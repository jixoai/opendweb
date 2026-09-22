# Tasks: sdk-mgmt-surface

> r1 修订：按 codex-review-sdkmgmt-r1 处置重排（envelope/回执 per-target/
> mode 拆分/pack 门禁/共享面协议/最终 exports 全集断言）。

## Phase 1 — Rust：admin API 扩面

- [ ] 1.1 错误 envelope 改造：既有 400/401 响应统一 `{"error":{code,message}}`
       （AdminError Display→envelope 映射；spec 场景钉住）
- [ ] 1.2 AdminState 增存 `relay_enabled`（main.rs 装配处注入）；connections
       投影 mode 取配置字段（禁止 gate 句柄推导）
- [ ] 1.3 抽取共享断连函数（unregister 内联路径重构，行为零变化）；新增
       `POST /admin/connections/disconnect`（恰好其一 + deny_unknown_fields
       →400 envelope；命中 → per-target 回执数组 op=0x03；未命中 404
       no-match envelope；relay 未启用 200 空报告）
- [ ] 1.4 `GET /admin/connections`（snake_case wire 按 spec JSON 示例冻结；
       per_endpoint endpoint_id 字典序；quota 结构）
- [ ] 1.5 回执 canonical 冻结向量导出：CROSS_CRATE_RECEIPT_VECTOR（含
       disconnect per-target 样例：canonical bytes + JSON wire；供 TS 对拍）
- [ ] 1.6 Rust 单测：disconnect 请求体矩阵、restricted+无 relay 投影、open
       空投影、未命中 envelope、op3 canonical
- [ ] 1.7 Rust e2e：restricted + 真实 relay 连接 → connections 计数 →
       disconnect → 有界轮询（≤5s）收敛 + 回执 ServerIdentity 验签
- [ ] 1.8 绿门：`mbx test -p dweb-server --bins` + e2e + clippy/fmt

## Phase 2 — TS：./admin subpath

- [ ] 2.1 `packages/client-sdk/admin/`（手写 ESM .js + .d.ts：AdminClient +
       probeEnabled + AdminError code 表 + receipt 透出 + receiptCanonical +
       verifyReceipt 注入式 + adminPublicKeyFromServices；禁 import root/
       net/http）
- [ ] 2.2 exports/files 增量（**rebase 后落盘**：以 app-protocol-layer 已合入
       快照为基线追加 ./admin ./token；最终全集 = . /net /net/internals
       /http /http/internals /admin /token，作为完成态断言）
- [ ] 2.3 单测：mock fetch 全 code 路径（probeEnabled 分流 no-match/
       not-enabled）、超时、receiptCanonical 对拍 CROSS_CRATE_RECEIPT_VECTOR
- [ ] 2.4 pack 门禁：干净 tmp 目录 npm pack → 安装 → 无 .node 环境
       self-reference import + tsc 类型检查（脚本化，两 change 共用）

## Phase 3 — TS：./token subpath

- [ ] 3.1 `packages/client-sdk/token/`（decodeInvite/decodeCapability + 位图
       展开 + TokenError；同 2.1 隔离规则）
- [ ] 3.2 invite 跨语言冻结向量（Rust 导出 + TS 消费）；cap 复用
       CROSS_CRATE_CAP_VECTOR
- [ ] 3.3 单测：冻结对拍 + 非法输入矩阵

## Phase 4 — 收口

- [ ] 4.1 TS e2e：AdminClient 打真实本地 server（与 1.7 同场景复用）
- [ ] 4.2 README subpath 说明（用法 + token 安全注意 + receiptCanonical
       验签示例）
- [ ] 4.3 绿门总收口 + openspec strict 校验
- [ ] 4.4 Owner 走查证据（演示记录，非实现门）
