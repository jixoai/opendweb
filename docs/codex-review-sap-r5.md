# server-access-policy R5 最终闭合核验（R5（zcode 子代理代行，Codex 会话工具故障））

复核对象为 `9c55304`（分支 `server-access-policy`），基线为 `main@ae271cf`；
R4 清单取自 `docs/codex-review-sap-r4.md:131-217`（8 个 P1）。本报告由
zcode 子代理代行 Codex 终验（Codex 会话工具故障），方法与门禁与前四轮
一致：设计/spec 层终验，`tasks.md` 未勾选属预期状态，不作为缺陷。

独立门禁：

- `openspec validate server-access-policy --type change --strict --no-interactive`
  → `Change 'server-access-policy' is valid`（经 `pnpm exec openspec`）。
- `git diff --check ae271cf..9c55304` 通过（无空白错误）。
- `git diff --stat ae271cf..9c55304`：10 个文件、2290 行插入，全部为
  change 文档（proposal/design/requirements/tasks/4 份 spec delta）与
  docs/ 评审留档（r3/r4 报告），零代码文件变更——与"纯设计阶段 change"
  定位一致。

## R4 清单逐条闭合核验

### P1-1：A_cb(S) 全文贯穿 —— 闭合

R4 点名的旧断言位置在 9c55304 已逐一修正：

| R4 点名位置 | 现状（9c55304） | 判定 |
|---|---|---|
| design §8.3（R4 引 :513-521） | design.md:516-523 ASCII 图已分叉：`static：对端 ∉ A(S) 必拒；callback：仅当 admin 的 webhook 将该 peer 纳入 A_cb(S) 才可达（admin 自担，默认 deny 即不可达）`；:525-531 汇合结论改为 `经 relay 的通信端点在接入时刻均 ∈ A(S) ∪ A_cb(S)` | ✅ |
| design §9 A3 | design.md:681-682 仍写 `无票 deny ✅（§8.3）` 未带 callback 限定，**但** §9 A11（:711-732）完整覆盖 callback 分支且 §15:962-963 明确 `A3 在 callback 模式下的可达边界扩展为 A(S) ∪ A_cb(S)，admin 自担`，A3 行显式指向 §8.3（权威已分叉） | ✅（留 minor-2） |
| design §13（R4 引 :902） | design.md:882-884 `授权边界…经 relay 的通信端点 ⊆ A(S) ∪ A_cb(S)（A_cb 仅 policy=callback 非空，admin 自担）；边界外端点零可达性` | ✅ |
| design §14（R4 引 :851-853/:915-917） | design.md:934-937 空 registry 语义按 policy 分裂：`static + 空 registry = 拒绝一切；callback + 空 registry = 一切票据被 L1b 拒，仅 webhook 放行的无票端点（A_cb(S)）可达（identity-only 动态名单）`；:926-928 老 SDK 迁移句残留（见 minor-3） | ✅ |
| design §15 | design.md:962-963 理由 4 已按 A(S) ∪ A_cb(S) 重写 A3 结论 | ✅ |
| spec :14-17 | specs/server/spec.md:14-18 scenario 前置 `restricted 且 policy=static`，并加注 `policy=callback 时无凭证接入交 webhook 裁决（A_cb(S) 边界）` | ✅ |
| spec :51-54（空 registry） | specs/server/spec.md:51 正文按 policy 分裂 + :53-56（`空 registry fail-closed（static）`）/ :58-61（`空 registry 的 callback 模式为 identity-only`）两个独立 scenario | ✅ |
| spec relay 桥接 requirement | specs/server/spec.md:7 `经 relay 通信的端点属于 A(S)，callback 模式下另加 webhook 动态放行集合 A_cb(S)；open 模式不设此边界` | ✅ |

静态断言（如 §8.5 design.md:571 StaticRegistryProvider `无票必拒`）被正确
限定在 provider 语义内，不再与 A_cb 冲突。实现者不会再在"callback 无票
名单"与"任何无票必拒"之间分叉。两条措辞残留（A3 行、老 SDK 迁移句）
不改变安全行为，列 minor。

### P1-2：registry 清缓存 scenario 修正 —— 闭合

- specs/server/spec.md:151-154（`registry 变更即时清缓存（unregistered
  票据不再回调）`）：unregister 后其名下已缓存票据再接入 → `缓存已被
  generation+1 失效；接入由 L1b 直接拒绝（dweb/unknown-owner），webhook
  调用计数为 0（无效票据不触发 webhook）`——R4 要求的"L1b 直拒 + 计数 0"
  逐字落地。
- specs/server/spec.md:156-159（`registry 变更后有效 key 产生新回调`）：
  `一个仍有效票据或无票 A_cb key 再次接入 → 旧缓存不命中，产生一次新回调
  并按其结果准入`——generation 清缓存改由仍然有效的 key 单独验证，与
  :136-139（无效票不触发 webhook）不再矛盾。
- specs/server/spec.md:176-179（Visitor 中继 scenario）补齐 policy 前置：
  `policy=static（或 policy=callback 且 webhook 对该第三方无票接入返回
  deny）`，THEN 结论相应写为 `可达边界（A(S)，callback 模式为
  A(S) ∪ A_cb(S)）之外的端点经本 Server 零可达`。

逻辑不可满足的两处硬冲突均已消除。

### P1-3：per-source = endpoint_id 冻结 —— 闭合

- design.md:622-628（§8.5 并发防护）：`每来源在途上限（默认 16，
  source = endpoint_id——R4 P1-3 冻结：iroh-relay hook 输入无远端地址
  （ClientRequest 无 peer_addr），endpoint_id 是唯一可用的来源维度）`。
- tasks.md:38 同步冻结：`全局 64/来源 16（source=endpoint_id）`。
- 源码佐证：`ClientRequest`（iroh-relay server.rs:187-277）字段仅
  `connection_id / endpoint_id / protocol_version / request: http::request::Parts`，
  Parts 含 uri/headers 而无对端地址——"唯一可用维度"的事实断言成立。

### P1-4：缓存投影冻结 —— 闭合（带一处数字笔误，见 minor-1）

- design.md:629-640（§8.5 缓存冻结）：键 =
  `(registry_generation, endpoint_id, BLAKE3(hash_input), event)`；
  hash_input 字段顺序、宽度、端序全部冻结：`caps u8 || issued_at u64 BE
  || expires_at u64 BE || fabric_id 32B || issuer 32B || recipient 32B`；
  无票 sentinel 给出精确展开 `caps=0 || issued_at=0 || expires_at=0 ||
  zero×96`（与有票投影等长，定长成立）；digest 为内部 32B 值（不出现在
  日志）。
- 响应 schema 行为冻结：`cache_ttl_s 省略 = 使用配置默认；非整数/负数/
  浮点/超 60 一律按 0（不缓存）；响应未知字段忽略（不拒绝）`
  （design.md:637-639）；registry 变更 generation+1 清空全部缓存（撤销
  即时生效窗口 = 0）；TTL = min(cache_ttl_s, callback_cache_ttl_ms,
  上限 60s)。
- specs/server/spec.md:119 正文同步（键构成、generation 清缓存、非法
  cache_ttl_s 按 0、缓存仅作用新连接准入）。

R4 诉求的"字段顺序/数值编码/null 固定输入/digest 表示/缺省与未知字段
处理"全部有 MUST 级行文，实现不再有自由度。唯"155B 定长"为算术笔误
（正确 113B，见 minor-1）——字段列表自洽，不产生安全分叉。

### P1-5：disconnect payload 冻结 —— 闭合

- design.md:653-661：请求体 = `{ "event": "relay.disconnect",
  "endpoint_id": "<z-base-32>", "connection_id": "<opaque>" }`，显式
  `不携带 capability/context——Server 不为断开事件保存连接上下文快照`；
  fire-and-forget、不阻塞、不重试、允许丢失（进程重启即丢）、`每
  connection 至多一次`、不可作为配额或撤销依据、受同一并发/超时上限
  约束（超限直接丢弃）。
- specs/server/spec.md:171-174 scenario 同步（携带 connection_id、
  best-effort、丢失不影响准入与撤销语义）。
- tasks.md:30-32 将 payload 冻结写入实现任务。
- 源码佐证：iroh-relay `AccessControl::on_disconnect(endpoint_id,
  connection_id)`（server.rs:302）只有这两个输入——冻结的 payload 是
  唯一可实现的选择，"不保存上下文快照"与上游能力精确对齐。

### P1-6：C0 凭证来源分类 —— 闭合

- design.md:445-454（§8.2 C0 框）：`实现 MUST 直接检查 Authorization
  header 与 ?token= query（不复用 auth_token() 的归一化——它对非法
  UTF-8 header 返回 None，会把"坏票"误降级为"无票"）`；两者皆缺失 →
  无票路径（A_cb 语义）；`任一存在但非 Bearer 形态/非法 UTF-8/非
  dwebr1. 前缀 → DENY "dweb/malformed-capability"（不得进入无票路径）`。
- specs/server/spec.md:25 独立 scenario：`声明了凭证但不可解析 →
  dweb/malformed-capability，该接入 MUST NOT 被归类为无票（无票路径仅限
  凭证完全缺失，防坏票混入 A_cb 动态名单）`。
- tasks.md:32-33 同步（含"直接检查 headers/query，不复用 auth_token()
  归一化"）。
- **源码验证（任务指定抽查点）**：iroh-relay server.rs:264-277
  `auth_token()` 实现为 `let value = value.to_str().ok()?;`——`?` 在
  Option 上下文对非法 UTF-8 header **立即返回 None**，其 doc 注释原文
  `If an Authorization header value is not valid UTF-8 the function
  returns None immediately, without checking later headers or the URL
  query`。design §8.2 对该行为的描述与引用（server.rs:252-276）真实
  无虚。另证实一个 design 未展开但方向一致的事实：非 Bearer scheme 的
  Authorization header 会被 auth_token() 跳过后 fallback 到 query——
  C0 的直接检查恰好能覆盖该分支（`Basic xyz` → malformed 拒），语义
  自洽。

### P1-7：rendezvous 复用同一不可绕过 verifier —— 闭合

specs/server/spec.md:183（rendezvous 访问控制 requirement 正文）四要素
齐备：

1. `MUST 通过与 relay 面同一套不可绕过验证器（L1 密码学完整性 + L1b
   票有效性底线：registry 二元组等`——同一 verifier + L1+L1b；
2. `各失败 reason 一致映射为 HTTP 401 响应体 {"error":"dweb/<reason>"}`；
3. `"存在但非法"的凭证同样不得按无票处理`——C0 分类延伸到 HTTP 面；
4. resolve 面明示 `L1 的 recipient==握手身份检查在 resolve 面不适用——
   无握手身份，仅验密码学有效性`（bearer-only 降级）+ announce 面
   `capability.recipient MUST == announce 请求体中签名的 EndpointId`。

R4 要求的修复选项一（"明确 rendezvous 走同一不可绕过 verifier，按
announce/resolve 分别要求 RDZ caps，announce 另做 recipient==签名者"）
被完整采纳；:185-207 的五个 scenario（匿名 resolve 拒/身份绑定/缺
RDZ_ANNOUNCE/缺 RDZ_RESOLVE/open 现状）与正文一致。

### P1-8：SSRF 解析-校验-连接原子语义 —— 闭合

design.md:641-649（§8.5 传输与 SSRF 边界）：

- `实现 MUST 自行解析 callback_url 主机 → 得到全部 A/AAAA 地址 → 逐个
  归一化（IPv4-mapped IPv6 折算为 IPv4）并校验拒绝私网（RFC1918/ULA）、
  link-local、云 metadata 网段（任一地址非法即整体拒绝，防多地址绕过与
  DNS rebinding——解析后的固定地址直接用于连接，不经系统代理、不二次
  解析）`；
- `不跟随重定向（3xx 一律按失联处理，防 token 跨 origin 泄露）`；
- 生产强制 https + `--allow-loopback-callback` 显式豁免；token 日志脱敏。

tasks.md:41-44 将全部要点（全部 A/AAAA 逐个校验/IPv4-mapped 归一化/
固定地址直连不经代理/不跟随重定向）写入 1.5b 实现任务；spec:166-169
SSRF scenario 保持私网/重定向/token 不外泄断言。任务指定的四个验证点
（全部地址逐个校验/IPv4-mapped 归一化/固定地址直连不经代理/不跟随
重定向）全部冻结。spec scenario 与 tasks 1.9 测试矩阵未单列
rebinding/IPv4-mapped 负例（见 minor-4）。

## 新发现问题

**无新 P0/P1。** R4 的 8 个 P1 全部闭合，未发现会改变实现安全行为的
新问题。以下为 P2 级 minor 备注（措辞/文档卫生，不要求迭代轮次，建议
实现期顺手修正）：

1. **minor-1（确定性数字笔误，建议实现期必改）**：design.md:633 与
   tasks.md:35 将缓存 hash_input 标注为 `155B 定长`，但冻结的字段列表
   1+8+8+32+32+32 = **113B**（无票 sentinel 1+8+8+96 = 113B，等长成立，
   定长语义本身没错）。155 无法由任何自洽字段集导出（含 server_id 也
   只有 145B）。字段顺序/宽度/端序是权威且自洽的，故不会造成实现分叉；
   但按 155B 写长度断言测试会确定性失败。修正：两处 `155B` → `113B`。
   另 design.md:632-633 `用 32 字节全零 sentinel 代替后三段` 措辞有
   歧义（易读成三段压成单个 32B），建议改为 `后三段各以 32 字节全零
   代替（共 zero×96）`——括号内 `zero×96` 展开已保证语义可恢复。
2. **minor-2**：design.md:681-682（§9 A3 行）`无票 deny ✅` 未带
   policy 限定。权威分叉在 §8.3 图、A11 与 §15:962-963 均已存在，此处
   为摘要行残留；建议补 `（callback 下以 A_cb(S) 为界，见 §8.3）`。
3. **minor-3**：design.md:926-928（§14 阶段 2）`老 SDK（无 token）连
   restricted relay：收到 deny reason`——在 callback + webhook 放行
   无票老端点时不成立。迁移叙述的默认语境是 static（或 webhook deny），
   建议加 policy 限定词。
4. **minor-4（可测性增强）**：spec SSRF scenario（specs/server/spec.md:
   166-169）与 tasks.md:62（1.9 测试矩阵 `SSRF（私网/重定向/token
   不外泄）`）未单列 DNS rebinding（二次解析返回私网）、IPv4-mapped
   （`::ffff:10.0.0.1`）、合法+非法混合多地址三个负例——语义已在
   design §8.5 + tasks 1.5b 冻结，但 scenario/测试矩阵未完全镜像。
   建议实现期在 1.9 补这三个用例。
5. **minor-5**：`cache_ttl_s 省略 = 使用配置默认` 只在 design.md:637
   出现，spec:119 只写了 `非法值按 0 不缓存`；多个 Authorization
   header（一个合法 Bearer + 一个垃圾值）时 C0 的取用优先序未显式
   （auth_token() 语义是首个 Bearer 优先，C0 直接检查后任何"存在但
   非法"都拒——fail-closed 方向一致，无分叉）。两者均可在实现期回写
   spec 时补一句。

## 代码事实抽查

四组关键引用逐一对源码核实（iroh-relay 1.1.0 =
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/iroh-relay-1.1.0/`，
项目代码 = 本 worktree @9c55304）：

| # | design 断言 | 源码事实 | 判定 |
|---|---|---|---|
| 1 | §8.2 C0：auth_token() 对非法 UTF-8 header 返回 None（引 server.rs:252-276） | server.rs:264-277：`value.to_str().ok()?` 在 Option 上下文对非法 UTF-8 立即返回 None；doc 注释原文确认 `returns None immediately, without checking later headers or the URL query` | 真实 |
| 2 | §8.2 末段 stock 装配链 `Server::spawn → 握手 → authorize_with → Clients::register`（引 http_server.rs:868-898、handshake.rs:480-505）；deny reason 经握手回传（handshake.rs:487-503） | http_server.rs:869（`handshake::serverside` 认证）→ :874（`ClientRequest::new`）→ :878（`authorize_with`）→ :896-897（`clients.register`），顺序一致；handshake.rs:489-502 `authorize_with` 在 Allow 后创建 `OnDisconnectGuard`、Deny 时 `self.deny(reason, io)` 回传 reason；:517 起确有可绕过 hook 的公开 `authorize_if`（与 design"装配边界而非 API 绝对承诺"的措辞一致） | 真实 |
| 3 | §1.1 F2：relay.rs 未触碰 access/.limits；iroh-relay 默认 AllowAll（server.rs:155-163） | crates/dweb-server/src/relay.rs:23-46：`RelayServerConfig::new` 后仅设 `tls = None` 与 quic，`Server::spawn` 在 :41-43，未触碰 `access`/`limits`；iroh-relay server.rs:151-163 `RelayConfig::new` 确认 `access: Arc::new(AllowAll)` 默认 | 真实 |
| 4 | §1.1 F1/F8/F9：rendezvous 纯内存、announce 签名/resolve 匿名；fabric 门控 fabric.rs:1902-1908/2675-2686；dweb-server 无 dweb-fabric 依赖 | rendezvous.rs:78-81（`Registry { entries: Mutex<HashMap> }`）、:99-119（`dweb-rendezvous-announce-v1\0` canonical 签名）、:183-201（resolve 无任何凭证检查，直接查表）；fabric.rs:1902-1908（发起侧 `roster.is_member` 门控）、:2675-2686（accept 侧先门控再 `acceptor_hello`）；`grep dweb-fabric crates/dweb-server/Cargo.toml` = 0 命中 | 真实 |

结论：design.md 的代码事实引用（F 表、§8.2 调用链、C0 依据）**无虚构**，
且多个引用在"可实现性"层面反过来构成 spec 冻结的支撑（on_disconnect
签名证 disconnect payload 冻结、ClientRequest 无 peer_addr 证
source=endpoint_id、auth_token().ok()? 证 C0 必要性）。

## 最终评分：8.4/10（与轨迹 5.5→5.9→6.1→7.0 对比）

评分轨迹 R1 5.5 → R2 5.9 → R3 6.1 → R4 7.0 → **R5 8.4**（+1.4）。

依据：

- **8 个 P1 全部闭合**（含 R4 判"会改变实现安全行为"的全部项）：
  A_cb(S) 贯穿、两处逻辑不可满足 scenario 修复、source/projection/
  disconnect payload/C0 分类/rendezvous verifier/DNS 原子性七类协议
  自由度全部收拢为 MUST 级冻结文字，且与 iroh-relay 1.1.0 真实能力
  逐条对得上。
- **无新 P0/P1**。新发现仅 5 条 P2 minor（1 条数字笔误 + 4 条措辞/
  可测性增强），全部不产生安全行为分叉。
- 未到 9+ 的原因：spec scenario/测试矩阵对已冻结语义的镜像仍不完全
  （minor-4/5——rebinding、IPv4-mapped、"省略 cache_ttl_s"等分支只在
  design+tasks 层冻结，scenario 层无独立负例）；155B 笔误写进了实现
  任务说明（tasks 1.5b），实现期必然触发一次小返工；A3/老 SDK 两处
  残留措辞说明"全文贯穿"未做到逐句干净。这些属于实现期可顺手消化的
  尾差，不构成设计缺陷。

## 结论：PASS-TO-IMPLEMENT（附条件）

**PASS-TO-IMPLEMENT。** 设计/spec 层面的安全语义与可测性冻结已达到
可实现标准：R4 全部 8 个 P1 闭合、无新增 P0/P1、代码事实引用无虚构、
独立门禁（strict validate + diff check）通过。tasks.md 未勾选是预期
状态。

附非阻塞条件（实现期执行，无需新开复核轮）：

1. 将 design.md:633 与 tasks.md:35 的 `155B` 修正为 `113B`（并在
   tasks 1.9 补 length==113 断言）；顺手澄清 minor-1 的 sentinel 措辞。
2. tasks 1.9 测试矩阵补 DNS rebinding / IPv4-mapped / 混合多地址
   SSRF 负例与 `cache_ttl_s 省略 → 配置默认` 正例（minor-4/5）。
3. A3 行与 §14 老 SDK 迁移句补 policy 限定（minor-2/3）——纯文档
   卫生，可与 2.6"实现偏差回写 spec"一并处理。
4. 实现阶段按 tasks.md 1.1-1.9 的 relay/rendezvous/registry/webhook
   adversarial 测试矩阵执行，stock 装配断言（1.5b 末项）不得省略。
