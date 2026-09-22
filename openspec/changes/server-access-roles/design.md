# Design: server-access-roles

> 术语：UI 呈现层「租户」= 工程面 owner/fabric root（PM §1.5 推荐，待
> Owner 最终确认——纯呈现层可低成本翻转）；「访客」= visitor（新概念）；
> 「包租婆」只作教育比喻不进操作文案（v1 §8.3 纪律延续）。

## 0. 裁决 → 机制映射

| 裁决 | 机制 | 节 |
|---|---|---|
| R1 公钥即地址 | 无票访客名册（relay 面） | §1.1 |
| R3 敲门台 | KnockLog + admin 处置动作 | §1.2/§2 |
| R4 邀请码 | codes.jsonl + POST /register（PoP） | §1.4 |
| R5 租户到期 | owners 条目 expires_at + L1b 时间维度 | §1.3 |
| R6 alias+缩写 | registry 元数据 + UI 显示规则 | §1.1/§3.3 |
| R7 节点簿 | sidecar 本地节点存储 + 受限切换 | §3.4 |
| R8 名单制 | 访客名册（放行半边）+ blocklist（拒绝半边） | §1.1/§1.5 |

**验证链不回退**：访客/blocklist 是 C0 前后的**新分支**；有票路径的
L1/L1b 判定逐字节不变（server-access-policy 冻结语义）。

## 1. 内核（crates/dweb-server/src/access/）

### 1.1 访客名册（visitor registry）——无票准入

- 存储：`<data_dir>/visitors.jsonl`，append-only 事件日志（照
  OwnerRegistry 模式：`registry.rs:33-47` 的行格式纪律 + generation
  AtomicU64 + mtime 热重载 + 坏行硬错误；**入口= admin API + 文件
  两入口**，不新增 CLI mutation——owners 既有 CLI 入口保持不动不扩
  （r2-P1-3 裁定：v1 面收敛，管理动作集中在 admin 面，权限边界单一））：
  `{"op":"grant"|"revoke","endpoint_id":"<hex64>","alias":"<str?>",`
  `"note":"<str?>","expires_at":<u64ms?>,"ts":<u64ms>}`
  —— serde 全字段 default 兼容演进；活跃集合 = 归并后 grant 未 revoke
  且未过期。
- **gate 挂点**（`gate.rs` C0 无票路径，`gate.rs:430-455` 之后）：
  ```
  C0 无票 → blocklist(endpoint)? → 拒 dweb/blocked
          → visitor 表命中(未过期)? → Allow（仅 relay 面；rendezvous 可达面为空）
          → policy=callback? → webhook（A_cb 既有路径，payload 无 cap）
          → 拒 dweb/no-capability（+ 记敲门 §1.2）
  ```
- visitor Allow **不进 OnlineTable 的 owner 计数**（无 fabric 归属）——
  在线表键升级为 `(endpoint, Option<fabric>)`：访客条目 fabric=None
  （**MUST NOT 用 sentinel 值**——真实 FabricId 空间不得被保留字污染，
  r1-P1-7）。投影：`per_endpoint` 仅租户对；新增 `per_visitor` 数组
  （endpoint_id 字典序）；status 增 `visitors_online`。配额两级：
  per-endpoint `DWEB_RELAY_MAX_CONNECTIONS_PER_VISITOR`（默认 4）+
  全局 `DWEB_RELAY_MAX_VISITOR_CONNECTIONS`（默认 64，防多 key 女巫
  聚合——r1-P1-4；残余：sybil key 无 IP 级 admission，Phase 2）；
  deny reason 统一 `dweb/visitor-quota-exceeded`；访客→租户不迁移
  计数（新连接按新身份，存量自然收敛）。
- **callback 缓存联动**（r1-P1-6）：无票路径 webhook 缓存键纳入复合
  generation（owners+visitors 世代组合）——visitor grant/revoke 即
  相关缓存失效，防「revoke 后仍命中旧 allow」。
- 访客语义边界：**仅 relay 通行**（rendezvous 可达面 v1 为空，见
  §1.6）；不 announce、不归属任何 fabric、租户门控由租户侧 roster
  承担（模式 2 语义天然成立）。

### 1.2 敲门日志（KnockLog）

- 内存台账（不落盘，重启清空——O-2 默认裁决：敲门是运营提示不是审计
  事实，审计靠 admin 操作回执）：`Mutex<HashMap<endpoint_id, KnockAgg>>`
  + 全局容量上限 4096 endpoint（按 seq 最小者逐出——与排序键同源；
  last_at 仅展示，r3-P1-1），照
  OnlineTable 投影模式。
- **身份来源红线（r1-P0-1）**：只记 **relay 握手认证**（E1 链）的
  endpoint——rendezvous HTTP 面（匿名 resolve 无调用方身份；announce
  签名验证前的 ACL 拒绝同样无已验身份）**不入 endpoint 台账**，仅
  结构化 debug 日志（防伪造污染/诱导授权攻击）。
- KnockAgg：`{endpoint_id, seq, first_at, last_at, count, last_reason,
  dismissed: bool}`——**seq 为唯一排序键**（endpoint_id 仅作同 seq
  的最终 tie-break；last_at 仅展示，不参与排序/逐出）；count u64
  饱和递增（r1-P2-2）。
- 挂点：仅 `relay.rs:135-138` Deny 臂（顺带补一条 deny debug log）。
- 排除项：`dweb/blocked` 不记敲门（已被处置，不是待办）；
  `dweb/owner-expired` 记为租户到期提醒类别。
- dismiss/undismiss 均幂等管理动作；**同端点新 deny 自动复位
  dismissed=false**（再次敲门重新冒出，O-7）；列表排序冻结：
  未处置在前、组内 seq 降序（last_at 仅展示）、endpoint_id 升序。

### 1.3 租户有效期

- `registry.rs` Record 增 `expires_at: Option<u64>`（**serde(default)**，
  探查实证：无 default 旧条目硬错误起不来；旧条目=永久）。快照
  `active: HashMap<(fabric,root), Entry{registered_at, expires_at, alias,
  note}>`。
- L1b：`gate.rs:311` 的 `contains` 换 `contains_active(f, r, now_ms)`
  → 过期拒 **`dweb/owner-expired`**（与 unknown-owner 区分；reason
  白名单语法合规）。generation 缓存正确性不受影响（过期判定在快照内）。
- 注册默认 `+30d`（R5）；admin 可 `expires_in_days`（自定义）/`permanent`；
  续期端点见 §2。到期不踢存量连接（与 unregister 语义一致；O-3 同构
  裁决：阻断新连接，存量自然收敛或 admin 手动断）。

### 1.4 租户邀请码

- 存储：`<data_dir>/codes.jsonl`：`{"op":"issue"|"revoke"|"consume","code_hash":`
  `"<blake3 hex>","alias_hint":"<str?>","max_uses":<u32,"expires_at":<u64ms>,`
  `"default_ttl_days":<u32?>,"fabric_id":"<hex64，consume 携带>","root":`
  `"<hex64，consume 携带>","ts":<u64ms>}`。码本体 `dwebc1.` + base32
  16 字符（80 bit 熵，仅签发响应显示一次；库存只留哈希）。
- **兑换端点（公开）**：`POST /register`，body：
  `{code, fabric_id: hex64, root: hex64, ts, sig}`，其中
  `sig = root_key.sign(b"dweb/register/v1\0" || code || fabric_id ||
  root || ts u64BE)`（**与 spec 冻结一致：被签载荷含 root**——验签键
  即 body.root，载荷与验签键同源才构成完整 PoP；**PoP 防 O-4 冒名**：
  fabric_id 无持有证明的攻击面被 root 签名关死；ts 窗口 ±120s 防重放）。
  校验链（与 spec 一致）：限流 → 形状 → ts±120s → **PoP 验签**（回
  放路径同样先验签）→ 幂等命中（durable 回放/pending 补写，均不刷
  新租期）→ 码状态 → 新兑换（root 即公钥本身，验 sig 用 body.root）→ **fabric_id 一致性**：
  body.fabric_id 与 root 的关系不校验（root 自由声明是新 fabric 的
  genesis root——首次注册无第三方可证；PoP 保证的是"root 密钥持有者
  本人请求"，冒名注册他人已存在的 (fabric_id, root) 需要他人 root 私钥
  签名，不成立）→ registry 追加 register（expires_at = code.default_
  ttl_days ?? +30d）→ consume 事件 → server.key 回执（新域
  `b"dweb/register-receipt/v1\0"`，canonical 含 code_hash/fabric/root/ts/
  generation——**回执不含 code 本体**）。
- 限流：/register per-IP 令牌桶（默认 10/min，突发 5；`DWEB_REGISTER_
  RATE_PER_MIN` 可调；无新依赖的 ~40 行实现）。
- **兑换幂等与续期边界（r4-P1-2）**：幂等键=(code_hash 规范化,
  fabric_id, root)——与 spec 一致，以码哈希为键（非码原文）。
  同键 consume 已 durable → **200 幂等回放**（expires_at 不刷新、
  零新副作用——旧码耗尽后同键重试走此路径，**不可续期**）；**续期
  唯一入口=持新有效码**（未耗尽/未过期/未吊销）。幂等命中在码状态
  检查**之前**。冒名二元组被 PoP 关死（需他人 root 私钥签名）。
- **消费原子性（r1-P0-2）**：codes.jsonl 事件面增 `consume`（携带
  fabric/root）；used_count=consume 计数由归并推导，不只存内存。兑换
  判定与 consume 追加在同一临界区按 code_hash 串行；**fsync 成功前
  不返回 200/回执**（落盘失败=500）；max_uses=1 并发双兑恰一成功
  （e2e 钉死）。
- **跨台账提交协议（r2-P0-1）**：consume 与 owners register 分属两个
  jsonl，无跨文件事务——冻结为**先 register 后 consume + 启动恢复**：
  ① owners.jsonl 追加 register 事件（携带 `via_code_hash` 字段，
  serde(default) 兼容旧行）+ fsync；② codes.jsonl 追加 consume + fsync；
  ③ 双 fsync 成功后才返回 200/回执。**启动恢复**：归并时对每个带
  via_code_hash 且无匹配 consume 的 register 事件，自动补齐缺失的
  consume 事件（完成提交；generation 相应递增）——崩溃窗口的结果
  恒为「完整兑换」或「码完好」，**不存在烧码无租户**。② 失败（进程
  存活）=500 且内存挂起补写：同键重试=幂等完成（按首次已持久化
  register 结果补写 consume，不刷新租期；durable 后重试=回放）。回执 generation=**owners 世代**（r2-P1-5，客户端
  不透明）。故障注入 e2e：① 后崩溃→重启→码已消费且租户在册。
- **码级 pending 预留与幂等键（r3-P0-1/P1-2）**：幂等键=(code_hash,
  fabric_id, root) 三元组；pending 期间他键 409 `code-pending`（零
  used_count 误放行）、同键重试幂等完成（durable 后重试 200 不重复
  consume）；孤儿匹配/去重按完整三元组，旧行永不触发补写。
- **reconciliation 覆盖热重载（r3-P0-2）**：孤儿补齐=每次加载（启动
  +mtime reload）的同锁步骤；**台账加载失败（含首启）=整服务
  fail-fast 拒绝启动**（v1 无台账级降级）；补写 append 失败=保旧
  快照+该码进 deny-set（503 code-unavailable）+告警，不影响其他台账。
- **重放/代理日志（r3-P2-2）**：同键重放幂等 200；跨键重放被 PoP
  结构性阻止（签名绑定 fabric/root）——无需 nonce；部署红线：反代
  /access-log/tracing 禁记 /register 请求体。
- **码生成与脱敏（r1-P1-3）**：OS CSPRNG；哈希输入=码本体 16 字符
  小写规范化（剥前缀/连字符）；日志/指标/错误零码全文（对齐
  callback_token 纪律）；错误码状态区分为明示产品取舍（排障需要）。
- **fabric_id 语义（r1-P1-1）**：自声明标签（FabricId 随机生成、无
  服务端可验 genesis 绑定）；身份键=二元组（与 registry 既有精确
  匹配一致）；同 fabric 多 root 合法并存，管理面以二元组呈现+钓鱼
  警示。攻击者注册受害者 fabric_id+自己 root ≠ 获得该 fabric 任何
  能力（成员资格在租户侧 roster）。

### 1.5 黑名单（blocklist）

- `<data_dir>/blocklist.jsonl`：`{"op":"add"|"remove","kind":"endpoint"|`
  `"fabric","id":"<hex64>","reason":"<str?>","ts":<u64>}`。热重载同
  registry 模式。
- gate 挂点：**最早**——C0 凭证分类之前查 endpoint 维度；有票路径在
  L1 之后查 fabric 维度（issuer 命中即拒）。deny slug `dweb/blocked`
  （message 带 reason）。O-9（open 模式）：open 不装配 gate（`relay.rs:
  46-48`）——blocklist 仅 restricted 语义，文档明示。
- 存量连接不主动断（同 §1.3 裁决）。

### 1.6 rendezvous 面 + 限流（访客可达面 v1 冻结为空）

- **访客可达面 = relay 通行**（R1 公钥即地址：敲门即连 relay，目标
  endpoint_id 已在手）。rendezvous 无票 resolve **维持 401**——HTTP
  GET 面无端点身份证明，"访客查表放行 resolve"不可实现（名册非空即
  全局放行的开关语义已否决：泥泞且扩大面）；带身份绑定的签名
  resolve 变体 = Phase 2。announce 仍需有票（现状）。rendezvous
  Deny 臂仅结构化 debug 日志（不入 KnockLog——身份不可信，见 §1.2）。
- resolve/announce 面基础限流：per-IP 令牌桶（resolve 60/min、
  announce 20/min）——探查实证当前 HTTP 面零限流；实现与 §1.4 共用
  令牌桶组件。

## 2. admin API 增量（复用既有 envelope/回执/auth_guard 模式）

| 路由 | 语义 |
|---|---|
| `GET /admin/knocks` | 敲门聚合列表（未处置优先、组内 seq 降序、endpoint_id 升序；last_at 仅展示；`?include_dismissed`） |
| `POST /admin/knocks/{endpoint_id}/dismiss` / `undismiss` | 处置/恢复待办（均幂等；回执 op=0x0B/0x0C；同端点新 deny 自动复位 dismissed） |
| `GET/POST/DELETE /admin/visitors` | 名册 CRUD（POST body：endpoint_id/alias/note/expires_in_days?；grant 回执） |
| `POST /admin/visitors/from-knock` | 敲门台一键定位（body：endpoint_id/alias?——同 POST 语义，语义糖路由） |
| `GET/POST/DELETE /admin/codes` | 签发（POST：alias_hint?/max_uses=1/expires_in_days=7/default_ttl_days=30——**响应含 code 全文仅此一次**）/列表（只回哈希与计数）/吊销 |
| `POST /admin/owners/{fabric_id}/{root}/renew` | 续期（body：expires_in_days/permanent；回执 op=renew 0x04） |
| `GET /admin/owners` 增量 | 列表条目增 alias/expires_at/expires_in/租户状态（active/expired） |
| `GET/POST/DELETE /admin/blocklist` | 名单 CRUD（POST kind/id/reason；回执） |
| `GET /admin/status` 增量 | 增 knocks_pending/visitors/codes_active 计数（wire 增量字段，旧消费者忽略未知字段——既有向前兼容规则） |

`POST /register` 为**公开路由**（码门控，不走 admin auth_guard；挂
gateway 根路径）。全部 JSON wire（snake_case/未知字段忽略/错误 envelope）
在 spec 冻结示例。新变更类操作的回执复用 103B canonical，op 枚举扩充
（renew=0x04 … knock-dismiss=0x0B / knock-undismiss=0x0C，未用维度置零；
code 类 target=code_hash 32B；**回执 generation=所属台账的 generation**，
客户端视为不透明 u64）——完整枚举与槽位映射表冻结于 spec delta
「三角色管理面 API」。

## 3. webui（Svelte+shadcn 基座上演进）

### 3.1 IA（PM §3 采纳）：总览（四问+待办条）/ 租户管理（名册+alias+
到期+续期+邀请码）/ 访客与门禁（敲门台+访客名册+黑名单）/ 在线连接
/ 节点簿（右上角）。导航「访问管理」拆三页，旧 hash 收敛规则更新。

### 3.2 敲门台：待办列表（谁/次数/首次/最近/原因）+ 行内四动作
（定位访客=表单预填+确认；导入租户=表单（fabric_id 引导文案：敲门记录
无 fabric，提示用邀请码通道或手工输入）；拉黑=确认；忽略=toast+撤销
链接——PM §4 成品文案逐字采用）。

### 3.3 key 显示规范 [R6]：全站统一 `alias (abc***xyz)`——缩写规则：
hex 首尾各 3 字符（前 3***后 3，较 v1 的前 8 位更紧凑防钓鱼），title
全文+复制；无 alias 时仅缩写。v1 的前 8 位规则由本规范**取代**（跨
change 规范更替，webui-console 归档时加增补说明——PM 摩擦点 3）。

### 3.4 节点簿 [R7]：sidecar 本地存储 `~/.opendweb/nodes.json`（0600；
条目：id/name/server_host/token/added_at——**token 只存在 sidecar 侧**，
浏览器经 /sidecar/* 操作；state/nodes 响应只回 id/name/server_host/
added_at——host 非机密（用户亲自输入），token 永不出现在任何响应）。
添加 = 配对面流程可重复（每次新配对码，validateTarget 全量校验与并发
一次性消费锁语义延续）；切换 = `POST /sidecar/nodes/switch
{node_id}`——**仅允许切到已存储节点**（不接受新 URL → 目标冻结安全
模型保持：攻击面无"新目标注入"通道；Host/Origin 校验同 connect，无
需配对码——无新秘密输入）。切换语义：进程内换 target+token 原子替换
（不重启进程——实现上 sidecar 的 target 状态从一次性改为可切换的
受控枚举；冻结文案改「切换需经节点簿」）。删除 = DELETE /sidecar/
nodes/{id}；当前连接节点不可删（先切走）。
  **对基座的两条版本化例外**（webui-console 归档时附增补说明）：①
  token 落盘例外——0600 nodes.json（单用户工作站威胁模型；临时文件+
  原子 rename、拒 symlink 跟随；帮助文本披露 OS 可见性）；② 切换例外
  ——switch 是唯一被许可的运行时重指向通道（仅已存 node_id），除此之外
  target-frozen 拒绝语义不变；在途代理请求以请求开始时的 target 快照
  完成（切换不撕裂）。路径命名：业务面沿用基座 `/api/*`→`/admin/*`，
  节点簿属本地控制面 `/sidecar/nodes*`（r1-P1-9）。

## 4. SDK/文档 [R2]

- `opendweb` CLI 增 `opendweb id`（只读：本机默认 key 的 endpoint_id/
  缩写/数据面路径；复用 SecretStore）；README「一台设备一个默认 key」
  产品化段落 + 多密钥对=高级功能指引（不在本轮实现）。
- `opendweb join --server <URL> --code <码>`（r1-P1-11，R4 自助入口）：
  默认设备 key 为 root（本地无 fabric 则生成、有则复用——不静默造
  第二个）；构造/签名 register canonical、兑换、保存回执与到期；码与
  私钥不落日志；http 非 loopback 需 --allow-insecure（对齐 sidecar
  守卫）；失败非零退出无半提交本地状态。含 register-receipt 客户端
  验签 helper。

## 5. 测试策略

| 面 | 测试 |
|---|---|
| gate 单测 | 访客矩阵（命中/过期/revoked/无票非访客/callback 分流/访客配额）、blocklist（endpoint 早判/fabric 晚判/open 不生效）、owner-expired 边界（到期当日/续期恢复） |
| registry 单测 | 旧格式条目（无 expires_at/alias）解析=永久无 alias；坏行硬错误；generation 递增 |
| 兑换单测+e2e | 正常兑换/错 sig/重放窗口/耗尽/过期/吊销/per-IP 限流/**持新有效码重复注册=续期**/**同键旧码回放不刷新租期**/回执验签/**崩溃恢复补 consume**（故障注入）/**pending 第二键 409 code-pending**/**durable 后重试幂等**/**热重载孤儿补齐+fail-closed**/unknown dismiss/undismiss=404/pending_count 恒为未处置数/时钟回拨排序稳定 |
| KnockLog 单测 | 聚合/LRU/排除 blocked/dismiss+undismiss 幂等/新 deny 复位/seq tie-break（每次 deny 分配新 seq，排序键 seq desc，last_at 仅展示——时钟回拨免疫） |
| admin e2e | 敲门→定位访客→raw client 重连放行全链路；邀请码签发→兑换→名册出现带 alias/到期；到期租户 deny reason；黑名单同票拒 |
| rendezvous | 无票 resolve/announce 维持 401（访客可达面为空）；限流触发 429 |
| webui | node --test 纯逻辑（新 copy/缩写规则/路由收敛）+ apiFetch 注入矩阵扩展 + sidecar 节点簿单测（存储 0600/原子 rename/拒 symlink/切换不含新 URL/state 掩码/在途快照）+ 业务调用路径契约（敲门台/邀请码仅 /api/*，本地控制面仅 /sidecar/nodes*） |
| 并发/缓存 | 并发双兑恰一成功（fsync 前零响应）；visitor grant/revoke 即刻失效 webhook 缓存（复合 generation） |
| 投影/wire | per_visitor 数组 + per_endpoint 不含访客；status visitors_online；XFF 伪造不改限流键；client-sdk op 0x04-0x0C 映射 + fixture 对拍增量 |
| CLI | `opendweb id` 幂等无私钥；`opendweb join` 端到端（新 fabric/复用/失效码三种） |
| 回归 | sdk-mgmt-surface/webui-console 全部既有测试零改动全绿（owners wire 增量字段不破坏旧断言；基线数字以当日实跑为准） |

## 6. 评审处置记录与遗留开放项

- r1（codex-review-sar-r1.md，5.0/10）22 条全处置：P0×6（rendezvous
敲门身份→relay-only；consume 事件/CAS/fsync；节点簿两条版本化例外；
R8 延期裁决链入 requirements 范围修订记录；访客可达面矛盾句清除）、
P1×12、P2×4 均已落入 spec/design/tasks。
- r2（codex-review-sar-r2.md，6.3/10）8 条全处置：跨台账提交协议/
  design 旧语义/webui 路径/CLI 入口/supersedes 优先级/generation+
  pending_count/seq 时钟/测试表。
- r3（codex-review-sar-r3.md，6.8/10）：码级 pending 预留+幂等键、
  热重载 reconciliation、KnockLog seq 主键统一、PM resolve 残留
  清除、O-9 收敛、重放/代理日志红线、webui-console 基座增补落地。
遗留（非阻塞、实现期观察）：
- fabric_id 自声明残余：UI 钓鱼警示 + 二元组呈现已冻结；genesis 绑定
  proof（FabricId 可验派生）列 Phase 2 候选
- sybil key 对全局访客上限 64 的压力：Phase 2 IP 级 admission
- trusted-proxy CIDR（反代下限流聚合）：Phase 2
- 术语「租户」待 Owner 最终确认（呈现层可低成本翻转）
