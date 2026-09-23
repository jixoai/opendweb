<!--
Intent: home-hub r12 design-readiness review.
Original request: independently verify r11 findings against HEAD e0c821a, assess v12 contradictions, and re-evaluate the ten implementation baselines.
Timestamp: 2026-09-24 Asia/Shanghai.
-->

# home-hub 设计层复审 r12

评审基点：`HEAD e0c821a7d972146c3522f3094c091ec7973c872b`（2026-09-23）。
对照基点：r11 `484e1abb5d5f946c258f3b32b63241d490f43a59`，r11 结论 NOT-READY 7.7/10。
范围：逐项核验 r11 的 2 条 P1；检查 v12 的同 seed 供给、[H8] 扩充、Scenario 顺序和 SDK roster 行为；复核十条不可回退基线。只读评审，仅新增本报告。

## 1. 结论与评分

结论：**NOT-READY，7.8/10（较 r11 +0.1）**。

v12 已用 requirements [H8] 二次拍板明确授权 `FabricOptions.fabricId` 的 roster 采纳语义，r11-P1-2 闭合；design、leases delta、SDK Node delta 也明确要求 SDK endpoint 身份与 CLI join 共用 `<DWEB_HOME>/identity.key`。但这仍是未定义供给方式的 MUST：当前 SDK Node 公开 API 没有从该文件读取/构造 `SecretSeedHandle` 的入口，`importSecret()` 只接受加密导出串；若不新增接口，默认 seed 由 SDK `dataDir/identity.key` 决定，而设计同时允许 roster `dataDir` 独立。因而 r11-P1-1 的“同 seed”要求尚不可按已冻结调用面执行，`register.root == lease.root == SDK endpointId()` 仍不能由设计保证，阻止设计层 GO。

| 维度 | r11 | r12 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.6 | 9.0 | [H8] 二次拍板明确授权 `fabricId` 采纳；设计映射表尚未列出这项授权，seed 供给的 API/授权边界仍未冻结。 |
| 基线契约一致性 | 8.0 | 8.0 | 未发现本轮对 server-access-roles 冻结面的改写；join/SDK root 的实际供给闭环未完成。 |
| 三方一致性 | 7.5 | 7.6 | design/leases/Node delta 同步了同 seed 要求，但 leases 的一条 Scenario 仍反向写成 createRoot→register。 |
| 技术可实现性 | 7.3 | 7.4 | `fabricId` 获得授权且契约明确；SDK 没有从 CLI identity 文件形成 seed handle 的公开路径。 |
| Spec 可测性 | 8.1 | 8.0 | 新增三方 root 相等及重启断言；执行所需 seed 供给未指定，部分 Scenario 与主流程矛盾。 |

较 r11 +0.1：Owner 授权缺口已实质闭合，root 连续性约束也由隐含假设变成显式要求；但主阻塞从“未规定同 seed”变为“规定了同 seed，却没有可调用的供给契约”，所以只小幅上调，仍为 NOT-READY。

## 2. 验证证据

### 实际阅读

- r11 报告：`docs/codex-review-hh-r11.md`，逐项对照 r11 的 P1/P2 与十条基线。
- 本轮变更：`openspec/changes/home-hub/requirements.md` [H8] 二次拍板；`design.md` §0、§2.1、Phase 0、§10 处置表；`specs/cli/leases/spec.md` Requirement 与 tuple/重开 Scenario；`specs/sdk/node/spec.md` 两个 Requirement 及 Scenario。
- SDK 事实：`packages/client-sdk/index.d.ts` Fabric 工厂、`SecretSeedHandle` 与 `importSecret`；`packages/client-sdk/src/fabric.rs` 的 `take_options`、`SecretInjection::Default/Seed` 和 `import_secret`；`crates/dweb-fabric/src/fabric.rs` `resolve_identity`、`create_root/open` 与 `endpoint_id`；`crates/dweb-fabric/src/roster.rs` 已有 roster 拒绝 `create` 的行为。
- CLI 身份事实：`packages/opendweb/src/device-key.mjs` 的 `<DWEB_HOME>/identity.key` 读写约定及 `packages/opendweb/src/join.mjs` 从该 seed 推导并签署 register.root。
- 授权事实以 `requirements.md` [H8] 原文为准；server-access-roles 本轮 diff 未触及其文件。

### 实际命令与结果

- `git status --short`（报告创建前）：工作树干净。
- `git rev-parse HEAD`：`e0c821a7d972146c3522f3094c091ec7973c872b`，与任务给出的 HEAD 一致。
- `git log -4 --oneline --decorate`：HEAD 为 v12 设计提交，父提交为 r11 `484e1ab`。
- `git diff --name-status 484e1ab..HEAD`：除 r11 报告存档外，仅修改 home-hub `design.md`、`requirements.md`、leases delta 和 SDK Node delta。
- `git diff --check 484e1ab..HEAD`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- `docs/agents/issue-tracker.md` 不存在；本评审按用户明确指定的 requirements/design/specs 与源码作为规范来源。若要恢复该 review skill 的通用 issue-tracker 工作流，可运行 `/setup-matt-pocock-skills`；本任务的规范来源已明确，因此不作为阻塞。

未运行 Rust/Node 测试、Custom restricted relay 握手、G-3 实验、平台自启或 tray acceptance。OpenSpec strict validation 只证明 artifact 结构有效，不证明 SDK 有同 seed 调用路径或实际握手成立。

## 3. r11 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R11-P1-1 root 同 seed 连续性 | **部分闭合，整体未闭合** | design §2.1、leases 与 Node delta 新增 `<DWEB_HOME>/identity.key` MUST 及 root 三方相等、重启稳定、异 seed 首拨前拒绝；但 Node API 只有接受 `SecretSeedHandle` 的 `createRoot/open`，句柄公开工厂 `importSecret(token, passphrase)` 只解密加密导出串，没有从 DWEB_HOME 裸 seed 文件构造句柄的入口。若使用 `SecretInjection::Default`，SDK 仍按 `FabricOptions.dataDir/identity.key` 解析 seed；而本设计明确 roster `dataDir` 可独立。`seed=<DWEB_HOME>/identity.key` 目前只是 Scenario 参数写法，不是已冻结的 SDK 参数或数据流。见 R12-P1-1。design 与 leases 的 fresh 正向 Scenario 均仍写 `createRoot→register`，见 R12-P2-1。 |
| R11-P1-2 `fabricId` 扩展授权 | **闭合** | requirements [H8] 116-120 明文授权 createRoot 的 64hex `fabricId` 采纳与持久化、缺省旧行为、既有 roster 冲突拒绝及范围边界；Node delta 与 Phase 0 均引用该裁决。design §0 映射表仍未把 fabricId 采纳列入 [H8]，见 R12-P2-3。 |
| R11-P2-1 createRoot 既有 roster 同 ID 语义 | **仍存在** | SDK Node delta §24 称既有 roster 且 ID 一致则“继续”；当前 `Fabric::create_root`/`Roster::create` 遇任何既有 roster 都返回 `AlreadyExists`。design §2.1 只允许复用时 open 同一 roster，未定义 createRoot 的“继续”具体行为。见 R12-P2-2。 |
| R11-P2-2 启动取消结果 | **仍存在** | design 状态表规定 Starting 时 shutdown→Closed，下一段又规定 start Future 被取消等价 Failed 可重试；Node delta 未冻结在途 `start()` Promise 的 resolve/reject/cancel，也未区分 shutdown 主动取消与调用者取消。见 R12-P2-4。 |
| R11-P2-3 文件意图元数据 | **仍存在** | 新增身份 seed 约束的 `specs/sdk/node/spec.md` 仍从 `## ADDED Requirements` 开始，没有全局 AGENTS 要求的顶部意图、原始需求来源和时间戳注释。见 R12-P2-5。 |

## 4. 新问题清单

### P0

无。

### P1

#### R12-P1-1：同 seed 要求没有 SDK seed 供给契约

设计已冻结 SDK identity seed MUST 与 CLI join 共用 `<DWEB_HOME>/identity.key`，并允许 roster `dataDir` 独立（`design.md:202-212`；`specs/cli/leases/spec.md:16-17,24`；`specs/sdk/node/spec.md:24`）。当前 SDK 可见事实无法按此组合：`Fabric.createRoot/open(opts, secret?)` 的 seed 参数是 `SecretSeedHandle`（`packages/client-sdk/index.d.ts:43-47`）；公开生成入口 `importSecret(token, passphrase)` 只从加密导出串生成该句柄，不接受路径或原始 seed（`:206-211,340-344`）。SDK `take_options()` 无句柄时设置 `SecretInjection::Default`（`packages/client-sdk/src/fabric.rs:284-310`），Rust `resolve_identity(Default)` 从 `config.data_dir/identity.key` 读取/创建身份（`crates/dweb-fabric/src/fabric.rs:1701-1713`）。CLI join 则用 JS `device-key.mjs` 读取 `<DWEB_HOME>/identity.key` 并以它签署 register（`packages/opendweb/src/device-key.mjs:39-54`；`packages/opendweb/src/join.mjs:337-349`）。

因此在合法的 `dataDir != DWEB_HOME` 配置下，SDK 没有符合当前公开契约的方式显式使用 join seed；若直接使用 SDK 默认身份存储则可能形成不同 endpointId。文本虽要求错误 seed 首拨前拒绝，却没有定义如何供给正确 seed，也没有定义在 seed 文件不存在/损坏/权限不足时的确定行为。用实际 relay 握手失败兜底不能满足已冻结的首拨前身份断言。

**可验证修复建议：**保留独立 roster 目录时，冻结明确的 SDK seed 注入入口和安全契约（Node 参数/工厂或 identity-store 路径、只读来源、32 字节校验、不得把 seed 转成 JS 字符串、错误与生命周期语义、句柄消费/zeroize、d.ts 与集成测试），并由 Owner 明确授权任何超出当前 [H8]“fabricId 采纳”范围的 SDK 身份入口扩展。随后验证同一 DWEB_HOME seed 生成 register.root 与 SDK `endpointId()` 相同、重启保持、错 seed 首拨前拒绝且账本不变。若选择让 `dataDir` 承担默认 identity store，则必须另行证明该约束不破坏 H7 多租约/多 roster；当前每个 dataDir 仅容纳一个 roster，不能只改文案将所有 roster 收到同一目录。

不应仅把 `seed=<path>` 写入 Scenario 作为闭环；必须让 spec 中的入口映射到明确 API，且同步 Owner 授权范围。

### P2

#### R12-P2-1：身份 tuple 正向 Scenario 顺序仍与冻结流程相反

leases delta 的 Scenario「身份 tuple 同源与分叉拒绝」仍写 `fresh 设备以 createRoot→register→ensure→restricted 握手`（`specs/cli/leases/spec.md:21`）；design §2.1 的 fresh Scenario 也写 `createRoot→register`（`design.md:217-218`）。两处均与同文件上文和设计主流程冻结的 `CLI join/register → SDK createRoot/open → endpointId 断言 → ensure/start/connect`（`design.md:211-213`）相反。旧顺序会先造 SDK roster，再由 CLI 执行唯一生成/注册点，无法按声明验证 SDK 消费租约。

**修复建议：**同步改写 design 与 leases 两处正向 Scenario：CLI join/register 在先，SDK createRoot/open 消费租约在后；明确 fabricId/root 来源以及 assert 后才 ensure/start/connect。严格验证可用集成测试步骤顺序日志。

#### R12-P2-2：既有 roster 的 createRoot 结果仍含不可执行的“继续”分支

SDK Node delta `spec.md:24` 规定同 data_dir 已有 roster 且 fabricId 相同时“继续”，参数又限定仅 `createRoot` 生效。当前 Rust `Fabric::create_root` 在检测既有 roster 时直接返回 `AlreadyExists`（`crates/dweb-fabric/src/fabric.rs:1717-1729`）；`Roster::create` 也拒绝覆盖（`crates/dweb-fabric/src/roster.rs:216-219`）。design `§2.1:218` 的既有 root 路径则是 `open`。如果计划改变 createRoot 的既有 roster 行为，当前 [H8] 授权只说明 fabricId 采纳/冲突拒绝，没有冻结复用/打开语义（`requirements.md:116-120`）。

**修复建议：**冻结 `createRoot` 对已有 roster 一律 `AlreadyExists`，只允许 `open` 复用并在 open 后校验 lease tuple；或者在 Owner 授权后另行定义“同 ID 继续”的准确状态转换。补同 ID/异 ID 下 createRoot/open 的分别断言，并保证不重复写 Genesis。

#### R12-P2-3：[H8] 映射表未列出已授权的 fabricId 采纳

requirements [H8] 已新增 `FabricOptions.fabricId` 的授权，但 `design.md` §0:31 的 [H8] 映射仍只列 deferStart 生命周期 API、NAPI/d.ts 和集成测试。评审者从裁决索引无法找到第二项获批机制；Phase 0 和 §2.1 已列 fabricId，索引不完整。

**修复建议：**将 [H8] 映射拆列为 lifecycle/deferStart 与 `Roster.fabricId` 采纳两项，引用 §2.1、Phase 0 和对应 Node delta；校验映射表至少涵盖 requirements [H8] 中每个授权范围。

#### R12-P2-4：shutdown 与 start Future 取消的终态/Promise 结果未对齐

design `§2.1:181-190` 状态表将 Starting 态 `shutdown()` 规定为取消启动并转 Closed；紧随其后的文字却称“start Future 被取消=等价 Failed 可重试”。Node delta `spec.md:17-20` 只说明并发 shutdown 胜出和无晚到网络事件，没有规定正在等待的 `start()` Promise 最终如何结束。两种取消来源可能对应不同状态，却没有区分。

**修复建议：**分别冻结 shutdown 主动取消与调用方 Future/Promise 取消的状态终点、返回值、资源清理和重试边；补 Rust/Node 表驱动测试，确保 shutdown 路径只进入 Closed，普通启动失败路径才进入 Failed。

#### R12-P2-5：新增 SDK Node delta 缺少意图/来源/时间戳头注释

`openspec/changes/home-hub/specs/sdk/node/spec.md:1` 是本轮修改的规范文件，但仍无全局 `/Users/kzf/.agents/AGENTS.md` §2 要求的顶部正交意图列表、原始需求输入和时间戳（该条文件自第 1 行直接开始 `## ADDED Requirements`）。`design.md:1-18` 虽有依据、事实底座日期和评审史，但仍没有明确维护意图列表/原始用户需求输入；文档覆盖 CLI、SDK、leases、WebUI、tray、G-3 等多个正交域，也没有声明无法拆分的原因。

**修复建议：**在 delta 和 design 文件头添加不会被 OpenSpec 消费的 HTML 注释，记录正交意图、原始需求来源（本次需求与 requirements [H8] 二次拍板，2026-09-23）及时间戳；若 design 意图无法拆分，明确不可调和的原因并持续维护。

## 5. Owner 裁决与基线终判

本轮 diff 没有修改 `server-access-roles` 文件；`openspec validate server-access-roles --strict` 通过。未发现 alias、邀请码、敲门、WebUI 冻结面或 renew/first_registered_at 契约被本轮放宽。[H8] 对 deferStart 与 fabricId 采纳的授权原文已存在；但 SDK seed 供给入口尚无 API/授权说明，不能用 [H8] 的 fabricId 授权推定另一项 seed API 已获批。

| 裁决 | r12 终判 |
|---|---|
| H0 | **部分**：Custom relay 与 deferStart 首触时序仍冻结；root 同 seed 未形成可调用供给路径。 |
| H1 | **设计满足**：短码 wire 与 golden vectors 未变；跨端对拍仍是实现期义务。 |
| H2 | **设计满足**：tray 版本化事件/RPC 契约未变；真实壳 acceptance 待交付。 |
| H3 | **设计满足**：平台范围、显式启动、autostart owner 与 stop 联动约束未变；平台 acceptance 待交付。 |
| H4 | **设计满足**：webui core/薄壳、注入 opener 与 hub 管理入口约束未变。 |
| H5 | **设计满足**：三视角、租约/到访语义与 member sidecar 边界未变。 |
| H6 | **设计满足**：alias 只消费显示、不改服务端契约。 |
| H7 | **部分**：多租约/写锁机制未变；join lease 与 SDK root 身份连续性未证明。 |
| H8 | **部分**：fabricId 采纳已明文获批，deferStart 已有映射；映射表未列 fabricId，seed 注入/目录供给边界未冻结。 |

### 十条不可回退基线

| # | 基线 | r12 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 保留。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL / 未转正**：CustomWithCaps/deferStart 时序有设计约束，但 join root 与 SDK endpoint 尚无可执行同 seed 供给闭环；真实受限 relay 首触带票仍待实现证据。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**：沿用既有接管与数据目录约束。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**：本轮未改写宿主生命周期约束。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**：锁/写者契约未变；身份 tuple 连续性由基线 2 阻塞。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**：本轮未改写安全边界。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；CLI/WebUI 对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL（实现证据待交付）**：G-3 范围与口径冻结；300 秒实验、relay-only 对照或六字段 NOT-EXECUTABLE 记录仍须完成。 |

## 6. 设计结论与实现期义务

**设计层 NOT-READY，7.8/10。** r11-P1-2 已闭合；r11-P1-1 只把共同 seed 写成规范，没有定义 SDK 如何取得该 seed，仍为 P1。R11-P2-1/2 的 createRoot 复用语义和 lifecycle cancellation 结果仍有缺口，另有 Scenario 顺序、[H8] 索引和文件元数据问题。基线 2、10 保持 CONDITIONAL。

进入实现前的阻塞闭环：

1. 决定同 seed 的可执行路径：限制 SDK roster dataDir 与 DWEB_HOME 相同，或定义明确且获授权的安全 seed 注入 API；同步 design、leases、Node delta 与端到端 Scenario。
2. 将 tuple 正向 Scenario 统一为 `CLI join/register → SDK createRoot/open → root 断言 → ensure/start/connect`，验证 fresh 与 reopen。
3. 冻结已有 roster 下 createRoot/open 行为和 start 取消状态/Promise 结果，并添加相应 Scenario。
4. 更新 [H8] 机制映射与 Node delta 顶部意图元数据。

设计闭合后仍需实现期证据，尤其是基线 2/10 转正条件：

1. **身份连续性与 Restricted relay：** join register body、leases.json、SDK roster 的 `(fabric_id, root)` 三方相等；错误 seed/目录/stale roster 在首拨前拒绝；CustomWithCaps 真实受限 relay 握手通过，无票、跨 server capability 与 malformed 输入按契约失败；首次 relay 接触观测确认携带已签票据。
2. **deferStart/fabricId 生命周期：** Rust 构造期零网络出站；Node 缺省 eager 行为回归；fabricId 64hex、缺省随机、持久化读回和冲突拒绝；状态转移、并发 start、shutdown 竞态及取消结果由 Rust/Node 测试覆盖，并验证 d.ts fixture。
3. **G-3（基线 10 转正）：** 仅 `relay_failover.rs` test-only；先证 Direct，停止整个 server/hub，300 秒双向零中断，停机期间新 join 失败，重启恢复；relay-only 对照或按六字段模板记录客观 NOT-EXECUTABLE 条件，产品文案保持“依网络环境”。
4. **其余验收：** darwin/Windows 自启与 stop 真实账户记录、member sidecar 负向矩阵、短码 CLI/WebUI 对拍、tray 真实壳 acceptance。strict validation 和单测不能代替这些证据。
