# Tasks: server-access-policy

> 第一阶段（本 change 文档：proposal/design/4 份 spec delta）已完成并经
> Codex R1 复核修订（P0×6 + P1×7 + P2×2 全部闭合，见 design 附录 B）。
> 以下为实现排期。InviteV2 wire 以本 change design 附录 A 为唯一权威。

## Phase 1 — Server 独立可测（dweb-server crate 内闭环）

- [ ] 1.1 server identity：`<data_dir>/server.key` load-or-create（0600、
       tmp+fsync+rename 原子写、幂等）；ServerId 派生
- [ ] 1.2 owner registry：owners.jsonl append-only 写入/启动归并/活跃集合
       只读快照；register/unregister CLI 子命令（含 root 公钥 PoP 卫生
       校验工具）；SIGHUP/mtime 文件重载
- [ ] 1.3 配置面：`--access-mode`/`--data-dir`/`--owners-file`（CLI）、
       `DWEB_ACCESS_MODE`/`DWEB_DATA_DIR`/`DWEB_OWNERS_FILE`（env）、
       `[server.access]`（config.toml）；fail-fast 校验（restricted+QAD
       bind 拒绝启动；restricted+空 registry 启动告警）
- [ ] 1.4 RelayCapV1：canonical 编解码（域分隔 `dweb/relay-cap/v1`）、
       `dwebr1.` 串格式、caps 位图（未知位拒绝）、≤1KiB 长度门与
       base64url 白名单；编码长度测试冻结（≈242B canonical+sig /
       ≈331 字符串）
- [ ] 1.5 AccessControl 实现：on_connect 十步验证链（含 (fabric_id,issuer)
       二元组、时间语义 now>=expires_at、CLOCK_SKEW 120s、TTL 上限
       90d/180d）+ on_disconnect；open 模式走 AllowAll 快路径
- [ ] 1.6 rendezvous ACL：announce（caps 校验 + recipient==签名
       EndpointId 绑定）/ resolve（bearer-only，caps 校验）；open 模式
       现状路径零变化
- [ ] 1.7 iroh-relay Limits 接线：仅 `client_rx`（上游已实现）；连接数
       限额不承诺（上游 accept_conn_* 未实现）
- [ ] 1.8 services.json 增量：`server_id` 字段（字段只增；
       packages/server-binary 字段断言测试同步更新）
- [ ] 1.9 集成测试：验证链矩阵（每个 deny reason 独立用例：no-capability/
       malformed/caps-unsupported/bad-signature/unknown-owner/wrong-server/
       capability-expired 含等值边界与超 TTL/not-recipient/caps-missing-relay）、
       open/restricted 行为对比、重启持久化、unregister 阻断新连接、
       client_rx 限流正交性、QAD fail-fast

## Phase 2 — fabric/SDK capability 流通

- [ ] 2.1 InviteV2 wire（附录 A）：编解码、recipient 必填校验、内嵌
       capability 一致性（recipient==invite.recipient、TTL≤invite.expires）、
       旧客户端 unsupported-invite-version 错误码
- [ ] 2.2 dweb-fabric RelayConfig 扩展：`CustomWithCaps(Vec<RelayEntry>)`，
       per-relay capability 注入 RelayMap（iroh 条目级 token）；旧
       `Custom(Vec<String>)` 保留
- [ ] 2.3 root 自签：Fabric 配置 restricted relay 时本地生成 own
       capability（caps 全位、TTL≤180d）
- [ ] 2.4 REDEEM_OK2 帧（0x15）：v2 令牌版本信号触发；payload = 名册
       dump + u32 前缀 capability 附发段（绑 redeemer，TTL≤90d）；v1
       令牌一律回旧 REDEEM_OK（兼容测试冻结）
- [ ] 2.5 napi SDK：RelayOptions 可选 `relays: {url, token?}[]`（双字段
       冲突显式报错）；relay 接入 `dweb/*` deny reason 透出为诊断事件
- [ ] 2.6 fabric/roster、fabric/session、sdk/node delta 随实现更新
       （初稿已产出，实现偏差回写 spec）
- [ ] 2.7 端到端：restricted server 上 invite v2→join（经 relay 拨号）→
       直连→relay fallback 全链路；老 SDK 连 restricted server 的可预期
       失败验证；老 SDK 解析 v2 invite 的错误路径验证

## Phase 3 — 运营面（另行排期）

- [ ] 3.1 admin API：server.key 签发的 admin token；registry 热加载
       与注册回执签名
- [ ] 3.2 per-owner 配额钩子（连接计数/端点数上限）与存量连接主动
       断连钩子评估（iroh-relay Clients 表可及性）
- [ ] 3.3 member capability 续期协议化评估（RENEW 消息 vs regular 会话
       重发的 MVP 语义固化）；`peer_scope` capability 扩展评估
- [ ] 3.4 多平台矩阵（darwin-arm64/windows-x64）与 Docker/compose
       配置文档更新
