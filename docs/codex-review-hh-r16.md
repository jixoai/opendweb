<!--
Intent: home-hub r16 design-readiness review.
Original request: independently verify r15's pending admission journal closure at HEAD 5c5c389.
Timestamp: 2026-09-24 Asia/Shanghai.
-->

# home-hub 设计层复审 r16

评审基点：`HEAD 5c5c389f611231c0c06d96796158fa58d8ef1088`。
对照基点：r15 `fd265bc`，r15 结论 NOT-READY 7.8/10。本轮只读；仅新增本报告。

## 1. 结论与评分

结论：**NOT-READY，8.0/10（较 r15 +0.2）**。

v16 的 journal 正确关闭了 r15 指出的“选定 tuple 未持久化”缺口：它在远端
`register` 前、仍持 admission 锁时原子写入 server/code_hash/fabric_id/root，并规定
超时、崩溃和陈锁接管均不得重新生成 fabric。设计与 leases delta 同步，也补了三组
故障 Scenario。

但恢复动作不可执行。journal 只有 `code_hash`，而基线 `POST /register` 必须重交原始
`code` 并以该原文重新签 PoP；现有协议没有按 `(code_hash,fabric_id,root)` 供 member
确认状态的查询入口。进程崩溃后，CLI 既不能从 hash 还原 code 来作“同 tuple 重发”，
也不能实现文中替代路径“确认服务端状态”。这个缺口正落在 v16 要保证的响应丢失、崩溃
和陈锁接管路径，故仍是 P1，不能设计层 GO。

| 维度 | r15 | r16 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 9.3 | 9.3 | H0-H8 的正常链未退化；H7 异常恢复仍无可执行输入。 |
| 基线契约一致性 | 7.9 | 8.2 | journal 与 register 同键幂等目标一致；但 code 原文/PoP 与公开查询边界未对齐。 |
| 三方一致性 | 8.3 | 8.6 | design 与 leases delta 均写入同一 journal 规则和 Scenario。 |
| 技术可实现性 | 7.7 | 7.9 | 原子持久化和锁序明确；恢复无法构造基线请求。 |
| Spec 可测性 | 8.0 | 8.2 | 三类故障已列出，但还不能对实际恢复请求做可执行断言。 |

## 2. 验证证据

### 实际阅读

- `docs/codex-review-hh-r15.md`，逐项对照 r15 唯一 P1。
- v16 diff 与当前文件：`openspec/changes/home-hub/design.md` §2.1、§10；
  `openspec/changes/home-hub/specs/cli/leases/spec.md`。
- 叠加基线：`openspec/changes/server-access-roles/specs/server/spec.md`
  的公开 `/register` 载荷、校验序、同键幂等和 pending；
  `specs/cli/identity/spec.md` 的 join 签名输入。
- 其余 home-hub delta（hub、sdk/node、webui、tray）及 requirements/proposal/
  PRODUCT-DESIGN 顶部边界，确认本轮未改写其承诺面。

### 实际命令与结果

- `git rev-parse HEAD`：`5c5c389f611231c0c06d96796158fa58d8ef1088`，与任务给定 HEAD 一致；
  `git rev-parse HEAD^`：`fd265bc11e0fef256fe53510a83dc030499fbccf`。
- `git log --oneline -6`：当前提交为 v16 journal 修订，父提交为 v15 admission 锁。
- `git diff --stat HEAD^..HEAD` / `git diff HEAD^..HEAD -- design.md leases/spec.md`：
  仅 r15 报告存档及上述两个规范文件承载 v16 设计修订。
- `git diff --check HEAD^..HEAD`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：`Change 'server-access-roles' is valid`。
- 未运行 Rust/Node、真实 register 故障注入、restricted relay、G-3 300 秒、自启、
  tray 或浏览器 acceptance。严格校验只验证 OpenSpec 结构，不证明恢复动作可执行。

## 3. r15 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R15-P1-1 register 响应丢失/崩溃可造第二 fabric | **持久化与 fail-closed 分支闭合；恢复凭据转为 R16-P1-1** | design §2.1（263-275）和 leases delta（16、67-70）均规定 register 前原子写 journal、成功后补账清除、未知远端结果禁新 fabric，并覆盖响应丢失/落账前崩溃/陈锁接管。journal 未保存或取得原始 code；基线也没有 status 查询，无法执行“同 tuple 重发/确认”。 |

## 4. 新问题清单

### P0

无。

### P1

#### R16-P1-1：journal 只存 code_hash，崩溃后无法完成规定的同 tuple 回放或状态确认

`design.md:263-275` 与 `specs/cli/leases/spec.md:16,67-70` 将恢复前提写成
`{server, code_hash, fabric_id, root, ...}`，并要求重发同一 tuple 或确认远端状态。
然而基线 `/register` 请求体必须含原始 `code`，PoP canonical 也含原始 `code`
（`server-access-roles/specs/server/spec.md:195,201`）；服务端只在收到 code 后计算
hash 并命中 `(code_hash,fabric_id,root)` 幂等键。基线无 member 可调用的 tuple/status
查询路由，现有 `GET /admin/owners` 不是该恢复 API，也不应向 member 暴露 admin token。

故障链：P 在 journal 写入后发出 register，服务端已 durable 但客户端在响应丢失或
落账前崩溃；Q 接管陈锁后只读到 hash。Q 无法从 hash 重建 invitation code，不能生成
合法的同键 `POST /register`；也无状态查询可确认。因此「恢复均以 journal 同一 tuple
幂等回放/确认」不是可执行 Requirement，三组 Scenario 无法按其 THEN 实现。若实现者
为继续流程而新收一张码并重新决策，就会重新打开 r15 的第二 fabric 风险；若拒绝，则
设计虽安全但未承载自己承诺的恢复成功路径。

**可验证修复建议（不扩 dweb-server）：**将恢复拆为明确的 CLI 交互状态机。保留
0600 journal 的 tuple/hash；发现 journal 后，`join` 必须先拒绝所有新 fabric 决策并提示
重新输入原邀请码。仅当重新输入的码规范化 hash 与 `journal.code_hash` 相等时，才用
journal 的 `fabric_id/root/server` 和新 ts 重签 `POST /register`；200 幂等回放后补账、
清 journal。无 code、hash 不符、网络未知、`code-pending` 均 fail-closed 且 journal
保留；同一码得到 `code-invalid`/`code-expired` 等时，须冻结能否把它视为“明确未登记”
的服务端可判定依据，否则仍走人工恢复。增加三个故障 Scenario 的子断言：无重新输入码
不得发 register/不得新决策；同码可回放并补账；异码绝不改变 journal 或生成第二 fabric。
若选择静默自动恢复，则必须经 Owner 改变安全边界，明定受保护的 code 持久化方案及其
清理/泄露面，或新增有 PoP 认证且不暴露租户枚举的状态查询 API；后者超出当前
`dweb-server` 零改动范围。

### P2

无新增 P2。本轮发现的 journal 回放输入缺失会直接令核心恢复路径不可实现，按 P1 处理。

## 5. Owner 裁决与十条不可回退基线

本轮没有修改 `server-access-roles`。两项 strict validation 均通过；未发现 alias、
邀请码、敲门、WebUI 冻结面、renew 顺延或 first_registered_at 被放宽。

| 裁决 | r16 终判 |
|---|---|
| H0 | **部分**：Custom relay/deferStart 正常链仍在；异常注册恢复未可执行。 |
| H1 | **设计满足**：短码 wire/golden vectors 未改；跨端对拍待实现。 |
| H2 | **设计满足**：tray 插件事件/RPC 契约未改；真实壳 acceptance 待交付。 |
| H3 | **设计满足**：显式 init/start、自启与 stop owner 契约未改。 |
| H4 | **设计满足**：webui core/薄壳、注入 opener、管理员入口边界未改。 |
| H5 | **设计满足**：三视角及 member sidecar 负向边界未改。 |
| H6 | **设计满足**：alias 仍仅为显示消费，未改服务端契约。 |
| H7 | **部分**：单 fabric、admission 锁、journal 写前持久化正确；崩溃恢复尚不能使用 journal 完成同键确认。 |
| H8 | **设计满足**：deferStart/fabricId 授权与 Node delta 未改。 |

| # | 不可回退基线 | r16 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：首触带票与 restricted 握手仍待实现证据。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **CONDITIONAL**：journal 的持久化/锁序已定义，但崩溃后无法执行同键补偿。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；CLI/WebUI 对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL（实现证据待交付）**。 |

## 6. 设计结论与实现期义务

**设计层 NOT-READY，8.0/10。** 进入实现前先闭合 R16-P1-1：冻结无需 server 改动的
“重输同一码、hash 比对、沿 journal tuple 重签回放”状态机，或取得扩范围授权并规定
等价的受保护恢复材料/查询契约；补齐每个终态的 journal 保留/清除语义与故障注入 Scenario。

闭合后仍需作为实现期义务验证：

1. admission 锁与 journal 的响应丢失、落账前崩溃、陈锁接管、异码/无码、同码幂等回放、
   server 不可达和 code-pending 故障注入；断言无第二远端 fabric、无错误账变更。
2. 同 fabric 双 server 租约、dataDir/identity 连续性、deferStart 零出站、缓存票优先级、
   首次 relay 接触带票，以及 Custom restricted 正反握手。
3. G-3 300 秒停整个 hub 实验与 relay-only 对照或六字段 NOT-EXECUTABLE 记录。
4. darwin/Windows 自启生命周期、member sidecar 负向矩阵、短码 CLI/WebUI 对拍、tray
   真实壳 acceptance。OpenSpec 严格校验不替代这些结果。
