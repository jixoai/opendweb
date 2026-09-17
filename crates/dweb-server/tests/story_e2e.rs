//! server-access-policy Phase 2 故事级 e2e（task 2.7）。
//!
//! 在 Phase 1 黑盒矩阵（server_access_e2e.rs）与 fabric 侧 OK2 集成
//! （dweb-fabric redeem_ok2_wire.rs）之上，用 dweb-fabric 的 Fabric API
//! 对**真 restricted dweb-server 二进制**走完整部署故事，每步断言：
//!
//! ```text
//! S1 admin 部署    ：tmp data_dir → owners register（root keypair）→
//!                    restricted 启动 → services.json 拉 server_id
//! S2 Owner A       ：预铸名册 + seed 注入 Fabric::open（root）→
//!                    CustomWithCaps(server_id) → ensure_relay_capabilities
//!                    自签（dwebr1.、recipient==A、caps 全位）→ 经 relay 上线
//! S3 邀请          ：invite v2（条目带 server_id 触发）→ dweb2. 前缀 +
//!                    内嵌 bootstrap capability（recipient==B）
//! S4 Visitor B 加入：独立 tmp data_dir → attach → join（bootstrap 热注入后
//!                    经 restricted relay 拨号）→ OK2 兑换 → 名册含 B；
//!                    relay.caps.json 落盘（member cap、recipient==B）
//! S5 通信          ：B→A connect+send → A 事件面收到回程
//! S6 越权矩阵      ：C 无票 → no-capability；B 的 member 票给 C →
//!                    not-recipient；C 重放 A 给 B 的票 → not-recipient
//! S7 v1/v2 兼容    ：旧形态 Custom 配置的 root 在 restricted server 上签
//!                    v1 invite → 无票 joiner 被拒（deny reason 可诊断）；
//!                    v1-only precheck 解析 dweb2. → unsupported-invite-version
//! S8 重启恢复      ：A/B 进程重建（open 重载 relay.caps.json；root 重签
//!                    own cap）→ 再次通信成功
//! ```
//!
//! 进程纪律：Server guard Drop 恒 kill+wait；fabric endpoint 显式
//! shutdown；端口 0 内核分配。故事线性依赖强，单测试函数承载（文件内
//! 天然串行；跑侧可与其它 e2e 并行——端口/目录全隔离）。
//!
//! 故事进度以 stdout 打印（bin-only crate 的集成测试无 tracing subscriber，
//! println 为走查等价物；server 子进程自身日志在 guard 缓冲，失败时倾倒）。

use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dweb_fabric::identity::{NodeIdentity, endpoint_id_display};
use dweb_fabric::protocol::{InviteV2Token, ROOT_CAPS, RelayCapV1, TOKEN_PREFIX, TOKEN2_PREFIX};
use dweb_fabric::roster::Roster;
use dweb_fabric::secret::SecretSeed;
use dweb_fabric::{
    Fabric, FabricConfig, FabricError, FabricEvent, HttpProxyConfig, InviteOptions, JoinErrorCode,
    RelayConfig, RelayEntry, RelayTlsTrust, SecretInjection, precheck_join_token,
};
use iroh::{RelayUrl, SecretKey};
use tempfile::TempDir;

/// Cargo 为包内 bin 目标注入的可执行路径
const BIN: &str = env!("CARGO_BIN_EXE_dweb-server");

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn story(msg: &str) {
    println!("[story] {msg}");
}

// ---------- dweb-server 子进程管理（guard 恒回收；同 server_access_e2e 惯例） ----------

struct Server {
    child: Child,
    logs: Arc<Mutex<Vec<String>>>,
    gateway: SocketAddr,
    relay: Option<SocketAddr>,
}

impl Server {
    fn spawn(data_dir: &Path, envs: &[(&str, &str)], extra_args: &[&str]) -> Server {
        let mut cmd = Command::new(BIN);
        cmd.arg("--gateway")
            .arg("127.0.0.1:0")
            .arg("--relay")
            .arg("127.0.0.1:0")
            .args(extra_args)
            .env("DWEB_DATA_DIR", data_dir)
            .envs(envs.iter().map(|(k, v)| (*k, *v)))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().expect("spawn dweb-server");
        let logs = Arc::new(Mutex::new(Vec::new()));
        spawn_log_drain(&mut child, logs.clone());
        let mut server = Server {
            child,
            logs,
            gateway: "127.0.0.1:0".parse().unwrap(),
            relay: None,
        };
        server.wait_ready();
        server
    }

    fn wait_ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(15);
        let (mut gateway, mut relay) = (None, None);
        while Instant::now() < deadline {
            if let Ok(Some(status)) = self.child.try_wait() {
                let dump = self.logs.lock().unwrap().join("\n");
                panic!("dweb-server 提前退出 {status}：\n{dump}");
            }
            let gl = self.logs.lock().unwrap();
            if gateway.is_none() {
                gateway = gl
                    .iter()
                    .find_map(|l| parse_listening_addr(l, "gateway listening on http://"));
            }
            if relay.is_none() {
                relay = gl
                    .iter()
                    .find_map(|l| parse_listening_addr(l, "iroh relay listening on http://"));
            }
            drop(gl);
            if gateway.is_some() && relay.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.gateway = gateway.unwrap_or_else(|| {
            let dump = self.logs.lock().unwrap().join("\n");
            panic!("15s 内未见 gateway 就绪日志：\n{dump}")
        });
        self.relay = Some(relay.unwrap_or_else(|| {
            let dump = self.logs.lock().unwrap().join("\n");
            panic!("15s 内未见 relay 就绪日志：\n{dump}")
        }));
    }

    fn relay_addr(&self) -> SocketAddr {
        self.relay.expect("relay 未启用")
    }
}

impl Drop for Server {
    /// 进程回收纪律：kill + wait（孙进程随 iroh-relay 同进程退出收敛）
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn parse_listening_addr(line: &str, marker: &str) -> Option<SocketAddr> {
    line.split(marker)
        .nth(1)?
        .trim()
        .trim_end_matches('"')
        .parse()
        .ok()
}

fn spawn_log_drain(child: &mut Child, logs: Arc<Mutex<Vec<String>>>) {
    fn drain<S: std::io::Read + Send + 'static>(stream: Option<S>, logs: Arc<Mutex<Vec<String>>>) {
        let Some(stream) = stream else { return };
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                logs.lock().unwrap().push(line);
            }
        });
    }
    drain(child.stdout.take(), logs.clone());
    drain(child.stderr.take(), logs);
}

// ---------- 服务面交互辅助（同 server_access_e2e 的极简形态） ----------

async fn http_get(addr: SocketAddr, path: &str) -> (u16, String) {
    let mut stream =
        tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(addr))
            .await
            .expect("tcp connect 超时")
            .expect("tcp connect");
    let req = format!("GET {path} HTTP/1.1\r\nhost: {addr}\r\nconnection: close\r\n\r\n");
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, body)
}

async fn fetch_server_id(gateway: SocketAddr) -> [u8; 32] {
    let (status, body) = http_get(gateway, "/services.json").await;
    assert_eq!(status, 200, "services.json: {body}");
    let manifest: serde_json::Value = serde_json::from_str(&body).unwrap();
    let hex_id = manifest["server_id"].as_str().unwrap().to_string();
    assert_eq!(hex_id.len(), 64, "server_id 应为 64 hex: {hex_id}");
    hex::decode(&hex_id).unwrap().try_into().unwrap()
}

fn owners_cli(data_dir: &Path, verb: &str, fabric_id: &[u8; 32], root: &[u8; 32]) {
    let out = Command::new(BIN)
        .args([
            "owners",
            "--data-dir",
            data_dir.to_str().unwrap(),
            verb,
            &hex::encode(fabric_id),
            &hex::encode(root),
        ])
        .output()
        .expect("run owners cli");
    assert!(
        out.status.success(),
        "owners {verb} 失败: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

// ---------- raw relay 客户端（deny reason 经握手协议回传的唯一可断言形态） ----------

fn relay_url(relay: SocketAddr) -> RelayUrl {
    format!("http://{relay}").parse().expect("relay url")
}

async fn raw_relay_connect(
    relay: SocketAddr,
    secret: &SecretKey,
    token: Option<String>,
) -> Result<(), iroh_relay::client::ConnectError> {
    let tls = iroh_relay::tls::CaTlsConfig::default()
        .client_config(iroh_relay::tls::default_provider())
        .expect("tls client config");
    let mut builder = iroh_relay::client::ClientBuilder::new(
        relay_url(relay),
        secret.clone(),
        iroh::dns::DnsResolver::builder().build(),
    )
    .tls_client_config(tls);
    if let Some(token) = token {
        builder = builder.auth_token(token);
    }
    builder.connect().await.map(|_| ())
}

/// 断言被拒并返回 deny reason
async fn expect_denied(relay: SocketAddr, secret: &SecretKey, token: Option<String>) -> String {
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        raw_relay_connect(relay, secret, token),
    )
    .await
    .expect("connect 超时（10s）");
    match result {
        Err(iroh_relay::client::ConnectError::Handshake { source, .. }) => match source {
            iroh_relay::protos::handshake::Error::ServerDeniedAuth { reason, .. } => reason,
            other => panic!("非 deny 的握手失败: {other:#}"),
        },
        Err(other) => panic!("传输层失败（非 deny）: {other:#}"),
        Ok(()) => panic!("连接被放行（预期 deny）"),
    }
}

// ---------- fabric 侧辅助 ----------

/// 故事节点配置：CustomWithCaps 单 relay 条目（server_id 按参数；seed 注入
/// 身份——测试身份先于 server 存在，S1 注册 owner 需要 fabric_id+pubkey）。
fn story_cfg(
    dir: &TempDir,
    url: &str,
    server_id: Option<[u8; 32]>,
    seed: [u8; 32],
) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::CustomWithCaps(vec![RelayEntry {
            url: url.to_owned(),
            server_id,
            token: None,
        }]),
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Seed(SecretSeed::from_bytes(seed)),
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: 20_000,
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
        bind_addr: None,
    }
}

/// 旧形态配置（v1 客户端行为基线；S7 用）
fn legacy_cfg(dir: &TempDir, url: &str) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Custom(vec![url.to_owned()]),
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: 20_000,
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
        bind_addr: None,
    }
}

/// 等 fabric 经 relay 上线（restricted 部署下 = 凭证被接受）
async fn await_relay_online(f: &Fabric) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if f.relay_status().online == Some(true) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!(
        "30s 内未经 restricted relay 上线（凭证被拒或网络故障）：{:?}",
        f.relay_status().last_error
    );
}

/// 等 relay 状态快照记录 deny reason（task 2.5 诊断面）并返回之
async fn await_deny_in_status(f: &Fabric, budget: Duration) -> String {
    const PREFIX: &str = "dweb/";
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        let snapshot = f.relay_status();
        if let Some(err) = &snapshot.last_error
            && let Some(at) = err.find(PREFIX)
        {
            // reason 主体 = "dweb/" 之后的语法段（[a-z0-9._-] 连续段）
            let body = &err[at + PREFIX.len()..];
            let end = body
                .find(|c: char| {
                    !(c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
                })
                .unwrap_or(body.len());
            assert!(!body.is_empty(), "deny reason 主体为空：{err}");
            return format!("{}{}", PREFIX, &body[..end]);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!(
        "{budget:?} 内 relay 状态未记录 deny reason（last_error={:?}）",
        f.relay_status().last_error
    );
}

/// 从 A 的事件流收一条 Message（S5/S8 通信断言）
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
            Err(_) => continue, // 单次 5s 空转，外层 deadline 收敛
        }
    }
    panic!("30s 内未收到来自 {expected_from} 的消息事件");
}

// ---------- S1-S8 故事 ----------

#[tokio::test]
async fn restricted_story_s1_to_s8() {
    // S1 admin 部署：root 身份/名册预铸（fabric_id 先于 server 存在）→ 注册
    // owner → restricted 启动 → services.json 拉 server_id
    let dir_server = TempDir::new().unwrap();
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let seed_a: [u8; 32] = [0xA7; 32];
    let seed_b: [u8; 32] = [0xB7; 32];
    let root_a = NodeIdentity::from_seed(seed_a);
    let (_roster, fabric_id) = Roster::create(&root_a, dir_a.path(), now_ms())
        .expect("预铸 A 名册（fabric_id 先于 server 存在）");
    drop(_roster);
    owners_cli(
        dir_server.path(),
        "register",
        fabric_id.as_bytes(),
        root_a.secret_key().public().as_bytes(),
    );
    let server = Server::spawn(
        dir_server.path(),
        &[("DWEB_ACCESS_MODE", "restricted")],
        &[],
    );
    let server_id = fetch_server_id(server.gateway).await;
    let relay_addr = server.relay_addr();
    let relay_url_s = format!("http://{relay_addr}");
    story(&format!(
        "S1 admin 部署完成：restricted server @ {relay_addr}（server_id={}…）",
        hex::encode(&server_id[..4])
    ));

    // S2 Owner A：open（root）→ 自签 own capability → 经 restricted relay 上线
    let a = Fabric::open(story_cfg(&dir_a, &relay_url_s, Some(server_id), seed_a))
        .await
        .expect("A open（root 身份 + 预铸名册）");
    let a_id = a.endpoint_id();
    assert_eq!(a_id, endpoint_id_display(&root_a.endpoint_id()));
    let own = a.ensure_relay_capabilities().await.expect("root 自签");
    assert_eq!(own.len(), 1, "单 restricted 条目 → 单 own capability");
    assert_eq!(own[0].0, relay_url_s);
    assert!(own[0].1.starts_with("dwebr1."), "own cap 为 dwebr1. 串");
    let own_cap = RelayCapV1::decode(&own[0].1).expect("own cap 可解码");
    assert_eq!(own_cap.server_id, server_id, "cap 绑定该 server");
    assert_eq!(
        endpoint_id_display(&own_cap.recipient),
        a_id,
        "recipient == root 自身"
    );
    assert_eq!(own_cap.caps, ROOT_CAPS, "root 全位");
    assert_eq!(
        a.relay_map_token(&relay_url_s).as_deref(),
        Some(own[0].1.as_str()),
        "own cap 已注入本地 RelayMap"
    );
    await_relay_online(&a).await;
    story("S2 Owner A 自签 + 上线完成");

    // S3 邀请：条目带 server_id → v2 令牌 + 内嵌 bootstrap capability
    let id_b = NodeIdentity::from_seed(seed_b).endpoint_id();
    let b_id = endpoint_id_display(&id_b);
    let token = a
        .invite_with(300_000, Some(&b_id), InviteOptions::default())
        .await
        .expect("签发 v2 邀请");
    assert!(token.starts_with(TOKEN2_PREFIX), "restricted 配置签 v2");
    let decoded = InviteV2Token::decode(&token).expect("v2 令牌可解码");
    assert_eq!(endpoint_id_display(&decoded.invite.recipient), b_id);
    let bootstrap = decoded
        .invite
        .relays
        .iter()
        .find(|r| r.url == relay_url_s)
        .and_then(|r| r.capability.as_deref())
        .expect("restricted 条目内嵌 bootstrap capability")
        .to_owned();
    assert!(bootstrap.starts_with("dwebr1."));
    let boot_cap = RelayCapV1::decode(&bootstrap).expect("bootstrap cap 可解码");
    assert_eq!(endpoint_id_display(&boot_cap.recipient), b_id, "预绑定 B");
    story("S3 v2 邀请签发完成（dweb2. + 内嵌 cap）");

    // S4 Visitor B：attach → join（bootstrap 热注入 → restricted relay 拨号
    // → OK2 兑换 → member cap 持久化）
    // 回归（云端实证 2026-09-18）：B 数据面残留上一次部署的过期 member
    // capability——open 构造期注入 RelayMap 会让 eager relay 会话以过期票
    // 握手被拒并进入 deny 退避，join 的 bootstrap 覆盖 map 也追不上退避
    // 窗口。加载侧必须丢弃过期条目，新邀请 bootstrap 胜出。
    {
        let stale_now = now_ms();
        let stale = RelayCapV1::sign_and_encode(
            root_a.secret_key(),
            &fabric_id,
            &server_id,
            &id_b,
            dweb_fabric::protocol::CAP_RELAY,
            stale_now - 120_000,
            stale_now - 60_000,
        )
        .expect("铸过期 member cap（root 签、recipient=B，形态与 OK2 附发一致）");
        std::fs::write(
            dir_b.path().join("relay.caps.json"),
            serde_json::to_string(&serde_json::json!([
                { "url": relay_url_s, "capability": stale }
            ]))
            .unwrap(),
        )
        .expect("预置过期 member cap（模拟上次部署残留）");
    }
    let b = Fabric::attach(
        story_cfg(&dir_b, &relay_url_s, None, seed_b),
        &hex::encode(fabric_id.as_bytes()),
    )
    .await
    .expect("B attach");
    b.join(&token)
        .await
        .expect("B 经 restricted relay join 成功");
    let members = b.members().await;
    assert_eq!(members.len(), 2, "名册含 root+B");
    assert!(
        members.iter().any(|m| m.endpoint_id == b_id),
        "roster 含 B：{members:?}"
    );
    let caps_file = dir_b.path().join("relay.caps.json");
    let persisted = std::fs::read_to_string(&caps_file).expect("relay.caps.json 落盘");
    assert!(persisted.contains(&relay_url_s), "文件含 relay url");
    let b_token = b
        .relay_map_token(&relay_url_s)
        .expect("member capability 已热注入");
    assert!(b_token.starts_with("dwebr1."));
    let member_cap = RelayCapV1::decode(&b_token).expect("member cap 可解码");
    assert_eq!(endpoint_id_display(&member_cap.recipient), b_id);
    assert_eq!(member_cap.caps, dweb_fabric::protocol::MEMBER_CAPS);
    await_relay_online(&b).await;
    story("S4 Visitor B join + member capability 持久化完成");

    // S5 通信：B→A（路径 direct 或 relay 均可，断言内容与来源）
    let mut rx_a = a.subscribe();
    b.connect(&a_id).await.expect("B→A connect");
    b.send(&a_id, b"story: hello from B".to_vec())
        .await
        .expect("B send");
    let data = recv_message(&mut rx_a, &b_id).await;
    assert_eq!(data, b"story: hello from B".to_vec());
    let path = b
        .link_status(&a_id)
        .await
        .map(|s| format!("{s:?}"))
        .unwrap_or_else(|_| "unknown".to_owned());
    story(&format!("S5 通信成功（路径 {path}）"));

    // S6 越权矩阵（raw client 直连断言 deny reason）
    let secret_c = SecretKey::generate();
    let reason = expect_denied(relay_addr, &secret_c, None).await;
    assert_eq!(reason, "dweb/no-capability", "C 无票");
    let reason = expect_denied(relay_addr, &secret_c, Some(b_token.clone())).await;
    assert_eq!(
        reason, "dweb/not-recipient",
        "B 的 member 票给 C 的 endpoint"
    );
    let reason = expect_denied(relay_addr, &secret_c, Some(bootstrap.clone())).await;
    assert_eq!(reason, "dweb/not-recipient", "C 重放 A 给 B 签的票");
    story("S6 越权矩阵完成（no-capability / not-recipient ×2）");

    // S7 v1/v2 兼容
    // (a) 旧形态 Custom 配置的 root 在 restricted server 上签 v1 invite；
    //     无票 joiner 拨号被拒——错误可诊断（deny reason 透出）
    let dir_a1 = TempDir::new().unwrap();
    let dir_j = TempDir::new().unwrap();
    let a1 = Fabric::create_root(legacy_cfg(&dir_a1, &relay_url_s))
        .await
        .expect("旧形态 root（v1 行为基线）");
    let v1_token = a1
        .invite(300_000, None)
        .await
        .expect("v1 invite 签发（relay 非空即过 D3 门）");
    assert!(
        v1_token.starts_with(TOKEN_PREFIX),
        "非 restricted 配置签 v1"
    );
    let j = Fabric::attach(legacy_cfg(&dir_j, &relay_url_s), &a1.fabric_id_hex().await)
        .await
        .expect("旧形态 joiner attach");
    let join_err = j.join(&v1_token).await.expect_err("无票 joiner 必被拒");
    // 诊断面 1（task 2.5）：relay 状态快照记录结构化 deny reason
    let deny = await_deny_in_status(&j, Duration::from_secs(20)).await;
    assert_eq!(deny, "dweb/no-capability");
    // 诊断面 2：join 错误分类为拨号族，且 message 含 deny 附注（可操作信号）
    match &join_err {
        FabricError::Join { code, message } => {
            assert!(
                matches!(
                    code,
                    JoinErrorCode::DialFailed
                        | JoinErrorCode::DialTimeout
                        | JoinErrorCode::RelayOffline
                ),
                "无票 joiner 应归拨号族（got {code}）: {message}"
            );
            assert!(
                message.contains("dweb/no-capability"),
                "join 错误 message 须含 deny reason: {message}"
            );
        }
        other => panic!("非 Join 错误: {other}"),
    }
    story("S7(a) 旧形态 v1 invite 在 restricted server 上可预期失败 + 可诊断");

    // (b) v1-only 客户端（precheck_join_token = 旧 SDK 唯一入口）解析 dweb2.
    //     → unsupported-invite-version（附录 A2 第九码的 SDK 错误码透出）
    let err = precheck_join_token(&token).expect_err("v1-only 路径拒绝 v2 令牌");
    match &err {
        FabricError::Join { code, .. } => {
            assert_eq!(code, &JoinErrorCode::UnsupportedInviteVersion);
            assert_eq!(code.kebab(), "unsupported-invite-version");
        }
        other => panic!("非 Join 错误: {other}"),
    }
    story("S7(b) v1-only 解析 dweb2. → unsupported-invite-version");
    j.shutdown().await.unwrap();
    a1.shutdown().await.unwrap();

    // S8 重启恢复：A/B 进程重建（B 的 relay.caps.json 重载注入；root 重签
    // own cap——own 不持久化是设计语义）→ 再次通信
    b.shutdown().await.unwrap();
    a.shutdown().await.unwrap();
    let a2 = Fabric::open(story_cfg(&dir_a, &relay_url_s, Some(server_id), seed_a))
        .await
        .expect("A 重启 open");
    a2.ensure_relay_capabilities()
        .await
        .expect("root 重签 own cap");
    await_relay_online(&a2).await;
    let b2 = Fabric::open(story_cfg(&dir_b, &relay_url_s, None, seed_b))
        .await
        .expect("B 重启 open");
    assert_eq!(
        b2.relay_map_token(&relay_url_s).as_deref(),
        Some(b_token.as_str()),
        "open() 重载 relay.caps.json 注入同源 member cap"
    );
    assert_eq!(b2.members().await.len(), 2, "重启后成员关系保留");
    await_relay_online(&b2).await;
    let mut rx_a2 = a2.subscribe();
    b2.connect(&a2.endpoint_id())
        .await
        .expect("重启后 B→A connect");
    b2.send(&a2.endpoint_id(), b"story: after restart".to_vec())
        .await
        .expect("重启后 send");
    let data = recv_message(&mut rx_a2, &b_id).await;
    assert_eq!(data, b"story: after restart".to_vec());
    story("S8 重启恢复 + 再次通信完成");

    // 收尾：显式 shutdown（endpoint/任务回收）+ server guard Drop kill+wait
    b2.shutdown().await.unwrap();
    a2.shutdown().await.unwrap();
    drop(server);
    story("S1-S8 全部通过");
}
