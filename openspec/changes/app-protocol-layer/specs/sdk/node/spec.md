## ADDED Requirements

### Requirement: net / http subpath exports

`@jixo/opendweb-client-sdk` SHALL 经 package.json `exports` map 暴露子路径
（Owner 2026-09-16 裁决，不新增独立包）：

- `.` — 现有 Fabric API（identity / membership / 连接状态快照）
- `./net` — TCP/UDP 模拟原语：`SessionHandle`（state/onState/openStream/
  sendDatagram/close）
- `./net/internals` — 内部面（帧观测、journal 状态等），**semver 宽松**，
  文档显式标注不承诺跨版本兼容
- `./http` — HTTP/WS 绑定：serveHttp / fetchHttp / WS upgrade / SSE 投影
  （引擎本体在 Rust）
- `./http/internals` — 内部面，semver 宽松

TS 消费面 SHALL 只依赖 `Fabric.openSession(peerId)`（唯一会话创建入口，
Fabric 工厂级方法；幂等：active/recovering 返回既有句柄、dead/closed 新建）、
`SessionHandle`（含 `LogicalStream`（AsyncIterable body + AbortSignal 取消
语义）、`OpenStreamMeta` 类型）与会话状态，不暴露原始 `PeerDisconnected`，不提供第二套重连循环。
`/http` 的 handler 在 TS 执行（Rust↔N-API ABI 见 design.md §3.4），请求/
响应体均为流式且取消语义对称。基于 `/net` 与 internals 的 TS 自建投影为
支持的定制逃生舱，但非默认路径。

#### Scenario: 单包安装按需导入

- **WHEN** 消费者安装 `@jixo/opendweb-client-sdk` 并
  `import { fetchHttp } from "@jixo/opendweb-client-sdk/http"`
- **THEN** 无需额外扩展包；root 导入面与既有版本兼容

#### Scenario: 逃生舱定制

- **WHEN** 开发者需要非默认的 HTTP 投影策略
- **THEN** 可基于 `/net/internals` 取得帧级/流级原语自建实现，与默认
  Rust 引擎路径并存互不干扰

#### Scenario: 发布产物校验

- **WHEN** client-sdk 执行发布前检查
- **THEN** `npm pack --dry-run` 列出全部五个子路径入口（types 与运行时），
  root 面与上一版本兼容，internals 子路径文档含 semver 宽松标注

#### Scenario: 五子路径真实导入

- **WHEN** CI 对 `.`、`/net`、`/net/internals`、`/http`、`/http/internals`
  分别执行 import + require + 类型解析
- **THEN** 五个入口在 ESM/CJS/类型三层全部可用，无需额外扩展包
