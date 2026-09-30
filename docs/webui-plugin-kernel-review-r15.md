# webui-plugin-kernel 终确复审 r15

## 范围与基线

审查固定于 HEAD `728e82a`，其前为编排席测试修复 `35eb0e4`。本轮只复核 r14 点名的 B1-B4，并检查 `35eb0e4` 是否引入测试面回归；未杀、未重启现有 sidecar/hub。工作区在报告写入前干净，`git diff --check 35eb0e4..728e82a` 与 `git diff --check HEAD` 通过。

评分基线采用 r13 **干净树 8.7/10**（r14 报告记为 `82cee55` 的干净树读数），不采用 r14 为在途半成品 `84d4726` 给出的 8.0/10。这样本轮增量只回答四个真实残余是否闭合，不把半成品状态混入基线。

证据分层如下：源码和四个判别测试为本轮独立核对；`/tmp/gate2-fabric.log` 中已完成的 dweb-fabric 全套为独立进程观察到的回执（unit 205/205、continuity_http 21/21，其余二进制均无失败）；workspace 654/0、client-sdk 99/99、ext-ports 43/43、webui 262/262、clippy、`.node` 重建和签名门禁是编排席/实现席提供的回执，本轮没有重复启动高负载全仓构建。

## 四项闭合核验

### B1：journal 入账后发送失败的恢复竞态

**闭合。** `settle_abort_cleanup()`（`crates/dweb-fabric/src/continuity/http.rs:325-338`）在返回错误前调用 `settle_local_abort()`；它同步完成终态和 journal 清账，只有 RESET 的 wire 补发在随后 detached task 中执行。OPEN、DATA、FIN 的 Op/Join/Cancel/Deadline 分支均经过该 helper（`http.rs:456-547`）。

`SessionChannel::send_data()` 在同一 `terminal_arb` 内完成 journal `record_send`、wire 发送和失败后的 `mark_local_abort`（`crates/dweb-fabric/src/continuity/session.rs:2441-2465`）。OPEN 的底层发送失败也在返回前落 `mark_local_abort` 并移除 `stream_keys`（`session.rs:2661-2713`）。因此恢复重放不能在“发送已失败、调用方尚未看到 Err”的窗口取得快照。

判别测试 `failed_data_send_after_journal_commit_settles_before_return`（`session.rs:5292-5363`）先用 wire lock 证明 DATA 已进入 journal，再启动恢复重放并断言其等待；释放停止通道后，测试断言返回 Err 时已经是 `LocalAbort`、journal 为零、`replay_batches()` 为空，重放结果为 `false`，RESET 义务仍在 registry。该测试命中了 r14 缺口要求的入账后 wire 失败交错，不是旧 h21 的入账前容量失败。

### B2：未知 RESET tombstone 的远端扩张

**闭合，代价明确。** `reset_tombstones` 已是 `HashSet`，容量达到 1024 后不再丢弃旧义务来继续收帧，而是置 `peer_state_exhausted`、同步将会话置 `Dead` 并计违规（`session.rs:1986-2028`）。帧入口在语义处理前检查该闸门，后续所有入站帧直接丢弃（`session.rs:1678-1692`）；Dead 会话的候选恢复安装也被拒绝（`session.rs:782-793`）。

`unknown_reset_flood_fails_closed_at_hard_tombstone_cap`（`session.rs:6718-6754`）发送 1025 个新鲜唯一 RESET，断言集合保持 1024、会话为 Dead，迟到 OPEN 不产生 `new_open`。这封住了对端以新 stream id 绕过被丢弃取消记录并启动 handler 的路径。

这里的 blast radius 是有意的：一次恶意或失控的未知 RESET flood 会牺牲整个多路复用 session 的剩余流，而不是只牺牲一个流。若继续接收其它流，系统无法证明被淘汰的取消是否对应迟到 OPEN；因此 fail-closed 是本缺口要求的安全优先取舍，不构成未闭合项。

### B3：aborted_registry 淘汰依据与 4096 共享预算

**闭合，公平性取保守策略。** 时间戳和 `resume_giveup()` 淘汰已删除；`aborted_registry` 只保存未确认 RESET 的 stream id，并保留到 `SessionShared` 释放（`session.rs:500-523,1283-1292`）。`mark_local_abort()` 采用 `aborted_registry -> streams` 锁序，在登记义务前不释放活跃流的预算（`session.rs:1186-1209`）。

`reserve_stream_slot()` 用相同锁序原子计算 `active + pending RESET`，达到 `ABORTED_REGISTRY_CAP=4096` 即拒绝新流（`session.rs:1634-1665`）。因此并发取消不能在检查后再把义务数推过上限，旧义务也不会因年龄或“本次 RESET send 成功”被静默丢弃。`stale_aborted_reset_obligations_are_retained_and_bound_admission`（`session.rs:6759-6792`）填满陈旧义务、登记最后两个流并断言第 4097 个预算请求被拒，最早义务仍保留。

这不是平均分配策略：4096 个未确认义务会冻结该 session 的新流准入，义务优先于新流，直到收到可证明的确认或会话释放。当前协议没有 RESET 应用层 ACK，因此不把 wire send 成功误作确认；这是 r14 要求的有界正确性取舍。它只保证 named registry/准入预算；完整 session 的终态元数据仍随 `SessionShared` 生命周期结束清理，未把其它生命周期设计扩大为本轮 blocker。

### B4：close 与 provider-FIN 冻结

**闭合。** `abort_is_frozen()` 集中表达四分支冻结规则（`session.rs:691-696`）。`reset_open_streams()` 先持有 `terminal_arb` 再快照 stream id，并在每条流发送 RESET 前重新检查同一冻结条件、执行 `mark_local_abort`（`session.rs:706-747`）。`Session::close()` 先置 `closing`、阻止新流，再通过该函数处理当前通道（`session.rs:2988-3014`）。

`close_reset_enumeration_preserves_provider_fin_freeze`（`session.rs:6628-6655`）以 provider `final_sent=Some` 且请求方向仍半开的状态验证 close 不落 `LocalAbort`、不追加 RESET。因而 provider FIN 已完整上 wire 后，close 不会再制造与干净 EOF 冲突的错误信号；client 已发请求 FIN 而响应未终局的形态仍按 §2b 进入完整取消。close 的既有 2 秒 best-effort 预算可能让极端多流会话来不及枚举完所有流，但不再绕过本项终态裁决。

## 35eb0e4 测试面修复

该提交只改 term-exit fixture/test：`fixtureChild.once("exit")` 在 `spawnSidecar` 前立即注册，超时从 30 秒收紧到 12 秒，fixture 尾部保留 unref 泄漏哨兵。此修复消除了全量负载下监听晚注册导致的假红；用户回执称修复后 20/20 与 webui 262/262 通过。源码 diff 没有改变数据面协议或生产运行时。

## 双机矩阵与条件结构

矩阵 harness 面已达到 r14 要求：`/tmp/wpk-matrix-run.sh:62-125` 对 `kill-mini`/`kill-imac` 先调用 `precheck`，只有 curl PID 存活、完成标志未落且 `0 < bytes < total` 才执行 kill；否则分类为 `INVALID-INJECT`。有效样本统一按 exit、HTTP 状态、总字节和 MD5 判定，`exit=0 + 200 + 短体/错 MD5` 才计 VIOLATION。`/tmp/wpk-mini-ctl.sh:63-120` 记录同一注入前证据并拒绝无效 kill。

有效双机矩阵本轮仍不能执行，但阻塞已被可靠二分到环境：更正后的探针显示裸 UDP、TCP、MTU 正常，而新旧两代 `.node` 的跨机 iroh QUIC 都在 30 秒拨号超时，回环 invite/join 通过（`/tmp/wpk-matrix-env-status.md:60-80`）。因此这不是本轮代码 blocker，也不能被伪造为已通过的双机 receipt。

本轮采用以下条件化结构：

1. **实现/代码裁决：GO，9.3/10。** r13 干净树的四项残余均有源码闭合和判别测试；没有新的 P1 blocker。
2. **archive→merge→push：条件 GO。** 双机矩阵是唯一剩余的发布前置；QUIC 环境恢复并重新配对后，使用 HEAD `728e82a`、当前 `.node` 和修正后的 harness 跑完 24 个计划周期。有效样本必须全部为 `PASS-FAIL` 或完整 MD5 精确的 `PASS-RECOVERED`，`VIOLATIONS=0`、`RECOVERY-FAILED=0`、无 `200:0`；`INVALID-INJECT` 单独记账且不计入有效样本。满足后可直接 archive→merge→push，不需要再改代码或补同窗的第四类确定性测试。

## 非阻塞观察

- `terminal_arb` 仍可能在单帧 wire timeout 期间串行化同一 session 的其它流终态操作；这是吞吐/尾延迟权衡，不属于 r14 四缺口。
- B2 的整 session fail-closed 与 B3 的准入冻结分别是明确的资源安全代价，部署监控应把它们作为可观测的 session 级事件。

## 最终裁决

**GO（实现面）；条件 GO（发布面，唯一前置为有效双机矩阵）。**

四项 r14 blocker 已闭合，评分相对 r13 干净树 8.7 提升至 **9.3/10**。本报告不把未能执行的跨机矩阵冒充通过；它只保留为环境恢复后的发布闸门。
