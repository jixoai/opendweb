# webui-plugin-kernel 发布前置裁决 r16

## 范围与基线

本轮只裁决 r15 留下的真双机发布闸门，不重开已闭合的实现缺口。目标 HEAD 为 `4d6643c831b39b0c356127e6dae851b21ad0e306`；工作区没有已跟踪源码修改。`packages/webui/test/fixtures/wpk-imac-join-mini.mjs`、`wpk-scratch-rjoin-client.mjs`、`wpk-scratch-rjoin-server.mjs` 是现存未跟踪环境辅助文件，本轮不纳入代码裁决。

评分基线为 r15 的实现面 **9.3/10**。本轮没有运行时代码变更，因此评分保持 9.3/10；本轮只改变发布闸门的裁决，不把环境证据倒灌成实现分数。

## 裁决

**选择 C：维持原判。**

- **实现面：GO，9.3/10。** r15 的四项实现 blocker 没有新代码变化或新反证。
- **发布面：NOT-READY。** 不允许据此执行 `archive -> merge -> push`。
- r15 的原门继续有效：**24 个有效注入周期**；每个周期必须是 `PASS-FAIL` 或完整 MD5 精确的 `PASS-RECOVERED`；`VIOLATIONS=0`、`RECOVERY-FAILED=0`，且不得出现 `200:0`。`ABORT(no-dataplane)` 不是有效样本，不能补足周期数。

评分轨迹保持：r13 干净树 `8.7` -> r15 `9.3` -> r16 `9.3`。

## 直接核对的证据

### 当前第四轮只有 3 个有效样本

`/tmp/wpk-matrix.log:79-104` 的 24 周期原始记录显示：

| 周期 | 注入 | 结果 | 是否有效 |
|---|---|---|---|
| 1 | `kill-curl` | `PASS-FAIL`，exit 137 | 是 |
| 2 | `kill-mini` | `PASS-FAIL`，exit 18，截断 1.27MB | 是 |
| 3 | `kill-imac` | 512MB MD5 精确，`PASS-RECOVERED` | 是，但后置恢复失败 |
| 4-24 | 无 | `ABORT(no-dataplane)` | 否 |

日志汇总为 `PASS-FAIL=2 PASS-RECOVERED=1 VIOLATIONS=0 INVALID-INJECT=0 E1-INTERVENTIONS=22`。这证明三类注入均能命中一次，但不是 24 个有效样本。

### `RECOVERY-FAILED` 已在有效周期中出现

同一份原始日志的 cycle 3 明确写着 `post=[RECOVERY-FAILED]`（`/tmp/wpk-matrix.log:82`）。即使请求本身完成了 512MB 精确恢复，这仍违反 r15 的 `RECOVERY-FAILED=0` 发布判据。当前 harness 的 `wait_dataplane()` 会在恢复窗口耗尽时发出该标记（`/tmp/wpk-matrix-run.sh:42-59`），但汇总行只统计 `E1-INTERVENTIONS`（`:123-132`），不能用汇总行的缺省字段证明恢复失败为零。cycle 4-24 的 `ABORT(no-dataplane)` 也不能被重新解释成通过，因为它们没有发生注入。

### 环境叙事支持“外部阻塞”，不替代发布闸门

终章记录了反向配对成功、约 400MB/s 数据面，以及累积触发、方向性、粘性的 QUIC 防护画像（`/tmp/wpk-matrix-env-status.md:84-98`）。这足以把当前失败归因到环境可用性，而不是新增代码 blocker；它不能把未发生的 21 个注入周期转换成有效样本。

### 日志与当前 harness 的可复现性边界

当前 `/tmp/wpk-matrix-run.sh:12-14` 已写为 256MB 探针和新的 MD5 锚点，而最终日志 cycle 1-3 使用的是 512MB 结果（`/tmp/wpk-matrix.log:80-82`）。因此这份日志不能单独作为“当前脚本、当前参数已完成 24 周期”的可复现 receipt；下次矩阵必须把 commit、脚本摘要、探针大小和 MD5 锚点写在同一份原始回执中。

## 旁证的证据等级

用户提供的第二/三轮叙述（48+ 周期旁证、第二轮 14/24 MD5 精确、截断均为非零退出）与历史请求材料中的第二轮摘要（`/tmp/wpk-r12-prompt.md:17`）相互一致，可作为稳定性与判据方向的支持性证据。但当前可见 `/tmp` 原始矩阵文件只保留了旧的无效/12 周期记录和本次 24 周期记录，没有一份可独立绑定到 HEAD `4d6643c` 的 48 周期逐周期 receipt；且历史摘要对应 r12 时点，不能替代最终 HEAD 的发布样本。因此本轮不把它们升级为 r15 所需的 24 个有效样本。

这也不是降低门槛（B）的依据：没有新的规范裁决或可审计的统计理由来把“3 个分类覆盖样本”替换为“24 个有效周期”。变更发布门槛应由 Owner 另行拍板，不由本轮环境失败倒推。

## 剩余等待与放行条件

等待任一可复现的环境恢复路径：QUIC 双向拨号恢复，或换用不触发该方向防护的隔离网络/链路。恢复后，在 HEAD `4d6643c` 上使用与日志同一版本的 harness 和探针，完成：

1. 24 个周期全部实际发生 `INJECT-OK`；不得用 `ABORT(no-dataplane)` 补数。
2. 每个周期归类为 `PASS-FAIL` 或完整 MD5 精确的 `PASS-RECOVERED`。
3. 汇总 `VIOLATIONS=0`、`RECOVERY-FAILED=0`、无 `200:0`；无效注入单独记账，并继续补跑直到得到 24 个有效样本。
4. 原始日志同时记录 HEAD、harness SHA-256、探针 size/MD5、两端 endpoint/fabric 身份、注入前 PID/字节水位和 post-recovery 状态。

满足以上条件后，沿用 r15 结论直接进入 `archive -> merge -> push`；在此之前保持发布 NOT-READY，不改代码、不把环境旁证写成 GO。

## 最终结论

**C：实现 GO 9.3/10；发布 NOT-READY。** 当前证据证明三类故障注入各命中一次，并证明环境在第三周期后失去数据面；它没有满足 24 个有效样本，且已有一条 `RECOVERY-FAILED`。剩余等待是可复现环境恢复后的原门重跑。
