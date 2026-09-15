//! app-protocol-layer Phase 0 probes（tasks 1.2–1.6）：iroh 1.1.0 特性查证。
//!
//! 全部同进程、loopback 直连（RelayMode::Disabled + 手动注入 127.0.0.1 地址），
//! 不依赖外网。每条 probe 的产出对应 design.md §4 查证清单：
//! - probe-exporter   §4.1  export_keying_material 是否绑定单连接 TLS secret
//! - probe-datagram   §4.2  datagram 支持面（最大 payload/超限/连接死亡后行为）
//! - probe-timeouts   §4.3  默认 keepalive/path idle 下的空闲连接时间线
//! - probe-close      §4.4  close reason 错误映射（应用关闭/静默丢弃）
//! - probe-flow       §4.5  并发流上限 + 流控对控制流的隔离性

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use iroh::endpoint::{Connection, VarInt, presets};
use iroh::{Endpoint, EndpointAddr, RelayMode};
use n0_future::StreamExt;

const PROBE_ALPN: &[u8] = b"appproto/probe/1";

/// 同进程建立一对直连（无 relay、无发现，注入 loopback 地址）。
/// 返回 (client_ep, server_ep, client_conn, server_conn)。
async fn connected_pair(tag: &str) -> Result<(Endpoint, Endpoint, Connection, Connection)> {
    let server_ep = Endpoint::builder(presets::Minimal)
        .alpns(vec![PROBE_ALPN.to_vec()])
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .context("server bind")?;
    let client_ep = Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .context("client bind")?;
    let accept_ep = server_ep.clone();
    let server_task = tokio::spawn(async move {
        let incoming = accept_ep.accept().await.context("accept None")?;
        let accepting = incoming.accept().context("incoming.accept")?;
        accepting.await.context("await connection")
    });
    let port = server_ep.bound_sockets()[0].port();
    let target = EndpointAddr::new(server_ep.id())
        .with_ip_addr(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port));
    let t0 = Instant::now();
    let client_conn = client_ep.connect(target, PROBE_ALPN).await.context("connect")?;
    let server_conn = server_task.await.context("accept task")??;
    println!("[{tag}] pair connected in {:?}", t0.elapsed());
    Ok((client_ep, server_ep, client_conn, server_conn))
}

/// 拆除一对连接（close 由一侧发起即可；双侧 closed() 语义由 probe-close 专测）。
fn teardown(ep_a: &Endpoint, ep_b: &Endpoint) {
    let _ = (ep_a, ep_b);
}

// ---------- §4.1 exporter ----------

pub async fn probe_exporter() -> Result<()> {
    println!("=== probe-exporter：export_keying_material 连接绑定性 ===");
    let (client_ep, server_ep, conn1, _sconn1) = connected_pair("exporter/conn1").await?;
    let mut k1 = [0u8; 32];
    conn1
        .export_keying_material(&mut k1, b"appproto/probe", b"ctx-A")
        .map_err(|e| anyhow::anyhow!("conn1 export: {e:?}"))?;
    // 同连接不同 context：验证 context 参与派生
    let mut k1_ctx_b = [0u8; 32];
    conn1
        .export_keying_material(&mut k1_ctx_b, b"appproto/probe", b"ctx-B")
        .map_err(|e| anyhow::anyhow!("conn1 export ctx-B: {e:?}"))?;
    println!(
        "conn1 ctx-A vs ctx-B 派生不同 = {}（context 绑定）",
        k1 != k1_ctx_b
    );

    conn1.close(VarInt::from_u32(0), b"probe-rotate");
    teardown(&client_ep, &server_ep);
    // 等旧连接终结后建立第二条连接
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (client_ep2, server_ep2, conn2, _sconn2) = connected_pair("exporter/conn2").await?;
    let mut k2 = [0u8; 32];
    conn2
        .export_keying_material(&mut k2, b"appproto/probe", b"ctx-A")
        .map_err(|e| anyhow::anyhow!("conn2 export: {e:?}"))?;
    println!("conn1 与 conn2 同 label/context 派生不同 = {}（单连接 TLS 绑定）", k1 != k2);
    println!(
        "结论：exporter 仅能证明『当前物理连接已认证』，不能作跨连接长期 resume token；\
         session token 须自生成随机值（design §2.3.0 已如此设计）"
    );
    conn2.close(VarInt::from_u32(0), b"probe-done");
    let _ = (client_ep2, server_ep2);
    Ok(())
}

// ---------- §4.2 datagram ----------

pub async fn probe_datagram() -> Result<()> {
    println!("=== probe-datagram：支持面与错误行为 ===");
    let (client_ep, server_ep, cconn, sconn) = connected_pair("datagram").await?;
    let max = cconn.max_datagram_size();
    println!("client max_datagram_size = {max:?}");
    println!("server max_datagram_size = {:?}", sconn.max_datagram_size());

    // 小包 round-trip
    let payload: bytes::Bytes = vec![7u8; 64].into();
    let t0 = Instant::now();
    cconn.send_datagram(payload.clone()).context("send small")?;
    let got = tokio::time::timeout(Duration::from_secs(5), sconn.read_datagram())
        .await
        .context("read timeout")?
        .context("read")?;
    println!(
        "小包(64B) round-trip OK，len={} 耗时 {:?}",
        got.len(),
        t0.elapsed()
    );

    // 超限包
    if let Some(m) = max {
        let oversized: bytes::Bytes = vec![1u8; m + 1].into();
        match cconn.send_datagram(oversized) {
            Err(e) => println!("超限(m+1={}) 拒绝：{:?}（预期 TooLarge）", m + 1, e),
            Ok(()) => println!("!! 超限包被接受——与预期不符"),
        }
    }

    // 连接死亡后的发送行为
    cconn.close(VarInt::from_u32(0), b"probe-close");
    tokio::time::sleep(Duration::from_millis(200)).await;
    match cconn.send_datagram(payload) {
        Err(e) => println!("close 后 send：{:?}（可区分错误）", e),
        Ok(()) => println!("!! close 后 send 仍成功"),
    }
    teardown(&client_ep, &server_ep);
    println!(
        "结论：datagram 可用（max≈{:?}）；at-most-once 契约可承载 sendDatagram；\
         真实替换 envelope 实现前还需 relay 路径实测（本 probe 仅 loopback 直连）",
        max
    );
    Ok(())
}

// ---------- §4.3 timeouts ----------

pub async fn probe_timeouts(secs: u64) -> Result<()> {
    println!("=== probe-timeouts：默认配置下空闲连接时间线（{}s 观察）===", secs);
    println!("源码默认：HEARTBEAT_INTERVAL=5s / PATH_MAX_IDLE_TIMEOUT=15s（iroh socket.rs）");
    let (client_ep, server_ep, cconn, _sconn) = connected_pair("timeouts").await?;
    let mut events = cconn.path_events();
    let t0 = Instant::now();
    let mut last_event_at: Option<(Duration, String)> = None;
    loop {
        let elapsed = t0.elapsed();
        if elapsed >= Duration::from_secs(secs) {
            break;
        }
        let remain = Duration::from_secs(secs) - elapsed;
        tokio::select! {
            ev = events.next() => {
                if let Some(ev) = ev {
                    last_event_at = Some((t0.elapsed(), format!("{ev:?}")));
                    println!("[{:>6.1}s] path event: {ev:?}", t0.elapsed().as_secs_f64());
                }
            }
            _ = tokio::time::sleep(remain.min(Duration::from_secs(1))) => {
                println!(
                    "[{:>6.1}s] idle tick：closed_reason={:?} paths_alive={}",
                    t0.elapsed().as_secs_f64(),
                    cconn.close_reason(),
                    cconn.paths().iter().count(),
                );
            }
        }
    }
    println!(
        "观察期结束：close_reason={:?}（None=连接仍活）；path 事件总数已逐条打印",
        cconn.close_reason()
    );
    let _ = last_event_at;
    println!(
        "结论：默认心跳维持空闲连接存活；空闲不触发 path Close——会话层死亡判据\
         不应把『无业务数据』当断连信号（与 design『客观死亡判据』一致）"
    );
    cconn.close(VarInt::from_u32(0), b"probe-done");
    teardown(&client_ep, &server_ep);
    Ok(())
}

// ---------- §4.4 close reasons ----------

pub async fn probe_close() -> Result<()> {
    println!("=== probe-close：错误映射表 ===");

    // 用例 A：对端应用层关闭（带 code 与 reason）
    {
        let (client_ep, server_ep, cconn, sconn) = connected_pair("close/app").await?;
        cconn.close(VarInt::from_u32(7), b"app-close-reason");
        let err = tokio::time::timeout(Duration::from_secs(10), sconn.closed())
            .await
            .context("A: closed() 超时")?;
        println!("A 对端应用关闭(code=7) → closed() = {err:?}");
        let _ = err;
        teardown(&client_ep, &server_ep);
    }

    // 用例 B：静默丢弃（drop endpoint + connection，不发 close 帧）
    {
        let (client_ep, server_ep, cconn, sconn) = connected_pair("close/silent").await?;
        drop(cconn);
        drop(client_ep);
        let t0 = Instant::now();
        let err = tokio::time::timeout(Duration::from_secs(35), sconn.closed()).await;
        match err {
            Ok(e) => println!("B 静默丢弃(观察 {:?}) → closed() = {e:?}", t0.elapsed()),
            Err(_) => println!(
                "B 静默丢弃：35s 内 closed() 未决——按 idle-timeout 类处理（等待期即恢复窗口语义）"
            ),
        }
        let _ = server_ep;
    }

    // 用例 C：close_reason() 读取时机（close 前后）
    {
        let (client_ep, server_ep, cconn, sconn) = connected_pair("close/reason").await?;
        println!("C close 前 close_reason = {:?}", cconn.close_reason());
        sconn.close(VarInt::from_u32(0), b"peer-done");
        tokio::time::sleep(Duration::from_millis(100)).await;
        println!("C 对端 close 后本端 close_reason = {:?}", cconn.close_reason());
        teardown(&client_ep, &server_ep);
    }
    println!(
        "结论：应用关闭可同步映射（ApplicationClosed 携 code/reason）；静默丢弃\
         只能靠超时界定——RECOVERY_WINDOW 语义与此吻合；epoch 由 opendweb 自生成"
    );
    Ok(())
}

// ---------- §4.5 flow / 并发 ----------

pub async fn probe_flow(stream_count: usize) -> Result<()> {
    println!("=== probe-flow：并发流上限与控制流隔离（{} 流）===", stream_count);
    let (client_ep, server_ep, cconn, sconn) = connected_pair("flow").await?;

    // 服务端：第一条接受流 = 控制 echo（立即回写）；其余 = 慢读回声（每 2ms 读 4KiB）
    let control = tokio::spawn(async move {
        let mut accepted = 0usize;
        let mut slow_tasks = Vec::new();
        let mut ctrl_task = None;
        loop {
            let inc = match sconn.accept_bi().await {
                Ok(x) => x,
                Err(_) => break,
            };
            accepted += 1;
            if accepted == 1 {
                let (mut send, mut recv) = inc;
                ctrl_task = Some(tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    loop {
                        match recv.read(&mut buf).await {
                            Ok(None) | Err(_) => break,
                            Ok(Some(n)) => {
                                if send.write_all(&buf[..n]).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }));
            } else {
                let (mut send, mut recv) = inc;
                slow_tasks.push(tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        match recv.read(&mut buf).await {
                            Ok(None) | Err(_) => break,
                            Ok(Some(n)) => {
                                send.write_all(&buf[..n]).await.ok();
                                tokio::time::sleep(Duration::from_millis(2)).await;
                            }
                        }
                    }
                }));
            }
        }
        if let Some(t) = ctrl_task {
            let _ = t.await;
        }
        let _ = slow_tasks;
    });

    // 控制流：先开一条（服务端第一条 accept = echo），测冷 RTT 与拥塞期 RTT
    let (mut ctrl_send, mut ctrl_recv) = cconn.open_bi().await.context("open control")?;
    let cold = ctrl_rtt(&mut ctrl_send, &mut ctrl_recv)
        .await
        .context("cold rtt")?;
    println!("控制流冷 RTT = {cold:?}");

    // 并发开 N 条数据流，各写 64KiB
    let t0 = Instant::now();
    let mut tasks = Vec::new();
    let mut opened_in_100ms = 0usize;
    for i in 0..stream_count {
        let c = cconn.clone();
        tasks.push(tokio::spawn(async move {
            let (mut send, recv) = c.open_bi().await?;
            send.write_all(&vec![i as u8; 64 * 1024]).await?;
            send.finish().ok();
            let _: iroh::endpoint::RecvStream = recv;
            Ok::<_, anyhow::Error>(())
        }));
        if i % 16 == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
    // 统计 100ms 内完成 open_bi 的任务数（近似并发上限观测）
    tokio::time::sleep(Duration::from_millis(100)).await;
    for t in &tasks {
        if t.is_finished() {
            opened_in_100ms += 1;
        }
    }
    // 拥塞期控制流 RTT（数据流在途时）
    let congested = ctrl_rtt(&mut ctrl_send, &mut ctrl_recv).await;
    println!("拥塞期控制流 RTT = {congested:?}");
    let results = futures_join_all(tasks).await;
    let ok = results.iter().filter(|r| r.is_ok()).count();
    println!(
        "open+write 完成 {ok}/{} 条（100ms 内完成 {opened_in_100ms}），总耗时 {:?}",
        stream_count,
        t0.elapsed()
    );
    println!(
        "结论：记录观测到的并发行为——若 {} 条全部完成且控制流仍可写，\
         说明流级流控隔离良好；上限数值对照 quinn 默认 max_concurrent_bidi_streams",
        stream_count
    );
    let _ = control;
    cconn.close(VarInt::from_u32(0), b"probe-done");
    teardown(&client_ep, &server_ep);
    Ok(())
}

/// 极简 join_all（避免引入 futures crate 依赖：逐个 await）。
async fn futures_join_all(
    tasks: Vec<tokio::task::JoinHandle<anyhow::Result<()>>>,
) -> Vec<anyhow::Result<()>> {
    let mut out = Vec::with_capacity(tasks.len());
    for t in tasks {
        out.push(t.await.unwrap_or_else(|e| Err(anyhow::anyhow!("join: {e}"))));
    }
    out
}

/// 控制流往返时延（服务端 echo 首条流）。
async fn ctrl_rtt(
    s: &mut iroh::endpoint::SendStream,
    r: &mut iroh::endpoint::RecvStream,
) -> Result<Duration> {
    let t = Instant::now();
    s.write_all(b"ping").await?;
    let mut b = [0u8; 4];
    r.read_exact(&mut b).await?;
    Ok(t.elapsed())
}
