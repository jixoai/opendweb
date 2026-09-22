# server-access-roles 设计定稿轮 r7 终验

## 1. 结论与评分

**评分：8.4/10（相对 r6 的 8.0/10，上升 0.4）。判定：设计层 GO。**

r6 的两条残余 P1 已闭合：任务矩阵与 design 现在使用同一条 `/register` 终态校验序，
幂等键统一为规范化 `code_hash + fabric_id + root`，测试矩阵明确区分持新码续期和同键
旧码回放；管理列表路由也明确为 seq 主键排序。未发现新的设计矛盾或安全回退。

这是“可进入实现”的设计 GO，不是实现完成声明。实现子代理必须遵守第 4 节的六条原有
基线及三条跨轮增补，并以对应场景作为验收门槛。

## 2. 验证证据

### 命令

| 命令 | 结果 |
|---|---|
| `git rev-parse HEAD` | `d39aca55a1d435db84e8fe786873a52118f22626` |
| `git diff --stat cacb78c..d39aca5` | 3 个文件，121 insertions，4 deletions |
| `git diff --check cacb78c..d39aca5` | 通过 |
| `openspec validate server-access-roles --strict` | `Change 'server-access-roles' is valid` |
| `openspec validate sdk-mgmt-surface --strict` | `Change 'sdk-mgmt-surface' is valid` |
| `openspec validate webui-console --strict` | `Change 'webui-console' is valid` |

### r6 P1 验收

- `tasks.md:29`：`形状 → ts±120s → PoP 验签（回放路径同样先验签）→ 幂等命中
  （durable 回放/pending 补写，均不刷新租期）→ 码校验`。
- `design.md:119-124`：幂等键是规范化 `code_hash + fabric_id + root`，明确非码原文，
  回放不刷新租期且续期唯一入口为持新有效码。
- `design.md:188`：`GET /admin/knocks` 明确未处置优先、seq 降序、endpoint_id 升序，
  `last_at` 仅展示。
- `design.md:260`：测试矩阵明确“持新有效码重复注册=续期 / 同键旧码回放不刷新租期”。

### 全文负向 grep 终扫

在活动 change 文档（`openspec/changes/server-access-roles` 与
`openspec/changes/webui-console`，排除历史 review 报告和不可改的 requirements 原始讨论）
复扫以下残留模式，均无命中：

- 旧校验序（`码校验 → PoP`、PoP 位于幂等之后）；
- 原文幂等键 `(code, fabric_id, root)`；
- 未限定的“最近在前/最新在上”或 `last_at` 排序；
- 回放跳过 PoP 验签；
- “拒绝启动或拒绝该台账功能面”、台账级降级；
- “进楼找人”或无票 resolve 命中承诺。

允许且已核对的命中均为正向约束：`last_at 仅展示/不参与排序`、同刻排序场景、
`fail-fast`、`code_hash` 三元组和 relay-only/持票 resolve 文案。

### 基座锚点

本轮仍无 runtime diff；已核对的源码锚点未变化：`gate.rs:285-286,310-313`、
`registry.rs:35-50,115-121,144-192,206-229,260-270`、`relay.rs:46-48,130-143`、
`rendezvous.rs:305-325`、`admin.rs:466`、`sidecar.mjs:172-180,363-365,422-455`、
`target.mjs:30-106`。strict 校验证明 artifact 结构有效，不能替代实现期并发、故障注入
和真实浏览器证据。

## 3. r6 残余问题闭合表

| r6 问题 | 状态 | 闭合证据 |
|---|---|---|
| P1-1 幂等合同在 design/tasks 仍可回退 | **闭合** | `tasks.md:29` 与 `specs/server/spec.md:195` 顺序一致；`design.md:119-124` 与 `specs/server/spec.md:197` 同用规范化 `code_hash` 三元组；`design.md:260` 已拆分新码续期与旧码回放。 |
| P1-2 design 管理列表使用未限定 wall-clock 语义 | **闭合** | `design.md:188` 已明确 seq desc、endpoint_id asc、last_at 仅展示；与 `specs/server/spec.md:159,305` 及 `specs/webui/spec.md:24` 对拍一致。 |

**终验统计：P0=0，P1=0，P2=0；r6 四条 GO 条件闭合 4/4。**

## 4. 实现验收基线

以下六条 r6 基线全部确认，不得回退：

1. `/register` 顺序固定为直连 peer 限流、形状、ts 窗口、PoP 验签、三元组 durable
   幂等回放/pending 补写、码状态、新兑换；回放与普通注册同样验签且不刷新租期。
2. 幂等主键统一为规范化 `code_hash + fabric_id + root`；pending 同码他键 409，
   owners register 与 consume 双 fsync 后才成功响应，恢复按完整三元组补齐。
3. 续期只能持新有效码；旧码同键回放不得刷新 `expires_at`；max_uses=2 的 K1→回放→K2
   与 max_uses=1 并发双兑恰一成功必须保持。
4. 台账加载/归并失败整服务 fail-fast；加载成功但补写失败使用进程内 deny-set + 503，
   成功补写清除，重启由 reconciliation 重演。
5. KnockLog 仅 relay E1 Deny 身份入账；排序/逐出只用 seq（endpoint_id 同 seq tie-break），
   `last_at` 仅展示；dismiss/undismiss/deny/逐出同锁，`pending_count` 恒为未 dismissed 数。
6. 节点簿仅允许已存 node_id 的 `/sidecar/nodes/switch` 运行时切换；token 仅 0600
   `nodes.json` 例外落盘，不出浏览器；原子 rename、拒 symlink、在途 target 快照和
   `/api/* → /admin/*` 业务路径契约不得回退。

跨轮增补三条：

7. 访客可达面 v1 仅 relay；无票 rendezvous resolve/announce 维持 401，KnockLog 只接受
   relay E1 endpoint，`open` 模式不装 gate、不生效门禁台账。
8. 回执继续复用 103B canonical；新增 op `0x04-0x0C`、generation 所属台账语义、client-sdk
   union/builder/fixture 对拍和 `register-receipt/v1` 验签 helper 必须同步。
9. PoP 域固定含 `code || fabric_id || root || ts(u64BE)`；限流只取直连 TCP peer、拒绝
   XFF/Forwarded；邀请码使用 OS CSPRNG 80-bit 熵，码全文仅签发响应一次且不得进入日志、
   指标、错误响应或反代请求体。

以上基线是实现子代理的设计验收合同；strict 通过不等价于这些运行时行为已经实现。
