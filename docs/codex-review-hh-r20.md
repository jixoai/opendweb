# home-hub 实现终验终判（r20）

## 1. 结论与评分

**结论：RELEASE-READY，9.2/10。**

r19 唯一的 P1-NEW 已闭合。`301d05e` 明确将角色收敛限定为 visits/probe 成员事实簿；label 是本机租约簿的显示命名，属于本机用户数据，任意本机姿态均可写，Origin 严格策略保持不变。该口径与 webui spec 既有条款一致：probe 明文要求 member-only，label 条款没有角色限定。

## 2. P1-NEW 验收

**通过。**

- `IMPLEMENTATION-NOTES.md:59` 的过宽“admin 落两页只读”表述已作废，替换为 probe/visits 与 label 的数据归属分层。
- `openspec/changes/home-hub/specs/webui/spec.md:33-48` 保持一致：`POST /sidecar/visits/probe` 非 member 403；`PATCH /sidecar/leases/{id}/label` 只冻结不透明 id、内容/长度、锁协议与严格 Origin，没有 member 限制。
- `packages/webui/src/core/sidecar.mjs:788-832` 的 label 路由继续允许任意本机姿态，但仍经过精确 Host+Origin 保护和账本锁写入。
- `packages/webui/test/home.test.mjs` 新增 r19 P1-NEW 测试：admin same-origin label 写入返回 200，并从 `/sidecar/leases` 读回持久化值“中枢机自看”。

这正是 r19 报告预告的选项三闭合路径；因此不再构成阻塞问题。

## 3. 独立验证证据

当前 HEAD 为 `2e49951`，工作树仅新增本报告。独立执行：

- `node --test packages/webui/test/*.test.mjs`：**195/195** 通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `git diff --check 301d05e^..HEAD`：通过。

r19 已独立验证的实现回归门继续有效：opendweb **244/244**、tray **26/26**；本轮提交除契约笔记与 webui 测试外未改变这些实现路径。Rust G-3 300s、Windows 交叉构建和真实浏览器走查仍沿用此前明确区分的收据，不冒充本轮重跑。

## 4. 安全与质量终判

visits probe 仍在授权守卫后于非 member 先返回 403；member Origin 四类矩阵、/admin/* 404 零上游、connect/nodes 403 未回退。label 的任意姿态可写不扩大远端管理面：只写本机 `leases.json`，并保留严格 Host+Origin、账本锁和原子持久化。token 不进入浏览器、URL、argv、IPC 或日志的既有红线未受本轮影响。

相较 r17 设计层 **9.0/10**，当前实现闭合了实现期义务；相较 `server-access-roles` 实现终验 **9.2/10**，本 change 达到同等发布口径。评分 **9.2/10** 的扣分仅对应未在本轮重复运行的重型/跨平台/真实浏览器收据，不是已知阻塞缺陷。

## 5. 最终判定

**RELEASE-READY（9.2/10）。**
