## ADDED Requirements

### Requirement: 三视角控制台（[H5]/[H7] 组 B 命名）

webui SHALL 升级为右上角身份切换器驱动的三视角控制台，命名冻结「我的中枢 / 我的租约 / 我的到访」：切换器为全局身份锚点（顶栏最右、当前视角名+下拉、各自徽章），**视角决定全局渲染**（导航/首屏/状态位整体切换，非叠加 Tab），一击切换无确认。既有四页（总览/租户管理/访客与门禁/在线连接）归入「我的中枢」视角且原样保留（server-access-roles 冻结面零回退）。「我的租约」=单页台账（首屏两问 3 秒答：剩几天/连得上吗；数据=本机 leases.json；空态三步加入指引）。「我的到访」=单页 best-effort 台账（数据=本机 visits.json；探测为主动动作；页脚诚实声明常驻）。默认视角按数据自动选择（本机中枢在跑→中枢；有租约→租约；有到访→到访；全空→中枢引导态），此后记忆最近使用。三视角数据互不串扰：租约/到访视角 MUST NOT 出现 admin 概念（节点簿/健康灯/管理凭证字样）。走查发现 F1/F2 吸收：列表轮询与在线面同拍（3s）；「按端点」区加「仅租户端点」说明性副标。

#### Scenario: 一击切换与首问可达

- **WHEN** 从「我的中枢」切换到「我的租约」
- **THEN** 整页重渲为租约单页，3 秒内可见剩余天数与连通探测入口；无任何 admin 概念出现

#### Scenario: 成员设备不进 setup

- **WHEN** 无管理凭证、无 hub.json、有租约的设备打开 webui
- **THEN** 直接落「我的租约」视角（sidecar member 态），不进入 setup 世界

### Requirement: webui SDK 分层与进程内宿主（[H4]）

packages/webui SHALL 重分层为核心 SDK + 薄壳：core（sidecar 运行时/节点簿/租约与到访读取/探测/事件/QR 与短码算法复用/静态资源）与壳（cli.mjs/plugin.mjs）。分发体感不变：`startSidecar` 现签名零破坏、`opendweb webui` 插件形态不变、包零外部运行时依赖。新增进程内宿主入口 `createConsole(opts)`：返回 `{onEvent(类型化事件: state-change/node-switch/knock-pending/error), switchTarget(id)（进程内直调，不再 HTTP-only）, getSnapshot()（三视角数据一次取齐）, close()}`；core MUST NOT 持有进程语义（信号处理/退出/开浏览器留在壳层）；NodeStore/validateTarget 从 core 导出；新增手写 index.d.ts。既有 startSidecar/webui 测试面零回归。

#### Scenario: 进程内消费（tray 宿主形态）

- **WHEN** 宿主进程调用 createConsole 并订阅 node-switch 事件后发起 switchTarget
- **THEN** 恰收到一次类型化 node-switch 事件，快照同步更新，全程无浏览器打开/进程退出副作用

#### Scenario: startSidecar 零破坏

- **WHEN** 以 server-access-roles 时代的 startSidecar 调用参数运行既有测试面
- **THEN** 全部通过（签名与行为不变）

### Requirement: sidecar 本机数据面（租约/到访/中枢状态）

sidecar SHALL 新增仅本机回环的数据路由（沿用 nodes 面的 Host/Origin 守卫）：`GET /sidecar/leases`（leases.json 投影，含 expires_in）、`GET /sidecar/visits`、`POST /sidecar/visits/probe`（触发探测落 last_probe）、`GET /sidecar/hub`（hub.json 投影；无 hub.json=404）。member 态（无 target/token）下 /admin 代理面 MUST 404，仅服务租约/到访数据面与静态 SPA。接入卡片卡（中枢视角·总览）与 CLI `hub card` 同源同文案（同一生成函数），二维码 SVG 与终端 ASCII 同算法。

#### Scenario: member 态的凭证边界

- **WHEN** member 态 sidecar 收到 `/admin/owners` 代理请求
- **THEN** 404；`/sidecar/leases` 正常返回本机租约投影

#### Scenario: 接入卡片三形态同源

- **WHEN** 修改中枢地址后分别在 CLI `hub card` 与 webui 总览卡片查看
- **THEN** 两处地址/短码/二维码一致（同一数据源与生成函数）
