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
- [x] 4.2 全量门禁（串行，实跑两轮）：fabric lib 178/178 + session 19/19
      + http 7/7 + state 5/5 + SDK release 重建 + SDK 全量 40/40 +
      tsc typecheck 净；clippy 警告零新增（既有 type_complexity 遗留不含）
- [x] 4.3 版本 0.6.0 + CHANGELOG

## 5. 评审与发布

- [x] 5.1 R1 复核处置（Codex NO-GO 6.2/10 → 全部 P1/P2 修复）：
      - P1-1：内核 400/500 错误出口 mark_completed（h8 钉）+ 桥初始 TSFN
        失败显式 watcher.abort()（双保险）
      - P1-2：JS 统一 liveRequests Map（controller+streamed 单 entry；
        finalizeRequest 全出口删除）
      - P1-3：downgrade_to_recovering_if_owner 原子 CAS（ResumeCtl 单锁）
      - P1-4：Replaced 臂置旧 shared Dead + install 拒绝 Dead 会话 +
        accept_resume 安装后/OK 前归属栅栏 + s6d barrier 竞态钉
      - P1-5：close 逐流 RESET（挂起 handler 秒停——h9/SDK 钉均 <1.4s）
      - P1-6：fetchHttp 预中止同步失败（不上线，SDK 钉）
      - P1-7：abort_fetch 严格输入校验（finite/非负/整数/安全整数域）
      - P2：sessionId 合同统一 hex string；D4/D8 措辞与实现期发现 3 收敛；
        JSDoc @param signal；P2-3 close 经 current_channel 解析当前代
      - 诚实留白：TSFN 队列满注入不可从黑盒确定性构造（以显式 abort +
        内核终裁双保险覆盖，未加直接注入测试）；JS liveRequests 大小无
        外部观测面（以单一 Map 全出口删除的简单性 + 代码评审覆盖）
- [x] 5.1b R2 处置（Codex NO-GO 6.8/10 → 四残余 P1 修复）：
      - 终局提交条件化（Dead/Closed/closing 不得拉回 Active）
      - closing CAS 闸门（close 先行置位：新 OPEN/install/终局三拒绝 +
        通道终结循环 ≤3 轮）——s6e 钉（Dead 后放行在途恢复被拒）
      - accept_resume OK 前终态复核（Dead/Closed/closing → superseded）
      - server.close 流式收敛（native close_notify + cancels 清空；JS
        controllers abort + liveRequests 清空）——SDK 钉 7/7
      - design D2 伪码定稿口径（250ms）+ D9 段
- [x] 5.1c R3 处置（NO-GO 7.1 → 两残余 P1）：install 全路径 closing/终态
      复查（decision:None 不再绕过）；客户端 resume 条件激活（失败撤安装
      superseded）；close 持 transition 串行化（移除 is_dead 错误提前退
      出）；reserve_stream_slot 锁内 closing 复查；SDK watcher enable-
      then-check + handle 插入后复查 + JS serverClosed 闸门；白盒钉。
- [x] 5.1d R4 复核：**GO 8.8/10**——两个核心竞态获得明确线性化点
      （close/install→transition；close/open→streams lock；watcher/close
      →Notify enable+recheck；insert/close→terminal recheck；JS→闸门）。
      发布后 P2 加固建议（留档决策项）：barrier 型跨任务锁边界交错测试；
      CLI e2e 负载稳定性持续观测。
- [ ] 5.2 tag v0.6.0 走 CI 发布（npm pinned @11）；npm@12 空跑验证后解钉
- [ ] 5.3 archive 本 change
