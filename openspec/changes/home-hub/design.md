# Design: home-hub（家庭中枢与三视角控制台）

> 依据：requirements.md 裁决 [H0]-[H7] + PRODUCT-DESIGN.md v1.1（O-1/O-2/G-1
> 已拍板）。本设计不触碰 dweb-server 内核（三角色/邀请码/敲门为
> server-access-roles 交付资产，原样复用）；全部工作在 CLI 包装层、
> webui、插件层。
>
> 事实底座（2026-09-23 探查，agent-facts-r1）：registration.json 单对象
> 且唯一读者是 join 自身（fabric_id 复用）；`opendweb server` 前台常驻、
> 零 daemonize 代码、readiness=/healthz race exited、单飞停机；webui 包
> 零依赖、`startSidecar`+`main`+plugin envelope 三入口、NodeStore 未导出、
> 无事件面；插件体系=`./opendweb-plugin` 子路径 + npm marketplace globs、
> builtin 集合恒优先；平台硬门 darwin-arm64/win32-x64（server-binary 与
> client-sdk 均单包双平台二进制捆带，非 optionalDependencies 分包）。

## 0. 裁决 → 机制映射

| 裁决 | 机制（本设计） | 章节 |
|---|---|---|
| [H0] 家庭点对点初衷 | hub=包装层；数据面零改动；G-3 对拍锚定「中枢停机」承诺 | §1/§9 |
| [H1] 二维码/短码/手动地址 | 接入卡片三形态同源；短码=离线自解编码（冻结编码规则） | §3 |
| [H2] 托盘=插件 | `opendweb tray` 插件包=无头控制器+状态/控制 IPC 契约；图标壳本体归 opentray（非 Goal） | §6 |
| [H3] 中枢=寻址+回退+门禁；不默认启动 | hub init 显式选择；restricted 预设；无任何默认常驻 | §1 |
| [H4] webui 双形态（plugin+SDK） | packages/webui 重分层：core SDK（事件面/进程内控制/类型）+薄壳；分发体感不变 | §5 |
| [H5] 三视角控制台 | 切换器+视角上下文决定全局渲染；租约/到访=单页台账；成员态 sidecar mode | §5.2 |
| [H6] 机器名默认别名 | 已落地（2dacb56）；本 change 消费其显示（租约簿「我的身份」） | §2 |
| [H7] G-1 多租约 / O-1 组 B 命名 / O-2 `hub` 族 | leases.json 0..N；「我的中枢/我的租约/我的到访」；hub init/start/stop/status/card/autostart | §1/§2/§5 |

## 1. 中枢命令族与守护（CLI builtin）

### 1.1 命令面（[H7]-O-2 冻结）

| 命令 | 语义 |
|---|---|
| `opendweb hub init` | 一次性：家庭预设+自检+管理凭证落地+接入卡片+自启引导（交互确认，PM §4.2 逐字文案） |
| `opendweb hub start [--foreground]` | 启动中枢。默认 detached 守护；`--foreground` 走现有 `server` 命令全链（含插件钩子） |
| `opendweb hub stop` | 停止（联动自启：见 1.4） |
| `opendweb hub status` | 状态一屏：运行/地址/成员/敲门/自启/排障提示（PM §4.3 样例） |
| `opendweb hub card` | 重打接入卡片（与 init 尾部/webui 卡片同源，§3） |
| `opendweb hub autostart on/off` | 安装/卸载用户级系统服务（1.4） |

- **builtin 集合扩展**：`hub` 加入 BUILTIN_COMMANDS（plugin-resolve.mjs:16-24），
  恒优先于 marketplace globs，防同名插件抢注；`tray` **不进** builtin（走插件
  自适应派发，npm glob `opendweb-tray`，§6）。
- 帮助文本与 PM §4.1 用户语言表逐字对齐。

### 1.2 状态模型与文件（DWEB_HOME 体系内，遵守既有原子性先例）

| 文件 | 内容 | 写入纪律 |
|---|---|---|
| `<DWEB_HOME>/hub.json` | `{version:1, data_dir, gateway_bind, relay_bind, public_gateway_url?, public_relay_url?, initialized_at, autostart:bool}` | 0600，tmp(O_EXCL)+fsync+rename（SecretStore 手法，nodes.mjs 模板+symlink 拒绝 lstat 守卫） |
| `<DWEB_HOME>/hub-token` | 高熵 admin token（CSPRNG 32B base64url） | 0600 同上；init 生成一次，start 注入 `DWEB_ADMIN_TOKEN` env |
| `<DWEB_HOME>/hub.pid` | 守护进程 pid（start 写、stop/意外退出清） | 写失败即 start 失败（fail-fast） |

- **data_dir 默认 `<DWEB_HOME>/hub-data`**（中枢身份与数据同源，status/tray
  可定位）；init 检测 cwd 下既有 `dweb-data/`（含 server.key/owners.jsonl）→
  提示接管（O-9：保留名册，不并行第二套）；`--data-dir` 显式指定优先。
- **端口（G-4 冻结）**：gateway `8787` / relay `3340`（与裸 server 默认一致，
  PM 文案即此值）；被占时 init 自检失败并给出 `--gateway/--relay` 指引。
- **访问模式冻结**：restricted（三角色门禁开箱即用）；access 段不接受插件
  覆写（server 命令既有安全面白名单纪律延续到 hub 路径）。

### 1.3 守护进程模型（`hub start` 默认路径）

- 直接 **detached spawn server-binary**（不经 node 包装进程，避免双进程树）：
  stdio→`<data_dir>/hub.log`（追加，轮转不做 v1）；env 注入面复用
  packages/server-binary/index.js 的 env 构造（DWEB_ADMIN_TOKEN/DWEB_DATA_DIR/
  binds/access-mode）；setsid+detached+unref。
- readiness 沿用 `/healthz` 探测（30s 窗口，与 `server.exited` race—— detached
  形态=探测失败时读 pid 存活+日志尾诊断）；成功后打印地址+卡片指引。
- **stop 语义**：SIGINT → 5s → SIGKILL（与 server-binary stop 同拍）；pid 文件
  不匹配（进程消失/被复用）→ 报告实况不盲杀（liveness=pid+进程名核对）。
- `--foreground` 转发现有 runServer 全链（插件 preStart/postReady/preStop、
  单飞停机）——高级用户与 launchd/systemd 服务共用此形态（1.4）。

### 1.4 开机自启（`hub autostart`，用户级、不提权）

| 平台 | 机制 | 内容 |
|---|---|---|
| macOS | LaunchAgent `~/Library/LaunchAgents/com.opendweb.hub.plist` | RunAtLoad+KeepAlive（中枢意外退出自动拉起——「中枢会自己回来」）；Exec=`opendweb hub start --foreground` |
| Linux | systemd user unit `~/.config/systemd/user/opendweb-hub.service` | Restart=on-failure；同 Exec；`systemctl --user daemon-reload` |
| Windows | 启动文件夹 `shell:startup/opendweb-hub.cmd` | `opendweb hub start`（detached）；无 KeepAlive（v1 接受，status 可察） |

- **stop×autostart 联动**（KeepAlive 下裸杀会被拉回）：autostart on 时
  `hub stop` = 先卸载服务（launchctl bootout / systemctl --user stop+disable /
  删启动脚本）再停进程；off 时只停进程。`hub start` 在 autostart on 时=
  load 服务（让系统管生命周期）。
- 生成物为**纯文本文件**（plist/unit/cmd），可 `--print` 预览；测试用快照
  断言文本，**不实际 load**（CI/单测不动系统状态）。

### 1.5 init 自检（PM §4.2 三态）

1. 端口占用检测（bind 探测）→ 失败态给 `--gateway` 指引；
2. 网关本机可达（起后 `/healthz`）；
3. 防火墙提示（**不做越权系统变更**）：macOS 读 `socketfilterfw --getglobalstate`
   / Windows 仅提示路径，给一句话指引；检测失败=警告不阻塞（诚实降级）。
- 局域网地址呈现：枚举非环回 IPv4（`os.networkInterfaces`），多网卡全列、
  卡片取首个并标注「多网卡时以 status 为准」。

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

- 键 = `(server origin 归一化, fabric_id, root)`；同键新码 join =
  **续期 upsert**：更新 expires_at/receipt，**registered_at 保持首条**
  （镜像服务端 first_registered_at 裁决，ced9215）；alias 更新为当前自报
  （本机事实簿，无历史包袱）；label 为本地备注（PM「备注名」，缺省 null
  → UI 掩码地址）。同设备换 server = 新条目（0..N）。
- 写入纪律：0600+tmp+fsync+rename（registration.json 同款 SecretStore 手法，
  join.mjs:258-279 先例平移）；失败无半提交。
- **迁移**：join/ leases 读取器发现旧 `registration.json` 存在 → 解析成功则
  作为首条并入 leases.json，旧文件改名 `registration.json.migrated`（不删，
  防回滚）；解析失败 → 不阻塞，警告+保留原文件。join 自身的 fabric_id
  复用语义改为按 server 维度查租约簿。
- 读者：`opendweb id`（租约计数行）、`hub` 无关；webui 租约视角经 sidecar
  本机只读面（§5.2）。

### 2.2 visits 到访簿（G-2，best-effort）

- `<DWEB_HOME>/visits.json`：`{version:1, visits:[{server, server_id?, first_visit_at, last_visit_at, last_probe:{result:"reachable"|"unreachable"|"refused", at}, note:null}]}`；
  键=server origin。同款原子写。
- **写入触发（v1 诚实范围）**：① join 成功（同源记录）；② webui「测一下」
  探测动作；③ `opendweb` 后续连接命令成功时（有则记，无则不记）。
  **不承诺**自动捕获每次放行连接（PM §3.4 best-effort 声明与此对齐；
  client-sdk 连接成功事件钩子=Phase 2 候选）。
- 探测实现：对 server origin 发 `GET /services.json`（5s 超时）——
  reachable/unreachable 二值+错误分类；不携带凭证（探测面无认证语义）。

## 3. 接入信息卡片与短码（[H1]/G-5）

### 3.1 短码：离线自解编码（冻结）

- 载荷（小端序除 port）：`ver(1B: 0x01=IPv4 / 0x02=IPv6) || ip(4/16B) || port(2B BE) || crc16-ccitt(2B)`；
  编码 = crockford-base32（小写、无校验字符集重叠）；呈现 = `dwebh1.` 前缀 +
  8 字符起 4-4 分组（例 `dwebh1.7k2q-9m4t-v3xa`）。
- 解码端（客户端 CLI/webui 卡片扫描引导）内置同一实现：前缀/版本/长度/
  CRC 四重校验，任一失败=明确错误；**零在线依赖**（[H1] 朴素可靠）。
- 实现单源：packages/opendweb/src/util.mjs（编码+解码+往返向量测试），
  webui 经 workspace 依赖复用同文件（webui 零外部依赖纪律不破——
  workspace 内部 import 不算外部依赖）。
- 地址语义：卡片短码承载**中枢网关地址**（http）;IPv6 字面量带 `[]`。

### 3.2 卡片（三形态同源，PM §4.4 逐字文案）

- 数据源=`hub.json`+局域网地址（1.5）：`hub card`（终端）、webui 总览卡
  （§5.2）同一生成函数产出字段（中枢名=本机机器名 [H6] 称呼层/地址/短码/
  二维码/三步引导）；CLI 终端二维码=自含 ASCII QR 实现（~200 行，无依赖），
  webui=SVG QR（core 层同算法）。
- 卡片无凭证、无邀请码（O-8 已裁决不内嵌）；webui 卡附注指向租户管理签发。

## 4. 三视角控制台（[H5]，webui IA v2）

### 4.1 路由与视角模型

- 现四页（#/overview|tenants|visitors|online）归入「我的中枢」视角；
  新增 `#/lease`（我的租约）、`#/visits`（我的到访）；顶栏最右切换器
  （组 B 命名），视角上下文决定导航区/首屏/状态位整体渲染（非叠加 Tab）。
- **默认视角**（PM §3.1）：本机 hub.json 存在且在跑→中枢；否则有租约→
  租约；否则有到访→到访；全空→中枢引导态。记忆最近使用（localStorage）。
- **成员态 sidecar**（铁则 3）：`startSidecar` 无 target/token 时新增
  `mode:"member"`（现 setup 态收窄）——只服务租约/到访两视角的本机数据
  面 + 静态 SPA；不进 setup 世界。

### 4.2 sidecar 本机数据面（新增，仅本机回环）

| 路由 | 数据 | 备注 |
|---|---|---|
| `GET /sidecar/leases` | leases.json 只读投影（含 expires_in 计算） | 同 nodes 面的 Host/Origin 守卫 |
| `GET /sidecar/visits` | visits.json 投影 | |
| `POST /sidecar/visits/probe` | 触发探测并落 last_probe | 本机动作，无凭证 |
| `GET /sidecar/hub` | hub.json 投影（中枢视角卡片/状态用；无 hub.json=404） | |

- 租约视角首屏两问（剩几天=expires_in 倒计时/连得上吗=探测按钮）；
  到访视角=列表+探测+页脚 best-effort 声明（PM §3.3/3.4 逐字文案）。
- 走查发现吸收：F1（leases/owners 列表轮询周期收紧到与 connections 同拍
  3s）；F2（「按端点」区加说明性副标「仅租户端点」）。

## 5. webui SDK 分层（[H4]）

### 5.1 包结构重分层（分发体感不变）

```
packages/webui/src/
  core/        # SDK 核心：sidecar 运行时、NodeStore、leases/visits 读取、
               # 探测、事件总线、QR/短码算法复用、静态资源定位
  cli.mjs      # 薄壳：main()（保留信号/开浏览器/退出语义）
  plugin.mjs   # 薄壳：opendweb-plugin envelope → main
```

- 导出面（package.json）：`.`=startSidecar（**现签名零破坏**）+ 新增
  `createConsole(opts)`（进程内宿主 API）；`./opendweb-plugin` 不变。
- `createConsole` 返回：`{ onEvent(type, fn)`（类型化事件：state-change/
  node-switch/knock-pending/error——补齐 tray 所需事件面）、`switchTarget(id)`
  （进程内直调，替代 HTTP-only nodes/switch）、`getSnapshot()`（三视角数据
  一次取齐）、`close()` }——薄壳与 tray 共用；`main()` 的进程语义
  （信号/退出/开浏览器）留在壳层，core 不持有。
- NodeStore/validateTarget 从 core 导出；类型面=JSDoc+checkjs（包无构建
  步骤纪律不变），新增 `index.d.ts` 手写声明（消费者类型体验）。

### 5.2 契约测试

- startSidecar 既有测试面零回归（139 项基线+）；
- createConsole 事件序测试（switch→state-change 恰一次等）；
- member 态路由守卫（无 token 时 /admin 代理面 404）。

## 6. 托盘插件（[H2]）

- 包 `packages/tray`（npm `opendweb-tray`，插件形态与 opendweb-webui 同模式：
  marketplace glob `opendweb-tray` 自适应派发；**不进 builtin**）。
- **v1 交付=无头控制器**：`opendweb tray` 起 createConsole（进程内 webui
  SDK 消费 [H4]）+ 状态/控制 IPC：
  - 状态：`<DWEB_HOME>/tray-status.json` 心跳文件（500ms 级 mtime 刷新，
    内容=图标四态快照：异常>敲门 n>运行>未配置，PM §3.6 优先级）+ stdout
    JSON lines 事件流；
  - 控制：`opendweb tray --ipc` stdio JSON-RPC（open-console/start/stop/
    set-autostart 落点到 hub 命令与 createConsole）。
  - 数据源：hub.json/hub.pid（进程态）+ hub-token 调 /admin/status
    （敲门/成员数，轮询 3s）+ console 事件。
- **图标壳本体不在本仓库**（proposal 非 Goal：opentray 消费此契约）；
  PM §3.6 图标状态表/菜单逐字/点击落点=opentray 侧产品输入，随契约冻结。
- 依赖纪律：tray 插件包允许平台依赖（不受 webui 零依赖约束），v1 无头
  形态实际零依赖；壳侧对接需求记录于 README。

## 7. G-3 技术对拍：「中枢停掉，已直连互传不受影响」（2026-09-23 结论）

**总裁决：承诺对「已建立直连（Direct）的会话」成立；对 relay-only 会话
不成立（30-45s 内死亡，中枢回来后自动恢复）。PM §1.2 文案维持，附
「借道中」的诚实呈现义务。**（证据级：iroh=1.1.0 registry 源码逐行，
agent-g3-r1）

| 会话形态 | 中枢停掉后 | 依据 |
|---|---|---|
| 已直连 | **无限期自持**：5s QUIC PING 裸 UDP 直发对端（不经 relay），relay 路径 30s Abandoned 仅触发重选路径不杀连接；带内重打洞（QNT 扩展）只要连接活着即可进行 | iroh socket.rs:105-129（HEARTBEAT_INTERVAL=5s）；remote_state.rs:598-628（Abandoned 只 select_path）；fabric.rs:3285-3322（closed 不触发） |
| relay-only | 30-45s 内死亡（relay 路径 idle 30s + 连接级 idle 30s）；中枢回来后重连 worker（1s→30s 退避）自动恢复 | remote_state.rs:992-995；fabric.rs:3394-3443 |

- **rendezvous 与 fabric 内核零耦合**：fabric 建连/互发全程不调 rendezvous
  （寻址来源=邀请令牌+known_addrs+relay 配置候选；endpoint 未配任何
  address_lookup）——中枢的 gateway 面（rendezvous）停机只影响**新成员
  拿地址**，不影响既有成员。
- **无任何「relay 掉了就断会话」的代码路径**：fabric 无自设心跳；全部
  巡检（path watcher/relay watcher）只读观察。
- 会杀死已直连会话的条件：任一方网络变更且带内重打洞失败（需 relay
  兜底交换新地址而 relay 已死）→ 连接死 → 重拨只剩死 relay → 持续失败
  → **中枢回来后自动恢复**（relay actor 无限退避重连，既有测试
  `session_reconnects_after_relay_outage_recovery` 已验证恢复半边）。
- **产品呈现义务（对 PM §3.x 的增补）**：用户无法从「已连接」区分
  Direct/relay-only——webui 在线面与 SDK 已有 `link_status()`/
  `PathChanged` 支撑「直连中/借道中」呈现；hub 停机提示文案写
  「已直连的设备不受影响」而非泛化的「设备不受影响」。
- **测试义务（本 change 唯一允许的 Rust 面：测试新增，产品代码零改动）**：
  relay_failover.rs 新增 G-3 用例（agent-g3-r1 方案 A）：双节点建立
  Direct 后 drop relay → 120s 双向可达断言 + RelayOffline 时刻记录 →
  重启 relay → 新成员可 join。relay-only 对照组（docker 双 bridge 隔离）
  为可选加强，不阻塞。

## 8. 测试策略

- **CLI（node --test）**：hub 命令族单元（状态文件原子性/迁移向量/短码
  往返+crockford 向量/自检三态注入）；e2e（hub init→start→join→leases
  断言→stop；autostart 生成物文本快照——不 load 系统）。
- **webui**：既有 139+ 基线零回归；三视角路由/切换器/member 态守卫/
  sidecar 数据面/租约倒计时与探测 mock；createConsole 事件序。
- **tray**：状态快照优先级表用例；IPC 动作落点（mock hub）。
- **跨包**：短码编解码 CLI↔webui 同源对拍向量；leases 迁移向量
  （旧 registration.json 三形态：完好/损坏/缺失）。
- **G-3 断言（唯一 Rust 面=test-only）**：relay_failover.rs 新增用例
  （§7 测试义务）；产品 Rust 代码零改动——dweb-server/dweb-fabric 全量
  绿作为基线快照一次性确认。
- 门禁沿用：npm test 分包；`git diff --check`；checkjs。

## 9. 任务分解（实现期细化为准）

- **Phase 1（CLI 内核）**：1a hub 状态模型+init+自检；1b start/stop/status
  （detached 守护）；1c autostart 三平台生成物+联动；1d 多租约簿+迁移+
  join 改造；1e 短码+卡片（终端 QR）。
- **Phase 2（webui）**：2a SDK 重分层（core/壳+事件面+createConsole+types）；
  2b 三视角 IA+member 态+sidecar 数据面；2c 接入卡片卡+visits 探测。
- **Phase 3（插件）**：3a packages/tray 无头控制器+IPC；3b marketplace
  上架与文档。
- 依赖序：1a→1b→1c；1d/1e 并行；2a 前置 2b/2c；3a 依赖 2a+1b。

## 10. 评审处置记录

（Codex 评审轮次追加于此。）
