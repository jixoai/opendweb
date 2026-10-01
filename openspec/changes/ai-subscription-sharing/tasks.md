# Tasks: ai-subscription-sharing

> 每门=可执行命令+阻断条件（r1-P1-7）。统一跑器=node --test（对齐仓库惯例）；
> worktree 内执行；e2e 双进程真内核。

## Phase A — 提供方纯逻辑 + wire 契约

- [ ] A1 包脚手架 `packages/opendweb-ext-ai`（scripts.test=node --test；
      README 含 ai-fly 致谢+upstream 标注约定+「不随包：codex OAuth/
      rust-fetch→后续 change」）
- [ ] A2 vendor 移植 provider 纯逻辑（secrets/store[raw key 沿用]/auth/
      limits/detail/rewrite/match-pattern/uri-template/upstream——engine 拆
      accept/catalog/forward 三文件）
- [ ] A3 auth 三族+env 二分法+两阶段导入器（staging blocked 清单/一次性
      commit/禁 env 快照）
- [ ] A4 presets 17 项+codex 占位+models-dev 长尾
- [ ] A5 wire ABI provider 端（端点表逐项+`x-odai-service` 剥离+gate 错误
      404 同体+catalog 长轮询）
- [ ] A6 单测：ai-fly 矩阵移植 + **wire 契约测试**（ABI 逐端点、404 同体
      三形态 byte 级断言、403/404/429 矩阵、413 边界 maxChunkPayload±1、
      gate op 名、admission 超积拒启）
- [ ] **A 门**：`cd packages/opendweb-ext-ai && npm test`（全绿）+
      `cd packages/webui && npm test`（零回归）。阻断：任一红。

## Phase B — 响应中继 + 消费方端点 + 竞态矩阵

- [ ] B1 中继状态机（epoch/rid/seq、租约、隐式提交、TTL 绝对 deadline、
      terminal arbiter、背压、跨重启幂等键）+ response/cancel 端点
- [ ] B2 上游转发（超时族/错误分族/abort 链）+ maxConcurrency 门 +
      dailyRequests/quota-day
- [ ] B3 consumer 本地端点（127.0.0.1/白名单/凭据头剥离/SSE 字节流 flush/
      错误 JSON）+ 钥环/`aifly1.` 导入 + fabric 宿主注入面接线
- [ ] B4 **竞态矩阵测试**（design §7.3 全清单：满 buffer×0/1/2 并发拉、
      cancel×done、租约过期、TTL×producing、epoch 重启、断线 90s 续拉、
      5MiB 长响应、并发撤钥三态）
- [ ] B5 e2e 双进程真内核（全链路+延迟目标 p95 断言）+ 泄露面扫描测试
- [ ] **B 门**：A 门 + `node --test test/e2e`（ext-ai）+ 三插件既有 e2e
      零回归。阻断：竞态矩阵任一红或 p95 超标。

## Phase C — UI 页组 + 占位替换 + 生命周期

- [ ] C1 descriptor 定稿+registry 注册+占位删除
- [ ] C2 UI 七接入点（route registry/bindings/页面组件/META）
- [ ] C3 `/sidecar/plugins/ai/*` 管理面+data-plane 双姿态装配+生命周期
      四步序（端点全关/在途 abort/启用恢复）
- [ ] C4 **C 门**：`cd packages/webui && npm test`（含 plugins-host/
      sidecar/route/wire 新增视角与生命周期用例）+ ui-dist/ui-compile +
      真浏览器走查（ego-browser 截图留 receipt：admin/member 两视角、
      启停生命周期、密钥本地复制仅本地面）。阻断：任一红或走查失败。

## Phase D — claude-code 写手 + 探活 + 预设验证

- [ ] D1 claude-code 写手（preview→diff→apply、sha256 token、占位符）
- [ ] D2 上游探活（provider 本机经同一 hook 管线发最小请求）
- [ ] D3 17 预设逐项冒烟（fake 上游断言头集/路径映射/auth 三族解析）
- [ ] **D 门**：ext-ai 全测 + 写手 preview/apply/回滚测试 + codex 占位
      呈现测试（`requires:"ai-codex-oauth"`）。阻断：任一红。

## Phase E — 收尾

- [ ] E1 specs 同步（plugins/ai 基线+webui spec 占位清单去 ai）+
      walkthrough 文档（AI 共享走查幕，含撤钥三态演示）
- [ ] **E 门（终验）**：全仓绿（webui npm test/opendweb/tray/ext 三包/
      dweb-server cargo）+ Codex 终审 GO → 归档（archive→merge main→push）
      + herdr 资源回收。
