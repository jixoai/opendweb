# webui-plugin-kernel 实现终审 r7

## 结论摘要

**结论：NOT-READY。**

当前实现已经完成了大部分内核修复，真双机实录也捕获并修复了多类单机测试无法覆盖的连接缺陷。但归档前仍有三个可验证阻塞项：

1. [W12] 只进入设计提案，没有进入默认配置和 WebUI 接线；当前数据面仍会自动使用 hub 的 HTTP-only relay。
2. shutdown 的 5 秒限制是多个串行阶段各自重新起算，不是全局 5 秒 deadline；包含 direct endpoint 1 秒、主 endpoint 5 秒及四个收尾阶段时，最坏路径约 26 秒。
3. sync push 的取消、组级并发预算和持久 staging 语义未闭合，存在取消后仍推进 ref、无限并发大 push 以及“staging 目录实际为空”的实现偏差。

本轮没有重跑全套门禁，也没有启动、终止或干扰 iMac/Mac mini 进程。全套测试数字标为 Owner 提供的当日 receipt；另独立运行 ext-sync endpoint 单文件 8/8，通过 `git diff --check`。源码结论来自当前工作区静态核对。

## 阻塞问题

### B1 — [W12] direct-only 架构裁决未落地

**证据**

- 设计实录已经给出明确实证：hub relay 只能注册，不能转发端点间 QUIC 数据；relay 配置会导致 relay-first 停滞；disabled-relay 2.3s，而 relay 配置会达到 115s 超时，见 [design.md §9.1](../openspec/changes/webui-plugin-kernel/design.md:364)。
- Rust 默认仍为 `RelayConfig::N0Default`：[fabric.rs](../crates/dweb-fabric/src/fabric.rs:284)。
- SDK 未提供 relay 配置时仍转换为 N0：[client-sdk/src/fabric.rs](../packages/client-sdk/src/fabric.rs:215)。
- WebUI `startSequence()` 和 `joinWithToken()` 都把租约 relay 装配为 `mode: "custom"`：[fabric.mjs](../packages/webui/src/core/fabric.mjs:327)、[fabric.mjs](../packages/webui/src/core/fabric.mjs:579)。

因此“数据面默认 Disabled、hub relay 仅作访问/发现面”现在仍是文档中的推荐，不是运行时事实。已有 8 秒拨号上界、罚期和 scratch direct endpoint 只能缓解毒 relay，不能消除默认候选污染。

**可验证修复**

- Fabric/SDK 的缺省 relay 改为 `Disabled`；N0 或 custom relay 只能由调用方显式 opt-in。
- WebUI 不得把租约 relay 自动放进数据面；直接依赖 invite 的 `advertiseAddrs` 和持久 `known_addrs` 发现。
- `RelayConfig::Disabled` 下 join/connect 的地址合并也必须过滤 invite 与 learned 中的 relay URL；仅不追加本地 relay 不够，否则 HTTP-only relay 仍可能从 `endpoint_addr_from_invite(_v2)` 进入拨号地址。
- `startSequence()`/`joinWithToken()` 还需把“管理面租约存在”与“数据面 relay 候选”解耦：已有 roster + known_addrs 的设备不能因为没有可用 `relay_url` 就在进入 direct-only 数据面前被 `no-lease` 门挡住；若产品仍要求 hub 租约作为管理面前置，必须在规范中明确这个边界并给出稳定错误，而不是把它伪装成 relay 数据面依赖。
- root 的 relay capability ensure/coverage 只在显式 relay 数据面模式执行；direct-only 模式跳过。
- 在 session/known-addrs 规范中明确：HTTP-only hub relay 不是数据面 relay；真正 QUIC/TLS relay 由后续独立 change 开放。
- 增加“默认配置不产生 relay 数据面接触、显式 custom relay 仍可用、direct-only 双机 pairing 200”的测试和 receipt。

**[W12] 裁定**

我 **approve W12，但附带上述边界修订**：当前产品形态应采用 direct-only 默认；HTTP-only hub 只保留租约、注册和发现面；server 端补齐 QUIC/TLS 后再以独立 change 开放 relay。W12 未落地前不能归档或给实现 GO。

这里不建议当前做“混合默认”：只要 HTTP-only 地址仍进入同一 relay 候选池，relay-first/已连接但不转发的毒路径仍会复现。后续 QUIC/TLS relay 也不是把一个端口打开即可，至少要同时冻结 UDP/QUIC 监听与地址发现、证书/信任链、restricted capability 在 QUIC 握手的准入、部署防火墙和双机 failover 矩阵；因此应作为独立 change 的显式 opt-in，完成后再扩大默认拓扑。

### B2 — shutdown 不是全局 5 秒有界

`close_endpoint_bounded()` 自身给 direct-dial endpoint 1 秒、主 endpoint 5 秒的独立预算：[fabric.rs](../crates/dweb-fabric/src/fabric.rs:919)、[fabric.rs](../crates/dweb-fabric/src/fabric.rs:4007)。

之后 `shutdown_drain()` 又顺序等待：

- accept loop，5 秒：[fabric.rs](../crates/dweb-fabric/src/fabric.rs:990)；
- connect inflight，5 秒：[fabric.rs](../crates/dweb-fabric/src/fabric.rs:1003)；
- detached connect tasks，5 秒：[fabric.rs](../crates/dweb-fabric/src/fabric.rs:1021)；
- accept children，5 秒：[fabric.rs](../crates/dweb-fabric/src/fabric.rs:1051)。

这些 deadline 都在前一个阶段完成后重新计算，因而不是同一个总预算。活跃 direct endpoint + 主 endpoint + 各类任务同时不收敛时，返回时间可超过 5 秒很多，约为多个阶段之和。现有测试中的 15/20 秒外层 timeout 只能证明测试没有一直挂住，不能证明产品的“shutdown 5s 有界”不变量。

**可验证修复**

在 drain 入口创建单一 `shutdown_deadline = now + 5s`，所有阶段统一 `timeout_at(shutdown_deadline, ...)`；截止后以确定性 abort/有限 join 收尾，并返回稳定的 incomplete-drain 错误。当前各超时分支在 `abort()` 后无条件 `task.await`，若任务处于不可取消的同步/不让出路径，仍可能越过预算；修复必须把这条边界也纳入可验证协议。新增同时阻塞 endpoint、accept、inflight、detached、child 的注入测试，断言整体返回时间≤5 秒加测试余量、完成门可观察、无后续事件。

### B3 — sync push 的取消、并发和 staging 语义未闭合

当前 push 代码有三个相互关联的缺口：

1. `readBoundedJsonLines()` 先调用 `readBoundedBody()` 把整个请求体读入内存；`request.signal` 只在每一行已经读出后才检查：[endpoint.mjs](../packages/opendweb-ext-sync/src/endpoint.mjs:178)、[util.mjs](../packages/opendweb-ext-sync/src/util.mjs:206)。
2. 请求体解析完以后，从闭包校验到 repo mutex 内的 `writeObject`/`writeRef` 没有再次检查 signal：[endpoint.mjs](../packages/opendweb-ext-sync/src/endpoint.mjs:238)。取消若发生在解析完成、CAS 前或对象写入之间，当前代码仍可能推进 ref，违背 delta 的“显式中止=ref 与工作树零变化”。
3. `streamsInFlight` 只在 `GET object` 分支递增；push 不占用组级≤2预算。每个 push 可缓冲约 256MiB 级对象数据，多个并发 push 可叠加。
4. `stagingDir` 在 `handlePush()` 中创建后，对象一直保存在内存 `objects` 数组；没有写入 staging 文件，最终直接在 repo mutex 内写入对象库：[endpoint.mjs](../packages/opendweb-ext-sync/src/endpoint.mjs:170)、[endpoint.mjs](../packages/opendweb-ext-sync/src/endpoint.mjs:245)。因此当前“staging 回收”只回收空目录，不能提供设计所说的持久中断/崩溃 staging 语义。

**可验证修复**

- 读取器接受 AbortSignal，边读边检查并在中断时立即停止消费；解析完成后、进入 repo mutex 前、提交线性化点再做取消裁决。
- 明确定义 abort 线性化：进入提交点前取消必须零 ref 变化；进入提交点后作为已接受提交完成，不能返回“取消但已推进”的模糊状态。
- push 纳入组级 stream budget（≤2），超限稳定返回 429；预算在 finally 中归还。
- 每个已验证对象先落入真正的 staging 文件，校验和闭包通过后再在单写者临界区导入并 CAS；崩溃/取消/TTL 测试必须确认 staging 可回收、ref 不动、对象库不产生不可解释的半写状态。
- 增加“解析完成后 abort”“CAS 前 abort”“第三个并发 push”“进程崩溃后 staging GC”四个用例。

## 非阻塞改进

### N1 — known_addrs 墓地仍无 TTL/活性修剪

容量 FIFO 和原子快照已经落地，坏文件按空表启动，满足内存有界与重启回落资本要求。但真双机实录已观察到专用 endpoint 随机端口形成约 16 条死地址；当前实现没有 TTL、失败计数或成功地址优先级。它不破坏安全边界，但在 direct-only 默认形态下会增加拨号噪声。后续应加入 TTL/失败退避/成功地址置前，并补持久化快照迁移测试。

### N2 — Darwin verified-walk 是诚实降级，不是 fd-chain 等价物

`fdchain.mjs` 明确探测 `/dev/fd` 不具备 Darwin 的子组件 fd-relative lookup，随后降级为逐组件 `O_NOFOLLOW` + dev/ino 复核 + 全部 wire 操作互斥，并明确不主张本地属主竞态免疫。该边界和 capability-adaptive 逃逸测试是诚实的；若要宣称 macOS 对本地属主竞态也免疫，仍需独立 openat NAPI change。当前不阻塞本轮可支持平台，但发布说明必须保留平台边界。

### N3 — 90 天 capability 实现正确，测试注释仍有旧语义

`mint_for()` 按当前时间加 90 天，不再按 invite 剩余时间钳制，符合“invite 过期是兑换窗口、不是成员寿命”。源码测试附近仍有“TTL = min(invite 剩余, 90d)”旧注释，应在归档前清理，避免未来误改。

### N4 — 真实验收覆盖仍有已知空洞

Owner 提供的 receipt 为：dweb-fabric 300/0、client-sdk 95/95、webui 256/256、ext-ports 35、ext-files 52、ext-sync 49、strict 通过；设计实录还给出了 iMac↔mini 的 ports 200/42231B/目录列表、member 重启恢复和 13 个真实缺陷修复。它们是有效证据，但本轮没有独立重跑。

仍未闭合的验收故事：

- SSE 和中途中断的真实双机矩阵；
- files/sync 的真实双机端到端故事；
- sidecar 在位配对路由 200（此前被 relay 吞没，W12 落地后需重跑）；
- W12 改动后的默认 relay 零接触证明；
- sync push 取消/并发/持久 staging 的新场景。

### N5 — 发布门禁要把 native 产物加载纳入收官

strip 损坏问题已按实录修复为 `strip=false` + 构建后 `strip -Sx` + codesign。归档前仍应保留一次真实 `node -e 'require(...)'`/等效 CJS dlopen 检查；cargo 构建成功和旧 native 测试变绿不能替代新 cdylib 的动态加载证明。

## 安全不变量核对

| 不变量 | 当前判定 | 证据 |
|---|---|---|
| member capability 90d，invite 过期不缩短成员寿命 | **通过** | `mint_for` 使用 `now + MEMBER_CAP_TTL_MS`；测试断言 90d |
| 尸体驱逐、supervisor 代次 fence、provider canonical 替换 | **通过（静态 + receipt）** | continuity manager/state/session 的尸体判定、原子 fence、canonical 重试/替换；真双机三轮实录 |
| 拨号 8s 上界、罚期、直连专用 endpoint | **通过，边界需记录** | continuity manager/fabric 两步拨号；8s 是单次尝试上界，双步总等待可更长 |
| known_addrs 持久化 | **通过** | `known_addrs.json`，sync+rename，损坏按空表启动 |
| shutdown 5s 有界 | **不通过** | 分阶段各自 5s，缺少全局 deadline（B2） |
| 新面零 argv 凭证 | **通过（源码核对）** | plugins runtime/host 不读 argv/env；既有 CLI token 入口仍是 W11 受控例外 |
| 精确 Origin 写守卫 | **通过** | `guardWriteOrigin` 要求精确 Host + 精确 Origin；插件 POST/PUT/DELETE 统一调用 |
| ports allowlist 默认拒绝 | **通过** | provider 先查 `isAccessAllowed`，未授权零转发 |
| files fd-chain / 降级声明 / 逃逸测试 | **通过但有平台边界** | capability 探测、逐组件 O_NOFOLLOW、dev/ino 复核、verified-walk 互斥和逃逸 Scenario |
| sync ref CAS / intent 三态恢复 | **部分通过** | CAS、parent/tree/blob closure、intent 的 ref/path 三态实现正确；push abort 临界竞态和 staging 实体语义仍是 B3 |

## 测试诚实度

- 当日全套 receipt 是 Owner 提供的验收材料，本轮没有复制为“本轮实跑”。
- 本轮独立运行 `packages/opendweb-ext-sync/test/endpoint.test.mjs`：8/8 通过。该文件的“aborted push”场景由 body generator 抛异常模拟断线，不能证明 `request.signal` 在解析完成后或 CAS 前的线性化；测试中也没有第三并发 push 的组级 429 断言，因此不削弱 B3。
- 本轮只读核对源码、设计和 delta；没有使用重型 cargo 门禁，也没有触碰双机进程。
- `git diff --check` 通过。
- 真双机实录本身可信度较高：它解释了 NAPI CJS、roster 首次接触、endpoint 编码、成员姿态、relay 毒化、cap TTL、崩溃尸体、supervisor TOCTOU、canonical 替换、known_addrs、shutdown drain 和 A-反向活锁等 13 个缺陷的因果链。它不能替代 W12 落地后的重新验收，也不能覆盖 B2/B3 的新边界。

## 归档前最小闭合清单

1. 落地 W12：SDK/Fabric 缺省 Disabled，WebUI 不自动注入 hub relay，custom QUIC/TLS relay 变成显式 opt-in，并同步 session/known-addrs 规范。
2. 把 shutdown 改成单一全局 5 秒 deadline，补同时阻塞任务的测试。
3. 修复 sync push 的 AbortSignal 线性化、组级并发预算和真实持久 staging；补四个取消/并发/崩溃场景。
4. 重跑 W12 后 sidecar pairing 200、ports SSE/中断，以及 files/sync 双机路径；保存独立 receipt。
5. 清理 capability TTL 旧注释、保留 Darwin 降级和 known_addrs 墓地限制说明。
6. native 重建后执行真实 dlopen，随后再跑 archive/strict 门禁。

## 评分

**实现质量：7.0/10。**

相对 r6 的设计预期 9/10，下调不是因为主体实现薄弱：内核连续性、成员 capability、NAPI 互操作、fd 安全降级、Origin/allowlist、intent 三态和真双机诊断都达到了较高工程质量。扣分来自：

- -1.5：[W12] 已有实证和架构定论，却没有进入默认配置；
- -0.8：shutdown 的“5 秒有界”没有成为全局不变量；
- -0.7：sync push 的取消/并发/staging 违反已冻结的资源与原子性边界。

修复 B1–B3 并补齐最小 receipt 后，预期可回到 9/10 附近；在此之前不能把当前工作区标为 release/archive ready。

## 明确结论

**NOT-READY。** 最小闭合范围就是 B1、B2、B3；N1–N5 可并行作为发布质量改进，但不能用当日绿门数字替代这三项实现闭合。
