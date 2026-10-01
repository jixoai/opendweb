# sdk/node Specification

## Purpose
定义 `@jixo/opendweb-client-sdk` npm 包面向 Node 应用的 API 契约：Fabric 生命周期、身份与名册操作、会话与事件。SDK 是 Rust kernel 的 napi-rs 绑定，公共 API 必须类型完备。

## Requirements

### Requirement: Fabric 生命周期

SDK SHALL 提供 Fabric 类：以异步工厂构造（createRoot/open/attach/joinWithToken，接受选项对象——数据目录、relay 配置等）完成初始化并返回实例，`shutdown()` 异步释放网络资源并保证幂等（重复调用不报错）。

#### Scenario: 工厂构造获得身份

- **WHEN** 以空数据目录调用 Fabric.createRoot 完成构造
- **THEN** `endpointId` 属性返回稳定的身份字符串

#### Scenario: 重复 shutdown 幂等

- **WHEN** 连续调用 shutdown 两次
- **THEN** 两次均正常返回，不抛出异常

### Requirement: 名册操作

SDK SHALL 提供 `invite()` 返回邀请令牌字符串、`join(token)` 兑换令牌加入网络、`members()` 返回当前有效成员投影（含 EndpointId 与显示名）、`revoke(endpointId)` 签发撤销。`invite()` SHALL 接受可选第三参 `{ allowRelayless?: boolean }` 透传内核签发安全门逃生阀；无 relay 且无显式直连地址时 `invite()` SHALL 以 `InviteWithoutRelay` 语义的错误 reject（而非产出不可达令牌）。构造选项 SHALL 新增：`advertiseAddrs`（字符串数组，逐项校验 ip:port，非法项构造报错）、`httpProxy`（`"none" | "from-env" | { url: string }`，缺省 `"none"`，映射内核 iroh endpoint 代理配置）、`joinTimeoutMs`（数值，缺省 30000，值域 1000 至 600000，越界构造报错）；relay 配置的 `mode` SHALL 为字面量联合 `"disabled" | "custom" | "n0"`。[W12]：`relay` 选项缺省（含 `mode` 缺省）SHALL 为 `"disabled"`（direct-only 数据面——HTTP-only relay 不能承载端点间 QUIC 数据面，真双机实证 relay-first 停滞）；`"n0"` 与 `"custom"` 只能显式 opt-in。join 失败的错误 SHALL 以 `[<kebab-code>]` 消息前缀标识稳定错误码（token-invalid/token-expired/wrong-fabric/no-reachable-path/relay-offline/dial-failed/dial-timeout/token-consumed），目录归属不匹配的前缀为 `[wrong-fabric]`，供 JS 侧设置 `err.code`。豁免的本地数据面错误（目录缺身份、名册真损坏、名册读写 IO）SHALL 同样以 kebab 前缀透出（missing-identity/corrupted/roster-io），JS 侧派生同名 SCREAMING_SNAKE code。主规格既有 `start()/stop()` 生命周期措辞与现实现（工厂构造 + `shutdown()`）的历史差异由 C0.3 勘误统一为后者。

#### Scenario: API 完整往返

- **WHEN** 使用 SDK 的 invite/join/members/revoke 完整流程
- **THEN** 各方法按 fabric/roster 规格定义的语义生效

#### Scenario: 无 relay 拒签透出

- **WHEN** relay 未配置时调用 `invite(ttl, null)`（无 allowRelayless）
- **THEN** Promise 以 InviteWithoutRelay 语义的错误 reject

#### Scenario: join 错误码前缀

- **WHEN** 以空路径令牌调用 `joinWithToken`
- **THEN** reject 的错误消息以 `[no-reachable-path]` 前缀标识

#### Scenario: 缺省 relay 配置为 direct-only（[W12]）

- **WHEN** 以不携带 `relay` 选项的选项对象构造 Fabric 并查询 `relayStatus()`
- **THEN** mode 为 `"disabled"`、urls 为空数组、online 为 null；显式 `{ mode: "n0" }` / `{ mode: "custom", urls }` / `{ mode: "custom", relays }` 构造照常可用

### Requirement: 会话与事件

SDK SHALL 提供事件订阅覆盖 peer 连接/断开、名册更新与消息收发，并新增 `relay-online`/`relay-offline` 事件——事件对象为判别联合，relay 事件 SHALL **必携带**快照同构 payload（mode、urls、online、lastError、activeUrl；禁用模式不产生；事件携带**跳变时刻**的完整快照副本，不事后读共享可变快照）。`on(cb)` SHALL 返回取消订阅函数。SDK SHALL 提供 `relayStatus()` 快照：`{ mode: "disabled"|"custom"|"n0", urls: string[], online: boolean | null, lastError: string | null, activeUrl: string | null }`——`online` 在 relay 禁用模式 SHALL 为 `null`（而非 false）；`lastError` 为脱敏的最近连接错误类别（不含 URL 凭证段）；`activeUrl` 为配置序最小的已连接 relay URL（`online !== true` 或 disabled 时为 null；`urls`/`activeUrl` 为配置原样字符串，内核不做尾斜杠规范化改写）。消费方 SHALL 以快照为初始事实、事件承载后续跳变（文档明示，避免初始事件竞态）。

#### Scenario: 事件订阅生效

- **WHEN** 注册消息事件回调后对端发来字节
- **THEN** 回调被调用且携带发送者 EndpointId 与原始字节

#### Scenario: 事件取消订阅

- **WHEN** 调用 `on()` 返回的取消函数后对端再次发来字节
- **THEN** 已注销的回调不再被调用

#### Scenario: relay 事件订阅

- **WHEN** 订阅事件后 relay 状态发生跳变
- **THEN** relay-online/relay-offline 事件按序送达回调，且每个 relay 事件必携带快照同构 payload

#### Scenario: 代理 URL 非法拒绝

- **WHEN** 以 `httpProxy: { url: "not a url" }` 构造 Fabric
- **THEN** 构造期以 `[bad-proxy-url]` 前缀 reject

#### Scenario: custom 空 urls 拒绝

- **WHEN** 以 `{ mode: "custom", urls: [] }` 构造 Fabric
- **THEN** 构造期 reject（提示至少一个 relay URL），不进入运行

#### Scenario: join 超时配置

- **WHEN** 以 `joinTimeoutMs: 1000` 构造并 join 一个 issuer 离线的 fabric
- **THEN** 约 1 秒后以 `[dial-timeout]` 前缀错误 reject；以 `joinTimeoutMs: 500` 构造则直接构造报错（值域）

#### Scenario: relay 状态查询

- **WHEN** 配置自托管 relay 且可达时调用 `relayStatus()`
- **THEN** 返回 `mode: "custom"`、实际 URL 列表与 `online: true`

#### Scenario: n0 模式的 relay 状态

- **WHEN** relay 配置为 n0 模式时调用 `relayStatus()`
- **THEN** 返回 `mode: "n0"`、`urls` 为 iroh 上游默认 relay 列表（4 个区域节点，排序冻结；v0.3 起与实际拨号一致）、online 为实际连接状态

#### Scenario: 禁用模式的 relay 状态

- **WHEN** relay 禁用模式下调用 `relayStatus()`
- **THEN** `online` 为 `null`，不产生 relay 事件

### Requirement: 类型完备与平台约束

包 MUST 附带 TypeScript 类型定义，公共 API 不得出现 `any`。v0.1 仅提供 darwin-arm64 原生二进制；在不支持的平台加载时 MUST 抛出明确指明平台约束的错误，而不是模糊的动态链接失败。

#### Scenario: 不支持平台

- **WHEN** 在非 darwin-arm64 平台 require 该包
- **THEN** 抛出内容包含平台支持说明的错误

### Requirement: server-binary 包

`@jixo/opendweb-server-binary` SHALL 包装服务端二进制：安装后在支持的平台上可经 Node API 或 bin 脚本以配置启动服务进程，并暴露停止方式。v0.1 仅 darwin-arm64。

#### Scenario: 启动服务进程

- **WHEN** 调用包提供的方式启动服务端并查询健康检查端点
- **THEN** 健康检查返回成功

### Requirement: handler 生命周期信号（sessionId / signal / writer 三态）

`/http` 的 serveHttp handler 请求对象 SHALL 携带会话与取消生命周期信号：

- `sessionId: string` — 请求所属逻辑会话 id（32 字符小写 hex；内核本地派生事实，非 wire
  字段，不可被对端伪造）；授权缓存 SHALL 以 session_id 为隔离键（同 peer
  不同 session 不继承授权——spec fabric §3.2 的会话级隔离前提）。
- `signal: AbortSignal` — 对端取消（RESET / 会话终态遗弃）事件驱动触发；
  挂起中的 handler（未开始 write）SHALL 也能即时收到 abort，不依赖下一次
  write 的错误回流。正常完成的请求 signal SHALL NOT 触发。
- respondStreaming 返回的 writer SHALL 提供三个正交观测 getter：
  - `finished` — 本地已调用 `finish()`（半关意图）；
  - `cancelled` — 对端取消事件已触发本请求；
  - `closed` — 底层投递通道已关（内核不再消费后续 write）。
  getter 为观测面；`write()` 的错误返回仍为取消/关闭的真相面（0.5.0
  语义不变）。

#### Scenario: 同 peer 新 session 不继承授权

- **WHEN** peer 的 session A 完成授权后断开，同 peer 以新 session B 重连
  且 B 尚未 AUTH
- **THEN** B 的请求事件携带 B 的 sessionId；下游按 sessionId 隔离的授权
  缓存查无 B 的条目 → 401（在 app 层拒绝，内核不裁决授权）

#### Scenario: 挂起 handler 秒停

- **WHEN** 流式 handler 尚未 write（等待慢上游），对端 abort → RESET 到达
- **THEN** handler 的 `req.signal` 在事件驱动下触发 abort（有界时延，
  不依赖 write 尝试）；随后 write/finish 收敛不再消费

#### Scenario: 正常完成不误报取消

- **WHEN** 流式响应正常 FIN 且 dispatch 标记完成
- **THEN** `req.signal` 不触发；writer `closed` 翻转 true、`cancelled`
  保持 false、`finished` 反映本地 finish() 调用

#### Scenario: cancel 事件为 best-effort 信号

- **WHEN** TSFN 队列满或 server 已 close，cancel 事件发射失败
- **THEN** 不阻塞不抛错（NonBlocking 信号语义）；后续 write 的错误返回
  仍如实暴露取消事实

### Requirement: Relay 配置携带 per-relay capability

`@jixo/opendweb-client-sdk` 的 `RelayOptions` SHALL 支持按 relay 携带 capability 凭证：新增可选字段 `relays: Array<{ url: string; server_id?: string; token?: string }>`（`token` 为 `dwebr1.` capability 串；`server_id` 为 restricted relay 的 ServerId——64 hex，admin 注册 owner 时转交）。既有 `urls?: string[]` 字段保留且语义不变（等价于 `relays` 中 `token`/`server_id` 缺省的条目）；两字段同时提供时 MUST 以显式报错拒绝（不静默合并）。`token` SHALL 原样注入对应 relay 的接入凭证（native 经 `Authorization` 头、wasm 经 URL query，由 iroh RelayMap 条目级机制承载）；带 `server_id` 的条目对 root 触发本地自签（`ensureRelayCapabilities()` 面向 SDK 暴露）。relay 接入被服务端拒绝（`dweb/*` 结构化 deny reason）时，SDK SHALL 将 reason 透出为连接诊断事件（不静默吞掉、不无限重试该 relay）。

实现裁定（Phase2-B 回写）：

1. `server_id` 字段为 spec 初稿 `{url, token?}` 之上的增补——root 自签场景
   （task 2.3 的 `ensure_relay_capabilities`）在 SDK 面需要 ServerId 配置位，
   否则 restricted relay 的 owner 侧凭证永远无法自签；napi 面暴露为可选
   hex64，构造期校验（非 64 hex 显式报错）。
2. deny reason 透出通道 = relay 状态快照 `lastError` + `relay-offline` 事件
   payload（fabric 错误脱敏层对 `dweb/[a-z0-9._-]` 结构化 reason 的例外
   透传，形态 `relay denied: dweb/<reason>`）；join/connect 拨号失败分类时
   若 deny 已记录，错误 message 附同一 reason（D11 码保持拨号族不变）。

#### Scenario: per-relay token 注入

- **WHEN** 以 `relays: [{url, token}]` 配置的客户端连接 restricted server 的 relay
- **THEN** 凭证随 relay 连接携带，验证通过后正常接入

#### Scenario: 旧形态兼容

- **WHEN** 以既有 `urls: string[]` 配置的客户端连接 open 模式 relay
- **THEN** 行为与本变更前一致

#### Scenario: 双字段冲突报错

- **WHEN** 同时提供 `urls` 与 `relays`
- **THEN** 构造期返回显式配置错误

#### Scenario: deny reason 透出

- **WHEN** restricted server 因 capability 过期拒绝接入
- **THEN** SDK 发出携带 `dweb/capability-expired` reason 的诊断事件，该 relay 路径不再重试

### Requirement: 延迟启动生命周期（FabricOptions.deferStart / Fabric.start，[H8]）

client-sdk Node 面 SHALL 提供 `FabricOptions.deferStart?: boolean`（**仅对 `createRoot`/`open` 生效**；缺省 false=既有 eager-start 行为**逐字节不变**——现有消费者零回归）与 `Fabric.start(): Promise<void>`。deferred 构造 MUST NOT 产生任何网络出站（不 bind、不等 online、不连接 relay）；`start()` 执行原构造期语义（缓存票据预检合并+注入+bind+online）。Node 可观察状态机冻结（与 design §2.1 转移表一致）：`Deferred→Starting→Started|Failed→Closed`——并发 `start()` single-flight 同结果；`Started` 后 `start()` 幂等 no-op；`Failed` 后 `start()` 重试（→Starting）；`Closed` 后 `start()`/`ensureRelayCapabilities()` 明确错误；任何态 `shutdown()` 幂等且 `Starting` 态 shutdown 取消启动转 Closed、**shutdown 返回后不得有晚到的 bind/网络事件**。`.d.ts` 同步更新（dts 契约纪律）并以 fixture 对拍；NAPI 集成测试覆盖每条合法/拒绝转移边（表驱动）与 deferred 构造期零出站断言。

#### Scenario: 缺省行为零回归

- **WHEN** 以既有 FabricOptions（无 deferStart）构造 createRoot/open 并运行既有 SDK 测试面
- **THEN** 行为与签名逐字节不变（eager-start；全部既有测试通过）

#### Scenario: deferred 构造零出站与首触带票

- **WHEN** 以 `{deferStart:true, relay:{mode:"custom",relays:[{url,serverId}]}}` 构造（网络层观测）后 `ensureRelayCapabilities()`→tuple 断言→`start()`
- **THEN** 构造与 ensure 阶段零网络出站；首次 relay 接触发生于 start() 之后且携带 ensure 所签 capability

#### Scenario: 状态机拒绝边与并发

- **WHEN** 分别在 Closed 态调用 start/ensure、并发 start+shutdown、Started 后重复 start、Failed 后重试 start
- **THEN** Closed 态两操作得明确错误；并发 shutdown 胜出且返回后无晚到网络事件（在途 start Promise resolve 为「已取消」、状态 Closed、不可重试）；Started 重复 start 幂等 no-op；Failed 重试重新进入 Starting；调用方放弃 Future（不 await）不影响状态机（single-flight 后续 start 得同一结果）；底层失败 reject（错误载荷含原因）与 shutdown 取消（resolve 已取消）语义可区分

### Requirement: Roster 显式 fabric_id 采纳（FabricOptions.fabricId，[H8]）

client-sdk Node 面 SHALL 提供 `FabricOptions.fabricId?: string`（**仅 `createRoot` 生效**；64 hex 小写校验，非法=构造错误；缺省=SDK 随机生成既有行为不变）：提供时 roster **持久化并采纳该值**，`fabricIdHex()` 读回值 MUST 逐字等于所提供值；**roster 已存在（同 data_dir）时 createRoot 一律 `AlreadyExists`**（不区分 fabricId 是否一致——复用一律走 `open`：open 负责校验 tuple 匹配（fabricIdHex==期望值，不匹配=明确错误），不重复 Genesis、不覆盖 roster）（r13-P2-2）。该参数是 home-hub 身份 tuple 同源机制的采纳侧（CLI join 为唯一生成点，见 cli/leases delta；**[H8] 二次拍板明文授权 roster 身份语义扩展**）；**身份 seed 供给（目录供给方案，零新 API）**：home-hub 消费路径 MUST 以 `dataDir=<DWEB_HOME>` 构造——SDK 既有 `resolve_identity(Default)` 由此读取 join 的 `<DWEB_HOME>/identity.key`（同文件同源；不新增 seed 供给 API，SecretSeedHandle/importSecret 面不动，seed 永不进 JS 字符串）；dataDir≠DWEB_HOME=home-hub 消费路径构造前禁止；identity.key 缺失/损坏/权限不足=构造前明确错误；集成测试 MUST 断言 createRoot(fabricId=X, dataDir=DWEB_HOME) 读回==X 且 `endpointId()`==register.root==lease.root（重启后仍相等）；异 data_dir 构造的 endpointId 不等于 lease.root=首拨前 fail-closed。

#### Scenario: 采纳与读回一致

- **WHEN** 以合法 64 hex fabricId 构造 createRoot 后读 `fabricIdHex()`
- **THEN** 读回值逐字等于提供值；同 data_dir 重开（open）后仍为该值

#### Scenario: 既有 roster 冲突拒绝

- **WHEN** data_dir 已有 roster（fabricId=A）时分别以 fabricId=B 与 fabricId=A 调 createRoot
- **THEN** 两者均得 `AlreadyExists`（复用一律走 open）；A 原样保留；随后 open 的 tuple 校验：期望 A=成功、期望 B=明确错误
