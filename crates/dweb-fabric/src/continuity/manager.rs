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
        if let Some(h) = inner.continuity.active(remote).await {
            return Ok(h);
        }
        if inner.lifecycle_closing() {
            return Err(FabricError::Session(SessionError::Connect(
                "fabric is shutting down".into(),
            )));
        }
        // 拿到许可（在途拨号者完成后）后复查 fast-path：他人已完成则直接复用
        let _permit = inner.continuity_dialing.permit(remote).await;
        if let Some(h) = inner.continuity.active(remote).await {
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
    let conn = match inner.endpoint.connect(addr, super::ALPN_CONTINUITY).await {
        Ok(c) => c,
        Err(e) => {
            state
                .set_phase(
                    remote,
                    ConnectionPhase::Disconnected,
                    Some(format!("{e}")),
                    false,
                )
                .await;
            return Err(FabricError::Session(SessionError::Connect(format!("{e}"))));
        }
    };
    // Handshaking 仅在无活跃连接时宣告（对端来连可能已把本端采纳为 Ready——
    // 不得覆盖；dav dual-dial 实证：覆盖后 loser 路径不恢复即永久卡死）
    if inner.continuity.active(remote).await.is_none() {
        state
            .set_phase(remote, ConnectionPhase::Handshaking, None, false)
            .await;
    }
    let handle = Arc::new(ConnHandle {
        conn: conn.clone(),
        initiator: inner.identity.endpoint_id(),
        deliberate: std::sync::atomic::AtomicBool::new(false),
    });
    match adopt_with_winner(inner, remote, handle).await {
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
    let handle = Arc::new(ConnHandle {
        conn,
        initiator: remote,
        deliberate: std::sync::atomic::AtomicBool::new(false),
    });
    let _ = adopt_with_winner(inner, &remote, handle).await;
}

/// winner 采纳：无既有 → 安装；并存 → 发起方 EndpointId 较小者胜，
/// 败者 deliberate 关闭。返回胜者句柄（新连接败选时返回既有句柄）。
async fn adopt_with_winner(
    inner: &Arc<FabricInner>,
    remote: &EndpointId,
    candidate: Arc<ConnHandle>,
) -> Option<Arc<ConnHandle>> {
    let state = &inner.continuity;
    let existing = state.active(remote).await;
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
    let path = winner
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
    state.adopt(remote, Arc::clone(&winner), path).await;
    spawn_supervisor(inner, *remote, Arc::clone(&winner));
    Some(winner)
}

/// 连接监督：死亡 →（非 deliberate）状态翻转 + 退避重连。
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
            // winner 替换：状态由新连接的 adopt 覆盖；这里只退出
            return;
        }
        let reason = handle
            .conn
            .close_reason()
            .map(|e| format!("{e}"))
            .unwrap_or_else(|| "connection lost".into());
        inner_for_task
            .continuity
            .set_phase(&remote, ConnectionPhase::Disconnected, Some(reason), true)
            .await;
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
    Ok(ContinuityTransport::from_parts(send, recv, epoch))
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
async fn endpoint_addr_for(
    inner: &Arc<FabricInner>,
    id: &EndpointId,
) -> Result<EndpointAddr, FabricError> {
    let learned = inner
        .known_addrs
        .lock()
        .await
        .get(id)
        .map(|s| s.to_vec())
        .unwrap_or_default();
    let addr = Fabric::merge_dial_candidates(id, &learned, &inner.relay);
    if addr.addrs.is_empty() {
        return Err(FabricError::Session(SessionError::NoAddressingInfo(
            endpoint_id_display(id),
        )));
    }
    Ok(addr)
}
