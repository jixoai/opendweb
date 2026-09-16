//! continuity 会话协议（app-protocol-layer Phase 2 tasks 3.1-3.3 + 硬化轮）。
//!
//! 架构：每会话**一条 bidi 流多路复用**（`SessionChannel` 收/发半边分别加锁
//! ——收帧等待不阻塞数据发送；ACK 由 pump 立即回发，重放按流轮转 + 每轮
//! 切片上限，单帧 ≤1MiB 的传输时延是控制帧最坏等待——design §5 HOL 缓解）。
//! 去重/journal 语义复用 Phase 0 模型（`RecvWindow`/`StreamJournal`——本层
//! 只接线，不重造语义）。
//!
//! 生命周期：
//! - 新会话：SESSION_INIT（client 生成 session_id+token——**重试循环外一次
//!   生成、各 attempt 复用**，硬化 P0-2：重试幂等、ghost 收敛）→ SESSION_INIT_OK
//! - 断线后（Phase 1 manager 自动重建传输连接）：client 发 RESUME_INIT
//!   （携带 current token + 流水位摘要）→ provider **原子裁决+轮换**
//!   （`try_rotate`：validate 与 rotate 同一临界区，硬化 P0-1）→ RESUME_OK
//!   （轮换 new_generation/new_token）→ 双方**先装通道再重放**（硬化 P1-5：
//!   重放经 channel 与接收并发排水，双向大 replay 不互等死锁）→ 重放未 ack
//!   段、重发 OPEN（幂等归并）/FIN 继续流
//! - 拒绝：TOKEN_INVALID / REQUEST_STATE_LOST（进程重启语义——内存注册表
//!   无此会话即副作状态已丢，design §2.3）
//!
//! 副作用状态机（design §2.8）：OPEN 落 ACCEPTED（幂等键归并重复 OPEN）；
//! provider 应用经 [`SessionShared::try_mark_started`] 进入 STARTED（CAS——
//! 仅 Accepted→Started 的那次返回 true，副作用唯一执行者判定）——**恢复轮
//! 不重执行**；COMPLETED 后响应 journal 仍可重放。
//!
//! 硬化轮裁定记录（2026-09-16，Codex 复核 4.5/10 NO-GO 的整改）：
//! - **ACK commit point**（P0-3）：ACK 只推进到应用消费水位 `committed_offset`
//!   （recv 出队推进并补发）——慢消费者期间发送侧 journal 不释放，反压闭合。
//! - **双端并发 INIT winner 不适用**（P0-2 裁定）：会话恒由 client 发起
//!   （provider 仅 accept），不存在双端同发 INIT 的收敛面——provider 侧幂等
//!   裁决（同 sid+token → OK 重发既有会话；token 不符 → REJECT 0x02；
//!   peer 不符 → REJECT 0x06）即为收敛路径。design §2.3.0 的 deterministic
//!   winner 规则在「双向均可发起」的模型下才有意义，本实现不引入。
//! - **previous 代恢复闸门**（P0-1）：previous token 仅在当前代不活跃
//!   （phase != Active——OK-lost 重试窗口）时可用；会话 Active 期间的
//!   previous 凭据 → TOKEN_INVALID（并发双 RESUME 恰一胜出）。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use bytes::Bytes;

use crate::fabric::{Fabric, FabricError};
use crate::session::SessionError;

use super::frame::{self, Direction, Frame, FrameType};
use super::model::{JournalLimits, JournalError, RecvWindow, SegmentAction, StreamJournal};
use super::state::ConnectionPhase;
use super::transport::{TransportError, TransportRecv, TransportSend};

pub const PROTOCOL_VERSION: u8 = 1;
/// gap buffer 容量（§2.7 有界）。
pub const GAP_CAP: usize = 64;
/// 重放每流每轮段数上限（§5：防单流垄断恢复通道）。
const REPLAY_PER_ROUND: usize = 4;
/// 交付队列软上限（P0-3 记账面）：超过即「慢消费者」状态。硬上界由发送侧
/// journal 上限闭合——未消费 ⟹ 未 ACK ⟹ 仍在发送方 journal（2MiB/流、
/// 8MiB/会话），接收队列因此天然有界，无需丢帧。
pub const DELIVER_QUEUE_CAP: usize = 256 * 1024;
/// 活跃逻辑流上限（design §2.6：超限拒绝 OPEN）。
pub const MAX_ACTIVE_STREAMS: usize = 128;

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

    /// 窗口校验（两代滑窗精确匹配；单测语义面——生产路径走 try_rotate 原子面）。
    #[cfg(test)]
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

    /// 原子裁决+轮换（P0-1）：validate 与 rotate 在调用方保证的同一临界区内
    /// 完成——两步之间不存在可观测的中间态，并发 RESUME 无法同过旧 token。
    /// - (generation, token) 匹配 current → 轮换（generation 单调 +1）。
    /// - 匹配 previous 且 `allow_previous`（当前代不活跃——OK-lost 重试窗口）
    ///   → 轮换。
    /// - 其它 → None（TOKEN_INVALID）。
    fn try_rotate(
        &mut self,
        generation: u64,
        token: &[u8; 16],
        new_token: [u8; 16],
        allow_previous: bool,
    ) -> Option<(u64, [u8; 16])> {
        let current_match = self.current.0 == generation && &self.current.1 == token;
        let previous_match = allow_previous
            && matches!(&self.previous, Some((g, t)) if *g == generation && t == token);
        if !current_match && !previous_match {
            return None;
        }
        let new_generation = self.current.0 + 1;
        self.rotate(new_generation, new_token);
        Some((new_generation, new_token))
    }

    /// previous 代清除（design §2.3.0 R5：新代首次成功交付后旧代立即失效）。
    fn clear_previous(&mut self) {
        self.previous = None;
    }

    fn current(&self) -> (u64, [u8; 16]) {
        self.current
    }

    fn current_generation(&self) -> u64 {
        self.current.0
    }

    /// SESSION_INIT 幂等裁决：INIT 携带的 token 是否与登记代一致。
    fn current_token_is(&self, token: &[u8; 16]) -> bool {
        &self.current.1 == token
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
    /// **ACK commit point**（P0-3）：应用已消费的累计 exclusive offset——
    /// ACK 只推进到此（recv 出队推进；DATA 入队不推进）。
    committed_offset: u64,
    /// 已发出的最高 ACK 水位（补发 ACK 判定：committed 越过才补发）。
    last_acked_offset: u64,
}

impl StreamCtx {
    fn new(stream_id: u64, limits: JournalLimits) -> Self {
        Self {
            recv: RecvWindow::new(),
            journal: StreamJournal::new(stream_id, limits),
            final_sent: None,
            remote_final: None,
            committed_offset: 0,
            last_acked_offset: 0,
        }
    }

    /// 流是否完全终结（名额可回收）：双方向终局 + 本端 journal 已排空。
    fn quota_reapable(&self) -> bool {
        self.remote_final.is_some()
            && self.final_sent.is_some()
            && self.journal.held_bytes() == 0
    }
}

/// 单流交付队列（frames + 字节记账——P0-3 慢消费者观测面）。
#[derive(Default)]
struct DeliverQueue {
    frames: VecDeque<Bytes>,
    bytes: usize,
}

/// 双端共享的会话核心：provider 侧常驻注册表跨连接存活（进程重启即丢——
/// RESUME 统一 REQUEST_STATE_LOST）；client 侧由 Session 句柄持有。
pub struct SessionShared {
    pub session_id: [u8; 16],
    pub peer_id: String,
    is_client: bool,
    tokens: std::sync::Mutex<TokenWindow>,
    /// previous 代是否仍占位（避免热路径无谓锁；rotate 置位、clear 复位）。
    previous_live: std::sync::atomic::AtomicBool,
    phase: tokio::sync::Mutex<SessionPhase>,
    streams: tokio::sync::Mutex<HashMap<u64, StreamCtx>>,
    next_stream_id: std::sync::atomic::AtomicU64,
    /// 副作用状态机：stream_id → (state, 幂等键)。
    requests: tokio::sync::Mutex<HashMap<u64, (RequestState, String)>>,
    /// 幂等键去重：key → stream_id（重复 OPEN 归并既有流）。
    idem_index: tokio::sync::Mutex<HashMap<String, u64>>,
    /// 非 canonical stream_id → canonical（P1-4：同幂等键重复 OPEN 的别名面）。
    aliases: tokio::sync::Mutex<HashMap<u64, u64>>,
    /// client 侧流→幂等键（恢复轮重发 OPEN 用；OPEN 不入 journal——
    /// 不占数据 offset 空间，靠对端幂等归合）。
    stream_keys: tokio::sync::Mutex<HashMap<u64, String>>,
    /// OPEN 原始 payload（HTTP 引擎的元数据面；跨连接存活）。
    open_metas: tokio::sync::Mutex<HashMap<u64, Bytes>>,
    /// 交付队列（stream_id → 有序字节），应用侧 recv 消费。
    delivered: tokio::sync::Mutex<HashMap<u64, DeliverQueue>>,
    delivered_notify: tokio::sync::Notify,
    /// 异 session_id 帧计数（P0-1：旧代/串线帧不污染会话）。
    stale_frame_count: std::sync::atomic::AtomicU64,
    /// 伪造 ACK（offset 超发）违例计数（P0-3）。
    ack_violation_count: std::sync::atomic::AtomicU64,
    /// client resume single-flight（P0-1：并发 resume 恰一执行者）。
    resume_in_flight: std::sync::atomic::AtomicBool,
    /// 当前代通道（Weak 注册——SessionChannel::new 时自登记；恢复轮换通道
    /// 后引擎经 shared 统一解析当前代，provider 侧跨 Session 实例存活）。
    current_channel: std::sync::RwLock<Option<std::sync::Weak<SessionChannel>>>,
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
            previous_live: std::sync::atomic::AtomicBool::new(false),
            phase: tokio::sync::Mutex::new(SessionPhase::Negotiating),
            streams: tokio::sync::Mutex::new(HashMap::new()),
            next_stream_id: std::sync::atomic::AtomicU64::new(if is_client { 1 } else { 2 }),
            requests: tokio::sync::Mutex::new(HashMap::new()),
            idem_index: tokio::sync::Mutex::new(HashMap::new()),
            aliases: tokio::sync::Mutex::new(HashMap::new()),
            stream_keys: tokio::sync::Mutex::new(HashMap::new()),
            open_metas: tokio::sync::Mutex::new(HashMap::new()),
            delivered: tokio::sync::Mutex::new(HashMap::new()),
            delivered_notify: tokio::sync::Notify::new(),
            stale_frame_count: std::sync::atomic::AtomicU64::new(0),
            ack_violation_count: std::sync::atomic::AtomicU64::new(0),
            resume_in_flight: std::sync::atomic::AtomicBool::new(false),
            current_channel: std::sync::RwLock::new(None),
            limits,
        })
    }

    /// 当前代通道（构造后由 SessionChannel::new 登记；始终有效）。
    pub fn current_channel(&self) -> Option<Arc<SessionChannel>> {
        self.current_channel
            .read()
            .unwrap()
            .as_ref()
            .and_then(|w| w.upgrade())
    }

    fn rotate_token(&self, new_generation: u64, new_token: [u8; 16]) {
        let mut w = self.tokens.lock().unwrap();
        w.rotate(new_generation, new_token);
        self.previous_live
            .store(true, std::sync::atomic::Ordering::Release);
    }

    fn current_token(&self) -> (u64, [u8; 16]) {
        self.tokens.lock().unwrap().current()
    }

    /// 当前代 generation（迟到响应竞态判定用）。
    fn current_generation(&self) -> u64 {
        self.tokens.lock().unwrap().current_generation()
    }

    /// 原子裁决+轮换（P0-1）：validate 与 rotate 在**单个 std::sync::Mutex
    /// 临界区**内完成。`allow_previous` = 当前代不活跃（OK-lost 重试窗口）。
    /// 返回新代 (generation, token)；失败 None（→ TOKEN_INVALID）。
    fn try_rotate(
        &self,
        generation: u64,
        token: &[u8; 16],
        new_token: [u8; 16],
        allow_previous: bool,
    ) -> Option<(u64, [u8; 16])> {
        let mut w = self.tokens.lock().unwrap();
        let out = w.try_rotate(generation, token, new_token, allow_previous);
        if out.is_some() {
            self.previous_live
                .store(true, std::sync::atomic::Ordering::Release);
        }
        out
    }

    /// SESSION_INIT 幂等裁决用：INIT token 与登记代是否一致。
    fn init_token_is(&self, token: &[u8; 16]) -> bool {
        self.tokens.lock().unwrap().current_token_is(token)
    }

    /// previous 代清除（P1-5 / design §2.3.0 R5：新代首次成功交付后旧代
    /// 立即失效——收敛后旧凭据不可再恢复）。
    fn clear_previous_token(&self) {
        if self
            .previous_live
            .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            self.tokens.lock().unwrap().clear_previous();
        }
    }

    /// 观测面：异 session_id 帧计数。
    pub fn stale_frames(&self) -> u64 {
        self.stale_frame_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 观测面：伪造 ACK（offset 超发）违例计数。
    pub fn ack_violations(&self) -> u64 {
        self.ack_violation_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 观测面：单流交付队列字节数（慢消费者状态）。
    pub async fn deliver_queue_bytes(&self, stream_id: u64) -> usize {
        self.delivered
            .lock()
            .await
            .get(&stream_id)
            .map(|q| q.bytes)
            .unwrap_or(0)
    }

    /// 观测面：慢消费者状态（交付队列超过 [`DELIVER_QUEUE_CAP`]——反压硬
    /// 上界由发送侧 journal 闭合，本观测面供指标/诊断消费）。
    pub async fn deliver_queue_over_cap(&self, stream_id: u64) -> bool {
        self.delivered
            .lock()
            .await
            .get(&stream_id)
            .map(|q| q.bytes > DELIVER_QUEUE_CAP)
            .unwrap_or(false)
    }

    /// 观测面：单流应用消费水位（ACK commit point）。
    pub async fn committed_offset(&self, stream_id: u64) -> u64 {
        self.streams
            .lock()
            .await
            .get(&stream_id)
            .map(|c| c.committed_offset)
            .unwrap_or(0)
    }

    /// 测试观测面：当前恢复凭据（集成测试注入合法 RESUME 用）。
    #[doc(hidden)]
    pub fn debug_current_token(&self) -> (u64, [u8; 16]) {
        self.current_token()
    }

    /// 本端接收方向（对端→本端 DATA 的 direction 域）。
    fn recv_direction(&self) -> Direction {
        if self.is_client {
            Direction::ProviderToClient
        } else {
            Direction::ClientToProvider
        }
    }

    /// P1-4：非 canonical stream_id → canonical（无别名则原样返回）。
    async fn resolve_stream(&self, raw: u64) -> u64 {
        self.aliases.lock().await.get(&raw).copied().unwrap_or(raw)
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

    /// provider 应用执行上游前调用：Accepted→Started CAS（P1-4——仅状态为
    /// Accepted 的那次调用返回 true，即副作用的**唯一执行者**；此后恢复轮
    /// 不重执行）。Started/Completed 状态下调用返回 false（不回退）。
    pub async fn try_mark_started(&self, stream_id: u64) -> bool {
        let mut reqs = self.requests.lock().await;
        if let Some((state, _)) = reqs.get_mut(&stream_id) {
            if *state == RequestState::Accepted {
                *state = RequestState::Started;
                return true;
            }
        }
        false
    }

    /// [`SessionShared::try_mark_started`] 的忽略返回形态（既有调用面兼容）。
    pub async fn mark_started(&self, stream_id: u64) {
        let _ = self.try_mark_started(stream_id).await;
    }

    /// 完成态落位（幂等：迟到完成不回退——Completed 是终态）。
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
    /// P0-3 commit point：出队即推进 `committed_offset`——越过上次 ACK 水位
    /// 时**补发 ACK**（经当前代通道，best-effort：失败由重放+去重自愈），
    /// 发送侧 journal 由此释放（慢消费者开始消费 → 反压解除）。
    pub async fn recv(&self, stream_id: u64) -> Result<Bytes, SessionError> {
        loop {
            let popped = {
                let mut q = self.delivered.lock().await;
                q.get_mut(&stream_id)
                    .and_then(|dq| dq.frames.pop_front())
                    .map(|b| {
                        if let Some(dq) = q.get_mut(&stream_id) {
                            dq.bytes = dq.bytes.saturating_sub(b.len());
                        }
                        b
                    })
            };
            if let Some(b) = popped {
                let mut supp_ack: Option<Frame> = None;
                {
                    let mut streams = self.streams.lock().await;
                    if let Some(ctx) = streams.get_mut(&stream_id) {
                        ctx.committed_offset += b.len() as u64;
                        if ctx.committed_offset > ctx.last_acked_offset {
                            ctx.last_acked_offset = ctx.committed_offset;
                            supp_ack = Some(mk_ack(
                                self.session_id,
                                stream_id,
                                self.recv_direction(),
                                ctx.committed_offset,
                            ));
                        }
                    }
                }
                if let Some(ack) = supp_ack {
                    if let Some(chan) = self.current_channel() {
                        // best-effort：连接死亡时丢弃——对端重放触发 Duplicate
                        // 再 ACK，语义自愈
                        let _ = chan.send_frame(&ack).await;
                    }
                }
                return Ok(b);
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
                    .is_none_or(|dq| dq.frames.is_empty());
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
    /// P0-3：先聚合**全部流** held_bytes 做 session 级上限检查
    /// （`max_session_bytes`），再走单流 journal 检查。
    pub(crate) async fn record_send(&self, stream_id: u64, payload: &Bytes) -> Result<u64, FabricError> {
        let mut streams = self.streams.lock().await;
        let session_held: usize = streams.values().map(|c| c.journal.held_bytes()).sum();
        if session_held + payload.len() > self.limits.max_session_bytes {
            return Err(FabricError::Session(SessionError::Connect(
                JournalError::SessionBytesCap {
                    held: session_held,
                    incoming: payload.len(),
                    cap: self.limits.max_session_bytes,
                }
                .to_string(),
            )));
        }
        let ctx = streams
            .entry(stream_id)
            .or_insert_with(|| StreamCtx::new(stream_id, self.limits));
        ctx.journal
            .record(payload.clone(), false)
            .map_err(|e| FabricError::Session(SessionError::Connect(format!("{e}"))))
    }

    /// P0-3d：活跃流名额预占（OPEN 前置闸门——超限拒绝；名额在流完全终结
    /// （双向终局 + journal 排空）后自然回收）。
    async fn reserve_stream_slot(&self, stream_id: u64) -> Result<(), FabricError> {
        let mut streams = self.streams.lock().await;
        let active = streams
            .values()
            .filter(|c| !c.quota_reapable())
            .count();
        if active >= MAX_ACTIVE_STREAMS {
            return Err(FabricError::Session(SessionError::Connect(format!(
                "active stream cap exceeded: {active} >= {MAX_ACTIVE_STREAMS}"
            ))));
        }
        streams.entry(stream_id).or_insert_with(|| StreamCtx::new(stream_id, self.limits));
        Ok(())
    }

    /// 处理一帧（收侧核心：去重/交付/ACK 生成/journal 释放）。
    /// P0-1：首行校验 session_id——异会话帧（旧代/串线）丢弃并计数，不污染。
    /// P1-4：stream_id 先经 alias 映射到 canonical 再处理。
    async fn handle_frame(&self, f: &Frame) -> FrameOutcome {
        if f.session_id != self.session_id {
            self.stale_frame_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return FrameOutcome {
                reply: None,
                new_open: None,
            };
        }
        match f.frame_type {
            FrameType::Data => {
                let sid = self.resolve_stream(f.stream_id).await;
                let mut streams = self.streams.lock().await;
                let ctx = streams
                    .entry(sid)
                    .or_insert_with(|| StreamCtx::new(sid, self.limits));
                let action = ctx.recv.feed(f.byte_offset, f.payload.clone(), GAP_CAP);
                match action {
                    Ok(SegmentAction::Deliver(payload)) => {
                        // P0-3 commit point：ACK 只携带应用消费水位
                        // （committed_offset——DATA 入队不推进）
                        let ack = mk_ack(
                            self.session_id,
                            sid,
                            f.direction,
                            ctx.committed_offset,
                        );
                        if ctx.committed_offset > ctx.last_acked_offset {
                            ctx.last_acked_offset = ctx.committed_offset;
                        }
                        drop(streams);
                        let queued_len = payload.len();
                        let mut q = self.delivered.lock().await;
                        let dq = q.entry(sid).or_default();
                        dq.frames.push_back(payload);
                        dq.bytes += queued_len;
                        drop(q);
                        self.delivered_notify.notify_waiters();
                        // 新代首次成功交付 → previous 失效（P1-5 / R5 收敛）
                        self.clear_previous_token();
                        FrameOutcome {
                            reply: Some(ack),
                            new_open: None,
                        }
                    }
                    Ok(SegmentAction::Duplicate) => {
                        // 幂等丢弃；仍回 ACK（对端可能未收到上次 ACK）——值恒为
                        // committed（消费水位）
                        let ack = mk_ack(
                            self.session_id,
                            sid,
                            f.direction,
                            ctx.committed_offset,
                        );
                        if ctx.committed_offset > ctx.last_acked_offset {
                            ctx.last_acked_offset = ctx.committed_offset;
                        }
                        FrameOutcome {
                            reply: Some(ack),
                            new_open: None,
                        }
                    }
                    Ok(SegmentAction::Buffered) => FrameOutcome {
                        reply: Some(mk_ack(
                            self.session_id,
                            sid,
                            f.direction,
                            ctx.committed_offset,
                        )),
                        new_open: None,
                    },
                    Ok(SegmentAction::OverlapMismatch { .. }) | Err(_) => {
                        // 内容不一致 / gap 溢出 → 流 RESET(PROTOCOL_ERROR)：
                        // 回发对端 + 本地终结（双端流死，不交付脏数据）
                        ctx.remote_final = Some(ctx.recv.expected_offset());
                        FrameOutcome {
                            reply: Some(mk_reset(self.session_id, sid)),
                            new_open: None,
                        }
                    }
                }
            }
            FrameType::Ack => {
                // ACK.direction = 被确认数据的方向；匹配本端发送方向才推进
                if f.direction == self.send_direction() {
                    let sid = self.resolve_stream(f.stream_id).await;
                    let mut streams = self.streams.lock().await;
                    if let Some(ctx) = streams.get_mut(&sid) {
                        if f.byte_offset > ctx.journal.next_offset() {
                            // P0-3e 伪造 ACK（超发确认）：拒绝推进 + 计数
                            // （合法域 ≤ next_send 才允许 clamp 推进）
                            self.ack_violation_count
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        } else {
                            ctx.journal.advance_ack(f.byte_offset);
                            // 新代首次合法 ACK → previous 失效（P1-5 / R5 收敛）
                            self.clear_previous_token();
                        }
                    }
                }
                FrameOutcome {
                    reply: None,
                    new_open: None,
                }
            }
            FrameType::Fin => {
                let sid = self.resolve_stream(f.stream_id).await;
                let mut streams = self.streams.lock().await;
                let ctx = streams
                    .entry(sid)
                    .or_insert_with(|| StreamCtx::new(sid, self.limits));
                ctx.remote_final = Some(f.byte_offset + f.payload.len() as u64);
                drop(streams);
                self.delivered_notify.notify_waiters();
                FrameOutcome {
                    reply: None,
                    new_open: None,
                }
            }
            FrameType::Open => {
                let idem = parse_idem_key(&f.payload);
                let (canonical, is_new) = self.on_open(f.stream_id, &idem).await;
                if is_new {
                    self.open_metas
                        .lock()
                        .await
                        .insert(canonical, f.payload.clone());
                } else if canonical != f.stream_id {
                    // P1-4：同幂等键不同 stream_id → 建立 canonical 别名
                    self.aliases
                        .lock()
                        .await
                        .insert(f.stream_id, canonical);
                }
                FrameOutcome {
                    reply: None,
                    new_open: is_new.then_some(canonical),
                }
            }
            FrameType::Reset => {
                let sid = self.resolve_stream(f.stream_id).await;
                let mut streams = self.streams.lock().await;
                if let Some(ctx) = streams.get_mut(&sid) {
                    ctx.remote_final = Some(ctx.recv.expected_offset());
                }
                drop(streams);
                self.delivered_notify.notify_waiters();
                FrameOutcome {
                    reply: None,
                    new_open: None,
                }
            }
            _ => FrameOutcome {
                reply: None,
                new_open: None,
            },
        }
    }

    /// OPEN 元数据（原始 JSON payload；HTTP 引擎解析 method/path/headers）。
    pub async fn open_meta(&self, stream_id: u64) -> Option<Bytes> {
        self.open_metas.lock().await.get(&stream_id).cloned()
    }

    /// 流水位摘要（RESUME_INIT 携带）。recv_ack = 本端**应用消费水位**
    /// （committed_offset，design §2.3「已连续提交的下一个 offset」——
    /// commit point 语义；对端据此裁剪重放，交付队列中的未消费段由本端
    /// 跨连接保有，重放侧去重闭合）。
    async fn summaries(&self) -> Vec<StreamSummary> {
        let streams = self.streams.lock().await;
        streams
            .iter()
            .map(|(&id, ctx)| StreamSummary {
                stream_id: id,
                recv_ack: ctx.committed_offset,
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

    /// 观测面：活跃逻辑流数（N-API SessionStateSnapshot 投影，task 4.2）。
    pub async fn stream_count(&self) -> usize {
        self.streams.lock().await.len()
    }

    /// 观测面：全部流 journal 持有字节总和（会话级 journalBytes）。
    pub async fn journal_bytes_total(&self) -> usize {
        self.streams
            .lock()
            .await
            .values()
            .map(|c| c.journal.held_bytes())
            .sum()
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

/// 帧处理结果：reply = 需立即回发的控制帧（ACK/RESET）；
/// new_open = 本次新建的逻辑流 id（重复 OPEN 幂等归并时为 None——
/// 供 channel 级 arrivals 队列消费，防恢复轮重复 dispatch）。
pub(crate) struct FrameOutcome {
    pub reply: Option<Frame>,
    pub new_open: Option<u64>,
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

/// channel 面（FabricError）→ 收敛期可重试错误。
fn map_fabric_err_try(e: FabricError) -> TryAgain {
    TryAgain::Transport(e)
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
    /// 本连接周期内新到达的逻辑流（provider 引擎的接受面）。挂 channel 而
    /// 非 shared：恢复轮新 channel 新任务接管新流，旧任务随死通道自然退出
    /// ——跨代不抢流（§3.3 恢复语义的实现基础）。
    arrivals: tokio::sync::Mutex<std::collections::VecDeque<u64>>,
    arrivals_notify: tokio::sync::Notify,
    /// pump 退出即置位（通道终结——arrivals 排空后 next_incoming 返回 None）。
    dead: std::sync::atomic::AtomicBool,
}

impl SessionChannel {
    fn new(shared: Arc<SessionShared>, send: TransportSend, recv: TransportRecv) -> Arc<Self> {
        let chan = Arc::new(Self {
            shared: Arc::clone(&shared),
            send: tokio::sync::Mutex::new(send),
            recv: tokio::sync::Mutex::new(recv),
            arrivals: tokio::sync::Mutex::new(std::collections::VecDeque::new()),
            arrivals_notify: tokio::sync::Notify::new(),
            dead: std::sync::atomic::AtomicBool::new(false),
        });
        // 当前代自登记（Weak——通道生命周期由强引用者持有，无环）
        *shared.current_channel.write().unwrap() = Some(Arc::downgrade(&chan));
        chan
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
        self.send_open(stream_id, idem_key, Bytes::from(open_json)).await?;
        Ok(stream_id)
    }

    /// 开新逻辑流（OPEN payload 全量由调用方给出——HTTP 引擎携带 §2.4
    /// 元数据；payload 原样上 wire，requestId 由调用方自定）。
    pub async fn open_stream_raw(&self, idem_key: &str, payload: Bytes) -> Result<u64, FabricError> {
        let stream_id = self.shared.alloc_stream_id();
        self.send_open(stream_id, idem_key, payload).await?;
        Ok(stream_id)
    }

    async fn send_open(
        &self,
        stream_id: u64,
        idem_key: &str,
        payload: Bytes,
    ) -> Result<(), FabricError> {
        // P0-3d：活跃流上限闸门（超限拒绝 OPEN）
        self.shared.reserve_stream_slot(stream_id).await?;
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
            payload,
        })
        .await
    }

    pub async fn recv(&self, stream_id: u64) -> Result<Bytes, FabricError> {
        self.shared
            .recv(stream_id)
            .await
            .map_err(|e| FabricError::Session(e))
    }

    /// 等待下一个新到达的逻辑流（provider 引擎接受面；None = 通道终结：
    /// pump 已退出且 arrivals 排空）。
    pub async fn next_incoming(&self) -> Option<u64> {
        loop {
            if let Some(id) = self.arrivals.lock().await.pop_front() {
                return Some(id);
            }
            if self.dead.load(std::sync::atomic::Ordering::SeqCst) {
                return None;
            }
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                self.arrivals_notify.notified(),
            )
            .await;
        }
    }

    /// 会话泵：独占收半边——收帧 → 语义处理 → 控制帧立即回发。
    /// 连接死亡（Ended/Io）→ Recovering + dead 置位并返回（恢复由 resume 驱动）。
    async fn pump(self: Arc<Self>) -> Result<(), FabricError> {
        let out = self.pump_inner().await;
        self.dead.store(true, std::sync::atomic::Ordering::SeqCst);
        self.arrivals_notify.notify_waiters();
        out
    }

    async fn pump_inner(self: &Arc<Self>) -> Result<(), FabricError> {
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
            let outcome = self.shared.handle_frame(&f).await;
            if let Some(stream_id) = outcome.new_open {
                self.arrivals.lock().await.push_back(stream_id);
                self.arrivals_notify.notify_waiters();
            }
            if let Some(ctrl) = outcome.reply {
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
/// 发送面优先经 shared 解析**当前代**通道（provider 侧恢复轮是新 Session
/// 实例，旧句柄发送自动切到新通道）；断线窗口（pump 已退、Weak 失效）回落
/// 本体强引用锚——最近代通道在会话存续期内不悬空。
pub struct Session {
    shared: Arc<SessionShared>,
    channel: std::sync::RwLock<Arc<SessionChannel>>,
    pump: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Session {
    pub fn shared(&self) -> &Arc<SessionShared> {
        &self.shared
    }

    /// 当前代通道（发送面；恢复轮换通道后自动指向新代）。
    pub fn channel(&self) -> Arc<SessionChannel> {
        if let Some(c) = self.shared.current_channel() {
            return c;
        }
        Arc::clone(&self.channel.read().unwrap())
    }

    pub async fn open_stream(&self, idem_key: &str) -> Result<u64, FabricError> {
        self.channel().open_stream(idem_key).await
    }

    pub async fn send_data(&self, stream_id: u64, payload: Bytes) -> Result<(), FabricError> {
        self.channel().send_data(stream_id, payload).await
    }

    /// 记录发送段（journal 一次；引擎断线重发用——定 offset 裸帧重发由
    /// [`Session::send_data_at`] 承接，对端 RecvWindow 去重闭合）。
    pub async fn prepare_send(
        &self,
        stream_id: u64,
        payload: &Bytes,
    ) -> Result<u64, FabricError> {
        self.shared.record_send(stream_id, payload).await
    }

    /// 以已记录的 offset 裸发 DATA 帧（不重复 record；重发幂等）。
    pub async fn send_data_at(
        &self,
        stream_id: u64,
        offset: u64,
        payload: Bytes,
    ) -> Result<(), FabricError> {
        self.channel()
            .send_frame(&Frame {
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

    pub async fn finish(&self, stream_id: u64) -> Result<(), FabricError> {
        self.channel().finish(stream_id).await
    }

    pub async fn recv(&self, stream_id: u64) -> Result<Bytes, FabricError> {
        self.channel().recv(stream_id).await
    }

    /// provider 引擎接受面：等待下一个新到达的逻辑流（None = 当前通道终结；
    /// 恢复后经新 Session/channel 继续）。
    pub async fn next_incoming(&self) -> Option<u64> {
        self.channel().next_incoming().await
    }

    /// OPEN 元数据（原始 JSON payload；HTTP 引擎解析）。
    pub async fn open_meta(&self, stream_id: u64) -> Option<Bytes> {
        self.shared.open_meta(stream_id).await
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
    /// P0-1c single-flight：并发调用恰一执行者（CAS）；后来者立即返回 Ok
    /// （进行中的恢复由先到者闭合，phase/数据面以先到者结果为准）。
    pub async fn resume(&self, fabric: &Fabric) -> Result<(), FabricError> {
        if self
            .shared
            .resume_in_flight
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return Ok(());
        }
        let out = resume_session(fabric, self).await;
        self.shared
            .resume_in_flight
            .store(false, std::sync::atomic::Ordering::Release);
        out
    }

    /// 显式关闭（Shutdown 语义第一步，SDK task 4.2）：置 Closed + 终止 pump。
    /// 发送面此后经当前代通道解析失败/死通道报错；终局对端由超时暴露。
    pub async fn close(&self) {
        if let Some(old) = self.pump.lock().unwrap().take() {
            old.abort();
        }
        self.shared.set_phase(SessionPhase::Closed).await;
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

/// SESSION_INIT 准入裁决结果（P0-2：幂等 + peer/token 绑定校验）。
pub(crate) enum InitAdmission {
    /// 准入（新会话，或同 sid+token 的幂等重发——返回既有会话）。
    Admitted(Arc<SessionShared>),
    /// 同 sid 但 peer 不符 → REJECT 0x06 POLICY_DENIED。
    PeerMismatch,
    /// 同 sid 但 token 不符（伪造/竞态）→ REJECT 0x02 TOKEN_INVALID。
    TokenMismatch,
}

#[derive(Default)]
pub struct SessionRegistry {
    inner: tokio::sync::Mutex<HashMap<[u8; 16], Arc<SessionShared>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// SESSION_INIT 准入（P0-2）：
    /// - 无此 sid → 登记新会话（绑定 peer_id + token）。
    /// - 有此 sid 且 peer 一致且 token 与登记代一致 → 幂等 OK（重发既有会话
    ///   ——client 重试用同一 sid/token，ghost 收敛）。
    /// - peer 不符 → PeerMismatch；token 不符 → TokenMismatch。
    pub(crate) async fn admit_init(
        &self,
        session_id: [u8; 16],
        token: [u8; 16],
        peer_id: String,
        limits: JournalLimits,
    ) -> InitAdmission {
        let mut map = self.inner.lock().await;
        if let Some(existing) = map.get(&session_id) {
            if existing.peer_id != peer_id {
                return InitAdmission::PeerMismatch;
            }
            if !existing.init_token_is(&token) {
                return InitAdmission::TokenMismatch;
            }
            return InitAdmission::Admitted(existing.clone());
        }
        let shared = SessionShared::new(session_id, token, peer_id, false, limits);
        map.insert(session_id, Arc::clone(&shared));
        InitAdmission::Admitted(shared)
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
/// 边界（P1-6）：p[36]/p[37]（token_len）读取前置 → 最小可判长度 38；
/// count × 36 用 checked 算术（u16 count ≤ 65535，65535×36 < usize::MAX
/// 恒不溢出——checked_add 双保险）。
pub fn decode_resume_init(p: &[u8]) -> Option<ResumeInitParsed> {
    if p.len() < 38 || p[0] != PROTOCOL_VERSION {
        return None;
    }
    let count = u16::from_be_bytes([p[2], p[3]]) as usize;
    let local_generation = get_u64(p, 4)?;
    let last_seen_generation = get_u64(p, 12)?;
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(&p[20..36]);
    let token_len = u16::from_be_bytes([p[36], p[37]]) as usize;
    let summaries_at = 54usize.checked_add(count.checked_mul(36)?)?;
    if token_len != 16 || p.len() < summaries_at {
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

/// SESSION_INIT_REJECT payload：[reason u8]（P0-2——复用 RESUME reason 表：
/// 0x02 TOKEN_INVALID / 0x06 POLICY_DENIED；硬化轮裁定，见模块注释）。
pub fn encode_session_init_reject(reason: u8) -> Vec<u8> {
    vec![reason]
}

// ---------------------------------------------------------------------------
// 建立与恢复入口
// ---------------------------------------------------------------------------

/// 128bit 会话/令牌随机（/dev/urandom；**fail-closed**——打开/读取失败返回
/// None，由调用方以「entropy unavailable」终结连接级操作。不设劣质熵兜底：
/// 会话凭据弱随机 = 认证面失守，宁可拒绝服务）。
pub fn rand_16() -> Option<[u8; 16]> {
    use std::io::Read;
    let mut b = [0u8; 16];
    let mut f = std::fs::File::open("/dev/urandom").ok()?;
    f.read_exact(&mut b).ok()?;
    Some(b)
}

/// 熵不可用错误（连接级致命；消息固定）。
fn entropy_err() -> FabricError {
    FabricError::Session(SessionError::Connect("entropy unavailable".into()))
}

fn mk_session(shared: Arc<SessionShared>, send: TransportSend, recv: TransportRecv) -> Session {
    let channel = SessionChannel::new(Arc::clone(&shared), send, recv);
    let pump = channel.spawn_pump();
    Session {
        shared,
        channel: std::sync::RwLock::new(Arc::clone(&channel)),
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
/// P0-2：session_id/token **重试循环外一次生成**、各 attempt 复用——重试
/// 对 provider 幂等（同 sid+token → OK 重发既有会话），ghost 会话不再累积。
pub async fn open_session(
    fabric: &Fabric,
    peer_id: &str,
    opts: SessionOptions,
) -> Result<Session, FabricError> {
    let session_id = rand_16().ok_or_else(entropy_err)?;
    let token = rand_16().ok_or_else(entropy_err)?;
    let mut last: Option<FabricError> = None;
    for _ in 0..CONVERGENCE_RETRY {
        match open_session_attempt(fabric, peer_id, opts, session_id, token).await {
            Ok(s) => return Ok(s),
            Err(TryAgain::Definitive(e)) => return Err(e),
            Err(TryAgain::Transport(e)) => {
                // 首建会话与对端接受侧并发拨号：winner 收敛可能关闭本流所绑
                // 连接（Phase 1 t4 实证形态）——重开新流重试（sid/token 复用）
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
    session_id: [u8; 16],
    token: [u8; 16],
) -> Result<Session, TryAgain> {
    strace!("open attempt start peer={peer_id}");
    let mut transport = super::manager::open_transport(fabric, peer_id)
        .await
        .map_err(|e| {
            strace!("open transport err {e}");
            TryAgain::Transport(e)
        })?;
    strace!("open transport epoch={}", transport.epoch);
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

/// provider：SESSION_INIT → 准入裁决（P0-2：幂等 + peer/token 绑定）→
/// SESSION_INIT_OK / SESSION_INIT_REJECT（reason u8）。
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
    let shared = match fabric
        .inner
        .continuity_sessions
        .admit_init(sid, token, peer_id.to_string(), opts.limits)
        .await
    {
        InitAdmission::Admitted(shared) => shared,
        InitAdmission::PeerMismatch => {
            // 同 sid 绑定其它 peer：策略拒绝（REJECT 0x06）
            transport
                .send(&Frame {
                    frame_type: FrameType::SessionInitReject,
                    flags: 0,
                    session_id: sid,
                    stream_id: 0,
                    direction: Direction::ProviderToClient,
                    byte_offset: 0,
                    payload: Bytes::from(encode_session_init_reject(
                        reject_reason::POLICY_DENIED,
                    )),
                })
                .await
                .map_err(map_transport_err)?;
            return Err(FabricError::Session(SessionError::Connect(
                "session init rejected: POLICY_DENIED (peer mismatch)".into(),
            )));
        }
        InitAdmission::TokenMismatch => {
            // 同 sid 但 token 不符（伪造/竞态）：REJECT 0x02
            transport
                .send(&Frame {
                    frame_type: FrameType::SessionInitReject,
                    flags: 0,
                    session_id: sid,
                    stream_id: 0,
                    direction: Direction::ProviderToClient,
                    byte_offset: 0,
                    payload: Bytes::from(encode_session_init_reject(
                        reject_reason::TOKEN_INVALID,
                    )),
                })
                .await
                .map_err(map_transport_err)?;
            return Err(FabricError::Session(SessionError::Connect(
                "session init rejected: TOKEN_INVALID".into(),
            )));
        }
    };
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

/// provider：RESUME_INIT → **原子裁决+轮换**（`try_rotate`——validate 与
/// rotate 单临界区，P0-1）→ RESUME_OK → 摘要裁剪 journal → **先装通道
/// （pump 并发排水）再后台重放**（P1-5：双向大 replay 不在握手路径上互等）
/// → 重发 FIN → Active。
/// previous 代闸门：仅当前代不活跃（phase != Active，OK-lost 重试窗口）时
/// 可用——会话 Active 期间的 previous 凭据 → TOKEN_INVALID（并发双 RESUME
/// 恰一胜出）。
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
    // P0-1：原子裁决+轮换（新 token 在临界区外生成——fail-closed 前置）
    let new_token = rand_16().ok_or_else(entropy_err)?;
    let allow_previous = shared.phase().await != SessionPhase::Active;
    let Some((new_generation, new_token)) =
        shared.try_rotate(parsed.local_generation, &parsed.token, new_token, allow_previous)
    else {
        transport
            .send(&reject(reject_reason::TOKEN_INVALID))
            .await
            .map_err(map_transport_err)?;
        return Err(FabricError::Session(SessionError::Connect(
            "resume rejected: TOKEN_INVALID".into(),
        )));
    };
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
    // 摘要裁剪：client 的 recv_ack = 本端 P→C 数据已被消费水位（commit point）
    shared.advance_journal_from_summary(&parsed.summaries).await;
    // P1-5：**先 split + 建通道（pump 立即排水对端重放/ACK）**，重放转后台
    // 任务经 channel 发送——恢复握手里不再有大数据量同步发送，与对端的
    // 反向重放并发进行（QUIC 流控互等死锁闭合）。
    let (send, recv) = transport.into_split();
    let session = mk_session(Arc::clone(&shared), send, recv);
    {
        let replay_shared = Arc::clone(&shared);
        let replay_chan = session.channel();
        tokio::spawn(async move {
            // 重放未 ack 段（轮转交织——小流/控制不被大流垄断）；连接死亡
            // 即中止——journal 未释放，下一轮恢复自愈重放
            for (stream_id, offset, payload) in
                interleave_replay(replay_shared.replay_batches().await)
            {
                let frame = Frame {
                    frame_type: FrameType::Data,
                    flags: frame::flags::REPLAY,
                    session_id: replay_shared.session_id,
                    stream_id,
                    direction: replay_shared.send_direction(),
                    byte_offset: offset,
                    payload,
                };
                if replay_chan.send_frame(&frame).await.is_err() {
                    return;
                }
            }
            // 重发 FIN（终局帧不入 journal——对端可能未收到）
            for (stream_id, final_offset) in replay_shared.fin_resent_streams().await {
                let frame = Frame {
                    frame_type: FrameType::Fin,
                    flags: frame::flags::END | frame::flags::REPLAY,
                    session_id: replay_shared.session_id,
                    stream_id,
                    direction: replay_shared.send_direction(),
                    byte_offset: final_offset,
                    payload: Bytes::new(),
                };
                if replay_chan.send_frame(&frame).await.is_err() {
                    return;
                }
            }
        });
    }
    shared.set_phase(SessionPhase::Active).await;
    Ok(session)
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
    // 迟到响应竞态判定基线（P0-1d）：本 attempt 期间的 generation
    let gen_before = session.shared.current_generation();
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
    let nonce = rand_16().ok_or_else(|| TryAgain::Definitive(entropy_err()))?;
    let payload = encode_resume_init(
        generation,
        generation,
        &nonce,
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
            // P1-5：**先 split + 装通道（pump 立即排水对端重放）**，此后
            // OPEN/DATA/FIN 重发经 channel 与接收并发——双向大 replay 不在
            // 握手路径互等（QUIC 流控死锁闭合）。
            let (send, recv) = transport.into_split();
            let chan = SessionChannel::new(Arc::clone(&session.shared), send, recv);
            session.install_channel(Arc::clone(&chan));
            session.shared.set_phase(SessionPhase::Active).await;
            // 重发 OPEN（幂等归并，不占数据 offset 空间）
            for (stream_id, idem) in session.shared.open_resend_list().await {
                chan.send_frame(&Frame {
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
                .map_err(map_fabric_err_try)?;
            }
            // 重放未 ack 段（client 侧对称；对端 RecvWindow 去重）
            for (stream_id, offset, payload) in
                interleave_replay(session.shared.replay_batches().await)
            {
                chan.send_frame(&Frame {
                    frame_type: FrameType::Data,
                    flags: frame::flags::REPLAY,
                    session_id: session.shared.session_id,
                    stream_id,
                    direction: session.shared.send_direction(),
                    byte_offset: offset,
                    payload,
                })
                .await
                .map_err(map_fabric_err_try)?;
            }
            // 重发 FIN
            for (stream_id, final_offset) in session.shared.fin_resent_streams().await {
                chan.send_frame(&Frame {
                    frame_type: FrameType::Fin,
                    flags: frame::flags::END | frame::flags::REPLAY,
                    session_id: session.shared.session_id,
                    stream_id,
                    direction: session.shared.send_direction(),
                    byte_offset: final_offset,
                    payload: Bytes::new(),
                })
                .await
                .map_err(map_fabric_err_try)?;
            }
            Ok(())
        }
        FrameType::ResumeReject => {
            // P0-1d 迟到响应竞态：若本 attempt 期间已成功轮换（generation 前移
            // / phase Active——并发恢复已闭合），拒绝不得把会话置 Dead
            if session.shared.current_generation() == gen_before
                && session.shared.phase().await != SessionPhase::Active
            {
                session.shared.set_phase(SessionPhase::Dead).await;
            }
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

    fn data_frame(sid: [u8; 16], stream: u64, off: u64, data: &[u8]) -> Frame {
        Frame {
            frame_type: FrameType::Data,
            flags: 0,
            session_id: sid,
            stream_id: stream,
            direction: Direction::ClientToProvider,
            byte_offset: off,
            payload: Bytes::copy_from_slice(data),
        }
    }

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

    /// P0-1：原子裁决+轮换——current 恒可用；previous 受 allow_previous 闸门。
    #[test]
    fn token_window_try_rotate_adjudication() {
        let mut w = TokenWindow::new([1u8; 16]);
        // current 匹配（allow_previous 无关）→ 轮换
        assert!(w.try_rotate(1, &[1u8; 16], [2u8; 16], false).is_some());
        // previous 匹配 + 会话 Active（allow=false，并发双 RESUME）→ 拒绝
        assert!(
            w.try_rotate(1, &[1u8; 16], [3u8; 16], false).is_none(),
            "Active 期间的 previous 凭据必须拒绝（恰一胜出）"
        );
        // previous 匹配 + OK-lost 重试窗口（allow=true）→ 轮换
        let out = w.try_rotate(1, &[1u8; 16], [3u8; 16], true).unwrap();
        assert_eq!(out.0, 3, "generation = current.0 + 1（单调）");
        // 错 token / 错 generation → 拒绝
        assert!(w.try_rotate(2, &[9u8; 16], [4u8; 16], true).is_none());
        assert!(w.try_rotate(1, &[3u8; 16], [4u8; 16], true).is_none());
        // 新 current 恒可用
        assert!(w.try_rotate(3, &[3u8; 16], [4u8; 16], false).is_some());
    }

    /// P1-5 / R5：previous 清除后旧代凭据立即失效。
    #[test]
    fn token_window_clear_previous() {
        let mut w = TokenWindow::new([1u8; 16]);
        w.rotate(2, [2u8; 16]);
        w.clear_previous();
        assert!(!w.validate(1, &[1u8; 16]), "清除后旧代拒绝");
        assert!(w.validate(2, &[2u8; 16]), "current 不受影响");
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

    /// P1-6：36/37 字节 payload（token_len 域读取前置边界）不 panic、返回 None。
    #[test]
    fn resume_init_short_payloads_no_panic() {
        for len in [0usize, 1, 4, 35, 36, 37] {
            let mut p = vec![0u8; len];
            if !p.is_empty() {
                p[0] = PROTOCOL_VERSION; // 合法版本前缀，触发长度边界而非版本拒绝
            }
            assert!(decode_resume_init(&p).is_none(), "len={len} 必须拒绝");
        }
    }

    #[test]
    fn rand_16_entropy_source_available() {
        // CI/开发环境 /dev/urandom 可用（fail-closed 语义的正路径钉）
        let a = rand_16();
        assert!(a.is_some(), "/dev/urandom 必须可用");
        let b = rand_16().unwrap();
        assert_ne!(a.unwrap(), b, "两次抽样不得退化相同");
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

    /// P0-3c：session 级字节上限——跨流聚合，超限 Err；释放后名额恢复。
    #[tokio::test]
    async fn session_bytes_cap_aggregates_streams() {
        let shared = SessionShared::new([1u8; 16], [2u8; 16], "peer".into(), true, {
            let mut l = JournalLimits::default();
            l.max_session_bytes = 64 * 1024;
            l.max_stream_bytes = 64 * 1024;
            l.max_segments = 4096;
            l
        });
        let half = Bytes::from(vec![0u8; 32 * 1024]);
        shared.record_send(1, &half).await.unwrap();
        shared.record_send(3, &half).await.unwrap();
        // 64KiB 已满：新流（或既有流）1 字节即超 session 上限
        let err = shared
            .record_send(5, &Bytes::from(vec![0u8; 1]))
            .await
            .expect_err("session 级上限必须拒绝");
        assert!(
            err.to_string().contains("session byte cap"),
            "错误必须是 SessionBytesCap：{err}"
        );
        // 流 3 全量 ACK 释放后名额恢复
        let ack = mk_ack([1u8; 16], 3, Direction::ClientToProvider, 32 * 1024);
        shared.handle_frame(&ack).await;
        assert!(shared.record_send(5, &Bytes::from(vec![0u8; 1])).await.is_ok());
    }

    /// P0-3d：活跃流上限 128——第 129 个 OPEN 拒绝；流完全终结后名额回收。
    #[tokio::test]
    async fn active_stream_cap_rejects_129th_open() {
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        for i in 0..MAX_ACTIVE_STREAMS {
            let sid = (i as u64) * 2 + 1;
            shared.reserve_stream_slot(sid).await.unwrap();
        }
        let err = shared
            .reserve_stream_slot(257)
            .await
            .expect_err("第 129 个 OPEN 必须拒绝");
        assert!(err.to_string().contains("active stream cap"));
        // 名额回收：流 1 完全终结（双向终局 + journal 空）后名额释放
        {
            let mut streams = shared.streams.lock().await;
            let ctx = streams.get_mut(&1).unwrap();
            ctx.remote_final = Some(0);
            ctx.final_sent = Some(0);
        }
        shared
            .reserve_stream_slot(257)
            .await
            .expect("终结流回收名额后新 OPEN 放行");
        // 半终结（仅 remote_final）不回收
        {
            let mut streams = shared.streams.lock().await;
            let ctx = streams.get_mut(&3).unwrap();
            ctx.remote_final = Some(0);
            // final_sent 仍 None → 仍占名额
        }
        assert!(
            shared.reserve_stream_slot(259).await.is_err(),
            "未完全终结的流不释放名额"
        );
    }

    /// P0-3 commit point：ACK 停在应用消费水位——慢消费者期间发送侧 journal
    /// 不释放；消费后（补发）ACK 推进释放。
    #[tokio::test]
    async fn ack_commit_point_pends_until_consumed() {
        let sender = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let receiver = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        let chunk = Bytes::from(vec![0xAB; 1024]);
        let off = sender.record_send(1, &chunk).await.unwrap();
        assert_eq!(off, 0);
        // 模拟 wire：DATA 到达接收端
        let ack0 = receiver
            .handle_frame(&data_frame([1u8; 16], 1, 0, &chunk))
            .await
            .reply
            .expect("DATA → ACK");
        assert_eq!(
            ack0.byte_offset, 0,
            "commit point：未消费，ACK 停在 committed=0"
        );
        assert_eq!(receiver.deliver_queue_bytes(1).await, 1024);
        // 入队水位 ACK（0）不释放发送侧 journal
        sender.handle_frame(&ack0).await;
        assert_eq!(
            sender.journal_held_bytes(1).await,
            1024,
            "未消费不得释放 journal（反压闭合）"
        );
        // 应用消费 → committed 推进（补发 ACK 无通道——按观测面手动回喂）
        assert_eq!(receiver.recv(1).await.unwrap().len(), 1024);
        assert_eq!(receiver.committed_offset(1).await, 1024);
        assert_eq!(receiver.deliver_queue_bytes(1).await, 0);
        let ack1 = mk_ack(
            [1u8; 16],
            1,
            Direction::ClientToProvider,
            receiver.committed_offset(1).await,
        );
        sender.handle_frame(&ack1).await;
        assert_eq!(sender.journal_held_bytes(1).await, 0, "消费后 ACK 释放");
    }

    /// P0-3e：伪造 ACK（offset 超发）——拒绝推进 + 计数；合法域内推进。
    #[tokio::test]
    async fn forged_ack_rejected_and_counted() {
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let chunk = Bytes::from(vec![0u8; 1000]);
        shared.record_send(1, &chunk).await.unwrap();
        // 伪造：offset 超过 next_send_offset
        let forged = mk_ack([1u8; 16], 1, Direction::ClientToProvider, 999_999);
        shared.handle_frame(&forged).await;
        assert_eq!(shared.journal_held_bytes(1).await, 1000, "伪造 ACK 不释放");
        assert_eq!(shared.ack_violations(), 1, "违例计数");
        // 合法 clamp：≤ next 才推进
        let legal = mk_ack([1u8; 16], 1, Direction::ClientToProvider, 1000);
        shared.handle_frame(&legal).await;
        assert_eq!(shared.journal_held_bytes(1).await, 0);
        assert_eq!(shared.ack_violations(), 1, "合法 ACK 不计数");
    }

    /// P0-1b：异 session_id 帧丢弃 + 计数，不污染会话。
    #[tokio::test]
    async fn stale_session_id_frames_counted_not_delivered() {
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        let out = shared
            .handle_frame(&data_frame([9u8; 16], 1, 0, b"evil"))
            .await;
        assert!(out.reply.is_none() && out.new_open.is_none(), "无副作用");
        assert_eq!(shared.stale_frames(), 1);
        assert_eq!(shared.deliver_queue_bytes(1).await, 0, "不交付");
        // 正确 session_id 正常处理
        shared
            .handle_frame(&data_frame([1u8; 16], 1, 0, b"good"))
            .await;
        assert_eq!(shared.stale_frames(), 1, "计数不误伤正常帧");
        assert_eq!(shared.deliver_queue_bytes(1).await, 4);
    }

    /// P1-5 / R5：新代首次成功交付后 previous 清除。
    #[tokio::test]
    async fn previous_token_cleared_after_first_delivery() {
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        shared.rotate_token(2, [3u8; 16]); // previous=(1,[2]) current=(2,[3])
        shared
            .handle_frame(&data_frame([1u8; 16], 1, 0, b"data"))
            .await;
        assert!(
            shared.try_rotate(1, &[2u8; 16], [4u8; 16], true).is_none(),
            "首次成功交付后 previous 凭据失效"
        );
        assert!(
            shared.try_rotate(2, &[3u8; 16], [5u8; 16], true).is_some(),
            "current 不受影响"
        );
    }

    /// P1-4：同幂等键双流 DATA 归并到 canonical 流交付。
    #[tokio::test]
    async fn open_alias_merges_duplicate_streams() {
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        let open = |stream: u64| Frame {
            frame_type: FrameType::Open,
            flags: frame::flags::START,
            session_id: [1u8; 16],
            stream_id: stream,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from_static(b"{\"requestId\":\"x\",\"idempotencyKey\":\"K\"}"),
        };
        let first = shared.handle_frame(&open(7)).await;
        assert_eq!(first.new_open, Some(7), "首个 OPEN 以帧内 id 为 canonical");
        let dup = shared.handle_frame(&open(21)).await;
        assert_eq!(dup.new_open, None, "重复 OPEN 幂等归并（不重复 dispatch）");
        // 别名流上的 DATA 归并到 canonical 7
        shared
            .handle_frame(&data_frame([1u8; 16], 21, 0, b"payload"))
            .await;
        assert_eq!(shared.deliver_queue_bytes(7).await, 7, "交付到 canonical");
        assert_eq!(shared.deliver_queue_bytes(21).await, 0, "别名无独立队列");
        assert_eq!(shared.recv(7).await.unwrap(), Bytes::from_static(b"payload"));
    }

    /// P1-4：try_mark_started CAS——并发双调恰一 true；Completed 终态不回退。
    #[tokio::test]
    async fn try_mark_started_exactly_one_winner() {
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        shared.on_open(1, "k").await;
        let (a, b) = tokio::join!(
            shared.try_mark_started(1),
            shared.try_mark_started(1)
        );
        assert_eq!(a as u8 + b as u8, 1, "并发双调恰一胜出: {a}/{b}");
        assert!(!shared.try_mark_started(1).await, "后续调用 false");
        // Completed 终态：迟到 started/completed 不回退
        shared.mark_completed(1).await;
        assert_eq!(shared.request_state(1).await, Some(RequestState::Completed));
        shared.mark_started(1).await;
        assert_eq!(
            shared.request_state(1).await,
            Some(RequestState::Completed),
            "迟到完成不回退"
        );
    }

    /// P0-2：registry 准入幂等 + peer/token 绑定闸门。
    #[tokio::test]
    async fn registry_admit_init_idempotent_and_gates() {
        let reg = SessionRegistry::new();
        let lim = JournalLimits::default();
        let s1 = match reg
            .admit_init([7u8; 16], [1u8; 16], "peer-a".into(), lim)
            .await
        {
            InitAdmission::Admitted(s) => s,
            _ => panic!("首登记必须准入"),
        };
        // 幂等：同 sid + 同 token + 同 peer → 同一会话（ghost 收敛）
        match reg
            .admit_init([7u8; 16], [1u8; 16], "peer-a".into(), lim)
            .await
        {
            InitAdmission::Admitted(s2) => assert!(Arc::ptr_eq(&s1, &s2), "幂等重发返回既有会话"),
            _ => panic!("幂等重发必须准入"),
        }
        // token 不符（伪造/竞态）
        assert!(matches!(
            reg.admit_init([7u8; 16], [2u8; 16], "peer-a".into(), lim)
                .await,
            InitAdmission::TokenMismatch
        ));
        // peer 不符
        assert!(matches!(
            reg.admit_init([7u8; 16], [1u8; 16], "peer-b".into(), lim)
                .await,
            InitAdmission::PeerMismatch
        ));
        // 轮换后旧 token 的 INIT 同样拒绝
        s1.rotate_token(2, [9u8; 16]);
        assert!(matches!(
            reg.admit_init([7u8; 16], [1u8; 16], "peer-a".into(), lim)
                .await,
            InitAdmission::TokenMismatch
        ));
    }

    #[tokio::test]
    async fn duplicate_and_overlap_semantics() {
        // 协议语义（网络无关）：重复帧不重复交付；overlap 不一致 → RESET。
        // ACK 值 = commit point（应用消费水位——P0-3）。
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
        let ack = shared
            .handle_frame(&f(0, b"AAAA"))
            .await
            .reply
            .expect("deliver→ack");
        assert_eq!(ack.frame_type, FrameType::Ack);
        assert_eq!(ack.byte_offset, 0, "未消费：ACK 停在 committed=0");
        // 精确重复：不重复交付（ACK 回发幂等，值=committed）
        let ack2 = shared
            .handle_frame(&f(0, b"AAAA"))
            .await
            .reply
            .expect("dup→ack");
        assert_eq!(ack2.frame_type, FrameType::Ack);
        assert_eq!(ack2.byte_offset, 0);
        // 交付恰好一份
        assert_eq!(shared.recv(1).await.unwrap(), Bytes::from_static(b"AAAA"));
        assert_eq!(shared.committed_offset(1).await, 4);
        // 消费后的重复帧：ACK 反映新 committed
        let ack3 = shared
            .handle_frame(&f(0, b"AAAA"))
            .await
            .reply
            .expect("dup→ack");
        assert_eq!(ack3.byte_offset, 4, "消费后 ACK 推进到 committed");
        // overlap 内容不一致 → RESET
        let rst = shared
            .handle_frame(&f(0, b"XXXX"))
            .await
            .reply
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
