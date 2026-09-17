//! cloud_story —— server-access-policy 云端/远程部署的故事走查工具。
//!
//! [2026-09-18] Owner 需求：真实公网（云机 gaubee-cloud）上完整走通
//! restricted 部署故事，并作为最终走查的内核。与 tests/story_e2e.rs 的
//! 差异：S1（部署）由外部完成（脚本 + 云端容器），本工具经环境变量指向
//! 远程 gateway/relay，本地执行 S2-S8。
//!
//! 用法（见 scripts/sap-cloud-*.sh 编排）：
//! ```text
//! cloud_story prepare                # 预铸 A 名册 → 打印 fabric_id/root 公钥
//! cloud_story verify                 # S2-S8 全链路（SAP_RELAY_URL 等 env）
//! cloud_story clean                  # 删除本地工作目录
//! ```
//! 环境变量：
//! - SAP_RELAY_URL   如 http://1.2.3.4:13340（必填，verify）
//! - SAP_GATEWAY_URL 如 http://1.2.3.4:18787（必填，verify——拉 server_id）
//! - SAP_WORK_DIR    本地工作目录（默认 ./.cloud-story）

use std::path::PathBuf;
use std::time::{Duration, Instant};

use dweb_fabric::identity::{NodeIdentity, endpoint_id_display};
use dweb_fabric::protocol::{InviteV2Token, ROOT_CAPS, RelayCapV1, TOKEN2_PREFIX};
use dweb_fabric::roster::Roster;
use dweb_fabric::secret::SecretSeed;
use dweb_fabric::{
    Fabric, FabricConfig, FabricEvent, HttpProxyConfig, InviteOptions, JoinErrorCode, RelayConfig,
    RelayEntry, RelayTlsTrust, SecretInjection, precheck_join_token,
};
use iroh::SecretKey;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn story(msg: &str) {
    println!("[story] {msg}");
}

fn work_dir() -> PathBuf {
    let dir = std::env::var("SAP_WORK_DIR").unwrap_or_else(|_| ".cloud-story".into());
    let p = PathBuf::from(dir);
    std::fs::create_dir_all(&p).expect("create work dir");
    p
}

/// 演示身份：固定 seed（走查工具语义——真实部署请用随机身份）
const SEED_A: [u8; 32] = [0xA7; 32];
const SEED_B: [u8; 32] = [0xB7; 32];

fn cfg(
    dir: &std::path::Path,
    url: &str,
    server_id: Option<[u8; 32]>,
    seed: [u8; 32],
) -> FabricConfig {
    FabricConfig {
        data_dir: dir.to_owned(),
        relay: RelayConfig::CustomWithCaps(vec![RelayEntry {
            url: url.to_owned(),
            server_id,
            token: None,
        }]),
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Seed(SecretSeed::from_bytes(seed)),
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: 30_000,
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
        bind_addr: None,
    }
}

async fn http_get(url: &str, path: &str) -> (u16, String) {
    reqwest_lite_get(&format!("{url}{path}")).await
}

/// 极简 HTTPS/HTTP GET（example 无 reqwest 依赖，用 tokio 手写最小客户端：
/// 仅 http 明文形态——云端走查拓扑为反代终结 TLS 或直连 http 端口）
async fn reqwest_lite_get(url: &str) -> (u16, String) {
    let uri: axum::http::Uri = url.parse().expect("url parse");
    let host = uri.host().expect("host");
    let port = uri.port_u16().unwrap_or(80);
    let mut stream = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .expect("tcp connect 超时")
    .expect("tcp connect");
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let req = format!(
        "GET {} HTTP/1.1\r\nhost: {host}:{port}\r\nconnection: close\r\n\r\n",
        uri.path()
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

async fn fetch_server_id(gateway: &str) -> [u8; 32] {
    let (status, body) = http_get(gateway, "/services.json").await;
    assert_eq!(status, 200, "services.json: {body}");
    let manifest: serde_json::Value = serde_json::from_str(&body).unwrap();
    let hex_id = manifest["server_id"].as_str().unwrap().to_string();
    hex::decode(&hex_id).unwrap().try_into().unwrap()
}

async fn await_relay_online(f: &Fabric) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if f.relay_status().online == Some(true) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!(
        "30s 内未经 restricted relay 上线：{:?}",
        f.relay_status().last_error
    );
}

async fn recv_message(
    rx: &mut tokio::sync::broadcast::Receiver<FabricEvent>,
    expected_from: &str,
) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Ok(FabricEvent::Message { from, data })) if from == expected_from => return data,
            Ok(Ok(_)) | Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => panic!("事件流关闭: {e:?}"),
            Err(_) => continue,
        }
    }
    panic!("30s 内未收到来自 {expected_from} 的消息事件");
}

async fn raw_relay_deny_reason(relay: &str, secret: &SecretKey, token: Option<String>) -> String {
    let url: iroh::RelayUrl = relay.parse().expect("relay url");
    let tls = iroh_relay::tls::CaTlsConfig::default()
        .client_config(iroh_relay::tls::default_provider())
        .expect("tls client config");
    let mut builder = iroh_relay::client::ClientBuilder::new(
        url,
        secret.clone(),
        iroh::dns::DnsResolver::builder().build(),
    )
    .tls_client_config(tls);
    if let Some(token) = token {
        builder = builder.auth_token(token);
    }
    let result = tokio::time::timeout(Duration::from_secs(15), builder.connect()).await;
    match result {
        Ok(Err(iroh_relay::client::ConnectError::Handshake { source, .. })) => match source {
            iroh_relay::protos::handshake::Error::ServerDeniedAuth { reason, .. } => reason,
            other => panic!("非 deny 的握手失败: {other:#}"),
        },
        Ok(Err(other)) => panic!("传输层失败（非 deny）: {other:#}"),
        Ok(Ok(_)) => panic!("连接被放行（预期 deny）"),
        Err(_) => panic!("connect 超时"),
    }
}

fn dir_a() -> PathBuf {
    work_dir().join("node-a")
}
fn dir_b() -> PathBuf {
    work_dir().join("node-b")
}

fn fabric_id_hex() -> String {
    std::fs::read_to_string(work_dir().join("fabric_id.txt")).expect("先运行 prepare")
}

// ---------- 子命令 ----------

fn cmd_prepare() {
    let dir = dir_a();
    let marker = work_dir().join("fabric_id.txt");
    let root = NodeIdentity::from_seed(SEED_A);
    if marker.exists() {
        // 幂等：名册已预铸（Roster::create 拒绝 clobber 已有目录）
        let fabric_id = std::fs::read_to_string(&marker).unwrap();
        println!("prepare 完成（复用已有名册）：A 名册 @ {}", dir.display());
        println!("  fabric_id  = {fabric_id}");
        println!(
            "  root pubkey = {}",
            hex::encode(root.secret_key().public().as_bytes())
        );
        return;
    }
    std::fs::create_dir_all(&dir).unwrap();
    let (_roster, fabric_id) = Roster::create(&root, &dir, now_ms()).expect("预铸 A 名册");
    drop(_roster);
    std::fs::write(&marker, hex::encode(fabric_id.as_bytes())).unwrap();
    println!("prepare 完成：A 名册 @ {}", dir.display());
    println!("  fabric_id  = {}", hex::encode(fabric_id.as_bytes()));
    println!(
        "  root pubkey = {}",
        hex::encode(root.secret_key().public().as_bytes())
    );
    println!("下一步（admin 注册 owner，在 server 侧执行）：");
    println!(
        "  dweb-server owners register {} {}",
        hex::encode(fabric_id.as_bytes()),
        hex::encode(root.secret_key().public().as_bytes())
    );
}

async fn cmd_verify() {
    let relay_url = std::env::var("SAP_RELAY_URL").expect("SAP_RELAY_URL（如 http://IP:13340）");
    let gateway_url =
        std::env::var("SAP_GATEWAY_URL").expect("SAP_GATEWAY_URL（如 http://IP:18787）");
    let fabric_id = fabric_id_hex();
    std::fs::create_dir_all(dir_b()).unwrap();

    let server_id = fetch_server_id(&gateway_url).await;
    story(&format!(
        "S1✓ 远程 restricted server 就绪 @ {relay_url}（server_id={}…，fabric={}…）",
        hex::encode(&server_id[..4]),
        &fabric_id[..8]
    ));

    // S2 Owner A：open（root + 预铸名册）→ 自签 → 经公网 relay 上线
    let a = Fabric::open(cfg(&dir_a(), &relay_url, Some(server_id), SEED_A))
        .await
        .expect("A open");
    let a_id = a.endpoint_id();
    let own = a.ensure_relay_capabilities().await.expect("root 自签");
    assert_eq!(own.len(), 1);
    assert!(own[0].1.starts_with("dwebr1."));
    let own_cap = RelayCapV1::decode(&own[0].1).unwrap();
    assert_eq!(own_cap.server_id, server_id);
    assert_eq!(endpoint_id_display(&own_cap.recipient), a_id);
    assert_eq!(own_cap.caps, ROOT_CAPS);
    await_relay_online(&a).await;
    story("S2✓ Owner 自签 + 经公网 relay 上线");

    // S3 邀请 v2
    let id_b = NodeIdentity::from_seed(SEED_B).endpoint_id();
    let b_id = endpoint_id_display(&id_b);
    let token = a
        .invite_with(600_000, Some(&b_id), InviteOptions::default())
        .await
        .expect("v2 邀请");
    assert!(token.starts_with(TOKEN2_PREFIX));
    let decoded = InviteV2Token::decode(&token).unwrap();
    assert_eq!(endpoint_id_display(&decoded.invite.recipient), b_id);
    let bootstrap = decoded
        .invite
        .relays
        .iter()
        .find(|r| r.url == relay_url)
        .and_then(|r| r.capability.as_deref())
        .expect("内嵌 bootstrap")
        .to_owned();
    story("S3✓ v2 邀请（dweb2. + 内嵌 bootstrap cap）");

    // S4 Visitor B join（公网 relay 拨号 → OK2 → member cap 持久化）
    let b = Fabric::attach(cfg(&dir_b(), &relay_url, None, SEED_B), &fabric_id)
        .await
        .expect("B attach");
    b.join(&token)
        .await
        .expect("B 经公网 restricted relay join");
    assert_eq!(b.members().await.len(), 2);
    let b_token = b.relay_map_token(&relay_url).expect("member cap 注入");
    let member_cap = RelayCapV1::decode(&b_token).unwrap();
    assert_eq!(endpoint_id_display(&member_cap.recipient), b_id);
    await_relay_online(&b).await;
    story("S4✓ Visitor join + member capability 持久化（relay.caps.json）");

    // S5 通信
    let mut rx_a = a.subscribe();
    b.connect(&a_id).await.expect("B→A connect");
    b.send(&a_id, b"cloud-story: hello from B".to_vec())
        .await
        .expect("send");
    let data = recv_message(&mut rx_a, &b_id).await;
    assert_eq!(data, b"cloud-story: hello from B".to_vec());
    let path = b
        .link_status(&a_id)
        .await
        .map(|s| format!("{s:?}"))
        .unwrap_or_else(|_| "unknown".into());
    story(&format!("S5✓ 公网通信成功（路径 {path}）"));

    // S6 越权矩阵（远程 raw 直连）
    let secret_c = SecretKey::generate();
    assert_eq!(
        raw_relay_deny_reason(&relay_url, &secret_c, None).await,
        "dweb/no-capability"
    );
    assert_eq!(
        raw_relay_deny_reason(&relay_url, &secret_c, Some(b_token.clone())).await,
        "dweb/not-recipient"
    );
    assert_eq!(
        raw_relay_deny_reason(&relay_url, &secret_c, Some(bootstrap.clone())).await,
        "dweb/not-recipient"
    );
    story("S6✓ 越权矩阵（无票 / 转借票 ×2 全拒）");

    // S7 v1-only 客户端解析 dweb2. → 第九码
    let err = precheck_join_token(&token).expect_err("v1-only 拒绝 v2");
    match &err {
        dweb_fabric::FabricError::Join { code, .. } => {
            assert_eq!(code, &JoinErrorCode::UnsupportedInviteVersion);
        }
        other => panic!("非 Join 错误: {other}"),
    }
    story("S7✓ v1-only 兼容（unsupported-invite-version）");

    // S8 重启恢复（本地进程重建 + relay.caps.json 重载）
    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
    let a2 = Fabric::open(cfg(&dir_a(), &relay_url, Some(server_id), SEED_A))
        .await
        .expect("A 重启");
    a2.ensure_relay_capabilities().await.unwrap();
    await_relay_online(&a2).await;
    let b2 = Fabric::open(cfg(&dir_b(), &relay_url, None, SEED_B))
        .await
        .expect("B 重启（重载 relay.caps.json）");
    assert_eq!(
        b2.relay_map_token(&relay_url).as_deref(),
        Some(b_token.as_str())
    );
    await_relay_online(&b2).await;
    let mut rx_a2 = a2.subscribe();
    b2.connect(&a2.endpoint_id()).await.expect("重启后 connect");
    b2.send(&a2.endpoint_id(), b"cloud-story: after restart".to_vec())
        .await
        .expect("重启后 send");
    let data = recv_message(&mut rx_a2, &b_id).await;
    assert_eq!(data, b"cloud-story: after restart".to_vec());
    story("S8✓ 重启恢复 + 再次通信");

    b2.shutdown().await.unwrap();
    a2.shutdown().await.unwrap();
    story("S2-S8 云端故事全部通过 ✅");
}

fn cmd_clean() {
    let dir = work_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
        println!("已删除 {}", dir.display());
    }
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("用法: cloud_story <prepare|verify|clean>");
        std::process::exit(2);
    });
    match cmd.as_str() {
        "prepare" => cmd_prepare(),
        "verify" => {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(cmd_verify());
        }
        "clean" => cmd_clean(),
        other => {
            eprintln!("未知子命令 {other}（prepare|verify|clean）");
            std::process::exit(2);
        }
    }
}
