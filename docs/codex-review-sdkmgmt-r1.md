# OpenDWeb 设计评审：sdk-mgmt-surface / webui-console

评审对象：`sdk-mgmt-surface`、`webui-console` 两个尚未实现的 OpenSpec change。

评审基线：worktree `sdk-mgmt-surface`，HEAD `f2aeb1c8d538240587cbe0a1224fa18051bb5f5c`。本次只评审设计/提案/spec/tasks，并以当前源码、已归档 `server-access-policy`、并行 `app-protocol-layer` 做事实核对。提交本身没有实现代码；`openspec validate --strict sdk-mgmt-surface` 与 `openspec validate --strict webui-console` 均通过，但这只证明文档结构有效，不证明语义或实现可行。

## 结论

总判定：**NEEDS-WORK**。

建议评分：

| Change | 评分 | 结论 |
|---|---:|---|
| `sdk-mgmt-surface` | **3.5/10** | NEEDS-WORK，存在未冻结且互相冲突的 HTTP/receipt/package 契约 |
| `webui-console` | **3.0/10** | NEEDS-WORK，sidecar 的运行时控制面与代理安全边界尚不可实现/验证 |

## P0 阻塞问题

### P0-1 `disconnect` 回执 canonical 在 design 与 spec 中互相矛盾

证据：当前实现的既有 canonical 是 `domain || op || fabric_id(32) || root(32) || ts || generation`（[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:360)–[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:377)）。新 design 却规定 disconnect 只签 `domain || 0x03 || ts || generation`（[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:80)–[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:84)），而 server spec 又要求所有 register/unregister/disconnect 都使用含 `fabric/root` 的 canonical（[server spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/specs/server/spec.md:14)）。JSON 形态也未冻结：design 示例是数值 `op`/hex `signature`/嵌套 `receipt`（[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:59)–[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:65)），既有 Rust 响应则是字符串 `op`、顶层 `receipt_sig`、base64url（[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:219)–[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:239)）。

影响：Rust、TS canonical 对拍和验签接口没有唯一答案；即使实现完成，也无法判断哪个 wire 是合规的。只签 `op+ts+generation` 还不能审计“具体断了谁”。

修复建议：在实现前冻结一个版本化 receipt schema：明确 `op` 类型、字段命名、签名编码、HTTP 包装层，并选择一种 canonical。建议 disconnect 至少绑定规范化 target（endpoint/fabric 或排序后的命中摘要），然后同步 server spec、SDK spec、design、fixture 和跨语言对拍测试。

### P0-2 relay 未启用时的 mode 投影与实际装配不符

证据：design 把 `gate = None` 解释为“open 模式或 relay 未启用”，并要求返回 `mode: open`（[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:51)–[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:55)）。实际 `main.rs` 先按 access mode 创建 gate：restricted 时无论 `relay_enabled` 与否都会构造并传入 `AdminState`（[main.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/main.rs:343)–[main.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/main.rs:395)、[main.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/main.rs:424)–[main.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/main.rs:447)）。只有 `AccessMode::Open` 才是 `gate=None`（[main.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/main.rs:394)–[main.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/main.rs:395)）。

影响：restricted + `--no-relay` 会被设计错误地投影成 open，客户端可能误以为验证链关闭；这违反“如实投影”，也会使配额/权限 UI 产生错误判断。

修复建议：把 `access_mode` 与 `relay_enabled` 分成两个显式字段；restricted + relay disabled 应保持 `mode: restricted`，另报 `relay: disabled`/`connectionStats: unavailable` 或空投影。不要用 `gate=None` 推导 mode。

### P0-3 sidecar 的 `/api/session` 与 `/api/* -> /admin/*` 规则冲突，并形成 token exfiltration/SSRF 路径

证据：sidecar 设计把所有 `/api/*` 重写到远端 `/admin/*`，并以 `/admin/` 白名单限制（[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:52)–[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:56)）；但同一文档又要求浏览器调用本地 `POST /api/session` 来更新 token 和 server URL（[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:103)–[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:117)）。spec 只规定 `/api/*` 反代和 token 来源，没有定义 `/api/session` 的本地路由、请求 schema、状态码、Origin/CSRF 或目标 URL 约束（[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/specs/webui/spec.md:3)–[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/specs/webui/spec.md:20)）。

若按现有白名单实现，`/api/session` 会被转成远端 `/admin/session`，功能不可达；若增设一个无本地鉴权的动态 session handler，则任意网页/本机进程都可把 sidecar 的目标改成攻击者控制的 URL，再诱使 sidecar 将内存中的 Bearer token 发出。仅绑定 `127.0.0.1` 不能阻止浏览器对 localhost 发请求；文档承认无本地鉴权（[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:130)–[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:132)）不等于可以接受 token 转发。

修复建议：将 `/api/session` 从代理路由物理隔离，优先固定 `--server`，不允许浏览器改变目标；若必须运行时配置，使用一次性随机本地授权码/严格 Origin 校验、固定允许的目标集合和 URL 规范化，且 session API 永不接受任意远端 URL。补齐 body/status/错误及 CSRF 测试，再谈 token 只驻内存。

### P0-4 新 subpath 未进入 npm 发布物，所谓 native 隔离尚未成立

证据：当前 root `index.js` 在加载时立即选择平台并读取/require `.node`（[client-sdk index.js](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/index.js:1)–[client-sdk index.js](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/index.js:27)）；已有 `./net` 直接 require root（[net/index.js](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/net/index.js:1)–[net/index.js](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/net/index.js:6)）。设计要求 `./admin`/`./token` 不传递性 import root（[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:100)–[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:112)），这在源码层可以做到，但 package `files` 当前只包含 `index`、`net`、`http` 和 native binaries，没有 `admin` 或 `token`（[package.json](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/package.json:50)–[package.json](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/package.json:57)）。

影响：即使新增 exports，`npm pack`/安装消费者仍拿不到新 entrypoints；“仅安装包且无 native binding 即可 import”场景必然失败。另有 `.js/.d.ts` 产物如何由“纯 TS 源码”生成的构建契约未定义。

修复建议：明确 CJS/ESM 输出和构建步骤；把 `admin/`、`token/` 的 `.js/.d.ts` 纳入 `files`；entrypoint 只依赖 Web 标准/API，禁止任何 root、`net`、`http` 传递 import；在干净临时目录执行 `npm pack` 后于无 `.node` 环境做 self-reference import/require/typecheck 三层门禁。

## P1 建议改进

### P1-1 404 双语义靠 body 约定不稳健

设计明确承认这是最脆契约：未挂载 admin 的 404 为空，disconnect 未命中改为 `{"error":"no-match"}`（[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:126)–[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:133)）。当前 `main.rs` 通过是否 merge admin router 控制挂载（[main.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/main.rs:484)–[main.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/main.rs:489)），Axum 默认未匹配路由并没有这个业务 body。中间代理还可以丢弃/重写 body，任意上游 404 也可能碰巧带同名 JSON。

建议用独立状态码（例如 admin 未启用保持 404，业务未命中用 409/410）或稳定的受保护错误头/错误 envelope，并把“代理剥离 body/Content-Type”纳入测试；不要把空 body 作为安全探测和业务判别的唯一信号。

### P1-2 disconnect 是异步 shutdown，不能承诺响应后立即视图收敛

当前注销路径调用 `Clients::disconnect`，源码注释明确是异步 `start_shutdown`，在线计数要等 `OnDisconnectGuard` 触发 `gate.on_disconnect` 才释放（[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:319)–[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:345)、[gate.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/gate.rs:377)–[gate.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/gate.rs:383)）。spec 却写成响应后下一次 GET 就“不再包含”（[server spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/specs/server/spec.md:36)–[server spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/specs/server/spec.md:39)）。

建议冻结为 best-effort/eventual convergence：响应区分 `requested`、`accepted`、`released`，或实现有界等待；测试使用 deadline/poll，而不是立即断言。

### P1-3 app-protocol-layer 文件级避让并不真实

sdk change 声称与 `./net`/`./http` 文件级互不相交（[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:100)–[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:110)），但两者都必须修改 `packages/client-sdk/package.json` exports/files/build 约定。并行 change 已把五个 subpath 和 npm pack 验收冻结在同一文件域（[app-protocol tasks](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/app-protocol-layer/tasks.md:83)–[app-protocol tasks](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/app-protocol-layer/tasks.md:86)）。

建议在两个 change 中显式声明 `package.json`/pack script/exports test 的共同 owner，定义合并顺序和最终完整 exports 快照；否则不是文件级避让，而是同文件并行改写。

### P1-4 admin API 的 wire 命名和状态投影未冻结

新 connections 示例使用 `mode/policy/quota/perOwner/perEndpoint` 及 camelCase（[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:38)–[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:49)），既有 `/admin/status` 则输出 snake_case `max_connections_per_owner/active_connections/per_owner_connections`（[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:389)–[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:455)）。SDK spec 也只写语义，不冻结 JSON 字段和未知字段策略。

建议在 server spec 中加入完整 JSON examples/schema，统一命名风格、`null`/空数组、排序、unknown fields 和 `Content-Type`，再生成 TS 类型。

### P1-5 sidecar 的 loopback/明文判断仍缺 DNS 与 URL 规范化边界

文档只写“非 https 且非 loopback”及 `127.0.0.1` 绑定（[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/specs/webui/spec.md:3)–[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/specs/webui/spec.md:20)），没有定义 `localhost`、IPv4-mapped IPv6、整数/八进制 IP、DNS rebinding、redirect、proxy env 和 encoded dot-segment 的处理。`/admin/` 前缀白名单也没有规定 URL path canonicalization（[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:52)–[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:56)）。

建议只允许绝对 `http(s)` URL，解析后按 IP 字节判断 loopback/private/link-local/metadata，默认不跟随 redirect，禁用环境代理，拒绝 dot-segment/编码斜杠，并对 DNS 解析与连接目标做明确策略。`--allow-insecure` 必须只放宽传输加密，不放宽目标/路径安全。

### P1-6 token 边界没有覆盖 argv/env 的 OS 可见性

spec 允许 `--token` 和 `DWEB_ADMIN_TOKEN`（[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/specs/webui/spec.md:3)–[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/specs/webui/spec.md:5)），但“只在 sidecar 内存”只排除了文件、浏览器响应和日志，并未说明 shell history、`ps`、崩溃转储、同用户 `/proc`/环境读取。设计还把粘贴 token 的浏览器表单作为避免命令行泄露的理由（[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:114)–[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:117)），但没有把风险写入契约。

建议把 `--token` 标为不推荐/显式泄露警告，优先 stdin/TTY，明确本机同用户威胁模型；不要把“内存驻留”表述成完整秘密边界。

### P1-7 plugin JSON Schema 子集够解析 flags，但不足以承载安全/语义契约

当前契约只支持 `object + properties + string/number/boolean + required`（[plugin-contract.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/opendweb/src/plugin-contract.mjs:8)–[plugin-contract.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/opendweb/src/plugin-contract.mjs:18)），运行时只把解析后的 envelope 交给 `run`（[plugin-contract.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/opendweb/src/plugin-contract.mjs:88)–[plugin-contract.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/opendweb/src/plugin-contract.mjs:114)）。它可以表达本 change 的六个基础参数，但不能表达 URL format、port range/integer、default、secret/no-echo、互斥条件、重复参数或环境来源。设计中的 `run: async (args) => main(args)` 还没有说明 `args` 是完整 dispatch context 还是内层参数对象。

建议至少冻结 `format/secret/default/minimum/integer` 中实际需要的子集，并把 token 的 secret 语义放入 help/log/argv 处理；明确 `run({command,args,...})` 的调用形态。若坚持不扩展，必须把所有校验和“不打印 token”责任写进 webui CLI spec 与测试。

### P1-8 WebUI Phase B 的 capability 场景不可独立测量

Phase B 同时承担 native fabric 打开/附加、root/member 权限矩阵、邀请签发、token 解码、撤销和 TTL 高亮（[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/specs/webui/spec.md:55)–[webui spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/specs/webui/spec.md:67)），但没有定义 data-dir fixture、FabricOptions、身份来源、接口路径、错误码、角色判定或可注入时钟。当前 SDK 确实提供 `Fabric.createRoot/open/attach`、`members/invite/revoke/ensureRelayCapabilities`（[index.d.ts](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/index.d.ts:41)–[index.d.ts](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/index.d.ts:102)），但 spec 没有把这些 API 映射为可测的 sidecar contract。

建议把 Phase B 拆成独立 change，先冻结 sidecar JSON API 和 fixture（root/member/缺失 native/损坏 roster），用 fake clock 测 `<7d`，再做 UI 场景；当前 change 至少应把 Phase A 与 B 分开评分/门禁。

## P2 建议

1. disconnect 响应只签 `op+ts+generation` 的方案不包含目标明细；即使 P0 wire 冲突修正，也应增加 target digest 或明确“审计仅证明动作发生，不证明对象”。
2. `--server` 在 manifest 中不是 required（[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:80)–[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:91)），但缺失时的默认/错误行为未写入 spec；应明确拒绝并给出无 token 泄露的错误。
3. 既有 admin/status 已包含在线投影（[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:387)–[admin.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/admin.rs:455)），新 connections API 的职责应明确为兼容 alias、不同粒度还是新 wire，避免 SDK 重复抽象。
4. 设计中“可选但默认做”的 TS e2e 与“Owner 视觉走查”没有统一收口证据格式（[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:159)–[sdk-mgmt design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/sdk-mgmt-surface/design.md:166)、[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:136)–[webui design](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-console/design.md:142)）；应规定哪些是实现门、哪些只是 Owner 验收证据。

## 特别审视结论

1. **404 双语义**：直接同进程 Axum 场景可用“空 body vs `{"error":"no-match"}`”，但跨代理不稳健；应改成独立 status/error code，见 P1-1。
2. **`./admin`/`./token` 隔离**：禁止传递 import root 的源码约束是正确方向，但当前 `package.json.files` 未发布新目录，且 build/模块格式未冻结；发布后隔离尚未成立，见 P0-4。
3. **sidecar token/明文/127.0.0.1**：明文公网双告警方向正确，但 loopback 绑定不是本地鉴权；动态 `/api/session` 使浏览器可改变目标并潜在外送 token，见 P0-3/P1-5。`--token`/env 还有 argv/环境可见性，见 P1-6。
4. **plugin 契约**：现有 JSON Schema 子集足以描述六个基础 flag，但不足以表达 secret、URL/port 约束和运行时 envelope；是否“够用”取决于把这些责任移入 CLI，并补齐契约，见 P1-7。
5. **webui capability 可测性**：Phase A 有可落地的 server API 场景；Phase B 缺少 sidecar wire、身份 fixture 和时间控制，当前不可独立验收，见 P1-8。
6. **app-protocol-layer 避让**：`./net`/`./http` 源文件可以分目录，但 `packages/client-sdk/package.json`、pack/build 和 exports tests 是共享修改面；“文件级互不相交”不成立，见 P1-3。

## 收口建议

先修正 P0-1 至 P0-4，并在文档中冻结完整 wire/schema 与 sidecar session 安全边界；再以 P1-1 至 P1-8 的可测性和共同文件 owner 方案为实现门。当前不建议进入实现阶段，也不建议把两个 change 标记为 GO。
