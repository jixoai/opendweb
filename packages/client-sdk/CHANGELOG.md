# Changelog — @jixo/opendweb-client-sdk

## 0.6.0 — 生命周期信号族（sdk-lifecycle-signals）

### Added

- **serveHttp handler 请求对象**
  - `sessionId: string`（hex）——请求所属逻辑会话；授权缓存应以此为隔离键
    （同 peer 异 session 不继承授权）。内核本地协商事实，非 wire 字段。
  - `signal: AbortSignal`——对端取消（RESET / 会话终态遗弃）事件驱动触发；
    挂起中的 handler（尚未 write）也能即时收到；正常完成不触发。
- **StreamWriter 三态正交观测**（`respondStreaming` 返回句柄）
  - `finished`——本地已调用 `finish()`（半关意图）
  - `cancelled`——对端取消事件已触发本请求
  - `closed`——底层投递通道已关（内核终裁后不再消费 write）
- 桥事件新增 `type:"cancel"`（requestId 关联；best-effort 信号）。
- `fetchHttp` 请求面类型补 `headTimeoutMs` 声明（0.5.0 运行时已有）。
- `/http` 类型面（index.d.ts）补全 `respondStreaming` / 流式 handler 形状。

### Added（实现期补入）

- **fetchHttp 消费端取消**：`request.signal`（JS 胶水）/ `abortKey`+
  `session.abortFetch(key)`（原生面）——head 等待期 abort 即时 RESET，
  对端在途请求不再悬挂至其自身超时（与 provider 侧 req.signal 对偶）。
- **Session.close 传输终结**：close 发送半 FIN——对端即时感知（此前对端
  至进程退出都视会话存活）。
- **同 peer 重开修复**：Recovering-死通道 canonical 可被新 INIT 即时替换
  + 恢复放弃看门狗（90s）——close/重启后立即可重开会话（此前永卡）。

### Fixed

- 内核：废弃 RESUME 尝试的迟到 OK 发送失败不再把更晚胜者刚置位的
  Active 打回 Recovering（owner 代次守卫）。
- 内核：`RequestCancel` 生命周期句柄（`wait() -> Cancelled | Completed`）。

### Notes

- watcher 生命周期 = 内核流生命周期：正常完成零任务残留。
- write() 的错误返回仍为取消/关闭的真相面；getter 为观测面（0.5.0 语义不变）。
