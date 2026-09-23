# Design: home-hub（家庭中枢与三视角控制台）

> 依据：requirements.md 裁决 [H0]-[H7] + PRODUCT-DESIGN.md v1.2。本设计不
> 触碰 dweb-server 内核产品代码（唯一 Rust 面=relay_failover.rs 新增 G-3
> 测试用例，test-only）。
>
> 事实底座（2026-09-23，agent-facts-r1/g3-r1）：registration.json 单对象且
> 唯一读者是 join；`opendweb server` 前台常驻、配置发现基于 process.cwd()、
> data_dir 优先级 CLI/env/默认 cwd 下 dweb-data（config.rs:19-20,143-155）、
> server-binary 从父进程继承 DWEB_DATA_DIR；webui sidecar 绑 127.0.0.1、
> 基线 guardLocalOrigin **放行缺失 Origin**（sidecar.mjs:520-534）；客户端
> SDK relay 缺省=N0Default（n0 公共 relay），仅显式 custom 才指向自托管
> （client-sdk/src/fabric.rs:177-229）；join 现状不配置 relay；平台硬门
> darwin-arm64/win32-x64。
>
> 评审史：r1（NOT-READY 6.2）9 P1+5 P2 已处置；r2（NOT-READY 7.0，
> docs/codex-review-hh-r2.md）9 P1+7 P2 处置见 §10。

## 0. 裁决 → 机制映射

| 裁决 | 机制（本设计） | 章节 |
|---|---|---|
| [H0] 家庭点对点初衷 | hub=包装层；数据面零改动；G-3 条件化承诺+入网链保证 Custom relay（join 落 relay_url） | §2.1/§7 |
| [H1] 二维码/短码/手动地址 | 接入卡片三形态同源；短码 wire 全冻结含 golden vectors（§3.1）+ join 直收 | §3 |
| [H2] 托盘=插件 | `opendweb tray` 插件=无头控制器+版本化 IPC（含完整帧样例）；图标壳归 opentray | §6 |
| [H3] 中枢=寻址+回退+门禁；不默认启动 | hub init 显式选择；restricted；无默认常驻（负向 Scenario 钉死） | §1 |
| [H4] webui 双形态 | core SDK+薄壳；createConsole（open=注入回调）；hub 管理员入口 `hub open` | §5 |
| [H5] 三视角控制台 | 切换器+member 态分流（五行表，含 hub 本机自动 admin）；租约/到访单页 | §4 |
| [H6] 机器名默认别名 | 已落地（2dacb56）；本 change 仅消费显示，不写回服务端 | §2 |
| [H7] G-1/O-1/O-2 | leases.json 0..N（锁协议）；组 B 命名；hub 命令族 | §1/§2/§4 |

## 1. 中枢命令族与守护（CLI builtin）

### 1.1 命令面（[H7]-O-2 冻结）

| 命令 | 语义 |
|---|---|
| `opendweb hub init` | 一次性：接管检测+家庭预设+自检+凭证+卡片+自启引导（交互确认） |
| `opendweb hub start [--foreground]` | 启动（detached/前台同链；autostart on 时转交系统服务） |
| `opendweb hub stop` | 停止（按进程 owner 分叉） |
| `opendweb hub status` | 状态一屏+排障提示 |
| `opendweb hub card` | 重打接入卡片 |
| `opendweb hub open [深链]` | **本机中枢管理员入口**（r2-P1-2）：读 hub.json/hub-token 进程内起 admin sidecar 并开浏览器落点（token 绝不入 argv/URL/浏览器）；未 init→指引 init；服务未跑→落中枢状态卡 |
| `opendweb hub autostart on/off [--print]` | 用户级系统服务安装/卸载 |

- `hub` 进 BUILTIN_COMMANDS 恒优先；`tray` 不进（插件派发）。帮助与 PM §4.1
  逐字对齐；access 段不接受插件覆写。
- **平台承诺（r1-P1-1）**：darwin-arm64 + win32-x64；Linux 移后续 change；
  非承诺平台明确错误退出。proposal 已同步（不含 systemd）。
- **默认不启动（[H3] 负向钉死，r2-P2-7）**：全新 DWEB_HOME/未 init/未
  autostart 时，任何普通 opendweb 命令、无 hub.json 的 `opendweb webui`、
  用户登录/重启均 MUST NOT 产生 server 子进程或系统服务（负向 Scenario 见
  hub delta）。

### 1.2 状态模型与文件

| 文件 | 内容 | 写入纪律 |
|---|---|---|
| `<DWEB_HOME>/hub.json` | `{version:1, data_dir, gateway_bind, relay_bind, public_gateway_url?, public_relay_url?, config_path?, initialized_at, autostart}`（config_path=init 时若 cwd 有 opendweb.config.toml/json 则冻结其绝对路径） | 0600 原子写；**init 最后写**（零残留） |
| `<DWEB_HOME>/hub-token` | CSPRNG 高熵 admin token | 0600；不出现在任何输出/日志/卡片/IPC/URL |
| `<DWEB_HOME>/hub.pid` | **进程身份三元组** `{pid, start_identity, argv_digest}`（r2-P1-6：start_identity=平台进程启动时刻——macOS `ps -o lstart=`、Windows 进程 CreationDate；argv_digest=守护命令行摘要） | 仅 detached 写；stop/status 三重核验（pid 活+启动时刻匹配+argv 摘要匹配），**任一不符=不发信号只报告** |
| `<data_dir>/hub.lock` | 目录锁（pid+ts）；同目录第二进程=占用错误；陈锁（>10s 且 pid 死）可打破 | O_EXCL |

### 1.3 统一进程模型与环境冻结（r2-P1-3/P1-4）

`hub start`（detached/`--foreground`）执行同一链（node CLI 完整 server 编排：
插件钩子/配置解析/startServer/readiness/单飞停机）。**全宿主环境冻结**：

- **DWEB_DATA_DIR**：链入口从 hub.json 解析 data_dir 绝对路径注入 env
  （优先级：hub 注入 > 继承环境）；readiness 后**核实** owners.jsonl/server.key
  实际落 hub.json.data_dir（防静默写错目录；不符=启动失败）。
- **DWEB_ADMIN_TOKEN（r3-P1-1）**：链入口读取 hub-token 内容，以子进程 env
  `DWEB_ADMIN_TOKEN` 注入（server 仅在该 env 存在时挂载 /admin/*——
  main.rs:478-503 事实）；**hub 注入优先于继承的同名 env**（覆盖而非透传）；
  绝不进 argv/plist/启动脚本/日志。readiness 后以本机请求断言 admin 面已
  挂载：无 token 请求 `/admin/status` 得 **401（挂载）而非 404（未挂载）**，
  再以 hub-token 请求得 200；断言失败=启动失败（停机+清 lock，不假成功）。
  四宿主（前台/detached/LaunchAgent/Windows Startup）同一注入路径。
- **cwd 与配置上下文**：全宿主统一 `cwd=<DWEB_HOME>`；配置发现=hub.json.
  config_path（有则 `--config` 显式传入，无则无配置）。**不依赖 cwd 插件
  发现**——三宿主（前台/detached/系统服务）钩子与配置上下文逐一致
  （与「裸 server 在任意 cwd」不强求一致，承诺面=三宿主间一致+与 init 时
  冻结的配置一致；init 时 cwd 有配置则被冻结继承）。
- 差异仅在宿主：detached=自举 spawn 后 unref（pid 记录三元组）；系统服务
  =服务管理器 Exec；前台=用户终端。

### 1.4 开机自启（用户级；平台=承诺面）

| 平台 | 机制 | 冻结内容 |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.opendweb.hub.plist` | RunAtLoad+KeepAlive；ProgramArguments=绝对路径元组 `[process.execPath, <pkg>/bin/opendweb.mjs, hub, start, --foreground]`；WorkingDirectory=`<DWEB_HOME>`；EnvironmentVariables={DWEB_HOME, DWEB_HUB_SERVICE=1}（DWEB_DATA_DIR 由链入口从 hub.json 注入，不落 plist） |
| Windows | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\opendweb-hub.cmd`（APPDATA 展开真实绝对路径） | 脚本=绝对路径调用同命令；cwd=脚本内显式 `cd /d <DWEB_HOME>`；无 KeepAlive（v1 接受） |

- 联动：autostart on 时 `hub start`=安装/加载服务不另起 detached（服务
  child 经 DWEB_HUB_SERVICE=1 自识别，不重复 load、不写 pid）；`hub stop`
  =卸载服务+停残留；off 时 detached 直起/杀。安装/卸载失败不更新 hub.json。
- **生成物 quoting 冻结（r3-P2-3）**：plist ProgramArguments=数组序列化
  （XML 转义，无 shell 参与）；Windows .cmd 对含空格/`%`/`&`/非 ASCII 的
  路径做 cmd 转义（引号包裹+`%%` 双写），生成前对路径做包含性检查；测试
  含 path-with-spaces 与非 ASCII 用户目录的生成物快照 Scenario。
- **测试分层（r2-P2-5）**：单测=生成物文本快照（含真实绝对路径断言），
  不 load；**生命周期 acceptance**（install→登录触发→stop 不复活→start
  恢复→off 卸载）=实现期在真实账户手工/VM 执行一次并留验收记录
  （docs/acceptance-home-hub-autostart.md，交付物之一）。

### 1.5 init 自检（PM §4.2 三态）

端口占用（bind 探测→`--gateway/--relay` 指引）→ 网关 /healthz → 防火墙
提示（不做越权变更；检测失败=警告不阻塞）。局域网地址：枚举非环回 IPv4
（多网卡全列、卡片取首个并标注）；**IPv6 呈现仅接受可路由 ULA/global**
（link-local fe80::/10 拒绝入卡与短码，r2-P2-6——无 scope id 的 link-local
短码无法恢复正确接口）。

### 1.6 接管既有数据（r2-P1-7 收口）

init 检测目标 data_dir（默认 hub-data 或 `--data-dir`）与 cwd 既有
`dweb-data/`：

1. 目录含 server.key/owners.jsonl ⇒ 自动探测尽力而为（默认端口与常见
   变体 /healthz）；**可证明运行中=拒绝**（提示先停，绝不自动杀）；
2. **无法证明已停=强制人工确认**（确认文案明示「无法自动验证使用自定义
   端口的旧服务，请确认其已停止」）——不静默接管；
3. **data_dir 唯一规则**：发现 cwd `dweb-data` 被接管时，hub.json.data_dir
   MUST 指向该目录（只读接管，不复制不搬迁）；`--data-dir` 显式指定优先；
4. 接管成功前 hub.json 零写入；启动期 hub.lock 防同目录双开（旧裸 server
   不持锁的残余风险由步骤 2 的人工确认兜底，此边界写入确认文案）。

## 2. 多租约簿（[H7]-G1）

### 2.1 存储：`<DWEB_HOME>/leases.json`

```json
{ "version": 1, "leases": [
  { "id": "a1b2c3d4e5", "server": "http://192.168.2.13:8787", "relay_url": "http://192.168.2.13:3340",
    "server_id": "<hex64>", "fabric_id": "<hex64>", "root": "<hex64>",
    "alias": "kzf-MacBook", "label": null,
    "registered_at": 0, "expires_at": 0,
    "receipt": { "ts": 0, "generation": 0, "code_hash": "<hex64>", "receipt_sig": "<b64url>" } }
] }
```

- 键=(server 归一化 origin, fabric_id, root)；**id**=创建时随机 10 字符
  不透明键（label 路由与 UI 引用的稳定句柄，r2-P2-4）。
- **relay_url（r2-P1-1 入网闭环；r3-P1-2 补 null/disabled 语义）**：join
  已访问 `/services.json` 校验 server_id——relay 选择规则冻结：取
  `services[]` 中 `name=="relay" && enabled==true && url` 非空 null 的条目
  → relay_url=该值；**relay disabled 或 url=null → join fail-closed**
  （明确报错「中枢未启用中转，无法完成家庭接入」，不落租约条目——不产生
  「宣称已加入却不可连接」的租约；G-3 家庭链前提由此保证）。**成员连接
  该 server 时 MUST 经此 relay**：连接器从租约构造
  `FabricOptions.relay={mode:"custom",urls:[relay_url]}`（SDK 默认
  N0Default 不适用；knock.mjs 即此形态示范）；leases 消费者以此为唯一
  relay 真源。实现期端到端断言：join→读 lease→SDK relay mode=custom 且
  url=relay_url（非 N0Default）。
- **expires_at=本机最后一次成功兑换的租期快照（r2-P1-5 冻结）**：管理端
  renew 只改服务端 owners，**不回写本机**（无成员侧查询协议——Phase 2
  候选，超出本 change 的 Rust 零改动边界）；租约页以「本地快照」呈现，
  临期黄条副文案指引（PM §4.5 已同步：「若管理者已为你续期，数字在你
  下次持新码加入时刷新；能否连上以实际连接为准」）。
- 同键新码 join=续期 upsert（expires_at/receipt/relay_url 更新；
  **registered_at 保持首条**，镜像 ced9215）；alias 更新当前自报；换
  server=新条目。
- **写者与锁协议（r1-P1-6 不变）**：写者=join CLI、label 编辑；每账本
  `<name>.lock`（O_EXCL+锁内重读+合并+rename+锁归属校验+陈锁打破+退避）。
- **迁移**：旧 registration.json 在 leases 写锁内并入首条（relay_url 由
  server 探测补全——对 server origin 发 /services.json 读取，不可达=留空
  待下次 join 补）；旧文件改名 `.migrated`；损坏=警告不阻塞。

### 2.2 visits 到访簿（G-2，回归访客语义——r2-P2-3）

- `<DWEB_HOME>/visits.json`：`{version, visits:[{server, server_id?, first_visit_at, last_visit_at, last_probe:{result, detail?, at}, note}]}`；键=server origin；同款锁协议。
- **业务定义回归 PM §1.3/§3.4：到访=本机作为访客被放行后的记录。
  join 成功（租户路径）不写 visits**——只写 leases。写入触发（v1）：
  ①webui/CLI「测一下」探测动作（创建/更新条目）；②既有访客连接类
  命令成功时；③未来访客连接器（Phase 2）。first_visit_at=条目创建；
  last_visit_at=最近一次 reachable 探测时刻。
- **探测枚举（含五类确定映射）**：`result ∈ {reachable, unreachable}`，
  detail∈{http-status:<n>, timeout, dns, bad-body, conn-refused}；映射：
  2xx 且 services.json 可解析→reachable；非 2xx→unreachable/http-status；
  连接拒绝→conn-refused；DNS→dns；超时（5s）→timeout；**2xx 但 JSON 不可
  解析→unreachable/bad-body**。探测=无凭证 `GET <origin>/services.json`；
  「连不上」话术不含「被拒」语义。

## 3. 接入信息卡片与短码（[H1]/G-5）

### 3.1 短码 wire 冻结（r2-P1-8 全参数+golden vectors）

- **载荷（IPv4 9 字节 / IPv6 21 字节——修正 r2 指出的 11/23 笔误）**：
  `ver(1B: 0x01=IPv4/0x02=IPv6) || ip(4/16B) || port(2B 大端)`，后接
  `crc16(2B 大端)`；**CRC-16/CCITT-FALSE 覆盖 `ver||ip||port` 全部载荷字节
  （不含 CRC 自身）**；参数 poly=0x1021/init=0xFFFF/refin=false/refout=
  false/xorout=0x0000（校验向量 "123456789"→0x29B1）。
- **编码**：crockford-base32 **MSB-first**（自最高位每 5 bit 一字符），
  小写无 padding；**末尾不足 5 bit 右侧补零**。
- **解码 canonical 规则（r3-P1-3 修订，消除歧义映射 vs 非规范拒绝的矛盾）**：
  **严格 canonical 模式**——①仅接受 crockford 32 字符集（`0-9` +
  `abcdefghjkmnpqrstvwxyz`）；**歧义字符 o/i/l/u 出现即拒绝**（错误提示
  「o→0、i/l→1、u→v」但不自动映射）；②大小写折叠（全大写输入归一为小写
  后比对，混合大小写接受）；③连字符**仅允许出现在固定分组位置**且整组
  可省略（canonical 串=无连字符形态；IPv4 分组 5-5-5、IPv6 4×8+2；其他
  位置连字符=拒绝）；④前缀 `dwebh1.` 大小写不敏感；⑤非零 padding 位=
  拒绝、多余/缺失字符=拒绝（非规范等价串一律不接受）。测试变体清单：
  逐位篡改/歧义字符（o、i、l、u 各一）/错误位置连字符/末字符零位变体/
  超长/缺字符。
- **IPv6 URL 冻结**：解码结果 URL 形态 `http://[<ip>]:<port>`（字面量带
  方括号）；V2 断言=`http://[fd00::13]:8787`。
- **长度**：IPv4=15 字符（5-5-5 分组）、IPv6=34 字符（4×8+2）。
- **link-local 拒绝（r2-P2-6）**：编码端 fe80::/10 → 明确错误（提示用
  ULA/global）；解码端同样拒绝。
- **设计级 golden vectors（CLI/webui 共用同向量对拍）**：

| 向量 | 地址 | 载荷+CRC（hex） | 短码 |
|---|---|---|---|
| V1（IPv4） | 192.168.2.13:8787 | `01c0a8020d22537afd` | `dwebh1.070ag-0gd49-9qnz8` |
| V2（IPv6） | [fd00::13]:8787 | `02fd0000000000000000000000000000132253e506` | `dwebh1.0byg-0000-0000-0000-0000-0000-009j-4mz5-0r` |

- **接收端**：`opendweb join --server` 直收短码（`dwebh1.` 前缀→离线
  decode→`http://<ip>:<port>`）；失败即明确报错不发网络请求。实现单源
  （CLI util，webui workspace 复用）；测试=两向量往返+逐位篡改+非规范
  等价串拒绝（如末字符换为其零位变体）+link-local 拒绝。

### 3.2 卡片（三形态同源，PM §4.4）

数据源=hub.json+局域网地址；`hub card` 与 webui 卡同一生成函数；CLI 终端
ASCII QR（自含实现）、webui SVG（同算法）。**卡片无凭证（实现默认，依
[H1] 精神，O-8 未显式拍板可回退）**。

## 4. 三视角控制台（[H5]，webui IA v2）

### 4.1 路由与视角模型

现四页归「我的中枢」；新增 `#/lease`、`#/visits`；顶栏切换器（组 B），
视角决定全局渲染。默认视角：hub.json 存在→中枢；有租约→租约；有到访→
到访；全空→中枢引导态；记忆最近使用。F1（3s 轮询同拍）/F2（「仅租户
端点」副标）吸收；在线面区分「直连中/借道中」（G-3 口径）。

### 4.2 sidecar 模式分流（对 webui-console setup 条款的部分 supersedes）与数据面

**五行分流表（r2-P1-2 补 hub 本机行）**：

| 输入 | 模式 | 行为 |
|---|---|---|
| 显式 `--server`（±`--token`） | ready(admin) | 既有行为（含节点簿），不变 |
| 无参 + 本机 hub.json 存在 | **ready(admin)（hub 本机自动）** | sidecar 进程内读 hub-token 连本机中枢（`hub open` 即此形态的命令封装）；服务未跑=中枢视角+中枢状态卡；不进 setup |
| 无参 + 无 hub.json + 有 leases/visits | member | 不进 setup、不生成配对码、connect/nodes 403、`/admin/*` 全 404 无上游出站 |
| 无参 + 零本地数据 | setup | 基线保留（首次配对入口） |
| 任何状态 + `--setup` | setup | 显式强制入口 |

- **member 安全负向矩阵**：`/admin/*`（含编码变体/未知子路径）→404 无
  上游出站；`/sidecar/connect`/nodes→403；静态 SPA+只读数据面正常。
- **本机数据路由**（Host 守卫沿用基线；**写路由 Origin 策略严于基线**，
  r2-P2-2：probe/label 写路由要求 Origin **存在且匹配**——浏览器 same-origin
  必带；基线 guard 的「缺失 Origin 放行」只适用于旧读/配对面，新写路由
  不沿用）：`GET /sidecar/leases`、`GET /sidecar/visits`、`POST
  /sidecar/visits/probe`（四类 Origin：same-origin→200；缺失→403；不匹配/
  伪造→403；坏 Host→403）、`GET /sidecar/hub`（无 hub.json=404）、
  `PATCH /sidecar/leases/{id}/label`（**id=条目不透明键**，body
  `{label: string|null}`，≤64 UTF-8 字节，空串归一为 null=清除；未知 id=404；
  锁协议写入）。
- 租约视角首屏两问；到访视角=列表+探测+best-effort 页脚（PM §3.3/3.4）。

## 5. webui SDK 分层（[H4]）

### 5.1 包结构与 createConsole 契约（r2-P1-9 收口）

```
packages/webui/src/
  core/        # sidecar 运行时、NodeStore、leases/visits 读取+锁写、探测、
               # 事件总线、QR/短码算法、静态资源
  cli.mjs / plugin.mjs   # 薄壳（信号/开浏览器/退出留壳层）
```

- 导出：`.`=startSidecar（零破坏）+`createConsole(opts)`；NodeStore/
  validateTarget 导出；手写 index.d.ts。
- **createConsole 契约**：返回 `{ urlFor(deepLink?)→string（纯函数，core）,
   open(deepLink?), mode(), getSnapshot(), onEvent(type,fn)→disposer,
   switchTarget(id), close() }`——
  - **open=宿主注入回调**：`opts.opener(url)` 必填（CLI 壳注入既有
    openImpl，tray 注入自己的壳行为）；**core 不自带浏览器 spawn**
    （消除与「core 无进程语义」的矛盾）；
  - `urlFor` 返回的 URL 可含 sidecar **会话 capability v1（r3-P2-4 冻结）**：
    ≥128-bit CSPRNG、绑定 sidecar 实例（跨实例无效）、**单次消费**（重放=
    403+记录）、TTL（默认 120s）、close/进程退出立即失效；**非 hub-token/
    admin token**——hub-token/admin token 绝不入 URL/浏览器可见状态/IPC；
    URL query 参数不落访问日志（sidecar 自身日志纪律）、SPA 页面不外发
    referrer（`no-referrer` 政策）；重放/过期/跨实例/close 后使用=明确 403；
  - 事件 schema v1：`{v:1, type:"state-change"|"node-switch"|"knock-pending"
    |"error", payload, ts}`；disposer；close 后事件静默/再订阅抛错；
  - getSnapshot=调用时刻同步快照（三视角数据取齐）。

## 6. 托盘插件（[H2]）

- `packages/tray`（npm `opendweb-tray`，插件形态；不进 builtin；可选）。
- v1=无头控制器：createConsole 进程内消费（open 经注入 opener 深链）；
  心跳 `<DWEB_HOME>/tray-status.json`（schema v1：`{v:1, state:"error"|
  "knock"|"running"|"unconfigured", knocks_pending, ts}`；「未配置」可选
  呈现，O-5 不承诺纯成员机托盘）；数据源=hub.json/pid 身份核验+hub-token
  调 /admin/status（3s）+console 事件。
- **IPC 双模式（帧级冻结，r2-P2-5）**：默认=stdout JSON-lines 事件流
  （schema v1 同款）；`--ipc`=stdin/stdout JSON-RPC 2.0 newline 分帧。
  **不支持 notification 与 batch**（收到即 `-32600` error 响应）。完整
  golden 帧样例（契约测试冻结）：

```jsonl
→ {"jsonrpc":"2.0","id":1,"method":"open-console","params":{"deepLink":"#/lease"}}
← {"jsonrpc":"2.0","id":1,"result":{"ok":true}}
→ {"jsonrpc":"2.0","id":2,"method":"set-autostart","params":{"on":true}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"hub not initialized"}}
→ {"jsonrpc":"2.0","method":"open-console"}            ← notification：拒绝
← {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"notifications not supported"}}
→ [超长帧 >64KB]
← {"jsonrpc":"2.0","id":<前缀可解析则透传，否则 null>,"error":{"code":-32601,"message":"frame too large"}}
→ {坏 JSON}
← {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}
```

**所有响应帧（含全部 error）都携带 `"jsonrpc":"2.0"` 字段（r3-P1-4）**——
契约测试以严格 JSON-RPC 2.0 validator 逐帧校验；错误帧的 id 提取=语法解析
前的受限前缀扫描（非任意 JSON 执行）。

  stdin EOF=优雅退出；stderr 只归日志；hub-token 不经任何面暴露；进程
  退出（含崩溃）后心跳 mtime 停止（壳侧失联判定）。
- README 冻结壳侧契约（优先级表/菜单逐字/深链/失联判定/帧样例）。

## 7. G-3 技术对拍（r2-P1-1 收口后的最终口径）

**总裁决（条件化+入网闭环）**：家庭场景成员经 join 落盘的 relay_url
（源自中枢 /services.json）以 Custom relay 连入（§2.1 冻结；此为家庭
入网链的自然结果，不再是「显式高级配置」）；此条件下，已直连（Direct
path selected）会话在中枢全进程停掉后继续双向可达（QUIC 5s 心跳直发，
不经 relay）；relay-only 会话在数十秒内断开、中枢回来后自动恢复（时限
依网络环境）。任一方网络变更需经 relay 交换新地址而 relay 不可用期间，
直连会话死亡、中枢回来后由重连 worker 恢复。N0Default 配置（显式选择
n0 公共 relay 的用户）不在本结论内。

- **delta 验收义务（r2-P1-1，写入 hub delta Scenario）**：join 后 leases
  的 relay_url=services.json relay URL；G-3 行为验收=Rust test-only 用例
  （下）+「停整个 hub（gateway+rendezvous+relay）→ 已直连会话双向可达 →
  停机期新 join 失败 → 重启 hub 新成员可入」。
- **Rust test-only 用例（relay_failover.rs）**：①两节点 Custom relay 指向
  测试 server 并 join；②断言 `link_status==Direct`；③**停整个 server
  进程**；④双向 send ≥300s 零中断；⑤同窗口新节点 join 失败；⑥重启
  server→新成员 join 成功。**relay-only 对照**：docker 双 bridge 隔离
  UDP 为必需尝试；**降级的客观封存条件（r3-P2-2）**：仅当 acceptance
  记录（docs/acceptance-home-hub-g3.md，模板六字段：环境/镜像与网络拓扑/
  命令清单/时间窗口/原始日志摘要/结论）以可复现实验证据写明
  `NOT-EXECUTABLE` 及原因时方可降级（尝试义务=至少一次可复现实验+失败
  时限记录）；降级后 PM 文案维持「时限依网络环境」口径（已按此书写，
  见 PRODUCT-DESIGN §1.2），发布清单必须引用该记录——不得把设计级 G-3
  表述标注为已断言。
- 「无限期」废除；文案口径「已直连不受影响+借道自动恢复」（PM 已同步）。

## 8. 测试策略

- **CLI**：hub 状态文件原子性（故障注入）；短码 golden vectors（V1/V2
  往返+逐位篡改+非规范等价拒绝+link-local 拒绝）+CLI/webui 对拍；join
  直收短码+relay_url 落盘；leases/visits 锁协议并发；迁移三形态+不可达
  server 的 relay_url 留空补全；init 零残留（各步故障注入）；接管（运行中
  拒绝/不可证明=人工确认交互/陈锁打破/活锁占用/接管后 data_dir 唯一规则）；
  detached 启停（**pid 身份三元组：同 execPath 无关 node 脚本占 pid→stop
  不发信号**）；DWEB_DATA_DIR 注入与核实（跨宿主）；自启生成物快照；
  **默认不启动负向**（全新 DWEB_HOME 全命令探针）。
- **webui**：基线零回归；三视角/五行分流矩阵（含 hub 本机 admin、--setup）；
  member 负向矩阵；label（id 路由/空串清除/并发）；createConsole（urlFor/
  注入 open/golden 事件帧/close）。
- **tray**：IPC golden 帧（含 notification/batch 拒绝、超长 id 恢复、坏帧
  续流、EOF）；心跳优先级；token 不出面。
- **G-3（test-only Rust）**：§7 用例；全量基线快照。
- **acceptance（非单测）**：自启生命周期真实账户记录（§1.4）；G-3 relay-only
  对照或降级记录。
- 门禁：npm test 分包；`git diff --check`；checkjs。

## 9. 任务分解

- **Phase 1（CLI）**：1a 状态模型+init（接管/自检/零残留/config_path 冻结）；
  1b 统一进程模型（DWEB_DATA_DIR 注入核实/三宿主/pid 三元组）+stop/status；
  1c autostart 两平台+联动+acceptance 记录；1d leases（id/relay_url/快照
  语义/锁/迁移）+join 改造；1e 短码（vectors）+卡片+hub open。
- **Phase 2（webui）**：2a core 分层+createConsole（urlFor/注入 open）；2b
  三视角+五行分流+数据面（label by id）+负向矩阵；2c 卡片卡+探测+直连/借道。
- **Phase 3**：3a tray（IPC golden）；3b G-3 用例；3c 上架+文档。
- 依赖序：1a→1b→1c；1d/1e 并行；2a→2b/2c；3a 依赖 2a+1b；3b 独立。

## 10. 评审处置记录

| 轮 | 结论 | 处置 |
|---|---|---|
| r1（02545d5） | NOT-READY 6.2，P1×9+P2×5 | 全处置（v2，330fa8f）——详表见 git 历史 |
| r3 | NOT-READY 7.3，P1×4+P2×4 | 全处置（v4，本版）：P1-1 DWEB_ADMIN_TOKEN 链入口注入（覆盖继承 env）+readiness 双探断言（无 token 401≠404 + token 200）+失败停机清锁（§1.3）；P1-2 relay null/disabled=join fail-closed 不落租约+连接器从租约构造 custom（§2.1）；P1-3 短码严格 canonical（歧义字符拒绝不映射+连字符仅固定分组位置+大小写折叠）+IPv6 bracket URL 冻结 V2 断言（§3.1）；P1-4 全部 error 帧补 jsonrpc 字段+严格 validator 逐帧校验（§6）；P2-1 proposal/PM 旧词残留清理+rg 门禁；P2-2 G-3 acceptance 模板六字段+NOT-EXECUTABLE 客观条件（§7）；P2-3 生成物 quoting 冻结+特殊路径 Scenario（§1.4）；P2-4 capability v1 冻结（§5.1） |
| r2 | NOT-READY 7.0，P1×9+P2×7 | 全处置（v3）：P1-1 入网闭环=join 落 relay_url（§2.1）+delta Scenario+G-3 验收义务（§7）；P1-2 hub open 命令+五行分流表 hub 本机行（§1.1/§4.2）；P1-3 DWEB_DATA_DIR 全宿主注入+启动后核实（§1.3）；P1-4 cwd 统一 DWEB_HOME+config_path 冻结+承诺面改为三宿主间一致（§1.3）；P1-5 expires_at=本地快照冻结+PM 文案同步（§2.1）；P1-6 pid 三元组（start_identity+argv 摘要）三重核验（§1.2）；P1-7 接管=尽力探测+强制人工确认+data_dir 唯一规则（§1.6）；P1-8 字节修正 9/21+CRC 覆盖范围+MSB/padding 位/非规范拒绝+设计级 golden vectors V1/V2（§3.1）；P1-9 urlFor+open=注入 opener+url 会话 capability 非 admin token（§5.1）；P2-1 PM/proposal 残留清理（已裁决记录化/平台同步）；P2-2 写路由 Origin 严格策略（存在且匹配，不沿用基线放行）（§4.2）；P2-3 visits 回归访客语义（join 不写）+五类映射（§2.2）；P2-4 label 用不透明 id+空串归一 null（§2.1/§4.2）；P2-5 RPC 完整 golden 帧+notification/batch 拒绝+服务验收分层（§1.4/§6）；P2-6 link-local 拒绝（§1.5/§3.1）；P2-7 默认不启动负向 Scenario（§1.1） |
