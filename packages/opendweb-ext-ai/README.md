# @jixo/opendweb-ext-ai

opendweb webui 第四内置插件（id=`ai`）：AI 订阅共享——一台设备把自有 AI
上游（OpenAI/Anthropic/DeepSeek/Gemini/…）经 opendweb fabric 分享给同组
设备；对等设备在本地回环起 OpenAI/Anthropic 兼容端点供 agent 使用。

本包是 **ai-fly（v0.6.0）的 vendor 适配**，不改上游、不改内核。

## ai-fly 致谢与 upstream 标注约定

- 上游仓库：ai-fly（本地只读参照；未随包分发、不被修改）。
- **每个自 ai-fly 移植的源文件头部保留一行标注**：

  ```
  // adapted from ai-fly src/provider/xxx.ts (v0.6.0)
  ```

  改动这些文件时保留标注；与上游的有意分歧在文件头注释中显式声明
  （例：`$env:` 凭证引用族删除、WS 透传不移植、codex 预设占位）。
- 与上游的主要分歧（design §0 冻结）：
  - 路径根 `<DWEB_HOME>/plugins/ai/`（上游 `~/.aifly/provider/`）；写原语
    换 opendweb `atomicWrite0600` 家族（O_EXCL tmp+fsync+rename+symlink 拒绝）。
  - **`$env:` 凭证引用族与 `hooks/env.cjs` 不存在**（W11 凭证纪律）；auth
    路径无 `process.env` fallback；auth 槽三族是凭证进入上游请求的唯一通道。
  - wire 常量族改名 `x-odai-*`（上游 `x-aifly-*`）；ABI 按
    `openspec/changes/ai-subscription-sharing/design.md` §3 冻结面实现。
  - WS 透传、桌面壳、自有 fabric 消费面不移植（宿主替代）。
  - store 不携带上游 legacy（pre-v2）迁移模式——本包数据目录是全新目录，
    ai-fly 旧配置经两阶段导入器（`src/provider/importer.mjs`）接入。

## codex OAuth 与 rust-fetch → 后续 change `ai-codex-oauth`

v1 **不随包**：codex 预设（ChatGPT OAuth 登录态）、`hooks/codex.cjs`、
rust-fetch sidecar、codex 写手。`src/presets/providers.json` 中 codex 条目
为占位（`{id:"codex", requires:"ai-codex-oauth", disabled:true}` 形态），
由后续 change `ai-codex-oauth` 承接（含 auth.json 只读 hook、rust-fetch
打包发现顺序、真订阅验收）。

## 目录

- `src/provider/` —— 提供方纯逻辑（secrets/store/auth/limits/detail/
  rewrite/match-pattern/uri-template/hooks/upstream + engine 三拆
  accept/catalog/forward + env 防线 envguard + 两阶段导入器 importer）。
- `src/presets/` —— 17 项精选预设 + codex 占位 + models.dev 长尾。
- `src/wire/` —— `/wpk1/ai/v1/*` header framing ABI（常量、schema、端点）。
- `test/` —— node --test（ai-fly 矩阵移植 + wire 契约测试）。

## 测试

```sh
npm test   # node --test --test-concurrency=1 --test-force-exit test/*.test.mjs
```
