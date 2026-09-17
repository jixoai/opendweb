//! @dweb/client-sdk 绑定层：fabric kernel 的 Node API 投影。
//! 生命周期契约：所有异步方法在 shutdown 后返回错误；事件回调在 shutdown 后
//! 不再触发；重复 shutdown 幂等。
//!
//! 错误码约定（connectivity-ux-hardening C0）：napi Error 无自定义 code 通道，
//! 稳定错误以 `[<kebab-code>]` 消息前缀标识（join 8 码 + invite 1 码 + 豁免 3 码
//! + bad-advertise-addr/bad-proxy-url），JS 侧以前缀解析派生 err.code。

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64;
use dweb_fabric::secret::SecretSeed;
use dweb_fabric::{
    Fabric as RustFabric, FabricConfig as RustFabricConfig, FabricEvent, HttpProxyConfig,
    LinkStatus, RelayConfig, RelayStatusSnapshot, RelayTlsTrust, SecretInjection,
};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;
use tokio::sync::Mutex;

type EventCallbacks = Arc<Mutex<Vec<(u64, ThreadsafeFunction<String>)>>>;

/// `relay.relays` 单条条目（server-access-policy task 2.5）：per-relay
/// capability 凭证配置。`serverId` 与 `token` 二选一或全无——
/// - `serverId`：restricted relay 的 ServerId（64 hex；admin 注册 owner 时
///   转交）——root 据此本地自签 own/bootstrap/member capability
///   （`ensureRelayCapabilities` / v2 invite / OK2 附发）；
/// - `token`：现成 `dwebr1.` capability 串（手工/测试用），原样注入本地
///   RelayMap（Authorization: Bearer 头）。
/// 全无 = 无凭证条目（等价旧 `urls` 形态的对应项）。
#[napi(object)]
#[derive(Debug, Clone)]
pub struct RelayEntryOptions {
    /// relay URL（http/https；与 urls 同规构造期校验）
    pub url: String,
    /// restricted relay 的 ServerId（64 hex；None = 非 restricted 条目）
    pub server_id: Option<String>,
    /// 现成 dwebr1. capability 串（None = 无静态凭证）
    pub token: Option<String>,
}

/// relay 配置（判别联合的 napi 投影）：
/// - `{}` / `{ mode: "n0" }`：n0 官方默认（不接受 urls/relays）
/// - `{ mode: "disabled" }`：禁用（不接受 urls/relays）
/// - `{ mode: "custom", urls: [..] }`：自托管列表（至少一个；空数组构造 reject）
/// - `{ mode: "custom", relays: [..] }`：条目级 capability 列表（至少一个；
///   与 urls 互斥——同时提供构造 reject，spec scenario 冻结）
#[napi(object)]
#[derive(Debug, Clone)]
pub struct RelayOptions {
    /// "disabled" | "custom" | "n0"（缺省 "n0"）
    pub mode: Option<String>,
    /// mode = "custom" 时的 relay URL 列表（自托管 docker 或其它 iroh relay）
    pub urls: Option<Vec<String>>,
    /// mode = "custom" 时的 per-relay 条目（url + 可选 serverId/token）；
    /// 与 urls 互斥（双字段同时给出构造 reject）
    pub relays: Option<Vec<RelayEntryOptions>>,
}

/// httpProxy 的 `{ url }` 形态（"none" | "from-env" 为字符串形态）。
#[napi(object)]
#[derive(Debug, Clone)]
pub struct HttpProxyUrl {
    pub url: String,
}

/// Fabric 构造配置
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FabricOptions {
    /// 数据目录（名册持久化位置；secret 默认实现也指向此目录）
    pub data_dir: String,
    pub relay: Option<RelayOptions>,
    /// 写入邀请令牌的 issuer 直连地址（host:port；逐项校验，非法构造 reject）
    pub advertise_addrs: Option<Vec<String>>,
    /// HTTP 控制面（relay 连接）代理所有权；缺省 "none"。
    /// iroh endpoint 不读进程环境变量；QUIC 数据面永不经代理。
    pub http_proxy: Option<Either<String, HttpProxyUrl>>,
    /// join 总时限（毫秒）；缺省 30000；值域 [1000, 600000]，越界构造 reject
    pub join_timeout_ms: Option<f64>,
    /// 本端 QUIC 绑定地址（host:port；e2e 组网需要固定端口对拨时使用）
    pub bind_addr: Option<String>,
}

/// invite 逃生阀选项（D3）。
#[napi(object)]
#[derive(Debug, Clone)]
pub struct InviteOptions {
    /// 允许签发无 relay 令牌；调用方自担可达性责任（带外路径）。
    pub allow_relayless: Option<bool>,
}

/// relay 状态快照（relayStatus() 返回值与 relay-* 事件 payload 同构）。
#[napi(object)]
#[derive(Debug, Clone)]
pub struct RelayStatusJs {
    /// "disabled" | "custom" | "n0"
    pub mode: String,
    /// 配置的 relay URL 列表（disabled 为空数组；n0 恒为官方默认）
    pub urls: Vec<String>,
    /// null <=> mode === "disabled"；否则为任一 relay 已连接
    pub online: Option<bool>,
    /// 最近一次连接错误（脱敏：仅类别 + host，无 URL 凭证段）
    pub last_error: Option<String>,
    /// 配置序最小的已连接 relay URL；offline/disabled 时为 null
    /// （tie-break：同时连上多个 relay 时取配置序最小者，内核既有语义）
    pub active_url: Option<String>,
}

impl From<RelayStatusSnapshot> for RelayStatusJs {
    fn from(s: RelayStatusSnapshot) -> Self {
        Self {
            mode: s.mode.to_owned(),
            urls: s.urls,
            online: s.online,
            last_error: s.last_error,
            active_url: s.active_url,
        }
    }
}

/// 成员信息
#[napi(object)]
pub struct Member {
    pub endpoint_id: String,
    pub display_name: Option<String>,
    pub since_ms: f64,
}

/// ensureRelayCapabilities 的返回条目（root 自签/透传的 per-relay 凭证）。
#[napi(object)]
#[derive(Debug, Clone)]
pub struct RelayCapabilityJs {
    /// relay URL（配置原样形态）
    pub url: String,
    /// `dwebr1.` capability 串
    pub token: String,
}

/// serverId hex64 → 32B（构造期校验：restricted 条目的 ServerId 形态错
/// 误会让 root 自签链静默失配，fail-fast 拒绝构造）。
fn parse_server_id(hex64: &str, url: &str) -> Result<[u8; 32]> {
    let mut buf = [0u8; 32];
    hex::decode_to_slice(hex64, &mut buf).map_err(|_| {
        Error::new(
            Status::GenericFailure,
            format!(
                "relay.relays entry '{url}': serverId must be 64 hex characters (ServerId), \
                 got {} character{}",
                hex64.len(),
                if hex64.len() == 1 { "" } else { "s" }
            ),
        )
    })?;
    Ok(buf)
}

/// relays 条目 → RelayEntry（token 原样透传；serverId hex64 解码）。
fn to_relay_entries(relays: Vec<RelayEntryOptions>) -> Result<Vec<dweb_fabric::RelayEntry>> {
    relays
        .into_iter()
        .map(|e| {
            let server_id = match &e.server_id {
                Some(h) => Some(parse_server_id(h, &e.url)?),
                None => None,
            };
            Ok(dweb_fabric::RelayEntry {
                url: e.url,
                server_id,
                token: e.token,
            })
        })
        .collect()
}

fn to_relay_config(relay: Option<RelayOptions>) -> Result<RelayConfig> {
    let bad = |msg: String| Err(Error::new(Status::GenericFailure, msg));
    match relay {
        None => Ok(RelayConfig::N0Default),
        Some(r) => {
            let has_urls = r.urls.as_ref().is_some_and(|u| !u.is_empty());
            let urls_empty_array = r.urls.as_ref().is_some_and(|u| u.is_empty());
            let has_relays = r.relays.as_ref().is_some_and(|v| !v.is_empty());
            let relays_empty_array = r.relays.as_ref().is_some_and(|v| v.is_empty());
            match r.mode.as_deref().unwrap_or("n0") {
                "n0" | "" => {
                    if has_urls || urls_empty_array {
                        bad("relay.urls is only valid with mode 'custom'".into())
                    } else if has_relays || relays_empty_array {
                        bad("relay.relays is only valid with mode 'custom'".into())
                    } else {
                        Ok(RelayConfig::N0Default)
                    }
                }
                "disabled" => {
                    if has_urls || urls_empty_array {
                        bad("relay.urls is not accepted with mode 'disabled'".into())
                    } else if has_relays || relays_empty_array {
                        bad("relay.relays is not accepted with mode 'disabled'".into())
                    } else {
                        Ok(RelayConfig::Disabled)
                    }
                }
                "custom" => {
                    // spec scenario 冻结：双字段同时给出显式报错（不静默合并）
                    if (has_urls || urls_empty_array) && (has_relays || relays_empty_array) {
                        return bad(
                            "relay.urls and relay.relays are mutually exclusive: provide \
                             exactly one of them"
                                .into(),
                        );
                    }
                    match r.relays {
                        Some(relays) if !relays.is_empty() => Ok(RelayConfig::CustomWithCaps(
                            to_relay_entries(relays)?,
                        )),
                        Some(_) => bad(
                            "relay mode 'custom' requires at least one relay entry".into(),
                        ),
                        None => match r.urls {
                            Some(urls) if !urls.is_empty() => Ok(RelayConfig::Custom(urls)),
                            _ => bad("relay mode 'custom' requires at least one relay URL".into()),
                        },
                    }
                }
                other => bad(format!(
                    "invalid relay mode '{other}' (expected disabled | custom | n0)"
                )),
            }
        }
    }
}

/// httpProxy 判别解析：字符串 "none" | "from-env"，或对象 { url }。
fn to_http_proxy_config(v: Option<Either<String, HttpProxyUrl>>) -> Result<HttpProxyConfig> {
    match v {
        None => Ok(HttpProxyConfig::None),
        Some(Either::A(s)) => match s.as_str() {
            "none" => Ok(HttpProxyConfig::None),
            "from-env" => Ok(HttpProxyConfig::FromEnv),
            other => Err(Error::new(
                Status::GenericFailure,
                format!("invalid httpProxy '{other}' (expected 'none' | 'from-env' | {{ url }})"),
            )),
        },
        Some(Either::B(obj)) => {
            if obj.url.trim().is_empty() {
                return Err(Error::new(
                    Status::GenericFailure,
                    "[bad-proxy-url] proxy url must not be empty",
                ));
            }
            // URL 语法校验由内核构造期执行（FabricConfig::validate），
            // 失败经 fabric_err 以 [bad-proxy-url] 前缀透出。
            Ok(HttpProxyConfig::Url(obj.url))
        }
    }
}

fn to_join_timeout_ms(v: Option<f64>) -> Result<u64> {
    match v {
        None => Ok(dweb_fabric::JOIN_TIMEOUT_MS_DEFAULT),
        Some(ms) => {
            if ms.fract() != 0.0 || ms < 0.0 {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("joinTimeoutMs must be an integer number of milliseconds, got {ms}"),
                ));
            }
            let ms = ms as u64;
            if !(dweb_fabric::JOIN_TIMEOUT_MS_MIN..=dweb_fabric::JOIN_TIMEOUT_MS_MAX).contains(&ms)
            {
                return Err(Error::new(
                    Status::GenericFailure,
                    format!("joinTimeoutMs {ms} out of range [1000, 600000]"),
                ));
            }
            Ok(ms)
        }
    }
}

/// 原子 take 配置构造：无 check-then-act 竞态；返回留存副本供失败归还。
fn take_options(
    opts: &FabricOptions,
    secret: Option<&SecretSeedHandle>,
) -> Result<(RustFabricConfig, Option<SecretSeed>)> {
    let base = || -> Result<RustFabricConfig> {
        Ok(RustFabricConfig {
            data_dir: opts.data_dir.clone().into(),
            relay: to_relay_config(opts.relay.clone())?,
            advertise_addrs: opts.advertise_addrs.clone().unwrap_or_default(),
            secret: SecretInjection::Default,
            http_proxy: to_http_proxy_config(opts.http_proxy.clone())?,
            join_timeout_ms: to_join_timeout_ms(opts.join_timeout_ms)?,
            bind_addr: opts.bind_addr.clone(),
            relay_tls_trust: RelayTlsTrust::PlatformRoot,
        })
    };
    // P1-2：先完整解析/校验配置，再 take 句柄——校验失败不消费 seed，
    // 调用方可修正配置后重试同一句柄。
    let mut cfg = base()?;
    match secret {
        None => Ok((cfg, None)),
        Some(handle) => {
            let seed = handle.take()?;
            cfg.secret = SecretInjection::Seed(seed.clone());
            Ok((cfg, Some(seed)))
        }
    }
}

pub(crate) fn link_status_str(s: LinkStatus) -> &'static str {
    match s {
        LinkStatus::Direct => "direct",
        LinkStatus::Relay => "relay",
        LinkStatus::Unknown => "unknown",
    }
}

/// 稳定错误码前缀映射（error-matrix 冻结集合）。
pub(crate) fn fabric_err(e: dweb_fabric::FabricError) -> Error {
    use dweb_fabric::FabricError as E;
    let prefixed = |p: &str| Error::new(Status::GenericFailure, format!("[{p}] {e}"));
    match &e {
        E::InviteWithoutRelay => prefixed("invite-without-relay"),
        E::Join { code, .. } => prefixed(code.kebab()),
        E::Roster(dweb_fabric::roster::RosterError::DirFabricMismatch { .. }) => {
            prefixed("wrong-fabric")
        }
        E::MissingIdentity(_) => prefixed("missing-identity"),
        E::Roster(dweb_fabric::roster::RosterError::Corrupted { .. }) => prefixed("corrupted"),
        E::Roster(dweb_fabric::roster::RosterError::Persistence { .. }) => prefixed("roster-io"),
        E::BadAdvertiseAddr { .. } => prefixed("bad-advertise-addr"),
        E::BadProxyUrl(_) => prefixed("bad-proxy-url"),
        _ => Error::new(Status::GenericFailure, format!("{e}")),
    }
}

/// 受保护的身份种子句柄：内部持有 [`SecretSeed`]（zeroize-on-drop），
/// 被 Fabric 构造消费（take）后即失效。用于"导入 token / 产品托管解密后"
/// 向 Fabric 注入身份而不经手明文 JS 字符串。内部 Arc：句柄可 clone 进
/// 配置对象，take 语义全局共享（一次消费）。
#[napi]
pub struct SecretSeedHandle {
    seed: std::sync::Arc<std::sync::Mutex<Option<SecretSeed>>>,
}

impl Clone for SecretSeedHandle {
    fn clone(&self) -> Self {
        Self {
            seed: self.seed.clone(),
        }
    }
}

#[napi]
impl SecretSeedHandle {
    /// 派生 EndpointId（z32 展示串；不暴露种子本体）。
    #[napi(getter)]
    pub fn endpoint_id(&self) -> Result<String> {
        let g = self.seed.lock().unwrap();
        match g.as_ref() {
            Some(s) => Ok(dweb_fabric::identity::endpoint_id_display(&s.endpoint_id())),
            None => Err(Error::new(
                Status::GenericFailure,
                "seed handle already consumed",
            )),
        }
    }

    /// 是否仍持有种子（未被消费）。
    #[napi(getter)]
    pub fn available(&self) -> bool {
        self.seed.lock().unwrap().is_some()
    }

    fn take(&self) -> Result<SecretSeed> {
        self.seed
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| Error::new(Status::GenericFailure, "seed handle already consumed"))
    }

    /// 构造失败时归还种子：句柄可重试（调用方不必重新导入 token）。
    fn put_back(&self, seed: SecretSeed) {
        let mut g = self.seed.lock().unwrap();
        // 只在仍未被他人填充时归还（后到者不覆盖）
        if g.is_none() {
            *g = Some(seed);
        }
    }
}

/// 导入 `dwebkey1.` 身份导出串：口令派生解密，返回受保护的种子句柄。
/// （不落盘；注入 Fabric 用工厂的 secret 参数。Argon2 在阻塞线程池执行。）
#[napi]
pub async fn import_secret(token: String, passphrase: String) -> Result<SecretSeedHandle> {
    let seed = tokio::task::spawn_blocking(move || {
        dweb_fabric::secret::import_secret(&token, &passphrase)
    })
    .await
    .map_err(|e| Error::new(Status::GenericFailure, format!("join: {e}")))?
    .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
    Ok(SecretSeedHandle {
        seed: Arc::new(std::sync::Mutex::new(Some(seed))),
    })
}

/// dweb fabric：应用级组网的 Node SDK 入口。
/// 工厂：Fabric.createRoot / Fabric.open / Fabric.attach；完成后调用 shutdown 释放资源。
#[napi]
pub struct Fabric {
    inner: RustFabric,
    event_callbacks: EventCallbacks,
    /// 事件泵任务句柄（P1-8：shutdown 时 abort+join，防永久阻塞在 recv；
    /// R4 Arc 化——drain 后台任务需要所有权）
    pump_handle: Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
    next_callback_id: Arc<std::sync::atomic::AtomicU64>,
    /// shutdown 已开始（事件泵的快速退出标志；R3 改名区分完成门）
    shutdown_flag: Arc<std::sync::atomic::AtomicBool>,
    /// R3 P1-1 共享完成门：首个 Some 由首次 shutdown 写入（订阅完成通知），
    /// 晚到调用克隆 Receiver 等待 drain（含事件泵 abort）完成后返回
    shutdown_gate: std::sync::Mutex<Option<tokio::sync::watch::Receiver<bool>>>,
    /// R3 P1-1 完成通知：drain 全部结束后 send(true)
    shutdown_completed: tokio::sync::watch::Sender<bool>,
}

#[napi]
impl Fabric {
    /// 创建新 fabric（本节点成为 root，可签发邀请与撤销）。
    #[napi(factory)]
    pub async fn create_root(
        opts: FabricOptions,
        secret: Option<&SecretSeedHandle>,
    ) -> Result<Fabric> {
        let (cfg, seed) = take_options(&opts, secret)?;
        Self::build_with_handle(RustFabric::create_root(cfg).await, secret, seed)
    }

    /// 打开已有 fabric（数据目录已含名册）。
    #[napi(factory)]
    pub async fn open(opts: FabricOptions, secret: Option<&SecretSeedHandle>) -> Result<Fabric> {
        let (cfg, seed) = take_options(&opts, secret)?;
        Self::build_with_handle(RustFabric::open(cfg).await, secret, seed)
    }

    /// 以加入者身份起步（空名册；随后调用 join 兑换邀请）。
    #[napi(factory)]
    pub async fn attach(
        opts: FabricOptions,
        fabric_id_hex: String,
        secret: Option<&SecretSeedHandle>,
    ) -> Result<Fabric> {
        let (cfg, seed) = take_options(&opts, secret)?;
        Self::build_with_handle(RustFabric::attach(cfg, &fabric_id_hex).await, secret, seed)
    }

    /// 一步加入：从令牌解析 fabric_id，attach + 兑换 + 持久化名册。
    /// 令牌前置检查（解码/过期/地址规范化）先于本地数据面加载与身份句柄消费
    ///（D11 冻结顺序：令牌自身错误优先于目录检查）。
    /// task 2.5：按串前缀分派前置检查——dweb2. 走 v2 precheck（附录 A 全部
    /// 校验含 capability 一致性），v1 路径零变化；后续 join 由内核按同前缀
    /// 分派（OK2 兑换 + member capability 持久化）。
    #[napi(factory)]
    pub async fn join_with_token(
        opts: FabricOptions,
        token: String,
        secret: Option<&SecretSeedHandle>,
    ) -> Result<Fabric> {
        let fabric_id = if token.starts_with(dweb_fabric::protocol::TOKEN2_PREFIX) {
            let decoded = dweb_fabric::precheck_join_token_v2(&token).map_err(fabric_err)?;
            hex::encode(decoded.invite.fabric_id.as_bytes())
        } else {
            let decoded = dweb_fabric::precheck_join_token(&token).map_err(fabric_err)?;
            hex::encode(decoded.invite.fabric_id.as_bytes())
        };
        let (cfg, seed) = take_options(&opts, secret)?;
        let fabric = match RustFabric::attach(cfg, &fabric_id).await {
            Ok(f) => f,
            Err(e) => {
                if let (Some(h), Some(s)) = (secret, seed) {
                    h.put_back(s);
                }
                return Err(fabric_err(e));
            }
        };
        match fabric.join(&token).await {
            Ok(()) => Self::build_with_handle(Ok(fabric), secret, seed),
            Err(e) => {
                // 失败也必须释放 endpoint/accept loop/watcher（P1-2：局部丢弃
                // 不会停掉 Arc<FabricInner> 持有的任务）
                let _ = fabric.shutdown().await;
                if let (Some(h), Some(s)) = (secret, seed) {
                    h.put_back(s);
                }
                Err(fabric_err(e))
            }
        }
    }

    fn build(fabric: std::result::Result<RustFabric, dweb_fabric::FabricError>) -> Result<Fabric> {
        let inner = fabric.map_err(fabric_err)?;
        let fabric = Fabric {
            inner,
            event_callbacks: Arc::new(Mutex::new(Vec::new())),
            pump_handle: Arc::new(std::sync::Mutex::new(None)),
            next_callback_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            shutdown_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            shutdown_gate: std::sync::Mutex::new(None),
            shutdown_completed: tokio::sync::watch::channel(false).0,
        };
        let pump = spawn_event_pump(&fabric);
        *fabric.pump_handle.lock().unwrap() = Some(pump);
        Ok(fabric)
    }

    /// build + 失败归还：句柄注入的种子在构造失败时放回句柄，调用方可重试。
    fn build_with_handle(
        fabric: std::result::Result<RustFabric, dweb_fabric::FabricError>,
        handle: Option<&SecretSeedHandle>,
        seed: Option<SecretSeed>,
    ) -> Result<Fabric> {
        match Self::build(fabric) {
            Ok(f) => Ok(f),
            Err(e) => {
                if let (Some(h), Some(s)) = (handle, seed) {
                    h.put_back(s);
                }
                Err(e)
            }
        }
    }

    /// 本节点 EndpointId（z-base-32，52 字符）
    #[napi(getter)]
    pub fn endpoint_id(&self) -> String {
        self.inner.endpoint_id()
    }

    /// fabric id（hex）
    #[napi]
    pub async fn fabric_id_hex(&self) -> String {
        self.inner.fabric_id_hex().await
    }

    /// 当前有效成员投影
    #[napi]
    pub async fn members(&self) -> Result<Vec<Member>> {
        let members = self.inner.members().await;
        Ok(members
            .into_iter()
            .map(|m| Member {
                endpoint_id: m.endpoint_id,
                display_name: m.display_name,
                since_ms: m.since_ms as f64,
            })
            .collect())
    }

    /// 查询 EndpointId 是否为有效成员
    #[napi]
    pub async fn is_member(&self, endpoint_id: String) -> Result<bool> {
        self.inner.is_member(&endpoint_id).await.map_err(fabric_err)
    }

    /// 签发邀请令牌（root-only）。返回 dweb1. 前缀的自包含字符串。
    /// 第三参 opts 透传签发安全门逃生阀：relay 为空且 advertiseAddrs 为空时，
    /// 无 opts 或 allowRelayless !== true => reject（[invite-without-relay]）。
    #[napi]
    pub async fn invite(
        &self,
        ttl_ms: f64,
        recipient: Option<String>,
        opts: Option<InviteOptions>,
    ) -> Result<String> {
        let rust_opts = dweb_fabric::InviteOptions {
            allow_relayless: opts
                .as_ref()
                .and_then(|o| o.allow_relayless)
                .unwrap_or(false),
        };
        self.inner
            .invite_with(ttl_ms.max(0.0) as u64, recipient.as_deref(), rust_opts)
            .await
            .map_err(fabric_err)
    }

    /// 兑换邀请令牌加入 fabric（issuer-online 单次兑换）。
    #[napi]
    pub async fn join(&self, token: String) -> Result<()> {
        self.inner.join(&token).await.map_err(fabric_err)
    }

    /// root 自签 per-relay own capability（server-access-policy task 2.3/2.5）。
    /// 对 relay.relays 中带 serverId 的条目以 root 身份现签（caps 全位、
    /// TTL 180d 上限内）注入本地 RelayMap；静态 token 条目原样注入。
    /// 返回 (url, token) 列表供调用方转交/审计。非 root 调用报名册
    /// root-only 错误（"operation requires root …"，原生变体无前缀）。
    #[napi]
    pub async fn ensure_relay_capabilities(&self) -> Result<Vec<RelayCapabilityJs>> {
        let caps = self
            .inner
            .ensure_relay_capabilities()
            .await
            .map_err(fabric_err)?;
        Ok(caps
            .into_iter()
            .map(|(url, token)| RelayCapabilityJs { url, token })
            .collect())
    }

    /// 连接成员（常规通道；双向门控 + 名册同步）。幂等（活跃连接直接成功）。
    #[napi]
    pub async fn connect(&self, endpoint_id: String) -> Result<()> {
        self.inner.connect(&endpoint_id).await.map_err(fabric_err)
    }

    /// 断开与某成员的会话
    #[napi]
    pub async fn disconnect(&self, endpoint_id: String) -> Result<()> {
        self.inner
            .disconnect(&endpoint_id)
            .await
            .map_err(fabric_err)
    }

    /// 发送不透明二进制 envelope
    #[napi]
    pub async fn send(&self, endpoint_id: String, data: Buffer) -> Result<()> {
        self.inner
            .send(&endpoint_id, data.as_ref().to_vec())
            .await
            .map_err(fabric_err)
    }

    /// 撤销成员（root-only）；投影收紧并断开既有会话。
    #[napi]
    pub async fn revoke(&self, endpoint_id: String) -> Result<()> {
        self.inner.revoke(&endpoint_id).await.map_err(fabric_err)
    }

    /// 设置本节点显示名
    #[napi]
    pub async fn set_display_name(&self, name: String) -> Result<()> {
        self.inner.set_display_name(&name).await.map_err(fabric_err)
    }

    /// 查询与某成员的当前路径类型："direct" | "relay" | "unknown"
    #[napi]
    pub async fn link_status(&self, endpoint_id: String) -> Result<String> {
        let status = self
            .inner
            .link_status(&endpoint_id)
            .await
            .map_err(fabric_err)?;
        Ok(link_status_str(status).to_owned())
    }

    /// relay 状态快照（零等待，读内核缓存）。快照优先于事件：初始事实一律先查
    /// 本方法，事件只承载后续跳变。禁用模式 online 为 null（而非 false）。
    #[napi]
    pub fn relay_status(&self) -> RelayStatusJs {
        self.inner.relay_status().into()
    }

    /// 显式导出身份（identity export，不含 roster）为 `dwebkey1.` 加密串。
    /// 交由产品自行安全保存（如账号系统加密托管——密文上云、口令在用户）。
    #[napi]
    pub async fn export_secret_passphrase(&self, passphrase: String) -> Result<String> {
        let identity = self.inner.identity().clone();
        tokio::task::spawn_blocking(move || {
            dweb_fabric::secret::export_secret(&identity, &passphrase)
        })
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("join: {e}")))?
        .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))
    }

    /// 注册事件回调（可多次调用，多个回调都会收到全部事件）。
    /// 返回句柄 id；off(id) 注销（index.js 包装为取消订阅函数）。
    #[napi]
    pub fn on(&self, callback: ThreadsafeFunction<String>) -> u32 {
        let id = self
            .next_callback_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst) as u32;
        let callbacks = self.event_callbacks.clone();
        callbacks.blocking_lock().push((id as u64, callback));
        id
    }

    /// continuity：与对端建立逻辑会话（design §3.3 唯一创建入口）。
    /// 返回 SessionHandle——内建 auto-resume 驱动（断线续传对 JS 透明）。
    #[napi]
    pub async fn open_session(&self, peer_id: String) -> Result<crate::session::SessionHandle> {
        let session = dweb_fabric::continuity::session::open_session(
            &self.inner,
            &peer_id,
            dweb_fabric::continuity::session::SessionOptions::default(),
        )
        .await
        .map_err(crate::session::session_err)?;
        Ok(crate::session::SessionHandle::new(session, self.inner.clone()))
    }

    /// continuity：对端连接状态快照（design §3.1；Phase 1 task 2.3 补课投影）。
    /// snapshot 优先于事件；epoch/stateSeq 为 bigint。
    #[napi]
    pub async fn continuity_snapshot(
        &self,
        peer_id: String,
    ) -> Result<crate::session::ConnectionStateSnapshotJs> {
        let s = self
            .inner
            .continuity_snapshot(&peer_id)
            .await
            .map_err(crate::session::session_err)?;
        Ok(s.into())
    }

    /// continuity：注入连接死亡（故障注入面——驱动恢复语义验证；非生产用途）。
    #[napi]
    pub async fn continuity_reset(&self, peer_id: String) -> Result<()> {
        self.inner
            .continuity_reset(&peer_id)
            .await
            .map_err(crate::session::session_err)
    }

    /// 添加对端直连地址提示（e2e 组网：固定端口对拨）。
    #[napi]
    pub async fn add_known_addr(&self, endpoint_id: String, addr: String) -> Result<()> {
        self.inner
            .add_known_addr(&endpoint_id, addr)
            .await
            .map_err(fabric_err)
    }

    /// serveHttp：provider 侧 HTTP 引擎（design §3.4）。
    /// handler 为 TSFN JSON 事件回调（native 桥形态）；§3.4 规范签名
    /// （HttpHandler 类型面）见 /http 子路径胶水。
    #[napi]
    pub async fn serve_http(
        &self,
        peer_id: String,
        handler: ThreadsafeFunction<String>,
    ) -> Result<crate::http::HttpServerJs> {
        Ok(crate::http::HttpServerJs::start(
            self.inner.clone(),
            peer_id,
            handler,
        ))
    }

    /// 注销事件回调（on 返回的 id）。
    #[napi]
    pub fn off(&self, id: u32) {
        let callbacks = self.event_callbacks.clone();
        let mut guard = callbacks.blocking_lock();
        if let Some(pos) = guard.iter().position(|(cid, _)| *cid == id as u64) {
            guard.remove(pos);
        }
    }

    /// 优雅关闭：断开全部会话并释放网络资源。幂等。
    /// R3 P1-1：共享完成门——只有首次调用执行 drain（内核 shutdown + 事件泵
    /// abort）；并发晚到调用等待同一完成通知后返回（返回即"无后续事件"）。
    #[napi]
    pub async fn shutdown(&self) -> Result<()> {
        let waiter = {
            let mut gate = self.shutdown_gate.lock().unwrap();
            match gate.as_ref() {
                Some(rx) => Some(rx.clone()),
                None => {
                    *gate = Some(self.shutdown_completed.subscribe());
                    None
                }
            }
        };
        if let Some(mut rx) = waiter {
            // 完成通知已发出的竞态：先查当前值，未完成再等变更
            if !*rx.borrow_and_update() {
                let _ = rx.changed().await;
            }
            return Ok(());
        }
        self.shutdown_flag
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // R4 P1-1：drain 任务化——首调用 Future 取消只是不再等 JoinHandle，
        // drain（内核 shutdown + 事件泵 abort）不受中断；send_replace 落值，
        // 顺序晚到调用即见 true。JoinHandle await cancel-safe。
        let inner = self.inner.clone();
        let pump_handle = self.pump_handle.clone();
        let completed = self.shutdown_completed.clone();
        let drain = tokio::spawn(async move {
            let res = inner.shutdown().await.map_err(fabric_err);
            // P1-8：endpoint 关闭后广播 sender 仍可能存活——abort 事件泵
            // 防止其永久阻塞在 recv（无新事件时不醒来检查标志）
            let pump = { pump_handle.lock().unwrap().take() };
            if let Some(pump) = pump {
                pump.abort();
                let _ = pump.await;
            }
            // 无论内核结果如何都放行晚到等待者（错误也已 drain 完毕）
            completed.send_replace(true);
            res
        });
        drain.await.unwrap_or_else(|e| {
            Err(Error::new(
                napi::bindgen_prelude::Status::GenericFailure,
                format!("shutdown drain task failed: {e}"),
            ))
        })
    }
}

/// 事件泵：把 broadcast 接收循环桥接到已注册的 TSFN 回调。
/// relay-* 事件必携带快照同构 payload（非可选字段）。
fn spawn_event_pump(fabric: &Fabric) -> tokio::task::JoinHandle<()> {
    let mut rx = fabric.inner.subscribe();
    let callbacks = fabric.event_callbacks.clone();
    let shutdown = fabric.shutdown_flag.clone();
    tokio::spawn(async move {
        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    continue; // 消费滞后：跳过丢失批次，继续投递后续事件
                }
                Err(_) => break, // sender dropped（fabric 释放）
            };
            if shutdown.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            // R3 P1-2：relay-* payload 一律取**事件携带的快照副本**（跳变后
            // 状态）——不事后读共享可变快照（连续跳变时会拿到错配状态）
            let relay_payload_of = |snap: &RelayStatusSnapshot| {
                serde_json::json!({
                    "mode": snap.mode,
                    "urls": snap.urls,
                    "online": snap.online,
                    "lastError": snap.last_error,
                    "activeUrl": snap.active_url,
                })
            };
            let payload = match &ev {
                FabricEvent::PeerConnected { endpoint_id } => {
                    let mut o = serde_json::Map::new();
                    o.insert("type".into(), "peer-connected".into());
                    o.insert("endpointId".into(), endpoint_id.as_str().into());
                    serde_json::Value::Object(o)
                }
                FabricEvent::PeerDisconnected { endpoint_id } => {
                    let mut o = serde_json::Map::new();
                    o.insert("type".into(), "peer-disconnected".into());
                    o.insert("endpointId".into(), endpoint_id.as_str().into());
                    serde_json::Value::Object(o)
                }
                FabricEvent::RosterUpdated => serde_json::json!({ "type": "roster-updated" }),
                FabricEvent::Message { from, data } => serde_json::json!({
                    "type": "message",
                    "from": from,
                    "dataBase64": BASE64.encode(data),
                }),
                FabricEvent::PathChanged {
                    endpoint_id,
                    status,
                } => serde_json::json!({
                    "type": "path-changed",
                    "endpointId": endpoint_id,
                    "status": link_status_str(*status),
                }),
                FabricEvent::RelayOnline { snapshot } => {
                    let mut o = serde_json::Map::new();
                    o.insert("type".into(), "relay-online".into());
                    o.insert("relay".into(), relay_payload_of(snapshot));
                    serde_json::Value::Object(o)
                }
                FabricEvent::RelayOffline { snapshot } => {
                    let mut o = serde_json::Map::new();
                    o.insert("type".into(), "relay-offline".into());
                    o.insert("relay".into(), relay_payload_of(snapshot));
                    serde_json::Value::Object(o)
                }
            };
            let Ok(payload) = serde_json::to_string(&payload) else {
                continue;
            };
            for (_id, cb) in callbacks.lock().await.iter() {
                cb.call(Ok(payload.clone()), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    })
}

/// SDK 原生层版本
#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
