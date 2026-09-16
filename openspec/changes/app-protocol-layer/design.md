# opendweb 应用协议层提案（Round 2 + Owner 裁决合并稿）

日期：2026-09-16

状态：设计提案，尚未冻结 wire compatibility；本文中的默认值是实现起点，不替代 Owner 决策。
**Owner 2026-09-16 裁决已合并**：HTTP/WS 下沉 Rust 实现；包形态为
`@jixo/opendweb-client-sdk` subpath exports（`.`,`/net[/internals]`,
`/http[/internals]`）；Q1–Q5/Q7/Q8 采纳 §5 推荐默认值；Q6 按 §5 裁决版执行。
journal「90s 未确认年龄」语义修正为**仅计恢复窗口内**（无活跃连接期间），
健康连接下的慢读只触发反压、不计时（编排者评审修正）。

## 0. 目标与非目标

### 目标

在 iroh QUIC 连接短暂死亡并由内核建立新 connection epoch 时，保持一个逻辑应用会话，使正在进行的 HTTP/SSE/WS 流可以在有界窗口内继续，而不重新执行已经开始的 AI 请求。

### 非目标

- 不重造 QUIC 的可靠有序流、拥塞控制、RTT 估计或路径迁移。
- 不把 direct/relay path change 当作逻辑会话死亡。
- 不把旧 invite/PoP 入网凭据直接当作 resume token。
- 不让通用 fabric 内核解析 HTTP、provider 目录、API key 或上游业务语义。
- 不承诺跨进程重启的恢复，除非后续启用持久化 journal。

## 1. 分层总览

```text
┌──────────────────────────────────────────────────────────────────┐
│ TS bindings：@jixo/opendweb-client-sdk/http（+ /http/internals） │
│ serveHttp / fetchHttp / WS upgrade 的类型面与 Node 适配           │
│ 只消费 SessionHandle；不消费 PeerDisconnected；不实现重连竞速      │
│ （Owner 2026-09-16：HTTP/WS 引擎本体在 Rust；TS 可经 internals    │
│   自建投影作为逃生舱）                                            │
└──────────────────────────────┬───────────────────────────────────┘
                               │ logical streams + commit/abort
┌──────────────────────────────▼───────────────────────────────────┐
│ HTTP/WS 模拟层（Rust，Owner 2026-09-16 裁决）                     │
│ serveHttp / fetchHttp 引擎 / SSE 投影 / WS upgrade 隧道           │
└──────────────────────────────┬───────────────────────────────────┘
                               │ logical streams + commit/abort
┌──────────────────────────────▼───────────────────────────────────┐
│ Session Continuity（Rust）                                        │
│ sessionId / epoch resume / stream offset / ACK / replay / dedupe │
│ request side-effect state / bounded journal / logical death      │
└──────────────────────────────┬───────────────────────────────────┘
                               │ typed connection facts + raw session frames
┌──────────────────────────────▼───────────────────────────────────┐
│ Rust connection layer                                             │
│ iroh Endpoint / QUIC / relay / direct path / auto reconnect       │
│ connection epoch / path status / connection state snapshot        │
│ raw PeerDisconnected 只作为层内事实，不直接交给业务应用           │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                         iroh 1.1 QUIC

Legacy / simulated UDP side path（R3 统一：session-bound 入口）:
SessionHandle.sendDatagram(data)
  -> one envelope, at-most-once across connection death, application retries
  -> 不进入 Session Continuity journal
Fabric.send(peer, data) 保留为 legacy 兼容面（无 session 语义）
```

### 1.1 Rust 连接层职责收敛

Rust 连接层负责：

1. EndpointId、名册成员资格、ALPN 门控和 QUIC connection 建立。
2. direct/relay path migration、relay failover 和底层自动重连。
3. 为每条物理连接分配单调 `connectionEpoch`。
4. 提供可靠的连接状态快照和代次流给 session 层。
5. 提供一个不携带 HTTP 语义的 raw session transport。

Rust 连接层不负责：

- 判断一个 HTTP 请求是否可以重发；
- 保存 SSE 响应历史；
- 解析 `REQ/RESP_CHUNK` 等 ai-fly 业务帧；
- 向 TS 应用广播原始 `PeerDisconnected`。

建议保留现有 legacy envelope，但把新连续性面物理隔离为新 ALPN：

```text
/dweb/fabric/1             legacy envelope / simulated UDP
/dweb/fabric-redeem/1      invite redemption
/dweb/fabric-continuity/1  session continuity
```

这样旧消费者不会因为新协议上线而意外获得重放语义；新协议版本升级也可以替换独立 ALPN。

### 1.2 Session Continuity 层

每个成员对维护一个逻辑 `Session`。一个 Session 可以经历多个物理 connection epoch，但同一时间只有一个 active epoch 可以发送业务数据。

该层负责：

- resume 握手和新旧 epoch 竞争；
- 每个逻辑流的 offset、ACK、replay 和接收去重；
- 请求副作用状态机；
- journal 的内存上限、年龄上限和淘汰语义；
- 业务层可见的 `recovering`、`active`、`dead` 状态。

### 1.3 模拟 UDP

模拟 UDP 是现有 envelope 的显式契约：单个消息不加入 Session journal，不跨 epoch 重放；连接存活时 QUIC 本身仍提供连接内可靠有序传输，连接死亡后消息可能丢失。

建议：

- 保留现有 `send` 作为兼容别名；
- 新增命名更明确的 `sendDatagram`；
- 文档将其定义为 `best-effort / at-most-once across epochs`；
- 不把 `send` 自动升级为 continuity 语义。

如果未来采用真正 QUIC DATAGRAM，必须先完成 iroh API、relay、MTU、丢包和资源上限查证，不能仅改方法名。

### 1.4 包边界与 subpath exports（Owner 2026-09-16 裁决）

不新增独立包；`@jixo/opendweb-client-sdk` 以 `exports` map 暴露子路径
（消除多包版本偏差这一整类 bug）：

```text
@jixo/opendweb-client-sdk            root：现有 Fabric API（identity/成员/
                                     状态快照）
@jixo/opendweb-client-sdk/net        TCP/UDP 模拟原语：SessionHandle /
                                     openStream / sendDatagram
@jixo/opendweb-client-sdk/net/internals   内部面（帧/journal 观测等），semver 宽松
@jixo/opendweb-client-sdk/http       HTTP/WS 绑定：serveHttp / fetchHttp /
                                     WS upgrade / SSE
@jixo/opendweb-client-sdk/http/internals  内部面，semver 宽松
```

- HTTP/WS **引擎本体在 Rust**（性能/内存；`/http` 子路径为类型面与 Node 适配）。
- 极端定制者可基于 `/net`、`/net/internals`、`/http/internals` 在 TS 自建
  投影——默认快路径与逃生舱并存，互不冲突（Owner 2026-09-16）。
- `/internals` 不承诺跨版本兼容；文档须显式标注。
- ai-fly 的 AUTH / catalog / provider policy / gateway 仍在应用层，消费
  Session 状态而非原始 `FabricEvent`；业务 request-id 必须绑定到 continuity
  的 logical stream 与幂等键。

## 2. 协议规格草案

### 2.1 版本与 ALPN

- ALPN：`/dweb/fabric-continuity/1`
- wire version：`1`
- 最大单帧：`1 MiB`，建议业务 payload 不超过 `960 KiB`
- **门控（单一 wire 规则，R3 修正）**：连接建立后、SESSION_INIT/RESUME
  握手完成前，只允许握手帧（SESSION_INIT/RESUME 族）、PING/PONG 与 REJECT；
  一切业务帧（OPEN/DATA/ACK/FIN/RESET）在握手完成前禁止发送，违者终结连接

### 2.2 公共帧头

所有 continuity 帧使用固定 48 字节大端头：

```text
offset  size  field
0       4     magic = ASCII "DWS1"
4       1     wire_version = 1
5       1     frame_type
6       2     flags (bit mask)
8       16    session_id (随机 128 bit)
24      8     stream_id (u64)
32      1     direction: 0 = client->provider, 1 = provider->client
33      1     reserved (必须为 0)
34      2     header_len (当前固定为 48)
36      8     byte_offset
44      4     payload_len
48      n     payload
```

公共校验：

- `header_len != 48`、magic/version 错误、reserved 非零直接拒绝当前 frame；
- `payload_len` 超过单帧上限直接终结当前 connection；
- `stream_id=0` 只允许 control frame；
- stream ID 由发起方奇偶分配，client 使用奇数，provider 使用偶数；
- `byte_offset` 是该方向 payload 的起始字节偏移，不是 frame 序号。

建议 flags：

```text
0x0001 START       逻辑流第一帧
0x0002 END         逻辑流正常结束，本帧 payload 后为 final offset
0x0004 RESET       逻辑流异常终结
0x0008 ACK_REQUEST 请求对端尽快回 ACK
0x0010 REPLAY      本帧来自 journal 重放
0x0020 FIN         stream half-close
0x0040 HAS_SACK    ACK payload 携带选择性确认区间
```

### 2.3 Resume 握手帧

帧类型：

```text
0x00 SESSION_INIT       首次建会话（R3 补：会话建立协议）
0x0A SESSION_INIT_OK
0x0B SESSION_INIT_REJECT
0x01 RESUME_INIT
0x02 RESUME_OK
0x03 RESUME_REJECT
0x04 PING
0x05 PONG
0x06 SESSION_FIN
0x07 SESSION_RESET
0x10 OPEN
0x11 OPEN_OK
0x12 OPEN_REJECT
0x20 DATA
0x21 ACK
0x22 FIN
0x23 RESET
```

### 2.3.0 首次建会话（SESSION_INIT，R3 补）

**发起**：`Fabric.openSession(peer)`（TS 入口；幂等——已有 active session 直接
返回既有 SessionHandle）。首个 continuity 连接上，发起方生成
`sessionId`（128bit 随机）与 `resume_token`（128bit 随机），发送：

```text
SESSION_INIT payload:
  protocol_version u8 = 1
  session_id       16B
  resume_token     16B   —— 经 iroh 已认证连接内分发，初始机密性由传输层保证
  local_epoch      u64 = 1
```

**响应载荷（R4 补，wire 闭合）**：

```text
SESSION_INIT_OK payload:
  accepted_session_id 16B   —— 回显（= 公共头 session_id）
  accepted_epoch      u64 = 1
  generation          u64 = 1

SESSION_INIT_REJECT payload:
  reason               u8    —— 0x01 ALREADY_ACTIVE / 0x02 MALFORMED / 0x03 POLICY_DENIED
  canonical_session_id 16B  —— 既有会话的权威 id（ALREADY_ACTIVE 时收敛用）
  canonical_epoch      u64
  generation           u64
```

**header 关联（R5 补）**：INIT_REJECT 的公共头 `session_id` = **被拒绝的**
（发起方自己的）id；canonical 三元组只在 payload——header 用于发起方关联在途
请求，payload 用于收敛。**token 获取路径**：会话是成对实体，两端在
SESSION_INIT 时均已持有 token（发起方生成、接收方从 INIT payload 登记；此后
每次 RESUME_OK 轮换双端同步）。并发双 INIT 的败方从**胜方 INIT 帧 payload**
直接登记胜方 session 与 token（该帧本来就会到达），无需额外传递。

**header/payload 校验**：SESSION_INIT 的公共头 `session_id` 必须等于 payload
`session_id` 且非零；INIT_OK/INIT_REJECT 回显同一 id。零 sessionId/空 token
非法，直接终结连接。

**幂等与并发收敛**：接收方无该 peer 会话 → 登记并回 OK；已有（含并发刚建立）
→ `SESSION_INIT_REJECT(ALREADY_ACTIVE)` + canonical 三元组，发起方收敛到既有
会话。**双端同时 INIT 的 deterministic winner**：以 `(endpointId, sessionId)`
全序取较小者为 winner；败方撤回自己的 INIT、按胜方 canonical 收敛——双端可
独立计算，无需仲裁往返。`Fabric.openSession(peer)`（唯一创建入口，见 §3.3）
幂等：active/recovering 返回既有 SessionHandle；dead/closed 后新建会话。

**Token 生命周期（R3 修正）**：token **无绝对过期**——90s 时效是「恢复窗口」
属性而非 token 属性：进入 recovering 后，resume 尝试须在窗口内完成，token
在窗口内始终有效；**长寿命健康会话断线时 token 依旧有效**。每次成功 RESUME
后 token 轮换（新 token 经 RESUME_OK 载荷分发，绑定新 epoch 与单调 generation；
旧 token 按**两代滑窗**处理——previous 代在新代首次成功 RESUME 或恢复窗口
结束前仍可恢复，之后拒绝 TOKEN_INVALID，见「轮换状态机」）。

`RESUME_INIT` payload：

```text
offset  size  field
0       1     protocol_version = 1
1       1     resume_flags
2       2     stream_summary_count
4       8     local_connection_epoch
12      8     last_seen_remote_epoch
20      16    resume_nonce
36      2     token_len
38      n     resume_token
38+n    ...   stream summaries
```

每个 stream summary：

```text
stream_id u64
direction u8
flags     u8
reserved  u16
recv_ack_offset u64   本端已连续提交的下一个 offset
send_ack_offset u64   本端已确认对端发送的下一个 offset
final_offset     u64  未结束时为 UINT64_MAX
```

`RESUME_OK` payload：

```text
accepted_session_id 16
accepted_epoch       u64
peer_epoch           u64
new_generation       u64      —— token 轮换（R4 补）
new_resume_token     16B      —— 轮换后的新 token，经已认证新连接分发
replay_stream_count  u16
status_flags         u16
per-stream replay summaries...
```

**轮换状态机（R5 定稿：两代滑窗）**：每端保留 `current` 与 `previous` 两代
(generation, token)。RESUME 校验按 (generation, token) 精确匹配 current 或
previous 二者之一。previous 的清除条件（先到者）：新代 token 完成首次成功
RESUME，或恢复窗口结束。发送方于发出 RESUME_OK 时切换 current（旧代降为
previous）；接收方于收到 OK 时切换。效果：OK 丢失（紧接再断线）→ 旧代仍在
previous 窗口内，可恢复并再次轮换；generation 前移且新代完成首次 RESUME 后，
旧 token 拒绝——轮换防未来重放，不作立即吊销。

`RESUME_REJECT` 使用固定 reason：

```text
0x01 UNKNOWN_SESSION          —— 仅持久化模式预留；Phase 1 内存模式下不使用
0x02 TOKEN_INVALID
0x03 RECOVERY_WINDOW_EXPIRED   —— R4 改名：恢复窗口耗尽（原 TOKEN_EXPIRED 语义歧义）
0x04 STALE_EPOCH
0x05 JOURNAL_EVICTED
0x06 POLICY_DENIED
0x07 VERSION_UNSUPPORTED
0x08 REQUEST_STATE_LOST
0x09 TOKEN_REVOKED             —— session tombstone（dead/journal evicted/显式 close 后 token 撤销）
```

握手规则：

1. 新 connection 先完成 transport 身份和成员资格认证。
2. 发起方发送 `RESUME_INIT`，带上旧 sessionId、旧 epoch、最新水位和 token。
3. 接收方使用 generation CAS 选择唯一 active epoch；旧 epoch 的数据帧全部拒绝。
4. `RESUME_OK` 后，双方先交换 ACK/重放计划，再开放新的 OPEN/DATA。
5. 同一个 logical stream 不能因为 resume 重新分配 streamId。

### 2.4 业务流帧

`OPEN` payload 只承载协议元数据，不承载大请求体：

```json
{
  "requestId": "z32-128-bit",
  "idempotencyKey": "base64url-128-bit",
  "method": "POST",
  "path": "/v1/chat/completions",
  "sideEffectPolicy": "at-most-once",
  "bodyLength": 1234,
  "contentType": "application/json"
}
```

实际请求和响应正文都使用 `DATA` 帧：

- `stream_id` 标识一个 logical request；
- `direction` 区分请求和响应；
- `byte_offset` 必须从 0 开始单调推进；
- payload 可跨帧切分，不能依赖固定 chunk 大小；
- `END` 携带 final offset，`RESET` 携带固定 reset reason；
- ACK 可以独立发送，也可以用 `HAS_SACK` 相关控制帧携带。

### 2.5 累计 ACK

ACK 使用公共头：

- `stream_id` = 被确认的流；
- `direction` = 被确认的数据方向；
- `byte_offset` = **最高连续已提交字节的 exclusive offset**；
- `payload_len=0` 表示纯累计 ACK；
- `HAS_SACK` 时 payload 为：

```text
ack_delay_us u32
sack_count   u16
reserved     u16
repeat sack_count times:
  range_start u64
  range_end   u64   exclusive
```

接收端只有在本地 commit point 完成后才推进累计 ACK。HTTP/SSE 默认 commit point 是数据进入有界的本地输出队列并获得写入确认；如果本地消费者停止读取，ACK 停止，发送端必须反压而不是无限缓存。

### 2.6 Replay journal

建议数据结构：

```text
SessionJournal {
  session_id: 16 bytes
  active_generation: u64
  streams: Map<(stream_id, direction), StreamJournal>
}

StreamJournal {
  next_send_offset: u64
  acked_offset: u64
  final_offset: Option<u64>
  terminal: Option<TerminalReason>
  segments: Deque<JournalSegment>
}

JournalSegment {
  offset: u64
  payload: Bytes
  flags: u16
  created_at: monotonic timestamp
}
```

第一阶段默认上限：

| 维度 | session 总量 | 单 stream | 触发行为 |
|---|---:|---:|---|
| payload bytes | 8 MiB | 2 MiB | 先反压；仍超限则 RESET(REPLAY_LIMIT) |
| segment 条数 | 4096 | 512 | 合并相邻 segment 后再判断 |
| 未确认年龄（仅恢复窗口内计） | 90 s | 90 s | 过期后拒绝继续恢复该 stream |
| 活跃 stream 数 | 128 | 不适用 | 超限拒绝 OPEN |

**年龄语义（编排者评审修正）**：90s 未确认年龄只累计「无活跃连接的恢复窗口内」；
连接健康时本地消费者读得慢 → ACK 停 → 发送端反压，**不计时、不判死**。字节/条数
上限在任何时刻生效。

只允许删除 `acked_offset` 之前的 segment。未确认数据不能静默淘汰；journal 满时优先暂停上游，超过恢复 deadline 才显式终结。

第一阶段 journal 只存在进程内存。进程重启后旧 session 返回 `REQUEST_STATE_LOST`，不得假装可以继续。

### 2.7 接收端去重规则

1. `offset == expected_offset`：校验、交付、推进 expected offset。
2. `offset < expected_offset`：视为重放；必须逐字节验证重叠范围。完全相同则丢弃重复 payload，不重复交付；内容不一致则 RESET(PROTOCOL_ERROR)。
3. `offset > expected_offset`：允许进入有界 gap buffer；回 ACK + SACK；超过 gap window 则 RESET(OFFSET_GAP)。
4. 收到已经 terminal 的 stream：相同 terminal frame 幂等丢弃；不同 terminal reason 视为协议错误。
5. 旧 epoch 的 frame 不进入 offset 处理，直接丢弃并记录 stale frame 计数。

### 2.8 请求副作用状态机

```text
NEW
 │ OPEN + idempotencyKey
 ▼
ACCEPTED  -- 尚未向上游执行，可等待 resume
 │ upstream admitted
 ▼
STARTED   -- 已可能产生外部副作用，禁止自动重新执行
 ├──────── response journal + ACK ───────► COMPLETED
 ├──────── explicit abort/cancel ─────────► CANCELLED
 └──────── journal/deadline 丢失 ─────────► STATE_LOST
```

语义：

- `idempotencyKey` 是 128 bit 随机值，在同一个用户请求的所有 connection epoch 中不变；客户端重试同一操作必须复用该键。
- provider 保存 `idempotencyKey -> requestId/state`，重复 OPEN 返回既有状态，不重新执行已进入 `STARTED` 的上游调用。
- `ACCEPTED` 可以恢复请求正文；`STARTED` 只能恢复响应、查询上游状态或显式报告 `RETRY_UNSAFE`。
- `COMPLETED` 保留 terminal metadata 和 response journal，直到 ACK 完成或 journal age 到期。
- 对不支持幂等查询的上游，默认 `at-most-once`，不能把 transport retry 冒充业务 retry。

## 3. 状态机与事件面

### 3.1 Rust 连接状态

每个 peer 维护一份最新快照：

```ts
type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "handshaking"
  | "ready"
  | "closing";

interface ConnectionStateSnapshot {
  peerId: string;
  phase: ConnectionPhase;
  epoch: bigint;
  stateSeq: bigint;
  path: "direct" | "relay" | "unknown";
  changedAtMs: number;
  reason?: string;
}
```

Rust 内部 API 建议：

- `connection_status(peer_id) -> ConnectionStateSnapshot`
- `watch_connection(peer_id, after_state_seq) -> StateChangeStream`
- `open_continuity_transport(peer_id) -> RawSessionTransport`

`watch_connection` 使用单调 `stateSeq`。订阅前必须先取 snapshot；发现 sequence gap 时，调用方重新拉取 snapshot，而不是猜测中间事件。

`PeerDisconnected`、旧 epoch watcher、relay path selected 等保留为 Rust 内部事实。通用 `FabricEvent` 不再作为 continuity 的唯一状态源。

### 3.2 Rust Session 状态

```ts
type SessionPhase =
  | "absent"
  | "negotiating"
  | "active"
  | "recovering"
  | "dead"
  | "closed";

interface SessionStateSnapshot {
  peerId: string;
  sessionId: string;
  phase: SessionPhase;
  activeEpoch: bigint | null;
  streamCount: number;
  journalBytes: number;
  lastAckAtMs: number | null;
  deadlineAtMs: number | null;
}
```

Session 层提供 `watchSession()`，状态变化包括：`resume-started`、`resume-accepted`、`resume-rejected`、`journal-limited`、`logical-dead`。这些事件面向 TS session adapter，不直接面向业务 UI。

### 3.3 TS 层消费面

```ts
interface SessionHandle {
  readonly peerId: string;
  readonly sessionId: string;
  state(): SessionStateSnapshot;
  onState(cb: (state: SessionStateSnapshot) => void): () => void;
  openStream(meta: OpenStreamMeta): Promise<LogicalStream>;
  sendDatagram(data: Uint8Array): Promise<void>;
  close(reason?: string): Promise<void>;
}
```

TS HTTP/WS 层的行为：

- `active`：正常转发；
- `recovering`：保持本地 SSE/WS 连接，停止向用户返回新的 503；继续等待有界 deadline；
- `dead`：SSE 关闭响应流并报告网络错误/504，WS 发 CLOSE/1012 后关闭；新请求才映射为 `provider_offline`；
- 不自行调用 `Fabric.connect()`、`Fabric.disconnect()` 或另起退避循环。

ai-fly 的 AUTH、目录刷新和 provider policy 仍在 `ProviderConnection`/`ProviderEngine`，但它们消费的是 Session 状态，不再直接消费 `peer-disconnected`。

**会话创建唯一入口（R4 统一）**：`Fabric.openSession(peerId): Promise<SessionHandle>`
（Fabric 工厂级方法）；`SessionHandle` 自身**不含** openSession。幂等语义：
active/recovering → 返回既有句柄；dead/closed → 新建会话（新 sessionId/token）。

### 3.4 Rust↔N-API HTTP/WS handler ABI（Codex 1.8 评审重写版——pull-first）

**执行位置**：HTTP 解析/分帧/SSE 投影/WS 重组在 Rust 引擎；`serveHttp(handler)`
的 handler 在 TS 执行。**桥接总原则（评审结论）**：TSFN 只做「信号」不做
「数据队列」；body 一律 pull-first；禁止 `ThreadsafeFunctionCallMode::Blocking`。

**body 双向桥（pull-first）**：
- Rust 侧每请求体/响应体一条**有界 `tokio::mpsc`**（容量 = 水位，与
  continuity journal 上限同源标定）；JS `AsyncIterator.next()` 触发一次 pull
  （经 TSFN NonBlocking 信号，返回状态必须检查），Rust 只有拿到 mpsc permit
  才发送下一块——**JS 消费速度 = ACK commit point** 由 permit 机制天然成立。
- 统一 `commit()` 点推进 ACK（数据进入 JS 有界输出队列并确认写入后）。
- body 迭代器 `return()`（提前终止）映射对端 FIN/本地取消；`throw()` 不由
  用户调用（协议错误经 reject 传播）。

**取消（AbortSignal 双向适配器）**：
- 不使用 napi 内部 AbortSignal（AsyncTask 专用、Rc 非跨线程）。每请求在 JS
  侧创建 `AbortController`，其 `signal` 交给 handler；controller 的 `abort()`
  注册进一个经 TSFN 可调用的 JS 端注册表——Rust 侧 RESET/连接死亡/对端取消
  时触发。JS→Rust 取消经 native handle（`cancel()` 方法）。

**生命周期（shutdown 定序，评审冻结）**：
```text
closing = true → 拒新 stream/request → cancel 全部 CancellationToken →
close body mpsc（pending next 以 CANCELLED 结算）→ abort/release TSFN →
有界 native drain → shutdown complete
```
- 用户 handler Promise **不被无限等待**：取消后丢弃其结果，late completion
  仅日志、不得再触碰 native state（防幽灵回调——`pump.abort()` 不撤销已排队
  TSFN 调用，此既有事实不得外推为新 ABI 的保证）。

**WS 通道 ABI（整消息边界冻结）**：
```ts
export type WsMessage =
  | { kind: "text"; data: string }
  | { kind: "binary"; data: Uint8Array };
export interface WebSocketChannel {
  readonly messages: AsyncIterable<WsMessage>;
  send(message: WsMessage): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}
```
错误码冻结：`WS_MESSAGE_TOO_LARGE` / `WS_INVALID_UTF8` / `WS_CLOSED`；
最大消息尺寸候选 1 MiB（Phase 0 冻结数值）。分片重组全在 Rust。

**HTTP 类型面（headers 保重复项）**：
```ts
export interface Header { name: string; value: string }   // 数组形态，非 Record
export interface HttpRequest {
  method: string; path: string;
  headers: readonly Header[];
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}
export interface HttpResponse {
  status: number;              // 200–599
  headers: readonly Header[];
  body?: AsyncIterable<Uint8Array>;
}
export type HttpHandler = (request: HttpRequest) =>
  HttpResponse | PromiseLike<HttpResponse>;
export interface HttpServer { close(reason?: string): Promise<void> }
export function serveHttp(session: SessionHandle, handler: HttpHandler,
  options?: { signal?: AbortSignal }): HttpServer;
export function fetchHttp(session: SessionHandle, request: HttpRequestInit,
  options?: { signal?: AbortSignal }): Promise<HttpResponse>;
```
- header 限额（候选，Phase 0 冻结）：≤64 头 / 键 ≤1KiB / 值 ≤8KiB，超限 431。
- 已发头后 handler/body 失败 → 流以 RESET 终结（不静默截断为 200）；内部
  错误码 → JS Error/DOMException 的映射表在实现时冻结（语义：取消 →
  AbortError；对端终结/协议错 → TypeError 族；超时 → TimeoutError）。

**`/http` 稳定面** = 上述类型与 serveHttp/fetchHttp；`/http/internals` 暴露
native request id、puller、frame/offset 观测（semver 宽松）。

**实现缺口清单（评审列出，Phase 3 前置）**：typed handler dispatch、双向
body puller、有界 mpsc/credit/commit bridge、native stream handle 终态状态机、
AbortController adapter、handler task registry、WS message channel、
package.json exports map 与 d.ts（当前均不存在）。

**风险核对单（实现与评审逐项对照）**：JS 慢消费者队列无限增长 / Blocking
TSFN 卡死 / next() 并发破坏 offset 序 / 用户 Promise 永不 resolve 的 drain
泄漏 / AbortSignal listener 泄漏 / napi_closing / Buffer 跨异步边界生命期 /
handler throw 误判 fatal / WS 大消息内存峰值 / Rust 与 TS header 限额不一致 /
shutdown 后幽灵回调 / 错误消息泄露 peer/路径/上游信息。


## 4. iroh 1.1 特性查证清单

以下项目在协议冻结前必须用本地 lockfile 对应的 iroh 1.1.0 源码和可运行 probe 验证。

### 4.1 `export_keying_material` 是否可用于跨连接 resume

查证方法：

1. 阅读 `iroh::endpoint::Connection::export_keying_material` 的文档、实现和底层 `noq` 调用，确认 exporter 是否绑定单条 QUIC connection 的 TLS secret。
2. 写两端 probe：建立 connection A 和 B，使用同一 label/context 比较输出；预期 A 与 B 输出不同。
3. 在同一 connection 内触发 direct↔relay path migration，再比较 exporter；预期 path change 不改变 exporter。
4. 查证 `remote_id()` 与 exporter 是否都能在 N-API 的生命周期和线程模型中安全使用。

设计结论：即使 exporter 可用，也只能作为“当前物理连接已认证”的证明，不能单独作为跨 connection 的长期 resume token。

### 4.2 Datagram 支持

查证方法：

1. 检索 iroh 1.1 `Connection` 的 `send_datagram`、`read_datagram`、最大 datagram size 和错误类型。
2. 编写 direct、relay、direct↔relay migration 三组 probe，记录最大 payload、丢包、拥塞、连接关闭时的行为。
3. 在 relay 进程停止、网络丢包和高并发发送下验证是否阻塞、丢弃或返回可区分错误。
4. 将结果写入固定 fixture；在 API 未冻结前，模拟 UDP 继续使用 envelope best-effort，不依赖 datagram。

### 4.3 keepalive、path idle、connection idle 默认值

查证方法：

1. 读取 iroh 1.1 `QuicTransportConfigBuilder` 默认值和 `HEARTBEAT_INTERVAL`、`PATH_MAX_IDLE_TIMEOUT` 常量。
2. 使用无业务数据的连接 probe 记录 PING、`PathEvent::Selected/Closed` 和 `Connection::closed()` 的时间线。
3. 分别禁用网络、停止 relay、切换 direct/relay，确认 path abandonment 与整条 connection close 的边界。
4. 验证自定义 `keep_alive_interval` 和 `max_idle_timeout` 是否会影响 relay 路径、内存和电量成本。

### 4.4 connection close reason 与新 epoch识别

查证方法：

1. 检查 `Connection::closed()`、`close_reason()` 和 QUIC `ConnectionError` 的可用字段。
2. 注入本地 close、远端 application close、idle timeout、stateless reset、relay 中断，建立错误映射表。
3. 验证 iroh 是否允许通过 EndpointId 建立并发新连接，以及新旧 connection 的去重窗口。
4. 将 `connectionEpoch` 由 opendweb 自己生成，不依赖 iroh 内部 connection id 的稳定性。

### 4.5 流控与并发上限

查证方法：

1. 读取 `max_concurrent_bidi_streams`、`stream_receive_window`、`receive_window`、`send_window` 的默认值和内存含义。
2. 在单个 connection 上同时运行 128 个 logical stream，注入慢读和大 replay，观察 QUIC flow control 是否阻塞 control stream。
3. 验证独立 control stream、优先级和 `send_fairness` 是否符合 session scheduler 预期。

### 4.6 验收产物

每项查证必须留下：源码路径和版本、probe 命令、原始输出、通过/不通过判定、对协议草案的影响。未经这些产物，不冻结 timeout、datagram 或 token 派生方案。

## 5. 八个开放问题及推荐默认值

### Q1：是否跨进程重启恢复？

推荐默认：**第一阶段只保证双方进程存活期间的跨 connection epoch 恢复**；进程重启返回 `REQUEST_STATE_LOST`。

理由：内存 journal 可以先闭合协议和故障语义；跨重启需要持久化正文、响应、权限撤销和崩溃一致性，不能隐含承诺。

### Q2：上游请求采用什么执行语义？

推荐默认：**at-most-once upstream execution + stable idempotency key**。

理由：AI 请求可能收费；`STARTED` 后禁止自动重新执行，只能恢复响应或明确报告 `RETRY_UNSAFE`。

### Q3：journal 放内存还是磁盘？

推荐默认：**Phase 1 内存，8 MiB/session、2 MiB/stream、4096 segments、未确认年龄 90s（仅恢复窗口内累计）**。

理由：先验证协议和 backpressure；上限可计算，且不会把连接层变成隐式数据库。

### Q4：逻辑恢复窗口多长？

推荐默认：**90 秒总窗口（recovering 起算），恢复窗口内 ACK 静默 15 秒判该流不可继续，退避 1/2/4/8/16/30 秒封顶**。

**ACK 静默适用域与终态（R3 闭合 / R4 终态化）**：15s 静默 watchdog 仅在
recovering（transport loss 已确认）期间生效；健康连接下的 ACK 静默只作探测
信号（触发 PING/状态上报），**不判死、不计时**。**15s 静默的终态是流级而非
会话级**：该 logical stream 以 `RESET(STREAM_STALLED)` 终结并停止重放，其本地
SSE 以网络错误关闭、WS 发 CLOSE(1012)；**session 继续恢复至 90s 窗口**，其它
流不受影响——与 Q7 的 90s 本地保持语义正交（90s 是会话恢复上限，15s 是单流
在恢复中的最长无进展等待）。

理由：覆盖一般 relay/网络切换，又不让用户请求无限挂起；必须用真实 relay 故障和 AI SLA 校准。

### Q5：resume token 如何生成和失效？

推荐默认：**SESSION_INIT 分发 128bit token（§2.3.0）：无绝对过期，90s 时效属恢复窗口；绑定双方 EndpointId、fabric、sessionId、epoch（每次成功 RESUME 轮换）、方向；当前连接认证后校验 MAC**。

理由：invite token 是入网凭据，不能复用；恢复窗口约束 + generation 单调 +
每次 RESUME 轮换限制抢跑与重放（token 本体无绝对过期；session tombstone 后
以 TOKEN_REVOKED 拒绝）。

### Q6：continuity 放 Rust 还是 TS？

**Owner 裁决（2026-09-16）**：continuity 与 HTTP/WS **均下沉 Rust**；
`@jixo/opendweb-client-sdk` 以 subpath（`/net`、`/http`、各自 `/internals`）
暴露类型面与 Node 适配；TS 逃生舱（基于 `/net`、internals 自建投影）保留给
极端定制场景。

理由（Owner）：HTTP/WS 很底层，Rust 实现性能更好、内存更省；高频变化的
产品策略（AUTH/catalog/上游策略）本就住在应用 TS 层、架在 `/http` 之上，
慢迭代环不构成瓶颈；默认快路径与定制逃生舱并存不冲突。编排者补充：全协议栈
单语言后，跨语言 wire fixture 从「必须」降级为「定制路径可选项」。

### Q7：SSE/WS 在恢复期间如何面对本地客户端？

推荐默认：**SSE/WS 在 recovering 窗口（≤90s）内保持本地连接；journal 不足或 session dead 后才关闭；新请求返回 503**。

理由：这是“透明续传”成立的必要条件；提前把 `PeerDisconnected` 转成 503 会重新引入当前痛点。

### Q8：UDP 兼容如何处理？

推荐默认：**保留 `send` 为 legacy best-effort 别名，新增 `sendDatagram`，两者均不进入 continuity journal**。

理由：避免现有 envelope 消费者获得隐式重放/顺序变化；真正 QUIC datagram 等 iroh 查证完成后再决定是否替换实现。

## 6. 分阶段任务切分与验收

### Phase 0：冻结术语、wire fixture 与 iroh probe

实现：

- 记录本提案中的术语、ALPN 和公共头；
- 建立二进制 fixture、malformed fixture、ACK/offset property tests；
- 完成 iroh 1.1 exporter、datagram、timeout、close reason、flow control 查证。

验收测试面：

- 所有合法帧 round-trip；长度、version、reserved、overflow、unknown reason 负例；
- offset duplicate/gap/SACK 的模型测试；
- **fixture 策略（R3 修正，对齐 Q6 裁决）**：主路径 = Rust fixture + N-API 黑盒测试；TS 解码器 fixture 仅作为逃生舱路径的可选项，不作主路径门禁。

真实故障注入：

- direct↔relay 切换期间连续发帧；
- relay 停止 10 秒后恢复；
- 丢包、重复包、延迟和乱序注入；
- 事件订阅者故意 lag，验证 snapshot resync。

### Phase 1：Rust 连接状态面和 raw continuity transport

实现：

- 新 ALPN `/dweb/fabric-continuity/1`；
- connection epoch、状态快照、`stateSeq`、watch stream；
- `open_continuity_transport()`；
- legacy envelope 与 continuity 物理隔离；
- N-API 暴露 typed snapshot/stream，不暴露内部 broadcast 细节。

验收测试面：

- member gate、ALPN gate、epoch 单调性、旧 watcher 不得删除新连接；
- concurrent connect/resume/shutdown 不产生 ghost session；
- snapshot-before-subscribe、sequence gap 后可恢复。

真实故障注入：

- 远端 application close、idle timeout、stateless reset；
- relay 进程停止并恢复；
- 两端同时重拨；
- shutdown 与 late connect/resume 竞速。

### Phase 2：Session Continuity 核心协议

实现：

- SESSION_INIT/OK/REJECT（首次建会话 + 幂等/并发收敛）；
- RESUME_INIT/OK/REJECT（含轮换载荷）；
- sessionId、epoch CAS、token、stream offset、ACK/SACK；
- per-stream journal、dedupe、replay scheduler；
- journal 三重上限、反压、logical death；
- OPEN/DATA/FIN/RESET 和请求副作用状态机。

验收测试面：

- 断在每个 frame byte offset 后恢复；
- duplicate exact frame 不重复交付；overlap mismatch 必须 reset；
- stale epoch frame 不得污染新 session；
- ACK 推进后 journal 释放；不 ACK 时内存不超过上限；
- 多 stream 恢复时 control/ACK 不被大流阻塞；
- started request 不被重复执行，completed response 可重放。

真实故障注入：

- `RESP_CHUNK` 发送后、ACK 前强制断连接；
- provider 已 STARTED 但 response 尚未返回时断连接；
- resume 期间启动第二个连接制造双主；
- journal 达到 bytes/count/age 上限；
- 一个慢 SSE 流与 127 个小控制流并发恢复。

### Phase 3：HTTP/WS Rust 引擎 + SDK subpath 与 ai-fly 接线

实现：

- HTTP/WS 引擎下沉 Rust：serveHttp/fetchHttp 引擎、SSE 投影、WS upgrade
  隧道（message/fragment boundary、DATA offset、close semantics 冻结）；
- `@jixo/opendweb-client-sdk` exports map：`.`、`/net`、`/net/internals`、
  `/http`、`/http/internals`（internals 标注 semver 宽松）；
- `SessionHandle` TS 类型面（`/net`）与 Node 适配；
- ai-fly ProviderConnection 删除第二套 fabric reconnect 竞速；
- SSE 本地连接在 `recovering` 期间保持；
- AUTH/catalog 保持 provider 业务层，不混入 continuity handshake；
- （可选，定制路径）TS 自建投影参考实现基于 `/net/internals`，作为逃生舱
  文档示例而非默认路径。

验收测试面：

- 60 秒 SSE 中途断线后按原顺序继续，不能重复 token；
- journal evicted/dead 时得到确定错误，不重新调用上游；
- pending/started/completed 三态重连；
- WS 握手中、单条大消息中、双向同时发送时均可恢复或明确关闭；
- 新请求在 dead 前不提前返回 503，dead 后快速失败。

真实故障注入：

- SSE 第 N 个 chunk 后 relay down 15 秒再恢复；
- 本地客户端慢读超过 4 MiB；
- provider 上游响应已经产生副作用后断线；
- WS message 在拆片中断线、握手中断、上游 close 与本地 close 同时发生；
- provider 进程重启，验证第一阶段按 `REQUEST_STATE_LOST` 失败而不是假续传。

### Phase 4：安全、容量和发布门

实现：

- token replay、stale epoch、跨 peer、跨 fabric、过期 token 防护；
- journal memory accounting、metrics、redaction、shutdown drain；
- Rust/TS compatibility fixture 和版本升级策略；
- 文档化 legacy `send` 与 continuity API 的差异。

验收测试面：

- 被盗 token、重复 resume、并发 resume、伪造 ACK、offset mismatch 全部拒绝；
- 8 MiB/2 MiB/4096/90s（恢复窗口）限额在压力下稳定，且健康慢读 >90s 不判死；
- 进程退出无残留 task、无未释放 journal；
- direct、relay、NAT、relay failover 矩阵重复通过；
- 真实 ai-fly SSE/WS 端到端测试与既有 legacy envelope 回归均通过。

真实故障注入：

- relay 长时间不可达、恢复后多次 path flip；
- 连接建立后立刻抢跑旧 epoch frame；
- ACK 被延迟、丢弃或篡改；
- 多 peer 同时恢复造成 session/journal 资源竞争；
- SDK 事件消费者停止读取后重新订阅并校验 snapshot 收敛。

## 7. 首轮实现停止条件

在以下条件满足前，不应声称“透明 SSE 续传”完成：

1. `REQ` 已 started 时不会被自动重复执行；
2. response replay 有明确 ACK、去重和 journal 上限；
3. old epoch 和 stale token 在 wire 层被拒绝；
4. direct/relay path change 不会误触发 logical death；
5. provider/consumer 双端均有真实断线故障注入，而不是只用可靠 loopback；
6. 进程重启边界明确为支持或不支持，并有对应测试断言。

