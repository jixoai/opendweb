# Phase 0 iroh 1.1.0 probe 查证存档（tasks 1.2–1.6）

- 时间：2026-09-16（UTC+8）
- 环境：本机 darwin arm64，loopback 直连（Minimal preset + RelayMode::Disabled + 注入 127.0.0.1），同进程双端
- 代码：`crates/spike-iroh/src/probes.rs`（子命令 probe-exporter / probe-datagram / probe-timeouts / probe-close / probe-flow）
- iroh 源码基线：iroh 1.1.0 / noq 1.2.0（cargo registry 本地源码核对）

## 1.2 exporter 连接绑定性（probe-exporter）

| 实验 | 结果 |
|---|---|
| 同连接不同 context（ctx-A vs ctx-B） | 派生不同（context 参与派生） |
| 不同连接同 label/context（conn1 vs conn2） | **派生不同（单连接 TLS secret 绑定）** |

**对协议草案的影响**：坐实 design §2.3.0 的结论——`export_keying_material`
只能证明「当前物理连接已认证」，**不能作跨连接长期 resume token**；session
token 用自生成 128bit 随机值 + 每代轮换的设计维持不变。exporter 可选用于
「当前连接」的附加认证因子（非必需）。

## 1.3 datagram 支持面（probe-datagram）

| 实验 | 结果 |
|---|---|
| `max_datagram_size()` | `Some(1288)`（loopback 直连路径） |
| 64B round-trip | OK，331µs |
| 超限（m+1=1289） | `TooLarge`（可区分拒绝） |
| close 后 send | `ConnectionLost(LocallyClosed)`（可区分错误） |

**对协议草案的影响**：datagram 可用且错误可区分；`sendDatagram` 的
at-most-once 契约可承载。**保留事项**：本 probe 仅 loopback 直连，relay 路径
的 datagram 行为（是否经 relay 转发、MTU 变化）未测——替换 envelope 实现前
补 relay 实测（已列入 Phase 4 故障矩阵）。

## 1.4 空闲连接时间线（probe-timeouts，25s 观察）

源码默认核对：`HEARTBEAT_INTERVAL = 5s`、`PATH_MAX_IDLE_TIMEOUT = 15s`
（iroh socket.rs:109/117，经 quic.rs 默认 transport 配置应用）。

| 观察点 | 结果 |
|---|---|
| 25s 无业务数据 | `close_reason = None`，`paths_alive = 1` 全程 |
| PathEvent::Closed | 未触发（仅初始 Opened/Selected） |

**对协议草案的影响**：默认心跳维持空闲连接存活；「无业务数据」不是断连
信号。会话层死亡判据维持「客观事件驱动」（重连退避超限/窗口耗尽/显式
close），不引入纯空闲判死。恢复窗口 90s 候选值与心跳/path 节奏兼容。

## 1.4b close reason 映射（probe-close）

| 用例 | 对端 `closed()` 结果 |
|---|---|
| A 应用关闭（code=7, reason） | `ApplicationClosed(ApplicationClose { error_code: 7, reason })` —— 全保真映射 |
| B 进程内静默丢弃（drop conn+endpoint） | `ApplicationClosed(ApplicationClose { error_code: 0, reason: "" })`，**~1.5µs 即决** |
| C close_reason() 时机 | close 前 `None`；对端 close 后 `Some(ApplicationClosed{..})` |

**对协议草案的影响**：
- 应用关闭的错误码/reason 可原样映射到 continuity 的终态原因表。
- **注意 B 的局限**：loopback 同进程场景下丢弃仍快速产生干净 ApplicationClosed
  （code=0 空 reason）——与「真实网络分区」不同（分区期间什么都收不到，只能
  靠超时）。code=0+空 reason 与「正常应用关闭」不可区分，会话层不应依赖
  reason 内容区分死因；真实分区行为由 Phase 2/4 的 relay-down/断网注入覆盖。
- `connectionEpoch` 由 opendweb 自生成（不依赖 iroh 内部 connection id）——维持设计。

## 1.5 并发流与流控隔离（probe-flow，128 流 × 64KiB + 慢读）

| 观察点 | 结果 |
|---|---|
| 控制流冷 RTT | 572µs |
| 拥塞期控制流 RTT（128 流在途 + 服务端慢读） | 37.7ms（未被阻塞，延迟上升 ~66× 但亚 100ms） |
| open+write 128 条 | 128/128 完成；100ms 内完成 99 条（与 ~100 并发上限一致，完成后释放额度） |
| 总耗时 | 171ms |

**对协议草案的影响**：QUIC 流级流控对控制流隔离良好（独立 control stream
方案可行）；128 并发逻辑流的 Phase 2 验收规模可用。若未来需要 >100 真并发
QUIC 流，需显式调 `max_concurrent_bidi_streams`（continuity 多路复用单流
设计下预计不需要）。

## 综合结论

五项查证全部支持现行设计，无一项推翻协议草案假设。两个保留事项进入后续
阶段：(1) relay 路径 datagram 实测（Phase 4 矩阵）；(2) 真实网络分区的
close 行为（Phase 2/4 故障注入）。超时候选值（90s/15s/退避 1..30s）与
iroh 默认节奏兼容，维持「Phase 2/4 实测后冻结」流程。
