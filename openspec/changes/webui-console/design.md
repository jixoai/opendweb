# Design: webui-console

## 0. 架构总览

```
浏览器（SPA，预构建静态资源）
   │  同源 http://127.0.0.1:<port>
   │  /api/* 不带任何凭证
   ▼
sidecar（node:http，零运行行时依赖）
   │  ├── 静态资源（dist/，随 npm 包分发）
   │  ├── Bearer 注入 + 反代 ──► 远端 dweb-server /admin/*（https 或 --allow-insecure）
   │  └── [Phase B] @jixo/opendweb-client-sdk native binding ──► 本地 fabric 数据面（--data-dir）
   │         （./admin AdminClient 复用为 sidecar 的远端客户端）
```

分发/启动：`opendweb webui` → marketplace 自适应解析（默认 glob
`npm:opendweb-*` 命中 `opendweb-webui`）→ 自愈安装 → plugin 契约派发
（packages/opendweb/src/plugin-contract.mjs 的 manifest/run 面即可，无需
生命周期 hooks）。

## 1. 包结构与构建

```
packages/webui/                    # npm name: opendweb-webui（unscoped）
├── package.json                   # exports: "." / "./opendweb-plugin"；bin: opendweb-webui（npx 直达）
├── src/
│   ├── cli.mjs                    # 入口：参数解析→token 获取→sidecar 启动（plugin run 的实现）
│   ├── sidecar.mjs                # node:http server：静态 + /api/* 反代
│   └── plugin.mjs                 # ./opendweb-plugin 清单导出（commands: [webui]）
├── ui/                            # SPA 源码（构建期，不发布）
│   ├── …（Preact + htm，Vite 构建）
└── dist/                          # 预构建静态资源（发布产物）
```

- **构建**：UI 源码 Vite 单页构建进 `dist/`；包发布物 = src + dist，安装方
  零构建。
- **UI 选型：Preact + htm**（无 JSX 运行时、无虚拟依赖链），理由：(a) 仓库
  无 React 既有投资；(b) 管理台是表单/表格/对话三件套，Preact 10kB 级足够；
  (c) 与 sidecar 的零依赖纪律匹配（依赖只在构建期，运行时是纯静态产物）。
  样式手写 CSS 变量主题（深/浅跟随系统），不引组件库——边界表格与确认对话
  自绘（<200 行）。

## 2. sidecar 语义（src/sidecar.mjs）

- **绑定**：`127.0.0.1` + 随机空闲端口（`--port` 覆盖）；启动后打印
  `http://127.0.0.1:<port>`（ASCII 纪律与 CLI 既有约定一致）。
- **token 获取优先级**：`--token` > `DWEB_ADMIN_TOKEN` > TTY 交互输入
  （readline，回显关闭；非 TTY 且无来源 → 报错退出，提示两种来源）。
  token 只驻内存；`/api/*` 请求处理器内注入后即弃；**日志脱敏**：sidecar
  日志只记 method/path/status/耗时，不记 headers。
- **反代面**：`/api/*` → `${server}/admin/*`（路径重写 `/api` → `/admin`）。
  仅允许 admin 面方法与路径（GET/POST/DELETE；白名单前缀 `/admin/`），其余
  404——sidecar 不是通用代理（防 SSRF 恶意页面借 sidecar 打内网）。
  **响应过滤**：透传 JSON body 与 status；剥除 `Set-Cookie`/`WWW-Authenticate`
  以外的 hop-by-hop 头。超时 10s（对齐 AdminClient 默认）。
- **明文告警**：`server` 协议非 https 且主机非 loopback → 无 `--allow-insecure`
  拒绝启动（exit 2 + 告警文案）；有 flag → 终端横幅 + UI 顶栏常驻警示条。
- **静态资源**：`dist/` 直读 + 内存缓存；SPA fallback 到 index.html（hash
  路由，无需服务端路由表）；`Cache-Control: no-store`（管理台数据不落盘
  缓存）。
- **Phase B 数据面**：`--data-dir` 时 lazy `import("@jixo/opendweb-client-sdk")`
  （optionalDependency 声明 + try/catch 缺失时 UI 降级提示安装命令——零
  安装用户不被 native 依赖拖累）。root 身份（roster 存在）→ 控制台全功能；
  成员身份 → 名册/邀请展示只读 + 受限操作（撤销/签发仅 root 可用，与 fabric
  语义一致，UI 灰化而非报错）。
- **进程生命周期**：SIGINT/SIGTERM → 关 fabric（若开）→ 退出；`--no-open`
  跳过浏览器打开（darwin `open`/其他平台打印 URL；打开失败仅打印）。

## 3. plugin 契约接线（src/plugin.mjs）

```js
// ./opendweb-plugin 导出（契约：plugin-contract.mjs PluginManifestSchema）
export default {
  name: "webui",
  apiVersion: 1,
  commands: [{
    name: "webui",
    description: "local management console (sidecar + UI)",
    args: {
      type: "object",
      properties: {
        server:   { type: "string" },   // --server URL
        token:    { type: "string" },   // --token（缺省走 env/交互）
        port:     { type: "number" },   // --port
        "allow-insecure": { type: "boolean" },
        "no-open": { type: "boolean" },
        "data-dir": { type: "string" },
      },
      required: [],
    },
  }],
  run: async (args) => import("./cli.mjs").then((m) => m.main(args)),
};
```

- 契约校验即插即用（zod safeParse 过 `PluginManifestSchema`；JSON Schema
  子集：object + string/number/boolean——现有契约面直接承载，**无需扩展
  plugin 契约**）。
- `npx opendweb-webui --server …` 与 `opendweb webui …` 同一入口（bin 指向
  cli.mjs）。

## 4. SPA 信息架构（Phase A → B）

- **路由**（hash）：`#/connect`（默认）→ `#/status` → `#/owners` →
  `#/connections` → `#/console`（Phase B，仅 --data-dir 时注册）。
- **状态**：极简 store（Preact signal 或 30 行 useState 组合）；轮询
  `/api/status` 与 `/api/connections`（5s，可暂停）；错误面呈现 AdminError
  的 code/reason（`admin-not-enabled` 提示远端未配 token；`unauthorized`
  提示检查 token）。
- **回执展示**：op 名称/时间/generation/签名前 16 hex + 复制全文（审计
  留痕靠复制，不做存储）。
- **断连确认**：对话展示 endpoint/fabric/连接数 → 确认 → 结果 + 回执。
- **token 表单**：`#/connect` 提交到 `POST /api/session`（sidecar 内存更新
  token 与 server URL；**不回显**——提交后表单清空，仅显示「已配置」+ 远端
  health 探测结果）。这一步让「先启动后粘贴 token」的流程可行（token 不必
  进命令行历史/ps 列表）。

## 5. 安全模型汇总

| 边界 | 机制 |
|---|---|
| token 泄露面 | 只驻 sidecar 内存；不落盘、不进浏览器、不进日志、`POST /api/session` 提交后不回显 |
| 明文公网 | 非 https 非 loopback 默认拒启；`--allow-insecure` + 双重横幅 |
| sidecar 滥用 | 绑定 127.0.0.1；`/api/*` 仅白名单 admin 路径与方法；非通用代理 |
| 浏览器同源 | SPA 与 API 同源（127.0.0.1:port），无 CORS 面 |
| UI 越权 | 不提供自注册/数据面凭证操作；变更动作二次确认 + 回执 |
| 数据面私钥 | Phase B 留 sidecar 进程（native binding 本地打开数据面）；UI 只见结果 |

**已知接受的残余**：本地恶意进程可访问 127.0.0.1 sidecar（无本地鉴权）——
与「本机已沦陷则一切皆失」的既有威胁模型一致（server.key/数据面同理）；
文档明示。bind 随机端口 + 短生命周期缓解探测。

## 6. 测试策略

| 面 | 测试 |
|---|---|
| sidecar 单测（node:test） | token 来源优先级、明文拒启/放行、/api 白名单（越界路径 404）、hop-by-hop 剥除、日志无 token、静态 fallback、no-store |
| plugin 契约 | manifest zod 过验、`--help` 零执行（CLI 契约测试既有面） |
| e2e（真 server） | 复用 sdk-mgmt-surface 的 Rust e2e 场景：起 restricted server → sidecar 连接 → fetch /api/status 断言透传 → 注册/断连全流程断言（node:test 驱动 fetch，不启浏览器） |
| UI 冒烟 | 构建 + `node --test` 对 dist 做 SPA fallback 冒烟；视觉验收走查（Owner） |
| Phase B | native binding optional 加载矩阵（装/未装 client-sdk）、root/成员身份功能矩阵 |

## 7. 分期

- **Phase A**（本 change 主交付）：sidecar + plugin 接线 + Server 管理视图。
- **Phase B**（同 change 内第二里程碑）：Owner 控制台（--data-dir + native
  binding + ./token 展示）。
- 依赖：sdk-mgmt-surface 全部（./admin、./token、connections/disconnect 路由）。
