# webui-plugin-kernel 终确复审 r14

## 范围与证据

审查目标为 HEAD `b9678ec`，对照在途半成品检查点 `84d4726`；审查开始时工作区干净，`git diff --check 84d4726..b9678ec` 通过，本轮只新增本报告。核对了 `session.rs`、`http.rs`、`continuity_http.rs` 的实现和相关测试。未运行测试或重型门禁，也未操作双端 sidecar/hub；650/0、client-sdk 99/99 等数字是提交者提供的实跑回执，不是本轮独立复跑。

## 阻塞问题

### B1：失败返回早于本地取消结算，恢复仍可能重放已失败请求

`spawn_abort_cleanup()` 只启动 detached task 后立即返回（`http.rs:336`）。OPEN、DATA、FIN 的 Op/Join/Cancel/Deadline 分支调用它后立刻向 fetch 调用方返回错误（`http.rs:458`、`http.rs:495`、`http.rs:528`）。与此同时，`send_data()` 的顺序是先 `record_send()` 入 journal，再发送 DATA（`session.rs:2445`）。如果 journal 写入成功而后续 wire 发送失败，错误返回后、清理 task 获得 `terminal_arb` 前，恢复可以先取到该 journal 快照；此时 stream 尚非错误终态，`replay_data_arbited()` 的终态复查仍会放行该 DATA（`session.rs:2555`）。这仍违反“失败请求不得重放/触发副作用”的承诺。

h21 不能证明该窗口已闭合：它用 64B 单流上限发送首个 128B chunk，失败发生在 `record_send()` 的容量检查，数据没有进入 journal；测试又在 fetch 返回后等待 200ms 才检查 `LocalAbort` 和 journal 清零（`continuity_http.rs:1729`、`continuity_http.rs:1785`）。因此测试没有覆盖“已记账、发送失败、恢复抢先”的路径，也没有证明 fetch 返回错误时本地终态已落位。

修复建议：错误返回前同步完成本地终态线性化及 journal 清账，只把 RESET 的 wire 发送留给后台任务；同时确保在途发送不会在本地中止后继续提交。增加确定性屏障用例：`record_send()` 成功后注入 `send_frame()` 失败，并让恢复与清理竞争；断言调用方观察到 Err 时已是 `LocalAbort`、journal 为零，恢复绝不发出 DATA/OPEN，RESET 仍可补发。对 OPEN/DATA/FIN 的 Op、Join、Cancel、Deadline 分支分别验证同一结算边界。

### B2：未知流 RESET 的 tombstone 容量不是硬上限，远端可放大内存

入站 RESET 未知流时，代码直接把对端给出的 stream id 插入 `reset_tombstones`（`session.rs:2002`）。除 direction 外，RESET 没有 stream-id 奇偶、已分配水位或数量校验；奇偶校验目前只应用于 OPEN（`session.rs:1719`）。`RESET_TOMBSTONE_CAP=1024` 并非硬上限：`prune_freshness_bounded()` 在条目都新于 90 秒时删零项，明确允许 map 超 cap（`session.rs:495`）。因此已认证的 session peer 可在一个恢复窗口内发送大量唯一 RESET，令 map 持续增长；“stream id 单调且不复用”只避免误伤后续合法新流，不限制远端提交多少不同 id。

修复建议：对未见流 RESET 实施每会话硬预算或基于合法远端 OPEN 水位的有界窗口。预算耗尽时必须 fail-closed（例如计数并终止该 session 或暂时拒绝新 OPEN），不能静默丢弃 tombstone 后继续允许同 id OPEN 启动 handler。添加超过 1024 个新鲜唯一 RESET 的测试，断言内存状态有硬界且后续 OPEN 不会绕过取消。

### B3：aborted_registry 的 90 秒淘汰论证不成立，且软上限也不构成内存界

`prune_freshness_bounded()` 把“条目距上次登记/重放已超过 `resume_giveup()`”等同于“会话已 Dead”（`session.rs:485`）。但 giveup 看门狗只在会话进入 Recovering 后开始计时；条目可以在 session 仍 Active 时变旧。比如 session 保持 Active 超过 90 秒后，新的中止使 registry 超 cap 并触发 prune，旧条目会被删；其年龄本身并不能证明会话已进入过恢复放弃态。恢复重放清单没有 RESET 的应用层 ACK，`send_frame()` 成功也没有在代码中证明对端已把该流收敛为 `PeerReset`。因此不能仅凭年龄丢弃跨代 RESET 义务。

此外，`ABORTED_REGISTRY_CAP=4096` 也是软上限；90 秒窗口内本地取消速率没有硬约束时，fresh 项可以无限超 cap。修复建议：把淘汰条件绑定到可验证的会话终态（Dead/Closed）或 RESET 确认，而不是独立的 entry age；在保留所有未确认义务时对新中止施加硬资源策略，不能靠丢最旧义务维持上限。增加“Active 超过 giveup 时间后触发 prune”与超 cap 新鲜取消测试，验证义务不会静默丢失且资源策略确有硬界。

### B4：close 绕过四分支终态裁决，可对 provider 已发出的响应 FIN 再发 RESET

`abort_stream()` 的冻结规则规定：provider 的响应 FIN 一旦完整发出，迟到 abort 对任意 `remote_final` 都无操作（`session.rs:1233`）。但 `reset_open_streams()` 只跳过双向都已 FIN 的流；对 provider `final_sent=Some`、`remote_final=None` 的半开流仍直接发 RESET（`session.rs:727`），而 `Session::close()` 正是直接调用这条路径（`session.rs:2997`），没有经过 `terminal_arb` 或四分支裁决。若接收端在处理 RESET 前后才消费已到达的 FIN，粘滞错误终态可能让同一响应呈现为干净 EOF 或 Err，和 provider FIN 分支冻结的结果不一致；并发 finish/close 还可能改变 FIN 与 RESET 的发送次序。

修复建议：明确关闭会话是否有意覆盖 provider-FIN 规则。若无意覆盖，则 close 对每条流走同一仲裁裁决，并为 FIN 已发/对端未终局的 provider 流加帧顺序与消费结果测试；若确实是特例，则把特例写入契约并测试关闭时应用可观察到的唯一结果。

## 闭合项验收

- **FIN/abort 四分支与恢复 FIN 仲裁：部分通过。** `finish()`、`abort_stream()`、`replay_fin_arbited()` 共用 `terminal_arb`，`final_sent` 在该锁内与 FIN 完整发送对应；LocalAbort 会同步清 `final_sent` 并清理 journal。锁顺序为 `terminal_arb → streams/send`，本次静态核对未发现反向嵌套。h19/h20 和四格矩阵覆盖了主要顺序。B4 所列 close 路径仍绕过该规则。
- **OPEN/DATA/FIN 恢复发送仲裁：通过主体路径。** 三个 arbited 方法在发送前持锁复查终态，能撤销已取快照但尚未仲裁的发送；DATA 同时排除 PeerReset、ProtocolError、LocalAbort。该结论不弥补 B1 的错误返回窗口：重放如果先于 detached cleanup 取得仲裁锁，仍可合法通过复查并发送。
- **RESET tombstone：功能路径通过，容量边界不通过。** 单调不复用 id 可避免某个已消费 tombstone 误伤另一个合法新 id，RESET-before-OPEN 测试证明正常单项路径；它不解决新鲜 tombstone 超 cap 无法淘汰的问题，也不限制 peer 生成任意不同 id。
- **abort 配额回收与前缀交付：通过主体路径。** 错误终态即时释放 128 活跃配额，LocalAbort 同一 streams 锁内清空 journal；`recv()` 先交付队列前缀，再以错误终结。140 次中止用例覆盖配额恢复。RESET registry 的未确认义务及内存界仍见 B3。
- **PhaseFail 分支：代码覆盖完整，行为证据不足。** OPEN/DATA/FIN 的 Op、Join、Cancel、Deadline 分支均调同一个 cleanup helper；但 helper 异步且 h21 在 journal 入账前失败，不能证明失败返回与恢复之间的结算原子性。
- **双机矩阵：本轮未复跑。** 当前 roster 失配使双机环境不可用；矩阵补跑本身可待环境恢复后作为补充验收，不单独阻塞本轮。确定性测试可替代环境矩阵来验证协议交错，但 h21 尚未覆盖 B1 指定的记账后失败竞态，因此替代证据目前不充分。

## 非阻塞改进

- `terminal_arb` 在 FIN/RESET/恢复帧写入期间持有 session 级锁；单帧发送有 5 秒内部上限，abort RESET 有 2 秒外层上限，但慢流仍会阻塞同 session 其他流的终态操作。可评估以每流状态锁和有序发送意图替代全会话临界区，并补多流取消延迟测试。
- OPEN、DATA、FIN 三处重复映射 PhaseFail，建议抽取统一的本地结算入口，避免后续分支语义漂移；该重构不能把本地结算重新移回 detached task。

## 评分与结论

综合评分：**8.3/10**。较干净树 `82cee55` 的 **8.7** 低 0.4：b9678ec 实质补上终态仲裁、journal 清账和配额回收，但仍有调用方错误先于清理返回的体完整性竞态、可由 peer 放大的无界 tombstone，以及 close 与 FIN 冻结契约不一致。较 `84d4726` 半成品检查点的 **8.0** 高 0.3：本提交关闭了 FIN 快照竞态、常规取消重放和配额耗尽问题；增量测试与实现也更完整，但尚不足以证明恢复不重放。

**结论：NOT-READY。** archive→merge→push 前最小闭合清单：

1. 失败返回前同步线性化本地 abort 与 journal 清账；用“已入账后 wire 失败 + 恢复竞争”的确定性用例验证，替换当前 h21 的入账前失败探针。
2. 为未知流 RESET tombstone 设硬资源界和超限 fail-closed 行为，并覆盖大量新鲜唯一 id。
3. 修正 aborted_registry 的 giveup 淘汰条件与硬内存策略，证明活跃会话中的未确认 RESET 不会被年龄淘汰。
4. 统一 close 与 provider 已发 FIN 的裁决，或冻结并测试 close 特例的唯一外显语义。

双机恢复后建议补跑中断/恢复矩阵，但该环境项不替代也不扩大以上四项代码闭合要求。
