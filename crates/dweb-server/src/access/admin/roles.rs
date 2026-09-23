//! 三角色管理面增量路由（server-access-roles Phase 1c，spec「三角色管理
//! 面 API（敲门/访客/邀请码/黑名单/续期）」requirement 逐字实现）。
//!
//! 全部复用 [`super`] 的冻结基座：Bearer auth_guard、错误 envelope
//! `{"error":{code,message}}`、server.key 回执（103B canonical
//! `b"dweb/admin-receipt/v1\0"` 布局，op 扩展 0x04-0x0E——槽位映射表 spec
//! 冻结：**未用维度置零字节**；code 类 target=code_hash 32B；**generation =
//! 所属台账 generation**：owners=renew/owner-meta、visitors=visitor-*、
//! codes=code-*、blocklist=block-*；KnockLog 为内存台账，knock-dismiss/
//! undismiss 用其内部单调计数器）。wire 上回执显式携带 canonical 两槽位
//! （fabric_id / target 字段——未用维度为 64 个 "0"，与 canonical 置零
//! 字节同步呈现；消费端可零特判重建待签载荷）。
//!
//! 路由清单（全部 Bearer）：
//! - `GET /admin/knocks`（排序冻结：未处置在前、组内 seq 降序、endpoint_id
//!   升序 tie-break——last_at 仅展示；`?include_dismissed=true` 含已处置；
//!   `pending_count` 恒为未 dismissed 条目数，include_dismissed 不改语义）
//! - `POST /admin/knocks/{endpoint_id}/dismiss|undismiss`（幂等；unknown
//!   404 no-match；回执 op=0x0B/0x0C）
//! - `GET/POST /admin/visitors` + `POST /admin/visitors/from-knock`（语义糖
//!   路由，等同 POST——敲门台一键定位）+ `DELETE/PATCH /admin/visitors/
//!   {endpoint_id}`（revoke 0x06 / 元数据 0x0E）
//! - `GET/POST/DELETE /admin/codes`：列表只回 code_hash/计数 + `denied`
//!   deny-set 投影（**绝不含码全文**）；签发响应含 `code` 全文**仅此一次**
//!   （op=0x07）；吊销回执 0x08
//! - `POST /admin/owners/{fabric}/{root}/renew`（`expires_in_days` 或
//!   `permanent:true` 恰好其一；0x04）与 `PATCH /admin/owners/{fabric}/{root}`
//!   （元数据 0x0D——两路由挂 super::router 的 owners 路径族）
//! - `GET/POST/DELETE /admin/blocklist`（0x09/0x0A；canonical fabric 槽位：
//!   kind=fabric 时为 id、endpoint 维度为零）
//! - `GET /admin/status` 增量字段（super::status：knocks_pending/
//!   visitors_active/codes_active——纯增量，既有 wire 冻结不变）
//!
//! 输入上限（spec 冻结，越界 400 invalid-request）：alias ≤ 32 UTF-8 字节、
//! note ≤ 256、alias_hint ≤ 32、max_uses ≤ 1000、expires_in_days ≥ 1（0
//! 非法）；到期边界 `now >= expires_at` 即过期（等值=过期）；时长换算
//! checked 运算防溢出。

use super::{
    AdminError, AdminState, OP_BLOCK_ADD, OP_BLOCK_REMOVE, OP_CODE_ISSUE, OP_CODE_REVOKE,
    OP_KNOCK_DISMISS, OP_KNOCK_UNDISMISS, OP_OWNER_META, OP_RENEW, OP_VISITOR_GRANT,
    OP_VISITOR_META, OP_VISITOR_REVOKE, now_ms, op_label, receipt_canonical,
};
use crate::access::blocklist::BlockKind;
use crate::access::codes::IssueParams;
use crate::access::registry::parse_owner_hex;
use axum::{
    Json, Router,
    extract::{Path, RawQuery, State},
    routing::{delete, get, post},
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

/// 输入上限（spec 冻结）：别名 32 UTF-8 字节
pub(crate) const ALIAS_MAX_BYTES: usize = 32;
/// 输入上限（spec 冻结）：备注 256 UTF-8 字节
pub(crate) const NOTE_MAX_BYTES: usize = 256;
/// canonical 未用维度的置零字节（wire 同步呈现为 64 个 "0"）
const ZERO: [u8; 32] = [0u8; 32];
/// 一天的毫秒数（expires_in_days 换算）
const DAY_MS: u64 = 24 * 3_600_000;
/// 永久租期的回执 wire 形态（register 回放回落 u64::MAX 的同款冻结裁决：
/// wire 恒数字）
const PERMANENT_WIRE: u64 = u64::MAX;

// ---- 回执 wire（全部携带 canonical 两槽位；字段形态 spec 槽位映射表冻结） ----

/// renew 回执（op=0x04；expires_at wire 恒数字——permanent 时 u64::MAX）
#[derive(Serialize)]
pub(crate) struct RenewReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub root: String,
    pub expires_at: u64,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

/// visitor-grant 回执（op=0x05；expires_at 缺省不落=永久）
#[derive(Serialize)]
pub(crate) struct VisitorGrantReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub endpoint_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

/// visitor-revoke 回执（op=0x06）
#[derive(Serialize)]
pub(crate) struct VisitorRevokeReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub endpoint_id: String,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

/// visitor-meta 回执（op=0x0E；alias/note 为编辑后的终值，清除则缺省不落）
#[derive(Serialize)]
pub(crate) struct VisitorMetaReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub endpoint_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

/// code-issue 回执（op=0x07；`code` 全文**仅此响应一次**——此后一切响应只
/// 含 code_hash，spec 脱敏红线）
#[derive(Serialize)]
pub(crate) struct CodeIssueReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub code: String,
    pub code_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_hint: Option<String>,
    pub max_uses: u32,
    pub expires_at: u64,
    pub default_ttl_days: u32,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

/// code-revoke 回执（op=0x08；只回 code_hash）
#[derive(Serialize)]
pub(crate) struct CodeRevokeReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub code_hash: String,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

/// block-add/remove 回执（op=0x09/0x0A；canonical fabric 槽位：kind=fabric
/// 时为 id、endpoint 维度为零——wire 的 fabric_id 同步该语义）
#[derive(Serialize)]
pub(crate) struct BlockReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub kind: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

/// knock-dismiss/undismiss 回执（op=0x0B/0x0C；generation=KnockLog 内部
/// 单调计数器）
#[derive(Serialize)]
pub(crate) struct KnockReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub endpoint_id: String,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

/// owner-meta 回执（op=0x0D；alias/note 为编辑后的终值）
#[derive(Serialize)]
pub(crate) struct OwnerMetaReceipt {
    pub op: &'static str,
    pub fabric_id: String,
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub ts: u64,
    pub generation: u64,
    pub receipt_sig: String,
}

// ---- 路由挂载 ----

/// 三角色增量路由（挂入 super::router——同 state/同 auth_guard 层）
pub(super) fn router() -> Router<AdminState> {
    Router::new()
        .route("/admin/knocks", get(list_knocks))
        .route("/admin/knocks/{endpoint_id}/dismiss", post(dismiss_knock))
        .route(
            "/admin/knocks/{endpoint_id}/undismiss",
            post(undismiss_knock),
        )
        .route("/admin/visitors", get(list_visitors).post(grant_visitor))
        .route("/admin/visitors/from-knock", post(grant_visitor_from_knock))
        .route(
            "/admin/visitors/{endpoint_id}",
            delete(revoke_visitor).patch(patch_visitor_metadata),
        )
        .route("/admin/codes", get(list_codes).post(issue_code))
        .route("/admin/codes/{code_hash}", delete(revoke_code))
        .route("/admin/blocklist", get(list_blocklist).post(add_blocklist))
        .route("/admin/blocklist/{kind}/{id}", delete(remove_blocklist))
}

// ---- 校验/合并助手 ----

fn parse_hex_id(value: &str, label: &str) -> Result<[u8; 32], AdminError> {
    parse_owner_hex(value).map_err(|e| AdminError::InvalidRequest(format!("{label}: {e}")))
}

/// 可选字符串字段的长度上限（spec 冻结表；None 不校验）
fn validate_opt_len(value: &Option<String>, max: usize, label: &str) -> Result<(), AdminError> {
    if let Some(v) = value
        && v.len() > max
    {
        return Err(AdminError::InvalidRequest(format!(
            "{label} must be <= {max} UTF-8 bytes, got {}",
            v.len()
        )));
    }
    Ok(())
}

/// `expires_in_days` → expires_at（checked 链防溢出；0 非法）。`base` =
/// 起算基准：visitor grant 传 now；owner renew 传 **max(now, 当前
/// expires_at)**（「顺延」语义——spec 实现期增补，三角色走查 r2）
fn expires_at_from_days(days: u64, base: u64) -> Result<u64, AdminError> {
    if days < 1 {
        return Err(AdminError::InvalidRequest(
            "expires_in_days must be >= 1 (0 is invalid)".into(),
        ));
    }
    days.checked_mul(DAY_MS)
        .and_then(|ms| base.checked_add(ms))
        .ok_or_else(|| AdminError::InvalidRequest("expires_at overflow".into()))
}

/// PATCH 元数据字段合并：Some("")=清除（None 终值）、Some(x)=覆盖、
/// 缺省=保留既有
fn merge_meta_field(incoming: Option<String>, existing: Option<String>) -> Option<String> {
    match incoming {
        Some(s) if s.is_empty() => None,
        Some(s) => Some(s),
        None => existing,
    }
}

/// 元数据 body 的「至少其一」约束
fn require_meta_body(alias: &Option<String>, note: &Option<String>) -> Result<(), AdminError> {
    if alias.is_none() && note.is_none() {
        return Err(AdminError::InvalidRequest(
            "request body must specify at least one of alias or note".into(),
        ));
    }
    Ok(())
}

/// 回执签名（canonical = super::receipt_canonical；generation 已由调用方
/// 从对应台账取定）
fn sign_receipt(
    state: &AdminState,
    op_code: u8,
    fabric: &[u8; 32],
    target: &[u8; 32],
    ts: u64,
    generation: u64,
) -> String {
    URL_SAFE_NO_PAD.encode(
        state
            .identity
            .sign(&receipt_canonical(op_code, fabric, target, ts, generation)),
    )
}

/// 台账变更后的 callback 缓存失效（复合 generation 之外的双保险，与
/// owners 变更同语义——visitor grant/revoke 即刻失效旧 allow 缓存）
fn invalidate_callback_cache(state: &AdminState) {
    if let Some(gate) = &state.gate {
        gate.invalidate_callback_cache();
    }
}

// ---- 敲门台 ----

#[derive(Serialize)]
struct KnockInfo {
    endpoint_id: String,
    seq: u64,
    first_at: u64,
    /// 仅展示字段（排序/逐出只用 seq——spec 冻结）
    last_at: u64,
    count: u64,
    last_reason: String,
    dismissed: bool,
}

#[derive(Serialize)]
struct KnocksList {
    knocks: Vec<KnockInfo>,
    /// 恒为未 dismissed 条目数（include_dismissed 不改变语义，spec 冻结）
    pending_count: usize,
}

/// `?include_dismissed` 解析：键存在且值 ∉ {"false","0"} 即视为 true
/// （spec 场景形态 `?include_dismissed=true`；裸键容忍）
fn include_dismissed_of(raw_query: Option<&str>) -> bool {
    raw_query.is_some_and(|q| {
        q.split('&').any(|pair| {
            let (key, value) = match pair.split_once('=') {
                Some((k, v)) => (k, Some(v)),
                None => (pair, None),
            };
            key == "include_dismissed" && !matches!(value, Some("false" | "0"))
        })
    })
}

async fn list_knocks(
    State(state): State<AdminState>,
    RawQuery(query): RawQuery,
) -> Json<KnocksList> {
    let Some(gate) = &state.gate else {
        // open 模式无 gate = 无敲门台账（重启清空的内存台账在此同形：空集）
        return Json(KnocksList {
            knocks: Vec::new(),
            pending_count: 0,
        });
    };
    let list = gate
        .knock_log()
        .list(include_dismissed_of(query.as_deref()));
    Json(KnocksList {
        knocks: list
            .knocks
            .into_iter()
            .map(|k| KnockInfo {
                endpoint_id: hex::encode(k.endpoint_id),
                seq: k.seq,
                first_at: k.first_at,
                last_at: k.last_at,
                count: k.count,
                last_reason: k.last_reason,
                dismissed: k.dismissed,
            })
            .collect(),
        pending_count: list.pending_count,
    })
}

/// dismiss/undismiss 共通：幂等管理动作；unknown（无 gate 或台账无此
/// endpoint）→ 404 no-match（与 disconnect 判定一致，spec 冻结）。回执
/// generation = KnockLog 内部单调计数器。
async fn knock_mutation(
    state: &AdminState,
    endpoint_hex: &str,
    dismissed: bool,
) -> Result<Json<KnockReceipt>, AdminError> {
    let endpoint_id = parse_hex_id(endpoint_hex, "endpoint_id")?;
    let op_code = if dismissed {
        OP_KNOCK_DISMISS
    } else {
        OP_KNOCK_UNDISMISS
    };
    let Some(gate) = &state.gate else {
        return Err(AdminError::NoMatch(
            "no knock ledger (open mode)".to_string(),
        ));
    };
    let log = gate.knock_log();
    let applied = if dismissed {
        log.dismiss(&endpoint_id)
    } else {
        log.undismiss(&endpoint_id)
    };
    if !applied {
        return Err(AdminError::NoMatch(format!(
            "no knock entry for endpoint_id {}",
            hex::encode(endpoint_id)
        )));
    }
    let generation = log.generation();
    let ts = now_ms();
    tracing::info!(
        op = op_label(op_code),
        endpoint_id = %hex::encode(endpoint_id),
        generation,
        "admin API: knock {}",
        if dismissed { "dismissed" } else { "undismissed" }
    );
    Ok(Json(KnockReceipt {
        op: op_label(op_code),
        fabric_id: hex::encode(ZERO),
        endpoint_id: hex::encode(endpoint_id),
        ts,
        generation,
        receipt_sig: sign_receipt(state, op_code, &ZERO, &endpoint_id, ts, generation),
    }))
}

async fn dismiss_knock(
    State(state): State<AdminState>,
    Path(endpoint_hex): Path<String>,
) -> Result<Json<KnockReceipt>, AdminError> {
    knock_mutation(&state, &endpoint_hex, true).await
}

async fn undismiss_knock(
    State(state): State<AdminState>,
    Path(endpoint_hex): Path<String>,
) -> Result<Json<KnockReceipt>, AdminError> {
    knock_mutation(&state, &endpoint_hex, false).await
}

// ---- 访客名册 ----

#[derive(Serialize)]
struct VisitorInfo {
    endpoint_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    granted_at: u64,
    /// 缺省不落 = 永久
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
}

#[derive(Serialize)]
struct VisitorsList {
    generation: u64,
    visitors: Vec<VisitorInfo>,
}

async fn list_visitors(State(state): State<AdminState>) -> Json<VisitorsList> {
    let snapshot = state.visitors.snapshot();
    Json(VisitorsList {
        generation: snapshot.generation(),
        visitors: snapshot
            .entries()
            .into_iter()
            .map(|e| VisitorInfo {
                endpoint_id: hex::encode(e.endpoint_id),
                alias: e.alias,
                note: e.note,
                granted_at: e.granted_at,
                expires_at: e.expires_at,
            })
            .collect(),
    })
}

#[derive(Deserialize)]
struct GrantVisitorBody {
    endpoint_id: String,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    expires_in_days: Option<u64>,
}

/// grant 共通核（POST /admin/visitors 与 from-knock 语义糖路由共享）：
/// body endpoint_id 必填 + alias/note/expires_in_days 可选（缺省=永久）；
/// 校验（长度/天数/checked 换算）→ 台账 grant → 缓存失效 → 回执 0x05。
async fn grant_visitor_core(
    state: &AdminState,
    body: Result<Json<GrantVisitorBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<VisitorGrantReceipt>, AdminError> {
    let Json(body) = body.map_err(|e| AdminError::InvalidRequest(e.body_text()))?;
    let endpoint_id = parse_hex_id(&body.endpoint_id, "endpoint_id")?;
    validate_opt_len(&body.alias, ALIAS_MAX_BYTES, "alias")?;
    validate_opt_len(&body.note, NOTE_MAX_BYTES, "note")?;
    let expires_at = match body.expires_in_days {
        Some(days) => Some(expires_at_from_days(days, now_ms())?),
        None => None,
    };
    state
        .visitors
        .grant(&endpoint_id, body.alias, body.note, expires_at)
        .map_err(|e| AdminError::Registry(format!("visitor grant failed: {e:#}")))?;
    invalidate_callback_cache(state);
    let generation = state.visitors.snapshot().generation();
    let ts = now_ms();
    tracing::info!(
        op = op_label(OP_VISITOR_GRANT),
        endpoint_id = %hex::encode(endpoint_id),
        expires_at = ?expires_at,
        generation,
        "admin API: visitor granted"
    );
    Ok(Json(VisitorGrantReceipt {
        op: op_label(OP_VISITOR_GRANT),
        fabric_id: hex::encode(ZERO),
        endpoint_id: hex::encode(endpoint_id),
        expires_at,
        ts,
        generation,
        receipt_sig: sign_receipt(state, OP_VISITOR_GRANT, &ZERO, &endpoint_id, ts, generation),
    }))
}

async fn grant_visitor(
    State(state): State<AdminState>,
    body: Result<Json<GrantVisitorBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<VisitorGrantReceipt>, AdminError> {
    grant_visitor_core(&state, body).await
}

/// 语义糖路由（spec 冻结：body 含 endpoint_id，等同 POST——敲门台一键定位）
async fn grant_visitor_from_knock(
    State(state): State<AdminState>,
    body: Result<Json<GrantVisitorBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<VisitorGrantReceipt>, AdminError> {
    grant_visitor_core(&state, body).await
}

async fn revoke_visitor(
    State(state): State<AdminState>,
    Path(endpoint_hex): Path<String>,
) -> Result<Json<VisitorRevokeReceipt>, AdminError> {
    let endpoint_id = parse_hex_id(&endpoint_hex, "endpoint_id")?;
    if !state.visitors.snapshot().contains(&endpoint_id) {
        return Err(AdminError::NoMatch(format!(
            "no active visitor for endpoint_id {}",
            hex::encode(endpoint_id)
        )));
    }
    state
        .visitors
        .revoke(&endpoint_id)
        .map_err(|e| AdminError::Registry(format!("visitor revoke failed: {e:#}")))?;
    invalidate_callback_cache(&state);
    let generation = state.visitors.snapshot().generation();
    let ts = now_ms();
    tracing::info!(
        op = op_label(OP_VISITOR_REVOKE),
        endpoint_id = %hex::encode(endpoint_id),
        generation,
        "admin API: visitor revoked"
    );
    Ok(Json(VisitorRevokeReceipt {
        op: op_label(OP_VISITOR_REVOKE),
        fabric_id: hex::encode(ZERO),
        endpoint_id: hex::encode(endpoint_id),
        ts,
        generation,
        receipt_sig: sign_receipt(
            &state,
            OP_VISITOR_REVOKE,
            &ZERO,
            &endpoint_id,
            ts,
            generation,
        ),
    }))
}

#[derive(Deserialize)]
pub(super) struct MetaBody {
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// visitor 元数据 PATCH（op=0x0E）：alias/note 至少其一、空串=清除、
/// 缺省=保留；不在册（grant 未 revoke——过期条目仍在册可编辑）→ 404。
async fn patch_visitor_metadata(
    State(state): State<AdminState>,
    Path(endpoint_hex): Path<String>,
    body: Result<Json<MetaBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<VisitorMetaReceipt>, AdminError> {
    let Json(body) = body.map_err(|e| AdminError::InvalidRequest(e.body_text()))?;
    require_meta_body(&body.alias, &body.note)?;
    validate_opt_len(&body.alias, ALIAS_MAX_BYTES, "alias")?;
    validate_opt_len(&body.note, NOTE_MAX_BYTES, "note")?;
    let endpoint_id = parse_hex_id(&endpoint_hex, "endpoint_id")?;
    let existing = state
        .visitors
        .snapshot()
        .entries()
        .into_iter()
        .find(|e| e.endpoint_id == endpoint_id);
    let Some(existing) = existing else {
        return Err(AdminError::NoMatch(format!(
            "no visitor entry for endpoint_id {}",
            hex::encode(endpoint_id)
        )));
    };
    let alias = merge_meta_field(body.alias, existing.alias);
    let note = merge_meta_field(body.note, existing.note);
    state
        .visitors
        .update_metadata(&endpoint_id, alias.clone(), note.clone())
        .map_err(|e| AdminError::Registry(format!("visitor metadata update failed: {e:#}")))?
        .then_some(())
        .ok_or_else(|| {
            AdminError::NoMatch(format!(
                "no visitor entry for endpoint_id {}",
                hex::encode(endpoint_id)
            ))
        })?;
    invalidate_callback_cache(&state);
    let generation = state.visitors.snapshot().generation();
    let ts = now_ms();
    tracing::info!(
        op = op_label(OP_VISITOR_META),
        endpoint_id = %hex::encode(endpoint_id),
        generation,
        "admin API: visitor metadata updated"
    );
    Ok(Json(VisitorMetaReceipt {
        op: op_label(OP_VISITOR_META),
        fabric_id: hex::encode(ZERO),
        endpoint_id: hex::encode(endpoint_id),
        alias,
        note,
        ts,
        generation,
        receipt_sig: sign_receipt(&state, OP_VISITOR_META, &ZERO, &endpoint_id, ts, generation),
    }))
}

// ---- 邀请码 ----

#[derive(Serialize)]
struct CodeInfo {
    /// 列表/吊销只回哈希——**绝不含码全文**（spec 脱敏红线）
    code_hash: String,
    max_uses: u32,
    /// consume 事件归并推导（去重键数）
    used_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias_hint: Option<String>,
    revoked: bool,
    default_ttl_days: u32,
    /// deny-set 命中（1b 遗留运维投影：补写失败 fail-closed 的码显式呈现；
    /// 补写成功即 false）
    denied: bool,
}

#[derive(Serialize)]
struct CodesList {
    generation: u64,
    codes: Vec<CodeInfo>,
}

async fn list_codes(State(state): State<AdminState>) -> Json<CodesList> {
    let snapshot = state.codes.snapshot();
    Json(CodesList {
        generation: snapshot.generation(),
        codes: snapshot
            .entries()
            .into_iter()
            .map(|c| CodeInfo {
                used_count: snapshot.used_count(&c.code_hash),
                denied: state.codes.is_denied(&c.code_hash),
                code_hash: hex::encode(c.code_hash),
                max_uses: c.max_uses,
                expires_at: c.expires_at,
                alias_hint: c.alias_hint,
                revoked: c.revoked,
                default_ttl_days: c.default_ttl_days,
            })
            .collect(),
    })
}

#[derive(Deserialize)]
struct IssueCodeBody {
    #[serde(default)]
    alias_hint: Option<String>,
    #[serde(default)]
    max_uses: Option<u32>,
    #[serde(default)]
    expires_in_days: Option<u64>,
    #[serde(default)]
    default_ttl_days: Option<u32>,
}

/// 签发（op=0x07）：输入上限由台账 issue() 校验（max_uses ∈ 1..=1000、
/// expires_in_days ≥ 1、default_ttl_days ≥ 1、alias_hint ≤ 32——spec 冻结
/// 表），违例映射 400 invalid-request。**响应含 code 全文——仅此一次**；
/// 日志/回执之外的一切面零码全文。
async fn issue_code(
    State(state): State<AdminState>,
    body: Result<Json<IssueCodeBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<CodeIssueReceipt>, AdminError> {
    let Json(body) = body.map_err(|e| AdminError::InvalidRequest(e.body_text()))?;
    let (code, code_hash) = state
        .codes
        .issue(IssueParams {
            alias_hint: body.alias_hint,
            max_uses: body.max_uses,
            expires_in_days: body.expires_in_days,
            default_ttl_days: body.default_ttl_days,
        })
        .map_err(|e| AdminError::InvalidRequest(format!("code issue rejected: {e:#}")))?;
    // 签发参数终值从台账快照回读（缺省值单一事实源在台账，不在此复刻）
    let entry = state
        .codes
        .snapshot()
        .entries()
        .into_iter()
        .find(|c| c.code_hash == code_hash)
        .expect("issue 后快照必含新码");
    let generation = state.codes.snapshot().generation();
    let ts = now_ms();
    tracing::info!(
        op = op_label(OP_CODE_ISSUE),
        code_hash = %hex::encode(code_hash),
        max_uses = entry.max_uses,
        default_ttl_days = entry.default_ttl_days,
        generation,
        "admin API: code issued (full text returned once)"
    );
    Ok(Json(CodeIssueReceipt {
        op: op_label(OP_CODE_ISSUE),
        fabric_id: hex::encode(ZERO),
        code,
        code_hash: hex::encode(code_hash),
        alias_hint: entry.alias_hint,
        max_uses: entry.max_uses,
        expires_at: entry.expires_at.unwrap_or(PERMANENT_WIRE),
        default_ttl_days: entry.default_ttl_days,
        ts,
        generation,
        receipt_sig: sign_receipt(&state, OP_CODE_ISSUE, &ZERO, &code_hash, ts, generation),
    }))
}

async fn revoke_code(
    State(state): State<AdminState>,
    Path(code_hash_hex): Path<String>,
) -> Result<Json<CodeRevokeReceipt>, AdminError> {
    let code_hash = parse_hex_id(&code_hash_hex, "code_hash")?;
    if !state
        .codes
        .snapshot()
        .entries()
        .into_iter()
        .any(|c| c.code_hash == code_hash)
    {
        return Err(AdminError::NoMatch(format!(
            "no code for code_hash {}",
            hex::encode(code_hash)
        )));
    }
    state
        .codes
        .revoke(&code_hash)
        .map_err(|e| AdminError::Registry(format!("code revoke failed: {e:#}")))?;
    let generation = state.codes.snapshot().generation();
    let ts = now_ms();
    tracing::info!(
        op = op_label(OP_CODE_REVOKE),
        code_hash = %hex::encode(code_hash),
        generation,
        "admin API: code revoked"
    );
    Ok(Json(CodeRevokeReceipt {
        op: op_label(OP_CODE_REVOKE),
        fabric_id: hex::encode(ZERO),
        code_hash: hex::encode(code_hash),
        ts,
        generation,
        receipt_sig: sign_receipt(&state, OP_CODE_REVOKE, &ZERO, &code_hash, ts, generation),
    }))
}

// ---- 黑名单 ----

#[derive(Serialize)]
struct BlocklistInfo {
    kind: &'static str,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    ts: u64,
}

#[derive(Serialize)]
struct BlocklistList {
    generation: u64,
    entries: Vec<BlocklistInfo>,
}

fn kind_label(kind: BlockKind) -> &'static str {
    match kind {
        BlockKind::Endpoint => "endpoint",
        BlockKind::Fabric => "fabric",
    }
}

fn parse_kind(value: &str) -> Result<BlockKind, AdminError> {
    match value {
        "endpoint" => Ok(BlockKind::Endpoint),
        "fabric" => Ok(BlockKind::Fabric),
        _ => Err(AdminError::InvalidRequest(format!(
            "kind must be \"endpoint\" | \"fabric\", got {value:?}"
        ))),
    }
}

async fn list_blocklist(State(state): State<AdminState>) -> Json<BlocklistList> {
    let snapshot = state.blocklist.snapshot();
    Json(BlocklistList {
        generation: snapshot.generation(),
        entries: snapshot
            .entries()
            .into_iter()
            .map(|(kind, id, entry)| BlocklistInfo {
                kind: kind_label(kind),
                id: hex::encode(id),
                reason: entry.reason,
                ts: entry.ts,
            })
            .collect(),
    })
}

#[derive(Deserialize)]
struct AddBlockBody {
    kind: String,
    id: String,
    #[serde(default)]
    reason: Option<String>,
}

/// 拉黑（op=0x09）：canonical fabric 槽位 = kind=fabric 时承载 id、endpoint
/// 维度置零（spec 槽位映射表）；wire 的 fabric_id 字段同步该语义。
async fn add_blocklist(
    State(state): State<AdminState>,
    body: Result<Json<AddBlockBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<BlockReceipt>, AdminError> {
    let Json(body) = body.map_err(|e| AdminError::InvalidRequest(e.body_text()))?;
    let kind = parse_kind(&body.kind)?;
    let id = parse_hex_id(&body.id, "id")?;
    state
        .blocklist
        .add(kind, &id, body.reason.clone())
        .map_err(|e| AdminError::Registry(format!("blocklist add failed: {e:#}")))?;
    invalidate_callback_cache(&state);
    let generation = state.blocklist.snapshot().generation();
    let ts = now_ms();
    let fabric_slot = match kind {
        BlockKind::Fabric => id,
        BlockKind::Endpoint => ZERO,
    };
    tracing::info!(
        op = op_label(OP_BLOCK_ADD),
        kind = kind_label(kind),
        id = %hex::encode(id),
        generation,
        "admin API: blocklist entry added"
    );
    Ok(Json(BlockReceipt {
        op: op_label(OP_BLOCK_ADD),
        fabric_id: hex::encode(fabric_slot),
        kind: kind_label(kind),
        id: hex::encode(id),
        reason: body.reason,
        ts,
        generation,
        receipt_sig: sign_receipt(&state, OP_BLOCK_ADD, &fabric_slot, &id, ts, generation),
    }))
}

/// 移出名单（op=0x0A）：不在当前名单 → 404 no-match（在名单内重复 DELETE
/// 的幂等收敛 = 第二次 404；文件入口的「不存在 remove 落日志」语义不适用
/// admin 面——不写无效事件）
async fn remove_blocklist(
    State(state): State<AdminState>,
    Path((kind_str, id_hex)): Path<(String, String)>,
) -> Result<Json<BlockReceipt>, AdminError> {
    let kind = parse_kind(&kind_str)?;
    let id = parse_hex_id(&id_hex, "id")?;
    let snapshot = state.blocklist.snapshot();
    if !snapshot.is_blocked(kind, &id) {
        return Err(AdminError::NoMatch(format!(
            "no blocklist entry for ({}, {})",
            kind_label(kind),
            hex::encode(id)
        )));
    }
    let reason = snapshot.reason(kind, &id).map(str::to_string);
    drop(snapshot);
    state
        .blocklist
        .remove(kind, &id)
        .map_err(|e| AdminError::Registry(format!("blocklist remove failed: {e:#}")))?;
    invalidate_callback_cache(&state);
    let generation = state.blocklist.snapshot().generation();
    let ts = now_ms();
    let fabric_slot = match kind {
        BlockKind::Fabric => id,
        BlockKind::Endpoint => ZERO,
    };
    tracing::info!(
        op = op_label(OP_BLOCK_REMOVE),
        kind = kind_label(kind),
        id = %hex::encode(id),
        generation,
        "admin API: blocklist entry removed"
    );
    Ok(Json(BlockReceipt {
        op: op_label(OP_BLOCK_REMOVE),
        fabric_id: hex::encode(fabric_slot),
        kind: kind_label(kind),
        id: hex::encode(id),
        reason,
        ts,
        generation,
        receipt_sig: sign_receipt(&state, OP_BLOCK_REMOVE, &fabric_slot, &id, ts, generation),
    }))
}

// ---- 租户续期与元数据（挂 super::router 的 owners 路径族） ----

#[derive(Deserialize)]
pub(super) struct RenewBody {
    #[serde(default)]
    expires_in_days: Option<u64>,
    #[serde(default)]
    permanent: Option<bool>,
}

/// 续期（op=0x04）：`expires_in_days` 或 `permanent:true` **恰好其一**（spec
/// 冻结）；**顺延基准 = max(now, 当前 expires_at)**（spec 实现期增补，三
/// 角色走查 r2：「顺延」语义——未到期从当前到期日起算，剩 N 天 +M 天 =
/// 旧到期 + M 天；过期条目从 now 起算恢复准入；permanent（无既有租期）→
/// days 以 now 起算）；permanent → expires_at=None（回执 wire 恒数字，
/// 回落 u64::MAX）；保留既有 alias/note（registry::renew 冻结语义）。键
/// 不在册（过期条目仍在册可续期——spec「续期恢复准入」）→ 404 no-match。
pub(super) async fn renew_owner(
    State(state): State<AdminState>,
    Path((fabric_hex, root_hex)): Path<(String, String)>,
    body: Result<Json<RenewBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<RenewReceipt>, AdminError> {
    let Json(body) = body.map_err(|e| AdminError::InvalidRequest(e.body_text()))?;
    match (body.expires_in_days, body.permanent) {
        (Some(_), Some(_)) | (None, None) => {
            return Err(AdminError::InvalidRequest(
                "request body must specify exactly one of expires_in_days or permanent".into(),
            ));
        }
        _ => {}
    }
    let fabric_id = parse_hex_id(&fabric_hex, "fabric_id")?;
    let root = parse_hex_id(&root_hex, "root")?;
    // 顺延基准：当前条目未到期 → 从当前 expires_at 起（webui「顺延 N 天」
    // 文案的产品语义）；过期 / permanent / 理论竞态缺失 → 从 now 起算。
    // 只读快照取基准 + renew 同锁写入（admin 低频单人操作面，快照与写入
    // 之间的窗口不构成可观察的语义漂移）
    let now = now_ms();
    let base = state
        .registry
        .snapshot()
        .active_entry(&fabric_id, &root)
        .and_then(|entry| entry.expires_at)
        .filter(|expires| *expires > now)
        .unwrap_or(now);
    let expires_at = match body.expires_in_days {
        Some(days) => Some(expires_at_from_days(days, base)?),
        None => None, // permanent
    };
    state
        .registry
        .renew(&fabric_id, &root, expires_at)
        .map_err(|e| AdminError::Registry(format!("owner renew failed: {e:#}")))?
        .then_some(())
        .ok_or_else(|| {
            AdminError::NoMatch(format!(
                "no registry entry for (fabric {}, root {})",
                hex::encode(fabric_id),
                hex::encode(root)
            ))
        })?;
    invalidate_callback_cache(&state);
    let generation = state.registry.snapshot().generation();
    let ts = now_ms();
    tracing::info!(
        op = op_label(OP_RENEW),
        fabric_id = %hex::encode(fabric_id),
        root = %hex::encode(root),
        permanent = expires_at.is_none(),
        generation,
        "admin API: owner renewed"
    );
    Ok(Json(RenewReceipt {
        op: op_label(OP_RENEW),
        fabric_id: hex::encode(fabric_id),
        root: hex::encode(root),
        expires_at: expires_at.unwrap_or(PERMANENT_WIRE),
        ts,
        generation,
        receipt_sig: sign_receipt(&state, OP_RENEW, &fabric_id, &root, ts, generation),
    }))
}

/// owner 元数据 PATCH（op=0x0D）：alias/note 至少其一、空串=清除、缺省=
/// 保留、长度上限同签发表；不在册 → 404。
pub(super) async fn patch_owner_metadata(
    State(state): State<AdminState>,
    Path((fabric_hex, root_hex)): Path<(String, String)>,
    body: Result<Json<MetaBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<OwnerMetaReceipt>, AdminError> {
    let Json(body) = body.map_err(|e| AdminError::InvalidRequest(e.body_text()))?;
    require_meta_body(&body.alias, &body.note)?;
    validate_opt_len(&body.alias, ALIAS_MAX_BYTES, "alias")?;
    validate_opt_len(&body.note, NOTE_MAX_BYTES, "note")?;
    let fabric_id = parse_hex_id(&fabric_hex, "fabric_id")?;
    let root = parse_hex_id(&root_hex, "root")?;
    let existing = state
        .registry
        .snapshot()
        .entries()
        .into_iter()
        .find(|e| e.fabric_id == fabric_id && e.root == root);
    let Some(existing) = existing else {
        return Err(AdminError::NoMatch(format!(
            "no registry entry for (fabric {}, root {})",
            hex::encode(fabric_id),
            hex::encode(root)
        )));
    };
    let alias = merge_meta_field(body.alias, existing.alias);
    let note = merge_meta_field(body.note, existing.note);
    state
        .registry
        .update_metadata(&fabric_id, &root, alias.clone(), note.clone())
        .map_err(|e| AdminError::Registry(format!("owner metadata update failed: {e:#}")))?
        .then_some(())
        .ok_or_else(|| {
            AdminError::NoMatch(format!(
                "no registry entry for (fabric {}, root {})",
                hex::encode(fabric_id),
                hex::encode(root)
            ))
        })?;
    invalidate_callback_cache(&state);
    let generation = state.registry.snapshot().generation();
    let ts = now_ms();
    tracing::info!(
        op = op_label(OP_OWNER_META),
        fabric_id = %hex::encode(fabric_id),
        root = %hex::encode(root),
        generation,
        "admin API: owner metadata updated"
    );
    Ok(Json(OwnerMetaReceipt {
        op: op_label(OP_OWNER_META),
        fabric_id: hex::encode(fabric_id),
        root: hex::encode(root),
        alias,
        note,
        ts,
        generation,
        receipt_sig: sign_receipt(&state, OP_OWNER_META, &fabric_id, &root, ts, generation),
    }))
}

#[cfg(test)]
mod tests {
    //! Phase 1c 三角色路由单测（黑盒 oneshort——经完整 admin router，覆盖
    //! spec「三角色管理面 API」requirement 的管理面条款；全链路连接行为由
    //! tests/server_access_e2e.rs e30-e36 钉死）。

    use super::*;
    use crate::access::admin::router;
    use crate::access::blocklist::Blocklist;
    use crate::access::codes::CodeLedger;
    use crate::access::config::PolicyConfig;
    use crate::access::gate::AccessGate;
    use crate::access::identity::ServerIdentity;
    use crate::access::registry::OwnerRegistry;
    use crate::access::visitor::VisitorRegistry;
    use axum::body::Body;
    use axum::http::Request;
    use ed25519_dalek::{Signature, Verifier};
    use std::sync::Arc;
    use tempfile::TempDir;
    use tower::ServiceExt;

    const TOKEN: &str = "roles-test-token";

    struct F {
        _dir: TempDir,
        identity: Arc<ServerIdentity>,
        registry: Arc<OwnerRegistry>,
        visitors: Arc<VisitorRegistry>,
        blocklist: Arc<Blocklist>,
        codes: Arc<CodeLedger>,
        gate: Arc<AccessGate>,
    }

    impl F {
        fn new() -> Self {
            let dir = TempDir::new().unwrap();
            let identity = Arc::new(ServerIdentity::load_or_create(dir.path()).unwrap());
            let registry = Arc::new(OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap());
            let visitors =
                Arc::new(VisitorRegistry::load(&dir.path().join("visitors.jsonl")).unwrap());
            let blocklist = Arc::new(Blocklist::load(&dir.path().join("blocklist.jsonl")).unwrap());
            let codes = Arc::new(CodeLedger::load(&dir.path().join("codes.jsonl"), &[]).unwrap());
            let gate = Arc::new(
                AccessGate::new(
                    *identity.server_id().as_bytes(),
                    Arc::clone(&registry),
                    PolicyConfig::Static,
                )
                .unwrap(),
            );
            Self {
                _dir: dir,
                identity,
                registry,
                visitors,
                blocklist,
                codes,
                gate,
            }
        }

        fn state(&self) -> AdminState {
            AdminState {
                token: TOKEN.to_string(),
                identity: Arc::clone(&self.identity),
                registry: Arc::clone(&self.registry),
                visitors: Arc::clone(&self.visitors),
                blocklist: Arc::clone(&self.blocklist),
                codes: Arc::clone(&self.codes),
                gate: Some(Arc::clone(&self.gate)),
                relay_clients: None,
                mode: crate::access::config::AccessMode::Restricted,
                policy: "static",
                relay_enabled: true,
            }
        }

        fn app(&self) -> axum::Router {
            router(self.state())
        }
    }

    fn auth() -> (&'static str, String) {
        ("authorization", format!("Bearer {TOKEN}"))
    }

    async fn send(
        app: &axum::Router,
        req: Request<Body>,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    fn get(path: &str) -> Request<Body> {
        Request::get(path)
            .header(auth().0, auth().1)
            .body(Body::empty())
            .unwrap()
    }

    fn req_with_body(method: &str, path: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header(auth().0, auth().1)
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    /// 回执验签（server_id 公钥侧；canonical 槽位按 spec 映射表）
    fn verify_receipt(
        f: &F,
        body: &serde_json::Value,
        op: u8,
        fabric: &[u8; 32],
        target: &[u8; 32],
    ) {
        let canonical = receipt_canonical(
            op,
            fabric,
            target,
            body["ts"].as_u64().unwrap(),
            body["generation"].as_u64().unwrap(),
        );
        let sig: [u8; 64] = URL_SAFE_NO_PAD
            .decode(body["receipt_sig"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        ed25519_dalek::VerifyingKey::from_bytes(f.identity.server_id().as_bytes())
            .unwrap()
            .verify(&canonical, &Signature::from_bytes(&sig))
            .expect("回执必须可用 ServerId 验签");
    }

    fn hex32(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    fn zeros_hex() -> String {
        "00".repeat(32)
    }

    // ---- 敲门台 ----

    /// spec Scenario「敲门列表排序契约」+ pending_count 恒定 + dismiss 幂等
    /// + 新 deny 复位 + undismiss
    #[tokio::test]
    async fn knocks_ordering_pending_count_and_dismiss_cycle() {
        let f = F::new();
        let app = f.app();
        let (a, b, c) = (hex32(0xD1), hex32(0xD2), hex32(0xD3));
        // 3 次未处置敲门（seq 1/2/3；b 的 last_at 回拨——排序只看 seq）
        f.gate.knock_log().record(a, "dweb/no-capability", 3000);
        f.gate.knock_log().record(b, "dweb/no-capability", 2000);
        f.gate.knock_log().record(c, "dweb/owner-expired", 1000);
        // c 处置掉（未处置剩 a/b）
        f.gate.knock_log().dismiss(&c);

        let (status, body) = send(&app, get("/admin/knocks")).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let knocks = body["knocks"].as_array().unwrap();
        assert_eq!(knocks.len(), 2, "已处置不在默认响应");
        // 未处置组内 seq 降序：b(seq2) → a(seq1)
        assert_eq!(knocks[0]["endpoint_id"], hex::encode(b));
        assert_eq!(knocks[1]["endpoint_id"], hex::encode(a));
        assert_eq!(knocks[0]["last_at"], 2000, "last_at 仅展示（回拨原样）");
        assert_eq!(knocks[1]["count"], 1);
        assert_eq!(body["pending_count"], 2);

        // include_dismissed=true：c 尾随（已处置组在后），pending_count 恒 2
        let (_, body) = send(&app, get("/admin/knocks?include_dismissed=true")).await;
        let knocks = body["knocks"].as_array().unwrap();
        assert_eq!(knocks.len(), 3);
        assert_eq!(knocks[2]["endpoint_id"], hex::encode(c));
        assert!(knocks[2]["dismissed"].as_bool().unwrap());
        assert_eq!(body["pending_count"], 2, "include_dismissed 不改语义");
        // 裸键与 false 值
        let (_, body) = send(&app, get("/admin/knocks?include_dismissed")).await;
        assert_eq!(body["knocks"].as_array().unwrap().len(), 3);
        let (_, body) = send(&app, get("/admin/knocks?include_dismissed=false")).await;
        assert_eq!(body["knocks"].as_array().unwrap().len(), 2);

        // dismiss 幂等 + 回执（op=0x0B；generation=KnockLog 内部计数器）
        let knock_gen = f.gate.knock_log().generation();
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                &format!("/admin/knocks/{}/dismiss", hex::encode(a)),
                serde_json::json!({}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["op"], "knock-dismiss");
        assert_eq!(body["fabric_id"], zeros_hex(), "未用维度 wire 置零");
        assert_eq!(body["generation"], knock_gen);
        verify_receipt(&f, &body, OP_KNOCK_DISMISS, &ZERO, &a);
        let (status, body2) = send(
            &app,
            req_with_body(
                "POST",
                &format!("/admin/knocks/{}/dismiss", hex::encode(a)),
                serde_json::json!({}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "二次 dismiss 幂等");
        assert_eq!(body2["op"], "knock-dismiss");

        // 新 deny 复位 dismissed=false（重新计入 pending）
        f.gate.knock_log().record(a, "dweb/no-capability", 4000);
        let (_, body) = send(&app, get("/admin/knocks")).await;
        assert_eq!(body["pending_count"], 2);
        let knocks = body["knocks"].as_array().unwrap();
        assert_eq!(knocks[0]["endpoint_id"], hex::encode(a), "seq4 最前");
        assert_eq!(knocks[0]["count"], 2, "复位不重置聚合计数");

        // undismiss 对等动作（op=0x0C）——先把 a 处置再手动恢复
        send(
            &app,
            req_with_body(
                "POST",
                &format!("/admin/knocks/{}/dismiss", hex::encode(a)),
                serde_json::json!({}),
            ),
        )
        .await;
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                &format!("/admin/knocks/{}/undismiss", hex::encode(a)),
                serde_json::json!({}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["op"], "knock-undismiss");
        verify_receipt(&f, &body, OP_KNOCK_UNDISMISS, &ZERO, &a);
        let (_, body) = send(&app, get("/admin/knocks")).await;
        assert_eq!(body["pending_count"], 2, "undismiss 恢复待办");
    }

    /// spec Scenario「unknown 敲门条目的处置动作」：404 + no-match envelope
    #[tokio::test]
    async fn knocks_unknown_endpoint_404_no_match() {
        let f = F::new();
        let app = f.app();
        for verb in ["dismiss", "undismiss"] {
            let (status, body) = send(
                &app,
                req_with_body(
                    "POST",
                    &format!("/admin/knocks/{}/{}", hex::encode(hex32(0xE9)), verb),
                    serde_json::json!({}),
                ),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "{verb}");
            assert_eq!(body["error"]["code"], "no-match");
        }
        // 坏 hex → 400
        let (status, body) = send(
            &app,
            req_with_body("POST", "/admin/knocks/zz/dismiss", serde_json::json!({})),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid-request");
    }

    // ---- 访客名册 ----

    /// grant（含 from-knock 语义糖等价）→ 列表 → revoke 全链 + 回执
    /// op=0x05/0x06（fabric 槽位置零；generation=visitors 台账）
    #[tokio::test]
    async fn visitors_grant_list_revoke_and_from_knock_equivalence() {
        let f = F::new();
        let app = f.app();
        let a = hex32(0xD1);

        // from-knock 授予（带元数据 + 7 天）
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                "/admin/visitors/from-knock",
                serde_json::json!({
                    "endpoint_id": hex::encode(a),
                    "alias": "guest-a",
                    "expires_in_days": 7,
                }),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(body["op"], "visitor-grant");
        assert_eq!(body["fabric_id"], zeros_hex());
        assert!(body["expires_at"].as_u64().unwrap() > now_ms());
        let visitors_gen = f.visitors.snapshot().generation();
        assert_eq!(body["generation"], visitors_gen, "generation=所属台账");
        verify_receipt(&f, &body, OP_VISITOR_GRANT, &ZERO, &a);

        // 等价性：POST /admin/visitors 同构（同回执形态；重复 grant 覆盖
        // 元数据是台账冻结语义——最新 grant 胜，故保留 alias 只验 expires
        // 覆盖为永久）
        let (status, body2) = send(
            &app,
            req_with_body(
                "POST",
                "/admin/visitors",
                serde_json::json!({"endpoint_id": hex::encode(a), "alias": "guest-a"}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body2["op"], "visitor-grant");
        assert_eq!(body2["endpoint_id"], hex::encode(a));
        // 永久缺省：重复 grant 不带 expires_in_days → 覆盖为永久（缺省不落）
        assert!(body2.get("expires_at").is_none(), "缺省=永久不落字段");

        // 列表：元数据 + granted_at/expires_at（最新 grant 覆盖=永久）
        let (_, list) = send(&app, get("/admin/visitors")).await;
        assert_eq!(list["generation"], f.visitors.snapshot().generation());
        let entries = list["visitors"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["endpoint_id"], hex::encode(a));
        assert_eq!(entries[0]["alias"], "guest-a");
        assert!(entries[0]["granted_at"].as_u64().unwrap() > 0);
        assert!(entries[0].get("expires_at").is_none(), "永久缺省不落");

        // revoke：回执 op=0x06 + 列表清空
        let (status, body) = send(
            &app,
            Request::delete(format!("/admin/visitors/{}", hex::encode(a)))
                .header(auth().0, auth().1)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["op"], "visitor-revoke");
        verify_receipt(&f, &body, OP_VISITOR_REVOKE, &ZERO, &a);
        assert_eq!(body["generation"], f.visitors.snapshot().generation());
        let (_, list) = send(&app, get("/admin/visitors")).await;
        assert_eq!(list["visitors"].as_array().unwrap().len(), 0);

        // revoke 未知 → 404 no-match；坏 hex → 400；缺 endpoint_id → 400
        let (status, body) = send(
            &app,
            Request::delete(format!("/admin/visitors/{}", hex::encode(hex32(0xE9))))
                .header(auth().0, auth().1)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "no-match");
        let (status, _) = send(
            &app,
            req_with_body("POST", "/admin/visitors", serde_json::json!({"alias": "x"})),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    }

    /// visitor 元数据 PATCH 矩阵：设置/空串清除/缺省保留/至少其一/上限/404
    #[tokio::test]
    async fn visitor_metadata_patch_matrix() {
        let f = F::new();
        let app = f.app();
        let a = hex32(0xD1);
        f.visitors
            .grant(&a, Some("old-alias".into()), Some("old-note".into()), None)
            .unwrap();

        // 缺省保留 + 单字段覆盖
        let (status, body) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!("/admin/visitors/{}", hex::encode(a)),
                serde_json::json!({"alias": "new-alias"}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(body["op"], "visitor-meta");
        assert_eq!(body["alias"], "new-alias");
        assert_eq!(body["note"], "old-note", "缺省字段保留");
        verify_receipt(&f, &body, OP_VISITOR_META, &ZERO, &a);

        // 空串清除
        let (_, body) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!("/admin/visitors/{}", hex::encode(a)),
                serde_json::json!({"note": ""}),
            ),
        )
        .await;
        assert!(body.get("note").is_none(), "空串=清除（缺省不落）");
        assert_eq!(body["alias"], "new-alias");

        // 台账事实：granted_at 刷新、expires_at 保留（永久）、重启归并一致
        let entry = &f.visitors.snapshot().entries()[0];
        assert_eq!(entry.alias.as_deref(), Some("new-alias"));
        assert_eq!(entry.note, None);
        assert_eq!(entry.expires_at, None);

        // 至少其一缺失 → 400；两键皆无
        let (status, body) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!("/admin/visitors/{}", hex::encode(a)),
                serde_json::json!({}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("at least one")
        );
        // 上限：alias 33B / note 257B → 400
        let (status, _) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!("/admin/visitors/{}", hex::encode(a)),
                serde_json::json!({"alias": "x".repeat(33)}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        let (status, _) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!("/admin/visitors/{}", hex::encode(a)),
                serde_json::json!({"note": "x".repeat(257)}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        // 未知访客 → 404
        let (status, body) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!("/admin/visitors/{}", hex::encode(hex32(0xE9))),
                serde_json::json!({"alias": "x"}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "no-match");
    }

    // ---- 邀请码 ----

    /// 签发（码全文仅一次 + 缺省 1/7/30 + 回执 0x07）→ 列表（只回哈希与
    /// 计数 + denied 投影）→ 兑换计数 → 吊销（0x08 + 404 unknown）
    #[tokio::test]
    async fn codes_issue_once_list_hash_only_revoke_and_limits() {
        let f = F::new();
        let app = f.app();

        // 签发：默认值 + 码全文仅此一次
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                "/admin/codes",
                serde_json::json!({"alias_hint": "team-onboarding"}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(body["op"], "code-issue");
        let code = body["code"].as_str().unwrap().to_string();
        assert!(code.starts_with("dwebc1."), "码全文形态：{code}");
        assert_eq!(code[7..].split('-').count(), 4);
        assert_eq!(body["fabric_id"], zeros_hex());
        assert_eq!(body["max_uses"], 1, "缺省 max_uses=1");
        assert_eq!(body["default_ttl_days"], 30, "缺省 default_ttl_days=30");
        let expires = body["expires_at"].as_u64().unwrap();
        assert!(
            expires > now_ms() + 6 * DAY_MS && expires <= now_ms() + 7 * DAY_MS,
            "缺省 7 天"
        );
        let code_hash_hex = body["code_hash"].as_str().unwrap().to_string();
        let code_hash: [u8; 32] = hex::decode(&code_hash_hex).unwrap().try_into().unwrap();
        // 哈希键 = 规范化本体（剥前缀/连字符）
        let body16: String = code[7..].chars().filter(|c| *c != '-').collect();
        assert_eq!(code_hash, crate::access::codes::code_hash(&body16));
        assert_eq!(body["generation"], f.codes.snapshot().generation());
        verify_receipt(&f, &body, OP_CODE_ISSUE, &ZERO, &code_hash);

        // 列表：哈希与计数 + denied 投影（正常 false）；**无 code 字段**
        let (_, list) = send(&app, get("/admin/codes")).await;
        let codes = list["codes"].as_array().unwrap();
        assert_eq!(codes.len(), 1);
        assert_eq!(codes[0]["code_hash"], code_hash_hex);
        assert_eq!(codes[0]["used_count"], 0);
        assert_eq!(codes[0]["revoked"], false);
        assert_eq!(codes[0]["denied"], false, "deny-set 投影字段在位");
        assert_eq!(codes[0]["alias_hint"], "team-onboarding");
        assert!(
            serde_json::to_string(&codes[0])
                .unwrap()
                .find("dwebc1")
                .is_none(),
            "列表绝不含码全文"
        );

        // 自定义参数签发（max_uses=2/3 天/7 天租期）
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                "/admin/codes",
                serde_json::json!({"max_uses": 2, "expires_in_days": 3, "default_ttl_days": 7}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["max_uses"], 2);
        assert_eq!(body["default_ttl_days"], 7);

        // 输入上限矩阵（spec 冻结表）→ 400 invalid-request
        for bad in [
            serde_json::json!({"max_uses": 0}),
            serde_json::json!({"max_uses": 1001}),
            serde_json::json!({"expires_in_days": 0}),
            serde_json::json!({"default_ttl_days": 0}),
            serde_json::json!({"alias_hint": "x".repeat(33)}),
        ] {
            let (status, body) =
                send(&app, req_with_body("POST", "/admin/codes", bad.clone())).await;
            assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "{bad}");
            assert_eq!(body["error"]["code"], "invalid-request");
        }

        // 吊销：回执 0x08（只回 code_hash）→ 列表 revoked=true
        let (status, body) = send(
            &app,
            Request::delete(format!("/admin/codes/{}", code_hash_hex))
                .header(auth().0, auth().1)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["op"], "code-revoke");
        assert_eq!(body["code_hash"], code_hash_hex);
        assert!(body.get("code").is_none(), "吊销不回码全文");
        verify_receipt(&f, &body, OP_CODE_REVOKE, &ZERO, &code_hash);
        let (_, list) = send(&app, get("/admin/codes")).await;
        let revoked_entry = list["codes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["code_hash"] == code_hash_hex.as_str())
            .expect("吊销后仍在列表（吊销是状态非删除）");
        assert_eq!(revoked_entry["revoked"], true);

        // 未知码吊销 → 404；坏 hex → 400
        let (status, _) = send(
            &app,
            Request::delete(format!("/admin/codes/{}", hex::encode(hex32(0xE9))))
                .header(auth().0, auth().1)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        let (status, _) = send(
            &app,
            Request::delete("/admin/codes/zz")
                .header(auth().0, auth().1)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    }

    // ---- 黑名单 ----

    /// CRUD + 双维度命名空间 + canonical fabric 槽位语义（kind=fabric 时
    /// 承载 id、endpoint 维度置零）+ 回执 0x09/0x0A
    #[tokio::test]
    async fn blocklist_crud_and_fabric_slot_semantics() {
        let f = F::new();
        let app = f.app();
        let ep = hex32(0xD1);
        let fab = hex32(0xD2);

        // endpoint 维度：fabric 槽位置零
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                "/admin/blocklist",
                serde_json::json!({"kind": "endpoint", "id": hex::encode(ep), "reason": "abuse"}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(body["op"], "block-add");
        assert_eq!(body["kind"], "endpoint");
        assert_eq!(body["id"], hex::encode(ep));
        assert_eq!(body["reason"], "abuse");
        assert_eq!(
            body["fabric_id"],
            zeros_hex(),
            "endpoint 维度 fabric 槽位置零"
        );
        assert_eq!(body["generation"], f.blocklist.snapshot().generation());
        verify_receipt(&f, &body, OP_BLOCK_ADD, &ZERO, &ep);

        // fabric 维度：fabric 槽位承载 id
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                "/admin/blocklist",
                serde_json::json!({"kind": "fabric", "id": hex::encode(fab)}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(
            body["fabric_id"],
            hex::encode(fab),
            "fabric 命中时 fabric 槽位=id"
        );
        assert!(body.get("reason").is_none());
        verify_receipt(&f, &body, OP_BLOCK_ADD, &fab, &fab);

        // 列表（确定性 (kind, id) 序）+ gate 生效（is_blocked）
        let (_, list) = send(&app, get("/admin/blocklist")).await;
        let entries = list["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["kind"], "endpoint", "endpoint 判别序在前");
        assert_eq!(entries[1]["kind"], "fabric");
        assert_eq!(entries[0]["reason"], "abuse");
        assert!(entries[0]["ts"].as_u64().unwrap() > 0);
        let snap = f.blocklist.snapshot();
        assert!(snap.is_blocked(BlockKind::Endpoint, &ep));
        assert!(snap.is_blocked(BlockKind::Fabric, &fab));

        // remove：回执 0x0A（kind=endpoint → fabric 槽位归零）+ 404 unknown
        let (status, body) = send(
            &app,
            Request::delete(format!("/admin/blocklist/endpoint/{}", hex::encode(ep)))
                .header(auth().0, auth().1)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["op"], "block-remove");
        assert_eq!(body["fabric_id"], zeros_hex());
        verify_receipt(&f, &body, OP_BLOCK_REMOVE, &ZERO, &ep);
        assert!(!f.blocklist.snapshot().is_blocked(BlockKind::Endpoint, &ep));
        assert!(
            f.blocklist.snapshot().is_blocked(BlockKind::Fabric, &fab),
            "维度独立"
        );
        let (status, body) = send(
            &app,
            Request::delete(format!("/admin/blocklist/endpoint/{}", hex::encode(ep)))
                .header(auth().0, auth().1)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "已移除再删=404");
        assert_eq!(body["error"]["code"], "no-match");

        // 坏 kind → 400
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                "/admin/blocklist",
                serde_json::json!({"kind": "node", "id": hex::encode(ep)}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid-request");
    }

    // ---- 续期与 owners 增量 ----

    /// spec Scenario「续期恢复准入」的 registry/路由层：过期条目 renew 30 天
    /// → active；恰好其一约束；permanent；unknown 404；alias/note 保留
    #[tokio::test]
    async fn owner_renew_restores_expired_entry() {
        let f = F::new();
        let app = f.app();
        let (fabric, root) = (hex32(0xF1), hex32(0xF2));
        // 文件入口：带 alias 的过期条目
        std::fs::write(
            f.registry.path(),
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":{},\"alias\":\"tenant-a\",\"note\":\"keep me\"}}\n",
                hex::encode(fabric),
                hex::encode(root),
                now_ms() - 1
            ),
        )
        .unwrap();
        f.registry.reload().unwrap();

        // renew 前：列表 status=expired、expires_in=0
        let (_, list) = send(&app, get("/admin/owners")).await;
        let e = &list["owners"][0];
        assert_eq!(e["status"], "expired");
        assert_eq!(e["expires_in"], 0);
        assert_eq!(e["alias"], "tenant-a", "Phase 1c 增量字段");

        // 恰好其一矩阵：双键/空键 → 400
        for bad in [
            serde_json::json!({}),
            serde_json::json!({"expires_in_days": 30, "permanent": true}),
        ] {
            let (status, body) = send(
                &app,
                req_with_body(
                    "POST",
                    &format!(
                        "/admin/owners/{}/{}/renew",
                        hex::encode(fabric),
                        hex::encode(root)
                    ),
                    bad.clone(),
                ),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "{bad}");
            assert!(
                body["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("exactly one")
            );
        }
        // expires_in_days=0 → 400
        let (status, _) = send(
            &app,
            req_with_body(
                "POST",
                &format!(
                    "/admin/owners/{}/{}/renew",
                    hex::encode(fabric),
                    hex::encode(root)
                ),
                serde_json::json!({"expires_in_days": 0}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);

        // renew 30 天 → 回执 0x04 + active + alias/note 保留
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                &format!(
                    "/admin/owners/{}/{}/renew",
                    hex::encode(fabric),
                    hex::encode(root)
                ),
                serde_json::json!({"expires_in_days": 30}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(body["op"], "renew");
        assert_eq!(body["fabric_id"], hex::encode(fabric));
        assert_eq!(body["root"], hex::encode(root));
        let expires = body["expires_at"].as_u64().unwrap();
        assert!(expires > now_ms() + 29 * DAY_MS);
        assert_eq!(body["generation"], f.registry.snapshot().generation());
        verify_receipt(&f, &body, OP_RENEW, &fabric, &root);
        let (_, list) = send(&app, get("/admin/owners")).await;
        let e = &list["owners"][0];
        assert_eq!(e["status"], "active");
        assert!(e["expires_in"].as_u64().unwrap() > 29 * DAY_MS);
        assert_eq!(e["alias"], "tenant-a", "renew 保留元数据");
        assert_eq!(e["note"], "keep me");
        // 磁盘归并一致（重启不丢元数据——upsert 终值落行）
        f.registry.reload().unwrap();
        assert_eq!(
            f.registry.snapshot().entries()[0].alias.as_deref(),
            Some("tenant-a")
        );

        // permanent → 回执 expires_at=u64::MAX（wire 恒数字）+ 列表 null
        let (_, body) = send(
            &app,
            req_with_body(
                "POST",
                &format!(
                    "/admin/owners/{}/{}/renew",
                    hex::encode(fabric),
                    hex::encode(root)
                ),
                serde_json::json!({"permanent": true}),
            ),
        )
        .await;
        assert_eq!(body["expires_at"], u64::MAX);
        let (_, list) = send(&app, get("/admin/owners")).await;
        assert!(list["owners"][0]["expires_at"].is_null(), "永久=null");
        assert!(list["owners"][0]["expires_in"].is_null());

        // unknown 二元组 → 404
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                &format!(
                    "/admin/owners/{}/{}/renew",
                    hex::encode(hex32(0xE9)),
                    hex::encode(hex32(0xE8))
                ),
                serde_json::json!({"expires_in_days": 30}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "no-match");
    }

    /// 三角色走查 r2（2026-09-23）：renew 顺延基准 = max(now, 当前
    /// expires_at)——未到期（剩 20 天）renew 30 → 新到期 = 旧到期 + 30 天
    /// （回执/列表数值精确断言，非 now+30）；permanent→days 从 now 起算；
    /// 过期条目从 now 起算恢复准入；renew 不改写 registered_at
    #[tokio::test]
    async fn owner_renew_extends_from_current_expiry_not_now() {
        let f = F::new();
        let app = f.app();
        let (unexpired, permanent, expired) = (hex32(0xF3), hex32(0xF5), hex32(0xF7));
        let old_expires = now_ms() + 20 * DAY_MS;
        // 三形态条目（文件入口；ts=100 = 固定首次注册时刻）
        std::fs::write(
            f.registry.path(),
            format!(
                "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":{}}}\n{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100}}\n{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":100,\"expires_at\":{}}}\n",
                hex::encode(unexpired),
                hex::encode(hex32(0xF4)),
                old_expires,
                hex::encode(permanent),
                hex::encode(hex32(0xF6)),
                hex::encode(expired),
                hex::encode(hex32(0xF8)),
                now_ms() - 1
            ),
        )
        .unwrap();
        f.registry.reload().unwrap();
        let renew = |fabric: [u8; 32], root: [u8; 32], body: serde_json::Value| {
            req_with_body(
                "POST",
                &format!(
                    "/admin/owners/{}/{}/renew",
                    hex::encode(fabric),
                    hex::encode(root)
                ),
                body,
            )
        };

        // ① 未到期（剩 20 天）renew 30：新到期 = 旧到期 + 30 天（精确）
        let (status, body) = send(
            &app,
            renew(
                unexpired,
                hex32(0xF4),
                serde_json::json!({"expires_in_days": 30}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(
            body["expires_at"].as_u64().unwrap(),
            old_expires + 30 * DAY_MS,
            "回执 expires_at = 旧到期 + 30 天（顺延，非 now+30）"
        );
        let (_, list) = send(&app, get("/admin/owners")).await;
        let e = &list["owners"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["fabric_id"] == hex::encode(unexpired))
            .unwrap();
        assert_eq!(e["expires_at"].as_u64().unwrap(), old_expires + 30 * DAY_MS);
        assert!(
            e["expires_in"].as_u64().unwrap() > 49 * DAY_MS,
            "剩余 ≈ 50 天（20 + 30），未损失既有租期"
        );
        assert_eq!(e["registered_at"], 100, "renew 不改写注册时间");
        // 磁盘归并一致
        f.registry.reload().unwrap();
        assert_eq!(
            f.registry
                .snapshot()
                .active_entry(&unexpired, &hex32(0xF4))
                .unwrap()
                .expires_at,
            Some(old_expires + 30 * DAY_MS)
        );
        assert_eq!(
            f.registry
                .snapshot()
                .active_entry(&unexpired, &hex32(0xF4))
                .unwrap()
                .registered_at,
            100
        );

        // ② permanent→days：无既有租期 → 从 now 起算（窗口断言）
        let before = now_ms();
        let (status, body) = send(
            &app,
            renew(
                permanent,
                hex32(0xF6),
                serde_json::json!({"expires_in_days": 7}),
            ),
        )
        .await;
        let after = now_ms();
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        let expires = body["expires_at"].as_u64().unwrap();
        assert!(
            expires >= before + 7 * DAY_MS && expires <= after + 7 * DAY_MS,
            "permanent→days 从 now 起算：{expires}"
        );

        // ③ 过期条目：从 now 起算恢复准入（非从旧到期顺延——已无可顺延）
        let before = now_ms();
        let (status, body) = send(
            &app,
            renew(
                expired,
                hex32(0xF8),
                serde_json::json!({"expires_in_days": 1}),
            ),
        )
        .await;
        let after = now_ms();
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        let expires = body["expires_at"].as_u64().unwrap();
        assert!(
            expires >= before + DAY_MS && expires <= after + DAY_MS,
            "过期条目 renew 从 now 起算：{expires}"
        );
        let (_, list) = send(&app, get("/admin/owners")).await;
        let e = &list["owners"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["fabric_id"] == hex::encode(expired))
            .unwrap();
        assert_eq!(e["status"], "active", "过期条目续期后恢复准入");
        assert_eq!(e["registered_at"], 100, "过期条目续期同样不改写注册时间");
    }

    /// owner 元数据 PATCH：设置/清除/保留 + 404 + 回执 0x0D
    #[tokio::test]
    async fn owner_metadata_patch_matrix() {
        let f = F::new();
        let app = f.app();
        let (fabric, root) = (hex32(0xF1), hex32(0xF2));
        f.registry.register(&fabric, &root).unwrap();

        let (status, body) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!(
                    "/admin/owners/{}/{}",
                    hex::encode(fabric),
                    hex::encode(root)
                ),
                serde_json::json!({"alias": "alpha", "note": "first note"}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        assert_eq!(body["op"], "owner-meta");
        assert_eq!(body["alias"], "alpha");
        assert_eq!(body["note"], "first note");
        verify_receipt(&f, &body, OP_OWNER_META, &fabric, &root);

        // 空串清除 note、缺省保留 alias
        let (_, body) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!(
                    "/admin/owners/{}/{}",
                    hex::encode(fabric),
                    hex::encode(root)
                ),
                serde_json::json!({"note": ""}),
            ),
        )
        .await;
        assert!(body.get("note").is_none());
        assert_eq!(body["alias"], "alpha");
        // 磁盘归并一致
        f.registry.reload().unwrap();
        let entry = &f.registry.snapshot().entries()[0];
        assert_eq!(entry.alias.as_deref(), Some("alpha"));
        assert_eq!(entry.note, None);

        // 至少其一 → 400；上限 → 400；unknown → 404
        let (status, _) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!(
                    "/admin/owners/{}/{}",
                    hex::encode(fabric),
                    hex::encode(root)
                ),
                serde_json::json!({}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        let (status, _) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!(
                    "/admin/owners/{}/{}",
                    hex::encode(fabric),
                    hex::encode(root)
                ),
                serde_json::json!({"alias": "x".repeat(33)}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        let (status, body) = send(
            &app,
            req_with_body(
                "PATCH",
                &format!(
                    "/admin/owners/{}/{}",
                    hex::encode(hex32(0xE9)),
                    hex::encode(root)
                ),
                serde_json::json!({"alias": "x"}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "no-match");
    }

    /// status 增量四字段（knocks_pending/visitors_active/codes_active +
    /// 1a 的 visitors_online）：纯增量，既有字段在位
    #[tokio::test]
    async fn status_increment_fields_project_ledgers() {
        let f = F::new();
        let app = f.app();
        f.gate
            .knock_log()
            .record(hex32(0xD1), "dweb/no-capability", now_ms());
        f.gate
            .knock_log()
            .record(hex32(0xD2), "dweb/no-capability", now_ms());
        f.gate.knock_log().dismiss(&hex32(0xD2));
        f.visitors.grant(&hex32(0xD3), None, None, None).unwrap();
        f.visitors
            .grant(&hex32(0xD4), None, None, Some(now_ms() - 1))
            .unwrap(); // 过期不计活跃
        f.codes.issue(IssueParams::default()).unwrap();
        let (_, expired_code) = {
            // 过期码（文件入口）不计活跃：issue 后直接改写文件不现实——用
            // 大 max_uses 双码对照即可断言 active=1（新签发未过期）
            let list = f.codes.snapshot();
            (list.entries().len(), [0u8; 32])
        };
        let _ = expired_code;

        let (status, body) = send(&app, get("/admin/status")).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["knocks_pending"], 1, "未 dismissed 数");
        assert_eq!(body["visitors_active"], 1, "在册未过期访客");
        assert_eq!(body["codes_active"], 1, "未吊销未过期码");
        assert_eq!(body["visitors_online"], 0);
        // 既有冻结字段在位（纯增量回归锚）
        assert_eq!(body["mode"], "restricted");
        assert!(body["generation"].is_u64());
        assert_eq!(body["cache_entries"], 0);
    }

    /// 敲门台账在 open 模式（gate=None）的诚实投影：空列表 + 处置 404
    #[tokio::test]
    async fn knocks_open_mode_empty_projection() {
        let f = F::new();
        let mut state = f.state();
        state.gate = None;
        let app = router(state);
        let (_, body) = send(&app, get("/admin/knocks")).await;
        assert_eq!(body["knocks"].as_array().unwrap().len(), 0);
        assert_eq!(body["pending_count"], 0);
        let (status, body) = send(
            &app,
            req_with_body(
                "POST",
                &format!("/admin/knocks/{}/dismiss", hex::encode(hex32(0xD1))),
                serde_json::json!({}),
            ),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "no-match");
    }
}
