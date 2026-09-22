# OpenDWeb 设计复审 r2：sdk-mgmt-surface / webui-console

评审对象：`openspec/changes/sdk-mgmt-surface/`、`openspec/changes/webui-console/`，以及登记用 `openspec/changes/webui-owner-console/`。

基线：worktree `sdk-mgmt-surface`，HEAD `af81762`（r1 修订，父提交 `f2aeb1c`）。本轮只复审设计文档、spec、tasks 与现有源码锚点；未把尚未实现的任务描述当成实现证据。

## 结论

| Change | 评分 | 判定 |
|---|---:|---|
| `sdk-mgmt-surface` | **6.8/10** | NEEDS-WORK |
| `webui-console` | **8.2/10** | GO |

`webui-owner-console` 仅是登记项（`skip_specs: true`，proposal 明确未排期、未设计），
因此没有可审的 capability contract，不计入两项实现 change 的评分或总判定；其状态单列于下文。

总判定：**NEEDS-WORK**。`webui-console` 的 r1 阻塞项已基本闭合；`sdk-mgmt-surface` 仍有一个发布形态 P0、一个回执契约精化项，以及既有错误 envelope 迁移未闭合的 P1。webui 另有一项入站代理路径规范化的 P1 实现门。

## r1 处置核对

### sdk-mgmt-surface

- **P0-1 canonical：已解决大半，但未完全闭合。** 新 design/spec 统一为 `domain || op || fabric_id || target32 || ts || generation`，disconnect 用 `target` 槽承载 endpoint，并要求每目标一张回执（[design.md:36](../openspec/changes/sdk-mgmt-surface/design.md:36)、[design.md:76](../openspec/changes/sdk-mgmt-surface/design.md:76)、[spec.md:29](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:29)）。与现有实现的 `receipt_canonical` 参数顺序一致（[admin.rs:360](../crates/dweb-server/src/access/admin.rs:360)–[admin.rs:377](../crates/dweb-server/src/access/admin.rs:377)）。
- **P0-2 mode/relay：已解决。** spec 明确 `mode` 来自 access 配置、`relay_enabled` 独立；restricted + 无 relay 仍为 restricted 且空投影（[spec.md:15](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:15)、[spec.md:24](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:24)、[spec.md:46](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:46)）。这与当前 `main.rs` 只有 open 才使用 `gate=None` 的事实相符（[main.rs:343](../crates/dweb-server/src/main.rs:343)、[main.rs:394](../crates/dweb-server/src/main.rs:394)）。
- **P0-4 subpath 发布/隔离：隔离与 pack 门已补齐，但引入新的模块格式 P0。** 手写 ESM `.js` + `.d.ts`、`files` 增目录、禁止传递 import root/net/http、pack 后无 `.node` self-reference 双门禁均已写入（[design.md:103](../openspec/changes/sdk-mgmt-surface/design.md:103)–[design.md:114](../openspec/changes/sdk-mgmt-surface/design.md:114)、[tasks.md:28](../openspec/changes/sdk-mgmt-surface/tasks.md:28)–[tasks.md:38](../openspec/changes/sdk-mgmt-surface/tasks.md:38)）。当前 package 仍只有旧五个 exports/files（[package.json:8](../packages/client-sdk/package.json:8)–[package.json:57](../packages/client-sdk/package.json:57)），目录尚未实现本身是待实现门；但 `.js` 在现有 CommonJS package scope 下不可按该设计直接运行，见 r2-P0-1。
- **P1-1 404 双语义：判别策略已改正确，但既有实现迁移未闭合。** 文档以 `GET /admin/status` 探测为唯一未启用判别，并冻结业务 error envelope（[design.md:88](../openspec/changes/sdk-mgmt-surface/design.md:88)–[design.md:93](../openspec/changes/sdk-mgmt-surface/design.md:93)、[spec.md:27](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:27)）。但当前 `error_response` 仍输出 `{"error":"unauthorized"}`，现有测试也断言字符串（[admin.rs:156](../crates/dweb-server/src/access/admin.rs:156)、[admin.rs:565](../crates/dweb-server/src/access/admin.rs:565)）。tasks 有改造项（[tasks.md:8](../openspec/changes/sdk-mgmt-surface/tasks.md:8)），故属于实现收口风险，不是新的设计矛盾。
- **P1-2 disconnect 收敛：已解决。** 新 spec 明确异步 `start_shutdown`、best-effort 与 ≤5s 有界轮询（[spec.md:25](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:25)、[spec.md:56](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:56)）。这符合现有 shutdown/guard 生命周期（[admin.rs:319](../crates/dweb-server/src/access/admin.rs:319)–[admin.rs:345](../crates/dweb-server/src/access/admin.rs:345)、[gate.rs:377](../crates/dweb-server/src/access/gate.rs:377)–[gate.rs:383](../crates/dweb-server/src/access/gate.rs:383)）。
- **P1-3 app-protocol-layer 避让：已从“互不相交”修正为共享 owner 协议。** rebase 后以合入快照增量追加，最终 exports 全集断言均已写入（[design.md:145](../openspec/changes/sdk-mgmt-surface/design.md:145)–[design.md:157](../openspec/changes/sdk-mgmt-surface/design.md:157)、[tasks.md:32](../openspec/changes/sdk-mgmt-surface/tasks.md:32)–[tasks.md:38](../openspec/changes/sdk-mgmt-surface/tasks.md:38)）。与并行 change 已冻结的五个 subpath/pack 门一致（[app-protocol-layer/tasks.md:83](../openspec/changes/app-protocol-layer/tasks.md:83)–[app-protocol-layer/tasks.md:86](../openspec/changes/app-protocol-layer/tasks.md:86)）。
- **P1-4 wire：已解决。** connections、disconnect、receipt JSON 示例均改为 snake_case，并定义未知字段忽略、排序和空投影（[spec.md:11](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:11)–[spec.md:24](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:24)）。
- **P1-5/P1-6：已解决。** target 守卫矩阵、解析 IP 连接/SNI、禁止 redirect/env proxy、`--allow-insecure` 仅放宽加密，以及 argv/env 可见性披露和 TTY/配对推荐均已冻结（[webui design.md:70](../openspec/changes/webui-console/design.md:70)–[webui design.md:83](../openspec/changes/webui-console/design.md:83)、[webui spec.md:9](../openspec/changes/webui-console/specs/webui/spec.md:9)、[webui spec.md:11](../openspec/changes/webui-console/specs/webui/spec.md:11)）。
- **P1-7：已解决。** plugin contract 不扩展，run envelope 与实测实现一致 `{command,args,log,cwd,stdout,stderr}`（[webui design.md:93](../openspec/changes/webui-console/design.md:93)–[webui design.md:116](../openspec/changes/webui-console/design.md:116)；[plugin-contract.mjs:88](../packages/opendweb/src/plugin-contract.mjs:88)–[plugin-contract.mjs:114](../packages/opendweb/src/plugin-contract.mjs:114)）。
- **P1-8：已解决。** webui-console 已移除 Owner 控制台与 Phase B，改为独立登记 change；新 proposal 明确未排期、未设计（[webui-console/spec.md:57](../openspec/changes/webui-console/specs/webui/spec.md:57)、[webui-owner-console/proposal.md:3](../openspec/changes/webui-owner-console/proposal.md:3)–[webui-owner-console/proposal.md:6](../openspec/changes/webui-owner-console/proposal.md:6)）。

### webui-console

- `/api/session` 动态改目标路径已移除；配对面物理分离到 `/sidecar/connect`，setup→ready→退出状态机、一次性 10 分钟配对码、五次失败销毁、Host/Origin 校验和目标冻结均已写入（[webui design.md:51](../openspec/changes/webui-console/design.md:51)–[webui design.md:68](../openspec/changes/webui-console/design.md:68)、[webui spec.md:7](../openspec/changes/webui-console/specs/webui/spec.md:7)）。
- `/api/*` 仅代理 `/admin/` 且限制 GET/POST/DELETE；setup 返回 503 `no-target`；不跟随重定向、不读代理变量（[webui design.md:85](../openspec/changes/webui-console/design.md:85)–[webui design.md:91](../openspec/changes/webui-console/design.md:91)、[webui spec.md:5](../openspec/changes/webui-console/specs/webui/spec.md:5)）。
- plugin JSON Schema 子集参数已明确由 CLI 自担 URL/port/互斥/安全校验，不再把 schema 当安全边界（[webui design.md:112](../openspec/changes/webui-console/design.md:112)–[webui design.md:116](../openspec/changes/webui-console/design.md:116)）。
- Server 视图已保留可测的 status/owners/connections/disconnect 场景，并删除原不可独立测量的 native Owner console；新登记 change 使用 `skip_specs: true`，严格校验也明确其为无 spec 行为变更（`openspec validate --strict webui-owner-console` 通过）。

## P0 阻塞问题

### r2-P0-1 `./admin` / `./token` 的 ESM `.js` 与现有 package 模块格式冲突

修订 design 明确要求手写 ESM `.js`，并把 exports 的 `default` 指向 `./admin/index.js`、`./token/index.js`（[design.md:103](../openspec/changes/sdk-mgmt-surface/design.md:103)–[design.md:109](../openspec/changes/sdk-mgmt-surface/design.md:109)）。但 `packages/client-sdk/package.json` 没有 `"type": "module"`，现有 root `index.js` 使用 `module.exports`，`net/index.js` 也直接 `require("../index.js")`（[package.json:1](../packages/client-sdk/package.json:1)–[package.json:16](../packages/client-sdk/package.json:16)、[index.js:1](../packages/client-sdk/index.js:1)–[index.js:27](../packages/client-sdk/index.js:27)、[net/index.js:1](../packages/client-sdk/net/index.js:1)–[net/index.js:6](../packages/client-sdk/net/index.js:6)）。在当前 package scope 中 `.js` 按 CommonJS 解析；写 ESM `export` 会在 import 时失败，而全局改成 module 又会破坏既有 native 主入口与五个旧 subpath。

可验证修复：二选一并写入 spec/tasks：使用 `.mjs` 作为纯 ESM entrypoint 并在 exports/types 指向它，或使用 CommonJS `.js`（`module.exports`）并同步删除“ESM”要求；也可明确为两个目录各自携带 `package.json` 的 `type: module`，并证明旧 exports 不受影响。随后在无 `.node` 的干净 `npm pack` 解包目录分别实测 `import`、`require` 与类型检查；不能仅以文件存在性门禁代替模块格式门禁。

### r2-P1-1 disconnect receipt 的 `fabric_id` 快照规则未冻结

新 canonical 必须签入 32B `fabric_id`，并要求每个被断 endpoint 一张回执（[sdk design.md:76](../openspec/changes/sdk-mgmt-surface/design.md:76)–[sdk design.md:80](../openspec/changes/sdk-mgmt-surface/design.md:80)、[server spec.md:29](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:29)）。但 disconnect 请求既可只给 `endpoint_id`，响应/receipt 仍强制返回 `fabric_id`（[server spec.md:25](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:25)、[server spec.md:29](../openspec/changes/sdk-mgmt-surface/spec.md:29)）。文档没有冻结：按 endpoint 命中时 fabric_id 从哪个快照字段取得、在线 endpoint 关联多个 fabric 时如何判定、按 fabric_id 命中多个 endpoint 时 generation/timestamp 是否每 endpoint 相同，以及 relay 未启用/ open 模式空报告时 receipts 是否必须为空。

源码锚点显示 gate 当前确实有 `OnlineView.per_endpoint` 的 fabric 绑定（[gate.rs:136](../crates/dweb-server/src/access/gate.rs:136)–[gate.rs:148](../crates/dweb-server/src/access/gate.rs:148)），但这是实现内部结构，并未成为 disconnect wire/canonical 的冻结输入；`Clients::disconnect` 只按 endpoint/connection 操作（[admin.rs:319](../crates/dweb-server/src/access/admin.rs:319)–[admin.rs:345](../crates/dweb-server/src/access/admin.rs:345)）。若不冻结该映射与快照规则，Rust/TS 对拍仍可能产生不同 fabric_id 或漏签对象。

可验证修复：在 server spec/design 中增加明确规则：先取得单次 `OnlineView` 快照；按 endpoint_id 取唯一 `{endpoint_id,fabric_id,connections}`；按 fabric_id 按 endpoint_id 字典序展开；每个命中条目使用该快照 fabric_id、独立（或明确共享）ts/generation；snapshot 无条目即 `no-match`；open/restricted+无 relay 200 时 receipts 必为空。把该输入/排序写入 `CROSS_CRATE_RECEIPT_VECTOR`，并在 SDK spec 固定多目标 fabric_id 场景。

## P1 建议与实现门

### r2-P1-2 既有错误响应仍不符合新 envelope，且“零变化”表述冲突

新契约要求所有管理面业务错误为 `{"error":{"code","message"}}`（[server spec.md:27](../openspec/changes/sdk-mgmt-surface/specs/server/spec.md:27)），但当前认证与 handler 仍输出单字符串（[admin.rs:145](../crates/dweb-server/src/access/admin.rs:145)、[admin.rs:156](../crates/dweb-server/src/access/admin.rs:156)–[admin.rs:175](../crates/dweb-server/src/access/admin.rs:175)），既有测试断言 `body["error"] == "unauthorized"`（[admin.rs:565](../crates/dweb-server/src/access/admin.rs:565)）。修复建议：实现 `ErrorEnvelope { error: { code, message } }`，为 401/400/500/JSON extractor 失败补统一 code，更新单测并在 sidecar 原样透传测试中断言 Content-Type 和 envelope。按当前代码直接实现会违反修订 spec。

另外，design §1.1 把既有面标为“实现零变化”（[sdk design.md:30](../openspec/changes/sdk-mgmt-surface/design.md:30)–[sdk design.md:35](../openspec/changes/sdk-mgmt-surface/design.md:35)），§1.2 又明确要改造既有 400/401 响应为 envelope（[sdk design.md:88](../openspec/changes/sdk-mgmt-surface/design.md:88)–[sdk design.md:93](../openspec/changes/sdk-mgmt-surface/design.md:93）。应将“零变化”改成“路由/成功 wire 不变，错误 body 版本化变更”，并在 proposal/spec 的兼容性说明中明确这是有意的 minor wire change。

### r2-P1-3 status 探测的 401/404/网络错误矩阵应冻结

`probeEnabled()` 被写成“404=未启用，200=已启用”（[sdk design.md:123](../openspec/changes/sdk-mgmt-surface/design.md:123)、[sdk node spec.md:7](../openspec/changes/sdk-mgmt-surface/spec.md:7)），但携带错误 token 访问已挂载 server 的 `/admin/status` 实际是 401（[admin.rs:132](../crates/dweb-server/src/access/admin.rs:132)–[admin.rs:147](../crates/dweb-server/src/access/admin.rs:147)），且代理可能返回 502/504 或连接超时。文档没有写 `probeEnabled()` 对 401、5xx、网络、超时的返回/抛错规则。修复建议：冻结 `200=true`、`404=admin-not-enabled`、`401=unauthorized`、其余 HTTP/网络/timeout 保持独立 `AdminError`，并增加 mock-fetch 与 sidecar e2e 矩阵；禁止把任意非 200 归为未启用。

### r2-P1-4 目标 URL 的“解析一次”与实际 HTTP 客户端绑定方式需写成可验证接口

文档要求所有 A/AAAA loopback、解析 IP 连接、Host/SNI 固定、禁止 redirect/env proxy（[webui design.md:70](../openspec/changes/webui-console/design.md:70)–[webui design.md:83](../openspec/changes/webui-console/design.md:83)），方向正确。但 Node `fetch` 默认并不天然提供“按指定解析 IP 连接同时保留原 Host/SNI”的单一开关；tasks 只列测试矩阵，未指定 custom `lookup`/dispatcher/Agent、TLS servername、IPv6 与 Host 端口的具体实现接口（[webui tasks.md:11](../openspec/changes/webui-console/tasks.md:11)–[webui tasks.md:16](../openspec/changes/webui-console/tasks.md:16)）。修复建议：设计冻结 `undici` dispatcher/自定义 connector（或标准库 `http[s].request`）接口，明确 `connect IP`、`Host`、TLS `servername`、IPv6 bracket 与连接池缓存键；为 DNS 变更、A/AAAA 混合、HTTPS SNI 和 redirect 做可注入测试。

### r2-P1-5 plugin manifest 的 token help 位置与解析行为需钉死

当前 schema 的 `description` 是命令级字符串，`renderPluginHelp` 才会输出它（[plugin-contract.mjs:127](../packages/opendweb/src/plugin-contract.mjs:127)–[plugin-contract.mjs:143](../packages/opendweb/src/plugin-contract.mjs:143)）。设计写“description 尾注”但没有冻结实际完整文案，也没有测试 `--token=value`、裸 token、boolean `--allow-insecure=false` 等 parser 行为（[webui design.md:102](../openspec/changes/webui-console/design.md:102)–[webui design.md:116](../openspec/changes/webui-console/design.md:116)）。修复建议：把安全告警 ASCII 文案作为 fixture，增加 help golden 与 CLI parser 矩阵；明确 token 不进入 `log`/错误字符串。

### r2-P1-6 app-protocol-layer 共享 owner 仍需合并态验证

修订已声明 rebase 后落盘和 exports 全集断言（[sdk design.md:149](../openspec/changes/sdk-mgmt-surface/design.md:149)–[sdk design.md:157](../openspec/changes/sdk-mgmt-surface/design.md:157)），这是正确处置，但当前提交仍未包含 app-protocol-layer 合并后的 package.json/pack 脚本；其只能证明流程约定，不能证明最终合并态无冲突。实现时必须在 app change 合入后重新执行全集 exports、pack、import/require/typecheck 三门。

### r2-P1-7 WebUI 代理入站路径的规范化与白名单测试未冻结

文档规定 `/api/x` 重写到 `/admin/x`，并要求仅允许 `/admin/` 前缀（[webui design.md:85](../openspec/changes/webui-console/design.md:85)–[webui design.md:91](../openspec/changes/webui-console/design.md:91)），但没有规定对浏览器传入的 raw path 先拒绝 dot-segment、编码斜杠/反斜杠，或在规范化后再次确认最终 path 仍在 `/admin/` 下。`target.mjs` 的路径守卫只保护配置的远端 base URL，不覆盖 `/api/*` 的每次入站请求（[webui design.md:70](../openspec/changes/webui-console/design.md:70)–[webui design.md:83](../openspec/changes/webui-console/design.md:83)）。现有 tasks 的白名单测试也只写“越界 404”，未钉住 `/api/../`、`/api/%2e%2e/`、编码分隔符与重复斜杠矩阵（[webui tasks.md:27](../openspec/changes/webui-console/tasks.md:27)–[webui tasks.md:29](../openspec/changes/webui-console/tasks.md:29)）。若先拼接再由 URL/HTTP 客户端规范化，可能把带 Bearer 的请求送到 `/admin/` 之外的远端路径。

可验证修复：冻结“raw path 仅允许 `/api/` + 单层 admin 相对路径”的解析函数；拒绝 `.`/`..`、percent-encoded slash/backslash/dot、空段/反斜杠等歧义输入；规范化后再次断言最终远端 pathname 以 `/admin/` 开头，并为每种矩阵增加 sidecar 单测，确认拒绝路径不会发出上游请求。

### r2-P1-8 webui owner-console 登记不应被误作可实现 change

`webui-owner-console` 的 `.openspec.yaml` 使用 `skip_specs: true`，strict 校验明确“zero deltas accepted”，proposal 也明确“未排期、未设计”（[.openspec.yaml:1](../openspec/changes/webui-owner-console/.openspec.yaml:1)、[proposal.md:3](../openspec/changes/webui-owner-console/proposal.md:3)–[proposal.md:6](../openspec/changes/webui-owner-console/proposal.md:6)）。这满足 r1 拆分要求；后续不得把该登记 proposal 当作 GO、独立实现评分，或把 `--data-dir` 当成本 change 已支持的 CLI 参数。

## P2 建议

- **P2-1 解析边界补齐。** target 守卫应明确 `localhost` 是否也必须走 DNS 全记录校验，并固定 IPv4-mapped IPv6、IPv6 zone id、尾点 hostname、默认端口和 Host header 的序列化；当前文档只列出字面 loopback/localhost 与 A/AAAA（[webui design.md:72](../openspec/changes/webui-console/design.md:72)–[webui design.md:80](../openspec/changes/webui-console/design.md:80)）。
- **P2-2 回执向量可复现。** `CROSS_CRATE_RECEIPT_VECTOR` 目前只规定“导出样例 + TS 消费”（[sdk design.md:134](../openspec/changes/sdk-mgmt-surface/design.md:134)–[sdk design.md:136](../openspec/changes/sdk-mgmt-surface/design.md:136)），未规定文件位置、生成命令、固定 key/时间/registry generation 或 CI 防漂移方式；建议把 fixture schema 与生成脚本列为任务，避免对拍向量随实现者本地时钟变化。
- **P2-3 代理响应/资源边界。** sidecar 已冻结 10s 超时与 hop-by-hop 头剥除，但未冻结上游响应体大小、重复/异常 Content-Length、压缩响应和连接池生命周期（[webui design.md:85](../openspec/changes/webui-console/design.md:85)–[webui design.md:91](../openspec/changes/webui-console/design.md:91)）。建议给 `/api/*` 增加有界 body、header allowlist 和 abort 后 socket 回收测试，防止管理面被大响应耗尽内存。
- **P2-4 UI 失败态验收。** webui spec 可测性已明显改善，但场景主要覆盖成功流程；`admin-not-enabled`、`unauthorized`、超时/网络断开和断连超时的 UI 状态仍只在 design 文字中出现（[webui design.md:125](../openspec/changes/webui-console/design.md:125)–[webui design.md:129](../openspec/changes/webui-console/design.md:129）。建议增加不依赖真实 server 的 fake sidecar/error fixture，明确“无错误风暴”与重启提示的可观察断言。

## 特别审视

1. **disconnect 404 双语义**：不再依赖空 body，status 探测 + 业务 `no-match` envelope 的方向稳健。仍需冻结 probe 的 401/5xx/网络矩阵；sidecar 原样透传不会改变语义，但反向代理测试必须覆盖 Content-Type/body 保留。
2. **`./admin` / `./token` 隔离**：设计规则成立，当前源码 package 尚未落目录/exports/files；pack 后无 `.node` import 与 `.d.ts` 自包含是必要且足够的第一道门，但必须防止任意共享 helper 反向 import root，并先解决 r2-P0-1 的 `.js` 模块格式冲突。
3. **sidecar token 边界**：单次配对码、10 分钟、五次失败销毁、127.0.0.1、Host/Origin、目标冻结、不跟重定向和不读代理已覆盖主要漏洞。接受残余是同用户恶意进程读内存/注入，文档已明示（[webui design.md:143](../openspec/changes/webui-console/design.md:143)–[webui design.md:145](../openspec/changes/webui-console/design.md:145)）。
4. **plugin 契约**：既有 schema 足以声明五个基础 flags；URL/port/互斥/secret 不能由 schema 表达，但修订明确由 cli 自担并测试，足够实现，不应再扩契约。
5. **webui specs 可测性**：Phase A 的 setup、target、白名单、status/owners/connections/disconnect 场景可独立测试；Owner 数据面已移至未排期 change，避免把不可测 native fixture 混入本 change。
6. **app-protocol-layer 文件级避让**：已诚实改成共享文件 owner/rebase 协议，不再声称物理互不相交；最终合并态仍需实测门禁。
7. **WebUI 代理白名单**：最终远端路径的 `/admin/` 前缀要求已写入，但入站 raw path 的规范化与拒绝矩阵仍需补齐，否则白名单安全性不能仅凭“前缀”文字验收。

## 验证记录

- `openspec validate --strict sdk-mgmt-surface`：通过。
- `openspec validate --strict webui-console`：通过。
- `openspec validate --strict webui-owner-console`：通过；工具提示 `skip_specs` 为零 spec delta。
- `git diff --check f2aeb1c..af81762 -- openspec/changes docs`：通过。
- 当前源码核对：`admin.rs` 仍是旧 `{"error":"..."}` envelope；`AdminState` 尚无 `relay_enabled`；`package.json` 尚无 `./admin`/`./token`，均属于尚未实现的任务状态，不能作为修订设计已落地证据。

## 评分依据

- `sdk-mgmt-surface`：canonical/mode/404 方向已明显改善，但 ESM `.js` 与当前 CommonJS package 直接冲突；disconnect receipt 的 fabric 快照规则和既有错误 envelope 迁移仍需实现门，故 6.8/10，NEEDS-WORK。
- `webui-console`：setup 配对面、目标冻结、URL 守卫、token 可见性、plugin envelope、Phase A 可测性均已闭合；Node DNS-to-connection 的具体 connector 仍是实现注意项，不足以阻塞设计，故 8.2/10，GO。
