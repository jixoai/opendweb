# home-hub 设计层复审 r4

评审基点：`HEAD 1f3d44889dbfd631f94ce3977532b6ce78786516`（2026-09-23）。
对照基点：r3 报告 `docs/codex-review-hh-r3.md`（`b2b960b`，NOT-READY 7.3/10）。
范围：`requirements.md`、`proposal.md`、`PRODUCT-DESIGN.md`、`design.md`、四份
delta；叠加 `server-access-roles`/`webui-console` 冻结面，并核对 CLI、webui、
server-binary、server 与 client-sdk 的真实实现。除本报告外未修改仓库文件。

## 1. 结论与评分

结论：**NOT-READY，7.5/10（较 r3 +0.2）**。

v4 真实闭合了 r3-P1-1 的 `DWEB_ADMIN_TOKEN` 注入与双探、r3-P1-3 的短码
canonical/IPv6 bracket、r3-P1-4 的 JSON-RPC error envelope；r3 的四个 P2 也都有
明确的设计承载。可是 r3-P1-2 只闭合了 `relay_url` 的 null/disabled 选择和“不回落
N0Default”的文字，没有闭合 **restricted relay 的凭证装配**：v4 明写的
`FabricOptions.relay={mode:"custom",urls:[relay_url]}` 对现有 SDK 是无凭证
`Custom`，而 home-hub 默认启动 restricted。按照既有 server-access-roles 契约，
成员连接会在 relay capability 校验处被拒，G-3 的家庭入网闭环仍不存在。因此不能
给设计层 GO。

| 维度 | r3 | r4 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.4 | 8.5 | [H0]-[H7] 均映射到章节；[H0] 仍受受限 relay 凭证缺口阻断。 |
| 基线契约与 supersedes | 7.6 | 8.0 | member/setup 例外范围已写清，未见 renew、first_registered_at、alias 反向覆盖。 |
| 三方一致性 | 7.1 | 7.8 | admin、短码、tray 已同步；relay 凭证和少量文档表述仍有漂移。 |
| 技术可实现性 | 6.8 | 7.0 | 四宿主环境和服务生成物收敛；restricted Custom relay 仍会失败。 |
| Spec 可测性 | 7.2 | 7.8 | 双探、canonical 变体、RPC validator、G-3 acceptance 模板均可测；relay 凭证缺少负向验收。 |

分数增加来自四条 r3 P1 的大部分文字闭合和更完整的 Scenario；未升至 GO 是因为
relay 缺口不是实现细节，而是默认安全模式下成员无法连接的主路径阻断。

## 2. 验证证据

### 实际阅读

- `openspec/changes/home-hub/{requirements,proposal,PRODUCT-DESIGN,design}.md`
- `openspec/changes/home-hub/specs/cli/hub/spec.md`
- `openspec/changes/home-hub/specs/cli/leases/spec.md`
- `openspec/changes/home-hub/specs/webui/spec.md`
- `openspec/changes/home-hub/specs/packaging/tray-plugin/spec.md`
- `docs/codex-review-hh-r1.md`、`docs/codex-review-hh-r3.md`、`git log`
- `openspec/changes/server-access-roles/specs/server/spec.md` 与其 webui 冻结面
- `crates/dweb-server/src/main.rs`、`crates/dweb-server/src/services.rs`
- `crates/dweb-server/src/relay.rs`、`crates/dweb-server/src/access/gate.rs`
- `packages/server-binary/index.js`
- `packages/opendweb/src/join.mjs`
- `packages/client-sdk/src/fabric.rs`
- `packages/webui/src/sidecar.mjs`

### 实际命令与结果

- `git status --short --untracked-files=all`（报告创建前）：干净；当前唯一新增文件为本报告。
- `git rev-parse HEAD`：`1f3d44889dbfd631f94ce3977532b6ce78786516`。
- `git log --oneline -8`：确认 `b2b960b` 为 v3、当前为 v4，r3 报告已存档。
- `git diff --stat b2b960b..HEAD`、`git diff --check b2b960b..HEAD`：仅报告存档与
  home-hub 设计/delta 文件；check 通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- 独立 CRC/Bit 编码计算：`"123456789" → 0x29B1`；V1 无分组体
  `070ag0gd499qnz8`，V2 无分组体 `0byg00000000000000000000009j4mz50r`，
  与 v4 文档向量一致。
- 未虚构实现期证据：没有运行完整 npm/Rust 测试、真实 LaunchAgent/Windows 登录
  生命周期、300 秒 G-3 或真实账户 acceptance；这些仍是实现交付义务。

### 关键事实

- `crates/dweb-server/src/main.rs:478-503`：只有非空 `DWEB_ADMIN_TOKEN` 才挂载
  `/admin/*`；v4 的唯一启动链已明确读取 hub-token 注入，并以无 token=401、带
  token=200 双探断言。
- `packages/server-binary/index.js:89-94`：子进程环境从父环境继承并覆盖 bind 变量，
  因而 v4 的链入口注入可到达 Rust server，且 token 不必进入 plist/argv。
- `crates/dweb-server/src/services.rs:266-308`：relay 条目可为 disabled/null，
  v4 的 fail-closed 分支针对了这一事实。
- `openspec/changes/server-access-roles/specs/server/spec.md:77-94`：restricted
  relay 需要通过 capability 校验，且 capability 绑定 server_id、issuer 与握手端点。
- `crates/dweb-server/src/relay.rs:134-155` 将握手交给 `AccessGate`，其无票静态
  路径的回归测试为 `dweb/no-capability`；这不是只存在于文档的假设。
- `packages/client-sdk/src/fabric.rs:24-58,177-225`：`urls` 形态是无凭证
  `Custom`；受限 relay 的 `serverId`/token 只出现在 `relays` 条目形态。v4 的
  `urls:[relay_url]` 因而不能满足默认 restricted 主路径。
- `packages/opendweb/src/join.mjs:395-450`：当前 join 仍在 register 后才读
  `/services.json`，v4 没有冻结 relay preflight 与远端副作用顺序。

## 3. r3 问题闭合度

| r3 编号 | 结论 | 当前核验 |
|---|---|---|
| P1-1 admin 注入 | **闭合** | design §1.3、hub delta 守护进程 Requirement/Scenario 已冻结子进程 `DWEB_ADMIN_TOKEN`、覆盖继承值、四宿主双探和失败清锁；与 `main.rs` 事实一致。 |
| P1-2 relay null/disabled | **部分闭合** | 选择规则、null/disabled fail-closed、不落租约已写入；但 `urls:[relay_url]` 没有 `serverId`/capability，restricted 默认下不能连接，见 R4-P1-1。 |
| P1-3 短码 canonical | **闭合（另有 P2 文案澄清）** | 9/21 字节、CRC 参数、MSB/padding、歧义字符拒绝、固定分组、大小写规则、IPv6 bracket、link-local 和变体 Scenario 均已同步；“大小写接受”与“非规范等价串一律拒绝”仍需术语澄清。 |
| P1-4 tray error wire | **闭合** | design §6 与 tray delta 的实际 error 帧均有 `jsonrpc:"2.0"`，并冻结严格 validator 和受限 id 前缀扫描。 |
| P2-1 proposal/PM 残留 | **基本闭合** | proposal/PM 主叙述已改为组 B、leases；requirements 原文、历史对照和当前事实的 `registration.json` 命中是可解释保留项；PRODUCT-DESIGN 头部仍有 H0-H6 过时范围，列为 R4-P2-2。 |
| P2-2 G-3 acceptance | **闭合（实现证据待交付）** | 六字段模板、`NOT-EXECUTABLE` 客观条件、至少一次可复现实验和发布清单引用义务已写入 §7。 |
| P2-3 quoting | **闭合（实现 acceptance 待交付）** | plist 数组/XML 转义、Windows `%`/`&`/空格/非 ASCII 路径和生成前包含性检查已冻结。 |
| P2-4 capability v1 | **闭合（实现 acceptance 待交付）** | ≥128-bit、实例绑定、单次消费、120s TTL、close/退出失效、403、日志/referrer 边界及 Scenario 已写。 |

## 4. 新问题

### P0

无。

### P1

#### R4-P1-1：restricted 中枢的 Custom relay 缺少 server 身份/凭证装配

证据链：

1. home-hub 的 `hub init` Requirement 明确要求 restricted 模式（hub delta §“一键变
   中枢” Scenario）；server-access-roles 的 restricted relay 规则要求 capability
   先过 server_id、issuer、recipient 和有效期校验（`specs/server/spec.md:77-94`）。
2. v4 design §2.1（约 149-153 行）以及 leases delta 写死的消费形态是
   `FabricOptions.relay={mode:"custom",urls:[relay_url]}`。
3. client SDK 的 `urls` 分支构造 `RelayConfig::Custom`（`fabric.rs:221-223`），
   `serverId` 只在 `relays:[{url,serverId|token}]` 分支产生受限凭证，且无凭证条目
   被定义为 credential-free（`fabric.rs:24-40`）。

因此 join 虽然能落 `relay_url`，成员从租约启动连接时仍没有 relay capability；默认
restricted 中枢会以 `dweb/no-capability` 拒绝 relay，G-3 的 relay-only 对照和借道
恢复也无法成立。这是主路径不可用，不是可推迟到实现细节的命名问题。

可验证修复：把消费契约改为使用租约中的 `server_id` 构造
`FabricOptions.relay={mode:"custom",relays:[{url:relay_url,serverId:server_id}]}`，
并冻结 root/member capability 的签发、落盘和刷新来源；或明确设计一条等价的现成
capability 注入路径。加入 restricted relay acceptance：注册后实际握手成功、无票
请求被拒、跨 server capability 被拒、relay mode 非 N0Default；同时在 malformed
server_id/URL 时于落租约前失败。

### P2

#### R4-P2-1：relay manifest 的有效性、重复选择和 join 副作用顺序未冻结

v4 只要求 `name==relay && enabled==true && url` 非 null；没有把空串、非 HTTP(S)、
重复 relay 条目、多个候选的选取规则写成 wire 约束。更重要的是当前 join 实现先
`POST /register`，之后才读 `/services.json`（`join.mjs:395-405`）；若按现有顺序实现，
relay disabled/null 会造成服务端已登记、客户端没有 leases 条目的半完成状态。

可验证修复：join 在 register 前完成 services preflight，要求恰一个可用 relay，
校验 URL scheme/authority/长度并固定重复条目策略；register 后再次核对 server_id 与
relay URL，任一步失败不写本地账本并明确记录远端已登记/补偿策略。补 disabled、null、
空串、错误 scheme、重复条目和 preflight 失败无远端 register 的 Scenario。

#### R4-P2-2：PRODUCT-DESIGN 头部的裁决范围仍漏写 H7

`PRODUCT-DESIGN.md:3-8` 已标 v1.2/[H7] 已拍板，但同一段仍写“一切产品决策以
requirements.md 的 [H0]-[H6] 为准”。设计 §0 和 requirements §90-102 已把 H7
作为正式拍板；该句会让读者误以为 leases/组 B/hub 命名仍是候选。

可验证修复：改为 `[H0]-[H7]`，并添加一个文档门禁断言 v1.2 头部的裁决范围与
`requirements.md` 最新 Owner 裁决编号一致。

#### R4-P2-3：短码 canonical 的“接受集”和“canonical 串”仍需拆开写

design §3.1 同时规定“大小写折叠、混合大小写接受”和“非规范等价串一律不接受”，
并说固定分组的连字符“整组可省略”，但没有明确是每个分组独立可省略还是只允许
全无/全有两种形态。实现者可能因此在大小写、部分连字符和 canonical 输出上分叉。

可验证修复：定义 `decode_accepts` 与 `encode_canonical` 两个集合：前者明确大小写
折叠和每个分隔符的可选性，后者固定为小写无连字符；补“混合大小写正例、全无/完整
分组正例、部分分组正例（若允许）、错位/重复分隔符负例”的表格测试。

#### R4-P2-4：tray batch 拒绝虽有 Scenario，缺少实际 error golden 帧

tray delta 要求 batch 收到即 `-32600`，但 golden 代码块只给 notification、超长和坏
JSON 的响应；对接壳无法从 golden 样例确认 batch 是单帧拒绝还是逐元素响应。

可验证修复：加入 `→ [{...}]` 与完整 `← {"jsonrpc":"2.0","id":null,"error":{"code":-32600,...}}`
样例，并在 validator 测试中断言拒绝后继续处理下一帧。

## 5. H0-H7 与基线契约终判

### Owner 裁决覆盖

| 裁决 | 设计机制 | 终判 |
|---|---|---|
| H0 | hub 包装层、数据面零改动、G-3 条件化、Custom relay 入网链 | **部分**：restricted 凭证缺口仍阻断家庭主路径。 |
| H1 | 三形态卡片、短码 wire、`join --server` 离线解码 | **基本满足**：短码规则可实现，canonical 文案需澄清。 |
| H2 | 可选 `opendweb tray` 插件、心跳、双 IPC 模式 | 满足（真实壳 acceptance 待实现）。 |
| H3 | 显式 init、restricted、两平台自启、默认不启动负向探针 | 满足设计承载。 |
| H4 | core/薄壳、createConsole、注入 opener、hub open | 满足设计承载；admin 双探已补。 |
| H5 | 三视角切换、member 分流、leases/visits 数据隔离 | 满足设计承载；member supersedes 范围明确。 |
| H6 | hostname alias 消费且不覆盖 server-access-roles 首写/续期语义 | 满足，未发现反向修改。 |
| H7 | leases.json 0..N、组 B 命名、`opendweb hub` 族 | 满足设计与 delta；产品文档头部需修正 H7 范围。 |

### server-access-roles / webui-console 冻结面

- 三角色、邀请码、敲门、`/admin/*` Bearer 认证、renew 的
  `max(now, current_expires_at)`、`first_registered_at` 和 H6 alias 未被 home-hub
  改写。
- webui 基线“无 `--server` 进入 setup”的改变被局部 supersedes 为五行分流；显式
  `--server`、零数据 setup 和 `--setup` 入口均保留，member 的 `/admin/*` 404、
  connect/nodes 403 和无上游出站有负向 Scenario。
- Origin 更严格策略只作用于新增 probe/label 写路由；设计明示没有改写基线读/配对
  面缺失 Origin 的既有语义。
- v4 未声明新的基线 supersedes；唯一尚需修正的是受限 relay 的凭证消费契约，
  它应作为 home-hub 对既有 SDK relay 配置的明确增补而不是隐式假设。

## 6. r1 十条不可回退基线终判

| # | 基线 | r4 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 与平台错误路径均有。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **PASS（设计）**：DWEB_ADMIN_TOKEN 注入优先级、双探、清锁和输出面边界已冻结。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**：hub.lock、人工确认、旧文件 `.migrated`/损坏保留。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**：同一 `--foreground` 链、PID 三元组、DWEB_HUB_SERVICE 和 stop 联动均有承载。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**：O_EXCL 锁内重读合并、rename、锁归属校验和 registered_at/快照语义齐全。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**：四类 Origin、未知 id、编码路径和无上游出站均有约束。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；P2 仅澄清接受集）**：向量和接收入口已闭合。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；batch golden 与真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL / BLOCKED**：六字段 acceptance 已规范化，但 restricted relay 凭证缺口必须先修，之后才能执行有效的 G-3 对拍。 |

## 7. 实现前结论

当前不得进入无条件实现 GO。先修 R4-P1-1，并把 restricted relay 的
`serverId`/capability 生命周期写入 leases consumer 与端到端 Scenario；同时处理
R4-P2-1 的 services preflight/URL 校验和文档、短码、batch 的澄清。完成后再复审：
若 Custom restricted relay 实际握手、null/disabled fail-closed、G-3 条件和十条基线
均有独立实现证据，可转为设计层 GO。
