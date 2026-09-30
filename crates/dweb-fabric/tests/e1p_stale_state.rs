//! E1′ 残余死锁簇回归（2026-09-30 真双机第六批实录的 cargo 仿真）。
//!
//! 现场形态（mini→iMac 当日不可恢复）：iMac mihomo TUN 劫持窗口过后，双方
//! fabric 沉积三层互锁状态——
//! 1. **per-remote 半开尸体**（旧会话时代的死连接槽位：close_reason=None、
//!    pump 阻塞在永不返回的流读盘——is_dead 恒 false）；
//! 2. **provider 侧 ALREADY_ACTIVE canonical 滞留**（Active canonical 的
//!    通道层活性信号缺失，新 sid INIT 被持续拒绝）；
//! 3. **scratch 端口交叉学习墓地**（对端 direct-dial 专用 endpoint 的临时
//!    随机端口被学进 known_addrs 并持久化，端点弃置即死；双方互相拨对方
//!    死端口）。
//!
//! 本文件钉住修复后的语义：**双方互相带尸体 + 死地址 + canonical 滞留下，
//! 同 key 重加入者的新会话必须有界建立，且 root→member 反向同样恢复**。
//!
//! 脏地址经 **v1 known_addrs.json 预置**注入（不落盘迁移路径的忠实复现：
//! 旧格式条目加载时降级 ObservedInbound——不落盘、TTL/失败修剪）。

use std::time::Duration;

use dweb_fabric::continuity::session::{self, SessionOptions, SessionPhase};
use dweb_fabric::identity::{NodeIdentity, endpoint_id_display};
use dweb_fabric::secret::SecretSeed;
use dweb_fabric::{
    Fabric, FabricConfig, HttpProxyConfig, JOIN_TIMEOUT_MS_DEFAULT, RelayConfig, RelayTlsTrust,
    SecretInjection,
};

/// 同 seed 派生稳定身份（b1/b2 = 同 endpoint key 的两个实例）。
const MEMBER_SEED: [u8; 32] = [0xE1; 32];

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

/// 预置 v1 格式 known_addrs.json（脏地址墓地：E1′ 现场的旧持久化文件形态）。
/// v1 = [[endpoint z32, ["ip:port", ...]], ...]；加载路径降级 ObservedInbound。
fn prewrite_v1_known_addrs(dir: &tempfile::TempDir, entries: &[(String, Vec<String>)]) {
    let path = dir.path().join("known_addrs.json");
    let json = serde_json::to_string_pretty(entries).unwrap();
    std::fs::write(path, json).expect("prewrite v1 known_addrs.json");
}

/// 有界建立会话（握手死等防御）。
async fn open_session_bounded(fabric: &Fabric, peer: &str) -> session::Session {
    tokio::time::timeout(
        Duration::from_secs(30),
        session::open_session(fabric, peer, SessionOptions::default()),
    )
    .await
    .expect("open_session 有界（E1′：互锁状态下不得分钟级不收敛）")
    .expect("open_session 成功（尸体/死地址/滞留 canonical 不得拒绝重加入者）")
}

/// E1′ 互锁死锁簇主回归：
///
/// 1. a（root，固定端口 pa）+ b1（member，固定端口 pb1，独立线程/runtime）；
///    a 的 v1 known_addrs 预置对 b 的死地址（模拟 root 侧墓地）。
/// 2. b1 join + 建会话（provider a 沉积：半开尸体连接 + Active canonical
///    + 会话通道——b1 的连接对 a 而言将变尸体）。
/// 3. b1 线程整体丢弃（= kill -9：无 close 帧，a 侧连接半开）。
/// 4. b2（同 key、新端口 pb2、新目录）携带**对 a 的死地址墓地**（v1 文件
///    预置两个死端口 + join 宣告的 pa 活地址）重加入。
/// 5. 断言：b2 新会话有界建立且 Active（canonical 滞留 + 尸体 + 死地址
///    三层互锁下不得卡死）。
/// 6. 反向恢复语义：a 向 b 开新会话（a 侧候选含死 pb1 墓地 + b2 拨入观测
///    到的 pb2）——必须有界建立（「重启单端救不回」不可接受）。
#[test]
fn e1p_mutual_stale_state_reconverges() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        let dir_a = tempfile::tempdir().unwrap();
        let port_a = reserve_loopback_port();
        let port_b1 = reserve_loopback_port();
        // a 侧墓地：b 的旧端口 pb1（b1 弃置后即死）+ 一个从未存在的端口
        let b_id = endpoint_id_display(&NodeIdentity::from_seed(MEMBER_SEED).endpoint_id());
        let a_dead_ports = vec![
            format!("127.0.0.1:{port_b1}"),
            format!("127.0.0.1:{}", reserve_loopback_port()),
        ];
        prewrite_v1_known_addrs(&dir_a, &[(b_id.clone(), a_dead_ports.clone())]);

        let a = Fabric::create_root(cfg_fixed_port_seed(&dir_a, port_a, [1u8; 32]))
            .await
            .unwrap();
        let fabric_id = a.fabric_id_hex().await;
        let a_id = a.endpoint_id();

        // provider accept 循环（受理 b1 与 b2 两代会话）
        let provider_a = a.clone();
        let provider_b_id = b_id.clone();
        let _provider = tokio::spawn(async move {
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
            while held < 3 && tokio::time::Instant::now() < accept_deadline {
                let session = tokio::time::timeout(
                    Duration::from_secs(30),
                    session::accept_any(&provider_a, &provider_b_id, SessionOptions::default()),
                )
                .await;
                match session {
                    Ok(Ok(s)) => {
                        held += 1;
                        drop(s);
                    }
                    Ok(Err(_)) | Err(_) => continue,
                }
            }
        });

        // b1：独立线程 + 独立 runtime（崩溃载体）；会话建立后线程丢弃
        let (b1_ready_tx, b1_ready_rx) = std::sync::mpsc::channel::<()>();
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
                let s = session.open_stream("e1p-1").await.unwrap();
                session
                    .send_data(s, bytes::Bytes::from_static(b"stale-era"))
                    .await
                    .unwrap();
                session.finish(s).await.unwrap();
                let _ = b1_ready_tx.send(());
                // 不 shutdown：线程返回即丢弃整个 runtime——对 a 而言 =
                // kill -9 的半开尸体（close_reason=None、pump 挂在读盘）
                drop(b);
            });
        });

        let token = a.invite(300_000, Some(&b_id)).await.expect("invite");
        *token_holder.lock().await = Some(token);
        b1_ready_rx
            .recv_timeout(Duration::from_secs(60))
            .expect("b1 established session");
        joiner.join().expect("b1 thread exited cleanly");

        // ---- E1′ 互锁窗口：a 持有尸体连接 + Active canonical + 死地址墓地 ----

        // b2：同 key、新端口、新目录；对 a 的地址表 = v1 墓地（两个死端口）
        // + join 宣告的 pa（活）——忠实复现 mini 侧 known_addrs 形态
        //（announced 3341 + 两个死 scratch 端口）。
        let dir_b2 = tempfile::tempdir().unwrap();
        let port_b2 = reserve_loopback_port();
        let b2_dead_ports = vec![
            format!("127.0.0.1:{}", reserve_loopback_port()),
            format!("127.0.0.1:{}", reserve_loopback_port()),
        ];
        prewrite_v1_known_addrs(&dir_b2, &[(a_id.clone(), b2_dead_ports.clone())]);
        let b2 = Fabric::attach(
            cfg_fixed_port_seed(&dir_b2, port_b2, MEMBER_SEED),
            &fabric_id,
        )
        .await
        .unwrap();
        let token2 = a.invite(300_000, Some(&b_id)).await.expect("invite #2");
        b2.join(&token2).await.expect("b2 join redeems invite");

        let t0 = std::time::Instant::now();
        let session2 = open_session_bounded(&b2, &a_id).await;
        let s = session2.open_stream("e1p-2").await.unwrap();
        session2
            .send_data(s, bytes::Bytes::from_static(b"rejoin-era"))
            .await
            .unwrap();
        session2.finish(s).await.unwrap();
        assert_eq!(
            session2.phase().await,
            SessionPhase::Active,
            "重加入者的新会话必须 Active（不得滞留 Negotiating/Rejected）"
        );
        let forward = t0.elapsed();
        eprintln!("e1p forward (member→root) converged in {forward:?}");

        // ---- 反向恢复语义：root→member（「重启单端救不回」不可接受） ----
        // a 的候选：死 pb1 墓地（v1 预置）+ b2 拨入观测到的 pb2（活）。
        let t1 = std::time::Instant::now();
        let session_r = open_session_bounded(&a, &b_id).await;
        let sr = session_r.open_stream("e1p-r").await.unwrap();
        session_r
            .send_data(sr, bytes::Bytes::from_static(b"reverse"))
            .await
            .unwrap();
        session_r.finish(sr).await.unwrap();
        assert_eq!(session_r.phase().await, SessionPhase::Active);
        let reverse = t1.elapsed();
        eprintln!("e1p reverse (root→member) converged in {reverse:?}");

        // 双端收尾有界
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
