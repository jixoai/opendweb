# webui Specification

## Purpose
定义 webui（本机 sidecar 控制台）的行为契约：节点管理台的信息架构与页面语义（三角色故事），叠加 home-hub 的三视角家庭控制台（中枢/租约/到访）、sidecar 本机数据面与 SDK 分层。admin 凭据只存在于本机 sidecar 进程，不进浏览器/URL/盘。

## Requirements

### Requirement: 三角色管理台信息架构

WebUI SHALL 以三角色心智模型（管理员/租户/访客）组织管理台，在 webui-console 冻结的 sidecar/token 边界/配对流程基座上演进。导航 SHALL 为：**总览**（四问：谁在线/有几个租户/有没有人敲门/邀请码状态 + 待办条）、**租户管理**（租户名册 + 别名 + 到期 + 续期 + 邀请码管理）、**访客与门禁**（敲门台 + 访客名册 + 黑名单）、**在线连接**（既有视图）。节点切换入口 SHALL 位于右上角节点信息区（见"节点簿与节点切换"），一次只呈现一个当前节点。术语：UI 呈现层 SHALL 使用「租户」指称 owner/fabric root、「访客」指称 visitor（术语映射在文档中单点定义；「包租婆」等比喻 MUST NOT 出现在操作文案中，仅限教育性引导文案）。**hash 路由冻结与收敛映射**：新路由 `#/overview`、`#/tenants`、`#/visitors`、`#/online`（邀请码为租户管理内子区块）；旧路由 MUST 301 式收敛（应用内重定向，不 404）：`#/owners`→`#/tenants`、`#/access`→`#/visitors`、`#/online`→`#/online`、`#/overview`→`#/overview`、其余未知 hash →`#/overview`。业务数据调用沿用基座 `/api/*` 同源代理（`/api/*` → `/admin/*`，不引入 `/sidecar/api/*`）。

#### Scenario: 旧路由收敛

- **WHEN** 访问 webui-console 时代的旧 hash 路由（如 #/owners）
- **THEN** 重定向到新 IA 对应页（租户管理），不出现 404 或空白

#### Scenario: 总览四问一次可读

- **WHEN** 管理员打开总览页且服务端各计数非零
- **THEN** 同屏呈现：在线连接数（含访客在线）、租户数（active）、待处理敲门数、可用邀请码数；待处理敲门 >0 时有待办引导条直达敲门台

#### Scenario: 敲门待办的导航入口

- **WHEN** 存在未处置敲门
- **THEN** 「访客与门禁」导航项呈现计数徽标，点击进入敲门台

### Requirement: 敲门台（待办处置）

WebUI SHALL 提供敲门台页：列表呈现聚合敲门（谁（key 缩写/别名）/次数/首次/最近/原因），未处置在前、组内按 seq 降序（最近敲门者在前——排序以服务端 seq 为准，时钟回拨免疫）；每行提供四个动作，成品文案采用 PRODUCT-DESIGN §4 冻结稿：**定位访客**（预填 endpoint_id 的访客授权表单 + 确认）、**导入租户**（租户注册表单——敲门记录无 fabric 归属，表单 MUST 提示「敲门记录只有敲门人的钥匙，没有房间号：请用邀请码让 TA 自助注册，或手工输入 fabric_id+root」）、**拉黑**（二次确认后加入黑名单）、**忽略**（dismiss + 带「撤销」入口的 toast）。列表数据经业务代理面 `/api/*`（→ `/admin/knocks`）获取；四个动作分别调用对应 `/api/*` 路由，失败走既有六类错误态渲染（业务请求一律走 `/api/*`；`/sidecar/*` 仅为本地控制面——r2-P1-2 路径契约）。

#### Scenario: 一键定位访客全链路

- **WHEN** 管理员在某敲门行点「定位访客」，确认表单（endpoint_id 已预填、可补别名）
- **THEN** 调用访客授权成功后该敲门从待办消失（或标记已处置），敲门者重连 relay 即放行

#### Scenario: 导入租户的引导而非阻断

- **WHEN** 管理员点「导入租户」
- **THEN** 表单呈现引导文案（邀请码通道或手工输入二元组），不因敲门记录无 fabric 而阻断流程

#### Scenario: 忽略的撤销路径

- **WHEN** 点「忽略」后 toast 呈现，管理员在 toast 存续期内点「撤销」
- **THEN** 该敲门恢复未处置状态（dismiss 幂等语义下撤销等价再次进入待办视图）

### Requirement: key 显示规范（别名 + 防钓鱼缩写）

WebUI 全站 SHALL 统一 key 呈现为 `别名 (abc***xyz)`：缩写规则为 hex 的**首 3 字符 + `***` + 尾 3 字符**（区块链钱包式）；无别名时仅缩写。缩写元素 MUST 提供 title 提示全文与复制全文入口（复制的是完整 64 hex，不是缩写）。本规则**取代** webui-console 时代的首 8 位缩写规则（跨 change 规范更替，webui-console 归档时注明被本规范取代）。缩写 MUST 出现在一切列举 key 的位置（敲门台/访客名册/租户名册/在线连接/邀请码 alias_hint 提示）。

#### Scenario: 有别名与无别名的呈现

- **WHEN** 列表中同时存在带别名租户与无别名端点
- **THEN** 前者呈现 `别名 (abc***xyz)`，后者呈现 `(abc***xyz)`；两者的复制入口均复制完整 64 hex

#### Scenario: 复制不含缩写混淆

- **WHEN** 管理员复制任一 key 缩写元素
- **THEN** 粘贴结果为完整 64 hex（可用于 admin 路由的路径参数）

### Requirement: 邀请码管理页

WebUI SHALL 在租户管理内提供邀请码管理：签发表单（备注 alias_hint 可选、次数默认 1、有效期默认 7 天、注册后默认有效期默认 30 天——均可改）；签发成功 MUST 以**仅此一次**的醒目视图呈现码全文（`dwebc1.` 前缀、4-4-4-4 分组）+ 复制按钮 + 「关闭后无法再次查看」警示；列表只呈现哈希缩写/计数（used/max）/状态（可用/耗尽/过期/已吊销）/到期；吊销为二次确认动作。列表与动作经业务代理面 `/api/*` 调用对应 admin 路由。

#### Scenario: 码全文仅签发时可见

- **WHEN** 签发成功后管理员离开签发结果视图再回列表
- **THEN** 列表与一切后续界面只呈现哈希缩写，无任何途径再次取回码全文

#### Scenario: 吊销的二次确认

- **WHEN** 管理员对可用码点「吊销」
- **THEN** 呈现二次确认（说明兑换将立即失效），确认后列表状态更新为已吊销

### Requirement: 节点簿与节点切换

sidecar SHALL 维护本地节点簿存储（`~/.opendweb/nodes.json`，权限 0600）：条目 `{id, name, server_host, token, added_at}`；节点列表/状态响应只含 `{id, name, server_host, added_at, current}`，**token MUST NOT 出现在任何 HTTP 响应、日志或浏览器可达状态中**。

**对 webui-console 基座契约的版本化例外（有意变更，非疏漏；supersedes 关系冻结）**：基座冻结「token MUST NOT 写入任何文件」与「目标一经设定即冻结（重新指向=重启）」——本 requirement 为**节点簿场景引入两条明示例外**，**优先级规则**：server-access-roles 归档后，webui capability 基线中与下述两条例外冲突的条款**按本 change 的增补修订生效**（spec 同步时 MUST 将例外写为基线正式条款并附「由 server-access-roles 引入」标注，非可选括注）；在 webui-console 与本 change 均未归档的实现窗口内，以本 requirement 为准（后 change 覆盖前 change 的同面条款）。同步义务（tasks Phase 2b 验收项）：归档时任一 change 时 MUST 在 specs/webui 基线落增补 + 负向测试清单（仅 nodes.json 允许落盘、仅 node_id switch 允许重指向，其余路径仍 target-frozen/token-frozen）：(1) **落盘例外**——节点 token 允许持久化于 0600 的 `nodes.json`（威胁模型：单用户工作站、用户主目录私有；文件创建走临时文件+原子 rename，拒绝 symlink 跟随；nodes.json 与 hub-token 同级私密面——0600 本机文件，帮助文本明示持久化位置与读写边界；W11 后 argv/env 凭证通道已移除，0600 文件是节点 token 的唯一持久化形态）。跨用户主机/共享环境部署文档 MUST 明示不适用；(2) **切换例外**——`POST /sidecar/nodes/switch {node_id}`（本地控制面 `/sidecar/*`）为**唯一被许可的运行时重指向通道**：MUST 仅接受已存储节点的 node_id（任何 URL/host 字段一律 400——目标冻结安全模型保持，无"新目标注入"通道；Host/Origin 校验与配对面一致，无需配对码——无新秘密输入）。切换为进程内原子替换 target+token（无需重启 sidecar）；在途代理请求 MUST 以请求开始时的 target 快照完成（切换不撕裂在途请求）。除此之外基座 target-frozen 拒绝语义不变。节点添加经既有配对面流程（每次新配对码；validateTarget 全量校验与并发一次性消费语义不变）。删除 `DELETE /sidecar/nodes/{id}`；当前连接节点不可删除（409，先切走）。**路径命名冻结**：业务代理面沿用基座 `/api/*` → `/admin/*`（canonical，不引入 `/sidecar/api/*`）；节点簿属本地控制面 `/sidecar/nodes*`。UI：右上角节点信息区提供节点切换菜单（一次一个当前节点，无同屏多节点），切换为进程内即时切换（无进程重启），过渡态呈现「正在切换到 <节点名>…」。

#### Scenario: 切换仅限已存储节点

- **WHEN** `POST /sidecar/nodes/switch` body 为 `{node_id}` 之外的任何形态（含直接给 URL/host）
- **THEN** 返回 400，不发生任何出站连接；仅已存储 node_id 被接受

#### Scenario: 切换后代理面即刻指向新节点（无重启）

- **WHEN** 切换到节点 B 成功后，浏览器立即请求 `/api/status`
- **THEN** 请求被代理到节点 B 的 `/admin/status`（响应反映 B 的状态；sidecar 进程未重启，本地端口持续可用）

#### Scenario: 在途请求不被切换撕裂

- **WHEN** 切换发生时有对节点 A 的 `/api/connections` 请求在途
- **THEN** 该请求以切换前的 target 快照完成（响应来自 A 或明确失败，不出现半 A 半 B 的混合）

#### Scenario: token 永不出浏览器

- **WHEN** 调用节点列表/切换/删除任一接口并审查响应与 sidecar 日志
- **THEN** 任何位置不含任何节点 token 明文

#### Scenario: 当前节点不可删除

- **WHEN** `DELETE /sidecar/nodes/{当前节点 id}`
- **THEN** 返回 409 错误 envelope；先切换到其他节点后方可删除

### Requirement: 三视角控制台（[H5]/[H7] 组 B 命名）

webui SHALL 升级为右上角身份切换器驱动的三视角控制台，命名冻结「我的中枢 / 我的租约 / 我的到访」：切换器为全局身份锚点（顶栏最右、当前视角名+下拉、各自徽章），**视角决定全局渲染**（导航/首屏/状态位整体切换，非叠加 Tab），一击切换无确认。既有四页归入「我的中枢」视角且原样保留（server-access-roles 冻结面零回退）。「我的租约」=单页台账（首屏两问 3 秒答：剩几天/连得上吗；数据=本机 leases.json；**倒计时为本地快照语义**——见 cli/leases delta；空态三步加入指引含「填地址或贴短码」）。「我的到访」=单页 best-effort 台账（数据=本机 visits.json；探测为主动动作；页脚诚实声明常驻）。默认视角按数据自动选择（本机 hub.json 存在→中枢；有租约→租约；有到访→到访；全空→中枢引导态），此后记忆最近使用。三视角数据互不串扰：租约/到访视角 MUST NOT 出现 admin 概念。F1/F2 吸收：列表轮询与在线面同拍（3s）；「按端点」区加「仅租户端点」副标。在线连接呈现 MUST 区分「直连中/借道中」（SDK link_status 支撑；G-3 口径）。

#### Scenario: 一击切换与首问可达 / 直连与借道可区分

- **WHEN** 从「我的中枢」切换到「我的租约」/ 在线面同时存在直连与仅借道会话
- **THEN** 整页重渲为租约单页，3 秒内可见剩余天数与探测入口，无 admin 概念 / 两条会话分别标注「直连中」「借道中」

### Requirement: sidecar 模式分流（对 webui-console setup 条款的部分 supersedes）

本 change 对 webui-console 基线「无 `--server` 即启动 setup」作**部分 supersedes**，分流规则冻结（五行）：①显式 `--server` → ready(admin)，既有行为含节点簿不变（W11：`--token`/`DWEB_ADMIN_TOKEN` argv/env 通道已移除——token 经终端隐藏输入获取，非 TTY 环境报迁移错误并指回节点簿/浏览器配对面）；②无参 + 本机 hub.json 存在 → **ready(admin)（hub 本机自动）**：sidecar 进程内读 hub-token 连本机中枢（`opendweb hub open` 即此形态的命令封装；服务未跑=中枢视角+中枢状态卡）；hub-token MUST NOT 入 argv/URL/浏览器状态；③无参 + 无 hub.json + 存在 leases/visits 数据 → **member 态**：不进 setup、MUST NOT 生成或打印配对码、`/sidecar/connect` 与 nodes 面全部 403、`/admin/*` 全部 404 且无上游出站（含路径编码变体与未知子路径）；仅服务租约/到访数据面与静态 SPA；④无参 + 零本地数据 → setup（基线保留，首次配对入口不破坏）；⑤任何状态 + `--setup` → setup（member 态设备重新配对的显式通道）。[H4]「独立使用体感不变」按此表解释：零数据设备与显式 `--server` 的行为与基线逐一致。

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

### Requirement: sidecar fabric 宿主数据面 direct-only（[W12]）

sidecar 的 fabric 宿主（数据面底座）SHALL 以 direct-only 数据面运行：构造 Fabric 时不携带 relay 配置（SDK 缺省 disabled）——**hub 租约的 relay URL MUST NOT 装配进数据面**（HTTP-only hub relay 只能承载注册/租约/rendezvous 管理面，不能转发端点间 QUIC 数据；配进数据面即 relay-first 吞没停滞，真双机三轮实录定论）。对端发现 = invite 令牌携带的 advertiseAddrs 直连地址 + 持久 known_addrs。root 五步时序中的 ②ensureRelayCapabilities+③覆盖断言 SHALL 仅在**显式 relay 数据面模式**（宿主 `relay` 选项在场——QUIC/TLS relay 形态，当前无消费方，server 补齐后由独立 change 开放）且 root 姿态时执行；direct-only（缺省）与 member 姿态一律跳过。租约 SHALL 仍是身份元组来源（fabricId/endpointId/deviceName 派生不变），但 `relay_url` 不可用 MUST NOT 阻断数据面 start——no-lease 门只看租约存在（无任何租约 = 无身份元组 = 明示 no-lease 稳定错误），已有 roster+known_addrs 的设备照常进 direct-only 数据面。

#### Scenario: 缺省 direct-only（租约 relay 不进数据面）

- **WHEN** 有租约的设备启用任一数据面插件触发 fabric 惰性启动
- **THEN** Fabric 构造不携带 relay 选项；relay 覆盖 ensure/断言被跳过（root 与 member 同）；start 正常完成，identity() 的 relays 投影仅供管理面观测

#### Scenario: 无可用 relay 的租约不阻断启动（no-lease 边界）

- **WHEN** 租约存在但 relay_url/server_id 为空，设备已有 roster 与 known_addrs
- **THEN** startSequence 不因 relay 字段缺失报 no-lease；direct-only 数据面正常启动（identity 元组照常派生，relays 投影为空数组）

#### Scenario: 显式 relay 数据面 opt-in 仍走 root ②③

- **WHEN** 宿主以显式 `relay` 选项（QUIC/TLS 形态）构造且姿态为 root
- **THEN** ensureRelayCapabilities+覆盖断言照常执行，覆盖缺口 fail-closed 不 start
