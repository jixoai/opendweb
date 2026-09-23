# server-access-roles 实现终验 r9

## 1. 结论与评分

**判定：NOT-READY。评分：7.2/10（较 r8 的 5.8 +1.4）。** r8 的 P0 热重载丢失消费计数、P1 pending 不释放、节点添加双消费窗口和 P2 节点簿落盘回滚均已由代码与独立测试闭合；Rust 302 项、三包 npm 测试、clippy 与完整 diff-check 均通过。仍发现两项发布阻塞 P1：codes reconciliation 补写失败时违反冻结的快照/503 失败语义；节点切换与删除并发可令已删除节点成为当前目标。另有一项非阻塞 JSDoc `any` 规范问题。

**发布条件：** 修复 P1-1、P1-2，加入指定回归场景，并重新跑本报告的 Rust、clippy、WebUI 门。没有 P0；当前不满足 RELEASE-READY。

## 2. 独立验证证据

评审范围为 `be5d008^..7434a55`；HEAD 为 `7434a55473f730735085cca41b67fa75b6f69e2f`。报告生成前工作区干净。没有把提交方生产走查或视觉走查收据计入独立证据；本轮未重跑云端生产实例及浏览器视觉验收。

| 命令 / 检查 | 独立结果 |
|---|---|
| `PATH="$HOME/.cargo/bin:$PATH" mbx test -j 1 -p dweb-server` | 通过：262 单测 + 39 e2e + 1 story = **302/302**；story 用时约 126 秒。通过 Herdr pane 串行运行；因启动时 swap 已用约 14.8/16 GiB 降为 `-j 1`。 |
| `PATH="$HOME/.cargo/bin:$PATH" mbx clippy -j 1 -p dweb-server --all-targets -- -D warnings` | 通过：`Finished dev profile`，零 warning。 |
| `packages/client-sdk` `npm test` | 通过：类型检查 + **87/87**。 |
| `packages/webui` `npm test` | 通过：**136/136**。 |
| `packages/opendweb` `npm test` | 通过：checkjs + **149/149**。 |
| `git diff --check be5d008^..HEAD` | 通过，退出码 0。 |
| `git check-attr whitespace -- ...` | `packages/webui/dist/assets/index-vCzVIzvZ.js` 为 `unset`（仅该生成物范围关闭 whitespace 检查）；`packages/webui/src/nodes.mjs`、`test/nodes.test.mjs`、Rust 源码均为 `unspecified`。 |

### r8 修复复核

- 四台账 `reload` 均先取各自状态锁，再读盘、归并并替换快照；codes 锁也覆盖 orphan reconciliation append 和 pending 清理。owners/codes watcher 是 owners 锁释放后再取 codes 锁，redeem 才是 codes→owners 嵌套，未形成锁环。证据：[registry.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/registry.rs:512)、[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:442)、[visitor.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/visitor.rs:322)、[blocklist.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/blocklist.rs:267)、watcher `codes.rs:799-807`。
- `CodeLedger::reload` 按 durable consumed 的完整 `(code_hash, fabric_id, root)` 键移除 pending。新增 barrier reload 竞争、同 ledger max_uses=2 K2 成功、max_uses=1 K2 exhausted 与 redeem/reload 锁序压力测试见 [codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:442) 及 `:1655-1858`；302 项全量测试通过。
- 节点添加的单飞锁从配对码校验后的目标验证持续到 `nodes.add` durable 完成、配对码轮换和响应，`finally` 释放；switch 也用 `try/finally`。证据：[sidecar.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/webui/src/sidecar.mjs:591)。独立双发存储延迟测试恰一 200、一 409、一条 durable 记录；写盘失败不烧码。
- NodeStore add/remove 共享串行队列，先构造候选数组、落盘成功后再替换内存；写盘失败测试断言内存与磁盘字节不变。证据：[nodes.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/webui/src/nodes.mjs:109)、`:147-188`；npm 测试通过。
- `.gitattributes` 仅将 `packages/webui/dist/assets/*.js` 的 `whitespace` 设为 unset；源代码和测试未受豁免，完整提交范围 `git diff --check` 通过。

## 3. 基线复判表

| # | r7 不可回退基线 | r9 判定 | 代码级证据 / 说明 |
|---|---|---|---|
| 1 | register 顺序、回放同样 PoP 验签、旧码回放不续期 | 满足 | 未受 r8 修订影响；`register.rs:165-273`、`codes.rs:560-600`。 |
| 2 | 三元组幂等键、pending、双 fsync、启动/热重载 reconciliation | **部分满足** | pending 与热重载锁竞争已修复；但 reconciliation append 失败仍发布 `load_inner` 返回的新 snapshot，违背“保留当前快照”契约，见 P1-1。`codes.rs:405-424,442-453`。 |
| 3 | 持新码续期、旧码同键回放不刷新、max_uses 与并发双兑 | 满足 | durable replay 不刷新；K1/K2 与 reload 竞争回归通过。`codes.rs:560-620,1655-1700,1708-1770`；Rust 302/302。 |
| 4 | 加载失败 fail-fast；补写失败 deny-set 503 并恢复 | **部分满足** | 首启/坏行 fail-fast、deny-set 和恢复路径存在；但 reload 的 orphan append 失败仍发布快照，且已存在 pending 时 pending 分支先于 deny，可能返回 500/409 而非 spec 要求的 503。`codes.rs:442-453,567-581`；spec `server/spec.md:198,274-275`。 |
| 5 | KnockLog 仅 relay E1 Deny、seq 排序/逐出、dismiss/deny 原子、pending_count | 满足 | r8 后无相关改动；`relay.rs:134-155`、`knock.rs:82-185`。 |
| 6 | 节点簿 token 0600、仅 node_id switch、请求目标快照、配对码纪律 | **部分满足** | 添加码全程单飞、存储事务已闭合；但 delete 与 switch 不共用互斥，切换校验中可删除其目标，见 P1-2。`sidecar.mjs:661-715`。 |
| 7 | 访客仅 relay；无票 rendezvous 401；open 不装 gate | 满足 | r8 后无相关改动；`relay.rs:44-48`、`gate.rs:518-545`、`main.rs:380-457`、`rendezvous.rs:263-289`。 |
| 8 | 103B canonical、0x04-0x0E、generation 与 SDK/fixture 同步 | 满足 | r8 后无相关改动；`admin/mod.rs:89-128,546-563`、client-sdk `admin/index.mjs:76-112`；client-sdk 87/87。 |
| 9 | PoP 域含 root、直连 peer 限流、80-bit CSPRNG、码脱敏 | 满足 | r8 后无相关改动；`register.rs:86-100,160-242`、`ratelimit.rs:4-7,51-82`、`codes.rs:229-268`。 |

**统计：满足 6/9，部分满足 3/9，违背 0/9。** 部分项均涉及明确运行语义，不等价于可发布。

## 4. 遗留问题

### P0

无。

### P1（阻塞发布）

**P1-1：reconciliation append 失败仍发布新快照，且 pending 优先级可能绕过 deny-set 的 503。** `load_inner` 对 orphan consume append 失败只把 hash 写入 `deny`，随后仍返回新 snapshot（[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:398) 至 `:424`）；`reload` 无条件替换 `state.current` 并发布 deny（`:442-453`）。冻结 spec 明确要求补写失败时“保留当前快照 + 受影响码进入进程内 deny-set”，且热重载场景要求保留旧快照（[server spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/server-access-roles/specs/server/spec.md:198)、`:272-275`）。此外 `redeem` 先处理 pending（`:567-578`），再检查 deny（`:579-581`）；同一进程中已有 pending 且 reconciliation 再次失败时，同键会尝试 append 并可能回 500，他键会回 409，而不是冻结的 `503 code-unavailable`。

**修复建议：** 将 reconciliation 失败与加载成功分开表达：失败时保留既有 current snapshot，只记录/更新失败 hash 的 deny 状态；该失败原因须优先映射受影响码为 503，同时保留“首次兑换 consume append 失败=500 + pending 同键可幂等补写”的既定语义。补写成功后再发布新 snapshot、清 deny 与匹配 pending。加回归覆盖同 ledger 已有 pending、reload append 失败、K1/K2 状态码及旧快照 generation/内容不变，随后修复磁盘 reload 成功后 K2 正常裁决。

**P1-2：switch 与 delete 并发可让已删除节点成为当前目标。** switch 在 `sidecar.mjs:661-672` 读取节点条目后异步执行 DNS/目标验证，提交时直接采用捕获的 `entry` 并设置 `currentNodeId`（`:688-691`）。与此同时 DELETE 只检查当时的 `state.currentNodeId`，再独立 `await nodes.remove(id)`（`:701-715`），不会检查 `nodeSwitchInFlight`。确定性时序：当前 A，switch(B) 已取得 B 并等待验证；DELETE B 因 B 当时非当前而成功落盘删除；验证返回后 switch 仍成功并把 `currentNodeId` 指向已不在 NodeStore 的 B。违反 spec“当前节点不可删除/切换仅接受已存节点”语义（[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/server-access-roles/specs/webui/spec.md:95)）。现有测试分别验证普通切换和删除，未覆盖该交错。

**修复建议：** 将 switch/delete 纳入同一节点变更互斥协议，并在 DNS await 后提交前重查目标仍存在；二者竞争时明确由一个请求得到冲突响应。新增延迟 DNS barrier 测试：并发 switch(B)+DELETE(B)，终态必须满足 `currentNodeId` 始终对应 durable 节点，或切换/删除一方明确失败。

### P2（非阻塞）

**P2-1：生产 JSDoc 边界使用 `any`。** [nodes.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/webui/src/nodes.mjs:55) 以及 `:81,93,96` 对文件系统错误和 JSON 数据使用 `@type {any}`；[join.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/opendweb/src/join.mjs:342) 对 HTTP JSON envelope 也使用 `any`。违反全局 TypeScript 强类型/禁止 any 的默认规范（[AGENTS.md](/Users/kzf/.agents/AGENTS.md:47)）。不改变本轮运行时验证结果，建议保留 `unknown` 并经窄化守卫读取。可用各包 `checkjs`/`npm test` 作修复验收。

## 5. 评审范围说明

本轮独立确认代码、测试和本地门；云端生产 11/11、节点簿人工走查及视觉走查均为提交方提供的证据，未在本轮重复执行，也未用于抵消上述 P1。`git diff --check` 通过说明 whitespace 豁免范围没有遮蔽本次提交中 dist 以外文件的问题；并不改变该豁免仅限生成 JS bundle 的事实。
