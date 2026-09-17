//! 访问控制配置面（task 1.3 Rust 侧，需求来源 2026-09-17；design §11.2 /
//! §8.5 callback 协议 / §9 A10 QAD）。
//!
//! 解析优先级与 main.rs 既有 resolve_* 一致：flag > env > default（纯函数 +
//! env 注入便于测试）。本棒覆盖 CLI flag 与 env；config.toml 的 `[server.access]`
//! TS 映射不在本棒（后续接线）。
//!
//! fail-fast 校验（错误信息经 main 以退出码 2 终止，风格同 main.rs）：
//! - access-mode 非法值
//! - policy=callback 时 callback 配置存在性（DWEB_CALLBACK_URL/TOKEN env；
//!   callback 完整逻辑与 SSRF 边界是下一棒 task 1.5b）
//! - restricted + DWEB_RELAY_QUIC_BIND 存在 → 拒绝启动（QAD 地址发现服务
//!   无 AccessControl，design §9 A10 spec 冻结）
//! - restricted + static + 空 registry → 启动告警（WARNING，不拒绝；design
//!   §14：fail-closed 语义由文档明示）

use std::path::PathBuf;

/// data_dir 默认值（cwd 相对；未显式配置时 server.key/owners.jsonl 落此目录）
pub const DEFAULT_DATA_DIR: &str = "dweb-data";
/// data_dir 内的 owner registry 文件名（design §11.2）
pub const OWNERS_FILE_NAME: &str = "owners.jsonl";

/// access mode（design §0：open 不启用访问控制、行为与现状一致）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    Open,
    Restricted,
}

impl AccessMode {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "open" => Ok(Self::Open),
            "restricted" => Ok(Self::Restricted),
            other => Err(format!(
                "invalid access mode {other:?}: expected open|restricted (--access-mode / DWEB_ACCESS_MODE)"
            )),
        }
    }
}

/// L2 策略选择（design §8.5；static 是默认，行为与 R2 版十步链一致）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyConfig {
    Static,
    Callback(CallbackConfig),
}

/// callback webhook 配置（design §8.5 协议卫生参数；本棒只做存在性与
/// 边界校验，webhook 客户端/缓存/并发防护是下一棒 task 1.5b）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackConfig {
    pub url: String,
    pub token: String,
    /// 默认 2000ms，硬上限 2000（design §8.5）
    pub timeout_ms: u64,
    /// 默认 30000，上限 60000
    pub cache_ttl_ms: u64,
    /// 全局在途上限，默认 64
    pub max_concurrency: usize,
    /// 每来源在途上限（source = endpoint_id），默认 16
    pub per_source: usize,
    /// 有界等待队列（队满即拒），默认 256
    pub queue: usize,
    /// loopback webhook 豁免（开发用，--allow-loopback-callback）
    pub allow_loopback: bool,
}

/// 解析后的访问控制配置（数据层初始化与下一棒执行点共用的输入）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessConfig {
    pub mode: AccessMode,
    pub policy: PolicyConfig,
    pub data_dir: PathBuf,
    pub owners_file: PathBuf,
}

/// CLI flag 输入（main 的 parse_cli 产出后传入；env 由 getter 注入便于测试）
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AccessCliInputs {
    pub access_mode: Option<String>,
    pub data_dir: Option<String>,
    pub owners_file: Option<String>,
    pub allow_loopback_callback: Option<bool>,
}

/// 解析 + fail-fast 校验（纯函数）。env 键：
/// DWEB_ACCESS_MODE / DWEB_DATA_DIR / DWEB_OWNERS_FILE / DWEB_ACCESS_POLICY /
/// DWEB_CALLBACK_URL / DWEB_CALLBACK_TOKEN / DWEB_CALLBACK_TIMEOUT_MS /
/// DWEB_CALLBACK_CACHE_TTL_MS / DWEB_CALLBACK_MAX_CONCURRENCY /
/// DWEB_CALLBACK_PER_SOURCE / DWEB_CALLBACK_QUEUE / DWEB_RELAY_QUIC_BIND。
pub fn resolve_access_config(
    cli: &AccessCliInputs,
    get_env: &dyn Fn(&str) -> Option<String>,
) -> Result<AccessConfig, String> {
    // mode：flag > env > default open（阶段 0 兼容，design §14）
    let mode_raw = cli
        .access_mode
        .clone()
        .or_else(|| get_env("DWEB_ACCESS_MODE"))
        .unwrap_or_else(|| "open".to_string());
    let mode = AccessMode::parse(&mode_raw)?;

    // data_dir / owners_file：flag > env > default（owners 缺省派生自 data_dir）
    let data_dir = PathBuf::from(
        cli.data_dir
            .clone()
            .or_else(|| get_env("DWEB_DATA_DIR"))
            .unwrap_or_else(|| DEFAULT_DATA_DIR.to_string()),
    );
    let owners_file = cli
        .owners_file
        .clone()
        .or_else(|| get_env("DWEB_OWNERS_FILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join(OWNERS_FILE_NAME));

    // policy：env（static|callback，默认 static）。config.toml 的 policy 字段
    // 随 TS 映射接线（不在本棒）；flag 面暂不设——策略是低频部署决策。
    let policy_raw = get_env("DWEB_ACCESS_POLICY").unwrap_or_else(|| "static".to_string());
    let policy = match policy_raw.as_str() {
        "static" => PolicyConfig::Static,
        "callback" => PolicyConfig::Callback(resolve_callback_config(cli, get_env)?),
        other => {
            return Err(format!(
                "invalid access policy {other:?}: expected static|callback (DWEB_ACCESS_POLICY)"
            ));
        }
    };

    let config = AccessConfig {
        mode,
        policy,
        data_dir,
        owners_file,
    };
    validate(&config, get_env)?;
    Ok(config)
}

fn resolve_callback_config(
    cli: &AccessCliInputs,
    get_env: &dyn Fn(&str) -> Option<String>,
) -> Result<CallbackConfig, String> {
    // 本棒只校验存在性（非空）；HTTPS/SSRF/解析原子性边界是 task 1.5b
    let url = get_env("DWEB_CALLBACK_URL")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            "policy=callback requires DWEB_CALLBACK_URL (see design §8.5)".to_string()
        })?;
    let token = get_env("DWEB_CALLBACK_TOKEN")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            "policy=callback requires DWEB_CALLBACK_TOKEN (see design §8.5)".to_string()
        })?;
    Ok(CallbackConfig {
        url,
        token,
        timeout_ms: env_u64(get_env, "DWEB_CALLBACK_TIMEOUT_MS", 2000, 1..=2000)?,
        cache_ttl_ms: env_u64(get_env, "DWEB_CALLBACK_CACHE_TTL_MS", 30_000, 0..=60_000)?,
        max_concurrency: env_usize(get_env, "DWEB_CALLBACK_MAX_CONCURRENCY", 64, 1..=65535)?,
        per_source: env_usize(get_env, "DWEB_CALLBACK_PER_SOURCE", 16, 1..=65535)?,
        queue: env_usize(get_env, "DWEB_CALLBACK_QUEUE", 256, 1..=65535)?,
        allow_loopback: cli.allow_loopback_callback.unwrap_or(false),
    })
}

fn env_u64(
    get_env: &dyn Fn(&str) -> Option<String>,
    key: &str,
    default: u64,
    range: std::ops::RangeInclusive<u64>,
) -> Result<u64, String> {
    let Some(raw) = get_env(key) else {
        return Ok(default);
    };
    let value = raw
        .parse::<u64>()
        .map_err(|e| format!("invalid {key} {raw:?}: {e}"))?;
    if !range.contains(&value) {
        return Err(format!(
            "invalid {key} {raw:?}: must be in {}..={}",
            range.start(),
            range.end()
        ));
    }
    Ok(value)
}

fn env_usize(
    get_env: &dyn Fn(&str) -> Option<String>,
    key: &str,
    default: usize,
    range: std::ops::RangeInclusive<usize>,
) -> Result<usize, String> {
    env_u64(
        get_env,
        key,
        default as u64,
        *range.start() as u64..=*range.end() as u64,
    )
    .map(|v| v as usize)
}

/// 跨字段校验（配置错误 = 退出码 2 路径）
fn validate(config: &AccessConfig, get_env: &dyn Fn(&str) -> Option<String>) -> Result<(), String> {
    // QAD fail-fast（design §9 A10 / tasks 1.3）：restricted 模式 MUST 拒绝
    // 启用 QAD bind——它是无 AccessControl 的地址发现服务，旁路属未授权
    // 地址探测/隐私泄漏面。错误信息保留 "QAD" 关键词供部署排障检索。
    if config.mode == AccessMode::Restricted && get_env("DWEB_RELAY_QUIC_BIND").is_some() {
        return Err(
            "invalid configuration: --access-mode restricted cannot be combined with \
             DWEB_RELAY_QUIC_BIND (QAD address-discovery plane has no access control; \
             unset DWEB_RELAY_QUIC_BIND or use --access-mode open — design §A10)"
                .to_string(),
        );
    }
    Ok(())
}

/// restricted + static + 空 registry 的启动告警（不拒绝启动；design §14
/// fail-closed 语义文档明示）。返回告警文案，由 main 以 WARNING 日志输出。
pub fn restricted_static_empty_warning(
    config: &AccessConfig,
    registry_is_empty: bool,
) -> Option<&'static str> {
    if config.mode == AccessMode::Restricted
        && matches!(config.policy, PolicyConfig::Static)
        && registry_is_empty
    {
        Some(
            "restricted mode with static policy and an empty owner registry: \
             every relay access will be denied (fail-closed) — register owners \
             via `dweb-server owners register` or switch DWEB_ACCESS_POLICY=callback",
        )
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn defaults_when_nothing_set() {
        let cfg = resolve_access_config(&AccessCliInputs::default(), &|_| None).unwrap();
        assert_eq!(cfg.mode, AccessMode::Open);
        assert_eq!(cfg.policy, PolicyConfig::Static);
        assert_eq!(cfg.data_dir, PathBuf::from(DEFAULT_DATA_DIR));
        assert_eq!(
            cfg.owners_file,
            PathBuf::from(DEFAULT_DATA_DIR).join(OWNERS_FILE_NAME)
        );
    }

    #[test]
    fn priority_flag_over_env_over_default() {
        // flag > env（access-mode / data-dir / owners-file 三路独立）
        let cli = AccessCliInputs {
            access_mode: Some("restricted".into()),
            data_dir: Some("/flag-data".into()),
            owners_file: Some("/flag-owners.jsonl".into()),
            allow_loopback_callback: None,
        };
        let getter = env(&[
            ("DWEB_ACCESS_MODE", "open"),
            ("DWEB_DATA_DIR", "/env-data"),
            ("DWEB_OWNERS_FILE", "/env-owners.jsonl"),
        ]);
        let cfg = resolve_access_config(&cli, &getter).unwrap();
        assert_eq!(cfg.mode, AccessMode::Restricted);
        assert_eq!(cfg.data_dir, PathBuf::from("/flag-data"));
        assert_eq!(cfg.owners_file, PathBuf::from("/flag-owners.jsonl"));

        // env > default（owners 未设时派生自 env data_dir）
        let getter = env(&[
            ("DWEB_ACCESS_MODE", "restricted"),
            ("DWEB_DATA_DIR", "/env-data"),
        ]);
        let cfg = resolve_access_config(&AccessCliInputs::default(), &getter).unwrap();
        assert_eq!(cfg.mode, AccessMode::Restricted);
        assert_eq!(cfg.data_dir, PathBuf::from("/env-data"));
        assert_eq!(cfg.owners_file, PathBuf::from("/env-data/owners.jsonl"));
    }

    #[test]
    fn invalid_mode_rejected() {
        let cli = AccessCliInputs {
            access_mode: Some("public".into()),
            ..Default::default()
        };
        let err = resolve_access_config(&cli, &|_| None).unwrap_err();
        assert!(err.contains("invalid access mode"), "{err}");

        let err = resolve_access_config(
            &AccessCliInputs::default(),
            &env(&[("DWEB_ACCESS_MODE", "public")]),
        )
        .unwrap_err();
        assert!(err.contains("DWEB_ACCESS_MODE"), "{err}");
    }

    #[test]
    fn invalid_policy_rejected() {
        let err = resolve_access_config(
            &AccessCliInputs::default(),
            &env(&[("DWEB_ACCESS_POLICY", "dynamic")]),
        )
        .unwrap_err();
        assert!(err.contains("DWEB_ACCESS_POLICY"), "{err}");
    }

    #[test]
    fn callback_policy_requires_url_and_token() {
        // 缺 URL
        let err = resolve_access_config(
            &AccessCliInputs::default(),
            &env(&[("DWEB_ACCESS_POLICY", "callback")]),
        )
        .unwrap_err();
        assert!(err.contains("DWEB_CALLBACK_URL"), "{err}");
        // 缺 token
        let err = resolve_access_config(
            &AccessCliInputs::default(),
            &env(&[
                ("DWEB_ACCESS_POLICY", "callback"),
                ("DWEB_CALLBACK_URL", "https://hook.example.com"),
            ]),
        )
        .unwrap_err();
        assert!(err.contains("DWEB_CALLBACK_TOKEN"), "{err}");
        // 齐备 → 默认参数生效（design §8.5：timeout 2000/ttl 30000/64/16/256）
        let cfg = resolve_access_config(
            &AccessCliInputs::default(),
            &env(&[
                ("DWEB_ACCESS_POLICY", "callback"),
                ("DWEB_CALLBACK_URL", "https://hook.example.com"),
                ("DWEB_CALLBACK_TOKEN", "sekrit"),
            ]),
        )
        .unwrap();
        match cfg.policy {
            PolicyConfig::Callback(cb) => {
                assert_eq!(cb.url, "https://hook.example.com");
                assert_eq!(cb.timeout_ms, 2000);
                assert_eq!(cb.cache_ttl_ms, 30_000);
                assert_eq!(cb.max_concurrency, 64);
                assert_eq!(cb.per_source, 16);
                assert_eq!(cb.queue, 256);
                assert!(!cb.allow_loopback);
            }
            other => panic!("expected callback policy, got {other:?}"),
        }
    }

    #[test]
    fn callback_numeric_bounds_enforced() {
        let base = &[
            ("DWEB_ACCESS_POLICY", "callback"),
            ("DWEB_CALLBACK_URL", "https://hook.example.com"),
            ("DWEB_CALLBACK_TOKEN", "sekrit"),
        ];
        // 超时硬上限 2000（design §8.5）
        let mut pairs: Vec<(&str, &str)> = base.to_vec();
        pairs.push(("DWEB_CALLBACK_TIMEOUT_MS", "2001"));
        assert!(resolve_access_config(&AccessCliInputs::default(), &env(&pairs)).is_err());
        // TTL 上限 60000
        let mut pairs = base.to_vec();
        pairs.push(("DWEB_CALLBACK_CACHE_TTL_MS", "60001"));
        assert!(resolve_access_config(&AccessCliInputs::default(), &env(&pairs)).is_err());
        // 非数字
        let mut pairs = base.to_vec();
        pairs.push(("DWEB_CALLBACK_QUEUE", "many"));
        let err = resolve_access_config(&AccessCliInputs::default(), &env(&pairs)).unwrap_err();
        assert!(err.contains("DWEB_CALLBACK_QUEUE"), "{err}");
        // 边界值合法（2000 / 60000 / 0 TTL=不缓存）
        let pairs: Vec<(&str, &str)> = base
            .iter()
            .cloned()
            .chain([
                ("DWEB_CALLBACK_TIMEOUT_MS", "2000"),
                ("DWEB_CALLBACK_CACHE_TTL_MS", "0"),
            ])
            .collect();
        let cfg = resolve_access_config(&AccessCliInputs::default(), &env(&pairs)).unwrap();
        assert!(matches!(cfg.policy, PolicyConfig::Callback(_)));
    }

    /// restricted + QAD bind 拒绝启动，错误信息含 "QAD"（design §9 A10）
    #[test]
    fn restricted_plus_qad_bind_rejected() {
        let getter = env(&[
            ("DWEB_ACCESS_MODE", "restricted"),
            ("DWEB_RELAY_QUIC_BIND", "0.0.0.0:3340"),
        ]);
        let err = resolve_access_config(&AccessCliInputs::default(), &getter).unwrap_err();
        assert!(err.contains("QAD"), "{err}");

        // open + QAD bind 不在此拦截（QAD 无 TLS 本就不启用，见 relay.rs）
        let getter = env(&[("DWEB_RELAY_QUIC_BIND", "0.0.0.0:3340")]);
        assert!(resolve_access_config(&AccessCliInputs::default(), &getter).is_ok());

        // restricted 但未设 QAD bind：合法
        let getter = env(&[("DWEB_ACCESS_MODE", "restricted")]);
        assert!(resolve_access_config(&AccessCliInputs::default(), &getter).is_ok());
    }

    #[test]
    fn restricted_static_empty_registry_warning_matrix() {
        let mut cfg = resolve_access_config(
            &AccessCliInputs {
                access_mode: Some("restricted".into()),
                ..Default::default()
            },
            &|_| None,
        )
        .unwrap();
        // restricted + static + 空 → 告警
        assert!(restricted_static_empty_warning(&cfg, true).is_some());
        // restricted + static + 非空 → 无告警
        assert!(restricted_static_empty_warning(&cfg, false).is_none());
        // restricted + callback + 空 → 无告警（A_cb 语义，design §14）
        cfg.policy = PolicyConfig::Callback(CallbackConfig {
            url: "https://hook.example.com".into(),
            token: "t".into(),
            timeout_ms: 2000,
            cache_ttl_ms: 30_000,
            max_concurrency: 64,
            per_source: 16,
            queue: 256,
            allow_loopback: false,
        });
        assert!(restricted_static_empty_warning(&cfg, true).is_none());
        // open → 无告警
        cfg.mode = AccessMode::Open;
        assert!(restricted_static_empty_warning(&cfg, true).is_none());
    }

    #[test]
    fn allow_loopback_flag_plumbs_into_callback() {
        let cli = AccessCliInputs {
            allow_loopback_callback: Some(true),
            ..Default::default()
        };
        let cfg = resolve_access_config(
            &cli,
            &env(&[
                ("DWEB_ACCESS_POLICY", "callback"),
                ("DWEB_CALLBACK_URL", "https://hook.example.com"),
                ("DWEB_CALLBACK_TOKEN", "t"),
            ]),
        )
        .unwrap();
        match cfg.policy {
            PolicyConfig::Callback(cb) => assert!(cb.allow_loopback),
            other => panic!("expected callback policy, got {other:?}"),
        }
    }
}
