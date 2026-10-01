# Design: ai-subscription-sharing

> r2 评审（Codex，2026-10-01，NOT-READY 5.8/10）已处置：
> §3 改 header framing（P0-A：元数据全走 `x-odai-*` 头，body=纯载荷——与
> 内核 OPEN metadata+DATA 投影（continuity/http.rs）逐层对齐；AUTH 多 key
> `groups[]/rejected[]`）；§3.2 改**单飞拉取+连续提交游标**（P0-B：禁止
> fromSeq 越过 committedSeq、无租约竞态、204 hold 语义、全部转移单锁）；
> 重启幂等降为**同进程重试**（P1-C）；gate 范围收缩为 ai handler 内统一 404
> （P1-D：内核插件级 404/503 语义不改，op-aware gate 列 follow-up）；请求
> 绑定 `x-odai-key-id`+5s drain 声明为有意分歧（P1-E）；hook 进程内执行+
> ambient env 启动/激活拒绝（P1-F，r4 终版）；rid 绝对寿命上界+终态摘要
> 保留（P1-G）；绿门
> receipt 路径（P1-H）；rust-fetch 承接条款补发现顺序（P2-I）。

## 0. 移植总策略

**vendor 适配，不改上游、不改内核。** ai-fly（/Users/kzf/Dev/GitHub/ai-fly，
v0.6.0）只读参照；适配源落 `packages/opendweb-ext-ai/`，每文件头保留
`// adapted from ai-fly <path> (v0.6.0)` 标注。**移植基线=ai-fly 现行
HTTP 投影面**（旧 AUTH/REQ/RESP envelope 已在上游退役——`src/wire/
http-protocol.ts`），本设计的 §3 ABI 是它的 wpk1 化重述，不是帧协议。

### 模块映射表（ai-fly → ext-ai）

| ai-fly 源 | 去处 | 适配要点（含与上游的有意分歧） |
|---|---|---|
| provider/{secrets,store,auth,limits,detail}.ts | `src/provider/` | 路径根 `<DWEB_HOME>/plugins/ai/`；写原语换 atomicWrite0600 家族；**raw key 可选落盘照搬**（上游 Owner 裁决 2026-09-13，§2） |
| provider/{rewrite,match-pattern,uri-template,upstream}.ts | `src/provider/` | `$env` 凭证引用族删除（§4）；SSE 字节流语义照搬（无事件边界对齐，上游本无 SSE parser） |
| provider/hook.ts + hooks/{secret,file,codex}.cjs | `src/provider/hooks/` | **env.cjs 不存在**；codex.cjs 移后续 change（§5） |
| presets/providers.json, models-dev.ts | `src/presets/` | **codex 条目 v1 不随包**（17 项；codex 位保留 `requires:"ai-codex-oauth"` 占位） |
| wire/http-protocol.ts, frames.ts, z32.ts, http-errors.ts | `src/wire/` | 常量族改名 `x-odai-*`；schema 复用其静态定义层 |
| consumer/{gateway,ports,join}.ts | `src/consumer/` | forward 层从自有 fabric 改接**宿主注入面**（ports 同款） |
| consumer/providers.ts（会话状态机） | `src/consumer/sessions.mjs` | 钥环 `plugins/ai/keyring.json` 0600 |
| app/writers/claude-code.ts | `src/consumer/writers/` | **只带 claude-code 写手**（codex 写手随 codex change） |
| provider/engine.ts, serve.ts | `src/provider/{accept,catalog,forward}.mjs` **三拆** | engine 含 peer-accept/AUTH/watch/forward 生命周期——按 wpk router 子面拆三文件独立验收（r1-C 抽查意见） |
| app/*（桌面壳）、webui/、sidecars/rust-fetch | **不移植** | 宿主替代；rust-fetch 随 codex change（§5） |

运行时新依赖仅 hono（本地端点）+ zod；零原生依赖。

## 1. 宿主接入（内核七接入点）

同 r1 版不变：descriptor（id=`ai`；pages=provider(admin)/consumer(member)，
≤3；dataEndpoints=`[{id:"wire",path:"/wpk1/ai/"}]`；configSchema=
`{maxConcurrency:number, dailyRequests:number, usageLog:boolean}`，域校验
工厂 1–32 / 0–1_000_000 / bool——**maxConcurrency 域上限由 §3 统一 admission
公式联动**）；registry 注册+占位删除；data-plane 双姿态装配（一台机可同时
提供+消费，视角互不排斥）；`/sidecar/plugins/ai/*` 管理面；UI 七接入点；
生命周期四步序（dispose=本地端点全关+在途上游 abort）；数据目录
`<DWEB_HOME>/plugins/ai/`（0700；0600 文件家族）。

## 2. 两层准入、凭证模型与撤钥三态

设备层=fabric 邀请（dweb1.）；应用层=分组密钥（**保持 ai-fly 语法**
`sk-aifly-`/`aifly1.`，征询①采纳——rebrand 留后续，改则常量单点）。wpk1
gate（peer×op deny-by-default）先过、ai 层密钥校验后过。

**gate 错误面（r2-P1-D 范围收缩）**：内核 wpk router 语义**不改**（unknown
-plugin 404 / plugin-disabled 503 / 插件级 gate——fabric.mjs createWpkRouter
现状）。本 change 的统一 404 纪律作用于 **ai handler 内部**：peer 未授权/
op 未授权/未知子路径→一律 `404 {error:"not_found"}` byte 级同体、不解析
key；`path_not_offered` 仅 gate+key 双过后可出现。内核级 op-aware gate 与
插件禁用面收敛列 follow-up（不在本 change 搭车改内核）。响应矩阵进测试。

**请求绑定 keyId（r2-P1-E）**：AUTH 成功返回 `groups[]`（多 key）；每
request/response 调用携带 `x-odai-key-id`（auth 所得其一）——quota/usage/
撤钥判定全部按 keyId。**撤钥三态与 ai-fly 的差异如实声明**：ai-fly 全钥
失效即 disconnect（engine.ts:322）；本 v1 增加 **5s 有界 drain**（有意分歧，
为在途流完整性）+单 key 粒度拒绝（ai-fly 为 session 粒度 grant 选择）。

**raw key（P2-1 处置）**：对齐上游 Owner 裁决——raw key 可选存 services.json
（0600，本机明文与密钥库同威胁模型）；**远程面**（wire 响应/日志/目录披露/
usage）恒掩码；**webui 本地管理面**允许显式复制动作（127.0.0.1+Host/Origin
守卫内，与 ai-fly GUI 同位）。修正 r1 版「仅一次性展示」表述；链接再生成
（link 复用已存 key）照搬。

**撤钥三态（P1-5 冻结，粒度=keyId；r3-C3 续拉规则）**：
- ①单 key 撤销、session 尚有其他有效 key：不断会话；该 keyId **新 request**
  `403 {code:"key_revoked"}`（对齐上游 REJECTED_CODE）；**已在途 rid 按创建
  时授权快照放行续拉至终态**（response 拉取不因撤钥 403——drain 语义闭合；
  仅新 request/新 rid 被拒）。
- ②session 全钥失效：drain deadline **5s**（在途 settle 或 abort，错误码
  `auth_revoked`）；随后断开该 fabric 会话（**有意分歧**：ai-fly 即时
  disconnect，本 v1 加 5s 有界 drain）。
- ③peer 被 gate 撤销：gate 拒新（404 同体）；在途随 fabric 会话关闭收敛。
- 三态的 maxConcurrency 占位都在流终态即释放（不等 TTL）。并发撤钥×在途
  ×拉取竞态进测试矩阵（含「撤钥后在途 rid 仍可续拉」正例）。

## 3. wire ABI：`/wpk1/ai/v1/*`（HTTP header framing，r2-P0-A 冻结）

**基于 ai-fly 现行 HTTP 投影形态的新增扩展**（非重述——auth/catalog/service
头沿用其形状（`src/wire/http-protocol.ts`）；`request/response/cancel` 三端点
为本 change 新设的中继面，ai-fly 的流式经其自有 keepOpen 隧道承载、不可平移）。
与内核投影逐层对齐：内核 OPEN metadata（method/path/headers/bodyLength）+
DATA body（`crates/dweb-fabric/src/continuity/http.rs`）→ **ai 层元数据全部走
HTTP 头（`x-odai-*`），body=纯载荷字节**——单一无歧义 framing，无 multipart、
无 metadata-in-body。

- **头预算**：ai 层元数据头合计 ≤8 KiB（provider 超限即 400 `metadata_too_
  large`）；`x-odai-service` 为 serviceId **唯一来源**（body/查询串中出现
  同名信息即 400 拒绝——无冲突规则）。
- gate op 名（内核授权粒度）：`ai/v1/{auth,catalog,request,response,cancel}`；
  不兼容变更升 `/wpk1/ai/v2/`。

| method+path | 请求 | 成功响应 | 错误 |
|---|---|---|---|
| `POST auth` | body `{v:1, keys:[≤8]}` | `200 {v:1, status:"ok", groups:[{keyId,group,limits:{maxConcurrency?,dailyRequests?},services:[ServiceEntry]}]（≥1）, rejected?:[{code:"key_invalid"\|"key_revoked"}]}`（**与 ai-fly frames.ts AUTH_OK 同型**：rejected 仅 code 不带 keyId——有效键集合=groups[].keyId，与输入的对应由此确立） | key 全错=`403 {v:1, code:"key_all_invalid"}`（AUTH_ERR 同型） |
| `GET catalog?since=<rev>` | — | `200 {v:1, refresh:true, catalog, rev}`；无变化 `204`（**hold ≤20s**——对齐 ai-fly CATALOG_WATCH_TIMEOUT_MS，且留裕量于内核 head deadline 30s 之内） | 未 auth=`403 key_all_invalid`；**全量 catalog ≤256 服务/JSON ≤256KiB**（工厂期拒绝超配——服务数超限即不可保存） |
| `POST request` | 头：`x-odai-service`/`x-odai-method`/`x-odai-path`/`x-odai-key-id`（auth 所得）/`x-odai-headers`（上游头白名单 JSON 数组 ≤4KiB）；body=raw 载荷 ≤maxChunkPayload | `200 {responseId,epoch,status,headers}` | `404 path_not_offered`；`429 {code:"rate_limited"\|"quota_exceeded"}`；**keyId 失效=403 `{code:"key_invalid"}`（从未有效）或 `{code:"key_revoked"}`（已撤）——与 AUTH 全钥失败 `key_all_invalid` 三码分立**；载荷超限 `413`；头预算超限 `400 metadata_too_large` |
| `POST response/<rid>` | 头：`x-odai-key-id`/`x-odai-from-seq`；body 空 | 就绪=`200` raw 单分片+`x-odai-seq`/`x-odai-done`/`x-odai-next-seq`；未就绪=`204`+`x-odai-next-seq`（**hold ≤20s** 后返回，consumer 重试——同 catalog watch 常量；**必小于内核 head deadline 30s**，consumer 侧不要求调大 head timeout）；终态后=摘要 `200` 零 body+`x-odai-done:1` | `404 {code:"response_not_found"\|"response_expired"}`；fromSeq≠committedSeq+1=`409 invalid_from_seq`；同 rid 并发第二拉取=`409 pull_in_flight` |
| `POST cancel` | body `{responseId,epoch}` | `200 {status:"cancelled"}`（幂等终态重放） | 404 族同上 |

### 3.1 预算与 admission 公式

- `maxChunkPayload = 1 MiB − 16 KiB`。**推导**（最坏叠加）：ai 元数据头
  8 KiB + 内核 OPEN metadata JSON（requestId/idempotencyKey/method/path/
  headers 数组——schema 实测 ≤2 KiB，按 4 KiB 余量计）+ 分片响应头 1 KiB +
  帧定界余量 1 KiB = 14 KiB，向上取整 16 KiB → 编码后落帧 payload ≤1 MiB
  恒成立（MAX_FRAME=1 MiB 为 payload 上限，continuity/frame.rs）。请求/
  响应同用此值。
- 每个 wpk1 调用=独立完整会话流（内核 2 MiB/流、8 MiB/session 记账天然
  覆盖；catalog 256 KiB 上限同在包络内）。
- provider 端 admission：在途上游 ≤maxConcurrency（默认 8，域 1–32）；
  **活跃 ring**（非终态 rid 缓冲）≤maxConcurrency×2 MiB ≤64 MiB（超积工厂
  拒启）；**终态摘要保留**独立上界 4 MiB LRU（§3.2）。请求体 v1 单片上限=
  maxChunkPayload（更大列 v2 分块）。

### 3.2 响应中继状态机（r2-P0-B：单飞拉取+连续提交游标）

```
allocated → producing →（逐 seq：ready(seq) → in-flight → committed）→ done
终态（互斥，单一 per-rid 互斥锁内裁决）：done | cancelled | expired
```

- **全部状态转移**（produce/cancel/expiry/commit/拉取）在 per-rid 互斥锁内
  完成（单线程事件循环+显式临界区；无跨锁竞态面）。
- **单飞拉取**：同一 rid 同时只允许一个在途 `response` 调用（第二个=409
  `pull_in_flight`）——取消了租约 token 的全部竞态面。
- **连续提交游标** `committedSeq`（**初值 −1**——首个合法 `fromSeq=0`，首片
  seq=0；EOF 空流=零分片+立即 done 摘要）：0..committedSeq 全部已提交的连续
  前缀。拉取必须 `fromSeq === committedSeq+1`，否则 409——**禁止越过未提交
  分片**（无 seq 空洞、无提前释放）。提交=消费方下一次拉取 fromSeq 推进
  （隐式连续提交）或终态确认；ring 槽仅随游标推进释放。
- **未就绪语义**：下一分片未产出时 hold **≤20s**（同 catalog watch 常量，
  严小于内核 head deadline 30s——OPEN/发送/头等待的总预算内必返回，consumer
  无需调大 head timeout）；期间产出即返回，超时 `204`+`x-odai-next-seq`
  （consumer 立即重试）。deadline 边界（hold 20s vs head 30s）入 e2e。
- **responseId=`<epoch>:<单调号>`**；epoch=进程启动 CSPRNG（持久化不需要）；
  **重启=全部在途 rid 404 `response_not_found`**——幂等仅**同进程内**保证
  （(epoch,rid,seq) 同键同内容重放）；跨重启由消费端重新 request 承接
  （v1 明确不支持跨重启重放——非幂等上游 POST 的重复执行风险由消费端重试
  策略自担，文档明示；持久化幂等账本列 follow-up）。
- **done**：上游 EOF 分片带 done 标记；此后拉取返回终态摘要（零 body+
  `x-odai-done:1`），**body 分片即弃**（摘要保留见下）。
- **cancel/done 竞态**：锁内先到定终态，后到幂等返回。
- **TTL 与绝对寿命**：空闲 TTL=最后活动+120s；**绝对寿命=创建+10 min 硬
  上界**（不可续期越过后仍存活——到点未 done/cancelled 即 expired，先
  abort 上游再释放）；204 hold 不续 TTL（仅 200 拉取推进算活动）。
- **终态摘要保留**：done 后仅保留 `{status,headers,committedSeq}` 摘要可
  重放（旧 seq body 不可再拉——404 已弃），独立 LRU 上界 4 MiB，随空闲
  TTL 过期回收；不占活跃 ring 预算。
- **满 buffer 无拉取**：上游读暂停（背压）至 buffer 浅/拉取/终态三者之一；
  绝对寿命是有界终止，无死锁路径；concurrency 占位在终态即释放（不等 TTL）。
- **取消**：consumer 本地连接断→cancel（+在途拉取 abort）→上游 abort
  （ai-fly abort 链照搬）。

### 3.3 SSE/流式语义（P1-2 冻结：字节流透明，不做事件对齐）

上游响应=**字节流透明中继**（ai-fly 本无 SSE parser；splitBodyChunks 256KiB
按字节切）。对 SSE 消费方的保证=**字节保序、零丢失、零重复**——事件完整性
由标准 SSE 客户端解析自愈（SSE 规范本就容忍任意 chunk 边界）。攒批策略：
首分片立即就绪可拉；后续 `min(256 KiB | 50ms | 上游块边界)`。**延迟目标**
（e2e 断言，双机 LAN）：元数据帧 p95 ≤600ms（不含上游 TTFB）；首分片
（自上游首字节）p95 ≤300ms；后续分片间 p95 ≤150ms。事件边界对齐 flush
列 follow-up（实测 agent 兼容性问题再上）。

## 4. auth 槽三族与 env 二分法（P1-3 冻结）

- auth 槽=ai-fly 现行三族单选+可选 bearer：`{secret:<name>} | {script:<name>,
  args?} | {literal:<v>}`（**无 file 族**——文件取值经 `{script:"file"}`，
  与上游一致；r1 proposal 笔误在本版修正）。literal 间接引用仅 `$secret:`。
- **env 二分法（r2-P1-F/r4 终版：进程内 hook+ambient env 启动/激活拒绝）**：ai-fly hooks 为
  **宿主进程内 require()**（hook.ts:266），非子进程——v1 **保持进程内执行**
  （内核「可信插件」信任模型的既定边界：hook 脚本与宿主同权限，可读
  `process.env` 与 secrets.json——**本 change 不宣称防御恶意 hook**（其与
  恶意插件同级，读密钥库与读 env 同难度）；文档明示此边界）。保证面冻结
  为两层：①**插件自身代码路径不经 env 取凭证**——`$env:` 形态与 env.cjs
  不存在、auth 路径 `process.env` fallback 删除、auth 槽三族（secret/
  script/literal[仅 `$secret:` 间接]）是凭证进入上游请求的唯一通道、预设
  `keyEnv` 降 UI 提示且激活前 MUST 绑定 secret；②**ambient env 防绕
  （fail-closed，两个时点）**——检测时机=**provider 启动时**与**每次服务的
  新增/启用/预设或 keyEnv 变更/staging commit**（管理面原子变更内）：任一
  已启用（或将启用）服务的预设 keyEnv 名单变量存在于进程环境即**拒绝**
  （启动时=拒绝启动；运行时=原子拒绝该变更），错误列明变量名，指引转
  secret 槽；不剥离值——剥离改变用户环境语义，拒绝才是诚实边界）。
  判定线=值进入上游请求头/体；CODEX_HOME 类运行时 env 不受限。负向测试
  「env 中人为放入等值 secret，请求仍不得携带」（槽解析不经 env）+「启动
  检测命中即拒（启动+运行中激活两时点）」双断言。
- **导入两阶段 staging**：扫描 ai-fly services.json → 返回机器可读
  `{blocked:[{service,field,ref}], ready:[...]}`（安全条目不激活）→ 用户
  完成 $env→secret 映射 → 一次性 commit；**禁止 env 自动快照**。

## 5. codex OAuth + rust-fetch：拆后续 change（征询③采纳，r2-P2-I 承接条款）

v1 不含：codex 预设（OAuth 登录态）、rust-fetch sidecar、codex 写手、
`hooks/codex.cjs`。presets 表 17 项 + codex 占位（`requires:"ai-codex-oauth"`）。
后续 change `ai-codex-oauth` 承接（其 requirements MUST 冻结）：
- auth.json 只读 hook（user-agent 去 codexHome 路径）+ codex 写手；
- **rust-fetch 打包**：crates workspace member 文件清单 + pack 脚本产物
  清单（vendored bin 路径+manifest）；**发现顺序**=生产仅包内路径+目标
  平台匹配+manifest hash 校验通过（三条件同时满足才执行；任一不符=
  `rust_fetch_unavailable` 显式降级）；**禁止 env/PATH fallback 发现**；
  显式路径仅 dev flag（绝对路径+属主/权限检查）；测试矩阵=缺失/不可执行/
  被替换（hash 不符）/错误架构四态；
- 真 ChatGPT 订阅验收（Owner 手工 receipt）。本 change tasks Phase D 相应收缩。

## 6. 页面与交互（v1）

- provider 页（admin）：服务列表（17 预设+自定义）→分组→密钥（签发/命名/
  **本地复制**（§2 raw key）/撤键三态呈现）→配额→用量（元数据聚合）→
  上游探活（provider 本机直发最小请求，经同一 hook 管线）。
- consumer 页（member）：贴 `aifly1.` 链接或邀请+key 分开输入→目录→本地
  端口（冲突真实报错）→claude-code 写手（preview→diff→apply，占位符 token）。
- 面板 META「AI 订阅共享」；禁用=端点全关。

## 7. 测试策略（P1-7 命令化绿门见 tasks）

1. 单测（ai-fly 矩阵移植，vitest→node --test；fake 注入不触原生）。
2. **wire 契约测试（Phase A 内）**：ABI 表逐端点（含 404 同体三形态 byte
   级、**三码分立独立用例**（AUTH `key_all_invalid` / request 未知 keyId
   `key_invalid` / 已撤 `key_revoked`）、403/404/409/429 矩阵、413 边界
   maxChunkPayload±1、400 头预算超限、serviceId 双源拒绝、AUTH 多 key
   正/部分失败/全失败三态 fixture 序列化断言、gate op 名、admission 超积
   拒启、catalog 256KiB 上限）。
3. **中继竞态矩阵（Phase B 内）**：满 buffer×0/1 拉取（并发第二拉取=409）、
   fromSeq 越前=409、首片 fromSeq=0（cursor 初值 −1）、204 hold→产出→返回、
   **hold 20s vs 内核 head deadline 30s 边界**、cancel×done 交叉、空闲 TTL
   过期、绝对寿命 10min 到点 expired（先 abort 上游）、done 后 body 弃+
   摘要重放、provider 重启（epoch 更替，旧 rid 404）、断线 90s 续拉零重复
   零丢失、5MiB 长响应、EOF 空流（零分片立即 done）、并发撤钥三态×在途×
   拉取（含**撤钥后在途 rid 仍可续拉**正例）、env 等值负向（secret 在 env
   中不得进请求）。
4. e2e 双进程真内核（全链路+延迟目标 p95 断言）。
5. 泄露面扫描（argv/净化后 env/日志/usage/stderr 零凭证）。
6. 回归门：webui 262 面零回归+三插件 e2e 零回归。

## 8. 风险与分期

- P0 风险仍是中继背压/竞态——§3.2 状态机+§7.3 矩阵对打；hono 依赖隔离
  （ext 包内，宿主不 import）。
- 分期 A（provider 纯逻辑+wire 契约）→B（中继+消费端点+竞态矩阵+e2e）→
  C（UI+占位替换+生命周期）→D（claude-code 写手+探活+17 预设验证）→
  E（specs 同步+walkthrough+归档）。每门=可执行命令+阻断条件（tasks）。
- 不做（v1）：codex OAuth/rust-fetch/codex 写手（→`ai-codex-oauth` change）、
  WS 透传、事件边界 flush、>maxChunkPayload 请求体分块、cursor/cline/
  continue 写手、catalog 服务端推送、CLI 插件面、$env 凭证、Linux 原生、
  非回环监听。
