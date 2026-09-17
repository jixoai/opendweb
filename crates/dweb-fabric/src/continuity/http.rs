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
use serde_json::{json, Value};

use crate::fabric::{Fabric, FabricError};
use crate::session::SessionError;

use super::session::{accept_any, RequestState, Session, SessionOptions, SessionShared};

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

    pub async fn recv(&self) -> Result<Bytes, FabricError> {
        self.shared
            .recv(self.stream_id)
            .await
            .map_err(FabricError::Session)
    }

    /// 读至 EOF 聚合（测试/非流式便利面）。
    pub async fn read_all(&self) -> Result<Vec<u8>, FabricError> {
        let mut out = Vec::new();
        loop {
            match self.recv().await {
                Ok(c) => out.extend_from_slice(&c),
                Err(_) => return Ok(out),
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
    /// 响应头等待上限（默认 30s；长轮询场景按需放宽/收紧）。
    pub head_timeout: Option<std::time::Duration>,
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
        if let Some(b) = self.buf.take() {
            if !b.is_empty() {
                return Ok(b);
            }
        }
        self.session.channel().recv(self.stream_id).await
    }

    /// 读至 EOF 聚合。
    pub async fn read_all_body(&mut self) -> Result<Vec<u8>, FabricError> {
        let mut out = Vec::new();
        loop {
            match self.recv_body().await {
                Ok(c) => out.extend_from_slice(&c),
                Err(_) => return Ok(out),
            }
        }
    }

    /// WS 隧道：client→provider 方向继续写（keep_open 请求专用）。
    pub async fn send_tunnel(&self, data: Bytes) -> Result<(), FabricError> {
        self.session.channel().send_data(self.stream_id, data).await
    }

    /// per-request 取消：向对端发 RESET（serve 响应循环止付、流式供给面随
    /// Drop 关闭——上游 handler 提前收敛）。失败仅意味着通道已死（取消目的
    /// 已达成），故映射为 Ok。幂等语义由调用方（SDK）标志位保证。
    pub async fn abort(&self) {
        let frame = crate::continuity::Frame {
            frame_type: crate::continuity::FrameType::Reset,
            flags: 0,
            session_id: self.session.shared().session_id,
            stream_id: self.stream_id,
            direction: self.session.shared().send_direction(),
            byte_offset: 0,
            payload: Bytes::new(),
        };
        let _ = self.session.channel().send_frame(&frame).await;
    }
}

/// 发起 HTTP 请求（请求方向默认 FIN；keep_open 隧道不关）。
/// meta 行到达前有界等待（响应头即首块）。
pub async fn fetch_http(
    session: &Session,
    init: HttpRequestInit,
) -> Result<HttpClientResponse, FabricError> {
    let channel = session.channel();
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
    let stream_id = channel
        .open_stream_raw(&idem, Bytes::from(meta.to_string()))
        .await?;
    for chunk in init.body {
        channel.send_data(stream_id, chunk).await?;
    }
    if !init.keep_open {
        channel.finish(stream_id).await?;
    }
    // 等 meta 行（首块；有界——head_timeout 可配，默认 30s）
    let head_timeout = init
        .head_timeout
        .unwrap_or(std::time::Duration::from_secs(30));
    let mut buf: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + head_timeout;
    let (status, headers, rest) = loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(FabricError::Session(SessionError::Connect(
                "response head timeout".into(),
            )));
        }
        let chunk = tokio::time::timeout(head_timeout, channel.recv(stream_id))
            .await
            .map_err(|_| {
                FabricError::Session(SessionError::Connect("response head timeout".into()))
            })??;
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
    loop {
        let Ok(session) = accept_any(fabric, peer_id, opts).await else {
            // 拒绝/死流/收敛期死连接：退避后继续（防热自旋）
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            continue;
        };
        let session = Arc::new(session);
        let handler = Arc::clone(&handler);
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
/// 返回 false = 恢复失败（流留未完态）。
async fn send_resilient(session: &Arc<Session>, stream_id: u64, payload: Bytes) -> bool {
    let offset = match session.prepare_send(stream_id, &payload).await {
        Ok(o) => o,
        Err(_) => return false, // journal 上限/关闭：背压终态
    };
    loop {
        match session
            .send_data_at(stream_id, offset, payload.clone())
            .await
        {
            Ok(()) => return true,
            Err(_) => {
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
    let Some(meta_raw) = shared.open_meta(stream_id).await else {
        return; // 无元数据（非 HTTP 流）——引擎不管
    };
    let meta: Value = match serde_json::from_slice(&meta_raw) {
        Ok(v) => v,
        Err(_) => {
            let _ = respond_error(&session, stream_id, 400, "bad request meta").await;
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
    };
    // 上游执行开始（副作用闸门：此后断线恢复不重入 dispatch）
    shared.mark_started(stream_id).await;
    match handler.handle(request).await {
        Ok(resp) => {
            let meta_line = json!({
                "status": resp.status,
                "headers": resp.headers.iter().map(|h| json!({"name": h.name, "value": h.value})).collect::<Vec<_>>(),
            });
            if !send_resilient(
                &session,
                stream_id,
                Bytes::from(format!("{}\n", meta_line.to_string())),
            )
            .await
            {
                return;
            }
            if let Some(mut body) = resp.body {
                while let Some(chunk) = body.recv().await {
                    // 对端 RESET（per-request cancel）：止付并丢弃接收器——
                    // 流式供给面随 Drop 关闭，handler 侧写失败提前收敛。
                    if shared.peer_reset(stream_id).await {
                        return;
                    }
                    if !send_resilient(&session, stream_id, chunk).await {
                        return;
                    }
                }
            }
            // 终局半关（幂等重发；失败时 final_sent 已记，恢复轮亦自动重发）
            loop {
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
            // 「未 FIN 即通道终结」暴露；§3.4 RESET 映射在 4.2 冻结）
            let _ = respond_error(&session, stream_id, 500, "upstream failed").await;
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
        .send_data(
            stream_id,
            Bytes::from(format!("{}\n{msg}", meta.to_string())),
        )
        .await?;
    session.finish(stream_id).await
}

// data 帧方向语义（P→C/C→P）由 SessionShared::send_direction 决定，本模块
// 不直接引用 Direction。
