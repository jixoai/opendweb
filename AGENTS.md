<!--
意图（2026-09-29）：为本仓后续 Agent 指向 webui-plugin-kernel 的权威 Owner 输入、地基代码和本轮构型记录。
原始需求输入：「webui-plugin-kernel 新 change 的构型讨论第 1 轮开始……将结论落到 docs/webui-plugin-kernel-discussion-r1.md」。
-->
# Project Context

## webui-plugin-kernel

- Owner 裁决以 `openspec/changes/webui-plugin-kernel/requirements.md` 的 W0-W6 原话为准。
- r1 构型讨论记录在 `docs/webui-plugin-kernel-discussion-r1.md`；design v2 的 r3 复审结论在 `docs/webui-plugin-kernel-review-r3.md`：6/10 NOT-READY。r4 对 d4a4cf5 的窄轮复验记录在 `docs/webui-plugin-kernel-review-r4.md`：4/10 NOT-READY；Owner 说明 ports/sync delta 未写盘源于修复脚本锚点断言失败后整体中止，d4a4cf5 提交说明失实。r5 对 v2.2 的复验记录在 `docs/webui-plugin-kernel-review-r5.md`：7/10 NOT-READY。r6 对 v2.3 的窄轮复验记录在 `docs/webui-plugin-kernel-review-r6.md`：9/10 GO；N1 已拆四条独立 Scenario，N2 targetRef 非 postimage 路径保留 intent 并转用户冲突，N4 已用三方竞争明示 mode 冲突与单侧 mode 自动传播。W11 继续待 Owner 追认，但新面零 argv 凭证 MUST 独立执行。
- 核对运行时事实时，区分 `openspec/changes/app-protocol-layer/design.md` 的目标 ABI 与 `packages/client-sdk/src/http.rs`、`packages/client-sdk/http/` 的已实现 N-API 面。
- `packages/opendweb/src/plugin-contract.mjs` 的 apiVersion 1 是 CLI 命令契约，不等于 WebUI 插件生命周期或页面契约。
- r7 实现终审（HEAD `b7284fd`）结论写入 `docs/webui-plugin-kernel-review-r7.md`：7/10 NOT-READY。主体内核连续性、90d member capability、known_addrs 持久化、Origin/allowlist、files fd-chain 降级与 sync CAS/intent 三态已通过静态核对及 Owner receipt；归档前仍阻塞于 [W12] direct-only 默认未落地、shutdown 阶段预算非全局 5s、sync push 的 AbortSignal 线性化/组级并发/staging 实体语义。r7 独立运行 ext-sync endpoint 单文件为 8/8，但未覆盖这些缺口；双机进程未触碰。
- r11 补审（HEAD `74e4ce6`）结论写入 `docs/webui-plugin-kernel-review-r11.md`：8.2/10 NOT-READY。`aae19fa` 的 dead-channel 交付闸门成立；体完整性仍被 abort→FIN 竞态、非 FIN 错误折叠为 EOF、聚合读取吞错及阶段 A 取消未贯穿恢复等待阻塞。Owner 供应的 mini 采样为 99/100 正常、1 次预期非空请求 `200:0`；本机无法复核 `/tmp/wpk-mini-sidecar.log`。E1′-① 作为首位后置可用性 change 跟踪，不豁免 `200:0`。
- r12 终确复验（HEAD `0dfaa4b`）结论写入 `docs/webui-plugin-kernel-review-r12.md`：8.5/10 NOT-READY。B2 已闭合；B1 仍有 abort/FIN 并发仲裁及 FIN-before-RESET 恢复重放风险，B3 的 Active LocalAbort 不能令聚合读取返回 Err，B4 的 head deadline 未覆盖 OPEN/DATA/FIN 发送等待。双机原始矩阵没有短体 clean 200，但 kill-curl harness 将任意 exit=0 都算 violation，且未确认 kill 前进程存活。
- r13 终确复审（基线 `0dfaa4b`，实现提交 `82cee55`；实际索引 HEAD `4397379`）结论写入 `docs/webui-plugin-kernel-review-r13.md`：8.0/10 NOT-READY。r12-B3 聚合读取闭合，head deadline 与 stalled-body-send 门有覆盖；B1 仍会重放取消流的 OPEN/DATA，FIN 快照发送未与 abort 线性化；B4 Op/Join 失败直返、异步清理未同步清 journal，abort 还永久占用 128 活跃流额度。server-kill harness 未核实 curl 存活/进度，且 LAN UDP 黑洞阻断有效矩阵补跑；代码闭合与有效双机中断矩阵均为 archive 前置。未提交源码候选不计入结论。
- r14 终确复验（HEAD `b9678ec`，对照 84d4726 半成品基线）结论写入 `docs/webui-plugin-kernel-review-r14.md`：8.3/10 NOT-READY（较 8.0 +0.3；干净树基线 8.7 与 8.0 双轨所致的可比性问题）。四缺口：h21 未覆盖 journal 入账后发送失败与恢复竞态；reset_tombstones 软上限可被对端扩张；aborted_registry 90s 淘汰依据不能证明 session 已 Dead；close 可绕过 provider-FIN 无操作规则发 RESET。评分轨迹 8.2→8.5→8.7→8.3 触发「算法任务升级规则」：停止 ZCode 自行实现，转 Codex 日曜三接手修复。
- r15 终确复审（HEAD `728e82a`，前置测试面修复 `35eb0e4`）结论写入 `docs/webui-plugin-kernel-review-r15.md`：r13 干净树基线 8.7，四项 r14 blocker 全闭合，代码 GO 9.3/10；发布面为条件 GO，唯一剩余前置是环境恢复后的有效双机矩阵。B1 的 terminal_arb/journal 入账后失败屏障、B2 tombstone hard-cap fail-closed、B3 4096 共享义务准入预算、B4 close/provider-FIN 冻结均有源码与判别测试证据。
- r16 发布前置裁决（HEAD `4d6643c`）结论写入 `docs/webui-plugin-kernel-review-r16.md`：实现面维持 GO 9.3/10，发布面选择 C 维持原 24 个有效样本门。第四轮仅有 3 个有效周期，cycle 3 同时记录 `post=[RECOVERY-FAILED]`，其余 21 周期为 `ABORT(no-dataplane)`；环境终章证明 QUIC 防护是外部累积/方向性/粘性阻塞，但不能替代 24 个有效样本或 `RECOVERY-FAILED=0`。历史 48+ 周期旁证仅作为 supplied support，未独立绑定到当前 HEAD，因此不得 archive→merge→push；环境恢复后按原门重跑。
