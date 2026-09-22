# Proposal: webui-console

> 原始需求输入（2026-09-22，Owner）：「我们 opendweb 自身是不是要提供一个
> 简单的 webui，正好我们自己有 plugin 体系，用这个来实现一个 webui，在
> webui 里面配置 服务器、密钥，从而实现管理。」
> Owner 裁决（同日）：**不做 Server 驻留管理台**——「我更倾向于我自己本地
> 在 webui 就可以管理云端的 server」。plugin 体系用于**分发与启动**（分发
> 通道复用 marketplace 自愈安装），而非 WebUI 的宿主框架。

## Why

**管理动作今天只有 curl。** sdk-mgmt-surface 交付后，admin API 与 TS 客户端
齐了，但 Owner 日常动作（看在线、注册/注销 owner、踢连接、发邀请）仍要
手敲 curl + 手拼 hex——「在 webui 里面配置服务器、密钥」是把这些动作变成
表单和按钮。

**本地 sidecar 是唯一同时满足安全与部署形态的挂载点**（Owner 裁决的直接
推论）：

- server 驻留管理台 = 给 dweb-server 加静态托管 + CORS + 浏览器持 token
  （XSS 即 owns server）——**否决**；
- 纯浏览器 SPA 直连远端 admin API = token 落浏览器 + CORS 开洞——**否决**；
- **本地 sidecar**：Node 进程托管 UI + 同源反代远端 admin API，Bearer token
  只存在于 sidecar 进程内存，浏览器永远不见 token；`opendweb webui` 一条
  命令起（marketplace 自愈安装 `npm:opendweb-*` glob 直接命中），管理
  云端 server 与管理本地无差别。

## What Changes

- **新包 `opendweb-webui`**（unscoped——命中 marketplace 默认 glob
  `npm:opendweb-*`；提供 `./opendweb-plugin` 子路径导出 → `opendweb webui`
  自愈安装后直达）：
  - **sidecar**（node:http，零运行时依赖）：绑定 `127.0.0.1`（默认随机
    空闲端口），托管预构建 SPA 静态资源；`/api/*` 同源反代到 `--server`
    指定的远端 admin base URL 并注入 Bearer（token 来自 `--token` flag /
    `DWEB_ADMIN_TOKEN` env / 交互式输入，**不落盘、不进浏览器**）；
  - **CLI 面**（plugin 契约，不扩展契约——校验自担）：`opendweb webui
    [--server URL] [--token T] [--port N] [--allow-insecure] [--no-open]`；
  - **目标生命周期**：目标 URL + token 一经设定即冻结（重指向 = 重启）；
    缺省 `--server` 进入 setup 模式（终端打印一次性配对码，浏览器经
    `/sidecar/connect` 三重防线——配对码 + Host + Origin——完成配对）；
  - **明文远端告警**：目标非 https 且非 loopback（按 DNS 解析判定）时，
    sidecar 默认拒绝启动，`--allow-insecure` 显式放行后横幅 + UI 顶栏双重
    持续告警（token 走明文公网 = 凭证暴露）；
  - **Server 管理视图**（SPA，Phase A）：连接配置页（server URL + token
    输入，token 仅驻 sidecar）、status 总览、owners 注册/注销（回执展示）、
    在线连接表 + 配额、主动断连（确认对话 + 回执展示）。
- **Owner 控制台拆出**：本地 fabric 数据面管理（成员/邀请/撤销/
  capability 视图）不在本 change——独立 change `webui-owner-console`
  登记（未排期；前置 = 本 change + sidecar 本地数据面 JSON 契约冻结）。

## 非 Goals（明确不做）

- server 进程内静态托管 / CORS / WebSocket 推送（轮询足够）。
- 浏览器持有或持久化 admin token（token 边界钉死在 sidecar）。
- Owner 自助注册、数据面授权判断进 UI（UI 是 admin API 的视图，不新增
  授权语义）。
- 多 server 聚合管理、RBAC、审计存储（后续按需立项）。
- 移动端适配。

## 依赖

- **依赖 sdk-mgmt-surface**：`./admin`（typed 客户端）、`./token`（令牌
  展示）、`GET /admin/connections` + disconnect 路由。实现顺序上本 change
  排在其后。
