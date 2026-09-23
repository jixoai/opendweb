# home-hub 设计层复审 r9

评审基点：`HEAD 9b687e0b4084ec5713424a6eaaff67aa6bb66502`（2026-09-23）。
对照基点：r8 报告 `docs/codex-review-hh-r8.md`，基点 `388636fc3e585322d15776ad38bf31a01f299e3c`（NOT-READY 7.9/10）。
范围：核验 r8 的 1 条 P1、2 条 P2 在当前文件中的闭合度；检查 [H8] deferStart 方案、缓存票据顺序、Node CLI 可调用面及十条基线。只读评审，除本报告外未修改仓库文件。

## 1. 结论与评分

结论：**NOT-READY，7.6/10（较 r8 -0.3）**。

Owner 已批准 dweb-fabric 最小生命周期扩展，v9 也将 deferStart 五步序列和重开正向 Scenario 写入 design 与 leases delta，方向上回应了 r8 的构造期先 bind/online 问题。但仍有两个实现前设计阻塞：`start()` 在 ensure 之后加载的持久化 capability 可以通过同 URL 的 `RelayMap::insert` 覆盖刚签发的新票；此外，Rust 扩展尚未冻结如何暴露到 home-hub 使用的 Node CLI。当前 `packages/opendweb` 不依赖 client-sdk，而 Node SDK 的 options、factory 和公开类型也没有 deferStart/start，因此设计承诺的五步顺序没有已定义的调用路径。另有流程图 fence 错误，导致 design §2.1 后半大段内容被 Markdown 解析为代码块。

| 维度 | r8 | r9 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.7 | 8.8 | [H8] 的决策边界已记录；Node/CLI 落地边界及缓存票据优先级仍未冻结。 |
| 基线契约与 supersedes | 8.2 | 8.2 | 本轮未见对 server-access-roles 冻结面的修改或放宽；能力票据的本地合并仍须遵守 tuple 校验。 |
| 三方一致性 | 8.5 | 7.4 | design 与 leases delta 同步五步流程，但两者都遗漏公开 Node API；design 的 Markdown fence 破坏 §2.1 后续渲染。 |
| 技术可实现性 | 7.0 | 6.7 | deferStart 可解决构造先拨号，但 start 的缓存注入可覆盖 ensure 结果，且 CLI 使用入口未定义。 |
| Spec 可测性 | 8.1 | 7.7 | 已补构造期零出站和 open 重开 Scenario；尚无缓存覆盖、Node API、start 生命周期失败/并发测试要求。 |

总分下降 0.3：Owner 已选择修复路线，但当前设计未证明这条路线可由本 change 的 CLI 按指定顺序调用，也未消除 start 阶段的 capability 覆盖风险。

## 2. 验证证据

### 实际阅读

- v9 提交 `9b687e0`、父提交 `388636f`、提交说明与实际 diff；r8 报告 `docs/codex-review-hh-r8.md`（用于逐条映射既有问题和十条基线）。
- `openspec/changes/home-hub/requirements.md` [H8]；`design.md` §0、§2.1、§9、§10；`specs/cli/leases/spec.md` requirement 与 Scenario。
- `crates/dweb-fabric/src/fabric.rs`：`create_root/open`、内部 `start`、`load_relay_caps`、`RelayMap` 构造及 `ensure_relay_capabilities`；`packages/client-sdk/src/fabric.rs`、`packages/client-sdk/index.d.ts`：Node FabricOptions、工厂、ensure 方法与公开类型。
- `packages/opendweb/package.json`、`src/device-key.mjs`、`src/join.mjs`：CLI 当前依赖、为何不直接拉起 NAPI 网络栈、join 的现有身份/注册流程。

### 实际命令与结果

- `git status --short`（报告创建前）：工作树干净。
- `git rev-parse HEAD`、`git rev-parse 388636f`、`git log -4 --oneline --decorate`：HEAD=`9b687e0`，对照基点=`388636f`。
- `git diff --no-ext-diff --name-status 388636f..9b687e0`：新增 r8 报告存档；修改 `design.md`、`requirements.md`、`specs/cli/leases/spec.md`。
- `git diff --check 388636f..9b687e0`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：`Change 'server-access-roles' is valid`。
- `rg -n '^```' openspec/changes/home-hub/design.md`：发现 §2.1 行 211 的 fence 带正文，非合法关闭行。

未运行 Rust/Node 测试、restricted relay 握手、G-3 300 秒实验、平台自启或真实账户 acceptance；本报告只判设计契约，不把 strict validation 当作运行时证明。

## 3. r8 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R8-P1-1 SDK 构造期 bind/online 先于 ensure | **部分闭合，仍阻塞** | v9 改为 deferred 构造→ensure→断言→start→拨号，并获 [H8] 授权。但 start 随后加载缓存票据，可能以同 URL 旧 capability 覆盖 ensure 的新票；Node SDK/CLI 公共调用面也未规定。详见 R9-P1-1、R9-P1-2。 |
| R8-P2-1 open 既有 root 正向 Scenario 缺失 | **闭合（设计）** | leases delta 已增加同 data_dir/seed 下 `open(deferStart)→ensure→断言→start→connect` 正向路径，并要求 tuple 与首次一致及错误 seed 首拨前拒绝。 |
| R8-P2-2 身份/拨号链缺流程图 | **部分闭合** | 已新增图，但使用 Unicode 线框字符；关闭围栏写成 ```` ```端到端断言... ````，导致 §2.1 后续内容到 design.md:339 被当作代码块。 |

## 4. 新问题清单

### P0

无。

### P1

#### R9-P1-1：start 加载的缓存 capability 可覆盖刚签发的新票

design §2.1 第 ②③ 步先执行 `ensureRelayCapabilities()` 并注入同一实例的 RelayMap，第 ④步才调用 `fabric.start()`；第 ④步又明确执行“加载缓存票据+注入+bind+online”。当前 SDK 的 `inject_relay_tokens` 对同 URL 调用 `RelayMap::insert`，后写值替换原值（`crates/dweb-fabric/src/fabric.rs:75-87`）。`load_relay_caps` 只校验 token 格式和过期，不校验 capability 的 fabric、issuer、server tuple（同文件 `:432-475`）。因此已有 `<data_dir>/relay.caps.json` 中同 URL 的旧票可能在 start 时覆盖 ensure 刚签的 own capability；错误 server/fabric 的票会使受限 relay 握手失败，违背“首次 relay 接触已带租约对应有效票”的设计承诺。

**可验证修复建议：**冻结缓存与本次签发的合并优先级：对租约目标 `(relay_url, fabric_id, issuer/root, server_id)`，当前调用成功签发且已断言的 token 必须优先，后续 start 不得覆盖；旧缓存 token 先 decode 并校验完整 tuple，不匹配则拒绝或忽略并留下可诊断结果。将无网络的缓存读取/初始化放在 ensure 前，或在 start 中做 tuple-aware merge，不能简单按插入先后覆盖。增加 Scenario：目标 URL 的旧票分别属于错误 server、错误 fabric、错误 issuer，以及同 tuple 的过期/有效票；逐一断言 start 后 RelayMap 中仍为匹配本次租约的票，并由 relay 侧观测第一次连接携带该票。负向路径不得先拨号或写租约。

#### R9-P1-2：[H8] 扩展未冻结 CLI 可调用的 Node API 与依赖路径

[H8] 只授权 dweb-fabric 增加可延迟 bind/online 的生命周期 API。home-hub 五步却要求 CLI 调用 `createRoot/open(deferStart)`、`ensureRelayCapabilities()`、`fabric.start()`。当前 `packages/client-sdk/src/fabric.rs:71-84,435-458` 的 FabricOptions 无 `deferStart`，`Fabric` 无公开 `start()`；`index.d.ts:41-80` 也没有相应参数/方法。当前 `packages/opendweb/package.json:9-14` 没有 client-sdk 依赖，`src/device-key.mjs:1-5` 明确说明 CLI 不引入会拉起 iroh 网络栈的 NAPI 工厂。design §9 的 Phase 1 只泛称“join 改造”，没有冻结何处新增 Node 桥接或依赖。因此 Rust crate 内的 deferred API 本身不足以让 home-hub join/租约消费调用五步顺序。

**可验证修复建议：**在 design 和 delta 中明确桥接边界：Node `FabricOptions.deferStart`、仅对 `createRoot/open` 生效的行为、NAPI `Fabric.start()`、生成的 `.d.ts` 更新，以及 CLI 对 client-sdk 的依赖/加载方式；说明既有默认 factory 是否保持 eager-start。若为了 CLI 包大小/冷启动不引入 NAPI，则须设计可验证的替代 Node/Rust helper 入口，不能只留下 Rust crate 私有扩展。增加端到端 CLI Scenario 证明 home-hub 实际使用该入口且操作顺序确为 zero-outbound→ensure→tuple 断言→start→首次接触；Node API 缺失时该 Scenario 应失败。

### P2

#### R9-P2-1：流程图 fence 未闭合，设计正文渲染错位

`design.md:198` 开启 ` ```text`，但 `:211` 行是 ```` ```端到端断言：... ````，不是 Markdown fence 关闭行；后续 §2.1 内容一直被吞进代码块，直至 `:339` 才遇到合法 fence。**修复：**把关闭围栏独立为一行三个反引号，再将“端到端断言”放到围栏外；跑 Markdown 渲染/结构检查，确认 `expires_at`、租约写协议、§3 短码等均恢复为正文。

#### R9-P2-2：新增图不是 ASCII 图

design §2.1 新图仍含 `─`、`│`、`←`、`├` 等 Unicode 字符，未满足 r8-P2-2 所依据的全局文档规范。**修复：**换成纯 ASCII `- | <- +` 并保持失败分支可读；对该代码块执行 ASCII 检查。

#### R9-P2-3：deferred Fabric 的完整生命周期状态语义未冻结

当前只写 `start()` 幂等、失败时不调用 start，但未定义并发 `start()` 的 single-flight/同结果语义、bind/online 失败后的重试或终态、deferred 状态调用 `shutdown()` 的资源清理、shutdown 后 start/ensure 的错误语义。现有 Fabric 持有必需 Endpoint 且 shutdown 会关闭它（`crates/dweb-fabric/src/fabric.rs:1117-1130,753`），deferred 需要改变这些生命周期假设。**修复：**给出最小状态机（Deferred→Starting→Started/Failed→Closed），冻结并发、失败清理/重试、重复 start 与关闭行为；为每条转换添加 Rust 与 Node 层测试。

#### R9-P2-4：[H8] 未进入裁决映射和任务分解

design §0 的裁决映射表只列至 [H7]，但文首依据已扩展为 [H0]-[H8]；§9 Phase 1 也未单列 Rust crate、NAPI/Node 类型、CLI 集成及其测试任务。虽然 §2.1 写了 deferStart 契约，读者无法从映射/执行拆解检查 H8 是否交付完整。**修复：**在 §0 增 H8→deferStart/API bridge/测试映射；在 §9 增可验收的实现任务，并声明 dweb-server 零改动、G-3 仍 test-only。

## 5. H0-H8 与基线契约

本轮只对照 r8 报告已核验的 H0-H7/基线，并重点检查新增 H8；未重开无关历史裁决。`server-access-roles` 本轮严格校验通过且 v9 diff 未改其文件；其三角色、root 自签 capability/server 只验票、续期和 alias 冻结语义不因此 supersede。

| 裁决 | 设计机制 | r9 终判 |
|---|---|---|
| H0 | hub 包装层、Custom relay 入网、条件化 G-3 | **部分**：deferStart 写入设计，但缓存票覆盖风险和 CLI API 桥接未闭合，首拨前凭证承诺仍不可证。 |
| H1 | QR/短码/手动地址及冻结 wire vectors | 设计条款沿用 r8，设计层满足；跨端实现对拍仍是实现期义务。 |
| H2 | tray 插件、心跳与版本化 IPC | 设计条款沿用 r8，满足；真实壳 acceptance 待交付。 |
| H3 | 显式 init、restricted、darwin+win、自启与默认不启动 | 设计条款沿用 r8，满足；平台 acceptance 待交付。 |
| H4 | webui core/薄壳、注入 opener、hub open | 设计条款沿用 r8，满足；sidecar/browser acceptance 待交付。 |
| H5 | 三视角、member 分流、leases/visits 隔离 | 设计条款沿用 r8，满足。 |
| H6 | hostname alias 消费，不改服务端既有语义 | 设计条款沿用 r8，满足。 |
| H7 | leases.json 0..N、组 B 命名、hub 命令族 | tuple 同源和 open 重开 Scenario 保留；依赖 H0 的凭证时序仍受 R9-P1-1/2 阻塞。 |
| H8 | 允许 dweb-fabric 最小 deferStart 生命周期扩展；server 零改、G-3 test-only | **部分**：Owner 决策及 Rust 方向已存档；缓存优先级、Node/CLI 公共入口和状态语义未冻结。 |

## 6. r1 十条不可回退基线终判

| # | 基线 | r9 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 保留。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：relay capability 顺序虽有设计，但缓存覆盖和 CLI 可调用入口未闭合；需通过 restricted 正负握手与 no-token 暴露测试转正。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；实现对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL**：设计条件与 test-only 边界保留；300 秒实验、relay-only 对照/降级记录仍须实现期交付。 |

## 7. 设计结论与实现期义务

**设计层 NOT-READY 7.6/10。** R8-P2-1 已闭合；R8-P1-1 仅部分闭合，R8-P2-2 的图已加入但 fence 和 ASCII 规范未满足。当前仍有两项 P1：启动后加载的旧缓存可能覆盖新签 capability；dweb-fabric 扩展尚未定义 Node SDK/CLI 调用路径。因此不满足“无新 P0/P1”的 GO 条件。

实现期开工前应先把以下内容补成规范；实现/发布时则须以独立证据验证：

1. **生命周期 API**：实现 deferStart createRoot/open；Node NAPI Options、`Fabric.start()` 和类型声明与 CLI 调用入口同步。deferred 构造无任何网络出站；`ensureRelayCapabilities` 可在该态使用；既有非 deferStart 调用语义按冻结契约保持。
2. **Capability 合并优先级（基线 2/10 转正条件）**：缓存解析必须对目标 URL 的 fabric/issuer/server tuple 做校验；本次租约匹配的新签 capability 在 ensure 和 start 全链中优先。测试同 URL 错 server/错 fabric/错 issuer/过期票及有效同 tuple 票，证明 start 后 map 与首个 relay 请求均用正确票。
3. **生命周期状态机**：证明并发/重复 start 幂等、失败收尾或重试语义确定、deferred/failed/started 状态 shutdown 正确、关闭后操作 fail-closed；Rust 与 Node API 两层均覆盖。
4. **tuple 连续性**：fresh createRoot 与 reopen 同一 root 两条路径中，register body、SDK roster、lease、root identity 与 capability tuple 一致；异 seed、异目录、篡改 lease/stale roster 在首拨前拒绝且账本不变。
5. **受限 relay 端到端**：有效 capability 成功握手、无票 `dweb/no-capability`、跨 server capability 拒绝；捕获首个 relay 接触时序，证明发生在 ensure 与 tuple 断言之后。relay disabled/null/非法 URL preflight 不发 register，或按既有幂等补偿语义明确报告远端状态。
6. **G-3（基线 10/10 转正条件）**：仅新增 `relay_failover.rs` test-only 用例；先证 Direct，停整个 server/hub、保持 300 秒窗口、停机期间新 join 失败、重启后恢复。relay-only 对照不可行时提交六字段 NOT-EXECUTABLE 记录及“依网络环境”时限文案，不宣称已断言。
7. **其余发布验收**：按既有文档完成两平台 autostart 生命周期、member sidecar、短码 CLI/WebUI 对拍、tray 壳 acceptance；strict validation、生成物快照或单测不替代真实账户/平台证据。

当 P1-1/2 对应规范补齐、H8 映射与任务分解修正、Markdown fence/ASCII 图修复后，可重新评估设计层 GO；设计 GO 不等于上述实现期义务已经通过。
