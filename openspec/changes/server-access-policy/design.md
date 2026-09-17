# Design: server-access-policy — Server Owner/Visitor 权限模型（R2）

> 意图清单：
> 1. [2026-09-17] Owner 原始需求：Server 级授权（Owner 可用基础设施、Visitor 只能参与）
> 2. [2026-09-17] 分层原则：Server 授权 / Fabric 授权 / Session 授权三问独立
> 3. [2026-09-17] 复用原则：不重复实现 Identity/Roster/Grant/Session Gating
> 4. [2026-09-17] R1 复核修订（Codex 5.5/10 → 本版）：需求语义精确化（§1.3）、
>    REDEEM_OK2 新帧、invite v2 强制 recipient、resolve bearer-only 降级、
>    F6/Limits/QAD/兼容措辞等全部 P0/P1/P2 闭合
>
> 本文是第一阶段（技术设计讨论）交付物，不写代码。代码引用基于
> main@ae271cf 实测；iroh-relay 引用基于 1.1.0 源码（registry
> index.crates.io-1949cf8c6b5b557f）。

---

## 0. 需求语义的精确化（R1 P0-1/P0-2 的裁决，全文的语义基座）

原始需求的"Visitor 不能**主动把 Server 当成自己的 relay/rendezvous 基础
设施**使用"是一个自然语言约束，必须形式化为可执行、可验证的边界，否则
无法评判任何方案。本 change 采用的形式化（**仅约束 `restricted` 模式**；
`open` 模式下 Server 不启用访问控制，接入集合无界，行为与现状一致——
R2 P0-N1 修正）：

```
定义（restricted 模式下 Server 基础设施的"授权接入集合"）：
  A(S) = { EndpointId e | e 持有某注册 Owner 签发的、未过期的、
           recipient==e 的有效 capability }
  （时间性：A(S) 是"接入判定时刻"的快照语义——on_connect 时点校验；
   撤销/过期对存量接入存在宽限期，见 §13 撤销窗口——R2 P1-N1 修正）

边界裁决（"主动使用"的禁止含义，restricted 模式）：
  R1. 任意 e ∉ A(S)：不得接入 relay，不得 announce/resolve rendezvous
      ——匿名第三方白嫖被完全阻止。
  R2. e ∈ A(S)：可作为 relay client 接入；其 relay 流量只能送达
      A(S) 接入中的其它端点（iroh-relay 1.1.0 投递目的地只能是在线
      ConnectedClient，§1.1 F6）。
  R3. e ∈ A(S) 与 A(S) 内其它端点经 relay 互连 —— 是否属于「参与授权
      Owner 名下的连接」是产品语义裁决，见 §0.1。
  R4.（callback 模式附加）经 webhook 无票放行的端点构成第二可达集合
      A_cb(S)（§8.5），可达边界读作 A(S) ∪ A_cb(S)；A_cb(S) 由
      admin 自担（Owner 裁决的"动态门槛"表达），static 模式下
      A_cb(S) = ∅。
```

### 0.1 R3 的产品语义裁决（Owner 已确认）

R1/R2 两轮 Codex 复核对"同 Owner 名下端点经 relay 互连"是否违反原始需求
存在分歧，且该分歧**不是技术问题而是产品意图问题**，技术事实如下（两轮
复核均确认）：

- 端侧 fabric 是全连通模型：roster 有效成员间任意可建 session
  （fabric.rs:1902-1908、2675-2685）。
- iroh-relay 1.1.0 的投递按 `dst_endpoint_id` 逐报进行，**没有
  per-destination 的授权 hook**（AccessControl 仅 on_connect/on_disconnect，
  server.rs:285-305）——relay 层无法表达"只能发给特定对端"，除非
  vendored fork iroh-relay 在转发路径插入策略检查（本仓库既有裁决
  "不动 iroh 上游"，见 relay-failover-hardening proposal）。

由此只有两个自洽的产品语义可选：

- **共享接入语义（Owner 2026-09-17 确认采纳）**：授权单位是
  "注册 Owner 签发的 capability"。Owner 名下端点（Owner 自身 + 其邀请的
  Visitor）共享本 Server 的 relay 接入资格，彼此可经 relay 互连。滥用
  边界 = A(S) 之外零可达（白嫖/冒充/为无关第三方中继全部阻断）；
  A(S) 内的资源消耗由 registry 移除（新连接即时拒）+ TTL + client_rx
  限流 + Phase 3 per-owner 配额约束。Owner 裁决原文意图：「我的目的只有
  一个：当别人私有化部署了 OpenDWeb，我希望它只服务于自家的业务，而
  不是被别人拿去滥用作为中继服务器，所以我需要有一个使用门槛。这个
  使用门槛是可以动态配置的……围绕这套密钥系统去实现动态的授权：通过
  自定义 hook/callback 来实现动态能力」——即：门槛 = Server 级准入；
  动态性 = §8.5 的可插拔策略层（PolicyProvider + callback hook）。
- **严格配对语义（否决）**：Visitor 仅可与 Owner 端点经 relay 通信。
  需要 fork iroh-relay 加 per-dst enforcement——成本高、偏离"纯调用
  上游"原则，且与 fabric 全连通模型（端侧本来允许 Visitor 互连直连）
  形成两层语义不一致。若未来产品确需，capability 已预留 peer_scope
  扩展位（§7.2），届时以独立 change 评估 fork。

**裁决：Owner 已确认共享接入语义（2026-09-17）。**该裁决作为需求基线
回写 requirements.md 注记，后续复核不再将 R3 视为缺口。严格配对语义
（fork iroh-relay）路径封存；peer_scope 扩展位保留（§7.2）。

R3 成立的支撑论证（保留备查）：

1. **fabric 全连通模型**：Owner 名下两个 Visitor 在端侧本来就能互建
   session；他们经 relay 通信只是同一既定权限在传输路径上的投影。
   Server 在 relay 层禁止它没有意义——端侧已授权，且 relay 看不见
   fabric 语义（§5.2 鸡蛋问题）。
2. **"与授权集合外端点通信"才是需求关心的滥用**：Visitor 给自己
   fabric 之外的 peers、给第三方服务当中继——这些路径全部要求对端
   ∈ A(S)，全部被 R2 阻断（对端无票进不来 relay）。
3. **跨 Owner 通信在应用层不可能成立**：不同 fabric 的成员间 session
   被端侧门控拒绝（roster 按 fabric_id 隔离）；relay 层即使出现 A(S)
   内跨 Owner 的"混流"，也只是两端点间加密 QUIC 包的搬运，无应用语义。

1. **fabric 本来就是成员全连通模型**：roster 的 `effective_members` 中任意
   两名成员都能互建 session（fabric.rs:1902-1908 发起侧无目标限制，
   accept 侧只验成员资格）。Owner 名下两个 Visitor 在端侧本来就能直连
   通信；他们经 relay 通信只是**同一既定权限在传输路径上的投影**。
   Server 在 relay 层禁止它没有意义——端侧已授权，且 relay 看不见
   fabric 语义（§5.2 鸡蛋问题）。
2. **"与授权集合外端点通信"才是需求关心的滥用**：Visitor 给自己 fabric
   之外的 peers、给第三方服务、给自己的其它网络项目当中继——这些路径
   全部要求对端 ∈ A(S)，全部被 R2 阻断（对端无票进不来 relay）。
3. **跨 Owner 通信在应用层不可能成立**：不同 fabric 的成员间 session 被
   端侧门控拒绝（roster 按 fabric_id 隔离）；relay 层即使出现 A(S) 内
   跨 Owner 的"混流"，也只是两端点间加密 QUIC 包的搬运，无应用语义。

与之对照的**更强语义**（"Visitor 只能与 Owner 本人的端点通信，Owner 名下
Visitor 之间也不许"）需要 relay 维护配对状态（per-pair 会话表、目标
peer 绑定、session nonce）。它在 iroh-relay 现有模型上没有 hook 点
（AccessControl 仅 per-connection 的 on_connect/on_disconnect，server.rs:285-305），
要实现等于重写 relay 转发层，且让 relay 必须理解"谁是 Owner、谁在参与谁的
连接"——重新引入 §5.2 否决的 fabric-aware 复杂度。收益（阻止 Owner 名下
成员互连）与 fabric 全连通语义直接冲突，不构成安全增益。
**裁决：不采用**，future-work 里保留"peer scope 绑定"作为 capability
可选扩展（§7.2）。

---

## 1. 现状架构与代码路径

### 1.1 分层现状

```
┌─────────────────────────────────────────────────────────────────┐
│  packages/*（TS）                                                  │
│  opendweb CLI ─ server-binary(napi spawn) ─ client-sdk(napi 绑定) │
└──────────────┬──────────────────────────────────┬───────────────┘
               │ spawn / HTTP                     │ napi
┌──────────────▼─────────────────┐  ┌─────────────▼───────────────┐
│  crates/dweb-server（bin）      │  │  crates/dweb-fabric（lib）   │
│  ├ relay.rs     iroh-relay 嵌入 │  │  identity.rs  EndpointId    │
│  │              AllowAll+无限流 │  │  roster.rs    签名事实投影   │
│  ├ rendezvous.rs 签名登记/匿名  │  │  session.rs   HELLO/REDEEM   │
│  │              解析（内存态）  │  │  fabric.rs    门控/拨号/事件  │
│  ├ services.rs  services.json  │  │  protocol.rs  Fact/Invite 线 │
│  └ main.rs      CLI/env 配置   │  │  continuity/  会话连续性      │
│  ※ 无 identity/持久化/admin 面  │  │  secret.rs    SecretStore    │
└──────────────┬─────────────────┘  └─────────────┬───────────────┘
               │ iroh-relay =1.1.0 (server)        │ iroh =1.1.0
┌──────────────▼──────────────────────────────────▼───────────────┐
│  iroh 1.1 QUIC（打洞/路径迁移/relay fallback 在 endpoint 内部完成）│
└──────────────────────────────────────────────────────────────────┘
```

关键事实（R1 复核后逐条核正）：

| # | 事实 | 证据 |
|---|---|---|
| F1 | Server 无自己的 identity/secret/持久化，重启清空 rendezvous | dweb-server 全 crate 无 keypair 代码；rendezvous.rs:78-81 纯内存 |
| F2 | relay ACL hook 存在但配了 AllowAll，限流未配置 | relay.rs:15-50 未触碰 `RelayConfig.access/.limits`；iroh-relay server.rs:155-163 默认 AllowAll |
| F3 | iroh-relay WS 握手密码学认证 EndpointId；on_connect 在认证后、注册前被调用，可拿到 Bearer/query token | 握手签名/验证 iroh-relay protos/handshake.rs:223-240,452-471（派生消息 :200-220）；ClientRequest/auth_token server.rs:185-276；调用点 http_server.rs:868-898 |
| F4 | 客户端 per-relay token 传递 iroh 已内置（native Bearer header / wasm query） | iroh-relay relay_map.rs:232-267、client.rs:320-325,407-410 |
| F5 | 客户端身份 = iroh Ed25519 keypair；endpoint 以 identity key 构建，TLS peer id == EndpointId | identity.rs:43,110-113；fabric.rs:1421-1428（`builder.secret_key(identity.secret_key().clone())`） |
| F6 | relay（WebSocket 面）是逐数据报转发：`Datagrams{dst_endpoint_id}`；**投递目的地只能是在线 ConnectedClient**（投递分派在注册表 server/clients.rs:199-216，入队方法 server/client.rs:199-211）；目标不在注册表时**静默丢包**，仅对**已有 sent_to 关系**的目标断开时发 `EndpointGone`（clients.rs:119-168） | iroh-relay protos/relay.rs:177-186、server/clients.rs、server/client.rs |
| F7 | holepunch 协调在 **iroh endpoint 内部**（remote_state），协调消息经 relay 数据报交换；Server 自研层不参与信令；spike-iroh 仅验证自建 relay + 基础互连 | iroh-1.1.0 socket/remote_map/remote_state.rs:504-531,922-945；spike-iroh/src/main.rs:301-343 |
| F8 | rendezvous announce 有 EndpointId 签名验证，resolve 匿名；**无客户端运行时代码消费 /rendezvous API**（仅 server 自身、manifest 测试断言与 example fixture 命中） | rendezvous.rs:99-119（签名）、:186-201（匿名 resolve） |
| F9 | 成员授权全部在端侧（roster 投影 + 双侧门控），Server 不参与 fabric 协议 | fabric.rs:1902-1908、fabric.rs:2675-2686；dweb-server 的 Cargo.toml 无 dweb-fabric 依赖 |
| F10 | 现行 server spec 冻结了"relay 不是成员授权点，其访问控制（若启用）仅限制 relay 使用" | specs/server/spec.md:10 |

### 1.2 需求的分层映射

```
授权问题                        现状                本 change 之后
─────────────────────────────────────────────────────────────────
Q1 谁有权使用本 Server 基础设施?  无（AllowAll）      ★ 新增 Server Access
                                                    Policy + capability
Q2 谁属于某 Fabric?             roster（完备）      不动
Q3 某 Session 是否允许建立?      双侧门控（完备）    不动（且不感知路径）
─────────────────────────────────────────────────────────────────
"某 Session 是否走 relay"?       无此概念           不新增——路径由 iroh
                                                    决定，Q1 已在入口拦住
```

Q1 是唯一缺口。且 Q1 的执行点必须在 relay **接入时刻**（on_connect），
不能等到 Q3——鸡蛋问题见 §5.2。

---

## 2. 现状实现：Identity / Session / Relay / Rendezvous

### 2.1 Identity（客户端）

- `EndpointId = iroh_base::PublicKey`（identity.rs:43）。Ed25519；展示为
  z-base-32 52 字符（identity.rs:94-103）。
- 持久化：`<data_dir>/identity.key`（32B 裸 seed，0600，tmp+fsync+rename
  原子写，secret.rs:54,165）；`load_or_create` 幂等（secret.rs:265）。
- **没有第二套密钥**：fact/invite/PoP/iroh TLS 全用同一 keypair（E1 等式，
  §8.1）。

### 2.2 Fabric 成员授权（roster / grant / invite）

- 模型：签名事实集合 + 确定性投影。`Fact{kind,fabric_id,issuer,subject,…}`
  canonical 域分隔编码，`fact_id=BLAKE3` 内容寻址（protocol.rs:236-274）。
- `FactKind = Genesis|Grant|Join|Revoke`（protocol.rs:185-197）。root-only
  签发；投影 = root + 未撤销未过期 root Grant（roster.rs:572-654）。
- invite：`dweb1.` 令牌（protocol.rs:588-606,779-843），含 issuer_relay_url/
  direct_addrs/expires/**可选 recipient 预绑定**；兑换校验含 recipient
  （session.rs:629-659）；PoP 域 `dweb/redeem-pop/v1`（protocol.rs:845-859），
  redeemer 必须 == TLS peer（session.rs:611-612）；single redemption 持久化
  CAS（roster.rs:885-920）。
- **关键约束（R1 P0-3）**：`REDEEM_OK` payload 是全量 fact dump，旧客户端
  用 `decode_all` 解析且**严格拒绝尾随字节**（session.rs:475-480、
  protocol.rs:509-546）——任何"追加段"都会破坏旧客户端。回执扩展必须走
  新帧类型（§12）。

### 2.3 Session（含 gating）

- regular ALPN（HELLO + per-message bidi 流）与 continuity ALPN
  （SESSION_INIT/RESUME）；redeem 独立 ALPN。
- 双侧门控点：发起 fabric.rs:1902-1908 / manager.rs:96-108；接受侧
  fabric.rs:2641-2686，先门控后任何应用数据。门控输入只有本地 roster
  投影；continuity `POLICY_DENIED` 语义不变。
- 成员间为全连通模型：任何两名有效成员可互建 session（§0 R3 论证的基础）。

### 2.4 Relay / Rendezvous（Server 侧）

- relay：`iroh_relay::server::Server::spawn`（relay.rs:41-43）；tls 恒 None
  → QUIC 数据面从不启用。注意：iroh-relay 的 `ServerConfig.quic` 实为
  **QAD 地址发现服务**（`/iroh-qad/0`，quic.rs:1-14,85-111,206-238），
  不是 relay 转发数据面；它同样没有 AccessControl（R1 P1 修正）。
- rendezvous：announce（Ed25519 签名载荷、±120s、TTL≤3600s）/ resolve
  （匿名）；内存 HashMap。
- 客户端发现：invite 携带 issuer relay/direct 提示 + known_addrs 学习 +
  本地 relay 配置兜底（fabric.rs:2188-2229）。

---

## 3. 已具备的能力（无需重建）

```
✅ EndpointId 密码学认证到达 relay 层（iroh-relay 握手，F3）      ← Q1 执行点的基础
✅ relay 层授权 hook + 凭证通道 + 拒绝原因回传（iroh-relay 原生）   ← 只需实现 trait
✅ 客户端 per-relay token 注入（iroh 原生，F4）                    ← 只需把 token 喂进去
✅ root 签名/验证、recipient 绑定、PoP、时间窗（fabric protocol）   ← capability 的密码学语料
✅ invite 兑换在线协议（REDEEM_*，含版本信号位）                    ← 附发 capability 的通道
✅ Fabric 成员授权与双侧 Session 门控（Q2/Q3 完备）                 ← 完全不动
✅ Server 配置入口雏形（flag/env/[server] config 段 + services.json）← policy 配置可挂靠
```

## 4. 缺失的能力（本 change 的建设面）

```
❌ Server Identity 与持久化 secret（server.key）
❌ Server 访问策略配置面（mode、owner registry、limits 接线）
❌ Owner Registration（谁可授权他人使用本 Server）
❌ capability 令牌格式、签发/验证/续期/撤销语义
❌ relay on_connect 执行器（验证链 + deny reason）
❌ rendezvous announce/resolve 的 ACL（含 announce 的 recipient 绑定校验）
❌ invite v2（restricted 场景强制 recipient 预绑定 + 内嵌 capability；
  附录 A 为唯一 wire 权威，invite-token-multi-relay 复用之）
❌ REDEEM_OK2 新帧（回执附发 capability，不破坏旧解析器）
❌ fabric RelayConfig / SDK RelayOptions 的 per-relay token
❌ root 自签与 REDEEM_OK2 附发的发放链
```

---

## 5. 架构方案比较

### 5.1 方案 A（推荐）：Owner-signed capability + Server 侧 owner registry

```
        Server Admin（机器管理者，本地配置/命令）
            │ 注册 (fabric_id, root EndpointId)
            ▼
   ┌─────────────────────────────┐
   │ dweb-server                 │
   │  server.key (ServerId)      │
   │  owner registry (持久化)    │
   │  AccessControl::on_connect ─┼─► 验证链（§8.2）
   │  rendezvous ACL             │
   └─────────────────────────────┘
            ▲ Bearer dwebr1.…（iroh auth_token 通道）
            │
   Owner(root) ──自签──► own capability
      │  invite v2 内嵌 bootstrap capability（restricted 下强制 recipient）
      └─ REDEEM_OK2 附发 member capability（长 TTL，绑 redeemer）
            ▲
      Visitor 持 capability 连 relay ──► 验证链全过才放行
```

- 授权判据 = 密码学（root 签名 + registry + EndpointId 绑定 + TTL），
  与 IP:port 无关。
- relay 对 fabric 完全不透明：只认"注册 Owner 签发的、未过期的、绑定你
  身份的 capability"，不解析 roster。
- 授权边界即 §0 的 A(S) 语义：接入与投递都以 A(S) 为界。

### 5.2 方案 B（否决）：fabric-aware Server（Server 理解 roster/session）

设想：Server 维护 roster 副本，relay 只转发"双方都是注册 fabric 成员"的
流量。**存在不可解决的鸡蛋问题**：

```
iroh QUIC 连接建立（路径选择含 relay）──► fabric 握手（TLS/ALPN）──► session 门控
        ▲                                        │
        └── relay 接入判定必须在此发生 ◄──────────┘ 时序上不可能
```

1. relay 是 QUIC 连接的**传输路径**，fabric session 在 QUIC **之上**——
   Server 在 relay 接入时刻没有任何 fabric 语义可用（Visitor 拨 Owner 时
   连 TLS 握手都还没发生）。
2. relay 流量端到端加密，Server 无法把转发流映射到 fabric session——除非
   终结/中间人化 QUIC，破坏 spec 冻结的"relay MUST NOT 解密"。
3. 要消除 1/2 只能让 Server 参与 roster gossip 成为 fabric 节点——复杂度、
   攻击面、信任模型全面恶化；且 R1 复核确认 iroh-relay 的转发层没有
   per-pair hook（F6），配对级判定需要重写 relay。
4. §0 已论证：A(S) 语义下 per-connection 检查已覆盖需求的真实边界
   （授权集合外端点不可达）；更强的配对语义与 fabric 全连通模型冲突。

结论：Server 保持传输设施定位；fabric 语义留在端侧。

### 5.3 方案 C（退化形态，不单独立项）：纯 Server Admin ACL

Admin 手工维护 endpoint 白名单，无 owner-issued capability。
- 优点：实现最小（registry → on_connect 查表）；单人自托管够用；
  A(S) 直接等于白名单集合。
- 缺点：invite 自治链断裂——每个 Visitor 加入都要 admin 手工登记；Owner
  无法自行扩张/收缩；多 Owner 场景不可运营。
- 定位：方案 A 的子集（capability 层退化为 endpoint 直登记）。作为 A 的
  `restricted-endpoint` 简化变体在 §11 配置面保留表达。

### 5.4 Model A × Model B（需求第 7 节）的裁决

**两层都要，但职责不同**——Admin 管"哪些 Owner 有资格"（registry，
粗粒度、低频），Owner 管"哪些 Endpoint 可用"（capability，细粒度、
高频、密码学可离线验证）。Server 不签 capability（不能伪造 Owner 意志），
Owner 不接触 Server 管理面（不能自我提权）：

```
Admin（Model A 面）:  registry ∈ {(fabric F1,root1), (F2,root2)}  ← 谁能当 Owner
Owner（Model B 面）:  capability 签发/续期（root 私钥，离线自主）   ← 谁能用基础设施
```

R1 复核认可该职责分离对"粗粒度 Server 使用权"是正确取舍；其质疑的
"配对授权缺口"由 §0 的语义精确化裁决回应（那不是缺口，是 fabric 语义
的忠实投影）。

---

## 6. Server Identity / Management Key 职责

### 6.1 为什么需要

- restricted 模式下 capability 绑定 `server_id` 防跨 Server 重放（同一
  Owner 多 Server 时每 Server 一张票）；
- services.json 发布 ServerId 供客户端在多 Server 场景选择/校验对应
  capability；
- 管理面凭证（Phase 3 admin API：admin token 由 server.key 签发）；
- 注册回执签名（registry 事件可审计、可验证未被篡改）。

### 6.2 职责边界（收窄原则）

```
server.key（Ed25519，<data_dir>/server.key，0600，原子写）
 ├── ✅ ServerId 自标识（services.json、capability 的 server_id 字段）
 ├── ✅ admin token 签发验证（Phase 3 admin API）
 ├── ✅ Owner 注册回执签名（可审计性）
 ├── ❌ 不签 relay capability   —— Owner 意志只能由 root key 表达
 ├── ❌ 不参与 fabric 语义      —— roster/session 不感知 ServerId
 └── ❌ 不充当任何 Fabric Owner —— Server Admin ≠ Fabric Owner（需求 §3）
```

实现形态：与客户端 identity.key 同构（iroh SecretKey 32B seed、0600、
tmp+fsync+rename）。dweb-server 不依赖 dweb-fabric——server crate 内同构
实现原子写语义（约 60 行），**不引入 dweb-fabric 依赖**。

---

## 7. Owner / Visitor 权限模型

### 7.1 术语（消歧——仓库既有 "Owner" 指项目决策者，本节限定本 change 语义）

| 术语 | 定义 | 载体 |
|---|---|---|
| Server Admin | 运行 dweb-server 实例的人（机器/容器管理者） | 本地配置文件/CLI |
| Relay Owner | 在 owner registry 中注册的 `(FabricId, root EndpointId)` 的持有者 | registry 记录 + root 私钥 |
| Visitor | 持某 Relay Owner 签发 capability 的 EndpointId | capability 令牌 |

### 7.2 权限表达：capability 位图，不是 role 字段

```
CapsV1（u8 位图，预留至 32 bit）
  bit0 RELAY            经本 Server relay 接入/桥接
  bit1 RDZ_ANNOUNCE     rendezvous 登记
  bit2 RDZ_RESOLVE      rendezvous 解析（bearer-only，见 §8.4）
  bit3..7               reserved（验证链 MUST 拒绝未知位）
```

- **签发最小化原则（R1 P0-2 修复）**：签发 API 的默认 caps 由用途显式
  选择，不存在协议层"Visitor 默认全给"：
  - root 自签 own capability：`RELAY|RDZ_ANNOUNCE|RDZ_RESOLVE`；
  - invite v2 / REDEEM_OK2 附发 Visitor capability：**默认仅
    `RELAY`**（join 拨号必需），RDZ_* 由 Owner 显式勾选。
- capability 的 RELAY 位语义 = "作为 client 接入 relay"（§0 R2），不是
  "无限制使用 relay 基础设施"（§0 R3 已形式化二者差异）。
- 需求图景"Owner: relay+RDV / Visitor: RDV only"等由签发策略裁剪 caps
  位表达，无 role 概念。
- future work（不在本 change）：`peer_scope`（目标端点集合摘要）/
  `max_peers` 字段作为 capability 可选扩展，为更强配对语义预留——
  需要时再评估 relay 侧 enforcement 的 hook 改造成本。
- expires 已在令牌内；maxConnections/per-owner 配额 Phase 3 钩子（§13）。

### 7.3 生命周期

```
Owner 注册（admin，低频）────► registry 持久化（jsonl append）
Owner capability: root 本地自签（TTL 长，默认上限 180d）
Visitor bootstrap:  invite v2 内嵌（TTL 短 ≤ invite expires；
                    InviteV2 recipient 恒必填——与 server 模式无关）
Visitor member:     REDEEM_OK2 附发（TTL 建议 ≤90d/硬上限 180d，绑 redeemer）
续期:               Owner 经 regular 会话重发（revoke 后门控拒绝→自然断粮）
失效:               ① TTL 到期 ② registry 移除 Owner（新连接即时拒绝；
                    存量连接断连语义见 §13 撤销窗口）③ caps 位不匹配
                    ④ 出示者 ≠ recipient
```

---

## 8. Relay 层如何识别与授权 Client

### 8.1 承重墙等式

```
E1: relay 握手认证的 endpoint_id == iroh endpoint TLS id == fabric EndpointId
    （同一 Ed25519 keypair，F5）——「我持有该身份私钥」的 PoP 由 iroh-relay
    握手层天然完成，relay 无需任何额外 handshake。
    注意：E1 仅适用于 relay 面；HTTP rendezvous 面没有握手身份，
    其绑定手段见 §8.4（R1 P0-5 修复）。
```

### 8.2 on_connect 验证链（L1 密码学 + L1b 票有效性底线 + L2 策略）

> Owner 裁决（2026-09-17）要求"使用门槛动态可配置 + 自定义 hook/callback"。
> 验证链拆为三层：**L1 密码学完整性**与 **L1b 票有效性底线**（两者合计 =
> "有效票据"，对出示票据的接入**恒定执行、任何 provider 不可绕过**——
> R3 P0-B1 修复：callback 只能在底线之上收紧，不能升级低权限票）；
> **L2 准入策略**（门槛，可插拔 provider，见 §8.5）。static policy 下
> 行为与 R2 版十步链完全一致（向后一致）。

```
ClientRequest { endpoint_id(已认证), auth_token() }
  │
  ▼ L1 密码学完整性（本地，无网络调用；出示了 capability 才执行）
  ┌────────────────────────────────────────────────────────────────┐
  │ C1 长度门（≤1KiB）+ base64url 白名单 ──► DENY "dweb/malformed-capability" │
  │ C2 解析 dwebr1. + 字段形状校验 ────────► DENY "dweb/malformed-capability" │
  │ C3 caps 含未知保留位 ─────────────────► DENY "dweb/caps-unsupported"     │
  │ C4 Ed25519 验签（issuer over 域分隔）──► DENY "dweb/bad-signature"        │
  │ C5 server_id ≠ 本 ServerId ───────────► DENY "dweb/wrong-server"          │
  │ C6 时间三重校验：now >= expires_at 拒（同 protocol.rs:770-774 语义）      │
  │    或 issued_at > now+120s 或 issued_at > expires_at 或 TTL > 180d        │
  │    ──────────────────────────────────► DENY "dweb/capability-expired"    │
  │ C7 recipient ≠ endpoint_id ───────────► DENY "dweb/not-recipient"（E1）  │
  └────────────────────────────────────────────────────────────────┘
  ▼ L1b 票有效性底线（有票才执行；不可插拔——static/callback 共享）
  ┌────────────────────────────────────────────────────────────────┐
  │ B1 (fabric_id, issuer) ∉ registry ─────► DENY "dweb/unknown-owner"        │
  │ B2 caps 不含 op 所需位（relay→RELAY）──► DENY "dweb/caps-missing-relay"   │
  └────────────────────────────────────────────────────────────────┘
  有效票 → AuthContext { endpoint_id, capability: Some(VerifiedCap) }
  无票 → AuthContext { capability: None }（跳过 L1/L1b）
  │
  ▼ L2 策略决策（PolicyProvider::decide(AuthContext)，见 §8.5）
  ┌────────────────────────────────────────────────────────────────┐
  │ StaticRegistryProvider（默认，policy=static）：                   │
  │   capability == None ──────────────────► DENY "dweb/no-capability"        │
  │   有效票 ─────────────────────────────► ALLOW                          │
  │ CallbackProvider（policy=callback）：                            │
  │   POST webhook（§8.5 协议）→ allow / deny(reason)；              │
  │   webhook 无法豁免 L1/L1b（无效票在到达 webhook 前已拒）；        │
  │   无票端点交 webhook 裁决（identity 动态名单，A_cb(S)，§8.5）；   │
  │   超时/失联/非法响应/并发超限 ────────► DENY "dweb/policy-unavailable"   │
  └────────────────────────────────────────────────────────────────┘
  ▼ ALLOW（connection 注册；on_disconnect 释放计数）
```

deny reason 经 iroh-relay 握手协议原样回传客户端
（handshake.rs:487-503），SDK 透出为 relay 接入诊断事件。

**"不可绕过"的适用边界（R3 P1-A1 修正）**：以上顺序在 iroh-relay stock
装配路径（`Server::spawn` → HTTP WS 握手 → `authorize_with` →
`Clients::register`，http_server.rs:868-898、handshake.rs:480-505）成立；
iroh-relay 的 `Clients::register`/`authorize_if` 是公开 embedder API，
本项目 dweb-server 只经 `Server::spawn` 装配（relay.rs:41-43），集成测试
须断言不出现绕路装配。该不变量属"本项目装配边界"，不是对 iroh-relay
crate 整体 API 的绝对声明。

### 8.3 「参与 Owner 的连接」vs「主动使用 relay」（需求 §C 核心问题）

判定发生在 **relay 层（on_connect）+ 策略层（验证链）**，边界语义即 §0
的形式化定义。不需要新 handshake、不需要协议层显式区分"参与/主动"操作：

```
iroh relay 投递模型（F6）：
  客户端以 Datagrams{dst_endpoint_id} 逐报请求转发；投递目的地只能是
  在线 ConnectedClient（即通过 on_connect 的端点）；未注册目标静默丢包，
  已有 sent_to 关系的目标断开才发 EndpointGone。

Visitor 参与 Owner 名下的连接:
  Visitor(cap) ─ok─► relay ◄─ok─ Owner(cap)        ✅ 双方 ∈ A(S)
  Visitor(cap) ─ok─► relay ◄─ok─ 同Owner的另一成员   ✅ §0 R3：fabric 全连通
                                                      模型的路径投影

Visitor 主动把 Server 当自己的基础设施:
  Visitor(cap) ─ok─► relay ──drop── 无票 peer        ❌ 对端 ∉ A(S)，进不来
                                        ▲
                                        └─ capability 绑定 recipient(=Visitor)，
                                           第三方/自己其它 endpoint 均无票
```

即：**per-connection capability 检查 + relay 只投递在线 client 的模型 ⟹
经 relay 的通信端点在接入时刻均 ∈ A(S)**（撤销宽限期的存量接入除外，
见 §0 时间性与 §13）。Visitor 抄下 IP:port、relay URL、EndpointId 都
无济于事——授权集合外的端点一个都进不了 relay，也就不存在"经本
Server 的中继路径"。

补充边界（与 §0 R3 呼应）：Visitor 亲自作为 client 接入 relay 是合法的
（它本来就是 fabric 通信的参与者）；它无法做的是**为 A(S) 之外的端点
提供任何经本 Server 的可达性**。这正是需求要的边界，不多不少。

### 8.4 rendezvous 授权（R1 P0-5 修复：按 HTTP 面能力分别设计）

HTTP 面没有 iroh 握手身份，E1 不可用。按操作的信息敏感度分级：

- **announce（登记）**：现有 EndpointId 签名验证保留（rendezvous.rs:99-119）
  ——签名私钥本身就是 PoP。叠加 capability 校验（Bearer），并**绑定校验：
  capability.recipient MUST == announce 载荷中签名的 EndpointId**（签名的
  key 即签名者身份，零成本绑定，窃取 token 者无对应私钥无法 announce
  任意身份）。caps 要求 RDZ_ANNOUNCE。
- **resolve（解析）**：**bearer-only**——capability 泄露即可用（TTL 内）。
  明示降级理由：resolve 只暴露"仍在 TTL 内的登记地址"（本来就被限制为
  登记者主动公布的地址），且 restricted 模式已要求 capability（比现状
  完全匿名严格）。不做 HTTP challenge/PoP（复杂度与收益不成比例，
  future-work 可评估）。caps 要求 RDZ_RESOLVE。
- open 模式：announce/resolve 维持现状（签名 announce / 匿名 resolve）。

### 8.5 可插拔策略层：PolicyProvider 与动态 callback hook（Owner 2026-09-17 裁决；R3 修订）

**动机**（Owner 原文）：私有化部署的 Server「只服务于自家的业务，而不是
被别人拿去滥用」，且这个使用门槛要**动态可配置**——「围绕这套密钥系统
去实现动态的授权：通过自定义 hook/callback 来实现动态能力」。

**架构**：L2 决策点抽象为 provider trait：

```
trait PolicyProvider: Send + Sync {
    async fn decide(&self, ctx: AuthContext) -> Access;
}
AuthContext { endpoint_id（握手认证身份）,
              capability: Option<VerifiedCap>（已过 L1+L1b 的有效票投影，
                含 fabric_id/issuer/caps/issued_at/expires_at） }

内置两个 provider：
  StaticRegistryProvider（policy = "static"，默认）
    · 无票必拒（dweb/no-capability）；有效票放行
    · 票有效性判定（registry/caps）在 L1b 恒定层，见 §8.2
  CallbackProvider（policy = "callback"）
    · webhook 动态准入：实时授予/吊销/限流由业务侧实现，Server 免重启
```

**两条不可逾越的边界（R3 P0-B1 修复）**：

1. **callback 只能收紧，不能放宽**：出示票据的接入必须先过 L1+L1b
   （密码学完整性 + registry 二元组 + 所需 caps 位）。缺 RELAY 位的票、
   未注册 owner 的票在到达 webhook 前已被拒——webhook 永远收不到
   "无效票"的决策请求，也无法升级它们。
2. **无票准入是独立语义**：capability == None 的端点交 webhook 裁决，
   由此产生的可达集合记作 **A_cb(S) = { e | webhook 曾对 e 返回
   allow 且在缓存有效期内 }**，与 A(S)（§0）**并列定义、互不混淆**：
   A(S) 是"注册 Owner 票据体系"的授权边界（static 模式的唯一边界）；
   A_cb(S) 是 admin 经 webhook 自担的动态名单边界（callback 模式的
   附加边界）。§0 的"集合外零可达"在 callback 模式下相应读作
   "A(S) ∪ A_cb(S) 之外零可达"。admin 对 A_cb(S) 的成员选择负全责
   （审计与配额边界见下）。若 webhook 对无票端点一律返回 deny，
   A_cb(S) = ∅，行为与 static 完全一致。

**CallbackProvider webhook 协议**（Server → admin 回调端点；
**本 change 事件范围仅 relay 面**——R3 P0-B2 修复：rendezvous 是独立
HTTP 路由（rendezvous.rs:124-201），announce 身份 = 请求体签名者、
resolve 无请求方身份，与 relay 的握手身份不同构，其动态策略留独立
change；本 change rendezvous 维持静态 ACL（L1+L1b+caps 位））：

```
POST {callback_url}
Authorization: Bearer {callback_token}
Content-Type: application/json；请求体 ≤4KiB；响应体 ≤4KiB
事件：event = "relay.connect" | "relay.disconnect"
请求体（relay.connect）：
{
  "event": "relay.connect",
  "endpoint_id": "<z-base-32>",
  "capability": null | { "fabric_id": "<hex>", "issuer": "<z-base-32>",
    "caps": ["relay"], "issued_at_ms": 0, "expires_at_ms": 0 },
  "connection_id": "<opaque>"
}
响应（HTTP 200，JSON）：
  { "allow": true, "cache_ttl_s": 30 }          # cache_ttl_s 可选
  { "allow": false, "reason": "dweb/<slug>" }   # 语法冻结见下
```

**协议卫生（R3 P1-B3..B7 修复，全部为协议约束而非实现细节）**：

- **fail-closed 恒定不可配置**：非 200 / 超时（默认 2000ms，硬上限
  2000ms）/ 响应解析失败 / 缺 `allow` 字段 / `allow` 非布尔 / body
  超限 → DENY `dweb/policy-unavailable`（deny 结果同样入缓存）。
- **并发防护**：per-key singleflight（同键并发 miss 只发一次回调）；
  全局并发上限（默认 64）+ 每来源在途上限（默认 16）+ 有界等待队列
  （默认 256，队满即 DENY `dweb/policy-unavailable`）——防回调风暴
  耗尽 relay executor（client_rx 限流在连接注册后的数据面，保护不到
  此处）。
- **缓存冻结**：键 = (registry_generation, endpoint_id,
  BLAKE3(capability canonical 投影), event)；registry 变更（文件重载/
  unregister）即 generation+1 并清空全部缓存（撤销即时生效窗口 =
  0）；TTL = min(响应 cache_ttl_s, callback_cache_ttl_ms 配置，上限
  60s)；cache_ttl_s 非法值（负数/浮点/超 60）按 0 处理（不缓存）。
  缓存仅作用于**新连接准入**，不作为存量连接撤销机制（§13）。
- **传输与 SSRF 边界**：生产强制 `https://`（`--allow-loopback-callback`
  显式豁免本机 loopback 供开发）；解析后地址拒绝私网（RFC1918/ULA）、
  link-local、云 metadata 网段（豁免开关同上）；**不跟随重定向**
  （3xx 一律按失联处理，防 token 跨 origin 泄露）；callback_token
  仅从配置/secret 读取，日志与 tracing 全程脱敏。
- **reason 语法冻结**：`dweb/[a-z0-9][a-z0-9._-]{0,63}`（ASCII slug，
  拒绝控制字符/非 ASCII/超长/空）；非法值一律替换为
  `dweb/policy-denied`（防日志注入与 deny 帧污染）。
- **relay.disconnect 为 best-effort 观察通知**：fire-and-forget、
  不阻塞、不重试、允许丢失（进程重启即丢）；**不可作为配额或撤销
  依据**（配额依赖它则必须由业务侧自建可重放/幂等的事件通道——
  非 Server 承诺）；其 callback 亦受同一并发/超时上限约束，超限
  直接丢弃。

**webhook 属 admin 信任域**：callback_token 泄露 = 策略面泄露（不
影响密码学层）；挂载点在 restricted 模式内（open 模式无 L2 调用）。
callback 配置（url/token）缺失或非法时启动 fail-fast。

---

## 9. Visitor 反向滥用攻击路径分析（R1 复核后修订）

```
A1 匿名扫描者（只知道 IP:port）
    └► 裸连 relay / GET rendezvous ──► on_connect deny / 401 ✅
A2 窃取 capability 串（无对应私钥）
    ├► relay 面出示 ──► recipient ≠ 握手认证 id ──► deny ✅
    └► rendezvous announce ──► 签名 key ≠ recipient ──> 401 ✅
       （E1 与 announce 签名双重绑定；resolve 面 bearer-only，见 A2'）
A2' 窃取 capability 串用于 resolve（已明示的降级面）
    └► 可枚举 TTL 内登记地址，TTL 后失效 ⚠(明示接受：信息敏感度低+已比
       现状匿名枚举严格)
A3 Visitor 给 A(S) 之外的 peers 当 relay（核心攻击）
    └► peers 必须各自通过 on_connect（F6 投递模型）──► 无票 deny ✅（§8.3）
A3' 同 Owner 名下两个 Visitor 经 relay 互连
    └► 允许（§0 R3 裁决：fabric 全连通模型的路径投影，非滥用）☑语义裁决
A4 把 capability 转卖给其它 endpoint
    └► 同 A2：recipient 绑定 ✅
A5 泄露的 invite 串
    ├► 抢兑成员资格 —— 既有威胁（单次兑换 + recipient 预绑定缓解）非新增
    └► bootstrap capability 连 relay —— **InviteV2 的 recipient 恒必填**
       （R1 P0-4 修复 + R2 表述统一：V2 与 server 模式无关一律必填）：
       capability.recipient == invite.recipient，泄露串对其它
       EndpointId 无用 ✅（V1 令牌维持现状 recipient 可选——V1 无内嵌
       capability，不存在 bootstrap 票；open server 的无门槛是模式属性
       而非令牌属性）
A6 恶意 Owner 刷资源（注册 fabric 后滥发票）
    └► registry 移除即时阻断新连接；Limits（client_rx）兜底；per-owner
       配额 Phase 3 ⚠(已缓解)
A7 capability 重放（同票重连）
    └► 幂等合法（重连必须允许）；server_id 绑定挡跨 Server 重放 ✅
A8 撤销后的 Visitor 继续用 relay 直到 TTL 尽
    └► 已知窗口：registry 移除 Owner = 新连接即时拒绝（存量连接见 §13）；
       visitor 级即时吊销（server 在线黑名单）为 Non-goal，future work
       ⚠(明示接受，TTL 是撤销传播上界)
A9 篡改 registry / 伪造 admin 操作
    └► registry 为本地持久化文件（admin 信任域）；注册回执 server.key
       签名供审计（Phase 3）✅
A10 QAD（iroh-relay ServerConfig.quic）旁路
    └› 实为地址发现服务（§2.4，R1 P1 正名），无 AccessControl。本 change
        spec 冻结：restricted 模式 MUST fail-fast 拒绝启用 QAD bind——
        理由是未授权地址探测/隐私泄漏面，而非转发旁路 ✅
A11 callback webhook 面（policy=callback 时新增；R3 修订）
    ├► 攻击者直连 webhook 端点伪造响应 ──► Bearer callback_token +
    │   admin 信任域 + SSRF 边界（私网/metadata 网段拒绝、不跟随
    │   重定向、HTTPS 强制）✅
    ├► webhook 不可达/超时拖垮接入 ──► fail-closed
    │   （dweb/policy-unavailable）+ 超时硬上限 2s + 缓存 ✅
    ├► 回调风暴（并发 miss 洪泛）──► per-key singleflight + 全局/来源
    │   并发上限 + 有界队列（队满即拒）✅
    ├► 低权限票被 webhook"升级"（缺 RELAY 位/未注册 owner）──►
    │   L1b 底线不可绕过：无效票到达 webhook 前已拒 ✅
    ├► 恶意/被入侵 webhook 放行任意无票端点 ──▶ admin 信任域内风险，
    │   明示为 A_cb(S) 独立边界（§0 R4/§8.5）：密码学层不受影响；
    │   被放行者仅限"真实持有自己身份私钥的端点"且受
    │   registry_generation 缓存失效与配额约束 ⚠(admin 责任，与
    │   registry 文件同级)
    ├► 撤销后缓存残留放行 ──► registry generation 入缓存键（registry
    │   变更清缓存）；A_cb(S) 名单撤销的残留窗口 = cache_ttl ≤60s，
    │   明示接受 ✅
    └► response 注入恶意 reason/日志注入 ──► reason 语法冻结
        （dweb/[a-z0-9][a-z0-9._-]{0,63}，非法替换
        dweb/policy-denied）✅
```

---

## 10. 与现有 Roster / Invite / Session Gating 的关系

```
┌────────────────────────── Server 信任域 ──────────────────────────┐
│  owner registry + capability 验证   [Q1: 谁可用基础设施]（新增）    │
└───────────────────────────────────────────────────────────────────┘
            ▲ capability 由 root 签发（复用同一 keypair/编码风格）
            │ 无 roster 知识泄漏到 Server
┌────────────────────────── 端侧 fabric 域（不动）───────────────────┐
│  roster 投影 + invite 兑换 + 双侧 Session 门控  [Q2/Q3]            │
│  ※ 触点三处：invite v2 wire（附录 A，唯一权威）；REDEEM_OK2 新帧    │
│    （§12）；RelayConfig per-relay token                              │
└───────────────────────────────────────────────────────────────────┘
```

- **复用而非重建**：capability 的签名/验证/PoP/时间窗语义沿用 fabric
  protocol 既有模式（域分隔 canonical 编码、Ed25519、recipient==TLS peer
  同 session.rs:611-612 的兑换检查、时间语义同 protocol.rs:770-774）；
  Ed25519 Identity 零改动。
- **invite wire 所有权（R1 P1 修复）**：invite-token-multi-relay 处于
  "仅登记、未排期、未实现"状态且其 v2 只规划 relay URL 列表。为消除
  双 change 争抢 wire 的归档顺序风险，**本 change 附录 A 是 InviteV2
  布局的唯一权威**（relay 列表 + 每条 capability 一并冻结）；multi-relay
  change 的 v2 定义引用附录 A，其自身聚焦 join 拨号候选合并语义与错误
  探针。两个 change 的实现可以独立推进，wire 只冻结一次。
- **Session Gating 零改动**：roster.is_member 判定不感知路径/capability；
  直连成功的 Visitor↔Owner 通信仍由 Q2/Q3 守护（relay ACL 只管传输设施
  入口——spec §10 原"仅限制 relay 使用"定位被精确保持）。
- **continuity 零改动**：RESUME/POLICY_DENIED 语义不变；relay 断开重连
  时新 transport 连接重新过 on_connect。

---

## 11. 数据结构 / 持久化配置

### 11.1 capability 令牌（`dwebr1.` + base64url-nopad）

```
RelayCapV1（canonical，域分隔 b"dweb/relay-cap/v1\0"）
┌──────────────┬─────┬─────────────────────────────────────────┐
│ field        │ len │ 语义                                    │
├──────────────┼─────┼─────────────────────────────────────────┤
│ version      │ 1   │ 0x01                                    │
│ fabric_id    │ 32  │ 归属 fabric（与 issuer 二元组查 registry）│
│ server_id    │ 32  │ 绑定 ServerId（防跨 Server 重放）       │
│ issuer       │ 32  │ root EndpointId（须 ∈ registry）       │
│ recipient    │ 32  │ 使用者 EndpointId（== 握手认证 id）     │
│ caps         │ 1   │ CapsV1 位图                             │
│ issued_at    │ 8   │ ms（容 CLOCK_SKEW 120s 未来偏移）       │
│ expires_at   │ 8   │ ms（now >= expires_at 即拒；无滑窗）    │
│ signature    │ 64  │ issuer Ed25519 over canonical bytes     │
└──────────────┴─────┴─────────────────────────────────────────┘
wire = 字段 146B + 签名 64B = 210B（签名输入 = 18B 域前缀
"dweb/relay-cap/v1\0" + 146B 字段，域前缀不进 wire）；base64url-nopad
280 字符 + "dwebr1." 前缀 = 287 字符（R2 P2 修正，以实现期编码
测试冻结为准）
TTL：验证侧统一上限 **180d**（不做类别判定）；签发侧建议 member
capability ≤ 90d、bootstrap ≤ invite expires（§7.3）
```

### 11.2 Server 数据目录与配置

```
<data_dir>/
  server.key            # 0600，32B seed，tmp+fsync+rename 原子写（同构 FileSecretStore）
  owners.jsonl          # append-only：{"op":"register","fabric_id":..,"root":..,
                        #  "registered_at":..,"receipt_sig":..} / {"op":"unregister",...}

配置优先级（沿既有 flag > env > config.toml > default）：
  CLI:   --access-mode <open|restricted>   --data-dir <path>
         --owners-file <path>              （dweb-server 新增，风格同 --gateway）
  env:   DWEB_ACCESS_MODE / DWEB_DATA_DIR / DWEB_OWNERS_FILE
  config: [server.access]
           mode = "open" | "restricted"
           policy = "static" | "callback"          # L2 provider 选择，默认 static
           owners_file = "…"                        # 票据有效性底线（L1b）数据源
           callback_url = "https://…"               # callback policy 必填（见 SSRF 边界）
           callback_token = "…"                     # Bearer（server→hook 鉴权）
           callback_timeout_ms = 2000               # 硬上限 2000
           callback_cache_ttl_ms = 30000            # 上限 60000
           callback_max_concurrency = 64            # 全局在途上限
           callback_per_source = 16                 # 每来源在途上限
           callback_queue = 256                     # 有界等待队列（队满即拒）
           allow_loopback_callback = false          # loopback webhook 豁免（开发）
           limits.client_rx = …                     # 透传 iroh-relay
registry 载入：启动读全量 jsonl 归并活跃集合（只读快照 Arc 供验证链）；
  Phase 1 支持文件重载（SIGHUP/mtime），Phase 3 admin API。
Limits（R1 P1 修正）：仅接线 iroh-relay 1.1.0 **已实现**的
  `client_rx` 字节率限流；连接数限额（accept_conn_limit/burst）
  上游标注未实现（server.rs:485-500），不承诺；如需连接上限在
  on_connect 自建计数（Phase 3 钩子）。
```

### 11.3 Fabric/SDK 侧

```
Rust:  RelayConfig::Custom(Vec<String>)              # 旧，保留
   +   RelayConfig::CustomWithCaps(Vec<RelayEntry>)  # 新
        RelayEntry { url: String, capability: Option<String> }
       → 构造 RelayMap 时 url+token 成对注入（iroh RelayMap 条目级 token）
napi:  RelayOptions { mode, urls?: string[] }        # 旧，保留
   +   RelayOptions { mode, relays?: { url, token? }[] }   # 新可选字段
invite v2：见附录 A（唯一 wire 权威）
REDEEM_OK2：见 §12（新帧类型，不触碰旧 payload 语义）
```

---

## 12. 协议握手是否需要修改（R1 P0-3 修复）

```
层                     变更                                            幅度
──────────────────────────────────────────────────────────────────────────
iroh relay 握手        无（auth_token 通道 + deny reason 均原生）          零
fabric regular ALPN    无                                                零
fabric redeem ALPN     新增 REDEEM_OK2 帧类型（0x15）：                    小
                       payload = fact dump（与旧 REDEEM_OK 同构）
                       + u32 长度前缀段 [(url, capability)]（可空）。
                       版本信号：REDEEM_INTENT 中的 invite 串为 dweb2.
                       （v2）时 issuer 才回 REDEEM_OK2；dweb1. 一律回
                       旧 REDEEM_OK——旧客户端永不收到扩展帧，新客户端
                       按帧类型分派。旧客户端收到未知帧的既有 fail-closed
                       归约不触发（它根本收不到 OK2）。
invite 令牌 wire       v2（附录 A：多 relay 列表 + 每条 capability；
                       restricted relay 下 recipient 强制）            一次
continuity ALPN        无                                                零
SDK 配置面             RelayOptions 可选新字段                          小
```

要点：**无需在 relay 之前增加任何 OpenDWeb handshake**——iroh-relay 握手
已完成身份 PoP（E1），授权凭证走其 token 通道。这是对需求 §B 的直接
回答：**不需要额外 handshake**。旧客户端解析 v2 invite 报
`unsupported-invite-version`（明确升级指引）。

---

## 13. 安全边界与 Threat Model

```
信任锚
  Server Admin: server.key + registry（全权于 Server 信任域；无法解密会话）
  Fabric root:  对其名下 capability 的签发权（被 registry 边界约束）
  EndpointId:   E1 等式（iroh-relay 握手 PoP，不可伪造）——仅 relay 面；
                rendezvous 面的绑定手段见 §8.4

授权边界（§0 形式化）
  通信端点（经 relay）恒 ⊆ A(S)；A(S) 外端点零可达性

明确不设防/接受项
  - Admin 可 DoS 自己的 Server（自伤，接受）
  - resolve bearer-only（A2'）：信息敏感度低 + 已比现状（完全匿名）严格
  - A3' 同 Owner 成员互连：§0 R3 语义裁决（fabric 全连通投影，非滥用）
  - A8 visitor 级撤销窗口 = TTL（Non-goal，明示）
  - registry 移除 Owner 的存量连接：on_connect 只拦新连接，存量连接
    保持至自然断开/重连（R1 P1 诚实化：Phase 1 语义为"新连接即时拒绝
    + 存量靠 TTL/重连收敛"；主动断连钩子 Phase 3 评估——iroh-relay
    Server 有 Clients 表，工程上可及，但非本 change 承诺）
  - 直连流量不经 Server，relay ACL 不适用（由 Q2/Q3 端侧门控守护）

资源保护（DoS 面）
  - on_connect 验证成本：长度门/字符集白名单先行（防解析 DoS，遵循
    密码学参数防 DoS 规则）→ 1 次 Ed25519 验签 + 只读快照查表（O(1)）
  - capability 不含 KDF/AEAD 参数，无参数协商面
  - client_rx 限流全程生效（与 access mode 正交）
  - 谨慎重试策略：deny 不重试（客户端收到结构化 reason 即终止 relay 路径）

密钥泄露分级
  - capability 串泄露  → relay 面/announce 不可用（recipient 绑定）；
                         resolve 可用（bearer-only，A2' 已明示）    低危
  - root 私钥泄露      → 该 fabric 名下 capability 可伪造（admin 移除
                         registry 记录即时阻断新连接）              中危
  - server.key 泄露    → admin token 伪造面（Phase 3 前无运行时消费）低危
```

---

## 14. Migration / Backward Compatibility（R1 P1 修正措辞）

```
阶段 0（现状）         open 模式 = AllowAll（默认值）
阶段 1（server 升级）  未配置 ACCESS_MODE → open，relay/rendezvous 行为
                       与现状一致；services.json 新增 server_id 字段——
                       兼容性语义为「行为兼容 + 字段只增」（沿既有
                       "字段只增不删"约束），不是字节级兼容；
                       packages/server-binary 的字段断言测试同步更新
阶段 2（Owner 启用 restricted）
                       - admin 注册 owner + --access-mode restricted
                       - 新 invite v2 / 新 SDK 携带 capability
                       - 老 SDK（无 token）连 restricted relay：收到
                         deny reason（iroh-relay 回传），SDK 显示
                         "server requires capability"——可预期失败
                       - 老 SDK 解析 v2 invite：unsupported-invite-version
阶段 3（渐进收紧）     open↔restricted 可随时切换（capability 链路独立存在）
```

- 默认 open 保证存量部署升级零行为变化；restricted 是显式 opt-in。
- restricted + 空 registry = 拒绝一切 relay 接入（fail-closed，文档明示）。
- wire 兼容性由"帧类型隔离 + invite 版本字段"承担；**不做双协议胶水**
  （Style 原则：新旧行为物理隔离，不写运行时探测分支）。

---

## 15. 推荐方案及理由（含 R1 复核后的修正路线）

**推荐：方案 A（Owner-signed capability + owner registry），分三阶段；
语义边界采用 §0 的形式化定义。**

理由：

1. **架构必然性**：鸡蛋问题（§5.2）证明 Server 授权凭证必须独立于
   fabric 语义存在；F6 证明 relay 投递以在线 client 为界——per-connection
   检查 + A(S) 语义精确覆盖需求的真实边界（授权集合外零可达）。
   R1/R2 复核指出的"配对授权缺口"，经 §0.1 升格为产品语义裁决：
   共享接入语义（iroh-relay 原生能力边界）vs 严格配对语义（需 fork
   relay）——本设计采用前者并保留 future-work 扩展位（peer_scope）。
2. **复用最大化**：iroh-relay 的 ACL hook、token 通道、deny 回传与
   iroh 客户端 token 注入全部现成（F2/F3/F4）；fabric 侧只动 invite
   wire（附录 A）与新增 REDEEM_OK2 帧。核心新建面集中在 dweb-server。
3. **三问独立被结构化保证**：Q1 在 Server（registry+capability），
   Q2/Q3 在端侧零改动——比把授权塞进 roster/session 的任何方案都更
   符合需求的分层原则，也符合 spec 既有"relay 仅限制 relay 使用"裁决。
4. **安全语义闭合**：A1、A2、A3、A4、A5、A7、A9、A10 全闭；A2'（resolve
   bearer-only）与 A3'（成员互连）是明示的语义裁决而非缺口；A6/A8 以
   TTL+registry+Limits 缓解并如实标注窗口。
5. **Owner/Visitor 零新概念成本**：不引入 role 字段；Visitor=持票者，
   Owner=registry 内 root；能力裁剪靠 caps 位签发策略表达。

阶段划分（与 tasks.md 对应）：

```
Phase 1（Server 独立可测）  server.key / owners.jsonl / --access-mode /
                            client_rx Limits / on_connect 验证链 /
                            rendezvous ACL（announce 绑定 + resolve bearer）/
                            QAD fail-fast / services.json server_id
Phase 2（fabric 流通）      invite v2（附录 A 冻结）+ REDEEM_OK2 /
                            root 自签 / RelayConfig 与 SDK per-relay token /
                            fabric+sdk spec delta 补全
Phase 3（运营面）           admin API / registry 热加载与回执 / 存量断连
                            钩子 / per-owner 配额 / peer_scope 扩展评估
```

---

## 附录 A：InviteV2 wire 布局（唯一权威，multi-relay change 复用）

```
InviteV2（串前缀 "dweb2."；canonical 域分隔升级 b"dweb/invite/v2\0"）
┌────────────────┬──────┬──────────────────────────────────────────┐
│ field          │ len  │ 语义                                     │
├────────────────┼──────┼──────────────────────────────────────────┤
│ version        │ 1    │ 0x02                                     │
│ fabric_id      │ 32   │ 同 v1                                    │
│ invite_id      │ 16   │ 同 v1（单次兑换）                        │
│ issuer         │ 32   │ root EndpointId                          │
│ expires_at     │ 8    │ ms                                       │
│ recipient      │ 32   │ ★ 变更：v2 恒必填（与 server 模式无关，  │
│                │      │   编解码层强制；V1 维持现状可选）        │
│ relay_count    │ 1    │ 0..=8                                    │
│ relays[]       │ 变长 │ 每条：u16 url_len + url(UTF-8) +         │
│                │      │   RelayCapV1 串（dwebr1.…，见 §11.1；    │
│                │      │   capability.expires_at ≤ invite         │
│                │      │   expires_at；recipient == invite        │
│                │      │   recipient）                            │
│ addr_count     │ 1    │ 0..=4                                    │
│ direct_addrs[] │ 变长 │ SocketAddr 编码（吸收 multi-relay 的     │
│                │      │   direct_addrs 需求）                    │
│ signature      │ 64   │ issuer over canonical bytes              │
└────────────────┴──────┴──────────────────────────────────────────┘
解码兼容：dweb2. 串对旧客户端报 unsupported-invite-version；
dweb1. 令牌不受影响（新旧并存，物理隔离）。
落地顺序：本 change 附录 A 冻结布局；invite-token-multi-relay 引用之并
聚焦 join 候选合并语义；两者实现独立、归档顺序解耦。
```

## 附录 A2：REDEEM_OK2 帧 wire 冻结（R2 P1-N2 修复）

```
帧：type = 0x15（REDEEM_OK2），仅当 REDEEM_INTENT 中的令牌为 dweb2. 时
    issuer 才允许回发；dweb1. 一律回既有 REDEEM_OK(0x13)。
payload 布局（全部整数大端 BE）：
  ┌──────────────────┬──────┬─────────────────────────────────────┐
  │ fact dump        │ 变长 │ 与 REDEEM_OK 完全同构（u32 count +  │
  │                  │      │ SignedFact frames）                 │
  │ cap_item_count   │ u32  │ 0..=8                               │
  │ cap_items[]      │ 变长 │ 每项：u16 url_len + url(UTF-8，     │
  │                  │      │ ≤512B) + u16 cap_len + cap（dwebr1. │
  │                  │      │ 串，≤512B）                          │
  └──────────────────┴──────┴─────────────────────────────────────┘
约束：
  - 兑换通道既有总上限沿用（payload ≤32KiB、5s 时限、单流）；
  - cap_item_count 越界 / 单项长度越界 / url 非 http(s) → 整帧视为
    无效回执：joiner 侧报 JoinError::Other（不降级、不部分采纳）；
  - 重复 url 以首条为准（后到丢弃并计数）；
  - cap 串格式非法（非 dwebr1. 前缀）：该条跳过并计数（名册回执
    语义不受影响——capability 是可选增强，不是兑换成立的条件）；
  - cap.recipient != redeemer EndpointId：该条跳过并计数（防御性，
    正常签发链不会出现）。
错误码（冻结为稳定枚举，SDK 透出）：
  JoinError 新增第九码 UnsupportedInviteVersion（dweb2. 令牌交给
  仅支持 v1 的旧客户端时返回；fabric.rs join 八码映射表同步扩展）。
兼容矩阵：
  ┌──────────────┬──────────────┬─────────────────────────────┐
  │ joiner\issuer│ v1 issuer    │ v2 issuer                   │
  ├──────────────┼──────────────┼──────────────┼──────────────┤
  │ v1 joiner    │ OK(0x13)     │ UnsupportedInviteVersion（  │
  │              │              │ 旧客户端无法解析 dweb2.）    │
  │ v2 joiner    │ OK(0x13)     │ OK2(0x15)                  │
  └──────────────┴──────────────┴─────────────────────────────┘
```



| 编号 | 问题（Codex R1, 5.5/10） | 处置 | 落点 |
|---|---|---|---|
| P0-1 | 配对级授权推理不成立 | 语义精确化（§0 A(S)/R1-R3 裁决）+ 配对方案显式否决 | §0、§5.2、§8.3 |
| P0-2 | Visitor 默认能力违反边界 | 签发最小化（默认仅 RELAY；RDZ 显式勾选）+ RELAY 位语义澄清 | §7.2 |
| P0-3 | REDEEM_OK 追加段破坏旧解析器 | REDEEM_OK2 新帧（0x15）+ invite v2 版本信号 | §2.2、§12 |
| P0-4 | bootstrap 无法同时满足接入与绑定 | invite v2 强制 recipient 预绑定 | §7.3、§9 A5、附录 A |
| P0-5 | resolve 无法复用 E1 验证链 | announce 签名 key 绑定 + resolve bearer-only 明示降级 | §8.4、§9 A2' |
| P0-6 | F6 EndpointGone/丢包表述错误 | F6 重写（静默丢包/sent_to 语义/holepunch 归属 iroh） | §1.1 F6、F7 |
| P1 ×7 | fabric 二元组/时间语义/unregister/Limits/QAD/兼容措辞/wire 所有权/flag | 全部采纳（详见各节 R1 标注） | §8.2、§13、§11.2、§2.4、§14、§10、附录 A |
| P2 ×2 | 引用精度/长度计算 | F3/F4 行号修正、caps 大小重算（当时数字有误，R2 表再次修正） | §1.1、§11.1 |

### R2 复核后：Owner 裁决与需求扩展（2026-09-17）

- **语义裁决**：共享接入语义获 Owner 确认（§0.1 定稿）——R1/R2 复核的
  P0-1/P0-2/P0-N2 悬置项全部闭合。
- **需求扩展（Owner 新输入）**：使用门槛须**动态可配置**，围绕密钥系统
  经**自定义 hook/callback** 实现动态授权 → 新增 §8.5 可插拔策略层
  （PolicyProvider：static registry / callback webhook），§8.2 验证链
  重构为 L1（密码学，本地强制）+ L2（准入，可插拔）两段式，§9 新增
  A11 webhook 攻击路径，§11.2 配置面扩展，spec 新增 callback
  requirement。static policy 下行为与 R2 版完全一致（向后一致）。

| 编号 | 问题 | 处置 | 落点 |
|---|---|---|---|
| P0-1/P0-2（R2 复审未闭合） | 共享接入语义是产品放宽，需 Owner 裁决 | 升格为 §0.1 产品语义裁决记录（共享语义 vs 严格配对 fork 的取舍显式化，Owner 确认后作为需求基线） | §0.1 |
| P0-N1 | A(S) 与 open 模式矛盾 | A(S)/R1-R3 显式限定 restricted；open 模式另行定义 | §0 |
| P0-N2 | capability 未绑定 membership/Owner 上下文 | 归入 §0.1 裁决（共享语义下授权单位=capability 本身；membership 无法在 Server 侧验证——Server 无 roster，且 root 本就是 fabric 完全权威）；可审计性经 registry+TTL+配额约束 | §0.1、§13 |
| P1-N1 | "恒属于 A(S)"与撤销宽限期矛盾 | A(S) 改为接入时刻快照语义 | §0 |
| P1-N2 | OK2 wire 未冻结/缺稳定错误码 | 附录 A2：完整布局+约束+错误码+兼容矩阵 | 附录 A2 |
| P1-N3 | deny reason 场景合并/缺边界场景 | spec delta 拆独立 scenario + 补 resolve 缺位/优先级/未来时间场景 | specs/server |
| P0-3 遗留 | OK2 端序/framing/上限未冻结 | 附录 A2 冻结 | 附录 A2 |
| P0-4 遗留 | recipient 必填的 V1/V2 例外表述冲突 | 统一：V2 恒必填（与模式无关）、V1 维持现状 | §7.3、§9 A5、附录 A |
| P2 遗留 | 长度 242B/331 字符错误；F6 引用错位 | 修正 210B/287 字符 + 域前缀 18B 说明；F6 引用精确化 | §11.1、F6 |

（R2 复核表之后见上节"Owner 裁决与需求扩展"。）

### R3 复核（6.1/10）问题 → 处置对照

| 编号 | 问题 | 处置 | 落点 |
|---|---|---|---|
| P0-B1 | callback 可绕过 capability 最小权限/A(S) | registry+caps 提升为 **L1b 票有效性底线**（不可插拔，webhook 无法升级低权限票/未注册票）；无票准入显式化为 **A_cb(S)** 独立边界（admin 自担，static 下为空） | §8.2、§8.5、§0 R4 |
| P0-B2 | rendezvous callback 身份上下文不成立 | callback 事件范围收窄为 relay.connect/disconnect；rendezvous 维持静态 ACL，动态化留独立 change | §8.5 |
| P1-A1 | "唯一注册路径"绝对化 | 限定为 stock 装配边界（Server::spawn→authorize_with→register），集成断言不绕路 | §8.2 末段 |
| P1-B3 | 超时+缓存不足以防并发风暴 | singleflight + 全局/来源并发上限 + 有界队列（队满即拒） | §8.5、spec |
| P1-B4 | 缓存 TOCTOU/陈旧窗口/无 schema | 键冻结（registry_generation + BLAKE3 canonical）、cache_ttl_s 有界整数（非法=0 不缓存）、registry 变更清缓存 | §8.5、spec |
| P1-B5 | SSRF/重定向/token 暴露未冻结 | HTTPS 强制+loopback 豁免开关、私网/metadata 网段拒绝、不跟随重定向、body ≤4KiB、token 脱敏 | §8.5、spec |
| P1-B6 | reason 仅前缀检查 | 语法冻结 `dweb/[a-z0-9][a-z0-9._-]{0,63}`，非法替换 policy-denied | §8.5、spec |
| P1-B7 | disconnect 一致性边界不足 | 明示 best-effort 观察通知，不可作配额/撤销依据 | §8.5、spec |
| C | spec 负例矩阵不足 | 重写 callback requirement：11 scenario（无效票不触发 webhook/registry 清缓存/并发风暴/SSRF/非法 reason 等） | spec |
| 遗漏5 | spec.md:7 A(S) 缺 restricted 限定 | 措辞修正（restricted 下 A(S)∪A_cb(S)；open 不设边界） | spec |
