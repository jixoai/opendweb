# home-hub 设计层评审 r1

评审基点：`HEAD fc464accfc53d87da692bcccbe37af11d56b2acd`（2026-09-23 worktree）
评审范围：实现前设计与 OpenSpec delta；只读。
结论：**NOT-READY，6.2/10**。不建议进入实现。当前设计覆盖面广，且 [H7] 三项裁决、`registered_at` 首次注册语义、[H6] 别名分层均有明确落点；但平台支持、sidecar 模式迁移、状态写入并发、短码 wire format、自启实际执行模型、tray 宿主契约和 G-3 验收仍有阻断级缺口。严格校验通过只证明 OpenSpec 结构有效，不能消除这些语义缺口。

## 1. 结论与评分

| 维度 | 评分 | 判断 |
|---|---:|---|
| Owner 裁决覆盖 | 7.0 | [H0]-[H7] 均有设计映射；[H0]/[H3]/G-3 的核心停机承诺没有落入 delta 的可执行验收场景。 |
| 基线契约与 supersedes | 5.5 | server-access-roles 的续期与首次注册时刻被正确继承；member/setup 变化与基线 webui 默认配对契约冲突，未声明覆盖/迁移规则。 |
| 三方一致性 | 6.0 | 主命令、命名与多租约模型基本一致；short-code 长度、visits 结果枚举、托盘未配置态和本地备注写路径存在缺口/漂移。 |
| 技术可实现性 | 5.5 | 真实平台基线与 Linux 自启不兼容；detached 启动、system service、状态文件并发及 SDK-to-tray 操作面尚未闭合。 |
| Spec 可测性 | 6.0 | 有较多 Scenario，但关键生命周期边界缺失，部分 Scenario 是“审查输出/任意输入”而非可复现的行为断言。 |

**判定依据**：至少 8 项 P1 需要在实现前改动 spec/design 或明确 Owner 决策，其中包括实现会改变既有 WebUI 默认行为，以及现有交付平台根本不能运行 Linux CLI 两个直接冲突。P0：无。P1 未关闭前，不应以“实现期再细化”推进。

## 2. 验证证据

### 实际阅读

- 按要求顺序读取 `openspec/changes/home-hub/requirements.md`、`proposal.md`、`PRODUCT-DESIGN.md`、`design.md`，以及全部四份 delta：`specs/cli/hub/spec.md`、`specs/cli/leases/spec.md`、`specs/webui/spec.md`、`specs/packaging/tray-plugin/spec.md`。
- 读取 server-access-roles 的 `requirements.md`、`design.md`、server/webui specs；核对 `ced9215` 与 `26df800` 对续期顺延和 `registered_at=首次注册时刻` 的修改，以及 HEAD 中包含的 [H6] `2dacb56`。
- 核对事实代码：`packages/opendweb/bin/opendweb.mjs`、`src/plugin-resolve.mjs`、`src/plugin-runtime.mjs`、`src/join.mjs`；`packages/webui/src/cli.mjs`、`sidecar.mjs`、`nodes.mjs`、`plugin.mjs` 与 `package.json`；`packages/server-binary/index.js` 与 `package.json`；`crates/dweb-fabric/src/fabric.rs`、`crates/dweb-fabric/tests/relay_failover.rs`、`Cargo.lock`。
- G-3 源码抽查了本机 Cargo registry 中锁定版本 iroh 1.1.0 的 `src/socket.rs`、`src/socket/remote_map/remote_state.rs`、`src/endpoint/presets.rs`，并将其与 `dweb-fabric` 的实际 endpoint 构造和现有 relay 故障测试对照。

### 实际命令

- `git rev-parse HEAD`：`fc464accfc53d87da692bcccbe37af11d56b2acd`。
- `git status --short --branch`：评审前 worktree 干净，分支 `sdk-mgmt-surface`。
- `git log -5 --oneline --decorate`：确认 HEAD 为 home-hub 技术设计 v1；前序包含 H7 收敛及基线 `ced9215`/`26df800`。
- `openspec validate home-hub --strict`：通过，输出 `Change 'home-hub' is valid`。
- `node packages/opendweb/bin/opendweb.mjs --help`：确认现有命令表没有 `hub`，join 仍写单条 `registration.json`；这作为 HEAD 基线事实，不是实现缺项结论。
- `git diff --check`：通过；评审期间未运行包测试或 Rust 测试，也未操作 launchd/systemd/Windows 服务实例。

### 关键事实核验

- CLI 入口只接受 `darwin-arm64`、`win32-x64`（`packages/opendweb/bin/opendweb.mjs:34-41`）；随包 server binary 也只有这两种文件（`packages/server-binary/index.js:11-20`、`packages/server-binary/package.json`）。
- 现有 `opendweb server` 会加载插件并运行 `server.preStart`、`postReady`、`preStop`（`packages/opendweb/bin/opendweb.mjs:482-519,541-583`）；server-binary 的二进制路径及 env 构造目前封装在 `startServer` 内（`packages/server-binary/index.js:61-135`）。
- 现有 `opendweb-webui` 无 `--server` 明确进入 setup、打印配对码并允许 `/sidecar/connect` 配对（`packages/webui/src/cli.mjs:40-47,163-180`；基线 `openspec/changes/webui-console/specs/webui/spec.md:7,89-92`）。本地控制面已有 Host/Origin guard，但路由覆盖有明确分派（`packages/webui/src/sidecar.mjs:520-555`）。
- `dweb-fabric` 默认 `RelayConfig::N0Default`（`fabric.rs:268`），并构造 `Endpoint::builder(presets::N0)`（`fabric.rs:1874`）；iroh N0 preset 会配置 Pkarr Publisher/Resolver 和 DNS AddressLookup（registry `endpoint/presets.rs:95-138`）。现有 `relay_failover.rs` 的 relay recovery 用例以 `RelayConfig::Custom` 建 Fabric，且通过 provider 主动断开会话模拟死亡（`relay_failover.rs:193-201,243-257`）。

## 3. 问题清单

### P1

#### HH-P1-1：Linux 自启契约超出现有 CLI 与 server-binary 支持边界

`design.md:80-82` 和 `specs/cli/hub/spec.md:38-43` 把 Linux systemd user unit 列为本期三平台交付，但现有 CLI 在模块初始化时即拒绝 Linux，server-binary 也没有 Linux 目标。即使 unit 文件可生成，服务命令无法运行。这不是只缺 systemd 文本快照，而是宿主功能目前不存在。

**可验证修复**：二选一并同步 requirements/proposal/design/spec：① 保留 Linux 承诺，先把 Linux binary/CLI packaging 纳入同 change 范围，补 Linux 安装包与隔离用户级 service 实测；② 把本期平台明确限定为当前已支持的两平台，并把 Linux 自启移到后续 change。验收至少证明所列每个平台的 CLI 可执行并能启动 server binary。

#### HH-P1-2：member 态重定义了 no-target setup，却没有基线 supersedes 或保留配对入口

`design.md:170-172` 与 `specs/webui/spec.md:14-15,33` 要求无 target/token 进入 member，不进入 setup。基线 webui 契约明确无 `--server` 就启动 setup 配对；[H4] 又要求独立 webui 用户体感不变。当前 design 没写由哪种输入区分“成员只读控制台”与“用户要配对远端 server”，也没有说明 `/sidecar/connect`、一次性配对码和既有 `opendweb webui` 入口如何继续工作。若直接按 `target/token` 推断 mode，会覆盖旧路径。

**可验证修复**：在 webui delta 明写对 `webui-console` setup 条款的 supersedes 范围及保留入口（例如显式 setup/member 模式或按本地状态的确定性分流），钉住无参数旧调用、已有租约 member 调用、无任何本地数据调用三种行为；member mode 必须负向断言不生成/打印配对码、不接受 `/sidecar/connect` 改写 target，也不暴露 admin 代理。同步 [H4] 的“体感不变”解释。

#### HH-P1-3：默认 detached 路径静默绕过 server 插件生命周期

`design.md:65-74` 把默认 `hub start` 定为直启 server-binary，只有 `--foreground` 使用 `runServer` 全链。源代码中插件 preStart 可覆写受限 server 配置白名单，postReady 可提供诊断横幅，preStop 可清理外部服务；直接启动会全部略过。设计没有声明这是对现有 server 插件行为的有意 supersedes，也没有规定已声明插件时的提示。常开服务的用户可能依赖 tunnel、绑定覆写或退出清理，默认路径会静默变行为。

**可验证修复**：明确选择并写入 spec：让 detached 与 foreground 执行相同插件生命周期（守护 wrapper/受控控制进程），或明确 hub 完全不读取 server 插件配置、拒绝含相关配置的启动并给可验证提示。补有/无 preStart、postReady、preStop 插件的默认 start/stop 场景，断言 side effect 与错误处理一致；仅写“foreground 含钩子”不足以关闭此项。

#### HH-P1-4：三平台 Exec 路径、Windows 启动项路径和 service-child 语义没有可运行定义

`design.md:80-87` 使用裸 `opendweb` Exec；systemd `ExecStart` 需要可执行文件路径而不是依赖交互 shell 的 PATH。Windows 的 `shell:startup/opendweb-hub.cmd` 是 shell namespace 名称，不是可直接交给文件 API 的目录路径。Windows 启动脚本调用 `opendweb hub start`，但同节又规定 autostart-on 时人工 `hub start` 是“load 服务”，没有区分启动项回调和人工调用。另 `hub.pid` 被定义成 detached pid，而 LaunchAgent/systemd 运行 `--foreground`；没有说明该服务进程是否写 pid、由谁 stop、manager 停止与 SIGINT→5s→SIGKILL 如何一致。

**可验证修复**：冻结每个平台的绝对 executable/Node/CLI 路径、工作目录、`DWEB_HOME`、环境继承与 quoting；Windows 用真实 Startup Known Folder 路径；区分人工命令与 service child（避免回调再走 load-service 分支）。规定 manager 是 foreground 进程唯一 owner 还是 pidfile owner，统一 stop/异常退出/pid 清理。用生成物快照加隔离账户下安装→登录触发→stop 不复活→start 恢复→off 卸载验证。

#### HH-P1-5：short-code 当前既非确定 wire format，产品样例也与载荷长度不符，且没有接入端使用入口

`design.md:143-149` / `specs/cli/hub/spec.md:52-57` 没冻结 CRC-16-CCITT 变体（poly/init/refin/refout/xorout）、Base32 bit/padding 规则、规范大小写和歧义字符解码策略。按设计字段，IPv4 payload 是 9 bytes，标准无填充 Base32 至少 15 个字符；IPv6 是 21 bytes，至少 34 个字符。PRODUCT-DESIGN §4.4 的短码示例只有 8 个字母数字字符，design 的示例是 12 个字符，均不能按声明恢复完整载荷。另产品卡片写“输短码”，但现有 join 只接受 `--server <URL>`，delta 未定义短码转 URL 的命令/参数/网页输入流程。

**可验证修复**：冻结可独立复现的算法参数、字符集、分组/前缀、长度、padding canonicality，给 IPv4/IPv6 固定已知向量（包括 CRC check vector）、错误向量与逐位篡改测试；修正 PRODUCT-DESIGN 示例。定义用户可达的离线解码入口（例如 join 接受短码并严格 decode，或明确另一条可执行命令），并加“生成卡片→另一设备只拿短码→离线解码出同 origin→join”Scenario。仅测试 encode/decode 往返不足以冻结 wire。

#### HH-P1-6：多进程状态文件读改写会丢更新；原子 rename 只防半写不防 lost update

`design.md:114-124` 把多次 `join` 的同一本地租约簿定义为读改写 upsert；没有跨进程互斥/CAS。两个 join 并发读取同一旧快照后各写入一个 server 租约，最后 rename 的进程会覆盖另一个新租约。visits 更明确有两个写者：join 成功记录与 webui `POST /sidecar/visits/probe` 写 last_probe（`design.md:130-136`、`specs/cli/leases/spec.md:22-29`、`specs/webui/spec.md:31-33`），并发时也可能丢 first/last_visit 或 probe。若读取端承担旧 registration 迁移，迁移与 join 的竞态也未定义。

**可验证修复**：为每个文件指定唯一写服务，或冻结跨进程 lock/CAS+重读合并和崩溃恢复语义；定义 `.migrated` 与 leases 已存在时迁移的优先级。加并发测试：两个不同 server join 同时提交，两种 visit 更新同时提交，迁移与写入相撞；最终必须包含全部更新且原文件不会被覆盖丢失。保留 tmp+fsync+rename，但不要将其当作并发协议。

#### HH-P1-7：G-3 设计证据中有可核查前提错误，测试也不验证“停 hub”端到端承诺

`design.md:246-255` 断言 Fabric endpoint 未配置任何 AddressLookup；但实际默认 `RelayConfig::N0Default` 走 iroh `presets::N0`，其中配置 Pkarr Publisher/Resolver 和 DNS AddressLookup。它们不是本机 hub rendezvous，因此不直接推翻“既有 Direct 会话不依赖本机 hub”的结论；但说明本节把默认 endpoint 和 custom-relay 证据混为一谈，尤其不能据此泛化所有 relay-only 连接的地址恢复行为。计划中的 G-3 用例（`design.md:260-264`）只 drop relay 并运行 120s；这不是停掉包含 gateway+rendezvous+relay 的 hub 进程，也不能推出“无限期”。现有 `relay_failover.rs:193-201,243-257` 的恢复测试还通过 provider 主动 `disconnect` 触发路径，并非 relay-only outage。relay-only 对照又被标成可选，却同时在设计和产品文案中陈述 30-45s 死亡/自动恢复。Cargo.lock 确实 pin 到 iroh 1.1.0，源码有 5s heartbeat、30s relay path idle 与 `Abandoned` 后重新选 path 的实现；这是可信的静态依据，但不足以替代默认配置下的行为测试。

**可验证修复**：将“无限期”降为有边界的可验证承诺；把 N0Default/custom relay 配置分别写进结论适用条件。新增必需用例先断言当前 path 为 Direct，再实际停止 hub 的 gateway+relay（或等价 stop 整个 server 进程），持续双向交换超过声明窗口，同时断言 gateway health/new lookup 不可用；重启 hub 后验证新成员恢复接入。relay-only 路径若保留 30-45s 与自动恢复结论，应设为必需对照并精确定义检测/重连时限。把源版本、引用、复现命令及测试场景存成可复核证据链。

#### HH-P1-8：tray 的 SDK/IPC 契约不足以支撑一个确定可互操作的图标壳

`design.md:200-206` / webui spec 定义 `createConsole()` 返回 `onEvent/switchTarget/getSnapshot/close`，但没有 `url`、`openConsole` 或深链返回字段；tray 的 `open-console` 操作（`design.md:220-227`）因此没有明确可调用的 SDK 落点。snapshot/event payload 也未定字段、版本、订阅取消、错误/关闭顺序。另同一设计要求 stdout 承载 JSON-lines 状态事件，又规定 `--ipc` 用 stdio JSON-RPC；没有说明是两个互斥 mode 还是同一 stdout 上混流，也无 request id/error envelope/notification 顺序/坏帧与超长输入规则。opentray 无法据此实现稳定消费者。

**可验证修复**：冻结带版本的 SDK 返回类型和事件 schema，至少明确 console URL/深链、启动/关闭单飞、unsubscribe、error、快照时点；冻结 IPC transport、JSON-RPC 版本、request id、response/error/notification、stdout/stderr 所有权、最大帧长及进程退出语义。补 golden frame 和宿主契约测试：打开深链、动作成功/失败、并发请求、事件与响应交错、非法帧、崩溃后心跳停止。

#### HH-P1-9：接管既有 `dweb-data` 未定义正在运行服务的安全交接

`design.md:55-59` 及 hub delta 要求检测 cwd 下旧 `dweb-data/` 并提示接管；PRODUCT-DESIGN 的 O-9 还包括“已在跑的裸 server”。设计只定义目录存在时保留名册，没有说明如何识别真实 `DWEB_DATA_DIR` 路径、旧 server 是否仍在运行、如何避免同目录两个 server 并发打开、端口被占时是否允许改端口后对同一数据目录再起第二进程，也没有 `.migrated`/hub.json 部分提交顺序。现有裸 server 支持由 `DWEB_DATA_DIR` 指向非 cwd 路径，因此 cwd 扫描不能代表其身份。

**可验证修复**：冻结接管范围（默认路径与自定义数据目录）、运行中 server 的检测/拒绝/用户交接流程、目录锁唯一性及失败回滚；不允许在无法确认旧进程已退出时用同一 data_dir 启新 server。补 cwd 与自定义 DWEB_DATA_DIR、运行中/已退出、端口冲突/改端口、文件权限/损坏等 Scenario，断言 owners/server.key 完整且不会双进程写同一目录。

### P2

#### HH-P2-1：未决产品建议被提升为冻结规范，托盘未配置态还与 O-5 自相矛盾

`requirements.md` 的 [H7] 只拍板 G-1/O-1/O-2；PRODUCT-DESIGN v1.1 §8.1 仍把 O-5（纯成员机未配置态）和 O-8（卡片是否不含邀请码）列为开放建议。home-hub design/spec 把卡片“无邀请码”写成已裁决，把托盘“未配置”做成第四状态；但 O-5 明写 v1 建议不承诺纯成员机未配置态。H1 支持地址与引导信息，不等价于已批准将 O-8 冻结为产品约束。

**可验证修复**：在 requirements 增明确 Owner 裁决，或把该行为标作实现默认且不超出冻结范围；同步 O-5 表格与 design/spec 四态枚举。验收检查 requirement 中不再保留与冻结 MUST 相矛盾的开放项。

#### HH-P2-2：visits 的 `refused` 结果只在 design 出现

`design.md:130` 允许 `last_probe.result="reachable"|"unreachable"|"refused"`，`specs/cli/leases/spec.md:24` 只列 `reachable|unreachable`；probe 行为没有定义 HTTP 非 2xx、坏 JSON、权限拒绝、DNS/超时分别映射为何种结果。UI 又承诺“结果与实际一致”。

**可验证修复**：统一枚举并冻结错误分类、时间戳更新时间与缓存语义；增加 reachable、HTTP refused、超时、DNS 失败、格式错误 Scenario，避免“被拒”和“服务不可达”误导混淆。

#### HH-P2-3：租约“备注名可改”没有写路径

`design.md:116-118` 及 PRODUCT-DESIGN §3.3 说明 `label` 是本地备注且 UI 可编辑；sidecar delta 只有 GET leases、GET visits、POST probe、GET hub，没有 leases label mutation API 或 SDK 写面。

**可验证修复**：明确 label 是否属于本期。如果是，增加最小本机写路由/类型化 SDK 方法、输入长度与并发规则以及 Host/Origin 守卫和测试；若否，从本期产品稿中删除“可改”。

#### HH-P2-4：sidecar 安全规则虽引用 nodes guard，但 member 态负向覆盖仍过窄

`specs/webui/spec.md:33-38` 只以 `/admin/owners` 一个请求断言 404，没有钉住 `/admin/*` 全面 fail-closed、`/sidecar/connect` 不得把 member 改成 admin、所有新增数据路由的 Host/Origin 规则以及 probe 对跨源 POST 的拒绝。现有 nodes 面确有 `guardLocalOrigin`，但不能仅凭“loopback + 一个 404”推导新增路由都安全。

**可验证修复**：列出 member 路由方法/路径/Host/Origin 缺失与伪造矩阵；对所有新增本机数据路由断言正确 guard，测试 `/admin` 编码/未知路径全部无上游出站，probe 跨源/坏 Host/缺失 Origin 的既定策略。保留本任务只读评审边界，不在本轮改实现。

#### HH-P2-5：若干关键 Scenario 不是稳定的 Given/When/Then 验收

例如 `hub/spec.md:26-29` 以“审查创建路径”断言三文件权限；`hub/spec.md:54-57` 用“任意 IPv4/IPv6 且篡改任一字符”但没有向量、规范化策略与字符位置；webui card 场景要求“修改中枢地址”但没有定义可执行的修改入口。另缺少重复 init/start、崩溃遗留 pid、pid 复用、端口抢占、autostart 安装部分失败、迁移损坏权限等边界。

**可验证修复**：把代码审查型 WHEN 改为注入故障后的具体操作和可观察结果；固定每个算法输入、文件 mode、进程退出状态与 deadline；增补以上边界场景，并将每项绑定实现期 test target。

## 4. 覆盖与契约对照

| 输入/契约 | 设计落点 | Delta 承载与评审判断 |
|---|---|---|
| [H0] 家庭设备点对点初衷 | proposal Why；design §7 | 缺少“hub 停止仍 Direct 双向传输”的规范 Scenario；见 HH-P1-7。 |
| [H1] 朴素地址传递，mDNS 非核心 | design §3 | hub delta 冻结短码字段与卡片，但算法参数/长度与接收端使用闭环未闭合；见 HH-P1-5。 |
| [H2] 可选 tray 插件、`opendweb tray` | design §6 | tray delta 有 plugin/可选性和粗粒度状态；宿主 URL 与 IPC wire 不足；见 HH-P1-8。 |
| [H3] restricted、不默认启动、寻址/回退/门禁 | design §1/1.2/7 | CLI delta 覆盖 restricted 和禁止默认启动；停机承诺没有实现前的强制验收，G-3 结论适用条件需收窄。 |
| [H4] webui plugin + 可复用 SDK | design §5 | WebUI delta 覆盖 core/thin shell 与 `createConsole`，但保留 setup 行为、open/deep-link API 未冻结；见 HH-P1-2/8。 |
| [H5] 三视角与全局切换器 | design §4 | WebUI delta 承载主 IA、默认选择和 member mode；旧 setup 基线冲突及状态矩阵不完整；见 HH-P1-2。 |
| [H6] hostname 默认别名、缩写并存 | design §2、server-access-roles `2dacb56` | 真实基线已有 join alias 与 id hostname；home-hub 正确消费，不应覆盖服务端首写/续期保留语义。 |
| [H7] G-1/O-1/O-2 | design §1/2/4 | `leases.json`、组 B 命名、`hub` 命令有对应 delta；本地备注缺写面；见 HH-P2-3。 |
| server-access-roles renew/registered_at | design §2.1 | 与 `ced9215`/`26df800` 的 max(now, expiry) 顺延和首次注册时刻保持一致；没有发现 supersedes 冲突。 |
| server-access-roles 别名和 key 短缩 | design §2 / PM §5.3 | H6 自报仅本地展示，不得误写回服务端并覆盖已有管理员 alias；设计总体遵循基线首写语义。 |
| server-access-roles webui setup/token/target freeze | design §4.1/5.1 | member 态成为无 target 的新语义，但未说明与旧 setup 的显式优先级/入口；属于需声明 supersedes 的差异。 |
| F1/F2/F3/F4/F5 走查输入 | design §4.2、leases view、H6 | F1 3s、F2 “仅租户端点”有吸收；F3 WebUI 覆盖剩余租期，CLI hint 未冻结但为候选；F4 明确接受 Phase 2；F5 是工具环境提醒，不是产品机制。 |

## 5. 实现期不可回退基线

1. **显式启用**：中枢永不默认常驻；hub 命令只在显式 init/start/autostart 后创建进程或系统服务。
2. **准入安全不降级**：hub 默认 restricted；admin token 0600 本地保存；access/security 配置不接受插件钩子覆写；token 不进入输出、日志、卡片、浏览器可达状态或 tray IPC。
3. **数据目录单所有者**：一个 hub 身份对应一个确定 data_dir；接管旧目录需先确认旧进程退出并防止并发打开；迁移失败不得改坏原始名册/密钥。
4. **服务生命周期单一事实源**：detached/foreground/autostart 明确进程 owner、PID 身份、重复 start、异常退出、stop 和自启卸载语义；stop 后不得被 KeepAlive/启动项拉回。
5. **平台执行路径可复现**：服务产物记录绝对可执行路径、环境、工作目录、DWEB_HOME 与 quoting；只承诺发布包实际支持的平台；安装/卸载失败不能与 hub.json 状态假成功。
6. **本地账本不丢写**：leases/visits 每种文件有明确 writer；原子替换必须叠加跨进程串行化或 CAS 合并；`registered_at` 保持首次注册，续期基准服从 server-access-roles 冻结值。
7. **member sidecar 不成为 admin setup**：localhost 之外仍须 Host/Origin 守卫；member mode 禁止 admin 代理与配对改 target；新本机写路由都有 schema、拒绝条件与负向测试。
8. **短码为跨端 wire contract**：CRC/Base32 变体、bit order、padding、字符、长度、分组、前缀和已知向量一次冻结；必须有真实接收端离线 decode 路径，不把未定义行为留给 UI/CLI 各自猜测。
9. **tray 只消费稳定版本化 SDK/IPC**：状态、深链、事件类型、JSON-RPC framing、stdio 所有权和死亡检测有 schema 与契约测试；opentray 不依赖未声明 stdout 混流或临时字段。
10. **G-3 只宣传已证明的条件**：区分 Direct/relay-only，报告其真实路径；测试先验证 path 类型并实际停 hub 全进程；有限时长测试不宣称“无限期”；本 change 仍只允许 test-only Rust 变更。
