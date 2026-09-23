# home-hub 设计层复审 r3

评审基点：`HEAD b2b960b92e3b1f6eb23a854e20e81b7b6696fa89`（2026-09-23）。
对照基点：r2 报告 `docs/codex-review-hh-r2.md`（`330fa8f`，NOT-READY 7.0/10）。
评审范围：home-hub v3 的 requirements、proposal、PRODUCT-DESIGN、design、四份
delta，以及 server-access-roles/webui-console 冻结面和实际 CLI/WebUI/server/SDK
实现。只读评审，除本报告外不改仓库文件。

结论：**NOT-READY，7.3/10（较 r2 +0.3）**。v3 确实处置了 r2 中大部分
文档级缺口：接管规则、三宿主路径/data_dir/config、PID 三元组、租期快照、visits
语义、label id、link-local、默认不启动和大部分 IPC 场景均已写入 delta。但仍有
新的实现前阻断：中枢 token 没有冻结为 server 的 `DWEB_ADMIN_TOKEN` 注入，因而
现有 server 不会挂载本机 admin 面；relay URL 只落在设计账本，`services.json`
可合法发布 `null`，且没有定义缺失处理和实际 SDK Custom relay 配置；短码的歧义
字符规则与“非规范等价串拒绝”自相矛盾，IPv6 解码结果的 URL 括号也未冻结；tray
错误 golden 帧不是合法完整 JSON-RPC 2.0 响应。故不能给设计层 GO。

## 1. 结论与评分

| 维度 | r2 | r3 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.2 | 8.4 | [H0]-[H7] 均有章节映射；[H0]/[H1] 仍受 relay 和短码闭环阻断。 |
| 基线契约与 supersedes | 7.2 | 7.6 | member 分流的 supersedes 范围基本合理；proposal/PM 仍留旧命名和旧 registration 叙述。 |
| 三方一致性 | 6.2 | 7.1 | design/delta 大体同步；短码、admin 注入、tray wire 仍有跨文档/事实矛盾。 |
| 技术可实现性 | 6.4 | 6.8 | data_dir、cwd、接管和 PID 明显收敛；admin 面和 relay 消费链未闭合。 |
| Spec 可测性 | 7.0 | 7.2 | 16 项旧问题多数有故障注入 Scenario；G-3 降级条件、capability 生命周期和服务验收仍不够可判定。 |

分数变化依据：v3 新增了可执行的五行分流、G-3 delta 条款、短码向量、锁/label/
visits/RPC 负向矩阵，故较 r2 上升；但独立检查发现这些文字没有覆盖 server
admin token 的真实装配点，且 relay/短码/JSON-RPC 的 wire 仍不能直接交给实现者而
不产生两套解释，故只增加 0.3 分。

## 2. 验证证据

### 实际阅读

- `openspec/changes/home-hub/requirements.md`
- `openspec/changes/home-hub/proposal.md`
- `openspec/changes/home-hub/PRODUCT-DESIGN.md`（v1.2）
- `openspec/changes/home-hub/design.md`（v3）
- `openspec/changes/home-hub/specs/cli/hub/spec.md`
- `openspec/changes/home-hub/specs/cli/leases/spec.md`
- `openspec/changes/home-hub/specs/webui/spec.md`
- `openspec/changes/home-hub/specs/packaging/tray-plugin/spec.md`
- `docs/codex-review-hh-r2.md`、r1 报告和 `git log`
- `openspec/changes/server-access-roles/specs/{server,webui}/spec.md`、
  `openspec/changes/webui-console/specs/webui/spec.md`
- 实现事实：`packages/opendweb/src/join.mjs`、`packages/opendweb/bin/opendweb.mjs`、
  `packages/webui/src/{sidecar,cli}.mjs`、`packages/server-binary/index.js`、
  `crates/dweb-server/src/{main,services}.rs`、`crates/dweb-server/src/access/config.rs`、
  `packages/client-sdk/src/fabric.rs`、`crates/dweb-fabric/tests/relay_failover.rs`。

### 实际命令

- `git status --short`：评审开始时工作树干净。
- `git rev-parse HEAD`：`b2b960b92e3b1f6eb23a854e20e81b7b6696fa89`。
- `git log --oneline -8`：确认 `02545d5` 为 r1 报告，`330fa8f` 为 v2，当前为 v3。
- `git diff --stat 330fa8f^..b2b960b`：变更为 r2 报告存档及 home-hub 七份设计/规格文件。
- `git diff --check 330fa8f^..b2b960b`：通过。
- `openspec validate home-hub --strict`：通过，`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- 独立 Python CRC/Base32 计算：V1 原始 `01c0a8020d22537afd`、编码
  `070ag0gd499qnz8`；V2 原始 `02fd0000000000000000000000000000132253e506`、编码
  `0byg00000000000000000000009j4mz50r`，与文档两向量一致（分组/前缀也一致）。
- 未运行 npm 包测试、Rust 测试、真实 LaunchAgent/Windows Startup 安装、300 秒 G-3
  或真实账户 acceptance；这些是实现期义务，不被本报告虚构为已通过。

### 关键事实

- `crates/dweb-server/src/main.rs:498-503` 只有在环境变量 `DWEB_ADMIN_TOKEN`
  存在时才挂载 `/admin/*`；`packages/server-binary/index.js` 将父进程环境传给
  server。v3 的 hub start 环境冻结只写 `DWEB_DATA_DIR`（design §1.3，hub delta
  “DWEB_DATA_DIR 注入”），没有写 `DWEB_ADMIN_TOKEN=hub-token` 的必需注入。
- `packages/opendweb/src/join.mjs:395-449` 当前只从 `/services.json` 取
  `server_id` 并写单条 `registration.json`，没有读取 relay 条目；设计虽规定未来
  落 `relay_url`，但未冻结 `services[].name=relay/enabled/url=null` 的失败语义或
  `FabricOptions.relay` 的 Custom 消费路径。
- `crates/dweb-server/src/services.rs:228-306` 的 relay 条目是 `url: Option<String>`；
  Host/回退地址不可用时可以是 `enabled:true,url:null`。这与 leases 的必填
  `relay_url` 及“不得回落 N0Default”没有闭合规则。
- `packages/client-sdk/src/fabric.rs:177-229` 的 relay 缺省是 `RelayConfig::N0Default`；
  Custom 必须由调用者显式构造。`leases.json` 本身不会改变 SDK 已运行实例的 relay 配置。
- `packages/webui/src/sidecar.mjs:520-534` 的基线 `guardLocalOrigin` 对缺失
  Origin 放行；home-hub 明确规定新 probe/label 写路由更严格，这属于已声明的局部
  supersedes，不是未声明地改写旧 `/api`/配对面。

## 3. r2 问题闭合度

| r2 编号 | 结论 | 当前核验 |
|---|---|---|
| P1-1 入网/G-3 Custom relay | **部分闭合** | 有 `relay_url` 字段、join Scenario 和停整 hub Scenario；但 relay 条目可为 null，现有 join/SDK 没有读取和 Custom 配置机制，见 R3-P1-2。 |
| P1-2 member/setup/管理员入口 | **闭合（设计面）** | `hub open`、hub.json 自动 admin、五行分流及 fresh-init Scenario 已写；其可用性仍受 admin token 注入问题阻断。 |
| P1-3 data_dir 注入核实 | **闭合（设计面）** | 三宿主注入优先级、readiness 后 owners/key 核验和失败语义均在 hub delta。 |
| P1-4 cwd/config/钩子一致 | **闭合（设计面）** | 全宿主 `DWEB_HOME`、冻结 `config_path`、不依赖 cwd 插件发现和对照 Scenario 已明确。 |
| P1-5 expires_at 续期投影 | **闭合** | 本地快照真源、服务端 renew 不回写、PM/Scenario 文案已同步。 |
| P1-6 PID 复用 | **闭合（设计面）** | `{pid,start_identity,argv_digest}` 三重校验及同 execPath 无关 Node Scenario 已补。 |
| P1-7 接管/自定义端口 | **闭合（设计面）** | 尽力探测、可证明运行拒绝、无法证明则人工确认、cwd `dweb-data` 唯一规则均冻结。实现仍须保证确认文案确实阻塞。 |
| P1-8 短码 wire | **部分闭合** | 9/21 字节、CRC、MSB、padding、向量和 link-local 已补；歧义字符/非规范串和 IPv6 URL 括号仍相互矛盾，见 R3-P1-3。 |
| P1-9 SDK/tray open | **部分闭合** | `urlFor`/注入 opener/close/disposer/秘密边界已写；capability 的 TTL、消费端点、绑定和撤销未冻结，且 tray error wire 仍不完整，见 R3-P1-4。 |
| P2-1 PM/proposal 残留 | **未完全闭合** | proposal 仍写 `我的服务器/我的服务商` 和 `registration.json`；PRODUCT-DESIGN §1.3 表头仍为“待拍板”，见 R3-P2-1。 |
| P2-2 Origin | **闭合（设计面）** | 新写面明确“Origin 必须存在且匹配”、四类状态码和不沿用旧缺失放行。 |
| P2-3 visits | **闭合** | join 不写 visits、first/last 时机和五类（含 bad-body）映射均有 requirement/scenario。 |
| P2-4 label | **闭合** | 不透明 10 字符 id、空串归一 null、未知 id 404、并发及 64 UTF-8 字节上限均有承载。 |
| P2-5 RPC/服务验收 | **部分闭合** | golden 场景增加 notification/batch/超长恢复/坏帧和 acceptance 分层；error 样例缺 `jsonrpc`，见 R3-P1-4。 |
| P2-6 link-local | **闭合** | 编码、解码、卡片均拒绝 fe80::/10 并提示 ULA/global。 |
| P2-7 默认不启动 | **闭合（设计面）** | 全新 DWEB_HOME 全命令探针已写；实现期仍需隔离 HOME 真实执行。 |

## 4. 新问题

### P0

无。

### P1

#### R3-P1-1：hub token 没有注入 server admin 面，`hub open` 的目标不存在

`hub init` 把凭证写入 `<DWEB_HOME>/hub-token`，`hub open` 和 webui delta 也要求
“进程内读 hub-token”。但现有 server 只有 `DWEB_ADMIN_TOKEN` 存在时才装配
`/admin/*`（`crates/dweb-server/src/main.rs:478-503`）；`startServer` 只会把父进程
环境传给二进制。v3 §1.3 只冻结 `DWEB_DATA_DIR`，plist 还明确不写该变量，却没有
冻结链入口读取 hub-token、设置 `DWEB_ADMIN_TOKEN`、清理环境及 readiness 后验证
`/admin/status` 的步骤。因此按当前文字启动的 restricted 中枢可以健康响应
`/healthz`，但 `hub open` 只能得到 404/no-admin，直接违反 H4/H5 和 fresh-init
Scenario。

可验证修复：在 hub start 的唯一链入口明文冻结 `hub-token` 仅以子进程 env
`DWEB_ADMIN_TOKEN` 注入（不进 argv/plist/日志），禁止继承的同名 env 覆盖；readiness
后用不泄露 token 的本机请求断言 `/admin/status` 已挂载，失败即停机并清理 lock；补
detached、foreground、LaunchAgent、Windows Startup 四宿主的“admin/status 200 +
token 不出面”Scenario。若选择不同 admin 传递机制，必须同步 server-binary 现有
事实和全部规格，不能只依赖 sidecar 读取文件。

#### R3-P1-2：relay_url “落账”仍不是可用的入网 Custom relay 闭环

home-hub delta 把 `relay_url` 写成租约必填，并规定连接 MUST 使用它、不回落
N0Default；但没有定义 `/services.json` 的 relay 条目选择（`name`、`enabled`、
`url`）、URL 为 `null` 或 relay disabled 时 join 是失败还是生成不可连接租约，
也没有规定如何把该值送进 `FabricOptions.relay={mode:"custom",urls:[...]}`。
这不是纯未来实现细节：当前 `join.mjs:395-449` 只取 `server_id`，当前 SDK 默认
`N0Default`（`fabric.rs:177-229`），账本字段不会改变已创建 Fabric 的 relay。
服务端还允许 `enabled:true,url:null`（`services.rs:228-306`），例如 Host 和本机
回退地址都不可用时即可出现。此时“G-3 家庭链自然得到 Custom”与实际 wire 不可
同时成立。

可验证修复：冻结 `services.json` relay 选择和 null 处理：要么 relay 必须为 enabled
且非空 URL，否则 join fail-closed、不得落可宣称已加入的条目；要么显式把产品承诺
降级并把 G-3/PM 文案限制到有 Custom relay 的配置。随后规定所有连接器从租约构造
Custom relay（含必要 server_id/capability），并做“只拿卡片→join→读 lease→检查
SDK relay mode/url，不是 N0Default”的端到端 Scenario；服务端 relay disabled、null、
错误 scheme 各补失败断言。

#### R3-P1-3：短码 canonical 规则仍互相矛盾，IPv6 结果字符串可能不可连接

design §3.1 / hub delta 同时写了“歧义字符 `o→0、i/l→1` 按 Crockford 映射”和
“非规范等价串不接受”。若 decoder 真接受这些字符，`o0...`、`l1...` 是同一 payload
的非规范等价串；若为满足后句拒绝，则前句的映射没有 wire 语义。另“解码忽略连字符”
允许任意插入/删除分组连字符，和 canonical 分组拒绝也未区分。IPv6 接收端只写
`http://<ip>:<port>`（design §3.1/hub delta），没有冻结必须生成
`http://[<ip>]:<port>`，按字面会得到无效 URL。

可验证修复：二选一并写入 decoder：①严格 canonical 模式只接受小写 canonical
字符和固定分组，任何歧义字符/非标准连字符/大小写均拒绝；②明确人类输入归一化，
归一化后必须重新编码并与输入 canonical 串比对，接受范围、显示范围和测试向量分开。
同时冻结 IPv6 bracketed URL、连字符位置、大小写和 `dwebh1.` 前缀解析；补
V2→`http://[fd00::13]:8787` 的断言以及每种歧义/连字符变体的正负测试。

#### R3-P1-4：tray JSON-RPC error golden 帧不是完整 JSON-RPC 2.0 wire

`specs/packaging/tray-plugin/spec.md:9-24` 和 design §6 宣称 JSON-RPC 2.0，但
notification、超长帧、parse error 的示例响应分别是
`{"id":null,"error":...}`，缺少响应必需的 `"jsonrpc":"2.0"`；只有成功帧带有该
字段。壳侧按 JSON-RPC 2.0 校验时会拒绝这些错误帧，违反“golden frame 冻结”和
坏帧后继续服务的互操作承诺。

可验证修复：所有响应（包括 `-32600/-32601/-32700`）统一冻结完整 envelope
`{"jsonrpc":"2.0","id":...,"error":{"code":...,"message":...}}`，明确
错误 id 提取是语法解析前的受限策略而非任意 JSON 执行；batch 拒绝也给出逐行
完整样例。契约测试用严格 JSON-RPC 2.0 validator 对每帧校验，并保留坏帧后正常
请求成功和 EOF 退出断言。

### P2

#### R3-P2-1：v3 声称 PM/proposal 同步，但旧叙述仍可导向错误实现

`proposal.md:24-29` 仍写“我的服务器/我的服务商”和 `registration.json`；实际
设计/spec 已冻结“我的中枢/我的租约/我的到访”和 `leases.json`。同时
`PRODUCT-DESIGN.md:62` 仍标“组 B 命名，§1.6 待拍板”，而文档顶部和 §1.6 已写
`[H7] 已拍板`。这会让实现者从 proposal 或 PM 表格走回旧分流/旧存储。

可验证修复：proposal What Changes、PRODUCT-DESIGN 视角表及所有事实基线统一到
v1.2 名称与 leases.json；删除“待拍板”残留（保留 O-3..O-10/G-2..G-5 的明确
默认建议状态即可），跑 `rg -n '待 Owner 拍板|请 Owner 确认|待拍板|registration\\.json'
openspec/changes/home-hub` 作为门禁并审阅命中。

#### R3-P2-2：G-3 relay-only 对照和降级没有客观封存条件

§7 说 relay-only 对照“必需尝试”，失败即可写环境限制并继续使用“依网络环境”文案；
没有尝试次数、网络拓扑 receipt、最迟交付日期、谁批准降级或 `docs/acceptance-*.md`
的最小字段。这样实现期很容易把“未测到”误报为“自动恢复”。

可验证修复：冻结 acceptance 记录模板（环境/镜像拓扑/命令/时间窗口/原始日志摘要/
结论），规定至少一次可复现实验和失败时限；只有记录 `NOT-EXECUTABLE` 才能降级，且
PM/发布清单必须引用该记录，不得将设计级 G-3 句子标成已断言。

#### R3-P2-3：自启路径的 shell quoting 与实际生命周期仍只有文本快照

macOS/Windows 的绝对路径元组已冻结，但 Windows `.cmd` 的空格/引号、`%`/`&` 等
路径转义和 LaunchAgent `ProgramArguments` 序列化没有规范；§1.4 仍把真实登录/重启/
stop 不复活留给实现期 acceptance。设计层可接受分层，但必须补 path-with-spaces、
非 ASCII 用户目录和失败后 hub.json 不更新的确定性 Scenario，避免生成物快照通过而
实际服务启动失败。

#### R3-P2-4：createConsole 会话 capability 只写“随机一次性”，没有可验证边界

`urlFor` 可携带 capability，但没有冻结熵/编码、绑定 sidecar 实例、过期时间、消费
端点、重放响应、日志/referrer 清理或 close 后失效。当前基线 pairing code 只存在终端，
不能直接作为 URL capability 的完整安全契约。

可验证修复：定义 capability v1（例如最小 128-bit CSPRNG、sidecar 实例绑定、单次
消费、明确 TTL、close/重启立即失效、拒绝 query 日志和 referrer），并给重复打开、
重放、跨实例、过期和 token 不出面的 Scenario。

## 5. [H0]-[H7] 与基线终判

### Owner 裁决覆盖

| 输入 | 设计机制 | Spec 承载终判 |
|---|---|---|
| [H0] 家庭点对点初衷 | hub 包装层、数据面零改动、G-3 条件化 | **不充分**：普通 join 尚未证明实际 Custom relay；停机行为虽有 Scenario，无法覆盖缺失 relay/null。 |
| [H1] 朴素地址/二维码/短码/手动地址 | 三形态卡片、offline wire、join 直收 | **部分**：向量已真实算对，但 canonical/IPv6 URL 规则仍有矛盾。 |
| [H2] tray 插件 | 可选无头包、心跳、stdout/IPC | **部分**：状态与双模式齐全，error response wire 不是完整 JSON-RPC。 |
| [H3] 寻址/回退/门禁、不默认启动 | hub init、restricted、用户级自启、负向探针 | **基本有承载**：默认不启动 Scenario 已补；admin token 装配缺口影响可运行性。 |
| [H4] webui plugin+SDK | core/薄壳、createConsole、hub open | **部分**：入口文案和注入 opener 已有，hub admin 面因 R3-P1-1 未真正建立。 |
| [H5] 三视角 | 分流表、leases/visits 台账、member 安全面 | **基本有承载**：初始化 admin 可达性仍依赖 token 注入。 |
| [H6] 机器名 alias | join 自报/本地快照/既有 alias 实现 | **有承载**：未见 v3 反向修改 server-access-roles 首写语义。 |
| [H7] G-1/O-1/O-2 | leases.json、组 B 命名、hub 命令族 | **基本有承载**：proposal/PM 旧词残留属一致性 P2。 |

### server-access-roles / webui-console 冻结面

- 三角色、邀请码、敲门、admin 路由、renew 顺延 `max(now, expires_at)`、
  `first_registered_at` 和 H6 alias 未被 home-hub 直接推翻。
- home-hub 对“无 `--server` 默认 setup”的变更被明确限定为五行分流：显式
  `--server` 和零本地数据仍走基线；hub.json 本机行、member 行和 `--setup` 均有
  supersedes 文字，范围可接受。
- home-hub 新写路由要求 Origin 存在且匹配，旧 `guardLocalOrigin` 对缺失 Origin
  放行；delta 已声明这是 probe/label 的局部更严规则，不应套到基线 `/api`/配对面。
- member `/admin/*` 404、connect/nodes 403 和无上游出站属于新增本地态边界；实现
  必须保留基线 `/api/* → /admin/*` 命名及显式 admin 行为。

### r1 §5 十条不可回退基线终判

| # | 基线 | r3 终判 |
|---|---|---|
| 1 | 显式启用，不默认常驻 | **满足（设计面）**：全新 DWEB_HOME 全命令/登录/重启负向 Scenario。 |
| 2 | restricted、凭证 0600、不进输出/卡片/浏览器/tray | **部分满足**：0600/不出面写清；server admin 注入未写，URL capability 边界也不完整。 |
| 3 | 单一 data_dir、旧进程退出、迁移不破坏名册 | **部分满足**：data_dir 注入/核实和接管规则闭合；relay/admin 运行链仍不能证明完整启动。 |
| 4 | detached/foreground/autostart owner、PID、stop、恢复唯一 | **基本满足（设计面）**：三宿主 owner/PID 三元组明确；真实服务生命周期未运行。 |
| 5 | 平台执行路径可复现，安装失败不假成功 | **基本满足（设计面）**：darwin+win 绝对路径和失败语义已写；Windows quoting/真实重启留 P2 acceptance。 |
| 6 | 本地账本无丢写且 renew/registered_at 保基线 | **满足（设计面）**：锁内重读/合并、registered_at 首次、expires_at 本地快照均冻结；relay_url null 需补。 |
| 7 | member sidecar 非 admin/setup，回环外有守卫 | **基本满足（设计面）**：member 404/403/Origin 矩阵已写；本机 admin 面仍依赖 R3-P1-1。 |
| 8 | 短码 wire 一次冻结且有真实 decode 端 | **未满足**：golden 数值正确，但 canonical 规则和 IPv6 URL 仍可产生不同实现。 |
| 9 | tray 消费稳定版本化 SDK/IPC | **未满足**：schema/模式稳定，error golden 缺 `jsonrpc`，不可直接互操作。 |
| 10 | G-3 只宣传已证明条件，Rust 仅 test-only | **部分满足**：Rust 范围仍 test-only 且条件化；Custom 入网未闭，relay-only 降级证据格式未冻结。 |

**实现前放行条件**：先关闭 R3-P1-1 至 R3-P1-4；同步 R3-P2-1 的旧叙述；冻结
relay null/disabled 行为、capability v1 和 G-3 acceptance receipt。完成后再重新
运行 strict validation，并在实现期按十条基线逐项留下真实 CLI/WebUI/宿主/G-3 证据。
