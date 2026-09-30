# webui-plugin-kernel 实现终确 r12

## 范围与证据

核对基线为 r11 `74e4ce6`，HEAD 为 `0dfaa4b`，重点检查 `934e46e`、`07e6ee0`、`0dfaa4b` 对 B1-B4 的修复。静态读取 Fabric、client-sdk、ports provider、OpenSpec delta、点名测试，以及 `/tmp/wpk-matrix.log` 和矩阵脚本。`git diff --check 74e4ce6...HEAD` 通过。未重跑 Cargo、Node 全量门禁或双机流程；323/0、98/98 等结果按 Owner/ZCode 回执记录，不作本轮独立实跑结论。未触碰双机进程。

## 阻塞问题

### B1：abort 与 FIN 的终态仲裁仍有竞速，P1

终态模型主体已落地：`StreamTerm` 对错误终态保持粘滞；`mark_local_abort()` 在 streams 锁内先记 LocalAbort；dispatch 在 body 关闭后复查 LocalAbort 与 peer RESET；恢复时补发 RESET（`crates/dweb-fabric/src/continuity/session.rs:285-296,1061-1077`、`crates/dweb-fabric/src/continuity/http.rs:709-749`）。但发送端 FIN 与 abort 仍没有共同的线性化点：`SessionChannel::finish()` 检查 LocalAbort、写入 `final_sent` 后释放 streams 锁，之后才发送 FIN（`session.rs:2151-2175`）。在该间隙到达的 abort 可以先记 LocalAbort，而已排队的 FIN 仍可能先于 RESET 发出。

此组合在恢复时也未被排除：`fin_resent_streams()` 无条件收集 `final_sent`（`session.rs:1797-1803`）；两端恢复路径都先重放 FIN、再重放 LocalAbort 的 RESET（`session.rs:4126-4155,4343-4370`）。消费端若在 RESET 被处理前读到 FIN，会把 `StreamTerm::Fin` 映射为 `null`（`packages/client-sdk/src/http.rs:150-160`），仍可能把中断响应当作干净 EOF。

另一个可达入口是 public writer API：native `abort()` 是 async，而 JS wrapper 丢弃其 Promise 并将 `abort()` 暴露为 `void`；`finish()` 同步关闭 sender，且不检查 abort 请求状态（`packages/client-sdk/src/http.rs:783-805`、`packages/client-sdk/http/index.js:172-185`、`packages/client-sdk/http/index.d.ts:50-58`）。同一事件轮次里的 `writer.abort(); writer.finish()` 不能保证 LocalAbort 先于 sender 关闭。内置 ports provider 用 `done` 标志缩窄了这个调用序列，但 SDK 公共句柄没有冻结 first-terminal-wins 规则。

**最小修复：**把 abort 请求和 FIN 发送收敛到同一个原子终态仲裁；FIN 已排队/可重放时遇到 LocalAbort 必须取消该 FIN 或确保 FIN 不会先于 RESET 成为可观察 EOF。同步修订 JS/TS ABI（使 abort 可等待，或同步落 abort-requested 状态并令 finish 拒绝）。增加 barrier 控制的 active 与 Recovering 竞速测试，覆盖 `abort()`/`finish()` 同轮、FIN 已登记后 abort、恢复重放三种路径，断言 bodyNext 绝不 resolve null。

### B3：活动会话中的 LocalAbort 未令聚合读取终结，P1

两个聚合器现在仅在 `StreamTerm::Fin` 时返回成功，其它错误均返回 `Err`；RESET、协议错误和会话关闭路径因此已明显改善（`crates/dweb-fabric/src/continuity/http.rs:91-109,290-305`）。但本地 abort 的内核读取路径仍不闭合：`mark_local_abort()` 只设置 `term` 并 notify，没有设置 `remote_final`（`session.rs:1061-1069`）；`recv()` 只有在 `remote_final == recv.expected_offset()` 时才读取终态，随后才返回错误（`session.rs:1283-1310`）。对仍 Active 的会话，本地 abort 唤醒后会再次等待，聚合读取器到不了映射为 `Err` 的分支。

h14 在 `client.close()` 后才开始聚合读取，依靠 Dead/Closed 会话错误终结；h11 覆盖的是对端 RESET。二者都未覆盖活动会话中的 `HttpClientResponse::abort()` 后调用 `read_all_body()`。ports delta 要求传输失败错误终结而不能伪装 clean EOF（`openspec/changes/webui-plugin-kernel/specs/plugins/ports/spec.md:39-42`），当前 API 还可能挂起。

**最小修复：**在队列中已交付数据耗尽后，让 LocalAbort 成为 `recv()` 的终止错误条件，不依赖远端 final offset；保持已排队前缀可读，再以 Err 终结。增加 Active 会话、本地 abort、已有前缀后的 `read_all_body()`/`RequestBody::read_all()` 用例，断言在短的确定性时限内返回 Err。

### B4：head deadline 没有约束 OPEN 与请求体发送，P1

`head_deadline` 在入口创建，活性闸门会检查剩余时间并 select 取消；OPEN 前会检查取消，body 每块前和 FIN 前也检查取消，响应头等待使用剩余预算（`crates/dweb-fabric/src/continuity/http.rs:332-378,402-435`）。但 OPEN、每次 `send_data()`、`finish()` 的 await 没有使用该 deadline，body 循环也不检查 deadline（`continuity/http.rs:402-420`）。底层 `send_frame()` 另有每帧独立 5 秒 timeout（`session.rs:89-91,2111-2129`），故一个配置为 1 秒的 head timeout 仍可能在 OPEN 上等近 5 秒，多块 body 的耗时还可按块数累加；只有 body 全部发送后才会在响应头阶段发现预算已耗尽。

h16 只通过 Recovering 闸门消耗 1.2 秒，再验证 handler 延迟时响应头等待使用 2 秒预算；没有请求体，也没有受控的 OPEN/DATA/FIN 背压等待（`crates/dweb-fabric/tests/continuity_http.rs:1208-1273`）。实现注释声称整次操作共享 deadline，但公共 d.ts 仍描述为“响应头等待上限”（`packages/client-sdk/index.d.ts:367-376`），语义也需统一。

**最小修复：**按冻结的单一 deadline 约束 OPEN、每个 DATA 和 FIN await；超时/取消必须走流终止清理，不能留下已登记的 ghost OPEN、journal 或可执行的 provider 请求。补可控发送阻塞与多块请求体测试，断言总耗时受单一预算约束、取消不遗留半开流。若产品实际只承诺“响应头等待上限”，则需撤回整次预算承诺，并同步 design、注释和 h16 的验收范围。

## B 项判定

- **B1：未闭合。** 主路径顺序已修，但 abort/FIN 并发仲裁及恢复重放的 FIN 优先风险仍存在。
- **B2：通过。** `StreamTerm` 已覆盖 FIN、RESET、协议错误和 LocalAbort；N-API 的 `term_err()` 只有 Fin 返回 `null`（`packages/client-sdk/src/http.rs:47-66,150-160,675-691`）。本轮未重跑测试。
- **B3：部分通过，未闭合。** 聚合读取器的 FIN-only 成功判定正确；Active LocalAbort 不使 `recv()` 返回错误，仍会挂起。
- **B4：部分通过，未闭合。** 活性闸门取消、OPEN 前检查、逐块取消检查及响应头剩余预算已落实；共享 deadline 未覆盖发送 await。

## 双机矩阵与门禁

第二轮 `/tmp/wpk-matrix.log` 原始行共 24 个：9 个非零退出/错误响应，11 个 96MiB 且 MD5 精确的恢复，另有 4 个 `kill-curl` 记录被脚本标为 `VIOLATION`。逐项核对这 4 个记录是 3 个完整 96MiB、MD5 精确的 200，以及 cycle #4 的 HTTP 502、203B；第二轮没有观察到短体或空体的 clean 200。

但 `/tmp/wpk-matrix-run.sh:3-6,83-85` 的说明称 violation 是 `exit=0 + 200 + size!=expected`，实际 `kill-curl` 分支却仅以 `exit=0` 判 violation；因此 502/203B 也被计入。`/tmp/wpk-mini-ctl.sh:63-67` 在 kill 前不检查 curl PID 是否存活，只在 kill 后确认 PID 消失，不能证明后三个完整 200 是有效中断。故矩阵支持“本轮未见短体 200”，但回执中的“四次迟杀全量”和四次有效 kill 都未被原始数据证实。建议修正 harness：按 HTTP 状态、size、MD5 统一分类，并记录 kill 前 PID/transfer bytes 与完成标志。

本轮独立执行了 `git diff --check`；其余测试及 `.node` dlopen/md5、双机中断矩阵、clippy/rustfmt 为 Owner/ZCode 提供的回执，没有在本轮重跑。

## 非阻塞项

- `07e6ee0` 的 `abort_join_bounded()` 留有未使用的 `_deadline` 参数，且日志仍描述为在 shutdown deadline 内终止，但实际 abort 后使用固定 100ms 宽限（`crates/dweb-fabric/src/fabric.rs:967-990`）。不影响本次 B1-B4 判定，建议后续清理参数与日志措辞。
- E1′-① 进程内新拨号停滞仍是持续使用体验债；可进入后置 change，但应明确告知用户长时间运行后设备重连可能需要重启 sidecar。它不豁免上述 body integrity 与 deadline 缺口。

## 评分与结论

**评分：8.5/10（较 r11 的 8.2 上升 0.3）。** 终态分类、RESET 恢复补发、聚合器异常错误处理、provider 写失败 abort 与双机故障注入都有实质改进；原始矩阵未见 clean 200 短体。扣分来自 B1 仍可能让 FIN 先于 RESET 被消费、B3 活动 LocalAbort 聚合读取不终结、B4 单一 head deadline 没有贯穿发送操作，以及矩阵 harness 对 kill-curl 的错误分类。

**最终结论：NOT-READY。** archive 前最小闭合为：修复并钉住 B1 abort/FIN first-terminal 仲裁（含恢复重放）；令活动 LocalAbort 下聚合读取快速 Err；使 head deadline 覆盖 OPEN/body/FIN 并补受控阻塞测试，或同步撤回该预算语义；修正双机矩阵 harness 的结果分类与 kill 生效判定。上述代码与测试闭合后再进入 archive/merge/push。

## Standards

当前 diff 未发现硬性仓库编码规范违例。判断性改进有三项：native `abort()` 是 async，但 JS wrapper 丢弃 Promise 并声明 `void`，调用方无法表达 abort 完成后再 finish；`abort_join_bounded()` 的 `_deadline` 参数未使用且日志仍声称受 shutdown deadline 约束；`respondStreaming` 的 JS 返回对象注释未列出 `abort()`，而 `.d.ts` 已列出。第一项与 B1 竞态重叠；后两项不单独阻塞本轮归档。

## Spec

ports delta 要求上游中断只能以错误终结，不能以干净 EOF/200 外显（[ports spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-plugin-kernel/specs/plugins/ports/spec.md:39)）。B2 已满足“只有 Fin 返回 null”；B1 的 FIN/RESET 仲裁仍可让中止先以 null 被消费，B3 的活动 LocalAbort 可让聚合读取不终结，B4 则没有让已承诺的单一 deadline 覆盖 OPEN、DATA、FIN 等待，因此三项仍未满足本轮闭合条件。

评审轴汇总：Standards 0 项硬性违例、3 项非阻塞判断性改进（最值得收敛的是 abort 的异步完成契约）；Spec 3 项未闭合 P1，最严重为 B1 可将中止响应暴露为干净 EOF。
