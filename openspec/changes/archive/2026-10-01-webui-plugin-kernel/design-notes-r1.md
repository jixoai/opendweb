# webui-plugin-kernel 设计讨论底稿（r1 —— 供 Codex 构型讨论）

> 状态：strawman（稻草人提案）。本文是协调者的**开场提案+开放问题**，不是冻结设计。
> 目标：与 Codex 逐项对撞后收敛出 design.md v1。
> 输入：requirements.md（[W0]-[W6] Owner 裁决逐字）、proposal.md、
> app-protocol-layer/design.md（HTTP 传输地基，进行中 19/31）、
> packages/opendweb 插件契约（./opendweb-plugin manifest apiVersion 1 + marketplace）、
> packages/webui 现构型（core/壳分层 + 三视角控制台 + sidecar 数据面，home-hub 产物）。

## 0. 总构型（提案）

```text
┌────────────────────────────────────────────────────────────┐
│ webui 薄核（保留 [W5]：服务启动/设备发现/认证/互联/管理）      │
│  sidecar 生命周期·配对·节点簿·三视角壳·tray 面（既有零回归）   │
├────────────────────────────────────────────────────────────┤
│ 插件宿主（进程内注册表 + 生命周期：安装/启用/停用/卸载）        │
│  插件面契约：                                               │
│   a. console 页与导航项（页注册）                            │
│   b. sidecar 路由（本机管理面 /ext/<plugin>/* + 既有 Origin 纪律）│
│   c. 能力声明（端口映射/共享/同步 → 复用核的设备与会话）        │
│   d. 配置/状态落点 <DWEB_HOME>/plugins/<name>/…（锁协议沿用）  │
├────────────────────────────────────────────────────────────┤
│ 传输面（全部走 dweb 会话，不新开网络面）                      │
│  fetchHttp / serveHttp（app-protocol-layer 已下沉 Rust+NAPI） │
└────────────────────────────────────────────────────────────┘
```

首发三插件 = 端口共享（ports）、文件夹共享（files）、文件同步（sync），
均为仓库内 workspace 包 + 既有 marketplace 形态可安装。

## 1. 我的立场（供挑战）

### P1 插件内核：v1 自研最小宿主，不引 Cordis（留迁移位）

- **理由**：Cordis 的核心价值是可逆副作用+响应式 DI 的热插拔安全，面向的是
  Koishi 那种第三方生态规模；我们 v1 的插件=内置+marketplace 安装，进程内注册表
  +停用清理纪律已够；且 webui UI 是 Svelte 5 runes 编译产物，Cordis 的响应式
  与 runes 双响应系统并存是长期摩擦点；新框架=学习/调试/供应链三成本。
- **迁移位**：宿主接口化（生命周期钩子/路由注册/页注册的 interface），
  若生态规模化再换 Cordis 内核不改插件面契约。
- **让步条件**：若 Codex 论证 v1 就需要运行时热卸载/第三方沙箱，则重议。

### P2 UI 插件面：v1「manifest 类型化页面 + 通用渲染器」，不做组件级动态加载

- 插件 manifest 声明页类型（列表/详情/表单/文件浏览器/冲突处理器等类型），
  核心用通用组件渲染；逃生舱=预留 slot 扩展点。
- 组件 bundle 动态 import / iframe 沙箱为 v2+（生态需要时）。
- 三首发所需页型：映射管理列表、共享目录浏览器、同步任务状态+冲突 UI
  （双版本并排/选择/冲突内容展示）。

### P3 端口共享：消费侧定义映射，HTTP 语义面先行

- B 机持有映射簿 {name, 对端设备, 对端端口, 本机端口}；本机起 node 监听 →
  逐请求 fetchHttp(session) 到 A 机 serveHttp 的插件端点
  （如 /ext/ports/proxy/<对端端口>）→ A 端插件转发 localhost:<对端端口>。
- method/headers/body/状态码透传；SSE 依 fetchHttp 流语义；
  **WS 升级依赖 app-protocol-layer 的 WS 面——非首发能力，标注**；
  raw TCP（ssh 等）非首发（「即将推出」）。
- 授权：fabric 会话本身=密码学认证；A 端插件层再加共享粒度 allowlist；
  本机监听默认 127.0.0.1（0.0.0.0 需显式）。

### P4 文件夹共享：自定义 REST FS 面（非 WebDAV/SMB）

- A 机共享簿 {root, 权限 ro|rw, 授权对象}；插件 serveHttp 端点：
  GET list/stat、GET read（range）、PUT write、POST mkdir/mv/rm。
- B 机 webui 文件浏览器（浏览/面包屑/上传/下载/改名/删除）。
- 安全：realpath 包含检查（禁逃逸）、默认不跟随 symlink、单请求大小上限、
  大文件 range 分块（对齐 fetchHttp 分块能力——待核对 §3.4）。

### P5 文件同步：isomorphic-git 引擎 + 自定义同步端点（核心风险点，见 Q5）

- 每个同步根=虚拟 git 仓库（gitdir 藏于同步根旁或集中管理，不污染用户目录
  语义——待设计冻结）；身份 author=设备 endpoint 缩写+机器名。
- 单向 = 只读镜像（fetch + fast-forward，服务侧变更自动跟随）；
- 双向 = fetch + merge（clean 自动合）+ push；冲突 → pending 冲突列表 +
  冲突 UI（选版本/看冲突内容），AI merge=预留 merge driver 钩子位。
- 触发：会话在线事件 + 间隔兜底（节律纪律沿用 F1 家族）。

### P6 配置/状态与 marketplace 关系

- 三插件状态落 DWEB_HOME（ports.json/shares.json/syncs.json 或插件目录制）；
  跨进程写沿用 acquireFileLock 家族。
- CLI 级 opendweb plugin add/marketplace 继续管**包安装**；
  webui 插件面板管**启用/停用/配置**（安装也可从面板触发 CLI）。

## 2. 开放问题（请逐项裁定/挑战）

- **Q1 Cordis vs 自研最小宿主**（P1 的对撞：v1 生命周期面到底要多大？热插拔
  是否刚需？双响应系统摩擦是否被我高估？）
- **Q2 UI 插件面形态**（类型化页面够不够三首发+冲突 UI？组件 bundle/iframe
  何时引入？）
- **Q3 端口共享细节**：映射簿归属/本地端口冲突策略/WS 与 raw TCP 的档位划线；
  A 端 allowlist 粒度（按设备/按端口）。
- **Q4 文件夹共享 wire**：自定义 REST vs WebDAV 子集；大文件与断点续传对齐
  fetchHttp 的实际能力（需对照 app-protocol-layer §3.4 的 body 分块/取消语义）。
- **Q5 同步引擎与传输（本 change 最大技术风险）**：
  isomorphic-git 客户端完整但**官方不提供 server 面**（git smart HTTP 的
  upload-pack/receive-pack 端点需自实现）。候选路：
  a. 自实现最小 git smart HTTP server（refs 广告+pack 协商——工程重、协议深）；
  b. 不走 git wire：插件端点传 refs+packfile/对象流（isomorphic-git 内部
     objects/pack API 能否支撑导出/导入？）；
  c. 换引擎：gitoxide（Rust server 面完整，但要新 NAPI 面，工程量前置）；
  d. 简化模型：快照+manifest+delta（放弃真 git 语义——与 [W3] 冲突，不倾向）。
  请裁定：v1 选型与降级路径；「无法自动 merge」的冲突面精度（行级 vs 文件级）。
- **Q6 插件生命周期与既有 CLI 插件契约/marketplace 的分层**（安装=CLI 包面、
  启停=webui 面的切分是否成立；tray/webui 自身是否迁为内核插件）。
- **Q7 安全审查清单**：同步目标目录的用户数据保护、共享默认 deny、
  端口监听面、路径逃逸、token 纪律延续、明文告知位。
- **Q8 分期与验收**：内核→ports→files→sync 的相位划分；真双机验收复用
  iMac+Mac mini 环境（agents-skills 目录双向同步为验收主故事）。

## 3. 既有地基盘点（讨论的事实底座）

- fetchHttp/serveHttp：client-sdk NAPI 已绑定（fabric.serve_http /
  session.fetch_http），/http 子路径 exports；引擎在 Rust（Owner 09-16 裁决）。
- 插件契约：./opendweb-plugin manifest（apiVersion 1：name/commands/args JSON
  Schema/run envelope {command,args,log,cwd,stdout,stderr}）+ marketplace
  globs（npm:@jixo/opendweb-ext-*, npm:opendweb-*）+ foldSingleCommand 直达。
- webui 现构型：src/core（sidecar/home/console/capability/cardkit）+ ui（Svelte 5）
  + 五行分流 + 三视角 + /sidecar 数据面（Origin 严格策略）。
- 安全基线：token 0600/链内注入；member 负向矩阵；0600 原子写+symlink 拒绝。
