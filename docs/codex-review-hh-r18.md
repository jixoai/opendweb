# home-hub 实现终验（r18）

## 1. 结论与评分

**结论：NOT-READY，8.3/10。**

实现提交序列、测试深度和安全边界整体达到发布前水平，但实现期裁决 #14 与实际写路由冲突，且裁决 #8 的默认 stdout 关闭语义没有实现。这两项都影响宿主生命周期或本机账本语义，不能以设计层已通过替代。相比 r17 设计层 9.0/10，本轮实现证据更强；相比 `server-access-roles` 实现终验 9.2/10，仍缺少这两个闭环，暂不 RELEASE-READY。

## 2. 验证证据

评审固定对象为 `333d73e`（当前 HEAD 仅新增 `IMPLEMENTATION-NOTES.md`，实现源码仍以该提交为准）。实际执行：

- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `git diff --check 333d73e^..333d73e`：通过，无输出。
- `node --test packages/webui/test/home.test.mjs packages/tray/test/controller.test.mjs packages/tray/test/heartbeat.test.mjs packages/tray/test/ipc.test.mjs`：47/47 通过，0 fail/skip/cancel/todo，约 4.33s。
- 当前工作树无未提交源码修改；未运行重型 Rust 全量门禁、真实 G-3 300s 或 Windows 交叉构建。本报告不把 IMPLEMENTATION-NOTES 中的历史收据冒充本轮独立实跑。

## 3. 阻塞问题

### P1-1：visits 写权限与实现期裁决 #14 冲突

`IMPLEMENTATION-NOTES.md:59` 明确裁决“到访簿仅成员侧（join/SDK 路径）写入；hub/服务端不写 visits”。但 `packages/webui/src/core/sidecar.mjs:485-496` 在 `homeDir` 存在时对 admin 与 member 都挂载本机数据面，`packages/webui/src/core/sidecar.mjs:739-775` 的 `POST /sidecar/visits/probe` 没有 `member` 守卫，默认/admin sidecar 可以写 `visits.json`。现有 `packages/webui/test/home.test.mjs:472-479` 还明确以默认（非 member）sidecar 验证该路由返回 200。

这不是纯文案差异：同一机器的中枢管理员视角可改变成员到访簿，破坏“成员侧事实簿”的来源和三视角语义。

**可验证修复：** 二选一并同步契约：

1. 若保留 #14，`/sidecar/visits/probe` 在 `member !== true` 时返回明确 403，补 admin/hub-local 负向测试，并保留 member 200 路径；或
2. 若产品允许管理员主动探测，修改 IMPLEMENTATION-NOTES #14、设计/delta 的写者定义，明确 admin 探测也是本机用户写入，并补角色矩阵测试。

### P1-2：默认 stdout 关闭未导致 tray 退出

`IMPLEMENTATION-NOTES.md:50` 裁决“stdout 模式下宿主关闭 stdout（EOF）→插件自行退出”。但 `packages/tray/src/controller.mjs:248-251` 只监听 `stdout` 的 `error`，并显式 `void stdin`；`runTray` 的 stream 分支（同文件约 301-303）只等待 `shutdownPromise`。宿主干净关闭 stdout/管道而不触发写错误时，心跳和控制器仍可驻留，形成孤儿进程，违反该生命周期裁决。

**可验证修复：** 在默认模式监听输出流的 `close`/等价断管事件，并以幂等 `stop()` 结束 `runTray`；补真实 child-process 测试：关闭 stdout、等待退出码为 0、断言 `tray-status.json` mtime 停止。若平台上不存在可可靠观察的 close 事件，应撤销 #8 的默认 EOF 语义并在实现期笔记与验收口径中明确仅 IPC 的 stdin EOF。

## 4. 非阻塞问题（P2）

### P2-1：迁移先于一致性闸门导致失败路径写入

`packages/opendweb/src/join.mjs:483-503` 先调用 `migrateLegacyRegistration`，随后才由 `resolveExistingFabricId` 检查 leases、legacy、roster 的 fabric 是否冲突。迁移在 `packages/opendweb/src/leases.mjs:427-442` 已写入 leases 并把 `registration.json` 改名；若之后发现 roster 冲突，命令虽 fail-closed，却留下迁移副作用。建议先只读汇总并校验各来源，再在一致性通过后提交迁移；或为迁移提供可回滚事务，并补“冲突时文件字节与文件名不变”测试。

## 5. 24 条实现裁决逐条判定

| # | 裁决 | 判定与证据 |
|---:|---|---|
| 1 | workspace 依赖分类 | **合理**：主包导出与手写 d.ts，未新增 npm 子包。 |
| 2 | capability 单次消费 | **合理**：`core/capability.mjs` 有实例绑定、used 墓碑、120s TTL、close 清空；console tests 覆盖重放/跨实例/关闭。 |
| 3 | hub 槽位/五行分流 | **合理**：`core/home.mjs` 与 CLI row 2-5 对齐，D1 测试通过。 |
| 4 | stopped→error | **合理**：heartbeat `computeSnapshot` 将已配置但 pid 不活映射 error，测试覆盖。 |
| 5 | pid 核验降级 | **合理**：tray 心跳仅以可用 pid 做运行态，核验失败不阻断；stop/status 的强核验留在 hub CLI。 |
| 6 | opened 帧序 | **合理**：IPC 用 `setImmediate` 发通知，结果帧先出；controller/ipc 测试覆盖。 |
| 7 | envelope 外字段不冻结 | **合理**：golden validator 只约束语义字段，未扩大协议承诺。 |
| 8 | 默认 stdout 关闭即退出 | **异议/P1**：当前仅监听 stdout error，未处理 clean close，见 P1-2。 |
| 9 | legacy fixture 替换 | **合理**：迁移测试使用不可兑换 fixture，隔离迁移面。 |
| 10 | 英文 fail-closed 文案 | **合理**：CLI 错误面为英文，webui 文案另行处理。 |
| 11 | roster wire 自源读取 | **合理**：`readRosterFabricId` 从 `roster.facts` 读取，未维护第二份手抄值。 |
| 12 | journal 陈旧性不自动判死 | **合理**：保留人工恢复路径，避免错误自动清除安全状态。 |
| 13 | 10s 崩溃窗 | **合理**：admission lock 与 hub lock 使用陈锁阈值和 pid 存活判断，测试覆盖。 |
| 14 | visits 仅成员侧写入 | **异议/P1**：源码/测试允许默认 admin sidecar probe 写入，见 P1-1。 |
| 15 | 迁移触发点 | **合理但有 P2**：首次读取触发符合产品体验；与一致性检查顺序的副作用见 P2-1。 |
| 16 | `opendweb id` 零租约显示 0 | **合理**：join/id 测试覆盖租约计数输出。 |
| 17 | link 字段前向兼容 | **合理**：缺失/未知不标注，`direct`/`relay` 映射有 home tests。 |
| 18 | F1 3s/5s 节奏 | **合理**：admin/member polling 分离，mock-timer 回归通过；未见重拉风暴。 |
| 19 | member/visitor 启动按钮仅指引 | **合理**：member 负向矩阵阻断本机 hub 副作用。 |
| 20 | `--server` 优先级 | **合理**：CLI 先冻结显式 target，本机 sidecar 数据仍跟随 DWEB_HOME；row 1/2 测试通过。 |
| 21 | UI/core 私有 helper 镜像 | **合理**：局部重复换取壳层独立可测，未形成安全分叉。 |
| 22 | 无组件测试基建 | **合理**：store/runMain/curl 测试覆盖行为，视觉验收仍需真实浏览器收据。 |
| 23 | `drop(Server) != shutdown` | **合理**：G-3 用例显式调用 shutdown，不把 drop 当停机证据。 |
| 24 | relay-only 恢复竞态记录 | **合理**：记录 21s/26s 窗口，不宣称瞬时恢复；属已知环境性事实。 |

## 6. 安全红线与实现证据

token 不进入 URL、事件、心跳文件、stderr 业务日志或 IPC 帧；sidecar `logAccess` 只记录 path，不记录 query；节点/心跳/账本文件使用 0600 原子写和 symlink 拒绝；admin API 代理在请求开始冻结 target/token；member `/api/*` 404 且零上游出站；写路由要求精确 Origin。上述均有源码和 47 项 focused tests 支撑。P1-1 的 visits 写面仍需角色授权收敛，P1-2 的 stdout 生命周期需补断管证据。

## 7. 基线与实现期义务

- 默认不启动、hub lock/接管、三宿主路径、短码 canonical、leases 锁与 admission journal、member admin 面隔离、tray 帧边界：实现与 focused tests 基本满足。
- 基线 2（restricted + token 不出面）保留为**实现期转正**：需实跑 CustomWithCaps restricted 首触带票、无票/跨 server capability 拒绝，并交付真实账户 acceptance 收据。
- 基线 10（G-3）保留为**实现期转正**：停整个 hub、先证 Direct、300s 双向零中断、新 join 失败、重启恢复；relay-only 对照或六字段 NOT-EXECUTABLE 记录必须随发布清单引用。
- 修复 P1 后补默认 stdout close/EOF child-process 收据、visits 角色矩阵、迁移冲突不变性测试；同时保留 Windows `.node`/exe CI 交叉构建收据和真实浏览器走查收据。

## 8. 最终判定

**NOT-READY（8.3/10）。** 两项 P1 都有明确源码行和可重复测试缺口；修复并独立复跑后，设计与实现可再评估 RELEASE-READY。
