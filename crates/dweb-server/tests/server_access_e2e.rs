//! server-access-policy Phase 1 e2e 集成矩阵（task 1.9）。
//!
//! 黑盒形态：dweb-server 是 bin-only crate，integration test 无法 import
//! bin 模块——测试以 `std::process::Command` 启动 Cargo 注入的
//! `CARGO_BIN_EXE_dweb-server` 编译产物，用真 iroh relay + 真 iroh 客户端
//! （dev-dep `iroh` 全量 Endpoint 与 iroh-relay raw `ClientBuilder` 两形态）
//! 验证验证链/callback/限流/持久化的端到端行为。capability 令牌按
//! design §11.1 冻结布局**独立重实现**（不走 cap.rs——黑盒交叉验证
//! 服务端解析器）。
//!
//! 矩阵（每用例断言 deny reason 或连接成功）：
//! - e1 open 回归：无票客户端连 relay 成功并完成双向通信
//! - e2 restricted+static：有效票（RelayMap per-relay token 注入）→
//!   双端 online + 经 relay 消息回程
//! - e3 无票 → dweb/no-capability（deny reason 经握手协议回传）
//! - e4 转借票 → dweb/not-recipient
//! - e5 未注册 owner → dweb/unknown-owner
//! - e6 过期票 → dweb/capability-expired
//! - e7 重启持久化：ServerId 稳定（services.json）+ registry 恢复 + 同票可用
//! - e8 unregister 阻断新连接（mtime 热重载窗口内收敛）
//! - e9 callback 三态：allow（A_cb）/deny(自定义 reason)/失联 fail-closed，
//!   外加「无效票不触发 webhook」
//! - e10 QAD fail-fast：restricted + DWEB_RELAY_QUIC_BIND → 退出码 2 + QAD
//! - e11 空 registry：static fail-closed / callback identity-only
//! - e12 client_rx 限流与 access mode 正交（open + 小限流仍准入）
//! - e13 rendezvous ACL 主接线（gateway 401 JSON 形态）
//! - e14 admin API：空 registry 服务经 POST /admin/owners 注册 → 同票
//!   即时可用（无热重载窗口）+ 回执可用 services.json ServerId 验签 +
//!   401/404 鉴权与未挂载面
//! - e15 per-owner 连接配额：配额满新连接 deny（dweb/owner-quota-exceeded
//!   经握手回传）+ 断连名额恢复 + /admin/status 在线投影
//! - e16 admin unregister 踢存量（task 3.2b）：配额内多连接在线 →
//!   DELETE /admin/owners → kicked 计数 + relay 在线表清零（OnDisconnectGuard
//!   随真断连触发，配额自动释放）+ 同票新连接 unknown-owner（对照：文件
//!   热重载路径不踢存量——e8）
//!
//! 进程纪律：Server guard Drop 恒 kill+wait（防孤儿 dweb-server——全局
//! 规则：测试泄漏常驻进程是重大事故）；网络测试以 --gateway/--relay
//! 端口 0（内核分配）互不冲突，跑侧 --test-threads 2。
//!
//! 令牌时间语义：服务端以真实时钟校验（C6），测试票以 now 为基准签发。

use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ed25519_dalek::{Signer, SigningKey};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayMode, RelayUrl, SecretKey};
use iroh_base::PublicKey;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Cargo 为包内 bin 目标注入的可执行路径（bin-only crate 的 tests/ 同样注入）
const BIN: &str = env!("CARGO_BIN_EXE_dweb-server");

/// CapsV1 位图（design §7.2 冻结；测试侧独立冻结，与 cap.rs 互为交叉验证）
const CAP_RELAY: u8 = 1 << 0;
const CAP_RDZ_ANNOUNCE: u8 = 1 << 1;
const CAP_RDZ_RESOLVE: u8 = 1 << 2;
const CAP_KNOWN_MASK: u8 = CAP_RELAY | CAP_RDZ_ANNOUNCE | CAP_RDZ_RESOLVE;

/// capability 签发（design §11.1 冻结 wire 的测试侧独立实现）：
/// canonical 146B = version(0x01) || fabric 32 || server 32 || issuer 32 ||
/// recipient 32 || caps u8 || issued_at u64BE || expires_at u64BE；
/// 签名输入 = "dweb/relay-cap/v1\0" || canonical；串 = "dwebr1." +
/// base64url-nopad(canonical || sig) = 287 字符。
fn relay_cap_token(
    issuer: &SigningKey,
    fabric_id: &[u8; 32],
    server_id: &[u8; 32],
    recipient: &[u8; 32],
    caps: u8,
    issued_at: u64,
    expires_at: u64,
) -> String {
    use base64::Engine;
    let mut canonical = [0u8; 146];
    canonical[0] = 0x01;
    canonical[1..33].copy_from_slice(fabric_id);
    canonical[33..65].copy_from_slice(server_id);
    canonical[65..97].copy_from_slice(&issuer.verifying_key().to_bytes());
    canonical[97..129].copy_from_slice(recipient);
    canonical[129] = caps;
    canonical[130..138].copy_from_slice(&issued_at.to_be_bytes());
    canonical[138..146].copy_from_slice(&expires_at.to_be_bytes());
    let domain: &[u8] = b"dweb/relay-cap/v1\0";
    let message = [domain, &canonical[..]].concat();
    let sig = issuer.sign(&message);
    let mut wire = [0u8; 210];
    wire[..146].copy_from_slice(&canonical);
    wire[146..].copy_from_slice(&sig.to_bytes());
    format!(
        "dwebr1.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(wire)
    )
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

const TOKEN_TTL_MS: u64 = 3_600_000; // 1h，远小于验证侧 180d 上限

// ---------- dweb-server 子进程管理（guard 恒回收） ----------

struct Server {
    child: Child,
    logs: Arc<Mutex<Vec<String>>>,
    gateway: SocketAddr,
    relay: Option<SocketAddr>,
}

impl Server {
    /// 启动 dweb-server 并等待就绪日志行（gateway 恒等待；relay 按需）。
    /// 端口全 0（内核分配，防用例间竞态）；地址从日志行解析。
    fn spawn(data_dir: &Path, envs: &[(&str, &str)], extra_args: &[&str], relay: bool) -> Server {
        let mut server = Self::spawn_raw(data_dir, envs, extra_args, relay);
        server.wait_ready(relay);
        server
    }

    /// 仅启动不等待就绪（fail-fast 用例：进程预期立刻退出）
    fn spawn_raw(
        data_dir: &Path,
        envs: &[(&str, &str)],
        extra_args: &[&str],
        relay: bool,
    ) -> Server {
        let mut cmd = Command::new(BIN);
        cmd.arg("--gateway").arg("127.0.0.1:0");
        if relay {
            cmd.arg("--relay").arg("127.0.0.1:0");
        } else {
            cmd.arg("--no-relay");
        }
        cmd.args(extra_args)
            .env("DWEB_DATA_DIR", data_dir)
            .envs(envs.iter().map(|(k, v)| (*k, *v)))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().expect("spawn dweb-server");
        let logs = Arc::new(Mutex::new(Vec::new()));
        spawn_log_drain(&mut child, logs.clone());
        Server {
            child,
            logs,
            gateway: "127.0.0.1:0".parse().unwrap(),
            relay: None,
        }
    }

    /// 等待就绪日志行并填充监听地址（gateway 恒等待；relay 按需）
    fn wait_ready(&mut self, relay: bool) {
        let child = &mut self.child;
        let logs = self.logs.clone();
        let deadline = Instant::now() + Duration::from_secs(15);
        let (mut gateway, mut relay_addr) = (None, None);
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                let dump = logs.lock().unwrap().join("\n");
                panic!("dweb-server 提前退出 {status}：\n{dump}");
            }
            let gl = logs.lock().unwrap();
            if gateway.is_none() {
                gateway = gl
                    .iter()
                    .find_map(|l| parse_listening_addr(l, "gateway listening on http://"));
            }
            if relay_addr.is_none() && relay {
                relay_addr = gl
                    .iter()
                    .find_map(|l| parse_listening_addr(l, "iroh relay listening on http://"));
            }
            drop(gl);
            if gateway.is_some() && (!relay || relay_addr.is_some()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.gateway = gateway.unwrap_or_else(|| {
            let dump = logs.lock().unwrap().join("\n");
            panic!("15s 内未见 gateway 就绪日志：\n{dump}")
        });
        if relay {
            self.relay = Some(relay_addr.unwrap_or_else(|| {
                let dump = logs.lock().unwrap().join("\n");
                panic!("15s 内未见 relay 就绪日志：\n{dump}")
            }));
        }
    }

    fn relay_addr(&self) -> SocketAddr {
        self.relay.expect("relay 未启用")
    }

    fn logs_contain(&self, needle: &str) -> bool {
        self.logs.lock().unwrap().iter().any(|l| l.contains(needle))
    }

    fn log_dump(&self) -> String {
        self.logs.lock().unwrap().join("\n")
    }

    /// 等待退出（fail-fast 用例）；超时 kill 后报错
    fn wait_exit(&mut self, timeout: Duration) -> ExitStatus {
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => return status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Ok(None) => panic!("进程未在 {:?} 内退出", timeout),
                Err(e) => panic!("wait 失败: {e}"),
            }
        }
    }
}

impl Drop for Server {
    /// 进程回收纪律：kill + wait（孙进程由 iroh-relay 同进程退出收敛）
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 从日志行解析监听地址（tracing 行尾含 "… listening on http://ADDR"）
fn parse_listening_addr(line: &str, marker: &str) -> Option<SocketAddr> {
    line.split(marker)
        .nth(1)?
        .trim()
        .trim_end_matches('"')
        .parse()
        .ok()
}

/// 后台线程持续收集 stdout/stderr 到统一日志缓冲（tracing 默认写 stdout、
/// fail-fast 的 eprintln 走 stderr——两流都进缓冲；同时防管道写满阻塞）
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

// ---------- 服务面交互辅助 ----------

/// 极简 HTTP/1.1 GET（无第三方客户端依赖；Connection: close 单响应）
async fn http_get(addr: SocketAddr, path: &str) -> (u16, String) {
    let mut stream =
        tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(addr))
            .await
            .expect("tcp connect 超时")
            .expect("tcp connect");
    let req = format!("GET {path} HTTP/1.1\r\nhost: {addr}\r\nconnection: close\r\n\r\n");
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

/// services.json → ServerId 字节（顺带 e2e 验证 task 1.8 发布面）
async fn fetch_server_id(gateway: SocketAddr) -> [u8; 32] {
    let (status, body) = http_get(gateway, "/services.json").await;
    assert_eq!(status, 200, "services.json: {body}");
    let manifest: serde_json::Value = serde_json::from_str(&body).unwrap();
    let hex_id = manifest["server_id"].as_str().unwrap().to_string();
    assert_eq!(hex_id.len(), 64, "server_id 应为 64 hex: {hex_id}");
    hex::decode(&hex_id).unwrap().try_into().unwrap()
}

/// 运行 owners CLI（顺带 e2e 验证 task 1.2 子命令面）
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

/// 测试身份：issuer（registry 内 owner root）+ fabric_id
struct Owner {
    issuer: SigningKey,
    fabric_id: [u8; 32],
}

impl Owner {
    fn new(seed: u8) -> Self {
        Self {
            issuer: SigningKey::from_bytes(&[seed; 32]),
            fabric_id: [0xF1; 32],
        }
    }

    fn register(&self, data_dir: &Path) {
        owners_cli(
            data_dir,
            "register",
            &self.fabric_id,
            &self.issuer.verifying_key().to_bytes(),
        );
    }

    fn unregister(&self, data_dir: &Path) {
        owners_cli(
            data_dir,
            "unregister",
            &self.fabric_id,
            &self.issuer.verifying_key().to_bytes(),
        );
    }

    fn token_for(&self, server_id: &[u8; 32], recipient: &PublicKey, caps: u8) -> String {
        let now = now_ms();
        relay_cap_token(
            &self.issuer,
            &self.fabric_id,
            server_id,
            recipient.as_bytes(),
            caps,
            now,
            now + TOKEN_TTL_MS,
        )
    }
}

// ---------- iroh 客户端（raw 协议断言 + 全量 Endpoint 两形态） ----------

fn relay_url(relay: SocketAddr) -> RelayUrl {
    format!("http://{relay}").parse().expect("relay url")
}

/// raw relay 客户端直连（WS 升级 + 挑战握手）——deny reason 经握手协议
/// 回传的唯一可断言形态（iroh Endpoint 对 deny 会静默重试，不适合断言）
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

/// 断言连接成功（握手 + 认证 + authorize 全链通过）
async fn expect_connected(relay: SocketAddr, secret: &SecretKey, token: Option<String>) {
    tokio::time::timeout(
        Duration::from_secs(10),
        raw_relay_connect(relay, secret, token),
    )
    .await
    .expect("connect 超时（10s）")
    .expect("连接失败（预期放行）");
}

/// 全量 iroh Endpoint（RelayMap per-relay token 注入——iroh-relay 1.1.0
/// `RelayConfig::with_auth_token`，native 以 Authorization: Bearer 头发送，
/// 这是 Phase 2 SDK 侧 RelayConfig::CustomWithCaps 的 API 基础）
async fn iroh_endpoint(relay: SocketAddr, secret: SecretKey, token: Option<String>) -> Endpoint {
    let mut cfg = iroh_relay::RelayConfig::new(relay_url(relay), None);
    if let Some(token) = token {
        cfg = cfg.with_auth_token(token);
    }
    let map = iroh_relay::RelayMap::from_iter([cfg]);
    Endpoint::builder(presets::Minimal)
        .secret_key(secret)
        .alpns(vec![b"dweb-e2e/1".to_vec()])
        .relay_mode(RelayMode::Custom(map))
        .bind()
        .await
        .expect("endpoint bind")
}

/// 等 endpoint 经 relay 上线（relay 连接成功的全量客户端形态断言）
async fn await_online(ep: &Endpoint) {
    tokio::time::timeout(Duration::from_secs(30), ep.online())
        .await
        .expect("endpoint online 超时（30s，relay 连接未建立或被拒）");
}

/// 双端经 relay 的消息回程（dial 只带 NodeId + relay URL——直连地址
/// 未注入，首径必然经 relay；回程后可能升级直连，不属断言面）
async fn relay_echo_roundtrip(server_ep: &Endpoint, client_ep: &Endpoint, relay: SocketAddr) {
    let alpn: &[u8] = b"dweb-e2e/1";
    let accept_side = {
        let ep = server_ep.clone();
        tokio::spawn(async move {
            // 噪声/探测 incoming（非本 ALPN）会以 AlpnError 落地——跳过
            // 而非失败（同 spike-iroh accept_loop 裁定）
            let conn = loop {
                let incoming = ep.accept().await.expect("accept 流");
                let Ok(accepting) = incoming.accept() else {
                    continue;
                };
                if let Ok(conn) = accepting.await {
                    break conn;
                }
            };
            let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");
            let data = recv.read_to_end(64 * 1024).await.expect("读请求");
            send.write_all(&data).await.expect("回写");
            send.finish().expect("finish");
            // 持有连接直到对端读完：任务提前 drop conn 会让 CONNECTION_CLOSE
            // 追上已发送的流数据（实测 ConnectionLost(ApplicationClosed)）
            let _ = conn.closed().await;
        })
    };
    let target = EndpointAddr::new(server_ep.id()).with_relay_url(relay_url(relay));
    let conn = tokio::time::timeout(Duration::from_secs(30), client_ep.connect(target, alpn))
        .await
        .expect("connect 超时（30s）")
        .expect("connect");
    let (mut send, mut recv) = conn.open_bi().await.expect("open_bi");
    send.write_all(b"ping-via-relay").await.expect("write");
    send.finish().expect("finish");
    let echo = recv.read_to_end(64 * 1024).await.expect("读回程");
    assert_eq!(echo, b"ping-via-relay");
    // 客户端先收完回程再关闭连接：accept 任务持有 conn 至 closed（防
    // 任务提前 drop 让 CONNECTION_CLOSE 追上流数据），关闭序由本侧发起
    conn.close(0u32.into(), b"");
    tokio::time::timeout(Duration::from_secs(10), accept_side)
        .await
        .expect("accept 任务超时")
        .expect("accept 任务 panic");
}

// ---------- e1：open 回归 ----------

#[tokio::test]
async fn e1_open_mode_no_token_relay_roundtrip() {
    let dir = TempDir::new().unwrap();
    let server = Server::spawn(dir.path(), &[], &[], true);
    let relay = server.relay_addr();

    let a = SecretKey::generate();
    let b = SecretKey::generate();
    let ep_a = iroh_endpoint(relay, a, None).await;
    let ep_b = iroh_endpoint(relay, b, None).await;
    await_online(&ep_a).await;
    await_online(&ep_b).await;
    relay_echo_roundtrip(&ep_a, &ep_b, relay).await;
}

// ---------- e2：restricted+static 有效票 ----------

#[tokio::test]
async fn e2_restricted_static_valid_capability_roundtrip() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xB1);
    owner.register(dir.path());
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    let a = SecretKey::generate();
    let b = SecretKey::generate();
    let token_a = owner.token_for(&server_id, &a.public(), CAP_KNOWN_MASK);
    let token_b = owner.token_for(&server_id, &b.public(), CAP_KNOWN_MASK);
    let ep_a = iroh_endpoint(relay, a, Some(token_a)).await;
    let ep_b = iroh_endpoint(relay, b, Some(token_b)).await;
    await_online(&ep_a).await;
    await_online(&ep_b).await;
    relay_echo_roundtrip(&ep_a, &ep_b, relay).await;
}

// ---------- e3-e6：deny reason 矩阵（raw 协议断言） ----------

#[tokio::test]
async fn e3_restricted_no_capability_denied() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xB3);
    owner.register(dir.path());
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let secret = SecretKey::generate();
    let reason = expect_denied(server.relay_addr(), &secret, None).await;
    assert_eq!(reason, "dweb/no-capability");
}

#[tokio::test]
async fn e4_restricted_borrowed_token_not_recipient() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xB4);
    owner.register(dir.path());
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let server_id = fetch_server_id(server.gateway).await;
    // A 的 capability，B 的 endpoint 接入（A2 窃取令牌串场景）
    let holder = SecretKey::generate();
    let token = owner.token_for(&server_id, &holder.public(), CAP_RELAY);
    let thief = SecretKey::generate();
    let reason = expect_denied(server.relay_addr(), &thief, Some(token)).await;
    assert_eq!(reason, "dweb/not-recipient");
}

#[tokio::test]
async fn e5_restricted_unknown_owner_denied() {
    let dir = TempDir::new().unwrap();
    // registry 内有别的 owner，本票 issuer 未注册（二元组精确匹配语义）
    let registered = Owner::new(0xB5);
    registered.register(dir.path());
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let server_id = fetch_server_id(server.gateway).await;

    let impostor = Owner::new(0xC5); // 同 fabric、不同 root → 不在活跃集合
    let client = SecretKey::generate();
    let token = impostor.token_for(&server_id, &client.public(), CAP_RELAY);
    let reason = expect_denied(server.relay_addr(), &client, Some(token)).await;
    assert_eq!(reason, "dweb/unknown-owner");
}

#[tokio::test]
async fn e6_restricted_expired_capability_denied() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xB6);
    owner.register(dir.path());
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let server_id = fetch_server_id(server.gateway).await;
    let client = SecretKey::generate();
    let now = now_ms();
    let token = relay_cap_token(
        &owner.issuer,
        &owner.fabric_id,
        &server_id,
        client.public().as_bytes(),
        CAP_RELAY,
        now - 2 * TOKEN_TTL_MS,
        now - TOKEN_TTL_MS,
    );
    let reason = expect_denied(server.relay_addr(), &client, Some(token)).await;
    assert_eq!(reason, "dweb/capability-expired");
}

// ---------- e7：重启持久化 ----------

#[tokio::test]
async fn e7_restart_persistence_same_identity_and_capability() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xB7);
    owner.register(dir.path());
    let envs = [("DWEB_ACCESS_MODE", "restricted")];

    let server = Server::spawn(dir.path(), &envs, &[], true);
    let server_id_first = fetch_server_id(server.gateway).await;
    let client = SecretKey::generate();
    let token = owner.token_for(&server_id_first, &client.public(), CAP_RELAY);
    expect_connected(server.relay_addr(), &client, Some(token.clone())).await;
    let relay_first = server.relay_addr();
    drop(server); // kill + wait（数据写入：server.key 原子写、owners.jsonl append）

    // 重启：同 data_dir → ServerId 稳定 + registry 恢复 + 同票仍可用
    let server = Server::spawn(dir.path(), &envs, &[], true);
    let server_id_second = fetch_server_id(server.gateway).await;
    assert_eq!(
        server_id_first, server_id_second,
        "重启后 ServerId 必须稳定（server.key load-or-create 幂等）"
    );
    assert_ne!(
        server.relay_addr(),
        relay_first,
        "端口 0 重新分配（信息性）"
    );
    expect_connected(server.relay_addr(), &client, Some(token)).await;
    let owners_file = dir.path().join("owners.jsonl");
    let content = std::fs::read_to_string(&owners_file).unwrap();
    assert!(
        content.contains(&hex::encode(owner.issuer.verifying_key().to_bytes())),
        "registry 文件须含注册 root（append-only 持久化）"
    );
}

// ---------- e8：unregister 阻断新连接（热重载） ----------

#[tokio::test]
async fn e8_unregister_blocks_new_connections_after_reload() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xB8);
    owner.register(dir.path());
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let server_id = fetch_server_id(server.gateway).await;
    let client = SecretKey::generate();
    let token = owner.token_for(&server_id, &client.public(), CAP_RELAY);
    expect_connected(server.relay_addr(), &client, Some(token.clone())).await;

    owner.unregister(dir.path());
    // mtime 看护 5s 轮询：热重载窗口内旧快照仍放行——探测式重试直到 deny
    // 翻转（上限 20s）
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let probe = tokio::time::timeout(
            Duration::from_secs(10),
            raw_relay_connect(server.relay_addr(), &client, Some(token.clone())),
        )
        .await
        .expect("probe connect 超时");
        match probe {
            // 尚未重载（旧快照放行）——继续等
            Ok(()) => {}
            Err(iroh_relay::client::ConnectError::Handshake { source, .. }) => {
                match source {
                    iroh_relay::protos::handshake::Error::ServerDeniedAuth { reason, .. }
                        if reason == "dweb/unknown-owner" =>
                    {
                        break; // 热重载生效：unregister 阻断新连接
                    }
                    other => panic!("非预期握手失败: {other:#}"),
                }
            }
            Err(other) => panic!("传输层失败: {other:#}"),
        }
        assert!(
            Instant::now() < deadline,
            "unregister 后 20s 内未见 unknown-owner（热重载未生效）"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

// ---------- e9：callback 三态 + 无效票不触发 webhook ----------

struct WebhookState {
    /// relay.connect 事件计数（断言口径：disconnect 是 best-effort 观察通知，
    /// 不在准入断言面——按事件分类计数防时序抖动）
    connect_count: std::sync::atomic::AtomicUsize,
    /// 响应模式：true → {"allow":true}；false → {"allow":false,"reason":...}
    allow: std::sync::atomic::AtomicBool,
    deny_reason: Mutex<String>,
    last_body: Mutex<serde_json::Value>,
    last_auth: Mutex<String>,
}

async fn spawn_webhook() -> (String, Arc<WebhookState>) {
    let state = Arc::new(WebhookState {
        connect_count: std::sync::atomic::AtomicUsize::new(0),
        allow: std::sync::atomic::AtomicBool::new(true),
        deny_reason: Mutex::new(String::new()),
        last_body: Mutex::new(serde_json::Value::Null),
        last_auth: Mutex::new(String::new()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app_state = state.clone();
    let app = axum::Router::new().route(
        "/hook",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, body: axum::Json<serde_json::Value>| {
                let state = app_state.clone();
                async move {
                    use std::sync::atomic::Ordering;
                    if body.0["event"] == "relay.connect" {
                        state.connect_count.fetch_add(1, Ordering::SeqCst);
                    }
                    *state.last_body.lock().unwrap() = body.0;
                    *state.last_auth.lock().unwrap() = headers
                        .get(axum::http::header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    if state.allow.load(Ordering::SeqCst) {
                        axum::Json(serde_json::json!({"allow": true}))
                    } else {
                        let reason = state.deny_reason.lock().unwrap().clone();
                        axum::Json(serde_json::json!({"allow": false, "reason": reason}))
                    }
                }
            },
        ),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://127.0.0.1:{port}/hook"), state)
}

#[tokio::test]
async fn e9_callback_allow_deny_and_unreachable() {
    use std::sync::atomic::Ordering;
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xB9);
    owner.register(dir.path());
    let (hook_url, hook) = spawn_webhook().await;

    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ACCESS_POLICY", "callback"),
        ("DWEB_CALLBACK_URL", leak_str(&hook_url)),
        ("DWEB_CALLBACK_TOKEN", "t-cb"),
    ];
    let server = Server::spawn(dir.path(), &envs, &["--allow-loopback-callback"], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    // 状态 1：无票端点 webhook allow → 接入成功（A_cb(S) 动态名单边界）
    let ep_a = SecretKey::generate();
    expect_connected(relay, &ep_a, None).await;
    assert_eq!(
        hook.connect_count.load(Ordering::SeqCst),
        1,
        "relay.connect 恰好一次"
    );
    {
        let body = hook.last_body.lock().unwrap();
        assert_eq!(body["event"], "relay.connect");
        assert_eq!(body["endpoint_id"], ep_a.public().to_z32());
        assert!(body["capability"].is_null(), "无票 payload capability=null");
    }
    assert_eq!(
        *hook.last_auth.lock().unwrap(),
        "Bearer t-cb",
        "webhook 请求携带 Bearer callback_token"
    );

    // 无效票到不了 webhook（L1/L1b 不豁免——e2e 侧）：过期票 → 密码学层拒
    let ep_bad = SecretKey::generate();
    let now = now_ms();
    let expired = relay_cap_token(
        &owner.issuer,
        &owner.fabric_id,
        &server_id,
        ep_bad.public().as_bytes(),
        CAP_RELAY,
        now - 2 * TOKEN_TTL_MS,
        now - TOKEN_TTL_MS,
    );
    let reason = expect_denied(relay, &ep_bad, Some(expired)).await;
    assert_eq!(reason, "dweb/capability-expired");
    assert_eq!(
        hook.connect_count.load(Ordering::SeqCst),
        1,
        "无效票据不得触发 webhook（relay.connect 计数不变；disconnect 不计）"
    );

    // 状态 2：webhook deny + 自定义 reason 透传（换 endpoint 避免缓存键命中）
    hook.allow.store(false, Ordering::SeqCst);
    *hook.deny_reason.lock().unwrap() = "dweb/e2e-denied".into();
    let ep_b = SecretKey::generate();
    let reason = expect_denied(relay, &ep_b, None).await;
    assert_eq!(reason, "dweb/e2e-denied");

    // 状态 3：失联 fail-closed——callback_url 指向已关闭端口（独立服务实例；
    // 随机高位端口绑定后立即释放，重分配概率可忽略）
    let dead_port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l);
        p
    };
    let dead_url = leak_str(&format!("http://127.0.0.1:{dead_port}/hook"));
    let envs_dead = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ACCESS_POLICY", "callback"),
        ("DWEB_CALLBACK_URL", dead_url),
        ("DWEB_CALLBACK_TOKEN", "t-cb"),
    ];
    let dead_server = Server::spawn(dir.path(), &envs_dead, &["--allow-loopback-callback"], true);
    let ep_c = SecretKey::generate();
    let reason = expect_denied(dead_server.relay_addr(), &ep_c, None).await;
    assert_eq!(reason, "dweb/policy-unavailable");
}

/// 静态字符串借用（env 元组生命周期辅助）
fn leak_str(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

// ---------- e10：QAD fail-fast ----------

#[tokio::test]
async fn e10_restricted_with_qad_bind_fails_fast() {
    let dir = TempDir::new().unwrap();
    let mut server = Server::spawn_raw(
        dir.path(),
        &[
            ("DWEB_ACCESS_MODE", "restricted"),
            ("DWEB_RELAY_QUIC_BIND", "127.0.0.1:12400"),
        ],
        &[],
        true,
    );
    let status = server.wait_exit(Duration::from_secs(10));
    assert_eq!(status.code(), Some(2), "fail-fast 退出码必须为 2");
    assert!(
        server.logs_contain("QAD"),
        "stderr 须含 QAD 关键词供排障检索：\n{}",
        server.log_dump()
    );
}

// ---------- e11：空 registry 的 static/callback 语义 ----------

#[tokio::test]
async fn e11a_empty_registry_static_fail_closed() {
    let dir = TempDir::new().unwrap();
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let relay = server.relay_addr();
    // 无票 → static 必拒
    let no_ticket = SecretKey::generate();
    let reason = expect_denied(relay, &no_ticket, None).await;
    assert_eq!(reason, "dweb/no-capability");
    // 任何密码学自洽的票 → L1b unknown-owner（fail-closed）
    let server_id = fetch_server_id(server.gateway).await;
    let stranger = Owner::new(0xD1);
    let holder = SecretKey::generate();
    let token = stranger.token_for(&server_id, &holder.public(), CAP_KNOWN_MASK);
    let reason = expect_denied(relay, &holder, Some(token)).await;
    assert_eq!(reason, "dweb/unknown-owner");
}

#[tokio::test]
async fn e11b_empty_registry_callback_identity_only() {
    use std::sync::atomic::Ordering;
    let dir = TempDir::new().unwrap();
    let (hook_url, hook) = spawn_webhook().await;
    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ACCESS_POLICY", "callback"),
        ("DWEB_CALLBACK_URL", leak_str(&hook_url)),
        ("DWEB_CALLBACK_TOKEN", "t-cb"),
    ];
    let server = Server::spawn(dir.path(), &envs, &["--allow-loopback-callback"], true);
    let relay = server.relay_addr();
    // 无票端点：webhook allow → 接入（identity-only 动态名单）
    let ep = SecretKey::generate();
    expect_connected(relay, &ep, None).await;
    assert_eq!(hook.connect_count.load(Ordering::SeqCst), 1);
    // 出示任何票据：L1b 在 webhook 前拒绝（空 registry → unknown-owner）
    let server_id = fetch_server_id(server.gateway).await;
    let stranger = Owner::new(0xD2);
    let holder = SecretKey::generate();
    let token = stranger.token_for(&server_id, &holder.public(), CAP_KNOWN_MASK);
    let reason = expect_denied(relay, &holder, Some(token)).await;
    assert_eq!(reason, "dweb/unknown-owner");
    assert_eq!(
        hook.connect_count.load(Ordering::SeqCst),
        1,
        "空 registry 下的票据接入不产生 webhook 调用"
    );
}

// ---------- e12：client_rx 限流与 access mode 正交 ----------

#[tokio::test]
async fn e12_client_rx_limit_orthogonal_to_access_mode() {
    let dir = TempDir::new().unwrap();
    // open 模式 + 4096 B/s：握手帧（百字节级）可在 1s 预算内完成，
    // 连接准入不受影响——限流节流数据面，不改变准入决策
    let server = Server::spawn(dir.path(), &[("DWEB_RELAY_CLIENT_RX", "4096")], &[], true);
    let secret = SecretKey::generate();
    expect_connected(server.relay_addr(), &secret, None).await;
    assert!(
        server.logs_contain("relay client_rx rate limit: 4096 bytes/s"),
        "限流配置须生效并留日志：\n{}",
        server.log_dump()
    );
}

// ---------- e13：rendezvous ACL 主接线（gateway 401 JSON 形态） ----------

#[tokio::test]
async fn e13_restricted_rendezvous_acl_on_gateway() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xBE);
    owner.register(dir.path());
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let server_id = fetch_server_id(server.gateway).await;

    let announcer = SigningKey::from_bytes(&[0x5E; 32]);
    let announcer_id = announcer.verifying_key().to_bytes();
    let announcer_hex = hex::encode(announcer_id);
    let other = SigningKey::from_bytes(&[0x5F; 32]);
    let other_id = other.verifying_key().to_bytes();
    let other_hex = hex::encode(other_id);

    // 匿名 resolve → 401 + spec 冻结 JSON 体
    let (status, body) = http_get(server.gateway, &format!("/rendezvous/{announcer_hex}")).await;
    assert_eq!(status, 401);
    assert_eq!(body, r#"{"error":"dweb/no-capability"}"#);

    // 身份绑定反例：token recipient = announcer，但 announce 载荷以 other
    // 私钥签名（recipient ≠ 签名 EndpointId）→ not-recipient，不产生登记项
    let announcer_pk = PublicKey::from_bytes(&announcer_id).unwrap();
    let wrong_binding = owner.token_for(&server_id, &announcer_pk, CAP_RDZ_ANNOUNCE);
    let (status, body) = http_post_json(
        server.gateway,
        &format!("/rendezvous/{other_hex}"),
        &announce_request(&other, "127.0.0.1:9000"),
        &[("authorization", &format!("Bearer {wrong_binding}"))],
    )
    .await;
    assert_eq!(status, 401, "recipient ≠ 签名 EndpointId 必须拒绝");
    assert_eq!(body, r#"{"error":"dweb/not-recipient"}"#);

    // 正例链：recipient == 签名者 + RDZ_ANNOUNCE 位 → 204；随后持
    // RDZ_RESOLVE 票（bearer-only，recipient 与解析目标无关）resolve → 200
    let right_binding = relay_cap_token(
        &owner.issuer,
        &owner.fabric_id,
        &server_id,
        &other_id,
        CAP_RDZ_ANNOUNCE,
        now_ms(),
        now_ms() + TOKEN_TTL_MS,
    );
    let (status, resp) = http_post_json(
        server.gateway,
        &format!("/rendezvous/{other_hex}"),
        &announce_request(&other, "127.0.0.1:9100"),
        &[("authorization", &format!("Bearer {right_binding}"))],
    )
    .await;
    assert_eq!(status, 204, "announce 应通过（resp={resp}）");

    let resolver = SecretKey::generate();
    let resolve_token = relay_cap_token(
        &owner.issuer,
        &owner.fabric_id,
        &server_id,
        resolver.public().as_bytes(),
        CAP_RDZ_RESOLVE,
        now_ms(),
        now_ms() + TOKEN_TTL_MS,
    );
    let (status, body) = http_get_with_auth(
        server.gateway,
        &format!("/rendezvous/{other_hex}"),
        &format!("Bearer {resolve_token}"),
    )
    .await;
    assert_eq!(status, 200, "resolve（bearer-only）应通过: {body}");
    let resolved: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(resolved["addrs"][0], "127.0.0.1:9100");
}

/// 构造合法签名的 announce 请求体（canonical 布局独立重实现：
/// "dweb-rendezvous-announce-v1\0" || endpoint_id || ts u64LE ||
/// addr_count u16LE || per-addr(u16LE len || utf8) || ttl u32LE）
fn announce_request(signer: &SigningKey, addr: &str) -> serde_json::Value {
    let id = signer.verifying_key().to_bytes();
    let ts = now_ms();
    let mut buf = b"dweb-rendezvous-announce-v1\0".to_vec();
    buf.extend_from_slice(&id);
    buf.extend_from_slice(&ts.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes());
    buf.extend_from_slice(&(addr.len() as u16).to_le_bytes());
    buf.extend_from_slice(addr.as_bytes());
    buf.extend_from_slice(&60u32.to_le_bytes());
    serde_json::json!({
        "endpoint_id": hex::encode(id),
        "addrs": [addr],
        "ttl_secs": 60,
        "timestamp_ms": ts,
        "signature": base64url(signer.sign(&buf).to_bytes()),
    })
}

// ---------- e14：admin API 注册 → 同票即时可用 ----------

/// admin 回执 canonical（b"dweb/admin-receipt/v1\0" || op u8 || fabric 32 ||
/// root 32 || ts u64BE || generation u64BE——测试侧独立重实现，与 admin.rs
/// 互为交叉验证）
fn admin_receipt_canonical(
    op: u8,
    fabric: &[u8; 32],
    root: &[u8; 32],
    ts: u64,
    generation: u64,
) -> Vec<u8> {
    let mut buf = b"dweb/admin-receipt/v1\0".to_vec();
    buf.push(op);
    buf.extend_from_slice(fabric);
    buf.extend_from_slice(root);
    buf.extend_from_slice(&ts.to_be_bytes());
    buf.extend_from_slice(&generation.to_be_bytes());
    buf
}

#[tokio::test]
async fn e14_admin_api_registers_owner_and_capability_works_immediately() {
    let dir = TempDir::new().unwrap();
    // 空 registry 启动（不预注册——注册只经 admin API，验证即时生效路径）
    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ADMIN_TOKEN", "e2e-admin-token"),
    ];
    let server = Server::spawn(dir.path(), &envs, &[], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    // 鉴权面：错 token → 401；无 token 的其它服务实例 → /admin/* 404
    let (status, body) = http_request(
        server.gateway,
        "/admin/owners",
        "GET",
        None,
        &[("authorization", "Bearer wrong-token")],
    )
    .await;
    assert_eq!(status, 401, "错 admin token 必须 401: {body}");
    {
        let plain_dir = TempDir::new().unwrap();
        let plain = Server::spawn(
            plain_dir.path(),
            &[("DWEB_ACCESS_MODE", "restricted")],
            &[],
            false,
        );
        let (status, _body) = http_request(plain.gateway, "/admin/status", "GET", None, &[]).await;
        assert_eq!(
            status, 404,
            "未配置 DWEB_ADMIN_TOKEN 的实例不挂载 admin 路由"
        );
    }

    // 注册 owner（Bearer 正确 token）→ 200 + 回执
    let owner = Owner::new(0xE1);
    let fabric = owner.fabric_id;
    let root = owner.issuer.verifying_key().to_bytes();
    let (status, body) = http_request(
        server.gateway,
        "/admin/owners",
        "POST",
        Some(
            &serde_json::json!({
                "fabric_id_hex": hex::encode(fabric),
                "root_hex": hex::encode(root),
            })
            .to_string(),
        ),
        &[("authorization", "Bearer e2e-admin-token")],
    )
    .await;
    assert_eq!(status, 200, "admin register: {body}");
    let receipt: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(receipt["op"], "register");
    let ts = receipt["ts"].as_u64().unwrap();
    let generation = receipt["generation"].as_u64().unwrap();
    // 回执验签（services.json 的 ServerId——跨面一致性 + canonical 交叉验证）
    use base64::Engine;
    let sig: [u8; 64] = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(receipt["receipt_sig"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let verifying = ed25519_dalek::VerifyingKey::from_bytes(&server_id).unwrap();
    use ed25519_dalek::Verifier;
    verifying
        .verify(
            &admin_receipt_canonical(0x01, &fabric, &root, ts, generation),
            &ed25519_dalek::Signature::from_bytes(&sig),
        )
        .expect("receipt_sig 必须可验签");

    // 列表与 status 反映注册（同一 registry 实例——无 mtime 热重载窗口）
    let (status, body) = http_request(
        server.gateway,
        "/admin/owners",
        "GET",
        None,
        &[("authorization", "Bearer e2e-admin-token")],
    )
    .await;
    assert_eq!(status, 200);
    let list: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(list["generation"].as_u64().unwrap(), generation);
    assert_eq!(list["owners"][0]["fabric_id"], hex::encode(fabric));
    let (status, body) = http_request(
        server.gateway,
        "/admin/status",
        "GET",
        None,
        &[("authorization", "Bearer e2e-admin-token")],
    )
    .await;
    assert_eq!(status, 200);
    let status_body: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(status_body["mode"], "restricted");
    assert_eq!(status_body["policy"], "static");
    assert_eq!(status_body["generation"].as_u64().unwrap(), generation);

    // 同票即时可用（admin 注册即刻生效于验证链——同进程快照替换）
    let client = SecretKey::generate();
    let token = owner.token_for(&server_id, &client.public(), CAP_RELAY);
    expect_connected(relay, &client, Some(token)).await;
}

// ---------- e15：per-owner 连接配额 ----------

#[tokio::test]
async fn e15_owner_connection_quota_denies_and_restores() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xE2);
    owner.register(dir.path());
    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ADMIN_TOKEN", "e2e-admin-token"),
        ("DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER", "1"),
    ];
    let server = Server::spawn(dir.path(), &envs, &[], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    // 连接 1：全量 endpoint（持有 relay 连接的常驻形态——名额被占用的前提）
    let a = SecretKey::generate();
    let token_a = owner.token_for(&server_id, &a.public(), CAP_RELAY);
    let ep_a = iroh_endpoint(relay, a.clone(), Some(token_a)).await;
    await_online(&ep_a).await;

    // /admin/status：per-owner 在线 1（无热重载依赖，直接断言）
    let (status, body) = http_request(
        server.gateway,
        "/admin/status",
        "GET",
        None,
        &[("authorization", "Bearer e2e-admin-token")],
    )
    .await;
    assert_eq!(status, 200);
    let st: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(st["max_connections_per_owner"], 1);
    assert_eq!(
        st["per_owner_connections"][0]["fabric_id"],
        hex::encode(owner.fabric_id)
    );
    assert_eq!(st["per_owner_connections"][0]["connections"], 1);
    assert_eq!(
        st["active_connections"][0]["endpoint_id"],
        a.public().to_string()
    );

    // 连接 2（同 owner，另一 endpoint 的票）→ 配额超限 deny（握手回传）
    let b = SecretKey::generate();
    let token_b = owner.token_for(&server_id, &b.public(), CAP_RELAY);
    let reason = expect_denied(relay, &b, Some(token_b.clone())).await;
    assert_eq!(reason, "dweb/owner-quota-exceeded");

    // 断开连接 1（drop endpoint → relay 连接关闭 → on_disconnect 释放）→
    // 探测式重试直到名额恢复（上限 15s；含 relay 感知断连的传播时延）
    drop(ep_a);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let probe = tokio::time::timeout(
            Duration::from_secs(10),
            raw_relay_connect(relay, &b, Some(token_b.clone())),
        )
        .await
        .expect("probe connect 超时");
        match probe {
            Ok(()) => break,
            Err(iroh_relay::client::ConnectError::Handshake { source, .. }) => match source {
                iroh_relay::protos::handshake::Error::ServerDeniedAuth { reason, .. }
                    if reason == "dweb/owner-quota-exceeded" => {}
                other => panic!("非预期握手失败: {other:#}"),
            },
            Err(other) => panic!("传输层失败: {other:#}"),
        }
        assert!(
            Instant::now() < deadline,
            "断开后 15s 内名额未恢复（配额泄漏）"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

// ---------- e16：admin unregister 踢存量连接（task 3.2b） ----------

/// e2e 断言要点：
/// 1. kicked 计数真实反映 relay 在线表反查（2 endpoint × 各 1 连接）
/// 2. Clients::disconnect 的 start_shutdown 异步落地——OnDisconnectGuard
///    drop 触发 gate on_disconnect，在线表/配额清零（poll /admin/status）
/// 3. API 注销即时生效：同票新连接与被踢 endpoint 重连均 unknown-owner
///    （无 e8 的 mtime 热重载等待窗口；对照语义：文件路径不踢存量）
#[tokio::test]
async fn e16_admin_unregister_kicks_existing_connections() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xE3);
    owner.register(dir.path());
    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ADMIN_TOKEN", "e2e-admin-token"),
        ("DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER", "4"),
    ];
    let server = Server::spawn(dir.path(), &envs, &[], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    // 配额内多连接在线（两个全量 endpoint，各持 relay 常驻连接）
    let a = SecretKey::generate();
    let token_a = owner.token_for(&server_id, &a.public(), CAP_RELAY);
    let ep_a = iroh_endpoint(relay, a, Some(token_a)).await;
    await_online(&ep_a).await;
    let b = SecretKey::generate();
    let token_b = owner.token_for(&server_id, &b.public(), CAP_RELAY);
    let ep_b = iroh_endpoint(relay, b.clone(), Some(token_b.clone())).await;
    await_online(&ep_b).await;

    // 前置：在线表 = 2 endpoints / 2 connections（同 owner 聚合）
    let auth = ("authorization", "Bearer e2e-admin-token");
    let (status, body) = http_request(server.gateway, "/admin/status", "GET", None, &[auth]).await;
    assert_eq!(status, 200);
    let st: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(st["active_connections"].as_array().unwrap().len(), 2);
    assert_eq!(st["per_owner_connections"][0]["connections"], 2);

    // DELETE owner → kicked 计数 + 回执同构
    let (status, body) = http_request(
        server.gateway,
        &format!(
            "/admin/owners/{}/{}",
            hex::encode(owner.fabric_id),
            hex::encode(owner.issuer.verifying_key().to_bytes())
        ),
        "DELETE",
        None,
        &[auth],
    )
    .await;
    assert_eq!(status, 200, "admin unregister: {body}");
    let receipt: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(receipt["op"], "unregister");
    assert_eq!(
        receipt["kicked_endpoints"], 2,
        "两个 endpoint 均被命中: {body}"
    );
    assert_eq!(receipt["kicked_connections"], 2);

    // 存量连接断开落地：在线表清零（disconnect 异步 start_shutdown →
    // 连接 actor 退出 → OnDisconnectGuard drop → on_disconnect 释放配额；
    // poll 上限 15s——iroh-relay 断连传播时延与 e15 同量级）
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let (status, body) =
            http_request(server.gateway, "/admin/status", "GET", None, &[auth]).await;
        assert_eq!(status, 200);
        let st: serde_json::Value = serde_json::from_str(&body).unwrap();
        if st["active_connections"].as_array().unwrap().is_empty()
            && st["per_owner_connections"].as_array().unwrap().is_empty()
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "DELETE 后 15s 内在线表未清零（踢存量未生效）: {body}"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // 客户端侧持有到断连观察完成后再释放（连接已被服务端终结）
    drop(ep_a);
    drop(ep_b);

    // 同票新连接 deny：API 注销即时生效（无热重载窗口）；被踢 endpoint
    // 的同票重连同样 unknown-owner
    let c = SecretKey::generate();
    let token_c = owner.token_for(&server_id, &c.public(), CAP_RELAY);
    let reason = expect_denied(relay, &c, Some(token_c)).await;
    assert_eq!(reason, "dweb/unknown-owner");
    let reason = expect_denied(relay, &b, Some(token_b)).await;
    assert_eq!(reason, "dweb/unknown-owner");
}

fn base64url(bytes: [u8; 64]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 极简 HTTP/1.1 POST JSON
async fn http_post_json(
    addr: SocketAddr,
    path: &str,
    body: &serde_json::Value,
    headers: &[(&str, &str)],
) -> (u16, String) {
    http_request(addr, path, "POST", Some(&body.to_string()), headers).await
}

async fn http_get_with_auth(addr: SocketAddr, path: &str, auth: &str) -> (u16, String) {
    http_request(addr, path, "GET", None, &[("authorization", auth)]).await
}

async fn http_request(
    addr: SocketAddr,
    path: &str,
    method: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> (u16, String) {
    let mut stream =
        tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect(addr))
            .await
            .expect("tcp connect 超时")
            .expect("tcp connect");
    let body_bytes = body.map(|b| b.as_bytes().to_vec()).unwrap_or_default();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nhost: {addr}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\n",
        body_bytes.len()
    );
    for (name, value) in headers {
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    if !body_bytes.is_empty() {
        stream.write_all(&body_bytes).await.unwrap();
    }
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    let resp_body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    (status, resp_body)
}
