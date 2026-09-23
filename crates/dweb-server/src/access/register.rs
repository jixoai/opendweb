//! `POST /register` 公开自助注册端点（server-access-roles Phase 1b，R4：
//! 租户持邀请码兑换；挂 gateway 根路径，不经 admin token；请求/响应体
//! ≤4KiB）。
//!
//! 校验序（spec 冻结终态，MUST NOT 重排）：
//! ① 直连 TCP peer 令牌桶限流（默认 10/min 突发 5，`DWEB_REGISTER_RATE_
//! PER_MIN` 可配；**ConnectInfo<SocketAddr>，XFF/Forwarded 一律不采信**）
//! → ② 字段形状 → ③ ts ±120s（`stale-ts`）→ ④ **PoP 验签**（域
//! `b"dweb/register/v1\0" || code || fabric_id || root || ts(u64BE)`，
//! 验签键 = body.root；**幂等回放路径同样先验签**——认证边界与普通注册
//! 一致，r5-P2-1）→ ⑤ 幂等命中/码状态/新兑换（[`CodeLedger::redeem`] 状态
//! 机：durable 回放/pending 补写均不刷新租期）。
//!
//! canonical 冻结（与 CLI `packages/opendweb/src/register.mjs` 逐字节互认，
//! 跨语言对拍向量钉死于本模块测试 + e2e）：
//! - register PoP：`b"dweb/register/v1\0"`（18B）|| code（**请求原文**，
//!   实现期裁决 b）|| fabric_id（hex 小写文本 64B）|| root（hex 小写文本
//!   64B）|| ts u64BE —— 冻结向量 179B
//! - receipt：`b"dweb/register-receipt/v1\0"`（25B）|| code_hash 32B ||
//!   fabric 32B || root 32B || ts u64BE || generation u64BE —— 137B 定长；
//!   generation = **owners 世代**（register 为兑换主效果；客户端不透明）
//!
//! 错误 envelope（sdk-mgmt-surface 冻结家族）：`{"error":{"code","message"}}`；
//! 状态码映射（spec 冻结 429/409/503；其余为实现期裁决，见交付报告）：
//! 400 invalid-request / 401 stale-ts·bad-signature / 400 code-invalid·
//! code-exhausted·code-expired / 409 code-pending / 429 rate-limited /
//! 500 internal / 503 code-unavailable。
//!
//! **脱敏红线（r1-P1-3）**：日志/指标/错误消息零码全文或其可逆变换——
//! 一切输出只允许 code_hash 形态。部署红线（r3-P2-2）：反向代理/
//! access-log/tracing **禁止记录 `POST /register` 请求体**（与码全文脱敏
//! 同级的红线——spec 冻结的生产部署文档义务）。
//!
//! home-hub [H6] 设备自报别名：body 可选 `alias`（≤32 UTF-8 字节，
//! `serde(default)` 兼容旧客户端），**不进 PoP canonical**（自报是展示层
//! 标签而非认证载荷——canonical 域冻结不重签）；落 owners 的优先级 =
//! body.alias（自报）> 码 alias_hint > 无，且为**首写语义**（同键已存在
//! 时自报不覆盖既有 alias——管理员 PATCH 命名/先前自报均受保护；幂等
//! 回放路径零 owners 副作用，alias 天然不变）。

use super::codes::{self, CodeLedger, RedeemOutcome};
use super::identity::ServerIdentity;
use super::ratelimit::IpRateLimiter;
use super::registry::{OwnerRegistry, parse_owner_hex};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

/// register PoP 域分隔符（17 字节域 + NUL = 18B）
pub const REGISTER_DOMAIN: &[u8] = b"dweb/register/v1\0";
/// 回执域分隔符（24 字节域 + NUL = 25B）
pub const RECEIPT_DOMAIN: &[u8] = b"dweb/register-receipt/v1\0";
/// 回执 canonical 定长：25 域 + 32×3 + 8×2 = 137B（spec 冻结）
pub const RECEIPT_CANONICAL_LEN: usize = RECEIPT_DOMAIN.len() + 32 * 3 + 8 * 2;
/// ts 窗口 ±120s（防重放；spec 冻结）
const TS_WINDOW_MS: u64 = 120_000;
/// 请求/响应体上限（spec 冻结 ≤4KiB；超限 413）
pub const MAX_BODY_BYTES: usize = 4096;
/// 自报别名上限（home-hub [H6]；与 admin PATCH ALIAS_MAX_BYTES / codes
/// alias_hint 同拍：≤32 UTF-8 字节）
pub const ALIAS_MAX_BYTES: usize = 32;

/// 共享状态（main 装配：identity 签回执、owners/codes 双台账、per-IP 限流）
#[derive(Clone)]
pub struct RegisterState {
    pub identity: Arc<ServerIdentity>,
    pub owners: Arc<OwnerRegistry>,
    pub codes: Arc<CodeLedger>,
    pub limiter: Arc<IpRateLimiter>,
}

/// 挂载公开注册路由（`POST /register`，gateway 根路径；4KiB body 上限层）
pub fn router(state: RegisterState) -> Router {
    Router::new()
        .route("/register", post(register_endpoint))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

/// register PoP canonical（spec 冻结）：code 取请求原文（裁决 b——服务端以
/// body 重建自洽，哈希规范化仅用于 code_hash）；fabric/root 以小写 hex
/// 文本嵌入（与 CLI 端 canonical 恒小写形态一致，body 大写输入不影响验签）
pub fn register_pop_canonical(
    code: &str,
    fabric_hex_lower: &str,
    root_hex_lower: &str,
    ts: u64,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(
        REGISTER_DOMAIN.len() + code.len() + fabric_hex_lower.len() + root_hex_lower.len() + 8,
    );
    buf.extend_from_slice(REGISTER_DOMAIN);
    buf.extend_from_slice(code.as_bytes());
    buf.extend_from_slice(fabric_hex_lower.as_bytes());
    buf.extend_from_slice(root_hex_lower.as_bytes());
    buf.extend_from_slice(&ts.to_be_bytes());
    buf
}

/// register-receipt canonical（spec 冻结 137B 定长；code_hash/fabric/root
/// 为 32B 原始字节而非 hex 文本；回执不含 code 本体）
pub fn register_receipt_canonical(
    code_hash: &[u8; 32],
    fabric_id: &[u8; 32],
    root: &[u8; 32],
    ts: u64,
    generation: u64,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(RECEIPT_CANONICAL_LEN);
    buf.extend_from_slice(RECEIPT_DOMAIN);
    buf.extend_from_slice(code_hash);
    buf.extend_from_slice(fabric_id);
    buf.extend_from_slice(root);
    buf.extend_from_slice(&ts.to_be_bytes());
    buf.extend_from_slice(&generation.to_be_bytes());
    buf
}

#[derive(Deserialize)]
struct RegisterBody {
    code: String,
    fabric_id: String,
    root: String,
    ts: u64,
    sig: String,
    /// 设备自报别名（home-hub [H6]；可选，≤32 UTF-8 字节，空串/超限 =
    /// 400 invalid-request；`serde(default)` 兼容旧客户端 body）。
    /// **不进 PoP canonical**（域冻结；自报是展示层标签，非认证载荷）
    #[serde(default)]
    alias: Option<String>,
}

/// 成功响应（CLI parseRegisterResponse 冻结形态：op/code_hash/fabric_id/
/// root/expires_at/ts/generation/receipt_sig；未知字段由消费端忽略）
#[derive(serde::Serialize)]
struct RegisterReceipt {
    op: &'static str,
    code_hash: String,
    fabric_id: String,
    root: String,
    expires_at: u64,
    ts: u64,
    generation: u64,
    /// base64url-nopad(64B)——server.key 对 receipt canonical 的签名
    receipt_sig: String,
}

/// 错误 envelope（`{"error":{"code","message"}}`；Content-Type JSON）
fn error_envelope(status: StatusCode, code: &str, message: &str) -> Response {
    let body = serde_json::json!({ "error": { "code": code, "message": message } });
    (status, Json(body)).into_response()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 端点主流程（校验序见模块注释；一切错误输出零码全文）
async fn register_endpoint(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<RegisterState>,
    body: Result<Json<RegisterBody>, axum::extract::rejection::JsonRejection>,
) -> Response {
    // ① 直连 TCP peer 限流（XFF 不采信——键恒为 peer.ip()）
    if !state.limiter.take(peer.ip()) {
        return error_envelope(
            StatusCode::TOO_MANY_REQUESTS,
            "rate-limited",
            "too many register attempts from this address; wait a minute and retry",
        );
    }
    // ② 字段形状（JSON 不可解析/缺字段/类型不符 = invalid-request；状态码
    // 继承 axum 拒绝语义——超限 413 / 语法 400 / 类型 422 / content-type 415）
    let Json(body) = match body {
        Ok(b) => b,
        Err(e) => {
            let rejection = e.into_response();
            let status = rejection.status();
            let bytes = axum::body::to_bytes(rejection.into_body(), usize::MAX)
                .await
                .unwrap_or_default();
            return error_envelope(
                status,
                "invalid-request",
                &format!(
                    "malformed register request: {}",
                    String::from_utf8_lossy(&bytes)
                ),
            );
        }
    };
    if body.code.is_empty() || body.code.len() > 256 {
        return error_envelope(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "code must be a non-empty string (<=256 chars)",
        );
    }
    // home-hub [H6]：自报别名形状（str::len = UTF-8 字节数；空串无意义拒收）
    if let Some(alias) = &body.alias
        && (alias.is_empty() || alias.len() > ALIAS_MAX_BYTES)
    {
        return error_envelope(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            &format!("alias must be a non-empty string (<= {ALIAS_MAX_BYTES} UTF-8 bytes)"),
        );
    }
    let fabric_id = match parse_owner_hex(&body.fabric_id) {
        Ok(v) => v,
        Err(e) => {
            return error_envelope(StatusCode::BAD_REQUEST, "invalid-request", &e);
        }
    };
    let root = match parse_owner_hex(&body.root) {
        Ok(v) => v,
        Err(e) => {
            return error_envelope(StatusCode::BAD_REQUEST, "invalid-request", &e);
        }
    };
    let sig_bytes: [u8; 64] = match URL_SAFE_NO_PAD
        .decode(&body.sig)
        .map_err(|e| e.to_string())
        .and_then(|v| v.try_into().map_err(|_| "not 64 bytes".to_string()))
    {
        Ok(v) => v,
        Err(e) => {
            return error_envelope(
                StatusCode::BAD_REQUEST,
                "invalid-request",
                &format!("sig must be base64url-nopad encoding 64 bytes ({e})"),
            );
        }
    };
    let now = now_ms();
    // ③ ts 窗口 ±120s
    if body.ts.abs_diff(now) > TS_WINDOW_MS {
        return error_envelope(
            StatusCode::UNAUTHORIZED,
            "stale-ts",
            "timestamp outside the ±120s window; check the clock and re-sign",
        );
    }
    // ④ PoP 验签（域含 root——验签键 = body.root，冒名注册需他人 root 私钥；
    //    回放路径同样先验签：此处先于一切幂等/码状态判定）
    let canonical = register_pop_canonical(
        &body.code,
        &hex::encode(fabric_id).to_ascii_lowercase(),
        &hex::encode(root).to_ascii_lowercase(),
        body.ts,
    );
    let verifying = match VerifyingKey::from_bytes(&root) {
        Ok(v) => v,
        Err(_) => {
            return error_envelope(
                StatusCode::UNAUTHORIZED,
                "bad-signature",
                "root is not a valid Ed25519 verifying key",
            );
        }
    };
    if verifying
        .verify(&canonical, &Signature::from_bytes(&sig_bytes))
        .is_err()
    {
        return error_envelope(
            StatusCode::UNAUTHORIZED,
            "bad-signature",
            "proof-of-possession signature verification failed",
        );
    }
    // 码规范化（哈希键专用；canonical 已用请求原文完成验签——裁决 b）。
    // 规范化失败 = code-invalid（码状态阶段的产品错误码，spec 冻结）
    let Some(normalized) = codes::normalize_code_body(&body.code) else {
        return error_envelope(
            StatusCode::BAD_REQUEST,
            "code-invalid",
            "code is not a dwebc1 invitation code",
        );
    };
    let code_hash = codes::code_hash(&normalized);
    // ⑤ 幂等命中 → pending → deny-set → 码状态 → 新兑换（codes 台账锁内）；
    //    alias（自报 > alias_hint）仅在新兑换路径落 owners（H6）
    let outcome = state.codes.redeem(
        &state.owners,
        &code_hash,
        &fabric_id,
        &root,
        body.alias.as_deref(),
        now,
    );
    let expires_at = match outcome {
        RedeemOutcome::Replay { expires_at } => {
            tracing::info!(
                code_hash = %hex::encode(code_hash),
                "register idempotent replay (no lease refresh, no new consume)"
            );
            expires_at
        }
        RedeemOutcome::Completed { expires_at } => {
            tracing::info!(
                code_hash = %hex::encode(code_hash),
                fabric_id = %hex::encode(fabric_id),
                root = %hex::encode(root),
                expires_at,
                "tenant registered via invite code"
            );
            expires_at
        }
        RedeemOutcome::PendingOtherKey => {
            return error_envelope(
                StatusCode::CONFLICT,
                "code-pending",
                "code is mid-redemption by another key; retry in a moment",
            );
        }
        RedeemOutcome::Unavailable => {
            return error_envelope(
                StatusCode::SERVICE_UNAVAILABLE,
                "code-unavailable",
                "code ledger temporarily unavailable; retry shortly",
            );
        }
        RedeemOutcome::Invalid => {
            return error_envelope(
                StatusCode::BAD_REQUEST,
                "code-invalid",
                "the invite code is not recognized by this server",
            );
        }
        RedeemOutcome::Expired => {
            return error_envelope(
                StatusCode::BAD_REQUEST,
                "code-expired",
                "the invite code has expired",
            );
        }
        RedeemOutcome::Exhausted => {
            return error_envelope(
                StatusCode::BAD_REQUEST,
                "code-exhausted",
                "the invite code has no uses left",
            );
        }
        RedeemOutcome::Io(e) => {
            tracing::error!(
                code_hash = %hex::encode(code_hash),
                "register redemption append failed: {e:#}"
            );
            return error_envelope(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "redemption could not be persisted; retry with the same request",
            );
        }
    };
    // ③ 双 fsync 成功 → 回执（ts = 当前时刻；generation = owners 世代；
    //    幂等回放同以当前时刻重签——spec 冻结）
    let generation = state.owners.snapshot().generation();
    let receipt_sig = state.identity.sign(&register_receipt_canonical(
        &code_hash, &fabric_id, &root, now, generation,
    ));
    Json(RegisterReceipt {
        op: "register",
        code_hash: hex::encode(code_hash),
        fabric_id: hex::encode(fabric_id),
        root: hex::encode(root),
        expires_at,
        ts: now,
        generation,
        receipt_sig: URL_SAFE_NO_PAD.encode(receipt_sig),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::codes::{IssueParams, RedeemKey};
    use crate::access::ratelimit::IpRateLimiter;
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::TempDir;
    use tower::ServiceExt;

    // ---- 跨语言对拍冻结向量（packages/opendweb/test/id-crypto.test.mjs 镜像） ----

    const FABRIC: &str = "11";
    const ROOT_HEX: &str = "22";
    const CODE_HASH_HEX: &str = "33";
    const TS: u64 = 1_758_612_345_678;

    /// RFC 8032 TEST 1 官方向量（跨实现一致性锚：dalek = OpenSSL = RFC）
    #[test]
    fn rfc8032_test1_vectors() {
        let seed = hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .unwrap()
            .try_into()
            .unwrap();
        let key = SigningKey::from_bytes(&seed);
        assert_eq!(
            hex::encode(key.verifying_key().to_bytes()),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        assert_eq!(
            hex::encode(key.sign(&[]).to_bytes()),
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        );
    }

    /// register canonical 冻结向量（179B；hex 逐字节对齐 CLI 测试）
    #[test]
    fn register_canonical_frozen_vector() {
        let canonical = register_pop_canonical(
            "dwebc1.0123-4567-89cd-fghj",
            &FABRIC.repeat(32),
            &ROOT_HEX.repeat(32),
            TS,
        );
        assert_eq!(canonical.len(), 179, "18 域 + 25 code + 64 + 64 + 8");
        // fabric/root 以 hex 文本（utf8）嵌入 canonical——hex dump 为 ASCII
        // 字节的编码（"1"→0x31），与 CLI `Buffer.from(FABRIC, "utf8").toString("hex")` 同源
        let expected = format!(
            "647765622f72656769737465722f763100\
             6477656263312e303132332d343536372d383963642d6667686a\
             {}\
             {}\
             000001997576d34e",
            hex::encode(FABRIC.repeat(32)),
            hex::encode(ROOT_HEX.repeat(32)),
        );
        assert_eq!(hex::encode(&canonical), expected);
    }

    /// receipt canonical 冻结向量（137B；code_hash/fabric/root 为 32B 原始
    /// 字节而非 hex 文本；ts/generation u64BE）
    #[test]
    fn receipt_canonical_frozen_vector() {
        let code_hash: [u8; 32] = hex::decode(CODE_HASH_HEX.repeat(32))
            .unwrap()
            .try_into()
            .unwrap();
        let fabric: [u8; 32] = hex::decode(FABRIC.repeat(32)).unwrap().try_into().unwrap();
        let root: [u8; 32] = hex::decode(ROOT_HEX.repeat(32))
            .unwrap()
            .try_into()
            .unwrap();
        let canonical = register_receipt_canonical(&code_hash, &fabric, &root, TS, 7);
        assert_eq!(RECEIPT_CANONICAL_LEN, 137);
        assert_eq!(canonical.len(), 137);
        let expected = format!(
            "647765622f72656769737465722d726563656970742f763100\
             {}{}{}\
             000001997576d34e\
             0000000000000007",
            CODE_HASH_HEX.repeat(32),
            FABRIC.repeat(32),
            ROOT_HEX.repeat(32),
        );
        assert_eq!(hex::encode(&canonical), expected);
    }

    /// 回执验签往返：server.key 签名可被 ServerId 公钥按 canonical 验证
    /// （CLI verifyRegisterReceipt 的服务端侧对偶），篡改任一字段失败
    #[test]
    fn receipt_sign_verify_roundtrip() {
        let dir = TempDir::new().unwrap();
        let identity = ServerIdentity::load_or_create(dir.path()).unwrap();
        let code_hash = [0x33u8; 32];
        let fabric = [0x11u8; 32];
        let root = [0x22u8; 32];
        let canonical = register_receipt_canonical(&code_hash, &fabric, &root, TS, 7);
        let sig = identity.sign(&canonical);
        let verifying = VerifyingKey::from_bytes(identity.server_id().as_bytes()).unwrap();
        assert!(
            verifying
                .verify(&canonical, &Signature::from_bytes(&sig))
                .is_ok()
        );
        // 篡改 ts（重签前体）→ 验签失败
        let tampered = register_receipt_canonical(&code_hash, &fabric, &root, TS + 1, 7);
        assert!(
            verifying
                .verify(&tampered, &Signature::from_bytes(&sig))
                .is_err()
        );
    }

    // ---- HTTP 层矩阵（oneshot + 合成 ConnectInfo） ----

    struct Fixture {
        _dir: TempDir,
        app: axum::Router,
        root_key: SigningKey,
        fabric: [u8; 32],
        code_display: String,
        code_hash: [u8; 32],
        identity: Arc<ServerIdentity>,
        owners: Arc<OwnerRegistry>,
        codes: Arc<CodeLedger>,
    }

    /// 测试 shim：注入 ConnectInfo（oneshot 无真实 TCP peer；生产路径由
    /// main 的 into_make_service_with_connect_info 提供）
    fn peer_shim(app: axum::Router, ip: [u8; 4]) -> axum::Router {
        use axum::middleware::Next;
        use std::net::{IpAddr, Ipv4Addr};
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::from(ip)), 0);
        app.layer(axum::middleware::from_fn(
            move |mut req: Request<Body>, next: Next| async move {
                req.extensions_mut().insert(ConnectInfo(addr));
                next.run(req).await
            },
        ))
    }

    impl Fixture {
        fn new() -> Self {
            Self::with_params(IssueParams::default())
        }

        fn with_params(params: IssueParams) -> Self {
            let dir = TempDir::new().unwrap();
            let identity = Arc::new(ServerIdentity::load_or_create(dir.path()).unwrap());
            let owners = Arc::new(OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap());
            let codes = Arc::new(CodeLedger::load(&dir.path().join("codes.jsonl"), &[]).unwrap());
            let (code_display, code_hash) = codes.issue(params).unwrap();
            let limiter = Arc::new(IpRateLimiter::new(1_000_000, 1_000_000));
            let app = router(RegisterState {
                identity: Arc::clone(&identity),
                owners: Arc::clone(&owners),
                codes: Arc::clone(&codes),
                limiter,
            });
            Self {
                _dir: dir,
                app: peer_shim(app, [127, 0, 0, 1]),
                root_key: SigningKey::from_bytes(&[0x42; 32]),
                fabric: [0x11; 32],
                code_display,
                code_hash,
                identity,
                owners,
                codes,
            }
        }

        fn root_hex(&self) -> String {
            hex::encode(self.root_key.verifying_key().to_bytes())
        }

        /// CLI 同构组包（canonical 恒小写 hex；code 取请求原文；alias 不进
        /// canonical——H6 自报字段仅入 body）
        fn request(&self, code: &str, ts: u64, signer: &SigningKey) -> Request<Body> {
            self.request_with_alias(code, ts, signer, None)
        }

        /// 自报别名变体（home-hub [H6]）
        fn request_with_alias(
            &self,
            code: &str,
            ts: u64,
            signer: &SigningKey,
            alias: Option<&str>,
        ) -> Request<Body> {
            let root_hex = hex::encode(signer.verifying_key().to_bytes());
            let canonical = register_pop_canonical(code, &hex::encode(self.fabric), &root_hex, ts);
            let sig = URL_SAFE_NO_PAD.encode(signer.sign(&canonical).to_bytes());
            let mut body = serde_json::json!({
                "code": code,
                "fabric_id": hex::encode(self.fabric),
                "root": root_hex,
                "ts": ts,
                "sig": sig,
            });
            if let Some(alias) = alias {
                body["alias"] = serde_json::json!(alias);
            }
            Request::post("/register")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap()
        }

        async fn send(&self, req: Request<Body>) -> (StatusCode, serde_json::Value) {
            let res = self.app.clone().oneshot(req).await.unwrap();
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

        async fn error_code(&self, req: Request<Body>) -> (StatusCode, String) {
            let (status, body) = self.send(req).await;
            (
                status,
                body["error"]["code"].as_str().unwrap_or("").to_string(),
            )
        }
    }

    /// 正常兑换：200 回执形态冻结 + expires_at = now+30d + 消费计数 +
    /// registry 出现该键 + 回执可验签（CLI parseRegisterResponse 兼容字段）
    #[tokio::test]
    async fn normal_redemption_receipt_shape_and_verify() {
        let f = Fixture::new();
        let (status, body) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["op"], "register");
        assert_eq!(body["code_hash"], hex::encode(f.code_hash));
        assert_eq!(body["fabric_id"], hex::encode(f.fabric));
        assert_eq!(body["root"], f.root_hex());
        assert_eq!(
            body["generation"],
            serde_json::json!(f.owners.snapshot().generation())
        );
        let expires = body["expires_at"].as_u64().unwrap();
        assert!(expires > now_ms() && expires <= now_ms() + 30 * 24 * 3_600_000);
        let ts = body["ts"].as_u64().unwrap();
        // 回执验签（CLI verifyRegisterReceipt 同构）
        let canonical = register_receipt_canonical(
            &f.code_hash,
            &f.fabric,
            &hex::decode(body["root"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap(),
            ts,
            body["generation"].as_u64().unwrap(),
        );
        let sig: [u8; 64] = URL_SAFE_NO_PAD
            .decode(body["receipt_sig"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let verifying = VerifyingKey::from_bytes(f.identity.server_id().as_bytes()).unwrap();
        assert!(
            verifying
                .verify(&canonical, &Signature::from_bytes(&sig))
                .is_ok()
        );
        // 副作用
        assert!(
            f.owners
                .snapshot()
                .contains(&f.fabric, &f.root_key.verifying_key().to_bytes())
        );
        assert_eq!(f.codes.snapshot().used_count(&f.code_hash), 1);
        // 响应体 ≤4KiB
        assert!(serde_json::to_string(&body).unwrap().len() <= MAX_BODY_BYTES);
    }

    /// 校验序矩阵：错 sig（冒名 PoP）→ bad-signature；重放窗口外 → stale-ts；
    /// 形状（坏 hex/坏 sig 编码/缺字段/非 JSON）→ invalid-request；未知码 →
    /// code-invalid；耗尽他键 → code-exhausted
    #[tokio::test]
    async fn validation_order_matrix() {
        let f = Fixture::new();
        // 错 sig：冒名者声明受害者 root 但以自己私钥签名（冒名注册被 PoP 拒绝）
        let impostor = SigningKey::from_bytes(&[0x99; 32]);
        let ts = now_ms();
        let canonical =
            register_pop_canonical(&f.code_display, &hex::encode(f.fabric), &f.root_hex(), ts);
        let forged = serde_json::json!({
            "code": f.code_display,
            "fabric_id": hex::encode(f.fabric),
            "root": f.root_hex(),
            "ts": ts,
            "sig": URL_SAFE_NO_PAD.encode(impostor.sign(&canonical).to_bytes()),
        });
        let req = Request::post("/register")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_string(&forged).unwrap()))
            .unwrap();
        let (status, code) = f.error_code(req).await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::UNAUTHORIZED, "bad-signature")
        );
        // 重放窗口外（ts 过去 121s）
        let (status, code) = f
            .error_code(f.request(&f.code_display, now_ms() - 121_000, &f.root_key))
            .await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::UNAUTHORIZED, "stale-ts")
        );
        // 形状：fabric 非 hex64
        let mut req = f.request(&f.code_display, now_ms(), &f.root_key);
        let bad = serde_json::json!({
            "code": f.code_display,
            "fabric_id": "zz",
            "root": f.root_hex(),
            "ts": now_ms(),
            "sig": URL_SAFE_NO_PAD.encode([0u8; 64]),
        });
        *req.body_mut() = Body::from(serde_json::to_string(&bad).unwrap());
        let (status, code) = f.error_code(req).await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::BAD_REQUEST, "invalid-request")
        );
        // sig 非 base64url
        let bad = serde_json::json!({
            "code": f.code_display,
            "fabric_id": hex::encode(f.fabric),
            "root": f.root_hex(),
            "ts": now_ms(),
            "sig": "!!!",
        });
        let req = Request::post("/register")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_string(&bad).unwrap()))
            .unwrap();
        let (status, code) = f.error_code(req).await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::BAD_REQUEST, "invalid-request")
        );
        // 非 JSON 体
        let req = Request::post("/register")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("not json"))
            .unwrap();
        let (status, code) = f.error_code(req).await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::BAD_REQUEST, "invalid-request")
        );
        // 未知码（签名合法——PoP 先过后码状态拒）
        let (status, code) = f
            .error_code(f.request("dwebc1.aaaa-bbbb-cccc-dddd", now_ms(), &f.root_key))
            .await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::BAD_REQUEST, "code-invalid")
        );
        // 畸形码（非 crockford 字符）→ code-invalid（规范化失败）
        let (status, code) = f
            .error_code(f.request("dwebc1.0123-4567-89cd-fghi", now_ms(), &f.root_key))
            .await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::BAD_REQUEST, "code-invalid")
        );
        // 耗尽：K1 兑换后他键 → code-exhausted
        let (status, _) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        assert_eq!(status, StatusCode::OK);
        let other = SigningKey::from_bytes(&[0x88; 32]);
        let (status, code) = f
            .error_code(f.request(&f.code_display, now_ms(), &other))
            .await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::BAD_REQUEST, "code-exhausted")
        );
    }

    /// 同键旧码重试 = 200 幂等回放：expires_at 不刷新、无新 consume、回执
    /// 以重试时刻重签（ts 前进、generation 相同或前进）
    #[tokio::test]
    async fn same_key_replay_no_refresh() {
        let f = Fixture::new();
        let (_, first) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        std::thread::sleep(std::time::Duration::from_millis(5));
        let (_, second) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        assert_eq!(
            first["expires_at"], second["expires_at"],
            "幂等回放不刷新租期（回放≠续期）"
        );
        assert!(
            second["ts"].as_u64().unwrap() > first["ts"].as_u64().unwrap(),
            "回执以重试时刻重签"
        );
        assert_eq!(
            f.codes.snapshot().used_count(&f.code_hash),
            1,
            "无新 consume"
        );
        assert_eq!(f.owners.snapshot().entries().len(), 1, "不重复建条目");
    }

    /// 持新有效码续期：同 (fabric,root) 二次兑换 → expires_at 刷新为新码
    /// default_ttl_days（7 天码 vs 默认 30 天码可区分）；名册不重复建条目
    #[tokio::test]
    async fn renewal_via_new_code_refreshes() {
        let f = Fixture::new();
        let (_, first) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        // 新码（default_ttl_days=7）兑换同键：issue 直接经台账实例（1c 前
        // 无签发路由，文件/方法入口等价）
        let (_, hash2) = f
            .codes
            .issue(IssueParams {
                default_ttl_days: Some(7),
                ..Default::default()
            })
            .unwrap();
        let now = now_ms();
        match f.codes.redeem(
            &f.owners,
            &hash2,
            &f.fabric,
            &f.root_key.verifying_key().to_bytes(),
            None,
            now,
        ) {
            RedeemOutcome::Completed { expires_at } => {
                assert_eq!(expires_at, now + 7 * 24 * 3_600_000, "新码租期");
                assert!(
                    expires_at < first["expires_at"].as_u64().unwrap(),
                    "7 天 < 30 天（租期随新码 default_ttl_days）"
                );
            }
            other => panic!("expected completion, got {other:?}"),
        }
        assert_eq!(f.owners.snapshot().entries().len(), 1, "名册单一二元组");
        assert_eq!(f.codes.snapshot().used_count(&f.code_hash), 1);
        assert_eq!(f.codes.snapshot().used_count(&hash2), 1);
    }

    /// 大写 hex body 的 PoP 验签：canonical 恒小写形态（CLI 冻结语义镜像）
    #[tokio::test]
    async fn uppercase_hex_body_signs_lowercase_canonical() {
        let f = Fixture::new();
        let root_hex_lower = f.root_hex();
        let ts = now_ms();
        let canonical =
            register_pop_canonical(&f.code_display, &hex::encode(f.fabric), &root_hex_lower, ts);
        let sig = URL_SAFE_NO_PAD.encode(f.root_key.sign(&canonical).to_bytes());
        let body = serde_json::json!({
            "code": f.code_display,
            "fabric_id": hex::encode(f.fabric).to_ascii_uppercase(),
            "root": root_hex_lower.to_ascii_uppercase(),
            "ts": ts,
            "sig": sig,
        });
        let req = Request::post("/register")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();
        let (status, resp) = f.send(req).await;
        assert_eq!(status, StatusCode::OK, "{resp}");
        assert_eq!(resp["root"], root_hex_lower, "响应恒小写 hex");
    }

    /// 请求体 >4KiB → 413（DefaultBodyLimit；不进校验链）
    #[tokio::test]
    async fn oversized_body_rejected() {
        let f = Fixture::new();
        let big = serde_json::json!({
            "code": f.code_display,
            "fabric_id": hex::encode(f.fabric),
            "root": f.root_hex(),
            "ts": now_ms(),
            "sig": "A",
            "padding": "x".repeat(5000),
        });
        let req = Request::post("/register")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_string(&big).unwrap()))
            .unwrap();
        let res = f.app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    /// per-IP 限流 + XFF 不采信：小桶限流器下第二请求 429（同 peer）；
    /// 伪造 X-Forwarded-For 不分裂限流键
    #[tokio::test]
    async fn rate_limit_and_xff_ignored() {
        let dir = TempDir::new().unwrap();
        let identity = Arc::new(ServerIdentity::load_or_create(dir.path()).unwrap());
        let owners = Arc::new(OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap());
        let codes = Arc::new(CodeLedger::load(&dir.path().join("codes.jsonl"), &[]).unwrap());
        let app = peer_shim(
            router(RegisterState {
                identity: Arc::clone(&identity),
                owners: Arc::clone(&owners),
                codes: Arc::clone(&codes),
                limiter: Arc::new(IpRateLimiter::new(2, 1)), // burst 1
            }),
            [127, 0, 0, 1],
        );
        let body = serde_json::json!({
            "code": "dwebc1.0123-4567-89cd-fghj",
            "fabric_id": hex::encode([0x11; 32]),
            "root": hex::encode([0x22; 32]),
            "ts": now_ms(),
            "sig": URL_SAFE_NO_PAD.encode([0u8; 64]),
        });
        let mk = |xff: &str| {
            Request::post("/register")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-forwarded-for", xff)
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap()
        };
        let res = app.clone().oneshot(mk("1.2.3.4")).await.unwrap();
        assert_eq!(
            res.status(),
            StatusCode::UNAUTHORIZED,
            "首个消费突发（形状合法、零签名 → PoP 401）"
        );
        // 伪造不同 XFF 不能分裂限流键（仍同 peer 127.0.0.1）
        let res = app.clone().oneshot(mk("5.6.7.8")).await.unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["error"]["code"], "rate-limited");
    }

    /// 幂等回放路径同样先验签（r5-P2-1）：已耗尽码 + 同键 + 错误签名 →
    /// bad-signature（而非回放 200）
    #[tokio::test]
    async fn replay_path_requires_valid_signature() {
        let f = Fixture::new();
        let (status, _) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        assert_eq!(status, StatusCode::OK);
        // 同键回放但换签名者（无 root 私钥的攻击者）→ bad-signature
        let impostor = SigningKey::from_bytes(&[0x77; 32]);
        let root_hex = f.root_hex();
        // 冒名者不能签出合法签名——组包以 impostor 签名、root 仍声明受害者
        let ts = now_ms();
        let canonical =
            register_pop_canonical(&f.code_display, &hex::encode(f.fabric), &root_hex, ts);
        let sig = URL_SAFE_NO_PAD.encode(impostor.sign(&canonical).to_bytes());
        let body = serde_json::json!({
            "code": f.code_display,
            "fabric_id": hex::encode(f.fabric),
            "root": root_hex,
            "ts": ts,
            "sig": sig,
        });
        let req = Request::post("/register")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap();
        let (status, code) = f.error_code(req).await;
        assert_eq!(
            (status, code.as_str()),
            (StatusCode::UNAUTHORIZED, "bad-signature")
        );
    }

    /// 部署红线（文档面）：/register 请求体不得进日志——本测试钉代码事实：
    /// tracing 输出面（本 crate 的全部 tracing 调用）不含码全文（静态审查
    /// 由 review 承担；运行时断言：成功兑换后日志缓冲不含码）。
    /// 这里以响应体不含 code 字段作为 wire 侧可测代理。
    #[tokio::test]
    async fn success_response_contains_no_code_body() {
        let f = Fixture::new();
        let (status, body) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        assert_eq!(status, StatusCode::OK);
        let text = serde_json::to_string(&body).unwrap();
        assert!(!text.contains("dwebc1."), "回执不含 code 本体（spec 冻结）");
    }

    /// 跨台账提交持久性：成功兑换后两台账事件齐备（owners 带 via_code_hash
    /// register + codes consume）；孤儿事实源暴露完整三元组
    #[tokio::test]
    async fn both_ledgers_persisted_after_success() {
        let f = Fixture::new();
        let (status, _) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        assert_eq!(status, StatusCode::OK);
        let owners_text = std::fs::read_to_string(f.owners.path()).unwrap();
        assert!(owners_text.contains(&format!(
            "\"via_code_hash\":\"{}\"",
            hex::encode(f.code_hash)
        )));
        let codes_text = std::fs::read_to_string(f.codes.path()).unwrap();
        assert!(codes_text.contains("\"op\":\"consume\""));
        let key: RedeemKey = (f.code_hash, f.fabric, f.root_key.verifying_key().to_bytes());
        assert!(f.codes.snapshot().is_consumed(&key));
        assert_eq!(f.owners.snapshot().code_orphans(), vec![key]);
    }

    // ---- home-hub [H6] 设备自报别名 ------------------------------------------

    /// owners 条目别名查找（二元组定位）
    fn owner_alias(f: &Fixture) -> Option<String> {
        let root = f.root_key.verifying_key().to_bytes();
        f.owners
            .snapshot()
            .entries()
            .into_iter()
            .find(|e| e.fabric_id == f.fabric && e.root == root)
            .and_then(|e| e.alias)
    }

    /// 自报落册 + 优先级 body.alias > alias_hint（hint 码同拍组合）+ 回执
    /// 不回显 alias（成功响应最小冻结不增字段）
    #[tokio::test]
    async fn alias_self_report_wins_over_hint() {
        let f = Fixture::with_params(IssueParams {
            alias_hint: Some("hint-name".into()),
            ..Default::default()
        });
        let (status, body) = f
            .send(f.request_with_alias(&f.code_display, now_ms(), &f.root_key, Some("kzf-MacBook")))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            owner_alias(&f).as_deref(),
            Some("kzf-MacBook"),
            "body.alias（自报）优先于 alias_hint"
        );
        assert!(
            body.get("alias").is_none(),
            "回执不回显 alias（响应形态冻结不增字段）"
        );
    }

    /// 无自报时 hint 兜底 + 旧客户端兼容：body 无 alias 字段（serde default）
    /// 照常 200
    #[tokio::test]
    async fn alias_hint_fallback_and_legacy_body_compat() {
        let f = Fixture::with_params(IssueParams {
            alias_hint: Some("hint-name".into()),
            ..Default::default()
        });
        // request() 组包不含 alias 键 = 旧客户端 body 形态
        let (status, _) = f
            .send(f.request(&f.code_display, now_ms(), &f.root_key))
            .await;
        assert_eq!(status, StatusCode::OK, "旧 body 无 alias 字段兼容");
        assert_eq!(owner_alias(&f).as_deref(), Some("hint-name"), "hint 兜底");
    }

    /// 首写语义全链路：首次自报落册 → 续期（新码）自报不覆盖 → 幂等回放
    /// 自报不改变
    #[tokio::test]
    async fn alias_first_write_renewal_and_replay_no_overwrite() {
        let f = Fixture::new();
        let (status, _) = f
            .send(f.request_with_alias(&f.code_display, now_ms(), &f.root_key, Some("first-name")))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(owner_alias(&f).as_deref(), Some("first-name"), "首写落册");
        // 续期：新码（带 hint）+ 新自报 → alias 不覆盖
        let (_, hash2) = f
            .codes
            .issue(IssueParams {
                alias_hint: Some("hint-2".into()),
                ..Default::default()
            })
            .unwrap();
        // 经 HTTP 面需要 code_display；issue 只回 hash——用码正文不可行，
        // 直接以台账实例同参调用（与 renewal_via_new_code_refreshes 同法）
        let now = now_ms();
        match f.codes.redeem(
            &f.owners,
            &hash2,
            &f.fabric,
            &f.root_key.verifying_key().to_bytes(),
            Some("second-name"),
            now,
        ) {
            RedeemOutcome::Completed { .. } => {}
            other => panic!("expected completion, got {other:?}"),
        }
        assert_eq!(
            owner_alias(&f).as_deref(),
            Some("first-name"),
            "续期自报不覆盖既有 alias"
        );
        // 幂等回放：同码同键 + 不同自报 → 200 但 alias 不变
        let (status, _) = f
            .send(f.request_with_alias(&f.code_display, now_ms(), &f.root_key, Some("replay-name")))
            .await;
        assert_eq!(status, StatusCode::OK, "幂等回放 200");
        assert_eq!(
            owner_alias(&f).as_deref(),
            Some("first-name"),
            "幂等回放不改变 alias"
        );
    }

    /// 形状矩阵：空串/超长 ASCII/超长多字节（UTF-8 字节计数）→ 400
    /// invalid-request；恰好 32 字节（含多字节边界）放行
    #[tokio::test]
    async fn alias_shape_validation() {
        let f = Fixture::new();
        let cases: [(&str, &str, bool); 4] = [
            ("empty", "", false),
            ("ascii-33", &"x".repeat(33), false),
            // 漢 = 3 字节 ×11 = 33 字节（多字节计数按 UTF-8 字节而非字符数）
            ("cjk-33", &"漢".repeat(11), false),
            // 漢×10 = 30 字节 + "ab" = 恰 32 字节（放行）
            ("cjk-exact-32", &format!("{}ab", "漢".repeat(10)), true),
        ];
        for (name, alias, ok) in cases {
            let (status, body) = f
                .send(f.request_with_alias(&f.code_display, now_ms(), &f.root_key, Some(alias)))
                .await;
            if ok {
                assert_eq!(status, StatusCode::OK, "{name}: {body}");
            } else {
                assert_eq!(
                    (status, body["error"]["code"].as_str().unwrap_or("")),
                    (StatusCode::BAD_REQUEST, "invalid-request"),
                    "{name}"
                );
                // 拒收请求零副作用（owners 无条目）
                assert!(f.owners.snapshot().entries().is_empty(), "{name}");
            }
        }
        // 恰 32 字节放行时自报落册
        assert_eq!(
            owner_alias(&f).as_deref(),
            Some(format!("{}ab", "漢".repeat(10)).as_str())
        );
    }
}
