# webui-plugin-kernel 技术设计 v1

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
| [W8] | 同步组=多成员数据模型（每设备一 ref：refs/devices/<endpointId>/main）；v1 验收双机；组模型不加 schema 迁移可扩 N 端 | 推荐（W4「多台」导出），待追认 |
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
- 内置三插件=workspace 包静态发现（编译期注册表）；外部 npm 插件 v1 不加载运行时
  （面板可列出 marketplace 候选+「安装需 CLI」引导 [W10]）。
- **信任模型=可信插件**：用户显式安装的包在宿主 Node 权限内执行，v1 不宣称沙箱
  （manifest safeParse 不是沙箱——既有事实）。文档明示。

### 2.2 生命周期与停用语义（r1 遗漏维度 6 的闭合）

状态机：`registered → enabled ⇄ disabled`（包卸载经 CLI；宿主只管启停）。
停用顺序：**先拒新请求**（路由/页/数据端点摘牌）→ 在途流 drain（有界超时）→
dispose（定时器/watcher/事件订阅/锁释放）→ 状态落盘。enable 逆序装配。
崩溃恢复：状态文件原子写（0600+tmpfs rename，沿用既有纪律）；重启按落盘状态重建，
半写状态由既有原子写纪律排除。

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

## 4. SDK 传输事实与使用边界（r1 地基事实 1-3 的冻结陈述）

- 请求体=静态分块（Array<Uint8Array>）——**v1 一切上行按 [W7] 有界**：
  ports 代理 8MiB 默认（可配）；files 分片上传 chunk 默认 4MiB；sync 对象单传
  默认 16MiB（超限对象 v1 拒绝并提示，pack 化后置）。
- 响应体=pull-first AsyncIterable（流式 ✓）+ 双向取消（provider AbortSignal /
  消费端 signal）——SSE 走 respondStreaming。
- **完整性自证**（r1 地基事实 2）：recv 非成功终态映射为 EOF ⇒ 传输层 EOF 不可
  作为完整性证据；一切对象/分片带预期长度+OID/hash，落盘前校验。
- WS=字节隧道形态 ⇒ v1 无 WebSocket/raw TCP 透传（面板「即将推出」）[P3/Q3]。

## 5. ports 插件（端口共享）

- 消费侧映射账本 `<DWEB_HOME>/plugins/ports/mappings.json`：
  `{id, name, peer(endpointId), remotePort, localPort, enabled}`。
- 本机 net listener（默认 127.0.0.1；0.0.0.0 需 [W7] 级追认+本地鉴权设计——v1 不做）
  → 逐请求 `fetchHttp(session, {path:"/wpk1/ports/proxy/<remotePort>", …})` →
  对端 handler 转发 `localhost:<remotePort>`。
- 提供侧 allowlist `<DWEB_HOME>/plugins/ports/allowlist.json`：
  `(peer, remotePort)` 显式授权，默认 deny；端口冲突明确报错不静默换端口。
- header 规则：hop-by-hop 头剥除清单冻结（connection/keep-alive/transfer-encoding/
  upgrade/proxy-*）；敏感回显头（server/via）重写。请求体上限 [W7] 超限 413。
- 取消传播：本地连接断开 → fetchHttp abort → 对端 handler signal。
- 语义边界明示：HTTP 方法/头/体/状态码/SSE 透传；WS×（§4）；「等同直接访问」
  在 [W7] 有界范围内成立。

## 6. files 插件（文件夹共享）

- 提供侧共享账本 `<DWEB_HOME>/plugins/files/shares.json`：
  `{id, name, root(绝对路径), mode: ro|rw, peers[]}`；默认 ro；root 变更走账本。
- wire（`/wpk1/files/<shareId>/<op>`）：
  `GET list?path=` / `GET stat?path=` / `GET read?path=&offset=&len=`（流式响应+Range
  语义：offset/len+OID/etag 版本标识；重命名后由客户端重拉列表恢复）/
  `PUT chunk`（分片上传：{uploadId, seq, offset, bytes}→临时 staging）/ 
  `POST commit`（总长+hash 校验→原子 rename 落盘）/ `POST mkdir|rename|delete`。
- **路径安全**（Q7）：share root realpath 冻结 + 每操作对解析后路径做包含校验 +
  **禁 symlink 跟随**（O_NOFOLLOW 语义：lstat 校验后打开，检查-打开竞态用打开后
  fstat 复核——r1 遗漏维度的落点）；单请求/chunk 上限 §4；staging 带 TTL 回收，
  取消/断线不暴露半文件（临时名不进正式命名空间）。
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
- **组模型=多成员**（[W8]）：每设备一个 ref `refs/devices/<endpointId>/main` +
  组收敛 ref `refs/heads/main`（快进/合并可解析时）；冲突身份=endpointId 排序
  稳定 ours/theirs（r1 P5 要求）。
- gitdir 布局：`<DWEB_HOME>/plugins/sync/<groupId>/<rootId>/git`（独立于用户目录；
  工作树=用户目录 root 本体）；`<root>/.dweb-sync` 元数据（ignore 规则继承
  `.gitignore` 语义 + `.dweb-sync/exclude`）。
- [W9] 首次建组：UI 显式选一端为 seed authority（整树作基线提交）；另一端首拉
  前若工作树非空 → 阻断并给三方对照（不自动合并、不覆盖）。

### 7.3 对象同步端点（`/wpk1/sync/<groupId>/<rootId>/<op>`）

- `GET refs`（对端 refs 快照）；`POST want`（body：期望 commit + 已有 OID 摘要集
  （ Bloom/区间摘要——v1 用排序 OID 列表分页比对））→ 返回缺失对象清单；
  `GET object/<oid>`（单松散对象，带类型+长度+OID；>16MiB 拒绝 §4）；
  `POST push`（commit DAG **parent 闭包** + 新对象集，staging 校验后 ref CAS）。
- **CAS**：push/ref 更新带 expectedOldRef；不匹配=拒绝+提示重 fetch/merge
  （r1 Q5：无 last-write-wins）。**单写者**：每 repo 同时只允许一个本地
  merge/ref writer（插件内互斥+账本锁）。
- 幂等：操作 id=对象 OID 天然幂等；staging 目录崩溃回收（启动扫描+TTL）。

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
| 路径 | root realpath 冻结+包含校验+禁 symlink+打开后 fstat 复核 |
| 落盘 | 0600 原子写+symlink 拒绝（既有纪律）；staging 临时名+TTL |
| 用户数据 | 不触碰 ~/.opendweb/nodes.json 等宿主数据；sync gitdir 独立；删除操作需 UI 确认 |
| 明文告知 | 沿用既有 insecure 披露模式（会话层 E2E，webui 本机回环） |
| 资源 | §4 上行有界+§7.5 预算+请求取消传播 |

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
  工作树一致 / [W9] 首次建组非空对端阻断。
- 每 Phase 绿门：对应包 node --test + 既有套件全绿 + strict 校验；
  最终 Codex 实现终验 + Owner 双机实走。

## 10. 评审处置表

| 轮 | 结论 | 处置 |
|---|---|---|
| r1 讨论 | 构型收敛：P1-P6/Q1-Q8 全裁定；六遗漏维度全部闭合进本 v1（§1 控制数据面分离/§2.2 停用语义/§7.2 组模型/§7.3 恢复/§7.5 预算/§2.1 信任模型）；五分歧→[W7]-[W11] 推荐裁决 | 本 v1 全文吸收 |
