//! Fabric 门面：SDK 与绑定层直接消费的公共 API。
//! 生命周期、邀请/兑换、连接管理、事件广播与关闭语义的编排层。

use crate::identity::{EndpointId, NodeIdentity, endpoint_id_display, endpoint_id_parse};
use crate::known_addrs::KnownAddrs;
use crate::roster::{RevokeTarget, Roster};
use crate::session::{self, ALPN_REDEEM, ALPN_REGULAR, LinkStatus, SessionError};
use iroh::endpoint::{self, Connection};
use iroh::{Endpoint, EndpointAddr, RelayMode, Watcher};
use rustls_pki_types::pem::PemObject;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{Mutex, broadcast};

/// relay 配置：禁用 / 自托管(或自定义) URL 列表 / n0 官方默认 /
/// 带 per-relay capability 的自定义列表（server-access-policy task 2.2）
#[derive(Debug, Clone)]
pub enum RelayConfig {
    Disabled,
    Custom(Vec<String>),
    N0Default,
    /// 自定义 relay 列表 + 条目级 capability 凭证（design §11.3）：
    /// 构造 RelayMap 时 url+token 成对注入（iroh 条目级 auth token）。
    /// 与 `Custom` 语义差异仅在凭证：无凭证条目等价 `Custom` 同款候选。
    CustomWithCaps(Vec<RelayEntry>),
}

/// `RelayConfig::CustomWithCaps` 的单条 relay 条目（design §11.3 + task 2.3
/// 裁定）：url 恒填；capability 凭证二选一——
/// - `server_id`：restricted relay 的 ServerId（admin 注册时转交 owner），
///   root 侧据此刻自签 own/bootstrap/member capability；
/// - `token`：现成的 `dwebr1.` 串（手工/测试用——如 admin 预铸后转交），
///   直接注入本地 RelayMap，不参与 invite 签发（v1 无凭证位、v2 凭证
///   由 server_id 现签保证 recipient 绑定）。
///
/// 两者可同时给出（token 优先生效于本地注入，server_id 供签发）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayEntry {
    /// relay URL（构造期校验可解析性，与 Custom 同规）。
    pub url: String,
    /// restricted relay 的 ServerId（32B；None = 非 restricted 条目）。
    pub server_id: Option<[u8; 32]>,
    /// 现成 capability 串（None = 无静态凭证）。
    pub token: Option<String>,
}

impl RelayEntry {
    /// 该条目是否为 restricted（参与 invite v2 签发 / OK2 附发）。
    fn is_restricted(&self) -> bool {
        self.server_id.is_some()
    }

    /// 本地 RelayMap 注入用的 token（静态 token 优先；None = 无凭证）。
    fn local_token(&self) -> Option<&str> {
        self.token.as_deref()
    }
}

impl RelayConfig {
    /// 是否含 restricted 条目（invite v2 触发条件，task 2.1）。
    fn has_restricted(&self) -> bool {
        match self {
            Self::CustomWithCaps(entries) => entries.iter().any(RelayEntry::is_restricted),
            _ => false,
        }
    }
}

/// 将 (url, token) 对注入 iroh RelayMap（条目级 auth token；task 2.2）。
/// RelayMap 内部为共享 RwLock 的 BTreeMap——本函数在 endpoint 构造前与
/// 运行中均可安全调用（iroh socket 持同一句柄，热注入即时生效）。
/// token 为空串时注入无凭证条目（等价默认形态）。
pub fn inject_relay_tokens(map: &iroh_relay::RelayMap, entries: &[(String, String)]) {
    for (url, token) in entries {
        let Ok(u) = url.parse::<iroh::RelayUrl>() else {
            // 构造期已校验配置 URL；此处的不可解析项只可能来自令牌/回执
            // 携带的外部 URL——跳过（不因一条坏候选拖垮整张 map）
            continue;
        };
        let mut cfg = iroh_relay::RelayConfig::from(u.clone());
        if !token.is_empty() {
            cfg = cfg.with_auth_token(token.clone());
        }
        map.insert(u, std::sync::Arc::new(cfg));
    }
}

/// relay TLS 信任根（HB 5.1 受限枚举）：公共 API 不暴露 iroh 上游类型，
/// `insecure_skip_verify` 在默认构建中对下游不可达。
#[derive(Clone, Default)]
pub enum RelayTlsTrust {
    /// 平台默认信任根（缺省）。映射为不设置 iroh `ca_tls_config`——iroh
    /// 默认使用内置 Mozilla webpki 根集合（与平台 TLS 根等价的发行版快照）。
    #[default]
    PlatformRoot,
    /// 自托管 relay 的自定义 CA（PEM 字节，可含多张 CERTIFICATE 段）。
    /// 映射为 iroh `custom_roots`：**仅**信任提供的证书（不叠加内置根）——
    /// 自签部署的标准收紧信任语义。
    CustomPem(Vec<u8>),
}

impl RelayTlsTrust {
    /// 映射到 iroh 上游 CA 配置：PlatformRoot -> None（builder 默认根）；
    /// CustomPem -> 仅自定义根。PEM 解析错误显式上报（构造期 fail-fast）。
    fn to_ca_tls_config(&self) -> Result<Option<iroh_relay::tls::CaTlsConfig>, FabricError> {
        match self {
            Self::PlatformRoot => Ok(None),
            Self::CustomPem(pem) => {
                let certs: Result<Vec<_>, _> =
                    rustls_pki_types::CertificateDer::pem_slice_iter(pem).collect();
                let certs = certs
                    .map_err(|e| FabricError::BadRelayTlsPem(format!("PEM decode failed: {e}")))?;
                if certs.is_empty() {
                    return Err(FabricError::BadRelayTlsPem(
                        "no CERTIFICATE sections found".to_owned(),
                    ));
                }
                Ok(Some(iroh_relay::tls::CaTlsConfig::custom_roots(certs)))
            }
        }
    }
}

impl std::fmt::Debug for RelayTlsTrust {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PlatformRoot => f.write_str("RelayTlsTrust::PlatformRoot"),
            // 不回显 PEM 字节（可能被视为敏感材料；日志只记长度）
            Self::CustomPem(pem) => write!(f, "RelayTlsTrust::CustomPem({} bytes)", pem.len()),
        }
    }
}

/// HTTP 控制面（relay 连接）代理所有权（D7）。iroh endpoint 不读进程环境变量；
/// QUIC 数据面（直连 + NAT 穿透）永不经代理。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum HttpProxyConfig {
    /// builder 不设 proxy（iroh 默认直连）。
    #[default]
    None,
    /// `builder.proxy_from_env()`（顺序 HTTP_PROXY > http_proxy > HTTPS_PROXY > https_proxy，由 iroh 冻结）。
    FromEnv,
    /// `builder.proxy_url(u)`（构造期校验 URL 语法，非法即报错）。
    Url(String),
}

/// join 网络工作流总时限的值域（毫秒）。
pub const JOIN_TIMEOUT_MS_MIN: u64 = 1_000;
pub const JOIN_TIMEOUT_MS_MAX: u64 = 600_000;
/// join 总时限默认值：30 秒（包住 connect + redeem）。
pub const JOIN_TIMEOUT_MS_DEFAULT: u64 = 30_000;
/// relay TCP 探针预算（transport-only；DNS 计入预算）。
pub const RELAY_PROBE_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// 签发邀请的可选参数（D3 逃生阀等）。
#[derive(Debug, Clone, Default)]
pub struct InviteOptions {
    /// 允许签发无 relay 令牌；调用方自担可达性责任（须自行保证带外可达路径，
    /// 不要求 advertise_addrs 非空——两者独立）。
    pub allow_relayless: bool,
}

/// join 网络工作流的稳定错误码（D11 八码 + server-access-policy 附录 A2
/// 第九码）。本地数据面错误豁免于八码之外，按原生变体透出
/// （missing-identity / corrupted / roster-io）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum JoinErrorCode {
    TokenInvalid,
    TokenExpired,
    WrongFabric,
    NoReachablePath,
    RelayOffline,
    DialFailed,
    DialTimeout,
    TokenConsumed,
    /// 附录 A2 第九码：`dweb2.` 令牌交给仅支持 v1 的客户端（旧客户端
    /// 无法解析 v2 布局；message 含升级指引，不得静默降级为 token-invalid）。
    UnsupportedInviteVersion,
}

impl JoinErrorCode {
    /// SDK 消息前缀使用的 kebab 串（error-matrix 冻结集合 + 附录 A2 扩展）。
    pub fn kebab(&self) -> &'static str {
        match self {
            Self::TokenInvalid => "token-invalid",
            Self::TokenExpired => "token-expired",
            Self::WrongFabric => "wrong-fabric",
            Self::NoReachablePath => "no-reachable-path",
            Self::RelayOffline => "relay-offline",
            Self::DialFailed => "dial-failed",
            Self::DialTimeout => "dial-timeout",
            Self::TokenConsumed => "token-consumed",
            Self::UnsupportedInviteVersion => "unsupported-invite-version",
        }
    }
}

impl std::fmt::Display for JoinErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.kebab())
    }
}

/// 身份注入方式（信任模型中立）：
/// - `Default`：运行时以最终 `data_dir` 解析 FileSecretStore（不复制路径）
/// - `Seed`：纯注入，绝不读写任何存储
/// - `Store`：产品自定义实现（Keychain/托管后端等）
#[derive(Clone)]
pub enum SecretInjection {
    Default,
    Seed(crate::secret::SecretSeed),
    Store(Arc<dyn crate::secret::SecretStore>),
}

impl std::fmt::Debug for SecretInjection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Default => f.write_str("SecretInjection::Default"),
            // 脱敏：绝不把 seed 打进日志
            Self::Seed(_) => f.write_str("SecretInjection::Seed([REDACTED])"),
            Self::Store(_) => f.write_str("SecretInjection::Store(<custom>)"),
        }
    }
}

#[derive(Clone)]
pub struct FabricConfig {
    pub data_dir: PathBuf,
    pub relay: RelayConfig,
    /// 写入邀请令牌的 issuer 直连地址（host:port），如 ["192.168.1.10:53210"]。
    /// 唯一受信的直连来源：签发路径永不混入运行时探测地址（direct_addr_hints）。
    pub advertise_addrs: Vec<String>,
    /// 身份来源；默认经 FileSecretStore 指向 `data_dir`
    pub secret: SecretInjection,
    /// HTTP 控制面代理所有权（缺省 None）。
    pub http_proxy: HttpProxyConfig,
    /// join 网络工作流总时限（毫秒；缺省 30000，值域 [1000, 600000]）。
    pub join_timeout_ms: u64,
    /// relay TLS 信任根（HB 5.1；缺省 [`RelayTlsTrust::PlatformRoot`]）。
    /// 自签 relay 部署用 [`RelayTlsTrust::CustomPem`] 提供自有 CA（PEM 字节）。
    pub relay_tls_trust: RelayTlsTrust,
    /// 显式本地绑定地址（"127.0.0.1:53210"；None = 默认临时端口）。
    /// 供固定端口部署与 advertise_addrs 保持一致（内核级选项，SDK 未暴露）。
    pub bind_addr: Option<String>,
}

impl std::fmt::Debug for FabricConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FabricConfig")
            .field("data_dir", &self.data_dir)
            .field("relay", &self.relay)
            .field("advertise_addrs", &self.advertise_addrs)
            .field("secret", &self.secret) // SecretInjection 的 Debug 已脱敏
            .field("http_proxy", &self.http_proxy)
            .field("join_timeout_ms", &self.join_timeout_ms)
            .field("relay_tls_trust", &self.relay_tls_trust)
            .field("bind_addr", &self.bind_addr)
            .finish()
    }
}

impl FabricConfig {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            relay: RelayConfig::N0Default,
            advertise_addrs: Vec::new(),
            secret: SecretInjection::Default,
            http_proxy: HttpProxyConfig::None,
            join_timeout_ms: JOIN_TIMEOUT_MS_DEFAULT,
            relay_tls_trust: RelayTlsTrust::default(),
            bind_addr: None,
        }
    }

    /// 构造期校验（advertise_addrs / http_proxy / join_timeout_ms / bind_addr）。
    /// 在 Fabric 构造（create_root/open/attach）前调用，非法项直接报错。
    pub fn validate(&self) -> Result<(), FabricError> {
        normalize_advertise_addrs(&self.advertise_addrs)?;
        // relay 配置完备性（P1-3）：custom 空列表与不可解析 URL 在任何
        // 身份/名册持久化之前拒绝。CustomWithCaps 同规（task 2.2），另校验
        // 静态 token 的 dwebr1. 形态（fail-fast，杜绝运行期注入坏凭证）。
        if let RelayConfig::Custom(urls) = &self.relay
            && urls.is_empty()
        {
            return Err(FabricError::Session(SessionError::Connect(
                "custom relay list must not be empty".into(),
            )));
        }
        if let RelayConfig::Custom(urls) = &self.relay {
            for u in urls {
                u.parse::<iroh::RelayUrl>().map_err(|e| {
                    FabricError::Session(SessionError::Connect(format!(
                        "invalid relay url {u}: {e}"
                    )))
                })?;
            }
        }
        if let RelayConfig::CustomWithCaps(entries) = &self.relay {
            if entries.is_empty() {
                return Err(FabricError::Session(SessionError::Connect(
                    "custom relay list must not be empty".into(),
                )));
            }
            // 附录 A：v2 令牌 relay_count 上限 8——CustomWithCaps 是 v2 专属
            // 形态，超限配置在构造期拒绝（否则签发永远失败）
            if entries.len() > crate::protocol::MAX_RELAYS_V2 {
                return Err(FabricError::Session(SessionError::Connect(format!(
                    "custom relay list of {} entries exceeds the v2 invite limit of {}",
                    entries.len(),
                    crate::protocol::MAX_RELAYS_V2
                ))));
            }
            for entry in entries {
                entry.url.parse::<iroh::RelayUrl>().map_err(|e| {
                    FabricError::Session(SessionError::Connect(format!(
                        "invalid relay url {}: {e}",
                        entry.url
                    )))
                })?;
                if let Some(token) = &entry.token
                    && crate::protocol::RelayCapV1::decode(token).is_err()
                {
                    return Err(FabricError::Session(SessionError::Connect(format!(
                        "relay '{}' carries a malformed dwebr1. capability token",
                        entry.url
                    ))));
                }
            }
        }
        if let HttpProxyConfig::Url(u) = &self.http_proxy {
            parse_proxy_url(u)?;
        }
        // HB 5.1：CustomPem 构造期解析（fail-fast，非法 PEM 不进入运行）。
        self.relay_tls_trust.to_ca_tls_config()?;
        // R2 P1-2：CustomPem 是"仅自定义根"的收紧语义——叠加 N0Default 会
        // 使官方 relay.iroh.network 的证书失去内置根信任而静默离线。组合
        // 无定义语义，构造期显式拒绝（要自定义 CA 请显式配置 custom relay）。
        if matches!(self.relay_tls_trust, RelayTlsTrust::CustomPem(_))
            && matches!(self.relay, RelayConfig::N0Default)
        {
            return Err(FabricError::Session(SessionError::Connect(
                "relay_tls_trust CustomPem replaces platform roots and cannot be combined \
                 with the n0 default relay (its certificate would become untrusted); \
                 configure an explicit custom relay list for custom CA deployments"
                    .into(),
            )));
        }
        if !(JOIN_TIMEOUT_MS_MIN..=JOIN_TIMEOUT_MS_MAX).contains(&self.join_timeout_ms) {
            return Err(FabricError::JoinTimeoutOutOfRange(self.join_timeout_ms));
        }
        if let Some(b) = &self.bind_addr
            && b.parse::<std::net::SocketAddr>().is_err()
        {
            return Err(FabricError::BadBindAddr(b.clone()));
        }
        Ok(())
    }
}

/// advertise_addrs 构造期规范化：非空可解析 ip:port（或 [ipv6]:port）、
/// 拒绝通配（unspecified）与端口 0、loopback 允许、重复去重保序。
pub fn normalize_advertise_addrs(addrs: &[String]) -> Result<Vec<String>, FabricError> {
    let mut out: Vec<String> = Vec::new();
    for raw in addrs {
        let bad = |why: &str| FabricError::BadAdvertiseAddr {
            addr: raw.clone(),
            reason: why.to_owned(),
        };
        if raw.trim().is_empty() {
            return Err(bad("empty address"));
        }
        let sa: std::net::SocketAddr = raw
            .parse()
            .map_err(|_| bad("not a parseable ip:port or [ipv6]:port"))?;
        if sa.ip().is_unspecified() {
            return Err(bad(
                "wildcard addresses are not dialable; use a concrete address",
            ));
        }
        if sa.port() == 0 {
            return Err(bad("port 0 is not dialable; use a concrete port"));
        }
        if !out.contains(raw) {
            out.push(raw.clone());
        }
    }
    Ok(out)
}

/// 代理 URL 解析（经 RelayUrl 借道 url::Url，避免直接依赖 url crate）。
fn parse_proxy_url(u: &str) -> Result<iroh::RelayUrl, FabricError> {
    u.parse::<iroh::RelayUrl>()
        .map_err(|_| FabricError::BadProxyUrl(u.to_owned()))
}

// ==== 成员 relay capability 持久化（server-access-policy task 2.3 / §7.3） ====

/// data_dir 内的成员 capability 存储文件（REDEEM_OK2 附发令牌的落盘点；
/// 形态：`[{"url":"...","capability":"dwebr1...."}]`，同 url 以新兑换覆盖）。
pub const RELAY_CAPS_FILE: &str = "relay.caps.json";

fn relay_caps_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join(RELAY_CAPS_FILE)
}

/// 读取持久化的 (url, capability) 列表；文件缺失 = 空（成员尚未兑换过）。
/// capability 串形态在写入侧已校验（dwebr1. 良构），读取侧再验一次——
/// 外部篡改/损坏按数据面错误上报，不静默吞掉。已过期条目在读取侧丢弃
/// （云端实证 2026-09-18：残留过期 member cap 在构造期注入 RelayMap，
/// eager relay 会话以过期票握手被拒，后续 join 的 bootstrap 覆盖 map 也
/// 追不上 deny 退避窗口——过期票对任何正确 server 都不可准入，加载侧
/// 丢弃是确定性收敛；文件在下次 store 的 read-merge-write 中惰性压实）。
fn load_relay_caps(data_dir: &std::path::Path) -> Result<Vec<(String, String)>, FabricError> {
    let path = relay_caps_path(data_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path).map_err(|e| FabricError::RelayCapsStore {
        path: path.clone(),
        reason: format!("read failed: {e}"),
    })?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_slice(&bytes).map_err(|e| FabricError::RelayCapsStore {
            path: path.clone(),
            reason: format!("corrupted (not a JSON array): {e}"),
        })?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let url = item.get("url").and_then(|v| v.as_str()).ok_or_else(|| {
            FabricError::RelayCapsStore {
                path: path.clone(),
                reason: "corrupted (entry missing 'url')".to_owned(),
            }
        })?;
        let cap = item
            .get("capability")
            .and_then(|v| v.as_str())
            .ok_or_else(|| FabricError::RelayCapsStore {
                path: path.clone(),
                reason: "corrupted (entry missing 'capability')".to_owned(),
            })?;
        // 过期判定与 server 侧 L1 同语义（now >= expires_at 等值即拒）
        match crate::protocol::RelayCapV1::decode(cap) {
            Err(_) => {
                return Err(FabricError::RelayCapsStore {
                    path: path.clone(),
                    reason: format!(
                        "corrupted (entry capability is not a dwebr1. token for {url})"
                    ),
                });
            }
            Ok(decoded) if now_ms() >= decoded.expires_at => continue,
            Ok(_) => {}
        }
        out.push((url.to_owned(), cap.to_owned()));
    }
    Ok(out)
}

/// 文件级 append/update + 原子写（tmp+fsync+rename；0600——capability 是
/// bearer 凭证）。语义（task 2.3）：新兑换覆盖同 url 条目，其余原样保留。
/// 实现为 read-merge-write：读现有文件（缺失 = 空）→ 内存 upsert → 全量落盘。
fn store_relay_caps(
    data_dir: &std::path::Path,
    incoming: &[(String, String)],
) -> Result<(), FabricError> {
    let path = relay_caps_path(data_dir);
    let mut merged = load_relay_caps(data_dir)?;
    upsert_relay_caps(&mut merged, incoming);
    // 形态冻结：[{url, capability}] 对象数组（tuple 会编码成 JSON 数组，不用）
    let items: Vec<serde_json::Value> = merged
        .iter()
        .map(|(url, cap)| serde_json::json!({ "url": url, "capability": cap }))
        .collect();
    let json = serde_json::to_string_pretty(&items).map_err(|e| FabricError::RelayCapsStore {
        path: path.clone(),
        reason: format!("encode failed: {e}"),
    })?;
    let mut tmp = std::ffi::OsString::from(path.as_os_str());
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| FabricError::RelayCapsStore {
                path: tmp.clone(),
                reason: format!("open failed: {e}"),
            })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        file.write_all(json.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|e| FabricError::RelayCapsStore {
                path: tmp.clone(),
                reason: format!("write failed: {e}"),
            })?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| FabricError::RelayCapsStore {
        path,
        reason: format!("rename failed: {e}"),
    })?;
    Ok(())
}

/// 内存态 upsert：同 url 覆盖、新 url 追加（保序）。
fn upsert_relay_caps(store: &mut Vec<(String, String)>, incoming: &[(String, String)]) -> bool {
    let mut changed = false;
    for (url, cap) in incoming {
        match store.iter_mut().find(|(u, _)| u == url) {
            Some(slot) => {
                if slot.1 != *cap {
                    slot.1 = cap.clone();
                    changed = true;
                }
            }
            None => {
                store.push((url.clone(), cap.clone()));
                changed = true;
            }
        }
    }
    changed
}

/// 中继状态快照（relay_status() 与 relay 事件 payload 同构；D4）。
#[derive(Debug, Clone)]
pub struct RelayStatusSnapshot {
    /// "disabled" | "custom" | "n0"
    pub mode: &'static str,
    /// 配置序 relay URL 列表（disabled 为空；n0 恒为官方默认）。
    pub urls: Vec<String>,
    /// None <=> mode == "disabled"；否则任一 relay 已连接。
    pub online: Option<bool>,
    /// 当前生效 relay（HB 8.1）：online == Some(true) 时为配置序最小的已连接
    /// relay URL（与 RelayOnline 事件同一 tie-break）；offline / disabled 为
    /// None。SDK 层透出为 activeUrl（跨层契约，字段名冻结）。
    pub active_url: Option<String>,
    /// 候选列表中首个（配置序）未连接且带错误的 relay 之脱敏错误。
    pub last_error: Option<String>,
}

/// watcher 聚合用的单 relay 视图（可脱离 iroh 类型确定性构造，供测试）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayStatusView {
    pub url: String,
    pub connected: bool,
    pub last_error: Option<String>,
}

/// 聚合结果：online = 任一 connected；事件 URL tie-break = 配置序最小。
#[derive(Debug, Clone, Default)]
struct RelayAggregate {
    online: bool,
    online_url: Option<String>,
    last_error: Option<String>,
}

/// 聚合语义（纯函数，D4）：
/// - online = 列表中任一 relay is_connected；
/// - lastError = 按配置序显式排序后，首个未连接且带 last_error 的 relay（确定性，
///   不信任 watcher 返回顺序）；
/// - 事件 URL tie-break：同时连上多个时取配置序最小者。
fn aggregate_relay_status(config_urls: &[String], statuses: &[RelayStatusView]) -> RelayAggregate {
    // R2 P1-4：配置串保持原样、watcher 报告规范化形态——匹配用归一化键
    let at = |url: &str| statuses.iter().find(|s| same_relay_url(url, &s.url));
    // online_url：配置序最小的已连接候选；若 watcher 报告了不在配置内的
    // 已连接 relay（不应发生），回退到其自身 URL。
    let online_url = config_urls
        .iter()
        .find(|u| at(u).is_some_and(|s| s.connected))
        .cloned()
        .or_else(|| statuses.iter().find(|s| s.connected).map(|s| s.url.clone()));
    let online = online_url.is_some();
    let last_error = config_urls
        .iter()
        .filter_map(|u| at(u))
        .find(|s| !s.connected && s.last_error.is_some())
        .map(|s| {
            format!(
                "{} (host {})",
                s.last_error.as_deref().unwrap_or("connection error"),
                relay_url_host(&s.url)
            )
        });
    RelayAggregate {
        online,
        online_url,
        last_error,
    }
}

/// 快照自洽不变量（R3 P1-3）：active_url 有值 ⇔ online == Some(true)。
/// 所有快照写入点（watch loop / start 初始构造）都必须满足。
fn snapshot_invariant(s: &RelayStatusSnapshot) -> bool {
    matches!(s.online, Some(true)) == s.active_url.is_some()
}

/// N0 默认 relay URL 列表（R3 P1-4）：iroh 上游 default_relay_map 的真实 URL
///（4 个区域节点），排序冻结配置序——快照 urls / 拨号候选 / invite 令牌同源，
/// 消除“公告 canonical 单条、实际连接区域节点”的错配。
fn n0_default_urls() -> Vec<String> {
    let mut urls: Vec<String> = iroh::defaults::prod::default_relay_map()
        .urls::<Vec<iroh::RelayUrl>>()
        .into_iter()
        .map(|u| u.to_string())
        .collect();
    urls.sort();
    urls
}

/// invite 令牌携带的 relay URL（c1，纯函数供确定性测试）：
/// - online 且 active_url 存在：返回**实际在线**的 relay——joiner 经它必然
///   可达 issuer（配置首条可能是死条目，盲取会把 join 钉死在死 relay 上）；
///   active_url 为 watcher 的归一化形态（可能带尾 "/"），映射回配置原样
///   字符串（HB 8.1 对外回显配置形态）。
/// - 其余（disabled / 快照未沉降 / active 不在配置内）：回退配置序首条
///   （R3 P1-4：n0 与快照 urls 同源），与旧行为一致。
fn invite_relay_url(relay: &RelayConfig, snapshot: &RelayStatusSnapshot) -> String {
    let config_first = match relay {
        RelayConfig::Disabled => return String::new(),
        RelayConfig::Custom(urls) => urls.first().cloned().unwrap_or_default(),
        RelayConfig::N0Default => n0_default_urls().first().cloned().unwrap_or_default(),
        RelayConfig::CustomWithCaps(entries) => {
            entries.first().map(|e| e.url.clone()).unwrap_or_default()
        }
    };
    if snapshot.online == Some(true)
        && let Some(active) = &snapshot.active_url
    {
        let candidates: Vec<String> = match relay {
            RelayConfig::Custom(urls) => urls.clone(),
            RelayConfig::N0Default => n0_default_urls(),
            RelayConfig::Disabled => Vec::new(),
            RelayConfig::CustomWithCaps(entries) => entries.iter().map(|e| e.url.clone()).collect(),
        };
        // 命中配置原样串（规范化键比较）；不命中（不应发生）时仍用在线事实
        return candidates
            .into_iter()
            .find(|u| same_relay_url(u, active))
            .unwrap_or_else(|| active.clone());
    }
    config_first
}

/// InviteV2 的 relay 列表序（task 2.1，纯函数）："活快照优先"在列表语义
/// 下的落法——online 快照的 active 条目稳定提前，其余保持配置序（列表
/// 携带全部候选，活跃性由 joiner 的并发拨号兜底；iroh 对 EndpointAddr
/// 的全部路径并发发起初始包，天然 dial-failover）。
fn invite_v2_relay_order<'a>(
    entries: &'a [RelayEntry],
    snapshot: &RelayStatusSnapshot,
) -> Vec<&'a RelayEntry> {
    let ordered: Vec<&RelayEntry> = entries.iter().collect();
    if snapshot.online != Some(true) {
        return ordered;
    }
    let Some(active) = &snapshot.active_url else {
        return ordered;
    };
    let mut front: Vec<&RelayEntry> = Vec::with_capacity(ordered.len());
    let mut rest: Vec<&RelayEntry> = Vec::with_capacity(ordered.len());
    for e in &ordered {
        if same_relay_url(&e.url, active) {
            front.push(*e);
        } else {
            rest.push(*e);
        }
    }
    if front.is_empty() {
        return ordered;
    }
    front.extend(rest);
    front
}

/// shutdown drain 主体（R4 P1-1：由后台任务持有，调用方 Future 取消不中断）。
/// 全部收尾完成后 `send_replace(true)`——无订阅者也落值，顺序晚到调用即见 true。
async fn shutdown_drain(inner: Arc<FabricInner>) -> Result<(), FabricError> {
    // [R8-1] 名册提交锁先于主门：等待已经开始的提交完成，再切换门状态。
    // 提交路径持有同一锁直到 roster 写入结束，因此门置位后不会再有名册写入。
    {
        let _commit = inner.roster_commit.lock().await;
        *inner.lifecycle_gate.lock().unwrap() = true;
    }
    let mut drain_error: Option<FabricError> = None;
    // R5-R7：置 draining 并唤醒 single-flight 等待者（**不清空**航班表——
    // owner 条目由 FlightGuard 自清理，随后的空表等待观测真实 owner 收敛；
    // 准入与登记同锁，此后 connect 原子拒绝）
    {
        let mut inflight = inner.connect_inflight.lock().await;
        inflight.draining = true;
        // R6 P1：不 drain 航班表——owner 条目保留（其 FlightGuard 在 owner
        // Future 退出时自清理），随后的空表等待因此能观测真实 owner 收敛；
        // send 只为唤醒并发 connect 的 waiter（owner 不等待自身航班）
        for entry in inflight.map.values() {
            let _ = entry.1.send(true);
        }
    }
    let peers = inner.peers.lock().await;
    for entry in peers.values() {
        entry.conn.close(0u32.into(), b"shutdown");
    }
    drop(peers);
    // watcher 先于 endpoint 释放退出（关闭后无任务残留、无后续事件）；
    // guard 在显式作用域内释放，绝不跨 await。
    let watcher_task = { inner.relay_watcher_task.lock().unwrap().take() };
    if let Some(task) = watcher_task {
        task.abort();
        let _ = task.await;
    }
    // c2：会话自动重连 manager 先于 endpoint 释放退出（此后不再派发新的
    // 重拨 worker；已在途的 worker 由 accept_children 登记表统一收割）
    let reconnect_manager = { inner.reconnect_manager_task.lock().unwrap().take() };
    if let Some(task) = reconnect_manager {
        task.abort();
        let _ = task.await;
    }
    // continuity 连接全部 deliberate 关闭（supervisor 不触发重连；watch 置
    // Closing——快照订阅者可观测收尾态）
    inner
        .continuity
        .close_all(
            crate::continuity::state::ConnectionPhase::Closing,
            "shutdown",
        )
        .await;
    inner.endpoint.close().await;
    // [R8-2] 先收割外层 accept loop，再关闭 child registry；loop 退出后不再有
    // 生产者可以把晚到 child push 到已 take 的表中。
    let accept_loop = { inner.accept_loop_task.lock().unwrap().take() };
    if let Some(mut task) = accept_loop {
        let deadline = tokio::time::Instant::now() + DETACHED_CONNECT_SHUTDOWN_TIMEOUT;
        if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
            tracing::warn!("accept loop did not finish after endpoint close; aborting (R8-2)");
            task.abort();
            // [R8-2] abort 只是请求；无条件 join 才能证明外层 loop 已退出，
            // 随后关闭 child registry 不会再遇到晚到生产者。
            let _ = task.await;
        }
    }
    // R5 重排：endpoint 先关——存量 owner 的挂起拨号随即失败退出，随后的
    // 空表等待才是有意义的收敛（关闭中的 endpoint 使拨号必然失败）
    let inflight_deadline = tokio::time::Instant::now() + DETACHED_CONNECT_SHUTDOWN_TIMEOUT;
    while !inner.connect_inflight.lock().await.map.is_empty() {
        if tokio::time::Instant::now() >= inflight_deadline {
            tracing::error!(
                timeout_secs = DETACHED_CONNECT_SHUTDOWN_TIMEOUT.as_secs(),
                "connect inflight not empty after endpoint close; reporting incomplete drain"
            );
            // [R8-3] 记录错误但继续收割 accept/detached 子任务；完成通知只能
            // 在所有可登记任务处理完后发出，首调用仍显式感知未收敛。
            drain_error = Some(FabricError::Session(SessionError::Connect(
                "shutdown incomplete: connect owner did not drain in time".into(),
            )));
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    // HB 4.1：detached connect 任务收尾——endpoint 已关闭，在途 connect
    // 大多随即自然失败；对仍未结束者共享一个 deadline 等待（不取消，
    // 保 P1-10 半开连接规避），超上限 abort 并记 warning。
    // R2 P0-2：置 flag 与 drain 同一临界区——此后到达的登记会被登记侧
    // 本地 abort+await，不再进表；abort 后 join 确认真正退出。
    {
        let tasks: Vec<_> = {
            let mut reg = inner.detached_connects.lock().unwrap();
            reg.shutting_down = true;
            std::mem::take(&mut reg.tasks)
        };
        if !tasks.is_empty() {
            let deadline = tokio::time::Instant::now() + DETACHED_CONNECT_SHUTDOWN_TIMEOUT;
            for mut task in tasks {
                // 经 &mut 借听 timeout：Elapsed 时句柄仍存活，abort 后可再 join
                let abort_handle = task.abort_handle();
                if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                    tracing::warn!(
                        timeout_secs = DETACHED_CONNECT_SHUTDOWN_TIMEOUT.as_secs(),
                        "detached connect task did not finish after endpoint close; \
                         aborting to guarantee clean shutdown (HB 4.1)"
                    );
                    abort_handle.abort();
                    // [R8-2] 不丢弃句柄：取消请求后必须消费 join 结果，避免
                    // detached 任务在完成门之后继续持有 endpoint。
                    let _ = task.await;
                }
            }
        }
    }
    // [R8-2] 外层 loop 已经 join 后才关闭 registry，再收割全部已登记 child。
    {
        let children: Vec<_> = {
            let mut reg = inner.accept_children.lock().unwrap();
            reg.closing = true;
            std::mem::take(&mut reg.tasks)
        };
        let deadline = tokio::time::Instant::now() + DETACHED_CONNECT_SHUTDOWN_TIMEOUT;
        for mut child in children {
            let abort_handle = child.abort_handle();
            if tokio::time::timeout_at(deadline, &mut child).await.is_err() {
                tracing::warn!(
                    "accept child did not finish after endpoint close; aborting (R7 P1-3)"
                );
                abort_handle.abort();
                // [R8-2] abort 后仍等待句柄真正结束，再宣告生命周期完成。
                let _ = child.await;
            }
        }
    }
    // R3/R4 P1-1：完成通知（send_replace 无订阅者也落值，顺序晚到调用即见 true）。
    // [R8-3] 此处之后才允许首调用返回，确保 accept/detached 收尾不会被超时分支跳过。
    inner.shutdown_done.send_replace(true);
    match drain_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// 规范化键比较（R2 P1-4）：配置串与 watcher 报告串可能仅差尾 "/"（url crate
/// 对空路径的规范化）——按 RelayUrl 归一化后比较；任一侧解析失败回退字符串等值。
fn same_relay_url(a: &str, b: &str) -> bool {
    match (a.parse::<iroh::RelayUrl>(), b.parse::<iroh::RelayUrl>()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// relay deny reason 提取（task 2.5 透出通道的第一段）：iroh 上游把
/// `ServerDeniedAuth { reason }` 折进错误链 Display 文本（"The relay denied
/// our authentication (…)"），本函数按服务端冻结语法
/// `dweb/[a-z0-9][a-z0-9._-]{0,63}` 从文本中扫描结构化 reason。
/// reason 由 dweb-server 侧约束生成（ASCII 白名单语法，无凭证/路径段），
/// 透传不违反 D4 脱敏语义；非 deny 错误返回 None。
pub(crate) fn extract_deny_reason(err_text: &str) -> Option<&str> {
    const PREFIX: &str = "dweb/";
    let bytes = err_text.as_bytes();
    let mut start = 0;
    while let Some(pos) = err_text[start..].find(PREFIX) {
        let at = start + pos;
        // 词边界：前一个字符不得是 reason 语法字符（拒绝 "adweb/x" 类内嵌
        // 误命中——deny reason 只以独立 token 出现）
        let boundary_ok = at == 0 || {
            let prev = bytes[at - 1];
            !(prev.is_ascii_alphanumeric() || prev == b'.' || prev == b'_' || prev == b'-')
        };
        // reason 主体：首段 [a-z0-9._-]{1,64}（服务端语法整体上限 64 字符）
        let mut end = at + PREFIX.len();
        let mut count = 0;
        while end < bytes.len() && count < 64 {
            let c = bytes[end];
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'_' || c == b'-' {
                end += 1;
                count += 1;
            } else {
                break;
            }
        }
        // 至少 1 个合法主体字符（"dweb/" 空 reason 不算）
        if boundary_ok && count >= 1 {
            return Some(&err_text[at..end]);
        }
        start = at + PREFIX.len();
    }
    None
}

/// 错误脱敏（D4）：仅输出粗粒度错误类别 + relay host，不含 URL 凭证段与完整路径。
/// server-access-policy task 2.5：`dweb/*` 结构化 deny reason 例外透传——
/// 受限 relay 拒绝接入时，reason 是排障的唯一信号（no-capability/
/// capability-expired/not-recipient 语义各不相同），语法由服务端白名单约束。
fn sanitize_relay_error(err_text: &str) -> String {
    let cleaned: String = err_text
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(reason) = extract_deny_reason(&cleaned) {
        return format!("relay denied: {reason}");
    }
    let lower = cleaned.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        "connect timeout".to_owned()
    } else if lower.contains("connection refused") {
        "connection refused".to_owned()
    } else if lower.contains("dns") || lower.contains("resolve") {
        "dns error".to_owned()
    } else if lower.contains("tls") || lower.contains("certificate") {
        "tls error".to_owned()
    } else {
        // P1-5：未识别错误不再回显原文（可能携带凭证/路径）——固定类别
        "connection error".to_owned()
    }
}

/// 从 relay URL 提取 host（脱敏输出用；失败回退原始串的截断）。
fn relay_url_host(url: &str) -> String {
    url.parse::<iroh::RelayUrl>()
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        // P1-5：解析失败不再回显原始 URL（可能携带凭证段/路径）——固定占位
        .unwrap_or_else(|| "unknown-host".to_owned())
}

#[derive(Debug, Clone)]
pub enum FabricEvent {
    PeerConnected {
        endpoint_id: String,
    },
    PeerDisconnected {
        endpoint_id: String,
    },
    RosterUpdated,
    Message {
        from: String,
        data: Vec<u8>,
    },
    PathChanged {
        endpoint_id: String,
        status: LinkStatus,
    },
    /// 聚合态 offline -> online 跳变。watcher 首值只入快照，不产生本事件。
    /// R3 P1-2：事件携带**跳变后**的完整快照副本——消费侧不得事后读共享可变
    /// 快照（连续跳变时会拿到错配状态）；payload 与 relayStatus() 同构。
    RelayOnline {
        snapshot: RelayStatusSnapshot,
    },
    /// 聚合态 online -> offline 跳变（同上，携带跳变后快照副本）。
    RelayOffline {
        snapshot: RelayStatusSnapshot,
    },
}

#[derive(Debug, Error)]
pub enum FabricError {
    #[error("session: {0}")]
    Session(#[from] SessionError),
    #[error("identity: {0}")]
    Identity(#[from] crate::identity::IdentityError),
    #[error("protocol: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
    #[error("connection: {0}")]
    Connection(#[from] iroh::endpoint::ConnectionError),
    #[error("stream closed")]
    StreamClosed,
    #[error("roster: {0}")]
    Roster(#[from] crate::roster::RosterError),
    #[error("iroh: {0}")]
    Iroh(#[from] iroh::endpoint::BindError),
    #[error("connect: {0}")]
    Connect(#[from] iroh::endpoint::ConnectError),
    #[error("invalid endpoint id: {0}")]
    BadEndpointId(String),
    #[error("already shutdown")]
    Shutdown,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error(
        "data dir {0} has no identity; open() does not create one (use create_root/attach/join)"
    )]
    MissingIdentity(String),
    #[error("identity {0} does not match the roster (not root and not an effective member)")]
    IdentityRosterMismatch(String),
    #[error("secret export/import: {0}")]
    SecretExport(#[from] crate::secret::SecretExportError),
    /// D3 签发安全门：relay 为空且 advertise_addrs 为空且未显式 allow_relayless。
    /// 令牌已知不可兑换（一次性进程直连地址随进程退出即死），内核不签发
    /// 不可达的信任凭据。
    #[error(
        "cannot issue an invite token with no relay URL and no advertise_addrs: the token \
         would be permanently unreachable. Configure a relay, set advertise_addrs, or pass \
         allow_relayless explicitly (the caller then owns out-of-band reachability)"
    )]
    InviteWithoutRelay,
    /// join 网络工作流的稳定归类（D11 八码）。message 为可操作细节（ASCII）；
    /// kebab 前缀由绑定层按 error-matrix 冻结集合添加（避免双重前缀）。
    #[error("{message}")]
    Join {
        code: JoinErrorCode,
        message: String,
    },
    /// advertise_addrs 构造期校验失败。
    #[error("invalid advertise address '{addr}': {reason}")]
    BadAdvertiseAddr { addr: String, reason: String },
    /// httpProxy URL 形态解析失败。
    #[error("invalid proxy URL '{0}'")]
    BadProxyUrl(String),
    /// relay TLS 自定义 CA 的 PEM 解析失败（HB 5.1 构造期校验）。
    #[error("invalid relay TLS CA PEM: {0}")]
    BadRelayTlsPem(String),
    /// join_timeout_ms 越界（值域 [1000, 600000]）。
    #[error("join_timeout_ms {0} out of range [1000, 600000]")]
    JoinTimeoutOutOfRange(u64),
    /// bind_addr 非法。
    #[error("invalid bind address '{0}'")]
    BadBindAddr(String),
    /// v2 邀请签发但未给 recipient（附录 A：v2 recipient 恒必填——restricted
    /// relay 的 bootstrap capability 必须预绑定接收者，task 2.1）。
    #[error(
        "v2 invites require an explicit recipient: the relay capability embedded in a dweb2. \
         token must be pre-bound to the invitee's EndpointId (appendix A)"
    )]
    InviteV2RequiresRecipient,
    /// 成员 relay capability 存档（relay.caps.json）读写失败（task 2.3；
    /// capability 是 bearer 凭证，损坏不静默吞掉）。
    #[error("relay capability store {path}: {reason}")]
    RelayCapsStore { path: PathBuf, reason: String },
}

struct PeerEntry {
    conn: Connection,
    link: Arc<std::sync::Mutex<LinkStatus>>,
    #[allow(dead_code)] // 控制流保留给后续增量 FACT 帧；v0.1 HELLO 后暂不使用
    ctrl_send: Arc<Mutex<endpoint::SendStream>>,
    /// 连接是否已关闭（watcher 异步置位；幂等快捷路径据此判断存活）
    closed: Arc<std::sync::atomic::AtomicBool>,
    /// 连接代次：旧连接的 watcher 只允许删除同代次条目
    epoch: u64,
}

/// single-flight 航班条目：(generation, completed watch sender)
type FlightEntry = Arc<(u64, tokio::sync::watch::Sender<bool>)>;

/// single-flight owner 的 RAII guard（R7 P1-1）：Drop 时只清理仍指向自身
/// generation 的航班并广播完成；try_lock 失败时 spawn 异步重试，不以无重试
/// try_lock 作为唯一取消路径。
struct FlightGuard {
    inner: Arc<FabricInner>,
    id: EndpointId,
    generation: u64,
}

/// single-flight 航班状态（R5 P1-1）：draining 与航班 map 同锁。
#[derive(Default)]
struct InflightState {
    draining: bool,
    map: HashMap<EndpointId, FlightEntry>,
}

/// 生命周期任务登记表（accept child + 连接附属 watcher）。[R8-2] `closing`
/// 只在外层 accept loop 与 inflight producer 都收敛后置位，因而 take 之后不存在
/// 晚到生产者。
#[derive(Default)]
pub(crate) struct AcceptChildren {
    pub(crate) closing: bool,
    pub(crate) tasks: Vec<tokio::task::JoinHandle<()>>,
}

/// 注册一个生命周期任务；closing 后返回句柄给调用方立即 abort+join。
pub(crate) fn register_lifecycle_task(
    registry: &std::sync::Mutex<AcceptChildren>,
    task: tokio::task::JoinHandle<()>,
) -> Option<tokio::task::JoinHandle<()>> {
    let mut reg = registry.lock().unwrap();
    if reg.closing {
        Some(task)
    } else {
        reg.tasks.push(task);
        None
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        let inner = Arc::clone(&self.inner);
        let id = self.id;
        let generation = self.generation;
        let cleanup = |inflight: &mut HashMap<EndpointId, FlightEntry>| {
            if inflight.get(&id).is_some_and(|e| e.0 == generation)
                && let Some(entry) = inflight.remove(&id)
            {
                let _ = entry.1.send(true);
            }
        };
        match inner.connect_inflight.try_lock() {
            Ok(mut guard) => cleanup(&mut guard.map),
            Err(_) => {
                // 与 shutdown/其它 connect 竞争：spawn 异步重试清理
                let inner = Arc::clone(&inner);
                tokio::spawn(async move {
                    let mut guard = inner.connect_inflight.lock().await;
                    if guard.map.get(&id).is_some_and(|e| e.0 == generation)
                        && let Some(entry) = guard.map.remove(&id)
                    {
                        let _ = entry.1.send(true);
                    }
                });
            }
        }
    }
}

pub struct FabricInner {
    pub(crate) identity: NodeIdentity,
    pub(crate) roster: Arc<Mutex<Roster>>,
    /// [R8-1] 所有运行时名册写入的提交锁；shutdown 先等它，再置生命周期门。
    roster_commit: Mutex<()>,
    pub(crate) endpoint: Endpoint,
    peers: Arc<Mutex<HashMap<EndpointId, PeerEntry>>>,
    events: broadcast::Sender<FabricEvent>,
    pub(crate) relay: RelayConfig,
    advertise_addrs: Vec<String>,
    /// endpoint 的 RelayMap 共享句柄（task 2.2；Custom/CustomWithCaps 才有，
    /// N0Default/Disabled 上游预设不暴露注入面）。运行期热注入 = 对该 map
    /// insert 带 auth token 的条目——iroh socket 持同一内部 RwLock，即时生效。
    relay_map: Option<iroh_relay::RelayMap>,
    /// data_dir（relay.caps.json 落盘路径来源，task 2.3）。
    data_dir: PathBuf,
    /// 成员 relay capability 内存视图（加载自 relay.caps.json；join OK2
    /// 后 upsert + 回写）。std 锁：读写均为短临界区，无 await。
    relay_caps: std::sync::Mutex<Vec<(String, String)>>,
    /// 从邀请令牌/连接学到的对端可达信息（relay URL 或 ip:port）；
    /// 有界（HB 3.1：per-endpoint 1024 地址 / 全局 65536 endpoint，FIFO 淘汰）。
    pub(crate) known_addrs: Mutex<KnownAddrs>,
    /// 近期主动断开的对端与时刻：connect 预沉降用（iroh 同 NodeId 去重窗口）。
    recent_disconnects: Mutex<HashMap<EndpointId, std::time::Instant>>,
    /// connect 的 per-EndpointId single-flight（R7）：entry 携带 generation，
    /// owner guard 精确清理自身代次（旧 owner 不误删新 owner 的航班）。
    flight_generation: std::sync::atomic::AtomicU64,
    /// single-flight 航班表（R5 P1-1）：draining 与 map 同锁——connect 的准入
    /// 检查与登记在同一临界区原子完成，shutdown 置 draining 后无新航班越过
    /// 完成门。
    connect_inflight: Mutex<InflightState>,
    /// peer 连接代次计数器（防旧 watcher 误删新连接）
    peer_epoch: std::sync::atomic::AtomicU64,
    /// relay 状态快照缓存（D4：快照先于事件可用；std 锁，读取零等待）。
    relay_snapshot: Arc<std::sync::Mutex<RelayStatusSnapshot>>,
    /// home relay watcher 任务（Disabled 模式不启动；shutdown 显式 abort + join）。
    relay_watcher_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// detached connect 任务登记（HB 4.1）：join deadline 到期后 connect
    /// wrapper 任务在后台自然跑完（P1-10 不取消语义）；shutdown 收尾时等待
    /// 其退出（上限 [`DETACHED_CONNECT_SHUTDOWN_TIMEOUT`]，超时 abort +
    /// warning）。已自然结束的句柄在下次登记时惰性清理。
    /// R2 P0-2：`shutting_down` 与任务表同锁——登记侧见 flag 即本地 abort+await，
    /// 关闭侧置 flag 与 drain 在同一临界区完成，消灭"spawn 后、登记前"的
    /// 关闭后残留窗口。
    detached_connects: std::sync::Mutex<DetachedConnects>,
    /// shutdown 请求门（[R8-1]）：首调用同步置位，先拒绝新的提交/事件；最终
    /// lifecycle_gate 会在 roster_commit 排空后置位，二阶段切换保证无门后写入。
    shutdown_started: Arc<std::sync::Mutex<bool>>,
    /// 生命周期主门（[R8-1]）：shutdown drain 在 roster_commit 之后置 true，
    /// 与全部事件发送/peer 插入临界区互斥；send 端持锁完成检查+发送，杜绝
    /// “检查后悬挂、完成后补发”的窗口。门置位后抑制后续生命周期事件。
    lifecycle_gate: Arc<std::sync::Mutex<bool>>,
    /// 已接受连接的处理子任务（R8-2）：外层 loop join 后关闭登记，再逐个收割。
    pub(crate) accept_children: std::sync::Mutex<AcceptChildren>,
    /// c2 会话自动重连：意外死亡通知通道（closed_task 同代次分支发送；
    /// UnboundedSender clone 进 FabricInner，manager 消费）。
    reconnect_tx: tokio::sync::mpsc::UnboundedSender<EndpointId>,
    /// c2 会话自动重连监管 manager（start() 常驻；shutdown 显式 abort + join）。
    reconnect_manager_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 外层 accept loop 本身也纳入 shutdown 收敛证明。
    accept_loop_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// shutdown 完成通知（R3 P1-1）：true 后 watch 订阅者立即放行
    pub(crate) shutdown_done: tokio::sync::watch::Sender<bool>,
    /// 生效代理策略是否为 none（RELAY_OFFLINE 探针适用条件之一）。
    proxy_is_none: bool,
    /// join 总时限（毫秒）。
    join_timeout_ms: u64,
    /// continuity 连接状态面（app-protocol-layer Phase 1）：快照/epoch/
    /// stateSeq watch；死亡重连只进 watch，不发 FabricEvent。
    pub(crate) continuity: crate::continuity::ContinuityState,
    /// continuity 拨号 single-flight（per-peer）。
    pub(crate) continuity_dialing: crate::continuity::manager::DialingGuard,
    /// continuity 会话注册表（app-protocol-layer Phase 2）：provider 侧常驻
    /// （跨连接存活；进程重启即丢——RESUME 统一 REQUEST_STATE_LOST）。
    pub(crate) continuity_sessions: crate::continuity::session::SessionRegistry,
    /// continuity 发起侧 campaign 登记（R3-3c：双端并发 INIT 的全序裁决面）。
    pub(crate) continuity_campaigns: crate::continuity::session::CampaignMap,
}

impl FabricInner {
    /// 生命周期门控事件发送。[R8-1] 检查与同步 send 在同一 std 锁临界区，
    /// 禁止“检查后悬挂、门置位后补发”；调用方不得在该临界区等待异步锁。
    pub(crate) fn emit_gated_on(
        lifecycle_gate: &std::sync::Mutex<bool>,
        shutdown_requested: &std::sync::Mutex<bool>,
        events: &broadcast::Sender<FabricEvent>,
        ev: FabricEvent,
    ) {
        // 固定锁序 request -> gate；两把锁均为同步检查，绝不跨 await。
        let requested = shutdown_requested.lock().unwrap();
        if *requested {
            return;
        }
        let live = !*lifecycle_gate.lock().unwrap();
        if live {
            let _ = events.send(ev);
        }
    }

    /// 已持 request/gate 锁时的同步发送；调用方必须保证两把锁的生命周期不跨 await。
    fn emit_gated_locked(&self, requested: bool, closed: bool, ev: FabricEvent) {
        if !requested && !closed {
            let _ = self.events.send(ev);
        }
    }

    /// 生命周期门控事件发送（R7）：与 shutdown 置位同锁——持锁期间完成
    /// 检查与发送（send 为同步操作，锁内无 await），draining 后零事件。
    fn emit_gated(&self, ev: FabricEvent) {
        Self::emit_gated_on(
            &self.lifecycle_gate,
            &self.shutdown_started,
            &self.events,
            ev,
        );
    }

    pub(crate) fn lifecycle_closing(&self) -> bool {
        // [R8-1] 按 request -> gate 读取一致快照；两把同步锁均在本函数内
        // 释放，调用方不得把任一 guard 带过 await。
        let requested = self.shutdown_started.lock().unwrap();
        if *requested {
            return true;
        }
        *self.lifecycle_gate.lock().unwrap()
    }

    fn shutting_down_error() -> FabricError {
        FabricError::Session(SessionError::Connect("fabric is shutting down".into()))
    }
}

#[derive(Clone)]
pub struct Fabric {
    pub(crate) inner: Arc<FabricInner>,
}

/// store 路径的身份解析：load 命中即用；缺失时按 allow_create 决定
/// create（create_root/attach）或 MissingIdentity（open——绝不静默生成）。
fn resolve_from_store(
    store: &dyn crate::secret::SecretStore,
    data_dir: &std::path::Path,
    allow_create: bool,
) -> Result<NodeIdentity, FabricError> {
    match store.load() {
        Ok(Some(seed)) => Ok(NodeIdentity::from_seed(*seed.as_bytes())),
        Ok(None) if allow_create => NodeIdentity::with_store(store).map_err(FabricError::Identity),
        Ok(None) => Err(FabricError::MissingIdentity(data_dir.display().to_string())),
        Err(e) => Err(FabricError::Identity(e.into())),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- join 分类总函数的组成件（D11） ---------------------------------------------

/// join 前置检查（步骤 1-3）：解码失败 -> TOKEN_INVALID；过期 -> TOKEN_EXPIRED；
/// relay_url 非空但不可解析 / 直连地址不可解析 -> TOKEN_INVALID（附原因）。
/// 公开供 SDK 的 joinWithToken 在消费身份句柄/加载本地数据面之前调用，
/// 保证「令牌自身错误优先于目录检查」的冻结顺序。
///
/// 本函数是**仅支持 v1 的路径**（附录 A2 兼容矩阵"v1 joiner"列）：
/// `dweb2.` 令牌报第九码 [`JoinErrorCode::UnsupportedInviteVersion`]
/// （含升级指引，不静默降级为 token-invalid）。v2 令牌的完整前置检查
/// 见 [`precheck_join_token_v2`]；[`Fabric::join`] 按前缀分派。
pub fn precheck_join_token(token_str: &str) -> Result<crate::protocol::InviteToken, FabricError> {
    let token = crate::protocol::InviteToken::decode(token_str).map_err(|e| {
        // 附录 A2：版本不支持是第九码，不是"令牌损坏"——分开映射，
        // SDK 才能给出正确的升级指引而非"找 inviter 重签"
        match &e {
            crate::protocol::ProtocolError::UnsupportedInviteVersion(why) => FabricError::Join {
                code: JoinErrorCode::UnsupportedInviteVersion,
                message: format!(
                    "this is a v2 (dweb2.) invite token and this code path supports v1 only; \
                     upgrade the SDK to redeem it ({why})"
                ),
            },
            _ => FabricError::Join {
                code: JoinErrorCode::TokenInvalid,
                message: format!(
                    "the invite token is malformed or has a bad signature; ask the inviter for \
                     a new one ({e})"
                ),
            },
        }
    })?;
    if token.is_expired(now_ms()) {
        return Err(FabricError::Join {
            code: JoinErrorCode::TokenExpired,
            message: format!(
                "the invite token has expired (expired at {} ms); ask the inviter for a new one",
                token.invite.expires_at_ms
            ),
        });
    }
    if !token.invite.issuer_relay_url.is_empty()
        && token
            .invite
            .issuer_relay_url
            .parse::<iroh::RelayUrl>()
            .is_err()
    {
        return Err(FabricError::Join {
            code: JoinErrorCode::TokenInvalid,
            message: format!(
                "token relay URL is not parseable: '{}'",
                token.invite.issuer_relay_url
            ),
        });
    }
    for a in &token.invite.issuer_direct_addrs {
        if a.parse::<std::net::SocketAddr>().is_err() {
            return Err(FabricError::Join {
                code: JoinErrorCode::TokenInvalid,
                message: format!("token direct address is not a parseable ip:port: '{a}'"),
            });
        }
    }
    Ok(token)
}

/// v2 令牌前置检查（task 2.1；与 [`precheck_join_token`] 同一冻结顺序）：
/// 解码（附录 A 全部校验含 capability 一致性）→ 过期 → relay URL 可解析
/// （直连地址是二进制 SocketAddr，解码期已定形，无字符串再解析步）。
pub fn precheck_join_token_v2(
    token_str: &str,
) -> Result<crate::protocol::InviteV2Token, FabricError> {
    let token =
        crate::protocol::InviteV2Token::decode(token_str).map_err(|e| FabricError::Join {
            code: JoinErrorCode::TokenInvalid,
            message: format!(
                "the invite token is malformed or has a bad signature; ask the inviter for a new \
                 one ({e})"
            ),
        })?;
    if token.is_expired(now_ms()) {
        return Err(FabricError::Join {
            code: JoinErrorCode::TokenExpired,
            message: format!(
                "the invite token has expired (expired at {} ms); ask the inviter for a new one",
                token.invite.expires_at_ms
            ),
        });
    }
    for relay in &token.invite.relays {
        if relay.url.parse::<iroh::RelayUrl>().is_err() {
            return Err(FabricError::Join {
                code: JoinErrorCode::TokenInvalid,
                message: format!("token relay URL is not parseable: '{}'", relay.url),
            });
        }
    }
    Ok(token)
}

/// join 步骤 7 的阶段化结果：deadline 到期时关闭已建立的连接后上报。
enum JoinPhaseError {
    /// connect 立即错误（拒绝/DNS/协议）。
    Connect(iroh::endpoint::ConnectError),
    /// redeem 阶段失败（结构化拒绝 / 非结构化 / 内层 5s 超时）。
    Redeem(session::RedeemError),
    /// 外层 join deadline 到期（joinTimeoutMs <= 5s 时拥有唯一结果）。
    DeadlineElapsed,
}

/// detached connect 任务 shutdown 等待上限（HB 4.1）：endpoint 关闭后残留
/// 的后台 connect 最多再等 5s 自然结束，超时 abort（保证进程退出无悬挂）。
const DETACHED_CONNECT_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 单次 send 的网络 I/O 上限（R9 P1）：open_bi + write + finish 的流控等待
/// 有界化——对端停读/额度耗尽时调用方拿到明确超时，而非无限期挂起。
const SEND_IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// detached connect 登记表（R2 P0-2）：flag 与任务表同锁构成状态机——
/// 登记与"开始关闭"互斥，关闭开始后到达的句柄由登记方本地 abort + await
/// 收割（不进表），保证 shutdown 返回后 `tasks` 恒空、无悬挂任务。
#[derive(Default)]
struct DetachedConnects {
    shutting_down: bool,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

/// deadline 包住 connect + redeem 的完整网络工作流。到期取消等待并关闭
/// 已建立的连接。成功返回 (conn, facts, relay_caps)——由调用方关闭连接
/// 并 merge（v1 路径 caps 恒空；v2 为 OK2 附发段，task 2.4）。
async fn join_with_deadline(
    endpoint: &Endpoint,
    detached: &std::sync::Mutex<DetachedConnects>,
    addr: &EndpointAddr,
    token: &crate::protocol::InviteVersion,
    secret: &iroh_base::SecretKey,
    redeemer: &EndpointId,
    timeout: std::time::Duration,
) -> Result<
    (
        Connection,
        Vec<crate::protocol::SignedFact>,
        Vec<(String, String)>,
    ),
    JoinPhaseError,
> {
    let deadline = tokio::time::Instant::now() + timeout;
    // connect 不被取消（P1-10：取消中的 iroh connect 会留下半开连接卡死该
    // NodeId 的后续拨号）。deadline 语义用 spawn 承载：到期时任务在后台自然
    // 跑完（iroh 内部超时或成功后 drop connection），此处直接归类超时。
    // HB 4.1：connect 包一层 wrapper 任务，结果经 oneshot 回传（oneshot 接收
    // 端 cancel-safe）；wrapper 句柄登记进 shutdown 可等待集合——JoinHandle
    // 非 Clone，不能既 await 又登记，wrapper 化后句柄专职登记、oneshot 专职
    // 传值。deadline 到期时接收端 drop，wrapper 的 send 落空无害。
    let ep = endpoint.clone();
    let addr = addr.clone();
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    let connect_task = tokio::spawn(async move {
        let conn = ep.connect(addr, ALPN_REDEEM).await;
        let _ = result_tx.send(conn);
    });
    // abort 句柄先行获取：登记（move 进表）与本地收割（abort 路径）两分支互斥，
    // 但借用检查器无法感知——Option::take + 提前分流 abort 能力避免 use-after-move。
    let abort_handle = connect_task.abort_handle();
    let mut connect_task = Some(connect_task);
    // R2 P0-2：登记与"开始关闭"同锁互斥。关闭已开始（shutdown 置 flag 后）
    // 到达的句柄不再进表——本地 abort + await 收割后按超时归类返回，
    // 保证 shutdown() 返回后登记表恒空。锁守卫严格限定在同步块内（不跨 await）。
    let arrived_after_shutdown = {
        let mut reg = detached.lock().unwrap();
        if reg.shutting_down {
            true
        } else {
            reg.tasks.retain(|t| !t.is_finished());
            reg.tasks.push(connect_task.take().expect("exactly once"));
            false
        }
    };
    if arrived_after_shutdown {
        abort_handle.abort();
        // abort 后无条件 join 确认退出（[R8-2]：不得把"已请求取消"当作"已退出"）。
        let task = connect_task.take().expect("exactly once");
        let _ = task.await;
        return Err(JoinPhaseError::DeadlineElapsed);
    }
    let conn = match tokio::time::timeout_at(deadline, result_rx).await {
        // 外层 deadline 到期（connect 阶段）：任务继续后台运行至自然结束
        Err(_) => return Err(JoinPhaseError::DeadlineElapsed),
        // wrapper 被中断（shutdown abort / runtime 关闭等罕见情形）——按超时归类
        Ok(Err(_recv)) => return Err(JoinPhaseError::DeadlineElapsed),
        Ok(Ok(Err(e))) => return Err(JoinPhaseError::Connect(e)),
        Ok(Ok(Ok(conn))) => conn,
    };
    // redeem 阶段按令牌版本分派（v1 = 既有 redeem_as_joiner；v2 =
    // redeem_v2_as_joiner，附录 A2 OK2 回执）；外层 deadline 语义两版一致
    let redeem_result = match token {
        crate::protocol::InviteVersion::V1(t) => tokio::time::timeout_at(
            deadline,
            session::redeem_as_joiner(&conn, t, secret, redeemer),
        )
        .await
        .map(|r| r.map(|facts| (facts, Vec::new()))),
        crate::protocol::InviteVersion::V2(t) => tokio::time::timeout_at(
            deadline,
            session::redeem_v2_as_joiner(&conn, t, secret, redeemer),
        )
        .await
        .map(|r| r.map(|receipt| (receipt.facts, receipt.relay_caps))),
    };
    match redeem_result {
        // 外层 deadline 到期（redeem 阶段）：等值边界下外层拥有唯一结果
        Err(_) => {
            conn.close(0u32.into(), b"join-timeout");
            Err(JoinPhaseError::DeadlineElapsed)
        }
        Ok(Err(e)) => {
            // 两路（内层 5s / 非结构化失败）都关闭连接（7d 契约）；
            // close 幂等，对端已关时无害。
            conn.close(0u32.into(), b"redeem-failed");
            Err(JoinPhaseError::Redeem(e))
        }
        Ok(Ok((facts, caps))) => Ok((conn, facts, caps)),
    }
}

/// redeem 阶段错误归类：结构化拒绝 -> TOKEN_CONSUMED / TOKEN_INVALID；
/// 非结构化失败 -> DIAL_FAILED（附原因）；内层 5s 超时 -> DIAL_TIMEOUT
///（附注 redeem timeout，不落入非结构化失败泛化分支）。
fn map_redeem_error(e: &session::RedeemError) -> FabricError {
    match e {
        session::RedeemError::Rejected(rejection) => match rejection {
            session::redeem_err::RedeemRejection::Consumed => FabricError::Join {
                code: JoinErrorCode::TokenConsumed,
                message: "this invite token was already used; invites are single-use".to_owned(),
            },
            session::redeem_err::RedeemRejection::Invalid { reason } => FabricError::Join {
                code: JoinErrorCode::TokenInvalid,
                message: format!(
                    "the issuer rejected the token: {reason}; ask the inviter for a new one"
                ),
            },
        },
        session::RedeemError::Unstructured(reason) => FabricError::Join {
            code: JoinErrorCode::DialFailed,
            message: format!("redeem channel failed: {reason}"),
        },
        session::RedeemError::Timeout => FabricError::Join {
            code: JoinErrorCode::DialTimeout,
            message: "redeem timeout: the issuer accepted the connection but did not complete \
                      the redemption"
                .to_owned(),
        },
    }
}

/// RELAY_OFFLINE 探针适用条件（全部成立）：
/// 1. 令牌含 relay URL 且无直连地址；
/// 2. 生效代理策略为 none（无代理时直连探针才与 iroh 实际路径一致）。
fn probe_applies(token: &crate::protocol::InviteToken, proxy_is_none: bool) -> bool {
    !token.invite.issuer_relay_url.is_empty()
        && token.invite.issuer_direct_addrs.is_empty()
        && proxy_is_none
}

/// 可替换的 relay 探针函数句柄（测试注入；默认 = 真 TCP 探针）。
pub type RelayProbeFn = Arc<
    dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

/// 全局探针覆盖（仅测试注入使用；None = 默认真实探针）。
static RELAY_PROBE_OVERRIDE: std::sync::RwLock<Option<RelayProbeFn>> = std::sync::RwLock::new(None);

/// 测试注入口：替换 relay TCP 探针（传 None 恢复默认）。
#[doc(hidden)]
pub fn set_relay_probe_for_tests(probe: Option<RelayProbeFn>) {
    *RELAY_PROBE_OVERRIDE.write().unwrap() = probe;
}

/// transport-only TCP 探针：对 relay URL 的 socketaddr 做 TcpStream::connect
///（域名先解析、取解析器首个地址、DNS 计入 2s 预算、无显式端口按 scheme 默认）。
/// TCP 成功只证明传输可达，不证明 relay 协议可用（协议死归 DIAL_FAILED）。
async fn run_relay_probe(relay_url: &str) -> bool {
    // 显式作用域：guard 绝不跨 await 存活（Send 约束）
    let probe = { RELAY_PROBE_OVERRIDE.read().unwrap().clone() };
    if let Some(probe) = probe {
        return probe(relay_url.to_owned()).await;
    }
    default_relay_probe(relay_url).await
}

async fn default_relay_probe(relay_url: &str) -> bool {
    // 阻塞式 DNS/TCP 在工作线程执行；整体套 2s 预算（DNS 计入预算，
    // 超时按探针失败处理，残留阻塞任务自行结束）。
    static INIT: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let semaphore = INIT.get_or_init(|| tokio::sync::Semaphore::new(1));
    let permit = match semaphore.try_acquire() {
        Ok(p) => p,
        Err(_) => return false, // 已有在途探针：按失败处理，不堆积
    };
    let url = relay_url.to_owned();
    // P1-1（R3）：permit move 进闭包——后台阻塞任务结束前始终占用唯一
    // 信号量，外层 timeout 只停止等待，第二个探针在任务真正结束前拿不到
    // permit，阻塞池占用有硬上界（1）。
    let blocking = tokio::task::spawn_blocking(move || {
        let _permit_held = permit;
        let Ok(url) = url.parse::<iroh::RelayUrl>() else {
            return false;
        };
        let Some(host) = url.host_str().map(str::to_owned) else {
            return false;
        };
        let Some(port) = url.port_or_known_default() else {
            return false;
        };
        use std::net::ToSocketAddrs;
        let addr = match host.parse::<std::net::IpAddr>() {
            Ok(ip) => std::net::SocketAddr::new(ip, port),
            Err(_) => match (host.as_str(), port).to_socket_addrs() {
                Ok(mut it) => match it.next() {
                    Some(a) => a,
                    None => return false,
                },
                Err(_) => return false,
            },
        };
        std::net::TcpStream::connect_timeout(&addr, RELAY_PROBE_BUDGET).is_ok()
    });
    tokio::time::timeout(RELAY_PROBE_BUDGET, blocking)
        .await
        .map(|r| r.unwrap_or(false))
        .unwrap_or(false)
}

/// iroh RelayStatus → 可确定性构造的视图（错误经脱敏为类别文本）。
impl<'a> From<&'a iroh::endpoint::RelayStatus> for RelayStatusView {
    fn from(s: &'a iroh::endpoint::RelayStatus) -> Self {
        Self {
            url: s.url().to_string(),
            connected: s.is_connected(),
            last_error: s
                .last_error()
                .map(|e| sanitize_relay_error(&format!("{e:#}"))),
        }
    }
}

/// iroh 状态流 → 视图流适配器（watcher 消费入口）。
struct RelayViewStream<S>(S);

impl<S> n0_future::Stream for RelayViewStream<S>
where
    S: n0_future::Stream<Item = Vec<iroh::endpoint::RelayStatus>> + Unpin,
{
    type Item = Vec<RelayStatusView>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let inner = self.get_mut();
        std::pin::Pin::new(&mut inner.0)
            .poll_next(cx)
            .map(|opt| opt.map(|v| v.iter().map(Into::into).collect()))
    }
}

// ---- relay watcher（D4） --------------------------------------------------------

/// 消费 home relay 状态流：聚合（任一连接即 online）、跳变触发、快照缓存先于
/// 广播、首值只入快照不广播。泛型于状态流以支持确定性注入测试。
pub(crate) async fn relay_watch_loop<S>(
    mut stream: S,
    config_urls: Vec<String>,
    snapshot: Arc<std::sync::Mutex<RelayStatusSnapshot>>,
    lifecycle_gate: Arc<std::sync::Mutex<bool>>,
    shutdown_requested: Arc<std::sync::Mutex<bool>>,
    events_tx: broadcast::Sender<FabricEvent>,
) where
    S: n0_future::Stream<Item = Vec<RelayStatusView>> + Unpin,
{
    use n0_future::StreamExt;
    let mut initialized = false;
    let mut last_online: Option<bool> = None;
    while let Some(views) = stream.next().await {
        // [R8-1] 门置位后 watcher 直接退出；事件发送仍经原子门控辅助函数。
        if *shutdown_requested.lock().unwrap() || *lifecycle_gate.lock().unwrap() {
            break;
        }
        let agg = aggregate_relay_status(&config_urls, &views);
        let snapshot_now = {
            let mut snap = snapshot.lock().unwrap();
            snap.online = Some(agg.online);
            snap.active_url = agg.online_url.clone();
            snap.last_error = agg.last_error.clone();
            snap.clone()
        };
        debug_assert!(snapshot_invariant(&snapshot_now), "快照自洽不变量");
        // 首值只更新快照缓存，不广播（初始状态必须经快照 API 获取）。
        if initialized {
            if last_online != Some(agg.online) {
                let ev = if agg.online {
                    FabricEvent::RelayOnline {
                        snapshot: snapshot_now,
                    }
                } else {
                    FabricEvent::RelayOffline {
                        snapshot: snapshot_now,
                    }
                };
                FabricInner::emit_gated_on(&lifecycle_gate, &shutdown_requested, &events_tx, ev);
            }
        } else {
            initialized = true;
        }
        last_online = Some(agg.online);
    }
}

impl Fabric {
    /// 按 SecretInjection 解析身份。
    /// - `Default`/`Store`：`ensure_with`（load，缺失则 create；并发不分叉）
    /// - `Seed`：纯注入，零存储副作用
    fn resolve_identity(
        config: &FabricConfig,
        allow_create: bool,
    ) -> Result<NodeIdentity, FabricError> {
        match &config.secret {
            SecretInjection::Seed(seed) => Ok(NodeIdentity::from_seed(*seed.as_bytes())),
            SecretInjection::Store(store) => {
                resolve_from_store(store.as_ref(), &config.data_dir, allow_create)
            }
            SecretInjection::Default => {
                let store = crate::secret::FileSecretStore::new(&config.data_dir);
                resolve_from_store(&store, &config.data_dir, allow_create)
            }
        }
    }

    /// 创建新 fabric（本节点成为 root）。既有 roster 先报 AlreadyExists——
    /// 在解析/写入身份之前检查，失败路径不留任何 identity 副作用。
    pub async fn create_root(config: FabricConfig) -> Result<Self, FabricError> {
        // 配置完整校验先于一切持久化副作用（P1-3）：非法配置不写目录
        config.validate()?;
        if crate::roster::roster_file_path(&config.data_dir).exists() {
            return Err(FabricError::Roster(
                crate::roster::RosterError::AlreadyExists {
                    path: crate::roster::roster_file_path(&config.data_dir),
                },
            ));
        }
        let identity = Self::resolve_identity(&config, true)?;
        let (roster, _fid) = Roster::create(&identity, &config.data_dir, now_ms())?;
        Self::start(identity, roster, config).await
    }

    /// 打开已有 fabric。**缺失身份是错误**（不静默生成新身份——那会制造一个
    /// 无成员关系的孤儿身份）；身份必须是 root 或有效成员（seed-roster 一致性）。
    pub async fn open(config: FabricConfig) -> Result<Self, FabricError> {
        config.validate()?;
        let identity = Self::resolve_identity(&config, false)?;
        let fid = crate::roster::peek_fabric_id(&config.data_dir)?.ok_or(
            crate::roster::RosterError::NotFound {
                path: crate::roster::roster_file_path(&config.data_dir),
            },
        )?;
        let roster = Roster::open(&config.data_dir, fid)?;
        let id = identity.endpoint_id();
        if !roster.is_member(&id, now_ms()) {
            return Err(FabricError::IdentityRosterMismatch(endpoint_id_display(
                &id,
            )));
        }
        Self::start(identity, roster, config).await
    }

    /// 以加入者身份起步（空名册，等待 join 写入事实）；允许创建新身份。
    /// 名册非空时（曾经 join 过）同样校验身份一致性。
    pub async fn attach(config: FabricConfig, fabric_id_hex: &str) -> Result<Self, FabricError> {
        config.validate()?;
        let identity = Self::resolve_identity(&config, true)?;
        // fabric_id 以 hex 传递；z32 不适合 32B 演示（避免双编码），此处 hex 是内部参数而非展示串
        let mut buf = [0u8; 32];
        hex::decode_to_slice(fabric_id_hex, &mut buf)
            .map_err(|_| FabricError::BadEndpointId(fabric_id_hex.to_owned()))?;
        let roster = Roster::attach(&config.data_dir, crate::protocol::FabricId(buf))?;
        if !roster.is_empty() {
            let id = identity.endpoint_id();
            if !roster.is_member(&id, now_ms()) {
                return Err(FabricError::IdentityRosterMismatch(endpoint_id_display(
                    &id,
                )));
            }
        }
        Self::start(identity, roster, config).await
    }

    /// 显式导出身份（identity export，不含 roster）为 `dwebkey1.` 加密串。
    pub fn export_secret(&self, passphrase: &str) -> Result<String, FabricError> {
        Ok(crate::secret::export_secret(
            &self.inner.identity,
            passphrase,
        )?)
    }

    async fn start(
        identity: NodeIdentity,
        roster: Roster,
        config: FabricConfig,
    ) -> Result<Self, FabricError> {
        // 构造期校验（D3/D7/join 时限）：非法配置不进入运行。
        config.validate()?;
        let advertise_addrs = normalize_advertise_addrs(&config.advertise_addrs)?;
        // HB 8.1 + R2 P1-4：对外快照（urls / active_url）保持**配置原样字符串**
        // （主规格 sdk/node 与 C0 契约冻结无尾斜杠形态，消费者做字符串比较）。
        // watcher 报告的是 RelayUrl 规范化形态（空路径补 "/"）——聚合匹配在
        // aggregate_relay_status 内部经规范化键比较（same_relay_url），此处仅
        // 做可解析性校验（构造期 fail-fast），不改写存储值。
        let validate_relay_url = |u: &str| -> Result<(), FabricError> {
            u.parse::<iroh::RelayUrl>()
                .map(|_| ())
                .map_err(|e: iroh::RelayUrlParseError| {
                    FabricError::Session(SessionError::Connect(format!(
                        "invalid relay url {u}: {e}"
                    )))
                })
        };
        let relay_config_urls: Vec<String> = match &config.relay {
            RelayConfig::Disabled => Vec::new(),
            RelayConfig::Custom(urls) => {
                for u in urls {
                    validate_relay_url(u)?;
                }
                urls.clone()
            }
            // R3 P1-4：N0 的候选列表 = iroh 上游默认 relay map 的真实 URL
            //（4 个区域节点）——与 Endpoint::builder(presets::N0) 实际拨号一致，
            // 消除“对外公告单条 canonical、实际连接区域节点”的配置/状态错配
            //（active_url 必须落在 urls 内）。
            RelayConfig::N0Default => n0_default_urls(),
            RelayConfig::CustomWithCaps(entries) => {
                for e in entries {
                    validate_relay_url(&e.url)?;
                }
                entries.iter().map(|e| e.url.clone()).collect()
            }
        };
        // task 2.3：成员端持久化 capability（上次兑换的 OK2 附发令牌）在
        // endpoint 构造前加载——构造期即注入 RelayMap；损坏文件 fail-fast
        //（capability 是 bearer 凭证，不静默丢弃）。
        let persisted_relay_caps = load_relay_caps(&config.data_dir)?;
        // task 2.2：Custom/CustomWithCaps 显式构造 RelayMap（CustomWithCaps
        // 条目带 auth token），保留共享句柄——iroh socket 持同一内部 RwLock，
        // 运行期（join 注入 bootstrap/member capability）热更新即时生效。
        // N0Default/Disabled 不持句柄（上游预设内部构造，无注入面）。
        let mut relay_map_handle: Option<iroh_relay::RelayMap> = None;
        let mut builder = match &config.relay {
            RelayConfig::Disabled => {
                Endpoint::builder(iroh::endpoint::presets::Minimal).relay_mode(RelayMode::Disabled)
            }
            RelayConfig::Custom(urls) => {
                let parsed: Result<Vec<_>, _> =
                    urls.iter().map(|u| u.parse::<iroh::RelayUrl>()).collect();
                let parsed = parsed.map_err(|e: iroh::RelayUrlParseError| {
                    FabricError::Session(SessionError::Connect(e.to_string()))
                })?;
                // 等价 RelayMode::custom(parsed)（其内部就是 from_iter），
                // 仅多保留一个共享句柄
                let map = iroh_relay::RelayMap::from_iter(parsed);
                inject_relay_tokens(
                    &map,
                    &persisted_relay_caps
                        .iter()
                        .map(|(u, c)| (u.clone(), c.clone()))
                        .collect::<Vec<_>>(),
                );
                relay_map_handle = Some(map.clone());
                Endpoint::builder(iroh::endpoint::presets::Minimal)
                    .relay_mode(RelayMode::Custom(map))
            }
            RelayConfig::CustomWithCaps(entries) => {
                let map = iroh_relay::RelayMap::empty();
                // 静态 token（配置显式给出的现成凭证）+ 成员持久化 capability；
                // server_id 条目的 own capability 由 ensure_relay_capabilities
                // 显式签发注入（root 语义，不在构造期隐式执行）
                let mut tokens: Vec<(String, String)> = persisted_relay_caps.clone();
                for e in entries {
                    if let Some(t) = e.local_token() {
                        tokens.push((e.url.clone(), t.to_owned()));
                    }
                }
                inject_relay_tokens(&map, &tokens);
                relay_map_handle = Some(map.clone());
                Endpoint::builder(iroh::endpoint::presets::Minimal)
                    .relay_mode(RelayMode::Custom(map))
            }
            RelayConfig::N0Default => Endpoint::builder(iroh::endpoint::presets::N0),
        };
        // 代理所有权映射（D7）：None=不设；FromEnv=proxy_from_env；Url=proxy_url。
        builder = match &config.http_proxy {
            HttpProxyConfig::None => builder,
            HttpProxyConfig::FromEnv => builder.proxy_from_env(),
            HttpProxyConfig::Url(u) => builder.proxy_url(parse_proxy_url(u)?.into()),
        };
        if let Some(bind) = &config.bind_addr {
            builder = builder.bind_addr(bind.as_str()).map_err(|e| {
                FabricError::Session(SessionError::Connect(format!("bind {bind}: {e}")))
            })?;
        }
        // HB 5.1：受限信任枚举 -> iroh 上游 CA 配置（PlatformRoot = 不设置，
        // 保持 iroh 默认内置根；CustomPem = 仅自定义根）。
        if let Some(ca) = config.relay_tls_trust.to_ca_tls_config()? {
            builder = builder.ca_tls_config(ca);
        }
        builder = builder
            .secret_key(identity.secret_key().clone())
            .alpns(vec![
                ALPN_REGULAR.to_vec(),
                ALPN_REDEEM.to_vec(),
                crate::continuity::ALPN_CONTINUITY.to_vec(),
            ]);
        let endpoint = builder.bind().await?;
        // R3 P1-3：10s online 等待仅作为“沉降触发”——其布尔结果**不**写入快照
        //（与随后的 watcher 观测分属两个时刻，会产生 online/active_url 错配）；
        // 快照的 online 与 active_url 一律来自下方同一次 watcher 聚合观测。
        if !matches!(config.relay, RelayConfig::Disabled) {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(10), endpoint.online()).await;
        }

        let (events, _) = broadcast::channel(256);
        let lifecycle_gate = Arc::new(std::sync::Mutex::new(false));
        let shutdown_started = Arc::new(std::sync::Mutex::new(false));
        let mode = match &config.relay {
            RelayConfig::Disabled => "disabled",
            RelayConfig::Custom(_) | RelayConfig::CustomWithCaps(_) => "custom",
            RelayConfig::N0Default => "n0",
        };
        // HB 8.1 + R3 P1-3：初始快照的 online / active_url / last_error 来自
        // **同一次** watcher 聚合观测（快照自洽不变量：active_url ⇔ online=true）。
        let mut initial_online = None;
        let mut initial_active_url = None;
        let mut initial_last_error = None;
        if !matches!(config.relay, RelayConfig::Disabled) {
            let mut status_watcher = endpoint.home_relay_status();
            let current: Vec<RelayStatusView> =
                status_watcher.get().iter().map(Into::into).collect();
            let agg = aggregate_relay_status(&relay_config_urls, &current);
            initial_online = Some(agg.online);
            initial_active_url = agg.online_url;
            initial_last_error = agg.last_error;
        }
        let relay_snapshot = Arc::new(std::sync::Mutex::new(RelayStatusSnapshot {
            mode,
            urls: relay_config_urls.clone(),
            online: if matches!(config.relay, RelayConfig::Disabled) {
                None
            } else {
                initial_online
            },
            active_url: initial_active_url,
            last_error: initial_last_error,
        }));
        // relay watcher（D4）：直接消费 iroh home_relay_status 状态流；Disabled 不启动。
        let relay_watcher_task = if !matches!(config.relay, RelayConfig::Disabled) {
            let status_stream = RelayViewStream(endpoint.home_relay_status().stream());
            let snapshot = relay_snapshot.clone();
            let events_tx = events.clone();
            let config_urls = relay_config_urls.clone();
            let lifecycle_gate = lifecycle_gate.clone();
            let shutdown_started = shutdown_started.clone();
            Some(tokio::spawn(async move {
                relay_watch_loop(
                    status_stream,
                    config_urls,
                    snapshot,
                    lifecycle_gate,
                    shutdown_started,
                    events_tx,
                )
                .await;
            }))
        } else {
            None
        };
        // c2：会话自动重连通道（closed_task 发送 -> manager 消费派发 worker）
        let (reconnect_tx, reconnect_rx) = tokio::sync::mpsc::unbounded_channel();
        let inner = Arc::new(FabricInner {
            identity,
            roster: Arc::new(Mutex::new(roster)),
            roster_commit: Mutex::new(()),
            endpoint,
            peers: Arc::new(Mutex::new(HashMap::new())),
            events,
            relay: config.relay.clone(),
            advertise_addrs,
            // task 2.2/2.3：RelayMap 共享句柄（Custom/CustomWithCaps）、
            // data_dir（relay.caps.json 落盘）与已加载的成员 capability 视图
            relay_map: relay_map_handle,
            data_dir: config.data_dir.clone(),
            relay_caps: std::sync::Mutex::new(persisted_relay_caps),
            known_addrs: Mutex::new(KnownAddrs::default()),
            recent_disconnects: Mutex::new(HashMap::new()),
            connect_inflight: Mutex::new(InflightState::default()),
            flight_generation: std::sync::atomic::AtomicU64::new(0),
            peer_epoch: std::sync::atomic::AtomicU64::new(0),
            relay_snapshot,
            relay_watcher_task: std::sync::Mutex::new(relay_watcher_task),
            detached_connects: std::sync::Mutex::new(DetachedConnects::default()),
            // shutdown 完成门（R3 P1-1）：started 与 done 配对——首次调用执行
            // drain 并在完成时 send(true)；并发晚到调用等待同一完成通知后才
            // 返回（完成语义：返回后无任务残留、无后续事件）。
            shutdown_started,
            lifecycle_gate,
            accept_children: std::sync::Mutex::new(AcceptChildren::default()),
            reconnect_tx: reconnect_tx.clone(),
            continuity: crate::continuity::ContinuityState::new(),
            continuity_dialing: crate::continuity::manager::DialingGuard::default(),
            continuity_sessions: crate::continuity::session::SessionRegistry::new(),
            continuity_campaigns: crate::continuity::session::CampaignMap::default(),
            reconnect_manager_task: std::sync::Mutex::new(None),
            accept_loop_task: std::sync::Mutex::new(None),
            shutdown_done: tokio::sync::watch::channel(false).0,
            proxy_is_none: matches!(config.http_proxy, HttpProxyConfig::None),
            join_timeout_ms: config.join_timeout_ms,
        });
        // c2：会话自动重连监管 manager 常驻（消费意外死亡通知派发退避重拨）
        let reconnect_manager = spawn_reconnect_manager(&inner, reconnect_rx);
        *inner.reconnect_manager_task.lock().unwrap() = Some(reconnect_manager);
        let accept_loop = spawn_accept_loop(&inner);
        *inner.accept_loop_task.lock().unwrap() = Some(accept_loop);
        Ok(Fabric { inner })
    }

    // ---- 查询 ----

    pub fn endpoint_id(&self) -> String {
        endpoint_id_display(&self.inner.identity.endpoint_id())
    }

    /// 身份引用（供导出等只读用途）。
    pub fn identity(&self) -> &NodeIdentity {
        &self.inner.identity
    }

    pub async fn fabric_id_hex(&self) -> String {
        hex::encode(self.inner.roster.lock().await.fabric_id().as_bytes())
    }

    pub async fn members(&self) -> Vec<MemberInfo> {
        let roster = self.inner.roster.lock().await;
        roster
            .effective_members(now_ms())
            .into_iter()
            .map(|m| MemberInfo {
                endpoint_id: endpoint_id_display(&m.endpoint_id),
                display_name: m.display_name,
                since_ms: m.since_ms,
            })
            .collect()
    }

    pub async fn is_member(&self, id: &str) -> Result<bool, FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        Ok(self.inner.roster.lock().await.is_member(&id, now_ms()))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<FabricEvent> {
        self.inner.events.subscribe()
    }

    /// relay 状态快照（D4）：直接读缓存，零等待。快照先于事件可用——
    /// 初始事实一律先查本方法，事件只承载后续跳变。禁用模式 online 为 None。
    pub fn relay_status(&self) -> RelayStatusSnapshot {
        self.inner.relay_snapshot.lock().unwrap().clone()
    }

    /// 读取 endpoint RelayMap 条目的 auth token（task 2.2/2.3 测试探针；
    /// url 以配置原样形态匹配，无该条目或无凭证返回 None）。
    #[doc(hidden)]
    pub fn relay_map_token(&self, url: &str) -> Option<String> {
        let map = self.inner.relay_map.as_ref()?;
        let parsed = url.parse::<iroh::RelayUrl>().ok()?;
        map.get(&parsed).and_then(|cfg| cfg.auth_token.clone())
    }

    /// watcher 任务是否已退出（shutdown 显式 abort + join 后为 true；测试用）。
    #[doc(hidden)]
    pub fn relay_watcher_exited(&self) -> bool {
        match self.inner.relay_watcher_task.lock().unwrap().as_ref() {
            Some(t) => t.is_finished(),
            // Disabled 模式从未启动：视为已退出（无任务残留）
            None => true,
        }
    }

    /// single-flight 航班表当前条目数（R5 P1-1；测试确定性等待 owner 登记
    /// 用——try_lock 自旋，仅测试探针语义）。
    #[doc(hidden)]
    pub fn connect_inflight_len(&self) -> usize {
        loop {
            match self.inner.connect_inflight.try_lock() {
                Ok(g) => return g.map.len(),
                Err(_) => std::thread::yield_now(),
            }
        }
    }

    /// 登记表中尚未自然结束的 detached connect 任务数（HB 4.1；测试断言
    /// shutdown 后无残留用）。
    #[doc(hidden)]
    pub fn detached_connect_pending(&self) -> usize {
        self.inner
            .detached_connects
            .lock()
            .unwrap()
            .tasks
            .iter()
            .filter(|t| !t.is_finished())
            .count()
    }

    pub async fn link_status(&self, id: &str) -> Result<LinkStatus, FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        let peers = self.inner.peers.lock().await;
        peers
            .get(&id)
            .map(|p| *p.link.lock().unwrap())
            .ok_or(FabricError::Session(SessionError::NotConnected(
                id.to_string(),
            )))
    }

    // ---- root 操作 ----

    /// 签发邀请令牌（root-only）。等价于 `invite_with(.., InviteOptions::default())`。
    pub async fn invite(
        &self,
        ttl_ms: u64,
        recipient: Option<&str>,
    ) -> Result<String, FabricError> {
        self.invite_with(ttl_ms, recipient, InviteOptions::default())
            .await
    }

    /// 签发邀请令牌（root-only；D3 签发安全门 + 逃生阀）。
    ///
    /// relay 为空（disabled/空列表）且 advertise_addrs 为空时拒绝签发
    /// （[`FabricError::InviteWithoutRelay`]）——此类令牌已知不可兑换；
    /// `opts.allow_relayless = true` 显式放行（可达性责任归调用方）。
    /// 直连地址只信显式配置字段：签发路径永不混入运行时探测地址
    /// （direct_addr_hints 是本进程临时端口，进程退出即死）。
    ///
    /// task 2.1：relay 配置含 restricted 条目（server_id）时签 **InviteV2**
    /// （附录 A：recipient 恒必填、relay 列表、每条 bootstrap capability）；
    /// 否则 v1 路径零变化。v2 安全门沿用 v1（relay 空且无 advertise_addrs
    /// 拒签）。
    pub async fn invite_with(
        &self,
        ttl_ms: u64,
        recipient: Option<&str>,
        opts: InviteOptions,
    ) -> Result<String, FabricError> {
        let recipient = match recipient {
            Some(s) => {
                Some(endpoint_id_parse(s).map_err(|_| FabricError::BadEndpointId(s.into()))?)
            }
            None => None,
        };
        // task 2.1：restricted 条目存在 → v2 签发路径
        if self.inner.relay.has_restricted() {
            return self.invite_v2(ttl_ms, recipient, opts).await;
        }
        // c1：令牌携带 issuer **实际在线**的 relay（快照 active_url；已连接
        // = joiner 经它必然可达 issuer），并映射回配置原样字符串（HB 8.1：
        // 对外回显配置形态，不做规范化改写）。快照未就绪（刚启动尚未沉降
        // online）时回退配置序首条——与旧行为一致，宁缺勿假。
        let relay_url = {
            let snapshot = self.inner.relay_snapshot.lock().unwrap().clone();
            invite_relay_url(&self.inner.relay, &snapshot)
        };
        // 安全门只信一个来源：显式 advertise_addrs（构造期已校验/去重）。
        let addrs = self.inner.advertise_addrs.clone();
        if relay_url.is_empty() && addrs.is_empty() && !opts.allow_relayless {
            return Err(FabricError::InviteWithoutRelay);
        }
        let token = {
            // [R8-1] 邀请事实也是运行时名册写入，纳入同一提交锁。
            let _commit = self.inner.roster_commit.lock().await;
            if self.inner.lifecycle_closing() {
                return Err(FabricInner::shutting_down_error());
            }
            self.inner.roster.lock().await.issue_invite(
                &self.inner.identity,
                relay_url,
                addrs,
                recipient,
                ttl_ms,
                now_ms(),
            )?
        };
        Ok(token.encode()?)
    }

    /// InviteV2 签发（root-only；附录 A，task 2.1）。
    ///
    /// - relay 列表 = CustomWithCaps 全量条目，"活快照优先"（active 条目
    ///   稳定提前，其余配置序）；
    /// - 每条 restricted（server_id）条目对 recipient 现签 bootstrap
    ///   capability（caps=仅 RELAY（§7.2 签发最小化）、TTL = 令牌 expires
    ///   （§7.3 bootstrap ≤ invite expires））；
    /// - 静态 token 条目不嵌入（recipient 绑定无法由本机保证——本地注入专用）；
    /// - recipient 恒必填（缺省报 [`FabricError::InviteV2RequiresRecipient`]）；
    /// - 安全门沿用 v1（relay 空且无 advertise_addrs 且未 allow_relayless 拒签）。
    async fn invite_v2(
        &self,
        ttl_ms: u64,
        recipient: Option<EndpointId>,
        opts: InviteOptions,
    ) -> Result<String, FabricError> {
        let Some(recipient) = recipient else {
            return Err(FabricError::InviteV2RequiresRecipient);
        };
        let entries = match &self.inner.relay {
            RelayConfig::CustomWithCaps(entries) => entries,
            // invite_with 已保证 has_restricted() ⇒ CustomWithCaps；此臂不可达
            _ => return Err(FabricError::InviteV2RequiresRecipient),
        };
        let addrs = self.inner.advertise_addrs.clone();
        let relays_any = !entries.is_empty();
        if !relays_any && addrs.is_empty() && !opts.allow_relayless {
            return Err(FabricError::InviteWithoutRelay);
        }
        // v2 直连地址 = 二进制 SocketAddr（构造期已校验 advertise_addrs）
        let direct_addrs: Vec<std::net::SocketAddr> = addrs
            .iter()
            .map(|a| {
                a.parse::<std::net::SocketAddr>()
                    .map_err(|_| FabricError::BadAdvertiseAddr {
                        addr: a.clone(),
                        reason: "not a parseable ip:port".to_owned(),
                    })
            })
            .collect::<Result<_, _>>()?;
        let now = now_ms();
        let expires_at = now.checked_add(ttl_ms).ok_or_else(|| {
            FabricError::Session(SessionError::Connect("invite ttl overflow".into()))
        })?;
        let snapshot = self.inner.relay_snapshot.lock().unwrap().clone();
        let fabric_id = self.inner.roster.lock().await.fabric_id();
        // bootstrap capability：restricted 条目逐条现签（recipient 预绑定）
        let relays: Vec<crate::protocol::InviteRelayV2> = invite_v2_relay_order(entries, &snapshot)
            .into_iter()
            .map(|entry| {
                let capability = entry.server_id.map(|sid| {
                    crate::protocol::RelayCapV1::sign_and_encode(
                        self.inner.identity.secret_key(),
                        &fabric_id,
                        &sid,
                        &recipient,
                        crate::protocol::MEMBER_CAPS,
                        now,
                        expires_at,
                    )
                });
                let capability = capability.transpose().map_err(|e| {
                    FabricError::Session(SessionError::Connect(format!(
                        "bootstrap capability mint failed for {}: {e}",
                        entry.url
                    )))
                })?;
                Ok(crate::protocol::InviteRelayV2 {
                    url: entry.url.clone(),
                    capability,
                })
            })
            .collect::<Result<_, FabricError>>()?;
        let token = {
            // [R8-1] 与 v1 同一提交锁（签发属运行时名册面操作）
            let _commit = self.inner.roster_commit.lock().await;
            if self.inner.lifecycle_closing() {
                return Err(FabricInner::shutting_down_error());
            }
            self.inner.roster.lock().await.issue_invite_v2(
                &self.inner.identity,
                relays,
                direct_addrs,
                recipient,
                ttl_ms,
                now,
            )?
        };
        Ok(token.encode()?)
    }

    /// root 自签 own capability 并注入本地 RelayMap（task 2.3 / §7.3）。
    ///
    /// 对 CustomWithCaps 中 server_id=Some 的条目，root 身份自签 own
    /// capability（caps=RELAY|RDZ_ANNOUNCE|RDZ_RESOLVE（§7.2 root 全位）、
    /// TTL=180d-1s（§11.1 上限内）、recipient=issuer=root）注入 endpoint
    /// RelayMap；静态 token 条目原样透传注入。返回 (url, token) 供调用方
    /// 复用（如转交/审计）。own capability 不持久化——root 每次启动重签
    /// （Ed25519 确定性 + 幂等覆盖，无状态漂移）。非 root 调用报
    /// [`crate::roster::RosterError::NotRoot`]（与名册 root-only 操作同源）。
    pub async fn ensure_relay_capabilities(&self) -> Result<Vec<(String, String)>, FabricError> {
        let entries = match &self.inner.relay {
            RelayConfig::CustomWithCaps(entries) => entries,
            _ => return Ok(Vec::new()),
        };
        let me = self.inner.identity.endpoint_id();
        {
            let roster = self.inner.roster.lock().await;
            if !matches!(roster.root(), Some(root) if root == me) {
                return Err(FabricError::Roster(crate::roster::RosterError::NotRoot {
                    caller: me,
                    root: roster.root(),
                }));
            }
        }
        let fabric_id = self.inner.roster.lock().await.fabric_id();
        let now = now_ms();
        let expires_at = now + crate::protocol::ROOT_CAP_TTL_MS;
        let mut out = Vec::new();
        for entry in entries {
            if let Some(sid) = entry.server_id {
                let token = crate::protocol::RelayCapV1::sign_and_encode(
                    self.inner.identity.secret_key(),
                    &fabric_id,
                    &sid,
                    &me,
                    crate::protocol::ROOT_CAPS,
                    now,
                    expires_at,
                )
                .map_err(|e| {
                    FabricError::Session(SessionError::Connect(format!(
                        "own capability mint failed for {}: {e}",
                        entry.url
                    )))
                })?;
                out.push((entry.url.clone(), token));
            } else if let Some(t) = entry.local_token() {
                out.push((entry.url.clone(), t.to_owned()));
            }
        }
        if let Some(map) = &self.inner.relay_map {
            inject_relay_tokens(map, &out);
        }
        Ok(out)
    }

    /// 撤销成员（root-only），并断开与其的既有会话。
    pub async fn revoke(&self, id: &str) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        {
            // [R8-1] revoke 与 shutdown 的门切换共享提交锁。
            let _commit = self.inner.roster_commit.lock().await;
            if self.inner.lifecycle_closing() {
                return Err(FabricInner::shutting_down_error());
            }
            let mut roster = self.inner.roster.lock().await;
            roster.revoke(
                &self.inner.identity,
                RevokeTarget::AllGrantsOf(id),
                now_ms(),
            )?;
            self.inner.emit_gated(FabricEvent::RosterUpdated);
        }
        if let Some(entry) = self.inner.peers.lock().await.remove(&id) {
            entry.conn.close(1u32.into(), b"revoked");
        }
        Ok(())
    }

    /// 设置本节点显示名（任意成员自签 Join）。
    pub async fn set_display_name(&self, name: &str) -> Result<(), FabricError> {
        let _commit = self.inner.roster_commit.lock().await;
        if self.inner.lifecycle_closing() {
            return Err(FabricInner::shutting_down_error());
        }
        self.inner.roster.lock().await.set_display_name(
            &self.inner.identity,
            Some(name.to_owned()),
            now_ms(),
        )?;
        self.inner.emit_gated(FabricEvent::RosterUpdated);
        Ok(())
    }

    // ---- 加入与连接 ----

    /// join/connect 拨号错误的 deny reason 附注（task 2.5）：relay watcher 已
    /// 把 `dweb/*` deny reason 记入快照 last_error（sanitize 例外透传）——
    /// 拨号失败分类时若存在，附在错误 message 尾部（结构化 reason 是唯一
    /// 可操作信号：无票/过期/转借的修复路径各不相同，不得折叠进泛化类别）。
    fn relay_deny_note(&self) -> Option<String> {
        let snap = self.inner.relay_snapshot.lock().unwrap().clone();
        snap.last_error
            .as_deref()
            .and_then(extract_deny_reason)
            .map(|r| format!("relay denied: {r}"))
    }

    /// Connect 错误分类的 deny 附注（task 2.5）：iroh ConnectError 的错误链
    /// 可能内嵌 relay 握手拒绝文本（`ServerDeniedAuth` Display 折进 reason）；
    /// 快照侧 watcher 记录可能晚于 connect 失败（首次握手拒绝的竞态窗口），
    /// 1s 宽限轮询收敛——无 deny 的常规失败最多多等 1s（探针路径同量级）。
    async fn connect_deny_note(&self, connect_reason: &str) -> Option<String> {
        if let Some(r) = extract_deny_reason(connect_reason) {
            return Some(format!("relay denied: {r}"));
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if let Some(note) = self.relay_deny_note() {
                return Some(note);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// 兑换邀请令牌（joiner 侧）。成功后本节点是成员且持有完整名册。
    ///
    /// 失败按 D11 分类总函数有序判定（互斥穷尽）：
    /// 令牌自身错误(解码/过期/地址规范化) -> 本地数据面豁免(缺身份/真损坏/IO，
    /// 按原生变体透出) -> 目录归属(DirFabricMismatch) -> 空路径(NO_REACHABLE_PATH，
    /// 拨号前零等待) -> deadline 包住的 connect+redeem 网络工作流（8 码归类，
    /// 含 2s transport-only TCP relay 探针驱动的 RELAY_OFFLINE/DIAL_TIMEOUT 附注）。
    pub async fn join(&self, token_str: &str) -> Result<(), FabricError> {
        // task 2.1：按串前缀分派——dweb2. 走 v2 路径（附录 A 令牌 + OK2
        // 回执 + member capability 持久化/注入）；dweb1. 路径零变化。
        if token_str.starts_with(crate::protocol::TOKEN2_PREFIX) {
            return self.join_v2(token_str).await;
        }
        // 1-3：解码 / 过期 / 地址规范化（令牌自身错误优先于目录检查）。
        let token = precheck_join_token(token_str)?;
        if self.inner.lifecycle_closing() {
            return Err(FabricInner::shutting_down_error());
        }
        // 4：本地数据面——本 Fabric 构造时已加载（attach/open 的豁免错误已在彼处
        //    透出）；此处的数据面错误只剩 merge/持久化 IO（roster-io 豁免，末尾透出）。
        // 学习 issuer 可达信息，供后续常规连接使用（有界，HB 3.1）
        {
            let mut learned: Vec<String> = Vec::new();
            if !token.invite.issuer_relay_url.is_empty() {
                learned.push(token.invite.issuer_relay_url.clone());
            }
            learned.extend(token.invite.issuer_direct_addrs.iter().cloned());
            self.inner
                .known_addrs
                .lock()
                .await
                .set(token.invite.issuer, learned);
        }
        // 5：既有目录名册 fabric != 令牌 fabric（目录归属，区别于 issuer 侧
        //    redeem_verify 的 WrongFabric——后者经 Other 透出为 TOKEN_INVALID）。
        {
            let roster = self.inner.roster.lock().await;
            if roster.fabric_id() != token.invite.fabric_id {
                return Err(FabricError::Roster(
                    crate::roster::RosterError::DirFabricMismatch {
                        path: crate::roster::roster_file_path(roster.data_dir()),
                        stored: roster.fabric_id(),
                        requested: token.invite.fabric_id,
                    },
                ));
            }
        }
        // 6：空路径——拨号前立即失败，零等待、不消耗时限。
        let has_relay = !token.invite.issuer_relay_url.is_empty();
        let has_direct = !token.invite.issuer_direct_addrs.is_empty();
        if !has_relay && !has_direct {
            return Err(FabricError::Join {
                code: JoinErrorCode::NoReachablePath,
                message: "the token carries no relay URL and no direct addresses (likely \
                          signed without a relay); ask the inviter to re-sign with a relay \
                          configured"
                    .to_owned(),
            });
        }
        // c1：本地 relay 配置作为补充拨号候选（与 connect 的合并语义一致，
        // known-addrs-boundary 冻结“custom relay 候选始终参与，learned 是
        // 补充”）。令牌携带的 issuer relay 在前、配置候选在后（EndpointAddr
        // 内部去重）；issuer 配置的首条 relay（令牌来源）死亡时，同列表中的
        // 其余 relay 兜底承接，join 不再被单死条目阻断。
        let addr = Self::with_local_relay_candidates(
            session::endpoint_addr_from_invite(&token)?,
            &self.inner.relay,
        );
        // 7：deadline 包住 connect + redeem（到期取消等待并关闭已建立的连接）。
        // token 克隆进 deadline 工作流（错误归因探针仍需原令牌字段）
        let join_err = join_with_deadline(
            &self.inner.endpoint,
            &self.inner.detached_connects,
            &addr,
            &crate::protocol::InviteVersion::V1(token.clone()),
            self.inner.identity.secret_key(),
            &self.inner.identity.endpoint_id(),
            std::time::Duration::from_millis(self.inner.join_timeout_ms),
        )
        .await;
        match join_err {
            Ok((conn, facts, caps)) => {
                conn.close(0u32.into(), b"redeem-done");
                debug_assert!(
                    caps.is_empty(),
                    "v1 redeem path never returns relay capabilities"
                );
                self.merge_and_emit(facts).await?; // roster-io 豁免透出
                Ok(())
            }
            // connect 立即错误的归因需要探针（不解析 iroh ConnectError 内部）。
            Err(JoinPhaseError::Connect(e)) => {
                let reason = e.to_string();
                // task 2.5：relay deny（受限 server 拒接入）优先于探针归因
                // 附进 message——TCP 探针只会报"端口活着"，deny reason 才是
                // 真因（无票/过期/转借）
                if let Some(note) = self.connect_deny_note(&reason).await {
                    return Err(FabricError::Join {
                        code: JoinErrorCode::DialFailed,
                        message: format!("could not reach the issuer: {reason} ({note})"),
                    });
                }
                if probe_applies(&token, self.inner.proxy_is_none) {
                    let relay_url = token.invite.issuer_relay_url.clone();
                    if !run_relay_probe(&relay_url).await {
                        return Err(FabricError::Join {
                            code: JoinErrorCode::RelayOffline,
                            message: format!(
                                "configured relay(es) are unreachable; check the server or \
                                 network (connect error: {reason})"
                            ),
                        });
                    }
                }
                Err(FabricError::Join {
                    code: JoinErrorCode::DialFailed,
                    message: format!("could not reach the issuer: {reason}"),
                })
            }
            Err(JoinPhaseError::Redeem(e)) => Err(map_redeem_error(&e)),
            Err(JoinPhaseError::DeadlineElapsed) => {
                let note = match &self.relay_deny_note() {
                    // task 2.5：deny 已记录时 deadline 归因让位（iroh 对 deny
                    // 静默退避重试，connect 常以超时面落地）
                    Some(note) => format!("join failed to reach the issuer via relay ({note})"),
                    None if probe_applies(&token, self.inner.proxy_is_none)
                        && run_relay_probe(&token.invite.issuer_relay_url).await =>
                    {
                        "relay online: issuer likely offline (invites must be redeemed while the \
                         inviter is running)"
                            .to_owned()
                    }
                    None => format!(
                        "join deadline exceeded after {}ms",
                        self.inner.join_timeout_ms
                    ),
                };
                Err(FabricError::Join {
                    code: JoinErrorCode::DialTimeout,
                    message: note,
                })
            }
        }
    }

    /// join 的 v2 路径（附录 A/A2；task 2.1/2.4）：与 v1 同一分类总函数
    /// 顺序，差异点：
    /// - 拨号候选 = relay 列表全量 + 直连地址 + 本地 relay 配置合并；
    /// - 拨号前把令牌内嵌 bootstrap capability 注入本地 RelayMap（附录 A：
    ///   bootstrap 仅用于 join 拨号窗口的 relay 接入）；
    /// - 成功回执 OK2 → 名册 merge（同 OK 路径）+ capability 段提取 →
    ///   upsert relay.caps.json（同 url 覆盖）+ 热注入本地 RelayMap。
    async fn join_v2(&self, token_str: &str) -> Result<(), FabricError> {
        // 1-3：解码（附录 A 全部校验）/ 过期 / relay URL 可解析
        let token = precheck_join_token_v2(token_str)?;
        if self.inner.lifecycle_closing() {
            return Err(FabricInner::shutting_down_error());
        }
        // 4：学习 issuer 可达信息（relay 列表 + 直连地址，有界 HB 3.1）
        {
            let mut learned: Vec<String> =
                token.invite.relays.iter().map(|r| r.url.clone()).collect();
            learned.extend(token.invite.direct_addrs.iter().map(|a| a.to_string()));
            self.inner
                .known_addrs
                .lock()
                .await
                .set(token.invite.issuer, learned);
        }
        // 5：目录归属
        {
            let roster = self.inner.roster.lock().await;
            if roster.fabric_id() != token.invite.fabric_id {
                return Err(FabricError::Roster(
                    crate::roster::RosterError::DirFabricMismatch {
                        path: crate::roster::roster_file_path(roster.data_dir()),
                        stored: roster.fabric_id(),
                        requested: token.invite.fabric_id,
                    },
                ));
            }
        }
        // 6：空路径
        if token.invite.relays.is_empty() && token.invite.direct_addrs.is_empty() {
            return Err(FabricError::Join {
                code: JoinErrorCode::NoReachablePath,
                message: "the token carries no relay URL and no direct addresses (likely \
                          signed without a relay); ask the inviter to re-sign with a relay \
                          configured"
                    .to_owned(),
            });
        }
        // bootstrap capability 注入（热更新共享句柄；N0/Disabled 模式无注入面，
        // 候选合并仍携带 relay URL——受限部署的 joiner 应以 Custom 形态配置）
        let bootstrap: Vec<(String, String)> = token
            .invite
            .relays
            .iter()
            .filter_map(|r| r.capability.as_ref().map(|c| (r.url.clone(), c.clone())))
            .collect();
        if let Some(map) = &self.inner.relay_map {
            inject_relay_tokens(map, &bootstrap);
        }
        if !bootstrap.is_empty() {
            // 新邀请语义：join 起点已用新 bootstrap 覆盖 RelayMap——构造期由
            // 残留旧票握手记录的 deny 随之作废，清零避免 deadline 归因引用
            // join 之前的 deny（云端实证：过期 member cap 的构造期 deny 让
            // join 超时被误归因为 capability-expired；deny 只在 join 窗口内
            // 由 watcher 重新记录，非 deny 形态的 last_error 不受影响）。
            let mut snap = self.inner.relay_snapshot.lock().unwrap();
            if snap
                .last_error
                .as_deref()
                .is_some_and(|e| extract_deny_reason(e).is_some())
            {
                snap.last_error = None;
            }
        }
        // c1 同款：本地 relay 配置追加为拨号候选
        let addr = Self::with_local_relay_candidates(
            session::endpoint_addr_from_invite_v2(&token)?,
            &self.inner.relay,
        );
        // 7：deadline 包住 connect + redeem（token 克隆进工作流；后续错误
        // 归因仍需原令牌的 relay 列表）
        let join_err = join_with_deadline(
            &self.inner.endpoint,
            &self.inner.detached_connects,
            &addr,
            &crate::protocol::InviteVersion::V2(token.clone()),
            self.inner.identity.secret_key(),
            &self.inner.identity.endpoint_id(),
            std::time::Duration::from_millis(self.inner.join_timeout_ms),
        )
        .await;
        let first_relay = token
            .invite
            .relays
            .first()
            .map(|r| r.url.clone())
            .unwrap_or_default();
        match join_err {
            Ok((conn, facts, caps)) => {
                conn.close(0u32.into(), b"redeem-done");
                self.merge_and_emit(facts).await?; // roster-io 豁免透出
                // member capability：内存 upsert + 文件 append/update（同 url
                // 覆盖）→ 热注入（重启后由 start() 加载同源注入）
                if !caps.is_empty() {
                    {
                        let mut store = self.inner.relay_caps.lock().unwrap();
                        upsert_relay_caps(&mut store, &caps);
                    }
                    store_relay_caps(&self.inner.data_dir, &caps)?;
                    if let Some(map) = &self.inner.relay_map {
                        inject_relay_tokens(map, &caps);
                    }
                }
                Ok(())
            }
            Err(JoinPhaseError::Connect(e)) => {
                let reason = e.to_string();
                // task 2.5：relay deny（受限 server 拒接入，如 bootstrap
                // capability 过期/转借）优先于探针归因附进 message
                if let Some(note) = self.connect_deny_note(&reason).await {
                    return Err(FabricError::Join {
                        code: JoinErrorCode::DialFailed,
                        message: format!("could not reach the issuer: {reason} ({note})"),
                    });
                }
                // 探针适用条件同 v1 probe_applies：relay-only 令牌（无直连
                // 地址）且无代理——直连路径存在时 relay 探针不构成归因依据
                let probe_applies = !first_relay.is_empty() && token.invite.direct_addrs.is_empty();
                if probe_applies && self.inner.proxy_is_none && !run_relay_probe(&first_relay).await
                {
                    return Err(FabricError::Join {
                        code: JoinErrorCode::RelayOffline,
                        message: format!(
                            "configured relay(es) are unreachable; check the server or \
                                 network (connect error: {reason})"
                        ),
                    });
                }
                Err(FabricError::Join {
                    code: JoinErrorCode::DialFailed,
                    message: format!("could not reach the issuer: {reason}"),
                })
            }
            Err(JoinPhaseError::Redeem(e)) => Err(map_redeem_error(&e)),
            Err(JoinPhaseError::DeadlineElapsed) => {
                let note = match &self.relay_deny_note() {
                    // task 2.5：deny 已记录时 deadline 归因让位（iroh 对 deny
                    // 静默退避重试，connect 常以超时面落地）
                    Some(note) => {
                        format!("join failed to reach the issuer via relay ({note})")
                    }
                    None if !first_relay.is_empty()
                        && token.invite.direct_addrs.is_empty()
                        && self.inner.proxy_is_none
                        && run_relay_probe(&first_relay).await =>
                    {
                        "relay online: issuer likely offline (invites must be redeemed while the \
                     inviter is running)"
                            .to_owned()
                    }
                    None => format!(
                        "join deadline exceeded after {}ms",
                        self.inner.join_timeout_ms
                    ),
                };
                Err(FabricError::Join {
                    code: JoinErrorCode::DialTimeout,
                    message: note,
                })
            }
        }
    }

    /// continuity：对端连接状态快照（snapshot-before-subscribe 语义）。
    pub async fn continuity_snapshot(
        &self,
        peer_id: &str,
    ) -> Result<crate::continuity::ConnectionStateSnapshot, FabricError> {
        let id = endpoint_id_parse(peer_id).map_err(FabricError::from)?;
        Ok((*self.inner.continuity.snapshot(&id).await).clone())
    }

    /// continuity：订阅对端状态流（watch；初值即最新，lag 自动收敛）。
    pub async fn continuity_watch(
        &self,
        peer_id: &str,
    ) -> Result<
        tokio::sync::watch::Receiver<std::sync::Arc<crate::continuity::ConnectionStateSnapshot>>,
        FabricError,
    > {
        let id = endpoint_id_parse(peer_id).map_err(FabricError::from)?;
        Ok(self.inner.continuity.watch(&id).await)
    }

    /// continuity：在当前代次连接上开 raw 传输（帧收发）。
    pub async fn continuity_open_transport(
        &self,
        peer_id: &str,
    ) -> Result<crate::continuity::ContinuityTransport, FabricError> {
        crate::continuity::manager::open_transport(self, peer_id).await
    }

    /// continuity：接受对端打开的 continuity 流（服务端形态）。
    pub async fn continuity_accept_stream(
        &self,
        peer_id: &str,
    ) -> Result<crate::continuity::ContinuityTransport, FabricError> {
        crate::continuity::manager::accept_stream(self, peer_id).await
    }

    /// continuity：非故意关闭当前连接（故障注入——触发状态翻转与重连）。
    pub async fn continuity_reset(&self, peer_id: &str) -> Result<(), FabricError> {
        crate::continuity::manager::reset(self, peer_id).await
    }

    /// 连接成员（常规 ALPN，双向门控 + 名册同步）。
    pub async fn connect(&self, id: &str) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        // R4 P1-2：shutdown 开始后拒绝新航班——drain 不再等待迟到的 connect，
        // 完成门语义（返回后无新 peer/事件）不被越过
        if *self.inner.shutdown_started.lock().unwrap() {
            return Err(FabricError::Session(SessionError::Connect(
                "fabric is shutting down".into(),
            )));
        }
        {
            let roster = self.inner.roster.lock().await;
            if !roster.is_member(&id, now_ms()) {
                return Err(FabricError::Session(SessionError::NotMember(
                    endpoint_id_display(&id),
                )));
            }
            {
                let mut peers = self.inner.peers.lock().await;
                match peers.get(&id) {
                    Some(entry) if !entry.closed.load(std::sync::atomic::Ordering::SeqCst) => {
                        return Ok(()); // 已有活跃连接，幂等
                    }
                    Some(_) => {
                        peers.remove(&id); // 残留已死条目，清理后重拨
                    }
                    None => {}
                }
            }
        }
        // single-flight（R7 P1-1 重写）：同 EndpointId 并发 connect 订阅同一
        // watch 航班；owner guard 与航班插入在同一临界区配对（generation），
        // 任何出口（成功/失败/取消 Drop）都只清理仍指向自身代次的 entry 并
        // 广播完成——取消不遗留陈旧航班，旧 owner 不误删新 owner 的航班。
        let (flight_tx, _flight_rx) = tokio::sync::watch::channel(false);
        let generation = self
            .inner
            .flight_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // R8 P1-1：guard 延迟创建——只在确认为 owner（None 分支插入后）才构造，
        // waiter 分支不持有 guard，避免 forget 泄漏 Arc<FabricInner>。
        #[allow(unused_assignments)]
        let mut guard_opt: Option<FlightGuard> = None;
        {
            let mut inflight = self.inner.connect_inflight.lock().await;
            // R5 P1-1：准入与登记同一临界区——draining 后原子拒绝（早前入口
            // 的 shutdown_started 快查只是快速路径，此处才是竞态闭合点）
            if inflight.draining {
                return Err(FabricError::Session(SessionError::Connect(
                    "fabric is shutting down".into(),
                )));
            }
            match inflight.map.get(&id) {
                Some(existing) => {
                    let mut subscribed = existing.1.subscribe();
                    drop(inflight);
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        subscribed.changed(),
                    )
                    .await; // 完成（true）或 owner 取消（Err）都视为信号
                    let peers = self.inner.peers.lock().await;
                    if let Some(entry) = peers.get(&id)
                        && !entry.closed.load(std::sync::atomic::Ordering::SeqCst)
                    {
                        return Ok(());
                    }
                    return Err(FabricError::Session(SessionError::Connect(
                        "concurrent connect failed; retry to redial".into(),
                    )));
                }
                None => {
                    inflight.map.insert(id, Arc::new((generation, flight_tx)));
                    // owner 确认：现在才创建 guard（插入临界区内——此后任何
                    // await 点取消都有 guard 清理）
                    guard_opt = Some(FlightGuard {
                        inner: Arc::clone(&self.inner),
                        id,
                        generation,
                    });
                }
            }
        }
        // 声明航班后复查 peers（锁序统一：持 peers 只记录结论后释放）
        {
            let already_connected = {
                let peers = self.inner.peers.lock().await;
                peers
                    .get(&id)
                    .is_some_and(|e| !e.closed.load(std::sync::atomic::Ordering::SeqCst))
            };
            if already_connected {
                drop(guard_opt.take()); // generation 校验的清理
                return Ok(());
            }
        }
        let result = self.connect_dial(&id).await;
        drop(guard_opt.take());
        result
    }

    /// 实际拨号（connect 的 single-flight 保护下的执行体）。
    async fn connect_dial(&self, id: &EndpointId) -> Result<(), FabricError> {
        let addr = self.endpoint_addr_for(id).await?;
        // 预沉降：刚主动断开过的对端，补足去重窗口再拨（实证窗口约 3s；
        // 期间强行拨号会制造卡死连接并延长坏状态，且重试无法恢复）。
        {
            let recent = self.inner.recent_disconnects.lock().await;
            if let Some(t) = recent.get(id) {
                const REDIAL_SETTLE: std::time::Duration = std::time::Duration::from_secs(3);
                let elapsed = t.elapsed();
                if elapsed < REDIAL_SETTLE {
                    drop(recent);
                    tokio::time::sleep(REDIAL_SETTLE - elapsed).await;
                }
            }
        }
        // iroh 对同一 NodeId 的"关闭中"连接存在传输层去重窗口：紧随 disconnect 的
        // 重拨可能在 QUIC 握手完成后被对端丢弃、HELLO 无应答直至空闲超时
        // （facade remote_revoke 竞态实证）。以有界 HELLO 超时 + 单次重试兜底：
        // 第二次拨号时旧连接已被双方清理，窗口不再命中。
        const CONNECT_HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
        const CONNECT_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_millis(2500);
        for attempt in 0..2 {
            // connect 本身不施加超时：取消中的 iroh connect 会留下半开连接，
            // 卡死该 NodeId 的后续拨号（实证）。握手在传输层毫秒级完成，
            // 无界风险由 HELLO 阶段超时 + 干净 close 兜底。
            let conn = self
                .inner
                .endpoint
                .connect(addr.clone(), ALPN_REGULAR)
                .await?;
            match tokio::time::timeout(CONNECT_HELLO_TIMEOUT, self.register_dialed(conn.clone()))
                .await
            {
                Ok(Ok(())) => {
                    // 成功：清除该对端的近期断开记录（沉降窗口已无意义）
                    self.inner.recent_disconnects.lock().await.remove(id);
                    return Ok(());
                }
                Ok(Err(e)) => {
                    // P1-7：注册失败同样干净关闭，不占用去重窗口
                    conn.close(0u32.into(), b"register-failed");
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), conn.closed())
                        .await;
                    return Err(e);
                }
                Err(_) if attempt == 0 => {
                    // HELLO 超时：干净关闭后退避重试一次（窗口实测约 3s 内消散）
                    conn.close(0u32.into(), b"hello-timeout");
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), conn.closed())
                        .await;
                    tokio::time::sleep(CONNECT_RETRY_BACKOFF).await;
                    continue;
                }
                Err(_) => {
                    conn.close(0u32.into(), b"hello-timeout");
                    return Err(FabricError::Session(SessionError::Connect(
                        "connect hello timed out twice (peer may hold a closing duplicate connection)".into(),
                    )));
                }
            }
        }
        unreachable!()
    }

    /// 显式登记对端可达地址（relay URL 或 ip:port），供后续 connect 使用。
    /// 有界（HB 3.1）：per-endpoint 超限淘汰最旧地址；重复地址幂等。
    pub async fn add_known_addr(&self, id: &str, addr: String) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        self.inner.known_addrs.lock().await.push(id, addr);
        Ok(())
    }

    /// 对端当前可达地址提示（网卡地址 + 回环端口）。
    pub async fn direct_addr_hints_public(&self) -> Vec<String> {
        self.direct_addr_hints()
    }

    pub async fn disconnect(&self, id: &str) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        if let Some(entry) = self.inner.peers.lock().await.remove(&id) {
            entry.conn.close(0u32.into(), b"bye");
            // 排空：有界等待连接完全关闭（对端 GC 同步进行），缩小紧随重拨的
            // iroh 同 NodeId 去重窗口。
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(2), entry.conn.closed()).await;
        }
        // c2：显式断开一律记录（即便此刻无活跃条目——会话可能刚死于网络），
        // 自动重连监管据此让位：用户 disconnect 语义不被后台重拨覆盖。
        {
            let mut rd = self.inner.recent_disconnects.lock().await;
            // P1-7：有界（容量 1024，超限逐出最旧——HashMap 迭代序不定，
            // 但淘汰语义只需近似 LRU；正常流量下成功重拨即删除）
            if rd.len() >= 1024
                && let Some(victim) = rd.keys().next().cloned()
            {
                rd.remove(&victim);
            }
            rd.insert(id, std::time::Instant::now());
        }
        Ok(())
    }

    /// 发送不透明 envelope（MSG 流：每消息一条 bidi 流，单帧）。
    pub async fn send(&self, id: &str, data: Vec<u8>) -> Result<(), FabricError> {
        let id = endpoint_id_parse(id).map_err(|_| FabricError::BadEndpointId(id.into()))?;
        if data.len() + 5 > session::MAX_FRAME {
            return Err(FabricError::Session(SessionError::FrameTooLarge {
                limit: session::MAX_FRAME,
            }));
        }
        // R9 P1（终审 R8-1）：peers 锁内只做连接克隆/准入——网络 I/O 一律在
        // 锁外有界执行。持锁跨 open_bi/write 的 await 会在对端流控挂起时
        // 饿死 shutdown 的 peers sweep（完成门永不到达）。
        let conn = {
            let peers = self.inner.peers.lock().await;
            // 关闭已开始即拒绝新发送（与 connect 准入同语义）
            if *self.inner.shutdown_started.lock().unwrap() {
                return Err(FabricError::Session(SessionError::Connect(
                    "fabric is shutting down".into(),
                )));
            }
            let entry = peers
                .get(&id)
                .ok_or(FabricError::Session(SessionError::NotConnected(
                    endpoint_id_display(&id),
                )))?;
            entry.conn.clone()
        };
        // 单帧发送有界（对端不读时流控等待不得无限期占用调用方）
        let io = async {
            let (mut send, _recv) = conn.open_bi().await?;
            session::write_frame(&mut send, session::frame_type::MSG, &data).await?;
            send.finish().map_err(|_| FabricError::StreamClosed)?;
            Ok::<(), FabricError>(())
        };
        match tokio::time::timeout(SEND_IO_TIMEOUT, io).await {
            Ok(res) => res,
            Err(_) => Err(FabricError::Session(SessionError::Connect(
                "send timed out (peer stalled or flow-control window exhausted)".into(),
            ))),
        }
    }

    /// 优雅关闭：断开全部会话，显式终止 relay watcher（iroh 的 watcher 流只在
    /// 最后一个 Endpoint clone drop 时断开，Endpoint::close 不会结束它——必须
    /// abort + join 确认退出），然后关闭 endpoint；释放 data-dir 排他锁（幂等）。
    /// R3 P1-1：共享完成门——只有首次调用执行 drain；并发晚到调用等待同一
    /// 完成通知后返回（返回即满足"无任务残留、无后续事件"完成语义）。
    pub async fn shutdown(&self) -> Result<(), FabricError> {
        // R3/R4 P1-1：共享完成门。守卫严格限定在同步块内（async fn 需 Send，
        // std MutexGuard 不得跨 await）。
        let waiter = {
            let mut started = self.inner.shutdown_started.lock().unwrap();
            if *started {
                Some(self.inner.shutdown_done.subscribe())
            } else {
                *started = true;
                None
            }
        };
        if let Some(mut rx) = waiter {
            // send_replace 无订阅者也会落值：完成后订阅即见 true，顺序调用不挂
            if !*rx.borrow_and_update() {
                let _ = rx.changed().await;
            }
            return Ok(());
        }
        // R4 P1-1：drain 交给后台任务持有——首调用的 Future 被取消（drop）只
        // 是不再等待 JoinHandle，不中断 drain 本身；完成通知由任务收尾发出，
        // 晚到等待者必然放行。JoinHandle await 是 cancel-safe 的。
        // [R8-1] shutdown_started 已在上方同步块中封住新准入；最终
        // lifecycle_gate 在后台 drain 内等待 roster_commit 后置位，避免已获
        // 提交锁的操作在最终门后写入；首调用 Future 取消也不影响 drain。
        let inner = self.inner.clone();
        let drain = tokio::spawn(async move { shutdown_drain(inner).await });
        // R7 P1-4：JoinErr（drain 任务 panic）与 drain 结果（未收敛 Err）都
        // 显式回报首调用；完成通知无论哪种情形都已发出，晚到等待者不挂死
        match drain.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(e) => Err(FabricError::Session(SessionError::Connect(format!(
                "shutdown drain task failed: {e}"
            )))),
        }
    }

    // ---- 内部 ----

    /// 拨号候选合并（HB 3.1 冻结语义，纯函数供确定性测试）：    /// learned 地址是**补充**而非**替代**——本地配置的 relay 候选始终参与
    /// 拨号，learned（如令牌携带的 issuer relay/直连地址）失效时仍有配置
    /// relay 兜底。顺序：learned（插入序）在前，本地 relay 配置序在后；
    /// EndpointAddr 内部为去重集合（P1-6：多 relay 全量进入，不截断故障
    /// 切换能力）。不可解析的 learned 条目跳过（令牌侧已在 precheck 拒绝，
    /// 此处防御 add_known_addr 的手工注入）。
    pub(crate) fn merge_dial_candidates(
        id: &EndpointId,
        learned: &[String],
        relay: &RelayConfig,
    ) -> EndpointAddr {
        let mut addr = EndpointAddr::new(*id);
        for hint in learned {
            if let Ok(url) = hint.parse::<iroh::RelayUrl>() {
                addr = addr.with_relay_url(url);
            } else if let Ok(ip) = hint.parse::<std::net::SocketAddr>() {
                addr = addr.with_ip_addr(ip);
            }
        }
        Self::with_local_relay_candidates(addr, relay)
    }

    /// 本地 relay 配置追加为拨号候选（c1）：custom 全量按配置序、n0 全量
    /// 默认列表（R3 P1-4 同源）；不可解析项跳过（构造期已校验，防御性）。
    /// join 与 connect 共用——令牌携带的 issuer relay 失效（死条目）时，
    /// 配置列表中的其余 relay 兜底承接（iroh 对 EndpointAddr 的全部路径
    /// 并发发起初始包，天然 dial-failover）。
    fn with_local_relay_candidates(mut addr: EndpointAddr, relay: &RelayConfig) -> EndpointAddr {
        match relay {
            RelayConfig::Disabled => {}
            RelayConfig::Custom(urls) => {
                for u in urls {
                    if let Ok(url) = u.parse::<iroh::RelayUrl>() {
                        addr = addr.with_relay_url(url);
                    }
                }
            }
            RelayConfig::CustomWithCaps(entries) => {
                // task 2.2：候选合并只管路径 URL；per-relay capability 的
                // RelayMap 条目级注入在拨号前由 join 路径完成
                for e in entries {
                    if let Ok(url) = e.url.parse::<iroh::RelayUrl>() {
                        addr = addr.with_relay_url(url);
                    }
                }
            }
            RelayConfig::N0Default => {
                // R3 P1-4：全量真实默认列表（与快照 urls / 实际拨号同源）
                for url_s in n0_default_urls() {
                    if let Ok(url) = url_s.parse::<iroh::RelayUrl>() {
                        addr = addr.with_relay_url(url);
                    }
                }
            }
        }
        addr
    }

    /// 邀请内的直连地址提示：endpoint.addr() 的网卡地址 + 127.0.0.1 回环提示（同机场景）。
    fn direct_addr_hints(&self) -> Vec<String> {
        let mut hints: Vec<String> = self
            .inner
            .endpoint
            .addr()
            .addrs
            .iter()
            .filter_map(|a| match a {
                iroh_base::TransportAddr::Ip(sa) => Some(sa.to_string()),
                _ => None,
            })
            .collect();
        if let Some(port) = self
            .inner
            .endpoint
            .bound_sockets()
            .first()
            .map(|sa| sa.port())
        {
            let loopback = format!("127.0.0.1:{port}");
            if !hints.contains(&loopback) {
                hints.push(loopback);
            }
        }
        hints
    }

    /// 为拨号构造 EndpointAddr：learned 与本地 relay 配置合并（见
    /// [`merge_dial_candidates`]）。
    async fn endpoint_addr_for(&self, id: &EndpointId) -> Result<EndpointAddr, FabricError> {
        let learned = self
            .inner
            .known_addrs
            .lock()
            .await
            .get(id)
            .map(|s| s.to_vec())
            .unwrap_or_default();
        let addr = Self::merge_dial_candidates(id, &learned, &self.inner.relay);
        if addr.addrs.is_empty() {
            return Err(FabricError::Session(SessionError::NoAddressingInfo(
                endpoint_id_display(id),
            )));
        }
        Ok(addr)
    }

    async fn register_dialed(&self, conn: Connection) -> Result<(), FabricError> {
        // R5 P1-1：draining 中不落 peer / 不发事件——成功拨号的连接在关闭已
        // 开始的 fabric 上直接废弃（完成门语义：完成后无新 peer、无后续事件）
        if self.inner.connect_inflight.lock().await.draining {
            conn.close(0u32.into(), b"shutdown-race");
            return Err(FabricError::Session(SessionError::Connect(
                "fabric is shutting down".into(),
            )));
        }
        let remote = conn.remote_id();
        let dump = {
            let roster = self.inner.roster.lock().await;
            crate::protocol::SignedFact::encode_all(roster.facts())?
        };
        let (facts, ctrl_send) = session::dialer_hello(&conn, dump).await?;
        // R6：HELLO 跨 await 后复检；最终 merge 仍由 [R8-1] 提交锁线性化。
        if self.is_draining().await {
            conn.close(0u32.into(), b"shutdown-race");
            return Err(FabricError::Session(SessionError::Connect(
                "fabric is shutting down".into(),
            )));
        }
        self.merge_and_emit(facts).await?;
        self.insert_peer(remote, conn, ctrl_send).await?;
        Ok(())
    }

    async fn merge_and_emit(
        &self,
        facts: Vec<crate::protocol::SignedFact>,
    ) -> Result<(), FabricError> {
        // [R8-1] gate 检查与 roster.merge 由同一提交锁线性化；shutdown 只有
        // 获得该锁后才能置门，所以门置位后不存在迟到名册写入。
        let _commit = self.inner.roster_commit.lock().await;
        if self.inner.lifecycle_closing() {
            return Err(FabricInner::shutting_down_error());
        }
        let removed: Vec<EndpointId> = {
            let mut roster = self.inner.roster.lock().await;
            let before: Vec<EndpointId> = roster
                .effective_members(now_ms())
                .into_iter()
                .map(|m| m.endpoint_id)
                .collect();
            let report = roster.merge(facts)?;
            let after: Vec<EndpointId> = roster
                .effective_members(now_ms())
                .into_iter()
                .map(|m| m.endpoint_id)
                .collect();
            if report.inserted > 0 {
                self.inner.emit_gated(FabricEvent::RosterUpdated);
            }
            before
                .into_iter()
                .filter(|id| !after.contains(id))
                .collect()
        };
        // 名册提交已完成；释放提交锁后再做连接清理，避免把无关的 peers await
        // 纳入门切换临界区。
        drop(_commit);
        // 远端同步到的 Revoke：摘除并断开失效成员的既有会话（撤销前向生效）
        if !removed.is_empty() {
            let mut peers = self.inner.peers.lock().await;
            for id in removed {
                if let Some(entry) = peers.remove(&id) {
                    entry.conn.close(1u32.into(), b"revoked via sync");
                }
            }
        }
        Ok(())
    }

    /// shutdown drain 是否已开始（R6 P1：生命周期门共用的原子读）
    async fn is_draining(&self) -> bool {
        self.inner.connect_inflight.lock().await.draining
    }

    async fn insert_peer(
        &self,
        remote: EndpointId,
        conn: Connection,
        ctrl_send: endpoint::SendStream,
    ) -> Result<(), FabricError> {
        // R6 P1/P2 原子门：两个调用点（拨出 register_dialed / 接受循环）的
        // 最终汇合处——draining 中不插 peer、不挂 watcher、不发事件（关闭
        // 完成语义：send_replace(true) 前后均无新 peer/事件）。迟到的成功
        // 连接直接废弃。
        let link = Arc::new(std::sync::Mutex::new(LinkStatus::Unknown));
        let closed_state = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let epoch = self
            .inner
            .peer_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let entry = PeerEntry {
            conn: conn.clone(),
            link: link.clone(),
            ctrl_send: Arc::new(Mutex::new(ctrl_send)),
            closed: closed_state.clone(),
            epoch,
        };
        let mut rejected_tasks = Vec::new();
        {
            // R7 P1-1：门与 peers 插入同一临界区（std 锁与 shutdown 置位互斥）——
            // 迟到插入要么在 sweep 前完成（随后被 sweep 关闭）、要么在此被拒
            let mut peers = self.inner.peers.lock().await;
            // peers 先、request 再、gate 最后：取得 request 锁后 shutdown 首调用
            // 无法在插入/事件同步临界区切换准入状态。
            let requested_guard = self.inner.shutdown_started.lock().unwrap();
            let gate_closed_guard = self.inner.lifecycle_gate.lock().unwrap();
            let requested = *requested_guard;
            let gate_closed = *gate_closed_guard;
            if requested || gate_closed {
                drop(peers);
                conn.close(0u32.into(), b"shutdown-race");
                return Err(FabricInner::shutting_down_error());
            }
            peers.insert(remote, entry);
            self.inner.emit_gated_locked(
                requested,
                gate_closed,
                FabricEvent::PeerConnected {
                    endpoint_id: endpoint_id_display(&remote),
                },
            );
            // [R8-2] 所有连接附属 watcher 在同一同步临界区启动；shutdown
            // 只能在此段完成后 sweep，避免 sweep 后出现迟到的 detached task。
            let path_task = session::spawn_path_watcher_gated(
                conn.clone(),
                self.inner.lifecycle_gate.clone(),
                self.inner.shutdown_started.clone(),
                link,
                self.inner.events.clone(),
                remote,
            );
            let inner = Arc::downgrade(&self.inner);
            let id_disp = endpoint_id_display(&remote);
            let closed_conn = conn.clone();
            let closed_task = tokio::spawn(async move {
                closed_conn.closed().await;
                closed_state.store(true, std::sync::atomic::Ordering::SeqCst);
                if let Some(inner) = inner.upgrade() {
                    // [R8-1] shutdown 已进入收敛时由 drain 统一 sweep；watcher
                    // 不再改 peers 或补发下线事件。
                    if inner.lifecycle_closing() {
                        return;
                    }
                    let mut peers = inner.peers.lock().await;
                    match peers.get(&remote) {
                        // 同代次：摘除并广播下线
                        Some(e) if e.epoch == epoch => {
                            peers.remove(&remote);
                            drop(peers);
                            inner.emit_gated(FabricEvent::PeerDisconnected {
                                endpoint_id: id_disp,
                            });
                            // c2：非人为移除（代次匹配 = 条目仍在表内，无人
                            // disconnect/revoke）的会话死亡请求自动重连监管
                            //（manager 在 start() 常驻；经 channel 请求，避免
                            // insert_peer -> reconnect -> connect -> insert_peer
                            // 的递归 future Send 环）。显式断开走 None 分支，
                            // 不重连。
                            let _ = inner.reconnect_tx.send(remote);
                        }
                        // 更新代次的连接已接管：静默退出
                        Some(_) => {}
                        // 条目已被主动移除（revoke/disconnect）：仍广播下线
                        None => {
                            drop(peers);
                            inner.emit_gated(FabricEvent::PeerDisconnected {
                                endpoint_id: id_disp,
                            });
                        }
                    }
                }
            });
            // MSG 流接受循环
            let inner2 = Arc::downgrade(&self.inner);
            let remote2 = remote;
            let msg_task = tokio::spawn(async move {
                loop {
                    let conn = match inner2.upgrade() {
                        Some(i) => {
                            // [R8-1] 门后不再接收/分派业务消息。
                            if i.lifecycle_closing() {
                                break;
                            }
                            match i.peers.lock().await.get(&remote2) {
                                Some(e) => e.conn.clone(),
                                None => break,
                            }
                        }
                        None => break,
                    };
                    match conn.accept_bi().await {
                        Ok((_send, mut recv)) => {
                            if let Ok((t, payload)) =
                                session::read_frame(&mut recv, session::MAX_FRAME).await
                                && t == session::frame_type::MSG
                                && let Some(i) = inner2.upgrade()
                            {
                                if i.lifecycle_closing() {
                                    break;
                                }
                                i.emit_gated(FabricEvent::Message {
                                    from: endpoint_id_display(&remote2),
                                    data: payload,
                                });
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
            // [R8-2] 连接附属任务与 accept child 共用登记表；若防御性地发现
            // registry 已关闭，调用方在离开 peers 临界区后立即收割这些句柄。
            for task in [path_task, closed_task, msg_task] {
                if let Some(task) = register_lifecycle_task(&self.inner.accept_children, task) {
                    rejected_tasks.push(task);
                }
            }
        }
        if !rejected_tasks.is_empty() {
            // 此分支按状态机不应发生（closing 只在 producer 收敛后置位），
            // 但仍不把已拒绝任务遗留给 runtime。
            for task in rejected_tasks {
                task.abort();
                let _ = task.await;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct MemberInfo {
    pub endpoint_id: String,
    pub display_name: Option<String>,
    pub since_ms: u64,
}

/// c2 会话自动重连：监管 manager（[`spawn_reconnect_manager`]，start() 常驻）
/// 收到对端会话意外死亡的通知后，为该对端派发本退避重拨 worker——1s 起
/// 倍增、上限 30s，直至重连成功 / 本地显式断开（recent_disconnects）/
/// 对端不再是成员 / fabric 关闭。重拨完全复用 [`Fabric::connect`] 的准入
/// 语义（幂等、single-flight、shutdown 拒绝、成员门控），因此并发的
/// 人工 connect 与监管重拨天然合流。
async fn session_reconnect_worker(inner: Arc<FabricInner>, remote: EndpointId) {
    const BACKOFF_START: std::time::Duration = std::time::Duration::from_secs(1);
    const BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(30);
    let fabric = Fabric {
        inner: Arc::clone(&inner),
    };
    let id_disp = endpoint_id_display(&remote);
    let mut backoff = BACKOFF_START;
    let mut shutdown_rx = inner.shutdown_done.subscribe();
    loop {
        // 退避等待可被 shutdown 完成通知提前唤醒（完成门：无任务残留）
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = shutdown_rx.changed() => return,
        }
        if inner.lifecycle_closing() {
            return;
        }
        // 本地显式断开（disconnect 语义不被自动重连覆盖）
        if inner.recent_disconnects.lock().await.contains_key(&remote) {
            tracing::debug!(peer = %id_disp, "session reconnect cancelled: explicit disconnect");
            return;
        }
        // 已有活跃连接（并发人工 connect / 对端重拨先行成功）：worker 结束
        {
            let peers = inner.peers.lock().await;
            if peers
                .get(&remote)
                .is_some_and(|e| !e.closed.load(std::sync::atomic::Ordering::SeqCst))
            {
                return;
            }
        }
        match fabric.connect(&id_disp).await {
            Ok(()) => {
                tracing::debug!(peer = %id_disp, "session auto-reconnected");
                return; // 新连接的 closed_task 接力下一轮监管
            }
            Err(FabricError::Session(SessionError::NotMember(_))) => {
                // 对端已撤销/移除：停止重拨
                tracing::debug!(peer = %id_disp, "session reconnect cancelled: not a member");
                return;
            }
            Err(e) => {
                tracing::debug!(peer = %id_disp, err = %e, "session reconnect attempt failed");
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
    }
}

/// c2 会话自动重连监管 manager：消费意外死亡通知（closed_task 同代次分支
/// 经 `reconnect_tx` 发送），为每个对端派发退避重拨 worker（登记进
/// accept_children 生命周期表，shutdown 可收割）；manager 自身随 shutdown
/// 完成通知退出。重复通知（同一对端多次死亡堆积）由 worker 的
/// “已有活跃连接即返回” + connect single-flight 自然合流。
fn spawn_reconnect_manager(
    inner: &Arc<FabricInner>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<EndpointId>,
) -> tokio::task::JoinHandle<()> {
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        let mut shutdown_rx = inner.shutdown_done.subscribe();
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                req = rx.recv() => {
                    let Some(remote) = req else { break };
                    if inner.lifecycle_closing() {
                        break;
                    }
                    let worker = tokio::spawn(session_reconnect_worker(
                        Arc::clone(&inner),
                        remote,
                    ));
                    if let Some(task) =
                        register_lifecycle_task(&inner.accept_children, worker)
                    {
                        // registry 已关闭（shutdown 收尾中）：本地收割不留残留
                        task.abort();
                        let _ = task.await;
                    }
                }
            }
        }
    })
}

/// 接受循环：按 ALPN 分派；regular 做成员门控；redeem 仅 root 受理。
fn spawn_accept_loop(inner: &Arc<FabricInner>) -> tokio::task::JoinHandle<()> {
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        loop {
            if inner.lifecycle_closing() {
                break;
            }
            let Some(incoming) = inner.endpoint.accept().await else {
                break;
            };
            let conn = match incoming.accept() {
                Ok(a) => match a.await {
                    Ok(c) => c,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            let inner2 = Arc::clone(&inner);
            let mut child = Some(tokio::spawn(async move {
                let alpn = conn.alpn().to_vec();
                let remote = conn.remote_id();
                // [R8-2] 子任务入场即检查主门；关闭后的连接只做 close，不触碰名册。
                if inner2.lifecycle_closing() {
                    conn.close(0u32.into(), b"shutdown-race");
                    return;
                }
                if alpn == ALPN_REDEEM {
                    // 仅 root 受理兑换
                    let is_root = {
                        let roster = inner2.roster.lock().await;
                        matches!(roster.root(), Some(r) if r == inner2.identity.endpoint_id())
                    };
                    if is_root {
                        // task 2.4：v2 兑换的 member capability 附发源——
                        // root 当前配置的 restricted 条目（url→server_id）；
                        // 非 CustomWithCaps 配置 → 空表（OK2 只回名册 + 空段）
                        let (fabric_id, restricted) = {
                            let roster = inner2.roster.lock().await;
                            let restricted = match &inner2.relay {
                                RelayConfig::CustomWithCaps(entries) => entries
                                    .iter()
                                    .filter_map(|e| e.server_id.map(|sid| (e.url.clone(), sid)))
                                    .collect(),
                                _ => Vec::new(),
                            };
                            (roster.fabric_id(), restricted)
                        };
                        let minter = session::RedeemCapMinter {
                            fabric_id,
                            signer: inner2.identity.secret_key(),
                            restricted,
                        };
                        let _res = session::handle_redeem_as_issuer_gated(
                            &conn,
                            &inner2.roster,
                            &inner2.identity,
                            &inner2.roster_commit,
                            &inner2.shutdown_started,
                            inner2.lifecycle_gate.clone(),
                            Some(&minter),
                        )
                        .await;
                        {
                            // 无论成功回执还是 emit=true 拒绝记录：等对端读取并关闭，
                            // 再关连接——CONNECTION_CLOSE 会丢弃未送达的流数据（含
                            // Consumed 记录，二次兑换测试实证）。emit=false 行未写帧，
                            // 对端会自行快速关闭，此等待同样有界无害。
                            let _ =
                                tokio::time::timeout(session::REDEEM_DEADLINE, conn.closed()).await;
                        }
                        // R4 P1-1：只有成功提交名册变更（grant 已入库）才广播
                        // RosterUpdated——拒绝/失败路径不伪造名册事件。
                        if _res.is_ok() {
                            inner2.emit_gated(FabricEvent::RosterUpdated);
                        }
                    }
                    conn.close(0u32.into(), b"redeem-done");
                } else if alpn == crate::continuity::ALPN_CONTINUITY {
                    // continuity 连接：member 门控 + winner 采纳；死亡/重连
                    // 只进 ContinuityState watch，不发 FabricEvent。
                    let ok = { inner2.roster.lock().await.is_member(&remote, now_ms()) };
                    if !ok {
                        conn.close(1u32.into(), b"not a member");
                        return;
                    }
                    crate::continuity::manager::register_incoming(&inner2, remote, conn).await;
                } else if alpn == ALPN_REGULAR {
                    let ok = { inner2.roster.lock().await.is_member(&remote, now_ms()) };
                    if !ok {
                        conn.close(1u32.into(), b"not a member");
                        return;
                    }
                    match session::acceptor_hello(&conn, &inner2.roster).await {
                        Ok((facts, ctrl_send)) => {
                            // [R8-1] HELLO 后再次检查；merge 内部仍由提交锁与门
                            // 原子线性化，关闭竞态只会丢弃事实而不会落盘。
                            if inner2.lifecycle_closing() {
                                conn.close(0u32.into(), b"shutdown-race");
                                return;
                            }
                            let fabric = Fabric {
                                inner: Arc::clone(&inner2),
                            };
                            if fabric.merge_and_emit(facts).await.is_err() {
                                conn.close(0u32.into(), b"shutdown-race");
                                return;
                            }
                            // insert_peer 关闭竞态拒绝（Err）时连接已 close，此处无需额外处理
                            let _ = fabric.insert_peer(remote, conn, ctrl_send).await;
                        }
                        Err(_) => {
                            conn.close(1u32.into(), b"hello failed");
                        }
                    }
                } else {
                    conn.close(1u32.into(), b"unknown alpn");
                }
            }));
            // [R8-2] spawn 与登记之间无 await；closing 仅在外层 loop 已 join 后
            // 设置。防御性拒绝分支仍立即 abort+await，绝不遗留未登记 child。
            let rejected = register_lifecycle_task(
                &inner.accept_children,
                child.take().expect("child handle present"),
            );
            if let Some(child) = rejected {
                child.abort();
                let _ = child.await;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // ==== server-access-policy Phase 2（tasks 2.1/2.2/2.3） ======================

    fn relay_entry(url: &str, server_id: Option<[u8; 32]>, token: Option<&str>) -> RelayEntry {
        RelayEntry {
            url: url.to_owned(),
            server_id,
            token: token.map(str::to_owned),
        }
    }

    /// CustomWithCaps 测试配置（relay URL 不可达也无妨——endpoint 构造不拨号）。
    fn caps_cfg(dir: &std::path::Path, entries: Vec<RelayEntry>) -> FabricConfig {
        FabricConfig {
            data_dir: dir.to_owned(),
            relay: RelayConfig::CustomWithCaps(entries),
            ..FabricConfig::new(dir)
        }
    }

    #[tokio::test]
    async fn invite_v2_signed_when_restricted_configured() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = caps_cfg(
            dir.path(),
            vec![
                relay_entry("https://relay-a.example", Some([0xA1; 32]), None),
                relay_entry("https://relay-b.example", None, None),
            ],
        );
        let a = Fabric::create_root(cfg).await.unwrap();
        let fabric_id = a.inner.roster.lock().await.fabric_id();
        let b_id = NodeIdentity::from_seed([0x22; 32]).endpoint_id();
        let token_str = a
            .invite_with(
                60_000,
                Some(&endpoint_id_display(&b_id)),
                InviteOptions::default(),
            )
            .await
            .unwrap();
        assert!(token_str.starts_with("dweb2."), "restricted 配置必须签 v2");
        let token = crate::protocol::InviteV2Token::decode(&token_str).unwrap();
        assert_eq!(token.invite.fabric_id, fabric_id);
        assert_eq!(token.invite.recipient, b_id);
        assert_eq!(token.invite.relays.len(), 2);
        // restricted 条目带 bootstrap capability：recipient 预绑定、TTL ≤ invite
        let cap = token.invite.relays[0].capability.as_ref().unwrap();
        let parsed = crate::protocol::RelayCapV1::decode(cap).unwrap();
        assert_eq!(parsed.recipient, b_id);
        assert_eq!(parsed.server_id, [0xA1; 32]);
        assert_eq!(
            parsed.caps,
            crate::protocol::MEMBER_CAPS,
            "§7.2 默认仅 RELAY"
        );
        assert!(parsed.expires_at <= token.invite.expires_at_ms);
        // 非 restricted 条目无凭证
        assert!(token.invite.relays[1].capability.is_none());
    }

    #[tokio::test]
    async fn invite_v2_requires_recipient() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = caps_cfg(
            dir.path(),
            vec![relay_entry("https://r.example", Some([1; 32]), None)],
        );
        let a = Fabric::create_root(cfg).await.unwrap();
        match a.invite(60_000, None).await {
            Err(FabricError::InviteV2RequiresRecipient) => {}
            other => panic!("expected InviteV2RequiresRecipient, got {other:?}"),
        }
    }

    /// 无 restricted 条目（server_id 全 None）→ v1 令牌，前缀行为零变化。
    #[tokio::test]
    async fn invite_stays_v1_without_restricted_entries() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = caps_cfg(
            dir.path(),
            vec![relay_entry("https://r.example", None, None)],
        );
        let a = Fabric::create_root(cfg).await.unwrap();
        let token_str = a.invite(60_000, None).await.unwrap();
        assert!(token_str.starts_with("dweb1."), "非 restricted 配置维持 v1");
        assert!(crate::protocol::InviteToken::decode(&token_str).is_ok());
    }

    #[tokio::test]
    async fn ensure_relay_capabilities_root_self_signs_non_root_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = caps_cfg(
            dir.path(),
            vec![
                relay_entry("https://relay-a.example", Some([0xA1; 32]), None),
                relay_entry("https://relay-b.example", None, None),
            ],
        );
        let a = Fabric::create_root(cfg).await.unwrap();
        let caps = a.ensure_relay_capabilities().await.unwrap();
        assert_eq!(caps.len(), 1, "仅 server_id 条目自签");
        assert_eq!(caps[0].0, "https://relay-a.example");
        let parsed = crate::protocol::RelayCapV1::decode(&caps[0].1).unwrap();
        let me = a.inner.identity.endpoint_id();
        assert_eq!(parsed.recipient, me, "own capability recipient = root");
        assert_eq!(parsed.issuer, me);
        assert_eq!(parsed.caps, crate::protocol::ROOT_CAPS, "root 全位（§7.2）");
        assert_eq!(
            parsed.expires_at - parsed.issued_at,
            crate::protocol::ROOT_CAP_TTL_MS,
            "TTL = 180d - 1ms"
        );
        // 注入生效：endpoint RelayMap 条目带 auth token
        assert_eq!(
            a.relay_map_token("https://relay-a.example").as_deref(),
            Some(caps[0].1.as_str())
        );
        assert_eq!(a.relay_map_token("https://relay-b.example"), None);

        // 非 root 调用 → NotRoot（同源 RosterError）
        let dir_b = tempfile::tempdir().unwrap();
        let fid = a.fabric_id_hex().await;
        let b = Fabric::attach(
            caps_cfg(
                dir_b.path(),
                vec![relay_entry(
                    "https://relay-a.example",
                    Some([0xA1; 32]),
                    None,
                )],
            ),
            &fid,
        )
        .await
        .unwrap();
        match b.ensure_relay_capabilities().await {
            Err(FabricError::Roster(crate::roster::RosterError::NotRoot { .. })) => {}
            other => panic!("expected NotRoot, got {other:?}"),
        }
    }

    #[test]
    fn relay_caps_store_roundtrip_and_upsert() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            load_relay_caps(dir.path()).unwrap().is_empty(),
            "缺文件 = 空"
        );
        // 时间基用真实墙钟（load 侧丢弃已过期条目——过期语义由
        // load_relay_caps_drops_expired_and_store_compacts 单独覆盖）
        let now = now_ms();
        let t1 = crate::protocol::RelayCapV1::sign_and_encode(
            NodeIdentity::from_seed([1; 32]).secret_key(),
            &crate::protocol::FabricId::from_name("f"),
            &[2; 32],
            &NodeIdentity::from_seed([3; 32]).endpoint_id(),
            crate::protocol::MEMBER_CAPS,
            now,
            now + 60_000,
        )
        .unwrap();
        let t2 = crate::protocol::RelayCapV1::sign_and_encode(
            NodeIdentity::from_seed([1; 32]).secret_key(),
            &crate::protocol::FabricId::from_name("f"),
            &[2; 32],
            &NodeIdentity::from_seed([3; 32]).endpoint_id(),
            crate::protocol::MEMBER_CAPS,
            now + 1_000,
            now + 61_000,
        )
        .unwrap();
        // 初始落盘 + 新 url 追加 + 同 url 覆盖
        store_relay_caps(dir.path(), &[("https://a.example".to_owned(), t1.clone())]).unwrap();
        store_relay_caps(dir.path(), &[("https://b.example".to_owned(), t2.clone())]).unwrap();
        store_relay_caps(dir.path(), &[("https://a.example".to_owned(), t2.clone())]).unwrap();
        let loaded = load_relay_caps(dir.path()).unwrap();
        assert_eq!(
            loaded,
            vec![
                ("https://a.example".to_owned(), t2.clone()),
                ("https://b.example".to_owned(), t2.clone()),
            ],
            "同 url 覆盖、异 url 保序追加"
        );
        // 内存 upsert 语义与文件一致
        let mut mem = vec![("https://a.example".to_owned(), t1)];
        assert!(upsert_relay_caps(
            &mut mem,
            &[("https://a.example".to_owned(), t2.clone())]
        ));
        assert_eq!(mem.len(), 1);
        assert_eq!(mem[0].1, t2);
        assert!(!upsert_relay_caps(
            &mut mem,
            &[("https://a.example".to_owned(), t2.clone())]
        ));
        // 损坏文件 → 显式错误（不静默吞 bearer 凭证）
        std::fs::write(relay_caps_path(dir.path()), b"not json").unwrap();
        assert!(matches!(
            load_relay_caps(dir.path()),
            Err(FabricError::RelayCapsStore { .. })
        ));
    }

    #[test]
    fn invite_v2_relay_order_active_first() {
        let entries = vec![
            relay_entry("https://dead.example", Some([1; 32]), None),
            relay_entry("https://live.example", Some([2; 32]), None),
        ];
        let snapshot = RelayStatusSnapshot {
            mode: "custom",
            urls: vec!["https://dead.example".into(), "https://live.example".into()],
            online: Some(true),
            active_url: Some("https://live.example/".into()),
            last_error: None,
        };
        let ordered = invite_v2_relay_order(&entries, &snapshot);
        assert_eq!(ordered[0].url, "https://live.example", "active 稳定提前");
        assert_eq!(ordered[1].url, "https://dead.example", "其余保配置序");
        // 快照未沉降 → 配置序
        let offline = RelayStatusSnapshot {
            online: Some(false),
            active_url: None,
            ..snapshot
        };
        let ordered = invite_v2_relay_order(&entries, &offline);
        assert_eq!(ordered[0].url, "https://dead.example");
    }

    #[test]
    fn inject_relay_tokens_sets_entry_level_auth() {
        let map = iroh_relay::RelayMap::empty();
        inject_relay_tokens(
            &map,
            &[
                ("https://r.example".to_owned(), "tok-1".to_owned()),
                ("https://plain.example".to_owned(), String::new()),
                ("::not a url::".to_owned(), "tok-2".to_owned()),
            ],
        );
        let cfg = map
            .get(&"https://r.example".parse::<iroh::RelayUrl>().unwrap())
            .unwrap();
        assert_eq!(cfg.auth_token.as_deref(), Some("tok-1"));
        let plain = map
            .get(&"https://plain.example".parse::<iroh::RelayUrl>().unwrap())
            .unwrap();
        assert!(plain.auth_token.is_none(), "空 token = 无凭证条目");
        assert_eq!(map.len(), 2, "不可解析 URL 跳过");
    }

    #[test]
    fn load_relay_caps_drops_expired_and_store_compacts() {
        // 云端实证回归：过期 member cap 残留在 relay.caps.json——加载侧必须
        // 丢弃（构造期注入过期票 → eager relay 握手被拒 → join bootstrap
        // 追不上 deny 退避）；良构未过期条目原样保留。
        let dir = tempfile::tempdir().expect("tempdir");
        let id = NodeIdentity::from_seed([0xEE; 32]);
        let fabric = crate::protocol::FabricId::from_name("caps-expiry");
        let server = [0x5A; 32];
        let now = now_ms();
        let mint = |issued: u64, expires: u64| {
            crate::protocol::RelayCapV1::sign_and_encode(
                id.secret_key(),
                &fabric,
                &server,
                &id.endpoint_id(),
                crate::protocol::CAP_RELAY,
                issued,
                expires,
            )
            .expect("mint cap")
        };
        let expired = mint(now - 120_000, now - 60_000);
        let valid = mint(now - 1_000, now + 600_000);
        let path = dir.path().join(RELAY_CAPS_FILE);
        std::fs::write(
            &path,
            serde_json::to_string(&serde_json::json!([
                { "url": "http://127.0.0.1:9", "capability": expired },
                { "url": "http://127.0.0.1:10", "capability": valid },
            ]))
            .unwrap(),
        )
        .expect("预置 caps 文件");
        let loaded = load_relay_caps(dir.path()).expect("load");
        assert_eq!(loaded.len(), 1, "过期条目丢弃、未过期保留: {loaded:?}");
        assert_eq!(loaded[0].0, "http://127.0.0.1:10");
        assert_eq!(loaded[0].1, valid);
        // 等值边界与 server 侧 L1 同语义：now == expires_at 即过期
        let boundary = mint(now - 1_000, now);
        std::fs::write(
            &path,
            serde_json::to_string(&serde_json::json!([
                { "url": "http://127.0.0.1:11", "capability": boundary },
            ]))
            .unwrap(),
        )
        .expect("预置边界 caps 文件");
        assert!(
            load_relay_caps(dir.path())
                .expect("load boundary")
                .is_empty(),
            "now >= expires_at 等值即拒"
        );
        // 惰性压实：下次 store 的 read-merge-write 不再把过期条目写回
        let fresh = mint(now, now + 300_000);
        store_relay_caps(dir.path(), &[("http://127.0.0.1:10".to_owned(), fresh)]).expect("store");
        let on_disk = std::fs::read_to_string(&path).expect("read back");
        assert!(
            !on_disk.contains("127.0.0.1:11"),
            "过期条目已压实: {on_disk}"
        );
        assert!(on_disk.contains("127.0.0.1:10"));
    }

    #[test]
    fn precheck_dweb2_token_maps_to_ninth_code() {
        // 构造合法 v2 令牌（recipient 必填）→ v1 precheck 必须报第九码
        let issuer = NodeIdentity::from_seed([5; 32]);
        let invite = crate::protocol::InviteV2 {
            fabric_id: crate::protocol::FabricId::from_name("ninth"),
            invite_id: [0xCD; 16],
            issuer: issuer.endpoint_id(),
            expires_at_ms: now_ms() + 60_000,
            recipient: NodeIdentity::from_seed([6; 32]).endpoint_id(),
            relays: vec![],
            direct_addrs: vec![],
        };
        let token = crate::protocol::InviteV2Token::sign(invite, issuer.secret_key())
            .unwrap()
            .encode()
            .unwrap();
        match precheck_join_token(&token) {
            Err(FabricError::Join {
                code: JoinErrorCode::UnsupportedInviteVersion,
                message,
            }) => {
                assert!(message.contains("upgrade"), "含升级指引: {message}");
                assert_eq!(
                    JoinErrorCode::UnsupportedInviteVersion.kebab(),
                    "unsupported-invite-version"
                );
            }
            other => panic!("expected ninth code, got {other:?}"),
        }
    }

    #[test]
    fn merge_dial_candidates_includes_custom_with_caps_urls() {
        let id = NodeIdentity::from_seed([1; 32]).endpoint_id();
        let relay = RelayConfig::CustomWithCaps(vec![
            relay_entry("https://r1.example", Some([1; 32]), None),
            relay_entry("https://r2.example", None, None),
        ]);
        let addr = Fabric::merge_dial_candidates(&id, &["127.0.0.1:9999".to_owned()], &relay);
        let urls: Vec<String> = addr
            .addrs
            .iter()
            .filter_map(|a| match a {
                iroh_base::TransportAddr::Relay(u) => Some(u.to_string()),
                _ => None,
            })
            .collect();
        assert_eq!(urls.len(), 2, "全部条目并入候选（spec delta 场景）");
    }

    // ---- 3.1 advertise_addrs 构造期校验 --------------------------------------

    #[test]
    fn advertise_addrs_accepts_loopback_and_dedupes_in_order() {
        let out = normalize_advertise_addrs(&[
            "192.168.1.10:53210".to_owned(),
            "127.0.0.1:9999".to_owned(),
            "192.168.1.10:53210".to_owned(),
            "[::1]:443".to_owned(),
        ])
        .unwrap();
        assert_eq!(
            out,
            vec![
                "192.168.1.10:53210".to_owned(),
                "127.0.0.1:9999".to_owned(),
                "[::1]:443".to_owned()
            ],
            "重复去重保序；loopback 允许"
        );
    }

    #[test]
    fn advertise_addrs_rejects_bad_inputs() {
        let bad = [
            "",
            "   ",
            "not an addr",
            "localhost:1234", // 非 ip:port
            "0.0.0.0:1234",   // 通配 v4
            "[::]:1234",      // 通配 v6
            "192.168.1.10:0", // 端口 0
        ];
        for raw in bad {
            let err = normalize_advertise_addrs(&[raw.to_owned()]).unwrap_err();
            assert!(
                matches!(err, FabricError::BadAdvertiseAddr { ref addr, .. } if addr == raw),
                "{raw:?} must be rejected with BadAdvertiseAddr, got {err:?}"
            );
        }
    }

    #[test]
    fn config_validate_bounds_and_proxy() {
        let mut cfg = FabricConfig::new("/tmp/x");
        // join_timeout_ms 值域：边界包含、越界拒绝
        for ok in [1000u64, 600000] {
            cfg.join_timeout_ms = ok;
            assert!(cfg.validate().is_ok(), "{ok} in range");
        }
        for bad in [999u64, 0, 600001, u64::MAX] {
            cfg.join_timeout_ms = bad;
            assert!(
                matches!(cfg.validate(), Err(FabricError::JoinTimeoutOutOfRange(v)) if v == bad),
                "{bad} out of range"
            );
        }
        cfg.join_timeout_ms = JOIN_TIMEOUT_MS_DEFAULT;
        // 代理 URL 非法
        cfg.http_proxy = HttpProxyConfig::Url("not a url".into());
        assert!(matches!(
            cfg.validate(),
            Err(FabricError::BadProxyUrl(u)) if u == "not a url"
        ));
        cfg.http_proxy = HttpProxyConfig::Url("http://127.0.0.1:7890".into());
        assert!(cfg.validate().is_ok());
        // bind_addr 非法
        cfg.http_proxy = HttpProxyConfig::None;
        cfg.bind_addr = Some("nope".into());
        assert!(matches!(cfg.validate(), Err(FabricError::BadBindAddr(_))));
        cfg.bind_addr = Some("127.0.0.1:1".into());
        assert!(cfg.validate().is_ok());
    }

    // ---- D4 聚合纯函数 --------------------------------------------------------

    fn view(url: &str, connected: bool, err: Option<&str>) -> RelayStatusView {
        RelayStatusView {
            url: url.to_owned(),
            connected,
            last_error: err.map(str::to_owned),
        }
    }

    #[test]
    fn aggregate_online_is_any_and_url_tie_break_is_config_order() {
        let urls = vec![
            "https://relay-b.example".to_owned(),
            "https://relay-a.example".to_owned(),
        ];
        // watcher 报告顺序与配置序相反：仍取配置序最小（relay-b）
        let agg = aggregate_relay_status(
            &urls,
            &[
                view("https://relay-a.example", true, None),
                view("https://relay-b.example", true, None),
            ],
        );
        assert!(agg.online);
        assert_eq!(agg.online_url.as_deref(), Some("https://relay-b.example"));
        // 仅后者连上
        let agg = aggregate_relay_status(
            &urls,
            &[view("https://relay-b.example", false, Some("refused"))],
        );
        assert!(!agg.online);
        assert!(agg.online_url.is_none());
        // R2 P1-4：watcher 报告规范化形态（尾 "/"）而配置为裸串——匹配仍命中，
        // online_url 返回**配置原样串**（对外契约不做尾斜杠改写）
        let agg = aggregate_relay_status(
            &urls,
            &[
                view("https://relay-a.example/", true, None),
                view("https://relay-b.example/", true, None),
            ],
        );
        assert!(agg.online);
        assert_eq!(agg.online_url.as_deref(), Some("https://relay-b.example"));
    }

    #[test]
    fn aggregate_last_error_takes_first_by_config_order() {
        let urls = vec![
            "https://r1.example".to_owned(),
            "https://r2.example".to_owned(),
        ];
        // watcher 到达序 r2 在前：仍按配置序取 r1 的错误
        let agg = aggregate_relay_status(
            &urls,
            &[
                view("https://r2.example", false, Some("dns error")),
                view("https://r1.example", false, Some("connect timeout")),
            ],
        );
        assert_eq!(
            agg.last_error.as_deref(),
            Some("connect timeout (host r1.example)")
        );
        // 全部已连接：lastError None
        let agg = aggregate_relay_status(
            &urls,
            &[
                view("https://r1.example", true, None),
                view("https://r2.example", true, None),
            ],
        );
        assert!(agg.last_error.is_none());
        // 已连接的 relay 不贡献错误
        let agg = aggregate_relay_status(
            &urls,
            &[
                view("https://r1.example", true, Some("stale")),
                view("https://r2.example", false, Some("tls error")),
            ],
        );
        assert_eq!(
            agg.last_error.as_deref(),
            Some("tls error (host r2.example)")
        );
    }

    #[test]
    fn sanitize_relay_error_maps_categories() {
        assert_eq!(
            sanitize_relay_error("tcp connect timed out"),
            "connect timeout"
        );
        assert_eq!(
            sanitize_relay_error("Connection refused (os error 61)"),
            "connection refused"
        );
        assert_eq!(sanitize_relay_error("dns resolution failed"), "dns error");
        assert_eq!(sanitize_relay_error("invalid certificate"), "tls error");
        assert_eq!(sanitize_relay_error(""), "connection error");
    }

    // ---- task 2.5：deny reason 提取/透传 -------------------------------------------

    #[test]
    fn extract_deny_reason_scans_structured_tokens() {
        // iroh ServerDeniedAuth Display 形态（错误链折进文本）
        assert_eq!(
            extract_deny_reason("The relay denied our authentication (dweb/no-capability)"),
            Some("dweb/no-capability")
        );
        assert_eq!(
            extract_deny_reason("handshake: relay denied: dweb/capability-expired, retrying"),
            Some("dweb/capability-expired")
        );
        // 多段 reason（服务端语法允许 . _ -）
        assert_eq!(
            extract_deny_reason("x dweb/policy.denied_2-a y"),
            Some("dweb/policy.denied_2-a")
        );
        // 非 deny 文本 / 空 reason / 前缀不完整
        assert_eq!(extract_deny_reason("tcp connect timed out"), None);
        assert_eq!(extract_deny_reason("dweb/ (empty reason)"), None);
        assert_eq!(extract_deny_reason("adweb/no-capability"), None);
    }

    #[test]
    fn sanitize_relay_error_passes_deny_reason_through() {
        // D4 脱敏的 task 2.5 例外：结构化 deny reason 不折叠进泛化类别
        assert_eq!(
            sanitize_relay_error("The relay denied our authentication (dweb/not-recipient)"),
            "relay denied: dweb/not-recipient"
        );
        // deny 优先于类别映射（含 timeout 字样的 deny 文本）
        assert_eq!(
            sanitize_relay_error("denied dweb/capability-expired after timeout"),
            "relay denied: dweb/capability-expired"
        );
    }

    // ---- HB 3.1 拨号候选合并（learned 不遮蔽 relay，冻结语义） ----------------------

    /// PublicKey::from_bytes 校验点有效性，随机字节不合法——经 SecretKey 派生。
    fn any_id(seed: u8) -> EndpointId {
        iroh_base::SecretKey::from_bytes(&[seed; 32]).public()
    }

    /// RelayUrl 规范化（url crate 给空路径补 "/"）：断言比较用解析后的形态。
    fn norm_url(u: &str) -> String {
        u.parse::<iroh::RelayUrl>().unwrap().to_string()
    }

    fn relay_urls_of(addr: &EndpointAddr) -> Vec<String> {
        addr.relay_urls().map(|u| u.to_string()).collect()
    }

    #[test]
    fn merge_learned_direct_addrs_do_not_shadow_custom_relays() {
        // 冻结场景：对端有 learned 直连地址且本地配置了 custom relay——
        // relay 候选必须仍在（learned 是补充不是替代）
        let addr = Fabric::merge_dial_candidates(
            &any_id(1),
            &["127.0.0.1:5000".to_owned()],
            &RelayConfig::Custom(vec![
                "https://relay-a.example".to_owned(),
                "https://relay-b.example".to_owned(),
            ]),
        );
        assert!(addr.ip_addrs().any(|ip| ip.port() == 5000));
        let urls = relay_urls_of(&addr);
        assert!(urls.contains(&norm_url("https://relay-a.example")));
        assert!(urls.contains(&norm_url("https://relay-b.example")));
    }

    #[test]
    fn merge_learned_relay_and_config_relays_all_participate() {
        // learned relay（如令牌携带的 issuer relay）+ 本地配置 relay 同时参与
        let addr = Fabric::merge_dial_candidates(
            &any_id(2),
            &[
                "https://issuer-relay.example".to_owned(),
                "127.0.0.1:9999".to_owned(),
            ],
            &RelayConfig::Custom(vec!["https://local-relay.example".to_owned()]),
        );
        let urls = relay_urls_of(&addr);
        assert_eq!(
            urls,
            vec![
                norm_url("https://issuer-relay.example"),
                norm_url("https://local-relay.example"),
            ]
        );
        assert!(addr.ip_addrs().any(|ip| ip.to_string() == "127.0.0.1:9999"));
    }

    #[test]
    fn merge_without_learned_uses_config_and_skips_junk() {
        // 无 learned：退回配置（P1-6 全量进入）
        let addr = Fabric::merge_dial_candidates(
            &any_id(3),
            &[],
            &RelayConfig::Custom(vec!["https://r.example".to_owned()]),
        );
        assert_eq!(relay_urls_of(&addr), vec![norm_url("https://r.example")]);
        // learned 含不可解析垃圾：跳过（防御 add_known_addr 手工注入）
        let addr = Fabric::merge_dial_candidates(
            &any_id(4),
            &["junk not an addr".to_owned()],
            &RelayConfig::N0Default,
        );
        // R3 P1-4：N0 = iroh 上游真实默认列表（排序冻结配置序）
        assert_eq!(
            relay_urls_of(&addr),
            n0_default_urls()
                .iter()
                .map(|u| norm_url(u))
                .collect::<Vec<_>>()
        );
        // Disabled + 无 learned：空（调用方按 NoAddressingInfo 拒绝）
        let addr = Fabric::merge_dial_candidates(&any_id(5), &[], &RelayConfig::Disabled);
        assert!(addr.addrs.is_empty());
    }

    // ---- c1/c2 relay failover ------------------------------------------------------

    fn snapshot(online: Option<bool>, active_url: Option<String>) -> RelayStatusSnapshot {
        RelayStatusSnapshot {
            mode: "custom",
            urls: Vec::new(),
            online,
            active_url,
            last_error: None,
        }
    }

    #[test]
    fn invite_relay_url_prefers_live_relay_and_maps_back_to_config_form() {
        let cfg = RelayConfig::Custom(vec![
            "https://dead.example".to_owned(),
            "https://alive.example".to_owned(),
        ]);
        // online 且 active_url 指向活条目（watcher 归一化形态带尾 "/"）：
        // 令牌携带活条目，且映射回配置原样字符串（无尾斜杠）
        let url = invite_relay_url(
            &cfg,
            &snapshot(Some(true), Some("https://alive.example/".to_owned())),
        );
        assert_eq!(url, "https://alive.example");
        // 快照未沉降（online=None）：回退配置序首条（与旧行为一致）
        let url = invite_relay_url(&cfg, &snapshot(None, None));
        assert_eq!(url, "https://dead.example");
        // offline：同样回退配置序首条（宁缺勿假）
        let url = invite_relay_url(
            &cfg,
            &snapshot(Some(false), Some("https://alive.example".to_owned())),
        );
        assert_eq!(url, "https://dead.example");
        // disabled：恒空
        assert_eq!(
            invite_relay_url(&RelayConfig::Disabled, &snapshot(None, None)),
            ""
        );
    }

    #[test]
    fn join_dial_candidates_merge_token_relay_with_local_config() {
        // c1 单元冻结：join 的拨号候选 = 令牌 issuer relay（learned）+ 本地
        // relay 配置全量——issuer 配置首条（令牌来源）死亡时，同列表其余
        // relay 兜底承接，不再被单死条目阻断
        let token_addr = session::endpoint_addr_from_invite(&test_token(
            "https://dead.example",
            &["192.168.1.4:9000"],
        ))
        .unwrap();
        let addr = Fabric::with_local_relay_candidates(
            token_addr,
            &RelayConfig::Custom(vec![
                "https://dead.example".to_owned(),
                "https://alive.example".to_owned(),
            ]),
        );
        let urls = relay_urls_of(&addr);
        // EndpointAddr 内部为去重集合（BTreeSet 序）；iroh 对全部已知路径
        // 并发发初始包，候选“参与”即 failover，顺序无功能语义
        assert_eq!(urls.len(), 2, "{urls:?}");
        assert!(urls.contains(&norm_url("https://dead.example")));
        assert!(urls.contains(&norm_url("https://alive.example")));
        assert!(
            addr.ip_addrs()
                .any(|ip| ip.to_string() == "192.168.1.4:9000")
        );
    }

    /// 构造最小邀请令牌（单测用；字段语义同 roster::issue_invite 产物）。
    fn test_token(relay: &str, direct: &[&str]) -> crate::protocol::InviteToken {
        let dir = tempfile::tempdir().unwrap();
        let identity = crate::identity::NodeIdentity::from_seed([0x42; 32]);
        let (mut roster, _fid) = crate::roster::Roster::create(&identity, dir.path(), 0).unwrap();
        roster
            .issue_invite(
                &identity,
                relay.to_owned(),
                direct.iter().map(|s| s.to_string()).collect(),
                None,
                60_000,
                0,
            )
            .unwrap()
    }

    // ---- HB 5.1 RelayTlsTrust 受限枚举 ---------------------------------------------

    #[test]
    fn relay_tls_trust_platform_root_maps_to_default_and_bad_pem_rejected() {
        // PlatformRoot：不设置上游 CA（iroh 默认内置根）
        assert!(
            RelayTlsTrust::PlatformRoot
                .to_ca_tls_config()
                .unwrap()
                .is_none()
        );
        // 非法 PEM / 空内容：构造期校验拒绝
        let mut cfg = FabricConfig::new("/tmp/x");
        cfg.relay_tls_trust = RelayTlsTrust::CustomPem(b"not a pem".to_vec());
        assert!(matches!(
            cfg.validate(),
            Err(FabricError::BadRelayTlsPem(_))
        ));
        cfg.relay_tls_trust = RelayTlsTrust::CustomPem(
            b"-----BEGIN CERTIFICATE-----\n!!!!\n-----END CERTIFICATE-----\n".to_vec(),
        );
        assert!(matches!(
            cfg.validate(),
            Err(FabricError::BadRelayTlsPem(_))
        ));
        cfg.relay_tls_trust = RelayTlsTrust::CustomPem(Vec::new());
        assert!(matches!(
            cfg.validate(),
            Err(FabricError::BadRelayTlsPem(ref m)) if m.contains("no CERTIFICATE")));
        // Debug 不回显 PEM 字节
        assert_eq!(
            format!("{:?}", RelayTlsTrust::CustomPem(vec![1, 2, 3])),
            "RelayTlsTrust::CustomPem(3 bytes)"
        );
    }

    #[test]
    fn custom_pem_combined_with_n0_default_rejected() {
        // R2 P1-2：CustomPem 是"仅自定义根"——叠加 N0Default 会让官方 relay
        // 证书失去内置根信任而静默离线，组合无定义语义，构造期拒绝。
        let mut cfg = FabricConfig::new("/tmp/x");
        cfg.relay = RelayConfig::N0Default;
        cfg.relay_tls_trust = RelayTlsTrust::CustomPem(
            b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n".to_vec(),
        );
        let err = cfg.validate().unwrap_err().to_string();
        assert!(
            err.contains("cannot be combined"),
            "must reject N0Default + CustomPem with guidance, got: {err}"
        );
        // custom relay + CustomPem：合法组合不受影响
        cfg.relay = RelayConfig::Custom(vec!["https://self-hosted.example".to_owned()]);
        assert!(cfg.validate().is_ok());
    }

    // ---- D4 watch loop（确定性注入流） ----------------------------------------

    use tokio::sync::broadcast;

    fn snap() -> Arc<std::sync::Mutex<RelayStatusSnapshot>> {
        Arc::new(std::sync::Mutex::new(RelayStatusSnapshot {
            mode: "custom",
            urls: vec!["https://r1.example".into()],
            online: Some(false),
            active_url: None,
            last_error: None,
        }))
    }

    fn views(items: &[(bool, Option<&str>)]) -> Vec<RelayStatusView> {
        items
            .iter()
            .map(|(c, e)| view("https://r1.example", *c, *e))
            .collect()
    }

    #[tokio::test]
    async fn watch_loop_first_value_only_updates_snapshot_no_broadcast() {
        let (tx, mut rx) = broadcast::channel(16);
        let snapshot = snap();
        // 首值即为 online：不广播
        let stream = n0_future::stream::iter(vec![views(&[(true, None)])]);
        relay_watch_loop(
            stream,
            vec!["https://r1.example".into()],
            snapshot.clone(),
            Arc::new(std::sync::Mutex::new(false)),
            Arc::new(std::sync::Mutex::new(false)),
            tx,
        )
        .await;
        assert!(rx.try_recv().is_err(), "first value must not broadcast");
        assert_eq!(snapshot.lock().unwrap().online, Some(true));
        // HB 8.1：首值同样写入 active_url（online => 配置序最小已连接）
        assert_eq!(
            snapshot.lock().unwrap().active_url.as_deref(),
            Some("https://r1.example")
        );
    }

    #[tokio::test]
    async fn watch_loop_matches_normalized_report_and_returns_config_string() {
        // R2 P1-4 回归：watcher 报告规范化形态（尾 "/"）而配置串保持原样——
        // 聚合仍须匹配（tie-break 命中），active_url 输出**配置原样字符串**
        // （对外契约冻结，不做尾斜杠改写）。
        let (tx, _rx) = broadcast::channel(16);
        let snapshot = snap();
        let stream = n0_future::stream::iter(vec![vec![view("https://r1.example/", true, None)]]);
        relay_watch_loop(
            stream,
            vec!["https://r1.example".into()],
            snapshot.clone(),
            Arc::new(std::sync::Mutex::new(false)),
            Arc::new(std::sync::Mutex::new(false)),
            tx,
        )
        .await;
        let s = snapshot.lock().unwrap();
        assert_eq!(s.online, Some(true));
        assert_eq!(s.active_url.as_deref(), Some("https://r1.example"));
        assert_eq!(s.urls, vec!["https://r1.example".to_owned()]);
    }

    #[tokio::test]
    async fn watch_loop_broadcasts_only_on_aggregate_jumps() {
        let (tx, mut rx) = broadcast::channel(16);
        let snapshot = snap();
        let stream = n0_future::stream::iter(vec![
            views(&[(false, None)]),                    // 首值（offline）
            views(&[(false, Some("refused"))]),         // 同态：错误变化不广播
            views(&[(true, None)]),                     // 跳变 online → RelayOnline
            views(&[(true, None)]),                     // 同态：不广播
            views(&[(false, Some("connect timeout"))]), // 跳变 offline → RelayOffline
        ]);
        relay_watch_loop(
            stream,
            vec!["https://r1.example".into()],
            snapshot.clone(),
            Arc::new(std::sync::Mutex::new(false)),
            Arc::new(std::sync::Mutex::new(false)),
            tx,
        )
        .await;
        let first = rx.recv().await.unwrap();
        // R3 P1-2：事件携带跳变后完整快照（online=true 时 active_url 必非空）
        assert!(matches!(
            &first,
            FabricEvent::RelayOnline { snapshot }
                if snapshot.online == Some(true)
                    && snapshot.active_url.as_deref() == Some("https://r1.example")
        ));
        let second = rx.recv().await.unwrap();
        assert!(matches!(
            &second,
            FabricEvent::RelayOffline { snapshot }
                if snapshot.online == Some(false) && snapshot.active_url.is_none()
        ));
        assert!(rx.try_recv().is_err());
        // 快照反映最新错误（同态变化入快照）
        assert_eq!(
            snapshot.lock().unwrap().last_error.as_deref(),
            Some("connect timeout (host r1.example)")
        );
        // HB 8.1：active_url 随聚合态翻转（offline => None）
        assert_eq!(snapshot.lock().unwrap().online, Some(false));
        assert_eq!(snapshot.lock().unwrap().active_url, None);
    }

    #[tokio::test]
    async fn watch_loop_stream_end_is_silent_shutdown() {
        // 流结束（endpoint 释放）后循环退出、不再广播（abort 语义的确定性近似）
        let (tx, mut rx) = broadcast::channel(16);
        let snapshot = snap();
        let stream = n0_future::stream::iter(vec![views(&[(false, None)])]);
        relay_watch_loop(
            stream,
            vec![],
            snapshot,
            Arc::new(std::sync::Mutex::new(false)),
            Arc::new(std::sync::Mutex::new(false)),
            tx,
        )
        .await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn watch_loop_gate_blocks_late_transition() {
        // [R8-1] 关闭门先置位时，已排队的 watcher 状态也不得产生事件。
        let (tx, mut rx) = broadcast::channel(16);
        let snapshot = snap();
        let gate = Arc::new(std::sync::Mutex::new(true));
        let stream = n0_future::stream::iter(vec![views(&[(true, None)])]);
        relay_watch_loop(
            stream,
            vec!["https://r1.example".into()],
            snapshot.clone(),
            gate,
            Arc::new(std::sync::Mutex::new(false)),
            tx,
        )
        .await;
        assert!(rx.try_recv().is_err(), "gated watcher must stay silent");
        assert_eq!(snapshot.lock().unwrap().online, Some(false));
    }

    // ---- D3 invite 门（三分支）+ 签发路径不混入 hints ---------------------------

    fn cfg(dir: &tempfile::TempDir) -> FabricConfig {
        FabricConfig {
            data_dir: dir.path().to_owned(),
            relay: RelayConfig::Disabled,
            advertise_addrs: Vec::new(),
            secret: SecretInjection::Default,
            http_proxy: HttpProxyConfig::None,
            join_timeout_ms: JOIN_TIMEOUT_MS_DEFAULT,
            bind_addr: None,
            relay_tls_trust: RelayTlsTrust::PlatformRoot,
        }
    }

    #[tokio::test]
    async fn invite_gate_three_branches() {
        let dir = tempfile::TempDir::new().unwrap();
        // 分支 1：relay 空 + advertise 空 + 无逃生阀 → 拒签
        let a = Fabric::create_root(cfg(&dir)).await.unwrap();
        let err = a.invite(60_000, None).await.unwrap_err();
        assert!(matches!(err, FabricError::InviteWithoutRelay), "{err:?}");
        // 分支 3：逃生阀放行；且 token 直连地址为空（永不混入 direct_addr_hints）
        let token = a
            .invite_with(
                60_000,
                None,
                InviteOptions {
                    allow_relayless: true,
                },
            )
            .await
            .unwrap();
        let decoded = crate::protocol::InviteToken::decode(&token).unwrap();
        assert!(decoded.invite.issuer_relay_url.is_empty());
        assert!(
            decoded.invite.issuer_direct_addrs.is_empty(),
            "issuance path must never mix in runtime direct_addr_hints"
        );

        // 分支 2：advertise_addrs 非空 → 正常签发且直连地址 = 配置值
        let dir2 = tempfile::TempDir::new().unwrap();
        let b = Fabric::create_root(FabricConfig {
            advertise_addrs: vec!["127.0.0.1:41234".into()],
            ..cfg(&dir2)
        })
        .await
        .unwrap();
        let token2 = b.invite(60_000, None).await.unwrap();
        let decoded2 = crate::protocol::InviteToken::decode(&token2).unwrap();
        assert!(decoded2.invite.issuer_relay_url.is_empty());
        assert_eq!(
            decoded2.invite.issuer_direct_addrs,
            vec!["127.0.0.1:41234".to_owned()]
        );

        // 非法 advertise_addrs：构造期报错（不入运行）
        let dir3 = tempfile::TempDir::new().unwrap();
        let bad = Fabric::create_root(FabricConfig {
            advertise_addrs: vec!["0.0.0.0:1".into()],
            ..cfg(&dir3)
        })
        .await;
        assert!(
            matches!(bad, Err(FabricError::BadAdvertiseAddr { .. })),
            "wildcard advertise addr must fail construction"
        );

        a.shutdown().await.unwrap();
        b.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_blocks_roster_writes_and_collects_accept_tasks() {
        // [R8-1/R8-2] 完成通知前 gate 已切换、外层 loop 已 join、child 表已清空；
        // 关闭后的公开名册写入统一快速失败且不改变投影。
        let dir = tempfile::TempDir::new().unwrap();
        let fabric = Fabric::create_root(cfg(&dir)).await.unwrap();
        let before = fabric.members().await;
        fabric.shutdown().await.unwrap();

        let result = fabric.set_display_name("late").await;
        assert!(
            result.is_err(),
            "post-shutdown display-name write must fail"
        );
        let result = fabric
            .invite_with(
                60_000,
                None,
                InviteOptions {
                    allow_relayless: true,
                },
            )
            .await;
        assert!(result.is_err(), "post-shutdown invite write must fail");
        let result = fabric.revoke(&fabric.endpoint_id()).await;
        assert!(result.is_err(), "post-shutdown revoke write must fail");
        assert_eq!(fabric.members().await.len(), before.len());

        assert!(fabric.inner.accept_loop_task.lock().unwrap().is_none());
        let children = fabric.inner.accept_children.lock().unwrap();
        assert!(children.closing, "accept registry must be closed");
        assert!(
            children.tasks.is_empty(),
            "accept children must be collected"
        );
    }

    #[tokio::test]
    async fn merge_commit_gate_rejects_late_fact_before_roster_write() {
        // [R8-1] 主门已置位时，merge 必须在取得名册锁前拒绝；无新增事实、无持久化。
        let dir = tempfile::TempDir::new().unwrap();
        let fabric = Fabric::create_root(cfg(&dir)).await.unwrap();
        let fabric_id = fabric.inner.roster.lock().await.fabric_id();
        let endpoint_id = fabric.inner.identity.endpoint_id();
        let late_fact = crate::protocol::SignedFact::sign(
            crate::protocol::Fact {
                kind: crate::protocol::FactKind::Join,
                fabric_id,
                issuer: endpoint_id,
                subject: endpoint_id,
                display_name: Some("late".into()),
                issued_at_ms: now_ms(),
                expires_at_ms: None,
                target_fact_id: None,
            },
            fabric.inner.identity.secret_key(),
        )
        .unwrap();
        let before = std::fs::read(crate::roster::roster_file_path(dir.path())).unwrap();
        *fabric.inner.lifecycle_gate.lock().unwrap() = true;

        assert!(fabric.merge_and_emit(vec![late_fact]).await.is_err());
        assert_eq!(fabric.inner.roster.lock().await.len(), 1);
        assert_eq!(
            std::fs::read(crate::roster::roster_file_path(dir.path())).unwrap(),
            before
        );
        fabric.shutdown().await.unwrap();
    }

    // ---- join 前置检查（步骤 1-3 的确定性构造） --------------------------------

    fn issue_token(
        relay: &str,
        addrs: &[&str],
        now_ms: u64,
        ttl_ms: u64,
    ) -> (tempfile::TempDir, String) {
        let dir = tempfile::TempDir::new().unwrap();
        let identity = crate::identity::NodeIdentity::load_or_create(dir.path()).unwrap();
        let (mut r, _fid) = crate::roster::Roster::create(&identity, dir.path(), now_ms).unwrap();
        let token = r
            .issue_invite(
                &identity,
                relay.to_owned(),
                addrs.iter().map(|s| s.to_string()).collect(),
                None,
                ttl_ms,
                now_ms,
            )
            .unwrap();
        (dir, token.encode().unwrap())
    }

    fn now_ms_real() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    #[test]
    fn precheck_rejects_expired_token_with_fixed_past_time() {
        // 固定过去时间构造：now=0, ttl=1000 → expires_at_ms=1000 << 真实 now
        let (_dir, token) = issue_token("https://relay.example", &[], 0, 1000);
        let err = precheck_join_token(&token).unwrap_err();
        assert!(
            matches!(
                err,
                FabricError::Join {
                    code: JoinErrorCode::TokenExpired,
                    ..
                }
            ),
            "{err:?}"
        );
    }

    #[test]
    fn precheck_rejects_malformed_token() {
        let err = precheck_join_token("dweb1.garbage!!").unwrap_err();
        assert!(
            matches!(
                err,
                FabricError::Join {
                    code: JoinErrorCode::TokenInvalid,
                    ..
                }
            ),
            "{err:?}"
        );
    }

    #[test]
    fn precheck_rejects_bad_addresses() {
        // 令牌地址规范化：relay 非空但不可解析 → TOKEN_INVALID
        let now = now_ms_real();
        let (_dir, token) = issue_token("http://[::bad", &[], now, 60_000);
        let err = precheck_join_token(&token).unwrap_err();
        assert!(
            matches!(err, FabricError::Join { code: JoinErrorCode::TokenInvalid, .. } if err.to_string().contains("relay URL")),
            "{err:?}"
        );
        // 直连地址不可解析 → TOKEN_INVALID
        let (_dir, token) = issue_token("https://relay.example", &["localhost:1234"], now, 60_000);
        let err = precheck_join_token(&token).unwrap_err();
        assert!(
            matches!(err, FabricError::Join { code: JoinErrorCode::TokenInvalid, .. } if err.to_string().contains("direct address")),
            "{err:?}"
        );
        // 好令牌通过
        let (_dir, token) = issue_token("https://relay.example", &["127.0.0.1:1"], now, 60_000);
        assert!(precheck_join_token(&token).is_ok());
    }
}
