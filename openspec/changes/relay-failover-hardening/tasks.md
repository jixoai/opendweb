# Tasks: relay-failover-hardening

## 1. 根因定位（iroh 1.1.0 上游语义核对）

- [x] 1.1 核对 iroh 1.1.0 `RelayMode::custom` 多 relay 语义：RelayMap 全量
      探活（net_report HTTPS/QUIC 探针按延迟选 preferred relay），
      `EndpointAddr` 多候选时对全部已知路径并发发初始包
      （remote_state.rs `handle_msg_send_datagram`），每条 relay 独立
      ActiveRelayActor 指数退避（10ms→16s）**无限重连**——上游无阻断
      bug，缺陷在本仓库拨号候选构造
- [x] 1.2 c1 双因确认：invite 写入 `urls.first()`（fabric.rs 原
      1584-1589）+ join 拨号只用令牌单 relay（session.rs:702
      `endpoint_addr_from_invite`，join 未做候选合并）
- [x] 1.3 c2 确认：closed_task 意外死亡分支只摘条目 + 发事件，无重拨；
      iroh relay 连接自身会恢复，但 fabric 会话永久死亡

## 2. 修复实现（crates/dweb-fabric/src/fabric.rs）

- [x] 2.1 c1-a：`invite_with()` 携带快照 active_url（在线 home relay），
      `same_relay_url` 映射回配置原样字符串；未沉降回退 urls.first()；
      纯函数 `invite_relay_url` 供单测
- [x] 2.2 c1-b：提取 `with_local_relay_candidates`（自 merge_dial_candidates），
      `join()` 拨号地址 = 令牌地址 + 本地 relay 配置全量追加；connect 的
      合并语义改用同一 helper（零行为变化）
- [x] 2.3 c2：reconnect manager 常驻（start() 启动，shutdown_drain 在
      endpoint 关闭前 abort+join）+ `reconnect_tx` channel + closed_task
      同代次分支发送通知 + `session_reconnect_worker` 退避重拨
      （1s→30s 上限，复用 Fabric::connect 全部准入语义）
- [x] 2.4 c2 配套：`disconnect()` 一律记录 recent_disconnects（无活跃条目
      也记录），显式断开语义不被自动重连覆盖；worker 的终止条件四路
      （成功/显式断开/NotMember/shutdown）
- [x] 2.5 Send 环规避实证：直接在 closed_task 内 spawn 重拨任务会形成
      insert_peer -> reconnect -> connect -> insert_peer 递归 future，
      rustc 无法证明 Send（E0277 实证）；改经 channel 请求 manager 派发

## 3. 测试

- [x] 3.1 新增 `tests/relay_failover.rs`（真实 iroh relay server + 自签
      证书 CustomPem 信任；死条目用本机已释放端口模拟 TCP RST）：
      - c1 `dead_first_relay_entry_fails_over_for_join`：issuer/joiner 配置
        同为 [dead, alive]，断言令牌携带活 relay、join 与 connect 均成功
        （修复前实测复现 `DialTimeout: join deadline exceeded`）
      - c2 `session_reconnects_after_relay_outage_recovery`：relay 宕机
        窗口内会话意外中断（provider 侧 close 触发 consumer 同代次分支），
        relay 同证书同端口恢复后会话自动重连 + 在途消息恢复
- [x] 3.2 lib 单测：`invite_relay_url_prefers_live_relay_and_maps_back_to_config_form`
      （活 relay 优先/尾斜杠映射回配置原样/未沉降回退/disabled 恒空）+
      `join_dial_candidates_merge_token_relay_with_local_config`
      （令牌 relay + 配置全量参与拨号候选）
- [x] 3.3 回归：`cargo test -p dweb-fabric --no-fail-fast`——lib 101/101、
      dial_after_disconnect 3/3、fabric_integration 4/4、facade_e2e 5/5、
      join_classification 26/27、redeem_wire 21/21、relay_failover 2/2、
      relay_watch 1/1；clippy 0 警告、rustfmt 通过、dweb-server/spike-iroh
      编译通过
- [x] 3.4 已知环境项登记：join_classification 的
      `relay_offline_probe_dns_failure` 在本机失败——本机 DNS 代理对
      `.invalid`（RFC 6761）合成 fake-IP 应答（198.18.0.73），探针 TCP
      可达导致分类翻转；**干净树上同样失败**（stash 实证），非本变更回归

## 4. 已知边界与后续项（登记）

- [ ] 4.1 c2 集成测试的"宕机期间重拨必然失败、恢复后经 relay 成功"腿在本机
      无法低成本端到端复现：loopback 上 iroh 打洞总能建直连路径（iroh
      builder 恒预置 0.0.0.0/[::] 默认 socket，bind_addr 是追加而非替换），
      重拨会走 iroh 内部记忆的直连路径。该腿的 relay 拨号部分由 c1 用例覆盖
      （拨号候选只含 relay、死条目在前仍建立成功）；relay 重启后 iroh actor
      自动重连为上游行为（actor.rs 无限退避重试 + 上游
      test_active_relay_reconnect）。现场 relay-only 部署的重腿验证留给
      ai-fly 三机回归
- [ ] 4.2 令牌仍携带单条 relay URL（wire 格式不动）：issuer invite 时快照
      未沉降（刚启动、net_report 未完成）则回退配置首条——若首条恰为死
      条目，joiner 侧 2.2 的候选合并仍可兜底（同列表场景），但跨列表配置
      的 joiner 无兜底。彻底解法是令牌携带多 relay（协议变更），登记为
      后续项
