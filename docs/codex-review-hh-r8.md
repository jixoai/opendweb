# home-hub 设计层复审 r8

评审基点：`HEAD 388636fc3e585322d15776ad38bf31a01f299e3c`（2026-09-23）。
对照基点：r7 报告 `docs/codex-review-hh-r7.md`（`510d2fd`，NOT-READY 7.8/10）。
范围：核验 r7 唯一 P1 的 v8 修订、相关 delta、SDK/Fabric 构造生命周期和 r7 残留 P2；不把历史轮次报告当作当前代码证据。除本报告外未修改仓库文件。

## 1. 结论与评分

结论：**NOT-READY，7.9/10（较 r7 +0.1）**。

v8 已把 register、lease 与 capability 使用的 `(fabric_id, root)` 唯一来源冻结到 SDK roster 实际值，并补上 tuple 连续性断言及正负 Scenario，r7 的 unknown-owner 缺口闭合。但新约束“`ensureRelayCapabilities()` 完成后才允许首次 relay 拨号”没有覆盖 SDK `createRoot/open` 的构造期网络启动：SDK 在 factory 返回前已 `bind`，并等待 `endpoint.online()`；若既有 `relay.caps.json` 或 RelayEntry 带有可注入票据，relay Map 会在 `ensureRelayCapabilities()` 前含票，构造期可能已连接 relay。设计允许 `open` 既有 root，却没有冻结缓存票据的前置条件或延迟拨号机制。因此该顺序对允许的生命周期并非普遍成立，不能设计层 GO。

| 维度 | r7 | r8 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.7 | 8.7 | 本轮目标 tuple 闭环已覆盖；首拨顺序仍使 H0 入网链未完全可证。 |
| 基线契约与 supersedes | 8.2 | 8.2 | 未发现新增对 server-access-roles 冻结面的覆盖或放宽。 |
| 三方一致性 | 7.8 | 8.5 | design 与 leases delta 已同步 roster tuple；open Scenario 尚未同步覆盖。 |
| 技术可实现性 | 6.8 | 7.0 | 身份来源修复；SDK 构造期 relay 生命周期仍与“ensure 后首拨”有条件冲突。 |
| Spec 可测性 | 8.0 | 8.1 | tuple 正负 Scenario 可测；未覆盖 open/cached-capability 构造期首拨。 |

总分上升 0.1，反映 r7 的核心身份分叉已闭合；仍有新的 P1 生命周期缺口，故结论维持 NOT-READY。

## 2. 验证证据

### 实际阅读

- `docs/codex-review-hh-r7.md` 与 v8 提交 `388636f` 的父提交、提交说明和实际 diff。
- `openspec/changes/home-hub/design.md` §2.1、§10；`openspec/changes/home-hub/specs/cli/leases/spec.md` Requirement 与 tuple Scenario。
- `packages/opendweb/src/join.mjs`、`packages/opendweb/src/device-key.mjs`、`packages/opendweb/package.json`：核对现状 join 的 fabric_id/设备 seed 生成路径及 CLI 包依赖。
- `packages/client-sdk/index.d.ts`、`packages/client-sdk/src/fabric.rs`：核对 `Fabric.createRoot/open`、tuple getter、`ensureRelayCapabilities` 与 seed handle API。
- `crates/dweb-fabric/src/fabric.rs`：核对 `create_root/open/start`、CustomWithCaps RelayMap 初始化、缓存票据加载和 ensure 注入；`iroh-1.1.0/src/endpoint.rs`：核对 `online()` 语义；`iroh-relay-1.1.0/src/relay_map.rs`：核对 RelayMap 空表/初始化行为。
- `openspec/changes/server-access-roles/specs/server/spec.md` 的 owner tuple/capability 冻结语义沿用 r7 已核验结论；本轮未重开其余安全面。

### 实际命令与结果

- `git status --short --untracked-files=all`（报告创建前）：工作树干净。
- `git rev-parse --short HEAD`、`git log -5 --oneline --decorate`：HEAD=`388636f`，父提交=`510d2fd`。
- `git diff --check 510d2fd..HEAD -- openspec/changes/home-hub/design.md openspec/changes/home-hub/specs/cli/leases/spec.md`：通过。未把已存档的 r7 报告纳入此项门禁。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- `git diff --unified=10 510d2fd..HEAD -- openspec/changes/home-hub/design.md openspec/changes/home-hub/specs/cli/leases/spec.md`：确认 v8 只新增/同步 tuple 同源条款、Scenario 与处置记录。

本轮未运行 SDK/Rust 测试、restricted relay 实际握手、G-3 300 秒对拍、平台自启或 UI/tray acceptance；这些是实现期证据，不作为本设计结论的通过项。OpenSpec strict 只证明结构有效，不证明 SDK 生命周期契约可执行。

## 3. r7 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R7-P1-1 租约 tuple 与 SDK roster 不同源 | **闭合（设计）** | design §2.1 与 leases delta 都冻结 register/lease `(fabric_id, root)` 只读 SDK roster 实际值；明确同设备 seed、已有 roster 只 open、重试/重启/换 server 不另生 seed/roster；首次拨号前比较 fabric、root、capability tuple。正向 fresh 与篡改 lease/异 seed/stale roster 三种负向 Scenario 均要求首拨前拒绝且账本不变。 |
| R7-P2-1 允许 open root 但 Scenario 只测 createRoot | **未闭合** | design 和 Requirement 允许 `createRoot（或 open 既有 root）`，tuple Scenario 仍只列 fresh `createRoot`。既有 roster reopen 是重启主路径，缺少独立可测断言。 |
| R7-P2-2 attach 拒绝措辞可能误读为 SDK 全局禁用 | **闭合** | design §2.1 明确 attach/invite 成员入网是 SDK 既有机制，不在 home-hub 租约消费时序内；delta Scenario 在租约消费语境中写 attach fail-closed，未 supersede SDK 原机制。 |

## 4. 新问题清单

### P0

无。

### P1

#### R8-P1-1：SDK 构造期可能先拨号，违反 ensure-before-first-dial

**证据链：**

1. home-hub design §2.1（约 160-193 行）及 leases delta（约 7-22 行）要求：先 `createRoot/open`，再 `await ensureRelayCapabilities()`、核对同一实例 RelayMap，之后才允许首次拨号。
2. `Fabric::create_root` / `Fabric::open` 在 Rust SDK 中都会先调用 `Self::start(...)`，只有 `start` 返回后 JS factory 才能返回 Fabric 对象；见 `crates/dweb-fabric/src/fabric.rs:1719-1731,1736-1751` 及 `packages/client-sdk/src/fabric.rs:435-447`。
3. `start` 会从 `<data_dir>/relay.caps.json` 加载持久票据；CustomWithCaps 分支把持久票据及 `RelayEntry.local_token()` 注入 RelayMap，然后 `bind()` 并等待 `endpoint.online()`；见 `crates/dweb-fabric/src/fabric.rs:1825-1872,1899-1905`。SDK `online()` 文档明确其返回表示“已连接至少一个 relay”，见 `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/iroh-1.1.0/src/endpoint.rs:1347-1366`。
4. 只有 Fabric factory 返回后，调用方才能 `ensureRelayCapabilities()`；该方法才签发 root capability 并注入同一 RelayMap，见 `crates/dweb-fabric/src/fabric.rs:2282-2325`。所以干净 fresh data_dir（无缓存票据）可能因空 Map 而等待后再 ensure；但允许的 `open` 既有 root 若已有目标 relay 缓存票据，则可在 ensure 前先建立 relay 连接。design/spec 未要求拒绝或隔离此状态，也没有 deferred-start 构造入口。
5. 这不是“ensure 已经在后台完成”的等价顺序：缓存票据可能过期、属于不同 server/fabric，构造期会先以旧票据连接或被拒；更重要的是契约明确要求首次拨号前完成当前租约 tuple 的 capability 覆盖断言。

```text
home-hub caller       SDK createRoot/open       start() / Endpoint          ensure()
     |                       |                         |                       |
     |---------------------->|                         |                       |
     |                       |-- load relay.caps.json->|                       |
     |                       |-- inject cached token -->|                       |
     |                       |-- bind + online() ------>|-- possible connect -->|
     |<----------------------|  only after start() returns                       |
     |------------------------------------------------------------------------->|
     |                       first-dial MUST be after ensure, but may precede it |
```

**可验证修复建议：**

- 这是设计与既定 Rust 零产品改动边界之间的真实选择，不能只靠增加一条“先检查缓存文件”的文字假设解决。优先请 Owner 裁决是否允许最小 Rust SDK 生命周期扩展：`createRoot/open` 可先得到 root roster/同实例 RelayMap，但推迟 `bind/online`；调用方完成 `ensureRelayCapabilities()` 和 tuple 断言后才启动 Endpoint。
- 若 Rust 产品改动仍严格禁止，则必须把 home-hub 的启动前置条件收窄并冻结：任何 SDK 会自动加载 bearer token 的数据目录都不得进入 `createRoot/open`；非空 `relay.caps.json` 或含 `RelayEntry.token` 时，在构造前 fail-closed 且原文件不动。还须明确同一设备 seed 与专用 roster/capability 目录如何隔离、如何跨重启复用，不能以删除/暂存用户票据绕过。
- 在 leases delta 增加故障注入 Scenario：①`open` root 且有目标 relay 的旧/错误缓存 capability；②`open` root 且有同 URL 但不同 server_id 的票据；③存在其它 URL 的缓存票据。断言在构造前拒绝、无任何 relay 拨号/握手、leases 不变；允许启动的路径则断言 capability 注入和 tuple 校验先于第一次 `bind/online`。当前接口若不能观测/保证该顺序，Scenario 应保持失败，不能把后续 restricted 握手成功作为替代。
### P2

#### R8-P2-1：open 既有 root 缺少身份连续性正向 Scenario

设计允许 `open` 重用 roster，但 Scenario 的正向项只覆盖 `fresh createRoot→register→ensure→restricted handshake`。建议增加 reopen 路径：相同 `data_dir`/seed/open 后 register 与 lease tuple 不变、重签/恢复 capability 后握手成功；错误 seed 或目录仍在首拨前拒绝。该项不替代 R8-P1-1 的缓存票据前置条件。

#### R8-P2-2：新增身份/拨号顺序仍以长段落承载

`~/.agents/AGENTS.md` §2 要求设计文档以 ASCII 数据流/状态图为主。v8 新增的 create/open→roster tuple→register/lease→ensure→首次拨号链仍是长段 prose。可在 design §2.1 增一张短 ASCII 流程图，并标出构造期 `bind/online` 与缓存票据的 fail-closed 闸门；此项不影响契约内容，但能让先后关系及失败边界可审查。

## 5. H0-H7 与基线契约

本轮范围内，v8 tuple 修订不改变裁决覆盖映射；H0 因 R8-P1-1 暂列部分满足，其余沿用 r7 已逐条核验的设计承载状态：

| 裁决 | 设计机制 | r8 终判 |
|---|---|---|
| H0 | hub 包装层、数据面零改动、Custom relay 入网、条件化 G-3 | **部分**：tuple 同源闭合；ensure-before-first-dial 在 open/cached-capability 路径未成立。 |
| H1 | 二维码/短码/手动地址与冻结 wire vectors | 设计承载满足；跨端实现对拍待交付。 |
| H2 | 可选 tray 插件、心跳、双 IPC 模式 | 设计承载满足；真实壳 acceptance 待交付。 |
| H3 | 显式 init、restricted、darwin+win 自启、默认不启动 | 设计承载满足；平台 acceptance 待交付。 |
| H4 | core/薄壳、注入 opener、hub open | 设计承载满足；sidecar/browser acceptance 待交付。 |
| H5 | 三视角、member 分流、leases/visits 隔离 | 设计承载满足，未见 v8 改动引入冻结面冲突。 |
| H6 | hostname alias 消费，不改首写/续期语义 | 满足。 |
| H7 | leases.json 0..N、组 B 命名、`opendweb hub` 族 | tuple 唯一数据源现已明确；首拨顺序仍受 R8-P1-1 阻塞。 |

server-access-roles 的三角色、邀请码/敲门、`/admin/*` Bearer、renew 顺延、`first_registered_at`、H6 alias、member sidecar 冻结面未发现新增 supersedes 或冲突。需要实现时遵守其 `(fabric_id, issuer)` owner 精确匹配，不能用“relay 曾在线”替代 tuple/capability 核验。

## 6. r1 十条不可回退基线终判

| # | 基线 | r8 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 保留。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：tuple 同源已闭合；首拨前 capability 覆盖仍需修正 R8-P1-1 并由 restricted 正负握手验证。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；实现对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL**：设计条件与测试义务已冻结；300 秒 test-only 对拍和六字段验收记录尚未执行。 |

## 7. 设计结论与实现期义务

**设计层 NOT-READY 7.9/10。** r7 的 P1 已闭合；当前唯一 P1 是 SDK 构造期 `bind/online` 与“先 ensure、后首拨”未对齐。补齐既有 root 缓存票据前置条件及负向 Scenario，或获 Owner 批准增加 deferred-start SDK API 后，若无新的 P0/P1，可转为设计层 GO。此结论不等于实现或发布已通过。

实现期义务（包括基线 2/10 的 CONDITIONAL 转正条件）：

1. 实现 `createRoot` 与 `open` 两条路径；证明 register body、lease、roster、root identity 和 capability 始终是同一 tuple。错误 seed、异 data_dir、篡改 lease/stale roster 必须首拨前 fail-closed 且账本不变。
2. 落实并测试 R8-P1-1 的缓存票据闸门。至少记录 SDK factory 返回前的 RelayMap 内容、`endpoint.online()` 结果、relay server 收到的首个握手时刻；证明任何负向路径均在首次拨号前拒绝。若批准 deferred-start API，则证明 capability 注入同一实例后才 bind/online。
3. 在 restricted relay 实测有效票成功、无票 `dweb/no-capability`、跨 server capability 拒绝、错误/旧缓存票不会先拨号；同时验证 relay disabled/null/非法 URL preflight 不发 register或明确远端补偿状态。
4. G-3 test-only 对拍：先证明 Direct；停整个 server/hub 进程、保持 300 秒窗口、停机期新 join 失败、重启后自动恢复；relay-only 对照不可行时提交六字段 NOT-EXECUTABLE 记录和“依网络环境”时限文案。Rust 产品代码不在本 change 许可范围内。
5. 交付两平台 autostart/stop、member sidecar 真实账户 acceptance、短码 CLI/WebUI 对拍、tray 两宿主 acceptance；按既定格式提交 `docs/acceptance-*.md`，不得以 strict validation 或单测快照代替。
