# webui-plugin-kernel 实现终确复审 r13

## 范围与证据

审查固定于 r12 基线 `0dfaa4b` 到目标实现提交 `82cee55`（`e7e95ae → 67ede31 → c60a03d → 82cee55`）。当前仓库实际 HEAD 为 `4397379`，并有 continuity 源码和测试的未提交改动；这些候选不属于目标提交，不作为闭合证据，也不纳入本次提交。

核对目标提交的 continuity session/HTTP 实现、h16-h20 与 stalled-body-send 用例、client-sdk abort/finish ABI 测试、app-protocol continuity delta，以及 `/tmp/wpk-matrix-run.sh` 和 `/tmp/wpk-mini-ctl.sh`。`git diff --check 0dfaa4b..82cee55` 与工作区 `git diff --check` 通过。本轮没有运行测试；cargo/client-sdk/webui/ports 的数字是 Owner 提供的当日回执，不是本轮独立复跑。未操作 sidecar 或 hub。仓库 code-review skill 所列 `docs/agents/issue-tracker.md` 不存在；本轮以用户指定 OpenSpec 为规范信源。

## Standards

没有发现本次改动违反仓库书面规范的硬性问题。

判断性改进项：

- `http.rs` 的 OPEN、DATA、FIN 发送阶段重复映射 `PhaseFail`，可提取共同失败结算逻辑，避免三处分支以后语义漂移。
- 发送操作和 `spawn_abort_cleanup` 都是 detached task，调用方不持有其完成句柄；错误返回、终态落位和恢复发送之间难以统一追踪。
- `terminal_arb` 在 `finish()` 与 `abort_stream()` 中跨网络发送持有 session 级锁（`session.rs@82cee55:1109-1112,2206-2231`），一个慢终态发送会挡住同会话其他流的终态操作。现有发送锁已经串行化单通道帧，但这把锁还跨越恢复代，建议后续评估按流仲裁或拆分本地决定与 wire 写入。

## Spec

### 阻塞问题

#### B1：取消流仍进入恢复重放，且 RESET 排在重放之后（P1）

`mark_local_abort()` 只设 `LocalAbort`、清 `final_sent`，没有清发送 journal，也没有从 `stream_keys` 移除该流（`session.rs@82cee55:1085-1095`）。`replay_batches()` 对所有持有 journal 的流取快照，`open_resend_list()` 返回全部 key，没有过滤取消终态（`session.rs@82cee55:1833-1839,1882-1888`）。恢复发送侧因此会重发 DATA；client 路径还会先发 OPEN，之后才发 RESET（`session.rs@82cee55:4177-4222,4378-4430`）。这可能在取消恢复后重新暴露请求或继续交付请求体。

FIN 过滤也只有快照时生效：`fin_resent_streams()` 排除当时已标记的 `LocalAbort`，但恢复循环在锁外发送该快照（`session.rs@82cee55:1847-1853,4193-4205,4410-4422`）。abort 若发生在快照取得后，旧 FIN 仍可上 wire。h20 先 abort、再调用 resume，没有覆盖“快照已取、发送暂停、abort 落位、恢复发送继续”的竞态。

修复建议：LocalAbort 在返回调用方前同步终止该流的重放数据并释放大 journal；OPEN/DATA/FIN 均在实际发帧点与 abort 使用同一可证明的线性化机制，且 RESET 义务仍跨恢复代保留。增加可控 barrier 测试，在每类快照后、发帧前落位 abort，断言取消后不再发 OPEN/DATA/FIN，恢复最终只交付取消终态。

#### B2：发送错误可直接返回，取消清理又晚于错误返回（P1）

`send_data()` 先登记 journal 再写帧（`session.rs@82cee55:2183-2192`）。但 `fetch_http()` 的 OPEN/DATA/FIN `PhaseFail::Op` 和 `PhaseFail::Join` 分支直接返回错误，不安排 abort 清理；只有 Cancel/Deadline 路径调用 `spawn_abort_cleanup()`（`http.rs@82cee55:452-465,482-496,508-522`）。因此 DATA 已入 journal、wire 写失败时，流仍可在恢复时重放，且可能再次驱动对端处理。

即便 Cancel/Deadline 路径，`spawn_abort_cleanup()` 也只是启动 detached task 并立即让 `fetch_http()` 返回；`abort_stream()` 后续才落 `LocalAbort`。它只清 `final_sent`，不清 journal。恢复可以抢在本地终态落位前取得快照，且终态落位后 journal 仍可重放。当前 stalled-body-send 测试在 fetch 返回后 sleep 200ms 才检查 `LocalAbort`，没有断言错误返回边界前已同步落位、journal 归零或恢复不会重发。

修复建议：把本地取消终态和 journal 清账设为错误返回前的同步步骤；后台任务仅承接 RESET wire I/O。Op/Join/Cancel/Deadline 所有失败分支都走相同结算。用故障注入在至少一个 DATA 段已登记后令发送失败，并用 barrier 让恢复紧贴 caller 错误返回发生，断言无数据重放、无 ghost OPEN、RESET 仍可补发。

#### B3：abort 永久占用活跃流配额并可钉住会话 journal（P1）

`quota_reapable()` 仅在双向终局且 journal 清空时返回 true（`session.rs@82cee55:298-300`）。abort 会清 `final_sent`，不设置 `remote_final`，又保留 journal，因此该流永久计入 `MAX_ACTIVE_STREAMS=128`；代码注释也明确该名额占用至 session 终结（`session.rs@82cee55:1089-1095`）。连续 128 次取消后，新请求会因活跃流上限失败。未 ACK 的取消流 journal 还继续占用 session 字节预算。

修复建议：将需跨恢复代保留的紧凑 RESET/取消义务与 `StreamCtx`、payload journal 分离；取消时释放大对象和配额，未确认取消义务不得静默丢失。新增超过 128 次取消后仍能开新流并发送数据的压力测试，同时断言 journal/map 占用有界且恢复仍补发 RESET。

#### B4：server-kill 矩阵缺有效注入校验，UDP 恢复后必须补跑（P1）

矩阵分类本身已按 exit、HTTP 状态、size、MD5 统一处理；但传输中断的前置核验只在 `curl-kill` 分支实现（`/tmp/wpk-mini-ctl.sh:66-92`）。`kill-mini` 的 `kill` 仅确认 sidecar 退出和 UDP 端口释放（`/tmp/wpk-mini-ctl.sh:15-28`）；`kill-imac` 仅确认进程被杀（`/tmp/wpk-matrix-run.sh:24-28`）。二者都没有核实 curl 仍存活、完成标记未落、且已写字节满足 `0 < bytes < total`。96MB 下载若在固定 1.5s 注入窗口内已经完成，server-kill 样本仍会被计为有效。

本轮双机 UDP 黑洞/名册漂移使矩阵没有补跑；用户提供的网络取证说明了环境阻断原因，但此前一次完整 96MB 传输不等于中断/恢复矩阵。修复建议：mini 与 iMac server-kill 复用与 curl-kill 相同的注入前检查，不满足条件时输出 `INVALID-INJECT` 且不 kill；记录 kill 时 PID、完成标记和字节水位。网络恢复后，用最终提交与有效 server-kill 注入重新跑矩阵。该矩阵是 archive 前置条件，不是后置观察项。

### 已闭合与覆盖边界

- **r12-B3（聚合读取终态）闭合。** `recv()` 每轮先交付队列中的数据，再把 `LocalAbort` 纳入 ended 条件；队列排空后返回 Err（`session.rs@82cee55:1281-1352`）。h17/h18 覆盖响应体和请求体聚合读取。现有用例在 abort 前已读出一个前缀；“abort 时队列里还留有多个前缀块”的专门用例可补，但实现顺序符合所述语义。
- **单一 head deadline 主路径成立。** 同一个 `head_deadline` 覆盖活性闸门、OPEN、每个 DATA、FIN 和响应头等待；发送 future 被 spawn 后有界观察，避免 select 丢弃半帧（`http.rs@82cee55:339-342,417-422`）。h16 与 `fetch_head_budget_bounds_stalled_body_send` 分别覆盖恢复等待/头等待与 raw_link 4MiB 流控停滞。结算及时性有证据，错误返回后的本地清理完整性仍由 B1/B2 阻塞。
- **FIN/abort 本地仲裁部分成立。** `finish()` 与 `abort_stream()` 共用 `terminal_arb`；abort 先落位时 finish 拒绝，FIN 已登记后 abort 清除 FIN 重放标记，h19/h20 和同轮 JS ABI 用例覆盖若干顺序。恢复快照竞速仍见 B1。

## 质量评价与裁决

实现质量评分：**8.0/10**，较 r12 的 **8.5/10 下降 0.5**。r12-B3 已闭合；同轮 abort/finish 仲裁、LocalAbort 错误传播和总 head deadline 均有明确实现与测试。扣分集中在更深一层的取消生命周期：恢复重放仍能越过 abort，发送错误路径可保留并重放 DATA，取消后配额/journal 不释放；双机矩阵的 server-kill 注入核验也未落地，且环境阻断了有效补跑。

**结论：NOT-READY。** 最小闭合清单：

1. 取消终态与 OPEN/DATA/FIN 恢复发帧形成发送点线性化；取消后同步清掉可重放 DATA/OPEN 状态，加入快照后取消屏障测试。
2. 所有发送失败分支在返回错误前完成本地取消落位与 journal 清账；仅 RESET wire I/O 留给后台任务，并以已登记 DATA 后失败的确定性交错测试验证。
3. 取消释放活跃配额和 payload/journal；用超过 128 次取消的压力测试证明会话仍可继续工作，且 RESET 恢复义务有界保留。
4. 给 `kill-mini`/`kill-imac` 增加注入前存活/进度检查，并在 LAN UDP 恢复后对最终提交补跑有效双机 server-kill 矩阵。

<!--
意图（2026-10-01）：记录 webui-plugin-kernel r13 实现终确复审；固定比较 r12 基线 `0dfaa4b` 与实现提交 `82cee55`，排除 dirty follow-on 候选。
原始需求输入：「r13：webui-plugin-kernel 终确（r12 B1/B3/B4 闭合确认）……列出阻塞问题、可验证修复建议、实现质量评价、综合评分与依据、与 r12 的变化；报告存档并登记 AGENTS.md、自行提交。」
-->
