# Tasks: server-access-policy

> 第一阶段（本 change 文档：proposal/design/4 份 spec delta）已完成并经
> Codex R1 复核修订（P0×6 + P1×7 + P2×2 全部闭合，见 design 附录 B）。
> 以下为实现排期。InviteV2 wire 以本 change design 附录 A 为唯一权威。

## Phase 1 — Server 独立可测（dweb-server crate 内闭环）

- [x] 1.1 server identity：`<data_dir>/server.key` load-or-create（0600、
       tmp+fsync+rename 原子写、幂等）；ServerId 派生
- [x] 1.2 owner registry：owners.jsonl append-only 写入/启动归并/活跃集合
       只读快照；register/unregister CLI 子命令（含 root 公钥 PoP 卫生
       校验工具）；SIGHUP/mtime 文件重载
- [x] 1.3 配置面：`--access-mode`/`--data-dir`/`--owners-file`（CLI）、
       `DWEB_ACCESS_MODE`/`DWEB_DATA_DIR`/`DWEB_OWNERS_FILE`（env）、
       `[server.access]`（config.toml）；fail-fast 校验（restricted+QAD
       bind 拒绝启动；restricted+空 registry 启动告警）
       （第一棒 CLI/env/fail-fast 全量；config.toml `[server.access]` TS
       映射曾为显式遗留，第二棒已收口：config-file schema/opendweb CLI
       三层链/startServer env 注入 + --allow-loopback-callback flag 透传）
- [x] 1.4 RelayCapV1：canonical 编解码（域分隔 `dweb/relay-cap/v1`）、
       `dwebr1.` 串格式、caps 位图（未知位拒绝）、≤1KiB 长度门与
       base64url 白名单；编码长度测试冻结（≈242B canonical+sig /
       ≈331 字符串）
       （实现勘定：canonical 146B + sig 64B = wire 210B，串 287 字符，
       见 cap.rs token_shape_frozen）
- [x] 1.5 AccessControl 实现：on_connect 两段式验证链——L1 密码学
       （C1-C7：格式/长度/字符集门、caps 保留位、Ed25519 验签、
       server_id、时间三重校验 now>=expires_at + CLOCK_SKEW 120s +
       TTL≤180d、recipient==握手 id）+ L2 StaticRegistryProvider
       （(fabric_id,issuer) 二元组 + op 所需 caps 位）；on_disconnect；
       open 模式走 AllowAll 快路径
- [x] 1.5b CallbackProvider（policy=callback，事件仅 relay.connect/
       disconnect）：webhook 客户端（Bearer callback_token、超时硬上限
       2s、请求/响应 body ≤4KiB、disconnect payload 冻结
       {event,endpoint_id,connection_id} 无 capability、每 connection
       至多一次）、C0 凭证来源分类（存在但非法 → malformed 拒，不进
       无票路径——直接检查 headers/query，不复用 auth_token() 归一化）、
       L1b 底线前置（无效票不触发 webhook）、决策缓存
       （registry_generation + endpoint_id + BLAKE3(113B 定长二进制投影，
       无票 sentinel zero×96) + event 键；TTL≤60s；cache_ttl_s 省略=
       配置默认/非法=0/未知字段忽略；registry 变更清缓存）、并发防护
       （singleflight + 全局 64/来源 16（source=endpoint_id）/队列 256，
       队满即 policy-unavailable）、fail-closed（非 200/3xx/超时/解析
       失败/body 超限）、reason 语法 dweb/[a-z0-9][a-z0-9._-]{0,63}
       （非法替换 dweb/policy-denied）、SSRF 边界（HTTPS 强制 +
       allow_loopback_callback 豁免 + 解析-校验-连接原子语义：全部
       A/AAAA 逐个校验/IPv4-mapped 归一化/固定地址直连不经代理/不跟随
       重定向 + token 日志脱敏）、callback 配置缺失/非法启动 fail-fast、
       stock 装配断言（Server::spawn 路径唯一，不绕 authorize_with/
       register）
       （实现勘定：缓存键投影为 113B 原文直键（单射），无 BLAKE3 摘要
       ——R5 实现期裁定，见 design 附录 B）
- [x] 1.6 rendezvous ACL：announce（caps 校验 + recipient==签名
       EndpointId 绑定）/ resolve（bearer-only，caps 校验）；open 模式
       现状路径零变化
- [x] 1.7 iroh-relay Limits 接线：仅 `client_rx`（上游已实现）；连接数
       限额不承诺（上游 accept_conn_* 未实现）
- [x] 1.8 services.json 增量：`server_id` 字段（字段只增；
       packages/server-binary 字段断言测试同步更新）
- [x] 1.9 集成测试：验证链矩阵（每个 deny reason 独立用例：no-capability/
       malformed/caps-unsupported/bad-signature/unknown-owner/wrong-server/
       capability-expired 含等值边界与超 TTL/not-recipient/caps-missing-relay/
       policy-unavailable）、callback 负例矩阵（无效票不触发 webhook：
       缺 RELAY 位/未注册 owner/L1 各失败分支 + 断言零回调；HTTP 401/403/
       500/非 JSON/缺 allow/非布尔/超大 body/读超时与 2000ms 边界；缓存键
       隔离（endpoint/capability/event 变化不命中）+ TTL=0/超限/负数 +
       registry 变更清缓存；singleflight 并发 miss + 全局/来源上限 +
       队列耗尽；SSRF（私网/重定向/token 不外泄）+ reason CR/LF/超长/
       Unicode；disconnect 重复/乱序/多连接）、open/restricted 行为对比、
       重启持久化、unregister 阻断新连接、client_rx 限流正交性、
       QAD fail-fast
       （形态勘定：单测层（gate/callback/cap/relay/rendezvous 模块内
       127 用例）覆盖全 reason 矩阵与 callback 负例；tests/
       server_access_e2e.rs 黑盒矩阵 e1-e13 覆盖真 iroh relay/客户端
       端到端：连接成功/各 deny reason 经握手协议回传/重启持久化/
       unregister 热重载/callback 三态/QAD/空 registry 双语义/
       client_rx 正交/rendezvous 网关 ACL）

## Phase 2 — fabric/SDK capability 流通

- [x] 2.1 InviteV2 wire（附录 A）：编解码、recipient 必填校验、内嵌
       capability 一致性（recipient==invite.recipient、TTL≤invite.expires）、
       旧客户端 unsupported-invite-version 错误码
       （Phase2-A 44e9e36）
- [x] 2.2 dweb-fabric RelayConfig 扩展：`CustomWithCaps(Vec<RelayEntry>)`，
       per-relay capability 注入 RelayMap（iroh 条目级 token）；旧
       `Custom(Vec<String>)` 保留
       （Phase2-A 44e9e36；RelayEntry{url, server_id?, token?}，
       server_id=restricted 条目标记 + root 自签锚点）
- [x] 2.3 root 自签：Fabric 配置 restricted relay 时本地生成 own
       capability（caps 全位、TTL≤180d）
       （Phase2-A 44e9e36；`ensure_relay_capabilities()`——own 不持久化，
       每次启动重签（Ed25519 确定性幂等））
- [x] 2.4 REDEEM_OK2 帧（0x15）：v2 令牌版本信号触发；payload = 名册
       dump + u32 前缀 capability 附发段（绑 redeemer，TTL≤90d）；v1
       令牌一律回旧 REDEEM_OK（兼容测试冻结）
       （Phase2-A 44e9e36；tests/redeem_ok2_wire.rs 6 用例）
- [x] 2.5 napi SDK：RelayOptions 可选 `relays: {url, token?}[]`（双字段
       冲突显式报错）；relay 接入 `dweb/*` deny reason 透出为诊断事件
       （Phase2-B：relays 条目增补 `serverId?`（hex64 构造期校验，root
       自签配置位——spec delta 已回写）；joinWithToken 按前缀分派 v1/v2
       precheck（v2 一步加入修复）；ensureRelayCapabilities 投影 SDK 面；
       deny reason 透出 = relay 状态 lastError + relay-offline 事件
       （sanitize 结构化例外）+ join/connect 拨号错误 message 附注）
- [x] 2.6 fabric/roster、fabric/session、sdk/node delta 随实现更新
       （初稿已产出，实现偏差回写 spec）
       （Phase2-B：sdk/node delta 回写 server_id 增补 + 透出通道裁定；
       roster/session delta 无偏差——44e9e36 已核对）
- [x] 2.7 端到端：restricted server 上 invite v2→join（经 relay 拨号）→
       直连→relay fallback 全链路；老 SDK 连 restricted server 的可预期
       失败验证；老 SDK 解析 v2 invite 的错误路径验证
       （Phase2-B：tests/story_e2e.rs 单故事函数承载 S1-S8——admin 部署/
       root 自签上线/v2 邀请/经 restricted relay join+member cap 持久化/
       通信回程/越权矩阵（no-capability + not-recipient×2）/v1 旧形态
       可预期失败（deny reason 双诊断面）+ v1-only 解析 dweb2. 第九码/
       重启恢复再通信）

## Phase 3 — 运营面（另行排期）

- [x] 3.1 admin API：server.key 签发的 admin token；registry 热加载
       与注册回执签名
       （Phase3-A 实现：`Authorization: Bearer <DWEB_ADMIN_TOKEN>` 静态
       token（env 必填才挂路由，未配置 = /admin/* 404 零暴露；server.key
       challenge 签名方案因需交互式握手被裁定否决——admin 信任域与
       callback_token 同级，见 access/admin.rs 模块注释）；路由
       GET/POST /admin/owners + DELETE /admin/owners/{fabric}/{root} +
       GET /admin/status（mode/policy/generation/配额/per-endpoint 在线表/
       per-owner 计数/cache_entries）；注册/注销复用 OwnerRegistry（CLI/
       文件重载/API 三入口同一实例）+ callback 缓存失效；回执 = server.key
       对 canonical b"dweb/admin-receipt/v1\0"||op||fabric||root||ts||
       generation 的 Ed25519 签名（响应自带全部被签字段，可对 services.json
       的 ServerId 独立验签）；jsonl 仍为 source of truth，mtime 热重载保留）
- [x] 3.2 per-owner 配额钩子（连接计数/端点数上限）与存量连接主动
       断连钩子评估（iroh-relay Clients 表可及性）
       （Phase3-A 实现：DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER env（默认无
       上限，仅 restricted relay gate 消费）；AccessGate 在线表
       (endpoint_id,connection_id)→fabric_id + owner 计数，on_connect
        Allow 原子预约（L1b 后、L2 前，L2 deny 回滚防泄漏），on_disconnect
        释放；超限 deny reason dweb/owner-quota-exceeded；无票 A_cb 接入
        与 rendezvous Op 不占名额。**断连钩子评估结论：可及**——iroh-relay
        1.1.0 公开 API 链 Server::relay_service() → RelayService::clients()
        → Clients::disconnect(endpoint_id, connection_id: Option)（http_
        server.rs:949-955 文档明示运行期踢连接用途；clients.rs:181-207
        异步 start_shutdown），unregister 踢存量可零 fork 实现，列入
        下一棒 3.2b；本棒按任务定义仅交付评估结论）
- [ ] 3.3 member capability 续期协议化评估（RENEW 消息 vs regular 会话
       重发的 MVP 语义固化）；`peer_scope` capability 扩展评估
- [ ] 3.4 多平台矩阵（darwin-arm64/windows-x64）与 Docker/compose
       配置文档更新
