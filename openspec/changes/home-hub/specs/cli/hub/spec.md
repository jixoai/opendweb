## ADDED Requirements

### Requirement: 中枢命令族（opendweb hub）

`opendweb` CLI SHALL 提供中枢命令族 `opendweb hub <sub>`（builtin 恒优先于 marketplace 派发，同名插件不得抢占）：`init`（一次性家庭预设：接管检测+restricted 门禁+管理凭证本机落地+端口自检+接入卡片+自启引导，交互确认）；`start [--foreground]`（统一进程模型——见「中枢守护进程模型」）；`stop`（按进程 owner 分叉）；`status`（运行/地址/成员/敲门/自启一屏+排障提示）；`card`（重打接入卡片）；`autostart on|off [--print]`。中枢是显式选择的一等本地服务：MUST NOT 存在任何默认启动行为（[H3]）。帮助文案与 PRODUCT-DESIGN §4.1 用户语言逐字对齐；access 段（门禁/凭证）不接受插件覆写（延续 server 命令安全面白名单纪律）。**平台承诺冻结**：本 change 交付 macOS（darwin-arm64）与 Windows（win32-x64）——与 CLI 入口门及 server-binary 捆带平台一致；Linux 自启（systemd user unit）移后续 change；非承诺平台执行 hub 子命令 MUST 以明确错误退出（非静默）。

#### Scenario: 一键变中枢

- **WHEN** 支持平台上常开机器执行 `opendweb hub init` 并确认
- **THEN** 走完确认→凭证落地→自检→卡片→自启引导，全程无未解释工程术语；restricted 模式、admin token 只落本机 0600 文件

#### Scenario: 非承诺平台明确拒绝

- **WHEN** 在本 change 平台承诺之外的系统执行任意 `opendweb hub` 子命令
- **THEN** 非零退出并输出平台不支持说明（含当前承诺平台清单），不产生任何文件或进程

#### Scenario: builtin 优先

- **WHEN** marketplace 存在名为 `hub` 的插件且用户执行 `opendweb hub status`
- **THEN** 派发到内置 hub 命令族，不解析插件

### Requirement: 中枢状态模型（DWEB_HOME 文件族）

中枢状态 SHALL 落 `<DWEB_HOME>/hub.json`（version/data_dir/gateway_bind/relay_bind/public urls?/initialized_at/autostart）、`<DWEB_HOME>/hub-token`（CSPRNG 高熵 admin token）、`<DWEB_HOME>/hub.pid`（**仅 detached 守护进程**写；系统服务与前台模式不写——owner 分属服务管理器/用户终端）；写入 MUST 沿用 SecretStore 原子纪律（0600、tmp(O_EXCL)+fsync+rename、symlink 拒绝 lstat 守卫）；hub-token MUST NOT 出现在任何日志/输出/卡片/tray IPC。`data_dir` 默认 `<DWEB_HOME>/hub-data`；家庭端口冻结 gateway 8787 / relay 3340（占用时自检失败并给 `--gateway/--relay` 指引）。**init 零残留**：hub.json 在全流程（检测/确认/凭证/自检）成功后最后写；任一步失败 MUST NOT 留下 hub.json/hub-token/hub.pid 部分状态。`hub stop`/`status` MUST 校验 pid 存活性（pid 存在+可执行名含 node/opendweb，防 pid 复用误杀）；孤儿 pid 文件（进程已消）清理后如实报告。

#### Scenario: init 失败零残留（故障注入）

- **WHEN** 注入自检失败（如端口被占）使 init 中途中止
- **THEN** DWEB_HOME 下不存在 hub.json/hub-token/hub.pid；重试成功后三者齐备且权限均为 0600

#### Scenario: pid 复用防护

- **WHEN** 守护进程退出且其 pid 被无关进程复用后执行 `opendweb hub stop`
- **THEN** pid 校验发现可执行名不匹配，不向该进程发信号，清理孤儿 pid 文件并报告「中枢未在运行」

### Requirement: 中枢守护进程模型（统一执行链）

`hub start` 的 detached 与 `--foreground` 形态 SHALL 执行**同一链**（node CLI 完整 server 编排：插件 preStart/postReady/preStop 钩子、配置解析、startServer、/healthz readiness、单飞停机）——差异仅在进程宿主：detached=start 以 `spawn(process.execPath, [bin/opendweb.mjs 绝对路径, hub, start, --foreground], {detached, stdio→<data_dir>/hub.log})` 自举后 unref，守护进程=node CLI 并记 hub.pid；前台=用户终端。插件钩子语义 MUST 与裸 `opendweb server` 逐一致（含 preStop 清理；不存在静默绕过）。stop 对 detached 守护进程发 SIGINT（经既有单飞停机级联停 binary），5s 后 SIGKILL 兜底。**data_dir 目录锁**：启动前于 `<data_dir>/hub.lock` O_EXCL 建锁（内容 pid+ts）；同目录第二进程启动 MUST 得到占用错误；陈锁（mtime>10s 且 pid 已死）可打破接管。

#### Scenario: detached 与前台同链

- **WHEN** 分别以 detached 与 `--foreground` 启动（注册了 preStart/preStop 插件）
- **THEN** 两种形态下钩子均按 server 命令语义执行（preStart 生效、退出时 preStop 被调用）；差异仅进程宿主与 pid 记录

#### Scenario: 同数据目录互斥

- **WHEN** 中枢已在运行时第二次 `opendweb hub start`
- **THEN** 第二次启动因 hub.lock 占用失败，输出占用方 pid；首次运行不受影响

### Requirement: 开机自启（hub autostart）

`opendweb hub autostart on` SHALL 安装**用户级**系统服务（不提权，仅限平台承诺面）：macOS=LaunchAgent `~/Library/LaunchAgents/com.opendweb.hub.plist`（RunAtLoad+KeepAlive；`ProgramArguments`=init 时冻结的绝对路径元组 `[node 绝对路径, opendweb.mjs 绝对路径, hub, start, --foreground]`，不依赖 PATH；EnvironmentVariables 含 DWEB_HOME 与 `DWEB_HUB_SERVICE=1`）；Windows=启动脚本落 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`（env 展开真实绝对路径；脚本内为冻结绝对路径调用；无 KeepAlive，v1 接受）。生成物纯文本可 `--print` 预览。**联动语义冻结**：autostart on 时 `hub start`=安装/加载服务不另起 detached（服务 child 经 `DWEB_HUB_SERVICE=1` 识别自身宿主，不重复 load、不写 pid）；`hub stop`=先卸载服务（bootout/删脚本）再停残留进程；off 时 start=detached 直起、stop=杀 detached。安装/卸载失败 MUST NOT 更新 hub.json 的 autostart 状态（不假成功）。测试 MUST 以生成物文本快照（含真实绝对路径断言）验收，MUST NOT 在测试中实际 load 系统服务。

#### Scenario: 自启后重启回来

- **WHEN** autostart on 后重启机器
- **THEN** 中枢进程由服务管理器自动恢复（KeepAlive/RunAtLoad），无需人工干预

#### Scenario: stop 不被自启拉回

- **WHEN** autostart on 状态下执行 `opendweb hub stop`
- **THEN** 服务卸载+进程停止，重启前不再自动运行；此后 `hub start` 恢复运行且不写 hub.pid（由服务管理器拥有生命周期）

#### Scenario: 安装失败不假成功

- **WHEN** 注入 plist 写入失败后执行 `opendweb hub autostart on`
- **THEN** 非零退出，hub.json 的 autostart 保持 false

### Requirement: 接管既有数据目录（安全交接）

`hub init` SHALL 在检测到目标 data_dir（含 cwd 既有 `dweb-data/`）存在 server.key/owners.jsonl 时执行交接协议：①**运行中检测**（gateway/relay 端口 /healthz 可达）⇒ MUST 拒绝接管并提示先停旧服务（绝不自动杀）；②未运行⇒二次确认后接管（名册/密钥保留，不并行第二套）；③启动期 hub.lock 保证同目录单进程；④接管成功前 hub.json 零写入。旧 server 使用自定义 DWEB_DATA_DIR 的场景由 `--data-dir` 显式交接，cwd 扫描仅覆盖默认形态。

#### Scenario: 运行中服务拒绝接管

- **WHEN** 旧 server 正在运行（gateway /healthz 可达）时对其数据目录执行 `opendweb hub init`
- **THEN** 拒绝接管，输出「先停旧服务」指引；旧进程未被触碰，数据目录未被修改

#### Scenario: 已停服务确认接管

- **WHEN** 旧 server 已退出，对其数据目录 init 并确认接管
- **THEN** owners.jsonl/server.key 原样保留；hub 启动后名册可读；不产生第二套数据目录

### Requirement: 接入短码（离线自解 wire 冻结）

短码 SHALL 为跨端 wire contract，全参数一次冻结：载荷=`ver(1B: 0x01=IPv4/0x02=IPv6) || ip(4/16B) || port(2B 大端) || crc16(2B 大端)`；CRC-16/CCITT-FALSE（poly=0x1021, init=0xFFFF, refin=false, refout=false, xorout=0x0000；校验向量 "123456789"→0x29B1）；编码=crockford-base32 小写无 padding（解码大小写不敏感、歧义字符按 crockford 映射）；**长度冻结** IPv4=15 字符、IPv6=34 字符；呈现=`dwebh1.` 前缀+连字符分组（IPv4 5-5-5；IPv6 4×8+2），解码忽略连字符。解码 MUST 离线（零在线依赖）且四重校验（前缀/版本/长度/CRC），任一失败给明确错误。**接收端入口**：`opendweb join --server` MUST 直收短码（检测 `dwebh1.` 前缀→离线 decode→`http://<ip>:<port>`；失败即明确报错，不猜测）。实现单源（CLI util，webui workspace 复用同文件）；实现首提交 MUST 附 ≥2 固定向量（IPv4+IPv6 完整短码串）与逐位篡改测试，向量同时进 CLI 与 webui 对拍。

#### Scenario: 已知向量往返与篡改

- **WHEN** 对冻结向量（IPv4 与 IPv6 各一）编码后解码，以及对载荷字符逐位替换后解码
- **THEN** 完整往返还原相同 ip:port；任一位篡改均解码失败并报明确错误

#### Scenario: 只拿短码完成加入

- **WHEN** 设备 B 仅获得设备 A 的接入短码（无 URL），执行 `opendweb join --server <短码> --code <有效码>`
- **THEN** 短码被离线解码为中枢地址并完成注册；篡改过的短码在解码层即失败，不发出网络请求

#### Scenario: 卡片无凭证（实现默认）

- **WHEN** 审查 `opendweb hub card` 与 webui 卡片的全部输出
- **THEN** 含地址/短码/二维码/引导文案，不含 admin token、邀请码或回执材料
