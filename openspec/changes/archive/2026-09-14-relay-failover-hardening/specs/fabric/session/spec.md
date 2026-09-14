# fabric/session Delta

## ADDED Requirements

### Requirement: 邀请令牌携带活 relay 快照

邀请令牌携带的 relay URL SHALL 取签发时刻快照的在线 home relay（active_url），
并映射回配置原样字符串（配置写入什么形态，令牌与对外回显就是什么形态）；
快照未沉降（签发者刚启动、net_report 未完成）时 SHALL 回退配置序首条。
relay 禁用模式下的令牌 relay 字段恒为空。令牌携带的 relay MUST 是签发者
实际可达路径的首选事实，而非盲取配置序首条。

#### Scenario: 死条目在首位时令牌携带活条目

- **WHEN** 签发者 custom relay 配置为 [死条目, 活条目] 且已沉降在线
- **THEN** 邀请令牌携带活条目 URL；同配置的加入者凭该令牌 join 与 connect 均在时限内成功

#### Scenario: 快照未沉降回退首条

- **WHEN** 签发者刚启动、relay 快照尚未沉降即签发邀请
- **THEN** 令牌携带配置序首条（与旧行为一致，不阻塞签发）

### Requirement: 会话意外中断自动重连

非人为死亡的成员会话（对端关闭、路径中断等意外死亡；本地显式断开、
成员撤销、fabric 关闭不属于此列）SHALL 由常驻重连监管自动恢复：以有界
退避（初始约 1 秒倍增、上限约 30 秒）周期重拨，重拨 MUST 复用常规连接
的全部准入语义（幂等、single-flight、成员门控、关闭拒绝）。监管终止
条件 SHALL 为：重连成功（新会话接力下一轮监管）/ 本地显式断开（显式
断开语义 MUST NOT 被自动重连覆盖）/ 对端不再是成员 / fabric 关闭。
fabric 关闭时重连任务 MUST 全部终止，无任务残留。

#### Scenario: relay 恢复后会话自动重建

- **WHEN** relay-only 会话因 relay 宕机中断（对端进程未退出），relay 以同地址恢复
- **THEN** 不重启进程、不显式重连，会话在退避窗口内自动重建，在途消息恢复可达

#### Scenario: 宕机窗口内持续退避不放弃

- **WHEN** relay 持续宕机超过重拨退避上限
- **THEN** 重拨周期性失败但不放弃、不产生事件风暴；relay 恢复后仍能自动重连

#### Scenario: 显式断开不被重连覆盖

- **WHEN** 本地对某成员显式断开（无论此刻有无活跃会话）
- **THEN** 该断开被记录，自动重连不再为该对端重拨，直到下一次显式连接

#### Scenario: 关闭时重连任务无残留

- **WHEN** fabric shutdown 完成
- **THEN** 重连监管与全部在途重拨任务已终止并回收
