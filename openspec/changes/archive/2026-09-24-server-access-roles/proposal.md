# Proposal: server-access-roles

> 原始需求输入（2026-09-22，Owner）：三角色心智模型——包租婆/租户/访客
> （裁决逐字存档见 requirements.md，[R1]-[R8]）。本 change 把模型落进
> 内核协议、admin API 与 webui，全量一次做。

## Why

**server-access-policy 建立了"包租婆+租户"两层，但"访客"层缺失，管理面不完整。**

现状（已冻结的 C0→L1→L1b→L2 验证链）：所有 relay 准入都要链到某个注册
fabric 的有效票（root 自签 own cap / 成员经 OK2 附发 member cap）。这意味着：

1. **"访客"概念不存在**：一个只想连上来"敲门"的陌生端点，没有任何合法
   准入路径——第一次连接就被 `dweb/no-capability` 拒掉，包租婆既不知道
   有人来过（deny 无任何记录），也没有任何手段说"让这个设备进楼"。
   Owner 裁决 [R3]：管理员要在 webui 上**看到敲门请求**，当场定位成
   访客或租户——这要求敲门可观测 + 角色授予可操作。
2. **公钥即地址的语义落不了地** [R1]：持有 pubkey 理论上就该能敲门，
   现在还必须有票。relay 握手本身已密码学认证端点身份（E1 链）——
   **设备 key 就是身份**，访客准入可以（也应该）做成无票的 pubkey 名册。
3. **租户生命周期不完整** [R4][R5]：注册无过期（一旦注册永久有效）、
   无自助注册通道（每个租户都要包租婆手工导入二元组）——Owner 明示
   "这些配置都是目前 opendweb 管理内核需要补充的。因为非常常用"。
4. **识别性差** [R6]：名册里只有裸 hex，无法标注"这是谁的设备"；
   alias 有钓鱼风险，需要区块链钱包式缩写防误判。
5. **多节点管理缺入口** [R7]：Owner 需要管多台，但裁定"一次专注一台、
   右上角切换"，不做同屏多节点。

## What Changes

### 内核（dweb-server）

- **访客名册（visitor registry）**：无票准入——`<data_dir>/visitors.jsonl`
  （endpoint_id + alias + 备注 + 授予时间，serde(default) 兼容演进）；
  gate 的 C0 无票路径在 L2 前查表放行（受限前提：访客面默认开启与否
  与 callback 的关系在设计期冻结）。**访客可达面 = relay 通行**；
  rendezvous 无票 resolve/announce 维持 401（HTTP 面无调用方身份证明，
  签名 resolve 变体 = Phase 2，见 requirements「范围修订记录」）。
- **敲门日志（KnockLog）**：**仅 relay deny 臂**记录（E1 握手认证
  身份；rendezvous 匿名面身份不可信，不入台账——防伪造污染），
  endpoint_id/reason/时间聚合，内存台账 + 有界容量（照 OnlineTable
  模式），admin API 可读——[R3] 的"看到访客请求"数据面。
- **租户过期**：owners.jsonl 条目扩展 `expires_at`（serde(default)：
  旧条目=永久）；L1b `contains_active(fabric, root, now)`，新 deny slug
  `dweb/owner-expired`；注册默认 +30d [R5]（admin 可改/续期/永久）。
- **租户邀请码** [R4]：`<data_dir>/codes.jsonl`（码哈希/max_uses/
  used_count/expires_at/alias 提示）；公开 HTTP 兑换端点
  `POST /register {code, fabric_id, root}`（码门控 + 基础限流 +
  server.key 新域回执）；默认 1 次/7 天，可自定义。
- **黑名单（blocklist）** [R8]：endpoint/fabric 维度拒绝名单，gate 早于
  票判定，slug `dweb/blocked`——包租婆名单制的拒绝半边（放行半边=
  访客名册）。
- **rendezvous 基础限流**：HTTP 面当前零限流（探查实证），兑换端点与
  resolve 补 per-source 有界频控。

### admin API

- `GET /admin/knocks`（敲门台）+ 处置动作（忽略/标记已处理）
- `GET/POST/DELETE /admin/visitors`（访客名册 CRUD + alias）——支持
  **从敲门记录一键定位访客** [R3]
- `POST/GET/DELETE /admin/codes`（邀请码签发/列表/吊销）+ 兑换端点计数
- `POST /admin/owners/{...}/renew`（租户续期/改期/设永久）+ 名册列表
  增量字段（alias/expires_at/剩余时长）
- `GET/POST/DELETE /admin/blocklist`

### webui（三角色重设计，Svelte+shadcn 基座上叠）

- **三角色 IA**：总览 / 租户管理（名册+alias+到期+续期）/ 访客管理
  （敲门台 + 访客名册 + 黑名单）/ 邀请码 / 在线连接——包租婆视角重组织
- **敲门台流** [R3]：敲门列表（谁/何时/为何被拒）→ 一键「定位为访客」/
  「导入为租户」/「加入黑名单」/「忽略」
- **alias + 缩写** [R6]：全站 key 显示统一 `别名 (abc***xyz)` + 复制全文
- **节点簿** [R7]：右上角节点信息处切换；本地保存多个节点配置
  （`~/.opendweb/nodes.json` 0600，sidecar 侧管理，token 不落浏览器——
  对 webui-console「token 不落文件/目标冻结」两条基座契约的**版本化例外**
  ，见 specs/webui 节点簿 requirement）；切换 = **进程内原子切换**（不
  重启，仅允许切到已存节点——无新目标注入通道，目标冻结安全模型保持）

### SDK/文档

- 默认设备 key 产品化文档 [R2]（SecretStore 既有能力 + `opendweb` 侧
  显示本机 key/缩写/导出指引）；多密钥对（设备指纹切换）明示为高级
  功能不在本轮

## 非 Goals（明确不做）

- fabric wire 变更（房门三制的"租户侧门"= fabric 级访客政策——探查实证
  新 FactKind 会让旧节点 HELLO dump 整体解码失败，Phase 2 单独设计评审；
  **该延期经 Owner 批准的实施计划放行，裁决链见 requirements.md「范围
  修订记录」**；本轮"租户名单制"由既有 roster 成员门控承担，
  `完全放行制`的房门侧同样 Phase 2）
- 同屏多节点管理、节点远程部署/启停
- SDK 多密钥对/设备指纹切换
- 访客票/能力令牌形态（无票名册已覆盖；若未来需要离线票再议）

## 依赖与基线

- 叠在 sdk-mgmt-surface/webui-console 之上（admin API 既有面、Svelte
  UI 基座、错误 envelope、回执体系全部复用）
- server-access-policy 冻结的验证链语义不回退：访客名册是 **C0 无票
  路径的新分支**，不触碰 L1/L1b 对有票路径的既有判定
