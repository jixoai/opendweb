# Design: ai-subscription-sharing

## 0. 移植总策略

**vendor 适配，不改上游、不改内核。** ai-fly（/Users/kzf/Dev/GitHub/ai-fly，
v0.6.0）作为只读参照；适配源落 `packages/opendweb-ext-ai/`，每文件头保留
`// adapted from ai-fly <path> (v0.6.0, MIT)` 标注。不引入 ai-fly 为依赖
（它是独立仓库 + 自带桌面壳），不修改 client-sdk / webui 内核契约；内核
包络不够用的地方用**逻辑流分片**绕行（§3），不搭车改内核。

### 模块映射表（ai-fly → ext-ai）

| ai-fly 源 | 去处 | 适配要点 |
|---|---|---|
| provider/secrets.ts, store.ts, auth.ts, limits.ts, detail.ts | `src/provider/` 原样移植 | 路径根改 `<DWEB_HOME>/plugins/ai/`；SSRF 门禁原样 |
| provider/rewrite.ts, match-pattern.ts, uri-template.ts, upstream.ts | `src/provider/` | **auth 槽删 `$env` 族**（§4） |
| provider/hook.ts + hooks/*.cjs | `src/provider/hooks/` | 脚本发现路径改插件目录；codex/secret/file 保留、**env.cjs 删除**、rust-fetch 保留 |
| presets/providers.json, models-dev.ts | `src/presets/` 数据原样 | 无逻辑改动 |
| wire/frames.ts, z32.ts, http-errors.ts | `src/wire/` | 帧语义作为 `/wpk1/ai/v1/*` 的 body 协议（§3） |
| consumer/gateway.ts（hono 面）, ports.ts, join.ts | `src/consumer/` | hono 依赖随包引入；forward 层从「自有 fabric 会话」改接**宿主注入的 sidecar fabric host**（与 ports 同款注入面） |
| consumer/providers.ts（会话状态机） | `src/consumer/sessions.mjs` | fabric 数据面换宿主；钥环 `plugins/ai/keyring.json` 0600 |
| app/writers/{codex,claude-code}.ts | `src/consumer/writers/` | 只移植两写手（cursor/cline/continue 不带） |
| provider/engine.ts, serve.ts | `src/provider/serve.mjs` | accept 循环从自有 Fabric 改挂 wpk router（§3） |
| app/*（OpenTray/oRPC/web-server）、webui/、sidecars/rust-fetch | 除 rust-fetch 外**不移植** | webui 宿主替代；rust-fetch 经 §5 打包 |

运行时依赖预算：hono（本地端点）+ zod（schema）为新增运行时依赖；@orpc/ws/
opentray 全部不进。包保持零原生依赖（rust-fetch 为独立子进程二进制）。

## 1. 宿主接入（内核七接入点）

1. descriptor：`src/webui-plugin.mjs` 导出 `descriptor`（id=`ai`，webuiApi=1）。
   pages：
   - `provider`（admin；type=page；服务/分组/密钥/配额/用量控制台）
   - `consumer`（member；type=page；目录/本地端点/钥环/写手）
   - `catalog`（member；type=page；可连共享服务浏览）——v1 并入 consumer 单页
     亦可（实现期定，descriptor 页数 ≤3）
   dataEndpoints：`[{id:"wire", path:"/wpk1/ai/"}]`；configSchema：
   `{maxConcurrency:number, dailyRequests:number, usageLog:boolean}`（required
   空；域校验在工厂：1–128 / 0–1_000_000 / bool）。
2. `registry.mjs`：`builtinWebuiPluginDescriptors()` 加入 import；`comingSoonPlugins()`
   删 `{id:"ai"}`。
3. `data-plane.mjs`：`buildPluginRuntimes()` 加 `createAiRuntime({home, fabric
   注入面, log, now})`——provider 侧挂 `createWpkRouter({gate})` 的 `/wpk1/ai/`
   子面；consumer 侧惰性（member 姿态才装配本地端点）。admin/member 双姿态
   共存（一台机可同时是提供方与消费方——按视角装配互不排斥）。
4. `sidecar.mjs`：`/sidecar/plugins/ai/<mgmt>` 管理面（服务 CRUD/密钥签发撤
   销/配额配置/用量查询；Host 守卫+精确 Origin 沿用）。
5. UI：`plugin-registry.ts`（`#/p/ai/provider`、`#/p/ai/consumer`）；
   `plugin-pages.ts` 绑定层；页面组件 `ui/src/components/plugins/ai/`；
   `PluginPanel.svelte` META 中文名「AI 订阅共享」。
6. 生命周期：onEnable=装配（provider wpk 面 + consumer 端点恢复）；停用四步
   序（摘牌→drain 10s→dispose（本地 listener 全关、在途上游 abort）→落盘）。
7. 数据目录：`<DWEB_HOME>/plugins/ai/`（0700；secrets/services/quota-day/
   keyring/usage.jsonl 全 0600，写原语用 opendweb `atomicWrite0600` 家族）。

## 2. 两层准入与凭证模型

设备层=fabric 邀请（dweb1.，内核既有）；应用层=分组密钥（`sk-aifly-`
CSPRNG，SHA-256+salt 哈希落台账，timingSafeEqual 校验）。wpk1 gate
（peer×plugin×op deny-by-default）先过，ai 层密钥校验后过——独立失败面。
分享链接沿用 ai-fly `aifly1.` 信封语法（一邀请+一密钥；URL-safe base64）：
**v1 保持 ai-fly 语法**（移植保真、继承其测试矩阵与既有用户肌肉记忆）；
rebrand（`sk-dweb-ai-`/`odai1.`）列为 Codex 轮征询项，若改则改常量单点。

**撤钥语义冻结：drain 不硬断。** 撤 key 后：新请求 401；既有在途请求按流
完成（与 ai-fly 语义一致，实现最薄）；目录/授权缓存 refresh 重算。

## 3. wire 面：`/wpk1/ai/v1/*` 与响应中继（本设计最关键决策）

ai-fly 自有 wire（AUTH/REQ/RESP 帧）作为 body 协议挂到 wpk1 版本化前缀：

- `POST /wpk1/ai/v1/auth`：body=auth 帧（key）→ 授权目录 + 密钥指纹 +
  catalog revision。
- `GET /wpk1/ai/v1/catalog?since=<rev>`：目录快照；**长轮询 ≤30s**（变更即
  返回；超时返回当前值+新 rev）。v1 不做服务端推送（ai-fly catalog-watch
  语义降维，简化实现；推送列后续）。
- `POST /wpk1/ai/v1/request`：body=REQ 帧（serviceId/路径/头白名单/体分块）。
- `POST /wpk1/ai/v1/response/<responseId>/<seq>`：**响应分片拉取**（见下）。

### 响应中继=逻辑流分片（不动内核包络）

内核 v1 包络（1MiB 单帧、单流 2MiB、在飞 8MiB）对「单 HTTP 流」设预算；
LLM 响应无界。方案：**provider 把上游响应缓冲成有界分片，consumer 以独立
短请求逐片拉取**——每次 `response/<id>/<seq>` 是一个 ≤1MiB 的完整 wpk1
请求/响应（天然落在包络内），总量无上限：

```
consumer                          provider
  ├─ POST request ────────────────▶ 起上游转发，得 responseId
  │   ◀── {responseId, status, headers}（首个元数据帧，立即返回）
  ├─ POST response/rid/0 ────────▶ {chunk bytes ≤1MiB, seq, done?}
  ├─ POST response/rid/1 ────────▶ …（在飞拉取窗 ≤2 并发）
  │    （provider 端：response ring buffer 有界（默认 2MiB/请求）；
  │     缓冲满→上游读暂停（背压）；缓冲浅→恢复读）
  └─ …直到 done；异常→显式 error 帧（consumer 抛出，绝不静默截断）
```

- 请求体：≤1MiB 静态分块沿内核惯例；超限 413。
- SSE 语义：chunk 即 SSE 事件块边界（ai-fly 已保证逐块 flush 透传；本地端
  点收到即向下游 flush）。延迟代价：每 chunk 一 RTT——flush 策略 =首 chunk
  立发 + 后续 `min(256KiB | 50ms | 上游块边界)` 攒批（实现期可调常量）。
- 取消：consumer 本地连接断 → abort 在飞拉取 + `POST response/rid/cancel`
  → provider abort 上游 signal（ai-fly abort 传播链原样）。
- 恢复窗口：fabric 90s 会话恢复语义覆盖单次拉取；responseId 缓冲跨恢复存活
  （provider 端 TTL 120s，超时显式失败帧）。
- **open question（Codex 轮）**：内核若后续开放 per-plugin 长流预算豁免，
  本中继可平滑升级为单流增量帧（接口已按帧序列设计，consumer 侧无感）。

### 在飞/并发预算

分组 maxConcurrency（默认 8，config 可调 1–128）计**在途上游请求**（拉取
窗内多片属同一请求不重复计）。全插件在飞字节数沿用内核 8MiB 门（wpk router
层既有）；provider 端 ring buffer 总量默认 16MiB（并发×单请求缓冲）有界。

## 4. auth 槽三族与 `$env` 移除（W11 收敛）

- 保留：`{secret:<name>}`（密钥库）、`{script:<name>,args}`、`{literal:<v>}`
  （literal 间接引用**仅** `$secret:<name>`）。
- 删除：`$env:` literal 形态、`hooks/env.cjs`、hook 四阶段中一切
  `process.env` 凭证读取。
- **存量迁移**：从 ai-fly 导入 services.json 时遇 `$env` 条目 → 导入失败并
  逐条列出（服务名/字段/`$env` 引用名），指引转 `{secret:}`；不做任何自动
  env 快照（那等于把 env 凭证固化进文件，违背 W11 精神）。
- codex hook 原样：只读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`），
  注入 codex CLI 同款头集；user-agent 去掉 codexHome 路径（ai-fly 已知信息
  泄露点，顺手修）。

## 5. rust-fetch sidecar 打包

- 源：ai-fly `sidecars/rust-fetch/`（rustls + HTTP/2 出站，stdio JSON 协议）
  复制为 `packages/opendweb-ext-ai/native/rust-fetch/`（同源标注）。
- 分发：workspace crate `crates/ai-rust-fetch` + `packages/ext-ai-binary`
  模仿 `@jixo/opendweb-server-binary` 的 pack.mjs（release 构建→vendored
  bin→CI 出 win32）。发现顺序：`EXT_AI_RUST_FETCH` 显式路径（仅调试用）
  > 包内 vendored 二进制 > **缺失**（codex 预设显式降级
  `rust_fetch_unavailable`，其余预设不受影响）。
- 凭证经 stdin 管道（JSON meta 行）不进 argv——ai-fly 原样，W11 合规。

## 6. 页面与交互（v1 范围）

- **provider 页**（admin）：服务列表（预设选择+自定义上游）→ 分组 → 密钥
  （签发一次性展示/copy；撤键即时）→ 配额设置 → 用量表（元数据聚合）。
  上游连通性探活（provider 本机直发 1 次 HEAD/最小请求，经同一 hook 管线）。
- **consumer 页**（member）：贴 `aifly1.` 链接/分别输入邀请+key → 目录列出
  可用服务 → 每服务显示本地端口（可改，冲突真实报错）→ 写手两段式写入。
- 面板 META：「AI 订阅共享」；禁用态下本地端点全部关闭（生命周期 dispose）。

## 7. 测试策略

1. **单测（继承 ai-fly 矩阵）**：auth/limits/secrets/rewrite/detail/frames
   的 ai-fly 测试随源移植（vitest→node --test 语法转换；包跑器=node --test
   对齐仓库惯例）；fake 注入面（fabric/hook/上游）不触原生模块。
2. **wire 单测**：wpk router `/wpk1/ai/v1/*` 全 op（auth/catalog/request/
   response 分片/cancel）× 预算边界（1MiB±1、并发+1、缓冲满背压）× 双层
   准入（gate 过/key 错、gate 拒/key 对）。
3. **e2e（双进程真内核）**：A/B 两 home 真 fabric（ext-cf/hub-process 同款
   骨架）：全链路（链接导入→auth→请求→SSE 长响应>4MiB→撤钥→配额→重启
   持久化）。
4. **泄露面扫描测试**：e2e 后扫描 argv/env/日志/usage.jsonl/stderr 断言零
   凭证（requirements 安全基线 Scenario 的可执行化）。
5. **回归门**：webui 262 + plugins-host/sidecar/route/wire 既有面零回归；
  三插件 e2e 零回归。

## 8. 风险与分期

- **P0 风险**：响应中继的背压正确性（ring buffer 满死锁/恢复窗口内
  responseId 失效竞态）——测试 §7.2/§7.3 重点覆盖；hono 与 webui 宿主
  共存（依赖面冲突）——ext 包独立 node_modules，宿主不 import hono。
- 分期：Phase A（provider 纯逻辑+wire 面+单测）→ Phase B（consumer 端点+
  中继+e2e）→ Phase C（UI 页组+占位替换+回归门）→ Phase D（codex hook+
  rust-fetch 打包+写手）→ Phase E（specs 归档同步+walkthrough 文档）。
- 不做（v1 明确出界）：WS 透传、cursor/cline/continue 写手、catalog 服务端
  推送、CLI 插件面、$env 凭证、Linux 原生二进制、非回环监听。
