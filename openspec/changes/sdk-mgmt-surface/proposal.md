# Proposal: sdk-mgmt-surface

> 原始需求输入（2026-09-22，Owner）：「接下来我们需要专注于 SDK 的提供。
> 因为别人需要基于 opendweb 来实现管理、授权的功能。」
> Owner 同期裁决：不做 Server 驻留管理台——管理动作从本地发起（WebUI/console
> 连远端 admin API，见后续 webui-console change）；本 change 是其 SDK 地基。

## Why

**「基于 opendweb 做管理/授权」目前没有可编程的消费者面。** 三层缺口：

1. **admin API 已实现但未 spec 化，且面不足以支撑管理动作。**
   Phase 3-A 落地了 `DWEB_ADMIN_TOKEN` 保护的 `/admin/*`（owners CRUD +
   status + 回执签名，crates/dweb-server/src/access/admin.rs:114-119），但
   requirement 层从未收编（server-access-policy 归档时 admin API 只存在于
   tasks.md/WALKTHROUGH.md，specs/server/spec.md 无对应 requirement）。且
   管理者真正要做的动作缺路由：**在线连接不可见**（OnlineTable 的
   per-endpoint/per-owner 视图只在 gate 内部，gate.rs:136-150）、**主动断连
   不可达**（unregister 路径里有「反查在线表逐 endpoint disconnect」的现成
   实现，admin.rs AdminState 持有 gate + relay_clients 两个句柄，但没有独立
   入口）、**配额用量不可查**（`DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER` 只能
   看配置不能看在用）。
2. **TS 侧没有 typed 管理客户端。** admin API 的消费者（CLI、WebUI、第三方
   运维工具）今天只能手写 fetch + 手拼路由。client-sdk 的 exports map
   （packages/client-sdk/package.json:8-21）只有 `.` / `./net` / `./net/internals`
   （app-protocol-layer 域），无管理面入口。
3. **owner 侧管理操作在 N-API 已齐但缺 TS 工具层。** `invite`/`join`/
   `members`/`revoke`/`ensure_relay_capabilities`/`export_secret_passphrase`
   都已暴露（packages/client-sdk/src/fabric.rs:573-672），但令牌是 287 字符
   的不透明串——第三方调用方要展示「这张邀请发给谁、何时过期、带哪条
   relay」必须解 base64url 手抠 wire 字段；dweb2. 格式在 design 附录 A 已
   冻结，纯 TS 解码显示是零成本补齐。

## What Changes

- **admin API spec 化 + 扩面**（dweb-server）：
  - ADDED requirement「Server 管理 API」收编现有面（Bearer token 挂载语义、
    owners CRUD、status、回执签名）；
  - 新增 `GET /admin/connections`（在线视图 + 配额投影；open 模式如实投影
    空集）；
  - 新增 `POST /admin/connections/disconnect`（按 endpointId 或 fabricId 主动
    断连，复用 unregister 的反查断连路径；回执 OP 扩展 0x03）。
- **client-sdk 新 subpath `./admin`**（纯 TS，零 native 依赖）：
  `AdminClient`（status/owners/connections/disconnect + Bearer 注入 + 超时 +
  错误归一 `AdminError{status, code, reason}`）与回执 canonical bytes 助手
  （验签可注入，本包不引 ed25519 依赖）。
- **client-sdk 新 subpath `./token`**（纯 TS，零 native 依赖）：
  `InviteV2Token`（dweb2.）与 `RelayCapV1`（dwebr1.）的只读解码显示
  （fabricId/issuer/recipient/expiresAt/relays/caps 位图/时间窗），与 Rust
  侧 wire 冻结向量同源对拍；不做验签（无密钥材料，显示用途）。

## 非 Goals（明确不做）

- 不动 relay 数据面 / L1/L1b/L2 验证链（server-access-policy 已冻结）。
- 不提供 Owner 自助注册（Admin 动作语义维持）。
- 不新增独立 npm 包（遵循 app-protocol-layer Owner 裁决的 subpath 形态）。
- 不在 client-sdk 引入签名/加密依赖（receipt 验签走注入式 verifier）。
- 不触碰 `./net`、`./http`、session/continuity 面（app-protocol-layer
  并行域，文件级避让）。
- WebUI 本体（sidecar/SPA/plugin 接线）→ webui-console change，本 change
  只交付其依赖的地基。

## 契约影响

- server admin API：**新增两个路由**（纯增量；既有路由零变化）。
- client-sdk exports map：新增 `./admin`、`./token` 两个 subpath（semver
  minor；`./` 与 `./net*` 不变）。
