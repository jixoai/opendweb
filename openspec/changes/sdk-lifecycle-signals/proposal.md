# Proposal: sdk-lifecycle-signals

## Why

0.5.0 复核（Codex NO-GO 7.1，2026-09-18）暴露的归档级缺口有一个共同根因：
**provider 侧 handler 对「请求归属哪个会话」「请求是否还被需要」一无所知**。

**授权隔离失效。** app-protocol-layer spec §3.2 承诺「授权按 session_id 缓存」；
但 SDK 事件只带 `streamId`，下游 ai-fly 的 ProviderPeerServer 只能按 peerId
长驻授权状态（`src/provider/engine.ts:146`）。同 peer 换新 session（重启进程/
换账号身份）时，新 session 在自己的 AUTH 完成前就能继承旧 grants 并通过
forward——spec 3.2 的会话级隔离在产品层根本无从实现。

**取消只能靠「下一次 write 报错」间接感知。** 对端 RESET 后内核丢弃 body
接收器，handler 若在等上游（SSE 首包前的长等待、慢工具调用）则永远学不到
取消；若在持续 write，也要等通道背压回流才见到错误。ai-fly 的慢任务因此
无法秒停——取消信号缺一条**事件驱动**的直达通路。

**StreamWriter 终态语义混一。** 0.5.0 评审冻结的遗留项（P2 → 0.6.0）：
`finished` 只是本地 finish() 标志；「本地已 finish」「底层投递通道已关」
「对端已取消」三个正交事实挤在一个状态位里，流式 handler 无法区分正常
收尾与被取消。

## What Changes

- **内核**（crates/dweb-fabric/src/continuity/http.rs）：
  - `HttpRequest` 新增 `session_id: u64` 与 `cancel: RequestCancel`；
  - 新增 `RequestCancel` 句柄：`wait() -> CancelOutcome`（Cancelled |
    Completed）——事件驱动（peer_reset 持久标志 + reset_notify 唤醒 +
    终态复查），不轮询；
- **N-API 桥**（packages/client-sdk/src/http.rs）：
  - request 事件 JSON 增 `sessionId`；
  - 新增 `type:"cancel"` TSFN 事件：per-request watcher 任务在
    Cancelled 时置标志并发射（Completed 时静默退出，无泄漏）；
  - `StreamWriterJs` 三拆：`finished`（本地半关意图）/ `cancelled`
    （对端取消事件已触发）/ `closed`（底层投递通道已关）；
- **JS 投影**（packages/client-sdk/http/index.js）：
  - handler 请求对象增 `sessionId: number` 与 `signal: AbortSignal`
    （per-request AbortController，cancel 事件触发 abort）；
  - respondStreaming 返回的 writer 增 `cancelled` / `closed` getter；
- **测试**：内核 session_id 传播 / cancel 事件驱动唤醒 / 完成不误报取消；
  SDK 事件字段 / signal abort / writer 三态；malformed_seen 观测钉；
  RESUME_OK 发送失败 × 异 nonce 压力（上轮评审遗留加固项）。

### 非目标

- 不改 wire 协议（RESET/FIN/帧格式不动——sessionId 是本地派生事实，
  kernel 直接可得，无需上帧）；
- 不做请求体 AsyncIterable（既有 phase 排期不变）；
- 不动 dweb-server / access-policy（Owner 自管范围）。
