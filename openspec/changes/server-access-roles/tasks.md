# Tasks: server-access-roles

> 规划期任务骨架（计划已批准）。PM 产品文档与 Codex 设计 GO 后细化
> 每阶段的实现任务与验收勾选。

## 1. 立项与设计

- [ ] 1.1 openspec change 脚手架 + requirements.md（裁决逐字存档）
- [ ] 1.2 PM 产品文档：三角色模型/敲门流/邀请码/到期/alias/节点切换的
      IA 与交互流成品文案（product-manager 子代理）并入 design
- [ ] 1.3 技术 design 展开：server（visitor registry/knocks/codes/
      expiry/blocklist/rendezvous 访客面）+ webui（三角色 IA+节点簿）+
      SDK 小节（默认设备 key 产品化）
- [ ] 1.4 spec deltas（server/webui/sdk 三面）strict 校验通过
- [ ] 1.5 Codex 设计评审（herdr 异步）处置到 GO

## 2. Phase 1 —— server 内核三角色

- [ ] 2.1 (1a) visitor registry + gate 无票路径查表 + KnockLog
      （OnlineTable 模式；relay Deny 臂 + rendezvous Deny 臂）
- [ ] 2.2 (1b) 邀请码：codes.jsonl 台账 + `POST /register` 兑换
      （码门控+限流+server.key 新 domain 回执）
- [ ] 2.3 (1b) 租户过期：owners.jsonl `expires_at`（serde(default)）+
      `contains_active(fabric,root,now)` + slug `dweb/owner-expired`
- [ ] 2.4 (1b) blocklist（endpoint/fabric 维度，gate 最前，slug
      `dweb/blocked`）
- [ ] 2.5 (1b) rendezvous 访客面（visitor 查表：可 RESOLVE 不可
      ANNOUNCE）+ HTTP 基础限流
- [ ] 2.6 (1c) admin API：敲门台/邀请码签发管理/名册与到期/blocklist
- [ ] 2.7 绿门：cargo test/clippy/fmt + node --test 零回归

## 3. Phase 2 —— webui 三角色 + 节点簿

- [ ] 3.1 (2a) 三角色 IA 重设计（含 PM 文案落地；alias + 防钓鱼缩写
      `别名 (abc***xyz)`）
- [ ] 3.2 (2b) 节点簿切换：右上角节点信息处切换，sidecar 重启指向新
      节点，凭证边界不变（token 不落浏览器）
- [ ] 3.3 绿门：webui 全测试面零回归 + e2e

## 4. 验收与收官

- [ ] 4.1 云端 demo 原地升级走查：敲门→webui 定位角色→访客敲门成功→
      租户邀请码自助注册→到期/黑名单生效（对照 requirements.md 验收标准）
- [ ] 4.2 小白路径零文档可完成自查 + 截图/录屏存档
- [ ] 4.3 最终 Codex 验收（评分 + 阻塞清单清零）
- [ ] 4.4 收官：archive → merge/push → herdr 回收 → Owner 报告

## 5. 范围外登记（不在本 change 实现）

- fabric wire 房门策略（Phase 2 专议：FactKind 复用 vs 版本化同步）
- SDK 多密钥对/设备指纹切换（仅文档化默认 key）
- 同屏多节点管理、节点远程部署/启停
