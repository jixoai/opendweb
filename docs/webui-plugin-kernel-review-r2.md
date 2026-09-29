# webui-plugin-kernel 设计评审 r2

> 评审对象：提交 900538b39d5ab6bd2a2cf44a9571780c39e24718 的 design.md 与四份 spec delta；交叉核对 r1 讨论记录、app-protocol-layer /http 设计与 client-sdk 已实现 N-API、webui/home-hub 现有路由和启动分层、opendweb CLI 插件契约。按要求只读文档和源码，未运行重型门禁。

## 阻塞问题

### B1. 取消契约把响应头前与响应体中的取消混为一谈

设计写“provider AbortSignal / 消费端 signal”并要求本机下游断开后 fetchHttp abort 到达 provider（design.md:103-104,120；ports Scenario spec:9-12）。当前 fetchHttp 的 request.signal 取消键只在 session.fetchHttp() 等待响应头的 Promise 期间注册；Promise 返回即从表中删除（packages/client-sdk/src/session.rs:231-245,249-272）。响应体阶段要用返回句柄的 abort() 发 RESET（packages/client-sdk/src/http.rs:153-161）；provider 的 request.signal 才会因此触发。SSE/长下载在响应头已到后客户端断开，不能只调用请求 signal.abort()。

**修复建议：**在 design/spec 明确状态转换：响应头前用请求 signal；响应头后监听本机响应连接关闭并调用 HttpClientResponse.abort()；对端 RESET 触发 provider request.signal。Scenario 分别覆盖响应头前取消、SSE/响应体中途取消，并断言 provider signal 与上游 socket 均收敛。

### B2. files 的路径安全描述没有封住父目录组件竞态

design 和 delta 将“realpath + 包含校验 + lstat、打开后 fstat”称为禁 symlink 且防检查-打开竞态（design.md:133-136,208-209；specs/plugins/files/spec.md:7,14-17）。按路径逐次 lstat/open 后只对最终 fd 做 fstat，不能证明打开时每个父目录仍位于冻结 root 内；O_NOFOLLOW 也只约束最终路径组件。并发替换中间目录为指向 root 外的 symlink，仍可能让读写逃出共享根。

**修复建议：**冻结 descriptor-relative 路径遍历：从已打开的 root directory fd 按组件逐级 openat，每级拒绝 symlink（macOS/Windows 定义等效实现），最终操作只基于已验证 fd；增加父目录并发替换的逃逸 Scenario，验证 root 外无读写副作用。若 v1 无法提供该原语，应限制共享根为不可被并发修改的受控目录并明确降级边界。

### B3. sync 崩溃恢复对工作树提交仍是二选一占位

sync delta 的恢复结果允许“ref 未移动（或按物化日志恢复）”（specs/plugins/sync/spec.md:29-32），但设计只冻结 staging 扫描/TTL 和 ref CAS，没有定义物化日志格式、写入顺序、恢复动作或 ref 与多文件工作树之间的提交点（design.md:167-171,196-200）。若崩溃发生在部分文件已物化、ref 尚未更新时，重启可能留下半套工作树；若 ref 先更新则可能出现工作树落后。现有 Scenario 的“或”让两种实现都通过，无法验收不丢用户数据。

**修复建议：**选定唯一恢复协议：持久化事务 intent/目标 commit/路径操作清单，定义 prepare、物化、ref 更新和提交标记的顺序，并规定崩溃时确定性 roll-forward 或 rollback；或者把工作树切换设计成可原子替换。将 Scenario 改为逐个注入上述提交边界的崩溃，断言重启后文件内容、ref、用户未提交改动三者一致且无半成品。

### B4. W8 的 N 成员模型没有 N 成员收敛规则

设计承诺每设备一条 ref 加 refs/heads/main，并称“组模型不加 schema 迁移可扩 N 端”（design.md:20-21,151-155）；但合并流程和验收 Scenario 都是 A/B 两端。没有定义三台及以上时如何取得全部 peer refs、如何排序/合并多个 heads、谁推进组收敛 ref，以及不同离线合并顺序如何得到同一结果。稳定的 pairwise ours/theirs 顺序本身不足以证明多端确定性。

**修复建议：**将承诺收窄为“账本/ref 命名支持记录 N 成员，v1 同步执行与收敛只保证双机”，明确第三成员加入/追赶语义留到后续；或者冻结多端 fan-in 顺序、组 ref 所有权和冲突身份算法，并增加三端不同离线顺序最终收敛 Scenario。不要把无迁移的存储形状等同于 N 端行为兼容。

### B5. WebUI 插件页没有接入现有 hash 路由的设计协议

设计冻结了 pages/routes/component 元数据与静态组件（design.md:50-58），但现有 route.ts 对未知 hash 会收敛到 #/overview（packages/webui/ui/src/lib/route.ts:40-68），App.svelte 只静态分派固定视图（packages/webui/ui/src/App.svelte:94-130）。新增页面若不先接入注册表路由就不可达；descriptor 没有规定页面 route key、导航所属视角、权限/可见性、冲突处理或禁用后深链行为。delta 只有既有面零回归 Scenario，没有插件页注册/访问/停用后路由闭合 Scenario（specs/webui/spec.md:24-27）。

**修复建议：**明确静态 route registry 如何扩展现有 routeFor 与 App.svelte 分派，插件页落在哪个视角/导航区、route id 唯一性和未知/禁用深链结果；增加内置页面可达、刷新深链、禁用摘牌、旧未知 hash 仍按基线收敛的 Scenario。

### B6. 安装账本与 WebUI 可运行插件的契约断开

design/spec 一方面规定外部 npm 包 v1 不运行时加载，另一方面让 WebUI 展示 marketplace 候选并通过 CLI 安装，同时维护启停状态（design.md:50-58,75-80；specs/webui/spec.md:7,19-22）。现有 marketplace 的 glob 候选解析的是 CLI 插件；./opendweb-plugin 的 apiVersion: 1 manifest 是 {name, commands, run}，foldSingleCommand 只折叠 CLI argv（packages/opendweb/src/plugin-contract.mjs:21-27,88-109），不是 WebUI 的 webuiApi 页面契约。调用 opendweb plugin add 因而不会安装一个能被 WebUI 启用的插件。这里没有破坏 apiVersion 1，但产品面与安装账本语义接不上。

**修复建议：**若 W10 维持 CLI-only，明确 v1 WebUI 面板只管理编译内置的 ports/files/sync；marketplace 外部候选不要显示为可安装/可启用 WebUI 插件，CLI 插件清单仅做独立入口。若要宣称外部 WebUI 插件可安装，必须定义新 export 的发现/验证/包锁/启停加载流程及权限边界，不能复用 CLI apiVersion: 1 名义代替。

### B7. 文件级 Scenario 没有覆盖设计宣称的关键验收义务

sync requirement 确实写了 parent 闭包、CAS、完整性、type/mode 文件级冲突和预算（specs/plugins/sync/spec.md:7），CAS 有独立 Scenario（:24-27），但没有 Scenario 验证：缺失中间 parent 或树/blob 闭包时拒绝且 ref 不动；取消时 staging 不提交并回收；type/mode 冲突落入文件级 UI；单对象超过 16 MiB 被拒绝。design §7.6 将它们称为必须的首批测试并纳入双机矩阵，但 §9 的双机矩阵并未列这些协议边界（design.md:196-200,223-228）。files 的上传 Scenario 还把同 uploadId 重试语义写成“续传或整体重来，语义明确二选一并冻结”，本身仍未冻结（specs/plugins/files/spec.md:19-22）。

**修复建议：**将这些义务拆成可判定 Scenario：完整 parent/tree/blob 闭包与缺项拒绝；显式 abort 后无 ref/worktree 变化、TTL 回收；type/mode 冲突文件级决议；16 MiB 边界内成功/超限拒绝；files 上传固定续传或整体重来其中一种，并覆盖 hash 失败/取消/重启。CAS 现有 Scenario 保留。

## r1 六条冻结建议对照

| r1 建议 | 裁定 | 对照 |
|---|---|---|
| 薄核、静态类型化页面、插件 drain/dispose、双账本、可信执行 | **主体落地，页面接线待补** | §2 冻结独立 WebUI 契约、静态 bundle、信任模型、生命周期和账本；但现有 router/App 如何消费 page registry 未定义（B5），外部包不加载使安装语义另有断点（B6）。 |
| /sidecar/plugins* 控制面与 /wpk1/* 会话数据面隔离 | **落地** | §1/§3 明确两个入口和授权维度；Host 守卫、写路由精确 Origin 与现有 sidecar 纪律一致。需在实现 Scenario 中保留旧路由行为。 |
| /http 请求/响应/取消/SSE/WS 边界 | **部分落地** | 静态请求 body、有界上传、响应 pull 流、provider AbortSignal、SSE、WS 字节隧道均记录；消费端取消没有区分响应头前的 request.signal 与响应体阶段的 response.abort()（B1）。 |
| Files REST、路径安全、chunk staging、校验和原子提交 | **协议主体落地，安全保证过度表述** | 端点/分片/hash/commit/TTL/只读默认齐全；路径遍历仍需 fd-relative 组件防竞态（B2），uploadId 重试语义未裁定（B7）。 |
| isomorphic-git 对象底座、自定义传输、CAS、自持 diff3 与冲突分级 | **构型落地，恢复与验收不完整** | §7 明确无 Git wire、对象完整性、CAS、hunk/file、AI hook；崩溃物化未给唯一协议，闭包/type-mode/超限缺独立 Scenario（B3、B7）。 |
| 成员/seed 决策与 iMac/Mac mini 双机验收 | **双机锚点落地，N 成员承诺不完整** | W9 明确 seed；§9 和 deltas 覆盖 ports/files/sync 双机主流程。W8 多成员模型尚无 N 端确定性收敛规则（B4）。 |

## 六个 strawman 遗漏维度闭合度

1. **控制面/数据面边界：已闭合。** /sidecar/plugins* 管本机，/wpk1/* 走 Fabric session；授权按 peer/plugin/share-or-port/operation。
2. **安装信任与前端交付：部分闭合。** 可信执行、无 iframe/远程 bundle、静态组件已写；静态页路由接入缺协议，CLI marketplace 与 WebUI 可运行插件不相连（B5、B6）。
3. **同步拓扑与初始化：部分闭合。** 有多成员 ref 形状、seed、删除/ignore/rename/case 规则；N 端收敛和同步工作树内 symlink 的处理仍未冻结（B4；sync git 不应默认为 files share 的路径防护语义）。
4. **事务与恢复：未闭合。** staging、CAS、TTL 已有；工作树物化和 ref 的崩溃原子性只有“未移动或按日志恢复”的备选描述（B3）。
5. **资源预算与可观测性：部分闭合。** sync 对象数/总量/并发和 job 状态已列；ports 8 MiB 可配无最大配置值，files staging 并发/总占用/TTL 数值与跨插件总体内存预算未定。静态 body 必须先缓存，更需限制并发累计内存。
6. **插件停用：主体闭合。** 摘牌→drain/取消→dispose→落盘顺序明确，Spec 有生命周期 Scenario；还应冻结 drain 超时值和超时后的稳定响应，但不阻止总体构型理解。

## W7-W11 裁决

- **W7 请求体 8 MiB 有界：方向与 r1 一致。** r1 已建议有限请求体并拒绝超限；当前 SDK 的 fetchHttp body 是静态 chunk 数组，故 8 MiB 可作为默认值。需补硬上限或受信配置的有限范围、未知 Content-Length 时边读边累计并在超限立即拒绝，以及并发累计预算。否则“可配”本身没有保证有界。
- **W8 多成员组模型、双机验收：方向与 r1 的开放项相容。** r1 明确要求先裁定成员数并把结构差异冻结；选 N 成员 ref 模型、首发只做 iMac/Mac mini 双机是可行决策。当前欠缺的是不能从 refs 命名推出 N 端收敛保证，需按 B4 降级承诺或补三端算法。
- **W9 seed authority 显式选择：与 r1 一致。** r1 的 Q4/下一步建议要求首次双向冲突由 Owner 选初始权威；设计给出非空对端阻断与三方对照，spec 有双机 Scenario。
- **W10 安装仅 CLI：作为 r1 未决二选一中的一个裁决，原则上可接受；实现语义尚不闭合。** r1 P6/Q6 保留既有 marketplace/CLI 安装而由 WebUI 管运行状态，并明确“面板是否触发 CLI 安装”仍是开放项。选择 CLI-only 本身没有反对 r1；但既有 CLI 只安装 ./opendweb-plugin 命令插件，而 v1 不加载外部 WebUI npm 包，因此不能把它描述成安装了 WebUI 插件（B6）。
- **W11 既有 token 入口是受控例外、新面零 argv 凭证：新面零凭证符合 r1；“例外已冻结”不符合 r1 的证据结论。** r1 明确要求 Owner 裁定旧 --token/DWEB_ADMIN_TOKEN 是例外还是需改造，而非把现有 OS 可见性披露等同于满足 W0。原 requirements 的凭证红线仍在；应由 Owner 明确追认例外或调整旧入口。--token 与环境变量也应分开裁定，因为只有前者是 argv。

以上五项在 design.md:20-24 均仍标注“待追认”。正式冻结前须记录 Owner 对 W7-W11 的接受/修改，尤其是 W11。

## Spec Scenario 覆盖矩阵

| 路径 | 覆盖结论 | 证据/缺口 |
|---|---|---|
| Parent 闭包 | **不足** | MUST 已写，但没有缺 parent/树/blob 闭包的拒绝与零 ref 变化 Scenario。 |
| CAS | **覆盖** | A/B 同基线并发 push，后到 CAS 拒绝、重取合并后收敛（sync :24-27）。 |
| 取消后的 staging 回收 | **部分覆盖** | files 有会话断开后 TTL 回收（files :19-22）；sync 只有崩溃/断线 Scenario，没有明确 abort、ref 不动和 staging 生命周期断言。 |
| 崩溃恢复 | **存在但不可判定** | sync :29-32 覆盖崩溃和物化，但允许“ref 未动或日志恢复”二选一；日志没有对应设计（B3）。 |
| type/mode 冲突 | **不足** | Requirement 分级为文件级，但没有触发具体冲突并走文件级决议的 Scenario。 |
| 超限对象 | **不足** | Requirement 有预算；没有大于 16 MiB 对象明确拒绝且不改 ref 的 Scenario。ports 超限请求体 Scenario 不替代此项。 |
| 双机验收矩阵 | **主流程有覆盖，协议边界缺项** | ports mini→iMac curl/SSE、files mini 浏览/传输 iMac、sync A/B 跟随/合并/冲突/恢复/seed 均出现；design §9 将 agents-skills 真目录列为最终验收。但这不能替代上面四项同步协议 Scenario，也没有三成员验收（W8 当前仅承诺双机验收）。 |

## 与既有面的冲突核对

- **/http 语义：**现有 N-API 已暴露 HttpHandlerRequest.sessionId、入站 bodyNext()、provider signal、respondStreaming()/writer；fetchHttp 请求 body 是 Array<Uint8Array> 静态分块，响应支持 pull bodyNext()/迭代，响应对象有 abort()。WebSocket 整消息仍是类型占位，当前是 keepOpen + sendTunnel + bodyNext 字节隧道。设计的大方向符合现状，取消阶段边界需按 B1 改正；EOF 映射为结束，因此对象 OID/hash 验证正确。
- **home-hub WebUI：**现有 core/壳分层、五行启动分流、hub/lease/visits 三视角与固定四页均可保留；sidecar listener 现把 /sidecar/* 统一交给固定 handleSidecar，新路由应在此既有入口注册。写路由精确 Origin 与基线一致，读路由允许缺失 Origin 的既有规则不应被新插件路由意外放宽。主要冲突是插件页面与未知 hash 收敛/静态 App 分派尚未定义（B5）。
- **CLI 插件契约：**新 ./opendweb-webui-plugin/webuiApi:1 与旧 ./opendweb-plugin/apiVersion:1 分版本是正确选择，没有字段级冲突；foldSingleCommand 是 CLI argv 处理，不能充当 WebUI page/route loader。marketplace/安装账本指向 CLI 包，不能单独证明 WebUI 插件已安装或可启用（B6）。
- **文档内两处明确修正：**design.md:72 的“tmpfs rename”若按字面执行，跨文件系统 rename 不具备原子性且会失败；应写成同一持久文件系统内临时文件 + rename。design.md:113 用 [W7] 交叉引用 0.0.0.0 监听决策，但 W7 定义的是请求体上限；应移除错误编号并为监听边界单独编号/落入既有裁决。

## 质量评价

总构型清楚，传输事实比 proposal 准确；对象同步路线、seed、CAS、hunk/file 冲突层级、双机用户故事和原有 home-hub 零回归门已进入文档。四份 delta 把大部分关键 MUST 写成了可执行要求，CAS 与主业务闭环也有 Scenario。

当前不宜冻结的原因集中在运行边界，而非技术栈选择：消费端取消 API 语义写宽、文件路径竞态防护不足、工作树崩溃事务没有唯一恢复协议、多成员承诺超出定义、插件页和 CLI marketplace 没有打通，以及明确列出的 sync 验收义务缺 Scenario。design.md §10 声称“六遗漏维度全部闭合”不准确，应改为部分闭合并保留上述开放项。

**评分：5/10。** 架构主线和大部分协议边界已经成形，值得保留；但至少 B1-B6 影响取消安全、文件越界、数据恢复、N 端一致性或插件页面可达性，另有 B7 的验收覆盖缺口，尚未达到可冻结/可直接实现的标准。

**结论：NOT-READY。** 完成 B1-B7 的可验证修订、改正文档内错误引用，并由 Owner 对 W7-W11（尤其 W11 旧凭证例外）明确追认后，再进入 design v1 冻结。
