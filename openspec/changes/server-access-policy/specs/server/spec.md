## MODIFIED Requirements

### Requirement: relay 桥接

服务端 SHALL 运行 iroh relay（`iroh-relay` crate 的 server feature）：接受客户端的 relay 协议连接，端口拓扑 MUST 明确可配置——HTTP(S) 端口（relay 控制与 WebSocket 桥接）与 QUIC/UDP 端口分开配置。无 TLS 的本地/内网部署 SHALL 可用（明文 HTTP relay），生产部署的 TLS 终结职责 MUST 在文档中写明（反代终结 TCP/WS；QUIC 数据面需要原生证书或明确降级说明）。relay MUST NOT 能解密端到端会话内容。

服务端 SHALL 实现基于 access mode 的 relay 访问控制（见"Server 访问策略"）：默认 `open` 模式行为与无访问控制一致（AllowAll）；`restricted` 模式下每条客户端接入 MUST 通过 capability 验证链（见"relay capability 验证"）后才被注册。relay 仍不是 fabric 成员授权点：fabric 成员资格判定全部在端侧 roster；本访问控制仅限制 Server 基础设施的使用，其授权边界为 design.md §0 的 A(S) 形式化定义（经 relay 通信的端点恒属于授权接入集合）。客户端 SHALL 能通过配置将本服务端指定为自定义 relay（含按 relay 携带 capability 凭证）并完成经 relay 的组网。

#### Scenario: 硬 NAT 双方经自托管 relay 组网

- **WHEN** 两节点直连不可达，均配置本服务端为 relay 且服务端为 `open` 模式
- **THEN** 两节点完成连接并交换消息，路径类型为 relay

#### Scenario: restricted 模式无凭证接入被拒

- **WHEN** 服务端为 `restricted` 模式，客户端未携带 capability 连接 relay
- **THEN** 接入被拒绝，拒绝原因经 relay 握手协议回传客户端（`dweb/no-capability`），连接不注册

#### Scenario: 拒绝原因按失败环节区分（独立用例矩阵）

以下每个失败环节均为独立可构造用例，reason 互不相同：

- **WHEN** 令牌格式/长度/base64url 字符集非法 → **THEN** `dweb/malformed-capability`
- **WHEN** caps 位图含未知保留位 → **THEN** `dweb/caps-unsupported`
- **WHEN** 签名与 issuer 公钥不匹配（篡改任一字段）→ **THEN** `dweb/bad-signature`
- **WHEN** issuer 的 (fabric_id, root) 二元组不在 registry 活跃集合 → **THEN** `dweb/unknown-owner`
- **WHEN** server_id 与本服务端不符 → **THEN** `dweb/wrong-server`
- **WHEN** recipient 与握手认证 endpoint_id 不匹配 → **THEN** `dweb/not-recipient`
- **WHEN** caps 缺 RELAY 位（仅含 RDZ_* 的令牌连 relay）→ **THEN** `dweb/caps-missing-relay`

## ADDED Requirements

### Requirement: Server 身份与持久化

服务端 SHALL 在数据目录维护持久化身份：`<data_dir>/server.key`（32B Ed25519 seed，权限 0600，tmp+fsync+rename 原子写，load-or-create 幂等）。ServerId（对应公钥）SHALL 作为服务自标识在 `services.json` 中发布（字段只增，既有字段语义不变；`packages/server-binary` 的清单断言测试同步更新）。server.key MUST NOT 用于签发 relay capability（capability 只能由注册 Owner 的 root 私钥签发）；MUST NOT 使服务端获得任何 fabric 语义。`restricted` 模式下若配置了 relay QUIC bind（QAD 地址发现服务，无访问控制钩子），服务端 MUST 以 fail-fast 拒绝启动并输出明确错误（防未授权地址探测/隐私泄漏面），不得降级为静默禁用。

#### Scenario: 首次启动生成身份

- **WHEN** 数据目录为空启动服务端
- **THEN** 生成 `server.key`（0600），`services.json` 发布稳定 ServerId；重启后 ServerId 不变

#### Scenario: restricted 与 QAD 组合 fail-fast

- **WHEN** `restricted` 模式且配置了 relay QUIC bind 启动服务端
- **THEN** 启动以非零退出码失败并输出含 QAD 字样的错误信息

### Requirement: Server 访问策略（owner registry 与 access mode）

服务端 SHALL 维护 owner registry（`<data_dir>/owners.jsonl`，append-only，register/unregister 事件归并出活跃集合）：每条记录为 `(fabric_id, root EndpointId)` 二元组。access mode 经 `--access-mode`（CLI）与 `DWEB_ACCESS_MODE`（env）与 config.toml `[server.access]` 配置（优先级 flag > env > config > default），取值 `open`（默认）或 `restricted`。`restricted` 模式下 L2 准入策略由 `policy` 配置项选择 provider：`static`（默认，owner registry 二元组 + 所需 caps 位）或 `callback`（见"动态策略回调" requirement；`callback_url`/`callback_token` 必填，缺失时启动 fail-fast）。`restricted` + `static` + 空 registry MUST 拒绝一切 relay 接入（fail-closed）。registry 变更 MUST 持久化并在重启后恢复。registry 移除 Owner 的语义为：**新连接即时拒绝**（下次 on_connect 起 `dweb/unknown-owner`）；已建立的存量连接保持至自然断开或重连收敛（主动断连钩子不在本 change 承诺内）。Server Admin（本地配置管理者）与 Relay Owner（registry 内 fabric root）是不同身份；服务端 MUST NOT 提供 Owner 自助注册（注册是 Admin 动作）。

#### Scenario: 空 registry fail-closed

- **WHEN** `restricted` 模式且 registry 为空，任何客户端连接 relay
- **THEN** 全部接入被拒绝

#### Scenario: registry 持久化

- **WHEN** 注册 owner 后重启服务端
- **THEN** registry 活跃集合恢复，已注册 owner 签发的有效 capability 仍可通过验证链

#### Scenario: 配置优先级

- **WHEN** 同一配置项在 CLI flag、环境变量、config.toml 中同时以不同值出现
- **THEN** 生效值为 CLI flag > env > config.toml > default

#### Scenario: unregister 阻断新连接

- **WHEN** 某 owner 被 unregister 后，其名下已签发的 capability 再次用于新连接
- **THEN** 新连接被拒（`dweb/unknown-owner`）；（存量连接语义见 requirement 正文）

#### Scenario: 二元组精确匹配

- **WHEN** registry 中有 (fabric_A, root_X)，而 capability 的 (fabric_id, issuer) 为 (fabric_B, root_X)
- **THEN** 接入被拒（`dweb/unknown-owner`）

### Requirement: relay capability 验证（L1 密码学层）

`restricted` 模式下，relay 的每条客户端接入 MUST 先通过 L1 本地密码学验证（不可绕过、不可插拔、无网络调用，fail-closed 顺序执行，仅当出示了 capability 时）：长度门（≤1KiB）与 base64url 字符集白名单 → `dwebr1.` 格式与字段形状校验 → caps 位图无未知保留位 → issuer Ed25519 验签（域分隔 `dweb/relay-cap/v1`）→ server_id == 本服务端 ServerId → 时间校验（`now >= expires_at` 拒绝；`issued_at` 容忍 120s 时钟偏移；`issued_at <= expires_at`；TTL 验证侧统一上限 180 天）→ recipient == iroh-relay 握手认证的 endpoint_id。L1 全过后进入 L2 策略决策（"Server 访问策略"/"动态策略回调" requirements）。验证 MUST 在接入注册前完成，L1 计算成本为 O(1) + 单次验签。capability 是身份绑定凭证而非纯 bearer：仅持有令牌串而无对应私钥者在 relay 面与 rendezvous announce 面 MUST 被拒绝。

#### Scenario: 窃取令牌串不可用（relay 面）

- **WHEN** 攻击者窃取 capability 串并从自己的 endpoint 连接 relay
- **THEN** recipient 与握手认证 id 不匹配，接入被拒（`dweb/not-recipient`）

#### Scenario: 跨 Server 重放被拒

- **WHEN** 为 Server A 签发的 capability 出示给 Server B
- **THEN** server_id 不匹配，接入被拒（`dweb/wrong-server`）

#### Scenario: 过期拒绝含等值边界

- **WHEN** 当前时间 == capability 的 expires_at
- **THEN** 接入被拒（`dweb/capability-expired`）

#### Scenario: 超长 TTL 被拒

- **WHEN** capability 的 expires_at - issued_at 超过 180 天统一上限
- **THEN** 接入被拒（`dweb/capability-expired`）

#### Scenario: 过大的未来签发时间被拒

- **WHEN** capability 的 issued_at 超过当前时间 + 120s 时钟偏移容忍
- **THEN** 接入被拒（`dweb/capability-expired`）

#### Scenario: issued_at 晚于 expires_at 被拒

- **WHEN** capability 的 issued_at > expires_at（自相矛盾的时间字段）
- **THEN** 接入被拒（`dweb/capability-expired`）

### Requirement: 动态策略回调（callback policy provider）

`restricted` 模式且 `policy = "callback"` 时，L2 准入决策 MUST 经 HTTP webhook 外部化：Server 以 Bearer `callback_token` POST 已验证的 AuthContext（event ∈ relay.connect/rendezvous.announce/rendezvous.resolve/relay.disconnect；endpoint_id 为握手认证身份；capability 为 L1 验签后的结构化投影，不含令牌原文/签名；connection_id 关联生命周期）到 `callback_url`，按 200 响应的 `allow` 布尔值决定准入。fail-closed 恒定：非 200 / 超时（`callback_timeout_ms`，配置上限 2000ms）/ 响应解析失败 MUST 拒绝并返回 `dweb/policy-unavailable`（此行为 MUST NOT 可配置为宽松）。自定义拒绝 `reason` MUST 校验 `dweb/` 前缀，非法值替换为 `dweb/policy-denied`。决策结果 MUST 按 (endpoint_id, capability 内容哈希, event) 缓存，TTL 取响应携带值与 `callback_cache_ttl_ms`（默认 30s、上限 60s）的较小者。webhook 无法豁免 L1：伪造/转借/过期的 capability 在密码学层已拒。无 capability 的接入（AuthContext.capability == null）交给 webhook 裁决（admin 可实现基于 EndpointId 的动态准入名单）。

#### Scenario: webhook 允许即接入

- **WHEN** policy=callback，webhook 对 (endpoint_id, capability, relay.connect) 返回 allow=true
- **THEN** 接入成功；同键后续接入在缓存 TTL 内不再回调

#### Scenario: webhook 拒绝并透出自定义 reason

- **WHEN** webhook 返回 allow=false, reason="dweb/quota-exceeded"
- **THEN** 接入被拒，客户端收到 deny reason `dweb/quota-exceeded`

#### Scenario: 非法 reason 被替换

- **WHEN** webhook 返回 allow=false 且 reason 不带 dweb/ 前缀
- **THEN** 接入被拒，reason 替换为 `dweb/policy-denied`

#### Scenario: webhook 失联 fail-closed

- **WHEN** callback_url 不可达或超时（≤2000ms）
- **THEN** 接入被拒（`dweb/policy-unavailable`），deny 结果同样进入缓存

#### Scenario: 无票端点经 webhook 准入

- **WHEN** 端点未携带 capability，webhook 对该 endpoint_id 返回 allow=true
- **THEN** 接入成功（动态名单语义）；L1 不受影响——出示伪造票据仍被密码学层拒绝

#### Scenario: disconnect 生命周期事件

- **WHEN** 一条已准入连接断开
- **THEN** Server 向 webhook 发送 relay.disconnect 事件（fire-and-forget，不阻塞不重试），携带对应 connection_id

#### Scenario: 缓存 TTL 生效

- **WHEN** 同一 (endpoint_id, capability, event) 在缓存 TTL 内再次接入
- **THEN** 不产生新的 webhook 调用，决策沿用缓存结果

#### Scenario: Visitor 无法为授权集合外端点提供中继

- **WHEN** 持有效 capability 的 Visitor 试图让无 capability 的第三方 peer 经本 relay 与任意端点通信
- **THEN** 第三方 peer 自身的接入在验证链被拒；relay 投递目的地只能是在线已接入 client，授权集合外端点经本 Server 零可达

### Requirement: rendezvous 访问控制

`restricted` 模式下，rendezvous announce 与 resolve MUST 要求 capability（HTTP `Authorization: Bearer dwebr1.…`）。announce：capability 的 caps MUST 含 RDZ_ANNOUNCE，且 **capability.recipient MUST == announce 请求体中签名的 EndpointId**（既有签名验证保留，签名私钥即 PoP，窃取 capability 者无法以他人身份登记）；不满足返回 401。resolve：caps MUST 含 RDZ_RESOLVE，为 **bearer-only 语义**（无 HTTP 面身份证明，capability 泄露即可用直至 TTL，属明示的降级承诺）；不满足返回 401。`open` 模式下 announce/resolve 行为与现状一致（签名 announce / 匿名 resolve）。

#### Scenario: restricted 下匿名 resolve 被拒

- **WHEN** `restricted` 模式下无 capability 的 GET /rendezvous/{id}
- **THEN** 返回 401，不返回任何登记项

#### Scenario: announce 的身份绑定校验

- **WHEN** `restricted` 模式下持 A 的 capability 但以 B 的私钥签名 announce
- **THEN** 返回 401（recipient ≠ 签名 EndpointId），不产生登记项

#### Scenario: announce 缺 RDZ_ANNOUNCE 位

- **WHEN** capability caps 仅含 RELAY，用于 announce
- **THEN** 返回 401

#### Scenario: resolve 缺 RDZ_RESOLVE 位

- **WHEN** `restricted` 模式下持仅含 RELAY 位的 capability 执行 GET /rendezvous/{id}
- **THEN** 返回 401，不返回任何登记项

#### Scenario: open 模式现状不变

- **WHEN** `open` 模式下匿名 resolve
- **THEN** 行为与本变更前一致

### Requirement: relay 资源限流

服务端 SHALL 接线 iroh-relay 1.1.0 **已实现**的限流能力：`client_rx` 客户端接收字节率（`[server.access] limits` 配置透传）。连接数类限额（accept_conn_limit/accept_conn_burst）上游标注未实现，本 change MUST NOT 承诺；per-owner 连接计数配额列为 Phase 3 钩子。限流语义 MUST 与 access mode 正交（open 模式下同样生效）。

#### Scenario: client_rx 限流独立生效

- **WHEN** `open` 模式且配置 client_rx 限额，单客户端发送速率超限
- **THEN** relay 按 iroh-relay 限流语义节流该客户端，与 capability 验证无关
