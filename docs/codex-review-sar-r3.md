# server-access-roles 设计定稿轮 r3 delta 复审

## 1. 结论与评分

**评分：6.8/10（相对 r2 的 6.3/10，上升 0.5）。判定：NEEDS-WORK。**

r2 的主要方向已落入最终文件：relay-only 敲门、邀请码 consume 事件、先
register 后 consume 的崩溃恢复、业务 `/api/*` 路径、统一两入口、register
receipt generation、`pending_count` 与 undismiss 契约均已有规范文字和测试任务。
但当前仍有一个实现前置的 P0：consume fsync 失败且进程存活时没有可持久化/可验证
的码级 reservation 与幂等身份；第二个请求可能在 pending 补写窗口看到旧
`used_count`，破坏 `max_uses`。另有 KnockLog 排序合同冲突、热重载恢复未钉死、
webui-console 基座仍双写互斥条款，以及 PM 文案仍承诺访客 resolve。故不能进入
实现 GO。

## 2. 验证证据

### 基线与命令

| 项目 | 结果 |
|---|---|
| `git rev-parse HEAD` | `c183185a7a772511db25ce489f36e26622cb33cc` |
| `git diff --stat 033e088..c183185` | 5 files, 227 insertions, 19 deletions（含 r2 报告） |
| `git diff --check 033e088..c183185` | 通过 |
| `openspec validate server-access-roles --strict` | `Change 'server-access-roles' is valid` |
| `openspec validate sdk-mgmt-surface --strict` | `Change 'sdk-mgmt-surface' is valid` |
| `openspec validate webui-console --strict` | `Change 'webui-console' is valid` |

本轮 diff 没有实现代码；没有把 runtime/e2e 测试当作已完成证据。strict 只证明
artifact 结构合法，不证明跨文件提交、热重载、并发或基座合同兼容。

### 源码锚点核对

| 设计锚点 | 当前源码事实 | 结论 |
|---|---|---|
| `gate.rs` C0/L1b | `crates/dweb-server/src/access/gate.rs:285-286` 无票直接进入 `decide_l2`；`:310-313` 仍为 `snapshot.contains` | 锚点真实，visitor/blocklist/expiry 是待实现改造位 |
| `registry.rs` 行格式/generation | `crates/dweb-server/src/access/registry.rs:33-47` 的 Record/Op；`:115-121` generation；`:158-192` 归并；`:206-229` append+fsync | 锚点真实；新台账同构和 `via_code_hash` 尚未实现 |
| relay gate | `crates/dweb-server/src/relay.rs:46-48` 仅有 gate 才装配；`:130-138` 是 `on_connect` Deny 臂 | open 不装 gate、KnockLog 未来挂点均吻合 |
| rendezvous | `crates/dweb-server/src/rendezvous.rs:212-237` 共享 ACL；`:305-325` resolve 无请求方握手身份 | 访客 resolve 不能直接取得已认证 endpoint，relay-only 收窄有源码依据 |
| admin/OnlineTable | `crates/dweb-server/src/access/admin.rs:463-480` 是 103B canonical；`gate.rs:124-208` 是现有 per-owner OnlineTable | 103B/投影基座真实，Option<fabric>/新 op 尚待实现 |
| sidecar | `packages/webui/src/sidecar.mjs:172-180` setup→ready；`:422-455` pairing 单飞；`:363-365` ready 后 target-frozen；`src/target.mjs:30-106` validateTarget/DNS 冻结 | 基座边界真实，节点簿切换仍是本 change 的受控例外 |

## 3. r2 处置逐条核对

| r2 处置 | 状态 | 最终文件证据与判断 |
|---|---|---|
| 1. 跨台账先 register 后 consume、恢复补齐 | **部分闭合** | `specs/server/spec.md:193-196,238-241`、`design.md:125-134`、`tasks.md:30-32` 已写顺序、双 fsync、启动补 consume、存活失败 500+挂起。但未定义 pending reservation/幂等键、恢复匹配是否为 `(code_hash,fabric_id,root)`、consume 已 durable 但响应丢失时的重试；见 P0-1/P1-2。 |
| 2. design 旧 visitor/CLI/rendezvous 语义清除 | **闭合（KnockLog 排序除外）** | `design.md:26-31,55-57,156-166` 已是 admin+文件两入口、relay-only、debug-only rendezvous、consume；旧语义未再作为主流程。 |
| 3. WebUI 业务路径改 `/api/*` | **闭合** | `specs/webui/spec.md:5,24,57,73`、`design.md:206-224`、`tasks.md:44-48` 均将业务面固定为 `/api/*→/admin/*`，`/sidecar/nodes*` 仅控制面。 |
| 4. 四台账入口统一 admin API+文件 | **闭合** | `design.md:26-31` 与 `tasks.md:15` 一致：不新增 CLI mutation，owners 既有 CLI 保持不动不扩。 |
| 5. supersedes 优先级/归档增补 | **部分闭合** | `specs/webui/spec.md:71-73` 已明确实现窗口“后 change 覆盖前 change”、归档时基线增补和负向测试；但 `webui-console/specs/webui/spec.md:5-7,30-31` 仍是 token 不落盘/target-frozen 绝对条款，`.openspec.yaml` 无依赖或 supersedes 元数据。文本意图已清楚，仓库级可机械执行的唯一合同仍未形成。 |
| 6. receipt generation、undismiss、pending_count | **闭合** | `specs/server/spec.md:196,243-251,258-277` 明确 register receipt 用 owners generation、unknown dismiss/undismiss=404、`pending_count` 恒按未 dismissed 数且不随 include_dismissed 改变；`tasks.md:36-40` 有对应测试。 |
| 7. seq/时钟回拨/锁内后写胜 | **部分闭合** | `specs/server/spec.md:159`、`tasks.md:36` 已写每次 deny 新 seq、锁内后写胜；但 `spec.md:159,189,272`、`design.md:63-77`、`tasks.md:19` 仍用 `last_at` 作为列表/逐出主键，和“seq 主排序、last_at 仅展示”冲突。见 P1-1。 |
| 8. design §5 测试矩阵同步 | **闭合（合同冲突仍需修）** | `design.md:244-250` 已加入崩溃恢复、unknown 404、pending_count、undismiss/复位、seq tie-break、路径契约、节点簿负向测试；`tasks.md:30-56` 也有对应验收项。但任务行 19 的旧 `(last_at,seq)` 逐出表述仍需同步。 |

**统计：闭合 5/8，部分闭合 3/8，未闭合 0/8。**

### 安全结论与残余风险

| 面 | 结论 |
|---|---|
| `/register` PoP | 签名域在 `specs/server/spec.md:195` 含 `code,fabric_id,root,ts`，验签键为 body.root；能阻止以他人 `(fabric_id,root)` 冒名，但 `fabric_id` 仍是自声明标签。同一签名在 ±120s 窗口可重放；无 nonce/请求 id，需与码级幂等一起钉死。 |
| 限流 IP | `specs/server/spec.md:118,195,228-231` 与 `tasks.md:29-31` 冻结直连 TCP peer；XFF/Forwarded 不采信。反代下多个用户聚合、trusted-proxy 属 Phase 2，风险已明示。 |
| 访客身份/配额 | relay `ClientRequest` 的握手 endpoint 是 E1 密码学身份；借用/伪造 endpoint 需其私钥。per-endpoint 4 + 全局 64 已落 spec，但多 key Sybil 仍可消耗全局配额，Phase 2 残余。 |
| 邀请码 | 80bit OS CSPRNG、Blake3 哈希和服务端脱敏已冻结；错误状态 oracle 是有意取舍。取得 `codes.jsonl` 后仍可离线验证候选码（80bit 使穷举成本很高，但无 salt/pepper，依赖文件权限与主机信任）；分布式在线爆破与 ±120s 重放仍受 per-IP 限流之外，且规范只禁止服务端日志/指标/错误中的全文，尚未明确反向代理/access-log/tracing 不记录 POST body，建议实现前补红线。 |
| 节点簿 | `nodes.json` 0600、原子 rename、拒 symlink、token 不进响应/日志/浏览器状态已写入；但与 webui-console 基座合同仍双写，见处置 5/P1-3。 |

## 4. 新问题清单

### P0（阻塞）

#### P0-1：存活时 consume fsync 失败没有码级 reservation，`max_uses` 可被并发绕过

证据：`specs/server/spec.md:195-196` 只冻结 register→consume 顺序和双 fsync；
`:196`/`design.md:132-134` 仅写“500+挂起补写、同码重试幂等完成”，没有 pending
状态的持久化/锁保持/拒绝规则。若第一请求已经把 owners register fsync，consume
fsync 失败后释放临界区，第二个不同 `(fabric_id,root)` 请求可从尚未归并的
`used_count` 看到可用码并再次 register；这会产生一个 max_uses=1 的第二租户。若
重试在 consume 已 durable 但响应丢失后发生，当前“匹配”与重复 consume 去重也没有
定义。

**可验证修复：**为每次兑换冻结稳定幂等键（至少
`code_hash+fabric_id+root`）和码级 pending reservation；consume 未 durable 时其余
二元组必须拒绝/等待，只有同一幂等键可补写并复用结果。启动和每次 mtime reload
按完整 `(code_hash,fabric_id,root)` 匹配/去重 register 与 consume；补写失败时保留
旧快照并阻止该码继续兑换。增加“consume fsync 失败+并发第二根”“响应丢失后重试”
故障注入测试。

#### P0-2：跨台账承诺没有覆盖热重载失败路径

证据：四台账统一矩阵要求 mtime 热重载（`specs/server/spec.md:7,193`、
`tasks.md:15`），而恢复规则只写“启动归并”（`spec.md:196,238-241`）。实现者无法
判断 mtime reload 是否也要补孤儿 consume、补写失败是否保留旧 codes/owners 快照，
以及文件入口在运行时追加 register/consume 时如何与 pending lock 协调。只在启动恢复
处理会让进程存活期间的热重载短暂重新暴露已注册但未消费的码。

**可验证修复：**将 reconciliation 明确为每次 load/reload 的同锁步骤，定义失败
策略（保留旧快照、阻止该码、告警/重试），并增加“外部文件追加 register 后 mtime
reload”和“reload 与 consume 并发”的测试；或明确运行时文件入口只能经 server
协调器写入。

### P1（须修）

#### P1-1：KnockLog 的排序/逐出主键仍自相矛盾

证据：`specs/server/spec.md:159` 说每次 deny 新 seq、排序键为 seq，last_at 仅
展示；但同段容量逐出仍是 `(last_at,seq)`，`:189` 和 `:272` 仍是
`last_at desc, seq desc, endpoint_id asc`；`design.md:63-77`、`tasks.md:19` 也保留
旧主键。时钟回拨时，同一份台账会按 seq 排序却按 wall clock 逐出，无法满足宣称的
时钟免疫，两个实现者会得到不同 LRU。

**可验证修复：**统一为 `seq desc` 列表、`seq asc` 逐出，`endpoint_id` 仅作稳定
最终 tie-break；last_at 只展示。同步 spec/design/tasks 和属性测试（回拨时钟、同
毫秒、多端点、多次 deny）。

#### P1-2：启动恢复的“匹配 consume”没有定义复合键与重复事件规则

证据：`specs/server/spec.md:196,238-241` 只写“有匹配 consume”/“计数正确”，
没有规定匹配是否必须同时比较 code_hash、fabric_id、root，也没有规定重复 register
或重复 consume 事件如何归并。max_uses>1 同码多租户时，按 code_hash 粗匹配会漏补消费；
按事件计数又会把同一重试重复计入 used_count。

**可验证修复：**在事件 schema 中加入稳定 redemption id 或冻结复合幂等键；写出
归并伪代码/不变量：每个有效 register 恰对应一个 consume，旧行兼容不触发补写，
`used_count` 是去重后的 consume 数；补充多次使用、重复 register、重复 consume、
部分行/坏行恢复测试。

#### P1-3：supersedes 文本尚未变成仓库级唯一合同

证据：本 change `openspec/changes/server-access-roles/specs/webui/spec.md:73` 规定后 change 覆盖前 change，但基座
`openspec/changes/webui-console/specs/webui/spec.md:5-7,30-31` 仍以绝对语气禁止
token 落盘和运行时重指向；三个 change 的 `.openspec.yaml` 只有 `schema/created`，
没有依赖/覆盖元数据。两个 strict 校验都绿并不能阻止实现/CI 仍按基座负向测试否决
nodes.json 与 switch。

**可验证修复：**在归档或实现入口前将增补正式同步进 webui-console 基线（并保留
明确“仅 nodes.json/仅已存 node_id”的负向测试），或增加仓库支持的 supersedes/
depends-on 元数据与合并后合同 lint；验证两个 change 的 combined contract 只有一套
优先级。

#### P1-4：PM 产物仍描述访客可 resolve，直接回退 R1 relay-only 收窄

证据：`PRODUCT-DESIGN.md:47,75,130,405` 写“查找门牌（resolve）”“他 resolve 到
要找的门牌”及验收“访客可 resolve、不可 announce”；但 Owner 范围修订
`requirements.md:76-80`、server spec `:9,118,140-143`、design `:156-163` 已冻结
访客可达面仅 relay、无票 resolve 恒 401。实现/验收若以 PM 文案为准会重新打开
rendezvous 访客面。

**可验证修复：**删除这些 resolve 承诺，改成“已知 endpoint 直接 relay 敲门；
rendezvous resolve 需 capability，访客签名 resolve 为 Phase 2”，并把 PM 验收剧本
与 server spec 的 401 场景对拍。

### P2（建议）

#### P2-1：O-9 仍未从 PM 开放问题收敛

`PRODUCT-DESIGN.md:247,425` 仍把 open 模式 blocklist 是否生效列为待 Codex 裁决；
`design.md:150-153` 与 server spec `:10` 已冻结 open 不装 gate、blocklist 不生效。
这是技术合同已有答案后的文案漂移。将 O-9 标为已裁决并删除条件式建议，补一条
open 模式负向测试即可。

#### P2-2：公开兑换的重放与中间层日志红线仍不完整

当前 ±120s 只限制时间，不阻止同一完整签名请求在窗口内重复提交；状态 oracle 是
有意取舍，但反向代理/access-log/tracing 是否禁止 body 记录没有规范边界。实现前可
选择加入一次性 redemption nonce/idempotency key，或明确这是接受的残余，并冻结
网关/反向代理的 body 脱敏和错误日志规则。

## 5. [R1]-[R8] 满足度核查

| 裁决 | 判定 | 理由 |
|---|---|---|
| R1 公钥即地址 | 满足（有边界） | relay 握手 endpoint 即身份，visitor 无票通行限定 relay；rendezvous 访客面明确延期。 |
| R2 默认 key | 满足 | `specs/cli/identity/spec.md:5,19` 固定默认 key、`id` 只读、`join` 有 fabric 复用/生成和非零失败。 |
| R3 敲门台 | 满足（relay-only） | `specs/server/spec.md:157-184` 与 webui spec 四动作提供可见、授权、拉黑、忽略；rendezvous 不入 endpoint 台账是安全收窄而非 R3 回退。 |
| R4 邀请码 | 部分 | 默认 1/7 天、PoP、join、consume 和恢复已写；P0-1/P1-2 仍使并发/恢复幂等不可唯一实现。 |
| R5 租户到期 | 满足 | owner expires_at、`now >= expires_at`、owner-expired、续期/存量连接语义均冻结。 |
| R6 alias+缩写 | 满足 | 全站 alias + 首尾三位缩写、全文 title/复制和二元组防钓鱼已写。 |
| R7 节点簿 | 部分 | nodes.json 0600、token 不出浏览器和仅已存 node_id switch 已写；但与基座的 supersedes 合同尚未落成唯一可执行基线。 |
| R8 名单制 | 满足（按 Owner 范围修订） | requirements 范围修订明确 server roster/static/callback/open 本轮落地，房门级 fabric wire 三制/混合延期 Phase 2。 |

## 6. 实现前必须钉死的开放项

- `design.md:254-264` 的 r1 遗留项已有边界：fabric genesis proof、访客 Sybil、
  trusted-proxy CIDR 属 Phase 2；不阻塞本轮，但需保留 UI 自声明标签警示。
- PRODUCT-DESIGN O-1/O-2/O-3/O-7/O-8/O-10/O-11 可沿用当前默认（访客长期、内存
  待办、只挡新连接、新 deny 复位、后写胜、Phase 2 时机、首现术语定义），并在实现
  测试/文案中保持一致。
- O-4 已由 root PoP 收窄为“阻止同一 `(fabric_id,root)` 冒名但不证明 fabric
  所有权”；不要把 UI 钓鱼警示写成 genesis proof。
- O-5/O-6 需与 P0-1/P2-2 一起落成：公开码的在线重放/代理日志边界，以及 `join`
  创建或复用 fabric 的失败/重试体验。
- O-9 不是开放问题了，应按 P2-1 记录为 open 模式门禁整体不生效。
