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

// ---- A-反向：root 崩溃重入、member 存活且 relay 客户端搁浅 ------------------------

/// 预留一个 UDP 端口并立即释放（固定 bind 用；与 crash_rejoin.rs 同法）。
fn reserve_loopback_udp_port() -> u16 {
    std::net::UdpSocket::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// 黑洞 TCP 代理：正常态双向透传上游 relay；置位后**不发 FIN**——上游
/// 读方向即停（客户端不再收到任何字节）、下游照读照吞（客户端写全部
/// 沉没）。客户端 TCP 永远「已建立且静默」（TLS 会话悬挂、无 EOF、无
/// RST），复现现场 mihomo 毒化五元组的净效果：relay server 存活，member
/// 的 relay 客户端却永远握不上新手。这是 A-反向活锁的关键环境形态——
/// iroh 的 relay 发送队列照常吞 QUIC Initial（本地写成功、永不抵达），
/// 走 relay 选中路径的半开连接连 deliberate close 都永不排干。
async fn spawn_blackhole_proxy(
    upstream: std::net::SocketAddr,
) -> (u16, tokio::sync::watch::Sender<bool>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        while let Ok((down, _)) = listener.accept().await {
            if *rx.borrow() {
                // 黑洞：只读丢弃，不接上游、不发 FIN（客户端握手悬挂）
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt as _;
                    let mut down = down;
                    let mut buf = [0u8; 4096];
                    loop {
                        match tokio::time::timeout(Duration::from_secs(30), down.read(&mut buf))
                            .await
                        {
                            Ok(Ok(0) | Err(_)) | Err(_) => break,
                            Ok(Ok(_)) => continue,
                        }
                    }
                });
                continue;
            }
            let up = match tokio::net::TcpStream::connect(upstream).await {
                Ok(u) => u,
                Err(_) => continue,
            };
            // 双向透传（split 半工：黑洞置位后上游→客户端即停但不 close
            // 客户端 socket——无 FIN；客户端→上游照读照吞）
            use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
            let (mut dr, mut dw) = down.into_split();
            let (mut ur, mut uw) = up.into_split();
            let rx_u = rx.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match tokio::time::timeout(Duration::from_secs(120), ur.read(&mut buf)).await {
                        Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                        Ok(Ok(n)) => {
                            if *rx_u.borrow() {
                                break; // 黑洞：客户端不再收到服务端字节
                            }
                            if dw.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            let rx_d = rx.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                loop {
                    match dr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if *rx_d.borrow() {
                                continue; // 黑洞：吞
                            }
                            if uw.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    (port, tx)
}

/// 现场缺陷 A-反向（2026-09-30 第二轮实证，iMac kill -9 同命令重启、mini
/// 存活不动）：member 存活，其 iroh 主 endpoint 上 root NodeId 的已解析
/// 状态停留 relay 路径（era-1 会话经 relay 建立），而 member 的 relay 客户端
/// TCP 被环境毒化（黑洞——连接建立但字节单向沉没，退避重连永不成）。
/// 此后 root 同 key 重入（新进程、新 endpoint），member 的重拨必须经直连
/// 候选有界收敛。
///
/// 修复前形态：direct-only 候选在主 endpoint 上同样零出站——QUIC Initial
/// 被 RemoteStateActor 路由进已选中的 relay 路径（发往黑洞 TCP，本地写
/// 成功、永不抵达），8s 拨号硬上界反复触发、redial 无限重演 relay-first
/// 停滞（现场 curl 19090 连续 150s 全 500；tcpdump 实证 3341 零出站）。
///
/// era-1 会话必须纯 relay（root 不 advertise 直连、member 无 known_addrs），
/// 否则回环直连会被路径选择器选中，复现不了「残留 relay 选中路径」。
#[test]
fn reverse_rejoin_survivor_member_converges_over_direct() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        let tls = self_signed_tls();
        // 真 relay server（全程存活）+ 前置黑洞代理（era-1 透传，era-2 吞字）
        let relay_port = reserve_closed_tcp_port();
        let _server = spawn_relay_on(relay_port, &tls).await;
        let (proxy_port, blackhole) =
            spawn_blackhole_proxy(std::net::SocketAddr::from(([127, 0, 0, 1], relay_port))).await;
        let relay_url = relay_url_for(proxy_port);

        let port_a = reserve_loopback_udp_port();
        let dir_a = tempfile::tempdir().unwrap();

        // era-1 root（a）：独立线程 + 独立 runtime——线程返回即 runtime 整体
        // 丢弃，等价 kill -9（无 close 帧；bind 端口随内核释放供同 key 重入
        // 者重绑——与 crash_rejoin.rs 的 b1 同法）。
        let (tx_ids, rx_ids) = tokio::sync::oneshot::channel::<(String, String)>();
        let (tx_token, rx_token) = tokio::sync::oneshot::channel::<String>();
        let (tx_crash, rx_crash) = tokio::sync::oneshot::channel::<()>();
        let cfg_a_dir = dir_a.path().to_owned();
        let relay_url_a = relay_url.clone();
        let cert_a = tls.cert_pem.clone();
        let crash_thread = std::thread::spawn(move || {
            let crash_rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            crash_rt.block_on(async move {
                let cfg = FabricConfig {
                    data_dir: cfg_a_dir,
                    relay: RelayConfig::Custom(vec![relay_url_a]),
                    // era-1 纯 relay：不 advertise 直连，member 不得提前习得 IP
                    advertise_addrs: Vec::new(),
                    secret: SecretInjection::Default,
                    http_proxy: dweb_fabric::HttpProxyConfig::None,
                    join_timeout_ms: 8_000,
                    relay_tls_trust: RelayTlsTrust::CustomPem(cert_a),
                    bind_addr: Some(format!("127.0.0.1:{port_a}")),
                };
                let a = Fabric::create_root(cfg).await.expect("era-1 root fabric");
                wait_relay_online(&a, "era-1 root").await;
                let token = a
                    .invite(Duration::from_secs(600).as_millis() as u64, None)
                    .await
                    .expect("era-1 invite");
                let _ = tx_ids.send((a.fabric_id_hex().await, a.endpoint_id()));
                let _ = tx_token.send(token);
                // 停车等崩溃信号；返回即丢弃（故意不 shutdown）
                let _ = rx_crash.await;
            });
        });
        let (fabric_id, a_id) = rx_ids.await.expect("era-1 ids");
        let token = rx_token.await.expect("era-1 token");

        // member（b，主 runtime，全程存活——A-反向的「幸存方」）
        let dir_b = tempfile::tempdir().unwrap();
        let b = Fabric::attach(
            cfg(&dir_b, vec![relay_url.clone()], tls.cert_pem.clone()),
            &fabric_id,
        )
        .await
        .expect("member fabric");
        wait_relay_online(&b, "member").await;
        b.join(&token).await.expect("member join");
        // era-1 会话经 relay 建立（b 侧无任何直连候选，必然 relay 路径）
        b.connect(&a_id).await.expect("era-1 connect via relay");

        // era-1b：member 习得 root 直连候选（模拟现场 known_addrs 健康期
        // 落盘——回落资本）。既有 relay 会话不动，主 endpoint 上 root 的
        // 选中路径保持 relay。
        b.add_known_addr(&a_id, format!("127.0.0.1:{port_a}"))
            .await
            .expect("learn direct addr");

        // 环境毒化（现场等价：mihomo 毒化五元组）：黑洞置位——既有 relay
        // TCP 立断，重连握手悬挂。relay server 本身存活。
        blackhole.send_replace(true);
        tokio::time::sleep(Duration::from_secs(2)).await;

        // root 崩溃（线程返回，无 close 帧）+ 尸体窗口成形。relay 路径的
        // 半开连接无 close 通知（supervisor 等 conn.closed() 不触发；rx 静默
        // 尸检是访问时被动触发）——这正是现场坏状态：陈旧 canonical 与
        // 滞留 remote 状态要靠下一次业务拨号来暴露。
        let _ = tx_crash.send(());
        crash_thread
            .join()
            .expect("era-1 root thread exits (crash)");
        tokio::time::sleep(Duration::from_secs(1)).await;

        // 幸存方业务层先把 era-1 会话作废（现场是 keepalive/尸检清掉 canonical
        // 后请求路径重新拨号；relay 路径静默死亡不发 close 通知，cargo 里以
        // 显式 disconnect 等价达成——注意静默 TCP 让 facade 快路径仍把 era-1
        // 连接视作存活，不断开则后续 connect 秒回 Ok 假象）
        let _ = b.disconnect(&a_id).await;

        // 现场坏状态诱因（真双机实证「被 abandon 的半开拨号卡该 NodeId 后续
        // 拨号」）：root 已崩、relay 客户端搁浅窗口内的拨号停摆、被硬上界
        // 放弃——主 endpoint 上留下该 NodeId 的 pending 拨号（现场此态自我
        // 续期 150s+：每次 redial 在 noq 自超时前再留一个新的）。必须在直连
        // 不可达窗口内做（root 已崩、relay 黑洞），且 a2 要在 abandon 后
        // 立即就位——era-2 root 用 Disabled relay（免 10s relay 沉降等待，
        // attach 即绑端口；本测试的收敛面是 member 侧直连，root 侧 relay
        // 与否无关）。
        let jam_started = std::time::Instant::now();
        let jam = b.connect(&a_id).await;
        eprintln!("A-反向 jam 诱因拨号: {jam:?} @ {:?}", jam_started.elapsed());

        // root 同 key 重入（attach 同目录同 fabric；重绑同端口——现场同命令
        // 重启语义）。era-2 advertise 直连（现场重启命令即如此）。
        let cfg_a2 = FabricConfig {
            data_dir: dir_a.path().to_owned(),
            relay: RelayConfig::Disabled,
            advertise_addrs: vec![format!("127.0.0.1:{port_a}")],
            secret: SecretInjection::Default,
            http_proxy: dweb_fabric::HttpProxyConfig::None,
            join_timeout_ms: 8_000,
            relay_tls_trust: RelayTlsTrust::PlatformRoot,
            bind_addr: Some(format!("127.0.0.1:{port_a}")),
        };
        let a2 = Fabric::attach(cfg_a2, &fabric_id)
            .await
            .expect("restarted root");

        // era-2 root 侧会话受理循环（member 的 INIT 需要落点；roster 已随
        // data_dir 持久化，is_member 立即成立，等待循环仅为防御）。
        // 受理的 Session 经 channel 送出由测试主体持有——provider 侧提前
        // drop 会把刚建立的会话连同传输一起关闭（消息断言的前提）。
        let b_id = b.endpoint_id();
        let (tx_held, mut rx_held) =
            tokio::sync::mpsc::channel::<dweb_fabric::continuity::session::Session>(4);
        let provider = a2.clone();
        let provider_b_peer = b_id.clone();
        let _provider_task = tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            loop {
                if provider.is_member(&provider_b_peer).await.unwrap_or(false) {
                    break;
                }
                assert!(tokio::time::Instant::now() < deadline, "roster 未恢复");
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            if let Ok(s) = dweb_fabric::continuity::session::accept_any(
                &provider,
                &provider_b_peer,
                dweb_fabric::continuity::session::SessionOptions::default(),
            )
            .await
            {
                let _ = tx_held.send(s).await;
            }
        });

        // 收敛判据（现场验收 ≤30s 的 cargo 镜像，留 5s 裕量）：member 侧重开
        // 会话必须在 25s 内成功——relay 客户端死窗口内经直连收敛。
        let started = std::time::Instant::now();
        let sess = tokio::time::timeout(
            Duration::from_secs(25),
            dweb_fabric::continuity::session::open_session(
                &b,
                &a_id,
                dweb_fabric::continuity::session::SessionOptions::default(),
            ),
        )
        .await
        .expect("A-反向：member 重拨必须有界收敛（≤25s；不得 relay-first 无限重演）")
        .expect("open_session 成功");
        let elapsed = started.elapsed();
        eprintln!("A-反向 open_session 收敛耗时: {elapsed:?}");
        assert!(
            elapsed <= Duration::from_secs(25),
            "收敛耗时 {elapsed:?} 超界"
        );
        // member 侧会话句柄保持存活至收尾（提前 drop 会连带关会话）
        let _sess = sess;

        // 在途证明：era-2 root 侧受理到会话（INIT/OK 全往返——真实传输面；
        // provider 句柄由测试主体持有至收尾）
        let _held = tokio::time::timeout(Duration::from_secs(10), rx_held.recv())
            .await
            .expect("era-2 root 受理 member 会话（INIT 往返）")
            .expect("provider task 存活");

        a2.shutdown().await.expect("shutdown a2");
        b.shutdown().await.expect("shutdown b");
    });
}
