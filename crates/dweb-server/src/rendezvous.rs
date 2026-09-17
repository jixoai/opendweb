//! rendezvous 登记/解析：节点用 EndpointId 私钥签名登记可达地址（带 TTL），
//! 其它节点按 EndpointId 查询仍在有效期内的登记项。
//! 规格：openspec/changes/fabric-mvp/specs/server/spec.md
//!
//! 访问控制（task 1.6，design §8.4 / spec「rendezvous 访问控制」）：
//! HTTP 面没有 iroh 握手身份（E1 不可用），按操作的信息敏感度分级——
//! - announce：现有签名验证保留（签名私钥即 PoP），叠加 capability 校验，
//!   且 capability.recipient MUST == announce 载荷中签名的 EndpointId
//!   （C7 绑定；窃取 token 者无对应私钥无法以他人身份登记）
//! - resolve：bearer-only 明示降级（无 HTTP 面身份证明，仅验密码学有效性）
//! - rendezvous 不接 callback webhook（design §8.5 R3 P0-B2 冻结：
//!   动态策略另立 change）——main 侧恒以 Static 策略构造 gate 装入本路由
//! - open 模式（gate = None）：announce/resolve 与现状逐字节一致
//!   （签名 announce / 匿名 resolve）

use crate::access::gate::{AccessGate, GateDecision, GateInput, Op};
use axum::{
    Json, Router,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    routing::{get, post},
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::Verifier;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

/// 签名时间戳允许窗口（毫秒），防重放
const TIMESTAMP_WINDOW_MS: u64 = 120_000;
/// TTL 上限（秒）
const MAX_TTL_SECS: u64 = 3600;

#[derive(Debug, Error)]
pub enum RendezvousError {
    #[error("invalid endpoint id: expected 64-char hex")]
    InvalidEndpointId,
    #[error("invalid signature")]
    InvalidSignature,
    #[error("timestamp out of window")]
    StaleTimestamp,
    #[error("ttl exceeds maximum {MAX_TTL_SECS}s")]
    TtlTooLarge,
    #[error("endpoint id mismatch between path and body")]
    IdMismatch,
    #[error("invalid address entry")]
    InvalidAddr,
    /// restricted 模式 ACL 拒绝（401 + JSON {"error":"dweb/<reason>"}，
    /// spec「rendezvous 访问控制」requirement 冻结的响应形态）
    #[error("{0}")]
    AclDenied(String),
}

impl RendezvousError {
    fn status(&self) -> StatusCode {
        match self {
            Self::InvalidEndpointId | Self::IdMismatch | Self::InvalidAddr => {
                StatusCode::BAD_REQUEST
            }
            Self::InvalidSignature | Self::StaleTimestamp => StatusCode::UNAUTHORIZED,
            Self::TtlTooLarge => StatusCode::BAD_REQUEST,
            Self::AclDenied(_) => StatusCode::UNAUTHORIZED,
        }
    }
}

/// ACL deny 的 JSON 响应体（spec 冻结：`{"error":"dweb/<reason>"}`）
#[derive(Serialize)]
struct AclErrorBody {
    error: String,
}

impl RendezvousError {
    /// 响应体：ACL 拒绝为 JSON（spec 冻结）；既有错误保持纯文本现状
    fn body(&self) -> String {
        match self {
            Self::AclDenied(reason) => serde_json::to_string(&AclErrorBody {
                error: reason.clone(),
            })
            .expect("serde_json 序列化 String 恒成功"),
            other => other.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnounceRequest {
    pub endpoint_id: String,
    pub addrs: Vec<String>,
    pub ttl_secs: u64,
    pub timestamp_ms: u64,
    /// Ed25519 签名，base64url-nopad
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveResponse {
    pub endpoint_id: String,
    pub addrs: Vec<String>,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone)]
struct Entry {
    addrs: Vec<String>,
    expires_at_ms: u64,
}

#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<[u8; 32], Entry>>,
}

/// 路由共享状态：登记表 + 可选 AccessGate（None = open 模式，行为与
/// 现状一致；Some = restricted 模式静态 ACL——恒 Static 策略，design §8.5）
pub struct AppState {
    registry: Registry,
    gate: Option<Arc<AccessGate>>,
}

pub type SharedState = Arc<AppState>;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn decode_endpoint_id(s: &str) -> Result<[u8; 32], RendezvousError> {
    let bytes = hex::decode(s).map_err(|_| RendezvousError::InvalidEndpointId)?;
    bytes
        .try_into()
        .map_err(|_| RendezvousError::InvalidEndpointId)
}

/// 规范签名载荷：
/// "dweb-rendezvous-announce-v1\0" || endpoint_id(32B) || timestamp_ms(u64 LE)
/// || addr_count(u16 LE) || per-addr(u16 LE len || utf8) || ttl_secs(u32 LE)
pub fn announce_canonical_bytes(
    endpoint_id: &[u8; 32],
    timestamp_ms: u64,
    addrs: &[String],
    ttl_secs: u32,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(64 + addrs.iter().map(|a| a.len() + 2).sum::<usize>());
    buf.extend_from_slice(b"dweb-rendezvous-announce-v1\0");
    buf.extend_from_slice(endpoint_id);
    buf.extend_from_slice(&timestamp_ms.to_le_bytes());
    buf.extend_from_slice(&(addrs.len() as u16).to_le_bytes());
    for addr in addrs {
        buf.extend_from_slice(&(addr.len() as u16).to_le_bytes());
        buf.extend_from_slice(addr.as_bytes());
    }
    buf.extend_from_slice(&ttl_secs.to_le_bytes());
    buf
}

/// open 模式路由（gate = None）。主路径经 [`router_with_access`]（main
/// 以 rdz_gate=None 达同语义）；本别名保留给测试与嵌入方直接构造。
#[allow(dead_code)]
pub fn router() -> Router {
    router_with_access(None)
}

/// 带 ACL 的路由构造（task 1.6）：`gate = None` 时与 [`router`]（open
/// 现状）完全一致；restricted 模式由 main 传入 Static 策略 gate。
pub fn router_with_access(gate: Option<Arc<AccessGate>>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/rendezvous/{id}", post(announce).get(resolve))
        .with_state(Arc::new(AppState {
            registry: Registry::default(),
            gate,
        }))
}

async fn healthz() -> StatusCode {
    StatusCode::OK
}

/// C0 同构凭证抽取（design §8.2 C0 / R4 P1-6）：Authorization header
/// 原始值 + `?token=` query 原始值（与 relay 面同一分类语义——存在但
/// 非法 → 401 malformed，绝不按无票处理）。非 UTF-8 header lossy 转换
/// （U+FFFD 恒不过白名单，必落 malformed）。token 字符集（dwebr1. +
/// base64url）天然 URL-safe，不做百分号解码——编码形态一律按原样送入
/// 分类器（编码异常的值必然 malformed，fail-closed）。
fn credential_sources(
    headers: &HeaderMap,
    raw_query: &Option<String>,
) -> (Option<String>, Option<String>) {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .map(|value| match value.to_str() {
            Ok(s) => s.to_owned(),
            Err(_) => String::from_utf8_lossy(value.as_bytes()).into_owned(),
        });
    let query_token = raw_query.as_deref().and_then(|q| {
        q.split('&').find_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            (name == "token").then(|| value.to_owned())
        })
    });
    (auth_header, query_token)
}

/// restricted 模式 ACL 执行（C0 → L1 → L1b → L2 全链经 AccessGate）。
/// deny → 401 + JSON `{"error":"dweb/<reason>"}`（spec 冻结响应形态）。
async fn acl_check(
    state: &AppState,
    op: Op,
    endpoint_id: [u8; 32],
    headers: &HeaderMap,
    raw_query: &Option<String>,
) -> Result<(), RendezvousError> {
    let Some(gate) = &state.gate else {
        return Ok(()); // open 模式：无 ACL（现状路径）
    };
    let (auth_header, query_token) = credential_sources(headers, raw_query);
    let input = GateInput {
        endpoint_id,
        auth_header,
        query_token,
        // rendezvous HTTP 面无 ConnectionId（webhook 不适用——恒 Static
        // 策略，此字段不参与决策）
        connection_id: 0,
        op,
    };
    match gate.decide(&input).await {
        GateDecision::Allow => Ok(()),
        GateDecision::Deny(reason) => Err(RendezvousError::AclDenied(reason.into_owned())),
    }
}

async fn announce(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw_query: RawQuery,
    Json(req): Json<AnnounceRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    // path/body 身份一致性 + id 解码先行（既有 400 语义保留），随后
    // restricted ACL（C0 先行序：无票/坏票/缺位/未注册 → 401，先于
    // 对签名与载荷细节的验证——不给未认证方验证 oracle）
    if req.endpoint_id != id {
        return Err((
            RendezvousError::IdMismatch.status(),
            RendezvousError::IdMismatch.body(),
        ));
    }
    let id_bytes = decode_endpoint_id(&req.endpoint_id).map_err(|e| (e.status(), e.body()))?;
    acl_check(&state, Op::RdzAnnounce, id_bytes, &headers, &raw_query.0)
        .await
        .map_err(|e| (e.status(), e.body()))?;
    handle_announce(&state.registry, id_bytes, req).map_err(|e| (e.status(), e.body()))
}

fn handle_announce(
    registry: &Registry,
    id_bytes: [u8; 32],
    req: AnnounceRequest,
) -> Result<StatusCode, RendezvousError> {
    if req.addrs.is_empty() || req.addrs.iter().any(|a| a.is_empty() || a.len() > 512) {
        return Err(RendezvousError::InvalidAddr);
    }
    if req.ttl_secs == 0 || req.ttl_secs > MAX_TTL_SECS {
        return Err(RendezvousError::TtlTooLarge);
    }
    let now = now_ms();
    if req.timestamp_ms.abs_diff(now) > TIMESTAMP_WINDOW_MS {
        return Err(RendezvousError::StaleTimestamp);
    }
    let canonical =
        announce_canonical_bytes(&id_bytes, req.timestamp_ms, &req.addrs, req.ttl_secs as u32);
    let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(&req.signature)
        .map_err(|_| RendezvousError::InvalidSignature)?
        .try_into()
        .map_err(|_| RendezvousError::InvalidSignature)?;
    let verifying = ed25519_dalek::VerifyingKey::from_bytes(&id_bytes)
        .map_err(|_| RendezvousError::InvalidEndpointId)?;
    verifying
        .verify(
            &canonical,
            &ed25519_dalek::Signature::from_bytes(&sig_bytes),
        )
        .map_err(|_| RendezvousError::InvalidSignature)?;

    let expires_at_ms = now + req.ttl_secs * 1000;
    registry.entries.lock().unwrap().insert(
        id_bytes,
        Entry {
            addrs: req.addrs,
            expires_at_ms,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn resolve(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw_query: RawQuery,
) -> Result<Json<ResolveResponse>, (StatusCode, String)> {
    let id_bytes = decode_endpoint_id(&id).map_err(|e| (e.status(), e.body()))?;
    // restricted：resolve bearer-only（C7 不适用）；endpoint_id 字段承载
    // 解析目标 id（不参与 recipient 绑定，仅 shape 校验需要合法 hex）
    acl_check(&state, Op::RdzResolve, id_bytes, &headers, &raw_query.0)
        .await
        .map_err(|e| (e.status(), e.body()))?;
    let now = now_ms();
    let entries = state.registry.entries.lock().unwrap();
    match entries.get(&id_bytes) {
        Some(entry) if entry.expires_at_ms > now => Ok(Json(ResolveResponse {
            endpoint_id: id,
            addrs: entry.addrs.clone(),
            expires_at_ms: entry.expires_at_ms,
        })),
        _ => Err((StatusCode::NOT_FOUND, "no active registration".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::cap::{
        CAP_KNOWN_MASK, CAP_RDZ_ANNOUNCE, CAP_RDZ_RESOLVE, CAP_RELAY, sign_and_encode,
    };
    use crate::access::config::PolicyConfig;
    use crate::access::registry::OwnerRegistry;
    use axum::body::Body;
    use axum::http::Request;
    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::TempDir;
    use tower::ServiceExt;

    fn signed_request(key: &SigningKey, addrs: Vec<&str>, ttl: u64, ts: u64) -> AnnounceRequest {
        let id_bytes = key.verifying_key().to_bytes();
        let addrs: Vec<String> = addrs.into_iter().map(String::from).collect();
        let canonical = announce_canonical_bytes(&id_bytes, ts, &addrs, ttl as u32);
        let sig = key.sign(&canonical);
        AnnounceRequest {
            endpoint_id: hex::encode(id_bytes),
            addrs,
            ttl_secs: ttl,
            timestamp_ms: ts,
            signature: URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        }
    }

    fn announce_body(req: &AnnounceRequest) -> Body {
        Body::from(serde_json::to_string(req).unwrap())
    }

    /// ACL 拒绝断言：401 + JSON 体恰为 {"error":"dweb/<reason>"}
    async fn assert_acl_deny(res: axum::response::Response, want_reason: &str) {
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{want_reason}");
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            body.as_ref(),
            format!("{{\"error\":\"{want_reason}\"}}").as_bytes(),
            "ACL deny 响应体必须恰为 spec 冻结形态"
        );
    }

    // ---- open 模式：现状行为逐字节一致（router() = router_with_access(None)）----

    #[tokio::test]
    async fn announce_then_resolve() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let app = router();
        let req = signed_request(&key, vec!["127.0.0.1:9000"], 60, now_ms());
        let id = req.endpoint_id.clone();

        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{id}"))
                    .header("content-type", "application/json")
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let res = app
            .oneshot(
                Request::get(format!("/rendezvous/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let resolved: ResolveResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(resolved.addrs, vec!["127.0.0.1:9000".to_string()]);
    }

    #[tokio::test]
    async fn invalid_signature_rejected() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let other = SigningKey::from_bytes(&[8u8; 32]);
        let mut req = signed_request(&key, vec!["127.0.0.1:9000"], 60, now_ms());
        // 用另一个 key 重签：对 id_bytes(属于 key) 的 canonical 签名必然验证失败
        let id_bytes = key.verifying_key().to_bytes();
        let canonical =
            announce_canonical_bytes(&id_bytes, req.timestamp_ms, &req.addrs, req.ttl_secs as u32);
        req.signature = URL_SAFE_NO_PAD.encode(other.sign(&canonical).to_bytes());

        let app = router();
        let res = app
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        // 现状语义保留：既有错误体为纯文本（非 ACL JSON 形态）
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), b"invalid signature");
    }

    #[tokio::test]
    async fn stale_timestamp_rejected() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let req = signed_request(&key, vec!["127.0.0.1:9000"], 60, now_ms() - 600_000);
        let app = router();
        let res = app
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn expired_entry_not_resolved() {
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let state = Arc::new(AppState {
            registry: Registry::default(),
            gate: None,
        });
        let id_bytes = key.verifying_key().to_bytes();
        state.registry.entries.lock().unwrap().insert(
            id_bytes,
            Entry {
                addrs: vec!["127.0.0.1:9000".into()],
                expires_at_ms: now_ms() - 1,
            },
        );
        let app = Router::new()
            .route("/rendezvous/{id}", get(resolve))
            .with_state(state);
        let res = app
            .oneshot(
                Request::get(format!("/rendezvous/{}", hex::encode(id_bytes)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// open 模式下 gate 恒 None（main 不构造）；匿名 announce（无 capability）
    /// 与匿名 resolve 现状可用——router_with_access(None) 与 router() 等价
    #[tokio::test]
    async fn open_mode_gate_none_keeps_anonymous_paths() {
        let key = SigningKey::from_bytes(&[10u8; 32]);
        for app in [router(), router_with_access(None)] {
            let req = signed_request(&key, vec!["127.0.0.1:9000"], 60, now_ms());
            let res = app
                .clone()
                .oneshot(
                    Request::post(format!("/rendezvous/{}", req.endpoint_id))
                        .header("content-type", "application/json")
                        .body(announce_body(&req))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::NO_CONTENT);
            let res = app
                .oneshot(
                    Request::get(format!("/rendezvous/{}", req.endpoint_id))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::OK);
        }
    }

    // ---- restricted 模式 ACL 矩阵（spec「rendezvous 访问控制」全部 Scenario）----

    /// restricted fixture：issuer（= registry 内 owner root）为 announce
    /// 签名者签发 capability；server_id/fabric_id 与 registry 联动。
    struct RestrictedFixture {
        issuer: SigningKey,
        server_id: [u8; 32],
        fabric_id: [u8; 32],
        /// announce 签名者（capability recipient 必须等于其 EndpointId）
        announcer: SigningKey,
    }

    impl RestrictedFixture {
        fn new() -> (Self, Router) {
            let dir = TempDir::new().unwrap();
            let registry = Arc::new(OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap());
            let f = Self {
                issuer: SigningKey::from_bytes(&[21u8; 32]),
                server_id: [22u8; 32],
                fabric_id: [23u8; 32],
                announcer: SigningKey::from_bytes(&[24u8; 32]),
            };
            registry
                .register(&f.fabric_id, &f.issuer.verifying_key().to_bytes())
                .unwrap();
            let gate = AccessGate::new(f.server_id, registry, PolicyConfig::Static).unwrap();
            (f, router_with_access(Some(Arc::new(gate))))
        }

        fn token_for(&self, recipient: &[u8; 32], caps: u8) -> String {
            let now = now_ms();
            sign_and_encode(
                &self.issuer,
                &self.fabric_id,
                &self.server_id,
                recipient,
                caps,
                now,
                now + 3_600_000,
            )
        }

        fn announcer_token(&self, caps: u8) -> String {
            self.token_for(&self.announcer.verifying_key().to_bytes(), caps)
        }

        fn bearer(&self, caps: u8) -> String {
            format!("Bearer {}", self.announcer_token(caps))
        }
    }

    #[tokio::test]
    async fn restricted_valid_caps_announce_and_resolve() {
        let (f, app) = RestrictedFixture::new();
        let req = signed_request(&f.announcer, vec!["10.0.0.1:9000"], 60, now_ms());
        let id = req.endpoint_id.clone();
        // 全位票 announce → 204
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{id}"))
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, f.bearer(CAP_KNOWN_MASK))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        // 仅 RDZ_RESOLVE 位票 resolve（bearer-only：recipient 与解析目标
        // 无关——announce 者与持票者可不同）→ 200
        let token = f.token_for(&[0xAB; 32], CAP_RDZ_RESOLVE);
        let res = app
            .clone()
            .oneshot(
                Request::get(format!("/rendezvous/{id}"))
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    /// query token 同形态接受（与 relay 面一致的 C0 分类：?token= 直取）
    #[tokio::test]
    async fn restricted_query_token_accepted() {
        let (f, app) = RestrictedFixture::new();
        let req = signed_request(&f.announcer, vec!["10.0.0.2:9000"], 60, now_ms());
        let token = f.announcer_token(CAP_RDZ_ANNOUNCE);
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .uri(format!("/rendezvous/{}?token={token}", req.endpoint_id))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn restricted_announce_reason_matrix() {
        let (f, app) = RestrictedFixture::new();

        // 无票 → dweb/no-capability（且不产生登记项）
        let req = signed_request(&f.announcer, vec!["10.0.0.3:9000"], 60, now_ms());
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/no-capability").await;

        // 存在但非 Bearer/坏前缀 → malformed（不按无票）
        for header_value in ["Basic xyz", "Bearer ", "Bearer dwebr2.aa", "garbage"] {
            let req = signed_request(&f.announcer, vec!["10.0.0.3:9000"], 60, now_ms());
            let res = app
                .clone()
                .oneshot(
                    Request::post(format!("/rendezvous/{}", req.endpoint_id))
                        .header("content-type", "application/json")
                        .header(header::AUTHORIZATION, header_value)
                        .body(announce_body(&req))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_acl_deny(res, "dweb/malformed-capability").await;
        }

        // caps 缺 RDZ_ANNOUNCE 位（仅 RELAY）→ caps-missing-rdz-announce
        let req = signed_request(&f.announcer, vec!["10.0.0.3:9000"], 60, now_ms());
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, f.bearer(CAP_RELAY))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/caps-missing-rdz-announce").await;

        // 身份绑定（spec Scenario「announce 的身份绑定校验」）：持 A 的
        // capability 但以 B 的私钥签名 announce → not-recipient，不产生登记项
        let impostor = SigningKey::from_bytes(&[25u8; 32]);
        let req = signed_request(&impostor, vec!["10.0.0.3:9000"], 60, now_ms());
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, f.bearer(CAP_RDZ_ANNOUNCE))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/not-recipient").await;

        // 未注册 owner（issuer 不在 registry）→ unknown-owner
        let stranger = SigningKey::from_bytes(&[26u8; 32]);
        let now = now_ms();
        let token = sign_and_encode(
            &stranger,
            &f.fabric_id,
            &f.server_id,
            &f.announcer.verifying_key().to_bytes(),
            CAP_RDZ_ANNOUNCE,
            now,
            now + 3_600_000,
        );
        let req = signed_request(&f.announcer, vec!["10.0.0.3:9000"], 60, now_ms());
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/unknown-owner").await;

        // 过期票 → capability-expired
        let expired = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &f.server_id,
            &f.announcer.verifying_key().to_bytes(),
            CAP_RDZ_ANNOUNCE,
            now_ms() - 7_200_000,
            now_ms() - 3_600_000,
        );
        let req = signed_request(&f.announcer, vec!["10.0.0.3:9000"], 60, now_ms());
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {expired}"))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/capability-expired").await;

        // 坏票（篡改字符）→ bad-signature
        let mut tampered = f.announcer_token(CAP_RDZ_ANNOUNCE).into_bytes();
        tampered[100] = if tampered[100] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        let req = signed_request(&f.announcer, vec!["10.0.0.3:9000"], 60, now_ms());
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {tampered}"))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/bad-signature").await;

        // 跨 Server 票 → wrong-server
        let wrong = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &[0x99; 32],
            &f.announcer.verifying_key().to_bytes(),
            CAP_RDZ_ANNOUNCE,
            now_ms(),
            now_ms() + 3_600_000,
        );
        let req = signed_request(&f.announcer, vec!["10.0.0.3:9000"], 60, now_ms());
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{}", req.endpoint_id))
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {wrong}"))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/wrong-server").await;

        // 全部 deny 后登记表必须为空（未授权 announce 不产生副作用）
        let state_probe = app
            .oneshot(
                Request::get(format!(
                    "/rendezvous/{}",
                    hex::encode(f.announcer.verifying_key().to_bytes())
                ))
                .header(header::AUTHORIZATION, f.bearer(CAP_RDZ_RESOLVE))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(state_probe.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn restricted_resolve_reason_matrix() {
        let (f, app) = RestrictedFixture::new();
        let target = f.announcer.verifying_key().to_bytes();
        let target_hex = hex::encode(target);

        // 预置登记项（有效全位票 announce）
        let req = signed_request(&f.announcer, vec!["10.0.0.4:9000"], 60, now_ms());
        let res = app
            .clone()
            .oneshot(
                Request::post(format!("/rendezvous/{target_hex}"))
                    .header("content-type", "application/json")
                    .header(header::AUTHORIZATION, f.bearer(CAP_KNOWN_MASK))
                    .body(announce_body(&req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        // 无票匿名 resolve → 401 no-capability，不返回任何登记项
        let res = app
            .clone()
            .oneshot(
                Request::get(format!("/rendezvous/{target_hex}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/no-capability").await;

        // 缺 RDZ_RESOLVE 位（仅 RELAY，spec Scenario）→ caps-missing-rdz-resolve
        let res = app
            .clone()
            .oneshot(
                Request::get(format!("/rendezvous/{target_hex}"))
                    .header(header::AUTHORIZATION, f.bearer(CAP_RELAY))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/caps-missing-rdz-resolve").await;

        // 坏票 → malformed（不按无票）
        let res = app
            .clone()
            .oneshot(
                Request::get(format!("/rendezvous/{target_hex}"))
                    .header(header::AUTHORIZATION, "Bearer not-a-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_acl_deny(res, "dweb/malformed-capability").await;
    }
}
