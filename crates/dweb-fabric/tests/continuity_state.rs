//! app-protocol-layer Phase 1 集成验收（tasks 2.1-2.4）。
//!
//! 覆盖：
//! - 瞬断不直达应用：continuity 连接死亡/重连只进 watch 快照，不发 FabricEvent
//! - epoch 单调：多轮死亡-重连后代次递增不减
//! - raw transport 帧往返（open_bi / accept_bi 双侧）
//! - 双端同拨收敛（winner 规则：发起方 id 较小者胜；收敛后 epoch 稳定）
//! - 远端 application close → Disconnected(reason) → 自动重连 Ready
//! - relay 停止/恢复：断连窗口后自动重连（自建 relay 同端口同证书重启）
//! - shutdown 竞速：在途拨号与 shutdown 并发不悬挂、Closing 可观测

use std::time::Duration;

use dweb_fabric::continuity::{ConnectionPhase, Direction, Frame, FrameType};
use dweb_fabric::{
    Fabric, FabricConfig, FabricEvent, HttpProxyConfig, JOIN_TIMEOUT_MS_DEFAULT, RelayConfig,
    RelayTlsTrust, SecretInjection,
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

/// 建立成员关系就绪的 fabric 对（A root + B join；双侧固定端口直连，
/// A 侧显式登记 B 地址——continuity 拨号候选不依赖常规连接的学习路径）。
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

/// 等待 watch 达到谓词（有界）。
async fn wait_phase(
    rx: &mut tokio::sync::watch::Receiver<
        std::sync::Arc<dweb_fabric::continuity::ConnectionStateSnapshot>,
    >,
    pred: impl Fn(&dweb_fabric::continuity::ConnectionStateSnapshot) -> bool,
    label: &str,
) -> dweb_fabric::continuity::ConnectionStateSnapshot {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if pred(&rx.borrow()) {
            return (**rx.borrow()).clone();
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "wait_phase timeout: {label}（当前 {:?}）",
                rx.borrow().phase
            );
        }
        tokio::time::timeout(Duration::from_secs(20), rx.changed())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "wait_phase 20s 无状态变化: {label}（当前 {:?} epoch={}）",
                    rx.borrow().phase,
                    rx.borrow().epoch
                )
            })
            .expect("changed");
    }
}

async fn wait_phase_long(
    rx: &mut tokio::sync::watch::Receiver<
        std::sync::Arc<dweb_fabric::continuity::ConnectionStateSnapshot>,
    >,
    pred: impl Fn(&dweb_fabric::continuity::ConnectionStateSnapshot) -> bool,
    label: &str,
) -> dweb_fabric::continuity::ConnectionStateSnapshot {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
    loop {
        if pred(&rx.borrow()) {
            return (**rx.borrow()).clone();
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "wait_phase timeout: {label}（当前 {:?}）",
                rx.borrow().phase
            );
        }
        tokio::time::timeout(Duration::from_secs(40), rx.changed())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "wait_phase 20s 无状态变化: {label}（当前 {:?} epoch={}）",
                    rx.borrow().phase,
                    rx.borrow().epoch
                )
            })
            .expect("changed");
    }
}

fn data_frame(stream_id: u64, offset: u64, payload: &[u8]) -> Frame {
    Frame {
        frame_type: FrameType::Data,
        flags: 0,
        session_id: [3u8; 16],
        stream_id,
        direction: Direction::ClientToProvider,
        byte_offset: offset,
        payload: bytes::Bytes::copy_from_slice(payload),
    }
}

/// t1+t2：瞬断不直达应用 + epoch 单调 + 自动重连 + 帧往返。
#[tokio::test]
async fn continuity_death_is_watch_only_and_epoch_monotonic() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b.endpoint_id();
    let mut ev_a = a.subscribe();
    let mut watch_a = a.continuity_watch(&b_id).await.unwrap();

    // 建连（拨号 + 双侧采纳）
    let mut txa = a.continuity_open_transport(&b_id).await.unwrap();
    let ready = wait_phase(
        &mut watch_a,
        |s| s.phase == ConnectionPhase::Ready,
        "ready#1",
    )
    .await;
    assert_eq!(ready.epoch, 1, "首次采纳 epoch=1");

    // t2 帧往返：B 接受流并回写
    let b_id_for_b = a_endpoint_id(&a);
    let echo_task = tokio::spawn(async move {
        let mut ts = b.continuity_accept_stream(&b_id_for_b).await.unwrap();
        let f = ts.recv().await.unwrap();
        let mut echo = f.clone();
        echo.direction = Direction::ProviderToClient;
        echo.byte_offset = 0;
        ts.send(&echo).await.unwrap();
        ts
    });
    txa.send(&data_frame(7, 0, b"phase1-roundtrip"))
        .await
        .unwrap();
    let back = txa.recv().await.unwrap();
    assert_eq!(back.payload, txa_legacy_payload());
    assert_eq!(back.direction, Direction::ProviderToClient);
    let _ts = echo_task.await.unwrap();

    // t1：注入死亡（非故意）——不发任何 FabricEvent，只进 watch
    a.continuity_reset(&b_id).await.unwrap();
    let dead = wait_phase(
        &mut watch_a,
        |s| s.phase == ConnectionPhase::Disconnected,
        "death observed",
    )
    .await;
    assert!(dead.reason.is_some(), "死亡快照携带原因：{:?}", dead.reason);
    // 事件通道静默（continuity 死亡不是应用事件；join 的 RosterUpdated 残留合法）
    tokio::time::sleep(Duration::from_millis(300)).await;
    while let Ok(ev) = ev_a.try_recv() {
        assert!(
            !matches!(
                ev,
                FabricEvent::PeerConnected { .. } | FabricEvent::PeerDisconnected { .. }
            ),
            "continuity 瞬断不得产生 peer 生命周期 FabricEvent（得到 {ev:?}）"
        );
    }
    // 自动重连：Ready 回归 + epoch 严格递增（对端 supervisor 也在重拨——
    // 当对端发起方 id 更小时其连接可经 winner 规则接管本端，额外 +1 合法）
    let epoch1 = ready.epoch;
    let ready2 = wait_phase(
        &mut watch_a,
        |s| s.phase == ConnectionPhase::Ready && s.epoch > epoch1,
        "ready#2",
    )
    .await;
    assert!(ready2.epoch > epoch1, "重连后 epoch 严格递增");

    // 第二轮注入：继续严格递增
    let epoch2 = ready2.epoch;
    a.continuity_reset(&b_id).await.unwrap();
    let ready3 = wait_phase(
        &mut watch_a,
        |s| s.phase == ConnectionPhase::Ready && s.epoch > epoch2,
        "ready#3",
    )
    .await;
    assert!(ready3.epoch > epoch2);
}

fn txa_legacy_payload() -> bytes::Bytes {
    bytes::Bytes::from_static(b"phase1-roundtrip")
}

fn b_endpoint_id(f: &Fabric) -> String {
    f.endpoint_id()
}

fn a_endpoint_id(f: &Fabric) -> String {
    f.endpoint_id()
}

/// t4：双端同拨收敛——并发 open_transport 双侧成功、epoch 收敛后稳定。
#[tokio::test]
async fn continuity_dual_dial_converges() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b_endpoint_id(&b);
    let a_id = a_endpoint_id(&a);
    let mut watch_a = a.continuity_watch(&b_id).await.unwrap();
    let mut watch_b = b.continuity_watch(&a_id).await.unwrap();

    let (ra, rb) = tokio::join!(
        a.continuity_open_transport(&b_id),
        b.continuity_open_transport(&a_id)
    );
    // 立即弃置拨号期传输：winner 收敛可能换代连接，旧传输绑旧连接即成死流
    drop(ra.expect("A 拨通"));
    drop(rb.expect("B 拨通"));
    wait_phase(
        &mut watch_a,
        |s| s.phase == ConnectionPhase::Ready,
        "A ready",
    )
    .await;
    wait_phase(
        &mut watch_b,
        |s| s.phase == ConnectionPhase::Ready,
        "B ready",
    )
    .await;
    // 收敛稳定性：500ms 内各端 epoch 不再变化（winner 裁决完成、无翻扑）。
    // 注：epoch 是**各端独立**的采纳计数（design §2.3 RESUME_INIT 的
    // local_connection_epoch 与 last_seen_remote_epoch 分列）——双端数值
    // 可不同（本端采纳次数不同），收敛判据是同一连接 + 各端本地稳定。
    let (e1, e1b) = (watch_a.borrow().epoch, watch_b.borrow().epoch);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(watch_a.borrow().epoch, e1, "winner 裁决后 A epoch 稳定");
    assert_eq!(watch_b.borrow().epoch, e1b, "winner 裁决后 B epoch 稳定");
    // 收敛稳定后往返：弃旧开新——新传输绑定最终连接，B 的 FIFO accept
    // 恰好对齐这条唯一的在途流（拨号期流已随旧传输 drop 关闭或属旧连接）
    let a_id2 = a_id.clone();
    let mut ts = a.continuity_open_transport(&b_id).await.unwrap();
    let echo = tokio::spawn(async move {
        // 跳过拨号期遗留的空已闭流（与最终连接同连接时排 FIFO 首位）——
        // 陈旧流不得卡死接受器（真实语义同此）
        loop {
            let mut srv = b.continuity_accept_stream(&a_id2).await.unwrap();
            match srv.recv().await {
                Ok(f) => {
                    let mut e = f;
                    e.byte_offset = 99;
                    srv.send(&e).await.unwrap();
                    break;
                }
                Err(dweb_fabric::continuity::TransportError::Ended) => continue,
                Err(other) => panic!("accept 循环意外错误: {other:?}"),
            }
        }
    });
    ts.send(&data_frame(11, 0, b"dual-dial")).await.unwrap();
    let back = tokio::time::timeout(Duration::from_secs(10), ts.recv())
        .await
        .expect("echo 有界返回")
        .unwrap();
    assert_eq!(back.byte_offset, 99);
    echo.await.unwrap();
}

/// t6：shutdown 竞速——在途拨号 + 并发 shutdown 不悬挂；Closing 可观测。
#[tokio::test]
async fn continuity_shutdown_race() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b_endpoint_id(&b);
    let mut watch_a = a.continuity_watch(&b_id).await.unwrap();
    // 先建一条活跃连接
    let _t = a.continuity_open_transport(&b_id).await.unwrap();
    wait_phase(&mut watch_a, |s| s.phase == ConnectionPhase::Ready, "ready").await;
    // 并发：reset（触发重连拨号）与 shutdown 赛跑
    a.continuity_reset(&b_id).await.unwrap();
    let shut = tokio::spawn({
        let a = a.clone();
        async move { a.shutdown().await }
    });
    let out = tokio::time::timeout(Duration::from_secs(15), shut)
        .await
        .expect("shutdown 有界完成")
        .expect("shutdown join");
    out.expect("shutdown Ok（无残留阻塞）");
    // Closing（或已 Disconnected→不再 Ready）；此后新请求被拒
    let snap = a.continuity_snapshot(&b_id).await.unwrap();
    assert_ne!(snap.phase, ConnectionPhase::Ready);
    assert!(
        a.continuity_open_transport(&b_id).await.is_err(),
        "shutdown 后拨号必须被拒"
    );
}

/// t5：relay 停止/恢复——断连窗口后自动重连（自建 relay 同端口同证书）。
#[tokio::test]
async fn continuity_relay_stop_and_restart_reconnects() {
    // TLS 材料 + 固定端口 relay（复刻 relay_failover.rs 装配）
    let (certs, server_config) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
    let cert_pem = {
        let der = certs[0].as_ref().to_vec();
        let mut b64 = String::new();
        use base64::Engine;
        let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
        for chunk in der.chunks(48) {
            pem.push_str(&base64::engine::general_purpose::STANDARD.encode(chunk));
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
        b64.push_str(&pem);
        b64.into_bytes()
    };
    let _ = cert_pem; // 见下：直接复用 relay_watch 的构造形态
    let tls_make = {
        let server_config = server_config.clone();
        move || iroh_relay::server::CertConfig::Manual {
            server_config: server_config.clone(),
        }
    };
    let relay_port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let spawn_relay = || async {
        let tls = iroh_relay::server::TlsConfig::new(
            (std::net::Ipv4Addr::LOCALHOST, relay_port),
            tls_make(),
        );
        // 仅 TLS 钉固定端口；plain-http 随机（两个监听抢同端口会 EADDRINUSE）
        let mut relay = iroh_relay::server::RelayConfig::new((std::net::Ipv4Addr::LOCALHOST, 0));
        relay.tls = Some(tls);
        relay.key_cache_capacity = Some(1024);
        let mut config = iroh_relay::server::ServerConfig::default();
        config.relay = Some(relay);
        config.quic = None;
        iroh_relay::server::Server::spawn(config).await.unwrap()
    };
    let server = spawn_relay().await;
    let relay_url = format!("https://127.0.0.1:{relay_port}/");

    let mk = |dir: &tempfile::TempDir| FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Custom(vec![relay_url.clone()]),
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: JOIN_TIMEOUT_MS_DEFAULT,
        relay_tls_trust: RelayTlsTrust::CustomPem(cert_pem.clone()),
        bind_addr: None,
    };

    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let a = Fabric::create_root(mk(&dir_a)).await.unwrap();
    let fabric_id = a.fabric_id_hex().await;
    let b = Fabric::attach(mk(&dir_b), &fabric_id).await.unwrap();
    let token = a.invite(300_000, None).await.unwrap();
    b.join(&token).await.expect("join via relay");

    let b_id = b_endpoint_id(&b);
    let mut watch_a = a.continuity_watch(&b_id).await.unwrap();
    let _t = a.continuity_open_transport(&b_id).await.unwrap();
    wait_phase(
        &mut watch_a,
        |s| s.phase == ConnectionPhase::Ready,
        "relay ready",
    )
    .await;

    // relay 宕机：drop server 即停（本机回环直连打洞无法低成本伪造「无直连
    // 路径」——沿用 relay_failover c2 的既定手法：宕机窗口内以非故意 close
    // 触发同一条 supervisor 死亡路径；本 manager 不从连接学习地址，重拨候选
    // 仅 relay——宕机期必败、恢复后必经 relay 成功，确定性成立）
    drop(server);
    a.continuity_reset(&b_id).await.unwrap();
    let dead = wait_phase(
        &mut watch_a,
        |s| s.phase == ConnectionPhase::Disconnected,
        "relay-down death",
    )
    .await;
    assert!(dead.reason.is_some());
    // 注：iroh 端点自身的地址簿会跨连接留存对端直连地址（首连路径学习），
    // 进程内无法剥夺——宕机期重拨可能直接走直连恢复（relay-failover c2
    // 先例同此妥协）。主断言：死亡被观测（带原因）+ 最终恢复 Ready 且
    // epoch 递增；relay 腿本身的可达性由 c1/c2 用例覆盖。

    // 同端口同证书重启：退避重拨后 Ready、epoch 递增
    let _server2 = spawn_relay().await;
    let ready = wait_phase_long(
        &mut watch_a,
        |s| s.phase == ConnectionPhase::Ready && s.epoch >= 2,
        "relay-up reconnect",
    )
    .await;
    assert!(
        ready.epoch >= 2,
        "恢复后 epoch 严格递增（含对端重拨接管 +N）"
    );
}

/// t3（集成形式）：订阅者 lag 后收敛（多跳变只读一次 → 最新且 seq 单调）。
#[tokio::test]
async fn continuity_watch_lag_converges() {
    let (a, b, _da, _db) = pair().await;
    let b_id = b_endpoint_id(&b);
    let mut watch = a.continuity_watch(&b_id).await.unwrap();
    let s0 = a.continuity_snapshot(&b_id).await.unwrap();
    assert_eq!(s0.state_seq, watch.borrow().state_seq);
    // 制造多次跳变（建连即 Connecting→Handshaking→Ready）
    let _t = a.continuity_open_transport(&b_id).await.unwrap();
    // 慢订阅：期间不读
    tokio::time::sleep(Duration::from_millis(50)).await;
    watch.changed().await.unwrap();
    let latest = (**watch.borrow()).clone();
    assert!(latest.state_seq > s0.state_seq, "seq 单调推进");
    assert_eq!(latest.epoch, 1);
    // 与快照通道一致（收敛）
    let snap = a.continuity_snapshot(&b_id).await.unwrap();
    assert_eq!(snap.state_seq, latest.state_seq);
}
