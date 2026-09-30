//! HTTP/WS 引擎集成验收（Phase 3 task 4.1）。
//!
//! 覆盖：
//! - JSON POST 往返（OPEN 元数据投影 + 响应首行 meta + body）+ 副作用状态机
//! - SSE 中途断线续传（HTTP 投影）：读若干 chunk → 注入死亡 → resume →
//!   字节级精确续读 + 上游执行恰好一次（task 4.5「60s SSE」的内核雏形）
//! - WS 隧道：keep_open 请求 + 101 → 双向字节隧道往返（RFC6455 帧不透明）
//!
//! 运行：`--test-threads=1`。

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use dweb_fabric::continuity::http::{
    FetchCancel, Header, HttpEngineError, HttpHandler, HttpRequest, HttpRequestInit, HttpResponse,
    fetch_http, serve_http,
};
use dweb_fabric::continuity::session::{self, SessionOptions, SessionPhase, StreamTerm};
use dweb_fabric::continuity::{Direction, Frame, FrameType};
use dweb_fabric::{
    Fabric, FabricConfig, HttpProxyConfig, JOIN_TIMEOUT_MS_DEFAULT, RelayConfig, RelayTlsTrust,
    SecretInjection,
};

fn cfg(dir: &tempfile::TempDir) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Disabled,
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: JOIN_TIMEOUT_MS_DEFAULT,
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
        bind_addr: None,
    }
}

fn cfg_fixed_port(dir: &tempfile::TempDir, port: u16) -> FabricConfig {
    FabricConfig {
        advertise_addrs: vec![format!("127.0.0.1:{port}")],
        bind_addr: Some(format!("127.0.0.1:{port}")),
        ..cfg(dir)
    }
}

fn reserve_loopback_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn pair() -> (Fabric, Fabric, tempfile::TempDir, tempfile::TempDir) {
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let port_a = reserve_loopback_port();
    let port_b = reserve_loopback_port();
    let a = Fabric::create_root(cfg_fixed_port(&dir_a, port_a))
        .await
        .unwrap();
    let fabric_id = a.fabric_id_hex().await;
    let b = Fabric::attach(cfg_fixed_port(&dir_b, port_b), &fabric_id)
        .await
        .unwrap();
    let token = a.invite(300_000, None).await.unwrap();
    b.join(&token).await.expect("join redeems invite");
    let b_id = b.endpoint_id();
    a.add_known_addr(&b_id, format!("127.0.0.1:{port_b}"))
        .await
        .unwrap();
    (a, b, dir_a, dir_b)
}

type BoxHttpFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<HttpResponse, HttpEngineError>> + Send>,
>;

/// 闭包 → HttpHandler（测试便利）。
struct FnHandler<F>(F);
impl<F> HttpHandler for FnHandler<F>
where
    F: Fn(HttpRequest) -> BoxHttpFuture + Send + Sync + 'static,
{
    fn handle(&self, request: HttpRequest) -> BoxHttpFuture {
        (self.0)(request)
    }
}

fn handler<F>(f: F) -> Arc<dyn HttpHandler>
where
    F: Fn(HttpRequest) -> BoxHttpFuture + Send + Sync + 'static,
{
    Arc::new(FnHandler(f))
}

fn body_channel(
    cap: usize,
) -> (
    tokio::sync::mpsc::Sender<Bytes>,
    tokio::sync::mpsc::Receiver<Bytes>,
) {
    tokio::sync::mpsc::channel(cap)
}

/// h1：JSON POST echo 往返 + 状态机 Completed。
#[tokio::test]
async fn http_json_post_roundtrip() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let h = handler(|req: HttpRequest| {
        Box::pin(async move {
            let body = req.body.read_all().await.unwrap_or_default();
            let expect = b"hello engine";
            assert_eq!(&body[..], expect, "请求体经 DATA 投影完整到达");
            let (tx, rx) = body_channel(4);
            let echoed = Bytes::from(body.clone());
            tokio::spawn(async move {
                let _ = tx.send(echoed).await;
            });
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "application/json")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, opts).await.expect("open");
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(
            &client,
            HttpRequestInit::post("/echo", Bytes::from_static(b"hello engine")),
        ),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    assert_eq!(
        resp.headers
            .iter()
            .find(|h| h.name == "content-type")
            .map(|h| h.value.as_str()),
        Some("application/json")
    );
    let body = tokio::time::timeout(Duration::from_secs(10), resp.read_all_body())
        .await
        .expect("body 有界")
        .unwrap();
    assert_eq!(body, b"hello engine".to_vec());
    // ACK 推进后 client 侧 journal 释放（request_state 是 provider 侧状态，
    // 由 Phase 2 套件覆盖；client 侧可观测面 = journal 释放）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while client.shared().journal_held_bytes(resp.stream_id).await > 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "client journal 未释放"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    provider.abort();
}

/// h2：SSE 断线续传（HTTP 投影）——读 3 chunk → 注入死亡 → resume → 字节级精确。
#[tokio::test]
async fn http_sse_survives_connection_swap() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let exec_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    // SSE 内容：10 个互异 chunk，30ms 间隔（断线窗口内仍在产出）
    let exec = Arc::clone(&exec_count);
    let h = handler(move |_req: HttpRequest| {
        let exec = Arc::clone(&exec);
        Box::pin(async move {
            if exec.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                // 引擎恢复轮不会重入 dispatch；此断言防御引擎回归
                return Err(HttpEngineError("re-executed".into()));
            }
            let (tx, rx) = body_channel(2); // 有界：断线窗口背压暂停上游
            tokio::spawn(async move {
                for i in 0..10u32 {
                    if tx
                        .send(Bytes::from(format!("data: tick-{i:02}\n\n")))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            });
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/event-stream")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, opts).await.expect("open");
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/sse")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    assert_eq!(
        resp.headers
            .iter()
            .find(|h| h.name == "content-type")
            .map(|h| h.value.as_str()),
        Some("text/event-stream")
    );

    // 读 ~3 chunk（可能因交付队列聚合略多）后注入死亡
    let mut got = Vec::new();
    let mut chunks_read = 0;
    while chunks_read < 3 {
        match tokio::time::timeout(Duration::from_secs(10), resp.recv_body()).await {
            Ok(Ok(c)) => {
                got.extend_from_slice(&c);
                chunks_read += 1;
            }
            other => panic!("首段读失败: {other:?}"),
        }
    }
    a.continuity_reset(&b_id).await.unwrap();
    client.resume(&a).await.expect("resume");

    // 续读至 EOF（恢复后 chunk 由 journal 重放/续流补齐；EOF = provider FIN）
    loop {
        match tokio::time::timeout(Duration::from_secs(15), resp.recv_body()).await {
            Ok(Ok(c)) => got.extend_from_slice(&c),
            Ok(Err(_)) => break,
            Err(_) => panic!("续读超时（已收 {}B）", got.len()),
        }
    }
    let expected: Vec<u8> = (0..10u32)
        .flat_map(|i| format!("data: tick-{i:02}\n\n").into_bytes())
        .collect();
    assert_eq!(
        got, expected,
        "SSE 断线续传必须字节级精确（丢块/重复即失败）"
    );
    assert_eq!(
        exec_count.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "上游执行恰好一次"
    );
    provider.abort();
}

/// h3：WS 隧道——keep_open + 101 → 双向字节隧道（帧不透明）。
#[tokio::test]
async fn http_ws_tunnel_bidirectional() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    // echo 隧道：101 后双向持续（响应 body 永不 EOF；请求方向持续读）
    let h = handler(|req: HttpRequest| {
        Box::pin(async move {
            let (tx, rx) = body_channel(8);
            tokio::spawn(async move {
                // 隧道 echo：请求方向 → 响应方向
                loop {
                    match req.body.recv().await {
                        Ok(chunk) => {
                            if tx.send(chunk).await.is_err() {
                                return;
                            }
                        }
                        Err(_) => return, // 隧道关闭
                    }
                }
            });
            Ok(HttpResponse {
                status: 101,
                headers: vec![Header::new("connection", "upgrade")],
                body: Some(rx), // 持续供给 = dispatch 永不 FIN（隧道语义）
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, opts).await.expect("open");
    let mut init = HttpRequestInit::get("/ws");
    init.keep_open = true; // WS：不半关请求方向
    let mut resp = tokio::time::timeout(Duration::from_secs(20), fetch_http(&client, init))
        .await
        .expect("fetch 有界")
        .expect("fetch ok");
    assert_eq!(resp.status, 101, "upgrade");

    // 双向隧道往返（RFC6455 帧字节在此为不透明载荷）
    for payload in ["hello-frame-1", "second-frame!!"] {
        resp.send_tunnel(Bytes::from(payload.to_string().repeat(8)))
            .await
            .expect("tunnel send");
        let back = tokio::time::timeout(Duration::from_secs(10), resp.recv_body())
            .await
            .expect("echo 有界")
            .expect("echo data");
        assert_eq!(&back[..], payload.as_bytes().repeat(8).as_slice());
    }
    provider.abort();
}

/// h4：对端 RESET 即时唤醒挂起中的响应流（B1/B2 P0）——handler 已发头、body
/// 供给面静默（无后续 write）时，dispatch 不得悬挂至超时：RESET 到达即止付并
/// Drop 接收器。供给 sender 的 reserve() 立刻报错 = 接收器已 Drop 的直接证据。
#[tokio::test]
async fn http_reset_wakes_idle_response_dispatch() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let probe = std::sync::Arc::new(tokio::sync::Mutex::new(
        None::<tokio::sync::mpsc::Sender<Bytes>>,
    ));
    let p = std::sync::Arc::clone(&probe);
    let h = handler(move |_req: HttpRequest| {
        let p = std::sync::Arc::clone(&p);
        Box::pin(async move {
            let (tx, rx) = body_channel(4);
            *p.lock().await = Some(tx);
            // body 永不供给（响应流挂起形态——上游沉默）
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/idle")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);

    // 等 handler 挂起（channel 就绪）→ 客户端 per-request 取消
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while probe.lock().await.is_none() {
        assert!(tokio::time::Instant::now() < deadline, "handler 未挂起");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    resp.abort().await;

    // RESET 即时唤醒 dispatch：止付 → Drop 接收器 → sender.reserve() 报错
    // （接收器存活时 reserve 对空通道恒成功；唤醒失败则挂到本 deadline 失败）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let tx = probe.lock().await.clone().expect("probe alive");
        match tokio::time::timeout(Duration::from_secs(1), tx.reserve()).await {
            Ok(Err(_send_err)) => break, // 接收器已 Drop——即时止付成立
            Ok(Ok(_permit)) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "RESET 未唤醒 idle 响应流（接收器仍存活）"
                );
                drop(_permit);
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(_) => panic!("reserve 探测不应超时"),
        }
    }
    provider.abort();
}

/// h5：head 超时实际发出并投递 RESET（P0 回归——async send future 曾在同步
/// 闭包中被构造即丢弃，RESET 从未上线）。证明链：client head 超时 → provider
/// 流置 peer_reset → 迟到的 handler 响应被 dispatch 循环头拦截（body 接收器
/// 即刻 Drop → sender.reserve() 报错），响应头永不回送。
#[tokio::test]
async fn http_head_timeout_sends_reset_to_provider() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let probe = std::sync::Arc::new(tokio::sync::Mutex::new(
        None::<tokio::sync::mpsc::Sender<Bytes>>,
    ));
    let handler_done = std::sync::Arc::new(tokio::sync::Notify::new());
    let p = std::sync::Arc::clone(&probe);
    let done = std::sync::Arc::clone(&handler_done);
    let h = handler(move |_req: HttpRequest| {
        let p = std::sync::Arc::clone(&p);
        let done = std::sync::Arc::clone(&done);
        Box::pin(async move {
            // 慢头：迟于 client 的 head_timeout（300ms）
            tokio::time::sleep(Duration::from_secs(2)).await;
            let (tx, rx) = body_channel(4);
            *p.lock().await = Some(tx);
            done.notify_waiters();
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let mut init = HttpRequestInit::get("/slow-head");
    init.head_timeout = Some(Duration::from_millis(300));
    let err = match tokio::time::timeout(Duration::from_secs(10), fetch_http(&client, init)).await {
        Ok(Err(e)) => e,
        Ok(Ok(_resp)) => panic!("head timeout 必须报错"),
        Err(_) => panic!("fetch 超时"),
    };
    assert!(
        err.to_string().contains("head timeout"),
        "unexpected error: {err}"
    );

    // 等 handler 完成（响应就绪）——dispatch 循环头应因 peer_reset 直接止付
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let maybe_tx = probe.lock().await.clone();
        let Some(tx) = maybe_tx else {
            assert!(
                tokio::time::Instant::now() < deadline,
                "handler 未完成（响应未就绪）"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        // reserve 探测：接收器存活恒成功；RESET 已处理则立刻报错
        match tokio::time::timeout(Duration::from_millis(500), tx.reserve()).await {
            Ok(Err(_)) => break, // RESET 已投递并止付（P0 闭合）
            Ok(Ok(permit)) => {
                drop(permit);
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "RESET 未投递：迟到响应未被 peer_reset 拦截"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(_) => panic!("reserve 探测不应超时"),
        }
    }
    let _ = handler_done;
    provider.abort();
}

/// h6：生命周期信号族（0.6.0 sdk-lifecycle-signals）。
/// - HttpRequest.session_id == 会话 id（dispatch 填充；授权隔离键）
/// - 正常完成 → RequestCancel::wait() == Completed（不误报取消）
/// - 挂起流被 client abort → wait() == Cancelled（事件驱动有界，非轮询时序）
/// - 新会话 → session_id 不同（同 peer 异 session 隔离的内核前提）
#[tokio::test]
async fn http_lifecycle_session_id_and_cancel_outcomes() {
    use dweb_fabric::continuity::http::CancelOutcome;

    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    // 观测面：handler 捕获的 (session_id, wait 终裁) 经 channel 回流
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::channel::<([u8; 16], CancelOutcome)>(8);
    let h = handler(move |req: HttpRequest| {
        let seen_tx = seen_tx.clone();
        Box::pin(async move {
            let sid = req.session_id;
            let cancel = req.cancel.clone();
            // wait() 挂起至终裁——与响应供给并行（桥层 watcher 同形态）
            tokio::spawn(async move {
                let outcome = cancel.wait().await;
                let _ = seen_tx.send((sid, outcome)).await;
            });
            let (tx, rx) = body_channel(1);
            // sender 保活（挂起形态：body 永不供给也不 EOF——dispatch 循环
            // 挂在 body.recv()，终裁只能来自对端取消/会话终态）
            std::mem::forget(tx);
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    // —— 请求 1：挂起流 + client abort → Cancelled ——
    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/hang-1")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    resp.abort().await;
    let (sid1, out1) = tokio::time::timeout(Duration::from_secs(10), seen_rx.recv())
        .await
        .expect("cancel 终裁有界")
        .expect("watcher 汇报");
    assert_eq!(out1, CancelOutcome::Cancelled, "abort → Cancelled");
    assert_eq!(
        sid1,
        client.shared().session_id,
        "HttpRequest.session_id == 会话 id"
    );

    // —— 请求 2：同会话 → session_id 稳定 ——
    let resp2 = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/hang-2")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp2.status, 200);
    resp2.abort().await;
    let (sid2, _out2) = tokio::time::timeout(Duration::from_secs(10), seen_rx.recv())
        .await
        .expect("cancel 终裁有界")
        .expect("watcher 汇报");
    assert_eq!(sid1, sid2, "同会话 → session_id 稳定");
    drop(resp2);
    client.close().await;

    client.close().await;
    provider.abort();

    // —— fresh pair：异会话 → session_id 不同（隔离键前提）。不用同 pair
    // 重拨：close 后旧会话 teardown 与新拨号存在确定性收敛窗口（客户端
    // adopt canonical 超时——0.5.0 已知传输层边缘，非本面缺陷，见 change
    // 文档已知问题）——
    let (c, d, _dc, _dd) = pair().await;
    let d_id = d.endpoint_id();
    let c_id = c.endpoint_id();
    let (sid_tx, sid_rx) = tokio::sync::oneshot::channel::<[u8; 16]>();
    let sid_tx = std::sync::Arc::new(tokio::sync::Mutex::new(Some(sid_tx)));
    let h2 = handler(move |req: HttpRequest| {
        let sid_tx = std::sync::Arc::clone(&sid_tx);
        Box::pin(async move {
            if let Some(tx) = sid_tx.lock().await.take() {
                let _ = tx.send(req.session_id);
            }
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: None,
            })
        })
    });
    let provider2 =
        tokio::spawn(async move { serve_http(&d, &c_id, SessionOptions::default(), h2).await });
    let client2 = session::open_session(&c, &d_id, SessionOptions::default())
        .await
        .expect("open 2 (fresh pair)");
    let resp3 = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client2, HttpRequestInit::get("/who")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    let mut resp3 = resp3;
    let _ = resp3.read_all_body().await;
    let sid3 = tokio::time::timeout(Duration::from_secs(10), sid_rx)
        .await
        .expect("sid 回流有界")
        .expect("handler 汇报");
    assert_ne!(sid1, sid3, "异会话 → session_id 不同（隔离键前提）");
    drop(resp3);
    client2.close().await;
    provider2.abort();
}

/// h7：正常完成 → wait() == Completed（Cancelled 误报会污染下游 signal 语义：
/// ai-fly 慢任务据 signal 止损——完成后的假 abort 是正确性缺陷）。
#[tokio::test]
async fn http_lifecycle_completion_not_reported_as_cancel() {
    use dweb_fabric::continuity::http::CancelOutcome;

    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::channel::<CancelOutcome>(4);
    let h = handler(move |req: HttpRequest| {
        let seen_tx = seen_tx.clone();
        Box::pin(async move {
            let cancel = req.cancel.clone();
            tokio::spawn(async move {
                let _ = seen_tx.send(cancel.wait().await).await;
            });
            // 静态响应：meta + FIN → dispatch mark_completed → Completed
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: None,
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/done")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    // 读至 EOF（客户端消费完 = FIN 已达）
    let _ = resp.read_all_body().await;
    let out = tokio::time::timeout(Duration::from_secs(10), seen_rx.recv())
        .await
        .expect("完成终裁有界")
        .expect("watcher 汇报");
    assert_eq!(out, CancelOutcome::Completed, "正常完成不误报取消");
    client.close().await;
    provider.abort();
}

/// h8（R1 P1-1）：handler 错误出口的终裁同步——respond_error(500) 后
/// mark_completed，RequestCancel::wait() 收敛 Completed（修复前：活跃会话上
/// watcher 悬挂至会话终态）。
#[tokio::test]
async fn http_handler_error_settles_cancel_as_completed() {
    use dweb_fabric::continuity::http::CancelOutcome;

    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::channel::<CancelOutcome>(4);
    let h = handler(move |req: HttpRequest| {
        let seen_tx = seen_tx.clone();
        Box::pin(async move {
            let cancel = req.cancel.clone();
            tokio::spawn(async move {
                let _ = seen_tx.send(cancel.wait().await).await;
            });
            // handler 失败 → 引擎 500 → 修复后 mark_completed
            Err(HttpEngineError("boom".into()))
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    // 500 响应也是合法 meta——fetch 正常返回 status 500
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/err")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 500, "handler 失败回 500");
    let out = tokio::time::timeout(Duration::from_secs(10), seen_rx.recv())
        .await
        .expect("终裁有界")
        .expect("watcher 汇报");
    assert_eq!(out, CancelOutcome::Completed, "错误出口终裁 Completed");
    client.close().await;
    provider.abort();
}

/// h9（R1 P1-5）：刻意 close 的流级取消——挂起 handler（无 write）在客户端
/// session.close() 后有界收到 Cancelled（仅 FIN 会被当可恢复断线，修复前
/// 只能等会话死亡/看门狗）。
#[tokio::test]
async fn http_session_close_cancels_hanging_handler() {
    use dweb_fabric::continuity::http::CancelOutcome;

    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::channel::<CancelOutcome>(4);
    let h = handler(move |req: HttpRequest| {
        let seen_tx = seen_tx.clone();
        Box::pin(async move {
            let cancel = req.cancel.clone();
            tokio::spawn(async move {
                let _ = seen_tx.send(cancel.wait().await).await;
            });
            let (tx, rx) = body_channel(1);
            std::mem::forget(tx); // 挂起形态：body 永不供给
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/hang")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    drop(resp);
    // 刻意关闭（非 abort 单流）：close 枚举在途流发 RESET → 对端 watcher 即时
    let t0 = std::time::Instant::now();
    client.close().await;
    let out = tokio::time::timeout(Duration::from_secs(10), seen_rx.recv())
        .await
        .expect("close 后终裁有界")
        .expect("watcher 汇报");
    assert_eq!(out, CancelOutcome::Cancelled, "close 刻意取消 → Cancelled");
    assert!(
        t0.elapsed() < Duration::from_secs(10),
        "close 取消应有界即时（实际 {:?}）",
        t0.elapsed()
    );
    provider.abort();
}

/// h10（真双机实证 2026-09-30）：fetch 活性通道闸门——通道死亡（会话
/// Recovering 窗口）内发起的新 fetch 不再立即失败，等待新代通道安装后
/// 发出（LAN 连接周期性颤动场景：消费端 fetch 不得因瞬断抖成 502/空响应）。
#[tokio::test]
async fn http_fetch_gate_waits_for_channel_reinstall_during_recovery() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let h = handler(|_req: HttpRequest| {
        Box::pin(async move {
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: None,
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/one")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200, "基准 fetch 正常");

    // 注入死亡并等待泵退出（通道 is_dead 置位、phase → Recovering）
    a.continuity_reset(&b_id).await.unwrap();
    let dead_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !client.channel().is_dead() {
        assert!(
            tokio::time::Instant::now() < dead_deadline,
            "通道死亡标记超时"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // 通道已死（会话 Recovering）：并发驱动 resume + 立刻发起新 fetch——
    // 活性闸门让 fetch 等新代安装后发出，而非死通道上 open_stream 快败
    let fetcher = {
        let client = client.clone();
        tokio::spawn(async move {
            tokio::time::timeout(
                Duration::from_secs(25),
                fetch_http(&client, HttpRequestInit::get("/two")),
            )
            .await
            .expect("fetch 有界")
            .expect("fetch 在新代通道上成功")
        })
    };
    client.resume(&a).await.expect("resume");
    let resp2 = fetcher.await.expect("task join");
    assert_eq!(
        resp2.status, 200,
        "Recovering 窗口内的 fetch 经新代通道成功"
    );
    provider.abort();
}

// ---------------------------------------------------------------------------
// r11 B1-B4：体完整性终态语义（abort→FIN 竞速 / 终止原因分类 / 聚合拒吞错 /
// 阶段 A 取消活性）——ports spec「传输中断绝不允许伪装成功」的内核承接面。
// ---------------------------------------------------------------------------

/// h11（r11-B1 active FIN/RESET 交错）：provider 在全量供给刚写完即中止
/// （不 finish）——修复前 dispatch 把 sender Drop 当正常 EOF 发 FIN，客户端
/// 以干净 null 收尾出截断 200。修复后：终态必须 PeerReset（错误），绝无
/// 干净 FIN EOF；聚合读取器（r11-B3）在 RESET 终止时必须 Err（前缀≠完整实体）。
#[tokio::test]
async fn http_provider_abort_midstream_never_clean_eof() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let h = handler(|req: HttpRequest| {
        let shared = Arc::clone(req.body.shared());
        let sid = req.stream_id;
        Box::pin(async move {
            let (tx, rx) = body_channel(8);
            tokio::spawn(async move {
                for i in 0..3u32 {
                    if tx
                        .send(Bytes::from(format!("chunk-{i:02};")))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                // 竞速形态：全量供给刚写完即中止（终态落位 → RESET → 才关 sender）
                shared.abort_stream(sid).await;
                drop(tx);
            });
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");

    // —— 请求 1：逐块读，终态分类必须是 PeerReset（错误），绝非干净 EOF ——
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/race-1")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    let mut got: Vec<u8> = Vec::new();
    let term = loop {
        match tokio::time::timeout(Duration::from_secs(10), resp.recv_body()).await {
            Ok(Ok(c)) => got.extend_from_slice(&c),
            Ok(Err(_)) => break client.shared().stream_term(resp.stream_id).await,
            Err(_) => panic!("读超时（已收 {}B）", got.len()),
        }
    };
    assert_eq!(
        term,
        Some(StreamTerm::PeerReset),
        "abort 竞速必须以 RESET 终结（截断≠干净 EOF）；已收 {}B",
        got.len()
    );

    // —— 请求 2（同形态）：聚合读取器不得把已有前缀当完整实体（r11-B3）——
    let mut resp2 = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/race-2")),
    )
    .await
    .expect("fetch 2 有界")
    .expect("fetch 2 ok");
    let agg = tokio::time::timeout(Duration::from_secs(10), resp2.read_all_body())
        .await
        .expect("聚合有界");
    assert!(
        agg.is_err(),
        "read_all_body 在 RESET 终止时必须 Err（前缀≠完整实体）"
    );
    client.close().await;
    provider.abort();
}

/// h12（r11-B1 Recovering 下 RESET 失败后恢复）：通道死亡窗口内 provider 中止
/// ——best-effort RESET 发送失败；终态（LocalAbort）跨恢复代保留，resume 后由
/// 重放面补发 RESET。客户端终态必须是错误（PeerReset），绝无干净 EOF。
#[tokio::test]
async fn http_provider_abort_reset_survives_recovery() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let kill = Arc::new(tokio::sync::Notify::new());
    let k = Arc::clone(&kill);
    let h = handler(move |req: HttpRequest| {
        let shared = Arc::clone(req.body.shared());
        let sid = req.stream_id;
        let k = Arc::clone(&k);
        Box::pin(async move {
            let (tx, rx) = body_channel(4);
            tokio::spawn(async move {
                if tx.send(Bytes::from_static(b"first-chunk;")).await.is_err() {
                    return;
                }
                k.notified().await; // 主测通知：此时通道已死（RESET 必然发送失败）
                shared.abort_stream(sid).await;
                drop(tx);
            });
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/recover-abort")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    let first = tokio::time::timeout(Duration::from_secs(10), resp.recv_body())
        .await
        .expect("首块有界")
        .expect("首块");
    assert_eq!(&first[..], b"first-chunk;");

    // 注入死亡 → 通道 dead（会话 Recovering）→ 在死通道上中止（RESET 失败）
    a.continuity_reset(&b_id).await.unwrap();
    let dead_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !client.channel().is_dead() {
        assert!(
            tokio::time::Instant::now() < dead_deadline,
            "通道死亡标记超时"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    kill.notify_waiters();
    tokio::time::sleep(Duration::from_millis(300)).await; // 让中止终态落位、失败的 RESET 返回

    // 恢复：重放面补发 RESET——客户端必须以错误终结
    client.resume(&a).await.expect("resume");
    let mut got: Vec<u8> = Vec::new();
    let term = loop {
        match tokio::time::timeout(Duration::from_secs(15), resp.recv_body()).await {
            Ok(Ok(c)) => got.extend_from_slice(&c),
            Ok(Err(_)) => break client.shared().stream_term(resp.stream_id).await,
            Err(_) => panic!("续读超时（已收 {}B）", got.len()),
        }
    };
    assert_eq!(
        term,
        Some(StreamTerm::PeerReset),
        "死通道上的中止经恢复补发 RESET 终结（绝无干净 EOF）；已收 {}B",
        got.len()
    );
    client.close().await;
    provider.abort();
}

/// h13（r11-B2 协议错误终态）：已交付段重发不同内容 → RecvWindow overlap
/// mismatch → 本地以 ProtocolError 终结（remote_final + 回 RESET），recv 报
/// 错而非「stream ended」；回环 RESET 使发送侧同流 PeerReset（双端流死）。
#[tokio::test]
async fn session_overlap_mismatch_terminates_stream_as_protocol_error() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let provider = tokio::spawn(async move {
        let session = session::accept_any(&b, &a_id, opts).await.expect("accept");
        let Some(sid) = session.next_incoming().await else {
            panic!("无入站流");
        };
        let first = session.recv(sid).await.expect("首段交付");
        assert_eq!(&first[..], b"AAAA");
        let second = session.recv(sid).await;
        let term = session.shared().stream_term(sid).await;
        (second, term)
    });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let sid = client.open_stream("k-err").await.expect("open");
    client
        .send_data(sid, Bytes::from_static(b"AAAA"))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await; // 交付窗口
    // 冲突段：同 offset 不同内容（越过 journal 正常路径的裸帧注入）
    client
        .channel()
        .send_frame(&Frame {
            frame_type: FrameType::Data,
            flags: 0,
            session_id: client.shared().session_id,
            stream_id: sid,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from_static(b"BBBB"),
        })
        .await
        .unwrap();

    let (second, term) = tokio::time::timeout(Duration::from_secs(10), provider)
        .await
        .expect("provider join 有界")
        .expect("provider task");
    assert!(second.is_err(), "协议错误后 recv 必须报错");
    assert_eq!(
        term,
        Some(StreamTerm::ProtocolError),
        "overlap mismatch 归类为协议错误（非干净 stream ended）"
    );
    // 回环 RESET：发送侧同流终结为 PeerReset（有界等待）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while client.shared().stream_term(sid).await != Some(StreamTerm::PeerReset) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "回环 RESET 未到达发送侧"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    client.close().await;
}

/// h14（r11-B2 会话丢失终态 + r11-B3）：响应体在途时本端刻意 close——
/// 会话终态后读取必须以错误终结（非悬挂、非干净成功），聚合读取器把已有
/// 前缀的截断流按 Err 返回。
#[tokio::test]
async fn http_session_close_terminates_pending_body_as_error() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let h = handler(|_req: HttpRequest| {
        Box::pin(async move {
            let (tx, rx) = body_channel(2);
            tokio::spawn(async move {
                // 慢速长流：永不 finish（close 时流必在途）
                for i in 0..1000u32 {
                    if tx.send(Bytes::from(format!("slow-{i:04};"))).await.is_err() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            });
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/slow")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    let _first = tokio::time::timeout(Duration::from_secs(10), resp.recv_body())
        .await
        .expect("首块有界")
        .expect("首块");
    client.close().await;
    let agg = tokio::time::timeout(Duration::from_secs(10), resp.read_all_body())
        .await
        .expect("聚合必须有限期终结（非悬挂）");
    assert!(
        agg.is_err(),
        "会话丢失后 read_all_body 必须 Err（截断前缀≠完整实体）"
    );
    provider.abort();
}

/// h15（r11-B4 阶段 A 取消活性）：Recovering 闸门等待中外 部取消——fetch 必须
/// 即时结算（远小于 head 预算）、provider handler 零启动（取消先于 OPEN）。
#[tokio::test]
async fn http_fetch_cancel_during_recovery_gate_settles_immediately() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let gated_execs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let exec = Arc::clone(&gated_execs);
    let h = handler(move |req: HttpRequest| {
        let exec = Arc::clone(&exec);
        Box::pin(async move {
            if req.path == "/gated" {
                exec.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: None,
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    // 注入死亡并等泵退出（会话 Recovering、通道 dead）
    a.continuity_reset(&b_id).await.unwrap();
    let dead_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !client.channel().is_dead() {
        assert!(
            tokio::time::Instant::now() < dead_deadline,
            "通道死亡标记超时"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let cancel = Arc::new(FetchCancel::default());
    let t0 = std::time::Instant::now();
    let fetcher = {
        let client = client.clone();
        let cancel = Arc::clone(&cancel);
        tokio::spawn(async move {
            let mut init = HttpRequestInit::get("/gated");
            init.head_timeout = Some(Duration::from_secs(5));
            init.cancel = Some(cancel);
            tokio::time::timeout(Duration::from_secs(10), fetch_http(&client, init)).await
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await; // fetch 挂在活性闸门
    cancel.fire();
    let out = tokio::time::timeout(Duration::from_secs(5), fetcher)
        .await
        .expect("取消结算有界")
        .expect("task join")
        .expect("fetch 有界");
    let err = match out {
        Err(e) => e,
        Ok(_) => panic!("闸门期取消必须失败"),
    };
    assert!(
        err.to_string().contains("cancelled"),
        "unexpected error: {err}"
    );
    assert!(
        t0.elapsed() < Duration::from_secs(2),
        "取消必须即时结算（实际 {:?}，预算 5s）",
        t0.elapsed()
    );
    assert_eq!(
        gated_execs.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "provider handler 零启动（取消先于 OPEN）"
    );
    client.close().await;
    provider.abort();
}

/// h16（r11-B4 单一 head 预算）：活性闸门消耗预算的一部分后通道恢复——
/// 头等待只能用**剩余**预算：整次 head 操作总时长 ≤ 单一配置预算（+调度
/// 余量）。修复前两段各占满额预算（闸门 R + 头等待 T），总量 R+T 违约。
#[tokio::test]
async fn http_fetch_head_budget_is_single_shared_deadline() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let budget = Duration::from_secs(2);

    // handler 挂起不响应（head 永不达——预算耗尽的确定性来源）
    let h = handler(|_req: HttpRequest| {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_secs(15)).await;
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: None,
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    a.continuity_reset(&b_id).await.unwrap();
    let dead_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !client.channel().is_dead() {
        assert!(
            tokio::time::Instant::now() < dead_deadline,
            "通道死亡标记超时"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let t0 = std::time::Instant::now();
    let fetcher = {
        let client = client.clone();
        tokio::spawn(async move {
            let mut init = HttpRequestInit::get("/budget");
            init.head_timeout = Some(budget);
            tokio::time::timeout(budget * 5, fetch_http(&client, init)).await
        })
    };
    // 闸门先消耗预算的 60%（判别力要求：修复前的双 deadline 形态——闸门满额
    // R + 头等待再满额 T——在 R=1.2s 时总时长 ≈3.2s，必然击穿 budget+500ms；
    // 单一 deadline 形态总时长恒 ≈budget）
    tokio::time::sleep(Duration::from_millis(1200)).await;
    client.resume(&a).await.expect("resume"); // 通道恢复（闸门退出、OPEN 发出）

    let out = fetcher.await.expect("task join").expect("fetch 有界");
    let err = match out {
        Err(e) => e,
        Ok(_) => panic!("挂起 handler 下 head 必然超时"),
    };
    assert!(
        err.to_string().contains("head timeout"),
        "unexpected error: {err}"
    );
    let elapsed = t0.elapsed();
    assert!(
        elapsed <= budget + Duration::from_millis(500),
        "整次 head 操作总时长必须 ≤ 单一预算+调度余量（实际{elapsed:?}，预算 {budget:?}）"
    );
    client.close().await;
    provider.abort();
}

/// h17（r12-B3 活动 LocalAbort 终结）：客户端在 **Active** 会话上本地中止
/// 响应流（`resp.abort()`）后，聚合读取必须以 Err 有限期终结。修复前
/// `mark_local_abort` 只设 term 不设 `remote_final`，`recv()` 等不到「远端
/// 终局水位到达」→ `read_all_body` 悬挂（h14 靠 close 后 Dead/Closed 收敛、
/// h11 是对端 RESET，均不覆盖此路径）。已排队前缀仍可读，随后 Err。
#[tokio::test]
async fn http_client_abort_on_active_session_terminates_read_all() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    // 慢速长流：持续供给、永不结束——中止时对端流必须仍未终局
    let h = handler(|_req: HttpRequest| {
        Box::pin(async move {
            let (tx, rx) = body_channel(2);
            tokio::spawn(async move {
                for i in 0..100_000u32 {
                    if tx
                        .send(Bytes::from(format!("prefix-{i:04};")))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            });
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/abort-active")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    let first = tokio::time::timeout(Duration::from_secs(10), resp.recv_body())
        .await
        .expect("首块有界")
        .expect("首块");
    assert!(!first.is_empty(), "中止前前缀必须可读");

    // Active 会话上的本地中止（终态落位 + best-effort RESET）
    assert_eq!(
        client.shared().phase().await,
        SessionPhase::Active,
        "中止时会话必须 Active（区别于 h14 的 close 后聚合）"
    );
    resp.abort().await;

    let t0 = Instant::now();
    let agg = tokio::time::timeout(Duration::from_secs(5), resp.read_all_body())
        .await
        .expect("read_all_body 必须有限期终结（修复前悬挂）");
    assert!(
        agg.is_err(),
        "本地中止后 read_all_body 必须 Err（前缀≠完整实体）"
    );
    assert!(t0.elapsed() < Duration::from_secs(5));
    assert_eq!(
        client.shared().stream_term(resp.stream_id).await,
        Some(StreamTerm::LocalAbort),
        "终态分类必须 LocalAbort（粘滞）"
    );
    client.close().await;
    provider.abort();
}

/// h18（r12-B3 供给面中止的请求体读终结）：provider 在 Active 会话上对请求
/// 流本地中止（StreamWriter abort 的内核等价路径：`abort_stream` 终态落位）
/// 后，handler 侧 `RequestBody::read_all()` 必须以 Err 有限期终结——请求体
/// 传输失败以错误暴露，绝不悬挂。
#[tokio::test]
async fn http_provider_local_abort_terminates_request_body_read_all() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    // (read_all 是否 Err, 是否外层超时)——handler 返回响应头即已结算完成
    let outcome: Arc<std::sync::Mutex<Option<(bool, bool)>>> = Arc::default();
    let o = Arc::clone(&outcome);
    let h = handler(move |req: HttpRequest| {
        let shared = Arc::clone(req.body.shared());
        let sid = req.stream_id;
        let o = Arc::clone(&o);
        Box::pin(async move {
            let first = req.body.recv().await.expect("首块请求体交付");
            assert!(!first.is_empty());
            // Active 会话上本地中止（终态落位 + best-effort RESET）
            shared.abort_stream(sid).await;
            let agg = tokio::time::timeout(Duration::from_secs(5), req.body.read_all()).await;
            let (is_err, timed_out) = match agg {
                Ok(r) => (r.is_err(), false),
                Err(_) => (false, true),
            };
            *o.lock().unwrap() = Some((is_err, timed_out));
            Ok(HttpResponse {
                status: 200,
                headers: vec![],
                body: None,
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    // keep_open：请求方向不 FIN——中止时请求流必须仍未终局。
    // fetch 不作结算断言：中止后响应 meta 按终态流幂等丢弃属预期（消费端
    // 以错误收敛）；本用例的断言面是 handler 侧 read_all 的终结性。
    let fetcher = {
        let client = client.clone();
        tokio::spawn(async move {
            let mut init =
                HttpRequestInit::post("/req-abort", Bytes::from_static(b"req-prefix-0;"));
            init.keep_open = true;
            let _ = fetch_http(&client, init).await;
        })
    };

    let deadline = Instant::now() + Duration::from_secs(10);
    let (is_err, timed_out) = loop {
        if let Some(o) = *outcome.lock().unwrap() {
            break o;
        }
        assert!(
            Instant::now() < deadline,
            "handler 未结算（read_all 悬挂 = 回归）"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(!timed_out, "read_all 不得悬挂（修复前外层超时）");
    assert!(
        is_err,
        "本地中止后 RequestBody::read_all 必须 Err（前缀≠完整实体）"
    );
    fetcher.abort();
    client.close().await;
    provider.abort();
}

/// h19（r12-B1 路径 b「FIN 已登记后 abort」）：provider 干净半关（FIN 已上
/// wire、final_sent 已登记）之后本地中止——消费端绝不以干净 null 收尾：
/// RESET 随后到达把终态粘滞升级为错误，`read_all_body` 必须 Err。barrier 控制
/// 读取时机（消费端在 provider 中止完成前不读——钉发送侧 first-terminal
/// 仲裁后的消费端终态，规避两帧处理间隙的读取窗口）。修复前
/// `fin_resent_streams` 无条件收集 final_sent 流、abort 不清除 FIN 面——
/// 恢复/竞速形态下 FIN 可先于 RESET 成为可观察 EOF。
#[tokio::test]
async fn http_fin_registered_then_abort_never_clean_eof() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let abort_now = Arc::new(tokio::sync::Notify::new());
    let ab = Arc::clone(&abort_now);
    let h = handler(move |req: HttpRequest| {
        let shared = Arc::clone(req.body.shared());
        let sid = req.stream_id;
        let ab = Arc::clone(&ab);
        Box::pin(async move {
            let (tx, rx) = body_channel(4);
            // feeder：prefix → 关供给（dispatch 走正常 FIN、final_sent 登记）
            // → 等主测确认 FIN 已被对端处理 → 中止（RESET 随 FIN 之后）
            tokio::spawn(async move {
                if tx
                    .send(Bytes::from_static(b"fin-then-abort-prefix;"))
                    .await
                    .is_err()
                {
                    return;
                }
                drop(tx); // 供给关闭 → dispatch 走正常 FIN（final_sent 登记）
                ab.notified().await; // 主测确认 FIN 送达后才放行（后到终态）
                shared.abort_stream(sid).await;
            });
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/fin-then-abort")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);

    // barrier 1（轮询观察）：provider 的 FIN 实际送达并被客户端 pump 处理
    //（term=Fin = final_sent 已登记且 FIN 已上 wire 的可观察证据）
    {
        let deadline = Instant::now() + Duration::from_secs(10);
        while client.shared().stream_term(resp.stream_id).await != Some(StreamTerm::Fin) {
            assert!(
                Instant::now() < deadline,
                "FIN 未送达（term 未落 Fin——前置条件不满足）"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    // barrier 2：FIN 已登记（客户端已处理）后释放中止——RESET 随 FIN 之后
    abort_now.notify_waiters();
    {
        let deadline = Instant::now() + Duration::from_secs(10);
        while client.shared().stream_term(resp.stream_id).await != Some(StreamTerm::PeerReset) {
            assert!(
                Instant::now() < deadline,
                "abort 后 RESET 未把终态升级为 PeerReset（截断不得停留干净 Fin）"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    // 消费端聚合：前缀可读但绝不以干净 EOF 收尾（read_all_body 必须 Err）
    let agg = tokio::time::timeout(Duration::from_secs(10), resp.read_all_body())
        .await
        .expect("聚合有界");
    assert!(
        agg.is_err(),
        "FIN 后 abort 的流必须以错误终结（read_all_body 绝不干净成功）"
    );
    assert_eq!(
        client.shared().stream_term(resp.stream_id).await,
        Some(StreamTerm::PeerReset),
        "终态粘滞：RESET 升级后不得回落 Fin"
    );
    client.close().await;
    provider.abort();
}

/// h20（r12-B1 路径 c「恢复期 active 与 Recovering 竞速」）：provider 已干净
/// 半关（FIN 送达）、连接死亡窗口内本地中止（RESET 发送失败）→ 恢复重放面
/// **不得重放该流的 FIN**（final_sent 在中止落位时原子清除——直接断言面），
/// RESET 补发后消费端以错误终结。修复前 final_sent 保留 + 重放顺序
/// FIN-then-RESET：消费端可在 RESET 处理前把 FIN 映射为干净 EOF（null）。
#[tokio::test]
async fn http_abort_after_fin_survives_recovery_without_fin_replay() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let abort_now = Arc::new(tokio::sync::Notify::new());
    // provider 侧终态快照（中止后、恢复前）：(term, final_sent)
    type TermSnap = Arc<std::sync::Mutex<Option<(Option<StreamTerm>, Option<u64>)>>>;
    let provider_snap: TermSnap = Arc::default();
    let ab = Arc::clone(&abort_now);
    let snap = Arc::clone(&provider_snap);
    let h = handler(move |req: HttpRequest| {
        let shared = Arc::clone(req.body.shared());
        let sid = req.stream_id;
        let ab = Arc::clone(&ab);
        let snap = Arc::clone(&snap);
        Box::pin(async move {
            let (tx, rx) = body_channel(4);
            tokio::spawn(async move {
                if tx
                    .send(Bytes::from_static(b"recover-no-fin-replay;"))
                    .await
                    .is_err()
                {
                    return;
                }
                drop(tx); // 正常半关 → FIN 上 wire
                ab.notified().await; // 主测在通道死亡后才放行（RESET 必然失败）
                shared.abort_stream(sid).await;
                // provider 侧快照：中止后 final_sent 必须已清除（r12-B1 修复面）
                let term = shared.stream_term(sid).await;
                let final_sent = shared.debug_final_sent(sid).await;
                *snap.lock().unwrap() = Some((term, final_sent));
            });
            Ok(HttpResponse {
                status: 200,
                headers: vec![Header::new("content-type", "text/plain")],
                body: Some(rx),
            })
        })
    });
    let provider = tokio::spawn(async move { serve_http(&b, &a_id, opts, h).await });

    let client = session::open_session(&a, &b_id, SessionOptions::default())
        .await
        .expect("open");
    let mut resp = tokio::time::timeout(
        Duration::from_secs(20),
        fetch_http(&client, HttpRequestInit::get("/recover-no-fin-replay")),
    )
    .await
    .expect("fetch 有界")
    .expect("fetch ok");
    assert_eq!(resp.status, 200);
    let first = tokio::time::timeout(Duration::from_secs(10), resp.recv_body())
        .await
        .expect("首块有界")
        .expect("首块");
    assert_eq!(&first[..], b"recover-no-fin-replay;");
    // FIN 实际送达并被客户端 pump 处理（term=Fin——final_sent 已登记证据）
    {
        let deadline = Instant::now() + Duration::from_secs(10);
        while client.shared().stream_term(resp.stream_id).await != Some(StreamTerm::Fin) {
            assert!(Instant::now() < deadline, "FIN 未送达（前置条件不满足）");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    // 连接死亡 → Recovering 窗口内中止（RESET best-effort 失败，终态跨代保留）
    a.continuity_reset(&b_id).await.unwrap();
    let dead_deadline = Instant::now() + Duration::from_secs(10);
    while !client.channel().is_dead() {
        assert!(Instant::now() < dead_deadline, "通道死亡标记超时");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    abort_now.notify_waiters();
    tokio::time::sleep(Duration::from_millis(300)).await; // 中止终态落位、失败的 RESET 返回

    // 直接断言面（r12-B1）：provider 侧中止原子清除 FIN 重放面——恢复轮
    // 不重放该流的 FIN（修复前 final_sent 保留 → FIN 先于 RESET 可观察）
    let (provider_term, provider_final_sent) = provider_snap
        .lock()
        .unwrap()
        .expect("provider 快照已落（中止路径已执行）");
    assert_eq!(
        provider_term,
        Some(StreamTerm::LocalAbort),
        "中止终态跨死亡窗口保留"
    );
    assert_eq!(
        provider_final_sent, None,
        "中止必须原子清除 final_sent（恢复重放面不得再含该 FIN）"
    );

    // 恢复：重放面只补发 RESET（FIN 面已清除）——先轮询终态升级为 PeerReset
    //（终态停留干净 Fin = 重放面违约/RESET 未补发），聚合面随后断言。
    client.resume(&a).await.expect("resume");
    {
        let deadline = Instant::now() + Duration::from_secs(15);
        while client.shared().stream_term(resp.stream_id).await != Some(StreamTerm::PeerReset) {
            assert!(
                Instant::now() < deadline,
                "恢复后 RESET 未补发（终态停留干净 Fin = 体完整性违约）"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    let agg = tokio::time::timeout(Duration::from_secs(10), resp.read_all_body())
        .await
        .expect("聚合有界");
    assert!(
        agg.is_err(),
        "恢复竞速后的流必须以错误终结（read_all_body 绝不干净成功）"
    );
    client.close().await;
    provider.abort();
}
