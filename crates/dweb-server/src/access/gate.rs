//! AccessGate：验证链执行点聚合（task 1.5 + 1.5b + 1.6 + 3.2 前半，需求来源
//! 2026-09-17；design §8.2 C0/L1/L1b/L2 验证链全图 + §8.4 rendezvous
//! 授权 + spec「relay capability 验证」/「动态策略回调」/「rendezvous
//! 访问控制」全部 Scenario）。
//!
//! 纯逻辑聚合层——输入为已抽取的原始请求要素（GateInput），输出
//! Allow / Deny(reason)。iroh-relay 装配（RelayAccessControl，relay.rs）只
//! 负责从 ClientRequest 抽取要素与本类型的双向适配，可测性优先：
//!
//! ```text
//! C0 凭证来源分类（R4 P1-6：区分「声明了凭证但非法」与「无凭证」）
//!   ├─ header/query 皆缺失 ──────────► 无票路径（跳过 L1/L1b，入 L2）
//!   ├─ 任一存在但非 Bearer 形态/非法 UTF-8（lossy 后落白名单外）/
//!   │  非 dwebr1. 前缀/空值 ────────► DENY dweb/malformed-capability
//!   │                                  （绝不降级无票——防坏票混入 A_cb）
//!   └─ 有效前缀 ──► L1（cap::verify_l1，C3..C7）──► L1b（registry 二元组
//!                   + op caps 位）──► L2（static：无票拒/有票放；
//!                   callback：交 webhook，无票也交 = A_cb(S) 语义）
//! ```
//!
//! L1/L1b 对出示票据的接入恒定执行、任何 provider 不可绕过（R3 P0-B1）；
//! static 模式行为与 R2 版十步链完全一致（向后一致）。
//! open 模式不构造本类型（relay 装配 AllowAll 快路径零开销）。

use crate::access::blocklist::{BlockKind, Blocklist};
use crate::access::callback::CallbackProvider;
use crate::access::cap::{self, CAP_RDZ_ANNOUNCE, CAP_RDZ_RESOLVE, CAP_RELAY, CapDeny, RelayCap};
use crate::access::config::PolicyConfig;
use crate::access::knock::KnockLog;
use crate::access::registry::{OwnerRegistry, RegistrySnapshot};
use crate::access::visitor::VisitorRegistry;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// per-owner 连接配额超限 deny reason（task 3.2 前半；wire 冻结 slug，
/// 语法同 dweb/ 家族）
pub const OWNER_QUOTA_EXCEEDED: &str = "dweb/owner-quota-exceeded";

/// 黑名单拒绝 deny reason（server-access-roles Phase 1a，spec 冻结；
/// relay 面协议只回 slug——reason 明文经 Phase 1c 管理面呈现）
pub const BLOCKED_REASON: &str = "dweb/blocked";

/// 租户条目过期 deny reason（L1b 时间维度；与 unknown-owner 区分，spec 冻结）
pub const OWNER_EXPIRED: &str = "dweb/owner-expired";

/// 访客两级配额超限 deny reason（per-endpoint 与全局共用，spec 冻结）
pub const VISITOR_QUOTA_EXCEEDED: &str = "dweb/visitor-quota-exceeded";

/// 待验证操作面（L1b B2 的 caps 位选择）。rendezvous announce/resolve 的
/// Op 变体随 task 1.6 接入（design §8.4：按 HTTP 面能力分别设计）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// relay 客户端接入（所需位 = CAP_RELAY；C7 绑定握手 id）
    RelayConnect,
    /// rendezvous announce 登记（所需位 = CAP_RDZ_ANNOUNCE；C7 绑定
    /// announce 载荷签名的 EndpointId——design §8.4 零成本 PoP）
    RdzAnnounce,
    /// rendezvous resolve 解析（所需位 = CAP_RDZ_RESOLVE；bearer-only
    /// 明示降级——C7 不适用，无握手身份，design §8.4 / R4 P1-7）
    RdzResolve,
}

impl Op {
    /// L1b B2 所需 caps 位
    fn required_cap(self) -> u8 {
        match self {
            Self::RelayConnect => CAP_RELAY,
            Self::RdzAnnounce => CAP_RDZ_ANNOUNCE,
            Self::RdzResolve => CAP_RDZ_RESOLVE,
        }
    }

    /// 缺位 deny reason（wire 冻结：relay 面为 caps-missing-relay；
    /// rendezvous 面为 caps-missing-rdz-announce/rdz-resolve，
    /// 与 caps-missing-relay 同构生成）
    fn missing_reason(self) -> &'static str {
        match self {
            Self::RelayConnect => "dweb/caps-missing-relay",
            Self::RdzAnnounce => "dweb/caps-missing-rdz-announce",
            Self::RdzResolve => "dweb/caps-missing-rdz-resolve",
        }
    }

    /// C7（recipient 绑定）是否适用本操作面。resolve 无握手身份
    /// （design §8.4 R4 P1-7）：bearer-only，仅验密码学有效性。
    fn checks_recipient(self) -> bool {
        !matches!(self, Self::RdzResolve)
    }

    /// endpoint_id 是否为本操作面**已认证的请求方身份**（server-access-roles
    /// Phase 1a 黑名单 endpoint 维度与访客名册的适用面判定）：
    /// - RelayConnect：iroh-relay 握手认证身份（E1 链）——适用
    /// - RdzAnnounce：announce 载荷签名的 EndpointId（签名私钥即 PoP）——适用
    /// - RdzResolve：endpoint_id 字段是**解析目标**而非请求方（bearer-only
    ///   无调用方身份）——不适用（按目标 id 拉黑会错杀「解析到被拉黑端点」
    ///   的合法请求，且无法约束请求方）
    fn authenticates_endpoint(self) -> bool {
        !matches!(self, Self::RdzResolve)
    }
}

/// 验证链输入（由执行点从原始请求要素抽取；connection_id 供 webhook
/// payload 关联生命周期）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateInput {
    /// 请求方身份（E1 绑定语义按 op 分面，design §8.4）：
    /// - RelayConnect：iroh-relay 握手认证身份（C7 recipient 绑定）
    /// - RdzAnnounce：announce 载荷中签名的 EndpointId（签名私钥即 PoP，
    ///   C7 绑定 = capability.recipient == 签名者，窃取 token 者无法
    ///   以他人身份登记）
    /// - RdzResolve：本字段不参与 C7（bearer-only，无握手身份）
    pub endpoint_id: [u8; 32],
    /// 原始 Authorization header 值（未归一化；非 UTF-8 由执行点 lossy
    /// 转换——U+FFFD 恒不过 dwebr1./base64url 白名单，必落 malformed）
    pub auth_header: Option<String>,
    /// `?token=` query 原始值（无 Bearer 前缀）
    pub query_token: Option<String>,
    /// iroh-relay ConnectionId（webhook payload 的 opaque 关联键；
    /// rendezvous HTTP 面无 ConnectionId，传 0）
    pub connection_id: u64,
    pub op: Op,
}

/// 验证链裁决。Deny 携带稳定 `dweb/` reason slug（static 链路为 'static，
/// callback 自定义 reason 为运行期字符串——经语法校验，进不出协议语法）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    Deny(Cow<'static, str>),
}

/// L2 策略 provider（design §8.5）：static / callback（webhook）。
enum Policy {
    Static,
    Callback(Arc<CallbackProvider>),
}

/// 在线连接表（task 3.2 前半 + server-access-roles Phase 1a 访客维度）：
/// 键 = (endpoint_id, connection_id) → fabric 归属 `Option<[u8; 32]>`。
/// **无 sentinel**（r1-P1-7）：访客连接的归属为 None（Option 类型隔离
/// 真实 FabricId 空间，保留字不污染）；租户票接入为 Some(fabric_id)。
/// 生命周期配对（依赖 iroh-relay 装配语义，handshake.rs authorize_with）：
/// on_connect 返回 Allow 后 OnDisconnectGuard 立即创建，其 Drop **恒**触发
/// on_disconnect（恰一次）——reserve 与 release 由此天然配对，连接中途
/// 死亡（accept 发送失败）也不例外。
/// 无票 A_cb 接入（webhook 放行的非访客）不计入任何维度（无归属可计，
/// 既有语义保持）；open 模式无 gate，零计数。
struct OnlineTable(Mutex<OnlineInner>);

#[derive(Default)]
struct OnlineInner {
    /// (endpoint_id, connection_id) → fabric 归属（None = 访客连接）
    conns: HashMap<([u8; 32], u64), Option<[u8; 32]>>,
    /// fabric_id → 租户在线连接数（per-owner 配额判定与 admin status 投影）
    owners: HashMap<[u8; 32], usize>,
    /// endpoint_id → 访客在线连接数（两级配额的 per-endpoint 维 + 投影）
    visitors: HashMap<[u8; 32], usize>,
}

/// admin status / connections 的在线表只读投影（GET /admin/status 与
/// GET /admin/connections 消费）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineView {
    /// per (endpoint, fabric) 对（**仅租户票接入**——访客连接无 fabric
    /// 归属，不混入本表）
    pub per_endpoint: Vec<OnlineEndpoint>,
    /// per owner（fabric_id → 在线连接数）
    pub per_owner: Vec<([u8; 32], usize)>,
    /// per visitor（endpoint_id → 在线连接数；endpoint_id 字典序——
    /// server-access-roles spec 冻结）
    pub per_visitor: Vec<([u8; 32], usize)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineEndpoint {
    pub endpoint_id: [u8; 32],
    pub fabric_id: [u8; 32],
    pub connections: usize,
}

impl OnlineTable {
    /// 租户票接入的原子配额预约（check+incr 同锁，杜绝并发 TOCTOU 超限）。
    /// 返回 false = 超限（不产生任何计数副作用）。
    fn reserve(
        &self,
        fabric_id: &[u8; 32],
        endpoint_id: [u8; 32],
        connection_id: u64,
        limit: Option<usize>,
    ) -> bool {
        let mut inner = self.0.lock().unwrap();
        let current = inner.owners.get(fabric_id).copied().unwrap_or(0);
        if limit.is_some_and(|l| current >= l) {
            return false;
        }
        // 同键重复预约（ConnectionId 进程内唯一，不应发生——防御性先回退
        // 旧归属再重记，保计数守恒）
        if let Some(old) = inner
            .conns
            .insert((endpoint_id, connection_id), Some(*fabric_id))
        {
            decrement_by_owner(&mut inner, old, endpoint_id);
        }
        *inner.owners.entry(*fabric_id).or_insert(0) += 1;
        true
    }

    /// 访客连接的原子两级配额预约（server-access-roles Phase 1a，r1-P1-4）：
    /// per-endpoint 上限 + 全局访客上限（防多 key 女巫聚合）。
    /// 返回 false = 任一超限（不产生任何计数副作用）。
    fn reserve_visitor(
        &self,
        endpoint_id: [u8; 32],
        connection_id: u64,
        per_endpoint_limit: usize,
        global_limit: usize,
    ) -> bool {
        let mut inner = self.0.lock().unwrap();
        let per = inner.visitors.get(&endpoint_id).copied().unwrap_or(0);
        if per >= per_endpoint_limit {
            return false;
        }
        let global: usize = inner.visitors.values().sum();
        if global >= global_limit {
            return false;
        }
        // 防御性回退旧归属（计数守恒，与租户路径同逻辑）
        if let Some(old) = inner.conns.insert((endpoint_id, connection_id), None) {
            decrement_by_owner(&mut inner, old, endpoint_id);
        }
        *inner.visitors.entry(endpoint_id).or_insert(0) += 1;
        true
    }

    /// 名额释放（on_disconnect；幂等——未知键零副作用）
    fn release(&self, endpoint_id: [u8; 32], connection_id: u64) {
        let mut inner = self.0.lock().unwrap();
        if let Some(owner) = inner.conns.remove(&(endpoint_id, connection_id)) {
            decrement_by_owner(&mut inner, owner, endpoint_id);
        }
    }

    /// 只读投影（admin status 低频调用；三表分别确定性排序）
    fn view(&self) -> OnlineView {
        let inner = self.0.lock().unwrap();
        // 条目粒度 = (endpoint_id, fabric_id) 对（r3-P1-3）：同 endpoint 持
        // 多 fabric 连接时逐对成条，杜绝 first() 类不确定聚合；排序双键
        // （endpoint_id, fabric_id）字典序，消费侧（disconnect 展开/receipts）
        // 依赖该确定性。访客连接（None 归属）单独进 per_visitor。
        let mut by_pair: HashMap<([u8; 32], [u8; 32]), usize> = HashMap::new();
        let mut visitors: HashMap<[u8; 32], usize> = HashMap::new();
        for ((endpoint, _conn), owner) in &inner.conns {
            match owner {
                Some(fabric) => *by_pair.entry((*endpoint, *fabric)).or_insert(0) += 1,
                None => *visitors.entry(*endpoint).or_insert(0) += 1,
            }
        }
        let mut per_endpoint: Vec<OnlineEndpoint> = by_pair
            .into_iter()
            .map(|((endpoint_id, fabric_id), connections)| OnlineEndpoint {
                endpoint_id,
                fabric_id,
                connections,
            })
            .collect();
        per_endpoint.sort_by_key(|e| (e.endpoint_id, e.fabric_id));
        let mut per_owner: Vec<([u8; 32], usize)> =
            inner.owners.iter().map(|(k, v)| (*k, *v)).collect();
        per_owner.sort();
        let mut per_visitor: Vec<([u8; 32], usize)> = visitors.into_iter().collect();
        per_visitor.sort();
        OnlineView {
            per_endpoint,
            per_owner,
            per_visitor,
        }
    }
}

/// 按归属递减计数（归零即删键，防 HashMap 无界增长）；owner = Some(fabric)
/// 走租户表，None 走访客表（endpoint 维）
fn decrement_by_owner(inner: &mut OnlineInner, owner: Option<[u8; 32]>, endpoint_id: [u8; 32]) {
    match owner {
        Some(fabric_id) => {
            if let Some(count) = inner.owners.get_mut(&fabric_id)
                && *count > 0
            {
                *count -= 1;
                if *count == 0 {
                    inner.owners.remove(&fabric_id);
                }
            }
        }
        None => {
            if let Some(count) = inner.visitors.get_mut(&endpoint_id)
                && *count > 0
            {
                *count -= 1;
                if *count == 0 {
                    inner.visitors.remove(&endpoint_id);
                }
            }
        }
    }
}

/// 验证链聚合器。`restricted` 模式构造（open 模式不构造，relay 走 AllowAll）。
pub struct AccessGate {
    server_id: [u8; 32],
    registry: Arc<OwnerRegistry>,
    policy: Policy,
    /// task 3.2 前半：票接入在线表（恒维护——admin status 需要；配额为
    /// None 时仅观测不拦截）
    online: OnlineTable,
    /// per-owner 在线连接上限（None = 无上限）
    max_connections_per_owner: Option<usize>,
    /// server-access-roles Phase 1a：无票准入名册（缺省 = 空台账——
    /// restricted 模式由 main 接线真实台账）
    visitors: Arc<VisitorRegistry>,
    /// 黑名单（缺省 = 空名单；endpoint 维度先于 C0、fabric 维度在 L1 后）
    blocklist: Arc<Blocklist>,
    /// 敲门台账（内存；唯一生产写入方 = relay Deny 臂，见 record_knock）
    knocks: KnockLog,
    /// 访客两级配额：per-endpoint 上限（spec 默认 4）
    max_connections_per_visitor: usize,
    /// 访客两级配额：全局上限（spec 默认 64，防多 key 女巫聚合 r1-P1-4）
    max_visitor_connections: usize,
}

impl std::fmt::Debug for AccessGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessGate")
            .field(
                "policy",
                &match &self.policy {
                    Policy::Static => "static",
                    Policy::Callback(_) => "callback",
                },
            )
            .finish_non_exhaustive()
    }
}

impl AccessGate {
    /// 构造（callback 配置的 URL 边界校验在此 fail-fast，错误经 main 退出码 2）
    pub fn new(
        server_id: [u8; 32],
        registry: Arc<OwnerRegistry>,
        policy: PolicyConfig,
    ) -> Result<Self, String> {
        let policy = match policy {
            PolicyConfig::Static => Policy::Static,
            PolicyConfig::Callback(cfg) => Policy::Callback(Arc::new(CallbackProvider::new(&cfg)?)),
        };
        Ok(Self {
            server_id,
            registry,
            policy,
            online: OnlineTable(Mutex::new(OnlineInner::default())),
            max_connections_per_owner: None,
            visitors: Arc::new(VisitorRegistry::ephemeral()),
            blocklist: Arc::new(Blocklist::ephemeral()),
            knocks: KnockLog::new(),
            max_connections_per_visitor: crate::access::config::DEFAULT_MAX_CONNECTIONS_PER_VISITOR,
            max_visitor_connections: crate::access::config::DEFAULT_MAX_VISITOR_CONNECTIONS,
        })
    }

    /// per-owner 连接配额（task 3.2 前半；builder 形态——main 仅对 relay
    /// gate 设置，rendezvous gate 无连接语义不设置）
    pub fn with_max_connections_per_owner(mut self, limit: Option<usize>) -> Self {
        self.max_connections_per_owner = limit;
        self
    }

    /// 访客名册接线（server-access-roles Phase 1a；restricted 模式由 main
    /// 装配——relay gate 必接；rendezvous gate 不接：访客可达面 v1 冻结为
    /// relay 通行，rendezvous 无票恒拒）
    pub fn with_visitor_ledger(mut self, visitors: Arc<VisitorRegistry>) -> Self {
        self.visitors = visitors;
        self
    }

    /// 黑名单接线（relay 与 rendezvous gate 均可接：endpoint 维度仅对
    /// 已认证请求方身份的面生效、fabric 维度对任何持票面生效）
    pub fn with_blocklist(mut self, blocklist: Arc<Blocklist>) -> Self {
        self.blocklist = blocklist;
        self
    }

    /// 访客两级配额（per-endpoint / 全局；spec 默认 4/64）
    pub fn with_visitor_quotas(mut self, per_endpoint: usize, global: usize) -> Self {
        self.max_connections_per_visitor = per_endpoint;
        self.max_visitor_connections = global;
        self
    }

    /// 执行验证链（C0 → L1 → L1b → L2 + Phase 1a 门禁）。全链 O(1) + 单次
    /// 验签；唯一网络调用是 callback 模式的 L2 webhook（超时/并发防护见
    /// callback.rs）。
    pub async fn decide(&self, input: &GateInput) -> GateDecision {
        // 黑名单 endpoint 维度（spec 冻结：先于 C0 凭证分类——有票无票同样
        // 生效，有效票不豁免，malformed 凭证同样先吃 blocked）。仅对
        // endpoint_id 为已认证请求方身份的面生效（RdzResolve 的 endpoint_id
        // 是解析目标而非请求方，不适用）。
        if input.op.authenticates_endpoint() {
            let blocked = self.blocklist.snapshot();
            if blocked.is_blocked(BlockKind::Endpoint, &input.endpoint_id) {
                tracing::debug!(
                    endpoint = %hex::encode(input.endpoint_id),
                    reason = blocked
                        .reason(BlockKind::Endpoint, &input.endpoint_id)
                        .unwrap_or(""),
                    "access denied by blocklist (endpoint dimension)"
                );
                return GateDecision::Deny(Cow::Borrowed(BLOCKED_REASON));
            }
        }
        match classify_credential(input.auth_header.as_deref(), input.query_token.as_deref()) {
            // C0：声明了凭证但不可解析——绝不进无票路径（R4 P1-6）
            Credential::Malformed => {
                GateDecision::Deny(Cow::Borrowed(CapDeny::MalformedCapability.reason()))
            }
            // 无票：跳过 L1/L1b，走访客/策略路径（Phase 1a 次序冻结）
            Credential::None => self.decide_no_ticket(input).await,
            Credential::Token(token) => {
                // L1 密码学完整性（C1/C2 形态门在 decode 内）
                let parsed = match cap::decode(token) {
                    Ok(c) => c,
                    Err(_) => {
                        return GateDecision::Deny(Cow::Borrowed(
                            CapDeny::MalformedCapability.reason(),
                        ));
                    }
                };
                // C7 recipient 绑定按 op 分面（design §8.4 / R4 P1-7）：
                // relay/announce 面绑定请求方身份（握手 id / 签名 EndpointId）；
                // resolve 面无握手身份——bearer-only 明示降级，传 cap.recipient
                // 自洽通过（仅验密码学有效性，capability 泄露即可用直至 TTL）
                let recipient_for_check: &[u8; 32] = match input.op.checks_recipient() {
                    true => &input.endpoint_id,
                    false => &parsed.recipient,
                };
                if let Err(e) =
                    cap::verify_l1(&parsed, &self.server_id, recipient_for_check, now_ms())
                {
                    return GateDecision::Deny(Cow::Borrowed(e.reason()));
                }
                // 黑名单 fabric 维度（spec 冻结：L1 解析出 issuer 后、L1b 之前
                // ——命中的 issuer fabric 拒；L1 失败的坏票已在上一步吃密码学
                // reason，验证链不回退）
                {
                    let blocked = self.blocklist.snapshot();
                    if blocked.is_blocked(BlockKind::Fabric, &parsed.fabric_id) {
                        tracing::debug!(
                            fabric = %hex::encode(parsed.fabric_id),
                            reason = blocked
                                .reason(BlockKind::Fabric, &parsed.fabric_id)
                                .unwrap_or(""),
                            "access denied by blocklist (fabric dimension)"
                        );
                        return GateDecision::Deny(Cow::Borrowed(BLOCKED_REASON));
                    }
                }
                // L1b 票有效性底线（static/callback 共享，不可插拔）：时间
                // 维度——过期拒 dweb/owner-expired（在册但过期），与未注册的
                // dweb/unknown-owner 区分（spec「relay capability 验证」冻结）
                let snapshot = self.registry.snapshot();
                if !snapshot.contains_active(&parsed.fabric_id, &parsed.issuer, now_ms()) {
                    return GateDecision::Deny(Cow::Borrowed(
                        if snapshot.contains(&parsed.fabric_id, &parsed.issuer) {
                            OWNER_EXPIRED
                        } else {
                            "dweb/unknown-owner"
                        },
                    ));
                }
                if !parsed.has_cap(input.op.required_cap()) {
                    return GateDecision::Deny(Cow::Borrowed(input.op.missing_reason()));
                }
                // per-owner 连接配额（task 3.2 前半）：relay 面且持票接入才
                // 计数——无票接入无 owner 维度（A_cb 不占配额）；rendezvous
                // Op 是无状态 HTTP 请求，不占连接名额。位置在 L1b 之后、
                // L2 之前：配额是 Server 自身的资源硬限（同 client_rx 定位），
                // 不交 webhook 裁决，也省一次注定被拒的回调。
                let mut reserved = false;
                if input.op == Op::RelayConnect {
                    if !self.online.reserve(
                        &parsed.fabric_id,
                        input.endpoint_id,
                        input.connection_id,
                        self.max_connections_per_owner,
                    ) {
                        return GateDecision::Deny(Cow::Borrowed(OWNER_QUOTA_EXCEEDED));
                    }
                    reserved = true;
                }
                let decision = self
                    .decide_l2(
                        Some(&parsed),
                        input,
                        snapshot,
                        self.visitors.snapshot().generation(),
                    )
                    .await;
                // L2 deny 的连接不会注册（iroh-relay 先 authorize 后
                // register），on_disconnect 永不触发——不回滚即泄漏名额
                if reserved && matches!(decision, GateDecision::Deny(_)) {
                    self.online.release(input.endpoint_id, input.connection_id);
                }
                decision
            }
        }
    }

    /// 无票路径（server-access-roles spec 冻结次序，MUST NOT 重排）：
    /// ① 黑名单 endpoint 维度已在 C0 前判定（拒 dweb/blocked）；
    /// ② 访客表命中（活跃）→ 放行（**不咨询 callback webhook**——名册先于
    ///    webhook；仅 relay 面：E1 握手认证身份即访客身份，rendezvous 可达
    ///    面 v1 冻结为空，design §1.6）；
    /// ③ policy=callback → webhook 裁决（A_cb(S)）；
    /// ④ 拒 dweb/no-capability（+ 记敲门——relay Deny 臂挂点）。
    /// 访客放行计入两级独立配额（per-endpoint + 全局，超限
    /// dweb/visitor-quota-exceeded——资源硬限不交 webhook，与 owner 配额
    /// 同位）；A_cb 放行的非访客无票连接不占任何配额（既有语义）。
    async fn decide_no_ticket(&self, input: &GateInput) -> GateDecision {
        let visitors = self.visitors.snapshot();
        if input.op == Op::RelayConnect && visitors.is_active(&input.endpoint_id, now_ms()) {
            if !self.online.reserve_visitor(
                input.endpoint_id,
                input.connection_id,
                self.max_connections_per_visitor,
                self.max_visitor_connections,
            ) {
                return GateDecision::Deny(Cow::Borrowed(VISITOR_QUOTA_EXCEEDED));
            }
            return GateDecision::Allow;
        }
        // ③/④（rendezvous 无票恒 static 拒——rdz gate 不接 callback）。
        // 缓存键复合 generation：owners+visitors 世代组合（r1-P1-6——访客
        // grant/revoke 即相关缓存失效，防「revoke 后仍命中旧 allow」）
        self.decide_l2(None, input, self.registry.snapshot(), visitors.generation())
            .await
    }

    /// L2 策略决策（design §8.2：static 无票必拒/有效票放行；callback 交
    /// webhook，无票同样交 = A_cb(S) 独立边界）。`visitor_generation` 入
    /// webhook 缓存复合键（owners+visitors 世代组合）
    async fn decide_l2(
        &self,
        capability: Option<&RelayCap>,
        input: &GateInput,
        snapshot: RegistrySnapshot,
        visitor_generation: u64,
    ) -> GateDecision {
        match &self.policy {
            Policy::Static => match capability {
                None => GateDecision::Deny(Cow::Borrowed(CapDeny::NoCapability.reason())),
                Some(_) => GateDecision::Allow,
            },
            Policy::Callback(provider) => {
                let decision = provider
                    .decide(
                        &input.endpoint_id,
                        capability,
                        input.connection_id,
                        snapshot.generation(),
                        visitor_generation,
                    )
                    .await;
                if decision.allow {
                    GateDecision::Allow
                } else {
                    GateDecision::Deny(Cow::Owned(decision.reason))
                }
            }
        }
    }

    /// on_disconnect 钩子：在线名额释放（租户与访客按归属分流）+ callback
    /// 模式转发 best-effort 观察通知；static 模式后者为空实现（design §8.5）
    pub fn on_disconnect(&self, endpoint_id: [u8; 32], connection_id: u64) {
        self.online.release(endpoint_id, connection_id);
        if let Policy::Callback(provider) = &self.policy {
            provider.notify_disconnect(&endpoint_id, connection_id);
        }
    }

    /// 敲门台账写入（KnockLog 的**唯一生产入口** = relay Deny 臂；E1 握手
    /// 认证身份——rendezvous 面身份不可信不入账，r1-P0-1 红线）。
    /// `dweb/blocked` 排除在 KnockLog 内部处理（已被处置，不是待办）。
    pub fn record_knock(&self, endpoint_id: [u8; 32], reason: &str) {
        self.knocks.record(endpoint_id, reason, now_ms());
    }

    /// 敲门台账只读句柄（Phase 1c `GET /admin/knocks` 消费）
    pub fn knock_log(&self) -> &KnockLog {
        &self.knocks
    }

    /// registry 热重载后的缓存清理（generation 已在缓存键内保证正确性，
    /// 此调用只释放容量；见 callback.rs invalidate_all）
    pub fn invalidate_callback_cache(&self) {
        if let Policy::Callback(provider) = &self.policy {
            provider.invalidate_all();
        }
    }

    /// per-owner 连接配额（admin status 透出；None = 无上限）
    pub fn max_connections_per_owner(&self) -> Option<usize> {
        self.max_connections_per_owner
    }

    /// 票接入在线表只读投影（GET /admin/status；task 3.1/3.2）
    pub fn online_view(&self) -> OnlineView {
        self.online.view()
    }

    /// callback 决策缓存条目数（admin status；static 恒 0）
    pub fn cache_entries(&self) -> usize {
        match &self.policy {
            Policy::Static => 0,
            Policy::Callback(provider) => provider.cache_len(),
        }
    }
}

/// C0 凭证来源分类结果
enum Credential<'a> {
    /// 两个来源皆缺失：无票路径
    None,
    /// 声明了凭证但不可解析（malformed）
    Malformed,
    /// 可进入 L1 的令牌串
    Token(&'a str),
}

/// C0 凭证来源分类（R4 P1-6；design §8.2 图）：
/// - header：剥 Bearer 前缀（scheme 大小写不敏感、单空格——与 iroh-relay
///   auth_token() 的 split_once(' ') 同构）；非 Bearer 形态 / Bearer 空值
///   → Malformed
/// - query：值本身即令牌（无 Bearer 前缀）
/// - 任一存在但非 `dwebr1.` 前缀 → Malformed（绝不降级无票）
/// - 全部有效时 header 优先（与 auth_token() 的 header 优先序一致）
fn classify_credential<'a>(
    auth_header: Option<&'a str>,
    query_token: Option<&'a str>,
) -> Credential<'a> {
    let mut header_token: Option<&'a str> = None;
    if let Some(header) = auth_header {
        match strip_bearer(header) {
            Some("") | None => return Credential::Malformed,
            Some(token) => {
                if !token.starts_with(cap::TOKEN_PREFIX) {
                    return Credential::Malformed;
                }
                header_token = Some(token);
            }
        }
    }
    if let Some(query) = query_token
        && !query.starts_with(cap::TOKEN_PREFIX)
    {
        return Credential::Malformed;
    }
    match header_token.or(query_token) {
        Some(token) => Credential::Token(token),
        None => Credential::None,
    }
}

/// Bearer scheme 剥离（scheme 大小写不敏感；单空格分隔，同 auth_token()）
fn strip_bearer(value: &str) -> Option<&str> {
    let (scheme, rest) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("Bearer").then_some(rest)
}

/// mtime 热重载看护的台账抽象（r1-P1-5 统一矩阵：owners/visitors/blocklist
/// 共用同一看护循环与日志形态）
pub trait ReloadableLedger: Send + Sync {
    /// 从磁盘重载（失败保留旧快照并上抛，由看护决定重试节奏）
    fn reload_from_disk(&self) -> anyhow::Result<()>;
    /// 台账文件路径（stat 目标）
    fn ledger_path(&self) -> &std::path::Path;
    /// 日志标签（"owner registry" / "visitor registry" / "blocklist"）
    fn ledger_label(&self) -> &'static str;
    /// 当前世代（重载成功日志）
    fn ledger_generation(&self) -> u64;
    /// 当前条目数（重载成功日志）
    fn ledger_count(&self) -> usize;
}

impl ReloadableLedger for OwnerRegistry {
    fn reload_from_disk(&self) -> anyhow::Result<()> {
        self.reload()
    }
    fn ledger_path(&self) -> &std::path::Path {
        self.path()
    }
    fn ledger_label(&self) -> &'static str {
        "owner registry"
    }
    fn ledger_generation(&self) -> u64 {
        self.snapshot().generation()
    }
    fn ledger_count(&self) -> usize {
        self.snapshot().len()
    }
}

impl ReloadableLedger for VisitorRegistry {
    fn reload_from_disk(&self) -> anyhow::Result<()> {
        self.reload()
    }
    fn ledger_path(&self) -> &std::path::Path {
        self.path()
    }
    fn ledger_label(&self) -> &'static str {
        "visitor registry"
    }
    fn ledger_generation(&self) -> u64 {
        self.snapshot().generation()
    }
    fn ledger_count(&self) -> usize {
        self.snapshot().len()
    }
}

impl ReloadableLedger for Blocklist {
    fn reload_from_disk(&self) -> anyhow::Result<()> {
        self.reload()
    }
    fn ledger_path(&self) -> &std::path::Path {
        self.path()
    }
    fn ledger_label(&self) -> &'static str {
        "blocklist"
    }
    fn ledger_generation(&self) -> u64 {
        self.snapshot().generation()
    }
    fn ledger_count(&self) -> usize {
        self.snapshot().len()
    }
}

/// 台账热重载看护（原 task 1.5 owners 专用看护的泛化，Phase 1a 三台账
/// 共用）：mtime+len 轮询（5s 间隔，跨平台实现简单——SIGHUP 不便携），
/// 文件变化即 reload（快照替换 + generation+1）并清 callback 缓存容量。
/// 重载失败（admin 正在写/坏行）保留旧快照，stat 再变化时重试。
pub fn spawn_ledger_reload_watcher<L: ReloadableLedger + 'static>(
    ledger: Arc<L>,
    gate: Option<Arc<AccessGate>>,
) -> tokio::task::JoinHandle<()> {
    spawn_ledger_reload_watcher_every(ledger, gate, std::time::Duration::from_secs(5))
}

/// 可配间隔版本（单测用 50ms 级间隔验证轮换语义）
pub fn spawn_ledger_reload_watcher_every<L: ReloadableLedger + 'static>(
    ledger: Arc<L>,
    gate: Option<Arc<AccessGate>>,
    interval: std::time::Duration,
) -> tokio::task::JoinHandle<()> {
    let path = ledger.ledger_path().to_path_buf();
    let label = ledger.ledger_label();
    tokio::spawn(async move {
        let mut last = stat_of(&path);
        loop {
            tokio::time::sleep(interval).await;
            let current = stat_of(&path);
            if current == last {
                continue;
            }
            last = current;
            match ledger.reload_from_disk() {
                Ok(()) => {
                    tracing::info!(
                        generation = ledger.ledger_generation(),
                        entries = ledger.ledger_count(),
                        "{label} reloaded"
                    );
                    if let Some(gate) = &gate {
                        gate.invalidate_callback_cache();
                    }
                }
                Err(e) => {
                    tracing::warn!("{label} reload failed (keeping previous snapshot): {e:#}");
                }
            }
        }
    })
}

/// (mtime, len) 文件指纹；None = 文件缺失（也是可观察状态：文件被删除
/// → reload 得空集合，fail-closed）
fn stat_of(path: &std::path::Path) -> Option<(std::time::SystemTime, u64)> {
    std::fs::metadata(path).ok().map(|m| {
        (
            m.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            m.len(),
        )
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::cap::{CAP_KNOWN_MASK, CAP_RDZ_ANNOUNCE, CAP_RDZ_RESOLVE, sign_and_encode};
    use ed25519_dalek::SigningKey;
    use tempfile::TempDir;

    /// 票据 TTL（验证使用真实时钟，见 Fixture 说明）
    const TTL: u64 = 3_600_000;

    struct Fixture {
        issuer: SigningKey,
        server_id: [u8; 32],
        fabric_id: [u8; 32],
        recipient: [u8; 32],
        registry: Arc<OwnerRegistry>,
    }

    impl Fixture {
        /// 构造 static 策略 gate + 已注册 (fabric, issuer) 的 registry。
        /// 注意：decide 走真实时钟，票以 now_ms() 为基准签发（TTL 1h，
        /// 测试运行远小于 TTL）。
        fn new() -> (Self, AccessGate) {
            let dir = TempDir::new().unwrap();
            let registry = Arc::new(OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap());
            let f = Self {
                issuer: SigningKey::from_bytes(&[1u8; 32]),
                server_id: [2u8; 32],
                fabric_id: [3u8; 32],
                recipient: [4u8; 32],
                registry: registry.clone(),
            };
            f.registry.register(&f.fabric_id, &f.issuer_key()).unwrap();
            let gate = AccessGate::new(f.server_id, registry, PolicyConfig::Static).unwrap();
            (f, gate)
        }

        /// issuer 公钥字节（= registry 二元组的 root 维）
        fn issuer_key(&self) -> [u8; 32] {
            self.issuer.verifying_key().to_bytes()
        }

        fn token(&self, caps: u8, issued: u64, expires: u64) -> String {
            sign_and_encode(
                &self.issuer,
                &self.fabric_id,
                &self.server_id,
                &self.recipient,
                caps,
                issued,
                expires,
            )
        }

        fn valid_token(&self) -> String {
            let now = now_ms();
            self.token(CAP_RELAY, now, now + TTL)
        }

        fn input(&self, header: Option<&str>, query: Option<&str>) -> GateInput {
            GateInput {
                endpoint_id: self.recipient,
                auth_header: header.map(str::to_owned),
                query_token: query.map(str::to_owned),
                connection_id: 1,
                op: Op::RelayConnect,
            }
        }
    }

    fn deny_reason(d: GateDecision) -> String {
        match d {
            GateDecision::Deny(r) => r.into_owned(),
            GateDecision::Allow => panic!("expected deny"),
        }
    }

    // ---- C0 凭证来源分类矩阵（R4 P1-6 / spec Scenario「拒绝原因按失败
    // 环节区分」的 malformed 行）----

    #[tokio::test]
    async fn c0_no_credential_static_denies_no_capability() {
        let (f, gate) = Fixture::new();
        let d = gate.decide(&f.input(None, None)).await;
        assert_eq!(deny_reason(d), "dweb/no-capability");
    }

    #[tokio::test]
    async fn c0_malformed_header_forms_never_downgrade() {
        let (f, gate) = Fixture::new();
        for header in [
            "Basic dXNlcjpwYXNz",       // 非 Bearer scheme
            "Bearer",                   // 无空格无值
            "Bearer ",                  // Bearer 空值
            "bearer",                   // 小写 scheme 但无值
            "Bearer dwebr2.abcdef",     // 非 dwebr1. 前缀
            "Bearer not-a-token",       // 非 dwebr1. 前缀
            "Bearer dwebr1.",           // 前缀但空 payload
            "\u{FFFD}\u{FFFD}",         // 非 UTF-8 lossy 形态（无 Bearer）
            "Bearer dwebr1.\u{FFFD}zz", // 非 UTF-8 落 payload
            "Bearer DWEBR1.AAAA",       // 前缀大小写敏感（非 dwebr1.）
        ] {
            let d = gate.decide(&f.input(Some(header), None)).await;
            assert_eq!(
                deny_reason(d),
                "dweb/malformed-capability",
                "header {header:?}"
            );
        }
        // 声明了坏凭证绝不进无票路径（无票 reason 是 no-capability）
        let d = gate.decide(&f.input(Some("garbage"), None)).await;
        assert_ne!(deny_reason(d), "dweb/no-capability");
        // 超长（> 1KiB 长度门在 decode；C0 前缀先行）
        let long = format!("Bearer {}", "x".repeat(2048));
        let d = gate.decide(&f.input(Some(&long), None)).await;
        assert_eq!(deny_reason(d), "dweb/malformed-capability");
    }

    #[tokio::test]
    async fn c0_query_token_variants() {
        let (f, gate) = Fixture::new();
        let valid = f.valid_token();
        // query 直取（无 Bearer 前缀）→ 放行
        let d = gate.decide(&f.input(None, Some(&valid))).await;
        assert_eq!(d, GateDecision::Allow);
        // 非法 query 值 → malformed（不降级）
        for query in ["", "zzz", "dwebr2.abc", "dwebr1.short"] {
            let d = gate.decide(&f.input(None, Some(query))).await;
            assert_eq!(
                deny_reason(d),
                "dweb/malformed-capability",
                "query {query:?}"
            );
        }
    }

    #[tokio::test]
    async fn c0_header_wins_and_any_invalid_source_is_malformed() {
        let (f, gate) = Fixture::new();
        let valid = f.valid_token();
        // header 有效 + query 有效：header 优先，放行
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {valid}")), Some(&valid)))
            .await;
        assert_eq!(d, GateDecision::Allow);
        // header 有效 + query 非法：任一存在但非法 → malformed（严格语义）
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {valid}")), Some("junk")))
            .await;
        assert_eq!(deny_reason(d), "dweb/malformed-capability");
        // 大小写不敏感 Bearer scheme
        let d = gate
            .decide(&f.input(Some(&format!("bEaReR {valid}")), None))
            .await;
        assert_eq!(d, GateDecision::Allow);
    }

    // ---- L1 链路（经 gate 端到端；单条款边界由 cap.rs 覆盖）----

    #[tokio::test]
    async fn l1_valid_token_allows_in_static_mode() {
        let (f, gate) = Fixture::new();
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {}", f.valid_token())), None))
            .await;
        assert_eq!(d, GateDecision::Allow);
    }

    #[tokio::test]
    async fn l1_deny_reasons_through_gate() {
        let (f, gate) = Fixture::new();
        let now = now_ms();

        // bad-signature：形态完好但翻转一个 base64url 字符（字符集保持合法）
        let mut tampered = f.valid_token().into_bytes();
        tampered[100] = if tampered[100] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {tampered}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/bad-signature");

        // wrong-server：票指向别的 ServerId
        let wrong = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &[0xAA; 32],
            &f.recipient,
            CAP_RELAY,
            now,
            now + TTL,
        );
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {wrong}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/wrong-server");

        // not-recipient：recipient ≠ 握手身份（A2 窃取令牌串场景）
        let stolen = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &f.server_id,
            &[0xCC; 32],
            CAP_RELAY,
            now,
            now + TTL,
        );
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {stolen}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/not-recipient");

        // capability-expired：过期票
        let expired = f.token(CAP_RELAY, now - 7_200_000, now - 3_600_000);
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {expired}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/capability-expired");

        // caps-unsupported：保留位（签名有效）
        let reserved = f.token(CAP_RELAY | 0x80, now, now + TTL);
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {reserved}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/caps-unsupported");
    }

    // ---- L1b（registry 二元组 + op caps 位；不可插拔底线）----

    #[tokio::test]
    async fn l1b_unknown_owner_before_caps_missing() {
        let (f, gate) = Fixture::new();
        // 未注册 fabric（fabric_id 不同）且缺 RELAY 位：B1 先于 B2
        let token = sign_and_encode(
            &f.issuer,
            &[0x77; 32],
            &f.server_id,
            &f.recipient,
            CAP_RDZ_ANNOUNCE | CAP_RDZ_RESOLVE,
            now_ms(),
            now_ms() + TTL,
        );
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {token}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/unknown-owner");
    }

    #[tokio::test]
    async fn l1b_caps_missing_relay() {
        let (f, gate) = Fixture::new();
        // 已注册 owner、仅 RDZ 位的票 → caps-missing-relay
        let token = f.token(CAP_RDZ_ANNOUNCE | CAP_RDZ_RESOLVE, now_ms(), now_ms() + TTL);
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {token}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/caps-missing-relay");
        // 全位票（含 RELAY）放行
        let full = f.token(CAP_KNOWN_MASK, now_ms(), now_ms() + TTL);
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {full}")), None))
            .await;
        assert_eq!(d, GateDecision::Allow);
    }

    #[tokio::test]
    async fn l1b_registry_unregister_blocks_new_connections() {
        // unregister 后新连接即时拒绝（spec Scenario「unregister 阻断新连接」）
        let (f, gate) = Fixture::new();
        let input = f.input(Some(&format!("Bearer {}", f.valid_token())), None);
        assert_eq!(gate.decide(&input).await, GateDecision::Allow);
        f.registry
            .unregister(&f.fabric_id, &f.issuer_key())
            .unwrap();
        assert_eq!(deny_reason(gate.decide(&input).await), "dweb/unknown-owner");
    }

    // ---- rendezvous Op（task 1.6，design §8.4：announce 绑定 / resolve bearer-only）----

    /// L1b B2：rdz 两面的缺位 slug（与 caps-missing-relay 同构生成）
    #[tokio::test]
    async fn rdz_ops_caps_missing_slugs() {
        let (f, gate) = Fixture::new();
        let now = now_ms();
        // announce 面：票仅含 RDZ_RESOLVE → caps-missing-rdz-announce
        let token = f.token(CAP_RDZ_RESOLVE, now, now + TTL);
        let input = GateInput {
            endpoint_id: f.recipient,
            auth_header: Some(format!("Bearer {token}")),
            query_token: None,
            connection_id: 0,
            op: Op::RdzAnnounce,
        };
        let d = gate.decide(&input).await;
        assert_eq!(deny_reason(d), "dweb/caps-missing-rdz-announce");
    }

    #[tokio::test]
    async fn rdz_ops_caps_missing_slugs_resolve() {
        let (f, gate) = Fixture::new();
        let now = now_ms();
        // resolve 面：票仅含 RDZ_ANNOUNCE → caps-missing-rdz-resolve
        // （GateInput.op 换面——endpoint_id 字段对 resolve 的 C7 无意义，
        // 这里传 recipient 保持其余链路恒定）
        let token = f.token(CAP_RDZ_ANNOUNCE, now, now + TTL);
        let input = GateInput {
            endpoint_id: f.recipient,
            auth_header: Some(format!("Bearer {token}")),
            query_token: None,
            connection_id: 0,
            op: Op::RdzResolve,
        };
        let d = gate.decide(&input).await;
        assert_eq!(deny_reason(d), "dweb/caps-missing-rdz-resolve");
    }

    /// announce 面 C7 绑定（零成本 PoP）：cap.recipient ≠ 签名 EndpointId
    /// → not-recipient（窃取 token 者无对应私钥无法 announce 任意身份）
    #[tokio::test]
    async fn rdz_announce_binds_recipient_to_signed_endpoint() {
        let (f, gate) = Fixture::new();
        let now = now_ms();
        let signed_by_other = [0x55; 32];
        let token = f.token(CAP_RDZ_ANNOUNCE, now, now + TTL);
        let input = GateInput {
            endpoint_id: signed_by_other,
            auth_header: Some(format!("Bearer {token}")),
            query_token: None,
            connection_id: 0,
            op: Op::RdzAnnounce,
        };
        let d = gate.decide(&input).await;
        assert_eq!(deny_reason(d), "dweb/not-recipient");
        // recipient == 签名者 → 过 C7（后续链路放行）
        let input = GateInput {
            endpoint_id: f.recipient,
            auth_header: Some(format!(
                "Bearer {}",
                f.token(CAP_RDZ_ANNOUNCE, now, now + TTL)
            )),
            query_token: None,
            connection_id: 0,
            op: Op::RdzAnnounce,
        };
        assert_eq!(gate.decide(&input).await, GateDecision::Allow);
    }

    /// resolve 面 bearer-only（design §8.4 / R4 P1-7）：无握手身份，
    /// C7 不适用——recipient 与请求身份无关联（自洽通过），仅验密码学
    /// 有效性；static L2 对有效票放行
    #[tokio::test]
    async fn rdz_resolve_bearer_only_skips_c7() {
        let (f, gate) = Fixture::new();
        let now = now_ms();
        let token = f.token(CAP_RDZ_RESOLVE, now, now + TTL);
        // 任意「请求方身份」（这里取解析目标 id，与 recipient 无关）
        let unrelated_target = [0x77; 32];
        let input = GateInput {
            endpoint_id: unrelated_target,
            auth_header: Some(format!("Bearer {token}")),
            query_token: None,
            connection_id: 0,
            op: Op::RdzResolve,
        };
        assert_eq!(gate.decide(&input).await, GateDecision::Allow);
        // 对照：同票换 relay 面 op → C7 生效（unrelated_target ≠ recipient）
        let input = GateInput {
            op: Op::RelayConnect,
            ..input
        };
        let d = gate.decide(&input).await;
        assert_eq!(deny_reason(d), "dweb/not-recipient");
        // 无票 resolve 在 static 策略下仍拒（no-capability）
        let input = GateInput {
            auth_header: None,
            query_token: None,
            op: Op::RdzResolve,
            ..input
        };
        let d = gate.decide(&input).await;
        assert_eq!(deny_reason(d), "dweb/no-capability");
    }

    #[tokio::test]
    async fn l1b_registry_reload_from_disk_swaps_snapshot() {
        // 外部进程写文件（CLI owners register）→ reload → 快照替换 + generation 递增
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let registry = Arc::new(OwnerRegistry::load(&path).unwrap());
        let g0 = registry.snapshot().generation();
        let line = format!(
            "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":1}}\n",
            "11".repeat(32),
            "22".repeat(32)
        );
        std::fs::write(&path, line).unwrap();
        registry.reload().unwrap();
        let snap = registry.snapshot();
        assert!(snap.contains(&[0x11; 32], &[0x22; 32]));
        assert!(snap.generation() > g0, "reload 后 generation 递增");
        // 坏文件 reload 失败保留旧快照
        std::fs::write(&path, "broken\n").unwrap();
        assert!(registry.reload().is_err());
        assert!(
            registry.snapshot().contains(&[0x11; 32], &[0x22; 32]),
            "失败重载不破坏当前快照"
        );
        // 文件删除 → 空集合（fail-closed）
        std::fs::remove_file(&path).unwrap();
        registry.reload().unwrap();
        assert!(registry.snapshot().is_empty());
    }

    #[tokio::test]
    async fn reload_watcher_polls_file_changes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("owners.jsonl");
        let registry = Arc::new(OwnerRegistry::load(&path).unwrap());
        let handle = spawn_ledger_reload_watcher_every(
            registry.clone(),
            None,
            std::time::Duration::from_millis(30),
        );
        // 等 watcher 完成首次 stat 后再写文件（避免写入发生在首次 stat 前
        // 被当作初始状态）
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        let line = format!(
            "{{\"op\":\"register\",\"fabric_id\":\"{}\",\"root\":\"{}\",\"ts\":1}}\n",
            "33".repeat(32),
            "44".repeat(32)
        );
        std::fs::write(&path, line).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if registry.snapshot().contains(&[0x33; 32], &[0x44; 32]) {
                handle.abort();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        handle.abort();
        panic!("watcher 未在 2s 内观测到文件变化并重载");
    }

    // ---- L2 callback 联动（gate 层；协议矩阵由 callback.rs 覆盖）----

    /// callback webhook 配置（不缓存，便于逐次断言回调计数）
    fn cb_cfg(url: String) -> crate::access::config::CallbackConfig {
        crate::access::config::CallbackConfig {
            url,
            token: "t".into(),
            timeout_ms: 2000,
            cache_ttl_ms: 0,
            max_concurrency: 8,
            per_source: 8,
            queue: 16,
            allow_loopback: true,
        }
    }

    #[tokio::test]
    async fn l2_callback_no_ticket_goes_to_webhook_and_invalid_ticket_does_not() {
        let (f, _gate) = Fixture::new();
        let mock = callback_mock_json(r#"{"allow":true}"#).await;
        let gate = AccessGate::new(
            f.server_id,
            f.registry.clone(),
            PolicyConfig::Callback(cb_cfg(mock.url.clone())),
        )
        .unwrap();
        // 无票：webhook allow=true → Allow（A_cb(S) 边界，spec Scenario）
        assert_eq!(gate.decide(&f.input(None, None)).await, GateDecision::Allow);
        // 无效票到不了 webhook（L1/L1b 不豁免）：缺 RELAY 位
        let rdz_only = f.token(CAP_RDZ_ANNOUNCE, now_ms(), now_ms() + TTL);
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {rdz_only}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/caps-missing-relay");
        assert_eq!(
            mock.count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "无效票不触发 webhook（L1/L1b 不豁免）"
        );
        // 未注册 owner 的票同样到不了 webhook（impostor issuer）
        let impostor = sign_and_encode(
            &SigningKey::from_bytes(&[9u8; 32]),
            &f.fabric_id,
            &f.server_id,
            &f.recipient,
            CAP_RELAY,
            now_ms(),
            now_ms() + TTL,
        );
        let d = gate
            .decide(&f.input(Some(&format!("Bearer {impostor}")), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/unknown-owner");
        assert_eq!(mock.count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn l2_callback_valid_ticket_allowed_and_custom_deny_reason() {
        let (f, _gate) = Fixture::new();
        let allow_mock = callback_mock_json(r#"{"allow":true}"#).await;
        let gate = AccessGate::new(
            f.server_id,
            f.registry.clone(),
            PolicyConfig::Callback(cb_cfg(allow_mock.url.clone())),
        )
        .unwrap();
        assert_eq!(
            gate.decide(&f.input(Some(&format!("Bearer {}", f.valid_token())), None))
                .await,
            GateDecision::Allow
        );
        // deny + 自定义 reason 透传（spec Scenario「webhook 拒绝并透出自定义 reason」）
        let deny_mock =
            callback_mock_json(r#"{"allow":false,"reason":"dweb/quota-exceeded"}"#).await;
        let gate2 = AccessGate::new(
            f.server_id,
            f.registry.clone(),
            PolicyConfig::Callback(cb_cfg(deny_mock.url.clone())),
        )
        .unwrap();
        let d = gate2
            .decide(&f.input(Some(&format!("Bearer {}", f.valid_token())), None))
            .await;
        assert_eq!(deny_reason(d), "dweb/quota-exceeded");
    }

    #[test]
    fn gate_construction_fail_fast_on_bad_callback_url() {
        let (f, _gate) = Fixture::new();
        let mut cfg = cb_cfg("http://hooks.example.com".into());
        cfg.allow_loopback = false; // http 未豁免
        let err = AccessGate::new(f.server_id, f.registry.clone(), PolicyConfig::Callback(cfg));
        assert!(err.is_err(), "callback URL 非法必须构造期 fail-fast");
    }

    /// 极简 webhook mock（gate 联动用；协议矩阵在 callback.rs）
    struct MockHook {
        url: String,
        count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    async fn callback_mock_json(body: &str) -> MockHook {
        use axum::routing::post;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = count.clone();
        let body = body.to_string();
        let app = axum::Router::new().route(
            "/hook",
            post(move || {
                let c = c2.clone();
                let body = body.clone();
                async move {
                    c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    axum::Json(serde_json::from_str::<serde_json::Value>(&body).unwrap())
                }
            }),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        MockHook {
            url: format!("http://127.0.0.1:{port}/hook"),
            count,
        }
    }

    // ---- per-owner 连接配额（task 3.2 前半）----

    /// 配额 fixture：static 策略 + limit 已设；带可变 connection_id 的输入
    fn quota_input(f: &Fixture, recipient: [u8; 32], connection_id: u64) -> GateInput {
        let now = now_ms();
        let token = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &f.server_id,
            &recipient,
            CAP_RELAY,
            now,
            now + TTL,
        );
        GateInput {
            endpoint_id: recipient,
            auth_header: Some(format!("Bearer {token}")),
            query_token: None,
            connection_id,
            op: Op::RelayConnect,
        }
    }

    /// 同 owner（同 fabric）第二条连接超限 deny；断连释放后名额恢复
    #[tokio::test]
    async fn quota_exceeded_and_release_restores_slot() {
        let (f, gate) = Fixture::new();
        let gate = gate.with_max_connections_per_owner(Some(1));
        let a = f.recipient;
        let b = [0xCC; 32];
        // 连接 1（endpoint A）→ Allow（占用唯一名额）
        assert_eq!(
            gate.decide(&quota_input(&f, a, 1)).await,
            GateDecision::Allow
        );
        // 连接 2（endpoint B，同 owner 票）→ 超限 deny
        assert_eq!(
            gate.decide(&quota_input(&f, b, 2)).await,
            GateDecision::Deny(Cow::Borrowed(OWNER_QUOTA_EXCEEDED))
        );
        // status 投影：恰一条在线（deny 不占名额）
        let view = gate.online_view();
        assert_eq!(view.per_owner, vec![(f.fabric_id, 1)]);
        assert_eq!(view.per_endpoint.len(), 1);
        assert_eq!(view.per_endpoint[0].endpoint_id, a);
        // 断连连接 1 → 名额恢复 → 新连接放行
        gate.on_disconnect(a, 1);
        assert_eq!(gate.online_view().per_owner, vec![]);
        assert_eq!(
            gate.decide(&quota_input(&f, b, 3)).await,
            GateDecision::Allow
        );
    }

    /// 不同 owner（不同 fabric）互不挤占；同 endpoint 多连接按条计数
    #[tokio::test]
    async fn quota_isolated_per_owner_and_counts_per_connection() {
        let (f, gate) = Fixture::new();
        let gate = gate.with_max_connections_per_owner(Some(2));
        // owner 2：另一 fabric 的已注册 issuer
        let issuer2 = SigningKey::from_bytes(&[0x71; 32]);
        let fabric2 = [0x72; 32];
        f.registry
            .register(&fabric2, &issuer2.verifying_key().to_bytes())
            .unwrap();
        let now = now_ms();
        let token2 = sign_and_encode(
            &issuer2,
            &fabric2,
            &f.server_id,
            &f.recipient,
            CAP_RELAY,
            now,
            now + TTL,
        );
        // owner1 两条（同 endpoint 不同 connection_id，各自计数）→ 满
        assert_eq!(
            gate.decide(&quota_input(&f, f.recipient, 1)).await,
            GateDecision::Allow
        );
        assert_eq!(
            gate.decide(&quota_input(&f, f.recipient, 2)).await,
            GateDecision::Allow
        );
        assert_eq!(
            gate.decide(&quota_input(&f, f.recipient, 3)).await,
            GateDecision::Deny(Cow::Borrowed(OWNER_QUOTA_EXCEEDED))
        );
        // owner2 名额独立（owner1 满 不影响）
        let input2 = GateInput {
            endpoint_id: f.recipient,
            auth_header: Some(format!("Bearer {token2}")),
            query_token: None,
            connection_id: 4,
            op: Op::RelayConnect,
        };
        assert_eq!(gate.decide(&input2).await, GateDecision::Allow);
        // 释放 owner1 一条 → 恢复
        gate.on_disconnect(f.recipient, 1);
        assert_eq!(
            gate.decide(&quota_input(&f, f.recipient, 5)).await,
            GateDecision::Allow
        );
        // 幂等释放：同键二次 release 零副作用（不误减 owner2）
        gate.on_disconnect(f.recipient, 1);
        let view = gate.online_view();
        assert!(view.per_owner.contains(&(f.fabric_id, 2)));
        assert!(view.per_owner.contains(&(fabric2, 1)));
    }

    /// 默认无上限；无票接入不占 owner 配额；rendezvous Op 不占连接名额
    #[tokio::test]
    async fn quota_default_unlimited_and_no_ticket_rdz_exempt() {
        // 默认（无上限）：同 owner 连打多条全部放行
        let (f, gate) = Fixture::new();
        for conn in 1..=5u64 {
            assert_eq!(
                gate.decide(&quota_input(&f, f.recipient, conn)).await,
                GateDecision::Allow
            );
        }
        assert_eq!(gate.max_connections_per_owner(), None);
        assert_eq!(gate.cache_entries(), 0, "static 策略缓存恒空");

        // callback 模式 + 配额 1：无票端点被 webhook 放行（A_cb）不占
        // owner 名额——随后同 owner 票接入仍可用
        let mock = callback_mock_json(r#"{"allow":true}"#).await;
        let gate = AccessGate::new(
            f.server_id,
            f.registry.clone(),
            PolicyConfig::Callback(cb_cfg(mock.url.clone())),
        )
        .unwrap()
        .with_max_connections_per_owner(Some(1));
        let no_ticket = GateInput {
            endpoint_id: [0xDD; 32],
            auth_header: None,
            query_token: None,
            connection_id: 100,
            op: Op::RelayConnect,
        };
        assert_eq!(gate.decide(&no_ticket).await, GateDecision::Allow);
        assert_eq!(
            gate.decide(&quota_input(&f, f.recipient, 101)).await,
            GateDecision::Allow,
            "无票 A_cb 接入不占 owner 维度配额"
        );

        // rendezvous Op（announce）：无状态 HTTP 请求不占连接名额
        let announce_input = GateInput {
            endpoint_id: f.recipient,
            auth_header: Some(format!(
                "Bearer {}",
                f.token(CAP_RDZ_ANNOUNCE, now_ms(), now_ms() + TTL)
            )),
            query_token: None,
            connection_id: 0,
            op: Op::RdzAnnounce,
        };
        assert_eq!(gate.decide(&announce_input).await, GateDecision::Allow);
        assert_eq!(
            gate.decide(&quota_input(&f, f.recipient, 102)).await,
            GateDecision::Deny(Cow::Borrowed(OWNER_QUOTA_EXCEEDED)),
            "announce 不占名额：owner 唯一名额仍被 101 占用"
        );
    }

    /// L2 deny（webhook 拒绝）必须回滚预约——deny 连接不注册、
    /// on_disconnect 永不触发，不回滚即泄漏名额
    #[tokio::test]
    async fn quota_reservation_rolled_back_on_l2_deny() {
        let (f, _gate) = Fixture::new();
        let deny_mock = callback_mock_json(r#"{"allow":false,"reason":"dweb/e2e-denied"}"#).await;
        let gate = AccessGate::new(
            f.server_id,
            f.registry.clone(),
            PolicyConfig::Callback(cb_cfg(deny_mock.url.clone())),
        )
        .unwrap()
        .with_max_connections_per_owner(Some(1));
        // webhook deny（cb_cfg cache_ttl_ms=0：deny 不入缓存）→ 名额未占用
        for (endpoint, conn) in [(f.recipient, 1u64), ([0xEE; 32], 2u64)] {
            let d = gate.decide(&quota_input(&f, endpoint, conn)).await;
            assert_eq!(deny_reason(d), "dweb/e2e-denied");
        }
        assert_eq!(
            gate.online_view().per_owner,
            vec![],
            "L2 deny 不留预约（否则唯一名额被永久泄漏）"
        );
        assert_eq!(
            gate.online_view().per_endpoint,
            vec![],
            "endpoint 维度同样无残留"
        );
    }

    #[test]
    fn online_view_mixed_fabric_endpoint_is_per_pair_deterministic() {
        // r3-P1-3 回归：同 endpoint 持两个 fabric 的连接——view 必须逐对成条
        // 且 (endpoint_id, fabric_id) 双键字典序，杜绝 first() 类 HashMap 序
        // 聚合；per_owner 两 fabric 计数独立。
        let (f, gate) = Fixture::new();
        let other_fabric = [0x77; 32];
        let e = f.recipient;
        // 同 endpoint 两条连接分属两 fabric（recipient 复用两个 owner 的票）
        assert!(gate.online.reserve(&f.fabric_id, e, 1, None));
        assert!(gate.online.reserve(&other_fabric, e, 2, None));
        let view = gate.online_view();
        assert_eq!(view.per_endpoint.len(), 2, "per-(endpoint,fabric) 对成条");
        let fabrics: Vec<[u8; 32]> = view.per_endpoint.iter().map(|x| x.fabric_id).collect();
        let mut sorted = fabrics.clone();
        sorted.sort();
        assert_eq!(fabrics, sorted, "同 endpoint 内按 fabric_id 字典序");
        assert!(view.per_endpoint.iter().all(|x| x.connections == 1));
        assert!(view.per_owner.contains(&(f.fabric_id, 1)));
        assert!(view.per_owner.contains(&(other_fabric, 1)));
    }

    // ---- server-access-roles Phase 1a：访客名册 / 黑名单 / owner-expired /
    // 访客配额 / 复合缓存 generation ----

    /// Phase 1a 测试 fixture：带 visitors/blocklist 台账的 gate 构造器
    /// （`_dir` 持有 TempDir 存活——台账文件在 fixture 生命周期内可写）
    struct Phase1aFixture {
        _dir: TempDir,
        visitors: Arc<VisitorRegistry>,
        blocklist: Arc<Blocklist>,
    }

    impl Phase1aFixture {
        fn new() -> Self {
            let dir = TempDir::new().unwrap();
            Self {
                visitors: Arc::new(
                    VisitorRegistry::load(&dir.path().join("visitors.jsonl")).unwrap(),
                ),
                blocklist: Arc::new(Blocklist::load(&dir.path().join("blocklist.jsonl")).unwrap()),
                _dir: dir,
            }
        }

        fn gate(&self, f: &Fixture, policy: PolicyConfig) -> AccessGate {
            AccessGate::new(f.server_id, f.registry.clone(), policy)
                .unwrap()
                .with_visitor_ledger(std::sync::Arc::clone(&self.visitors))
                .with_blocklist(std::sync::Arc::clone(&self.blocklist))
        }

        fn no_ticket(&self, endpoint: [u8; 32], connection_id: u64) -> GateInput {
            GateInput {
                endpoint_id: endpoint,
                auth_header: None,
                query_token: None,
                connection_id,
                op: Op::RelayConnect,
            }
        }
    }

    /// 访客矩阵（spec Scenario「访客裁决次序——名册先于 webhook」「访客过期
    /// 或吊销后回落原路径」）：命中放行不咨询 webhook；过期/吊销回落
    #[tokio::test]
    async fn visitor_matrix_hit_expiry_revoke_and_fallthrough() {
        let (f, _gate) = Fixture::new();
        let p1a = Phase1aFixture::new();
        // callback 策略 + webhook 恒 deny：验证「名册先于 webhook」
        let mock = callback_mock_json(r#"{"allow":false,"reason":"dweb/cb-no"}"#).await;
        let gate = p1a.gate(&f, PolicyConfig::Callback(cb_cfg(mock.url.clone())));

        let visitor = [0xE1; 32];
        // 未授予：无票 → webhook 裁决（次序 ③，reason 透传）
        assert_eq!(
            deny_reason(gate.decide(&p1a.no_ticket(visitor, 1)).await),
            "dweb/cb-no"
        );
        assert_eq!(mock.count.load(std::sync::atomic::Ordering::SeqCst), 1);

        // 授予：无票 → 放行，webhook 不被咨询（次序 ② 先于 ③）
        p1a.visitors
            .grant(
                &visitor,
                Some("guest".into()),
                None,
                Some(now_ms() + 3_600_000),
            )
            .unwrap();
        assert_eq!(
            gate.decide(&p1a.no_ticket(visitor, 2)).await,
            GateDecision::Allow
        );
        assert_eq!(
            mock.count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "访客命中不咨询 webhook"
        );

        // 吊销：回落 webhook（再次计数）
        p1a.visitors.revoke(&visitor).unwrap();
        assert_eq!(
            deny_reason(gate.decide(&p1a.no_ticket(visitor, 3)).await),
            "dweb/cb-no"
        );
        assert_eq!(mock.count.load(std::sync::atomic::Ordering::SeqCst), 2);

        // 过期（文件入口 + reload）：static 策略下回落无票路径拒 no-capability
        let (f2, _gate2) = Fixture::new();
        let p1a2 = Phase1aFixture::new();
        let gate2 = p1a2.gate(&f2, PolicyConfig::Static);
        std::fs::write(
            p1a2.visitors.path(),
            format!(
                "{{\"op\":\"grant\",\"endpoint_id\":\"{}\",\"alias\":\"was\",\"ts\":1,\"expires_at\":100}}\n",
                "e2".repeat(32)
            ),
        )
        .unwrap();
        p1a2.visitors.reload().unwrap();
        assert_eq!(
            deny_reason(gate2.decide(&p1a2.no_ticket([0xE2; 32], 1)).await),
            "dweb/no-capability",
            "过期访客按无票路径拒绝（static）"
        );
    }

    /// 访客准入仅 relay 面：rendezvous op 的无票请求恒拒（design §1.6 可达
    /// 面 v1 冻结为空）
    #[tokio::test]
    async fn visitor_admission_is_relay_face_only() {
        let (f, _gate) = Fixture::new();
        let p1a = Phase1aFixture::new();
        let gate = p1a.gate(&f, PolicyConfig::Static);
        let visitor = [0xE3; 32];
        p1a.visitors.grant(&visitor, None, None, None).unwrap();
        assert_eq!(
            gate.decide(&p1a.no_ticket(visitor, 1)).await,
            GateDecision::Allow
        );
        let rdz_input = GateInput {
            endpoint_id: visitor,
            auth_header: None,
            query_token: None,
            connection_id: 0,
            op: Op::RdzAnnounce,
        };
        assert_eq!(
            deny_reason(gate.decide(&rdz_input).await),
            "dweb/no-capability"
        );
    }

    /// 访客两级配额：per-endpoint 超限拒；全局上限跨端点独立生效；访客不进
    /// 租户投影；释放恢复（spec Scenario「访客连接配额独立于租户配额」）
    #[tokio::test]
    async fn visitor_quotas_two_levels_and_isolated_projection() {
        let (f, _gate) = Fixture::new();
        let p1a = Phase1aFixture::new();
        let gate = p1a
            .gate(&f, PolicyConfig::Static)
            .with_visitor_quotas(2, 64);
        let a = [0xE4; 32];
        let b = [0xE5; 32];
        p1a.visitors.grant(&a, None, None, None).unwrap();
        p1a.visitors.grant(&b, None, None, None).unwrap();
        // per-endpoint 2：a 的第 3 条拒；b 独立不串扰
        assert_eq!(gate.decide(&p1a.no_ticket(a, 1)).await, GateDecision::Allow);
        assert_eq!(gate.decide(&p1a.no_ticket(a, 2)).await, GateDecision::Allow);
        assert_eq!(
            deny_reason(gate.decide(&p1a.no_ticket(a, 3)).await),
            VISITOR_QUOTA_EXCEEDED
        );
        assert_eq!(gate.decide(&p1a.no_ticket(b, 4)).await, GateDecision::Allow);
        // 投影：per_visitor 字典序，不进 per_endpoint/per_owner
        let view = gate.online_view();
        assert!(
            view.per_endpoint.is_empty(),
            "访客无 fabric 归属不进租户投影"
        );
        assert!(view.per_owner.is_empty());
        assert_eq!(view.per_visitor, vec![(a, 2), (b, 1)]);
        // 释放恢复（on_disconnect 按归属分流到访客表）
        gate.on_disconnect(a, 1);
        assert_eq!(gate.decide(&p1a.no_ticket(a, 5)).await, GateDecision::Allow);

        // 全局上限 3：第四条跨端点拒（防多 key 女巫聚合）
        let g2 = p1a
            .gate(&f, PolicyConfig::Static)
            .with_visitor_quotas(10, 3);
        let c = [0xE6; 32];
        p1a.visitors.grant(&c, None, None, None).unwrap();
        assert_eq!(g2.decide(&p1a.no_ticket(a, 11)).await, GateDecision::Allow);
        assert_eq!(g2.decide(&p1a.no_ticket(b, 12)).await, GateDecision::Allow);
        assert_eq!(g2.decide(&p1a.no_ticket(c, 13)).await, GateDecision::Allow);
        assert_eq!(
            deny_reason(g2.decide(&p1a.no_ticket(a, 14)).await),
            VISITOR_QUOTA_EXCEEDED,
            "全局访客上限独立于 per-endpoint"
        );
    }

    /// 反向独立：访客连接不受（也不占）per-owner 配额
    #[tokio::test]
    async fn visitor_connections_do_not_consume_owner_quota() {
        let (f, _gate) = Fixture::new();
        let p1a = Phase1aFixture::new();
        let gate = p1a
            .gate(&f, PolicyConfig::Static)
            .with_max_connections_per_owner(Some(1));
        let visitor = [0xE7; 32];
        p1a.visitors.grant(&visitor, None, None, None).unwrap();
        assert_eq!(
            gate.decide(&p1a.no_ticket(visitor, 1)).await,
            GateDecision::Allow
        );
        // owner 唯一名额不被访客占用
        assert_eq!(
            gate.decide(&quota_input(&f, f.recipient, 2)).await,
            GateDecision::Allow,
            "访客接入不占 per-owner 配额"
        );
        // owner 配额满后访客连接仍可用（反向独立）
        assert_eq!(
            deny_reason(gate.decide(&quota_input(&f, f.recipient, 3)).await),
            OWNER_QUOTA_EXCEEDED
        );
        assert_eq!(
            gate.decide(&p1a.no_ticket(visitor, 4)).await,
            GateDecision::Allow
        );
    }

    /// 黑名单矩阵（spec Scenario 全组）：endpoint 维度先于 C0（有效票不豁免、
    /// 坏凭证同吃 blocked）；fabric 维度 L1 后 L1b 前（L1 失败仍回密码学
    /// reason——验证链不回退）；解除后恢复
    #[tokio::test]
    async fn blocklist_endpoint_and_fabric_dimensions() {
        let (f, _gate) = Fixture::new();
        let p1a = Phase1aFixture::new();
        let gate = p1a.gate(&f, PolicyConfig::Static);
        let victim = f.recipient;

        // endpoint 维度：有效票 + 被拉黑 → dweb/blocked（不豁免）
        p1a.blocklist
            .add(BlockKind::Endpoint, &victim, Some("abuse".into()))
            .unwrap();
        let valid = f.valid_token();
        assert_eq!(
            deny_reason(
                gate.decide(&f.input(Some(&format!("Bearer {valid}")), None))
                    .await
            ),
            BLOCKED_REASON
        );
        // 坏凭证同样先吃 blocked（先于 C0——次序冻结）
        assert_eq!(
            deny_reason(gate.decide(&f.input(Some("garbage"), None)).await),
            BLOCKED_REASON
        );
        // 无票 + 被拉黑 → blocked（先于访客/callback 路径）
        assert_eq!(
            deny_reason(gate.decide(&p1a.no_ticket(victim, 1)).await),
            BLOCKED_REASON
        );
        // 解除 → 恢复放行
        p1a.blocklist.remove(BlockKind::Endpoint, &victim).unwrap();
        assert_eq!(
            gate.decide(&f.input(Some(&format!("Bearer {valid}")), None))
                .await,
            GateDecision::Allow
        );

        // fabric 维度：issuer fabric 拉黑 → 持有效票拒
        p1a.blocklist
            .add(BlockKind::Fabric, &f.fabric_id, None)
            .unwrap();
        assert_eq!(
            deny_reason(
                gate.decide(&f.input(Some(&format!("Bearer {valid}")), None))
                    .await
            ),
            BLOCKED_REASON
        );
        // L1 失败（坏签名）先于 fabric 维度：密码学 reason 不被掩盖
        let mut tampered = f.valid_token().into_bytes();
        tampered[100] = if tampered[100] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        assert_eq!(
            deny_reason(
                gate.decide(&f.input(Some(&format!("Bearer {tampered}")), None))
                    .await
            ),
            "dweb/bad-signature"
        );
        // 未拉黑 fabric 的票不受影响
        let issuer2 = SigningKey::from_bytes(&[0x71; 32]);
        let fabric2 = [0x72; 32];
        f.registry
            .register(&fabric2, &issuer2.verifying_key().to_bytes())
            .unwrap();
        let now = now_ms();
        let token2 = sign_and_encode(
            &issuer2,
            &fabric2,
            &f.server_id,
            &f.recipient,
            CAP_RELAY,
            now,
            now + TTL,
        );
        assert_eq!(
            gate.decide(&f.input(Some(&format!("Bearer {token2}")), None))
                .await,
            GateDecision::Allow
        );
        // 解除 → 恢复
        p1a.blocklist
            .remove(BlockKind::Fabric, &f.fabric_id)
            .unwrap();
        assert_eq!(
            gate.decide(&f.input(Some(&format!("Bearer {valid}")), None))
                .await,
            GateDecision::Allow
        );
    }

    /// owner-expired 边界（spec Scenario「租户条目过期拒绝且 reason 与未注册
    /// 区分」「续期恢复准入」）：过期 → dweb/owner-expired；未注册 →
    /// dweb/unknown-owner；文件入口续期（新 register + reload）→ 恢复
    #[tokio::test]
    async fn owner_expired_reason_distinct_and_renewal_restores() {
        // Fixture 的 registry 临时目录不保活——本测试要直接写 owners.jsonl
        // （文件入口），用独立存活的 TempDir 自建 registry（签名材料与
        // Fixture 同构：fabric=[3;32] issuer=[1;32] server=[2;32]）
        let dir = TempDir::new().unwrap();
        let registry = Arc::new(OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap());
        let issuer = SigningKey::from_bytes(&[1u8; 32]);
        let issuer_root = issuer.verifying_key().to_bytes();
        registry.register(&[3u8; 32], &issuer_root).unwrap();
        let gate = AccessGate::new([2u8; 32], registry.clone(), PolicyConfig::Static).unwrap();
        let now = now_ms();
        let valid = sign_and_encode(
            &issuer,
            &[3u8; 32],
            &[2u8; 32],
            &[4u8; 32],
            CAP_RELAY,
            now,
            now + TTL,
        );
        let input = GateInput {
            endpoint_id: [4u8; 32],
            auth_header: Some(format!("Bearer {valid}")),
            query_token: None,
            connection_id: 1,
            op: Op::RelayConnect,
        };
        // 基线：有效票放行
        assert_eq!(gate.decide(&input).await, GateDecision::Allow);

        // 文件入口写入带过期时间的 register（expires_at = 过去）+ reload
        let fabric_hex = hex::encode([3u8; 32]);
        let root_hex = hex::encode(issuer_root);
        let path = registry.path().to_path_buf();
        let expired_line = format!(
            "{{\"op\":\"register\",\"fabric_id\":\"{fabric_hex}\",\"root\":\"{root_hex}\",\"ts\":100,\"expires_at\":200}}\n"
        );
        std::fs::write(&path, &expired_line).unwrap();
        registry.reload().unwrap();
        // now >= expires_at（等值=过期）→ owner-expired（区别于 unknown）
        assert_eq!(deny_reason(gate.decide(&input).await), OWNER_EXPIRED);

        // 未注册 fabric → unknown-owner（区分面）
        let impostor = sign_and_encode(
            &SigningKey::from_bytes(&[1u8; 32]),
            &[0x77; 32],
            &[2u8; 32],
            &[4u8; 32],
            CAP_RELAY,
            now_ms(),
            now_ms() + TTL,
        );
        let impostor_input = GateInput {
            endpoint_id: [4u8; 32],
            auth_header: Some(format!("Bearer {impostor}")),
            query_token: None,
            connection_id: 2,
            op: Op::RelayConnect,
        };
        assert_eq!(
            deny_reason(gate.decide(&impostor_input).await),
            "dweb/unknown-owner"
        );

        // 续期：新 register（远期 expires_at + alias）+ reload → 放行
        let renewed_expiry = now_ms() + 3_600_000;
        let renewed = format!(
            "{{\"op\":\"register\",\"fabric_id\":\"{fabric_hex}\",\"root\":\"{root_hex}\",\"ts\":300,\"expires_at\":{renewed_expiry},\"alias\":\"renewed\"}}\n"
        );
        std::fs::write(&path, format!("{expired_line}{renewed}")).unwrap();
        registry.reload().unwrap();
        assert_eq!(gate.decide(&input).await, GateDecision::Allow);
        // 快照携带元数据（续期事件的 alias/expires_at）
        let entries = registry.snapshot().entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].expires_at, Some(renewed_expiry));
        assert_eq!(entries[0].alias.as_deref(), Some("renewed"));
    }

    /// 复合 generation 缓存联动（r1-P1-6 回归）：无票 webhook 放行被缓存后，
    /// 访客 grant（世代+1）→ 名册放行；revoke（世代+1）→ 旧 allow 缓存失效，
    /// webhook 在 TTL 内也被重新咨询
    #[tokio::test]
    async fn visitor_generation_invalidates_cached_webhook_allow() {
        let (f, _gate) = Fixture::new();
        let p1a = Phase1aFixture::new();
        // 可缓存形态：TTL 60s（> 测试时长）
        let mock = callback_mock_json(r#"{"allow":true}"#).await;
        let mut cfg = cb_cfg(mock.url.clone());
        cfg.cache_ttl_ms = 60_000;
        let gate = p1a.gate(&f, PolicyConfig::Callback(cfg));

        let endpoint = [0xE8; 32];
        let count = || mock.count.load(std::sync::atomic::Ordering::SeqCst);
        // ① 无票非访客：webhook allow → 放行并缓存；第二次缓存命中
        assert_eq!(
            gate.decide(&p1a.no_ticket(endpoint, 1)).await,
            GateDecision::Allow
        );
        assert_eq!(count(), 1);
        assert_eq!(
            gate.decide(&p1a.no_ticket(endpoint, 2)).await,
            GateDecision::Allow
        );
        assert_eq!(count(), 1, "缓存命中不回调");

        // ② grant：名册放行（webhook 仍不咨询）
        p1a.visitors.grant(&endpoint, None, None, None).unwrap();
        assert_eq!(
            gate.decide(&p1a.no_ticket(endpoint, 3)).await,
            GateDecision::Allow
        );
        assert_eq!(count(), 1);

        // ③ revoke：复合世代变化 → 旧 allow 缓存不命中 → webhook 重新咨询
        p1a.visitors.revoke(&endpoint).unwrap();
        assert_eq!(
            gate.decide(&p1a.no_ticket(endpoint, 4)).await,
            GateDecision::Allow
        );
        assert_eq!(count(), 2, "revoke 后不得命中 revoke 前的 allow 缓存");
    }

    /// RdzResolve 的 endpoint_id 是解析目标：黑名单 endpoint 维度不适用
    /// （bearer-only 无请求方身份——按目标拉黑会错杀合法解析）
    #[tokio::test]
    async fn blocklist_endpoint_dim_skips_rdz_resolve() {
        let (f, _gate) = Fixture::new();
        let p1a = Phase1aFixture::new();
        let gate = p1a.gate(&f, PolicyConfig::Static);
        let target = [0xE9; 32];
        p1a.blocklist
            .add(BlockKind::Endpoint, &target, None)
            .unwrap();
        // 被拉黑 id 作为解析目标 + 无票 → 走 C0（no-capability），非 blocked
        let input = GateInput {
            endpoint_id: target,
            auth_header: None,
            query_token: None,
            connection_id: 0,
            op: Op::RdzResolve,
        };
        assert_eq!(deny_reason(gate.decide(&input).await), "dweb/no-capability");
        // 对照：同 id 在 relay 面（已认证身份）→ blocked
        assert_eq!(
            deny_reason(gate.decide(&p1a.no_ticket(target, 1)).await),
            BLOCKED_REASON
        );
    }
}
