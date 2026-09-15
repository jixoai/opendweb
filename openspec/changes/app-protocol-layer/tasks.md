# Tasks

## Phase 0：术语冻结、wire fixture 与 iroh probe

- [x] 1.0 会话生命周期契约冻结（R3 补）：SESSION_INIT 建会话流程、token
      签发/轮换/无绝对过期语义、`openSession` 幂等入口——design.md §2.3.0 定稿
- [ ] 1.1 冻结术语与公共帧头（48B 头、帧类型表、flags）进 design.md 附录；
      建立 Rust 侧二进制 fixture（合法 round-trip + malformed 负例）与
      offset/ACK/SACK property tests（fixture 主路径 = Rust + N-API 黑盒；
      TS 解码器 fixture 仅逃生舱可选）
- [x] 1.2 iroh probe：`export_keying_material` 跨连接适用性（A/B 连接对比 +
      同连接 path migration 对比）+ N-API 暴露安全性
- [x] 1.3 iroh probe：datagram 支持面（最大 payload/丢包/relay 行为）
- [x] 1.4 iroh probe：keepalive/path idle/connection idle 默认值实测时间线
      （PING、PathEvent::Selected/Closed、closed() 边界）
- [x] 1.5 iroh probe：close reason 错误映射表（本地/远端/超时/stateless
      reset/relay 中断）；`connectionEpoch` 自生成方案确认
- [x] 1.6 iroh probe：流控并发上限（128 logical stream × 慢读 + 大 replay，
      control stream 不被阻塞）
- [x] 1.7 每项 probe 产出存档：源码路径+版本、命令、原始输出、判定、对协议
      草案的影响；未过查证不冻结 timeout/token 派生方案
- [ ] 1.8 Rust↔N-API HTTP/WS handler ABI 定稿（R3 补草案 design.md §3.4：
      handler TS 执行、body 流桥接、背压与 ACK 同源、取消/shutdown drain、
      跨界异常不 panic）——含 ABI 评审

## Phase 1：Rust 连接状态面与 raw continuity transport

- [ ] 2.1 新 ALPN `/dweb/fabric-continuity/1`；connectionEpoch 单调代次；
      ConnectionStateSnapshot + stateSeq watch 流（snapshot-before-subscribe、
      gap 重拉）
- [ ] 2.2 `open_continuity_transport()`；legacy envelope 物理隔离
- [ ] 2.3 N-API 暴露 typed snapshot/stream，不暴露内部 broadcast 细节
- [ ] 2.4 验收：member/ALPN gate、epoch 单调、旧 watcher 不删新连接、
      snapshot resync；故障注入：远端 close/idle timeout/stateless reset/
      relay 停复/双端同拨/shutdown 竞速

## Phase 2：Session Continuity 核心协议

- [ ] 3.1 SESSION_INIT/OK/REJECT（首次建会话、重复 INIT 幂等收敛、双端并发
      INIT deterministic winner）+ RESUME_INIT/OK/REJECT（含 RESUME_OK 的
      new_generation/new_resume_token 轮换载荷与原子性）+ sessionId/epoch
      CAS/token/stream summaries
- [ ] 3.2 每流 offset/累计 ACK(+SACK)/replay journal（三重上限 + 反压 +
      **年龄仅恢复窗口内计**）/ 接收去重 / 逻辑死亡判据
- [ ] 3.3 OPEN/DATA/FIN/RESET + 请求副作用状态机（幂等键、STARTED 不重执行、
      REQUEST_STATE_LOST）
- [ ] 3.4 验收：任意 offset 断点恢复、duplicate 幂等/overlap mismatch reset、
      stale epoch 拒绝、ACK 推进释放 journal、多流恢复 control 不阻塞
- [ ] 3.5 故障注入：RESP_CHUNK 后 ACK 前断连、STARTED 后断连、双主、journal
      上限、慢 SSE + 127 小流并发恢复

## Phase 3：HTTP/WS Rust 引擎 + SDK subpath + ai-fly 接线

- [ ] 4.1 HTTP/WS 引擎（Rust）：serveHttp/fetchHttp、SSE 投影、WS upgrade
      隧道（边界/分片/close 冻结）
- [ ] 4.2 `@jixo/opendweb-client-sdk` exports map（. /net /net/internals
      /http /http/internals；internals 标注 semver 宽松）+ SessionHandle/
      LogicalStream/OpenStreamMeta TS 类型面 + npm pack 验证 + 五子路径
      import/require/类型三层实测
- [ ] 4.3 （可选）TS 逃生舱参考实现（基于 /net/internals）作文档示例
- [ ] 4.4 ai-fly 迁移 change：ProviderConnection 删除第二套重连竞速、
      frames/mux 退役、AUTH/catalog 消费 Session 状态
- [ ] 4.5 验收：60s SSE 中途断线原序续传不重复 token、journal evicted/
      dead 确定错误、WS 三态恢复、新请求 dead 前不提前 503
- [ ] 4.6 故障注入：SSE 第 N chunk 后 relay down 15s、本地慢读 >4MiB、
      上游副作用后断线、WS 拆片/握手/双向竞态、provider 重启 REQUEST_STATE_LOST

## Phase 4：安全、容量与发布门

- [ ] 5.1 token replay/stale epoch/跨 peer/跨 fabric/过期 token 防护测试
- [ ] 5.2 journal 内存记账、metrics、redaction、shutdown drain（无残留
      task/journal）
- [ ] 5.3 限额压力测试（8MiB/2MiB/4096/恢复窗口 90s；含健康慢读 >90s
      不判死、长寿命会话断线 token 仍有效；recovering 内 15s 单流静默
      的普通流/SSE/WS 三分支终态）+ direct/relay/NAT/failover
      矩阵重复通过
- [ ] 5.4 真实 ai-fly SSE/WS 端到端 + legacy envelope 回归
- [ ] 5.5 「透明续传」六条停止条件逐条核验后方可宣称完成（design.md §7）

## 复核门

- [ ] 6.1 Codex 复核 change 文档合并稿（裁决一致性）——已排
- [ ] 6.2 每 Phase 完成后 Codex 复核 + 实测证据核验（remix 闭环）
