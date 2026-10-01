# sdk/node delta —— webui-plugin-kernel

## MODIFIED Requirements

### Requirement: 名册操作

SDK SHALL 提供 `invite()` 返回邀请令牌字符串、`join(token)` 兑换令牌加入网络、`members()` 返回当前有效成员投影（含 EndpointId 与显示名）、`revoke(endpointId)` 签发撤销。`invite()` SHALL 接受可选第三参 `{ allowRelayless?: boolean }` 透传内核签发安全门逃生阀；无 relay 且无显式直连地址时 `invite()` SHALL 以 `InviteWithoutRelay` 语义的错误 reject（而非产出不可达令牌）。构造选项 SHALL 新增：`advertiseAddrs`（字符串数组，逐项校验 ip:port，非法项构造报错）、`httpProxy`（`"none" | "from-env" | { url: string }`，缺省 `"none"`，映射内核 iroh endpoint 代理配置）、`joinTimeoutMs`（数值，缺省 30000，值域 1000 至 600000，越界构造报错）；relay 配置的 `mode` SHALL 为字面量联合 `"disabled" | "custom" | "n0"`。[W12]：`relay` 选项缺省（含 `mode` 缺省）SHALL 为 `"disabled"`（direct-only 数据面——HTTP-only relay 不能承载端点间 QUIC 数据面，真双机实证 relay-first 停滞）；`"n0"` 与 `"custom"` 只能显式 opt-in。join 失败的错误 SHALL 以 `[<kebab-code>]` 消息前缀标识稳定错误码（token-invalid/token-expired/wrong-fabric/no-reachable-path/relay-offline/dial-failed/dial-timeout/token-consumed），目录归属不匹配的前缀为 `[wrong-fabric]`，供 JS 侧设置 `err.code`。豁免的本地数据面错误（目录缺身份、名册真损坏、名册读写 IO）SHALL 同样以 kebab 前缀透出（missing-identity/corrupted/roster-io），JS 侧派生同名 SCREAMING_SNAKE code。主规格既有 `start()/stop()` 生命周期措辞与现实现（工厂构造 + `shutdown()`）的历史差异由 C0.3 勘误统一为后者。

#### Scenario: API 完整往返

- **WHEN** 使用 SDK 的 invite/join/members/revoke 完整流程
- **THEN** 各方法按 fabric/roster 规格定义的语义生效

#### Scenario: 无 relay 拒签透出

- **WHEN** relay 未配置时调用 `invite(ttl, null)`（无 allowRelayless）
- **THEN** Promise 以 InviteWithoutRelay 语义的错误 reject

#### Scenario: join 错误码前缀

- **WHEN** 以空路径令牌调用 `joinWithToken`
- **THEN** reject 的错误消息以 `[no-reachable-path]` 前缀标识

#### Scenario: 缺省 relay 配置为 direct-only（[W12]）

- **WHEN** 以不携带 `relay` 选项的选项对象构造 Fabric 并查询 `relayStatus()`
- **THEN** mode 为 `"disabled"`、urls 为空数组、online 为 null；显式 `{ mode: "n0" }` / `{ mode: "custom", urls }` / `{ mode: "custom", relays }` 构造照常可用
