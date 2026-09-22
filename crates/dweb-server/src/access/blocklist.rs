//! Blocklist：`blocklist.jsonl` append-only 事件日志 + 当前名单只读快照
//! （server-access-roles Phase 1a，R8 拒绝半边：包租婆名单制）。
//!
//! 与 owners.jsonl 同构存储模式（r1-P1-5 统一矩阵，IO/generation 由
//! [`super::ledger`] 承担）：坏行启动 fail-fast、reload 失败保留旧快照、
//! 变更 generation+1、mtime 热重载、`reason` 字段 `serde(default)` 向后兼容。
//!
//! 事件形态（spec 冻结）：`{"op":"add"|"remove","kind":"endpoint"|"fabric",`
//! `"id":"<64hex>","reason"?,"ts"}`。当前名单 = add 未 remove。两个维度
//! 独立命名空间：同 hex 值的 endpoint 条目与 fabric 条目互不影响。
//!
//! gate 挂点（spec 冻结次序，MUST NOT 重排）：endpoint 维度在凭证分类（C0）
//! **之前**（有票无票同样生效，有效票不豁免）；fabric 维度在 L1 解析出
//! issuer 后、L1b 之前。deny slug `dweb/blocked`。**open 模式不生效**——
//! open 不装配 gate（relay.rs AllowAll 快路径），名单仅 restricted 语义。
//!
//! 存量连接不主动断（与 owners 到期/unregister 的「新连接即时拒」语义一致）。
//!
//! 入口边界：admin API（Phase 1c `POST/DELETE /admin/blocklist`）+ 文件两
//! 入口，无 CLI mutation；add/remove 方法 1a 内由测试与文件入口驱动。

use super::ledger;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

/// 名单维度（serde wire 值冻结：endpoint|fabric）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Endpoint,
    Fabric,
}

/// (kind, id) 命名空间键——两个维度的同值 id 互不干扰
type BlockKey = (BlockKind, [u8; 32]);

/// jsonl 事件记录（hex 64 字符小写；reason serde(default) + 缺省不落行）
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    op: Op,
    kind: BlockKind,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    ts: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Op {
    Add,
    Remove,
}

/// 当前名单只读快照（Arc 克隆派发；gate 每次接入取用）
#[derive(Clone)]
pub struct BlocklistSnapshot {
    inner: Arc<SnapshotInner>,
}

struct SnapshotInner {
    generation: u64,
    /// 值 = add 事件携带的 reason（None = 未填写）
    entries: HashMap<BlockKey, Option<String>>,
}

impl BlocklistSnapshot {
    /// 台账 generation
    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    /// gate 挂点判定：该维度的 id 是否在当前名单（add 未 remove）
    pub fn is_blocked(&self, kind: BlockKind, id: &[u8; 32]) -> bool {
        self.inner.entries.contains_key(&(kind, *id))
    }

    /// 命中时的 add 理由（deny debug 日志消费；Phase 1c 列表回显复用）
    pub fn reason(&self, kind: BlockKind, id: &[u8; 32]) -> Option<&str> {
        self.inner
            .entries
            .get(&(kind, *id))
            .and_then(|r| r.as_deref())
    }

    /// 当前名单条目数（启动日志用）
    pub fn len(&self) -> usize {
        self.inner.entries.len()
    }
}

struct State {
    current: Arc<SnapshotInner>,
}

/// Blocklist 句柄：load 建立当前名单；add/remove 在锁内 append+fsync+更新
/// 内存快照+generation+1。
pub struct Blocklist {
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
    let s = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    s.to_ascii_lowercase()
}

impl Blocklist {
    /// 读全量 jsonl 归并当前名单；文件不存在 = 空名单（首启合法形态）
    pub fn load(path: &Path) -> Result<Self> {
        let entries = Self::load_entries(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            state: Mutex::new(State {
                current: Arc::new(SnapshotInner {
                    generation: ledger::next_generation(),
                    entries,
                }),
            }),
        })
    }

    /// 未接线 gate 的空名单形态（AccessGate 默认构造用）
    pub fn ephemeral() -> Self {
        Self {
            path: PathBuf::new(),
            state: Mutex::new(State {
                current: Arc::new(SnapshotInner {
                    generation: ledger::next_generation(),
                    entries: HashMap::new(),
                }),
            }),
        }
    }

    fn load_entries(path: &Path) -> Result<HashMap<BlockKey, Option<String>>> {
        let mut entries: HashMap<BlockKey, Option<String>> = HashMap::new();
        for (line_no, record) in ledger::read_records::<Record>(path, "blocklist")? {
            let id = super::registry::parse_owner_hex(&record.id)
                .map_err(|e| anyhow::anyhow!("{}:{line_no} {e}", path.display()))?;
            match record.op {
                Op::Add => {
                    entries.insert((record.kind, id), record.reason);
                }
                Op::Remove => {
                    entries.remove(&(record.kind, id));
                }
            }
        }
        Ok(entries)
    }

    /// 加入名单（Phase 1c `POST /admin/blocklist` 入口；1a 由测试驱动）。
    /// 同键重复 add 幂等（集合语义），事件仍落日志。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn add(&self, kind: BlockKind, id: &[u8; 32], reason: Option<String>) -> Result<()> {
        self.apply(
            Record {
                op: Op::Add,
                kind,
                id: encode_id(id),
                reason,
                ts: now_ms(),
            },
            *id,
        )
    }

    /// 移出名单（按 (kind, id) 定位；不存在的 remove 同样落日志、无内存效果）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn remove(&self, kind: BlockKind, id: &[u8; 32]) -> Result<()> {
        self.apply(
            Record {
                op: Op::Remove,
                kind,
                id: encode_id(id),
                reason: None,
                ts: now_ms(),
            },
            *id,
        )
    }

    fn apply(&self, record: Record, id: [u8; 32]) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let line = ledger::record_line(&record)?;
        ledger::append_line(&self.path, "blocklist", &line)?;
        let mut entries = state.current.entries.clone();
        match record.op {
            Op::Add => {
                entries.insert((record.kind, id), record.reason);
            }
            Op::Remove => {
                entries.remove(&(record.kind, id));
            }
        }
        state.current = Arc::new(SnapshotInner {
            generation: ledger::next_generation(),
            entries,
        });
        Ok(())
    }

    /// 当前名单快照（Arc 克隆；gate 持有只读视图）
    pub fn snapshot(&self) -> BlocklistSnapshot {
        BlocklistSnapshot {
            inner: Arc::clone(&self.state.lock().unwrap().current),
        }
    }

    /// 台账文件路径（热重载看护的 stat 目标）
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 从磁盘重载：成功原子替换快照 + generation+1；失败保留旧快照并上抛。
    /// 文件缺失 = 空名单（fail-closed，与 owners/visitors 同语义）。
    pub fn reload(&self) -> Result<()> {
        let fresh = Self::load_entries(&self.path)?;
        let mut state = self.state.lock().unwrap();
        state.current = Arc::new(SnapshotInner {
            generation: ledger::next_generation(),
            entries: fresh,
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
    fn add_remove_merge_and_restart() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("blocklist.jsonl");
        let bl = Blocklist::load(&path).unwrap();
        assert!(bl.snapshot().len() == 0);
        bl.add(BlockKind::Endpoint, &key(1), Some("abuse".into()))
            .unwrap();
        bl.add(BlockKind::Fabric, &key(1), None).unwrap();
        let snap = bl.snapshot();
        assert!(snap.is_blocked(BlockKind::Endpoint, &key(1)));
        assert!(snap.is_blocked(BlockKind::Fabric, &key(1)));
        assert_eq!(snap.reason(BlockKind::Endpoint, &key(1)), Some("abuse"));
        assert_eq!(snap.reason(BlockKind::Fabric, &key(1)), None);
        assert_eq!(snap.len(), 2);
        // remove 精确到 (kind, id)：移 endpoint 不动 fabric
        bl.remove(BlockKind::Endpoint, &key(1)).unwrap();
        let snap = bl.snapshot();
        assert!(!snap.is_blocked(BlockKind::Endpoint, &key(1)));
        assert!(
            snap.is_blocked(BlockKind::Fabric, &key(1)),
            "维度独立命名空间"
        );

        // 重启 load 恢复
        let reloaded = Blocklist::load(&path).unwrap();
        assert!(reloaded.snapshot().is_blocked(BlockKind::Fabric, &key(1)));
        assert!(!reloaded.snapshot().is_blocked(BlockKind::Endpoint, &key(1)));
        assert_eq!(
            reloaded.snapshot().reason(BlockKind::Fabric, &key(1)),
            None,
            "add 未带 reason = None"
        );
    }

    /// 同 hex 双维度互不干扰（spec：endpoint 维度与 fabric 维度各自判定）
    #[test]
    fn same_hex_two_kinds_independent() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("blocklist.jsonl");
        let bl = Blocklist::load(&path).unwrap();
        bl.add(BlockKind::Fabric, &key(9), None).unwrap();
        let snap = bl.snapshot();
        assert!(snap.is_blocked(BlockKind::Fabric, &key(9)));
        assert!(!snap.is_blocked(BlockKind::Endpoint, &key(9)));
    }

    /// 坏行硬错误；reload 失败保留旧快照；文件缺失 = 空名单
    #[test]
    fn bad_line_fail_fast_and_reload_keeps_old_snapshot() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("blocklist.jsonl");
        let bl = Blocklist::load(&path).unwrap();
        bl.add(BlockKind::Endpoint, &key(1), None).unwrap();
        std::fs::write(&path, "garbage\n").unwrap();
        assert!(Blocklist::load(&path).is_err());
        assert!(bl.reload().is_err());
        assert!(bl.snapshot().is_blocked(BlockKind::Endpoint, &key(1)));
        std::fs::remove_file(&path).unwrap();
        bl.reload().unwrap();
        assert!(bl.snapshot().len() == 0, "文件缺失 = 空名单（fail-closed）");
    }

    /// 落行形状冻结：op/kind/id/ts + reason 缺省不落
    #[test]
    fn jsonl_line_shape_frozen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("blocklist.jsonl");
        let bl = Blocklist::load(&path).unwrap();
        bl.add(BlockKind::Endpoint, &[0x11; 32], None).unwrap();
        let line = std::fs::read_to_string(&path).unwrap();
        let line = line.trim_end();
        assert!(
            line.starts_with("{\"op\":\"add\",\"kind\":\"endpoint\",\"id\":\""),
            "{line}"
        );
        assert!(line.contains(&format!("\"id\":\"{}\"", "11".repeat(32))));
        assert!(line.contains("\"ts\":"));
        assert!(!line.contains("reason"));
        bl.add(BlockKind::Fabric, &[0x22; 32], Some("spam".into()))
            .unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("\"kind\":\"fabric\""));
        assert!(content.contains("\"reason\":\"spam\""));
        bl.remove(BlockKind::Fabric, &[0x22; 32]).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("\"op\":\"remove\""));
    }

    /// 极简行兼容 + generation 单调
    #[test]
    fn minimal_lines_parse_and_generation_monotonic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("blocklist.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"add\",\"kind\":\"endpoint\",\"id\":\"{}\",\"ts\":3}}\n",
                "31".repeat(32)
            ),
        )
        .unwrap();
        let bl = Blocklist::load(&path).unwrap();
        let g0 = bl.snapshot().generation();
        assert!(g0 >= 1);
        assert!(bl.snapshot().is_blocked(BlockKind::Endpoint, &[0x31; 32]));
        bl.remove(BlockKind::Endpoint, &[0x31; 32]).unwrap();
        assert!(bl.snapshot().generation() > g0);
        let reloaded = Blocklist::load(&path).unwrap();
        assert!(reloaded.snapshot().generation() > g0, "重启不回退");
        assert!(reloaded.snapshot().len() == 0);
    }

    /// 文件入口外部追加 → reload 生效（两入口收敛）；re-add 恢复
    #[test]
    fn file_entry_reload_picks_up_external_append() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("blocklist.jsonl");
        let bl = Blocklist::load(&path).unwrap();
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"add\",\"kind\":\"fabric\",\"id\":\"{}\",\"reason\":\"bad tenant\",\"ts\":1}}\n",
                "41".repeat(32)
            ),
        )
        .unwrap();
        bl.reload().unwrap();
        let snap = bl.snapshot();
        assert!(snap.is_blocked(BlockKind::Fabric, &[0x41; 32]));
        assert_eq!(
            snap.reason(BlockKind::Fabric, &[0x41; 32]),
            Some("bad tenant")
        );
    }

    /// ephemeral 形态：恒空
    #[test]
    fn ephemeral_blocklist_is_empty() {
        let bl = Blocklist::ephemeral();
        assert!(bl.snapshot().len() == 0);
        assert!(bl.snapshot().generation() >= 1);
        assert!(!bl.snapshot().is_blocked(BlockKind::Endpoint, &key(1)));
    }
}
