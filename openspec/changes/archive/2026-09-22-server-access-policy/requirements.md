# 原始需求输入（2026-09-17，Owner）

> 本文件是需求的原始快照（仅作复核与追溯依据；措辞中的"建议"均为待验证
> 的设计输入，最终裁决见 design.md）。
>
> **语义裁决注记（2026-09-17，Owner 已确认）**：原文"不能主动把 Server
> 当自己的基础设施使用"存在一处自然语言歧义——「同 Owner 名下端点
> （含多个 Visitor）之间经 relay 互连」是否属于禁止范围。技术事实：
> iroh-relay 的授权 hook 仅接入粒度，配对级限制需 fork iroh-relay。
> **Owner 裁决：采用共享接入语义**（同 Owner 名下互连允许），理由：
> 「我的目的只有一个：当别人私有化部署了 OpenDWeb，我希望它只服务于
> 自家的业务，而不是被别人拿去滥用作为中继服务器，所以我需要有一个
> 使用门槛。这个使用门槛是可以动态配置的。」
>
> **需求扩展（2026-09-17，Owner 新输入）**：使用门槛须动态可配置，
> 围绕现有密钥系统实现动态授权——通过自定义 hook/callback 实现动态
> 能力（design.md §8.5 PolicyProvider/CallbackProvider）。

## 1. 背景与目标

OpenDWeb Server 不仅承担 rendezvous / NAT traversal / relay 等基础设施能力，
还希望允许用户将一个 OpenDWeb Server 作为自己的网络基础设施。

两类使用者：

- **Owner**：将 Server 作为自己的 rendezvous/打洞服务器、relay/中继服务器、
  P2P connection 辅助基础设施；可通过 Server 创建面向 Visitor 的 P2P 入口。
- **Visitor**：使用入口连接 Owner、参与 NAT traversal/hole punching、P2P
  建立后双向通信、直连失败时使用 Server relay 中转；但**不能**主动把这个
  Server 当成自己的 relay/rendezvous 基础设施使用。

## 2. 关键安全场景

连接过程中 Visitor 自然获得 Server 的 IP:port / relay address / EndpointId /
connection metadata——这些信息本身**不能成为 Server 的授权凭证**。尤其不能
出现"Visitor 看到 relay address → 自己发起 relay 使用请求 → Server 把
Visitor 当成 Owner"。Server 必须区分"Visitor 正在参与 Owner 创建的连接"
（允许）与"Visitor 正在尝试主动使用 Server 的 relay 能力"（拒绝）。

## 3. 设计输入（建议性质）

- 研究 Server Identity / Management Key（持久化 keypair），区分 Server
  Admin/Management Identity 与 Fabric Owner Identity。
- 优先 capability/policy 模型而非 role=owner|visitor 的 RBAC；capability
  可表达 rendezvous/relay/connect/admin 等，未来可扩展 expires/
  maxConnections/scope（按实际架构判断复杂度）。
- 三层授权边界彼此独立：Server-level（endpoint 能否用本 Server 基础设施）、
  Fabric-level（能否加入某 Fabric——复用现有 Genesis/Grant/Join/Revoke/
  Roster）、Session-level（两端能否建立 Session——复用现有双侧 Session
  Gating）。
- 比较两种模型，不默认选择：Model A（Server Admin ACL）vs Model B
  （Owner-issued capability）。
- "IP:port 不代表权限"：IP:port/EndpointId/Relay address/Invite ID 均不得
  单独作为 Server capability；授权基于 cryptographic identity + proof of
  possession + server policy/capability，必要时结合 session/connection
  state/expiry。
- 与现有 Invite/Roster 系统的关系：不重新设计独立用户认证体系；研究
  Server-level authorization 能否直接复用现有 Ed25519 Identity 与 PoP；
  Owner/Visitor 是否应仅为 Server capability 而非全局身份新角色。
- 权限判断发生的层（Gateway/Rendezvous/Relay/Session/Identity/Policy）与
  协议层是否需要显式区分这些操作。
- 不要为 Owner/Visitor 简单加 role 字段；保持
  Identity → PoP → Capability/Policy → Endpoint → Session → Transport 的
  推导链；"谁有权使用 Server"、"谁有权访问某 Fabric/Owner"、"某 Session
  是否允许 relay" 三问独立。
- 最终目标：密码学身份驱动、可配置能力边界的 P2P 基础设施节点，而非
  传统账号权限系统。

## 4. 要求的调研问题

A. 当前架构中 Identity 位于哪里（Server identity？Client key？持久化
   secret？iroh EndpointId 与 OpenDWeb Identity 关系？）
B. Relay 层现在如何识别连接方？Server 在什么阶段可靠知道 Client 是谁？
   是否需要 relay 前置 handshake / 现有 Session handshake / Ed25519 PoP /
   额外 signed capability？
C. 如何区分"参与 Owner 的连接"与"主动使用 Relay"？判断发生在哪一层？

## 5. 第一阶段交付要求

不写代码，输出技术设计讨论（带图文解说），至少覆盖 15 点：现状代码路径与
架构分析；Identity/Session/Relay/Rendezvous 现状实现；已具备能力；缺失
能力；≥2 个可行架构方案；Server Identity/Management Key 职责；Owner/Visitor
权限模型建议；Relay 层识别与授权；Visitor 反向滥用攻击路径分析；与现有
Roster/Invite/Session Gating 关系；数据结构/持久化建议；协议握手是否修改；
安全边界与 threat model；migration/向后兼容；最终推荐方案及理由。
