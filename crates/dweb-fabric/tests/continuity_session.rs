//! app-protocol-layer Phase 2 集成验收（tasks 3.1-3.5，design §6）。
//!
//! 覆盖：
//! - SESSION_INIT 握手 + 双向流往返 + 副作用状态机（Accepted→Started→Completed）
//! - ACK 推进后 journal 释放（双端）
//! - SSE 中途断线续传：断在多个 chunk 边界后恢复，字节级精确重组（去重证明）
//!   ——「已生成的 token 不作废」的核心验收
//! - provider 已 STARTED、响应未返回时断线：恢复轮不重执行（exec==1），
//!   响应在恢复后送达
//! - RESUME 拒绝面：未知会话 → REQUEST_STATE_LOST；已知会话错 token →
//!   TOKEN_INVALID（两代滑窗的 e2e 面；窗口挤出语义在 session.rs 单测）
//! - 多流并发恢复：大流 + 小流同时重放，双双字节精确完成（轮转交织的
//!   e2e 面；公平性序在 session.rs 单测）
//!
//! 运行：`--test-threads=1`（固定端口跨测试竞争）。

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use dweb_fabric::continuity::session::{
    self, reject_reason, encode_resume_init, RequestState, SessionOptions,
};
use dweb_fabric::continuity::{Direction, Frame, FrameType};
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

/// 成员关系就绪的 fabric 对（复刻 continuity_state.rs 装配）。
async fn pair() -> (Fabric, Fabric, tempfile::TempDir, tempfile::TempDir) {
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let port_a = reserve_loopback_port();
    let port_b = reserve_loopback_port();
    let a = Fabric::create_root(cfg_fixed_port(&dir_a, port_a)).await.unwrap();
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

/// 等 OPEN 落地（副作用状态机可见）。
async fn wait_request(session: &session::Session, stream: u64, label: &str) -> RequestState {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(s) = session.request_state(stream).await {
            return s;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "OPEN 未到达: {label}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 读流到终结，聚合全部字节。
async fn drain_stream(client: &session::Session, stream: u64, label: &str) -> Vec<u8> {
    let mut got = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(15), client.recv(stream)).await {
            Ok(Ok(chunk)) => got.extend_from_slice(&chunk),
            Ok(Err(_)) => return got,
            Err(_) => panic!("recv 超时: {label}（已收 {}B）", got.len()),
        }
    }
}

/// 有界建立会话（握手死等防御）。
async fn open_session_bounded(
    fabric: &Fabric,
    peer: &str,
    opts: SessionOptions,
) -> session::Session {
    tokio::time::timeout(Duration::from_secs(30), session::open_session(fabric, peer, opts))
        .await
        .expect("open_session 有界")
        .expect("open_session 成功")
}

/// s1：握手 + 双向流 + 状态机 + ACK 驱动 journal 释放（双端）。
#[tokio::test]
async fn session_handshake_roundtrip_and_ack_release() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let provider = tokio::spawn(async move {
        let session = session::accept_any(&b, &a_id, opts).await.expect("accept");
        let req = session.recv(1).await.expect("request body");
        assert_eq!(&req[..], b"ping");
        assert_eq!(
            session.request_state(1).await,
            Some(RequestState::Accepted),
            "OPEN 落地即 ACCEPTED"
        );
        session.mark_started(1).await;
        session.send_data(1, Bytes::from_static(b"pong")).await.unwrap();
        session.finish(1).await.unwrap();
        session.mark_completed(1).await;
        session
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream("k1").await.expect("open_stream");
    assert_eq!(s, 1, "client 首流 id = 1（奇数）");
    client.send_data(s, Bytes::from_static(b"ping")).await.unwrap();
    client.finish(s).await.unwrap();
    let resp = client.recv(s).await.expect("response");
    assert_eq!(&resp[..], b"pong");
    // 流终结
    assert!(client.recv(s).await.is_err(), "FIN 后 recv 终结");

    let provider = provider.await.unwrap();
    assert_eq!(provider.request_state(1).await, Some(RequestState::Completed));

    // ACK 推进后 journal 释放（双端；有界轮询）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while client.shared().journal_held_bytes(s).await > 0
        || provider.shared().journal_held_bytes(1).await > 0
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "ACK 未释放 journal：client={} provider={}",
            client.shared().journal_held_bytes(s).await,
            provider.shared().journal_held_bytes(1).await
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// s2：SSE 中途断线续传——断在多个 chunk 边界，字节级精确重组 + 上游执行恰好一次。
#[tokio::test]
async fn session_resume_mid_stream_sse() {
    for cut in [1usize, 3, 6] {
        sse_case(cut).await;
    }
}

async fn sse_case(cut: usize) {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let exec_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    // SSE 内容：8 个互异 chunk（拼接即期望流）
    let chunks: Vec<Bytes> = (0..8u32)
        .map(|i| Bytes::from(format!("chunk-{i:02};").repeat(64)))
        .collect();
    let expected: Vec<u8> = chunks.iter().flat_map(|c| c.iter().copied()).collect();

    let exec = Arc::clone(&exec_count);
    let provider = tokio::spawn(async move {
        loop {
            let Ok(session) = session::accept_any(&b, &a_id, opts).await else {
                continue; // 拒绝/死流：继续接受
            };
            match wait_request(&session, 1, "sse").await {
                RequestState::Started | RequestState::Completed => {
                    // 恢复轮：journal 重放已由协议层 accept_resume 完成
                }
                _ => {
                    if exec.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        let _ = session.recv(1).await; // 请求体
                        session.mark_started(1).await;
                        for c in &chunks {
                            session.send_data(1, c.clone()).await.unwrap();
                        }
                        session.finish(1).await.unwrap();
                        session.mark_completed(1).await;
                    }
                }
            }
        }
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream(&format!("sse-{cut}")).await.unwrap();
    client
        .send_data(s, Bytes::from_static(b"GET /sse"))
        .await
        .unwrap();
    client.finish(s).await.unwrap();

    // 读 cut 个 chunk 后注入死亡（任意断点；已交付队列/未 ACK 重放均须闭合）
    let mut got = Vec::new();
    for _ in 0..cut {
        match tokio::time::timeout(Duration::from_secs(10), client.recv(s)).await {
            Ok(Ok(c)) => got.extend_from_slice(&c),
            Ok(Err(_)) => break,
            Err(_) => panic!("cut={cut} 首段读超时"),
        }
    }
    a.continuity_reset(&b_id).await.unwrap();
    client.resume(&a).await.expect("resume");
    assert_eq!(client.phase().await, session::SessionPhase::Active);

    let rest = drain_stream(&client, s, &format!("sse cut={cut}")).await;
    got.extend_from_slice(&rest);
    assert_eq!(
        got, expected,
        "cut={cut}：断点续传必须字节级精确（重复交付即失败）"
    );
    assert_eq!(
        exec_count.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "cut={cut}：上游执行恰好一次"
    );
    provider.abort();
}

/// s3：provider 已 STARTED、响应未返回时断线——不重执行；响应在恢复轮送达。
#[tokio::test]
async fn session_started_not_reexecuted_pending_response() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let exec_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let started_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let exec = Arc::clone(&exec_count);
    let started = Arc::clone(&started_flag);
    let provider = tokio::spawn(async move {
        loop {
            let Ok(session) = session::accept_any(&b, &a_id, opts).await else {
                continue;
            };
            match wait_request(&session, 1, "pending").await {
                RequestState::Started | RequestState::Completed => {
                    // 恢复轮：不重执行；此刻补发响应（模型：上游结果就绪）
                    session.send_data(1, Bytes::from_static(b"late-pong")).await.unwrap();
                    session.finish(1).await.unwrap();
                    session.mark_completed(1).await;
                }
                _ => {
                    exec.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = session.recv(1).await;
                    session.mark_started(1).await;
                    started.store(true, std::sync::atomic::Ordering::SeqCst);
                    // 故意不发响应——断线窗口内上游仍在「执行」
                }
            }
        }
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream("pending-1").await.unwrap();
    client.send_data(s, Bytes::from_static(b"ping")).await.unwrap();
    client.finish(s).await.unwrap();

    // 确定性断点：等 provider 真实进入 STARTED 再注入死亡
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !started_flag.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(tokio::time::Instant::now() < deadline, "provider 未 STARTED");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    a.continuity_reset(&b_id).await.unwrap();
    client.resume(&a).await.expect("resume");

    let got = drain_stream(&client, s, "pending").await;
    assert_eq!(got, b"late-pong".to_vec(), "响应在恢复轮送达");
    assert_eq!(
        exec_count.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "STARTED 不得重执行"
    );
    provider.abort();
}

/// s4：RESUME 拒绝面——未知会话 REQUEST_STATE_LOST；已知会话错 token TOKEN_INVALID。
#[tokio::test]
async fn session_resume_rejects_unknown_and_bad_token() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    // 常驻 provider（拒绝路径返回 Err 后继续接受）
    let provider = tokio::spawn(async move {
        loop {
            let _ = session::accept_any(&b, &a_id, opts).await;
        }
    });

    // 真实会话（注册表落名）
    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream("k").await.unwrap();
    client.send_data(s, Bytes::from_static(b"x")).await.unwrap();

    // 注入器 A：未知会话 → REQUEST_STATE_LOST（进程重启语义）
    let mut raw = a.continuity_open_transport(&b_id).await.unwrap();
    let unknown_sid = [0xAAu8; 16];
    raw.send(&Frame {
        frame_type: FrameType::ResumeInit,
        flags: 0,
        session_id: unknown_sid,
        stream_id: 0,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::from(encode_resume_init(1, 1, &[0u8; 16], &[7u8; 16], &[])),
    })
    .await
    .unwrap();
    let resp = tokio::time::timeout(Duration::from_secs(10), raw.recv())
        .await
        .expect("reject 有界返回")
        .unwrap();
    assert_eq!(resp.frame_type, FrameType::ResumeReject);
    assert_eq!(resp.payload[0], reject_reason::REQUEST_STATE_LOST);
    drop(raw);

    // 注入器 B：已知会话 + 错 token → TOKEN_INVALID（两代滑窗不匹配）
    let mut raw2 = a.continuity_open_transport(&b_id).await.unwrap();
    raw2
        .send(&Frame {
            frame_type: FrameType::ResumeInit,
            flags: 0,
            session_id: client.shared().session_id,
            stream_id: 0,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from(encode_resume_init(
                1,
                1,
                &[0u8; 16],
                &[7u8; 16],
                &[],
            )),
        })
        .await
        .unwrap();
    let resp2 = tokio::time::timeout(Duration::from_secs(10), raw2.recv())
        .await
        .expect("reject 有界返回")
        .unwrap();
    assert_eq!(resp2.frame_type, FrameType::ResumeReject);
    assert_eq!(resp2.payload[0], reject_reason::TOKEN_INVALID);
    drop(raw2);

    // 真实会话不受注入干扰：通道仍可健康发送（provider 侧无响应 FIN，
    // 不做终结断言——那需要 provider 应用配合半关）
    client
        .send_data(s, Bytes::from_static(b"more"))
        .await
        .expect("真实会话通道不受注入干扰");
    client.finish(s).await.unwrap();

    // 真实会话还可恢复（两代滑窗轮换后旧 token 失效、新 token 生效）
    a.continuity_reset(&b_id).await.unwrap();
    client.resume(&a).await.expect("真实会话恢复成功");
    assert_eq!(client.phase().await, session::SessionPhase::Active);
    provider.abort();
}

/// s5：多流并发恢复——大流（多段）+ 小流（单段）同时重放，双双字节精确。
#[tokio::test]
async fn session_multi_stream_resume_interleaved() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let big: Vec<Bytes> = (0..12u32)
        .map(|i| Bytes::from(format!("big-{i:02};").repeat(512)))
        .collect();
    let small = Bytes::from_static(b"small-payload");
    let small_expected = small.to_vec();
    let big_expected: Vec<u8> = big.iter().flat_map(|c| c.iter().copied()).collect();

    let provider = tokio::spawn(async move {
        loop {
            let Ok(session) = session::accept_any(&b, &a_id, opts).await else {
                continue;
            };
            let s1 = wait_request(&session, 1, "big").await;
            let s3 = wait_request(&session, 3, "small").await;
            if matches!(s1, RequestState::Accepted) && matches!(s3, RequestState::Accepted) {
                session.mark_started(1).await;
                session.mark_started(3).await;
                for c in &big {
                    session.send_data(1, c.clone()).await.unwrap();
                }
                session.send_data(3, small.clone()).await.unwrap();
                session.finish(1).await.unwrap();
                session.finish(3).await.unwrap();
                session.mark_completed(1).await;
                session.mark_completed(3).await;
            }
            // 恢复轮：重放由协议层完成（accept_resume 轮转交织）
        }
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s1 = client.open_stream("big").await.unwrap();
    let s3 = client.open_stream("small").await.unwrap();
    assert_eq!((s1, s3), (1, 3));
    client.send_data(s1, Bytes::from_static(b"req-big")).await.unwrap();
    client.finish(s1).await.unwrap();
    client.send_data(s3, Bytes::from_static(b"req-small")).await.unwrap();
    client.finish(s3).await.unwrap();

    // 读到大流首段后立即注入死亡（两流响应均未完）
    let _first = tokio::time::timeout(Duration::from_secs(10), client.recv(s1))
        .await
        .expect("big 首段")
        .expect("big 首段数据");
    a.continuity_reset(&b_id).await.unwrap();
    client.resume(&a).await.expect("resume");

    // 双流聚合：首段 + 余量；字节级精确即重放去重证明
    let mut big_got = _first.to_vec();
    big_got.extend_from_slice(&drain_stream(&client, s1, "big").await);
    let small_got = drain_stream(&client, s3, "small").await;
    assert_eq!(big_got, big_expected, "大流恢复后字节级精确");
    assert_eq!(small_got, small_expected, "小流恢复后字节级精确");
    provider.abort();
}
