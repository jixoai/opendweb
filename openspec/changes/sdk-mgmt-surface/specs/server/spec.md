## ADDED Requirements

### Requirement: Server 管理 API（admin token 保护的管理面）

服务端 SHALL 提供挂载于 `/admin/*` 的管理 API，仅当 `DWEB_ADMIN_TOKEN` 已配置时挂载（未配置 = 不挂载 = 404 零暴露）；所有 `/admin/*` 请求 MUST 经 Bearer token 常时比较认证（401 拒绝且不泄露配置了哪些路由）。管理 API 是 Admin（本地配置管理者）的动作面，MUST NOT 提供 Owner 自助注册；管理动作与 relay 数据面（L1/L1b/L2 验证链）MUST 保持隔离——管理 API 只消费 gate 的观察视图与连接表句柄，MUST NOT 旁路验证链。

管理面 SHALL 覆盖：

- **owners registry CRUD**：`GET /admin/owners`（活跃集合列表）、`POST /admin/owners`（注册 (fabric_id, root) 二元组）、`DELETE /admin/owners/{fabric_id}/{root}`（注销；新连接即时拒绝，存量连接由注销语义处理）。
- **运行状态**：`GET /admin/status`（access mode、policy、registry generation、owner 数等投影）。
- **在线连接视图**：`GET /admin/connections` 返回 per-endpoint（endpoint_id、fabric_id、连接数）与 per-owner（fabric_id → 在线连接数）两个投影，连同 per-owner 连接配额（`DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER` 的配置值与当前在用值）。`open` 模式无验证链即无在线统计，MUST 如实投影为空集合并标注 mode（不得虚构数据，也不得报错）。
- **主动断连**：`POST /admin/connections/disconnect`，请求体指定 `endpointId`（hex）或 `fabricId`（hex）其一；命中在线端点的存量 relay 连接 MUST 被断开并在响应中报告（断开数、命中明细），未命中返回 404。relay 服务未启用时该路由 MUST 仍可路由并报告零断开（明确语义而非报错）。

变更类管理动作（register/unregister/disconnect）SHALL 返回服务端 `server.key` 签名的回执（domain `b"dweb/admin-receipt/v1\0"` + op 码 + fabric/root/时间戳/generation 的 canonical 序列化；disconnect 为新 op 码 0x03），供调用方审计留痕。回执是审计辅助而非授权凭证。

#### Scenario: 未配置 token 时管理面零暴露

- **WHEN** 服务端启动未设置 `DWEB_ADMIN_TOKEN`
- **THEN** `/admin/*` 全部路由返回 404，与「路由不存在」语义一致（不提示需配置）

#### Scenario: 无凭证或错凭证访问被拒

- **WHEN** 携带错误 Bearer token 或不携带凭证访问任一 `/admin/*` 路由
- **THEN** 返回 401，响应体不包含任何 registry/在线状态信息

#### Scenario: 在线视图投影与配额

- **WHEN** restricted 模式下两个 Owner 各有一条在线连接，`GET /admin/connections`
- **THEN** per_endpoint 与 per_owner 均如实反映两个 Owner 的连接；配额字段返回配置值（未配置时为 null）与在用值

#### Scenario: open 模式的如实空投影

- **WHEN** `open` 模式（无验证链）下 `GET /admin/connections`
- **THEN** 返回 200，mode 标注 `open`，per_endpoint/per_owner 为空数组（不报错、不虚构）

#### Scenario: 主动断连收敛

- **WHEN** `POST /admin/connections/disconnect` 指定一个有在线连接的 endpointId
- **THEN** 该端点的存量 relay 连接被断开，响应报告断开明细并附回执；随后 `GET /admin/connections` 不再包含该端点的连接计数

#### Scenario: 断连目标未命中

- **WHEN** disconnect 指定的 endpointId/fabricId 不在任何在线表项中
- **THEN** 返回 404，不产生断开动作与回执

#### Scenario: 请求体同时缺失或同时给出两个键

- **WHEN** disconnect 请求体既无 `endpointId` 也无 `fabricId`，或两者同时出现
- **THEN** 返回 400，错误信息指明必须恰好其一
