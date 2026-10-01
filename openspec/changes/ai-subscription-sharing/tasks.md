# Tasks: ai-subscription-sharing

## Phase A — 提供方纯逻辑 + wire 面（单测绿门）

- [ ] A1 包脚手架：`packages/opendweb-ext-ai`（package.json/scripts=node --test、
      tsconfig、README 含 ai-fly 致谢与 upstream 标注约定）；webui workspace
      依赖接线（不触发注册——descriptor 在 Phase C 才入 registry）
- [ ] A2 vendor 移植 provider 纯逻辑：secrets/store/auth/limits/detail/
      rewrite/match-pattern/uri-template（ai-fly 源+同源标注；路径根
      `<DWEB_HOME>/plugins/ai/`；写原语换 opendweb atomicWrite0600 家族）
- [ ] A3 auth 槽三族收敛：删 `$env` 形态与间接引用、构造期拒绝、ai-fly 配置
      导入器（`$env` 条目整体失败+逐条列出）
- [ ] A4 presets 数据移植（providers.json 18 项+models-dev 长尾）
- [ ] A5 wire 帧移植（frames/z32/http-errors）+ `/wpk1/ai/v1/*` provider 端
      实现（auth/catalog 长轮询/request 元数据帧）
- [ ] A6 单测：ai-fly 矩阵移植（vitest→node --test）+ auth 三族/$env 拒绝/
      导入失败面 + wire op 全覆盖（fake fabric 注入）
- [ ] A7 绿门：`node --test`（ext-ai 包）+ webui/opendweb 既有套件零回归

## Phase B — 响应中继 + 消费方端点（e2e 绿门）

- [ ] B1 response ring buffer（有界 2MiB/请求、满暂停浅恢复、TTL 120s、
      responseId 状态机）+ `response/<rid>/<seq>` 分片拉取 + cancel 传播
- [ ] B2 上游转发（upstream.ts 移植：超时族/错误分族/abort 链）+ maxConcurrency
      在途门 + dailyRequests/quota-day 持久化
- [ ] B3 consumer 本地端点：127.0.0.1 listener（ports 纪律）、路由白名单、
      凭据头剥离、SSE 逐块 flush（首块立发+攒批常量）、413/限流错误 JSON
- [ ] B4 钥环 + 链接导入：`aifly1.` 信封解码、keyring.json 0600、auth 帧
      会话状态机（fabric=宿主注入面）
- [ ] B5 e2e 双进程真内核：全链路（导入→auth→请求→SSE 5MiB 长响应→撤钥
      drain→配额→重启持久化→断线 90s 续拉零重复/零丢失）
- [ ] B6 泄露面扫描测试（argv/env/日志/usage/stderr 零凭证断言）
- [ ] B7 绿门：A 门 + e2e 全绿 + 既有三插件 e2e 零回归

## Phase C — UI 页组 + 占位替换（webui 面绿门）

- [ ] C1 descriptor 定稿（pages≤3/configSchema/域校验工厂）+ registry 注册
      + `comingSoonPlugins()` 删 ai
- [ ] C2 UI 路由/组件：plugin-registry.ts、plugin-pages.ts 绑定层、
      `components/plugins/ai/` 页面（provider/consumer）+ PluginPanel META
- [ ] C3 `/sidecar/plugins/ai/*` 管理面（服务/分组/密钥/配额/用量；Host 守卫
      +精确 Origin）+ data-plane.mjs 双姿态装配 + 生命周期四步序（本地端点
      全关、在途 abort）
- [ ] C4 视角过滤测试（admin/member 各见各页）+ plugins-host/sidecar/route/
      wire 既有测试面零回归 + ui-dist/ui-compile 测试

## Phase D — codex 预设 + rust-fetch + 写手

- [ ] D1 codex hook 移植（auth.json 只读、头集、user-agent 去 codexHome 路径）
      + secret/file hook 脚本库（env.cjs 不存在）
- [ ] D2 rust-fetch 打包：crates/ai-rust-fetch + ext-ai-binary 包（pack.mjs
      vendored 模式）+ 发现顺序（显式路径>vendored>缺失降级
      `rust_fetch_unavailable`）
- [ ] D3 写手两件：codex config.toml / claude-code settings.json（preview→
      diff→apply、sha256 token、占位符 token）
- [ ] D4 D 门：codex 预设 e2e（真 ChatGPT 订阅路径由 Owner 手工验收留 receipt；
      自动化覆盖降级路径与头集断言）

## Phase E — 收尾

- [ ] E1 specs 同步（plugins/ai 基线 + webui spec 面板范围措辞：占位清单去掉
      ai）+ walkthrough 文档（AI 共享走查幕）
- [ ] E2 全仓绿门（webui 262 面+全包+tray）+ Codex 终审 → 归档
