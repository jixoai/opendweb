# home-hub 设计层复审 r2

评审基点：`HEAD 330fa8f3bb1eae5216a85dc383c78339565ba4ab`（2026-09-23 worktree）
对照基点：r1 报告 `docs/codex-review-hh-r1.md`，HEAD `fc464ac`，NOT-READY 6.2/10。
评审范围：home-hub v2 设计与全部 delta、相关基线契约及实现事实；只读，报告文件除外。
结论：**NOT-READY，7.0/10（较 r1 +0.8）**。v2 对 r1 提出的平台范围、写锁、setup 分流、托管执行路径、短码入口、G-3 测试形态等作了实质修补；但仍有多项实现前必须补齐的行为闭环。尤其是家庭默认接入并未保证 G-3 所要求的 Custom relay，系统服务没有冻结实际 `DWEB_DATA_DIR` 与插件配置上下文，服务端续期不会更新租户本机到期快照，接管检测可漏掉使用自定义端口的旧服务，短码字节数自相矛盾，SDK `open()` 又与“core 不开浏览器”冲突。严格 OpenSpec 校验通过不消除这些语义问题。

## 1. 结论与评分

| 维度 | r1 | r2 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 7.0 | 8.2 | [H0]-[H7] 的设计映射更完整；但 G-3 仍未作为 delta 行为验收，且适用前提没有接入闭环。 |
| 基线契约与 supersedes | 5.5 | 7.2 | member/setup 有明确部分 supersedes 和 `--setup`；租约续期投影与现有服务端续期语义未闭合。 |
| 三方一致性 | 6.0 | 6.2 | design 与 delta 多数同名同字段；PRODUCT-DESIGN/proposal 仍有已拍板项、平台范围、成员 setup 的残留冲突。 |
| 技术可实现性 | 5.5 | 6.4 | 锁、进程分叉、路径和 IPC 已比 r1 可实现；data_dir、cwd 插件配置、PID 身份与旧服务探测仍有安全边界缺口。 |
| Spec 可测性 | 6.0 | 7.0 | 故障注入、并发、短码和 IPC 场景显著改善；探测分类、系统服务实测边界和部分负向测试仍不完整。 |

**分数变化依据**：原先 9 项 P1、5 项 P2 中，平台收窄、账本互斥锁、O-8/O-5 可回退标注基本闭合；setup、统一启动链、自启、short-code、G-3、tray 和接管问题有较大修订但只算部分闭合。评分上升反映初版的确定性缺口确已收敛，不代表当前可以开工：下列 P1 涉及数据目录所有权、既有服务并发、用户可见租期、凭证/进程安全和跨端 wire，任一项都可能让实现与承诺无法同时成立。

## 2. 验证证据

### 实际阅读

- 按评审对象读取 `openspec/changes/home-hub/requirements.md`、`proposal.md`、`PRODUCT-DESIGN.md`、`design.md` 与全部 delta：`specs/cli/hub/spec.md`、`specs/cli/leases/spec.md`、`specs/webui/spec.md`、`specs/packaging/tray-plugin/spec.md`；并读取 r1 原报告。
- 对照 `openspec/changes/webui-console/specs/webui/spec.md` 中无 `--server` 默认 setup、loopback/Host/Origin 守卫，以及 `openspec/changes/server-access-roles/specs/webui/spec.md`、`specs/server/spec.md` 的冻结面。
- 对照 `ced9215`、`26df800` 的 renew 顺延和首次注册时刻修复，以及 `2dacb56` 的机器名 alias 实现；另读 `server-access-roles/design.md` 与当前 server/webui delta。
- 核对实现事实：`packages/opendweb/bin/opendweb.mjs`、`src/join.mjs`、`src/plugin-resolve.mjs`、`packages/server-binary/index.js`、`crates/dweb-server/src/access/config.rs`、`packages/client-sdk/src/fabric.rs`、`packages/webui/src/cli.mjs`、`sidecar.mjs`、`target.mjs`、`crates/dweb-fabric/src/fabric.rs` 与 `crates/dweb-fabric/tests/relay_failover.rs`。

### 实际命令

- `git rev-parse HEAD`：`330fa8f3bb1eae5216a85dc383c78339565ba4ab`；评审开始时 `git status --short` 无输出，工作树干净。
- `git log -12 --oneline --decorate`：确认 `02545d5` 为 r1 报告归档、`330fa8f` 为 v2 修订；历史中确认 `ced9215`、`26df800`、`2dacb56`。
- `git diff --stat fc464ac..HEAD`：差异限于 r1 报告归档及 home-hub 的 PRODUCT-DESIGN/design/四份 delta；`git diff --check fc464ac..HEAD` 通过（无输出）。
- `openspec validate home-hub --strict`：通过，输出 `Change 'home-hub' is valid`。
- 未运行包测试、Rust 测试或系统服务安装/卸载。此轮审查的是实现前设计，G-3 的 300 秒测试义务和 launchd/Windows 登录验收均未被本轮实际执行；不把未来义务记作已验证行为。

### 支撑判断的源代码事实

- Client SDK 的 relay 缺省配置为 `RelayConfig::N0Default`，只有显式 `{mode:"custom", urls/relays}` 才指向自托管 relay（`packages/client-sdk/src/fabric.rs:177-229`）。当前 `join` 的工作是访问 `/register`、验签并写本机注册状态，不配置 SDK relay（`packages/opendweb/src/join.mjs:314-350,435-449`）。
- Server 的 data_dir 优先级是 CLI/env/default，默认相对 cwd 的 `dweb-data`（`crates/dweb-server/src/access/config.rs:19-20,143-155`）；server-binary 从父进程继承 `DWEB_DATA_DIR`（`packages/server-binary/index.js:50-53,87-94`）。
- `runServer` 以 `process.cwd()` 自动发现配置，并按 config 加载 server 插件（`packages/opendweb/bin/opendweb.mjs:462-492`）。v2 macOS LaunchAgent 将工作目录固定为 data_dir 父目录（`design.md:92`）。
- 基线 sidecar 实际绑定 `127.0.0.1`；现有 `guardLocalOrigin` 拒绝错误 Host 和不匹配 Origin，但明确允许 Origin 缺失（`packages/webui/src/sidecar.mjs:230-237,520-534`）。
- server-access-roles 将管理端 renew 定义为更新 owners registry，并冻结 `max(now, expires_at)`；客户端本地 `registration.json` 的 `expires_at` 只由成功 join 响应写入（`openspec/changes/server-access-roles/specs/server/spec.md` renew 条款；`join.mjs:435-449`）。home-hub 的租约 sidecar 目前只投影本地账本。

## 3. r1 问题闭合度

| r1 编号 | 结论 | 当前核验 |
|---|---|---|
| P1-1 平台承诺超出交付 | **闭合** | design 与 hub delta 均限定 darwin-arm64/win32-x64，非承诺平台明确非零退出；Linux 移后续 change。proposal 尚未同步，列入 P2。 |
| P1-2 member/setup 基线冲突 | **部分闭合** | 四行分流、部分 supersedes 和 `--setup` 显式入口已落 webui delta；但 PRODUCT-DESIGN 仍概括“无管理凭证直接落 member”，且已初始化 hub 的管理员入口没有分流路径。 |
| P1-3 detached 绕过插件钩子 | **部分闭合** | detached 自举 `hub start --foreground`，消除了双执行链；但系统服务 cwd 与手动启动 cwd 不同，server 配置/插件发现未冻结，不能据此证明 hook 行为逐一致。 |
| P1-4 服务路径与 owner 联动 | **部分闭合** | macOS 绝对 argv、Windows Startup 真实路径、owner 表、服务标识和失败不假成功均已写；但 `DWEB_DATA_DIR`/Windows cwd、服务 PID 身份、幂等 start/stop/status 和插件配置上下文未闭合。 |
| P1-5 short-code wire 与入口 | **部分闭合** | 字段/CRC 参数/长度/前缀/分组/接收入口和测试义务已写；design 同段又写错 payload 为 11/23 字节，且未冻结 bit packing/规范末位/真实固定向量。 |
| P1-6 leases/visits lost update | **闭合（设计层）** | 双写者、锁内重读、合并、原子替换、锁归属校验、陈锁和竞争 Scenario 已覆盖；实现期仍须按其协议实测。 |
| P1-7 G-3 证据与停机测试 | **部分闭合** | 明确 Custom/N0Default 条件、停整个 server、300s 双向发送与 relay-only 对照；但实际 join/default SDK 不保证 Custom，主承诺仍无 delta Scenario，relay-only 又允许不自动断言而继续保留数十秒口径。 |
| P1-8 SDK/tray 操作与 IPC | **部分闭合** | 有 `url/open`、事件 schema、disposer、双模式及 64KB/EOF 规则；但 SDK `open()` 的副作用与 core 边界直接冲突，RPC golden frame 未给可互操作的完整 wire。 |
| P1-9 旧数据接管 | **部分闭合** | 有拒绝运行中服务、hub.lock、显式自定义目录和 init 零残留；健康探测可能漏掉自定义端口旧 server，默认 `hub-data` 与发现的 cwd `dweb-data` 谁成为最终 data_dir 不明确。 |
| P2-1 O-8/O-5 未裁决默认 | **闭合** | 卡片不含凭证和托盘未配置态均标“实现默认/可回退”，O-5 不承诺纯成员机托盘。 |
| P2-2 visits 枚举/映射 | **部分闭合** | 主枚举统一为 reachable/unreachable 且 detail 有映射；Scenario 漏 timeout、2xx 坏 JSON，`bad-body` 没有确定归类断言。 |
| P2-3 label 无写路径 | **部分闭合** | PATCH 路由、锁和 64 UTF-8 字节上限已加；server origin 如何编码为单 path segment、空串如何归一为 null 未冻结。 |
| P2-4 member 负向安全覆盖 | **部分闭合** | `/admin/*` 无出站、connect/nodes 和跨源写拒绝均写入；但“缺失 Origin 必须 403”与所引用的基线 guard（缺失 Origin 被接受）相冲突。 |
| P2-5 Scenario 可测性与边界 | **部分闭合** | 故障注入、锁并发、迁移、pid 复用、同目录互斥等明显改进；autostart 只测生成物却要求重启行为，部分输出仍用“审查”式 WHEN，且 pid 用例未覆盖其他 Node 进程。 |

## 4. 未闭合/新增问题

### P0

无。

### P1

#### HH-R2-P1-1：家庭入网没有保证 G-3 所需的 Custom relay，停机承诺不在 delta 验收面

`design.md:290-299` 把结论限定为成员显式使用指向中枢的 Custom relay，并明确排除 SDK 默认 `N0Default`；但用户流程只交付网关地址短码，`join --server` 只注册和存本地凭据，未配置客户端 relay（`design.md:186-190`；`packages/client-sdk/src/fabric.rs:177-229`；`packages/opendweb/src/join.mjs:314-350`）。因此“家里常规扫码/join 后已直连会话不受 hub stop 影响”不是当前入网链自然具备的条件。另 G-3 停机行为与 300s 测试目前只在 design §7，delta 没有要求在指定 relay 配置下停机仍双向互传、新 join 失败且恢复后可加入；webui delta 仅要求标注直连/借道。

**修复建议**：在实现前决定并冻结 relay 下发路径：若家庭场景必须 Custom，则卡片/服务发现/客户端配置必须使新加入者实际采用 hub relay，并增加“只凭卡片→join→确认 Custom→停整个 hub→Direct 双向传输”的 delta Scenario；若本 change 不负责客户端 relay 配置，则把产品承诺限制到显式 Custom 配置用户，修改 PM 文案和验收，不再声称普通家庭流程天然满足。把 G-3 的可观察行为和 test-only Rust 义务写入 delta requirement/Scenario；未自动验证 relay-only 时须把自动恢复时限/文案一并降级，不能只备注未经断言。

#### HH-R2-P1-2：初始化后的中枢管理员没有明确的独立 WebUI 进入路径

webui delta 的启动分流只有显式 `--server`→admin、带本地 leases/visits→member、零本地数据→setup、`--setup`→setup（`specs/webui/spec.md:17-34`）。新 hub 首次初始化恰可能没有 leases/visits；`hub-token` 被要求不输出，`hub init`/命令族也没有打开本地 admin 控制台或自动将 hub credentials 交给 SDK 的 CLI 入口（`design.md:39-45,59-60`）。这会令本机中枢所有者执行普通 `opendweb webui` 进入 setup，而无法无文档地到达 [H5]“我的中枢”；tray 是可选插件，不能成为唯一入口。PRODUCT-DESIGN §3.2 又把 ready 管理台作为中枢视角既有资产。

**修复建议**：增加明确受控入口（例如 `opendweb webui --hub`/`opendweb hub open`），或把“本机 hub.json+hub-token 且服务运行”的自动分流加入规则；仅在进程内读取 0600 token，不能把 token 放 argv、URL、浏览器状态或 IPC。补 fresh-init 零租约/零到访下打开管理员面、停机后错误态、`--setup` 仍显式保留的 Scenario。

#### HH-R2-P1-3：LaunchAgent/Startup 没有冻结 server 实际使用的 data_dir

home-hub 将目录记为 `<DWEB_HOME>/hub-data`（`design.md:59,64`），而服务端实际使用 `DWEB_DATA_DIR` 或 cwd 下 `dweb-data`；server-binary 仅继承父进程 env（`crates/dweb-server/src/access/config.rs:19-20,143-155`；`packages/server-binary/index.js:50-53`）。detached 行只泛称“注入 DWEB_*”；LaunchAgent 环境表只点名 DWEB_HOME，Windows 启动脚本没有冻结工作目录/`DWEB_DATA_DIR`（`design.md:78,92-101`）。在服务 child 未从 hub.json 显式读入 data_dir 的情况下，进程可启动成功却把 `owners.jsonl/server.key` 写到另一个目录，绕过接管数据与 `<data_dir>/hub.lock` 的唯一所有权假设。

**修复建议**：规定所有宿主（foreground、detached、macOS service、Windows Startup）在执行 server 链前从 `hub.json` 解析并设置绝对 `DWEB_DATA_DIR`，明确与继承环境/CLI 的优先级；启动后核实 server 使用目录与 hub.lock 所在目录相同。加跨宿主集成断言：注册/owner 文件实际落在 hub.json.data_dir，错误路径/权限时不得启动或假报成功。

#### HH-R2-P1-4：服务 child 的 cwd 会改变插件配置发现，违反“钩子逐一致”

`runServer` 从 `process.cwd()` 发现配置并按配置加载 server 插件（`packages/opendweb/bin/opendweb.mjs:462-492`）。detached spawn 默认继承调用 cwd，但 macOS 服务明确把 WorkingDirectory 改为 data_dir 父目录（`design.md:78,92`）；Windows 未定义 cwd。于是启动服务时可能发现不到启动时配置的插件，或发现另一个目录的配置，`preStart/postReady/preStop` 与裸 server/前台不再逐一致。相同代码链不等于相同配置上下文。

**修复建议**：在 hub.json 中冻结经验证的绝对 config 路径及插件解析基准目录，并由每个宿主显式传入；或者明确 hub 使用独立固定配置且不得加载 cwd 插件，同时撤回“与裸 server 逐一致”的承诺并说明插件兼容策略。增加有本地配置插件时的 detached、LaunchAgent、Windows 启动脚本对照 Scenario，断言三钩子及配置内容一致。

#### HH-R2-P1-5：租户本机 `expires_at` 不会随管理员侧 renew 更新

租约页以本机 `leases.json` 计算 `expires_in`（`specs/webui/spec.md:36-38`），而 `leases.json` 的 `expires_at` 来自 join 响应。server-access-roles 的管理端 renew 改的是服务端 owners registry，且约定 `max(now, expires_at)` 顺延；客户端没有订阅/公开查询这次 mutation 的路径。PRODUCT-DESIGN §2 叙事 H4/§4.5 又要求管理员续期后成员黄条消失。两者不能同时成立：本机倒计时会继续走到旧到期日，可能显示已过期而服务端其实已续期。

**修复建议**：在本 change 不碰 Rust server 的约束下，选择并写明该页显示的是“本机最后一次 join/兑换所获租期快照”，管理员后台 renew 不实时同步；改 PM 文案与验收，不承诺黄条自动消失。若产品坚持显示服务端最新租期，则需另有带身份认证的成员查询/推送协议，并明确这是超出本 change Rust 范围的依赖，不能在当前范围内假设存在。

#### HH-R2-P1-6：PID 防复用只看 `node` 可执行名，可能误杀其他 Node 应用

`design.md:85-86` 与 hub spec 的 PID Scenario 仅要求进程名含 `node/opendweb`。detached 守护进程本身由 `process.execPath`（通常就是共享的 node 可执行文件）启动；PID 若复用给不相关 Node 程序，仍满足 `node` 名称检查。按 PID 发 SIGINT/SIGKILL 会伤及无关应用，当前“无关进程”Scenario 可能仅用非 Node 进程而漏掉该类复用。

**修复建议**：pid/lock 元数据冻结进程启动身份（创建时刻/平台可读的进程 start identity）和规范 CLI 入口/argv，并在 stop/status 同时核验；任何身份字段缺失或无法确认时只报占用/未验证，不发信号。测试用同一个 `process.execPath` 启动不相关 Node 脚本占据旧 PID，断言 stop 不发信号；服务模式也测 manager/lock 状态查询。

#### HH-R2-P1-7：接管检测无法证明自定义端口的旧 server 已退出

接管协议只在 gateway/relay 的健康地址可达时拒绝（`design.md:113-126`）。旧 server 可用 `--gateway/--relay`、env 或 config 改端口；默认 cwd `dweb-data` 仍可能被该进程使用。探测默认端口失败会被当成“未运行”，而旧裸 server 不持有新加的 hub.lock，因此可与新 hub 同时写相同目录。另 default `<DWEB_HOME>/hub-data` 与发现 cwd `dweb-data` 时，哪一个是被接管后的真实 data_dir 没有明确选择规则。

**修复建议**：对已识别的旧 data_dir 读取/解析其服务配置与启动上下文并探测所有实际绑定；如果不能可靠证明旧进程已停止，拒绝自动接管并要求明确人工停机确认/迁移步骤。冻结“检测到 cwd dweb-data 时 hub.json.data_dir 必须指向该目录，还是复制/搬迁”的唯一规则（当前写的是只读不迁移），并加自定义端口运行中拒绝、已停机接管和绝不启动第二份的故障注入 Scenario。

#### HH-R2-P1-8：短码 payload 长度互相矛盾，编码 bit/canonical wire 仍可多解

`design.md:174-182` 首句把 payload 写为 IPv4 11B/IPv6 23B，但同段之后按 9B/21B 计算 Base32 长度。字段实际是 `1+4+2+2=9B` 与 `1+16+2+2=21B`，所以 11/23 是错误常量。除此之外 CRC 输入范围（是否只覆盖 `ver||ip||port`）、Base32 的跨字节 bit 顺序、末尾不足 5 bit 的补位值及非规范末字符是否拒绝均未明文冻结；目前只要求实现提交附固定向量，设计/spec 没有给出任何完整 input→short-code 向量。

**修复建议**：修正字节数；明确 CRC 精确覆盖范围和字节序；明确 MSB/LSB 打包、剩余位填充值、decode 对非零 padding 位/多余字符/非法 Crockford 字符的拒绝规则。把至少 IPv4/IPv6 完整地址、端口、原始 payload、CRC、完整短码做成设计级 golden vectors，并让 CLI/WebUI 共用同向量；逐字符篡改之外，断言非规范等价串拒绝。

#### HH-R2-P1-9：createConsole 的 `open()` 与 core 禁止开浏览器互相矛盾

design §5.1/spec `createConsole` 把 `open(deepLink?)` 定义为“打开浏览器”；紧接着又规定 core MUST NOT 持有进程语义，并把开浏览器留在 CLI 壳层（`design.md:253-262`；`specs/webui/spec.md:50-62`）。tray 需要通过 SDK 落点打开深链，现有定义没有说由调用者注入 opener、由 shell 包装，还是 core 自己 `spawn/open`。`url` 还被描述为带“本次会话口令参数”，但该口令的类型、生命周期、与 hub-token/admin token 的关系及不出浏览器/IPC 的边界没有定义。

**修复建议**：冻结纯 core 能力（例如 `urlFor(deepLink)` 返回地址）与宿主副作用边界；若保留 `open()`，必须明确为必需注入的 host callback，并在 createConsole opts/types 中定义。区分随机 sidecar session capability 与 hub-token/admin token，禁止秘密进入 URL/浏览器可见状态/IPC 响应；为默认 CLI 与 tray 分别增加打开深链和错误路径契约 Scenario。

### P2

#### HH-R2-P2-1：PRODUCT-DESIGN 与 proposal 未同步已拍板命名、成员分流和平台边界

PRODUCT-DESIGN 顶部承认 O-1/O-2/G-1 已拍板，但 §1.6/§4.1 仍写“待 Owner 拍板”，术语表仍写“待拍板”，开放问题表仍列 O-1/O-2，G-1 仍是“请 Owner 确认”（`PRODUCT-DESIGN.md:131,302,385,470-471,485`）；其 §1.3/§7 又把所有无管理凭证设备概括成 member、不进 setup，与 delta 的“零 leases/visits 仍 setup”不同。proposal 仍写 launchd/systemd 跨平台（`proposal.md:32-39`），与 design/spec 限定 darwin+win 冲突。

**修复建议**：将 O-1/O-2/G-1 从开放问题改成已裁决记录，保留 [H7] 为唯一决定来源；逐处同步“无凭证但无本地数据”的 setup 行为及短码命令；proposal 明写本 change 不交付 Linux/systemd。加文档搜索门禁，确保“待 Owner 拍板”“请 Owner 确认”和本期 systemd 承诺不再残留。

#### HH-R2-P2-2：member 写路由 Origin 矩阵与基线守卫语义冲突

`design.md:225-234` 要求跨源写请求（坏 Host/缺失 Origin/非回环 Host）403，并说所有本机路由沿用 nodes guard；基线 `guardLocalOrigin` 对缺失 Origin 实际放行，仅拒绝不匹配的 Origin（`packages/webui/src/sidecar.mjs:520-534`）。因此按“复用基线 guard”实现将无法通过新 Scenario；按新矩阵实现又不是沿用基线行为。

**修复建议**：明确新增 probe/label 写路由是否要求 Origin 必须存在；若要求，定义仅新写路由的更严格 guard，不改动旧配对/节点簿语义，并在 spec 明确 same-origin browser、curl/无 Origin、坏 Host、伪造 Origin 四类状态码。同步 design 与 Scenario，不要把缺 Origin 一概称为“跨源”。

#### HH-R2-P2-3：visits 既混入租户 join，探测映射又缺故障类别

design/spec 将 `join 成功`列为 visits 写触发（`design.md:157-168`、`specs/cli/leases/spec.md:29-36`），但 PRODUCT-DESIGN 把 visits 定义为本机作为访客被放行后的记录（§1.3/§3.4）；租户兑换成功不等于访客到访，可能让同服务器同时出现在“租约”和“到访”。探测枚举列有 timeout、dns、bad-body，但 Scenario 只测 reachable、500、连接拒绝、DNS；“2xx 但 JSON 无法解析”及超时没有落值断言。

**修复建议**：明确 visits 的业务定义；租户 join 仅写 leases，只有访客成功连接/明确访客尝试才写 visits，或同步修改产品命名和用户文案。冻结 first_visit_at/last_visit_at 的更新时机，并补 DNS、超时、连接拒绝、非 2xx、2xx 坏 JSON 的五类确定映射 Scenario。

#### HH-R2-P2-4：label endpoint 的规范化键不能直接作为普通路径段

`PATCH /sidecar/leases/{server 归一化键}/label` 将 HTTP origin（含 `http://`、斜线、IPv6 方括号/冒号、端口）直接描述为单路径参数（`design.md:229-234`；`specs/webui/spec.md:36-43`），没有定义编码、解码、大小写/default-port canonicalization 或冲突拒绝。`label: ""` 是否转为 `null` 也未冻结。

**修复建议**：改用稳定不透明 lease key，或规定 `encodeURIComponent(canonicalOrigin)` 的唯一线路编码并在一次 URL 解码后严格重归一化比对账本键；拒绝双重编码/分隔符/未知键。冻结空串清除与 null 的一致语义，并对 IPv4、域名默认端口、IPv6、恶意编码补路由测试。

#### HH-R2-P2-5：托盘 RPC 与系统服务验收仍缺可互操作的完整帧和运行证据

tray 规定 JSON-RPC 2.0、newline framing、`{code,message}`、64KB 和 EOF，但没有展示 JSON-RPC 的完整请求/响应/error JSON envelope、通知是否允许/是否回包、batch 是否支持、超长帧的 id 如何恢复；Golden Scenario 只要求“一个结果帧/error 帧”（`specs/packaging/tray-plugin/spec.md:7-22`）。同时 hub spec 禁止测试中实际 load 服务，却要求重启自启与 stop 不复活，design test strategy 只列文本快照（`specs/cli/hub/spec.md:50-67`；`design.md:102-104,317-328`）。

**修复建议**：把逐行 JSON-RPC 请求/成功/错误/通知样例写入契约，冻结字段、id、错误码、超长/坏帧恢复和 stderr/stdout 所有权；明确 batch/notification 的拒绝策略。将系统服务分为普通单测（不 load）和 disposable 用户/VM 手工或 CI acceptance（install→login/reboot→stop→不复活→start→off），指定验收记录，不以快照替代生命周期验证。

#### HH-R2-P2-6：IPv6 link-local 地址无法由当前短码恢复到正确接口

短码只编码 16 字节 IPv6 地址和 port，解码成 `[ip]:port`（`design.md:174-190`）。IPv6 link-local（`fe80::/10`）访问通常需要 zone/interface scope；wire 中没有 scope id，无法在多网卡家庭设备上唯一选择接口。当前只枚举 IPv4 LAN 地址（§1.5），却把 IPv6 列为短码与未来接入目标。

**修复建议**：v1 明确拒绝 link-local 并提示输出可路由 ULA/global IPv6，短码和卡片只接受无 scope 地址；或扩展 wire 增 scope 设计（后者须版本化并重新冻结向量）。增加多网卡 link-local 拒绝/ULA 成功用例。

#### HH-R2-P2-7：显式不默认启动尚缺“全新/安装后无服务”的负向 Scenario

hub Requirement 中有 MUST NOT 默认启动，但没有可执行 Scenario 覆盖首次安装、普通 `opendweb` 命令、无 hub.json 的 `webui`、用户登录/重启在 autostart 未启用时均不会启动 server（`specs/cli/hub/spec.md:3-20`）。非承诺平台的无副作用断言不覆盖支持平台的首次启动。

**修复建议**：增加全新 DWEB_HOME/未 init/未 autostart 的启动探针 Scenario，断言无 server 子进程、无 system service、无 hub 文件；普通安装/打开 webui 后依旧如此。把它作为 [H3] 的实现期必测项。

## 5. [H0]-[H7] 与基线终判

### Owner 裁决覆盖

| 输入 | 设计机制 | Spec 承载终判 |
|---|---|---|
| [H0] 家庭点对点初衷 | hub 为生命周期/寻址/门禁包装；G-3 条件化（design §7） | **不充分**：delta 没有停机后 Direct 双向可用的验收 Scenario；且 Custom relay 条件未由卡片/join 保证。 |
| [H1] 朴素地址、mDNS 非核心 | 卡片地址/二维码/短码、短码离线 decode、join 直收 | **有承载，wire 需修**：hub delta 有字段/CRC/长度与接收场景，但 payload byte 行自相矛盾且没有完整 golden vectors。 |
| [H2] tray 为可选插件 | opendweb tray 无头插件、心跳、stdout/RPC、可选性 | **基本有承载**：tray delta 有 schema 与场景；SDK open 和 JSON-RPC 完整 envelope 尚未闭合。 |
| [H3] 寻址/回退/门禁、不默认启动 | restricted、显式 hub init、自启用户级、零默认常驻 | **部分承载**：规范 MUST 有，缺支持平台首次安装/登录不启动的负向 Scenario；G-3 适用条件不是默认入网条件。 |
| [H4] webui plugin+SDK | core/薄壳、createConsole、事件和快照 | **部分承载**：API 有 schema；`open()` 与 core 禁止开浏览器矛盾，独立 hub 管理员入口欠缺。 |
| [H5] 三视角 | 切换器、租约/到访本地账本、member 视角 | **有承载但语义需修**：成员数据分流有明确 Scenario；产品稿 setup 口径陈旧，续期快照不会同步。 |
| [H6] 机器名 alias | 已由 `2dacb56` 实现；home-hub 只消费 alias | **基线承载**：不覆盖 server 侧自报>hint>无、首写语义；新增 leases alias 是本机快照。 |
| [H7] G-1/O-1/O-2 | 多租约簿、组 B、hub 命令族 | **基本有承载**：leases/hub delta 都有要求；PRODUCT-DESIGN 尚残留待拍板文字。 |

### server-access-roles 冻结面

- 三角色、邀请码、敲门、admin 四页、token 边界仍在；member/setup 只声明对“有本机租约/到访数据且无参”路径 supersedes，零数据 setup 与显式 `--server` 基线保留，未发现对 `/admin/*` 业务模型的未声明改写。
- `[H6]` alias 的首写与自报语义未被 home-hub 推翻；本地显示/备注字段不同于写回服务端 alias。
- `ced9215`/`26df800` 的 `max(now, 当前 expires_at)` 顺延与首次注册时刻在本机租约同键 upsert 规则中得到尊重；但服务端后台续期不会自动回写成员本机 `leases.json`，见 HH-R2-P1-5。
- 无其他明确声明 supersedes 的基线冲突；当前 setup 分流声明范围合理，需同步 PRODUCT-DESIGN 以免实现者从旧稿得出另一规则。

### r1 §5 十条“不可回退基线”

| # | 基线 | 终判 |
|---|---|---|
| 1 | 显式启用，不默认常驻 | **部分满足**：Requirement 写了 MUST NOT 默认启动，但缺支持平台首装/重启的负向测试。 |
| 2 | restricted、凭证 0600、不进输出/卡片/浏览器/tray | **部分满足**：token 文件及禁止输出写清；`createConsole.url` 的会话口令未定义，须排除 admin/hub token。 |
| 3 | 单一 data_dir、接管前旧进程退出、迁移不破坏原名册 | **未满足**：服务 child 的 `DWEB_DATA_DIR` 未冻结；自定义端口旧 server 可漏探测；cwd `dweb-data` 的接管后路径不明确。 |
| 4 | detached/foreground/autostart owner、PID、stop、恢复唯一 | **部分满足**：owner 表存在，但 PID 复用校验不足，服务模式 status/stop 过程和配置上下文未完全定义。 |
| 5 | 平台执行路径可复现，安装失败不假成功 | **部分满足**：平台范围和主要绝对路径已冻结；proposal 仍包含 systemd，Windows cwd/env/ quoting 与服务实际 acceptance 不足。 |
| 6 | 本地账本无丢写且 renew/registered_at 保基线 | **部分满足**：多文件锁协议与 registered_at 闭合；管理员 renew 后租户本地 expires_at 变陈旧，visits 边界也未定。 |
| 7 | member sidecar 非 admin/setup，回环外有守卫 | **部分满足**：member 面有明确 404/403 和无出站要求；缺 Origin 策略与基线 guard 矛盾，hub 本机管理员启动路径缺失。 |
| 8 | 短码 wire 一次冻结且有真实 decode 端 | **未满足**：直收入口已定义，但 payload 字节矛盾、Base32 规范细节与真实 golden vector 缺失。 |
| 9 | tray 消费稳定版本化 SDK/IPC | **部分满足**：schema、心跳、互斥 transport、最大帧和 EOF 已冻结；SDK opener 与 IPC golden wire 未完全明确。 |
| 10 | G-3 仅宣传已证明条件，Rust 仅 test-only | **部分满足**：300s/full-server-stop/test-only 范围很好；但 household 客户端并未保证 Custom，relay-only 可降级同时保留结论，主行为未进入 delta。 |

**实现前放行条件**：至少关闭 HH-R2-P1-1 至 P1-9；并同步 proposal/PRODUCT-DESIGN，明确本机 hub 管理员入口、renew 后租户页展示真源以及 JSON-RPC wire。实现期只允许 `relay_failover.rs` 的 G-3 test-only Rust 增量；不能通过改 server Rust 行为来掩盖当前 CLI/WebUI/设计范围的缺口。
