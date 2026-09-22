# server-access-roles 设计定稿轮 r4 delta 复审

## 1. 结论与评分

**评分：7.2/10（相对 r3 的 6.8/10，上升 0.4）。判定：NEEDS-WORK。**

r3 的两个阻塞面已经进入规范：兑换先写 owners、再写 consume，双 fsync 后才响应；
同码 pending 会阻止其他幂等键；启动与 mtime reload 都做完整三元组 reconciliation；
KnockLog 的权威条款已改为 seq 主键；PoP、XFF 拒绝、反代请求体脱敏、open 模式不装
gate 也已明确。本轮没有新的 P0。

仍不能直接给设计层 GO：设计文档和一个管理 API 场景保留旧排序/幂等语义，PM 产物
还有无票 resolve 与重启切换文案，基座的 target-frozen 场景未显式排除 switch 例外，
且启动时没有旧快照时的 fail-closed 状态没有定义。尤其同键重试被写成“续期 200”，
却没有限定它是响应丢失的幂等重试还是一次性码的新续期，可能把 max_uses=1 的码变成
可重复续租凭据。

若完成 6 个 P1 的文本/状态机修订，并补齐 max_uses>1 与启动失败测试，设计层可
判定 GO；当前判定仍为 NEEDS-WORK。

## 2. 验证证据

### 命令

| 命令 | 结果 |
|---|---|
| `git rev-parse HEAD` | `dd6519dac973f94304a566f31cbeb146a7daa07f` |
| `git diff --stat c183185..dd6519d` | 6 个文件，251 insertions，19 deletions（本轮无实现代码） |
| `git diff --check c183185..dd6519d` | 通过 |
| `openspec validate server-access-roles --strict` | `Change 'server-access-roles' is valid` |
| `openspec validate sdk-mgmt-surface --strict` | `Change 'sdk-mgmt-surface' is valid` |
| `openspec validate webui-console --strict` | `Change 'webui-console' is valid` |

strict 校验只证明 artifact 结构合法，不证明跨台账原子性、并发、reload 或浏览器运行时
行为。

### 源码锚点核对

| 设计引用 | 当前源码事实 | 结论 |
|---|---|---|
| `gate.rs` C0/L1b | 无票路径在 `:285-286` 进入 `decide_l2`；L1b registry `contains` 在 `:310-313` | 语义存在；design 中 `:430-455` 是行号漂移，不是语义漂移 |
| `registry.rs` 行格式/generation/reload | `Record/Op` 在 `:35-50`；generation 在 `:115-121`；load/归并 `:144-192`；append+fsync `:206-229`；reload `:260-270` | owners 同构基座真实，新增台账仍待实现 |
| `relay.rs` gate/open/Deny | open 模式仅在 `:46-48` 装 gate；`on_connect` Deny 臂在 `:130-143` | relay-only KnockLog 挂点吻合 |
| rendezvous 门控 | resolve 处理在 `:305-325`，restricted 为 bearer-only；匿名 resolve 测试在 `:797-827` | 无票 resolve=401 的收窄有源码依据 |
| `access/admin.rs` / OnlineTable | receipt canonical 在 `:466`；OnlineTable 投影在 `gate.rs:124-208`；断连在 `admin.rs:380-397` | 103B/投影/断连基座真实，新 op 与 visitor 投影待实现 |
| `sidecar.mjs` | setup→ready 状态在 `:172-180`；pairing 单飞 `:422-455`；现有 ready 后 target-frozen `:363-365`；`validateTarget` 在 `target.mjs:30-106` | 基座安全面真实；节点簿 switch 是本 change 的受控例外，尚无实现 |

## 3. r3 处置逐条核对

| r3 处置 | 状态 | 证据与判断 |
|---|---|---|
| P0-1 码级 reservation/三元组幂等 | **部分闭合** | `specs/server/spec.md:196-197,246-254` 已冻结 code-wide pending、其他键 409、完整三元组去重、durable 后同键 200；但 code 校验序仍先写 exhausted，`design.md:116-120` 仍写同键耗尽后 `code-exhausted`，没有明确同键幂等检查优先级/重放有效期。max_uses>1 只有隐含串行语义，没有正向场景。 |
| P0-2 每次加载 reconciliation/fail-closed | **部分闭合** | `specs/server/spec.md:198,256-259` 和 `tasks.md:30-33` 已覆盖启动+mtime reload、同锁、旧快照保留、受影响码 fail-closed、告警重试；但首次启动没有“旧快照”，也未定义禁兑码的状态表示、成功重试后的清除、进程重启后的可用性。 |
| P1-1 KnockLog 主键统一 | **部分闭合** | 权威 requirement `specs/server/spec.md:159,186-189,290` 与 `tasks.md:37` 已是每次 deny 新 seq、列表 seq desc、逐出 seq 最小；但 `design.md:76-78` 仍按 last_at desc，`specs/server/spec.md:297-300` 场景仍断言按 last_at desc。 |
| P1-2 完整三元组匹配/去重 | **闭合** | `specs/server/spec.md:197,241-259` 明确 `(code_hash,fabric_id,root)` 匹配，consume 按键去重，`used_count` 为去重键数，旧行/管理员直加行不触发补写；max_uses>1 的粗匹配风险已消除。 |
| P1-3 supersedes 仓库级唯一合同 | **部分闭合** | `openspec/changes/webui-console/specs/webui/spec.md:13` 已加入 nodes.json 0600 与已存 node_id switch 两条例外；SAR spec 也保留 URL 不可注入、原子切换、在途快照和其余 target-frozen。但同文件 `:30-33` 的“任何 `/sidecar/*` 重指向均 target-frozen”未排除 switch，仍会让基座 Scenario 与例外互相否定。 |
| P1-4 PM resolve 残留 | **部分闭合** | 角色表与 T2 已部分限定 relay/持票 resolve，验收 `PRODUCT-DESIGN.md:405` 也写了无票 resolve 401；但 `PRODUCT-DESIGN.md:84` 仍写访客“resolve 命中”，`:140` 写设备“从此可被 resolve 找到”，`:261` 写访客可查找租户门牌，`:357` 写访客“进楼找人”，均未限定持票/Phase 2。 |
| P2-1 O-9 open 模式 | **闭合** | `design.md:161-164`、`PRODUCT-DESIGN.md:247,425`、`tasks.md:17` 明示 open 不装 gate、blocklist/敲门台整体不生效，并已有负向测试任务。 |
| P2-2 重放/中间层日志 | **闭合** | `specs/server/spec.md:199,236-239` 与 `tasks.md:33` 已规定同键重放 200、换 fabric/root 的跨键重放因 PoP 失败、服务端及反代/access-log/tracing 禁记 `/register` body。残余取舍是同键重放可续期，见 P1-1。 |

**处置统计：闭合 3/8，部分闭合 5/8，未闭合 0/8。新问题：P0=0、P1=6、P2=1。**

### 安全与专项结论

- **PoP**：`specs/server/spec.md:195` 的域含 `code + fabric_id + root + ts`，验签键是
  `body.root`，可阻止以他人 `(fabric_id, root)` 冒名。`fabric_id` 仍是自声明标签，
  同 fabric 多 root 合法；UI 二元组与钓鱼警示是必要缓解。±120 秒窗口允许同键重放，
  不能在未钉死续期边界前视为纯网络重试。
- **IP 限流**：`spec.md:195,231-234` 与 `tasks.md:29` 冻结为直连 TCP peer；XFF/
  Forwarded 不采信。反代下用户聚合、trusted-proxy CIDR 延后 Phase 2，取舍明确。
- **访客身份/配额**：relay `ClientRequest` 的 endpoint 是 E1 密码学握手身份，
  rendezvous 声称的 endpoint 不入 KnockLog；per-endpoint 4 + 全局 64 已冻结。多 key
  Sybil 仍能消耗全局访客配额，已标为 Phase 2 残余。
- **邀请码**：OS CSPRNG 的 80bit 码、BLAKE3 哈希存储和零码全文日志纪律已冻结；
  文件泄露后可离线验证候选码，但 80bit 穷举成本高，主要依赖 `codes.jsonl` 权限。
  全文仅签发响应一次、代理/access-log/tracing 禁记 body 已写入 spec；状态 oracle
  （invalid/exhausted/expired）是明示产品取舍。仍需钉死同键旧码是否可无限续期。
- **节点簿/基座**：例外没有削弱 token 不出浏览器、pairing 单飞、`validateTarget`、
  Host/Origin 或 SSRF 防护；问题是基座旧 Scenario 的“任何 sidecar 重指向”仍未显式
  排除 switch，属于合同可执行性问题而非已发现的安全回退。
- **pending 与 max_uses**：当前 code-wide pending 串行化是可实现的：K1 consume
  durable 后释放，max_uses>1 的 K2 才按剩余次数裁决；同键不重复 consume。设计仍需
  明示 `max_uses=2: K1→K2` 和“同键 durable 后响应丢失重试”的测试，并选择同键重试
  是纯幂等回执还是允许续期。

## 4. 新问题清单

### P0（阻塞）

无。

### P1（须修）

#### P1-1：KnockLog 排序合同仍有双主键

证据：`openspec/changes/server-access-roles/design.md:76-78` 写“组内 `last_at`
降序、seq 降序”；`specs/server/spec.md:297-300` 场景写“按 last_at 降序”，而权威
条款 `:159,186-189,290` 已冻结 `seq desc` 且 `last_at` 仅展示。实现者按 design 或
场景实现会重新引入时钟回拨依赖。

修复：删除所有 last_at 排序表述，统一为未处置优先、组内 seq desc、endpoint_id asc
最终 tie-break；增加回拨/相同展示时间的属性测试。

#### P1-2：同键幂等与一次性码续期优先级未唯一化

证据：`design.md:116-120` 仍说同 `(code,fabric_id,root)` 在 used 耗尽后返回
`code-exhausted`，但 `design.md:137-140`、`specs/server/spec.md:197,251-254` 要求
同键 durable 后返回 200、不重复 consume，并写了 register 续期。`spec.md:195` 的校验
序又把 exhausted 检查放在 PoP 之前；`PRODUCT-DESIGN.md:139` 还说“再拿同码注册被拒”。

这不仅是旧文案：若任意同键请求都可在耗尽后走“续期 200”，持有 root 私钥者可用旧的
一次性码持续生成新 ts 签名并刷新租期；若先走 exhausted，则响应丢失后的合法重试又
无法满足 200。当前没有 replay window、请求 id 或“只返回已缓存结果、不再刷新 expires”
的界线。

修复：在 spec 中明确幂等检测与 code 状态检查的顺序和生命周期，区分“未完成兑换补写/
响应丢失的同一结果”与“持新有效码的续期”；明确旧码是否还能刷新 `expires_at`，并加入
max_uses=1/2 的同键、他键、过期码和响应丢失测试。同步 design/schema，consume 事件
显式携带 `fabric_id/root`（当前 `design.md:95-97` 的事件示例未列出这两个字段）。

#### P1-3：reconciliation 首次加载的 fail-closed 状态不可实现唯一

证据：`specs/server/spec.md:198,258-259` 要求“保留旧快照 + 该码禁止兑换 + 告警重试”，
但首次启动没有旧快照；也没有定义禁兑码是内存集合、台账事件还是独立标记，成功重试
何时清除，进程重启后如何处理 IO 仍失败。

修复：冻结首次加载失败策略（例如相关台账不可用则服务不 ready，或加载可读旧快照并把
受影响 code 加入内存 deny-set），定义 retry 成功/mtime reload/重启的状态迁移与告警
可观测字段，并增加无旧快照故障注入测试。

#### P1-4：PM 产物仍承诺无票 resolve/访客找房

证据：server spec/design 已冻结无票 resolve 401、访客 v1 仅 relay；但
`PRODUCT-DESIGN.md:84,140,261,357` 仍用“resolve 命中”“可被 resolve 找到”“查找租户
门牌”“访客进楼找人”等未限定文案。

修复：租户路径明确为“持票 resolve”；访客路径改为“已知 endpoint 直达 relay，定向
解析为 Phase 2”；验收和 UI copy 用同一条 401 场景对拍。

#### P1-5：PM 节点簿仍保留“重启切换”旧合同

证据：`PRODUCT-DESIGN.md:93,161` 仍写“切换 = sidecar 重启”及“切换会重启本地后台
进程”；同文件 `:302`、`proposal.md:77-78`、`design.md:225-227` 与 SAR webui
spec 已冻结为进程内即时切换、只接受已存 `node_id`。这会让验收者按旧文案期待重启，
也会使实现者不清楚是否需要保留进程生命周期边界。

修复：删除对象树/N5 的重启语义，统一为“进程内原子切换；在途请求使用开始时快照；
仅节点簿已存 node_id 可切换”，并保留退出重启仅作为未加入节点簿的通用 fallback。

#### P1-6：webui-console 基座 Scenario 未排除节点簿 switch

证据：`openspec/changes/webui-console/specs/webui/spec.md:13` 新增仅已存 `node_id`
switch 的受控例外，但同文件 `:30-33` 仍写任何 `/sidecar/*` 重指向均返回
`target-frozen`、需重启。SAR 的“后 change 覆盖前 change”说明能表达意图，但独立运行
基座测试时仍存在直接文字冲突。

修复：把既有 Scenario 改为“除 `/sidecar/nodes/switch` 外的任何重指向”，并新增
switch 只接受已存 node_id、拒绝新 URL、在途请求使用开始时快照的正向/负向场景；保留
token 不出浏览器和其余 target-frozen 断言。

### P2（建议）

#### P2-1：max_uses>1 的正向序列与 fail-closed 可观测性测试不足

`tasks.md:33,37` 已有 pending/seq/热重载测试，但没有明确 `max_uses=2` 下 K1 成功、
K1 重试不增 consume、K2 在 K1 durable 后成功的 e2e，也没有对 fail-closed 码的告警/清除
状态断言。可作为 P1 修订后的实现期验收补充，但应在 task matrix 中列出。

## 5. [R1]-[R8] 满足度核查

| 裁决 | 判定 | 理由 |
|---|---|---|
| R1 公钥即地址 | 满足（边界已冻结） | relay 握手身份可直接敲门；无票 rendezvous resolve 维持 401，签名 resolve 延期 Phase 2。PM 仍有残留措辞。 |
| R2 默认 key | 满足 | CLI identity spec 固定默认 root key、fabric 生成/复用、join 非零失败与明文守卫。 |
| R3 敲门台 | 满足 | relay Deny 臂且仅 E1 endpoint 入账；dismiss/undismiss、复位、pending_count、unknown 404 与 webui 动作已定义。 |
| R4 邀请码 | 部分 | PoP、80bit、consume、双 fsync、三元组去重、pending 与恢复已写；同键旧码续期边界和首启 fail-closed 仍未唯一化。 |
| R5 租户到期 | 满足 | owners expires_at、`now >= expires_at`、owner-expired、续期及存量连接语义均已冻结。 |
| R6 alias+缩写 | 满足 | alias + 首尾缩写、全文复制/title、二元组呈现与钓鱼警示已覆盖。 |
| R7 节点簿 | 部分 | 0600、原子 rename、拒 symlink、token 边界与仅存 node_id switch 已写；基座旧 Scenario 和 PM 重启文案仍冲突。 |
| R8 名单制 | 满足（按范围修订） | roster/static/callback/open 的本轮落地和 fabric wire 三制 Phase 2 延期链已存档。 |

## 6. 设计层 GO 条件

本轮无 P0，但不能以“无 P0”自动放行。满足以下条件后，可把本 change 判为设计层
GO 并进入实现：

1. 统一 KnockLog 的所有排序/逐出文字与场景为 seq 主键；
2. 明确同键幂等的优先级、重放/续期寿命和 max_uses>1 行为，删除 design/spec/PM
   互相矛盾的旧句，并补齐 consume schema；
3. 冻结 reconciliation 首次加载、禁兑码状态、retry/clear/restart 迁移；
4. 修正 PM resolve 与节点切换文案；
5. 修正 PM 节点簿的重启旧文案；更新 webui-console 基座 Scenario，形成唯一的 switch 例外合同，并把上述边界
   写入可执行测试矩阵。
