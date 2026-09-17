# Tasks: sdk-lifecycle-signals

## 1. 内核（dweb-fabric）

- [x] 1.1 `HttpRequest` 增 `session_id: [u8;16]` + `cancel: RequestCancel`；
      dispatch_stream 从 shared 填充（continuity/http.rs）
- [x] 1.2 `RequestCancel` + `CancelOutcome`（wait 循环：peer_reset 优先 →
      Completed 复查 → phase 终态 → reset_notify 唤醒 + 250ms 有界 sleep
      佐餐——无 phase_notify，见 design 实现期发现）
- [x] 1.3 内核钉 h6/h7：session_id 传播（== SessionShared.session_id）+
      同会话稳定 + fresh pair 异会话差异；挂起流 abort → wait()==Cancelled；
      正常完成 → wait()==Completed（不误报）
- [x] 1.4 malformed 钉（口径修正）：零 sid/token/epoch 身份字段 →
      REJECT(MALFORMED) 负例（session_init_zero_identity_rejects_malformed）；
      未新增 malformed 计数器面——无消费者，避免发明死 API（payload 短/
      版本错臂已有 P0-4 钉）
- [x] 1.5 RESUME 压力钉（口径修正）：黑盒确定性触发「安装后 OK 发送失败」
      需 QUIC 流控级注入，代价过高；改为钉不变量
      session_abandoned_resume_then_cross_nonce_recovers（废弃 RESUME × 异
      nonce 恢复必须成功且 provider 回 Active）。过程中实证并修复 3572
      owner 守卫缺陷（迟到的失败回落覆盖新胜者 Active——见 design 实现期
      发现 2）

- [x] 1.6 fetch 侧取消（D7）：FetchCancel 开关 + head 等待取消分支 +
      FetchHttpInit.abortKey + SessionHandle.abortFetch + JS 胶水 signal 接线
- [x] 1.7 close 语义与 canonical 释放（D8）：Session::close 传输终结（FIN）；
      恢复放弃看门狗（90s 默认 + 测试旋钮）；死通道 Recovering canonical
      即时替换；campaign 守卫活跃判定收紧；内核钉 s6c（close 后同 peer
      重开立即成功）

## 2. N-API 桥（packages/client-sdk/src/http.rs）

- [x] 2.1 request 事件 JSON 增 `sessionId`（hex）
- [x] 2.2 RequestFlags（cancelled/closed）注册表 + per-request watcher +
      `type:"cancel"` TSFN 事件；watcher 出口自清理（正常完成零残留）
- [x] 2.3 StreamWriterJs `cancelled`（watcher 旗）/`closed`（终裁旗）
      getter（tx_probe 探针方案已废弃——EOF 回归，见 design 实现期发现 1）

## 3. JS 投影（packages/client-sdk/http/index.js + index.d.ts）

- [x] 3.1 事件路由 request|cancel；controllers Map / streamed Set 外提；
      controller 生命周期 = 流生命周期（finish/write 错误/cancel/静态结算
      出口清理）
- [x] 3.2 请求对象 `sessionId` + `signal`；writer 投影三 getter
- [x] 3.3 JSDoc + index.d.ts 类型面补全（含 0.5.0 欠账的 respondStreaming
      形状与 headTimeoutMs 声明）

## 4. 测试与门禁

- [x] 4.1 SDK lifecycle 3 钉（test/http-lifecycle.test.mjs）：sessionId
      hex 会话稳定；挂起 handler 收 signal abort + writer.cancelled +
      write 拒绝；正常完成 signal 静默 + closed 翻转 + cancelled 保持 false
- [ ] 4.2 全量门禁（串行）：fabric lib + 3 continuity 套件 + SDK release
      重建 + SDK 全量测试（39）+ tsc typecheck；clippy -D warnings
      （fabric/sdk 范围）
- [x] 4.3 版本 0.6.0 + CHANGELOG

## 5. 评审与发布

- [ ] 5.1 Codex 复核（herdr）→ 处置结论 → 复验
- [ ] 5.2 tag v0.6.0 走 CI 发布（npm pinned @11）；npm@12 空跑验证后解钉
- [ ] 5.3 archive 本 change
