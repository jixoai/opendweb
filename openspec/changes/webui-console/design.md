# Design: webui-console

> r1 修订（2026-09-22）：按 codex-review-sdkmgmt-r1 处置 P0-3（配对面重设计，
> 目标冻结 + 一次性配对码 + Host/Origin 校验）、P1-5（URL/loopback 解析
> 边界）、P1-6（argv/env 可见性披露）、P1-7（契约不扩展 + run envelope
> 事实修正）、P1-8（Owner 控制台拆出为独立 change webui-owner-console）、
> P2-2（缺省 --server = setup 模式）。处置表见文末 §8。

## 0. 架构总览

```
浏览器（SPA，预构建静态资源）
   │  同源 http://127.0.0.1:<port>
   │  /api/*    业务代理（无凭证；目标冻结后才有意义）
   │  /sidecar/* 本地控制面（配对面；与 /api 物理分离）
   ▼
sidecar（node:http，零运行时依赖）
   │  ├── 静态资源（dist/，随 npm 包分发）
   │  ├── Bearer 注入 + 白名单反代 ──► 远端 dweb-server /admin/*（https 或 --allow-insecure）
   │  └── setup 配对面（一次性配对码）──► 设定目标+token 后冻结
```

分发/启动：`opendweb webui` → marketplace 自适应解析（`npm:opendweb-*` 命中）
→ 自愈安装 → plugin 契约派发。

## 1. 包结构与构建

```
packages/webui/                    # npm name: opendweb-webui（unscoped）
├── package.json                   # exports: "." / "./opendweb-plugin"；bin: opendweb-webui
├── src/
│   ├── cli.mjs                    # 入口：参数解析（URL/port 自担校验）→ token 获取 → sidecar
│   ├── sidecar.mjs                # node:http：静态 + /api/* 白名单代理 + /sidecar/* 配对面
│   ├── target.mjs                 # 目标 URL 守卫（绝对 http(s)、loopback 解析、冻结语义）
│   └── plugin.mjs                 # ./opendweb-plugin 清单导出
├── ui/                            # SPA 源码（构建期，不发布）
│   └── …（Preact + htm，Vite 构建）
└── dist/                          # 预构建静态资源（发布产物）
```

UI 选型维持 r0（Preact + htm；手写 CSS；理由不变）。依赖只在构建期，运行时
纯静态产物。

## 2. sidecar 语义（src/sidecar.mjs + target.mjs）

### 2.1 绑定与静态面（同 r0）

`127.0.0.1` + 随机空闲端口（`--port` 覆盖）；`dist/` 直读；SPA fallback
index.html（hash 路由）；`Cache-Control: no-store`。

### 2.2 目标生命周期（P0-3 处置核心）

**状态机**：`setup`（无目标）→ `ready`（目标冻结）→ 进程退出。**没有
运行时改目标路径。**

- **启动期设定**：`--server URL` + token（`--token` > `DWEB_ADMIN_TOKEN` >
  TTY 交互）。目标守卫通过即直接 ready。
- **setup 模式**（缺省 `--server`）：sidecar 打印访问 URL + **一次性配对码**
  （`crypto.randomBytes` 派生 8 位 base32；只进终端 stdout，不进任何 HTTP
  响应/日志）。浏览器配对面 `POST /sidecar/connect {pairing_code, server,
  token}`，防线三重：(1) 配对码单次匹配（成功或 10min 超时即失效，常时
  比较）；(2) Host 头 === `127.0.0.1:<port>`；(3) Origin 缺失或 === sidecar
  origin。三者全过 → 校验 server 守卫 → 存内存 → 冻结 → 配对码销毁。
  失败 wire（r6 冻结）：header/配对码/目标错误 → 400 + 错误码
  （`bad-pairing` / `bad-origin-host` / `invalid-request` / `bad-target`）；
  **并发单飞冲突 → 409 + `pairing-in-progress`**（r5-P0-1：配对码校验通过
  后、`await validateTarget` 让出事件循环前同步置 in-flight 锁——并发
  第二请求立即 409；validateTarget 失败 finally 恢复锁，bad-target 不烧码
  语义不变；成功提交前二次防御 `target-frozen`）。且**配对码连续失败 5 次
  即销毁**（防在线猜测）。
- **token 途径可见性（P1-6）**：`--token`/env 途径在 help 与启动横幅打印
  提醒（OS 级可见：history/ps/env）；推荐 TTY 或配对面。
- token 内存驻留纪律同 r0：日志只记 method/path/status/耗时。

### 2.3 目标 URL 守卫（P1-5 处置）

- 仅绝对 `http://`/`https://`（`new URL` 解析失败即拒）。
- 路径段拒绝 `..`/编码斜杠（`%2f`）/反斜杠；端口显式任意（admin 常驻非标
  端口），无端口默认 80/443。
- `http` scheme：hostname 为 `localhost` 或字面 loopback IP（`127.0.0.0/8`、
  `::1`、IPv4-mapped `::ffff:127.0.0.0/104`）直接放行；否则 DNS 解析**所有**
  A/AAAA 记录须全部为 loopback 才放行（`localhost` 字面量也走一次全记录
  校验，解析异常按非 loopback 拒）——非 loopback 结果即拒（未设
  `--allow-insecure` 时）。hostname 尾点剥除后判定；IPv6 zone-id 拒绝；
  无显式端口默认 80/443 并按此序列化进 Host header。**连接按解析后的 IP
  建立并显式设置 Host header / SNI**（解析一次缓存，防 TOCTOU rebinding）。
- `https` scheme：不做 IP 限制（公网正常形态）；连接同样按解析 IP + SNI。
- `--allow-insecure` 仅放宽「http 非 loopback」的传输加密判断；目标/路径
  校验恒全量执行。
- 不跟随重定向（3xx 按原状态透传给 UI 呈现）；不读 env 代理。
- **连接实现冻结（r2-P1-4）**：代理路径不用全局 fetch，用标准库
  `node:http`/`node:https` 的 `request()`——`options.host = 解析缓存 IP`、
  `options.servername = 原 hostname`（TLS SNI）、`headers.host = 原序列化
  host[:port]`（IPv6 字面量 bracket 序列化）；**逐请求新建连接**（无连接
  池生命周期问题），响应结束/abort 即 destroy socket。DNS 变更重解析仅随
  目标重设（冻结语义），请求内不复解析。
- **代理资源界（r2-P2-3）**：上游响应 body 上限 1 MiB（超限 abort + 502
  `upstream-too-large`）；上游响应头白名单透传（content-type/ etag 类 +
  状态码），其余剥除；请求 body 上限 64 KiB。

### 2.4 /api/* 代理面（r0 语义 + 修正）

- 路径重写 `/api/x` → `/admin/x`；方法白名单 GET/POST/DELETE。**入站
  raw path 先过独立解析函数（r2-P1-7）**：拒绝任何路径段含 `.`/`..`、
  percent-encoded 的 `.`/`/`/`\`、反斜杠、空段与重复斜杠；解析出单层
  admin 相对路径后拼接，并**再次断言最终远端 pathname 以 `/admin/` 开头**
  ——双保险防规范化差异把带 Bearer 的请求送出白名单。任一校验失败 = 404，
  且 MUST NOT 发出上游请求（单测以假上游断言零出站）。
- Bearer 注入（ready 态）；setup 态一律 503 `no-target`。
- 超时 10s；透传 JSON body 与 status；剥 hop-by-hop 头。**body 原样透传
  不重写**（错误 envelope 语义由远端负责，sidecar 不解释）。

## 3. plugin 契约接线（P1-7 处置：不扩展契约）

```js
export default {
  name: "webui",
  apiVersion: 1,
  commands: [{
    name: "webui",
    description: "local management console (sidecar + UI)",
    args: { type: "object", properties: {
      server: { type: "string" }, token: { type: "string" },
      port: { type: "number" }, "allow-insecure": { type: "boolean" },
      "no-open": { type: "boolean" } }, required: [] },
  }],
  run: async ({ command, args, log, cwd, stdout, stderr }) =>
    import("./cli.mjs").then((m) => m.main(args, { log, stdout, stderr })),
};
```

- run envelope 为契约既定的 `{command, args, log, cwd, stdout, stderr}`
  （plugin-contract.mjs:113 实测形态——r0 草案的 `run(args)` 写法有误，已修）。
- URL 格式/端口范围/互斥等校验在 cli.mjs 自担（契约不扩展 secret/format
  等 schema 能力）；`--token` 的可见性提示放命令 description 尾注（ASCII），
  help 渲染器原样呈现——**告警文案为冻结 fixture（r2-P1-5）**，help golden
  测试钉住；CLI parser 矩阵测试覆盖 `--token value` / `--token=value` /
  boolean `--allow-insecure=false` 形态；token 值 MUST NOT 进入 log 输出与
  任何错误字符串（测试断言）。
- `npx opendweb-webui` 同入口（bin → cli.mjs）。

## 4. SPA 信息架构

- hash 路由：`#/connect`（setup 态默认页：配对面）→ `#/status` → `#/owners`
  → `#/connections`。
- setup 态：所有业务视图挂「未连接」引导；配对面提交 {server, token,
  pairing_code}（配对码从终端抄录——UI 明示）。
- ready 态：轮询 `/api/status` + `/api/connections`（5s 可暂停）；AdminError
  code 呈现（`admin-not-enabled`→提示远端未配 token；`unauthorized`→提示
  重启换 token——目标冻结使然，UI 明示重启路径）；回执展示（op/ts/
  generation/签名前 16 hex + 复制全文）；断连二次确认（收敛语义：提交后
  有界轮询观测收敛，UI 呈现「已下发/收敛中」两态）。
- **失败态可测（r2-P2-4）**：SPA 的 API 访问收敛为单一可注入 `apiFetch`
  抽象层——单测注入 error fixture（not-enabled/unauthorized/http-502/
  network/timeout/断连未命中）断言各视图呈现（无错误风暴、重启提示可见），
  不依赖真实 server。

## 5. 安全模型汇总（r1 修订版）

| 边界 | 机制 |
|---|---|
| token 泄露面 | 只驻 sidecar 内存；不落盘/不进浏览器/不进日志；配对面提交后 token 输入框清空且不回显 |
| 外站提交/CSRF | 配对面三重防线：一次性配对码（仅终端可见）+ Host 校验（防 rebinding）+ Origin 校验；连败 5 次销毁配对码 |
| 目标劫持 | 目标生命周期内冻结；无运行时改目标路径；重指向 = 重启 |
| 明文公网 | http 非 loopback 默认拒启；--allow-insecure 仅放宽加密判断；解析-连接一致性防 rebinding |
| sidecar 滥用 | 127.0.0.1 绑定；/api/* 白名单 admin 路径方法；不跟重定向；不读 env 代理 |
| argv/env 可见性 | help/横幅披露；推荐 TTY/配对面 |
| UI 越权 | 不提供自注册/数据面凭证操作；变更二次确认 + 回执 |

**已知接受残余**（文档明示）：本机同用户恶意进程仍可读 sidecar 内存/注入
（与 server.key/数据面同威胁层级）；配对码防线的成立依赖终端与浏览器不同
时被攻击者控制。

## 6. 测试策略

| 面 | 测试 |
|---|---|
| target.mjs 单测 | URL 守卫矩阵（绝对 URL/..路径/编码斜杠/字面 loopback/localhost/DNS 解析 loopback 混合记录/rebinding 双解析）、allow-insecure 只放宽加密 |
| sidecar 单测 | 配对面三重防线（无码/错码/坏 Origin/坏 Host/连败销毁/成功冻结/再提交 target-frozen）、/api 白名单越界 404、setup 态 503、日志无 token、hop-by-hop 剥除 |
| plugin 契约 | manifest 过 PluginManifestSchema、--help 零执行 + token 提示文案 |
| e2e | 真 restricted server → --server 启动 → /api/status 透传 → 注册/断连全流程（fetch 驱动）；setup 流程（起 sidecar → 模拟浏览器带码 connect → 冻结 → 业务通） |
| UI | 构建产物冒烟 + **apiFetch 注入失败态矩阵**（r2-P2-4）+ Owner 视觉走查（验收证据） |

## 7. 分期（r1 修订）

- **本 change = Server 管理视图单期交付**（sidecar + 配对面 + plugin 接线 +
  Server 管理视图）。
- **Owner 控制台拆出** → 独立 change `webui-owner-console`（注册未排期；
  前置：本 change + native binding 加载矩阵 + sidecar 本地数据面 JSON 契约
  冻结——r1 P1-8 的可测性要求在该 change 内解决）。
- 依赖：sdk-mgmt-surface 全部。

## 8. r1 评审处置表

| 项 | 处置 |
|---|---|
| P0-3 /api/session 漏洞 | 配对面物理分离到 /sidecar/*；一次性配对码 + Host/Origin；目标冻结；连败销毁（§2.2） |
| P1-5 URL 边界 | target.mjs 守卫矩阵 + 解析-连接一致 + 不跟重定向/不读代理（§2.3） |
| P1-6 argv/env | help/横幅披露 + 推荐途径（§2.2） |
| P1-7 契约承载 | 不扩展契约；run envelope 修正为既定形态；校验自担（§3） |
| P1-8 Phase B 拆出 | webui-owner-console 独立 change（§7） |
| P2-2 缺省 --server | setup 模式 + 503 no-target（§2.2；spec 场景钉住） |

### r5/r6 处置增补

| 项 | 处置 |
|---|---|
| r5-P0-1 配对并发竞态 | in-flight 单飞锁（同步置位先于 await）+ 409 pairing-in-progress + 提交前二次防御（§2.2） |
| r6-P1 409 wire 契约同步 | design/spec/tasks 三处冻结（本修订） |

### r2 增补处置

| 项 | 处置 |
|---|---|
| r2-P1-4 连接接口 | stdlib http/https.request 冻结（IP+SNI+Host 序列化、逐请求连接）（§2.3） |
| r2-P1-5 help/parser | 告警文案 fixture + help golden + parser 矩阵 + token 不入 log（§3） |
| r2-P1-7 入站路径 | 独立解析函数 + 拼接后二次 /admin/ 断言 + 零出站测试（§2.4） |
| r2-P2-1 解析边界 | localhost 全记录校验/IPv4-mapped/zone-id/尾点/默认端口序列化（§2.3） |
| r2-P2-3 代理资源界 | body 1MiB/64KiB 上限 + 响应头白名单 + abort 回收（§2.3） |
| r2-P2-4 UI 失败态 | apiFetch 注入层 + 失败态矩阵单测（§4） |
