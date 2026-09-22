# Design: sdk-mgmt-surface

> r1 修订（2026-09-22）：按 Codex 评审 docs/codex-review-sdkmgmt-r1.md 处置
> P0-1（回执 canonical 统一）、P0-2（mode/relay_enabled 拆分）、P0-4（发布物
> 门禁）、P1-1/2/3/4、P2-3/4。处置表见文末 §7。

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
server 侧**不新增**静态托管/CORS/WebSocket 面；`/admin/*` 保持纯 JSON REST。

## 1. admin API 扩面（crates/dweb-server/src/access/admin.rs）

### 1.1 既有面（收编进 spec：路由与成功 wire 不变；错误 body 为版本化变更）

- 挂载语义：`DWEB_ADMIN_TOKEN` 存在才挂 `/admin/*`（main.rs:436-441）。
- 认证：Bearer 常时比较中间件。
- 路由：`GET/POST /admin/owners`、`DELETE /admin/owners/{fabric_id}/{root}`、
  `GET /admin/status`。
- 回执 canonical（admin.rs:362-377 冻结）：`b"dweb/admin-receipt/v1\0" ||
  op u8 || fabric 32B || root 32B || ts u64BE || generation u64BE`；JSON
  Receipt `{op: "register"|"unregister", fabric_id, root, ts, generation,
  receipt_sig(base64url-nopad), kicked_*?}`（admin.rs:219-239）。
- **错误 body 版本化变更（r2-P1-2 措辞修正）**：既有 401/400 响应当前为
  单字符串 `{"error":"unauthorized"}` 形态（admin.rs:156）；本 change 统一
  迁移为 §1.2 的 `{"error":{code,message}}` envelope——这是**有意的 minor
  wire change**（旧消费者只看 status code 不解析 body，影响面零；spec 场景
  钉住新形态，既有测试同步更新）。

### 1.2 新增路由

**`GET /admin/connections`**（wire 见 spec 全 JSON 示例；snake_case 与既有
admin 面一致——既有 /admin/status 即 snake_case：max_connections_per_owner/
active_connections/per_owner_connections，admin.rs:389-399）：

- `mode` 取自 access 配置（AdminState.mode 字段直存，非 gate 句柄推导）；
  `relay_enabled` 独立字段（AdminState 增存 relay 装配事实）。restricted +
  relay 未启用 → mode="restricted" + relay_enabled=false + 空投影（P0-2
  处置：**不得**用 gate=None 推导 open——main.rs:343-447 实际装配是
  restricted 恒建 gate）。
- 数据源：`gate.online_view()`（gate.rs:400）快照 + `gate.
  max_connections_per_owner()`（gate.rs:395）；gate=None（open 模式）→ 空
  投影。**per_endpoint 条目粒度 = (endpoint_id, fabric_id) 对（r3-P1-3），
  按 (endpoint_id, fabric_id) 双键字典序**——同 endpoint 持多 fabric 连接
  时逐对成条，无 first() 类不确定聚合。
- **与 /admin/status 的分工**（P2-3）：status 的 active_connections/
  per_owner_connections 是既有冻结 wire（旧消费者依赖），保持不动；
  connections 是新详细视图（含 fabric 绑定、mode/relay 拆分、quota 结构）。
  两路并存是有意的，SDK 只面向 connections 详细视图抽象。

**`POST /admin/connections/disconnect`**：

```jsonc
// 请求（恰好其一；deny_unknown_fields）
{ "endpoint_id": "<64hex>" } | { "fabric_id": "<64hex>" }
// 200
{ "disconnected": [ { "endpoint_id": "<64hex>", "fabric_id": "<64hex>", "connections": 1 } ],
  "receipts": [ { "op": "disconnect", "fabric_id": "<64hex>", "endpoint_id": "<64hex>",
                  "ts": 1789…, "generation": 4, "receipt_sig": "<base64url-nopad>" } ] }
// 404（业务未命中，必带 envelope）
{ "error": { "code": "no-match", "message": "…" } }
```

- 实现：抽取 unregister 既有断连路径为共享函数（当前 admin.rs 注销分支
  内联「online_view 反查 → Clients::disconnect」）；unregister 与 disconnect
  共用，仅过滤键不同。
- **回执（P0-1 处置）**：canonical 布局**不变**（§1.1 冻结形），disconnect
  复用 `root` 32B 槽位承载**被断 endpoint_id**（op=0x03）；**每个被断端点
  一张回执**（per-target 审计，P2-1 一并解决）。JSON 层 disconnect Receipt
  用显式 `endpoint_id` 字段（不复用 `root` 键名），register/unregister 的
  Receipt 形态零变化。
- **回执快照规则（r2-P1-1 冻结）**：断连判定取**单次** `OnlineView` 快照；
  按 `endpoint_id` 请求 → 快照中该 endpoint 的全部 (endpoint, fabric) 对
  条目（per-pair 语义下可多条，按 fabric_id 字典序；无任何条目 = no-match
  404）；按 `fabric_id` 请求 → 该 owner 全部条目按 (endpoint_id, fabric_id)
  字典序展开（endpoint 在单一 fabric 名下至多一条）。每张回执的 fabric_id 取自该
  快照条目；**ts 与 generation 全部回执共享**（同一动作同一时刻同一 registry
  世代——ts 在进入 handler 时取一次，generation 取当时 registry snapshot）。
  open 模式 / restricted+relay 未启用 → 200 空 disconnected 且 **receipts
  必为空数组**。该输入/排序规则连同样例进 CROSS_CRATE_RECEIPT_VECTOR。
- **收敛语义（P1-2）**：`Clients::disconnect` 是异步 start_shutdown，在线
  计数等 OnDisconnectGuard 回调释放——响应报告「已下发」而非「已完成」；
  spec 场景钉有界轮询收敛；Rust/TS e2e 用 poll-with-deadline 断言。
- `relay_clients = None`（relay 未启用）：200 + 空 disconnected。
- 未命中：404 + envelope。请求体缺键/双键/未知字段/坏 hex：400 + envelope
  （`invalid-request`）。

**错误 envelope（P1-1 冻结）**：所有管理面业务错误响应统一
`{"error":{"code","message"}}`。「未挂载」判别的唯一规范途径 = `GET
/admin/status` 探测（404=未启用，200=已启用）——不依赖空 body 嗅探；代理
剥 body 场景下 status 探测依然成立（status 探测判别的是路由存在性而非
body 形态）。既有 401/400 路由响应改造为 envelope 形态（微调，属本 change
收编面）。

### 1.3 不做的（与 r1 评审对齐预答）

- 不做 `POST /admin/callback/test`（避免 callback_token 经 admin 面反射）。
- 不做运行时改配额/改 mode（重启生效的既有部署模型）。
- 不做 SSE/长轮询（轮询 connections 足够）。

## 2. client-sdk `./admin` 与 `./token` subpath（纯 TS）

### 2.1 形态、放置与发布物门禁（P0-4 处置）

- 源码形态（r2-P0-1 处置）：**`.mjs` + `.d.mts`**（纯 ESM entrypoint）。
  `packages/client-sdk` 无 `"type": "module"`，root/subpath 均为 CommonJS
  （index.js module.exports、net/index.js require）——`.js` 会被按 CJS 解析
  直接炸；不改包级 type（会破坏既有六个入口）。`.mjs` 在 CJS 包内合法共存
  且与 packages/opendweb 的 .mjs 纪律同构。exports：
  `"./admin": { "types": "./admin/index.d.mts", "default": "./admin/index.mjs" }`
  （./token 同形）。**冻结契约决策：两 subpath 为 ESM-only**（`import` 载入；
  不承诺 `require()`——Node 22 前 require(ESM) 不可用，写进 README）。
  目录 `packages/client-sdk/admin/`、`packages/client-sdk/token/`。
- `package.json` 增量（r3-P1-1：后缀统一 .mjs/.d.mts，全文不出现旧后缀）：
  `"./admin": { "types": "./admin/index.d.mts", "default": "./admin/index.mjs" }`
  （./token 同形）；**`files` 数组增 `admin`、`token` 目录**；tasks 2.2 的
  最终 exports 断言逐字冻结这两条路径。
- **隔离规则**：两目录源码 MUST NOT import 包内 root/`net`/`http`（无传递
  native 加载）；`.d.ts` 自包含。
- **pack 门禁（tasks 2.4）**：干净临时目录 `npm pack` → 解包安装 → 无
  `.node` 环境 self-reference import（`import "@jixo/opendweb-client-sdk/admin"`）
  + 类型检查双过。纳入 CI 面（与 app-protocol-layer 的 pack 验收同款）。

### 2.2 AdminClient

```ts
new AdminClient({ baseUrl, token, timeoutMs?: 10_000 })
.status() / .listOwners() / .registerOwner(fabricId, root) / .unregisterOwner(fabricId, root)
.connections()                                // GET /admin/connections（详细视图）
.disconnect({ endpointId? , fabricId? })      // POST /admin/connections/disconnect
.probeEnabled()                               // GET /admin/status → boolean / AdminError
```

- fetch + `AbortSignal.timeout`；Bearer 注入；baseUrl 尾斜杠归一。
- **probeEnabled 签名与矩阵（r2-P1-3 + r3-P1-2 冻结）**：
  `probeEnabled(): Promise<true>`——仅在探测得到 200 时 resolve `true`；
  **其余一律 reject `AdminError`**：404 → `code="admin-not-enabled"`（已判定
  未启用）；401 → `unauthorized`（已挂载但凭证错——不是 not-enabled）；
  502/503/任意非 200 → `http-<status>`；fetch reject → `network`；超时 →
  `timeout`。**不存在「false 返回值」，禁止把任意非 200 折叠为 not-enabled**。
  code 枚举含 `http-<status>` 形态（AdminError.code: string）。
  mock-fetch + e2e 双矩阵测试（502/503/未知 5xx 显式用例）。
- 错误归一 `AdminError{status, code, message}`；code 表：`admin-not-enabled`、
  `unauthorized`、`invalid-request`、`no-match`、`network`、`timeout`。
- 回执：`receiptCanonical(receipt)` 输出 §1.1 冻结 canonical（disconnect 的
  target=endpoint_id）；`verifyReceipt(receipt, verifier)` 注入式（包内无
  ed25519 依赖；调用方可自带 @noble/ed25519，公钥 = services.json 的
  server_id hex——helper `adminPublicKeyFromServices(json)` 提取）。
- 跨语言冻结对拍：Rust 单测导出 disconnect receipt 样例（canonical bytes +
  JSON），TS 测试消费同向量断言 `receiptCanonical` 逐字节一致（沿用
  CROSS_CRATE_CAP_VECTOR 先例，新增 CROSS_CRATE_RECEIPT_VECTOR）。**fixture
  可复现规则（r2-P2-2）**：向量文件落
  `crates/dweb-server/tests/fixtures/receipt-vector.json`，由 Rust 测试内
  固定 key/ts/generation 生成并断言（非本地时钟漂移）；TS 侧只读该文件。
  样例覆盖：register / unregister / disconnect（按 endpoint 与按 fabric
  多端点两种形态）。

### 2.3 ./token（只读解码显示）

同 r0（wire 按归档 design 附录 A 冻结；caps 位图命名展开；非法输入抛
TokenError；显式不做验签/构造）。对拍向量：cap 复用既有
CROSS_CRATE_CAP_VECTOR（crates/dweb-fabric/src/lib.rs:29）；invite 新增跨语言
向量（Rust 导出 + TS 消费）。

## 3. 与 app-protocol-layer 的共享面协议（P1-3 处置）

「文件级互不相交」修正为「源码目录不相交 + 共享文件显式 owner 协议」：

- **共享文件**：`packages/client-sdk/package.json`（exports/files）、pack
  验收脚本、exports 存在性测试。并行 change app-protocol-layer 已冻结五个
  subpath 的同文件域（其 tasks 4.2/4.6）。
- **协议**：本 change 的 tasks 2.2 明确「**rebase 后落盘**」——实现期以
  app-protocol-layer 已合入的 exports/files 快照为基线增量追加
  `./admin`/`./token`，冲突以「并集快照」解决；最终 exports 全集 =
  `.`/`./net`/`./net/internals`/`./http`/`./http/internals`/`./admin`/
  `./token`（写进本 change tasks 作为完成态断言）。pack 门禁脚本两 change
  共用同一份，后合并者负责跑通。

## 4. 测试策略

| 层 | 测试 | 性质 |
|---|---|---|
| Rust 单测 | disconnect 请求体矩阵（缺键/双键/未知字段/坏 hex→400 envelope）、restricted+无 relay 投影、open 空投影、未命中 404 envelope、回执 op3 canonical 冻结向量 | 实现门 |
| Rust e2e | restricted + 真实 relay 连接 → connections 计数 → disconnect → **有界轮询**收敛 + 回执 ServerIdentity 验签（per-target） | 实现门 |
| TS 单测 | AdminClient mock-fetch 全 code 路径（probeEnabled 判定 no-match/enabled 分流）、receiptCanonical 冻结对拍、token 解码向量 + 非法矩阵 | 实现门 |
| TS e2e | AdminClient 打真实本地 server（与 Rust e2e 同场景） | 实现门 |
| pack 门禁 | 干净目录 npm pack + 无 .node import | 实现门（CI） |
| Owner 走查 | 手册演示（curl/AdminClient 对照） | Owner 验收证据（非实现门） |

（P2-4 处置：上表「性质」列即门禁与验收证据的分界，tasks 不再混写。）

## 5. 风险与开放问题

- disconnect 响应与视图收敛间的竞态：已冻结为 best-effort + 有界轮询
  （§1.2）；响应中的 disconnected 列表 = 已下发 start_shutdown 的快照。
- AdminState 需增存 `relay_enabled`（构造期注入；main.rs 装配处一行）——
  mode 字段已存在。
- envelope 改造涉及既有 400/401 路由响应体微调（旧消费者只看 status 不看
  body，影响面零；spec 场景钉住新形态）。

## 6. 任务切分依据

Rust 面（含 wire 冻结向量导出）先行；TS 两 subpath 并行；pack 门禁与 e2e
收口在后。

## 7. r1 评审处置表

| 项 | 处置 |
|---|---|
| P0-1 回执矛盾 | canonical 统一为既有冻结布局；disconnect 复用 root 槽位承载 endpoint_id、per-target 回执；JSON snake_case + endpoint_id 字段；跨语言向量钉住（§1.2） |
| P0-2 mode 投影 | mode 取配置 + relay_enabled 独立字段；restricted+无 relay 保持 restricted（§1.2；spec 场景钉住） |
| P0-4 发布物 | files 增目录；手写 ESM+.d.ts 零构建；npm pack 双门禁（§2.1） |
| P1-1 404 判别 | error envelope 冻结 + status 探测为唯一规范判别（§1.2） |
| P1-2 收敛语义 | best-effort + 有界轮询，spec/测试同步（§1.2） |
| P1-3 共享面 | 共享文件 owner 协议 + rebase 落盘 + 最终 exports 全集断言（§3） |
| P1-4 wire 冻结 | spec 全 JSON 示例（snake_case、排序、未知字段忽略）（spec 文件） |
| P2-1 审计空洞 | per-target 回执（§1.2） |
| P2-3 status 重叠 | 分工显式化：status 冻结不动，connections 为详细视图（§1.2） |
| P2-4 证据分界 | 测试表「性质」列（§4） |

## 8. r2 评审处置表

| 项 | 处置 |
|---|---|
| r2-P0-1 ESM/.js 冲突 | `.mjs` + `.d.mts` 纯 ESM entrypoint；不改包级 type；ESM-only 契约决策（§2.1） |
| r2-P1-1 回执快照规则 | 单次 OnlineView 快照 + 展开序 + 共享 ts/generation + 空场景 receipts 必空（§1.2） |
| r2-P1-2 envelope 迁移措辞 | §1.1 改「错误 body 版本化变更」；proposal 契约影响同步 |
| r2-P1-3 probe 矩阵 | 200/404/401/其余/网络/超时 全矩阵冻结，禁止折叠（§2.2） |
| r2-P2-2 向量可复现 | fixture 文件路径 + 固定 key/ts/generation 生成规则（§2.2） |

## 9. r3 评审处置表

| 项 | 处置 |
|---|---|
| r3-P1-1 exports 残句 | 删除旧后缀句；全文统一 .mjs/.d.mts；tasks 2.2 逐字断言（§2.1） |
| r3-P1-2 probe 签名 | `Promise<true>` + 全 reject 矩阵 + `http-<status>` 入枚举（§2.2） |
| r3-P1-3 OnlineView 唯一性 | view() 改 per-(endpoint,fabric) 对 + 双键字典序 + 混 fabric 回归测试（gate.rs；§1.2/spec 同步） |
| r3-P1-4 fixture 入库 | 随仓库提交；测试缺失即败（重生成走 DWEB_REGEN_FIXTURES=1 显式门） |
