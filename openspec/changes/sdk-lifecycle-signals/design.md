# Design: sdk-lifecycle-signals

## Context

0.5.0 的 handler 桥是「请求进、响应出」的单向面：事件只带 streamId，终态只
能从 write 错误反推。0.6.0 在**不加 wire 帧**的前提下补齐生命周期可观测面
——所有新事实都是内核本地已有的（session_id、peer_reset 标志、reset_notify、
request_state），只做投影。

## Goals / Non-Goals

Goals:
1. handler 可按 session 隔离授权状态（sessionId 传播）；
2. 挂起中的 handler 可被取消事件即时唤醒（cancel 事件 + JS signal）；
3. 流式写句柄三态正交（finished/cancelled/closed）；
4. watcher 生命周期 = 内核流生命周期，正常完成零任务残留。

Non-Goals: wire 协议变更；请求体迭代面；access-policy（Owner 自管）。

## Decisions

### D1. sessionId 是内核派生事实，不进 wire

`SessionShared.session_id` 在 dispatch 现场即可得（fetch_http 的 abort 路径
已在用同源值，continuity/http.rs:199）。OPEN meta 不加字段——对端伪造的
meta 不可信，而 `shared.session_id` 是本地协商事实。桥事件 JSON 直接投影
`"sessionId": request.session_id`。

### D2. RequestCancel：持久标志 + Notify 唤醒 + 状态终裁

```rust
pub struct RequestCancel { shared: Arc<SessionShared>, stream_id: u64 }
pub enum CancelOutcome { Cancelled, Completed }

impl RequestCancel {
    pub async fn wait(&self) -> CancelOutcome {
        loop {
            // 1. 取消优先复查（Notify 不保留通知——标志兜底注册窗口）
            if self.shared.peer_reset(self.stream_id).await {
                return CancelOutcome::Cancelled;
            }
            // 2. 内核已终裁完成（dispatch mark_completed 后）——不是取消
            if matches!(self.shared.request_state(self.stream_id).await,
                        Some(RequestState::Completed)) {
                return CancelOutcome::Completed;
            }
            // 3. 会话终态（放弃恢复/对端关闭）＝未完请求被遗弃 → 取消
            match self.shared.phase().await {
                SessionPhase::Dead | SessionPhase::Closed => {
                    return CancelOutcome::Cancelled;
                }
                _ => {}
            }
            // 4. 挂起等唤醒（reset_notify 全会话级——唤醒后回 1 复查本流）
            tokio::select! {
                _ = self.shared.reset_notify.notified() => continue,
                _ = self.shared.phase_notify.notified() => continue, // 若无此项则退化为有限轮询
            }
        }
    }
}
```

要点：
- **顺序敏感**：取消复查在完成复查之前——FIN 与 RESET 竞速时宁可多发一次
  cancel（JS 侧 signal abort 对已结束请求无害）也不漏发（漏发 = 挂起任务
  永不停止）。
- **无泄漏**：正常路径 dispatch `mark_completed` → watcher 退出；异常路径
  peer_reset/session 终态 → 发射后退出。watcher 挂起面 = reset_notify /
  phase 变化，二者在会话对象 Drop 前都可能长期静默——由 Completed/终态
  出口兜底。
- session.rs 若无 phase 变化 Notify，则以 100ms 有界轮询 phase 佐餐
  （wait_active 同款模式，终态出口仍保证退出）。

### D3. cancel 事件走既有 TSFN（JSON String 通道）

不加第二条 TSFN。事件形状 `{"type":"cancel","requestId":N}`；router 在
`ev.type` 分派。NonBlocking 信号语义不变（返回状态检查同 request 事件，
失败即丢弃——cancel 是 best-effort 通知，write 错误仍是兜底真相源）。

### D4. watcher 由 handle() 生命周期锚定，标志经 AtomicBool 共享

```
handle():
  cancelled_flag = Arc<AtomicBool>
  cancels.register(request_id, cancelled_flag)
  watcher = spawn { 若 wait()==Cancelled:
                      flag.store(true); tsfn.emit(cancel 事件) }
  …既有序程…
  // 出口不 abort watcher——D2 的 Completed/终态出口保证自然退出
```

- `cancels` 注册表（Mutex<HashMap<u64, Arc<AtomicBool>>>）供
  respond_streaming 时给 StreamWriterJs 挂 `cancelled` getter；entry 在
  watcher 退出时移除（writer 已持 clone，只影响观察面）。
- close() 时：closed 置位 → 后续 handle 直接拒绝；既有 pending drain 走
  "server closed" 拒绝；watcher 由会话终态出口收尾（serve 任务 abort 后
  session 随之 Dead）。

### D5. StreamWriter 三态正交定义

| getter | 语义 | 实现 |
|---|---|---|
| `finished` | 本地已调用 finish()（半关意图，幂等面） | tx Option 取 None（既有） |
| `cancelled` | 对端取消事件已触发本请求 | watcher 的 AtomicBool |
| `closed` | 底层投递通道已关（内核不再消费：完成/放弃/取消后） | `mpsc::Sender::is_closed()` |

write() 错误信息保持「peer or engine」统称——三态 getter 是**观测面**，
write 仍是**真相面**（不变更 0.5.0 语义）。

### D6. JS 投影

- 事件回调外提 per-server `controllers: Map<requestId, AbortController>`；
- `type:"request"` → 构造 controller，`signal` 随请求对象传入 handler；
- `type:"cancel"` → `controllers.get(id)?.abort()`；
- 顺带修正：既有 `streamed` Set 从回调内提级到 per-server（当前 per-event
  重建虽然恰好正确，但 cancel 路由后同一闭包要共享状态，统一外提）；
- writer 投影补 `cancelled`/`closed` getter。

ai-fly 侧消费（另仓变更）：AUTH grants 按 sessionId 隔离 + 慢任务
`req.signal` 秒停。

## Risks / Trade-offs

- **reset_notify 全会话级唤醒**：多流并发取消时 watcher 可能被无关流的
  RESET 虚假唤醒——复查标志后回挂起，正确性无虞，仅为罕见多余调度。
- **Completed 竞速窗口**：mark_completed 与 peer_reset 同时为真时按取消
  报（D2 顺序）——JS signal abort 已结束的请求是幂等无害操作。
- **AtomicBool 观测滞后**：cancelled getter 与 write 错误之间可能存在
  微秒级窗口——观测面非真相面，write 仍会如实报错。

## Migration / Compatibility

- 事件新增字段/getter 均为**加法**；0.5.x 消费者（ai-fly 0.5.0-alpha.1）
  不读新字段，行为不变；
- SDK npm 0.6.0（semver minor）；crates 版本随 workspace 既有节奏；
- `/http/internals` 不动新面（cancels 注册表不暴露——经 getter 观测）。

## Open Questions

（已解）D2 的 phase_notify：SessionShared 无 phase 变化唤醒面——wait()
以 250ms 有界 sleep 佐餐 + reset_notify 即时唤醒；终态出口保证退出。
实测挂起唤醒即时性满足（SDK lifecycle 测试 1s 内收口）。

## 实现期发现（记录）

1. **tx_probe EOF 回归（已修）**：初版以「writer 持探针 mpsc Sender 观测
   is_closed」实现 closed getter——探针 sender 让 dispatch 的 body.recv()
   永不返回 None（所有 sender drop 才 EOF），FIN 发不出、客户端 EOF 挂起。
   修正：closed 改由 watcher 终裁置位（RequestFlags），writer 不持有任何
   探针 sender。教训已写入代码注释。
2. **3572 owner 守卫（真实缺陷修复）**：RESUME_OK 发送失败的 phase 回落
   原为无条件 Active→Recovering——被更晚恢复超替的迟到失败会把新胜者刚
   置的 Active 打回 Recovering。加 current_channel_owner() 代次守卫。
   （s6b 钉不变量：废弃 RESUME + 异 nonce 恢复后 provider 必须回到
   Active；具体迟到失败交错由竞态决定，守卫为原则性加固。）
3. **双拨收敛已知边缘（未修，非本面）**：同 peer close 旧会话后立即
   open_session，客户端可能卡 adopt canonical（"not observed locally"）
   直至握手超时——0.5.0 malformed INIT_OK 测试同族现象。h6 因之改用
   fresh pair 断言跨会话差异。遗留至传输层专项（见收尾决策项）。
