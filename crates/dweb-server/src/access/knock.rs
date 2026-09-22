//! KnockLog：relay 面拒绝接入的内存敲门台账（server-access-roles Phase 1a，
//! R3 敲门台的内核半边）。
//!
//! **身份来源红线（r1-P0-1）**：只接受 relay 握手密码学认证的 endpoint_id
//! （E1 链）——rendezvous HTTP 面的 deny（匿名 resolve 无调用方身份；announce
//! 签名验证前的 ACL 拒绝同样无已验身份）**不入 endpoint 台账**（由挂点
//! 结构性保证：唯一写入方是 relay.rs 的 Deny 臂，rendezvous.rs 不触达）。
//!
//! 台账语义（spec「敲门日志」requirement 冻结）：
//! - 按 endpoint_id 聚合：`{endpoint_id, seq, first_at, last_at, count,
//!   last_reason, dismissed}`；重复敲门 count u64 饱和递增（不回绕）并更新
//!   last_at/last_reason
//! - **seq 为唯一排序键**：进程内单调序号，每次 deny 分配新 seq（同端点
//!   再次 deny 也换新 seq）——seq 单调故时钟回拨不影响排序；last_at 仅作
//!   展示字段，不参与排序/逐出；endpoint_id 升序仅作同 seq 的稳定 tie-break
//! - **排除项**：deny reason 为 `dweb/blocked` 的尝试不记（已被处置，不是
//!   待办）；`dweb/owner-expired` 记入且作为租户到期提醒类别
//! - dismiss/undismiss/新 deny/容量逐出在同一锁内原子完成（并发胜者 = 后
//!   获得锁者）；新 deny 自动复位 dismissed=false（重新进入待办）；
//!   dismiss/undismiss 幂等；对不存在条目返回 false（admin 面 404 判定源）
//! - 容量有界：最多 [`CAPACITY`] 个 endpoint 条目，超限按 seq 最小者逐出
//! - 重启清空（内存台账不落盘——敲门是运营提示不是审计事实，审计以管理
//!   操作回执为准；持久化列为未来工作）
//!
//! 排序契约（列表消费方 = Phase 1c `GET /admin/knocks`）：未处置（dismissed
//! =false）在前、组内 seq 降序、endpoint_id 升序 tie-break；
//! `pending_count` 恒为未 dismissed 条目数（include_dismissed 不改变语义）。

use std::collections::HashMap;
use std::sync::Mutex;

/// 台账容量上限（endpoint 条目数；超限按 seq 最小者逐出）
pub const CAPACITY: usize = 4096;

/// deny reason `dweb/blocked` 的排除项（与 gate.rs BLOCKED_REASON 同值；
/// 本地冻结一份，避免模块环）
const BLOCKED_REASON: &str = "dweb/blocked";

/// 单 endpoint 聚合条目（Phase 1c `GET /admin/knocks` 的 wire 源）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnockAgg {
    pub endpoint_id: [u8; 32],
    /// 进程内单调序号，每次 deny 分配新值（唯一排序键）
    pub seq: u64,
    pub first_at: u64,
    /// 仅展示字段（排序/逐出不用）
    pub last_at: u64,
    /// 饱和递增（不回绕）
    pub count: u64,
    pub last_reason: String,
    pub dismissed: bool,
}

/// 列表查询结果（`include_dismissed=true` 含已处置条目；pending_count 恒为
/// 未 dismissed 数）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnockList {
    pub knocks: Vec<KnockAgg>,
    pub pending_count: usize,
}

struct KnockInner {
    next_seq: u64,
    entries: HashMap<[u8; 32], KnockAgg>,
}

/// KnockLog 句柄（AccessGate 内嵌；relay Deny 臂经 gate 写入）
pub struct KnockLog {
    inner: Mutex<KnockInner>,
}

impl KnockLog {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(KnockInner {
                next_seq: 1,
                entries: HashMap::new(),
            }),
        }
    }

    /// relay Deny 臂唯一写入口。`dweb/blocked` 不记（排除项）；同端点重复
    /// deny 递增 count、分配新 seq、复位 dismissed；超容量按 (seq, endpoint_id)
    /// 最小者逐出——与排序键同源（时钟回拨免疫）。
    pub fn record(&self, endpoint_id: [u8; 32], reason: &str, now_ms: u64) {
        if reason == BLOCKED_REASON {
            return; // 已被处置，不是待办（spec 排除项）
        }
        let mut inner = self.inner.lock().unwrap();
        let seq = inner.next_seq;
        inner.next_seq = inner.next_seq.saturating_add(1);
        match inner.entries.get_mut(&endpoint_id) {
            Some(entry) => {
                entry.seq = seq; // 每次 deny 分配新 seq（排序键前移）
                entry.last_at = now_ms;
                entry.count = entry.count.saturating_add(1);
                entry.last_reason = reason.to_string();
                entry.dismissed = false; // 新 deny 复位（重新进入待办）
            }
            None => {
                inner.entries.insert(
                    endpoint_id,
                    KnockAgg {
                        endpoint_id,
                        seq,
                        first_at: now_ms,
                        last_at: now_ms,
                        count: 1,
                        last_reason: reason.to_string(),
                        dismissed: false,
                    },
                );
                if inner.entries.len() > CAPACITY {
                    evict_min_seq(&mut inner.entries);
                }
            }
        }
    }

    /// dismiss（幂等管理动作，不删除记录）。false = 台账无此 endpoint
    /// （Phase 1c 映射 404 no-match，与 disconnect 判定一致）
    pub fn dismiss(&self, endpoint_id: &[u8; 32]) -> bool {
        self.set_dismissed(endpoint_id, true)
    }

    /// undismiss（对等管理动作：手动恢复待办，幂等）
    pub fn undismiss(&self, endpoint_id: &[u8; 32]) -> bool {
        self.set_dismissed(endpoint_id, false)
    }

    /// 回执 generation 语义（Phase 1c，spec 冻结）：KnockLog 为内存台账，
    /// knock-dismiss/undismiss 回执的 generation 使用其**内部单调计数器**
    /// （与 seq 同源——每次 deny 前进，dismiss/undismiss 不前进；客户端
    /// 视为不透明 u64）
    pub fn generation(&self) -> u64 {
        self.inner.lock().unwrap().next_seq
    }

    fn set_dismissed(&self, endpoint_id: &[u8; 32], dismissed: bool) -> bool {
        let mut inner = self.inner.lock().unwrap();
        match inner.entries.get_mut(endpoint_id) {
            Some(entry) => {
                entry.dismissed = dismissed;
                true
            }
            None => false,
        }
    }

    /// 列表（排序冻结：未处置在前、组内 seq 降序、endpoint_id 升序
    /// tie-break；last_at 仅展示）。pending_count 恒为未 dismissed 条目数。
    pub fn list(&self, include_dismissed: bool) -> KnockList {
        let inner = self.inner.lock().unwrap();
        let mut knocks: Vec<KnockAgg> = inner
            .entries
            .values()
            .filter(|e| include_dismissed || !e.dismissed)
            .cloned()
            .collect();
        knocks.sort_by(|a, b| {
            // 未处置在前（false < true 的布尔序恰好实现 dismissed 分组）
            a.dismissed
                .cmp(&b.dismissed)
                // 组内 seq 降序（唯一排序键）
                .then(b.seq.cmp(&a.seq))
                // 同 seq tie-break：endpoint_id 升序（seq 全局唯一，理论上
                // 不可达——确定性兜底）
                .then(a.endpoint_id.cmp(&b.endpoint_id))
        });
        let pending_count = inner.entries.values().filter(|e| !e.dismissed).count();
        KnockList {
            knocks,
            pending_count,
        }
    }
}

/// 容量逐出：按 (seq, endpoint_id) 最小者移除（与排序键同源；last_at 不参与）
fn evict_min_seq(entries: &mut HashMap<[u8; 32], KnockAgg>) {
    if let Some(victim) = entries
        .values()
        .min_by_key(|e| (e.seq, e.endpoint_id))
        .map(|e| e.endpoint_id)
    {
        entries.remove(&victim);
    }
}

impl Default for KnockLog {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    /// spec Scenario「同端点重复敲门聚合计数」：单一条目 count=3、
    /// first_at=首次、last_at=最近、last_reason=最近一次
    #[test]
    fn same_endpoint_denies_aggregate() {
        let log = KnockLog::new();
        log.record(ep(1), "dweb/no-capability", 100);
        log.record(ep(1), "dweb/no-capability", 200);
        log.record(ep(1), "dweb/policy-denied", 300);
        let list = log.list(false);
        assert_eq!(list.knocks.len(), 1);
        let k = &list.knocks[0];
        assert_eq!(k.count, 3);
        assert_eq!(k.first_at, 100);
        assert_eq!(k.last_at, 300);
        assert_eq!(k.last_reason, "dweb/policy-denied");
        assert!(!k.dismissed);
        assert_eq!(list.pending_count, 1);
    }

    /// spec Scenario「黑名单拒绝不入台账」
    #[test]
    fn blocked_denies_not_recorded() {
        let log = KnockLog::new();
        log.record(ep(1), "dweb/blocked", 100);
        log.record(ep(2), "dweb/no-capability", 100);
        let list = log.list(true);
        assert_eq!(list.knocks.len(), 1);
        assert_eq!(list.knocks[0].endpoint_id, ep(2));
    }

    /// `dweb/owner-expired` 记入（租户到期提醒类别，与 unknown 区分面在 gate）
    #[test]
    fn owner_expired_recorded_as_category() {
        let log = KnockLog::new();
        log.record(ep(1), "dweb/owner-expired", 100);
        let list = log.list(false);
        assert_eq!(list.knocks[0].last_reason, "dweb/owner-expired");
    }

    /// spec Scenario「dismiss 幂等与再次敲门复位」
    #[test]
    fn dismiss_idempotent_and_new_deny_resets() {
        let log = KnockLog::new();
        log.record(ep(1), "dweb/no-capability", 100);
        assert!(log.dismiss(&ep(1)));
        assert!(log.dismiss(&ep(1)), "二次 dismiss 幂等成功");
        assert_eq!(log.list(false).knocks.len(), 0, "已处置不在默认响应");
        let all = log.list(true);
        assert_eq!(all.knocks.len(), 1);
        assert_eq!(all.pending_count, 0, "pending_count 恒为未处置数");
        assert!(all.knocks[0].dismissed);
        // 新 deny 复位 dismissed（重新计入 pending_count）
        log.record(ep(1), "dweb/no-capability", 200);
        let all = log.list(true);
        assert!(!all.knocks[0].dismissed);
        assert_eq!(all.pending_count, 1);
        assert_eq!(all.knocks[0].count, 2, "复位不重置聚合计数");
        // undismiss 对等动作幂等
        log.dismiss(&ep(1));
        assert!(log.undismiss(&ep(1)));
        assert!(log.undismiss(&ep(1)));
        assert_eq!(log.list(false).pending_count, 1);
        // unknown endpoint：false、无副作用
        assert!(!log.dismiss(&ep(9)));
        assert!(!log.undismiss(&ep(9)));
    }

    /// spec Scenario「排序契约」：seq 降序决出先后、last_at 仅展示——
    /// 时钟回拨（后 deny 的 last_at 更早）不改变 seq 排序
    #[test]
    fn seq_desc_order_immune_to_clock_rollback() {
        let log = KnockLog::new();
        log.record(ep(1), "dweb/no-capability", 1000); // seq 1
        log.record(ep(2), "dweb/no-capability", 2000); // seq 2
        log.record(ep(3), "dweb/no-capability", 500); // seq 3（时钟回拨：last_at 早于前两条）
        log.record(ep(1), "dweb/no-capability", 300); // seq 4（再回拨）
        let list = log.list(false);
        let order: Vec<[u8; 32]> = list.knocks.iter().map(|k| k.endpoint_id).collect();
        // seq 降序：ep1(seq4) → ep3(seq3) → ep2(seq2)
        assert_eq!(
            order,
            vec![ep(1), ep(3), ep(2)],
            "排序只看 seq，last_at 仅展示"
        );
        assert_eq!(list.knocks[0].last_at, 300, "回拨的 last_at 原样展示");
        assert_eq!(list.knocks[0].count, 2);
    }

    /// dismissed 分组在前与否：未处置在前、组内各自 seq 降序
    #[test]
    fn undisplayed_grouping_undismissed_first() {
        let log = KnockLog::new();
        log.record(ep(1), "r", 100); // seq1
        log.record(ep(2), "r", 200); // seq2
        log.record(ep(3), "r", 300); // seq3
        log.dismiss(&ep(2));
        log.record(ep(4), "r", 400); // seq4
        log.dismiss(&ep(4));
        let all = log.list(true);
        let order: Vec<[u8; 32]> = all.knocks.iter().map(|k| k.endpoint_id).collect();
        // 未处置（ep3 seq3, ep1 seq1）在前组内降序；已处置（ep4 seq4, ep2 seq2）在后
        assert_eq!(order, vec![ep(3), ep(1), ep(4), ep(2)]);
        assert_eq!(all.pending_count, 2);
    }

    /// 容量逐出：4096 上限，按 seq 最小者逐出（时钟回拨免疫；last_at 不参与）
    #[test]
    fn capacity_evicts_min_seq() {
        fn id_of(n: u64) -> [u8; 32] {
            let mut id = [0u8; 32];
            id[0..8].copy_from_slice(&n.to_be_bytes());
            id
        }
        let log = KnockLog::new();
        for n in 0..CAPACITY as u64 {
            log.record(id_of(n), "dweb/no-capability", 1000 + n);
        }
        let before = log.list(true);
        assert_eq!(before.knocks.len(), CAPACITY);
        let oldest = before
            .knocks
            .iter()
            .min_by_key(|k| k.seq)
            .unwrap()
            .endpoint_id;
        assert_eq!(oldest, id_of(0));
        // 第 4097 个不同 endpoint：seq 最小者（id_of(0)）被逐出
        log.record(id_of(CAPACITY as u64 + 7), "dweb/no-capability", 3000);
        let after = log.list(true);
        assert_eq!(after.knocks.len(), CAPACITY, "容量恒 4096");
        assert!(
            !after.knocks.iter().any(|k| k.endpoint_id == oldest),
            "seq 最小者被逐出"
        );
        assert!(
            after
                .knocks
                .iter()
                .any(|k| k.endpoint_id == id_of(CAPACITY as u64 + 7))
        );
    }

    /// 同端点重复 deny 不触发逐出路径（只更新既有条目，条目数不增）
    #[test]
    fn repeat_deny_same_endpoint_never_exceeds_capacity_path() {
        let log = KnockLog::new();
        for i in 0..(CAPACITY as u64 + 100) {
            log.record(ep(1), "dweb/no-capability", i);
        }
        let all = log.list(true);
        assert_eq!(all.knocks.len(), 1);
        assert_eq!(all.knocks[0].count, CAPACITY as u64 + 100);
    }

    /// 并发 record 与 dismiss 同锁原子（烟雾测试：无死锁、终态一致）
    #[test]
    fn concurrent_record_and_dismiss() {
        let log = std::sync::Arc::new(KnockLog::new());
        let mut handles = Vec::new();
        for i in 0..4u8 {
            let log = std::sync::Arc::clone(&log);
            handles.push(std::thread::spawn(move || {
                for _ in 0..100 {
                    log.record(ep(1), "dweb/no-capability", 100 + i as u64);
                }
            }));
        }
        let log2 = std::sync::Arc::clone(&log);
        handles.push(std::thread::spawn(move || {
            for _ in 0..100 {
                log2.dismiss(&ep(1));
            }
        }));
        for h in handles {
            h.join().unwrap();
        }
        let all = log.list(true);
        assert_eq!(all.knocks.len(), 1);
        assert_eq!(all.knocks[0].count, 400, "全部 record 聚合无丢失");
    }

    /// 重启清空语义由「内存台账」结构性保证（无持久化路径）；Default 等价 new
    #[test]
    fn default_equals_new_empty() {
        let log = KnockLog::default();
        assert_eq!(
            log.list(true),
            KnockList {
                knocks: vec![],
                pending_count: 0
            }
        );
    }
}
