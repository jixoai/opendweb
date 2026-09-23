# home-hub 设计层复审 r10

评审基点：`HEAD 9dfa0c08389f13e37502a1309f887d2fa7ac7aef`（2026-09-23）。
对照基点：r9 报告 `docs/codex-review-hh-r9.md`，基点 `9b687e0`（NOT-READY 7.6/10）。
范围：逐项核验 r9 的 2 条 P1、4 条 P2；复查 v10 对 H8/deferStart 的扩展是否与 home-hub join、SDK Node 契约及现有基线相容；终判 r1 十条不可回退基线。只读评审，除本报告外未修改仓库文件。

## 1. 结论与评分

结论：**NOT-READY，7.8/10（较 r9 +0.2）**。

v10 已把 `start()` 的 ensured-vs-cache 优先级、Node NAPI 的 `deferStart/start` 入口、生命周期测试义务、ASCII 流程图和 H8/Phase 0 映射写入 design；多数 r9 文档问题已闭合。但仍有一条设计级 P1：租约要求 `opendweb join` 的 register tuple 只能来自 SDK roster 实际值，而 join 当前是无 NAPI 的独立 CLI 命令；v10 明确 CLI 不引入 NAPI，并把“连接器命令”留给未来 change，却没有冻结 join 如何创建/打开 SDK roster 并读取 tuple 的其他入口。Node API 的定义修复了“SDK 如何延迟启动”，没有修复“CLI join 如何获得唯一身份 tuple”。因此 Phase 1 join 改造目前无法按 MUST 契约执行，设计层不能 GO。

| 维度 | r9 | r10 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.8 | 8.9 | [H8] 现已映射到 Rust 生命周期、Node bridge 和 Phase 0；join tuple 获取路径仍未冻结。 |
| 基线契约与 supersedes | 8.2 | 8.2 | 未发现对 server-access-roles 冻结面的放宽；基线 2 仍被 join 身份来源阻塞。 |
| 三方一致性 | 7.4 | 7.8 | 缓存优先级与 NAPI API 已跨 design/delta 对齐；CLI join 的数据来源与依赖边界仍互斥。 |
| 技术可实现性 | 6.7 | 7.3 | deferred 时序更完整；但指定 register tuple 无 CLI 可调用的 SDK roster 来源。 |
| Spec 可测性 | 7.7 | 8.0 | 缓存及状态测试义务已增加；Scenario 没有冻结 join 的 roster adapter/API，因此无法验收真实 CLI 注册链。 |

总分上升 0.2：r9 的缓存覆盖风险和 SDK 生命周期 Node 暴露面已显著收敛，3 项文档/任务问题闭合；但身份 tuple 的消费者边界仍留下一个 P1，维持 NOT-READY。

## 2. 验证证据

### 实际阅读

- `docs/codex-review-hh-r9.md`：逐项对照 r9 发现与 r1 十条基线；不以其自评替代当前文件证据。
- `openspec/changes/home-hub/requirements.md` [H8]；`design.md` §0、§2.1、§9、§10；`specs/cli/leases/spec.md` Requirement/Scenario；核对 deferred 生命周期、缓存合并、Node bridge、任务映射及 join tuple 约束。
- `openspec/specs/sdk/node/spec.md` Fabric 生命周期与 Relay 配置条款；`packages/client-sdk/src/fabric.rs`、`index.d.ts`：现行 Node SDK 工厂、`ensureRelayCapabilities`、FabricOptions 公开面。
- `packages/opendweb/src/join.mjs`、`device-key.mjs`、`packages/opendweb/package.json`：join 当前选取 fabric ID、基于设备 seed 组装 register body，以及 CLI 不依赖 client-sdk 的边界。
- `crates/dweb-fabric/src/roster.rs`：`Roster::create` 在 Rust 内部随机生成 FabricId；`crates/dweb-fabric/src/protocol.rs`：RelayCapV1 decode 的结构解析边界；`crates/dweb-fabric/src/fabric.rs`：缓存票读取/注入、ensure 注入及 shutdown 实现事实。
- `openspec/changes/home-hub/specs/cli/hub/spec.md`、`specs/webui/spec.md`、`specs/packaging/tray-plugin/spec.md` 文件清单：确认本轮 diff 没有触碰其他 delta；`server-access-roles` 严格校验验证基线 change 仍有效。

### 实际命令与结果

- `git status --short --branch`（报告创建前）：工作树干净。
- `git rev-parse HEAD`：`9dfa0c08389f13e37502a1309f887d2fa7ac7aef`，与任务提供的 HEAD 一致。
- `git log --oneline --decorate 9b687e0..HEAD`：单个 v10 设计提交；提交说明列出缓存优先级、Node bridge、状态机及文档修复。
- `git diff --stat 9b687e0...HEAD`：仅 r9 报告归档、home-hub `design.md`、leases delta 三处；未改实现或 SDK Node 主规格。
- `git diff 9b687e0...HEAD -- openspec/changes/home-hub/design.md openspec/changes/home-hub/specs/cli/leases/spec.md`：逐段核对实际修订。
- `git diff --check 9b687e0...HEAD`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。

未运行 Rust/Node 测试、restricted relay 握手、首次 relay 接触观测、G-3 300 秒实验、真实账户、tray 或两平台自启 acceptance。strict validation 只证明 OpenSpec 结构有效，不证明新增 Node API 或 join tuple 路径已实现/可调用。

## 3. r9 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R9-P1-1 `start()` 缓存票覆盖 ensured 票 | **闭合（设计）** | design §2.1 现在冻结 ensured 票优先于 tuple 校验且未过期的缓存票；冲突时 start 不得覆盖 ensured 票。构造期非网络预检、错 server/fabric/issuer、过期/有效同 tuple 场景，以及首触带票观测均已写入 leases delta。实现/relay 观测仍是实现期义务。 |
| R9-P1-2 Node SDK 缺 deferStart/start 桥接 | **局部闭合，整体仍阻塞** | `FabricOptions.deferStart`、仅 createRoot/open 生效、缺省 eager、`Fabric.start()`、d.ts、NAPI 集成测试均已冻结；但同一 design 又要求 CLI join 读取 SDK roster tuple，明确 CLI 不引入 NAPI且 connector 留未来 change。当前没有无 NAPI 的 roster 创建/打开与 tuple 读取接口，详见 R10-P1-1。 |
| R9-P2-1 Markdown fence 损伤 | **闭合** | 当前流程图以独立 fence 行闭合，后续 Node bridge、expires_at 等恢复正文；`git diff --check` 通过。 |
| R9-P2-2 流程图非 ASCII | **闭合** | 新流程图字符为 ASCII `- | ->`；r9 指定图表问题已修复。 |
| R9-P2-3 Deferred 状态机语义 | **部分闭合，遗留 P2** | 已规定并发 start single-flight、失败可重试、Deferred shutdown 清理、Closed 后错误及 Rust/Node 双层测试；但未冻结 `Starting` 中 shutdown 与 start 的竞态胜者/收敛结果，也未完整列出每个状态允许的 close 边。 |
| R9-P2-4 H8 映射与任务分解 | **闭合（设计）** | §0 增 [H8] 映射，§9 增 Phase 0a dweb-fabric 与 0b client-sdk NAPI/d.ts/集成测试。Phase 1 仍缺 join tuple adapter 的可执行入口，这是独立 P1，不是 H8 映射遗漏。 |

## 4. 新问题清单

### P0

无。

### P1

#### R10-P1-1：CLI join 没有获取 SDK roster tuple 的已冻结路径

home-hub design §2.1 与 leases delta 要求 register body 和租约 `(fabric_id, root)` 的唯一来源是 SDK roster 实际值，并明确禁止 join 独立选择 `fabric_id`（design.md:185-200；leases spec:8）。但 v10 冻结的 Node bridge 只给 client-sdk 暴露 `FabricOptions.deferStart`/`Fabric.start()`，同时明确“CLI 不引入 NAPI 依赖”“CLI 连接器命令=未来 change”（design.md:233-239）。这并没有为现有的 `opendweb join` 注册入口提供 roster 读取能力。

当前事实与承诺间有直接缺口：`packages/opendweb/src/join.mjs:283-303` 仍从 flag/旧 `registration.json` 选取或用 JS CSPRNG 产生 `fabricId`；`:327-350` 随后用该值和 seed 派生的 root 直接签 register body。`packages/opendweb/package.json:9-14` 无 client-sdk 依赖；`packages/opendweb/src/device-key.mjs:1-9` 说明 NAPI Fabric 工厂会拉起 iroh 网络栈，故 CLI 有意不依赖它。反向看，`crates/dweb-fabric/src/roster.rs:204-224` 的 `Roster::create` 独立随机生成 FabricId，当前 Node `.d.ts` 没有纯 metadata roster factory。于是“CLI 不接 NAPI”与“CLI join 必须读 SDK roster 实值”同时成立时，没有能实现 MUST 的数据路径；当前 Phase 1 的“join 改造”不足以消除此矛盾。

**可验证修复建议：**在 design 与 delta 中冻结一个具体可调用的 tuple 供给接口并列入 Phase 0/1：优先定义无 Endpoint/network 启动的 SDK roster metadata 操作（create/open 同一 seed/data_dir，返回实际 `fabric_id/root`），明确 CLI 如何调用且保持 NAPI/CLI 依赖纪律；或由 Owner 明确裁决修改边界，允许 join 使用指定桥接并同步冷启动/网络出站承诺。不要只写“未来 connector change”，因为 join 本身负责当前 change 的 register 和 leases upsert。补 `opendweb join` 端到端 Scenario：fresh 与 reopen 两路径中，桥接返回值逐字等于 register body、SDK roster、租约 tuple；调用记录证明没有第二 seed/roster，register 失败不落账；另一 seed/stale roster 在 register 前拒绝。若不提供当前 change 内的路径，则应明确将 join/多租约入网能力移出本 change 并同步改写 H0/H7 与接受范围。

### P2

#### R10-P2-1：Node 公共生命周期 API 没有 SDK Node delta Requirement

home-hub design 和 `specs/cli/leases/spec.md` 已描述 NAPI `FabricOptions.deferStart` 与 `Fabric.start()`，但当前 home-hub `specs/` 没有 `sdk/node` delta，现行 `openspec/specs/sdk/node/spec.md:8-20` 仍只冻结工厂构造后使用与 `shutdown()`，公开类型 `packages/client-sdk/index.d.ts:41-80,298-314` 也无新选项/方法。设计层已有 API 意图，但 SDK 自身契约没有可直接对照的 Requirement/Scenario，未来实现可只满足 home-hub 文案而漏掉 Node 生命周期状态与默认行为。

**修复建议：**新增 `home-hub/specs/sdk/node/spec.md`（或明确将此 API 契约同步进 SDK Node change）并冻结 deferStart 仅 createRoot/open 生效、缺省 eager 不回归、start 幂等/并发/失败重试/关闭后错误；Scenario 覆盖 JS 可观察行为，并要求 d.ts fixture 和 NAPI 集成测试对应这些场景。

#### R10-P2-2：状态机仍缺 Starting 与 shutdown 的竞态语义

design §2.1:177-184 规定 `Starting/Started` 失败进 Failed、Failed 可重试、Closed 后操作报错，但未说明 `shutdown()` 与进行中的 `start()` 并发时是等待 start 后关闭、取消启动转 Closed，还是 start 必须拒绝；也未明确 Started 的正常 shutdown、Failed shutdown 与重复 shutdown 的完成语义。图式 `Deferred -> Starting -> Started | Failed -> Closed` 不能表达 Failed→Starting 重试和上述 close 边，文字只完整说明 deferred 态 close。

**修复建议：**给出以操作为输入的转移表，至少覆盖每个状态的 `start/ensure/shutdown`、并发 start+shutdown、start Future 被取消/底层 bind 失败、重试及 close 幂等；规定任何 shutdown 返回后不得晚到 bind/网络事件，并在 Rust 与 Node 两层分别加入竞态测试。以表驱动状态测试验证每条合法/拒绝边，而不只覆盖 happy path。

## 5. 裁决与基线契约

本轮实际 diff 不修改 `server-access-roles` 或 SDK Node 主规格；`openspec validate server-access-roles --strict` 通过。home-hub 对 restricted relay 的 CustomWithCaps、root 自签/server 只验票、租约快照、别名及 member sidecar 既有冻结面的声明未见 v10 放宽或新增 supersedes。[H8] 明确允许 dweb-fabric 最小生命周期扩展，并保留 dweb-server 零改动、G-3 test-only；v10 将该生命周期扩展映射到 client-sdk NAPI bridge 与 d.ts。该解释不扩大 server/G-3 范围，也不能替代 CLI join 的 tuple 获取路径。

| 裁决 | r10 终判 |
|---|---|
| H0 | **部分**：Custom relay 与缓存/ensure 时序已冻结；CLI join 无 SDK roster tuple 获取路径，入网闭环未闭合。 |
| H1 | **设计满足**：短码编码/解码 wire 与 vectors 沿用冻结条款；实现对拍待交付。 |
| H2 | **设计满足**：tray 双模式、版本化事件/RPC 与 golden frames 已冻结；真实壳 acceptance 待交付。 |
| H3 | **设计满足**：平台收窄、显式启动、自启 owner 与 stop 联动约束已冻结；两平台 acceptance 待交付。 |
| H4 | **设计满足**：core/薄壳、注入 opener、hub open 与 member/admin 分流已冻结。 |
| H5 | **设计满足**：三视角、租约/到访语义与 sidecar 负向矩阵已冻结。 |
| H6 | **设计满足**：alias 仅消费显示，不改服务端冻结语义。 |
| H7 | **部分**：多租约、账本锁协议和 tuple 连续性目标已冻结；当前 join 实际身份来源无可调用实现路径。 |
| H8 | **部分**：Owner 允许 dweb-fabric 生命周期扩展；缓存与 Node bridge 已冻结，但 CLI join tuple 获取路径缺失，生命周期关闭竞态还需补 Spec。 |

### 十条不可回退基线

| # | 基线 | r10 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 保留。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：缓存优先级设计已补；CLI 无 roster tuple 路径是 P1。转正需 join tuple 数据源闭环、restricted 正负握手/首触带票、无 token 暴露测试。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计；join tuple blocker 另列于基线 2）**。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；CLI/WebUI 对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL**：test-only 与条件化口径满足设计；300 秒实验、relay-only 对照/客观降级记录仍须实现期交付。 |

## 6. 设计结论与实现期义务

**设计层 NOT-READY 7.8/10。** R9-P1-1 已闭合；R9-P1-2 的 Node SDK 入口已写清，但 CLI join 仍无法从 SDK roster 取得 register 所需 tuple，R10-P1-1 阻止 GO。R9-P2-1/2/4 闭合；R9-P2-3 部分闭合并留下 R10-P2-2。基线 2 与 10 继续 CONDITIONAL。

进入实现前须先关闭 R10-P1-1，并让新的 SDK/CLI Scenario 可执行验收。实现期义务如下，不等同设计 GO：

1. **tuple 来源（基线 2 转正前置）**：实现前冻结且测试 CLI roster metadata bridge/允许的 SDK 调用路径；验证 fresh/reopen、同 seed/data_dir、register body/roster/lease/capability 四者相等，异 seed/stale roster 首拨前 fail-closed，失败不半写账本。
2. **deferStart 扩展**：Rust 构造期零网络出站；deferred 态 ensure 可执行；NAPI 缺省保持 eager、仅 createRoot/open 支持 deferStart、start 单飞且同结果、首次 relay 接触晚于 ensure 与 tuple 断言；d.ts、Node 集成测试和自定义 restricted relay 首触观测一致。
3. **缓存票合并**：错 server/fabric/issuer、同 tuple 过期与有效缓存票下，确保 start 后 RelayMap 与 relay 首触使用租约匹配票；负向路径无先行拨号/账本写入。
4. **生命周期关闭竞态**：补齐转移表并在 Rust/Node 双层覆盖 concurrent start/shutdown、失败重试、重复关闭、关闭后 start/ensure 拒绝及无晚到网络事件。
5. **G-3（基线 10 转正条件）**：仅 `relay_failover.rs` test-only；先证 Direct，停整个 server/hub，300 秒双向零中断，停机期新 join 失败，重启恢复。relay-only 对照必须尝试；不可行时交六字段 NOT-EXECUTABLE 记录和“依网络环境”文案，不声称已断言。
6. **其余 acceptance**：两平台 autostart/stop、member sidecar 真实账户、短码 CLI/WebUI 对拍、tray 真实壳 acceptance 仍按既有规范交付；strict validation 或单测不能替代这些证据。
