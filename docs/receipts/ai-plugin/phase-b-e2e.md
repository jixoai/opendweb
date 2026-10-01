# Phase B 门 receipt —— ai-subscription-sharing

> worktree `/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-wt-ai`（分支
> ai-subscription-sharing，基线 43d099b=Phase A 提交；Phase B 改动未提交——
> 按简报「不 git commit」）；2026-10-01。

## B 门命令与输出尾

### 1. `cd $WT/packages/opendweb-ext-ai && npm test`（A 门命令，B 门复跑）

- runner：`node --test --test-concurrency=1 --test-force-exit test/*.test.mjs`
- **exit code 0**

```
ℹ tests 111
ℹ suites 0
ℹ pass 111
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9707.095417
```

测试文件（13）：Phase A 12 文件（94 用例零回归）+ **relay-race.test.mjs**
（design §7.3 竞态矩阵全清单 17 用例——见下「关键断言摘要」）。
唯一 Phase A 断言更新：wire-contract 路径解析矩阵补 `response/<rid>` 尾段
`{op:"response", tail:"abc:1"}`（B1 端点挂载所需；空 rid=未知子路径负向补例）。

### 2. e2e 单跑（B 门字面命令 `node --test test/e2e/` 在 Node 24.21 下目录实参
被 CJS loader 当模块解析——MODULE_NOT_FOUND；等价 glob 形式执行）

- 命令：`node --test --test-concurrency=1 --test-force-exit "test/e2e/*.test.mjs"`
- **exit code 0**

```
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

### 3. 三插件回归（各单行执行）

| 命令 | 用例 | exit code |
|---|---|---|
| `cd $WT/packages/opendweb-ext-ports && npm test` | 43/43 pass | **0** |
| `cd $WT/packages/opendweb-ext-files && npm test` | 59/59 pass | **0** |
| `cd $WT/packages/opendweb-ext-sync && npm test` | 74/74 pass | **0** |

## 关键断言摘要

### relay-race.test.mjs（§7.3 竞态矩阵→§3.2 冻结面）

- **满 buffer×0 拉取背压**：5MiB/64KiB 块快速产出、零拉取期上游 sentBlocks
  停在环上界不再增长（上游读暂停）；拉取驱动后 5MiB 字节全量相等（零丢失/
  保序/每片 ≤maxChunkPayload=1MiB−16KiB）、上游全部产出。
- **并发第二拉取**：hold 期第二 pull=409 `{code:"pull_in_flight"}`；首个拉取
  正常完成后单飞位释放。
- **fromSeq 越前**：fromSeq=5（chunk 0 未送达）=409 `invalid_from_seq` 且 ring
  不提前释放（fromSeq=0 仍可拉）；同 seq 重试=同内容重放（幂等）；推进后回退
  旧 seq=409。
- **首片 fromSeq=0**（cursor 初值 −1）+ **EOF 空流零分片立即 done 摘要**
  （200 零 body+x-odai-done:1+next-seq=0）。
- **204 hold**：hold 期产出即唤醒返回 200（实测 <2s，不等 4s hold 超时）；
  hold 超时=204+next-seq（holdMs=150 注入，实测 elapsed∈[140,2000)ms）；
  常量边界 CATALOG_WATCH_TIMEOUT_MS(20s) < 内核 head deadline(30s) 静态断言。
- **cancel×done 交叉**：先到 cancel 定终态+幂等同响应；cancelled rid 拉取=404
  response_not_found；上游连接关闭（abort 链）；done 后 cancel=幂等
  `{status:"done"}`；取消流占位即时释放（后续请求不受拖累）。
- **空闲 TTL**（idleTtlMs=250 注入）：200 拉取活动后静默→404
  `response_expired`+上游 abort；204 hold 不续 TTL。
- **绝对寿命**（absoluteLifetimeMs=600 注入，idleTtl=60s 不触发）：持续拉取
  保持活动仍到点 expired——先 abort 上游。
- **done 后旧 seq 不可拉**：多分片流 done 后任意旧 seq=摘要 200 零 body
  （body 分片即弃）。
- **provider 重启**：新 plane 新 epoch（CSPRNG）；旧 rid pull/cancel=404
  response_not_found；新请求正常且 epoch 不同。
- **断线续拉**：消费 3 轮后停 600ms（<idleTtl 8s）恢复——seq 严格连续
  （零重复）+SSE 字节全量相等（零丢失）。
- **撤钥三态**：①单钥撤销→新 request 403 `key_revoked`、其余 key 不受影响、
  在途 rid 按创建时快照续拉至 done（正例，拉取全程无 403）；②全钥失效
  drainForKeys(deadline 150ms)→未 settle 在途 abort `auth_revoked`（wire 拉取
  =503 显式错误）+上游 abort；③closeAll（会话收敛/dispose 面）→在途 aborted
  （拉取=504）+上游 abort。
- **env 等值负向**：ambient env 放入与槽等值/轮换值——上游恒收槽值
  （Bearer 槽值→轮换后新槽值）；槽删除=502 `secret_missing` 零上游触达
  （env 等值不得顶替）。

### e2e（relay-e2e + leak-scan）

- **全链路**：aifly1. 信封导入 keyring（0600）→AUTH 多 key groups→catalog→
  本地网关 127.0.0.1 listener→SSE 24 事件长响应**字节等同直连**（含撤中途键
  在途快照续传）；首分片相对延迟 <1500ms（注入面 in-process 相对断言——真双机
  LAN p95 留 Phase C/E）；白名单外路径 404 `path_not_offered` 零上游触达；
  撤钥后新请求=403 OpenAI 风格 JSON（code 透传 `key_revoked`）；provider 重启
  （epoch 更替）→旧钥 AUTH 全错 `key_all_invalid`、新钥全链路恢复。
- **配额**：dailyRequests=2→第三请求 429 `quota_exceeded`
  （type=rate_limit_error、code 透传）；provider「重启」（同 store）后同日
  计数仍在（quota-day.json 持久化）。
- **端口冲突**：占位端口真实 listen→明确报错（含端口与服务名，
  「no silent fallback」）；**WS v1 显式拒绝**：raw upgrade→400+
  `websocket passthrough is not supported` JSON、零上游触达。
- **凭据头剥离**：本地 authorization/cookie/proxy-authorization 到上游全 absent
  （上游断言锚点）；上游只见 provider 槽注入值。
- **泄露面扫描**：全链路（成功流/错误路径/usage 开启/撤钥/白名单 404）后
  argv、env 值、provider 日志、usage.jsonl、网关错误响应体、非 AUTH wire
  调用（request/response/cancel 的 path+头+body）对三密钥原文**零命中**；
  usage.jsonl 记录键集恰为 {ts,keyId,serviceId,status,bytes}；
  keyring.json/usage.jsonl 权限 0600。

## 进程回收证据

- 全部 listener/upstream 经 `t.after(() => xx.close())` 显式回收（close 前
  `closeAllConnections()`）；测试 runner 全部正常退出（exit 0）。
- 门跑毕核验：`ps -axo pid,command | grep -E "node.*(odai|relay|e2e|opendweb-ext)"`
  零匹配；`lsof -nP -iTCP -sTCP:LISTEN | grep node` 仅余无关会话进程
  （贴钻-backend 23573 / design.mjs 31619 / webui cli 33820——均非本测试
  起的进程，未触碰）。本包测试仅用随机空闲端口，无残留 LISTEN。

## 与 design §3.2 冻结面的偏差

**零。** 逐条对照：per-rid 互斥锁内全部转移（promise 链互斥+同步临界区双保险，
hold/背压等待在锁外=无锁内等待）、单飞 409、连续提交游标初值 −1/首片 seq=0/
fromSeq≠committedSeq+1 即 409、提交=下次拉取推进或终态确认、ring 槽仅随游标
推进释放、204 hold ≤20s 不续 TTL、responseId=<epoch>:<单调号>/epoch=CSPRNG/
重启旧 rid 404、空闲 TTL=最后 200 活动+120s、绝对寿命=创建+10min 到点先 abort
再释放、done EOF 分片带 done:1+此后摘要零 body+旧 seq 弃、终态摘要 LRU 独立
≤4MiB、满 buffer 背压、取消双向传播（本地断开→cancel→在途拉取 abort→上游
abort）、撤钥三态（①新 request 403+在途快照续拉；②5s drain auth_revoked；
③随会话收敛 closeAll）——全部按冻结文义实现并被上述用例覆盖。

**实现裁记（非偏差，供复核）**：
1. 隐式连续提交的确认上界=servedSeq（已送达分片）——「消费方下一次拉取
   fromSeq 推进」只释放**已送达**分片：防越前声明确认未送达分片（无 seq 空洞、
   无提前释放——冻结文义的两面兼得；同 seq 重试在 committedSeq+1 窗口内合法
   且同内容）。
2. meta 后上游中途失败投影为显式 error 终态（拉取回送映射 HTTP 错误——
   502/503/504 族+{code,message}）：requirements「断线/过期/竞态 MUST 显式
   错误，MUST NOT 静默截断成成功」的落点；§3.2 终态互斥集合（done|cancelled|
   expired）不因错误路径产生第二终态。
3. done 终态在「终态确认拉取」时定格（消费方见末片 done:1 后的 next-seq 拉取
   =确认+摘要）：末片保留可重放（丢包重试零损失）；消费方 sessions.forward
   常规路径必发确认拉取（占位即时释放）；无消费方确认时由空闲 TTL/绝对寿命
   有界收敛（无死锁路径）。
4. cancel 对已终态 rid 幂等回送 `{status:<终态kind>}`（done→"done"——先到定
   终态、后到幂等返回的落点；端点表 `{status:"cancelled"}` 覆盖真取消路径）。

## 改动清单（Phase B，未提交）

- 新增 `packages/opendweb-ext-ai/src/provider/relay.mjs`（响应中继状态机，
  ~700 行）
- 新增 `packages/opendweb-ext-ai/src/consumer/{keyring,join,sessions,gateway}.mjs`
  （B3 消费方四件；node:http 直挂零 hono）
- 改 `src/provider/forward.mjs`（B2：relay sink 接线+meta 即回+占位终态释放
  +dispose 面）
- 改 `src/wire/{endpoints,schemas}.mjs`+`src/provider/accept.mjs`（B1：
  response/cancel 端点挂载替换 404 占位；CANCEL_BODY_SCHEMA；parseWirePath
  尾段）
- 改 `src/index.mjs`（出口桶：relay+consumer 面）
- 新增 `test/relay-race.test.mjs`、`test/e2e/{relay-e2e,leak-scan}.test.mjs`
- 改 `test/wire-contract.test.mjs`（路径解析矩阵尾段断言）

## 遗留/风险

- **真双机 LAN p95 延迟断言**（元数据 ≤600ms/首分片 ≤300ms/分片间 ≤150ms）
  留 Phase C/E（B5 用注入面相对断言：首分片 <1500ms）。
- webui 262 面零回归属 C 门（B 门按 tasks 只跑三插件回归）。
- `node --test test/e2e/`（目录实参）在 Node 24.21 需 glob 形式
  `"test/e2e/*.test.mjs"`（receipt 已注明等价命令；如需字面命令可通过
  package.json script 固化——未动，避免超范围）。
- Phase C 待办：descriptor/registry/占位替换/生命周期四步序/UI（本 Phase 的
  fabric 注入面届时由宿主装配替换）。
