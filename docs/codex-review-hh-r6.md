# home-hub 设计层复审 r6

评审基点：`HEAD 0481503e7b74284c4e52cfca94f78c136b702c0c`（2026-09-23）。
对照基点：r5 报告 `docs/codex-review-hh-r5.md`（`a49dff9`，NOT-READY 7.8/10）。
范围：home-hub requirements、proposal、PRODUCT-DESIGN、design、四份 delta；叠加
server-access-roles/webui-console 冻结面，并核对 client SDK、fabric、server、join
真实实现。除本报告外未修改仓库文件。

## 1. 结论与评分

结论：**NOT-READY，7.8/10（较 r5 +0.0）**。

v6 确实闭合了 r5 的两个 P2，并把 root 路径的 capability 顺序写成了可测的四步：
构造 `CustomWithCaps`、显式签发、同实例注入校验、首次拨号前才连接。然而该顺序
同时强制 `createRoot/open/attach`，而 SDK 的 `attach` 明确是“空名册、等待 join”
的非 root 起点；`ensure_relay_capabilities()` 又是 root-only。对 attach 的正常
成员入网，第二步必然 `NotRoot`，join 前不能按该序列完成；join 后身份仍是 member，
也不能调用 root-only own-capability 签发。这是新增的主路径设计矛盾，不能给设计层
GO。r5 的修复价值被该新 P1 抵消，故总分保持 7.8。

| 维度 | r5 | r6 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 8.7 | 8.7 | [H0]-[H7] 映射保持完整；入网分支仍未闭合。 |
| 基线契约与 supersedes | 8.2 | 8.2 | 未见新的反向 supersedes，H7 证据范围已补齐。 |
| 三方一致性 | 8.1 | 8.0 | root 顺序更清楚，但 `attach` 与 root-only API 发生直接冲突。 |
| 技术可实现性 | 7.3 | 6.9 | attach/member 正常路径按字面不可执行。 |
| Spec 可测性 | 8.0 | 8.1 | 顺序断言可测，但缺少 root/member 分支 Scenario。 |

## 2. 验证证据

### 实际阅读

- `openspec/changes/home-hub/{requirements,proposal,PRODUCT-DESIGN,design}.md`
- `openspec/changes/home-hub/specs/cli/{hub,leases}/spec.md`
- `openspec/changes/home-hub/specs/webui/spec.md`
- `openspec/changes/home-hub/specs/packaging/tray-plugin/spec.md`
- `docs/codex-review-hh-r5.md`、`git log --oneline -6`
- `openspec/changes/server-access-roles/specs/server/spec.md`
- `packages/client-sdk/src/fabric.rs`、`packages/client-sdk/index.d.ts`
- `crates/dweb-fabric/src/fabric.rs`、相关 relay/join 测试
- `packages/opendweb/src/join.mjs`

### 实际命令与结果

- `git rev-parse HEAD`：`0481503e7b74284c4e52cfca94f78c136b702c0c`。
- `git status --short --untracked-files=all`（报告创建前）：工作树干净。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：通过。
- `git diff --check a49dff9..HEAD -- openspec/changes/home-hub/{design.md,specs/cli/leases/spec.md,PRODUCT-DESIGN.md}`：通过。
  未对已归档的 r5 报告做回写；全量 diff 的唯一 whitespace 提示是该历史报告 EOF 空行。
- `rg` 复核 `ensureRelayCapabilities`、preflight、H0-H7 和 Owner 占位词：home-hub
  未留下 `[H0]-[H6]` 或“恰一可用 relay”旧措辞；`server-access-roles` 自身的
  “待 Owner 拍板”属于基线原文，不是 home-hub 残留。

### 关键实现事实

- `crates/dweb-fabric/src/fabric.rs:1754-1772`：`attach` 注释和实现都是空名册
  起步，等待 `join` 写入事实。
- `crates/dweb-fabric/src/fabric.rs:2282-2295`：
  `ensure_relay_capabilities()` 检查 `roster.root() == self`，否则返回
  `RosterError::NotRoot`；空名册和普通 member 均不满足。
- `packages/client-sdk/src/fabric.rs:450-490`：`Fabric.attach` 后调用 `join`；
  `joinWithToken` 同样先 attach 再兑换 token。
- `crates/dweb-fabric/src/fabric.rs:2593-2603`：非 root joiner 的正确初始路径是
  从邀请 token 注入 bootstrap capability；`2637-2647` 在 OK2 后保存/热注入
  member capability。
- `crates/dweb-fabric/src/fabric.rs:1858-1870`：CustomWithCaps 构造只加载静态/
  持久化 token，own capability 不自动签发；v6 对 root 路径的显式 ensure 文字与
  此事实一致。
- `packages/client-sdk/src/fabric.rs:214-216`：`relays` 映射为 CustomWithCaps，
  `urls` 仍是无凭证 Custom。

本轮未运行完整 npm/Rust 测试、真实 restricted relay 握手、G-3 300 秒对拍、双平台
自启 acceptance 或真实账户 sidecar 验收；这些仍属于实现期证据，不能冒充 GO 依据。

## 3. r5 问题闭合度

| r5 编号 | 结论 | 当前核验 |
|---|---|---|
| P1-1 capability 签发时序 | **部分闭合，转为 R6-P1-1** | root `createRoot/open` 路径的四步和 fail-closed 已冻结；但把同一步骤强制到 `attach`，与 SDK root-only/空名册事实冲突。 |
| P2-1 preflight 选择语义 | **闭合** | 已改为至少一条可用 relay；零条失败，多候选按 manifest 顺序取第一条合法者，且 delta 同步。 |
| P2-2 PM H7 证据范围 | **闭合** | PRODUCT-DESIGN 已明确 `[H1]-[H7]` 并注明 H7 三项拍板，附录和决策头部一致。 |

## 4. 新问题

### P0

无。

### P1

#### R6-P1-1：统一四步把 attach/member 路径置于必然 NotRoot 状态

证据链：

1. v6 design §2.1 和 leases delta 规定所有租约消费者都按
   `createRoot/open/attach → ensureRelayCapabilities → token 同实例注入 →
   join/connect`，并将 ensure 失败统一 fail-closed。
2. SDK `attach` 的契约是空 roster、随后 `join`（`packages/client-sdk/index.d.ts:46-56`；
   `crates/dweb-fabric/src/fabric.rs:1754-1772`）。空 roster 的 `root()` 为 None。
3. `ensure_relay_capabilities()` 明确要求调用者就是 roster root
   (`fabric.rs:2287-2295`)；正常 `attach → join` 后，调用者是被邀请的 member，
   root 仍是 issuer，不是调用者。现有测试也把 attach caller 的 ensure 断言为
   `requires root`（`packages/client-sdk/test/relay-relays.test.mjs:222-235`）。
4. SDK 已有的 member 入网机制是 join 前使用邀请内嵌 bootstrap capability，join
   成功后接收并持久化 member capability（`fabric.rs:2593-2603,2637-2647`），不是
   member 自签 own capability。

因此，按 v6 字面实现 attach 分支，第二步即失败；若把 ensure 延后到 join 后，仍会
因非 root 失败。该分支不能完成 home-hub 声称的 restricted relay 入网，属于 P1，
不是实现期测试细节。

可验证修复（二选一，必须在设计和 delta 明确）：

- 若 home-hub 只支持 `/register` 后本机作为 fabric root 的租约消费者：删除
  `attach` 作为该四步的可选构造器，限定为 `createRoot/open`，并在 Scenario 中
  明示 root 身份前提；或
- 若必须支持现有 SDK 的 invite/member attach：拆成两条状态机。attach 分支在
  首次 join 前要求 token 的 bootstrap capability 注入并完成 join，成功后只消费
  OK2 member capability；root 分支才调用 `ensureRelayCapabilities` 自签 own。
  两分支都要断言 server_id/relay_url 绑定、首次拨号使用同一实例 RelayMap，失败
  fail-closed，并各有一个端到端 Scenario。

### P2

无新的 P2。r5 两项 P2 已闭合。

## 5. H0-H7 与基线契约终判

### Owner 裁决覆盖

| 裁决 | 设计机制 | 终判 |
|---|---|---|
| H0 | hub 包装层、数据面零改动、Custom relay 入网、条件化 G-3 | **部分**：attach/member capability 分支仍未定义。 |
| H1 | 二维码/短码/手动地址、离线短码、V1/V2 golden vectors | 满足设计承载。 |
| H2 | 可选 `opendweb tray` 插件、心跳、双 IPC 模式 | 满足设计承载；真实壳 acceptance 待实现。 |
| H3 | 显式 init、restricted、两平台自启、默认不启动 | 满足设计承载。 |
| H4 | core/薄壳、createConsole、注入 opener、hub open | 满足设计承载；真实 sidecar/browser acceptance 待实现。 |
| H5 | 三视角切换、member 分流、leases/visits 隔离 | 满足设计承载，未见新 supersedes 冲突。 |
| H6 | hostname alias 消费，不改 server-access-roles 首写/续期语义 | 满足，未发现反向覆盖。 |
| H7 | leases.json 0..N、组 B 命名、`opendweb hub` 族 | 满足设计与 delta；H7 证据范围已同步。 |

### server-access-roles / webui-console 冻结面

- 三角色、邀请码、敲门、`/admin/*` Bearer 认证、renew 的
  `max(now,current_expires_at)`、`first_registered_at`、H6 alias 均未被 home-hub
  反向改写。
- member 态 setup supersedes 仍局限于五行分流；显式 `--server`、零数据 setup、
  `--setup` 入口以及 `/admin/*` 404/connect/nodes 403/无上游出站负向矩阵保持。
- Origin 更严格策略只作用于新增 probe/label 写路由；没有改写基线旧读/配对面的
  缺失 Origin 语义。
- v6 没有新增未声明 supersedes；唯一阻断是 CustomWithCaps 的 root/member 分支
  需要按 R6-P1-1 拆开。

## 6. r1 十条不可回退基线终判

| # | 基线 | r6 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**：默认不启动负向 Scenario 仍完整。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：root 自签顺序明确；attach/member 票据分支未定义。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；实现对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL / BLOCKED**：G-3 依赖 R6-P1-1 的有效入网分支，且本轮未执行 300 秒对拍。 |

## 7. 设计层结论与实现期义务

设计层当前仍为 **NOT-READY 7.8/10**。v6 的 root 四步已经达到“可进入实现”的
细度，但 `attach` 的 root/member 身份矛盾必须先在设计上拆分；修复 R6-P1-1 后，
若无新的 P0/P1，才可按 r5 §7 转为设计层 GO。

实现期的 GO 前置与验收义务：

1. 明确 home-hub 只走 root `createRoot/open`，或实现 bootstrap/member 的 attach
   分支；不得把 root-only ensure 施加到 member。
2. root 分支实际验证 ensure 在首次拨号前执行、返回条目覆盖租约、token 注入同一
   RelayMap；member 分支实际验证 bootstrap/OK2 member capability 的绑定与拒绝矩阵。
3. restricted relay 实际握手、无票拒绝、跨 server capability 拒绝；relay
   disabled/null/非法 URL preflight fail-closed 且不发 register。
4. G-3 test-only 对拍：停整个 server、Direct 300s、停机期新 join 失败、重启恢复、
   relay-only 对照或六字段 `NOT-EXECUTABLE` 记录。
5. 两平台自启生命周期、sidecar capability/RPC golden、短码 CLI/webui 对拍和真实
   账户 acceptance 文档。

