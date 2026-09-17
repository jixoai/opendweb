# Proposal: server-access-policy

> 原始需求输入（2026-09-17，Owner）：OpenDWeb Server Owner/Visitor 权限模型——
> Owner 可把自托管 Server 当作自己的 rendezvous/relay 基础设施并向 Visitor 开放
> P2P 入口；Visitor 可参与 Owner 创建的连接（含 relay 中转回退），但 MUST NOT
> 能主动把该 Server 当成自己的 relay/rendezvous 基础设施使用。IP:port、
> EndpointId、relay address、invite id 本身 MUST NOT 构成任何授权凭证。
> 本 change 第一阶段只做技术设计（design.md），实现任务另行排期。

## Why

**Server 当前零授权面。** dweb-server 是"iroh relay 嵌入 + HTTP gateway"的纯传输
设施（crates/dweb-server/src/main.rs:8-10）：relay 配置为 `AllowAll` 无限流
（relay.rs:25 未触碰 `RelayConfig.access`/`limits`），rendezvous resolve 完全匿名
（rendezvous.rs:186-201），无 identity、无持久化 secret、无配置文件、无 admin API，
重启即清空。任何知道公网 IP:port 的第三方都能把 Owner 的 Server 当作免费
relay/打洞基础设施使用——资源被白嫖、滥用流量归因到 Owner 的服务器。

**而授权所需的密码学底座其实已经齐了。**

- iroh-relay 协议在 WS 握手阶段就完成客户端 EndpointId 的**密码学认证**
  （challenge 签名，iroh-relay protos/handshake.rs:209-221），并以
  `AccessControl::on_connect(ClientRequest)` 暴露认证结果 + `Authorization:
  Bearer`/`?token=` 凭证通道 + 拒绝原因回传（iroh-relay server.rs:185-334）——
  dweb-server 只是没接线。
- 客户端侧 per-relay token 传递机制 iroh 已内置（`RelayMap` 条目级 token，
  iroh endpoint.rs:1925-1965；native Bearer header / wasm query 自动注入）。
- fabric 侧 root 签名事实（Fact + Ed25519）、invite 令牌 recipient 预绑定、
  challenge-response PoP、single redemption CAS 已冻结（fabric/roster spec）。

**缺的只是把它们接起来的一层 Server 访问策略**：Server 身份、Owner 注册表、
capability 令牌、relay/rendezvous 的授权执行点。且必须以"三个独立授权问题"的
分层方式接入（谁可用本 Server / 谁属于某 Fabric / 某 Session 是否成立），
而不是发明一套 role=owner|visitor 的账号系统。

## What Changes

0. **需求语义精确化（design §0）**：把"Visitor 不能主动把 Server 当自己的
   基础设施"形式化为授权接入集合 A(S) 边界——经 relay 通信的端点恒 ⊆ A(S)
   （注册 Owner 签发、未过期、recipient 绑定的 capability 持有者）；同
   Owner 名下成员互连是 fabric 全连通模型的路径投影，属"参与授权 Owner
   名下的连接"而非滥用。更强的配对语义（per-pair 状态）显式否决
   （需要重写 relay 转发层且与 fabric 语义冲突），保留 future-work 扩展位。
1. **Server Identity**：dweb-server 启动时生成/加载持久化 Ed25519 keypair
   （`<data_dir>/server.key`，0600），ServerId = 公钥。职责收窄为：服务自标识
   （services.json 发布）、管理面凭证（admin token 签发）、Owner 注册回执签名。
   **不签 relay capability、不参与 fabric 语义**。
2. **Server Access Policy（配置面）**：新增 `--access-mode`/`DWEB_ACCESS_MODE`
   （默认 `open` 保持现状行为兼容；`restricted` 启用授权）与 owner registry
   持久化文件；接线 iroh-relay 1.1.0 **已实现**的 `client_rx` 限流（连接数
   限额上游未实现，不承诺）；restricted 模式对 relay QUIC bind（QAD 地址
   发现服务，无访问控制）fail-fast 拒绝启动。
3. **Owner Registration**：Server Admin 将 `(FabricId, root EndpointId)` 注册进
   owner registry（多 Owner 天然支持）。Owner 是"Server 基础设施的使用授权者"，
   与 Server Admin（机器管理者）是两个不同身份，绝不混同。移除语义 =
   新连接即时拒绝（存量连接靠 TTL/重连收敛）。
4. **Relay Capability 令牌（`dwebr1.`）**：fabric root 签名的 ScopedEd25519
   capability——`fabric_id | server_id | issuer(root) | recipient EndpointId |
   caps 位图 | issued_at | expires_at`，域分隔 `dweb/relay-cap/v1`。经 iroh relay
   既有 auth_token 通道（Bearer/query）传递。签发最小化：Visitor 附发默认
   仅 RELAY 位，RDZ_* 由 Owner 显式勾选。
5. **Relay 授权执行点**：实现 `AccessControl::on_connect` 十步验证链
   （格式/长度门 → caps 保留位 → 验签 → **(fabric_id, issuer) 二元组** 查
   registry → server_id → 时间校验（含时钟偏移容忍与 TTL 上限）→
   recipient == 握手认证 EndpointId → caps 含 relay），任一失败即 deny
   （结构化 `dweb/*` reason 回传客户端）。
6. **Rendezvous ACL**：`restricted` 模式下 announce 要求 capability 且
   **recipient == announce 签名 EndpointId**（既有签名即 PoP，零成本绑定）；
   resolve 要求 capability 但为 **bearer-only**（明示降级：无 HTTP 面身份
   证明，信息敏感度低且已严于现状匿名枚举）。
7. **Fabric/SDK 侧 capability 流通**：
   - invite 令牌 v2（**附录 A 唯一 wire 权威**，invite-token-multi-relay
     复用之）内嵌 bootstrap relay capability；**restricted 场景 recipient
     强制预绑定**（joiner 兑换前拨号必需，同时闭合令牌转借窗口）；
   - **REDEEM_OK2 新帧**（0x15，v2 令牌版本信号触发）：回执附发 member
     capability（长 TTL，绑定 redeemer）——不复用旧 REDEEM_OK 追加段
     （旧解析器严格拒绝尾随字节，追加即破坏兼容）；
   - root 本地自签自己的 capability；
   - `RelayConfig`/SDK `RelayOptions` 扩展 per-relay token（URL 字符串旧形态
     保持兼容；双字段冲突显式报错）。

Owner/Visitor **不是**新的全局身份角色：Owner=在 owner registry 中的 fabric
root；Visitor=持某 Owner 签发 capability 的 EndpointId。两者都只是 Server
capability 的两种投影，fabric 身份模型零改动。

## Impact

- **包/代码**：`crates/dweb-server`（identity、access 模块、relay AccessControl
  接线、rendezvous ACL、配置面）；`crates/dweb-fabric`（invite v2 内嵌
  capability、REDEEM_OK 附发、root 自签、RelayConfig per-relay token）；
  `@jixo/opendweb-client-sdk`（RelayOptions napi 类型扩展）；`packages/opendweb`
  （config.toml `[server.access]` 段）。
- **规格**：`server`（MODIFIED "relay 桥接" + ADDED access/identity/rendezvous/
  limits requirements，每 deny reason 独立 Scenario）；`fabric/roster`
  （MODIFIED "邀请令牌"——InviteV2）；`fabric/session`（MODIFIED "兑换通道"
  ——REDEEM_OK2、"relay 快照"——v2 多 relay 候选）；`sdk/node`（ADDED
  RelayOptions per-relay capability）。fabric/sdk delta 已随本 change 产出。
- **协同 change**：`invite-token-multi-relay`——本 change design 附录 A 是
  InviteV2 布局的**唯一 wire 权威**（relay 列表 + 每条 capability 一并
  冻结）；multi-relay 引用附录 A 并聚焦 join 候选合并语义，两者实现独立、
  归档顺序解耦。
- **不依赖**：`app-protocol-layer`（continuity 层不感知路径与 relay 授权，
  POLICY_DENIED 码语义不受影响）。

## Non-goals

- 不做账号体系/RBAC/角色字段；Owner/Visitor 不进入 fabric 身份模型。
- 不让 Server 理解 fabric 协议（roster/session gating 仍在端侧，Server 对
  relay 流量保持不透明——"relay MUST NOT 能解密端到端会话内容"约束不变）。
- 不做 Visitor 级即时吊销（Server 在线黑名单）：撤销窗口 = capability TTL +
  registry 级移除；即时吊销列为 future work。
- 不启用 relay QUIC 数据面（现状即未启用；其无 AccessControl 的旁路问题
  因此不存在，spec 显式冻结该约束）。
- 不做 Server 侧 per-owner 配额/计费（Phase 3 可选，本次仅在 design 留钩子）。
