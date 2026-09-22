//! Admin API：gateway 上的受保护管理面（task 3.1，Phase 3 运营面；需求来源
//! 2026-09-17/18；design §6.2 server.key 职责 / §11.2 配置面 / specs/server
//! 「Server 访问策略」requirement——**admin 面**而非 owner 面：Server Admin
//! （本地配置管理者）与 Relay Owner（registry 内 fabric root）是不同身份，
//! 服务端 MUST NOT 提供 Owner 自助注册，注册是 Admin 动作（spec 冻结））。
//!
//! **admin token 方案（design §6.2「admin token 签发验证」的实现裁定）**：
//! `Authorization: Bearer <DWEB_ADMIN_TOKEN>`——env 配置的静态 token，部署期
//! 生成；未配置/空 = main 完全不挂载 admin 路由（404，零暴露面）。
//! 备选方案「server.key 对 challenge 签名」被否决：需要交互式握手
//! （challenge→sign→verify 三步）才能证明持有 server.key 派生凭证，而 admin
//! API 是低频运维面，静态 token 在 admin 信任域（本地 env/配置，与
//! callback_token 同级信任模型：泄露 = 管理面泄露，不影响密码学层）足够，
//! 且免除握手状态机。server.key 仍只签注册回执、不签 capability（§6.2
//! 收窄原则不变）。
//!
//! 路由（全部要求 Bearer）：
//! - `GET /admin/owners` → `{generation, owners:[{fabric_id,root,
//!   registered_at}]}`（活跃集合确定性排序）
//! - `POST /admin/owners`（`{fabric_id_hex, root_hex}`）→ 注册：jsonl
//!   append+fsync + 快照替换 + generation+1 + callback 缓存失效——复用
//!   `OwnerRegistry::register`，与 CLI / 文件重载三入口收敛到同一实例；
//!   成功响应附 `receipt_sig`（server.key 对 canonical
//!   `{op,fabric_id,root,ts,generation}` 的 Ed25519 签名，design §6.2 注册
//!   回执可审计；响应自带全部被签字段，可对 services.json 公布的 ServerId
//!   独立验签）
//! - `DELETE /admin/owners/{fabric_id}/{root}` → 注销（同上，回执同构；
//!   **task 3.2b 踢存量**：unregister 后对 gate 在线表反查该 fabric 名下
//!   全部 endpoint，逐个 `Clients::disconnect(ep, None)`（iroh-relay
//!   1.1.0 公开 API，异步 start_shutdown → OnDisconnectGuard drop → 配额
//!   自动释放），响应附 `kicked_endpoints`/`kicked_connections` 计数）
//! - `GET /admin/status` → `{mode, policy, generation,
//!   max_connections_per_owner, active_connections（per endpoint 票接入
//!   在线表，task 3.2）, per_owner_connections, cache_entries}`（既有冻结
//!   wire，sdk-mgmt-surface 不动——详细视图走 connections）
//! - `GET /admin/connections` → 详细在线视图 `{mode, policy, relay_enabled,
//!   quota{configured,max_connections_per_owner}, per_endpoint, per_owner}`
//!   （sdk-mgmt-surface task 1.4；mode 取 access 配置字段、relay_enabled
//!   取装配事实，两字段独立——restricted+无 relay 不得误报 open）
//! - `POST /admin/connections/disconnect` → 主动断连（task 1.3；请求体
//!   `{endpoint_id}` 或 `{fabric_id}` 恰好其一，per-target 回执 op=0x03）
//!
//! **错误 envelope（sdk-mgmt-surface 冻结）**：管理面业务错误统一
//! `{"error":{"code","message"}}`——401 `unauthorized` / 400 请求不可解析
//! `invalid-request` / 404 业务未命中 `no-match` / 500 registry 故障
//! `registry`。既有 401/400 单字符串 body 是**有意的 minor wire change**
//! （旧消费者只看 status code，影响面零）。
//!
//! **断连语义边界（design §13 勘定）**：admin API 的 DELETE 是 admin 动作
//! 的即时全灭（存量连接一并断开）；文件热重载路径（CLI owners unregister
//! → mtime 看护 reload）**不踢存量**——维持 Phase 1 冻结的「新连接即时拒、
//! 存量靠 TTL/重连收敛」语义。两条撤销入口的差异在此显式声明，不视为
//! 不一致：API 是运维面强操作，文件是声明面最终一致。
//!
//! 热加载路径保留：owners.jsonl 仍是 source of truth——API 只经 registry
//! 写入，mtime 看护随后的一次 reload 只会再 +1 generation（缓存键随
//! generation 变化，正确性无损；admin 信任域内的冗余事件被日志吸收）。

use crate::access::config::AccessMode;
use crate::access::gate::{AccessGate, OnlineEndpoint, OnlineView};
use crate::access::identity::ServerIdentity;
use crate::access::registry::{OwnerRegistry, parse_owner_hex};
use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use iroh_base::EndpointId;
use iroh_relay::server::clients::Clients;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// 回执签名域分隔前缀（18B + 1B op，不进任何 wire 帧；与 relay-cap 域
/// b"dweb/relay-cap/v1\0" 不同源，跨域重放无意义）
const RECEIPT_DOMAIN: &[u8] = b"dweb/admin-receipt/v1\0";
const OP_REGISTER: u8 = 0x01;
const OP_UNREGISTER: u8 = 0x02;
/// disconnect 回执 op（target 槽位承载被断 endpoint_id——布局复用冻结
/// canonical，JSON 层用显式 endpoint_id 字段不复用 root 键名）
const OP_DISCONNECT: u8 = 0x03;

/// admin API 共享状态（main 在 DWEB_ADMIN_TOKEN 存在时构造并挂载）。
/// `gate` = relay gate（restricted 模式；open 模式 None——无验证链即无
/// 在线统计，status 如实投影为空集合）。`relay_clients` = iroh-relay
/// 在线连接表句柄（task 3.2b 踢存量用；`Server::relay_service()` →
/// `RelayService::clients()` 的 clone——relay 未启用时 None，此时
/// unregister 仍即时阻断新连接，仅无法主动断存量）。`relay_enabled` =
/// relay 服务装配事实（构造期注入，与 gate 句柄无推导关系——restricted
/// 恒建 gate，gate=None 不代表 open，connections 投影的 mode/relay_enabled
/// 必须各自独立取值，P0-2）。
#[derive(Clone)]
pub struct AdminState {
    token: String,
    identity: Arc<ServerIdentity>,
    registry: Arc<OwnerRegistry>,
    gate: Option<Arc<AccessGate>>,
    relay_clients: Option<Clients>,
    mode: AccessMode,
    policy: &'static str,
    relay_enabled: bool,
}

impl AdminState {
    /// 构造（`policy` 取 "static"|"callback"，与启动日志同源标签；
    /// `relay_clients`/`relay_enabled` 见结构体注释）。参数与字段一一对应
    /// （main 装配的部署事实清单），8 参不聚合——引入 config struct 反而
    /// 掩盖「每字段一个装配来源」的对应关系
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        token: String,
        identity: Arc<ServerIdentity>,
        registry: Arc<OwnerRegistry>,
        gate: Option<Arc<AccessGate>>,
        relay_clients: Option<Clients>,
        mode: AccessMode,
        policy: &'static str,
        relay_enabled: bool,
    ) -> Self {
        Self {
            token,
            identity,
            registry,
            gate,
            relay_clients,
            mode,
            policy,
            relay_enabled,
        }
    }
}

/// 挂载 admin 路由（仅当 DWEB_ADMIN_TOKEN 已配置时由 main 调用；
/// 未配置 = 不挂载 = 404 零暴露）
pub fn router(state: AdminState) -> Router {
    Router::new()
        .route("/admin/owners", get(list_owners).post(register_owner))
        .route(
            "/admin/owners/{fabric_id}/{root}",
            axum::routing::delete(unregister_owner),
        )
        .route("/admin/status", get(status))
        .route("/admin/connections", get(connections))
        .route(
            "/admin/connections/disconnect",
            axum::routing::post(disconnect),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_guard,
        ))
        .with_state(state)
}

/// Bearer 鉴权中间件：scheme 大小写不敏感（HTTP 语义，与 relay 面
/// strip_bearer 同构）；token 比较为常量时间（长度先行情报可接受——
/// 剩余字节不泄露）。任何缺失/不符 → 401 envelope。
async fn auth_guard(State(state): State<AdminState>, req: Request, next: Next) -> Response {
    let authorized = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| match value.split_once(' ') {
            Some((scheme, token)) if scheme.eq_ignore_ascii_case("Bearer") => {
                ct_eq(token, &state.token)
            }
            _ => false,
        })
        .unwrap_or(false);
    if !authorized {
        return error_envelope(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid admin bearer token",
        );
    }
    next.run(req).await
}

/// 常量时间字符串相等（admin token 比较面；早退长度差只泄露长度）
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 管理面错误 envelope（sdk-mgmt-surface 冻结）：所有业务错误响应统一
/// `{"error":{"code","message"}}`（Content-Type application/json）。
/// code 表：unauthorized / invalid-request / no-match / registry。
fn error_envelope(status: StatusCode, code: &str, message: &str) -> Response {
    let body = serde_json::json!({ "error": { "code": code, "message": message } });
    (status, Json(body)).into_response()
}

/// handler 层错误 → HTTP 映射（错误体统一 envelope，见 error_envelope）
enum AdminError {
    /// 请求不可解析：JSON 形态/hex 非法/键约束违反（400 invalid-request）
    InvalidRequest(String),
    /// registry 写入/IO 失败（500 registry）
    Registry(String),
    /// 业务未命中：disconnect 目标不在在线表快照（404 no-match）
    NoMatch(String),
}

impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        match self {
            Self::InvalidRequest(msg) => {
                error_envelope(StatusCode::BAD_REQUEST, "invalid-request", &msg)
            }
            Self::Registry(msg) => {
                error_envelope(StatusCode::INTERNAL_SERVER_ERROR, "registry", &msg)
            }
            Self::NoMatch(msg) => error_envelope(StatusCode::NOT_FOUND, "no-match", &msg),
        }
    }
}

// ---- GET /admin/owners ----

#[derive(Serialize)]
struct OwnersList {
    generation: u64,
    owners: Vec<OwnerInfo>,
}

#[derive(Serialize)]
struct OwnerInfo {
    /// 小写 hex64（与 owners.jsonl 展示形态一致）
    fabric_id: String,
    root: String,
    registered_at: u64,
}

async fn list_owners(State(state): State<AdminState>) -> Json<OwnersList> {
    let snapshot = state.registry.snapshot();
    Json(OwnersList {
        generation: snapshot.generation(),
        owners: snapshot
            .entries()
            .into_iter()
            .map(|e| OwnerInfo {
                fabric_id: hex::encode(e.fabric_id),
                root: hex::encode(e.root),
                registered_at: e.registered_at,
            })
            .collect(),
    })
}

// ---- POST /admin/owners + DELETE /admin/owners/{fabric_id}/{root} ----

#[derive(Deserialize)]
struct RegisterOwnerBody {
    fabric_id_hex: String,
    root_hex: String,
}

/// 注册回执（全部被签字段随响应返回——客户端可对 services.json 的
/// ServerId 独立验证 receipt_sig，无需其它带外信息）。
/// `kicked_*` 仅 unregister 响应携带（task 3.2b 踢存量计数；register /
/// open 模式 / relay 未启用时缺省不出现）。
#[derive(Serialize)]
struct Receipt {
    op: &'static str,
    fabric_id: String,
    root: String,
    ts: u64,
    generation: u64,
    /// base64url-nopad(64B)（Ed25519 over RECEIPT_DOMAIN || canonical）
    receipt_sig: String,
    /// disconnect 命中并已下发 start_shutdown 的 endpoint 数
    /// （unregister only；relay 在线表反查 × Clients::disconnect 返回 true）
    #[serde(skip_serializing_if = "Option::is_none")]
    kicked_endpoints: Option<usize>,
    /// 被踢 endpoint 在线表视角的连接总数（unregister only）
    #[serde(skip_serializing_if = "Option::is_none")]
    kicked_connections: Option<usize>,
}

async fn register_owner(
    State(state): State<AdminState>,
    body: Result<Json<RegisterOwnerBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Receipt>, AdminError> {
    // JSON 解析失败同入 invalid-request envelope（400 面统一迁移）
    let Json(body) = body.map_err(|e| AdminError::InvalidRequest(e.body_text()))?;
    let fabric_id = parse_owner_hex(&body.fabric_id_hex).map_err(AdminError::InvalidRequest)?;
    let root = parse_owner_hex(&body.root_hex).map_err(AdminError::InvalidRequest)?;
    apply_mutation(&state, OP_REGISTER, "register", fabric_id, root).map(Json)
}

async fn unregister_owner(
    State(state): State<AdminState>,
    Path((fabric_id_hex, root_hex)): Path<(String, String)>,
) -> Result<Json<Receipt>, AdminError> {
    let fabric_id = parse_owner_hex(&fabric_id_hex).map_err(AdminError::InvalidRequest)?;
    let root = parse_owner_hex(&root_hex).map_err(AdminError::InvalidRequest)?;
    apply_mutation(&state, OP_UNREGISTER, "unregister", fabric_id, root).map(Json)
}

/// 注册/注销共通：registry 变更 → callback 缓存失效 → （注销）踢存量 →
/// 回执签名。registry 写入（jsonl append + fsync + 快照替换 + generation+1）
/// 全部由 OwnerRegistry::mutate 承担——CLI / 文件重载 / admin API 三入口
/// 收敛。
fn apply_mutation(
    state: &AdminState,
    op_code: u8,
    op_label: &'static str,
    fabric_id: [u8; 32],
    root: [u8; 32],
) -> Result<Receipt, AdminError> {
    let result = match op_code {
        OP_REGISTER => state.registry.register(&fabric_id, &root),
        _ => state.registry.unregister(&fabric_id, &root),
    };
    result.map_err(|e| AdminError::Registry(format!("owner {op_label} failed: {e:#}")))?;
    // registry 变更即清 callback 缓存容量（与 mtime 看护同语义；generation
    // 已在缓存键内，正确性双保险）
    if let Some(gate) = &state.gate {
        gate.invalidate_callback_cache();
    }
    // task 3.2b：注销即时踢存量（admin 动作的全灭语义；热重载路径不踢，
    // 见模块注释）。先于快照读取——unregister 已把 owner 移出活跃集合，
    // 但在线表只按 fabric 归属，不受 registry 快照影响。
    let kicked = if op_code == OP_UNREGISTER {
        let (endpoints, connections) = kick_existing_connections(state, &fabric_id);
        (Some(endpoints), Some(connections))
    } else {
        (None, None)
    };
    let generation = state.registry.snapshot().generation();
    let ts = now_ms();
    let sig = state.identity.sign(&receipt_canonical(
        op_code, &fabric_id, &root, ts, generation,
    ));
    tracing::info!(
        op = op_label,
        generation,
        kicked_endpoints = kicked.0.unwrap_or(0),
        kicked_connections = kicked.1.unwrap_or(0),
        "admin API: owner {} (fabric {}, root {})",
        op_label,
        hex::encode(fabric_id),
        hex::encode(root)
    );
    Ok(Receipt {
        op: op_label,
        fabric_id: hex::encode(fabric_id),
        root: hex::encode(root),
        ts,
        generation,
        receipt_sig: URL_SAFE_NO_PAD.encode(sig),
        kicked_endpoints: kicked.0,
        kicked_connections: kicked.1,
    })
}

/// 踢存量连接（task 3.2b，design §13 Phase3-A 评估结论的落地）：单次在线表
/// 快照反查 fabric 名下全部 endpoint → 共享断连原语下发。返回
/// (disconnect 命中的 endpoint 数, 在线表视角被踢连接数)。
///
/// 粒度勘定：在线表按 fabric_id 归属（与 per-owner 配额同一维度）——同一
/// fabric 注册了多个 root 时（非常规形态），注销其一也会全踢该 fabric
/// 的存量；配额语义与此一致，不引入第二粒度。
/// open 模式（gate None）/ relay 未启用（clients None）：零踢除、零副作用
/// ——unregister 的「新连接即时拒」仍由 registry 快照保证。
fn kick_existing_connections(state: &AdminState, fabric_id: &[u8; 32]) -> (usize, usize) {
    let (Some(gate), Some(clients)) = (&state.gate, &state.relay_clients) else {
        return (0, 0);
    };
    let snapshot = gate.online_view();
    let hits = disconnect_endpoints(clients, &endpoints_of_fabric(&snapshot, fabric_id));
    let kicked_connections: usize = hits.iter().map(|e| e.connections).sum();
    (hits.len(), kicked_connections)
}

/// 共享断连原语（task 1.3 抽取）：unregister 踢存量与 disconnect 路由的
/// 唯一下发路径——对单次快照筛出的在线条目逐个
/// `Clients::disconnect(ep, None)`（iroh-relay 异步 start_shutdown，该
/// 物理断连按 endpoint 去重（r4-P0-1）：`Clients::disconnect(endpoint, None)`
/// 的 None 语义 = 断该 endpoint 的**全部**连接——同 endpoint 多 fabric 的
/// 多个 pair 只能调用一次，重复调用第二张 pair 恒 false、会丢 pair 与回执。
/// 动作成功（任一物理 endpoint 下发成功）后，该 endpoint 在快照中的**全部**
/// 匹配 pair 均计入已下发清单（各 pair 各自生成回执，共享 ts/generation）。
/// 返回 false = 连接表已无此 endpoint（诚实整 endpoint 不计入）。
fn disconnect_endpoints(clients: &Clients, entries: &[OnlineEndpoint]) -> Vec<OnlineEndpoint> {
    disconnect_endpoints_with(entries, |endpoint_id| clients.disconnect(endpoint_id, None))
}

/// 断连原语的纯决策核（dispatch 注入便于单测伪造「一次成功覆盖全 endpoint」
/// 的 None 语义）：dispatch 每 endpoint 至多被调用一次；成功过的 endpoint 的
/// 全部 pair 计入返回。
fn disconnect_endpoints_with(
    entries: &[OnlineEndpoint],
    dispatch: impl Fn(EndpointId) -> bool,
) -> Vec<OnlineEndpoint> {
    let mut dispatched: Vec<[u8; 32]> = Vec::new();
    for e in entries {
        if dispatched.contains(&e.endpoint_id) {
            continue; // 同 endpoint 物理动作只做一次
        }
        // 在线表条目源自握手认证身份（合法曲线点）；构造失败 = 该 endpoint
        // 整体诚实跳过
        if let Ok(endpoint_id) = EndpointId::from_bytes(&e.endpoint_id)
            && dispatch(endpoint_id)
        {
            dispatched.push(e.endpoint_id);
        }
    }
    entries
        .iter()
        .filter(|e| dispatched.contains(&e.endpoint_id))
        .cloned()
        .collect()
}

/// 在线表反查（task 3.2b）：fabric 名下在线条目清单（踢存量、kicked
/// 计数与 disconnect 路由的公共映射层；单测在此层冻结）
fn endpoints_of_fabric(view: &OnlineView, fabric_id: &[u8; 32]) -> Vec<OnlineEndpoint> {
    view.per_endpoint
        .iter()
        .filter(|e| e.fabric_id == *fabric_id)
        .cloned()
        .collect()
}

/// status 的 endpoint 级投影（r4-P1-1）：per-pair 视图按 endpoint 聚合——
/// connections 求和、fabric_id 取该 endpoint 名下字典序最小（确定性）。
/// 聚合不依赖输入次序（防御调用方排序不变量变化）。
fn endpoint_level_projection(view: &OnlineView) -> Vec<EndpointOnlineInfo> {
    let mut agg: std::collections::BTreeMap<[u8; 32], ([u8; 32], usize)> =
        std::collections::BTreeMap::new();
    for e in &view.per_endpoint {
        match agg.get_mut(&e.endpoint_id) {
            Some((fabric, count)) => {
                *count += e.connections;
                if e.fabric_id < *fabric {
                    *fabric = e.fabric_id;
                }
            }
            None => {
                agg.insert(e.endpoint_id, (e.fabric_id, e.connections));
            }
        }
    }
    agg.into_iter()
        .map(
            |(endpoint_id, (fabric_id, connections))| EndpointOnlineInfo {
                endpoint_id: hex::encode(endpoint_id),
                fabric_id: hex::encode(fabric_id),
                connections,
            },
        )
        .collect()
}

/// 回执 canonical（design §6.2 {op,fabric_id,root,ts,generation}；全大端）：
/// `b"dweb/admin-receipt/v1\0" || op u8 || fabric_id 32B || root 32B ||
/// ts u64BE || generation u64BE`
pub fn receipt_canonical(
    op: u8,
    fabric_id: &[u8; 32],
    root: &[u8; 32],
    ts: u64,
    generation: u64,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(RECEIPT_DOMAIN.len() + 1 + 32 + 32 + 8 + 8);
    buf.extend_from_slice(RECEIPT_DOMAIN);
    buf.push(op);
    buf.extend_from_slice(fabric_id);
    buf.extend_from_slice(root);
    buf.extend_from_slice(&ts.to_be_bytes());
    buf.extend_from_slice(&generation.to_be_bytes());
    buf
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- GET /admin/status ----

#[derive(Serialize)]
struct Status {
    mode: &'static str,
    policy: &'static str,
    generation: u64,
    /// None = 无上限（task 3.2 默认）
    max_connections_per_owner: Option<usize>,
    /// 票接入在线表（per endpoint；无票 A_cb 接入与 open 模式不在其中——
    /// 前者无 owner 维度，后者无 gate）
    active_connections: Vec<EndpointOnlineInfo>,
    per_owner_connections: Vec<OwnerOnlineInfo>,
    /// callback 决策缓存条目数（static 恒 0）
    cache_entries: usize,
}

#[derive(Serialize)]
struct EndpointOnlineInfo {
    endpoint_id: String,
    fabric_id: String,
    connections: usize,
}

#[derive(Serialize)]
struct OwnerOnlineInfo {
    fabric_id: String,
    connections: usize,
}

async fn status(State(state): State<AdminState>) -> Json<Status> {
    let snapshot = state.registry.snapshot();
    let (quota, active, per_owner, cache_entries) = match &state.gate {
        Some(gate) => {
            let view = gate.online_view();
            (
                gate.max_connections_per_owner(),
                // status wire 冻结为 endpoint 级聚合（r4-P1-1）：per-pair 是
                // /admin/connections 的详细视图；同 endpoint 多 fabric 在此
                // 聚合为一条——connections 求和、fabric_id 取字典序最小
                // （确定性规则，不依赖视图对内的次序之外的任何东西）。
                endpoint_level_projection(&view),
                view.per_owner
                    .into_iter()
                    .map(|(fabric_id, connections)| OwnerOnlineInfo {
                        fabric_id: hex::encode(fabric_id),
                        connections,
                    })
                    .collect(),
                gate.cache_entries(),
            )
        }
        None => (None, Vec::new(), Vec::new(), 0),
    };
    Json(Status {
        mode: match state.mode {
            AccessMode::Open => "open",
            AccessMode::Restricted => "restricted",
        },
        policy: state.policy,
        generation: snapshot.generation(),
        max_connections_per_owner: quota,
        active_connections: active,
        per_owner_connections: per_owner,
        cache_entries,
    })
}

// ---- GET /admin/connections（task 1.4：详细在线视图） ----

#[derive(Serialize)]
struct Connections {
    /// 取 AdminState.mode 配置字段（禁止 gate 句柄推导——restricted+无
    /// relay 仍为 restricted，P0-2）
    mode: &'static str,
    policy: &'static str,
    /// relay 服务装配事实（独立字段，与 mode 无推导关系）
    relay_enabled: bool,
    quota: Quota,
    /// endpoint_id 字典序（online_view 冻结排序）
    per_endpoint: Vec<EndpointOnlineInfo>,
    per_owner: Vec<OwnerOnlineInfo>,
}

#[derive(Serialize)]
struct Quota {
    configured: bool,
    /// configured=false 时 null（quota 结构恒在——与 status 的扁平字段
    /// 分工：connections 是新详细视图，status wire 冻结不动）
    max_connections_per_owner: Option<usize>,
}

/// 与 /admin/status 的分工（P2-3 冻结）：status 的 active_connections/
/// per_owner_connections 是既有冻结 wire；connections 是 SDK 面向的详细
/// 视图（fabric 绑定 + mode/relay_enabled 拆分 + quota 结构）。open 模式
/// （gate=None）→ 空投影；restricted+relay 未启用 → 在线表天然为空（无
/// relay 即无票接入），mode/relay_enabled 如实各自取值。
async fn connections(State(state): State<AdminState>) -> Json<Connections> {
    let (quota, per_endpoint, per_owner) = match &state.gate {
        Some(gate) => {
            let view = gate.online_view();
            (
                Quota {
                    configured: gate.max_connections_per_owner().is_some(),
                    max_connections_per_owner: gate.max_connections_per_owner(),
                },
                view.per_endpoint
                    .into_iter()
                    .map(|e| EndpointOnlineInfo {
                        endpoint_id: hex::encode(e.endpoint_id),
                        fabric_id: hex::encode(e.fabric_id),
                        connections: e.connections,
                    })
                    .collect(),
                view.per_owner
                    .into_iter()
                    .map(|(fabric_id, connections)| OwnerOnlineInfo {
                        fabric_id: hex::encode(fabric_id),
                        connections,
                    })
                    .collect(),
            )
        }
        None => (
            Quota {
                configured: false,
                max_connections_per_owner: None,
            },
            Vec::new(),
            Vec::new(),
        ),
    };
    Json(Connections {
        mode: match state.mode {
            AccessMode::Open => "open",
            AccessMode::Restricted => "restricted",
        },
        policy: state.policy,
        relay_enabled: state.relay_enabled,
        quota,
        per_endpoint,
        per_owner,
    })
}

// ---- POST /admin/connections/disconnect（task 1.3：主动断连） ----

/// 请求体：endpoint_id / fabric_id 恰好其一（deny_unknown_fields + 显式
/// 互斥检查——serde 拒未知字段，缺键/双键在此统一 400 invalid-request）
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DisconnectBody {
    endpoint_id: Option<String>,
    fabric_id: Option<String>,
}

/// disconnect 回执（JSON 形态与 register/unregister Receipt 同构，但
/// target 用显式 endpoint_id 字段——不复用 root 键名，design §1.2 P0-1）
#[derive(Serialize)]
struct DisconnectReceipt {
    op: &'static str,
    fabric_id: String,
    endpoint_id: String,
    ts: u64,
    generation: u64,
    /// base64url-nopad(64B)（Ed25519 over RECEIPT_DOMAIN || canonical；
    /// canonical 的 root 槽位承载被断 endpoint_id）
    receipt_sig: String,
}

#[derive(Serialize)]
struct DisconnectResponse {
    /// 已下发 start_shutdown 的条目（「已下发」非「已完成」——收敛由调用方
    /// 有界轮询确认，P1-2）
    disconnected: Vec<EndpointOnlineInfo>,
    /// per-target 回执（与 disconnected 对齐；空报告必为空数组）
    receipts: Vec<DisconnectReceipt>,
}

/// 主动断连。快照规则（r2-P1-1 冻结）：判定取**单次** online_view 快照；
/// 按 endpoint_id 请求命中快照中该 endpoint 的唯一条目（无条目 = 404
/// no-match）；按 fabric_id 请求展开该 owner 全部条目（快照本身已按
/// endpoint_id 字典序）。ts 在 handler 进入时取一次、generation 取当时
/// registry snapshot——全部回执共享（与 register/unregister 回执的
/// generation 同源：`registry.snapshot().generation()`）。open 模式 /
/// relay 未启用 → 200 空 disconnected + 空 receipts（明确语义而非报错）。
async fn disconnect(
    State(state): State<AdminState>,
    body: Result<Json<DisconnectBody>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<DisconnectResponse>, AdminError> {
    let Json(body) = body.map_err(|e| AdminError::InvalidRequest(e.body_text()))?;
    // 恰好其一约束（含缺键/双键/未知字段三类，spec 场景钉住）
    let selector = match (body.endpoint_id, body.fabric_id) {
        (Some(_), Some(_)) | (None, None) => {
            return Err(AdminError::InvalidRequest(
                "request body must specify exactly one of endpoint_id or fabric_id".into(),
            ));
        }
        (Some(endpoint_hex), None) => DisconnectSelector::Endpoint(
            parse_owner_hex(&endpoint_hex).map_err(AdminError::InvalidRequest)?,
        ),
        (None, Some(fabric_hex)) => DisconnectSelector::Fabric(
            parse_owner_hex(&fabric_hex).map_err(AdminError::InvalidRequest)?,
        ),
    };
    // 共享 ts/generation：单一动作时刻与 registry 世代（进入分发前取定）
    let ts = now_ms();
    let generation = state.registry.snapshot().generation();
    // 单次快照判定 + 共享断连原语下发（与 unregister 踢存量同一路径）
    let (Some(gate), Some(clients)) = (&state.gate, &state.relay_clients) else {
        return Ok(Json(DisconnectResponse {
            disconnected: Vec::new(),
            receipts: Vec::new(),
        }));
    };
    let snapshot = gate.online_view();
    let targets: Vec<OnlineEndpoint> = match selector {
        DisconnectSelector::Endpoint(endpoint_id) => snapshot
            .per_endpoint
            .iter()
            .filter(|e| e.endpoint_id == endpoint_id)
            .cloned()
            .collect(),
        // 快照 per_endpoint 已按 endpoint_id 字典序冻结排序，过滤保序
        DisconnectSelector::Fabric(fabric_id) => snapshot
            .per_endpoint
            .iter()
            .filter(|e| e.fabric_id == fabric_id)
            .cloned()
            .collect(),
    };
    if targets.is_empty() {
        return Err(AdminError::NoMatch(format!(
            "no online connection matches {}",
            match selector {
                DisconnectSelector::Endpoint(id) => format!("endpoint_id {}", hex::encode(id)),
                DisconnectSelector::Fabric(id) => format!("fabric_id {}", hex::encode(id)),
            }
        )));
    }
    let hits = disconnect_endpoints(clients, &targets);
    tracing::info!(
        requested = match selector {
            DisconnectSelector::Endpoint(id) => hex::encode(id),
            DisconnectSelector::Fabric(id) => hex::encode(id),
        },
        issued = hits.len(),
        generation,
        "admin API: disconnect issued (async start_shutdown)"
    );
    let receipts = hits
        .iter()
        .map(|e| DisconnectReceipt {
            op: "disconnect",
            fabric_id: hex::encode(e.fabric_id),
            endpoint_id: hex::encode(e.endpoint_id),
            ts,
            generation,
            // canonical 的 root 32B 槽位承载被断 endpoint_id（P0-1：
            // 布局复用冻结形，op=0x03 区分）
            receipt_sig: URL_SAFE_NO_PAD.encode(state.identity.sign(&receipt_canonical(
                OP_DISCONNECT,
                &e.fabric_id,
                &e.endpoint_id,
                ts,
                generation,
            ))),
        })
        .collect();
    let disconnected = hits
        .into_iter()
        .map(|e| EndpointOnlineInfo {
            endpoint_id: hex::encode(e.endpoint_id),
            fabric_id: hex::encode(e.fabric_id),
            connections: e.connections,
        })
        .collect();
    Ok(Json(DisconnectResponse {
        disconnected,
        receipts,
    }))
}

#[derive(Clone, Copy)]
enum DisconnectSelector {
    Endpoint([u8; 32]),
    Fabric([u8; 32]),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::cap::{CAP_RELAY, sign_and_encode};
    use crate::access::config::PolicyConfig;
    use crate::access::gate::{GateDecision, GateInput, Op};
    use axum::body::Body;
    use axum::http::Request;
    use ed25519_dalek::{Signer, SigningKey, Verifier};
    use tempfile::TempDir;
    use tower::ServiceExt;

    const TOKEN: &str = "admin-secret-token";

    fn test_now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    struct Fixture {
        dir: TempDir,
        identity: Arc<ServerIdentity>,
        registry: Arc<OwnerRegistry>,
        issuer: SigningKey,
        server_id: [u8; 32],
        fabric_id: [u8; 32],
    }

    impl Fixture {
        fn new() -> Self {
            let dir = TempDir::new().unwrap();
            let identity = Arc::new(ServerIdentity::load_or_create(dir.path()).unwrap());
            let registry = Arc::new(OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap());
            Self {
                dir,
                identity,
                registry,
                issuer: SigningKey::from_bytes(&[0xA1; 32]),
                server_id: [0xA2; 32],
                fabric_id: [0xA3; 32],
            }
        }

        fn state(&self, gate: Option<Arc<AccessGate>>) -> AdminState {
            self.state_with_relay(gate, None)
        }

        /// task 3.2b：可注入 iroh-relay Clients 句柄（None = relay 未启用
        /// 形态；单测用 Clients::default() 模拟空在线连接表）
        fn state_with_relay(
            &self,
            gate: Option<Arc<AccessGate>>,
            relay_clients: Option<Clients>,
        ) -> AdminState {
            self.state_as(gate, relay_clients, true, AccessMode::Restricted)
        }

        /// task 1.4 投影矩阵：mode/relay_enabled 独立注入（P0-2——
        /// restricted+无 relay 的组合只能在字段层构造）
        fn state_as(
            &self,
            gate: Option<Arc<AccessGate>>,
            relay_clients: Option<Clients>,
            relay_enabled: bool,
            mode: AccessMode,
        ) -> AdminState {
            AdminState {
                token: TOKEN.to_string(),
                identity: Arc::clone(&self.identity),
                registry: Arc::clone(&self.registry),
                gate,
                relay_clients,
                mode,
                policy: "static",
                relay_enabled,
            }
        }

        fn issuer_key(&self) -> [u8; 32] {
            self.issuer.verifying_key().to_bytes()
        }
    }

    fn bearer(value: &str) -> (&'static str, String) {
        ("authorization", format!("Bearer {value}"))
    }

    async fn body_json(res: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    // ---- 鉴权面 ----

    #[tokio::test]
    async fn auth_matrix_401_on_missing_wrong_or_malformed_bearer() {
        let f = Fixture::new();
        let app = router(f.state(None));
        let bad_headers: Vec<Vec<(&str, String)>> = vec![
            vec![],                                     // 缺头
            vec![bearer("")],                           // Bearer 空值
            vec![("authorization", TOKEN.to_string())], // 非 Bearer 形态
            vec![bearer("wrong-token")],                // 错 token
            vec![bearer(&format!("{TOKEN}x"))],         // 前缀碰撞
            vec![bearer("Basic dXNlcjpwYXNz")],         // 其它 scheme
        ];
        for headers in &bad_headers {
            let mut req = Request::get("/admin/owners");
            for (name, value) in headers {
                req = req.header(*name, value.clone());
            }
            let res = app
                .clone()
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                res.status(),
                StatusCode::UNAUTHORIZED,
                "headers {headers:?}"
            );
            let body = body_json(res).await;
            // envelope 迁移回归（sdk-mgmt-surface task 1.1）：401 统一
            // {"error":{"code","message"}} 形态
            assert_eq!(body["error"]["code"], "unauthorized");
            assert!(body["error"]["message"].is_string());
        }
        // 正确 token + 大小写不敏感 scheme → 200
        let res = app
            .oneshot(
                Request::get("/admin/owners")
                    .header("authorization", format!("bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        // admin 路由未挂载的 404 语义由 main 装配承担（未配 token 不构造
        // router），e2e e14 黑盒覆盖
    }

    // ---- owners CRUD 全链 ----

    #[tokio::test]
    async fn owners_register_list_unregister_full_chain_with_receipt() {
        let f = Fixture::new();
        let app = router(f.state(None));

        // 注册（hex 值取真实曲线点字节——root 无曲线约束，任意 32B 合法）
        let fabric = [0x0F; 32];
        let root = [0x0E; 32];
        let res = app
            .clone()
            .oneshot(
                Request::post("/admin/owners")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::from(
                        serde_json::json!({
                            "fabric_id_hex": hex::encode(fabric),
                            "root_hex": hex::encode(root),
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let receipt = body_json(res).await;
        assert_eq!(receipt["op"], "register");
        assert_eq!(receipt["fabric_id"], hex::encode(fabric));
        assert_eq!(receipt["root"], hex::encode(root));
        let ts = receipt["ts"].as_u64().unwrap();
        let generation = receipt["generation"].as_u64().unwrap();
        assert!(generation >= 1);
        // register 回执不携带 kicked 字段（serde skip——wire 形态冻结）
        assert!(receipt.get("kicked_endpoints").is_none());
        assert!(receipt.get("kicked_connections").is_none());

        // 回执可验证：services.json 同源 ServerId 对 canonical 验签
        let sig_b64 = receipt["receipt_sig"].as_str().unwrap();
        let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD.decode(sig_b64).unwrap().try_into().unwrap();
        let verifying =
            ed25519_dalek::VerifyingKey::from_bytes(f.identity.server_id().as_bytes()).unwrap();
        verifying
            .verify(
                &receipt_canonical(OP_REGISTER, &fabric, &root, ts, generation),
                &ed25519_dalek::Signature::from_bytes(&sig_bytes),
            )
            .expect("receipt_sig 必须可用 ServerId 验签");

        // 列表：含新 owner（registered_at = jsonl ts 语义同源）
        let res = app
            .clone()
            .oneshot(
                Request::get("/admin/owners")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let list = body_json(res).await;
        assert_eq!(list["generation"].as_u64().unwrap(), generation);
        assert_eq!(list["owners"].as_array().unwrap().len(), 1);
        assert_eq!(list["owners"][0]["fabric_id"], hex::encode(fabric));
        assert!(list["owners"][0]["registered_at"].as_u64().unwrap() > 0);

        // 三入口一致性：jsonl 是 source of truth——CLI/文件路径 load 同一
        // 活跃集合；API 注册即写盘
        let path = f.dir.path().join("owners.jsonl");
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains(&hex::encode(fabric)), "{content}");
        let reloaded = OwnerRegistry::load(&path).unwrap();
        assert!(reloaded.snapshot().contains(&fabric, &root));

        // 注销 → 列表空 + 回执同构可验 + kicked 字段恒在（open/无 relay
        // 形态零踢除——字段存在性即 task 3.2b wire 形态断言）
        let res = app
            .clone()
            .oneshot(
                Request::delete(format!(
                    "/admin/owners/{}/{}",
                    hex::encode(fabric),
                    hex::encode(root)
                ))
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let receipt = body_json(res).await;
        assert_eq!(receipt["op"], "unregister");
        assert_eq!(receipt["kicked_endpoints"], 0);
        assert_eq!(receipt["kicked_connections"], 0);
        let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
            .decode(receipt["receipt_sig"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        verifying
            .verify(
                &receipt_canonical(
                    OP_UNREGISTER,
                    &fabric,
                    &root,
                    receipt["ts"].as_u64().unwrap(),
                    receipt["generation"].as_u64().unwrap(),
                ),
                &ed25519_dalek::Signature::from_bytes(&sig_bytes),
            )
            .unwrap();
        assert!(
            OwnerRegistry::load(&path).unwrap().snapshot().is_empty(),
            "注销后磁盘归并结果为空"
        );

        // 非法 hex → 400（POST body 与 DELETE path 双面）
        let res = app
            .clone()
            .oneshot(
                Request::post("/admin/owners")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::from(
                        serde_json::json!({"fabric_id_hex": "zz", "root_hex": "aa".repeat(32)})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        let res = app
            .oneshot(
                Request::delete(format!("/admin/owners/{}/{}", "zz", "aa".repeat(32)))
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    // ---- status（与 gate 在线表/配额联动）----

    #[tokio::test]
    async fn status_projects_gate_online_table_and_quota() {
        let f = Fixture::new();
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
        let gate = Arc::new(
            AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Static)
                .unwrap()
                .with_max_connections_per_owner(Some(2)),
        );
        let app = router(f.state(Some(Arc::clone(&gate))));

        // 占一个名额（同 gate decide 全链：Allow 即预约）
        let recipient = [0xB1; 32];
        let now = test_now_ms();
        let token = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &f.server_id,
            &recipient,
            CAP_RELAY,
            now,
            now + 3_600_000,
        );
        let input = GateInput {
            endpoint_id: recipient,
            auth_header: Some(format!("Bearer {token}")),
            query_token: None,
            connection_id: 7,
            op: Op::RelayConnect,
        };
        assert_eq!(gate.decide(&input).await, GateDecision::Allow);

        let res = app
            .clone()
            .oneshot(
                Request::get("/admin/status")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["mode"], "restricted");
        assert_eq!(body["policy"], "static");
        assert_eq!(body["max_connections_per_owner"], 2);
        assert_eq!(body["cache_entries"], 0);
        assert_eq!(body["active_connections"].as_array().unwrap().len(), 1);
        assert_eq!(
            body["active_connections"][0]["endpoint_id"],
            hex::encode(recipient)
        );
        assert_eq!(
            body["active_connections"][0]["fabric_id"],
            hex::encode(f.fabric_id)
        );
        assert_eq!(body["active_connections"][0]["connections"], 1);
        assert_eq!(
            body["per_owner_connections"][0]["fabric_id"],
            hex::encode(f.fabric_id)
        );
        assert_eq!(body["per_owner_connections"][0]["connections"], 1);

        // 断连 → 在线表归零（status 是实时投影）
        gate.on_disconnect(recipient, 7);
        let res = app
            .oneshot(
                Request::get("/admin/status")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = body_json(res).await;
        assert_eq!(body["active_connections"].as_array().unwrap().len(), 0);
        assert_eq!(body["per_owner_connections"].as_array().unwrap().len(), 0);
    }

    // ---- task 3.2b：unregister 踢存量（反查映射 + kicked 计数）----

    /// 在线表登记一条票接入（同 gate decide 全链：L1/L1b/配额预约）。
    /// recipient 必须是真实曲线点（kick 侧 EndpointId::from_bytes 会校验）
    async fn occupy(gate: &AccessGate, f: &Fixture, seed: u8, connection_id: u64) -> [u8; 32] {
        let recipient = *iroh_base::SecretKey::from_bytes(&[seed; 32])
            .public()
            .as_bytes();
        let now = test_now_ms();
        let token = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &f.server_id,
            &recipient,
            CAP_RELAY,
            now,
            now + 3_600_000,
        );
        let input = GateInput {
            endpoint_id: recipient,
            auth_header: Some(format!("Bearer {token}")),
            query_token: None,
            connection_id,
            op: Op::RelayConnect,
        };
        assert_eq!(
            gate.decide(&input).await,
            GateDecision::Allow,
            "occupy 前置失败"
        );
        recipient
    }

    /// 反查映射（endpoints_of_fabric）：fabric 维度精确圈定 + 同 endpoint
    /// 多连接聚合——这是踢存量与 kicked 计数的公共映射层
    #[tokio::test]
    async fn kick_reverse_lookup_maps_fabric_to_endpoints() {
        let f = Fixture::new();
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
        // 第二 fabric 的 owner（映射隔离对照）
        let issuer2 = ed25519_dalek::SigningKey::from_bytes(&[0x71; 32]);
        let fabric2 = [0x72; 32];
        f.registry
            .register(&fabric2, &issuer2.verifying_key().to_bytes())
            .unwrap();
        let gate = AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Static).unwrap();

        let ep1 = occupy(&gate, &f, 0xB1, 1).await;
        occupy(&gate, &f, 0xB1, 2).await; // 同 endpoint 第二条连接
        let ep2 = occupy(&gate, &f, 0xB2, 3).await;
        // fabric2 的一条连接（不应出现在 fabric1 的反查结果里）
        let now = test_now_ms();
        let token2 = sign_and_encode(
            &issuer2,
            &fabric2,
            &f.server_id,
            &[0xB3; 32],
            CAP_RELAY,
            now,
            now + 3_600_000,
        );
        let input2 = GateInput {
            endpoint_id: [0xB3; 32],
            auth_header: Some(format!("Bearer {token2}")),
            query_token: None,
            connection_id: 4,
            op: Op::RelayConnect,
        };
        assert_eq!(gate.decide(&input2).await, GateDecision::Allow);

        let mut hits = endpoints_of_fabric(&gate.online_view(), &f.fabric_id);
        hits.sort_by_key(|e| e.endpoint_id);
        assert_eq!(
            hits,
            vec![
                OnlineEndpoint {
                    endpoint_id: ep1,
                    fabric_id: f.fabric_id,
                    connections: 2,
                },
                OnlineEndpoint {
                    endpoint_id: ep2,
                    fabric_id: f.fabric_id,
                    connections: 1,
                },
            ],
            "fabric 反查：两个 endpoint（连接数聚合），fabric2 不混入"
        );
        // 未知 fabric → 空集
        assert!(endpoints_of_fabric(&gate.online_view(), &[0x99; 32]).is_empty());
    }

    /// kicked 计数语义：Clients 表 miss（空句柄——单测无法构造真连接，
    /// 用 Clients::default() 的空注册表模拟）时 disconnect 返回 false →
    /// kicked 0/0（诚实计数，不把「已定位」谎报为「已踢」）；在线表不受
    /// 假踢影响。gate/clients 任一缺失（open 模式 / relay 未启用）同样
    /// 零副作用零 panic。真实命中路径由 e2e e16 黑盒钉死。
    #[tokio::test]
    async fn kick_counts_stay_honest_when_disconnect_misses() {
        let f = Fixture::new();
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
        let gate = Arc::new(
            AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Static).unwrap(),
        );
        occupy(&gate, &f, 0xC1, 1).await;
        occupy(&gate, &f, 0xC2, 2).await;
        let view_before = gate.online_view();

        // 空在线连接表（relay 侧无此 endpoint）→ kicked 0/0，在线表不变
        let app = router(f.state_with_relay(Some(Arc::clone(&gate)), Some(Clients::default())));
        let res = app
            .oneshot(
                Request::delete(format!(
                    "/admin/owners/{}/{}",
                    hex::encode(f.fabric_id),
                    hex::encode(f.issuer_key())
                ))
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let receipt = body_json(res).await;
        assert_eq!(receipt["op"], "unregister");
        assert_eq!(receipt["kicked_endpoints"], 0, "disconnect miss 不计数");
        assert_eq!(receipt["kicked_connections"], 0);
        assert_eq!(
            gate.online_view().per_endpoint.len(),
            view_before.per_endpoint.len(),
            "假踢不动在线表（释放只来自真 relay 断连）"
        );

        // re-register 后：clients None（relay 未启用形态）→ 同样 0/0 零副作用
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
        let app = router(f.state_with_relay(Some(Arc::clone(&gate)), None));
        let res = app
            .oneshot(
                Request::delete(format!(
                    "/admin/owners/{}/{}",
                    hex::encode(f.fabric_id),
                    hex::encode(f.issuer_key())
                ))
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let receipt = body_json(res).await;
        assert_eq!(receipt["kicked_endpoints"], 0);
        assert_eq!(receipt["kicked_connections"], 0);

        // 对照：gate None（open 模式形态）不 panic、响应同构
        let app = router(f.state_with_relay(None, Some(Clients::default())));
        let res = app
            .oneshot(
                Request::delete(format!(
                    "/admin/owners/{}/{}",
                    hex::encode(f.fabric_id),
                    hex::encode(f.issuer_key())
                ))
                .header("authorization", format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let receipt = body_json(res).await;
        assert_eq!(receipt["kicked_endpoints"], 0);
        assert_eq!(receipt["kicked_connections"], 0);
    }

    // ---- sdk-mgmt-surface task 1.6：connections 投影 + disconnect 面单测 ----

    /// spec 场景「在线视图投影与配额」：restricted + relay 启用，两个
    /// owner 各一条在线连接——per_endpoint 字典序 / per_owner / quota 结构 /
    /// mode 与 relay_enabled 独立如实
    #[tokio::test]
    async fn connections_projects_online_view_quota_and_mode_split() {
        let f = Fixture::new();
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
        let issuer2 = ed25519_dalek::SigningKey::from_bytes(&[0x71; 32]);
        let fabric2 = [0x72; 32];
        f.registry
            .register(&fabric2, &issuer2.verifying_key().to_bytes())
            .unwrap();
        let gate = Arc::new(
            AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Static)
                .unwrap()
                .with_max_connections_per_owner(Some(2)),
        );
        let ep1 = occupy(&gate, &f, 0xB1, 1).await;
        // fabric2 的一条连接（独立 owner 投影对照）
        let recipient2 = *iroh_base::SecretKey::from_bytes(&[0xB2; 32])
            .public()
            .as_bytes();
        let now = test_now_ms();
        let token2 = sign_and_encode(
            &issuer2,
            &fabric2,
            &f.server_id,
            &recipient2,
            CAP_RELAY,
            now,
            now + 3_600_000,
        );
        assert_eq!(
            gate.decide(&GateInput {
                endpoint_id: recipient2,
                auth_header: Some(format!("Bearer {token2}")),
                query_token: None,
                connection_id: 2,
                op: Op::RelayConnect,
            })
            .await,
            GateDecision::Allow
        );

        let app = router(f.state_as(Some(gate), None, true, AccessMode::Restricted));
        let res = app
            .oneshot(
                Request::get("/admin/connections")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["mode"], "restricted");
        assert_eq!(body["policy"], "static");
        assert_eq!(body["relay_enabled"], true);
        assert_eq!(body["quota"]["configured"], true);
        assert_eq!(body["quota"]["max_connections_per_owner"], 2);
        // 字典序冻结：返回数组与排序后的 hex 清单逐一相等
        let mut expected = [ep1, recipient2];
        expected.sort();
        let got: Vec<&str> = body["per_endpoint"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["endpoint_id"].as_str().unwrap())
            .collect();
        assert_eq!(
            got,
            expected.iter().map(hex::encode).collect::<Vec<_>>(),
            "per_endpoint 必须按 endpoint_id 字典序"
        );
        assert_eq!(body["per_endpoint"][0]["connections"], 1);
        assert_eq!(
            body["per_endpoint"][0]["fabric_id"],
            hex::encode(f.fabric_id)
        );
        assert_eq!(body["per_endpoint"][1]["fabric_id"], hex::encode(fabric2));
        let owners: Vec<&str> = body["per_owner"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["fabric_id"].as_str().unwrap())
            .collect();
        let mut fabrics = [f.fabric_id, fabric2];
        fabrics.sort();
        assert_eq!(owners, fabrics.iter().map(hex::encode).collect::<Vec<_>>());
        assert_eq!(body["per_owner"][0]["connections"], 1);
    }

    /// spec 场景「restricted + relay 未启用的正确投影」（P0-2）：不得把
    /// restricted+无 relay 误报为 open——mode/relay_enabled 各自如实，投影
    /// 为空（relay 未装配即无票接入，在线表天然为空）。
    /// 同场覆盖 open 模式：如实标注 mode、空投影、quota 无上限。
    #[tokio::test]
    async fn connections_projection_restricted_without_relay_and_open_mode() {
        let f = Fixture::new();
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();

        // restricted + relay 未启用（gate 恒建——restricted 装配事实）
        let gate = AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Static)
            .unwrap()
            .with_max_connections_per_owner(Some(2));
        let app = router(f.state_as(Some(Arc::new(gate)), None, false, AccessMode::Restricted));
        let res = app
            .oneshot(
                Request::get("/admin/connections")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["mode"], "restricted", "不得投影为 open");
        assert_eq!(body["relay_enabled"], false);
        assert_eq!(body["per_endpoint"].as_array().unwrap().len(), 0);
        assert_eq!(body["per_owner"].as_array().unwrap().len(), 0);
        // quota 是 gate 装配事实（配置了上限即如实透出，与 relay 无关）
        assert_eq!(body["quota"]["configured"], true);
        assert_eq!(body["quota"]["max_connections_per_owner"], 2);

        // open 模式（无 gate）：mode 如实 + 空投影 + 无配额概念
        let app = router(f.state_as(None, None, true, AccessMode::Open));
        let res = app
            .oneshot(
                Request::get("/admin/connections")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = body_json(res).await;
        assert_eq!(body["mode"], "open");
        assert_eq!(body["relay_enabled"], true);
        assert_eq!(body["per_endpoint"].as_array().unwrap().len(), 0);
        assert_eq!(body["per_owner"].as_array().unwrap().len(), 0);
        assert_eq!(body["quota"]["configured"], false);
        assert!(body["quota"]["max_connections_per_owner"].is_null());
    }

    /// spec 场景「请求体同时缺失或同时给出两个键」：缺键/双键/未知字段/
    /// 坏 hex/坏 JSON → 400 + invalid-request envelope（信息指明恰好其一）
    #[tokio::test]
    async fn disconnect_request_body_matrix_rejected_with_envelope() {
        let f = Fixture::new();
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
        let gate = Arc::new(
            AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Static).unwrap(),
        );
        let app = router(f.state_with_relay(Some(gate), Some(Clients::default())));
        let good_hex = hex::encode([0xB1; 32]);
        let cases: Vec<(&str, String, bool)> = vec![
            // (标签, body, 恰好其一约束违例？——错误信息须指明)
            ("缺两键", serde_json::json!({}).to_string(), true),
            (
                "双键",
                serde_json::json!({"endpoint_id": good_hex, "fabric_id": good_hex}).to_string(),
                true,
            ),
            (
                "未知字段",
                serde_json::json!({"endpoint_id": good_hex, "extra": 1}).to_string(),
                false,
            ),
            (
                "坏 hex",
                serde_json::json!({"endpoint_id": "zz"}).to_string(),
                false,
            ),
            ("坏 JSON", "{\"nope".to_string(), false),
        ];
        for (label, body, exactly_one) in cases {
            let res = app
                .clone()
                .oneshot(
                    Request::post("/admin/connections/disconnect")
                        .header("content-type", "application/json")
                        .header("authorization", format!("Bearer {TOKEN}"))
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST, "用例 {label}");
            let json = body_json(res).await;
            assert_eq!(json["error"]["code"], "invalid-request", "用例 {label}");
            assert!(json["error"]["message"].is_string(), "用例 {label}");
            if exactly_one {
                assert!(
                    json["error"]["message"]
                        .as_str()
                        .unwrap()
                        .contains("exactly one"),
                    "用例 {label} 错误信息须指明必须恰好其一: {json}"
                );
            }
        }
    }

    /// spec 场景「断连目标未命中」：快照无条目 → 404 no-match envelope，
    /// 不产生断开动作与回执（endpoint 与 fabric 两查询键）
    #[tokio::test]
    async fn disconnect_no_match_returns_404_envelope() {
        let f = Fixture::new();
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
        let gate = Arc::new(
            AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Static).unwrap(),
        );
        occupy(&gate, &f, 0xB1, 1).await; // 在线的是别的 endpoint
        let app = router(f.state_with_relay(Some(Arc::clone(&gate)), Some(Clients::default())));

        for key in ["endpoint_id", "fabric_id"] {
            let res = app
                .clone()
                .oneshot(
                    Request::post("/admin/connections/disconnect")
                        .header("content-type", "application/json")
                        .header("authorization", format!("Bearer {TOKEN}"))
                        .body(Body::from(
                            serde_json::json!({ key: hex::encode([0x99; 32]) }).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "查询键 {key}");
            let json = body_json(res).await;
            assert_eq!(json["error"]["code"], "no-match", "查询键 {key}");
            assert!(json["error"]["message"].is_string());
        }
        // 未命中不产生断开动作：在线表不受影响
        assert_eq!(gate.online_view().per_endpoint.len(), 1);
    }

    /// spec 场景「空报告的 receipts 语义」两路：relay 未启用 → 200 空
    /// disconnected+空 receipts；快照命中但连接表 miss（单测空句柄模拟
    /// 「已定位未下发」竞态）→ 同样空报告——诚实计数，不虚构回执
    #[tokio::test]
    async fn disconnect_empty_reports_stay_empty() {
        let f = Fixture::new();
        f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
        let gate = Arc::new(
            AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Static).unwrap(),
        );
        let ep = occupy(&gate, &f, 0xB1, 1).await;

        // relay 未启用（clients None）→ 200 空报告（明确语义而非报错）
        let app = router(f.state_with_relay(Some(Arc::clone(&gate)), None));
        let res = app
            .clone()
            .oneshot(
                Request::post("/admin/connections/disconnect")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::from(
                        serde_json::json!({"endpoint_id": hex::encode(ep)}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let json = body_json(res).await;
        assert_eq!(json["disconnected"].as_array().unwrap().len(), 0);
        assert_eq!(json["receipts"].as_array().unwrap().len(), 0);

        // 连接表 miss（Clients::default() 空 registry）：快照命中但 disconnect
        // 返回 false → 已下发清单为空 → 无回执（真实命中路径由 e2e 钉死）
        let app = router(f.state_with_relay(Some(Arc::clone(&gate)), Some(Clients::default())));
        let res = app
            .oneshot(
                Request::post("/admin/connections/disconnect")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {TOKEN}"))
                    .body(Body::from(
                        serde_json::json!({"fabric_id": hex::encode(f.fabric_id)}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let json = body_json(res).await;
        assert_eq!(json["disconnected"].as_array().unwrap().len(), 0);
        assert_eq!(json["receipts"].as_array().unwrap().len(), 0);
    }

    // ---- sdk-mgmt-surface task 1.5：回执 canonical 冻结向量 ----

    /// CROSS_CRATE_RECEIPT_VECTOR（r2-P2-2 可复现规则）：固定 key/ts/
    /// generation/输入在测试内生成 fixtures/receipt-vector.json——存在即
    /// 对拍（实现漂移即红）、不存在则写出入库（首次+CI 缺档自愈）；TS 侧
    /// （client-sdk ./admin）只读该文件对拍 receiptCanonical。绝不使用本地
    /// 时钟——任何环境重跑同结果。
    #[test]
    fn disconnect_endpoints_mixed_pairs_keeps_all_pairs_per_dispatched_endpoint() {
        // r4-P0-1 回归：同 endpoint 两 fabric 的 pair——物理断连（None 语义
        // = 一次成功覆盖全 endpoint）只 dispatch 一次，两张 pair 都必须保留
        //（回执映射按 pair 生成，丢 pair = 丢审计条目）。
        let endpoint = *iroh_base::SecretKey::from_bytes(&[0x53; 32])
            .public()
            .as_bytes();
        let entries = vec![
            OnlineEndpoint {
                endpoint_id: endpoint,
                fabric_id: [0x11; 32],
                connections: 1,
            },
            OnlineEndpoint {
                endpoint_id: endpoint,
                fabric_id: [0x22; 32],
                connections: 2,
            },
        ];
        let calls = std::cell::Cell::new(0);
        let hits = disconnect_endpoints_with(&entries, |_| {
            calls.set(calls.get() + 1);
            true // 首调即成功（None 语义下第二次调用本会 false——不应发生）
        });
        assert_eq!(calls.get(), 1, "同 endpoint 物理动作只做一次");
        assert_eq!(hits.len(), 2, "两张 pair 全保留");
        assert_eq!(hits[0].fabric_id, [0x11; 32]);
        assert_eq!(hits[1].fabric_id, [0x22; 32]);
        // dispatch false（连接表已无该 endpoint）→ 整 endpoint 诚实不计入
        let hits = disconnect_endpoints_with(&entries, |_| false);
        assert!(hits.is_empty());
    }

    #[test]
    fn status_projection_aggregates_pairs_to_endpoint_level() {
        // r4-P1-1：status 的 active_connections 是 endpoint 级聚合 wire——
        // 同 endpoint 多 fabric 聚合为一条（connections 求和、fabric 取
        // 字典序最小），与 connections 的 per-pair 详细视图分工。
        let endpoint = [0x33; 32];
        let view = OnlineView {
            per_endpoint: vec![
                OnlineEndpoint {
                    endpoint_id: endpoint,
                    fabric_id: [0x22; 32],
                    connections: 2,
                },
                OnlineEndpoint {
                    endpoint_id: endpoint,
                    fabric_id: [0x11; 32],
                    connections: 1,
                },
                OnlineEndpoint {
                    endpoint_id: [0x44; 32],
                    fabric_id: [0x99; 32],
                    connections: 5,
                },
            ],
            per_owner: vec![],
        };
        let proj = endpoint_level_projection(&view);
        assert_eq!(proj.len(), 2, "同 endpoint 聚合一条");
        assert_eq!(proj[0].endpoint_id, hex::encode(endpoint));
        assert_eq!(
            proj[0].fabric_id,
            hex::encode([0x11; 32]),
            "字典序最小 fabric"
        );
        assert_eq!(proj[0].connections, 3, "connections 求和");
        assert_eq!(proj[1].endpoint_id, hex::encode([0x44; 32]));
        assert_eq!(proj[1].connections, 5);
    }

    #[test]
    fn receipt_vector_fixture_is_frozen() {
        // 固定输入（Ed25519 seed 与真实 server.key 同为 32B 裸 seed）
        let key = SigningKey::from_bytes(&[0x5D; 32]);
        let fabric = [0x51; 32];
        let root = [0x52; 32];
        let fabric_b = [0x55; 32];
        let endpoint = *iroh_base::SecretKey::from_bytes(&[0x53; 32])
            .public()
            .as_bytes();
        // 按 fabric 断连的两 endpoint：真实曲线点，按 endpoint_id 字典序冻结
        let mut endpoints_b = vec![
            *iroh_base::SecretKey::from_bytes(&[0x31; 32])
                .public()
                .as_bytes(),
            *iroh_base::SecretKey::from_bytes(&[0x32; 32])
                .public()
                .as_bytes(),
        ];
        endpoints_b.sort();

        /// 单样例：per-target canonical + JSON wire（receipts 与实现结构体
        /// 同源序列化——wire 形态随实现演化时对拍立即红；op label 由 op_code
        /// 派生，防调用处两处标签漂移）
        fn sample(
            kind: &str,
            op_code: u8,
            fabric: &[u8; 32],
            targets: &[[u8; 32]],
            ts: u64,
            generation: u64,
            key: &SigningKey,
        ) -> serde_json::Value {
            let op_label = match op_code {
                OP_REGISTER => "register",
                OP_UNREGISTER => "unregister",
                _ => "disconnect",
            };
            let mut canonical_hex = Vec::new();
            let mut receipts = Vec::new();
            for target in targets {
                let canonical = receipt_canonical(op_code, fabric, target, ts, generation);
                let sig = URL_SAFE_NO_PAD.encode(key.sign(&canonical).to_bytes());
                canonical_hex.push(hex::encode(&canonical));
                receipts.push(
                    match op_code {
                        OP_DISCONNECT => serde_json::to_value(DisconnectReceipt {
                            op: op_label,
                            fabric_id: hex::encode(fabric),
                            endpoint_id: hex::encode(target),
                            ts,
                            generation,
                            receipt_sig: sig,
                        }),
                        _ => serde_json::to_value(Receipt {
                            op: op_label,
                            fabric_id: hex::encode(fabric),
                            root: hex::encode(target),
                            ts,
                            generation,
                            receipt_sig: sig,
                            kicked_endpoints: None,
                            kicked_connections: None,
                        }),
                    }
                    .unwrap(),
                );
            }
            serde_json::json!({
                "kind": kind,
                "op_code": op_code,
                "fabric_id": hex::encode(fabric),
                // register/unregister 的 target 序列化为 root；disconnect 为 endpoint_id
                "target_field": if op_code == OP_DISCONNECT { "endpoint_id" } else { "root" },
                "targets": targets.iter().map(hex::encode).collect::<Vec<_>>(),
                "ts": ts,
                "generation": generation,
                "canonical_hex": canonical_hex,
                "receipts": receipts,
            })
        }

        let vector = serde_json::json!({
            "note": "CROSS_CRATE_RECEIPT_VECTOR: dweb admin receipt frozen vector — fixed key/ts/generation, generated and asserted by crates/dweb-server unit test (sdk-mgmt-surface task 1.5); TS (client-sdk ./admin) recomputes canonical from fields and verifies receipt_sig against server_id",
            "domain_hex": hex::encode(RECEIPT_DOMAIN),
            "ops": { "register": OP_REGISTER, "unregister": OP_UNREGISTER, "disconnect": OP_DISCONNECT },
            "server_id": hex::encode(key.verifying_key().to_bytes()),
            "samples": [
                sample("register", OP_REGISTER, &fabric, &[root], 1_789_012_345_678, 4, &key),
                sample("unregister", OP_UNREGISTER, &fabric, &[root], 1_789_012_400_000, 5, &key),
                sample("disconnect-endpoint", OP_DISCONNECT, &fabric, &[endpoint], 1_789_012_500_000, 6, &key),
                sample("disconnect-fabric", OP_DISCONNECT, &fabric_b, &endpoints_b, 1_789_012_600_000, 7, &key),
            ],
        });

        // 独立于文件的布局断言（op3 canonical：domain || 0x03 || fabric ||
        // endpoint(root 槽位) || ts u64BE || generation u64BE）
        let op3 = receipt_canonical(
            OP_DISCONNECT,
            &fabric_b,
            &endpoints_b[0],
            1_789_012_600_000,
            7,
        );
        let mut expected = RECEIPT_DOMAIN.to_vec();
        expected.push(OP_DISCONNECT);
        expected.extend_from_slice(&fabric_b);
        expected.extend_from_slice(&endpoints_b[0]);
        expected.extend_from_slice(&1_789_012_600_000u64.to_be_bytes());
        expected.extend_from_slice(&7u64.to_be_bytes());
        assert_eq!(op3, expected);
        // 验签（固定 key 的公钥侧——server_id 同源语义）
        let verifying =
            ed25519_dalek::VerifyingKey::from_bytes(&key.verifying_key().to_bytes()).unwrap();
        verifying
            .verify(
                &op3,
                &ed25519_dalek::Signature::from_bytes(
                    &URL_SAFE_NO_PAD
                        .decode(
                            vector["samples"][3]["receipts"][0]["receipt_sig"]
                                .as_str()
                                .unwrap(),
                        )
                        .unwrap()
                        .try_into()
                        .unwrap(),
                ),
            )
            .expect("冻结向量的 receipt_sig 必须可验签");

        // fixture 随仓库入库（r3-P1-4）：缺失即失败——测试不得在 CI 中写回
        // 源码树；显式重生成 = DWEB_REGEN_FIXTURES=1 跑本测试写出后复核入库。
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/receipt-vector.json");
        let read = std::fs::read_to_string(&path);
        let on_disk: serde_json::Value = match read {
            Ok(text) => serde_json::from_str(&text).unwrap(),
            Err(_) if std::env::var("DWEB_REGEN_FIXTURES").as_deref() == Ok("1") => {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, serde_json::to_vec_pretty(&vector).unwrap()).unwrap();
                eprintln!("regenerated {}", path.display());
                return;
            }
            Err(e) => panic!(
                "receipt-vector.json 缺失或不可读（{e}）——冻结向量必须随仓库入库；\
                 显式重生成：DWEB_REGEN_FIXTURES=1 cargo test -p dweb-server \
                 receipt_vector，复核后 git add"
            ),
        };
        assert_eq!(
            on_disk, vector,
            "receipt-vector.json 与当前实现漂移——回执 canonical/wire 是冻结契约，\
             需以实现复核后重新入库（并同步 TS 对拍）"
        );
    }
}
