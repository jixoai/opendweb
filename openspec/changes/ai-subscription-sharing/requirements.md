# Requirements: ai-subscription-sharing

## Owner 已裁决（存档）

- 「下一插件 = **AI 订阅共享（基于 ai-fly 的代码）**」（2026-10-01，W11 决策同轮）。
- [W6]（webui-plugin-kernel）：面板占位 vpn/clash/**ai**/ssh/screen——本 change
  兑现 ai 占位；其余四个占位不动。
- W11 纪律（2026-10-01，同日生效）：凭证只走 0600 文件，绝不进 argv/env/URL/
  日志——ai-fly 的 `$env` 凭证源族在移植时**移除**，收敛为 secret/file/literal。
- 内核信任模型（webui-plugin-kernel 冻结）：v1 可信插件，宿主权限内执行，
  不宣称沙箱；ai-fly 的 hook 脚本执行沿用此模型并文档明示。

## Requirements

### Requirement: 插件形态与注册（内置第四插件）

ai 插件 SHALL 以 workspace 包 `@jixo/opendweb-ext-ai` 的 `./opendweb-webui-plugin`
子路径导出 webuiApi 1 descriptor（id=`ai`；字段集按内核契约冻结），经
`builtinWebuiPluginDescriptors()` 静态注册为内置第四插件，并从
`comingSoonPlugins()` 移除 `{id:"ai"}`（其余四个占位保留）。页面 SHALL 按
视角分置：提供方控制台（admin：服务/分组/密钥/配额/用量）、消费方控制台
（member：可用目录/本地端点/钥环/写手）、目录页（member，浏览可连的共享
服务）。源码 SHALL 保留 ai-fly upstream 出处标注（文件头注释 + 包 README
致谢节）；ai-fly 仓库不因本 change 被修改。

#### Scenario: 占位替换与双视角路由

- **WHEN** admin 设备与 member 设备分别打开 webui 插件面板与 `#/p/ai/*` 路由
- **THEN** 「AI 助手」占位卡消失，出现可启停的 ai 插件；admin 看到 provider
  页组、member 看到 consumer 页组（视角过滤按 descriptor.perspective 执行）；
  未启用时路由按内核收敛语义处理

### Requirement: 提供方密钥库与服务台账（凭证纪律）

提供方 SHALL 维护 0600 密钥库 `<DWEB_HOME>/plugins/ai/secrets.json`（0700
目录、原子写 tmp+rename、无内存缓存、值 ≤8192 字符）与服务台账
`services.json` v2（服务/分组/密钥 SHA-256+固定 salt 哈希、
timingSafeEqual 常数时间校验、revision）。分组密钥（`sk-` 前缀 CSPRNG）原文
仅签发时一次性展示；管理面任何列表/详情响应 MUST NOT 含密钥原文（脱敏
投影 `●`）。撤 key MUST 实时生效（KeySessionIndex 定位持钥会话：refresh
重算或断开）。

#### Scenario: 撤钥即时生效

- **WHEN** 提供方撤掉某 key，消费方持该 key 的既有会话与新请求并发到达
- **THEN** 新请求被拒（明确 401 语义）；既有在途请求按流完成或被断开
  （二选一，design 冻结）；目录/授权缓存刷新后该 key 一切面失效

### Requirement: 上游预设与凭证注入（auth 槽三族）

ai 插件 SHALL 内置 ai-fly 的上游预设表（providers.json 18 项 + models.dev
长尾目录，数据面原样移植）与 hooks 管线（四阶段：入站剥离 → auth 解析 →
headers 变换 → onRequest/onResponse 脚本）。auth 槽 SHALL 仅支持
`{secret:<name>}`（密钥库引用）、`{script:<name>,args}`、`{literal:<值>}`
（仅 `$secret:` 间接引用）三族——**`$env` 引用族 MUST NOT 存在**（W11 收敛，
构造期拒绝）。消费方入站凭据头（authorization/proxy-authorization/cookie）
MUST 在协议层剥离；提供方出站头集经防护头再过滤。SSR 纵深沿用 ai-fly：
上游 URL 仅来自本地服务配置、origin 双重断言、路径白名单（未声明路径 404
`path_not_offered`，防 /user、/balance 等个人信息端点被提供方凭证打穿）。
codex 预设 MUST 复用 ai-fly 的 OAuth 只读 hook（`~/.codex/auth.json` 只读、
永不写凭据文件、chatgpt-account-id 等 codex CLI 同款头集）。

#### Scenario: $env 凭证源被拒绝（W11）

- **WHEN** 服务配置的 auth literal 写 `$env:MY_KEY` 或任何 env 间接引用形态
- **THEN** 保存被拒（明确错误指回 secret/file 族）；存量配置升级路径中
  `$env` 条目按 design 的迁移规则处置（不静默保留可用）

#### Scenario: 个人信息端点白名单

- **WHEN** 消费方经本地端点请求预设未声明的路径（如 `/user`、`/balance`）
- **THEN** 404 `path_not_offered`——请求不触达上游，提供方凭证零 exposure

### Requirement: 消费方本地回环网关

消费方 SHALL 为每个已授权服务在本机起独立 `127.0.0.1` HTTP listener
（ports 插件同款纪律：仅回环、端口冲突真实 listen + 明确报错不静默换端口），
路由为预设白名单映射（localPrefix→upstreamPrefix，如 `/codex`→
`/backend-api/codex`）。跨设备数据 MUST 经 fabric 会话 `/wpk1/ai/v1/*`
（见 wire requirement），不经 sidecar 控制面。本地端点收到请求后：剥离
消费方凭据头 → 组装 wpk1 请求帧 → 流式回收响应 → SSE 逐块透传。WebSocket
透传 v1 MUST NOT 宣称支持（面板列「即将推出」）。agent 配置写手（codex
`~/.codex/config.toml`、claude-code `~/.claude/settings.json`）MUST 两段式
preview→diff 确认（sha256 token）→apply；写入的本地 token 一律占位符。

#### Scenario: 本地端点等价直连

- **WHEN** 消费方把 agent 的 base URL 指向本地端点并发起 OpenAI/Anthropic
  兼容请求（含 SSE 流式）
- **THEN** 响应（状态码/头/流式块序）等同消费方直连上游——差异仅限：凭据
  头替换为提供方注入、路由白名单外 404、配额/限流错误为 OpenAI 风格 error
  JSON（`rate_limited`/`quota_exceeded`）

### Requirement: wire 协议（/wpk1/ai/v1/*）

跨设备面 SHALL 冻结为版本化前缀 `/wpk1/ai/v1/`：`POST auth`（钥环校验 →
授权目录 + 密钥指纹）、`GET catalog`（目录快照；变更经目录推送/长轮询 <
30s 收敛）、`POST request`（请求转发：路径白名单校验 → auth 槽解析 →
上游转发 → **增量响应帧序列**）。帧语义沿用 ai-fly wire（REQ/RESP/ServiceEntry
schema 移植）。包络：请求体 MUST ≤1MiB 单帧（静态分块，与 ports/files 同
包络；超限 413）；响应 MUST 为增量帧序列（单帧 ≤1MiB、按会话在飞预算流控
背压、**不设单请求全程字节上限**——LLM 长响应合法）；并发按分组 maxConcurrency
预算（拨号前检查，超限 `rate_limited`）；取消 MUST 双向传播（本地断开→
fabric abort→上游 signal）。wpk1 gate 授权模型 MUST 沿用内核 deny-by-default
（peer×plugin×操作）叠加 ai 层密钥校验（两层都要过）。

#### Scenario: 长流式响应不触顶

- **WHEN** 一次 completion 响应持续产出超过内核「单流 2MiB」名义预算的总量
- **THEN** 响应以增量帧序列完整送达（每帧 ≤1MiB、在飞预算内背压）——总量
  不构成拒绝理由；断线时按 fabric 恢复窗口语义（90s）续传或明确失败，绝不
  静默截断成「成功」

#### Scenario: 双层准入

- **WHEN** 已入 fabric 的 peer（设备邀请有效）持错误 key 请求 `/wpk1/ai/v1/request`
- **THEN** fabric gate 放行（peer 合法）但 ai 层 401（key 错）——两层独立
  校验，任一失败即拒绝；错误响应不泄露哪层失败以外的信息（key 指纹除外）

### Requirement: 配额、限流与用量审计

提供方 SHALL 执行 ai-fly 配额模型：分组 maxConcurrency（在途请求计数）与
按 key 的 dailyRequests（UTC 日界重置、`quota-day.json` 0600 原子持久化）；
超限返回 OpenAI 风格 `rate_limited`/`quota_exceeded`。usage 审计
（`usage.jsonl` 0600）MUST 仅记元数据（ts/keyId/serviceId/status/bytes），
MUST NOT 记录请求/响应正文与凭证；默认关闭，启用需显式配置。

#### Scenario: 日配额边界

- **WHEN** 某 key 当日请求数达到 dailyRequests 上限后再次请求；UTC 日界翻越后再次请求
- **THEN** 达限后 `quota_exceeded`（现有在途请求完成）；日界翻越后配额重置
  可用；重启不丢失当日已用计数（持久化）

### Requirement: rust-fetch sidecar 分发（codex 预设）

codex 预设的 Cloudflare 旁路（rustls 出站 sidecar，stdio JSON 协议、凭证经
stdin 管道不进 argv）SHALL 随包分发（vendored 二进制模式参照
@jixo/opendweb-server-binary 先例；darwin-arm64 首发，win32 跟随 CI）。sidecar
缺失/不可执行时 codex 预设 MUST 显式降级（面板与请求错误均明示
`rust_fetch_unavailable`），MUST NOT 静默失败或伪装成功。

#### Scenario: sidecar 缺失显式降级

- **WHEN** 二进制缺失或执行失败时选择 codex 预设并发起请求
- **THEN** 明确错误（`rust_fetch_unavailable` + 指引）；其余预设不受影响；
  面板预设状态如实呈现

### Requirement: 安全基线（W11 继承）

全链路 MUST 满足：分组密钥/上游密钥/OAuth 登录态不出现在 argv、env、URL
（含 query）、日志、浏览器可达状态、wpk1 帧明文外的任何面；分享链接
（邀请+密钥信封）与密钥原文仅一次性展示（终端/面板 copy field），不落日志；
usage/错误帧/目录披露全部脱敏（错误文案不含脚本路径与密钥名）。hook 脚本
以宿主同权限执行（信任模型文档明示）；`~/.codex/auth.json` 严格只读。

#### Scenario: 泄露面扫描（测试断言）

- **WHEN** 全链路 e2e（auth/请求/撤钥/配额/错误路径）后扫描进程 argv、
  env、日志文件、usage.jsonl、sidecar stderr
- **THEN** 零密钥原文/密钥指纹外凭证出现；错误响应与目录投影均为脱敏形态
