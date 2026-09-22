# server-access-roles 设计定稿轮 r2 delta 复审

## 1. 结论与评分

**评分：6.3/10（相对 r1 的 5.0/10 上升 1.3 分）。判定：NEEDS-WORK。**

r1 的 6 个 P0 中，身份来源、节点簿冲突、R8 范围和 rendezvous 可达面已在
spec/proposal/requirements 中给出可执行收窄或版本化例外；邀请码消费也已补事件、
串行临界区和 fsync 约束。但仍存在一个新的 P0：consume 事件落盘后，owners
register 事件没有跨文件事务或恢复协议，register 失败会烧掉邀请码，和“无半提交”
承诺冲突。另有设计正文旧语义、WebUI 路径、CLI 台账入口和 pending_count 契约
漂移，当前不能作为唯一实现合同。

处置统计：**闭合 15/22，部分闭合 7/22，未闭合 0/22**。新发现问题：P0×1、
P1×5、P2×2。

## 2. 验证证据

### 基线与 diff

| 项目 | 结果 |
|---|---|
| `git rev-parse HEAD` | `033e08892ad2e389c6f6a719c5bfcd75513b4a27` |
| 评审 diff | `d876203..033e088`，仅含本轮文档修订及 r1 报告归档 |
| `git diff --check d876203..033e088` | 通过 |

本 diff 未修改 `crates/` 或 `packages/` 实现源码；本轮结论只覆盖设计/spec/tasks
的可实现性，不把任何实现或运行时行为视为已闭合。

### Strict 校验

| 命令 | 结果 |
|---|---|
| `openspec validate server-access-roles --strict` | `Change 'server-access-roles' is valid` |
| `openspec validate sdk-mgmt-surface --strict` | `Change 'sdk-mgmt-surface' is valid` |
| `openspec validate webui-console --strict` | `Change 'webui-console' is valid` |

Strict 校验只证明 artifact 结构合法，不能证明跨文件事务、依赖 change 的例外
优先级或设计正文与 delta 的语义一致。

### 关键处置实证

| 处置 | 最终文件证据 | 结论 |
|---|---|---|
| relay-only KnockLog | `specs/server/spec.md:157-189`、`design.md:57-75`：仅 relay 握手身份，rendezvous 仅 debug | 安全边界已写入规范；design `:143-153` 仍有“rendezvous Deny 臂照记敲门”旧句 |
| consume/CAS/fsync | `specs/server/spec.md:191-240`、`tasks.md:27-31`：consume 事件、code_hash 串行、fsync 前零响应、双兑 e2e | 单文件消费约束已补；跨 codes/owners 两文件提交仍未冻结 |
| 节点簿例外 | `specs/webui/spec.md:69-98`：0600、临时文件+rename、拒 symlink、唯一 switch、在途 target 快照 | 例外条款清楚，但依赖基座仍保留旧绝对禁令，归档增补尚未成为当前可验证产物 |
| R8/R1 范围 | `requirements.md:63-80`、`proposal.md:82-90`、`specs/server/spec.md:9,118-153` | relay-only、R8 Phase 2 裁决链和四种当前落地形态已对齐 |
| 投影/回执 | `specs/server/spec.md:9,242-254`、`tasks.md:35-39` | Option&lt;fabric&gt;、per_visitor、0x04-0x0C、槽位表和 client-sdk 义务已写入 |

## 3. r1 处置逐条核对

| r1 项 | 状态 | 复核依据与残余 |
|---|---|---|
| P0-1 rendezvous 敲门身份 | **部分闭合** | `specs/server/spec.md:157-169` 和 `design.md:57-75` 已 relay-only；但 `design.md:143-153` 仍写 rendezvous Deny 记敲门，必须删除旧句并将 debug-only 写成唯一语义。 |
| P0-2 邀请码消费/CAS/fsync | **部分闭合** | `specs/server/spec.md:193-205`、`tasks.md:27-31` 已有 consume、串行和 fsync；但 consume 与 owners register 分属两个 jsonl，没有跨文件 commit/recovery，见新 P0-1。design `:92-122` 还同时保留旧 `issue|revoke`/`used_count+1`。 |
| P0-3 token 落盘 | **闭合（实现前置）** | `specs/webui/spec.md:71-73` 明示版本化 0600 例外、rename、symlink 和工作站威胁模型；需在 webui-console 归档时落增补条款并加入实现测试。 |
| P0-4 target freeze | **闭合（实现前置）** | `specs/webui/spec.md:73-88` 将 switch 定为唯一运行时重指向、在途请求按开始时快照；其余通道仍 target-frozen。 |
| P0-5 R8 房门三制 | **闭合** | `requirements.md:63-75` 记录 Owner 批准的 wire 延期及当前落地：roster 租户门、server 包租婆门、open 完全放行、可配置房门/混合 Phase 2；`proposal.md:82-90` 已引用。 |
| P0-6 visitor rendezvous 矛盾 | **闭合** | `specs/server/spec.md:9,118-143`、`proposal.md:34-40` 均为 relay-only/无票 resolve=401；未再承诺 visitor resolve。 |
| P1-1 fabric_id 自声明 | **闭合（残余已明示）** | `specs/server/spec.md:193-215` 定义自声明标签、二元组身份、多 root 合法和 UI 钓鱼警示；genesis proof 已列 Phase 2。 |
| P1-2 IP/XFF | **闭合** | `specs/server/spec.md:118,195,227-230`、`tasks.md:29-31` 冻结直连 TCP peer、拒绝 XFF/Forwarded，并加入伪造场景。 |
| P1-3 邀请码熵/日志 | **闭合** | `specs/server/spec.md:193-195,232-235` 冻结 OS CSPRNG、规范化哈希、日志/指标/错误零码全文；状态 oracle 被明确为产品取舍。 |
| P1-4 visitor 多 key 配额 | **闭合（残余已明示）** | `specs/server/spec.md:9`、`tasks.md:20` 增加 per-endpoint 4 + 全局 64；sybil 的 IP admission 明示 Phase 2。 |
| P1-5 四台账同构纪律 | **部分闭合** | `tasks.md:15` 有 fail-fast/reload 保旧/独立 generation/mtime/两入口矩阵，但写明“CLI 不新增”；`design.md:26-32` 仍写 visitors “CLI 三入口收敛”，且 codes 旧事件描述未同步。 |
| P1-6 visitor generation 缓存 | **闭合** | `specs/server/spec.md:9`、`design.md:50-52`、`tasks.md:22` 明确 owners+visitors 复合 generation 与 revoke-after-cached-allow 回归。 |
| P1-7 visitor 在线投影 | **闭合** | `specs/server/spec.md:9`、`tasks.md:21` 使用 `Option<fabric>`、无 sentinel，per_endpoint 与 per_visitor 分离，status 增 visitors_online。 |
| P1-8 103B/client-sdk | **闭合（实现门）** | `specs/server/spec.md:242-254` 有 0x04-0x0C union/canonical/fixture/验签 helper 义务，`tasks.md:36-39` 有 regen 对拍门；仍需实现时逐 op 对拍。 |
| P1-9 WebUI canonical/hash | **部分闭合** | `specs/webui/spec.md:5,71-73`、`tasks.md:43` 已冻结 `/api/*` 和四个 hash；但 `specs/webui/spec.md:24,57` 仍写业务列表经 `/sidecar/*`，与 canonical 文本冲突，见新 P1-2。 |
| P1-10 undismiss/复位/排序 | **部分闭合** | `specs/server/spec.md:159,181-189,256` 和 `tasks.md:35,39` 已有 undismiss、自动复位和 tie-break；`pending_count` 在 `include_dismissed=true`、不存在条目 undismiss、并发 dismiss/deny 下的计数定义仍未冻结。 |
| P1-11 `opendweb join` | **闭合（实现门）** | `specs/cli/identity/spec.md:17-35`、`tasks.md:58-60` 冻结默认 root、fabric 生成/复用、canonical、回执保存、明文守卫和非零失败。 |
| P1-12 generation/槽位 | **部分闭合** | `specs/server/spec.md:242-254` 已有管理 op 槽位表和“所属台账 generation”；公开 `/register` 回执同时跨 codes consume 与 owners register，generation 取哪一台账未说明，需与新 P0-1 一并冻结。 |
| P2-1 tokens/nodes 命名 | **闭合** | `specs/webui/spec.md:71-73`、`design.md:193-211` 统一为 nodes.json。 |
| P2-2 KnockLog seq/饱和/锁 | **部分闭合** | `specs/server/spec.md:159,186-189` 和 `design.md:57-75` 加入 seq、饱和计数和排序；未说明重复 deny 是否更新 seq、时钟回拨和 dismiss/deny 的锁内胜者，设计测试表 `design.md:232` 也未覆盖 undismiss/复位。 |
| P2-3 输入上限/到期边界 | **闭合** | `specs/server/spec.md:193,254`、`tasks.md:37` 冻结 alias/note/max_uses/checked arithmetic 与 `now >= expires_at`。 |
| P2-4 切换文案 | **闭合** | `PRODUCT-DESIGN.md:294-305`、`proposal.md:72-80` 已统一为进程内即时切换，无重启文案。 |

## 4. 新问题清单

### P0（阻塞）

#### P0-1：consume 与 owners register 不是原子提交，仍可出现“烧码无租户”

证据：`specs/server/spec.md:193-205` 要求 consume fsync 后再追加 owners register；
`tasks.md:29` 也把 register 放在 consume 之后，但没有两文件事务、commit marker、
恢复扫描或 register fsync。若 consume 已 fsync 而 owners.jsonl 写入失败/进程崩溃，
下次启动会把码计为已用，却没有对应租户；文档同时声称“落盘失败=500，不产生半
提交状态”（`design.md:118-122`），两者不相容。公开回执也不能在这时安全签发。

可验证修复：冻结跨 ledger 的 WAL/commit 记录（或单一事务日志）和启动恢复规则，
使 consume、owners register、generation、回执要么全部提交要么全部补偿；加入
“consume fsync 后 register 写失败/崩溃恢复，码可重试且无幽灵 consume”的故障注入
测试，并明确 `/register` 回执 generation 的所属世代。

### P1（须修）

#### P1-1：design.md 仍同时描述旧 codes/visitor/rendezvous 语义

证据：`design.md:26-38` 写 visitor “仅 relay/resolve 面”且 visitor 有 CLI 三入口；
`design.md:92-110` 仍是 `issue|revoke`、内存 `used_count+1`；`design.md:143-153`
仍写 rendezvous Deny 臂照记敲门。它们分别与 `specs/server/spec.md:9,157-205`、
`tasks.md:15,27-31` 的冻结语义冲突。

可验证修复：删除旧段或改为唯一的 consume/relay-only/CLI policy；增加文档 lint 或
spec-to-design grep 门，禁止同一 change 同时出现 `rendezvous.*记敲门`、
`issue|revoke`（无 consume）和 `used_count+1` 作为事实源。

#### P1-2：WebUI 敲门台/邀请码仍引用 `/sidecar/*` 业务代理

证据：`specs/webui/spec.md:5` 和 `:71-73` 冻结业务 canonical 为 `/api/*` →
`/admin/*`，但 `:24`、`:57` 仍写列表与动作经 `/sidecar/*` 代理；`design.md:210`
和 `tasks.md:43` 又选择 `/api/*`。实现者无法确定业务请求是否走基座代理还是本地
控制面。

可验证修复：把 `:24`、`:57` 的 `/sidecar/*` 全部改为 `/api/*`，仅保留
`/sidecar/nodes*`、`/sidecar/connect`、`/sidecar/state` 等本地控制面路径，并增加
路径契约 grep/测试。

#### P1-3：四台账 CLI 入口策略互相矛盾

证据：`tasks.md:15` 明示四台账“CLI 不新增”，但 `design.md:26-29` 仍要求
visitors “CLI 三入口收敛”；requirements/spec 也没有给出统一的 CLI 入口表。实现者
无法知道是否要为 visitors/codes/blocklist 提供 CLI mutation，进而无法冻结权限边界
与坏行/热重载的入口一致性。

可验证修复：由 Owner 选择一个策略并在 design/spec/tasks 同步：要么四台账均复用
owners 的 CLI 三入口并逐台账定义命令；要么明确全部仅 admin+文件，并删除 design
中的 CLI 三入口字样、补充“不提供 CLI mutation”的安全理由和验收。

#### P1-4：webui-console 版本化例外没有正式的生效优先级/归档锚点

证据：`specs/webui/spec.md:73` 声称归档 webui-console 时再附增补；当前基座
`openspec/changes/webui-console/specs/webui/spec.md:3-7` 仍绝对要求 token 不写文件、
target 重指向必须重启。当前 change 只有自然语言“例外”，没有版本号、supersedes
关系或基座测试更新，严格读取两个 change 时仍得到互斥合同。

可验证修复：在本 change 依赖矩阵中冻结 supersedes 条款/版本标识，并在 webui-console
归档或兼容 spec 中落对应增补与负向测试：仅 nodes.json 允许落盘、仅 node_id
switch 允许重指向，其他路径仍 target-frozen。

#### P1-5：公开 register 回执 generation 与 pending_count 仍缺完整 wire 语义

证据：管理面表格 `specs/server/spec.md:244-254` 只定义各管理操作的所属台账；
`POST /register` `:195` 同时消费 codes 并追加 owners，却未声明回执 generation
取 codes、owners 还是复合世代。`GET /admin/knocks` `:256` 声明 pending_count，
但未定义 `include_dismissed=true` 是否仍返回未处置计数、对不存在条目的 undismiss
是否成功以及并发新 deny 与 dismiss 的胜者。

可验证修复：为 register-receipt 增加明确的 `generation=owners_generation` 或
复合世代布局；冻结 pending_count 永远表示未 dismissed 条目数，并定义 unknown
undismiss、并发 CAS/锁顺序和响应码，补 wire/e2e 场景。

### P2（建议）

#### P2-1：KnockLog seq 的更新与时间回拨未定义

证据：`specs/server/spec.md:159,186-189` 只说 seq 是 tie-break，`design.md:67-75`
也未说明重复 deny 是否更新 seq；`last_at` 使用 wall clock 时没有回拨处理。排序、
LRU 淘汰和同端点重复敲门在同毫秒/时钟回拨下仍可能出现不稳定结果。

可验证修复：冻结每次 deny 都分配 seq（或明确 seq 仅创建时分配）、使用单调时钟排序
并把 wall-clock 仅用于展示；将 dismiss、new deny、eviction 放在同一锁内并加入属性/并发测试。

#### P2-2：设计测试表没有同步 r2 新场景

证据：`design.md:227-239` 的 KnockLog 测试仍只列 `dismiss`，未列 undismiss/自动
复位/seq tie-break；兑换测试未列 register 写入失败恢复；WebUI 测试仍写“sidecar
节点簿单测”但未锁定业务 `/api/*` 路径。

可验证修复：把 r2 新增的负向、故障注入和路径契约场景逐项加入 design 测试矩阵，
并让 tasks 的验收项引用同一套场景 ID。

## 5. 评审结论

r2 已显著收敛安全边界和产品范围，但设计文档尚未达到无歧义实现门。优先修复
P0-1 的跨文件提交协议，再同步 design/webui 路径/CLI 入口，并冻结 register receipt
generation 与 pending_count；完成后再进入实现或下一轮复审。
