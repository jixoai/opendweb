# home-hub 设计层复审 r7

评审基点：`HEAD 510d2fd02b0fc9ad4c20f1703c2c63f82d916abd`（2026-09-23）。  
对照基点：r6 报告 `docs/codex-review-hh-r6.md`（`0481503`，NOT-READY 7.8/10）。  
范围：home-hub requirements、proposal、PRODUCT-DESIGN、design、四份 delta；叠加
server-access-roles/webui-console 冻结面，并核对 CLI、client SDK、fabric、server
真实实现。除本报告外未修改仓库文件。

## 1. 结论与评分

结论：**NOT-READY，7.8/10（较 r6 +0.0）**。

r6 的唯一 P1（把 `attach` 放进 root-only capability 时序）已由 v7 正确收窄：home-hub
租约消费只允许 `createRoot` 或打开既有 root，SDK 原有 invite/attach member 路径被明确
排除。可是逐着注册数据流和 SDK roster 实现核验后，发现新的主路径缺口：注册租约的
`(fabric_id, root)` 与 `createRoot` 实际使用的 roster `(fabric_id, root)` 没有同源
或相等断言。当前 CLI 会独立生成/复用 `fabric_id`，而 SDK `Roster::create` 独立随机
生成 fabric id；`ensureRelayCapabilities` 又用 roster 的 fabric id 签票。restricted
relay 的 L1b 对 `(fabric_id, issuer)` 精确匹配，因此按现有事实实现可能在首次拨号前得到
合法签名但被服务端判为 unknown owner。这个问题不是实现期测试细节，而是 v7 端到端
“注册后实际握手成功”所依赖的设计契约缺失，故仍不能 GO。

| 维度 | r6 | r7 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.7 | 8.7 | [H0]-[H7] 仍有设计映射；入网 tuple 连续性尚未冻结。 |
| 基线契约与 supersedes | 8.2 | 8.2 | 未见新的反向覆盖；server-access-roles 二元组校验反而暴露了缺口。 |
| 三方一致性 | 8.0 | 7.8 | root 时序已一致，但注册字段和 SDK roster 来源未对齐。 |
| 技术可实现性 | 6.9 | 6.8 | root-only 顺序可执行；正常注册到 root roster 的身份链仍可能断裂。 |
| Spec 可测性 | 8.1 | 8.0 | 顺序 Scenario 完整，缺 `(fabric_id, root)` 连续性正/负 Scenario。 |

## 2. 验证证据

### 实际阅读

- `openspec/changes/home-hub/{requirements,proposal,PRODUCT-DESIGN,design}.md`
- `openspec/changes/home-hub/specs/cli/{hub,leases}/spec.md`
- `openspec/changes/home-hub/specs/webui/spec.md`
- `openspec/changes/home-hub/specs/packaging/tray-plugin/spec.md`
- `docs/codex-review-hh-r6.md`、v7 提交及 `git log`
- `openspec/changes/server-access-roles/specs/server/spec.md` 与相关冻结面
- `packages/opendweb/src/join.mjs`
- `packages/client-sdk/src/fabric.rs`
- `crates/dweb-fabric/src/fabric.rs`、`crates/dweb-fabric/src/roster.rs`

### 实际命令与结果

- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- `git diff --check 0481503..HEAD -- openspec/changes/home-hub/design.md openspec/changes/home-hub/specs/cli/leases/spec.md openspec/changes/home-hub/PRODUCT-DESIGN.md`：通过。
- `git log --oneline --decorate -8`：确认 HEAD 为 `510d2fd`，其父提交为 v6 `0481503`。
- `git status --short --untracked-files=all`（报告创建前）：干净。

### 关键实现事实

- home-hub v7 在 `design.md:160-177`、leases delta `spec.md:7,16` 中限定
  `createRoot/open`、显式 `await ensureRelayCapabilities()`、同实例 RelayMap 注入、
  首次拨号前完成，并把 `attach` 作为 SDK 既有 member 机制排除。
- `packages/opendweb/src/join.mjs:283-303` 的 `selectFabricId` 在无显式/旧注册值时
  用 OS CSPRNG 独立生成 `fabric_id`；`join.mjs:335-348` 再用设备 seed 计算 root 并把
  这两个值送入 `/register`。
- `crates/dweb-fabric/src/fabric.rs:1717-1731` 的 `create_root` 调用
  `Roster::create`；`crates/dweb-fabric/src/roster.rs:204-221` 明确每次创建
  `FabricId::random()`，没有接收 CLI 已注册的 fabric id。
- `crates/dweb-fabric/src/fabric.rs:2282-2308` 的
  `ensure_relay_capabilities` 用 roster 的 `fabric_id` 和当前 root endpoint 签发
  capability，而不是读取 leases 中的 `fabric_id`。
- `server-access-roles/specs/server/spec.md:77-79` 将 L1b 冻结为
  `(fabric_id, issuer) ∈ owner registry`；其 `:37-40` Scenario 明确 fabric 不同即
  `dweb/unknown-owner`。因此“root 身份相同”不能替代 fabric id 相同。

本轮没有执行完整 npm/Rust 测试、真实 restricted relay 握手、G-3 300 秒对拍、双平台
自启 acceptance 或真实账户 sidecar 验收；它们仍是实现期义务，不能冒充设计层证据。

## 3. r6 与 r5 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R6-P1-1 attach 非 root 必败 | **闭合** | v7 在 design §2.1 和 leases delta 明确租约消费只允许 `createRoot` 或既有 root `open`；`attach/invite` 保留为 SDK 既有 member 机制，不再被要求调用 root-only ensure。 |
| r5 P2-1 preflight 选择语义 | **闭合** | “至少一条可用 relay”；零条失败，多候选按 manifest 顺序取第一条合法者。 |
| r5 P2-2 PM [H7] 证据范围 | **闭合** | PRODUCT-DESIGN/处置记录均为 `[H1]-[H7]`。 |

## 4. 新问题清单

### P0

无。

### P1

#### R7-P1-1：注册租约 tuple 与 SDK root roster 不保证同源

**证据链**：

1. home-hub 租约键和 relay 票据消费都依赖 `(fabric_id, root)`；v7 只写“设备以本机
   key 为自己 fabric 的 root”，没有规定 `lease.fabric_id == Fabric.fabric_id_hex()`
   和 `lease.root == Fabric.endpoint_id()` 的来源、存储及启动复核。
2. 当前 `join` 先在 JS 中独立选择 `fabric_id`（显式、旧 registration 复用或随机），再
   用设备 key 产生 `root` 并注册（`join.mjs:283-303,335-348`）。
3. SDK `createRoot` 通过 `Roster::create` 随机产生另一个 fabric id
   (`fabric.rs:1717-1731`; `roster.rs:204-221`)。除非 home-hub 额外先初始化/打开这个
   roster 并把其结果用于 register，否则两个值没有相等保证。
4. `ensureRelayCapabilities` 对 SDK roster fabric id 签票
   (`fabric.rs:2297-2308`)，而 restricted server 只接受 registry 中精确的
   `(fabric_id, issuer)` (`server/spec.md:77-79`)。结果可以是：register 远端 owner 成功、
   本地租约落盘成功、票据密码学有效且 root 正确，但 relay 因 fabric id 不同返回
   `dweb/unknown-owner`。v7 当前 Scenario 没有覆盖这个负向/正向连续性断言。

**可验证修复建议**（必须写入 design、leases delta 和端到端 Scenario）：

- 冻结唯一数据源：首次消费前先以与 register 相同的设备 seed 创建 root roster，读取
  SDK 实际 `fabric_id_hex()` 与 `endpoint_id()`；register body 和最终 lease 必须使用这
  两个值，而不是另行随机 fabric id。若 roster 已存在，只允许 `open` 同一 roster。
- 明确 identity seed、roster/data_dir 与租约 tuple 的复用规则；重试、重启、换 server
  均不得静默生成第二个 roster 或第二个 seed。
- 在首次 relay 拨号前断言
  `Fabric.fabric_id_hex() == lease.fabric_id`、`Fabric.endpoint_id() == lease.root`，
  并断言 capability 的 `(fabric_id, issuer, server_id)` 覆盖租约；任一不符、旧 roster、
  不同 seed 或 server/url 不匹配都 fail-closed，不写/不更新 leases。
- 增加两组可测 Scenario：fresh `createRoot`→register→ensure→restricted handshake
  成功；以及人为修改 lease fabric、使用另一 data_dir/seed 或 stale roster 时在首次拨号
  前拒绝并保持账本不变。实现不得把“实际 restricted 握手”留作唯一发现手段。

### P2

#### R7-P2-1：Scenario 只写 createRoot，未覆盖允许的 open root

design §2.1 允许 `createRoot（或 open 既有 root）`，但 leases delta Scenario 仍写
“以 createRoot root 身份”。建议统一成“root-capable `createRoot/open`”，并分别断言
fresh 与 reopen 两条路径，避免实现把 `open` 错当成非承诺分支。

#### R7-P2-2：attach 拒绝措辞可能被误读为 SDK 全局禁用

leases delta Scenario 的“attach 形态/未调用/不匹配=连接 fail-closed”应限定为
“attach 在 home-hub 租约消费时序中禁止/拒绝”；旁边已写的 SDK 既有
bootstrap/OK2 member 机制必须保持可用。这样不会把 v7 的局部 supersedes 误扩展到
server-access-roles 的成员入网契约。

## 5. H0-H7 与基线契约终判

### Owner 裁决覆盖

| 裁决 | 设计机制 | 终判 |
|---|---|---|
| H0 | hub 包装层、数据面零改动、Custom relay 入网、条件化 G-3 | **部分**：root/member 分支已收窄，但注册 tuple 连续性未定义。 |
| H1 | 二维码/短码/手动地址、离线短码、V1/V2 vectors | 满足设计承载；实现对拍待交付。 |
| H2 | 可选 tray 插件、心跳、双 IPC 模式 | 满足设计承载；真实壳 acceptance 待交付。 |
| H3 | 显式 init、restricted、两平台自启、默认不启动 | 满足设计承载；平台 acceptance 待交付。 |
| H4 | core/薄壳、createConsole、注入 opener、hub open | 满足设计承载；真实 sidecar/browser acceptance 待交付。 |
| H5 | 三视角切换、member 分流、leases/visits 隔离 | 满足设计承载，未见新 supersedes 冲突。 |
| H6 | hostname alias 消费，不改 server-access-roles 首写/续期语义 | 满足。 |
| H7 | leases.json 0..N、组 B 命名、`opendweb hub` 族 | 满足设计与 delta。 |

### server-access-roles / webui-console 冻结面

未发现 v7 新增的基线反向 supersedes。三角色、邀请码、敲门、`/admin/*` Bearer、renew
顺延、`first_registered_at`、H6 alias 和 member sidecar 的 404/403/no-upstream 边界
仍保持。新增风险是 home-hub 票据的 fabric id 可能不命中该基线明确要求的 owner 二元组，
不是对基线规则的放宽。

## 6. r1 十条不可回退基线终判

| # | 基线 | r7 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 保留。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：root 签发顺序已冻结，但 lease tuple 与签票 roster 的连续性未冻结；需通过 R7-P1-1 和真实 restricted handshake。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；实现对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL / BLOCKED**：G-3 依赖有效 root owner tuple，且本轮未执行 300 秒对拍。 |

## 7. 设计层结论与实现期义务

设计层当前仍为 **NOT-READY 7.8/10**。v7 已经闭合 r6 的 attach/root 语义矛盾，但在
进入实现前必须补齐 R7-P1-1：注册、租约、roster、capability 四处必须共享同一个
`(fabric_id, root, server_id)` tuple。修复并经严格校验后，若没有新的 P0/P1，可按 r6/r5
路径转为设计层 GO；这不等同于实现已通过。

实现期义务清单（也是基线 2/10 的 CONDITIONAL 转正条件）：

1. 实现 fresh `createRoot` 与 reopen `open` 两条 root 路径，证明其 roster tuple 与
   register/lease 完全相同；任何 stale/mismatch 在首次拨号前 fail-closed。
2. 实际验证 `ensureRelayCapabilities` 在首次拨号前执行、返回条目覆盖 lease、token
   注入同一 Fabric RelayMap，且 restricted relay 对有效票成功、无票和跨 server 票拒绝。
3. 验证 relay disabled/null/非法 URL 的 preflight fail-closed、不发 register 或明确
   远端已登记的补偿状态；并验证 leases 锁并发、迁移和 label 写路由。
4. G-3 test-only 对拍：先证 Direct；停整个 server/hub 进程、保持 300s 窗口、停机期
   新 join 失败、重启后自动恢复；relay-only 对照不可行时提交六字段 NOT-EXECUTABLE
   记录和“依网络环境”时限文案。
5. 两平台自启/stop 联动、sidecar capability/RPC golden、短码 CLI/webui 对拍、tray
   宿主 acceptance 与真实账户 `docs/acceptance-*.md` 记录均需作为发布证据。

