# server-access-roles 实现终验 r8

## 1. 结论与评分

**判定：NOT-READY。评分：5.8/10。** r7 的 8.4/10 是设计层 GO；本轮评分只评实现。实现已覆盖九条基线的大部分功能，三包 JS 回归和三个 OpenSpec strict 校验通过，但源码存在可破坏邀请码 `max_uses` 的热重载竞态（P0），并有 pending 恢复与节点添加配对码并发问题（P1）。Rust 测试与 clippy 因机器 swap 压力未安全启动，因此不能据提交方收据给出发布就绪结论。

提交方提供的云端 11/11、节点簿 10/10、视觉走查及 Rust 回归统计属于提交方收据；本轮没有独立复跑云端或视觉走查，也未将这些收据计作本轮验证。

## 2. 验证证据

| 命令 / 检查 | 结果 |
|---|---|
| `git rev-parse HEAD` | `84815092ba30c220b4ce78f406d16485879d815c` |
| `git log --oneline be5d008^..HEAD` | 范围与请求列出的实现提交一致，包含实现期 spec 回写及 gitignore |
| `openspec validate server-access-roles --strict` | 通过：change valid |
| `openspec validate sdk-mgmt-surface --strict` | 通过：change valid |
| `openspec validate webui-console --strict` | 通过：change valid |
| `packages/client-sdk` `npm test` | 87/87 通过 |
| `packages/webui` `npm test` | 131/131 通过 |
| `packages/opendweb` `npm test` | checkjs 通过，149/149 通过 |
| `git diff --check be5d008^..HEAD` | 失败：`packages/webui/dist/assets/index-B1zlYTDj.js:1` 有 trailing whitespace（生成的 minified bundle） |
| `PATH="$HOME/.cargo/bin:$PATH" mbx test -j 2 -p dweb-server` | 未运行：检查时 swap 已用约 15.0 GiB/16 GiB；按仓库重负载纪律未启动 Rust 测试 |
| `PATH="$HOME/.cargo/bin:$PATH" mbx clippy -j 2 -p dweb-server --all-targets -- -D warnings` | 未运行：同一资源限制；不得视为通过 |

### 高风险路径抽查

- `/register`：`register.rs:165-273` 按直连 peer 限流、形状、时间窗、PoP 验签后才进入幂等/码状态；PoP canonical 在 `register.rs:86-100` 包含请求 code、规范化 hex fabric/root 与大端 ts。CLI 的 `register.mjs:61-75` 构造相同载荷，`join.mjs:313-321` 签名并发送。`codes.rs:542-600` 对 durable 同键回放不刷新租期，新兑换先写 owners 再 consume。
- 热重载：`codes.rs:430-435`、`registry.rs:506-514`、`visitor.rs:318-325`、`blocklist.rs:263-270` 均先从磁盘加载、后取得状态锁替换快照；这与写入端锁内 append+fsync 不构成单一原子临界区，详见 P0-1。成功恢复时 `CodeLedger::reload` 也未移除已经补写完成的 `state.pending`，详见 P1-1。
- KnockLog：生产写入点只有 `relay.rs:134-155` 的 Deny 臂，经 `gate.rs:591-600` 写入；`knock.rs:82-185` 实现 seq 分配、饱和计数、同锁 dismiss/undismiss、pending_count 和逐出契约。管理面仅调用 dismiss/undismiss，rendezvous 不写入。
- 节点簿：0600、O_EXCL 临时文件、fsync、rename 与拒 symlink 在 `nodes.mjs:49-59,101-126`；业务请求于首个 await 前冻结 target/token 快照并将其传入代理，在 `sidecar.mjs:246-263`。但添加码的单飞锁在 `validateTarget` 返回后、节点落盘前释放，`sidecar.mjs:589-613`，未覆盖提交阶段。
- CLI join：默认设备 key 作为 root、fabric 选择、canonical 签名、回执验签后保存见 `join.mjs:301-321,365-420`；设备 seed 由 OS CSPRNG 创建并以 insert-if-absent 持久化，见 `device-key.mjs:65-119`。
- 实现期增补：0x0D/0x0E 元数据回执映射及路由在 `admin/mod.rs:95-128`、`roles.rs`；fixture 有 16 个样例，JS fixture 对拍随 client-sdk 87 项测试通过。ce3cf0b 的严格 base64url、请求原文 code canonical、状态映射和回放响应形态可在 `register.rs:159-273` 对拍；67b7f1d 的 permanent wire 形态、open 模式加载台账但不装 gate、unknown 目标 404 有对应路由/快照实现。未发现这些增补引入新的 wire 槽位或基座 sidecar 例外矛盾。

## 3. 基线复核表

| # | r7 不可回退基线 | 判定 | 实现证据 / 说明 |
|---|---|---|---|
| 1 | register 顺序、回放同样 PoP 验签、旧码回放不续期 | **满足** | `register.rs:165-273`；`codes.rs:542-547,564-600`；CLI 同构 canonical：`register.mjs:61-75`。 |
| 2 | 三元组幂等键、pending、owners/consume 双 fsync、重启/热重载 reconciliation | **部分满足** | 键与跨台账顺序在 `codes.rs:527-600`、完整三元组归并在 `codes.rs:366-412`；但 reload 在锁外读盘/补写后才发布，且未清除已 durable 的 pending（P0-1、P1-1）。 |
| 3 | 新码续期、旧码同键回放不刷新、max_uses=2 与并发双兑 | **部分满足** | 回放/续期分支 `codes.rs:542-600`，串行序列与并发测试 `codes.rs:1240-1279,1382-1413`；reload 竞态可丢失已计数 consume，导致上限绕过（P0-1）。 |
| 4 | 加载失败 fail-fast；append 失败 deny-set 503 并可恢复 | **部分满足** | 启动加载错误通过 `main.rs:326-337` 传播；deny-set 路径 `codes.rs:665-699`，测试 `codes.rs:1149-1185`。恢复 reload 后 pending 未清除，导致同码他键继续 409（P1-1）。 |
| 5 | KnockLog 仅 relay E1 Deny、seq 排序/逐出、dismiss/deny 原子、pending_count | **满足** | 唯一生产写入口 `relay.rs:134-155`；聚合及顺序 `knock.rs:82-185`；管理投影/动作 `roles.rs:335-419`。 |
| 6 | 节点簿 token 0600 落盘例外、仅 node_id switch、目标快照、其余路径冻结 | **部分满足** | 文件边界 `nodes.mjs:49-59,101-126`；仅 node_id `sidecar.mjs:615-659`；请求开始快照 `sidecar.mjs:246-263`。节点添加单飞锁未延伸到 fsync/rename 和码轮换，存在双消费窗口（P1-2）。 |
| 7 | 访客仅 relay；无票 rendezvous 401；open 不装 gate | **满足** | relay 装 gate 条件 `relay.rs:44-48`；无票访客只对 RelayConnect 放行 `gate.rs:518-545`；open 返回无 gate `main.rs:380-457`；rendezvous ACL deny 映射 401 `rendezvous.rs:263-289`。 |
| 8 | 103B canonical、0x04-0x0E、所属台账 generation、client-sdk/fixture 同步 | **满足** | canonical `admin/mod.rs:546-563`；op 映射 `admin/mod.rs:89-128` 与 `client-sdk/admin/index.mjs:76-112`；16 样例 fixture 和本轮 SDK 测试通过。 |
| 9 | register PoP 域含 root、直连 peer 限流、80-bit CSPRNG、码全文脱敏 | **满足** | PoP/限流 `register.rs:86-100,160-242`；令牌桶只接 `IpAddr` `ratelimit.rs:4-7,51-82`；生成 `codes.rs:229-268`；日志只记录 code_hash `register.rs:279-339`、签发 `roles.rs:693-740`。 |

**统计：满足 5/9，部分满足 4/9，违背 0/9。** “部分满足”包含会改变安全/一致性结果的实现偏差，不等价于可发布。

## 4. 问题清单

### P0（阻塞）

**P0-1：热重载可覆盖已完成兑换的快照，绕过 `max_uses`。** `CodeLedger::reload` 在 `codes.rs:431` 先执行 `load_inner`（读取与 orphan consume append 见 `:339-421`），之后才在 `:432-434` 获取锁并替换 `state.current`。兑换则持有同一状态锁完成 owners register、codes consume 和快照推进（`codes.rs:541-600`）。若 watcher 先读到旧 codes/owners 文件，兑换随后双 fsync 并更新当前快照，reload 最后仍可拿锁发布旧快照；其 5 秒 watcher 间隔留下同码他键再次被当作未消费的窗口。`registry.rs:506-514`、`visitor.rs:318-325`、`blocklist.rs:263-270` 有相同读盘后加锁的发布模式，可能短暂丢掉刚写入的 owner/blocklist/visitor 状态。**修复建议：** reload 的磁盘读取、归并、reconciliation 和发布必须与本台账所有写入组成同一写入序列化协议；跨 owners/codes 的锁获取顺序须避免与 redeem 的 codes→owners 顺序形成死锁。加入 barrier 控制的并发回归：reload 读旧文件后暂停，完成 max_uses=1 兑换再恢复 reload，随后第二键必须仍为 exhausted；同样覆盖 deny/blocklist 写入不被 reload 回退。

### P1（须修）

**P1-1：热重载补齐 consume 后没有释放进程内 pending。** append 失败后 `pending` 保留、deny-set 记录；watcher reload 能从 owners orphan 补写 consume 并把 `state.deny` 替换为空（`codes.rs:424-435`），但注释明确 pending 不清理，代码也未从 `state.pending` 移除相应 hash。由于 reconciliation append 会在 reload 入场时捕获的文件指纹之后改变 codes 文件，可能额外触发一次 watcher reload；该次 reload 仍不清 pending。待指纹追平且 deny-set 为空后无后续触发，`redeem` 对同码新键经过 pending 分支（`codes.rs:548-558`），即使首键 consume 已 durable，仍会持续返回 `code-pending`。现有恢复测试 `codes.rs:1181-1185` 使用新 ledger load 验证 deny 清除，没有断言同一个有 pending 的 ledger reload 后 K2 可继续使用。**修复建议：** reconciliation 在同一临界区返回本轮已 durable 的完整三元组，并在快照提交时清除匹配 pending；新增 max_uses=2、consume append 失败→reload 补齐→K2 成功以及 max_uses=1→K2 exhausted 场景。

**P1-2：节点添加配对码的单飞锁在持久化前释放，允许同码并发双消费。** `sidecar.mjs:595-600` 的 `nodePairingInFlight` 只覆盖 `validateTarget`；锁在 `nodes.add` 前释放，而配对码只在 `await nodes.add(...)` 成功后于 `:608-610` 轮换。第一请求进入 `NodeStore.add` 的 fsync/rename await 窗口时，第二请求仍可用旧码通过校验并追加另一节点，形成一个一次性终端码创建两个条目的可能性。现有 `nodes.test.mjs:132-149` 只测顺序重放，未覆盖并发添加。**修复建议：** 单飞锁覆盖验证至 durable 落盘、码轮换和成功响应；失败时回滚内存条目且保留配对码。用延迟 DNS/存储注入并发双发同一码，验收恰一成功、一条持久条目、另一请求 409。

### P2（建议）

**P2-1：节点簿写盘失败会留下与磁盘不一致的内存状态。** `nodes.mjs:138-149` 在 `#save()` 前 push，`remove` 在 `#save()` 前 splice（`:153-158`）；保存失败时均没有恢复旧数组。修复为先构造候选数组、持久化成功后再替换内存状态，并加写失败测试。此项与 P1-2 的并发提交应共用节点簿事务边界。

**P2-2：WebUI 错误/响应类型在边界处未经运行时校验。** `console.svelte.ts:292-298` 等处将 `catch (e)` 直接断言为 `AdminError`；`api.ts:104-106` 将 `jsonFetch` 结果断言为 `SidecarState`。非该类型错误不会因此被归一化，畸形 JSON 也可能进入组件状态。建议统一 `unknown` 错误归一化，并在 API 边界验证响应结构。

**P2-3：生成资源 diff 有 trailing whitespace。** `git diff --check` 报 `packages/webui/dist/assets/index-B1zlYTDj.js:1`。重新生成/规范化 bundle 后确认 diff check 清洁；该项本身不影响本次运行时判定。
