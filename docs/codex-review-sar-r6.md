# server-access-roles 设计定稿轮 r6 delta 复审

## 1. 结论与评分

**评分：8.0/10（相对 r5 的 7.6/10，上升 0.4）。判定：NEEDS-WORK。**

r6 已闭合两项重要安全合同：`POST /register` 的权威校验序现在把 PoP 验签置于
幂等回放之前，且回放不刷新租期；台账加载/归并失败也已经冻结为整服务 fail-fast。
KnockLog 的 design、WebUI 与 PM 主体文字，以及访客空态均已按 seq/relay-only 方向
收敛。三项 OpenSpec strict 校验全部通过。

设计层仍不能 GO，原因是实现入口尚未完全唯一化：design 的管理列表路由仍写“最近在前”，
任务矩阵仍保留 `码校验 → PoP` 的旧顺序，design 的幂等键仍写原始 `code` 而非规范的
`code_hash`，且测试矩阵的“重复注册=续期”未限定为持新有效码。它们会让实现子代理重新
引入时序、规范化和一次性码续期歧义；均为实现前应修订的 P1，而非运行时代码 P0。

## 2. 验证证据

### 命令

| 命令 | 结果 |
|---|---|
| `git rev-parse HEAD` | `cacb78c787f98f2c3442eeaed323a207204233fd` |
| `git diff --stat 6882e6c..cacb78c` | 6 个文件，165 insertions，18 deletions（本轮仍无实现代码） |
| `git diff --check 6882e6c..cacb78c` | 通过 |
| `openspec validate server-access-roles --strict` | `Change 'server-access-roles' is valid` |
| `openspec validate sdk-mgmt-surface --strict` | `Change 'sdk-mgmt-surface' is valid` |
| `openspec validate webui-console --strict` | `Change 'webui-console' is valid` |

### 全文残留复扫

- `specs/server/spec.md:195` 与 `design.md:107-109` 均明确 `ts → PoP → 幂等命中`，
  回放路径同样验签；未发现“回放跳过验签”的旧句。
- `specs/server/spec.md:198`、`design.md:144-147`、`tasks.md:32` 均为单一的整服务
  fail-fast；未发现“拒绝启动或拒绝该台账功能面”的残句。
- `PRODUCT-DESIGN.md:357` 已改为“进楼连接（relay 通行）”；PM/CLI/服务器验收中未再发现
  “进楼找人”或无票 resolve 命中承诺。`requirements.md` 的 Owner 原始讨论仍出现“找人”，
  属不可改产品输入，不是实现合同。
- `design.md:70-79`、`specs/server/spec.md:159,188-189,305`、`specs/webui/spec.md:24`
  的权威排序已指向 seq；但 `design.md:187` 仍写“未处置优先/最近在前”，构成未限定的
  排序残留。
- 仍需修订的幂等合同残留：`design.md:119` 使用 `(code, fabric_id, root)`，而
  `specs/server/spec.md:197` 冻结的是 `(code_hash, fabric_id, root)`；`design.md:259`
  写“重复注册=续期”未限定持新码；`tasks.md:29` 仍写 `码校验 → PoP 验签`，与终态
  `specs/server/spec.md:195` 相反。

### 基座源码锚点回看

本轮没有 runtime diff；r5 已核对的事实仍适用：`gate.rs:285-286` 为 C0 无票路径、
`:310-313` 为 L1b `contains`；`registry.rs:35-50,115-121,144-192,206-229,260-270`
覆盖行格式、generation、load/fsync/reload；`relay.rs:46-48,130-143` 覆盖 open gate
装配与 Deny 臂；`rendezvous.rs:305-325` 为 bearer-only resolve；`admin.rs:466` 为
receipt canonical；`sidecar.mjs:172-180,422-455,363-365` 与 `target.mjs:30-106` 覆盖
setup、配对单飞、target freeze 与目标校验。r6 只改动设计/spec/任务文案，不改变这些源码事实。

## 3. r5 §6 GO 条件逐项验收

| GO 条件 | 状态 | 证据与判断 |
|---|---|---|
| 1. KnockLog 所有排序/逐出文字统一为 seq 主键 | **部分闭合** | `design.md:70-79`、server requirement 与 `specs/webui/spec.md:24` 已明确 seq desc、endpoint_id tie-break、last_at 仅展示；但 `design.md:187` 的“最近在前”仍未指明 seq，设计列表 API 仍存在双重解释。 |
| 2. 幂等优先级、回放/续期寿命、max_uses>1 与旧句唯一化 | **部分闭合** | 权威 `specs/server/spec.md:195-214,241-244`、`design.md:107-143`、PM/CLI 场景已固定 PoP 先行、同键回放不刷新、他键 exhausted、持新码续期；但 `design.md:119` 的 code/code_hash 不一致、`:259` 的未限定“重复注册=续期”和 `tasks.md:29` 的旧校验顺序仍可驱动错误实现。 |
| 3. reconciliation 首启 fail-fast、deny-set、retry/clear/restart 迁移 | **闭合** | `specs/server/spec.md:198,271-274`、`design.md:144-147` 与 `tasks.md:32-34` 已统一为加载失败整服务拒绝启动；补写 append 失败保留旧快照、受影响码 deny-set 503，成功移除，重启由归并重演。 |
| 4. PM resolve 与节点切换文案修正 | **闭合** | `PRODUCT-DESIGN.md:84,139,161,255,302,357,399` 与 CLI/Server 场景均已移除无票 resolve/访客找房及重启切换误导；访客文案明确 relay 通行，切换明确进程内即时生效。 |

**GO 条件统计：闭合 2/4，部分闭合 2/4，未闭合 0/4。**

## 4. 新问题清单

### P0（阻塞）

无。

### P1（须修）

#### P1-1：幂等合同在 design/tasks 仍可回退

证据：规范终态 `specs/server/spec.md:195` 是 `ts → PoP → 幂等命中 → 码状态`，
但 `tasks.md:29` 仍列 `ts → 码校验 → PoP`；`design.md:119` 将幂等键写成原始
`(code, fabric_id, root)`，而 pending/归并规范 `specs/server/spec.md:197` 要求
`(code_hash, fabric_id, root)`；`design.md:259` 仍是未限定的“重复注册=续期”。

修复建议：将 tasks 伪代码同步为终态顺序；全设计统一以规范化后的 `code_hash` 作为
幂等键；把测试项改为“持新有效码重复注册=续期”，并单列“同键旧码回放不刷新租期”。
保留 PoP 在回放之前的断言及 max_uses=2 K1→回放→K2 场景。

#### P1-2：design 管理列表仍使用未限定的 wall-clock 语义

证据：`design.md:187` 的 `GET /admin/knocks` 仍写“未处置优先/最近在前”，
而同一 design 的数据模型 `:70-79`、server requirement `specs/server/spec.md:159,305`
已经冻结 seq 为唯一排序键、endpoint_id 为同 seq tie-break、last_at 仅展示/不逐出。

修复建议：将该路由描述改为“未处置优先、组内 seq 降序、endpoint_id 升序；last_at
仅展示”，并让 grep 负向检查禁止未限定的“最近/最新在前”排序短语。

### P2（建议）

无新增 P2；r5 的回放 PoP 风险已由 `specs/server/spec.md:195` 闭合。

## 5. 设计层判定与实现期验收基线

当前判定仍为 **NEEDS-WORK**，因为四条 GO 条件中第 1、2 条尚未完全闭合。完成上述
两个 P1 后，可判定设计层 GO。进入实现时必须保持以下不可回退约束：

1. `/register` 固定顺序为直连 peer 限流、形状、ts 窗口、PoP 验签、三元组 durable
   幂等回放/pending 补写、码状态、新兑换；回放与普通注册同样验签且不刷新租期。
2. 幂等主键统一为规范化 `code_hash + fabric_id + root`；pending 同码他键 409，
   consume 与 owners register 双 fsync 后才成功响应，恢复按完整三元组补齐。
3. 续期只能持新有效码；旧码同键回放不得刷新 `expires_at`，max_uses=2 的 K1→回放→K2
   与并发双兑场景必须保持。
4. 台账加载/归并失败整服务 fail-fast；加载成功但补写失败使用进程内 deny-set + 503，
   成功补写清除，重启由 reconciliation 重演。
5. KnockLog 仅 relay E1 Deny 身份入账；排序/逐出只用 seq（endpoint_id 同 seq tie-break），
   last_at 仅展示；dismiss/undismiss/deny/逐出同锁，pending_count 恒为未 dismissed 数。
6. 节点簿仅允许已存 node_id 的 `/sidecar/nodes/switch` 运行时切换；token 仅 0600
   `nodes.json` 例外落盘，不出浏览器；原子 rename、拒 symlink、在途 target 快照和
   `/api/* → /admin/*` 业务路径契约不得回退。
