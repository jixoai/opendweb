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
    self, decode_resume_ok, encode_session_init, reject_reason, encode_resume_init,
    RequestState, SessionOptions,
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

/// s6（硬化 P0-1）：并发双 RESUME 同 token——恰一个 RESUME_OK、一个
/// TOKEN_INVALID（try_rotate 原子裁决 + Active 期 previous 闸门）。
#[tokio::test]
async fn session_concurrent_double_resume_single_winner() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let provider = tokio::spawn(async move {
        loop {
            let _ = session::accept_any(&b, &a_id, opts).await;
        }
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let (token_gen, token) = client.shared().debug_current_token();
    let sid = client.shared().session_id;

    // 双 raw transport 并发注入同 (generation, token) 的 RESUME
    let send_resume = |mut t: dweb_fabric::continuity::ContinuityTransport| async move {
        t.send(&Frame {
            frame_type: FrameType::ResumeInit,
            flags: 0,
            session_id: sid,
            stream_id: 0,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from(encode_resume_init(token_gen, token_gen, &[0u8; 16], &token, &[])),
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), t.recv())
            .await
            .expect("resume 响应有界")
            .unwrap()
    };
    let send_resume_with_nonce =
        |mut t: dweb_fabric::continuity::ContinuityTransport, nonce: [u8; 16]| async move {
            t.send(&Frame {
                frame_type: FrameType::ResumeInit,
                flags: 0,
                session_id: sid,
                stream_id: 0,
                direction: Direction::ClientToProvider,
                byte_offset: 0,
                payload: Bytes::from(encode_resume_init(
                    token_gen,
                    token_gen,
                    &nonce,
                    &token,
                    &[],
                )),
            })
            .await
            .unwrap();
            tokio::time::timeout(Duration::from_secs(10), t.recv())
                .await
                .expect("resume 响应有界")
                .unwrap()
        };
    let t1 = a.continuity_open_transport(&b_id).await.unwrap();
    let t2 = a.continuity_open_transport(&b_id).await.unwrap();
    // —— R3 语义矩阵（Codex 复评步骤 6）——
    // 1) 同 nonce 并发双发（OK-lost 重试形态）：双 OK 且载荷**完全一致**
    //    （幂等缓存重发——不二次轮换，generation 恰前进一次）
    let (r1, r2) = tokio::join!(send_resume(t1), send_resume(t2));
    let mut oks = 0usize;
    let mut results: Vec<(u64, [u8; 16])> = Vec::new();
    for r in [r1, r2] {
        match r.frame_type {
            FrameType::ResumeOk => {
                oks += 1;
                results.push(decode_resume_ok(&r.payload).expect("RESUME_OK 载荷可解析"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(oks, 2, "同 nonce 并发 = 幂等路径：双方都得 OK");
    assert_eq!(
        results[0], results[1],
        "幂等重发同一 (generation, token)——不二次轮换"
    );
    assert_eq!(
        results[0].0,
        token_gen + 1,
        "generation 恰前进一次（单次轮换）"
    );
    // 2) 异 nonce 携 previous 凭据：拒绝（单胜——previous 仅经 nonce 绑定
    //    pending 可用，陌生 nonce 不得二次轮换）
    let t3 = a.continuity_open_transport(&b_id).await.unwrap();
    let r3 = send_resume_with_nonce(t3, [7u8; 16]).await;
    assert_eq!(
        r3.frame_type,
        FrameType::ResumeReject,
        "异 nonce + previous 凭据必须拒绝"
    );
    assert_eq!(
        r3.payload.first().copied().unwrap_or(0),
        reject_reason::TOKEN_INVALID
    );
    provider.abort();
}

/// s7（硬化 P0-2）：SESSION_INIT 幂等（同 sid+token 重发 OK——ghost 收敛）；
/// 同 sid 伪造 token → REJECT 0x02。
#[tokio::test]
async fn session_init_idempotent_and_token_gate() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let provider = tokio::spawn(async move {
        loop {
            let _ = session::accept_any(&b, &a_id, opts).await;
        }
    });

    let sid = [0x42u8; 16];
    let token = [0x11u8; 16];
    let send_init = |tok: [u8; 16]| {
        let a = &a;
        let b_id = b_id.clone();
        async move {
            let mut raw = a.continuity_open_transport(&b_id).await.unwrap();
            raw.send(&Frame {
                frame_type: FrameType::SessionInit,
                flags: 0,
                session_id: sid,
                stream_id: 0,
                direction: Direction::ClientToProvider,
                byte_offset: 0,
                payload: Bytes::from(encode_session_init(&sid, &tok, 1)),
            })
            .await
            .unwrap();
            tokio::time::timeout(Duration::from_secs(10), raw.recv())
                .await
                .expect("init 响应有界")
                .unwrap()
        }
    };
    // 首登记 → OK
    assert_eq!(send_init(token).await.frame_type, FrameType::SessionInitOk);
    // 幂等重发（client 重试同 sid/token）→ OK（不产生 ghost）
    assert_eq!(
        send_init(token).await.frame_type,
        FrameType::SessionInitOk,
        "同 sid+token 重发必须幂等 OK"
    );
    // 伪造 token → REJECT 0x02 TOKEN_INVALID
    let resp = send_init([0xEEu8; 16]).await;
    assert_eq!(resp.frame_type, FrameType::SessionInitReject);
    assert_eq!(resp.payload[0], reject_reason::TOKEN_INVALID);
    provider.abort();
}

/// s8（硬化 P0-3）：慢消费者反压——不 recv 时发送端 journal 封顶、record
/// Err；开始消费后 ACK（commit point）推进释放。
#[tokio::test]
async fn session_slow_consumer_backpressure_then_release() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions {
        limits: {
            let mut l = dweb_fabric::continuity::model::JournalLimits::default();
            l.max_stream_bytes = 128 * 1024;
            l.max_session_bytes = 256 * 1024;
            l
        },
    };
    let cap_hit = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let flag = Arc::clone(&cap_hit);
    let provider = tokio::spawn(async move {
        let session = session::accept_any(&b, &a_id, opts)
            .await
            .expect("accept");
        session.mark_started(1).await;
        let mut sent = Vec::new();
        for i in 0..16u32 {
            let chunk = Bytes::from(vec![(0x40 + i) as u8; 16 * 1024]);
            if session.send_data(1, chunk.clone()).await.is_err() {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
                break; // journal 封顶：反压终态（内存有界）
            }
            sent.extend_from_slice(&chunk);
        }
        session.finish(1).await.unwrap();
        session.mark_completed(1).await;
        (session, sent)
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream("slow").await.unwrap();
    client.send_data(s, Bytes::from_static(b"req")).await.unwrap();
    client.finish(s).await.unwrap();

    // 慢消费者：不 recv——发送端必须封顶（有界），本端交付队列涨满
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !cap_hit.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(tokio::time::Instant::now() < deadline, "发送端未封顶");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while client.shared().deliver_queue_bytes(s).await < 8 * 16 * 1024 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "交付队列未涨满：{}",
            client.shared().deliver_queue_bytes(s).await
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(client.shared().committed_offset(s).await, 0, "未消费");

    // 开始消费：字节精确 + ACK（commit point）释放发送端 journal
    let (provider_session, sent) = provider.await.unwrap();
    let got = drain_stream(&client, s, "slow").await;
    assert_eq!(got, sent, "慢消费者消费路径字节精确");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while provider_session.shared().journal_held_bytes(1).await > 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "消费后 ACK 未释放 journal：{}",
            provider_session.shared().journal_held_bytes(1).await
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// s9（硬化 P1-5）：双向大 replay（两侧各 1MiB 未 ack 数据）断线恢复不
/// 悬挂（先装通道后重放，pump 并发排水）+ 字节精确。
#[tokio::test]
async fn session_bidir_big_replay_no_deadlock() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    const CHUNK: usize = 16 * 1024;
    const N: usize = 64; // 1 MiB each way

    let req_chunks: Vec<Bytes> = (0..N)
        .map(|i| Bytes::from(vec![(i % 251) as u8 + 1; CHUNK]))
        .collect();
    let resp_chunks: Vec<Bytes> = (0..N)
        .map(|i| Bytes::from(vec![((i + 77) % 251) as u8 + 1; CHUNK]))
        .collect();
    let resp_expected: Vec<u8> = resp_chunks.iter().flat_map(|c| c.iter().copied()).collect();
    let req_expected: Vec<u8> = req_chunks.iter().flat_map(|c| c.iter().copied()).collect();
    let resp_sent = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let provider_done = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let sent_flag = Arc::clone(&resp_sent);
    let done_flag = Arc::clone(&provider_done);
    let req_exp = req_expected.clone();
    let provider = tokio::spawn(async move {
        loop {
            let Ok(session) = session::accept_any(&b, &a_id, opts).await else {
                continue;
            };
            match wait_request(&session, 1, "big-replay").await {
                RequestState::Started | RequestState::Completed => {
                    // 恢复轮：不重执行；排空请求方向并校验字节精确
                    let mut got = Vec::new();
                    loop {
                        match tokio::time::timeout(Duration::from_secs(15), session.recv(1)).await {
                            Ok(Ok(c)) => got.extend_from_slice(&c),
                            Ok(Err(_)) => break,
                            Err(_) => panic!("恢复轮请求排空超时（已收 {}B）", got.len()),
                        }
                    }
                    assert_eq!(got, req_exp, "请求方向恢复后字节精确");
                    done_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                _ => {
                    // 首轮：不消费请求（保持 client journal 未 ack）——先发响应
                    session.mark_started(1).await;
                    for c in &resp_chunks {
                        session.send_data(1, c.clone()).await.unwrap();
                    }
                    session.finish(1).await.unwrap();
                    session.mark_completed(1).await;
                    sent_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream("big").await.unwrap();
    for c in &req_chunks {
        client.send_data(s, c.clone()).await.unwrap();
    }
    client.finish(s).await.unwrap();

    // 双向未 ack 就绪：响应全部到达本端队列 + provider 已发完
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while client.shared().deliver_queue_bytes(s).await < N * CHUNK
        || !resp_sent.load(std::sync::atomic::Ordering::SeqCst)
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "双向未 ack 数据未就绪：queue={}B sent={}",
            client.shared().deliver_queue_bytes(s).await,
            resp_sent.load(std::sync::atomic::Ordering::SeqCst)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 慢消费者观测面：1MiB 未消费 > 256KiB 软上限
    assert!(client.shared().deliver_queue_over_cap(s).await);

    // 断线 + 恢复（有界 30s——修复前双向同步重放在 QUIC 流控上互等死锁）
    a.continuity_reset(&b_id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(30), client.resume(&a))
        .await
        .expect("大 replay 恢复不悬挂")
        .expect("resume 成功");

    // 双向字节精确收尾
    let got = drain_stream(&client, s, "big-replay").await;
    assert_eq!(got, resp_expected, "响应方向恢复后字节精确");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !provider_done.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(tokio::time::Instant::now() < deadline, "provider 未完成校验");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    provider.abort();
}

/// s10（硬化 P0-1c）：client resume single-flight——并发调用恰一执行者，
/// 双双 Ok、终态 Active、数据面继续可用。
#[tokio::test]
async fn session_resume_single_flight() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    let provider = tokio::spawn(async move {
        loop {
            let Ok(session) = session::accept_any(&b, &a_id, opts).await else {
                continue;
            };
            match wait_request(&session, 1, "single-flight").await {
                RequestState::Started | RequestState::Completed => {}
                _ => {
                    let _ = session.recv(1).await;
                    session.mark_started(1).await;
                    session.send_data(1, Bytes::from_static(b"pong")).await.unwrap();
                    session.finish(1).await.unwrap();
                    session.mark_completed(1).await;
                }
            }
        }
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream("sf").await.unwrap();
    client.send_data(s, Bytes::from_static(b"ping")).await.unwrap();
    client.finish(s).await.unwrap();
    assert_eq!(client.recv(s).await.unwrap(), Bytes::from_static(b"pong"));

    // 并发双 resume：single-flight 恰一执行者，两者都 Ok 返回
    a.continuity_reset(&b_id).await.unwrap();
    let (r1, r2) = tokio::join!(client.resume(&a), client.resume(&a));
    assert!(r1.is_ok() && r2.is_ok(), "并发 resume 双双 Ok：{r1:?} {r2:?}");
    // 终态收敛 Active + 数据面继续
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while client.phase().await != session::SessionPhase::Active {
        assert!(tokio::time::Instant::now() < deadline, "未收敛 Active");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    client.send_data(s, Bytes::from_static(b"again")).await.unwrap();
    client.finish(s).await.unwrap();
    provider.abort();
}
