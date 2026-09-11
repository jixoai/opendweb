//! relay failover 集成测试（c1/c2 缺陷针对性复现）：
//!
//! - c1：custom relay 列表死条目在首位时，join（invite 兑换）与会话建立必须
//!   failover 到列表中的活条目（现场证据：单条目立即成功、双条目死在前则
//!   dial-timeout 超 2 分钟不切换）。
//! - c2：会话建立后 relay 宕机再恢复，中断的会话必须自动重连（现场证据：
//!   不重启进程则永远 provider_offline）。
//!
//! 全程真实 iroh relay server（自签证书经 RelayTlsTrust::CustomPem 信任），
//! 死条目用本机已释放端口（TCP 立即 RST，非静默丢包——与现场 docker stop 一致）。

use dweb_fabric::fabric::FabricEvent;
use dweb_fabric::{Fabric, FabricConfig, RelayConfig, RelayTlsTrust, SecretInjection};
use std::net::Ipv4Addr;
use std::time::Duration;
use tempfile::TempDir;

/// DER -> PEM（64 列换行；与 relay_watch.rs 同法）。
fn cert_der_to_pem(der: &[u8]) -> Vec<u8> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap());
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    pem.into_bytes()
}

/// TLS 材料：证书 PEM（客户端信任）+ 每次起 server 用的 CertConfig 工厂
///（跨 relay 重启复用同一证书身份，端口的 CustomPem 信任保持有效；
/// ServerConfig 非 iroh-relay 公开 Clone 项，经闭包持有并克隆）。
struct TlsMaterial {
    cert_pem: Vec<u8>,
    make_cert_config: Box<dyn Fn() -> iroh_relay::server::CertConfig + Send + Sync>,
}

fn self_signed_tls() -> TlsMaterial {
    let (certs, server_config) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
    TlsMaterial {
        cert_pem: cert_der_to_pem(certs[0].as_ref()),
        make_cert_config: Box::new(move || iroh_relay::server::CertConfig::Manual {
            server_config: server_config.clone(),
        }),
    }
}

/// 在固定 HTTPS 端口起真实 relay server（drop 返回值即关停；重启用同一
/// TLS 材料保证同证书同端口）。HTTP 控制面走随机端口，与 relay_watch.rs
/// 同构：fabric 连接的 URL 来自 `server.https_addr()`。
async fn spawn_relay_on(port: u16, tls: &TlsMaterial) -> iroh_relay::server::Server {
    let tls_conf =
        iroh_relay::server::TlsConfig::new((Ipv4Addr::LOCALHOST, port), (tls.make_cert_config)());
    let mut relay = iroh_relay::server::RelayConfig::new((Ipv4Addr::LOCALHOST, 0));
    relay.tls = Some(tls_conf);
    relay.key_cache_capacity = Some(1024);
    let mut config = iroh_relay::server::ServerConfig::default();
    config.relay = Some(relay);
    config.quic = None;
    iroh_relay::server::Server::spawn(config)
        .await
        .expect("spawn iroh relay server")
}

/// 预留一个 TCP 端口并立即释放（返回时端口已无监听者：连接会被 RST）。
fn reserve_closed_tcp_port() -> u16 {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

fn relay_url_for(port: u16) -> String {
    format!("https://127.0.0.1:{port}")
}

fn cfg(dir: &TempDir, urls: Vec<String>, cert_pem: Vec<u8>) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Custom(urls),
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: dweb_fabric::HttpProxyConfig::None,
        join_timeout_ms: 8_000,
        relay_tls_trust: RelayTlsTrust::CustomPem(cert_pem),
        bind_addr: None,
    }
}

/// 有界等待 relay 快照 online=true（失败即超时，不挂死）。
async fn wait_relay_online(fabric: &Fabric, what: &str) {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            if fabric.relay_status().online == Some(true) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "{what}: relay online timed out: {:?}",
            fabric.relay_status()
        )
    });
}

async fn wait_event(
    rx: &mut tokio::sync::broadcast::Receiver<FabricEvent>,
    pred: impl Fn(&FabricEvent) -> bool,
    what: &str,
    budget: Duration,
) -> FabricEvent {
    match tokio::time::timeout(budget, async {
        loop {
            let ev = rx.recv().await.expect("event channel open");
            if pred(&ev) {
                return ev;
            }
        }
    })
    .await
    {
        Ok(ev) => ev,
        Err(_) => panic!("timeout waiting for {what}"),
    }
}

// ---- c1：死条目在首位，join 必须走活条目 -----------------------------------------

/// 现场缺陷 c1 的判别复现：issuer 与 joiner 配置同为 [dead, alive]（死在前）。
/// 期望：invite/join 成功建立（failover 到活条目），且令牌携带 issuer 实际
/// 在线的 relay（修复前：令牌携带 urls.first()=死条目，join 拨号单候选
/// 无 failover，时限内必败）。
#[tokio::test]
async fn dead_first_relay_entry_fails_over_for_join() {
    let tls = self_signed_tls();
    // 活 relay：随机空闲端口；句柄持有至测试结束（drop 即关停）
    let alive_port = reserve_closed_tcp_port();
    let _alive_server = spawn_relay_on(alive_port, &tls).await;
    let dead_port = reserve_closed_tcp_port();
    // 死条目在列表首位（与现场完全一致的形态）
    let urls = vec![relay_url_for(dead_port), relay_url_for(alive_port)];

    let dir_a = TempDir::new().unwrap();
    let a = Fabric::create_root(cfg(&dir_a, urls.clone(), tls.cert_pem.clone()))
        .await
        .expect("issuer fabric");
    wait_relay_online(&a, "issuer").await;
    // 现场证据复原：双条目配置下 issuer 自身状态应为 online（活条目生效）
    assert_eq!(a.relay_status().online, Some(true));

    let token = a
        .invite(Duration::from_secs(300).as_millis() as u64, None)
        .await
        .expect("issue invite");

    // 令牌必须携带 issuer 实际在线的 relay（活条目），而不是盲取配置首位
    let decoded = dweb_fabric::protocol::InviteToken::decode(&token).unwrap();
    assert_eq!(
        decoded.invite.issuer_relay_url,
        relay_url_for(alive_port),
        "token must carry the issuer's live relay, not urls.first()"
    );

    let dir_b = TempDir::new().unwrap();
    let b = Fabric::attach(
        cfg(&dir_b, urls.clone(), tls.cert_pem.clone()),
        &a.fabric_id_hex().await,
    )
    .await
    .expect("joiner fabric");
    wait_relay_online(&b, "joiner").await;

    // 修复判别点：join 必须在时限内成功（修复前 dial-timeout）
    b.join(&token)
        .await
        .expect("join must fail over to the live relay entry");

    // 会话建立同样必须走活条目
    b.connect(&a.endpoint_id())
        .await
        .expect("connect must fail over to the live relay entry");

    a.shutdown().await.expect("shutdown a");
    b.shutdown().await.expect("shutdown b");
}

// ---- c2：relay 宕机恢复后会话自动重连 --------------------------------------------

/// 现场缺陷 c2 的复现：relay 宕机窗口内会话中断（consumer 侧为**非人为**
/// 死亡——现场是 relay-only 会话的 relay 路径 idle 超时；本机回环上直连
/// 打洞总能让会话存活/重拨走直连，无法低成本伪造“无直连路径”，故以
/// provider 侧主动 close 触发 consumer 的同一条“非人为死亡”代码路径
/// [closed_task 同代次分支]），relay 以同一证书同端口恢复后，会话必须
/// 自动重建（不重启进程）。“宕机期间重拨必然失败、恢复后经 relay 成功”
/// 的 relay 腿由 c1 用例覆盖（拨号候选只含 relay、死条目在前仍建立成功）。
#[tokio::test]
async fn session_reconnects_after_relay_outage_recovery() {
    let tls = self_signed_tls();
    let port = reserve_closed_tcp_port();
    let relay_url = relay_url_for(port);

    let server = spawn_relay_on(port, &tls).await;

    let dir_a = TempDir::new().unwrap();
    let a = Fabric::create_root(cfg(&dir_a, vec![relay_url.clone()], tls.cert_pem.clone()))
        .await
        .expect("provider fabric");
    wait_relay_online(&a, "provider").await;

    let token = a
        .invite(Duration::from_secs(600).as_millis() as u64, None)
        .await
        .unwrap();

    let dir_b = TempDir::new().unwrap();
    let b = Fabric::attach(
        cfg(&dir_b, vec![relay_url.clone()], tls.cert_pem.clone()),
        &a.fabric_id_hex().await,
    )
    .await
    .expect("consumer fabric");
    wait_relay_online(&b, "consumer").await;

    b.join(&token).await.expect("join");
    b.connect(&a.endpoint_id()).await.expect("initial connect");

    let mut ev_b = b.subscribe();
    let mut ev_a = a.subscribe();
    // 双向消息确认会话真正在途
    b.send(&a.endpoint_id(), b"hello".to_vec()).await.unwrap();
    let _ = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::Message { .. }),
        "provider receives first message",
        Duration::from_secs(15),
    )
    .await;

    // relay 宕机：drop server 即关停全部连接
    drop(server);

    // 宕机窗口内会话中断：provider 主动 close——consumer 侧表现为对端关闭，
    // 走“非人为死亡”分支（与现场 relay 路径超时同一条 closed_task 路径）
    a.disconnect(&b.endpoint_id())
        .await
        .expect("provider closes session during outage");
    let _ = wait_event(
        &mut ev_b,
        |e| matches!(e, FabricEvent::PeerDisconnected { .. }),
        "consumer observes unexpected session death",
        Duration::from_secs(30),
    )
    .await;

    // relay 恢复（同证书同端口；持有至测试结束）
    let _server2 = spawn_relay_on(port, &tls).await;

    // 期望：不重启进程，会话自动重连（带退避的重拨监管），并恢复在途消息
    let _ = wait_event(
        &mut ev_b,
        |e| matches!(e, FabricEvent::PeerConnected { .. }),
        "consumer session auto-reconnects after relay recovery",
        Duration::from_secs(120),
    )
    .await;
    b.send(&a.endpoint_id(), b"back online".to_vec())
        .await
        .expect("send after reconnect");
    let _ = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::Message { data, .. } if data == b"back online"),
        "provider receives post-recovery message",
        Duration::from_secs(15),
    )
    .await;

    a.shutdown().await.expect("shutdown a");
    b.shutdown().await.expect("shutdown b");
}
