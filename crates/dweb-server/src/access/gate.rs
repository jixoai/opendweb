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

use crate::access::callback::CallbackProvider;
use crate::access::cap::{self, CAP_RDZ_ANNOUNCE, CAP_RDZ_RESOLVE, CAP_RELAY, CapDeny, RelayCap};
use crate::access::config::PolicyConfig;
use crate::access::registry::{OwnerRegistry, RegistrySnapshot};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// per-owner 连接配额超限 deny reason（task 3.2 前半；wire 冻结 slug，
/// 语法同 dweb/ 家族）
pub const OWNER_QUOTA_EXCEEDED: &str = "dweb/owner-quota-exceeded";

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

/// per-owner 在线连接表（task 3.2 前半，Phase 3）：票接入的
/// (endpoint_id, connection_id) → fabric_id 归属 + owner 维度计数。
/// 生命周期配对（依赖 iroh-relay 装配语义，handshake.rs authorize_with）：
/// on_connect 返回 Allow 后 OnDisconnectGuard 立即创建，其 Drop **恒**触发
/// on_disconnect（恰一次）——reserve 与 release 由此天然配对，连接中途
/// 死亡（accept 发送失败）也不例外。
/// 无票接入（A_cb）不计入 owner 维度（无 fabric 可归，配额语义只约束
/// 票据接入）；open 模式无 gate，零计数。
struct OnlineTable(Mutex<OnlineInner>);

#[derive(Default)]
struct OnlineInner {
    /// (endpoint_id, connection_id) → fabric_id（on_disconnect 按连接精确定位）
    conns: HashMap<([u8; 32], u64), [u8; 32]>,
    /// fabric_id → 在线连接数（配额判定与 admin status 投影）
    owners: HashMap<[u8; 32], usize>,
}

/// admin status 的在线表只读投影（GET /admin/status 消费）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineView {
    /// per endpoint（票接入）：{endpoint_id, fabric_id, connections}
    pub per_endpoint: Vec<OnlineEndpoint>,
    /// per owner（fabric_id → 在线连接数）
    pub per_owner: Vec<([u8; 32], usize)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineEndpoint {
    pub endpoint_id: [u8; 32],
    pub fabric_id: [u8; 32],
    pub connections: usize,
}

impl OnlineTable {
    /// 原子配额预约（check+incr 同锁，杜绝并发 TOCTOU 超限）。
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
        if let Some(old) = inner.conns.insert((endpoint_id, connection_id), *fabric_id) {
            decrement_owner(&mut inner.owners, &old);
        }
        *inner.owners.entry(*fabric_id).or_insert(0) += 1;
        true
    }

    /// 名额释放（on_disconnect；幂等——未知键零副作用）
    fn release(&self, endpoint_id: [u8; 32], connection_id: u64) {
        let mut inner = self.0.lock().unwrap();
        if let Some(fabric_id) = inner.conns.remove(&(endpoint_id, connection_id)) {
            decrement_owner(&mut inner.owners, &fabric_id);
        }
    }

    /// 只读投影（admin status 低频调用；双表分别确定性排序）
    fn view(&self) -> OnlineView {
        let inner = self.0.lock().unwrap();
        let mut by_endpoint: HashMap<[u8; 32], (Vec<[u8; 32]>, usize)> = HashMap::new();
        for ((endpoint, _conn), fabric) in &inner.conns {
            let entry = by_endpoint.entry(*endpoint).or_default();
            entry.0.push(*fabric);
            entry.1 += 1;
        }
        let mut per_endpoint: Vec<OnlineEndpoint> = by_endpoint
            .into_iter()
            .map(|(endpoint_id, (fabrics, connections))| OnlineEndpoint {
                endpoint_id,
                // 同一 endpoint 的多条连接理论上同 fabric（recipient 绑定）；
                // 防御性取首条
                fabric_id: fabrics.first().copied().unwrap_or([0u8; 32]),
                connections,
            })
            .collect();
        per_endpoint.sort_by_key(|e| e.endpoint_id);
        let mut per_owner: Vec<([u8; 32], usize)> =
            inner.owners.iter().map(|(k, v)| (*k, *v)).collect();
        per_owner.sort();
        OnlineView {
            per_endpoint,
            per_owner,
        }
    }
}

/// owner 计数递减（归零即删键，防 HashMap 无界增长）
fn decrement_owner(owners: &mut HashMap<[u8; 32], usize>, fabric_id: &[u8; 32]) {
    if let Some(count) = owners.get_mut(fabric_id)
        && *count > 0
    {
        *count -= 1;
        if *count == 0 {
            owners.remove(fabric_id);
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
        })
    }

    /// per-owner 连接配额（task 3.2 前半；builder 形态——main 仅对 relay
    /// gate 设置，rendezvous gate 无连接语义不设置）
    pub fn with_max_connections_per_owner(mut self, limit: Option<usize>) -> Self {
        self.max_connections_per_owner = limit;
        self
    }

    /// 执行验证链（C0 → L1 → L1b → L2）。全链 O(1) + 单次验签；唯一网络
    /// 调用是 callback 模式的 L2 webhook（超时/并发防护见 callback.rs）。
    pub async fn decide(&self, input: &GateInput) -> GateDecision {
        match classify_credential(input.auth_header.as_deref(), input.query_token.as_deref()) {
            // C0：声明了凭证但不可解析——绝不进无票路径（R4 P1-6）
            Credential::Malformed => {
                GateDecision::Deny(Cow::Borrowed(CapDeny::MalformedCapability.reason()))
            }
            // 无票：跳过 L1/L1b，直接 L2（static 拒 / callback 交 webhook）
            Credential::None => self.decide_l2(None, input, self.registry.snapshot()).await,
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
                // L1b 票有效性底线（static/callback 共享，不可插拔）
                let snapshot = self.registry.snapshot();
                if !snapshot.contains(&parsed.fabric_id, &parsed.issuer) {
                    return GateDecision::Deny(Cow::Borrowed("dweb/unknown-owner"));
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
                let decision = self.decide_l2(Some(&parsed), input, snapshot).await;
                // L2 deny 的连接不会注册（iroh-relay 先 authorize 后
                // register），on_disconnect 永不触发——不回滚即泄漏名额
                if reserved && matches!(decision, GateDecision::Deny(_)) {
                    self.online.release(input.endpoint_id, input.connection_id);
                }
                decision
            }
        }
    }

    /// L2 策略决策（design §8.2：static 无票必拒/有效票放行；callback 交
    /// webhook，无票同样交 = A_cb(S) 独立边界）
    async fn decide_l2(
        &self,
        capability: Option<&RelayCap>,
        input: &GateInput,
        snapshot: RegistrySnapshot,
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

    /// on_disconnect 钩子：per-owner 在线名额释放（task 3.2）+ callback
    /// 模式转发 best-effort 观察通知；static 模式后者为空实现（design §8.5）
    pub fn on_disconnect(&self, endpoint_id: [u8; 32], connection_id: u64) {
        self.online.release(endpoint_id, connection_id);
        if let Policy::Callback(provider) = &self.policy {
            provider.notify_disconnect(&endpoint_id, connection_id);
        }
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

/// registry 热重载看护（task 1.2 遗留 / task 1.5 接线）：mtime+len 轮询
/// （5s 间隔，跨平台实现简单——SIGHUP 不便携），文件变化即
/// OwnerRegistry::reload（快照替换 + generation+1）并清 callback 缓存容量。
/// 重载失败（admin 正在写/坏行）保留旧快照，stat 再变化时重试。
pub fn spawn_registry_reload_watcher(
    registry: Arc<OwnerRegistry>,
    gate: Option<Arc<AccessGate>>,
) -> tokio::task::JoinHandle<()> {
    spawn_registry_reload_watcher_every(registry, gate, std::time::Duration::from_secs(5))
}

/// 可配间隔版本（单测用 50ms 级间隔验证轮换语义）
pub fn spawn_registry_reload_watcher_every(
    registry: Arc<OwnerRegistry>,
    gate: Option<Arc<AccessGate>>,
    interval: std::time::Duration,
) -> tokio::task::JoinHandle<()> {
    let path = registry.path().to_path_buf();
    tokio::spawn(async move {
        let mut last = stat_of(&path);
        loop {
            tokio::time::sleep(interval).await;
            let current = stat_of(&path);
            if current == last {
                continue;
            }
            last = current;
            match registry.reload() {
                Ok(()) => {
                    let snapshot = registry.snapshot();
                    tracing::info!(
                        generation = snapshot.generation(),
                        owners = snapshot.len(),
                        "owner registry reloaded"
                    );
                    if let Some(gate) = &gate {
                        gate.invalidate_callback_cache();
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "owner registry reload failed (keeping previous snapshot): {e:#}"
                    );
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
        let handle = spawn_registry_reload_watcher_every(
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
}
