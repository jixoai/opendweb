# Phase C Receipt — ai-subscription-sharing（宿主接线+UI）

> worktree `/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-wt-ai`（分支 ai-subscription-sharing，基线 9fc2c35 + 本轮工作树改动，未提交）。
> 统一跑器=node --test；工作目录=packages/*（下同）。日期 2026-10-01。

## C 门命令与输出尾

### 1. `cd packages/webui && npm test`（含新增视角/生命周期/管理面用例）

```
ℹ tests 266
ℹ pass 266
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21566.861709
exit=0
```

新增 `test/plugins-ai.test.mjs`（4 用例）：
- ai descriptor：子路径导出过 validateWebuiPluginDescriptor；registry 含 ai（ports/files/sync/ai 四内置）；coming-soon 不含 ai（vpn/clash/ssh/screen）；UI PLUGIN_ROUTE_REGISTRY `#/p/ai/provider`(admin)/`#/p/ai/consumer`(member) managed=true。
- data-plane：ai runtime 原生 PluginRuntime 形状（onEnable/onDispose/onConfigChange）；冷态 wireHandler 稳定 503；enable 后 wire 统一 404 纪律（未知子路径 byte 级 `{error:"not_found"}` 不解析 key）；dispose 幂等拆面；validateAiConfig 域校验（0/33/1,000,001/非 bool 拒）。
- 管理面（createSidecar 真实 HTTP + SDK 替身）：GET overview 基线 Host 守卫四态（200/200-缺失 Origin 放行/伪造 400/坏 Host 400）；POST secrets 写路由精确 Origin 四类（200/403/403/403）；提供方全流程（keyEnv 未绑定拒启 400 → 绑 secret 创建 200 → 分组 → 签发密钥（原文仅响应体）→ overview 掩码 ●/零 `sk-aifly-` 泄露 → aifly1. 链接（payload.key 复用已存 key）→ 撤钥三态呈现 revoked）。
- 生命周期：enable 恢复 consumer 本地端点（预置 keyring+账本 → 端口监听）→ disable 端点全关（端口拒连）+ wire 503（内核 gate 摘牌）+ 平面 dispose；账本保留；再 enable 恢复监听；state.json 落 disabled。

修正的既有期望（占位删除连带）：`plugins-host.test.mjs`（内置集 +ai）、`plugins-sidecar.test.mjs`（插件列表 +ai、coming_soon 去 ai）、`dispatch-fold.test.mjs`（临时项目镜像依赖 +opendweb-ext-ai）。

### 2. `cd packages/webui && npm run build`

```
✓ built in 4.50s
exit=0
```

dist 含 ai 页面（单 bundle 面证据）：`dist/assets/index-*.js` grep `p/ai/provider|p/ai/consumer` 命中 2 处；`AI 订阅` 中文文案在 bundle 内。

### 3. `cd packages/opendweb-ext-ai && npm test`（零回归）

```
ℹ tests 111
ℹ pass 111
ℹ fail 0
ℹ duration_ms 13129.597209
exit=0
```

注（时序抖动记录，非代码回归）：紧接 webui 全量套件后的一次实跑中 `relay-race: 满 buffer 背压…5MiB 分片` 出现一次 80!==79 计数抖动；该文件隔离复跑 3/3 绿、随后全量复跑 111/111 绿（负载敏感边界，源码零改动——与仓规「负载敏感测试先隔离复跑再定性」一致）。

### 4. 三插件回归（各单行执行）

```
ports: ℹ tests 43  ℹ pass 43  ℹ fail 0   exit=0
files: ℹ tests 59  ℹ pass 59  ℹ fail 0   exit=0
sync:  ℹ tests 74  ℹ pass 74  ℹ fail 0   exit=0
```

### 5. 走查脚本自验（C4 准备——编排者亲测用）

```
node scripts/walkthrough/ai-demo.mjs --exit
自验（SSE 往返）：PASS（含 data: 分片与 [DONE]）
  [tmp] homes removed
  [upstream] fake upstream closed
  [A] sidecar closed
  [B] sidecar closed
exit=0
```

## 进程回收证据

- 走查脚本 --exit 模式退出即回收（teardown 四步日志如上）；交互模式 Ctrl+C 同路径。
- 回收后核查：`pgrep -fl "ai-demo|opendweb-webui|sidecar"`（过滤 grep）无输出；`lsof -nP -iTCP:4310 -sTCP:LISTEN` 无监听。
- 测试套件常驻面：node --test --test-force-exit（既有门形态）；本轮无泄漏进程（上述 pgrep 为证）。

## 凭证纪律核查

- 密钥原文仅出现在 POST /keys、POST /link 的本地管理面响应体（127.0.0.1+Host/Origin 守卫内）；GET overview/consumer/usage 投影掩码（keyId/状态/长度指纹），测试断言列表零 `sk-aifly-`。
- secret 值只进请求体（写路由），响应只回名称/时间戳；日志（logAccess）只记 method+path+status。
- UI：issuedKey/issuedLink 一次性内存视图（关闭即清空），不落 localStorage/URL。
