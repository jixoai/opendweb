## ADDED Requirements

### Requirement: handler 生命周期信号（sessionId / signal / writer 三态）

`/http` 的 serveHttp handler 请求对象 SHALL 携带会话与取消生命周期信号：

- `sessionId: string` — 请求所属逻辑会话 id（32 字符小写 hex；内核本地派生事实，非 wire
  字段，不可被对端伪造）；授权缓存 SHALL 以 session_id 为隔离键（同 peer
  不同 session 不继承授权——spec fabric §3.2 的会话级隔离前提）。
- `signal: AbortSignal` — 对端取消（RESET / 会话终态遗弃）事件驱动触发；
  挂起中的 handler（未开始 write）SHALL 也能即时收到 abort，不依赖下一次
  write 的错误回流。正常完成的请求 signal SHALL NOT 触发。
- respondStreaming 返回的 writer SHALL 提供三个正交观测 getter：
  - `finished` — 本地已调用 `finish()`（半关意图）；
  - `cancelled` — 对端取消事件已触发本请求；
  - `closed` — 底层投递通道已关（内核不再消费后续 write）。
  getter 为观测面；`write()` 的错误返回仍为取消/关闭的真相面（0.5.0
  语义不变）。

#### Scenario: 同 peer 新 session 不继承授权

- **WHEN** peer 的 session A 完成授权后断开，同 peer 以新 session B 重连
  且 B 尚未 AUTH
- **THEN** B 的请求事件携带 B 的 sessionId；下游按 sessionId 隔离的授权
  缓存查无 B 的条目 → 401（在 app 层拒绝，内核不裁决授权）

#### Scenario: 挂起 handler 秒停

- **WHEN** 流式 handler 尚未 write（等待慢上游），对端 abort → RESET 到达
- **THEN** handler 的 `req.signal` 在事件驱动下触发 abort（有界时延，
  不依赖 write 尝试）；随后 write/finish 收敛不再消费

#### Scenario: 正常完成不误报取消

- **WHEN** 流式响应正常 FIN 且 dispatch 标记完成
- **THEN** `req.signal` 不触发；writer `closed` 翻转 true、`cancelled`
  保持 false、`finished` 反映本地 finish() 调用

#### Scenario: cancel 事件为 best-effort 信号

- **WHEN** TSFN 队列满或 server 已 close，cancel 事件发射失败
- **THEN** 不阻塞不抛错（NonBlocking 信号语义）；后续 write 的错误返回
  仍如实暴露取消事实
