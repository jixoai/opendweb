//! 双向并发会话开启 + 连接翻覆后的重开收敛（E1′ 修复验证的互开场景）。
//!
//! 真双机现场（2026-09-30 E1′ 修复部署后）：双端 sidecar 的 sync 引擎互相
//! 开会话（互为 client），连接经 winner 收敛后一次翻覆，再开即「continuity
//! stream io: connection lost」循环不收敛。本文件钉住：互开收敛 + 注入死亡
//! + 重开收敛（双向）。

use std::time::Duration;

use dweb_fabric::continuity::session::{self, SessionOptions};
use dweb_fabric::{
    Fabric, FabricConfig, HttpProxyConfig, JOIN_TIMEOUT_MS_DEFAULT, RelayConfig, RelayTlsTrust,
    SecretInjection,
};

fn cfg_fixed_port(dir: &tempfile::TempDir, port: u16) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Disabled,
        advertise_addrs: vec![format!("127.0.0.1:{port}")],
        bind_addr: Some(format!("127.0.0.1:{port}")),
        secret: SecretInjection::Default,
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

async fn open_bounded(fabric: &Fabric, peer: &str) -> session::Session {
    tokio::time::timeout(
        Duration::from_secs(30),
        session::open_session(fabric, peer, SessionOptions::default()),
    )
    .await
    .expect("open_session 有界")
    .expect("open_session 成功")
}

#[test]
fn mutual_open_converges_and_survives_connection_flip() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
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
        let b_id = b.endpoint_id();
        let a_id = a.endpoint_id();
        let token = a.invite(300_000, None).await.unwrap();
        b.join(&token).await.expect("join redeems invite");
        a.add_known_addr(&b_id, format!("127.0.0.1:{port_b}"))
            .await
            .unwrap();
        b.add_known_addr(&a_id, format!("127.0.0.1:{port_a}"))
            .await
            .unwrap();

        // 双端 accept 循环（受理对端发起的会话）
        for (fabric, peer) in [(a.clone(), b_id.clone()), (b.clone(), a_id.clone())] {
            tokio::spawn(async move {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
                while tokio::time::Instant::now() < deadline {
                    let s = tokio::time::timeout(
                        Duration::from_secs(30),
                        session::accept_any(&fabric, &peer, SessionOptions::default()),
                    )
                    .await;
                    match s {
                        Ok(Ok(sess)) => {
                            // 保持句柄在场
                            Box::leak(Box::new(sess));
                        }
                        _ => continue,
                    }
                }
            });
        }

        // ---- 互开（并发双 INIT：winner 收敛到单会话或双会话并存皆合法） ----
        let (ra, rb) = tokio::join!(open_bounded(&a, &b_id), open_bounded(&b, &a_id));
        let _ = (ra, rb);
        eprintln!("mutual open converged");

        // ---- 注入连接死亡（双向）+ 翻覆后重开（双向各一次） ----
        a.continuity_reset(&b_id).await.unwrap();
        b.continuity_reset(&a_id).await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let s1 = open_bounded(&b, &a_id).await;
        let st = s1.open_stream("flip-1").await.unwrap();
        s1.send_data(st, bytes::Bytes::from_static(b"after-flip"))
            .await
            .unwrap();
        s1.finish(st).await.unwrap();
        let s2 = open_bounded(&a, &b_id).await;
        let st2 = s2.open_stream("flip-2").await.unwrap();
        s2.send_data(st2, bytes::Bytes::from_static(b"reverse-after-flip"))
            .await
            .unwrap();
        s2.finish(st2).await.unwrap();
        eprintln!("post-flip reopen converged both directions");

        tokio::time::timeout(Duration::from_secs(20), b.shutdown())
            .await
            .expect("b shutdown 有界")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(20), a.shutdown())
            .await
            .expect("a shutdown 有界")
            .unwrap();
    });
}
