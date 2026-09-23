# Design: home-hub（家庭中枢与三视角控制台）

> 依据：requirements.md 裁决 [H0]-[H7] + PRODUCT-DESIGN.md v1.1（O-1/O-2/G-1
> 已拍板）。本设计不触碰 dweb-server 内核产品代码（三角色/邀请码/敲门为
> server-access-roles 交付资产，原样复用；唯一 Rust 面=relay_failover.rs
> 新增 G-3 测试用例，test-only）。
>
> 事实底座（2026-09-23 探查，agent-facts-r1）：registration.json 单对象
> 且唯一读者是 join 自身（fabric_id 复用）；`opendweb server` 前台常驻、
> 零 daemonize 代码、readiness=/healthz race exited、单飞停机；webui 包
> 零依赖、`startSidecar`+`main`+plugin envelope 三入口、NodeStore 未导出、
> 无事件面；插件体系=`./opendweb-plugin` 子路径 + npm marketplace globs、
> builtin 集合恒优先；**平台硬门 darwin-arm64/win32-x64**（CLI 入口与
> server-binary/client-sdk 均只捆这两平台，无 Linux 目标——r1-P1-1 据此
> 收窄平台承诺）。
>
> r1 评审（docs/codex-review-hh-r1.md，NOT-READY 6.2/10）9 P1 + 5 P2
> 全部处置，见 §10 处置记录。

## 0. 裁决 → 机制映射

| 裁决 | 机制（本设计） | 章节 |
|---|---|---|
| [H0] 家庭点对点初衷 | hub=包装层；数据面零改动；G-3 条件化承诺（§7） | §1/§7 |
| [H1] 二维码/短码/手动地址 | 接入卡片三形态同源；短码=离线自解 wire 冻结（§3.1）+ join 直收短码 | §3 |
| [H2] 托盘=插件 | `opendweb tray` 插件包=无头控制器+版本化 IPC 契约；图标壳本体归 opentray（非 Goal） | §6 |
| [H3] 中枢=寻址+回退+门禁；不默认启动 | hub init 显式选择；restricted 预设；无任何默认常驻 | §1 |
| [H4] webui 双形态（plugin+SDK） | packages/webui 重分层：core SDK（事件面/进程内控制/类型）+薄壳；分发体感不变（含 setup 入口保留，§5.2 supersedes 声明） | §5 |
| [H5] 三视角控制台 | 切换器+视角上下文决定全局渲染；租约/到访=单页台账；member 态 sidecar（§5.2 分流规则） | §5.2 |
| [H6] 机器名默认别名 | 已落地（2dacb56）；本 change 仅消费其显示（租约簿「我的身份」），不写回服务端 | §2 |
| [H7] G-1 多租约 / O-1 组 B 命名 / O-2 `hub` 族 | leases.json 0..N（§2.1 含锁协议）；「我的中枢/我的租约/我的到访」；hub init/start/stop/status/card/autostart | §1/§2/§5 |

## 1. 中枢命令族与守护（CLI builtin）

### 1.1 命令面（[H7]-O-2 冻结）

| 命令 | 语义 |
|---|---|
| `opendweb hub init` | 一次性：家庭预设+接管检测+自检+管理凭证落地+接入卡片+自启引导（交互确认，PM §4.2 逐字文案） |
| `opendweb hub start` | 启动中枢（detached 守护，统一进程模型见 1.3；autostart on 时转交系统服务，见 1.4） |
| `opendweb hub start --foreground` | 前台运行（autostart 服务与高级用户共用；**与 detached 同一执行链**，见 1.3） |
| `opendweb hub stop` | 停止（按进程 owner 分叉：detached/系统服务，见 1.4 联动表） |
| `opendweb hub status` | 状态一屏：运行/地址/成员/敲门/自启/排障提示（PM §4.3 样例） |
| `opendweb hub card` | 重打接入卡片（与 init 尾部/webui 卡片同源，§3） |
| `opendweb hub autostart on/off [--print]` | 安装/卸载用户级系统服务（1.4；`--print` 仅打印生成物） |

- **builtin 集合扩展**：`hub` 加入 BUILTIN_COMMANDS（plugin-resolve.mjs:16-24），
  恒优先于 marketplace globs，防同名插件抢注；`tray` **不进** builtin（走插件
  自适应派发，npm glob `opendweb-tray`，§6）。帮助文本与 PM §4.1 逐字对齐。
- **平台承诺（r1-P1-1 收窄）**：本 change 交付面 = **macOS（darwin-arm64）与
  Windows（win32-x64）**——与 CLI 入口门、server-binary/client-sdk 捆带平台
  一致；Linux（systemd user unit）移至后续 change（CLI 支持 Linux 分发后）。
  非承诺平台执行 `hub` 子命令 = 明确错误退出（非静默）。

### 1.2 状态模型与文件（DWEB_HOME 体系内，遵守既有原子性先例）

| 文件 | 内容 | 写入纪律 |
|---|---|---|
| `<DWEB_HOME>/hub.json` | `{version:1, data_dir, gateway_bind, relay_bind, public_gateway_url?, public_relay_url?, initialized_at, autostart:bool}` | 0600，tmp(O_EXCL)+fsync+rename；**init 全流程最后写**（此前任何失败=零残留，r1-P1-9） |
| `<DWEB_HOME>/hub-token` | 高熵 admin token（CSPRNG 32B base64url） | 0600 同上；init 生成一次，start 注入 `DWEB_ADMIN_TOKEN` env；不出现在任何输出/日志/卡片/IPC（基线 2） |
| `<DWEB_HOME>/hub.pid` | **detached 守护进程** pid（仅 detached start 写；系统服务模式不写——owner 是服务管理器，见 1.4） | start 写、stop/退出清；写失败即 start 失败 |
| `<data_dir>/hub.lock` | 目录占用锁（r1-P1-9）：启动前 O_EXCL 创建，内容=pid+ts；持有至进程退出 | 同目录第二进程启动=占用错误（见 1.6 接管） |

- **data_dir 默认 `<DWEB_HOME>/hub-data`**；端口（G-4 冻结）：gateway
  `8787` / relay `3340`；被占时 init 自检失败并给 `--gateway/--relay` 指引
  （**不允许**改端口后对同一 data_dir 起第二进程——hub.lock 拒绝）。
- **访问模式冻结**：restricted；access 段不接受插件覆写（server 命令既有
  白名单纪律延续到 hub 全路径）。

### 1.3 统一进程模型（r1-P1-3/P1-4 裁决：无双轨）

`hub start`（detached 与 `--foreground`）**执行同一链**：node CLI 进程跑
完整 `server` 命令编排（插件 preStart/postReady/preStop 钩子、配置解析、
startServer、/healthz readiness、单飞停机）。差异只在进程宿主：

| 形态 | 进程宿主 | pid 记录 | 生命周期 owner |
|---|---|---|---|
| detached（默认） | `hub start` 以 `spawn(process.execPath, [bin/opendweb.mjs 绝对路径, 'hub', 'start', '--foreground'], {detached, stdio→<data_dir>/hub.log, env 注入 DWEB_*})` 后 unref 退出；守护进程=node CLI | hub.pid（node 进程 pid） | `hub stop`（SIGINT→runServer 单飞停机→binary SIGINT→5s→SIGKILL 兜底） |
| 系统服务（autostart on 后的 start） | 服务管理器直接 Exec 同一命令（1.4 绝对路径冻结） | 不写 hub.pid | 服务管理器（KeepAlive）；`hub stop`=卸载+停服务 |
| `--foreground`（用户直跑） | 用户终端 | 不写 | 用户 Ctrl+C（单飞停机） |

- 插件钩子语义与裸 `opendweb server` **逐一致**（含 preStop 清理）；有
  preStart 覆写类插件时行为同 server——无静默差异。stop 对 node 守护进程
  发 SIGINT：runServer 信号处理负责级联停 binary（既有单飞停机已覆盖）。
- pid 校验：stop/status 先读 hub.pid，核对进程存在+可执行名含 node/opendweb
  （防 pid 复用误杀）；进程消失→清孤儿 pid 文件并报告。

### 1.4 开机自启（用户级、不提权；平台=1.1 承诺面）

| 平台 | 机制 | Exec/路径冻结（r1-P1-4） |
|---|---|---|
| macOS | LaunchAgent `~/Library/LaunchAgents/com.opendweb.hub.plist` | RunAtLoad+KeepAlive；`ProgramArguments=[process.execPath 绝对路径, <pkg>/bin/opendweb.mjs 绝对路径, hub, start, --foreground]`（init 时解析冻结进 plist，不依赖 PATH）；WorkingDirectory=data_dir 父目录；EnvironmentVariables 含 DWEB_HOME |
| Windows | 启动脚本 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\opendweb-hub.cmd`（APPDATA env 展开真实绝对路径） | 脚本内容=冻结的绝对路径调用（node+cli 绝对路径）`opendweb-hub-foreground.cmd`（无窗口后台执行 `hub start --foreground` 的同目录脚本）；无 KeepAlive（v1 接受，status 可察） |

- **start/stop×autostart 联动（消除歧义）**：autostart on 时 `hub start`
  = 安装/加载服务（macOS `launchctl bootstrap`；Windows 生成即生效，提示
  注销重登或手动运行脚本一次）**不另起 detached**；autostart off 时 =
  detached 直起。`hub stop`：autostart on → 卸载服务（bootout / 删脚本）
  再停残留进程；off → 杀 detached。服务 child **不写 pid、不重复 load**
  （进程内检测「本进程由服务管理器拉起」=环境变量 `DWEB_HUB_SERVICE=1`
  由 plist/脚本注入，跳过 load 分支）。
- 生成物纯文本可 `--print` 预览；测试=生成物文本快照（含真实绝对路径
  注入断言）+ **不实际 load**；安装/卸载失败=autostart 状态不更新（hub.json
  不假成功，基线 5）。

### 1.5 init 自检（PM §4.2 三态）

1. 端口占用（bind 探测）→ 失败给 `--gateway/--relay` 指引；
2. 网关本机可达（起后 /healthz）；
3. 防火墙提示（**不做越权系统变更**；检测失败=警告不阻塞）。
- 局域网地址：枚举非环回 IPv4；多网卡全列、卡片取首个并标注。

### 1.6 接管既有数据（r1-P1-9 冻结交接协议）

init 检测目标 data_dir（默认 hub-data 或 `--data-dir`）与 cwd 既有
`dweb-data/`：

1. 目录含 server.key/owners.jsonl → **运行中检测**：gateway/relay 端口
   /healthz 探测可达 ⇒ **拒绝接管**（明确提示「先停旧服务」），绝不自动杀；
2. 未在运行 → 二次确认后接管（名册/密钥保留，不并行第二套）；
3. 启动时 hub.lock（O_EXCL）保证同 data_dir 单进程；陈锁（mtime>10s 且
   pid 不活）可打破接管，活锁=占用错误；
4. init 任何步骤失败=零文件残留（hub.json 最后写）；接管只读不迁移文件
   （registration.json 迁移是另一条独立链，§2.1）。
- 旧 server 用自定义 DWEB_DATA_DIR 的场景：不猜路径——由用户以
  `--data-dir` 显式交接；cwd 扫描只覆盖默认形态。

## 2. 多租约簿（[H7]-G-1）

### 2.1 存储：`<DWEB_HOME>/leases.json`

```json
{ "version": 1, "leases": [
  { "server": "http://192.168.2.13:8787", "server_id": "<hex64>",
    "fabric_id": "<hex64>", "root": "<hex64>",
    "alias": "kzf-MacBook", "label": null,
    "registered_at": 0, "expires_at": 0,
    "receipt": { "ts": 0, "generation": 0, "code_hash": "<hex64>", "receipt_sig": "<b64url>" } }
] }
```

- 键 = `(server origin 归一化, fabric_id, root)`；同键新码 join = 续期
  upsert（更新 expires_at/receipt；**registered_at 保持首条**，镜像
  ced9215 裁决）；alias 更新为当前自报；同设备换 server = 新条目。
- **写者集合与并发协议（r1-P1-6 冻结）**：写者 = join CLI、label 编辑
  （§4.2）两个进程面。每个账本文件配 `<name>.lock`（O_EXCL 创建，内容
  pid+ts）：获取锁 → **锁内重读** → 合并 → tmp+fsync+rename → 校验锁仍
  属本进程（比较内容）→ 释放。陈锁（>10s 且 pid 死）可打破；锁获取失败
  = 短退避重试（≤3 次）后报错（不静默丢写）。原子 rename 防半写，锁协议
  防 lost update——两者叠加，缺一不可（基线 6）。
- **迁移**：读取器（join/ leases 读取器）发现旧 `registration.json` 且
  leases.json 缺失 → 在 leases 写锁内解析并入首条 → 旧文件改名
  `.registration.json.migrated`（不删）；解析失败=警告+保留原文件，不阻塞。
  迁移与并发 join 相撞=锁协议自然串行（同一把 leases.lock）。
- 读者：`opendweb id`（租约计数行）、webui 租约视角（sidecar 本机面 §4.2）。

### 2.2 visits 到访簿（G-2，best-effort）

- `<DWEB_HOME>/visits.json`：`{version:1, visits:[{server, server_id?, first_visit_at, last_visit_at, last_probe:{result, detail?, at}, note}]}`；键=server origin；同款锁协议（写者=join CLI、sidecar probe 两个进程面）。
- **探测结果枚举（r1-P2-2 冻结）**：`result ∈ {reachable, unreachable}`；
  detail ∈ {http-status:<n>, timeout, dns, bad-body, conn-refused}（内部
  归类字段，UI 只呈现二值+话术）。映射：HTTP 2xx 且 services.json 可解析
  → reachable；非 2xx → unreachable/http-status；连接被拒 → unreachable/
  conn-refused；DNS 失败/超时（5s）→ unreachable/dns|timeout。**不使用**
  「refused」作用户面词（与「被拒准入」歧义）。
- **写入触发（v1 诚实范围）**：join 成功（同源记录）、webui「测一下」、
  既有连接类命令成功。不承诺自动捕获每次放行连接（PM §3.4 声明对齐；
  client-sdk 事件钩子=Phase 2）。探测=无凭证 `GET <origin>/services.json`。

## 3. 接入信息卡片与短码（[H1]/G-5）

### 3.1 短码 wire 冻结（r1-P1-5 全参数）

- **载荷**（11 字节 IPv4 / 23 字节 IPv6）：`ver(1B: 0x01=IPv4, 0x02=IPv6)
  || ip(4/16B) || port(2B 大端) || crc16(2B 大端)`；CRC-16/CCITT-FALSE
  冻结参数：poly=0x1021, init=0xFFFF, refin=false, refout=false,
  xorout=0x0000（校验向量：ASCII "123456789" → 0x29B1，实现首提交必含）。
- **编码**：crockford-base32（字母表 `0123456789abcdefghjkmnpqrstvwxyz`，
  小写，**无 padding**，解码大小写不敏感、O/o/I/i/L/l 歧义字符按 crockford
  规范映射）；**长度冻结**：IPv4=9B 载荷 → **15 字符**；IPv6=21B 载荷 →
  **34 字符**（总长=前缀 `dwebh1.` + 分组体：IPv4 分 5-5-5，IPv6 分
  4×8+2；连字符 `-` 分隔，解码时忽略）。
- **已知向量义务**：实现首提交 MUST 附 ≥2 个固定向量（IPv4+IPv6，含
  完整短码串）与逐位篡改测试（每向量篡改任一载荷字符 → decode 失败）；
  向量同时进 CLI 与 webui 对拍测试。
- **接收端入口**：`opendweb join --server` **直收短码**（检测 `dwebh1.`
  前缀 → 离线 decode → `http://<ip>:<port>`；解码失败=明确错误不猜）；
  webui 租约空态指引文案同步（「填地址或贴短码」）。
- 实现单源：packages/opendweb/src/util.mjs（encode/decode/向量），webui
  经 workspace 依赖复用同文件。地址语义=中枢网关；IPv6 字面量带 `[]`。
- PRODUCT-DESIGN §4.4 短码样例同步修正为真实长度形态（见 §10 处置）。

### 3.2 卡片（三形态同源，PM §4.4 逐字文案）

- 数据源=hub.json+局域网地址：`hub card`（终端）与 webui 总览卡同一生成
  函数（中枢名=本机机器名 [H6]/地址/短码/二维码/三步引导）；CLI 终端
  二维码=自含 ASCII 实现（无依赖），webui=SVG（同算法）。
- **卡片无凭证（实现默认，依 [H1]「承载地址与引导信息」精神；O-8 未
  Owner 显式拍板，标注可回退——r1-P2-1）**：不含邀请码/token/回执材料；
  webui 卡附注指向租户管理签发。

## 4. 三视角控制台（[H5]，webui IA v2）

### 4.1 路由与视角模型

- 现四页归入「我的中枢」视角；新增 `#/lease`、`#/visits`；顶栏最右切换器
  （组 B 命名），视角上下文决定全局渲染（非叠加 Tab）。
- **默认视角**：本机 hub.json 存在且在跑→中枢；否则有租约→租约；否则
  有到访→到访；全空→中枢引导态。记忆最近使用（localStorage）。
- **走查发现吸收**：F1（列表轮询与在线面同拍 3s）；F2（「按端点」区加
  「仅租户端点」副标）。

### 4.2 sidecar 模式分流与数据面（r1-P1-2 supersedes 声明）

**对 webui-console 基线「无 --server 即 setup」的部分 supersedes**（本
change 冻结新分流，旧条款在成员数据在场时被覆盖）：

| 输入 | 模式 | 行为 |
|---|---|---|
| 显式 `--server`（±`--token`） | ready(admin) | 既有行为（含节点簿），不变 |
| 无参 + 本机有 leases/visits 数据 | **member（新）** | 不进 setup、不生成/打印配对码、`/sidecar/connect` 403、`/admin/*` 全 404（见下负向矩阵）；服务租约/到访视角+静态 SPA |
| 无参 + 零本地数据 | setup | **基线保留**（首次配对入口不破坏） |
| 任何状态 + `--setup` | setup | 显式强制入口（member 态设备重新配对的通道） |

- **member 态安全负向矩阵（r1-P2-4，测试面冻结）**：`/admin/*`（含路径
  编码变体/未知子路径）→ 404 且**无上游出站**；`/sidecar/connect`/
  nodes 面 → 403；probe/label 写路由跨源（坏 Host/缺失 Origin/非回环
  Host）→ 403；静态 SPA 与只读数据面正常。
- **本机数据路由**（全家族沿用 nodes 面 Host/Origin 守卫）：
  `GET /sidecar/leases`（投影含 expires_in）、`GET /sidecar/visits`、
  `POST /sidecar/visits/probe`、`GET /sidecar/hub`（无 hub.json=404）、
  `PATCH /sidecar/leases/{server 归一化键}/label`（r1-P2-3：label 行内
  编辑的写面；body `{label: string|null}`，≤64 UTF-8 字节，走 §2.1 锁
  协议）。
- 租约视角首屏两问（剩几天/连得上吗）；到访视角=列表+探测+页脚 best-effort
  声明（PM §3.3/3.4 逐字）。

## 5. webui SDK 分层（[H4]）

### 5.1 包结构重分层（分发体感不变）

```
packages/webui/src/
  core/        # SDK 核心：sidecar 运行时、NodeStore、leases/visits 读取+锁写、
               # 探测、事件总线、QR/短码算法复用、静态资源定位
  cli.mjs      # 薄壳：main()（信号/开浏览器/退出语义留壳层）
  plugin.mjs   # 薄壳：opendweb-plugin envelope → main
```

- 导出面：`.`=startSidecar（**现签名零破坏**）+ 新增 `createConsole(opts)`；
  `./opendweb-plugin` 不变；NodeStore/validateTarget 从 core 导出；手写
  index.d.ts。
- **createConsole 契约（r1-P1-8 冻结）**：返回
  `{ url, open(deepLink?), mode(), getSnapshot(), onEvent(type, fn)→disposer,
   switchTarget(id), close() }`——
  - `url`=控制台地址（含本次会话口令参数）；`open(deepLink?)` 打开浏览器
    落点（`#/lease` 等深链，tray open-console 的 SDK 落点）；
  - **事件 schema v1**：`{v:1, type:"state-change"|"node-switch"|
    "knock-pending"|"error", payload, ts}`；`onEvent` 返回 unsubscribe
    disposer；close 后再触发=静默、再订阅=抛错；
  - `getSnapshot()`=最新投影（三视角数据一次取齐，时点=调用时刻同步快照）；
  - switchTarget 为进程内直调（不再 HTTP-only）；core 不持有进程语义。
- 契约测试：事件序（switch→恰一次 node-switch）、golden 事件帧、close 语义、
  startSidecar 既有面零回归。

## 6. 托盘插件（[H2]）

- 包 `packages/tray`（npm `opendweb-tray`，插件形态同 opendweb-webui；
  **不进 builtin**；可选——未安装不影响核心）。
- **v1 交付=无头控制器**（图标壳本体归 opentray，非 Goal）：
  1. **进程内消费 webui SDK**：`opendweb tray` 经 createConsole 拉起本机
     控制台（含深链 open）；
  2. **状态面**：`<DWEB_HOME>/tray-status.json` 心跳（≤1s 级 mtime 刷新），
     内容=schema v1 快照 `{v:1, state:"error"|"knock"|"running"|"unconfigured",
     knocks_pending:n, ts}`（优先级 异常>敲门 n>运行>未配置——「未配置」
     为 v1 可选呈现，O-5 维持不承诺纯成员机托盘，r1-P2-1）；数据源=
     hub.json/hub.pid+hub-token 调 /admin/status（3s 轮询）+console 事件；
  3. **控制面（两种互斥模式，r1-P1-8 冻结）**：默认模式=stdout **JSON-lines
     事件流**（仅事件推送，同 schema v1，无请求）；`--ipc` 模式=stdin/stdout
     **JSON-RPC 2.0**（newline 分帧；request id 透传；错误 envelope
     `{code,message}`；帧长上限 64KB 超限=error 响应不断流；坏 JSON=error
     响应；stdin EOF=优雅退出；stderr 只归日志）。方法集：`open-console`
     (参数 deepLink?)/`start`/`stop`/`set-autostart`——落点到 hub 命令与
     createConsole；**hub-token 绝不经 IPC 暴露**（方法内部使用）。
- golden frame 契约测试（事件帧+RPC 帧+非法帧）；心跳文件原子写先例。
- README 冻结壳侧对接契约：状态优先级表、菜单（PM §3.6 逐字）、深链落点。

## 7. G-3 技术对拍：「中枢停掉，已直连互传不受影响」（r1-P1-7 收窄后结论）

**总裁决（条件化）**：在**家庭中枢场景（成员经 Custom relay 指向中枢）**
下，已建立直连（Direct path selected）的会话在中枢全进程停掉后继续双向
可达——QUIC 5s 心跳直发对端不经 relay，relay 路径 30s 弃用不杀连接。
**适用条件**：①成员 fabric 用 custom relay 配置（hub 家庭场景即此；
`RelayConfig::N0Default` 走 n0 公共 pkarr/DNS 发现，行为不同，不在本结论
内）；②直连路径持续可用（任一方网络变更且需经 relay 交换新地址时，连接
在 relay 死亡期间无法重建——中枢回来后由重连 worker 恢复）。relay-only
会话 30-45s 内死亡、中枢回来后 ≤60s 自动恢复。**文案口径**：PM §1.2
「已直连的设备不受影响」+「借道中的设备会暂时断开，中枢回来自动恢复」；
在线面呈现「直连中/借道中」（SDK link_status/PathChanged 支撑）。

- 证据链（iroh=1.1.0 registry 源码，agent-g3-r1）：socket.rs:105-129
  （HEARTBEAT_INTERVAL=5s）、remote_state.rs:598-628（Abandoned 只重选
  路径）、fabric.rs:3285-3322（closed 不触发）；fabric 默认 N0Default 的
  澄清见上「适用条件」。
- **测试义务（必需用例，test-only）**：relay_failover.rs 新增——①两节点
  Custom relay join 并轮询 `link_status==Direct` 断言；②**停整个 server
  进程**（gateway+rendezvous+relay 全停，非只 drop relay）；③持续双向
  send ≥300s（远超 relay 路径 30s+连接级 30s idle）断言零中断；④同窗口
  断言新节点 join 失败（gateway 不可达）；⑤重启 server → wait relay
  online → 新成员 join 成功。**relay-only 对照（必需，r1 升级）**：双
  docker bridge 网络隔离 UDP（实现期若环境无法稳定隔离：降级为记录环境
  限制+只交付直连主用例，同时 PM 文案的「数十秒」保留为源码推导值并标注
  未经自动断言）。
- 「无限期」表述废除：承诺改为「只要直连路径不断，会话不依赖中枢」+
  300s 测试窗口（基线 10：只宣传已证明的条件）。

## 8. 测试策略

- **CLI（node --test）**：hub 状态文件原子性（故障注入断言，非审查式）；
  短码向量+逐位篡改；join 短码直收；leases/visits 锁协议并发（双进程同
  写不同 server → 两更新俱在）；迁移三形态+迁移与 join 相撞；init 零残留
  （各步故障注入）；接管（运行中拒绝/陈锁打破/活锁占用）；detached 启停
  （pid 校验/孤儿 pid/复用防护）；自启生成物快照（绝对路径断言，不 load）。
- **webui**：既有基线零回归；三视角/切换器/member 分流矩阵（含 --setup）；
  member 负向矩阵（/admin 编码变体全 404 无上游出站/connect 403/跨源写
  403）；label 编辑（含并发）；createConsole golden 事件帧+close 语义。
- **tray**：状态优先级表用例；IPC golden 帧+非法帧+EOF；动作落点 mock。
- **G-3（test-only Rust）**：§7 用例；dweb-server/fabric 全量绿=基线快照。
- 门禁沿用：npm test 分包；`git diff --check`；checkjs。

## 9. 任务分解（实现期细化为准）

- **Phase 1（CLI 内核）**：1a hub 状态模型+init（含接管协议+自检+零残留）；
  1b 统一进程模型 start/stop/status（detached/foreground/服务三宿主）；
  1c autostart 两平台+联动；1d 多租约簿+锁协议+迁移+join 改造；1e 短码
  wire+向量+卡片（终端 QR）+join 直收短码。
- **Phase 2（webui）**：2a SDK 重分层（core/壳+createConsole 契约+types）；
  2b 三视角 IA+member 分流+数据面（含 label）+负向矩阵；2c 接入卡片卡+
  visits 探测+直连/借道呈现。
- **Phase 3（插件+测试）**：3a packages/tray（无头+IPC 契约）；3b G-3
  relay_failover 用例；3c marketplace 上架与文档。
- 依赖序：1a→1b→1c；1d/1e 并行；2a 前置 2b/2c；3a 依赖 2a+1b；3b 独立可并行。

## 10. 评审处置记录

| 轮 | 结论 | 处置 |
|---|---|---|
| r1（02545d5） | NOT-READY 6.2/10，P1×9+P2×5 | 全处置：P1-1 平台收窄 darwin+win（§1.1）；P1-2 supersedes+四行分流表+--setup 入口（§4.2）；P1-3 统一进程模型消除双轨（§1.3）；P1-4 Exec 绝对路径冻结+Windows 真实 Startup 路径+owner 分叉表（§1.3/1.4）；P1-5 短码 wire 全参数+长度数学修正+向量义务+join 直收（§3.1）；P1-6 锁协议（§2.1/2.2）；P1-7 G-3 条件化+测试升级+「无限期」废除（§7）；P1-8 createConsole url/open+事件 schema v1+IPC 双模式冻结（§5.1/§6）；P1-9 接管交接协议+hub.lock+零残留（§1.6）；P2-1 O-8/O-5 标实现默认可回退（§3.2/§6）；P2-2 visits 枚举统一+detail 映射（§2.2）；P2-3 label 写路由（§4.2）；P2-4 member 负向矩阵（§4.2）；P2-5 Scenario 可测性改写+边界补全（§8） |
