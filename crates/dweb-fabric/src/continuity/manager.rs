//! continuity 连接管理（app-protocol-layer Phase 1 task 2.1/2.2）。
//!
//! 职责（design §1.1/§3.1）：
//! - 以独立 ALPN [`super::ALPN_CONTINUITY`] 维护 per-peer 的 continuity 连接
//!   （与 legacy envelope 连接物理隔离）；
//! - **epoch 单调**：每次采纳新连接 epoch+1；
//! - **winner 规则**（双端同拨收敛）：既有连接与新连接并存时，保留发起方
//!   EndpointId 较小者——双端独立可计算，无仲裁往返（design §2.3.0 同源思想）；
//! - **意外死亡 → 自动重连**（1s 起倍增、上限 30s，复用既有 worker 语义）；
//! - **状态只进 watch**：死亡/重连/采纳只改 `ContinuityState` 快照，
//!   **不发 FabricEvent**——「瞬断不直达应用」在本层的实现。
//!
//! 显式关闭语义：deliberate 标记的关闭（winner 替换 / shutdown）不触发重连。

use std::collections::HashMap;
use std::sync::Arc;

use iroh::EndpointAddr;

use crate::fabric::{Fabric, FabricError, FabricInner, register_lifecycle_task};
use crate::identity::{EndpointId, endpoint_id_display, endpoint_id_parse};
use crate::session::{LinkStatus, SessionError};

use super::state::{ConnHandle, ConnectionPhase};
use super::transport::ContinuityTransport;

/// 退避参数（与 session_reconnect_worker 同源语义）。
const BACKOFF_START: std::time::Duration = std::time::Duration::from_secs(1);
const BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(30);

/// 拨号 single-flight（per-peer，Semaphore(1) 计数型——无 Notify 注册时序
/// 竞态；dual-dial 实证卡死根因后弃 Notify）。
#[derive(Default)]
pub(crate) struct DialingGuard {
    inner: tokio::sync::Mutex<HashMap<EndpointId, std::sync::Arc<tokio::sync::Semaphore>>>,
}

/// 连接已死（非阻塞判定）：`close_reason` 仅在连接终结后为 Some——QUIC 半开
/// （对端崩溃、无 close 帧）时由 iroh 心跳/空闲超时兜底，期间此检查为 false。
/// 真双机验收实证（2026-09-30）：对端 kill -9 后同 key 重启再拨，存活方槽位
/// 里的死句柄在传输层死亡被观测到之前仍是「既有时续」——winner 规则若按
/// initiator 比较裁决，会把新活连接判负掐掉（candidate.initiator ==
/// old.initiator，`<` 恒 false），重加入者的每个会话都被 connection lost。
fn conn_is_dead(h: &ConnHandle) -> bool {
    h.conn.close_reason().is_some()
}

/// 尸体判定：传输层已判死，或 rx 静默超过两个心跳周期（正向活性信号缺失）。
/// 阈值常量（[`super::state::CORPSE_SILENCE`]）与会话通道层共用（E1′ 硬化）。
fn is_corpse(h: &ConnHandle) -> bool {
    conn_is_dead(h) || h.rx_silent_for() > super::state::CORPSE_SILENCE
}

impl DialingGuard {
    /// 取该 peer 的拨号许可（无人拨号时立即获得；有在途拨号则排队等其
    /// 完成后再获得——获得者复查 fast-path 决定是否还需拨号）。
    pub(crate) async fn permit(&self, peer: &EndpointId) -> tokio::sync::OwnedSemaphorePermit {
        let sem = {
            let mut map = self.inner.lock().await;
            Arc::clone(
                map.entry(*peer)
                    .or_insert_with(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1))),
            )
        };
        sem.acquire_owned()
            .await
            .expect("dialing semaphore 永不 close")
    }
}

/// 确保 peer 存在已采纳的 continuity 连接；返回其句柄。
/// fast path：活跃连接直接返回；否则 member 门控 + 拨号 + winner 采纳。
pub(crate) async fn ensure_connection(
    inner: &Arc<FabricInner>,
    remote: &EndpointId,
) -> Result<Arc<ConnHandle>, FabricError> {
    loop {
        if let Some(h) = live_active(inner, remote).await {
            return Ok(h);
        }
        if inner.lifecycle_closing() {
            return Err(FabricError::Session(SessionError::Connect(
                "fabric is shutting down".into(),
            )));
        }
        // 拿到许可（在途拨号者完成后）后复查 fast-path：他人已完成则直接复用
        let _permit = inner.continuity_dialing.permit(remote).await;
        if let Some(h) = live_active(inner, remote).await {
            return Ok(h);
        }
        if inner.lifecycle_closing() {
            return Err(FabricError::Session(SessionError::Connect(
                "fabric is shutting down".into(),
            )));
        }
        dial_and_adopt(inner, remote).await?;
        // 采纳成功：loop 头 fast-path 取回句柄
    }
}

/// `ContinuityState::active` 的活性过滤：传输层已终结（close_reason=Some）
/// 或 rx 静默超阈值（尸体）的槽位句柄按不存在处理，并顺手摘除——死句柄
/// 短路的 fast-path 曾让重加入会话整个死亡检测窗口内无路可走（真双机
/// 验收实证 2026-09-30）。
async fn live_active(inner: &Arc<FabricInner>, remote: &EndpointId) -> Option<Arc<ConnHandle>> {
    let h = inner.continuity.active(remote).await?;
    if is_corpse(&h) {
        // 传输层已判死/静默超阈：摘除槽位（supervisor 迟到时由 fence 分支
        // 静默退出）
        h.close_deliberate(b"evicted-dead");
        inner.continuity.clear_if_current(remote, &h).await;
        return None;
    }
    Some(h)
}

/// 拨号 + winner 采纳 + supervisor 派生。
async fn dial_and_adopt(
    inner: &Arc<FabricInner>,
    remote: &EndpointId,
) -> Result<Arc<ConnHandle>, FabricError> {
    let state = &inner.continuity;
    state
        .set_phase(remote, ConnectionPhase::Connecting, None, false)
        .await;
    // member 门控（与 regular ALPN 接受侧同源语义）
    {
        let roster = inner.roster.lock().await;
        if !roster.is_member(remote, now_ms()) {
            let err = FabricError::Session(SessionError::NotMember(endpoint_id_display(remote)));
            state
                .set_phase(
                    remote,
                    ConnectionPhase::Disconnected,
                    Some("not a member".into()),
                    false,
                )
                .await;
            return Err(err);
        }
    }
    let addr = endpoint_addr_for(inner, remote).await?;
    // [H8] deferred 未 start：明确 NotStarted 错误（网络操作前置）。
    let endpoint = inner.require_endpoint()?;
    // 直连-only 回落候选：iroh 拨号停在 relay 相位不回落 direct（真双机验收
    // 实证 2026-09-30——relay 客户端退避期间全量候选拨号挂起至自身超时，
    // 与回环 relay 停滞同族）。relay 实测不可用（罚期/快照离线/实时客户端
    // 未连接）且有 IP 候选时，**首选独立 endpoint 直连**（A-反向实证
    // 2026-09-30 第二轮：主 endpoint 上该 NodeId 的 relay 选中路径/尸体
    // 连接/abandoned pending 拨号会把直连候选也饿死——直连必须换全新
    // endpoint 拨）；失败再换另一组候选（反向亦然）。
    let direct_only = Fabric::strip_relay_candidates(&addr);
    let prefer_direct = !Fabric::relay_snapshot_online(inner) && !direct_only.addrs.is_empty();
    // 拨号硬上界（真双机验收实证 2026-09-30）：iroh 停在 relay 相位的
    // connect 不自报错误——relay 客户端退避期间可挂起 ~60s。
    const DIAL_BOUND: std::time::Duration = std::time::Duration::from_secs(8);
    // 两步拨号（与 facade connect_dial 同构）：
    // - prefer_direct：[直连, 主 endpoint 全量]
    // - 否则：[主 endpoint 全量, 直连回落]（无直连候选时两步全量）
    // 直连步骤载体按 relay 配置分流：配置了 relay 的 fabric 用**独立
    // endpoint**（主 endpoint 上该 NodeId 的 relay 选中路径/尸体连接/
    // abandoned pending 拨号会把直连候选也饿死——A-反向实证）；Disabled
    // fabric 用主 endpoint direct-only（无 relay 状态可逃，独立 endpoint
    // 反而制造双连接 displacement 抖动）。主 endpoint 停滞（超时）→ relay
    // 配置面进罚期后仍走独立 endpoint 第二步（不受主 endpoint pending-dial
    // 卡死——A-反向活锁修复点）；Disabled 面维持停滞即返旧语义。
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum DialStep {
        ScratchDirect,
        MainDirect,
        MainFull,
    }
    let relay_disabled = matches!(inner.relay, crate::fabric::RelayConfig::Disabled);
    let direct_step = if relay_disabled {
        DialStep::MainDirect
    } else {
        DialStep::ScratchDirect
    };
    let steps: [DialStep; 2] = if direct_only.addrs.is_empty() {
        [DialStep::MainFull, DialStep::MainFull]
    } else if prefer_direct {
        [direct_step, DialStep::MainFull]
    } else {
        [DialStep::MainFull, direct_step]
    };
    let mut last_err: Option<String> = None;
    let mut conn: Option<iroh::endpoint::Connection> = None;
    for (i, step) in steps.iter().enumerate() {
        // shutdown 感知（g3 实证：拨号链变长后须在 lifecycle 关闭后即时退出）
        if inner.lifecycle_closing() {
            state
                .set_phase(
                    remote,
                    ConnectionPhase::Disconnected,
                    Some("fabric is shutting down".into()),
                    false,
                )
                .await;
            return Err(FabricError::Session(SessionError::Connect(
                "fabric is shutting down".into(),
            )));
        }
        let res: Result<iroh::endpoint::Connection, String> = match step {
            DialStep::MainFull => match tokio::time::timeout(
                DIAL_BOUND,
                endpoint.connect(addr.clone(), super::ALPN_CONTINUITY),
            )
            .await
            {
                Ok(Ok(c)) => Ok(c),
                Ok(Err(e)) => Err(format!("{e}")),
                Err(_) => {
                    // 主 endpoint 超时放弃（relay 相位挂起）：进罚期
                    Fabric::enter_relay_dial_penalty(inner).await;
                    if relay_disabled || direct_only.addrs.is_empty() {
                        Err(format!(
                            "dial exceeded {}s bound (relay path stalled)",
                            DIAL_BOUND.as_secs()
                        ))
                    } else {
                        Err(format!(
                            "dial exceeded {}s bound (relay path stalled); falling back to fresh-endpoint direct",
                            DIAL_BOUND.as_secs()
                        ))
                    }
                }
            },
            DialStep::MainDirect => match tokio::time::timeout(
                DIAL_BOUND,
                endpoint.connect(direct_only.clone(), super::ALPN_CONTINUITY),
            )
            .await
            {
                Ok(Ok(c)) => Ok(c),
                Ok(Err(e)) => Err(format!("{e}")),
                Err(_) => {
                    Fabric::enter_relay_dial_penalty(inner).await;
                    Err(format!(
                        "dial exceeded {}s bound (direct candidates stalled)",
                        DIAL_BOUND.as_secs()
                    ))
                }
            },
            DialStep::ScratchDirect => {
                Fabric::direct_dial(inner, &direct_only, super::ALPN_CONTINUITY, DIAL_BOUND).await
            }
        };
        match res {
            Ok(c) => {
                if i > 0
                    && let Some(first) = last_err.take()
                {
                    tracing::debug!(
                        peer = %endpoint_id_display(remote),
                        first = %first,
                        "continuity dial fell back to alternate candidates"
                    );
                }
                conn = Some(c);
                break;
            }
            Err(e) => {
                // 中间步骤失败：若与下一步同型（无直连候选的两步全量）则不再
                // 重试同型拨号
                let next = steps.get(i + 1);
                if next.is_none() || next == Some(step) {
                    last_err = Some(e);
                    break;
                }
                last_err = Some(e);
            }
        }
    }
    let conn = match conn {
        Some(c) => c,
        None => {
            let reason = last_err.unwrap_or_else(|| "dial produced no result".to_owned());
            state
                .set_phase(
                    remote,
                    ConnectionPhase::Disconnected,
                    Some(reason.clone()),
                    false,
                )
                .await;
            // N1 活性修剪：两步拨号计划全败 → 可淘汰地址条目计一次失败
            //（墓地死地址按阈值淘汰；announced 保留）。
            Fabric::note_dial_failure(inner, remote).await;
            return Err(FabricError::Session(SessionError::Connect(reason)));
        }
    };
    // Handshaking 仅在无活跃连接时宣告（对端来连可能已把本端采纳为 Ready——
    // 不得覆盖；dav dual-dial 实证：覆盖后 loser 路径不恢复即永久卡死）
    if inner.continuity.active(remote).await.is_none() {
        state
            .set_phase(remote, ConnectionPhase::Handshaking, None, false)
            .await;
    }
    let handle = Arc::new(ConnHandle::new(conn.clone(), inner.identity.endpoint_id()));
    match adopt_with_winner(inner, remote, handle, true).await {
        Some(h) => Ok(h),
        None => {
            // 被 winner 规则否决（对端已有更小发起方连接）：不算错误，
            // fast-path 复查将取到既有连接
            Ok(inner
                .continuity
                .active(remote)
                .await
                .expect("winner 裁决后必有活跃连接"))
        }
    }
}

/// 接受侧入口（accept loop 的 continuity ALPN 分派）。
pub(crate) async fn register_incoming(
    inner: &Arc<FabricInner>,
    remote: EndpointId,
    conn: iroh::endpoint::Connection,
) {
    let handle = Arc::new(ConnHandle::new(conn, remote));
    let _ = adopt_with_winner(inner, &remote, handle, false).await;
}

/// winner 采纳：无既有 → 安装；并存 → 发起方 EndpointId 较小者胜，
/// 败者 deliberate 关闭。返回胜者句柄（新连接败选时返回既有句柄）。
/// `dialed`：胜者是否为本端拨出（N1 地址学习来源分治——拨出连接的选中
/// 路径对端地址 = 拨号成功验证，DialOk 落盘；对端拨入连接的源地址 =
/// ObservedInbound，**不落盘**：可能是对端 direct-dial 专用 endpoint 的
/// 临时随机端口，E1′ 交叉学习实证其随端点弃置即死）。
/// 真双机验收实证修正（2026-09-30）：
/// - **尸体不参裁**：既有时续的传输层已终结（close_reason=Some）或 rx 静默
///   超两个心跳周期时按无既有时续处理——驱逐（标记 deliberate 使其在途
///   supervisor 静默退出）后采纳新连接。崩溃对端同 key 重加入的每个新连接
///   都曾因尸体占位被 `superseded-by-older-initiator` 掐死。
/// - **平局保持既有**（`<` 不含等号）：同 initiator（同一远端再次来连/本端
///   再次拨出）且既有健康时，新连接判负——拨号方经 fast-path 复用健康既有
///   连接收敛。曾改判新胜（`<=`）造成并行拨号方（open_session 重试 +
///   supervisor 重拨 + 人工 connect）互相换代健康连接的自激 churn（真双机
///   反向验收实证：iMac 重启后 mini 侧 connection lost 连续 ~25s）。重加入
///   场景由尸体驱逐承接，无需平局新胜。
async fn adopt_with_winner(
    inner: &Arc<FabricInner>,
    remote: &EndpointId,
    candidate: Arc<ConnHandle>,
    dialed: bool,
) -> Option<Arc<ConnHandle>> {
    let state = &inner.continuity;
    let existing = state.active(remote).await;
    let existing = match existing {
        Some(old) if is_corpse(&old) => {
            // 尸体驱逐：置 deliberate（迟到的 supervisor 见标记静默退出，
            // 不把新连接的 Ready 状态拉回 Disconnected）+ 摘除槽位。
            old.close_deliberate(b"evicted-dead");
            state.clear_if_current(remote, &old).await;
            None
        }
        other => other,
    };
    let winner = match existing {
        None => candidate,
        Some(old) => {
            if candidate.initiator < old.initiator {
                // 新连接发起方更小：新胜，旧连接让位
                old.close_deliberate(b"superseded-by-newer-initiator");
                candidate
            } else {
                candidate.close_deliberate(b"superseded-by-older-initiator");
                // 败选不改变存活连接；确保相位回到 Ready（拨号流程可能刚写过
                // Handshaking/Connecting）
                state
                    .set_phase(remote, ConnectionPhase::Ready, None, false)
                    .await;
                return Some(old);
            }
        }
    };
    let selected = winner
        .conn
        .paths()
        .iter()
        .find(|p| p.is_selected())
        .map(|p| match p.remote_addr() {
            iroh_base::TransportAddr::Ip(_) => LinkStatus::Direct,
            iroh_base::TransportAddr::Relay(_) => LinkStatus::Relay,
            _ => LinkStatus::Unknown,
        })
        .unwrap_or(LinkStatus::Unknown);
    let path = selected;
    state.adopt(remote, Arc::clone(&winner), path).await;
    // 直连路径学习（N1 来源分治）：本端拨出 = 拨号成功验证（DialOk 落盘，
    // 跨重启存活是对端崩溃/relay 失效时的回落资本）；对端拨入 = 观测源地址
    // （ObservedInbound 不落盘——可能是 scratch 临时端口，TTL/失败修剪）。
    if selected == LinkStatus::Direct {
        Fabric::learn_selected_direct_addr(inner, remote, &winner.conn, dialed).await;
    }
    spawn_supervisor(inner, *remote, Arc::clone(&winner));
    Some(winner)
}

/// 连接监督：死亡 →（非 deliberate）状态翻转 + 退避重连。
/// 真双机验收实证修正（2026-09-30）：supervisor 只为自己代次的句柄翻转状态
/// ——若槽位已被新连接接管（同 key 重加入被采纳），迟到的死亡观测静默退出，
/// 不得把新连接的 handle 摘除、也不得把 phase 拉回 Disconnected（曾造成
/// 尸体死亡事件反复毒化新会话的状态面）。
fn spawn_supervisor(inner: &Arc<FabricInner>, remote: EndpointId, handle: Arc<ConnHandle>) {
    let inner_for_task = Arc::clone(inner);
    let task = tokio::spawn(async move {
        let mut shutdown_rx = inner_for_task.shutdown_done.subscribe();
        tokio::select! {
            _ = shutdown_rx.changed() => return,
            _ = handle.conn.closed() => {}
        }
        if inner_for_task.lifecycle_closing() {
            return;
        }
        if handle.deliberate.load(std::sync::atomic::Ordering::SeqCst) {
            // winner 替换/尸体驱逐：状态由新连接的 adopt 覆盖；这里只退出
            return;
        }
        // 代次 fence 原子收口：槽位已由新连接接管时静默退出（不翻状态、不摘
        // 新柄）——检查+清柄+置相位在同一槽位锁内完成。
        let reason = handle
            .conn
            .close_reason()
            .map(|e| format!("{e}"))
            .unwrap_or_else(|| "connection lost".into());
        if !inner_for_task
            .continuity
            .mark_disconnected_if_current(&remote, &handle, reason)
            .await
        {
            return;
        }
        // 退避重连（可被 shutdown 提前唤醒）
        let mut backoff = BACKOFF_START;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = shutdown_rx.changed() => return,
            }
            if inner_for_task.lifecycle_closing() {
                return;
            }
            match ensure_connection(&inner_for_task, &remote).await {
                Ok(_) => return, // 新连接的 supervisor 接力
                Err(FabricError::Session(SessionError::NotMember(_))) => return,
                Err(_) => backoff = (backoff * 2).min(BACKOFF_MAX),
            }
        }
    });
    if let Some(task) = register_lifecycle_task(&inner.accept_children, task) {
        // registry 已关闭（shutdown 收尾中）：本地收割不留残留
        task.abort();
        futures_nowait(task);
    }
}

/// 非 async 上下文收割（register_lifecycle_task 闭合分支专用）。
fn futures_nowait(task: tokio::task::JoinHandle<()>) {
    let rt = tokio::runtime::Handle::current();
    rt.spawn(async move {
        let _ = task.await;
    });
}

/// 公开入口：在 peer 的当前代次连接上开 continuity 传输。
pub async fn open_transport(
    fabric: &Fabric,
    peer_id: &str,
) -> Result<ContinuityTransport, FabricError> {
    let inner = Arc::clone(&fabric.inner);
    let remote = endpoint_id_parse(peer_id).map_err(FabricError::from)?;
    let handle = ensure_connection(&inner, &remote).await?;
    let epoch = inner.continuity.snapshot(&remote).await.epoch;
    ContinuityTransport::open(&handle.conn, epoch)
        .await
        .map_err(|e| FabricError::Session(SessionError::Connect(format!("{e}"))))
}

/// 公开入口：接受对端在本端采纳连接上打开的 continuity 流（服务端形态）。
pub async fn accept_stream(
    fabric: &Fabric,
    peer_id: &str,
) -> Result<ContinuityTransport, FabricError> {
    let inner = Arc::clone(&fabric.inner);
    let remote = endpoint_id_parse(peer_id).map_err(FabricError::from)?;
    let handle = ensure_connection(&inner, &remote).await?;
    let epoch = inner.continuity.snapshot(&remote).await.epoch;
    let (send, recv) = handle
        .conn
        .accept_bi()
        .await
        .map_err(|e| FabricError::Session(SessionError::Connect(format!("{e}"))))?;
    Ok(ContinuityTransport::from_parts(
        handle.conn.clone(),
        send,
        recv,
        epoch,
    ))
}

/// 公开入口：非故意关闭当前连接（故障注入/强制重拨——supervisor 视为
/// 意外死亡，触发状态翻转与退避重连）。
pub async fn reset(fabric: &Fabric, peer_id: &str) -> Result<(), FabricError> {
    let inner = Arc::clone(&fabric.inner);
    let remote = endpoint_id_parse(peer_id).map_err(FabricError::from)?;
    let handle = inner.continuity.active(&remote).await.ok_or_else(|| {
        FabricError::Session(SessionError::Connect(
            "no active continuity connection".into(),
        ))
    })?;
    handle.conn.close(7u32.into(), b"injected-death");
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 拨号地址推导（复用 Fabric::endpoint_addr_for 的候选合并语义）。
/// N1：候选按「宣告 > 手工 > 近期拨号成功 > 观测」优先序（惰性修剪后）。
async fn endpoint_addr_for(
    inner: &Arc<FabricInner>,
    id: &EndpointId,
) -> Result<EndpointAddr, FabricError> {
    let learned = inner.known_addrs.lock().await.ordered_addrs(id, now_ms());
    let addr = Fabric::merge_dial_candidates(id, &learned, &inner.relay);
    if addr.addrs.is_empty() {
        return Err(FabricError::Session(SessionError::NoAddressingInfo(
            endpoint_id_display(id),
        )));
    }
    Ok(addr)
}
