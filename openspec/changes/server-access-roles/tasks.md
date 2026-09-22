# Tasks: server-access-roles

## 1. 文档基线

- [x] requirements.md（Owner 裁决 [R1]-[R8] 逐字存档）
- [x] proposal.md
- [x] PRODUCT-DESIGN.md（PM 子代理产出，IA/成品文案/开放问题）
- [x] design.md（技术设计：内核/管理面/webui/SDK + 测试策略）
- [x] spec deltas（server 三 MODIFIED + 三 ADDED；webui 五 ADDED；cli identity 一 ADDED）
- [ ] Codex 设计评审迭代至 GO（评分 0-10 + 逐项处置）

## 2. Phase 1a —— 内核：名册与门（crates/dweb-server/src/access/）

- [ ] registry：owners 条目增 `expires_at/alias/note`（serde(default)，旧条目=永久无别名）+ `contains_active(f,root,now)`；快照携带元数据
- [ ] visitor registry（visitors.jsonl，同构存储模式）+ gate 无票路径裁决次序接线（blocklist endpoint → visitor → callback → 拒+敲门）
- [ ] blocklist（blocklist.jsonl）+ 双维挂点（endpoint 先于 C0；fabric 于 L1 后 L1b 前）+ `dweb/blocked`
- [ ] L1b 过期拒绝 `dweb/owner-expired`（gate.rs:311 contains→contains_active）
- [ ] KnockLog（内存聚合台账 4096 LRU + relay/rendezvous Deny 臂挂点 + blocked 排除 + dismiss）
- [ ] 访客在线配额 `DWEB_RELAY_MAX_CONNECTIONS_PER_VISITOR`（默认 4，`dweb/visitor-quota-exceeded`）+ 在线投影访客条目（保留 fabric、不入 per-owner）
- [ ] 绿门：`mbx test -p dweb-server`（gate/registry 单测矩阵全量）+ clippy `-D warnings` + rustfmt --edition 2024（仅变更文件）

## 3. Phase 1b —— 邀请码与公开注册面

- [ ] codes.jsonl 台账（blake3 哈希/used/expires/revoked，serde(default)）+ 码生成 `dwebc1.`+base32×16
- [ ] `POST /register` 公开端点：per-IP 令牌桶（10/min 突发 5）→ 形状 → ts±120s → 码校验（invalid/exhausted/expired）→ PoP 验签（域 `dweb/register/v1\0`，验签键=body.root）→ register 事件（续期语义）→ 回执域 `dweb/register-receipt/v1\0`
- [ ] rendezvous per-IP 限流（resolve 60/min、announce 20/min，429 envelope；令牌桶组件与 /register 共用）
- [ ] 绿门：兑换矩阵 e2e（正常/错 sig/重放/耗尽/过期/吊销/限流/续期/回执验签）+ 旧格式 codes/owners 条目兼容

## 4. Phase 1c —— 三角色管理面 API

- [ ] knocks（GET 列表排序契约 + dismiss 幂等回执）、visitors CRUD + from-knock、codes 三路（签发响应含全文仅一次）、renew、blocklist CRUD、status 增量四字段
- [ ] 回执 op 枚举扩充 0x04-0x0B（103B canonical 未用维度置零；code 类 target=code_hash）+ fixture 向量增量
- [ ] 绿门：admin e2e 全链路（敲门→定位访客→重连放行；签发→兑换→名册出现带别名/到期；到期 deny reason；黑名单同票拒）+ 既有 sdk-mgmt-surface e2e 零回归

## 5. Phase 2a —— webui 三角色重设计（packages/webui/ui）

- [ ] IA 重构：总览四问+待办条 / 租户管理（名册+到期+续期+邀请码页）/ 访客与门禁（敲门台+访客名册+黑名单）/ 在线连接；旧 hash 收敛
- [ ] 敲门台四动作（定位访客/导入租户引导/拉黑确认/忽略+撤销 toast）——PM §4 文案逐字
- [ ] key 显示规范落地（`别名 (abc***xyz)` 首3***尾3，取代前 8 位；复制全文）
- [ ] 邀请码管理页（签发一次全文视图/列表哈希缩写/吊销确认）
- [ ] 绿门：node --test（copy/缩写/路由收敛/错误态矩阵扩展）+ vision 子代理视觉走查

## 6. Phase 2b —— 节点簿

- [ ] sidecar nodes.json（0600）+ 配对面可重复添加 + switch 仅已存 node_id + 进程内原子切换 + 删除（当前节点 409）
- [ ] state/列表响应零 token 披露；Host/Origin 守卫延续
- [ ] UI：右上角节点切换菜单（一次一个当前节点，过渡态）
- [ ] 绿门：sidecar 单测（0600/切换拒绝新 URL/掩码/409）+ e2e 切换后代理面指向新节点

## 7. Phase 3 —— SDK/文档

- [ ] `opendweb id`（只读；endpoint_id/缩写/路径；无私钥输出）+ README「一台设备一个默认 key」段落
- [ ] 绿门：packages/opendweb node --test（checkjs + id 命令）

## 8. 验收

- [ ] 云端 demo 原地升级走查：敲门→webui 定位→重连即通；邀请码自助注册→名册出现；到期/黑名单生效；节点切换
- [ ] 全量回归（dweb-server + client-sdk + webui + opendweb 四包测试面零改动全绿）+ openspec strict 校验
- [ ] 最终 Codex 验收（评分 0-10 + RELEASE-READY 判定）
