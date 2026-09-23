//! G-3 停机行为验收（home-hub Phase 3b，test-only，产品代码零改动）：
//!
//! spec 真源：openspec/changes/home-hub/specs/cli/hub/spec.md
//! 「G-3 停机行为的 delta 验收（test-only）」/ Scenario「停整个中枢后直连会话
//! 存活（Rust test-only）」。design §7 总裁决：Custom relay 入网（家庭入网链
//! 的自然结果）下，已直连（Direct path selected）会话在中枢全停后继续双向
//! 可达（QUIC 直发，不经 relay）。
//!
//! 「中枢」在 test-only 拓扑中的形态：本进程内 spawn 的真实 iroh relay
//! server（自签证书经 RelayTlsTrust::CustomPem 信任）即中枢的网络面
//! （gateway+rendezvous/relay 的承载者——iroh 会合/打洞/中转全部经它）。
//! 「停整个中枢进程」= `server.shutdown().await`（取消令牌 → accept 环退出 →
//! JoinSet 关停全部连接任务+监听器关闭——观察面等价于杀进程：既有 relay
//! 客户端连接被真实切断、端口拒绝新连接）。实证警示：裸 `drop(server)` 只
//! 中止 supervisor，**已建立的 relay 连接会泄漏存活**（连接任务不死，中枢
//! 功能性在线，本文件初版即被此坑翻车：D 停机窗口内 join 竟经僵尸连接
//! 成功）——不等效于停进程，故不可用 drop 注入。
//!
//! 用例结构 ↔ spec Scenario 映射：
//! ① 两节点（B、C）以 Custom relay 指向测试 server join（root A 签发）；
//! ② 轮询断言 `link_status==Direct`（先证直连，之后才允许停中枢）；
//! ③ 停整个 server（shutdown()：连接全断+端口关闭，另以 TCP 拒连硬证）；
//! ④ 双向 send 全窗口零中断：周期双向带序号 send、双侧事件面断言无
//!    PeerDisconnected/PathChanged 离开 Direct、link_status 持续 Direct、
//!    接收序号连续（零丢失）；
//! ⑤ 同窗口内新节点 D join 失败（relay 不可达，归类网络不可达族：
//!    RelayOffline/DialFailed/DialTimeout）；
//! ⑥ 重启 server（同证书同端口）→ D join 成功（恢复半边；A 名册含 4 成员）。
//!
//! relay-only 对照（docker 双 bridge 隔离 UDP）：已实际执行并自动断言——
//! driver（本文件 `g3_relay_only_control_driver`，env 驱动）经宿主侧编排跑在
//! 两个 --internal bridge 的隔离容器里，实测 relay-only 会话在中枢进程
//! docker stop 后 33.6s 断开、中枢回来后 21.0s 自动恢复（重连 worker，无
//! 进程重启）；六字段记录与命令清单见 docs/acceptance-home-hub-g3.md。
//! PM 侧恢复时限文案仍维持「依网络环境」口径（设计 §7：环境特定数字不改
//! 产品文案承诺）。
//!
//! 时长策略：spec 全量窗口 ≥300s 的主用例标注 `#[ignore = "g3-300s"]`
//! （默认电池 188s 基线上再默认挂 330s+ 会令每次绿门近三倍——CI
//! `cargo test --workspace`（40min timeout）与本地迭代双双不可承受），
//! 验收以 `cargo test -p dweb-fabric --test g3_hub_outage -- --ignored
//! --exact` 显式执行并留实跑记录；同一代码路径的 20s 短窗变体进默认
//! 电池，保证接线（停机注入/窗口断言/D 探针/恢复 join）持续回归。

use dweb_fabric::fabric::FabricEvent;
use dweb_fabric::{
    Fabric, FabricConfig, FabricError, HttpProxyConfig, JoinErrorCode, LinkStatus, RelayConfig,
    RelayTlsTrust, SecretInjection,
};
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// spec Scenario 冻结的停机窗口下限（≥300s 双向零中断）。
const OUTAGE_WINDOW_SPEC: Duration = Duration::from_secs(300);
/// 短窗变体窗口（默认电池；同一代码路径，仅缩短窗口）。
const OUTAGE_WINDOW_BRIEF: Duration = Duration::from_secs(20);
/// 窗口内双向 send 周期。
const SEND_INTERVAL: Duration = Duration::from_millis(500);

// ---- 脚手架（与 relay_failover.rs 同构） -----------------------------------------

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
///（跨中枢重启复用同一证书身份，端口的 CustomPem 信任保持有效）。
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

/// 在固定 HTTPS 端口起真实 relay server（drop 返回值即全停——supervisor 为
/// AbortOnDropHandle；重启用同一 TLS 材料保证同证书同端口）。
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
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: 8_000,
        relay_tls_trust: RelayTlsTrust::CustomPem(cert_pem),
        bind_addr: None,
    }
}

/// 有界等待 relay 快照 online=true（失败即超时，不挂死）。恢复等待用宽预算：
/// iroh relay actor 断线重试退避上限 16s + 连接超时 10s。
async fn wait_relay_online_within(fabric: &Fabric, what: &str, budget: Duration) {
    tokio::time::timeout(budget, async {
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

/// 有界轮询 link_status==Direct（G-3 前置：先证直连，才允许停中枢）。
/// loopback 上 iroh 打洞直连路径建立后，BiasedRttPathSelector 将 relay 归为
/// Backup 传输（直连可用时必选直连），Direct 是稳定稳态而非竞态。
async fn wait_link_direct(fabric: &Fabric, peer_id: &str, what: &str, budget: Duration) {
    tokio::time::timeout(budget, async {
        loop {
            if matches!(fabric.link_status(peer_id).await, Ok(LinkStatus::Direct)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}: link_status did not reach Direct within {budget:?}"));
}

// ---- 窗口证据面 ------------------------------------------------------------------

/// 窗口内双向流量与事件面的累计证据。
#[derive(Default)]
struct WindowStats {
    sent_b2c: u64,
    sent_c2b: u64,
    /// C 侧收到的 b2c 序号连续核验（下一期望序号）。
    recv_b2c_next: u64,
    /// B 侧收到的 c2b 序号连续核验（下一期望序号）。
    recv_c2b_next: u64,
    /// 观察到 relay 聚合态翻 offline（停机真实性的观察面证据之一）。
    saw_relay_offline: bool,
}

fn seq_payload(dir_tag: &str, seq: u64) -> Vec<u8> {
    format!("{dir_tag}:{seq}").into_bytes()
}

fn parse_seq(dir_tag: &str, data: &[u8]) -> Option<u64> {
    let s = std::str::from_utf8(data).ok()?;
    let rest = s.strip_prefix(dir_tag)?.strip_prefix(':')?;
    rest.parse().ok()
}

/// 非阻塞清空一侧事件面并执行零中断断言（限受验对端 B<->C）：
/// - Message：序号必须严格连续（零丢失＝零中断的载荷面证据）；
/// - PeerDisconnected（受验对端）：直接失败；
/// - PathChanged 离开 Direct（受验对端）：直接失败；
/// - Lagged：事件通道丢帧＝零中断断言不可信，直接失败（500ms 双消息
///   周期 vs 256 容量，正常运行不可达；防御性硬失败）。
fn drain_and_assert(
    rx: &mut tokio::sync::broadcast::Receiver<FabricEvent>,
    side: &str,
    peer_id: &str,
    dir_tag: &str,
    next_recv: &mut u64,
    since: Instant,
) {
    loop {
        match rx.try_recv() {
            Ok(FabricEvent::Message { from, data }) if from == peer_id => {
                let seq = parse_seq(dir_tag, &data)
                    .unwrap_or_else(|| panic!("{side}: malformed payload {data:?}"));
                assert_eq!(
                    seq,
                    *next_recv,
                    "{side}: {dir_tag} sequence gap at t={:?} (zero-interruption violated)",
                    since.elapsed()
                );
                *next_recv += 1;
            }
            Ok(FabricEvent::PeerDisconnected { endpoint_id }) if endpoint_id == peer_id => {
                panic!(
                    "{side}: PeerDisconnected({endpoint_id}) at t={:?} — direct session must \
                     survive full hub outage",
                    since.elapsed()
                );
            }
            Ok(FabricEvent::PathChanged {
                endpoint_id,
                status,
            }) if endpoint_id == peer_id => {
                assert_eq!(
                    status,
                    LinkStatus::Direct,
                    "{side}: path left Direct at t={:?} — spec requires Direct maintained",
                    since.elapsed()
                );
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => panic!(
                "{side}: event channel lagged ({n} dropped) at t={:?} — zero-interruption \
                 assertion unreliable",
                since.elapsed()
            ),
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                panic!("{side}: event channel closed at t={:?}", since.elapsed())
            }
        }
    }
}

/// 窗口收尾：排空在途消息（有界），断言双侧收发计数配平。
async fn settle_and_assert_counters(
    ev_b: &mut tokio::sync::broadcast::Receiver<FabricEvent>,
    ev_c: &mut tokio::sync::broadcast::Receiver<FabricEvent>,
    b_id: &str,
    c_id: &str,
    stats: &mut WindowStats,
    since: Instant,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while (stats.recv_b2c_next < stats.sent_b2c || stats.recv_c2b_next < stats.sent_c2b)
        && Instant::now() < deadline
    {
        drain_and_assert(ev_b, "b", c_id, "c2b", &mut stats.recv_c2b_next, since);
        drain_and_assert(ev_c, "c", b_id, "b2c", &mut stats.recv_b2c_next, since);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        stats.recv_b2c_next, stats.sent_b2c,
        "c side must receive every b2c message sent during the outage window"
    );
    assert_eq!(
        stats.recv_c2b_next, stats.sent_c2b,
        "b side must receive every c2b message sent during the outage window"
    );
}

// ---- G-3 场景主体 ----------------------------------------------------------------

/// G-3 停机场景（spec Scenario 全步骤；window 与断言深度按变体参数化）。
///
/// `assert_relay_flip_offline`：长窗断言观察面确实翻 offline（300s 内 iroh
/// 心跳/探针必达）；短窗（20s）不强制（翻转时点依赖心跳周期，非本变体义务）。
async fn run_g3_outage_scenario(window: Duration, assert_relay_flip_offline: bool) {
    let tls = self_signed_tls();
    let port = reserve_closed_tcp_port();
    let relay_url = relay_url_for(port);

    // ① 测试中枢上线；root A 以 Custom relay 入网
    let server = spawn_relay_on(port, &tls).await;
    let dir_a = TempDir::new().unwrap();
    let a = Fabric::create_root(cfg(&dir_a, vec![relay_url.clone()], tls.cert_pem.clone()))
        .await
        .expect("root fabric a");
    wait_relay_online_within(&a, "root a", Duration::from_secs(25)).await;

    // 令牌 TTL 覆盖整个场景（含 300s 窗口 + 恢复半边），一次签发、全程复用
    let ttl_ms = 900_000u64;
    let token_b = a.invite(ttl_ms, None).await.expect("invite b");
    let token_c = a.invite(ttl_ms, None).await.expect("invite c");
    let token_d = a.invite(ttl_ms, None).await.expect("invite d");
    let fid_hex = a.fabric_id_hex().await;

    // ① B、C 分别 join（各 TempDir、各自身份）
    let dir_b = TempDir::new().unwrap();
    let b = Fabric::attach(
        cfg(&dir_b, vec![relay_url.clone()], tls.cert_pem.clone()),
        &fid_hex,
    )
    .await
    .expect("member fabric b");
    wait_relay_online_within(&b, "member b", Duration::from_secs(25)).await;
    b.join(&token_b).await.expect("b joins fabric");

    let dir_c = TempDir::new().unwrap();
    let c = Fabric::attach(
        cfg(&dir_c, vec![relay_url.clone()], tls.cert_pem.clone()),
        &fid_hex,
    )
    .await
    .expect("member fabric c");
    wait_relay_online_within(&c, "member c", Duration::from_secs(25)).await;
    c.join(&token_c).await.expect("c joins fabric");

    // 新节点 D 停机前起好（新节点到达=join 尝试；fabric 起动本身零网络依赖面）
    let dir_d = TempDir::new().unwrap();
    let d = Fabric::attach(
        cfg(&dir_d, vec![relay_url.clone()], tls.cert_pem.clone()),
        &fid_hex,
    )
    .await
    .expect("late-joiner fabric d");
    wait_relay_online_within(&d, "late joiner d", Duration::from_secs(25)).await;

    // 名册互通：B/C 各自与 A 同步（HELLO 携带全量事实，互相知晓对方 Grant）
    b.connect(&a.endpoint_id())
        .await
        .expect("b syncs roster via a");
    c.connect(&a.endpoint_id())
        .await
        .expect("c syncs roster via a");

    // 受验会话：B <-> C（B 拨号，C acceptor）
    let b_id = b.endpoint_id();
    let c_id = c.endpoint_id();
    b.connect(&c_id).await.expect("b-c session established");

    // ② 先证直连（窗口前置：Direct 是本验收的适用条件）
    wait_link_direct(&b, &c_id, "b->c", Duration::from_secs(60)).await;
    wait_link_direct(&c, &b_id, "c->b", Duration::from_secs(60)).await;

    // 事件订阅先于停机（窗口内任何跳变都必须入账）。载荷序号 1 起，
    // 接收侧连续核验的「下一期望序号」同基。
    let mut ev_b = b.subscribe();
    let mut ev_c = c.subscribe();
    let mut stats = WindowStats {
        recv_b2c_next: 1,
        recv_c2b_next: 1,
        ..Default::default()
    };

    // ③ 停整个中枢：shutdown() 走取消令牌 → accept 环退出 → JoinSet 关停全部
    //    连接任务（客户端侧连接被真实切断）+ 监听器关闭。实证注意：裸 drop()
    //    只中止 supervisor，已建立的 relay 客户端连接会泄漏存活（连接任务不死，
    //    D 的 join 甚至能经僵尸连接成功）——不等效于停进程，不可用。
    server
        .shutdown()
        .await
        .expect("graceful hub shutdown severs all connections");
    let window_start = Instant::now();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("hub https port must refuse TCP within 5s after full shutdown");

    // ④+⑤ 停机窗口：双向周期 send 零中断 + 事件面/路径面核查 + 中点 D join 探针
    //（探针为并发任务：发起于窗口内、失败完成于 join 时限内，send 证据面零间隙）
    let d_probe_at = window_start + window / 2;
    let mut d_join_task: Option<tokio::task::JoinHandle<Result<(), FabricError>>> = None;
    while window_start.elapsed() < window {
        stats.sent_b2c += 1;
        b.send(&c_id, seq_payload("b2c", stats.sent_b2c))
            .await
            .expect("b->c send must succeed during full hub outage");
        stats.sent_c2b += 1;
        c.send(&b_id, seq_payload("c2b", stats.sent_c2b))
            .await
            .expect("c->b send must succeed during full hub outage");

        drain_and_assert(
            &mut ev_b,
            "b",
            &c_id,
            "c2b",
            &mut stats.recv_c2b_next,
            window_start,
        );
        drain_and_assert(
            &mut ev_c,
            "c",
            &b_id,
            "b2c",
            &mut stats.recv_b2c_next,
            window_start,
        );

        // 路径面持续采样：双侧必须保持 Direct（QUIC 直发不经中枢）
        assert_eq!(
            b.link_status(&c_id).await.unwrap(),
            LinkStatus::Direct,
            "b->c must stay Direct at t={:?}",
            window_start.elapsed()
        );
        assert_eq!(
            c.link_status(&b_id).await.unwrap(),
            LinkStatus::Direct,
            "c->b must stay Direct at t={:?}",
            window_start.elapsed()
        );

        stats.saw_relay_offline |= b.relay_status().online == Some(false);

        // ⑤ 窗口中点：新节点 join 尝试（中枢不可达；拨号止于 relay 腿）
        if d_join_task.is_none() && Instant::now() >= d_probe_at {
            let d2 = d.clone();
            let token = token_d.clone();
            d_join_task = Some(tokio::spawn(async move { d2.join(&token).await }));
        }

        tokio::time::sleep(SEND_INTERVAL).await;
    }
    // 窗口内发起的 join 必须失败，且归类为「网络不可达」族（RelayOffline=探针
    // 归因 / DialFailed=拨号错误 / DialTimeout=join 时限到点——中枢停机时 D 的
    // relay actor 处于退避重试，deadline 到点是常态路径；排除 Token* 等协议
    // 层类别）。join 时限 8s 保证失败完成于窗口内。
    let d_err = d_join_task
        .expect("D outage probe must have started in-window")
        .await
        .expect("D join task must not panic")
        .expect_err("new join during full hub outage must fail");
    assert!(
        matches!(
            &d_err,
            FabricError::Join {
                code: JoinErrorCode::RelayOffline,
                ..
            } | FabricError::Join {
                code: JoinErrorCode::DialFailed,
                ..
            } | FabricError::Join {
                code: JoinErrorCode::DialTimeout,
                ..
            }
        ),
        "outage join must classify as network-unreachable family, got: {d_err:?}"
    );
    // join 失败必须留在 join 层：fabric 存活、名册未混入
    assert_eq!(
        d.members().await.len(),
        0,
        "failed join must not merge roster"
    );
    assert!(
        window_start.elapsed() >= window,
        "outage window must cover the full spec duration (>= {window:?})"
    );
    if assert_relay_flip_offline {
        assert!(
            stats.saw_relay_offline,
            "relay aggregate status must flip offline during the outage (hub was really down)"
        );
    }

    // 窗口收尾：在途消息排空 + 双侧收发配平（序号连续已在事件面逐条断言）
    settle_and_assert_counters(&mut ev_b, &mut ev_c, &b_id, &c_id, &mut stats, window_start).await;
    assert!(
        stats.sent_b2c > 0 && stats.sent_c2b > 0,
        "window must carry traffic"
    );

    // ⑥ 恢复半边：同证书同端口重启中枢 → D join 成功（同一令牌、同一进程——
    //    停机不烧令牌、恢复不需进程重启）。join 带有界重试：停机窗口内 D 的
    //    join 尝试按 P1-10 把 connect 留在后台自然跑完，首个恢复 join 可能与
    //    relay 客户端重注册/残留拨号清理赛跑（观测：8s deadline 到点，探针
    //    relay online——瞬时收敛竞态而非行为破坏），故允许 ≤3 次尝试收敛。
    let _server2 = spawn_relay_on(port, &tls).await;
    wait_relay_online_within(&a, "root a recovery", Duration::from_secs(45)).await;
    wait_relay_online_within(&d, "late joiner d recovery", Duration::from_secs(45)).await;
    let mut joined = false;
    for attempt in 1..=3u8 {
        match d.join(&token_d).await {
            Ok(()) => {
                eprintln!("g3 recovery join ok on attempt {attempt}");
                joined = true;
                break;
            }
            Err(err) => {
                eprintln!("g3 recovery join attempt {attempt} failed: {err:?}");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
    assert!(
        joined,
        "new member must join after hub restart (<=3 attempts)"
    );
    assert_eq!(
        a.members().await.len(),
        4,
        "roster must hold a+b+c+d after recovery join"
    );

    eprintln!(
        "g3 window: {:?} window, {} b2c / {} c2b sends, all delivered in-order, relay_offline_observed={}",
        window_start.elapsed(),
        stats.sent_b2c,
        stats.sent_c2b,
        stats.saw_relay_offline
    );

    // 进程自终止面：fabric 逐一停机（TempDir 析构自动回收磁盘状态）
    a.shutdown().await.expect("shutdown a");
    b.shutdown().await.expect("shutdown b");
    c.shutdown().await.expect("shutdown c");
    d.shutdown().await.expect("shutdown d");
}

// ---- 用例入口 --------------------------------------------------------------------

/// spec Scenario「停整个中枢后直连会话存活」主验收（窗口=300s 冻结下限）。
///
/// 标注 `#[ignore = "g3-300s"]`：默认电池基线 188s，默认挂 330s+ 用例会令
/// 每次绿门近三倍（CI `cargo test --workspace` 40min timeout 同受冲击）。
/// 验收执行：`cargo test -p dweb-fabric --test g3_hub_outage -- --ignored
/// --exact hub_outage_direct_session_survives_300s`。
#[tokio::test]
#[ignore = "g3-300s"]
async fn hub_outage_direct_session_survives_300s() {
    run_g3_outage_scenario(OUTAGE_WINDOW_SPEC, true).await;
}

/// 短窗变体（默认电池）：同一场景代码路径，20s 窗口 + 中点 D 探针——对停机
/// 注入/窗口断言/恢复 join 的接线做持续回归；300s 维度的零中断证据由上面的
/// 主验收显式运行承载。
#[tokio::test]
async fn hub_outage_direct_session_survives_brief_window() {
    run_g3_outage_scenario(OUTAGE_WINDOW_BRIEF, false).await;
}

// ---- relay-only 对照 driver（acceptance 手动编排，不在默认电池运行） --------------
//
// design §7「relay-only 对照：docker 双 bridge 隔离 UDP」的执行载体：由宿主侧
// 编排（命令清单与结果见 docs/acceptance-home-hub-g3.md）在两个互相隔离的
// docker bridge 网络里各起一个节点容器（直连不可能，唯一路径=relay），中枢
// relay 以独立容器承载（`docker stop`=停整个中枢进程：OS 关闭全部套接字；
// 无 TLS 自签身份问题——plain http relay，重启无需保身份）。
//
// 预期（§7 relay-only 结论侧）：relay 停止后 relay-only 会话断开（时限记录于
// acceptance），relay 回来后由重连 worker 自动恢复；driver 以进程退出码给出
// 自动判定（drop+recover 均发生才算过），日志行携带 unix 毫秒时戳供编排侧
// 对齐 docker stop/start 时刻。
//
// 环境变量协议（G3_ROLE 缺省时静默跳过——普通 `--ignored` 扫跑不误伤）：
//   G3_ROLE=relay   G3_PORT=<u16>                       G3_DURATION_SECS
//   G3_ROLE=root    G3_RELAY_URL G3_DURATION_SECS
//   G3_ROLE=member  G3_RELAY_URL G3_TOKEN G3_ROOT_ID    G3_DURATION_SECS

fn g3_env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("driver env {key} required"))
}

fn g3_env_secs(key: &str) -> Duration {
    Duration::from_secs(g3_env(key).parse::<u64>().expect("secs"))
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

/// driver 节点配置：plain-http relay（TLS 信任面不参与）、不公告直连地址。
fn driver_cfg(dir: &TempDir, relay_url: String) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Custom(vec![relay_url]),
        advertise_addrs: Vec::new(),
        secret: SecretInjection::Default,
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: 20_000,
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
        bind_addr: None,
    }
}

/// 中枢面：plain http relay 绑 0.0.0.0:port（跨容器可达）；进程被 docker
/// stop 杀死=真实进程死亡（OS 切断全部连接）。
async fn drive_relay_head() {
    let port: u16 = g3_env("G3_PORT").parse().expect("port");
    let duration = g3_env_secs("G3_DURATION_SECS");
    let mut relay = iroh_relay::server::RelayConfig::new((Ipv4Addr::UNSPECIFIED, port));
    relay.key_cache_capacity = Some(1024);
    let mut config = iroh_relay::server::ServerConfig::default();
    config.relay = Some(relay);
    config.quic = None;
    let server = iroh_relay::server::Server::spawn(config)
        .await
        .expect("plain relay spawn");
    eprintln!("RELAY_READY t={}", unix_ms());
    tokio::time::sleep(duration).await;
    server.shutdown().await.expect("relay self-terminate");
    eprintln!("RELAY_EXIT t={}", unix_ms());
}

/// root 面：签发令牌（编排侧转交 member），等 member 建立会话后周期心跳；
/// 记录会话掉线/恢复时戳。不因掉线失败（掉线正是被测行为）。
async fn drive_root_head() {
    let relay_url = g3_env("G3_RELAY_URL");
    let duration = g3_env_secs("G3_DURATION_SECS");
    let dir = TempDir::new().unwrap();
    let a = Fabric::create_root(driver_cfg(&dir, relay_url.clone()))
        .await
        .expect("root fabric");
    wait_relay_online_within(&a, "driver root", Duration::from_secs(30)).await;
    eprintln!("ROOT_RELAY_ONLINE t={}", unix_ms());
    eprintln!("ROOT_ENDPOINT {}", a.endpoint_id());
    let token = a.invite(600_000, None).await.expect("invite");
    eprintln!("ROOT_TOKEN {token}");

    let mut ev = a.subscribe();
    let deadline = Instant::now() + duration;
    let mut member: Option<String> = None;
    let mut hb: u64 = 0;
    while Instant::now() < deadline {
        while let Ok(e) = ev.try_recv() {
            match e {
                FabricEvent::PeerConnected { endpoint_id } if member.is_none() => {
                    member = Some(endpoint_id);
                    eprintln!("ROOT_PEER_CONNECTED t={}", unix_ms());
                }
                FabricEvent::PeerDisconnected { ref endpoint_id }
                    if Some(endpoint_id) == member.as_ref() =>
                {
                    eprintln!("ROOT_PEER_DROPPED t={}", unix_ms());
                    member = None;
                }
                _ => {}
            }
        }
        if let Some(peer) = &member {
            hb += 1;
            if let Err(err) = a.send(peer, format!("hb:{hb}").into_bytes()).await {
                eprintln!("ROOT_SEND_ERR t={} err={err}", unix_ms());
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    eprintln!("ROOT_DONE t={} hbs={hb}", unix_ms());
    a.shutdown().await.expect("root shutdown");
}

/// member 面：join+connect 后**必须收敛到 Relay-only**（Direct=隔离失败）；
/// 记录会话掉线与自动恢复时戳，窗口结束要求「掉线且已自动恢复」否则失败
/// （进程退出码即自动判定）。
async fn drive_member_head() {
    let relay_url = g3_env("G3_RELAY_URL");
    let token = g3_env("G3_TOKEN");
    let root_id = g3_env("G3_ROOT_ID");
    let duration = g3_env_secs("G3_DURATION_SECS");
    let t0 = Instant::now();

    let dir = TempDir::new().unwrap();
    // fabric_id 由 root 令牌携带：解码取得（driver 侧不经过编排面传参）
    let fid_hex = {
        let decoded = dweb_fabric::precheck_join_token(&token).expect("token decodes");
        hex::encode(decoded.invite.fabric_id.as_bytes())
    };
    let m = Fabric::attach(driver_cfg(&dir, relay_url.clone()), &fid_hex)
        .await
        .expect("member fabric");
    wait_relay_online_within(&m, "driver member", Duration::from_secs(30)).await;
    m.join(&token).await.expect("member joins via relay");
    m.connect(&root_id).await.expect("member connects root");

    // 隔离硬断言：任何时刻都不得出现 Direct（双 bridge 使直连不可达；Direct
    // 出现即拓扑失真，实验作废）。relay-only 的正向证据不由 link_status 承载：
    // 实证（docker 双 bridge，2026-09-23）纯 relay 会话的 path watcher 稳态为
    // Unknown（Selected 事件只在路径**跳变**时发出，Relay 枚举仅在「direct
    // 回落 relay」跳变后出现）——对照组的 relay-only 证明 = ①网络级阻断探针
    // （编排侧：SAME_BRIDGE=REACHABLE + CROSS_BRIDGE=BLOCKED）+ ②行为证据：
    // 停 relay 进程将会话杀死（主用例已证 Direct 会话在同等停机下存活）。
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match m.link_status(&root_id).await {
                Ok(LinkStatus::Direct) => panic!("ISOLATION_FAILED: direct path selected"),
                Ok(_) => return,
                Err(err) => eprintln!("MEMBER_SETTLE_ERR t={} err={err}", unix_ms()),
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .expect("link_status must settle on a non-direct steady state");
    eprintln!("MEMBER_RELAY_ONLY_CONFIRMED t={}", unix_ms());

    let mut ev = m.subscribe();
    let deadline = Instant::now() + duration;
    let mut connected = true;
    let mut dropped_at: Option<u128> = None;
    let mut recovered_at: Option<u128> = None;
    let mut send_ok: u64 = 0;
    let mut send_fail: u64 = 0;
    let mut hb: u64 = 0;
    while Instant::now() < deadline {
        while let Ok(e) = ev.try_recv() {
            match e {
                FabricEvent::PeerDisconnected { ref endpoint_id } if endpoint_id == &root_id => {
                    connected = false;
                    dropped_at = Some(unix_ms());
                    eprintln!("MEMBER_SESSION_DROPPED t={}", unix_ms());
                }
                FabricEvent::PeerConnected { ref endpoint_id }
                    if endpoint_id == &root_id && !connected =>
                {
                    connected = true;
                    recovered_at = Some(unix_ms());
                    eprintln!("MEMBER_SESSION_RECOVERED t={}", unix_ms());
                }
                FabricEvent::PathChanged {
                    ref endpoint_id,
                    status: LinkStatus::Direct,
                } if endpoint_id == &root_id => {
                    panic!("ISOLATION_FAILED: direct path selected mid-run");
                }
                _ => {}
            }
        }
        if connected {
            hb += 1;
            match m.send(&root_id, format!("hb:{hb}").into_bytes()).await {
                Ok(()) => send_ok += 1,
                Err(err) => {
                    send_fail += 1;
                    eprintln!("MEMBER_SEND_ERR t={} err={err}", unix_ms());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    eprintln!(
        "MEMBER_DONE t={} elapsed={:?} dropped_at={dropped_at:?} recovered_at={recovered_at:?} \
         send_ok={send_ok} send_fail={send_fail}",
        unix_ms(),
        t0.elapsed()
    );
    m.shutdown().await.expect("member shutdown");
    assert!(
        dropped_at.is_some(),
        "relay-only session must drop while the hub process is stopped"
    );
    assert!(
        recovered_at.is_some(),
        "relay-only session must auto-recover after the hub returns"
    );
}

/// relay-only 对照 driver 入口（#[ignore]：仅 acceptance 编排显式执行）。
#[tokio::test]
#[ignore = "g3-relay-only-driver"]
async fn g3_relay_only_control_driver() {
    let Ok(role) = std::env::var("G3_ROLE") else {
        return; // 无编排环境：静默跳过（防 --ignored 扫跑误伤）
    };
    match role.as_str() {
        "relay" => drive_relay_head().await,
        "root" => drive_root_head().await,
        "member" => drive_member_head().await,
        other => panic!("unknown G3_ROLE {other}"),
    }
}
