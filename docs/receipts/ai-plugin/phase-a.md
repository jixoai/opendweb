# Phase A 门 receipt —— ai-subscription-sharing

> worktree `/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-wt-ai`（分支
> ai-subscription-sharing，基线 d030e8a）；2026-10-01。

## A 门命令与输出尾

### 1. `cd $WT/packages/opendweb-ext-ai && npm test`

- runner：`node --test --test-concurrency=1 --test-force-exit test/*.test.mjs`
- **exit code 0**

```
ℹ tests 94
ℹ suites 0
ℹ pass 94
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5864.380875
```

测试文件（12）：z32 / secrets / store / auth / limits / detail-match-uri /
hooks-rewrite / upstream / presets / envguard-importer / wire-contract + helpers
（矩阵=ai-fly test/unit 移植 vitest→node --test + design §7.2 wire 契约全清单）。

### 2. `cd $WT/packages/webui && npm test`（零回归）

- **exit code 0**

```
ℹ tests 262
ℹ suites 0
ℹ pass 262
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21073.363625
```

## 覆盖对照（design §7.2 清单 → 测试）

| 冻结面 | 测试（test/wire-contract.test.mjs 为主） |
|---|---|
| 404 同体三形态 byte 级（peer 未授权/op 未授权/未知子路径；不解析 key） | `wire: 404 同体三形态…`（三形态 body 与 NOT_FOUND_BODY 逐字节断言） |
| 三码分立独立用例（AUTH key_all_invalid / request key_invalid / key_revoked） | `wire: AUTH 三态…`、`wire: request 三码分立…`（三响应 body 两两不等断言） |
| 403/404/429/413 矩阵 | `wire: request 404 族…`（unknown_service 未知/停用/跨组 + path_not_offered 仅双过后）、`wire: 429 矩阵…`（rate_limited 并发与 quota_exceeded 日限独立码） |
| 413 边界 maxChunkPayload±1 | `wire: 413 边界…`（恰好=上限通过；+1 拒 413 且零 forward） |
| 400 头预算超限 | `wire: 400 元数据族…`（x-odai-* 合计 >8KiB → 400 metadata_too_large） |
| serviceId 双源拒绝 | `wire: request x-odai-service 唯一来源…`（query service/serviceId 与 JSON body 顶层 service/serviceId → 400 service_source_conflict） |
| AUTH 多 key 正/部分失败/全失败三态 fixture 序列化断言 | `wire: AUTH 三态…` + `auth.test.mjs`（AUTH_OK/AUTH_ERR schema 校验；rejected 仅 code 不带 keyId） |
| gate op 名 | `wire: gate op 名与路径解析矩阵`（ai/v1/{auth,catalog,request,response,cancel}；authorize 收到 gate op 名） |
| admission 超积拒启 | `wire: admission 域与超积…` + `wire: 工厂期拒绝…maxConcurrency`（域 1–32；×2MiB≤64MiB；33 拒启） |
| catalog ≤256KiB/≤256 服务 | `store: catalog ≤256 服务…`（服务数保存门）+ `wire: 工厂期拒绝——catalog JSON 超过 256KiB`（工厂期） |
| catalog since 长轮询 | `wire: catalog——…204/200/hold 唤醒…`（204+x-odai-rev、200 refresh:true+rev、hold 期间变更唤醒） |
| auth keys≤8 / response/cancel=Phase B | `wire: AUTH 三态…`（9 钥 400）、`wire: 错误方法与 Phase B 端点…`（response/cancel 当前 404 同体） |
| env 四面防线（§4） | store/hooks-rewrite/envguard-importer：`$env:` 构造期拒绝（声明面）、auth 路径无 env 分支+等值负向（脚本面）、keyEnv→secret 绑定门（预设面）、ambient env 两时点（启动+运行中启用原子拒绝；导入 commit 禁 env 快照） |
| 白名单外路径零触达 | `rewrite: 路由白名单…` + `upstream: secret_missing…path_not_offered 本地拒绝`（零 fetch 计数断言） |

## 常驻进程回收

- wire/upstream 测试起的 127.0.0.1 真上游 listener 全部 `t.after(() => up.close())`
  显式回收（closeAllConnections + close）；`up.activeConnections === 0` 有界等待
  断言见 `wire: 默认 forward 面…`。
- 门跑毕 `ps`/`pgrep` 复核：无残留 node --test / listener 进程。

## 变更面

- 新增 `packages/opendweb-ext-ai/`（src 26 文件——provider 17 + hooks 内建 2 +
  presets 2 + wire 3 + fsutil/index 2；test 12 文件；package.json/README）。
- `pnpm-lock.yaml`：+6 行（新 importer `packages/opendweb-ext-ai` → zod ^4.5.2，
  复用既有 store 版本；无其它包改动）。
- 内核/webui/registry 零改动（packages/webui、packages/opendweb、crates/ 未触碰）。
