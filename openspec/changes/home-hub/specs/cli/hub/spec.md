## ADDED Requirements

### Requirement: 中枢命令族（opendweb hub）

`opendweb` CLI SHALL 提供中枢命令族 `opendweb hub <sub>`（builtin 恒优先于 marketplace 派发，同名插件不得抢占）：`init`（接管检测+家庭预设+自检+凭证+卡片+自启引导，交互确认）；`start [--foreground]`（统一进程模型）；`stop`（按进程 owner 分叉）；`status`；`card`（重打接入卡片）；`open [深链]`（**本机中枢管理员入口**：读 hub.json/hub-token 进程内起 admin sidecar 并开浏览器落点；hub-token MUST NOT 入 argv/URL/浏览器状态；未 init=指引 init，服务未跑=落中枢状态卡）；`autostart on|off [--print]`。中枢 MUST NOT 存在任何默认启动行为（[H3]）：全新 DWEB_HOME/未 init/未 autostart 时，普通 opendweb 命令、无 hub.json 的 `opendweb webui`、用户登录/重启均 MUST NOT 产生 server 子进程或系统服务。帮助文案与 PRODUCT-DESIGN §4.1 逐字对齐；access 段不接受插件覆写。**平台冻结**：darwin-arm64+win32-x64；非承诺平台明确错误退出。

#### Scenario: 默认不启动（负向探针）

- **WHEN** 全新 DWEB_HOME（未 init/未 autostart）下依次执行普通 opendweb 命令、`opendweb webui`、并模拟登录会话
- **THEN** 全程无 server 子进程、无系统服务安装、无 hub 状态文件产生

#### Scenario: 一键变中枢

- **WHEN** 支持平台上常开机器执行 `opendweb hub init` 并确认
- **THEN** 走完确认→凭证落地→自检→卡片→自启引导；restricted 模式、admin token 只落本机 0600 文件

#### Scenario: hub open 无文档可达管理台

- **WHEN** hub init 完成后（本机尚无任何租约/到访数据）执行 `opendweb hub open`
- **THEN** 浏览器打开的 webui 落在「我的中枢」视角（admin 态）；hub-token 未出现在 argv/URL/浏览器任何可见状态

#### Scenario: 非承诺平台明确拒绝 / builtin 优先

- **WHEN** 承诺外平台执行 hub 子命令 / marketplace 存在同名 `hub` 插件
- **THEN** 前者非零退出+平台说明、零副作用；后者派发内置命令族

### Requirement: 中枢状态模型（DWEB_HOME 文件族）

中枢状态 SHALL 落 `<DWEB_HOME>/hub.json`（version/data_dir/gateway_bind/relay_bind/public urls?/**config_path?**（init 时 cwd 有 opendweb.config.toml|json 则冻结绝对路径）/initialized_at/autostart）、`<DWEB_HOME>/hub-token`（CSPRNG 高熵）、`<DWEB_HOME>/hub.pid`（仅 detached 宿主写；内容=**进程身份三元组** `{pid, start_identity, argv_digest}`——start_identity=平台进程启动时刻（macOS `ps -o lstart=` / Windows CreationDate），argv_digest=守护命令行摘要）；写入沿用 SecretStore 原子纪律（0600+tmp(O_EXCL)+fsync+rename+symlink 拒绝）；hub-token MUST NOT 出现在任何日志/输出/卡片/tray IPC/URL。data_dir 默认 `<DWEB_HOME>/hub-data`；端口冻结 8787/3340。**init 零残留**：hub.json 全流程最后写，任一步失败不留部分状态。**pid 三重核验**：stop/status MUST 同时校验 pid 存活+启动时刻匹配+argv 摘要匹配，任一不符=不发信号只报告（防 pid 复用误杀——含同 execPath 的无关 node 进程）。`<data_dir>/hub.lock`（O_EXCL，pid+ts）：同目录第二进程=占用错误；陈锁（>10s 且 pid 死）可打破。

#### Scenario: init 失败零残留（故障注入）

- **WHEN** 注入自检失败（端口被占）使 init 中途中止
- **THEN** DWEB_HOME 无 hub.json/hub-token/hub.pid；重试成功后三者齐备且 0600

#### Scenario: pid 复用防护（同执行文件）

- **WHEN** 守护进程退出后，其 pid 被一个**同 node 可执行文件**的无关脚本复用，此时执行 `opendweb hub stop`
- **THEN** 启动时刻/argv 摘要核验不匹配→不发任何信号；清理孤儿 pid 文件并报告「中枢未在运行」

### Requirement: 中枢守护进程模型（统一执行链与环境冻结）

`hub start` 的 detached 与 `--foreground` SHALL 执行同一链（node CLI 完整 server 编排：插件钩子/配置解析/startServer/readiness/单飞停机）；detached=自举 spawn（`spawn(process.execPath, [bin/opendweb.mjs 绝对路径, hub, start, --foreground], {detached, stdio→<data_dir>/hub.log})` 后 unref，pid 记录三元组）。**全宿主环境冻结**：①链入口从 hub.json 解析 data_dir 绝对路径注入 `DWEB_DATA_DIR`（优先级=hub 注入>继承环境），readiness 后 MUST 核实 owners.jsonl/server.key 实际落在 hub.json.data_dir（不符=启动失败，不假成功）；②**链入口读取 hub-token 内容以子进程 env `DWEB_ADMIN_TOKEN` 注入**（server 仅在该 env 存在时挂载 `/admin/*`；hub 注入 MUST 覆盖继承的同名 env；绝不进 argv/plist/启动脚本/日志）；readiness 后 MUST 以本机双探断言 admin 面挂载：无 token 请求 `/admin/status` 得 **401（已挂载）而非 404**，再以 hub-token 请求得 200——断言失败=启动失败（停机+清 hub.lock，不假成功）；③全宿主统一 `cwd=<DWEB_HOME>`、配置=config_path 显式传入（无则无配置），**不依赖 cwd 插件发现**——前台/detached/系统服务三宿主的插件钩子与配置上下文 MUST 逐一致（承诺面=三宿主间一致+与 init 冻结配置一致）。stop 对 detached 守护进程 SIGINT（单飞停机级联）→5s→SIGKILL。

#### Scenario: data_dir 注入与核实

- **WHEN** 继承环境中存在指向别处的 DWEB_DATA_DIR，且以 detached/前台/服务三种宿主分别启动 hub
- **THEN** 三种宿主下 server 实际数据目录均为 hub.json.data_dir（owners.jsonl 落该目录）；hub 注入优先于继承值

#### Scenario: admin 面挂载断言（四宿主）

- **WHEN** 分别以前台/detached/LaunchAgent/Windows Startup 四宿主启动 hub
- **THEN** readiness 后无 token 请求 `/admin/status` 得 401（非 404）、以 hub-token 请求得 200；hub-token 不出现在 argv/plist/脚本/日志任何面；断言失败时启动失败并清理 hub.lock

#### Scenario: 三宿主插件钩子一致

- **WHEN** 注册了 preStart/postReady/preStop 插件（init 时 cwd 配置被冻结）后分别以前台/detached/系统服务启动并停止
- **THEN** 三宿主的钩子触发与配置内容逐一致

#### Scenario: 同数据目录互斥

- **WHEN** 中枢已在运行时第二次 `opendweb hub start`
- **THEN** 第二次因 hub.lock 占用失败并输出占用方 pid；首次运行不受影响

### Requirement: 开机自启（hub autostart）

`opendweb hub autostart on` SHALL 安装用户级系统服务（不提权，仅限承诺平台）：macOS=LaunchAgent `~/Library/LaunchAgents/com.opendweb.hub.plist`（RunAtLoad+KeepAlive；ProgramArguments=init 时冻结的绝对路径元组；WorkingDirectory=`<DWEB_HOME>`；EnvironmentVariables={DWEB_HOME, DWEB_HUB_SERVICE=1}——**DWEB_DATA_DIR 不落 plist**，由链入口从 hub.json 注入）；Windows=`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\opendweb-hub.cmd`（APPDATA 展开真实绝对路径；脚本内显式 `cd /d <DWEB_HOME>`；无 KeepAlive，v1 接受）。联动：autostart on 时 `hub start`=安装/加载服务不另起 detached（服务 child 经 DWEB_HUB_SERVICE=1 自识别，不重复 load、不写 pid）；`hub stop`=先卸载服务再停残留；off 时 detached 直起/杀。安装/卸载失败 MUST NOT 更新 hub.json。**测试分层**：单测=生成物文本快照（真实绝对路径断言，不 load）；生命周期 acceptance（install→登录触发→stop 不复活→start 恢复→off 卸载）=实现期真实账户执行一次并留验收记录。

#### Scenario: 自启后重启回来 / stop 不被拉回 / 安装失败不假成功

- **WHEN** autostart on 后重启机器 / on 状态下 `hub stop` / 注入 plist 写入失败后 `autostart on`
- **THEN** 重启后中枢自动恢复 / 服务卸载+进程停止且重启前不再自动运行（此后 start 由服务管理器拥有，不写 hub.pid）/ 非零退出且 hub.json.autostart 保持 false

### Requirement: 接管既有数据目录（安全交接）

`hub init` 检测目标 data_dir（含 cwd 既有 `dweb-data/`）存在 server.key/owners.jsonl 时 SHALL 执行交接协议：①自动探测尽力而为（默认端口与常见变体 /healthz）——**可证明运行中=拒绝接管**（提示先停，绝不自动杀）；②**无法证明已停=强制人工确认**（确认文案明示「无法自动验证使用自定义端口的旧服务」），不静默接管；③**data_dir 唯一规则**：发现 cwd `dweb-data` 被接管时 hub.json.data_dir MUST 指向该目录（只读接管，不复制不搬迁）；`--data-dir` 显式指定优先；④接管成功前 hub.json 零写入；启动期 hub.lock 防同目录双开（旧裸 server 不持锁的残余风险由②的人工确认兜底，写入确认文案）。旧 server 使用自定义 DWEB_DATA_DIR 的场景由 `--data-dir` 显式交接。

#### Scenario: 自定义端口旧服务的强制确认

- **WHEN** 旧 server 以非默认端口运行（自动探测不可达），init 指向其数据目录
- **THEN** 不静默接管：输出强制人工确认（含「无法自动验证自定义端口旧服务」提示）；用户拒绝=中止且零残留；用户确认而旧服务实为运行中=hub.lock 之外该残余风险已在确认文案明示

#### Scenario: 已停服务确认接管

- **WHEN** 旧 server 已退出，对其数据目录 init 并确认接管
- **THEN** owners.jsonl/server.key 原样保留于该目录（hub.json.data_dir=该目录）；不产生第二套数据目录

### Requirement: 接入短码（离线自解 wire 冻结）

短码 SHALL 为跨端 wire contract：载荷=**IPv4 9 字节 / IPv6 21 字节**（`ver(1B: 0x01/0x02) || ip(4/16B) || port(2B 大端)`），后接 `crc16(2B 大端)`；**CRC-16/CCITT-FALSE 覆盖 `ver||ip||port` 全部载荷字节（不含 CRC 自身）**，参数 poly=0x1021/init=0xFFFF/refin=false/refout=false/xorout=0x0000（校验向量 "123456789"→0x29B1）。编码=crockford-base32 **MSB-first**、小写、无 padding、末尾不足 5 bit 右侧补零；长度冻结 IPv4=15 字符（5-5-5 分组）/IPv6=34 字符（4×8+2）；呈现 `dwebh1.` 前缀+连字符。**解码严格 canonical**：①仅接受 crockford 32 字符集，**歧义字符 o/i/l/u 出现即拒绝**（提示 o→0、i/l→1、u→v，不自动映射）；②大小写折叠（全大写归一小写）；③连字符仅允许固定分组位置且整组可省略（canonical=无连字符形态；其他位置连字符拒绝）；④非零 padding 位/多余/缺失字符/非法字符拒绝（非规范等价串不接受）。**IPv6 URL 冻结**：解码结果 `http://[<ip>]:<port>`（V2 断言=`http://[fd00::13]:8787`）。**link-local（fe80::/10）编码与解码均拒绝**（提示用 ULA/global）。**设计级 golden vectors（CLI/webui 共用对拍）**：V1 `192.168.2.13:8787`→payload+crc `01c0a8020d22537afd`→`dwebh1.070ag-0gd49-9qnz8`；V2 `[fd00::13]:8787`→`02fd0000000000000000000000000000132253e506`→`dwebh1.0byg-0000-0000-0000-0000-0000-009j-4mz5-0r`。**接收端**：`opendweb join --server` MUST 直收短码（`dwebh1.` 前缀→离线 decode→`http://<ip>:<port>`；失败即明确报错、不发网络请求）。实现单源（CLI util，webui workspace 复用）。

#### Scenario: golden vectors 往返与篡改

- **WHEN** 对 V1/V2 编码后解码（断言 V2 URL=`http://[fd00::13]:8787`）、逐位替换载荷字符、把末字符替换为零 padding 位变体、注入歧义字符（o/i/l/u 各一）、在非分组位置插连字符
- **THEN** 完整往返还原相同 ip:port 与 bracket URL；逐位篡改/零位变体/歧义字符/错位连字符均解码失败（歧义字符错误含映射提示）

#### Scenario: link-local 拒绝

- **WHEN** 对 fe80::1 编码、或对含 fe80 载荷的串解码
- **THEN** 双向明确报错并提示使用可路由 ULA/global 地址

#### Scenario: 只拿短码完成加入

- **WHEN** 设备 B 仅获得接入短码（无 URL），执行 `opendweb join --server <短码> --code <有效码>`
- **THEN** 短码离线解码为中枢地址并完成注册；篡改短码在解码层失败、不发出网络请求

#### Scenario: 卡片无凭证（实现默认）

- **WHEN** 审查 `opendweb hub card` 与 webui 卡片的全部输出
- **THEN** 含地址/短码/二维码/引导文案，不含 admin token、邀请码或回执材料

### Requirement: G-3 停机行为的 delta 验收（test-only）

「中枢停掉，已直连成员互传不受影响」SHALL 由 test-only Rust 用例验收（dweb-fabric/tests/relay_failover.rs 增量，产品代码零改动）：两节点以 Custom relay 指向测试 server join 并断言 `link_status==Direct` 后，**停整个 server 进程**（gateway+rendezvous+relay）→ 双向 send ≥300s 零中断 → 停机窗口内新节点 join 失败 → 重启 server 后新成员 join 成功。relay-only 对照（docker 双 bridge 隔离 UDP）为必需尝试；**证不可行的降级路径**=设计记录环境限制与证据链+自动恢复时限文案保持「依网络环境」口径+不得宣称已自动断言。

#### Scenario: 停整个中枢后直连会话存活（Rust test-only）

- **WHEN** 测试中两成员已建立 Direct 会话且 server 全进程被停止 300s
- **THEN** 双向消息零中断；窗口内新 join 失败；server 重启后新成员可加入
