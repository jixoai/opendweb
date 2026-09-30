# webui-plugin-kernel 实现终确 r13

## 范围与证据

核对基线为 r12 `0dfaa4b`，HEAD 为 `82cee55`，重点检查 `e7e95ae`（kernel B1/B3/B4 + 6 测试）、`67ede31`（JS/TS ABI + .node）、`c60a03d`/`82cee55`（清理）对 r12 三缺口的闭合。静态读取 session.rs / http.rs / index.js / continuity_http.rs 与 AGENTS.md 评审记录。`git diff --check 0dfaa4b..HEAD` 通过，worktree clean。未重跑测试门禁或触碰双端进程；645/0、99/99 等门禁数字与 20/24 cycles 矩阵结果按 Owner/ZCode 回执记录（`/tmp/wpk-matrix.log` 在 Codex 侧不可读，未独立复核）。

## 阻塞问题

### B1：终态语义仍不是真正的 first-terminal-wins，P1

`terminal_arb` 串行化了 FIN 与 abort，但 FIN 先完成后，`abort_stream()` 仍会设置 LocalAbort、清除 final_sent 并发送 RESET（session.rs:1109、2206）。接收端可能已在 RESET 到达前把 FIN 返回为 null；h19 特意等到 PeerReset 后才调用聚合读取，没有覆盖这个窗口（continuity_http.rs:1490）。此外，恢复端先取 FIN 快照、再发送，快照与 abort 不共用仲裁锁，之后到来的 abort 无法撤回快照中的 FIN（session.rs:1847、4194）。需统一「FIN 先完成后再 abort」的契约，并让恢复重放在实际发送时受终态仲裁约束；补测消费端先读到 FIN、以及恢复快照后与 abort 并发的情形。

### B4：调用方 deadline 有界，但请求失败后仍可能继续发送或执行，P1

OPEN/DATA/FIN 通过后台 task 观察 deadline，超时路径异步启动清理。但 DATA/FIN 的 `PhaseFail::Op` 和 `Join` 分支直接返回，没有启动 abort 清理；同时 `send_data()` 先写 journal 再发送，恢复后这些数据仍可能被重放（http.rs:482、session.rs:2183）。超时清理也与未完成的 OPEN send task 分离；接收端会丢弃未知流的 RESET，随后到达的 OPEN 仍可触发请求（session.rs:1750、http.rs:737）。现有 stalled-body 测试只断言调用方及时收到错误及本地稍后落入 LocalAbort，没有断言对端不启动 handler。需补受控的 OPEN 排队、DATA 发送失败后恢复、RESET 与副作用闸门竞速测试，并保证失败的请求不会在调用方收到错误后继续重放执行。

### 新增 P1：abort 会永久占用活跃流名额

`mark_local_abort()` 清除 final_sent，而 `quota_reapable()` 要求 final_sent 存在；`reserve_stream_slot()` 会持续把该流计入 128 条上限（session.rs:1089、298、1444）。在复用的长驻会话上，累计 128 次取消即可拒绝后续新流。提交注释虽披露了这个代价，但它把「活跃流」上限变成会话寿命内的累计 abort 上限；归档前应拆分保留 RESET 重放所需的终态信息与活跃流配额，或明确纳入产品和协议约束并补上 128 次取消后的验收。

## 已闭合与证据边界

- **B3 通过**：`recv()` 先交付已排队前缀，队列排空后把 Active LocalAbort 作为终止条件返回错误；h17/h18 覆盖响应体与请求体聚合读取（session.rs:1319、continuity_http.rs:1284）。
- 矩阵脚本现在按状态码、大小、MD5 分类，并在 kill-curl 前检查注入有效性；矩阵结果按回执记录，未独立复核。

## 最小闭合清单

1. 冻结并实现一致的 FIN/abort 终态规则，封住恢复重放竞态。
2. 让 DATA/FIN 发送错误和超时后的后台发送都不能在调用方失败后触发请求重放或 provider 副作用。
3. 解决 abort 流永久占用 128 条配额的问题。

闭合后再做 focused 复验。

## 评分与结论

**评分：8.7/10（较 r12 的 8.5 上升 0.2）。** 评分上升反映 B3 已修复、发送阶段开始受单一 deadline 约束、矩阵判定脚本已纠正；未放行由上述三个阻塞项决定。

**最终结论：NOT-READY。** 当前不建议 archive→merge→push。
