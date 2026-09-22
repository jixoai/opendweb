# OpenDWeb sdk-mgmt-surface / webui-console r5 Delta Review

评审范围：只复核 r4 四项处置及三个实现提交（`4fd9ed7`、`a7367ff`、`6c587d7`）的忠实度，并核对其后已落入当前 HEAD 的收口提交（当前 HEAD：`b248955`，包含 `c2c39ef` WebUI SPA 与 `985efca` SDK README/e2e）。工作树仅有用户对旧 r3 报告的修改；未把该 dirty 文件作为实现证据。

## 结论与评分

| Change | 评分 | 判定 |
|---|---:|---|
| `sdk-mgmt-surface` | **7.8/10** | NEEDS-WORK |
| `webui-console` | **4.8/10** | NEEDS-WORK |

总判定：**NEEDS-WORK**。Rust 的 mixed-fabric 物理断连和 endpoint 聚合已经落地，SDK 的探测、canonical、pack 隔离也通过实测；但 WebUI 配对码消费仍有可复现的并发竞态，破坏“一次性配对码/目标冻结”安全边界，是 P0。

`webui-owner-console` 仍为另行登记的 `skip_specs: true` change，无实现评分，不改变上述两项评分。

## 验证证据

- `openspec validate --strict sdk-mgmt-surface`、`webui-console`、`webui-owner-console`：均通过；owner change 按 `skip_specs` 正常通过。
- `packages/client-sdk`：`npm test` **73/73** 通过；`npm run test:pack` 通过清单、删除 `.node` 后 `./admin`/`./token` import、根入口失败、NodeNext 类型门禁。
- `packages/webui`：`npm test` **84/84** 通过，包含真实 sidecar e2e、入站越界零出站、资源界、连接回收、目标守卫及 UI 六类错误态。
- `packages/opendweb`：`npm test -- --test-name-pattern='foldSingleCommand|cli e2e'` 的 `checkjs` 与 **105/105** 测试通过。
- Rust（串行 `mbx`）：`disconnect_endpoints_mixed_pairs_keeps_all_pairs_per_dispatched_endpoint`、`status_projection_aggregates_pairs_to_endpoint_level`、`e19_admin_disconnect_mixed_fabric_same_endpoint` 均通过。
- `git diff --check` 与三项 strict 校验通过；上述测试均以当前 HEAD/工作树实现执行，代码文件无未提交实现改动。

## P0 阻塞问题

### P0-1：setup 配对码不是并发一次性消费，目标冻结可被两个请求同时穿透

证据：`packages/webui/src/sidecar.mjs:363-433`。请求先读取共享 `state.pairing` 并校验配对码（`402-414`），随后在 `await validateTarget(...)`（`422`）期间让出事件循环，只有校验返回后才在 `429-433` 设置 `mode = "ready"`、写入 target/token 并清除 pairing。两个并发请求可在 `await` 前同时通过同一配对码；后一个请求随后也能写入 target/token。

独立探针给 `validateTarget` 注入延迟 DNS，两个完全相同的 `/sidecar/connect` 并发 POST 返回：`200 {"ok":true}`、`200 {"ok":true}`。这违反 spec 的“单次有效/成功即失效”和“目标一经设定冻结”（`openspec/changes/webui-console/specs/webui/spec.md:6-7,23-26`），并允许一次配对码触发重复配置或覆盖已选目标。

修复建议：在配对码和请求字段通过后，先以同步状态转移将 `setup` 标记为 `pairing-in-flight`/消费锁，或使用等价的单飞 CAS；在锁持有期间拒绝第二请求。目标校验失败时明确决定是否恢复同一配对尝试，但任何路径都不能让两个请求同时进入 `validateTarget` 后的提交段；补充延迟 DNS 的并发回归测试，断言最多一个 200、另一个为明确错误。

## P1 问题

### P1-1：Rust 纯决策核在 false-first 时仍重复物理 dispatch

`crates/dweb-server/src/access/admin.rs:396-417` 只在 `dispatch(endpoint)` 返回 `true` 后将 endpoint 放入 `dispatched`。若同 endpoint 第一条 pair 返回 `false`，第二条 pair 会再次调用 dispatch；这违背函数注释所冻结的“每 endpoint 至多被调用一次”语义（`394-395`），也使 `None = 全 endpoint` 的调用次数依赖输入 pair 数量。

修复建议：增加独立的 `attempted` 集合，在调用前记录 endpoint；`succeeded` 只记录成功 endpoint，用它筛选全部快照 pair；增加 false-first mixed-pair 单测，断言 dispatch 次数仍为 1 且返回为空。

### P1-2：`receiptCanonical` 接受继承原型键，非法 op 被静默编码为 0

`packages/client-sdk/admin/index.mjs:47` 使用普通对象保存 op 映射，`receiptCanonical` 在 `:317-328` 直接以 `RECEIPT_OP_BYTES[receipt.op]` 读取。实测 `op = "constructor"`、`"toString"`、`"__proto__"` 均被接受，输出 canonical 的 op byte 为 `0`，而非抛出 `TypeError`。这破坏了“op 必须为三种冻结值”的运行时契约，并可能让调用方对无效回执签名错误消息。

修复建议：使用 `Object.hasOwn(RECEIPT_OP_BYTES, op)` 或 `Map` 查表，并补三种原型键回归测试。

## P2 / 收口项

### P2-1：e19 仍未完全钉住 disconnected wire 与 per-owner 收敛

`crates/dweb-server/tests/server_access_e2e.rs:1812-1835` 断言 `disconnected.len() == 2`、两张回执的共享 `ts/generation`、逐张验签，并以 `per_endpoint` 清零作为收敛条件；但没有断言 `disconnected` 中两条的 endpoint/fabric/connections 及数组顺序，也没有直接断言两个 `per_owner` 计数均为零。回执验签通过只能证明 receipts，不等于 disconnected 列表的 wire/order 完整。

修复建议：按预期 endpoint/fabric 字典序逐项比较 `disconnected`，检查两条连接数，并在轮询谓词中同时要求 `per_endpoint` 与 `per_owner` 均为空。

### P2-2：设计处置表残留旧后缀

`openspec/changes/sdk-mgmt-surface/design.md:230` 仍写“手写 ESM+.d.ts”，而实现、spec、README 已冻结为 `.mjs + .d.mts`。这不影响当前运行时，但会使后续实现者误读已关闭的 r2/r3 决策。改为 `.mjs + .d.mts` 即可。

## r4 四项逐项核对

### `sdk-mgmt-surface`

| r4 项 | 结果 | 证据 |
|---|---|---|
| P0-1 disconnect endpoint 去重/保留全部 pair | **主路径闭合，false-first 部分闭合** | `admin.rs:396-417` 通过成功 endpoint 保留全部 pair；Rust mixed-pair 单测和 e19 通过；但见 P1-1。 |
| P1-1 endpoint-level projection | **闭合** | `admin.rs:433-457` 用 `BTreeMap` 聚合 connections、取最小 fabric；聚合单测通过，输入顺序不影响结果。 |
| P1-2 fixture 重生成门 | **闭合** | `admin.rs:1842` 严格匹配 `DWEB_REGEN_FIXTURES == "1"`；冻结 fixture 在 `crates/dweb-server/tests/fixtures/receipt-vector.json`，Rust 生成断言、TS 只读对拍。 |
| e19 断言强度 | **部分闭合** | 已覆盖同 endpoint 双 fabric、connections per-pair 排序、status 聚合、两回执共享元数据/逐张验签和收敛；列表字段及 per-owner 清零仍见 P2-1。 |

### `client-sdk ./admin` / `./token`

| 抽查项 | 结果 | 证据 |
|---|---|---|
| `probeEnabled(): Promise<true>` | **闭合** | `admin/index.mjs:218-247` 只对 200 resolve；404/401/其它非 200、network、timeout 分别拒绝，73/73 测试通过。 |
| canonical/验签/fixture | **主路径闭合** | `admin/index.mjs:317-365` 103B 大端布局、disconnect endpoint 槽位、注入式 verifier；pack/test 对拍通过；原型键异常见 P1-2。 |
| native 主入口隔离 | **闭合** | `package.json:29-35` 使用 `.mjs/.d.mts` exports；pack gate 在删 `.node` 后导入两个 subpath 成功且 root 失败。 |
| README/ESM 决策 | **实现闭合，文档有一处旧表述** | `packages/client-sdk/README.md` 已存在并说明 ESM-only；design 历史表仍残留 `.d.ts`，见 P2-2。 |

### `webui-console`

| r4/指定抽查项 | 结果 | 证据 |
|---|---|---|
| sidecar 配对面/目标冻结 | **P0 未闭合** | `sidecar.mjs:338-436` 的 Host/Origin/配对码校验和目标守卫存在，但提交段缺少并发消费锁，见 P0-1。 |
| 入站路径解析与零出站 | **闭合** | `parseApiPath`、拼接后二次 `/admin/` 断言（`sidecar.mjs:220-245`）；84/84 测试含假上游零出站。 |
| 资源界/逐请求连接/错误 wire | **闭合** | `sidecar.mjs:236-333,497-530`；请求 64 KiB、响应 1 MiB、abort 回收、白名单响应头和失败 envelope 均有测试。 |
| CLI 折叠/插件 envelope | **闭合** | `packages/opendweb/src/plugin-contract.mjs:112-120` 与 `packages/webui/src/plugin.mjs:29-32` 使用 `{command,args,log,cwd,stdout,stderr}`；opendweb 105/105。 |
| target 守卫 | **闭合** | `packages/webui/src/target.mjs:30-105` 解析全部 DNS A/AAAA、固定 connect IP/SNI/Host、无代理/不跟重定向；target 矩阵通过。 |
| UI 六路失败态 | **闭合（实现层抽查）** | `openspec/changes/webui-console/specs/webui/spec.md:63-66` 场景落地；webui 84/84。 |

## 评分依据

- `sdk-mgmt-surface` **7.8/10**：r4 的核心 Rust 数据模型、endpoint 聚合、冻结回执向量、`probeEnabled` 六路矩阵、ESM/native 隔离和实际 pack/type 测试均扎实；扣分来自 false-first dispatch 语义缺口、canonical 原型键输入校验和 e19 断言尚未完全覆盖。
- `webui-console` **4.8/10**：路径/SSRF/资源/连接生命周期、token 披露、CLI 契约和 UI 可测性均有较完整实现与绿测；但配对码是唯一配置授权边界，当前可由并发请求重复消费并覆盖目标，故在安全阻塞修复前不能 GO。

