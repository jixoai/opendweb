# Requirements: ai-subscription-sharing

## Owner 已裁决（存档）

- 「下一插件 = **AI 订阅共享（基于 ai-fly 的代码）**」（2026-10-01）。
- [W6] 占位兑现：本 change 替换 `{id:"ai"}`；vpn/clash/ssh/screen 不动。
- W11 纪律（2026-10-01）：凭证不进 argv/env/URL/日志——**凭证 env 引用族
  移除**（`$env:`、env.cjs）；运行时配置 env（CODEX_HOME 类）不属凭证。
- ai-fly 上游 Owner 裁决沿用（2026-09-13）：分组密钥 raw 原文**可选落
  services.json**（0600；本机明文与密钥库同威胁模型）；远程面恒掩码。
- r1 评审征询项采纳（Codex 2026-10-01）：①密钥/链接语法保持 ai-fly
  （`sk-aifly-`/`aifly1.`）；②v1 响应中继，不向内核提案预算豁免；③codex
  OAuth+rust-fetch 拆后续 change `ai-codex-oauth`。
- 内核信任模型：v1 可信插件（宿主权限执行，不宣称沙箱），文档明示。

## Requirements

### Requirement: 插件形态与注册（内置第四插件）

ai 插件 SHALL 以 workspace 包 `@jixo/opendweb-ext-ai` 的 `./opendweb-webui-plugin`
子路径导出 webuiApi 1 descriptor（id=`ai`），经 `builtinWebuiPluginDescriptors()`
静态注册，并从 `comingSoonPlugins()` 移除 `{id:"ai"}`。页面按视角分置：
provider（admin：服务/分组/密钥/配额/用量）、consumer（member：目录/本地
端点/钥环/写手）。源码 SHALL 保留 ai-fly upstream 标注；ai-fly 仓库不被
修改。configSchema=`{maxConcurrency,dailyRequests,usageLog}`，域 1–32 /
0–1_000_000 / bool，且 `maxConcurrency×perRequestBuffer(2MiB) ≤64MiB`
超积 MUST 工厂期拒绝启动。

#### Scenario: 占位替换与双视角路由

- **WHEN** admin 与 member 设备分别打开插件面板与 `#/p/ai/*`
- **THEN** 「AI 助手」占位消失；admin 见 provider 页组、member 见 consumer
  页组（perspective 过滤）；未启用按内核收敛语义处理

### Requirement: 提供方密钥库与服务台账（raw key 对齐上游裁决）

提供方 SHALL 维护 0600 密钥库 `secrets.json`（0700 目录/原子写/无内存缓存/
值 ≤8192 字符）与服务台账 `services.json` v2（服务/分组/密钥 SHA-256+固定
salt 哈希、timingSafeEqual、revision、**raw key 可选存储**——上游 Owner
裁决 2026-09-13）。分组密钥 `sk-aifly-` CSPRNG；**远程面**（wire 响应/日志/
目录披露/usage）MUST NOT 含密钥原文（`●` 掩码）；webui 本地管理面（回环+
Host/Origin 守卫内）MAY 显式复制。分享链接沿用 `aifly1.` 信封语法（一邀请
+一密钥）；链接再生成可复用已存 raw key。撤钥三态 SHALL 冻结（粒度=keyId，
绑定见 wire requirement）：①单 keyId 撤销且 session 另有有效 key——该
keyId 新 request `403 {code:"key_revoked"}`（**在途 rid 按创建时授权快照
续拉至终态——response 拉取不因撤钥 403，仅新 request/新 rid 被拒**）；
②session 全钥失效
——drain deadline 5s（settle 或 abort，错误码 `auth_revoked`）后断开该
fabric 会话（**有意分歧声明**：ai-fly 即时 disconnect，本 v1 加 5s 有界
drain）；③peer 被 gate 撤销——gate 拒新、在途随会话关闭收敛。
maxConcurrency 占位在流终态即释放（不等 TTL）。

#### Scenario: 撤钥三态

- **WHEN** 分别发生①②③三态且各有在途请求与并发新请求
- **THEN** ①新 request `403 {code:"key_revoked"}`、在途 rid 按快照续拉完成；
  ②5s 内在途 settle/abort
  （`auth_revoked`）后会话断开；③新请求 404 同体、在途随会话关闭；三态
  占位即时释放（后续请求不受已撤流配额拖累）

### Requirement: 上游预设与凭证注入（auth 三族+env 二分法）

SHALL 内置 ai-fly 预设表 **17 项**（codex 条目占位 `requires:"ai-codex-oauth"`
不随包激活）+ models.dev 长尾，与 hooks 管线（四阶段）。auth 槽 SHALL 仅
`{secret:<name>} | {script:<name>,args?} | {literal:<v>}`（+可选 bearer；
literal 间接引用仅 `$secret:`）——**凭证 env 四面防线**：①声明面 `$env:`
形态与 env.cjs MUST NOT 存在（声明面）；②脚本面=v1 hook 为**宿主进程内
require()**（内核可信插件信任模型——hook 与宿主同权限、可读 process.env
与 secrets.json，**本 change 不宣称防御恶意 hook**，文档明示），保证=
auth 路径 `process.env` fallback MUST 删除+auth 槽三族是凭证进入上游请求
的唯一通道；③预设面 `keyEnv` 降为 UI 提示，服务激活前 MUST 绑定 secret 名
（未绑定不可启用）；④**ambient env 防绕（fail-closed，两个时点）**：检测
时机=provider 启动时**与每次服务新增/启用/预设或 keyEnv 变更/staging
commit**（管理面原子变更内）——已启用（或将启用）服务的预设 keyEnv 名单
变量存在于进程环境→启动时拒绝启动、运行时原子拒绝该变更（列明
变量名+指引转 secret 槽；不剥离值）；「provider 已运行时再启用带 keyEnv
的服务（环境中存在该变量）」为必有负向测试。凭证判定
线=值进入上游请求头/体；CODEX_HOME 类运行时 env 不受限（「env 中存有等值
secret 但请求不得携带」为必有负向测试）。消费方入站凭据头
（authorization/proxy-authorization/cookie）MUST 协议层剥离；上游 URL 仅
来自本地服务配置、origin 双重断言、路径白名单（未声明路径 404
`path_not_offered` 不触达上游）。ai-fly 配置导入 SHALL 两阶段：staging 扫描
返回机器可读 `{blocked:[{service,field,ref}]}`（安全条目不激活）→ 用户完成
$env→secret 映射后一次性 commit；**MUST NOT 做 env 自动快照**。

#### Scenario: $env 拒绝与两阶段导入

- **WHEN** auth literal 写 `$env:MY_KEY`；或导入含 `$env` 条目的 ai-fly 配置
- **THEN** 前者构造期拒绝；后者 staging 返回完整 blocked 清单、零部分激活；
  映射完成前该服务不可用；commit 后全量生效

#### Scenario: 白名单外路径零触达

- **WHEN** 持有效 key 的消费方请求预设未声明路径（如 `/user`、`/balance`）
- **THEN** 404 `path_not_offered`，不触达上游，提供方凭证零 exposure

### Requirement: 消费方本地回环网关

消费方 SHALL 为每授权服务起独立 `127.0.0.1` HTTP listener（仅回环；端口
冲突真实 listen 明确报错；路由=预设白名单映射），凭据头协议层剥离，跨设备
数据经 `/wpk1/ai/v1/*`（见 wire requirement）。SSE=**字节流透明中继**（保序/
零丢失/零重复；不做事件边界对齐——事件完整性由标准 SSE 客户端自愈）；延迟
目标（双机 LAN e2e 断言 p95）：元数据帧 ≤600ms（不含上游 TTFB）、首分片
≤300ms（自上游首字节）、后续分片间 ≤150ms。WebSocket v1 MUST NOT 宣称支持。
claude-code 写手（`~/.claude/settings.json`）MUST preview→diff 确认（sha256
token）→apply，本地 token 一律占位符。

#### Scenario: 本地端点等价直连

- **WHEN** agent base URL 指向本地端点发起 OpenAI/Anthropic 兼容请求（含 SSE）
- **THEN** 字节流等同直连（差异仅凭据头替换/白名单 404/限流错误 JSON）；
  延迟目标 p95 达标

### Requirement: wire ABI（/wpk1/ai/v1/*，header framing）与响应中继状态机

跨设备面 SHALL 冻结 **header framing ABI**（与内核 OPEN metadata+DATA 投影
逐层对齐：ai 层元数据全部走 `x-odai-*` HTTP 头，body=纯载荷字节，无
multipart/metadata-in-body）：`POST auth`（`{v:1,keys:[≤8]}`→200 **多 key**
`{v:1,status:"ok",groups:[{keyId,group,limits:{maxConcurrency?,dailyRequests?},
services:[ServiceEntry]}]（≥1）,rejected?:[{code:"key_invalid"|"key_revoked"}]}`
——**与 ai-fly frames.ts AUTH_OK 同型**（rejected 仅 code 不带 keyId；有效
键集合=groups[].keyId，与输入对应由此确立）；全错 `403 {v:1,code:
"key_all_invalid"}`）；`GET catalog?since=<rev>`（**hold ≤20s**——对齐
ai-fly CATALOG_WATCH_TIMEOUT_MS 且严小于内核 head deadline 30s；204/200
全量；**全量 ≤256 服务且 JSON ≤256KiB**，超配工厂期拒绝）；
`POST request`（头 `x-odai-service`[**唯一来源**，body/query 同名信息=400]/
`x-odai-method`/`x-odai-path`/`x-odai-key-id`/`x-odai-headers`[≤4KiB]；
raw body ≤maxChunkPayload → 200 `{responseId,epoch,status,headers}`；keyId
失效=`403 {code:"key_invalid"}`（从未有效）|`{code:"key_revoked"}`（已撤）——
与 AUTH 全钥失败 `key_all_invalid` 三码分立）；
`POST response/<rid>`（头 `x-odai-key-id`/`x-odai-from-seq`；就绪=200 raw
单分片+`x-odai-seq/x-odai-done/x-odai-next-seq`，未就绪=**204 hold ≤20s**，
终态=摘要 200 零 body；`fromSeq≠committedSeq+1`=409 `invalid_from_seq`；
并发第二拉取=409 `pull_in_flight`）；`POST cancel`（幂等终态重放）。ai
元数据头合计 ≤8KiB（超限 400 `metadata_too_large`）。**gate 范围**：内核
wpk router 语义不改（unknown-plugin 404/plugin-disabled 503）；ai handler
内部 peer 未授权/op 未授权/未知子路径→一律 `404 {error:"not_found"}`
byte 级同体、不解析 key；`path_not_offered` 仅双过后可出现（内核 op-aware
gate 列 follow-up）。**预算**：`maxChunkPayload=1MiB−16KiB`（推导=ai 头
8KiB+OPEN metadata 4KiB+分片头 1KiB+定界 1KiB=14KiB 取整 16KiB；编码后落
帧 ≤1MiB 恒成立）；每调用独立流（内核 2MiB/流 8MiB/session 覆盖）；请求
体超限 413；admission：在途上游 ≤maxConcurrency（默认 8 域 1–32）且活跃
ring（=maxConcurrency×2MiB）≤64MiB 超积工厂拒启；终态摘要 LRU 独立 ≤4MiB。
**中继状态机**：`allocated→producing→（ready(seq)→in-flight→committed）→
done`；全部转移（produce/cancel/expiry/commit/拉取）在 per-rid 互斥锁内；
**单飞拉取**（同 rid 同时仅一个在途 response 调用）；**连续提交游标**
`committedSeq`（**初值 −1——首个合法 fromSeq=0、首片 seq=0；EOF 空流=零分片
+立即 done 摘要**；拉取必须 fromSeq=committedSeq+1——无 seq 空洞、无提前
释放；提交=下次拉取推进或终态确认）；responseId=`<epoch>:<单调号>`，epoch=
启动 CSPRNG；**幂等仅同进程**（(epoch,rid,seq) 同键同内容重放；重启→全部
在途 rid 404 `response_not_found`，跨重启重放不支持——非幂等上游 POST 的
重复执行风险由消费端重试策略自担并文档明示；持久化幂等账本列 follow-up）；
空闲 TTL=最后 200 拉取活动+120s（204 hold 不续期）；**绝对寿命=创建+10min
硬上界**（到点未终态即 expired，先 abort 上游再释放占位）；done 后 body
分片即弃（仅摘要可重放，旧 seq 不可再拉）；满 buffer=上游读暂停背压，绝对
寿命为有界终止无死锁路径；取消双向传播；断线/过期/竞态 MUST 显式错误，
MUST NOT 静默截断成成功。请求/拉取 MUST 绑定 `x-odai-key-id`（quota/usage/
撤钥判定按 keyId；在途 rid 授权=request 时刻快照——撤钥不撕已在途流）。
**撤钥三态**：①单 keyId 撤销+session 另有有效 key=该 keyId 新 request
`403 {code:"key_revoked"}`（在途 rid 按创建时快照续拉至终态）
；②session 全钥失效=5s drain deadline（settle/abort，
`auth_revoked`）后断 fabric 会话（**有意分歧声明**：ai-fly 即时 disconnect，
本 v1 加 5s 有界 drain）；③peer 被 gate 撤销=gate 拒新、在途随会话关闭。
maxConcurrency 占位在流终态即释放。

#### Scenario: 长流式响应不触顶（5MiB SSE）

- **WHEN** 单响应总量超过内核单流名义预算（5MiB SSE 流）
- **THEN** 分片完整送达（每片 ≤maxChunkPayload、租约/提交推进、零重复零
  丢失、字节保序）；无「成功但少字节」路径

#### Scenario: 竞态与恢复矩阵

- **WHEN** 满 buffer×0/1 拉取（并发第二拉取）；fromSeq 越过 committedSeq；
  首片 fromSeq=0（cursor 初值 −1）；204 hold 期间产出分片；**hold 20s vs
  内核 head deadline 30s 边界**；cancel×done 交叉；空闲 TTL 过期；绝对寿命
  10min 到点仍 producing；done 后再拉旧 seq；EOF 空流；provider 重启（epoch
  更替）；断线 90s 内恢复；**撤钥后在途 rid 续拉（正例）**
- **THEN** 按状态机终态收敛：并发第二拉取 409 `pull_in_flight`、越前 409
  `invalid_from_seq`、hold 醒来即返回新分片、先到终态幂等、空闲 TTL/绝对
  寿命到期先 abort 上游再 expired、done 后旧 seq 不可再拉（摘要 only）、
  重启后旧 rid 404、续拉零重复零丢失（committedSeq 连续推进）

#### Scenario: 双层准入错误矩阵

- **WHEN** ai handler 内：peer 未授权 / op 未授权 / 未知子路径 / 双过+**未知
  keyId** / 双过+**已撤 keyId** / 双过+白名单外路径
- **THEN** 前三者与未知路径 `404 {error:"not_found"}` byte 级同体；第四
  `403 {code:"key_invalid"}`（从未有效）；第五 `403 {code:"key_revoked"}`
  （已撤）；第六 `404 path_not_offered`（仅双过后可出现）；三码
  （+AUTH `key_all_invalid`）各有独立契约测试；内核
  插件级响应（unknown-plugin 404/plugin-disabled 503）保持现状不属本矩阵

### Requirement: 配额、限流与用量审计

提供方 SHALL 执行分组 maxConcurrency（在途计数、拨号前检查、超限 429
`rate_limited`）与按 key dailyRequests（UTC 日界重置、`quota-day.json` 0600
原子持久化、重启不丢、超限 429 `quota_exceeded`）；错误为 OpenAI 风格 error
JSON。usage 审计 `usage.jsonl`（0600）默认关闭、显式启用，仅记
`ts/keyId/serviceId/status/bytes`，MUST NOT 记正文与凭证。全链路 MUST 零
凭证泄露（argv/凭证 env/URL/日志/浏览器状态/usage/错误帧/目录披露；e2e
后扫描断言）；错误文案 MUST NOT 含脚本路径与密钥名。

#### Scenario: 配额持久化与日界重置

- **WHEN** key 当日达限→再请求；provider 重启→再请求；UTC 日界翻越→再请求
- **THEN** 达限 `quota_exceeded`；重启后同日计数仍在；日界翻越后恢复

#### Scenario: 泄露面扫描（e2e 断言）

- **WHEN** 全链路 e2e（auth/请求/撤钥三态/配额/错误路径）后扫描两机 argv、
  env、日志、usage.jsonl、sidecar stderr、浏览器可达状态
- **THEN** 零命中（掩码投影与密钥指纹除外）
