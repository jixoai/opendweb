<!--
意图（2026-09-29）：记录 webui-plugin-kernel 构型讨论第 1 轮的 P1-P6、Q1-Q8 裁定、源码事实、未决边界与 design.md v1 冻结建议。
原始需求输入：「webui-plugin-kernel 新 change 的构型讨论第 1 轮开始……结论落到 docs/webui-plugin-kernel-discussion-r1.md」。
-->
# webui-plugin-kernel 构型讨论 r1

> 讨论性质：共同架构收敛，不是对 Owner 输入的评审。需求信源为 `requirements.md` 的 W0-W6；本记录不替代后续 Owner 对分歧项的裁决。Q5 纳入 2026-09-24 本机探针报告及 43b42e1。

## 结论摘要

建议 v1 采用自研最小插件宿主、静态注册的内置 Svelte 页面、两种彼此隔离的路由面，以及 isomorphic-git 松散对象传输和自持三方树合并。首发仍是 ports/files/sync 三件套。对象同步不实现 Git smart HTTP；WebUI 本机 `/sidecar/*` 管理面也不承载远端插件数据流。

```text
浏览器 UI
  │ 同源 localhost；只持本机短期 console capability
  ▼
sidecar 控制面：/sidecar/*（Host + Origin；插件配置/状态）
  │
  ├── WebUI 插件宿主：注册表、生命周期、权限、状态
  │       ├── ports / files / sync（内置 workspace 插件）
  │       └── 静态编入 UI 的类型化页面
  │
  └── client-sdk /http：fetchHttp ── Fabric session ── serveHttp
                                                        │
                                     远端插件数据端点（版本化、按 peer 授权）
```

## 地基事实

1. app-protocol-layer §3.4 冻结的目标类型面是请求和响应 body 均可 `AsyncIterable`、pull-first、有界背压、取消双向适配；当前 N-API 实际面仍分阶段：`FetchHttpInit.body` 是 `Vec<Buffer>` 静态分块（`packages/client-sdk/src/http.rs:54-67`；JS 包装器 `packages/client-sdk/http/index.js:14-18,29-65`），尚不能从 fetch 侧边读边发送任意请求体。响应体可由 `bodyNext()` pull-first 读取并迭代，也有显式 `abort()`；provider 侧 `serveHttp` 能用 `bodyNext()` 拉取入站请求体，并经 `respondStreaming()/write()/finish()` 流式回响应（`http/index.js:82-95,111-227`；`http/index.d.ts:32-58,60-95`）。
2. SSE 可用上述流式响应承载，是应用层 `text/event-stream`，不是另一个特殊消息接口。请求取消有 provider `AbortSignal` 和 fetch 侧响应句柄 `abort()`；`fetchHttp` 的 `signal` 目前映射到响应头等待期的 abort key，不能把它写成请求体 AsyncIterable 已落地。当前 N-API `recv_body()` 的非成功终态映射为 EOF（`src/http.rs:121-130`），所以自定义对象传输必须带预期长度/OID 并在 `writeBlob` 前验证完整性，不能把正常 EOF 当作对象完整的唯一证据。
3. `WsMessage` / `WebSocketChannel` 是类型占位；今日 runtime 是 `keepOpen + sendTunnel + bodyNext` 字节隧道，不是整消息 API，也不等于本地 TCP/HTTP server 已能透明代理 WebSocket upgrade（`packages/client-sdk/http/index.d.ts:123-139`；`src/http.rs:135-150`）。app-protocol-layer 在 `openspec list` 中仍为 19/31；设计面、当前 ABI 与整个 change 完成状态必须分开陈述。
4. WebUI core 已拆出 sidecar、target、capability、events、nodes、home、cardkit、console；CLI/plugin 是薄壳（`packages/webui/src/index.mjs:1-32`）。无参启动五行分流在 `cli.mjs:182-211` 与 `core/home.mjs:71-107`；UI 有 hub/lease/visits 三视角和固定中枢四页（`ui/src/lib/route.ts:23-59`、`components/SideNav.svelte:11-22`）。当前 sidecar 路由只有 `/api/*`、`/sidecar/*` 和静态 fallback（`core/sidecar.mjs:312-317`），没有插件路由注册器。`/sidecar` 写路由已有要求精确 Origin 的守卫，读路由的 Host/Origin 规则允许缺省 Origin（`core/sidecar.mjs:663-683,855-869`）。
5. 当前 `./opendweb-plugin` 是 CLI 命令清单 `name/apiVersion:1/commands/run`，不是 WebUI 生命周期或页面 API（`packages/opendweb/src/plugin-contract.mjs:21-27`）；`foldSingleCommand` 只是单命令 CLI 参数折叠（同文件 `88-109`）。marketplace 是 npm 包名 glob 候选配置（`marketplace.mjs:1-18`），`plugin add` 在调用方 cwd 安装 devDependency，并将 alias→package/version 锁入 `~/.opendweb/plugins.json`（`plugin-registry.mjs:1-8,137-167`）。schema 校验不是沙箱：插件模块 import/run 会在宿主 Node 权限下执行（`plugin-contract.mjs:1-4,120-143`）。
6. 本轮读了 probe 原始脚本并安全复跑 `probe2.mjs`；clean merge 与冲突区结果符合预期。报告中的冲突标记样例未传 `stringSeparator: "\n"`，而 node-diff3 默认按 `/\s+/` 切分，会破坏单词间空格和行边界；本轮另用显式换行分隔及断言复跑标记输出通过。对象传输脚本 `probe.mjs` 首行会递归删除 `/tmp/iso-probe/repos`，该目录当前存在，因此本轮未执行它；对象搬运结论采纳 Owner 的 43b42e1 报告和脚本核读，不标记为本轮独立复跑。
7. 对象探针的 `transferObjects()` 写入传入的 commit 和该 commit 的树/blob，但没有递归写入 `commit.parent`；初始化时 `c2` 的 `c1` parent 因而缺失。B 上的 ref 还以 `force: true` 直接写入。这不否定 `read/writeBlob/Tree/Commit` 可用，也说明探针未证明 commit 历史闭包或 compare-and-swap。

## P1-P6 裁定

**P1 插件内核：同意 v1 自研最小宿主，不引 Cordis。** v1 的能力边界是进程内注册页、远端 HTTP handler、启停/配置与确定性 dispose；不需要通用依赖注入、热替换或第三方隔离。这个结论成立的主因是当前产品规模和运行时责任有限，而不是 Cordis 响应式与 Svelte runes 必然冲突：Cordis 响应系统完全可以留在非 UI 层，双响应系统理由偏弱。迁移位也不应成为抽象目标；先冻结插件面，不冻结“以后换 Cordis”的适配框架。安装第三方包等于信任并在宿主权限执行，v1 必须明确这是可信插件模型，不宣称 sandbox。

**P2 UI 插件面：部分同意，需改成“类型化静态页面注册 + 页面专属组件”。** manifest 页面类型和通用渲染器适合配置表单、简单列表，但文件浏览器、冲突编辑器和高密度状态页有真实交互差异；把它们压成通用 schema 页面会把复杂度塞进 renderer。v1 页面随 workspace 插件编译进同一 UI bundle，由类型化注册表映射页面 id、导航元数据、能力和 Svelte 组件；共用 shell、表格、表单与状态组件，复杂页保持各自组件。暂不做 iframe、运行时远程 bundle 或任意插件 JS 动态导入；它们需要独立的前端包发现、版本、CSP 和信任设计。

**P3 端口共享：同意 HTTP 语义面优先，但原型对“透明代理”的承诺过宽。** B 侧本机 listener 到 A 侧 `fetchHttp`，A 侧通过 `serveHttp` 转发到获准的 localhost 服务；默认只绑定 `127.0.0.1`，本机端口冲突明确失败，不静默换端口；A 侧授权按 peer 与远端端口组合、默认 deny。普通请求/响应头需定义 hop-by-hop 与敏感 header 规则。响应侧可流式并传播取消，SSE 可用；请求侧现为静态分块，因此 v1 必须有请求体上限，超限拒绝，不能宣称任意大/实时上传透明转发。WS 与 raw TCP 不进 v1；字节隧道不能替代完整 upgrade 代理。`0.0.0.0` 单靠“显式选择”不足以构成安全边界：没有本地访问认证时应留作后续能力。

**P4 文件夹共享：同意自定义 REST FS 面，不采用 SMB/WebDAV。** 端点只暴露明确操作：列目录/stat、流式读、分片上传及提交、mkdir/rename/delete；共享 id 与规范化相对路径分开传，禁止把未经校验的 URL path 直接拼接成本机路径。默认只读；写授权按 peer/share。`serveHttp` 可流式读请求 body、响应可流式写；但 WebUI 客户端经 `fetchHttp` 上传仍受静态请求体限制，因此大文件按应用层 chunk 请求传输，服务端写临时文件并校验总长度/hash 后原子提交，取消/断线不得暴露半文件。Range 下载可用于续读，但 Range、etag/version 和重命名后的恢复语义要由插件协议定义。

**P5 文件同步：同意并按 probe 重裁为 isomorphic-git 对象底座 + 自定义对象端点 + 自持三方树合并。** 这保留 Git 对象、commit、ref、历史与 push/pull 语义，不实现 Git wire。Owner 报告记录：跨 gitdir 搬运 blob/tree/commit 的 OID 逐字节一致（含嵌套树）；`git.merge` 对 bothModified 不做非重叠行自动合并；`node-diff3` 的换行分隔模式能自动合并不重叠区域并输出 a/b/o 冲突数组（`probe-sync-engine.md:7-33`）。本轮安全运行 `probe2.mjs` 验证了 clean merge 与冲突数组，并用显式 `stringSeparator: "\n"` 独立断言了标记文本；原报告第三场景省略该选项，按库默认 `/\s+/` 会破坏文本边界，是探针代码应修正的瑕疵，不改变栈选型。粗量级（工程周，低置信度，不含插件 UI/宿主）：a 自实现可互操作 smart HTTP/pack 服务约 8-16+ 人周，协议和 pack/协商面过大；b 有界自定义 refs+wants+缺失 loose objects 端点，双机 MVP 约 3-6 人周，做完恢复/并发/故障硬化约 6-10 人周；c gitoxide 接入先做 1-2 人周 API/能力 spike，再估 6-12+ 人周 N-API、Rust/JS 数据映射、构建与运行时接线，成熟 server 面也不能免去本 change 的授权、生命周期和冲突策略。本轮没有证据证明 c 的完整 server 面可直接嵌入，暂不值得选。建议冻结 b；百 MB 级二进制和 pack 压缩是后续按实测决定的优化。冲突 UI 对 UTF-8 文本采用 hunk/行区级：非重叠自动合并，重叠区逐块选择 ours/theirs 或编辑；binary、超限/非 UTF-8、delete/modify、类型/模式冲突退回文件级选择。ours/theirs 命名必须按稳定设备身份排序，并持久化 base/ours/theirs OID、diff3 算法版本与用户决议，保证两端复现；AI 只作为拿到结构化 hunk 的 merge driver 钩子，首发不自动授权其写回。

**P6 配置/状态与 marketplace：同意分层，但必须拆分安装记录和启用状态。** 继续由 `opendweb plugin add/marketplace` 解析、安装和锁定 npm 包；WebUI 宿主管插件启停、授权和配置，不重造 marketplace。现有 `plugins.json` 是包安装锁，不得兼作运行时启用状态；插件状态与私有数据各落在 `DWEB_HOME` 的宿主管理文件/插件子目录，沿用锁、原子写与 symlink 拒绝纪律。若面板触发 CLI 安装，须用固定 argv、明确显示包名/版本并由用户确认；安装脚本会以用户权限运行。CLI 的 apiVersion 1 保持原样，WebUI 插件另设独立版本化契约（例如新 export 子路径），不把生命周期/page/route 字段塞进旧 manifest。停用先拒新请求并 dispose，待在途流收敛后卸载；包替换/卸载是否需重启写入设计，不假装可热替换。

## Q1-Q8 裁定

**Q1 Cordis vs 自研：裁定自研最小宿主。** 宿主只负责注册表、启动/停用/卸载顺序、插件级路由/页面元数据、配置与状态 owner、错误隔离和 dispose；不提供插件间 DI 或响应式状态系统。Cordis 可以在后续生态规模和第三方生命周期复杂度有实证后重开，但不预留空泛兼容层。必须先定义可信执行边界：v1 包是用户明确安装并信任的宿主内代码，不是沙箱代码。

**Q2 UI 页面形态：裁定复杂首发页不做纯通用渲染。** v1 用静态注册的类型化页面组件，通用 renderer 仅承载简单配置/表格；files 与 sync 冲突页面由各自插件提供编译时组件，共享控件和 shell。第三方可热载 UI bundle/iframe 留到有包分发、CSP、API 兼容和签名信任设计之后。

**Q3 端口共享：裁定“HTTP 有界请求 + 流式响应，v1 不含 WebSocket/raw TCP”。** 端口映射账本由消费侧 B 保存，提供侧 A 保存 peer/port allowlist；端口绑定失败明确报冲突；v1 默认 loopback-only，公网/LAN 监听需额外的本地鉴权和披露机制，不以选择 bind 地址代替授权。对 HTTP body 设上限并透传常见方法；当前 SDK 请求体静态分块，非有限缓冲上传要先扩展 SDK 或另有协议。WebSocket 今日只有字节隧道，不能承诺本地 HTTP upgrade 到 dweb upgrade 的端到端兼容。

**Q4 文件共享 wire：裁定自定义小型 REST，文件下载用响应流，上传用分片提交。** 不引入 WebDAV 子集的兼容负担。读操作支持 offset/range 与内容标识；写操作先入临时文件，按 chunk 序号/offset 去重，最终核对长度和哈希后 rename；取消清理或保留带 TTL 的 staging，不把未完成结果显示成正式文件。SDK 的静态请求 body 使分块必须在应用协议表达；底层流取消负责停止资源消耗，应用校验负责阻止截断内容落盘。

**Q5 同步引擎与传输：裁定用 b，接受新的本机 probe 结论。** 端点交换 ref 快照、期望 commit、已有 OID/缺失对象和 loose object 内容；对象由本地重算 OID、检查类型/长度后导入，所有对象齐备后再做 ref compare-and-swap。每个 repo 同时只有一个本地 merge/ref writer；并发远端 push 若基于旧 ref 必须 CAS 拒绝并触发重新 fetch/merge，不能 last-write-wins。传输先落 staging，取消或校验失败不移动 ref；重试用操作 id/object OID 幂等。树合并由自持算法分类 add/modify/delete/type/mode，再对允许的文本 blob 调 node-diff3；重叠冲突是 hunk 级，二进制与结构冲突是文件级。首发限 configs/skills 量级并限制单 blob/总对象/并发预算；pack 与超大二进制后置。probe 直接验证了原语组合，不验证 rename、symlink、crash recovery、并发 ref CAS、旧格式迁移或超大对象，相关测试须进 change 实施任务。
> 补充证据边界：对象搬运报告能支持单对象 OID 稳定与树/blob 递归，不覆盖完整 commit DAG、endpoint envelope 或 CAS；将 parent closure、取消后的 staging 回收、并发 push 与崩溃重启列为首批实现验收项。

**Q6 生命周期与 CLI 契约：裁定包安装与运行状态双账本。** `opendweb` marketplace/plugin 命令负责包来源和版本锁；WebUI 插件面板消费独立的 WebUI manifest/运行时契约并管理 enabled/config。`webui` CLI 插件本身是宿主启动器，tray 是宿主集成，均不迁成普通可停用业务插件；未来可将其页面/功能拆为内置插件，但启动、认证、设备与服务管理仍属于薄核。首发插件可由 workspace 包静态发现，外部 npm 插件加载保持显式信任与版本校验。

**Q7 安全清单：裁定以 capability 拆边界，不复用一条 Origin 规则覆盖所有面。** 浏览器到本机控制面使用现有 Host 校验和写路由精确 same-origin Origin；不能把短期 UI capability、admin/member token 或 peer 授权放进 URL、argv、浏览器持久化或日志。这里有一条必须显式处理的现状差异：W0 推导红线写明凭证不进 argv，而现有 WebUI 仍接受 `--token`/`DWEB_ADMIN_TOKEN` 并在帮助中披露 OS 可见性（`requirements.md:90-92`；`packages/webui/src/plugin.mjs:1-13`、`src/cli.mjs:164-180`）；不能把“已有提示”直接等同于满足 W0。建议插件内核和浏览器新路径一律不接触这些秘密，由 Owner 明确旧 CLI 入口是受控例外还是需要在本 change 范围外改造。远端数据面绑定 Fabric sessionId/peer，并按 share、port 和操作逐项 deny-by-default 授权；loopback 本机端口映射另计本机访问者。路径防逃逸不能只做字符串前缀或一次 realpath：禁止 symlink 跟随并处理检查到打开之间的替换竞态；同步 gitdir 独立放在插件管理目录，明确 ignore/delete/rename/大小限制，排除 `.opendweb/nodes.json` 等宿主数据。每个文件写入要有原子提交、权限/所有者校验与崩溃恢复状态。明文传输提醒沿用既有模式。

**Q8 分期与验收：裁定先锁共同宿主和协议，再逐插件闭环，双机故事作为最终行为门。** Phase 0 冻结插件 descriptor、控制面/数据面路由、信任/授权、状态文件和 lifecycle；Phase 1 ports 完成 loopback curl、权限与请求体上限；Phase 2 files 先只读，再加入安全写、分片恢复和断线清理；Phase 3 sync 先单向 seed/pull，再双向 commit/merge/冲突决议/离线重连。每阶段都跑现有 WebUI 三视角、五行分流、接入卡片回归。最后用 iMac + Mac mini 对 agents-skills 真实目录验证单边变更、非重叠自动合并、重叠冲突决议、处理中断恢复和两端最终 OID/工作树收敛；API 单测不替代该验收。

## Strawman 遗漏的构型维度

- **控制面与数据面的物理边界**：本机 sidecar `/sidecar/*` 是浏览器管理面；跨设备调用走 Fabric session 的 `fetchHttp/serveHttp`。`/ext/*` 不应成为本地 Node listener 上绕过路由守卫的隐式新入口。
- **安装信任与前端交付**：npm 包执行权限、UI bundle 如何发现/加载、包版本与 WebUI API 版本兼容、安装时用户确认都未冻结。CLI manifest 的 safeParse 不提供沙箱。
- **同步拓扑与初始种子**：同步组是固定双端还是多设备组、首次两边均有内容时谁作基线、是否传播删除、ignore/rename/case-folding/symlink/文件模式策略，需要有明确数据模型。W4 说多台设备，验收锚点目前只覆盖两台。
- **事务与恢复**：对象下载 staging、ref CAS、工作树物化日志、进程崩溃恢复、重复消息去重、断线续传及垃圾回收未定义。内容寻址解决重复对象，不自动解决“ref 已更新而工作树只写了一半”。
- **资源预算和可观测性**：最大文件/object/group、并发流、队列与超时预算，sync job 状态/错误/重试/进度，以及持久化 schema 的升级策略需要冻结；尤其 fetch 请求体静态数组要求传输预算可执行。
- **插件停用语义**：在途 HTTP 流、定时器、文件 watcher、锁和事件订阅何时 drain/dispose，禁用与包删除如何排序，不能只定义一个 `enabled` 布尔值。

## 分歧清单

核心内核与 Q5 引擎栈暂无分歧：本轮接受对象传输 + isomorphic-git + node-diff3。以下是从 W0-W6/验收锚点尚不能唯一推出的产品边界，建议 Owner 冻结：

1. **端口代理的请求体范围**：v1 是否接受有限请求体上限与超限 413，还是“等同直接访问”要求任意大/持续上传，因此必须先扩展 `fetchHttp` 的流式请求 body ABI？当前真实地基无法同时满足后一承诺与不改 app-protocol-layer 的边界。
2. **同步成员数**：v1 的 sync group 是否先限定 iMac+Mac mini 两端，还是从第一版就承诺三台以上成员的 refs/合并收敛？数据结构可以从单机对模型起步，但群组 ref 和冲突身份会不同。
3. **UI 安装操作**：是否允许已配对的 WebUI 直接触发 marketplace npm 安装（明确提示安装脚本以用户权限执行），还是安装只由 CLI 发起、WebUI 只启停已安装包？这是信任/权限承诺，不只是按钮放置。
4. **首次双向同步的冲突基线**：当双方在建组前已经各自有不同内容，是否要求首发自动合并，还是由 Owner 选择一端作为初始权威？现有双机故事未覆盖初始化冲突。
5. **既有凭证入口与 W0 argv 红线**：W0 的走查含义要求 admin/member 凭证不进入 argv，但现有 CLI 接受 `--token` 并仅作可见性披露。Owner 需裁定此入口是否属先前冻结的受控例外；本 change 的新插件/API 不应扩大该例外。

## 下一步建议：冻结进 design.md v1

1. 冻结薄核职责、插件 descriptor/version、启停/在途 drain/dispose，以及 CLI 包安装记录和 WebUI enabled/config 状态的双账本；第三方插件按宿主进程内可信代码处理。
2. 冻结双路由拓扑：sidecar `/sidecar/plugins/*` 仅管本机控制；Fabric session 内的版本化插件路径承载远端数据。分别写入 Host/Origin 与 peer/session/operation 授权表。
3. 冻结 SDK 传输事实与使用边界：fetch 请求体静态分块；响应 pull-first 流；provider 入站 body pull 和响应流写；取消如何传递；SSE 可用、WebSocket 仍是字节隧道。由 Owner 裁定请求体范围后决定是否卡住 ports v1。
4. 冻结 files REST 操作、只读默认、路径/symlink 规则、chunk upload staging/校验/原子提交和 Range 下载语义。
5. 冻结 Q5 推荐栈、对象端点 envelope、ref CAS、单写者锁、hunk/file conflict 分级、稳定 ours/theirs 顺序、算法版本、对象与流预算；将 probe 的对象/merge 原语整理成仓内可复跑测试，并增加尚未验证的路径类型、取消、并发与崩溃用例。
6. 冻结 sync 组成员数、首次 seed 权威、删除/ignore/rename 规则和最终 iMac/Mac mini 验收矩阵，再拆 Phase 0-3 tasks。
