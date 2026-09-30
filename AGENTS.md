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
- r13 终确复验（HEAD `82cee55`）结论写入 `docs/webui-plugin-kernel-review-r13.md`：8.7/10 NOT-READY。B3 闭合；B1 终态语义仍非 first-terminal-wins（FIN-先完成后 abort 窗口、恢复快照不共用仲裁锁）、B4 失败后仍可重放（journal 先写、PhaseFail::Op/Join 无清理、OPEN 后至触发请求）、新增 P1：abort 永久占用 128 活跃流配额。最小闭合：统一 FIN/abort 终态规则、失败请求不得重放/触发副作用、拆分终态信息与配额。
