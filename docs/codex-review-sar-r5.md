# server-access-roles 设计定稿轮 r5 delta 复审

## 1. 结论与评分

**评分：7.6/10（相对 r4 的 7.2/10，上升 0.4）。判定：NEEDS-WORK。**

r5 已把主要行为方向改正确：规范的 `/register` 校验序现在先检查已 durable 的同键
幂等回放，回放返回首次 `expires_at`、不追加副作用，续期明确只接受新有效码；
max_uses=2 串行场景、deny-set 503/恢复、节点切换例外 Scenario 和相应任务均已加入。
因此“max_uses=1 旧码变成永久续租凭据”的规范路径已被新条款消除。

但设计层仍未 GO。旧语义没有被全文清除：`design.md` 的跨台账/pending 段仍写
“register 续期”，server pending requirement 也保留同句；设计的兑换校验链仍先写
“码有效”再谈幂等，验收/CLI 还把耗尽码再次兑换笼统写成拒绝。KnockLog 在 design、
WebUI 和 PM 仍有“最近/最新在前”残句，PM 访客空态仍承诺“进楼找人”，而首启失败策略
的“拒绝启动或拒绝该台账功能面”仍是两个不同合同。

## 2. 验证证据

### 命令

| 命令 | 结果 |
|---|---|
| `git rev-parse HEAD` | `6882e6c5fa8435f4b2128c9f04a89a75a16c7f8b` |
| `git diff --stat dd6519d..6882e6c` | 6 个文件，229 insertions，19 deletions（本轮仍无实现代码） |
| `git diff --check dd6519d..6882e6c` | 通过 |
| `openspec validate server-access-roles --strict` | `Change 'server-access-roles' is valid` |
| `openspec validate sdk-mgmt-surface --strict` | `Change 'sdk-mgmt-surface' is valid` |
| `openspec validate webui-console --strict` | `Change 'webui-console' is valid` |

strict 结果只证明 OpenSpec artifact 结构，不证明实现会选择哪一条仍含“或”的失败
分支，也不证明幂等/重载并发行为。

### r4 关键源码锚点回看

本轮没有 runtime diff；基座锚点仍与 r4 核对一致：`gate.rs:285-286` 为 C0 无票
路径、`:310-313` 为 L1b `contains`；`registry.rs:35-50,115-121,144-192,206-229,260-270`
为行格式/generation/load/fsync/reload；`relay.rs:46-48,130-143` 为 open gate 装配与
Deny 臂；`rendezvous.rs:305-325` 为 bearer-only resolve；`admin.rs:466` 为 receipt
canonical；`sidecar.mjs:172-180,422-455,363-365` 与 `target.mjs:30-106` 为
setup、配对单飞、旧 target freeze、目标校验基座。r5 只修订了设计/spec，不改变这些
源码事实。

## 3. r4 §6 GO 条件逐项验收

| GO 条件 | 状态 | 证据与判断 |
|---|---|---|
| 1. KnockLog 所有排序/逐出文字统一为 seq | **部分闭合** | server/admin 场景已改为 seq desc、last_at 仅展示；但 `design.md:70-72` 仍写“last_at 相同的排序 tie-break”，`specs/webui/spec.md:24` 写“最近在前”，`PRODUCT-DESIGN.md:255` 写“最新在上”，均暗示 wall-clock 参与排序。应改为仅 seq/endpoint_id 的稳定顺序。 |
| 2. 同键幂等优先级、重放/续期寿命、max_uses>1 唯一化并清除旧句 | **部分闭合** | 新权威规则在 `specs/server/spec.md:195,206-214`，且 `design.md:117-121`、`tasks.md:31,34` 已说明回放不刷新、续期须新码；但 `design.md:105-106` 仍是“限流→码有效→PoP”的旧链，`:134-136` 仍写同码重试“register 续期”，`:138-141` 及 `specs/server/spec.md:197` 仍写“register 续期 + consume 补写”。`spec.md:241-244`、`PRODUCT-DESIGN.md:399`、`specs/cli/identity/spec.md:31-34` 的泛化“耗尽码再次兑换=拒绝/code-exhausted”也没有限定为他键。合同尚未唯一。 |
| 3. 首次 reconciliation/fail-closed 状态、retry/clear/restart 冻结 | **部分闭合** | `specs/server/spec.md:198,216-219` 已定义加载失败、append 失败 deny-set、503、成功移除与重启重演；但 `(a)` 仍写“拒绝启动**或**拒绝该台账功能面”，实现者仍可选择两个不同生命周期/可用性合同；重试触发/退避也未定义。 |
| 4. 修正 PM resolve 与节点切换文案 | **部分闭合** | V2、流 B、敲门台 3a 和 N5 已收敛；但 `PRODUCT-DESIGN.md:357` 仍写“访客可以进楼找人”，与 relay-only/无票 resolve 401 冲突。节点切换的即时语义已统一。 |
| 5. 基座 Scenario 明确排除 switch | **闭合** | `openspec/changes/webui-console/specs/webui/spec.md:30-33` 已明确排除 `/sidecar/nodes/switch`；节点簿 delta `openspec/changes/server-access-roles/specs/webui/spec.md:73-89` 另有仅存 node_id、无重启、在途快照场景，且基座例外段 `openspec/changes/webui-console/specs/webui/spec.md:13` 保留 token/target 安全边界。 |

**GO 条件统计：闭合 1/5，部分闭合 4/5，未闭合 0/5。**

## 4. 新问题清单

### P0（阻塞）

无。

### P1（须修）

#### P1-1：幂等新合同与旧 register 续期句并存

证据：权威新条款 `specs/server/spec.md:195,206-214` 要求旧码同键回放 200、
`expires_at` 不刷新、续期只能用新码；但 `specs/server/spec.md:197` 仍写“同幂等键
重试（register 续期 + consume 补写）”，`design.md:134-141` 同样保留该语义，
`design.md:105-106` 仍把码状态检查放在幂等命中之前。`spec.md:241-244`、
`PRODUCT-DESIGN.md:399`、`specs/cli/identity/spec.md:31-34` 又把耗尽码的再次兑换
笼统写成拒绝/`code-exhausted`，没有排除同键回放。

这会让实现者在 pending/崩溃恢复路径重新刷新租期，直接复活 r4 已消除的永久续租
路径；同时 code 版与 code_hash 版幂等键在 design/spec 间不够统一。

修复：删除/改写所有旧“register 续期 + consume 补写”句，统一校验伪代码为
`ts → durable-key replay → code state → PoP → new redemption`；将“code-exhausted”
场景限定为其他幂等键；明确 pending 同键只补 consume/返回既有结果，不刷新租期，并
同步 design 的校验链与事件字段。

#### P1-2：reconciliation 首启失败策略仍非唯一合同

证据：`specs/server/spec.md:198` 写台账加载/归并失败（含首启）为“fail-fast 拒绝
启动**或**拒绝该台账功能面”。这两个选择分别意味着整个 gateway 不可用，或
`/register`/codes 面不可用但其他管理面继续服务；规范没有裁决哪一个是 v1 行为。

修复：选定一个行为并写成 MUST（建议沿 owners 坏行纪律：整个服务拒绝启动）；若产品
确实要台账级降级，则固定 health/status/error envelope、受影响路由集合、恢复后 reload
迁移和重试退避，并为另一条行为加负向测试防止实现漂移。

#### P1-3：KnockLog design 仍暗示 last_at 参与排序

证据：`design.md:70-72` 写“seq 进程内单调序号（last_at 相同的排序 tie-break）”，
`specs/webui/spec.md:24` 写“最近在前”，`PRODUCT-DESIGN.md:255` 写“最新在上”；而
server requirement `specs/server/spec.md:159,186-189,305` 已明确 seq 是唯一主排序并由
endpoint_id 作最终稳定 tie-break，last_at 仅展示。这些残句会让实现选择 wall-clock
比较，破坏 r4 要求的时钟回拨免疫。

修复：改为“seq 是排序键；endpoint_id 仅作同 seq 的最终 tie-break；last_at 只展示”，
并在 design 及任务矩阵加入回拨断言。

#### P1-4：PM 访客空态仍承诺“找人”

证据：`PRODUCT-DESIGN.md:357` 仍写“访客可以进楼找人”，但同文件 `:47,84,261`
与 server spec 已冻结访客 v1 仅 relay 通行、无票 resolve 401、定向解析 Phase 2。
其余 r5 文案已改，单独保留这一句仍会让 UI/验收重新实现发现面。

修复：改为“访客可以进楼连接（relay 通行；定向解析=Phase 2）”，并在 copy 回归测试
中禁止无票“找人/查门牌/resolve 命中”措辞。

### P2（建议）

#### P2-1：幂等回放是否仍需 PoP 验签未明示

当前校验序在 durable-key 命中后直接返回回放，PoP 验签写在其后（`specs/server/spec.md:195`）。
由于回放没有副作用，这不是新的准入绕过；但持有旧码和公开 `(fabric_id,root)` 的请求者
可在不提供有效 root 签名时获得 200 回放/到期信息，认证边界与普通注册不一致。

修复：明确回放路径是否仍需先验签（推荐保留 PoP 验签但跳过 code 状态检查），或在安全
模型中承认回放为无副作用的查询，并固定响应脱敏与审计语义。

## 5. 安全与可实现性结论

- **一次性码续租路径**：新权威 spec 已将同键旧码回放固定为不刷新 `expires_at`，并补了
  max_uses=2 K1→回放→K2 场景；因此产品语义本身已正确。但残留旧句足以让实现回退，
  设计层必须先清除。
- **失败分级**：append 失败的进程内 deny-set、503、成功移除和重启重演是可实现的；
  首启加载失败的“启动拒绝/仅台账拒绝”二选一尚未裁决，不能宣称唯一实现。
- **节点簿基座**：r5 的 Scenario 与例外段一致，没有削弱 token 不出浏览器、仅存
  node_id switch、原子 target 快照、Host/Origin 或 `validateTarget` 边界。
- **PoP/限流/访客身份**：PoP 域仍含 code/fabric/root/ts，直连 peer 限流与 XFF 拒绝、
  relay E1 endpoint 以及 per-endpoint+global visitor quota 语义未回退；残余 Sybil 与
  self-declared fabric_id 仍是既有 Phase 2 取舍。

## 6. 设计层 GO 条件

本轮无 P0，但仍不能 GO。完成以下修订后可进入实现：

1. 删除 design/spec 中所有旧的“register 续期 + consume 补写”及泛化 exhausted 句，
   统一 durable-key replay → code state → PoP 的最终状态机，并补充回放 PoP 取舍；
2. 将首启台账加载失败从“启动拒绝或功能面拒绝”裁成一个 MUST 行为，定义重试退避/健康
   状态；
3. 清除 design 的 `last_at` tie-break 残句；
4. 修正 PM 访客空态的“找人”文案并加入 copy 负向测试。
