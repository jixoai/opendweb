# Proposal: app-protocol-layer

## Why

下游产品 ai-fly 的实测暴露了本仓库传输抽象的层级缺口（证据链完整）：

**应用会话被连接瞬断杀死。** 连接死亡时内核在同一临界区里做两件事：向上广播
`PeerDisconnected`（fabric.rs:2366-2368），同时向后台重连管理器请求自动重连
（fabric.rs:2375）。恢复能力存在于内核，但每一个瞬断——哪怕内核明知自己正在
恢复——都以「死亡通知」的形态直达 JS 应用。ai-fly 因此拆掉自己的 WireSession
并跑起第二套退避重连，两层重连赛跑，用户看到间歇性 `provider_offline` 503。

**应用层被迫自建整个「web 语义」。** JS 面只有信封消息（`send` = 每条消息
`open_bi` 开一条新 QUIC 双向流，fabric.rs:2058）；ai-fly 在其上手搓了完整的
frames 编解码 + 多路复用 + AUTH + 流式投影（src/wire/）。分钟级 AI SSE 响应
一旦中途断线，只能整体重试——已生成的 token 全部作废（真实计费浪费）。

**状态面不可靠。** SDK 事件不带 epoch，broadcast 通道丢弃 lagged 批次——
不能作为会话层的唯一状态源（packages/client-sdk/src/fabric.rs:642）。

### Owner 裁决链（2026-09-16）

1. **两层架构**：连接层只产客观事实（连接/断开带代次、路径翻转、重连进度）；
   新增应用协议层把客观事实翻译成协议语义。恢复策略禁止上提给应用。
2. **「模拟 TCP」正名为跨 QUIC connection epoch 的 session continuity**：
   不重造 TCP 的拥塞控制/乱序处理/连接内可靠传输（QUIC 已有）。path-changed
   是同连接内路径迁移，不触发会话恢复。
3. **HTTP/WS 下沉 Rust 实现**（性能/内存；产品策略留在应用 TS 层）。
   TS 侧经 subpath 暴露；极端定制者可基于 `PKG/net[/internals]`、
   `PKG/http[/internals]` 在 TS 自建投影——默认快路径与逃生舱不冲突。
4. **包形态**：不新增独立包，subpath exports 挂在
   `@jixo/opendweb-client-sdk` 下（`.`,`/net`,`/net/internals`,`/http`,
   `/http/internals`）。`/internals` 契约 semver 宽松。
5. **开放问题 Q1–Q8 采纳 Codex 推荐默认值**（design.md §5；数值均为候选值，
   Phase 0 probe 与 Phase 2/4 故障注入实测后冻结）：Phase 1 不跨进程重启；
   at-most-once 上游执行 + 幂等键；内存 journal（8MiB/2MiB/4096，未确认年龄
   90s 仅恢复窗口内累计）；恢复窗口 90s（recovering 起算）/恢复窗口内 ACK
   静默 15s/退避 1..30s；SESSION_INIT 分发 resume token（无绝对过期，每次
   RESUME 轮换，不复用 invite）；恢复期 SSE/WS 保持、dead 才 503；`send`
   保留为 best-effort 别名 + 新增 session-bound `sendDatagram`。
6. **首次建会话与跨界 ABI 成文**（R3 复核补）：SESSION_INIT/OK/REJECT 会话
   建立协议（design.md §2.3.0）；Rust↔N-API HTTP/WS handler ABI 草案
   （design.md §3.4，handler 在 TS 执行、背压与 ACK 同源、shutdown drain）。

## What Changes

1. **Rust 连接层收敛**：`connectionEpoch` 单调代次；`ConnectionStateSnapshot`
   + `stateSeq` 单调 watch 流（snapshot-before-subscribe，gap 重拉）；
   `PeerDisconnected` 降级为层内事实。新 ALPN `/dweb/fabric-continuity/1`
   与 legacy envelope 物理隔离。
2. **Session Continuity（Rust）**：sessionId/epoch CAS resume 握手；每流
   byte_offset + 累计 ACK（可选 SACK）；有界 replay journal（三重上限 +
   反压）；接收端去重；请求副作用状态机（NEW→ACCEPTED→STARTED→COMPLETED，
   STARTED 后禁止自动重执行）；逻辑死亡判据（恢复窗口/ACK 静默/显式终结）。
3. **HTTP/WS 模拟层（Rust）**：`serveHttp`/`fetchHttp` 虚拟服务端/客户端、
   SSE 流式投影、WS upgrade 隧道（消息边界/分片/重复投递规则冻结）。
4. **SDK subpath 面**：`@jixo/opendweb-client-sdk` root（现有 Fabric API）、
   `/net`（SessionHandle/openStream/sendDatagram）、`/http`（HTTP/WS 绑定）、
   `/net/internals`、`/http/internals`（内部面，semver 宽松）。
5. **模拟 UDP 契约化**：`send` = legacy best-effort 别名；新增 `sendDatagram`
   （at-most-once across epochs，不进 journal）。

## Impact

- **包**：`@jixo/opendweb-client-sdk`（exports map + 新绑定）；legacy `send`
  行为不变。
- **规格**：fabric/continuity（状态面/协议/HTTP-WS）、sdk/node（subpath
  契约与类型面）。
- **下游**：ai-fly 后续 change 迁移到 `/http`（自研 frames/mux 与双层重连
  退役）；其 16 项集成用例为迁移验收网。
- **iroh 查证前置**：exporter 跨连接适用性、datagram、keepalive/idle 默认、
  close reason、流控并发——五项 probe 未过不冻结超时与 token 派生方案
  （design.md §4）。

## Non-goals

- 不做跨进程重启恢复（Phase 1；进程重启如实返回 `REQUEST_STATE_LOST`）。
- 不重造 QUIC 连接内可靠性/拥塞控制/RTT/路径迁移。
- 不在内核解析 provider 目录、API key、上游业务语义（ai-fly 的
  AUTH/catalog/policy 仍在应用层，消费 Session 状态而非原始事件）。
- 真正 QUIC DATAGRAM 替换 envelope 实现需 probe 查证后另行裁决。
