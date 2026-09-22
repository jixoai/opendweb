# OpenDWeb 设计增量复审 r3：sdk-mgmt-surface / webui-console

## 范围与证据

- 评审 HEAD：`3d58e4e`（r2 文档修订）。本轮只核对用户列出的 r2 修订项，不重开 r1 已接受问题。
- `git show --check HEAD` 通过；三个目标 change 的 `openspec change validate --strict` 均通过。
- 当前 worktree 另有未提交的 `crates/dweb-server/src/access/admin.rs`、`main.rs`、e2e 测试及 `tests/fixtures/`。这些不是 `3d58e4e` 的提交证据；报告明确区分它们。
- 全量 `openspec validate --strict --changes` 仍被无关的 `cf-provider-rewrite`、`invite-token-multi-relay` 缺 delta 阻断；目标三 change 的 scoped 校验不受影响。

## 结论与评分

| Change | 评分 | 判定 |
|---|---:|---|
| `sdk-mgmt-surface` | **7.7/10** | NEEDS-WORK |
| `webui-console` | **8.8/10** | GO（设计层） |

`webui-owner-console` 仍是 `skip_specs: true` 的未排期登记项（[.openspec.yaml](../openspec/changes/webui-owner-console/.openspec.yaml:1)）；不计入两项实现 change 评分。

总判定：**NEEDS-WORK**。r2 的 P0 方向已消除，但 sdk 仍有两个可实现性/一致性 P1，以及冻结向量尚未进入评审 commit；WebUI 的安全设计已冻结，不过新增安全/资源约束尚未完整进入 `specs/webui` 的可测 capability 场景。

## r2 修订逐项核对

### sdk-mgmt-surface

| 修订项 | 结果 | 证据/说明 |
|---|---|---|
| r2-P0-1 `.mjs` + `.d.mts`、ESM-only | **部分闭合** | active 形态与 proposal/spec 已统一（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:116)、[spec.md](../openspec/changes/sdk-mgmt-surface/specs/sdk/node/spec.md:9)），但同节 exports 增量仍写 `.d.ts/.js`（design:127-130），见 P1-1。 |
| r2-P1-1 disconnect 快照 | **部分闭合** | 单次 `OnlineView`、endpoint/fabric 展开序、条目 fabric、共享 `ts/generation`、空 receipts 均已写入 design/spec（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:86)、[server spec](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:29)）。但“唯一 endpoint 条目”没有被现有 `OnlineView` 不变量保证，见 P1-3。 |
| r2-P1-2 envelope minor wire change | **已闭合** | design §1.1、proposal 契约影响、server spec 均改为“成功 wire 不变、错误 body 有意 minor change”（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:30)、[proposal.md](../openspec/changes/sdk-mgmt-surface/proposal.md:63)）。 |
| r2-P1-3 probe 六路矩阵 | **部分闭合** | spec 场景钉住 200/404/401/502/network/timeout（[node spec](../openspec/changes/sdk-mgmt-surface/specs/sdk/node/spec.md:21)），但 design 的返回类型/错误码定义仍不唯一，见 P1-2。 |
| r2-P2-2 receipt fixture | **设计已闭合，提交 provenance 未闭合** | 路径、固定 key/时间/generation、Rust 断言、TS 只读均已写入（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:157)、[tasks.md](../openspec/changes/sdk-mgmt-surface/tasks.md:19)）。`3d58e4e` tree 不含该文件；当前 fixture 只存在于脏 worktree/staged 状态，不能作为该 commit 的交付证据，见 P1-4。 |
| app-protocol-layer 文件避让 | **已闭合（设计层）** | rebase 后以合入快照为基线、追加 admin/token、最终 exports 全集断言均明确（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:173)、[tasks.md](../openspec/changes/sdk-mgmt-surface/tasks.md:34)）。合并态仍需实现时重跑 pack 门。 |

### webui-console

| 修订项 | 结果 | 证据/说明 |
|---|---|---|
| r2-P1-4 stdlib connector | **设计已闭合** | `http[s].request`、解析 IP、SNI、Host、逐请求连接、abort/destroy 已冻结（[design.md](../openspec/changes/webui-console/design.md:86)），tasks 有对应门禁（[tasks.md](../openspec/changes/webui-console/tasks.md:15)）。 |
| r2-P1-5 help/parser/token | **设计已闭合，fixture 仍是实现门** | 告警文案 fixture、help golden、parser 矩阵、token 不入 log/错误串已写入（[design.md](../openspec/changes/webui-console/design.md:127)、[tasks.md](../openspec/changes/webui-console/tasks.md:36)）；尚无提交的 golden 文件，不能宣称实现证据。 |
| r2-P1-7 入站路径 | **设计已闭合** | 独立 raw-path 解析、拒绝歧义段、拼接后二次 `/admin/` 断言、越界零出站已冻结（[design.md](../openspec/changes/webui-console/design.md:96)、[tasks.md](../openspec/changes/webui-console/tasks.md:32)）。 |
| r2-P2-1 解析边界 | **设计已闭合** | localhost 全记录、mapped IPv6、zone-id、尾点、默认端口序列化已列明（[design.md](../openspec/changes/webui-console/design.md:72)）。 |
| r2-P2-3 body/header 界 | **设计已闭合，wire 细节待钉** | 1 MiB 响应、64 KiB 请求、header allowlist、abort 已列明（[design.md](../openspec/changes/webui-console/design.md:92)），但超限响应的具体状态/错误 envelope 未进 spec，见 P2-2。 |
| r2-P2-4 apiFetch 失败态 | **设计/tasks 已闭合，spec 可测性不足** | 注入层与六路 fixture 矩阵已写入（[design.md](../openspec/changes/webui-console/design.md:148)、[tasks.md](../openspec/changes/webui-console/tasks.md:41)），但 `specs/webui` 尚无对应失败场景，见 P2-3。 |
| owner-console 拆分 | **已闭合** | 独立 change 明确未排期、未设计，且 `skip_specs: true`。 |

## P0

本轮没有发现新的 P0。r2-P0-1 的实际模块格式矛盾已通过 `.mjs`/`.d.mts` 与包级 CommonJS 共存的决策消除；下列问题仍阻塞 sdk 设计达到可实现闭合，但不是新的安全红线 P0。

## P1

### P1-1：exports 段落残留旧后缀，ESM 契约仍可被两种方式实现

证据：active 设计先冻结 `"./admin": ... index.d.mts/index.mjs`（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:118)），紧接着又要求 exports `types/default` 指向 `.d.ts/.js`（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:127)）。这不是历史处置表，而是同一实现段落中的相反路径；实现者可能照旧后缀落盘，重新触发 r2-P0-1。

修复：删除 `.d.ts/.js` 残句，统一为 `.d.mts/.mjs`；在 tasks 2.2 的最终 exports 断言中逐字冻结两条新路径，并让 README、package.json 示例只出现新后缀。

### P1-2：`probeEnabled()` 的 404 返回形态与错误码集合不唯一

证据：设计 API 形态写 `boolean / AdminError`（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:137)），矩阵又把 404 写成“`admin-not-enabled（false 语义错误对象）`”（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:145)）；node spec 场景则要求 404 得到 `admin-not-enabled`，502 得到 `http-502`（[spec.md](../openspec/changes/sdk-mgmt-surface/specs/sdk/node/spec.md:21)），但 design 的 code 表没有 `http-<status>` 项（design:151-152）。调用者无法知道 404 是返回 `false`、返回带 status 的对象，还是抛出 `AdminError`，也无法知道 500/503 是否统一为 `http-500`/`http-503`。

修复：冻结一个签名，例如 `probeEnabled(): Promise<true>`，非 200 全部抛 `AdminError`，404 固定 `code="admin-not-enabled"`；或冻结 `Promise<boolean>` 并把错误另行抛出，但不得使用“false 语义错误对象”。将 `http-${status}` 写入 code 枚举/类型与 502、503、未知 5xx 测试矩阵。

### P1-3：disconnect 的“唯一 endpoint 条目”没有由数据模型保证

证据：设计/spec 要求按 endpoint 命中唯一 `{endpoint_id,fabric_id,connections}` 条目（[design.md](../openspec/changes/sdk-mgmt-surface/design.md:86)、[server spec](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:29)）。现有在线表却先按 endpoint 聚合多个 fabric，再用 `fabrics.first()` 作为 receipt/投影的 fabric（[gate.rs](../crates/dweb-server/src/access/gate.rs:185)）；该 `Vec` 来源是 HashMap 遍历，混合 fabric 时选择不具确定性。注释只称“理论上同 fabric”，不是可验证不变量。

修复二选一：在 `OnlineTable:reserve`/握手认证处对同 endpoint 的不同 fabric 明确拒绝并加负测；或把 OnlineView 改成每个 `(endpoint_id,fabric_id)` 一项并相应冻结 disconnect 展开。至少应加入混合 fabric fixture，证明 receipt 的 fabric、排序和 no-match 行为不会依赖 HashMap 顺序。

### P1-4：冻结回执向量未进入 r2 提交，当前只存在脏树文件

证据：r2 commit 的统计与 tree 没有 `crates/dweb-server/tests/fixtures/receipt-vector.json`；当前文件只在脏 worktree/staged diff 中出现，仍不属于 `3d58e4e`。因此 design/tasks 所称“TS 只读冻结文件”在评审 commit 上没有可消费对象。该问题不否定修订规则，但会让跨 Rust/TS 对拍在以该 commit 为基线的干净 checkout 中无法运行。

修复：将 JSON fixture 与其 Rust 只读断言、TS 消费测试一并纳入 change 交付；测试应在 fixture 缺失时失败，而不是在 CI 中写回源码树。若 fixture 只在实现阶段生成，须在 tasks 标明“生成后提交”及 pack/CI 的读取路径。

## P2

### P2-1：stdlib connector 还缺显式禁止连接池的接口断言

`request()` 的“逐请求新建连接”已在设计文字冻结，但没有明确 `agent: false`/socket 生命周期断言；[design.md](../openspec/changes/webui-console/design.md:86) 只要求响应结束或 abort 时 destroy。实现测试应验证 keep-alive 不会跨目标请求复用，并覆盖 abort、DNS 失败、TLS SNI 失败三种关闭路径。

### P2-2：WebUI 资源上限的失败 wire 未冻结

设计已给出 1 MiB/64 KiB 界与 `upstream-too-large`（[design.md](../openspec/changes/webui-console/design.md:92)），但 `specs/webui` 只冻结了代理方法/前缀/重定向/代理变量等高层约束（[spec.md](../openspec/changes/webui-console/specs/webui/spec.md:3)），没有超限时的 HTTP status、JSON envelope、连接回收可观察断言。补一个 scenario，固定请求超限与响应超限各自的状态/body，并断言假上游不会继续读写。

### P2-3：r2 新增 WebUI 安全细节主要停留在 design/tasks，spec capability 场景未同步

raw path 二次 `/admin/` 断言、解析 IP+SNI+Host、help golden、apiFetch 六路失败矩阵分别出现在 design/tasks（如 [design.md](../openspec/changes/webui-console/design.md:86)、[design.md](../openspec/changes/webui-console/design.md:127)），但 `specs/webui` 的场景仍只覆盖配对、目标冻结、基本代理和成功 UI 流程（[spec.md](../openspec/changes/webui-console/specs/webui/spec.md:13)）。tasks 可以驱动实现，却不能替代 capability contract；后续实现容易只满足 design prose 而漏测路径/失败态。

修复：在 `specs/webui` 增加四组可观察 scenario：解析 IP/SNI/Host；每个 raw-path 越界输入 404 且假上游零出站；token help/parser 不泄露；apiFetch 的 six-way error rendering 与 setup no-target。把 fixture 名称/字段/期望状态固定在 spec 或 contracts 路径。

## 评分依据

- `sdk-mgmt-surface` 从 r2 的 6.8 提升至 **7.7**：canonical、mode/relay、envelope 措辞、快照语义、probe 六路、ESM 隔离和 app-protocol owner 协议均有实质修订；扣分集中在旧后缀残留、probe 类型歧义、OnlineView 唯一性和 commit 未携带 fixture。
- `webui-console` 从 r2 的 8.2 提升至 **8.8**：connector、URL/DNS 边界、路径双断言、资源界、help/parser 与 apiFetch 矩阵均已写入 design/tasks；保留 P2 是因为这些新增安全/失败 wire 尚未完整落入 `specs/webui`，且尚无实现/golden 证据。
