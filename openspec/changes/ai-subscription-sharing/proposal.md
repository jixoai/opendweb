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
2. **提供方（admin 视角）**：服务/分组/密钥管理（0600 密钥库+哈希+撤钥实时
   生效）、上游预设与凭证注入（auth 槽收敛为 `{secret}|{file}|{literal}`
   三族——**$env 族按 W11 纪律移除**）、hooks 管线（含 codex OAuth 只读
   hook）、按 key 配额与 usage 审计（元数据 only）。
3. **消费方（member 视角）**：每授权服务一个 127.0.0.1 本地端点（ports 插件
   同款 loopback 纪律），路由白名单、消费方凭据头剥离、SSE 逐块透传、WS v1
   不宣称；agent 配置写手（codex/claude-code 的 base URL 写入）preview→确认。
4. **wire 面 `/wpk1/ai/v1/*`**：ai-fly 的 AUTH/目录/请求转发帧语义映射到
   wpk1 版本化前缀；请求体 1MiB 单帧分块（与 ports/files 同包络），**响应=
   增量帧序列（按帧预算、不设全程总量上限，流控背压）**——LLM 长响应不被
   2MiB 单流预算误伤（设计轮冻结精确语义）。
5. **rust-fetch sidecar（codex 预设的 Cloudflare 旁路）**：随包分发
   （server-binary 包的 vendored 二进制先例）；缺失时该预设显式降级报错，
   不静默失败。
6. **准入面**：复用 fabric 邀请（dweb1.，设备层）+ 插件自己的分组密钥
   （应用层）；分享链接 = 邀请+密钥组合信封，一次性展示。

## 验收锚点（真人故事）

- mini（member）在 webui「AI」页贴入 iMac 分享的链接 → 本机
  `127.0.0.1:4306` 出现 codex 兼容端点 → `OPENAI_BASE_URL` 指过去跑通一次
  真实 codex 会话（走 iMac 的 ChatGPT 订阅）。
- iMac（admin）撤掉 mini 那把 key → mini 在途请求完成后新请求即刻被拒。
- 全链路零凭证泄露：key/上游密钥不出现在 argv/env/URL/日志/浏览器状态
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
- CLI 插件面（./opendweb-plugin）v1 不做（WebUI-only；后续另议）。
- ai-fly 的 $env 凭证族、无沙箱 hook 执行模型（信任模型 v1 沿用内核
  「可信插件」并文档明示）。
- Linux 支持：受 client-sdk 原生二进制覆盖面约束（darwin-arm64/win32-x64）。
