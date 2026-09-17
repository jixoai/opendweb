# server-access-policy R4 终验

复核对象为 `eed7480`，基线为 `main@ae271cf`；R3 清单取自
`docs/codex-review-sap-r3.md:265-275`。这是设计/spec 层终验，`tasks.md`
仍未勾选属于预期，不作为实现缺陷。独立门禁：
`openspec validate server-access-policy --type change --strict --no-interactive`
通过，`git diff --check ae271cf..eed7480` 通过。

## R3 清单闭合核验

### 1. P0-B1：L1b 不可绕过与 A_cb(S) —— 部分闭合

**已闭合部分。** `design.md:433-475` 和 `specs/server/spec.md:76-112`
明确把 registry 二元组和当前操作所需 caps 位提升为 L1b，要求在任何
provider/webhook 之前执行；无效票据不得到达 webhook。`design.md:563-577`
又把无票 callback 放行另定义为 `A_cb(S)`，可达边界写成
`A(S) ∪ A_cb(S)`，static 下 `A_cb(S)=∅`。

**单 hook 可实现性已核实。** iroh-relay 的唯一准入接口是
`iroh-relay-1.1.0/src/server.rs:285-305` 的 `AccessControl::on_connect`。
`ClientRequest` 已带认证后的 `endpoint_id`、请求头/查询 token 和
`connection_id`（`.../server.rs:185-276`）；stock HTTP 路径先认证、构造请求，
再调用 `authorize_with`（`.../server/http_server.rs:868-879`），而
`authorize_with` 在返回 Allow 后才创建断开 guard
（`.../protos/handshake.rs:489-503`），最后才 `Clients::register`
（`.../server/http_server.rs:894-898`）。因此 L1→L1b→L2（webhook 为最后一段）
可全部放在同一个 `on_connect` 内，不需要二次 hook。

**未完全闭合原因。** callback 例外没有同步替换所有旧的 A(S) 边界文字：
`design.md:513-521` 仍断言经 relay 的端点恒属于 A(S)，而
`design.md:569-577` 允许无票端点进入 A_cb；`design.md:651-653`、
`design.md:851-853`、`design.md:915-917` 及 `specs/server/spec.md:14-17`
仍把无票/集合外端点一概视为必拒。实现者据此会在“callback 无票名单”与
“任何无票必拒”之间分叉。

### 2. P0-B2：callback 事件范围与 rendezvous —— 闭合

`design.md:579-583`、`specs/server/spec.md:110-112` 已把事件冻结为
`relay.connect` / `relay.disconnect`，并明确 rendezvous 不接 callback、继续静态
ACL。当前 rendezvous 是独立 HTTP 路由（`crates/dweb-server/src/rendezvous.rs:121-201`），
没有可复用的 relay 握手身份；因此收窄范围确实消除了 R3 的“rendezvous callback
AuthContext 无法成立”问题。其静态 ACL 的验证链完整性另列为新 P1。

### 3. P1-A1：stock 装配边界 —— 闭合

`design.md:482-488` 已把“不绕过”限定为
`Server::spawn → authorize_with → Clients::register` 的 stock 装配，而非对
iroh-relay crate 全部公开 API 的绝对承诺。上游确实把 `Clients::register` 暴露给
embedder（`.../server/clients.rs:69-102`），并提供可绕过 hook 的
`authorize_if`（`.../protos/handshake.rs:517-526`）；当前项目路径仅调用
`Server::spawn`（`crates/dweb-server/src/relay.rs:25-43`）。边界声明与事实一致，
实现阶段的装配断言已列入 `tasks.md:28-40`。

### 4. P1-B3：并发风暴防护 —— 部分闭合

`design.md:603-612`、`specs/server/spec.md:112,149-152` 已冻结 per-key
singleflight、全局 64、每来源 16、队列 256，以及队满返回
`dweb/policy-unavailable`；该安全目标和可测分支已经存在。

但“来源”没有定义。上游 `ClientRequest` 公开字段只有 endpoint、connection、
URI、headers（`.../server.rs:185-276`）；监听器虽在
`.../server/http_server.rs:489-500` 得到 `peer_addr`，却没有传入 `ClientRequest`
（`.../server/http_server.rs:868-874`）。因此若“source”意指 IP/连接源，当前 hook
输入不足；若意指 endpoint_id，也必须明文冻结，避免实现各自选择 IP、endpoint 或
callback URL。

### 5. P1-B4：缓存键、失效与 TTL —— 部分闭合

`design.md:613-618` 和 `specs/server/spec.md:112,144-147` 已冻结
`registry_generation + endpoint_id + BLAKE3 + event`、registry 变更立即清缓存、
TTL 上限 60 秒、非法 `cache_ttl_s` 按 0，且明确缓存不撤销存量连接。这部分关闭了
R3 的 generation/TOCTOU 主风险。

仍未冻结 `capability canonical 投影` 的具体字节编码、BLAKE3 digest 的表示，
以及 `capability=null` 时的哈希输入；响应中省略 `cache_ttl_s`、未知字段和
`cache_ttl_s` 类型错误时的确切处理也没有 schema（`design.md:590-600,613-617`）。
不同实现可产生不同 key/缓存窗口，故不能算完整协议闭合。

### 6. P1-B5：callback 传输/SSRF 边界 —— 部分闭合

`design.md:619-623`、`specs/server/spec.md:154-157` 已冻结 HTTPS、显式
`allow_loopback_callback`、私网/ULA/link-local/metadata 拒绝、禁止重定向、4KiB
请求/响应体和 token 日志脱敏，R3 的主要 SSRF 约束已补齐。

但“解析后拒绝”没有冻结 DNS rebinding 的解析-连接绑定，也没有说明 IPv4-mapped
地址、多个 A/AAAA 结果、系统代理是否绕过地址检查。若实现先解析检查再由 HTTP
客户端重新解析，仍可能把 token 发往后续解析到的私网地址。

### 7. P1-B6：reason 语法 —— 闭合

`design.md:624-626` 与 `specs/server/spec.md:124-127` 给出同一冻结语法
`dweb/[a-z0-9][a-z0-9._-]{0,63}`，并规定控制字符、非 ASCII、空值和超长值统一
替换为 `dweb/policy-denied`；`tasks.md:28-39` 也列出对应测试。

### 8. P1-B7：disconnect 生命周期 —— 部分闭合

`design.md:627-631`、`specs/server/spec.md:159-162` 已明确 disconnect 是
best-effort、fire-and-forget、可丢失、不可作为配额或撤销依据；这与上游
`AccessControl::on_disconnect` 的同步、每条已准入连接一次回调语义
（`.../server.rs:295-305`）相容。

但 callback 协议只给出了 connect 请求体
（`design.md:585-600`），没有冻结 disconnect 请求体是否携带 endpoint、
capability/context、event id 或仅携带 connection_id。上游 disconnect 不再提供
token/context，若业务需要这些字段必须说明 server 如何按 connection 保存、如何处理
重复/乱序/重启；否则实现只能自行猜测。

### 9. C：动态策略回调 scenario 可测性 —— 部分闭合

从 `specs/server/spec.md:114-167` 逐个计数确有 11 个 `Scenario`，且已加入无效票、
registry generation、并发、SSRF 和 disconnect 分支，数量层面闭合；但可构造性仍有
两处硬冲突：

1. `specs/server/spec.md:129-132` 明确无效票据在 webhook 前拒绝，然而
   `specs/server/spec.md:144-147` 的 registry 场景在 unregister 同一票据后又要求
   “产生新回调”。L1b 会先返回 `dweb/unknown-owner`，该请求不可能触发 webhook。
2. `specs/server/spec.md:164-167` 的 Visitor/无票第三方场景落在 callback
   requirement 的 11 个 scenario 内，却没有 `policy=static` 或 webhook 对无票一律
   deny 的前置条件；在 `A_cb(S)` 允许无票端点时，其“第三方必被拒”结论并不成立。

另外，响应未知字段/省略 `cache_ttl_s` 等 schema 分支仍只在设计文字中隐含，未形成
可独立断言的 scenario。故不能把这 11 个标题直接视为完整负例矩阵。

### 10. 遗漏 5：relay bridge 的 restricted/A_cb 表述 —— 闭合（目标句）

`specs/server/spec.md:7` 已明确仅在 `restricted` 下使用
`A(S)`，callback 另加 `A_cb(S)`，`open` 不设该边界，正好满足 R3 清单的目标
修订。其余旧段落的冲突属于上面 P0-B1 和下方 P1 新问题，不改变该目标句本身已被
修正的事实。

## 新发现问题

### P1-1：A_cb(S) 没有贯穿所有安全边界和基础 scenario

**现象/证据：** `design.md:569-577` 定义 callback 无票集合，但
`design.md:513-521,651-653,851-853,915-917`、`design.md:902` 以及
`specs/server/spec.md:14-17,51-54` 仍写“无票必拒”或“restricted + 空 registry
拒绝一切”。这与 callback 无票准入（`specs/server/spec.md:139-142`）直接矛盾，
会改变实现的安全边界。

**可验证修复建议：** 全文将旧断言显式限定为 `policy=static`，并把 callback 模式
统一写成 `A(S) ∪ A_cb(S)`；空 registry/no-capability scenario 拆成 static 拒绝与
callback webhook deny/allow 两个独立用例。

### P1-2：registry 清缓存 scenario 要求了不可能的 webhook 调用

**现象/证据：** `specs/server/spec.md:129-132` 与
`design.md:565-568` 要求 L1b 失败不得回调；但
`specs/server/spec.md:144-147` 对刚 unregister 的同一票据要求缓存失效后产生新回调。

**可验证修复建议：** 将该 scenario 改为“generation 变更后旧缓存不命中，随后由
L1b 直接返回 `dweb/unknown-owner` 且 webhook 调用计数为 0”；另增一个仍然有效的
票据或无票 A_cb key 来单独验证 generation 清缓存确实导致一次新回调。

### P1-3：per-source 限额没有可实现的 source 定义

**现象/证据：** `design.md:608-610,787` 和 `specs/server/spec.md:112` 冻结了
“每来源 16”，但上游 hook 输入（`.../server.rs:185-276`）没有远端地址；监听器的
`peer_addr` 未传给 `ClientRequest`（`.../server/http_server.rs:489-500,868-874`）。

**可验证修复建议：** 明确 source=`endpoint_id`（最小改动），或冻结可信 remote
address/代理头的获取和 rebinding 语义，并把 source 维度加入压力 scenario。

### P1-4：缓存 projection/响应 schema 未冻结

**现象/证据：** `design.md:590-600` 只展示 JSON 形状，
`design.md:613-617` 只写“canonical 投影”和 BLAKE3；未定义字段顺序/数值编码、
`null` 的固定输入、digest 表示、缺省 `cache_ttl_s` 和未知响应字段处理。

**可验证修复建议：** 采用一个固定的结构化/二进制投影并列出字段顺序、字节序和
`None` sentinel，冻结 digest 为 32-byte 内部值；为 allow/deny 的省略、非法类型和
未知字段写出 MUST 行为与独立 scenario。

### P1-5：disconnect callback 的载荷和上下文生命周期未冻结

**现象/证据：** 规范只要求携带 `connection_id`
（`specs/server/spec.md:159-162`），connect body 才定义了 capability
（`design.md:590-597`）；上游 disconnect 仅传 endpoint_id/connection_id
（`.../server.rs:295-305`）。

**可验证修复建议：** 冻结 disconnect JSON schema（至少 event、endpoint_id、
connection_id，明确 capability 是否为 null/是否复用 connect snapshot），并规定每
connection 一次、乱序/重启的可观测语义；保持 best-effort 不能成为配额或撤销依据。

### P1-6：非法 Authorization header 可能被降级为 A_cb 无票

**现象/证据：** `ClientRequest::auth_token()` 对非法 UTF-8 Authorization header
直接返回 `None`（`.../server.rs:252-276`），而设计把 `None` 解释为无票并送入
callback（`design.md:442-463,569-577`）。因此“出现了非法票据”与“没有票据”在
hook 输入中不可区分；这也削弱了 `specs/server/spec.md:129-132` 所要求的无效票不
触发 webhook 断言。

**可验证修复建议：** 在策略入口先区分 Authorization 缺失、Bearer 值非法 UTF-8、
query token 和合法空值；任何声明存在但解析失败的 token 统一在 L1 返回
`dweb/malformed-capability`，不得进入 A_cb webhook。

### P1-7：rendezvous 静态 ACL 的完整 L1/L1b 链未冻结

**现象/证据：** `design.md:523-537,579-583` 与
`specs/server/spec.md:169-191` 只明确 Bearer、RDZ caps 和 announce recipient
绑定；没有明确 rendezvous 是否复用 server_id、时间、签名、registry 二元组的完整
L1/L1b 验证及各失败 reason。当前 HTTP 路由本身只有签名 announce/匿名 resolve
（`crates/dweb-server/src/rendezvous.rs:121-201`），不能从 relay on_connect
自动继承这些检查。

**可验证修复建议：** 明确 rendezvous 走同一不可绕过 verifier（按 announce/resolve
分别要求 RDZ caps，announce 另做 recipient==签名者），或逐字段写出独立链和 401
映射；为 bearer-only resolve 的泄露/TTL 边界保留负例。

### P1-8：SSRF 的 DNS/地址族/代理语义仍可分叉

**现象/证据：** `design.md:619-623` 只有“解析后拒绝网段”，没有规定解析结果
固定到实际连接、IPv4-mapped 地址归一化、多地址选择或系统代理绕过行为。

**可验证修复建议：** 要么只允许已解析且固定的公网 IP，要么冻结每次连接的解析-校验-
连接原子语义并拒绝 rebinding；明确 IPv4-mapped/AAAA/代理规则，并在 SSRF scenario
中加入 DNS rebinding 和 IPv4-mapped 负例。

## 最终评分：7.0/10（与 R1/R2/R3 轨迹对比说明）

评分轨迹为 R1 5.5 → R2 5.9 → R3 6.1 → R4 7.0。相对 R3，本轮确实关闭了
两个核心方向：L1b registry/caps 底线已在单一 `on_connect` 内、webhook 之前冻结，
callback 事件也收窄到 relay；并发、SSRF、reason、generation 缓存和 best-effort
disconnect 均有可测文字。扣分来自 A_cb 与旧安全边界互相矛盾、两个 scenario 的
逻辑不可满足，以及 source、canonical cache、disconnect payload、非法 header、
rendezvous ACL 和 DNS 解析等仍会让实现产生不同安全行为。

## 结论：NEEDS-WORK（附条件）

尚不能 PASS-TO-IMPLEMENT。进入实现前必须：

1. 全文统一 `A(S)`、`A_cb(S)` 和 `policy=static/callback`，修正 §8.3、§9、§13、
   §15、空 registry/no-capability scenario 的旧断言；
2. 修正 registry scenario 的“无效票仍触发 webhook”矛盾，并将 Visitor scenario
   明确限定 static 或 callback-deny；
3. 冻结 per-source 身份、canonical projection/`None` sentinel、digest 和完整
   callback response schema；
4. 冻结 disconnect payload/context 生命周期、非法 Authorization 的 fail-closed
   分类、rendezvous 的完整 L1/L1b 链；
5. 补齐 DNS rebinding/地址族/代理 SSRF 语义及对应独立 scenario，再由实现阶段按
   `tasks.md:1.1-1.9` 的真实 relay、rendezvous、registry 和 webhook adversarial
   tests 复核。
