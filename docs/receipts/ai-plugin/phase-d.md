# Phase D 门 receipt —— ai-subscription-sharing

> worktree `/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-wt-ai`（分支
> ai-subscription-sharing，基线 744fca3——A/B/C 已提交）；2026-10-02。
> Phase D = D1 claude-code 写手 + D2 上游探活 + D3 17 预设冒烟 + 顺手项
> （B 端点「A 已停用」错误码 internal→upstream_unreachable 502 族——phase-c
> 走查备忘的正式闭合）。

## D 门命令与输出尾

### 1. `cd $WT/packages/opendweb-ext-ai && npm test`（含 D1-D3 新用例）

- runner：`node --test --test-concurrency=1 --test-force-exit test/*.test.mjs`
- **exit code 0**

```
ℹ tests 126
ℹ suites 0
ℹ pass 126
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11486.558375
```

新增测试文件（4）+ 用例（15）：consumer-writer（5——compose 占位符纪律/
surgical 合并/拒绝非对象 JSON/anthropic base 推导/两段式 sha256 令牌+0600+
stale 拒绝/mgmt 端点接线）；provider-probe（4——同一管线可达+Bearer secret
断言/连接拒绝+超时+pattern-only 三不可达/keyEnv 未绑+secret 缺失两 no_auth/
mgmt probe 端点+404）；presets-smoke（4——17 预设逐项/codex 占位/激活门逐
预设/auth 三族矩阵）；gateway-error-family（2——sessions 嵌套 error.code 解析/
gateway 提供方不可用族→502 upstream_unreachable 脱敏）。
基线 94→126（Phase B/C 后全量重跑 +1 e2e 附验 exit 0）。

### 2. `cd $WT/packages/webui && npm test`（写手 UI 接入后零回归）

- **exit code 0**

```
ℹ tests 267
ℹ suites 0
ℹ pass 267
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21695.765541
```

含新增第 ⑤ 用例「mgmt probe: POST /services/:id/probe three-state over the
sidecar HTTP chain」（本地 fake 上游 401=可达；写路由 Origin 纪律 403；未知
服务 404；脱敏投影断言）。

### 3. `cd $WT/packages/webui && npm run build`

- **exit code 0**（vite build 4.47s；chunk >500kB 警告为既有基线，非本次引入）

```
../dist/assets/index-3vC2GXUu.css    90.55 kB │ gzip:  15.68 kB
../dist/assets/index-3p9XqQWY.js    600.23 kB │ gzip: 178.21 kB
✓ built in 4.47s
```

dist 产物含写手/探活面（grep 实证：`consumer/writer/preview`、
`sidecar/plugins/ai/services/`+`/probe`、探活文案均在 bundle 内）。

## D1 写手 preview/apply 示例（真实执行捕获；tmp home 隔离）

预置既有 `~/.claude/settings.json`（含 `permissions.allow` 与 `env.FOO`）后：

```diff
--- …/.claude/settings.json
+++ …/.claude/settings.json
@@ -5,6 +5,8 @@
     ]
   },
   "env": {
-    "FOO": "keep-me"
+    "FOO": "keep-me",
+    "ANTHROPIC_BASE_URL": "http://127.0.0.1:43001",
+    "ANTHROPIC_AUTH_TOKEN": "sk-aifly-local"
   }
 }
```

- preview：`{exists:true, baseUrl:"http://127.0.0.1:43001"（anthropic 路由
  /v1 剥版本段）, tokenSha256: 083289f3135d8e3c…}`；permissions 等兄弟字段原样。
- apply（tokenSha256 一致）→ 落盘 0600，`ANTHROPIC_AUTH_TOKEN` 恒占位符
  `sk-aifly-local`——**真实凭证绝不写入**（测试断言：钥环真实密钥材料
  `sk-aifly-REAL-KEY-MATERIAL…` 不出现在产物）。
- stale 拒绝：令牌不符 / 预览后盘面被外部改动 → `409 stale-preview` 零字节
  写入（测试断言文件内容保持外部版本）。
- mgmt 面：`POST /sidecar/plugins/ai/consumer/writer/preview`（端点不在监听
  =409；账本无此端点=404）与 `POST …/writer/apply`（409 stale-preview）。

## D2 探活三态（真实执行捕获）

- reachable：fake 上游 401 → `{state:"reachable", status:401}`——任意 HTTP
  状态即达；同管线断言：GET 走路由白名单首条 prefix 路由（/v1→/v1）、
  `authorization: Bearer sk-real-upstream-value`（① auth 槽）。
- unreachable：连接拒绝→`upstream_unreachable`；接受连接但 5s 不应答→
  `timeout`；pattern-only 路由→`path_not_offered`（不绕白名单）。
- no_auth：keyEnv 未绑 auth 槽→`keyenv_unbound`（零上游触达）；已绑 secret
  库中缺失→`secret_missing`。
- 脱敏：结果投影仅 state/status/reason/keyEnv/ms——零头表、零 URL、零原始
  错误文案（测试 grep 断言）。

## D3 17 预设冒烟清单（逐项：展开/路由白名单/Bearer 注入/白名单外拒；keyEnv 门）

```
openai           port=4300  keyEnv=OPENAI_API_KEY   upstream=https://api.openai.com                    routes: openai-chat+openai-responses /v1->/v1
anthropic        port=4301  keyEnv=ANTHROPIC_API_KEY upstream=https://api.anthropic.com                routes: anthropic /v1->/v1
deepseek         port=4304  keyEnv=DEEPSEEK_API_KEY  upstream=https://api.deepseek.com                  routes: openai-chat+openai-responses /v1->/v1 ; anthropic /anthropic->/anthropic
gemini           port=4302  keyEnv=GEMINI_API_KEY    upstream=https://generativelanguage.googleapis.com/v1beta
openrouter       port=4303  keyEnv=OPENROUTER_API_KEY upstream=https://openrouter.ai/api/v1             routes: openai-chat /v1->/api/v1
zai              port=4305  keyEnv=ZHIPU_API_KEY     upstream=https://api.z.ai/api/paas/v4
zai-coding       port=4307  keyEnv=ZHIPU_API_KEY     upstream=https://api.z.ai/api/coding/paas/v4
zai-cn           port=4308  keyEnv=ZHIPU_API_KEY     upstream=https://open.bigmodel.cn/api/paas/v4
moonshot         port=4309  keyEnv=MOONSHOT_API_KEY  upstream=https://api.moonshot.cn/v1                 routes: openai-chat /v1->/v1 ; anthropic /anthropic->/anthropic
minimax          port=4311  keyEnv=MINIMAX_API_KEY   upstream=https://api.minimax.io/anthropic/v1
qwen-token-plan  port=4312  keyEnv=ALIBABA_TOKEN_PLAN_API_KEY upstream=https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
github-copilot   port=4313  keyEnv=GITHUB_TOKEN      upstream=https://api.githubcopilot.com
groq             port=4314  keyEnv=GROQ_API_KEY      upstream=https://api.groq.com/openai/v1
xai              port=4315  keyEnv=XAI_API_KEY       upstream=https://api.x.ai/v1
together         port=4316  keyEnv=TOGETHER_API_KEY  upstream=https://api.together.xyz/v1
ollama           port=4317  keyEnv=-                 upstream=http://127.0.0.1:11434/v1
lmstudio         port=4318  keyEnv=-                 upstream=http://127.0.0.1:1234/v1
```

逐项断言（presets-smoke.test.mjs）：

1. `presetToServiceInput` 展开正确：upstream=baseUrl、defaultPort、name=id、
   keyEnv 提示保留（无 keyEnv 不虚构）、路由白名单随预设携带。
2. 路由白名单：每条 prefix 路由的 whitelisted 路径构造出
   `baseUrl+upstreamPrefix+rest`（逐预设逐路由）；`/user`（个人信息端点形态）
   拒绝（PathNotOfferedError）；无路由预设裸透传不设白名单。
3. auth 绑定（{secret}）后 `authorization: Bearer sk-fake-<id>-value`（同一
   ① auth 槽——逐预设断言）。
4. codex 占位：curated 呈现 `{id:"codex", requires:"ai-codex-oauth",
   disabled:true}`；loadActivatablePresets 排除；presetToServiceInput 拒绝展开
   （文案含 ai-codex-oauth）。
5. keyEnv 门：15 个带 keyEnv 预设未绑 secret 全部被激活门拒
   （/bind its credential via the {secret/）；绑定后启用；ollama/lmstudio 免绑
   直接启用。
6. auth 三族矩阵：secret（库值+Bearer）/script（内建 secret hook 经 args.name）
   /literal（$secret: 间接引用+裸字面量 bearer:false 不拼前缀）；secret 缺失
   →secret_missing 不回退。

## 顺手项：B 端点「A 已停用」错误分族（phase-c 走查备忘闭合）

- sessions.mjs：错误体码位提取改双形态——ai handler 平铺 `{code}` 与内核
  wpk 路由嵌套 `{error:{code}}`（此前嵌套形态取不到 → 折叠 internal）。
- gateway.mjs：`classifyLocalError`——提供方不可用族
  {plugin-disabled, router-missing, unknown-plugin, internal} → 本地
  **502 upstream_unreachable** + 固定脱敏文案（不透传内核原文）；OpenAI 风格
  error JSON 形态不变（`{error:{message,type:"api_error",code}}`）；透传码族
  （rate_limited 429/key_revoked 403 等）不受影响（测试断言）。

## 文件清单

ext-ai（新增 2 + 修改 5 + 测试 4）：

- `packages/opendweb-ext-ai/src/consumer/writers/claude-code.mjs`（新——D1 核心）
- `packages/opendweb-ext-ai/src/provider/probe.mjs`（新——D2 核心）
- `packages/opendweb-ext-ai/src/mgmt.mjs`（+services/:id/probe、+consumer/writer/{preview,apply}）
- `packages/opendweb-ext-ai/src/runtime.mjs`（writerHome 注入+writerTarget/preview/apply）
- `packages/opendweb-ext-ai/src/index.mjs`（出口）
- `packages/opendweb-ext-ai/src/consumer/sessions.mjs`（双形态错误码提取）
- `packages/opendweb-ext-ai/src/consumer/gateway.mjs`（classifyLocalError 分族）
- `packages/opendweb-ext-ai/test/{consumer-writer,provider-probe,presets-smoke,gateway-error-family}.test.mjs`（新×4）

webui（修改 4 + 测试 1 + dist 重建）：

- `packages/webui/ui/src/lib/api.ts`（previewAiWriter/applyAiWriter/probeAiService+类型）
- `packages/webui/ui/src/lib/plugins-ai-controller.svelte.ts`（写手/探活状态与动作）
- `packages/webui/ui/src/components/plugins/ai/ConsumerPage.svelte`（写手区接真：选端点→预览 diff→确认应用→成功/失败反馈）
- `packages/webui/ui/src/components/plugins/ai/ProviderPage.svelte`（服务行「探活」按钮+三态结果）
- `packages/webui/test/plugins-ai.test.mjs`（+第 ⑤ 探活 HTTP 面用例）
- `packages/webui/dist/*`（build 产物——哈希轮换）

## 偏差与说明

1. 写手 apply 用 0600 原子写（atomicWrite0600 家族），**不保留既有文件 mode**——
   上游 ai-fly 覆盖时保留原 mode；本仓落盘纪律统一 0600（含凭据语义配置按
   私有文件处理），有意分歧。
2. 提供方不可用族的本地文案为**固定脱敏串**（不透传内核/传输层原始 message）——
   原文案可能含 provider 端内部信息；诊断信息保留在 provider 端日志，属脱敏
   取舍而非信息丢失。
3. pattern-only 路由服务探活=unreachable{reason:"path_not_offered"}——不合成
   白名单路径、不绕过路由白名单（探活与消费请求同管线约束）；17 预设无此形态。
4. 写手 home 缺省=真实用户 home（os.homedir()——Claude Code 读取处）；测试经
   createAiRuntime({writerHome}) 注入 tmp 路径，零触真实 ~/.claude（本机实测
   ~/.claude/settings.json mtime 未变）。
5. mgmt 探活对**任意存在服务**可用（含停用态——诊断价值）；no_auth 分诊仅拦
   keyEnv 未绑（hooks 预设模式有 hooks 声明时不拦——① 归脚本）。

## 回收证据

- ext-ai/webui 测试均 `--test-force-exit`，fake 上游/网关 listener 全部
  `t.after` 显式 close；跑后 `ps` 无本任务残留 node 进程（在场 node 进程
  ——主仓 webui cli(18801)/codex 会话——均非本次创建，未触碰）。
- /tmp 无 odai-* 残留（t.after rm 全清）；真实 `~/.claude/settings.json`
  mtime 2026-09-20 未变。
