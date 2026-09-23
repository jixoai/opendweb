## ADDED Requirements

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
- **THEN** Closed 态两操作得明确错误；并发 shutdown 胜出且返回后无晚到网络事件；Started 重复 start 幂等 no-op；Failed 重试重新进入 Starting

### Requirement: Roster 显式 fabric_id 采纳（FabricOptions.fabricId，[H8]）

client-sdk Node 面 SHALL 提供 `FabricOptions.fabricId?: string`（**仅 `createRoot` 生效**；64 hex 小写校验，非法=构造错误；缺省=SDK 随机生成既有行为不变）：提供时 roster **持久化并采纳该值**，`fabricIdHex()` 读回值 MUST 逐字等于所提供值；roster 已存在（同 data_dir）时提供 fabricId=校验一致则继续、不一致=明确错误（不静默改写既有 roster）。该参数是 home-hub 身份 tuple 同源机制的采纳侧（CLI join 为唯一生成点，见 cli/leases delta）；集成测试 MUST 断言 createRoot(fabricId=X) 读回==X 且与 register/lease 值逐字一致。

#### Scenario: 采纳与读回一致

- **WHEN** 以合法 64 hex fabricId 构造 createRoot 后读 `fabricIdHex()`
- **THEN** 读回值逐字等于提供值；同 data_dir 重开（open）后仍为该值

#### Scenario: 既有 roster 冲突拒绝

- **WHEN** data_dir 已有 roster（fabricId=A）时以 fabricId=B 调 createRoot
- **THEN** 明确错误（不静默改写/生成第二个 roster）；A 原样保留
