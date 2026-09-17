//! dweb 自托管服务端：gateway（rendezvous + healthz + services.json）+ iroh relay 桥接。
//! gateway 命名（design D1）：`--gateway` / `DWEB_GATEWAY_BIND` 为 canonical，
//! 优先级 flag > env > default。
//! 公网 URL 覆盖（public-exposure D1/D2）：`--public-gateway` / `--public-relay`
//! 与 `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL` 声明反代/隧道后的
//! 公网入口，services.json 按条目跳过 Host 派生（厂商中立的反代适配层）。
//! 访问控制（server-access-policy Phase 1）：`--access-mode` / `--data-dir` /
//! `--owners-file` / `--allow-loopback-callback` 与 `owners` 子命令；restricted
//! 模式构造 AccessGate 装入 relay on_connect 验证链与 rendezvous 静态 ACL
//! （tasks 1.5/1.5b/1.6 接线），registry mtime 轮询热重载，
//! DWEB_RELAY_CLIENT_RX 限流透传（task 1.7），services.json 发布 server_id
//! （task 1.8）。Phase 3 第一棒（tasks 3.1/3.2 前半）：DWEB_ADMIN_TOKEN
//! 存在时挂 /admin/* 管理面（owners CRUD + 回执签名 + status）；
//! DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER per-owner 连接配额。

mod access;
mod relay;
mod rendezvous;
mod services;

use anyhow::{Context, Result};
use std::net::SocketAddr;
use std::num::NonZeroU32;

/// CLI 覆盖项（flag > env > default）
#[derive(Default)]
struct Cli {
    gateway: Option<String>,
    relay: Option<String>,
    relay_enabled: Option<bool>,
    public_gateway: Option<String>,
    public_relay: Option<String>,
    access_mode: Option<String>,
    data_dir: Option<String>,
    owners_file: Option<String>,
    allow_loopback_callback: Option<bool>,
}

fn parse_cli(args: impl Iterator<Item = String>) -> Result<Cli, String> {
    let mut cli = Cli::default();
    let mut it = args;
    while let Some(arg) = it.next() {
        // `--opt value` 与 `--opt=value` 双形式等价（D8 语义同样适用于二进制入口）
        let (name, inline_value) = match arg.split_once('=') {
            Some((n, v)) => (n.to_owned(), Some(v.to_owned())),
            None => (arg.clone(), None),
        };
        let value_opts = [
            "--gateway",
            "--relay",
            "--public-gateway",
            "--public-relay",
            "--access-mode",
            "--data-dir",
            "--owners-file",
        ];
        if value_opts.contains(&name.as_str()) {
            let value = match inline_value {
                Some(v) => v,
                None => it
                    .next()
                    .ok_or_else(|| format!("missing value for {name}"))?,
            };
            match name.as_str() {
                "--relay" => cli.relay = Some(value),
                "--gateway" => cli.gateway = Some(value),
                "--public-gateway" => cli.public_gateway = Some(value),
                "--public-relay" => cli.public_relay = Some(value),
                "--access-mode" => cli.access_mode = Some(value),
                "--data-dir" => cli.data_dir = Some(value),
                _ => cli.owners_file = Some(value),
            }
            continue;
        }
        match name.as_str() {
            "--no-relay" => cli.relay_enabled = Some(false),
            "--allow-loopback-callback" => cli.allow_loopback_callback = Some(true),
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(cli)
}

const DEFAULT_GATEWAY_BIND: &str = "0.0.0.0:8787";

/// gateway 监听地址解析（纯函数）：--gateway flag > DWEB_GATEWAY_BIND > 默认
fn resolve_gateway_bind(flag: Option<&str>, env_canonical: Option<&str>) -> String {
    flag.or(env_canonical)
        .unwrap_or(DEFAULT_GATEWAY_BIND)
        .to_string()
}

fn gateway_bind(cli: &Cli) -> String {
    resolve_gateway_bind(
        cli.gateway.as_deref(),
        std::env::var("DWEB_GATEWAY_BIND").ok().as_deref(),
    )
}

fn relay_bind(cli: &Cli) -> Result<SocketAddr, String> {
    // 显式给出的 bind 解析失败必须硬错误退出——静默回退默认端口会把
    // 拼写错误变成意外开放 0.0.0.0:3340（实现复审 P1-5）。
    let raw = cli
        .relay
        .clone()
        .or_else(|| std::env::var("DWEB_RELAY_HTTP_BIND").ok());
    match raw {
        Some(raw) => raw
            .parse()
            .map_err(|e| format!("invalid relay bind {raw}: {e}")),
        None => Ok(SocketAddr::from(([0, 0, 0, 0], 3340))),
    }
}

fn relay_enabled(cli: &Cli) -> bool {
    cli.relay_enabled.unwrap_or_else(|| {
        std::env::var("DWEB_RELAY_ENABLED")
            .map(|v| !matches!(v.as_str(), "false" | "0" | "off"))
            .unwrap_or(true)
    })
}

fn env_addr(key: &str) -> Option<SocketAddr> {
    std::env::var(key).ok()?.parse().ok()
}

/// DWEB_RELAY_CLIENT_RX 解析（task 1.7，纯函数便于测试）：字节/秒，非零
/// u32。未设置/空 = None（不限流）；非法值（0/负/溢出/非数字）硬错误。
fn parse_client_rx(raw: Option<String>) -> Result<Option<NonZeroU32>, String> {
    let Some(raw) = raw.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let value = raw
        .parse::<u32>()
        .map_err(|e| format!("invalid DWEB_RELAY_CLIENT_RX {raw}: {e}"))?;
    NonZeroU32::new(value)
        .map(Some)
        .ok_or_else(|| format!("invalid DWEB_RELAY_CLIENT_RX {raw}: must be > 0"))
}

/// 公网 URL 白名单校验 + 规范化（public-exposure D2；R2 P1-1/P1-3）：
/// `http(s)://host[:port]`，path 仅允许空或 `/`，拒绝 query/fragment/userinfo。
/// 返回 canonical 形态——必须从解析结果重建而非对原始串做字符串手术：
/// http::Uri 会把 scheme 归一为小写、把非法端口（`65536`、空串、非数字）
/// 从 `port_u16()` 静默丢弃为 None；只对原始串做 strip/前缀判断会出现
/// 「校验通过的值」与「公告的值」不一致（大写 scheme 被 services.rs 的
/// starts_with 防御兜底判为禁用、`:65536` 绕过端口上限）。
/// 拒绝 path 的根因：iroh 客户端 `set_path("/relay")` 会丢弃 relay URL 中
/// 的任何 path；gateway 的 rendezvous 条目靠字符串拼接，path 前缀同样破坏语义。
fn validate_public_url(value: &str) -> Result<String, String> {
    // http::Uri 解析会静默丢弃 fragment——必须先于解析显式拒绝
    if value.contains('#') {
        return Err(format!(
            "invalid public url {value}: fragment is not allowed"
        ));
    }
    // R2 P0-1：http::Uri::host() 会剥离 userinfo 段（"user:pass@host" 只返回
    // host），凭 userinfo 的输入能绕过后续 host 校验并把凭证原样写进
    // services.json 公告——authority 的 '@' 前置显式拒绝（合法公网入口
    // URL 不含 userinfo；'@' 出现在 path 的形态已被 path 规则拒绝）。
    if value.contains('@') {
        return Err(format!(
            "invalid public url {value}: userinfo is not allowed"
        ));
    }
    // 纯 ASCII、无空白/控制字符：scheme/host/port 的合法字符均为 ASCII，
    // http::Uri 对部分控制字符宽容，但公告输出必须保持纯 ASCII（D10 同源）
    if !value.is_ascii() || value.bytes().any(|b| b <= b' ') {
        return Err(format!(
            "invalid public url {value}: must be pure ASCII without whitespace"
        ));
    }
    let uri: axum::http::Uri = value
        .parse()
        .map_err(|_| format!("invalid public url {value}: cannot parse as absolute URL"))?;
    let scheme = uri.scheme_str().unwrap_or_default();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "invalid public url {value}: scheme must be http or https, got {scheme:?}"
        ));
    }
    let host = uri.host().unwrap_or_default();
    if host.is_empty() {
        return Err(format!("invalid public url {value}: missing host"));
    }
    // 端口必须从 authority 原文判断「写没写」：port_u16() 对越界/非数字端口
    // 返回 None，与「未写端口」不可区分（R2 P1-1）。括号 IPv6 的冒号在
    // 括号内，authority 以 ']' 结尾即无端口。
    let port = match uri.authority().map(|a| a.as_str()).and_then(|a| {
        if a.ends_with(']') {
            None
        } else {
            a.rsplit_once(':').map(|(_, p)| p)
        }
    }) {
        None => None,
        Some("") => {
            return Err(format!(
                "invalid public url {value}: port must be 1-65535 (empty port)"
            ));
        }
        Some(p) => match p.parse::<u32>() {
            Ok(n) if (1..=65535).contains(&n) => Some(n),
            _ => {
                return Err(format!("invalid public url {value}: port must be 1-65535"));
            }
        },
    };
    let path = uri.path();
    if path != "/" && !path.is_empty() {
        return Err(format!(
            "invalid public url {value}: path prefix is not supported (expected scheme://host[:port])"
        ));
    }
    if uri.query().is_some() {
        return Err(format!("invalid public url {value}: query is not allowed"));
    }
    let canonical = match port {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    };
    Ok(canonical)
}

/// 解析公网覆盖（flag > env > 未设置）；存储 canonical 形态
/// （scheme 小写、无尾随 `/`、端口规范化）。非法值硬错误（与 bind 同类
/// 失败，退出码 2）。
fn resolve_public_urls(
    cli: &Cli,
    get_env: impl Fn(&str) -> Option<String>,
) -> Result<(Option<String>, Option<String>), String> {
    let resolve_one =
        |flag: Option<&str>, env_key: &str, label: &str| -> Result<Option<String>, String> {
            let raw = match flag.map(str::to_owned).or_else(|| get_env(env_key)) {
                Some(v) => v,
                None => return Ok(None),
            };
            validate_public_url(&raw)
                .map(Some)
                .map_err(|e| format!("{e} ({label})"))
        };
    let gateway = resolve_one(
        cli.public_gateway.as_deref(),
        "DWEB_PUBLIC_GATEWAY_URL",
        "DWEB_PUBLIC_GATEWAY_URL / --public-gateway",
    )?;
    let relay = resolve_one(
        cli.public_relay.as_deref(),
        "DWEB_PUBLIC_RELAY_URL",
        "DWEB_PUBLIC_RELAY_URL / --public-relay",
    )?;
    Ok((gateway, relay))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let argv: Vec<String> = std::env::args().skip(1).collect();
    // `owners` 子命令（task 1.2）：直接操作 data_dir 的 owners.jsonl 后退出，
    // 不启动服务（admin 低频操作，design §7.3）
    if argv.first().map(String::as_str) == Some("owners") {
        return match access::registry::owners_cli(argv.into_iter().skip(1), &|k| {
            std::env::var(k).ok()
        }) {
            Ok(msg) => {
                println!("{msg}");
                Ok(())
            }
            Err(msg) => {
                eprintln!("error: {msg}");
                std::process::exit(2);
            }
        };
    }

    let cli = match parse_cli(argv.into_iter()) {
        Ok(cli) => cli,
        Err(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };

    // R2/R3：公网 URL 校验最先执行（静态输入，先于一切 bind/spawn）——
    // 非法值是最早的 fail-fast（退出码 2），不被 bind 解析/端口冲突遮蔽。
    let (public_gateway_url, public_relay_url) =
        match resolve_public_urls(&cli, |k| std::env::var(k).ok()) {
            Ok(v) => v,
            Err(msg) => {
                eprintln!("error: {msg}");
                std::process::exit(2);
            }
        };
    // 访问控制配置（task 1.3）：flag > env > default，fail-fast 校验
    // （非法 mode / callback 缺配置 / restricted+QAD 拒绝）先于一切 bind/spawn。
    let access_cli = access::config::AccessCliInputs {
        access_mode: cli.access_mode.clone(),
        data_dir: cli.data_dir.clone(),
        owners_file: cli.owners_file.clone(),
        allow_loopback_callback: cli.allow_loopback_callback,
    };
    let access_cfg =
        match access::config::resolve_access_config(&access_cli, &|k| std::env::var(k).ok()) {
            Ok(cfg) => cfg,
            Err(msg) => {
                eprintln!("error: {msg}");
                std::process::exit(2);
            }
        };

    // 数据层初始化（task 1.1/1.2）：server.key load-or-create + owners.jsonl
    // 归并。执行点接线（task 1.5/1.5b）：restricted 模式构造 AccessGate
    // （callback URL 非法在此 fail-fast，退出码 2），registry 以 Arc 共享给
    // 验证链与热重载看护。identity 同以 Arc 共享——admin API（task 3.1）
    // 的回执签名与 services.json 的 ServerId 同一实例。
    let identity = std::sync::Arc::new(access::identity::ServerIdentity::load_or_create(
        &access_cfg.data_dir,
    )?);
    let owners = std::sync::Arc::new(access::registry::OwnerRegistry::load(
        &access_cfg.owners_file,
    )?);
    let owners_snapshot = owners.snapshot();
    if let Some(warning) =
        access::config::restricted_static_empty_warning(&access_cfg, owners_snapshot.is_empty())
    {
        tracing::warn!("{warning}");
    }
    tracing::info!(
        "server id {} (access mode {:?}, owner registry: {} active, generation {})",
        identity.server_id(),
        access_cfg.mode,
        owners_snapshot.len(),
        owners_snapshot.generation()
    );

    // restricted：构造验证链聚合器并挂 registry 热重载看护（mtime 轮询 5s；
    // open 模式 relay 走 AllowAll 快路径，无需 gate/看护）
    let (relay_gate, rdz_gate) = match access_cfg.mode {
        access::config::AccessMode::Restricted => {
            // per-owner 连接配额（task 3.2 前半）：仅 relay gate 消费
            // （rendezvous Op 无连接语义）
            let gate = match access::gate::AccessGate::new(
                *identity.server_id().as_bytes(),
                std::sync::Arc::clone(&owners),
                access_cfg.policy.clone(),
            ) {
                Ok(g) => g.with_max_connections_per_owner(access_cfg.max_connections_per_owner),
                Err(msg) => {
                    eprintln!("error: {msg}");
                    std::process::exit(2);
                }
            };
            let gate = std::sync::Arc::new(gate);
            tracing::info!(
                "relay access control enabled (policy {}, deny reasons on dweb/ namespace{})",
                match access_cfg.policy {
                    access::config::PolicyConfig::Static => "static",
                    access::config::PolicyConfig::Callback(_) => "callback",
                },
                match access_cfg.max_connections_per_owner {
                    Some(n) => format!(", per-owner connection quota {n}"),
                    None => String::new(),
                }
            );
            access::gate::spawn_registry_reload_watcher(
                std::sync::Arc::clone(&owners),
                Some(std::sync::Arc::clone(&gate)),
            );
            // rendezvous gate（task 1.6）：恒 Static 策略——design §8.5 R3
            // P0-B2 冻结 rendezvous 不接 callback（其 HTTP 面无握手身份，
            // 动态策略另立 change）；共享同一 registry/server_id（L1/L1b
            // 同一套验证器，registry 热重载经 Arc 共享生效）
            let rdz = match access::gate::AccessGate::new(
                *identity.server_id().as_bytes(),
                std::sync::Arc::clone(&owners),
                access::config::PolicyConfig::Static,
            ) {
                Ok(g) => std::sync::Arc::new(g),
                Err(msg) => {
                    eprintln!("error: {msg}");
                    std::process::exit(2);
                }
            };
            tracing::info!("rendezvous access control enabled (static ACL: announce/resolve)");
            (Some(gate), Some(rdz))
        }
        access::config::AccessMode::Open => (None, None),
    };

    let relay_bind_addr = match relay_bind(&cli) {
        Ok(a) => a,
        Err(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };
    // client_rx 限流（task 1.7）：DWEB_RELAY_CLIENT_RX 字节/秒，与 access
    // mode 正交（open 模式同样生效）；非法值硬错误（与 bind 同类，退出码 2）
    let client_rx = match parse_client_rx(std::env::var("DWEB_RELAY_CLIENT_RX").ok()) {
        Ok(v) => v,
        Err(msg) => {
            eprintln!("error: {msg}");
            std::process::exit(2);
        }
    };
    if let Some(bytes_per_second) = client_rx {
        tracing::info!("relay client_rx rate limit: {bytes_per_second} bytes/s");
    }
    // admin API（task 3.1）：DWEB_ADMIN_TOKEN 存在才挂路由——未配置 =
    // /admin/* 404 零暴露（静态 token 方案与 admin 信任域论证见 admin.rs
    // 模块注释）。registry/relay gate 以 Arc 共享：API 注册即时生效于
    // 验证链（同进程同一 OwnerRegistry 快照替换）；先于 relay::start 构造
    // （relay_gate 所有权随后移交 relay）。
    let admin_router = std::env::var("DWEB_ADMIN_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
        .map(|token| {
            tracing::info!("admin API enabled (Bearer DWEB_ADMIN_TOKEN, /admin/*)");
            access::admin::router(access::admin::AdminState::new(
                token,
                std::sync::Arc::clone(&identity),
                std::sync::Arc::clone(&owners),
                relay_gate.clone(),
                access_cfg.mode,
                match access_cfg.policy {
                    access::config::PolicyConfig::Static => "static",
                    access::config::PolicyConfig::Callback(_) => "callback",
                },
            ))
        });
    let relay = relay::start(
        relay_enabled(&cli),
        relay_bind_addr,
        env_addr("DWEB_RELAY_QUIC_BIND"),
        relay_gate,
        client_rx,
    )
    .await?;

    let bind = gateway_bind(&cli);
    let bind_addr: SocketAddr = bind
        .parse()
        .with_context(|| format!("invalid gateway bind address {bind}"))?;
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("gateway bind {bind}"))?;
    let local = listener.local_addr()?;
    tracing::info!("dweb-server gateway listening on http://{local}");

    if let Some(url) = &public_gateway_url {
        tracing::info!("public gateway url override: {url}");
    }
    if let Some(url) = &public_relay_url {
        tracing::info!("public relay url override: {url}");
    }

    let info = std::sync::Arc::new(services::ServiceInfo {
        gateway_port: local.port(),
        relay_port: relay.as_ref().and_then(|s| s.http_addr()).map(|a| a.port()),
        trust_proxy: std::env::var("DWEB_TRUST_PROXY").ok().as_deref() == Some("1"),
        fallback_ipv4: services::primary_non_loopback_ipv4(),
        public_gateway_url,
        public_relay_url,
        // task 1.8：ServerId 以 hex 发布（iroh_base::PublicKey Display = 小写
        // hex，与 owners.jsonl 的 root hex 同一展示形态）
        server_id: identity.server_id().to_string(),
    });

    let app = rendezvous::router_with_access(rdz_gate).merge(services::router(info));
    let app = match admin_router {
        Some(admin) => app.merge(admin),
        None => app,
    };
    let http = axum::serve(listener, app);
    tokio::select! {
        res = http => res?,
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("shutting down");
            if let Some(server) = relay {
                server.shutdown().await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_flags_parsed() {
        let cli = parse_cli(
            [
                "--gateway",
                "0.0.0.0:9999",
                "--relay",
                "0.0.0.0:3350",
                "--no-relay",
                "--public-gateway",
                "https://gw.example.com",
                "--public-relay",
                "https://relay.example.com",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();
        assert_eq!(cli.gateway.as_deref(), Some("0.0.0.0:9999"));
        assert_eq!(cli.relay.as_deref(), Some("0.0.0.0:3350"));
        assert_eq!(cli.relay_enabled, Some(false));
        assert_eq!(
            cli.public_gateway.as_deref(),
            Some("https://gw.example.com")
        );
        assert_eq!(
            cli.public_relay.as_deref(),
            Some("https://relay.example.com")
        );
    }

    #[test]
    fn cli_public_url_inline_form_equals_split_form() {
        let a = parse_cli(
            ["--public-gateway", "https://a.example.com"]
                .into_iter()
                .map(String::from),
        )
        .unwrap();
        let b = parse_cli(
            ["--public-gateway=https://a.example.com"]
                .into_iter()
                .map(String::from),
        )
        .unwrap();
        assert_eq!(a.public_gateway, b.public_gateway);
    }

    #[test]
    fn cli_public_url_missing_value_rejected() {
        assert!(parse_cli(["--public-gateway".into()].into_iter()).is_err());
        assert!(parse_cli(["--public-relay".into()].into_iter()).is_err());
    }

    #[test]
    fn validate_public_url_accepts_minimal_forms() {
        for ok in [
            "https://gw.example.com",
            "https://gw.example.com/",
            "http://192.168.1.9:8787",
            "http://[fd00::1]:9000",
            "https://relay.example.com:443",
        ] {
            validate_public_url(ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
    }

    /// R2 P1-1/P1-3：校验必须产出 canonical 形态——scheme 归一为小写、
    /// 尾随 `/` 剥除、无端口段保持无端口；公告值与校验值同源。
    #[test]
    fn validate_public_url_canonicalizes() {
        assert_eq!(
            validate_public_url("HTTPS://GW.example.com").unwrap(),
            "https://GW.example.com"
        );
        assert_eq!(
            validate_public_url("https://gw.example.com/").unwrap(),
            "https://gw.example.com"
        );
        assert_eq!(
            validate_public_url("http://[fd00::1]:9000").unwrap(),
            "http://[fd00::1]:9000"
        );
        // 无端口输入不得伪造默认端口
        assert_eq!(
            validate_public_url("https://gw.example.com").unwrap(),
            "https://gw.example.com"
        );
    }

    /// R2 P1-1 回归：port_u16() 对越界/空/非数字端口静默返回 None，
    /// 端口语义必须从 authority 原文判断，不得依赖 port_u16()。
    #[test]
    fn validate_public_url_rejects_degenerate_ports() {
        assert!(validate_public_url("https://ex.com:65536").is_err());
        assert!(validate_public_url("https://ex.com:").is_err());
        assert!(validate_public_url("https://ex.com:abc").is_err());
        assert!(validate_public_url("http://ex.com:0").is_err());
        // 括号 IPv6 本体（含冒号）不算端口段
        assert!(validate_public_url("http://[fd00::1]").is_ok());
    }

    #[test]
    fn validate_public_url_rejects_structured_forms() {
        // path 前缀：iroh set_path("/relay") 会丢弃 path，必然错配
        assert!(validate_public_url("https://ex.com/dweb").is_err());
        // query / fragment / 非 http(s) / 空 host / 端口 0
        assert!(validate_public_url("https://ex.com/?a=b").is_err());
        assert!(validate_public_url("https://ex.com/#frag").is_err());
        assert!(validate_public_url("ftp://ex.com").is_err());
        assert!(validate_public_url("https://").is_err());
        assert!(validate_public_url("http://ex.com:0").is_err());
        assert!(validate_public_url("not a url").is_err());
        assert!(validate_public_url("https://exa mple.com").is_err());
        // R2 P0-1 回归：userinfo 必须被拒绝（http::Uri::host() 会静默剥离，
        // 不前置拒绝则凭证进入 services.json 公告）
        assert!(validate_public_url("https://user:pass@example.com").is_err());
        assert!(validate_public_url("https://user@example.com").is_err());
        assert!(validate_public_url("https://ex.com@evil.com").is_err());
    }

    #[test]
    fn resolve_public_urls_priority_and_normalization() {
        let cli = Cli {
            public_gateway: Some("https://flag-gw.example.com".into()),
            public_relay: None,
            ..Cli::default()
        };

        // flag gateway > env gateway；env relay 合法则生效
        let env1: std::collections::HashMap<String, String> = [
            ("DWEB_PUBLIC_GATEWAY_URL", "https://env-gw.example.com/"),
            ("DWEB_PUBLIC_RELAY_URL", "https://env-relay.example.com"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let (gw, relay) = resolve_public_urls(&cli, |k| env1.get(k).cloned()).unwrap();
        assert_eq!(gw.as_deref(), Some("https://flag-gw.example.com"));
        assert_eq!(relay.as_deref(), Some("https://env-relay.example.com"));

        // env relay 非法 → 硬错误（即使 gateway 侧全部合法）
        let env2: std::collections::HashMap<String, String> = [("DWEB_PUBLIC_RELAY_URL", "bogus")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert!(resolve_public_urls(&Cli::default(), |k| env2.get(k).cloned()).is_err());

        // 纯 env 路径 + 尾随 "/" 归一化剥除
        let env3: std::collections::HashMap<String, String> =
            [("DWEB_PUBLIC_GATEWAY_URL", "https://env-gw.example.com/")]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        let (gw, relay) = resolve_public_urls(&Cli::default(), |k| env3.get(k).cloned()).unwrap();
        assert_eq!(gw.as_deref(), Some("https://env-gw.example.com"));
        assert_eq!(relay, None);
    }

    #[test]
    fn cli_http_alias_equals_gateway() {
        let a = parse_cli(["--gateway", "0.0.0.0:9000"].into_iter().map(String::from)).unwrap();
        let b = parse_cli(["--gateway=0.0.0.0:9000"].into_iter().map(String::from)).unwrap();
        assert_eq!(a.gateway, b.gateway);
    }

    #[test]
    fn cli_unknown_option_rejected() {
        assert!(parse_cli(["--foo".into()].into_iter()).is_err());
        assert!(parse_cli(["--gateway".into()].into_iter()).is_err()); // 缺值
    }

    #[test]
    fn gateway_bind_priority_flag_env_default() {
        // flag > env > default
        assert_eq!(resolve_gateway_bind(Some("A"), Some("G")), "A");
        assert_eq!(resolve_gateway_bind(None, Some("G")), "G");
        assert_eq!(resolve_gateway_bind(None, None), DEFAULT_GATEWAY_BIND);
    }

    /// client_rx 解析（task 1.7）：未设置/空 = 不限流；0/非法 = 硬错误
    #[test]
    fn client_rx_parse_matrix() {
        assert_eq!(parse_client_rx(None).unwrap(), None);
        assert_eq!(parse_client_rx(Some(String::new())).unwrap(), None);
        assert_eq!(
            parse_client_rx(Some("1024".into())).unwrap(),
            Some(NonZeroU32::new(1024).unwrap())
        );
        assert_eq!(
            parse_client_rx(Some("1".into())).unwrap(),
            Some(NonZeroU32::new(1).unwrap())
        );
        for bad in ["0", "-1", "abc", "4294967296"] {
            assert!(
                parse_client_rx(Some(bad.into())).is_err(),
                "DWEB_RELAY_CLIENT_RX={bad}"
            );
        }
    }

    /// 访问控制 flag（task 1.3）：--access-mode/--data-dir/--owners-file 值形 +
    /// --allow-loopback-callback bool 形 + inline 等价
    #[test]
    fn cli_access_flags_parsed() {
        let cli = parse_cli(
            [
                "--access-mode",
                "restricted",
                "--data-dir",
                "/srv/dweb",
                "--owners-file",
                "/srv/dweb/owners.jsonl",
                "--allow-loopback-callback",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();
        assert_eq!(cli.access_mode.as_deref(), Some("restricted"));
        assert_eq!(cli.data_dir.as_deref(), Some("/srv/dweb"));
        assert_eq!(cli.owners_file.as_deref(), Some("/srv/dweb/owners.jsonl"));
        assert_eq!(cli.allow_loopback_callback, Some(true));

        let inline = parse_cli(
            ["--access-mode=restricted", "--data-dir=/srv/dweb"]
                .into_iter()
                .map(String::from),
        )
        .unwrap();
        assert_eq!(inline.access_mode, cli.access_mode);
        assert_eq!(inline.data_dir, cli.data_dir);
        // 缺值拒绝
        assert!(parse_cli(["--access-mode".into()].into_iter()).is_err());
        assert!(parse_cli(["--data-dir".into()].into_iter()).is_err());
        assert!(parse_cli(["--owners-file".into()].into_iter()).is_err());
    }
}
