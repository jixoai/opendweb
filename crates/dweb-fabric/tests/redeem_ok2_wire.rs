//! server-access-policy Phase 2 集成测试（附录 A/A2；tasks 2.1-2.4）：
//! - OK2 真连接舞步（v2 令牌 → 0x15 回执 + capability 附发；v1 令牌 → 0x13
//!   不变——附录 A2 兼容矩阵）；
//! - joiner 侧 OK2 解析语义（整帧级违规拒绝 / 逐条跳过计数 / 重复 url
//!   首条为准）；
//! - fabric 门面 e2e：真本地 relay 上 invite v2 → join → relay.caps.json
//!   持久化 → 重启加载注入（task 2.3 member 生命周期）。
//!
//! 进程纪律：无外部常驻进程（本地 iroh relay Server 句柄随测试 drop 回收；
//! endpoint 均内存形态）。跑侧 --test-threads 2。

use dweb_fabric::identity::NodeIdentity;
use dweb_fabric::protocol::{FabricId, InviteRelayV2, InviteV2Token, RelayCapV1, TOKEN2_PREFIX};
use dweb_fabric::roster::Roster;
use dweb_fabric::session::{
    self, RedeemCapMinter, frame_type, redeem_as_joiner, redeem_v2_as_joiner,
};
use dweb_fabric::{Fabric, FabricConfig, RelayConfig, RelayEntry, RelayTlsTrust};
use iroh::{Endpoint, EndpointAddr, RelayMode};
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::Mutex;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

const RELAY_URL: &str = "https://relay-a.example";
const SERVER_ID: [u8; 32] = [0xA1; 32];

/// 签发一支 v2 令牌（recipient 绑定 redeemer；relay 列表 = RELAY_URL 带占位
/// capability 不需要——minter 按 url 命中 restricted 条目即可）。
fn issue_v2(
    roster: &mut Roster,
    root: &NodeIdentity,
    redeemer: &NodeIdentity,
    ttl_ms: u64,
) -> InviteV2Token {
    roster
        .issue_invite_v2(
            root,
            vec![InviteRelayV2 {
                url: RELAY_URL.to_owned(),
                capability: None,
            }],
            vec![],
            redeemer.endpoint_id(),
            ttl_ms,
            now_ms(),
        )
        .unwrap()
}

/// 带 minter 的 issuer endpoint（gated 形态直连装配——fabric accept loop
/// 同款调用面；restricted 表由测试注入）。
async fn spawn_issuer(
    root: &NodeIdentity,
    restricted: Vec<(String, [u8; 32])>,
) -> (Endpoint, Arc<Mutex<Roster>>, TempDir) {
    let dir = TempDir::new().unwrap();
    let (roster, _) = Roster::create(root, dir.path(), now_ms()).unwrap();
    let roster = Arc::new(Mutex::new(roster));
    let fabric_id = roster.lock().await.fabric_id();
    let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .secret_key(root.secret_key().clone())
        .alpns(vec![session::ALPN_REDEEM.to_vec()])
        .bind()
        .await
        .unwrap();
    let ep = endpoint.clone();
    let roster2 = roster.clone();
    let identity = root.clone();
    tokio::spawn(async move {
        while let Some(incoming) = ep.accept().await {
            let Ok(conn) = incoming.accept() else { continue };
            let Ok(conn) = conn.await else { continue };
            let roster3 = roster2.clone();
            let identity = identity.clone();
            let fabric_id = fabric_id;
            let restricted = restricted.clone();
            tokio::spawn(async move {
                let commit = tokio::sync::Mutex::new(());
                let gate = Arc::new(std::sync::Mutex::new(false));
                let requested = std::sync::Mutex::new(false);
                let minter = RedeemCapMinter {
                    fabric_id,
                    signer: identity.secret_key(),
                    restricted,
                };
                let _ = session::handle_redeem_as_issuer_gated(
                    &conn,
                    &roster3,
                    &identity,
                    &commit,
                    &requested,
                    gate,
                    Some(&minter),
                )
                .await;
                let _ = tokio::time::timeout(session::REDEEM_DEADLINE, conn.closed()).await;
                conn.close(0u32.into(), b"redeem-done");
            });
        }
    });
    (endpoint, roster, dir)
}

/// 攻击者 issuer：完整舞步但不验证 PoP，最终帧由测试指定（joiner 侧 OK2
/// 解析语义的注入面）。
async fn spawn_attacker_issuer(
    final_frame: (u8, Vec<u8>),
) -> Endpoint {
    let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .secret_key(NodeIdentity::generate().secret_key().clone())
        .alpns(vec![session::ALPN_REDEEM.to_vec()])
        .bind()
        .await
        .unwrap();
    let ep = endpoint.clone();
    tokio::spawn(async move {
        while let Some(incoming) = ep.accept().await {
            let Ok(conn) = incoming.accept() else { continue };
            let Ok(conn) = conn.await else { continue };
            let frame = final_frame.clone();
            tokio::spawn(async move {
                let Ok((mut send, mut recv)) = conn.accept_bi().await else {
                    return;
                };
                // 读 INTENT / PROOF，回 CHALLENGE，最终回注帧
                let _ = session::read_frame(&mut recv, session::MAX_REDEEM_FRAME).await;
                let _ = session::write_frame(
                    &mut send,
                    frame_type::REDEEM_CHALLENGE,
                    &[0u8; 32],
                )
                .await;
                let _ = session::read_frame(&mut recv, session::MAX_REDEEM_FRAME).await;
                let _ = session::write_frame(&mut send, frame.0, &frame.1).await;
                let _ = send.finish();
                let _ = tokio::time::timeout(session::REDEEM_DEADLINE, conn.closed()).await;
            });
        }
    });
    endpoint
}

fn loopback_addr(ep: &Endpoint) -> EndpointAddr {
    let s = *ep.bound_sockets().first().unwrap();
    let ip = if s.ip().is_unspecified() {
        std::net::IpAddr::from([127, 0, 0, 1])
    } else {
        s.ip()
    };
    EndpointAddr::new(ep.id()).with_ip_addr(std::net::SocketAddr::new(ip, s.port()))
}

async fn client_endpoint(redeemer: &NodeIdentity) -> Endpoint {
    Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .secret_key(redeemer.secret_key().clone())
        .alpns(vec![session::ALPN_REDEEM.to_vec()])
        .bind()
        .await
        .unwrap()
}

/// 矩阵格 [v2 joiner × v2 issuer]：OK2(0x15) + 名册 + 附发 capability
///（recipient 绑 redeemer、默认仅 RELAY、TTL ≤ min(invite 剩余, 90d)）。
#[tokio::test]
async fn v2_redeem_returns_ok2_with_member_caps() {
    let root = NodeIdentity::from_seed([0x11; 32]);
    let redeemer = NodeIdentity::from_seed([0x21; 32]);
    let (issuer, roster, _dir) =
        spawn_issuer(&root, vec![(RELAY_URL.to_owned(), SERVER_ID)]).await;
    let mut r = roster.lock().await;
    let ttl = 3_600_000u64; // 1h < 90d → TTL = invite 剩余
    let now = now_ms();
    let token = issue_v2(&mut r, &root, &redeemer, ttl);
    drop(r);

    let client = client_endpoint(&redeemer).await;
    let conn = client
        .connect(loopback_addr(&issuer), session::ALPN_REDEEM)
        .await
        .unwrap();
    let receipt = redeem_v2_as_joiner(
        &conn,
        &token,
        redeemer.secret_key(),
        &redeemer.endpoint_id(),
    )
    .await
    .unwrap();
    conn.close(0u32.into(), b"done");
    // 名册：genesis + grant(redeemer)
    assert!(receipt.facts.len() >= 2, "genesis + grant");
    assert!(receipt
        .facts
        .iter()
        .any(|f| f.fact.subject == redeemer.endpoint_id()));
    // 附发 capability
    assert_eq!(receipt.relay_caps.len(), 1);
    assert_eq!(receipt.relay_caps[0].0, RELAY_URL);
    let cap = RelayCapV1::decode(&receipt.relay_caps[0].1).unwrap();
    assert_eq!(cap.recipient, redeemer.endpoint_id());
    assert_eq!(cap.issuer, root.endpoint_id());
    assert_eq!(cap.server_id, SERVER_ID);
    assert_eq!(cap.caps, dweb_fabric::protocol::MEMBER_CAPS);
    assert!(cap.expires_at <= now + ttl);
    assert_eq!(receipt.skipped.skipped_malformed, 0);
}

/// 矩阵格 [v2 joiner × v1 issuer]：v1 令牌一律旧 OK(0x13)——既有
/// redeem_as_joiner 路径零变化（同一 issuer 进程内分派）。
#[tokio::test]
async fn v1_redeem_still_returns_plain_ok() {
    let root = NodeIdentity::from_seed([0x31; 32]);
    let redeemer = NodeIdentity::from_seed([0x32; 32]);
    let (issuer, roster, _dir) =
        spawn_issuer(&root, vec![(RELAY_URL.to_owned(), SERVER_ID)]).await;
    let token = roster
        .lock()
        .await
        .issue_invite(
            &root,
            RELAY_URL.to_owned(),
            vec![],
            Some(redeemer.endpoint_id()),
            60_000,
            now_ms(),
        )
        .unwrap();
    let client = client_endpoint(&redeemer).await;
    let conn = client
        .connect(loopback_addr(&issuer), session::ALPN_REDEEM)
        .await
        .unwrap();
    let facts = redeem_as_joiner(
        &conn,
        &token,
        redeemer.secret_key(),
        &redeemer.endpoint_id(),
    )
    .await
    .unwrap();
    conn.close(0u32.into(), b"done");
    assert!(facts.len() >= 2, "旧 OK 路径照常返回全量名册");
}

/// minter 缺席（独立会话入口形态）：OK2 照发、附发段为空——capability
/// 是可选增强，不是兑换成立的条件（附录 A2）。
#[tokio::test]
async fn v2_redeem_without_minter_gives_empty_cap_segment() {
    let root = NodeIdentity::from_seed([0x41; 32]);
    let redeemer = NodeIdentity::from_seed([0x42; 32]);
    let (issuer, roster, _dir) = spawn_issuer(&root, Vec::new()).await;
    let mut r = roster.lock().await;
    let token = issue_v2(&mut r, &root, &redeemer, 60_000);
    drop(r);
    let client = client_endpoint(&redeemer).await;
    let conn = client
        .connect(loopback_addr(&issuer), session::ALPN_REDEEM)
        .await
        .unwrap();
    let receipt = redeem_v2_as_joiner(
        &conn,
        &token,
        redeemer.secret_key(),
        &redeemer.endpoint_id(),
    )
    .await
    .unwrap();
    conn.close(0u32.into(), b"done");
    assert!(receipt.relay_caps.is_empty());
    assert!(receipt.facts.len() >= 2);
}

/// joiner 侧 OK2 逐条跳过语义（攻击者注帧注入）：非 dwebr1. 串跳过、
/// 重复 url 首条为准——名册回执不受影响。
#[tokio::test]
async fn ok2_joiner_skips_bad_items_and_keeps_first_duplicate() {
    let root = NodeIdentity::from_seed([0x51; 32]);
    let redeemer = NodeIdentity::from_seed([0x52; 32]);
    let mut roster = {
        let dir = TempDir::new().unwrap();
        let (r, _) = Roster::create(&root, dir.path(), now_ms()).unwrap();
        r
    };
    let token = issue_v2(&mut roster, &root, &redeemer, 60_000);
    let good = RelayCapV1::sign_and_encode(
        root.secret_key(),
        &FabricId::from_name("attacker"),
        &[9; 32],
        &redeemer.endpoint_id(),
        dweb_fabric::protocol::MEMBER_CAPS,
        now_ms(),
        now_ms() + 60_000,
    )
    .unwrap();
    // fact dump = 空列表（u32 0）+ cap 段（首条合法 + 非法串 + 重复 url）
    let mut payload = (0u32).to_be_bytes().to_vec();
    let items: Vec<(String, String)> = vec![
        ("https://first.example".to_owned(), good.clone()),
        ("https://bad.example".to_owned(), "garbage-cap".to_owned()),
        ("https://first.example".to_owned(), good.clone()),
    ];
    payload.extend_from_slice(&session::encode_ok2_cap_segment(&items));
    let attacker = spawn_attacker_issuer((frame_type::REDEEM_OK2, payload)).await;
    let client = client_endpoint(&redeemer).await;
    let conn = client
        .connect(loopback_addr(&attacker), session::ALPN_REDEEM)
        .await
        .unwrap();
    let receipt = redeem_v2_as_joiner(
        &conn,
        &token,
        redeemer.secret_key(),
        &redeemer.endpoint_id(),
    )
    .await
    .unwrap();
    conn.close(0u32.into(), b"done");
    assert_eq!(receipt.relay_caps.len(), 1, "首条为准，重复丢弃");
    assert_eq!(receipt.relay_caps[0].0, "https://first.example");
    assert_eq!(receipt.skipped.skipped_malformed, 1);
    assert_eq!(receipt.skipped.skipped_duplicate, 1);
}

/// joiner 侧 OK2 整帧级违规：count 越界 / url 非 http(s) → 非结构化失败
///（JoinError::Other 语义，不降级、不部分采纳）。
#[tokio::test]
async fn ok2_joiner_rejects_whole_frame_violations() {
    let root = NodeIdentity::from_seed([0x61; 32]);
    let redeemer = NodeIdentity::from_seed([0x62; 32]);
    let mut roster = {
        let dir = TempDir::new().unwrap();
        let (r, _) = Roster::create(&root, dir.path(), now_ms()).unwrap();
        r
    };
    let token = issue_v2(&mut roster, &root, &redeemer, 60_000);
    for (name, tail) in [
        ("count>8", {
            let mut t = session::encode_ok2_cap_segment(&[]);
            t[0..4].copy_from_slice(&(9u32).to_be_bytes());
            t
        }),
        (
            "non-http url",
            session::encode_ok2_cap_segment(&[("ftp://x.example".to_owned(), "dwebr1.x".to_owned())]),
        ),
    ] {
        let mut payload = (0u32).to_be_bytes().to_vec();
        payload.extend_from_slice(&tail);
        let attacker = spawn_attacker_issuer((frame_type::REDEEM_OK2, payload)).await;
        let client = client_endpoint(&redeemer).await;
        let conn = client
            .connect(loopback_addr(&attacker), session::ALPN_REDEEM)
            .await
            .unwrap();
        let res = redeem_v2_as_joiner(
            &conn,
            &token,
            redeemer.secret_key(),
            &redeemer.endpoint_id(),
        )
        .await;
        conn.close(0u32.into(), b"done");
        match res {
            Err(dweb_fabric::RedeemError::Unstructured(reason)) => {
                assert!(reason.contains("OK2"), "{name}: {reason}");
            }
            other => panic!("{name}: expected Unstructured, got {other:?}"),
        }
    }
}

// ==== fabric 门面 e2e：真本地 relay 上 v2 全链路（task 2.3 member 持久化） ====

/// DER -> PEM（64 列换行；rustls-pki-types 1.15 仅有解码 API）。
fn cert_der_to_pem(der: &[u8]) -> Vec<u8> {
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    let b64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(der)
    };
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out.into_bytes()
}

async fn spawn_local_relay() -> (String, Vec<u8>, iroh_relay::server::Server) {
    let (certs, server_config) =
        iroh_relay::server::testing::self_signed_tls_certs_and_config();
    let der = certs[0].as_ref().to_vec();
    let tls = iroh_relay::server::TlsConfig::new(
        (std::net::Ipv4Addr::LOCALHOST, 0),
        iroh_relay::server::CertConfig::Manual { server_config },
    );
    let mut relay = iroh_relay::server::RelayConfig::new((std::net::Ipv4Addr::LOCALHOST, 0));
    relay.tls = Some(tls);
    relay.key_cache_capacity = Some(1024);
    let mut config = iroh_relay::server::ServerConfig::default();
    config.relay = Some(relay);
    config.quic = None;
    let server = iroh_relay::server::Server::spawn(config)
        .await
        .expect("spawn local iroh relay");
    let url = format!("https://{}", server.https_addr().expect("https bound"))
        .parse::<iroh::RelayUrl>()
        .unwrap()
        .to_string();
    (url, cert_der_to_pem(&der), server)
}

fn e2e_cfg(dir: &TempDir, url: &str, cert: &[u8], server_id: Option<[u8; 32]>) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::CustomWithCaps(vec![RelayEntry {
            url: url.to_owned(),
            server_id,
            token: None,
        }]),
        advertise_addrs: Vec::new(),
        secret: dweb_fabric::SecretInjection::Default,
        http_proxy: dweb_fabric::HttpProxyConfig::None,
        join_timeout_ms: 20_000,
        relay_tls_trust: RelayTlsTrust::CustomPem(cert.to_vec()),
        bind_addr: None,
    }
}

/// 全链路：root（restricted relay）invite v2 → joiner join（经 relay 拨号）
/// → OK2 附发 → relay.caps.json 落盘 → Fabric::open 重启加载注入。
#[tokio::test]
async fn fabric_v2_join_persists_member_caps_and_reloads() {
    let (relay_url, cert, _relay) = spawn_local_relay().await;
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();

    let a = Fabric::create_root(e2e_cfg(&dir_a, &relay_url, &cert, Some(SERVER_ID)))
        .await
        .unwrap();
    // root 自签 own capability 并注入（task 2.3）
    let own = a.ensure_relay_capabilities().await.unwrap();
    assert_eq!(own.len(), 1);
    assert_eq!(
        a.relay_map_token(&relay_url).as_deref(),
        Some(own[0].1.as_str())
    );

    let fabric_id = a.fabric_id_hex().await;
    let b = Fabric::attach(
        e2e_cfg(&dir_b, &relay_url, &cert, None),
        &fabric_id,
    )
    .await
    .unwrap();

    // v2 邀请（recipient 预绑定）
    let token = a
        .invite_with(
            300_000,
            Some(&b.endpoint_id()),
            dweb_fabric::InviteOptions::default(),
        )
        .await
        .unwrap();
    assert!(token.starts_with(TOKEN2_PREFIX), "restricted 配置签 v2");
    // bootstrap capability 已在 joiner 本地 RelayMap 热注入（join 拨号窗口）
    b.join(&token).await.expect("v2 join over local relay");
    assert_eq!(b.members().await.len(), 2, "joiner 成为成员");

    // member capability 持久化 + 热注入
    let caps_file = dir_b.path().join("relay.caps.json");
    assert!(caps_file.exists(), "relay.caps.json 落盘");
    let persisted = std::fs::read_to_string(&caps_file).unwrap();
    assert!(persisted.contains(&relay_url), "文件含 relay url: {persisted}");
    let map_token = b.relay_map_token(&relay_url).expect("热注入生效");
    let parsed = RelayCapV1::decode(&map_token).unwrap();
    assert_eq!(
        dweb_fabric::identity::endpoint_id_display(&parsed.recipient),
        b.endpoint_id()
    );
    assert_eq!(parsed.caps, dweb_fabric::protocol::MEMBER_CAPS);

    // 重启（open）→ 持久化 token 加载注入同源 RelayMap
    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
    let b2 = Fabric::open(e2e_cfg(&dir_b, &relay_url, &cert, None))
        .await
        .unwrap();
    assert_eq!(
        b2.relay_map_token(&relay_url).as_deref(),
        Some(map_token.as_str()),
        "open() 加载 relay.caps.json 注入"
    );
    assert_eq!(b2.members().await.len(), 2, "重启后成员关系保留");
    b2.shutdown().await.unwrap();
}
