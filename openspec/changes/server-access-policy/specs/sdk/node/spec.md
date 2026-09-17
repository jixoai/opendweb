## ADDED Requirements

### Requirement: Relay 配置携带 per-relay capability

`@jixo/opendweb-client-sdk` 的 `RelayOptions` SHALL 支持按 relay 携带 capability 凭证：新增可选字段 `relays: Array<{ url: string; server_id?: string; token?: string }>`（`token` 为 `dwebr1.` capability 串；`server_id` 为 restricted relay 的 ServerId——64 hex，admin 注册 owner 时转交）。既有 `urls?: string[]` 字段保留且语义不变（等价于 `relays` 中 `token`/`server_id` 缺省的条目）；两字段同时提供时 MUST 以显式报错拒绝（不静默合并）。`token` SHALL 原样注入对应 relay 的接入凭证（native 经 `Authorization` 头、wasm 经 URL query，由 iroh RelayMap 条目级机制承载）；带 `server_id` 的条目对 root 触发本地自签（`ensureRelayCapabilities()` 面向 SDK 暴露）。relay 接入被服务端拒绝（`dweb/*` 结构化 deny reason）时，SDK SHALL 将 reason 透出为连接诊断事件（不静默吞掉、不无限重试该 relay）。

实现裁定（Phase2-B 回写）：

1. `server_id` 字段为 spec 初稿 `{url, token?}` 之上的增补——root 自签场景
   （task 2.3 的 `ensure_relay_capabilities`）在 SDK 面需要 ServerId 配置位，
   否则 restricted relay 的 owner 侧凭证永远无法自签；napi 面暴露为可选
   hex64，构造期校验（非 64 hex 显式报错）。
2. deny reason 透出通道 = relay 状态快照 `lastError` + `relay-offline` 事件
   payload（fabric 错误脱敏层对 `dweb/[a-z0-9._-]` 结构化 reason 的例外
   透传，形态 `relay denied: dweb/<reason>`）；join/connect 拨号失败分类时
   若 deny 已记录，错误 message 附同一 reason（D11 码保持拨号族不变）。

#### Scenario: per-relay token 注入

- **WHEN** 以 `relays: [{url, token}]` 配置的客户端连接 restricted server 的 relay
- **THEN** 凭证随 relay 连接携带，验证通过后正常接入

#### Scenario: 旧形态兼容

- **WHEN** 以既有 `urls: string[]` 配置的客户端连接 open 模式 relay
- **THEN** 行为与本变更前一致

#### Scenario: 双字段冲突报错

- **WHEN** 同时提供 `urls` 与 `relays`
- **THEN** 构造期返回显式配置错误

#### Scenario: deny reason 透出

- **WHEN** restricted server 因 capability 过期拒绝接入
- **THEN** SDK 发出携带 `dweb/capability-expired` reason 的诊断事件，该 relay 路径不再重试
