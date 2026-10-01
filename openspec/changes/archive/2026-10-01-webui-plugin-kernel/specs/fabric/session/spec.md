# fabric/session delta —— webui-plugin-kernel

## MODIFIED Requirements

### Requirement: 显式寻址建连

EndpointId 是身份不是地址。节点发起连接 SHALL 提供对端的可达信息：relay URL 与/或直连地址（EndpointAddr），来源为邀请令牌、同步的地址记录或显式配置。仅凭 EndpointId 且无任何地址线索时，连接 SHALL 快速失败并给出可诊断错误。直连优先（QUIC + NAT 穿透），不可达时经配置的 relay 桥接；默认 relay 与自托管 relay 均为可配置项，两者对上层 API 行为一致。

[W12]（真双机三轮实录的架构定论，Codex r7 终审 approve）：数据面 fabric 缺省 SHALL 为 **direct-only**（relay 禁用；发现 = invite 携带的 advertiseAddrs 直连地址 + 持久 known_addrs）；n0 / custom relay 数据面 SHALL 仅由调用方**显式 opt-in**。HTTP-only hub relay 不是数据面 relay——它只能承载注册/租约/rendezvous（管理面），不能转发端点间 QUIC 数据；把 HTTP-only relay 配置进数据面 relay 位是已知毒路径（relay 客户端"已连接"→路径选择 relay-first→数据吞没→停滞）。真正的 QUIC/TLS 数据面 relay 由后续独立 change 以显式 opt-in 开放。relay 禁用（direct-only）时，join 与 connect 的候选合并 MUST 过滤 invite 令牌与 learned（known_addrs）中的一切 relay URL——只保留 IP 直连候选；relay-only 令牌（无直连地址）在 direct-only 数据面上按空路径（NO_REACHABLE_PATH）在拨号前立即失败，错误信息指向签发侧补 advertiseAddrs。

#### Scenario: 直连成功

- **WHEN** 两节点在同一局域网且 UDP 可达，A 以对端 EndpointAddr 连接 B
- **THEN** 连接建立，上层可立即收发消息

#### Scenario: relay 回退

- **WHEN** 两节点间 UDP 直连不可达，且配置了可用 relay
- **THEN** 连接经 relay 桥接建立，API 层可观测到当前路径类型（direct / relay）

#### Scenario: 无地址线索快速失败

- **WHEN** 仅以 EndpointId 发起连接且无 relay/直连地址
- **THEN** 快速失败，错误信息说明缺少可达地址

#### Scenario: 缺省 direct-only 零 relay 接触（[W12]）

- **WHEN** 以缺省配置（不提供 relay）构造 fabric 并完成 start
- **THEN** relay 状态快照为 disabled（urls 空、online null）、无 relay watcher 任务、无任何 relay 连接尝试；显式 `{ mode: "custom", urls }` / `{ mode: "custom", relays }` / `{ mode: "n0" }` 构造仍可用

#### Scenario: direct-only 下 relay 候选被过滤（[W12] 地址卫生）

- **WHEN** direct-only fabric 的 learned/known_addrs 中混入 relay URL（历史持久化文件或手工注入），或收到携带 relay URL 与直连地址的 invite
- **THEN** join/connect 的拨号候选只含 IP 直连地址（relay URL 一律剥离）；收到 relay-only invite（无直连地址）时 join 以 no-reachable-path 在拨号前立即失败

## ADDED Requirements

### Requirement: shutdown 单一全局 5 秒 drain 预算

Fabric shutdown 的收尾 SHALL 受**单一全局 deadline**约束：自 drain 入口起算 5 秒总预算，全部收尾阶段（direct endpoint 关闭、主 endpoint 关闭、relay watcher / 重连 manager 收割、continuity 关闭、外层 accept loop、connect inflight 收敛、detached connect 任务、accept children）SHALL 共享该 deadline——任何阶段 MUST NOT 重起算独立预算。deadline 截止后收尾 SHALL 以确定性 abort + 有界 join 完成（abort 后的 join 同样受 deadline 约束；不可取消任务不无限等待，句柄丢弃并记 incomplete-drain）；未在预算内收敛时 shutdown SHALL 返回稳定的 incomplete-drain 错误，完成门（后续 shutdown 调用立即放行、无后续事件）仍 MUST 可观察。

#### Scenario: 多阶段同时阻塞在总预算内返回

- **WHEN** accept loop、connect inflight、detached connect、accept child 同时永不收敛（注入），调用 shutdown
- **THEN** 整体在 5 秒加测试余量内返回（不随阶段数线性叠加）；返回 incomplete-drain 错误；完成门放行后无后续事件，后续 shutdown 调用立即完成

#### Scenario: 正常收敛零额外等待

- **WHEN** 空载 fabric（无活跃会话/任务）调用 shutdown
- **THEN** 各阶段即时收敛，shutdown 在远小于预算的时间内成功返回
