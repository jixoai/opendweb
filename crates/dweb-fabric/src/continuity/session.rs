//! continuity 会话协议（app-protocol-layer Phase 2 tasks 3.1-3.3）。
//!
//! 架构：每会话**一条 bidi 流多路复用**（`SessionChannel` 收/发半边分别加锁
//! ——收帧等待不阻塞数据发送；ACK 由 pump 立即回发，重放按流轮转 + 每轮
//! 切片上限，单帧 ≤1MiB 的传输时延是控制帧最坏等待——design §5 HOL 缓解）。
//! 去重/journal 语义复用 Phase 0 模型（`RecvWindow`/`StreamJournal`——本层
//! 只接线，不重造语义）。
//!
//! 生命周期：
//! - 新会话：SESSION_INIT（client 生成 session_id+token）→ SESSION_INIT_OK
//! - 断线后（Phase 1 manager 自动重建传输连接）：client 发 RESUME_INIT
//!   （携带 current token + 流水位摘要）→ provider 校验**两代滑窗** token →
//!   RESUME_OK（轮换 new_generation/new_token）→ 双方重放未 ack 段、重发
//!   OPEN（幂等归并）/FIN 继续流
//! - 拒绝：TOKEN_INVALID / REQUEST_STATE_LOST（进程重启语义——内存注册表
//!   无此会话即副作状态已丢，design §2.3）
//!
//! 副作用状态机（design §2.8）：OPEN 落 ACCEPTED（幂等键归并重复 OPEN）；
//! provider 应用经 [`SessionShared::mark_started`] 进入 STARTED——**恢复轮
//! 不重执行**；COMPLETED 后响应 journal 仍可重放。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use bytes::Bytes;

use crate::fabric::{Fabric, FabricError};
use crate::session::SessionError;

use super::frame::{self, Direction, Frame, FrameType};
use super::model::{JournalLimits, RecvWindow, SegmentAction, StreamJournal};
use super::state::ConnectionPhase;
use super::transport::{TransportError, TransportRecv, TransportSend};

pub const PROTOCOL_VERSION: u8 = 1;
/// gap buffer 容量（§2.7 有界）。
pub const GAP_CAP: usize = 64;
/// 重放每流每轮段数上限（§5：防单流垄断恢复通道）。
const REPLAY_PER_ROUND: usize = 4;

/// RESUME_REJECT reason（design §2.3 冻结表）。
pub mod reject_reason {
    pub const UNKNOWN_SESSION: u8 = 0x01;
    pub const TOKEN_INVALID: u8 = 0x02;
    pub const RECOVERY_WINDOW_EXPIRED: u8 = 0x03;
    pub const STALE_EPOCH: u8 = 0x04;
    pub const JOURNAL_EVICTED: u8 = 0x05;
    pub const POLICY_DENIED: u8 = 0x06;
    pub const VERSION_UNSUPPORTED: u8 = 0x07;
    pub const REQUEST_STATE_LOST: u8 = 0x08;
    pub const TOKEN_REVOKED: u8 = 0x09;
}

/// 请求副作用状态（§2.8）：STARTED 后恢复轮不得自动重执行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestState {
    Accepted,
    Started,
    Completed,
}

/// 会话阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionPhase {
    Negotiating,
    Active,
    Recovering,
    Dead,
    Closed,
}

/// 会话建立选项（journal 上限可注入——容量验收用小上限）。
#[derive(Debug, Clone, Copy)]
pub struct SessionOptions {
    pub limits: JournalLimits,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            limits: JournalLimits::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// token 两代滑窗（§2.3.0 R5：精确匹配 current 或 previous）
// ---------------------------------------------------------------------------

struct TokenWindow {
    current: (u64, [u8; 16]),
    previous: Option<(u64, [u8; 16])>,
}

impl TokenWindow {
    fn new(token: [u8; 16]) -> Self {
        Self {
            current: (1, token),
            previous: None,
        }
    }

    fn validate(&self, generation: u64, token: &[u8]) -> bool {
        if self.current.0 == generation && self.current.1.as_slice() == token {
            return true;
        }
        matches!(&self.previous, Some((g, t)) if *g == generation && t.as_slice() == token)
    }

    /// 轮换：旧 current 降为 previous（滑窗恒保两代；再旧即被挤出）。
    fn rotate(&mut self, new_generation: u64, new_token: [u8; 16]) {
        self.previous = Some(self.current);
        self.current = (new_generation, new_token);
    }

    fn current(&self) -> (u64, [u8; 16]) {
        self.current
    }
}

// ---------------------------------------------------------------------------
// 逻辑流上下文与共享核心
// ---------------------------------------------------------------------------

struct StreamCtx {
    /// 对端→本端方向的接收窗口（去重/交付）。
    recv: RecvWindow,
    /// 本端→对端方向的发送 journal（重放/ACK 释放）。
    journal: StreamJournal,
    /// 本端已发 FIN 的终局水位。
    final_sent: Option<u64>,
    /// 对端声明的终局水位（FIN.byte_offset + payload.len()）。
    remote_final: Option<u64>,
}

impl StreamCtx {
    fn new(stream_id: u64, limits: JournalLimits) -> Self {
        Self {
            recv: RecvWindow::new(),
            journal: StreamJournal::new(stream_id, limits),
            final_sent: None,
            remote_final: None,
        }
    }
}

/// 双端共享的会话核心：provider 侧常驻注册表跨连接存活（进程重启即丢——
/// RESUME 统一 REQUEST_STATE_LOST）；client 侧由 Session 句柄持有。
pub struct SessionShared {
    pub session_id: [u8; 16],
    pub peer_id: String,
    is_client: bool,
    tokens: std::sync::Mutex<TokenWindow>,
    phase: tokio::sync::Mutex<SessionPhase>,
    streams: tokio::sync::Mutex<HashMap<u64, StreamCtx>>,
    next_stream_id: std::sync::atomic::AtomicU64,
    /// 副作用状态机：stream_id → (state, 幂等键)。
    requests: tokio::sync::Mutex<HashMap<u64, (RequestState, String)>>,
    /// 幂等键去重：key → stream_id（重复 OPEN 归并既有流）。
    idem_index: tokio::sync::Mutex<HashMap<String, u64>>,
    /// client 侧流→幂等键（恢复轮重发 OPEN 用；OPEN 不入 journal——
    /// 不占数据 offset 空间，靠对端幂等归合）。
    stream_keys: tokio::sync::Mutex<HashMap<u64, String>>,
    /// 交付队列（stream_id → 有序字节），应用侧 recv 消费。
    delivered: tokio::sync::Mutex<HashMap<u64, VecDeque<Bytes>>>,
    delivered_notify: tokio::sync::Notify,
    limits: JournalLimits,
}

impl SessionShared {
    fn new(
        session_id: [u8; 16],
        token: [u8; 16],
        peer_id: String,
        is_client: bool,
        limits: JournalLimits,
    ) -> Arc<Self> {
        Arc::new(Self {
            session_id,
            peer_id,
            is_client,
            tokens: std::sync::Mutex::new(TokenWindow::new(token)),
            phase: tokio::sync::Mutex::new(SessionPhase::Negotiating),
            streams: tokio::sync::Mutex::new(HashMap::new()),
            next_stream_id: std::sync::atomic::AtomicU64::new(if is_client { 1 } else { 2 }),
            requests: tokio::sync::Mutex::new(HashMap::new()),
            idem_index: tokio::sync::Mutex::new(HashMap::new()),
            stream_keys: tokio::sync::Mutex::new(HashMap::new()),
            delivered: tokio::sync::Mutex::new(HashMap::new()),
            delivered_notify: tokio::sync::Notify::new(),
            limits,
        })
    }

    fn token_valid(&self, generation: u64, token: &[u8]) -> bool {
        self.tokens.lock().unwrap().validate(generation, token)
    }

    fn rotate_token(&self, new_generation: u64, new_token: [u8; 16]) {
        self.tokens.lock().unwrap().rotate(new_generation, new_token);
    }

    fn current_token(&self) -> (u64, [u8; 16]) {
        self.tokens.lock().unwrap().current()
    }

    /// 分配下一个逻辑流 id（client 奇数 / provider 偶数，§2.2）。
    fn alloc_stream_id(&self) -> u64 {
        self.next_stream_id
            .fetch_add(2, std::sync::atomic::Ordering::SeqCst)
    }

    fn send_direction(&self) -> Direction {
        if self.is_client {
            Direction::ClientToProvider
        } else {
            Direction::ProviderToClient
        }
    }

    pub async fn phase(&self) -> SessionPhase {
        *self.phase.lock().await
    }

    async fn set_phase(&self, p: SessionPhase) {
        *self.phase.lock().await = p;
    }

    /// 副作用状态机：OPEN 落 ACCEPTED（幂等键归并——重复 OPEN 返回既有流，
    /// 状态不回退）。
    pub async fn on_open(&self, stream_id: u64, idem_key: &str) -> (u64, bool) {
        let mut idem = self.idem_index.lock().await;
        if let Some(&existing) = idem.get(idem_key) {
            return (existing, false);
        }
        idem.insert(idem_key.to_string(), stream_id);
        drop(idem);
        self.stream_keys
            .lock()
            .await
            .insert(stream_id, idem_key.to_string());
        let mut reqs = self.requests.lock().await;
        reqs.entry(stream_id)
            .or_insert((RequestState::Accepted, idem_key.to_string()));
        (stream_id, true)
    }

    /// provider 应用执行上游前调用：Accepted→Started（此后恢复轮不重执行）。
    pub async fn mark_started(&self, stream_id: u64) {
        let mut reqs = self.requests.lock().await;
        if let Some((state, _)) = reqs.get_mut(&stream_id) {
            if *state == RequestState::Accepted {
                *state = RequestState::Started;
            }
        }
    }

    pub async fn mark_completed(&self, stream_id: u64) {
        let mut reqs = self.requests.lock().await;
        if let Some((state, _)) = reqs.get_mut(&stream_id) {
            *state = RequestState::Completed;
        }
    }

    pub async fn request_state(&self, stream_id: u64) -> Option<RequestState> {
        self.requests.lock().await.get(&stream_id).map(|(s, _)| *s)
    }

    /// 应用侧消费一条已交付数据；流终结（FIN/RESET 且队列排空）→ Err。
    pub async fn recv(&self, stream_id: u64) -> Result<Bytes, SessionError> {
        loop {
            {
                let mut q = self.delivered.lock().await;
                if let Some(b) = q.get_mut(&stream_id).and_then(|d| d.pop_front()) {
                    return Ok(b);
                }
            }
            let ended = {
                let streams = self.streams.lock().await;
                match streams.get(&stream_id) {
                    Some(ctx) => {
                        matches!(ctx.remote_final, Some(f) if f == ctx.recv.expected_offset())
                    }
                    None => false,
                }
            };
            if ended {
                let q_empty = self
                    .delivered
                    .lock()
                    .await
                    .get(&stream_id)
                    .is_none_or(|d| d.is_empty());
                if q_empty {
                    return Err(SessionError::Connect("stream ended".into()));
                }
            }
            // 有界等待（防 notify 竞态悬挂；流终结由 FIN/RESET 处理唤醒）
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                self.delivered_notify.notified(),
            )
            .await;
        }
    }

    /// 记录发送段（journal 前置闸门——上限即背压面；未 ACK 时内存有界）。
    async fn record_send(&self, stream_id: u64, payload: &Bytes) -> Result<u64, FabricError> {
        let mut streams = self.streams.lock().await;
        let ctx = streams
            .entry(stream_id)
            .or_insert_with(|| StreamCtx::new(stream_id, self.limits));
        ctx.journal
            .record(payload.clone(), false)
            .map_err(|e| FabricError::Session(SessionError::Connect(format!("{e}"))))
    }

    /// 处理一帧（收侧核心：去重/交付/ACK 生成/journal 释放）。
    /// 返回需立即回发的控制帧（ACK/RESET）。
    async fn handle_frame(&self, f: &Frame) -> Option<Frame> {
        match f.frame_type {
            FrameType::Data => {
                let mut streams = self.streams.lock().await;
                let ctx = streams
                    .entry(f.stream_id)
                    .or_insert_with(|| StreamCtx::new(f.stream_id, self.limits));
                let action = ctx.recv.feed(f.byte_offset, f.payload.clone(), GAP_CAP);
                match action {
                    Ok(SegmentAction::Deliver(payload)) => {
                        let ack = mk_ack(
                            self.session_id,
                            f.stream_id,
                            f.direction,
                            ctx.recv.ack_offset(),
                        );
                        drop(streams);
                        let mut q = self.delivered.lock().await;
                        q.entry(f.stream_id).or_default().push_back(payload);
                        drop(q);
                        self.delivered_notify.notify_waiters();
                        Some(ack)
                    }
                    Ok(SegmentAction::Duplicate) => {
                        // 幂等丢弃；仍回 ACK（对端可能未收到上次 ACK）
                        Some(mk_ack(
                            self.session_id,
                            f.stream_id,
                            f.direction,
                            ctx.recv.ack_offset(),
                        ))
                    }
                    Ok(SegmentAction::Buffered) => Some(mk_ack(
                        self.session_id,
                        f.stream_id,
                        f.direction,
                        ctx.recv.ack_offset(),
                    )),
                    Ok(SegmentAction::OverlapMismatch { .. }) | Err(_) => {
                        // 内容不一致 / gap 溢出 → 流 RESET(PROTOCOL_ERROR)：
                        // 回发对端 + 本地终结（双端流死，不交付脏数据）
                        ctx.remote_final = Some(ctx.recv.expected_offset());
                        Some(mk_reset(self.session_id, f.stream_id))
                    }
                }
            }
            FrameType::Ack => {
                // ACK.direction = 被确认数据的方向；匹配本端发送方向才推进
                if f.direction == self.send_direction() {
                    let mut streams = self.streams.lock().await;
                    if let Some(ctx) = streams.get_mut(&f.stream_id) {
                        ctx.journal.advance_ack(f.byte_offset);
                    }
                }
                None
            }
            FrameType::Fin => {
                let mut streams = self.streams.lock().await;
                let ctx = streams
                    .entry(f.stream_id)
                    .or_insert_with(|| StreamCtx::new(f.stream_id, self.limits));
                ctx.remote_final = Some(f.byte_offset + f.payload.len() as u64);
                drop(streams);
                self.delivered_notify.notify_waiters();
                None
            }
            FrameType::Open => {
                let idem = parse_idem_key(&f.payload);
                self.on_open(f.stream_id, &idem).await;
                None
            }
            FrameType::Reset => {
                let mut streams = self.streams.lock().await;
                if let Some(ctx) = streams.get_mut(&f.stream_id) {
                    ctx.remote_final = Some(ctx.recv.expected_offset());
                }
                drop(streams);
                self.delivered_notify.notify_waiters();
                None
            }
            _ => None,
        }
    }

    /// 流水位摘要（RESUME_INIT 携带；recv_ack = 本端接收进度 = 对端发送
    /// 已被确认进度——provider 据此裁剪重放）。
    async fn summaries(&self) -> Vec<StreamSummary> {
        let streams = self.streams.lock().await;
        streams
            .iter()
            .map(|(&id, ctx)| StreamSummary {
                stream_id: id,
                recv_ack: ctx.recv.ack_offset(),
                send_next: ctx.journal.next_offset(),
                final_sent: ctx.final_sent,
            })
            .collect()
    }

    /// 恢复摘要推进本端 journal（provider 侧：client 的 recv_ack 即本端
    /// P→C 数据已被接收的累计水位）。
    async fn advance_journal_from_summary(&self, summaries: &[StreamSummary]) {
        let mut streams = self.streams.lock().await;
        for s in summaries {
            if let Some(ctx) = streams.get_mut(&s.stream_id) {
                ctx.journal.advance_ack(s.recv_ack);
            }
        }
    }

    /// 重放快照（短锁收集，发送在锁外）：(stream_id, [(offset, payload)])。
    async fn replay_batches(&self) -> Vec<(u64, Vec<(u64, Bytes)>)> {
        let streams = self.streams.lock().await;
        streams
            .iter()
            .filter(|(_, c)| c.journal.held_bytes() > 0)
            .map(|(&id, ctx)| (id, ctx.journal.replay().collect()))
            .collect()
    }

    /// 待重发 FIN 的流（终局已宣告但可能未被对端收到）。
    async fn fin_resent_streams(&self) -> Vec<(u64, u64)> {
        let streams = self.streams.lock().await;
        streams
            .iter()
            .filter_map(|(&id, ctx)| ctx.final_sent.map(|f| (id, f)))
            .collect()
    }

    /// 观测面：单流 journal 持有字节（容量验收）。
    pub async fn journal_held_bytes(&self, stream_id: u64) -> usize {
        self.streams
            .lock()
            .await
            .get(&stream_id)
            .map(|c| c.journal.held_bytes())
            .unwrap_or(0)
    }

    /// client 侧 OPEN 重发清单。
    async fn open_resend_list(&self) -> Vec<(u64, String)> {
        self.stream_keys
            .lock()
            .await
            .iter()
            .map(|(&id, k)| (id, k.clone()))
            .collect()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StreamSummary {
    pub stream_id: u64,
    pub recv_ack: u64,
    pub send_next: u64,
    pub final_sent: Option<u64>,
}

fn mk_ack(sid: [u8; 16], stream: u64, data_direction: Direction, offset: u64) -> Frame {
    Frame {
        frame_type: FrameType::Ack,
        flags: 0,
        session_id: sid,
        stream_id: stream,
        direction: data_direction,
        byte_offset: offset,
        payload: Bytes::new(),
    }
}

/// 追踪用短 hex（前 8 字符）。
fn hex8(sid: &[u8; 16]) -> String {
    sid.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

fn mk_reset(sid: [u8; 16], stream: u64) -> Frame {
    Frame {
        frame_type: FrameType::Reset,
        flags: frame::flags::RESET,
        session_id: sid,
        stream_id: stream,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::new(),
    }
}

/// 极简 JSON 幂等键抽取（"idempotencyKey":"..."；内核不引 serde_json）。
fn parse_idem_key(payload: &[u8]) -> String {
    let s = String::from_utf8_lossy(payload);
    const KEY: &str = "\"idempotencyKey\"";
    if let Some(i) = s.find(KEY) {
        let rest = s[i + KEY.len()..].trim_start();
        if let Some(rest) = rest.strip_prefix(':') {
            let rest = rest.trim_start();
            if let Some(stripped) = rest.strip_prefix('"') {
                if let Some(end) = stripped.find('"') {
                    return stripped[..end].to_string();
                }
            }
        }
    }
    format!("auto-{}", s.len())
}

fn put_u64(dst: &mut Vec<u8>, v: u64) {
    dst.extend_from_slice(&v.to_be_bytes());
}

fn get_u64(src: &[u8], at: usize) -> Option<u64> {
    if at + 8 > src.len() {
        return None;
    }
    let mut b = [0u8; 8];
    b.copy_from_slice(&src[at..at + 8]);
    Some(u64::from_be_bytes(b))
}

/// 重放按流轮转交织（每流每轮至多 [`REPLAY_PER_ROUND`] 段）。
fn interleave_replay(batches: Vec<(u64, Vec<(u64, Bytes)>)>) -> Vec<(u64, u64, Bytes)> {
    let mut cursors: Vec<std::ops::Range<usize>> =
        batches.iter().map(|(_, segs)| 0..segs.len()).collect();
    let mut out = Vec::new();
    loop {
        let mut progressed = false;
        for (i, range) in cursors.iter_mut().enumerate() {
            let end = (range.start + REPLAY_PER_ROUND).min(range.end);
            for j in range.start..end {
                out.push((batches[i].0, batches[i].1[j].0, batches[i].1[j].1.clone()));
                progressed = true;
            }
            range.start = end;
        }
        if !progressed {
            return out;
        }
    }
}

fn map_transport_err(e: TransportError) -> FabricError {
    FabricError::Session(SessionError::Connect(format!("{e}")))
}

/// 追踪开关（DWEB_SESSION_TRACE=1；默认零开销一条 env 检查）。
fn trace_enabled() -> bool {
    std::env::var_os("DWEB_SESSION_TRACE").is_some()
}

macro_rules! strace {
    ($($arg:tt)*) => {
        if trace_enabled() {
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() % 100_000)
                .unwrap_or(0);
            eprintln!("[{t:05}] {}", format!($($arg)*));
        }
    };
}

fn map_transport_err_try(e: TransportError) -> TryAgain {
    TryAgain::Transport(map_transport_err(e))
}

fn timeout_err(what: &str) -> FabricError {
    FabricError::Session(SessionError::Connect(format!("{what} handshake timeout")))
}

// ---------------------------------------------------------------------------
// 会话通道（收/发半边分锁）与会话句柄
// ---------------------------------------------------------------------------

/// 会话通道：一条 bidi 流上的会话帧收发。收半边由 pump 独占消费；
/// 发半边按帧粒度加锁（ACK 回发与数据发送互不阻塞超过单帧时延）。
pub struct SessionChannel {
    shared: Arc<SessionShared>,
    send: tokio::sync::Mutex<TransportSend>,
    recv: tokio::sync::Mutex<TransportRecv>,
}

impl SessionChannel {
    fn new(shared: Arc<SessionShared>, send: TransportSend, recv: TransportRecv) -> Arc<Self> {
        Arc::new(Self {
            shared,
            send: tokio::sync::Mutex::new(send),
            recv: tokio::sync::Mutex::new(recv),
        })
    }

    pub fn shared(&self) -> &Arc<SessionShared> {
        &self.shared
    }

    pub async fn send_frame(&self, f: &Frame) -> Result<(), FabricError> {
        self.send.lock().await.send(f).await.map_err(map_transport_err)
    }

    /// 发送数据（journal 前置闸门 → DATA 帧）。
    pub async fn send_data(&self, stream_id: u64, payload: Bytes) -> Result<(), FabricError> {
        let offset = self.shared.record_send(stream_id, &payload).await?;
        self.send_frame(&Frame {
            frame_type: FrameType::Data,
            flags: 0,
            session_id: self.shared.session_id,
            stream_id,
            direction: self.shared.send_direction(),
            byte_offset: offset,
            payload,
        })
        .await
    }

    /// 半关（FIN；final offset = 已发送水位——恢复轮可重发）。
    pub async fn finish(&self, stream_id: u64) -> Result<(), FabricError> {
        let final_offset = {
            let mut streams = self.shared.streams.lock().await;
            let ctx = streams
                .entry(stream_id)
                .or_insert_with(|| StreamCtx::new(stream_id, self.shared.limits));
            let f = ctx.journal.next_offset();
            ctx.final_sent = Some(f);
            f
        };
        self.send_frame(&Frame {
            frame_type: FrameType::Fin,
            flags: frame::flags::END,
            session_id: self.shared.session_id,
            stream_id,
            direction: self.shared.send_direction(),
            byte_offset: final_offset,
            payload: Bytes::new(),
        })
        .await
    }

    /// 开新逻辑流（OPEN 帧；幂等键供对端副作用归并）。
    pub async fn open_stream(&self, idem_key: &str) -> Result<u64, FabricError> {
        let stream_id = self.shared.alloc_stream_id();
        let open_json = format!(
            "{{\"requestId\":\"{stream_id}\",\"idempotencyKey\":\"{idem_key}\"}}"
        );
        self.shared
            .streams
            .lock()
            .await
            .entry(stream_id)
            .or_insert_with(|| StreamCtx::new(stream_id, self.shared.limits));
        self.shared
            .stream_keys
            .lock()
            .await
            .insert(stream_id, idem_key.to_string());
        self.send_frame(&Frame {
            frame_type: FrameType::Open,
            flags: frame::flags::START,
            session_id: self.shared.session_id,
            stream_id,
            direction: self.shared.send_direction(),
            byte_offset: 0,
            payload: Bytes::from(open_json),
        })
        .await?;
        Ok(stream_id)
    }

    pub async fn recv(&self, stream_id: u64) -> Result<Bytes, FabricError> {
        self.shared
            .recv(stream_id)
            .await
            .map_err(|e| FabricError::Session(e))
    }

    /// 会话泵：独占收半边——收帧 → 语义处理 → 控制帧立即回发。
    /// 连接死亡（Ended/Io）→ Recovering 并返回（恢复由 resume 驱动）。
    async fn pump(self: Arc<Self>) -> Result<(), FabricError> {
        loop {
            let f = {
                let mut recv = self.recv.lock().await;
                match recv.recv().await {
                    Ok(f) => f,
                    Err(TransportError::Ended) => {
                        self.shared.set_phase(SessionPhase::Recovering).await;
                        return Ok(());
                    }
                    Err(e) => {
                        self.shared.set_phase(SessionPhase::Recovering).await;
                        return Err(map_transport_err(e));
                    }
                }
            };
            if let Some(ctrl) = self.shared.handle_frame(&f).await {
                if let Err(e) = self.send_frame(&ctrl).await {
                    // 连接死亡同样进入 Recovering（recv 侧未必再被轮到）
                    self.shared.set_phase(SessionPhase::Recovering).await;
                    return Err(e);
                }
            }
            if trace_enabled() {
                strace!(
                    "pump {} {:?} sid={} stream={} off={} len={}",
                    if self.shared.is_client { "C" } else { "P" },
                    f.frame_type,
                    hex8(&f.session_id),
                    f.stream_id,
                    f.byte_offset,
                    f.payload.len()
                );
            }
        }
    }

    fn spawn_pump(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let chan = Arc::clone(self);
        tokio::spawn(async move {
            let _ = chan.pump().await;
        })
    }
}

/// 会话句柄（双端同形；client 驱动建立/恢复，provider 经 accept 获得）。
/// channel 经 RwLock 可在 &self 上被 resume 更换（恢复轮换通道不夺句柄）。
pub struct Session {
    shared: Arc<SessionShared>,
    channel: std::sync::RwLock<Arc<SessionChannel>>,
    pump: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Session {
    pub fn shared(&self) -> &Arc<SessionShared> {
        &self.shared
    }

    /// 当前通道（发送面；断线恢复后由 resume 更换）。
    pub fn channel(&self) -> Arc<SessionChannel> {
        Arc::clone(&self.channel.read().unwrap())
    }

    pub async fn open_stream(&self, idem_key: &str) -> Result<u64, FabricError> {
        self.channel().open_stream(idem_key).await
    }

    pub async fn send_data(&self, stream_id: u64, payload: Bytes) -> Result<(), FabricError> {
        self.channel().send_data(stream_id, payload).await
    }

    pub async fn finish(&self, stream_id: u64) -> Result<(), FabricError> {
        self.channel().finish(stream_id).await
    }

    pub async fn recv(&self, stream_id: u64) -> Result<Bytes, FabricError> {
        self.channel().recv(stream_id).await
    }

    pub async fn phase(&self) -> SessionPhase {
        self.shared.phase().await
    }

    pub async fn request_state(&self, stream_id: u64) -> Option<RequestState> {
        self.shared.request_state(stream_id).await
    }

    pub async fn mark_started(&self, stream_id: u64) {
        self.shared.mark_started(stream_id).await;
    }

    pub async fn mark_completed(&self, stream_id: u64) {
        self.shared.mark_completed(stream_id).await;
    }

    /// 断线恢复：等传输层 Ready → RESUME 握手 → 重放/重发 → 换通道续跑。
    pub async fn resume(&self, fabric: &Fabric) -> Result<(), FabricError> {
        resume_session(fabric, self).await
    }

    fn install_channel(&self, channel: Arc<SessionChannel>) {
        if let Some(old) = self.pump.lock().unwrap().take() {
            old.abort();
        }
        let pump = channel.spawn_pump();
        *self.pump.lock().unwrap() = Some(pump);
        *self.channel.write().unwrap() = channel;
    }
}

// ---------------------------------------------------------------------------
// 会话注册表（provider 侧常驻）
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct SessionRegistry {
    inner: tokio::sync::Mutex<HashMap<[u8; 16], Arc<SessionShared>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn get_or_insert_provider(
        &self,
        session_id: [u8; 16],
        token: [u8; 16],
        peer_id: String,
        limits: JournalLimits,
    ) -> Arc<SessionShared> {
        let mut map = self.inner.lock().await;
        map.entry(session_id)
            .or_insert_with(|| SessionShared::new(session_id, token, peer_id, false, limits))
            .clone()
    }

    pub(crate) async fn get(&self, session_id: &[u8; 16]) -> Option<Arc<SessionShared>> {
        self.inner.lock().await.get(session_id).cloned()
    }
}

// ---------------------------------------------------------------------------
// wire payload 编解码（本模块单一权威；集成测试经 pub 造帧注入）
// ---------------------------------------------------------------------------

/// SESSION_INIT payload：[ver u8][sid 16][token 16][generation u64]。
pub fn encode_session_init(session_id: &[u8; 16], token: &[u8; 16], generation: u64) -> Vec<u8> {
    let mut p = Vec::with_capacity(41);
    p.push(PROTOCOL_VERSION);
    p.extend_from_slice(session_id);
    p.extend_from_slice(token);
    put_u64(&mut p, generation);
    p
}

/// SESSION_INIT_OK payload：[accepted sid 16][generation u64]。
pub fn encode_session_init_ok(session_id: &[u8; 16], generation: u64) -> Vec<u8> {
    let mut p = Vec::with_capacity(24);
    p.extend_from_slice(session_id);
    put_u64(&mut p, generation);
    p
}

/// RESUME_INIT payload：
/// [ver u8][flags u8][count u16][local_gen u64][last_seen_gen u64][nonce 16]
/// [token_len u16=16][token 16] + count × [sid u64][dir u8][rsv u8][rsv2 u16]
/// [recv_ack u64][send_next u64][final_sent u64（无终局 = u64::MAX）]。
pub fn encode_resume_init(
    generation: u64,
    last_seen_generation: u64,
    nonce: &[u8; 16],
    token: &[u8; 16],
    summaries: &[StreamSummary],
) -> Vec<u8> {
    let mut p = Vec::with_capacity(52 + 36 * summaries.len());
    p.push(PROTOCOL_VERSION);
    p.push(0);
    p.extend_from_slice(&(summaries.len() as u16).to_be_bytes());
    put_u64(&mut p, generation);
    put_u64(&mut p, last_seen_generation);
    p.extend_from_slice(nonce);
    p.extend_from_slice(&(token.len() as u16).to_be_bytes());
    p.extend_from_slice(token);
    for s in summaries {
        p.extend_from_slice(&s.stream_id.to_be_bytes());
        p.push(0);
        p.push(0);
        p.extend_from_slice(&[0, 0]);
        put_u64(&mut p, s.recv_ack);
        put_u64(&mut p, s.send_next);
        put_u64(&mut p, s.final_sent.unwrap_or(u64::MAX));
    }
    p
}

/// 解析后的 RESUME_INIT。
pub struct ResumeInitParsed {
    pub local_generation: u64,
    pub last_seen_generation: u64,
    pub nonce: [u8; 16],
    pub token: [u8; 16],
    pub summaries: Vec<StreamSummary>,
}

/// 解析 RESUME_INIT（严格长度校验；畸形 → None）。
pub fn decode_resume_init(p: &[u8]) -> Option<ResumeInitParsed> {
    if p.len() < 36 || p[0] != PROTOCOL_VERSION {
        return None;
    }
    let count = u16::from_be_bytes([p[2], p[3]]) as usize;
    let local_generation = get_u64(p, 4)?;
    let last_seen_generation = get_u64(p, 12)?;
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(&p[20..36]);
    let token_len = u16::from_be_bytes([p[36], p[37]]) as usize;
    if token_len != 16 || p.len() < 54 + count * 36 {
        return None;
    }
    let mut token = [0u8; 16];
    token.copy_from_slice(&p[38..54]);
    let mut summaries = Vec::with_capacity(count);
    let mut at = 54;
    for _ in 0..count {
        if at + 36 > p.len() {
            return None;
        }
        let mut sid = [0u8; 8];
        sid.copy_from_slice(&p[at..at + 8]);
        let stream_id = u64::from_be_bytes(sid);
        let recv_ack = get_u64(p, at + 12)?;
        let send_next = get_u64(p, at + 20)?;
        let final_raw = get_u64(p, at + 28)?;
        summaries.push(StreamSummary {
            stream_id,
            recv_ack,
            send_next,
            final_sent: (final_raw != u64::MAX).then_some(final_raw),
        });
        at += 36;
    }
    Some(ResumeInitParsed {
        local_generation,
        last_seen_generation,
        nonce,
        token,
        summaries,
    })
}

/// RESUME_OK payload：[accepted sid 16][new_generation u64][new_token 16][status u16]。
pub fn encode_resume_ok(
    session_id: &[u8; 16],
    new_generation: u64,
    new_token: &[u8; 16],
) -> Vec<u8> {
    let mut p = Vec::with_capacity(42);
    p.extend_from_slice(session_id);
    put_u64(&mut p, new_generation);
    p.extend_from_slice(new_token);
    p.extend_from_slice(&0u16.to_be_bytes());
    p
}

pub fn decode_resume_ok(p: &[u8]) -> Option<(u64, [u8; 16])> {
    if p.len() < 42 {
        return None;
    }
    let new_generation = get_u64(p, 16)?;
    let mut new_token = [0u8; 16];
    new_token.copy_from_slice(&p[24..40]);
    Some((new_generation, new_token))
}

/// RESUME_REJECT payload：[reason u8]。
pub fn encode_resume_reject(reason: u8) -> Vec<u8> {
    vec![reason]
}

// ---------------------------------------------------------------------------
// 建立与恢复入口
// ---------------------------------------------------------------------------

/// 128bit 会话/令牌随机（/dev/urandom；失败退化为混合熵——Phase 4 安全门
/// 前替换为审计过的实现）。
pub fn rand_16() -> [u8; 16] {
    use std::io::Read;
    let mut b = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut b).is_ok() {
            return b;
        }
    }
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut state = t ^ ((std::process::id() as u64) << 32) ^ 0x9E37_79B9_7F4A_7C15;
    for slot in b.iter_mut() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *slot = (state >> 24) as u8;
    }
    b
}

fn mk_session(shared: Arc<SessionShared>, send: TransportSend, recv: TransportRecv) -> Session {
    let channel = SessionChannel::new(Arc::clone(&shared), send, recv);
    let pump = channel.spawn_pump();
    Session {
        shared,
        channel: std::sync::RwLock::new(channel),
        pump: std::sync::Mutex::new(Some(pump)),
    }
}

/// 收敛期错误分类：传输类（winner 收敛杀流/拨号竞速）可重试；
/// 拒绝类为终局。
enum TryAgain {
    Transport(FabricError),
    Definitive(FabricError),
}

const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CONVERGENCE_RETRY: usize = 3;
const CONVERGENCE_BACKOFF: std::time::Duration = std::time::Duration::from_millis(250);

/// client：建立新会话（收敛感知——传输竞速失败自动换新流重试；拒绝不重试）。
pub async fn open_session(
    fabric: &Fabric,
    peer_id: &str,
    opts: SessionOptions,
) -> Result<Session, FabricError> {
    let mut last: Option<FabricError> = None;
    for _ in 0..CONVERGENCE_RETRY {
        match open_session_attempt(fabric, peer_id, opts).await {
            Ok(s) => return Ok(s),
            Err(TryAgain::Definitive(e)) => return Err(e),
            Err(TryAgain::Transport(e)) => {
                // 首建会话与对端接受侧并发拨号：winner 收敛可能关闭本流所绑
                // 连接（Phase 1 t4 实证形态）——重开新流重试
                last = Some(e);
                tokio::time::sleep(CONVERGENCE_BACKOFF).await;
            }
        }
    }
    Err(last.expect("至少一次尝试"))
}

async fn open_session_attempt(
    fabric: &Fabric,
    peer_id: &str,
    opts: SessionOptions,
) -> Result<Session, TryAgain> {
    strace!("open attempt start peer={peer_id}");
    let mut transport = super::manager::open_transport(fabric, peer_id)
        .await
        .map_err(|e| {
            strace!("open transport err {e}");
            TryAgain::Transport(e)
        })?;
    strace!("open transport epoch={}", transport.epoch);
    let session_id = rand_16();
    let token = rand_16();
    transport
        .send(&Frame {
            frame_type: FrameType::SessionInit,
            flags: 0,
            session_id,
            stream_id: 0,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from(encode_session_init(&session_id, &token, 1)),
        })
        .await
        .map_err(|e| {
            strace!("open send INIT err {e}");
            map_transport_err_try(e)
        })?;
    strace!("open INIT sent sid={}", hex8(&session_id));
    let resp = tokio::time::timeout(HANDSHAKE_TIMEOUT, transport.recv())
        .await
        .map_err(|_| {
            strace!("open OK wait timeout sid={}", hex8(&session_id));
            TryAgain::Transport(timeout_err("SESSION_INIT_OK"))
        })?
        .map_err(|e| {
            strace!("open recv err {e}");
            map_transport_err_try(e)
        })?;
    strace!(
        "open got {:?} sid={}",
        resp.frame_type,
        hex8(&resp.session_id)
    );
    match resp.frame_type {
        FrameType::SessionInitOk => {
            let shared =
                SessionShared::new(session_id, token, peer_id.to_string(), true, opts.limits);
            shared.set_phase(SessionPhase::Active).await;
            let (send, recv) = transport.into_split();
            Ok(mk_session(shared, send, recv))
        }
        FrameType::SessionInitReject => Err(TryAgain::Definitive(
            FabricError::Session(SessionError::Connect(format!(
                "session init rejected: reason={}",
                resp.payload.first().copied().unwrap_or(0)
            ))),
        )),
        other => Err(TryAgain::Definitive(FabricError::Session(
            SessionError::Connect(format!("unexpected frame {other:?}")),
        ))),
    }
}

/// provider：接受入站会话流（首帧分派 SESSION_INIT / RESUME_INIT）。
/// 拒绝路径（REJECT 已回发）返回 Err——调用方循环继续接受下一个。
pub async fn accept_any(
    fabric: &Fabric,
    peer_id: &str,
    opts: SessionOptions,
) -> Result<Session, FabricError> {
    loop {
        let mut transport = match fabric.continuity_accept_stream(peer_id).await {
            Ok(t) => {
                strace!("accept transport epoch={}", t.epoch);
                t
            }
            // 收敛期 accept 侧连接死亡（败者连接被 winner 规则关闭）：重接受
            Err(e) => {
                strace!("accept_stream err {e}");
                continue;
            }
        };
        let first = match transport.recv().await {
            Ok(f) => f,
            // 拨号期遗留死流（FIFO 首位）与 winner 收敛期被杀的流：接受下一个
            Err(e) => {
                strace!("accept first-frame err {e}");
                continue;
            }
        };
        match first.frame_type {
            FrameType::SessionInit => {
                return accept_session_init(fabric, peer_id, opts, transport, first).await
            }
            FrameType::ResumeInit => return accept_resume(fabric, transport, first).await,
            other => {
                return Err(FabricError::Session(SessionError::Connect(format!(
                    "unexpected first frame {other:?}"
                ))))
            }
        }
    }
}

/// provider：SESSION_INIT → 登记（幂等）→ SESSION_INIT_OK。
async fn accept_session_init(
    fabric: &Fabric,
    peer_id: &str,
    opts: SessionOptions,
    mut transport: super::transport::ContinuityTransport,
    init: Frame,
) -> Result<Session, FabricError> {
    let p = &init.payload;
    if p.len() != 41 || p[0] != PROTOCOL_VERSION {
        return Err(FabricError::Session(SessionError::Connect(
            "malformed SESSION_INIT".into(),
        )));
    }
    let mut sid = [0u8; 16];
    sid.copy_from_slice(&p[1..17]);
    let mut token = [0u8; 16];
    token.copy_from_slice(&p[17..33]);
    let shared = fabric
        .inner
        .continuity_sessions
        .get_or_insert_provider(sid, token, peer_id.to_string(), opts.limits)
        .await;
    transport
        .send(&Frame {
            frame_type: FrameType::SessionInitOk,
            flags: 0,
            session_id: sid,
            stream_id: 0,
            direction: Direction::ProviderToClient,
            byte_offset: 0,
            payload: Bytes::from(encode_session_init_ok(&sid, 1)),
        })
        .await
        .map_err(map_transport_err)?;
    shared.set_phase(SessionPhase::Active).await;
    let (send, recv) = transport.into_split();
    Ok(mk_session(shared, send, recv))
}

/// provider：RESUME_INIT → 两代滑窗校验 → 轮换 → RESUME_OK →
/// 摘要裁剪 journal → 重放（轮转交织）→ 重发 FIN → Active。
async fn accept_resume(
    fabric: &Fabric,
    mut transport: super::transport::ContinuityTransport,
    resume: Frame,
) -> Result<Session, FabricError> {
    let Some(parsed) = decode_resume_init(&resume.payload) else {
        transport
            .send(&Frame {
                frame_type: FrameType::ResumeReject,
                flags: 0,
                session_id: resume.session_id,
                stream_id: 0,
                direction: Direction::ProviderToClient,
                byte_offset: 0,
                payload: Bytes::from(encode_resume_reject(reject_reason::VERSION_UNSUPPORTED)),
            })
            .await
            .map_err(map_transport_err)?;
        return Err(FabricError::Session(SessionError::Connect(
            "resume rejected: malformed RESUME_INIT".into(),
        )));
    };
    let sid = resume.session_id;
    let reject = |reason: u8| Frame {
        frame_type: FrameType::ResumeReject,
        flags: 0,
        session_id: sid,
        stream_id: 0,
        direction: Direction::ProviderToClient,
        byte_offset: 0,
        payload: Bytes::from(encode_resume_reject(reason)),
    };
    let Some(shared) = fabric.inner.continuity_sessions.get(&sid).await else {
        // 内存注册表无此会话：副作用状态已丢——统一 REQUEST_STATE_LOST
        transport
            .send(&reject(reject_reason::REQUEST_STATE_LOST))
            .await
            .map_err(map_transport_err)?;
        return Err(FabricError::Session(SessionError::Connect(
            "resume rejected: REQUEST_STATE_LOST".into(),
        )));
    };
    if !shared.token_valid(parsed.local_generation, &parsed.token) {
        transport
            .send(&reject(reject_reason::TOKEN_INVALID))
            .await
            .map_err(map_transport_err)?;
        return Err(FabricError::Session(SessionError::Connect(
            "resume rejected: TOKEN_INVALID".into(),
        )));
    }
    // 两代滑窗轮换（当前代 → previous；新代生效）
    let (new_generation, new_token) = (shared.current_token().0 + 1, rand_16());
    shared.rotate_token(new_generation, new_token);
    transport
        .send(&Frame {
            frame_type: FrameType::ResumeOk,
            flags: 0,
            session_id: sid,
            stream_id: 0,
            direction: Direction::ProviderToClient,
            byte_offset: 0,
            payload: Bytes::from(encode_resume_ok(&sid, new_generation, &new_token)),
        })
        .await
        .map_err(map_transport_err)?;
    // 摘要裁剪：client 的 recv_ack = 本端 P→C 数据已被接收水位
    shared.advance_journal_from_summary(&parsed.summaries).await;
    // 重放未 ack 段（轮转交织——小流/控制不被大流垄断）
    for (stream_id, offset, payload) in interleave_replay(shared.replay_batches().await) {
        transport
            .send(&Frame {
                frame_type: FrameType::Data,
                flags: frame::flags::REPLAY,
                session_id: sid,
                stream_id,
                direction: shared.send_direction(),
                byte_offset: offset,
                payload,
            })
            .await
            .map_err(map_transport_err)?;
    }
    // 重发 FIN（终局帧不入 journal——对端可能未收到）
    for (stream_id, final_offset) in shared.fin_resent_streams().await {
        transport
            .send(&Frame {
                frame_type: FrameType::Fin,
                flags: frame::flags::END | frame::flags::REPLAY,
                session_id: sid,
                stream_id,
                direction: shared.send_direction(),
                byte_offset: final_offset,
                payload: Bytes::new(),
            })
            .await
            .map_err(map_transport_err)?;
    }
    shared.set_phase(SessionPhase::Active).await;
    let (send, recv) = transport.into_split();
    Ok(mk_session(shared, send, recv))
}

/// client：断线后恢复（等 Ready → RESUME_INIT → 续传）。收敛感知——
/// 重连竞速期传输失败自动重试；RESUME_REJECT 为终局（phase → Dead）。
pub async fn resume_session(fabric: &Fabric, session: &Session) -> Result<(), FabricError> {
    let mut last: Option<FabricError> = None;
    for _ in 0..CONVERGENCE_RETRY {
        match resume_attempt(fabric, session).await {
            Ok(()) => return Ok(()),
            Err(TryAgain::Definitive(e)) => return Err(e),
            Err(TryAgain::Transport(e)) => {
                last = Some(e);
                tokio::time::sleep(CONVERGENCE_BACKOFF).await;
            }
        }
    }
    Err(last.expect("至少一次尝试"))
}

async fn resume_attempt(fabric: &Fabric, session: &Session) -> Result<(), TryAgain> {
    let peer = session.shared.peer_id.clone();
    // 等 Phase 1 manager 重建传输连接（退避 1s..30s）
    let mut watch = fabric
        .continuity_watch(&peer)
        .await
        .map_err(TryAgain::Transport)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while watch.borrow().phase != ConnectionPhase::Ready {
        if tokio::time::Instant::now() >= deadline {
            return Err(TryAgain::Transport(timeout_err("recovery window")));
        }
        tokio::time::timeout(std::time::Duration::from_secs(30), watch.changed())
            .await
            .map_err(|_| TryAgain::Transport(timeout_err("watch change")))?
            .map_err(|_| TryAgain::Transport(timeout_err("watch closed")))?;
    }
    let mut transport = fabric
        .continuity_open_transport(&peer)
        .await
        .map_err(TryAgain::Transport)?;
    let (generation, token) = session.shared.current_token();
    let payload = encode_resume_init(
        generation,
        generation,
        &rand_16(),
        &token,
        &session.shared.summaries().await,
    );
    transport
        .send(&Frame {
            frame_type: FrameType::ResumeInit,
            flags: 0,
            session_id: session.shared.session_id,
            stream_id: 0,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from(payload),
        })
        .await
        .map_err(map_transport_err_try)?;
    let resp = tokio::time::timeout(HANDSHAKE_TIMEOUT, transport.recv())
        .await
        .map_err(|_| TryAgain::Transport(timeout_err("RESUME_OK")))?
        .map_err(map_transport_err_try)?;
    match resp.frame_type {
        FrameType::ResumeOk => {
            let Some((new_generation, new_token)) = decode_resume_ok(&resp.payload) else {
                return Err(TryAgain::Definitive(FabricError::Session(
                    SessionError::Connect("malformed RESUME_OK".into()),
                )));
            };
            session.shared.rotate_token(new_generation, new_token);
            // 重发 OPEN（幂等归并，不占数据 offset 空间）
            for (stream_id, idem) in session.shared.open_resend_list().await {
                transport
                    .send(&Frame {
                        frame_type: FrameType::Open,
                        flags: frame::flags::START | frame::flags::REPLAY,
                        session_id: session.shared.session_id,
                        stream_id,
                        direction: session.shared.send_direction(),
                        byte_offset: 0,
                        payload: Bytes::from(format!(
                            "{{\"requestId\":\"{stream_id}\",\"idempotencyKey\":\"{idem}\"}}"
                        )),
                    })
                    .await
                    .map_err(map_transport_err_try)?;
            }
            // 重放未 ack 段（client 侧对称；对端 RecvWindow 去重）
            for (stream_id, offset, payload) in
                interleave_replay(session.shared.replay_batches().await)
            {
                transport
                    .send(&Frame {
                        frame_type: FrameType::Data,
                        flags: frame::flags::REPLAY,
                        session_id: session.shared.session_id,
                        stream_id,
                        direction: session.shared.send_direction(),
                        byte_offset: offset,
                        payload,
                    })
                    .await
                    .map_err(map_transport_err_try)?;
            }
            // 重发 FIN
            for (stream_id, final_offset) in session.shared.fin_resent_streams().await {
                transport
                    .send(&Frame {
                        frame_type: FrameType::Fin,
                        flags: frame::flags::END | frame::flags::REPLAY,
                        session_id: session.shared.session_id,
                        stream_id,
                        direction: session.shared.send_direction(),
                        byte_offset: final_offset,
                        payload: Bytes::new(),
                    })
                    .await
                    .map_err(map_transport_err_try)?;
            }
            let (send, recv) = transport.into_split();
            session.install_channel(SessionChannel::new(
                Arc::clone(&session.shared),
                send,
                recv,
            ));
            session.shared.set_phase(SessionPhase::Active).await;
            Ok(())
        }
        FrameType::ResumeReject => {
            session.shared.set_phase(SessionPhase::Dead).await;
            Err(TryAgain::Definitive(FabricError::Session(
                SessionError::Connect(format!(
                    "resume rejected: reason={}",
                    resp.payload.first().copied().unwrap_or(0)
                )),
            )))
        }
        other => Err(TryAgain::Definitive(FabricError::Session(
            SessionError::Connect(format!("unexpected frame {other:?}")),
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_window_two_generations() {
        let mut w = TokenWindow::new([1u8; 16]);
        assert!(w.validate(1, &[1u8; 16]));
        w.rotate(2, [2u8; 16]);
        // 两代滑窗：current + previous 均有效
        assert!(w.validate(2, &[2u8; 16]));
        assert!(w.validate(1, &[1u8; 16]));
        assert!(!w.validate(1, &[9u8; 16]), "token 不匹配必须拒绝");
        w.rotate(3, [3u8; 16]);
        // gen1 已被挤出滑窗（stale epoch/token）
        assert!(!w.validate(1, &[1u8; 16]));
        assert!(w.validate(2, &[2u8; 16]));
        assert!(w.validate(3, &[3u8; 16]));
    }

    #[test]
    fn resume_init_roundtrip() {
        let summaries = vec![
            StreamSummary {
                stream_id: 1,
                recv_ack: 100,
                send_next: 200,
                final_sent: Some(200),
            },
            StreamSummary {
                stream_id: 3,
                recv_ack: 0,
                send_next: 0,
                final_sent: None,
            },
        ];
        let p = encode_resume_init(2, 1, &[7u8; 16], &[9u8; 16], &summaries);
        let parsed = decode_resume_init(&p).expect("parse");
        assert_eq!(parsed.local_generation, 2);
        assert_eq!(parsed.token, [9u8; 16]);
        assert_eq!(parsed.summaries.len(), 2);
        assert_eq!(parsed.summaries[0].recv_ack, 100);
        assert_eq!(parsed.summaries[0].final_sent, Some(200));
        assert_eq!(parsed.summaries[1].final_sent, None);
        // 截断拒绝
        assert!(decode_resume_init(&p[..p.len() - 1]).is_none());
    }

    #[test]
    fn interleave_is_round_robin() {
        let big = (0..10)
            .map(|i| (i as u64 * 10, Bytes::from(vec![0u8; 10])))
            .collect();
        let small = vec![(0u64, Bytes::from(vec![1u8; 5]))];
        let out = interleave_replay(vec![(1u64, big), (3u64, small)]);
        let order: Vec<u64> = out.iter().map(|(sid, _, _)| *sid).collect();
        // 小流（1 段）必须在大流全部 10 段发完之前获得发送机会
        let small_at = order.iter().position(|s| *s == 3).unwrap();
        let big_last = order.iter().rposition(|s| *s == 1).unwrap();
        assert!(small_at < big_last, "轮转交织必须防大流垄断: {order:?}");
        // 大流 offset 有序
        let big_offsets: Vec<u64> = out
            .iter()
            .filter(|(sid, _, _)| *sid == 1)
            .map(|(_, off, _)| *off)
            .collect();
        let mut sorted = big_offsets.clone();
        sorted.sort();
        assert_eq!(big_offsets, sorted);
    }

    #[tokio::test]
    async fn journal_cap_gates_record_before_send() {
        // 不 ACK 时内存有界：record 前置闸门在上限处拒绝（未触发送路径）
        let shared = SessionShared::new([1u8; 16], [2u8; 16], "peer".into(), true, {
            let mut l = JournalLimits::default();
            l.max_stream_bytes = 64 * 1024;
            l.max_segments = 128;
            l
        });
        let chunk = Bytes::from(vec![0u8; 32 * 1024]);
        assert!(shared.record_send(1, &chunk).await.is_ok());
        assert!(shared.record_send(1, &chunk).await.is_ok());
        assert_eq!(shared.journal_held_bytes(1).await, 64 * 1024);
        assert!(
            shared.record_send(1, &chunk).await.is_err(),
            "超限必须在上限处拒绝（有界）"
        );
        assert_eq!(shared.journal_held_bytes(1).await, 64 * 1024);
    }

    #[tokio::test]
    async fn duplicate_and_overlap_semantics() {
        // 协议语义（网络无关）：重复帧不重复交付；overlap 不一致 → RESET
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let sid = [1u8; 16];
        let f = |off: u64, data: &[u8]| Frame {
            frame_type: FrameType::Data,
            flags: 0,
            session_id: sid,
            stream_id: 1,
            direction: Direction::ClientToProvider,
            byte_offset: off,
            payload: Bytes::copy_from_slice(data),
        };
        let ack = shared.handle_frame(&f(0, b"AAAA")).await.expect("deliver→ack");
        assert_eq!(ack.frame_type, FrameType::Ack);
        assert_eq!(ack.byte_offset, 4);
        // 精确重复：不重复交付（ACK 回发幂等）
        let ack2 = shared.handle_frame(&f(0, b"AAAA")).await.expect("dup→ack");
        assert_eq!(ack2.frame_type, FrameType::Ack);
        assert_eq!(ack2.byte_offset, 4);
        // 交付恰好一份
        assert_eq!(shared.recv(1).await.unwrap(), Bytes::from_static(b"AAAA"));
        // overlap 内容不一致 → RESET
        let rst = shared
            .handle_frame(&f(0, b"XXXX"))
            .await
            .expect("mismatch→reset");
        assert_eq!(rst.frame_type, FrameType::Reset);
        // RESET 后流终结
        assert!(shared.recv(1).await.is_err());
    }

    #[test]
    fn idem_key_extraction() {
        assert_eq!(
            parse_idem_key(br#"{"requestId":"7","idempotencyKey":"chat-42"}"#),
            "chat-42"
        );
        assert_eq!(
            parse_idem_key(b"garbage"),
            "auto-7",
            "无键 payload 退化为确定性占位键"
        );
    }
}
