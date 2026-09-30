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
/// Tombstone LRU capacity. 1024 revoked session ids bounds churn memory while
/// retaining a large enough recent window for delayed resume retries;
/// eviction never reinstates a session, it only changes the fallback to the
/// normal REQUEST_STATE_LOST path for an otherwise unknown id.
const TOMBSTONE_CAP: usize = 1024;

/// r13-P1：本端已中止（LocalAbort）流的 RESET 跨代补发旁路注册表容量上限。
/// 每项仅 8 字节 stream_id；超限按插入序丢弃最旧（LRU 语义：近期取消优先
/// 保留——恢复补发窗口内的迟到恢复仍命中，更早的取消随会话终态自然终结）。
const ABORTED_REGISTRY_CAP: usize = 4096;
/// r13-B4③：未知流 RESET tombstone 容量上限（近期取消记录——覆盖「RESET
/// 先到被丢、OPEN 后到触发 handler」的重排窗口）。stream id 单调分配永不
/// 复用 → tombstone 不可能误伤新流；上限纯为内存有界。
const RESET_TOMBSTONE_CAP: usize = 1024;

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

/// 流终止原因（r11-B2 终态语义面）：`recv` 终结错误的分类——只有
/// [`StreamTerm::Fin`] 是干净 EOF；其余一律按错误透传（N-API bodyNext /
/// 聚合读取器据此区分 null 与 Err——传输失败不得以干净 EOF 外显）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamTerm {
    /// 对端 FIN（干净 EOF——交付队列排空后正常终结）。
    Fin,
    /// 对端 RESET（per-request cancel——上游被取消/掐断）。
    PeerReset,
    /// 本地协议错误（gap 超限/overlap 不一致/交付队列超限——已回 RESET）。
    ProtocolError,
    /// 本端主动中止（供给取消：禁 FIN；RESET 跨恢复代补发直至送达或会话终态）。
    LocalAbort,
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
#[derive(Debug, Clone, Copy, Default)]
pub struct SessionOptions {
    pub limits: JournalLimits,
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
    /// 对端已发 RESET（per-request cancel 链）：serve 响应循环据此止付，
    /// 流式 body 供给面随接收器 Drop 关闭——上游 handler 得以提前收敛。
    peer_reset: bool,
    /// 终止原因（r11-B2）：None = 未终结。落位后按 [`StreamCtx::set_term`]
    /// 的粘滞规则演进——错误终态永不被降级为 Fin。
    term: Option<StreamTerm>,
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
            peer_reset: false,
            term: None,
        }
    }

    /// 终止原因落位（r11-B2 粘滞规则）：错误终态（PeerReset/ProtocolError/
    /// LocalAbort）一旦置位永不改写；Fin 只能被升级为错误终态，绝不反向
    /// （竞速窗口内 FIN 先到、RESET 后到时，取消语义必须胜出）。
    fn set_term(&mut self, t: StreamTerm) {
        if matches!(
            self.term,
            Some(StreamTerm::PeerReset | StreamTerm::ProtocolError | StreamTerm::LocalAbort)
        ) {
            return;
        }
        self.term = Some(t);
    }

    /// 流是否完全终结（名额可回收）。
    ///
    /// r13-P1（abort 配额）双分支：
    /// - **错误终态**（PeerReset/ProtocolError/LocalAbort）：立即回收。流在
    ///   协议层面已死——不会再有任何有效的 FIN/ACK 推进它（对端已取消/双方
    ///   已按错误收敛），把它计入 128 活跃上限会把「活跃流」退化成「会话
    ///   寿命内累计取消数」（128 次取消即拒绝新流）。发送 journal 在错误
    ///   终态落位时同步清账（见 `SessionShared::mark_local_abort` 与 RESET/
    ///   ProtocolError 处理分支），session 字节预算不被死流永久占用。
    ///   LocalAbort 流的 RESET 跨代补发信息在 `aborted_registry`（旁路结构，
    ///   不依赖本 entry 的存续）。
    /// - **干净终局**：双方向 FIN（remote_final + final_sent）+ journal 排空
    ///   （既有语义不变）。
    fn quota_reapable(&self) -> bool {
        if matches!(
            self.term,
            Some(StreamTerm::PeerReset | StreamTerm::ProtocolError | StreamTerm::LocalAbort)
        ) {
            return true;
        }
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

/// provider 侧恢复放弃地平线：当前胜者通道死亡后，无成功 RESUME 的
/// Recovering 会话在此时限后转 Dead（释放 canonical——同 peer 的新 INIT
/// 得以准入；与 client 驱动侧 90s 放弃窗口 Q4 对齐）。
const RESUME_GIVEUP: std::time::Duration = std::time::Duration::from_secs(90);

/// 测试旋钮（毫秒；0 = 默认）。进程级全局——仅串行测试面使用。
static RESUME_GIVEUP_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 测试面：收紧恢复放弃窗口（#[doc(hidden)]；串行测试专用）。
#[doc(hidden)]
pub fn set_resume_giveup_for_test(ms: u64) {
    RESUME_GIVEUP_MS.store(ms, std::sync::atomic::Ordering::Relaxed);
}

fn resume_giveup() -> std::time::Duration {
    let ms = RESUME_GIVEUP_MS.load(std::sync::atomic::Ordering::Relaxed);
    if ms != 0 {
        std::time::Duration::from_millis(ms)
    } else {
        RESUME_GIVEUP
    }
}

/// r13-P1 有界淘汰的**鲜活度准则**：只淘汰项龄超过恢复放弃窗口
///（`resume_giveup`）的最旧项；窗口内的新鲜项宁超软上限也不丢——
/// 「RESET 跨代补发直至送达或会话终态」的承诺不因容量被截断。
///
/// 无损论证：项龄在每次补发发送成功时刷新（`note_aborted_reset_sent`），
/// 因此「项龄 > giveup」意味着上一次发送机会之后经历了 ≥giveup 的窗口
/// 而无任何成功恢复——当前胜者通道死亡后的 giveup 看门狗已把会话置
/// Dead，任何后续重放都不再可能，淘汰等价于会话终态后的自然清账。
/// 内存上界 = 软上限 + 单个 giveup 窗口内的本地写入量（registry/tombstone
/// 只由本地行为写入，无对端放大面）。
fn prune_freshness_bounded(map: &mut HashMap<u64, std::time::Instant>, cap: usize) {
    if map.len() <= cap {
        return;
    }
    let horizon = resume_giveup();
    let excess = map.len() - cap;
    let mut stale: Vec<(u64, std::time::Instant)> = map
        .iter()
        .filter(|(_, at)| at.elapsed() >= horizon)
        .map(|(&id, &at)| (id, at))
        .collect();
    stale.sort_by_key(|&(_, at)| at);
    for (id, _) in stale.into_iter().take(excess) {
        map.remove(&id);
    }
    // 剩余超量项均为窗口内新鲜：保留（软上限，语义优先），由窗口滚动收敛。
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
    /// r13-P1：本端已中止流的旁路注册表（stream_id → 最近一次 RESET 发送/
    /// 登记时刻）。RESET 跨代补发（恢复重放 `aborted_streams`）从此处取——
    /// **独立于 streams 表 entry 的生命周期**（rollback/未来回收不撤走补发
    /// 承诺）；中止流 entry 在 streams 表中按错误终态即时回收 128 配额，二者
    /// 的职责由此拆分。写入侧持 streams 锁（锁序 streams → aborted_registry，
    /// 读取侧仅单锁）。有界淘汰见 [`SessionShared::prune_freshness_bounded`]。
    aborted_registry: tokio::sync::Mutex<HashMap<u64, std::time::Instant>>,
    /// r13-B4③：近期「对未建流发来的 RESET」记录（取消先于 OPEN 到达——
    /// OPEN 发送排队/发送竞速窗口的取消重排）。OPEN 处理时命中即按已取消
    /// 收敛（不入 arrivals——handler 零启动）。stream id 单调不复用，无误伤面。
    reset_tombstones: tokio::sync::Mutex<HashMap<u64, std::time::Instant>>,
    /// r12-B1 终态仲裁锁：`SessionChannel::finish`（FIN 决定+发送）、
    /// [`SessionShared::abort_stream`]（冻结契约裁决+LocalAbort 落位+RESET
    /// 发送）与恢复重放（`replay_fin_arbited` / `replay_data_arbited` /
    /// `replay_open_arbited`——发送时终态复查）的公共线性化点。
    /// r13-B1 冻结契约（全文见 [`SessionShared::abort_stream`]）：FIN 完整
    /// 发出后的迟到 abort 按角色/终局形态裁决为无操作或完整取消——「先到
    /// 者完整完成其终态发送」在 FIN 侧即不可撤销。修复前 finish 在 streams
    /// 锁内检查 LocalAbort 后释放锁、之后才发 FIN——该间隙到达的 abort 先
    /// 记终态，已排队 FIN 仍可能先于 RESET 上 wire。
    /// 会话级单锁（非 per-stream）：终态操作低频，且通道发送本就经单一
    /// send 互斥锁串行——不引入新的串行化面。锁序：terminal_arb →
    /// streams / chan.send（不得反向嵌套）。
    terminal_arb: tokio::sync::Mutex<()>,
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
    /// 对端 RESET 唤醒面（per-request cancel）：serve 响应循环 select 监听——
    /// 挂起中的响应流（handler 无后续 write）也能即时止付并 Drop 接收器。
    pub(crate) reset_notify: tokio::sync::Notify,
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
    /// 刻意关闭中（R2-P1c：close 与 resume/open 并发串行化）——置位后：
    /// 新 OPEN 拒绝、resume install 拒绝、终局提交拒绝 Active；close 的
    /// 通道终结循环据此收敛。
    closing: std::sync::atomic::AtomicBool,
    /// barrier 测试钩子（R3-1；生产零开销）。
    #[doc(hidden)]
    pub resume_gate: ResumeGate,
    /// Unit-test-only shortening for the otherwise six-second stop timeout.
    /// Keeping it on the shared instance avoids a process-global test race.
    #[cfg(test)]
    stop_wait_timeout_ms: std::sync::atomic::AtomicU64,
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
            aborted_registry: tokio::sync::Mutex::new(HashMap::new()),
            reset_tombstones: tokio::sync::Mutex::new(HashMap::new()),
            terminal_arb: tokio::sync::Mutex::new(()),
            next_stream_id: std::sync::atomic::AtomicU64::new(if is_client { 1 } else { 2 }),
            requests: tokio::sync::Mutex::new(HashMap::new()),
            idem_index: tokio::sync::Mutex::new(HashMap::new()),
            aliases: tokio::sync::Mutex::new(HashMap::new()),
            stream_keys: tokio::sync::Mutex::new(HashMap::new()),
            open_metas: tokio::sync::Mutex::new(HashMap::new()),
            delivered: tokio::sync::Mutex::new(HashMap::new()),
            delivered_notify: tokio::sync::Notify::new(),
            reset_notify: tokio::sync::Notify::new(),
            stale_frame_count: std::sync::atomic::AtomicU64::new(0),
            ack_violation_count: std::sync::atomic::AtomicU64::new(0),
            protocol_violation_count: std::sync::atomic::AtomicU64::new(0),
            resume_in_flight: std::sync::atomic::AtomicBool::new(false),
            closing: std::sync::atomic::AtomicBool::new(false),
            resume_gate: ResumeGate::new(),
            #[cfg(test)]
            stop_wait_timeout_ms: std::sync::atomic::AtomicU64::new(0),
            limits,
        })
    }

    fn stop_wait_timeout(&self) -> std::time::Duration {
        #[cfg(test)]
        {
            let millis = self
                .stop_wait_timeout_ms
                .load(std::sync::atomic::Ordering::Relaxed);
            if millis != 0 {
                return std::time::Duration::from_millis(millis);
            }
        }
        STOP_WAIT_TIMEOUT
    }

    #[cfg(test)]
    fn set_stop_wait_timeout_for_test(&self, timeout: std::time::Duration) {
        self.stop_wait_timeout_ms.store(
            timeout.as_millis().try_into().unwrap_or(u64::MAX),
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    /// The second phase of a provider-side RESUME. Call this only after the
    /// candidate channel is installed and its RESUME_OK was sent successfully.
    /// R2 收敛：终局提交条件化——会话在发送窗口内进入 Dead/Closed 或已置
    /// closing 刻意关闭时，不得被无条件拉回 Active（迟到恢复不得复活终态
    /// 会话；90s 窗口内的合法慢恢复不受影响——它们到达时仍 Recovering）。
    fn complete_resume_install(&self) {
        let _ = self.complete_resume_install_checked();
    }

    /// 条件激活（返回是否成功）：仅 Active/Recovering 且未 closing 时置
    /// Active。调用方（客户端恢复路径）失败时撤销安装按 superseded 收敛。
    fn complete_resume_install_checked(&self) -> bool {
        let mut ctl = self.resume_control.lock().unwrap();
        if !self.closing.load(std::sync::atomic::Ordering::Acquire)
            && matches!(ctl.phase, SessionPhase::Active | SessionPhase::Recovering)
        {
            ctl.phase = SessionPhase::Active;
            return true;
        }
        false
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

    /// 刻意关闭前的在途流取消（P1-5）：逐流 best-effort RESET（整体 2s 有
    /// 界——close 不得悬挂）。对端 dispatch 循环头的 peer_reset 检查与
    /// RequestCancel watcher 即时命中——挂起 handler 秒停，不等待会话级
    /// 死亡/看门狗。
    /// r13-B1 对齐：双向都已干净终局（remote_final + final_sent）的流跳过
    /// ——交换已完成，对 null 已消费/必然消费的流补发 RESET 只会产生矛盾
    /// 信号；在途/半开流保持既有取消语义。
    async fn reset_open_streams(&self, chan: &Arc<SessionChannel>) {
        let ids: Vec<u64> = self
            .streams
            .lock()
            .await
            .iter()
            .filter(|(_, c)| !(c.remote_final.is_some() && c.final_sent.is_some()))
            .map(|(&id, _)| id)
            .collect();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        for id in ids {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            let frame = super::frame::Frame {
                frame_type: super::frame::FrameType::Reset,
                flags: 0,
                session_id: self.session_id,
                stream_id: id,
                direction: self.send_direction(),
                byte_offset: 0,
                payload: Bytes::new(),
            };
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(200),
                chan.send_frame(&frame),
            )
            .await;
        }
    }

    /// 通道死亡进入 Recovering 时启动的有界放弃看门狗：到期仍是同一胜者
    /// 且仍 Recovering → Dead（canonical 释放，reap_terminal 懒清注册表）。
    /// 恢复成功（新通道安装）则 owner 已变——看门狗空转退出。
    fn spawn_resume_giveup(self: &Arc<Self>, epoch: u64, owner: u64) {
        let shared = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(resume_giveup()).await;
            if shared.channel_is_current(epoch, owner)
                && shared.phase_sync() == SessionPhase::Recovering
            {
                shared.set_phase_sync(SessionPhase::Dead);
            }
        });
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
        // P1-4/R2-P1c：Dead 会话（canonical 已被替换/看门狗放弃）与刻意
        // 关闭中（closing）不得再安装——在途旧 RESUME 就此出局（失归属/
        // 已关闭语义由对端重开承接）。
        // R3-P1a：closing/Dead 复查覆盖**所有**安装路径（客户端 resume 传
        // decision: None——此前仅 decision 分支设闸，客户端路径绕过）。
        {
            let phase = self.phase_sync();
            let closing = self.closing.load(std::sync::atomic::Ordering::Acquire);
            if closing || phase == SessionPhase::Dead || phase == SessionPhase::Closed {
                let _ = send.finish();
                // 终局终态：候选传输半关出局（迟到安装不得复活）
                return None;
            }
        }
        if let Some(decision) = decision {
            let ctl = self.resume_control.lock().unwrap();
            let valid = ctl.phase != SessionPhase::Dead
                && !self.closing.load(std::sync::atomic::Ordering::Acquire)
                && ctl.pending.as_ref().is_some_and(|pending| {
                    decision_matches_pending(&pending.decision, &decision)
                        && (decision.cached || pending.installed_owner.is_none())
                });
            drop(ctl);
            if !valid {
                let _ = send.finish();
                return None;
            }
        }
        if let Some(expected) = expected_generation
            && self.current_generation() != expected
        {
            let _ = send.finish();
            return None;
        }

        let old = self.current_channel();
        if policy == InstallPolicy::IfVacant
            && let Some(chan) = old.as_ref()
            && !chan.is_dead()
        {
            // Duplicate INIT/RESUME transport is acknowledged by the
            // caller, then half-closed without changing ownership.
            // A stopping pump still owns the transition until it has
            // actually exited, so it is not vacant yet.
            let _ = send.finish();
            return None;
        }
        if let Some(chan) = old {
            chan.request_stop();
            if tokio::time::timeout(self.stop_wait_timeout(), chan.wait_stopped())
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
        if let Some(expected) = expected_generation
            && ctl.tokens.current_generation() != expected
        {
            let _ = send.finish();
            return None;
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
        let conn = send.conn.clone();
        let rx_sample = std::sync::Mutex::new(super::state::RxSample {
            datagrams: conn.stats().udp_rx.datagrams,
            at: std::time::Instant::now(),
        });
        let last_frame_rx = std::sync::Mutex::new(std::time::Instant::now());
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
            conn,
            rx_sample,
            last_frame_rx,
        });
        if ctl.channel.as_ref().is_none_or(|(o, _)| owner > *o) {
            ctl.channel = Some((owner, Arc::downgrade(&chan)));
        }
        if let Some(decision) = decision
            && let Some(pending) = ctl.pending.as_mut()
        {
            debug_assert_eq!(pending.decision.lease_id, decision.lease_id);
            pending.installed_owner = Some(owner);
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
    ///
    /// 返回一个绑定 nonce/generation/epoch 的 decision。
    ///
    /// `decide_resume` 保留无 epoch 的单测便利面；生产入口使用
    /// `decide_resume_with_epoch`。
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
        if let Some(p) = &ctl.pending
            && p.decision.nonce == nonce
            && p.decision.from_generation == effective_generation
            && &p.decision.from_token == token
            && (remote_epoch == 0 || p.decision.remote_epoch == remote_epoch)
        {
            let mut cached = p.decision;
            cached.cached = true;
            return Some(cached);
        }
        if remote_epoch != 0 && remote_epoch < ctl.last_seen_remote_epoch {
            return None;
        }
        let (g, t) = ctl
            .tokens
            .try_rotate(effective_generation, token, new_token)?;
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
        if let Some(pending) = &ctl.pending
            && pending.decision.nonce == nonce
            && pending.decision.from_generation == effective_generation
            && &pending.decision.from_token == token
            && (remote_epoch == 0 || pending.decision.remote_epoch == remote_epoch)
        {
            return false;
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

    /// 观测面：对端是否已对本流发 RESET（per-request cancel）——serve 响应
    /// 循环据此止付，流式供给面随接收器 Drop 关闭。
    pub async fn peer_reset(&self, stream_id: u64) -> bool {
        self.streams
            .lock()
            .await
            .get(&stream_id)
            .is_some_and(|c| c.peer_reset)
    }

    /// 观测面：流终止原因（r11-B2）——None = 未终结。终态粘滞（单调），
    /// 消费端在 `recv` 报错后查询即可获得稳定分类。
    pub async fn stream_term(&self, stream_id: u64) -> Option<StreamTerm> {
        self.streams
            .lock()
            .await
            .get(&stream_id)
            .and_then(|c| c.term)
    }

    /// 测试观测面：本端 FIN 登记水位（r12-B1 断言「中止原子清除 FIN 重放
    /// 面——恢复轮不重放已中止流的 FIN」用）。
    #[doc(hidden)]
    pub async fn debug_final_sent(&self, stream_id: u64) -> Option<u64> {
        self.streams
            .lock()
            .await
            .get(&stream_id)
            .and_then(|c| c.final_sent)
    }

    /// 本端主动中止的终态落位（r11-B1）：**必须在供给面（sender）关闭之前
    /// 调用**——落位与 journal/final_sent 同在 streams 域内原子完成，跨恢复
    /// 代保留（StreamCtx 挂 SessionShared，不随通道更替丢失）。此后：
    /// - `finish()` 拒绝（取消不得伪装干净 EOF）；
    /// - dispatch 对该流禁 FIN；
    /// - 恢复重放面补发 RESET（[`SessionShared::aborted_streams`]——r13-P1
    ///   起从 `aborted_registry` 旁路取，不依赖 streams entry 存续）。
    ///
    /// 幂等；流不存在时静默（对端从未观察到的流无需终结面）。
    /// r12-B1：仅经 [`SessionShared::abort_stream`]（terminal_arb 临界区内）
    /// 调用——直接裸调会绕过与 FIN 发送的线性化仲裁，故为私有。
    ///
    /// r13 落地时的三步原子清账（同 streams 锁内）：
    /// 1. term=LocalAbort（粘滞）；
    /// 2. final_sent=None——撤回 FIN 重放面（r12-B1：中止流不得在恢复轮重放
    ///    FIN）+ RESUME 摘要如实报告；
    /// 3. journal 清账（advance_ack 到 next_offset：释放全部未确认段、保留
    ///    offset 水位）——中止流的 journal 数据**不得**在恢复重放中再次驱动
    ///    对端请求/副作用（r13-B4），也不再占用 session 字节预算（r13-P1：
    ///    否则 128 次取消即可耗尽 8MiB 会话 journal 预算，阻塞一切新发送）。
    /// 4. aborted_registry 登记（RESET 跨代补发承诺的旁路承载，r13-P1）。
    async fn mark_local_abort(&self, stream_id: u64) {
        let mut registry_entry = false;
        {
            let mut streams = self.streams.lock().await;
            if let Some(ctx) = streams.get_mut(&stream_id) {
                // 只有 LocalAbort 真正粘滞落位（此前 term 非错误终态）时才登记
                // 补发面——已是 PeerReset/ProtocolError 的流对端已按错误收敛，
                // 重复补发只是每轮恢复的无效 RESET。
                registry_entry = ctx.term.is_none() || ctx.term == Some(StreamTerm::Fin);
                ctx.set_term(StreamTerm::LocalAbort);
                ctx.final_sent = None;
                let next = ctx.journal.next_offset();
                ctx.journal.advance_ack(next);
            }
        }
        if registry_entry {
            let mut reg = self.aborted_registry.lock().await;
            reg.insert(stream_id, std::time::Instant::now());
            prune_freshness_bounded(&mut reg, ABORTED_REGISTRY_CAP);
        }
        // 唤醒本端消费/止付等待面（recv 竞速循环与 dispatch select）
        self.delivered_notify.notify_waiters();
        self.reset_notify.notify_waiters();
    }

    /// 本端中止流统一面（r11-B1）：终态先落位（跨代保留）→ best-effort
    /// RESET（当前代通道；失败由恢复重放补发）。调用方此后关闭供给面 sender。
    /// r12-B1：与 [`SessionChannel::finish`] 共享 [`SessionShared::terminal_arb`]
    /// ——abort 请求与 FIN 发送在此线性化（first-terminal-wins）：abort 先入
    /// 锁则 FIN 拒绝（FIN 永不上 wire）；FIN 先入锁则其发送完整完成后 abort
    /// 才进入仲裁。
    ///
    /// ## r13-B1 冻结契约（FIN 与 abort 的终态统一规则）
    ///
    /// terminal_arb 序列化下，`final_sent == Some` 等价于「本端 FIN 已完整
    /// 发出（finish 成功返回）」——finish 失败路径会撤回 final_sent。以此
    /// 为基准，abort_stream 在锁内按下表裁决（**粘滞规则「Fin 只升不降」的
    /// 例外收口**：已发出的 FIN 是不可撤销的既成事实）：
    ///
    /// | 本端角色 | 本端 FIN | 对端方向终局（remote_final） | 行为 |
    /// |---|---|---|---|
    /// | provider | 已发出 | 任意 | **无操作**（契约§1） |
    /// | client | 已发出 | 已终局 | **无操作**（契约§2a） |
    /// | client | 已发出 | 未终局 | **完整取消**（契约§2b） |
    /// | 任意 | 未发出 | 任意 | **完整取消**（契约§3，r11/r12 语义不变） |
    ///
    /// - **§1（provider，本端 FIN = 响应方向）**：响应 FIN 的 null 即消费端
    ///   （client 应用）的**终局结果**。FIN 一旦上 wire，消费端可能在任何
    ///   时刻把它消费为 null；此后的迟到 abort 只能产生「null 已发生后又
    ///   收到矛盾 RESET」的不可预测形态（r13-B1 封堵目标）。因此 provider
    ///   侧的迟到 abort 是无操作：不落 LocalAbort、不清 final_sent（恢复轮
    ///   继续重放该 FIN 直至送达）、不发 RESET。
    /// - **§2a（client，双向都已干净终局）**：响应已完整到达（remote_final
    ///   已置），交换已完成——取消不再有意义，无操作与 §1 同理。
    /// - **§2b（client，本端 FIN = 请求方向、响应未终局）**：请求 FIN 的
    ///   null 供入的是对端**可取消的 handler**（RequestCancel/peer_reset
    ///   止付是设计内语义），不是任何一方的终局结果；此时 abort 是唯一的
    ///   取消信号（fetch head 超时/外部取消在 FIN 之后的清理路径），必须
    ///   保留完整取消语义（LocalAbort + 撤回 FIN 重放面 + RESET + 跨代
    ///   补发）。该形态绝不产生「应用已拿到终局 null 后又翻转」——本端应用
    ///   仍在等待响应方向，以 Err 结算。
    /// - **接收侧（既有语义，幂等）**：已终结流迟到的 RESET——term 粘滞升级
    ///   仅修正内部分类，绝不翻转已交付的应用结果。
    ///
    /// 已中止流（term=LocalAbort）的重复 abort 保持幂等重发（mark 幂等 +
    /// RESET best-effort 重发无害）。
    pub async fn abort_stream(&self, stream_id: u64) {
        let _arb = self.terminal_arb.lock().await;
        // 冻结契约裁决（r13-B1）：仅本端 FIN 已完整发出的流可能进入无操作分支
        let frozen = {
            let streams = self.streams.lock().await;
            match streams.get(&stream_id) {
                Some(ctx) if ctx.term == Some(StreamTerm::LocalAbort) => false,
                Some(ctx) if ctx.final_sent.is_some() => {
                    !self.is_client || ctx.remote_final.is_some()
                }
                _ => false,
            }
        };
        if frozen {
            strace!(
                "abort_stream frozen-noop stream={stream_id} (FIN already on wire; \
                 r13-B1 contract)"
            );
            return;
        }
        self.mark_local_abort(stream_id).await;
        self.send_reset(stream_id).await;
    }

    /// 本端已中止（LocalAbort）流清单（r11-B1：恢复轮 RESET 补发面——
    /// 首轮发送失败对流饿死是 0.6.0 的竞速缺口，终态跨代保留后由此承接）。
    /// r13-P1：改从 `aborted_registry` 旁路读取——中止流的 streams entry 已
    /// 按错误终态回收 128 配额，补发承诺不再依赖它的存续。升序输出（重放
    /// 顺序确定）。
    async fn aborted_streams(&self) -> Vec<u64> {
        let mut ids: Vec<u64> = self.aborted_registry.lock().await.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// r13-P1：RESET 补发成功后刷新 registry 项龄——项龄 = 「最近一次发送
    /// 机会」时刻，供 [`prune_freshness_bounded`] 的鲜活度淘汰判定。
    async fn note_aborted_reset_sent(&self, stream_id: u64) {
        let mut reg = self.aborted_registry.lock().await;
        if let Some(at) = reg.get_mut(&stream_id) {
            *at = std::time::Instant::now();
        }
    }

    /// 主动向对端发本流的 RESET（SDK 中止面——provider 上游被取消/掐断时经
    /// StreamWriterJs.abort 调用）。best-effort 有界：通道已死时发送失败即
    /// 中止目的已达（对端经会话终态/自身超时收敛；已中止流的跨代补发见
    /// [`SessionShared::aborted_streams`]）。
    pub async fn send_reset(&self, stream_id: u64) {
        if let Some(chan) = self.current_channel() {
            let frame = super::frame::Frame {
                frame_type: super::frame::FrameType::Reset,
                flags: 0,
                session_id: self.session_id,
                stream_id,
                direction: self.send_direction(),
                byte_offset: 0,
                payload: Bytes::new(),
            };
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), chan.send_frame(&frame))
                    .await;
        }
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

    /// 当前通道 owner 代次（crate 内——生命周期相位守卫用：失败路径只有
    /// 在自己仍是当前胜者时才允许回落 phase）。
    pub(crate) fn current_channel_owner(&self) -> u64 {
        self.resume_control.lock().unwrap().channel_owner
    }

    /// 原子守卫回落（P1-3）：owner 匹配且当前为 Active 才置 Recovering——
    /// 检查与写入在同一 ResumeCtl 锁内（消除「检查后新 owner 安装、旧失败
    /// 随后覆盖新 Active」的 TOCTOU）。
    pub(crate) fn downgrade_to_recovering_if_owner(&self, expected_owner: u64) {
        let mut ctl = self.resume_control.lock().unwrap();
        if ctl.channel_owner == expected_owner && ctl.phase == SessionPhase::Active {
            ctl.phase = SessionPhase::Recovering;
        }
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

    pub(crate) fn send_direction(&self) -> Direction {
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
        if let Some((state, _)) = reqs.get_mut(&stream_id)
            && *state == RequestState::Accepted
        {
            *state = RequestState::Started;
            return true;
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
                    .inspect(|b| {
                        if let Some(dq) = q.get_mut(&stream_id) {
                            dq.bytes = dq.bytes.saturating_sub(b.len());
                        }
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
                if let Some(ack) = supp_ack
                    && let Some(chan) = self.current_channel()
                {
                    // best-effort：连接死亡时丢弃——对端重放触发 Duplicate
                    // 再 ACK，语义自愈
                    let _ = chan.send_frame(&ack).await;
                }
                return Ok(b);
            }
            let (ended, term) = {
                let streams = self.streams.lock().await;
                match streams.get(&stream_id) {
                    Some(ctx) => (
                        // r12-B3：本端中止（LocalAbort）是独立的终止条件——
                        // `mark_local_abort` 不设 remote_final（中止不依赖对端
                        // 声明终局水位），不并入此条件则 Active 会话上本地
                        // abort 后消费端永远悬挂。已排队前缀由循环头先行交付，
                        // 队列排空后按下方 q_empty 复查以 Err 终结。
                        matches!(ctx.remote_final, Some(f) if f == ctx.recv.expected_offset())
                            || ctx.term == Some(StreamTerm::LocalAbort),
                        ctx.term,
                    ),
                    None => (false, None),
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
                    // r11-B2：终止原因入错误消息（消费端经 stream_term 拿稳定
                    // 分类；消息面同步区分——只有 Fin 是「正常终结」措辞）。
                    return Err(SessionError::Connect(match term {
                        Some(StreamTerm::Fin) | None => "stream ended".into(),
                        Some(StreamTerm::PeerReset) => "stream reset by peer".into(),
                        Some(StreamTerm::ProtocolError) => {
                            "stream terminated: protocol error".into()
                        }
                        Some(StreamTerm::LocalAbort) => "stream aborted locally".into(),
                    }));
                }
            }
            // r11-B2（会话丢失面）：队列已空且流未终结时，会话终态不得让消费端
            // 悬挂——已达数据已在循环头交付，此处按错误终结（非干净 EOF）。
            if matches!(
                self.phase().await,
                SessionPhase::Dead | SessionPhase::Closed
            ) {
                return Err(SessionError::Connect(
                    "stream ended: session dead/closed".into(),
                ));
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
        let Some(existing) = streams.get(&stream_id) else {
            return Err(FabricError::Session(SessionError::Connect(format!(
                "unknown stream id: {stream_id}"
            ))));
        };
        // r13-B4：错误终态流拒绝再入账——中止/取消后的 journal 数据不得进入
        // 重放面（双保险：mark/RESET 路径已清账，此处封住竞速窗口的新写入）。
        if matches!(
            existing.term,
            Some(StreamTerm::PeerReset | StreamTerm::ProtocolError | StreamTerm::LocalAbort)
        ) {
            return Err(FabricError::Session(SessionError::Connect(format!(
                "stream terminated: {stream_id} (no journal after terminal error)"
            ))));
        }
        if existing.final_sent.is_some() {
            return Err(FabricError::Session(SessionError::Connect(format!(
                "stream already finished: {stream_id}"
            ))));
        }
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
        streams
            .get_mut(&stream_id)
            .expect("stream checked above")
            .journal
            .record(payload.clone(), false)
            .map_err(|e| FabricError::Session(SessionError::Connect(format!("{e}"))))
    }

    /// 发送面流存在性闸门：DATA/FIN 只能作用于已由 OPEN 预占或由对端
    /// OPEN 登记的逻辑流，禁止凭任意 stream id 隐式造状态。
    /// r13-B4：错误终态（本端中止/对端取消/协议错误）拒绝一切后续发送——
    /// 调用方已失败/对端已取消的流不得继续上 wire（中止与在途发送竞速的
    /// 止收口；替代旧「仅查 final_sent」的宽松面）。
    async fn ensure_send_stream(&self, stream_id: u64) -> Result<(), FabricError> {
        let streams = self.streams.lock().await;
        match streams.get(&stream_id) {
            Some(ctx)
                if matches!(
                    ctx.term,
                    Some(
                        StreamTerm::PeerReset | StreamTerm::ProtocolError | StreamTerm::LocalAbort
                    )
                ) =>
            {
                Err(FabricError::Session(SessionError::Connect(format!(
                    "stream terminated: {stream_id} (no send after terminal error)"
                ))))
            }
            Some(ctx) if ctx.final_sent.is_none() => Ok(()),
            Some(_) => Err(FabricError::Session(SessionError::Connect(format!(
                "stream already finished: {stream_id}"
            )))),
            None => Err(FabricError::Session(SessionError::Connect(format!(
                "unknown stream id: {stream_id}"
            )))),
        }
    }

    /// OPEN 发送失败后的本地预占回滚。该流尚未被对端观察到，因此只需
    /// 撤销发送侧的流上下文和 key 登记，后续 OPEN 仍可复用名额。
    /// r13-B4：已中止（LocalAbort）的流不回滚——abort 清理与 OPEN 发送
    /// 竞速时（head 超时先落终态、迟到的 OPEN 发送失败），保留终态与
    /// registry 补发承诺（streams entry 按错误终态即时回收配额，无泄漏）。
    async fn rollback_send_open(&self, stream_id: u64) {
        {
            let mut streams = self.streams.lock().await;
            if streams
                .get(&stream_id)
                .is_some_and(|c| c.term == Some(StreamTerm::LocalAbort))
            {
                return;
            }
            streams.remove(&stream_id);
        }
        self.stream_keys.lock().await.remove(&stream_id);
    }

    /// P0-3d：活跃流名额预占（OPEN 前置闸门——超限拒绝；名额在流完全终结
    /// （双向终局 + journal 排空）后自然回收）。
    /// r12-B4：pub(crate)——fetch 面在 OPEN 发送 spawn 前同步预占，使超时/
    /// 取消清理（abort_stream 终态落位）不与 OPEN 登记竞速（mark 先于登记
    /// 会静默丢失）。幂等（or-insert）。
    pub(crate) async fn reserve_stream_slot(&self, stream_id: u64) -> Result<(), FabricError> {
        let mut streams = self.streams.lock().await;
        // R3-P1c：closing 复查在登记锁内——与 close 的「先置旗再快照」构成
        // 全序（检查在旗前 → 登记完成于快照前；检查在旗后 → 拒绝）。
        if self.closing.load(std::sync::atomic::Ordering::Acquire) {
            return Err(FabricError::Session(SessionError::Connect(
                "session closing".into(),
            )));
        }
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
    #[cfg(test)]
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
            FrameType::Ack if f.direction != self.send_direction() => {
                self.count_violation();
                return FrameOutcome::drop();
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
                if let Some(final_off) = ctx.remote_final
                    && frame_end > final_off
                {
                    drop(streams);
                    self.count_violation();
                    return FrameOutcome::drop();
                }
                let incoming_gap_bytes = ctx.recv.incoming_gap_bytes(f.byte_offset, &f.payload);
                if session_gap_bytes.saturating_add(incoming_gap_bytes) > GAP_SESSION_BYTE_CAP {
                    // Session-level gap memory is a hard protocol boundary. The
                    // frame is rejected before RecvWindow insertion; terminate
                    // this logical stream and never surface attacker-controlled
                    // bytes to an unbounded application queue.
                    ctx.remote_final = Some(ctx.recv.expected_offset());
                    ctx.set_term(StreamTerm::ProtocolError);
                    // r13-P1：错误终态清账（session 字节预算释放；配额即时回收）
                    let next = ctx.journal.next_offset();
                    ctx.journal.advance_ack(next);
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
                    Ok(SegmentAction::Deliver(segments)) => {
                        // P0-3 commit point：ACK 只携带应用消费水位
                        // （committed_offset——DATA 入队不推进）
                        let ack = mk_ack(self.session_id, sid, f.direction, ctx.committed_offset);
                        if ctx.committed_offset > ctx.last_acked_offset {
                            ctx.last_acked_offset = ctx.committed_offset;
                        }
                        drop(streams);
                        // 按段入队（§3.4 分块边界不变量）：一批到达的段各占一条
                        // 交付队列项——消费端 bodyNext 逐段返回。字节上限按整批
                        // 记账（原子到达，整批拒绝语义与单段一致）。
                        let queued_len: usize = segments.iter().map(|s| s.len()).sum();
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
                                ctx.set_term(StreamTerm::ProtocolError);
                                // r13-P1：错误终态清账（配额即时回收）
                                let next = ctx.journal.next_offset();
                                ctx.journal.advance_ack(next);
                            }
                            drop(streams);
                            self.count_violation();
                            return FrameOutcome {
                                reply: Some(mk_reset(self.session_id, sid, self.send_direction())),
                                new_open: None,
                            };
                        }
                        let dq = q.entry(sid).or_default();
                        for segment in segments {
                            dq.frames.push_back(segment);
                        }
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
                        ctx.set_term(StreamTerm::ProtocolError);
                        // r13-P1：错误终态清账（配额即时回收）
                        let next = ctx.journal.next_offset();
                        ctx.journal.advance_ack(next);
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
                ctx.set_term(StreamTerm::Fin);
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
                    // r13-B4③：取消重排闸门——同 id 近期已有 RESET 到达
                    //（tombstone 命中，消耗性移除）→ 调用方在 OPEN 排队/竞速
                    // 窗口内已取消：不入 arrivals（handler 零启动、零副作用），
                    // 流终态按对端已取消落位（后续帧幂等丢弃），Completed 收敛
                    // watcher。与 dispatch 前的 peer_reset 复查（r12-B4）共同
                    // 覆盖「RESET 先于 OPEN / RESET 先于 dispatch」两个窗口。
                    if self
                        .reset_tombstones
                        .lock()
                        .await
                        .remove(&canonical)
                        .is_some()
                    {
                        {
                            let mut streams = self.streams.lock().await;
                            if let Some(ctx) = streams.get_mut(&canonical) {
                                ctx.remote_final = Some(ctx.recv.expected_offset());
                                ctx.peer_reset = true;
                                ctx.set_term(StreamTerm::PeerReset);
                            }
                        }
                        self.mark_completed(canonical).await;
                        self.reset_notify.notify_waiters();
                        strace!(
                            "open cancelled by pre-arrived reset stream={canonical} \
                             (r13-B4 tombstone)"
                        );
                        return FrameOutcome::drop();
                    }
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
                    ctx.peer_reset = true;
                    ctx.set_term(StreamTerm::PeerReset);
                    // r13-P1：对端已取消——本端 journal 的未确认段永远等不到
                    // ACK，跨代重放也不会被对端消费；同步清账（释放 session
                    // 字节预算，配额按错误终态即时回收）。offset 水位保留。
                    let next = ctx.journal.next_offset();
                    ctx.journal.advance_ack(next);
                    drop(streams);
                    self.delivered_notify.notify_waiters();
                    // 唤醒可能阻塞在 body 供给上的 serve 响应循环（即时止付）
                    self.reset_notify.notify_waiters();
                } else {
                    // R3-4b：未见过的流。r13-B4③：这不是协议违例，而是
                    // 「取消先于 OPEN」的合法重排（OPEN 发送排队/竞速窗口内
                    // 调用方取消——RESET 经发送互斥锁先行上 wire，OPEN 迟到）。
                    // 记 tombstone：随后到达的同 id OPEN 按已取消收敛（handler
                    // 零启动），不再违规计数。淘汰按鲜活度（giveup 窗口外的
                    // 旧项才可丢——迟到的 OPEN 只在会话仍可处理帧时才有意义）。
                    drop(streams);
                    let mut tombs = self.reset_tombstones.lock().await;
                    tombs.insert(sid, std::time::Instant::now());
                    prune_freshness_bounded(&mut tombs, RESET_TOMBSTONE_CAP);
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
    /// r13-B4：错误终态流（本端中止/对端取消/协议错误）跳过 DATA 重放——
    /// 调用方已失败/对端已取消的请求体不得在恢复轮再次上 wire 驱动对端
    /// （journal 在错误终态落位时已清账，此处过滤是语义收口的双保险）。
    async fn replay_batches(&self) -> Vec<(u64, Vec<(u64, Bytes)>)> {
        let streams = self.streams.lock().await;
        streams
            .iter()
            .filter(|(_, c)| {
                c.journal.held_bytes() > 0
                    && !matches!(
                        c.term,
                        Some(
                            StreamTerm::PeerReset
                                | StreamTerm::ProtocolError
                                | StreamTerm::LocalAbort
                        )
                    )
            })
            .map(|(&id, ctx)| (id, ctx.journal.replay().collect()))
            .collect()
    }

    /// 待重发 FIN 的流（终局已宣告但可能未被对端收到）。
    /// r12-B1：本端已中止（LocalAbort 粘滞终态）的流**跳过 FIN 重放**——
    /// 恢复轮若重放 FIN，消费端可能在 RESET 补发处理前把 Fin 映射为干净
    /// EOF（截断伪装完整实体）。中止流的终结面由 aborted_streams 的 RESET
    /// 补发承接（终态跨代保留 → 恢复后中止仍胜出）。
    async fn fin_resent_streams(&self) -> Vec<(u64, u64)> {
        let streams = self.streams.lock().await;
        streams
            .iter()
            .filter(|(_, c)| c.term != Some(StreamTerm::LocalAbort))
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

    /// client 侧 OPEN 重发清单。r13-B4：本端已中止（LocalAbort）的流跳过——
    /// 已取消的请求不得经 OPEN 重发再次触发对端 handler（对端只能经 RESET
    /// 补发以错误收敛；若 RESET 曾先于 OPEN 到达，对端 tombstone 亦兜底）。
    async fn open_resend_list(&self) -> Vec<(u64, String)> {
        let aborted: std::collections::HashSet<u64> =
            self.aborted_registry.lock().await.keys().copied().collect();
        let keys = self.stream_keys.lock().await;
        keys.iter()
            .filter(|&(&id, _)| !aborted.contains(&id))
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
            if let Some(stripped) = rest.strip_prefix('"')
                && let Some(end) = stripped.find('"')
            {
                return stripped[..end].to_string();
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
    /// 所属 continuity 连接（E1′ 硬化 2026-09-30：通道级 rx 静默活性信号）。
    conn: iroh::endpoint::Connection,
    /// 连接 rx 采样（与 ConnHandle 同源的活性原语）。
    rx_sample: std::sync::Mutex<super::state::RxSample>,
    /// 最近一次收到会话帧的时刻（流级正向活性——E1′ 硬化第二信号：
    /// 进程双活 + 连接心跳正常但会话流停滞的 zombie（「response head
    /// timeout」现场）在连接级信号上不可见，只有流级帧静默可判）。
    last_frame_rx: std::sync::Mutex<std::time::Instant>,
}

impl SessionChannel {
    /// 安装通道（R3-2d：唯一安装路径——owner 分配 + active_epoch 更新 +
    /// Weak 登记/单调覆写全部在 ResumeCtl 单锁内；策略见 [`InstallPolicy`]）。
    /// 返回 None = IfVacant 被拒（既有通道存活；调用方应半关本传输）。
    #[expect(
        dead_code,
        reason = "main R6 transition-lease 重构后生产入口迁移，旧安装路径无调用方；待 app-protocol-layer 侧清理"
    )]
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

    /// 通道所属连接的 rx 静默时长（E1′ 硬化：半开尸体连接上 pump 阻塞在
    /// 永不返回的流读盘，`is_dead` 恒 false——连接级心跳 ACK 计数是唯一
    /// 可靠的正向活性证据；与 ConnHandle::rx_silent_for 同源）。
    pub(crate) fn rx_silent_for(&self) -> std::time::Duration {
        let mut sample = self.rx_sample.lock().unwrap();
        super::state::rx_silent_for(&mut sample, &self.conn)
    }

    /// 自最近一次收到会话帧以来的时长（流级活性——pump 每帧刷新）。
    pub(crate) fn frame_silent_for(&self) -> std::time::Duration {
        self.last_frame_rx.lock().unwrap().elapsed()
    }

    /// 通道活性（pump 存活且连接 rx 未静默超阈）——canonical 会话压制新
    /// INIT 的判据（E1′ 硬化：仅 `!is_dead()` 会把半开尸体的 Active canonical
    /// 变成 ALREADY_ACTIVE 滞留，重加入者当日不可恢复）。
    pub(crate) fn is_live(&self) -> bool {
        !self.is_dead() && self.rx_silent_for() <= super::state::CORPSE_SILENCE
    }

    /// 通道是否可被新 sid INIT 替换（E1′ 硬化的替换判据）：非活（pump 退出/
    /// 连接 rx 静默超阈——崩溃与半开类），或**流级帧静默超窗**（进程双活 +
    /// 心跳正常但会话流停滞的 zombie——连接级信号不可见；窗口取 30s：客户端
    /// openSession 对存活会话幂等复用不发新 sid，「新 sid INIT ⟹ 客户端已
    /// 放弃旧会话」为冻结不变式，帧静默只是防御性第二道闸）。
    pub(crate) fn replaceable_by_new_init(&self) -> bool {
        !self.is_live() || self.frame_silent_for() > session_frame_silence()
    }

    /// 终结传输（Session::close Shutdown 语义）：发送半 FIN + 置 dead。
    /// 对端 recv 得到 Ended → Recovering（看门狗放弃 / 新 INIT 替换）。
    pub async fn terminate(&self) {
        self.request_stop();
        let _ = self.send.lock().await.finish();
        self.dead.store(true, std::sync::atomic::Ordering::SeqCst);
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
        self.shared.ensure_send_stream(stream_id).await?;
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
    /// r11-B1：本端已中止的流禁 FIN——取消终态不得伪装干净 EOF（对端只能经
    /// RESET/会话终态以错误收敛）。
    /// r12-B1：FIN 决定与发送全程持有 [`SessionShared::terminal_arb`]——与
    /// [`SessionShared::abort_stream`] 的（终态落位+RESET）构成原子终态仲裁
    ///（first-terminal-wins）。修复前锁内检查 LocalAbort 后释放锁、之后才
    /// 发送 FIN：间隙内到达的 abort 先记终态，已排队 FIN 仍可能先于 RESET
    /// 上 wire。锁序：terminal_arb → streams（不得反向）。
    pub async fn finish(&self, stream_id: u64) -> Result<(), FabricError> {
        let _arb = self.shared.terminal_arb.lock().await;
        self.shared.ensure_send_stream(stream_id).await?;
        let final_offset = {
            let mut streams = self.shared.streams.lock().await;
            let ctx = streams.get_mut(&stream_id).expect("stream checked above");
            if ctx.term == Some(StreamTerm::LocalAbort) {
                return Err(FabricError::Session(SessionError::Connect(format!(
                    "stream aborted locally: no FIN after abort ({stream_id})"
                ))));
            }
            let f = ctx.journal.next_offset();
            ctx.final_sent = Some(f);
            f
        };
        let result = self
            .send_frame(&Frame {
                frame_type: FrameType::Fin,
                flags: frame::flags::END,
                session_id: self.shared.session_id,
                stream_id,
                direction: self.shared.send_direction(),
                byte_offset: final_offset,
                payload: Bytes::new(),
            })
            .await;
        if result.is_err() {
            // FIN was only a local half-close declaration; make a failed send
            // retryable rather than leaving the stream permanently reserved.
            if let Some(ctx) = self.shared.streams.lock().await.get_mut(&stream_id) {
                ctx.final_sent = None;
            }
        }
        result
    }

    /// r13-B1：恢复重放 FIN 受终态仲裁约束——**决定（快照有效性复查）与
    /// 发送全程持有 [`SessionShared::terminal_arb`]**，与 `finish` /
    /// `abort_stream` 同一线性化点。修复前恢复路径先取 `fin_resent_streams`
    /// 快照、锁外发送：快照与 abort 不共用仲裁锁，快照之后到达的 abort
    /// 无法撤回其中的 FIN（消费端可能在 RESET 补发前把 FIN 映射为干净
    /// EOF）。现在快照后到达的 abort 在本临界区内可见：
    /// - abort 先入锁 → term=LocalAbort / final_sent 已清 → **撤回重放**
    ///   （返回 Ok(false)，对端经 RESET 补发以错误收敛）；
    /// - 重放先入锁 → FIN 完整发出后 abort 才落位 → 按冻结契约裁决
    ///   （client 半开形态仍可真取消；provider/双向终局形态为无操作）。
    ///
    /// 快照水位不匹配（final_sent 已变化）同样撤回——不重放过期决定。
    /// 返回 Ok(true) = FIN 已发出；Err = 通道失败（调用方保留状态，下一轮
    /// 恢复重试）。
    pub(crate) async fn replay_fin_arbited(
        &self,
        stream_id: u64,
        snapshot: u64,
    ) -> Result<bool, FabricError> {
        let _arb = self.shared.terminal_arb.lock().await;
        let final_offset = {
            let streams = self.shared.streams.lock().await;
            match streams.get(&stream_id) {
                Some(ctx)
                    if ctx.term != Some(StreamTerm::LocalAbort)
                        && ctx.final_sent == Some(snapshot) =>
                {
                    snapshot
                }
                _ => return Ok(false),
            }
        };
        self.send_frame(&Frame {
            frame_type: FrameType::Fin,
            flags: frame::flags::END | frame::flags::REPLAY,
            session_id: self.shared.session_id,
            stream_id,
            direction: self.shared.send_direction(),
            byte_offset: final_offset,
            payload: Bytes::new(),
        })
        .await
        .map(|()| true)
    }

    /// r13-B4：恢复重放 DATA 同受发送时终态复查——`replay_batches` 快照后
    /// 到达的 abort（或对端 RESET/协议错误）必须能撤回该段的发送（调用方
    /// 已失败/对端已取消的请求体不得再上 wire）。与 FIN 重放同在
    /// [`SessionShared::terminal_arb`] 内复查+发送（逐段短临界区——大重放
    /// 不长期独占仲裁锁）。返回 Ok(false) = 撤回（跳过本段，继续后续段）。
    pub(crate) async fn replay_data_arbited(
        &self,
        stream_id: u64,
        offset: u64,
        payload: Bytes,
    ) -> Result<bool, FabricError> {
        let _arb = self.shared.terminal_arb.lock().await;
        {
            let streams = self.shared.streams.lock().await;
            match streams.get(&stream_id) {
                Some(ctx)
                    if !matches!(
                        ctx.term,
                        Some(
                            StreamTerm::PeerReset
                                | StreamTerm::ProtocolError
                                | StreamTerm::LocalAbort
                        )
                    ) => {}
                _ => return Ok(false),
            }
        }
        self.send_frame(&Frame {
            frame_type: FrameType::Data,
            flags: frame::flags::REPLAY,
            session_id: self.shared.session_id,
            stream_id,
            direction: self.shared.send_direction(),
            byte_offset: offset,
            payload,
        })
        .await
        .map(|()| true)
    }

    /// r13-B4：OPEN 重发同受发送时终态复查——`open_resend_list` 快照后到达的
    /// abort 必须能撤回该 OPEN（已取消请求不得经重发再次触发对端 handler）。
    /// 返回 Ok(false) = 撤回。
    pub(crate) async fn replay_open_arbited(
        &self,
        stream_id: u64,
        idem_key: &str,
    ) -> Result<bool, FabricError> {
        let _arb = self.shared.terminal_arb.lock().await;
        {
            let streams = self.shared.streams.lock().await;
            match streams.get(&stream_id) {
                Some(ctx) if ctx.term != Some(StreamTerm::LocalAbort) => {}
                _ => return Ok(false),
            }
        }
        self.send_frame(&Frame {
            frame_type: FrameType::Open,
            flags: frame::flags::START | frame::flags::REPLAY,
            session_id: self.shared.session_id,
            stream_id,
            direction: self.shared.send_direction(),
            byte_offset: 0,
            payload: Bytes::from(format!(
                "{{\"requestId\":\"{stream_id}\",\"idempotencyKey\":\"{idem_key}\"}}"
            )),
        })
        .await
        .map(|()| true)
    }

    /// 开新逻辑流（OPEN 帧；幂等键供对端副作用归并）。
    pub async fn open_stream(&self, idem_key: &str) -> Result<u64, FabricError> {
        let stream_id = self.alloc_stream();
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
        let stream_id = self.alloc_stream();
        self.send_open(stream_id, idem_key, payload).await?;
        Ok(stream_id)
    }

    /// r12-B4：预分配逻辑流 id（与 [`SessionChannel::open_stream_raw`] 同源，
    /// 但把「分配」与「OPEN 发送」拆开）——发送 await 受调用方 deadline 竞速
    /// 约束（fetch head 预算）时，超时/取消路径仍持有 id 可走 abort_stream
    /// 清理，不留失去句柄的 ghost 流。
    pub fn alloc_stream(&self) -> u64 {
        self.shared.alloc_stream_id()
    }

    /// r12-B4：OPEN 发送拆分面（与 [`SessionChannel::alloc_stream`] 配对——
    /// 发送 await 受调用方 deadline/取消竞速约束时用）。幂等：流名额预占
    /// or-insert，重复调用不重建状态。
    pub(crate) async fn send_open(
        &self,
        stream_id: u64,
        idem_key: &str,
        payload: Bytes,
    ) -> Result<(), FabricError> {
        // R2-P1c：刻意关闭中拒绝新流（close 快照后新开的流不得逃过 RESET）
        if self
            .shared
            .closing
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(FabricError::Session(SessionError::Connect(
                "session closing".into(),
            )));
        }
        // P0-3d：活跃流上限闸门（超限拒绝 OPEN）
        self.shared.reserve_stream_slot(stream_id).await?;
        self.shared
            .stream_keys
            .lock()
            .await
            .insert(stream_id, idem_key.to_string());
        // r13-B4：OPEN 写入排队期间调用方已取消（fetch 超时/取消清理与发送
        // task 竞速——终态已在 terminal_arb 内落位）：跳过上 wire（发了也只会
        // 被对端 tombstone/止付闸门取消），不回滚（registry 承接 RESET 补发）。
        if self
            .shared
            .streams
            .lock()
            .await
            .get(&stream_id)
            .is_some_and(|c| c.term == Some(StreamTerm::LocalAbort))
        {
            return Ok(());
        }
        let result = self
            .send_frame(&Frame {
                frame_type: FrameType::Open,
                flags: frame::flags::START,
                session_id: self.shared.session_id,
                stream_id,
                direction: self.shared.send_direction(),
                byte_offset: 0,
                payload,
            })
            .await;
        if result.is_err() {
            self.shared.rollback_send_open(stream_id).await;
        }
        result
    }

    pub async fn recv(&self, stream_id: u64) -> Result<Bytes, FabricError> {
        self.shared
            .recv(stream_id)
            .await
            .map_err(FabricError::Session)
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
                            self.shared.spawn_resume_giveup(self.epoch, self.owner);
                        }
                        return Ok(());
                    }
                    Err(e) => {
                        if self.is_current() {
                            self.shared.set_phase(SessionPhase::Recovering).await;
                            self.shared.spawn_resume_giveup(self.epoch, self.owner);
                        }
                        return Err(map_transport_err(e));
                    }
                }
            };
            // 流级活性刷新（E1′ 硬化：frame_silent_for 的采样点）
            *self.last_frame_rx.lock().unwrap() = std::time::Instant::now();
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
        if let Some(ctrl) = outcome.reply
            && let Err(e) = self.send_frame(&ctrl).await
        {
            // Connection death also enters Recovering (the receive side
            // may never run again), but only while this channel remains
            // the winner. A newer owner cannot be pulled back to recovery.
            if self.is_current() {
                self.shared.set_phase(SessionPhase::Recovering).await;
                self.shared.spawn_resume_giveup(self.epoch, self.owner);
            }
            return Err(e);
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
        self.shared.ensure_send_stream(stream_id).await?;
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

    /// 显式关闭（Shutdown 语义第一步，SDK task 4.2）：置 Closed、终止 pump、
    /// 取消全部在途流（逐流 RESET——对端 dispatch 止付/RequestCancel 即时
    /// 触发；仅 FIN 会被对端当作可恢复断线，挂起中的 handler 只能等看门狗/
    /// 死亡，P1-5），并终结传输（发送半 FIN——对端 pump 感知 Ended →
    /// Recovering → 看门狗放弃/新 INIT 替换）。
    pub async fn close(&self) {
        // R2-P1c：closing CAS 先行——此后新 OPEN 拒绝、resume install 拒绝、
        // 终局提交拒绝 Active（并发 resume 不得把 Closed 拉回 Active）。
        self.shared
            .closing
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(old) = self.pump.lock().unwrap().take() {
            old.abort();
        }
        // 当前胜者通道终结循环（P2-3 + R2/R3-P1）：持有 channel_transition
        // 与 install 串行化——循环期间不会有新安装插入；再解析再终结直至
        // 无存活通道（transition 锁下 ≤2 轮收敛：当前代 + None）。
        {
            let _transition = self.shared.channel_transition.lock().await;
            for _ in 0..3 {
                let Some(current) = self.shared.current_channel() else {
                    break;
                };
                self.shared.reset_open_streams(&current).await;
                current.terminate().await;
            }
        }
        // 本 handle 自持代幂等兜底（先 clone 再 await——读守卫不得跨 await，
        // 否则 close future 失去 Send）。
        let own = self.channel.read().unwrap().clone();
        own.terminate().await;
        self.shared.set_phase(SessionPhase::Closed).await;
    }

    fn install_channel(&self, channel: Arc<SessionChannel>) {
        let pump = channel.spawn_pump();
        *self.pump.lock().unwrap() = Some(pump);
        *self.channel.write().unwrap() = channel;
    }
}

impl Session {
    /// 由 shared 组装服务面句柄（serve_http 的反向到达面——E1′ 硬化）：
    /// 通道在场才有可服务面；无通道（协商中/已终结）返回 None。
    /// 句柄不持 pump（泵随通道安装已由所有者驱动）；发送面经 shared 解析
    /// 当前代通道（与 adopt_session 同构）。
    pub(crate) fn from_shared_for_serve(shared: Arc<SessionShared>) -> Option<Self> {
        let chan = shared.current_channel()?;
        Some(Self {
            shared,
            channel: std::sync::RwLock::new(chan),
            pump: std::sync::Mutex::new(None),
        })
    }
}

/// 并发 INIT 败方收敛（R3-3c）：从本地注册表采纳 canonical 会话——等待
/// 本端 accept 侧把胜方 INIT 登记进注册表并装好通道，返回复用句柄
/// （不重复 pump；发送面经 shared 解析当前代通道）。
/// `grace`：本地观察到 canonical 的宽限（真双机验收实证 2026-09-30：
/// 崩溃重启的客户端本地没有旧 canonical——等满 HANDSHAKE_TIMEOUT 只会把
/// 重加入失败推迟一个超时周期；调用方以短宽限 + 传输类重试承接）。
async fn adopt_session(
    fabric: &Fabric,
    canonical: [u8; 16],
    grace: std::time::Duration,
) -> Result<Session, FabricError> {
    let deadline = tokio::time::Instant::now() + grace;
    loop {
        if let Some(shared) = fabric.inner.continuity_sessions.get(&canonical).await
            && let Some(chan) = shared.current_channel()
        {
            return Ok(Session {
                shared,
                channel: std::sync::RwLock::new(chan),
                pump: std::sync::Mutex::new(None),
            });
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
    tombstone_order: VecDeque<[u8; 16]>,
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

    fn insert_tombstone(state: &mut RegistryState, session_id: [u8; 16]) {
        if state
            .tombstones
            .insert(session_id, SessionTombstone)
            .is_some()
        {
            state.tombstone_order.retain(|sid| sid != &session_id);
        }
        state.tombstone_order.push_back(session_id);
        while state.tombstone_order.len() > TOMBSTONE_CAP {
            if let Some(evicted) = state.tombstone_order.pop_front() {
                state.tombstones.remove(&evicted);
            }
        }
    }

    fn is_tombstoned(state: &mut RegistryState, session_id: &[u8; 16]) -> bool {
        if !state.tombstones.contains_key(session_id) {
            return false;
        }
        // A successful lookup refreshes recency so a recently retried revoked
        // credential is less likely to lose its explicit TOKEN_REVOKED reason.
        state.tombstone_order.retain(|sid| sid != session_id);
        state.tombstone_order.push_back(*session_id);
        true
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
                Self::insert_tombstone(state, sid);
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
        if Self::is_tombstoned(&mut state, &session_id) {
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
        if Self::is_tombstoned(&mut state, &session_id) {
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
        if let Some(&canonical_sid) = state.peers.get(&peer_id)
            && let Some(existing) = state.sessions.get(&canonical_sid)
        {
            let existing_phase = existing.shared.phase_sync();
            // 0.6.0：Recovering 且通道已死的 canonical 允许被新 INIT 即时替换
            //——客户端 close/重启后的立即重开（否则 canonical 原地滞留，
            // e2e 实证永卡）。通道存活的 Recovering（真实瞬断，RESUME 在途）
            // 仍保持 canonical。客户端侧 openSession 对 recovering 会话幂等
            // 复用（不发新 sid），故新 sid INIT ⟹ 客户端已放弃旧会话。
            // E1′ 硬化（2026-09-30 第六批实证）：「通道已死」判定扩为
            // 「通道可被新 INIT 替换」（is_dead / 连接 rx 静默超 CORPSE_SILENCE
            // / 流级帧静默超 SESSION_FRAME_SILENCE）——半开尸体连接上 pump
            // 阻塞在永不返回的流读盘、is_dead 恒 false；进程双活的流停滞
            // zombie 连接级信号恒活、QUIC 空闲超时永不触发。两者都会把
            // Active canonical 变成 ALREADY_ACTIVE 滞留，重加入者当日不可
            // 恢复（mutual-scratch 死锁的会话层支柱）。
            let recovering_dead_channel = existing_phase == SessionPhase::Recovering
                && existing
                    .shared
                    .current_channel()
                    .is_none_or(|c| c.replaceable_by_new_init());
            // 真双机验收实证（2026-09-30）：Active 但通道已死（对端崩溃后旧
            // 连接被 winner 替换/传输层死亡尚未被 pump 处理完）同样放行新
            // INIT——通道已死的 Active 无法交付任何帧，滞留只会让重加入者的
            // 首个会话吃一次 ALREADY_ACTIVE 拒绝（pump 处理完流终结前存在
            // 该竞态窗口）。E1′ 硬化同上：rx 静默/帧静默超阈同判。
            let active_dead_channel = existing_phase == SessionPhase::Active
                && existing
                    .shared
                    .current_channel()
                    .is_none_or(|c| c.replaceable_by_new_init());
            let incoming_wins = (existing_phase == SessionPhase::Negotiating
                && existing
                    .initiator
                    .is_some_and(|id| (incoming_endpoint, session_id) < (id, canonical_sid)))
                || recovering_dead_channel
                || active_dead_channel;
            if !incoming_wins {
                return InitAdmission::Canonical(Arc::clone(&existing.shared));
            }
            replaced = state
                .sessions
                .remove(&canonical_sid)
                .map(|entry| entry.shared);
            state.peers.remove(&peer_id);
            // P1-4：被替换的旧 shared 立即置 Dead——迟到的在途 RESUME（已持有
            // 旧 Arc）在 install 校验处被拒，不得复活旧会话（双活/孤儿）。
            if let Some(old) = replaced.as_ref() {
                old.set_phase_sync(SessionPhase::Dead);
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
        Self::insert_tombstone(&mut state, *session_id);
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
        if Self::is_tombstoned(&mut state, session_id) {
            ResumeLookup::Revoked
        } else {
            ResumeLookup::Missing
        }
    }

    /// Find an existing local session for a peer. Negotiating is included so
    /// concurrent `open_session` calls wait on the first campaign instead of
    /// allocating a second sid.
    /// peer 当前 canonical sid（P1-4 归属栅栏：accept_resume 安装后、OK 前
    /// 复核——被替换的在途恢复不得发送 RESUME_OK）。
    pub(crate) async fn canonical_sid_for_peer(&self, peer_id: &str) -> Option<[u8; 16]> {
        let mut state = self.inner.lock().await;
        Self::reap_terminal(&mut state);
        let sid = *state.peers.get(peer_id)?;
        state.sessions.get(&sid).map(|_| sid)
    }

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
    if accepted_epoch == 0 || generation == 0 {
        return None;
    }
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
///   [recv_ack u64][send_next u64][final_sent u64（无终局 = u64::MAX）]。
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
/// 会话通道的流级帧静默窗（E1′ 硬化）：超过该窗未收到任何会话帧的
/// Active/Recovering canonical 可被新 sid INIT 替换（进程双活 + 连接心跳
/// 正常但会话流停滞的 zombie——连接级 rx 信号恒活，QUIC 空闲超时永不触发）。
const SESSION_FRAME_SILENCE: std::time::Duration = std::time::Duration::from_secs(30);
/// 帧静默窗测试注入（None = 生产常量；E1′ zombie 类单测需要短窗）。
static FRAME_SILENCE_OVERRIDE: std::sync::Mutex<Option<std::time::Duration>> =
    std::sync::Mutex::new(None);

fn session_frame_silence() -> std::time::Duration {
    FRAME_SILENCE_OVERRIDE
        .lock()
        .unwrap()
        .unwrap_or(SESSION_FRAME_SILENCE)
}

/// 测试注入口：替换帧静默窗（传 None 恢复生产常量）。
#[doc(hidden)]
pub fn set_frame_silence_for_tests(value: Option<std::time::Duration>) {
    *FRAME_SILENCE_OVERRIDE.lock().unwrap() = value;
}
/// 收敛重试预算（真双机验收实证 2026-09-30）：对端崩溃后存活方槽位里的
/// 半开尸体（close_reason 未判死）会把重加入者的前几个候选连接按 winner
/// 规则判负掐掉，直到尸体被 rx 静默阈值驱逐（两个心跳周期 ≈10s）——
/// 首建会话的传输类错误重试必须覆盖该窗口（原 3×250ms 在双机仿真 cargo
/// 测试实测 4/8 失败，即分钟级不收敛缺陷的微观形态）。
const CONVERGENCE_RETRY: usize = 10;
const CONVERGENCE_BACKOFF: std::time::Duration = std::time::Duration::from_millis(250);
const CONVERGENCE_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(2);

/// Wait for a local per-peer campaign to publish its channel. A waiter never
/// starts a second dial; if the owner terminates before publishing, propagate
/// the owner's failure boundary and let the caller explicitly retry.
async fn wait_for_existing_session(shared: Arc<SessionShared>) -> Result<Session, FabricError> {
    let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        if let Some(channel) = shared.current_channel()
            && !channel.is_dead()
        {
            // 活性闸门：pump 已退出（dead）的通道一帧都发不出，交付即
            // 「open_stream 立即 connection lost」（互开翻覆现场实证
            // 2026-09-29：provider 孪生侧经本路径拿到 dead 通道——Weak 仍可
            // 被存活的 Session 句柄强锚升级）。死通道按无通道处理：继续等
            // 新代安装（client 侧重开/resume 驱动 admit 替换）或终态/超时。
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
/// E1′ 硬化（2026-09-30 第六批实证）：reusable 既有会话的通道若已不可救
/// （pump 退出/连接 rx 静默超阈/流级帧静默超窗——「response head timeout」
/// 后客户端复用 zombie 通道反复撞墙），不再幂等复用——显式放弃
/// （remove_if 与 tombstone 防复活）后以新 sid 全新建会话；协商中的
/// campaign（无通道）保持 single-flight 等待。
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
        // E1′ 硬化修正（2026-09-30 互开现场实证）：只放弃**本端自己的
        // client campaign**（is_client——本端发起、本端可重开）。对端发起
        // 会话在本端的 provider 孪生（is_client=false）绝不得 tombstone：
        // 它是对端 Active campaign 的 canonical——对端 reject 时以它为锚、
        // 本端 adopt 需在本地注册表找到它；tombstone 后成 mutual 拒绝死锁
        //（双方互相以对方无法 adopt 的 canonical 拒绝，永不收敛）。provider
        // 孪生的死通道由对端自己的重开（admit 替换路径）承接。
        let corpse_channel = existing.is_client
            && match existing.current_channel() {
                Some(c) => c.replaceable_by_new_init(),
                None => !matches!(existing.phase_sync(), SessionPhase::Negotiating),
            };
        if corpse_channel {
            // 不可救通道上的本端 campaign 无法交付任何帧：放弃旧 sid
            //（tombstone 防本地复活），以全新 campaign 建立——provider 侧
            // 同信号（admit_init_ordered）保证新 INIT 被即时采纳。
            fabric
                .inner
                .continuity_sessions
                .remove_if(&existing.session_id)
                .await;
            fabric
                .inner
                .continuity_campaigns
                .lock()
                .await
                .remove(peer_id);
        } else {
            return wait_for_existing_session(existing).await;
        }
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
    let mut backoff = CONVERGENCE_BACKOFF;
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
                // 连接（Phase 1 t4 实证形态）——重开新流重试（sid/token 复用）。
                // 退避指数增长（250ms 起、2s 封顶）：预算须覆盖尸体驱逐窗口
                // （~10s），让重加入者的候选连接最终落在存活方采纳的新代次上。
                last = Some(e);
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(CONVERGENCE_BACKOFF_MAX);
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
            let Some((echo_sid, accepted_epoch, generation)) =
                decode_session_init_ok(&resp.payload)
            else {
                return Err(TryAgain::Definitive(FabricError::Session(
                    SessionError::Connect("malformed SESSION_INIT_OK".into()),
                )));
            };
            if echo_sid != session_id || accepted_epoch == 0 || generation == 0 {
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
                    // 真双机验收实证（2026-09-30）：ALREADY_ACTIVE 的 canonical
                    // 只在「本端 accept 侧已登记胜方」时本地可得（真并发双
                    // INIT）。崩溃重启的客户端本地没有旧 canonical——短宽限
                    // 观察不到即按传输类可重试：provider 侧旧 canonical 的
                    // 死通道替换（admit_init_ordered）会在下一轮 INIT 生效，
                    // 不得以 Definitive 语义等满 HANDSHAKE_TIMEOUT 后放弃
                    // （重加入者首个会话曾因此卡 10s 后失败）。
                    const ADOPT_CANONICAL_GRACE: std::time::Duration =
                        std::time::Duration::from_millis(500);
                    match adopt_session(fabric, canonical, ADOPT_CANONICAL_GRACE).await {
                        Ok(session) => return Ok(session),
                        Err(e) => {
                            strace!("canonical not local ({e}); retrying init");
                            return Err(TryAgain::Transport(e));
                        }
                    }
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
            // 收敛期 accept 侧连接死亡（败者连接被 winner 规则关闭）：重接受。
            // 退避（E1′ 硬化 2026-09-30 双机实证）：NoAddressingInfo 类错误
            //（serve 预绑的不可达成员）在此 continue 曾无退避热自旋——真双机
            // 实测 3 分钟 270 万条 trace；拨号类错误重试至少间隔一个拨号周期。
            Err(e) => {
                strace!("accept_stream err {e}");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
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
                return accept_session_init(fabric, peer_id, opts, transport, first).await;
            }
            FrameType::ResumeInit => return accept_resume(fabric, transport, first).await,
            other => {
                return Err(FabricError::Session(SessionError::Connect(format!(
                    "unexpected first frame {other:?}"
                ))));
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
    if let Some(campaign) = local_campaign
        && campaign.session_id != sid
    {
        let local_endpoint = fabric.inner.identity.endpoint_id();
        let local_shared = fabric
            .inner
            .continuity_sessions
            .get(&campaign.session_id)
            .await;
        // 活跃判定只认 Active / （通道存活的）Recovering：Dead/Closed 与
        // 通道已死的 Recovering 不得压制新 INIT（canonical 由 reap_terminal
        // 懒清；放弃看门狗负责转 Dead；死通道 Recovering 即时替换语义见
        // admit_init_ordered）。E1′ 硬化：「通道存活」= is_live（含连接 rx
        // 静默信号——半开尸体连接上 is_dead 恒 false，Active 侧同样不得
        // 用尸体通道压制新 INIT）；Active 且无通道（罕见中间态）保守视为
        // 活跃（真并发双 INIT 收敛优先）。
        let local_is_active = local_shared.as_ref().is_some_and(|shared| {
            let phase = shared.phase_sync();
            if phase == SessionPhase::Active {
                return shared.current_channel().is_none_or(|c| c.is_live());
            }
            phase == SessionPhase::Recovering
                && shared.current_channel().is_some_and(|c| c.is_live())
        });
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
/// rotate 单临界区，P0-1）→ 摘要裁剪 journal → **先装通道**（pump 并发
/// 排水）→ 仅在安装成功后发送 RESUME_OK → 后台重放（P1-5：双向大 replay
/// 不在握手路径上互等）→ 重发 FIN → Active。
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
    // 摘要裁剪：client 的 recv_ack = 本端 P→C 数据已被消费水位（commit point）
    shared.advance_journal_from_summary(&parsed.summaries).await;
    let resume_ok = Frame {
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
    };
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
    // P1-4 归属栅栏：安装成功 ≠ 仍拥有 canonical——决策与安装之间可能有
    // 新 INIT 走死通道替换路径移除了本会话。已失归属则半关候选（close 含
    // 流 RESET + FIN），不发送 RESUME_OK——对端以失败/重开收敛，无双活。
    if fabric
        .inner
        .continuity_sessions
        .canonical_sid_for_peer(&shared.peer_id)
        .await
        != Some(shared.session_id)
    {
        session.close().await;
        return Err(channel_superseded_err());
    }
    // R2-P1a：终态复核——安装与栅栏之间会话可能已 Dead/Closed（看门狗/
    // 刻意 close）。终态会话不发成功 OK（对端以失败/重开收敛）；即便
    // 与下方发送窗口内的替换交错，complete_resume_install 的条件化提交
    // 兜底不复活。
    {
        let phase = shared.phase_sync();
        let closing = shared.closing.load(std::sync::atomic::Ordering::Acquire);
        if matches!(phase, SessionPhase::Dead | SessionPhase::Closed) || closing {
            session.close().await;
            return Err(channel_superseded_err());
        }
    }
    // Two-phase RESUME commit: the client must not observe RESUME_OK until the
    // provider has installed the candidate channel. If installation failed,
    // mk_session_with_expectation already half-closed the candidate transport;
    // pending remains available for a same-nonce cached retry.
    //
    // owner 守卫：OK 发送失败只在「本通道仍是当前胜者」时回落 phase——
    // 被更晚恢复超替的失败不得把新胜者刚置的 Active 打回 Recovering
    // （0.6.0 s6b 实证：废弃 RESUME 的迟到失败覆盖了后续成功轮的相位；
    // P1-3：检查+写入原子化于 ResumeCtl 单锁内）。
    let installed_owner = shared.current_channel_owner();
    session
        .channel()
        .send_frame(&resume_ok)
        .await
        .inspect_err(|_e| {
            shared.downgrade_to_recovering_if_owner(installed_owner);
        })?;
    {
        let replay_shared = Arc::clone(&shared);
        let replay_chan = session.channel();
        tokio::spawn(async move {
            // 重放未 ack 段（轮转交织——小流/控制不被大流垄断）；连接死亡
            // 即中止——journal 未释放，下一轮恢复自愈重放。
            // r13-B4：逐段经 replay_data_arbited——实际发送前在 terminal_arb
            // 内复查终态（快照后到达的 abort/RESET 撤回该段发送）。
            for (stream_id, offset, payload) in
                interleave_replay(replay_shared.replay_batches().await)
            {
                match replay_chan
                    .replay_data_arbited(stream_id, offset, payload)
                    .await
                {
                    Ok(_) => {}
                    Err(_) => return,
                }
            }
            // 重发 FIN（终局帧不入 journal——对端可能未收到）。r13-B1：每次
            // 发送经 replay_fin_arbited——实际发送前在 terminal_arb 内复查
            // 快照有效性（快照后到达的 abort 撤回该 FIN 的重放）。
            for (stream_id, final_offset) in replay_shared.fin_resent_streams().await {
                match replay_chan
                    .replay_fin_arbited(stream_id, final_offset)
                    .await
                {
                    Ok(_) => {}
                    Err(_) => return,
                }
            }
            // r11-B1：本端已中止流的 RESET 补发（终态跨代保留——首轮 best-effort
            // 发送失败由恢复重放承接；发送失败保留状态，下轮恢复再发）。
            // r13-P1：成功发送刷新 registry 项龄（有界淘汰的鲜活度依据——
            // 超窗项只可能在会话已终态（giveup 后 Dead）后丢失）。
            for stream_id in replay_shared.aborted_streams().await {
                let frame = Frame {
                    frame_type: FrameType::Reset,
                    flags: frame::flags::RESET,
                    session_id: replay_shared.session_id,
                    stream_id,
                    direction: replay_shared.send_direction(),
                    byte_offset: 0,
                    payload: Bytes::new(),
                };
                if replay_chan.send_frame(&frame).await.is_err() {
                    return;
                }
                replay_shared.note_aborted_reset_sent(stream_id).await;
            }
        });
    }
    // Cached decisions are a successful second phase as well: once their
    // candidate channel is installed and RESUME_OK is sent, provider is Active.
    shared.complete_resume_install();
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
            // R3-P1a：条件激活——closing 窗口内迟到完成的客户端恢复不得把
            // Closed 拉回 Active（complete_resume_install 的 ResumeCtl 单锁
            // 条件化语义复用）；激活失败即撤销安装并按 superseded 收敛。
            if !session.shared.complete_resume_install_checked() {
                let _ = chan.terminate().await;
                return Err(TryAgain::Transport(channel_superseded_err()));
            }
            // 重发 OPEN（幂等归并，不占数据 offset 空间）。r13-B4：发送经
            // replay_open_arbited 受终态仲裁约束——快照后到达的 abort 撤回该
            // OPEN（已取消请求不得经重发再次触发对端 handler）。
            for (stream_id, idem) in session.shared.open_resend_list().await {
                chan.replay_open_arbited(stream_id, &idem)
                    .await
                    .map_err(map_fabric_err_try)?;
            }
            // 重放未 ack 段（client 侧对称；对端 RecvWindow 去重）。r13-B4：
            // 逐段经 replay_data_arbited——发送前在 terminal_arb 内复查终态。
            for (stream_id, offset, payload) in
                interleave_replay(session.shared.replay_batches().await)
            {
                chan.replay_data_arbited(stream_id, offset, payload)
                    .await
                    .map_err(map_fabric_err_try)?;
            }
            // 重发 FIN。r13-B1：发送经 replay_fin_arbited 受终态仲裁约束
            //（快照后到达的 abort 撤回该 FIN 的重放；见方法注释）。
            for (stream_id, final_offset) in session.shared.fin_resent_streams().await {
                chan.replay_fin_arbited(stream_id, final_offset)
                    .await
                    .map_err(map_fabric_err_try)?;
            }
            // r11-B1：本端已中止流的 RESET 补发（终态跨代保留；失败保留状态，
            // 下轮恢复再发——对端必须以错误而非干净 EOF 收敛）。r13-P1：成功
            // 发送刷新 registry 项龄（有界淘汰的鲜活度依据）。
            for stream_id in session.shared.aborted_streams().await {
                chan.send_frame(&Frame {
                    frame_type: FrameType::Reset,
                    flags: frame::flags::RESET,
                    session_id: session.shared.session_id,
                    stream_id,
                    direction: session.shared.send_direction(),
                    byte_offset: 0,
                    payload: Bytes::new(),
                })
                .await
                .map_err(map_fabric_err_try)?;
                session.shared.note_aborted_reset_sent(stream_id).await;
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

    /// R3-P1a：closing 闸门覆盖**所有** install 路径（客户端 resume 传
    /// decision: None——此前仅 decision 分支设闸被绕过）+ 条件激活不复活
    /// Closed + reserve_stream_slot 锁内 closing 拒绝。
    #[tokio::test]
    async fn install_all_paths_rejected_while_closing_and_no_reactivation() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xA3u8; 16],
            [0xB3u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        // decision: None 路径（客户端 resume 形态）
        let (send_none, recv_none) = link.transport(1).await.into_split();
        shared
            .closing
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            shared
                .install_channel(send_none, recv_none, InstallPolicy::Force, None, None)
                .await
                .is_none(),
            "closing 中 decision:None 安装必须被拒"
        );
        // 条件激活：closing 下不得置 Active（客户端迟到恢复路径的终局防线）
        shared.set_phase_sync(SessionPhase::Recovering);
        assert!(
            !shared.complete_resume_install_checked(),
            "closing 中条件激活必须失败"
        );
        assert_eq!(shared.phase_sync(), SessionPhase::Recovering);
        // 流登记拒绝（send_open 的闸门锚点）
        assert!(
            shared.reserve_stream_slot(1).await.is_err(),
            "closing 中新流登记必须被拒"
        );
        // 对照：清旗后同路径恢复可用（合法恢复不受误拒）
        shared
            .closing
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let (send_ok, recv_ok) = link.transport(2).await.into_split();
        assert!(
            shared
                .install_channel(send_ok, recv_ok, InstallPolicy::Force, None, None)
                .await
                .is_some(),
            "非 closing 的 decision:None 安装应成功"
        );
        assert!(shared.complete_resume_install_checked(), "合法恢复激活成功");
        assert_eq!(shared.phase_sync(), SessionPhase::Active);
        // Closed 终态同样不得被条件激活复活
        shared.set_phase_sync(SessionPhase::Closed);
        assert!(
            !shared.complete_resume_install_checked(),
            "Closed 不得被复活"
        );
        assert_eq!(shared.phase_sync(), SessionPhase::Closed);
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
        assert!(
            !new_channel
                .stopping
                .load(std::sync::atomic::Ordering::SeqCst)
        );
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

    /// R6 P0/P1: an installation that times out while stopping the old channel
    /// must not consume the pending decision. The same nonce can retry from
    /// the cached decision after the old owner is gone, and only that completed
    /// second phase makes the provider Active.
    #[tokio::test]
    async fn cached_resume_retries_after_stop_timeout_and_becomes_active() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xA3u8; 16],
            [0xB3u8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        shared.set_stop_wait_timeout_for_test(std::time::Duration::from_millis(10));
        shared.set_phase(SessionPhase::Recovering).await;

        // Deliberately do not spawn this pump. It models a transport whose
        // cancellation never reaches its receive task, exercising the actual
        // stop-wait timeout branch in install_channel.
        let (old_send, old_recv) = link.transport(1).await.into_split();
        let old = shared
            .install_channel(old_send, old_recv, InstallPolicy::Force, None, None)
            .await
            .expect("old channel installs");
        let first = shared
            .decide_resume([7u8; 16], 1, &[0xB3u8; 16], [0xC3u8; 16])
            .expect("first decision");
        let (failed_send, failed_recv) = link.transport(2).await.into_split();
        assert!(
            shared
                .install_channel(
                    failed_send,
                    failed_recv,
                    InstallPolicy::Force,
                    Some(first),
                    None,
                )
                .await
                .is_none(),
            "stop timeout must reject the first candidate before RESUME_OK"
        );
        assert_eq!(shared.phase().await, SessionPhase::Recovering);

        let cached = shared
            .decide_resume([7u8; 16], 1, &[0xB3u8; 16], [0xD3u8; 16])
            .expect("same nonce reuses pending decision");
        assert!(cached.cached, "retry must use the cached result");
        old.dead.store(true, std::sync::atomic::Ordering::SeqCst);
        old.stopped_notify.notify_waiters();

        let (retry_send, retry_recv) = link.transport(3).await.into_split();
        let retry = shared
            .install_channel(
                retry_send,
                retry_recv,
                InstallPolicy::IfVacant,
                Some(cached),
                None,
            )
            .await
            .expect("cached retry installs after old channel is dead");
        retry
            .send_frame(&Frame {
                frame_type: FrameType::ResumeOk,
                flags: 0,
                session_id: shared.session_id,
                stream_id: 0,
                direction: Direction::ProviderToClient,
                byte_offset: 0,
                payload: Bytes::new(),
            })
            .await
            .expect("installed retry can send RESUME_OK");
        shared.complete_resume_install();
        assert_eq!(shared.phase().await, SessionPhase::Active);
        assert_eq!(shared.debug_channel_owner(), 2, "retry owns new channel");

        retry.request_stop();
        link.close().await;
    }

    /// R6: a failed local OPEN must release the slot it reserved so subsequent
    /// streams still get the full 128-stream budget.
    #[tokio::test]
    async fn failed_send_open_releases_reserved_stream_slot() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xA4u8; 16],
            [0xB4u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        for index in 0..(MAX_ACTIVE_STREAMS - 1) {
            shared
                .reserve_stream_slot(index as u64 * 2 + 1)
                .await
                .unwrap();
        }
        let (send, recv) = link.transport(1).await.into_split();
        let channel = shared
            .install_channel(send, recv, InstallPolicy::Force, None, None)
            .await
            .expect("channel installs");
        channel.request_stop();
        assert!(
            channel
                .send_open(255, "failed-open", Bytes::from_static(b"{}"))
                .await
                .is_err(),
            "stopped channel makes OPEN fail after reservation"
        );
        shared
            .reserve_stream_slot(257)
            .await
            .expect("failed OPEN slot is reusable");
        assert!(
            !shared.stream_keys.lock().await.contains_key(&255),
            "failed OPEN key registration rolls back"
        );
        link.close().await;
    }

    /// R6: DATA, explicit replay DATA, and FIN may not create a stream state
    /// without an OPEN reservation.
    #[tokio::test]
    async fn send_paths_reject_unknown_stream_without_creating_state() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xA5u8; 16],
            [0xB5u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let (send, recv) = link.transport(1).await.into_split();
        let channel = shared
            .install_channel(send, recv, InstallPolicy::Force, None, None)
            .await
            .expect("channel installs");
        assert!(
            channel
                .send_data(99, Bytes::from_static(b"x"))
                .await
                .is_err()
        );
        assert!(channel.finish(99).await.is_err());
        assert!(
            shared
                .record_send(99, &Bytes::from_static(b"x"))
                .await
                .is_err()
        );
        assert!(
            shared.streams.lock().await.is_empty(),
            "unknown ids add no state"
        );
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

    #[test]
    fn session_init_ok_rejects_zero_epoch_or_generation() {
        let sid = [0xA6u8; 16];
        assert!(decode_session_init_ok(&encode_session_init_ok(&sid, 1, 1)).is_some());
        assert!(
            decode_session_init_ok(&encode_session_init_ok(&sid, 0, 1)).is_none(),
            "zero accepted epoch is malformed"
        );
        assert!(
            decode_session_init_ok(&encode_session_init_ok(&sid, 1, 0)).is_none(),
            "zero generation is malformed"
        );
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
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            true,
            JournalLimits {
                max_stream_bytes: 64 * 1024,
                max_segments: 128,
                ..Default::default()
            },
        );
        let chunk = Bytes::from(vec![0u8; 32 * 1024]);
        // R6-5：record_send 不再隐式建流——测试按生产序先预占（send_open 同路径）
        shared.reserve_stream_slot(1).await.unwrap();
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
        let shared = SessionShared::new(
            [1u8; 16],
            [2u8; 16],
            "peer".into(),
            true,
            JournalLimits {
                max_session_bytes: 64 * 1024,
                max_stream_bytes: 64 * 1024,
                max_segments: 4096,
                ..Default::default()
            },
        );
        let half = Bytes::from(vec![0u8; 32 * 1024]);
        for sid in [1u64, 3, 5] {
            shared.reserve_stream_slot(sid).await.unwrap();
        }
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
        assert!(
            shared
                .record_send(5, &Bytes::from(vec![0u8; 1]))
                .await
                .is_ok()
        );
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
        sender.reserve_stream_slot(1).await.unwrap();
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
        shared.reserve_stream_slot(1).await.unwrap();
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
        assert!(
            shared
                .decide_resume([9u8; 16], 1, &[2u8; 16], [4u8; 16])
                .is_none()
        );
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

    /// R6: terminal-session churn is bounded. Once the LRU evicts the oldest
    /// tombstone, a late RESUME falls through to Missing/REQUEST_STATE_LOST;
    /// lookup never recreates a SessionShared from an evicted credential.
    #[tokio::test]
    async fn registry_tombstone_lru_evicts_to_missing_without_resurrection() {
        let reg = SessionRegistry::new();
        let limits = JournalLimits::default();
        let first_sid = [0u8; 16];
        for index in 0..=TOMBSTONE_CAP {
            let mut sid = [0u8; 16];
            sid[..8].copy_from_slice(&(index as u64).to_be_bytes());
            let mut token = [0u8; 16];
            token[..8].copy_from_slice(&(index as u64).to_be_bytes());
            let peer = format!("peer-{index}");
            assert!(matches!(
                reg.admit_init(sid, token, peer, limits).await,
                InitAdmission::Admitted(_, true)
            ));
            reg.remove_if(&sid).await;
        }
        assert_eq!(reg.inner.lock().await.tombstones.len(), TOMBSTONE_CAP);
        assert!(matches!(
            reg.lookup_resume(&first_sid).await,
            ResumeLookup::Missing
        ));
        assert!(
            reg.get(&first_sid).await.is_none(),
            "evicted credential lookup must not recreate a session"
        );
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

    /// E1′ zombie 类（2026-09-30 第六批实证）：**进程双活 + 连接心跳正常
    /// 但会话流停滞**的 Active canonical——连接级 rx 信号恒活（RawLink 的
    /// 服务端受理连接但永不发帧，QUIC ACK 照常回，udp_rx 持续增长）、
    /// is_dead 恒 false（pump 阻塞在流读盘）、QUIC 空闲超时永不触发——
    /// 唯一可判信号是流级帧静默。帧静默超窗后新 sid INIT 必须替换而非
    /// ALREADY_ACTIVE 滞留。
    #[tokio::test]
    async fn admit_replaces_frame_silent_active_canonical() {
        let _guard =
            FrameSilenceOverrideGuard::set(Some(std::time::Duration::from_millis(200))).await;
        let link = raw_link().await;
        let peer = "zombie-peer";
        let shared = std::sync::Arc::new(SessionShared::new(
            [0xA7u8; 16],
            [0xB7u8; 16],
            peer.to_owned(),
            false,
            JournalLimits::default(),
        ));
        // 通道安装（真实 iroh 连接；服务端永不发帧 = 会话流停滞）+ Active。
        // 句柄必须保活：ctl.channel 只持 Weak，Arc 释放即 current_channel=None
        //（None 在准入判定里按死通道处理）。
        let (send, recv) = link.transport(1).await.into_split();
        let _chan = shared
            .install_channel(send, recv, InstallPolicy::Force, None, None)
            .await
            .expect("channel installed");
        shared.set_phase_sync(SessionPhase::Active);
        // 注册为 peer 的 canonical
        let registry = SessionRegistry::new();
        let initiator = iroh_base::SecretKey::from_bytes(&[9u8; 32]).public();
        let (_s, is_owner) = registry
            .register_local(std::sync::Arc::clone(&shared), peer.to_owned(), initiator)
            .await;
        assert!(is_owner);
        // 连接级活性在场（ACK 流动，rx 静默 ≈ 0——zombie 的连接级伪装）；
        // canonical 就位
        assert_eq!(
            registry.canonical_sid_for_peer(peer).await,
            Some([0xA7u8; 16]),
            "canonical 就位"
        );
        // 帧静默超窗（200ms 窗，等待 300ms）
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // 新 sid INIT：必须 Replaced（不得 Canonical 拒绝）
        let incoming = iroh_base::SecretKey::from_bytes(&[8u8; 32]).public();
        match registry
            .admit_init_ordered(
                [0xA8u8; 16],
                [0xB8u8; 16],
                peer.to_owned(),
                incoming,
                JournalLimits::default(),
            )
            .await
        {
            InitAdmission::Replaced(_, old) => {
                assert_eq!(
                    old.phase_sync(),
                    SessionPhase::Dead,
                    "被替换旧 canonical 立即置 Dead"
                );
            }
            InitAdmission::Canonical(_) => {
                panic!("帧静默超窗的 Active canonical 必须被新 INIT 替换（E1′ zombie）")
            }
            _ => panic!("unexpected admission outcome"),
        }
    }

    /// 对照：新鲜通道（帧静默未超窗）的 Active canonical 仍然压制新 INIT
    ///（真并发双 INIT 收敛语义不受 E1′ 硬化影响）。
    #[tokio::test]
    async fn admit_keeps_fresh_active_canonical() {
        let _guard = FrameSilenceOverrideGuard::set(Some(std::time::Duration::from_secs(60))).await;
        let link = raw_link().await;
        let peer = "fresh-peer";
        let shared = std::sync::Arc::new(SessionShared::new(
            [0xA9u8; 16],
            [0xB9u8; 16],
            peer.to_owned(),
            false,
            JournalLimits::default(),
        ));
        let (send, recv) = link.transport(1).await.into_split();
        let _chan = shared
            .install_channel(send, recv, InstallPolicy::Force, None, None)
            .await
            .expect("channel installed");
        shared.set_phase_sync(SessionPhase::Active);
        let registry = SessionRegistry::new();
        let initiator = iroh_base::SecretKey::from_bytes(&[9u8; 32]).public();
        let (_s, is_owner) = registry
            .register_local(std::sync::Arc::clone(&shared), peer.to_owned(), initiator)
            .await;
        assert!(is_owner);
        let incoming = iroh_base::SecretKey::from_bytes(&[8u8; 32]).public();
        match registry
            .admit_init_ordered(
                [0xAAu8; 16],
                [0xBAu8; 16],
                peer.to_owned(),
                incoming,
                JournalLimits::default(),
            )
            .await
        {
            InitAdmission::Canonical(_) => {}
            _ => panic!("unexpected admission outcome"),
        }
    }

    /// 帧静默窗注入的 RAII 守卫（测试退出即恢复生产常量——全局静态不泄漏）。
    /// 同时持有互斥锁：窗注入是全局静态，zombie/对照两测试并行会互相污染
    ///（对照测试曾被 200ms 短窗泄漏误判 Replaced）。
    static FRAME_SILENCE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct FrameSilenceOverrideGuard(
        #[expect(dead_code, reason = "字段仅为持有互斥锁至 Drop；Drop 侧不读它")]
        Option<tokio::sync::MutexGuard<'static, ()>>,
    );

    impl FrameSilenceOverrideGuard {
        async fn set(value: Option<std::time::Duration>) -> Self {
            let lock = FRAME_SILENCE_TEST_LOCK.lock().await;
            set_frame_silence_for_tests(value);
            Self(Some(lock))
        }
    }

    impl Drop for FrameSilenceOverrideGuard {
        fn drop(&mut self) {
            set_frame_silence_for_tests(None);
        }
    }

    /// r12-B4：fetch 发送阶段（DATA）受单一 head 预算约束。raw_link 对端刻意
    /// 不读 bidi 流——请求体写入达 QUIC 流控窗口后阻塞（受控发送阻塞）。
    /// 修复前：阻塞的 send_data 只受内部 SEND_FRAME_TIMEOUT（5s/帧）约束，
    /// 1s 预算的 fetch 在体写上等近 5s（多块按块数放大）；修复后：head
    /// deadline 到点即时结算 + abort_stream 异步清理（终态 LocalAbort 落位
    /// ——不留已登记而未终止的 ghost 流）。
    /// （置于 session.rs 测试模块：raw_link 停滞注入 harness 在此；断言面是
    /// http.rs 的 fetch_http。）
    #[tokio::test]
    async fn fetch_head_budget_bounds_stalled_body_send() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xA5u8; 16],
            [0xB5u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let (send, recv) = link.transport(1).await.into_split();
        let chan = shared
            .install_channel(send, recv, InstallPolicy::Force, None, None)
            .await
            .expect("channel installs");
        let _pump = chan.spawn_pump();
        shared.set_phase_sync(SessionPhase::Active);
        let session = Session {
            shared: std::sync::Arc::clone(&shared),
            channel: std::sync::RwLock::new(std::sync::Arc::clone(&chan)),
            pump: std::sync::Mutex::new(None),
        };
        // 多块大体量请求体（4MiB ≫ QUIC 流控窗口）：中途必然阻塞在体写上
        let mut init =
            crate::continuity::http::HttpRequestInit::post("/stall", Bytes::from_static(b"seed"));
        init.body = (0..8)
            .map(|_| Bytes::from(vec![0x41u8; 512 * 1024]))
            .collect();
        init.head_timeout = Some(std::time::Duration::from_secs(1));

        let t0 = std::time::Instant::now();
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            crate::continuity::http::fetch_http(&session, init),
        )
        .await
        .expect("fetch 必须有限期结算（修复前体写吃满 SEND_FRAME_TIMEOUT）");
        let err = match out {
            Err(e) => e,
            Ok(_) => panic!("停滞体写下 head 预算必然耗尽"),
        };
        assert!(
            err.to_string().contains("head timeout"),
            "unexpected error: {err}"
        );
        assert!(
            t0.elapsed() < std::time::Duration::from_millis(2500),
            "整次 fetch 总时长必须受单一预算约束（实际 {:?}，预算 1s）",
            t0.elapsed()
        );
        // 清理断言：超时路径必须落 LocalAbort 终态（abort_stream 异步承接，
        // mark 先于 RESET；流不再是无终止的 ghost）
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(
            shared.stream_term(1).await,
            Some(StreamTerm::LocalAbort),
            "超时清理必须落终态（client 首个流 id = 1）"
        );
        chan.request_stop();
        link.close().await;
    }

    /// r12-B1（恢复重放面）：本端已中止（LocalAbort）的流不得重放 FIN——
    /// final_sent 已登记后 abort 落位的流，恢复轮若重放 FIN，消费端可能在
    /// RESET 处理前把 Fin 映射为干净 EOF。修复前 fin_resent_streams 无条件
    /// 收集 final_sent。RESET 补发面（aborted_streams）保持覆盖。
    #[tokio::test]
    async fn fin_resent_streams_skips_locally_aborted_streams() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xA6u8; 16],
            [0xB6u8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let (send, recv) = link.transport(1).await.into_split();
        let chan = shared
            .install_channel(send, recv, InstallPolicy::Force, None, None)
            .await
            .expect("channel installs");
        let _pump = chan.spawn_pump();
        shared.set_phase_sync(SessionPhase::Active);

        let sid = chan.open_stream("k-fin-abort").await.expect("open");
        chan.send_data(sid, Bytes::from_static(b"prefix;"))
            .await
            .expect("data");
        chan.finish(sid)
            .await
            .expect("finish（FIN 写入流控窗口内成功）");
        assert_eq!(
            shared.fin_resent_streams().await,
            vec![(sid, 7)],
            "未中止流的 FIN 仍在重放面"
        );
        // FIN 已登记（final_sent=Some）后本地中止——粘滞终态落位
        shared.abort_stream(sid).await;
        assert!(
            shared.fin_resent_streams().await.is_empty(),
            "LocalAbort 流不得重放 FIN（修复前无条件收集 final_sent）"
        );
        assert_eq!(
            shared.aborted_streams().await,
            vec![sid],
            "RESET 补发面保持覆盖"
        );
        chan.request_stop();
        link.close().await;
    }

    /// r13-P1（abort 配额）：中止流不得永久占用 128 活跃流名额——修复前
    /// `mark_local_abort` 清 final_sent 后 `quota_reapable` 恒 false，128 次
    /// 累计取消即拒绝新流。修复后错误终态即时回收配额，且 RESET 补发信息
    /// 由 aborted_registry 旁路承载（不依赖 streams entry）、journal 同步清账
    ///（不占用 session 字节预算）。
    #[tokio::test]
    async fn abort_frees_stream_quota_and_registry_carries_replay() {
        let shared = SessionShared::new(
            [0xABu8; 16],
            [0xBBu8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let count = MAX_ACTIVE_STREAMS + 12; // 140 > 128：修复前必触发上限
        let mut ids = Vec::new();
        for i in 0..count {
            let sid = (i as u64) * 2 + 1;
            shared.reserve_stream_slot(sid).await.unwrap();
            // 中止前 journal 有在途数据（未 ACK）：中止必须清账（否则 session
            // 字节预算被死流永久占用，阻塞其它流的 record_send）
            shared
                .record_send(sid, &Bytes::from_static(b"in-flight-payload"))
                .await
                .unwrap();
            shared.abort_stream(sid).await;
            ids.push(sid);
        }
        // 配额回收实证：140 次中止后新流仍可建立（修复前第 129 个预占被拒）
        shared
            .reserve_stream_slot((count as u64) * 2 + 1)
            .await
            .expect("中止流回收配额后新流预占必须放行（140 > 128）");
        // RESET 补发旁路：全部中止流仍在补发面（跨代补发承诺不破）
        assert_eq!(
            shared.aborted_streams().await,
            ids,
            "registry 覆盖全部中止流"
        );
        // journal 清账：中止流的在途数据不残留（恢复重放无源）
        for &sid in &ids {
            assert_eq!(
                shared.journal_held_bytes(sid).await,
                0,
                "中止流 journal 必须清账（sid={sid}）"
            );
        }
        assert!(
            shared.replay_batches().await.is_empty(),
            "中止流的 journal 数据不得进入恢复重放面"
        );
        // 终态语义面：本端中止后 recv 以错误终结（r12-B3 不回退）
        assert_eq!(
            shared.stream_term(ids[0]).await,
            Some(StreamTerm::LocalAbort)
        );
        assert!(shared.recv(ids[0]).await.is_err());
    }

    /// r13-B1（恢复重放受仲裁）：fin_resent_streams 快照之后到达的 abort 必须能
    /// 撤回该 FIN 的重放——`replay_fin_arbited` 在 terminal_arb 内复查快照有效
    /// 性。修复前恢复路径锁外发送快照，abort 与 FIN 重放竞速时 FIN 可先于
    /// RESET 成为可观察 EOF。对照流（未中止）的重放正常发出。
    #[tokio::test]
    async fn fin_replay_arbitration_retracts_snapshot_after_abort() {
        let link = raw_link().await;
        let shared = SessionShared::new(
            [0xACu8; 16],
            [0xBCu8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        let (send, recv) = link.transport(1).await.into_split();
        let chan = shared
            .install_channel(send, recv, InstallPolicy::Force, None, None)
            .await
            .expect("channel installs");
        let _pump = chan.spawn_pump();
        shared.set_phase_sync(SessionPhase::Active);

        // 流 A：OPEN + DATA + FIN（finish 成功——final_sent=Some(7)）
        let sid_a = chan.open_stream("k-arb-a").await.expect("open");
        chan.send_data(sid_a, Bytes::from_static(b"prefix;"))
            .await
            .expect("data");
        chan.finish(sid_a).await.expect("finish");
        // 快照先行（恢复路径的实际形态：先取快照、后逐流发送）
        let snapshot = shared.fin_resent_streams().await;
        assert_eq!(snapshot, vec![(sid_a, 7)], "中止前 FIN 在重放快照中");

        // 快照之后 abort 落位（client 半开形态：remote_final=None → 真取消，
        // final_sent 被撤回）——重放必须在发送时撤回
        shared.abort_stream(sid_a).await;
        for (stream_id, final_offset) in snapshot {
            let sent = chan
                .replay_fin_arbited(stream_id, final_offset)
                .await
                .expect("通道健康（raw_link 可写）——撤回不是发送失败");
            assert!(
                !sent,
                "快照后中止的流：FIN 重放必须被仲裁撤回（stream={stream_id}）"
            );
        }
        assert!(
            shared.fin_resent_streams().await.is_empty(),
            "中止流不在 FIN 重放面"
        );
        assert_eq!(
            shared.aborted_streams().await,
            vec![sid_a],
            "RESET 补发面承接"
        );

        // 对照流 B：未中止——仲裁重放正常发出（Ok(true)）
        let sid_b = chan.open_stream("k-arb-b").await.expect("open");
        chan.finish(sid_b).await.expect("finish");
        let sent = chan
            .replay_fin_arbited(sid_b, 0)
            .await
            .expect("对照流发送路径健康");
        assert!(sent, "未中止流的 FIN 重放必须正常发出");
        chan.request_stop();
        link.close().await;
    }

    /// r13-B1（冻结契约矩阵）：本端 FIN 已完整发出（final_sent=Some，arb 序列化
    /// 下等价 finish 成功）后的迟到 abort 裁决——
    /// - provider（本端 FIN = 响应方向，null 即消费端终局）：无论对端方向是否
    ///   终局，**无操作**（不落 LocalAbort、不清 final_sent、不发 RESET）；
    /// - client（本端 FIN = 请求方向）：响应已终局（remote_final）→ 无操作
    ///   （交换完成）；响应未终局 → **保留完整取消语义**（fetch head 超时/
    ///   取消在请求 FIN 之后的清理路径，B4 依赖）。
    #[tokio::test]
    async fn abort_after_own_fin_contract_matrix() {
        // —— provider：FIN 已发 + 对端（请求方向）已终局 → 无操作 ——
        let provider = SessionShared::new(
            [0xADu8; 16],
            [0xBDu8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        provider.reserve_stream_slot(2).await.unwrap();
        {
            let mut streams = provider.streams.lock().await;
            let ctx = streams.get_mut(&2).unwrap();
            ctx.final_sent = Some(8);
            ctx.remote_final = Some(6);
            ctx.set_term(StreamTerm::Fin);
        }
        provider.abort_stream(2).await;
        {
            let streams = provider.streams.lock().await;
            let ctx = streams.get(&2).unwrap();
            assert_eq!(ctx.term, Some(StreamTerm::Fin), "契约§1：终态不得升级");
            assert_eq!(ctx.final_sent, Some(8), "契约§1：final_sent 不得清除");
        }
        assert!(
            provider.aborted_streams().await.is_empty(),
            "契约§1：无操作不得登记 RESET 补发面"
        );
        // —— provider：FIN 已发 + 对端方向开放（keep_open/请求 FIN 丢失形态）
        //    → 仍无操作（响应 FIN 是不可撤销的既成事实）——
        provider.reserve_stream_slot(4).await.unwrap();
        {
            let mut streams = provider.streams.lock().await;
            let ctx = streams.get_mut(&4).unwrap();
            ctx.final_sent = Some(3);
        }
        provider.abort_stream(4).await;
        {
            let streams = provider.streams.lock().await;
            let ctx = streams.get(&4).unwrap();
            assert_eq!(ctx.term, None, "契约§1（半开形态）：终态不得落位");
            assert_eq!(ctx.final_sent, Some(3), "契约§1（半开形态）：FIN 面保留");
        }

        // —— client：FIN（请求方向）已发 + 响应已终局 → 无操作（交换完成）——
        let client = SessionShared::new(
            [0xAEu8; 16],
            [0xBEu8; 16],
            "peer".into(),
            true,
            JournalLimits::default(),
        );
        client.reserve_stream_slot(1).await.unwrap();
        {
            let mut streams = client.streams.lock().await;
            let ctx = streams.get_mut(&1).unwrap();
            ctx.final_sent = Some(5);
            ctx.remote_final = Some(9);
            ctx.set_term(StreamTerm::Fin);
        }
        client.abort_stream(1).await;
        {
            let streams = client.streams.lock().await;
            let ctx = streams.get(&1).unwrap();
            assert_eq!(ctx.term, Some(StreamTerm::Fin), "契约§2a：交换完成后无操作");
            assert_eq!(ctx.final_sent, Some(5), "契约§2a：FIN 面保留");
        }
        // —— client：FIN（请求方向）已发 + 响应未终局 → 完整取消（B4 语义）——
        client.reserve_stream_slot(3).await.unwrap();
        client
            .record_send(3, &Bytes::from_static(b"req-body;"))
            .await
            .unwrap();
        {
            let mut streams = client.streams.lock().await;
            let ctx = streams.get_mut(&3).unwrap();
            ctx.final_sent = Some(9);
        }
        client.abort_stream(3).await;
        {
            let streams = client.streams.lock().await;
            let ctx = streams.get(&3).unwrap();
            assert_eq!(
                ctx.term,
                Some(StreamTerm::LocalAbort),
                "契约§2b：半开形态保留完整取消语义"
            );
            assert_eq!(ctx.final_sent, None, "契约§2b：FIN 重放面撤回");
        }
        assert_eq!(
            client.aborted_streams().await,
            vec![3],
            "契约§2b：RESET 补发"
        );
        assert_eq!(
            client.journal_held_bytes(3).await,
            0,
            "契约§2b：journal 清账"
        );
    }

    /// r13-B4③（取消重排闸门）：RESET 先于 OPEN 到达（OPEN 发送排队/竞速窗口内
    /// 调用方取消）——修复前未知流的 RESET 被违规丢弃，随后到达的 OPEN 仍触发
    /// dispatch（副作用闸门 http.rs 的 peer_reset 复查覆盖不到「从未建流」的
    /// 形态）。修复后：RESET 记 tombstone（非违规），同 id OPEN 按已取消收敛
    /// ——不入 arrivals（handler 零启动）、终态 PeerReset、Completed 收敛。
    #[tokio::test]
    async fn reset_before_open_tombstone_blocks_dispatch() {
        let shared = SessionShared::new(
            [0xAFu8; 16],
            [0xBFu8; 16],
            "peer".into(),
            false,
            JournalLimits::default(),
        );
        let sid = [0xAFu8; 16];
        // 1) 未知流的 RESET：tombstone 而非违规计数
        let reset = mk_reset(sid, 7, Direction::ClientToProvider);
        let out = shared.handle_frame(&reset).await;
        assert!(
            out.reply.is_none() && out.new_open.is_none(),
            "未知流 RESET 无立即副作用"
        );
        assert_eq!(
            shared.protocol_violations(),
            0,
            "取消重排不是协议违例（修复前违规计数）"
        );
        // 2) 迟到的同 id OPEN：按已取消收敛，不产生 arrival
        let open = shared.handle_frame(&open_frame(sid, 7)).await;
        assert_eq!(
            open.new_open, None,
            "tombstone 命中的 OPEN 不得入 arrivals（handler 零启动）"
        );
        assert_eq!(
            shared.stream_term(7).await,
            Some(StreamTerm::PeerReset),
            "取消流终态：对端已取消"
        );
        assert!(shared.peer_reset(7).await, "peer_reset 止付标志置位");
        assert_eq!(
            shared.request_state(7).await,
            Some(RequestState::Completed),
            "watcher 终裁收敛（Completed）"
        );
        // 3) 对照：无 tombstone 的 OPEN 正常入 arrivals（闸门不误伤新流）
        let control = shared.handle_frame(&open_frame(sid, 9)).await;
        assert_eq!(control.new_open, Some(9), "正常 OPEN 不受 tombstone 影响");
        assert_eq!(
            shared.protocol_violations(),
            0,
            "全程无违规（tombstone 消耗性命中）"
        );
        // 4) tombstone 已消耗：同 id 再 OPEN（幂等重发）走既有归并路径
        let dup = shared.handle_frame(&open_frame(sid, 9)).await;
        assert_eq!(dup.new_open, None, "重复 OPEN 幂等归并（不重复 dispatch）");
    }
}
