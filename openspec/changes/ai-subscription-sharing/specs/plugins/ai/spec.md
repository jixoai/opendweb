# plugins/ai delta —— ai-subscription-sharing

## ADDED Requirements

### Requirement: AI 订阅共享插件（提供方/消费方双姿态）

ai 插件 SHALL 以 workspace 包 `@jixo/opendweb-ext-ai` 注册为 webui 内置第四
插件（webuiApi 1，id=`ai`），替换 `comingSoonPlugins()` 的 `{id:"ai"}` 占位
（其余 vpn/clash/ssh/screen 保留）。提供方（admin 视角）SHALL 维护 0600
密钥库 `<DWEB_HOME>/plugins/ai/secrets.json`（0700 目录/原子写/无内存缓存/
值 ≤8192 字符）与服务台账 `services.json` v2（服务/分组/密钥 SHA-256+固定
salt 哈希、timingSafeEqual、revision、raw key 可选存储——ai-fly 上游 Owner
裁决 2026-09-13 沿用），内置 ai-fly 上游预设表 **17 项**（codex 条目占位
`requires:"ai-codex-oauth"` 不激活）+ models.dev 长尾与 hooks 四阶段管线。
auth 槽 SHALL 仅 `{secret}|{script,args?}|{literal}`（+可选 bearer；literal
间接引用仅 `$secret:`）；**`$env` 引用族与 env.cjs MUST NOT 存在**（凭证
判定线=值进入上游请求头/体；CODEX_HOME 类运行时 env 不受限）；ai-fly 配置
导入 MUST 两阶段 staging（机器可读 blocked 清单、安全条目不激活、映射后
一次性 commit、禁止 env 自动快照）。消费方（member 视角）SHALL 为每授权
服务起独立 `127.0.0.1` HTTP listener（仅回环；端口冲突真实 listen 明确
报错；路由=预设白名单映射，未声明路径 404 `path_not_offered` 不触达上游），
入站凭据头（authorization/proxy-authorization/cookie）MUST 协议层剥离；
claude-code 写手 MUST preview→diff 确认（sha256 token）→apply 且本地 token
一律占位符；WebSocket 透传 v1 MUST NOT 宣称支持。撤钥三态 SHALL 冻结
（①单 key 撤销+session 另有有效 key=新请求 403 `auth_failed`、在途 drain；
②session 全钥失效=drain deadline 5s 内 settle/abort（`auth_revoked`）后断
fabric 会话；③peer 被 gate 撤销=gate 拒新 404 同体、在途随会话关闭），
maxConcurrency 占位在流 terminal 即释放。raw key/密钥原文远程面（wire 响应/
日志/目录披露/usage）恒 `●` 掩码，webui 本地管理面（回环+Host/Origin 守卫
内）MAY 显式复制；分享链接沿用 `aifly1.` 信封（一邀请+一密钥），可复用已存
raw key 再生成。

#### Scenario: 双姿态同机共存

- **WHEN** 同一设备既是某服务提供方又导入朋友的服务（消费方）
- **THEN** provider wpk 面与 consumer 本地端点互不干扰并存；停用插件时两者
  一并按四步序收敛（端点全关、在途上游 abort）

#### Scenario: $env 拒绝与两阶段导入

- **WHEN** auth literal 写 `$env:MY_KEY`；或导入含 `$env` 条目的 ai-fly 配置
- **THEN** 前者构造期拒绝（指回 secret/script）；后者 staging 返回完整
  blocked 清单、零部分激活、映射前服务不可用、commit 后全量生效；任何
  路径都无 env 值自动落盘

#### Scenario: 白名单外路径零触达

- **WHEN** 持有效 key 的消费方请求预设未声明路径（如 `/user`、`/balance`）
- **THEN** 404 `path_not_offered`，不触达上游，提供方凭证零 exposure

#### Scenario: 撤钥三态

- **WHEN** 三态分别发生且各有在途与并发新请求
- **THEN** 按冻结语义收敛（①403+drain；②5s deadline+`auth_revoked`+断会话；
  ③404 同体+随会话关闭）；占位即时释放

### Requirement: ai wire ABI（/wpk1/ai/v1/*）与响应中继状态机

跨设备面 SHALL 冻结 JSON-over-HTTP ABI：`POST auth`（`{v:1,keys:[≤8]}`→
200 目录+keyId+catalogRev | 403 `auth_failed`）、`GET catalog?since=<rev>`
（≤30s 长轮询；204 无变化/200 全量）、`POST request`（JSON 元数据+raw body
≤`maxChunkPayload` → 200 `{responseId,epoch,status,headers}` 元数据帧；
404 `path_not_offered`/429 `rate_limited|quota_exceeded`）、`POST
response/<rid>`（`{epoch,fromSeq}`→raw 单分片+`x-odai-seq|x-odai-done|
x-odai-lease-ms|x-odai-next-seq` 头；404 `response_not_found|
response_expired`）、`POST cancel`（幂等）。serviceId 路由头 `x-odai-service`
提供端剥离绝不透传上游；gate op 名 `ai/v1/{auth,catalog,request,response,
cancel}`（版本随前缀）。**gate 错误面**：gate 失败一律 `404 {error:
"not_found"}` 固定同体（与未知路径 byte 级一致）、不解析 key；`path_not_
offered` 仅 gate+key 双过后可出现。**预算**：`maxChunkPayload=1MiB−4KiB`
（编码后落帧 ≤1MiB 恒成立）；每 wpk1 调用独立流（内核 2MiB/流 8MiB/session
天然覆盖）；请求体超限 413；admission：在途上游 ≤maxConcurrency（默认 8、
域 1–32）且 ring 总量（=maxConcurrency×2MiB）≤64MiB 超积工厂期拒启。**中继
状态机**：`allocated→producing→（ready(seq)→leased→committed）→done`；
终态 done|cancelled|expired 由 terminal arbiter 单点互斥裁决（先到定终态、
后到幂等重放）；responseId=`<epoch>:<单调号>`（重启换 epoch、旧 rid 一律
404 不复用不复活；跨重启重放经 `{serviceId,method,path,bodyHash}` 幂等键
识别存活 rid）；分片幂等键 `(epoch,rid,seq)` 同键同内容重放；拉取租约 30s
（到期回 ready、fromSeq 推进=隐式提交释放 ring 槽）；TTL=绝对 deadline
（元数据帧+120s、活动续期至最后活动+120s；到期先 abort 上游再 expired 并
释放占位）；满 buffer=上游读暂停背压、TTL 为有界终止无死锁路径；取消双向
传播（本地断开→cancel→上游 abort）。SSE=字节流透明中继（保序/零丢失/零
重复，不做事件对齐）；延迟目标（双机 LAN e2e p95 断言）：元数据帧 ≤600ms
（不含上游 TTFB）、首分片 ≤300ms（自上游首字节）、后续分片间 ≤150ms；
断线/过期/竞态 MUST 显式错误，MUST NOT 静默截断成成功。

#### Scenario: 长流式响应不触顶（5MiB SSE）

- **WHEN** 单响应总量超内核单流名义预算（5MiB SSE 流）
- **THEN** 分片完整送达（≤maxChunkPayload/租约推进/零重复零丢失/保序）；
  无「成功但少字节」路径；延迟目标 p95 达标

#### Scenario: 竞态与恢复矩阵

- **WHEN** 满 buffer×0/1/2 并发拉；cancel×done 交叉；租约过期重拉；TTL 到期
  仍 producing；provider 重启换 epoch；断线 90s 内恢复
- **THEN** 按状态机终态收敛：背压不死锁、先到终态幂等、过期重拉同内容、
  TTL 先 abort、旧 rid 404、续拉零重复零丢失（seq 严格连续）

#### Scenario: 双层准入错误矩阵

- **WHEN** 未知 peer / 合法 peer 未授权 op / gate 过+错 key / 双过+白名单外路径
- **THEN** 前二者与未知路径 `404 {error:"not_found"}` byte 级同体；第三
  `403 auth_failed`；第四 `404 path_not_offered`（仅双过后可出现）

### Requirement: ai 配额、限流与用量审计

提供方 SHALL 执行分组 maxConcurrency（在途计数、拨号前检查、超限 429
`rate_limited`）与按 key dailyRequests（UTC 日界重置、`quota-day.json` 0600
原子持久化、重启不丢当日计数、超限 429 `quota_exceeded`）；错误为 OpenAI
风格 error JSON。usage 审计 `usage.jsonl`（0600）默认关闭、显式启用，仅记
`ts/keyId/serviceId/status/bytes` 元数据，MUST NOT 记录正文与凭证。全链路
（argv/凭证 env/URL/日志/浏览器状态/usage/错误帧/目录披露）MUST 零密钥
原文与指纹外凭证（e2e 后扫描断言）；错误文案 MUST NOT 含脚本路径与密钥名。

#### Scenario: 配额持久化与日界重置

- **WHEN** key 当日达限→再请求；provider 重启→再请求；UTC 日界翻越→再请求
- **THEN** 达限 `quota_exceeded`；重启同日计数仍在；日界翻越后恢复

#### Scenario: 泄露面扫描（e2e 断言）

- **WHEN** 全链路 e2e（auth/请求/撤钥三态/配额/错误路径）后扫描两机 argv、
  env、日志、usage.jsonl、sidecar stderr、浏览器可达状态
- **THEN** 零命中（掩码投影与密钥指纹除外）
