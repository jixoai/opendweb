//! [H8] Phase 0（home-hub §2.1）：deferStart 生命周期与 roster 显式 fabric_id
//! 采纳的集成测试。
//!
//! 覆盖面（spec `openspec/changes/home-hub/specs/sdk/node` + design §2.1）：
//! - 状态机转移表逐条合法/拒绝边（表驱动）；
//! - 取消三分法三分支（shutdown 取消=resolve 已取消不可重试 / 底层失败
//!   =reject 可重试 / 调用方放弃 Future=状态机不感知）；
//! - 并发 start single-flight；shutdown 各态幂等；
//! - deferred 构造零网络出站（endpoint 未 bind、零注入）+ 本地预检；
//! - start() 缓存票据合并优先级（ensured > tuple 校验缓存票；四类旧票
//!   忽略；同 URL 冲突 ensured 胜；start 不覆盖 ensured 票）；
//! - fabricId：采纳读回逐字相等 / open 重开仍该值 / open tuple 校验 /
//!   既有 roster（无论 fabricId 是否一致）createRoot=AlreadyExists。
//!
//! 网络策略：Disabled 模式（纯本地 UDP bind）驱动相位流转；CustomWithCaps
//! 场景使用不可达 relay URL（http://127.0.0.1:1，连接拒绝不出外网）——
//! 合并注入先于 bind/online，以 endpoint_bound() 为注入完成信号，随后以
//! shutdown 取消在途航班收尾（不等待 10s online 超时）。

use dweb_fabric::identity::NodeIdentity;
use dweb_fabric::protocol::{FabricId, ROOT_CAPS, RelayCapV1};
use dweb_fabric::roster::RosterError;
use dweb_fabric::secret::SecretSeed;
use dweb_fabric::{
    Fabric, FabricConfig, FabricError, FabricStartOptions, LifecyclePhase, RelayConfig, RelayEntry,
    SecretInjection, StartOutcome,
};
use std::sync::Arc;
use std::time::Duration;

const RELAY_URL: &str = "http://127.0.0.1:1";
const SERVER_ID: [u8; 32] = [0xA1; 32];

fn seed(n: u8) -> SecretSeed {
    SecretSeed::from_bytes([n; 32])
}

fn cfg_disabled(dir: &std::path::Path) -> FabricConfig {
    FabricConfig {
        data_dir: dir.to_owned(),
        relay: RelayConfig::Disabled,
        secret: SecretInjection::Seed(seed(1)),
        ..FabricConfig::new(dir)
    }
}

fn cfg_caps(dir: &std::path::Path, secret: SecretSeed) -> FabricConfig {
    FabricConfig {
        data_dir: dir.to_owned(),
        relay: RelayConfig::CustomWithCaps(vec![RelayEntry {
            url: RELAY_URL.to_owned(),
            server_id: Some(SERVER_ID),
            token: None,
        }]),
        secret: SecretInjection::Seed(secret),
        ..FabricConfig::new(dir)
    }
}

fn defer_opts(fabric_id: Option<[u8; 32]>) -> FabricStartOptions {
    FabricStartOptions {
        defer_start: true,
        fabric_id,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// 以指定签发者身份铸造一枚 capability 串。
fn mint_cap(signer: &NodeIdentity, fabric: [u8; 32], server: [u8; 32], ttl_ms: u64) -> String {
    RelayCapV1::sign_and_encode(
        signer.secret_key(),
        &FabricId(fabric),
        &server,
        &signer.endpoint_id(),
        ROOT_CAPS,
        now_ms(),
        now_ms() + ttl_ms,
    )
    .unwrap()
}

/// 预置 relay.caps.json（形态冻结：[{url, capability}]）。
fn seed_caps_file(dir: &std::path::Path, entries: &[(String, String)]) {
    let items: Vec<serde_json::Value> = entries
        .iter()
        .map(|(url, cap)| serde_json::json!({ "url": url, "capability": cap }))
        .collect();
    std::fs::write(
        dir.join("relay.caps.json"),
        serde_json::to_string_pretty(&items).unwrap(),
    )
    .unwrap();
}

/// 等待启动航班完成注入+bind（endpoint_bound=true 即注入步已过）。
async fn wait_bound(fabric: &Fabric) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !fabric.endpoint_bound() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "start flight did not bind within 5s"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// 等待相位到达目标（abandon 分支的收敛观测）。
async fn wait_phase(fabric: &Fabric, want: LifecyclePhase) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while fabric.lifecycle_phase() != want {
        assert!(
            tokio::time::Instant::now() < deadline,
            "phase did not reach {want:?} within 5s (now {:?})",
            fabric.lifecycle_phase()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// 启动航班 → shutdown 取消 → 断言「已取消」+Closed。
async fn start_then_cancel(fabric: &Arc<Fabric>) {
    let fb = Arc::clone(fabric);
    let handle = tokio::spawn(async move { fb.start().await });
    wait_bound(fabric).await;
    fabric.shutdown().await.unwrap();
    let outcome = handle.await.unwrap().unwrap();
    assert_eq!(outcome, StartOutcome::CancelledByShutdown);
    assert_eq!(fabric.lifecycle_phase(), LifecyclePhase::Closed);
}

// ==== 状态机转移表（合法/拒绝边，表驱动） =======================================

/// | Deferred \ start() | →Starting→Started |；| Started \ start() | 幂等 no-op |；
/// | Deferred \ shutdown() | →Closed |；| Closed \ start()/ensure | 明确错误 |；
/// | Closed \ shutdown() | 幂等 no-op |。
#[tokio::test]
async fn state_machine_legal_and_rejected_edges() {
    let dir = tempfile::tempdir().unwrap();

    // Deferred → Started；Started 后 start() 幂等 no-op
    let f = Fabric::create_root_with(cfg_disabled(dir.path()), defer_opts(None))
        .await
        .unwrap();
    assert_eq!(f.lifecycle_phase(), LifecyclePhase::Deferred);
    assert!(!f.endpoint_bound(), "deferred 构造零网络出站（未 bind）");
    assert_eq!(f.start().await.unwrap(), StartOutcome::Started);
    assert_eq!(f.lifecycle_phase(), LifecyclePhase::Started);
    assert!(f.endpoint_bound());
    assert_eq!(
        f.start().await.unwrap(),
        StartOutcome::Started,
        "Started 后 start() 幂等 no-op"
    );
    f.shutdown().await.unwrap();
    assert_eq!(f.lifecycle_phase(), LifecyclePhase::Closed);

    // Closed → start()/ensure 明确错误；shutdown 幂等 no-op
    assert!(matches!(f.start().await, Err(FabricError::Shutdown)));
    assert!(matches!(
        f.ensure_relay_capabilities().await,
        Err(FabricError::Shutdown)
    ));
    f.shutdown().await.unwrap();

    // Deferred →（shutdown）→ Closed：无网络面可清理，直接终态
    let dir2 = tempfile::tempdir().unwrap();
    let g = Fabric::create_root_with(cfg_disabled(dir2.path()), defer_opts(None))
        .await
        .unwrap();
    g.shutdown().await.unwrap();
    assert_eq!(g.lifecycle_phase(), LifecyclePhase::Closed);
    assert!(!g.endpoint_bound(), "Deferred 态 shutdown 不 bind");
    assert!(matches!(g.start().await, Err(FabricError::Shutdown)));
}

/// | Failed \ start() | →Starting（重试）→ Started |：bind 冲突制造底层失败，
/// 释放端口后重试成功。
#[tokio::test]
async fn state_machine_failed_retry_edge() {
    let dir = tempfile::tempdir().unwrap();
    // 占用 UDP 端口制造 bind 冲突（QUIC 数据面绑定同端口必败）
    let guard = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let port = guard.local_addr().unwrap().port();
    let cfg = FabricConfig {
        bind_addr: Some(format!("127.0.0.1:{port}")),
        ..cfg_disabled(dir.path())
    };
    let f = Fabric::create_root_with(cfg, defer_opts(None))
        .await
        .unwrap();
    let first = f.start().await;
    assert!(
        first.is_err(),
        "bind 冲突必须以底层失败 reject（三分法②，错误载荷含原因: {first:?}）"
    );
    assert_eq!(f.lifecycle_phase(), LifecyclePhase::Failed);
    // 释放端口后重试 → Starting → Started
    drop(guard);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(f.start().await.unwrap(), StartOutcome::Started);
    assert_eq!(f.lifecycle_phase(), LifecyclePhase::Started);
    f.shutdown().await.unwrap();
}

/// 并发 start single-flight：同航班同结果；调用方放弃 Future（不 await）状态机
/// 不感知——detached 航班照常完成，后续 start() 读得 Started（三分法③）。
#[tokio::test]
async fn concurrent_start_single_flight_and_abandoned_future() {
    let dir = tempfile::tempdir().unwrap();
    let f = Fabric::create_root_with(cfg_disabled(dir.path()), defer_opts(None))
        .await
        .unwrap();
    let (a, b) = tokio::join!(f.start(), f.start());
    assert_eq!(a.unwrap(), StartOutcome::Started);
    assert_eq!(b.unwrap(), StartOutcome::Started);
    assert_eq!(f.lifecycle_phase(), LifecyclePhase::Started);
    f.shutdown().await.unwrap();

    // 放弃 Future：poll 一次（触发 detached 航班）后丢弃
    let dir2 = tempfile::tempdir().unwrap();
    let g = Fabric::create_root_with(cfg_disabled(dir2.path()), defer_opts(None))
        .await
        .unwrap();
    {
        let fut = g.start();
        tokio::pin!(fut);
        let _ = tokio::time::timeout(Duration::from_millis(1), fut.as_mut()).await;
        // 超时丢弃 = 调用方不 await；detached 任务继续
    }
    wait_phase(&g, LifecyclePhase::Started).await;
    assert_eq!(
        g.start().await.unwrap(),
        StartOutcome::Started,
        "放弃 Future 后：后续 start() 经相位读得同一结果"
    );
    g.shutdown().await.unwrap();
}

/// | Starting \ shutdown() | 取消启动→Closed：在途 start 以「已取消」resolve
/// （非错误、不可重试）；shutdown 返回后无晚到 bind/网络事件。
#[tokio::test]
async fn shutdown_cancels_inflight_start_no_late_events() {
    let dir = tempfile::tempdir().unwrap();
    let fabric = Arc::new(
        Fabric::create_root_with(cfg_caps(dir.path(), seed(8)), defer_opts(None))
            .await
            .unwrap(),
    );
    let mut events = fabric.subscribe();
    // 不可达 relay：bind 即完成，取消落在 online 等待窗口内
    let fb = Arc::clone(&fabric);
    let handle = tokio::spawn(async move { fb.start().await });
    wait_bound(&fabric).await;
    tokio::time::sleep(Duration::from_millis(100)).await; // 确认进入 online 等待
    fabric.shutdown().await.unwrap();
    let outcome = handle.await.unwrap().unwrap();
    assert_eq!(
        outcome,
        StartOutcome::CancelledByShutdown,
        "在途 start Promise resolve「已取消」（非错误）"
    );
    assert_eq!(fabric.lifecycle_phase(), LifecyclePhase::Closed);
    // 不可重试
    assert!(matches!(fabric.start().await, Err(FabricError::Shutdown)));
    // shutdown 返回后无晚到 bind/网络事件
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(fabric.relay_watcher_exited(), "watcher 从未启动/已退出");
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}

// ==== deferred 构造零出站 + 预检 + 合并优先级 ===================================

/// deferred 构造与 ensure 阶段零网络出站；缓存票据 tuple 预检（有效票留待
/// 注入）；start() 后 RelayMap 持租约匹配票 = ensured 票（缓存票不覆盖）。
#[tokio::test]
async fn deferred_zero_outbound_preflight_and_ensured_wins() {
    let dir = tempfile::tempdir().unwrap();
    let fabric_id: [u8; 32] = [0x0F; 32];
    // 同 tuple 有效缓存票（issuer=root、server=SERVER_ID、fabric 一致、未过期）
    let root = NodeIdentity::from_seed([9u8; 32]);
    let valid_cache = mint_cap(&root, fabric_id, SERVER_ID, 3_600_000);
    seed_caps_file(dir.path(), &[(RELAY_URL.to_owned(), valid_cache)]);

    let f = Arc::new(
        Fabric::create_root_with(cfg_caps(dir.path(), seed(9)), defer_opts(Some(fabric_id)))
            .await
            .unwrap(),
    );
    // 构造期：零 bind、零注入（缓存票留待 start() 合并）
    assert_eq!(f.lifecycle_phase(), LifecyclePhase::Deferred);
    assert!(!f.endpoint_bound(), "构造零网络出站：未 bind");
    assert_eq!(
        f.relay_map_token(RELAY_URL),
        None,
        "构造期不注入缓存票据（留待 start 合并）"
    );
    assert_eq!(f.relay_status().online, Some(false));

    // ensure（deferred 态可执行，零网络）：注入 ensured 票
    let ensured = f.ensure_relay_capabilities().await.unwrap();
    assert_eq!(ensured.len(), 1);
    assert_eq!(
        f.relay_map_token(RELAY_URL).as_deref(),
        Some(ensured[0].1.as_str())
    );
    assert!(!f.endpoint_bound(), "ensure 仍是零网络出站");

    // start：同 URL 冲突 ensured 胜（start 不得覆盖 ensured 票）
    start_then_cancel(&f).await;
    assert_eq!(
        f.relay_map_token(RELAY_URL).as_deref(),
        Some(ensured[0].1.as_str()),
        "start 后 RelayMap 持租约匹配票 = ensured 票（合并优先级压制缓存票）"
    );
}

/// 四类旧票（错 server / 错 fabric / 错 issuer / 同 tuple 过期）+ 同 tuple 有效：
/// 预检忽略前三+过期，有效票在无 ensure 时参与注入；有 ensure 时 ensured 胜。
#[tokio::test]
async fn cache_merge_priority_table() {
    struct Case {
        name: &'static str,
        cap: String,
    }
    let root = NodeIdentity::from_seed([2u8; 32]);
    let other_signer = NodeIdentity::from_seed([3u8; 32]);
    let fabric_id: [u8; 32] = [0x22; 32];
    let cases = [
        Case {
            name: "wrong-server",
            cap: mint_cap(&root, fabric_id, [0xB2; 32], 3_600_000),
        },
        Case {
            name: "wrong-fabric",
            cap: mint_cap(&root, [0x33; 32], SERVER_ID, 3_600_000),
        },
        Case {
            name: "wrong-issuer",
            cap: mint_cap(&other_signer, fabric_id, SERVER_ID, 3_600_000),
        },
        Case {
            name: "same-tuple-expired",
            // expires_at < now：load_relay_caps 读取侧丢弃
            cap: RelayCapV1::sign_and_encode(
                root.secret_key(),
                &FabricId(fabric_id),
                &SERVER_ID,
                &root.endpoint_id(),
                ROOT_CAPS,
                now_ms() - 10_000,
                now_ms() - 1,
            )
            .unwrap(),
        },
        Case {
            name: "same-tuple-valid",
            cap: mint_cap(&root, fabric_id, SERVER_ID, 3_600_000),
        },
    ];
    for case in cases {
        // 无 ensure：start 后 RelayMap 持票情况（仅 valid 参与）
        let dir = tempfile::tempdir().unwrap();
        seed_caps_file(dir.path(), &[(RELAY_URL.to_owned(), case.cap.clone())]);
        let f = Arc::new(
            Fabric::create_root_with(cfg_caps(dir.path(), seed(2)), defer_opts(Some(fabric_id)))
                .await
                .unwrap(),
        );
        start_then_cancel(&f).await;
        let injected = f.relay_map_token(RELAY_URL);
        if case.name == "same-tuple-valid" {
            assert_eq!(
                injected.as_deref(),
                Some(case.cap.as_str()),
                "{}: tuple 校验通过的缓存票参与注入",
                case.name
            );
        } else {
            assert_eq!(
                injected, None,
                "{}: tuple 不匹配/过期的旧票被忽略（不注入）",
                case.name
            );
        }

        // 有 ensure：ensured 胜（五类场景全部被压制——含同 tuple 有效旧票）
        let dir2 = tempfile::tempdir().unwrap();
        seed_caps_file(dir2.path(), &[(RELAY_URL.to_owned(), case.cap.clone())]);
        let g = Arc::new(
            Fabric::create_root_with(cfg_caps(dir2.path(), seed(2)), defer_opts(Some(fabric_id)))
                .await
                .unwrap(),
        );
        let ensured = g.ensure_relay_capabilities().await.unwrap();
        assert_eq!(ensured.len(), 1);
        start_then_cancel(&g).await;
        assert_eq!(
            g.relay_map_token(RELAY_URL).as_deref(),
            Some(ensured[0].1.as_str()),
            "{}: ensured 票最高优先（start 不覆盖）",
            case.name
        );
    }
}

// ==== roster 显式 fabric_id 采纳 ===============================================

#[tokio::test]
async fn fabric_id_adoption_readback_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let adopted: [u8; 32] = [0x5A; 32];
    let f = Fabric::create_root_with(cfg_disabled(dir.path()), defer_opts(Some(adopted)))
        .await
        .unwrap();
    let hex = f.fabric_id_hex().await;
    assert_eq!(hex, "5a".repeat(32), "读回逐字等于提供值（小写 hex）");
    f.shutdown().await.unwrap();

    // 同 data_dir 重开（open 无期望值 / open 期望 A）：仍为该值
    let g = Fabric::open_with(cfg_disabled(dir.path()), defer_opts(None))
        .await
        .unwrap();
    assert_eq!(g.fabric_id_hex().await, hex);
    g.shutdown().await.unwrap();
    let h = Fabric::open_with(cfg_disabled(dir.path()), defer_opts(Some(adopted)))
        .await
        .unwrap();
    assert_eq!(h.fabric_id_hex().await, hex);
    h.shutdown().await.unwrap();

    // open 期望 B：明确错误（DirFabricMismatch）
    let mismatch = Fabric::open_with(cfg_disabled(dir.path()), defer_opts(Some([0x5B; 32]))).await;
    assert!(
        matches!(
            mismatch,
            Err(FabricError::Roster(RosterError::DirFabricMismatch { .. }))
        ),
        "open 的 tuple 校验：期望不符=明确错误"
    );

    // 既有 roster：createRoot（fabricId=A / B / 缺省）一律 AlreadyExists
    for bad in [Some(adopted), Some([0x5B; 32]), None] {
        let err = Fabric::create_root_with(cfg_disabled(dir.path()), defer_opts(bad)).await;
        assert!(
            matches!(
                err,
                Err(FabricError::Roster(RosterError::AlreadyExists { .. }))
            ),
            "既有 roster（无论 fabricId 是否一致）createRoot=AlreadyExists"
        );
    }
    // A 原样保留
    let reopened = Fabric::open_with(cfg_disabled(dir.path()), defer_opts(None))
        .await
        .unwrap();
    assert_eq!(reopened.fabric_id_hex().await, hex);
    reopened.shutdown().await.unwrap();

    // 缺省 = SDK 随机生成（既有行为）
    let dir2 = tempfile::tempdir().unwrap();
    let r = Fabric::create_root(cfg_disabled(dir2.path()))
        .await
        .unwrap();
    let random_hex = r.fabric_id_hex().await;
    assert_eq!(random_hex.len(), 64);
    assert_ne!(random_hex, hex);
    assert!(
        random_hex.bytes().all(|b| b.is_ascii_hexdigit()),
        "随机 fabric_id 为 hex64"
    );
    r.shutdown().await.unwrap();
}

/// 缺省 eager 行为零回归（相位面）：createRoot/open 缺省即 Started、已 bind。
#[tokio::test]
async fn eager_default_starts_immediately() {
    let dir = tempfile::tempdir().unwrap();
    let f = Fabric::create_root(cfg_disabled(dir.path())).await.unwrap();
    assert_eq!(f.lifecycle_phase(), LifecyclePhase::Started);
    assert!(f.endpoint_bound());
    assert_eq!(f.relay_status().online, None, "Disabled 模式 online=None");
    // Started 后 start() 幂等（与 deferred 完成后同面）
    assert_eq!(f.start().await.unwrap(), StartOutcome::Started);
    f.shutdown().await.unwrap();

    let g = Fabric::open(cfg_disabled(dir.path())).await.unwrap();
    assert_eq!(g.lifecycle_phase(), LifecyclePhase::Started);
    g.shutdown().await.unwrap();
}
