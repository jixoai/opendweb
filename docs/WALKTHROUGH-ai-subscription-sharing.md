# 走查：AI 订阅共享（ai 插件）

> 前置：仓库根 `cd packages/webui && npm run build`（走查脚本需要 UI dist）。
> 一键演示环境：`node scripts/walkthrough/ai-demo.mjs`（`--exit` 自验退出；
> `--keep` 保留现场复检）。真实两机用法见末节。

## 第一幕 · 一键环境（双 home 假上游）

```sh
node scripts/walkthrough/ai-demo.mjs
```

脚本自动完成：A（提供方）存 secret→建服务 demo-openai（假上游 OpenAI 型
SSE）→分组 family→签发 key→生成 `aifly1.` 链接；B（消费方）导入链接→
AUTH→本地端点 `127.0.0.1:4310`。打印两端 UI URL 与自验结果（SSE 往返
PASS）。

## 第二幕 · 浏览器双视角

- A `…/#/p/ai/provider`：五 Tab——服务（列表/探活/启停/secret 绑定）、
  分组（限额）、密钥与链接（签发一次性展示/本地复制/撤钥）、用量与配额、
  导入（ai-fly 配置两阶段 staging）。
- B `…/#/p/ai/consumer`：贴链接→授权目录→本地端点（监听中）→写手接入
  （claude-code：预览 diff→确认应用，token 恒占位符）。
- 面板 `…/#/p/host/panel`：「AI 订阅共享」启停与三配置项（maxConcurrency/
  dailyRequests/usageLog）；「即将推出」只剩 VPN/Clash/SSH/屏幕共享。

## 第三幕 · 数据面验证（终端）

```sh
# 非流式
curl -s http://127.0.0.1:4310/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"demo-1","messages":[{"role":"user","content":"ping"}]}'
# 流式（SSE 分片逐块到达）
curl -N http://127.0.0.1:4310/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"demo-1","stream":true,"messages":[{"role":"user","content":"ping"}]}'
```

## 第四幕 · 撤钥三态演示

1. **单 key 撤销**：A 密钥 Tab 撤掉 B 在用的 key → B 新请求立即
   `403 key_revoked`；**在途流仍续拉至终态**（不撕裂）。
2. **会话全钥失效**：撤掉该会话全部 key → 5s 有界 drain（在途 settle 或
   abort `auth_revoked`）后 fabric 会话断开。
3. **面板停用**：B 面板停用 ai → 4310 立即完全关闭（连接拒绝）；A 面板
   停用 → B 端点显式 `502 upstream_unreachable`（绝不静默截断）。复启恢复。

## 第五幕 · 真实两机（iMac ↔ Mac mini）

1. 提供方机器：`opendweb webui`（admin）→ AI 订阅·提供方 → 从 17 预设选
   上游（keyEnv 类预设先在密钥库存 secret 并绑定）→ 分组 → 签发/
   生成链接（受邀方=对端设备 ID）。
2. 消费方机器：`opendweb webui`（member/已有租约）→ AI 订阅·消费方 →
   贴 `aifly1.` 链接 → 起本地端点 → claude-code 写手一键写入 base URL。
3. 注意：codex（ChatGPT 订阅 OAuth）预设显示「需后续版本」（拆分至
   `ai-codex-oauth` change）；凭证只走 0600 文件（W11 纪律——argv/env
   通道不存在）。
