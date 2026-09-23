## ADDED Requirements

### Requirement: 三视角控制台（[H5]/[H7] 组 B 命名）

webui SHALL 升级为右上角身份切换器驱动的三视角控制台，命名冻结「我的中枢 / 我的租约 / 我的到访」：切换器为全局身份锚点（顶栏最右、当前视角名+下拉、各自徽章），**视角决定全局渲染**（导航/首屏/状态位整体切换，非叠加 Tab），一击切换无确认。既有四页归入「我的中枢」视角且原样保留（server-access-roles 冻结面零回退）。「我的租约」=单页台账（首屏两问 3 秒答：剩几天/连得上吗；数据=本机 leases.json；**倒计时为本地快照语义**——见 cli/leases delta；空态三步加入指引含「填地址或贴短码」）。「我的到访」=单页 best-effort 台账（数据=本机 visits.json；探测为主动动作；页脚诚实声明常驻）。默认视角按数据自动选择（本机 hub.json 存在→中枢；有租约→租约；有到访→到访；全空→中枢引导态），此后记忆最近使用。三视角数据互不串扰：租约/到访视角 MUST NOT 出现 admin 概念。F1/F2 吸收：列表轮询与在线面同拍（3s）；「按端点」区加「仅租户端点」副标。在线连接呈现 MUST 区分「直连中/借道中」（SDK link_status 支撑；G-3 口径）。

#### Scenario: 一击切换与首问可达 / 直连与借道可区分

- **WHEN** 从「我的中枢」切换到「我的租约」/ 在线面同时存在直连与仅借道会话
- **THEN** 整页重渲为租约单页，3 秒内可见剩余天数与探测入口，无 admin 概念 / 两条会话分别标注「直连中」「借道中」

### Requirement: sidecar 模式分流（对 webui-console setup 条款的部分 supersedes）

本 change 对 webui-console 基线「无 `--server` 即启动 setup」作**部分 supersedes**，分流规则冻结（五行）：①显式 `--server`（±`--token`）→ ready(admin)，既有行为含节点簿不变；②无参 + 本机 hub.json 存在 → **ready(admin)（hub 本机自动）**：sidecar 进程内读 hub-token 连本机中枢（`opendweb hub open` 即此形态的命令封装；服务未跑=中枢视角+中枢状态卡）；hub-token MUST NOT 入 argv/URL/浏览器状态；③无参 + 无 hub.json + 存在 leases/visits 数据 → **member 态**：不进 setup、MUST NOT 生成或打印配对码、`/sidecar/connect` 与 nodes 面全部 403、`/admin/*` 全部 404 且无上游出站（含路径编码变体与未知子路径）；仅服务租约/到访数据面与静态 SPA；④无参 + 零本地数据 → setup（基线保留，首次配对入口不破坏）；⑤任何状态 + `--setup` → setup（member 态设备重新配对的显式通道）。[H4]「独立使用体感不变」按此表解释：零数据设备与显式 `--server` 的行为与基线逐一致。

#### Scenario: 中枢本机无文档可达

- **WHEN** hub init 完成（尚无任何租约/到访数据）的机器上无参打开 webui 或执行 `opendweb hub open`
- **THEN** 落「我的中枢」视角（admin 态）；不进 setup；hub-token 不出现在浏览器任何可见状态

#### Scenario: 成员设备不进 setup / member 态 admin 面全封闭（负向矩阵）

- **WHEN** 无 hub.json、有租约的设备无参打开 webui，随后请求 `/admin/owners`、`/admin/status`、编码变体与未知子路径的 `/admin/*`、`/sidecar/connect`、伪造 Origin/坏 Host 的写请求
- **THEN** 落「我的租约」（member 态）、未生成配对码、connect 403；`/admin/*` 全 404 且无任何上游出站；伪造写请求全 403

#### Scenario: 显式配对通道保留

- **WHEN** member 态设备执行 `opendweb webui --setup`
- **THEN** 进入 setup 配对流程（基线行为），配对成功后转入 ready(admin)

### Requirement: sidecar 本机数据面（租约/到访/中枢状态）

sidecar SHALL 新增仅本机回环的数据路由：`GET /sidecar/leases`（投影含 expires_in）、`GET /sidecar/visits`、`POST /sidecar/visits/probe`（按 leases delta 冻结的五类映射落 last_probe；**写面仅 member 姿态可用——到访簿仅成员侧写入，admin/默认/hub-local 姿态一律 403（含 same-origin 合法写形态），授权守卫先于 Origin/入参守卫**）、`GET /sidecar/hub`（hub.json 投影；无 hub.json=404）、`PATCH /sidecar/leases/{id}/label`（**id=条目不透明键**；body `{label: string|null}`，≤64 UTF-8 字节，**空串归一为 null=清除**；未知 id=404；走 leases delta 锁协议）。**Host 守卫沿用基线；写路由（probe/label）Origin 策略严于基线**：MUST 要求 Origin 存在且匹配（基线 guard 的缺失 Origin 放行仅适用旧读/配对面，新写路由不沿用）；四类状态冻结：same-origin→200、缺失 Origin→403、不匹配/伪造 Origin→403、坏 Host→403。接入卡片卡（中枢视角·总览）与 CLI `hub card` 同源同文案（同一生成函数），二维码 SVG 与终端 ASCII 同算法；卡片不含凭证（实现默认，依 [H1] 精神，O-8 未显式拍板可回退）。

#### Scenario: label 行内编辑（id 路由+并发+归一）

- **WHEN** 在租约视角行内将某租约 label 改为「家里的 Mac」、提交空串、以未知 id 请求，同时另一进程完成一次 join 写入
- **THEN** 改名持久（id 路由命中）；空串=清除（label 归一 null）；未知 id=404；并发写经锁协议串行两更新俱在；超长（>64 字节）被拒

#### Scenario: 写路由 Origin 四类

- **WHEN** 对 probe/label 分别以 same-origin 浏览器请求、无 Origin 的裸 HTTP 客户端、伪造 Origin、坏 Host 请求（probe 在 member 姿态）
- **THEN** 依次 200 / 403 / 403 / 403；读路由（GET leases/visits/hub）行为不受影响（沿用基线 Host 守卫）

#### Scenario: 到访探测仅成员视角（负向矩阵）

- **WHEN** admin/默认/hub-local 姿态的 sidecar 收到 `POST /sidecar/visits/probe`（含 same-origin 合法写形态）
- **THEN** 一律 403（`forbidden`——到访簿仅成员侧写入）；member 姿态按写路由 Origin 四类照常服务

#### Scenario: 接入卡片三形态同源

- **WHEN** hub.json 的地址变更后在 CLI `hub card` 与 webui 总览卡片分别查看
- **THEN** 两处地址/短码/二维码一致（同一数据源与生成函数），均不含凭证

### Requirement: webui SDK 分层与进程内宿主（[H4]）

packages/webui SHALL 重分层为核心 SDK + 薄壳：core（sidecar 运行时/节点簿/租约与到访读取+锁写/探测/事件/QR 与短码算法/静态资源）与壳（cli.mjs/plugin.mjs——信号/退出/开浏览器留壳层）。分发体感不变：`startSidecar` 现签名零破坏、`opendweb webui` 插件形态不变、包零外部运行时依赖。新增 `createConsole(opts)`，返回契约冻结：`{ urlFor(deepLink?)→string（**纯函数**：core 只生成 URL）、open(deepLink?)（**宿主注入回调**：opts.opener 必填，core 不自带浏览器 spawn——CLI 壳注入既有 openImpl、tray 注入自身壳行为）、mode()、getSnapshot()（调用时刻同步快照）、onEvent(type, fn)→unsubscribe disposer、switchTarget(id)（进程内直调）、close() }`。`urlFor` 返回的 URL 可含 sidecar **会话 capability v1**：≥128-bit CSPRNG、绑定 sidecar 实例（跨实例无效）、**单次消费**（重放=403+记录）、TTL 默认 120s、close/进程退出立即失效；属一次性会话凭证（基线 pairingCode 族的强化），**非 hub-token/admin token**——后者 MUST NOT 入 URL/浏览器可见状态/IPC；URL query 不落访问日志、SPA 施加 `no-referrer`；重放/过期/跨实例/close 后使用=明确 403。**事件 schema v1**：`{v:1, type:"state-change"|"node-switch"|"knock-pending"|"error", payload, ts}`；close 后事件静默、再订阅抛错。NodeStore/validateTarget 从 core 导出；手写 index.d.ts。既有测试面零回归。

#### Scenario: 进程内消费（注入 opener）

- **WHEN** 宿主以 `opts.opener` 注入自定义打开行为后 createConsole、订阅 node-switch、switchTarget、close
- **THEN** 恰一帧 `{v:1,type:"node-switch",...}`；core 未自行 spawn 浏览器（打开行为只经注入回调发生）；close 后事件静默、再订阅明确报错

#### Scenario: 深链落点与口令边界

- **WHEN** 宿主调用 `open("#/lease")` 并审查 URL 构成
- **THEN** 浏览器落租约视角路由；URL 至多含一次性会话 capability，绝无 hub-token/admin token

#### Scenario: startSidecar 零破坏

- **WHEN** 以 server-access-roles 时代的 startSidecar 调用参数运行既有测试面
- **THEN** 全部通过（签名与行为不变）
