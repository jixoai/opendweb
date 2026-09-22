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
  AtomicU64 + mtime 热重载 + 坏行硬错误 + CLI 三入口收敛）：
  `{"op":"grant"|"revoke","endpoint_id":"<hex64>","alias":"<str?>",`
  `"note":"<str?>","expires_at":<u64ms?>,"ts":<u64ms>}`
  —— serde 全字段 default 兼容演进；活跃集合 = 归并后 grant 未 revoke
  且未过期。
- **gate 挂点**（`gate.rs` C0 无票路径，`gate.rs:430-455` 之后）：
  ```
  C0 无票 → blocklist(endpoint)? → 拒 dweb/blocked
          → visitor 表命中(未过期)? → Allow（仅 relay/resolve 面）
          → policy=callback? → webhook（A_cb 既有路径，payload 无 cap）
          → 拒 dweb/no-capability（+ 记敲门 §1.2）
  ```
  visitor Allow **不进 OnlineTable 的 owner 计数**（无 fabric 归属）——
  在线表条目 fabric_id 置 `visitor` 保留位 `[0xFF*32]`？**否**——Online
  Table 键为 (endpoint,fabric)；访客条目 fabric 固定
  `VISITOR_FABRIC_ID = [0u8;32]` 之外的保留字 `0xFF…`（不与真实 fabric
  碰撞；admin connections 投影 mode 侧标注 visitor 计数字段）。配额：
  访客不受 per-owner 配额（无 owner），新增 `DWEB_RELAY_MAX_CONNECTIONS_
  PER_VISITOR`（默认 4，防单访客占满中继）。
- 访客语义边界：**仅 relay 通行**（rendezvous 可达面 v1 为空，见
  §1.6）；不 announce、不归属任何 fabric、租户门控由租户侧 roster
  承担（模式 2 语义天然成立）。

### 1.2 敲门日志（KnockLog）

- 内存台账（不落盘，重启清空——O-2 默认裁决：敲门是运营提示不是审计
  事实，审计靠 admin 操作回执）：`Mutex<HashMap<endpoint_id, KnockAgg>>`
  + 全局容量上限 4096 endpoint（LRU 逐出），照 OnlineTable 投影模式。
- KnockAgg：`{endpoint_id, first_at, last_at, count, last_reason,
  last_source: relay|rendezvous, dismissed: bool}`。
- 挂点：`relay.rs:135-138` Deny 臂 + `rendezvous.rs:234-237` Deny 臂
  （deny reason 已在手；无 deny tracing 的现状顺带补一条 debug log）。
- 排除项：`dweb/blocked` 不记敲门（已被处置，不是待办）；
  `dweb/owner-expired` 记为租户到期提醒类别。

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

- 存储：`<data_dir>/codes.jsonl`：`{"op":"issue"|"revoke","code_hash":`
  `"<blake3 hex>","alias_hint":"<str?>","max_uses":<u32,"expires_at":<u64ms>,`
  `"default_ttl_days":<u32?>,"ts":<u64ms>}`。码本体 `dwebc1.` + base32
  16 字符（80 bit 熵，仅签发响应显示一次；库存只留哈希）。
- **兑换端点（公开）**：`POST /register`，body：
  `{code, fabric_id: hex64, root: hex64, ts, sig}`，其中
  `sig = root_key.sign(b"dweb/register/v1\0" || code || fabric_id || ts)`
  （**PoP 防 O-4 冒名**：fabric_id 无持有证明的攻击面被 root 签名关死；
  ts 窗口 ±120s 防重放）。校验链：限流 → 码有效（哈希命中/未吊销/
  used<max/expires 未过）→ PoP 验签（root 由 fabric 的 genesis 推导？
  否——root 即公钥本身，验 sig 用 body.root）→ **fabric_id 一致性**：
  body.fabric_id 与 root 的关系不校验（root 自由声明是新 fabric 的
  genesis root——首次注册无第三方可证；PoP 保证的是"root 密钥持有者
  本人请求"，冒名注册他人已存在的 (fabric_id, root) 需要他人 root 私钥
  签名，不成立）→ registry 追加 register（expires_at = code.default_
  ttl_days ?? +30d）→ used_count+1 → server.key 回执（新域
  `b"dweb/register-receipt/v1\0"`，canonical 含 code_hash/fabric/root/ts/
  generation——**回执不含 code 本体**）。
- 限流：/register per-IP 令牌桶（默认 10/min，突发 5；`DWEB_REGISTER_
  RATE_PER_MIN` 可调；无新依赖的 ~40 行实现）。
- 兑换幂等：同 (code, fabric_id, root) 重复请求在码 used 耗尽后返回
  `{"error":{"code":"code-exhausted"}}`；同租户已注册=续期语义（刷新
  expires_at）——避免攻击者用他人已注册二元组+自己签名？不成立（需
  他人 root 签名）。**已注册二元组 + 自己的新签名**：fabric_id+root
  是别人的、自己签不出有效 sig（sig 用 body.root 验）→ 关死。

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
  Deny 臂照记敲门。
- resolve/announce 面基础限流：per-IP 令牌桶（resolve 60/min、
  announce 20/min）——探查实证当前 HTTP 面零限流；实现与 §1.4 共用
  令牌桶组件。

## 2. admin API 增量（复用既有 envelope/回执/auth_guard 模式）

| 路由 | 语义 |
|---|---|
| `GET /admin/knocks` | 敲门聚合列表（未处置优先/最近在前；`?include_dismissed`） |
| `POST /admin/knocks/{endpoint_id}/dismiss` | 标记已处理（幂等；回执） |
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
（renew=0x04 … knock-dismiss=0x0B，未用维度置零；code 类 target=
code_hash 32B）——完整枚举与 wire 示例冻结于 spec delta「三角色管理面
API」。

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

## 4. SDK/文档 [R2]

- `opendweb` CLI 增 `opendweb id`（只读：本机默认 key 的 endpoint_id/
  缩写/数据面路径；复用 SecretStore）；README「一台设备一个默认 key」
  产品化段落 + 多密钥对=高级功能指引（不在本轮实现）。

## 5. 测试策略

| 面 | 测试 |
|---|---|
| gate 单测 | 访客矩阵（命中/过期/revoked/无票非访客/callback 分流/访客配额）、blocklist（endpoint 早判/fabric 晚判/open 不生效）、owner-expired 边界（到期当日/续期恢复） |
| registry 单测 | 旧格式条目（无 expires_at/alias）解析=永久无 alias；坏行硬错误；generation 递增 |
| 兑换单测+e2e | 正常兑换/错 sig/重放窗口/耗尽/过期/吊销/per-IP 限流/重复注册=续期/回执验签 |
| KnockLog 单测 | 聚合/LRU/排除 blocked/dismiss 幂等 |
| admin e2e | 敲门→定位访客→raw client 重连放行全链路；邀请码签发→兑换→名册出现带 alias/到期；到期租户 deny reason；黑名单同票拒 |
| rendezvous | 无票 resolve/announce 维持 401（访客可达面为空）；限流触发 429 |
| webui | node --test 纯逻辑（新 copy/缩写规则/路由收敛）+ apiFetch 注入矩阵扩展 + sidecar 节点簿单测（存储 0600/切换不含新 URL/state 掩码）|
| 回归 | sdk-mgmt-surface/webui-console 全部既有测试零改动全绿（owners wire 增量字段不破坏旧断言） |

## 6. 开放问题（Codex 评审重点）

- O-4 已用 PoP 关死（§1.4）——请复核签名域/验签键选择（body.root 自
  验）是否有残余冒名面
- 访客配额默认 4 与 per-owner 配额的联动（访客转租户后计数迁移？——
  现设计：不迁移，新连接按新身份计数）
- KnockLog 内存上限 4096 endpoint 的运营够用性
- 节点簿 tokens.json 的本地威胁模型披露文案（与 --token env 同层）
