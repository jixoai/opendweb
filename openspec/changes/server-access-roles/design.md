# Design: server-access-roles

> 状态：**种子稿**（立项冻结的技术决策 + 计划骨架）。PM 产品文档
> （三角色/敲门流/邀请码/到期/alias/节点切换的 IA 与交互流）与内核
> 探查补强后展开；Codex 设计评审（herdr 异步）处置到 GO 后才进入实现。

## 1. 冻结的技术决策（基于内核探查，计划已批准）

| 决策 | 方案 | 依据 |
|---|---|---|
| 访客准入形态 | **无票 pubkey 名册**（visitor registry），gate 在 C0 无票路径查表 | relay 握手已密码学认证端点（E1 链）——设备 key 即身份，访客零客户端配置；与裁决 1/2 对齐 |
| 敲门记录 | KnockLog（照 OnlineTable 模式：Mutex+view 投影），挂 relay.rs Deny 臂 + rendezvous Deny 臂 | 覆盖全部 deny 原因；tenant 侧 "not a member" 拒绝发生在租户机器，server 不感知（符合模式 2 语义） |
| 租户过期 | owners.jsonl 条目扩展 `expires_at`（**必须 serde(default)**，旧条目=永久），L1b `contains_active(fabric,root,now)` + 新 slug `dweb/owner-expired` | 探查确认：无 default 会硬错误起不来；挂点唯一（gate.rs:311） |
| 邀请码 | server 侧台账（codes.jsonl：码哈希/max_uses/used/expires/角色）+ 公开 HTTP 兑换端点 `POST /register`（码门控+限流+server.key 回执） | 自包含令牌过重；码即凭证，高熵随机 |
| 黑名单 | blocklist（endpoint/fabric 维度）挂 gate 早于一切票判定，slug `dweb/blocked` | 与 static/callback 互补 |
| rendezvous 访客面 | 无票路径加 visitor 查表：访客可 RESOLVE（找房门牌）、不可 ANNOUNCE；补 HTTP 基础限流（探查确认当前零限流） | 敲门需要能找到门 |
| fabric 房门策略 | **Phase 2 分期**：新 FactKind 有 wire 地雷（旧节点 HELLO dump 整体解码失败），Phase 1 不动 fabric wire，先做 server 三角色；房门策略设计期与 Codex 专议（复用现有 kind 编码 vs 版本化同步） | 探查发现的具体风险 |
| server.key 签名面 | 仅邀请码回执等新域（新 domain 前缀）；**不签 relay capability**（identity.rs 纪律注释维持） | 既有裁决 |

## 2. 角色语义（引用 requirements.md 裁决 1-8）

- **包租婆**：fabric 的 owner/管理员；签发邀请码、裁决敲门、管理 blocklist
  与租户到期。
- **租户**：持邀请码自助注册进入名册的设备；限期通行（默认今天+30 天）。
- **访客**：未注册但持 pubkey 敲门的设备；仅在包租婆当场裁决后获得
  RESOLVE 面（找房门牌），不可 ANNOUNCE。

房门三制（完全放行/租户名单/包租婆名单+混合）在 Phase 1 落在 server
gate 判定顺序上；fabric wire 层的房门策略 Phase 2 专议。

## 3. 分期与工作流（既有 remix 闭环）

1. **立项**：本 change + requirements.md（裁决逐字）+ proposal ✅
2. **PM 产品文档**：三角色模型/敲门流/邀请码/到期/alias/节点切换的 IA
   与交互流成品文案（product-manager 子代理）→ 并入本 design
3. **技术 design + spec deltas**：server（visitor registry/knocks/codes/
   expiry/blocklist/rendezvous 访客面）、webui（三角色 IA+节点簿）、
   SDK 小节（默认设备 key 产品化）
4. **Codex 评审闭环**（herdr 异步，gpt-5.6-terra xhigh；若该模型不可用
   回退大地三并在 tasks 记录）→ 处置迭代到 GO
5. **子代理实现**：Phase 1a 内核 registry/gate/knocks → 1b 邀请码/过期/
   blocklist/rendezvous → 1c admin API → 2a webui 三角色重设计 →
   2b 节点簿切换；每阶段绿门：cargo test/clippy/fmt + node --test + e2e
6. **验收**：云端 demo 原地升级走查（敲门→webui 定位角色→访客敲门成功→
   租户邀请码自助注册→到期/黑名单生效）+ 最终 Codex 验收

## 4. 风险与边界

- **fabric wire 地雷**：Phase 1 严禁 FactKind/HELLO dump 结构变更（探查
  实证旧节点整体解码失败）。
- **owners.jsonl 兼容**：`expires_at` 必须 `serde(default)`；升级路径上
  旧文件不迁移即兼容。
- **凭证边界**：token/admin 面不落浏览器（既有 W 系裁决延续）；`/register`
  是唯一新增公开端点，必须限流 + 码哈希存储（明文码不落盘）。
- **范围外**：见 proposal「范围外」；SDK 多密钥对只文档化。
