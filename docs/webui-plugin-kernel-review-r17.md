# webui-plugin-kernel 发布前置终裁 r17

## 范围与基线

本轮只终裁 r16 保留的有效双机矩阵前置，不重开实现审查。当前 HEAD 为 `d24c0680f93e50e9575b7e06320c62484e0c9512`；该提交及本轮改动均为文档，运行时代码相对 r15 实现基线没有变化。工作区现有三个未跟踪环境辅助 fixture 未纳入本轮提交。

评分基线为实现面 **GO 9.3/10**。评分轨迹保持：r13 干净树 `8.7` → r15 `9.3` → r16 `9.3` → r17 `9.3`。本轮新增的是发布证据，不把环境矩阵结果计入实现分数。

## 裁决

**r16 发布前置已闭合；放行 `archive → merge → push`。**

iMac 消费、mini 提供的反向拓扑不构成判据变更。r16 门槛规定真双机、真实 QUIC 数据面、注入类型与样本分类，没有规定必须由哪一端消费或提供。回执仍是两台真实机器、同一 fabric 和同一类传输/故障注入；只按环境可用的健康拨号方向交换角色，不降低样本数或任何通过条件。

实现面保持 **GO 9.3/10**；发布面由 r16 的 NOT-READY 转为 **GO**。本轮没有 `PASS-RECOVERED` 样本；24 个样本均为明确非零退出的 `PASS-FAIL`，已满足“每个有效样本为 `PASS-FAIL` 或完整 MD5 精确 `PASS-RECOVERED`”的原判据。r16 已记录的正向拓扑 512 MiB 精确恢复样本仅作旁证，本轮不计数。

## 回执核验

采用 `/tmp/wpk-matrix-rev.log` 的 run2；首轮 `/tmp/wpk-matrix-rev-run1.log` 因 `RECOVERY-FAILED=1` 明确不计入终裁。run2 回执第 1 行绑定 HEAD、harness SHA-256、探针字节数与 MD5、拓扑、两端 endpoint、fabric 和目标样本数；第 2–25 行逐周期记录注入前进度、curl 结果及 post 状态；第 26 行是汇总。

run2 汇总与逐行独立计数相符：`attempts=24 VALID=24`，其中 `kill-curl=8`、`kill-mini=8`、`kill-imac=8`；24/24 都是 `INJECT-OK` 与 `PASS-FAIL`。`kill-curl` 为 exit 137，`kill-mini` / `kill-imac` 为 exit 28 / 18 且留下非零截断体。没有 `exit=0 + HTTP 200`，所以没有 clean-200 短体，也没有 `200:0`。汇总为 `VIOLATIONS=0 RECOVERY-FAILED=0 INVALID-INJECT=0`。

身份与探针可复核：回执 HEAD 与当前 HEAD 一致；回执 harness SHA-256 `abc956a1b8785aaa97857b4ba033486c34941d4c86b500db16550a08a0e0de5e` 与 `/tmp/wpk-matrix-run-rev.sh` 实测一致；回执探针为 `268435456` 字节、MD5 `692c4d62deaff99106c53c949968910b`，与本地 `/tmp/wpk-matrix-96m.bin` 的实测大小和 MD5 一致。文件名保留了早期的 `96m`，实际大小按回执和文件核验为 256 MiB。

## 证据边界

反向拓扑矩阵证明三种中断都真实命中，传输均以非零退出结束，且每轮后探测到非零字节的 HTTP 200 响应；这满足 r16 明订的 24 有效周期、结果分类、`VIOLATIONS=0`、`RECOVERY-FAILED=0` 和无 `200:0`。本轮没有声称这些 200 探针完成了 256 MiB 全量传输或做过探针 MD5 校验。

原因是 `/tmp/wpk-matrix-run-rev.sh` 的 `probe()` 只输出 HTTP 状态与 `size_download`，`wait_dataplane()` 以 200 响应判定数据面已恢复，不检查 curl 退出码、期望长度或 MD5。回执的 `post=[200 <非零字节数>]` 应按该连通性判据理解，而不是完整性样本。r16 没有要求每次 post 探针做全量 MD5；传输完整性仍由主请求的退出状态和 `PASS-RECOVERED` 分类判定。本轮主请求全部是非零退出，因此没有短体 clean 200 被误归为通过。

汇总中的 `E1-INTERVENTIONS=25` 是 `/tmp/wpk-matrix-e1.count` 的累计行数；harness 只 `touch` 文件而不清空，且 run1/run2 汇总均为 25，不能将它解释为 run2 独有计数。该字段不是 r16 发布判据；run2 的逐周期 pre/post 没有记录 `E1-INTERVENTION` 或 `RECOVERY-FAILED`。

## 最终结论

**反向拓扑的 run2 满足 r16 发布前置。实现 GO 9.3/10；发布 GO。** 可以进入 `archive → merge → push`。没有代码变更，也没有新增代码测试。本报告只裁决并记录发布证据，不代替后续 archive、merge 或 push 操作。
