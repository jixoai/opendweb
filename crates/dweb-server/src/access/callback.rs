//! CallbackProvider：`policy=callback` 的 L2 webhook 决策器（task 1.5b，
//! 需求来源 2026-09-17；design §8.5 全部协议冻结项 + spec「动态策略回调」
//! requirement 的全部 Scenario）。
//!
//! 分层前提（R3 P0-B1）：L1 密码学 + L1b 票有效性底线在 AccessGate 恒定
//! 前置——无效票据（缺 RELAY 位/未注册 owner/L1 任一失败）到不了本模块，
//! webhook 无法豁免或升级它们。本模块只做两件事：
//! - `relay.connect` 准入决策（可缓存；无票端点同样交 webhook = A_cb(S)）
//! - `relay.disconnect` best-effort 观察通知（不缓存、不重试、允许丢失、
//!   每 connection 至多一次、不可作为配额或撤销依据）
//!
//! 协议卫生冻结项 → 实现位置：
//! - fail-closed 恒定：非 200 / 3xx（不跟随重定向）/ 超时（≤2000ms 硬上限）
//!   / 响应解析失败 / 缺 `allow` 或非布尔 / body 超限 → `dweb/policy-unavailable`
//!   （webhook 交互侧失败同样入缓存，防失联风暴；纯本地负载侧拒绝
//!   ——队列满/并发等待超时——不入缓存，瞬时条件不毒化后续准入）
//! - 并发防护：per-key singleflight（watch channel 共享结果）+ 全局在途上限
//!   （默认 64）+ per-source 在途上限（默认 16，source=endpoint_id，R4 P1-3
//!   冻结：iroh-relay hook 输入无远端地址）+ 有界等待队列（默认 256，队满即拒）
//! - 缓存：键 = (registry_generation, endpoint_id, 113B 定长二进制投影, event)
//!   ——投影原文进键、不做摘要（定长键无碰撞面，BLAKE3 摘要是等价替代）；
//!   deny 也缓存；TTL = min(响应 cache_ttl_s〔省略=配置默认/非法=0〕, 配置
//!   上限 ≤60s)；registry generation 在键内，变更后旧键自然不命中；
//!   `invalidate_all()` 供 reload 清容量。缓存仅作用于新连接准入。
//! - SSRF 解析-校验-连接原子语义（R4 P1-8）：tokio lookup_host 解析全部
//!   A/AAAA → IPv4-mapped 归一化为 IPv4 → 逐个校验（任一非法整体拒绝，
//!   防多地址绕过与 DNS rebinding）→ 用已校验的固定地址直连（Host/SNI
//!   仍用域名，不二次解析、不经系统代理）；不跟随重定向（3xx 按失联）
//! - 传输边界：生产强制 https；`allow_loopback` 显式豁免仅限 loopback
//!   （且 http scheme 只在豁免下允许、豁免下 http 也仅可连 loopback）
//! - reason 语法 `dweb/[a-z0-9][a-z0-9._-]{0,63}`：非法/缺失替换
//!   `dweb/policy-denied`（防日志注入与 deny 帧污染）
//! - callback_token 全程脱敏：tracing 只记 host，不记 token/完整 URL/
//!   Authorization 值
//!
//! HTTP 栈选型：hyper client conn（`http1::handshake`）逐连接握手、不池化
//! ——callback 频率低（2s 超时上界），池化无收益，且固定 IP 直连需要完全
//! 掌握连接建立。hyper/hyper-util/http-body-util 均为 axum 既有树内依赖。

use crate::access::cap::{HASH_INPUT_LEN, RelayCap, hash_input, hash_input_none};
use crate::access::config::CallbackConfig;
use axum::http::{Method, Request, StatusCode, Uri, header};
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

/// 装箱流统一抽象（明文 TcpStream / TLS 流，供 hyper 握手）
trait AsyncStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> AsyncStream for T {}

/// 请求/响应体硬上限（design §8.5 协议冻结）
pub const MAX_BODY_BYTES: usize = 4096;
/// 响应 cache_ttl_s 的协议上限（design §8.5：TTL 上限 60s）
pub const MAX_CACHE_TTL_S: u64 = 60;
/// fail-closed 统一 reason（spec「动态策略回调」requirement 冻结）
pub const UNAVAILABLE_REASON: &str = "dweb/policy-unavailable";
/// webhook deny 未给 reason / reason 非法时的替换值（design §8.5 reason 冻结）
pub const POLICY_DENIED_REASON: &str = "dweb/policy-denied";
/// webhook 事件名（协议冻结）
const EVENT_CONNECT: &str = "relay.connect";
const EVENT_DISCONNECT: &str = "relay.disconnect";
/// leader 任务的外层等待宽限（leader 内部已有 timeout 上界，此处防调度
/// 抖动造成误判 transient）
const LEADER_AWAIT_SLACK: Duration = Duration::from_millis(500);
/// 决策缓存容量粗门（实现复核 R1 P2-3）：键空间可被握手身份无限拉大，
/// 超限整表清空——缓存仅为性能层，清空无正确性影响
const CACHE_MAX_ENTRIES: usize = 10_000;

/// webhook 裁决结果（已 sanitize：reason 恒为合法 `dweb/` slug）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub allow: bool,
    pub reason: String,
    /// 本裁决的缓存 TTL（ms）；0 = 不缓存
    ttl_ms: u64,
    /// 是否来自 webhook 交互（可缓存）；纯本地负载侧拒绝为 false
    cacheable: bool,
}

impl Decision {
    /// 负载侧瞬时拒绝（队列满/并发等待超时）：不可缓存——瞬时条件
    /// 不毒化后续准入（与 webhook 交互侧 fail-closed 的「deny 入缓存」区分）
    fn transient_unavailable() -> Self {
        Self {
            allow: false,
            reason: UNAVAILABLE_REASON.to_string(),
            ttl_ms: 0,
            cacheable: false,
        }
    }

    /// webhook 交互侧失败语义（不可达/非 200/超时/解析失败）：按配置默认
    /// TTL 入缓存（spec：deny 结果同样进入缓存）
    fn webhook_unavailable(default_ttl_ms: u64) -> Self {
        Self {
            allow: false,
            reason: UNAVAILABLE_REASON.to_string(),
            ttl_ms: default_ttl_ms,
            cacheable: true,
        }
    }
}

/// 决策缓存键（design §8.5 R4 P1-4 冻结）：generation 在键内，registry
/// 变更后旧键自然不命中；投影为 113B 定长原文（无票 = 全零 sentinel）。
/// 注（实现复核 R1 P2-5）：spec 键式含 event 字段——当前唯一入缓存的事件
/// 是 relay.connect（disconnect 明确不入缓存），event 省略语义等价；
/// 将来若有新事件入缓存，MUST 先把 event 补进本结构体。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    generation: u64,
    endpoint_id: [u8; 32],
    projection: [u8; HASH_INPUT_LEN],
}

struct Inner {
    /// 请求目标（authority + path_and_query + scheme 重建的 canonical 形态）
    request_uri: Uri,
    scheme_https: bool,
    host: String,
    port: u16,
    token: String,
    timeout: Duration,
    cache_ttl: Duration,
    allow_loopback: bool,
    tls: Option<Arc<rustls::ClientConfig>>,
    /// 决策缓存（deny 也缓存；TTL 到期惰性清理）
    cache: Mutex<HashMap<CacheKey, (Decision, Instant)>>,
    /// singleflight 在途表：leader 持 Sender，joiner 订阅
    inflight: Mutex<HashMap<CacheKey, watch::Sender<Option<Decision>>>>,
    /// 全局在途上限（默认 64）
    global: Arc<Semaphore>,
    /// 有界等待队列（默认 256，队满即拒）
    queue: Arc<Semaphore>,
    /// per-source 在途计数（source = endpoint_id，默认 16）
    sources: Mutex<HashMap<[u8; 32], usize>>,
    per_source: usize,
}

/// CallbackProvider 句柄（廉价克隆，内部共享状态）。
/// Debug 恒脱敏：不含 callback_token 与完整 URL（§8.5）。
#[derive(Clone)]
pub struct CallbackProvider(Arc<Inner>);

impl std::fmt::Debug for CallbackProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallbackProvider")
            .field("host", &self.0.host)
            .field("port", &self.0.port)
            .field("https", &self.0.scheme_https)
            .finish_non_exhaustive()
    }
}

impl CallbackProvider {
    /// 构造 + URL fail-fast 校验（spec：callback 配置缺失或非法时启动
    /// fail-fast；存在性校验在 config.rs task 1.3，此处补 URL 边界）。
    pub fn new(cfg: &CallbackConfig) -> Result<Self, String> {
        // fragment：http::Uri 本就拒绝 '#'，显式报错给出可排障信息
        if cfg.url.contains('#') {
            return Err(format!(
                "invalid DWEB_CALLBACK_URL {:#?}: fragment is not allowed",
                cfg.url
            ));
        }
        // userinfo：http::Uri::host() 会静默剥离（main.rs R2 P0-1 同源教训），
        // 前置拒绝防 token/凭证进公告面
        if cfg.url.contains('@') {
            return Err(format!(
                "invalid DWEB_CALLBACK_URL {:#?}: userinfo is not allowed",
                cfg.url
            ));
        }
        let uri: Uri = cfg
            .url
            .parse()
            .map_err(|e| format!("invalid DWEB_CALLBACK_URL {:#?}: {e}", cfg.url))?;
        let scheme = uri.scheme_str().unwrap_or_default();
        let scheme_https = match scheme {
            "https" => true,
            // 生产强制 https；http 仅 loopback 豁免（开发形态）下允许
            "http" => {
                if !cfg.allow_loopback {
                    return Err(format!(
                        "invalid DWEB_CALLBACK_URL {:#?}: production callbacks must use \
                         https; pass --allow-loopback-callback for local development",
                        cfg.url
                    ));
                }
                false
            }
            other => {
                return Err(format!(
                    "invalid DWEB_CALLBACK_URL {:#?}: scheme must be http or https, got {other:?}",
                    cfg.url
                ));
            }
        };
        let host = uri
            .host()
            .filter(|h| !h.is_empty())
            .ok_or_else(|| format!("invalid DWEB_CALLBACK_URL {:#?}: missing host", cfg.url))?
            .trim_matches(['[', ']'])
            .to_string();
        // 端口判别从 authority 原文（port_u16() 对越界/非数字端口静默 None，
        // 与「未写端口」不可区分——main.rs validate_public_url R2 P1-1 同源）
        let auth = uri.authority().map(|a| a.as_str()).unwrap_or_default();
        let has_port = !auth.ends_with(']') && auth.rsplit_once(':').is_some();
        let port = match uri.port_u16() {
            Some(p) if p > 0 => p,
            Some(_) => {
                return Err(format!(
                    "invalid DWEB_CALLBACK_URL {:#?}: port must be 1-65535",
                    cfg.url
                ));
            }
            None if has_port => {
                return Err(format!(
                    "invalid DWEB_CALLBACK_URL {:#?}: port must be 1-65535",
                    cfg.url
                ));
            }
            None => {
                if scheme_https {
                    443
                } else {
                    80
                }
            }
        };
        // 重建 canonical 请求目标（authority 原样 + path_and_query，缺省 "/")
        let pq = uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "/".to_string());
        let authority = uri
            .authority()
            .map(|a| a.as_str())
            .unwrap_or_default()
            .to_string();
        let request_uri = Uri::builder()
            .scheme(scheme)
            .authority(authority)
            .path_and_query(pq)
            .build()
            .map_err(|e| format!("invalid DWEB_CALLBACK_URL {:#?}: {e}", cfg.url))?;

        let tls = scheme_https.then(build_tls_client_config);
        Ok(Self(Arc::new(Inner {
            request_uri,
            scheme_https,
            host,
            port,
            token: cfg.token.clone(),
            timeout: Duration::from_millis(cfg.timeout_ms),
            cache_ttl: Duration::from_millis(cfg.cache_ttl_ms),
            allow_loopback: cfg.allow_loopback,
            tls,
            cache: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            global: Arc::new(Semaphore::new(cfg.max_concurrency)),
            queue: Arc::new(Semaphore::new(cfg.queue)),
            sources: Mutex::new(HashMap::new()),
            per_source: cfg.per_source,
        })))
    }

    /// `relay.connect` 准入决策（缓存 + singleflight + 并发防护）。
    /// - `cap`：已过 L1+L1b 的有效票（None = 无票，A_cb(S) 语义交 webhook）
    /// - `generation`：本次接入看到的 registry generation（来自快照）
    pub async fn decide(
        &self,
        endpoint_id: &[u8; 32],
        cap: Option<&RelayCap>,
        connection_id: u64,
        generation: u64,
    ) -> Decision {
        let key = CacheKey {
            generation,
            endpoint_id: *endpoint_id,
            projection: cap.map(hash_input).unwrap_or_else(hash_input_none),
        };
        if let Some(hit) = self.cache_get(&key) {
            return hit;
        }
        // singleflight：在途则订阅共享结果；否则成为 leader
        let joiner = {
            let mut inflight = self.0.inflight.lock().unwrap();
            match inflight.get(&key) {
                Some(tx) => Some(tx.subscribe()),
                None => {
                    let (tx, _initial) = watch::channel(None);
                    inflight.insert(key.clone(), tx);
                    None
                }
            }
        };
        if let Some(mut rx) = joiner {
            // 先看当前值（leader 可能已在我们订阅前发布），再等变更；
            // 等待上界 = 超时（leader 自带更紧的上界，此为双保险）
            loop {
                if let Some(d) = rx.borrow_and_update().clone() {
                    return d;
                }
                match tokio::time::timeout(self.0.timeout, rx.changed()).await {
                    Err(_) => return Decision::transient_unavailable(),
                    Ok(Err(_)) => {
                        // leader 未发布即消亡。实现复核 R1 P2-4 自愈：
                        // 顺手摘除在途条目（sender 已无任何 receiver 即安全），
                        // 防 leader panic 路径下条目永驻、同键永久 joiner 化
                        let mut inflight = self.0.inflight.lock().unwrap();
                        if inflight
                            .get(&key)
                            .is_some_and(|tx| tx.receiver_count() == 0)
                        {
                            inflight.remove(&key);
                        }
                        return Decision::transient_unavailable();
                    }
                    Ok(Ok(())) => continue,
                }
            }
        }
        // leader：spawn 独立任务执行（调用者被取消也完成发布，joiner 不悬挂）
        let this = self.clone();
        let endpoint = *endpoint_id;
        let cap = cap.cloned();
        let handle = tokio::spawn(async move {
            let d = this.leader(endpoint, connection_id, cap.as_ref()).await;
            this.finish(&key, &d);
            d
        });
        match tokio::time::timeout(self.0.timeout + LEADER_AWAIT_SLACK, handle).await {
            Ok(Ok(d)) => d,
            _ => Decision::transient_unavailable(),
        }
    }

    /// `relay.disconnect` best-effort 观察通知（fire-and-forget）：受同一
    /// 全局并发上限与**超时上限**约束（try，超限直接丢弃；超时即放弃），
    /// 不重试、不阻塞、不入缓存、每 connection 至多一次（OnDisconnectGuard
    /// 保证每连接恰一次回调）。并发 permit 随任务持有至 HTTP 结束（保证
    /// 在途语义真实生效）。
    /// 实现复核 R1 P1-1：HTTP 调用必须包 timeout——慢/挂起 webhook 无上界
    /// 会无限期持有全局 permit（OS 级 connect ~75s），耗尽并发槽拖垮
    /// callback 模式的准入面（fail-closed 方向的 DoS）。
    pub fn notify_disconnect(&self, endpoint_id: &[u8; 32], connection_id: u64) {
        // 并发超限：直接丢弃（§8.5 冻结）
        let Ok(_concurrency_permit) = self.0.global.clone().try_acquire_owned() else {
            return;
        };
        let this = self.clone();
        let timeout = self.0.timeout;
        let endpoint = *endpoint_id;
        tokio::spawn(async move {
            let body = DisconnectView {
                event: EVENT_DISCONNECT,
                endpoint_id: z32(&endpoint),
                connection_id: connection_id.to_string(),
            };
            let _ = tokio::time::timeout(
                timeout,
                this.webhook_call(&serde_json::to_string(&body).unwrap_or_default()),
            )
            .await;
            // _concurrency_permit 在此 drop（在途计数随任务生命周期）
        });
    }

    /// 清空全部决策缓存（registry reload 时调用清容量；generation 已在键
    /// 内，不调用也不影响正确性——只是释放空间）
    pub fn invalidate_all(&self) {
        self.0.cache.lock().unwrap().clear();
    }

    fn cache_get(&self, key: &CacheKey) -> Option<Decision> {
        let mut cache = self.0.cache.lock().unwrap();
        match cache.get(key) {
            Some((d, expiry)) if Instant::now() < *expiry => Some(d.clone()),
            Some(_) => {
                cache.remove(key);
                None
            }
            None => None,
        }
    }

    /// leader 路径：队列（try）→ 超时包裹（全局并发 await + per-source try +
    /// webhook 全程）。进入 HTTP 交互阶段后超时按 webhook 失联语义缓存。
    async fn leader(
        &self,
        endpoint_id: [u8; 32],
        connection_id: u64,
        cap: Option<&RelayCap>,
    ) -> Decision {
        // 有界等待队列：try 获取（队满即拒，不缓存）
        let Ok(_queue_permit) = self.0.queue.clone().try_acquire_owned() else {
            return Decision::transient_unavailable();
        };
        let default_ttl_ms = self.0.cache_ttl.as_millis() as u64;
        let reached_webhook = std::sync::atomic::AtomicBool::new(false);
        let outcome = tokio::time::timeout(self.0.timeout, async {
            // 全局在途：await（本超时包裹即等待上界）
            let _global: OwnedSemaphorePermit = self
                .0
                .global
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| ())?;
            // per-source 在途：try（超限即拒，不缓存）
            let Some(_source_slot) = self.acquire_source(endpoint_id) else {
                return Err(());
            };
            let body = ConnectView {
                event: EVENT_CONNECT,
                endpoint_id: z32(&endpoint_id),
                capability: cap.map(CapabilityView::new),
                connection_id: connection_id.to_string(),
            };
            let serialized = serde_json::to_string(&body).map_err(|_| ())?;
            reached_webhook.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok::<Decision, ()>(self.webhook_call(&serialized).await)
        })
        .await;
        match outcome {
            Ok(Ok(decision)) => decision,
            // 负载侧拒绝（并发等待/来源超限）：不缓存
            Ok(Err(())) => Decision::transient_unavailable(),
            // 超时：已进入 webhook 交互阶段 → 失联语义缓存；否则纯等待超时不缓存
            Err(_) if reached_webhook.load(std::sync::atomic::Ordering::Relaxed) => {
                Decision::webhook_unavailable(default_ttl_ms)
            }
            Err(_) => Decision::transient_unavailable(),
        }
    }

    /// 发布：singleflight 通知 joiner + 可缓存裁决入缓存
    fn finish(&self, key: &CacheKey, decision: &Decision) {
        if decision.cacheable && decision.ttl_ms > 0 {
            let ttl = Duration::from_millis(decision.ttl_ms);
            let mut cache = self.0.cache.lock().unwrap();
            // 实现复核 R1 P2-3：容量粗门——键空间可被握手身份无限拉大
            //（每条 ~200B），超限整表清空（正确性无损：缓存仅为性能层）
            if cache.len() >= CACHE_MAX_ENTRIES {
                cache.clear();
            }
            cache.insert(key.clone(), (decision.clone(), Instant::now() + ttl));
        }
        let mut inflight = self.0.inflight.lock().unwrap();
        if let Some(tx) = inflight.remove(key) {
            let _ = tx.send(Some(decision.clone()));
        }
    }

    /// per-source 在途槽位（source = endpoint_id）：计数制，离开时递减；
    /// 返回 guard（Drop 递减）。超限返回 None（不缓存语义由调用方处理）。
    fn acquire_source(&self, endpoint_id: [u8; 32]) -> Option<SourceSlot<'_>> {
        let mut sources = self.0.sources.lock().unwrap();
        let count = sources.entry(endpoint_id).or_insert(0);
        if *count >= self.0.per_source {
            return None;
        }
        *count += 1;
        Some(SourceSlot {
            inner: &self.0,
            endpoint_id,
        })
    }

    /// webhook 单次调用：解析-校验-连接原子语义 + 请求/响应协议处理。
    /// 任何失败映射为可缓存的 fail-closed（unavailable）。
    async fn webhook_call(&self, body: &str) -> Decision {
        let default_ttl_ms = self.0.cache_ttl.as_millis() as u64;
        let fail = || Decision::webhook_unavailable(default_ttl_ms);
        if body.len() > MAX_BODY_BYTES {
            return fail(); // 请求侧防御（我们的序列化恒 <4KiB，冻结门）
        }
        let addrs = match self.resolved_addrs().await {
            Ok(a) => a,
            Err(()) => {
                tracing::debug!(
                    host = %self.0.host,
                    "callback webhook rejected by SSRF boundary or resolution failed"
                );
                return fail();
            }
        };
        // 固定已校验地址直连（按序尝试；不再解析、不经系统代理）
        let stream = match connect_first(&addrs).await {
            Ok(s) => s,
            Err(()) => {
                tracing::debug!(host = %self.0.host, "callback webhook connect failed");
                return fail();
            }
        };
        // TLS 仅 https 形态；http（loopback 豁免）为明文直连。装箱统一
        // stream 类型给 hyper 握手（两种流都实现 AsyncRead/Write）
        let stream: Box<dyn AsyncStream> = if self.0.scheme_https {
            match self.tls_wrap(stream).await {
                Ok(s) => Box::new(s),
                Err(()) => {
                    tracing::debug!(host = %self.0.host, "callback webhook tls handshake failed");
                    return fail();
                }
            }
        } else {
            Box::new(stream)
        };
        let (mut sender, conn) = match http1::handshake(TokioIo::new(stream)).await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(host = %self.0.host, error = %e, "callback webhook http handshake failed");
                return fail();
            }
        };
        // 连接驱动任务（响应体读取依赖它）
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let req = Request::builder()
            .method(Method::POST)
            .uri(self.0.request_uri.clone())
            .header(header::AUTHORIZATION, format!("Bearer {}", self.0.token))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::copy_from_slice(body.as_bytes())));
        let req = match req {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(host = %self.0.host, error = %e, "callback webhook request build failed");
                return fail();
            }
        };
        let res = match sender.send_request(req).await {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(host = %self.0.host, error = %e, "callback webhook send failed");
                return fail();
            }
        };
        // 非 200 一律失联（3xx 不跟随：防 token 跨 origin 泄露）
        if res.status() != StatusCode::OK {
            tracing::debug!(
                host = %self.0.host,
                status = res.status().as_u16(),
                "callback webhook non-200 response"
            );
            return fail();
        }
        // 响应体 ≤4KiB（逐帧累计，超限即弃）
        let mut buf: Vec<u8> = Vec::new();
        let mut resp_body = res.into_body();
        loop {
            match resp_body.frame().await {
                None => break,
                Some(Err(_)) => return fail(),
                Some(Ok(frame)) => {
                    let Ok(data) = frame.into_data() else {
                        return fail();
                    };
                    if buf.len() + data.len() > MAX_BODY_BYTES {
                        return fail();
                    }
                    buf.extend_from_slice(&data);
                }
            }
        }
        let value: serde_json::Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(_) => return fail(),
        };
        // allow 必填且必须布尔（缺省/非布尔 → 失联）
        let Some(allow) = value.get("allow").and_then(|v| v.as_bool()) else {
            return fail();
        };
        if allow {
            return Decision {
                allow: true,
                reason: String::new(),
                ttl_ms: response_ttl_ms(value.get("cache_ttl_s"), default_ttl_ms),
                cacheable: true,
            };
        }
        Decision {
            allow: false,
            reason: sanitize_reason(value.get("reason").and_then(|r| r.as_str())),
            ttl_ms: response_ttl_ms(value.get("cache_ttl_s"), default_ttl_ms),
            cacheable: true,
        }
    }

    /// SSRF 解析-校验：全部 A/AAAA → IPv4-mapped 归一化 → 逐个校验
    /// （任一非法整体拒绝）。返回已校验地址列表（直连用）。
    async fn resolved_addrs(&self) -> Result<Vec<SocketAddr>, ()> {
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((self.0.host.as_str(), self.0.port))
            .await
            .map_err(|_| ())?
            .collect();
        if addrs.is_empty() {
            return Err(());
        }
        let mut validated = Vec::with_capacity(addrs.len());
        for addr in addrs {
            let ip = normalize_v4_mapped(addr.ip());
            if !self.0.addr_allowed(&ip) {
                return Err(());
            }
            validated.push(SocketAddr::new(ip, addr.port()));
        }
        Ok(validated)
    }

    async fn tls_wrap(
        &self,
        stream: TcpStream,
    ) -> Result<tokio_rustls::client::TlsStream<TcpStream>, ()> {
        let config = self.0.tls.as_ref().ok_or(())?;
        let name = rustls::pki_types::ServerName::try_from(self.0.host.clone()).map_err(|_| ())?;
        let connector = tokio_rustls::TlsConnector::from(Arc::clone(config));
        connector.connect(name, stream).await.map_err(|_| ())
    }
}

impl Inner {
    /// 地址白名单（design §8.5 传输边界）：
    /// - https：loopback 仅豁免时允许；拒绝 unspecified/私网（RFC1918/ULA）/
    ///   link-local（含云 metadata 169.254.169.254）/组播/广播/共享地址段
    /// - http（仅豁免下可达构造）：只允许 loopback（开发形态）
    fn addr_allowed(&self, ip: &IpAddr) -> bool {
        if !self.scheme_https {
            return self.allow_loopback && ip.is_loopback();
        }
        if ip.is_loopback() {
            return self.allow_loopback;
        }
        if ip.is_unspecified() || ip.is_multicast() {
            return false;
        }
        match ip {
            IpAddr::V4(v4) => {
                !(v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || is_shared_cgnat(v4)
                    || v4.is_documentation())
            }
            IpAddr::V6(v6) => !(is_ula(v6) || is_v6_link_local(v6)),
        }
    }
}

/// per-source 槽位守卫：Drop 递减计数并在归零时移除条目
struct SourceSlot<'a> {
    inner: &'a Inner,
    endpoint_id: [u8; 32],
}
impl Drop for SourceSlot<'_> {
    fn drop(&mut self) {
        let mut sources = self.inner.sources.lock().unwrap();
        if let Some(count) = sources.get_mut(&self.endpoint_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                sources.remove(&self.endpoint_id);
            }
        }
    }
}

/// 解析后按序直连第一个成功的地址（全部已过 SSRF 校验）
async fn connect_first(addrs: &[SocketAddr]) -> Result<TcpStream, ()> {
    let mut last = None;
    for addr in addrs {
        match TcpStream::connect(addr).await {
            Ok(s) => return Ok(s),
            Err(e) => last = Some(e),
        }
    }
    match last {
        Some(_) => Err(()),
        None => Err(()),
    }
}

/// IPv4-mapped IPv6（::ffff:a.b.c.d）归一化为 IPv4 再套用 IPv4 规则
/// （design §8.5 R4 P1-8：防地址族绕过）
fn normalize_v4_mapped(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

/// ULA（fc00::/7，RFC 4193）
fn is_ula(v6: &std::net::Ipv6Addr) -> bool {
    v6.segments()[0] & 0xfe00 == 0xfc00
}

/// IPv6 link-local（fe80::/10）
fn is_v6_link_local(v6: &std::net::Ipv6Addr) -> bool {
    (v6.segments()[0] & 0xffc0) == 0xfe80
}

/// CGNAT 共享地址段（100.64.0.0/10，RFC 6598；std 的 is_shared 未稳定）
fn is_shared_cgnat(v4: &std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    o[0] == 100 && (o[1] & 0xc0) == 0x40
}

/// z-base-32 展示（payload 冻结编码；与 iroh_base::PublicKey::to_z32 同一
/// 编码——alphabet/位序冻结为 z-base-32 规范，本地实现以免 PublicKey 的
/// 曲线点校验把任意 32B endpoint_id 误判为非法：endpoint_id 只是身份字节，
/// 不要求是本实现处的合法公钥位形）
fn z32(bytes: &[u8; 32]) -> String {
    /// z-base-32 alphabet（philzimmermann.com 规范；与 iroh_base 一致）
    const ALPHABET: &[u8; 32] = b"ybndrfg8ejkmcpqxot1uwisza345h769";
    let mut out = String::with_capacity(52);
    let mut bit_buffer: u32 = 0;
    let mut bit_count: u32 = 0;
    for &byte in bytes {
        bit_buffer = (bit_buffer << 8) | u32::from(byte);
        bit_count += 8;
        while bit_count >= 5 {
            bit_count -= 5;
            let idx = ((bit_buffer >> bit_count) & 0x1f) as usize;
            out.push(ALPHABET[idx] as char);
        }
    }
    if bit_count > 0 {
        // 末段低位零填充（data_encoding 同语义）
        let idx = ((bit_buffer << (5 - bit_count)) & 0x1f) as usize;
        out.push(ALPHABET[idx] as char);
    }
    out
}

/// reason 语法冻结（design §8.5）：`dweb/[a-z0-9][a-z0-9._-]{0,63}`；
/// 缺失/非法一律替换 `dweb/policy-denied`
fn sanitize_reason(raw: Option<&str>) -> String {
    const FALLBACK: &str = POLICY_DENIED_REASON;
    match raw {
        Some(r) if is_valid_reason(r) => r.to_string(),
        _ => FALLBACK.to_string(),
    }
}

fn is_valid_reason(s: &str) -> bool {
    let Some(slug) = s.strip_prefix("dweb/") else {
        return false;
    };
    let b = slug.as_bytes();
    // 空 slug / 超长（1+63=64 上界）直接拒绝；非 ASCII 字节全部落在外
    //（多字节字符 ≥0x80 不在白名单）
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    let first_ok = b[0].is_ascii_lowercase() || b[0].is_ascii_digit();
    let rest_ok = b[1..]
        .iter()
        .all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'));
    first_ok && rest_ok
}

/// cache_ttl_s 语义（design §8.5 R4 P1-4）：省略 = 配置默认；非整数/负数/
/// 浮点/超 60 一律按 0（不缓存）。最终 TTL = min(响应值, 配置上限)。
fn response_ttl_ms(raw: Option<&serde_json::Value>, default_ttl_ms: u64) -> u64 {
    let response_ms = match raw {
        None => default_ttl_ms,
        Some(v) => match v.as_u64() {
            Some(secs) if secs <= MAX_CACHE_TTL_S => secs * 1000,
            _ => 0, // 非法（浮点/负/字符串/超 60）= 不缓存
        },
    };
    response_ms.min(default_ttl_ms)
}

/// webhook 请求体（relay.connect；design §8.5 冻结字段）
#[derive(Serialize)]
struct ConnectView {
    event: &'static str,
    endpoint_id: String,
    capability: Option<CapabilityView>,
    connection_id: String,
}

/// 有效票结构化投影（不含令牌原文/签名）
#[derive(Serialize)]
struct CapabilityView {
    fabric_id: String,
    issuer: String,
    caps: Vec<&'static str>,
    issued_at_ms: u64,
    expires_at_ms: u64,
}

impl CapabilityView {
    fn new(cap: &RelayCap) -> Self {
        Self {
            fabric_id: hex::encode(cap.fabric_id),
            issuer: z32(&cap.issuer),
            caps: cap_names(cap.caps),
            issued_at_ms: cap.issued_at,
            expires_at_ms: cap.expires_at,
        }
    }
}

/// webhook 请求体（relay.disconnect：不携带 capability/context，R4 P1-5 冻结）
#[derive(Serialize)]
struct DisconnectView {
    event: &'static str,
    endpoint_id: String,
    connection_id: String,
}

/// caps 位图 → 名称数组（wire 冻结：relay / rdz-announce / rdz-resolve）
fn cap_names(caps: u8) -> Vec<&'static str> {
    use crate::access::cap::{CAP_RDZ_ANNOUNCE, CAP_RDZ_RESOLVE, CAP_RELAY};
    let mut names = Vec::new();
    if caps & CAP_RELAY != 0 {
        names.push("relay");
    }
    if caps & CAP_RDZ_ANNOUNCE != 0 {
        names.push("rdz-announce");
    }
    if caps & CAP_RDZ_RESOLVE != 0 {
        names.push("rdz-resolve");
    }
    names
}

/// https 用 rustls 客户端配置：ring provider（iroh tls-ring 同源，显式指定
/// 避免依赖进程级默认 provider 安装状态）+ Mozilla 根
fn build_tls_client_config() -> Arc<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring provider supports default tls versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::cap::{self, CAP_RELAY};
    use axum::Router;
    use axum::extract::{Request, State};
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use ed25519_dalek::SigningKey;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const NOW: u64 = 1_800_000_000_000;
    const TTL: u64 = 3_600_000;

    fn cb_config(url: String) -> CallbackConfig {
        CallbackConfig {
            url,
            token: "test-token".to_string(),
            timeout_ms: 400,
            cache_ttl_ms: 30_000,
            max_concurrency: 64,
            per_source: 16,
            queue: 256,
            allow_loopback: true,
        }
    }

    /// 端点/票 fixture（签发用 seed 与字段值无关语义，只求互异）
    fn sample_cap(caps: u8) -> RelayCap {
        let issuer = SigningKey::from_bytes(&[1u8; 32]);
        let token = cap::sign_and_encode(
            &issuer,
            &[3u8; 32],
            &[2u8; 32],
            &[4u8; 32],
            caps,
            NOW,
            NOW + TTL,
        );
        cap::decode(&token).unwrap()
    }

    /// mock webhook 形态
    #[derive(Clone)]
    enum Mock {
        /// (status, raw body)
        Respond(axum::http::StatusCode, String),
        /// 延迟后 200 + body（singleflight/超时/并发用）
        Delayed(Duration, String),
        /// 5KiB JSON body（超限用）
        Oversize,
    }

    #[derive(Clone, Debug)]
    struct Recorded {
        authorization: Option<String>,
        body: serde_json::Value,
    }

    #[derive(Clone)]
    struct MockState {
        behavior: Mock,
        count: Arc<AtomicUsize>,
        seen: Arc<Mutex<Vec<Recorded>>>,
    }

    async fn hook(State(state): State<MockState>, req: Request) -> Response {
        state.count.fetch_add(1, Ordering::SeqCst);
        let authorization = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
            .await
            .unwrap_or_default();
        let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        state.seen.lock().unwrap().push(Recorded {
            authorization,
            body,
        });
        match state.behavior.clone() {
            Mock::Respond(status, body) => {
                (status, [("content-type", "application/json")], body).into_response()
            }
            Mock::Delayed(delay, body) => {
                tokio::time::sleep(delay).await;
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "application/json")],
                    body,
                )
                    .into_response()
            }
            Mock::Oversize => {
                let pad = "x".repeat(5000);
                let body = format!(r#"{{"allow":true,"pad":"{pad}"}}"#);
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "application/json")],
                    body,
                )
                    .into_response()
            }
        }
    }

    /// 起一个 loopback mock webhook（测试内 spawn，测试结束随 runtime 回收）
    async fn spawn_mock(behavior: Mock) -> (String, Arc<AtomicUsize>, Arc<Mutex<Vec<Recorded>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = MockState {
            behavior,
            count: Arc::new(AtomicUsize::new(0)),
            seen: Arc::new(Mutex::new(Vec::new())),
        };
        let app = Router::new()
            .route("/hook", post(hook))
            .with_state(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (
            format!("http://127.0.0.1:{port}/hook"),
            state.count,
            state.seen,
        )
    }

    fn z32_of(ep: &[u8; 32]) -> String {
        z32(ep)
    }

    /// 等 mock 收到第 n 个请求（fire-and-forget 的 disconnect 断言用）
    async fn wait_count(count: &AtomicUsize, n: usize) {
        for _ in 0..100 {
            if count.load(Ordering::SeqCst) >= n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("webhook did not receive {n} requests in time");
    }

    #[tokio::test]
    async fn allow_true_cached_and_request_shape_frozen() {
        let (url, count, seen) = spawn_mock(Mock::Respond(
            axum::http::StatusCode::OK,
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let ep = [0xAB; 32];
        // 无票（capability: null）+ connection_id
        let d = provider.decide(&ep, None, 42, 7).await;
        assert!(d.allow);
        // 缓存命中：同键二次接入零回调（spec Scenario「webhook 允许即接入」）
        let d2 = provider.decide(&ep, None, 43, 7).await;
        assert!(d2.allow);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        // 请求形状冻结：Bearer token / event / endpoint_id(z32) / capability
        // null / connection_id（字符串）
        let rec = seen.lock().unwrap()[0].clone();
        assert_eq!(rec.authorization.as_deref(), Some("Bearer test-token"));
        assert_eq!(rec.body["event"], "relay.connect");
        assert_eq!(rec.body["endpoint_id"], z32_of(&ep));
        assert!(rec.body["capability"].is_null());
        assert_eq!(rec.body["connection_id"], "42");
    }

    #[tokio::test]
    async fn capability_projection_in_payload() {
        let (url, count, seen) = spawn_mock(Mock::Respond(
            axum::http::StatusCode::OK,
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let cap = sample_cap(CAP_RELAY);
        let d = provider.decide(&cap.recipient, Some(&cap), 1, 1).await;
        assert!(d.allow);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let rec = seen.lock().unwrap()[0].clone();
        let c = &rec.body["capability"];
        assert_eq!(c["fabric_id"], "03".repeat(32));
        assert_eq!(c["issuer"], z32_of(&cap.issuer));
        assert_eq!(c["caps"], serde_json::json!(["relay"]));
        assert_eq!(c["issued_at_ms"], NOW);
        assert_eq!(c["expires_at_ms"], NOW + TTL);
    }

    #[tokio::test]
    async fn deny_custom_reason_transparent_and_cached() {
        let (url, count, _seen) = spawn_mock(Mock::Respond(
            axum::http::StatusCode::OK,
            r#"{"allow":false,"reason":"dweb/quota-exceeded"}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let ep = [1u8; 32];
        let d = provider.decide(&ep, None, 1, 1).await;
        assert!(!d.allow);
        assert_eq!(d.reason, "dweb/quota-exceeded");
        // deny 同样入缓存：第二次零回调
        let d2 = provider.decide(&ep, None, 2, 1).await;
        assert!(!d2.allow);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalid_reasons_replaced_with_policy_denied() {
        let ep = [2u8; 32];
        let bad: Vec<String> = vec![
            "no-slash".to_string(),             // 非 dweb/ 前缀
            "dweb/".to_string(),                // 空 slug
            "dweb/A".to_string(),               // 大写
            "dweb/a b".to_string(),             // 空白
            "dweb/a\nb".to_string(),            // 控制字符
            "dweb/-leading".to_string(),        // 首字符非 [a-z0-9]
            format!("dweb/{}", "a".repeat(65)), // 超长
            "dweb/a\u{4e2d}".to_string(),       // 非 ASCII
        ];
        for (i, reason) in bad.iter().enumerate() {
            let (url_i, _c, _s) = spawn_mock(Mock::Respond(
                axum::http::StatusCode::OK,
                format!(
                    r#"{{"allow":false,"reason":{}}}"#,
                    serde_json::json!(reason)
                ),
            ))
            .await;
            let provider = CallbackProvider::new(&cb_config(url_i)).unwrap();
            let d = provider.decide(&ep, None, i as u64, 100 + i as u64).await;
            assert!(!d.allow, "case {reason:?}");
            assert_eq!(d.reason, POLICY_DENIED_REASON, "case {reason:?}");
        }
        // deny 未带 reason → 同样替换
        let (url2, _c2, _s2) = spawn_mock(Mock::Respond(
            axum::http::StatusCode::OK,
            r#"{"allow":false}"#.into(),
        ))
        .await;
        let provider2 = CallbackProvider::new(&cb_config(url2)).unwrap();
        let d = provider2.decide(&ep, None, 1, 1).await;
        assert_eq!(d.reason, POLICY_DENIED_REASON);
    }

    #[tokio::test]
    async fn fail_closed_non_200_redirect_and_cached() {
        // 500 → 失联；且 deny(unavailable) 入缓存（第二次零请求）
        let (url, count, _seen) = spawn_mock(Mock::Respond(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let ep = [3u8; 32];
        let d = provider.decide(&ep, None, 1, 1).await;
        assert!(!d.allow);
        assert_eq!(d.reason, UNAVAILABLE_REASON);
        let d2 = provider.decide(&ep, None, 2, 1).await;
        assert!(!d2.allow);
        assert_eq!(count.load(Ordering::SeqCst), 1, "失联 deny 入缓存");

        // 302 重定向 → 失联且不跟随（token 不发往其它 origin）
        let (url3, count3, _s) =
            spawn_mock(Mock::Respond(axum::http::StatusCode::FOUND, String::new())).await;
        // Location 头：Mock::Respond 不带 —— 直接用 302 空 body 断言不跟随即可
        let provider3 = CallbackProvider::new(&cb_config(url3)).unwrap();
        let d3 = provider3.decide(&ep, None, 1, 1).await;
        assert!(!d3.allow);
        assert_eq!(d3.reason, UNAVAILABLE_REASON);
        assert_eq!(count3.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn timeout_fail_closed_and_cached() {
        // webhook 慢于 timeout（400ms 配置 vs 800ms 响应）→ 失联 + 缓存
        let (url, count, _seen) = spawn_mock(Mock::Delayed(
            Duration::from_millis(800),
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let ep = [4u8; 32];
        let d = provider.decide(&ep, None, 1, 1).await;
        assert!(!d.allow);
        assert_eq!(d.reason, UNAVAILABLE_REASON);
        let d2 = provider.decide(&ep, None, 2, 1).await;
        assert!(!d2.allow);
        assert_eq!(count.load(Ordering::SeqCst), 1, "超时 deny 入缓存");
    }

    #[tokio::test]
    async fn malformed_responses_fail_closed() {
        let ep = [5u8; 32];
        for (i, body) in [
            "{}",                 // 缺 allow
            r#"{"allow":"yes"}"#, // 非布尔
            "not json",           // 非 JSON
        ]
        .iter()
        .enumerate()
        {
            let (url, _c, _s) =
                spawn_mock(Mock::Respond(axum::http::StatusCode::OK, body.to_string())).await;
            let provider = CallbackProvider::new(&cb_config(url)).unwrap();
            let d = provider.decide(&ep, None, 1, 100 + i as u64).await;
            assert!(!d.allow, "case {body}");
            assert_eq!(d.reason, UNAVAILABLE_REASON, "case {body}");
        }
    }

    #[tokio::test]
    async fn oversize_body_fail_closed() {
        let (url, _count, _seen) = spawn_mock(Mock::Oversize).await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let d = provider.decide(&[6u8; 32], None, 1, 1).await;
        assert!(!d.allow);
        assert_eq!(d.reason, UNAVAILABLE_REASON);
    }

    #[tokio::test]
    async fn cache_ttl_semantics_matrix() {
        // 省略 → 配置默认 30s：缓存命中
        // 0 / 61 / 浮点 → 非法=0：不缓存
        // 合法 30 → min(30s, 配置 30s)：缓存
        let cases: &[(&str, bool)] = &[
            (r#"{"allow":true}"#, true),                     // 省略 → 默认 → 缓存
            (r#"{"allow":true,"cache_ttl_s":0}"#, false),    // 0 → 不缓存
            (r#"{"allow":true,"cache_ttl_s":61}"#, false),   // 超 60 → 不缓存
            (r#"{"allow":true,"cache_ttl_s":30.5}"#, false), // 浮点 → 不缓存
            (r#"{"allow":true,"cache_ttl_s":30}"#, true),    // 合法 → 缓存
        ];
        for (body, expect_cached) in cases {
            let (url, count, _s) =
                spawn_mock(Mock::Respond(axum::http::StatusCode::OK, body.to_string())).await;
            let provider = CallbackProvider::new(&cb_config(url)).unwrap();
            let ep = [7u8; 32];
            let d1 = provider.decide(&ep, None, 1, 1).await;
            assert!(d1.allow, "case {body}");
            let _d2 = provider.decide(&ep, None, 2, 1).await;
            let hits = count.load(Ordering::SeqCst);
            assert_eq!(
                hits,
                if *expect_cached { 1 } else { 2 },
                "case {body}: cache_ttl 语义"
            );
        }
        // 未知字段忽略（不拒绝）
        let (url, _c, _s) = spawn_mock(Mock::Respond(
            axum::http::StatusCode::OK,
            r#"{"allow":true,"future_field":"x"}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        assert!(provider.decide(&[8u8; 32], None, 1, 1).await.allow);
    }

    #[tokio::test]
    async fn generation_change_misses_cache() {
        let (url, count, _seen) = spawn_mock(Mock::Respond(
            axum::http::StatusCode::OK,
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let ep = [9u8; 32];
        assert!(provider.decide(&ep, None, 1, 1).await.allow);
        assert!(provider.decide(&ep, None, 2, 1).await.allow); // 缓存
        // registry 变更：generation+1 → 旧键不命中，产生新回调
        assert!(provider.decide(&ep, None, 3, 2).await.allow);
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn singleflight_collapses_same_key_misses() {
        let (url, count, _seen) = spawn_mock(Mock::Delayed(
            Duration::from_millis(300),
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let ep = [0x0A; 32];
        let mut handles = Vec::new();
        for i in 0..10 {
            let p = provider.clone();
            handles.push(tokio::spawn(async move { p.decide(&ep, None, i, 1).await }));
        }
        for h in handles {
            assert!(h.await.unwrap().allow);
        }
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "同键并发 miss 只发一次回调（singleflight）"
        );
    }

    #[tokio::test]
    async fn queue_exhaustion_denies_without_cache() {
        // queue=1 / max_concurrency=1：leader 持队列槽在 HTTP 中，第二请求队满即拒
        let (url, count, _seen) = spawn_mock(Mock::Delayed(
            Duration::from_millis(300),
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let mut cfg = cb_config(url);
        cfg.queue = 1;
        cfg.max_concurrency = 1;
        let provider = CallbackProvider::new(&cfg).unwrap();
        let ep1 = [0x0B; 32];
        let ep2 = [0x0C; 32];
        let p1 = provider.clone();
        let p2 = provider.clone();
        let (a, b) = tokio::join!(
            async move { p1.decide(&ep1, None, 1, 1).await },
            async move { p2.decide(&ep2, None, 1, 1).await },
        );
        let decisions = [a, b];
        assert!(decisions.iter().any(|d| d.allow));
        let denied = decisions.iter().find(|d| !d.allow).expect("一放一拒");
        assert_eq!(denied.reason, UNAVAILABLE_REASON);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn per_source_limit_denies_second_key_of_same_endpoint() {
        // per_source=1：同 endpoint 两个不同键（有票/无票投影不同）并发，
        // 第二个来源超限即拒
        let (url, count, _seen) = spawn_mock(Mock::Delayed(
            Duration::from_millis(300),
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let mut cfg = cb_config(url);
        cfg.per_source = 1;
        cfg.max_concurrency = 8;
        cfg.queue = 8;
        let provider = CallbackProvider::new(&cfg).unwrap();
        let cap = sample_cap(CAP_RELAY);
        let ep = cap.recipient;
        let p1 = provider.clone();
        let p2 = provider.clone();
        let (a, b) = tokio::join!(
            async move { p1.decide(&ep, None, 1, 1).await },
            async move { p2.decide(&ep, Some(&cap), 1, 1).await },
        );
        let decisions = [a, b];
        assert!(decisions.iter().any(|d| d.allow));
        let denied = decisions.iter().find(|d| !d.allow).expect("一放一拒");
        assert_eq!(denied.reason, UNAVAILABLE_REASON);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn ssrf_address_policy_matrix() {
        // https 生产形态（未豁免）：私网/link-local/metadata/loopback 全拒
        let mut strict_cfg = cb_config("https://hooks.example.com".into());
        strict_cfg.allow_loopback = false;
        let strict = CallbackProvider::new(&strict_cfg).unwrap();
        assert!(!strict.0.addr_allowed(&"10.0.0.1".parse().unwrap()));
        assert!(!strict.0.addr_allowed(&"172.16.0.1".parse().unwrap()));
        assert!(!strict.0.addr_allowed(&"192.168.1.1".parse().unwrap()));
        assert!(
            !strict.0.addr_allowed(&"169.254.169.254".parse().unwrap()),
            "云 metadata"
        );
        assert!(
            !strict.0.addr_allowed(&"127.0.0.1".parse().unwrap()),
            "loopback 未豁免"
        );
        assert!(!strict.0.addr_allowed(&"0.0.0.0".parse().unwrap()));
        assert!(!strict.0.addr_allowed(&"::1".parse().unwrap()));
        assert!(
            !strict.0.addr_allowed(&"fe80::1".parse().unwrap()),
            "v6 link-local"
        );
        assert!(!strict.0.addr_allowed(&"fc00::1".parse().unwrap()), "ULA");
        assert!(strict.0.addr_allowed(&"8.8.8.8".parse().unwrap()));
        assert!(
            strict
                .0
                .addr_allowed(&"2001:4860:4860::8888".parse().unwrap())
        );
        // IPv4-mapped 归一化：::ffff:10.0.0.1 套用 IPv4 规则被拒
        assert!(
            !strict
                .0
                .addr_allowed(&normalize_v4_mapped("::ffff:10.0.0.1".parse().unwrap()))
        );

        // https + 豁免：loopback 放行、私网仍拒
        let exempt = CallbackProvider::new(&cb_config("https://127.0.0.1:9443".into())).unwrap();
        assert!(exempt.0.addr_allowed(&"127.0.0.1".parse().unwrap()));
        assert!(exempt.0.addr_allowed(&"::1".parse().unwrap()));
        assert!(!exempt.0.addr_allowed(&"10.0.0.1".parse().unwrap()));

        // http（仅豁免下构造成功）：只允许 loopback（开发形态）
        let dev = CallbackProvider::new(&cb_config("http://localhost:9999".into())).unwrap();
        assert!(dev.0.addr_allowed(&"127.0.0.1".parse().unwrap()));
        assert!(!dev.0.addr_allowed(&"8.8.8.8".parse().unwrap()));
    }

    #[tokio::test]
    async fn ssrf_connection_to_closed_loopback_port_fail_closed() {
        // url 指向 127.0.0.1:1（豁免下合法构造）：连接拒绝 → 失联 + 缓存
        let provider = CallbackProvider::new(&cb_config("http://127.0.0.1:1/hook".into())).unwrap();
        let ep = [0x0D; 32];
        let d = provider.decide(&ep, None, 1, 1).await;
        assert!(!d.allow);
        assert_eq!(d.reason, UNAVAILABLE_REASON);
        let d2 = provider.decide(&ep, None, 2, 1).await;
        assert!(!d2.allow);
    }

    #[test]
    fn url_validation_fail_fast() {
        // 非 http(s)
        assert!(CallbackProvider::new(&cb_config("ftp://hook.example.com".into())).is_err());
        // http 未豁免（生产强制 https）
        let mut cfg = cb_config("http://hook.example.com".into());
        cfg.allow_loopback = false;
        assert!(CallbackProvider::new(&cfg).is_err());
        // userinfo / fragment / 坏端口 / 空 host / 非 URL
        assert!(CallbackProvider::new(&cb_config("https://user:pass@ex.com".into())).is_err());
        assert!(CallbackProvider::new(&cb_config("https://ex.com/#f".into())).is_err());
        assert!(CallbackProvider::new(&cb_config("https://ex.com:0".into())).is_err());
        assert!(CallbackProvider::new(&cb_config("https://ex.com:99999".into())).is_err());
        assert!(CallbackProvider::new(&cb_config("https://".into())).is_err());
        assert!(CallbackProvider::new(&cb_config("not a url".into())).is_err());
        // 合法形态：https 任意 host；http + 豁免（含端口与 path）
        assert!(CallbackProvider::new(&cb_config("https://hooks.example.com".into())).is_ok());
        assert!(
            CallbackProvider::new(&cb_config("https://hooks.example.com:8443/cb?k=1".into()))
                .is_ok()
        );
        assert!(CallbackProvider::new(&cb_config("http://127.0.0.1:9999/cb".into())).is_ok());
    }

    #[tokio::test]
    async fn disconnect_notify_is_best_effort_without_capability() {
        let (url, count, seen) =
            spawn_mock(Mock::Respond(axum::http::StatusCode::OK, String::new())).await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let ep = [0x0E; 32];
        provider.notify_disconnect(&ep, 4242);
        wait_count(&count, 1).await;
        let rec = seen.lock().unwrap()[0].clone();
        assert_eq!(rec.body["event"], "relay.disconnect");
        assert_eq!(rec.body["endpoint_id"], z32_of(&ep));
        assert_eq!(rec.body["connection_id"], "4242");
        assert!(
            rec.body.get("capability").is_none(),
            "disconnect payload 不携带 capability（R4 P1-5 冻结）"
        );
        assert_eq!(
            rec.authorization.as_deref(),
            Some("Bearer test-token"),
            "disconnect 同样带 Bearer"
        );
    }

    /// 实现复核 R1 P1-1 回归：disconnect 的 webhook 调用必须受 timeout
    /// 上界——慢 webhook 不允许无限期持有全局并发 permit（会耗尽槽位把
    /// callback 准入面拖入 fail-closed DoS）。
    #[tokio::test]
    async fn disconnect_notify_timeout_releases_concurrency_permit() {
        let (url, _count, _seen) = spawn_mock(Mock::Delayed(
            std::time::Duration::from_secs(10),
            String::new(),
        ))
        .await;
        let mut cfg = cb_config(url);
        cfg.timeout_ms = 200;
        let provider = CallbackProvider::new(&cfg).unwrap();
        let ep = [0x2A; 32];
        provider.notify_disconnect(&ep, 7);
        // 等 timeout + 余量：permit 应已释放（无 timeout 包裹时会被 10s
        // 的 mock 挂住，此时 try_acquire 失败）
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        assert!(
            provider.0.global.clone().try_acquire_owned().is_ok(),
            "disconnect permit 必须在 timeout 内释放"
        );
    }

    #[tokio::test]
    async fn invalidate_all_clears_cache() {
        let (url, count, _seen) = spawn_mock(Mock::Respond(
            axum::http::StatusCode::OK,
            r#"{"allow":true}"#.into(),
        ))
        .await;
        let provider = CallbackProvider::new(&cb_config(url)).unwrap();
        let ep = [0x0F; 32];
        assert!(provider.decide(&ep, None, 1, 1).await.allow);
        // invalidate_all：即使 generation 不变也强制重回调（reload 清容量）
        provider.invalidate_all();
        assert!(provider.decide(&ep, None, 2, 1).await.allow);
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn reason_syntax_validation() {
        for ok in ["dweb/a", "dweb/a1", "dweb/a.b-c_d", "dweb/1a"] {
            assert!(is_valid_reason(ok), "{ok}");
        }
        let max = format!("dweb/{}", "a".repeat(64));
        assert!(is_valid_reason(&max), "slug 1+63=64 是上界");
        let over = format!("dweb/{}", "a".repeat(65));
        assert!(!is_valid_reason(&over));
        for bad in [
            "",
            "dweb/",
            "web/a",
            "dweb/A",
            "dweb/-",
            "dweb/a b",
            "dweb/a\tb",
            "dweb/../escape",
            "dweb/a\u{7f}",
        ] {
            assert!(!is_valid_reason(bad), "{bad:?}");
        }
    }

    #[test]
    fn normalize_v4_mapped_only_maps_mapped() {
        let mapped: IpAddr = "::ffff:192.168.1.1".parse().unwrap();
        assert_eq!(
            normalize_v4_mapped(mapped),
            IpAddr::V4("192.168.1.1".parse().unwrap())
        );
        let native: IpAddr = "2001:db8::1".parse().unwrap();
        assert_eq!(normalize_v4_mapped(native), native);
        let v4: IpAddr = "8.8.8.8".parse().unwrap();
        assert_eq!(normalize_v4_mapped(v4), v4);
    }

    /// z-base-32 本地实现与 iroh_base 编码逐字节一致（wire 兼容冻结）
    #[test]
    fn z32_matches_iroh_base_encoding() {
        let sk = iroh_base::SecretKey::from_bytes(&[7u8; 32]);
        assert_eq!(z32(sk.public().as_bytes()), sk.public().to_z32());
        let sk2 = iroh_base::SecretKey::generate();
        assert_eq!(z32(sk2.public().as_bytes()), sk2.public().to_z32());
        // 非法曲线点位形的 32B 也能编码（endpoint_id 只是身份字节）
        assert_eq!(z32(&[0xAB; 32]).len(), 52);
        assert!(
            z32(&[0xAB; 32])
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        );
    }
}
