# home-hub 设计层复审 r5

评审基点：`HEAD a49dff91ba87ef566ba0c8703c91d5021d3022d7`（2026-09-23）。
对照基点：r4 报告 `docs/codex-review-hh-r4.md`（`1f3d448`，NOT-READY 7.5/10）。
范围：home-hub 的 requirements、proposal、PRODUCT-DESIGN、design、四份 delta；叠加
server-access-roles/webui-console 冻结面，并核对 SDK、server、server-binary、join、
webui 的真实实现。除本报告外未修改仓库文件。

## 1. 结论与评分

结论：**NOT-READY，7.8/10（较 r4 +0.3）**。

v5 已真实补齐 r4 发现的消费数据形态：租约消费者改用
`relays:[{url,serverId}]`，并把 restricted relay 的握手、无票拒绝、跨 server
拒绝写入 Scenario；preflight、短码接受集和 tray batch 也都有新增承载。可是
现有 SDK 的 `CustomWithCaps` 构造不会自动签发 own capability，签发是显式的
`ensure_relay_capabilities()` 调用，而 home-hub 没有冻结“Fabric 创建后、首次
connect/join 前必须调用，失败即 fail-closed”的时序。因此在实现者只按配置构造
并直接连接时，默认 restricted 中枢仍会得到 `dweb/no-capability`。这仍是家庭
接入主路径阻断，不能给无条件设计层 GO。

| 维度 | r4 | r5 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.5 | 8.7 | [H0]-[H7] 均有映射；[H0] 仍受 capability 生命周期缺口影响。 |
| 基线契约与 supersedes | 8.0 | 8.2 | 未见新的反向 supersedes；旧范围文字仍有一处文档漂移。 |
| 三方一致性 | 7.8 | 8.1 | relays 形态和 batch/canonical 已同步；capability 调用时序未同步。 |
| 技术可实现性 | 7.0 | 7.3 | 数据契约正确，但显式自签未被消费链强制。 |
| Spec 可测性 | 7.8 | 8.0 | 新增端到端 Scenario；preflight 选择语义仍自相矛盾。 |

增分来自 r4 P2 的实质收口和 `CustomWithCaps` 数据形态修正；扣分来自显式签发
时序仍会让 restricted 主路径在合理实现下失败，而不是实现期纯验收差异。

## 2. 验证证据

### 实际阅读

- `openspec/changes/home-hub/{requirements,proposal,PRODUCT-DESIGN,design}.md`
- `openspec/changes/home-hub/specs/cli/hub/spec.md`
- `openspec/changes/home-hub/specs/cli/leases/spec.md`
- `openspec/changes/home-hub/specs/webui/spec.md`
- `openspec/changes/home-hub/specs/packaging/tray-plugin/spec.md`
- `docs/codex-review-hh-r4.md`、`git log --oneline -8`
- `openspec/changes/server-access-roles/specs/server/spec.md` 及其设计/冻结面
- `packages/client-sdk/src/fabric.rs`
- `crates/dweb-fabric/src/fabric.rs`
- `crates/dweb-server/src/relay.rs`、`crates/dweb-server/src/main.rs`
- `packages/opendweb/src/join.mjs`、`packages/server-binary/index.js`

### 实际命令与结果

- `git rev-parse HEAD`：`a49dff91ba87ef566ba0c8703c91d5021d3022d7`。
- `git status --short --untracked-files=all`：创建报告前工作树干净。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- `git diff --check 1f3d448..HEAD`：通过。
- `rg` 复核 capability、旧词、systemd、batch、preflight 和 H0-H7 范围；未见
  “待 Owner 拍板/请 Owner 确认”残留。`registration.json`/systemd 的命中均位于
  迁移、现状事实或 Linux 后续 change 说明；但 PRODUCT-DESIGN 证据基线仍有一处
  `[H0]-[H6]`，见 R5-P2-2。

### 关键实现事实

- `packages/client-sdk/src/fabric.rs:205-216`：`relays` 才映射为
  `RelayConfig::CustomWithCaps`；`urls` 仍是无凭证 `Custom`。
- `crates/dweb-fabric/src/fabric.rs:1858-1870`：`CustomWithCaps` 构造只注入
  静态 token 和已持久化 token，注释明确 own capability 由
  `ensure_relay_capabilities` 显式签发，构造期不隐式执行。
- `crates/dweb-fabric/src/fabric.rs:2273-2282`：
  `ensure_relay_capabilities()` 是 public async API，且 root-only；成功后才把
  自签 token 注入共享 RelayMap。
- `crates/dweb-fabric/src/fabric.rs:1736-1752,1754-1772`：`open`/`attach` 直接
  进入 `start`，未自动调用上述方法；本轮在 home-hub 设计和 delta 中也未找到
  调用顺序或失败门冻结。
- `crates/dweb-server/src/relay.rs:134-155` 和 server-access-roles server spec：
  restricted relay 的 AccessGate 会校验 capability，无票拒绝不是假设。

本轮未运行完整 npm/Rust 测试、真实 restricted relay 握手、G-3 300 秒停机对拍、
LaunchAgent/Windows 登录生命周期或真实账户 acceptance；这些只能作为实现期义务，
不能冒充设计层证据。

## 3. r4 问题闭合度

| r4 编号 | 结论 | 当前核验 |
|---|---|---|
| P1-1 relay 凭证消费 | **部分闭合，转为 R5-P1-1** | `relays:[{url,serverId}]`、CustomWithCaps、restricted/无票/跨 server Scenario 均已写；但显式 `ensure_relay_capabilities()` 的调用时序、失败处理和“token 已在同一 RelayMap 后再 connect”没有写死。 |
| P2-1 join preflight | **机制已写，新增语义冲突 R5-P2-1** | register 前校验、URL 约束、register 后复核、补偿路径和负向 Scenario 均在；“要求恰一可用 relay”与“多候选取第一条合法者继续”不可能同时按字面成立。 |
| P2-2 PM H0-H7 范围 | **主要闭合，残余 R5-P2-2** | PRODUCT-DESIGN 决策句和附录已为 `[H0]-[H7]`；同文件证据基线第 16 行仍写 `[H0]-[H6]`，会让读者误解 H7 不在 Owner 输入范围。 |
| P2-3 短码 canonical | **闭合** | `encode_canonical`/`decode_accepts` 两集合、大小写、三种分组形态、歧义字符、padding、错位/重复和表格正负例已同步。 |
| P2-4 tray batch | **闭合** | batch 完整 request/response golden、整帧 `-32600`、拒绝后继续下一帧，以及严格 JSON-RPC validator 义务均已写。 |

## 4. 新问题

### P0

无。

### P1

#### R5-P1-1：CustomWithCaps 的 capability 签发/注入时序未冻结

证据链：

1. home-hub design §2.1 和 leases delta 已正确要求
   `FabricOptions.relay={mode:"custom",relays:[{url,serverId}]}`，并称 root 据
   `serverId` 自签 capability。
2. 现有 SDK 的 CustomWithCaps 构造（`crates/dweb-fabric/src/fabric.rs:1858-1870`）
   明确只读取静态/持久化 token；own capability 要由显式
   `ensure_relay_capabilities()`（`2273-2320`）生成并注入 RelayMap。
3. `open`、`attach` 和 SDK `Fabric` 构造路径没有自动调用它；home-hub 设计没有
   规定 join/lease consumer 的调用点、调用失败行为或调用后必须使用同一 Fabric
   实例连接。

可验证修复：在 leases consumer Requirement 和端到端 Scenario 中冻结以下顺序：

`createRoot/open/attach(CustomWithCaps)` → `await ensureRelayCapabilities()` →
断言返回条目覆盖租约 `relay_url/server_id` 且 token 已注入该实例的 RelayMap →
才允许任何 `join/connect`；签发失败、非 root、server_id/URL 不匹配或 token
未出现时 MUST fail-closed，且不得写租约。Scenario 应用受限 relay 实际握手验证
“调用发生在首次拨号之前”，并保留无票、跨 server capability 的负向断言。这样才
能证明 v5 的数据契约确实闭合默认 restricted 主路径。

### P2

#### R5-P2-1：preflight 的“恰一”与“第一条合法者”冲突

`design.md:173-176` 和 leases delta 第 7 行写“要求恰一可用 relay”，随后又写
“多候选按 manifest 顺序取第一条合法者”；Scenario 第 21 行进一步规定重复条目
取第一条合法者并继续。多个合法候选显然不满足“恰一”。

可验证修复：二选一并在 design、delta、Scenario、测试表统一：

- 将规则改成“至少一条合法 relay，按 manifest 顺序取第一条”；或
- 保留“恰一”，并规定出现第二条合法候选/重复条目即 preflight 失败、不得 register。

#### R5-P2-2：PRODUCT-DESIGN 证据基线仍漏 H7

`openspec/changes/home-hub/PRODUCT-DESIGN.md:16` 仍写 Owner 裁决范围
`requirements.md ([H0]-[H6])`，而同文件第 3-8 行和附录已经写 `[H0]-[H7]`，
`requirements.md` 第 90-102 行明确 H7 已拍板。该句虽不改变运行行为，却破坏设计
文档内部的一致性并可能误导后续评审。

可验证修复：将该证据基线改为 `[H0]-[H7]`，或明确标注它是 H7 补充前的历史快照；
建议加入 rg 门禁，禁止非历史处置表中出现过时范围。

## 5. H0-H7 与基线契约终判

### Owner 裁决覆盖

| 裁决 | 设计机制 | 终判 |
|---|---|---|
| H0 | hub 包装层、数据面零改动、Custom relay 入网、条件化 G-3 | **部分**：restricted capability 的显式签发顺序未冻结。 |
| H1 | 二维码/短码/手动地址、离线短码、V1/V2 golden vectors | 满足设计承载。 |
| H2 | 可选 `opendweb tray` 插件、心跳、双 IPC 模式 | 满足设计承载；真实壳 acceptance 待实现。 |
| H3 | 显式 init、restricted、两平台自启、默认不启动 | 满足设计承载。 |
| H4 | core/薄壳、createConsole、注入 opener、hub open | 满足设计承载；真实浏览器/sidecar acceptance 待实现。 |
| H5 | 三视角切换、member 分流、leases/visits 隔离 | 满足设计承载，未见新 supersedes 冲突。 |
| H6 | hostname alias 消费，不改 server-access-roles 首写/续期语义 | 满足，未发现反向覆盖。 |
| H7 | leases.json 0..N、组 B 命名、`opendweb hub` 族 | 满足设计与 delta；PRODUCT-DESIGN 仍有一处范围文字需修。 |

### server-access-roles / webui-console 冻结面

- 三角色、邀请码、敲门、`/admin/*` Bearer 认证、renew 的
  `max(now,current_expires_at)`、`first_registered_at`、H6 alias 均未被改写。
- member 态对 webui-console setup 的 supersedes 仍局限于五行分流；显式
  `--server`、零数据 setup、`--setup` 入口均保留。`/admin/*` 404、connect/nodes
  403、无上游出站和编码路径负向矩阵均有承载。
- 新增严格 Origin 仅约束 probe/label 写路由；没有把基线缺 Origin 的旧读/配对
  语义悄然改写。
- v5 没有新增未声明的 supersedes；其 relay 消费契约是对既有 SDK 配置形态的
  明确增补，但必须按 R5-P1-1 补齐调用时序。

## 6. r1 十条不可回退基线终判

| # | 基线 | r5 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 和平台错误路径均有。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：admin token 面已 PASS；CustomWithCaps token 签发顺序仍见 R5-P1-1。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**：hub.lock、人工确认、旧文件迁移/保留和唯一 data_dir 规则齐全。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**：同一 foreground 链、PID 三元组、服务自识别和 stop 联动均有。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**：锁内重读合并、原子 rename、registered_at 和本地快照语义齐全。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**：五行分流、四类 Origin 和 member 负向矩阵齐全。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；实现对拍待交付）**：向量、canonical 接受集和接收入口已闭合。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**：双模式、batch golden 和 error validator 已冻结。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL / BLOCKED**：六字段 acceptance 和降级条件齐全，但有效 G-3 依赖先修 R5-P1-1，并且本轮未执行 300 秒验收。 |

## 7. 设计层结论与实现期义务

设计层当前为 **NOT-READY 7.8/10**，不是实现期测试失败，而是 restricted relay
凭证生命周期还没有成为不可绕过的设计机制。修复 R5-P1-1 后，若不引入新的
P0/P1，设计层可转 GO；R5-P2-1/2 应同时清理以避免实现分叉。

实现期仍必须独立交付并记录：

1. restricted Custom relay 的真实握手、无票拒绝、跨 server capability 拒绝，且
   证明 `ensureRelayCapabilities` 发生在首次拨号前；
2. relay disabled/null/非法 URL 的 preflight fail-closed 和“未发 register”探针；
3. G-3 条件化 Rust test-only 对拍（停整个 server、Direct 300s、停机期新 join
   失败、重启恢复、relay-only 对照或六字段 NOT-EXECUTABLE 记录）；
4. 两平台自启真实账户生命周期、sidecar capability/RPC golden、短码跨 CLI/webui
   对拍及 acceptance 文档。

