# Tasks: ai-subscription-sharing

> 每门=工作目录+完整命令+预期退出码 0+receipt 路径+阻断条件（r2-P1-H）。
> 统一跑器=node --test；worktree 根=/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-wt-ai
> （下文 `$WT`）；receipt 落 `docs/receipts/ai-plugin/`。

## Phase A — 提供方纯逻辑 + wire 契约

- [ ] A1 包脚手架 `packages/opendweb-ext-ai`（scripts.test=node --test；
      README：ai-fly 致谢+upstream 标注约定+「codex OAuth/rust-fetch→后续
      change ai-codex-oauth」）
- [ ] A2 vendor 移植 provider 纯逻辑（secrets/store[raw key 沿用]/auth
      [groups 多 key]/limits/detail/rewrite[删 $env+auth 路径 env fallback]/
      match-pattern/uri-template/upstream——engine 拆 accept/catalog/forward）
- [ ] A3 auth 三族+env 净化（hook 子进程 allowlist env）+keyEnv→secret 绑定
      门+两阶段导入器
- [ ] A4 presets 17 项+codex 占位+models-dev 长尾
- [ ] A5 wire ABI provider 端（header framing 端点表逐项+`x-odai-service`
      单源+gate 内 404 同体+catalog 长轮询+256KiB/256 服务上限）
- [ ] A6 单测：ai-fly 矩阵移植+wire 契约测试（design §7.2 全清单）
- [ ] **A 门**：`cd $WT/packages/opendweb-ext-ai && npm test`（退出码 0）+
      `cd $WT/packages/webui && npm test`（退出码 0，零回归）。阻断：任一非 0。

## Phase B — 响应中继 + 消费方端点 + 竞态矩阵

- [ ] B1 中继状态机（per-rid 互斥锁/单飞拉取/连续提交游标/204 hold/空闲
      TTL+绝对寿命 10min/done body 弃+摘要 LRU/epoch CSPRNG）+
      response/cancel 端点
- [ ] B2 上游转发（超时族/错误分族/abort 链）+maxConcurrency 门+keyId 绑定
      （quota/usage/撤钥）+dailyRequests/quota-day
- [ ] B3 consumer 本地端点（127.0.0.1/白名单/凭据头剥离/SSE 字节流 flush/
      错误 JSON）+钥环/`aifly1.` 导入+fabric 宿主注入面接线
- [ ] B4 竞态矩阵测试（design §7.3 全清单）
- [ ] B5 e2e 双进程真内核（全链路+延迟目标 p95）+泄露面扫描测试
- [ ] **B 门**：A 门 + `cd $WT/packages/opendweb-ext-ai && node --test
      test/e2e/`（退出码 0）+ 三插件既有 e2e 零回归。阻断：竞态矩阵任一
      非 0 或 p95 超标。receipt：`docs/receipts/ai-plugin/phase-b-e2e.md`
      （命令+输出尾+延迟 p95 表）。

## Phase C — UI 页组 + 占位替换 + 生命周期

- [ ] C1 descriptor 定稿+registry 注册+占位删除
- [ ] C2 UI 七接入点（route registry/bindings/页面组件/META）
- [ ] C3 `/sidecar/plugins/ai/*` 管理面+data-plane 双姿态装配+生命周期
      四步序（端点全关/在途 abort/启用恢复）
- [ ] C4 真浏览器走查（ego-browser）：admin/member 两视角截图、启停生命
      周期、密钥本地复制仅本地面
- [ ] **C 门**：`cd $WT/packages/webui && npm test`（含新增视角/生命周期
      用例，退出码 0）+ `npm run -w packages/webui build`（退出码 0）+
      ui-compile。阻断：任一非 0 或走查失败。receipt：
      `docs/receipts/ai-plugin/phase-c-walkthrough.md`（截图路径+步骤记录）。

## Phase D — claude-code 写手 + 探活 + 预设验证

- [ ] D1 claude-code 写手（preview→diff→apply、sha256 token、占位符）
- [ ] D2 上游探活（provider 本机经同一 hook 管线发最小请求）
- [ ] D3 17 预设逐项冒烟（fake 上游断言头集/路径映射/auth 三族解析/keyEnv
      未绑定不可启用）
- [ ] **D 门**：`cd $WT/packages/opendweb-ext-ai && npm test`（退出码 0，
      含 D1-D3 新用例+codex 占位呈现）。阻断：任一非 0。

## Phase E — 收尾

- [ ] E1 specs 同步（plugins/ai 基线+webui spec 占位清单去 ai）+
      walkthrough 文档（AI 共享走查幕，含撤钥三态演示）
- [ ] **E 门（终验）**：
      `cd $WT && openspec validate ai-subscription-sharing --strict`（0）；
      `cd $WT/packages/webui && npm test`（0）；`cd $WT/packages/opendweb &&
      npm test`（0）；`cd $WT/packages/tray && npm test`（0）；
      `cd $WT/packages/opendweb-ext-ai && npm test`（0）；
      `PATH="$HOME/.cargo/bin:$PATH" CARGO_TARGET_DIR="$HOME/.cargo-target/dweb"
      cargo test -p dweb-server -j2 -- --test-threads=1`（0，零回归）；
      Codex 终审 GO → 归档（archive→merge main→push）+ herdr 资源回收
      （`herdr agent get codex-ai-r1` 确认退出→`herdr workspace close w82`）。
      阻断：任一非 0 或终审 NOT-READY。receipt：
      `docs/receipts/ai-plugin/phase-e-final.md`（全命令输出摘要+终审评分）。
