# Proposal: relay-failover-hardening

## Why

下游产品 ai-fly 三机实测暴露 dweb-fabric 层两个 relay failover 缺陷（证据链完整，
非下游用法问题）：

**c1（死 relay 条目阻断新会话建立）**——`relay = { mode: "custom",
urls: [dead, alive] }`（死条目在首位）时，全新 fabric 会话建立（join/invite
兑换）被阻断：下游报 `[dial-timeout]`（或探针成功时附注 "relay online:
issuer likely offline"），>2 分钟不 failover 到第二个活条目；同环境
`urls: [alive]` 单条目立即成功，两端 relay status 均显示 online。死条目为
docker stop 的自托管 relay（TCP RST）。

**c2（relay 恢复后运行中的会话不重连）**——会话建立后 relay 宕机几分钟再恢复：
在途流量不受影响（p2p 打洞直连会话正常），但 relay-only 会话中断的 consumer
网关进程在 relay 恢复后永远不重新建立会话（下游持续报 provider_offline 503），
必须重启进程。

### 根因（file:line 证据）

**c1 是双因叠加，均在本仓库：**

1. `crates/dweb-fabric/src/fabric.rs` `invite_with()`（原 1584-1589 行）把
   **配置序首条** relay URL（`urls.first()`）写入邀请令牌——死条目在首位时
   令牌钉死在死 relay 上。
2. `crates/dweb-fabric/src/session.rs:702` `endpoint_addr_from_invite()` 把令牌
   字段**原样**转成拨号地址，`join()`（fabric.rs，原 1707 行）直接使用——
   拨号候选只有令牌那**一条** relay，无任何 failover 候选。

iroh 1.1.0 上游**已具备**多候选 failover 语义（`RelayMode::custom` 接受
RelayMap；`EndpointAddr` 多 relay URL + IP 并存时，`RemoteStateActor` 对全部
已知路径并发发送初始握手包——iroh/src/socket/remote_map/remote_state.rs
`handle_msg_send_datagram` "sending datagram to all known paths"；每条 relay
URL 独立 `ActiveRelayActor` 带指数退避无限重连）。缺陷是本仓库从未把多条目
候选喂给拨号路径：`connect()` 走 `merge_dial_candidates`（learned + 本地配置
全量合并）本可 failover，但 join 路径没有做同样的合并。**非上游 bug，无需
vendored 改动。**

**c2 是本仓库会话层缺失重连：**`insert_peer()` 的 `closed_task`
（fabric.rs，closed_task 同代次分支）在连接死亡后仅摘除 peer 条目并广播
`PeerDisconnected`，**无任何重拨**——iroh 侧 relay 连接会自动重连恢复
（actor 无限退避重试），但 fabric 会话死了就死了，直到进程重启。

## What Changes

三处最小侵入修复（全部在 `crates/dweb-fabric/src/fabric.rs`）：

1. **invite 携带活 relay（c1）**：`invite_with()` 改用快照
   `active_url`（当前实际在线的 home relay，经 `same_relay_url` 映射回配置
   原样字符串——HB 8.1 对外回显配置形态）；快照未沉降（刚启动未 online）时
   回退 `urls.first()`（与旧行为一致，宁缺勿假）。纯函数
   `invite_relay_url(&RelayConfig, &RelayStatusSnapshot)` 供确定性单测。

2. **join 拨号候选合并（c1）**：`join()` 的拨号地址 = 令牌地址（issuer relay
   + 直连提示）+ 本地 relay 配置**全量**追加（`with_local_relay_candidates`，
   自 `merge_dial_candidates` 的 relay 段提取共用，custom 配置序全量 / n0
   默认列表全量，EndpointAddr 内部去重）。与 connect 的合并语义一致
   （known-addrs-boundary 规格已冻结"custom relay 候选始终参与，learned 是
   补充"），join 不再被令牌里的单死条目阻断。join 错误分类（8 码 +
   RELAY_OFFLINE 探针）完全不变——探针仍只看令牌 relay URL。

3. **会话自动重连监管（c2）**：`start()` 常驻 reconnect manager（消费
   `reconnect_tx` unbounded channel），`closed_task` 同代次分支（= 非人为
   移除的意外死亡）发送通知，manager 为该对端派发退避重拨 worker（1s 起倍
   增、上限 30s），重拨完全复用 `Fabric::connect()` 的准入语义（幂等、
   single-flight、shutdown 拒绝、成员门控）。终止条件：重连成功（新连接的
   closed_task 接力下一轮）/ 本地显式断开（`disconnect()` 现在一律记录
   recent_disconnects，即便此刻无活跃条目）/ 对端不再是成员（NotMember 即
   停）/ fabric 关闭（worker 经 accept_children 登记表收割，manager 在
   endpoint 关闭前 abort+join——完成门"无任务残留"语义不变）。经 channel
   请求而非直接 spawn 的原因：直接 spawn 会形成
   insert_peer -> reconnect -> connect -> insert_peer 的递归 future，
   rustc 无法证明 Send（编译期报错实证）。

   双侧同时意外死亡时两端各自监管重拨，iroh/fabric 的同 NodeId 连接去重 +
   peers 代次替换保证收敛。

## Non-goals

- 不改邀请令牌 wire 格式（令牌仍携带单条 relay URL；协议兼容性不动）。
- 不改 join 错误分类矩阵（D11 八码 + 探针语义冻结）。
- 不动 iroh 上游（无需 vendored 修复）。
- 不做 relay 健康度排序/主动摘除（iroh net_report 的 preferred relay 已按
  探活延迟选择 home relay）。

## Impact

- 代码：`crates/dweb-fabric/src/fabric.rs`（invite/join/insert_peer/
  disconnect/start/shutdown_drain + 2 个纯函数 + 2 个单测）。
- 测试：新增 `crates/dweb-fabric/tests/relay_failover.rs`（真实 iroh relay
  server 集成测试，c1/c2 各一）。
- Specs：`fabric/session`（会话自动重连语义）、`fabric/known-addrs-boundary`
  （join 拨号候选合并语义）随归档同步。
