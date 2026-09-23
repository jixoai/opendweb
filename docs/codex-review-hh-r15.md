<!--
Intent: home-hub r15 design-readiness review.
Original request: independently verify r14's fabric-admission lock and cancellation/order closures at HEAD fd265bc.
Timestamp: 2026-09-24 Asia/Shanghai.
-->

# home-hub 设计层复审 r15

评审基点：`HEAD fd265bc11e0fef256fe53510a83dc030499fbccf`。
对照基点：r14 `f795e19`，r14 结论 NOT-READY 7.6/10。
范围：核验 r14 的 P1-1、P2-1、P2-2；检查 v15 新矛盾；复核十条不可回退基线。只读评审，仅新增本报告。

## 1. 结论与评分

结论：**NOT-READY，7.8/10（较 r14 +0.2）**。

v15 已正确把 `fabric.lock` 放在单 fabric admission 的核心路径上：取锁、既有 fabric 检查、fabric 决策、services preflight、远端 register、回执校验、leases 合并和释放；账本锁嵌套顺序也已冻结。正常并发异 fabric join 因此不再存在 r14 的 TOCTOU。三处正向流程和取消三分法旧句也已同步修正。

仍有一个新的 P1：锁超时释放和陈锁打破都没有恢复本次 register 的 tuple 或远端结果。若请求已到服务端但客户端超时/崩溃，`fabric.lock` 消失后下一次 join 可重新随机 fabric；服务端幂等键是 `(code_hash, fabric_id, root)`，新 tuple 不会命中旧登记，最终可能出现两个远端 fabric，违反 v15 自己冻结的单 `DWEB_HOME` 不变量。正常路径改善不足以抵消该故障恢复缺口，设计层仍 NOT-READY。

| 维度 | r14 | r15 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 9.2 | 9.3 | H7 单 fabric、admission 锁和 H8 机制均已写入；异常恢复的持久化事实源缺失。 |
| 基线契约一致性 | 7.7 | 7.9 | 与 `server-access-roles` 的同键幂等语义对齐，但新 tuple 会绕过服务端幂等键。 |
| 三方一致性 | 7.7 | 8.3 | design、leases、SDK delta 的流程顺序和取消语义已统一。 |
| 技术可实现性 | 7.5 | 7.7 | 正常锁路径可实现；响应丢失/崩溃/陈锁接管无法安全决定是否允许新 fabric。 |
| Spec 可测性 | 7.8 | 8.0 | 已有并发 Scenario；缺少 register 响应丢失、崩溃和陈锁接管的恢复 Scenario。 |

## 2. 验证证据

### 实际阅读

- `docs/codex-review-hh-r14.md`，逐项对照 r14 P1/P2。
- v15 变更：`openspec/changes/home-hub/design.md` §2.1、§8、§10；`specs/cli/leases/spec.md`；`specs/sdk/node/spec.md`。
- 基线契约：`openspec/changes/server-access-roles/specs/cli/identity/spec.md`；`openspec/changes/server-access-roles/design.md` 的 register 幂等键和跨台账恢复语义。
- 实现事实：`packages/opendweb/src/join.mjs` 的 fabric 生成/register 编排；`crates/dweb-fabric/src/roster.rs` 的单 roster 事实。

### 实际命令与结果

- `git rev-parse HEAD`：`fd265bc11e0fef256fe53510a83dc030499fbccf`，与任务给出的 HEAD 一致。
- `git rev-parse HEAD^`：`f795e19e18e06ec979c3af379f53c20c9a7e4d83`；`git log -6 --oneline --decorate` 确认 v15 为当前提交。
- `git diff --stat HEAD^..HEAD`：仅 r14 报告存档、`design.md` 和 leases delta 被修改。
- `git diff --check HEAD^..HEAD`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- 未运行 Rust/Node 测试、故障注入 register、陈锁接管、真实 restricted relay、G-3 300 秒实验、自启、tray 或 acceptance；strict validation 只证明 artifact 结构。

## 3. r14 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R14-P1-1 admission TOCTOU | **正常路径闭合；异常恢复转为 R15-P1-1** | v15 明确 `<DWEB_HOME>/fabric.lock` 的 O_EXCL、陈锁规则、覆盖全窗口、admission→ledger 锁序和并发异 fabric “最多一个 register”断言。若锁持有者在远端 register 后响应丢失/崩溃，锁释放或陈锁接管前没有保存已选 tuple/远端结果，单 fabric 仍可被下一次新决策破坏。 |
| R14-P2-1 反向流程 | **闭合** | design 正向 Scenario 与 leases tuple Scenario 均统一为 `CLI join/register → SDK createRoot/open → tuple 断言 → ensure → start → restricted`；createRoot 只消费已有 lease。 |
| R14-P2-2 取消语义矛盾 | **闭合** | design 删除“Future 取消=Failed 可重试”旧句，并明确 shutdown 主动取消 resolve/Closed 不可重试、底层失败/取消 reject/Failed 可重试、调用方不 await 不被状态机感知；Node delta 同步可观察结果。 |

## 4. 新问题清单

### P0

无。

### P1

#### R15-P1-1：register 响应丢失或崩溃后，陈锁接管可制造第二 fabric

`design.md:253-264` 与 leases delta `spec.md:16,67-70` 规定了锁覆盖 register，但同时允许 register 超时后释放并重试、进程死后超过 10 秒打破陈锁。锁文件只保存 `pid+ts`，没有持久化本次选择的 `(server, code_hash, fabric_id, root)`、attempt 状态或远端 outcome。

具体故障链：

1. 进程 P 取 `fabric.lock`，选择 fabric A/root R，远端 `POST /register` 已到达服务端，但响应在客户端超时或进程在本地落账前崩溃。
2. P 未留下 leases，锁最终被释放或被陈锁接管。
3. 下一进程 Q 看不到既有本地 fabric，重新 CSPRNG 选择 fabric B，再以相同 code/root 之外的新 tuple register。
4. 服务端的幂等键是 `(code_hash, fabric_id, root)`；B 与 A 不同，故不会命中 A 的幂等回放。结果是远端可能同时存在 A、B 两条登记，而本地单 roster 只能承载一个 fabric。

现有“服务端已登记本地失败由幂等回放补偿”声明不足以覆盖该链：没有保存 A，重试无法构造命中同键的请求；未知远端结果也不能安全地放行新 fabric 决策。

**可验证修复建议：**在释放 admission 锁前增加 `<DWEB_HOME>` 下的 pending admission journal（0600、tmp+fsync+rename），至少保存归一化 server、code_hash、fabric_id、root、attempt 状态和最后错误/时间。对 register 超时、异常退出恢复、陈锁接管，必须先用 journal 中的同一 tuple 做 register 幂等回放或服务端状态确认；确认成功后补写 leases 并清 journal；确认明确未登记后才允许新决策；远端结果未知时 fail-closed，禁止生成第二 fabric。补充三组 Scenario：响应丢失、register 后崩溃/落账前崩溃、陈锁接管，均断言远端最多一条登记、恢复同一 tuple、账本最终一致。需明确 journal 陈旧/损坏、服务端不可达和 code 已耗尽时的错误与人工恢复文案。

### P2

无新增 P2；r14 两项 P2 已闭合。

## 5. Owner 裁决与基线终判

本轮未修改 `server-access-roles`；strict validation 通过，未发现 alias、邀请码、敲门、WebUI 冻结面或 renew/first_registered_at 语义被放宽。H7 的单 fabric 与多 server 租约范围、admission 锁正常路径已冻结，但异常恢复仍缺一个持久化事实源。

| 裁决 | r15 终判 |
|---|---|
| H0 | **部分**：Custom relay/deferStart/单 fabric 正常链已写；远端 register 未知结果恢复未闭合。 |
| H1 | **设计满足**：短码 wire/golden vectors 未被本轮改写；跨端对拍待实现期。 |
| H2 | **设计满足**：tray 事件/RPC 契约未变；真实壳 acceptance 待交付。 |
| H3 | **设计满足**：显式 init/start、平台自启、stop owner 契约未变；真实平台 acceptance 待交付。 |
| H4 | **设计满足**：webui core/薄壳、注入 opener、管理员入口约束未变。 |
| H5 | **设计满足**：三视角和 member sidecar 安全边界未变。 |
| H6 | **设计满足**：alias 仍只消费显示，不改服务端契约。 |
| H7 | **部分**：单 fabric 与多 server leases 的正常并发路径闭合；超时/崩溃/陈锁接管可产生第二远端 fabric。 |
| H8 | **设计满足**：deferStart、fabricId 授权、取消三分法映射一致。 |

### 十条不可回退基线

| # | 基线 | r15 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向未被改写。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：CustomWithCaps/deferStart/admission 正常路径已写；真实首触带票、故障恢复和 restricted 握手待验收。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**：data_dir ownership 与接管边界未改写。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**：本轮未改写。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **CONDITIONAL**：admission→ledger 锁序已冻结，但 pending register outcome 未持久化，异常时仍可增错误 fabric。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；CLI/WebUI 对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL（实现证据待交付）**：300 秒实验、relay-only 对照或六字段 NOT-EXECUTABLE 记录仍需完成。 |

## 6. 设计结论与实现期义务

**设计层 NOT-READY，7.8/10。** r14 的正常 admission TOCTOU 已闭合，r14 两项 P2 已闭合；R15-P1-1 的未知远端 register 结果仍阻止 GO。

进入实现前必须完成：

1. 冻结 pending admission journal 或等价的持久化 reservation；register 超时、响应丢失、进程崩溃、陈锁接管必须先恢复/确认原 tuple，未知结果 fail-closed，禁止新 fabric 决策。
2. 补响应丢失、远端已登记后本地崩溃、陈锁接管三类 Scenario，断言远端最多一个登记、同 tuple 幂等回放、leases 最终一致；明确 journal 清理、损坏和人工恢复路径。

设计闭合后仍需实现期验证：

1. 两个 server 同 fabric 的双租约、重启 `open`、错误 fabric/目录/损坏 roster 首拨前拒绝；admission 锁的并发、超时、崩溃、陈锁和 pending journal 故障注入。
2. `dataDir=DWEB_HOME` 身份连续性、deferStart 构造零出站、缓存票优先级、首次 relay 接触带票、Custom restricted 握手及无票/跨 server/malformed 拒绝。
3. G-3 test-only 300 秒实验、Direct 前置、停整个 hub、新 join 失败、重启恢复及 relay-only 对照或六字段降级记录。
4. darwin/Windows 自启与 stop、member sidecar 负向矩阵、短码 CLI/WebUI 对拍、tray 真实壳 acceptance；strict validation 不替代这些证据。
