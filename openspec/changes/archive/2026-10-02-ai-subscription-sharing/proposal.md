# Proposal: ai-subscription-sharing（AI 订阅共享插件——webui 内置第四插件）

## Why

**[W6] 的「AI」占位要兑现，而实现已经在别处长好了。** Owner 裁决（2026-10-01）：
下一个插件 = AI 订阅共享，**基于 ai-fly 的代码**（/Users/kzf/Dev/GitHub/ai-fly，
v0.6.0，约 19k 行）。ai-fly 是「把一个 AI 订阅/上游通过邀请制 P2P 网络共享给
朋友」的完整实现：18 个上游预设（OpenAI/Anthropic/Gemini/DeepSeek/Z.ai/Kimi/
Copilot/ollama…含 ChatGPT Codex 订阅 OAuth 登录态共享）、双层凭证（设备邀请 +
分组密钥）、按 key 配额审计、本地回环网关——而且**数据面本来就跑在
opendweb fabric 上**（@jixo/opendweb-client-sdk 的 Fabric/fetchHttp/serveHttp）。

webui-plugin-kernel 归档后，内核具备了插件注册/生命周期/数据面
（/wpk1/<plugin>/<op> + deny-by-default）的完整承接力；本 change 把 ai-fly 的
引擎移植为 webui 内置插件 `ai`，替换「即将推出」占位，让「朋友的 ChatGPT
订阅，我的本地端口」成为装机即得的体验。

## What Changes

1. **新 workspace 包 `packages/opendweb-ext-ai`**（@jixo/opendweb-ext-ai）：
   ai-fly 适配源码的 vendor 落点（保留 upstream 出处标注；ai-fly 仓库仍是
   上游参照，不反向修改）。WebUI 插件契约（webuiApi 1）注册为内置第四插件，
   替换 `comingSoonPlugins()` 的 `{id:"ai"}` 占位。
2. **提供方（admin 视角）**：服务/分组/密钥管理（0600 密钥库+哈希+撤钥三态
   冻结）、上游预设与凭证注入（auth 槽=`{secret}|{script}|{literal}` 三族
   ——**$env 凭证族按 W11 纪律移除**，env 按凭证/运行时二分法处理）、hooks
   管线、按 key 配额与 usage 审计（元数据 only）。
3. **消费方（member 视角）**：每授权服务一个 127.0.0.1 本地端点（ports 插件
   同款 loopback 纪律），路由白名单、消费方凭据头剥离、SSE 字节流透明中继
   （保序+延迟目标）、WS v1 不宣称；claude-code 配置写手 preview→确认。
4. **wire 面 `/wpk1/ai/v1/*`**：JSON-over-HTTP ABI（对齐 ai-fly 现行 HTTP
   投影形态的 wpk1 化重述）；请求体 ≤1MiB−4KiB 单片；**响应=分片拉取中继**
   （状态机+租约+TTL+背压；每片独立完整 wpk1 调用，天然落在内核包络内，
   响应总量无上限）——LLM 长响应不被单流预算误伤；gate 错误面统一 404 同体。
5. **准入面**：复用 fabric 邀请（dweb1.，设备层）+ 插件分组密钥（应用层，
   沿用 ai-fly `sk-aifly-`/`aifly1.` 语法）；分享链接=邀请+密钥信封；
   raw key 可选落盘沿用上游 Owner 裁决（远程面恒掩码）。

## 验收锚点（真人故事）

- mini（member）在 webui「AI」页贴入 iMac 分享的链接 → 本机出现 OpenAI/
  Anthropic 兼容本地端点 → agent base URL 指过去跑通一次真实流式会话（SSE
  保序、长响应 >4MiB 完整送达、延迟目标 p95 达标）。
- iMac（admin）撤掉 mini 那把 key → 三态语义冻结生效（新请求即刻被拒、
  在途按态 drain/abort）。
- 全链路零凭证泄露：key/上游密钥不出现在 argv/凭证 env/URL/日志/浏览器状态
  （W11 纪律继承，测试断言）。
- 既有三插件与 webui 基座零回归。

## 依赖与边界

- 依赖 webui-plugin-kernel 已冻结面：descriptor 契约、插件数据目录纪律
  （0700 目录/0600 原子写/锁家族）、`/wpk1/*` wire 门控、loopback listener
  先例（ports）。
- 依赖 client-sdk 会话面（fetchHttp/serveHttp/direct-only [W12]）现状，
  不新增内核需求；内核包络若需调整（响应流预算），单独提出，不搭车。
- ai-fly 的桌面壳（OpenTray/oRPC/web-server token 门禁）**不移植**——
  webui 宿主替代其全部职责。
- **codex 预设（ChatGPT 订阅 OAuth 登录态）、rust-fetch sidecar、codex
  写手拆后续 change `ai-codex-oauth`**（r1 评审征询③采纳——核心协议
  正确性与高风险平台集成解耦）；v1 预设表 17 项+codex 占位。
- CLI 插件面（./opendweb-plugin）v1 不做（WebUI-only；后续另议）。
- ai-fly 的 $env 凭证族（W11 收敛）、无沙箱 hook 执行模型（信任模型 v1
  沿用内核「可信插件」并文档明示）。
- Linux 支持：受 client-sdk 原生二进制覆盖面约束（darwin-arm64/win32-x64）。
