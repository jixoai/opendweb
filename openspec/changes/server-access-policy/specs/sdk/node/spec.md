## ADDED Requirements

### Requirement: Relay 配置携带 per-relay capability

`@jixo/opendweb-client-sdk` 的 `RelayOptions` SHALL 支持按 relay 携带 capability 凭证：新增可选字段 `relays: Array<{ url: string; token?: string }>`（`token` 为 `dwebr1.` capability 串）。既有 `urls?: string[]` 字段保留且语义不变（等价于 `relays` 中 `token` 缺省的条目）；两字段同时提供时 MUST 以显式报错拒绝（不静默合并）。`token` SHALL 原样注入对应 relay 的接入凭证（native 经 `Authorization` 头、wasm 经 URL query，由 iroh RelayMap 条目级机制承载）。relay 接入被服务端拒绝（`dweb/*` 结构化 deny reason）时，SDK SHALL 将 reason 透出为连接诊断事件（不静默吞掉、不无限重试该 relay）。

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
