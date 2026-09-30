# webui-plugin-kernel 实现终审补审 r11

## 范围与证据

核对基线为 r10 GO 的 `c66e12c`，HEAD 为 `74e4ce6`；审查 `aae19fa` 与 `74e4ce6` 的源码、ports delta、回归测试和提交回执。未停止双机进程，未重跑重型 Cargo/全仓门禁。

- 本轮前序窄测：`body-integrity.test.mjs` 5/5、`http-lifecycle.test.mjs` 7/7；`git diff --check c66e12c...HEAD` 通过。
- Owner 提供的当日门禁：fabric 317/0、ext-ports 43/43、webui 262/262、client-sdk 96/96，`.node` 双端 md5 一致并 dlopen。未在本轮重跑，按供应回执记录。
- 新增采样为 Owner 供应数据：mini `19090`，100 次×3 秒，99 次正常、#58 一次 `200:0`；称修复前该形态约 20–30%，修复后约 1%。`/tmp/wpk-mini-sidecar.log` 在当前工作区不可读取，33 行日志未独立复核。

## 阻塞问题

**B1 — abort 仍可能被转换为干净 FIN，P1。** `StreamWriterJs::abort` 先丢弃 body sender，再 best-effort 发送 RESET（[http.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/src/http.rs:767)；[session.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/session.rs:1014)）。provider dispatch 将 `body.recv() == None` 当正常 EOF 并调用 `finish`（[http.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/http.rs:668)）。RESET 发送失败时没有跨恢复代持久化的 abort 状态；即使 RESET 成功，FIN/RESET 竞速也允许消费端先观察 FIN。结果是客户端可在 RESET 到达前以 `null` 收尾并发出空/截断 200。修复应让取消终态在流状态机中先于 sender 关闭原子落位、跨恢复保留，并禁止 dispatch 对已取消供给发送 FIN。增加真实 N-API 集成用例覆盖 active 下 FIN/RESET 交错与 Recovering 下 RESET 失败后恢复，断言预头失败为 502、已发头时连接失败，绝无干净 200。

**B2 — 接收错误仍可冒充干净 EOF，P1。** `body_next()` 只有 `peer_reset` 已置位时才报错，其他 `recv_body()` 错误一律返回 `null`（[http.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/src/http.rs:124)）。但内核 gap/队列超限/overlap mismatch 路径设置 `remote_final` 并发回 RESET，不设置本地 `peer_reset`；`recv()` 因而返回与 FIN 共用的 `stream ended`（[session.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/session.rs:1403)、[session.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/session.rs:1493)、[session.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/session.rs:1202)）。ports proxy 对 `null` 当干净 EOF 并 `res.end()`；只有抛错才记 `upstream-body-lost`（[proxy.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/opendweb-ext-ports/src/proxy.mjs:461)）。因此采样窗口没有该日志不能排除体传输失败，反而与这条漏报路径相容。修复应在内核保存终止原因（FIN / RESET / 本地协议错误 / 会话丢失）并透传到 N-API；只有 FIN 才返回 `null`。对协议错误、会话终止和 RESET 增加原生端到端测试，断言代理不是干净 EOF。

**B3 — 聚合读取器也吞掉 body 错误，P1。** `HttpClientResponse::read_all_body()` 把任意 `recv_body()` 错误当作成功并返回已有前缀（[http.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/http.rs:275)）；`RequestBody::read_all()` 有相同模式（[http.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/http.rs:84)）。调用者无法区分完整实体与截断前缀。仅将消费错误改成类型化终态仍不足以闭合整个 ABI：聚合 API 必须在异常终止时返回 `Err`，并测试“已有前缀后 RESET/会话丢失”不返回成功。

**B4 — 阶段 A 取消未覆盖活性等待与请求发出前，P1。** `fetch_http()` 的 dead-channel 等待循环没有观察 `init.cancel`；离开循环后会先 `OPEN`、发送请求体并 `FIN`，直到等响应头才检查取消（[http.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/http.rs:321)、[http.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/http.rs:362)、[http.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-fabric/src/continuity/http.rs:405)）。下游断开期间若会话 Recovering，取消会延迟至恢复/超时，且可能在 RESET 前触发 provider handler。另，活性闸门与响应头等待分别创建完整 `head_timeout` deadline，和代码注释所称“共享同一预算”不符。修复应在活性等待中 select 取消，并在 OPEN/请求体写入前后设置线性化取消检查；整次 head 操作用一个 deadline。测试需在 Recovering 闸门中取消，断言即时结算、provider handler 零启动，及总等待不超过单一配置预算。

## 非阻塞改进

- [provider.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/opendweb-ext-ports/src/provider.mjs:144) 与 [index.js](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/client-sdk/http/index.js:178) 在 native writer 缺少 `abort()` 时回退 `finish()`，重新引入“取消=干净 EOF”；provider 同处还保留旧的 `finish` 描述（[provider.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/opendweb-ext-ports/src/provider.mjs:131)）。当前随附 `.node` 声称已包含 abort 面，因此列为兼容边界清理：移除静默回退，缺 ABI 时明确失败，并删除矛盾注释。
- E1′-① 仍可作为后置 change 首位，但必须独立跟踪。体验表述建议：长流量后 sidecar 进程内出站拨号可能停滞，设备间数据面重连需重启 sidecar；这影响持续使用可用性。当前证据不能把它作为本次 `200:0` 的解释。

## Standards

发现 1 项与全局“默认不做向下兼容、禁止胶水回退”规则相悖的行为（[AGENTS.md](/Users/kzf/.agents/AGENTS.md:24)）：缺失 `abort()` 时降级为 `finish()`；另有 1 处相互矛盾的旧注释。当前精确发布包若确实固定搭配已验证的 native 二进制，属于非阻塞清理；不得将该回退称为满足取消语义。

## Spec

ports delta 明确要求传输失败必须以错误而非干净 EOF 终结，并规定上游截断不得以 200 外显（[spec.md](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/webui-plugin-kernel/specs/plugins/ports/spec.md:39)）。B1–B4 分别覆盖 abort 终态、错误分类、聚合读取和阶段 A 取消的缺口。

## 采样判定

99/100 成功说明主导故障路径显著改善；1/100 的异常仍是有效性告警，不构成可接受的放行门槛。单次样本不能独立证明 B1 或 B2 是该次根因，也不能估计长期真实故障率。Owner 描述的 `session init rejected reason=1 / owner terminated` 属早前重连噪声，未与 #58 同窗对应；它既不能定因，也不能排除 `null` 被当成正常 EOF 的路径。“不记录 `upstream-body-lost`”不为实现背书，因为仅在 bodyNext 抛错时才会生成该日志，而 B1/B2 都能把失败折成 `null`。在 probe 对应请求预期非空这一前提下，异常 `200:0` 直接违反 ports 的体完整性约束；不能按后置风险归档。

## 评分与结论

**评分：8.2/10（r10：9.2/10，-1.0）。** `aae19fa` 的死通道活性闸门针对已证实的错误交付路径，代码修改直接且边界有限；74e4ce6 的代理头延迟、错误处理和会话缓存保留修复了主导路径，窄测及供应的双机采样也显示异常明显下降。扣分来自 body EOF 仍不能在所有终止路径上证明完整性、取消可竞争为 FIN、阶段 A 取消可能晚于请求副作用，以及当前百次采样仍见一例异常。

**最终结论：NOT-READY。** archive 前最小闭合：B1–B4 的语义修复与点名原生集成测试；随后重跑当前 focused gates，并对预期非空 probe 做确定性中断/恢复矩阵，要求异常终态均为 502 或连接失败、零 `200:0`。15 分钟稳定性采样若仍被 E1′-① 阻断，应如实记录为后置可用性债，不能替代体完整性门。

Standards 轴：1 项非阻塞兼容/注释问题；Spec 轴：4 项 P1 缺口，最严重为失败体被映射成成功 EOF。
