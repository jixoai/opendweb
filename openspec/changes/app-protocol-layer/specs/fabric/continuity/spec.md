## ADDED Requirements

### Requirement: 连接状态快照与代次流

连接层 SHALL 为每个 peer 维护带单调 `connectionEpoch` 的
`ConnectionStateSnapshot`（phase/epoch/stateSeq/path/changedAt/reason），并经
`watch_connection(peer, after_state_seq)` 提供单调 `stateSeq` 状态流。订阅前
必须先取 snapshot；发现 sequence gap 时调用方重拉 snapshot。原始
`PeerDisconnected` 事件 SHALL 降级为连接层内部事实，不再作为会话层/应用层的
唯一状态源；丢批的 broadcast 通道不得用于状态收敛。

#### Scenario: 瞬断不直达应用

- **WHEN** 连接死亡且内核自动重连进行中
- **THEN** 会话层收到带 epoch 的状态翻转；应用层消费的是会话状态
  （active/recovering/dead），不直接收到原始 PeerDisconnected

#### Scenario: 订阅者 lag 后收敛

- **WHEN** 状态流消费者落后并错过若干 stateSeq
- **THEN** 重拉 snapshot 后收敛到最新状态，不依赖被丢弃的中间事件

### Requirement: session continuity 协议

新 ALPN `/dweb/fabric-continuity/1`（与 legacy envelope 物理隔离）SHALL 提供
跨 connection epoch 的逻辑会话：sessionId（128bit）+ epoch CAS resume 握手
（RESUME_INIT/OK/REJECT，固定 reason 码含 `REQUEST_STATE_LOST`）；每逻辑流
streamId+direction+byte_offset 单调推进 + 累计 ACK（可选 SACK）；发送端有界
replay journal（session 8MiB / stream 2MiB / 4096 段；**未确认年龄 90s 仅在
恢复窗口内累计**——健康连接下慢读只反压不判死）；接收端按 offset 去重
（重复帧逐字节校验，不一致即 RESET；gap 进有界缓冲）；旧 epoch 帧拒绝。
请求副作用状态机 SHALL 区分 NEW→ACCEPTED→STARTED→COMPLETED：STARTED 后
禁止自动重新执行上游调用（at-most-once + 128bit 幂等键跨 epoch 复用）。
resume token SHALL 由 SESSION_INIT 在已认证连接内分发（不复用 invite/PoP
凭据），**无绝对过期**——90s 时效属恢复窗口而非 token。轮换为**两代滑窗**：
每端保留 current/previous 两代 (generation, token)，RESUME 按 (generation,
token) 精确匹配二者之一；新代完成首次成功 RESUME 或恢复窗口结束后清除
previous，此后旧 token 拒绝。SESSION_INIT_REJECT 的 header 关联被拒 id、
payload 携 canonical 三元组；并发双 INIT 败方从胜方 INIT 帧登记 session 与
token。Phase 1 内存模式下未知 session 的 RESUME SHALL 统一回报
REQUEST_STATE_LOST（本端无历史，按重启丢失处理；UNKNOWN_SESSION 仅持久化
模式预留）。首次连接 SHALL
经 SESSION_INIT/SESSION_INIT_OK 建会话（幂等：对同 peer 已有会话时拒绝新建
并收敛到既有会话）。

#### Scenario: SSE 中途断线透明续传

- **WHEN** 分钟级 SSE 响应在第 N chunk 后连接死亡，90s 恢复窗口内新 epoch
  连接建立并完成 resume
- **THEN** 响应按原字节顺序继续投递，无重复 chunk，上游不重新执行

#### Scenario: 已执行请求不重复计费

- **WHEN** 请求已进入 STARTED（上游可能已产生副作用）后断线并 resume
- **THEN** 不自动重新执行上游调用；仅恢复响应重放或显式报告 RETRY_UNSAFE

#### Scenario: 慢消费者不误杀

- **WHEN** 连接健康但本地消费者长时间慢读
- **THEN** ACK 停滞触发发送端反压；未确认年龄不计时、流不被判死

#### Scenario: 进程重启如实失败

- **WHEN** 对端进程重启后旧 session 尝试 resume（Phase 1 内存 journal）
- **THEN** 返回 REQUEST_STATE_LOST，不假装续传

### Requirement: HTTP/WS 模拟层（Rust）

内核 SHALL 内置模拟 HTTP/WS 语义（Owner 2026-09-16 裁决，性能/内存归内核）：
虚拟服务端 `serveHttp(handler)` 与客户端 `fetchHttp(peer, req)`，请求/响应
正文流式（DATA 帧 + offset），SSE 投影逐帧透传；WS 为 upgrade 隧道，消息
边界/分片 offset/重复投递语义冻结。内核 SHALL NOT 解析 provider 目录、API key
或上游业务语义。

#### Scenario: 恢复期本地行为

- **WHEN** 会话处于 recovering 且未超 90s 窗口
- **THEN** 本地 SSE/WS 连接保持，不向用户返回 503；dead 后 SSE 关闭并报
  网络错误，WS 发 CLOSE(1012)，新请求才映射 offline

### Requirement: 模拟 UDP 契约化

现有 `send` 信封 SHALL 保留为 legacy best-effort 别名（at-most-once across
epochs，不进 journal）；新增 `sendDatagram` 显式承载同一契约。两者不因
continuity 上线而隐式改变可靠性语义。

#### Scenario: 连接死亡后信封丢失如实呈现

- **WHEN** sendDatagram 发出后连接死亡
- **THEN** 该消息可能丢失、不重放；应用自行决定重试

#### Scenario: 首次建会话与 token 轮换

- **WHEN** `openSession(peer)` 首次发起 SESSION_INIT 后连接断线，恢复窗口内
  新连接 RESUME 成功，且新代 token 再次完成一次成功 RESUME
- **THEN** previous 代被清除，旧 token 的 RESUME 拒绝；在新代首次成功 RESUME
  前，旧 token（previous 窗口内）仍可恢复——两代滑窗语义

#### Scenario: 长寿命会话断线仍可恢复

- **WHEN** 会话健康运行远超 90s 后发生瞬断
- **THEN** token 依旧有效（无绝对过期），恢复窗口内 RESUME 成功

#### Scenario: 终态语义

- **WHEN** 请求被显式取消 / 对端进程重启（journal 丢失）/ journal 淘汰
- **THEN** 分别以 CANCELLED / REQUEST_STATE_LOST / JOURNAL_EVICTED 确定终态
  回报；SSE 以网络错误关闭（非 200 截断），WS 发 CLOSE(1012)

#### Scenario: 双端并发 INIT 确定性收敛

- **WHEN** 双端同时发起 SESSION_INIT（各生成 sessionId）
- **THEN** 以 (endpointId, sessionId) 全序较小者为 winner；败方撤回并收敛到
  胜方会话，双端独立可计算、无仲裁往返

#### Scenario: 恢复窗口内的单流静默终态

- **WHEN** recovering 期间某流 ACK 静默超过 15s（普通流 / SSE / WS 三种形态）
- **THEN** 该流以 RESET(STREAM_STALLED) 终结并停止重放，本地 SSE 关网络错误、
  WS 发 CLOSE(1012)；session 继续恢复至 90s 窗口，其它流不受影响

#### Scenario: token tombstone

- **WHEN** session 已 dead / journal 被淘汰 / 显式 close 后以旧 token RESUME
- **THEN** 以 TOKEN_REVOKED 拒绝；恢复窗口耗尽以 RECOVERY_WINDOW_EXPIRED 拒绝
