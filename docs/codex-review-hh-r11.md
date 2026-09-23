<!--
Intent: home-hub r11 design readiness review
Original request: r11 re-review against HEAD 484e1ab; verify r10 findings, new contradictions, and ten baselines.
Timestamp: 2026-09-23 Asia/Shanghai
-->

# home-hub 设计层复审 r11

评审基点：`HEAD 484e1abb5d5f946c258f3b32b63241d490f43a59`（2026-09-23）。
对照基点：r10 `9dfa0c08389f13e37502a1309f887d2fa7ac7aef`，r10 结论 NOT-READY 7.8/10。
范围：核验 r10 的 1 条 P1、2 条 P2；检查 v11 tuple 供给反转、SDK Node delta、生命周期转移表及 [H8] 授权映射；按 r1 十条基线复核设计状态。只读评审，除本报告外未修改仓库文件。

## 1. 结论与评分

结论：**NOT-READY，7.7/10（较 r10 -0.1）**。

v11 把 `fabric_id` 的生成职责明确交还 CLI，并新增 SDK `fabricId` 采纳契约和 Node delta；状态操作表也覆盖了五态下的 `start/ensure/shutdown`。但 tuple 是 `(fabric_id, root)`：CLI 的 `root` 来自 `<DWEB_HOME>/identity.key`，SDK 的 `endpointId()` 来自 `FabricOptions.dataDir/identity.key` 或显式 seed；设计没有冻结二者共用同一 seed，也没有端到端断言 `register.root == lease.root == SDK endpointId()`。因此 r10 的身份连续性阻塞只从 `fabric_id` 移到了 `root`，并未整体闭合。另一个新增 API `FabricOptions.fabricId` 改变 dweb-fabric roster 身份持久化语义；当前 [H8] Owner 裁决只明示 deferStart 生命周期扩展，未明示该 roster 扩展授权。

| 维度 | r10 | r11 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.9 | 8.6 | [H8] 生命周期扩展已映射；fabricId 持久化采纳是额外的 Rust 产品语义，未见 Owner 裁决。 |
| 基线契约一致性 | 8.2 | 8.0 | 无 server-access-roles 冻结面放宽；tuple 的 root 连续性仍未冻结。 |
| 三方一致性 | 7.8 | 7.5 | fabricId 已对齐；CLI root seed 与 SDK data_dir seed、createRoot/open 路径仍缺桥接约束。 |
| 技术可实现性 | 7.3 | 7.3 | 生命周期表更完整；同 seed 入口及取消结果仍有缺口。 |
| Spec 可测性 | 8.0 | 8.1 | 新增 Node Requirement/Scenario 和表驱动测试义务；尚无 root 三方相等断言，少数状态边语义冲突。 |

总分较 r10 下降 0.1：Node API delta 与操作矩阵补齐是实质进展，但 r10 唯一 P1 只对 `fabric_id` 闭合，完整 `(fabric_id, root)` 仍不可证明；[H8] 的授权边界也需要明确。

## 2. 验证证据

### 实际阅读

- `docs/codex-review-hh-r10.md`：逐项对照 r10 发现和十条基线。
- `openspec/changes/home-hub/requirements.md` [H8]（104、110、113）；`design.md` §0、§2.1、§9、§10；`specs/cli/leases/spec.md` tuple 与正反 Scenario；新增 `specs/sdk/node/spec.md` 两项 Requirement 和 Scenario。
- 当前事实代码：`packages/opendweb/src/join.mjs`（327、337、338、347）；`packages/opendweb/src/device-key.mjs`（5、29、103、107）；`packages/client-sdk/src/fabric.rs`（72、291、435、445）；`crates/dweb-fabric/src/fabric.rs`（1705、1711、1722、1736）；`crates/dweb-fabric/src/roster.rs`（204、207、220）；`packages/client-sdk/index.d.ts`（39、43、299、301）。
- 基线文件：`openspec/changes/server-access-roles/` 的当前 delta/设计及其 strict validation；[H8] 原文逐条核对，而非采信提交说明中“=[H8]”的标签。
- 全局规范 `/Users/kzf/.agents/AGENTS.md` §2：新增 SDK Node delta 的文件头意图/原始需求/时间戳要求。

### 实际命令与结果

- `git status --short --branch`（报告创建前）：工作树干净。
- `git rev-parse HEAD`：`484e1abb5d5f946c258f3b32b63241d490f43a59`，与任务给出的 HEAD 一致。
- `git rev-parse 9dfa0c0`、`git log --oneline 9dfa0c0..HEAD`：基点存在；本轮为 v11 单提交。
- `git diff --stat 9dfa0c0...HEAD`：变动仅含 r10 报告归档、home-hub `design.md`、leases delta、新增 SDK Node delta。
- `git diff 9dfa0c0...HEAD -- openspec/changes/home-hub/design.md openspec/changes/home-hub/specs/cli/leases/spec.md openspec/changes/home-hub/specs/sdk/node/spec.md`：逐段核验本轮契约变更。
- `git diff --check 9dfa0c0...HEAD`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。

未运行 Rust/Node 测试、restricted relay 握手、G-3 300 秒实验、自启或 tray acceptance。strict validation 证明 delta 结构有效，不证明 SDK 扩展获批或 CLI/SDK 身份实际一致。

## 3. r10 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R10-P1-1 tuple 供给路径缺失 | **部分闭合，整体未闭合** | design §2.1 与 leases delta 将 `fabric_id` 唯一生成点改为纯 JS CLI join，SDK 增 `FabricOptions.fabricId` 显式采纳，解决了同一 fabric ID 的供给路径。但完整 tuple 仍含 root：join 从 `<DWEB_HOME>/identity.key` 派生，SDK 默认从 `dataDir/identity.key` 派生；无共同 seed/SecretSeedHandle 传递约束，也无 register/root/endpointId 三方比较 Scenario。见 R11-P1-1。 |
| R10-P2-1 SDK Node delta 缺失 | **闭合（结构与设计）** | 新增 `specs/sdk/node/spec.md`，列明 deferStart/start、缺省 eager、Node 状态、fabricId 采纳、d.ts fixture 与 NAPI 集成测试义务；strict validation 通过。测试义务未实跑。 |
| R10-P2-2 生命周期操作矩阵不全 | **部分闭合** | design 增加 start/ensure/shutdown × 五态表，覆盖 Starting 时 shutdown 与晚到网络禁令；但 design §2.1:184 规定 shutdown 取消转 Closed，:189 又把“start Future 被取消”定为可重试 Failed，未区分取消来源，也未冻结 Node `start()` Promise 的最终结果。见 R11-P2-2。 |

## 4. 新问题清单

### P0

无。

### P1

#### R11-P1-1：root 身份没有从 CLI join 连续传递到 SDK roster

v11 只解决 tuple 中的 `fabric_id`。`join.mjs:337` 从 `<DWEB_HOME>/identity.key` 取得 seed，`:338` 计算 `rootHex`；Node SDK 的 `FabricOptions.dataDir` 是 roster 与默认 SecretStore 的路径（`packages/client-sdk/src/fabric.rs:72,291`），Rust `resolve_identity(Default)` 实际读取 `<data_dir>/identity.key`（`crates/dweb-fabric/src/fabric.rs:1711,1712`）。设计没有规定 SDK connector 的 data_dir 必须与 DWEB_HOME 相同，也没有要求通过同一 seed 的 `SecretSeedHandle` 构造 SDK。设置 `FabricOptions.fabricId` 只能对齐 roster 的 fabric id，不能改变 root endpoint 身份。

因此合法的 CLI join 可以 register `root=A` 并落 lease，而 SDK 在另一 `dataDir` 以 seed B 创建 `fabricId` 已对齐、root 却为 B 的 roster。design §2.1:204、:205 所称“两侧测试合并=全链一致性”目前只分别证明 `register body == lease` 和 `createRoot(fabricId=lease.fabric_id)` 读回 fabric id，并未证明 SDK `endpointId()==lease.root`。leases Scenario 还保留 `createRoot→register` 顺序（`specs/cli/leases/spec.md:21`），与“CLI join=唯一生成点、SDK 消费 lease 再 createRoot”的新路径不一致。

**可验证修复建议：**在 design、leases delta、SDK Node delta 中冻结同 seed 供给机制：SDK 必须使用 join 的 `<DWEB_HOME>/identity.key`（或显式以同一 seed 建立 `SecretSeedHandle`），并说明 roster `dataDir` 可独立而不能决定身份 seed。重写 fresh/reopen Scenario 为 `CLI join/register → SDK createRoot(fabricId=lease.fabric_id, 同 seed) / open → endpointId 断言 → ensure/start/connect`；断言 `register.root == lease.root == SDK endpointId()`、重启后仍相等。另一 seed/错误 data_dir 必须在注册前或首拨前 fail-closed，且不得把握手失败作为唯一检测。

#### R11-P1-2：`fabricId` roster 持久化扩展未被 [H8] 裁决明确授权

`requirements.md:110` 与 `:113` 的 [H8] Owner 裁决是允许 dweb-fabric **生命周期 API**，明确内容为 createRoot/open 推迟 bind/online；dweb-server 零改动，G-3 test-only。新增 SDK delta `specs/sdk/node/spec.md:24` 另要求 `Roster` 显式采纳 fabricId 并持久化；design §2.1:196、:197 与 §9 Phase 0a 也把它作为 dweb-fabric 扩展。该行为改变 roster 身份生成/持久化语义，不是 deferStart 生命周期本身。v11 提交说明把它标注为“=[H8]”，但 requirements 裁决原文未含此项。

这会把原先 Rust 产品代码边界进一步扩大；当前 change 的设计输入没有证明 Owner 已批准这一独立身份语义，也未说明旧 createRoot 的随机 FabricId 兼容行为如何保留在 API 上。

**可验证修复建议：**由 Owner 在 requirements 追加单独裁决（或扩充 [H8] 明文）明确允许 Roster 接受指定 FabricId、适用范围、既有 roster 冲突/打开语义及旧调用缺省行为；然后同步 Phase 0、Node delta 与测试。若无授权，则不能把这项变更归入 [H8]，应重新设计不改 roster 产品语义的桥接方案。不要只依提交说明或设计自标注作为授权证据。

### P2

#### R11-P2-1：既有 roster 的 createRoot 同 ID 语义自相矛盾

SDK Node delta `specs/sdk/node/spec.md:24` 规定：同一 data_dir 已有 roster，传入 fabricId 与之相同则“继续”；但该选项明定“仅 createRoot 生效”。当前 Rust `Fabric::create_root` 在 `crates/dweb-fabric/src/fabric.rs:1722` 检查到既有 roster 即返回 `AlreadyExists`，`Roster::create` 在 `crates/dweb-fabric/src/roster.rs:218` 也拒绝覆盖。设计 §2.1:202、:203 则规定已有 roster 只允许 open。故“同 ID 则继续”无从在 createRoot 下执行。

**修复建议：**冻结 `createRoot` 对已有 roster 一律 `AlreadyExists`；复用必须调用 `open`，由 open 后读回 ID 与 lease 比较。或者明确另加 `open(expectedFabricId)` 校验 API。补同 ID/异 ID、createRoot/open 分别覆盖的 Scenario 与 Node 集成测试。

#### R11-P2-2：start Future 取消的 Failed/Closed 结果未区分

design §2.1:184 表示 `shutdown()` 在 Starting 时取消启动并转 Closed；:189 随后规定“start Future 被取消=等价 Failed 可重试”。SDK Node delta `specs/sdk/node/spec.md:3` 与 `:19` 覆盖并发 start+shutdown，但只说 shutdown 胜出和无晚到网络事件，没有规定在途 `start()` Promise 是拒绝、resolve 还是取消，也未区分调用方丢弃 Future 与 SDK shutdown 主动取消。

**修复建议：**分别定义 caller cancellation 与 shutdown cancellation：状态终点、在途 Rust Future/Node Promise 结果、资源清理、是否允许再次 start；把每种取消源加到 Rust 与 Node 表驱动 Scenario。确保 shutdown 路径只能 Closed，普通可重试启动失败才是 Failed。

#### R11-P2-3：设计文档未满足全局意图元数据与拆分约束

新增 `openspec/changes/home-hub/specs/sdk/node/spec.md:1` 直接从 `## ADDED Requirements` 开始，没有全局 `/Users/kzf/.agents/AGENTS.md:18`、`:19` 要求的文件顶部正交意图列表、原始需求输入和时间戳；也未声明 OpenSpec 格式使该要求不可调和。修改中的 `design.md:3` 有依据说明但没有维护意图清单/原始需求时间戳；其设计域已至少横跨 CLI/服务、leases、短码、console、SDK、tray、G-3（入口如 `design.md:33,129,296,343,377,406,444`），超过单文件最多五个正交意图的约束。

**修复建议：**在新增 delta 与 design 顶部添加不被 OpenSpec 消费的 HTML 注释，列出意图、原始需求输入和时间戳；把 SDK 生命周期/API 与审查历史等正交内容拆出独立文档。若成本/工具导致暂不能拆分，按全局规则在顶部说明不可调和原因。

## 5. Owner 裁决与基线终判

home-hub v11 的实际 diff 未修改 `server-access-roles`。`openspec validate server-access-roles --strict` 通过；未发现 alias、邀请码、敲门、webui 冻结面或 renew/first_registered_at 语义被本轮改写。H8 的生命周期授权明确，但新 `fabricId` 持久化授权缺口见 R11-P1-2。

| 裁决 | r11 终判 |
|---|---|
| H0 | **部分**：Custom relay/deferStart 契约仍在；租约 root 与 SDK endpoint 身份未证明连续。 |
| H1 | **设计满足**：短码 wire 与 vectors 沿用冻结条款；跨实现对拍仍为实现义务。 |
| H2 | **设计满足**：tray 版本化事件/RPC 契约未被本轮放宽；真实壳 acceptance 待交付。 |
| H3 | **设计满足**：平台范围、显式启动、autostart owner 与 stop 联动约束未变；平台 acceptance 待交付。 |
| H4 | **设计满足**：webui core/薄壳、注入 opener、hub 管理入口约束未变。 |
| H5 | **设计满足**：三视角、租约/到访语义与 member sidecar 边界未变。 |
| H6 | **设计满足**：alias 只消费显示、不改服务端契约。 |
| H7 | **部分**：多租约与锁协议设计未变；join tuple 的 root 连续性缺少 seed 供给闭环。 |
| H8 | **部分**：deferStart 生命周期批准及 Node 映射已写；Roster.fabricId 扩展是否获批、取消竞态结果仍未冻结。 |

### 十条不可回退基线

| # | 基线 | r11 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 保留。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：首次 relay 带票时序仍有设计义务；tuple root/seed 未闭环且 fabricId 扩展授权待澄清。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；两平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**：root tuple 缺口另由基线 2 与 P1 约束。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；CLI/WebUI 对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL**：范围与条件化口径满足；300 秒实验和 relay-only 对照/客观降级记录仍为实现期交付。 |

## 6. 设计结论与实现期义务

**设计层 NOT-READY，7.7/10。** R10-P2-1 已闭合；R10-P1-1 只闭合了 fabric_id 生成/采纳，未证明 root 共用 seed；R10-P2-2 的转移表已补但取消结果仍部分缺失。R11-P1-1 与 R11-P1-2 均阻止 GO。基线 2、10 继续 CONDITIONAL。

进入实现前必须先完成以下设计裁决/闭环：

1. **身份 seed 连续性（基线 2 转正前置）**：冻结 CLI join 与 SDK createRoot/open 的同 seed 供给，补 fresh/reopen 的 `register.root == lease.root == endpointId()` 断言；异 seed/目录在安全边界前拒绝。
2. **Rust 扩展授权**：Owner 明确批准或拒绝 `fabricId` 写入 roster 的产品语义，并更新 requirements；缺少该授权不得实现此扩展。
3. **roster 复用语义**：createRoot 已有 roster 一律拒绝，open 后做 expected tuple 校验；消除 delta 中“同 ID 则继续”的不可达分支。
4. **生命周期取消语义**：区分普通启动取消/失败与 shutdown 主动取消，冻结状态与 Rust/Node 返回值，并补齐对应测试 Scenario。

设计闭合后，以下仍是实现期验证义务，不由设计层 GO 替代：

1. **deferStart**：Rust 构造期零网络出站；deferred ensure 可执行；Node 缺省保持 eager；首次 relay 接触晚于 ensure、tuple 断言且携带正确 capability；Rust/Node 每条状态转换及关闭竞态有测试。
2. **fabricId**（仅 Owner 批准后）：64 hex 验证、缺省旧行为、roster 持久化采纳/冲突拒绝、createRoot/open 读回及 d.ts fixture；不覆盖既有 roster。
3. **身份端到端**：join register body、leases.json、SDK roster 的 `(fabric_id, root)` 全等；缓存票优先级、wrong seed/stale roster fail-closed；restricted relay 正反握手和 relay 侧首触带票观测。
4. **G-3（基线 10 转正条件）**：仅 `relay_failover.rs` test-only；先证 Direct，停整个 server/hub，300 秒双向零中断，停机期间新 join 失败，重启恢复；relay-only 对照或六字段 NOT-EXECUTABLE 记录，文案限“依网络环境”。
5. **其他验收**：darwin+Windows autostart/stop 真实账户记录、member sidecar 负向矩阵、短码 CLI/WebUI 对拍、tray 真实壳 acceptance。strict validation 与单测不能代替这些证据。
