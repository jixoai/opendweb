## ADDED Requirements

### Requirement: 中枢命令族（opendweb hub）

`opendweb` CLI SHALL 提供中枢命令族 `opendweb hub <sub>`（builtin 恒优先于 marketplace 派发，同名插件不得抢占）：`init`（一次性家庭预设：restricted 门禁+管理凭证本机落地+端口自检+接入卡片+自启引导，交互确认）；`start [--foreground]`（默认 detached 守护直启 server-binary；`--foreground` 走既有 `server` 命令全链含插件钩子）；`stop`；`status`（运行/地址/成员/敲门/自启一屏+排障提示）；`card`（重打接入卡片）；`autostart on|off`。中枢是显式选择的一等本地服务：MUST NOT 存在任何默认启动行为（[H3]）。帮助文案与 PRODUCT-DESIGN §4.1 用户语言逐字对齐；access 段（门禁/凭证）不接受插件覆写（延续 server 命令安全面白名单纪律）。

#### Scenario: 一键变中枢

- **WHEN** 常开机器上执行 `opendweb hub init` 并确认
- **THEN** 走完确认→凭证落地→自检→卡片→自启引导，全程无未解释工程术语；restricted 模式、admin token 只落本机 0600 文件

#### Scenario: 守护启动与停止

- **WHEN** `opendweb hub start` 后执行 `opendweb hub status`，再 `opendweb hub stop`
- **THEN** start 后台拉起并以 /healthz 确认就绪后返回；status 报告运行态与地址；stop 以 SIGINT→5s→SIGKILL 停止并清理 pid 记录；stop 后 status 报告未运行

#### Scenario: builtin 优先

- **WHEN** marketplace 存在名为 `hub` 的插件且用户执行 `opendweb hub status`
- **THEN** 派发到内置 hub 命令族，不解析插件

### Requirement: 中枢状态模型（DWEB_HOME 文件族）

中枢状态 SHALL 落 `<DWEB_HOME>/hub.json`（version/data_dir/gateway_bind/relay_bind/public urls?/initialized_at/autostart）、`<DWEB_HOME>/hub-token`（CSPRNG 高熵 admin token）、`<DWEB_HOME>/hub.pid`（守护 pid）；三者写入 MUST 沿用 SecretStore 原子纪律（0600、tmp(O_EXCL)+fsync+rename、symlink 拒绝 lstat 守卫）；hub-token 不出现在任何日志/输出。`data_dir` 默认 `<DWEB_HOME>/hub-data`；init 检测 cwd 既有 `dweb-data/`（server.key/owners.jsonl）SHALL 提示接管（保留名册，不并行第二套）。家庭端口冻结：gateway 8787 / relay 3340（G-4；占用时自检失败并给 `--gateway/--relay` 指引）。`hub stop`/`status` MUST 校验 pid 存活性（pid+进程名核对），不盲杀复用 pid 的无关进程。

#### Scenario: 状态文件原子性与权限

- **WHEN** 审查 hub.json/hub-token/hub.pid 的创建路径
- **THEN** 三者均 0600、经临时文件+fsync+rename 落盘；写入失败无半提交残留

#### Scenario: 接管既有数据目录

- **WHEN** cwd 存在含 owners.jsonl 的 dweb-data/ 时执行 `opendweb hub init`
- **THEN** 提示接管该目录（名册保留），不创建第二套数据目录

### Requirement: 开机自启（hub autostart）

`opendweb hub autostart on` SHALL 安装**用户级**系统服务（不提权）：macOS=LaunchAgent plist（RunAtLoad+KeepAlive，Exec=`opendweb hub start --foreground`）；Linux=systemd user unit（Restart=on-failure）；Windows=启动文件夹脚本（无 KeepAlive，v1 接受）。生成物为纯文本可预览（`--print`）。`hub stop` 与自启联动：autostart on 时 stop MUST 先卸载服务再停进程（防 KeepAlive 拉回）；off 时仅停进程。测试 MUST 以生成物文本快照断言，MUST NOT 在测试中实际 load 系统服务。

#### Scenario: 自启后重启回来

- **WHEN** autostart on 后重启机器
- **THEN** 中枢进程自动恢复运行（KeepAlive/RunAtLoad 语义），无需人工干预

#### Scenario: stop 不被自启拉回

- **WHEN** autostart on 状态下执行 `opendweb hub stop`
- **THEN** 服务卸载+进程停止，重启前不再自动运行；`hub start` 恢复运行且 autostart 配置不被篡改

### Requirement: 接入信息卡片与短码（离线自解）

中枢地址传递 SHALL 提供接入卡片三形态同源（中枢名=本机机器名 [H6] 称呼层 / 地址 / 短码 / 二维码 / 三步引导；卡片 MUST NOT 携带邀请码或任何凭证——O-8 裁决）。短码编码冻结（G-5，两端同拍）：载荷 = `ver(1B: 0x01=IPv4/0x02=IPv6) || ip(4/16B) || port(2B BE) || crc16-ccitt(2B)`，编码 = crockford-base32 小写，呈现 = `dwebh1.` 前缀 + 4 字符分组；解码 MUST 离线自解（零在线依赖，[H1]）且校验前缀/版本/长度/CRC 四重，任一失败给明确错误。编解码实现单源（CLI util，webui workspace 复用同一文件）；CLI 终端二维码为自含 ASCII 实现（无新依赖），webui 为 SVG（同算法）。卡片数据源 = hub.json + 局域网地址（多网卡全列，卡片取首个并标注）。

#### Scenario: 短码往返

- **WHEN** 对任意 IPv4/IPv6+端口生成短码后离线解码
- **THEN** 还原出相同地址与端口；篡改任意一字符解码失败并报明确错误

#### Scenario: 卡片无凭证

- **WHEN** 审查 `opendweb hub card` 与 webui 卡片的全部输出
- **THEN** 含地址/短码/二维码/引导文案，不含 admin token、邀请码或回执材料
