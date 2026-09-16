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
    Header, HttpEngineError, HttpHandler, HttpRequest as KernelHttpRequest,
    HttpRequestInit as KernelHttpRequestInit,
    HttpResponse as KernelHttpResponse, RequestBody, fetch_http as kernel_fetch_http,
    serve_http as kernel_serve_http,
};
use dweb_fabric::continuity::session::{Session, SessionOptions, SessionPhase, SessionShared};
use dweb_fabric::Fabric as RustFabric;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, oneshot};

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
        self.resp
            .lock()
            .await
            .send_tunnel(Bytes::from(data.as_ref().to_vec()))
            .await
            .map_err(session_err)
    }
}

/// fetchHttp 内部落点（SessionHandle.fetchHttp 方法转发；session 归属见 session.rs）。
/// 注意：本模块 `Result` 经 bindgen_prelude glob 是 napi::Result——内核桥的
/// std Result 一律全限定。
pub(crate) async fn fetch_http(
    session: &Arc<Session>,
    init: FetchHttpInit,
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
    })
}

// ---------------------------------------------------------------------------
// serveHttp：TSFN handler 桥
// ---------------------------------------------------------------------------

/// JS handler 结算载荷（bridge 内部）。
struct HandlerOutcome {
    status: u16,
    headers: Vec<Header>,
    chunks: Vec<Bytes>,
}

type BoxHttpFuture = std::pin::Pin<
    Box<
        dyn std::future::Future<
                Output = std::result::Result<KernelHttpResponse, HttpEngineError>,
            > + Send,
    >,
>;

/// TSFN→Rust handler 适配器：请求经 JSON 事件（NonBlocking 信号）进入 JS；
/// 结算经 HttpServerJs.resolveRequest/rejectRequest 回流（requestId 关联）。
/// pending/bodies 注册表容量 = 活跃请求数；server.close() 时未决请求全部以
/// 取消结算（§3.4 shutdown：用户 Promise 不被无限等待，late completion 仅丢弃）。
/// TSFN 不 Clone（napi 3.12）——经 Arc 共享进 dispatch future。
pub(crate) struct HandlerBridge {
    tsfn: Arc<ThreadsafeFunction<String>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<HandlerOutcome, String>>>>>,
    bodies: Arc<Mutex<HashMap<u64, RequestBody>>>,
    next_request_id: std::sync::atomic::AtomicU64,
    closed: Arc<std::sync::atomic::AtomicBool>,
}

impl HandlerBridge {
    fn new(tsfn: ThreadsafeFunction<String>) -> Arc<Self> {
        Arc::new(Self {
            tsfn: Arc::new(tsfn),
            pending: Arc::new(Mutex::new(HashMap::new())),
            bodies: Arc::new(Mutex::new(HashMap::new())),
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
            let event = serde_json::json!({
                "type": "request",
                "requestId": request_id,
                "streamId": request.stream_id,
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
                return Err(HttpEngineError(format!(
                    "handler signal failed: {call_status:?}"
                )));
            }
            match rx.await {
                Ok(Ok(out)) => {
                    // 静态 chunks → 有界 mpsc 供给（断线窗口引擎侧背压承接）
                    let (btx, brx) = tokio::sync::mpsc::channel::<Bytes>(BODY_CHANNEL_CAP);
                    tokio::spawn(async move {
                        for c in out.chunks {
                            if btx.send(c).await.is_err() {
                                break;
                            }
                        }
                    });
                    Ok(KernelHttpResponse {
                        status: out.status,
                        headers: out.headers,
                        body: Some(brx),
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
            let out = HandlerOutcome {
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
            Err(Error::new(
                Status::GenericFailure,
                format!("[session] unknown request id {id}"),
            ))
        }
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
            Err(Error::new(
                Status::GenericFailure,
                format!("[session] unknown request id {id}"),
            ))
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
