# Proposal: server-access-roles（包租婆/租户/访客三角色模型落地）

## Why

**现在的门禁只有「有票/无票」一档。** relay 会话层已能密码学认证端点
（公钥即身份），但 server 侧没有产品化的准入分层：陌生设备一律拒绝，
Owner 想临时放一个访客、或给协作者发一个限时租户身份，都只能手动改
票务事实。Owner 裁决引入三角色模型——**包租婆**（管理员，房子是她
的）、**租户**（持邀请码自助注册、限期通行）、**访客**（敲门请求、
管理员当场裁决）——把「谁可以进」从一次性配置变成可运营的产品面。

## What Changes

1. **访客准入 = 无票 pubkey 名册 + 敲门台**：陌生人连接被拒时在 server
   留下 KnockLog（照 OnlineTable 模式）；包租婆在 webui 敲门台看到请求，
   一键把敲门者定位成访客（visitor registry 挂 gate 无票路径查表）或租户。
   访客可 RESOLVE 找到门牌、不可 ANNOUNCE。
2. **租户邀请码**：包租婆签发（默认 1 次/7 天过期，times+deadline 可自
   定义），码哈希入 server 台账（codes.jsonl）；公开 HTTP 端点
   `POST /register` 码门控兑换 + 限流，成功回执 server.key 签名（新
   domain 前缀，**不签 relay capability**）。
3. **租户过期**：owners.jsonl 条目扩展 `expires_at`（serde(default)，
   旧条目=永久）；L1b `contains_active(fabric,root,now)` + deny slug
   `dweb/owner-expired`；默认今天+30 天，可配置。
4. **黑名单**：blocklist（endpoint/fabric 维度）挂 gate 早于一切票判定，
   deny slug `dweb/blocked`。
5. **rendezvous 访客面**：无票路径加 visitor 查表（访客可 RESOLVE、不可
   ANNOUNCE）；补 HTTP 基础限流（当前零限流）。
6. **webui 三角色 IA + 节点簿**：三角色视角重设计；alias + 防钓鱼缩写
   `别名 (abc***xyz)`（区块链钱包式）；右上角节点信息处切换节点，一次
   专注管一台，不做同屏多节点。
7. **SDK 小节**：默认设备 key 产品化（一台设备一个默认 key；多密钥对=
   高级功能=切换设备指纹，仅文档化，不在本 change 实现）。

**范围外（明确不做）**：fabric wire 变更（房门策略 FactKind 有旧节点
HELLO 整体解码失败的地雷，Phase 2 单独设计评审）；同屏多节点管理、节点
远程部署/启停；SDK 多密钥对实现。

Owner 裁决逐字存档见本 change 目录 `requirements.md`，为最高需求信源。

## Capabilities

### New Capabilities

（无——全部落在既有 capability 上）

### Modified Capabilities

- `server`: 访客名册/敲门记录/邀请码台账与兑换/租户过期/blocklist/
  rendezvous 访客面与限流的 server 侧行为
- `webui`: 三角色信息架构、敲门台、邀请码签发与管理、alias 缩写展示、
  节点簿切换
- `sdk`: 默认设备 key 的产品化承诺（一机一默认 key；多密钥对为高级功能
  边界）

## Impact

- **代码**：crates/dweb-fabric server 侧（gate/relay/rendezvous/owners
  台账）；packages/webui（三视角控制台扩展）；packages/client-sdk 文档面。
- **契约**：owners.jsonl 加可选字段（serde(default) 向后兼容）；新增
  codes.jsonl 与 KnockLog 内存结构；新增公开 HTTP 端点 `/register`
  （限流）；webui API 面扩展。不触碰 fabric wire 与 relay capability
  签名面。
- **依赖**：无新重型依赖（高熵随机码用既有 crypto 面）。
