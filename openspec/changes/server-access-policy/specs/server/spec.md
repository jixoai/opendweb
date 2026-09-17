## MODIFIED Requirements

### Requirement: relay 桥接

服务端 SHALL 运行 iroh relay（`iroh-relay` crate 的 server feature）：接受客户端的 relay 协议连接，端口拓扑 MUST 明确可配置——HTTP(S) 端口（relay 控制与 WebSocket 桥接）与 QUIC/UDP 端口分开配置。无 TLS 的本地/内网部署 SHALL 可用（明文 HTTP relay），生产部署的 TLS 终结职责 MUST 在文档中写明（反代终结 TCP/WS；QUIC 数据面需要原生证书或明确降级说明）。relay MUST NOT 能解密端到端会话内容。

服务端 SHALL 实现基于 access mode 的 relay 访问控制（见"Server 访问策略"）：默认 `open` 模式行为与无访问控制一致（AllowAll）；`restricted` 模式下每条客户端接入 MUST 通过 capability 验证链（见"relay capability 验证"）后才被注册。relay 仍不是 fabric 成员授权点：fabric 成员资格判定全部在端侧 roster；本访问控制仅限制 Server 基础设施的使用，其在 `restricted` 模式下的授权边界为 design.md §0 的形式化定义（经 relay 通信的端点属于 A(S)，callback 模式下另加 webhook 动态放行集合 A_cb(S)；`open` 模式不设此边界）。客户端 SHALL 能通过配置将本服务端指定为自定义 relay（含按 relay 携带 capability 凭证）并完成经 relay 的组网。

#### Scenario: 硬 NAT 双方经自托管 relay 组网

- **WHEN** 两节点直连不可达，均配置本服务端为 relay 且服务端为 `open` 模式
- **THEN** 两节点完成连接并交换消息，路径类型为 relay

#### Scenario: restricted 模式无凭证接入被拒

- **WHEN** 服务端为 `restricted` 且 `policy=static`，客户端未携带 capability 连接 relay
- **THEN** 接入被拒绝，拒绝原因经 relay 握手协议回传客户端（`dweb/no-capability`），连接不注册
- **注** `policy=callback` 时无凭证接入交 webhook 裁决（A_cb(S) 边界，见"动态策略回调"）

#### Scenario: 拒绝原因按失败环节区分（独立用例矩阵）

以下每个失败环节均为独立可构造用例，reason 互不相同：

- **WHEN** 令牌格式/长度/base64url 字符集非法 → **THEN** `dweb/malformed-capability`
- **WHEN** Authorization header 或 `?token=` 存在但为非 Bearer 形态/非法 UTF-8/非 `dwebr1.` 前缀（即"声明了凭证但不可解析"）→ **THEN** `dweb/malformed-capability`，该接入 MUST NOT 被归类为无票（无票路径仅限凭证完全缺失，防坏票混入 A_cb 动态名单）
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

服务端 SHALL 维护 owner registry（`<data_dir>/owners.jsonl`，append-only，register/unregister 事件归并出活跃集合）：每条记录为 `(fabric_id, root EndpointId)` 二元组。access mode 经 `--access-mode`（CLI）与 `DWEB_ACCESS_MODE`（env）与 config.toml `[server.access]` 配置（优先级 flag > env > config > default），取值 `open`（默认）或 `restricted`。`restricted` 模式下 L2 准入策略由 `policy` 配置项选择 provider：`static`（默认，无票必拒 + 有效票放行）或 `callback`（见"动态策略回调" requirement；`callback_url`/`callback_token` 必填，缺失时启动 fail-fast）。空 registry 语义按 policy 分裂：`static` + 空 registry MUST 拒绝一切 relay 接入（fail-closed）；`callback` + 空 registry = 一切票据被 L1b 拒绝，仅 webhook 放行的无票端点（A_cb(S)，identity-only 动态名单，admin 自担）可达。registry 变更 MUST 持久化并在重启后恢复，且 MUST 使缓存 generation+1（清空策略缓存）。registry 移除 Owner 的语义为：**新连接即时拒绝**（下次 on_connect 起 `dweb/unknown-owner`）；已建立的存量连接保持至自然断开或重连收敛（主动断连钩子不在本 change 承诺内）。Server Admin（本地配置管理者）与 Relay Owner（registry 内 fabric root）是不同身份；服务端 MUST NOT 提供 Owner 自助注册（注册是 Admin 动作）。

#### Scenario: 空 registry fail-closed（static）

- **WHEN** `restricted` 且 `policy=static` 且 registry 为空，任何客户端连接 relay
- **THEN** 全部接入被拒绝

#### Scenario: 空 registry 的 callback 模式为 identity-only

- **WHEN** `restricted` 且 `policy=callback` 且 registry 为空，无票端点连接 relay 且 webhook 返回 allow=true
- **THEN** 该端点接入成功（A_cb(S) 边界）；出示任何票据的端点均被 L1b 拒绝（`dweb/unknown-owner`）

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

### Requirement: relay capability 验证（L1 密码学完整性 + L1b 票有效性底线）

`restricted` 模式下，relay 的每条客户端接入若出示 capability，MUST 先通过不可绕过、不可插拔（与 policy provider 无关）的两级验证：**L1 密码学完整性**（本地、无网络调用，fail-closed 顺序执行）：长度门（≤1KiB）与 base64url 字符集白名单 → `dwebr1.` 格式与字段形状校验 → caps 位图无未知保留位 → issuer Ed25519 验签（域分隔 `dweb/relay-cap/v1`）→ server_id == 本服务端 ServerId → 时间校验（`now >= expires_at` 拒绝；`issued_at` 容忍 120s 时钟偏移；`issued_at <= expires_at`；TTL 验证侧统一上限 180 天）→ recipient == iroh-relay 握手认证的 endpoint_id。**L1b 票有效性底线**：(fabric_id, issuer) ∈ owner registry 活跃集合 → caps 含当前操作所需位（relay 接入需 RELAY）。两级验证均须在接入注册前完成、在任何策略 provider 决策（含 callback webhook）之前完成——策略层只能收紧不能放宽（无效票据 MUST 在到达 webhook 前被拒）。L1 计算成本为 O(1) + 单次验签。capability 是身份绑定凭证而非纯 bearer：仅持有令牌串而无对应私钥者在 relay 面与 rendezvous announce 面 MUST 被拒绝。

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

`restricted` 模式且 `policy = "callback"` 时，relay 接入的 L2 准入决策 MUST 经 HTTP webhook 外部化。**事件范围仅 relay 面**（event ∈ relay.connect / relay.disconnect）；rendezvous 不接入 callback（其 HTTP 面无握手身份，动态策略另立 change，本 change rendezvous 维持静态 ACL）。webhook 请求以 Bearer `callback_token` POST 已验证的 AuthContext（endpoint_id 为握手认证身份；capability 为已过 L1+L1b 的有效票结构化投影，不含令牌原文/签名；connection_id 关联生命周期）到 `callback_url`，请求/响应体 ≤4KiB，按 200 响应的 `allow` 布尔值决定准入。**webhook MUST NOT 能豁免 L1/L1b**：无效票据（含缺所需 caps 位、未注册 owner）在到达 webhook 前已被拒。无 capability 的接入交给 webhook 裁决，其可达集合为独立定义的动态名单边界 A_cb(S)（admin 自担责任；webhook 对无票端点一律拒绝时 A_cb(S) 为空、行为与 static 一致）。fail-closed 恒定不可配置宽松：非 200 / 3xx 重定向 / 超时（默认与硬上限均 2000ms）/ 响应解析失败 / 缺 `allow` 或非布尔 / body 超限 / 并发超限 → 拒绝并返回 `dweb/policy-unavailable`（deny 结果同样入缓存）。**并发防护**：per-key singleflight、全局并发上限（默认 64）、每来源在途上限（默认 16）、有界等待队列（默认 256，队满即拒）。**缓存**：键 = (registry_generation, endpoint_id, BLAKE3(capability canonical 投影), event)；registry 变更即 generation+1 并清空全部缓存；TTL = min(响应 `cache_ttl_s`（非法值按 0 不缓存）, `callback_cache_ttl_ms` 上限 60s)；缓存仅作用于新连接准入，不作为存量连接撤销机制。**传输边界**：生产强制 https（`allow_loopback_callback` 显式豁免 loopback）；解析后拒绝私网（RFC1918/ULA）/link-local/云 metadata 网段；不跟随重定向；callback_token 日志全程脱敏。**reason 语法**：`dweb/[a-z0-9][a-z0-9._-]{0,63}`，非法值（含控制字符/非 ASCII/超长/空）替换为 `dweb/policy-denied`。**relay.disconnect 为 best-effort 观察通知**：fire-and-forget、不重试、允许丢失，MUST NOT 作为配额或撤销依据。callback 配置（url/token）缺失或非法时启动 fail-fast。

#### Scenario: webhook 允许即接入

- **WHEN** policy=callback，webhook 对 (endpoint_id, capability, relay.connect) 返回 allow=true
- **THEN** 接入成功；同键后续接入在缓存 TTL 内不再回调

#### Scenario: webhook 拒绝并透出自定义 reason

- **WHEN** webhook 返回 allow=false, reason="dweb/quota-exceeded"
- **THEN** 接入被拒，客户端收到 deny reason `dweb/quota-exceeded`

#### Scenario: 非法 reason 被替换

- **WHEN** webhook 返回的 reason 含控制字符/非 ASCII/超长/不合 slug 语法
- **THEN** 接入被拒，reason 替换为 `dweb/policy-denied`

#### Scenario: 无效票据不触发 webhook（L1/L1b 不豁免）

- **WHEN** 端点出示缺 RELAY 位、或 issuer 未注册、或签名/时间/recipient 任一不过的 capability，policy=callback
- **THEN** 接入被拒（对应 `dweb/caps-missing-relay` / `dweb/unknown-owner` / L1 对应 reason），webhook 未被调用

#### Scenario: webhook 失联 fail-closed

- **WHEN** callback_url 不可达、返回非 200/3xx、超时（≤2000ms）、响应缺 allow 字段或 body 超限
- **THEN** 接入被拒（`dweb/policy-unavailable`），deny 结果同样进入缓存

#### Scenario: 无票端点经 webhook 准入（A_cb(S) 动态名单）

- **WHEN** 端点未携带 capability，webhook 对该 endpoint_id 返回 allow=true
- **THEN** 接入成功（A_cb(S) 边界内）；出示伪造票据的端点仍被密码学层拒绝

#### Scenario: registry 变更即时清缓存（unregistered 票据不再回调）

- **WHEN** owner 被 unregister 后，其名下已缓存的票据再次接入（缓存 TTL 未到期）
- **THEN** 缓存已被 generation+1 失效；接入由 L1b 直接拒绝（`dweb/unknown-owner`），webhook 调用计数为 0（无效票据不触发 webhook）

#### Scenario: registry 变更后有效 key 产生新回调

- **WHEN** registry 发生任何变更（generation+1）后，一个仍有效票据或无票 A_cb key 再次接入
- **THEN** 旧缓存不命中，产生一次新回调并按其结果准入

#### Scenario: 并发风暴防护

- **WHEN** 同键并发 miss 或全局/来源并发超限、等待队列耗尽
- **THEN** 同键仅发一次回调（singleflight）；超限请求被拒（`dweb/policy-unavailable`），relay executor 不被拖垮

#### Scenario: SSRF 边界

- **WHEN** callback_url 指向私网/link-local/metadata 地址或返回重定向，且未设置 loopback 豁免
- **THEN** 按失联处理（`dweb/policy-unavailable`）；不跟随重定向、不发送 token 到其它 origin

#### Scenario: disconnect 生命周期事件

- **WHEN** 一条已准入连接断开
- **THEN** Server 向 webhook 发送 relay.disconnect 事件（best-effort，不阻塞不重试），携带对应 connection_id；事件丢失不影响准入与撤销语义

#### Scenario: Visitor 无法为授权集合外端点提供中继

- **WHEN** 持有效 capability 的 Visitor 试图让无 capability 的第三方 peer 经本 relay 与任意端点通信，且服务端为 `policy=static`（或 `policy=callback` 且 webhook 对该第三方无票接入返回 deny）
- **THEN** 第三方 peer 自身的接入在验证链（或 webhook）被拒；relay 投递目的地只能是在线已接入 client，可达边界（A(S)，callback 模式为 A(S) ∪ A_cb(S)）之外的端点经本 Server 零可达

### Requirement: rendezvous 访问控制

`restricted` 模式下，rendezvous announce 与 resolve MUST 要求 capability（HTTP `Authorization: Bearer dwebr1.…`），且出示的 capability MUST 通过与 relay 面同一套不可绕过验证器（L1 密码学完整性 + L1b 票有效性底线：registry 二元组等，各失败 reason 一致映射为 HTTP 401 响应体 `{"error":"dweb/<reason>"}`；"存在但非法"的凭证同样不得按无票处理）。announce：capability 的 caps MUST 含 RDZ_ANNOUNCE，且 **capability.recipient MUST == announce 请求体中签名的 EndpointId**（既有签名验证保留，签名私钥即 PoP，窃取 capability 者无法以他人身份登记）；不满足返回 401。resolve：caps MUST 含 RDZ_RESOLVE，为 **bearer-only 语义**（无 HTTP 面身份证明，capability 泄露即可用直至 TTL，属明示的降级承诺；L1 的 recipient==握手身份检查在 resolve 面不适用——无握手身份，仅验密码学有效性）；不满足返回 401。rendezvous 不接入 callback webhook（动态策略另立 change）。`open` 模式下 announce/resolve 行为与现状一致（签名 announce / 匿名 resolve）。

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
