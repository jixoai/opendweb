//! continuity 语义模型（app-protocol-layer Phase 0 task 1.1）：
//! 接收窗口去重（design §2.7）与发送侧 replay journal（design §2.6）的
//! 纯函数模型 + property 式不变量测试。Phase 2 实现以本模型为单一语义权威。
//!
//! 模型→实现的映射注记：
//! - RecvWindow 的重放校验历史为**有界滑动窗口**（最近 [`HISTORY_CAP`] 字节，
//!   Phase 2 硬化：全量保留在生产不可接受）。落入视界内的重叠段做逐字节
//!   一致性校验（一致丢弃 / 不一致 RESET）；offset 低于视界下沿的重叠段
//!   **无法逐字节校验**——按重复丢弃并计数 `unverifiable_duplicates`
//!   （该区间必然 ≤ expected，即已入交付队列/已消费，丢弃无损）。
//! - delivered_bytes 记账为**累计计数器**（非 history.len()——history 已裁剪）。
//! - StreamJournal 的 acked_offset 允许落在段中间（协议真值）；journal 只按
//!   **整段**释放内存，跨 ack 边界的段保留整段——重放整段、接收端按 §2.7
//!   重叠规则去重，两侧语义闭合。

use std::collections::BTreeMap;

use bytes::Bytes;

/// 重放校验历史上限（有界滑动窗口；Phase 2 硬化）。
pub const HISTORY_CAP: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// 接收窗口（§2.7 去重规则）
// ---------------------------------------------------------------------------

/// 接收端单流状态：expected_offset 之前的字节已连续交付。
#[derive(Debug)]
pub struct RecvWindow {
    expected_offset: u64,
    /// gap buffer：乱序提前到达的段（offset -> payload）；容量有界。
    gaps: BTreeMap<u64, Bytes>,
    /// 校验历史（有界滑动窗口：覆盖 [history_start, expected_offset)）。
    history: Vec<u8>,
    /// history[0] 对应的流 offset。
    history_start: u64,
    /// 累计交付字节（记账计数器——history 裁剪后仍是全量真值）。
    delivered_total: u64,
    /// 低于校验视界、无法逐字节校验而按重复丢弃的段计数。
    unverifiable_duplicates: u64,
}

/// 段处置结果。
#[derive(Debug, PartialEq, Eq)]
pub enum SegmentAction {
    /// 顺序到达（或重叠段的后缀）：交付增量字节。
    Deliver(Bytes),
    /// 完全重复：丢弃（重叠范围逐字节校验一致）。
    Duplicate,
    /// 乱序：入 gap buffer，待中间段补齐。
    Buffered,
    /// overlap 内容不一致 → 协议违规，流应 RESET(PROTOCOL_ERROR)。
    OverlapMismatch { expected: u64, got: u64 },
}

#[derive(Debug, thiserror::Error)]
#[error("gap buffer overflow: {held} segments > {cap}")]
pub struct GapOverflow {
    pub held: usize,
    pub cap: usize,
}

impl RecvWindow {
    pub fn new() -> Self {
        Self {
            expected_offset: 0,
            gaps: BTreeMap::new(),
            history: Vec::new(),
            history_start: 0,
            delivered_total: 0,
            unverifiable_duplicates: 0,
        }
    }

    pub fn expected_offset(&self) -> u64 {
        self.expected_offset
    }

    /// 累计 ACK 投影（最高连续已交付的 exclusive offset）。
    pub fn ack_offset(&self) -> u64 {
        self.expected_offset
    }

    pub fn delivered_bytes(&self) -> u64 {
        self.delivered_total
    }

    /// 校验视界下沿（history 覆盖 [history_start, expected_offset)）。
    pub fn history_start(&self) -> u64 {
        self.history_start
    }

    /// 低于校验视界、按重复丢弃的段计数（观测面）。
    pub fn unverifiable_duplicates(&self) -> u64 {
        self.unverifiable_duplicates
    }

    /// SACK 区间投影（gap buffer 的 (start, end_exclusive) 列表，升序合并）。
    pub fn sack_ranges(&self) -> Vec<(u64, u64)> {
        let mut out: Vec<(u64, u64)> = Vec::new();
        for (&off, payload) in &self.gaps {
            let end = off + payload.len() as u64;
            match out.last_mut() {
                Some((_, e)) if off <= *e => *e = (*e).max(end),
                _ => out.push((off, end)),
            }
        }
        out
    }

    /// 喂入一段 (offset, payload)。
    /// - offset < expected：重叠/重复——对 [max(offset, history_start),
    ///   min(end, expected)) 与历史逐字节校验；一致且 end <= expected →
    ///   Duplicate；一致但跨界 → 交付后缀；不一致 → OverlapMismatch。
    ///   offset < history_start 的重叠区**无法逐字节校验**——按重复丢弃并
    ///   计数（该区间 ≤ expected 即已交付，丢弃无损）。
    /// - offset == expected：顺序交付，随后吸干 gap 前缀。
    /// - offset > expected：入 gap buffer（容量有界）。
    pub fn feed(
        &mut self,
        offset: u64,
        payload: Bytes,
        gap_cap: usize,
    ) -> Result<SegmentAction, GapOverflow> {
        let end = offset + payload.len() as u64;
        if offset < self.expected_offset {
            let overlap_end = end.min(self.expected_offset);
            if offset < self.history_start {
                // 低于校验视界：无法逐字节校验，按重复丢弃记账
                self.unverifiable_duplicates += 1;
            }
            // 视界内的可校验区：[max(offset, history_start), overlap_end)
            let verify_start = offset.max(self.history_start);
            if verify_start < overlap_end {
                let hs = (verify_start - self.history_start) as usize;
                let he = (overlap_end - self.history_start) as usize;
                let hist_slice = self.history.get(hs..he).expect(
                    "history 必须覆盖 [history_start, expected) 区间（append 记账不变量）",
                );
                let ps = (verify_start - offset) as usize;
                let pe = ps + (overlap_end - verify_start) as usize;
                if hist_slice != &payload[ps..pe] {
                    return Ok(SegmentAction::OverlapMismatch {
                        expected: self.expected_offset,
                        got: offset,
                    });
                }
            }
            if end <= self.expected_offset {
                return Ok(SegmentAction::Duplicate);
            }
            // 一致前缀（或视界外跳过前缀）+ 跨界后缀：交付后缀（连同吸干的 gap 段）
            let skip = (self.expected_offset - offset) as usize;
            let mut out: Vec<u8> = payload.slice(skip..).to_vec();
            let tail_len = out.len();
            self.append_delivered(&Bytes::from(out.clone()));
            self.expected_offset = end;
            out.extend_from_slice(&self.drain_gaps());
            debug_assert_eq!(out.len() - tail_len, (self.expected_offset - end) as usize);
            return Ok(SegmentAction::Deliver(Bytes::from(out)));
        }
        if offset == self.expected_offset {
            let mut out: Vec<u8> = payload.to_vec();
            self.append_delivered(&payload);
            self.expected_offset = end;
            out.extend_from_slice(&self.drain_gaps());
            return Ok(SegmentAction::Deliver(Bytes::from(out)));
        }
        if self.gaps.len() >= gap_cap {
            return Err(GapOverflow {
                held: self.gaps.len(),
                cap: gap_cap,
            });
        }
        self.gaps.insert(offset, payload);
        Ok(SegmentAction::Buffered)
    }

    fn append_delivered(&mut self, bytes: &Bytes) {
        self.history.extend_from_slice(bytes);
        self.delivered_total += bytes.len() as u64;
        // 有界滑动窗口：只保留最近 HISTORY_CAP 字节
        if self.history.len() > HISTORY_CAP {
            let excess = self.history.len() - HISTORY_CAP;
            self.history.drain(0..excess);
            self.history_start += excess as u64;
        }
    }

    /// 吸干 gap 前缀，返回被吸干的字节拼接（供 feed 一并交付调用方）。
    fn drain_gaps(&mut self) -> Bytes {
        let mut drained: Vec<u8> = Vec::new();
        while let Some((&off, payload)) = self.gaps.first_key_value() {
            if off != self.expected_offset {
                break;
            }
            let payload = payload.clone();
            self.gaps.remove(&off);
            self.append_delivered(&payload);
            drained.extend_from_slice(&payload);
            self.expected_offset += payload.len() as u64;
        }
        Bytes::from(drained)
    }
}

// ---------------------------------------------------------------------------
// 发送侧 replay journal（§2.6）
// ---------------------------------------------------------------------------

/// journal 上限（字节/段；年龄维度由调用方定时器驱动——恢复窗口结束即终结，
/// 见 design「年龄仅恢复窗口内累计」）。
#[derive(Debug, Clone, Copy)]
pub struct JournalLimits {
    pub max_session_bytes: usize,
    pub max_stream_bytes: usize,
    /// 单流段数上限（design §2.6 表：512）。
    pub max_segments: usize,
    /// session 级段数上限（design §2.6 表：4096——全部流聚合）。
    pub max_session_segments: usize,
}

impl Default for JournalLimits {
    fn default() -> Self {
        Self {
            max_session_bytes: 8 * 1024 * 1024,
            max_stream_bytes: 2 * 1024 * 1024,
            max_segments: 512,
            max_session_segments: 4096,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("journal segment cap exceeded: {0}")]
    SegmentCap(usize),
    #[error("journal stream byte cap exceeded: {held} + {incoming} > {cap}")]
    StreamBytesCap {
        held: usize,
        incoming: usize,
        cap: usize,
    },
    #[error("journal session byte cap exceeded: {held} + {incoming} > {cap}")]
    SessionBytesCap {
        held: usize,
        incoming: usize,
        cap: usize,
    },
}

/// 单流发送 journal：持有未（整段）ack 段；ack 推进即整段释放。
#[derive(Debug)]
pub struct StreamJournal {
    pub stream_id: u64,
    next_send_offset: u64,
    /// 协议真值 ack（可落在段中间）。
    acked_offset: u64,
    final_offset: Option<u64>,
    segments: BTreeMap<u64, Bytes>,
    limits: JournalLimits,
}

impl StreamJournal {
    pub fn new(stream_id: u64, limits: JournalLimits) -> Self {
        Self {
            stream_id,
            next_send_offset: 0,
            acked_offset: 0,
            final_offset: None,
            segments: BTreeMap::new(),
            limits,
        }
    }

    pub fn acked_offset(&self) -> u64 {
        self.acked_offset
    }

    pub fn next_offset(&self) -> u64 {
        self.next_send_offset
    }

    pub fn segments_len(&self) -> usize {
        self.segments.len()
    }

    pub fn held_bytes(&self) -> usize {
        self.segments.values().map(|b| b.len()).sum()
    }

    /// 记录一个已发送段（按序入账；offset = 返回值）。
    pub fn record(&mut self, payload: Bytes, is_final: bool) -> Result<u64, JournalError> {
        if self.segments.len() >= self.limits.max_segments {
            return Err(JournalError::SegmentCap(self.limits.max_segments));
        }
        let held = self.held_bytes();
        if held + payload.len() > self.limits.max_stream_bytes {
            return Err(JournalError::StreamBytesCap {
                held,
                incoming: payload.len(),
                cap: self.limits.max_stream_bytes,
            });
        }
        let offset = self.next_send_offset;
        self.segments.insert(offset, payload);
        self.next_send_offset += payload_len_inc(&self.segments, offset);
        if is_final {
            self.final_offset = Some(self.next_send_offset);
        }
        Ok(offset)
    }

    /// ACK 推进（累计，exclusive offset；只前进、clamp 到已发送）。
    /// 返回整段释放的字节数（跨 ack 边界的段保留整段，由重放+对端去重闭合）。
    pub fn advance_ack(&mut self, exclusive_offset: u64) -> usize {
        if exclusive_offset <= self.acked_offset {
            return 0;
        }
        self.acked_offset = exclusive_offset.min(self.next_send_offset);
        let mut freed = 0usize;
        let mut to_remove = Vec::new();
        for (&off, payload) in &self.segments {
            if off + payload.len() as u64 <= self.acked_offset {
                freed += payload.len();
                to_remove.push(off);
            }
        }
        for off in to_remove {
            self.segments.remove(&off);
        }
        freed
    }

    /// 重放快照：(offset, payload) 升序；首段可能跨 ack 边界（整段保留语义）。
    pub fn replay(&self) -> impl Iterator<Item = (u64, Bytes)> + '_ {
        self.segments
            .iter()
            .map(|(&off, payload)| (off, payload.clone()))
    }
}

fn payload_len_inc(segments: &BTreeMap<u64, Bytes>, offset: u64) -> u64 {
    segments
        .get(&offset)
        .map(|p| p.len() as u64)
        .expect("record 刚插入")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(v: u8, n: usize) -> Bytes {
        Bytes::from(vec![v; n])
    }

    // ---------- RecvWindow ----------

    #[test]
    fn recv_order_delivery_and_duplicate() {
        let mut w = RecvWindow::new();
        assert_eq!(
            w.feed(0, b(1, 10), 8).unwrap(),
            SegmentAction::Deliver(b(1, 10))
        );
        assert_eq!(w.feed(0, b(1, 10), 8).unwrap(), SegmentAction::Duplicate);
        assert_eq!(
            w.feed(10, b(2, 5), 8).unwrap(),
            SegmentAction::Deliver(b(2, 5))
        );
        assert_eq!(w.expected_offset(), 15);
        assert_eq!(w.delivered_bytes(), 15);
    }

    #[test]
    fn recv_overlap_mismatch_detected() {
        let mut w = RecvWindow::new();
        w.feed(0, b(1, 10), 8).unwrap();
        assert_eq!(
            w.feed(0, b(9, 10), 8).unwrap(),
            SegmentAction::OverlapMismatch {
                expected: 10,
                got: 0
            }
        );
        // 重叠区内字节不一致（history[8..10]=1,1，来帧为 9,1）→ mismatch
        assert_eq!(
            w.feed(8, Bytes::from(vec![9u8, 1, 7, 7, 7]), 8).unwrap(),
            SegmentAction::OverlapMismatch {
                expected: 10,
                got: 8
            }
        );
    }

    #[test]
    fn recv_straddling_replay_delivers_tail() {
        let mut w = RecvWindow::new();
        w.feed(0, b(1, 10), 8).unwrap();
        // 重放段 5..15：前 5B 与历史一致，后 5B 是新数据
        let seg = Bytes::from(vec![1u8; 5].into_iter().chain(vec![3u8; 5]).collect::<Vec<_>>());
        assert_eq!(w.feed(5, seg, 8).unwrap(), SegmentAction::Deliver(b(3, 5)));
        assert_eq!(w.expected_offset(), 15);
    }

    #[test]
    fn recv_gap_buffer_and_drain() {
        let mut w = RecvWindow::new();
        assert_eq!(w.feed(10, b(2, 5), 8).unwrap(), SegmentAction::Buffered);
        assert_eq!(w.sack_ranges(), vec![(10, 15)]);
        // 顺序段交付时连同吸干的 gap 段一并返回（拼接体）
        let mut expect = Vec::new();
        expect.extend_from_slice(&b(1, 10));
        expect.extend_from_slice(&b(2, 5));
        assert_eq!(
            w.feed(0, b(1, 10), 8).unwrap(),
            SegmentAction::Deliver(Bytes::from(expect))
        );
        assert_eq!(w.expected_offset(), 15);
        assert!(w.sack_ranges().is_empty());
        assert_eq!(w.delivered_bytes(), 15);
    }

    #[test]
    fn recv_gap_overflow_rejected() {
        let mut w = RecvWindow::new();
        for i in 0..4 {
            w.feed(10 + i * 10, b(1, 5), 4).unwrap();
        }
        assert!(w.feed(100, b(1, 5), 4).is_err());
    }

    /// 有界校验历史：窗口只保留最近 HISTORY_CAP 字节。
    #[test]
    fn recv_history_bounded_sliding_window() {
        let mut w = RecvWindow::new();
        let total = HISTORY_CAP + 4096;
        // 单段交付 total 字节（一段超窗口也允许——按总量裁剪）
        w.feed(0, b(7, total), 8).unwrap();
        assert_eq!(w.delivered_bytes(), total as u64);
        assert_eq!(w.history.len(), HISTORY_CAP);
        assert_eq!(w.history_start, (total - HISTORY_CAP) as u64);
        assert_eq!(w.expected_offset(), total as u64);
        // 视界内重叠：逐字节校验仍生效
        let in_view = (total - 100) as u64;
        assert_eq!(
            w.feed(in_view, Bytes::from(vec![7u8; 100]), 8).unwrap(),
            SegmentAction::Duplicate
        );
        // 视界内重叠：内容不一致仍 RESET
        let mut bad = vec![7u8; 100];
        bad[0] ^= 0xFF;
        assert!(matches!(
            w.feed(in_view, Bytes::from(bad), 8).unwrap(),
            SegmentAction::OverlapMismatch { .. }
        ));
    }

    /// 视界外重放：无法逐字节校验 → 按重复丢弃 + 计数；跨界后缀仍交付。
    #[test]
    fn recv_ancient_replay_discards_and_counts() {
        let mut w = RecvWindow::new();
        // 交付 3 段 × 32KiB：history 保留最后 64KiB（段 2+段 3）
        for i in 0..3u64 {
            w.feed(i * 32768, b((i + 1) as u8, 32768), 8).unwrap();
        }
        assert_eq!(w.history_start, 32768);
        // 完全低于视界的重放段：丢弃 + unverifiable 计数
        assert_eq!(w.unverifiable_duplicates(), 0);
        assert_eq!(
            w.feed(0, b(1, 32768), 8).unwrap(),
            SegmentAction::Duplicate
        );
        assert_eq!(w.unverifiable_duplicates(), 1);
        assert_eq!(w.delivered_bytes(), 3 * 32768);
        // 跨界段（前缀低于视界、中间与历史一致、后缀是新数据）：跳过前缀交付后缀
        let straddle = {
            let mut v = vec![0xFFu8; 8]; // [32760, 32768) 低于视界（内容不参与校验）
            v.extend_from_slice(&[2u8; 32768]); // 与 history 一致
            v.extend_from_slice(&[3u8; 32768]); // 与 history 一致
            v.extend_from_slice(&[9u8; 8]); // [98304, 98312) 新数据
            Bytes::from(v)
        };
        assert_eq!(
            w.feed(32760, straddle, 8).unwrap(),
            SegmentAction::Deliver(b(9, 8))
        );
        assert_eq!(w.unverifiable_duplicates(), 2);
        assert_eq!(w.expected_offset(), 98312);
    }

    /// property 式不变量：随机段序 + 重复投递，交付流恒为原始流的连续前缀；
    /// expected == delivered 总量；一致重放不产生 mismatch。
    #[test]
    fn recv_property_contiguous_delivery() {
        let mut seed: u64 = 0x9E3779B97F4A7C15;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _round in 0..200 {
            let mut w = RecvWindow::new();
            let mut delivered_log: Vec<u8> = Vec::new();
            let mut sent: Vec<(u64, Bytes)> = Vec::new();
            let mut off = 0u64;
            for i in 0..50usize {
                let len = 1 + (next() % 7) as usize;
                sent.push((off, Bytes::from(vec![(i % 251) as u8; len])));
                off += len as u64;
            }
            let mut ops: Vec<(u64, Bytes)> = Vec::new();
            for &(o, ref p) in &sent {
                ops.push((o, p.clone()));
                if next() % 3 == 0 {
                    ops.push((o, p.clone()));
                }
            }
            for i in (1..ops.len()).rev() {
                let j = (next() as usize) % (i + 1);
                ops.swap(i, j);
            }
            for (o, p) in ops {
                match w.feed(o, p, 64).unwrap() {
                    SegmentAction::Deliver(t) => delivered_log.extend_from_slice(&t),
                    SegmentAction::Duplicate | SegmentAction::Buffered => {}
                    SegmentAction::OverlapMismatch { .. } => {
                        panic!("一致重放不得 mismatch")
                    }
                }
            }
            let original: Vec<u8> = sent.iter().flat_map(|(_, p)| p.iter().copied()).collect();
            assert_eq!(delivered_log.len() as u64, w.delivered_bytes());
            assert_eq!(w.expected_offset(), w.delivered_bytes());
            assert_eq!(delivered_log, original[..delivered_log.len()]);
        }
    }

    // ---------- StreamJournal ----------

    #[test]
    fn journal_record_ack_release_replay() {
        let mut j = StreamJournal::new(7, JournalLimits::default());
        let o1 = j.record(b(1, 100), false).unwrap();
        let o2 = j.record(b(2, 100), false).unwrap();
        assert_eq!((o1, o2), (0, 100));
        assert_eq!(j.advance_ack(100), 100);
        assert_eq!(j.acked_offset(), 100);
        assert_eq!(j.held_bytes(), 100);
        let replay: Vec<(u64, usize)> = j.replay().map(|(o, p)| (o, p.len())).collect();
        assert_eq!(replay, vec![(100, 100)]);
        // ack 超过已发送 → clamp 到 next_send 并释放剩余
        assert_eq!(j.advance_ack(999), 100);
        assert_eq!(j.acked_offset(), 200);
        assert_eq!(j.held_bytes(), 0);
        assert!(j.replay().next().is_none());
        // ack 只前进
        assert_eq!(j.advance_ack(50), 0);
        assert_eq!(j.acked_offset(), 200);
    }

    #[test]
    fn journal_mid_segment_ack_keeps_whole_segment() {
        let mut j = StreamJournal::new(1, JournalLimits::default());
        j.record(b(1, 100), false).unwrap();
        // ack 落在段中间：协议真值推进，但段整段保留（重放整段、对端去重）
        assert_eq!(j.advance_ack(50), 0);
        assert_eq!(j.acked_offset(), 50);
        assert_eq!(j.held_bytes(), 100);
        let replay: Vec<(u64, usize)> = j.replay().map(|(o, p)| (o, p.len())).collect();
        assert_eq!(replay, vec![(0, 100)]);
        assert_eq!(j.advance_ack(100), 100);
        assert_eq!(j.held_bytes(), 0);
    }

    #[test]
    fn journal_caps() {
        let mut lim = JournalLimits::default();
        lim.max_stream_bytes = 100;
        lim.max_segments = 4;
        let mut j = StreamJournal::new(1, lim);
        assert!(j.record(b(1, 40), false).is_ok());
        assert!(j.record(b(1, 40), false).is_ok());
        // 字节上限独立于段数上限先触发（80 + 21 > 100）
        assert!(matches!(
            j.record(b(1, 21), false),
            Err(JournalError::StreamBytesCap { .. })
        ));
        j.advance_ack(80);
        for _ in 0..4 {
            assert!(j.record(b(1, 1), false).is_ok());
        }
        assert!(matches!(
            j.record(b(1, 1), false),
            Err(JournalError::SegmentCap(4))
        ));
    }

    /// property 式不变量：随机 record/ack 序列下——
    /// held_bytes ≤ 上限；acked ≤ next_send；replay 段间无空洞且首段跨住 acked。
    #[test]
    fn journal_property_bounds() {
        let mut seed: u64 = 0xDEADBEEFCAFEF00D;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let lim = JournalLimits {
            max_session_bytes: 1 << 20,
            max_stream_bytes: 4096,
            max_segments: 512,
            max_session_segments: 4096,
        };
        for _round in 0..300 {
            let mut j = StreamJournal::new(1, lim);
            for _step in 0..200 {
                if next() % 2 == 0 {
                    let len = 1 + (next() % 64) as usize;
                    if j.held_bytes() + len <= lim.max_stream_bytes
                        && j.segments_len() < lim.max_segments
                    {
                        let before = j.next_offset();
                        j.record(Bytes::from(vec![0u8; len]), false).unwrap();
                        assert_eq!(j.next_offset(), before + len as u64);
                    }
                } else {
                    let span = (next() % 128) as u64;
                    j.advance_ack(j.acked_offset() + span);
                }
                assert!(j.held_bytes() <= lim.max_stream_bytes);
                assert!(j.acked_offset() <= j.next_offset());
                let mut first = true;
                let mut cursor = 0u64;
                for (o, p) in j.replay() {
                    if first {
                        // 首段允许跨 ack 边界：off ≤ acked ≤ off+len
                        assert!(o <= j.acked_offset());
                        first = false;
                    } else {
                        assert_eq!(o, cursor, "replay 段间不得有空洞");
                    }
                    cursor = o + p.len() as u64;
                }
                assert!(first || cursor == j.next_offset());
            }
        }
    }
}
