//! HTTP N-API 桥（app-protocol-layer Phase 3 task 4.2，design §3.4 冻结 ABI）。
//!
//! 正交意图（2026-09-16，task 4.2）：
//! 1. fetchHttp 响应 body 桥：**pull-first**——无桥内缓冲/队列，JS bodyNext()
//!    直接驱动内核 recv（每次一块；EOF = null）。有界性来自内核 journal 上限
//!    （发送侧反压）与 delivered 队列（commit point，§2.5）；并发 next 经
//!    公平 tokio Mutex 串行（offset 序不乱）。
//! 2. serveHttp handler 桥：TSFN 只作**信号**（NonBlocking，返回状态检查），
//!    不做数据队列；请求经 JSON 事件进入 JS，结算经 resolveRequest/
//!    rejectRequest 回流；静态 chunks 以有界 mpsc（cap 16）供给引擎。
//! 3. 会话终态竞速：bodyNext 与 phase(Dead/Closed) 竞速——有界失败不悬挂。
//! 4. WS：字节隧道面（keepOpen + sendTunnel + bodyNext）；整消息通道
//!    （WsMessage/WebSocketChannel）归 Phase 4——类型占位见 /http d.ts。
//!
//! 禁止项（§3.4 评审冻结）：无界队列、ThreadsafeFunctionCallMode::Blocking。

use bytes::Bytes;
use dweb_fabric::continuity::http::{
    fetch_http as kernel_fetch_http, serve_http as kernel_serve_http, CancelOutcome, FetchCancel,
    Header, HttpEngineError, HttpHandler, HttpRequest as KernelHttpRequest,
    HttpRequestInit as KernelHttpRequestInit, HttpResponse as KernelHttpResponse, RequestBody,
};
use dweb_fabric::continuity::session::{Session, SessionOptions, SessionPhase, SessionShared};
use dweb_fabric::Fabric as RustFabric;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};

use crate::session::session_err;

/// body 拉取与会话终态竞速的轮询片（Dead/Closed → 有界失败而非悬挂）。
const BODY_RACE_SLICE: Duration = Duration::from_millis(500);
/// serve 响应静态 chunks → 引擎 mpsc 容量（§3.4 有界水位；引擎侧背压/断线桥接）。
const BODY_CHANNEL_CAP: usize = 16;

/// HTTP 头（数组形态保重复项，§3.4）。
#[napi(object)]
#[derive(Clone)]
pub struct HeaderJs {
    pub name: String,
    pub value: String,
}

impl HeaderJs {
    fn to_kernel(&self) -> Header {
        Header::new(&self.name, &self.value)
    }
}

/// fetchHttp 请求初始化（本阶段静态 body 分块；AsyncIterable body 后续 phase）。
#[napi(object)]
pub struct FetchHttpInit {
    pub method: String,
    pub path: String,
    pub headers: Option<Vec<HeaderJs>>,
    pub body: Option<Vec<Buffer>>,
    /// WS 隧道模式：不半关请求方向（101 后双向持续；配合 sendTunnel）。
    pub keep_open: Option<bool>,
    /// 响应头等待上限毫秒（默认 30s——长轮询/慢上游按需放宽）。
    pub head_timeout_ms: Option<f64>,
    /// 外部取消键（index.js 胶水由 request.signal 生成注册；abort 时经
    /// SessionHandle.abortFetch(key) 触发 head 等待期即时 RESET）。
    pub abort_key: Option<f64>,
}

/// fetchHttp 响应：status/headers/streamId + bodyNext（pull-first）。
/// http/index.js 胶水另注入 [Symbol.asyncIterator]（§3.4 body AsyncIterable 投影）。
#[napi]
pub struct HttpClientResponseJs {
    status: u16,
    headers: Vec<HeaderJs>,
    stream_id: u64,
    resp: Mutex<dweb_fabric::continuity::http::HttpClientResponse>,
    shared: Arc<SessionShared>,
    aborted: std::sync::atomic::AtomicBool,
}

#[napi]
impl HttpClientResponseJs {
    #[napi(getter)]
    pub fn status(&self) -> u32 {
        self.status as u32
    }

    #[napi(getter)]
    pub fn headers(&self) -> Vec<HeaderJs> {
        self.headers.clone()
    }

    /// 逻辑流 id（/http/internals 观测面；幂等键关联）。
    #[napi(getter)]
    pub fn stream_id(&self) -> f64 {
        self.stream_id as f64
    }

    /// 拉取下一块 body（EOF = null）。pull-first：无桥内缓冲——JS 消费速度即
    /// 内核 delivered 队列排空速度。并发调用经公平 Mutex 串行（offset 序保持）；
    /// 会话 Dead/Closed 时有界失败。
    #[napi]
    pub async fn body_next(&self) -> Result<Option<Buffer>> {
        if self.aborted.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Error::new(
                Status::GenericFailure,
                "[session] response aborted by caller",
            ));
        }
        loop {
            match self.shared.phase().await {
                SessionPhase::Dead | SessionPhase::Closed => {
                    return Err(Error::new(
                        Status::GenericFailure,
                        "[session] response body ended: session dead/closed",
                    ));
                }
                _ => {}
            }
            let pull = async {
                let mut guard = self.resp.lock().await;
                match guard.recv_body().await {
                    Ok(c) => Ok(Some(c)),
                    Err(_) => Ok(None), // EOF（对端 FIN/RESET——内核收敛为流结束）
                }
            };
            match tokio::time::timeout(BODY_RACE_SLICE, pull).await {
                Ok(r) => return r.map(|opt| opt.map(|c| Buffer::from(c.to_vec()))),
                Err(_) => continue, // 本片无数据：回头复查终态
            }
        }
    }

    /// WS 隧道（keepOpen 请求专用）：client→provider 方向继续写。
    /// 整消息边界 ABI（WsMessage，§3.4）归 Phase 4——本面是字节隧道级，如实标注。
    #[napi]
    pub async fn send_tunnel(&self, data: Buffer) -> Result<()> {
        if self.aborted.load(std::sync::atomic::Ordering::Acquire) {
            return Err(Error::new(
                Status::GenericFailure,
                "[session] response aborted by caller",
            ));
        }
        self.resp
            .lock()
            .await
            .send_tunnel(Bytes::from(data.as_ref().to_vec()))
            .await
            .map_err(session_err)
    }

    /// per-request 取消（幂等）：向 provider 发 RESET——serve 响应循环止付、
    /// 流式 body 供给面关闭，上游 handler 提前收敛（本地断开 → 上游关闭）。
    /// 通道已死时发送失败即取消目的已达，静默成功。
    #[napi]
    pub async fn abort(&self) -> Result<()> {
        if !self.aborted.swap(true, std::sync::atomic::Ordering::AcqRel) {
            self.resp.lock().await.abort().await;
        }
        Ok(())
    }
}

/// fetchHttp 内部落点（SessionHandle.fetchHttp 方法转发；session 归属见 session.rs）。
/// 注意：本模块 `Result` 经 bindgen_prelude glob 是 napi::Result——内核桥的
/// std Result 一律全限定。
pub(crate) async fn fetch_http(
    session: &Arc<Session>,
    init: FetchHttpInit,
    cancel: Option<Arc<FetchCancel>>,
) -> Result<HttpClientResponseJs> {
    let rin = KernelHttpRequestInit {
        method: init.method,
        path: init.path,
        headers: init
            .headers
            .unwrap_or_default()
            .iter()
            .map(|h| h.to_kernel())
            .collect(),
        body: init
            .body
            .unwrap_or_default()
            .into_iter()
            .map(|b| Bytes::from(b.as_ref().to_vec()))
            .collect(),
        keep_open: init.keep_open.unwrap_or(false),
        head_timeout: init
            .head_timeout_ms
            .filter(|ms| *ms > 0.0)
            .map(|ms| std::time::Duration::from_millis(ms as u64)),
        cancel,
    };
    let resp = kernel_fetch_http(session, rin).await.map_err(session_err)?;
    let shared = Arc::clone(session.shared());
    Ok(HttpClientResponseJs {
        status: resp.status,
        headers: resp
            .headers
            .iter()
            .map(|h| HeaderJs {
                name: h.name.clone(),
                value: h.value.clone(),
            })
            .collect(),
        stream_id: resp.stream_id,
        resp: Mutex::new(resp),
        shared,
        aborted: std::sync::atomic::AtomicBool::new(false),
    })
}

// ---------------------------------------------------------------------------
// serveHttp：TSFN handler 桥
// ---------------------------------------------------------------------------

/// JS handler 结算载荷（bridge 内部）：
/// - Static：一次性状态行+全量 chunks（resolveRequest——简单响应）。
/// - Streaming：先回状态行（respondStreaming），body 经 StreamWriterJs
///   持续 write——SSE/长连接/WS 101 早发等真实流式响应。
enum HandlerOutcome {
    Static {
        status: u16,
        headers: Vec<Header>,
        chunks: Vec<Bytes>,
    },
    Streaming {
        status: u16,
        headers: Vec<Header>,
        body: tokio::sync::mpsc::Receiver<Bytes>,
    },
}

type BoxHttpFuture = std::pin::Pin<
    Box<
        dyn std::future::Future<Output = std::result::Result<KernelHttpResponse, HttpEngineError>>
            + Send,
    >,
>;

/// TSFN→Rust handler 适配器：请求经 JSON 事件（NonBlocking 信号）进入 JS；
/// 结算经 HttpServerJs.resolveRequest/rejectRequest 回流（requestId 关联）。
/// pending/bodies 注册表容量 = 活跃请求数；server.close() 时未决请求全部以
/// 取消结算（§3.4 shutdown：用户 Promise 不被无限等待，late completion 仅丢弃）。
/// TSFN 不 Clone（napi 3.12）——经 Arc 共享进 dispatch future。
/// per-request 生命周期观测旗（watcher 置位）：cancelled = 对端取消事件；
/// closed = 流终裁（完成/取消——内核此后不再消费 write）。
/// 注意不得以保留 mpsc Sender 的方式观测通道状态——探针 sender 会让
/// dispatch 的 body.recv() 永不 EOF、FIN 无法发出（0.6.0 实证回归）。
pub(crate) struct RequestFlags {
    pub cancelled: std::sync::atomic::AtomicBool,
    pub closed: std::sync::atomic::AtomicBool,
}

pub(crate) struct HandlerBridge {
    tsfn: Arc<ThreadsafeFunction<String>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<HandlerOutcome, String>>>>>,
    bodies: Arc<Mutex<HashMap<u64, RequestBody>>>,
    /// per-request 生命周期旗（watcher 置位；StreamWriterJs 观测用）。
    cancels: Arc<Mutex<HashMap<u64, Arc<RequestFlags>>>>,
    next_request_id: std::sync::atomic::AtomicU64,
    closed: Arc<std::sync::atomic::AtomicBool>,
}

impl HandlerBridge {
    fn new(tsfn: ThreadsafeFunction<String>) -> Arc<Self> {
        Arc::new(Self {
            tsfn: Arc::new(tsfn),
            pending: Arc::new(Mutex::new(HashMap::new())),
            bodies: Arc::new(Mutex::new(HashMap::new())),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            next_request_id: std::sync::atomic::AtomicU64::new(1),
            closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
    }
}

impl HttpHandler for HandlerBridge {
    fn handle(&self, request: KernelHttpRequest) -> BoxHttpFuture {
        let tsfn = Arc::clone(&self.tsfn);
        let pending = Arc::clone(&self.pending);
        let bodies = Arc::clone(&self.bodies);
        let cancels = Arc::clone(&self.cancels);
        let closed = Arc::clone(&self.closed);
        let request_id = self
            .next_request_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if closed.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(HttpEngineError("server closed".into()));
            }
            let (tx, rx) = oneshot::channel();
            pending.lock().await.insert(request_id, tx);
            bodies.lock().await.insert(request_id, request.body.clone());
            // per-request 取消 watcher：终裁 Cancelled → 置 cancelled + 发
            // TSFN cancel 事件（best-effort 信号；write 错误仍是真相面）；
            // 任一终裁 → 置 closed（内核此后不再消费 write）。watcher 生命
            // 周期 = 内核流生命周期，正常完成零残留。
            let flags = Arc::new(RequestFlags {
                cancelled: std::sync::atomic::AtomicBool::new(false),
                closed: std::sync::atomic::AtomicBool::new(false),
            });
            cancels.lock().await.insert(request_id, Arc::clone(&flags));
            {
                let tsfn = Arc::clone(&tsfn);
                let cancels = Arc::clone(&cancels);
                let flags = Arc::clone(&flags);
                let cancel = request.cancel.clone();
                let rid = request_id;
                tokio::spawn(async move {
                    let outcome = cancel.wait().await;
                    flags
                        .closed
                        .store(true, std::sync::atomic::Ordering::Release);
                    if outcome == CancelOutcome::Cancelled {
                        flags
                            .cancelled
                            .store(true, std::sync::atomic::Ordering::Release);
                        let ev = serde_json::json!({
                            "type": "cancel",
                            "requestId": rid,
                        });
                        // NonBlocking 信号语义：队列满/运行时关闭即丢弃
                        // （返回状态检查——不悬挂 watcher 出口）
                        let _ = tsfn.call(
                            Ok(ev.to_string()),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                    cancels.lock().await.remove(&rid);
                });
            }
            let event = serde_json::json!({
                "type": "request",
                "requestId": request_id,
                "streamId": request.stream_id,
                "sessionId": request.cancel.session_id_hex(),
                "method": request.method,
                "path": request.path,
                "headers": request.headers.iter()
                    .map(|h| serde_json::json!({"name": h.name, "value": h.value}))
                    .collect::<Vec<_>>(),
            });
            // §3.4：TSFN 信号式 NonBlocking——返回状态必须检查（队列满/关闭
            // 即结算失败，不悬挂 dispatch）
            let call_status = tsfn.call(
                Ok(event.to_string()),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
            if call_status != napi::Status::Ok {
                pending.lock().await.remove(&request_id);
                bodies.lock().await.remove(&request_id);
                cancels.lock().await.remove(&request_id);
                return Err(HttpEngineError(format!(
                    "handler signal failed: {call_status:?}"
                )));
            }
            match rx.await {
                Ok(Ok(out)) => {
                    let (status, headers, body) = match out {
                        HandlerOutcome::Static {
                            status,
                            headers,
                            chunks,
                        } => {
                            // 静态 chunks → 有界 mpsc 供给（断线窗口引擎侧背压承接）
                            let (btx, brx) = tokio::sync::mpsc::channel::<Bytes>(BODY_CHANNEL_CAP);
                            tokio::spawn(async move {
                                for c in chunks {
                                    if btx.send(c).await.is_err() {
                                        break;
                                    }
                                }
                            });
                            (status, headers, Some(brx))
                        }
                        HandlerOutcome::Streaming {
                            status,
                            headers,
                            body,
                        } => (status, headers, Some(body)),
                    };
                    Ok(KernelHttpResponse {
                        status,
                        headers,
                        body,
                    })
                }
                Ok(Err(msg)) => Err(HttpEngineError(msg)),
                Err(_dropped) => Err(HttpEngineError("handler cancelled".into())),
            }
        })
    }
}

/// serveHttp 返回句柄：close() 停引擎循环 + 未决 handler 以取消结算。
/// 引擎 accept 循环与 per-connection dispatch 任务由内核承接；close 后残留
/// dispatch 由 wait_active 有界（30s）退出。
#[napi]
pub struct HttpServerJs {
    peer_id: String,
    bridge: Arc<HandlerBridge>,
    task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl HttpServerJs {
    pub(crate) fn start(
        fabric: RustFabric,
        peer_id: String,
        tsfn: ThreadsafeFunction<String>,
    ) -> Self {
        let bridge = HandlerBridge::new(tsfn);
        let handler: Arc<dyn HttpHandler> = Arc::clone(&bridge) as Arc<dyn HttpHandler>;
        let opts = SessionOptions::default();
        let peer = peer_id.clone();
        let task = tokio::spawn(async move {
            let _ = kernel_serve_http(&fabric, &peer, opts, handler).await;
        });
        Self {
            peer_id,
            bridge,
            task: std::sync::Mutex::new(Some(task)),
        }
    }
}

#[napi]
impl HttpServerJs {
    /// 服务对端（观测）。
    #[napi(getter)]
    pub fn peer_id(&self) -> String {
        self.peer_id.clone()
    }

    /// 是否已关闭（观测）。
    #[napi(getter)]
    pub fn closed(&self) -> bool {
        self.bridge.closed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// （内部面 /http/internals）未决 handler 请求数（在途观测）。
    #[napi(getter)]
    pub fn pending_request_count(&self) -> u32 {
        self.bridge.pending.blocking_lock().len() as u32
    }

    /// （内部面）JS handler 正常返回：status（100..=599 整数）/headers/bodyChunks
    /// （静态数组；流式供给由引擎有界背压承接）。
    #[napi]
    pub fn resolve_request(
        &self,
        request_id: f64,
        status: f64,
        headers: Option<Vec<HeaderJs>>,
        body_chunks: Option<Vec<Buffer>>,
    ) -> Result<()> {
        let id = request_id as u64;
        if status.fract() != 0.0 || !(100.0..=599.0).contains(&status) {
            return Err(Error::new(
                Status::GenericFailure,
                "[session] handler status must be an integer in 100..=599",
            ));
        }
        let mut pending = self.bridge.pending.blocking_lock();
        if let Some(tx) = pending.remove(&id) {
            let out = HandlerOutcome::Static {
                status: status as u16,
                headers: headers
                    .unwrap_or_default()
                    .iter()
                    .map(|h| h.to_kernel())
                    .collect(),
                chunks: body_chunks
                    .unwrap_or_default()
                    .into_iter()
                    .map(|b| Bytes::from(b.as_ref().to_vec()))
                    .collect(),
            };
            let _ = tx.send(Ok(out));
            Ok(())
        } else {
            // §3.4 late completion：close 后/已结算的晚到结算只丢弃（幂等），
            // 不抛错——防 server.close 后 unhandledRejection
            Ok(())
        }
    }

    /// （内部面）流式结算：立即回状态行（响应头此刻发出——SSE 首包/WS 101
    /// 早发），body 经返回的 StreamWriterJs 持续 write/finish。与
    /// resolveRequest 互斥（先到者胜）。unknown id 幂等返回 null。
    #[napi]
    pub fn respond_streaming(
        &self,
        request_id: f64,
        status: f64,
        headers: Option<Vec<HeaderJs>>,
    ) -> Result<Option<StreamWriterJs>> {
        let id = request_id as u64;
        if status.fract() != 0.0 || !(100.0..=599.0).contains(&status) {
            return Err(Error::new(
                Status::GenericFailure,
                "[session] handler status must be an integer in 100..=599",
            ));
        }
        let mut pending = self.bridge.pending.blocking_lock();
        let Some(tx) = pending.remove(&id) else {
            return Ok(None);
        };
        let (btx, brx) = tokio::sync::mpsc::channel::<Bytes>(BODY_CHANNEL_CAP);
        let out = HandlerOutcome::Streaming {
            status: status as u16,
            headers: headers
                .unwrap_or_default()
                .iter()
                .map(|h| h.to_kernel())
                .collect(),
            body: brx,
        };
        let _ = tx.send(Ok(out));
        // 生命周期观测旗（watcher 终裁置位；pending 存续期间 entry 必在——
        // watcher 仅于流终裁后移除）。writer 不得另持 mpsc sender 探针——
        // 那会让 dispatch 的 body.recv() 永不 EOF（FIN 发不出）。
        let flags = self
            .bridge
            .cancels
            .blocking_lock()
            .get(&id)
            .cloned()
            .unwrap_or_else(|| {
                Arc::new(RequestFlags {
                    cancelled: std::sync::atomic::AtomicBool::new(false),
                    closed: std::sync::atomic::AtomicBool::new(false),
                })
            });
        Ok(Some(StreamWriterJs {
            tx: std::sync::Mutex::new(Some(btx)),
            flags,
        }))
    }

    /// （内部面）JS handler 抛错/拒绝：引擎按未发头前失败处置（500）。
    #[napi]
    pub fn reject_request(&self, request_id: f64, message: String) -> Result<()> {
        let id = request_id as u64;
        let mut pending = self.bridge.pending.blocking_lock();
        if let Some(tx) = pending.remove(&id) {
            let _ = tx.send(Err(message));
            Ok(())
        } else {
            // 同 resolve_request：晚到拒绝幂等丢弃（§3.4 late completion）
            Ok(())
        }
    }

    /// （内部面）请求体拉取（pull-first；EOF = null；unknown id / 会话终态 → 错误）。
    #[napi]
    pub async fn request_body_next(&self, request_id: f64) -> Result<Option<Buffer>> {
        let id = request_id as u64;
        let body = self.bridge.bodies.lock().await.get(&id).cloned();
        let Some(body) = body else {
            return Err(Error::new(
                Status::GenericFailure,
                format!("[session] unknown request id {id}"),
            ));
        };
        loop {
            match body.shared().phase().await {
                SessionPhase::Dead | SessionPhase::Closed => {
                    return Err(Error::new(
                        Status::GenericFailure,
                        "[session] request body ended: session dead/closed",
                    ));
                }
                _ => {}
            }
            let pull = async {
                match body.recv().await {
                    Ok(c) => Ok(Some(c)),
                    Err(_) => Ok(None), // EOF（对端 FIN/RESET）
                }
            };
            match tokio::time::timeout(BODY_RACE_SLICE, pull).await {
                Ok(r) => {
                    return r.map(|opt| opt.map(|c| Buffer::from(c.to_vec())));
                }
                Err(_) => continue, // 本片无数据：回头复查终态
            }
        }
    }

    /// 关闭（幂等）：停引擎循环 + 未决 handler 以取消结算 + 清 body 注册表。
    /// 已 dispatch 流的引擎侧收尾由内核 wait_active 有界（30s）退出。
    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.bridge
            .closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(t) = self.task.lock().unwrap().take() {
            t.abort();
        }
        let mut pending = self.bridge.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("server closed".into()));
        }
        self.bridge.bodies.lock().await.clear();
        Ok(())
    }
}

/// 流式响应写句柄（respondStreaming 返回）：write 逐块供给（有界通道背压
/// ——消费速度传导到内核发送面）；finish 半关（EOF）。对端 RESET/引擎丢弃
/// 时 write 报错——调用方据此提前收敛上游（本地断开 → 上游关闭链路）。
/// 三态观测（0.6.0 三拆，正交）：
/// - finished：本地已调用 finish()（半关意图）
/// - cancelled：对端取消事件已触发本请求（watcher 旗）
/// - closed：底层投递通道已关（内核不再消费后续 write）
/// getter 为观测面；write 的错误返回仍为取消/关闭的真相面。
#[napi]
pub struct StreamWriterJs {
    tx: std::sync::Mutex<Option<tokio::sync::mpsc::Sender<Bytes>>>,
    flags: Arc<RequestFlags>,
}

#[napi]
impl StreamWriterJs {
    /// 是否已 finish（本地半关意图，幂等面）。
    #[napi(getter)]
    pub fn finished(&self) -> bool {
        self.tx.lock().unwrap().is_none()
    }

    /// 对端取消（RESET/会话终态遗弃）是否已触发本请求（事件驱动观测）。
    #[napi(getter)]
    pub fn cancelled(&self) -> bool {
        self.flags
            .cancelled
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// 底层投递通道是否已关（内核停止消费——完成/放弃/取消后均翻转）。
    #[napi(getter)]
    pub fn closed(&self) -> bool {
        self.flags.closed.load(std::sync::atomic::Ordering::Acquire)
    }

    /// 写入一块 body（背压：通道满即等待——内核发送面/对端消费速度传导）。
    /// finish 后写、或对端已取消（RESET/引擎丢弃）→ 错误。
    #[napi]
    pub async fn write(&self, chunk: Buffer) -> Result<()> {
        let sender = {
            let guard = self.tx.lock().unwrap();
            guard.as_ref().cloned().ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    "[session] stream writer already finished",
                )
            })?
        };
        sender
            .send(Bytes::from(chunk.as_ref().to_vec()))
            .await
            .map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "[session] stream closed by peer or engine (request cancelled)",
                )
            })
    }

    /// 半关（EOF；幂等）：对端随后的 bodyNext 返回 null。
    #[napi]
    pub fn finish(&self) -> Result<()> {
        *self.tx.lock().unwrap() = None;
        Ok(())
    }
}
