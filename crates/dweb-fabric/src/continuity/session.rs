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
//! - **双端并发 INIT deterministic winner**（R3-3c，**已实现**——R2 的
//!   「不适用」裁定被 Codex 驳回，design §2.3.0 明文要求）：本端对同 peer
//!   的发起中 session 登记（`FabricInner::continuity_campaigns`）；INIT 交叉
//!   时接收侧按 `(EndpointId, sessionId)` 全序取较小者为 canonical——胜者
//!   REJECT(ALREADY_ACTIVE + canonical 三元组)，败者撤回发起并从本地注册表
//!   采纳 canonical 会话（`adopt_session`），双端独立收敛到同一 session，
//!   不产生双会话并存。
//! - **恢复单胜 + nonce 幂等**（R3-1，取代 R2 的 phase 闸门——Codex 不接受
//!   锁外 phase 判定）：恢复裁决/轮换/phase/epoch/通道 owner 全部内聚在
//!   `resume_control` 单把 std::sync::Mutex（`ResumeCtl`）。client 每个
//!   resume campaign 生成一个 nonce（重试复用）；provider 侧 RESUME 的
//!   nonce+凭据命中 `pending`（轮换已发生、新通道未确认）→ 重发缓存的
//!   同 (generation, token) RESUME_OK（不二次轮换）；异 nonce 或凭据不符
//!   → 按当前窗口裁决（current/previous 均须精确匹配）；pending 在新代
//!   首次成功 Deliver / 合法 ACK 推进时清除。
//! - **epoch/owner fencing**（R3-2）：`SessionChannel` 携带 (epoch, owner)
//!   ——pump 收帧后先 fence（与 ResumeCtl 快照比对），旧通道帧丢弃计数、
//!   不进 journal 不回 ACK；旧通道退出不把新代拉回 Recovering；通道安装
//!   只经 `ResumeCtl`（owner 单调，弱引用随 owner 比较）。
//! - **入站资源门**（R3-4）：入站 OPEN 原子预占 128 名额（超限计数丢弃）；
//!   未见过流的 DATA/ACK/FIN/RESET 违规计数丢弃（不 or_insert）；已终结流
//!   幂等丢弃（§2.7 规则 4）；direction/奇偶校验（§2.2）；journal 段数上限
//!   接线（session 4096 / 单流 512，design §2.6 表值）。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use bytes::Bytes;

use crate::fabric::{Fabric, FabricError};
use crate::identity::endpoint_id_parse;
use crate::session::SessionError;

use super::frame::{self, Direction, Frame, FrameType};
use super::model::{JournalError, JournalLimits, RecvWindow, SegmentAction, StreamJournal};
use super::state::ConnectionPhase;
use super::transport::{TransportError, TransportRecv, TransportSend};

pub const PROTOCOL_VERSION: u8 = 1;
/// gap buffer 容量（§2.7 有界）。
pub const GAP_CAP: usize = 64;
/// gap buffer 字节上限（单流）。段数上限不能单独 bound memory，因为每段
/// 可以接近 MAX_FRAME。
pub const GAP_BYTE_CAP: usize = 2 * 1024 * 1024;
/// gap buffer 字节上限（整个 session）。单流上限不能阻止多个 stream
/// 各自持有大 gap；超限 DATA 按协议违例终结该流，不把数据抛给上层。
pub const GAP_SESSION_BYTE_CAP: usize = 8 * 1024 * 1024;
/// 重放每流每轮段数上限（§5：防单流垄断恢复通道）。
const REPLAY_PER_ROUND: usize = 4;
/// 交付队列软上限（P0-3 记账面）：超过即「慢消费者」状态。硬上界由发送侧
/// journal 上限闭合——未消费 ⟹ 未 ACK ⟹ 仍在发送方 journal（2MiB/流、
/// 8MiB/会话），接收队列因此天然有界，无需丢帧。
pub const DELIVER_QUEUE_CAP: usize = 256 * 1024;
/// 交付队列硬上限（单流/会话）。超限按协议违例处置并丢弃数据，绝不把
/// 恶意 DATA 继续向上层排队造成 OOM；`DELIVER_QUEUE_CAP` 仍是软观测阈值。
pub const DELIVER_QUEUE_STREAM_CAP: usize = 2 * 1024 * 1024;
pub const DELIVER_QUEUE_SESSION_CAP: usize = 8 * 1024 * 1024;
/// 活跃逻辑流上限（design §2.6：超限拒绝 OPEN）。
pub const MAX_ACTIVE_STREAMS: usize = 128;

/// 单帧发送的取消/超时预算。transition 请求 stop 时会先取消发送；超时
/// 是 QUIC 实现不及时响应取消的最终有界兜底。
const SEND_FRAME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const STOP_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

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

/// SESSION_INIT_REJECT reason（design §2.3.0 冻结表——与 RESUME 表是
/// **不同帧类型的独立命名空间**，数值不可混读：INIT 0x02 = MALFORMED，
/// RESUME 0x02 = TOKEN_INVALID）。
pub mod init_reason {
    /// 已有 canonical 会话（并发双 INIT 收敛用）。
    pub const ALREADY_ACTIVE: u8 = 0x01;
    /// 载荷/头校验失败（长度异常、header≠payload sid、零 sid/token）。
    pub const MALFORMED: u8 = 0x02;
    /// 策略拒绝（peer 绑定不符）。
    pub const POLICY_DENIED: u8 = 0x03;
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
    /// - 匹配 previous → 轮换。
    /// - 其它 → None（TOKEN_INVALID）。
    fn try_rotate(
        &mut self,
        generation: u64,
        token: &[u8; 16],
        new_token: [u8; 16],
    ) -> Option<(u64, [u8; 16])> {
        let current_match = self.current.0 == generation && &self.current.1 == token;
        let previous_match =
            matches!(&self.previous, Some((g, t)) if *g == generation && t == token);
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

    fn generation_for_token(&self, token: &[u8; 16]) -> Option<u64> {
        if &self.current.1 == token {
            return Some(self.current.0);
        }
        self.previous
            .as_ref()
            .and_then(|(generation, candidate)| (candidate == token).then_some(*generation))
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
        self.remote_final.is_some() && self.final_sent.is_some() && self.journal.held_bytes() == 0
    }
}

/// 单流交付队列（frames + 字节记账——P0-3 慢消费者观测面）。
#[derive(Default)]
struct DeliverQueue {
    frames: VecDeque<Bytes>,
    bytes: usize,
}

/// 恢复裁决值。它是 install CAS 的不可变身份：仅凭 generation/token 不足以
/// 证明这是当前 decision，因为另一个 nonce 可能已经用 previous 串行胜出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResumeDecision {
    nonce: [u8; 16],
    from_generation: u64,
    from_token: [u8; 16],
    result_generation: u64,
    result_token: [u8; 16],
    /// ResumeCtl 内单调 lease；不同 nonce 的 previous winner 会 supersede
    /// 旧 lease，旧 transport 只能半关。
    lease_id: u64,
    remote_epoch: u64,
    cached: bool,
}

/// 恢复裁决的幂等缓存（R3-1）：胜出 attempt 呈交的 (nonce, 前代凭据) 与
/// 轮换结果的绑定——同 campaign 重试（OK 丢失）重发缓存结果，不二次轮换。
struct PendingResume {
    decision: ResumeDecision,
    /// 成功安装后绑定的 channel owner。安装前为 None，旧 owner 不能在
    /// supersede 期间提前清理 previous/pending。
    installed_owner: Option<u64>,
}

fn decision_matches_pending(pending: &ResumeDecision, decision: &ResumeDecision) -> bool {
    pending.lease_id == decision.lease_id
        && pending.nonce == decision.nonce
        && pending.from_generation == decision.from_generation
        && pending.from_token == decision.from_token
        && pending.result_generation == decision.result_generation
        && pending.result_token == decision.result_token
        && pending.remote_epoch == decision.remote_epoch
}

/// 恢复控制（R3-1：**单锁内聚**）——恢复裁决（token 窗口）、phase 迁移、
/// 当前胜者通道 (epoch, owner)、pending 幂等缓存全部在这一个临界区内完成，
/// 不存在跨锁可观测中间态。std::sync::Mutex：所有方法同步短临界区、
/// 永不跨 await 持有。
struct ResumeCtl {
    tokens: TokenWindow,
    phase: SessionPhase,
    /// 当前胜者通道的 transport epoch（fence 快照面，R3-2）。
    active_epoch: u64,
    /// 当前胜者通道 owner id（单调递增；同 epoch 双通道由它区分）。
    channel_owner: u64,
    /// 当前胜者通道（owner, Weak——生命周期由强引用者持有，无环）。
    channel: Option<(u64, std::sync::Weak<SessionChannel>)>,
    pending: Option<PendingResume>,
    /// current/previous 窗口是否仍可用于恢复。与 `tokens.clear_previous`
    /// 在同一把 ResumeCtl 锁内切换，避免确认与下一次 RESUME 交错。
    previous_live: bool,
    /// 远端在 RESUME_INIT 中声明的 local_connection_epoch，严格单调。
    last_seen_remote_epoch: u64,
    /// decision lease 分配器。
    next_lease: u64,
    /// token 轮换后等待新 owner 首次确认的 owner。
    confirmation_owner: Option<u64>,
}

/// barrier 测试钩子（R3-1，Codex 步骤 6）：`accept_resume` 在**轮换完成、
/// Active 置位之前**受控暂停——测试在该窗口注入第二/第三个 RESUME 验证
/// 单胜与幂等。生产恒零开销（enabled=false 时 wait 立即返回）。
#[doc(hidden)]
pub struct ResumeGate {
    enabled: std::sync::atomic::AtomicBool,
    /// 0 = idle / 1 = reached（轮换已完成，暂停中）/ 2 = released。
    state: tokio::sync::watch::Sender<u8>,
}

impl ResumeGate {
    fn new() -> Self {
        let (tx, _rx) = tokio::sync::watch::channel(0u8);
        Self {
            enabled: std::sync::atomic::AtomicBool::new(false),
            state: tx,
        }
    }

    /// 启用并订阅状态（测试面：先订阅再注入，防错过 reached 边沿）。
    pub fn enable(&self) -> tokio::sync::watch::Receiver<u8> {
        self.enabled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.state.subscribe()
    }

    /// 释放暂停（测试面）。
    pub fn release(&self) {
        self.state.send_modify(|v| *v = 2);
    }

    /// 轮换后暂停点：reached 置位 → 等 release（有界 30s 防悬挂）。
    pub(crate) async fn wait(&self) {
        if !self.enabled.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        self.state.send_modify(|v| *v = 1);
        let mut rx = self.state.subscribe();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                if *rx.borrow() >= 2 {
                    return;
                }
                if rx.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;
    }
}

/// 通道安装策略（R3-2d：安装只经 ResumeCtl）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallPolicy {
    /// 强制接管：新代通道无条件成为胜者（owner 单调递增；旧通道被 fence）。
    /// 用于**新**握手（fresh INIT / fresh RESUME 轮换）与 client 恢复换通道。
    Force,
    /// 仅在无存活通道时装入：用于**重复**握手的传输接管（幂等 INIT 重发 /
    /// RESUME 幂等缓存重发）——既有通道存活则拒绝（半关本传输），防止
    /// 双通道并存；既有通道已死则本传输接管。
    IfVacant,
}

/// 双端共享的会话核心：provider 侧常驻注册表跨连接存活（进程重启即丢——
/// RESUME 统一 REQUEST_STATE_LOST）；client 侧由 Session 句柄持有。
pub struct SessionShared {
    pub session_id: [u8; 16],
    pub peer_id: String,
    is_client: bool,
    /// 恢复控制单锁（R3-1：token 窗口 + phase + 通道 owner/epoch + pending）。
    resume_control: std::sync::Mutex<ResumeCtl>,
    /// 收帧处理 lease 与通道 transition 互斥：读 lease 覆盖 fence 检查和
    /// `handle_frame` 提交，写 transition 先停止旧泵并等待所有 lease 排空。
    frame_gate: tokio::sync::RwLock<()>,
    channel_transition: tokio::sync::Mutex<()>,
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
    /// 异 session_id 帧计数（P0-1：旧代/串线帧不污染会话）+ 旧通道 fence
    /// 计数（R3-2：epoch/owner 不符的迟到帧）。
    stale_frame_count: std::sync::atomic::AtomicU64,
    /// 伪造 ACK（offset 超发）违例计数（P0-3）。
    ack_violation_count: std::sync::atomic::AtomicU64,
    /// 入站协议违例计数（R3-4：未见过流的帧 / direction·奇偶违例 /
    /// OPEN 名额超限 / 终结流后越界帧）。
    protocol_violation_count: std::sync::atomic::AtomicU64,
    /// client resume single-flight（P0-1：并发 resume 恰一执行者）。
    resume_in_flight: std::sync::atomic::AtomicBool,
    /// barrier 测试钩子（R3-1；生产零开销）。
    #[doc(hidden)]
    pub resume_gate: ResumeGate,
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
            resume_control: std::sync::Mutex::new(ResumeCtl {
                tokens: TokenWindow::new(token),
                phase: SessionPhase::Negotiating,
                active_epoch: 0,
                channel_owner: 0,
                channel: None,
                pending: None,
                previous_live: false,
                last_seen_remote_epoch: 0,
                next_lease: 0,
                confirmation_owner: None,
            }),
            frame_gate: tokio::sync::RwLock::new(()),
            channel_transition: tokio::sync::Mutex::new(()),
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
            protocol_violation_count: std::sync::atomic::AtomicU64::new(0),
            resume_in_flight: std::sync::atomic::AtomicBool::new(false),
            resume_gate: ResumeGate::new(),
            limits,
        })
    }

    /// 当前代通道（经 ResumeCtl 解析——owner 单调，恢复轮换后指向新代；
    /// provider 侧跨 Session 实例存活）。
    pub fn current_channel(&self) -> Option<Arc<SessionChannel>> {
        self.resume_control
            .lock()
            .unwrap()
            .channel
            .as_ref()
            .and_then(|(_, w)| w.upgrade())
    }

    /// fence 快照（R3-2）：通道是否仍是当前胜者（epoch+owner 双匹配）。
    pub(crate) fn channel_is_current(&self, epoch: u64, owner: u64) -> bool {
        let ctl = self.resume_control.lock().unwrap();
        ctl.active_epoch == epoch && ctl.channel_owner == owner
    }

    /// 通道安装（R3-2d/P0 transition）：所有切换先串行化，停止旧泵并等待
    /// 其 frame-handler read lease 排空，再在 ResumeCtl 内提交新的 owner/epoch。
    /// 这样旧帧不可能在 fence 检查后、owner 替换后继续提交。
    async fn install_channel(
        self: &Arc<Self>,
        mut send: TransportSend,
        recv: TransportRecv,
        policy: InstallPolicy,
        decision: Option<ResumeDecision>,
        expected_generation: Option<u64>,
    ) -> Option<Arc<SessionChannel>> {
        let _transition = self.channel_transition.lock().await;

        // Validate the immutable decision before touching the current channel.
        // A superseded RESUME can arrive after its OK was sent but before its
        // transport is installed; it must only close its own candidate stream,
        // never stop the newer owner that won while this task was suspended.
        if let Some(decision) = decision {
            let valid = self
                .resume_control
                .lock()
                .unwrap()
                .pending
                .as_ref()
                .is_some_and(|pending| {
                    decision_matches_pending(&pending.decision, &decision)
                        && (decision.cached || pending.installed_owner.is_none())
                });
            if !valid {
                let _ = send.finish();
                return None;
            }
        }
        if let Some(expected) = expected_generation {
            if self.current_generation() != expected {
                let _ = send.finish();
                return None;
            }
        }

        let old = self.current_channel();
        if policy == InstallPolicy::IfVacant {
            if let Some(chan) = old.as_ref() {
                if !chan.is_dead() {
                    // Duplicate INIT/RESUME transport is acknowledged by the
                    // caller, then half-closed without changing ownership.
                    // A stopping pump still owns the transition until it has
                    // actually exited, so it is not vacant yet.
                    let _ = send.finish();
                    return None;
                }
            }
        }
        if let Some(chan) = old {
            chan.request_stop();
            if tokio::time::timeout(STOP_WAIT_TIMEOUT, chan.wait_stopped())
                .await
                .is_err()
            {
                // A transport implementation which ignores cancellation must
                // not hold recovery forever. The candidate is closed and no
                // ownership is committed.
                let _ = send.finish();
                return None;
            }
        }
        // The pump normally drains before this point. The write guard is the
        // final lease barrier for a handler that was between fence and commit.
        let _frame_barrier = self.frame_gate.write().await;
        let epoch = send.epoch;
        let mut ctl = self.resume_control.lock().unwrap();
        if let Some(expected) = expected_generation {
            if ctl.tokens.current_generation() != expected {
                let _ = send.finish();
                return None;
            }
        }
        if let Some(decision) = decision {
            let valid = ctl.pending.as_ref().is_some_and(|pending| {
                decision_matches_pending(&pending.decision, &decision)
                    && (decision.cached || pending.installed_owner.is_none())
            });
            if !valid {
                // The decision was superseded (usually by a different nonce
                // using previous) or was already installed. Never let a stale
                // Force path overwrite the newer owner.
                let _ = send.finish();
                return None;
            }
        }
        let owner = ctl.channel_owner + 1;
        ctl.channel_owner = owner;
        ctl.active_epoch = epoch;
        let chan = Arc::new(SessionChannel {
            shared: Arc::clone(self),
            send: tokio::sync::Mutex::new(send),
            recv: tokio::sync::Mutex::new(recv),
            arrivals: tokio::sync::Mutex::new(std::collections::VecDeque::new()),
            arrivals_notify: tokio::sync::Notify::new(),
            dead: std::sync::atomic::AtomicBool::new(false),
            stopping: std::sync::atomic::AtomicBool::new(false),
            stop_notify: tokio::sync::Notify::new(),
            stopped_notify: tokio::sync::Notify::new(),
            epoch,
            owner,
        });
        if ctl.channel.as_ref().is_none_or(|(o, _)| owner > *o) {
            ctl.channel = Some((owner, Arc::downgrade(&chan)));
        }
        if let Some(decision) = decision {
            if let Some(pending) = ctl.pending.as_mut() {
                debug_assert_eq!(pending.decision.lease_id, decision.lease_id);
                pending.installed_owner = Some(owner);
            }
        }
        if ctl.previous_live {
            ctl.confirmation_owner = Some(owner);
        }
        Some(chan)
    }

    /// client 侧收到 RESUME_OK 的轮换（R5：旧 current 降 previous）。
    fn rotate_token(&self, new_generation: u64, new_token: [u8; 16]) {
        let mut ctl = self.resume_control.lock().unwrap();
        if ctl.tokens.current() == (new_generation, new_token) {
            return;
        }
        // A late RESUME_OK must never move credentials backwards. The caller
        // treats this as a stale response and will not install its transport.
        if new_generation <= ctl.tokens.current_generation() {
            return;
        }
        ctl.tokens.rotate(new_generation, new_token);
        ctl.previous_live = true;
        ctl.confirmation_owner = None;
    }

    fn current_token(&self) -> (u64, [u8; 16]) {
        self.resume_control.lock().unwrap().tokens.current()
    }

    /// 当前代 generation（迟到响应竞态判定用）。
    fn current_generation(&self) -> u64 {
        self.resume_control
            .lock()
            .unwrap()
            .tokens
            .current_generation()
    }

    fn last_seen_remote_epoch(&self) -> u64 {
        self.resume_control.lock().unwrap().last_seen_remote_epoch
    }

    /// Record the epoch carried by SESSION_INIT. Equal epochs are idempotent;
    /// a lower one is stale and must not replace a newer peer connection.
    fn observe_remote_epoch(&self, epoch: u64) -> bool {
        if epoch == 0 {
            return false;
        }
        let mut ctl = self.resume_control.lock().unwrap();
        if epoch < ctl.last_seen_remote_epoch {
            return false;
        }
        ctl.last_seen_remote_epoch = epoch;
        true
    }

    /// RESUME 原子裁决（R3-1：裁决+轮换+pending 记账在同一 ResumeCtl
    /// 临界区）：
    /// - nonce+凭据命中 pending（轮换已发生、新通道未确认——OK-lost 重试
    ///   窗口）→ 重发缓存结果（同 generation/token，不二次轮换）。
    /// - 否则按当前窗口裁决：current 或 previous 均可精确匹配；只有同一
    ///   nonce+来源凭据才是缓存重发。不同 campaign 即使使用 previous，也
    ///   是新的串行 winner，由 transition/owner lease 收口。
    /// 返回一个绑定 nonce/generation/epoch 的 decision。`decide_resume` 保留
    /// 无 epoch 的单测便利面；生产入口使用 `decide_resume_with_epoch`。
    #[cfg(test)]
    fn decide_resume(
        &self,
        nonce: [u8; 16],
        generation: u64,
        token: &[u8; 16],
        new_token: [u8; 16],
    ) -> Option<ResumeDecision> {
        self.decide_resume_with_epoch(nonce, generation, token, new_token, 0)
    }

    fn decide_resume_with_epoch(
        &self,
        nonce: [u8; 16],
        generation: u64,
        token: &[u8; 16],
        new_token: [u8; 16],
        remote_epoch: u64,
    ) -> Option<ResumeDecision> {
        let mut ctl = self.resume_control.lock().unwrap();
        // The frozen RESUME_INIT wire carries connection epochs, not a second
        // token-generation field. Resolve the generation from the exact token
        // in the two-generation window; the epoch-less unit-test facade keeps
        // accepting its explicit generation hint.
        let effective_generation = if remote_epoch != 0 {
            ctl.tokens.generation_for_token(token)?
        } else {
            generation
        };
        if let Some(p) = &ctl.pending {
            if p.decision.nonce == nonce
                && p.decision.from_generation == effective_generation
                && &p.decision.from_token == token
                && (remote_epoch == 0 || p.decision.remote_epoch == remote_epoch)
            {
                let mut cached = p.decision;
                cached.cached = true;
                return Some(cached);
            }
        }
        if remote_epoch != 0 {
            if remote_epoch < ctl.last_seen_remote_epoch {
                return None;
            }
        }
        let Some((g, t)) = ctl
            .tokens
            .try_rotate(effective_generation, token, new_token)
        else {
            return None;
        };
        ctl.next_lease = ctl.next_lease.saturating_add(1);
        let decision = ResumeDecision {
            nonce,
            from_generation: effective_generation,
            from_token: *token,
            result_generation: g,
            result_token: t,
            lease_id: ctl.next_lease,
            remote_epoch,
            cached: false,
        };
        ctl.pending = Some(PendingResume {
            decision,
            installed_owner: None,
        });
        if remote_epoch != 0 {
            ctl.last_seen_remote_epoch = remote_epoch;
        }
        ctl.previous_live = true;
        ctl.confirmation_owner = None;
        Some(decision)
    }

    fn resume_epoch_is_stale(
        &self,
        nonce: [u8; 16],
        generation: u64,
        token: &[u8; 16],
        remote_epoch: u64,
    ) -> bool {
        let ctl = self.resume_control.lock().unwrap();
        let effective_generation = if remote_epoch != 0 {
            ctl.tokens.generation_for_token(token).unwrap_or(generation)
        } else {
            generation
        };
        if let Some(pending) = &ctl.pending {
            if pending.decision.nonce == nonce
                && pending.decision.from_generation == effective_generation
                && &pending.decision.from_token == token
                && (remote_epoch == 0 || pending.decision.remote_epoch == remote_epoch)
            {
                return false;
            }
        }
        remote_epoch != 0 && remote_epoch < ctl.last_seen_remote_epoch
    }

    /// SESSION_INIT 幂等裁决用：INIT token 与登记代是否一致。
    fn init_token_is(&self, token: &[u8; 16]) -> bool {
        self.resume_control
            .lock()
            .unwrap()
            .tokens
            .current_token_is(token)
    }

    /// 新代确认（R3-1c / P1-5 / design §2.3.0 R5）：新代首次成功 Deliver 或
    /// 合法 ACK 推进 → pending 幂等缓存与 previous 代在 ResumeCtl 同一临界区
    /// 内清除（R2 的 clear_previous 与 rotate 交错竞态由此闭合）。
    fn note_confirmed(&self, owner: Option<u64>) {
        let mut ctl = self.resume_control.lock().unwrap();
        let owner_matches = owner.is_some_and(|owner| {
            ctl.channel_owner == owner && ctl.confirmation_owner == Some(owner)
        });
        // The owner-less path is retained only for the in-module model tests;
        // every production pump supplies its channel owner. This keeps the
        // old pure-state tests useful without reopening the old-pump race.
        if ctl.previous_live && (owner_matches || owner.is_none()) {
            ctl.pending = None;
            ctl.tokens.clear_previous();
            ctl.previous_live = false;
            ctl.confirmation_owner = None;
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

    /// 观测面：入站协议违例计数（R3-4：未见流帧/direction/奇偶/名额/越界）。
    pub fn protocol_violations(&self) -> u64 {
        self.protocol_violation_count
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

    /// 测试观测面：当前胜者通道 owner（barrier 测试断言 channel_owner 唯一）。
    #[doc(hidden)]
    pub fn debug_channel_owner(&self) -> u64 {
        self.resume_control.lock().unwrap().channel_owner
    }

    /// 测试观测面：当前胜者通道 transport epoch（fence 测试）。
    #[doc(hidden)]
    pub fn debug_active_epoch(&self) -> u64 {
        self.resume_control.lock().unwrap().active_epoch
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

    /// phase 读取（ResumeCtl 内聚——R3-1；异步签名保持既有调用面）。
    pub async fn phase(&self) -> SessionPhase {
        self.phase_sync()
    }

    fn phase_sync(&self) -> SessionPhase {
        self.resume_control.lock().unwrap().phase
    }

    async fn set_phase(&self, p: SessionPhase) {
        self.set_phase_sync(p);
    }

    fn set_phase_sync(&self, p: SessionPhase) {
        self.resume_control.lock().unwrap().phase = p;
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
    /// P0-3：先聚合**全部流** held_bytes 做 session 级字节上限检查
    /// （`max_session_bytes`），再走单流 journal 检查。
    /// R3-4d：session 级段数上限（4096——聚合全部流段计数；design §2.6 表）。
    pub(crate) async fn record_send(
        &self,
        stream_id: u64,
        payload: &Bytes,
    ) -> Result<u64, FabricError> {
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
        // R3-4d：session 级段数（保守口径：按 BTreeMap 原生段计数，不做
        // 相邻段合并——合并后计数只会更小，原生计数是上限的保守界）。
        let session_segments: usize = streams.values().map(|c| c.journal.segments_len()).sum();
        if session_segments >= self.limits.max_session_segments {
            return Err(FabricError::Session(SessionError::Connect(format!(
                "journal session segment cap exceeded: {session_segments} >= {}",
                self.limits.max_session_segments
            ))));
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
        let active = streams.values().filter(|c| !c.quota_reapable()).count();
        if active >= MAX_ACTIVE_STREAMS {
            return Err(FabricError::Session(SessionError::Connect(format!(
                "active stream cap exceeded: {active} >= {MAX_ACTIVE_STREAMS}"
            ))));
        }
        streams
            .entry(stream_id)
            .or_insert_with(|| StreamCtx::new(stream_id, self.limits));
        Ok(())
    }

    /// 处理一帧（收侧核心：去重/交付/ACK 生成/journal 释放）。
    /// P0-1：首行校验 session_id——异会话帧（旧代/串线）丢弃并计数，不污染。
    /// P1-4：stream_id 先经 alias 映射到 canonical 再处理。
    /// R3-4：入站资源门——direction/奇偶校验（§2.2）、未见流帧丢弃、
    /// OPEN 原子预占 128 名额、终结流幂等丢弃（§2.7 规则 4）。
    async fn handle_frame(&self, f: &Frame) -> FrameOutcome {
        self.handle_frame_with_owner(f, None).await
    }

    async fn handle_frame_with_owner(&self, f: &Frame, owner: Option<u64>) -> FrameOutcome {
        if f.session_id != self.session_id {
            self.stale_frame_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return FrameOutcome {
                reply: None,
                new_open: None,
            };
        }
        // R3-4c direction 闸门（§2.2）：对端发来的数据面帧（OPEN/DATA/FIN/
        // RESET）direction 必须是对端的发送方向；ACK 的 direction 是被确认
        // 方向 = 本端发送方向。违例计数丢弃。
        match f.frame_type {
            FrameType::Data | FrameType::Open | FrameType::Fin | FrameType::Reset => {
                if f.direction != self.recv_direction() {
                    self.count_violation();
                    return FrameOutcome::drop();
                }
            }
            FrameType::Ack => {
                if f.direction != self.send_direction() {
                    self.count_violation();
                    return FrameOutcome::drop();
                }
            }
            _ => {}
        }
        // R3-4c 奇偶闸门（§2.2）：OPEN 的 stream_id 奇偶必须与发起方一致
        // （client 奇 / provider 偶）。非 OPEN 帧不在此校验——响应帧合法地
        // 出现在对端发起的流上，其合法性由「流必须先 OPEN（未见流丢弃）」
        // 与 direction 闸门共同闭合。
        if f.frame_type == FrameType::Open {
            let stream_is_odd = f.stream_id % 2 == 1;
            let peer_initiates_odd = !self.is_client;
            if stream_is_odd != peer_initiates_odd {
                self.count_violation();
                return FrameOutcome::drop();
            }
        }
        match f.frame_type {
            FrameType::Data => {
                let sid = self.resolve_stream(f.stream_id).await;
                let mut streams = self.streams.lock().await;
                let session_gap_bytes = streams.values().fold(0usize, |total, ctx| {
                    total.saturating_add(ctx.recv.gap_bytes())
                });
                // R3-4b：未见过的流（无 OPEN 预占/非本端发送流）不 or_insert
                // ——违规计数丢弃，恶意/失常对端无法凭 DATA 无限造流。
                let Some(ctx) = streams.get_mut(&sid) else {
                    drop(streams);
                    self.count_violation();
                    return FrameOutcome::drop();
                };
                // §2.7 规则 4 语义：已终结流的越界 DATA（超出已宣告 final
                // offset）违规丢弃；final 内的重复段走下方正常去重幂等。
                let Some(frame_end) = f.byte_offset.checked_add(f.payload.len() as u64) else {
                    drop(streams);
                    self.count_violation();
                    return FrameOutcome {
                        reply: Some(mk_reset(self.session_id, sid, self.send_direction())),
                        new_open: None,
                    };
                };
                if let Some(final_off) = ctx.remote_final {
                    if frame_end > final_off {
                        drop(streams);
                        self.count_violation();
                        return FrameOutcome::drop();
                    }
                }
                let incoming_gap_bytes = ctx.recv.incoming_gap_bytes(f.byte_offset, &f.payload);
                if session_gap_bytes.saturating_add(incoming_gap_bytes) > GAP_SESSION_BYTE_CAP {
                    // Session-level gap memory is a hard protocol boundary. The
                    // frame is rejected before RecvWindow insertion; terminate
                    // this logical stream and never surface attacker-controlled
                    // bytes to an unbounded application queue.
                    ctx.remote_final = Some(ctx.recv.expected_offset());
                    drop(streams);
                    self.count_violation();
                    return FrameOutcome {
                        reply: Some(mk_reset(self.session_id, sid, self.send_direction())),
                        new_open: None,
                    };
                }
                let action = ctx.recv.feed_with_limits(
                    f.byte_offset,
                    f.payload.clone(),
                    GAP_CAP,
                    GAP_BYTE_CAP,
                );
                match action {
                    Ok(SegmentAction::Deliver(payload)) => {
                        // P0-3 commit point：ACK 只携带应用消费水位
                        // （committed_offset——DATA 入队不推进）
                        let ack = mk_ack(self.session_id, sid, f.direction, ctx.committed_offset);
                        if ctx.committed_offset > ctx.last_acked_offset {
                            ctx.last_acked_offset = ctx.committed_offset;
                        }
                        drop(streams);
                        let queued_len = payload.len();
                        let mut q = self.delivered.lock().await;
                        let session_bytes: usize = q.values().map(|queue| queue.bytes).sum();
                        let stream_bytes = q.get(&sid).map(|queue| queue.bytes).unwrap_or(0);
                        if stream_bytes.saturating_add(queued_len) > DELIVER_QUEUE_STREAM_CAP
                            || session_bytes.saturating_add(queued_len) > DELIVER_QUEUE_SESSION_CAP
                        {
                            drop(q);
                            // DATA has already crossed the receive window, so
                            // terminate this logical stream and count a
                            // protocol violation. The payload is intentionally
                            // dropped: bounded memory is preferable to
                            // surfacing an OOM-prone unbounded queue.
                            let mut streams = self.streams.lock().await;
                            if let Some(ctx) = streams.get_mut(&sid) {
                                ctx.remote_final = Some(ctx.recv.expected_offset());
                            }
                            drop(streams);
                            self.count_violation();
                            return FrameOutcome {
                                reply: Some(mk_reset(self.session_id, sid, self.send_direction())),
                                new_open: None,
                            };
                        }
                        let dq = q.entry(sid).or_default();
                        dq.frames.push_back(payload);
                        dq.bytes += queued_len;
                        drop(q);
                        self.delivered_notify.notify_waiters();
                        // 新代首次成功交付 → pending/previous 失效（R3-1c）
                        self.note_confirmed(owner);
                        FrameOutcome {
                            reply: Some(ack),
                            new_open: None,
                        }
                    }
                    Ok(SegmentAction::Duplicate) => {
                        // 幂等丢弃；仍回 ACK（对端可能未收到上次 ACK）——值恒为
                        // committed（消费水位）
                        let ack = mk_ack(self.session_id, sid, f.direction, ctx.committed_offset);
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
                        let reset = mk_reset(self.session_id, sid, self.send_direction());
                        FrameOutcome {
                            reply: Some(reset),
                            new_open: None,
                        }
                    }
                }
            }
            FrameType::Ack => {
                // ACK.direction = 被确认数据的方向；匹配本端发送方向才推进
                //（direction 闸门前置已保证；此处推进 journal）
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
                        // 新代首次合法 ACK → pending/previous 失效（R3-1c）
                        self.note_confirmed(owner);
                    }
                } else {
                    // R3-4b：未见过的流的 ACK——违规计数丢弃
                    drop(streams);
                    self.count_violation();
                }
                FrameOutcome {
                    reply: None,
                    new_open: None,
                }
            }
            FrameType::Fin => {
                let sid = self.resolve_stream(f.stream_id).await;
                let mut streams = self.streams.lock().await;
                // R3-4b：未见过的流不 or_insert——违规计数丢弃
                let Some(ctx) = streams.get_mut(&sid) else {
                    drop(streams);
                    self.count_violation();
                    return FrameOutcome::drop();
                };
                let Some(incoming_final) = f.byte_offset.checked_add(f.payload.len() as u64) else {
                    drop(streams);
                    self.count_violation();
                    return FrameOutcome {
                        reply: Some(mk_reset(self.session_id, sid, self.send_direction())),
                        new_open: None,
                    };
                };
                // §2.7 规则 4：已终结流——相同 terminal 幂等丢弃；不同
                // final offset 视为协议错误（计数丢弃）
                if let Some(existing) = ctx.remote_final {
                    if existing != incoming_final {
                        drop(streams);
                        self.count_violation();
                        return FrameOutcome::drop();
                    }
                    return FrameOutcome::drop();
                }
                ctx.remote_final = Some(incoming_final);
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
                    // R3-4a：入站 OPEN 原子预占 128 名额（design §2.6「超限
                    // 拒绝 OPEN」——RESET 无 reason 载荷面，走计数拒绝路径，
                    // 注释说明；对端经超时暴露）。超限回滚幂等登记防幻影。
                    if self.reserve_stream_slot(canonical).await.is_err() {
                        self.rollback_open(canonical, &idem).await;
                        self.count_violation();
                        return FrameOutcome::drop();
                    }
                    self.open_metas
                        .lock()
                        .await
                        .insert(canonical, f.payload.clone());
                    FrameOutcome {
                        reply: None,
                        new_open: Some(canonical),
                    }
                } else if canonical != f.stream_id {
                    // P1-4：同幂等键不同 stream_id → 建立 canonical 别名
                    self.aliases.lock().await.insert(f.stream_id, canonical);
                    FrameOutcome {
                        reply: None,
                        new_open: None,
                    }
                } else {
                    FrameOutcome {
                        reply: None,
                        new_open: None,
                    }
                }
            }
            FrameType::Reset => {
                let sid = self.resolve_stream(f.stream_id).await;
                let mut streams = self.streams.lock().await;
                if let Some(ctx) = streams.get_mut(&sid) {
                    ctx.remote_final = Some(ctx.recv.expected_offset());
                    drop(streams);
                    self.delivered_notify.notify_waiters();
                } else {
                    // R3-4b：未见过的流——违规计数丢弃
                    drop(streams);
                    self.count_violation();
                }
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

    fn count_violation(&self) {
        self.protocol_violation_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// OPEN 名额超限的幂等登记回滚（R3-4a）：撤销 on_open 的全部记账，
    /// 使同幂等键的合法重试不被幻影登记吞掉。
    async fn rollback_open(&self, stream_id: u64, idem_key: &str) {
        self.idem_index.lock().await.remove(idem_key);
        self.requests.lock().await.remove(&stream_id);
        self.stream_keys.lock().await.remove(&stream_id);
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
                // Reuse the normal forged-ACK upper-bound rule for recovery
                // summaries. A peer cannot release journal bytes by claiming
                // an offset beyond what this side actually sent.
                if s.recv_ack > ctx.journal.next_offset() {
                    self.ack_violation_count
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                } else {
                    ctx.journal.advance_ack(s.recv_ack);
                }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

impl FrameOutcome {
    fn drop() -> Self {
        Self {
            reply: None,
            new_open: None,
        }
    }
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

fn mk_reset(sid: [u8; 16], stream: u64, send_direction: Direction) -> Frame {
    Frame {
        frame_type: FrameType::Reset,
        flags: frame::flags::RESET,
        session_id: sid,
        stream_id: stream,
        // R3-4c：RESET 是发送方的数据面帧——direction 必须取发送方方向
        //（接收端闸门按 §2.2 校验）。
        direction: send_direction,
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
/// R3-2：通道携带 (epoch, owner)——pump 收帧先 fence（ResumeCtl 快照
/// 比对），旧通道的迟到帧丢弃计数、退出不把新代拉回 Recovering。
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
    /// transition 请求旧 pump 停止；通过 select 唤醒其 recv 等待。
    stopping: std::sync::atomic::AtomicBool,
    stop_notify: tokio::sync::Notify,
    stopped_notify: tokio::sync::Notify,
    /// 本通道的 transport epoch（创建时取 TransportSend.epoch；fence 键 1/2）。
    epoch: u64,
    /// 本通道的 owner id（ResumeCtl 单调分配；fence 键 2/2——同 epoch 的
    /// 双通道由它区分）。
    owner: u64,
}

impl SessionChannel {
    /// 安装通道（R3-2d：唯一安装路径——owner 分配 + active_epoch 更新 +
    /// Weak 登记/单调覆写全部在 ResumeCtl 单锁内；策略见 [`InstallPolicy`]）。
    /// 返回 None = IfVacant 被拒（既有通道存活；调用方应半关本传输）。
    pub(crate) async fn install(
        shared: &Arc<SessionShared>,
        send: TransportSend,
        recv: TransportRecv,
        policy: InstallPolicy,
    ) -> Option<Arc<Self>> {
        shared.install_channel(send, recv, policy, None, None).await
    }

    /// 通道是否已终结（pump 退出）——IfVacant 策略的存活判定。
    pub fn is_dead(&self) -> bool {
        self.dead.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn request_stop(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.stop_notify.notify_waiters();
    }

    async fn wait_stopped(&self) {
        loop {
            // `enable` registers this waiter before the atomic recheck. The
            // pump uses `notify_waiters`, which otherwise has no retained
            // permit and could be lost between the check and `.await`.
            let stopped = self.stopped_notify.notified();
            tokio::pin!(stopped);
            stopped.as_mut().enable();
            if self.is_dead() {
                return;
            }
            stopped.await;
        }
    }

    /// 本通道是否仍是当前胜者（fence 快照）。
    fn is_current(&self) -> bool {
        self.shared.channel_is_current(self.epoch, self.owner)
    }

    pub fn shared(&self) -> &Arc<SessionShared> {
        &self.shared
    }

    pub async fn send_frame(&self, f: &Frame) -> Result<(), FabricError> {
        let mut send = self.send.lock().await;
        // Register the stop waiter before the atomic recheck. A transition
        // can therefore cancel a QUIC write blocked by peer flow control.
        let stop = self.stop_notify.notified();
        tokio::pin!(stop);
        stop.as_mut().enable();
        if self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(map_transport_err(TransportError::Ended));
        }
        let result = tokio::time::timeout(SEND_FRAME_TIMEOUT, async {
            tokio::select! {
                _ = stop.as_mut() => Err(TransportError::Ended),
                result = send.send(f) => result,
            }
        })
        .await
        .map_err(|_| map_transport_err(TransportError::Io("send frame timeout".into())))?;
        result.map_err(map_transport_err)
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
        let open_json =
            format!("{{\"requestId\":\"{stream_id}\",\"idempotencyKey\":\"{idem_key}\"}}");
        self.send_open(stream_id, idem_key, Bytes::from(open_json))
            .await?;
        Ok(stream_id)
    }

    /// 开新逻辑流（OPEN payload 全量由调用方给出——HTTP 引擎携带 §2.4
    /// 元数据；payload 原样上 wire，requestId 由调用方自定）。
    pub async fn open_stream_raw(
        &self,
        idem_key: &str,
        payload: Bytes,
    ) -> Result<u64, FabricError> {
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

    /// 会话泵：独占收半边——收帧 → fence（R3-2）→ 语义处理 → 控制帧立即
    /// 回发。连接死亡（Ended/Io）→ Recovering + dead 置位并返回（恢复由
    /// resume 驱动）；**旧通道退出不改 phase**（owner 已让位——不得把新代
    /// 拉回 Recovering）。
    async fn pump(self: Arc<Self>) -> Result<(), FabricError> {
        let out = self.pump_inner().await;
        self.dead.store(true, std::sync::atomic::Ordering::SeqCst);
        self.arrivals_notify.notify_waiters();
        self.stopped_notify.notify_waiters();
        out
    }

    async fn pump_inner(self: &Arc<Self>) -> Result<(), FabricError> {
        loop {
            let f = {
                let mut recv = self.recv.lock().await;
                // Register before checking `stopping`: `notify_waiters` has
                // no retained permit, so checking first could miss a stop
                // request and leave the old pump blocked in recv.
                let stop = self.stop_notify.notified();
                tokio::pin!(stop);
                stop.as_mut().enable();
                if self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                    return Ok(());
                }
                match tokio::select! {
                    _ = stop.as_mut() => return Ok(()),
                    result = recv.recv() => result,
                } {
                    Ok(f) => f,
                    Err(TransportError::Ended) => {
                        if self.is_current() {
                            self.shared.set_phase(SessionPhase::Recovering).await;
                        }
                        return Ok(());
                    }
                    Err(e) => {
                        if self.is_current() {
                            self.shared.set_phase(SessionPhase::Recovering).await;
                        }
                        return Err(map_transport_err(e));
                    }
                }
            };
            self.dispatch_frame(&f).await?;
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

    /// Fence and commit one received frame. The read lease covers both the
    /// owner check and every resulting side effect, including an immediate
    /// control reply, so a channel transition cannot replace the owner in the
    /// middle of this dispatch.
    async fn dispatch_frame(&self, f: &Frame) -> Result<(), FabricError> {
        // The read lease covers the fence check and semantic commit only.
        // Reply writes are deliberately outside it: QUIC flow control must not
        // prevent a transition from draining the old pump.
        let outcome = {
            let _frame_lease = self.shared.frame_gate.read().await;
            if !self.is_current() {
                self.shared
                    .stale_frame_count
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return Ok(());
            }
            let outcome = self
                .shared
                .handle_frame_with_owner(f, Some(self.owner))
                .await;
            if let Some(stream_id) = outcome.new_open {
                self.arrivals.lock().await.push_back(stream_id);
                self.arrivals_notify.notify_waiters();
            }
            outcome
        };
        if let Some(ctrl) = outcome.reply {
            if let Err(e) = self.send_frame(&ctrl).await {
                // Connection death also enters Recovering (the receive side
                // may never run again), but only while this channel remains
                // the winner. A newer owner cannot be pulled back to recovery.
                if self.is_current() {
                    self.shared.set_phase(SessionPhase::Recovering).await;
                }
                return Err(e);
            }
        }
        Ok(())
    }

    /// Test-only observation hook for a frame that was received by a specific
    /// epoch/owner channel. It deliberately reuses the pump dispatch path.
    #[doc(hidden)]
    pub async fn debug_dispatch_frame(&self, f: &Frame) -> Result<(), FabricError> {
        self.dispatch_frame(f).await
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

impl Clone for Session {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
            channel: std::sync::RwLock::new(self.channel.read().unwrap().clone()),
            // The pump is owned by the original handle. Clones are sending /
            // receiving views and must never abort or double-join that task.
            pump: std::sync::Mutex::new(None),
        }
    }
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
    pub async fn prepare_send(&self, stream_id: u64, payload: &Bytes) -> Result<u64, FabricError> {
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
        let pump = channel.spawn_pump();
        *self.pump.lock().unwrap() = Some(pump);
        *self.channel.write().unwrap() = channel;
    }
}

/// 并发 INIT 败方收敛（R3-3c）：从本地注册表采纳 canonical 会话——等待
/// 本端 accept 侧把胜方 INIT 登记进注册表并装好通道，返回复用句柄
/// （不重复 pump；发送面经 shared 解析当前代通道）。
async fn adopt_session(fabric: &Fabric, canonical: [u8; 16]) -> Result<Session, FabricError> {
    let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        if let Some(shared) = fabric.inner.continuity_sessions.get(&canonical).await {
            if let Some(chan) = shared.current_channel() {
                return Ok(Session {
                    shared,
                    channel: std::sync::RwLock::new(chan),
                    pump: std::sync::Mutex::new(None),
                });
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(FabricError::Session(SessionError::Connect(format!(
                "canonical session {} not observed locally",
                hex8(&canonical)
            ))));
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

// ---------------------------------------------------------------------------
// 会话注册表（provider 侧常驻）
// ---------------------------------------------------------------------------

/// SESSION_INIT 准入裁决结果（P0-2：幂等 + peer/token 绑定校验）。
pub(crate) enum InitAdmission {
    /// 准入：新会话（fresh=true），或同 sid+token 的幂等重发（fresh=false，
    /// 返回既有会话）。
    Admitted(Arc<SessionShared>, bool),
    /// 同 sid 但 peer 不符 → REJECT 0x03 POLICY_DENIED（INIT 表）。
    PeerMismatch,
    /// 同 sid 但 token 不符（伪造/竞态）→ REJECT 0x02 MALFORMED（INIT 表
    /// ——数值与旧 TOKEN_INVALID 相同，语义按 §2.3.0 冻结表）。
    TokenMismatch,
    /// session 已进入 tombstone（dead/closed）；旧凭据不可重新建会话。
    TokenRevoked,
    /// 同 peer 已有 canonical 会话，当前 INIT 是败方。
    Canonical(Arc<SessionShared>),
    /// 新候选按全序胜出，旧的 negotiating shared 已从 per-peer index 撤回。
    Replaced(Arc<SessionShared>, Arc<SessionShared>),
}

struct RegistryEntry {
    shared: Arc<SessionShared>,
    /// `(EndpointId, sessionId)` 全序中的 initiator；provider 入站 INIT
    /// 使用 remote，client campaign 使用本端 identity。
    initiator: Option<crate::identity::EndpointId>,
}

#[derive(Debug, Clone, Copy)]
struct SessionTombstone;

#[derive(Default)]
struct RegistryState {
    sessions: HashMap<[u8; 16], RegistryEntry>,
    /// per-peer canonical index，保证同 peer 不并存不同 session。
    peers: HashMap<String, [u8; 16]>,
    /// terminal session 的撤销锚。新 sid 可复用该 peer；旧 sid 的 RESUME
    /// 明确返回 TOKEN_REVOKED，而不是把状态丢失误报 REQUEST_STATE_LOST。
    tombstones: HashMap<[u8; 16], SessionTombstone>,
}

#[derive(Default)]
pub struct SessionRegistry {
    inner: tokio::sync::Mutex<RegistryState>,
}

pub(crate) enum ResumeLookup {
    Active(Arc<SessionShared>),
    Revoked,
    Missing,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn reap_terminal(state: &mut RegistryState) {
        let terminal: Vec<[u8; 16]> = state
            .sessions
            .iter()
            .filter_map(|(sid, entry)| {
                matches!(
                    entry.shared.phase_sync(),
                    SessionPhase::Dead | SessionPhase::Closed
                )
                .then_some(*sid)
            })
            .collect();
        for sid in terminal {
            if let Some(entry) = state.sessions.remove(&sid) {
                if state.peers.get(&entry.shared.peer_id) == Some(&sid) {
                    state.peers.remove(&entry.shared.peer_id);
                }
                state.tombstones.insert(sid, SessionTombstone);
            }
        }
    }

    /// Test-only legacy admission helper; production INIT uses the ordered
    /// per-peer path below so concurrent campaigns share one canonical index.
    #[cfg(test)]
    pub(crate) async fn admit_init(
        &self,
        session_id: [u8; 16],
        token: [u8; 16],
        peer_id: String,
        limits: JournalLimits,
    ) -> InitAdmission {
        let mut state = self.inner.lock().await;
        Self::reap_terminal(&mut state);
        if state.tombstones.contains_key(&session_id) {
            return InitAdmission::TokenRevoked;
        }
        if let Some(existing) = state.sessions.get(&session_id) {
            if existing.shared.peer_id != peer_id {
                return InitAdmission::PeerMismatch;
            }
            if !existing.shared.init_token_is(&token) {
                return InitAdmission::TokenMismatch;
            }
            return InitAdmission::Admitted(Arc::clone(&existing.shared), false);
        }
        let shared = SessionShared::new(session_id, token, peer_id.clone(), false, limits);
        state.sessions.insert(
            session_id,
            RegistryEntry {
                shared: Arc::clone(&shared),
                initiator: None,
            },
        );
        state.peers.entry(peer_id).or_insert(session_id);
        InitAdmission::Admitted(shared, true)
    }

    /// Ordered per-peer INIT admission. A still-negotiating local campaign may
    /// be replaced only when the incoming `(EndpointId, sessionId)` is smaller;
    /// an active/recovering canonical session always wins and rejects newcomers.
    pub(crate) async fn admit_init_ordered(
        &self,
        session_id: [u8; 16],
        token: [u8; 16],
        peer_id: String,
        incoming_endpoint: crate::identity::EndpointId,
        limits: JournalLimits,
    ) -> InitAdmission {
        let mut state = self.inner.lock().await;
        Self::reap_terminal(&mut state);
        if state.tombstones.contains_key(&session_id) {
            return InitAdmission::TokenRevoked;
        }
        if let Some(existing) = state.sessions.get(&session_id) {
            if existing.shared.peer_id != peer_id {
                return InitAdmission::PeerMismatch;
            }
            if !existing.shared.init_token_is(&token) {
                return InitAdmission::TokenMismatch;
            }
            return InitAdmission::Admitted(Arc::clone(&existing.shared), false);
        }
        let mut replaced = None;
        if let Some(&canonical_sid) = state.peers.get(&peer_id) {
            if let Some(existing) = state.sessions.get(&canonical_sid) {
                let existing_phase = existing.shared.phase_sync();
                let incoming_wins = existing_phase == SessionPhase::Negotiating
                    && existing
                        .initiator
                        .is_some_and(|id| (incoming_endpoint, session_id) < (id, canonical_sid));
                if !incoming_wins {
                    return InitAdmission::Canonical(Arc::clone(&existing.shared));
                }
                replaced = state
                    .sessions
                    .remove(&canonical_sid)
                    .map(|entry| entry.shared);
                state.peers.remove(&peer_id);
            }
        }
        let shared = SessionShared::new(session_id, token, peer_id.clone(), false, limits);
        state.sessions.insert(
            session_id,
            RegistryEntry {
                shared: Arc::clone(&shared),
                initiator: Some(incoming_endpoint),
            },
        );
        state.peers.insert(peer_id, session_id);
        if let Some(old) = replaced {
            InitAdmission::Replaced(shared, old)
        } else {
            InitAdmission::Admitted(shared, true)
        }
    }

    /// Register an outgoing client campaign so an inbound concurrent INIT can
    /// compare it and the loser can later adopt the canonical shared state.
    pub(crate) async fn register_local(
        &self,
        shared: Arc<SessionShared>,
        peer_id: String,
        initiator: crate::identity::EndpointId,
    ) -> (Arc<SessionShared>, bool) {
        let mut state = self.inner.lock().await;
        Self::reap_terminal(&mut state);
        if let Some(&canonical_sid) = state.peers.get(&peer_id) {
            if let Some(existing) = state.sessions.get(&canonical_sid) {
                return (Arc::clone(&existing.shared), false);
            }
            // Defensive cleanup for an index left behind by an interrupted
            // admission; the next caller may safely become the owner.
            state.peers.remove(&peer_id);
        }
        let sid = shared.session_id;
        state.sessions.insert(
            sid,
            RegistryEntry {
                shared: Arc::clone(&shared),
                initiator: Some(initiator),
            },
        );
        state.peers.insert(peer_id, sid);
        (shared, true)
    }

    pub(crate) async fn remove_if(&self, session_id: &[u8; 16]) {
        let mut state = self.inner.lock().await;
        let Some(entry) = state.sessions.remove(session_id) else {
            return;
        };
        // Wake local single-flight waiters before dropping the registry entry;
        // they can then retry with a new session instead of waiting forever on
        // a removed Negotiating shared state.
        entry.shared.set_phase_sync(SessionPhase::Dead);
        // Explicit removal is still terminal: retain a revocation anchor so a
        // late INIT/RESUME for the superseded sid cannot recreate the ghost
        // session while a new sid for the same peer is admitted normally.
        state.tombstones.insert(*session_id, SessionTombstone);
        if state.peers.get(&entry.shared.peer_id) == Some(session_id) {
            state.peers.remove(&entry.shared.peer_id);
        }
    }

    pub(crate) async fn get(&self, session_id: &[u8; 16]) -> Option<Arc<SessionShared>> {
        let mut state = self.inner.lock().await;
        Self::reap_terminal(&mut state);
        state
            .sessions
            .get(session_id)
            .map(|entry| Arc::clone(&entry.shared))
    }

    pub(crate) async fn lookup_resume(&self, session_id: &[u8; 16]) -> ResumeLookup {
        let mut state = self.inner.lock().await;
        Self::reap_terminal(&mut state);
        if let Some(entry) = state.sessions.get(session_id) {
            return ResumeLookup::Active(Arc::clone(&entry.shared));
        }
        if state.tombstones.contains_key(session_id) {
            ResumeLookup::Revoked
        } else {
            ResumeLookup::Missing
        }
    }

    /// Find an existing local session for a peer. Negotiating is included so
    /// concurrent `open_session` calls wait on the first campaign instead of
    /// allocating a second sid.
    pub(crate) async fn reusable_for_peer(&self, peer_id: &str) -> Option<Arc<SessionShared>> {
        let mut state = self.inner.lock().await;
        Self::reap_terminal(&mut state);
        let sid = *state.peers.get(peer_id)?;
        let entry = state.sessions.get(&sid)?;
        (!matches!(
            entry.shared.phase_sync(),
            SessionPhase::Dead | SessionPhase::Closed
        ))
        .then(|| Arc::clone(&entry.shared))
    }
}

// ---------------------------------------------------------------------------
// wire payload 编解码（本模块单一权威；集成测试经 pub 造帧注入）
// ---------------------------------------------------------------------------

/// 本端对同 peer 的 INIT 发起登记（R3-3c：并发双 INIT 的全序裁决面）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct InitCampaign {
    pub session_id: [u8; 16],
}

/// per-peer 发起侧登记表（挂在 FabricInner；成功后保留作迟到交叉 INIT 的
/// 收敛锚，失败/被取代时移除）。
pub(crate) type CampaignMap = tokio::sync::Mutex<HashMap<String, InitCampaign>>;

/// SESSION_INIT payload：[ver u8][sid 16][token 16][local_epoch u64]
///（design §2.3.0——末域是 local_epoch=1，非 generation）。
pub fn encode_session_init(session_id: &[u8; 16], token: &[u8; 16], local_epoch: u64) -> Vec<u8> {
    let mut p = Vec::with_capacity(41);
    p.push(PROTOCOL_VERSION);
    p.extend_from_slice(session_id);
    p.extend_from_slice(token);
    put_u64(&mut p, local_epoch);
    p
}

/// SESSION_INIT_OK payload：[accepted sid 16][accepted_epoch u64][generation u64]
///（design §2.3.0 R4 全载荷——R3-3 闭合）。
pub fn encode_session_init_ok(
    session_id: &[u8; 16],
    accepted_epoch: u64,
    generation: u64,
) -> Vec<u8> {
    let mut p = Vec::with_capacity(40);
    p.extend_from_slice(session_id);
    put_u64(&mut p, accepted_epoch);
    put_u64(&mut p, generation);
    p
}

/// 解析 SESSION_INIT_OK（严格长度；畸形 → None）。
pub fn decode_session_init_ok(p: &[u8]) -> Option<([u8; 16], u64, u64)> {
    // 与 encode 自洽：sid16 + epoch8 + generation8 = 32B
    if p.len() != 32 {
        return None;
    }
    let mut sid = [0u8; 16];
    sid.copy_from_slice(&p[0..16]);
    let accepted_epoch = get_u64(p, 16)?;
    let generation = get_u64(p, 24)?;
    Some((sid, accepted_epoch, generation))
}

/// SESSION_INIT_REJECT payload：[reason u8][canonical sid 16]
/// [canonical_epoch u64][generation u64]（design §2.3.0 R4 全载荷——R3-3
/// 闭合；header.session_id = 被拒方自己的 id，canonical 三元组只在 payload）。
pub fn encode_session_init_reject(
    reason: u8,
    canonical_session_id: &[u8; 16],
    canonical_epoch: u64,
    generation: u64,
) -> Vec<u8> {
    let mut p = Vec::with_capacity(33);
    p.push(reason);
    p.extend_from_slice(canonical_session_id);
    put_u64(&mut p, canonical_epoch);
    put_u64(&mut p, generation);
    p
}

/// 解析 SESSION_INIT_REJECT（严格长度；畸形 → None；canonical 可为全零）。
pub fn decode_session_init_reject(p: &[u8]) -> Option<(u8, [u8; 16], u64, u64)> {
    if p.len() != 33 {
        return None;
    }
    let mut canonical = [0u8; 16];
    canonical.copy_from_slice(&p[1..17]);
    let canonical_epoch = get_u64(p, 17)?;
    let generation = get_u64(p, 25)?;
    Some((p[0], canonical, canonical_epoch, generation))
}

/// RESUME_INIT payload：
/// [ver u8][flags u8][count u16][local_connection_epoch u64]
/// [last_seen_remote_epoch u64][nonce 16][token_len u16=16][token 16]
/// + count × [sid u64][dir u8][flags u8][reserved u16]
/// [recv_ack u64][send_next u64][final_sent u64（无终局 = u64::MAX）]。
pub fn encode_resume_init(
    local_connection_epoch: u64,
    last_seen_remote_epoch: u64,
    nonce: &[u8; 16],
    token: &[u8; 16],
    summaries: &[StreamSummary],
) -> Vec<u8> {
    let mut p = Vec::with_capacity(52 + 36 * summaries.len());
    p.push(PROTOCOL_VERSION);
    p.push(0);
    p.extend_from_slice(&(summaries.len() as u16).to_be_bytes());
    put_u64(&mut p, local_connection_epoch);
    put_u64(&mut p, last_seen_remote_epoch);
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
    pub local_connection_epoch: u64,
    pub last_seen_remote_epoch: u64,
    /// Deprecated aliases retained for consumers compiled against the R4
    /// generation-named fields. They carry the exact same wire values.
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
    if p[1] != 0 {
        return None;
    }
    let count = u16::from_be_bytes([p[2], p[3]]) as usize;
    let local_connection_epoch = get_u64(p, 4)?;
    let last_seen_remote_epoch = get_u64(p, 12)?;
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(&p[20..36]);
    let token_len = u16::from_be_bytes([p[36], p[37]]) as usize;
    let summaries_at = 54usize.checked_add(count.checked_mul(36)?)?;
    if token_len != 16 || p.len() != summaries_at || local_connection_epoch == 0 {
        return None;
    }
    let mut token = [0u8; 16];
    token.copy_from_slice(&p[38..54]);
    if token == [0u8; 16] {
        return None;
    }
    let mut summaries = Vec::with_capacity(count);
    let mut at = 54;
    for _ in 0..count {
        if at + 36 > p.len() {
            return None;
        }
        let mut sid = [0u8; 8];
        sid.copy_from_slice(&p[at..at + 8]);
        let stream_id = u64::from_be_bytes(sid);
        if stream_id == 0 || p[at + 10] != 0 || p[at + 11] != 0 {
            return None;
        }
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
        local_connection_epoch,
        last_seen_remote_epoch,
        local_generation: local_connection_epoch,
        last_seen_generation: last_seen_remote_epoch,
        nonce,
        token,
        summaries,
    })
}

/// RESUME_OK full payload：[accepted sid 16][accepted_epoch u64]
/// [peer_epoch u64][new_generation u64][new_token 16][replay_count u16]
/// [status_flags u16] + replay summaries (36B each).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeOkParsed {
    pub accepted_session_id: [u8; 16],
    pub accepted_epoch: u64,
    pub peer_epoch: u64,
    pub new_generation: u64,
    pub new_resume_token: [u8; 16],
    pub replay_stream_count: u16,
    pub status_flags: u16,
    pub replay_summaries: Vec<StreamSummary>,
}

/// Encode the complete RESUME_OK payload. `replay_summaries` is a bounded
/// snapshot of the sender's outstanding streams, not an unbounded journal dump.
pub fn encode_resume_ok_full(
    session_id: &[u8; 16],
    accepted_epoch: u64,
    peer_epoch: u64,
    new_generation: u64,
    new_token: &[u8; 16],
    replay_summaries: &[StreamSummary],
    status_flags: u16,
) -> Vec<u8> {
    let mut p = Vec::with_capacity(60 + 36 * replay_summaries.len());
    p.extend_from_slice(session_id);
    put_u64(&mut p, accepted_epoch);
    put_u64(&mut p, peer_epoch);
    put_u64(&mut p, new_generation);
    p.extend_from_slice(new_token);
    p.extend_from_slice(&(replay_summaries.len() as u16).to_be_bytes());
    p.extend_from_slice(&status_flags.to_be_bytes());
    for s in replay_summaries {
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

/// Compatibility convenience encoder. It still emits the full wire shape;
/// callers that know the epochs/replay plan should use `encode_resume_ok_full`.
pub fn encode_resume_ok(
    session_id: &[u8; 16],
    new_generation: u64,
    new_token: &[u8; 16],
) -> Vec<u8> {
    encode_resume_ok_full(session_id, 1, 1, new_generation, new_token, &[], 0)
}

/// Strict RESUME_OK decoder. Header/payload session-id equality is checked by
/// the handshake caller; this parser validates the payload's exact shape,
/// reserved fields and absence of trailing garbage.
pub fn decode_resume_ok_full(p: &[u8]) -> Option<ResumeOkParsed> {
    if p.len() < 60 {
        return None;
    }
    let mut accepted_session_id = [0u8; 16];
    accepted_session_id.copy_from_slice(&p[..16]);
    if accepted_session_id == [0u8; 16] {
        return None;
    }
    let accepted_epoch = get_u64(p, 16)?;
    let peer_epoch = get_u64(p, 24)?;
    let new_generation = get_u64(p, 32)?;
    if accepted_epoch == 0 || peer_epoch == 0 || new_generation == 0 {
        return None;
    }
    let mut new_resume_token = [0u8; 16];
    new_resume_token.copy_from_slice(&p[40..56]);
    if new_resume_token == [0u8; 16] {
        return None;
    }
    let replay_stream_count = u16::from_be_bytes([p[56], p[57]]) as usize;
    let status_flags = u16::from_be_bytes([p[58], p[59]]);
    let expected = 60usize.checked_add(replay_stream_count.checked_mul(36)?)?;
    if p.len() != expected {
        return None;
    }
    let mut replay_summaries = Vec::with_capacity(replay_stream_count);
    let mut at = 60;
    for _ in 0..replay_stream_count {
        let stream_id = get_u64(p, at)?;
        if stream_id == 0 || p[at + 10] != 0 || p[at + 11] != 0 {
            return None;
        }
        let recv_ack = get_u64(p, at + 12)?;
        let send_next = get_u64(p, at + 20)?;
        let final_raw = get_u64(p, at + 28)?;
        replay_summaries.push(StreamSummary {
            stream_id,
            recv_ack,
            send_next,
            final_sent: (final_raw != u64::MAX).then_some(final_raw),
        });
        at += 36;
    }
    Some(ResumeOkParsed {
        accepted_session_id,
        accepted_epoch,
        peer_epoch,
        new_generation,
        new_resume_token,
        replay_stream_count: replay_stream_count as u16,
        status_flags,
        replay_summaries,
    })
}

/// Legacy projection used by the existing SDK/test surface. Strictness comes
/// from `decode_resume_ok_full`; only the additional fields are discarded.
pub fn decode_resume_ok(p: &[u8]) -> Option<(u64, [u8; 16])> {
    let parsed = decode_resume_ok_full(p)?;
    Some((parsed.new_generation, parsed.new_resume_token))
}

/// RESUME_REJECT payload：[reason u8]。
pub fn encode_resume_reject(reason: u8) -> Vec<u8> {
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

/// 由已装通道组装会话句柄（pump 启动）。IfVacant 被拒 → None（调用方
/// 半关传输并按「被存活通道取代」处理）。
async fn mk_session(
    shared: Arc<SessionShared>,
    send: TransportSend,
    recv: TransportRecv,
    policy: InstallPolicy,
) -> Option<Session> {
    mk_session_with_expectation(shared, send, recv, policy, None, None).await
}

async fn mk_session_with_expectation(
    shared: Arc<SessionShared>,
    send: TransportSend,
    recv: TransportRecv,
    policy: InstallPolicy,
    decision: Option<ResumeDecision>,
    expected_generation: Option<u64>,
) -> Option<Session> {
    let channel = shared
        .install_channel(send, recv, policy, decision, expected_generation)
        .await?;
    let pump = channel.spawn_pump();
    Some(Session {
        shared,
        channel: std::sync::RwLock::new(channel),
        pump: std::sync::Mutex::new(Some(pump)),
    })
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

/// Wait for a local per-peer campaign to publish its channel. A waiter never
/// starts a second dial; if the owner terminates before publishing, propagate
/// the owner's failure boundary and let the caller explicitly retry.
async fn wait_for_existing_session(shared: Arc<SessionShared>) -> Result<Session, FabricError> {
    let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        if let Some(channel) = shared.current_channel() {
            return Ok(Session {
                shared,
                channel: std::sync::RwLock::new(channel),
                pump: std::sync::Mutex::new(None),
            });
        }
        if matches!(
            shared.phase_sync(),
            SessionPhase::Dead | SessionPhase::Closed
        ) {
            return Err(FabricError::Session(SessionError::Connect(
                "concurrent session owner terminated; retry to open".into(),
            )));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(FabricError::Session(SessionError::Connect(
                "existing session negotiation timeout".into(),
            )));
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// client：建立新会话（收敛感知——传输竞速失败自动换新流重试；拒绝不重试）。
/// P0-2：session_id/token **重试循环外一次生成**、各 attempt 复用——重试
/// 对 provider 幂等（同 sid+token → OK 重发既有会话），ghost 会话不再累积。
/// R3-3c：发起侧登记（continuity_campaigns）——双端并发 INIT 的全序裁决面；
/// 成功后保留（迟到交叉 INIT 的收敛锚），最终失败移除。
pub async fn open_session(
    fabric: &Fabric,
    peer_id: &str,
    opts: SessionOptions,
) -> Result<Session, FabricError> {
    // Per-peer idempotency/single-flight: an active, recovering, or currently
    // negotiating campaign is the canonical local session. A second caller
    // waits for its channel instead of creating a competing sid.
    if let Some(existing) = fabric
        .inner
        .continuity_sessions
        .reusable_for_peer(peer_id)
        .await
    {
        return wait_for_existing_session(existing).await;
    }
    let session_id = rand_16().ok_or_else(entropy_err)?;
    let token = rand_16().ok_or_else(entropy_err)?;
    let candidate = SessionShared::new(session_id, token, peer_id.to_string(), true, opts.limits);
    let (shared, is_owner) = fabric
        .inner
        .continuity_sessions
        .register_local(
            Arc::clone(&candidate),
            peer_id.to_string(),
            fabric.inner.identity.endpoint_id(),
        )
        .await;
    if !is_owner {
        // The registry lock linearizes the check with the insertion above. A
        // concurrent caller reuses the canonical shared state and never sends
        // its freshly generated sid on the wire.
        return wait_for_existing_session(shared).await;
    }
    fabric
        .inner
        .continuity_campaigns
        .lock()
        .await
        .insert(peer_id.to_string(), InitCampaign { session_id });
    let mut last: Option<FabricError> = None;
    for _ in 0..CONVERGENCE_RETRY {
        match open_session_attempt(fabric, peer_id, session_id, token, Arc::clone(&shared)).await {
            Ok(s) => return Ok(s),
            Err(TryAgain::Definitive(e)) => {
                cleanup_campaign(fabric, peer_id, session_id).await;
                fabric
                    .inner
                    .continuity_sessions
                    .remove_if(&session_id)
                    .await;
                return Err(e);
            }
            Err(TryAgain::Transport(e)) => {
                // 首建会话与对端接受侧并发拨号：winner 收敛可能关闭本流所绑
                // 连接（Phase 1 t4 实证形态）——重开新流重试（sid/token 复用）
                last = Some(e);
                tokio::time::sleep(CONVERGENCE_BACKOFF).await;
            }
        }
    }
    cleanup_campaign(fabric, peer_id, session_id).await;
    fabric
        .inner
        .continuity_sessions
        .remove_if(&session_id)
        .await;
    Err(last.expect("至少一次尝试"))
}

/// 移除本 campaign 登记（仅当仍指向自己的 sid——防误删并发的新 campaign）。
async fn cleanup_campaign(fabric: &Fabric, peer_id: &str, session_id: [u8; 16]) {
    let mut map = fabric.inner.continuity_campaigns.lock().await;
    if map.get(peer_id).is_some_and(|c| c.session_id == session_id) {
        map.remove(peer_id);
    }
}

async fn open_session_attempt(
    fabric: &Fabric,
    peer_id: &str,
    session_id: [u8; 16],
    token: [u8; 16],
    shared: Arc<SessionShared>,
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
            // R3-3：全载荷解析 + 回显校验（header/payload sid 一致性）
            if resp.session_id != session_id {
                return Err(TryAgain::Definitive(FabricError::Session(
                    SessionError::Connect("SESSION_INIT_OK header sid mismatch".into()),
                )));
            }
            let Some((echo_sid, _accepted_epoch, _generation)) =
                decode_session_init_ok(&resp.payload)
            else {
                return Err(TryAgain::Definitive(FabricError::Session(
                    SessionError::Connect("malformed SESSION_INIT_OK".into()),
                )));
            };
            if echo_sid != session_id {
                return Err(TryAgain::Definitive(FabricError::Session(
                    SessionError::Connect("SESSION_INIT_OK sid mismatch".into()),
                )));
            }
            shared.set_phase(SessionPhase::Active).await;
            let (send, recv) = transport.into_split();
            // 新会话无既有通道，Force 安装恒成功
            mk_session(shared, send, recv, InstallPolicy::Force)
                .await
                .ok_or_else(|| TryAgain::Transport(channel_superseded_err()))
        }
        FrameType::SessionInitReject => {
            // R3-3c：并发双 INIT 败方收敛——canonical 三元组指向对端胜方
            // 会话，从本地注册表采纳（不产生双会话并存）。
            if resp.session_id != session_id {
                return Err(TryAgain::Definitive(FabricError::Session(
                    SessionError::Connect("SESSION_INIT_REJECT header sid mismatch".into()),
                )));
            }
            if let Some((reason, canonical, _epoch, _gen)) =
                decode_session_init_reject(&resp.payload)
            {
                if reason == init_reason::ALREADY_ACTIVE
                    && canonical != [0u8; 16]
                    && canonical != session_id
                {
                    strace!("open lost race, adopting canonical {}", hex8(&canonical));
                    // 收敛锚更新为 canonical（自身 campaign 撤回语义）
                    fabric.inner.continuity_campaigns.lock().await.insert(
                        peer_id.to_string(),
                        InitCampaign {
                            session_id: canonical,
                        },
                    );
                    fabric
                        .inner
                        .continuity_sessions
                        .remove_if(&session_id)
                        .await;
                    let session = adopt_session(fabric, canonical)
                        .await
                        .map_err(TryAgain::Definitive)?;
                    return Ok(session);
                }
                if reason == init_reason::MALFORMED || reason == init_reason::POLICY_DENIED {
                    return Err(TryAgain::Definitive(FabricError::Session(
                        SessionError::Connect(format!("session init rejected: reason={reason:#x}")),
                    )));
                }
            }
            Err(TryAgain::Definitive(FabricError::Session(
                SessionError::Connect(format!(
                    "session init rejected: reason={}",
                    resp.payload.first().copied().unwrap_or(0)
                )),
            )))
        }
        other => Err(TryAgain::Definitive(FabricError::Session(
            SessionError::Connect(format!("unexpected frame {other:?}")),
        ))),
    }
}

/// mk_session IfVacant 被拒时的统一错误（传输被存活胜者通道取代）。
fn channel_superseded_err() -> FabricError {
    FabricError::Session(SessionError::Connect(
        "transport superseded by live channel".into(),
    ))
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
async fn send_init_reject(
    transport: &mut super::transport::ContinuityTransport,
    session_id: [u8; 16],
    reason: u8,
    canonical: Option<&Arc<SessionShared>>,
) -> Result<(), FabricError> {
    let (canonical_sid, canonical_epoch, generation) = canonical
        .map(|shared| {
            (
                shared.session_id,
                shared.debug_active_epoch(),
                shared.current_generation(),
            )
        })
        .unwrap_or(([0u8; 16], 0, 0));
    transport
        .send(&Frame {
            frame_type: FrameType::SessionInitReject,
            flags: 0,
            session_id,
            stream_id: 0,
            direction: Direction::ProviderToClient,
            byte_offset: 0,
            payload: Bytes::from(encode_session_init_reject(
                reason,
                &canonical_sid,
                canonical_epoch,
                generation,
            )),
        })
        .await
        .map_err(map_transport_err)
}

async fn accept_session_init(
    fabric: &Fabric,
    peer_id: &str,
    opts: SessionOptions,
    mut transport: super::transport::ContinuityTransport,
    init: Frame,
) -> Result<Session, FabricError> {
    let p = &init.payload;
    if p.len() != 41 || p.first().copied() != Some(PROTOCOL_VERSION) {
        send_init_reject(
            &mut transport,
            init.session_id,
            init_reason::MALFORMED,
            None,
        )
        .await?;
        let _ = transport.finish();
        return Err(FabricError::Session(SessionError::Connect(
            "malformed SESSION_INIT".into(),
        )));
    }
    let mut sid = [0u8; 16];
    sid.copy_from_slice(&p[1..17]);
    let mut token = [0u8; 16];
    token.copy_from_slice(&p[17..33]);
    let local_epoch = get_u64(p, 33).unwrap_or(0);
    if sid != init.session_id || sid == [0u8; 16] || token == [0u8; 16] || local_epoch == 0 {
        send_init_reject(
            &mut transport,
            init.session_id,
            init_reason::MALFORMED,
            None,
        )
        .await?;
        let _ = transport.finish();
        return Err(FabricError::Session(SessionError::Connect(
            "malformed SESSION_INIT identity fields".into(),
        )));
    }
    let incoming_endpoint = endpoint_id_parse(peer_id).map_err(FabricError::from)?;
    // Read the per-peer campaign before registry admission. This is the
    // concurrent dual-INIT tie-break input; registry admission repeats the
    // check under its own lock for non-campaign canonical sessions.
    let local_campaign = fabric
        .inner
        .continuity_campaigns
        .lock()
        .await
        .get(peer_id)
        .copied();
    if let Some(campaign) = local_campaign {
        if campaign.session_id != sid {
            let local_endpoint = fabric.inner.identity.endpoint_id();
            let local_shared = fabric
                .inner
                .continuity_sessions
                .get(&campaign.session_id)
                .await;
            let local_is_active = local_shared
                .as_ref()
                .is_some_and(|shared| shared.phase_sync() != SessionPhase::Negotiating);
            let incoming_wins = (incoming_endpoint, sid) < (local_endpoint, campaign.session_id);
            if local_is_active || !incoming_wins {
                let canonical = fabric
                    .inner
                    .continuity_sessions
                    .get(&campaign.session_id)
                    .await;
                send_init_reject(
                    &mut transport,
                    sid,
                    init_reason::ALREADY_ACTIVE,
                    canonical.as_ref(),
                )
                .await?;
                let _ = transport.finish();
                return Err(FabricError::Session(SessionError::Connect(
                    "session init rejected: ALREADY_ACTIVE".into(),
                )));
            }
            let mut campaigns = fabric.inner.continuity_campaigns.lock().await;
            if campaigns
                .get(peer_id)
                .is_some_and(|current| current.session_id == campaign.session_id)
            {
                campaigns.remove(peer_id);
            }
        }
    }
    let admission = fabric
        .inner
        .continuity_sessions
        .admit_init_ordered(
            sid,
            token,
            peer_id.to_string(),
            incoming_endpoint,
            opts.limits,
        )
        .await;
    let (shared, fresh) = match admission {
        InitAdmission::Admitted(shared, is_new) => (shared, is_new),
        InitAdmission::Replaced(shared, _old) => (shared, true),
        InitAdmission::Canonical(canonical) => {
            send_init_reject(
                &mut transport,
                sid,
                init_reason::ALREADY_ACTIVE,
                Some(&canonical),
            )
            .await?;
            let _ = transport.finish();
            return Err(FabricError::Session(SessionError::Connect(
                "session init rejected: ALREADY_ACTIVE".into(),
            )));
        }
        InitAdmission::PeerMismatch => {
            send_init_reject(&mut transport, sid, init_reason::POLICY_DENIED, None).await?;
            let _ = transport.finish();
            return Err(FabricError::Session(SessionError::Connect(
                "session init rejected: POLICY_DENIED (peer mismatch)".into(),
            )));
        }
        InitAdmission::TokenMismatch => {
            send_init_reject(&mut transport, sid, init_reason::MALFORMED, None).await?;
            let _ = transport.finish();
            return Err(FabricError::Session(SessionError::Connect(
                "session init rejected: MALFORMED".into(),
            )));
        }
        InitAdmission::TokenRevoked => {
            send_init_reject(&mut transport, sid, init_reason::MALFORMED, None).await?;
            let _ = transport.finish();
            return Err(FabricError::Session(SessionError::Connect(
                "session init rejected: revoked session".into(),
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
            payload: Bytes::from(encode_session_init_ok(
                &sid,
                transport.epoch,
                shared.current_generation(),
            )),
        })
        .await
        .map_err(map_transport_err)?;
    if fresh {
        shared.set_phase(SessionPhase::Active).await;
    }
    let policy = if fresh {
        InstallPolicy::Force
    } else {
        InstallPolicy::IfVacant
    };
    let (send, recv) = transport.into_split();
    mk_session(shared, send, recv, policy)
        .await
        .ok_or_else(channel_superseded_err)
}

/// provider：RESUME_INIT → **原子裁决+轮换**（`try_rotate`——validate 与
/// rotate 单临界区，P0-1）→ RESUME_OK → 摘要裁剪 journal → **先装通道
/// （pump 并发排水）再后台重放**（P1-5：双向大 replay 不在握手路径上互等）
/// → 重发 FIN → Active。
/// current/previous 均按精确 `(generation, token)` 匹配；同一 pending
/// campaign 的重发走缓存，通道 owner 仍由 transition 串行收口。
async fn accept_resume(
    fabric: &Fabric,
    mut transport: super::transport::ContinuityTransport,
    resume: Frame,
) -> Result<Session, FabricError> {
    if resume.session_id == [0u8; 16] {
        transport
            .send(&Frame {
                frame_type: FrameType::ResumeReject,
                flags: 0,
                session_id: resume.session_id,
                stream_id: 0,
                direction: Direction::ProviderToClient,
                byte_offset: 0,
                payload: Bytes::from(encode_resume_reject(reject_reason::TOKEN_INVALID)),
            })
            .await
            .map_err(map_transport_err)?;
        let _ = transport.finish();
        return Err(FabricError::Session(SessionError::Connect(
            "resume rejected: zero session id".into(),
        )));
    }
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
    let shared = match fabric.inner.continuity_sessions.lookup_resume(&sid).await {
        ResumeLookup::Active(shared) => shared,
        ResumeLookup::Revoked => {
            transport
                .send(&reject(reject_reason::TOKEN_REVOKED))
                .await
                .map_err(map_transport_err)?;
            let _ = transport.finish();
            return Err(FabricError::Session(SessionError::Connect(
                "resume rejected: TOKEN_REVOKED".into(),
            )));
        }
        ResumeLookup::Missing => {
            // 内存注册表无此会话：副作用状态已丢——统一 REQUEST_STATE_LOST
            transport
                .send(&reject(reject_reason::REQUEST_STATE_LOST))
                .await
                .map_err(map_transport_err)?;
            let _ = transport.finish();
            return Err(FabricError::Session(SessionError::Connect(
                "resume rejected: REQUEST_STATE_LOST".into(),
            )));
        }
    };
    // R3-1：原子裁决（单锁：nonce 幂等 + token 窗口——previous 可用性判定
    // 在锁内由 pending 推导，Codex 指出的锁外相位窗口不复存在）
    if parsed.last_seen_remote_epoch > transport.epoch {
        transport
            .send(&reject(reject_reason::STALE_EPOCH))
            .await
            .map_err(map_transport_err)?;
        let _ = transport.finish();
        return Err(FabricError::Session(SessionError::Connect(
            "resume rejected: STALE_EPOCH (peer saw future epoch)".into(),
        )));
    }
    let new_token = rand_16().ok_or_else(entropy_err)?;
    let Some(decision) = shared.decide_resume_with_epoch(
        parsed.nonce,
        parsed.local_connection_epoch,
        &parsed.token,
        new_token,
        parsed.local_connection_epoch,
    ) else {
        let reason = if shared.resume_epoch_is_stale(
            parsed.nonce,
            parsed.local_connection_epoch,
            &parsed.token,
            parsed.local_connection_epoch,
        ) {
            reject_reason::STALE_EPOCH
        } else {
            reject_reason::TOKEN_INVALID
        };
        transport
            .send(&reject(reason))
            .await
            .map_err(map_transport_err)?;
        let _ = transport.finish();
        return Err(FabricError::Session(SessionError::Connect(format!(
            "resume rejected: reason={reason:#x}"
        ))));
    };
    // barrier 测试钩子（R3-1）：轮换完成、OK 未发/Active 未置位窗口——
    // 测试在此注入并发第二 RESUME 验证单胜与幂等（生产零开销）
    shared.resume_gate.wait().await;
    transport
        .send(&Frame {
            frame_type: FrameType::ResumeOk,
            flags: 0,
            session_id: sid,
            stream_id: 0,
            direction: Direction::ProviderToClient,
            byte_offset: 0,
            payload: Bytes::from(encode_resume_ok_full(
                &sid,
                transport.epoch,
                parsed.local_connection_epoch,
                decision.result_generation,
                &decision.result_token,
                &shared.summaries().await,
                0,
            )),
        })
        .await
        .map_err(map_transport_err)?;
    // 摘要裁剪：client 的 recv_ack = 本端 P→C 数据已被消费水位（commit point）
    shared.advance_journal_from_summary(&parsed.summaries).await;
    // P1-5：**先 split + 建通道（pump 立即排水对端重放/ACK）**，重放转后台
    // 任务经 channel 发送——恢复握手里不再有大数据量同步发送，与对端的
    // 反向重放并发进行（QUIC 流控互等死锁闭合）。
    let policy = if decision.cached {
        InstallPolicy::IfVacant
    } else {
        InstallPolicy::Force
    };
    let (send, recv) = transport.into_split();
    let session = mk_session_with_expectation(
        Arc::clone(&shared),
        send,
        recv,
        policy,
        Some(decision),
        None,
    )
    .await
    .ok_or_else(channel_superseded_err)?;
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
    if !decision.cached {
        shared.set_phase(SessionPhase::Active).await;
    }
    Ok(session)
}

/// client：断线后恢复（等 Ready → RESUME_INIT → 续传）。收敛感知——
/// 重连竞速期传输失败自动重试；RESUME_REJECT 为终局（phase → Dead）。
pub async fn resume_session(fabric: &Fabric, session: &Session) -> Result<(), FabricError> {
    let mut last: Option<FabricError> = None;
    // R3-1：nonce 每 campaign 一次（重试复用——provider 侧幂等缓存的匹配键）
    let nonce = rand_16().ok_or_else(entropy_err)?;
    for _ in 0..CONVERGENCE_RETRY {
        match resume_attempt(fabric, session, nonce).await {
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

async fn resume_attempt(
    fabric: &Fabric,
    session: &Session,
    nonce: [u8; 16],
) -> Result<(), TryAgain> {
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
    let local_connection_epoch = transport.epoch;
    let last_seen_remote_epoch = session.shared.last_seen_remote_epoch();
    let (_generation, token) = session.shared.current_token();
    let payload = encode_resume_init(
        local_connection_epoch,
        last_seen_remote_epoch,
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
            if resp.session_id != session.shared.session_id {
                return Err(TryAgain::Definitive(FabricError::Session(
                    SessionError::Connect("RESUME_OK header sid mismatch".into()),
                )));
            }
            let Some(ok) = decode_resume_ok_full(&resp.payload) else {
                return Err(TryAgain::Definitive(FabricError::Session(
                    SessionError::Connect("malformed RESUME_OK".into()),
                )));
            };
            let current_generation = session.shared.current_generation();
            if ok.accepted_session_id != session.shared.session_id
                || ok.peer_epoch != local_connection_epoch
                || ok.accepted_epoch == 0
                || ok.new_generation <= current_generation
            {
                // A response from an older attempt must not replace a newer
                // owner/credential. Close only this transport and let the
                // already-successful attempt remain authoritative.
                let _ = transport.finish();
                if session.shared.phase().await == SessionPhase::Active {
                    return Ok(());
                }
                return Err(TryAgain::Transport(channel_superseded_err()));
            }
            if !session.shared.observe_remote_epoch(ok.accepted_epoch) {
                // A response from an older provider epoch is stale even when
                // its token/generation still parses. It must not rotate the
                // local window or replace the current channel.
                let _ = transport.finish();
                if session.shared.phase().await == SessionPhase::Active {
                    return Ok(());
                }
                return Err(TryAgain::Transport(channel_superseded_err()));
            }
            session
                .shared
                .rotate_token(ok.new_generation, ok.new_resume_token);
            // P1-5：**先 split + 装通道（pump 立即排水对端重放）**，此后
            // OPEN/DATA/FIN 重发经 channel 与接收并发——双向大 replay 不在
            // 握手路径互等（QUIC 流控死锁闭合）。
            let (send, recv) = transport.into_split();
            let Some(chan) = session
                .shared
                .install_channel(
                    send,
                    recv,
                    InstallPolicy::Force,
                    None,
                    Some(ok.new_generation),
                )
                .await
            else {
                // A newer response may have won while this attempt was
                // waiting for the old pump to drain. The candidate transport
                // was half-closed by install_channel; preserve the newer
                // owner instead of panicking or forcing a rollback.
                if session.shared.phase().await == SessionPhase::Active
                    && session.shared.current_generation() >= ok.new_generation
                {
                    return Ok(());
                }
                return Err(TryAgain::Transport(channel_superseded_err()));
            };
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

    const TEST_ALPN: &[u8] = b"/dweb/session-unit-test/1";

    struct RawLink {
        endpoint: iroh::Endpoint,
        conn: iroh::endpoint::Connection,
        stop_tx: tokio::sync::oneshot::Sender<()>,
        server_task: tokio::task::JoinHandle<()>,
    }

    async fn raw_link() -> RawLink {
        let server = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
            .relay_mode(iroh::RelayMode::Disabled)
            .alpns(vec![TEST_ALPN.to_vec()])
            .bind()
            .await
            .expect("unit-test server endpoint");
        let server_id = server.id();
        let socket = *server
            .bound_sockets()
            .first()
            .expect("unit-test server socket");
        let ip = if socket.ip().is_unspecified() {
            std::net::IpAddr::from([127, 0, 0, 1])
        } else {
            socket.ip()
        };
        let addr = std::net::SocketAddr::new(ip, socket.port());
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            let Some(incoming) = server.accept().await else {
                return;
            };
            let Ok(connecting) = incoming.accept() else {
                return;
            };
            let Ok(conn) = connecting.await else {
                return;
            };
            // Deliberately do not accept/read bidi streams. The client send
            // side therefore reaches QUIC flow control for the cancellation
            // test while the connection itself stays alive.
            let _ = stop_rx.await;
            conn.close(0u32.into(), b"unit-test done");
        });
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
            .relay_mode(iroh::RelayMode::Disabled)
            .alpns(vec![TEST_ALPN.to_vec()])
            .bind()
            .await
            .expect("unit-test client endpoint");
        let conn = endpoint
            .connect(
                iroh::EndpointAddr::new(server_id).with_ip_addr(addr),
                TEST_ALPN,
            )
            .await
            .expect("unit-test connection");
        RawLink {
            endpoint,
            conn,
            stop_tx,
            server_task,
        }
    }

    impl RawLink {
        async fn transport(&self, epoch: u64) -> crate::continuity::ContinuityTransport {
            crate::continuity::ContinuityTransport::open(&self.conn, epoch)
                .await
                .expect("unit-test continuity stream")
        }

        async fn close(self) {
            let _ = self.stop_tx.send(());
            self.endpoint.close().await;
            let _ = self.server_task.await;
        }
    }

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

    /// 合法入站 OPEN（client 奇数流 → provider；R3-4 闸门前置fixture）。
    fn open_frame(sid: [u8; 16], stream: u64) -> Frame {
        Frame {
            frame_type: FrameType::Open,
            flags: frame::flags::START,
            session_id: sid,
            stream_id: stream,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from(format!(
                "{{\"requestId\":\"{stream}\",\"idempotencyKey\":\"k{stream}\"}}"
            )),
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

    /// P0-1：原子裁决+轮换——current/previous 均可精确匹配；
    /// owner transition 负责单胜收口。
    #[test]
    fn token_window_try_rotate_adjudication() {
        let mut w = TokenWindow::new([1u8; 16]);
        // current 精确匹配 → 轮换。
        assert!(w.try_rotate(1, &[1u8; 16], [2u8; 16]).is_some());
        // previous 精确匹配同样可恢复（design §2.3.0 R5）。
        assert!(
            w.try_rotate(1, &[1u8; 16], [3u8; 16]).is_some(),
            "previous 精确匹配必须可恢复"
        );
        // 再次轮换 current，generation 继续单调前进。
        let out = w.try_rotate(3, &[3u8; 16], [4u8; 16]).unwrap();
        assert_eq!(out.0, 4, "generation = current.0 + 1（单调）");
        // 错 token / 错 generation → 拒绝
        assert!(w.try_rotate(2, &[9u8; 16], [4u8; 16]).is_none());
        assert!(w.try_rotate(1, &[3u8; 16], [4u8; 16]).is_none());
        // 新 current 恒可用
        assert!(w.try_rotate(4, &[4u8; 16], [5u8; 16]).is_some());
    }

    /// P0-1 regression: if a second nonce supersedes the first previous-token
    /// decision, installing the first decision in reverse order must close only
    /// its candidate transport and leave the newer owner untouched.
    #[tokio::test]
    async fn install_rejects_superseded_decision_without_stopping_new_owner() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xA1u8; 16],
            [0xB1u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let first = shared
            .decide_resume([1u8; 16], 1, &[0xB1u8; 16], [0xC1u8; 16])
            .expect("first decision");
        let newer = shared
            .decide_resume([2u8; 16], 1, &[0xB1u8; 16], [0xD1u8; 16])
            .expect("previous-token decision supersedes first");

        let (send_new, recv_new) = link.transport(2).await.into_split();
        let new_channel = shared
            .install_channel(send_new, recv_new, InstallPolicy::Force, Some(newer), None)
            .await
            .expect("newer decision installs");
        let new_pump = new_channel.spawn_pump();

        let (send_old, recv_old) = link.transport(1).await.into_split();
        let stale = shared
            .install_channel(send_old, recv_old, InstallPolicy::Force, Some(first), None)
            .await;
        assert!(stale.is_none(), "superseded decision must not install");
        assert_eq!(
            shared.debug_channel_owner(),
            1,
            "new owner remains canonical"
        );
        assert!(!new_channel
            .stopping
            .load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            !new_channel.is_dead(),
            "reverse install must not kill new pump"
        );

        new_channel.request_stop();
        let _ = new_pump.await;
        link.close().await;
    }

    /// P0-2 regression: a pump blocked in an outbound QUIC write is cancelled
    /// by transition, allowing the new owner to install within a bounded time.
    #[tokio::test]
    async fn transition_cancels_blocked_send_before_install() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xA2u8; 16],
            [0xB2u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let (send_old, recv_old) = link.transport(1).await.into_split();
        let old_channel = shared
            .install_channel(send_old, recv_old, InstallPolicy::Force, None, None)
            .await
            .expect("old channel installs");
        let old_pump = old_channel.spawn_pump();
        let frame = Frame {
            frame_type: FrameType::Data,
            flags: 0,
            session_id: shared.session_id,
            stream_id: 1,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            // The raw peer intentionally never reads this stream, so the
            // repeated send reaches QUIC flow control and remains pending.
            payload: Bytes::from(vec![0x5Au8; crate::continuity::frame::MAX_FRAME]),
        };
        let sender = {
            let old_channel = Arc::clone(&old_channel);
            tokio::spawn(async move {
                loop {
                    old_channel.send_frame(&frame).await?;
                }
                #[allow(unreachable_code)]
                Ok::<(), FabricError>(())
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(
            !sender.is_finished(),
            "send must still be blocked before stop"
        );

        let (send_new, recv_new) = link.transport(2).await.into_split();
        let started = std::time::Instant::now();
        let new_channel = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            shared.install_channel(send_new, recv_new, InstallPolicy::Force, None, None),
        )
        .await
        .expect("transition must be bounded")
        .expect("new channel installs");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "transition exceeded its bound"
        );
        let send_result = tokio::time::timeout(std::time::Duration::from_secs(2), sender)
            .await
            .expect("stop must release blocked sender")
            .expect("sender task join");
        assert!(send_result.is_err(), "stopped channel must reject send");
        let _ = old_pump.await;
        new_channel.request_stop();
        link.close().await;
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
        assert!(shared
            .record_send(5, &Bytes::from(vec![0u8; 1]))
            .await
            .is_ok());
    }

    /// P0-3 regression: the receive queue has a byte cap independent of frame
    /// count; crossing it resets the stream and does not enqueue the payload.
    #[tokio::test]
    async fn deliver_queue_byte_cap_resets_stream_without_growth() {
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        shared.handle_frame(&open_frame([1u8; 16], 1)).await;
        let half = vec![0xAB; DELIVER_QUEUE_STREAM_CAP / 2];
        assert!(matches!(
            shared
                .handle_frame(&data_frame([1u8; 16], 1, 0, &half))
                .await
                .reply,
            Some(Frame {
                frame_type: FrameType::Ack,
                ..
            })
        ));
        assert!(matches!(
            shared
                .handle_frame(&data_frame(
                    [1u8; 16],
                    1,
                    (DELIVER_QUEUE_STREAM_CAP / 2) as u64,
                    &half,
                ))
                .await
                .reply,
            Some(Frame {
                frame_type: FrameType::Ack,
                ..
            })
        ));
        assert_eq!(
            shared.deliver_queue_bytes(1).await,
            DELIVER_QUEUE_STREAM_CAP,
            "exact cap is still admissible"
        );
        let over = shared
            .handle_frame(&data_frame(
                [1u8; 16],
                1,
                DELIVER_QUEUE_STREAM_CAP as u64,
                &[0xCD],
            ))
            .await;
        assert!(matches!(
            over.reply,
            Some(Frame {
                frame_type: FrameType::Reset,
                ..
            })
        ));
        assert_eq!(
            shared.deliver_queue_bytes(1).await,
            DELIVER_QUEUE_STREAM_CAP,
            "over-cap DATA must be dropped"
        );
        assert_eq!(shared.protocol_violations(), 1);
    }

    /// R5：gap memory is bounded at the session level, not only per stream.
    /// 128 streams may each hold one admissible gap, but the next byte over
    /// the aggregate cap is rejected before it reaches `RecvWindow`.
    #[tokio::test]
    async fn gap_session_byte_cap_resets_without_growth() {
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        let chunk = vec![0xBC; GAP_SESSION_BYTE_CAP / MAX_ACTIVE_STREAMS];
        for index in 0..MAX_ACTIVE_STREAMS {
            let stream_id = (index as u64) * 2 + 1;
            shared.handle_frame(&open_frame([1u8; 16], stream_id)).await;
            assert!(matches!(
                shared
                    .handle_frame(&data_frame([1u8; 16], stream_id, 1, &chunk))
                    .await
                    .reply,
                Some(Frame {
                    frame_type: FrameType::Ack,
                    ..
                })
            ));
        }
        let held: usize = shared
            .streams
            .lock()
            .await
            .values()
            .map(|ctx| ctx.recv.gap_bytes())
            .sum();
        assert_eq!(held, GAP_SESSION_BYTE_CAP);

        let over = shared
            .handle_frame(&data_frame(
                [1u8; 16],
                1,
                (GAP_SESSION_BYTE_CAP as u64) + 1,
                &[0xCD],
            ))
            .await;
        assert!(matches!(
            over.reply,
            Some(Frame {
                frame_type: FrameType::Reset,
                ..
            })
        ));
        let held_after: usize = shared
            .streams
            .lock()
            .await
            .values()
            .map(|ctx| ctx.recv.gap_bytes())
            .sum();
        assert_eq!(held_after, GAP_SESSION_BYTE_CAP, "拒绝不得增长 gap");
        assert_eq!(shared.protocol_violations(), 1);
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
        // R3-4b：入站流先 OPEN 预占（未见流的 DATA 违规丢弃）
        receiver.handle_frame(&open_frame([1u8; 16], 1)).await;
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
        // 正确 session_id 正常处理（R3-4b：先 OPEN 预占再 DATA）
        shared.handle_frame(&open_frame([1u8; 16], 1)).await;
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
        shared.handle_frame(&open_frame([1u8; 16], 1)).await;
        shared
            .handle_frame(&data_frame([1u8; 16], 1, 0, b"data"))
            .await;
        // 新代首次合法交付确认后，previous 与 pending 同锁清除。
        assert!(shared
            .decide_resume([9u8; 16], 1, &[2u8; 16], [4u8; 16])
            .is_none());
        assert!(
            shared
                .decide_resume([10u8; 16], 2, &[3u8; 16], [5u8; 16])
                .is_some(),
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
        assert_eq!(
            shared.recv(7).await.unwrap(),
            Bytes::from_static(b"payload")
        );
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
        let (a, b) = tokio::join!(shared.try_mark_started(1), shared.try_mark_started(1));
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
            InitAdmission::Admitted(s, _) => s,
            _ => panic!("首登记必须准入"),
        };
        // 幂等：同 sid + 同 token + 同 peer → 同一会话（ghost 收敛）
        match reg
            .admit_init([7u8; 16], [1u8; 16], "peer-a".into(), lim)
            .await
        {
            InitAdmission::Admitted(s2, _) => {
                assert!(Arc::ptr_eq(&s1, &s2), "幂等重发返回既有会话")
            }
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

    /// R5：registry admission is the local `open_session` single-flight
    /// boundary. Two candidates for one peer must share the first canonical
    /// `SessionShared`; the loser must not reach transport dialing.
    #[tokio::test]
    async fn registry_register_local_returns_canonical_single_flight() {
        let reg = SessionRegistry::new();
        let initiator = crate::identity::NodeIdentity::from_seed([7u8; 32]).endpoint_id();
        let first = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer-a".into(),
            true,
            JournalLimits::default(),
        );
        let second = SessionShared::new(
            [3u8; 16],
            [4u8; 16],
            "peer-a".into(),
            true,
            JournalLimits::default(),
        );
        let (canonical, first_owner) = reg
            .register_local(Arc::clone(&first), "peer-a".into(), initiator)
            .await;
        assert!(first_owner);
        assert!(Arc::ptr_eq(&canonical, &first));
        let (reused, second_owner) = reg
            .register_local(Arc::clone(&second), "peer-a".into(), initiator)
            .await;
        assert!(!second_owner, "第二个 caller 不得成为拨号 owner");
        assert!(
            Arc::ptr_eq(&reused, &first),
            "必须返回首个 canonical shared"
        );
        assert!(reg.reusable_for_peer("peer-a").await.is_some());
    }

    #[tokio::test]
    async fn registry_remove_leaves_tombstone_but_releases_peer() {
        let reg = SessionRegistry::new();
        let lim = JournalLimits::default();
        let sid = [0x71u8; 16];
        let token = [0x72u8; 16];
        let shared = match reg.admit_init(sid, token, "peer-a".into(), lim).await {
            InitAdmission::Admitted(shared, true) => shared,
            _ => panic!("initial admission must succeed"),
        };
        reg.remove_if(&sid).await;
        assert!(matches!(
            reg.admit_init(sid, token, "peer-a".into(), lim).await,
            InitAdmission::TokenRevoked
        ));
        assert!(reg.reusable_for_peer("peer-a").await.is_none());
        assert_eq!(shared.phase_sync(), SessionPhase::Dead);
    }

    #[tokio::test]
    async fn duplicate_and_overlap_semantics() {
        // 协议语义（网络无关）：重复帧不重复交付；overlap 不一致 → RESET。
        // ACK 值 = commit point（应用消费水位——P0-3）。接收方 = provider
        // 侧（C2P 数据面合法——R3-4c direction 闸门）。
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        shared.handle_frame(&open_frame([1u8; 16], 1)).await;
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
