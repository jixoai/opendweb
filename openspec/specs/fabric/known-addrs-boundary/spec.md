# fabric/known-addrs-boundary Specification

## Purpose
known_addrs 从邀请令牌/连接学到的对端地址，当前为无界 HashMap——长期运行
内存缓慢增长，且 learned 地址优先于 custom relay 候选（可能跳过配置的 relay）。

## Requirements

### Requirement: known_addrs 有界

known_addrs SHALL 有容量上限（建议 1024 per-endpoint / 全局 65536）；
超限时按插入序淘汰最旧条目。SHALL 冻结 learned 地址与 custom relay
候选的合并优先级语义（建议：custom relay 候选始终参与，learned 地址
作为补充而非替代）。

#### Scenario: 容量淘汰

- **WHEN** known_addrs 超过容量上限
- **THEN** 最旧条目被淘汰，不无限增长

#### Scenario: learned 不遮蔽 custom relay

- **WHEN** 对端有 learned 直连地址且本地配置了 custom relay 列表
- **THEN** 拨号时 relay 候选仍参与（不被 learned 地址完全替代）

### Requirement: join 拨号候选与本地 relay 配置合并

join（邀请兑换后的会话建立）的拨号地址 SHALL 为令牌携带地址（relay 与
直连提示）加上本地 relay 配置的全量候选（custom 配置序全量；n0 默认为
上游默认列表全量），与常规 connect 的候选合并语义同源；候选合并后按
端点地址内部去重。加入侧 MUST NOT 因令牌携带的单条 relay 不可达而失去
本地配置中的可达候选。

[W12] 边界：relay 禁用（direct-only 数据面）时，令牌携带的 relay URL 与
learned 地址中的 relay 形态串 MUST 全部过滤（只留 IP 直连候选）——本地
无 relay 配置可合并，relay 候选也不得从 invite/learned 侧进入拨号地址。
学习路径同源约束：direct-only 数据面下 join 学习 issuer 可达信息时
MUST NOT 把 relay URL 写入/持久化进 known_addrs（真双机实证：hub 的
HTTP-only relay URL 曾被当直连候选持久化，重启后经 connect 候选合并
回流拨号地址）；relay URL 学习仅在显式 relay 数据面模式下发生。

#### Scenario: 令牌死 relay 与本地活条目同列表

- **WHEN** 签发者与加入者 relay 配置同为 [死条目, 活条目]，令牌携带的 relay 不可达
- **THEN** join 拨号对全部候选并发尝试，经活条目在时限内建立会话

#### Scenario: 跨列表配置同样参与合并

- **WHEN** 令牌携带的 relay 与本地配置的 relay 属不同列表且令牌条目可达
- **THEN** 会话建立；后续该对端的常规 connect 拨号同样包含两路候选

#### Scenario: direct-only 学习不落 relay URL（[W12] 学习源头卫生）

- **WHEN** direct-only fabric 以携带 relay URL 与直连地址的令牌 join（拨号最终失败也计入）
- **THEN** 持久化的 known_addrs 只含直连地址（relay URL 不进文件）；后续 connect 的候选合并同样过滤该表中的任何 relay 形态串
