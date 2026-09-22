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
//! - e17 admin connections 视图 + 按 endpoint 断连（sdk-mgmt-surface
//!   task 1.7）：两 owner 各一连接 → GET /admin/connections 投影（字典序/
//!   quota/mode/relay_enabled）→ POST disconnect{endpoint_id} → per-target
//!   回执（ServerId 验签）→ 有界轮询（≤5s/50ms）观测收敛
//! - e18 admin 按 fabric 断连多端点：同 fabric 两 endpoint → disconnect
//!   {fabric_id} → disconnected/receipts 按 endpoint_id 字典序展开 + 两回执
//!   共享 ts/generation → 收敛后同票可重连（disconnect ≠ unregister）
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

// ---------- e1：open 回归（含 O-9 门禁台账不生效负向） ----------

#[tokio::test]
async fn e1_open_mode_no_token_relay_roundtrip() {
    let dir = TempDir::new().unwrap();
    let a = SecretKey::generate();
    let b = SecretKey::generate();
    // server-access-roles Phase 1a（O-9 冻结）：open 不装 gate——门禁台账
    // 文件在场（endpoint a 已拉黑 / b 非访客）也完全不生效、启动不读不炸
    std::fs::write(
        dir.path().join("blocklist.jsonl"),
        format!(
            "{{\"op\":\"add\",\"kind\":\"endpoint\",\"id\":\"{}\",\"reason\":\"e2e-open-negative\",\"ts\":1}}\n",
            a.public()
        ),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("visitors.jsonl"),
        format!(
            "{{\"op\":\"grant\",\"endpoint_id\":\"{}\",\"alias\":\"unused\",\"ts\":1}}\n",
            a.public()
        ),
    )
    .unwrap();
    let server = Server::spawn(dir.path(), &[], &[], true);
    let relay = server.relay_addr();

    let ep_a = iroh_endpoint(relay, a, None).await;
    let ep_b = iroh_endpoint(relay, b, None).await;
    await_online(&ep_a).await;
    await_online(&ep_b).await;
    // a 名义上被拉黑、b 无票非访客——open 模式（AllowAll）全部照常通行
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

// ---------- e17/e18：admin connections 视图 + 主动断连 ----------
// （sdk-mgmt-surface task 1.7；raw Client 形态而非全量 iroh Endpoint——
// 全量 Endpoint 对 relay 断开会自动重连，会与「在线计数收敛消失」的
// 有界轮询观测互相竞态；raw Client 持有即常驻、断开即消亡，收敛确定性）

/// raw relay 客户端持久连接（持有 = 在线；drop = 关闭，无重试逻辑）
async fn raw_relay_client(
    relay: SocketAddr,
    secret: &SecretKey,
    token: Option<String>,
) -> iroh_relay::client::Client {
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
    tokio::time::timeout(Duration::from_secs(10), builder.connect())
        .await
        .expect("connect 超时（10s）")
        .expect("raw relay client 连接失败（预期放行）")
}

/// GET /admin/connections（admin token 恒注入）
async fn admin_connections(gateway: SocketAddr) -> serde_json::Value {
    let (status, body) =
        http_get_with_auth(gateway, "/admin/connections", "Bearer e2e-admin-token").await;
    assert_eq!(status, 200, "GET /admin/connections: {body}");
    serde_json::from_str(&body).unwrap()
}

/// 有界轮询（≤5s、50ms 间隔；spec 场景「主动断连的最终收敛」冻结口径）：
/// 直到 `pred` 对 connections 投影为真；超时 panic 带最后一次投影
async fn poll_connections_until(
    gateway: SocketAddr,
    pred: impl Fn(&serde_json::Value) -> bool,
    what: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut last = serde_json::Value::Null;
    while Instant::now() < deadline {
        last = admin_connections(gateway).await;
        if pred(&last) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("5s 内未见收敛（{what}）：{last}");
}

/// disconnect 回执验签（canonical 测试侧独立重实现：op3 的 target 槽位 =
/// 被断 endpoint_id；与 admin.rs 互为交叉验证）
fn verify_disconnect_receipt(
    receipt: &serde_json::Value,
    server_id: &[u8; 32],
    fabric: &[u8; 32],
    endpoint: &[u8; 32],
) {
    use base64::Engine;
    use ed25519_dalek::Verifier;
    assert_eq!(receipt["op"], "disconnect");
    assert_eq!(receipt["fabric_id"], hex::encode(fabric));
    assert_eq!(receipt["endpoint_id"], hex::encode(endpoint));
    let ts = receipt["ts"].as_u64().unwrap();
    let generation = receipt["generation"].as_u64().unwrap();
    let sig: [u8; 64] = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(receipt["receipt_sig"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let verifying = ed25519_dalek::VerifyingKey::from_bytes(server_id).unwrap();
    verifying
        .verify(
            &admin_receipt_canonical(0x03, fabric, endpoint, ts, generation),
            &ed25519_dalek::Signature::from_bytes(&sig),
        )
        .expect("disconnect 回执必须可 ServerId 验签");
}

/// e2e 断言要点（spec 场景「在线视图投影与配额」+「主动断连的最终收敛」）：
/// 1. 两 owner 各一条在线连接 → per_endpoint 字典序 / per_owner / quota
///    结构 / mode 与 relay_enabled 独立如实
/// 2. disconnect{endpoint_id} → disconnected 恰一条 + per-target 回执验签
/// 3. 有界轮询（≤5s/50ms）观测该 endpoint 计数消失，另一 owner 不受影响
#[tokio::test]
async fn e17_admin_connections_view_and_disconnect_by_endpoint() {
    let dir = TempDir::new().unwrap();
    // 两个 owner（独立 fabric——Owner::new 的 fabric 恒 0xF1，这里直接用
    // owners_cli 注册自定义二元组）
    let fabric1 = [0xF1; 32];
    let fabric2 = [0xF2; 32];
    let issuer1 = SigningKey::from_bytes(&[0x71; 32]);
    let issuer2 = SigningKey::from_bytes(&[0x72; 32]);
    owners_cli(
        dir.path(),
        "register",
        &fabric1,
        &issuer1.verifying_key().to_bytes(),
    );
    owners_cli(
        dir.path(),
        "register",
        &fabric2,
        &issuer2.verifying_key().to_bytes(),
    );
    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ADMIN_TOKEN", "e2e-admin-token"),
        ("DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER", "8"),
    ];
    let server = Server::spawn(dir.path(), &envs, &[], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    // 两 owner 各一条持久在线连接
    let a = SecretKey::generate();
    let token_a = relay_cap_token(
        &issuer1,
        &fabric1,
        &server_id,
        a.public().as_bytes(),
        CAP_RELAY,
        now_ms(),
        now_ms() + TOKEN_TTL_MS,
    );
    let client_a = raw_relay_client(relay, &a, Some(token_a)).await;
    let b = SecretKey::generate();
    let token_b = relay_cap_token(
        &issuer2,
        &fabric2,
        &server_id,
        b.public().as_bytes(),
        CAP_RELAY,
        now_ms(),
        now_ms() + TOKEN_TTL_MS,
    );
    // 票可复用（bearer 多次使用）；重连断言（disconnect ≠ unregister）留待后用
    let client_b = raw_relay_client(relay, &b, Some(token_b.clone())).await;

    // 视图前置：两 endpoint 都上线（有界等待——握手完成到在线表可见）
    poll_connections_until(
        server.gateway,
        |c| c["per_endpoint"].as_array().map(|a| a.len()) == Some(2),
        "两 owner 上线",
    )
    .await;
    let view = admin_connections(server.gateway).await;
    assert_eq!(view["mode"], "restricted");
    assert_eq!(view["policy"], "static");
    assert_eq!(view["relay_enabled"], true);
    assert_eq!(view["quota"]["configured"], true);
    assert_eq!(view["quota"]["max_connections_per_owner"], 8);
    let endpoints: Vec<String> = view["per_endpoint"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["endpoint_id"].as_str().unwrap().to_string())
        .collect();
    let mut expected = vec![a.public().to_string(), b.public().to_string()];
    expected.sort();
    assert_eq!(endpoints, expected, "per_endpoint 按 endpoint_id 字典序");
    let owners: Vec<String> = view["per_owner"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["fabric_id"].as_str().unwrap().to_string())
        .collect();
    let mut fabrics = vec![hex::encode(fabric1), hex::encode(fabric2)];
    fabrics.sort();
    assert_eq!(owners, fabrics);
    assert_eq!(view["per_owner"][0]["connections"], 1);

    // disconnect 按 endpoint（b 的 endpoint）：恰一条 + 回执验签
    let b_hex = b.public().to_string();
    let (status, body) = http_post_json(
        server.gateway,
        "/admin/connections/disconnect",
        &serde_json::json!({ "endpoint_id": b_hex }),
        &[("authorization", "Bearer e2e-admin-token")],
    )
    .await;
    assert_eq!(status, 200, "disconnect by endpoint: {body}");
    let resp: serde_json::Value = serde_json::from_str(&body).unwrap();
    let disconnected = resp["disconnected"].as_array().unwrap();
    assert_eq!(disconnected.len(), 1);
    assert_eq!(disconnected[0]["endpoint_id"], b_hex);
    assert_eq!(disconnected[0]["fabric_id"], hex::encode(fabric2));
    assert_eq!(disconnected[0]["connections"], 1);
    let receipts = resp["receipts"].as_array().unwrap();
    assert_eq!(receipts.len(), 1, "per-target 恰一张回执");
    verify_disconnect_receipt(&receipts[0], &server_id, &fabric2, b.public().as_bytes());

    // 有界轮询（≤5s/50ms）：b 消失、a 存活（disconnect 不伤及其它 owner）
    poll_connections_until(
        server.gateway,
        |c| {
            c["per_endpoint"].as_array().map(|a| a.len()) == Some(1)
                && c["per_endpoint"][0]["endpoint_id"] == a.public().to_string()
        },
        "断连 b 后仅剩 a",
    )
    .await;
    // b 的连接确实被服务端终结：同票重连放行（disconnect ≠ unregister，
    // registry 未动）；探测连接随 map(|_| ()) 即弃，由 guard 统一收尾
    expect_connected(relay, &b, Some(token_b)).await;
    drop(client_a);
    drop(client_b);
}

/// e2e 断言要点（spec 场景「按 fabric 断连多端点的确定性展开」）：
/// 1. 同 fabric 两 endpoint → disconnect{fabric_id} → disconnected 与
///    receipts 均按 endpoint_id 字典序展开
/// 2. 两张回执共享 ts 与 generation（单一动作时刻与 registry 世代）、
///    fabric_id 取自快照条目
/// 3. 有界轮询观测在线表清零；同票重连放行（disconnect ≠ unregister）
#[tokio::test]
async fn e18_admin_disconnect_by_fabric_expands_two_endpoints() {
    let dir = TempDir::new().unwrap();
    let fabric = [0xF3; 32];
    let issuer = SigningKey::from_bytes(&[0x73; 32]);
    owners_cli(
        dir.path(),
        "register",
        &fabric,
        &issuer.verifying_key().to_bytes(),
    );
    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ADMIN_TOKEN", "e2e-admin-token"),
        ("DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER", "8"),
    ];
    let server = Server::spawn(dir.path(), &envs, &[], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    let a = SecretKey::generate();
    let b = SecretKey::generate();
    let token_for = |secret: &SecretKey| {
        let now = now_ms();
        relay_cap_token(
            &issuer,
            &fabric,
            &server_id,
            secret.public().as_bytes(),
            CAP_RELAY,
            now,
            now + TOKEN_TTL_MS,
        )
    };
    let client_a = raw_relay_client(relay, &a, Some(token_for(&a))).await;
    let client_b = raw_relay_client(relay, &b, Some(token_for(&b))).await;
    poll_connections_until(
        server.gateway,
        |c| {
            c["per_endpoint"].as_array().map(|x| x.len()) == Some(2)
                && c["per_owner"][0]["connections"] == 2_u64
        },
        "同 fabric 两 endpoint 上线",
    )
    .await;

    // disconnect 按 fabric：字典序展开 + 共享 ts/generation + 逐张验签
    let (status, body) = http_post_json(
        server.gateway,
        "/admin/connections/disconnect",
        &serde_json::json!({ "fabric_id": hex::encode(fabric) }),
        &[("authorization", "Bearer e2e-admin-token")],
    )
    .await;
    assert_eq!(status, 200, "disconnect by fabric: {body}");
    let resp: serde_json::Value = serde_json::from_str(&body).unwrap();
    let disconnected = resp["disconnected"].as_array().unwrap();
    let receipts = resp["receipts"].as_array().unwrap();
    assert_eq!(disconnected.len(), 2);
    assert_eq!(receipts.len(), 2, "per-target 回执：每端点一张");
    let mut expected = vec![a.public().to_string(), b.public().to_string()];
    expected.sort();
    let got: Vec<&str> = disconnected
        .iter()
        .map(|e| e["endpoint_id"].as_str().unwrap())
        .collect();
    assert_eq!(got, expected, "disconnected 按 endpoint_id 字典序展开");
    let receipt_eps: Vec<&str> = receipts
        .iter()
        .map(|r| r["endpoint_id"].as_str().unwrap())
        .collect();
    assert_eq!(receipt_eps, got, "receipts 与 disconnected 对齐展开");
    assert_eq!(
        receipts[0]["ts"].as_u64().unwrap(),
        receipts[1]["ts"].as_u64().unwrap(),
        "两回执共享 ts（单一动作时刻）"
    );
    assert_eq!(
        receipts[0]["generation"].as_u64().unwrap(),
        receipts[1]["generation"].as_u64().unwrap(),
        "两回执共享 generation（同一 registry 世代）"
    );
    // endpoint_id hex 即公钥字节（32B）——直接取回供逐张验签
    let pk_of = |hex_id: &str| -> [u8; 32] { hex::decode(hex_id).unwrap().try_into().unwrap() };
    verify_disconnect_receipt(&receipts[0], &server_id, &fabric, &pk_of(got[0]));
    verify_disconnect_receipt(&receipts[1], &server_id, &fabric, &pk_of(got[1]));

    // 有界轮询：该 fabric 在线表清零
    poll_connections_until(
        server.gateway,
        |c| {
            c["per_endpoint"].as_array().unwrap().is_empty()
                && c["per_owner"].as_array().unwrap().is_empty()
        },
        "fabric 全断后在线表清零",
    )
    .await;
    // 同票重连放行（owner 未注销，仅断连）
    expect_connected(relay, &a, Some(token_for(&a))).await;
    drop(client_a);
    drop(client_b);
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

/// e2e e19（r4-P0-1 回归）：同一 endpoint 持两个 fabric 的连接——
/// 1. connections 视图 per_endpoint 两条 pair（同 endpoint_id、fabric 字典序）
/// 2. status 的 active_connections 聚合为一条（connections 求和、fabric 取最小）
/// 3. disconnect by endpoint：物理断连只一次、两张 pair 全保留、两张回执
///    共享 ts/generation 且逐张验签
/// 4. 有界轮询收敛：两 fabric 的 per_owner 计数双双归零
#[tokio::test]
async fn e19_admin_disconnect_mixed_fabric_same_endpoint() {
    let dir = TempDir::new().unwrap();
    let fabric1 = [0xF4; 32];
    let fabric2 = [0xF5; 32];
    let issuer1 = SigningKey::from_bytes(&[0x74; 32]);
    let issuer2 = SigningKey::from_bytes(&[0x75; 32]);
    for (fabric, issuer) in [(fabric1, &issuer1), (fabric2, &issuer2)] {
        owners_cli(
            dir.path(),
            "register",
            &fabric,
            &issuer.verifying_key().to_bytes(),
        );
    }
    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ADMIN_TOKEN", "e2e-admin-token"),
        ("DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER", "8"),
    ];
    let server = Server::spawn(dir.path(), &envs, &[], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    // 同一 endpoint 身份、两张不同 fabric 的票（recipient 相同）
    let e = SecretKey::generate();
    let now = now_ms();
    let token1 = relay_cap_token(
        &issuer1,
        &fabric1,
        &server_id,
        e.public().as_bytes(),
        CAP_RELAY,
        now,
        now + TOKEN_TTL_MS,
    );
    let token2 = relay_cap_token(
        &issuer2,
        &fabric2,
        &server_id,
        e.public().as_bytes(),
        CAP_RELAY,
        now,
        now + TOKEN_TTL_MS,
    );
    let _c1 = raw_relay_client(relay, &e, Some(token1)).await;
    let _c2 = raw_relay_client(relay, &e, Some(token2)).await;
    poll_connections_until(
        server.gateway,
        |c| {
            let eps = c["per_endpoint"].as_array();
            eps.is_some_and(|x| x.len() == 2)
                && x_all_same_endpoint(eps.unwrap())
                && c["per_owner"].as_array().map(|a| a.len()) == Some(2)
        },
        "同 endpoint 双 fabric 上线（两条 pair）",
    )
    .await;

    // 视图分工：connections per-pair vs status endpoint 级聚合
    let view = admin_connections(server.gateway).await;
    let pairs = view["per_endpoint"].as_array().unwrap();
    assert_eq!(pairs.len(), 2, "per-pair 两条");
    let endpoint_hex = e.public().to_string();
    assert!(pairs.iter().all(|p| p["endpoint_id"] == endpoint_hex));
    let fabrics: Vec<&str> = pairs
        .iter()
        .map(|p| p["fabric_id"].as_str().unwrap())
        .collect();
    let mut sorted = fabrics.clone();
    sorted.sort();
    assert_eq!(fabrics, sorted, "同 endpoint 内按 fabric 字典序");
    let (status_code, body) =
        http_get_with_auth(server.gateway, "/admin/status", "Bearer e2e-admin-token").await;
    assert_eq!(status_code, 200);
    let st: serde_json::Value = serde_json::from_str(&body).unwrap();
    let active = st["active_connections"].as_array().unwrap();
    let mine: Vec<&serde_json::Value> = active
        .iter()
        .filter(|a| a["endpoint_id"] == endpoint_hex)
        .collect();
    assert_eq!(mine.len(), 1, "status 聚合为一条（r4-P1-1）");
    assert_eq!(mine[0]["connections"], 2_u64, "connections 求和");
    assert_eq!(
        mine[0]["fabric_id"], sorted[0],
        "聚合条目 fabric 取字典序最小"
    );

    // disconnect by endpoint：一次物理动作、两 pair 两回执共享 ts/generation
    let (status_code, body) = http_post_json(
        server.gateway,
        "/admin/connections/disconnect",
        &serde_json::json!({ "endpoint_id": endpoint_hex }),
        &[("authorization", "Bearer e2e-admin-token")],
    )
    .await;
    assert_eq!(status_code, 200, "disconnect by endpoint: {body}");
    let resp: serde_json::Value = serde_json::from_str(&body).unwrap();
    let disconnected = resp["disconnected"].as_array().unwrap();
    let receipts = resp["receipts"].as_array().unwrap();
    assert_eq!(disconnected.len(), 2, "两张 pair 全保留（r4-P0-1）");
    assert_eq!(receipts.len(), 2, "每 pair 一张回执");
    // r5-P2-1：disconnected 的 wire 字段与顺序逐项钉住（同 endpoint 按
    // fabric 字典序，connections 各 1）
    let mut expected: Vec<serde_json::Value> = [fabric1, fabric2]
        .iter()
        .map(|f| {
            serde_json::json!({
                "endpoint_id": endpoint_hex,
                "fabric_id": hex::encode(f),
                "connections": 1,
            })
        })
        .collect();
    expected.sort_by_key(|j| j["fabric_id"].as_str().unwrap().to_owned());
    assert_eq!(*disconnected, expected, "disconnected wire 与顺序逐项一致");
    let ts_set: Vec<u64> = receipts.iter().map(|r| r["ts"].as_u64().unwrap()).collect();
    let gen_set: Vec<u64> = receipts
        .iter()
        .map(|r| r["generation"].as_u64().unwrap())
        .collect();
    assert!(ts_set.windows(2).all(|w| w[0] == w[1]), "ts 全回执共享");
    assert!(
        gen_set.windows(2).all(|w| w[0] == w[1]),
        "generation 全回执共享"
    );
    for (r, fabric) in receipts.iter().zip([fabric1, fabric2]) {
        verify_disconnect_receipt(r, &server_id, &fabric, e.public().as_bytes());
    }

    // 收敛：per_endpoint 与 per_owner 双双清零（r5-P2-1：两 fabric 计数
    // 均归零，不只看 endpoint 维度）
    poll_connections_until(
        server.gateway,
        |c| {
            c["per_endpoint"].as_array().map(|a| a.len()) == Some(0)
                && c["per_owner"].as_array().map(|a| a.len()) == Some(0)
        },
        "混合 fabric 断连后 per_endpoint 与 per_owner 双清零",
    )
    .await;
}

/// per_endpoint 数组内全部条目同 endpoint_id（e19 辅助）
fn x_all_same_endpoint(arr: &[serde_json::Value]) -> bool {
    let first = arr.first().and_then(|v| v["endpoint_id"].as_str());
    first.is_some_and(|f| arr.iter().all(|v| v["endpoint_id"].as_str() == Some(f)))
}

// ---------- e20-e22：server-access-roles Phase 1a（访客名册/黑名单/租户到期） ----------

/// e20：访客名册准入 + 两级配额 + 投影（spec「访客裁决次序」「访客连接配额
/// 独立于租户配额」）。文件入口授予（文件/admin 两入口收敛的文件侧），
/// per-endpoint 配额 2：同端点第 3 条拒；非访客无票拒 no-capability；
/// /admin/status 增量字段 visitors_online 与 /admin/connections 的
/// per_visitor 数组如实投影；断连释放后名额恢复。
#[tokio::test]
async fn e20_visitor_registry_admission_quota_and_projection() {
    let dir = TempDir::new().unwrap();
    let visitor = SecretKey::generate();
    // 文件入口授予（永久、带 alias）
    std::fs::write(
        dir.path().join("visitors.jsonl"),
        format!(
            "{{\"op\":\"grant\",\"endpoint_id\":\"{}\",\"alias\":\"e2e-guest\",\"ts\":1}}\n",
            visitor.public()
        ),
    )
    .unwrap();
    let envs = [
        ("DWEB_ACCESS_MODE", "restricted"),
        ("DWEB_ADMIN_TOKEN", "e2e-admin-token"),
        ("DWEB_RELAY_MAX_CONNECTIONS_PER_VISITOR", "2"),
    ];
    let server = Server::spawn(dir.path(), &envs, &[], true);
    let relay = server.relay_addr();

    // 无票访客准入（R1 敲门即连）：同端点两条常驻连接（两个 Endpoint 实例
    // 共享同一身份 key）
    let ep1 = iroh_endpoint(relay, visitor.clone(), None).await;
    await_online(&ep1).await;
    let ep2 = iroh_endpoint(relay, visitor.clone(), None).await;
    await_online(&ep2).await;

    // 第 3 条（同端点）→ per-endpoint 配额拒
    let reason = expect_denied(relay, &visitor, None).await;
    assert_eq!(reason, "dweb/visitor-quota-exceeded");

    // 非访客无票 → no-capability（回落原路径）
    let outsider = SecretKey::generate();
    let reason = expect_denied(relay, &outsider, None).await;
    assert_eq!(reason, "dweb/no-capability");

    // 投影：status visitors_online=2；connections per_visitor=[{visitor,2}]；
    // 既有字段（per_endpoint/per_owner）不含访客
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
    assert_eq!(st["visitors_online"], 2, "status 增量字段：访客在线数");
    assert_eq!(st["active_connections"].as_array().unwrap().len(), 0);
    let (status, body) = http_request(
        server.gateway,
        "/admin/connections",
        "GET",
        None,
        &[("authorization", "Bearer e2e-admin-token")],
    )
    .await;
    assert_eq!(status, 200);
    let conns: serde_json::Value = serde_json::from_str(&body).unwrap();
    let per_visitor = conns["per_visitor"].as_array().unwrap();
    assert_eq!(per_visitor.len(), 1);
    assert_eq!(per_visitor[0]["endpoint_id"], visitor.public().to_string());
    assert_eq!(per_visitor[0]["connections"], 2);
    assert_eq!(conns["per_endpoint"].as_array().unwrap().len(), 0);
    assert_eq!(conns["per_owner"].as_array().unwrap().len(), 0);

    // 断开两条常驻 → 名额恢复（poll 探测式重试，上限 15s）
    drop(ep1);
    drop(ep2);
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let probe = tokio::time::timeout(
            Duration::from_secs(10),
            raw_relay_connect(relay, &visitor, None),
        )
        .await
        .expect("probe connect 超时");
        match probe {
            Ok(()) => break,
            Err(iroh_relay::client::ConnectError::Handshake { source, .. }) => match source {
                iroh_relay::protos::handshake::Error::ServerDeniedAuth { reason, .. }
                    if reason == "dweb/visitor-quota-exceeded" => {}
                other => panic!("非预期握手失败: {other:#}"),
            },
            Err(other) => panic!("传输层失败: {other:#}"),
        }
        assert!(
            Instant::now() < deadline,
            "断开后 15s 内访客名额未恢复（配额泄漏）"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// e21：黑名单双维（spec「黑名单 endpoint 维度先于凭证分类」「黑名单 fabric
/// 维度拒整个租户」）。endpoint 维度：被拉黑端点持**有效票**仍拒；fabric
/// 维度经文件追加 + mtime 热重载生效：同 fabric 任何端点的有效票拒。
#[tokio::test]
async fn e21_blocklist_endpoint_and_fabric_dimensions() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xC3);
    owner.register(dir.path());
    let blocked_client = SecretKey::generate();
    let other_client = SecretKey::generate();
    // 文件入口：endpoint 维度拉黑 blocked_client（有票无票同样生效）
    std::fs::write(
        dir.path().join("blocklist.jsonl"),
        format!(
            "{{\"op\":\"add\",\"kind\":\"endpoint\",\"id\":\"{}\",\"reason\":\"e2e-abuse\",\"ts\":1}}\n",
            blocked_client.public()
        ),
    )
    .unwrap();
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let relay = server.relay_addr();
    let server_id = fetch_server_id(server.gateway).await;

    // 被拉黑端点持有效票 → dweb/blocked（有效票不豁免，先于 C0）
    let token_blocked = owner.token_for(&server_id, &blocked_client.public(), CAP_RELAY);
    let reason = expect_denied(relay, &blocked_client, Some(token_blocked)).await;
    assert_eq!(reason, "dweb/blocked");

    // 未拉黑端点同票 → 放行
    let token_other = owner.token_for(&server_id, &other_client.public(), CAP_RELAY);
    expect_connected(relay, &other_client, Some(token_other.clone())).await;

    // 文件入口追加 fabric 维度（owner.fabric_id）→ mtime 热重载（5s 看护）
    // 后同 fabric 任何端点的有效票拒
    std::fs::write(
        dir.path().join("blocklist.jsonl"),
        format!(
            "{{\"op\":\"add\",\"kind\":\"endpoint\",\"id\":\"{}\",\"reason\":\"e2e-abuse\",\"ts\":1}}\n{{\"op\":\"add\",\"kind\":\"fabric\",\"id\":\"{}\",\"reason\":\"bad tenant\",\"ts\":2}}\n",
            blocked_client.public(),
            hex::encode(owner.fabric_id)
        ),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let probe = tokio::time::timeout(
            Duration::from_secs(10),
            raw_relay_connect(relay, &other_client, Some(token_other.clone())),
        )
        .await
        .expect("probe connect 超时");
        match probe {
            Ok(()) => {} // 尚未重载——继续等
            Err(iroh_relay::client::ConnectError::Handshake { source, .. }) => match source {
                iroh_relay::protos::handshake::Error::ServerDeniedAuth { reason, .. }
                    if reason == "dweb/blocked" =>
                {
                    break; // fabric 维度热重载生效
                }
                other => panic!("非预期握手失败: {other:#}"),
            },
            Err(other) => panic!("传输层失败: {other:#}"),
        }
        assert!(
            Instant::now() < deadline,
            "fabric 拉黑后 20s 内未见 blocked（热重载未生效）"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// e22：租户到期（spec「租户条目过期拒绝且 reason 与未注册区分」）：文件
/// 入口的带 expires_at（已过）register → 有效票拒 `dweb/owner-expired`；
/// 未注册 fabric 的票仍拒 `dweb/unknown-owner`（两 reason 区分面）
#[tokio::test]
async fn e22_owner_expired_denied_with_distinct_reason() {
    let dir = TempDir::new().unwrap();
    let owner = Owner::new(0xC4);
    let client = SecretKey::generate();
    // 文件入口：register 携带已过期的 expires_at（跳过 CLI——CLI 无到期参数）
    std::fs::write(
        dir.path().join("owners.jsonl"),
        format!(
            "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":{}}}\n",
            hex::encode(owner.fabric_id),
            hex::encode(owner.issuer.verifying_key().to_bytes()),
            now_ms() - 1_000
        ),
    )
    .unwrap();
    let server = Server::spawn(dir.path(), &[("DWEB_ACCESS_MODE", "restricted")], &[], true);
    let server_id = fetch_server_id(server.gateway).await;

    // 到期租户的有效票 → owner-expired（在册但过期，非 unknown）
    let token = owner.token_for(&server_id, &client.public(), CAP_RELAY);
    let reason = expect_denied(server.relay_addr(), &client, Some(token)).await;
    assert_eq!(reason, "dweb/owner-expired");

    // 未注册 fabric 的票 → unknown-owner（区分面）
    let impostor = Owner::new(0xC5);
    let token2 = impostor.token_for(&server_id, &client.public(), CAP_RELAY);
    let reason = expect_denied(server.relay_addr(), &client, Some(token2)).await;
    assert_eq!(reason, "dweb/unknown-owner");
}

// ---------- server-access-roles Phase 1b：邀请码与公开注册面 ----------
//
// 黑盒交叉验证：canonical/哈希/回执全部测试侧独立重实现（与服务端实现
// 互不依赖——wire 冻结的对拍锚）。码签发经 codes.jsonl 文件入口（admin
// 签发路由是 Phase 1c；文件入口是 spec 冻结的第二入口）。
// - e20 兑换全场景矩阵（正常/回执验签/错 sig/stale-ts/回放不刷新/耗尽他键/
//   过期/吊销/持新码续期/响应形态）
// - e21 register 限流 + XFF 伪造分裂失败
// - e22 并发双兑恰一成功
// - e23 max_uses=2 串行序列（K1→同键回放计数仍 1→K2）
// - e24 崩溃恢复补 consume（register fsync 后崩溃的磁盘等价态 + 重启归并）
// - e25 pending 第二键 409 + 同键补写完成（codes.jsonl 0444 故障注入）
// - e26 deny-set 503 与恢复（启动孤儿 + 注入失败 → 补写成功移除）
// - e27 codes 台账坏行 fail-fast（整服务拒绝启动）
// - e28 热重载孤儿补齐（运行中文件入口 register → mtime reload 补 consume）

/// 测试侧独立码哈希：blake3(码本体 16 字符小写)——spec 冻结规范化
fn code_hash_of(body16: &str) -> [u8; 32] {
    *blake3::hash(body16.as_bytes()).as_bytes()
}

/// 文件入口签发（codes.jsonl 追加 issue 行；Phase 1c 前的合法签发通道）
fn issue_code_file_entry(
    data_dir: &Path,
    body16: &str,
    max_uses: u32,
    expires_at: u64,
    default_ttl_days: u32,
) {
    use std::io::Write;
    let line = serde_json::json!({
        "op": "issue",
        "code_hash": hex::encode(code_hash_of(body16)),
        "max_uses": max_uses,
        "expires_at": expires_at,
        "default_ttl_days": default_ttl_days,
        "ts": now_ms(),
    })
    .to_string();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("codes.jsonl"))
        .unwrap();
    writeln!(file, "{line}").unwrap();
}

/// 追加任意 codes.jsonl 行（吊销等）
fn append_codes_line(data_dir: &Path, value: serde_json::Value) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("codes.jsonl"))
        .unwrap();
    writeln!(file, "{value}").unwrap();
}

/// 码展示形态：`dwebc1.` + 4-4-4-4 分组
fn code_display(body16: &str) -> String {
    format!(
        "dwebc1.{}-{}-{}-{}",
        &body16[0..4],
        &body16[4..8],
        &body16[8..12],
        &body16[12..16]
    )
}

/// register PoP canonical（独立重实现：域 + code 原文 + fabric/root 小写
/// hex 文本 + ts u64BE——CLI register.mjs 同构）
fn register_pop_canonical(
    code: &str,
    fabric_hex_lower: &str,
    root_hex_lower: &str,
    ts: u64,
) -> Vec<u8> {
    let mut buf = b"dweb/register/v1\0".to_vec();
    buf.extend_from_slice(code.as_bytes());
    buf.extend_from_slice(fabric_hex_lower.as_bytes());
    buf.extend_from_slice(root_hex_lower.as_bytes());
    buf.extend_from_slice(&ts.to_be_bytes());
    buf
}

/// 组装合法签名的 /register 请求体（root PoP）
fn register_body(
    code: &str,
    fabric: &[u8; 32],
    root_key: &SigningKey,
    ts: u64,
) -> serde_json::Value {
    let root_hex = hex::encode(root_key.verifying_key().to_bytes());
    let canonical = register_pop_canonical(code, &hex::encode(fabric), &root_hex, ts);
    serde_json::json!({
        "code": code,
        "fabric_id": hex::encode(fabric),
        "root": root_hex,
        "ts": ts,
        "sig": base64url(root_key.sign(&canonical).to_bytes()),
    })
}

/// register-receipt canonical（独立重实现，137B）
fn register_receipt_canonical(
    code_hash: &[u8; 32],
    fabric: &[u8; 32],
    root: &[u8; 32],
    ts: u64,
    generation: u64,
) -> Vec<u8> {
    let mut buf = b"dweb/register-receipt/v1\0".to_vec();
    buf.extend_from_slice(code_hash);
    buf.extend_from_slice(fabric);
    buf.extend_from_slice(root);
    buf.extend_from_slice(&ts.to_be_bytes());
    buf.extend_from_slice(&generation.to_be_bytes());
    buf
}

fn error_code_of(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body).unwrap()["error"]["code"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

#[tokio::test]
async fn e20_register_full_scenario_matrix() {
    let dir = TempDir::new().unwrap();
    // 三码预签发：A（1 用/30 天）、B（1 用/30 天，持新码续期用）、
    // R（吊销）、E（已过期）
    issue_code_file_entry(dir.path(), "0123456789abcdea", 1, now_ms() + 86_400_000, 30);
    issue_code_file_entry(dir.path(), "0123456789abcdeb", 1, now_ms() + 86_400_000, 30);
    issue_code_file_entry(dir.path(), "0123456789abcded", 1, now_ms() + 86_400_000, 30);
    append_codes_line(
        dir.path(),
        serde_json::json!({
            "op": "revoke",
            "code_hash": hex::encode(code_hash_of("0123456789abcded")),
            "ts": now_ms(),
        }),
    );
    issue_code_file_entry(dir.path(), "0123456789abcdee", 1, now_ms() - 1, 30);
    let server = Server::spawn(
        dir.path(),
        &[
            ("DWEB_ACCESS_MODE", "restricted"),
            ("DWEB_REGISTER_RATE_PER_MIN", "1000"),
        ],
        &[],
        false,
    );
    let server_id = fetch_server_id(server.gateway).await;

    let fabric = [0xA1; 32];
    let root_key = SigningKey::from_bytes(&[0xA2; 32]);
    let code_a = code_display("0123456789abcdea");

    // 正常兑换：200 + 回执可验签 + registry 生效
    let (status, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code_a, &fabric, &root_key, now_ms()),
        &[],
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let receipt: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(receipt["op"], "register");
    assert_eq!(
        receipt["code_hash"],
        hex::encode(code_hash_of("0123456789abcdea"))
    );
    assert!(body.len() <= 4096, "响应体 ≤4KiB");
    assert!(!body.contains("dwebc1."), "回执不含码本体");
    let canonical = register_receipt_canonical(
        &code_hash_of("0123456789abcdea"),
        &fabric,
        &root_key.verifying_key().to_bytes(),
        receipt["ts"].as_u64().unwrap(),
        receipt["generation"].as_u64().unwrap(),
    );
    let sig: [u8; 64] = base64::Engine::decode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        receipt["receipt_sig"].as_str().unwrap(),
    )
    .unwrap()
    .try_into()
    .unwrap();
    use ed25519_dalek::Verifier;
    ed25519_dalek::VerifyingKey::from_bytes(&server_id)
        .unwrap()
        .verify(&canonical, &ed25519_dalek::Signature::from_bytes(&sig))
        .expect("回执可用 services.json ServerId 验签");
    // registry 生效：到期前租户在册（owners.jsonl 出现带 via_code_hash 的 register）
    let owners_text = std::fs::read_to_string(dir.path().join("owners.jsonl")).unwrap();
    assert!(owners_text.contains(&format!(
        "\"via_code_hash\":\"{}\"",
        hex::encode(code_hash_of("0123456789abcdea"))
    )));

    // 错 sig：冒名者私钥签名（canonical 覆盖受害者 root）→ bad-signature
    let impostor = SigningKey::from_bytes(&[0xA3; 32]);
    let ts = now_ms();
    let canonical = register_pop_canonical(
        &code_display("0123456789abcdeb"),
        &hex::encode(fabric),
        &hex::encode(root_key.verifying_key().to_bytes()),
        ts,
    );
    let forged = serde_json::json!({
        "code": code_display("0123456789abcdeb"),
        "fabric_id": hex::encode(fabric),
        "root": hex::encode(root_key.verifying_key().to_bytes()),
        "ts": ts,
        "sig": base64url(impostor.sign(&canonical).to_bytes()),
    });
    let (status, body) = http_post_json(server.gateway, "/register", &forged, &[]).await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(error_code_of(&body), "bad-signature");

    // stale-ts：窗口外重发
    let (status, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(
            &code_display("0123456789abcdeb"),
            &fabric,
            &root_key,
            now_ms() - 121_000,
        ),
        &[],
    )
    .await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(error_code_of(&body), "stale-ts");

    // 同键回放：expires_at 不刷新、无新副作用、回执以当前时刻重签
    std::thread::sleep(Duration::from_millis(10));
    let (status, replay) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code_a, &fabric, &root_key, now_ms()),
        &[],
    )
    .await;
    assert_eq!(status, 200, "{replay}");
    let replay: serde_json::Value = serde_json::from_str(&replay).unwrap();
    assert_eq!(
        replay["expires_at"], receipt["expires_at"],
        "同键回放不刷新租期（回放≠续期）"
    );
    assert!(replay["ts"].as_u64().unwrap() > receipt["ts"].as_u64().unwrap());

    // 耗尽他键：码 A 已被 K1 用掉
    let other_root = SigningKey::from_bytes(&[0xA4; 32]);
    let (status, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code_a, &fabric, &other_root, now_ms()),
        &[],
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(error_code_of(&body), "code-exhausted");

    // 持新码续期：同 (fabric,root) 持码 B → 200 且 expires_at 刷新
    let (status, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(
            &code_display("0123456789abcdeb"),
            &fabric,
            &root_key,
            now_ms(),
        ),
        &[],
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let renewed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(
        renewed["expires_at"].as_u64().unwrap() > receipt["expires_at"].as_u64().unwrap(),
        "持新码 = 续期（expires_at 刷新）"
    );

    // 吊销 → code-invalid；过期 → code-expired
    for (code, want) in [
        (&code_display("0123456789abcded"), "code-invalid"),
        (&code_display("0123456789abcdee"), "code-expired"),
    ] {
        let fresh = SigningKey::from_bytes(&[0xA5; 32]);
        let (status, body) = http_post_json(
            server.gateway,
            "/register",
            &register_body(code, &fabric, &fresh, now_ms()),
            &[],
        )
        .await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(error_code_of(&body), want, "{code}");
    }
    drop(server);
}

#[tokio::test]
async fn e21_register_rate_limit_and_xff_not_trusted() {
    let dir = TempDir::new().unwrap();
    let server = Server::spawn(
        dir.path(),
        &[
            ("DWEB_ACCESS_MODE", "restricted"),
            ("DWEB_REGISTER_RATE_PER_MIN", "2"), // burst = 1
        ],
        &[],
        false,
    );
    let body = register_body(
        "dwebc1.0123-4567-89cd-fghj",
        &[0xB1; 32],
        &SigningKey::from_bytes(&[0xB2; 32]),
        now_ms(),
    );
    let with_xff = |ip: &str| {
        let mut v = body.clone();
        // XFF 不进 body——经 header 伪造
        v["sig"] = v["sig"].clone();
        (v, ip.to_string())
    };
    let (b1, xff1) = with_xff("1.2.3.4");
    let (b2, xff2) = with_xff("5.6.7.8");
    let (s1, body1) = http_post_json(
        server.gateway,
        "/register",
        &b1,
        &[("x-forwarded-for", &xff1)],
    )
    .await;
    assert_eq!(
        s1, 400,
        "首个消费突发（PoP 合法、码未知 → code-invalid）: {body1}"
    );
    assert_eq!(error_code_of(&body1), "code-invalid");
    let (s2, body2) = http_post_json(
        server.gateway,
        "/register",
        &b2,
        &[("x-forwarded-for", &xff2)],
    )
    .await;
    assert_eq!(s2, 429, "第 2 次超突发；XFF 换值不分裂限流键: {body2}");
    assert_eq!(error_code_of(&body2), "rate-limited");
    drop(server);
}

#[tokio::test]
async fn e22_concurrent_double_redemption_single_winner() {
    let dir = TempDir::new().unwrap();
    issue_code_file_entry(dir.path(), "0123456789abcdf0", 1, now_ms() + 86_400_000, 30);
    let server = Server::spawn(
        dir.path(),
        &[("DWEB_ACCESS_MODE", "restricted")],
        &[],
        false,
    );
    let gateway = server.gateway;
    let code = code_display("0123456789abcdf0");
    let k1 = SigningKey::from_bytes(&[0xC1; 32]);
    let k2 = SigningKey::from_bytes(&[0xC2; 32]);
    let (f1, f2) = ([0xC3; 32], [0xC4; 32]);
    let body1 = register_body(&code, &f1, &k1, now_ms());
    let body2 = register_body(&code, &f2, &k2, now_ms());
    let (r1, r2) = tokio::join!(
        http_post_json(gateway, "/register", &body1, &[]),
        http_post_json(gateway, "/register", &body2, &[]),
    );
    let statuses = [r1.0, r2.0];
    assert_eq!(
        statuses.iter().filter(|s| **s == 200).count(),
        1,
        "恰一个 200：{statuses:?} / {} / {}",
        r1.1,
        r2.1
    );
    assert_eq!(
        statuses.iter().filter(|s| **s == 400).count(),
        1,
        "另一个 code-exhausted"
    );
    if r1.0 == 400 {
        assert_eq!(error_code_of(&r1.1), "code-exhausted");
    } else {
        assert_eq!(error_code_of(&r2.1), "code-exhausted");
    }
    // codes.jsonl 恰一条 consume、无半提交
    let codes_text = std::fs::read_to_string(dir.path().join("codes.jsonl")).unwrap();
    assert_eq!(
        codes_text
            .lines()
            .filter(|l| l.contains("\"op\":\"consume\""))
            .count(),
        1,
        "{codes_text}"
    );
    drop(server);
}

#[tokio::test]
async fn e23_max_uses_two_serial_sequence() {
    let dir = TempDir::new().unwrap();
    issue_code_file_entry(dir.path(), "0123456789abcdf1", 2, now_ms() + 86_400_000, 30);
    let server = Server::spawn(
        dir.path(),
        &[("DWEB_ACCESS_MODE", "restricted")],
        &[],
        false,
    );
    let code = code_display("0123456789abcdf1");
    let k1 = SigningKey::from_bytes(&[0xD1; 32]);
    let k2 = SigningKey::from_bytes(&[0xD2; 32]);
    let fabric = [0xD3; 32];
    // K1 首兑
    let (s, _) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &k1, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 200);
    // K1 同键回放：used_count 仍 1
    let (s, _) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &k1, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 200);
    let codes_text = std::fs::read_to_string(dir.path().join("codes.jsonl")).unwrap();
    assert_eq!(
        codes_text
            .lines()
            .filter(|l| l.contains("\"op\":\"consume\""))
            .count(),
        1,
        "回放不增 consume（used_count 仍 1）"
    );
    // K2 在 K1 durable 后按剩余次数成功
    let (s, _) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &k2, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 200);
    let codes_text = std::fs::read_to_string(dir.path().join("codes.jsonl")).unwrap();
    assert_eq!(
        codes_text
            .lines()
            .filter(|l| l.contains("\"op\":\"consume\""))
            .count(),
        2,
        "K2 后 used_count=2"
    );
    // 第三键耗尽
    let k3 = SigningKey::from_bytes(&[0xD4; 32]);
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &k3, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(error_code_of(&body), "code-exhausted");
    drop(server);
}

/// 崩溃窗口磁盘等价态：owners register（含 via_code_hash）已 fsync、
/// codes consume 未落盘 → 进程崩溃。重启归并必须补齐 consume（完整兑换，
/// 无烧码无租户）；同键再兑 = 幂等回放；他键 = 耗尽。
#[tokio::test]
async fn e24_crash_recovery_completes_orphan_consume() {
    let dir = TempDir::new().unwrap();
    issue_code_file_entry(dir.path(), "0123456789abcdf2", 1, now_ms() + 86_400_000, 30);
    let fabric = [0xE1; 32];
    let root = SigningKey::from_bytes(&[0xE2; 32])
        .verifying_key()
        .to_bytes();
    let expires = now_ms() + 30 * 24 * 3_600_000;
    // 崩溃窗口等价态：register durable、consume 缺失
    use std::io::Write;
    let mut owners = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.path().join("owners.jsonl"))
        .unwrap();
    writeln!(
        owners,
        "{}",
        serde_json::json!({
            "op": "register",
            "fabric_id": hex::encode(fabric),
            "root": hex::encode(root),
            "ts": now_ms(),
            "expires_at": expires,
            "via_code_hash": hex::encode(code_hash_of("0123456789abcdf2")),
        })
    )
    .unwrap();
    // 重启：启动归并补齐 consume
    let server = Server::spawn(
        dir.path(),
        &[("DWEB_ACCESS_MODE", "restricted")],
        &[],
        false,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let codes_text = std::fs::read_to_string(dir.path().join("codes.jsonl")).unwrap();
        if codes_text.contains("\"op\":\"consume\"") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "启动 reconciliation 未补齐 consume：{codes_text}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // 完整兑换：租户在册（restricted gate 侧由 owners.jsonl 保证）
    // 同键重试 → 200 幂等回放（不产生第二次租户条目）
    let root_key = SigningKey::from_bytes(&[0xE2; 32]);
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(
            &code_display("0123456789abcdf2"),
            &fabric,
            &root_key,
            now_ms(),
        ),
        &[],
    )
    .await;
    assert_eq!(s, 200, "{body}");
    let replay: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        replay["expires_at"].as_u64().unwrap(),
        expires,
        "回放回落 owners 持久值"
    );
    let owners_text = std::fs::read_to_string(dir.path().join("owners.jsonl")).unwrap();
    assert_eq!(owners_text.lines().count(), 1, "无第二次租户条目");
    let codes_text = std::fs::read_to_string(dir.path().join("codes.jsonl")).unwrap();
    assert_eq!(
        codes_text
            .lines()
            .filter(|l| l.contains("\"op\":\"consume\""))
            .count(),
        1
    );
    drop(server);
}

/// pending 矩阵（codes.jsonl 0444 注入，root 环境跳过）：K1 兑换至 consume
/// 失败 → 500；他键 K2 → 409 code-pending；恢复后同键 K1 补写完成（租期
/// 不重算）；K2 → code-exhausted
#[tokio::test]
#[cfg(unix)]
async fn e25_pending_second_key_409_and_completion() {
    if nix::unistd::Uid::effective().is_root() {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new().unwrap();
    issue_code_file_entry(dir.path(), "0123456789abcdf3", 1, now_ms() + 86_400_000, 30);
    let server = Server::spawn(
        dir.path(),
        &[("DWEB_ACCESS_MODE", "restricted")],
        &[],
        false,
    );
    let codes_path = dir.path().join("codes.jsonl");
    let code = code_display("0123456789abcdf3");
    let fabric = [0xF1; 32];
    let k1 = SigningKey::from_bytes(&[0xF2; 32]);
    let k2 = SigningKey::from_bytes(&[0xF3; 32]);
    // ① 锁 consume 追加：K1 → 500（register durable、consume 失败）
    std::fs::set_permissions(&codes_path, std::fs::Permissions::from_mode(0o444)).unwrap();
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &k1, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 500, "{body}");
    let owners_text = std::fs::read_to_string(dir.path().join("owners.jsonl")).unwrap();
    assert!(
        owners_text.contains("via_code_hash"),
        "跨台账提交 ① 已 durable"
    );
    // ② 他键 K2 → 409 code-pending（不得按未归并 used_count 放行）
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &k2, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 409, "{body}");
    assert_eq!(error_code_of(&body), "code-pending");
    // ③ 恢复可写 → K1 同键补写完成（200）
    std::fs::set_permissions(&codes_path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &k1, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 200, "{body}");
    // ④ K2 → code-exhausted
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &k2, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 400, "{body}");
    assert_eq!(error_code_of(&body), "code-exhausted");
    drop(server);
}

/// deny-set fail-closed：启动即有孤儿（register durable + consume 缺失）且
/// codes.jsonl 不可写 → 该码兑换一律 503 code-unavailable（非 exhausted/
/// expired）；恢复可写并触发 reload（同键重试）→ 补写完成移除 deny
#[tokio::test]
#[cfg(unix)]
async fn e26_deny_set_503_and_recovery() {
    if nix::unistd::Uid::effective().is_root() {
        return;
    }
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new().unwrap();
    issue_code_file_entry(dir.path(), "0123456789abcdf4", 1, now_ms() + 86_400_000, 30);
    let fabric = [0xF5; 32];
    let root = SigningKey::from_bytes(&[0xF6; 32])
        .verifying_key()
        .to_bytes();
    let mut owners = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.path().join("owners.jsonl"))
        .unwrap();
    writeln!(
        owners,
        "{}",
        serde_json::json!({
            "op": "register",
            "fabric_id": hex::encode(fabric),
            "root": hex::encode(root),
            "ts": now_ms(),
            "expires_at": now_ms() + 30 * 24 * 3_600_000,
            "via_code_hash": hex::encode(code_hash_of("0123456789abcdf4")),
        })
    )
    .unwrap();
    drop(owners);
    // 启动即锁：reconciliation 补写失败 → deny-set（非 fail-fast）
    std::fs::set_permissions(
        dir.path().join("codes.jsonl"),
        std::fs::Permissions::from_mode(0o444),
    )
    .unwrap();
    let server = Server::spawn(
        dir.path(),
        &[("DWEB_ACCESS_MODE", "restricted")],
        &[],
        false,
    );
    let root_key = SigningKey::from_bytes(&[0xF6; 32]);
    let code = code_display("0123456789abcdf4");
    let stranger = SigningKey::from_bytes(&[0xF7; 32]);
    // 他键兑换（无 pending 预留）：503 code-unavailable
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &stranger, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 503, "{body}");
    assert_eq!(error_code_of(&body), "code-unavailable");
    // 恢复可写：看护的 deny-set 自愈重试（权限修复不改变 mtime/len——
    // deny 非空即每轮重试）补齐 consume → deny 移除
    std::fs::set_permissions(
        dir.path().join("codes.jsonl"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(9);
    loop {
        let codes_text = std::fs::read_to_string(dir.path().join("codes.jsonl")).unwrap();
        if codes_text.contains("\"op\":\"consume\"") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "deny-set 自愈未在 9s 内补齐：{codes_text}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // 补写完成后按码状态裁决：孤儿键 = 幂等回放 200；他键 = 耗尽
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &root_key, now_ms()),
        &[],
    )
    .await;
    assert_eq!(
        s, 200,
        "孤儿键同键兑换 = 幂等回放（补写已 durable）：{body}"
    );
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(&code, &fabric, &stranger, now_ms()),
        &[],
    )
    .await;
    assert_eq!(s, 400, "补写完成后按码状态裁决：{body}");
    assert_eq!(error_code_of(&body), "code-exhausted");
    drop(server);
}

/// 台账加载失败 fail-fast：codes.jsonl 坏行 → 整服务拒绝启动（退出码非零，
/// 日志含台账路径与失败原因——r4-P1-3 分级 (a)）
#[tokio::test]
async fn e27_codes_ledger_bad_line_fails_fast() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("codes.jsonl"), "not json\n").unwrap();
    let mut server = Server::spawn_raw(
        dir.path(),
        &[("DWEB_ACCESS_MODE", "restricted")],
        &[],
        false,
    );
    let status = server.wait_exit(Duration::from_secs(10));
    assert!(!status.success(), "坏行必须 fail-fast 拒绝启动");
    let dump = server.log_dump();
    assert!(dump.contains("codes.jsonl"), "启动日志含台账路径：{dump}");
    assert!(
        dump.contains("malformed codes record"),
        "日志含失败原因：{dump}"
    );
}

/// 热重载孤儿补齐：运行中经文件入口追加带 via_code_hash 的 register →
/// mtime reload（5s 轮询）同锁补齐 consume；同键兑换收敛为幂等回放
#[tokio::test]
async fn e28_hot_reload_orphan_reconciliation() {
    let dir = TempDir::new().unwrap();
    issue_code_file_entry(dir.path(), "0123456789abcdf5", 1, now_ms() + 86_400_000, 30);
    let server = Server::spawn(
        dir.path(),
        &[("DWEB_ACCESS_MODE", "restricted")],
        &[],
        false,
    );
    // 运行中文件入口追加孤儿 register（无 consume）
    use std::io::Write;
    let fabric = [0xF8; 32];
    let root_key = SigningKey::from_bytes(&[0xF9; 32]);
    let root = root_key.verifying_key().to_bytes();
    let mut owners = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.path().join("owners.jsonl"))
        .unwrap();
    writeln!(
        owners,
        "{}",
        serde_json::json!({
            "op": "register",
            "fabric_id": hex::encode(fabric),
            "root": hex::encode(root),
            "ts": now_ms(),
            "via_code_hash": hex::encode(code_hash_of("0123456789abcdf5")),
        })
    )
    .unwrap();
    drop(owners);
    // 等 mtime 轮询（5s 间隔）补齐 consume
    let deadline = Instant::now() + Duration::from_secs(9);
    loop {
        let codes_text = std::fs::read_to_string(dir.path().join("codes.jsonl")).unwrap();
        if codes_text.contains("\"op\":\"consume\"") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "热重载未在 9s 内补齐孤儿 consume：{codes_text}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // 同键兑换 → 200 幂等回放（consume 已补齐；恰一条 consume）
    let (s, body) = http_post_json(
        server.gateway,
        "/register",
        &register_body(
            &code_display("0123456789abcdf5"),
            &fabric,
            &root_key,
            now_ms(),
        ),
        &[],
    )
    .await;
    assert_eq!(s, 200, "{body}");
    let codes_text = std::fs::read_to_string(dir.path().join("codes.jsonl")).unwrap();
    assert_eq!(
        codes_text
            .lines()
            .filter(|l| l.contains("\"op\":\"consume\""))
            .count(),
        1
    );
    drop(server);
}

/// rendezvous per-IP 限流经真实 gateway（ConnectInfo 接线 + open 模式同
/// 样生效——与 access mode 正交；resolve 2/min → burst 1：第二个请求 429）
#[tokio::test]
async fn e29_rendezvous_rate_limit_on_real_gateway() {
    let dir = TempDir::new().unwrap();
    let server = Server::spawn(
        dir.path(),
        &[("DWEB_RDZ_RATE_RESOLVE_PER_MIN", "2")],
        &[],
        false,
    );
    let target = hex::encode([0xAB; 32]);
    // open 模式匿名 resolve：首请求 404（无登记，未限流）；第二个 429
    let (s1, _) = http_get(server.gateway, &format!("/rendezvous/{target}")).await;
    assert_eq!(s1, 404);
    let (s2, body) = http_get(server.gateway, &format!("/rendezvous/{target}")).await;
    assert_eq!(s2, 429, "{body}");
    assert_eq!(body, r#"{"error":"rate-limited"}"#);
    drop(server);
}
