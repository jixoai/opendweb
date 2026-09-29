//! 真双机验收缺陷回归（2026-09-30，iMac↔Mac mini kill -9 实证的 cargo 仿真）。
//!
//! 覆盖：
//! - **同 key 崩溃重加入收敛（缺陷 A 主链）**：客户端进程硬崩（独立 runtime
//!   整体丢弃——无 close 帧，对端连接半开）后，同 endpoint key 的新实例重新
//!   加入：存活方（provider）不得用陈旧 continuity 槽位/winner 规则掐死新
//!   连接，不得用滞留的 canonical 会话拒绝新 INIT；会话有界重建。
//! - **活跃会话下的 shutdown 有界（缺陷 B）**：TERM 挂死的根因是 endpoint
//!   排干无界——本测试钉住「活跃会话 + 存活对端」下 shutdown 必须在有界
//!   时间内返回。

use std::time::Duration;

use dweb_fabric::continuity::session::{self, SessionOptions, SessionPhase};
use dweb_fabric::identity::{NodeIdentity, endpoint_id_display};
use dweb_fabric::secret::SecretSeed;
use dweb_fabric::{
    Fabric, FabricConfig, HttpProxyConfig, JOIN_TIMEOUT_MS_DEFAULT, RelayConfig, RelayTlsTrust,
    SecretInjection,
};

/// 同 seed 派生稳定身份（b1/b2 = 同 endpoint key 的两个实例）。
const MEMBER_SEED: [u8; 32] = [7u8; 32];

fn cfg_fixed_port_seed(dir: &tempfile::TempDir, port: u16, seed: [u8; 32]) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Disabled,
        advertise_addrs: vec![format!("127.0.0.1:{port}")],
        bind_addr: Some(format!("127.0.0.1:{port}")),
        secret: SecretInjection::Seed(SecretSeed::from_bytes(seed)),
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: JOIN_TIMEOUT_MS_DEFAULT,
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
    }
}

fn reserve_loopback_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// 有界建立会话（握手死等防御；缺陷 A 的收敛判据之一）。
async fn open_session_bounded(fabric: &Fabric, peer: &str) -> session::Session {
    tokio::time::timeout(
        Duration::from_secs(30),
        session::open_session(fabric, peer, SessionOptions::default()),
    )
    .await
    .expect("open_session 有界（缺陷 A：崩溃重加入的会话不得分钟级不收敛）")
    .expect("open_session 成功（陈旧 canonical/尸体连接不得拒绝重加入者）")
}

/// 同 key 崩溃重加入（存活方 = root/provider 视角）：
///
/// 1. provider（a，主 runtime）常驻 accept 循环。
/// 2. b1（同 key，**独立 runtime + 独立线程**）join → 建会话 → 标记就绪。
/// 3. b1 的 runtime 随线程退出整体丢弃——等价 kill -9：无 close 帧，
///    provider 侧连接半开（close_reason=None 的尸体窗口）、canonical 会话
///    滞留——真双机实证的坏状态。
/// 4. b2（同 key、新端口/新目录）在尸体窗口内重新加入并建新会话。
/// 5. 断言：新会话有界建立且 Active、continuity 代次推进到新连接。
#[test]
fn crash_rejoin_same_key_session_converges() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        let dir_a = tempfile::tempdir().unwrap();
        let port_a = reserve_loopback_port();
        let a = Fabric::create_root(cfg_fixed_port_seed(&dir_a, port_a, [1u8; 32]))
            .await
            .unwrap();
        let fabric_id = a.fabric_id_hex().await;
        let a_id = a.endpoint_id();
        let b_id = endpoint_id_display(&NodeIdentity::from_seed(MEMBER_SEED).endpoint_id());

        // provider accept 循环：等成员就绪后依次受理会话（每会话一次
        // accept_any；不施加短超时——中途取消在途 dial 会留半开连接，
        // 正是 connect_dial 注释里实证过的反模式）
        let provider_a = a.clone();
        let provider_b_id = b_id.clone();
        let _provider = tokio::spawn(async move {
            // 成员门就绪（b1 join 完成前 accept 会因 NotMember 热循环）
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            loop {
                if provider_a.is_member(&provider_b_id).await.unwrap_or(false) {
                    break;
                }
                assert!(tokio::time::Instant::now() < deadline, "b1 join 未完成");
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            let mut held = 0usize;
            let accept_deadline = tokio::time::Instant::now() + Duration::from_secs(90);
            while held < 2 && tokio::time::Instant::now() < accept_deadline {
                let session = tokio::time::timeout(
                    Duration::from_secs(30),
                    session::accept_any(&provider_a, &provider_b_id, SessionOptions::default()),
                )
                .await;
                match session {
                    Ok(Ok(s)) => {
                        held += 1;
                        // 句柄在场保活；不消费业务流（本测试聚焦会话层收敛）
                        drop(s);
                    }
                    // 收敛期 accept 错误（死流/竞速帧）是既有语义——继续等
                    // 下一个会话，不得 panic 中断 provider
                    Ok(Err(_)) | Err(_) => continue,
                }
            }
        });

        // b1：独立线程 + 独立 runtime（崩溃载体）
        let (b1_ready_tx, b1_ready_rx) = std::sync::mpsc::channel::<()>();
        let port_b1 = reserve_loopback_port();
        let token_holder = std::sync::Arc::new(tokio::sync::Mutex::new(None::<String>));
        let token_for_thread = token_holder.clone();
        let fabric_id_thread = fabric_id.clone();
        let a_id_thread = a_id.clone();

        let joiner = std::thread::spawn(move || {
            let rt_b = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap();
            rt_b.block_on(async move {
                let dir_b = tempfile::tempdir().unwrap();
                let b = Fabric::attach(
                    cfg_fixed_port_seed(&dir_b, port_b1, MEMBER_SEED),
                    &fabric_id_thread,
                )
                .await
                .unwrap();
                let token = token_for_thread.lock().await.take().expect("token seeded");
                b.join(&token).await.expect("join redeems invite");
                let session = tokio::time::timeout(
                    Duration::from_secs(30),
                    session::open_session(&b, &a_id_thread, SessionOptions::default()),
                )
                .await
                .expect("b1 open_session 有界")
                .expect("b1 open_session 成功");
                let s = session.open_stream("k1").await.expect("open_stream");
                session
                    .send_data(s, bytes::Bytes::from_static(b"ping-1"))
                    .await
                    .unwrap();
                session.finish(s).await.unwrap();
                let _ = b1_ready_tx.send(());
                // 不 shutdown：线程返回即丢弃整个 runtime——连接无 close 帧
                // 地消失（对 provider 而言 = 对端 kill -9 的半开尸体窗口）
                drop(b);
            });
        });

        // 主侧签 invite（v1；recipient 绑定同 key）并等 b1 会话就绪
        let token = a.invite(300_000, Some(&b_id)).await.expect("invite");
        *token_holder.lock().await = Some(token);
        b1_ready_rx
            .recv_timeout(Duration::from_secs(60))
            .expect("b1 established session");
        joiner.join().expect("b1 thread exited cleanly");

        // ---- 尸体窗口内重加入（b2：同 key、新端口/新目录） ----
        let dir_b2 = tempfile::tempdir().unwrap();
        let port_b2 = reserve_loopback_port();
        let b2 = Fabric::attach(
            cfg_fixed_port_seed(&dir_b2, port_b2, MEMBER_SEED),
            &fabric_id,
        )
        .await
        .unwrap();
        let token2 = a.invite(300_000, Some(&b_id)).await.expect("invite #2");
        b2.join(&token2).await.expect("b2 join redeems invite");
        // 直连候选显式注入（本测试聚焦会话层收敛；known_addrs 持久化另有行为面）
        b2.add_known_addr(&a_id, format!("127.0.0.1:{port_a}"))
            .await
            .unwrap();

        let t0 = std::time::Instant::now();
        let session2 = open_session_bounded(&b2, &a_id).await;
        let s = session2.open_stream("k2").await.expect("open_stream");
        session2
            .send_data(s, bytes::Bytes::from_static(b"ping-2"))
            .await
            .unwrap();
        session2.finish(s).await.unwrap();
        // 会话 Active（INIT_OK 已回、无 ALREADY_ACTIVE 滞留）
        assert_eq!(
            session2.phase().await,
            SessionPhase::Active,
            "重加入者的新会话必须 Active（不得滞留 Negotiating/Rejected）"
        );
        // provider 侧 continuity 采纳了新连接（代次 ≥ 2：b1 一次 + b2 一次）
        let watch = a.continuity_watch(&b_id).await.unwrap();
        let snap = watch.borrow().clone();
        assert!(
            snap.epoch >= 2,
            "provider 采纳了重加入者的新连接（epoch={}）：快照 {:?}",
            snap.epoch,
            snap
        );
        eprintln!(
            "crash-rejoin converged in {:?} (epoch={}, phase ok)",
            t0.elapsed(),
            snap.epoch
        );
        // 双端收尾（有界——同时是缺陷 B 的又一钉子）
        tokio::time::timeout(Duration::from_secs(20), b2.shutdown())
            .await
            .expect("b2 shutdown 有界")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(20), a.shutdown())
            .await
            .expect("a shutdown 有界")
            .unwrap();
    });
}

/// 缺陷 B 钉子：活跃会话（continuity 连接在用）下 shutdown 必须有界返回。
/// 真双机实证（TERM 后 drain 挂死、4 分钟无进展、只能 kill -9）的回归面。
#[tokio::test]
async fn shutdown_bounded_with_active_session() {
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let port_a = reserve_loopback_port();
    let port_b = reserve_loopback_port();
    let a = Fabric::create_root(cfg_fixed_port_seed(&dir_a, port_a, [1u8; 32]))
        .await
        .unwrap();
    let fabric_id = a.fabric_id_hex().await;
    let b = Fabric::attach(cfg_fixed_port_seed(&dir_b, port_b, MEMBER_SEED), &fabric_id)
        .await
        .unwrap();
    let b_id = b.endpoint_id();
    let a_id = a.endpoint_id();
    let token = a.invite(300_000, Some(&b_id)).await.unwrap();
    b.join(&token).await.expect("join redeems invite");
    b.add_known_addr(&a_id, format!("127.0.0.1:{port_a}"))
        .await
        .unwrap();

    // 活跃会话（provider 侧持续持有会话句柄）
    let provider_a = a.clone();
    let provider_b_id = b_id.clone();
    let _provider = tokio::spawn(async move {
        let session = tokio::time::timeout(
            Duration::from_secs(30),
            session::accept_any(&provider_a, &provider_b_id, SessionOptions::default()),
        )
        .await
        .expect("accept 有界")
        .expect("accept 成功");
        // 保持会话在场（continuity 连接持续在用）
        loop {
            if session.phase().await == SessionPhase::Closed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
    let client = open_session_bounded(&b, &a_id).await;
    let s = client.open_stream("k1").await.unwrap();
    client
        .send_data(s, bytes::Bytes::from_static(b"ping"))
        .await
        .unwrap();

    // 双端在有活跃会话时 shutdown——有界（缺陷 B：曾无界挂死）
    let t0 = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(20), b.shutdown())
        .await
        .expect("b shutdown 不得挂死（缺陷 B）")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(20), a.shutdown())
        .await
        .expect("a shutdown 不得挂死（缺陷 B）")
        .unwrap();
    eprintln!("both shutdowns completed in {:?}", t0.elapsed());
}
