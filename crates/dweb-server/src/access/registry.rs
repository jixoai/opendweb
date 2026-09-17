//! Owner registry：`owners.jsonl` append-only 事件日志 + 活跃集合只读快照
//! （task 1.2，需求来源 2026-09-17；design §8.2 B1 / §8.5 generation / §11.2）。
//!
//! 活跃集合 = (fabric_id, root EndpointId) 二元组集合，由全量 jsonl 归并得出
//! （register 加入 / unregister 按 fabric_id+root 定位移除——同一 fabric 换
//! root 或多 fabric 同 root 都是不同记录）。
//!
//! generation 语义（design §8.5 缓存键冻结）：每次 load / 每次变更 +1；
//! 快照携带 generation，下一棒 CallbackProvider 缓存以 (registry_generation,
//! endpoint_id, BLAKE3(hash_input), event) 为键，registry 变更即 generation+1
//! 并清空全部缓存（撤销即时生效窗口 = 0）。
//!
//! 坏行语义：load 对非空白行的 JSON 解析失败**硬错误**（admin 信任域的本地
//! 文件被截断/篡改必须暴露而非静默跳过，§9 A9）。
//!
//! CLI 子命令（`dweb-server owners register|unregister <fabric_id_hex>
//! <root_hex>`）：直接操作 data_dir 的 jsonl 后退出，不启动服务。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

/// (fabric_id, root EndpointId) 活跃二元组的键类型（L1b 查表键，design §8.2 B1）
pub type OwnerKey = ([u8; 32], [u8; 32]);

/// jsonl 事件记录（行格式冻结：op/fabric_id/root/ts；hex 64 字符小写）
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    op: Op,
    fabric_id: String,
    root: String,
    ts: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Op {
    Register,
    Unregister,
}

/// 活跃 Owner 条目（admin API 列表用，task 3.1；registered_at = 该键最后
/// 一次 register 事件的 ts——重复注册刷新时间戳，append-only 日志保留
/// 全部历史事件）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerEntry {
    pub fabric_id: [u8; 32],
    pub root: [u8; 32],
    pub registered_at: u64,
}

/// 活跃集合只读快照。验证链 O(1) 查表（snapshot() 是 Arc 克隆，零拷贝派发）。
#[derive(Clone)]
pub struct RegistrySnapshot {
    inner: Arc<SnapshotInner>,
}

struct SnapshotInner {
    generation: u64,
    /// Phase 3（task 3.1）：值 = registered_at（GET /admin/owners 暴露）；
    /// 归并语义与 HashSet 时代一致（register 插入/覆盖、unregister 移除）
    active: HashMap<OwnerKey, u64>,
}

impl RegistrySnapshot {
    /// 缓存键用的 registry generation（design §8.5）
    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    /// L1b B1：(fabric_id, issuer) 是否 ∈ registry（验证链接线 task 1.5 消费）
    pub fn contains(&self, fabric_id: &[u8; 32], root: &[u8; 32]) -> bool {
        self.inner.active.contains_key(&(*fabric_id, *root))
    }

    /// 活跃 Owner 数（空 registry 启动告警与 CLI 回显用）
    pub fn len(&self) -> usize {
        self.inner.active.len()
    }

    /// 是否为空（restricted+static+空 registry 启动告警，task 1.3）
    pub fn is_empty(&self) -> bool {
        self.inner.active.is_empty()
    }

    /// 活跃集合确定性列表（按 (fabric_id, root) 字节序排序；admin API 与
    /// 测试断言用——admin 信任域的低频只读投影，无锁竞争顾虑）
    pub fn entries(&self) -> Vec<OwnerEntry> {
        let mut list: Vec<OwnerEntry> = self
            .inner
            .active
            .iter()
            .map(|((fabric_id, root), registered_at)| OwnerEntry {
                fabric_id: *fabric_id,
                root: *root,
                registered_at: *registered_at,
            })
            .collect();
        list.sort_by_key(|e| (e.fabric_id, e.root));
        list
    }
}

struct State {
    current: Arc<SnapshotInner>,
}

/// 进程级单调 generation 计数器：每次 load / 每次变更 +1（task 1.2；
/// design §8.5 缓存键冻结）。全局单调而非每实例计数，保证后续文件重载
/// （SIGHUP/mtime）后 generation 不回退、缓存键不复用旧值。
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_generation() -> u64 {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

/// Owner registry 句柄：load 建立活跃集合；register/unregister 在锁内
/// append+fsync+更新内存快照+generation+1。
pub struct OwnerRegistry {
    path: PathBuf,
    state: Mutex<State>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn encode_key(hex_str: &str) -> String {
    hex_str.to_ascii_lowercase()
}

impl OwnerRegistry {
    /// 读全量 jsonl 归并活跃集合；文件不存在 = 空集合（首次启动合法形态）。
    /// 每次 load 消耗一个新 generation（恒非零，可作缓存键成分）。
    pub fn load(path: &Path) -> Result<Self> {
        let active = Self::load_active(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            state: Mutex::new(State {
                current: Arc::new(SnapshotInner {
                    generation: next_generation(),
                    active,
                }),
            }),
        })
    }

    /// jsonl 全量归并（load 与 reload 共享；坏行硬错误，见模块注释）。
    /// 值 = 该键最后一次 register 事件的 ts。
    fn load_active(path: &Path) -> Result<HashMap<OwnerKey, u64>> {
        let mut active: HashMap<OwnerKey, u64> = HashMap::new();
        match std::fs::File::open(path) {
            Ok(file) => {
                let reader = BufReader::new(file);
                for (idx, line) in reader.lines().enumerate() {
                    let line = line.with_context(|| format!("read {}", path.display()))?;
                    if line.trim().is_empty() {
                        continue; // 容忍尾随空行；非空白坏行仍硬错误（见模块注释）
                    }
                    let record: Record = serde_json::from_str(&line).with_context(|| {
                        format!("{}:{} malformed owners record", path.display(), idx + 1)
                    })?;
                    let fabric_id = parse_owner_hex(&record.fabric_id)
                        .map_err(|e| anyhow::anyhow!("{}:{} {e}", path.display(), idx + 1))?;
                    let root = parse_owner_hex(&record.root)
                        .map_err(|e| anyhow::anyhow!("{}:{} {e}", path.display(), idx + 1))?;
                    match record.op {
                        Op::Register => {
                            active.insert((fabric_id, root), record.ts);
                        }
                        Op::Unregister => {
                            active.remove(&(fabric_id, root));
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(e).with_context(|| format!("open owners file {}", path.display()));
            }
        }
        Ok(active)
    }

    /// 注册 Owner：append+fsync 后更新内存快照与 generation。
    /// 同键重复 register 幂等（活跃集合是集合语义，不重复计入），事件仍落日志。
    pub fn register(&self, fabric_id: &[u8; 32], root: &[u8; 32]) -> Result<()> {
        self.mutate(Op::Register, fabric_id, root)
    }

    /// 注销 Owner（按 fabric_id+root 定位；不存在的注销同样落日志、无内存效果）
    pub fn unregister(&self, fabric_id: &[u8; 32], root: &[u8; 32]) -> Result<()> {
        self.mutate(Op::Unregister, fabric_id, root)
    }

    fn mutate(&self, op: Op, fabric_id: &[u8; 32], root: &[u8; 32]) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        // 先落盘（append + fsync），成功后才更新内存——磁盘失败不留内存超前状态
        let record = Record {
            op,
            fabric_id: encode_key(&hex::encode(fabric_id)),
            root: encode_key(&hex::encode(root)),
            ts: now_ms(),
        };
        let line = serde_json::to_string(&record).context("serialize owners record")?;
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create owners dir {}", parent.display()))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .with_context(|| format!("open owners file {}", self.path.display()))?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .with_context(|| format!("append owners file {}", self.path.display()))?;
        file.sync_all()
            .with_context(|| format!("fsync owners file {}", self.path.display()))?;
        drop(file);

        let mut active = state.current.active.clone();
        match op {
            Op::Register => {
                active.insert((*fabric_id, *root), record.ts);
            }
            Op::Unregister => {
                active.remove(&(*fabric_id, *root));
            }
        }
        state.current = Arc::new(SnapshotInner {
            generation: next_generation(),
            active,
        });
        Ok(())
    }

    /// 当前活跃集合快照（Arc 克隆；验证链持有只读视图，不被后续变更影响）
    pub fn snapshot(&self) -> RegistrySnapshot {
        RegistrySnapshot {
            inner: Arc::clone(&self.state.lock().unwrap().current),
        }
    }

    /// registry 文件路径（热重载看护的 stat 目标）
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 从磁盘重载活跃集合（mtime 轮询/SIGHUP 热重载接线，task 1.5）：
    /// 成功则原子替换内存快照并 generation+1（全局单调不回退——外部进程
    /// 经 CLI 追加事件与本进程 register 走同一计数器）；失败（坏行/IO）
    /// 保留旧快照并上抛错误，由调用方决定重试节奏。
    /// 文件缺失 = 空集合（与 load 同语义：admin 删除文件即移除全部 owner，
    /// fail-closed）。
    pub fn reload(&self) -> Result<()> {
        let fresh = Self::load_active(&self.path)?;
        let mut state = self.state.lock().unwrap();
        state.current = Arc::new(SnapshotInner {
            generation: next_generation(),
            active: fresh,
        });
        Ok(())
    }
}

/// hex 64 字符 → [u8;32]（CLI 参数与 jsonl 值共用；非法值报错含原文）
pub fn parse_owner_hex(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 {
        return Err(format!(
            "invalid owner id {s:?}: expected 64 hex characters, got {}",
            s.len()
        ));
    }
    hex::decode(s)
        .map_err(|e| format!("invalid owner id {s:?}: {e}"))?
        .try_into()
        .map_err(|_| format!("invalid owner id {s:?}: expected 32 bytes"))
}

/// `owners` CLI 子命令（task 1.2）：`owners [--data-dir <path>|--owners-file
/// <path>] register|unregister <fabric_id_hex> <root_hex>`。
/// 直接操作 jsonl 后返回摘要；错误（非法 hex/坏文件/未知动词）以 String 上抛，
/// main 以退出码 2 fail-fast。data_dir 解析优先级与主服务一致（flag > env >
/// default），env 注入便于单测。
pub fn owners_cli(
    args: impl Iterator<Item = String>,
    get_env: &dyn Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let mut data_dir_flag: Option<String> = None;
    let mut owners_file_flag: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut it = args;
    while let Some(arg) = it.next() {
        let (name, inline_value) = match arg.split_once('=') {
            Some((n, v)) => (n.to_owned(), Some(v.to_owned())),
            None => (arg.clone(), None),
        };
        match name.as_str() {
            "--data-dir" | "--owners-file" => {
                let value = inline_value
                    .or_else(|| it.next())
                    .ok_or_else(|| format!("missing value for {name}"))?;
                if name == "--data-dir" {
                    data_dir_flag = Some(value);
                } else {
                    owners_file_flag = Some(value);
                }
            }
            _ => rest.push(arg),
        }
    }
    let verb = rest.first().cloned().ok_or_else(|| {
        "usage: owners [--data-dir <path>] register|unregister <fabric_id_hex> <root_hex>"
            .to_string()
    })?;
    if verb != "register" && verb != "unregister" {
        return Err(format!(
            "unknown owners subcommand {verb:?}: expected register|unregister"
        ));
    }
    if rest.len() != 3 {
        return Err(format!(
            "owners {verb} expects exactly 2 arguments (<fabric_id_hex> <root_hex>), got {}",
            rest.len() - 1
        ));
    }
    let fabric_id = parse_owner_hex(&rest[1])?;
    let root = parse_owner_hex(&rest[2])?;

    let data_dir = std::path::PathBuf::from(
        data_dir_flag
            .or_else(|| get_env("DWEB_DATA_DIR"))
            .unwrap_or_else(|| super::config::DEFAULT_DATA_DIR.to_string()),
    );
    let owners_file: PathBuf = owners_file_flag
        .map(PathBuf::from)
        .or_else(|| get_env("DWEB_OWNERS_FILE").map(PathBuf::from))
        .unwrap_or_else(|| data_dir.join(super::config::OWNERS_FILE_NAME));

    let registry = OwnerRegistry::load(&owners_file).map_err(|e| e.to_string())?;
    match verb.as_str() {
        "register" => registry
            .register(&fabric_id, &root)
            .map_err(|e| e.to_string())?,
        _ => registry
            .unregister(&fabric_id, &root)
            .map_err(|e| e.to_string())?,
    }
    let snap = registry.snapshot();
    Ok(format!(
        "owner {verb}ed: fabric {} root {} (active {} owners, generation {}, file {})",
        hex::encode(fabric_id),
        hex::encode(root),
        snap.len(),
        snap.generation(),
        owners_file.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn key(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    #[test]
    fn register_unregister_merge_and_restart() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let reg = OwnerRegistry::load(&path).unwrap();
        assert!(reg.snapshot().is_empty());
        reg.register(&key(1), &key(2)).unwrap();
        reg.register(&key(3), &key(4)).unwrap();
        let snap = reg.snapshot();
        assert!(snap.contains(&key(1), &key(2)));
        assert!(snap.contains(&key(3), &key(4)));
        assert_eq!(snap.len(), 2);
        reg.unregister(&key(1), &key(2)).unwrap();
        assert!(!reg.snapshot().contains(&key(1), &key(2)));

        // 重启 load：jsonl 全量归并恢复同一活跃集合
        let reloaded = OwnerRegistry::load(&path).unwrap();
        let snap = reloaded.snapshot();
        assert!(!snap.contains(&key(1), &key(2)));
        assert!(snap.contains(&key(3), &key(4)));
    }

    #[test]
    fn unregister_locates_by_pair_not_single_field() {
        let dir = TempDir::new().unwrap();
        let reg = OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap();
        reg.register(&key(1), &key(2)).unwrap();
        reg.register(&key(1), &key(9)).unwrap(); // 同 fabric 不同 root
        reg.unregister(&key(1), &key(2)).unwrap();
        let snap = reg.snapshot();
        assert!(!snap.contains(&key(1), &key(2)), "定位对按二元组精确匹配");
        assert!(
            snap.contains(&key(1), &key(9)),
            "同 fabric 的其它 root 不受影响"
        );
    }

    #[test]
    fn generation_increments_on_load_and_each_mutation() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let reg = OwnerRegistry::load(&path).unwrap();
        let g0 = reg.snapshot().generation();
        assert!(g0 >= 1, "generation 恒非零（可作缓存键成分）");
        reg.register(&key(1), &key(2)).unwrap();
        let g1 = reg.snapshot().generation();
        assert!(g1 > g0, "每次变更 generation+1");
        reg.register(&key(1), &key(2)).unwrap(); // 幂等 register 仍是变更事件
        assert!(reg.snapshot().generation() > g1);
        reg.unregister(&key(1), &key(2)).unwrap();
        let g2 = reg.snapshot().generation();
        assert!(g2 > g1 + 1);
        // 旧快照保持旧 generation（缓存键随快照携带，不被后续变更改写）
        let stale = reg.snapshot();
        reg.register(&key(5), &key(6)).unwrap();
        assert_eq!(stale.generation(), g2);

        // 再次 load（模拟重启/文件重载）generation 不回退（全局单调）
        let reloaded = OwnerRegistry::load(&path).unwrap();
        assert!(reloaded.snapshot().generation() > g2);
    }

    #[test]
    fn duplicate_register_idempotent_in_active_set() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let reg = OwnerRegistry::load(&path).unwrap();
        reg.register(&key(7), &key(8)).unwrap();
        reg.register(&key(7), &key(8)).unwrap();
        let snap = reg.snapshot();
        assert_eq!(snap.len(), 1, "同键重复 register 不重复计入活跃集合");
        // 事件日志保留两行（append-only 审计事实）
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 2);
    }

    #[test]
    fn concurrent_register_same_key_stays_unique() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let reg = std::sync::Arc::new(OwnerRegistry::load(&path).unwrap());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let reg = std::sync::Arc::clone(&reg);
            handles.push(std::thread::spawn(move || {
                reg.register(&key(7), &key(8)).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(reg.snapshot().len(), 1);
        // 全部事件行落盘无交叉损坏
        let lines = std::fs::read_to_string(&path).unwrap();
        assert_eq!(lines.lines().count(), 8);
        assert!(lines.lines().all(|l| l.contains("\"op\":\"register\"")));
    }

    #[test]
    fn jsonl_line_shape_frozen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let reg = OwnerRegistry::load(&path).unwrap();
        reg.register(&[0x11; 32], &[0x22; 32]).unwrap();
        let line = std::fs::read_to_string(&path).unwrap();
        let line = line.trim_end();
        // 字段顺序与命名冻结（task 1.2）：op/fabric_id/root/ts
        assert!(
            line.starts_with("{\"op\":\"register\",\"fabric_id\":\""),
            "{line}"
        );
        assert!(line.contains(&format!("\"fabric_id\":\"{}\"", "11".repeat(32))));
        assert!(line.contains(&format!("\"root\":\"{}\"", "22".repeat(32))));
        assert!(line.contains("\"ts\":"), "{line}");
        // hex 归一为小写
        reg.register(&[0xAB; 32], &[0xCD; 32]).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains(&format!("\"fabric_id\":\"{}\"", "ab".repeat(32))));
    }

    #[test]
    fn malformed_line_fails_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        std::fs::write(&path, "{\"op\":\"register\"}\n").unwrap(); // 缺字段
        assert!(OwnerRegistry::load(&path).is_err());
        std::fs::write(&path, "not json\n").unwrap();
        assert!(OwnerRegistry::load(&path).is_err());
        // 尾随空行容忍
        std::fs::write(&path, "\n\n").unwrap();
        assert!(OwnerRegistry::load(&path).unwrap().snapshot().is_empty());
    }

    #[test]
    fn parse_owner_hex_validates() {
        assert!(parse_owner_hex(&"ab".repeat(32)).is_ok());
        assert!(parse_owner_hex(&"AB".repeat(32)).is_ok(), "大写 hex 可解码");
        assert!(parse_owner_hex("zz").is_err());
        assert!(parse_owner_hex(&"a".repeat(63)).is_err());
        assert!(parse_owner_hex(&"a".repeat(65)).is_err());
        assert!(parse_owner_hex(&"g".repeat(64)).is_err());
    }

    /// task 3.1：entries() 暴露 registered_at（最后 register 事件 ts），
    /// 确定性排序；磁盘重载保留 ts；重复 register 刷新 ts
    #[test]
    fn entries_track_registered_at_sorted_and_survive_reload() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":111}}\n",
                "31".repeat(32),
                "32".repeat(32)
            ),
        )
        .unwrap();
        let reg = OwnerRegistry::load(&path).unwrap();
        reg.register(&key(1), &key(2)).unwrap(); // 内存路径（ts = now）
        let entries = reg.snapshot().entries();
        assert_eq!(entries.len(), 2);
        // 按 (fabric_id, root) 字节序：0x01..（内存路径）< 0x31..（磁盘路径）
        assert_eq!(entries[0].fabric_id, key(1));
        assert!(entries[0].registered_at > 111, "内存 register 记录当下 ts");
        assert_eq!(entries[1].fabric_id, [0x31; 32]);
        assert_eq!(entries[1].registered_at, 111, "磁盘 load 路径保留 jsonl ts");

        // 磁盘重载：ts 持久（append-only 日志的 ts 是唯一事实源）
        let reloaded = OwnerRegistry::load(&path).unwrap();
        assert_eq!(reloaded.snapshot().entries(), entries);

        // 重复 register 刷新 registered_at（活跃集合不重复，时间戳前进）
        let before = reloaded.snapshot().entries()[0].registered_at;
        std::thread::sleep(std::time::Duration::from_millis(5));
        reloaded.register(&key(1), &key(2)).unwrap();
        let after = reloaded.snapshot().entries();
        assert_eq!(after.len(), 2);
        assert!(
            after[0].registered_at > before,
            "重复 register 刷新 registered_at"
        );
    }

    #[test]
    fn owners_cli_registers_and_unregisters() {
        let dir = TempDir::new().unwrap();
        let env: std::collections::HashMap<String, String> =
            [("DWEB_DATA_DIR", dir.path().to_str().unwrap())]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        let getter = |k: &str| env.get(k).cloned();
        let fid = "11".repeat(32);
        let root = "22".repeat(32);
        let out = owners_cli(
            ["register".to_string(), fid.clone(), root.clone()].into_iter(),
            &getter,
        )
        .unwrap();
        assert!(out.contains("register"), "{out}");
        let path = dir.path().join("owners.jsonl");
        assert!(
            OwnerRegistry::load(&path)
                .unwrap()
                .snapshot()
                .contains(&[0x11; 32], &[0x22; 32])
        );

        let out = owners_cli(["unregister".to_string(), fid, root].into_iter(), &getter).unwrap();
        assert!(out.contains("unregister"), "{out}");
        assert!(OwnerRegistry::load(&path).unwrap().snapshot().is_empty());
    }

    #[test]
    fn owners_cli_flag_overrides_env_and_validates() {
        let dir = TempDir::new().unwrap();
        let env: std::collections::HashMap<String, String> =
            [("DWEB_DATA_DIR", "/nonexistent-default".to_string())]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        let getter = |k: &str| env.get(k).cloned();
        // flag > env
        owners_cli(
            [
                "--data-dir".to_string(),
                dir.path().to_str().unwrap().to_string(),
                "register".to_string(),
                "33".repeat(32),
                "44".repeat(32),
            ]
            .into_iter(),
            &getter,
        )
        .unwrap();
        assert!(dir.path().join("owners.jsonl").exists());
        // 非法 hex → 错误（main 退出码 2 路径）
        assert!(
            owners_cli(
                ["register".to_string(), "zz".to_string(), "44".repeat(32)].into_iter(),
                &getter
            )
            .is_err()
        );
        // 未知动词 / 参数数不符
        assert!(owners_cli(["bogus".to_string()].into_iter(), &getter).is_err());
        assert!(
            owners_cli(
                ["register".to_string(), "33".repeat(32)].into_iter(),
                &getter
            )
            .is_err()
        );
    }
}
