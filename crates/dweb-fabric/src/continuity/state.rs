//! continuity 连接状态面（app-protocol-layer Phase 1 task 2.1）。
//!
//! 契约：openspec/changes/app-protocol-layer/design.md §3.1——
//! - 每个 peer 一份 `ConnectionStateSnapshot`（phase/epoch/stateSeq/path/
//!   changedAt/reason）；
//! - 状态经 `tokio::sync::watch` 暴露（只存最新快照）：订阅前必须先取
//!   snapshot，watch 天然收敛到最新——「sequence gap → 重拉 snapshot」由
//!   watch 语义免费提供；
//! - epoch 为 **per-peer 单调**（每次采纳新连接 +1）；
//! - 本状态面只服务 continuity 层；legacy `PeerDisconnected` broadcast
//!   不受影响、也不被本层消费（「瞬断不直达应用」由 continuity 连接的
//!   独立生命周期保证——它的死亡/重连只改 watch，不发 FabricEvent）。

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, watch};

use crate::session::LinkStatus;

/// continuity 连接阶段（design §3.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionPhase {
    /// 无连接且未在重试（初始态 / 显式关闭后）。
    Disconnected,
    /// 拨号中（含退避等待）。
    Connecting,
    /// 传输握手进行中（QUIC 已建立、门控/采纳前）。
    Handshaking,
    /// 已采纳为当前代次连接。
    Ready,
    /// shutdown 收尾中。
    Closing,
}

/// 对外快照（design §3.1 ConnectionStateSnapshot 的内核形态；N-API 投影
/// 在 client-sdk 侧另行映射，字段名保持一致）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionStateSnapshot {
    /// 对端 EndpointId（z32 展示串）。
    pub peer_id: String,
    pub phase: ConnectionPhase,
    /// 当前已采纳连接的代次；0 = 尚无。
    pub epoch: u64,
    /// 快照单调序号（订阅者据此检测跳变）。
    pub state_seq: u64,
    pub path: LinkStatus,
    pub changed_at_ms: u64,
    pub reason: Option<String>,
}

/// 被采纳的 continuity 连接句柄（supervisor 与 dialer 共享）。
pub struct ConnHandle {
    pub conn: iroh::endpoint::Connection,
    /// 连接发起方（winner 规则用）：本端拨出 = 本端 id；对端来接 = 对端 id。
    pub initiator: crate::identity::EndpointId,
    /// 主动关闭标记（supervisor 据此区分「换连接」与「意外死亡→重连」）。
    pub deliberate: std::sync::atomic::AtomicBool,
}

impl ConnHandle {
    pub fn close_deliberate(&self, reason: &[u8]) {
        self.deliberate
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.conn.close(0u32.into(), reason);
    }
}

/// 单 peer 槽位。
struct PeerSlot {
    epoch_next: u64,
    seq_next: u64,
    tx: watch::Sender<Arc<ConnectionStateSnapshot>>,
    handle: Option<Arc<ConnHandle>>,
}

/// 状态表（FabricInner 持有）。
#[derive(Default)]
pub struct ContinuityState {
    slots: Mutex<HashMap<crate::identity::EndpointId, PeerSlot>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ContinuityState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取（或惰性建）peer 槽位；返回快照与订阅接收器。
    /// 「snapshot-before-subscribe」：调用方先 snapshot() 后 watch()，
    /// watch 初值即最新——gap 后收敛由 watch 语义保证。
    pub async fn snapshot(
        &self,
        peer: &crate::identity::EndpointId,
    ) -> Arc<ConnectionStateSnapshot> {
        let mut slots = self.slots.lock().await;
        Arc::clone(&*get_slot(&mut slots, peer).tx.borrow())
    }

    pub async fn watch(
        &self,
        peer: &crate::identity::EndpointId,
    ) -> watch::Receiver<Arc<ConnectionStateSnapshot>> {
        let mut slots = self.slots.lock().await;
        get_slot(&mut slots, peer).tx.subscribe()
    }

    /// 当前活跃句柄（无则 None）。
    pub async fn active(&self, peer: &crate::identity::EndpointId) -> Option<Arc<ConnHandle>> {
        let slots = self.slots.lock().await;
        slots.get(peer).and_then(|s| s.handle.clone())
    }

    /// 采纳连接（winner 规则在 manager 层裁决后调用）：epoch+1、phase=Ready。
    pub async fn adopt(
        &self,
        peer: &crate::identity::EndpointId,
        handle: Arc<ConnHandle>,
        path: LinkStatus,
    ) -> u64 {
        let mut slots = self.slots.lock().await;
        let slot = get_slot(&mut slots, peer);
        let epoch = slot.epoch_next;
        slot.epoch_next += 1;
        slot.handle = Some(Arc::clone(&handle));
        slot.tx.send_modify(|snap| {
            let s = Arc::make_mut(snap);
            s.phase = ConnectionPhase::Ready;
            s.epoch = epoch;
            s.path = path;
            s.changed_at_ms = now_ms();
            s.reason = None;
            s.state_seq = slot.seq_next;
            slot.seq_next += 1;
        });
        epoch
    }

    /// 置阶段（不改 epoch/handle；handle=None 时可同时清除）。
    pub async fn set_phase(
        &self,
        peer: &crate::identity::EndpointId,
        phase: ConnectionPhase,
        reason: Option<String>,
        clear_handle: bool,
    ) {
        let mut slots = self.slots.lock().await;
        let slot = get_slot(&mut slots, peer);
        if clear_handle {
            slot.handle = None;
        }
        slot.tx.send_modify(|snap| {
            let s = Arc::make_mut(snap);
            s.phase = phase;
            s.reason = reason;
            s.changed_at_ms = now_ms();
            s.state_seq = slot.seq_next;
            slot.seq_next += 1;
        });
    }

    /// shutdown 收口：全部句柄 deliberate 关闭 + 置 Closing。
    pub async fn close_all(&self, phase: ConnectionPhase, reason: &str) {
        let mut slots = self.slots.lock().await;
        for slot in slots.values_mut() {
            if let Some(h) = slot.handle.take() {
                h.close_deliberate(reason.as_bytes());
            }
            slot.tx.send_modify(|snap| {
                let s = Arc::make_mut(snap);
                s.phase = phase;
                s.reason = Some(reason.to_string());
                s.changed_at_ms = now_ms();
                s.state_seq = slot.seq_next;
                slot.seq_next += 1;
            });
        }
    }
}

fn get_slot<'a>(
    slots: &'a mut HashMap<crate::identity::EndpointId, PeerSlot>,
    peer: &crate::identity::EndpointId,
) -> &'a mut PeerSlot {
    slots.entry(*peer).or_insert_with(|| {
        let (tx, _rx) = watch::channel(Arc::new(ConnectionStateSnapshot {
            peer_id: peer.to_string(),
            phase: ConnectionPhase::Disconnected,
            epoch: 0,
            state_seq: 0,
            path: LinkStatus::Unknown,
            changed_at_ms: now_ms(),
            reason: None,
        }));
        PeerSlot {
            epoch_next: 1,
            seq_next: 1,
            tx,
            handle: None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    fn peer(n: u8) -> crate::identity::EndpointId {
        // 不同 n 派生稳定不同的 id（内容寻址测试钥，非机密）
        SecretKey::from_bytes(&[n; 32]).public()
    }

    #[tokio::test]
    async fn snapshot_before_subscribe_and_lag_converge() {
        let st = ContinuityState::new();
        let p = peer(1);
        // 初始快照
        let s0 = st.snapshot(&p).await;
        assert_eq!(s0.phase, ConnectionPhase::Disconnected);
        assert_eq!(s0.epoch, 0);
        // 订阅（初值 = 最新）
        let mut rx = st.watch(&p).await;
        assert_eq!(*rx.borrow(), s0);
        // 慢订阅者不读期间发生多次跳变
        st.set_phase(&p, ConnectionPhase::Connecting, None, false)
            .await;
        st.set_phase(&p, ConnectionPhase::Handshaking, None, false)
            .await;
        // lag 收敛：读一次即最新，无缺事件悬挂
        rx.changed().await.unwrap();
        let latest = rx.borrow().clone();
        assert_eq!(latest.phase, ConnectionPhase::Handshaking);
        assert_eq!(latest.state_seq, s0.state_seq + 2);
        // 重拉 snapshot 与 watch 一致
        assert_eq!(*st.snapshot(&p).await, *latest);
    }

    #[tokio::test]
    async fn seq_monotonic_across_phase_changes() {
        let st = ContinuityState::new();
        let p = peer(2);
        let mut last = st.snapshot(&p).await.state_seq;
        for phase in [
            ConnectionPhase::Connecting,
            ConnectionPhase::Handshaking,
            ConnectionPhase::Ready,
            ConnectionPhase::Disconnected,
        ] {
            st.set_phase(&p, phase, Some("test".into()), false).await;
            let cur = st.snapshot(&p).await.state_seq;
            assert!(cur > last, "state_seq 必须单调");
            last = cur;
        }
    }
}
