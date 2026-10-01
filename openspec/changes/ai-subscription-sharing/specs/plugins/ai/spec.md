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
间接引用仅 `$secret:`）；**凭证 env 三面全闭**：`$env:` 形态与 env.cjs
MUST NOT 存在（声明面）、hook 子进程仅接收净化 env（非凭证 allowlist）且
auth 路径 `process.env` fallback MUST 删除（脚本面）、预设 `keyEnv` 降为
UI 提示且服务激活前 MUST 绑定 secret 名（预设面；未绑定不可启用）；凭证
判定线=值进入上游请求头/体；CODEX_HOME 类运行时 env 不受限；「env 中存有
等值 secret 但请求不得携带」为必有负向测试。ai-fly 配置导入 MUST 两阶段
staging（机器可读 blocked 清单、安全条目不激活、映射后一次性 commit、禁止
env 自动快照）。消费方入站凭据头（authorization/proxy-authorization/cookie）
MUST 协议层剥离；上游 URL 仅来自本地服务配置、origin 双重断言、路径白名单
（未声明路径 404 `path_not_offered` 不触达上游）。claude-code 写手 MUST
preview→diff 确认（sha256 token）→apply 且本地 token 一律占位符；WebSocket
透传 v1 MUST NOT 宣称支持。请求/拉取 MUST 绑定 `x-odai-key-id`（quota/
usage/撤钥按 keyId 判定；在途 rid 授权=request 时刻快照——撤钥不撕已在途
流）。撤钥三态 SHALL 冻结（①单 keyId 撤销+session 另有有效 key=该 keyId
新 request `403 {code:"key_revoked"}`、在途 rid 按创建时快照续拉 drain；②session 全钥失效=drain
deadline 5s 内 settle/abort（`auth_revoked`）后断 fabric 会话——**有意分歧
声明**：ai-fly 即时 disconnect，本 v1 加 5s 有界 drain；③peer 被 gate 撤销
=gate 拒新、在途随会话关闭），maxConcurrency 占位在流终态即释放。消费方
（member 视角）SHALL 为每授权服务起独立 `127.0.0.1` HTTP listener（仅回环；
端口冲突真实 listen 明确报错；路由=预设白名单映射），SSE=字节流透明中继
（保序/零丢失/零重复，不做事件对齐；延迟目标双机 LAN e2e p95：元数据帧
≤600ms 不含上游 TTFB、首分片 ≤300ms、后续分片间 ≤150ms）。raw key/密钥原文远程面（wire 响应/
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

### Requirement: ai wire ABI（/wpk1/ai/v1/*，header framing）与响应中继状态机

跨设备面 SHALL 冻结 **header framing ABI**（与内核 OPEN metadata+DATA 投影
逐层对齐：ai 层元数据全部走 `x-odai-*` HTTP 头、body=纯载荷字节，无
multipart/metadata-in-body）：`POST auth`（`{v:1,keys:[≤8]}`→200 **多 key**
`{v:1,status:"ok",groups:[{keyId,group,limits:{maxConcurrency?,dailyRequests?},
services:[ServiceEntry]}]（≥1）,rejected?:[{code:"key_invalid"|"key_revoked"}]}`
——与 ai-fly frames.ts AUTH_OK 同型（rejected 仅 code；有效键集合=groups[].
keyId）| 全错 `403 {v:1,code:"key_all_invalid"}`）、`GET catalog?since=<rev>`
（**hold ≤20s**（对齐 CATALOG_WATCH_TIMEOUT_MS，严小于内核 head deadline
30s）；204 无变化/200 全量；全量 ≤256 服务且 JSON ≤256KiB，超配工厂期
拒绝）、`POST request`（头 `x-odai-service`[唯一来源，body/query 同名
信息=400]/`x-odai-method`/`x-odai-path`/`x-odai-key-id`/`x-odai-headers`
[≤4KiB]；raw body ≤`maxChunkPayload` → 200 `{responseId,epoch,status,
headers}`；404 `path_not_offered`/429 `rate_limited|quota_exceeded`/413
超限/400 `metadata_too_large`）、`POST response/<rid>`（头 `x-odai-key-id`/
`x-odai-from-seq`；就绪=200 raw 单分片+`x-odai-seq|x-odai-done|
x-odai-next-seq`；未就绪=**204 hold ≤20s** 后返回重试；终态=摘要 200 零
body；`fromSeq≠committedSeq+1`=409 `invalid_from_seq`；同 rid 并发第二拉取
=409 `pull_in_flight`；404 `response_not_found|response_expired`）、`POST
cancel`（幂等终态重放）。ai 元数据头合计 ≤8KiB（超限 400）。**gate 范围**：
内核 wpk router 语义不改（unknown-plugin 404/plugin-disabled 503）；ai
handler 内部 peer 未授权/op 未授权/未知子路径→一律 `404 {error:"not_found"}`
byte 级同体、不解析 key；`path_not_offered` 仅双过后可出现（内核 op-aware
gate 列 follow-up）。**预算**：`maxChunkPayload=1MiB−16KiB`（推导=ai 头
8KiB+OPEN metadata 4KiB+分片头 1KiB+定界 1KiB 取整；编码后落帧 ≤1MiB 恒
成立）；每调用独立流（内核 2MiB/流 8MiB/session 覆盖）；admission：在途
上游 ≤maxConcurrency（默认 8、域 1–32）且活跃 ring（=maxConcurrency×2MiB）
≤64MiB 超积工厂期拒启；终态摘要 LRU 独立 ≤4MiB。**中继状态机**：
`allocated→producing→（ready(seq)→in-flight→committed）→done`；全部转移
（produce/cancel/expiry/commit/拉取）在 per-rid 互斥锁内；**单飞拉取**；
**连续提交游标 committedSeq**（**初值 −1——首个合法 fromSeq=0、首片 seq=0；
EOF 空流=零分片+立即 done 摘要**；拉取必须 fromSeq=committedSeq+1——无 seq
空洞、无提前释放；提交=下次拉取推进或终态确认）；responseId=`<epoch>:
<单调号>`（epoch=启动 CSPRNG）；**幂等仅同进程**（(epoch,rid,seq) 同键同
内容；重启→全部在途 rid 404，跨重启重放不支持——非幂等上游 POST 重复执行
风险由消费端重试策略自担并文档明示；持久化幂等账本列 follow-up）；空闲
TTL=最后 200 拉取+120s（204 hold 不续期）；**绝对寿命=创建+10min 硬上界**
（到点未终态即 expired，先 abort 上游再释放占位）；done 后 body 分片即弃
（仅摘要可重放，旧 seq 不可再拉）；满 buffer=上游读暂停背压、绝对寿命为
有界终止无死锁路径；取消双向传播。SSE=字节流透明中继（保序/零丢失/零
重复，不做事件对齐）；延迟目标（双机 LAN e2e p95 断言）：元数据帧 ≤600ms
（不含上游 TTFB）、首分片 ≤300ms（自上游首字节）、后续分片间 ≤150ms；
断线/过期/竞态 MUST 显式错误，MUST NOT 静默截断成成功。

#### Scenario: 长流式响应不触顶（5MiB SSE）

- **WHEN** 单响应总量超内核单流名义预算（5MiB SSE 流）
- **THEN** 分片完整送达（≤maxChunkPayload/committedSeq 连续推进/零重复零
  丢失/保序）；无「成功但少字节」路径；延迟目标 p95 达标

#### Scenario: 竞态与恢复矩阵

- **WHEN** 满 buffer×0/1 拉取（并发第二拉取）；fromSeq 越过 committedSeq；
  首片 fromSeq=0（cursor 初值 −1）；204 hold 期间产出分片；**hold 20s vs
  内核 head deadline 30s 边界**；cancel×done 交叉；空闲 TTL 过期；绝对寿命
  10min 到点仍 producing；done 后再拉旧 seq；EOF 空流；provider 重启换
  epoch；断线 90s 内恢复；**撤钥后在途 rid 续拉（正例）**
- **THEN** 按状态机终态收敛：并发第二拉取 409 `pull_in_flight`、越前 409
  `invalid_from_seq`、hold 醒来即返回新分片、先到终态幂等、到期先 abort
  上游再 expired、done 后旧 seq 不可再拉（摘要 only）、重启后旧 rid 404、
  续拉零重复零丢失（committedSeq 连续推进）

#### Scenario: 双层准入错误矩阵

- **WHEN** ai handler 内：peer 未授权 / op 未授权 / 未知子路径 / 双过+错
  keyId / 双过+白名单外路径
- **THEN** 前三者与未知路径 `404 {error:"not_found"}` byte 级同体；第四
  `403 {code:"key_revoked"}`；第五 `404 path_not_offered`（仅双过后可出现）；内核
  插件级响应（unknown-plugin 404/plugin-disabled 503）保持现状不属本矩阵

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
