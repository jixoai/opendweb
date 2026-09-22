## ADDED Requirements

### Requirement: 本地管理 sidecar（token 边界与同源代理）

`opendweb-webui` 包 SHALL 提供本地管理 sidecar：Node 进程内以 `node:http` 启动 HTTP 服务，绑定 `127.0.0.1`（默认随机空闲端口，`--port` 可指定），托管预构建的 SPA 静态资源。sidecar SHALL 将浏览器同源请求 `/api/*` 反向代理到配置目标（target）的远端 admin base URL，并由 sidecar 注入 `Authorization: Bearer` 头——**admin token MUST 只存在于 sidecar 进程内存**（MUST NOT 写入任何文件、MUST NOT 出现在发往浏览器的任何响应/资源/日志中）。代理面 MUST 仅允许 `/admin/` 前缀的 GET/POST/DELETE 方法（非通用代理）；MUST NOT 跟随重定向、MUST NOT 读取环境代理变量。sidecar MUST 零运行时依赖（node 标准库 + 预构建静态资源）。

**目标（target）生命周期**：目标 server URL 与 token 在 sidecar 生命周期内**一经设定即冻结**（重新指向 = 重启 sidecar）。设定途径：(a) 启动参数 `--server`/`--token`（token 另有 env `DWEB_ADMIN_TOKEN` 与 TTY 交互输入两条途径）；(b) **setup 模式**——未传 `--server` 启动时 sidecar 进入 setup 模式（业务 `/api/*` 一律 503 no-target），浏览器经配对面提交目标与 token。配对面（`/sidecar/connect`，与 `/api/*` 代理命名空间**物理分离**的本地路由）MUST 同时满足以下防线才接受提交：(1) **一次性配对码**——sidecar 启动时在终端打印的随机码（单次有效，首次成功或超时即失效；仅出现在终端，不进任何 HTTP 面）；(2) Host 头校验（必须等于 `127.0.0.1:<port>`，防 DNS rebinding）；(3) Origin 校验（同源或缺失）。配对成功后目标冻结、配对码立即失效。

**明文远端守卫**：目标 URL MUST 为绝对 `http(s)` URL（解析后拒绝 dot-segment/编码斜杠路径段）；`http` scheme 时主机名 MUST 解析为 loopback（解析一次并按解析 IP 连接，防 rebinding；`localhost` 与 `127.0.0.0/8`/`::1` 视为 loopback），否则拒绝启动——除非显式 `--allow-insecure`（终端横幅 + UI 顶栏双重持续告警；该 flag 仅放宽传输加密，MUST NOT 放宽目标与路径校验）。

**token 途径的 OS 可见性披露**：`--token` flag 与 env 途径在帮助文本与使用文档中 MUST 标注其 OS 级可见性（shell history / ps / 环境读取）；推荐途径为 TTY 交互输入或 setup 配对面。

#### Scenario: token 不落浏览器

- **WHEN** sidecar 运行中，浏览器开发者工具检视任意页面资源、网络响应与 sidecar 日志
- **THEN** admin token 不出现在任何位置；`/api/*` 请求由浏览器发出时不携带 Authorization 头（由 sidecar 注入后转发）

#### Scenario: 配对码防外站提交

- **WHEN** 攻击者网页（evil.com）向 `http://127.0.0.1:<port>/sidecar/connect` 直接 POST 目标+token 配置
- **THEN** 被 Origin 校验拒绝；伪造/缺失配对码被拒绝；即便通过 header 校验，无终端打印的一次性配对码无法提交成功

#### Scenario: 并发配对单飞

- **WHEN** 两个请求以同一有效配对码并发提交 `/sidecar/connect`（目标校验含 DNS 解析的让出窗口）
- **THEN** 恰一个成功（200）；另一个返回 409 + `{"error":{"code":"pairing-in-progress"}}`；配对码不被双消费，目标不重复提交

#### Scenario: 目标冻结

- **WHEN** 目标已设定后，任何 `/sidecar/*` 或浏览器途径再次提交新目标
- **THEN** 返回错误（target-frozen），不改写目标；重新指向需重启 sidecar

#### Scenario: 明文远端默认拒绝与 rebinding 防护

- **WHEN** 目标为 `http://203.0.113.10:18787`（非 https 非 loopback）且未传 `--allow-insecure`
- **THEN** sidecar 拒绝启动并输出告警；`http://attacker.example`（域名解析非 loopback）同样拒绝；传 `--allow-insecure` 后启动，横幅与 UI 顶栏持续显示明文告警

#### Scenario: 绑定面锁定本机

- **WHEN** sidecar 启动
- **THEN** 监听地址为 127.0.0.1，非本机不可访问

#### Scenario: 入站路径越界零出站

- **WHEN** 以原始 HTTP 请求行（绕过浏览器 URL 规范化的 raw fixture）请求 `/api/../status`、`/api/%2e%2e/status`、`/api/a%2fb`、`/api//x`、`/api/x/` 等含 dot-segment/编码分隔符/空段/重复斜杠的路径
- **THEN** 全部返回 404 且 sidecar **不向上游发出任何请求**（以假上游零收包断言）；拼接后最终远端 pathname 必须再次断言以 `/admin/` 开头

#### Scenario: 上游响应超限的失败 wire

- **WHEN** 上游响应 body 超过 1 MiB
- **THEN** sidecar abort 上游连接（socket 回收，假上游不再被读写）并返回 502 + `Content-Type: application/json` + `{"error":{"code":"upstream-too-large","message":"…"}}` envelope

#### Scenario: 请求体超限的失败 wire

- **WHEN** 浏览器请求 body 超过 64 KiB
- **THEN** sidecar 拒收（不向上游发送）并返回 413 + `Content-Type: application/json` + `{"error":{"code":"request-too-large","message":"…"}}` envelope

#### Scenario: 逐请求连接不跨目标复用

- **WHEN** 代理连续向同一目标发出多个请求（含一请求 abort）
- **THEN** 每请求独立新建连接（禁用连接池复用），响应结束或 abort 即销毁 socket——以 keep-alive 不跨请求存活断言

#### Scenario: token 不入 help 与错误输出

- **WHEN** `opendweb webui --help` 或任一 CLI 错误路径（坏 URL/坏端口/代理失败）执行且 token 已传入
- **THEN** 输出（help golden/错误信息）不含 token 值；`--token value` 与 `--token=value` 两形态解析均正确

#### Scenario: UI 失败态矩阵呈现

- **WHEN** SPA 的 apiFetch 注入层分别返回 not-enabled / unauthorized / http-502 / network / timeout / no-match 六类错误
- **THEN** 各对应视图呈现语义化提示（not-enabled→配置指引、unauthorized→重启换 token 指引等），无未捕获异常与错误风暴；setup 态业务请求呈现「未连接」引导

### Requirement: CLI 面接线（plugin 契约与一键启动）

`opendweb-webui` SHALL 通过 `./opendweb-plugin` 子路径导出符合 CLI 插件契约的清单（`webui` 命令，args JSON Schema 声明 `--server/--token/--port/--allow-insecure/--no-open`，均为既有契约的 string/number/boolean 子集——不扩展插件契约；URL/端口/互斥等语义校验由命令实现自担，进入 run 前后均可校验）。`run` 收到契约既定的 dispatch envelope `{command, args, log, cwd, stdout, stderr}`。`opendweb webui …` 经 marketplace 自适应解析直达（候选 `opendweb-webui` 命中默认 glob `npm:opendweb-*`；自愈安装语义沿用 marketplace spec）。命令启动 sidecar 后 SHALL 打印本地访问 URL（setup 模式同时打印一次性配对码）；默认在可打开浏览器的环境下自动打开（`--no-open` 关闭；headless/失败仅打印 URL 不报错）。`--token` 的 help 文本 MUST 标注 OS 可见性与推荐替代途径。缺省 `--server` = setup 模式（非错误）。

#### Scenario: 零安装直达

- **WHEN** 未安装任何插件的用户执行 `opendweb webui --server https://srv.example:18787`
- **THEN** CLI 按 marketplace 声明序自愈安装 `opendweb-webui` 并派发命令，sidecar 启动打印 URL（与 marketplace spec 自愈场景一致，过程对用户可见）

#### Scenario: help 零执行与安全提示

- **WHEN** `opendweb webui --help`
- **THEN** 输出基于清单 args 声明的用法说明（含 --token 可见性提示），不执行 sidecar 业务代码

#### Scenario: 缺省 server 进入 setup 模式

- **WHEN** 启动未传 `--server`
- **THEN** sidecar 以 setup 模式启动并打印访问 URL 与一次性配对码；业务 `/api/*` 返回 503（no-target）；UI 呈现配对面

### Requirement: Server 管理视图（本 change 唯一视图面）

SPA SHALL 提供 Server 管理功能，全部经 sidecar `/api/*`（底层为 `./admin` AdminClient 同构调用）：连接状态（目标 URL 展示、`/admin/status` 总览 mode/policy/generation/owner 数）、owners 列表/注册/注销（变更回执的 op/ts/generation/签名摘要展示）、在线连接表（per-endpoint/per-owner 投影 + 配额在用/上限，有界轮询刷新）、主动断连（二次确认对话；结果与 per-target 回执展示）。断连等变更动作 MUST 有明确的二次确认；UI MUST NOT 提供任何数据面授权判断入口（不自注册、不发数据面凭证）。**Owner 控制台（本地 fabric 数据面管理）不在本 change 范围**——另行立项（webui-owner-console）。

#### Scenario: 注册 Owner 全流程

- **WHEN** 在 UI 填入 fabric_id/root 提交注册
- **THEN** owners 列表即时更新并展示回执摘要；对应远端 `GET /admin/owners` 一致

#### Scenario: 断连二次确认与回执

- **WHEN** 对一个在线 endpoint 点击断连
- **THEN** 弹出确认对话（展示目标 endpoint 与连接数）；确认后以有界轮询观测在线表收敛并展示 per-target 回执

#### Scenario: 无目标时的业务面语义

- **WHEN** setup 模式下 UI 请求任意业务数据
- **THEN** 呈现「未连接」引导至配对面，不出现错误风暴
