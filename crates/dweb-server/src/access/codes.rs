//! Invitation code ledger：`codes.jsonl` append-only 事件日志 + 兑换状态机
//! （server-access-roles Phase 1b，R4：租户邀请码与公开自助注册）。
//!
//! 存储纪律与 owners/visitors/blocklist 同构（[`super::ledger`] 共享内核，
//! r1-P1-5 统一矩阵）：坏行启动 fail-fast、reload 失败保留旧快照、变更
//! generation+1、mtime 热重载、全字段 `serde(default)` 向后兼容。事件形态
//! （spec 冻结）：`{"op":"issue"|"revoke"|"consume","code_hash":"<blake3
//! hex>","alias_hint"?,"max_uses"?,"expires_at"?,"default_ttl_days"?,
//! "fabric_id"?,"root"?,"ts"}`——`consume` 为消费事件（携带兑换出的
//! fabric_id/root），`used_count` 由事件归并推导（**按 (code_hash,
//! fabric_id, root) 三元组去重**，MUST NOT 只存在于内存）。
//!
//! 码本体（r1-P1-3）：`dwebc1.` + base32(crockford) 16 字符（80bit 熵），
//! 4-4-4-4 分组展示；生成 MUST 用 OS CSPRNG；**哈希输入规范化冻结**：码
//! 本体 16 字符小写形态（剥 `dwebc1.` 前缀与连字符）blake3。码全文仅
//! 签发响应携带一次（Phase 1c 的 `POST /admin/codes` 签发路由经
//! [`CodeLedger::issue`] 消费 [`generate_code`]），**日志/指标/错误零码全文**。
//!
//! 跨台账提交协议（r2-P0-1，consume 与 owners register 分属两个 jsonl）：
//! ① owners register（带 `via_code_hash`）先 fsync → ② codes consume 后
//! fsync → ③ 双成功才允许 200/回执。崩溃窗口恒收敛为「完整兑换」或「码
//! 完好」：**reconciliation（孤儿 consume 补齐）是每次加载（启动 + mtime
//! 热重载）的同锁步骤**（r3-P0-2；r8-P0-1 起热重载整段——读盘/归并/
//! 补写/发布——与全部写入共享同一台账锁，单一写序列化协议），孤儿匹配
//! 按完整三元组（旧行/管理员直加行无 via_code_hash 永不补写）。
//!
//! 失败分级（r4-P1-3；r9-P1-1 细化；r10-P1-1 扩面）：(a) 台账加载/归并
//! 失败（含首启）= 调用方（main）fail-fast 拒绝启动；(b) 加载成功后的补写
//! append 失败 = 受影响码入**进程内 deny-set**（不落盘）+ 告警（code_hash/
//! 原因/重试数）。**reload 路径部分失败 = 保留既有 current snapshot
//! （generation/内容不变），仅合并 deny——r10-P1-1：deny 面 = 本轮全部孤儿
//! 中未被已发布快照 consumed 覆盖的 code hash**（补写成功的孤儿 consume
//! 同样已 durable 落盘但随旧快照保留而未发布，used_count 不推进——不 deny
//! 即可按旧计数再次兑换绕过 max_uses）；**补写全部成功才发布新快照 + 清
//! deny + 释放匹配 pending**（首启 load 无旧快照可保，按磁盘事实发布——
//! 成功补写直接入快照，无未发布窗口）。同键 pending 补写成功可完成当前
//! 请求（幂等恢复路径保持），但**不提前清除 Reconciliation 来源 deny**
//! （Redemption 来源照旧自愈）——唯一解除通道 = 整轮成功的 reload 发布
//! 新快照（快照 consumed 届时覆盖全部 durable 三元组）。deny 的
//! 兑换语义按来源裁决（r9，见 [`DenySource`]）：reconciliation 失败的码
//! 他键兑换 **503 `code-unavailable` 优先于 pending 409**；redeem 首次
//! consume append 失败的 pending 窗口他键仍 409；**同键重试恒为幂等补写
//! 恢复路径**（不因 deny 阻断——幂等完成优先，这是崩溃窗口的恢复通道，
//! 不是滥用面）。重启由归并重演恢复。
//!
//! 码级 pending 预留与幂等键（r3-P0-1/P1-2）：幂等键 = (code_hash,
//! fabric_id, root) 三元组。任一兑换通过校验即在台账锁内进入 pending；
//! pending 期间他键 409 `code-pending`、同键重试 = 幂等完成（按首次已
//! 持久化 register 结果补写 consume，**不重新计算租期**）；consume 已
//! durable 的同键请求 = 200 幂等回放（expires_at 不刷新，续期唯一入口
//! 是持新有效码——r4-P1-2）。pending 的释放通道有二：同键重试补写完成，
//! 或 reload 归并/reconciliation 发现该键 consume 已 durable（r8-P1-1；
//! 仅整轮成功的 reload 发布——部分失败轮 pending 保留，同键恢复路径
//! 不中断）。
//! 兑换判定与 consume 追加在同一临界区（codes Mutex）按 code_hash 串行：
//! max_uses=1 并发双兑恰一成功（r1-P0-2）。

use super::ledger;
use super::registry::OwnerRegistry;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// 码全文前缀（wire 冻结；与 dwebr1. capability 前缀同族命名法）
pub const CODE_PREFIX: &str = "dwebc1.";
/// 码本体长度：16 字符 × 5bit = 80bit 熵（spec 冻结）
const CODE_BODY_LEN: usize = 16;
/// crockford base32 小写字符集（排除 i/l/o/u；哈希输入与生成共用同一集合）
const CROCKFORD_LOWER: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
/// 签发默认值（spec 冻结）：单次使用 / 7 天有效 / 兑换租期 30 天
pub const DEFAULT_MAX_USES: u32 = 1;
pub const DEFAULT_EXPIRES_IN_DAYS: u64 = 7;
pub const DEFAULT_TTL_DAYS: u32 = 30;
/// 输入上限（spec 冻结，越界 400 invalid-request——由 Phase 1c 签发路由
/// 消费；issue() 在本层先行校验）
pub const MAX_USES_LIMIT: u32 = 1000;
pub const ALIAS_HINT_MAX_BYTES: usize = 32;

/// jsonl 事件记录（行序冻结：op/code_hash/alias_hint/max_uses/expires_at/
/// default_ttl_days/fabric_id/root/ts；可选字段 serde(default) + 缺省不落行）
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    op: Op,
    code_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    alias_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_uses: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_ttl_days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fabric_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    ts: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Op {
    Issue,
    Revoke,
    Consume,
}

/// 兑换幂等键：(code_hash, fabric_id, root) 完整三元组（r3-P0-1 冻结）
pub type RedeemKey = ([u8; 32], [u8; 32], [u8; 32]);

/// 归并后的码条目（列表/状态判定用；`used_count` 不在此——由 consume 键
/// 集合按 hash 前缀推导）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeEntry {
    pub code_hash: [u8; 32],
    /// 单码最大兑换次数（spec 默认 1）
    pub max_uses: u32,
    /// 码自身有效期（None = 永久码；`now >= expires_at` 即过期，等值=过期）
    pub expires_at: Option<u64>,
    /// 兑换出的租户默认租期天数（spec 默认 30）
    pub default_ttl_days: u32,
    pub alias_hint: Option<String>,
    pub revoked: bool,
    pub issued_at: u64,
}

/// 只读快照（Arc 克隆派发）
#[derive(Clone)]
pub struct CodeSnapshot {
    inner: Arc<SnapshotInner>,
}

struct SnapshotInner {
    generation: u64,
    codes: HashMap<[u8; 32], CodeEntry>,
    /// 去重后的 consume 键集合 → (consume ts, 兑换时租期 expires_at)。
    /// expires_at 仅进程内可靠（consume 行不带租期——事件形态 spec 冻结）；
    /// 磁盘 load 的行为 None，幂等回放回落 owners 快照取当前持久值
    consumed: HashMap<RedeemKey, (u64, Option<u64>)>,
}

impl CodeSnapshot {
    /// 台账世代（generation = 所属台账 generation，客户端不透明）
    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    /// 在册码数（含已吊销——吊销是状态而非删除；Phase 1c 列表过滤）
    pub fn len(&self) -> usize {
        self.inner.codes.len()
    }

    /// len 的空集判别（与 is_consumed 同为测试面消费——保留 1b 的标注纪律）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.inner.codes.is_empty()
    }

    /// 去重后的兑换计数（used_count 恒由事件归并推导，spec 冻结）
    pub fn used_count(&self, code_hash: &[u8; 32]) -> usize {
        self.inner
            .consumed
            .keys()
            .filter(|(h, _, _)| h == code_hash)
            .count()
    }

    /// 幂等键是否已有 durable consume（/register 幂等命中判定共享同一事实源）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_consumed(&self, key: &RedeemKey) -> bool {
        self.inner.consumed.contains_key(key)
    }

    /// 确定性列表（code_hash 字节序；Phase 1c `GET /admin/codes` 消费）
    pub fn entries(&self) -> Vec<CodeEntry> {
        let mut list: Vec<CodeEntry> = self.inner.codes.values().cloned().collect();
        list.sort_by_key(|e| e.code_hash);
        list
    }
}

/// pending 预留条目：register 已 durable、consume 未 durable 的窗口
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingEntry {
    fabric_id: [u8; 32],
    root: [u8; 32],
    /// 首次尝试已持久化的 register 租期（同键补写不重新计算，r3-P1-2）
    expires_at: u64,
}

/// deny-set 失败来源（r9-P1-1 裁决：他键兑换错误优先级的判别依据）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DenySource {
    /// 加载/reload 的 reconciliation 补写失败或孤儿 consume 未被已发布
    /// 快照覆盖（r10-P1-1 扩面；spec「该码禁止兑换」：pending 期间他键兑换
    /// **503 `code-unavailable` 优先于 409**；同键仍走幂等补写恢复路径，
    /// 不因 deny 阻断——且补写成功也**不提前清除**本 deny：同 hash 可能
    /// 还有其他 durable 但未入快照的孤儿，唯一解除通道 = 整轮成功的 reload
    /// 发布新快照）
    Reconciliation,
    /// redeem 首次 consume append 失败（pending 挂起窗口：他键仍 409
    /// `code-pending`——spec「pending 期间第二幂等键被拒」语义不回退；
    /// 同键重试 = 幂等补写）
    Redemption,
}

/// deny-set 条目（进程内、不落盘；告警三要素 code_hash/原因/重试数）
#[derive(Debug, Clone)]
struct DenyEntry {
    /// 告警文案承载（写入即消费：tracing 告警在失败现场输出；Phase 1c
    /// 运维投影将直读——保留结构完整性）
    #[allow(dead_code)]
    reason: String,
    retries: u32,
    source: DenySource,
}

/// load/reload 的归并产物：快照 + 补写失败的 deny-set（分级 (b)）
type LoadOutcome = (Arc<SnapshotInner>, HashMap<[u8; 32], DenyEntry>);

struct State {
    current: Arc<SnapshotInner>,
    /// code_hash → 预留键（pending 期间他键 409 / 同键幂等完成）
    pending: HashMap<[u8; 32], PendingEntry>,
    /// code_hash → 补写失败（来源见 [`DenySource`]：reconciliation 失败
    /// 他键 503 优先、redemption 失败他键 409；同键幂等补写恒不受阻；
    /// reload 整轮补写成功后移除）
    deny: HashMap<[u8; 32], DenyEntry>,
}

/// 兑换结果（HTTP 层映射：Replay/Completed→200、PendingOtherKey→409、
/// Unavailable→503、Invalid/Expired/Exhausted→400、Io→500）
#[derive(Debug)]
pub enum RedeemOutcome {
    /// 同键 consume 已 durable：200 幂等回放（expires_at 不刷新、零新副作用）
    Replay { expires_at: u64 },
    /// 新兑换（或同键 pending 补写完成）：双 fsync 成功，回执可签发
    Completed { expires_at: u64 },
    /// pending 期间他幂等键（409 code-pending）
    PendingOtherKey,
    /// deny-set fail-closed（503 code-unavailable）
    Unavailable,
    /// 哈希未命中 / 已吊销 / 规范化失败（400 code-invalid）
    Invalid,
    /// 码自身过期（400 code-expired）
    Expired,
    /// 次数耗尽（他键；同键在幂等命中已回放）（400 code-exhausted）
    Exhausted,
    /// 落盘失败且进程存活（500；pending/deny 语义见 redeem 注释）
    Io(anyhow::Error),
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- 码生成与规范化（r1-P1-3 冻结语义） --------------------------------

/// OS CSPRNG 10 字节（iroh `SecretKey::generate` = OS 熵；blake3 作提取器
/// 取前 10 字节——与 dweb-fabric `random_bytes` 同构，零新增依赖）
fn random_10_bytes() -> [u8; 10] {
    let seed = iroh_base::SecretKey::generate().to_bytes();
    let digest = blake3::hash(&seed);
    let mut out = [0u8; 10];
    out.copy_from_slice(&digest.as_bytes()[..10]);
    out
}

/// 10 字节 → 16 字符 crockford base32（小写；80bit 恰好无余位）
fn encode_crockford_16(bytes: &[u8; 10]) -> String {
    let mut out = String::with_capacity(CODE_BODY_LEN);
    let mut bitbuf: u32 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        bitbuf = (bitbuf << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((bitbuf >> bits) & 0x1f) as usize;
            out.push(CROCKFORD_LOWER[idx] as char);
        }
    }
    out
}

/// 生成一个新码：返回（全文展示形态 `dwebc1.xxxx-xxxx-xxxx-xxxx`（小写），
/// code_hash）。全文仅签发响应可携带——本函数的调用方（Phase 1c 签发路由
/// /测试）之外不得持久化或记录全文。
pub fn generate_code() -> (String, [u8; 32]) {
    let body = encode_crockford_16(&random_10_bytes());
    let display = format!(
        "{CODE_PREFIX}{}-{}-{}-{}",
        &body[0..4],
        &body[4..8],
        &body[8..12],
        &body[12..16]
    );
    (display, code_hash(&body))
}

/// 哈希输入规范化（spec 冻结）：剥 `dwebc1.` 前缀（大小写不敏感）与全部
/// 连字符、转小写，校验恰 16 字符且全部 ∈ crockford 小写集。失败 = None
/// （HTTP 层映射 code-invalid）。
pub fn normalize_code_body(raw: &str) -> Option<String> {
    let s = raw.trim();
    let body = s
        .strip_prefix(CODE_PREFIX)
        .or_else(|| {
            // 前缀大小写不敏感（用户手抄/输入法形态容忍；哈希键仍是规范化本体）
            s.get(..CODE_PREFIX.len())
                .filter(|head| head.eq_ignore_ascii_case(CODE_PREFIX))
                .map(|_| &s[CODE_PREFIX.len()..])
        })
        .unwrap_or(s);
    let mut normalized = String::with_capacity(CODE_BODY_LEN);
    for c in body.chars() {
        if c == '-' {
            continue;
        }
        normalized.push(c.to_ascii_lowercase());
    }
    (normalized.len() == CODE_BODY_LEN && normalized.bytes().all(|b| CROCKFORD_LOWER.contains(&b)))
        .then_some(normalized)
}

/// 哈希输入 = 规范化码本体的 blake3（16 字符小写形态的字节）
pub fn code_hash(normalized_body: &str) -> [u8; 32] {
    *blake3::hash(normalized_body.as_bytes()).as_bytes()
}

// ---- 台账 ----------------------------------------------------------------

/// 签发参数（Phase 1c `POST /admin/codes` 入口；1b 由测试驱动）。全部可选，
/// 缺省 1 / 7 天 / 30 天（spec 冻结）
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct IssueParams {
    pub alias_hint: Option<String>,
    pub max_uses: Option<u32>,
    pub expires_in_days: Option<u64>,
    pub default_ttl_days: Option<u32>,
}

/// Invitation code ledger 句柄：load = 归并 + reconciliation（同锁步骤）；
/// 兑换/签发/吊销在锁内 append+fsync+更新快照+generation+1。
pub struct CodeLedger {
    path: PathBuf,
    state: Mutex<State>,
}

impl CodeLedger {
    /// 读全量 jsonl 归并 + 孤儿 consume 补齐（reconciliation）。文件不存在
    /// = 空集合（首启合法形态）。坏行/IO 错误硬错误上抛——main 对首启
    /// fail-fast（失败分级 (a)）。`orphans` = owners 侧全部带 via_code_hash
    /// 的 register 三元组（含本进程写入后仍在 pending 的——去重由 consumed
    /// 键集合判定）。补写 append 失败**不上抛**：受影响码入 deny-set（分级
    /// (b)），快照按磁盘事实发布。
    pub fn load(path: &Path, orphans: &[RedeemKey]) -> Result<Self> {
        let (snapshot, deny) = Self::load_inner(path, orphans)?;
        Ok(Self {
            path: path.to_path_buf(),
            state: Mutex::new(State {
                current: snapshot,
                pending: HashMap::new(),
                deny,
            }),
        })
    }

    fn load_inner(path: &Path, orphans: &[RedeemKey]) -> Result<LoadOutcome> {
        let records = ledger::read_records::<Record>(path, "codes")?;
        let mut codes = HashMap::new();
        let mut consumed: HashMap<RedeemKey, (u64, Option<u64>)> = HashMap::new();
        for (line_no, record) in records {
            let hash = parse_code_hash(&record.code_hash)
                .map_err(|e| anyhow::anyhow!("{}:{line_no} {e}", path.display()))?;
            match record.op {
                Op::Issue => {
                    codes.insert(
                        hash,
                        CodeEntry {
                            code_hash: hash,
                            max_uses: record.max_uses.unwrap_or(DEFAULT_MAX_USES),
                            expires_at: record.expires_at,
                            default_ttl_days: record.default_ttl_days.unwrap_or(DEFAULT_TTL_DAYS),
                            alias_hint: record.alias_hint,
                            revoked: false,
                            issued_at: record.ts,
                        },
                    );
                }
                Op::Revoke => {
                    if let Some(entry) = codes.get_mut(&hash) {
                        entry.revoked = true;
                    }
                }
                Op::Consume => {
                    // 消费事件按完整三元组去重（重复行/补写竞态幂等收敛）；
                    // fabric/root 缺失的畸形 consume 以零值键计数（无法归因
                    // 到真实租户，也不与任何真键碰撞——[0;32] 不是合法公钥点）
                    let fabric = record
                        .fabric_id
                        .as_deref()
                        .and_then(|s| super::registry::parse_owner_hex(s).ok())
                        .unwrap_or([0u8; 32]);
                    let root = record
                        .root
                        .as_deref()
                        .and_then(|s| super::registry::parse_owner_hex(s).ok())
                        .unwrap_or([0u8; 32]);
                    consumed
                        .entry((hash, fabric, root))
                        .or_insert((record.ts, None));
                }
            }
        }
        let mut generation = ledger::next_generation();
        let mut deny: HashMap<[u8; 32], DenyEntry> = HashMap::new();
        // reconciliation：每个孤儿三元组（完整匹配，禁止按 hash 粗匹配——
        // max_uses>1 同码多租户会漏补）无 durable consume 即补写
        for (hash, fabric, root) in orphans {
            let key = (*hash, *fabric, *root);
            if consumed.contains_key(&key) {
                continue;
            }
            let record = consume_record(hash, fabric, root, now_ms());
            let line = ledger::record_line(&record)?;
            match ledger::append_line(path, "codes", &line) {
                Ok(()) => {
                    consumed.insert(key, (record.ts, None));
                    generation = ledger::next_generation();
                    #[cfg(test)]
                    test_hooks::fire_orphan_appended_hook();
                }
                Err(e) => {
                    let reason = format!("{e:#}");
                    tracing::warn!(
                        code_hash = %hex::encode(hash),
                        reason = %reason,
                        retries = 1,
                        "code reconciliation append failed (code enters deny-set)"
                    );
                    deny.insert(
                        *hash,
                        DenyEntry {
                            reason,
                            retries: 1,
                            source: DenySource::Reconciliation,
                        },
                    );
                }
            }
        }
        Ok((
            Arc::new(SnapshotInner {
                generation,
                codes,
                consumed,
            }),
            deny,
        ))
    }

    /// 从磁盘重载 + reconciliation（mtime 热重载路径）。**写序列化协议
    /// （r8-P0-1）**：磁盘读取、归并、孤儿补写与发布**全段持台账锁**——
    /// 与本台账全部写入（redeem/issue/revoke 的「锁内 append+fsync+快照
    /// 推进」）构成同一互斥临界区，reload 不可能发布落后于任一已完成写入
    /// 的快照（旧实现锁外读盘后加锁替换：watcher 读旧文件期间完成的兑换
    /// 会被旧快照覆盖，consume 计数丢失 → max_uses 绕过窗口）。锁序：本
    /// 方法只持 codes 锁（orphans 由调用方先行从 owners 台账取得，看护中
    /// owners/codes 两步顺序调用不嵌套持锁），与 redeem 的 codes→owners
    /// 单向序无环，不构成死锁。孤儿补写（reconciliation append）本身是写
    /// 操作，同样在该协议内。
    /// 失败（坏行/IO）保留旧快照并上抛。**r9-P1-1：reconciliation 失败与
    /// 加载成功分开表达**——任一孤儿补写 append 失败 = **保留既有 current
    /// snapshot**（generation/内容不变；冻结 spec「补写失败 = 保留当前快照 +
    /// 受影响码进 deny-set」+ 热重载场景「补写 IO 失败时保留旧快照」），
    /// deny 面 = **本轮全部孤儿中未被已发布快照 consumed 覆盖的 code hash**
    /// （r10-P1-1 扩面——补写成功的孤儿 consume 已 durable 但未发布，同样
    /// 存在「按旧 used_count 再次兑换绕过 max_uses」的窗口；append 失败的
    /// hash 恒在覆盖差集内，已发布快照已覆盖全部孤儿三元组的 hash 不入
    /// deny——孤儿全集含历史兑换，无差别 deny 全部孤儿 hash 会把无关码一并
    /// 503）。来源统一改判 Reconciliation——该码他键兑换自此 503 优先于
    /// pending 409。已有 deny 条目本轮补写成功也**不提前移除**：快照未
    /// 发布、used_count 未推进，提前放行会绕过 max_uses；统一由 watcher 的
    /// 「deny 非空强制重试」在磁盘恢复后的整轮成功中解除。
    /// pending 同样保留（同键补写恢复路径不中断）。**补写全部成功（含无
    /// 孤儿）**才原子替换快照 + generation+1 + deny 重建为空 + **释放匹配
    /// pending（r8-P1-1 语义保持）**：快照 consumed 键集合 = 本轮 durable
    /// 三元组全集（磁盘既有行 + 本轮补写）——覆盖此前全部被 deny 隐藏的
    /// durable 孤儿（deny 全量清空因此安全），预留键命中即清除——同码他键
    /// 不再滞留 409 code-pending。
    pub fn reload(&self, orphans: &[RedeemKey]) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let (snapshot, deny) = Self::load_inner(&self.path, orphans)?;
        #[cfg(test)]
        test_hooks::fire_reload_read_hook();
        if !deny.is_empty() {
            // 部分失败：保留既有 current snapshot（generation/内容不变），
            // 仅合并 deny——重试计数在既有条目上递增，来源统一改判
            // Reconciliation（该码自此进入 503 优先的 fail-closed 态）。
            // r10-P1-1：fail-closed 面 = 本轮全部孤儿中未被已发布快照
            // consumed 覆盖的 code hash（按 hash 去重）——本轮补写**成功**
            // 的孤儿 consume 已 durable 落盘，但旧快照保留即未发布、
            // used_count 不推进，不 deny 则该码他键可按旧计数再次兑换绕过
            // max_uses；此前轮次/外部文件入口写入的 durable 孤儿同理。
            // append 失败的 hash 恒在差集内（失败 ⇒ 不在候选 consumed ⇒
            // 不在已发布快照）；已发布快照已覆盖全部孤儿三元组的 hash 无
            // 未发布窗口，不入 deny（避免可用性无谓回退）。唯一解除通道
            // = 整轮成功的 reload 发布新快照（下方 deny 重建为空）。
            let uncovered: HashSet<[u8; 32]> = orphans
                .iter()
                .filter(|(hash, fabric, root)| {
                    !state
                        .current
                        .consumed
                        .contains_key(&(*hash, *fabric, *root))
                })
                .map(|(hash, _, _)| *hash)
                .collect();
            for hash in uncovered {
                let reason = deny.get(&hash).map_or_else(
                    || {
                        "orphan consume durable but snapshot not published (partial reload round)"
                            .to_string()
                    },
                    |failed| failed.reason.clone(),
                );
                let merged = match state.deny.remove(&hash) {
                    Some(prev) => DenyEntry {
                        reason,
                        retries: prev.retries + 1,
                        source: DenySource::Reconciliation,
                    },
                    None => DenyEntry {
                        reason,
                        retries: 1,
                        source: DenySource::Reconciliation,
                    },
                };
                state.deny.insert(hash, merged);
            }
            return Ok(());
        }
        state.pending.retain(|hash, p| {
            !snapshot
                .consumed
                .contains_key(&(*hash, p.fabric_id, p.root))
        });
        state.current = snapshot;
        // 整轮成功 = 快照 consumed 覆盖全部 durable 三元组（磁盘既有行含
        // 此前被 deny 隐藏的孤儿 + 本轮补写）——不再存在未发布窗口，deny
        // 全量重建为空（r10-P1-1 恢复断言的落点）
        state.deny = deny;
        Ok(())
    }

    /// 签发（Phase 1c 签发路由入口；1b 由测试驱动）。码全文仅本响应携带。
    /// 输入校验（spec 冻结上限）：max_uses ∈ 1..=1000、expires_in_days ≥ 1、
    /// default_ttl_days ≥ 1、alias_hint ≤ 32 UTF-8 字节。
    pub fn issue(&self, params: IssueParams) -> Result<(String, [u8; 32])> {
        let max_uses = params.max_uses.unwrap_or(DEFAULT_MAX_USES);
        let expires_in_days = params.expires_in_days.unwrap_or(DEFAULT_EXPIRES_IN_DAYS);
        let default_ttl_days = params.default_ttl_days.unwrap_or(DEFAULT_TTL_DAYS);
        if !(1..=MAX_USES_LIMIT).contains(&max_uses) {
            anyhow::bail!("max_uses must be 1..={MAX_USES_LIMIT}, got {max_uses}");
        }
        if expires_in_days < 1 {
            anyhow::bail!("expires_in_days must be >= 1 (0 is invalid)");
        }
        if default_ttl_days < 1 {
            anyhow::bail!("default_ttl_days must be >= 1");
        }
        if let Some(hint) = &params.alias_hint
            && hint.len() > ALIAS_HINT_MAX_BYTES
        {
            anyhow::bail!("alias_hint must be <= {ALIAS_HINT_MAX_BYTES} UTF-8 bytes");
        }
        let expires_at = now_ms()
            .checked_add(expires_in_days.saturating_mul(24 * 3_600_000))
            .context("expires_at overflow")?;
        let mut state = self.state.lock().unwrap();
        // CSPRNG 生成 + 台账内碰撞防御（80bit 熵下碰撞概率可忽略，防御性重生成）
        let (display, hash) = loop {
            let (display, hash) = generate_code();
            if !state.current.codes.contains_key(&hash) {
                break (display, hash);
            }
        };
        let record = Record {
            op: Op::Issue,
            code_hash: hex::encode(hash),
            alias_hint: params.alias_hint,
            max_uses: Some(max_uses),
            expires_at: Some(expires_at),
            default_ttl_days: Some(default_ttl_days),
            fabric_id: None,
            root: None,
            ts: now_ms(),
        };
        let entry = CodeEntry {
            code_hash: hash,
            max_uses,
            expires_at: Some(expires_at),
            default_ttl_days,
            alias_hint: record.alias_hint.clone(),
            revoked: false,
            issued_at: record.ts,
        };
        apply_event(&self.path, &mut state, record, hash, entry)?;
        Ok((display, hash))
    }

    /// 吊销（Phase 1c `DELETE /admin/codes/{code_hash}` 入口）。未知码同样
    /// 落日志（幂等管理员动作），内存无效果。
    pub fn revoke(&self, code_hash: &[u8; 32]) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let record = Record {
            op: Op::Revoke,
            code_hash: hex::encode(code_hash),
            alias_hint: None,
            max_uses: None,
            expires_at: None,
            default_ttl_days: None,
            fabric_id: None,
            root: None,
            ts: now_ms(),
        };
        let mut entry = state
            .current
            .codes
            .get(code_hash)
            .cloned()
            .unwrap_or(CodeEntry {
                code_hash: *code_hash,
                max_uses: DEFAULT_MAX_USES,
                expires_at: None,
                default_ttl_days: DEFAULT_TTL_DAYS,
                alias_hint: None,
                revoked: false,
                issued_at: record.ts,
            });
        entry.revoked = true;
        apply_event(&self.path, &mut state, record, *code_hash, entry)
    }

    /// 兑换状态机（唯一生产入口 = POST /register；校验序上游已完成限流/
    /// 形状/ts/PoP）。整段在 codes Mutex 临界区内按 code_hash 串行执行：
    /// ① durable 幂等回放 → ② pending（同键 = 幂等补写恢复路径，deny 不
    /// 阻断；他键 = reconciliation 来源 deny 时 503 优先、否则 409）→
    /// ③ deny-set 503 → ④ 码状态（invalid/expired/exhausted）→ ⑤ 新兑换
    /// （跨台账提交协议：pending 预留 → owners register fsync → consume
    /// fsync）。
    pub fn redeem(
        &self,
        owners: &OwnerRegistry,
        code_hash: &[u8; 32],
        fabric_id: &[u8; 32],
        root: &[u8; 32],
        now: u64,
    ) -> RedeemOutcome {
        let key = (*code_hash, *fabric_id, *root);
        let mut state = self.state.lock().unwrap();
        // ① 同键 consume 已 durable → 200 幂等回放（零新副作用、expires_at
        //   不刷新；进程内可取首次兑换租期，重启后回落 owners 当前持久值）
        if let Some((_, expires)) = state.current.consumed.get(&key) {
            let expires_at = expires.unwrap_or_else(|| owners_expires_at(owners, fabric_id, root));
            return RedeemOutcome::Replay { expires_at };
        }
        // ② pending（register durable / consume 缺失）。r9-P1-1 裁决（错误
        //   优先级，写入代码以供 spec 回写）：**同键 = 幂等完成恢复路径，
        //   即使该码已在 deny-set 也继续补写尝试**（幂等完成优先——这是
        //   崩溃窗口的恢复通道，不是滥用面；再失败仍 500）；**他键 = 该码
        //   因 reconciliation 补写失败入 deny（来源 Reconciliation）时
        //   503 code-unavailable 优先于 409**（冻结 spec「deny-set 中的码
        //   兑换一律 503」），仅 redeem 首次 consume append 失败的 pending
        //   挂起窗口（deny 来源 Redemption）保持 409 code-pending——
        //   「pending 期间第二幂等键被拒」的既有语义不回退。503 的判定
        //   时点是 reconciliation 判定补写当前不可恢复（watcher 整轮
        //   重试失败）；磁盘恢复后整轮成功的 reload 发布快照即解除。
        if let Some(p) = state.pending.get(code_hash) {
            if p.fabric_id == *fabric_id && p.root == *root {
                let expires_at = p.expires_at;
                return match complete_pending(self, &mut state, &key, expires_at, now) {
                    Ok(()) => RedeemOutcome::Completed { expires_at },
                    Err(e) => RedeemOutcome::Io(e),
                };
            }
            if let Some(d) = state.deny.get(code_hash)
                && d.source == DenySource::Reconciliation
            {
                return RedeemOutcome::Unavailable;
            }
            return RedeemOutcome::PendingOtherKey;
        }
        // ③ deny-set：状态不可用（区别于 exhausted/expired 的产品取舍）
        if state.deny.contains_key(code_hash) {
            return RedeemOutcome::Unavailable;
        }
        // ④ 码状态：未命中/已吊销 → invalid；过期（等值=过期）→ expired；
        //   次数耗尽（他键——同键已在 ① 回放）→ exhausted
        let Some(entry) = state.current.codes.get(code_hash).cloned() else {
            return RedeemOutcome::Invalid;
        };
        if entry.revoked {
            return RedeemOutcome::Invalid;
        }
        if entry.expires_at.is_some_and(|e| now >= e) {
            return RedeemOutcome::Expired;
        }
        if snapshot_used_count(&state.current, code_hash) >= entry.max_uses as usize {
            return RedeemOutcome::Exhausted;
        }
        // ⑤ 新兑换。租期 = now + default_ttl_days×24h（checked 防溢出，R5）
        let expires_at = match now.checked_add(u64::from(entry.default_ttl_days) * 24 * 3_600_000) {
            Some(v) => v,
            None => return RedeemOutcome::Io(anyhow::anyhow!("expires_at overflow")),
        };
        // pending 预留（台账锁内）；owners register 失败 = 无任何持久化
        // 副作用，回滚预留（500）
        state.pending.insert(
            *code_hash,
            PendingEntry {
                fabric_id: *fabric_id,
                root: *root,
                expires_at,
            },
        );
        if let Err(e) = owners.register_via_code(fabric_id, root, Some(expires_at), code_hash) {
            state.pending.remove(code_hash);
            return RedeemOutcome::Io(e.context("owners register append failed"));
        }
        // ② codes consume + fsync；失败保留 pending + 入 deny-set（500，
        // 同键重试/下次 reload 的 reconciliation 补写）
        match complete_pending(self, &mut state, &key, expires_at, now) {
            Ok(()) => RedeemOutcome::Completed { expires_at },
            Err(e) => RedeemOutcome::Io(e),
        }
    }

    /// 当前快照（Arc 克隆）
    pub fn snapshot(&self) -> CodeSnapshot {
        CodeSnapshot {
            inner: Arc::clone(&self.state.lock().unwrap().current),
        }
    }

    /// 台账文件路径（热重载看护的 stat 目标）
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// deny-set 条目数（进程内；测试断言用）
    pub fn deny_count(&self) -> usize {
        self.state.lock().unwrap().deny.len()
    }

    /// 单码 deny-set 命中判定（Phase 1c `GET /admin/codes` 的 `denied`
    /// 运维投影——1b 遗留：补写 append 失败的码在列表显式呈现 fail-closed
    /// 状态）
    pub fn is_denied(&self, code_hash: &[u8; 32]) -> bool {
        self.state.lock().unwrap().deny.contains_key(code_hash)
    }
}

/// 事件落地公共核：先落盘（append + fsync），成功后才更新内存快照
fn apply_event(
    path: &Path,
    state: &mut State,
    record: Record,
    hash: [u8; 32],
    entry: CodeEntry,
) -> Result<()> {
    let line = ledger::record_line(&record)?;
    ledger::append_line(path, "codes", &line)?;
    let mut codes = state.current.codes.clone();
    codes.insert(hash, entry);
    state.current = Arc::new(SnapshotInner {
        generation: ledger::next_generation(),
        codes,
        consumed: state.current.consumed.clone(),
    });
    Ok(())
}

/// consume 事件构造（携带三元组；不落 alias/max_uses 等签发字段）
fn consume_record(code_hash: &[u8; 32], fabric_id: &[u8; 32], root: &[u8; 32], ts: u64) -> Record {
    Record {
        op: Op::Consume,
        code_hash: hex::encode(code_hash),
        alias_hint: None,
        max_uses: None,
        expires_at: None,
        default_ttl_days: None,
        fabric_id: Some(hex::encode(fabric_id)),
        root: Some(hex::encode(root)),
        ts,
    }
}

/// pending 补写（同键幂等完成 / 新兑换第 ② 步共用）：append consume + fsync；
/// 成功 = pending 释放 + **来源判定式 deny 移除（r10-P1-1：仅 Redemption
/// 来源自愈；Reconciliation 来源保持到整轮成功的 reload 发布新快照——同
/// hash 可能仍有其他 durable 但未入快照的孤儿，提前解除会让该码他键按旧
/// 计数越过 max_uses）** + 快照推进；失败 = deny 记录/递增重试
/// （来源保守合并：已有 Reconciliation 判定保持——他键 503 不降级；否则
/// Redemption——pending 窗口他键 409。reload 的 reconciliation 失败会把
/// 来源改判 Reconciliation，见 [`CodeLedger::reload`]）并上抛（pending
/// 保留——同键下次重试）
fn complete_pending(
    ledger_ref: &CodeLedger,
    state: &mut State,
    key: &RedeemKey,
    expires_at: u64,
    now: u64,
) -> Result<()> {
    let record = consume_record(&key.0, &key.1, &key.2, now);
    let line = ledger::record_line(&record)?;
    if let Err(e) = ledger::append_line(&ledger_ref.path, "codes", &line) {
        let prev = state.deny.get(&key.0);
        let retries = prev.map_or(1, |d| d.retries + 1);
        let reason = format!("{e:#}");
        // r9-P1-1：来源保守合并——已有 reconciliation 判定（reload 整轮补写
        // 失败）不因同键补写再次失败而降级，他键的 503 fail-closed 保护
        // 保持；无既有条目/仅 redemption 来源时记 redemption（pending 窗口
        // 他键 409）
        let source = match prev {
            Some(d) if d.source == DenySource::Reconciliation => DenySource::Reconciliation,
            _ => DenySource::Redemption,
        };
        tracing::warn!(
            code_hash = %hex::encode(key.0),
            reason = %reason,
            retries,
            "codes consume append failed (code pending/denied, redemption not acknowledged)"
        );
        state.deny.insert(
            key.0,
            DenyEntry {
                reason,
                retries,
                source,
            },
        );
        return Err(e.context("codes consume append failed"));
    }
    // r10-P1-1：补写成功的 deny 移除仅限 Redemption 来源（本进程首兑失败的
    // pending 窗口自愈）；Reconciliation 来源（reload 部分失败轮）**保持**：
    // 同 hash 可能仍有其他 durable 但未入已发布快照的孤儿 consume，提前解除
    // 会让该码他键按旧计数越过 max_uses；唯一解除通道 = 整轮成功的 reload
    // 发布新快照（快照 consumed 届时覆盖全部 durable 三元组）。
    let deny_is_redemption =
        matches!(state.deny.get(&key.0), Some(d) if d.source == DenySource::Redemption);
    if deny_is_redemption {
        state.deny.remove(&key.0);
        tracing::info!(code_hash = %hex::encode(key.0), "code recovered from deny-set");
    } else if state.deny.contains_key(&key.0) {
        tracing::info!(
            code_hash = %hex::encode(key.0),
            "consume append recovered; reconciliation deny retained until snapshot republish"
        );
    }
    state.pending.remove(&key.0);
    let mut consumed = state.current.consumed.clone();
    consumed.insert(*key, (now, Some(expires_at)));
    state.current = Arc::new(SnapshotInner {
        generation: ledger::next_generation(),
        codes: state.current.codes.clone(),
        consumed,
    });
    Ok(())
}

fn snapshot_used_count(snapshot: &SnapshotInner, code_hash: &[u8; 32]) -> usize {
    snapshot
        .consumed
        .keys()
        .filter(|(h, _, _)| h == code_hash)
        .count()
}

/// 幂等回放的租期回落（consume 行不带租期——重启后）：owners 当前持久值；
/// 条目缺失（已注销）/永久 → u64::MAX（回执 expires_at 恒为数字的 wire
/// 约束；该形态下注册本身已不在册，回放仅确认兑换事实）
fn owners_expires_at(owners: &OwnerRegistry, fabric: &[u8; 32], root: &[u8; 32]) -> u64 {
    owners
        .snapshot()
        .entry_expires_at(fabric, root)
        .unwrap_or(u64::MAX)
}

fn parse_code_hash(s: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 {
        return Err(format!(
            "invalid code_hash {s:?}: expected 64 hex characters, got {}",
            s.len()
        ));
    }
    hex::decode(s)
        .map_err(|e| format!("invalid code_hash {s:?}: {e}"))?
        .try_into()
        .map_err(|_| format!("invalid code_hash {s:?}: expected 32 bytes"))
}

// ---- 热重载看护（codes.jsonl 与 owners.jsonl 双指纹——孤儿补齐覆盖两侧变更） ----

/// (mtime, len) 文件指纹；None = 文件缺失（可观察状态）
fn stat_of(path: &Path) -> Option<(SystemTime, u64)> {
    std::fs::metadata(path)
        .ok()
        .map(|m| (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len()))
}

/// codes 台账热重载看护：同时 stat codes.jsonl 与 owners.jsonl（孤儿来自
/// owners 侧 register——运行时经文件入口追加的带 via_code_hash register
/// 在下次 reload 归并时补齐，spec Scenario「热重载触发孤儿补齐」）。
/// 任一指纹变化即 reload（归并 + reconciliation 同锁）。**孤儿事实源 =
/// 同轮 `owners.reload_for_orphans()`**（owners 磁盘与快照原子归并——
/// 不依赖 owners 自身看护的时序，消除跨看护竞态）。**owners reload
/// 失败 = 本轮 fail-closed：不调 codes.reload、不推进指纹，挂起待重试
/// 标志**（r11-P1-1：旧实现回落旧孤儿集继续 reload codes 并在成功后
/// 推进指纹——失败窗口内新增的外部 via_code_hash register 不在旧孤儿
/// 集，被发布中的 codes reload 漏过；临时读权限故障恢复不改变
/// (mtime,len)，指纹相等即永久跳过，该码 used_count 永久漏计、max_uses
/// 可绕过。待重试标志直到 owners reload 成功**且**同轮孤儿集合完成
/// codes reload 才清除——期间即使指纹不变也每轮重试）。codes reload
/// 失败保留旧快照且**不推进指纹**（下轮重试——自进程追加与本看护并发
/// 时的撕裂读窗口靠重试收敛；持久坏行则周期性告警，由 admin 修复磁盘）。
pub fn spawn_codes_ledger_watcher(
    codes: Arc<CodeLedger>,
    owners: Arc<OwnerRegistry>,
) -> tokio::task::JoinHandle<()> {
    spawn_codes_ledger_watcher_every(codes, owners, Duration::from_secs(5))
}

/// 可配间隔版本（单测用 50ms 级验证轮换语义）
pub fn spawn_codes_ledger_watcher_every(
    codes: Arc<CodeLedger>,
    owners: Arc<OwnerRegistry>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    let codes_path = codes.path().to_path_buf();
    let owners_path = owners.path().to_path_buf();
    tokio::spawn(async move {
        let mut last = (stat_of(&codes_path), stat_of(&owners_path));
        // 待重试标志（r11-P1-1）：owners reload 失败挂起的未完成
        // reconciliation 轮次——存在时即使 (mtime,len) 指纹未变也每轮
        // 重试（权限修复不改变指纹，不能只靠指纹变化触发）
        let mut owners_reload_retry = false;
        loop {
            tokio::time::sleep(interval).await;
            let current = (stat_of(&codes_path), stat_of(&owners_path));
            // deny-set 非空 = 已知未完成的补写修复工作：无论指纹是否变化，
            // 每轮重试 reload（磁盘恢复后自愈——「补写成功即从 deny-set 移除」
            // 的重试通道；权限修复不改变 mtime/len，指纹不变也需可触发）
            let deny_pending = codes.deny_count() > 0;
            if current == last && !deny_pending && !owners_reload_retry {
                continue;
            }
            // 同轮孤儿事实源：失败则本轮不调 codes.reload、不推进 last
            //（宁可滞后发布也不带旧孤儿集发布——见函数级注释）
            let orphans = match owners.reload_for_orphans() {
                Ok(orphans) => orphans,
                Err(e) => {
                    owners_reload_retry = true;
                    tracing::warn!(
                        "owners reload for code reconciliation failed (codes reload deferred, will retry): {e:#}"
                    );
                    continue;
                }
            };
            match codes.reload(&orphans) {
                Ok(()) => {
                    owners_reload_retry = false;
                    last = current;
                    tracing::info!(
                        generation = codes.snapshot().generation(),
                        entries = codes.snapshot().len(),
                        "code ledger reloaded"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "code ledger reload failed (keeping previous snapshot, will retry): {e:#}"
                    );
                }
            }
        }
    })
}

/// barrier 测试钩子（r8-P0-1 回归专用）：armed 时 reload 在「读盘完成、
/// 发布前」（**持有台账锁**）触发一次并阻塞至释放——用于并发回归钉死
/// 「读盘与发布同临界区」的写序列化协议。
#[cfg(test)]
mod test_hooks {
    use std::sync::Mutex;
    use std::sync::mpsc::{Receiver, Sender};

    struct Hook {
        fired: Sender<()>,
        release: Receiver<()>,
    }

    static RELOAD_HOOK: Mutex<Option<Hook>> = Mutex::new(None);
    static ORPHAN_APPEND_HOOK: Mutex<Option<Hook>> = Mutex::new(None);

    /// 安装屏障（单次生效：fire 后自动卸载）
    pub fn arm(fired: Sender<()>, release: Receiver<()>) {
        *RELOAD_HOOK.lock().unwrap() = Some(Hook { fired, release });
    }

    /// r10-P1-1 回归专用：armed 时 load_inner 在**首个孤儿补写 append 成功
    /// 后**（持台账锁）触发一次并阻塞至释放——用于在同一轮内制造「部分
    /// 孤儿补写成功、其余失败」的混合结果（fired 窗口内测试侧 chmod 0444）
    pub fn arm_orphan_append(fired: Sender<()>, release: Receiver<()>) {
        *ORPHAN_APPEND_HOOK.lock().unwrap() = Some(Hook { fired, release });
    }

    pub(super) fn fire_reload_read_hook() {
        let mut guard = RELOAD_HOOK.lock().unwrap();
        if let Some(hook) = guard.take() {
            let _ = hook.fired.send(());
            let _ = hook.release.recv();
        }
    }

    pub(super) fn fire_orphan_appended_hook() {
        let mut guard = ORPHAN_APPEND_HOOK.lock().unwrap();
        if let Some(hook) = guard.take() {
            let _ = hook.fired.send(());
            let _ = hook.release.recv();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn key(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    // ---- 生成与规范化 ----

    /// 生成形态冻结：前缀 + 4-4-4-4 小写 crockford；80bit 熵（字符集 32
    /// 且 16 字符）；多次生成互异（CSPRNG）；哈希输入=规范化本体
    #[test]
    fn generate_code_shape_and_entropy() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            let (display, hash) = generate_code();
            assert!(display.starts_with("dwebc1."), "{display}");
            let body: String = display["dwebc1.".len()..]
                .chars()
                .filter(|c| *c != '-')
                .collect();
            assert_eq!(body.len(), 16);
            assert!(body.bytes().all(|b| CROCKFORD_LOWER.contains(&b)), "{body}");
            assert_eq!(display[7..].split('-').count(), 4, "4-4-4-4 分组展示");
            assert_eq!(hash, code_hash(&body));
            seen.insert(body);
        }
        assert_eq!(seen.len(), 64, "CSPRNG 生成互异");
    }

    /// 规范化矩阵：剥前缀（大小写）/连字符/空白、转小写；非 crockford 字符、
    /// 错误长度、非 ASCII 全部拒绝
    #[test]
    fn normalize_code_matrix() {
        let ok = "dwebc1.0123-4567-89cd-fghj";
        assert_eq!(normalize_code_body(ok).as_deref(), Some("0123456789cdfghj"));
        // 前缀大小写/无前缀/无连字符/大写本体/首尾空白
        assert_eq!(
            normalize_code_body("DWEBC1.0123-4567-89cd-fghj").as_deref(),
            Some("0123456789cdfghj")
        );
        assert_eq!(
            normalize_code_body("0123456789cdfghj").as_deref(),
            Some("0123456789cdfghj")
        );
        assert_eq!(
            normalize_code_body("dwebc1.0123456789CDFGHJ").as_deref(),
            Some("0123456789cdfghj")
        );
        // 首尾空白容忍；组内空白拒绝（非 crockford 字符）
        assert_eq!(
            normalize_code_body("  dwebc1.0123-4567-89cd-fghj  ").as_deref(),
            Some("0123456789cdfghj")
        );
        assert!(normalize_code_body("01234567 89cdfghj").is_none());
        // 拒绝：含 i/l/o/u（crockford 排除集）
        for bad in [
            "dwebc1.0123-4567-89cd-fghi",
            "dwebc1.0l23456789cdfghj",
            "dwebc1.0123456789cdfgho",
            "dwebc1.0123456u89cdfghj",
        ] {
            assert!(normalize_code_body(bad).is_none(), "{bad}");
        }
        // 拒绝：长度错误/空/非 ASCII
        assert!(normalize_code_body("").is_none());
        assert!(normalize_code_body("dwebc1.0123-4567-89cd-fg").is_none());
        assert!(normalize_code_body("dwebc1.0123-4567-89cd-fghjk").is_none());
        assert!(normalize_code_body("dwebc1.0123456789cdfgh\u{e9}").is_none());
    }

    /// 哈希冻结语义：同本体不同书写形态同哈希；不同本体不同哈希
    #[test]
    fn code_hash_normalizes_display_forms() {
        let a = code_hash(&normalize_code_body("dwebc1.0123-4567-89cd-fghj").unwrap());
        let b = code_hash(&normalize_code_body("DWEBC1.0123456789CDFGHJ").unwrap());
        let c = code_hash(&normalize_code_body("dwebc1.0123-4567-89cd-fghk").unwrap());
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    // ---- 台账归并 ----

    /// issue/revoke/consume 归并 + 重启恢复：used_count = 去重 consume 键数
    #[test]
    fn issue_revoke_consume_merge_and_restart() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("codes.jsonl");
        let ledger = CodeLedger::load(&path, &[]).unwrap();
        assert!(ledger.snapshot().is_empty());
        let (display, hash) = ledger
            .issue(IssueParams {
                alias_hint: Some("team-a".into()),
                max_uses: Some(2),
                expires_in_days: Some(7),
                default_ttl_days: Some(30),
            })
            .unwrap();
        let snap = ledger.snapshot();
        assert_eq!(snap.used_count(&hash), 0);
        assert_eq!(snap.len(), 1);
        let entry = &snap.entries()[0];
        assert_eq!(entry.max_uses, 2);
        assert_eq!(entry.default_ttl_days, 30);
        assert_eq!(entry.alias_hint.as_deref(), Some("team-a"));
        assert!(!entry.revoked);
        assert!(display.starts_with("dwebc1."), "码全文仅签发响应携带");

        // 直接落 consume 事件（文件入口形态的等价快捷路径：经 redeem 覆盖
        // 于 redeem 矩阵；此处钉归并语义）
        ledger::append_line(
            &path,
            "codes",
            &ledger::record_line(&consume_record(&hash, &key(1), &key(2), 100)).unwrap(),
        )
        .unwrap();
        ledger.reload(&[]).unwrap();
        assert_eq!(ledger.snapshot().used_count(&hash), 1);
        // 重复 consume 行（同三元组）按键去重
        ledger::append_line(
            &path,
            "codes",
            &ledger::record_line(&consume_record(&hash, &key(1), &key(2), 200)).unwrap(),
        )
        .unwrap();
        ledger.reload(&[]).unwrap();
        assert_eq!(ledger.snapshot().used_count(&hash), 1, "重复 consume 去重");
        // 他键 consume 计入
        ledger::append_line(
            &path,
            "codes",
            &ledger::record_line(&consume_record(&hash, &key(3), &key(4), 300)).unwrap(),
        )
        .unwrap();
        ledger.reload(&[]).unwrap();
        assert_eq!(ledger.snapshot().used_count(&hash), 2);

        // 吊销 → revoked；重启 load 恢复全部状态
        ledger.revoke(&hash).unwrap();
        assert!(ledger.snapshot().entries()[0].revoked);
        let reloaded = CodeLedger::load(&path, &[]).unwrap();
        let snap = reloaded.snapshot();
        assert!(snap.entries()[0].revoked, "重启后吊销状态恢复");
        assert_eq!(snap.used_count(&hash), 2, "重启后 used_count 不丢失");
    }

    /// 落行形状冻结：op/code_hash/ts 恒在；可选字段缺省不落
    #[test]
    fn jsonl_line_shape_frozen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("codes.jsonl");
        let ledger = CodeLedger::load(&path, &[]).unwrap();
        let (_, hash) = ledger.issue(IssueParams::default()).unwrap();
        let line = std::fs::read_to_string(&path).unwrap();
        let line = line.trim_end();
        assert!(
            line.starts_with("{\"op\":\"issue\",\"code_hash\":\""),
            "{line}"
        );
        assert!(line.contains(&format!("\"code_hash\":\"{}\"", hex::encode(hash))));
        assert!(line.contains("\"ts\":"));
        // 缺省值仍显式落行（max_uses/expires_at/default_ttl_days = 签发事实）
        assert!(line.contains("\"max_uses\":1"));
        assert!(line.contains("\"default_ttl_days\":30"));
        // consume 行：不落签发字段，携带三元组
        ledger::append_line(
            &path,
            "codes",
            &ledger::record_line(&consume_record(&hash, &key(1), &key(2), 7)).unwrap(),
        )
        .unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        let last = content.lines().last().unwrap();
        assert!(
            last.starts_with("{\"op\":\"consume\",\"code_hash\":\""),
            "{last}"
        );
        assert!(last.contains(&format!("\"fabric_id\":\"{}\"", hex::encode(key(1)))));
        assert!(last.contains(&format!("\"root\":\"{}\"", hex::encode(key(2)))));
        assert!(!last.contains("max_uses") && !last.contains("alias_hint"));
    }

    /// 旧格式/极简行兼容：只有 op/code_hash/ts 的行解析为默认码（max=1、
    /// 无过期、ttl=30）；坏行硬错误；文件缺失 = 空集合
    #[test]
    fn minimal_line_defaults_and_bad_line_fail_fast() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("codes.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"issue\",\"code_hash\":\"{}\",\"ts\":7}}\n",
                "31".repeat(32)
            ),
        )
        .unwrap();
        let snap = CodeLedger::load(&path, &[]).unwrap().snapshot();
        let entry = &snap.entries()[0];
        assert_eq!(entry.max_uses, 1);
        assert_eq!(entry.expires_at, None, "无 expires_at = 永久码");
        assert_eq!(entry.default_ttl_days, 30);
        assert_eq!(entry.issued_at, 7);
        // 坏行 load 硬错误（fail-fast 分级 (a) 的台账层事实源）
        std::fs::write(&path, "not json\n").unwrap();
        assert!(CodeLedger::load(&path, &[]).is_err());
        // 非法 code_hash 硬错误
        std::fs::write(&path, "{\"op\":\"issue\",\"code_hash\":\"zz\",\"ts\":1}\n").unwrap();
        assert!(CodeLedger::load(&path, &[]).is_err());
        // reload 失败保留旧快照（先恢复合法行构造基线快照）
        std::fs::write(
            &path,
            format!(
                "{{\"op\":\"issue\",\"code_hash\":\"{}\",\"ts\":7}}\n",
                "41".repeat(32)
            ),
        )
        .unwrap();
        let ledger = CodeLedger::load(&path, &[]).unwrap();
        assert_eq!(ledger.snapshot().len(), 1);
        std::fs::write(&path, "not json\n").unwrap();
        assert!(ledger.reload(&[]).is_err());
        assert_eq!(ledger.snapshot().len(), 1, "失败重载不破坏当前快照");
    }

    /// issue 输入上限矩阵（spec 冻结：max_uses ≤ 1000、expires_in_days ≥ 1、
    /// default_ttl_days ≥ 1、alias_hint ≤ 32 字节）
    #[test]
    fn issue_input_bounds() {
        let dir = TempDir::new().unwrap();
        let ledger = CodeLedger::load(&dir.path().join("codes.jsonl"), &[]).unwrap();
        assert!(
            ledger
                .issue(IssueParams {
                    max_uses: Some(1001),
                    ..Default::default()
                })
                .is_err()
        );
        assert!(
            ledger
                .issue(IssueParams {
                    max_uses: Some(0),
                    ..Default::default()
                })
                .is_err()
        );
        assert!(
            ledger
                .issue(IssueParams {
                    expires_in_days: Some(0),
                    ..Default::default()
                })
                .is_err()
        );
        assert!(
            ledger
                .issue(IssueParams {
                    default_ttl_days: Some(0),
                    ..Default::default()
                })
                .is_err()
        );
        assert!(
            ledger
                .issue(IssueParams {
                    alias_hint: Some("x".repeat(33)),
                    ..Default::default()
                })
                .is_err()
        );
        // 边界值合法（1000 / 1 / 1 / 恰 32 字节）
        ledger
            .issue(IssueParams {
                max_uses: Some(1000),
                expires_in_days: Some(1),
                default_ttl_days: Some(1),
                alias_hint: Some("y".repeat(32)),
            })
            .unwrap();
    }

    // ---- reconciliation（孤儿补齐）与 deny-set ----

    /// 孤儿补齐：带 via_code_hash 的 register 三元组在 load/reload 时补写
    /// consume；完整三元组匹配（同码他键不误补）；已 consume 的不重复补
    #[test]
    fn reconciliation_appends_missing_consumes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("codes.jsonl");
        let ledger = CodeLedger::load(&path, &[]).unwrap();
        let (_, hash) = ledger
            .issue(IssueParams {
                max_uses: Some(2),
                ..Default::default()
            })
            .unwrap();
        // 孤儿 1：K1（无 consume）；孤儿 2：同码 K2（无 consume）；非孤儿：K3 已 consume
        let k1 = (hash, key(1), key(2));
        let k3 = (hash, key(5), key(6));
        ledger::append_line(
            &path,
            "codes",
            &ledger::record_line(&consume_record(&k3.0, &k3.1, &k3.2, 50)).unwrap(),
        )
        .unwrap();
        let reloaded = CodeLedger::load(&path, &[k1, (hash, key(3), key(4)), k3]).unwrap();
        let snap = reloaded.snapshot();
        assert_eq!(snap.used_count(&hash), 3, "孤儿两键补齐 + 既有 1");
        assert!(snap.is_consumed(&k1));
        assert!(snap.is_consumed(&(hash, key(3), key(4))));
        assert!(snap.is_consumed(&k3));
        // 补写的 consume 行确实落盘（重启幂等——不再重复补）
        let reloaded2 = CodeLedger::load(&path, &[k1, (hash, key(3), key(4)), k3]).unwrap();
        assert_eq!(reloaded2.snapshot().used_count(&hash), 3);
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content
                .lines()
                .filter(|l| l.contains("\"op\":\"consume\""))
                .count(),
            3,
            "恰三条 consume（孤儿不重复补写）"
        );
    }

    /// 无孤儿 = 零补写（旧行/管理员直加行永不触发——orphans 由 owners 侧
    /// via_code_hash 事实源给出，本测试钉「空 orphans 零副作用」）
    #[test]
    fn reconciliation_without_orphans_is_noop() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("codes.jsonl");
        let ledger = CodeLedger::load(&path, &[]).unwrap();
        let (_, hash) = ledger.issue(IssueParams::default()).unwrap();
        let before = std::fs::read_to_string(&path).unwrap().lines().count();
        let reloaded = CodeLedger::load(&path, &[]).unwrap();
        assert_eq!(reloaded.snapshot().used_count(&hash), 0);
        let after = std::fs::read_to_string(&path).unwrap().lines().count();
        assert_eq!(before, after, "无孤儿不得追加任何行");
    }

    /// 补写 append 失败 → deny-set（分级 (b)：不上抛、保留快照、该码 503
    /// 语义由 redeem 消费）；恢复可写后同批孤儿 reload 补写成功 → deny 清空
    #[test]
    #[cfg(unix)]
    fn reconciliation_failure_denies_code_and_recovers() {
        if nix::unistd::Uid::effective().is_root() {
            // root 绕过 0500 目录权限，注入不成立（CI root 环境跳过）
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("codes.jsonl");
        let ledger = CodeLedger::load(&path, &[]).unwrap();
        let (_, hash) = ledger
            .issue(IssueParams {
                max_uses: Some(2),
                ..Default::default()
            })
            .unwrap();
        let orphan = (hash, key(1), key(2));
        // 文件 0444：读可行、append 拒绝（EACCES——目录 0500 不阻断对既有
        // 文件的 O_CREAT|O_APPEND，注入必须落在文件权限上）
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let denied = CodeLedger::load(&path, &[orphan]).unwrap();
        assert_eq!(denied.snapshot().used_count(&hash), 0, "补写失败不入计数");
        assert_eq!(denied.deny_count(), 1, "受影响码入 deny-set");
        // 兑换 fail-closed：503（Unavailable，而非 exhausted）
        let owners = OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap();
        assert!(matches!(
            denied.redeem(&owners, &hash, &key(1), &key(2), now_ms()),
            RedeemOutcome::Unavailable
        ));
        // 恢复可写 → 同批孤儿 reload 补写成功 → deny 移除、计数就位
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        denied.reload(&[orphan]).unwrap();
        assert_eq!(denied.deny_count(), 0, "补写成功移除 deny-set");
        assert_eq!(denied.snapshot().used_count(&hash), 1);
    }

    // ---- redeem 状态机 ----

    struct RedeemFixture {
        _dir: TempDir,
        owners: OwnerRegistry,
        codes: CodeLedger,
    }

    impl RedeemFixture {
        fn new(max_uses: u32) -> (Self, [u8; 32]) {
            let dir = TempDir::new().unwrap();
            let owners = OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap();
            let codes = CodeLedger::load(&dir.path().join("codes.jsonl"), &[]).unwrap();
            let (_, hash) = codes
                .issue(IssueParams {
                    max_uses: Some(max_uses),
                    expires_in_days: Some(7),
                    default_ttl_days: Some(30),
                    ..Default::default()
                })
                .unwrap();
            (
                Self {
                    _dir: dir,
                    owners,
                    codes,
                },
                hash,
            )
        }

        fn redeem(
            &self,
            hash: &[u8; 32],
            fabric: [u8; 32],
            root: [u8; 32],
            now: u64,
        ) -> RedeemOutcome {
            self.codes.redeem(&self.owners, hash, &fabric, &root, now)
        }
    }

    fn completed_expires(o: RedeemOutcome) -> u64 {
        match o {
            RedeemOutcome::Completed { expires_at } | RedeemOutcome::Replay { expires_at } => {
                expires_at
            }
            other => panic!("expected success outcome, got {other:?}"),
        }
    }

    /// 正常兑换：双 fsync 后 Completed；owners 出现该键；used_count=1；
    /// 同键重试（durable）= Replay 且 used_count 仍 1、expires_at 不刷新
    #[test]
    fn redeem_normal_idempotent_replay_no_refresh() {
        let (f, hash) = RedeemFixture::new(1);
        let now = now_ms();
        let e1 = completed_expires(f.redeem(&hash, key(1), key(2), now));
        assert_eq!(e1, now + 30 * 24 * 3_600_000);
        assert!(f.owners.snapshot().contains(&key(1), &key(2)));
        assert_eq!(f.codes.snapshot().used_count(&hash), 1);
        // 同键重试（新 ts）= 幂等回放：无新 consume、expires_at 不刷新
        let e2 = completed_expires(f.redeem(&hash, key(1), key(2), now + 60_000));
        assert_eq!(e2, e1, "幂等回放不刷新租期（进程内取首次值）");
        assert_eq!(f.codes.snapshot().used_count(&hash), 1);
        // 他键（max_uses=1 已耗尽）→ exhausted（同键回放不耗尽语义的对偶面）
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now),
            RedeemOutcome::Exhausted
        ));
    }

    /// max_uses=2 串行序列（spec Scenario）：K1 首兑 → K1 同键回放（计数仍
    /// 1）→ K2 成功（计数 2）
    #[test]
    fn redeem_max_uses_two_serial_sequence() {
        let (f, hash) = RedeemFixture::new(2);
        let now = now_ms();
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Completed { .. }
        ));
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now + 1),
            RedeemOutcome::Replay { .. }
        ));
        assert_eq!(f.codes.snapshot().used_count(&hash), 1, "回放不增计数");
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 2),
            RedeemOutcome::Completed { .. }
        ));
        assert_eq!(f.codes.snapshot().used_count(&hash), 2);
        // 耗尽后他键拒绝；K1/K2 同键仍可回放
        assert!(matches!(
            f.redeem(&hash, key(5), key(6), now + 3),
            RedeemOutcome::Exhausted
        ));
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now + 4),
            RedeemOutcome::Replay { .. }
        ));
    }

    /// 码状态矩阵：未命中/吊销 → Invalid；过期（等值=过期）→ Expired；
    /// 吊销后同键已消费仍可回放（吊销阻断新兑换，不改写既有兑换事实）
    #[test]
    fn redeem_status_matrix() {
        let (f, hash) = RedeemFixture::new(1);
        let now = now_ms();
        let unknown = code_hash("0123456789abcdea");
        assert!(matches!(
            f.redeem(&unknown, key(1), key(2), now),
            RedeemOutcome::Invalid
        ));
        // 吊销 → 新兑换 Invalid（未消费过的键在吊销后不可再兑）
        f.codes.revoke(&hash).unwrap();
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Invalid
        ));
        // 过期：issue 一个已过期的码（文件入口）
        let dir2 = TempDir::new().unwrap();
        let path2 = dir2.path().join("codes.jsonl");
        let expired_hash = code_hash("0123456789abcdeb");
        std::fs::write(
            &path2,
            format!(
                "{{\"op\":\"issue\",\"code_hash\":\"{}\",\"max_uses\":1,\"expires_at\":1000,\"default_ttl_days\":30,\"ts\":1}}\n",
                hex::encode(expired_hash)
            ),
        )
        .unwrap();
        let owners2 = OwnerRegistry::load(&dir2.path().join("owners.jsonl")).unwrap();
        let codes2 = CodeLedger::load(&path2, &[]).unwrap();
        assert!(
            matches!(
                codes2.redeem(&owners2, &expired_hash, &key(1), &key(2), 999),
                RedeemOutcome::Completed { .. }
            ),
            "到期前活跃"
        );
        assert!(
            matches!(
                codes2.redeem(&owners2, &expired_hash, &key(3), &key(4), 1000),
                RedeemOutcome::Expired
            ),
            "等值 = 过期（过期判定先于耗尽——次序冻结）"
        );
    }

    /// 续期语义（spec Scenario「重复注册为续期」）：同 (fabric,root) 持**新
    /// 有效码**再兑换 → expires_at 刷新为 now + 新码 default_ttl_days；名册
    /// 不重复建条目；alias/note 保留（register_via_code 的合并语义）
    #[test]
    fn redeem_renewal_via_new_code_refreshes() {
        let (f, hash1) = RedeemFixture::new(1);
        let now = now_ms();
        let e1 = completed_expires(f.redeem(&hash1, key(1), key(2), now));
        // 文件入口给该租户设置 alias（模拟既有元数据）
        let owners_path = f.owners.path();
        std::fs::write(
            owners_path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":1,\"expires_at\":{e1},\"alias\":\"kept\"}}\n",
                hex::encode(key(1)),
                hex::encode(key(2))
            ),
        )
        .unwrap();
        f.owners.reload().unwrap();
        // 新码（default_ttl_days=7）兑换同键 → 刷新租期 + 保留 alias
        let (_, hash2) = f
            .codes
            .issue(IssueParams {
                default_ttl_days: Some(7),
                ..Default::default()
            })
            .unwrap();
        let later = now + 3_600_000;
        let e2 = completed_expires(f.redeem(&hash2, key(1), key(2), later));
        assert_eq!(e2, later + 7 * 24 * 3_600_000, "持新码 = 刷新为新码租期");
        assert!(
            e2 < e1,
            "新码 7 天 < 首码 30 天（租期随新码 default_ttl_days 重算）"
        );
        let entries = f.owners.snapshot().entries();
        assert_eq!(entries.len(), 1, "名册不重复建条目");
        assert_eq!(entries[0].alias.as_deref(), Some("kept"), "续期保留 alias");
        assert_eq!(entries[0].expires_at, Some(e2));
        // 新码也计入消费（各码独立计数）
        assert_eq!(f.codes.snapshot().used_count(&hash2), 1);
        assert_eq!(f.codes.snapshot().used_count(&hash1), 1);
    }

    /// 并发双兑恰一成功（max_uses=1）：codes.jsonl 恰一条 consume、无半提交
    #[test]
    fn redeem_concurrent_double_redemption_single_winner() {
        let (f, hash) = RedeemFixture::new(1);
        let f = std::sync::Arc::new(f);
        let now = now_ms();
        let mut handles = Vec::new();
        for seed in 0..2u8 {
            let f = std::sync::Arc::clone(&f);
            handles.push(std::thread::spawn(move || {
                matches!(
                    f.redeem(&hash, key(seed + 1), key(seed + 10), now),
                    RedeemOutcome::Completed { .. }
                )
            }));
        }
        let results: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(
            results.iter().filter(|r| **r).count(),
            1,
            "恰一个成功：{results:?}"
        );
        let content = std::fs::read_to_string(f.codes.path()).unwrap();
        assert_eq!(
            content
                .lines()
                .filter(|l| l.contains("\"op\":\"consume\""))
                .count(),
            1,
            "codes.jsonl 恰一条 consume 事件"
        );
        assert_eq!(f.codes.snapshot().used_count(&hash), 1);
    }

    /// pending 全矩阵见 redeem_pending_matrix_via_chmod（codes.jsonl 0444
    /// 注入：K1 Io → K2 409 → 同键 Io → 恢复后补写完成不刷租期 → K2 耗尽）
    #[test]
    #[cfg(unix)]
    fn redeem_pending_second_key_409_and_same_key_completion() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (f, hash) = RedeemFixture::new(1);
        let now = now_ms();
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        // ① K1：register durable、consume 失败 → Io（500 事实源）
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Io(_)
        ));
        assert!(
            f.owners.snapshot().contains(&key(1), &key(2)),
            "register 已 durable（跨台账提交 ① 完成而 ② 失败）"
        );
        assert_eq!(f.codes.snapshot().used_count(&hash), 0, "未归并不计数");
        assert_eq!(f.codes.deny_count(), 1, "consume 失败入 deny-set");
        // ② K2 他键 → 409 PendingOtherKey（不得按 used_count=0 放行）
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 1),
            RedeemOutcome::PendingOtherKey
        ));
        // ③ 恢复可写 → K1 同键补写完成，租期 = 首次计算值（不刷新）
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let e = completed_expires(f.redeem(&hash, key(1), key(2), now + 3));
        assert_eq!(e, now + 30 * 24 * 3_600_000, "补写不重新计算租期");
        assert_eq!(f.codes.snapshot().used_count(&hash), 1);
        assert_eq!(f.codes.deny_count(), 0, "补写成功清 deny-set");
        // ④ K2 → Exhausted（max_uses=1；pending 释放后按码状态裁决）
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 4),
            RedeemOutcome::Exhausted
        ));
    }

    /// 补写失败期间的同键重试（仍 0444）→ Io 且不重复 register（幂等完成
    /// 路径不追加第二行 owners 事件）
    #[test]
    #[cfg(unix)]
    fn redeem_pending_retry_while_still_failing_no_duplicate_register() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (f, hash) = RedeemFixture::new(1);
        let now = now_ms();
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Io(_)
        ));
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now + 1),
            RedeemOutcome::Io(_)
        ));
        let owners_content = std::fs::read_to_string(f.owners.path()).unwrap();
        assert_eq!(
            owners_content.lines().count(),
            1,
            "同键重试不重复 register（幂等完成路径）"
        );
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    /// 崩溃恢复（spec Scenario「register 落盘后崩溃，恢复补齐 consume」的
    /// 台账层）：register（含 via_code_hash）fsync 后、consume 前进程死亡 =
    /// 磁盘孤儿形态；重启 load 归并补齐 consume → 完整兑换（租户在册 +
    /// 计数正确）；同码幂等收敛不产生第二次租户条目
    #[test]
    fn crash_recovery_completes_orphan_consume() {
        let dir = TempDir::new().unwrap();
        let codes_path = dir.path().join("codes.jsonl");
        let owners_path = dir.path().join("owners.jsonl");
        // 进程 A：签发 + 兑换至 register fsync 后崩溃（手工构型等价磁盘态）
        let dead = CodeLedger::load(&codes_path, &[]).unwrap();
        let (_, hash) = dead
            .issue(IssueParams {
                default_ttl_days: Some(30),
                ..Default::default()
            })
            .unwrap();
        let expires = now_ms() + 30 * 24 * 3_600_000;
        std::fs::write(
            &owners_path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":{expires},\"via_code_hash\":\"{}\"}}\n",
                hex::encode(key(1)),
                hex::encode(key(2)),
                hex::encode(hash)
            ),
        )
        .unwrap();
        // 进程 B：重启 → owners 归并出孤儿 → codes load 同锁补齐 consume
        let owners = OwnerRegistry::load(&owners_path).unwrap();
        let orphans = owners.snapshot().code_orphans();
        assert_eq!(orphans, vec![(hash, key(1), key(2))]);
        let codes = CodeLedger::load(&codes_path, &orphans).unwrap();
        assert_eq!(codes.snapshot().used_count(&hash), 1, "启动补齐 consume");
        assert!(
            owners.snapshot().contains(&key(1), &key(2)),
            "租户在册（完整兑换，无烧码无租户）"
        );
        // 重启后同键重试 = 幂等回放（不产生第二 consume/条目）
        let e = completed_expires(codes.redeem(&owners, &hash, &key(1), &key(2), now_ms()));
        assert_eq!(e, expires, "回放回落 owners 持久值（consume 行不带租期）");
        assert_eq!(codes.snapshot().used_count(&hash), 1);
        let oc = std::fs::read_to_string(&owners_path).unwrap();
        assert_eq!(oc.lines().count(), 1);
    }

    /// 幂等回放与 owners 状态解耦：consume durable + owners 条目被注销 →
    /// 回放仍 200。进程内取首次兑换租期；重启后（consume 行不带租期）回落
    /// owners 当前持久值——条目缺失时为 u64::MAX（注册已不在册，回放仅
    /// 确认兑换事实）
    #[test]
    fn replay_after_unregister_falls_back() {
        let (f, hash) = RedeemFixture::new(1);
        let now = now_ms();
        let e1 = completed_expires(f.redeem(&hash, key(1), key(2), now));
        f.owners.unregister(&key(1), &key(2)).unwrap();
        let e2 = completed_expires(f.redeem(&hash, key(1), key(2), now));
        assert_eq!(e2, e1, "进程内回放取首次兑换租期（与 owners 状态无关）");
        // 重启等价：磁盘归并（consume 无租期）→ 回放回落 owners 持久值
        let owners2 = OwnerRegistry::load(f.owners.path()).unwrap();
        let codes2 = CodeLedger::load(f.codes.path(), &[]).unwrap();
        let e3 = completed_expires(codes2.redeem(&owners2, &hash, &key(1), &key(2), now));
        assert_eq!(
            e3,
            u64::MAX,
            "重启后回落：条目缺失 → MAX（wire 恒数字约束）"
        );
    }

    /// 热重载看护：运行中文件入口追加孤儿 register → mtime reload 补齐
    /// consume（同锁、完整三元组）
    #[tokio::test]
    async fn watcher_picks_up_orphans_on_owners_change() {
        use std::time::Instant;
        let dir = TempDir::new().unwrap();
        let codes_path = dir.path().join("codes.jsonl");
        let owners_path = dir.path().join("owners.jsonl");
        let owners = Arc::new(OwnerRegistry::load(&owners_path).unwrap());
        let codes = Arc::new(CodeLedger::load(&codes_path, &[]).unwrap());
        let (_, hash) = codes.issue(IssueParams::default()).unwrap();
        let handle = spawn_codes_ledger_watcher_every(
            Arc::clone(&codes),
            Arc::clone(&owners),
            Duration::from_millis(30),
        );
        tokio::time::sleep(Duration::from_millis(60)).await;
        // 文件入口追加带 via_code_hash 的 register（无 consume）
        std::fs::write(
            &owners_path,
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":1,\"via_code_hash\":\"{}\"}}\n",
                hex::encode(key(1)),
                hex::encode(key(2)),
                hex::encode(hash)
            ),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if codes.snapshot().used_count(&hash) == 1 {
                handle.abort();
                assert!(
                    codes.snapshot().is_consumed(&(hash, key(1), key(2))),
                    "完整三元组补齐"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        handle.abort();
        panic!("热重载未在 2s 内补齐孤儿 consume");
    }

    /// r11-P1-1：owner 指纹变化后 owners 读取失败（注入 0o000）→ 本轮
    /// codes reload 必须不发布不推进（旧实现用旧孤儿集继续 reload 并推进
    /// 指纹）；恢复读权限（chmod 不改 mtime/len——指纹不变）后必须重试并
    /// 补齐孤儿，终态 used_count/deny/配额正确（新 register 占用的码不可
    /// 超兑 max_uses）。注入确定性：先取 append 句柄再 chmod——已打开 fd
    /// 保留写权，写入落地时文件已不可读，无「成功窗口」竞态。
    #[tokio::test]
    #[cfg(unix)]
    async fn watcher_owners_read_failure_defers_codes_reload_then_backfills() {
        if nix::unistd::Uid::effective().is_root() {
            // root 绕过 0o000 读权限，注入不成立（CI root 环境跳过）
            return;
        }
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;
        let dir = TempDir::new().unwrap();
        let codes_path = dir.path().join("codes.jsonl");
        let owners_path = dir.path().join("owners.jsonl");
        // 先建空 owners 文件（load 对缺失文件不落盘）：看护启动时指纹即
        // 稳定为 (mtime, 0)，后续「摘权限→写入」不存在建文件窗口
        std::fs::write(&owners_path, b"").unwrap();
        let owners = Arc::new(OwnerRegistry::load(&owners_path).unwrap());
        let codes = Arc::new(CodeLedger::load(&codes_path, &[]).unwrap());
        let (_, hash) = codes
            .issue(IssueParams {
                max_uses: Some(1),
                ..Default::default()
            })
            .unwrap();
        let handle = spawn_codes_ledger_watcher_every(
            Arc::clone(&codes),
            Arc::clone(&owners),
            Duration::from_millis(30),
        );
        tokio::time::sleep(Duration::from_millis(60)).await;
        let gen_before = codes.snapshot().generation();
        // 先摘读权限，再经预先打开的 append 句柄写入外部孤儿 register：
        // 写入落地即指纹已变且不可读——失败窗口内每个 tick 都必然失败
        let mut owners_file = std::fs::OpenOptions::new()
            .append(true)
            .open(&owners_path)
            .unwrap();
        std::fs::set_permissions(&owners_path, std::fs::Permissions::from_mode(0o000)).unwrap();
        writeln!(
            owners_file,
            "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":1,\"via_code_hash\":\"{}\"}}",
            hex::encode(key(1)),
            hex::encode(key(2)),
            hex::encode(hash)
        )
        .unwrap();
        owners_file.sync_all().unwrap();
        // 失败窗口：多轮 tick 后 codes reload 未发布（generation 不变——
        // 旧实现此处每轮以旧孤儿集发布 generation+1）、未补齐、无 deny
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            codes.snapshot().generation(),
            gen_before,
            "owners 读取失败期间不得发布 codes reload（旧实现以旧孤儿集发布）"
        );
        assert_eq!(codes.snapshot().used_count(&hash), 0, "失败窗口不补齐");
        assert_eq!(codes.deny_count(), 0);
        // 恢复读权限：chmod 只改 ctime——mtime/len 与失败窗口一致（指纹
        // 不变），待重试路径仍必须触发并补齐孤儿
        std::fs::set_permissions(&owners_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && codes.snapshot().used_count(&hash) == 0 {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        handle.abort();
        assert_eq!(
            codes.snapshot().used_count(&hash),
            1,
            "权限恢复（指纹不变）后必须重试并补齐孤儿 consume"
        );
        assert!(
            codes.snapshot().is_consumed(&(hash, key(1), key(2))),
            "完整三元组补齐"
        );
        assert_eq!(codes.deny_count(), 0, "整轮成功终态无 deny");
        // 配额终态：新 register 已占满 max_uses=1——同键幂等回放 200，
        // 他键不可超兑（exhausted，而非复活可兑）
        assert!(matches!(
            codes.redeem(&owners, &hash, &key(1), &key(2), now_ms()),
            RedeemOutcome::Replay { .. }
        ));
        assert!(matches!(
            codes.redeem(&owners, &hash, &key(3), &key(4), now_ms()),
            RedeemOutcome::Exhausted
        ));
    }

    // ---- r8 验收：P0-1 写序列化协议 / P1-1 pending 释放 ----

    /// ①（r8-P0-1，barrier）：reload 读盘完成后、发布前暂停（持锁），期间
    /// 发起 max_uses=1 兑换并恢复 reload——写序列化协议下兑换与发布互斥
    /// 排序，consume 计数不得丢失：同码他键必须仍 code-exhausted（旧实现
    /// 读盘在锁外，暂停期间完成的兑换会被旧快照覆盖 → 计数复活 → 绕过
    /// max_uses）
    #[test]
    fn reload_barrier_read_pause_then_redeem_keeps_exhausted() {
        let (f, hash) = RedeemFixture::new(1);
        let f = std::sync::Arc::new(f);
        let now = now_ms();
        let (fired_tx, fired_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        test_hooks::arm(fired_tx, release_rx);
        let reloader = {
            let f = std::sync::Arc::clone(&f);
            std::thread::spawn(move || f.codes.reload(&[]).unwrap())
        };
        fired_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("reload 已完成读盘（发布前、持锁暂停）");
        // 暂停窗口内发起兑换：协议下与 reload 的发布互斥（阻塞至其完成）
        let redeemer = {
            let f = std::sync::Arc::clone(&f);
            std::thread::spawn(move || {
                matches!(
                    f.redeem(&hash, key(1), key(2), now),
                    RedeemOutcome::Completed { .. }
                )
            })
        };
        std::thread::sleep(Duration::from_millis(50)); // 确保兑换线程已竞争锁
        release_tx.send(()).expect("恢复 reload");
        reloader.join().unwrap();
        assert!(redeemer.join().unwrap(), "K1 兑换完成");
        // 兑换事实无损：快照计数 / 磁盘 consume 行 / durable 键命中
        assert_eq!(f.codes.snapshot().used_count(&hash), 1);
        assert!(f.codes.snapshot().is_consumed(&(hash, key(1), key(2))));
        let content = std::fs::read_to_string(f.codes.path()).unwrap();
        assert_eq!(
            content
                .lines()
                .filter(|l| l.contains("\"op\":\"consume\""))
                .count(),
            1,
            "恰一条 consume 事件"
        );
        // 同码他键：必须仍 exhausted（旧实现此处复活为可兑——P0 安全语义）
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now),
            RedeemOutcome::Exhausted
        ));
    }

    /// ⑤（r8-P1-1，max_uses=2）：consume append 失败 → pending+deny-set →
    /// 恢复可写 → **同一 ledger** reload 补齐孤儿 → pending 释放 → 同码
    /// 他键 K2 成功（旧实现 pending 永不清 → K2 滞留 409 code-pending；
    /// 现有恢复测试用新 load，不覆盖同 ledger 路径）
    #[test]
    #[cfg(unix)]
    fn reload_reconciliation_releases_pending_k2_succeeds_same_ledger() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (f, hash) = RedeemFixture::new(2);
        let now = now_ms();
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Io(_)
        ));
        assert_eq!(f.codes.deny_count(), 1, "consume 失败入 deny-set");
        // 恢复可写 → 同一 ledger reload（orphans = owners 侧事实源）补齐
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let orphans = f.owners.snapshot().code_orphans();
        assert_eq!(orphans, vec![(hash, key(1), key(2))]);
        f.codes.reload(&orphans).unwrap();
        assert_eq!(f.codes.deny_count(), 0, "补写成功清 deny-set");
        assert_eq!(f.codes.snapshot().used_count(&hash), 1);
        // 同码他键 K2：pending 已释放（不再 409）且计数 1 < 2 → 成功
        assert!(
            matches!(
                f.redeem(&hash, key(3), key(4), now + 1),
                RedeemOutcome::Completed { .. }
            ),
            "K2 必须成功（旧实现此处为 PendingOtherKey 409）"
        );
        assert_eq!(f.codes.snapshot().used_count(&hash), 2);
    }

    /// ⑥（r8-P1-1，max_uses=1）：同场景 reload 补齐后 pending 已清且计数
    /// 正确 → K2 = code-exhausted（而非 409 code-pending / 复活可兑）
    #[test]
    #[cfg(unix)]
    fn reload_reconciliation_releases_pending_k2_exhausted_max1() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (f, hash) = RedeemFixture::new(1);
        let now = now_ms();
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Io(_)
        ));
        assert_eq!(f.codes.deny_count(), 1);
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let orphans = f.owners.snapshot().code_orphans();
        assert_eq!(orphans, vec![(hash, key(1), key(2))]);
        f.codes.reload(&orphans).unwrap();
        assert_eq!(f.codes.deny_count(), 0);
        assert_eq!(f.codes.snapshot().used_count(&hash), 1, "补齐后计数就位");
        // 同码他键 K2：pending 已清、按码状态裁决 → exhausted
        assert!(
            matches!(
                f.redeem(&hash, key(3), key(4), now + 1),
                RedeemOutcome::Exhausted
            ),
            "K2 必须 code-exhausted（不得 409 pending，也不得复活可兑）"
        );
        assert_eq!(f.codes.snapshot().used_count(&hash), 1);
    }

    /// ⑦（r9-P1-1）：同 ledger 已有 pending → reload 补写 append 失败 =
    /// **保留既有 current snapshot**（generation/内容不变——冻结 spec
    /// 「补写失败 = 保留当前快照 + 受影响码进 deny-set」），deny 合并且
    /// 来源改判 reconciliation：同键重试仍走幂等补写恢复路径（再失败 =
    /// 500，而非 503）；他键自此 **503 code-unavailable 优先于 409**。
    /// 对照面：reload 之前（deny 来源 = redemption）他键仍 409——
    /// 「pending 期间第二幂等键被拒」的既有语义不回退
    #[test]
    #[cfg(unix)]
    fn reload_reconciliation_failure_keeps_snapshot_same_key_500_other_key_503() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (f, hash) = RedeemFixture::new(2);
        let now = now_ms();
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        // K1 首兑：register durable、consume append 失败 → 500 + pending +
        // deny（来源 redemption——pending 窗口他键仍 409）
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Io(_)
        ));
        assert_eq!(f.codes.deny_count(), 1);
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 1),
            RedeemOutcome::PendingOtherKey
        ));
        // 同 ledger reload（磁盘仍 0444）：读盘成功、孤儿补写 append 失败 =
        // 部分失败——不上抛、保留既有快照、仅合并 deny
        let gen_before = f.codes.snapshot().generation();
        let entries_before = f.codes.snapshot().entries();
        let orphans = f.owners.snapshot().code_orphans();
        assert_eq!(orphans, vec![(hash, key(1), key(2))]);
        f.codes.reload(&orphans).unwrap();
        let snap = f.codes.snapshot();
        assert_eq!(
            snap.generation(),
            gen_before,
            "generation 不变（未发布新快照）"
        );
        assert_eq!(snap.entries(), entries_before, "快照内容不变（保留既有）");
        assert_eq!(snap.used_count(&hash), 0, "失败补写不入计数");
        assert_eq!(f.codes.deny_count(), 1, "deny 合并（同 hash 不重复计入）");
        // 同键重试：幂等补写恢复路径继续（r9 裁决——deny 不阻断恢复通道）
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now + 2),
            RedeemOutcome::Io(_)
        ));
        // 他键：reconciliation 来源 deny → 503 优先于 409（冻结语义）
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 3),
            RedeemOutcome::Unavailable
        ));
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    /// ⑧（r9-P1-1 恢复面）：部分失败轮之后磁盘恢复 → reload 整轮成功 =
    /// 发布新快照（generation 前进）+ 清 deny + 释放 pending；K1 同键 =
    /// durable 幂等回放（200），K2 他键**按码状态正常裁决**（max_uses=1 →
    /// code-exhausted——不再 503/409，也不得复活可兑）
    #[test]
    #[cfg(unix)]
    fn reload_recovery_after_partial_failure_adjudicates_by_code_state() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (f, hash) = RedeemFixture::new(1);
        let now = now_ms();
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Io(_)
        ));
        let orphans = f.owners.snapshot().code_orphans();
        // 部分失败轮：快照保留 + deny（他键自此 503）
        let gen_before = f.codes.snapshot().generation();
        f.codes.reload(&orphans).unwrap();
        assert_eq!(f.codes.snapshot().generation(), gen_before);
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 1),
            RedeemOutcome::Unavailable
        ));
        // 磁盘恢复 → 整轮成功：发布新快照 + 清 deny + 释放 pending
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        f.codes.reload(&orphans).unwrap();
        assert_eq!(f.codes.deny_count(), 0, "补写成功清 deny-set");
        assert_eq!(f.codes.snapshot().used_count(&hash), 1, "发布补写后的计数");
        assert_ne!(
            f.codes.snapshot().generation(),
            gen_before,
            "整轮成功发布新快照（generation 前进）"
        );
        // K1 同键：durable 幂等回放（200，零新副作用）
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now + 2),
            RedeemOutcome::Replay { .. }
        ));
        // K2 他键：按码状态裁决 → exhausted（r9 建议场景）
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 3),
            RedeemOutcome::Exhausted
        ));
        assert_eq!(f.codes.snapshot().used_count(&hash), 1);
    }

    /// ⑨（r10-P1-1，混合 hash）：同轮两个不同 code hash 的孤儿补写产生
    /// **混合结果**——首个孤儿 append 成功（hook 暂停后 chmod 0444）、同轮
    /// 第二个孤儿 append 失败 = 部分失败轮。成功侧的 consume 已 durable
    /// 落盘，但旧快照保留（未发布、used_count 不推进）：fail-closed 面 =
    /// 未被已发布快照覆盖的全部孤儿 hash，**成功侧与失败侧均入 deny**
    /// （Reconciliation 来源）——成功侧的他键请求 503，不得按旧 used_count
    /// 放行（旧实现成功侧不在 deny → 他键可再兑 → durable 计数超出
    /// max_uses）。整轮成功恢复后两侧计数覆盖全部 durable 三元组、deny
    /// 清空、他键按码状态裁决。孤儿序由 BTreeSet 字节序决定，断言对两侧
    /// 对称成立。
    #[test]
    #[cfg(unix)]
    fn reload_partial_failure_mixed_hashes_fail_closed() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (f, hash_a) = RedeemFixture::new(1);
        let (_, hash_b) = f.codes.issue(IssueParams::default()).unwrap();
        let orphan_a = (hash_a, key(1), key(2));
        let orphan_b = (hash_b, key(3), key(4));
        // owners 侧两个孤儿 register（文件入口 durable）
        let expires = now_ms() + 30 * 24 * 3_600_000;
        std::fs::write(
            f.owners.path(),
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":1,\"expires_at\":{expires},\"via_code_hash\":\"{}\"}}\n{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":1,\"expires_at\":{expires},\"via_code_hash\":\"{}\"}}\n",
                hex::encode(key(1)),
                hex::encode(key(2)),
                hex::encode(hash_a),
                hex::encode(key(3)),
                hex::encode(key(4)),
                hex::encode(hash_b),
            ),
        )
        .unwrap();
        let orphans = f.owners.reload_for_orphans().unwrap();
        assert_eq!(orphans.len(), 2);
        // barrier hook：首个孤儿补写 append 成功后暂停（持台账锁）——期间
        // chmod 0444，同轮第二个孤儿补写失败 = 真实混合结果（成功侧 append
        // 有磁盘副作用，非「预先 durable」等价构型）
        let (fired_tx, fired_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        test_hooks::arm_orphan_append(fired_tx, release_rx);
        let f = std::sync::Arc::new(f);
        let orphans_thread = orphans.clone();
        let reloader = {
            let f = std::sync::Arc::clone(&f);
            std::thread::spawn(move || f.codes.reload(&orphans_thread).unwrap())
        };
        fired_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("首个孤儿补写 append 已成功（hook 暂停）");
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        release_tx.send(()).expect("恢复 reload（后续补写将失败）");
        reloader.join().unwrap();
        // 部分失败轮：旧快照保留（成功侧 durable consume 不入计数）+ 两侧
        // 孤儿 hash 均 deny——成功侧未被已发布快照覆盖（r10-P1-1 核心）
        let snap = f.codes.snapshot();
        assert_eq!(snap.used_count(&hash_a), 0, "成功侧 durable 但快照未发布");
        assert_eq!(snap.used_count(&hash_b), 0);
        assert!(f.codes.is_denied(&hash_a), "成功侧孤儿必须 fail-closed");
        assert!(f.codes.is_denied(&hash_b), "失败侧孤儿照旧 deny");
        // 成功侧的他键：503（不得按旧计数 used=0 < max_uses=1 放行——旧实现
        // 此处可 Completed，durable consume 变 2 > max_uses=1）
        assert!(matches!(
            f.redeem(&hash_a, key(5), key(6), now_ms()),
            RedeemOutcome::Unavailable
        ));
        // 恢复（整轮成功）：快照计数覆盖全部 durable 三元组 + deny 清空
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        f.codes.reload(&orphans).unwrap();
        let snap = f.codes.snapshot();
        assert_eq!(snap.used_count(&hash_a), 1, "成功侧 durable consume 入计数");
        assert_eq!(snap.used_count(&hash_b), 1, "失败侧整轮补写成功入计数");
        assert!(snap.is_consumed(&orphan_a));
        assert!(snap.is_consumed(&orphan_b));
        assert_eq!(f.codes.deny_count(), 0, "整轮成功清空 deny");
        // 他键按码状态裁决：两侧均 max_uses=1 已耗尽（不复活）
        assert!(matches!(
            f.redeem(&hash_a, key(5), key(6), now_ms()),
            RedeemOutcome::Exhausted
        ));
        assert!(matches!(
            f.redeem(&hash_b, key(5), key(6), now_ms()),
            RedeemOutcome::Exhausted
        ));
    }

    /// ⑩（r10-P1-1，同 hash 多孤儿）：max_uses=2 的同码两个孤儿——K1 为本
    /// 进程 pending（首兑 consume 失败），K2 的 consume 已 durable 落盘但
    /// 未入快照（文件入口）。部分失败轮（K1 补写失败）把该码判入
    /// Reconciliation deny；随后**同键 K1 恢复成功**（幂等补写完成当前请求）
    /// 时 deny **不得被 complete_pending 成功分支提前清除**（旧实现无条件
    /// 移除）——K2 仍被旧快照隐藏，剩余他键 K3 若放行则 durable 计数 =
    /// K1+K2+K3 = 3 > max_uses=2。整轮成功恢复后快照计数覆盖 K1/K2 全部
    /// durable 三元组、deny 清空、他键按码状态裁决。
    #[test]
    #[cfg(unix)]
    fn reload_partial_failure_same_hash_pending_completion_keeps_deny() {
        if nix::unistd::Uid::effective().is_root() {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (f, hash) = RedeemFixture::new(2);
        let now = now_ms();
        // K1 首兑：owners register durable、codes consume append 失败（0444）
        // → Io + pending + deny（来源 Redemption）
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now),
            RedeemOutcome::Io(_)
        ));
        // K2 孤儿：codes consume 已 durable 落盘（文件入口，对内存快照隐藏）
        // + owners register（via_code_hash，追加保留 K1 行）
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        ledger::append_line(
            f.codes.path(),
            "codes",
            &ledger::record_line(&consume_record(&hash, &key(3), &key(4), 100)).unwrap(),
        )
        .unwrap();
        let expires = now + 30 * 24 * 3_600_000;
        {
            use std::io::Write as _;
            let mut owners = std::fs::OpenOptions::new()
                .append(true)
                .open(f.owners.path())
                .unwrap();
            writeln!(
                owners,
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":{expires},\"via_code_hash\":\"{}\"}}",
                hex::encode(key(3)),
                hex::encode(key(4)),
                hex::encode(hash)
            )
            .unwrap();
        }
        let orphans = f.owners.reload_for_orphans().unwrap();
        assert_eq!(orphans.len(), 2, "K1 + K2 两个孤儿（via_code 全集）");
        // 部分失败轮（codes 仍 0444）：K2 consume 已在磁盘（归并跳过补写）、
        // K1 补写 append 失败 → 旧快照保留 + 同码 deny（来源 Reconciliation）
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o444)).unwrap();
        f.codes.reload(&orphans).unwrap();
        assert_eq!(
            f.codes.snapshot().used_count(&hash),
            0,
            "K2 durable consume 仍被旧快照隐藏"
        );
        assert_eq!(f.codes.deny_count(), 1);
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 1),
            RedeemOutcome::Unavailable
        ));
        // 同键 K1 恢复成功（磁盘恢复可写）：当前请求完成（幂等恢复路径保持）
        // 但 Reconciliation deny 不清（K2 仍未入已发布快照）
        std::fs::set_permissions(f.codes.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let e = completed_expires(f.redeem(&hash, key(1), key(2), now + 2));
        assert_eq!(e, now + 30 * 24 * 3_600_000, "补写不重新计算租期");
        assert_eq!(f.codes.snapshot().used_count(&hash), 1, "仅 K1 入计数");
        assert!(
            f.codes.is_denied(&hash),
            "Reconciliation deny 不得被同键补写成功提前清除（r10-P1-1）"
        );
        // 剩余他键 K3：503 fail-closed——不得按旧计数越过配额（旧实现：deny
        // 已被清 → used=1 < 2 放行 K3 → durable K1+K2+K3 = 3 > max_uses=2）
        assert!(matches!(
            f.redeem(&hash, key(5), key(6), now + 3),
            RedeemOutcome::Unavailable
        ));
        // 整轮成功恢复：快照计数覆盖全部 durable 三元组（K1+K2）+ deny 清空
        f.codes.reload(&orphans).unwrap();
        let snap = f.codes.snapshot();
        assert_eq!(snap.used_count(&hash), 2, "K1/K2 全部 durable 三元组入计数");
        assert!(snap.is_consumed(&(hash, key(1), key(2))));
        assert!(snap.is_consumed(&(hash, key(3), key(4))));
        assert_eq!(f.codes.deny_count(), 0, "整轮成功清空 deny");
        // 他键按码状态裁决 → exhausted；K1/K2 同键 = 幂等回放
        assert!(matches!(
            f.redeem(&hash, key(5), key(6), now + 4),
            RedeemOutcome::Exhausted
        ));
        assert!(matches!(
            f.redeem(&hash, key(1), key(2), now + 5),
            RedeemOutcome::Replay { .. }
        ));
        assert!(matches!(
            f.redeem(&hash, key(3), key(4), now + 6),
            RedeemOutcome::Replay { .. }
        ));
    }

    /// ④（r8-P0-1，锁序压力）：并发 redeem（codes→owners 单向锁序）与
    /// owners/codes 各自 reload（单锁、看护同序两步不嵌套）持续交错——
    /// 锁图无环不得死锁（有界超时断言）；终态一致：每码 used_count = 完成
    /// 兑换数（内存与 reload 自磁盘复核同值）、owners 全部在册
    #[test]
    fn concurrent_redeem_and_dual_ledger_reload_no_deadlock() {
        const WORKERS: usize = 3;
        const PER_WORKER: u8 = 40;
        let (f, _) = RedeemFixture::new(1);
        // 每个兑换线程独占一个码（避免同码他键 pending 窗口的 409 噪声）
        let hashes: Vec<[u8; 32]> = (0..WORKERS)
            .map(|_| {
                f.codes
                    .issue(IssueParams {
                        max_uses: Some(1000),
                        ..Default::default()
                    })
                    .unwrap()
                    .1
            })
            .collect();
        let f = std::sync::Arc::new(f);
        let (done_tx, done_rx) = std::sync::mpsc::channel::<&'static str>();
        let mut handles = Vec::new();
        for (worker, hash) in hashes.iter().copied().enumerate() {
            let f = std::sync::Arc::clone(&f);
            let done_tx = done_tx.clone();
            handles.push(std::thread::spawn(move || {
                let fabric = [(worker + 1) as u8; 32];
                for i in 0..PER_WORKER {
                    let root = [i + 1; 32];
                    assert!(
                        matches!(
                            f.redeem(&hash, fabric, root, now_ms()),
                            RedeemOutcome::Completed { .. }
                        ),
                        "worker {worker} 第 {i} 次兑换必须成功"
                    );
                }
                done_tx.send("redeem").unwrap();
            }));
        }
        for _ in 0..2 {
            let f = std::sync::Arc::clone(&f);
            let done_tx = done_tx.clone();
            handles.push(std::thread::spawn(move || {
                for _ in 0..60 {
                    // 与生产看护同序：owners 先 reload 取孤儿，codes 后 reload
                    let orphans = f.owners.reload_for_orphans().unwrap();
                    f.codes.reload(&orphans).unwrap();
                }
                done_tx.send("reload").unwrap();
            }));
        }
        drop(done_tx);
        let expected = WORKERS + 2;
        for _ in 0..expected {
            done_rx
                .recv_timeout(Duration::from_secs(30))
                .expect("疑似死锁：工作线程 30s 未完成（codes→owners 与 reload 锁序不得成环）");
        }
        for h in handles {
            h.join().unwrap();
        }
        // 终态一致：owners 全在册、每码 used_count = 完成兑换数（内存）；
        // 静默后自磁盘 reload 复核同值（reload 不回退已完成写入）
        for (worker, hash) in hashes.iter().enumerate() {
            let fabric = [(worker + 1) as u8; 32];
            for i in 0..PER_WORKER {
                assert!(
                    f.owners.snapshot().contains(&fabric, &[i + 1; 32]),
                    "worker {worker} root {i} 未在册"
                );
            }
            assert_eq!(f.codes.snapshot().used_count(hash), PER_WORKER as usize);
        }
        let orphans = f.owners.reload_for_orphans().unwrap();
        f.codes.reload(&orphans).unwrap();
        for (worker, hash) in hashes.iter().enumerate() {
            assert_eq!(
                f.codes.snapshot().used_count(hash),
                PER_WORKER as usize,
                "worker {worker}：磁盘事实复核（reload 后不回退）"
            );
        }
    }
}
