# webui delta —— webui-plugin-kernel

## ADDED Requirements

### Requirement: WebUI 插件宿主与插件面板

webui SHALL 内置进程内插件宿主：独立于 CLI `./opendweb-plugin` 契约（apiVersion 1 零变化）的 WebUI 插件契约（新 export 子路径 `./opendweb-webui-plugin`，webuiApi 1：id/pages/routes/dataEndpoints/configSchema 字段集冻结）；内置插件（ports/files/sync）以 workspace 包静态注册，外部 npm 插件 v1 不做运行时加载。宿主生命周期状态机 MUST 为 registered→enabled⇄disabled，停用顺序 MUST 为先拒新请求（路由/页/数据端点摘牌）→在途流 drain（有界超时）→dispose（定时器/watcher/订阅/锁释放）→状态落盘。安装账本（`~/.opendweb/plugins.json`，CLI 包锁）与运行账本（`<DWEB_HOME>/plugins/state.json` 0600 原子写 + `<DWEB_HOME>/plugins/<id>/` 插件数据目录）MUST 分离；跨进程写沿用既有锁家族。信任模型=v1 可信插件（用户显式安装的包在宿主权限内执行，不宣称沙箱，文档明示）。控制面路由 `/sidecar/plugins*`（注册表/启停/配置）MUST 沿用 Host 守卫+写路由精确 Origin 纪律；浏览器新路径零凭证（argv/URL/持久化/日志零秘密）。UI 插件面 v1=MUST 类型化静态页面注册（复杂页=插件专属 Svelte 组件编入同一 bundle；通用 renderer 仅简单配置/表格页）；不做运行时远程 bundle/iframe/任意插件 JS 动态导入。**插件页路由接入协议（r2-B5）**：编译期静态 route registry，routeId 形如 `#/p/<pluginId>/<pageId>`（全局唯一、与既有路由空间隔离），App 分派命中且插件 enabled 才渲染；命中但 disabled/未知 routeId MUST 按既有未知 hash 收敛语义处理；导航落 SideNav「工具」区并按视角可见性过滤；既有路由行为零变化。**面板范围（r2-B6）**：v1 面板只管理编译内置三插件的启停/配置；marketplace 的 CLI 插件候选 MUST NOT 呈现为可安装/可启用的 WebUI 插件（CLI 插件是独立入口；CLI `opendweb plugin add` 安装的命令插件不产生可被 webui 启用的插件）；插件面板 MUST 含「即将推出」占位（vpn/clash/ai/ssh/screen，无实现仅展示 [W6]）与「外部 WebUI 插件=后续版本」标注；面板不触发 npm 安装（安装仅 CLI [W10]）。

#### Scenario: 插件启停生命周期（drain 与摘牌）

- **WHEN** 已启用的 files 插件有一在途分片上传，用户在面板点击「停用」
- **THEN** 新请求立即收到明确拒绝；在途流在有界超时（默认 10s 可配）内收敛或超时强制取消并给稳定错误响应；dispose 后路由/页/端点全部摘牌；重启后按落盘状态保持停用

#### Scenario: 插件页路由接入（可达/深链/停用收敛）

- **WHEN** 分别：启用状态下访问 `#/p/files/browser` 并整页刷新（深链）；停用 files 后再访问同一深链；访问未注册的 `#/p/unknown/page`；访问既有路由 `#/overview`
- **THEN** 深链刷新后页面可达且组件渲染；停用后深链按既有未知 hash 收敛（不残留死页/错误页）；未知插件路由同收敛；既有路由行为与基线完全一致

#### Scenario: 面板范围与安装语义（B6）

- **WHEN** 打开插件面板查看 marketplace 候选列表；或 CLI `opendweb plugin add` 安装一个 CLI 命令插件后刷新面板
- **THEN** 面板呈现内置三插件（ports/files/sync）的启停/配置与「即将推出」占位；CLI 插件候选不呈现为可安装/可启用的 WebUI 插件；CLI 安装的命令插件不出现在 webui 可启用列表

#### Scenario: 控制面授权与零凭证

- **WHEN** 对 `/sidecar/plugins/<id>/enable` 分别以 same-origin 浏览器、缺失 Origin 裸客户端、伪造 Origin 请求
- **THEN** 分别为 200/403/403；全部响应与日志不含 token/capability 之外的任何凭证；新插件面代码路径不含 argv 凭证读取

#### Scenario: 安装与运行双账本分离

- **WHEN** 内置插件停用后重启进程（对照：CLI 安装记录不变）
- **THEN** `plugins.json`（安装锁）不变，`plugins/state.json` 记录 disabled；两账本字段互不渗透

#### Scenario: 既有面零回归

- **WHEN** 插件宿主接入后运行既有 webui 全套测试（三视角/五行分流/接入卡片/数据面）
- **THEN** 全部通过；sidecar 既有路由（/api/*、/sidecar/*）行为不变
