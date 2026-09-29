# webui delta —— webui-plugin-kernel

## ADDED Requirements

### Requirement: WebUI 插件宿主与插件面板

webui SHALL 内置进程内插件宿主：独立于 CLI `./opendweb-plugin` 契约（apiVersion 1 零变化）的 WebUI 插件契约（新 export 子路径 `./opendweb-webui-plugin`，webuiApi 1：id/pages/routes/dataEndpoints/configSchema 字段集冻结）；内置插件（ports/files/sync）以 workspace 包静态注册，外部 npm 插件 v1 不做运行时加载。宿主生命周期状态机 MUST 为 registered→enabled⇄disabled，停用顺序 MUST 为先拒新请求（路由/页/数据端点摘牌）→在途流 drain（有界超时）→dispose（定时器/watcher/订阅/锁释放）→状态落盘。安装账本（`~/.opendweb/plugins.json`，CLI 包锁）与运行账本（`<DWEB_HOME>/plugins/state.json` 0600 原子写 + `<DWEB_HOME>/plugins/<id>/` 插件数据目录）MUST 分离；跨进程写沿用既有锁家族。信任模型=v1 可信插件（用户显式安装的包在宿主权限内执行，不宣称沙箱，文档明示）。控制面路由 `/sidecar/plugins*`（注册表/启停/配置）MUST 沿用 Host 守卫+写路由精确 Origin 纪律；浏览器新路径零凭证（argv/URL/持久化/日志零秘密）。UI 插件面 v1=MUST 类型化静态页面注册（复杂页=插件专属 Svelte 组件编入同一 bundle；通用 renderer 仅简单配置/表格页）；不做运行时远程 bundle/iframe/任意插件 JS 动态导入。插件面板 MUST 含「即将推出」占位（vpn/clash/ai/ssh/screen，无实现仅展示 [W6]）；面板不触发 npm 安装（安装仅 CLI [W10]）。

#### Scenario: 插件启停生命周期（drain 与摘牌）

- **WHEN** 已启用的 files 插件有一在途分片上传，用户在面板点击「停用」
- **THEN** 新请求立即收到明确拒绝；在途流在有界超时内收敛或取消；dispose 后路由/页/端点全部摘牌；重启后按落盘状态保持停用

#### Scenario: 控制面授权与零凭证

- **WHEN** 对 `/sidecar/plugins/<id>/enable` 分别以 same-origin 浏览器、缺失 Origin 裸客户端、伪造 Origin 请求
- **THEN** 分别为 200/403/403；全部响应与日志不含 token/capability 之外的任何凭证；新插件面代码路径不含 argv 凭证读取

#### Scenario: 安装与运行双账本分离

- **WHEN** CLI `opendweb plugin add` 安装插件包后，webui 面板停用该插件并重启进程
- **THEN** `plugins.json`（安装锁）不变，`plugins/state.json` 记录 disabled；两账本字段互不渗透

#### Scenario: 既有面零回归

- **WHEN** 插件宿主接入后运行既有 webui 全套测试（三视角/五行分流/接入卡片/数据面）
- **THEN** 全部通过；sidecar 既有路由（/api/*、/sidecar/*）行为不变
