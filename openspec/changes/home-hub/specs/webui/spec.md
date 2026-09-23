## ADDED Requirements

### Requirement: 三视角控制台（[H5]/[H7] 组 B 命名）

webui SHALL 升级为右上角身份切换器驱动的三视角控制台，命名冻结「我的中枢 / 我的租约 / 我的到访」：切换器为全局身份锚点（顶栏最右、当前视角名+下拉、各自徽章），**视角决定全局渲染**（导航/首屏/状态位整体切换，非叠加 Tab），一击切换无确认。既有四页（总览/租户管理/访客与门禁/在线连接）归入「我的中枢」视角且原样保留（server-access-roles 冻结面零回退）。「我的租约」=单页台账（首屏两问 3 秒答：剩几天/连得上吗；数据=本机 leases.json；空态三步加入指引，含「填地址或贴短码」——短码由 join 直收，见 cli/hub delta）。「我的到访」=单页 best-effort 台账（数据=本机 visits.json；探测为主动动作；页脚诚实声明常驻）。默认视角按数据自动选择（本机中枢在跑→中枢；有租约→租约；有到访→到访；全空→中枢引导态），此后记忆最近使用。三视角数据互不串扰：租约/到访视角 MUST NOT 出现 admin 概念。走查发现 F1/F2 吸收：列表轮询与在线面同拍（3s）；「按端点」区加「仅租户端点」说明性副标。在线连接呈现 MUST 区分「直连中/借道中」（SDK link_status 支撑；G-3 口径）。

#### Scenario: 一击切换与首问可达

- **WHEN** 从「我的中枢」切换到「我的租约」
- **THEN** 整页重渲为租约单页，3 秒内可见剩余天数与连通探测入口；无任何 admin 概念出现

#### Scenario: 直连/借道呈现

- **WHEN** 在线连接面同时存在直连与仅借道的会话
- **THEN** 两条会话分别标注「直连中」「借道中」，可区分

### Requirement: sidecar 模式分流（对 webui-console setup 条款的部分 supersedes）

本 change 对 webui-console 基线「无 `--server` 即启动 setup」作**部分 supersedes**，分流规则冻结：①显式 `--server`（±`--token`）→ ready(admin)，既有行为含节点簿不变；②无参 + 本机存在 leases/visits 数据 → **member 态（新）**：不进 setup、MUST NOT 生成或打印配对码、`/sidecar/connect` 与 nodes 面全部 403、`/admin/*` 全部 404 且**无上游出站**（含路径编码变体与未知子路径）；仅服务租约/到访数据面与静态 SPA；③无参 + 零本地数据 → setup（基线保留，首次配对入口不破坏）；④任何状态 + `--setup` → setup（member 态设备重新配对的显式通道）。[H4]「独立使用体感不变」按此表解释：零数据设备与显式 `--server` 的行为与基线逐一致。

#### Scenario: 成员设备不进 setup

- **WHEN** 无管理凭证、无 hub.json、有租约的设备以无参方式打开 webui
- **THEN** 直接落「我的租约」视角（member 态）；未生成配对码；`/sidecar/connect` 返回 403

#### Scenario: member 态 admin 面全封闭（负向矩阵）

- **WHEN** member 态下分别请求 `/admin/owners`、`/admin/status`、经 URL 编码变体与未知子路径的 `/admin/*`、跨源（伪造 Host/缺失 Origin）的 probe/label 写请求
- **THEN** `/admin/*` 全部 404 且无任何上游出站发生；跨源写请求全部 403；正常本机只读数据面可用

#### Scenario: 显式配对通道保留

- **WHEN** member 态设备执行 `opendweb webui --setup`
- **THEN** 进入 setup 配对流程（基线行为），配对成功后转入 ready(admin)

### Requirement: sidecar 本机数据面（租约/到访/中枢状态）

sidecar SHALL 新增仅本机回环的数据路由（全家族沿用 nodes 面的 Host/Origin 守卫）：`GET /sidecar/leases`（leases.json 投影，含 expires_in 计算）、`GET /sidecar/visits`、`POST /sidecar/visits/probe`（触发探测并按 leases delta 冻结的枚举映射落 last_probe）、`GET /sidecar/hub`（hub.json 投影；无 hub.json=404）、`PATCH /sidecar/leases/{server 归一化键}/label`（本地备注写面：body `{label: string|null}`，≤64 UTF-8 字节，走 leases delta 冻结的锁协议；跨源拒绝）。接入卡片卡（中枢视角·总览）与 CLI `hub card` 同源同文案（同一生成函数），二维码 SVG 与终端 ASCII 同算法；卡片不含凭证（实现默认，依 [H1] 精神，O-8 未显式拍板可回退）。

#### Scenario: label 行内编辑（并发安全）

- **WHEN** 在租约视角行内将某租约 label 改为「家里的 Mac」并同时另一进程完成一次 join 写入
- **THEN** 两个更新均持久（锁协议串行）；超长（>64 字节）输入被拒并提示

#### Scenario: 接入卡片三形态同源

- **WHEN** hub.json 的地址变更后在 CLI `hub card` 与 webui 总览卡片分别查看
- **THEN** 两处地址/短码/二维码一致（同一数据源与生成函数），均不含凭证

### Requirement: webui SDK 分层与进程内宿主（[H4]）

packages/webui SHALL 重分层为核心 SDK + 薄壳：core（sidecar 运行时/节点簿/租约与到访读取+锁写/探测/事件/QR 与短码算法复用/静态资源）与壳（cli.mjs/plugin.mjs）。分发体感不变：`startSidecar` 现签名零破坏、`opendweb webui` 插件形态不变、包零外部运行时依赖。新增进程内宿主入口 `createConsole(opts)`，返回契约冻结：`{ url（控制台地址）, open(deepLink?)（浏览器落点，深链如 #/lease——tray open-console 的 SDK 落点）, mode(), getSnapshot()（调用时刻同步快照，三视角数据一次取齐）, onEvent(type, fn)→unsubscribe disposer, switchTarget(id)（进程内直调）, close() }`。**事件 schema v1**：`{v:1, type:"state-change"|"node-switch"|"knock-pending"|"error", payload, ts}`；close 后事件静默、再订阅抛错。core MUST NOT 持有进程语义（信号/退出/开浏览器留壳层）；NodeStore/validateTarget 从 core 导出；新增手写 index.d.ts。既有 startSidecar/webui 测试面零回归。

#### Scenario: 进程内消费（tray 宿主形态）

- **WHEN** 宿主调用 createConsole、订阅 node-switch、发起 switchTarget 后 close
- **THEN** 恰收到一帧 `{v:1,type:"node-switch",...}` 事件；close 后不再有事件且再订阅得到明确错误；全程无浏览器打开/进程退出副作用

#### Scenario: open 深链落点

- **WHEN** 宿主调用 `open("#/lease")`
- **THEN** 浏览器打开的控制台直接落在租约视角路由

#### Scenario: startSidecar 零破坏

- **WHEN** 以 server-access-roles 时代的 startSidecar 调用参数运行既有测试面
- **THEN** 全部通过（签名与行为不变）
