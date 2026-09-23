# home-hub 实现终验复核（r19）

## 1. 结论与评分

**结论：NOT-READY，8.6/10。**

r18 的两项 P1 与一项 P2 均已由真实源码和回归测试闭合：visits probe 的非成员拒绝、tray 双断管退出、迁移一致性闸门前置均达到修复条款。当前仍有一项新发现：本轮修复说明明确要求 admin 落 Lease/Visits 页为只读，但 `LeaseView` 仍对 admin 显示并执行本地 label 编辑，sidecar 的 label PATCH 也未按角色收敛。该问题不泄露凭证，也不影响中枢/成员网络安全，但违反本轮 UI 对偶面验收语义；在角色契约明确前不应宣称完全 RELEASE-READY。

## 2. 验证范围与证据

固定对象为当前 HEAD `0d1503c`，实现基点仍为 `333d73e`；`8aa0987` 与 `0d1503c` 是本轮修复提交。当前工作树除本报告外无改动。

本轮独立执行：

- `node --test packages/opendweb/test/*.test.mjs`：**244/244** 通过。
- `node --test packages/webui/test/*.test.mjs`：**195/195** 通过。
- `node --test packages/tray/test/*.test.mjs`：**26/26** 通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `git diff --check 235906d..HEAD`：通过，无输出。

未在本轮重复运行重型 Rust workspace/G-3 300s、Windows 交叉构建或真实浏览器走查；这些仍以 r18 已区分的实现期收据为准，不冒充本轮独立证据。

## 3. r18 三项修复验收

### P1-1 visits probe 成员守卫与 UI 对偶面：通过（但发现只读语义残留）

服务端 `packages/webui/src/core/sidecar.mjs:740-750` 先判断 `member`，admin、默认、hub-local 即使提供合法 same-origin 也返回 `403 forbidden`，早于 Origin 和 body 校验；member 路径随后执行既有四类 Origin 策略。`packages/webui/test/home.test.mjs:470-535` 覆盖 admin/hub-local 负向及 member 的 200/缺失 Origin/伪造 Origin/坏 Host 四类矩阵，五类探测映射也在 member 形态回归。

两视图的 probe 按钮均受 `cs.role === "member"` 门控：`LeaseView.svelte:161-180`、`VisitsView.svelte:68-87`；`console-store.test.mjs:318-326` 做源断言，`home.test.mjs` 做行为断言，提交的 dist bundle 也含同一 role 判定。凭证/Origin/member 负向红线未回退。

因此，r18 原 P1 的**探测写面**已闭合。剩余问题见第 4 节：修复说明写的是 admin 两页只读，但 label 编辑并未同样门控。

### P1-2 tray 默认模式双断管退出：通过

`packages/tray/src/controller.mjs:226-246` 的 `stop()` 幂等执行心跳停止、disposer 清理、stdin `destroy()`、console close，并解析 shutdown；`254-267` 接入 stdout 写错误与默认模式 stdin `end`/`close`，IPC 模式仍由 `createIpcSession` 接管 EOF；`runTray:300-313` 等待停机后返回 exit 0。

`packages/tray/test/lifecycle.test.mjs` 的真实子进程用 pipe 关闭 stdin、销毁 stdout，断言退出码 0 与 `tray-status.json` mtime 冻结；另有双信号幂等、真实 `PassThrough` EOF、IPC 不误接管四例。整包 tray **26/26** 通过。文档同步了宿主必须保持 stdin 打开的约束，`stdio: ignore` 不再作为默认模式。

### P2-1 join 一致性闸门前置：通过

`packages/opendweb/src/join.mjs:486-512` 在 `migrateLegacyRegistration` 前只读 leases/legacy/roster，并用 `buildLegacyLeaseEntry` 预演迁移条目；冲突直接 `CliExit`，不进入网络探测或迁移提交。提交路径从 `:514` 开始，仍在一致性通过后执行。

`packages/opendweb/src/leases.mjs:379-414` 的纯函数同时被预检与迁移提交使用；`join.test.mjs` 新增冲突测试断言 `registration.json` 字节不变、无 `.migrated`、无 `leases.json`、无网络调用，并有一致状态的正向迁移测试。全包 **244/244** 通过，包含迁移/并发/journal 回归。

## 4. 新问题

### P1-NEW：admin “只读”契约未闭合

本轮修复笔记 #14 明确写出“Lease/Visits 视图的‘测一下’按钮仅成员视角渲染，**admin 落这两页为只读**”。当前实现仍在 `packages/webui/ui/src/components/LeaseView.svelte:109-143` 对所有角色渲染 label 编辑输入、保存、清除和 `beginLeaseLabelEdit`；`packages/webui/src/core/sidecar.mjs:788-795` 的 label PATCH 也没有 member 守卫。现有 `home.test.mjs` 只验证 probe 的角色矩阵，`console-store.test.mjs` 只验证 probe 源门控，未验证 admin label 只读；因此当前绿门不能证明该新增语义。

可验证修复建议：先冻结口径。若“只读”是本轮硬契约，则 LeaseView 在 `cs.role !== "member"` 时隐藏/禁用 label 编辑，补 admin/hub-local UI 源断言、dist 产物断言和交互测试；若 API 也必须只读，则 label PATCH 在非 member 先返回明确 403，并补相应 Origin 前置顺序测试。若产品仍允许 admin 修改本机租约备注，应删除“admin 只读”表述，回到已有 `label` 写路由契约，并补一条明确的 admin 可写测试，消除文档与实现分歧。

这是本轮唯一新的契约问题。它不构成 token、上游出站或账本并发安全漏洞，但在角色面验收严格按“只读”解释时阻止 RELEASE-READY。

## 5. 安全红线复核

- hub-token/admin token：本轮改动未把 token 引入浏览器、URL、argv、IPC、心跳或业务日志；已有 projection/logAccess 与 focused tests 仍通过。
- 文件权限：hub-token、heartbeat、leases/visits/nodes 等原子落盘和 0600/symlink 防护未被本轮修复破坏。
- Origin：probe/label 的精确 Host+Origin 四类策略仍通过；probe 现在在非 member 先返回 403，符合授权优先。
- member 负向面：`/admin/*` 编码变体 404 且零上游、connect/nodes 403 的 195 项 webui 全量回归通过。

## 6. 实现质量与口径对照

三个修复都采用了可测试的最小改动：角色守卫位于写入副作用之前，tray 停机统一走 single-flight/idempotent stop，迁移预检与提交共享纯构建函数。新增测试包含真实子进程和文件不变性，而不是只做字符串断言；Node 三包当日独立数字为 244/195/26。

相较 r17 设计层 **9.0/10**，当前实现已有完整的命令、sidecar、tray、账本与生命周期落点；相较 `server-access-roles` 实现终验 **9.2/10**，仍因角色只读语义未定/未实现扣分。若按“只读”冻结并补齐 P1-NEW，预计可升至约 9.2；若 Owner 明确 admin label 写入是既有允许面并同步契约，则本项转为文档闭合，可直接重新判定发布。

## 7. 最终判定

**NOT-READY（8.6/10）。** r18 的三项修复均通过；请先解决“admin 落 Lease/Visits 只读”与 label 写路由的契约分歧，并补对应测试/产物证据，再转 RELEASE-READY。
