## ADDED Requirements

### Requirement: 托盘插件包（opendweb tray，[H2]）

托盘 SHALL 以 opendweb 插件包交付（npm `opendweb-tray`，`./opendweb-plugin` 子路径导出，marketplace glob 自适应派发；**不进 builtin 集合**；可选——未安装不影响核心功能，中枢全生命周期 CLI 直达）。v1 交付形态=**无头控制器**（图标壳本体归 opentray 消费本契约，proposal 非 Goal）：

1. **进程内消费 webui SDK**（[H4]）：`opendweb tray` 经 createConsole 拉起本机控制台（可深链），不另起浏览器进程树以外的 webui 实例；
2. **状态面**：`<DWEB_HOME>/tray-status.json` 心跳文件（mtime 级刷新）承载图标四态快照——优先级 异常>敲门角标 n>运行>未配置（PRODUCT-DESIGN §3.6 冻结表；异常=自启开但进程不在/进程失联），数据源=hub.json/hub.pid+hub-token 调 /admin/status（敲门/成员数，3s 轮询）+console 事件；stdout 同步 JSON lines 事件流；
3. **控制面**：`opendweb tray --ipc` stdio JSON-RPC（open-console/start/stop/set-autostart），动作落点到 hub 命令与 createConsole，MUST NOT 绕过 hub 状态文件的原子纪律。

托盘插件包 v1 零外部依赖（无头形态）；心跳文件遵守 DWEB_HOME 原子写先例。README SHALL 记录壳侧（opentray）对接契约：状态优先级表、菜单结构（PM §3.6 逐字）、点击落点深链规则。

#### Scenario: 无头运行与状态聚合

- **WHEN** 中枢运行且有 1 台设备待敲门时启动 `opendweb tray`
- **THEN** tray-status.json 快照=敲门角标 1（优先级高于运行态）；进程消失（Ctrl+C）后心跳文件停止刷新（壳侧可判失联）

#### Scenario: 可选性

- **WHEN** 未安装 opendweb-tray 插件
- **THEN** `opendweb hub` 全命令族行为完全不变（核心不依赖插件）
