# server-access-policy R3 终审复核

复核边界：本报告针对 `server-access-policy` change 的设计阶段复核，基线为
`main@ae271cf`，R1=`fd6f8db`、R2=`69dbe29`、R3=`6be4408`。R3 在工作树中
只新增/修改 OpenSpec 文档，`tasks.md` 的实现任务仍未勾选；因此下文的
“闭合”是协议/设计闭合，不是实现验收。

## R2 悬置项闭合核验

**P0-1 / P0-2 / P0-N2：产品语义已由 Owner 裁决闭合。**

- `requirements.md:6-17` 记录了 2026-09-17 的原始意图和明确裁决：采用
  共享接入语义，同一 Owner 名下的 Owner/Visitor 端点允许经 relay 互连；
  严格的 Owner-Visitor 配对语义不再作为本 change 的要求。
- `design.md:42-77` 将该裁决提升为规范基线，并解释了 iroh-relay 只有
  接入粒度 hook、没有 per-destination 授权点（`iroh-relay` 的
  `server.rs:285-305`）。因此 R2 中“是否允许同 Owner 端点互连”不再是
  技术缺口，而是已经作出的产品选择。
- `design.md:26-37` 把受限模式的边界形式化为 `A(S)`，并把“集合外端点
  零可达”作为滥用边界；这与共享接入裁决相容。R3 不能再以 Visitor 之间
  经 relay 互连本身作为 P0。

**R2 新发现项抽查。**

- **P0-N1：基本闭合，但有一处措辞回归。** `design.md:21-23` 明确 `A(S)`
  只对 `restricted` 生效，`open` 保持 AllowAll；然而
  `specs/server/spec.md:7` 仍使用“经 relay 的端点恒属于授权接入集合”的
  无条件表述。按上下文可推断它指 restricted，但文字没有带限定，可能使
  `open` 模式与形式化定义产生歧义。建议把该句改为“在 restricted 模式下，
  经 relay 的端点恒属于 `A(S)`”，并在 spec 中保留 open 的现状语义。
- **P1-N1：已闭合。** `design.md:26-30` 和 `design.md:410-411` 冻结了
  on_connect 时点快照：Owner 移除/票据过期即时影响新连接，存量连接保持
  至自然断开或重连；这与 iroh-relay 的 `OnDisconnectGuard`
  （`server.rs:360-374`）生命周期相符。主动踢出存量连接仍被明确留到后续
  change，不能在本轮声称已经实现。
- **P1-N2：协议格式闭合。** R2 的附录 A2 已补入 REDEEM_OK2 的帧号、长度
  前缀、兼容矩阵和 v1/v2 行为约束；`tasks.md:2.1-2.4` 将其拆成可实现的
  编解码、recipient、TTL 和旧客户端错误路径。仍须由实现阶段的 wire fixture
  验证，文档闭合不等于字节级实现已通过。
- **P1-N3：拒绝原因矩阵已独立化。** `specs/server/spec.md:19-31` 为
  malformed、保留位、签名、unknown-owner、wrong-server、not-recipient、
  caps-missing-relay 分别冻结 reason；R3 又为 callback 增加了
  `policy-unavailable` 和自定义 reason 场景。原 R2 的“失败环节互相覆盖”
  问题已在规范层解决，但 callback 的非法响应分支仍不完整，见下文 C。

结论：R2 的三个悬置 P0 已因 Owner 裁决合理闭合；R2 的 P1 项基本完成文档
收口。唯一残留是 `spec.md:7` 的 restricted 限定缺失，应在实现前修正文案。
该残留不是 Owner 语义重新悬置，而是规范文字回归。

## 新扩展（L1/L2 + callback）安全审查

### A. L1 不可绕过性（iroh-relay 注册路径是否唯一经 on_connect）

**已核实的生产路径。**

- `iroh-relay` 的 `RelayConfig.access` 是 `Arc<dyn DynAccessControl>`
  （`server.rs:145-146`）。HTTP WebSocket 握手先完成客户端公钥认证，再由
  `http_server.rs:868-878` 构造已绑定认证身份的 `ClientRequest`。
- `protos/handshake.rs:480-505` 的 `authorize_with` 调用
  `access_control.on_connect(request).await`，只有得到 `Access::Allow` 才创建
  `OnDisconnectGuard` 并发送确认帧；随后 `http_server.rs:894-898` 才调用
  `Clients::register`。因此标准 `Server::spawn`/`RelayService` HTTP relay
  路径中，注册前的 on_connect 顺序成立。
- `ClientRequest::new` 的 endpoint id 来自已完成的 relay 握手
  （`server.rs:185-200`）；`on_disconnect` 通过同一 guard 回调
  （`server.rs:285-305、360-374`）。这支持 R3 的 C7 recipient 绑定和连接
  生命周期关联。

**P1-A1： “唯一注册路径”不能对整个 crate API 绝对化。**

- `server/clients.rs:50-105` 的 `Clients::register` 是公开 API，调用者只需
  自行构造 `Config`/`OnDisconnectGuard` 即可注册；上游文档明确 embedders
  负责自行构造 guard。`handshake.rs` 另提供 `authorize_if`（同文件约
  `:510-540`），调用者可以在不走 `authorize_with` 的情况下直接完成握手授权。
- 这不是当前 dweb-server 的已知生产旁路：`crates/dweb-server/src/relay.rs:15-50`
  只通过 `Server::spawn` 装配 relay。但 R3 对 L1 使用了“不可绕过/唯一注册
  路径”的绝对措辞，未写明这是 stock server 装配边界，未来嵌入式装配很容易
  误接 `register` 或 `authorize_if`。

可验证修复建议：在设计中把安全不变量限定为“本项目的 Server/RelayService
装配只能经 `authorize_with` 后注册”，并增加一个集成断言覆盖 HTTP 与启用的
其它 relay 入口；若需要支持 embedders，封装/限制 `Clients::register`，或要求
调用者显式提供已完成 L1/L2 的 admission proof。对 QAD/地址发现这类没有
AccessControl hook 的入口继续保持 `restricted + QAD` 启动 fail-fast，不能
把它写成普通 relay ACL 已覆盖。

### B. CallbackProvider 安全

**P0-B1：Callback 模式可绕过 capability 的最小权限和 `A(S)` 定义。**

现象：R3 把 caps 位、owner registry 和所需操作位放在
`StaticRegistryProvider`；`design.md:440-464` 明确 token 缺失时跳过 L1，
CallbackProvider 只把 `AuthContext` 交 webhook 决定。`requirements.md:112`
以及 `specs/server/spec.md` 的“无票端点经 webhook 准入”场景允许 webhook
对任意已握手 EndpointId 返回 allow=true；同理，拥有有效签名但缺少 RELAY
位、或 issuer 不在 registry 的 capability，在 callback 分支没有规范化的
不可绕过拒绝点。

影响：

- callback 可以把“缺少 RELAY 能力”的票据升级成 relay 准入，破坏原十步链的
  最小权限和 `caps-missing-relay` 保证；
- callback 可以把不属于 `A(S)` 的无票 EndpointId 动态放行，因而 R3 的
  `A(S)` 不再是原定义的“注册 Owner capability 集合”；只要 callback 管理
  端被误配置或被滥用，Server 就能变成对任意 endpoint 开放的通用 relay。
  这与 Owner“只服务自家业务、使用门槛动态可配”的目标并非逻辑必然冲突，
  但必须明确这是一个新的 identity-only 动态名单语义，而不是继续声称原
  `A(S)` 安全边界成立。

可验证修复建议：

1. 对出示 capability 的请求，无论 provider 为何，L1/L2 之间保留不可绕过
   的安全下限：签名、server_id、时间、recipient、issuer registry（若仍以
   `A(S)` 为定义）及当前操作所需 caps 位；callback 只能收紧，不得升级。
2. 若产品确实需要无票动态名单，新增显式的 `identity-only`/`callback`
   admission 模式，给出新的 `A_callback(S)` 定义、按操作的 allowlist、审计
   和配额边界；不要把它混写进 capability 模式。relay、announce、resolve
   分别定义允许的 identity 来源。
3. 为“有效票但缺 RELAY/unknown-owner 时 callback 是否被调用”冻结负向协议
   场景，并要求实现证明 callback 不能豁免 L1 安全下限。

**P0-B2：rendezvous 的 callback 身份上下文不可按当前协议直接成立。**

`design.md:421-426` 已承认 HTTP rendezvous 没有 iroh 握手身份；announce
的可信身份来自请求体中的 EndpointId 签名，resolve 是 bearer-only，根本没有
请求方身份。可是 `requirements.md:112` 的 callback AuthContext 统一规定
`endpoint_id` 为“握手认证身份”，并将 `rendezvous.announce`、
`rendezvous.resolve` 与 relay.connect 放在同一 event 集合中。

这会产生两个未定义且可能不安全的实现：announce 若填 HTTP 连接的匿名/代理
身份，策略可能对错误主体授权；resolve 若填 capability recipient，则它实际
是 bearer 投影，若填 null，callback 又无法做逐主体名单。当前
`crates/dweb-server/src/rendezvous.rs:124-201` 也证明 announce/resolve 是
独立 HTTP 路由，没有 relay handshake 可复用。

可验证修复建议：为 HTTP 面定义单独的 `PolicyContext`：announce 使用“签名
EndpointId + 已验证 capability.recipient”，resolve 明确 `requester=None`
或明确以 capability recipient 作为 bearer principal；分别冻结泄露和审计语义。
更保守的方案是本 change 只把 callback 接到 relay.connect/disconnect，
rendezvous 继续静态 ACL，待身份模型另立 change。

**P1-B3：callback 超时和缓存不足以防并发风暴。**

设计只规定超时硬上限 2s、缓存 TTL 上限 60s（`design.md:461-464、
requirements.md:112`），没有 in-flight singleflight、并发上限、有界队列、
每 endpoint/IP/连接尝试限流或 circuit breaker。同一缓存键在并发 miss 时可以
同时发起大量 webhook 请求；`client_rx` 限流发生在连接注册后的数据面，不能
保护 on_connect 的握手和 callback 压力。

可验证修复建议：对每个键做 singleflight，并设置全局/每来源 semaphore 和
有界排队；超限立即返回 `dweb/policy-unavailable`，可加短暂 fail-closed
熔断。为“callback 风暴不耗尽 relay executor”增加并发压力和超时测试。

**P1-B4：缓存规范存在 TOCTOU 和陈旧策略窗口。**

现象：缓存键写作 `(endpoint_id, capability 内容哈希, event)`，但没有冻结
hash 算法、canonical 输入、截断长度，也没有正式定义响应 `cache_ttl` 的
JSON schema、零/负数/浮点/超大值处理。allow/deny 的 TTL 允许最长 60s；
registry 或 callback 策略撤销后没有版本号/主动失效规则。无票准入尤其可能在
名单撤销后继续生效至缓存到期。

可验证修复建议：冻结完整的 SHA-256/BLAKE3 digest 和结构化 canonical 投影；
响应只接受有界整数 `0..min(server_ttl,60s)`，定义 TTL=0 为不缓存；将策略版本、
registry generation 或撤销 epoch 纳入键并在变更时清空相关条目；明确 deny/allow
各自最大陈旧窗口及时间基准。连接 admission 不得把 callback 缓存当作撤销
存量连接的安全机制。

**P1-B5：SSRF、重定向和 callback token 暴露边界未冻结。**

`design.md:520-597` 只把 `callback_url` 描述为 admin 配置，TLS 仍是建议，
没有 HTTPS scheme 强制、localhost/私网/云元数据地址拒绝、DNS rebinding
处理、重定向策略、请求/响应大小上限或代理日志卫生。若 HTTP client 跟随
重定向，Bearer `callback_token` 是否发送到新 host 未定义；错误日志/trace
也可能泄露 token。

可验证修复建议：生产模式强制 HTTPS（开发 loopback 需显式开关）；解析后拒绝
loopback、link-local、RFC1918/ULA、metadata 网段并防 DNS rebinding；默认不跟随
重定向，若必须跟随则跨 origin 丢弃 Authorization；限制 body/header 大小，
token 仅从 secret store 读取并做日志脱敏；增加恶意 URL、重定向和私网解析的
负向测试。若要更高保证，增加 mTLS 或签名响应。

**P1-B6：reason 白名单只有前缀检查。**

`design.md:548-557`、`requirements.md:112` 只要求 `dweb/` 前缀。这样可传入
控制字符、超长字符串、换行或日志注入内容；它们还会进入 iroh-relay 的 deny
帧和服务端日志。

可验证修复建议：冻结 ASCII slug 语法（例如
`dweb/[a-z0-9][a-z0-9._-]{0,63}`），拒绝控制字符和非 ASCII，超过长度或非法
值统一替换为 `dweb/policy-denied`，并测试 CR/LF、空串、超长和 Unicode。

**P1-B7：disconnect fire-and-forget 的一致性边界不足。**

上游 `on_disconnect` 是同步、带 `endpoint_id` 和 `connection_id` 的一次回调
（`server.rs:295-305`）；R3 callback 规定事件异步、丢失不重试。设计没有说明
provider 如何保存每条 connection 的 capability/context、同 endpoint 多连接
如何去重、事件乱序/进程重启如何处理，也没有声明 callback 不能作为硬配额或
撤销依据。

可验证修复建议：把事件明确标为 best-effort 观察通知；若运营配额依赖它，使用
带 event id、connection id、generation 的可重放有界队列和接收方幂等，而不是
fire-and-forget；增加重复断开、旧连接先于新连接断开、进程崩溃的测试。存量
连接撤销继续由 on_connect/自然断开语义承担。

### C. spec“动态策略回调”可测性

当前 7 个 scenario（allow、deny+reason、非法 reason、失联 fail-closed、
无票准入、disconnect、TTL）覆盖了基本 happy path 和故障 path，但不足以证明
安全契约。至少缺少以下可独立构造的场景：

- callback 永不应豁免的 L1 负例：格式非法、签名错误、未知 caps、wrong-server、
  过期、recipient 不匹配、缺 RELAY 位、unknown-owner；并断言 webhook 是否
  被调用以及最终 reason。
- HTTP 401/403/500、非 JSON、缺少 `allow`、`allow` 非布尔、未知字段、超大
  body、连接建立后读超时和精确 2000ms 边界；每类均应得到
  `dweb/policy-unavailable` 且按约定决定是否缓存。
- 缓存键隔离：endpoint、capability 内容、event 任一变化都不能命中旧结果；
  TTL=0、TTL 大于 60s、负数/浮点、过期瞬间、策略/registry 版本变化时的失效。
- 并发 miss 的 singleflight、全局/来源限流、队列耗尽和 callback 恢复后的熔断
  行为。
- HTTPS/私网/localhost、DNS rebinding、重定向跨 origin 以及 token 不外泄；
  reason 的 CR/LF、控制字符、超长和 Unicode。
- rendezvous announce/resolve 各自的 AuthContext 身份投影，尤其是 resolve
  无请求方身份时的策略结果；disconnect 重复、乱序、重启和多连接 cardinality。

可验证修复建议：把上述分支加入 `specs/server/spec.md` 的独立 scenario 和
`tasks.md:1.5b/1.9` 的验收矩阵，给 callback 请求/响应定义精确 JSON schema、
大小、字段未知处理、重定向和缓存头语义。没有这些负例，严格 OpenSpec 结构
校验即使通过，也不能证明 callback 安全。

## 遗漏与回归

1. **设计与实现状态分离。** `crates/dweb-server/src/relay.rs:15-50` 仍创建
   `RelayServerConfig::new`，保持 `tls=None`，没有设置 `access`、owner registry、
   PolicyProvider 或 `client_rx`；`main.rs:241-251` 也没有 access-mode/policy
   解析。`tasks.md:1.1-1.9`（含 1.5b）全部未完成，不能把本轮文档场景当作已
   通过的运行时安全证据。
2. **L1/L2 的操作边界没有与 rendezvous 统一。** relay 的
   `ClientRequest` 身份来自 iroh 握手，HTTP rendezvous 的 announce/resolve
   走 `rendezvous.rs:124-201` 独立路由；当前文档把两者塞进同一 callback
   AuthContext，导致 B2 的身份空洞。
3. **动态名单改变了原需求的可达集合定义。** 原 `A(S)` 只包含注册 Owner
   capability 的 endpoint（`design.md:26-37`），但无票 callback allow 场景
   实际引入第二个集合；文档仍沿用“集合外零可达”和“relay 只能服务自家业务”
   的单一表述，应补上动态集合、管理员责任、审计和资源配额。
4. **回调传输安全和资源界限遗漏。** 配置面只有 URL/token/timeout/TTL 的
   名义字段，没有 URL 解析策略、body 限制、redirect、并发和 secret 生命周期；
   这些不是实现细节，而是 webhook 成为安全决策点所必需的协议约束。
5. **规范文字回归。** `specs/server/spec.md:7` 的 `A(S)` 无 restricted
   限定与 `design.md:21-23` 不完全一致；应在实现前修复，否则 open 模式兼容
   场景会出现解释分叉。

## 综合评分：6.1/10（与 R1 5.5 / R2 5.9 对比说明）

相对 R1，R2 已补足 Owner/Visitor 的核心语义、撤销窗口、OK2 wire 和独立
拒绝矩阵；相对 R2，本轮把“动态可配置门槛”具体化为 L1/L2、缓存和 webhook，
并验证了 stock iroh-relay HTTP 路径确实在注册前执行 on_connect，因此文档的
可实现性有所提高。但 callback 模式目前有两个 P0 级边界缺口：它可以绕过
capability 最小权限/原 `A(S)`，且 rendezvous callback 的身份上下文不成立；
并有并发、缓存、SSRF、reason 和生命周期等 P1 风险。设计尚未达到可直接进入
实现的安全冻结程度。

结论：NEEDS-WORK

进入实现前至少满足以下条件：

- 保留 capability 模式的不可绕过 L1/L2 安全下限，或显式定义独立的
  identity-only callback 模式及新的 `A_callback(S)`、操作范围、审计和配额；
- 为 relay 与 rendezvous 分别冻结可信身份投影，解决 resolve bearer-only 的
  callback 语义；
- 补齐 callback 的 URL/TLS/SSRF/redirect/token、body、并发和缓存失效协议；
- 把 callback 负向矩阵、并发/生命周期和 reason 语法加入 spec/tasks，并修正
  `spec.md:7` 的 restricted 限定；
- 实现阶段完成 `tasks.md:1.1-1.9`，再以真实 relay、HTTP rendezvous、
  registry 重启/撤销和 webhook adversarial tests 重新复核。
