# Design: ai-subscription-sharing

> r1 评审（Codex，2026-10-01，NOT-READY 4.8/10）全部 P0/P1/P2 已处置：
> §3 重写为具体 JSON-over-HTTP ABI + 中继状态机（P0-1/P0-2）；预算按
> 编码后最坏计账（P1-1）；SSE 改字节流透明语义+延迟目标（P1-2）；auth
> 三族统一+env 二分法+两阶段导入（P1-3）；gate 错误面统一 404（P1-4）；
> 撤钥三态冻结（P1-5）；codex OAuth+rust-fetch 拆后续 change（P1-6/征询③）；
> 阶段绿门命令化（P1-7）；raw key 对齐上游 Owner 裁决（P2-1）；密钥语法
> 保持 ai-fly（征询①）；v1 用响应中继不动内核（征询②）。

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

**gate 错误面（P1-4 冻结）**：gate 失败（未知 peer/未授权 op/插件停用）
一律 `404 {error:"not_found"}`——与未知路径同体、固定 body、不解析 key；
gate 过后才出现 ai 层码（403 `auth_failed` 等）。白名单外路径的
`path_not_offered` **仅在 gate+key 双过后可出现**（此时路径存在性已无泄露
面——对端已持有效 key）。响应矩阵进测试（§7）。

**raw key（P2-1 处置）**：对齐上游 Owner 裁决——raw key 可选存 services.json
（0600，本机明文与密钥库同威胁模型）；**远程面**（wire 响应/日志/目录披露/
usage）恒掩码；**webui 本地管理面**允许显式复制动作（127.0.0.1+Host/Origin
守卫内，与 ai-fly GUI 同位）。修正 r1 版「仅一次性展示」表述；链接再生成
（link 复用已存 key）照搬。

**撤钥三态（P1-5 冻结）**：
- ①单 key 撤销、session 尚有其他有效 key：不断会话；该 key 新请求 403
  `auth_failed`；在途按流完成（drain）。
- ②session 全钥失效：drain deadline **5s**（在途 settle 或 abort，错误码
  `auth_revoked`）；随后断开该 fabric 会话（对齐 ai-fly engine.disconnect）。
- ③peer 被 gate 撤销：gate 拒新（404 同体）；在途随 fabric 会话关闭收敛。
- 三态的 maxConcurrency 占位都在流 terminal（done/cancelled/expired）即释放
  （不等 TTL）。并发撤钥×在途×拉取竞态进测试矩阵。

## 3. wire ABI：`/wpk1/ai/v1/*`（JSON-over-HTTP，P0-1 冻结）

对齐 ai-fly HTTP 投影形态的 wpk1 化重述。serviceId 路由头 `x-odai-service`
（消费端注入；提供端剥离，**绝不透传上游**）。不兼容变更升 `/wpk1/ai/v2/`。
gate op 名（内核授权粒度，随前缀带版本）：`ai/v1/auth`、`ai/v1/catalog`、
`ai/v1/request`、`ai/v1/response`、`ai/v1/cancel`。

| method+path | 请求 | 成功响应 | 错误 |
|---|---|---|---|
| `POST auth` | `{v:1, keys:[≤8]}` | `200 {status:"ok",keyId,catalog,catalogRev}` | gate=404 同体；key 错=`403 {status:"err",code:"auth_failed"}` |
| `GET catalog?since=<rev>` | — | `200 {refresh:true,catalog,rev}`；无变化 `204`（≤30s 长轮询） | gate=404；未 auth=`403 auth_failed` |
| `POST request` | JSON 元数据 `{v:1,serviceId,method,path,headers:[{n,v}]}` + **raw body**（octet-stream，≤maxChunkPayload，超限 413） | `200 {responseId,epoch,status,headers}`（上游头就绪即返） | `404 path_not_offered`；`429 {code:"rate_limited"\|"quota_exceeded"}`；`403 auth_failed` |
| `POST response/<rid>` | `{epoch,fromSeq}` | `200` + raw body=**单分片**（≤maxChunkPayload）+ 头 `x-odai-seq`/`x-odai-done`/`x-odai-lease-ms`/`x-odai-next-seq` | epoch/rid 不符=`404 {code:"response_not_found"}`；过期=`404 {code:"response_expired"}` |
| `POST cancel` | `{responseId,epoch}` | `200 {status:"cancelled"}`（幂等，终态后重放同响应） | 同上 404 族 |

**分片用 raw body+头携带元数据**（不做 base64——零膨胀，P1-1 简化）。

### 3.1 预算与 admission 公式（P1-1 冻结）

- `maxChunkPayload = 1 MiB − 4 KiB`（worst-case envelope：JSON 元数据+头+
  分片头，4 KiB 封顶）→ **编码后落帧 payload ≤1 MiB 恒成立**（fabric
  MAX_FRAME=1 MiB 是 payload 上限，crates/dweb-fabric/src/continuity/frame.rs）。
- 每个 wpk1 调用（request/response 拉/cancel）=独立完整会话流，按内核既有
  per-stream 2 MiB / session journal 8 MiB 记账：单调用 1 MiB+envelope 天然
  在内；**无任何调用超过单流预算**，方向性计账由此闭合。
- provider 端统一 admission：`在途上游请求 ≤ maxConcurrency（默认 8，域
  1–32）`；`ring 总量 ≤ maxConcurrency × perRequestBuffer(2 MiB)`，且
  **乘积 ≤64 MiB**（config 联动校验：超积拒绝启动插件——工厂期错误）。
- 请求体 v1 单片上限=maxChunkPayload（≈1 MiB−4 KiB；与 ports 同量级；
  更大请求体列 v2 分块上传）。

### 3.2 响应中继状态机（P0-2 冻结）

```
allocated → producing →（逐 seq：ready(seq) → leased → committed）→ done
终态（互斥，terminal arbiter 单点裁决）：done | cancelled | expired
```

- **responseId = `<epoch>:<单调序号>`**；进程重启→新 epoch，旧 rid 一律
  `response_not_found`——**不复用、不复活**（跨重启恢复=消费端重新 request，
  幂等键 `{serviceId,method,path,bodyHash}` 使 provider 可识别重放并返回
  存活中的既有 rid）。
- **幂等键 `(epoch, rid, seq)`**：同键重放同内容 200；分片内容由上游字节
  流序决定，同 seq 异内容=不可能（若发生=内部错误显式 500）。
- **拉取租约**：`response` 调用返回即租（leaseMs 默认 30_000）；租约内同
  fromSeq 重拉=重放同分片；租约到期未推进→分片回 ready 可重拉；**隐式
  提交**：下一次 fromSeq 推进（或 done 确认）即视为此前分片 committed，
  ring 中对应槽位释放。
- **done 裁决**：上游 EOF 分片带 `x-odai-done:1`；此后拉取返回零 body+
  done 头（终态重放），有效期至 TTL。
- **cancel/done 竞态**：terminal arbiter 先到先定，后到幂等返回既有终态。
- **TTL（绝对 deadline）**：元数据帧返回时刻 +120s；有拉取活动则续至最后
  活动 +120s；到期→若仍 producing 先 abort 上游→expired→释放 concurrency
  占位与 ring。
- **满 buffer 无拉取**：上游读暂停（背压）持续到 buffer 浅/拉取/TTL 三者
  之一——TTL 是有界终止保证，无死锁路径；concurrency 占位在 terminal 即
  释放（不等 TTL）。
- **取消**：consumer 本地连接断→cancel 调用（+拉取窗内 abort）→上游
  abort（ai-fly abort 链照搬）。

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
- **env 二分法**：**凭证 env 禁止**（`$env:` 形态、env.cjs、hook 读
  process.env 中将值注入上游请求的变量）；**运行时配置 env 允许**（
  CODEX_HOME、EXT_AI_* 开关、路径类）——判定线=「值进入上游请求头/体」。
- **导入两阶段 staging**：扫描 ai-fly services.json → 返回机器可读
  `{blocked:[{service,field,ref}], ready:[...]}`（安全条目不激活）→ 用户
  完成 $env→secret 映射 → 一次性 commit；**禁止 env 自动快照**。

## 5. codex OAuth + rust-fetch：拆后续 change（征询③采纳）

v1 不含：codex 预设（OAuth 登录态）、rust-fetch sidecar、codex 写手、
`hooks/codex.cjs`。presets 表 17 项 + codex 占位条目（`requires:"ai-codex-oauth"`
呈现「需后续版本」）。后续 change `ai-codex-oauth` 承接：auth.json 只读
hook、rust-fetch vendored 打包（生产仅包内+平台匹配+manifest hash 校验；
显式路径仅 dev flag+绝对路径+权限检查——P1-6 的约束直接写进该 change 的
requirements）、真订阅验收。本 change tasks Phase D 相应收缩。

## 6. 页面与交互（v1）

- provider 页（admin）：服务列表（17 预设+自定义）→分组→密钥（签发/命名/
  **本地复制**（§2 raw key）/撤键三态呈现）→配额→用量（元数据聚合）→
  上游探活（provider 本机直发最小请求，经同一 hook 管线）。
- consumer 页（member）：贴 `aifly1.` 链接或邀请+key 分开输入→目录→本地
  端口（冲突真实报错）→claude-code 写手（preview→diff→apply，占位符 token）。
- 面板 META「AI 订阅共享」；禁用=端点全关。

## 7. 测试策略（P1-7 命令化绿门见 tasks）

1. 单测（ai-fly 矩阵移植，vitest→node --test；fake 注入不触原生）。
2. **wire 契约测试（Phase A 内）**：ABI 表逐端点（含 404 同体三形态、
   403/404/429 矩阵、413 边界 maxChunkPayload±1、gate op 名）。
3. **中继竞态矩阵（Phase B 内）**：满 buffer×0/1/2 并发拉、cancel×done
   交叉、租约过期重拉、TTL 过期×producing、epoch 重启、幂等重放、断线
   90s 续拉零重复零丢失、5 MiB 长响应、并发撤钥三态。
4. e2e 双进程真内核（全链路+延迟目标 p95 断言）。
5. 泄露面扫描（argv/env[仅凭证判定线内]/日志/usage/stderr 零凭证）。
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
