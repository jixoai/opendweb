<!--
intent:
  - id: home-hub-sdk-lifecycle-and-identity
    why: [H8] 两项最小扩展的 Node 可观察契约（deferStart 生命周期+
    fabricId 采纳）——home-hub 入网闭环的 SDK 面
原始输入：requirements.md [H8]（含二次拍板）；design.md §2.1/转移表。
-->

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
- **THEN** Closed 态两操作得明确错误；并发 shutdown 胜出且返回后无晚到网络事件（在途 start Promise resolve 为「已取消」、状态 Closed、不可重试）；Started 重复 start 幂等 no-op；Failed 重试重新进入 Starting；调用方放弃 Future（不 await）不影响状态机（single-flight 后续 start 得同一结果）；底层失败 reject（错误载荷含原因）与 shutdown 取消（resolve 已取消）语义可区分

### Requirement: Roster 显式 fabric_id 采纳（FabricOptions.fabricId，[H8]）

client-sdk Node 面 SHALL 提供 `FabricOptions.fabricId?: string`（**仅 `createRoot` 生效**；64 hex 小写校验，非法=构造错误；缺省=SDK 随机生成既有行为不变）：提供时 roster **持久化并采纳该值**，`fabricIdHex()` 读回值 MUST 逐字等于所提供值；**roster 已存在（同 data_dir）时 createRoot 一律 `AlreadyExists`**（不区分 fabricId 是否一致——复用一律走 `open`：open 负责校验 tuple 匹配（fabricIdHex==期望值，不匹配=明确错误），不重复 Genesis、不覆盖 roster）（r13-P2-2）。该参数是 home-hub 身份 tuple 同源机制的采纳侧（CLI join 为唯一生成点，见 cli/leases delta；**[H8] 二次拍板明文授权 roster 身份语义扩展**）；**身份 seed 供给（目录供给方案，零新 API）**：home-hub 消费路径 MUST 以 `dataDir=<DWEB_HOME>` 构造——SDK 既有 `resolve_identity(Default)` 由此读取 join 的 `<DWEB_HOME>/identity.key`（同文件同源；不新增 seed 供给 API，SecretSeedHandle/importSecret 面不动，seed 永不进 JS 字符串）；dataDir≠DWEB_HOME=home-hub 消费路径构造前禁止；identity.key 缺失/损坏/权限不足=构造前明确错误；集成测试 MUST 断言 createRoot(fabricId=X, dataDir=DWEB_HOME) 读回==X 且 `endpointId()`==register.root==lease.root（重启后仍相等）；异 data_dir 构造的 endpointId 不等于 lease.root=首拨前 fail-closed。

#### Scenario: 采纳与读回一致

- **WHEN** 以合法 64 hex fabricId 构造 createRoot 后读 `fabricIdHex()`
- **THEN** 读回值逐字等于提供值；同 data_dir 重开（open）后仍为该值

#### Scenario: 既有 roster 冲突拒绝

- **WHEN** data_dir 已有 roster（fabricId=A）时分别以 fabricId=B 与 fabricId=A 调 createRoot
- **THEN** 两者均得 `AlreadyExists`（复用一律走 open）；A 原样保留；随后 open 的 tuple 校验：期望 A=成功、期望 B=明确错误
