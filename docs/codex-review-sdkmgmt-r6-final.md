# OpenDWeb sdk-mgmt-surface / webui-console r6 终审

## 评审范围

本轮只复核 r5 的五项处置及其实现闭合，不重新打开已接受的历史问题。比较基线为 `0828249`，当前 HEAD 为 `5f8926f`（其间包含任务勾选与走查手册收口）。`webui-owner-console` 仍是 `skip_specs: true` 的独立登记项，不纳入两个 change 的实现评分。

## 结论

| Change | 最终评分 | 验收判定 | RELEASE-READY |
|---|---:|---|---|
| `sdk-mgmt-surface` | **9.7/10** | **GO** | **是**（Owner 走查仍是非实现门） |
| `webui-console` | **8.8/10** | **NEEDS-WORK** | **否，需先同步 409 wire 契约** |

总判定：**NEEDS-WORK**。r5 的运行时安全/正确性缺口均已闭合；WebUI 仍有一个可观察的错误响应未写入 change 的设计与 spec：并发配对返回 `409 pairing-in-progress`，而设计仍声称任何失败均为 `400`。因此代码已具备发布质量，但该 change 的契约包尚未达到可冻结发布状态。

## 验证证据

- `openspec validate --strict sdk-mgmt-surface`：通过。
- `openspec validate --strict webui-console`：通过；该结构校验不检查语义 wire 漂移。
- `openspec validate --strict webui-owner-console`：通过，`skip_specs: true`。
- `packages/webui`：`npm test` **85/85** 通过，包含延迟 DNS + 独立 Agent 的真实并发配对回归。
- `packages/client-sdk`：`npm test` **82/82** 通过；`npm run test:pack` 通过 tarball 清单、删除 `.node` 后 `./admin`/`./token` 导入、根入口失败及 NodeNext 类型门禁。
- Rust bins/e2e/clippy 的 `150 / 20 / 0` 为 `0828249` 提交说明中的绿门收据；本轮因机器 swap 水位接近满载未再次启动重负载 cargo。源码与新增单测/e19 已逐项抽查，不能把该收据表述为本轮独立重跑。
- `git diff --check 0828249..HEAD`：通过；三个 change strict 校验通过。

## r5 五项逐项复核

### 1. WebUI 配对码并发消费（r5-P0-1）

**闭合。** `packages/webui/src/sidecar.mjs:422-455` 在 `await validateTarget` 前同步设置 `pairing.inFlight`；第二个已通过基础字段校验的并发请求立即返回 `409` 与 `error.code = "pairing-in-progress"`，`finally` 恢复锁；目标提交前还检查 `state.mode` 与 `state.pairing`，防止目标重复提交。失败的 `bad-target` 不烧码，成功后进入 `ready` 并销毁配对状态。

`packages/webui/test/sidecar.test.mjs:318-352` 用 `localhost` 延迟 DNS 和两个独立 Agent 强制真实并发，断言恰一 `200`、一 `409`，第三次为 `target-frozen`；当前 WebUI 全套 85/85 通过。

### 2. Rust false-first 不重试（r5-P1-1）

**闭合。** `crates/dweb-server/src/access/admin.rs:397-420` 使用 `attempted` 与 `succeeded` 双集合：合法 endpoint 在 dispatch 前即加入 `attempted`，无论返回 `true`/`false` 都不会再次物理 dispatch；只有成功 endpoint 的全部快照 pair 进入返回集。`admin.rs:1665-1693` 的回归测试断言 false-first 仍只有一次调用且结果为空。

### 3. `receiptCanonical` 原型键穿透（r5-P1-2）

**闭合。** `packages/client-sdk/admin/index.mjs:318-330` 通过 `Object.hasOwn(RECEIPT_OP_BYTES, op)` 查表；`packages/client-sdk/test/admin-receipt.test.mjs` 新增 `constructor`、`toString`、`__proto__` 三键 TypeError 回归，避免继承属性被编码为 op byte 0。82/82 测试与跨语言冻结向量均通过。

### 4. e19 disconnected wire 与收敛断言（r5-P2-1）

**闭合。** `crates/dweb-server/tests/server_access_e2e.rs:1816-1857` 将 `disconnected` 与按 `fabric_id` 字典序构造的完整 JSON 数组逐字段比较（endpoint、fabric、connections），验证两张回执共享 `ts`/`generation` 并逐张验签；有界轮询同时要求 `per_endpoint` 与 `per_owner` 清零。该测试保留了同 endpoint 双 fabric 的 mixed-pair 覆盖，断言强度足以捕获漏 pair、错序和单维度假收敛。

### 5. `.mjs` + `.d.mts` 文档残句（r5-P2-2）

**闭合。** `openspec/changes/sdk-mgmt-surface/design.md:122-136,230`、proposal、node spec、实现与 README 均统一为 `.mjs` + `.d.mts`；当前检索未发现旧的 “ESM+.d.ts” 设计表述。`npm run test:pack` 还实际验证了发布物和 NodeNext 类型解析。

## 新发现（尚未闭合）

### P1：`409 pairing-in-progress` 未冻结到 WebUI change 契约

证据：

- 实现 `packages/webui/src/sidecar.mjs:425-427` 明确返回 HTTP `409`、`{"error":{"code":"pairing-in-progress",...}}`。
- 回归测试 `packages/webui/test/sidecar.test.mjs:344-351` 明确要求该 wire；`openspec/changes/webui-console/WALKTHROUGH.md:78` 也记录“恰一成功一 409”。
- 但 `openspec/changes/webui-console/design.md:58-65` 仍写“任何失败 → 400 + 错误码”，错误码列表没有 `pairing-in-progress`；`specs/webui/spec.md:7` 只冻结一次性配对码/目标冻结，没有并发状态与 409 场景；`tasks.md:21-23,32-35` 也未列单飞锁或 409 wire。

这不是当前实现的并发漏洞，且 strict validator 不会发现它；但它会让消费者按设计把 409 误当成 400，也使错误 envelope/status 的契约无法作为发布基线冻结。修复建议：

1. 在 design §2.2 明确同步单飞状态、`409 pairing-in-progress` 的 status/body/message，以及 400 仍适用于普通校验失败。
2. 在 `specs/webui/spec.md` 增加延迟验证下“双 POST：恰一 200、一 409；第三次 target-frozen”的场景，并冻结 `Content-Type` 与 error envelope。
3. 在 proposal/tasks 的契约影响和 A.4/A.8 测试项中同步该行为，避免只在 WALKTHROUGH 留痕。

修复前：`webui-console` 的代码可运行、测试可发布，但 change 文档不能称为完整 RELEASE-READY。

## 其他收口说明

- `crates/dweb-server/src/access/admin.rs:380-388` 仍有一段历史注释用“重复调用会丢 pair”描述旧风险；当前函数已正确去重，建议顺手改为“重复调用会导致 false，因此必须由 attempted 去重”，属于 P2 文档卫生，不改变本轮判定。
- `sdk-mgmt-surface/tasks.md` 的 Owner 走查项 `4.4` 仍未勾选；任务文件明确标注其为非实现门。`webui-console/tasks.md` 的 `C.2` 同样是 Owner 实操验收，不把它降级为代码缺陷，但正式对外发布仍应由 Owner 完成真实云端走查。
- 当前工作树另有未跟踪的历史报告 `docs/codex-review-sdkmgmt-r5.md`；它不是本轮实现证据，也未被修改。

## 最终验收依据

`sdk-mgmt-surface` 的 Rust admin 断连决策、per-pair 快照/回执、跨语言向量、Node SDK 错误矩阵、ESM/native 隔离和 pack 门禁均已闭合，给 **GO 9.7/10**。`webui-console` 的配对面三重防线、并发单飞、路径零出站、资源界、逐请求连接、CLI/plugin 和 UI 失败态均已闭合；唯一未闭合的是新增 409 的设计/spec 同步，给 **NEEDS-WORK 8.8/10**。因此整体验收为 **NEEDS-WORK**，不能在契约同步前宣称两个 change 均 RELEASE-READY。
