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
use std::time::Duration;

use bytes::Bytes;
use dweb_fabric::continuity::http::{
    fetch_http, serve_http, Header, HttpEngineError, HttpHandler, HttpRequest, HttpRequestInit,
    HttpResponse,
};
use dweb_fabric::continuity::session::{self, RequestState, SessionOptions};
use dweb_fabric::{
    Fabric, FabricConfig, HttpProxyConfig, RelayConfig, RelayTlsTrust, SecretInjection,
    JOIN_TIMEOUT_MS_DEFAULT,
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
