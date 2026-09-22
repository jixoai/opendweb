# server-access-roles 设计定稿轮 r1 评审

## 1. 结论与评分

**评分：5.0/10。判定：NEEDS-WORK。**

文档结构完整，三项 OpenSpec strict 校验通过，现有 relay/gateway/admin/sidecar 锚点大多真实且语义可对应；PoP 域已按冻结形态包含 `root`。但当前定稿仍有 6 个 P0：公开注册的一次性邀请码没有可持久化、并发原子消费事件；rendezvous 敲门记录使用了未认证的 endpoint 身份；访客 rendezvous 可达面在同一 change 内互相矛盾；节点簿同时违反基座的 token 不落文件和目标冻结契约；R8 的房门三制被明确延期。另有多项 P1 会阻止实现者得到唯一、安全的实现。

## 2. 验证证据

### 实际命令

| 命令 | 结果 |
|---|---|
| `git rev-parse HEAD` | `d87620313b92383afd6d06edc0b9241d0cabd35f`，与题定基线一致 |
| `openspec validate server-access-roles --strict` | `Change 'server-access-roles' is valid` |
| `openspec validate sdk-mgmt-surface --strict` | `Change 'sdk-mgmt-surface' is valid` |
| `openspec validate webui-console --strict` | `Change 'webui-console' is valid` |
| `node --test packages/webui/test/*.mjs` | 91/91 pass；文档中“既有 90 测试”已漂移 |
| `git diff --check d876203..HEAD` | 通过，无 whitespace error（当前评审基线） |

Strict 校验只证明 artifact 结构合法，不证明跨文档语义、runtime wiring、并发或安全闭环。

### 源码锚点核对

| 设计引用 | 实际源码事实 | 结论 |
|---|---|---|
| `gate.rs` C0/L1b | `crates/dweb-server/src/access/gate.rs:277-312`：C0 无票直接进 `decide_l2`，L1b 仍是 `snapshot.contains`；没有 visitor/blocklist/expiry 分支 | 锚点存在，但新分支尚未存在，设计改造位置正确 |
| `registry.rs` 行格式/generation/hot reload | `crates/dweb-server/src/access/registry.rs:33-40` 的 Record 只有 `op/fabric_id/root/ts`；`142-192` 归并、`260-273` reload；`291-369` 只有 owners CLI | “同构模式”基座真实；metadata/serde(default)/三台账 CLI 仍须设计补齐 |
| relay Deny/open | `crates/dweb-server/src/relay.rs:46-48` 仅在有 gate 时装配；`130-145` Deny/on_disconnect | 行号语义相符；open 模式确实不装 gate |
| rendezvous 门控 | `crates/dweb-server/src/rendezvous.rs:212-237` 经 `AccessGate`；`305-325` resolve 把路径目标 `id_bytes` 作为 `GateInput.endpoint_id` | ACL 锚点真实；resolve 没有请求方 endpoint 身份，不能直接当敲门人记录 |
| admin receipt/OnlineTable | `crates/dweb-server/src/access/admin.rs:463-480` 为 103B canonical；`490-555` 是旧 status wire；`gate.rs:182-208` 是 per-pair OnlineView | 基座投影/回执真实；visitor 投影与 op 0x04-0x0B 尚未定义/接线 |
| sidecar 状态机/配对/target | `packages/webui/src/sidecar.mjs:172-180` 是 `setup -> ready`；`199-203` 仅 `/api/*`、`/sidecar/*` 分流；`363-365` ready 后所有 POST target-frozen；`401-455` 配对单飞、validateTarget、成功即冻结；`packages/webui/src/target.mjs:30-106` 是目标守卫和解析 IP 冻结 | 基座安全边界真实，但节点簿的 ready 内切换/重复配对不是现有行为 |

### MODIFIED requirement 基线逐段对照

| MODIFIED 段落 | 基线对照 | 评审结论 |
|---|---|---|
| Server 访问策略：`openspec/specs/server/spec.md:225-257` ↔ `openspec/changes/server-access-roles/specs/server/spec.md:3-75` | access mode 优先级、static/callback 空 registry、generation、二元组精确匹配、unregister 只阻断新连接均保留；新增 owner 到期、访客、黑名单与元数据 | **无明显基线回退**；但 active disconnect 文案从“不在本 change 承诺”改为“管理面 disconnect”，必须与 sdk-mgmt-surface 的 disconnect 语义逐字接线 |
| relay capability：`openspec/specs/server/spec.md:259-360` ↔ `openspec/changes/server-access-roles/specs/server/spec.md:77-115` | L1 顺序、L1b registry/caps 底线、callback 不得豁免、错误 reason、配额/存量连接语义均保留；新增 `owner-expired` | **无明显基线回退**；实现必须继续保证无效票不进 webhook，不能因 visitor 分支改变有票路径 |
| rendezvous ACL：`openspec/specs/server/spec.md:362-389` ↔ `openspec/changes/server-access-roles/specs/server/spec.md:116-153` | announce 的签名/recipient、resolve bearer-only、401、open 模式现状均保留；新增 visitor 可达面声明与 per-IP 限流 | **基线验证链保留，但新增 visitor 语义自相矛盾**：同一 delta 的 requirement 早段声称 visitor 可 resolve，后段又冻结无票 resolve=401（P0-6） |

## 3. 问题清单

### P0（阻塞）

#### P0-1：rendezvous KnockLog 记录的 endpoint_id 不具备请求方身份认证

证据：`crates/dweb-server/src/rendezvous.rs:305-315` 在 resolve 中把 URL 路径目标作为 `endpoint_id`；`240-250` 的 announce 也在签名验证前执行 ACL；`openspec/changes/server-access-roles/design.md:51-61` 与 `specs/server/spec.md:157-179` 却要求 Deny 臂按 endpoint 聚合。

攻击者可用无票 HTTP 请求任意声称的 endpoint_id，制造敲门、污染 4096 LRU，甚至诱导管理员给错误公钥授权；匿名 resolve 根本没有调用方 endpoint。relay 的 `ClientRequest::endpoint_id()` 由握手认证，不能把同一假设套到 rendezvous HTTP。

修复：KnockLog 只接受 relay 握手认证的 endpoint；announce 必须在签名/身份校验后记录；匿名 resolve 不记录 endpoint（或另设 source-IP 维度的 abuse 计数，不能进入“谁在敲门”台账）。spec 必须明确两类记录的身份来源，并加入伪造路径测试。

#### P0-2：邀请码没有消费事件、并发 CAS 或重启后的 used_count 事实源

证据：`specs/server/spec.md:181-185` 的 `codes.jsonl` 事件只有 `issue|revoke`，但同段要求兑换后 `used_count+1`；`tasks.md:24-27` 也只写 used/expires 和兑换矩阵。没有 append-only 的消费事件或原子更新规则，两个并发请求都可能看到 `used_count < max_uses`，重启后还可能丢失消费计数。

修复：冻结 `consume/redeem` 事件格式、按 `code_hash` 串行/CAS、fsync 成功后才返回 200、reload 归并规则和失败回滚；将“max_uses=1 并发双兑恰一个成功”加入 e2e。兑换响应不得在持久化前签发回执。

#### P0-3：节点簿持久化 token 违反 webui-console 冻结的 token 边界

证据：基座 `openspec/changes/webui-console/specs/webui/spec.md:3-7` 明确 admin token **不得写入任何文件**；本 change `openspec/changes/server-access-roles/specs/webui/spec.md:69-71` 却冻结 `nodes.json` 条目含 `token`，`design.md:165-168` 也如此。

`0600` 只能降低普通文件读取风险，不能把“不得落盘”变成兼容。实现前必须二选一：改用 OS credential store/加密密钥环并明确恢复语义，或由 Owner 明确批准对基座契约的版本化例外；仅写一条“0600”不足以闭环。

#### P0-4：节点簿切换违反基座的“目标一经设定即冻结”契约

证据：基座 `openspec/changes/webui-console/specs/webui/spec.md:6-7,28-31` 要求 ready 后任何 `/sidecar/*` 重指向返回 `target-frozen`、重新指向必须重启；本 change `specs/webui/spec.md:69-81` 要求 ready 进程内原子切换，`design.md:169-176` 明确“不重启”。当前实现 `packages/webui/src/sidecar.mjs:363-365` 对 ready 的所有 POST 一律拒绝。

修复：在 change 依赖矩阵中明确“节点簿 route 是基座例外”并更新基座 spec/测试，或保留重启语义并把 switch 设计成受控重启。不能同时声称 target freeze 不变和允许运行时换 target；还需固定并发 proxy 与 switch 的 target+token 原子快照语义。

#### P0-5：R8 的两种房门策略被非 Goals 明确延期

证据：Owner 裁决 `requirements.md:54-60` 把完全放行、租户名单、包租婆名单及混合列为 [R8]；`proposal.md:82-87` 明确不做 fabric wire、租户侧门和完全放行房门，`design.md:7-20` 只映射 server-level visitor/blocklist。

当前方案最多实现包租婆名单的部分（且 open 模式 blocklist 不生效），没有完全放行/租户名单的可执行协议。若 R8 仍是本轮不可挑战输入，必须纳入本 change；若 Owner 同意 Phase 2，需把 requirements/范围改成显式延期并重新裁决，而不是在定稿中同时标记“全量一次做”。

#### P0-6：访客 rendezvous 可达面在同一 change 内互相矛盾

证据：`specs/server/spec.md:7-10` 写访客“relay + rendezvous resolve”；同文件 `:116-148` 又冻结访客可达面为空并要求无票 resolve 401；`design.md:116-126` 和 `tasks.md:193` 也明确 relay-only/401。

修复：若采用当前安全收窄，删除/改写 line 9 的 rendezvous resolve 承诺，并同步 proposal/PRODUCT-DESIGN；若 R1 必须支持发现，则另行冻结带身份绑定的 signed resolve。实现者不能从矛盾文本推导唯一行为。

### P1（须修）

#### P1-1：PoP 关掉了 root 冒名，但没有关掉 fabric_id 自由声明

证据：`design.md:82-103` 明确 body.root 自验且“body.fabric_id 与 root 的关系不校验”；源码事实是 `Roster::create` 使用随机 FabricId（`crates/dweb-fabric/src/roster.rs:204-233`），Genesis 只由 root 签名（`crates/dweb-fabric/src/protocol.rs:655-672`）。

攻击者可用自己的 root 对任意已知/猜测的 fabric_id 签名并兑换，形成同 fabric_id 的第二 root 条目。它未必能加入受害者 fabric roster，但会污染租户身份、alias、配额和管理面。修复为提交可验证的 signed Genesis/fabric-binding proof，或明确接受“fabric_id 是租户自声明标签”的安全语义并在 UI/审计中区分；不能把当前形态描述成“完整 PoP”。

#### P1-2：per-IP 限流没有冻结 IP 来源，X-Forwarded-For 可被伪造

证据：`specs/server/spec.md:183-185` 和 `tasks.md:25-26` 只写“per-来源-IP”；gateway 当前 `main.rs:458-492` 使用普通 `axum::serve`，没有 `ConnectInfo<SocketAddr>` 或 trusted-proxy 解析，仓库也没有该端点的 XFF 规则。

修复：默认只取直连 TCP peer，明确忽略 XFF/Forwarded；若部署在反代后，增加显式 trusted proxy CIDR 与 hop 规则，非可信来源的 XFF 一律拒绝采信。补 XFF 伪造、共享代理和 IPv4/IPv6 归一化测试。

#### P1-3：邀请码 80bit/Blake3 的离线与日志泄露边界未钉死

80bit CSPRNG 码对在线猜测足够强，BLAKE3 预映像离线枚举仍约为 2^80；但当前 spec 未要求 CSPRNG、哈希比较策略、请求/反代/APM/trace 日志禁止记录 body.code，也未处理 `invalid/exhausted/expired` 错误作为状态 oracle 的残余面。

修复：冻结 OS CSPRNG、规范化码输入（prefix/大小写/4-4-4-4 分组的 hash 输入）、所有日志/指标/错误不得含 code 全文；必要时使用 server-side pepper；对公开端点评估统一错误或明确状态泄露是产品取舍。

#### P1-4：visitor quota 按 endpoint 计，无法阻止多 key 聚合绕过

证据：`design.md:40-49` 与 `specs/server/spec.md:7-10` 只定义每 visitor endpoint 默认 4 条；relay 仅从握手取 endpoint（`relay.rs:95-120`）。E1 使“借用已有 endpoint”需要私钥，不能伪造已有 key，但攻击者可以廉价生成大量新 key，绕过 per-endpoint 配额并耗尽 relay/KnockLog。

修复：增加全局 visitor connection 上限、按 source-IP/握手来源的 admission bucket、KnockLog 新 endpoint 速率上限，并明确 visitor→tenant 后是否迁移/不迁移配额；配额检查必须与 disconnect release 同锁配对。

#### P1-5：三份新 jsonl 没有把 owners 的三入口同构纪律落到 tasks/设计矩阵

证据：spec `:7-10,183` 概括了坏行 fail-fast、generation、mtime reload、serde(default)；但 `design.md:26-32` 只对 visitors 写 CLI 三入口，`:107-113` 对 blocklist 只写“热重载同 registry”，`tasks.md:15-26` 也没有 codes/blocklist 的 CLI/坏行/generation 测试项。

修复：为 owners/visitors/codes/blocklist 建共享 registry trait/状态矩阵，逐项冻结 startup fail-fast、reload 失败保留旧快照、generation 递增、mtime 指纹、CLI/admin/文件三入口和旧行兼容；每个 ledger 都要有独立坏行、重载、并发写测试。

#### P1-6：visitor registry 变更没有进入 callback cache 的 generation

证据：当前 callback cache 调用只使用 owner snapshot generation（`gate.rs:359-366`）；设计的 visitor 分支在 `design.md:26-39` 位于 callback 前，但没有规定 visitor grant/revoke 如何清缓存。

在 callback 模式下，某 endpoint 的无票 `allow=true` 可能仍命中旧 cache；随后 revoke visitor 不一定立即回落为拒绝。修复：cache key/invalidator 纳入 visitor generation，或 visitor revoke/grant 原子清空相关 endpoint/event 缓存，并加入 revoke-after-cached-allow 测试。

#### P1-7：visitor 在线投影使用 sentinel fabric 的方案不安全且 wire 未定义

证据：`design.md:40-46` 在 `[0u8;32]` 与 `0xFF…` sentinel 之间自相矛盾；当前 `OnlineView` 的 fabric_id 是必填 32B（`gate.rs:124-148`），admin status 也只序列化 owner/per-endpoint 结构（`admin.rs:492-555`）。

修复：不要把可由真实 FabricId 取到的值当保留字；引入显式 `mode: visitor|tenant`/`visitor_id` 或 nullable fabric，并冻结 `/admin/status`、`/admin/connections`、webui 展示和排序。visitor 必须不进入 `per_owner`，但应有可枚举、可计数的独立投影。

#### P1-8：103B op 扩展没有同步 client-sdk 类型、映射与完整对拍向量

证据：tasks 只写 `tasks.md:31-33` “op 0x04-0x0B + fixture”；当前 `packages/client-sdk/admin/index.mjs:46-51,317-345` 只接受 register/unregister/disconnect，`index.d.mts:58-82` 的 union 也只有三种，fixture `crates/dweb-server/tests/fixtures/receipt-vector.json` 的 `ops` 只有 1–3。

修复：冻结每个新 op 的 JSON 形态、fabric/target 槽位、generation 来源和 target 字段；同步 TS helper/types、Rust vector generator、fixture 与跨语言对拍。`register-receipt/v1` 还需单独冻结客户端验证入口，不能只写“回执可验签”。

#### P1-9：webui 新 API 路径与基座 sidecar 路径不一致，旧 hash 映射不完整

证据：新 spec `specs/webui/spec.md:22-24,69-81` 使用 `/sidecar/*` 代理并给出 `/sidecar/api/status`；当前 sidecar `sidecar.mjs:199-203` 的业务代理是 `/api/*`，`/sidecar/*` 是本地控制面，ready 后还会在 `:363-365` 拒绝 POST。当前 `ui/src/lib/route.ts:1-27` 只有 overview/access/online/owners 的旧映射，`ui.test.mjs:31-49` 也只覆盖这些 15 个路由契约。

修复：以基座 `/api/* -> /admin/*` 为 canonical，或显式新增 `/sidecar/api/*` 并同步所有文档/测试；冻结 `#/tenants`、`#/visitors`、`#/knocks`、`#/invites` 等新 hash 和旧路由逐一映射。保留现有 91 个测试，再增加五个新 requirement 的 UI/API/错误态测试并重建 dist，不得以“旧测试全绿”代替新面覆盖。

#### P1-10：敲门“撤销忽略”与再次敲门语义没有服务端操作

证据：webui spec `:36-39` 要求 dismiss 后 toast 可撤销；admin API `server/spec.md:221-226` 和 `tasks.md:31` 只有幂等 dismiss，没有 undismiss；PRODUCT-DESIGN O-7（`PRODUCT-DESIGN.md:423`）又要求忽略后再次敲门重新冒出，但 KnockAgg 规则没有把新 deny 设回 `dismissed=false`。

修复：增加 `undismiss` 或带明确 CAS 的状态变更及回执；规定新事件是否自动清除 dismissed、toast 过期后的竞态、pending_count 和排序的 tie-break（建议 `last_at desc, endpoint_id asc`）。

#### P1-11：租户自助注册只有 HTTP wire，没有客户端/SDK 的可执行入口

证据：PRODUCT-DESIGN O-6（`PRODUCT-DESIGN.md:422`）明确询问 fabric_id 从哪里来；tasks 只有 `POST /register`（`:24-27`）和只读 `opendweb id`（`:50-53`），没有 root/fabric 创建、PoP canonical 签名或兑换 CLI/SDK API。

修复：冻结客户端先 `create_root`、取得随机 FabricId、构造 register canonical、发送 code、保存 receipt/到期的完整路径；至少提供 SDK helper 或 CLI，并把零文档验收剧本纳入测试。

#### P1-12：三角色管理回执的 generation 来源和路由响应形态不完整

证据：`specs/server/spec.md:217-226` 只给 op 枚举和路由摘要，没有定义 visitor/code/block/knock 新响应中的 target 字段、code 全文与 receipt 的组合，也没有说明 code/visitor/blocklist 各自 generation 还是 owners generation。

修复：增加一张 canonical/wire 映射表；所有 mutation 响应必须给出 `op/fabric_id/target/ts/generation/receipt_sig` 的确定字段，未使用槽位置零；generation 采用单一全局世代或带 ledger 前缀的明确世代，不能让客户端猜测。

### P2（建议）

#### P2-1：设计 §6 的“tokens.json”与正文 `nodes.json` 不一致

`design.md:197-204` 写 `tokens.json`，而 `design.md:165-176`、`specs/webui/spec.md:69-71` 写 `nodes.json`。统一名称并说明目录创建、原子替换、symlink/backup 防护和跨平台权限。

#### P2-2：KnockLog 的 4096 LRU 只有容量，没有可测的时间/并发契约

`design.md:51-59` 和 `specs/server/spec.md:157-179` 没有规定相同 `last_at` 的顺序、计数溢出、时钟回拨或 dismiss 与 deny 并发。建议使用显式序号作为 tie-break，`count` 饱和递增，并把锁内状态转移写成 property tests。

#### P2-3：到期/期限边界与输入上限未冻结

`expires_at` 的 exact boundary、`expires_in_days=0`、整数溢出、alias/note 长度、code max_uses 上限未在 spec 固定。应采用 `now >= expires_at`、checked arithmetic、明确最大长度/次数，并对错误码做矩阵测试。

#### P2-4：PM 与技术设计仍有节点切换旧文案

`proposal.md:72-74` 和 `PRODUCT-DESIGN.md:293-305` 写“切换会重启本地后台进程”，而 `design.md:169-176` 写进程内原子切换。应在实现前统一产品文案、过渡态和验收步骤，避免 UI/测试按不同生命周期实现。

## 4. [R1]-[R8] 满足度核查

| 裁决 | 判定 | 依据与残余风险 |
|---|---|---|
| R1 公钥即地址、持有 pubkey 可敲门 | **部分** | relay 访客名册/C0 分支能承载“已知 pubkey 直接敲门”；但 rendezvous resolve 被收窄为空，且 KnockLog 对 HTTP endpoint 身份不可信。必须明确 R1 的“访问”是 relay 连接而非发现 API。 |
| R2 一台设备一个默认 key，多 key 仅高级文档 | **满足** | `opendweb id` 与 README 任务覆盖默认 key、缩写、无私钥输出；需补数据目录/SecretStore 解析规则。 |
| R3 管理员在 webui 看到敲门并定位访客/租户 | **部分** | KnockLog、四动作和 visitor from-knock 已规划；callback allow 路径不入待办，HTTP rendezvous 记录又可伪造，且导入租户只是引导文案，尚未形成端到端可执行路径。 |
| R4 邀请码 1 次/7 天、可配置、自助注册 | **部分** | 默认值、PoP、公开端点和 UI 一次性显示均有；消费事件/CAS、日志脱敏、客户端兑换入口未冻结，不能宣称安全闭环。 |
| R5 租户默认 +30 天、可配置 | **满足（实现前须补边界）** | owners metadata、`contains_active`、`owner-expired`、renew 规划一致；需冻结 exact boundary、旧行兼容和 renew 保留 alias/note。 |
| R6 alias + `xxx***xxx` 防钓鱼缩写 | **满足** | 设计/spec/tasks 均定义首尾 3 hex、全文复制/title、全站统一；需把 alias 校验长度/Unicode 规则加入 wire。 |
| R7 右上角节点切换，一次专注一台 | **部分** | IA/节点簿/已存 node_id 限制明确；但与 token 不落文件、目标冻结、PM 重启文案冲突，当前 sidecar 无多节点/切换实现。 |
| R8 完全放行/租户名单/包租婆名单/混合房门 | **违背** | 当前只做 server-level visitor/blocklist；proposal 明确将 fabric wire、租户侧门和完全放行延期 Phase 2。必须重新裁决范围或补齐实现。 |

## 5. 开放问题回应与实现前必须钉死项

### design §6 四项

| 项目 | 评审回应 |
|---|---|
| O-4 PoP | `root` 纳入签名域且用 body.root 验签，确实挡住“拿自己的 key 冒充他人 root”。残余是 fabric_id 任意声明、±120s 内重放、公开端点状态 oracle、日志/反代泄露；需按 P1-1/2/3 修订，不能写“完全关死”。 |
| visitor 配额联动 | “不迁移”可接受，但必须同时冻结 visitor 全局/IP 上限、转换瞬间旧连接归属、disconnect release 和投影 wire；单 endpoint=4 不足以防多 key DoS。 |
| KnockLog 4096 | 作为实时待办容量可以接受，但必须定义淘汰时 pending_count、同时间排序、重敲门清 dismiss、匿名 HTTP 不入 endpoint 台账和重启清空提示。 |
| 节点簿 token 威胁模型 | 当前“0600 文件 + token 不出浏览器”不足以满足基座；先决定 OS keychain/加密存储还是版本化例外，再写备份、symlink、崩溃日志、进程转储和多用户主机边界。 |

### PRODUCT-DESIGN O-1..O-11

| O | 实现前结论 |
|---|---|
| O-1 访客到期 | 必须钉死默认永久是否接受；访客可中继到多个租户，建议默认有限 TTL/显式永久确认，并定义过期回落和提醒。 |
| O-2 敲门保留 | 必须钉死 4096 与时间 TTL、淘汰后 pending 语义、重启提示；当前“运营提示非审计”方向可保留。 |
| O-3 黑名单存量连接 | 当前设计选择只挡新连接；必须在 UI 明示并决定是否提供同一动作的 disconnect，避免“拉黑=立即断开”的误解。 |
| O-4 兑换冒名 | 必须补 fabric binding proof 或明确自声明 fabric_id 的安全边界，见 P1-1。 |
| O-5 兑换滥用 | 必须钉死直连 IP、CSPRNG/规范化、并发消费、日志脱敏、错误 oracle 和是否 pepper，见 P0-2/P1-2/P1-3。 |
| O-6 fabric_id 来源 | 必须提供客户端 create_root + register canonical 的 SDK/CLI 路径，不能把手工 HTTP 当“自助”。 |
| O-7 忽略后重敲 | 必须实现 undismiss 或等价 CAS，并规定新 deny 清除 dismissed；当前 spec 缺操作。 |
| O-8 多管理员并发 | 必须定义先到先得/幂等/CAS 与 UI 刷新，尤其 grant、dismiss、blocklist 同时发生时的胜者。 |
| O-9 open 模式 blocklist | 当前选择 open 不装 gate、blocklist 不生效；需在部署文档、UI 门禁说明和测试中明确这一反直觉边界。 |
| O-10 房门三制时机 | 不能在 R8 仍为不可挑战输入时静默延期；必须由 Owner 明确本轮纳入或修改 requirements。 |
| O-11 术语迁移 | 首现定义句可行，但需在旧 hash 页面、README、changelog/验收中统一“所有者→租户”，避免旧文案残留。 |
