# 三用户故事 UX 修复——走查回执（2026-10-02）

Owner 指令：「你按照用户故事去修去走查吧」。目标：setup 页把三条用户故事同屏呈现，
且「管理本地连接」（故事 C）不再依赖先连上一台服务器、「连接本地服务器」（故事 B）
真正做到一键启动本地服务并连接。

## 变更面

| 层 | 文件 | 内容 |
|---|---|---|
| 本地控制面 | `packages/webui/src/core/home.mjs` | `ensureHubRunning`（可选 `hubInit --yes` → `hubStart` detached 自举 → `/healthz` 就绪轮询，全链复用 `packages/opendweb/src/hub.mjs`；零残留/0600 凭证语义不变）+ `readLocalHubToken` 导出 |
| sidecar 路由 | `packages/webui/src/core/sidecar.mjs` | `POST /sidecar/hub/start {initialize?}`：member 403 → `guardWriteOrigin`（精确 Origin）→ ensureHubRunning → 连接段仅 setup 态注入 target+token（磁盘态来源，与 row 2 同源；目标冻结模型不变，浏览器零 URL 输入）。row 2 daemon-down 启动即自愈；远端 ready 目标绝不改指。`hubLocal` 改 let（连接段接管时置位）+ `hubStart` 测试注入面 |
| CLI 导出 | `packages/opendweb/src/hub.mjs` | `resolveHubCtx` 导出（webui 侧构建完整 HubCtx） |
| UI api | `ui/src/lib/api.ts` | `startSidecarHub(initialize)` |
| UI store | `ui/src/lib/console.svelte.ts` | `startLocalHub`（connected → 清缓存/翻世界/落总览）+ `connectNodeFromSetup`（故事 C setup 直连）+ `hubStartBusy/Error` |
| UI 组件 | `ui/src/components/SetupWizard.svelte` | 三故事同屏：① 远程配对（原面不动）② 一键本机中枢（未初始化=「把这台电脑变成中枢」/ 已初始化未跑=「启动本机中枢并连接」/ 在跑=「连接本机中枢」；CLI 等价命令披露）③ 已保存节点列表（连接/删除 + 空态文案） |
| UI 组件 | `ui/src/components/HubStatusCard.svelte` | 主按钮改为真启动（经 sidecar 本地控制面；浏览器不直接管系统进程），复制命令降为等价替代 |

## 测试

- 新增 `packages/webui/test/hub-start.test.mjs`（10 用例）：守卫矩阵（member/404/Origin×3/坏 Host/字段白名单）、未初始化 409 零 spawn、已在跑→setup 翻 ready+hub_local+Bearer=hub-token 注入、row 2 daemon-down 冷启动（spawn 替身拉起假中枢）、就绪超时 504、`ensureHubRunning` 真实 init 链（0600 落盘/pid 三元组）与端口被占零残留。
- **顺带修复潜伏回归（我方 `e82828f` 工作区解析回退暴露）**：`packages/opendweb/test/hub-state.test.mjs` 的 `default-not-started` 用例假设 `opendweb webui` 会插件解析失败快速退出——仓库内现在会真启动 sidecar 永不退出（execFileAsync 永挂 44 分钟并泄漏孤儿进程）。改为 `timeout: 2500` 限时收割，「零 hub 副作用」断言不变。
- 绿门：webui `npm test` 277/277 + `npm run build` ✓；opendweb `checkjs` ✓ + 全量 248/248 ✓。
- 走查中发现的既有事实（未改，仅记录）：nodesFile 路径为 `<DWEB_HOME>/.opendweb/nodes.json`（自定义 DWEB_HOME 时多一层 `.opendweb`，与 hub.json 直接落 `<home>/` 不一致）。

## ego-browser 真链路走查（space 44；双 temp home = 两台「机器」）

| 轮 | 场景 | 结果 |
|---|---|---|
| 1 | 故事 B 全新机：homeA（空）→ `opendweb webui` setup 页三故事同屏 → 点「把这台电脑变成中枢」 | ✓ 真实 `hubInit --yes`（8787/3340 自检）+ detached daemon + healthz → 世界翻 hub 总览（admin）；hub.json/hub-token(0600)/hub.pid 落盘；接入卡片（LAN 地址/短码/QR）完整。shots/01、02 |
| 2 | 故事 C：homeB 预置 nodes.json（指向 A 的中枢+token）→ setup 页故事③ 列出「书房中枢」→ 点「连接」 | ✓ setup 直翻 admin 总览（`#/overview`，管理面连接正常，目标掩码 8787）。shots/03、04 |
| 3 | 故事 B 变体 row 2 daemon-down：A 停 daemon（`hub stop --yes`）→ 重启 webui（row 2）→ 状态卡「启动中枢」 | ✓ daemon 拉起（healthz 200）→ 状态卡消失 → 「管理面连接正常」+ toast「中枢已启动」。shots/05、06 |

进程回收：两侧 sidecar、hub daemon、浏览器任务空间全部回收；8787/3340/18971/18972 释放
（用户自己的 `pnpm dev webui` bun 实例未触碰）。
