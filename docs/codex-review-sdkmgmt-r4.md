# OpenDWeb sdk-mgmt-surface / webui-console r4 Delta Review

评审基线：`493a445`。本轮只复核用户列出的 r3 处置项及其 Rust Phase 1 实现抽查；工作树中未提交的 client-sdk/webui 文件不作为本轮提交证据。

## 结论与评分

| Change | 评分 | 判定 |
|---|---:|---|
| `sdk-mgmt-surface` | **5.4/10** | NEEDS-WORK |
| `webui-console` | **8.8/10** | GO（设计层） |

总判定：**NEEDS-WORK**。`OnlineView` 的 per-pair 改动本身正确，回执 canonical、快照时序和 e17/e18 的单 fabric 场景也有实测证据；但断连实现无法兑现同一 endpoint 多 fabric 时的逐 pair 回执契约，属于本 change 的阻塞问题。

## 验证证据

- `openspec change validate --strict sdk-mgmt-surface`、`webui-console`、`webui-owner-console` 均通过；后者按 `skip_specs: true` 正常通过。
- `git show --check 493a445` 与该提交的 `git diff --check` 通过。
- 协作测试 lane 报告：`mbx test -p dweb-server --bin dweb-server access::admin::tests:: -- --test-threads 2` 为 11 passed；e17、e18 各 1 passed。它们覆盖真实 relay 的单 endpoint/同 fabric 多 endpoint，但没有覆盖同一 endpoint 多 fabric 的断连路径，因此不能证明下述 P0 已闭合。

## r3 处置逐项核对

### `sdk-mgmt-surface`

| r3 项 | 结果 | 证据 |
|---|---|---|
| P1-1 `.mjs` + `.d.mts` | **部分闭合** | exports、Node spec、tasks 已统一新后缀（[design.md:121-133](../openspec/changes/sdk-mgmt-surface/design.md:121)）；但活动设计仍写“`.d.ts` 自包含”（[design.md:134-135](../openspec/changes/sdk-mgmt-surface/design.md:134)），历史处置表也仍写 `ESM+.d.ts`（[design.md:228](../openspec/changes/sdk-mgmt-surface/design.md:228)）。 |
| P1-2 `probeEnabled` | **契约主体闭合，设计残句未清** | Node spec 已冻结 `Promise<true>` 和六路互斥矩阵（[spec.md:7](../openspec/changes/sdk-mgmt-surface/specs/sdk/node/spec.md:7)）；活动 API 代码块仍写 `boolean / AdminError`（[design.md:147](../openspec/changes/sdk-mgmt-surface/design.md:147)），动态 `http-<status>` 也未列入紧邻的 code 表（[design.md:159-160](../openspec/changes/sdk-mgmt-surface/design.md:159)）。 |
| P1-3 per-pair `OnlineView` | **视图闭合，断连消费未闭合** | `view()` 按 `(endpoint_id,fabric_id)` 聚合并双键排序（[gate.rs:183-209](../crates/dweb-server/src/access/gate.rs:183)），混 fabric 回归测试存在；但断连 helper 仍按物理 endpoint 逐次调用 relay API，见 P0-1。 |
| P1-4 fixture | **文件/对拍闭合，重生成门有缺口** | fixture 已进入提交（[receipt-vector.json:1](../crates/dweb-server/tests/fixtures/receipt-vector.json:1)），包含四样例；缺失默认失败且有显式重生成分支（[admin.rs:1715-1738](../crates/dweb-server/src/access/admin.rs:1715)），但分支判断接受任意已设置值，见 P1-3。 |
| e17/e18 | **单 fabric 形态闭合** | e17 验签、共享路由收敛和同票重连（[server_access_e2e.rs:1521-1547](../crates/dweb-server/tests/server_access_e2e.rs:1521)）；e18 验证 endpoint 排序、两张回执、共享 `ts/generation`、逐张验签和收敛（[server_access_e2e.rs:1613-1647](../crates/dweb-server/tests/server_access_e2e.rs:1613)）。缺少混 fabric 同 endpoint 场景。 |

### `webui-console`

| r3 项 | 结果 | 证据 |
|---|---|---|
| P2-1/2/3 入站路径、资源界、连接生命周期、token 输出 | **基本闭合** | 新场景已落入 capability spec（[spec.md:38-56](../openspec/changes/webui-console/specs/webui/spec.md:38)），与 design/tasks 的 raw-path 二次断言、502 和逐请求 socket 语义对应。 |
| P2-4 `apiFetch` 六路失败态 | **闭合（设计层）** | 六类错误和 setup 未连接态均已写入 spec（[spec.md:58-61](../openspec/changes/webui-console/specs/webui/spec.md:58)）。 |
| 可测性细节 | **仍有 P2** | 资源上限把“响应 >1 MiB”和“请求 >64 KiB”合并为一个 OR 场景，单测可只覆盖一支；且 wire 只写 code，未冻结 `message`/Content-Type。见 P2-2。路径样例中的 `/api/../status` 也应以 raw HTTP request fixture 表述，避免浏览器先规范化。 |

`webui-owner-console` 仍是登记项，`.openspec.yaml` 为 `skip_specs: true`，未排期、不计实现评分。

## P0 阻塞问题

### P0-1：同 endpoint 多 fabric 时断连丢 pair 与回执

证据链：

- r3 视图现在允许同一 endpoint 产生多个 `(endpoint_id,fabric_id)` 条目（[gate.rs:189-201](../crates/dweb-server/src/access/gate.rs:189)）。
- disconnect 按 endpoint 请求会把所有 pair 收入 `targets`（[admin.rs:655-669](../crates/dweb-server/src/access/admin.rs:655)）。
- 但共享 helper 对每个 pair 调用 `Clients::disconnect(endpoint_id, None)`，并只保留返回 `true` 的条目（[admin.rs:386-397](../crates/dweb-server/src/access/admin.rs:386)）。`iroh-relay` 的 `connection_id=None` 明确定义为断开该 endpoint 的 every connection（`iroh-relay-1.1.0/src/server/clients.rs:172-196`）；第一次调用已覆盖该 endpoint 的全部连接，后续 pair 不再形成独立命中，`hits` 因而丢掉 pair，后面的回执映射也只生成剩余 `hits`（[admin.rs:680-719](../crates/dweb-server/src/access/admin.rs:680)）。

这直接违反了设计/spec 对 endpoint 请求“全部对条目、按 fabric 展开、每对一张回执”的冻结语义（[design.md:88-94](../openspec/changes/sdk-mgmt-surface/design.md:88)、[server spec:29](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:29)）。它不是测试覆盖不足，而是该输入下成功 wire 不可实现。

修复建议：将物理断连动作按 endpoint 去重，只对每个 endpoint 调用一次 `Clients::disconnect(endpoint,None)`；动作成功后仍按同一份快照保留该 endpoint 的全部匹配 pair，分别生成 `disconnected`/receipt（各 receipt 使用对应 snapshot fabric，且共享 `ts/generation`）。若需要 pair 级真实断连，则必须先增加可按 endpoint+fabric 定位的 relay 原语；不能再次对同一 endpoint 重复调用全 endpoint API。新增 e2e：一个 endpoint 同时持两个 fabric，endpoint selector 返回两 pair、两回执，且按 fabric 排序。

## P1/P2 建议

### P1-1：`/admin/status` 的既有 wire 被 per-pair 改动波及

`status()` 直接把新的 `gate.online_view().per_endpoint` 序列化进 `active_connections`（[admin.rs:467-505](../crates/dweb-server/src/access/admin.rs:467)）。同一 endpoint 多 fabric 时，旧的单 endpoint 聚合数组会变成多个 pair 条目；但设计明确声称 `/admin/status` 是既有冻结 wire、详细 per-pair 只属于 `/admin/connections`（[design.md:62-65](../openspec/changes/sdk-mgmt-surface/design.md:62)；[server spec:10](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:10)）。

修复建议：为 status 保留旧 endpoint 聚合投影（明确其 fabric 字段选择/兼容规则），connections 单独消费 per-pair view；或者显式把 status 也版本化并同步所有消费者。当前两种语义同时存在，不能宣称 wire 不变。

### P1-2：冻结向量重生成门不是 `=1` 门

测试注释和文档要求 `DWEB_REGEN_FIXTURES=1`，但实现只判断环境变量是否存在（[admin.rs:1722-1726](../crates/dweb-server/src/access/admin.rs:1722)）。`DWEB_REGEN_FIXTURES=0`、空值等也会写回 fixture，削弱“缺失即失败/显式重生成”的保护。

修复建议：严格匹配 `std::env::var("DWEB_REGEN_FIXTURES").as_deref() == Ok("1")`（或等价 `matches!`），其它值按缺失失败，并在测试矩阵中加入 `0`/空值。

### P1-3：活动设计仍留有会改变实现选择的旧契约文字

`.d.ts` 自包含（[design.md:134-135](../openspec/changes/sdk-mgmt-surface/design.md:134)）、`boolean / AdminError`（[design.md:147](../openspec/changes/sdk-mgmt-surface/design.md:147)）与动态 `http-<status>` 未入 code 表（[design.md:159-160](../openspec/changes/sdk-mgmt-surface/design.md:159)）会让实现者在 spec 与 design 之间做不同选择。历史处置表的 `.d.ts` 残字（[design.md:228](../openspec/changes/sdk-mgmt-surface/design.md:228)）虽不影响实现，但违反“全文统一”验收断言。

修复建议：活动段落全部改为 `.d.mts`、`probeEnabled(): Promise<true>`，code 表明确包含 `http-<status>`；若保留历史处置表，按当前冻结文本更新。

### P2-1：WebUI 资源界场景需要拆分并冻结完整错误 wire

当前 spec 用一个 OR 场景覆盖两种方向（[webui spec:43-46](../openspec/changes/webui-console/specs/webui/spec.md:43)）。拆成“上游响应超 1 MiB”和“请求体超 64 KiB”两个 scenario，分别断言 abort/socket 回收、HTTP 502、`Content-Type: application/json` 及完整 `error.code/message`，才能防止只实现一条分支。路径越界场景应将 `/api/../status` 改为原始请求行/fixture，避免浏览器 URL 规范化掩盖测试。

## 评分依据

- `sdk-mgmt-surface` **5.4**：canonical、fixture、per-pair view、共享 `ts/generation`、错误矩阵文档和 e17/e18 证据质量较高；但核心 disconnect 在新支持的 mixed-fabric endpoint 输入上丢审计条目，且 status wire 漂移，需修复后再谈实现 GO。
- `webui-console` **8.8**：新增安全/资源/失败态场景均已进入 `specs/webui`，strict 校验通过；扣分来自资源上限合并场景和错误 wire/原始路径的可测性细节，属于 P2 设计收口。

