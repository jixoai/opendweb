# Tasks: server-access-roles

## 1. 文档基线

- [x] requirements.md（Owner 裁决 [R1]-[R8] 逐字存档 + 范围修订记录：fabric wire Phase 2 延期的裁决链）
- [x] proposal.md / PRODUCT-DESIGN.md（PM IA/成品文案/开放问题；节点切换文案=进程内即时切换）
- [x] design.md（技术设计：内核/管理面/webui/SDK + 测试策略 + r1 处置记录）
- [x] spec deltas（server 三 MODIFIED + 三 ADDED；webui 五 ADDED；cli identity+join 二 ADDED）
- [x] Codex r1 设计评审（5.0/10，22 条全处置，docs/codex-review-sar-r1.md）
- [ ] Codex r2 复审迭代至 GO（评分 0-10 + 逐项核对处置忠实度）

## 2. Phase 1a —— 内核：名册与门（crates/dweb-server/src/access/）

- [ ] registry：owners 条目增 `expires_at/alias/note`（serde(default)，旧条目=永久无别名）+ `contains_active(f,root,now)`；快照携带元数据
- [ ] 共享 ledger 基座（r1-P1-5）：owners/visitors/codes/blocklist 四台账统一矩阵——startup 坏行 fail-fast、reload 失败保留旧快照、每台账独立 generation、mtime 指纹、admin API+文件两入口（CLI 不新增，spec 明示）、旧行兼容；逐台账坏行/重载/并发写测试
- [ ] visitor registry（visitors.jsonl）+ gate 无票路径裁决次序接线（blocklist endpoint → visitor → callback → 拒+敲门）；**访客 Allow 不进 webhook**
- [ ] blocklist（blocklist.jsonl）+ 双维挂点（endpoint 先于 C0；fabric 于 L1 后 L1b 前）+ `dweb/blocked`
- [ ] L1b 过期拒绝 `dweb/owner-expired`（gate.rs:311 contains→contains_active）
- [ ] KnockLog（r1-P0-1 收窄）：**仅 relay Deny 臂**（E1 认证身份；rendezvous 匿名面不入台账）；聚合 {seq/count/…}、4096 上限 (last_at,seq) 逐出、blocked 排除、count 饱和递增、dismiss/undismiss 幂等 + 新 deny 复位 dismissed
- [ ] 访客两级配额（r1-P1-4）：per-endpoint 4（`DWEB_RELAY_MAX_CONNECTIONS_PER_VISITOR`）+ 全局 64（`DWEB_RELAY_MAX_VISITOR_CONNECTIONS`），`dweb/visitor-quota-exceeded`
- [ ] 在线投影（r1-P1-7）：在线表键 `(endpoint, Option<fabric>)`（无 sentinel）；`per_endpoint` 仅租户对 + 新增 `per_visitor` 数组 + status `visitors_online`
- [ ] callback 缓存复合 generation（r1-P1-6）：owners+visitors 世代组合入缓存键；revoke-after-cached-allow 回归测试
- [ ] 绿门：`mbx test -p dweb-server`（gate/registry/KnockLog 单测矩阵全量）+ clippy `-D warnings` + rustfmt --edition 2024（仅变更文件）

## 3. Phase 1b —— 邀请码与公开注册面

- [ ] codes.jsonl 台账（issue/revoke/**consume** 三事件，serde(default)；used_count=consume 计数归并推导）
- [ ] 码生成：OS CSPRNG `dwebc1.`+base32×16；哈希输入=码本体小写规范化（剥前缀/连字符）；日志/指标/错误零码全文（r1-P1-3）
- [ ] `POST /register` 公开端点：直连 TCP peer 限流（10/min 突发 5，**XFF 不采信**——r1-P1-2）→ 形状 → ts±120s → 码校验 → PoP 验签（域含 root）；**兑换判定+consume 追加同临界区按 code_hash 串行、fsync 成功前零响应**（r1-P0-2）→ register 事件（续期语义）→ 回执域 `dweb/register-receipt/v1\0`
- [ ] rendezvous per-IP 限流（resolve 60/min、announce 20/min，429 envelope；直连 peer；令牌桶组件与 /register 共用）
- [ ] 绿门：兑换矩阵 e2e（正常/错 sig/重放/耗尽/过期/吊销/限流/XFF 伪造/续期/回执验签/**并发双兑恰一成功**）+ 旧格式 codes/owners 条目兼容

## 4. Phase 1c —— 三角色管理面 API

- [ ] knocks（GET 排序契约：未处置前/last_at desc/seq desc/endpoint_id asc + dismiss/**undismiss**）、visitors CRUD + from-knock、codes 三路（签发响应含全文仅一次）、renew、blocklist CRUD、status 增量四字段
- [ ] 回执 op 枚举 0x04-0x0C（103B canonical 未用维度置零；code 类 target=code_hash；**generation=所属台账 generation**——r1-P1-12 按 spec 槽位映射表逐项实现）
- [ ] 输入上限与边界（r1-P2-3）：alias≤32/note≤256/alias_hint≤32/max_uses≤1000/expires_in_days≥1/checked 运算/now>=expires_at 等值=过期
- [ ] client-sdk 同步（r1-P1-8）：`./admin` op 映射 0x04-0x0C + Receipt 类型 union + canonical builder；receipt-vector.json 增补新 op 向量（Rust 生成断言 + TS 只读对拍，`DWEB_REGEN_FIXTURES=1` 门）
- [ ] 绿门：admin e2e 全链路（敲门→定位访客→重连放行；签发→兑换→名册出现带别名/到期；到期 deny reason；黑名单同票拒；undismiss/复位）+ 既有 sdk-mgmt-surface e2e 零回归

## 5. Phase 2a —— webui 三角色重设计（packages/webui/ui）

- [ ] IA 重构：总览四问+待办条 / 租户管理（名册+到期+续期+邀请码页）/ 访客与门禁（敲门台+访客名册+黑名单）/ 在线连接；hash 冻结 `#/overview|#/tenants|#/visitors|#/online` + 旧路由收敛映射（#/owners→#/tenants、#/access→#/visitors，r1-P1-9）；业务面沿用 `/api/*`→`/admin/*`
- [ ] 敲门台四动作（定位访客/导入租户引导/拉黑确认/忽略+撤销 toast→undismiss）——PM §4 文案逐字
- [ ] key 显示规范落地（`别名 (abc***xyz)` 首3***尾3，取代前 8 位；复制全文）；租户身份=二元组呈现 + 同 fabric 多 root 钓鱼警示（r1-P1-1）
- [ ] 邀请码管理页（签发一次全文视图/列表哈希缩写/吊销确认）
- [ ] 绿门：node --test（copy/缩写/路由收敛/错误态矩阵扩展——新增五 requirement 各自有 UI/API/错误态测试，不以旧测试全绿代替新面覆盖）+ vision 子代理视觉走查

## 6. Phase 2b —— 节点簿

- [ ] sidecar `~/.opendweb/nodes.json`（0600；临时文件+原子 rename、拒 symlink 跟随——版本化例外条款落地）+ 配对面可重复添加 + switch 仅已存 node_id + 进程内原子切换（在途请求按请求开始时 target 快照完成）+ 删除（当前节点 409）
- [ ] state/列表响应零 token 披露；Host/Origin 守卫延续；帮助文本 OS 可见性披露
- [ ] UI：右上角节点切换菜单（一次一个当前节点；行内过渡态「正在切换到…」，无重启文案）
- [ ] 绿门：sidecar 单测（0600/原子 rename/symlink 拒绝/切换拒绝新 URL/在途快照/409/token 零披露）+ e2e 切换后 `/api/status` 指向新节点

## 7. Phase 3 —— CLI/文档

- [ ] `opendweb id`（只读；endpoint_id/缩写/路径；无私钥输出）+ README「一台设备一个默认 key」段落
- [ ] `opendweb join --server --code`（R4 自助入口，r1-P1-11）：默认 key 为 root、无 fabric 生成/有则复用、canonical 签名兑换、回执保存、明文守卫、失败非零退出；含 register-receipt 客户端验签 helper
- [ ] 绿门：packages/opendweb node --test（checkjs + id/join 命令矩阵）

## 8. 验收

- [ ] 云端 demo 原地升级走查：敲门→webui 定位→重连即通；`opendweb join` 持码自助注册→名册出现；到期/黑名单生效；节点切换即时生效
- [ ] 全量回归（dweb-server + client-sdk + webui + opendweb 四包测试面零改动全绿；基线数字以当日实跑为准）+ openspec strict 校验
- [ ] 最终 Codex 验收（评分 0-10 + RELEASE-READY 判定）
