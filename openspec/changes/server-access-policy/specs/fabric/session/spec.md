## MODIFIED Requirements

### Requirement: 兑换通道（独立 ALPN）

邀请兑换 SHALL 使用独立于常规会话的 ALPN。兑换连接 MUST 限制为单条双向流、按三段式交换（REDEEM_INTENT（令牌）→ CHALLENGE（32B 质询）→ PROOF（PoP 签名））、总字节数不超过上限（32 KiB）、自连接建立起不超过时限（5s）；超限或超时即断开。签发者侧对 invite_id 的消费 MUST 持久化且原子（单次成功）。兑换完成后连接即关闭，兑换通道 MUST NOT 承载 HELLO、名册同步或业务消息。

**回执帧版本化**：成功回执 SHALL 按令牌版本选择帧类型——`dweb1.` 令牌回既有 `REDEEM_OK`（payload 为全量名册 dump，语义与长度边界不变）；`dweb2.` 令牌回新帧 `REDEEM_OK2`（payload = 名册 dump + u32 长度前缀的 capability 附发段 `[(relay_url, dwebr1.capability)]`，可为空）。capability 附发段 SHALL 绑定 redeemer（recipient == 兑换 PoP 中的 redeemer EndpointId == TLS peer），作为长期 member capability（TTL 上限 90 天）。签发者 MUST NOT 对 v1 令牌回 OK2（旧客户端按尾随字节严格拒绝扩展的既有解析器不受影响）。

#### Scenario: 兑换后通道关闭

- **WHEN** 被邀请者完成一次成功兑换
- **THEN** 连接被关闭，后续通信走常规 ALPN（届时已是成员）

#### Scenario: 兑换超时断开

- **WHEN** 连接建立后 5s 内未收到合法首帧
- **THEN** 连接被服务侧断开

#### Scenario: v2 兑换回 OK2 附发 capability

- **WHEN** joiner 以 `dweb2.` 令牌完成兑换
- **THEN** 收到 REDEEM_OK2：名册 dump + 附发 capability 段（每条 recipient==redeemer）；joiner 持久化该 capability 供后续 relay 接入

#### Scenario: v1 兑换不收到扩展帧

- **WHEN** joiner 以 `dweb1.` 令牌完成兑换
- **THEN** 收到既有 REDEEM_OK，payload 不含任何 capability 段

### Requirement: 邀请令牌携带活 relay 快照

邀请令牌携带的 relay URL SHALL 取签发时刻快照的在线 home relay（active_url），
并映射回配置原样字符串（配置写入什么形态，令牌与对外回显就是什么形态）；
快照未沉降（签发者刚启动、net_report 未完成）时 SHALL 回退配置序首条。
relay 禁用模式下的令牌 relay 字段恒为空。令牌携带的 relay MUST 是签发者
实际可达路径的首选事实，而非盲取配置序首条。InviteV2 的 relay 列表沿用
同一"活快照优先"原则（v1 单条语义退化为列表特例：v1 令牌仍为单条）。

#### Scenario: 死条目在首位时令牌携带活条目

- **WHEN** 签发者 custom relay 配置为 [死条目, 活条目] 且已沉降在线
- **THEN** 邀请令牌携带活条目 URL；同配置的加入者凭该令牌 join 与 connect 均在时限内成功

#### Scenario: 快照未沉降回退首条

- **WHEN** 签发者刚启动、relay 快照尚未沉降即签发邀请
- **THEN** 令牌携带配置序首条（与旧行为一致，不阻塞签发）

#### Scenario: v2 拨号候选含 per-relay capability

- **WHEN** joiner 持 InviteV2（relay 列表含 restricted server 条目）执行 join
- **THEN** 拨号候选合并时每条 relay URL 连同其 capability 注入 iroh RelayMap（条目级 token）；无 capability 的 relay URL 候选保持原样注入
