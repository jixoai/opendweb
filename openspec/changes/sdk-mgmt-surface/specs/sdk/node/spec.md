## ADDED Requirements

### Requirement: 管理客户端 subpath（./admin）

`@jixo/opendweb-client-sdk` SHALL 提供 `./admin` subpath 导出：零 native 依赖的纯 TS `AdminClient`（Node 18+ 全局 fetch；浏览器同构可用），封装 Server 管理 API 全部路由（status/owners CRUD/connections 视图/主动断连）。客户端 MUST 以构造参数注入 `baseUrl` 与 `token`，请求自动附 Bearer 头；请求超时 MUST 可配置（默认 10s）。错误 MUST 归一为可判别的 `AdminError`（携带 HTTP status、机器可读 code、服务端 reason 文本），404-no-admin（未配置 token 的 server）与 401（凭证错误）MUST 是互斥可判别的 code。变更类操作的返回 SHALL 包含服务端回执的结构化透出（op、fabric、ts、generation、签名 hex），并提供 canonical bytes 助手与**注入式**验签接口（`verify(receipt, verifier)`，包本身不引入签名依赖、不内置验签实现）。subpath 的运行时依赖 MUST 为零（打包产物不携带 native binding）。

#### Scenario: 纯 TS 环境导入可用

- **WHEN** 仅安装 `@jixo/opendweb-client-sdk` 并 `import { AdminClient } from "@jixo/opendweb-client-sdk/admin"`，运行环境无 native binding
- **THEN** 导入成功，AdminClient 可构造并可对可达的 admin API 发起请求

#### Scenario: 错误归一与判别

- **WHEN** AdminClient 访问未配置 `DWEB_ADMIN_TOKEN` 的 server（404）与 token 错误的 server（401）
- **THEN** 分别抛出 code 互异的 AdminError（如 `admin-not-enabled` / `unauthorized`），错误对象携带 status 与服务端 reason（若有）

#### Scenario: 断连往返

- **WHEN** 调用 `disconnect({endpointId})` 命中在线端点
- **THEN** 返回断开明细与回执对象；`receiptCanonical(receipt)` 输出与 server 侧 `receipt_canonical` 逐字节一致的待签载荷（对拍测试钉住）

### Requirement: 令牌工具 subpath（./token）

`@jixo/opendweb-client-sdk` SHALL 提供 `./token` subpath 导出：`dweb2.`（InviteV2）与 `dwebr1.`（RelayCapV1）令牌的**只读解码显示**工具，纯 TS 零依赖（base64url/BE 定长字段解析，对齐 server-access-policy design 附录 A 的冻结 wire 格式）。解码结果 SHALL 覆盖：invite 的 fabricId/inviteId/issuer/recipient/expiresAtMs/relays[{url, hasCapability}]/directAddrs；capability 的 fabricId/serverId/issuer/recipient/caps 位图（命名展开）/issuedAt/expiresAt。非法输入（前缀不符/长度不符/字符集非法/保留位）MUST 抛出可判别的解析错误。解码 MUST NOT 做验签（无密钥材料；显示用途——调用方安全决策 MUST 依赖服务端验证结果而非本解码）。

#### Scenario: 邀请令牌解码显示

- **WHEN** 对一张合法 `dweb2.` 邀请令牌调用解码
- **THEN** 返回 recipient（预绑定对象）、expiresAtMs、relays 列表（含是否内嵌 capability 标注）等字段，与 Rust 侧 `InviteV2Token::decode` 同源同值（冻结向量对拍）

#### Scenario: 能力令牌解码与位图展开

- **WHEN** 对一张合法 `dwebr1.` 能力令牌调用解码
- **THEN** 返回 caps 的命名展开（relay/rdzAnnounce/rdzResolve）、时间窗与绑定三元组（fabricId/serverId/issuer/recipient），与 Rust 侧 `RelayCapV1::decode` 同源同值（跨 crate 冻结向量 `CROSS_CRATE_CAP_VECTOR` 对拍）

#### Scenario: 非法输入拒绝

- **WHEN** 输入非 `dweb2.`/`dwebr1.` 前缀、长度不符或 base64url 字符集非法的串
- **THEN** 抛出带原因的解析错误，不返回部分解码结果
