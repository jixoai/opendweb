## ADDED Requirements

### Requirement: 管理客户端 subpath（./admin）

`@jixo/opendweb-client-sdk` SHALL 提供 `./admin` subpath 导出：零 native 依赖的纯 TS `AdminClient`（Node 18+ 全局 fetch；浏览器同构可用），封装 Server 管理 API 全部路由（status/owners CRUD/connections 视图/主动断连）。客户端 MUST 以构造参数注入 `baseUrl` 与 `token`，请求自动附 Bearer 头；请求超时 MUST 可配置（默认 10s）。响应字段为冻结的 snake_case wire（server spec 全 JSON 示例）；客户端类型 MUST 忽略未知字段（不因服务端向前兼容新增字段而失败）。

错误 MUST 归一为可判别的 `AdminError`（携带 HTTP status、机器可读 code、服务端 message）。code 判别：`admin-not-enabled` MUST 经专用 `GET /admin/status` 探测判定——`probeEnabled(): Promise<true>` 仅在 200 时 resolve true，其余一律 reject AdminError，矩阵冻结为：200 = resolve true；404 = `admin-not-enabled`；401 = `unauthorized`（已挂载但凭证错，不得折叠为未启用）；502/503/任意非 200 = `http-<status>`；网络失败 = `network`；超时 = `timeout`。MUST NOT 以「404 空 body」作为唯一判别信号，MUST NOT 把任意非 200 折叠为未启用；业务未命中（disconnect no-match）以 404 + error envelope 判别；`invalid-request`（400）、`network`、`timeout` 互斥可判别。

变更类操作的返回 SHALL 包含服务端回执的结构化透出（op/fabric_id/endpoint_id 或 root/ts/generation/receipt_sig base64url），并提供 `receiptCanonical(receipt)` 助手输出与 server 侧 `receipt_canonical` 逐字节一致的待签载荷（canonical = domain||op u8||fabric 32B||target 32B||ts u64BE||generation u64BE，全大端；register/unregister 的 target=root，disconnect 的 target=endpoint——对拍测试钉住）；验签接口 MUST 为注入式（`verifyReceipt(receipt, verifier)`，包本身不引入签名依赖、不内置验签实现）。两 subpath 为**纯 ESM entrypoint**（`.mjs` + `.d.mts`，不改包级 module type，与既有 CommonJS 入口共存；ESM-only——`import` 载入，不承诺 `require()`）。subpath 的运行时依赖 MUST 为零，且 MUST NOT 传递性 import 包的 native 主入口（`.`）/`./net`/`./http`；`npm pack` 发布物 MUST 包含 `admin/`、`token/` 目录（干净目录 pack + 无 `.node` 环境 import 双门禁）。

#### Scenario: 纯 TS 环境导入可用

- **WHEN** 仅安装 `@jixo/opendweb-client-sdk` 并 `import { AdminClient } from "@jixo/opendweb-client-sdk/admin"`（ESM import），运行环境无 native binding
- **THEN** 导入成功，AdminClient 可构造并可对可达的 admin API 发起请求（pack 物含 admin/ 目录）

#### Scenario: 错误归一与判别

- **WHEN** AdminClient 访问未配置 `DWEB_ADMIN_TOKEN` 的 server 与 token 错误的 server
- **THEN** 分别得到 `admin-not-enabled`（经 status 探测判定）与 `unauthorized` 的 AdminError，code 互异且携带 status 与服务端 message

#### Scenario: status 探测矩阵

- **WHEN** probeEnabled 分别面对 200 / 404 / 401 / 502 / 网络失败 / 超时
- **THEN** 分别得到 true / admin-not-enabled / unauthorized / http-502 / network / timeout——六路互斥，无折叠

#### Scenario: 断连往返与回执对拍

- **WHEN** 调用 `disconnect({endpointId})` 命中在线端点
- **THEN** 返回断开明细与 per-endpoint 回执数组；`receiptCanonical(receipt)` 对每张回执输出与 server 侧 `receipt_canonical` 逐字节一致的待签载荷（跨语言冻结向量对拍钉住）

### Requirement: 令牌工具 subpath（./token）

`@jixo/opendweb-client-sdk` SHALL 提供 `./token` subpath 导出：`dweb2.`（InviteV2）与 `dwebr1.`（RelayCapV1）令牌的**只读解码显示**工具，纯 TS 零依赖（base64url/BE 定长字段解析，对齐 server-access-policy design 附录 A 的冻结 wire 格式）。解码结果 SHALL 覆盖：invite 的 fabricId/inviteId/issuer/recipient/expiresAtMs/relays[{url, hasCapability}]/directAddrs；capability 的 fabricId/serverId/issuer/recipient/caps 位图（命名展开）/issuedAt/expiresAt。非法输入（前缀不符/长度不符/字符集非法/保留位）MUST 抛出可判别的解析错误。解码 MUST NOT 做验签（无密钥材料；显示用途——调用方安全决策 MUST 依赖服务端验证结果而非本解码）。`npm pack` 发布物 MUST 包含 `token/` 目录；与 `./admin` 同受无 native 环境 import 门禁约束。

#### Scenario: 邀请令牌解码显示

- **WHEN** 对一张合法 `dweb2.` 邀请令牌调用解码
- **THEN** 返回 recipient（预绑定对象）、expiresAtMs、relays 列表（含是否内嵌 capability 标注）等字段，与 Rust 侧 `InviteV2Token::decode` 同源同值（冻结向量对拍）

#### Scenario: 能力令牌解码与位图展开

- **WHEN** 对一张合法 `dwebr1.` 能力令牌调用解码
- **THEN** 返回 caps 的命名展开（relay/rdzAnnounce/rdzResolve）、时间窗与绑定三元组（fabricId/serverId/issuer/recipient），与 Rust 侧 `RelayCapV1::decode` 同源同值（跨 crate 冻结向量 `CROSS_CRATE_CAP_VECTOR` 对拍）

#### Scenario: 非法输入拒绝

- **WHEN** 输入非 `dweb2.`/`dwebr1.` 前缀、长度不符或 base64url 字符集非法的串
- **THEN** 抛出带原因的解析错误，不返回部分解码结果
