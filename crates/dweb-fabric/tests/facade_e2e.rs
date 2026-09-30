//! Fabric 门面端到端：root 创建 → invite → joiner 兑换 → 双向连接 → 消息 → 撤销。
//! 全程仅 localhost 直连（relay 禁用），无任何外部设施。

use dweb_fabric::fabric::{JOIN_TIMEOUT_MS_DEFAULT, JOIN_TIMEOUT_MS_MIN};
use dweb_fabric::{Fabric, FabricConfig, FabricEvent, HttpProxyConfig, RelayConfig, RelayTlsTrust};
use std::time::Duration;
use tempfile::TempDir;

fn cfg(dir: &TempDir) -> FabricConfig {
    FabricConfig {
        data_dir: dir.path().to_owned(),
        relay: RelayConfig::Disabled,
        advertise_addrs: Vec::new(),
        secret: dweb_fabric::SecretInjection::Default,
        http_proxy: HttpProxyConfig::None,
        join_timeout_ms: JOIN_TIMEOUT_MS_DEFAULT,
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
        bind_addr: None,
    }
}

/// 预留一个空闲本地端口（UDP 试探后释放；测试语义下竞态可忽略）。
fn reserve_loopback_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// relay 禁用 + 固定端口直连配置（advertise_addrs 与实际监听端口一致）。
fn cfg_fixed_port(dir: &TempDir, port: u16) -> FabricConfig {
    FabricConfig {
        advertise_addrs: vec![format!("127.0.0.1:{port}")],
        bind_addr: Some(format!("127.0.0.1:{port}")),
        join_timeout_ms: JOIN_TIMEOUT_MS_MIN.max(5_000),
        relay_tls_trust: RelayTlsTrust::PlatformRoot,
        ..cfg(dir)
    }
}

async fn wait_event(
    rx: &mut tokio::sync::broadcast::Receiver<FabricEvent>,
    pred: impl Fn(&FabricEvent) -> bool,
    what: &str,
) -> FabricEvent {
    let deadline = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let ev = rx.recv().await.expect("event channel open");
            if pred(&ev) {
                return ev;
            }
        }
    })
    .await;
    match deadline {
        Ok(ev) => ev,
        Err(_) => panic!("timeout waiting for {what}"),
    }
}

#[tokio::test]
async fn full_lifecycle_invite_join_message_revoke() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();

    let port = reserve_loopback_port();
    let a = Fabric::create_root(cfg_fixed_port(&dir_a, port))
        .await
        .unwrap();
    let mut ev_a = a.subscribe();

    let fabric_id = a.fabric_id_hex().await;

    // B 以 attach 起步（空名册，等待 join 写入）
    let b = Fabric::attach(cfg(&dir_b), &fabric_id).await.unwrap();
    let mut ev_b = b.subscribe();

    // 邀请（5 分钟有效；advertise_addrs 携带固定端口直连地址）
    let token = a
        .invite(Duration::from_secs(300).as_millis() as u64, None)
        .await
        .unwrap();
    let decoded = dweb_fabric::protocol::InviteToken::decode(&token).unwrap();
    assert_eq!(
        decoded.invite.issuer_direct_addrs,
        vec![format!("127.0.0.1:{port}")]
    );

    // B 兑换：经 redeem ALPN 连 A（invite 含 127.0.0.1 直连提示）
    b.join(&token).await.expect("join redeems invite");
    let members_b = b.members().await;
    assert_eq!(
        members_b.len(),
        2,
        "B sees root + self after redeem: {:?}",
        members_b
    );
    assert!(members_b.iter().any(|m| m.endpoint_id == a.endpoint_id()));

    // A 侧名册更新（root 收到自身签发的 grant 后重放事件由 redeem handler 发出）
    let _ = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::RosterUpdated),
        "A roster updated",
    )
    .await;
    assert_eq!(a.members().await.len(), 2);

    // 同一令牌二次兑换必须被拒（CAS）：结构化 Consumed 记录 → TOKEN_CONSUMED
    let again = b.join(&token).await;
    match &again {
        Err(dweb_fabric::FabricError::Join { code, .. }) => {
            assert_eq!(*code, dweb_fabric::JoinErrorCode::TokenConsumed);
        }
        other => panic!("second redeem must fail with TOKEN_CONSUMED, got {other:?}"),
    }

    // B 连接 A（常规 ALPN，双向 HELLO 同步）
    b.connect(&a.endpoint_id()).await.expect("B connects A");
    let _ = wait_event(
        &mut ev_b,
        |e| matches!(e, FabricEvent::PeerConnected { .. }),
        "B sees A connected",
    )
    .await;
    let _ = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::PeerConnected { .. }),
        "A sees B connected",
    )
    .await;

    // 双向消息
    a.send(&b.endpoint_id(), b"ping from A".to_vec())
        .await
        .unwrap();
    let ev = wait_event(
        &mut ev_b,
        |e| matches!(e, FabricEvent::Message { .. }),
        "B receives message",
    )
    .await;
    match ev {
        FabricEvent::Message { from, data } => {
            assert_eq!(from, a.endpoint_id());
            assert_eq!(data, b"ping from A");
        }
        _ => unreachable!(),
    }
    b.send(&a.endpoint_id(), b"pong from B".to_vec())
        .await
        .unwrap();
    let ev = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::Message { .. }),
        "A receives message",
    )
    .await;
    match ev {
        FabricEvent::Message { from, data } => {
            assert_eq!(from, b.endpoint_id());
            assert_eq!(data, b"pong from B");
        }
        _ => unreachable!(),
    }

    // A 撤销 B：投影收紧 + 会话断开
    a.revoke(&b.endpoint_id()).await.unwrap();
    let _ = wait_event(
        &mut ev_a,
        |e| matches!(e, FabricEvent::PeerDisconnected { .. }),
        "A sees B disconnected",
    )
    .await;
    let _ = wait_event(
        &mut ev_b,
        |e| matches!(e, FabricEvent::PeerDisconnected { .. }),
        "B sees own disconnect",
    )
    .await;
    assert_eq!(a.members().await.len(), 1, "B removed from A projection");

    // B 重连被门控拒绝（B 本地投影在 HELLO 同步后含 revoke 事实——由撤销前的同步传播；
    // 若 B 尚未收到 revoke，A 侧门控也会拒绝其连接）
    let blocked = b.connect(&a.endpoint_id()).await;
    assert!(blocked.is_err(), "revoked member must not reconnect");

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}

#[tokio::test]
async fn non_member_connect_is_gated() {
    let dir_a = TempDir::new().unwrap();
    let dir_c = TempDir::new().unwrap();

    let a = Fabric::create_root(cfg(&dir_a)).await.unwrap();
    let c = Fabric::create_root(cfg(&dir_c)).await.unwrap();
    let err = c.connect(&a.endpoint_id()).await.unwrap_err();
    assert!(
        matches!(
            err,
            dweb_fabric::FabricError::Session(dweb_fabric::SessionError::NotMember(_))
        ),
        "expected NotMember, got {err:?}"
    );

    a.shutdown().await.unwrap();
    c.shutdown().await.unwrap();
}

#[tokio::test]
async fn root_restart_keeps_membership_and_identity() {
    let dir = TempDir::new().unwrap();
    let a1 = Fabric::create_root(cfg(&dir)).await.unwrap();
    let id1 = a1.endpoint_id();
    let fid1 = a1.fabric_id_hex().await;
    a1.shutdown().await.unwrap();

    let a2 = Fabric::open(cfg(&dir)).await.unwrap();
    assert_eq!(a2.endpoint_id(), id1);
    assert_eq!(a2.fabric_id_hex().await, fid1);
    assert_eq!(a2.members().await.len(), 1);
    a2.shutdown().await.unwrap();
}

#[tokio::test]
async fn remote_revoke_kicks_session_via_acceptor_path() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();
    let dir_c = TempDir::new().unwrap();

    let port = reserve_loopback_port();
    let a = Fabric::create_root(cfg_fixed_port(&dir_a, port))
        .await
        .unwrap();
    let fid = a.fabric_id_hex().await;

    let b = Fabric::attach(cfg(&dir_b), &fid).await.unwrap();
    let c = Fabric::attach(cfg(&dir_c), &fid).await.unwrap();
    let mut ev_c = c.subscribe();

    // A 邀请 B 与 C
    b.join(&a.invite(300_000, None).await.unwrap())
        .await
        .unwrap();
    c.join(&a.invite(300_000, None).await.unwrap())
        .await
        .unwrap();

    // B/C 各自再与 A 同步，互相知晓对方的 Grant
    b.connect(&a.endpoint_id()).await.unwrap();
    c.connect(&a.endpoint_id()).await.unwrap();

    // relay 禁用场景：显式交换地址提示（仅 loopback：LAN 路径在本机发夹场景下
    // 与 iroh 路径状态竞争，会造成重拨卡死——见 dial_after_disconnect 复现）
    for hint in c
        .direct_addr_hints_public()
        .await
        .into_iter()
        .filter(|h| h.starts_with("127.0.0.1:"))
    {
        b.add_known_addr(&c.endpoint_id(), hint.clone())
            .await
            .unwrap();
        a.add_known_addr(&c.endpoint_id(), hint).await.unwrap();
    }
    for hint in b
        .direct_addr_hints_public()
        .await
        .into_iter()
        .filter(|h| h.starts_with("127.0.0.1:"))
    {
        c.add_known_addr(&b.endpoint_id(), hint.clone())
            .await
            .unwrap();
        a.add_known_addr(&b.endpoint_id(), hint).await.unwrap();
    }

    // C 与 B 建立既有会话（B 主动拨号，C 为 acceptor）
    b.connect(&c.endpoint_id()).await.unwrap();
    let _ = wait_event(
        &mut ev_c,
        |e| matches!(e, FabricEvent::PeerConnected { .. }),
        "C sees B",
    )
    .await;

    // A 撤销 B
    a.revoke(&b.endpoint_id()).await.unwrap();

    // A 主动拨号 C：C 作为 acceptor 在 HELLO 中收到含 revoke(B) 的事实集，
    // 必须在 merge 后差集踢除并断开与 B 的既有会话（codex round3 场景）。
    // 先断开既有 A-C 连接，避免 connect 幂等短路不发 HELLO。
    a.disconnect(&c.endpoint_id()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    a.connect(&c.endpoint_id()).await.unwrap();

    // C 侧观察到 B 下线（acceptor 路径差集踢除）
    let _ = wait_event(
        &mut ev_c,
        |e| matches!(e, FabricEvent::PeerDisconnected { .. }),
        "C kicks B",
    )
    .await;

    // B 不再是 C 的有效成员
    assert!(!c.is_member(&b.endpoint_id()).await.unwrap());

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
    c.shutdown().await.unwrap();
}

#[tokio::test]
async fn secret_injection_semantics() {
    use dweb_fabric::SecretInjection;
    use dweb_fabric::secret::SecretSeed;

    // 1) Seed 注入：确定性 + 零存储副作用（目录无 identity.key）
    let dir = TempDir::new().unwrap();
    let seed = SecretSeed::from_bytes([7u8; 32]);
    let expected_id = seed.endpoint_id();
    let f = Fabric::create_root(FabricConfig {
        secret: SecretInjection::Seed(seed),
        ..cfg(&dir)
    })
    .await
    .unwrap();
    assert_eq!(
        f.endpoint_id(),
        dweb_fabric::identity::endpoint_id_display(&expected_id)
    );
    assert!(
        !dir.path().join("identity.key").exists(),
        "seed injection must not touch storage"
    );

    // 2) open 缺失身份 => MissingIdentity，不生成
    let dir2 = TempDir::new().unwrap();
    let f2 = Fabric::create_root(FabricConfig {
        secret: SecretInjection::Seed(SecretSeed::from_bytes([8u8; 32])),
        ..cfg(&dir2)
    })
    .await
    .unwrap();
    f2.shutdown().await.unwrap();
    // data_dir 只有 roster（seed 注入没写 identity.key）
    let opened = Fabric::open(FabricConfig {
        secret: SecretInjection::Default,
        ..cfg(&dir2)
    })
    .await;
    assert!(
        matches!(opened, Err(dweb_fabric::FabricError::MissingIdentity(_))),
        "open without identity must fail"
    );

    // 3) seed 与 roster 不一致 => IdentityRosterMismatch（open）
    let mismatch = Fabric::open(FabricConfig {
        secret: SecretInjection::Seed(SecretSeed::from_bytes([9u8; 32])),
        ..cfg(&dir2)
    })
    .await;
    assert!(
        matches!(
            mismatch,
            Err(dweb_fabric::FabricError::IdentityRosterMismatch(_))
        ),
        "foreign seed vs roster must fail"
    );

    // 4) 身份导出：同 seed 恢复同 EndpointId；不含 roster 语义
    let token = f2.export_secret("pass-phrase").unwrap();
    let restored = dweb_fabric::secret::import_secret(&token, "pass-phrase").unwrap();
    assert_eq!(
        restored.endpoint_id(),
        dweb_fabric::identity::endpoint_id_parse(&f2.endpoint_id()).unwrap()
    );
    assert!(matches!(
        dweb_fabric::secret::import_secret(&token, "wrong"),
        Err(dweb_fabric::secret::SecretExportError::Auth)
    ));
}

/// v2 recipient-bound invite 的 join 全链（真双机验收形态：restricted relay
/// 配置 + 直连地址主路径——relay 不可达不妨碍直连兑换），并冻结消费面
/// root 判定语义：
/// - `root_endpoint_id`：root 册=Some(self)；attach 空册=None；join 后
///   member 册=Some(issuer)（消费面据此分流 root-only 操作）。
/// - `ensure_relay_capabilities` 对 member 句柄按设计拒绝（NotRoot，
///   caller=member、root=issuer）——member 的 capability 由 OK2 附发，
///   这是 webui 侧 join 接管序列不得调用 ensure 的内核依据。
#[tokio::test]
async fn v2_recipient_bound_join_member_root_accessors_and_ensure_refusal() {
    let dir_a = TempDir::new().unwrap();
    let dir_b = TempDir::new().unwrap();

    // A（root）：CustomWithCaps restricted 条目 + 固定端口直连宣告——
    // invite_with 由此分派 v2 签发路径（has_restricted）。
    let port = reserve_loopback_port();
    let relay_entry = dweb_fabric::RelayEntry {
        url: "https://127.0.0.1:1".to_owned(),
        server_id: Some([0xA1; 32]),
        token: None,
    };
    let a = Fabric::create_root(FabricConfig {
        relay: RelayConfig::CustomWithCaps(vec![relay_entry.clone()]),
        ..cfg_fixed_port(&dir_a, port)
    })
    .await
    .unwrap();

    // root 判定：root 册 = Some(self)
    assert_eq!(
        a.root_endpoint_id().await.as_deref(),
        Some(a.endpoint_id().as_str())
    );

    let fabric_id = a.fabric_id_hex().await;
    // B（joiner）：同为 CustomWithCaps（消费面装配形态），attach 空册
    let b = Fabric::attach(
        FabricConfig {
            relay: RelayConfig::CustomWithCaps(vec![relay_entry]),
            ..cfg(&dir_b)
        },
        &fabric_id,
    )
    .await
    .unwrap();
    assert_eq!(
        b.root_endpoint_id().await,
        None,
        "empty attach roster has no root"
    );

    // v2 邀请：recipient 恒必填（Some(B)）→ dweb2. 令牌（直连地址随签）
    let token = a
        .invite_with(
            300_000,
            Some(&b.endpoint_id()),
            dweb_fabric::InviteOptions::default(),
        )
        .await
        .unwrap();
    assert!(
        token.starts_with("dweb2."),
        "restricted relay config signs v2 tokens"
    );
    // 回环 relay 剔除（真双机验收实证）：直连地址在场时 issuer 本机回环
    // relay 条目不签入令牌——跨机 joiner 的 relay 相位死等会拖垮整个 dial
    //（iroh 路径选择不回落 direct，实测 30s join deadline 全耗尽）。
    let decoded_v2 = dweb_fabric::protocol::InviteV2Token::decode(&token).unwrap();
    assert!(
        decoded_v2.invite.relays.is_empty(),
        "loopback relay entries must be dropped when direct addrs exist: {:?}",
        decoded_v2.invite.relays
    );
    assert_eq!(
        decoded_v2.invite.direct_addrs,
        vec![format!("127.0.0.1:{port}").parse().unwrap()]
    );

    // 兑换（relay 不可达，直连主路径）→ member 册 root = issuer
    b.join(&token)
        .await
        .expect("v2 recipient-bound join via direct addr");
    assert_eq!(
        b.members().await.len(),
        2,
        "joiner is a member after redeem"
    );
    assert_eq!(
        b.root_endpoint_id().await.as_deref(),
        Some(a.endpoint_id().as_str()),
        "member roster root is the issuer"
    );

    // member 句柄 ensure 拒绝（内核设计）：caller=member、root=issuer——
    // 消费面（webui joinWithToken/startSequence）必须按 root 判定分流。
    let refused = b.ensure_relay_capabilities().await;
    match refused {
        Err(dweb_fabric::FabricError::Roster(dweb_fabric::roster::RosterError::NotRoot {
            caller,
            root,
        })) => {
            assert_eq!(
                dweb_fabric::identity::endpoint_id_display(&caller),
                b.endpoint_id()
            );
            assert_eq!(
                root.map(|r| dweb_fabric::identity::endpoint_id_display(&r)),
                Some(a.endpoint_id())
            );
        }
        other => panic!("member ensure must refuse with NotRoot, got {other:?}"),
    }

    a.shutdown().await.unwrap();
    b.shutdown().await.unwrap();
}
