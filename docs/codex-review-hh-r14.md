<!--
Intent: home-hub r14 design-readiness review.
Original request: independently verify r13's single-fabric and four P2 closures at HEAD f795e19.
Timestamp: 2026-09-24 Asia/Shanghai.
-->

# home-hub 设计层复审 r14

评审基点：`HEAD f795e19e18e06ec979c3af379f53c20c9a7e4d83`。
对照基点：r13 `e93408f`，r13 结论 NOT-READY 7.8/10。
范围：核验 r13 的 P1-1 与 P2-1..4；检查 v14 新矛盾；复核十条不可回退基线。只读评审，仅新增本报告。

## 1. 结论与评分

结论：**NOT-READY，7.6/10（较 r13 -0.2）**。

v14 已把“每个 `DWEB_HOME` 一个 fabric”写成设计约束，并补了同 fabric 跨 server 正向、第二 fabric 负向、`createRoot`/`open` 分工、[H8] a/b 映射及意图元数据。可是该约束只有检查语义，没有覆盖检查到远端 `register` 及本地合并提交的并发窗口：现有锁协议只保护账本写入，两个冷启动 join 仍可同时读到“无既有 fabric”，各自生成不同 fabric 并先完成远端登记。这样既违反“第二 fabric 不 register”，也破坏“每个 DWEB_HOME 恰好一个 fabric”。这是新的 P1，设计层仍不能 GO。

| 维度 | r13 | r14 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 9.0 | 9.2 | H7 的单 fabric 范围与 H8 a/b 机制已明确；并发 admission 尚未承载。 |
| 基线契约一致性 | 7.8 | 7.7 | 与 server-access-roles 的“既有 fabric MUST 复用”对齐，但竞态仍可远端注册第二 fabric。 |
| 三方一致性 | 7.8 | 7.7 | 主流程与 createRoot/open 大体同步；两个正向 Scenario 和取消旧句仍漂移。 |
| 技术可实现性 | 7.7 | 7.5 | 单 roster 路径可实现；跨进程单 fabric admission 未定义，无法保证不产生孤儿远端登记。 |
| Spec 可测性 | 7.9 | 7.8 | 正负 Scenario 增加，但缺少并发异 fabric 的 register 次数/远端状态断言。 |

相对 r13，范围裁决更完整，但并发窗口使核心不变量不可证明，故扣分并保持 NOT-READY。

## 2. 验证证据

### 实际阅读

- `docs/codex-review-hh-r13.md`，逐项对照 r13 P1/P2。
- v14 变更：`openspec/changes/home-hub/design.md` §0、§2.1、§9、§10；`specs/cli/leases/spec.md`；`specs/sdk/node/spec.md`；`requirements.md` [H7]/[H8]。
- 基线契约：`openspec/changes/server-access-roles/specs/cli/identity/spec.md` 的既有 fabric 复用与 `--fabric` 语义。
- 实现事实：`packages/opendweb/src/join.mjs` 的 fabric 选择/注册顺序；`crates/dweb-fabric/src/roster.rs` 的单 `roster.facts`、`create` 已有文件拒绝、`open` tuple 校验与 `peek_fabric_id`。

### 实际命令与结果

- `git rev-parse HEAD`：`f795e19e18e06ec979c3af379f53c20c9a7e4d83`，与任务给出的 HEAD 一致。
- `git log -8 --oneline --decorate`：确认 HEAD 为 v14，父提交为 v13 `e93408f`。
- `git diff --name-status e93408f...HEAD`：仅 r13 报告存档及 `design.md`、leases delta、SDK Node delta 修改。
- `git diff --check e93408f...HEAD`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- 未运行 Rust/Node 测试、并发 join、真实 restricted relay、G-3 300 秒实验、自启、tray 或 acceptance；strict validation 只证明 artifact 结构。

## 3. r13 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R13-P1-1 单 roster 与多 fabric 边界 | **闭合但有新竞态 P1** | v14 明确每个 `DWEB_HOME` 恰好一个 fabric；preflight 读取既有 roster/租约，不等则 fail-closed；同 fabric 两 server 正向、第二 fabric 负向均已写入。问题是该读取没有与 register/落账组成互斥 admission，冷启动并发仍可双注册。 |
| R13-P2-1 tuple Scenario 顺序 | **部分闭合** | `design.md:251-253` 与 leases `Scenario: join 落盘...`、重开场景已体现 CLI 先、SDK 后；但 `design.md:258` 和 leases `spec.md:29` 仍写 `fresh createRoot→register→ensure`。 |
| R13-P2-2 createRoot/open 语义 | **闭合** | Node delta 明确既有 roster 下 `createRoot` 一律 `AlreadyExists`；复用统一走 `open`，并校验 fabric tuple。与 `roster.rs` 的既有文件拒绝和 decode mismatch 事实一致。 |
| R13-P2-3 取消结果 | **部分闭合** | 新三分法明确 shutdown resolve“已取消”且 Closed 不可重试、底层失败 reject/Failed 可重试、调用方不 await 不影响状态；但 design 后文仍写“start Future 被取消=等价 Failed 可重试”，形成同文矛盾。 |
| R13-P2-4 意图元数据与 [H8] | **闭合** | design、leases delta、SDK Node delta 均有顶部意图/原始输入/时间戳；design §0 已拆 [H8]-a deferStart 与 [H8]-b fabricId 采纳。 |

## 4. 新问题清单

### P0

无。

### P1

#### R14-P1-1：单 fabric preflight 存在 TOCTOU，无法保证第二 fabric 不 register

`design.md:243-250` 与 leases delta `spec.md:16,62-65` 只冻结“register 前读取既有 roster/租约并比较 fabric”。账本锁（`spec.md:20`）保护的是 `leases.json` 的锁内重读、合并和 rename，并没有覆盖“读取既有 fabric → 选择/生成 fabric → 远端 `POST /register` → 本地提交”的整个 admission 窗口。

因此两个进程在空 `DWEB_HOME` 并发 join A/B 时都可读到无既有 fabric，各自走 CSPRNG 生成不同 fabric，并先完成两个远端 register；之后才分别落账。即使本地最终能检测冲突，也已违反“第二 fabric 不 register”，且服务端留下无法由本地单 roster 消费的登记。该竞态同样适用于同旧 fabric 的并发选择与租约合并，不能只靠写锁补救。

**可验证修复建议：**增加独立的 per-`DWEB_HOME` fabric-admission 锁（`O_EXCL`/陈锁规则与账本锁一致），覆盖 preflight、fabric 决策、services preflight、远端 register、回执校验和 leases 合并；或定义等价的 CAS reservation，使失败者在 register 前看到已预留 fabric。补“并发异 fabric join” Scenario：断言最多一个远端 register、失败者明确 fail-closed、失败者无 leases 变更、服务端无第二条 `(fabric_id,root)` 登记；并说明服务端已登记后本地失败时的幂等补偿边界。锁名、释放时机、进程崩溃后的陈锁打破与网络超时必须可测。

### P2

#### R14-P2-1：tuple 正向 Scenario 仍保留反向流程

`design.md:258` 与 `specs/cli/leases/spec.md:29` 仍写 `fresh createRoot→register→ensure→restricted`，而同一设计的冻结主流程（`design.md:251-253`）和 leases `spec.md:24` 是 `CLI join/register → SDK createRoot/open → fabricId/endpointId 断言 → ensure/start/connect`。这会让实现/测试作者按旧顺序先建 SDK roster，再注册。

**可验证修复建议：**将两处统一为 `join/register → createRoot/open(dataDir=DWEB_HOME) → tuple 断言 → ensure → start → restricted handshake`；fresh 场景的 `createRoot` 只消费已有 lease，不再承担 register 前建账。

#### R14-P2-2：取消三分法后仍残留相反的 retry 语义

`design.md:201-207` 明确 shutdown 主动取消 resolve“已取消”、状态 Closed、不可重试；但 `design.md:212-213` 仍写“start Future 被取消=等价 Failed 可重试”。Node delta 只冻结 shutdown 取消的 Closed 结果，没有把底层取消与 shutdown 主动取消的来源/错误载荷分开。

**可验证修复建议：**删除/限定旧句，明确 cancellation source（shutdown 主动取消、底层启动失败/取消、调用方不 await）、Promise 结果、状态终点、资源清理和 retry 边；为 shutdown 与底层 cancellation 各补 Rust/Node 表驱动 Scenario，并断言 shutdown 返回后无晚到 bind/网络事件。

## 5. Owner 裁决与基线终判

本轮未修改 `server-access-roles`；strict validation 通过，未发现 alias、邀请码、敲门、WebUI 冻结面或 renew/first_registered_at 语义被放宽。H7 现在明确为“每个 DWEB_HOME 单 fabric、租约 N 仅按 server 维度增长”，但该不变量尚未具备并发 admission 机制。

| 裁决 | r14 终判 |
|---|---|
| H0 | **部分**：Custom relay/deferStart/单 fabric 路径有设计；并发 admission 与真实握手仍待实现证据。 |
| H1 | **设计满足**：短码 wire/golden vectors 未被本轮改写；跨端对拍待实现期。 |
| H2 | **设计满足**：tray 事件/RPC 契约未变；真实壳 acceptance 待交付。 |
| H3 | **设计满足**：显式 init/start、平台自启、stop owner 契约未变；真实平台 acceptance 待交付。 |
| H4 | **设计满足**：webui core/薄壳、注入 opener、管理员入口约束未变。 |
| H5 | **设计满足**：三视角和 member sidecar 安全边界未变。 |
| H6 | **设计满足**：alias 仍只消费显示，不改服务端契约。 |
| H7 | **部分**：单 fabric 与多 server leases 已冻结，但并发 join 仍可能产生第二 fabric 远端登记。 |
| H8 | **设计满足**：deferStart 与 fabricId 的 Owner 授权和映射已对齐；取消结果需先消除同文矛盾。 |

### 十条不可回退基线

| # | 基线 | r14 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向未被改写。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：CustomWithCaps/deferStart/单 fabric 约束已写；并发 admission、真实首触带票与 restricted 握手待验收。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**：目录 ownership 约束保持；单 fabric admission 见 P1。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**：本轮未改写。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **CONDITIONAL**：账本写锁完备，但单 fabric admission 未覆盖远端 register，无法证明不丢/不增错误租约。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；CLI/WebUI 对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL（实现证据待交付）**：300 秒实验、relay-only 对照或六字段 NOT-EXECUTABLE 记录仍需完成。 |

## 6. 设计结论与实现期义务

**设计层 NOT-READY，7.6/10。** r13 的单 fabric 范围裁决已经写清，但 R14-P1-1 仍阻止 GO；另有两个可测的三方文本矛盾。

进入实现前必须完成：

1. 冻结 per-`DWEB_HOME` fabric admission 锁/CAS，覆盖 preflight 到 register 与本地 leases 合并；补并发异 fabric Scenario，证明最多一个 register 且失败者无远端/本地副作用。
2. 删除 design/leases 中两处 `createRoot→register` 旧顺序，统一为 CLI join/register 后 SDK 消费。
3. 删除或限定“Future 取消=Failed 可重试”旧句，完成取消来源、Promise 结果、状态终点和 retry 边的 Rust/Node 测试矩阵。

设计闭合后仍需实现期验证：

1. 两个 server 同 fabric 的双租约、重启 `open`、错误 fabric/目录/损坏 roster 首拨前拒绝；单 fabric admission 的并发/崩溃/超时/陈锁测试。
2. `dataDir=DWEB_HOME` 身份连续性、deferStart 构造零出站、缓存票优先级、首次 relay 接触带票、Custom restricted 握手及无票/跨 server/malformed 拒绝。
3. G-3 test-only 300 秒实验、Direct 前置、停整个 hub、新 join 失败、重启恢复及 relay-only 对照或六字段降级记录。
4. darwin/Windows 自启与 stop、member sidecar 负向矩阵、短码 CLI/WebUI 对拍、tray 真实壳 acceptance；strict validation 不替代这些证据。
