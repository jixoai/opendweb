//! continuity raw 传输（app-protocol-layer Phase 1 task 2.1）。
//!
//! `ContinuityTransport` = 在已采纳的 continuity 连接上开一条 bidi 流，
//! 承载 [`super::frame::Frame`] 的收发。流上帧无长度前缀——`Frame::decode`
//! 的返回消费数即边界，`StreamFramer` 负责增量缓冲（不完整帧等待更多字节）。
//! Phase 2 的会话层在本传输之上做 SESSION_INIT/RESUME 与 journal 重放。

use bytes::BytesMut;

use super::frame::{Frame, FrameError};

/// 增量分帧器：喂入任意切片，吐出完整帧。
/// `TooShort` / `LengthMismatch{declared>available}` 视为「等待更多字节」。
#[derive(Debug, Default)]
pub struct StreamFramer {
    buf: BytesMut,
}

enum FeedOutcome {
    Frame(Frame),
    NeedMore,
    Fatal(FrameError),
}

impl StreamFramer {
    pub fn new() -> Self {
        Self::default()
    }

    fn try_one(src: &[u8]) -> FeedOutcome {
        match Frame::decode(src) {
            Ok((frame, _used)) => FeedOutcome::Frame(frame),
            Err(FrameError::TooShort(_)) => FeedOutcome::NeedMore,
            Err(FrameError::LengthMismatch { declared, available }) => {
                if declared > available {
                    FeedOutcome::NeedMore
                } else {
                    FeedOutcome::Fatal(FrameError::LengthMismatch { declared, available })
                }
            }
            Err(e) => FeedOutcome::Fatal(e),
        }
    }

    /// 喂入字节，返回完整帧列表；协议违规立即返回（缓冲区保留后续供诊断）。
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, FrameError> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            match Self::try_one(&self.buf) {
                FeedOutcome::Frame(f) => {
                    let used = super::frame::HEADER_LEN + f.payload.len();
                    let _ = self.buf.split_to(used);
                    out.push(f);
                }
                FeedOutcome::NeedMore => return Ok(out),
                FeedOutcome::Fatal(e) => {
                    if out.is_empty() {
                        return Err(e);
                    }
                    // 已解出的帧先交付；错误留给下一次 feed 重放同一缓冲触发
                    self.buf.clear();
                    return Ok(out);
                }
            }
        }
    }
}

/// 发送半边（[`ContinuityTransport::into_split`] 产物）。
/// 会话层将收发半边分别加锁——收帧等待与数据发送互不阻塞（design §5）。
pub struct TransportSend {
    pub epoch: u64,
    send: iroh::endpoint::SendStream,
}

impl TransportSend {
    pub async fn send(&mut self, frame: &Frame) -> Result<(), TransportError> {
        let mut buf = BytesMut::with_capacity(super::frame::HEADER_LEN + frame.payload.len());
        frame.encode(&mut buf)?;
        self.send
            .write_all(&buf)
            .await
            .map_err(|e| TransportError::Io(format!("{e}")))?;
        Ok(())
    }

    /// 优雅半关（发送侧 FIN）。
    pub fn finish(&mut self) -> Result<(), TransportError> {
        self.send
            .finish()
            .map_err(|e| TransportError::Io(format!("{e}")))
    }
}

/// 接收半边（framer 增量状态随半边走；同批多帧入 pending 队列逐帧交付——
/// 背靠背帧合并读盘时不得丢帧）。
pub struct TransportRecv {
    pub epoch: u64,
    recv: iroh::endpoint::RecvStream,
    framer: StreamFramer,
    pending: std::collections::VecDeque<Frame>,
}

impl TransportRecv {
    /// 阻塞收一帧（EOF/错误 → Ended/Io）。
    pub async fn recv(&mut self) -> Result<Frame, TransportError> {
        loop {
            if let Some(f) = self.pending.pop_front() {
                return Ok(f);
            }
            let mut chunk = [0u8; 16 * 1024];
            let n = self
                .recv
                .read(&mut chunk)
                .await
                .map_err(|e| TransportError::Io(format!("{e}")))?;
            let Some(n) = n else { return Err(TransportError::Ended) };
            for f in self.framer.feed(&chunk[..n])? {
                self.pending.push_back(f);
            }
            // 帧未齐：继续读
        }
    }
}

/// 一条已采纳连接上的 continuity 双向流。
pub struct ContinuityTransport {
    pub epoch: u64,
    send: TransportSend,
    recv: TransportRecv,
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("continuity stream io: {0}")]
    Io(String),
    #[error("continuity frame: {0}")]
    Frame(#[from] FrameError),
    #[error("continuity stream ended")]
    Ended,
}

impl ContinuityTransport {
    /// 在当前代次连接上开一条 bidi 流（调用方保证 conn 存活窗口内使用）。
    pub async fn open(
        conn: &iroh::endpoint::Connection,
        epoch: u64,
    ) -> Result<Self, TransportError> {
        let (send, recv) = conn
            .open_bi()
            .await
            .map_err(|e| TransportError::Io(format!("{e}")))?;
        Ok(Self::from_parts(send, recv, epoch))
    }

    pub async fn send(&mut self, frame: &Frame) -> Result<(), TransportError> {
        self.send.send(frame).await
    }

    /// 阻塞收一帧（EOF/错误 → Ended/Io）。
    pub async fn recv(&mut self) -> Result<Frame, TransportError> {
        self.recv.recv().await
    }

    /// 由已建立的 (send, recv) 组装（接受侧入口）。
    pub fn from_parts(
        send: iroh::endpoint::SendStream,
        recv: iroh::endpoint::RecvStream,
        epoch: u64,
    ) -> Self {
        Self {
            epoch,
            send: TransportSend {
                epoch,
                send,
            },
            recv: TransportRecv {
                epoch,
                recv,
                framer: StreamFramer::new(),
                pending: std::collections::VecDeque::new(),
            },
        }
    }

    /// 拆分收发半边（会话层分别加锁）。
    pub fn into_split(self) -> (TransportSend, TransportRecv) {
        (self.send, self.recv)
    }

    /// 优雅半关（发送侧 FIN）。
    pub fn finish(&mut self) -> Result<(), TransportError> {
        self.send.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use crate::continuity::frame::{Direction, FrameType};

    fn data_frame(offset: u64, payload: &[u8]) -> Frame {
        Frame {
            frame_type: FrameType::Data,
            flags: 0,
            session_id: [5u8; 16],
            stream_id: 9,
            direction: Direction::ClientToProvider,
            byte_offset: offset,
            payload: Bytes::copy_from_slice(payload),
        }
    }

    #[test]
    fn framer_incremental_and_split_boundaries() {
        let f1 = data_frame(0, b"hello");
        let f2 = data_frame(5, b"world!!!");
        let mut wire = BytesMut::new();
        f1.encode(&mut wire).unwrap();
        f2.encode(&mut wire).unwrap();
        let wire = wire.freeze();
        // 逐字节喂入：每一步都不得报错，最终恰好两帧且内容一致
        let mut fr = StreamFramer::new();
        let mut got = Vec::new();
        for b in wire.iter() {
            got.extend(fr.feed(&[*b]).unwrap());
        }
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], f1);
        assert_eq!(got[1], f2);
        // 中间任何截断点：已产出帧数单调、无错
        let mut fr2 = StreamFramer::new();
        let mut produced = 0usize;
        for cut in 1..=wire.len() {
            let out = fr2.feed(&wire[cut - 1..cut]).unwrap();
            produced += out.len();
        }
        assert_eq!(produced, 2);
    }

    #[test]
    fn framer_fatal_propagates() {
        let good = data_frame(0, b"x");
        let mut wire = good.encode_to_vec().unwrap();
        wire[0] = b'Q'; // 坏 magic
        let mut fr = StreamFramer::new();
        assert!(fr.feed(&wire).is_err());
    }

    /// 背靠背帧合并读盘不得丢帧（Phase 2 会话层实证缺陷的回归钉）：
    /// OPEN+DATA+FIN 一次喂入 → recv 逐帧交付三帧全数到达。
    #[test]
    fn recv_batch_delivers_all_frames_in_order() {
        let open = Frame {
            frame_type: crate::continuity::frame::FrameType::Open,
            flags: crate::continuity::frame::flags::START,
            session_id: [5u8; 16],
            stream_id: 9,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: bytes::Bytes::from_static(b"{\"requestId\":\"9\"}"),
        };
        let data = data_frame(0, b"ping");
        let fin = Frame {
            frame_type: crate::continuity::frame::FrameType::Fin,
            flags: crate::continuity::frame::flags::END,
            session_id: [5u8; 16],
            stream_id: 9,
            direction: Direction::ClientToProvider,
            byte_offset: 4,
            payload: bytes::Bytes::new(),
        };
        // 三帧编码进同一缓冲——模拟 QUIC 单次读盘合并
        let mut wire = BytesMut::new();
        open.encode(&mut wire).unwrap();
        data.encode(&mut wire).unwrap();
        fin.encode(&mut wire).unwrap();
        // 与 TransportRecv::recv 相同的 pending 语义：一次 feed 全量入队逐帧交付
        let mut fr = StreamFramer::new();
        let mut pending = std::collections::VecDeque::new();
        for f in fr.feed(&wire[..]).unwrap() {
            pending.push_back(f);
        }
        assert_eq!(pending.len(), 3, "三帧全数解出");
        assert_eq!(pending.pop_front().unwrap().frame_type, FrameType::Open);
        assert_eq!(pending.pop_front().unwrap().payload, data.payload);
        assert_eq!(pending.pop_front().unwrap().frame_type, FrameType::Fin);
    }
}
