# Design: sdk-mgmt-surface

## 0. 定位与边界

本 change 交付「别人基于 opendweb 做管理/授权」的可编程地基，三层：

```
第三方工具 / CLI / WebUI（webui-console change）
        │  typed 调用
        ▼
@jixo/opendweb-client-sdk ./admin + ./token   ← 本 change（纯 TS，零 native）
        │  HTTPS + Bearer
        ▼
dweb-server /admin/*（既有 owners/status + 新 connections/disconnect） ← 本 change（Rust 增量）
```

**红线继承**（server-access-policy §0）：管理 API 只是 admin-plane 的动作面；
`IP:port / endpoint_id / invite id / admin token 本身` 都不构成数据面授权。
本 change 不触碰 L1/L1b/L2 验证链与 relay 数据面。

**Owner 裁决（2026-09-22）**：不做 Server 驻留管理台——管理动作从本地发起。
因此 server 侧**不新增**静态托管/CORS/WebSocket 面；`/admin/*` 保持纯 JSON
REST（这是「不扩大 server 攻击面」的结构性保证）。

## 1. admin API 扩面（crates/dweb-server/src/access/admin.rs）

### 1.1 既有面（收编进 spec，实现零变化）

- 挂载语义：`DWEB_ADMIN_TOKEN` 存在才挂 `/admin/*`（main.rs:436-441），未设 = 404。
- 认证：Bearer 常时比较中间件（admin.rs 既有）。
- 路由：`GET/POST /admin/owners`、`DELETE /admin/owners/{fabric_id}/{root}`、
  `GET /admin/status`。
- 回执：`receipt_canonical`（admin.rs:363）domain `dweb/admin-receipt/v1\0`，
  OP_REGISTER=0x01 / OP_UNREGISTER=0x02。

### 1.2 新增路由

**`GET /admin/connections`**

```jsonc
// 200
{
  "mode": "restricted",          // "open" | "restricted"
  "policy": "static",
  "quota": { "maxConnectionsPerOwner": 16, "configured": true },
  "perOwner":  [ { "fabricId": "80ad…", "connections": 2 } ],
  "perEndpoint": [ { "endpointId": "9726…", "fabricId": "80ad…", "connections": 2 } ]
}
```

数据源：`AdminState.gate`（restricted 模式）→ `gate.online_view()`
（gate.rs:400，`OnlineView{per_endpoint, per_owner}` 已是快照语义）+
`gate.max_connections_per_owner()`（gate.rs:395）。`gate = None`（open 模式
或 relay 未启用）→ 如实空集 + `"mode": "open"`（spec 场景钉住：不报错、
不虚构）。在用值 = perOwner[].connections 直接可读，无需额外字段。

**`POST /admin/connections/disconnect`**

```jsonc
// 请求（恰好其一）
{ "endpointId": "9726…" } | { "fabricId": "80ad…" }
// 200
{ "disconnected": [ { "endpointId": "9726…", "fabricId": "80ad…", "connections": 1 } ],
  "receipt": { "op": 3, "ts": 1789…, "generation": 4, "signature": "hex…" } }
```

实现：**抽取 unregister 既有断连路径为共享函数**（当前 admin.rs 注销分支
内联「gate.online_view 反查 → relay_clients.disconnect(endpoint, Option<
ConnectionId>)」；抽 `disconnect_online(state, filter) -> Vec<DisconnectHit>`，
unregister 与新路由共用——unregister 按 (fabric,root) 过滤，新路由按
endpointId/fabricId 过滤）。语义边界：

- `relay_clients = None`（relay 未启用）：返回 200 + 空 disconnected（明确
  语义；spec 场景钉住）。
- 未命中：404（不断开、无回执）。
- 请求体校验：`endpointId`/`fabricId` 恰好其一（serde deny_unknown_fields +
  手工互斥检查），违者 400。
- hex 解析失败：400（与既有 owners 路由的 400 语义一致）。

**回执 op 扩展**：`OP_DISCONNECT: u8 = 0x03`；canonical 载荷 =
`RECEIPT_DOMAIN || 0x03 || ts_ms u64BE || generation u64BE`（disconnect 不绑
fabric/root 单主键——命中可能是多 endpoint 的聚合动作，绑 op+ts+generation
即可审计；多 endpoint 明细在响应体不在签名内，签名只承诺「该动作发生于该
时刻的该 registry 世代」）。

### 1.3 不做的（与 Codex 对齐预答）

- **不做** `POST /admin/callback/test`（webhook 连通性测试）：callback 配置含
  token，测试端点会诱导把 callback_token 经 admin 面反射，扩大凭证暴露面；
  连通性由 operator 在 webhook 侧自测（curl 即可）。若后续需要，独立 change
  论证。
- **不做** 运行时改配额/改 mode：配置变更重启生效是既有部署模型（SIGHUP
  只热加载 registry）；运行时突变与 fail-fast 校验冲突，收益不抵复杂度。
- **不做** SSE/长轮询在线流：轮询 `GET /admin/connections` 足够管理场景。

## 2. client-sdk `./admin` subpath（纯 TS）

### 2.1 形态与放置

遵循 app-protocol-layer Owner 裁决的 subpath 形态（不新增独立包）：

```jsonc
// packages/client-sdk/package.json exports 增量
"./admin": { "types": "./admin/index.d.ts", "default": "./admin/index.js" },
"./token": { "types": "./token/index.d.ts", "default": "./token/index.js" }
```

源码放 `packages/client-sdk/admin/` 与 `packages/client-sdk/token/`（纯 TS，
**不经过** napi build 产物目录——与 Rust 构建解耦，`app-protocol-layer` 的
`./net`/`./http` 面（native+TS 混合）文件级互不相交）。零运行时依赖：
手写窄类型守卫（不引 zod——client-sdk 是 native 包，TS 侧依赖面要最小化；
解析失败路径统一抛 `AdminError`/`TokenError`）。

### 2.2 AdminClient

```ts
new AdminClient({ baseUrl: "https://srv.example:18787", token: "…", timeoutMs?: 10_000 })
.status()                                    // GET /admin/status
.listOwners() / .registerOwner(fabricId, root) / .unregisterOwner(fabricId, root)
.connections()                               // GET /admin/connections
.disconnect({ endpointId? , fabricId? })     // POST /admin/connections/disconnect
```

- 请求：全局 `fetch` + `AbortSignal.timeout`；Bearer 头注入；`baseUrl` 尾斜杠
  归一。
- 错误归一：非 2xx → `AdminError`。code 判别表：
  `admin-not-enabled`（404 且路径存在性不可探测——server 未配 token）、
  `unauthorized`（401）、`bad-request`（400）、`not-found`（404 且业务语义
  = 目标不存在，如 disconnect 未命中）、`network`（fetch reject）、
  `timeout`。实现注意：404 的两种语义靠 body 区分不可靠（axum 默认 404 空
  body）——**决策**：disconnect 未命中改为带 JSON body `{"error":"no-match"}`
  的 404，AdminClient 以 body 判别；未挂载的 404 body 为空。此判别规则写进
  实现注释与测试。
- 回执：变更类返回 `{ receipt: AdminReceipt }`；`receiptCanonical(receipt)`
  输出待签字节（与 server `receipt_canonical` 逐字节一致，冻结对拍测试）；
  `verifyReceipt(receipt, verifier)` —— verifier 为注入的
  `(payload: Uint8Array, signature: Uint8Array, publicKey?: Uint8Array) =>
  boolean`，包内不引 ed25519（调用方可自带 @noble/ed25519 或用 server_id
  公钥自验）。公钥来源：`GET /`（services.json 的 `server_id` hex 即 Ed25519
  公钥）——helper `adminPublicKeyFromServices(json)` 提取之。

### 2.3 ./token subpath（只读解码显示）

- `decodeInvite(token: string): DecodedInviteV2` —— wire 按归档 design 附录 A
  冻结解析：`dweb2.` + base64url-nopad；canonical = version(1)||fabric(32)||
  invite_id(16)||issuer(32)||expires u64BE||recipient(32)||relay_count u8||[
  url_len u16BE||url||cap_len u16BE||cap]…||addr 段。输出 hex 化 id 字段、
  `relays: [{url, hasCapability}]`、`directAddrs: string[]`。
- `decodeCapability(token: string): DecodedRelayCapV1` —— `dwebr1.` 210B wire：
  canonical 146B（version(1)+4×32+caps(1)+issued u64BE+expires u64BE）+sig 64B。
  caps 位图命名展开 `{relay, rdzAnnounce, rdzResolve}`。
- 冻结对拍：测试向量与 Rust 侧同源生成（fabric 协议测试已有
  `CROSS_CRATE_CAP_VECTOR`（crates/dweb-fabric/src/lib.rs:29）——TS 测试读
  同一向量文件对拍；invite 侧新增一个跨语言冻结向量（Rust 测试导出 + TS
  消费，形式沿用 cap 向量先例）。
- 显式不做：验签、私钥操作、令牌构造（构造留在 Rust——签名域集中在
  native/服务端，TS 只读显示）。

## 3. 测试策略

| 层 | 测试 | 门 |
|---|---|---|
| Rust 单测 | disconnect 请求体校验矩阵（缺键/双键/坏 hex/未命中/命中）、open 模式空投影、回执 op3 canonical | `mbx test -p dweb-server --bins`（node:test 无关，cargo 系） |
| Rust e2e | admin_token e2e 扩展：restricted 起 server + 真实 relay 连接 → connections 视图计数 → disconnect → 视图收敛 + 回执验签（server 侧 ServerIdentity 验） | server_access_e2e 风格（同文件追加） |
| TS 单测 | AdminClient mock-fetch 全 code 路径（404 空体 vs 带 body 判别）、receiptCanonical 冻结对拍、token 解码向量 + 非法输入矩阵 | `packages/client-sdk` 既有 node --test（test/ 目录） |
| TS e2e（可选但默认做） | story 侧：node 脚本用 AdminClient 打真实本地 server | npm script，纳入 change 验证记录 |

## 4. 任务切分依据

Rust 面（1.x）先行——TS 客户端的判别规则依赖路由语义冻结；TS 两 subpath
可并行；e2e 收口在最后。

## 5. 风险与开放问题

- **404 双语义判别**（§2.2）是最脆的契约点：已用 body 约定钉住，spec 场景
  「未配置 token 零暴露」+「断连未命中」分立，TS 测试双覆盖。若 Codex 认为
  应改用 409/410 等独立状态码，实现期可换——spec 只钉「互斥可判别」。
- **AdminState 无 lock 的快照一致性**：online_view 是单锁快照，disconnect
  反查与断连间存在竞态窗口（查到时在、断时已走）——语义为 best-effort 断开
  报告（报告实际断开数），不承诺线性一致；与 unregister 既有语义相同。
- **./admin 在无 native 环境 import 的验证**：client-sdk 的 `.` 主入口加载
  native binding——subpath 独立文件树必须保证不传递性 import 主入口
  （package.json `exports` 隔离即可，测试以 `node --input-type=module` 在无
  binding 环境冒烟）。
