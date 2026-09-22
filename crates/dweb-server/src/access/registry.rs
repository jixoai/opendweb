//! Owner registry：`owners.jsonl` append-only 事件日志 + 活跃集合只读快照
//! （task 1.2，需求来源 2026-09-17；design §8.2 B1 / §8.5 generation / §11.2；
//! server-access-roles Phase 1a：条目元数据 expires_at/alias/note + 时间维度
//! 活跃判定 `contains_active`——R5 租户有效期 / R6 别名）。
//!
//! 活跃集合 = (fabric_id, root EndpointId) 二元组集合，由全量 jsonl 归并得出
//! （register 加入 / unregister 按 fabric_id+root 定位移除——同一 fabric 换
//! root 或多 fabric 同 root 都是不同记录）。条目可携带元数据
//! `expires_at`（u64 毫秒；`now >= expires_at` 即过期，等值=过期——spec
//! 冻结边界）/`alias`/`note`，全部 `serde(default)`：**旧格式条目（无这些
//! 字段）解析为「永久、无别名」，MUST NOT 因缺字段启动失败**。
//!
//! generation 语义（design §8.5 缓存键冻结）：每次 load / 每次变更 +1；
//! 快照携带 generation，下一棒 CallbackProvider 缓存以 (registry_generation,
//! endpoint_id, BLAKE3(hash_input), event) 为键，registry 变更即 generation+1
//! 并清空全部缓存（撤销即时生效窗口 = 0）。
//!
//! 坏行语义：load 对非空白行的 JSON 解析失败**硬错误**（admin 信任域的本地
//! 文件被截断/篡改必须暴露而非静默跳过，§9 A9）。文件 IO/generation 计数
//! 由 [`super::ledger`] 共享基座承担（r1-P1-5 四台账统一矩阵）。
//!
//! CLI 子命令（`dweb-server owners register|unregister <fabric_id_hex>
//! <root_hex>`）：直接操作 data_dir 的 jsonl 后退出，不启动服务。

use super::ledger;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

/// (fabric_id, root EndpointId) 活跃二元组的键类型（L1b 查表键，design §8.2 B1）
pub type OwnerKey = ([u8; 32], [u8; 32]);

/// jsonl 事件记录（行格式：op/fabric_id/root/ts + 可选元数据；hex 64 字符
/// 小写）。元数据字段 serde(default) + 缺省不落行——旧格式条目（无这些
/// 字段）解析为永久无别名，写入侧不带元数据时行形状与本变更前逐字节一致
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    op: Op,
    fabric_id: String,
    root: String,
    ts: u64,
    /// 租户有效期（u64 毫秒时间戳；None = 永久）。R5/server-access-roles
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
    /// 别名（R6；管理面展示用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    /// 备注（管理面展示用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    /// 促成本次注册的邀请码哈希（server-access-roles Phase 1b 跨台账提交
    /// 协议 r2-P0-1：/register 兑换路径写入；CLI/admin 直加行不带。
    /// `serde(default)` 兼容旧行——无此字段的行解析为非兑换注册）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    via_code_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Op {
    Register,
    Unregister,
}

/// 活跃条目的元数据（归并保留该键最后一次 register 事件的值）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct EntryMeta {
    registered_at: u64,
    expires_at: Option<u64>,
    alias: Option<String>,
    note: Option<String>,
}

/// 活跃 Owner 条目（admin API 列表用，task 3.1；registered_at = 该键最后
/// 一次 register 事件的 ts——重复注册刷新时间戳，append-only 日志保留
/// 全部历史事件）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerEntry {
    pub fabric_id: [u8; 32],
    pub root: [u8; 32],
    pub registered_at: u64,
    /// 到期时间戳（None = 永久）。Phase 1c 起经 `GET /admin/owners` 增量
    /// 暴露（`expires_at`/`expires_in`/状态）
    pub expires_at: Option<u64>,
    /// 别名（R6）。元数据经 `PATCH /admin/owners/{f}/{r}` 编辑（Phase 1c）
    pub alias: Option<String>,
    /// 备注。消费面同上（Phase 1c）
    pub note: Option<String>,
}

/// 活跃集合只读快照。验证链 O(1) 查表（snapshot() 是 Arc 克隆，零拷贝派发）。
#[derive(Clone)]
pub struct RegistrySnapshot {
    inner: Arc<SnapshotInner>,
}

struct SnapshotInner {
    generation: u64,
    /// Phase 3（task 3.1）+ Phase 1a（元数据）：值 = 该键最后一次 register
    /// 事件的完整元数据；归并语义与 HashSet 时代一致（register 插入/覆盖、
    /// unregister 移除）
    active: HashMap<OwnerKey, EntryMeta>,
    /// 带 via_code_hash 的 register 三元组全集（append-only 事实，不随后续
    /// unregister 移除）——codes 台账 reconciliation 的孤儿事实源
    /// （server-access-roles Phase 1b，r3-P0-2 每次加载同锁补齐）
    via_code: std::collections::BTreeSet<super::codes::RedeemKey>,
}

impl RegistrySnapshot {
    /// 缓存键用的 registry generation（design §8.5）
    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    /// L1b B1（无时间维度）：(fabric_id, issuer) 是否 ∈ registry（已注册，
    /// 无论是否过期）。gate 据此区分 `dweb/owner-expired` 与
    /// `dweb/unknown-owner`（spec「relay capability 验证」冻结语义）
    pub fn contains(&self, fabric_id: &[u8; 32], root: &[u8; 32]) -> bool {
        self.inner.active.contains_key(&(*fabric_id, *root))
    }

    /// L1b B1 时间维度（server-access-roles Phase 1a）：已注册**且未过期**。
    /// 到期判定冻结：`now >= expires_at` 即过期（等值=过期）；无 expires_at
    /// = 永久活跃（旧格式条目兼容）
    pub fn contains_active(&self, fabric_id: &[u8; 32], root: &[u8; 32], now_ms: u64) -> bool {
        self.inner
            .active
            .get(&(*fabric_id, *root))
            .is_some_and(|meta| meta.expires_at.is_none_or(|expires| now_ms < expires))
    }

    /// 活跃 Owner 数（空 registry 启动告警与 CLI 回显用）
    pub fn len(&self) -> usize {
        self.inner.active.len()
    }

    /// 带 via_code_hash 的 register 三元组全集（确定性排序——BTreeSet 字节
    /// 序；codes 台账 reconciliation 的孤儿匹配键，Phase 1b）
    pub fn code_orphans(&self) -> Vec<super::codes::RedeemKey> {
        self.inner.via_code.iter().copied().collect()
    }

    /// 指定键的持久租期（None = 条目缺失或永久）——/register 幂等回落在
    /// 重启后的 expires_at 事实源（consume 行不带租期，Phase 1b）
    pub fn entry_expires_at(&self, fabric_id: &[u8; 32], root: &[u8; 32]) -> Option<u64> {
        self.inner
            .active
            .get(&(*fabric_id, *root))
            .and_then(|meta| meta.expires_at)
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
            .map(|((fabric_id, root), meta)| OwnerEntry {
                fabric_id: *fabric_id,
                root: *root,
                registered_at: meta.registered_at,
                expires_at: meta.expires_at,
                alias: meta.alias.clone(),
                note: meta.note.clone(),
            })
            .collect();
        list.sort_by_key(|e| (e.fabric_id, e.root));
        list
    }
}

struct State {
    current: Arc<SnapshotInner>,
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
        let (active, via_code) = Self::load_active(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            state: Mutex::new(State {
                current: Arc::new(SnapshotInner {
                    generation: ledger::next_generation(),
                    active,
                    via_code,
                }),
            }),
        })
    }

    /// jsonl 全量归并（load 与 reload 共享；坏行硬错误，见模块注释）。
    /// 值 = 该键最后一次 register 事件的完整元数据；同时收集全部带
    /// via_code_hash 的 register 三元组（Phase 1b 孤儿事实源）。
    fn load_active(
        path: &Path,
    ) -> Result<(
        HashMap<OwnerKey, EntryMeta>,
        std::collections::BTreeSet<super::codes::RedeemKey>,
    )> {
        let mut active: HashMap<OwnerKey, EntryMeta> = HashMap::new();
        let mut via_code = std::collections::BTreeSet::new();
        for (line_no, record) in ledger::read_records::<Record>(path, "owners")? {
            let fabric_id = parse_owner_hex(&record.fabric_id)
                .map_err(|e| anyhow::anyhow!("{}:{line_no} {e}", path.display()))?;
            let root = parse_owner_hex(&record.root)
                .map_err(|e| anyhow::anyhow!("{}:{line_no} {e}", path.display()))?;
            match record.op {
                Op::Register => {
                    if let Some(hash_hex) = &record.via_code_hash {
                        let hash = parse_owner_hex(hash_hex)
                            .map_err(|e| anyhow::anyhow!("{}:{line_no} {e}", path.display()))?;
                        via_code.insert((hash, fabric_id, root));
                    }
                    active.insert(
                        (fabric_id, root),
                        EntryMeta {
                            registered_at: record.ts,
                            expires_at: record.expires_at,
                            alias: record.alias,
                            note: record.note,
                        },
                    );
                }
                Op::Unregister => {
                    active.remove(&(fabric_id, root));
                }
            }
        }
        Ok((active, via_code))
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

    /// CLI/admin 入口的事件构造（不带元数据——永久租户）。带元数据的写入
    /// 走文件入口（jsonl 直接追加）或 Phase 1b/1c 的专用端点，不经本方法。
    fn mutate(&self, op: Op, fabric_id: &[u8; 32], root: &[u8; 32]) -> Result<()> {
        self.apply(
            Record {
                op,
                fabric_id: encode_key(&hex::encode(fabric_id)),
                root: encode_key(&hex::encode(root)),
                ts: now_ms(),
                expires_at: None,
                alias: None,
                note: None,
                via_code_hash: None,
            },
            *fabric_id,
            *root,
        )
    }

    /// 邀请码兑换注册（server-access-roles Phase 1b 跨台账提交协议 ①：
    /// 唯一调用方 = codes::CodeLedger::redeem，codes 锁内执行）。事件携带
    /// `via_code_hash` + 兑换租期；**同键已活跃 = 续期语义**——刷新
    /// expires_at 与 registered_at、**保留既有 alias/note**（spec 冻结，
    /// 与 mutate 的覆盖语义有意不同）、不重复建条目。
    pub fn register_via_code(
        &self,
        fabric_id: &[u8; 32],
        root: &[u8; 32],
        expires_at: Option<u64>,
        via_code_hash: &[u8; 32],
    ) -> Result<()> {
        // expires_at 覆盖、alias/note 保留
        self.upsert_preserving(
            fabric_id,
            root,
            Some(expires_at),
            None,
            None,
            *via_code_hash,
        )
    }

    /// 续期（Phase 1c `POST /admin/owners/{f}/{r}/renew`）：register 事件
    /// 刷新 expires_at（None = permanent），**保留既有 alias/note**（与
    /// register_via_code 同语义——renew 不应清空运营元数据）。false = 键
    /// 不在册（含从未注册；过期条目仍在册可续期——spec「续期恢复准入」），
    /// 映射 404 no-match。
    pub fn renew(
        &self,
        fabric_id: &[u8; 32],
        root: &[u8; 32],
        expires_at: Option<u64>,
    ) -> Result<bool> {
        let mut state = self.state.lock().unwrap();
        if !state.current.active.contains_key(&(*fabric_id, *root)) {
            return Ok(false);
        }
        Self::upsert_locked(
            &mut state,
            fabric_id,
            root,
            Some(expires_at),
            None,
            None,
            None,
            self.path.as_path(),
        )?;
        Ok(true)
    }

    /// 元数据编辑（Phase 1c `PATCH /admin/owners/{f}/{r}`）：alias/note 覆盖
    /// 为入参终值（调用方完成「缺省保留/空串清除」合并），**保留既有
    /// expires_at**（元数据编辑不改租期）。false = 键不在册。
    pub fn update_metadata(
        &self,
        fabric_id: &[u8; 32],
        root: &[u8; 32],
        alias: Option<String>,
        note: Option<String>,
    ) -> Result<bool> {
        let mut state = self.state.lock().unwrap();
        if !state.current.active.contains_key(&(*fabric_id, *root)) {
            return Ok(false);
        }
        Self::upsert_locked(
            &mut state,
            fabric_id,
            root,
            None,
            Some(alias),
            Some(note),
            None,
            self.path.as_path(),
        )?;
        Ok(true)
    }

    /// upsert 公共核（register_via_code 直连；renew/update_metadata 在
    /// 预检后同锁进入）：None = 保留既有值，Some = 覆盖为终值。锁外不可
    /// 调用（renew/update 的存在性预检与写入必须同临界区）。
    fn upsert_preserving(
        &self,
        fabric_id: &[u8; 32],
        root: &[u8; 32],
        expires_at: Option<Option<u64>>,
        alias: Option<Option<String>>,
        note: Option<Option<String>>,
        via_code_hash: [u8; 32],
    ) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        Self::upsert_locked(
            &mut state,
            fabric_id,
            root,
            expires_at,
            alias,
            note,
            Some(via_code_hash),
            self.path.as_path(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_locked(
        state: &mut State,
        fabric_id: &[u8; 32],
        root: &[u8; 32],
        expires_at: Option<Option<u64>>,
        alias: Option<Option<String>>,
        note: Option<Option<String>>,
        via_code_hash: Option<[u8; 32]>,
        path: &Path,
    ) -> Result<()> {
        // 先合并出**终值**再落事件行：归并语义 = 最新 register 行原值生效，
        // 事件行必须携带完整终态（否则「保留既有 alias/note」只存在于内存、
        // 重启归并即丢失——1b 的潜在漂移在此修正：磁盘与内存同值）。
        // 合并规则：外层 Some=覆盖终值（内层 None=清除/永久）、外层 None=
        // 保留既有——**不得**用 flatten().or() 回落（会把「清除」误判为
        // 「未提供」而复活旧值）
        let existing = state
            .current
            .active
            .get(&(*fabric_id, *root))
            .cloned()
            .unwrap_or_default();
        let final_expires = expires_at.unwrap_or(existing.expires_at);
        let final_alias = alias.unwrap_or(existing.alias);
        let final_note = note.unwrap_or(existing.note);
        let record = Record {
            op: Op::Register,
            fabric_id: encode_key(&hex::encode(fabric_id)),
            root: encode_key(&hex::encode(root)),
            ts: now_ms(),
            expires_at: final_expires,
            alias: final_alias,
            note: final_note,
            via_code_hash: via_code_hash.map(hex::encode),
        };
        let line = ledger::record_line(&record).context("serialize owners record")?;
        ledger::append_line(path, "owners", &line)?;
        let mut active = state.current.active.clone();
        active.insert(
            (*fabric_id, *root),
            EntryMeta {
                registered_at: record.ts,
                expires_at: record.expires_at,
                alias: record.alias,
                note: record.note,
            },
        );
        let mut via_code = state.current.via_code.clone();
        if let Some(hash) = via_code_hash {
            via_code.insert((hash, *fabric_id, *root));
        }
        state.current = Arc::new(SnapshotInner {
            generation: ledger::next_generation(),
            active,
            via_code,
        });
        Ok(())
    }

    /// 事件落地公共核：先落盘（append + fsync），成功后才更新内存——磁盘
    /// 失败不留内存超前状态；快照按事件字段重建（元数据 = 事件原值）
    fn apply(&self, record: Record, fabric_id: [u8; 32], root: [u8; 32]) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let line = ledger::record_line(&record).context("serialize owners record")?;
        ledger::append_line(&self.path, "owners", &line)?;
        let op = record.op;
        let mut active = state.current.active.clone();
        match op {
            Op::Register => {
                active.insert(
                    (fabric_id, root),
                    EntryMeta {
                        registered_at: record.ts,
                        expires_at: record.expires_at,
                        alias: record.alias,
                        note: record.note,
                    },
                );
            }
            Op::Unregister => {
                active.remove(&(fabric_id, root));
            }
        }
        state.current = Arc::new(SnapshotInner {
            generation: ledger::next_generation(),
            active,
            via_code: state.current.via_code.clone(),
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
        let (fresh, via_code) = Self::load_active(&self.path)?;
        let mut state = self.state.lock().unwrap();
        state.current = Arc::new(SnapshotInner {
            generation: ledger::next_generation(),
            active: fresh,
            via_code,
        });
        Ok(())
    }

    /// reload 并返回孤儿集合（codes 台账热重载看护的原子事实源，Phase 1b）：
    /// 孤儿与快照出自**同一次**磁盘归并——消除「codes 看护先于 owners 看护
    /// reload」读到旧快照（孤儿缺失）的竞态窗口。失败保留旧快照并上抛，
    /// 由调用方回落上一轮孤儿集合（保守）。
    pub fn reload_for_orphans(&self) -> Result<Vec<super::codes::RedeemKey>> {
        self.reload()?;
        Ok(self.snapshot().code_orphans())
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
        assert!(snap.contains_active(&key(1), &key(2), now_ms()));
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

    // ---- server-access-roles Phase 1a：元数据 + 时间维度活跃判定 ----

    /// spec Scenario「旧格式 owners 条目解析为永久租户」：本变更前格式的行
    /// （无 expires_at/alias/note 字段）启动成功、按永久无别名参与活跃集合
    #[test]
    fn old_format_entry_parses_as_permanent_no_alias() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        // 逐字节复刻本变更前的行形状（无新字段）
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
        let snap = reg.snapshot();
        assert!(snap.contains(&[0x31; 32], &[0x32; 32]));
        // 永久：任意 now（含远未来）都活跃
        assert!(snap.contains_active(&[0x31; 32], &[0x32; 32], u64::MAX));
        let entry = &snap.entries()[0];
        assert_eq!(entry.expires_at, None, "旧条目 = 永久");
        assert_eq!(entry.alias, None, "旧条目 = 无别名");
        assert_eq!(entry.note, None);
        assert_eq!(entry.registered_at, 111);
    }

    /// 到期边界冻结：now >= expires_at 即过期（等值=过期）；过期后
    /// contains 仍真（区分 owner-expired 与 unknown-owner 的事实源）
    #[test]
    fn expires_at_boundary_equality_means_expired() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":1000}}\n",
                "41".repeat(32),
                "42".repeat(32)
            ),
        )
        .unwrap();
        let snap = OwnerRegistry::load(&path).unwrap().snapshot();
        assert!(
            snap.contains_active(&[0x41; 32], &[0x42; 32], 999),
            "到期前活跃"
        );
        assert!(
            !snap.contains_active(&[0x41; 32], &[0x42; 32], 1000),
            "等值 = 过期（spec 冻结边界）"
        );
        assert!(!snap.contains_active(&[0x41; 32], &[0x42; 32], 1001));
        assert!(
            snap.contains(&[0x41; 32], &[0x42; 32]),
            "过期条目仍在册（owner-expired ≠ unknown-owner）"
        );
    }

    /// 续期恢复（spec Scenario「续期恢复准入」的 registry 层）：过期条目经
    /// 文件入口追加新 register（未来 expires_at）+ reload → 重新活跃
    #[test]
    fn renewal_via_file_reload_restores_active() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let expired_line = format!(
            "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":200}}\n",
            "51".repeat(32),
            "52".repeat(32)
        );
        std::fs::write(&path, &expired_line).unwrap();
        let reg = OwnerRegistry::load(&path).unwrap();
        assert!(
            !reg.snapshot()
                .contains_active(&[0x51; 32], &[0x52; 32], 10_000)
        );
        // 文件入口续期：新 register 事件携带远期 expires_at（重复注册=刷新语义）
        let renewed = format!(
            "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":5000,\"expires_at\":9000}}\n",
            "51".repeat(32),
            "52".repeat(32)
        );
        std::fs::write(&path, format!("{expired_line}{renewed}")).unwrap();
        reg.reload().unwrap();
        assert!(
            reg.snapshot()
                .contains_active(&[0x51; 32], &[0x52; 32], 8_999)
        );
        assert!(
            !reg.snapshot()
                .contains_active(&[0x51; 32], &[0x52; 32], 9_000)
        );
        // 重复注册保留单一条目，元数据取最后一次 register 事件
        let entries = reg.snapshot().entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].registered_at, 5000);
        assert_eq!(entries[0].expires_at, Some(9000));
    }

    /// register()/unregister()（CLI/admin 入口）不带元数据：落行形状与本
    /// 变更前逐字节一致（无 expires_at/alias/note 键）——旧行形状冻结
    #[test]
    fn mutation_line_shape_unchanged_without_metadata() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let reg = OwnerRegistry::load(&path).unwrap();
        reg.register(&key(1), &key(2)).unwrap();
        reg.unregister(&key(1), &key(2)).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        for keyword in ["expires_at", "alias", "note"] {
            assert!(
                !content.contains(keyword),
                "无元数据写入不得落 {keyword} 键：{content}"
            );
        }
        assert!(content.contains("\"op\":\"register\""));
        assert!(content.contains("\"op\":\"unregister\""));
    }

    /// 元数据完整往返：文件入口写入 alias/note/expires_at → 快照携带 →
    /// 重启 load 保留（append-only 日志是唯一事实源）
    #[test]
    fn metadata_roundtrips_through_file_and_reload() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":99999999999999,\"alias\":\"tenant-a\",\"note\":\"paid plan\"}}\n",
                "61".repeat(32),
                "62".repeat(32)
            ),
        )
        .unwrap();
        let reg = OwnerRegistry::load(&path).unwrap();
        let entry = &reg.snapshot().entries()[0];
        assert_eq!(entry.expires_at, Some(99_999_999_999_999));
        assert_eq!(entry.alias.as_deref(), Some("tenant-a"));
        assert_eq!(entry.note.as_deref(), Some("paid plan"));
        let reloaded = OwnerRegistry::load(&path).unwrap();
        assert_eq!(reloaded.snapshot().entries(), reg.snapshot().entries());
    }

    /// 带元数据行的坏元数据形态：expires_at 非数字 = 坏行硬错误（fail-fast）
    #[test]
    fn malformed_metadata_field_fails_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":1,\"expires_at\":\"soon\"}}\n",
                "71".repeat(32),
                "72".repeat(32)
            ),
        )
        .unwrap();
        assert!(OwnerRegistry::load(&path).is_err());
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

    // ---- server-access-roles Phase 1b：via_code_hash + 兑换注册 ----

    /// 兑换注册事件落行形状：via_code_hash 与 expires_at 落行、不带
    /// alias/note；旧行（无 via_code_hash）解析不变
    #[test]
    fn register_via_code_line_shape_and_old_rows_parse() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let reg = OwnerRegistry::load(&path).unwrap();
        reg.register_via_code(&[0x11; 32], &[0x22; 32], Some(9_999), &[0x33; 32])
            .unwrap();
        let line = std::fs::read_to_string(&path).unwrap();
        let line = line.trim_end();
        assert!(
            line.starts_with("{\"op\":\"register\",\"fabric_id\":\""),
            "{line}"
        );
        assert!(line.contains(&format!("\"root\":\"{}\"", "22".repeat(32))));
        assert!(line.contains("\"expires_at\":9999"));
        assert!(line.contains(&format!("\"via_code_hash\":\"{}\"", "33".repeat(32))));
        assert!(!line.contains("alias") && !line.contains("note"));
        // 重启 load：via_code 孤儿集合 + 快照租期恢复
        let reloaded = OwnerRegistry::load(&path).unwrap();
        assert_eq!(
            reloaded.snapshot().code_orphans(),
            vec![([0x33; 32], [0x11; 32], [0x22; 32])]
        );
        assert_eq!(
            reloaded
                .snapshot()
                .entry_expires_at(&[0x11; 32], &[0x22; 32]),
            Some(9_999)
        );
        // 旧行（无 via_code_hash）不产生孤儿；永久条目 entry_expires_at=None
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":5}}\n",
                "44".repeat(32),
                "55".repeat(32)
            ),
        )
        .unwrap();
        let plain = OwnerRegistry::load(&path).unwrap();
        assert!(
            plain.snapshot().code_orphans().is_empty(),
            "旧行永不触发补写"
        );
        assert_eq!(
            plain.snapshot().entry_expires_at(&[0x44; 32], &[0x55; 32]),
            None,
            "永久条目（缺省租期）"
        );
        // 非法 via_code_hash = 坏行硬错误
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":5,\"via_code_hash\":\"zz\"}}\n",
                "44".repeat(32),
                "55".repeat(32)
            ),
        )
        .unwrap();
        assert!(OwnerRegistry::load(&path).is_err());
    }

    /// 兑换注册的续期合并语义：同键再兑换刷新租期/registered_at、保留
    /// 既有 alias/note、不重复建条目；unregister 后 via_code 孤儿仍保留
    /// （append-only 事实，reconciliation 不因注销而漏补）
    #[test]
    fn register_via_code_renewal_preserves_metadata() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        // 既有租户带 alias（文件入口）
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":200,\"alias\":\"a\",\"note\":\"n\"}}\n",
                "66".repeat(32),
                "77".repeat(32)
            ),
        )
        .unwrap();
        let reg = OwnerRegistry::load(&path).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        reg.register_via_code(&[0x66; 32], &[0x77; 32], Some(900), &[0x88; 32])
            .unwrap();
        let entries = reg.snapshot().entries();
        assert_eq!(entries.len(), 1, "续期不重复建条目");
        assert_eq!(entries[0].expires_at, Some(900));
        assert_eq!(entries[0].alias.as_deref(), Some("a"), "续期保留 alias");
        assert_eq!(entries[0].note.as_deref(), Some("n"), "续期保留 note");
        assert!(entries[0].registered_at > 100, "registered_at 刷新");
        assert_eq!(
            reg.snapshot().code_orphans(),
            vec![([0x88; 32], [0x66; 32], [0x77; 32])],
            "同键重复兑换的孤儿按三元组去重"
        );
        // 注销后孤儿事实仍在（崩溃恢复以事件为准，不以活跃集合为准）
        reg.unregister(&[0x66; 32], &[0x77; 32]).unwrap();
        assert_eq!(reg.snapshot().code_orphans().len(), 1);
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
