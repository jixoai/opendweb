# fabric/known-addrs-boundary Delta

## ADDED Requirements

### Requirement: join 拨号候选与本地 relay 配置合并

join（邀请兑换后的会话建立）的拨号地址 SHALL 为令牌携带地址（relay 与
直连提示）加上本地 relay 配置的全量候选（custom 配置序全量；n0 默认为
上游默认列表全量），与常规 connect 的候选合并语义同源；候选合并后按
端点地址内部去重。加入侧 MUST NOT 因令牌携带的单条 relay 不可达而失去
本地配置中的可达候选。

#### Scenario: 令牌死 relay 与本地活条目同列表

- **WHEN** 签发者与加入者 relay 配置同为 [死条目, 活条目]，令牌携带的 relay 不可达
- **THEN** join 拨号对全部候选并发尝试，经活条目在时限内建立会话

#### Scenario: 跨列表配置同样参与合并

- **WHEN** 令牌携带的 relay 与本地配置的 relay 属不同列表且令牌条目可达
- **THEN** 会话建立；后续该对端的常规 connect 拨号同样包含两路候选
