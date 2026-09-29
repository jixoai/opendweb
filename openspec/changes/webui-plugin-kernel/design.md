# webui-plugin-kernel 技术设计 v2（吸收 r2 设计评审 B1-B7）

<!--
意图（2026-09-24）：把 Owner 思维原型（[W0]-[W6]）与构型讨论 r1（docs/webui-plugin-kernel-discussion-r1.md，
Codex 共同架构师轮全裁定）收敛为可冻结设计。[W7]-[W11] 为讨论分歧清单的编排者推荐默认，
标注「待 Owner 追认」，Owner 推翻任一条只影响对应小节，不影响总构型。
-->

## 0. 裁决映射

| 裁决 | 内容 | 来源 |
|---|---|---|
| [W0] | SMB 不内置；内置跨设备共享/同步三件套 | Owner 原话 |
| [W1] | 端口共享：B:9090 ≡ A:8080 | Owner 原话 |
| [W2] | webui 提供简单 FS 操作能力（非 SMB wire） | Owner 原话 |
| [W3] | 虚拟 git + 单向/双向 + 自动 merge + 冲突交还用户 + AI 钩子 | Owner 原话 |
| [W4] | 刚需：多台设备同步 agents-skills/prompt/wiki/configs | Owner 原话 |
| [W5] | webui 薄核（服务启动/设备发现/认证/互联/管理）+ 插件系统 | Owner 原话 |
| [W6] | 首发=三件套；vpn/clash/AI/ssh/屏幕共享「即将推出」占位 | Owner 原话 |
| [W7] | 端口共享 v1 请求体有界（默认 8MiB 可配）+ 超限 413；流式请求体 ABI 扩展为后续 change（不动 app-protocol-layer 边界） | 推荐，待追认 |
| [W8] | 同步组账本/ref 命名自 v1 记录 N 成员（每设备一 ref）；**v1 同步执行与收敛只保证双机**（pairwise），第三成员加入/多端 fan-in 收敛为后续 change 显式义务（r2-B4 收窄） | 推荐（W4「多台」导出），待追认 |
| [W9] | 首次建组：UI 显式选择一端为初始权威（seed authority），不做首次自动合并 | 推荐，待追认 |
| [W10] | 插件包安装仅 CLI（opendweb plugin add 家族）；webui 面板只管启停/配置，不触发 npm 安装 | 推荐，待追认 |
| [W11] | 既有 --token/DWEB_ADMIN_TOKEN 入口=先前冻结的受控例外（OS 可见性披露在案）；本 change 全部新面零 argv 凭证，不扩大例外 | 推荐，待追认 |

讨论 r1 裁定的吸收：P1-P6/Q1-Q8 全文见 docs/webui-plugin-kernel-discussion-r1.md，
本设计按其「下一步建议」六条冻结；探针两瑕疵（commit DAG parent 闭包、ref CAS 未证）
转为实现期首批验收义务（§7.6/§9）。

## 1. 总构型（r1 结论摘要图 + 增量）

```text
浏览器 UI（Svelte 5 编译产物；三视角壳零回归）
  │ 同源 localhost；只持本机短期 console capability
  ▼
sidecar 控制面 /sidecar/*（Host 守卫 + 写路由精确 Origin——既有纪律不变）
  │  新增：/sidecar/plugins/*（插件注册表/启停/配置/状态——本机管理面）
  │
  ├── webui 插件宿主（进程内注册表 + 生命周期 + 权限 + 状态）
  │     ├── 内置插件：ports / files / sync（workspace 包，编译期注册）
  │     ├── 「即将推出」占位：vpn/clash/ai/ssh/screen（无实现，面板 flag）[W6]
  │     └── UI：类型化静态页面注册（复杂页=插件专属 Svelte 组件编入同一 bundle；
  │         通用 renderer 只承载简单配置/表格页）——无运行时远程 bundle/iframe [P2]
  │
  └── 数据面（跨设备）：client-sdk /http
        fetchHttp(session) ──Fabric 会话──▶ serveHttp(provider 侧插件端点)
        · 版本化插件路径（§3.2）；按 peer/share/operation deny-by-default 授权
```

控制面与数据面物理分离（r1 遗漏维度 1 的闭合）：`/sidecar/plugins/*` 永不承载
跨设备数据流；跨设备数据只走 Fabric 会话的 fetchHttp/serveHttp。`/ext/*` 不成为
本机 listener 上的新入口——本机管理面只有 sidecar 路由注册器一扇门。

## 2. 插件内核（宿主）

### 2.1 descriptor 与注册

- **WebUI 插件契约独立于 CLI apiVersion 1**（新 export 子路径
  `./opendweb-webui-plugin`；旧 `./opendweb-plugin` 契约零变化 [P6]）：
  `{ id, webuiApi: 1, pages: [{id,title,nav,icon,type,component?}], routes?: [...],
     dataEndpoints?: [...], configSchema }`——字段集在本 change spec delta 冻结。
- 内置三插件=workspace 包静态发现（编译期注册表）；**外部 npm 插件 v1 不加载
  运行时（r2-B6 收口）**：v1 面板只管理编译内置的 ports/files/sync 三插件的
  启停/配置；marketplace 的 CLI 插件候选**不**在 webui 面板呈现为「可安装/
  可启用的 WebUI 插件」（CLI 插件清单是独立入口）；「即将推出」占位（vpn/
  clash/ai/ssh/screen）与「外部 WebUI 插件=后续版本」并列标注。CLI `opendweb
  plugin add` 安装的是 `./opendweb-plugin` 命令插件，**不产生**可被 webui 启用的
  插件——两契约分版本并存，安装语义互不冒充。
- **UI 路由接入协议（r2-B5 冻结）**：
  - 静态 route registry（编译期生成）：`{routeId: "#/p/<pluginId>/<pageId>",
     component, nav 区, 视角可见性（admin|member|both）, title}`；routeId 全局
    唯一（前缀 `#/p/` 与既有路由空间隔离，routeFor 扩展消费该表）；
  - App.svelte 分派扩展：`#/p/*` → 查 registry → 命中且插件 enabled → 渲染
    组件；命中但 disabled/未知 → **按既有基线收敛语义**（未知 hash 收敛
    #/overview）处理；
  - 导航：SideNav 新增「工具」区（三视角通用；按视角可见性过滤行）；
  - 深链刷新=注册表重放（页面可达）；停用后深链=基线收敛（不残留死页）；
  - 既有路由（#/overview|#/lease|#/visits|#/tenants|#/visitors|#/online）
    行为零变化（零回归门覆盖）。
- **信任模型=可信插件**：用户显式安装的包在宿主 Node 权限内执行，v1 不宣称沙箱
  （manifest safeParse 不是沙箱——既有事实）。文档明示。

### 2.2 生命周期与停用语义（r1 遗漏维度 6 的闭合）

状态机：`registered → enabled`、`enabled ⇄ disabled`（两条有向转换：enable 与 disable 可往返；包卸载经 CLI；宿主只管启停）。
停用顺序：**先拒新请求**（路由/页/数据端点摘牌）→ 在途流 drain（有界超时，
默认 10s 可配，超时后强制取消并给稳定错误响应）→
dispose（定时器/watcher/事件订阅/锁释放）→ 状态落盘。enable 逆序装配。
崩溃恢复：状态文件原子写（0600+**同一持久文件系统内**临时文件+rename，沿用既有
纪律）；重启按落盘状态重建，半写状态由既有原子写纪律排除。

### 2.3 双账本（P6）

- 安装账本：既有 `~/.opendweb/plugins.json`（CLI 包锁）——只增不改语义。
- 运行账本：`<DWEB_HOME>/plugins/state.json`（启停/配置/授权，0600 原子写）+
  每插件数据目录 `<DWEB_HOME>/plugins/<id>/`（含 sync gitdir，§7.2）。
  两账本不混用；跨进程写沿用 acquireFileLock 家族。

## 3. 路由与授权

### 3.1 控制面（本机）

- `/sidecar/plugins`（GET 注册表+状态）、`/sidecar/plugins/<id>/enable|disable`
  （POST，精确 Origin 写路由纪律）、`/sidecar/plugins/<id>/config`（GET/PUT）。
- 浏览器新路径零秘密：插件面不接触 token/capability 之外的凭证；capability 语义
  沿用 v1（128-bit 单次消费 TTL 120s）。

### 3.2 数据面（Fabric 会话）

- 版本化路径：`/wpk1/<plugin>/<op>`（wpk1=协议版本前缀；演进靠版本化不靠字段漂移）。
- 授权表：serveHttp handler 以 `request.sessionId` 为隔离键（/http 既有注释语义），
  按 (peer endpointId, plugin, share/port, operation) **deny-by-default** 判定；
  授权数据落各插件的共享/映射账本（§5/§6），会话密码学身份=第一道门。

## 4. SDK 传输事实与使用边界（r1 地基事实 1-3 + r2-B1 修订）

- 请求体=静态分块（Array<Uint8Array>）——**v1 一切上行按 [W7] 有界**：
  ports 代理 8MiB 默认（可配范围 1MiB–64MiB 硬上限，超范围配置拒绝）；files 分片
  chunk 默认 4MiB；sync 对象单传默认 16MiB（超限对象 v1 拒绝并提示，pack 化后置）。
  未知 Content-Length 的入站请求 MUST 边读边累计、达到上限立即断开拒绝（不得先
  缓冲后判）；**跨请求并发累计内存预算 MUST 强制且额度冻结**：ports 并发代理
  ≤16 请求、files 并发传输（上传 chunk+读流合计）≤4、sync ≤2 流/组（既有），
  在飞字节预算=并发上限×各自上限值，超预算拒绝新请求直至回落（429 语义）。
- 响应体=pull-first AsyncIterable（流式 ✓）；SSE 走 respondStreaming。
- **取消两阶段协议（r2-B1 冻结）**：
  - 阶段 A（响应头等待期）：消费端 `request.signal.abort()` → 即时 RESET →
    provider `request.signal` 触发（既有 cancel-key 表语义）；
  - 阶段 B（响应体传输期）：`request.signal` 的取消键在响应头返回后已注销——
    消费端 MUST 监听本机下游连接断开并调用**响应句柄 `HttpClientResponse.abort()`**
    → RESET → provider `request.signal` 触发、上游 socket 收敛；
  - 两阶段各有独立 Scenario（§5/specs）；SSE/长下载属阶段 B。
- **完整性自证**（r1 地基事实 2）：recv 非成功终态映射为 EOF ⇒ 传输层 EOF 不可
  作为完整性证据；一切对象/分片带预期长度+OID/hash，落盘前校验。
- WS=字节隧道形态 ⇒ v1 无 WebSocket/raw TCP 透传（面板「即将推出」）[P3/Q3]。

## 5. ports 插件（端口共享）

- 消费侧映射账本 `<DWEB_HOME>/plugins/ports/mappings.json`：
  `{id, name, peer(endpointId), remotePort, localPort, enabled}`。
- 本机 net listener（默认且 v1 仅 127.0.0.1；非 loopback 监听属后续独立裁决，
  需本地鉴权设计——本 change 不做）
  → 逐请求 `fetchHttp(session, {path:"/wpk1/ports/proxy/<remotePort>", …})` →
  对端 handler 转发 `localhost:<remotePort>`。
- 提供侧 allowlist `<DWEB_HOME>/plugins/ports/allowlist.json`：
  `(peer, remotePort)` 显式授权，默认 deny；端口冲突明确报错不静默换端口。
- header 规则：hop-by-hop 头剥除清单冻结（connection/keep-alive/transfer-encoding/
  upgrade/proxy-*）；敏感回显头（server/via）重写。请求体上限 [W7]（含未知长度
  边读边拒）超限 413。
- 取消传播按 §4 两阶段协议执行（阶段 B=下游断开→resp.abort()）。
- 语义边界明示：HTTP 方法/头/体/状态码/SSE 透传；WS×（§4）；「等同直接访问」
  在 [W7] 有界范围内成立。

## 6. files 插件（文件夹共享）

- 提供侧共享账本 `<DWEB_HOME>/plugins/files/shares.json`：
  `{id, name, root(绝对路径), mode: ro|rw, peers[]}`；默认 ro；root 变更走账本。
- wire（`/wpk1/files/<shareId>/<op>`）：
  `GET list?path=` / `GET stat?path=` / `GET read?path=&offset=&len=`（流式响应+Range
  语义：offset/len+OID/etag 版本标识；重命名后由客户端重拉列表恢复）/
  `PUT chunk`（分片上传：{uploadId, seq, offset, bytes, chunkHash}→临时 staging；
  chunkHash=客户端声明块摘要，服务端从 bytes 重算比对——同幂等键
  (uploadId,seq,offset) 同内容幂等成功、不同内容明确拒绝不覆盖 [r4-N5 与
  delta 统一]）/ 
  `POST commit`（总长+hash 校验→原子 rename 落盘）/ `POST mkdir|rename|delete`。
- **路径安全（r2-B2 冻结：fd 链遍历，非 lstat+open）**：share root 以目录 fd
  打开并冻结（realpath 仅作展示）；**每操作从 root fd 按路径组件逐级打开**
  （每级拒绝 symlink——目录组件用 O_DIRECTORY+O_NOFOLLOW 语义，最终组件按操作
  类型带 O_NOFOLLOW），逐级持有父目录 fd 再开子组件（macOS 经 /dev/fd/<fd>/
  组合实现 fd 相对打开；win32 等效实现为实现期义务）；最终操作只作用于已验证
  fd（fstat 复核类型）。**中间目录组件被并发替换为指向 root 外 symlink 的逃逸
  Scenario 为验收门**（攻击者循环替换 vs 并发请求，断言 root 外零读写副作用）。
  若目标平台确无等效原语，降级边界=该平台 share root 限制为插件管理的受控目录
  （降级必须显式落文档，不得静默）。
- 上传重试语义（r2-B7 冻结；r4-N5 统一字段）：**幂等续传**——幂等键=
  (uploadId, seq, offset)，内容判据=chunkHash（同键同内容幂等成功/同键异内容
  明确拒绝不覆盖/伪造 chunkHash 即 bytes 重算不符=拒绝）；staging 按 uploadId
  目录化；`commit` 按序核对全部分片（总长+整文件 hash）后原子 rename，整文件
  摘要不匹配=整体拒绝；取消/TTL 过期回收整个 uploadId staging。
- 单请求/chunk 上限 §4；staging 带 TTL 回收，取消/断线不暴露半文件（临时名不进
  正式命名空间）。
- B 侧 UI（类型化专属页）：浏览/面包屑/上传（进度）/下载/改名/删除；写按钮按
  share.mode 与授权显隐。
- ignore：`<root>/.opendweb-ignore`（行 glob，忽略清单不下传——共享语义由提供侧定）。

## 7. sync 插件（文件同步）

### 7.1 引擎栈（Q5 冻结，探针实证）

**isomorphic-git（对象/refs/commit 底座）+ 自定义对象同步端点（无 git wire）+
自持三方树合并 + node-diff3 文本合并**。依赖：isomorphic-git、node-diff3
（纯 JS，workspace dependencies，随插件包内置）。

### 7.2 仓库布局与组模型

- 同步组账本 `<DWEB_HOME>/plugins/sync/groups.json`：
  `{id, name, members:[{endpointId, deviceName}], roots:[{localPath, seedAuthority}]}`。
- **组模型=多成员账本、双机执行（r2-B4 收窄 [W8]）**：账本/ref 命名自 v1 起
  记录 N 成员（每设备一个 ref `refs/devices/<endpointId>/main` + 组收敛 ref
  `refs/heads/main`）；**v1 同步执行与收敛保证只覆盖双机**（pairwise 两端语义：
  fetch 对端 device ref + 本地 merge + CAS 推进组 ref）；第三成员加入/追赶/
  多端 fan-in 顺序与收敛确定性为后续 change 的显式义务，v1 不承诺（存储形状
  兼容 ≠ N 端行为承诺——r2-B4 原话语义）。冲突身份=endpointId 排序稳定
  ours/theirs（r1 P5 要求）。
- gitdir 布局：`<DWEB_HOME>/plugins/sync/<groupId>/<rootId>/git`（独立于用户目录；
  工作树=用户目录 root 本体）；`<root>/.dweb-sync` 元数据（ignore 规则继承
  `.gitignore` 语义 + `.dweb-sync/exclude`）。
- [W9] 首次建组：UI 显式选一端为 seed authority（整树作基线提交）；另一端首拉
  前若工作树非空 → 阻断并给三方对照（不自动合并、不覆盖）。

### 7.3 对象同步端点（`/wpk1/sync/<groupId>/<rootId>/<op>`）

- `GET refs`（对端 refs 快照）；`POST want`（body：期望 commit + 已有 OID 摘要集
  （ Bloom/区间摘要——v1 用排序 OID 列表分页比对））→ 返回缺失对象清单；
  `GET object/<oid>`（单松散对象，带类型+长度+OID；>16MiB 拒绝 §4——引用该
  blob 的整个 push 拒绝且 ref/工作树不变，其他独立 root 或不含该 blob 的后续
  commit 不受影响；文件级跳过大对象=过滤树/commit 语义，非 v1）；
  `POST push`（commit DAG **parent 闭包** + 新对象集，staging 校验后 ref CAS）。
- **CAS**：push/ref 更新带 expectedOldRef；不匹配=拒绝+提示重 fetch/merge
  （r1 Q5：无 last-write-wins）。**单写者**：每 repo 同时只允许一个本地
  merge/ref writer（插件内互斥+账本锁）。
- 幂等：操作 id=对象 OID 天然幂等；staging 目录崩溃回收（启动扫描+TTL）。
- **闭包校验（r2-B7）**：`push` 收到的新 commit MUST 携带完整 parent 闭包 +
  树/blob 闭包；对象库缺任一引用对象 → 整个 push 拒绝（明确缺项清单）且
  **零 ref 变化**。

### 7.3.1 崩溃恢复协议（r2-B3 冻结：intent 日志 + 确定性 roll-forward）

工作树物化与 ref 推进 MUST 经单一持久化事务协议（不留二选一）：

1. **prepare**：在 gitdir 旁写 intent 日志（0600 原子写）：{txId, targetCommit,
   路径操作清单（write=path/oid、delete=path）, 旧 ref 快照}；
2. **物化**：逐操作执行——write 从对象库读内容→同文件系统临时文件→fsync→
   rename 到目标路径（逐文件原子）；delete 直接 unlink；每步幂等（重放安全）；
3. **推进**：ref CAS 到 targetCommit；
4. **提交标记**：intent 追加 done 标记（原子写）。
- **崩溃恢复（重启扫描；r4-N2 冻结：路径级三态 × ref 三态，先分诊后执行）**：
  发现未 done 的 intent →
  1. **ref 分诊**：`currentRef == targetCommit` → 物化与推进均视为完成，逐路径
     完成性核验（**只接受 postimage**；任一路径处于 preimage 或其他状态 →
     **不得补 done**：保留 intent 现场、进 conflicted 态，经用户决议形成新的
     同步提交后才清理）后仅补 done（**不得**再按旧快照 CAS，也不重放物化）；
     `currentRef == oldRef` → 进入路径分诊+物化，完成后 CAS；其他值 → 冲突：
     停止、保留现场、conflicted 态交用户。
  2. **路径分诊（仅 oldRef 分支执行）**：intent 的路径操作清单 MUST 记录每路径
     的预期前像 preimage（OID 或不存在）与目标后像 postimage（OID 或不存在），
     **判定元组=（OID，entry type，mode）**——OID 单独不可分辨 chmod/type 变化；
     实际状态==preimage → 应用该路径操作；实际状态==postimage → 该路径已完成
     （**引擎自己的半写不得误判为用户冲突**）；其他 → 用户新改动：保留内容、
     保留 intent 现场、转冲突，绝不静默覆盖。
  3. 全部路径完成且无冲突 → CAS → done；存在用户冲突路径 → conflicted 态
     （intent 保留至用户决议后继续）。
- 用户在同步根的未提交本地改动与协议的关系：物化前本地改动 MUST 已被
  commit 进 device ref（scanning 阶段保证）；扫描后到物化/恢复间的新改动由
  路径分诊第三态承接（保留+冲突）。
- **验收（B3）**：在 prepare 后/物化中/推进后/标记前四个边界逐个注入崩溃 →
  重启恢复后断言：文件内容、ref、用户未提交改动三者一致且无半成品。

### 7.4 合并算法（自持三方树合并）

1. 树分类：按 (base,ours,theirs) 树 diff 分类 add/modify/delete/type/mode；
2. 文本 blob（UTF-8、≤上限）：node-diff3（`stringSeparator:"\n"`——探针瑕疵修正
   已入档）非重叠自动合并；
3. 冲突分级（r1 P5）：**hunk 级**（重叠区逐块选 ours/theirs 或编辑）/ **文件级**
   （binary、超限、非 UTF-8、delete-modify、type/mode 冲突）；
4. 冲突记录持久化：base/ours/theirs OID + diff3 算法版本 + 用户决议（选块/选版/
   编辑后内容）——两端可复现；
5. merge driver 钩子：冲突 hunk 结构化输入（a/b/o 行数组）喂注册的 driver
   （AI merge 为未来 driver，v1 只留接口不自动写回 [W3] 边界）。
6. 删除传播：git 树语义自然承载；ignore/rename/case：v1 ignore=.gitignore 语义、
   rename=delete+add（不追踪）、大小写冲突=文件级冲突（大小写敏感文件系统语义）。

### 7.5 调度与预算

- 触发：会话在线事件 + 间隔兜底（默认 30s，节律纪律沿用 F1 家族）；本地变更
  扫描 debounce 2s。同步任务状态机：idle→scanning→fetching→merging→(conflicted)→
  pushing→done|error（UI 状态页+错误+重试+进度）。
- 预算（r1 遗漏维度 5）：单 blob ≤16MiB、单次同步对象数 ≤5000、总传输 ≤256MiB、
  并发会话流 ≤2/组；超预算明示拒绝与分批建议。GC：对象去重靠内容寻址；
  reflog 式清理=非首发。

### 7.6 实现期首批验收义务（探针未证路径，r1 Q5 补充证据边界）

commit DAG parent 闭包传输、ref CAS 并发拒绝、取消后 staging 回收、崩溃重启恢复、
类型/mode 冲突、超限对象——以上均须仓内可复跑测试（probe 原语整理为
packages/*/test 用例），并纳入 §9 双机验收矩阵。

## 8. 安全总表（Q7 冻结）

| 面 | 措施 |
|---|---|
| 浏览器→sidecar | Host 守卫+写路由精确 Origin（既有）；capability 单次消费；新面零 argv 凭证 [W11] |
| 会话→数据端点 | sessionId 隔离键；(peer,plugin,share/port,op) deny-by-default；版本化路径 |
| 路径 | §6 fd 链逐组件遍历（拒绝每级 symlink）+最终 fstat 复核+并发逃逸验收门 |
| 落盘 | 0600 原子写+symlink 拒绝（既有纪律，同一持久文件系统内临时文件+rename）；staging 临时名+TTL |
| 用户数据 | 不触碰 ~/.opendweb/nodes.json 等宿主数据；sync gitdir 独立；删除操作需 UI 确认 |
| 明文告知 | 沿用既有 insecure 披露模式（会话层 E2E，webui 本机回环） |
| 资源 | §4 上行有界（含未知长度边读边拒+并发累计预算）+§7.5 预算+两阶段取消传播 |

## 9. 分期与验收（Q8）

- **Phase 0 宿主**：descriptor/注册表/生命周期/双账本/控制面路由/「即将推出」占位；
  webui 既有面零回归门（三视角/五行分流/接入卡片全套测试）。
- **Phase 1 ports**：映射账本+listener+代理端点+allowlist+上限+取消传播；
  双机验收：mini `curl localhost:9090` ≡ iMac 8080（含 SSE）。
- **Phase 2 files**：先只读（list/stat/read/Range+UI 浏览下载）→ 再写
  （chunk/commit/mkdir/rename/delete+staging）；双机验收：mini 浏览/下载/上传
  iMac 共享目录；断线中途中断不产生半文件。
- **Phase 3 sync**：单向（seed/pull/跟随）→ 双向（commit/push/CAS/自动合并/
  冲突决议 UI/重连收敛）；双机验收矩阵（agents-skills 真目录）：单边变更跟随 /
  非重叠双方变更自动合并 / 重叠冲突→选版本→收敛 / 同步中断→恢复→两端 OID 与
  工作树一致 / [W9] 首次建组非空对端阻断；**协议边界（r2-B7 补入矩阵）**：
  push 缺 parent/树/blob 闭包→拒绝且 ref 不动 / 显式 abort→零 ref 与工作树
  变化+staging TTL 回收 / type 与 mode 冲突→文件级决议 UI / >16MiB 对象拒绝且
  ref 不动 / §7.3.1 四边界崩溃注入→roll-forward 收敛。
- 每 Phase 绿门：对应包 node --test + 既有套件全绿 + strict 校验；
  最终 Codex 实现终验 + Owner 双机实走。

### 9.1 真双机验收实录（iMac ↔ Mac mini，2026-09-29/30）

实现四阶段全绿（webui 256 / ext-ports 35 / ext-files 52 / ext-sync 49 /
client-sdk 95 / tray 26 / opendweb 245，strict 通过）后进入真双机验收，
两轮共抓出 **9 个真实缺陷**（单机/替身测试全部测不出的类别）：

**第一轮（cb6533a + 9e50d20）**：① NAPI 主入口 CJS 互操作（cjs-module-lexer
不识别命名导出，Fabric 须经 default 取）；② 首次 SDK 接触的已 join 设备无
roster（CLI join 纯 JS）→ open 失败回落 createRoot 采纳租约 fabricId；
③ endpointId z32↔hex 同钥异码（字母表+MSB-first 位序经 SDK ground-truth
校准）；④ 会话 peer 编码归一；⑤ 重启恢复双缺口（fabric 惰性触发只在 enable
转换 + 宿主恢复不重放 onEnable）；⑥ relay HTTP-only 无 QUIC 数据面 →
LAN 直连为主路径，invite 必须携带直连地址（advertiseAddrs/bindAddr env）；
⑦ member 句柄照抄 root 五步的 `ensureRelayCapabilities`（root-only）即
`RosterError::NotRoot`——新增内核 `rootEndpointId()` 姿态分流；⑧ hexToZ32
尾组对齐 bug（残余位须左移 MSB，末位为 1 的键产出错误末字符）；⑨ 回环 relay
死候选令 iroh dial 停滞不回落 direct → 签发/拨号双侧回环剔除。

**第二轮（abc3459）**：⑩ **member relay cap TTL 被钳到 invite 兑换窗口**
（`mint_for` 的 `.min(invite_expires_at_ms)`）——invite 默认 10 分钟 TTL
导致成员 10 分钟后失去 relay 访问、重启后永久无法重连（open 路径拨号零出站
停滞的根因）；活 spec（fabric/session「回执帧版本化」）冻结的是"长期 member
capability（TTL 上限 90 天）"，invite 过期是兑换防重放窗口、不是成员寿命。
同轮：NAPI release 产物 strip 损坏（cargo strip=true 经链接器产出
mis-aligned LINKEDIT 坏 Mach-O——profile 改 strip=false + 构建脚本
`strip -Sx`+codesign 后处理）；join_classification 的 DNS 失败假设在本机
mihomo Fake-IP 环境不成立（.invalid 解析进 198.18.0.0/15 且 TCP 可达）→
环境感知断言。

**验收里程碑（ports 等价性）**：mini `curl localhost:19090` → HTTP 200 /
42231B / python http.server 目录列表，与 iMac 直连 `127.0.0.1:8080` 等同；
member 重启（graceful）后 open 路径自动恢复（member 姿态+90d cap 注入+
relay ≤4s 连接）。

**进行中（深挖代理）**：⑪ 崩溃恢复不收敛——会话建立后成员被 kill -9，
仅重启成员不恢复（存活方陈旧对端会话/连续性状态掐死新会话
`continuity stream io: connection lost` + 重拨饿死 relay 退避；双侧重启
0.4s 收敛）；⑫ sidecar close()/TERM drain 挂死（健康 fabric 也复现，
两机多例）；⑬ 在位配对路由（POST /sidecar/fabric/join）干净状态终验
（此前 4 次停滞系僵尸同键端点环境污染，独立进程同代码稳定成功）。

**验收方法论沉淀**（全局 AGENTS.md）：cdylib 重建门禁必须含真实 dlopen；
Fake-IP 环境下网络假设测试需环境感知；kill 后必须验证死亡（TERM 被 drain
挂死吞掉真实存在，僵尸同身份端点是"新进程网络全断"的首要嫌疑）。

## 10. 评审处置表

| 轮 | 结论 | 处置 |
|---|---|---|
| r1 讨论 | 构型收敛：P1-P6/Q1-Q8 全裁定；五分歧→[W7]-[W11] 推荐裁决 | v1 全文吸收 |
| r2 设计评审 | NOT-READY 5/10：B1 取消两阶段混谈/B2 路径父组件竞态/B3 崩溃恢复二选一/B4 N 成员承诺过宽/B5 插件页路由未接线/B6 安装账本断链/B7 Scenario 缺口；另 W7 需硬上限、两处文档错误 | v2 全部闭合：§4 两阶段取消协议+硬上限（1-64MiB）+未知长度边读边拒+并发累计预算；§6 fd 链遍历+逃逸验收门+幂等续传冻结；§7.3.1 intent 日志+确定性 roll-forward+四边界注入；[W8]/§7.2 承诺收窄；§2.1 路由接入协议（#/p/ 前缀+registry+停用收敛）；§2.1 B6 收口（面板只管内置三插件）；§9 矩阵补 B7 五项；tmpfs→同文件系统临时文件+rename；0.0.0.0 误引 [W7] 删除 |
