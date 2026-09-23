<!--
Intent: home-hub r13 design-readiness review.
Original request: independently verify r12's seed-supply closure against HEAD e93408f, inspect new contradictions, and re-evaluate the ten non-regression baselines.
Timestamp: 2026-09-24 Asia/Shanghai.
-->

# home-hub 设计层复审 r13

评审基点：`HEAD e93408f03f64b04d6fa96216808b5a60b3a23054`（2026-09-24）。
对照基点：r12 `e0c821a7d972146c3522f3094c091ec7973c872b`，r12 结论 NOT-READY 7.8/10。
范围：核验 r12 唯一 P1 的目录供给修复；检查 v13 对 H7 多租约、CLI `--fabric`、SDK 单 roster 与既有 P2 的一致性；复核十条不可回退基线。只读评审，仅新增本报告。

## 1. 结论与评分

结论：**NOT-READY，7.8/10（较 r12 0.0）**。

v13 的目录供给方案确实闭合了 r12 的同 seed API 缺口：home-hub 消费路径将 SDK `dataDir` 固定为 `<DWEB_HOME>`，现有 `resolve_identity(Default)` 读取的正是该目录下的 `identity.key`，没有把 seed 暴露给 JS，也没有新增 NAPI。可是这个选择同时把本地 SDK roster 固定为一个 `roster.facts`/一个 `fabric_id`。H7 的租约簿仍是 0..N，继承的 CLI 仍允许 `--fabric` 显式选择不同 fabric；server-access-roles 也允许不同 `(fabric_id, root)` 注册。v13 只写“多租约共用同一 `(fabric_id, root)`”，没有在 join/preflight/连接器边界拒绝第二个 fabric，或定义多 roster 选择。因此 r12 P1 转移为新的多租约/单 roster P1，设计层仍不能 GO。

| 维度 | r12 | r13 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 9.0 | 9.0 | 目录供给不需新 [H8]；H7 的 0..N 租约与单 roster 的边界未获额外裁决。 |
| 基线契约一致性 | 8.0 | 7.8 | 未改写 server-access-roles，但继承的 `--fabric` 能力与 v13 固定单 roster 尚未闭合。 |
| 三方一致性 | 7.6 | 7.8 | design/leases/Node delta 均写 `dataDir=DWEB_HOME`；旧顺序和 createRoot/open 文案仍漂移。 |
| 技术可实现性 | 7.4 | 7.7 | 同 seed 路径可直接复用现有实现；不同 fabric 的第二租约没有承载路径。 |
| Spec 可测性 | 8.0 | 7.9 | 增加了目录、缺失/损坏 key 的要求，但缺少同 fabric 多租约正向与不同 fabric 负向 Scenario。 |

相对 r12，种子供给从不可调用约束变成可执行的同文件约束，技术可实现性上升；但该约束暴露并新增单 roster/多 fabric 矛盾，分数不升，仍为 NOT-READY。

## 2. 验证证据

### 实际阅读

- r12 报告：`docs/codex-review-hh-r12.md`，逐项对照 r12 P1/P2 和十条基线。
- v13 变更：`openspec/changes/home-hub/design.md` §2.1、§9、§10 处置表；`specs/cli/leases/spec.md` tuple/多租约/Scenario；`specs/sdk/node/spec.md` fabricId 与目录供给 Requirement；`requirements.md` [H7]/[H8]。
- 身份与 roster 事实：`packages/opendweb/src/device-key.mjs` 的 `<DWEB_HOME>/identity.key` 读取/原子创建；`packages/opendweb/src/join.mjs` 的 fabric 选择（显式 `--fabric`、既有值复用、随机）和 register root；`packages/client-sdk/src/fabric.rs` 的默认 `SecretInjection`；`crates/dweb-fabric/src/fabric.rs` 的 `resolve_identity`, `create_root`, `open`；`crates/dweb-fabric/src/roster.rs` 的单 roster 文件与既有文件拒绝创建。
- 基线契约：`openspec/changes/server-access-roles/specs/cli/identity/spec.md` 的既有 fabric 复用与 `--fabric` 语义；`PRODUCT-DESIGN.md` 的 0..N 租约和多租约产品叙事。

### 实际命令与结果

- `git status --short`（报告创建前）：工作树干净。
- `git rev-parse HEAD`：`e93408f03f64b04d6fa96216808b5a60b3a23054`，与任务给出的 HEAD 一致。
- `git rev-parse e0c821a`、`git log e0c821a..HEAD --oneline`：基点存在；本轮为 v13 单提交。
- `git diff --name-status e0c821a...HEAD`：除 r12 报告存档外，仅修改 home-hub `design.md`、leases delta、SDK Node delta。
- `git diff --check e0c821a...HEAD`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。

未运行 Rust/Node 测试、真实 restricted relay 握手、G-3 300 秒实验、自启、tray 或多租约 acceptance。Strict validation 只证明 artifact 结构，不证明单 roster 能消费多个 fabric。

## 3. r12 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R12-P1-1 同 seed 无 SDK 供给契约 | **闭合（同 fabric 路径）** | v13 在 design §2.1、leases delta、SDK Node delta 冻结 home-hub `dataDir=<DWEB_HOME>`；CLI 与 SDK 默认解析均读取同一 `<DWEB_HOME>/identity.key`，不新增 seed API，seed 不进 JS。并明确 dataDir 不一致、key 缺失/损坏/权限问题 fail-closed。该闭合只覆盖单 roster/同 fabric；不同 fabric 的多租约矛盾成为 R13-P1-1。 |
| R12-P2-1 Scenario 顺序 | **仍存在** | leases delta:21 仍写 `createRoot→register`，design:226 仍写 `fresh createRoot→register`，与 design:220-222 冻结的 `CLI join/register → SDK createRoot/open → endpointId → ensure/start/connect` 相反。 |
| R12-P2-2 createRoot 既有 roster 语义 | **仍存在** | SDK Node delta:24 仍说同 data_dir、同 fabricId 的既有 roster 在 createRoot 下“继续”；实际 `Fabric::create_root` 与 `Roster::create` 对既有 roster 返回 `AlreadyExists`，设计复用路径是 `open`。 |
| R12-P2-3 [H8] 映射 | **仍存在** | design §0:31 仍只列 deferStart 生命周期/NAPI；requirements [H8] 已授权的 fabricId 采纳没有在映射表中列出。 |
| R12-P2-4 取消结果 | **仍存在** | design §2.1:184 将 Starting shutdown 转 Closed，:189 又称取消的 start Future 等价 Failed、可重试；Node delta 只冻结 Closed/no-late-events，没有 Promise 结果和取消来源优先级。 |
| R12-P2-5 文件意图元数据 | **仍存在** | `specs/cli/leases/spec.md:1`、`specs/sdk/node/spec.md:1` 仍直接从 `## ADDED Requirements` 开始；design 顶部也无全局要求的意图/原始输入/时间戳或不可拆分声明。 |

## 4. 新问题清单

### P0

无。

### P1

#### R13-P1-1：固定单 roster 与 H7 0..N/不同 fabric 租约未闭合

v13 的同 seed 修复依赖 `Fabric dataDir=<DWEB_HOME>`。现有 SDK roster 以该目录保存一个 `roster.facts`；`Fabric::create_root` 在文件存在时直接 `AlreadyExists`，`open` 读取该 roster 的单一 fabric。与此同时，home-hub 仍声明租约键为 `(server, fabric_id, root)`、数量 0..N，并保留 tuple 的 fabric 来源 `flag/既有租约复用/CSPRNG`；继承的 `opendweb join --fabric` 也允许显式传入新的 64hex fabric。server-access-roles 的 CLI 契约允许既有 fabric 复用，也允许 `--fabric` 显式指定，服务端允许不同 `(fabric_id, root)` 条目。

因此如下路径在设计上仍合法，但没有可消费的本地 roster：先以 `DWEB_HOME` 加入 server A 得到 fabric A，再以 `--fabric=fabric-B` 加入 server B 得到第二条租约；leases.json 可以按键落两条，但连接器只能打开 DWEB_HOME 的 fabric A roster，不能为 fabric B `createRoot`（已有 roster）或 `open`（fabric 不匹配）。v13 只写“多租约共用同一 `(fabric_id, root)`、本地一个 roster”，这是未经裁决的额外限制，既没有拒绝第二 fabric，也没有为其定义布局/选择规则。

**可验证修复建议（二选一）：**

1. **明确单 fabric 约束：**Owner/requirements 或 home-hub delta 明文冻结每个 DWEB_HOME 只能承载一个 fabric；join preflight 在 register 前读取既有 roster/租约，`--fabric` 或将要加入的 fabric 与既有值不等时 fail-closed，明确错误且不远端 register、不写 leases；同 fabric 跨 server 仍必须成功。补“两个 server 同 fabric 两条租约”正向和“第二 fabric 拒绝”负向 Scenario，并说明这是 H7 0..N 租约中允许的多 server/同 fabric 子集。
2. **保留不同 fabric 的 0..N：**设计每 fabric 的 roster 目录/选择与 SDK `open`/`createRoot` 语义，确保仍能使用同一设备 seed 且不依赖当前单 roster API；该布局和任何 SDK 变化需取得 Owner 授权，并补跨 fabric 的正向/重启/错误选择 Scenario。

在上述二选一完成前，H7 多租约的设计覆盖不完整，基线 2 和 6 不能转正。

### P2

#### R13-P2-1：tuple 正向 Scenario 仍反向写流程

`specs/cli/leases/spec.md:21` 与 `design.md:226-230` 仍以 `createRoot→register` 开始；主流程在 `design.md:220-222` 已冻结为 CLI join/register 先、SDK 连接器消费租约后。

**修复建议：**统一改成 `CLI join/register → SDK createRoot/open(dataDir=DWEB_HOME) → endpointId/fabricId 断言 → ensure/start/connect`；将负向明确为错 fabric/错目录/损坏 roster 在首拨前拒绝。

#### R13-P2-2：既有 roster 下 createRoot “继续”仍与实现和 open 分工冲突

`specs/sdk/node/spec.md:24` 的“同 fabricId 则继续”与当前 `create_root` 的 `AlreadyExists` 及 design 的 `open` 复用路径矛盾。

**修复建议：**冻结 createRoot 对任何既有 roster 一律 `AlreadyExists`，open 才负责复用并校验 fabric tuple；或者 Owner 明确批准并定义新的 createRoot 复用语义，避免重复 Genesis/覆盖 roster。

#### R13-P2-3：生命周期取消结果仍未冻结

`design.md:181-190` 同时规定 Starting shutdown→Closed 和取消 start Future→Failed 可重试；Node delta 未规定并发 `shutdown()` 胜出时在途 Promise 的 resolve/reject/cancel 结果，也未区分 shutdown 主动取消和调用方取消。

**修复建议：**为 shutdown 主动取消、底层启动失败、调用方放弃 Future 分别冻结状态终点、Promise 错误/返回、资源清理、重试边，并补 Rust/Node 表驱动 Scenario。

#### R13-P2-4：意图元数据与 [H8] 映射仍不完整

两份 delta 顶部缺少全局要求的意图、原始需求、时间戳；design 顶部没有多意图不可拆分声明。design §0 [H8] 行也仍未列 `FabricOptions.fabricId` 采纳，尽管 requirements [H8] 已明文授权。

**修复建议：**为 `design.md`、leases delta、SDK Node delta 增加 HTML 头注释，列正交意图、原始输入和时间戳，必要时声明不可拆分原因；将 [H8] 映射拆为 deferStart 与 fabricId 采纳两项并引用 §2.1/Phase 0/Node delta。

## 5. Owner 裁决与基线终判

本轮 diff 未修改 `server-access-roles`；strict validation 通过，未发现 alias、邀请码、敲门、WebUI 冻结面或 renew/first_registered_at 语义被放宽。r12 的目录供给没有扩大 [H8]，但其单 roster 后果尚未被 Owner 作为单 fabric 范围裁决。

| 裁决 | r13 终判 |
|---|---|
| H0 | **部分**：同 seed/Custom relay/deferStart 时序在同一 fabric 路径闭合；不同 fabric 租约无本地 roster 方案。 |
| H1 | **设计满足**：短码 wire/golden vectors 未被本轮改写；跨端对拍待实现期证据。 |
| H2 | **设计满足**：tray 事件/RPC 契约未变；真实壳 acceptance 待交付。 |
| H3 | **设计满足**：显式 init/start、平台自启、stop owner 契约未变；真实平台 acceptance 待交付。 |
| H4 | **设计满足**：webui core/薄壳、注入 opener、管理员入口约束未变。 |
| H5 | **设计满足**：三视角和 member sidecar 安全边界未变。 |
| H6 | **设计满足**：alias 仍只消费显示，不改服务端契约。 |
| H7 | **部分**：0..N leases.json/锁协议存在，但单 roster 与不同 fabric join 的边界未冻结。 |
| H8 | **部分**：deferStart 与 fabricId 授权原文存在；§0 映射遗漏 fabricId，取消结果仍未冻结。 |

### 十条不可回退基线

| # | 基线 | r13 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 未被改写。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL / 未转正**：同 fabric 的 CustomWithCaps/deferStart 时序闭合；不同 fabric 多租约可能落账但无法安全消费，真实 restricted 首触带票仍待验收。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**：目录 ownership 约束未被放宽；单 roster 后果见 P1。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**：本轮未改写。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **CONDITIONAL**：锁协议与多租约条目存在，但不同 fabric 租约的 SDK roster 消费边界未闭合。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；CLI/WebUI 对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL（实现证据待交付）**：条件与文案冻结；300 秒实验、relay-only 对照或六字段 NOT-EXECUTABLE 记录仍须完成。 |

## 6. 设计结论与实现期义务

**设计层 NOT-READY，7.8/10。** r12 的同 seed P1 在单 fabric 路径上闭合，但新增 R13-P1-1（单 DWEB_HOME roster 与 0..N/不同 fabric 租约边界）阻止 GO；r12 的 Scenario 顺序、createRoot/open、取消语义和文档元数据问题仍未闭合。

进入实现前必须完成：

1. 选择并冻结单 fabric 约束或多 roster 方案。推荐先明确单 fabric 约束：保留多租约的 server 维度（同 fabric 跨 server），对不同 `--fabric` 在 register 前 fail-closed，并补正负 Scenario；不得让第二 fabric 先远端 register 再在本地无法消费。
2. 统一 fresh/reopen 正向 Scenario 为 CLI join/register → SDK createRoot/open(dataDir=DWEB_HOME) → tuple 断言 → ensure/start/connect。
3. 冻结 createRoot/open 的既有 roster 语义和 shutdown/start Promise 结果，补对应 Node/Rust 测试。
4. 补齐 design/delta 顶部意图元数据与 [H8] 映射索引。

设计闭合后仍需实现期验证，特别是基线 2/6/10：

1. **同 fabric 多租约与身份连续性：**两个不同 server 使用同一 `(fabric_id, root)` 成功落两条 lease；第二 fabric/错 `--fabric` 按选定策略在 register 前拒绝或按多 roster 方案成功；每次消费均在首拨前断言 register.root==lease.root==SDK endpointId、fabricId、server_id、relay capability 全等。
2. **目录与生命周期：**`dataDir=DWEB_HOME` 的路径规范化/权限/缺失/损坏/重启测试；deferStart 构造零出站、首次 relay 接触晚于 ensure、缓存票优先级、状态转移和 shutdown 竞态由 Rust/Node 测试覆盖。
3. **Restricted relay/G-3：**CustomWithCaps 真实受限握手、无票/跨 server/malformed 拒绝；G-3 只改 `relay_failover.rs` test-only，先证 Direct，停整个 hub，300 秒双向零中断，停机期间新 join 失败，重启恢复；relay-only 对照或六字段 NOT-EXECUTABLE 记录，文案只写“依网络环境”。
4. **其他验收：**darwin/Windows 自启与 stop 真实账户记录、member sidecar 负向矩阵、短码 CLI/WebUI 对拍、tray 真实壳 acceptance；strict validation 不替代这些证据。
