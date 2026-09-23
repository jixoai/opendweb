<!--
Intent: home-hub r17 design-readiness review.
Original request: independently verify r16's no-server-expansion admission-journal recovery at HEAD 79032df.
Timestamp: 2026-09-24 Asia/Shanghai.
-->

# home-hub 设计层复审 r17

评审基点：`HEAD 79032dfc67bb45fb26c12c0e63c762cd00295182`。
对照基点：r16 `5c5c389`，r16 结论 NOT-READY 8.0/10。本轮只读；仅新增本报告。

## 1. 结论与评分

结论：**GO（设计层），9.0/10（较 r16 +1.0）**。

r17 已完整闭合 r16-P1-1，且没有引入新的 P0/P1。journal 仍只存不可逆
`code_hash`，不扩大邀请码持久化面；发现 journal 后先封死新的 fabric 决策，要求
重输邀请码。只有规范化 hash 与 journal 相等时，CLI 才以 journal 固定的
`server/fabric_id/root` 和新 ts 重签 `/register`，从而命中既有同键幂等回放或同键
pending 补写路径。任何无码、异码、网络未知或 `code-pending` 都保留 journal 并
fail-closed；`code-invalid`/`code-expired` 也不会被误作“未登记”的授权。

这消除了“响应已到服务端但本地崩溃后，下一次 join 换 tuple 造成第二 fabric”的
路径，同时不需要新增 dweb-server API 或把邀请码全文写盘。结论只表示设计可进入实现；
并不表示 relay、自启、tray、G-3 或 journal 故障注入已获得实现证据。

| 维度 | r16 | r17 | 判断 |
|---|---:|---:|---|
| Owner 裁决覆盖 | 9.3 | 9.4 | H0-H8 机制完整；H7 异常 admission 有可执行恢复入口。 |
| 基线契约一致性 | 8.2 | 9.2 | 重输原码后再签 PoP，严格落在 `(code_hash,fabric_id,root)` 幂等键和 server 零改动边界内。 |
| 三方一致性 | 8.6 | 9.2 | design、leases delta 与 Scenario 对同一状态机逐项同步。 |
| 技术可实现性 | 7.9 | 8.9 | 输入、身份 seed、固定 tuple 与已有 `/register` 回放路径均可获得。 |
| Spec 可测性 | 8.2 | 8.9 | 三类故障均有无码/同码/异码与最终账本断言；需在实现期故障注入。 |

## 2. 验证证据

### 实际阅读

- `docs/codex-review-hh-r16.md`，逐项核验唯一 P1 的修复建议。
- v17 diff 与当前文件：`openspec/changes/home-hub/design.md` §2.1、§10；
  `openspec/changes/home-hub/specs/cli/leases/spec.md`。
- 叠加规范与真实实现：
  `openspec/changes/server-access-roles/specs/server/spec.md`、
  `specs/cli/identity/spec.md`；`crates/dweb-server/src/access/codes.rs` 的
  `normalize_code_body`、BLAKE3 hash 与 `redeem` 状态机；
  `crates/dweb-server/src/access/register.rs` 的 PoP 与 `/register` 路由；
  `packages/opendweb/src/join.mjs`、`register.mjs` 的 code 原文签名和新 ts 请求事实。
- requirements/proposal/PRODUCT-DESIGN 与余下 hub/sdk-node/webui/tray deltas，确认
  本轮未改变其冻结面或 [H8] 的 dweb-server 零改动边界。

### 实际命令与结果

- `git rev-parse HEAD`：`79032dfc67bb45fb26c12c0e63c762cd00295182`，与任务给定
  HEAD 一致；`git rev-parse HEAD^`：`5c5c389f611231c0c06d96796158fa58d8ef1088`。
- `git log --oneline -6`、`git diff HEAD^..HEAD -- design.md leases/spec.md`：v17 只
  增加 r16 状态机与 r16 报告存档，未扩 server 或 SDK 生产代码。
- `git diff --check HEAD^..HEAD`：通过。
- `openspec validate home-hub --strict`：`Change 'home-hub' is valid`。
- `openspec validate server-access-roles --strict`：`Change 'server-access-roles' is valid`。
- 未运行 Rust/Node、真实 HTTP 崩溃注入、restricted relay、G-3 300 秒、自启、tray 或
  浏览器 acceptance；严格校验不构成实现期验收。

## 3. r16 问题闭合度

| 编号 | 当前结论 | 核验 |
|---|---|---|
| R16-P1-1 journal 只有 hash，无法同 tuple 回放/确认 | **闭合** | design §2.1（263-280）与 leases delta（16、67-70）均冻结“先发现 journal、拒绝新决策、重输原码、hash 相等后按 journal tuple+新 ts 重签、200 后补账清 journal”。无码/hash 不符/网络未知/`code-pending` 一律保留 journal；异码零副作用。 |

交叉事实验证：服务端 `normalize_code_body` 的输入规范化是剥 `dwebc1.` 前缀与
连字符、转小写后 BLAKE3；`redeem` 先检查 `(code_hash,fabric_id,root)` durable
回放，再处理同键 pending 补写，最后才裁决 invalid/expired/exhausted。故 r17 的同码
hash 比对、journal tuple 和新 ts PoP 恰能构造基线允许的恢复请求，不需原始码落盘或
member 状态查询。对 `code-invalid`/`code-expired` 保守保留 journal也避免把未知远端
结果错误授权为新 fabric 决策。

## 4. 新问题清单

### P0

无。

### P1

无。设计层 GO 的条件已满足。

### P2

无新增设计缺陷。

实现时应将服务端既有的 code 规范化/BLAKE3 算法以 CLI 独立实现或受控依赖对拍，不能
把“规范化 hash”简化成原文 hash；这是实现验收项，不阻塞本设计结论。

## 5. Owner 裁决与十条不可回退基线

本轮没有修改 `server-access-roles`，且两项 strict validation 都通过。没有发现
alias、邀请码、敲门、WebUI 冻结面、renew 顺延或 first_registered_at 的退化。

| 裁决 | r17 终判 |
|---|---|
| H0 | **设计满足**：Custom relay/deferStart 与异常 admission 恢复均有 fail-closed 链。 |
| H1 | **设计满足**：短码 wire/golden vectors 未改；跨端对拍属实现期。 |
| H2 | **设计满足**：tray 插件事件/RPC 契约未改；真实图标壳 acceptance 待交付。 |
| H3 | **设计满足**：显式 init/start、自启、stop owner 和默认不启动契约未改。 |
| H4 | **设计满足**：webui core/薄壳、注入 opener、管理员入口边界未改。 |
| H5 | **设计满足**：三视角与 member sidecar 安全分流未改。 |
| H6 | **设计满足**：alias 仍是显示层消费，未放宽服务端注册契约。 |
| H7 | **设计满足**：单 fabric、多 server leases、admission 锁和崩溃恢复均有明确状态机。 |
| H8 | **设计满足**：deferStart/fabricId 最小扩展未超出 Owner 授权；dweb-server 零改动。 |

| # | 不可回退基线 | r17 终判 |
|---:|---|---|
| 1 | 中枢只在显式 init/start/autostart 后运行 | **PASS（设计）**。 |
| 2 | restricted、admin token 0600、token 不出面、插件不得降级安全 | **CONDITIONAL**：设计已冻结，需真实首触带票与 restricted 握手转正。 |
| 3 | 一个 hub 对应一个 data_dir，接管先确认、迁移不损坏原数据 | **PASS（设计）**。 |
| 4 | detached/foreground/autostart 的 owner、PID、stop 和卸载单一事实源 | **PASS（设计）**。 |
| 5 | 绝对 Exec、cwd/env、平台范围和 quoting 可复现，失败不假成功 | **PASS（设计；平台 acceptance 待交付）**。 |
| 6 | leases/visits 写者明确、锁/CAS 合并不丢写、续期时间语义不变 | **PASS（设计）**：admission→ledger 锁序与 journal 同 tuple 回放已冻结。 |
| 7 | member sidecar 不成为 admin/setup 代理，写路由有 schema/Origin/负向测试 | **PASS（设计）**。 |
| 8 | 短码是一次冻结的跨端 wire，真实接收端离线解码 | **PASS（设计；CLI/WebUI 对拍待交付）**。 |
| 9 | tray 只消费版本化状态/深链/事件/JSON-RPC，stdout 所有权明确 | **PASS（设计；真实壳 acceptance 待交付）**。 |
| 10 | G-3 只宣传已证明条件，先证 Direct、停整个 hub、仅 test-only Rust | **CONDITIONAL（实现证据待交付）**。 |

## 6. 设计结论与实现期义务

**设计层 GO。** 可进入 Phase 0-3 实现；这不等同于 release GO。实现期必须完成：

1. 在 CLI 实现精确的 code 规范化+BLAKE3 对拍，并对 journal 注入三类故障：响应丢失、
   register durable 后落账前崩溃、陈锁接管。逐一断言无码不发请求、同码同 tuple 回放、
   异码零副作用、未知/pending 保留 journal、远端最多一个登记和账本最终一致。
2. 验证同 fabric 双 server 租约、identity/dataDir 连续性、deferStart 零出站、缓存票
   优先级、首次 relay 接触带票，以及 Custom restricted 的成功、无票、跨 server、
   malformed 拒绝路径。
3. 完成 G-3 的 Direct 前置、停整个 hub 300 秒、新 join 失败、重启恢复、relay-only
   对照或六字段 NOT-EXECUTABLE 记录。
4. 完成 darwin/Windows 自启生命周期 acceptance、member sidecar 负向矩阵、短码
   CLI/WebUI 对拍、tray 真实壳 IPC/心跳 acceptance，并提交约定的 acceptance 记录。
