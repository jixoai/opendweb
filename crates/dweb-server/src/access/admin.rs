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
//! - `DELETE /admin/owners/{fabric_id}/{root}` → 注销（同上，回执同构）
//! - `GET /admin/status` → `{mode, policy, generation,
//!   max_connections_per_owner, active_connections（per endpoint 票接入
//!   在线表，task 3.2）, per_owner_connections, cache_entries}`
//!
//! 热加载路径保留：owners.jsonl 仍是 source of truth——API 只经 registry
//! 写入，mtime 看护随后的一次 reload 只会再 +1 generation（缓存键随
//! generation 变化，正确性无损；admin 信任域内的冗余事件被日志吸收）。

use crate::access::config::AccessMode;
use crate::access::gate::AccessGate;
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
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// 回执签名域分隔前缀（18B + 1B op，不进任何 wire 帧；与 relay-cap 域
/// b"dweb/relay-cap/v1\0" 不同源，跨域重放无意义）
const RECEIPT_DOMAIN: &[u8] = b"dweb/admin-receipt/v1\0";
const OP_REGISTER: u8 = 0x01;
const OP_UNREGISTER: u8 = 0x02;

/// admin API 共享状态（main 在 DWEB_ADMIN_TOKEN 存在时构造并挂载）。
/// `gate` = relay gate（restricted 模式；open 模式 None——无验证链即无
/// 在线统计，status 如实投影为空集合）。
#[derive(Clone)]
pub struct AdminState {
    token: String,
    identity: Arc<ServerIdentity>,
    registry: Arc<OwnerRegistry>,
    gate: Option<Arc<AccessGate>>,
    mode: AccessMode,
    policy: &'static str,
}

impl AdminState {
    /// 构造（`policy` 取 "static"|"callback"，与启动日志同源标签）
    pub fn new(
        token: String,
        identity: Arc<ServerIdentity>,
        registry: Arc<OwnerRegistry>,
        gate: Option<Arc<AccessGate>>,
        mode: AccessMode,
        policy: &'static str,
    ) -> Self {
        Self {
            token,
            identity,
            registry,
            gate,
            mode,
            policy,
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
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_guard,
        ))
        .with_state(state)
}

/// Bearer 鉴权中间件：scheme 大小写不敏感（HTTP 语义，与 relay 面
/// strip_bearer 同构）；token 比较为常量时间（长度先行情报可接受——
/// 剩余字节不泄露）。任何缺失/不符 → 401 JSON。
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
        return error_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    next.run(req).await
}

/// 常量时间字符串相等（admin token 比较面；早退长度差只泄露长度）
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn error_response(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({ "error": message });
    (status, Json(body)).into_response()
}

/// handler 层错误 → HTTP 映射（错误体 JSON {"error": ...}，同 rendezvous
/// ACL 形态）
enum AdminError {
    /// hex 形态非法（400）
    InvalidHex(String),
    /// registry 写入/IO 失败（500）
    Registry(String),
}

impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        match self {
            Self::InvalidHex(msg) => error_response(StatusCode::BAD_REQUEST, &msg),
            Self::Registry(msg) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &msg),
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
/// ServerId 独立验证 receipt_sig，无需其它带外信息）
#[derive(Serialize)]
struct Receipt {
    op: &'static str,
    fabric_id: String,
    root: String,
    ts: u64,
    generation: u64,
    /// base64url-nopad(64B)（Ed25519 over RECEIPT_DOMAIN || canonical）
    receipt_sig: String,
}

async fn register_owner(
    State(state): State<AdminState>,
    Json(body): Json<RegisterOwnerBody>,
) -> Result<Json<Receipt>, AdminError> {
    let fabric_id =
        parse_owner_hex(&body.fabric_id_hex).map_err(|e| AdminError::InvalidHex(e.to_string()))?;
    let root =
        parse_owner_hex(&body.root_hex).map_err(|e| AdminError::InvalidHex(e.to_string()))?;
    apply_mutation(&state, OP_REGISTER, "register", fabric_id, root).map(Json)
}

async fn unregister_owner(
    State(state): State<AdminState>,
    Path((fabric_id_hex, root_hex)): Path<(String, String)>,
) -> Result<Json<Receipt>, AdminError> {
    let fabric_id =
        parse_owner_hex(&fabric_id_hex).map_err(|e| AdminError::InvalidHex(e.to_string()))?;
    let root = parse_owner_hex(&root_hex).map_err(|e| AdminError::InvalidHex(e.to_string()))?;
    apply_mutation(&state, OP_UNREGISTER, "unregister", fabric_id, root).map(Json)
}

/// 注册/注销共通：registry 变更 → callback 缓存失效 → 回执签名。
/// registry 写入（jsonl append + fsync + 快照替换 + generation+1）全部由
/// OwnerRegistry::mutate 承担——CLI / 文件重载 / admin API 三入口收敛。
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
    let generation = state.registry.snapshot().generation();
    let ts = now_ms();
    let sig = state.identity.sign(&receipt_canonical(
        op_code, &fabric_id, &root, ts, generation,
    ));
    tracing::info!(
        op = op_label,
        generation,
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
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::cap::{CAP_RELAY, sign_and_encode};
    use crate::access::config::PolicyConfig;
    use crate::access::gate::{GateDecision, GateInput, Op};
    use axum::body::Body;
    use axum::http::Request;
    use ed25519_dalek::{SigningKey, Verifier};
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
            AdminState {
                token: TOKEN.to_string(),
                identity: Arc::clone(&self.identity),
                registry: Arc::clone(&self.registry),
                gate,
                mode: AccessMode::Restricted,
                policy: "static",
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
            assert_eq!(body["error"], "unauthorized");
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

        // 注销 → 列表空 + 回执同构可验
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
}
