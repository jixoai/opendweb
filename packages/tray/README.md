# opendweb-tray

opendweb 家庭中枢的**托盘无头控制器**（home-hub [H2] v1 交付形态）。它是一个
opendweb 插件包（`opendweb tray`，marketplace 默认 glob `npm:opendweb-*` 自适应
派发命中；**不进 builtin 集合、可选**——未安装不影响核心功能，中枢全生命周期
CLI 直达）。

v1 是无头形态：**图标壳本体归 opentray 消费本契约**。本包负责——

- **状态面**：`<DWEB_HOME>/tray-status.json` 心跳文件（≤1s 级 mtime 刷新，原子写）；
- **控制台**：进程内经 webui SDK（`createConsole`）拉起本机管理控制台；
- **控制面（两种互斥模式）**：默认 = stdout JSON-lines 事件流；`--ipc` =
  stdin/stdout JSON-RPC 2.0（帧级冻结）。

v1 无头裁决：**本包绝不自行 spawn 浏览器**。`open-console` 只发出 `opened`
通知/事件（携带控制台 URL，内含一次性会话 capability，TTL 120s）——壳侧收到
后自行开窗（壳侧可覆写打开行为；URL 即 `createConsole.open(deepLink)` 的落点）。

```
┌──────────┐  mtime ≤1s     ┌─────────────┐  kill0/轮询    ┌──────────────┐
│ 壳(opentray)│◀──tray-status.json──│ opendweb-tray │──/admin/status──│ hub (127.0.0.1)│
│  图标/菜单  │◀─ stdout 帧 ──────│  无头控制器   │◀─ hub.json/pid/token ── DWEB_HOME
└──────────┘  (events/--ipc) └─────────────┘  子进程 node bin/opendweb.mjs hub …
```

## 运行

```sh
opendweb tray            # 默认模式：stdout JSON-lines 事件流（常驻）
opendweb tray --ipc      # IPC 模式：stdin/stdout JSON-RPC 2.0（常驻）
opendweb-tray --ipc      # 等价 bin 直跑形态
```

环境：`DWEB_HOME`（缺省 `~/.opendweb`）。stderr 只归日志；stdout 恒为当前模式
的帧通道（事件与 RPC 不混流）。

## 状态面：tray-status.json

路径 `<DWEB_HOME>/tray-status.json`，0600 原子写，每 ≤1s 无条件重写（mtime 与
`ts` 同拍前进）。**schema v1（冻结）**：

```json
{"v":1,"state":"knock","knocks_pending":2,"ts":1760000000123}
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `v` | `1` | schema 版本位 |
| `state` | `"error" \| "knock" \| "running" \| "unconfigured"` | 四态聚合（优先级见下） |
| `knocks_pending` | `number` | 待处理敲门数（与敲门台同源） |
| `ts` | `number` | 写盘时刻（epoch ms） |

**图标状态（优先级从高到低，同时只呈现一个）**（PRODUCT-DESIGN §3.6 逐字）：

| 优先级 | 状态 | 图标 | 语义 |
|---|---|---|---|
| 1 | 异常 | 警示态 | 该运行而未运行（自启开了但进程不在）/ 进程失联 |
| 2 | 敲门待处理 | 常态 + 数字角标 n | n 台设备在等放行（与敲门台同源） |
| 3 | 运行中 | 常态 | 一切正常 |
| 4 | 未配置 | 灰态 | 本机无中枢（纯成员机装了托盘的降级呈现，v1 边界见 O-5） |

数据源与裁决（v1）：

- `hub.json` 不存在 → `unconfigured`；
- `hub.json` 存在但进程不在（hub.pid 记录的 pid 不存活；含自启开了但进程不在）
  → `error`。v1 schema 无 `stopped` 态：**配置存在而进程不在一律按异常呈现**
  （自开自停由菜单的「启动中枢」承接，见下）；
- 进程存活 + `knocks_pending > 0` → `knock`；进程存活 → `running`；
- `knocks_pending` 来自 `GET http://127.0.0.1:<gateway_port>/admin/status`（3s
  轮询，Bearer hub-token——**token 只进请求头，绝不写入心跳/事件/日志/任何
  输出面**）与 console `knock-pending` 事件（后到者覆盖）。

**失联可察**：tray 进程退出（含崩溃）后心跳文件停止刷新、文件保留——壳侧以
`stat` 的 **mtime 龄期**判定失联（建议阈值 ≥3× 刷新周期，即 ≥3s；期间图标可
降级为警示态）。`ts` 字段可作为交叉校验（与 mtime 同拍）。

## 菜单结构（PRODUCT-DESIGN §3.6 逐字，v1）

```
中枢：运行中 · 1 台设备在敲门      （状态行，不可点）
──────────
打开控制台
停止中枢                        （运行时；停止时显示「启动中枢」）
开机自启 ✓
──────────
退出
```

**点击落点**（点图标 = 打开控制台，按当前最需关注的事深链）：有待处理敲门 →
敲门台；异常 → 总览（中枢状态卡）；运行中 → 总览；未配置 → 租约视角。
（深链取 webui IA v2 的 hash 路由，经 `open-console` 的 `deepLink` 参数传递，
如 `"#/lease"`。）

## 默认模式：stdout JSON-lines 事件流

无请求语义；每行一个 JSON 帧，三类：

1. **webui schema v1 事件转发**（webui SDK 同款帧，原样透传）：
   `{"v":1,"type":"state-change"|"node-switch"|"knock-pending"|"error","payload":…,"ts":…}`
2. **心跳状态变化通知**（`tray-status`，`{state,knocks_pending}` 变化时发）：
   `{"v":1,"type":"tray-status","payload":{"state":"knock","knocks_pending":1},"ts":…}`
3. **opened 事件**（open 落点；URL 含一次性会话 capability，TTL 120s，壳侧应
   尽快打开）：
   `{"v":1,"type":"opened","payload":{"url":"http://127.0.0.1:<port>/?dweb_console=<cap>#/lease"},"ts":…}`

生命周期：SIGINT/SIGTERM → 优雅退出（心跳冻结、console 关闭、capability 失效）。
默认模式为**双断管信号**（r18）：**stdout 写错（EPIPE）或宿主关闭 stdin（EOF）
任一发生 → 幂等停机退出（exit 0）**——宿主干净关闭管道且无写错时，stdin EOF
是可靠即时的宿主消失信号，插件不驻留成孤儿。因此默认模式宿主 MUST 以管道接
stdin 并在整个生命周期保持打开（stdin 数据无协议语义，仅 EOF 有意义；
`stdio: ignore` 形态会立即触发退出，不再适用）。ipc 模式 stdin EOF 同为
优雅退出（既有语义，由会话层承接）。

## --ipc 模式：JSON-RPC 2.0（帧级冻结）

stdin/stdout JSON-RPC 2.0，newline 分帧；request id 透传；错误 envelope
`{code,message}`；**不支持 notification 与 batch**（收到即 `-32600` error
响应）；单帧上限 64KB（UTF-8 字节）——超限返回 error 帧（id 取帧前缀可解析
值，否则 null）不断流；坏 JSON = error 帧继续服务；stdin EOF = 优雅退出；
stderr 仅归日志。**所有响应帧（含全部 error）都携带 `"jsonrpc":"2.0"` 字段**
——契约测试以严格 JSON-RPC 2.0 validator 逐帧校验；错误帧的 id 提取 = 语法
解析前的受限前缀扫描（非任意 JSON 执行）。

**golden 帧样例（契约测试冻结）**：

```jsonl
→ {"jsonrpc":"2.0","id":1,"method":"open-console","params":{"deepLink":"#/lease"}}
← {"jsonrpc":"2.0","id":1,"result":{"ok":true}}
→ {"jsonrpc":"2.0","id":2,"method":"set-autostart","params":{"on":true}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"hub not initialized"}}
→ {"jsonrpc":"2.0","method":"open-console"}
← {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"notifications not supported"}}
→ [{"jsonrpc":"2.0","id":9,"method":"stop"}]     ← batch：整帧拒绝
← {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch not supported"}}
→ [超长帧 >64KB]
← {"jsonrpc":"2.0","id":<前缀可解析则透传，否则 null>,"error":{"code":-32601,"message":"frame too large"}}
→ {坏 JSON}
← {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}
```

（batch = 单帧整体拒绝、不逐元素响应；拒绝后连接继续处理下一帧。）

**server 通知**：本包只发一种 server→client 通知——`open-console` 成功后紧跟：

```jsonl
← {"jsonrpc":"2.0","method":"opened","params":{"url":"http://127.0.0.1:<port>/?dweb_console=<cap>#/lease"}}
```

（URL 内是一次性会话 capability，非 hub-token/admin token；重放/过期即 403，
壳侧收到应尽快打开。）

### 方法集

| 方法 | params | 语义 |
|---|---|---|
| `open-console` | `{deepLink?: string}` | 经 webui SDK 打开本机控制台（hash 路由深链，如 `"#/lease"`；缺省=默认落点）。落点=发出 `opened` 通知 |
| `start` | `{}` | `opendweb hub start`（子进程真实调用；未 init hub → `-32000 "hub not initialized"`） |
| `stop` | `{}` | `opendweb hub stop --yes` |
| `set-autostart` | `{on: boolean}`（必填） | `opendweb hub autostart on\|off` |

成功恒为 `{"jsonrpc":"2.0","id":<id>,"result":{"ok":true}}`。错误码：
`-32700` parse error / `-32600` notifications·batch not supported（及 invalid
request）/ `-32601` frame too large（超长）与 method not found / `-32602`
invalid params / `-32603` internal error / `-32000` hub 动作业务错误。

## 安全纪律

- **hub-token 绝不出现在任何输出面**（stdout 事件流 / IPC 响应与通知 / 心跳
  文件 / stderr 日志）：只在本进程内读入并作为回环 `/admin/status` 轮询的
  Authorization 头；
- 控制台 URL 携带的是 webui 会话 capability v1（≥128-bit、单次消费、TTL
  120s、绑定 sidecar 实例）——非 hub-token/admin token；
- 心跳文件 0600、原子写（tmp + rename；拒绝穿透符号链接）。

## 壳侧对接清单（opentray）

1. 拉起 `opendweb tray --ipc`（或默认模式），以本 README 的帧协议通信；
2. `tray-status.json` 轮询 `stat`（建议 1s）+ mtime 龄期 ≥3s 判失联；
3. 菜单/图标按 §状态面 与 §菜单结构 渲染；点击 → `open-console`（按落点表
   选 `deepLink`），消费 `opened` 的 URL 自行开窗（打开行为在壳侧，可覆写）；
4. 菜单动作 → `start` / `stop` / `set-autostart`；
5. 退出：发 SIGINT/SIGTERM（或关 stdin——ipc 模式 EOF 即优雅退出）。
