# 实现终审 r1 修复 receipt —— ai-subscription-sharing（P1 全量 + P2 除大扫除外全量）

> worktree `/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-wt-ai`（分支
> ai-subscription-sharing，基线 7c1b70c，未提交——任务约束）；2026-10-02。
> 输入：`/tmp/codex-ai-impl-r1.md`（Codex 实现终审 6.8/10 NOT-READY）。
> 本轮逐条关闭 P1-1..P1-8 与 P2-1..P2-4 + P2-5（约定范围内的窄面）。

## 一、逐条处置表

| 条目 | 修复（文件:面） | 回归测试（文件:用例） | 结果 |
| --- | --- | --- | --- |
| P1-1 单飞位漏 ready 路径 | `src/provider/relay.mjs` `pull()` 重构：第 1 轮锁内**先占位再裁决**（ready/terminal/hold 统一），`finally` 锁内释放（释放登记晚于并发第二拉取的裁决注册——微任务 FIFO 保证并发窗内恒见占位）；终态摘要重放面（无 Entry/锁）补 `replayInFlight` 集合占位（同步决策+延后一拍释放） | `test/relay-fix-r1.test.mjs`：`P1-1: 已 ready 分片并发 pull——恰一个 200 一个 409`（含三并发=1×200+2×409、串行释放对照）；`P1-1: 终态摘要重放面并发 pull——恰一个 200 一个 409` | ✔ |
| P1-2 背压漏唤醒窗口 | `relay.mjs` `sink.chunk()` 重构：**「确认仍满 + 注册 waiter」并入同一锁内临界区**（条件变量模式——唤醒后回循环头部状态复查）；applyTerminal/dropEntry 既有 spaceWaiters 全量唤醒保留；`relay.dispose()` 增防御性收敛（残余活跃 rid error 终态→waiter 必然 resolve） | `test/relay-fix-r1.test.mjs`：`P1-2: 背压 waiter 注册×拉取交叉（微任务偏移 0..4）——producer 必被唤醒`（5 用例交叉调度注入）；`P1-2: closeAll…必然唤醒背压 waiter`；`P1-2: 空闲 TTL expiry（sweep 面）必然唤醒背压 waiter` | ✔ |
| P1-3 终态摘要无 TTL/sweep | `relay.mjs`：putSummary 记 `lastActivityAt`/`expiresAt`；`touchSummary`（LRU 触摸+TTL 续期——重放=拉取活动；墓碑仅触摸）；`expireSummary`（replay/sweep 前置判 TTL——过期**墓碑化** kind=expired，后续重放恒 404 response_expired）；sweep 遍历 summaries；sweep 计时器生命周期覆盖 summaries 存在期；`summaryBytes`/LRU 不变量集中于 put/touch/remove/expire 四入口（`summarySizes` 平行记账） | `test/relay-fix-r1.test.mjs`：`P1-3: 低 TTL 摘要过期后重放=404 response_expired（墓碑稳定）；重放续期；sweep 覆盖 summaries`（400ms TTL 探针：续期→过期 404 response_expired→墓碑稳定→inspect expired→cancel 同拍） | ✔ |
| P1-4 response 端点 1 字节 body | `src/wire/endpoints.mjs` `handleResponse`：`readBoundedBody(req, 0)` + 显式 `read.body.length > 0` 双保险 → 400 metadata_invalid | `test/wire-fix-r1.test.mjs`：`P1-4: response 端点 1 字节 body=400 metadata_invalid（relay 零触达）；空 body 对照放行`（单块 1 字节+分块 1 字节+pulls 计数=1） | ✔ |
| P1-5 serviceId 双源检错对象 | `endpoints.mjs`：调用面改 `serviceIdDuplicateSource(req.path, body) \|\| serviceIdDuplicateSource(path, body)`（path=x-odai-path 解析后上游路径；承载端点检测保留）；`serviceIdDuplicateSource` 查询串改 `URLSearchParams` 规范化 percent encoding（坏编码回退原始扫描） | `test/wire-fix-r1.test.mjs`：`P1-5: x-odai-path 查询串携带 serviceId（明文+编码变体）→400 且 forward 零调用`（明文+4 编码变体+无关查询对照+纯函数编码键断言） | ✔ |
| P1-6 staging 漏扫 auth:null 的 headers.$env | `src/provider/importer.mjs`：`headers.set` 扫描只依赖 `entry.headers`（与 auth 存在性解耦） | `test/envguard-importer.test.mjs`：`importer: staging——auth:null + headers.set $env 同样进 blocked（扫描与 auth 解耦；零 ready）` | ✔ |
| P1-7 公开 data/save 绕过激活门 | `src/provider/store.mjs`：`save()` 唯一落盘入口对相对**上次落盘基线**（`#persistedEnabled`，构造时自盘载初始化）「将启用」（新增启用/停用→启用翻转）的服务重跑 `assertServiceActivatable`——fail-closed 零写入（revision 不动、盘不变）；已启用存量不重判（secret 事后移除不毒化无关写路径/不阻碍停用——启用时点已过门）；transaction 回滚重写失败不吞原始错误 | `test/store-fix-r1.test.mjs`：`P1-7: 直接 data+save 绕过激活门→拒绝（ambient env 命中；fail-closed 零写入）`；`P1-7: 绕过探针——未绑定 secret 的停用服务直接启用+save→拒绝`（含直接塞入 data 条目+高层对照放行）；`P1-7: 已启用存量不重判——secret 事后移除不毒化/不阻碍停用` | ✔ |
| P1-8 错误投影泄名/路径 | 新增 `src/redact.mjs`（**单一脱敏层**：code→固定 HTTP 状态+固定文案；激活门三分支保留 keyEnv 变量名（规范许可）剥离服务/secret 名——「bind its credential via the {secret」短语冻结保留供 webui 断言；`diagnosticLogLine`=code+类名结构化诊断）；`src/mgmt.mjs` 全部 catch 改经 `sanitizedErr`+外层 `handle()` 兜底（腐坏 store 打开等路由体外异常不再透出）；`import-stage/commit` 解析失败固定文案（不含 ai-fly 文件名）；fabric invite/写手 io 族固定文案；`store.mjs` StoreError 增 `details`（gate/keyEnv 安全字段）；`importer.mjs` mapping 错误去 secret 名；`keyring.mjs` 腐坏文案去路径；`runtime.mjs` 账本腐坏文案去路径+code=corrupt；`wire/endpoints.mjs` handler 兜底日志改结构化（无 message） | `test/e2e/leak-scan.test.mjs`：`leak-scan: 管理面错误投影固定脱敏——腐坏/激活门/secret 操作零名称零路径（响应+日志）`（①腐坏 services.json→固定 500 文案 ②激活门三态（unbound 短语/missing-secret 零 secret 名/ambient 409 含 keyEnv 不含 secret 名+干净对照放行）③secret 操作三面（ghost 删除固定 404/非法名固定 400/腐坏 secrets.json 固定 500）④overview UI 投影值零回显+auth 槽掩码 ●；全部扫描响应+日志：`zzleakprobe-secret|services\.json|secrets\.json|keyring\.json|<home 路径>` 零命中） | ✔ |
| P2-1 hold 预中止竞态 | `relay.mjs`：`addEventListener` 后同步复查 `signal.aborted` 补发 onAbort（ai-fly engine.ts 5.2-P1 同款） | `test/relay-fix-r1.test.mjs`：`P2-1: 预中止复查——初始检查后、监听注册前中止的 signal 秒回 null（不等 hold）`（queueMicrotask 注入窗口+holdMs=5000 下 <1.5s 返回+未中止对照 204） | ✔ |
| P2-2 listener 启动后持久化失败不回收 | `src/runtime.mjs` `startConsumerEndpoint`：`saveEndpoints()` 失败→摘账本条目+`listener.close()` 后上抛（端口真实释放） | `test/runtime-fix-r1.test.mjs`：`P2-2: startService 后 saveEndpoints 失败→close listener+移除账本条目（同端口可重试）`（0500 收写注入→失败上抛→账本无孤儿→同端口重试 200→stop 后全 stopped） | ✔ |
| P2-3 catalog 坏 percent encoding 500 | `endpoints.mjs` `handleCatalog`：`decodeURIComponent` try/catch → 400 metadata_invalid | `test/wire-fix-r1.test.mjs`：`P2-3: catalog since 坏 percent encoding →400 metadata_invalid（非 500）`（`%zz`/`%E0%A4%A`/`%`+合法对照） | ✔ |
| P2-4 leak-scan 覆盖不足 | `test/e2e/leak-scan.test.mjs` 主用例扩展：AUTH body 保留为合法凭证载体（注释明示）；非 AUTH wire 面/提供方日志/keyring.json **内容**增加名称+路径结构化断言（secret 名/存储文件名/本地绝对路径零命中） | 同文件主用例（`leak-scan: 全链路后 argv/env/日志/usage/错误体零凭证；keyring 0600`——⑥⑦⑧段扩展） | ✔ |
| P2-5（部分，按简报范围）| `packages/webui/src/index.d.ts`：`builtinWebuiPluginDescriptors` 注释改「内置四插件（ports/files/sync/ai——ai 自 Phase C 实现入册）」；`comingSoonPlugins` 改「vpn/clash/ssh/screen——ai 已实现入册不在列」（与 registry.mjs 实现对齐）。ext-ai 关键注入面 any→具体形状：`wire/endpoints.mjs` 增 `WireHandlerRequest`/`WireHandlerResponse` typedef 并替换全部 handler 签名+forwardPlane 注入面；`runtime.mjs` wireHandler 面；`consumer/join.mjs` fabric fetchImpl 面。（未做全量 46 处清扫——按简报「关键面即可」） | webui 既有套件（267/267 含 plugins-ai/contract 面）+ ext-ai 150/150 | ✔ |

### 与冻结规范的关系（无冲突声明）

- P1-7 选择终审给出的方案 (b)（唯一写入口落盘前重跑激活门），并按「**将启用**」
  措辞实现为相对落盘基线的翻转判定——已启用存量不重判：启用时点已过门，
  secret 事后移除不得毒化无关写路径/阻碍停用（全量重判会造成「删 secret 后
  无法停用服务」的死锁面）。终审复现探针（`data.services[0].enabled=true;
  save()`）与直接塞条目探针均被拒（见测试）。
- P1-8 中 keyEnv 变量名与 webui 断言短语（`bind its credential via the {secret`）
  按规范/既有契约保留；secret **名**在管理面清单/绑定视图是合法本机管理数据
  （绑定 UX 必需，值恒掩码/零回显）——错误投影面零名称零路径。
- P1-3 过期摘要采用**墓碑化**（kind=expired）而非直接删除：过期后的重放恒
  404 response_expired（与活跃条目过期语义同拍；直接删除会退化为
  response_not_found，与 §3.2 语义不符）。重放=活动续期（空闲 TTL 自最后
  拉取活动起算——与活跃条目同拍）。
- P1-5 双源检测保留承载端点 path 检测（既有冻结契约测试要求）并补齐
  x-odai-path 解析后上游路径检测（终审要求）——两面并检。

## 二、门命令与输出尾

### 1. `cd packages/opendweb-ext-ai && npm test`

- runner：`node --test --test-concurrency=1 --test-force-exit "test/*.test.mjs" "test/e2e/*.test.mjs"`
  （package.json test glob 本轮纳入 `test/e2e/*.test.mjs`——全部新回归用例
  进门；e2e 基线 4 用例已先独立复跑确认绿）
- **exit code 0**（150=原 126 + relay 11 + wire 3 + store 3 + importer 1 + runtime 1 + e2e 5）

```
ℹ tests 150
ℹ suites 0
ℹ pass 150
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 25940.633416
```

### 2. `cd packages/webui && env -u OPENAI_API_KEY npm test && npm run build`

- **test exit code 0**：

```
ℹ tests 267
ℹ suites 0
ℹ pass 267
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36393.028875
```

- **build exit code 0**（仅 chunk>500kB 既有警告）：

```
../dist/assets/index-3vC2GXUu.css                              90.55 kB │ gzip:  15.68 kB
../dist/assets/index-3p9XqQWY.js                              600.23 kB │ gzip: 178.21 kB
✓ built in 20.15s
```

### 3. ports / files / sync（零回归）

- `cd packages/opendweb-ext-ports && npm test`（**exit 0**）：

```
ℹ tests 43
ℹ pass 43
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4742.452667
```

- `cd packages/opendweb-ext-files && npm test`（**exit 0**）：

```
ℹ tests 59
ℹ pass 59
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5977.461333
```

- `cd packages/opendweb-ext-sync && npm test`（**exit 0**）：

```
ℹ tests 74
ℹ pass 74
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 53777.854083
```

## 三、变更清单（未提交——任务约束不 git commit）

修改：`packages/opendweb-ext-ai/{package.json, src/consumer/join.mjs, src/consumer/keyring.mjs, src/mgmt.mjs, src/provider/importer.mjs, src/provider/relay.mjs, src/provider/store.mjs, src/runtime.mjs, src/wire/endpoints.mjs, test/e2e/leak-scan.test.mjs, test/envguard-importer.test.mjs}`、`packages/webui/src/index.d.ts`
新增：`packages/opendweb-ext-ai/src/redact.mjs`（单一脱敏层）、`test/relay-fix-r1.test.mjs`、`test/wire-fix-r1.test.mjs`、`test/store-fix-r1.test.mjs`、`test/runtime-fix-r1.test.mjs`
零新依赖（仅 node 内建+zod 既有）；凭证纪律不变（AUTH 唯一呈交通道、原文仅签发/链接本地面、远程面恒掩码）。

## 四、常驻进程回收证据

- 测试面：runner 为 `node --test --test-force-exit`（进程退出即回收）；本轮
  运行后 `ps aux | grep "node --test"` 零命中、`lsof -iTCP -sTCP:LISTEN` 无
  本轮测试遗留监听（现存 listener 均为用户既有会话：design.mjs:5399、
  webui cli:18801、贴钻-backend、opendweb hub——非本轮产物，未触碰）。
- 测试内显式回收：relay 用例逐个 `relay.dispose()`；P2-2 用例断言 stop 后
  全部 listener=stopped 且**在测试体内证明失败路径 listener close**（同端口
  重试成功=端口真实释放）；上游 listener `t.after(() => up.close())`。

## r3 处置追加（2026-10-02，编排者直修）

- P0-1：preview/apply 拆 canonical（内部，写盘+令牌源）与展示面（掩码：敏感键名[auth/token/key/secret/password/credential]取值+sk- 前缀值→●●●●；占位符 sk-aifly-local 豁免；非敏感键如 BASE_URL 保持可见）；回归=既有真实 token 零入响应+apply 写 canonical 保留其它 env 真值+占位符。
- P1-2：save() 落盘前全服务 SERVICE_STORE_SCHEMA 终审+槽规范化（auth.literal/headers.set 的 $env 双探针拒绝，revision/盘上不变；普通字面量放行）。
- P1-3：detail.mjs 新增 safeCatalogEntry（顶层白名单+detail 重建白名单键+凭证/脚本键恒掩码+坏形状 null）；GET /consumer 与 join.importLink 两侧接入（恶意快照零凭证外泄回归）。
- P2-4：C-2 夹具修正（fetchHttpImpl+sessionResolver 真会话+start 异常记录）。
- 门：ext-ai 158/158（两轮稳定）· webui 267/267。
