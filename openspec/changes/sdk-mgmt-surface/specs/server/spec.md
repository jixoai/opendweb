## ADDED Requirements

### Requirement: Server 管理 API（admin token 保护的管理面）

服务端 SHALL 提供挂载于 `/admin/*` 的管理 API，仅当 `DWEB_ADMIN_TOKEN` 已配置时挂载（未配置 = 不挂载 = 404 零暴露）；所有 `/admin/*` 请求 MUST 经 Bearer token 常时比较认证（401 拒绝且不泄露配置了哪些路由）。管理 API 是 Admin（本地配置管理者）的动作面，MUST NOT 提供 Owner 自助注册；管理动作与 relay 数据面（L1/L1b/L2 验证链）MUST 保持隔离——管理 API 只消费 gate 的观察视图与连接表句柄，MUST NOT 旁路验证链。

管理面 SHALL 覆盖：

- **owners registry CRUD**：`GET /admin/owners`（活跃集合列表）、`POST /admin/owners`（注册 (fabric_id, root) 二元组）、`DELETE /admin/owners/{fabric_id}/{root}`（注销；新连接即时拒绝，存量连接由注销语义处理）。
- **运行状态**：`GET /admin/status`（access mode、policy、registry generation、owner 数等投影；既有 wire 冻结不变）。
- **在线连接视图**：`GET /admin/connections` 返回按 endpoint 与按 owner 的在线投影及配额。响应 JSON（snake_case，与既有 admin 面一致）MUST 为：

```jsonc
{
  "mode": "restricted",            // "open" | "restricted"（取自 access 配置，非 gate 句柄推导）
  "policy": "static",
  "relay_enabled": true,           // relay 服务是否装配
  "quota": { "configured": true, "max_connections_per_owner": 16 },
  "per_endpoint": [ { "endpoint_id": "<64hex>", "fabric_id": "<64hex>", "connections": 2 } ],
  "per_owner":  [ { "fabric_id": "<64hex>", "connections": 2 } ]
}
```

  投影语义：`mode` 与 `relay_enabled` 为独立字段——`restricted` + relay 未启用时 MUST 保持 `mode: "restricted"`、`relay_enabled: false`、在线投影为空数组（不得把 restricted+无 relay 误报为 open）。`open` 模式（无验证链无在线统计）MUST 如实投影空集合并标注 mode（不虚构、不报错）。`per_endpoint` 按在线表快照排序稳定（endpoint_id 字典序）。未知响应字段调用方 MUST 忽略（向前兼容）。
- **主动断连**：`POST /admin/connections/disconnect`，请求体 `{ "endpoint_id": "<64hex>" }` 或 `{ "fabric_id": "<64hex>" }` 恰好其一。命中在线端点的存量 relay 连接 MUST 被下发断开（异步 start_shutdown 语义）；断开为 best-effort 最终收敛——响应报告**已下发断开的端点与连接数**，在线视图在断开完成后收敛（调用方以有界轮询确认，不得假设响应即收敛）。未命中返回 404。relay 服务未启用时该路由 MUST 仍可路由并报告零断开（明确语义而非报错）。

**错误面契约**：管理面业务错误响应 MUST 携带稳定 JSON envelope `{"error":{"code":"<machine-readable>","message":"<human>"}}`（Content-Type application/json）。「未挂载」（未配置 token 的 axum 默认 404，空 body）与「业务未命中」（404 + envelope `no-match`）的判别 MUST NOT 依赖空 body 嗅探作为唯一信号——客户端以专用 `GET /admin/status` 探测判定未挂载（404 = 未启用；200 = 已挂载）。

**回执契约**（版本化冻结，与既有 register/unregister 同构）：变更类操作（register/unregister/disconnect）SHALL 返回服务端 `server.key`（Ed25519）签名的回执。canonical 载荷统一为 `b"dweb/admin-receipt/v1\0" || op u8 || fabric_id 32B || target 32B || ts_ms u64BE || generation u64BE`（op：register=0x01 / unregister=0x02 / disconnect=0x03；register/unregister 的 target = root EndpointId；disconnect 的 target = 被断开的 endpoint EndpointId——**每个被断端点一张回执**，实现 per-target 审计）。disconnect 的快照规则 MUST 冻结为：判定取**单次在线表快照**；按 endpoint_id 请求命中该快照中唯一条目（无条目 = 404 no-match）；按 fabric_id 请求按 endpoint_id 字典序展开该 owner 全部在线条目；每张回执的 fabric_id 取自快照条目，ts 与 generation 为全请求共享（单一动作时刻与 registry 世代）；open 模式或 relay 未启用的空报告响应中 receipts MUST 为空数组。HTTP JSON 形态（snake_case，与既有 Receipt 一致）：`{ "op": "disconnect", "fabric_id": "<64hex>", "endpoint_id": "<64hex>", "ts": 1789…, "generation": 4, "receipt_sig": "<base64url-nopad 64B>" }`（register/unregister 沿用既有字段 `root` 与顶层形态，不变）。回执是审计辅助而非授权凭证。**错误 body 版本化变更**：既有 401/400 单字符串错误 body 统一迁移为 envelope `{"error":{"code","message"}}`（有意的 minor wire change；旧消费者只看 status code）。

#### Scenario: 未配置 token 时管理面零暴露

- **WHEN** 服务端启动未设置 `DWEB_ADMIN_TOKEN`
- **THEN** `/admin/*` 全部路由返回 404，与「路由不存在」语义一致（不提示需配置）

#### Scenario: 无凭证或错凭证访问被拒

- **WHEN** 携带错误 Bearer token 或不携带凭证访问任一 `/admin/*` 路由
- **THEN** 返回 401，响应体不包含任何 registry/在线状态信息

#### Scenario: 在线视图投影与配额

- **WHEN** restricted 模式、relay 已启用，两个 Owner 各有一条在线连接，`GET /admin/connections`
- **THEN** per_endpoint 与 per_owner 如实反映（endpoint_id 字典序）；quota 返回 configured=true 与配置值；mode="restricted"、relay_enabled=true

#### Scenario: restricted + relay 未启用的正确投影

- **WHEN** restricted 模式但 relay 服务未装配，`GET /admin/connections`
- **THEN** mode="restricted"、relay_enabled=false、per_endpoint/per_owner 为空数组（不得投影为 open）

#### Scenario: open 模式的如实空投影

- **WHEN** `open` 模式（无验证链）下 `GET /admin/connections`
- **THEN** 返回 200，mode 标注 `open`，per_endpoint/per_owner 为空数组（不报错、不虚构）

#### Scenario: 主动断连的最终收敛

- **WHEN** `POST /admin/connections/disconnect` 指定一个有在线连接的 endpoint_id
- **THEN** 响应报告该端点的连接数并附 per-target 回执（op/endpoint_id/ts/generation/receipt_sig）；随后以有界轮询（如 ≤5s）观测 `GET /admin/connections`，该端点的连接计数收敛消失

#### Scenario: 按 fabric 断连多端点的确定性展开

- **WHEN** 某 fabric 有两个在线 endpoint，`POST /admin/connections/disconnect` 指定该 fabric_id
- **THEN** disconnected 与 receipts 均按 endpoint_id 字典序展开；两张回执的 fabric_id 各取自快照条目、ts 与 generation 相同

#### Scenario: 空报告的 receipts 语义

- **WHEN** relay 未启用或 open 模式下调用 disconnect
- **THEN** 返回 200，disconnected 与 receipts 均为空数组

#### Scenario: 断连目标未命中

- **WHEN** disconnect 指定的 endpoint_id/fabric_id 不在任何在线表项中
- **THEN** 返回 404 且 body 为 `{"error":{"code":"no-match",…}}` envelope；不产生断开动作与回执

#### Scenario: 请求体同时缺失或同时给出两个键

- **WHEN** disconnect 请求体既无 `endpoint_id` 也无 `fabric_id`，或两者同时出现（含未知字段）
- **THEN** 返回 400 + error envelope（`invalid-request`），错误信息指明必须恰好其一
