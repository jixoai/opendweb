# Proposal: webui-plugin-kernel（webui 插件化内核 + 跨设备共享与同步首发三件套）

## Why

**内核能力齐了，但用户摸不到。** dweb 的 fabric 会话/身份/门禁/HTTP 传输
（fetchHttp/serveHttp，app-protocol-layer 已下沉 Rust + NAPI 绑定）已经能支撑
「跨设备的共享与同步」，但这些能力对用户只有 CLI 没有产品面；Owner 的刚需
（多台设备同步 agents-skills/prompt/wiki/configs）目前只能手动搬运。[W0][W4]

同时 webui 正在长胖：三视角控制台、节点簿、数据面……每加一个能力都在加厚
单体。[W5] 裁决把 webui 收敛为「服务启动、设备发现、认证、互联、管理」的薄核，
其余能力（含首发三件套与未来的 vpn/clash/AI/ssh/屏幕共享）全部走插件系统——
能力可拔插、生态可生长、核心可长期保持小。

## What Changes

1. **webui 插件内核**：插件注册面（console 页/导航项、sidecar 路由、能力声明）、
   插件生命周期（安装/启用/停用/卸载）、配置与状态落点；评估 Cordis kernel
   （@cordisjs/core）vs 自研最小核（设计轮冻结）；现有 CLI 级插件契约
   （./opendweb-plugin manifest，apiVersion 1）与 marketplace 不破坏。
2. **端口共享插件（首发 1/3）**：B 机把 A 机的 HTTP 服务（如 8080）映射为本机
   端口（如 9090），访问 B:9090 等同 A:8080；基于 fetchHttp/serveHttp 会话面。
3. **文件夹共享插件（首发 2/3）**：A 机声明共享目录，B 机在 webui 里做简单
   文件系统操作（浏览/上传/下载/改名/删除）；非 SMB wire，用户面是简单 FS 能力。
4. **文件同步插件（首发 3/3）**：虚拟 git 引擎内置（JS 技术优先候选
   isomorphic-git，设计轮冻结）；单向同步（跟随变更）与双向同步（push/pull +
   自动 merge + 冲突交还用户：选版本/看 git 冲突内容，AI merge 留钩子）。
5. **插件面板**：已装/可装/启用停用管理；vpn/clash/AI(ai-fly)/ssh/屏幕共享以
   「即将推出」占位。[W6]

## 验收锚点（真人故事）

- Owner 在两台真机（iMac + Mac mini）间建立一条 agents-skills 目录的双向同步：
  任一侧改动自动到达另一侧；两侧同时改同一文件时，能自动 merge 的自动合，
  不能的给冲突 UI（选版本/看冲突内容）；处理完再同步收敛。
- 端口共享：mini 上 `curl localhost:9090` 拿到 iMac 8080 服务的响应。
- 文件夹共享：mini 的 webui 里浏览/下载/上传 iMac 声明的共享目录内容。
- 既有 webui 三视角/五行分流/接入卡片零回归；既有插件（tray/webui manifest）零破坏。

## 依赖与边界

- 依赖 app-protocol-layer 已落地的 HTTP 传输面（fetchHttp/serveHttp NAPI +
  /http 子路径 exports）；该 change 尚在进行中（19/31）——本 change 只消费其
  已冻结面，不阻塞其收尾，也不替它做实现。
- raw TCP 级端口转发（ssh 等非 HTTP 服务）非首发（fetchHttp 是 HTTP 语义面）；
  「即将推出」档。
- 不内置 SMB 协议本体 [W0]。
- 涉及用户目录读写（同步目标）时：白名单声明 + 路径逃逸防护 + 既有用户数据
  （~/.opendweb/nodes.json 等）不触碰。
