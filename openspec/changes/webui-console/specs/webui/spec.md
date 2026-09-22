## ADDED Requirements

### Requirement: 本地管理 sidecar（token 边界与同源代理）

`opendweb-webui` 包 SHALL 提供本地管理 sidecar：Node 进程内以 `node:http` 启动 HTTP 服务，绑定 `127.0.0.1`（默认随机空闲端口，`--port` 可指定），托管预构建的 SPA 静态资源。sidecar SHALL 将浏览器同源请求 `/api/*` 反向代理到 `--server` 指定的远端 admin base URL，并由 sidecar 注入 `Authorization: Bearer` 头——**admin token MUST 只存在于 sidecar 进程内存**（来源：`--token` flag、`DWEB_ADMIN_TOKEN` env、或交互式输入；MUST NOT 写入任何文件、MUST NOT 出现在发往浏览器的任何响应/资源/日志中）。sidecar MUST 零运行时依赖（node 标准库 + 预构建静态资源；`@jixo/opendweb-client-sdk` 仅 Owner 控制台视图需要，作为 optional/peer 语义按需加载）。远端 base URL 为非 https 且非 loopback 时，sidecar MUST 拒绝启动，除非显式传入 `--allow-insecure`（横幅与 UI 顶栏双重明文告警）。

#### Scenario: token 不落浏览器

- **WHEN** sidecar 运行中，浏览器开发者工具检视任意页面资源、网络响应与 sidecar 日志
- **THEN** admin token 不出现在任何位置；`/api/*` 请求由浏览器发出时不携带 Authorization 头（由 sidecar 注入后转发）

#### Scenario: 明文远端默认拒绝

- **WHEN** `--server http://203.0.113.10:18787`（非 https 非 loopback）且未传 `--allow-insecure`
- **THEN** sidecar 拒绝启动并输出告警说明（token 将明文过公网）；传 `--allow-insecure` 后启动，横幅与 UI 顶栏持续显示明文告警

#### Scenario: 绑定面锁定本机

- **WHEN** sidecar 启动
- **THEN** 监听地址为 127.0.0.1，非本机不可访问

### Requirement: CLI 面接线（plugin 契约与一键启动）

`opendweb-webui` SHALL 通过 `./opendweb-plugin` 子路径导出符合 CLI 插件契约的清单（`webui` 命令，args JSON Schema 声明 `--server/--token/--port/--allow-insecure/--no-open/--data-dir`），使 `opendweb webui …` 经 marketplace 自适应解析直达（候选 `opendweb-webui` 命中默认 glob `npm:opendweb-*`；自愈安装语义沿用 marketplace spec）。命令启动 sidecar 后 SHALL 打印本地访问 URL；默认在可打开浏览器的环境下自动打开（`--no-open` 关闭；headless/失败仅打印 URL 不报错）。`--data-dir` 指定时启用 Owner 控制台视图（Phase B）；未指定时仅 Server 管理视图（Phase A），UI 相应隐藏不可用入口（不报错）。

#### Scenario: 零安装直达

- **WHEN** 未安装任何插件的用户执行 `opendweb webui --server https://srv.example:18787`
- **THEN** CLI 按 marketplace 声明序自愈安装 `opendweb-webui` 并派发命令，sidecar 启动打印 URL（与 marketplace spec 自愈场景一致，过程对用户可见）

#### Scenario: help 零执行

- **WHEN** `opendweb webui --help`
- **THEN** 输出基于清单 args 声明的用法说明，不执行 sidecar 业务代码（plugin 契约既有语义）

#### Scenario: 无 data-dir 的降级视图

- **WHEN** 启动未传 `--data-dir`
- **THEN** UI 呈现 Server 管理视图，Owner 控制台入口隐藏（非报错态）

### Requirement: Server 管理视图（Phase A）

SPA SHALL 提供 Server 管理功能，全部经 sidecar `/api/*`（底层为 `./admin` AdminClient 同构调用）：连接配置（server URL；token 输入仅提交给 sidecar，刷新后不回显）、`/admin/status` 总览（mode/policy/generation/owner 数）、owners 列表/注册/注销（变更回执的 op/ts/generation/签名摘要展示）、在线连接表（per-endpoint/per-owner 投影 + 配额在用/上限）、主动断连（二次确认对话；结果与回执展示）。断连等变更动作 MUST 有明确的二次确认；UI MUST NOT 提供任何数据面授权判断入口（不自注册、不发数据面凭证）。

#### Scenario: 注册 Owner 全流程

- **WHEN** 在 UI 填入 fabric_id/root 提交注册
- **THEN** owners 列表即时更新并展示回执摘要；对应远端 `GET /admin/owners` 一致

#### Scenario: 断连二次确认与回执

- **WHEN** 对一个在线 endpoint 点击断连
- **THEN** 弹出确认对话（展示目标 endpoint 与连接数）；确认后在线表收敛并展示回执

### Requirement: Owner 控制台视图（Phase B）

SPA SHALL 在 `--data-dir` 指定时提供 Owner 控制台：sidecar 进程经 `@jixo/opendweb-client-sdk` native binding 打开（root 身份）或附加（成员身份）本地 fabric 数据面，提供成员名册视图、邀请签发（ttl/recipient 表单；签发结果经 `./token` 解码展示 recipient/过期时间/relay 列表与 capability 有无）、成员撤销（二次确认）、relay capability 视图（own/member 票的到期时间与剩余 TTL，即将过期高亮）。数据面私钥与成员身份操作 MUST 留在 sidecar 进程内；UI 仅呈现结果与发起确认。

#### Scenario: 签发邀请并解码展示

- **WHEN** Owner 在控制台填写 TTL 与 recipient 提交签发
- **THEN** 展示完整邀请令牌（可复制）与其解码摘要（recipient/过期/relay 与内嵌 capability 标注），摘要与 `./token` 解码结果一致

#### Scenario: 即将过期能力高亮

- **WHEN** 成员/own capability 剩余 TTL 低于 7 天
- **THEN** capability 视图对应条目高亮提示联系 Owner 续发（或 root 自签），不自动续期
