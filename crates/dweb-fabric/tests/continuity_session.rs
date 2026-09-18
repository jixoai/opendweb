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
//! - 恢复后的旧 epoch DATA/ACK 由同一 pump fence 丢弃：stale 计数增加、
//!   journal 与 Active phase 不变
//!
//! 运行：`--test-threads=1`（固定端口跨测试竞争）。

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

use bytes::Bytes;
use dweb_fabric::continuity::session::{
    self, RequestState, SessionOptions, decode_resume_ok, encode_resume_init, encode_session_init,
    encode_session_init_ok, init_reason, reject_reason,
};
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

/// 成员关系就绪的 fabric 对（复刻 continuity_state.rs 装配）。
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
    tokio::time::timeout(
        Duration::from_secs(30),
        session::open_session(fabric, peer, opts),
    )
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
        session
            .send_data(1, Bytes::from_static(b"pong"))
            .await
            .unwrap();
        session.finish(1).await.unwrap();
        session.mark_completed(1).await;
        session
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream("k1").await.expect("open_stream");
    assert_eq!(s, 1, "client 首流 id = 1（奇数）");
    client
        .send_data(s, Bytes::from_static(b"ping"))
        .await
        .unwrap();
    client.finish(s).await.unwrap();
    let resp = client.recv(s).await.expect("response");
    assert_eq!(&resp[..], b"pong");
    // 流终结
    assert!(client.recv(s).await.is_err(), "FIN 后 recv 终结");

    let provider = provider.await.unwrap();
    assert_eq!(
        provider.request_state(1).await,
        Some(RequestState::Completed)
    );

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

/// P0-2：双端同时以 `open_session` 建会话时，按
/// `(EndpointId, sessionId)` 全序收敛到同一个 canonical sid；同 peer 不保留
/// 两个已接受会话。
#[tokio::test]
async fn session_dual_open_session_converges_to_one_sid() {
    let (a, b, _da, _db) = pair().await;
    let a_id = a.endpoint_id();
    let b_id = b.endpoint_id();
    let opts = SessionOptions::default();

    let accept_a = {
        let provider = a.clone();
        let peer = b_id.clone();
        tokio::spawn(async move { session::accept_any(&provider, &peer, opts).await })
    };
    let accept_b = {
        let provider = b.clone();
        let peer = a_id.clone();
        tokio::spawn(async move { session::accept_any(&provider, &peer, opts).await })
    };

    let (a_result, b_result) = tokio::time::timeout(Duration::from_secs(45), async {
        tokio::join!(
            open_session_bounded(&a, &b_id, opts),
            open_session_bounded(&b, &a_id, opts),
        )
    })
    .await
    .expect("双端 open_session 有界");
    let a_session = a_result;
    let b_session = b_result;
    assert_eq!(
        a_session.shared().session_id,
        b_session.shared().session_id,
        "双端并发 INIT 必须收敛到同一 sid"
    );

    let accepted_a = tokio::time::timeout(Duration::from_secs(10), accept_a)
        .await
        .expect("A provider accept 有界")
        .expect("A provider task");
    let accepted_b = tokio::time::timeout(Duration::from_secs(10), accept_b)
        .await
        .expect("B provider accept 有界")
        .expect("B provider task");
    let accepted: Vec<_> = [accepted_a, accepted_b]
        .into_iter()
        .filter_map(Result::ok)
        .collect();
    assert_eq!(
        accepted.len(),
        1,
        "同 peer 只能有一个 provider canonical session"
    );
    assert_eq!(
        accepted[0].shared().session_id,
        a_session.shared().session_id,
        "provider canonical sid 与双方句柄一致"
    );
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
                    session
                        .send_data(1, Bytes::from_static(b"late-pong"))
                        .await
                        .unwrap();
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
    client
        .send_data(s, Bytes::from_static(b"ping"))
        .await
        .unwrap();
    client.finish(s).await.unwrap();

    // 确定性断点：等 provider 真实进入 STARTED 再注入死亡
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !started_flag.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "provider 未 STARTED"
        );
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
    raw2.send(&Frame {
        frame_type: FrameType::ResumeInit,
        flags: 0,
        session_id: client.shared().session_id,
        stream_id: 0,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::from(encode_resume_init(1, 1, &[0u8; 16], &[7u8; 16], &[])),
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
    client
        .send_data(s1, Bytes::from_static(b"req-big"))
        .await
        .unwrap();
    client.finish(s1).await.unwrap();
    client
        .send_data(s3, Bytes::from_static(b"req-small"))
        .await
        .unwrap();
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

/// s6（硬化 P0-1）：同 nonce 的并发 RESUME 重发同一 RESUME_OK；异 nonce
/// 对 previous 的精确匹配仍可开启一个串行 winner。
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
            payload: Bytes::from(encode_resume_init(
                token_gen,
                token_gen,
                &[0u8; 16],
                &token,
                &[],
            )),
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), t.recv())
            .await
            .expect("resume 响应有界")
    };
    let send_resume_with_nonce = |mut t: dweb_fabric::continuity::ContinuityTransport,
                                  nonce: [u8; 16]| async move {
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
    };
    let t1 = a.continuity_open_transport(&b_id).await.unwrap();
    let t2 = a.continuity_open_transport(&b_id).await.unwrap();
    // —— R3 语义矩阵（Codex 复评步骤 6）——
    // 1) 同 nonce 并发双发（OK-lost 重试形态）：双 OK 且载荷**完全一致**
    //    （幂等缓存重发——不二次轮换，generation 恰前进一次）
    let (r1, r2) = tokio::join!(send_resume(t1), send_resume(t2));
    let oks: Vec<_> = [r1, r2]
        .into_iter()
        .filter_map(Result::ok)
        .filter(|r| r.frame_type == FrameType::ResumeOk)
        .map(|r| decode_resume_ok(&r.payload).expect("RESUME_OK 载荷可解析"))
        .collect();
    assert_eq!(oks.len(), 1, "两阶段提交只允许真正安装者收到 RESUME_OK");
    assert_eq!(oks[0].0, token_gen + 1, "generation 恰前进一次（单次轮换）");
    // 2) 异 nonce 携 previous 凭据：previous 精确匹配仍可开启新的串行
    //    winner（不是 cached 幂等路径）。
    let t3 = a.continuity_open_transport(&b_id).await.unwrap();
    let r3 = send_resume_with_nonce(t3, [7u8; 16]).await;
    let r3 = r3.expect("previous 精确匹配可恢复：两阶段安装成功后收到 RESUME_OK");
    assert_eq!(
        r3.frame_type,
        FrameType::ResumeOk,
        "previous 精确匹配可恢复"
    );
    assert_eq!(decode_resume_ok(&r3.payload).unwrap().0, oks[0].0 + 1);
    provider.abort();
}

/// P0 transition barrier：RESUME_OK 已缓存但新 owner 尚未提交时，重复
/// transport 只能收到缓存结果并半关；owner 只由真正 winner 前进一次。
#[tokio::test]
async fn session_resume_cached_duplicate_does_not_change_owner() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let (ready_tx, ready_rx) = oneshot::channel();
    let provider = tokio::spawn(async move {
        let initial = session::accept_any(&b, &a_id, opts)
            .await
            .expect("initial accept");
        let gate_rx = initial.shared().resume_gate.enable();
        let owner_before = initial.shared().debug_channel_owner();
        ready_tx
            .send((initial.shared().clone(), gate_rx, owner_before))
            .unwrap_or_else(|_| panic!("barrier handoff"));
        let b1 = b.clone();
        let b2 = b.clone();
        let a1 = a_id.clone();
        let a2 = a_id.clone();
        let p1 = tokio::spawn(async move { session::accept_any(&b1, &a1, opts).await });
        let p2 = tokio::spawn(async move { session::accept_any(&b2, &a2, opts).await });
        let _ = tokio::join!(p1, p2);
    });
    let client = open_session_bounded(&a, &b_id, opts).await;
    let (shared, mut gate_rx, owner_before) = ready_rx.await.expect("barrier ready");
    let (generation, token) = client.shared().debug_current_token();
    let sid = client.shared().session_id;

    let send = |mut t: dweb_fabric::continuity::ContinuityTransport| async move {
        t.send(&Frame {
            frame_type: FrameType::ResumeInit,
            flags: 0,
            session_id: sid,
            stream_id: 0,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from(encode_resume_init(
                generation,
                generation,
                &[9u8; 16],
                &token,
                &[],
            )),
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), t.recv())
            .await
            .expect("resume response")
    };
    let t1 = a.continuity_open_transport(&b_id).await.unwrap();
    let t2 = a.continuity_open_transport(&b_id).await.unwrap();
    let j1 = tokio::spawn(send(t1));
    let j2 = tokio::spawn(send(t2));
    tokio::time::timeout(Duration::from_secs(10), gate_rx.changed())
        .await
        .expect("winner reaches ResumeGate")
        .expect("gate remains open");
    assert_eq!(
        shared.debug_channel_owner(),
        owner_before,
        "barrier 内尚未提交 owner"
    );
    shared.resume_gate.release();
    let (winner, duplicate) =
        tokio::time::timeout(Duration::from_secs(10), async { tokio::join!(j1, j2) })
            .await
            .expect("winner released");
    let responses = [
        winner.expect("winner task"),
        duplicate.expect("duplicate task"),
    ];
    assert_eq!(
        responses.iter().filter(|r| r.is_ok()).count(),
        1,
        "两阶段提交只向真正安装者发送 RESUME_OK"
    );
    assert!(
        responses
            .iter()
            .filter_map(|r| r.as_ref().ok())
            .all(|r| r.frame_type == FrameType::ResumeOk)
    );
    assert_eq!(
        shared.debug_channel_owner(),
        owner_before + 1,
        "仅 winner 提交新 owner"
    );
    provider.abort();
}

/// s6b（0.6.0 加固）：中途废弃的 RESUME 尝试 × 异 nonce 恢复。第一次
/// RESUME（nonce N1）发出后立即杀传输（客户端放弃——候选流死在协议的
/// 任意阶段：决策前/gated/安装后 OK 发送失败），第二次 RESUME 携异 nonce
/// N2 + previous 凭据必须干净成功且 provider 回到 Active。
/// 不变量钉（失败路径与跨 nonce 状态机的交叉面；具体停驻阶段由竞态决定，
/// 各分支——未决策/已决策未安装/安装后发送失败——均须满足本断言）。
#[tokio::test]
async fn session_abandoned_resume_then_cross_nonce_recovers() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();

    // provider 侧 shared 经首 accept 交接（同 sid 注册表条目跨 resume 存活——
    // phase 断言必须落在 provider 侧实例上：Active 由 accept_resume 置位）
    let (ready_tx, ready_rx) = oneshot::channel();
    let provider = tokio::spawn(async move {
        let initial = session::accept_any(&b, &a_id, opts)
            .await
            .expect("initial accept");
        let shared = initial.shared().clone();
        ready_tx.send(shared).unwrap_or_else(|_| panic!("handoff"));
        loop {
            let _ = session::accept_any(&b, &a_id, opts).await;
        }
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let (generation, token) = client.shared().debug_current_token();
    let sid = client.shared().session_id;
    let shared = ready_rx.await.expect("provider shared handoff");

    // —— 第一次 RESUME（nonce N1）：帧发出后立即杀传输（放弃尝试） ——
    let t1 = a.continuity_open_transport(&b_id).await.unwrap();
    {
        let mut t = t1;
        t.send(&Frame {
            frame_type: FrameType::ResumeInit,
            flags: 0,
            session_id: sid,
            stream_id: 0,
            direction: Direction::ClientToProvider,
            byte_offset: 0,
            payload: Bytes::from(encode_resume_init(
                generation,
                generation,
                &[0xA1u8; 16],
                &token,
                &[],
            )),
        })
        .await
        .expect("N1 帧发出");
    } // drop(t1)：杀候选流（对端在途处理死于任意阶段）

    // —— 第二次 RESUME：异 nonce N2 + previous 凭据（客户端仍持旧 token） ——
    // 注意保活 t2：RESUME_OK 到达后 transport 即恢复后通道本体——drop 会让
    // 泵立即判定 Ended 正确置回 Recovering（断言前不得拆线）。
    let mut t2 = a.continuity_open_transport(&b_id).await.unwrap();
    t2.send(&Frame {
        frame_type: FrameType::ResumeInit,
        flags: 0,
        session_id: sid,
        stream_id: 0,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::from(encode_resume_init(
            generation,
            generation,
            &[0xB2u8; 16],
            &token,
            &[],
        )),
    })
    .await
    .expect("N2 帧发出");
    let r2 = tokio::time::timeout(Duration::from_secs(10), t2.recv())
        .await
        .expect("resume 响应有界")
        .expect("recv ok");
    assert_eq!(r2.frame_type, FrameType::ResumeOk, "异 nonce 恢复必须成功");
    let (ok_gen, _ok_token) = decode_resume_ok(&r2.payload).expect("OK 可解析");
    assert!(
        ok_gen > generation,
        "轮换代际前进（N1 已消耗一次轮换亦可，不得回退）"
    );
    // provider 侧最终回到 Active（N1 弃线造成的 Recovering 被覆盖）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let phase = shared.phase().await;
        if phase == session::SessionPhase::Active {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "二轮成功后 provider 必须回到 Active（当前 {phase:?}）"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drop(t2);
    provider.abort();
}

/// s6c（0.6.0）：close 后同 peer 重开。旧缺陷：provider 侧会话在客户端
/// close 后永驻 Recovering（无放弃机制），canonical 永不释放——新 INIT
/// 永远 ALREADY_ACTIVE、客户端 adopt 死 canonical 超时（e2e T7 实证卡死
/// 45s+）。修复：恢复放弃看门狗（Recovering 且同一胜者 → 有界转 Dead，
/// reap 释放 canonical）+ campaign 守卫活跃判定只认 Active/Recovering。
#[tokio::test]
async fn session_reopen_after_giveup_releases_canonical() {
    // 全局旋钮的 panic 安全复位（断言失败不毒化同二进制后续测试）
    struct GiveupGuard;
    impl Drop for GiveupGuard {
        fn drop(&mut self) {
            session::set_resume_giveup_for_test(0);
        }
    }
    let _giveup = GiveupGuard;
    session::set_resume_giveup_for_test(300);
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let provider = tokio::spawn(async move {
        loop {
            let _ = session::accept_any(&b, &a_id, opts).await;
        }
    });

    let s1 = open_session_bounded(&a, &b_id, opts).await;
    let sid1 = s1.shared().session_id;
    s1.close().await;

    // 看门狗窗口（300ms 放弃 + pump 死亡传播余量）
    tokio::time::sleep(Duration::from_millis(800)).await;

    // 重开：canonical 已释放（Dead → reap），新 sid 准入成功
    let s2 = open_session_bounded(&a, &b_id, opts).await;
    let sid2 = s2.shared().session_id;
    assert_ne!(sid1, sid2, "重开必须得到新 session（canonical 已释放）");
    s2.close().await;
    provider.abort();
    drop(_giveup);
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
    // 伪造 token → INIT REJECT 0x02 MALFORMED（INIT 与 RESUME reason 命名空间独立）
    let resp = send_init([0xEEu8; 16]).await;
    assert_eq!(resp.frame_type, FrameType::SessionInitReject);
    assert_eq!(resp.payload[0], init_reason::MALFORMED);
    provider.abort();
}

/// P0-4b：零 sid / 零 token / 零 epoch 的 identity 字段守卫——长度与版本
/// 合法但身份字段全零时同样必须 REJECT(MALFORMED)（0.6.0 补钉：该守卫臂
/// 此前无负例）。
#[tokio::test]
async fn session_init_zero_identity_rejects_malformed() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let provider = tokio::spawn(async move { session::accept_any(&b, &a_id, opts).await });

    // 41 字节合法长度 + 正确版本，但 sid/token 全零、epoch 0
    let sid = [0u8; 16];
    let mut payload = Vec::with_capacity(41);
    payload.push(session::PROTOCOL_VERSION);
    payload.extend_from_slice(&[0u8; 16]); // zero sid
    payload.extend_from_slice(&[0u8; 16]); // zero token
    payload.extend_from_slice(&0u64.to_be_bytes()); // zero epoch
    let mut raw = a.continuity_open_transport(&b_id).await.unwrap();
    raw.send(&Frame {
        frame_type: FrameType::SessionInit,
        flags: 0,
        session_id: sid,
        stream_id: 0,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::from(payload),
    })
    .await
    .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(10), raw.recv())
        .await
        .expect("zero-identity INIT response 有界")
        .unwrap();
    assert_eq!(response.frame_type, FrameType::SessionInitReject);
    assert_eq!(response.payload.first(), Some(&init_reason::MALFORMED));
    assert!(
        tokio::time::timeout(Duration::from_secs(10), provider)
            .await
            .expect("zero-identity provider task 有界")
            .expect("provider task")
            .is_err(),
        "零身份字段应拒绝接纳而非建立 session"
    );
}

/// P0-4：畸形 SESSION_INIT 必须在 wire 上回 INIT_REJECT(MALFORMED)，不能静默
/// 结束传输或把错误误报成 RESUME reason。
#[tokio::test]
async fn session_init_malformed_rejects_on_wire() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let provider = tokio::spawn(async move { session::accept_any(&b, &a_id, opts).await });

    let sid = [0x53u8; 16];
    let mut raw = a.continuity_open_transport(&b_id).await.unwrap();
    raw.send(&Frame {
        frame_type: FrameType::SessionInit,
        flags: 0,
        session_id: sid,
        stream_id: 0,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::from_static(&[session::PROTOCOL_VERSION]),
    })
    .await
    .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(10), raw.recv())
        .await
        .expect("malformed INIT response 有界")
        .unwrap();
    assert_eq!(response.frame_type, FrameType::SessionInitReject);
    assert_eq!(response.session_id, sid, "INIT_REJECT header 回显被拒 sid");
    assert_eq!(response.payload.first(), Some(&init_reason::MALFORMED));
    assert!(
        tokio::time::timeout(Duration::from_secs(10), provider)
            .await
            .expect("malformed provider task 有界")
            .expect("provider task")
            .is_err(),
        "畸形 INIT 应结束本次接纳而非建立 session"
    );
}

/// R6 P0：client 必须拒绝载荷中 accepted_epoch/generation 为零的 INIT_OK，
/// 即使公共头和 accepted sid 都正确，也不能把会话置为 Active。
#[tokio::test]
async fn session_init_ok_zero_epoch_or_generation_rejected_on_client_wire() {
    for (accepted_epoch, generation) in [(0, 1), (1, 0)] {
        let (a, b, _da, _db) = pair().await;
        let b_id = b.endpoint_id();
        let a_id = a.endpoint_id();
        let opts = SessionOptions::default();
        let provider = tokio::spawn(async move {
            // 并发双拨的连接收敛窗口内 accept 可能瞬态 closed——按 accept_any
            // 同款语义有界重试（单发 accept 会把收敛抖动误判为致命）
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let mut raw = loop {
                match b.continuity_accept_stream(&a_id).await {
                    Ok(t) => break t,
                    Err(_) if tokio::time::Instant::now() < deadline => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                    Err(e) => panic!("accept raw INIT transport: {e}"),
                }
            };
            let init = tokio::time::timeout(Duration::from_secs(10), raw.recv())
                .await
                .expect("INIT 有界")
                .expect("INIT 帧");
            assert_eq!(init.frame_type, FrameType::SessionInit);
            raw.send(&Frame {
                frame_type: FrameType::SessionInitOk,
                flags: 0,
                session_id: init.session_id,
                stream_id: 0,
                direction: dweb_fabric::continuity::Direction::ProviderToClient,
                byte_offset: 0,
                payload: Bytes::from(encode_session_init_ok(
                    &init.session_id,
                    accepted_epoch,
                    generation,
                )),
            })
            .await
            .expect("发送畸形 INIT_OK");
        });

        let result = tokio::time::timeout(
            Duration::from_secs(15),
            session::open_session(&a, &b_id, opts),
        )
        .await
        .expect("open_session 有界");
        let error = match result {
            Ok(_) => panic!("zero INIT_OK fields must not establish a session"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("malformed SESSION_INIT_OK"),
            "unexpected client error: {error}"
        );
        provider.await.expect("provider task");
    }
}

/// P0-3d：绕过本地 OPEN 名额门、从真实 continuity wire 发送 129 个 OPEN；
/// 远端只接受前 128 个，第 129 个计入协议违例并丢弃。
#[tokio::test]
async fn session_wire_rejects_129th_open() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let provider_task = tokio::spawn(async move {
        session::accept_any(&b, &a_id, opts)
            .await
            .expect("provider accept")
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let provider = provider_task.await.expect("provider task");
    let sid = client.shared().session_id;
    for index in 0..=session::MAX_ACTIVE_STREAMS {
        let stream_id = index as u64 * 2 + 1;
        client
            .channel()
            .send_frame(&Frame {
                frame_type: FrameType::Open,
                flags: dweb_fabric::continuity::frame::flags::START,
                session_id: sid,
                stream_id,
                direction: Direction::ClientToProvider,
                byte_offset: 0,
                payload: Bytes::from(format!(
                    "{{\"requestId\":\"{stream_id}\",\"idempotencyKey\":\"wire-{stream_id}\"}}"
                )),
            })
            .await
            .expect("OPEN wire send");
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while provider.shared().protocol_violations() == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "第 129 个 OPEN 未被拒绝"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(provider.shared().protocol_violations(), 1);
}

/// P0 transition：真实断线恢复完成后，旧 channel 的 DATA/ACK 即便已从旧
/// transport 收到，也只能穿过同一 dispatch fence 计为 stale；不得交付、释放
/// journal 或把新代拉离 Active。
#[tokio::test]
async fn session_old_epoch_data_and_ack_are_fenced_after_resume() {
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
    let stream = client.open_stream("old-epoch-fence").await.unwrap();
    client
        .prepare_send(stream, &Bytes::from_static(b"journal-before-stale"))
        .await
        .expect("journal seed");
    let old_channel = client.channel();

    a.continuity_reset(&b_id).await.unwrap();
    client.resume(&a).await.expect("resume");
    assert_eq!(client.phase().await, session::SessionPhase::Active);
    let journal_before = client.shared().journal_held_bytes(stream).await;
    let stale_before = client.shared().stale_frames();

    // `old_channel` 是真实恢复前的 channel；测试钩子复用 pump 的完整
    // fence/dispatch 路径，模拟它在换代后才取得的旧连接帧。
    let old_data = Frame {
        frame_type: FrameType::Data,
        flags: 0,
        session_id: client.shared().session_id,
        stream_id: stream,
        direction: Direction::ProviderToClient,
        byte_offset: 0,
        payload: Bytes::from_static(b"old-epoch-data"),
    };
    let old_ack = Frame {
        frame_type: FrameType::Ack,
        flags: 0,
        session_id: client.shared().session_id,
        stream_id: stream,
        direction: Direction::ClientToProvider,
        byte_offset: journal_before as u64,
        payload: Bytes::new(),
    };
    old_channel
        .debug_dispatch_frame(&old_data)
        .await
        .expect("stale DATA dispatch");
    old_channel
        .debug_dispatch_frame(&old_ack)
        .await
        .expect("stale ACK dispatch");

    assert_eq!(client.shared().stale_frames(), stale_before + 2);
    assert_eq!(
        client.shared().journal_held_bytes(stream).await,
        journal_before,
        "旧 ACK 不得释放新代 journal"
    );
    assert_eq!(
        client.phase().await,
        session::SessionPhase::Active,
        "旧 DATA/ACK 不得改变新代 phase"
    );
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
        limits: dweb_fabric::continuity::model::JournalLimits {
            max_stream_bytes: 128 * 1024,
            max_session_bytes: 256 * 1024,
            ..Default::default()
        },
    };
    let cap_hit = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let flag = Arc::clone(&cap_hit);
    let provider = tokio::spawn(async move {
        let session = session::accept_any(&b, &a_id, opts).await.expect("accept");
        // R6-5：send_data 不再隐式建流——等对端 OPEN 登记流 1 后再进发送循环
        let _ = wait_request(&session, 1, "slow-consumer").await;
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
    client
        .send_data(s, Bytes::from_static(b"req"))
        .await
        .unwrap();
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
        assert!(
            tokio::time::Instant::now() < deadline,
            "provider 未完成校验"
        );
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
        let mut first_round = true;
        loop {
            let Ok(session) = session::accept_any(&b, &a_id, opts).await else {
                continue;
            };
            match wait_request(&session, 1, "single-flight").await {
                RequestState::Started | RequestState::Completed => {}
                _ => {
                    let _ = session.recv(1).await;
                    session.mark_started(1).await;
                    session
                        .send_data(1, Bytes::from_static(b"pong"))
                        .await
                        .unwrap();
                    session.finish(1).await.unwrap();
                    session.mark_completed(1).await;
                }
            }
            if first_round {
                // 首轮只服务流 1；回到 accept_any 等待 resume 轮的恢复传输
                first_round = false;
                continue;
            }
            // resume 轮：流 1 已 Completed；R6 严格语义下 FIN 过的流不再复用，
            // 客户端在恢复后开新流（id 3）验证数据面
            match wait_request(&session, 3, "single-flight-2").await {
                RequestState::Started | RequestState::Completed => {}
                _ => {
                    let _ = session.recv(3).await;
                    session.mark_started(3).await;
                    session
                        .send_data(3, Bytes::from_static(b"pong"))
                        .await
                        .unwrap();
                    session.finish(3).await.unwrap();
                    session.mark_completed(3).await;
                }
            }
        }
    });

    let client = open_session_bounded(&a, &b_id, opts).await;
    let s = client.open_stream("sf").await.unwrap();
    client
        .send_data(s, Bytes::from_static(b"ping"))
        .await
        .unwrap();
    client.finish(s).await.unwrap();
    assert_eq!(client.recv(s).await.unwrap(), Bytes::from_static(b"pong"));

    // 并发双 resume：single-flight 恰一执行者，两者都 Ok 返回
    a.continuity_reset(&b_id).await.unwrap();
    let (r1, r2) = tokio::join!(client.resume(&a), client.resume(&a));
    assert!(
        r1.is_ok() && r2.is_ok(),
        "并发 resume 双双 Ok：{r1:?} {r2:?}"
    );
    // 终态收敛 Active + 数据面继续
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while client.phase().await != session::SessionPhase::Active {
        assert!(tokio::time::Instant::now() < deadline, "未收敛 Active");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 数据面继续可用：流 1 已 FIN——严格语义下不复用，开新流验证
    let s2 = client.open_stream("sf2").await.unwrap();
    client
        .send_data(s2, Bytes::from_static(b"again"))
        .await
        .unwrap();
    client.finish(s2).await.unwrap();
    assert_eq!(
        client.recv(s2).await.unwrap(),
        Bytes::from_static(b"pong"),
        "恢复后新流数据面可用"
    );
    provider.abort();
}

/// s6d（R1 P1-4）：INIT 替换 vs 在途 RESUME 竞态——被替换会话不得复活。
/// 交错（resume_gate 确定性注入）：R1 决策完成被 gate 拦截（未安装）→
/// 客户端刻意 close（S1 → 死通道 Recovering）→ 新 INIT I1 走死通道替换
/// （S1 置 Dead、S2 上位）→ 放行 R1 → install 因 S1 已 Dead 被拒 →
/// 无 RESUME_OK、S1 永不重新 Active（单 canonical 收敛）。
#[tokio::test]
async fn session_replaced_canonical_not_resurrected_by_inflight_resume() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let (ready_tx, ready_rx) = oneshot::channel();
    let b_loop = b.clone();
    let a_loop = a_id.clone();
    let provider = tokio::spawn(async move {
        let initial = session::accept_any(&b_loop, &a_loop, opts)
            .await
            .expect("initial accept");
        let gate_rx = initial.shared().resume_gate.enable();
        let shared = initial.shared().clone();
        ready_tx
            .send((shared, gate_rx))
            .unwrap_or_else(|_| panic!("handoff"));
        loop {
            let _ = session::accept_any(&b_loop, &a_loop, opts).await;
        }
    });
    let client = open_session_bounded(&a, &b_id, opts).await;
    let (shared, gate_rx) = ready_rx.await.expect("handoff");
    let (generation, token) = client.shared().debug_current_token();
    let sid1 = client.shared().session_id;

    // R1：RESUME 于 t1，决策后被 gate 拦截（未安装）
    let t1 = a.continuity_open_transport(&b_id).await.unwrap();
    let mut t1 = t1;
    t1.send(&Frame {
        frame_type: FrameType::ResumeInit,
        flags: 0,
        session_id: sid1,
        stream_id: 0,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::from(encode_resume_init(
            generation,
            generation,
            &[0xC1u8; 16],
            &token,
            &[],
        )),
    })
    .await
    .unwrap();
    // 并发第二 accept 承接 I1（串行 loop 会被 gated R1 阻塞）
    let b2 = b.clone();
    let a2 = a_id.clone();
    let p2 = tokio::spawn(async move { session::accept_any(&b2, &a2, opts).await });
    let mut gate_rx = gate_rx;
    tokio::time::timeout(Duration::from_secs(10), gate_rx.changed())
        .await
        .expect("R1 到达 gate 有界")
        .expect("gate 保持打开");

    // 客户端刻意 close：S1（provider 侧）→ 死通道 Recovering
    client.close().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while shared.phase().await != session::SessionPhase::Recovering {
        assert!(
            tokio::time::Instant::now() < deadline,
            "close 后 S1 应进入 Recovering（当前 {:?}）",
            shared.phase().await
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // I1：fresh INIT（新 sid）——死通道 Recovering canonical 即时替换
    let sid2 = [0x77u8; 16];
    let t2 = a.continuity_open_transport(&b_id).await.unwrap();
    let mut t2 = t2;
    t2.send(&Frame {
        frame_type: FrameType::SessionInit,
        flags: 0,
        session_id: sid2,
        stream_id: 0,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::from(encode_session_init(&sid2, &[0x99u8; 16], 1)),
    })
    .await
    .unwrap();
    let ok2 = tokio::time::timeout(Duration::from_secs(10), t2.recv())
        .await
        .expect("INIT_OK 有界")
        .expect("recv ok");
    assert_eq!(ok2.frame_type, FrameType::SessionInitOk, "I1 替换成功");

    // 放行 R1：install 因 S1 已 Dead 被拒——无 RESUME_OK、S1 不复活
    shared.resume_gate.release();
    let r1_resp = tokio::time::timeout(Duration::from_secs(10), t1.recv()).await;
    match r1_resp {
        Ok(Ok(f)) => panic!("R1 不得收到成功帧（得到 {:?}）", f.frame_type),
        Ok(Err(_)) | Err(_) => {} // 半关候选：连接终结/无帧
    }
    // 终态：S1 保持 Dead（不因 R1 的任何后续步骤复活）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let phase = shared.phase().await;
        assert_eq!(
            phase,
            session::SessionPhase::Dead,
            "被替换会话必须保持 Dead"
        );
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(p2);
    provider.abort();
}

/// s6e（R2-P1c）：close 与在途 RESUME 并发串行化——closing 闸门后迟到的
/// 恢复不得安装/复活（终局提交条件化 + install closing 拒绝双保险）。
/// 交错（resume_gate 注入）：R1 决策后被 gate 拦截 → 客户端刻意 close →
/// 放行 R1 → install 因 closing 被拒 → 无 RESUME_OK、会话保持 Closed。
#[tokio::test]
async fn session_close_gates_inflight_resume_from_reactivating() {
    // 旋钮加速 provider 侧放弃（Recovering → Dead 300ms）+ panic 安全复位
    struct GiveupGuard;
    impl Drop for GiveupGuard {
        fn drop(&mut self) {
            session::set_resume_giveup_for_test(0);
        }
    }
    let _giveup = GiveupGuard;
    session::set_resume_giveup_for_test(300);
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let opts = SessionOptions::default();
    let (ready_tx, ready_rx) = oneshot::channel();
    let b_loop = b.clone();
    let a_loop = a_id.clone();
    let provider = tokio::spawn(async move {
        let initial = session::accept_any(&b_loop, &a_loop, opts)
            .await
            .expect("initial accept");
        let gate_rx = initial.shared().resume_gate.enable();
        let shared = initial.shared().clone();
        ready_tx
            .send((shared, gate_rx))
            .unwrap_or_else(|_| panic!("handoff"));
        loop {
            let _ = session::accept_any(&b_loop, &a_loop, opts).await;
        }
    });
    let client = open_session_bounded(&a, &b_id, opts).await;
    let (shared, gate_rx) = ready_rx.await.expect("handoff");
    let (generation, token) = client.shared().debug_current_token();
    let sid1 = client.shared().session_id;

    // R1 上线（决策后被 gate 拦截——未安装）
    let t1 = a.continuity_open_transport(&b_id).await.unwrap();
    let mut t1 = t1;
    t1.send(&Frame {
        frame_type: FrameType::ResumeInit,
        flags: 0,
        session_id: sid1,
        stream_id: 0,
        direction: Direction::ClientToProvider,
        byte_offset: 0,
        payload: Bytes::from(encode_resume_init(
            generation,
            generation,
            &[0xD1u8; 16],
            &token,
            &[],
        )),
    })
    .await
    .unwrap();
    let mut gate_rx = gate_rx;
    tokio::time::timeout(Duration::from_secs(10), gate_rx.changed())
        .await
        .expect("R1 到达 gate 有界")
        .expect("gate 保持打开");

    // 客户端刻意 close：provider 侧（异实例）经通道终结进入 Recovering，
    // 旋钮加速的放弃看门狗 300ms 后转 Dead（closing 旗在客户端实例——
    // provider 侧的迟到恢复防线是 Dead 拒绝 + 条件化终局提交）。
    client.close().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while shared.phase().await != session::SessionPhase::Dead {
        assert!(
            tokio::time::Instant::now() < deadline,
            "close 后 provider 侧应经看门狗转 Dead（当前 {:?}）",
            shared.phase().await
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 放行 R1：Dead 拒绝安装——无成功帧、Dead 不被拉回 Active
    shared.resume_gate.release();
    let r1 = tokio::time::timeout(Duration::from_secs(10), t1.recv()).await;
    match r1 {
        Ok(Ok(f)) => panic!("Dead 会话的迟到恢复不得收到成功帧（{:?}）", f.frame_type),
        Ok(Err(_)) | Err(_) => {}
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        assert_eq!(
            shared.phase().await,
            session::SessionPhase::Dead,
            "Dead 不得被迟到恢复复活"
        );
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(_giveup);
    provider.abort();
}
