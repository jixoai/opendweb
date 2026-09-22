# @jixo/opendweb-client-sdk

dweb 应用层 fabric SDK for Node。根入口（`.`）、`./net`、`./http` 为
CommonJS + napi-rs native binding；本 README 说明纯 TS 的两个 ESM subpath
（sdk-mgmt-surface 起）：

- **`./admin`** — dweb-server 管理 API（`/admin/*`）客户端：owner 注册表、
  在线视图、主动断连，Bearer 注入 + 回执 Ed25519 验签。
- **`./token`** — 邀请/能力令牌只读解码（显示用途）。

两 subpath 零运行时依赖、不加载包内 native binding（与 root/`./net`/`./http`
互不引用），浏览器同构可用（`./admin` 需全局 fetch）。

## ESM-only 契约

`./admin` 与 `./token` 是纯 ESM entrypoint（`.mjs` + `.d.mts`）：以 `import`
载入；**不承诺 `require()`**（Node 22 起 require(ESM) 才可用）。包级无
`"type": "module"`，与既有 CommonJS 入口共存。

```js
// ESM（支持）
import { AdminClient } from "@jixo/opendweb-client-sdk/admin";
import { decodeInvite } from "@jixo/opendweb-client-sdk/token";

// CommonJS（不支持，Node 22 前抛 ERR_REQUIRE_ESM）
// require("@jixo/opendweb-client-sdk/admin"); // ✗
```

## `./admin` — Server 管理 API 客户端

管理面挂载条件：dweb-server 以非空 `DWEB_ADMIN_TOKEN` 启动才挂载 `/admin/*`
（否则 probeEnabled 探测为 `admin-not-enabled`）。

### 用法

```js
import { AdminClient, AdminError } from "@jixo/opendweb-client-sdk/admin";

const admin = new AdminClient({
  baseUrl: "http://127.0.0.1:8080", // dweb-server gateway 地址
  token: process.env.DWEB_ADMIN_TOKEN, // 见「admin token 安全注意」
  timeoutMs: 10_000, // 默认 10s（AbortSignal.timeout）
});

// 管理面启用探测（仅 200 才 resolve true——见下方矩阵）
await admin.probeEnabled(); // → true

// 在线详细视图：mode / relay_enabled 独立字段 + quota 结构 + per_endpoint / per_owner
const view = await admin.connections();
// { mode: "restricted", policy: "static", relay_enabled: true,
//   quota: { configured: true, max_connections_per_owner: 8 },
//   per_endpoint: [{ endpoint_id, fabric_id, connections }], per_owner: [...] }

// owner 注册表（fabric_id 与 root 均 64-hex）
const owners = await admin.listOwners();
const receipt = await admin.registerOwner(fabricIdHex, rootIdHex);
await admin.unregisterOwner(fabricIdHex, rootIdHex); // 注销回执带 kicked_* 计数

// 主动断连：endpointId / fabricId 恰好其一（两者同给或缺省 → invalid-request）
// best-effort：响应报告「已下发」，最终收敛用 connections() 有界轮询确认
const { disconnected, receipts } = await admin.disconnect({ endpointId: hex64 });
// 或 await admin.disconnect({ fabricId: hex64 });
```

### `probeEnabled()` 探测矩阵

`Promise<true>`——仅探测到 200 时 resolve `true`，**不存在 false 返回值**；
其余一律 reject `AdminError`：

| 服务端响应 | 结果 |
| --- | --- |
| `200` | resolve `true` |
| `404` | reject `code: "admin-not-enabled"`（未配置 `DWEB_ADMIN_TOKEN`，`/admin/*` 未挂载） |
| `401` | reject `code: "unauthorized"`（已挂载但凭证错——**不是** not-enabled） |
| 其它任意非 200（502/503/未知 5xx…） | reject `code: "http-<status>"` |
| fetch 传输层失败（连接拒绝/DNS…） | reject `code: "network"`（`status: null`） |
| 超时 | reject `code: "timeout"`（`status: null`） |

探测判别的是路由存在性而非 body 形态——经反代剥 body 的部署下依然成立。
注意 `admin-not-enabled` 的 404 判别**只属于 `probeEnabled()`**：其余方法的
任意非 200 不折叠（无 envelope 时兜底 `http-<status>`）。

### `AdminError` code 表

`AdminError extends Error`，携带 `{ code, message, status }`（网络/超时/本地
前置校验时 `status: null`）：

| code | status | 语义 |
| --- | --- | --- |
| `admin-not-enabled` | 404 | 管理面未挂载（仅 `probeEnabled()` 判定） |
| `unauthorized` | 401 | Bearer 缺失/错误 |
| `invalid-request` | 400 或 `null` | 请求体约束违反/hex 非法（服务端 400 envelope；客户端本地前置校验为 `null`） |
| `no-match` | 404 | disconnect 目标不在在线表快照 |
| `network` | `null` | 传输层失败 |
| `timeout` | `null` | 超时（`AbortSignal.timeout`） |
| `http-<status>` | 任意 | 非 200 且无 envelope 的兜底（如代理剥 body 的空 404/502） |
| `invalid-response` | 2xx | 2xx 但 body 非 JSON（防御性；正常服务端不产生） |
| （其它） | — | 服务端 envelope 的 code 原样透传（如 500 `registry`） |

### 回执验签（`receiptCanonical` + `verifyReceipt` + node:crypto 注入）

注册/注销/断连的成功响应都带回执 `Receipt`（`{op, fabric_id, root | endpoint_id,
ts, generation, receipt_sig}`）。包本身不引入签名依赖——`verifyReceipt` 为
注入式验签，公钥 = gateway 公告的 services.json 里的 `server_id`（Ed25519
verifying key，`adminPublicKeyFromServices` 提取）：

```js
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import {
  adminPublicKeyFromServices,
  verifyReceipt,
} from "@jixo/opendweb-client-sdk/admin";

// 1) 公钥：services.json 的 server_id（hex64；入参为 JSON 文本或已解析对象均可）
const servicesText = await (await fetch(`${baseUrl}/services.json`)).text();
const serverIdHex = adminPublicKeyFromServices(servicesText);

// 2) 注入式验签：verifier 收 (canonical 103B, sig 64B)——这里用 node:crypto
const key = createPublicKey({
  key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), // Ed25519 SPKI DER 前缀
    Buffer.from(serverIdHex, "hex"),
  ]),
  format: "der",
  type: "spki",
});
const verifier = (message, signature) =>
  ed25519Verify(null, Buffer.from(message), key, Buffer.from(signature));

// 3) 验证回执（register / unregister / disconnect 的 per-target 回执同款）
const receipt = await admin.registerOwner(fabricIdHex, rootIdHex);
if (!(await verifyReceipt(receipt, verifier))) {
  throw new Error("receipt 验签失败——响应不可信");
}
```

待签载荷由 `receiptCanonical(receipt)` 输出（103B 冻结布局：
`b"dweb/admin-receipt/v1\0" || op u8 || fabric_id 32B || target 32B ||
ts u64BE || generation u64BE`，与 dweb-server `admin.rs` 逐字节一致；
register/unregister 的 target = root，disconnect 的 target = endpoint_id）。
调用方自带 @noble/ed25519 等其它验签库时，直接把该函数喂给
`verifyReceipt(receipt, verifier)` 即可。

## `./token` — 邀请/能力令牌只读解码

面向展示层（UI 列出邀请内容、运维查看能力位）的 wire 层解码，camelCase
字段展开：

```js
import {
  decodeInvite,
  decodeCapability,
} from "@jixo/opendweb-client-sdk/token";

// 邀请令牌（"dweb2." + base64url）
const invite = decodeInvite(inviteTokenString);
// → { fabricId, inviteId, issuer, expiresAtMs, recipient,
//     relays: [{ url, capability, hasCapability }],
//     directAddrs: ["203.0.113.7:4333", "[2001:db8::1]:4333"] }

// 能力令牌（"dwebr1." + base64url）——caps 位图命名展开
const cap = decodeCapability(relayCapTokenString);
// → { fabricId, serverId, issuer, recipient, capsBits,
//     caps: { relay, rdzAnnounce, rdzResolve },
//     issuedAt, expiresAt, signature } // signature: hex128（未验证，原样透出）
```

非法输入（坏前缀/长度/字符集/保留位/计数超限/截断/尾随字节等）抛可判别的
`TokenError { code, message }`，不返回部分解码结果。

**解码不验签**：本解码器无密钥材料，只做 wire 层解析——不做签名验证、不做
内嵌 capability 的语义一致性校验（recipient 绑定 / expires ≤ invite 等）。
调用方的**安全决策 MUST 依赖服务端验证结果**（dweb-server 的验证链），
不得以本解码输出作为准入依据；解码结果仅用于显示。

## admin token 安全注意

`DWEB_ADMIN_TOKEN` 是管理面的唯一凭证（Bearer，服务端常量时间比较）——
泄露即放开 owner 注册表与断连动作。处理建议：

- **不进 argv**：`--token` 类参数对 `ps` 可见、进 shell history；SDK 侧同样
  不要把 token 写进日志或错误信息（`AdminClient` 构造后 token 为私有字段，
  `AdminError` 不携带 token）。
- **不进 CI/部署明文**：CI 日志、环境 dump、制品清单都会留痕；用 secret
  注入并限制掩码范围。
- **env 有 OS 级可见性**：`DWEB_ADMIN_TOKEN` 环境变量可被同用户进程读取，
  只是把可见面从 argv 收窄，不是消除。
- **推荐形态：本地 sidecar 注入**（参考 `@jixo/opendweb-webui`
  `packages/webui`）：token 获取链为 CLI `--token` > 环境变量
  `DWEB_ADMIN_TOKEN` > 终端隐藏输入，取到后**只驻 sidecar 进程内存**——
  不落盘、不进浏览器、不进日志；sidecar 仅绑定 `127.0.0.1`，对远端
  dweb-server 做 Bearer 注入 + `/admin/` 前缀白名单反向代理。浏览器/脚本
  只与本机 sidecar 通信，永远接触不到 token 本体。
