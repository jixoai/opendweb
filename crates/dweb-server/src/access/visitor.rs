//! Visitor registry：`visitors.jsonl` append-only 事件日志 + 活跃访客集合
//! 只读快照（server-access-roles Phase 1a，R1/R8：无票准入的名册半边）。
//!
//! 与 owners.jsonl 同构存储模式（r1-P1-5 统一矩阵，IO/generation 由
//! [`super::ledger`] 承担）：坏行启动 fail-fast、reload 失败保留旧快照、
//! 变更 generation+1、mtime 热重载、元数据字段 `serde(default)` 向后兼容。
//!
//! 事件形态（spec 冻结）：`{"op":"grant"|"revoke","endpoint_id":"<64hex>",`
//! `"alias"?,"note"?,"expires_at"?,"ts"}`。活跃访客 = 最新 grant 未 revoke
//! 且未过期（`expires_at` 缺省 = 永久；`now >= expires_at` 即过期，等值=
//! 过期——与 owners 到期边界同一条冻结规则）。同端点重复 grant 覆盖元数据
//! （alias/note/expires_at 取最后一次 grant 事件值）。
//!
//! **入口边界（r2-P1-3 裁定）**：admin API + 文件两入口——不新增 CLI
//! mutation（owners 既有 CLI 保持不动不扩）；grant/revoke 方法由 Phase 1c
//! 的 `POST/DELETE /admin/visitors` 消费，1a 内由测试与文件入口驱动。
//!
//! 访客语义边界（design §1.1）：仅 relay 通行——relay 握手已密码学认证
//! endpoint_id（E1 链），设备 key 即身份；rendezvous 可达面 v1 为空。

use super::ledger;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

/// jsonl 事件记录（hex 64 字符小写；元数据 serde(default) + 缺省不落行）
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    op: Op,
    endpoint_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
    ts: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Op {
    Grant,
    Revoke,
}

/// 活跃访客条目（admin 列表/元数据编辑消费元数据——Phase 1c）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisitorEntry {
    pub endpoint_id: [u8; 32],
    /// 最后一次 grant 事件的 ts
    pub granted_at: u64,
    /// None = 永久
    pub expires_at: Option<u64>,
    pub alias: Option<String>,
    pub note: Option<String>,
}

/// 活跃集合只读快照（Arc 克隆派发；gate 每次接入取用）
#[derive(Clone)]
pub struct VisitorSnapshot {
    inner: Arc<SnapshotInner>,
}

struct SnapshotInner {
    generation: u64,
    active: HashMap<[u8; 32], VisitorEntry>,
}

impl VisitorSnapshot {
    /// 缓存键复合 generation 用的访客名册世代（design §1.1 callback 联动）
    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    /// 无票准入判定（gate 次序 ② 消费）：命中活跃访客 = grant 未 revoke
    /// 且未过期（`now >= expires_at` 即过期，等值=过期）
    pub fn is_active(&self, endpoint_id: &[u8; 32], now_ms: u64) -> bool {
        self.inner
            .active
            .get(endpoint_id)
            .is_some_and(|e| e.expires_at.is_none_or(|expires| now_ms < expires))
    }

    /// 在册判定（无时间维度）：grant 未 revoke 即在册（过期条目仍在——
    /// Phase 1c PATCH 定位与列表展示用；活跃判定走 is_active）
    pub fn contains(&self, endpoint_id: &[u8; 32]) -> bool {
        self.inner.active.contains_key(endpoint_id)
    }

    /// 活跃访客数（启动日志/告警用）
    pub fn len(&self) -> usize {
        self.inner.active.len()
    }

    /// 活跃集合确定性列表（endpoint_id 字节序；Phase 1c `GET /admin/visitors`
    /// 消费，1a 由测试驱动）
    pub fn entries(&self) -> Vec<VisitorEntry> {
        let mut list: Vec<VisitorEntry> = self.inner.active.values().cloned().collect();
        list.sort_by_key(|e| e.endpoint_id);
        list
    }
}

struct State {
    current: Arc<SnapshotInner>,
}

/// Visitor registry 句柄：load 建立活跃集合；grant/revoke 在锁内
/// append+fsync+更新内存快照+generation+1。
pub struct VisitorRegistry {
    path: PathBuf,
    state: Mutex<State>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn encode_id(bytes: &[u8; 32]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        .to_ascii_lowercase()
}

impl VisitorRegistry {
    /// 读全量 jsonl 归并活跃集合；文件不存在 = 空集合（首启合法形态）。
    /// 每次 load 消耗一个新 generation（恒非零）。
    pub fn load(path: &Path) -> Result<Self> {
        let active = Self::load_active(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            state: Mutex::new(State {
                current: Arc::new(SnapshotInner {
                    generation: ledger::next_generation(),
                    active,
                }),
            }),
        })
    }

    /// 未接线 gate 的空台账形态（AccessGate 默认构造用：无文件、永不写入、
    /// 恒空——restricted 模式由 main 显式接线真实台账取代）
    pub fn ephemeral() -> Self {
        Self {
            path: PathBuf::new(),
            state: Mutex::new(State {
                current: Arc::new(SnapshotInner {
                    generation: ledger::next_generation(),
                    active: HashMap::new(),
                }),
            }),
        }
    }

    fn load_active(path: &Path) -> Result<HashMap<[u8; 32], VisitorEntry>> {
        let mut active: HashMap<[u8; 32], VisitorEntry> = HashMap::new();
        for (line_no, record) in ledger::read_records::<Record>(path, "visitors")? {
            let endpoint_id = super::registry::parse_owner_hex(&record.endpoint_id)
                .map_err(|e| anyhow::anyhow!("{}:{line_no} {e}", path.display()))?;
            match record.op {
                Op::Grant => {
                    active.insert(
                        endpoint_id,
                        VisitorEntry {
                            endpoint_id,
                            granted_at: record.ts,
                            expires_at: record.expires_at,
                            alias: record.alias,
                            note: record.note,
                        },
                    );
                }
                Op::Revoke => {
                    active.remove(&endpoint_id);
                }
            }
        }
        Ok(active)
    }

    /// 授予访客（Phase 1c `POST /admin/visitors` 入口）。
    /// 同端点重复 grant 覆盖元数据（活跃集合集合语义），事件仍落日志。
    pub fn grant(
        &self,
        endpoint_id: &[u8; 32],
        alias: Option<String>,
        note: Option<String>,
        expires_at: Option<u64>,
    ) -> Result<()> {
        self.apply(
            Record {
                op: Op::Grant,
                endpoint_id: encode_id(endpoint_id),
                alias,
                note,
                expires_at,
                ts: now_ms(),
            },
            *endpoint_id,
        )
    }

    /// 吊销访客（按 endpoint_id 定位；不存在的 revoke 同样落日志、无内存效果）
    pub fn revoke(&self, endpoint_id: &[u8; 32]) -> Result<()> {
        self.apply(
            Record {
                op: Op::Revoke,
                endpoint_id: encode_id(endpoint_id),
                alias: None,
                note: None,
                expires_at: None,
                ts: now_ms(),
            },
            *endpoint_id,
        )
    }

    /// 元数据编辑（Phase 1c `PATCH /admin/visitors/{endpoint_id}`）：
    /// 以 grant 事件落盘（台账只有 grant/revoke 两事件——元数据随最新 grant
    /// 归并），**保留既有 expires_at**（元数据编辑不改租期），granted_at
    /// 刷新为本次事件 ts（字段语义 = 最新 grant 时间）。false = 端点不在
    /// 名册（grant 未撤销即算在册——过期条目可编辑，与 revoke 语义对称），
    /// 映射 404 no-match。
    pub fn update_metadata(
        &self,
        endpoint_id: &[u8; 32],
        alias: Option<String>,
        note: Option<String>,
    ) -> Result<bool> {
        let mut state = self.state.lock().unwrap();
        let Some(existing) = state.current.active.get(endpoint_id) else {
            return Ok(false);
        };
        let expires_at = existing.expires_at;
        let record = Record {
            op: Op::Grant,
            endpoint_id: encode_id(endpoint_id),
            alias,
            note,
            expires_at,
            ts: now_ms(),
        };
        let line = ledger::record_line(&record)?;
        ledger::append_line(&self.path, "visitors", &line)?;
        let mut active = state.current.active.clone();
        active.insert(
            *endpoint_id,
            VisitorEntry {
                endpoint_id: *endpoint_id,
                granted_at: record.ts,
                expires_at: record.expires_at,
                alias: record.alias,
                note: record.note,
            },
        );
        state.current = Arc::new(SnapshotInner {
            generation: ledger::next_generation(),
            active,
        });
        Ok(true)
    }

    /// 事件落地公共核：先落盘（append + fsync），成功后才更新内存快照
    fn apply(&self, record: Record, endpoint_id: [u8; 32]) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let line = ledger::record_line(&record)?;
        ledger::append_line(&self.path, "visitors", &line)?;
        let mut active = state.current.active.clone();
        match record.op {
            Op::Grant => {
                active.insert(
                    endpoint_id,
                    VisitorEntry {
                        endpoint_id,
                        granted_at: record.ts,
                        expires_at: record.expires_at,
                        alias: record.alias,
                        note: record.note,
                    },
                );
            }
            Op::Revoke => {
                active.remove(&endpoint_id);
            }
        }
        state.current = Arc::new(SnapshotInner {
            generation: ledger::next_generation(),
            active,
        });
        Ok(())
    }

    /// 当前活跃集合快照（Arc 克隆；gate 持有只读视图）
    pub fn snapshot(&self) -> VisitorSnapshot {
        VisitorSnapshot {
            inner: Arc::clone(&self.state.lock().unwrap().current),
        }
    }

    /// 台账文件路径（热重载看护的 stat 目标）
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 从磁盘重载活跃集合：**写序列化协议（r8-P0-1 四台账统一）**：读盘
    /// 归并与发布同持本台账锁——与 grant/revoke/update_metadata 的「锁内
    /// append+fsync+快照推进」构成同一互斥临界区，reload 不可能发布缺失
    /// 任一已完成写入的旧快照。成功原子替换快照 + generation+1；失败（坏
    /// 行/IO）保留旧快照并上抛。文件缺失 = 空集合（fail-closed，与 owners
    /// 同语义）。
    pub fn reload(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let fresh = Self::load_active(&self.path)?;
        state.current = Arc::new(SnapshotInner {
            generation: ledger::next_generation(),
            active: fresh,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn key(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    #[test]
    fn grant_revoke_merge_and_restart() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        let reg = VisitorRegistry::load(&path).unwrap();
        assert!(reg.snapshot().len() == 0);
        reg.grant(&key(1), None, None, None).unwrap();
        reg.grant(
            &key(2),
            Some("guest-b".into()),
            None,
            Some(999_999_999_999_999),
        )
        .unwrap();
        let snap = reg.snapshot();
        assert!(snap.is_active(&key(1), now_ms()));
        assert!(snap.is_active(&key(2), now_ms()));
        assert_eq!(snap.len(), 2);
        assert!(!snap.is_active(&key(3), now_ms()));
        reg.revoke(&key(1)).unwrap();
        assert!(!reg.snapshot().is_active(&key(1), now_ms()));

        // 重启 load：全量归并恢复同一活跃集合（含元数据）
        let reloaded = VisitorRegistry::load(&path).unwrap();
        let snap = reloaded.snapshot();
        assert!(!snap.is_active(&key(1), now_ms()));
        assert!(snap.is_active(&key(2), now_ms()));
        let entry = &snap.entries()[0];
        assert_eq!(entry.endpoint_id, key(2));
        assert_eq!(entry.alias.as_deref(), Some("guest-b"));
    }

    /// 到期边界：now >= expires_at 即过期（等值=过期）；缺省 = 永久
    #[test]
    fn expires_boundary_and_permanent_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        let reg = VisitorRegistry::load(&path).unwrap();
        reg.grant(&key(1), None, None, Some(1000)).unwrap();
        reg.grant(&key(2), None, None, None).unwrap();
        let snap = reg.snapshot();
        assert!(snap.is_active(&key(1), 999));
        assert!(!snap.is_active(&key(1), 1000), "等值 = 过期");
        assert!(!snap.is_active(&key(1), 1001));
        assert!(snap.is_active(&key(2), u64::MAX), "缺省 = 永久");
    }

    /// 过期/吊销后回落原路径（spec Scenario 的 registry 层）：过期访客
    /// revoke 语义一致——不活跃即不是访客
    #[test]
    fn regrant_overrides_metadata_latest_grant_wins() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        let reg = VisitorRegistry::load(&path).unwrap();
        reg.grant(&key(1), Some("old".into()), None, Some(500))
            .unwrap();
        assert!(!reg.snapshot().is_active(&key(1), 10_000), "短期已过期");
        // 再授予：最新 grant 覆盖元数据（别名刷新 + 永久化）
        reg.grant(&key(1), Some("new".into()), Some("re-granted".into()), None)
            .unwrap();
        let snap = reg.snapshot();
        assert!(snap.is_active(&key(1), 10_000));
        assert_eq!(snap.entries().len(), 1, "同端点不重复计入");
        let entry = &snap.entries()[0];
        assert_eq!(entry.alias.as_deref(), Some("new"));
        assert_eq!(entry.note.as_deref(), Some("re-granted"));
        assert_eq!(entry.expires_at, None);
    }

    /// 旧行/极简行兼容：只有 op/endpoint_id/ts 的 grant 解析为永久无别名
    #[test]
    fn minimal_line_shape_parses_with_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"grant\",\"endpoint_id\":\"{}\",\"ts\":7}}\n",
                "21".repeat(32)
            ),
        )
        .unwrap();
        let snap = VisitorRegistry::load(&path).unwrap().snapshot();
        assert!(snap.is_active(&[0x21; 32], u64::MAX));
        let entry = &snap.entries()[0];
        assert_eq!(entry.granted_at, 7);
        assert_eq!(entry.alias, None);
        assert_eq!(entry.expires_at, None);
    }

    /// 落行形状冻结：op/endpoint_id/ts 前缀 + 可选字段缺省不落
    #[test]
    fn jsonl_line_shape_frozen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        let reg = VisitorRegistry::load(&path).unwrap();
        reg.grant(&[0x11; 32], None, None, None).unwrap();
        let line = std::fs::read_to_string(&path).unwrap();
        let line = line.trim_end();
        assert!(
            line.starts_with("{\"op\":\"grant\",\"endpoint_id\":\""),
            "{line}"
        );
        assert!(line.contains(&format!("\"endpoint_id\":\"{}\"", "11".repeat(32))));
        assert!(line.contains("\"ts\":"), "{line}");
        assert!(!line.contains("alias") && !line.contains("note") && !line.contains("expires_at"));
        // 带元数据：字段序 op/endpoint_id/alias/note/expires_at/ts（spec 冻结）
        reg.grant(&[0x22; 32], Some("a".into()), Some("n".into()), Some(1))
            .unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        let second = content.lines().last().unwrap();
        assert!(
            second.starts_with("{\"op\":\"grant\",\"endpoint_id\":\""),
            "{second}"
        );
        let alias_pos = second.find("\"alias\":\"a\"").unwrap();
        let note_pos = second.find("\"note\":\"n\"").unwrap();
        let exp_pos = second.find("\"expires_at\":1").unwrap();
        let ts_pos = second.find("\"ts\":").unwrap();
        assert!(
            alias_pos < note_pos && note_pos < exp_pos && exp_pos < ts_pos,
            "{second}"
        );
    }

    /// 坏行硬错误（fail-fast）；reload 失败保留旧快照；文件缺失 = 空集合
    #[test]
    fn bad_line_fail_fast_and_reload_keeps_old_snapshot() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        let reg = VisitorRegistry::load(&path).unwrap();
        reg.grant(&key(1), None, None, None).unwrap();
        // 坏行 load = 硬错误
        std::fs::write(&path, "not json\n").unwrap();
        assert!(VisitorRegistry::load(&path).is_err());
        // reload 失败保留旧快照
        assert!(reg.reload().is_err());
        assert!(reg.snapshot().is_active(&key(1), now_ms()));
        // 文件删除 → 空集合（fail-closed）
        std::fs::remove_file(&path).unwrap();
        reg.reload().unwrap();
        assert!(reg.snapshot().len() == 0);
        // 缺字段坏行（无 op/endpoint_id）
        std::fs::write(&path, "{\"op\":\"grant\"}\n").unwrap();
        assert!(VisitorRegistry::load(&path).is_err());
    }

    /// generation：load/每次变更 +1，全局单调不回退（复合缓存键前提）
    #[test]
    fn generation_increments_and_does_not_regress() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        let reg = VisitorRegistry::load(&path).unwrap();
        let g0 = reg.snapshot().generation();
        assert!(g0 >= 1);
        reg.grant(&key(1), None, None, None).unwrap();
        let g1 = reg.snapshot().generation();
        assert!(g1 > g0);
        reg.revoke(&key(1)).unwrap();
        assert!(reg.snapshot().generation() > g1);
        // 重启（模拟文件重载）不回退
        let reloaded = VisitorRegistry::load(&path).unwrap();
        assert!(reloaded.snapshot().generation() > g1);
    }

    /// 外部进程经文件入口追加事件 → reload 归并生效（两入口收敛）
    #[test]
    fn file_entry_reload_picks_up_external_append() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        let reg = VisitorRegistry::load(&path).unwrap();
        assert!(!reg.snapshot().is_active(&[0x31; 32], now_ms()));
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"grant\",\"endpoint_id\":\"{}\",\"ts\":1}}\n",
                "31".repeat(32)
            ),
        )
        .unwrap();
        reg.reload().unwrap();
        assert!(reg.snapshot().is_active(&[0x31; 32], now_ms()));
        let g0 = reg.snapshot().generation();
        // revoke 文件入口
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"grant\",\"endpoint_id\":\"{}\",\"ts\":1}}\n{{\"op\":\"revoke\",\"endpoint_id\":\"{}\",\"ts\":2}}\n",
                "31".repeat(32),
                "31".repeat(32)
            ),
        )
        .unwrap();
        reg.reload().unwrap();
        assert!(!reg.snapshot().is_active(&[0x31; 32], now_ms()));
        assert!(reg.snapshot().generation() > g0);
    }

    /// 并发同键 grant：活跃集合唯一、事件行全部落盘无交叉损坏
    #[test]
    fn concurrent_grant_same_key_stays_unique() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("visitors.jsonl");
        let reg = std::sync::Arc::new(VisitorRegistry::load(&path).unwrap());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let reg = std::sync::Arc::clone(&reg);
            handles.push(std::thread::spawn(move || {
                reg.grant(&key(7), None, None, None).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(reg.snapshot().len(), 1);
        let lines = std::fs::read_to_string(&path).unwrap();
        assert_eq!(lines.lines().count(), 8);
        assert!(lines.lines().all(|l| l.contains("\"op\":\"grant\"")));
    }

    /// ephemeral 形态：恒空、generation 恒非零
    #[test]
    fn ephemeral_registry_is_empty() {
        let reg = VisitorRegistry::ephemeral();
        assert!(reg.snapshot().len() == 0);
        assert!(reg.snapshot().generation() >= 1);
        assert!(!reg.snapshot().is_active(&key(1), now_ms()));
    }

    /// ③a（r8-P0-1 同构回归，visitors 侧）：并发 grant 与 reload 交错——
    /// 写序列化协议下 reload 不可能发布缺失任一已完成 grant 的旧快照
    /// （每轮 join 后立即断言内存快照；终态经 reload 从磁盘复核）
    #[test]
    fn concurrent_grant_and_reload_active_never_regresses() {
        let dir = TempDir::new().unwrap();
        let reg =
            std::sync::Arc::new(VisitorRegistry::load(&dir.path().join("visitors.jsonl")).unwrap());
        const ITERS: u8 = 24;
        for i in 0..ITERS {
            let grant = {
                let reg = std::sync::Arc::clone(&reg);
                std::thread::spawn(move || reg.grant(&key(i), None, None, None).unwrap())
            };
            let reload = {
                let reg = std::sync::Arc::clone(&reg);
                std::thread::spawn(move || reg.reload().unwrap())
            };
            grant.join().unwrap();
            reload.join().unwrap();
            assert!(
                reg.snapshot().is_active(&key(i), now_ms()),
                "第 {i} 轮：grant 完成后活跃集合不得被 reload 旧快照回退"
            );
        }
        // 终态：静默后一次 reload（磁盘事实）+ 全量复核
        reg.reload().unwrap();
        let snap = reg.snapshot();
        for i in 0..ITERS {
            assert!(snap.is_active(&key(i), now_ms()), "终态第 {i} 键活跃");
        }
        assert_eq!(snap.len(), ITERS as usize);
    }
}
