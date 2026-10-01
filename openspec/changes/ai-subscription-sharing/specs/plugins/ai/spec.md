# plugins/ai delta —— ai-subscription-sharing

## ADDED Requirements

### Requirement: AI 订阅共享插件（提供方/消费方双姿态）

ai 插件 SHALL 以 workspace 包 `@jixo/opendweb-ext-ai` 注册为 webui 内置第四
插件（webuiApi 1，id=`ai`），替换 `comingSoonPlugins()` 的 `{id:"ai"}` 占位
（其余 vpn/clash/ssh/screen 保留）。提供方（admin 视角）SHALL 维护 0600 密钥库
`<DWEB_HOME>/plugins/ai/secrets.json`（0700 目录/原子写/无内存缓存/值
≤8192 字符）与服务台账 `services.json`（服务/分组/密钥 SHA-256+salt 哈希、
timingSafeEqual 校验、revision），内置 ai-fly 上游预设表（18 项 + models.dev
长尾）与 hooks 管线；auth 槽 SHALL 仅 `{secret}|{script}|{literal}`（literal
间接引用仅 `$secret:`）三族，`$env` 形态构造期拒绝、`hooks/env.cjs` 不存在
（W11 收敛）；存量 ai-fly 配置导入遇 `$env` 条目 MUST 整体失败并列出全部
条目（指引转 secret，不做 env 自动快照）。消费方（member 视角）SHALL 为每
授权服务起独立 `127.0.0.1` HTTP listener（仅回环；端口冲突真实 listen 明确
报错不静默换端口；路由=预设白名单映射，未声明路径 404 `path_not_offered`
不触达上游），消费方凭据头（authorization/proxy-authorization/cookie）
MUST 协议层剥离；agent 配置写手（codex/claude-code）MUST preview→diff 确认
（sha256 token）→apply 且本地 token 一律占位符；WebSocket 透传 v1 MUST NOT
宣称支持（面板「即将推出」）。撤 key MUST drain 语义（新请求 401、在途按流
完成）；分组密钥 `sk-` 前缀 CSPRNG 原文仅签发一次性展示；管理面列表/详情/
目录披露 MUST NOT 含密钥原文（`●` 脱敏）。rust-fetch sidecar 随包分发
（vendored 二进制，server-binary 先例）；缺失时 codex 预设 MUST 显式降级
`rust_fetch_unavailable`，MUST NOT 静默失败；`~/.codex/auth.json` 严格只读。

#### Scenario: 双姿态同机共存

- **WHEN** 同一台设备既是某服务的提供方又导入朋友的服务（消费方）
- **THEN** provider wpk 面与 consumer 本地端点互不干扰地并存（数据目录/端口
  /账本独立），停用插件时两者一并按四步序收敛

#### Scenario: $env 拒绝与存量导入失败

- **WHEN** auth literal 写 `$env:MY_KEY`；或从 ai-fly 导入含 `$env` 条目的
  services.json
- **THEN** 前者构造期拒绝（明确错误指回 secret/file）；后者导入整体失败并
  逐条列出（服务名/字段/引用名），零部分导入

#### Scenario: 白名单外路径零触达

- **WHEN** 消费方经本地端点请求预设未声明路径（如 `/user`、`/balance`）
- **THEN** 404 `path_not_offered`，请求不触达上游，提供方凭证零 exposure

#### Scenario: rust-fetch 缺失显式降级

- **WHEN** vendored 二进制缺失/不可执行时使用 codex 预设
- **THEN** 面板与请求错误均明示 `rust_fetch_unavailable`；其余预设不受影响

### Requirement: ai wire 面（/wpk1/ai/v1/*）与响应中继

跨设备面 SHALL 冻结 `/wpk1/ai/v1/`：`POST auth`（key→授权目录+密钥指纹+
catalog revision）、`GET catalog?since=<rev>`（快照+长轮询 ≤30s）、`POST
request`（REQ 帧→上游转发→立即返回 `{responseId, status, headers}` 元数据
帧）、`POST response/<responseId>/<seq>`（**响应分片拉取**：每次独立完整
wpk1 请求 ≤1MiB，落在内核 v1 包络内；响应总量无上限）、`POST
response/<responseId>/cancel`（取消传播→上游 abort）。wpk1 gate（peer×plugin
×op deny-by-default）与 ai 层密钥校验 MUST 双层独立通过；请求体 ≤1MiB 静态
分块（超限 413）；provider 端 response ring buffer MUST 有界（默认 2MiB/
请求）且缓冲满 MUST 暂停读上游（背压）、浅 MUST 恢复；在飞拉取窗并发 ≤2；
responseId 跨 fabric 恢复窗口（90s）存活（provider TTL 120s，超时显式失败
帧）；SSE chunk 即事件块边界（本地端点收到即 flush，首 chunk 立发、后续
min(256KiB|50ms|上游块边界) 攒批）；分组 maxConcurrency（默认 8，域 1–128）
计在途上游请求；断线/超时/缓冲失效 MUST 显式错误，MUST NOT 静默截断成成功。

#### Scenario: 长流式响应不触顶（>4MiB）

- **WHEN** 一次 completion 响应总字节超过内核单流名义预算（如 5MiB SSE 流）
- **THEN** 经分片拉取完整送达消费方本地端点并逐块 flush；总量不构成拒绝
  理由；无任何「成功但少字节」路径（截断=显式错误）

#### Scenario: 背压与恢复

- **WHEN** 消费方拉取慢于上游产出（ring buffer 满）；或拉取中途 fabric 断线
  90s 内恢复
- **THEN** 前者上游读暂停、缓冲浅恢复（上游不被无界缓冲拖死，零数据丢失）；
  后者同 responseId 续拉（零重复 chunk、零丢失 chunk，seq 严格连续）

#### Scenario: 双层准入独立失败

- **WHEN** fabric peer 合法但 key 错；或 key 对但 gate 未授权该 peer
- **THEN** 分别 401（ai 层）与 gate 层拒绝——错误面不泄露失败层以外的信息

### Requirement: ai 配额、限流与用量审计

提供方 SHALL 执行分组 maxConcurrency（在途计数、拨号前检查、超限
`rate_limited`）与按 key dailyRequests（UTC 日界重置、`quota-day.json` 0600
原子持久化、重启不丢当日计数、超限 `quota_exceeded`）；错误 MUST 为 OpenAI
风格 error JSON。usage 审计 `usage.jsonl`（0600）MUST 默认关闭、显式启用，
仅记 `ts/keyId/serviceId/status/bytes` 元数据，MUST NOT 记录正文与凭证；全
链路（argv/env/URL/日志/浏览器状态/usage/错误帧/目录披露）MUST 零密钥原文
与密钥指纹外的凭证（e2e 后扫描断言）；错误文案 MUST NOT 含脚本路径与密钥名。

#### Scenario: 配额持久化与日界重置

- **WHEN** key 当日用量达限→继续请求；重启提供方→再请求；UTC 日界翻越→再请求
- **THEN** 达限 `quota_exceeded`；重启后计数仍在（同日继续拒绝）；日界翻越
  后配额恢复

#### Scenario: 泄露面扫描（e2e 断言）

- **WHEN** 全链路 e2e（auth/请求/撤钥/配额/错误路径/rust-fetch 路径）后扫描
  两机进程 argv、env、日志文件、usage.jsonl、sidecar stderr、浏览器可达状态
- **THEN** 零命中（脱敏投影与密钥指纹除外）
