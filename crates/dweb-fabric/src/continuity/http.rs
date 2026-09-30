//! HTTP/WS 引擎（app-protocol-layer Phase 3 task 4.1）——架在 Session
//! continuity 层上的应用协议投影（design §2.4/§3.3/§3.4 的 Rust 内核面）。
//!
//! 投影契约（与 wire 冻结面一致，不新增帧类型）：
//! - 请求：OPEN payload = 元数据 JSON（§2.4：requestId/idempotencyKey/
//!   method/path/headers/bodyLength/contentType）；请求体 = DATA（C→P）；
//!   非隧道请求 FIN 半关。
//! - 响应：P→C 字节流 = `{meta JSON}\n` 首行（status/headers）+ body 字节；
//!   FIN 半关。断线续传由 Session 层字节级承接——meta 行与 body 同流，
//!   恢复后无需特殊处理。
//! - WS 隧道：`keep_open` 请求（不 FIN 请求方向）+ 101 响应（不 FIN 响应
//!   方向）→ 逻辑流成为双向字节隧道；RFC6455 帧为端到端不透明载荷，
//!   整消息重组在 SDK 层（§3.4 WsMessage ABI，task 4.2）。
//!
//! 副作用闸门（§2.8）：引擎调 handler 前落 STARTED；恢复轮（已 STARTED/
//! COMPLETED）跳过 dispatch——响应重放由协议层完成，上游**不重执行**。

use std::sync::Arc;

use bytes::Bytes;
use serde_json::{Value, json};

use crate::fabric::{Fabric, FabricError};
use crate::session::SessionError;

use super::session::{
    RequestState, Session, SessionChannel, SessionOptions, SessionShared, StreamTerm, accept_any,
};

/// HTTP 头（数组形态保重复项，§3.4）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub name: String,
    pub value: String,
}

impl Header {
    pub fn new(name: &str, value: &str) -> Self {
        Self {
            name: name.to_string(),
            value: value.to_string(),
        }
    }
}

/// 引擎层错误（对端/路径信息不外泄——固定掩码面）。
#[derive(Debug, thiserror::Error)]
#[error("http engine: {0}")]
pub struct HttpEngineError(pub String);

impl From<HttpEngineError> for FabricError {
    fn from(e: HttpEngineError) -> Self {
        FabricError::Session(SessionError::Connect(e.0))
    }
}

type BoxHttpFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<HttpResponse, HttpEngineError>> + Send>,
>;

/// handler trait（object-safe；N-API 层在 task 4.2 适配 TS handler）。
pub trait HttpHandler: Send + Sync + 'static {
    fn handle(&self, request: HttpRequest) -> BoxHttpFuture;
}

/// 请求体读取面（DATA 帧投影；EOF = 对端 FIN/RESET）。
#[derive(Clone)]
pub struct RequestBody {
    shared: Arc<SessionShared>,
    stream_id: u64,
}

impl RequestBody {
    /// 会话共享核（N-API 桥终态竞速/观测用，task 4.2）。
    pub fn shared(&self) -> &Arc<SessionShared> {
        &self.shared
    }

    /// 逻辑流 id（r11-B2：N-API 桥终态分类查询面）。
    pub fn stream_id(&self) -> u64 {
        self.stream_id
    }

    pub async fn recv(&self) -> Result<Bytes, FabricError> {
        self.shared
            .recv(self.stream_id)
            .await
            .map_err(FabricError::Session)
    }

    /// 读至 EOF 聚合（测试/非流式便利面）。r11-B3：异常终止（RESET/协议错误/
    /// 本端中止/会话丢失）必须返回 Err——已有前缀不得伪装完整实体；只有干净
    /// FIN（对端半关且队列排空）才是成功 EOF。
    pub async fn read_all(&self) -> Result<Vec<u8>, FabricError> {
        let mut out = Vec::new();
        loop {
            match self.recv().await {
                Ok(c) => out.extend_from_slice(&c),
                Err(_) => {
                    return match self.shared.stream_term(self.stream_id).await {
                        Some(StreamTerm::Fin) => Ok(out),
                        _ => Err(FabricError::Session(SessionError::Connect(
                            "request body terminated abnormally".into(),
                        ))),
                    };
                }
            }
        }
    }

    /// 取消观察句柄（与请求体同生命周期；N-API 桥 watcher 用）。
    pub fn cancel(&self) -> RequestCancel {
        RequestCancel::new(Arc::clone(&self.shared), self.stream_id)
    }

    /// 所属逻辑会话 id（授权隔离键）。
    pub fn session_id(&self) -> [u8; 16] {
        self.shared.session_id
    }
}

/// 请求取消终裁结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    /// 对端 RESET / 会话终态遗弃：上游应尽快收敛（未消费副作用止损）。
    Cancelled,
    /// 请求已正常完成（FIN 送达且 dispatch 标记 Completed）：非取消。
    Completed,
}

/// 请求取消观察句柄：挂起等「对端不再需要本请求」。
/// 事件驱动（peer_reset 持久标志 + reset_notify 唤醒 + request_state/phase
/// 终裁）；phase 终态无专属唤醒面，以有界轮询佐餐（终态出口保证退出）。
#[derive(Clone)]
pub struct RequestCancel {
    shared: Arc<SessionShared>,
    stream_id: u64,
}

impl RequestCancel {
    fn new(shared: Arc<SessionShared>, stream_id: u64) -> Self {
        Self { shared, stream_id }
    }

    /// 会话 id（hex；授权隔离键——同 peer 异 session 不共享，spec §3.2）。
    pub fn session_id_hex(&self) -> String {
        self.shared
            .session_id
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// 挂起等待终裁。取消复查在完成复查之前——FIN 与 RESET 竞速时宁可
    /// 多发一次取消（对已结束请求的 signal abort 幂等无害）也不漏发
    /// （漏发 = 挂起任务永不停止）。Notify 不保留通知：标志复查兜底
    /// 注册窗口。
    pub async fn wait(&self) -> CancelOutcome {
        loop {
            if self.shared.peer_reset(self.stream_id).await {
                return CancelOutcome::Cancelled;
            }
            if matches!(
                self.shared.request_state(self.stream_id).await,
                Some(RequestState::Completed)
            ) {
                return CancelOutcome::Completed;
            }
            match self.shared.phase().await {
                super::session::SessionPhase::Dead | super::session::SessionPhase::Closed => {
                    return CancelOutcome::Cancelled;
                }
                _ => {}
            }
            tokio::select! {
                _ = self.shared.reset_notify.notified() => continue,
                _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => continue,
            }
        }
    }
}

/// handler 收到的请求（§3.4 Rust 形态）。
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<Header>,
    pub body: RequestBody,
    pub stream_id: u64,
    /// 所属逻辑会话（授权隔离键；内核本地协商事实，非 wire 字段）。
    pub session_id: [u8; 16],
    /// 取消观察句柄（挂起 handler 的秒停通路）。
    pub cancel: RequestCancel,
}

/// handler 返回的响应；body 为 mpsc 流（SSE 长流逐块供给；None = 无 body）。
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<Header>,
    pub body: Option<tokio::sync::mpsc::Receiver<Bytes>>,
}

// ---------------------------------------------------------------------------
// client：fetch_http
// ---------------------------------------------------------------------------

/// 请求初始化（Rust 侧静态 body；TS 侧 AsyncIterable 由 N-API 层投影）。
pub struct HttpRequestInit {
    pub method: String,
    pub path: String,
    pub headers: Vec<Header>,
    pub body: Vec<Bytes>,
    /// WS 隧道模式：不半关请求方向（101 后双向持续）。
    pub keep_open: bool,
    /// head 操作单一预算（毫秒；默认 30s——长轮询/慢上游按需放宽）。预算
    /// 覆盖整次 head 操作：活性闸门 + OPEN + 请求体逐块发送 + FIN + 响应头
    /// 等待（r12-B4 冻结语义——非仅「响应头等待上限」）。
    pub head_timeout: Option<std::time::Duration>,
    /// 外部取消开关（SDK 注入：JS AbortSignal → fire；head 等待期即时
    /// RESET——消费端取消的对称面，provider 侧为 req.signal）。
    pub cancel: Option<Arc<FetchCancel>>,
}

/// fetch 侧外部取消开关：fire 置位 + 唤醒（flag 兜底 Notify 注册窗口）。
#[derive(Default)]
pub struct FetchCancel {
    fired: std::sync::atomic::AtomicBool,
    notify: tokio::sync::Notify,
}

impl FetchCancel {
    pub fn fire(&self) {
        self.fired.store(true, std::sync::atomic::Ordering::Release);
        self.notify.notify_waiters();
    }

    fn fired(&self) -> bool {
        self.fired.load(std::sync::atomic::Ordering::Acquire)
    }
}

impl HttpRequestInit {
    pub fn get(path: &str) -> Self {
        Self {
            method: "GET".into(),
            path: path.into(),
            headers: Vec::new(),
            body: Vec::new(),
            keep_open: false,
            head_timeout: None,
            cancel: None,
        }
    }

    pub fn post(path: &str, body: Bytes) -> Self {
        Self {
            method: "POST".into(),
            path: path.into(),
            headers: vec![Header::new("content-type", "application/json")],
            body: vec![body],
            keep_open: false,
            head_timeout: None,
            cancel: None,
        }
    }
}

/// 响应面：meta 已剥；body 经 recv_body 逐块（EOF = Err）。
/// WS 模式（status==101）可继续 send_tunnel 双向读写。
pub struct HttpClientResponse {
    pub status: u16,
    pub headers: Vec<Header>,
    pub stream_id: u64,
    /// Session view rather than a fixed channel. `Session::channel()` resolves
    /// the current owner after a resume, so an in-flight WS/HTTP response does
    /// not write into a dead transport generation.
    session: Session,
    buf: Option<Bytes>,
}

impl HttpClientResponse {
    /// 读下一块 body（首块 = meta 行后的剩余字节）。
    pub async fn recv_body(&mut self) -> Result<Bytes, FabricError> {
        if let Some(b) = self.buf.take()
            && !b.is_empty()
        {
            return Ok(b);
        }
        self.session.channel().recv(self.stream_id).await
    }

    /// 读至 EOF 聚合。r11-B3：异常终止（RESET/协议错误/本端中止/会话丢失）
    /// 必须返回 Err——已有前缀不得伪装完整实体；只有干净 FIN 才是成功 EOF。
    pub async fn read_all_body(&mut self) -> Result<Vec<u8>, FabricError> {
        let mut out = Vec::new();
        loop {
            match self.recv_body().await {
                Ok(c) => out.extend_from_slice(&c),
                Err(_) => {
                    return match self.session.shared().stream_term(self.stream_id).await {
                        Some(StreamTerm::Fin) => Ok(out),
                        _ => Err(FabricError::Session(SessionError::Connect(
                            "response body terminated abnormally".into(),
                        ))),
                    };
                }
            }
        }
    }

    /// WS 隧道：client→provider 方向继续写（keep_open 请求专用）。
    pub async fn send_tunnel(&self, data: Bytes) -> Result<(), FabricError> {
        self.session.channel().send_data(self.stream_id, data).await
    }

    /// per-request 取消：向对端发 RESET（serve 响应循环止付、流式供给面随
    /// Drop 关闭——上游 handler 提前收敛）。r11-B1：终态先于动作落位（跨恢复
    /// 代保留）——RESET 发送失败由恢复重放补发，对端以错误而非干净 EOF 收敛。
    /// 幂等语义由调用方（SDK）标志位保证。
    pub async fn abort(&self) {
        self.session.shared().abort_stream(self.stream_id).await;
    }
}

/// fetch 发送阶段失败的本地结算。终态与 journal 清账必须在调用方看到 Err
/// 前完成；RESET 的 wire 发送仍放到独立任务，避免关闭阶段把错误返回拖到
/// 网络重试窗口。取消/预算打断会先退役当前通道，让在途帧停在完整帧边界。
async fn settle_abort_cleanup(channel: &Arc<SessionChannel>, stream_id: u64, retire_channel: bool) {
    if retire_channel {
        channel.request_stop();
    }
    let shared = Arc::clone(channel.shared());
    let needs_reset = shared.settle_local_abort(stream_id).await;
    if needs_reset {
        tokio::spawn(async move {
            shared.send_reset(stream_id).await;
        });
    }
}

/// 发起 HTTP 请求（请求方向默认 FIN；keep_open 隧道不关）。
/// meta 行到达前有界等待（响应头即首块）。
/// r11-B4 + r12-B4：整次 head 操作（活性闸门 + OPEN + 每个 DATA + FIN +
/// 头等待）共享**单一 deadline**——发送 await 同受预算约束（spawn 后有界
/// 观察，不丢弃在途发送）；外部取消在每一阶段线性化检查（活性等待 select
/// 即时唤醒、OPEN 前零副作用拦截、体写逐块复查）。
pub async fn fetch_http(
    session: &Session,
    init: HttpRequestInit,
) -> Result<HttpClientResponse, FabricError> {
    let head_timeout = init
        .head_timeout
        .unwrap_or(std::time::Duration::from_secs(30));
    let head_deadline = tokio::time::Instant::now() + head_timeout;
    let head_timeout_err =
        || FabricError::Session(SessionError::Connect("response head timeout".into()));
    let cancelled_err =
        || FabricError::Session(SessionError::Connect("response head cancelled".into()));
    // 外部取消（SDK AbortSignal）：flag 复查 + notify 唤醒双面（Notify 不保留
    // 许可——注册窗口由各阶段的 fired() 线性化检查闭合）。无开关时恒挂起。
    let cancel_fired = || init.cancel.as_ref().is_some_and(|c| c.fired());
    let cancel_fut = async {
        match &init.cancel {
            Some(c) => c.notify.notified().await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(cancel_fut);
    // 活性通道闸门（真双机实证 2026-09-30：LAN 连接周期性颤动 → 会话 Recovering
    // → 死通道上 open_stream 立即失败 → 消费端 fetch 502/空响应抖动）。与
    // open_session 的 wait_for_existing_session 活性闸门同源：死通道按无通道
    // 处理——Recovering 期间等 auto-resume 安装新代（有界=head 预算共享），
    // 终态（Dead/Closed）立即失败；r11-B4：等待循环 select 外部取消。
    let channel = loop {
        let ch = session.channel();
        if !ch.is_dead() {
            break ch;
        }
        if matches!(
            session.phase().await,
            super::session::SessionPhase::Dead | super::session::SessionPhase::Closed
        ) {
            return Err(FabricError::Session(SessionError::Connect(
                "session dead/closed".into(),
            )));
        }
        if cancel_fired() {
            return Err(cancelled_err());
        }
        if tokio::time::Instant::now() >= head_deadline {
            return Err(head_timeout_err());
        }
        tokio::select! {
            _ = &mut cancel_fut => return Err(cancelled_err()),
            _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => continue,
        }
    };
    // r11-B4：OPEN 前线性化取消检查——取消必须先于任何请求副作用（对端
    // handler 零启动；此时无流 id，无需 RESET）。
    if cancel_fired() {
        return Err(cancelled_err());
    }
    let idem = hex16(
        &super::session::rand_16().ok_or_else(|| HttpEngineError("entropy unavailable".into()))?,
    );
    let body_len: usize = init.body.iter().map(|b| b.len()).sum();
    // OPEN payload = §2.4 元数据全量（requestId 在 open_stream_raw 内由流 id 决定）
    let meta = json!({
        "idempotencyKey": idem,
        "method": init.method,
        "path": init.path,
        "headers": init.headers.iter().map(|h| json!({"name": h.name, "value": h.value})).collect::<Vec<_>>(),
        "bodyLength": body_len,
        "contentType": init
            .headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("content-type"))
            .map(|h| h.value.clone())
            .unwrap_or_default(),
    });
    // r12-B4：OPEN/每个 DATA/FIN 的 await 全部纳入同一 head 预算 + 外部取消
    // 竞速。发送 future **不得在 select 中丢弃**——中途丢弃 write_all 会把半
    // 帧留上 wire（撕裂帧边界 = 杀死健康通道，仅通道退役路径可承受）；改为
    // spawn 后有界观察：超时/取消即时结算返回，在途帧继续完整写出（内部
    // SEND_FRAME_TIMEOUT 自界），随后 abort_stream 的 RESET 经发送互斥锁
    // 串行于在途帧之后——provider 在途请求止付，不留 ghost OPEN。
    enum PhaseFail {
        Cancel,
        Deadline,
        Op(FabricError),
        Join(tokio::task::JoinError),
    }
    macro_rules! guard_send {
        ($task:expr) => {
            tokio::select! {
                r = &mut $task => match r {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(PhaseFail::Op(e)),
                    Err(j) => Some(PhaseFail::Join(j)),
                },
                _ = &mut cancel_fut => Some(PhaseFail::Cancel),
                _ = tokio::time::sleep_until(head_deadline) => Some(PhaseFail::Deadline),
            }
        };
    }
    let stream_id = channel.alloc_stream();
    // 名额预占先于 OPEN 发送：超时/取消清理的终态落位（mark_local_abort）
    // 不与 OPEN 登记竞速（mark 先于登记会静默丢失）。
    channel.shared().reserve_stream_slot(stream_id).await?;
    {
        let chan = Arc::clone(&channel);
        let idem_key = idem.clone();
        let open_payload = Bytes::from(meta.to_string());
        let mut open_task =
            tokio::spawn(async move { chan.send_open(stream_id, &idem_key, open_payload).await });
        if let Some(f) = guard_send!(open_task) {
            return Err(match f {
                // r13-B4：Op/Join 失败同样走 abort 清理（终态落位 + RESET——
                // Join 分支的 task 未及回滚，预留 entry 必须终结；Op 分支的
                // rollback 已撤 entry 时 abort 为静默无操作）。
                PhaseFail::Op(e) => {
                    settle_abort_cleanup(&channel, stream_id, false).await;
                    e
                }
                PhaseFail::Join(j) => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    FabricError::Session(SessionError::Connect(format!("open task join: {j}")))
                }
                PhaseFail::Cancel => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    cancelled_err()
                }
                PhaseFail::Deadline => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    head_timeout_err()
                }
            });
        }
    }
    // r11-B4：请求体逐块 + FIN 前取消复查——此时请求已可见于对端，取消须
    // 走 abort_stream（终态落位 + RESET：provider 侧在途请求止付收敛）。
    // r12-B4：每个 DATA/FIN 的 await 同受单一 head 预算约束（spawn + 有界
    // 观察，见上方 OPEN 注释）。
    for chunk in init.body {
        if cancel_fired() {
            settle_abort_cleanup(&channel, stream_id, true).await;
            return Err(cancelled_err());
        }
        let mut send_task = {
            let chan = Arc::clone(&channel);
            tokio::spawn(async move { chan.send_data(stream_id, chunk).await })
        };
        if let Some(f) = guard_send!(send_task) {
            return Err(match f {
                // r13-B4：DATA 发送失败（Op）必须走 abort 清理——send_data 先写
                // journal 再发送，失败后 journal 里的数据若不随终态清账，会在
                // 恢复轮重放、再次驱动对端请求/副作用。
                PhaseFail::Op(e) => {
                    settle_abort_cleanup(&channel, stream_id, false).await;
                    e
                }
                PhaseFail::Join(j) => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    FabricError::Session(SessionError::Connect(format!("send task join: {j}")))
                }
                PhaseFail::Cancel => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    cancelled_err()
                }
                PhaseFail::Deadline => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    head_timeout_err()
                }
            });
        }
    }
    if !init.keep_open {
        if cancel_fired() {
            settle_abort_cleanup(&channel, stream_id, true).await;
            return Err(cancelled_err());
        }
        let mut fin_task = {
            let chan = Arc::clone(&channel);
            tokio::spawn(async move { chan.finish(stream_id).await })
        };
        if let Some(f) = guard_send!(fin_task) {
            return Err(match f {
                // r13-B4：FIN 发送失败（Op——finish 已自撤 final_sent）同样落
                // 终态 + RESET：调用方已拿到错误，该流不得以未终结形态残留
                // 到恢复轮（FIN 重发/重放不再有调用方语义）。
                PhaseFail::Op(e) => {
                    settle_abort_cleanup(&channel, stream_id, false).await;
                    e
                }
                PhaseFail::Join(j) => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    FabricError::Session(SessionError::Connect(format!("fin task join: {j}")))
                }
                PhaseFail::Cancel => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    cancelled_err()
                }
                PhaseFail::Deadline => {
                    settle_abort_cleanup(&channel, stream_id, true).await;
                    head_timeout_err()
                }
            });
        }
    }
    // 等 meta 行（首块；有界——head 预算的剩余部分）。超时/取消发 RESET 清理
    // provider 侧在途请求（未清理则 handler 悬挂至其自身超时）。
    // r11-B1：RESET 前终态落位（LocalAbort 跨恢复代保留）——发送失败由恢复
    // 重放补发，对端以错误而非干净 EOF 收敛。
    let reset_stream = session.shared().abort_stream(stream_id);
    tokio::pin!(reset_stream);
    let mut buf: Vec<u8> = Vec::new();
    // head 预算剩余（零剩余 = 已超时；timeout(0) 首查 future，已排队数据仍交付）
    let remaining = || {
        let now = tokio::time::Instant::now();
        if now >= head_deadline {
            std::time::Duration::ZERO
        } else {
            head_deadline - now
        }
    };
    let (status, headers, rest) = loop {
        if cancel_fired() {
            reset_stream.await;
            return Err(cancelled_err());
        }
        if tokio::time::Instant::now() >= head_deadline {
            reset_stream.await;
            return Err(head_timeout_err());
        }
        let chunk = tokio::select! {
            r = tokio::time::timeout(remaining(), channel.recv(stream_id)) => match r {
                Ok(r) => r?,
                Err(_) => {
                    reset_stream.await;
                    return Err(head_timeout_err());
                }
            },
            _ = &mut cancel_fut => {
                reset_stream.await;
                return Err(cancelled_err());
            }
        };
        buf.extend_from_slice(&chunk);
        if let Some((status, headers, rest)) = peel_meta_line(&buf) {
            break (status, headers, rest);
        }
    };
    Ok(HttpClientResponse {
        status,
        headers,
        stream_id,
        session: session.clone(),
        buf: Some(rest),
    })
}

/// 响应首行 meta：`{json}\n`；成功返回 (status, headers, 行后剩余字节)。
fn peel_meta_line(buf: &[u8]) -> Option<(u16, Vec<Header>, Bytes)> {
    let nl = buf.iter().position(|&b| b == b'\n')?;
    let line = &buf[..nl];
    let v: Value = serde_json::from_slice(line).ok()?;
    let status = v.get("status")?.as_u64()? as u16;
    let headers = v
        .get("headers")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|h| {
                    Some(Header {
                        name: h.get("name")?.as_str()?.to_string(),
                        value: h.get("value")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some((status, headers, Bytes::copy_from_slice(&buf[nl + 1..])))
}

fn hex16(b: &[u8; 16]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------
// provider：serve_http
// ---------------------------------------------------------------------------

/// provider 引擎循环：accept 会话 → per-connection 任务消费新到达流。
/// 恢复轮（session 内流已 STARTED/COMPLETED）跳过 dispatch——重放由协议层
/// 完成；新流在新 channel 上到达，旧任务随死通道自然退出。
pub async fn serve_http(
    fabric: &Fabric,
    peer_id: &str,
    opts: SessionOptions,
    handler: Arc<dyn HttpHandler>,
) -> Result<(), FabricError> {
    // E1′ 硬化（2026-09-30 双机实证）：serve 面有两个来源——
    // ① 对端发起的新会话（accept_any，既有语义：**不可中途取消**——其内
    //    部 ensure_connection 的在途拨号被取消会留半开连接，故以常驻 worker
    //    + mpsc 承载，select 只等结果不取消工作）；
    // ② 本端 client/canonical 会话的**反向到达流**：并发双开收敛后对端
    //    adopted 本端发起的会话（open_session 的 ALREADY_ACTIVE adopt 路径
    //    /幂等复用），对端在其上开 provider 向流发请求——该会话从未经过
    //    accept_any，无 dispatch 任务 → 请求到达 pump 却永不分发（真双机
    //    实证：response head timeout 循环 + 对端 Reset）。每 tick 复核
    //    canonical：未见过的 sid 挂 dispatch（通道死亡任务退出后重挂——
    //    恢复轮新通道由重挂承接）。
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Session>();
    {
        let fabric = fabric.clone();
        let peer_id = peer_id.to_owned();
        tokio::spawn(async move {
            loop {
                match accept_any(&fabric, &peer_id, opts).await {
                    Ok(session) => {
                        let _ = tx.send(session);
                    }
                    // 拒绝/死流/收敛期死连接：退避后继续（防热自旋）
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                }
            }
        });
    }
    let mut reverse_served: std::collections::HashSet<[u8; 16]> = std::collections::HashSet::new();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let session = tokio::select! {
            s = rx.recv() => s,
            _ = tick.tick() => None,
        };
        if let Some(s) = session {
            spawn_session_dispatch(Arc::new(s), Arc::clone(&handler));
        }
        // 面②：canonical 会话的反向到达（收敛/自开会话）
        if let Some(shared) = fabric
            .inner
            .continuity_sessions
            .reusable_for_peer(peer_id)
            .await
            && let Some(session) = Session::from_shared_for_serve(shared)
            && reverse_served.insert(session.shared().session_id)
        {
            spawn_session_dispatch(Arc::new(session), Arc::clone(&handler));
        }
    }
}

/// 单会话 dispatch 任务（新入站会话与反向到达面共用）：next_incoming 逐流
/// 派发；通道终结退出（恢复轮/canonical 更替由调用方的复核重挂承接）。
fn spawn_session_dispatch(session: Arc<Session>, handler: Arc<dyn HttpHandler>) {
    tokio::spawn(async move {
        loop {
            let Some(stream_id) = session.next_incoming().await else {
                return; // 通道终结（恢复轮由新任务接管）
            };
            let handler = Arc::clone(&handler);
            let session = Arc::clone(&session);
            tokio::spawn(dispatch_stream(session, stream_id, handler));
        }
    });
}

/// 等会话回到 Active（断线桥接：发送失败期间 body mpsc 背压暂停上游；
/// 恢复后 journal 重放补齐未送达段，新块走新 channel）。
/// 有界 30s（超时视为恢复失败，流留在未完态由对端超时暴露）。
async fn wait_active(session: &Arc<Session>) -> bool {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        if session.phase().await == super::session::SessionPhase::Active {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    false
}

/// record-once + 定 offset 裸帧重发：journal 恰好记一次，发送失败等恢复后
/// 以同一 offset 重发（对端 RecvWindow 去重闭合；部分写入帧由帧边界丢弃）。
/// 返回 false = 恢复失败（流留未完态由对端超时暴露）。
/// r13-B4：错误终态（本端中止/对端取消/协议错误）即时退出——发送闸门对
/// 终态流恒 Err，不复查会在 Active 会话上热自旋（wait_active 恒 true）。
async fn send_resilient(session: &Arc<Session>, stream_id: u64, payload: Bytes) -> bool {
    let offset = match session.prepare_send(stream_id, &payload).await {
        Ok(o) => o,
        Err(_) => return false, // journal 上限/关闭/终态：背压或取消终态
    };
    loop {
        match session
            .send_data_at(stream_id, offset, payload.clone())
            .await
        {
            Ok(()) => return true,
            Err(_) => {
                if matches!(
                    session.shared().stream_term(stream_id).await,
                    Some(
                        StreamTerm::LocalAbort | StreamTerm::PeerReset | StreamTerm::ProtocolError
                    )
                ) {
                    return false; // 流已终结：停止重发（调用方失败后不得继续）
                }
                if !wait_active(session).await {
                    return false;
                }
            }
        }
    }
}

/// 单流 dispatch：元数据解析 → 副作用闸门 → handler → 响应投影。
/// 断线窗口 = 发送失败：等 Active 后定 offset 重发；FIN 失败同理重发
/// （final_sent 已记，幂等）。
async fn dispatch_stream(session: Arc<Session>, stream_id: u64, handler: Arc<dyn HttpHandler>) {
    let shared = session.shared();
    // 恢复轮短路：上游已执行（重放由协议层完成，§2.8 STARTED 不重执行）
    match shared.request_state(stream_id).await {
        Some(RequestState::Started) | Some(RequestState::Completed) => return,
        _ => {}
    }
    // r12-B4：对端取消先于 dispatch 到达（OPEN 后立即 RESET——客户端 head
    // 超时/取消清理的竞速窗口）：副作用闸门之前止付，不触发上游请求（对端
    // 已明确取消，执行上游只会留下无人消费的副作用）。终裁标记 Completed
    // 让 watcher/RequestCancel 有界收敛（peer_reset 优先复查 → Cancelled）。
    if shared.peer_reset(stream_id).await {
        shared.mark_completed(stream_id).await;
        return;
    }
    let Some(meta_raw) = shared.open_meta(stream_id).await else {
        return; // 无元数据（非 HTTP 流）——引擎不管
    };
    let meta: Value = match serde_json::from_slice(&meta_raw) {
        Ok(v) => v,
        Err(_) => {
            let _ = respond_error(&session, stream_id, 400, "bad request meta").await;
            // 错误响应仍是该流的终局（P1-1）：RequestCancel waiter 据此收敛
            // Completed——否则活跃会话上的 watcher 悬挂至会话终态。
            shared.mark_completed(stream_id).await;
            return;
        }
    };
    let request = HttpRequest {
        method: meta
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_string(),
        path: meta
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("/")
            .to_string(),
        headers: meta
            .get("headers")
            .and_then(|h| h.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|h| {
                        Some(Header {
                            name: h.get("name")?.as_str()?.to_string(),
                            value: h.get("value")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        body: RequestBody {
            shared: Arc::clone(shared),
            stream_id,
        },
        stream_id,
        session_id: shared.session_id,
        cancel: RequestCancel::new(Arc::clone(shared), stream_id),
    };
    // 上游执行开始（副作用闸门：此后断线恢复不重入 dispatch）
    shared.mark_started(stream_id).await;
    match handler.handle(request).await {
        Ok(resp) => {
            let meta_line = json!({
                "status": resp.status,
                "headers": resp.headers.iter().map(|h| json!({"name": h.name, "value": h.value})).collect::<Vec<_>>(),
            });
            if !send_resilient(&session, stream_id, Bytes::from(format!("{}\n", meta_line))).await {
                return;
            }
            if let Some(mut body) = resp.body {
                loop {
                    // 注册唤醒面之前先查标志——Notify 不保留通知，select 订阅
                    // 前到达的 RESET 已置 peer_reset（只查标志即可命中）。
                    if shared.peer_reset(stream_id).await {
                        return; // 止付并丢弃接收器（供给面随 Drop 关闭）
                    }
                    let chunk = tokio::select! {
                        c = body.recv() => match c {
                            Some(c) => c,
                            None => break, // 供给关闭：正常 EOF 与本端中止在循环后分流
                        },
                        // 对端 RESET 即时唤醒（挂起中的响应流——handler 无后续
                        // write 时 body.recv() 永不返回，止付必须事件驱动）
                        _ = shared.reset_notify.notified() => {
                            continue; // 回到循环头复查 peer_reset/本端中止
                        }
                    };
                    // 对端 RESET（per-request cancel）：止付并丢弃接收器——
                    // 流式供给面随 Drop 关闭，handler 侧写失败提前收敛。
                    if shared.peer_reset(stream_id).await {
                        return;
                    }
                    // r11-B1：本端已中止供给（上游取消/掐断）：止付并丢弃接收器
                    //——禁 FIN（终局 RESET 已由 abort_stream 落位，跨代补发由
                    // 恢复重放承接）；终裁 Completed 收敛 watcher。
                    if shared.stream_term(stream_id).await == Some(StreamTerm::LocalAbort) {
                        shared.mark_completed(stream_id).await;
                        return;
                    }
                    if !send_resilient(&session, stream_id, chunk).await {
                        return;
                    }
                }
            }
            // r11-B1：供给关闭 ≠ 正常 EOF——已取消供给禁 FIN：截断不得伪装干净
            // EOF（对端只能经 RESET/会话终态以错误收敛）。
            if shared.stream_term(stream_id).await == Some(StreamTerm::LocalAbort) {
                shared.mark_completed(stream_id).await;
                return;
            }
            // r11-B1 竞速收口（双机矩阵 cycle#19：干净 200 短体）：供给关闭
            //（None）与对端 RESET 并发到达时，select 可能先观察到 None——FIN
            // 前必须复查 peer_reset，否则截断以干净 EOF 外显（体完整性违约）。
            if shared.peer_reset(stream_id).await {
                return;
            }
            // 终局半关（幂等重发；失败时 final_sent 已记，恢复轮亦自动重发）。
            // r11-B1：重试环内复查中止终态——finish 对已中止流恒 Err，而
            // wait_active 在 Active 会话上立即返回 true；不复查即热自旋
            //（窗口：循环外检查过后、finish 落锁前中止落位）。
            // r13-B4：复查面扩展到全部错误终态——发送闸门（ensure_send_stream）
            // 对 PeerReset/ProtocolError 同样恒 Err，只查 LocalAbort 会自旋。
            loop {
                if matches!(
                    shared.stream_term(stream_id).await,
                    Some(
                        StreamTerm::LocalAbort | StreamTerm::PeerReset | StreamTerm::ProtocolError
                    )
                ) {
                    shared.mark_completed(stream_id).await;
                    return;
                }
                match session.finish(stream_id).await {
                    Ok(()) => break,
                    Err(_) => {
                        if !wait_active(&session).await {
                            return;
                        }
                    }
                }
            }
            shared.mark_completed(stream_id).await;
        }
        Err(_e) => {
            // 未发头前 handler 失败 → 500（已发头后失败由 body 流 Drop 时
            // 「未 FIN 即通道终结」暴露；§3.4 RESET 映射在 4.2 冻结）。
            // 500 已构成终局响应（P1-1）：mark_completed 让 watcher/
            // RequestCancel 收敛——lifecycle terminal 必须与响应终局同步。
            let _ = respond_error(&session, stream_id, 500, "upstream failed").await;
            shared.mark_completed(stream_id).await;
        }
    }
}

async fn respond_error(
    session: &Arc<Session>,
    stream_id: u64,
    status: u16,
    msg: &str,
) -> Result<(), FabricError> {
    let meta = json!({
        "status": status,
        "headers": [ { "name": "content-type", "value": "text/plain" } ],
    });
    session
        .send_data(stream_id, Bytes::from(format!("{}\n{msg}", meta)))
        .await?;
    session.finish(stream_id).await
}

// data 帧方向语义（P→C/C→P）由 SessionShared::send_direction 决定，本模块
// 不直接引用 Direction。
