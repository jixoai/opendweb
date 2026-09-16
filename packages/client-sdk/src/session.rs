//! continuity 会话句柄 N-API（app-protocol-layer Phase 3 task 4.2，
//! design §3.2/§3.3）。
//!
//! 正交意图（2026-09-16，app-protocol-layer task 4.2）：
//! 1. SessionHandle 状态面：state()/onState()/close()（§3.2 快照对齐子集）
//! 2. auto-resume 驱动（§3.3 adapter 职责）：watch phase==Recovering →
//!    session.resume(fabric)——SSE 断线续传对 JS 透明的关键
//! 3. continuity 连接快照透传（Phase 1 task 2.3 补课投影，§3.1）
//! 4. fetchHttp 挂点（实现在 http.rs 的类型上；本 impl 只承载方法归属）
//!
//! 事件桥沿用 Fabric.on 约定：TSFN 以 JSON 字符串投递（对象转换在
//! napi 3.x 不稳定），index.js 包装为类型化回调 + 取消订阅函数。

use dweb_fabric::continuity::session::{Session, SessionPhase};
use dweb_fabric::continuity::state::{ConnectionPhase, ConnectionStateSnapshot};
use dweb_fabric::{Fabric as RustFabric, FabricError};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::fabric::link_status_str;
use crate::http::FetchHttpInit;

type StateCallbacks = Arc<Mutex<Vec<(u64, ThreadsafeFunction<String>)>>>;

/// 恢复窗口（Q4 推荐默认 90s；内核 deadline 观测未实现——由本 adapter 强制：
/// 窗口耗尽即 close() 有界失败，不无限重试）。
const RECOVERY_WINDOW: Duration = Duration::from_secs(90);
/// 状态泵/resume 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// resume 失败轮次间隔（防快速失败热自旋）。
const RESUME_ROUND_GAP: Duration = Duration::from_secs(1);

pub(crate) fn phase_str(p: SessionPhase) -> &'static str {
    match p {
        SessionPhase::Negotiating => "negotiating",
        SessionPhase::Active => "active",
        SessionPhase::Recovering => "recovering",
        SessionPhase::Dead => "dead",
        SessionPhase::Closed => "closed",
    }
}

pub(crate) fn conn_phase_str(p: ConnectionPhase) -> &'static str {
    match p {
        ConnectionPhase::Disconnected => "disconnected",
        ConnectionPhase::Connecting => "connecting",
        ConnectionPhase::Handshaking => "handshaking",
        ConnectionPhase::Ready => "ready",
        ConnectionPhase::Closing => "closing",
    }
}

/// session/http 层错误统一映射：`[session]` 前缀（内核 HttpEngineError 已保证
/// 固定掩码——不泄 peer/路径，透传）；其余沿用 fabric_err 冻结前缀集。
pub(crate) fn session_err(e: FabricError) -> Error {
    if matches!(&e, FabricError::Session(_)) {
        Error::new(Status::GenericFailure, format!("[session] {e}"))
    } else {
        crate::fabric_err(e)
    }
}

/// 会话状态快照（design §3.2 对齐子集）。
/// activeEpoch/lastAckAtMs/deadlineAtMs：内核观测未实现，本阶段不投影
/// （不冒充）——随 Phase 4 记账面（task 5.2）补齐。
#[napi(object)]
pub struct SessionStateSnapshotJs {
    pub peer_id: String,
    /// 会话 id（hex，128bit → 32 字符）
    pub session_id: String,
    /// "negotiating" | "active" | "recovering" | "dead" | "closed"
    pub phase: String,
    pub stream_count: u32,
    /// 全部流 journal 持有字节总和（发送侧反压水位观测）
    pub journal_bytes: f64,
}

/// continuity 连接状态快照（design §3.1；Phase 1 task 2.3 补课投影）。
/// epoch/stateSeq 按 napi 习惯映射为 number（工作区 napi 特性集为 napi4——
/// BigInt 需 napi6；f64 精确到 2^53，epoch/seq 单调计数远不及）。
#[napi(object)]
pub struct ConnectionStateSnapshotJs {
    pub peer_id: String,
    /// "disconnected" | "connecting" | "handshaking" | "ready" | "closing"
    pub phase: String,
    /// 当前已采纳连接代次；0 = 尚无
    pub epoch: f64,
    /// 快照单调序号（跳变检测）
    pub state_seq: f64,
    /// "direct" | "relay" | "unknown"
    pub path: String,
    pub changed_at_ms: f64,
    pub reason: Option<String>,
}

impl From<ConnectionStateSnapshot> for ConnectionStateSnapshotJs {
    fn from(s: ConnectionStateSnapshot) -> Self {
        Self {
            peer_id: s.peer_id,
            phase: conn_phase_str(s.phase).to_owned(),
            epoch: s.epoch as f64,
            state_seq: s.state_seq as f64,
            path: link_status_str(s.path).to_owned(),
            changed_at_ms: s.changed_at_ms as f64,
            reason: s.reason,
        }
    }
}

async fn snapshot_of(session: &Session) -> SessionStateSnapshotJs {
    let shared = session.shared();
    SessionStateSnapshotJs {
        peer_id: shared.peer_id.clone(),
        session_id: hex::encode(shared.session_id),
        phase: phase_str(session.phase().await).to_owned(),
        stream_count: shared.stream_count().await as u32,
        journal_bytes: shared.journal_bytes_total().await as f64,
    }
}

/// continuity 会话句柄（design §3.3；唯一创建入口 Fabric.openSession）。
/// 内建 auto-resume 驱动——断线续传对 JS 透明；close() 走 Session 层
/// Shutdown 语义（置 Closed + abort pump + 停驱动）。
#[napi]
pub struct SessionHandle {
    pub(crate) session: Arc<Session>,
    driver: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    state_callbacks: StateCallbacks,
    next_cb_id: std::sync::atomic::AtomicU64,
    closed: Arc<std::sync::atomic::AtomicBool>,
}

impl SessionHandle {
    pub(crate) fn new(session: Session, fabric: RustFabric) -> Self {
        let session = Arc::new(session);
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let state_callbacks: StateCallbacks = Arc::new(Mutex::new(Vec::new()));
        let driver = spawn_session_driver(
            Arc::clone(&session),
            fabric,
            closed.clone(),
            Arc::clone(&state_callbacks),
        );
        Self {
            session,
            driver: std::sync::Mutex::new(Some(driver)),
            state_callbacks,
            next_cb_id: std::sync::atomic::AtomicU64::new(1),
            closed,
        }
    }
}

#[napi]
impl SessionHandle {
    /// 对端 EndpointId（z32）
    #[napi(getter)]
    pub fn peer_id(&self) -> String {
        self.session.shared().peer_id.clone()
    }

    /// 会话 id（hex，128bit）
    #[napi(getter)]
    pub fn session_id(&self) -> String {
        hex::encode(self.session.shared().session_id)
    }

    /// 会话状态快照（§3.2 对齐子集；snapshot 优先——onState 只承载跳变）。
    #[napi]
    pub async fn state(&self) -> Result<SessionStateSnapshotJs> {
        Ok(snapshot_of(&self.session).await)
    }

    /// 订阅状态变化（native 返回回调 id；index.js 包装为取消订阅函数；
    /// payload 为 §3.2 快照同构 JSON）。
    #[napi]
    pub fn on_state(&self, callback: ThreadsafeFunction<String>) -> u32 {
        let id = self
            .next_cb_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst) as u32;
        self.state_callbacks.blocking_lock().push((id as u64, callback));
        id
    }

    /// 注销状态回调（onState 返回的 id）。
    #[napi]
    pub fn off_state(&self, id: u32) {
        let mut guard = self.state_callbacks.blocking_lock();
        if let Some(pos) = guard.iter().position(|(cid, _)| *cid == id as u64) {
            guard.remove(pos);
        }
    }

    /// 显式关闭（幂等）：置 Closed + abort pump + 停 auto-resume 驱动。
    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(d) = self.driver.lock().unwrap().take() {
            d.abort();
        }
        self.session.close().await;
        Ok(())
    }

    /// （内部面 /net/internals）单流 journal 持有字节（观测；streamId 来自
    /// 响应/内部面的逻辑流 id）。
    #[napi]
    pub async fn journal_bytes(&self, stream_id: f64) -> Result<f64> {
        if stream_id < 0.0 || stream_id.fract() != 0.0 {
            return Err(Error::new(
                Status::GenericFailure,
                "streamId must be a non-negative integer",
            ));
        }
        Ok(self.session.shared().journal_held_bytes(stream_id as u64).await as f64)
    }

    /// fetchHttp：发起 HTTP 请求（§3.4；本阶段静态 body 分块；响应 body 为
    /// pull-first——bodyNext() 逐块拉取，EOF = null）。§3.4 规范签名（自由
    /// 函数形态）见 /http 子路径胶水。
    #[napi]
    pub async fn fetch_http(
        &self,
        init: FetchHttpInit,
    ) -> Result<crate::http::HttpClientResponseJs> {
        crate::http::fetch_http(&self.session, init).await
    }
}

/// auto-resume + 状态事件驱动（§3.3 adapter 职责核心）：
/// - 轮询 phase：变化即向 onState 订阅者投递快照 JSON（TSFN NonBlocking）
/// - Recovering：session.resume(fabric)（内核内建收敛重试；RESUME_REJECT
///   终局 → phase Dead → 驱动退出）
/// - 恢复窗口 90s（Q4）：耗尽即 close() 有界失败（内核 deadline 观测未实现，
///   deadlineAtMs 不冒充）
/// - Dead/Closed：终局退出
fn spawn_session_driver(
    session: Arc<Session>,
    fabric: RustFabric,
    closed: Arc<std::sync::atomic::AtomicBool>,
    callbacks: StateCallbacks,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_phase = session.phase().await;
        let mut recovering_since: Option<tokio::time::Instant> = None;
        loop {
            if closed.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let phase = session.phase().await;
            if phase != last_phase {
                last_phase = phase;
                recovering_since = (phase == SessionPhase::Recovering)
                    .then(tokio::time::Instant::now);
                emit_state(&session, &callbacks).await;
            }
            match phase {
                SessionPhase::Recovering => {
                    let since = recovering_since.get_or_insert_with(tokio::time::Instant::now);
                    if since.elapsed() >= RECOVERY_WINDOW {
                        // 恢复窗口耗尽：有界失败（bodyNext 竞速检测 Closed 报错）
                        session.close().await;
                        emit_state(&session, &callbacks).await;
                        return;
                    }
                    // resume 内建收敛重试；失败轮次间隔防热自旋（成功即续跑）
                    if session.resume(&fabric).await.is_err() {
                        tokio::time::sleep(RESUME_ROUND_GAP).await;
                    }
                    // 归来重评 phase（Active/Dead/仍 Recovering）
                    continue;
                }
                SessionPhase::Dead | SessionPhase::Closed => return,
                _ => {}
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    })
}

/// 驱动侧事件投递：快照序列化为 JSON（camelCase 键），逐订阅者 TSFN 信号。
async fn emit_state(session: &Arc<Session>, callbacks: &StateCallbacks) {
    let snap = snapshot_of(session).await;
    let payload = serde_json::json!({
        "type": "state",
        "peerId": snap.peer_id,
        "sessionId": snap.session_id,
        "phase": snap.phase,
        "streamCount": snap.stream_count,
        "journalBytes": snap.journal_bytes,
    });
    let Ok(json) = serde_json::to_string(&payload) else {
        return;
    };
    for (_id, cb) in callbacks.lock().await.iter() {
        cb.call(Ok(json.clone()), ThreadsafeFunctionCallMode::NonBlocking);
    }
}
