# plugins/ports delta —— webui-plugin-kernel

## ADDED Requirements

### Requirement: 端口共享插件（HTTP 语义映射）

ports 插件 SHALL 在消费侧（B 机）维护映射账本 `<DWEB_HOME>/plugins/ports/mappings.json`（id/name/peer(endpointId)/remotePort/localPort/enabled，0600 原子写+锁家族），并对每条启用映射在本机起 HTTP listener（默认 127.0.0.1；0.0.0.0 v1 不提供）逐请求经 `fetchHttp(session)` 到提供侧端点 `/wpk1/ports/proxy/<remotePort>`，提供侧转发 `localhost:<remotePort>`，实现 B 机访问 `localhost:<localPort>` 等同 A 机服务（[W1]，HTTP 语义面）。提供侧 MUST 维护 allowlist `(peer, remotePort)` 显式授权（默认 deny）。请求体 MUST 有界（默认 8MiB 可配 [W7]，超限 413）；hop-by-hop 头（connection/keep-alive/transfer-encoding/upgrade/proxy-*）MUST 剥除，敏感回显头重写；取消 MUST 双向传播（本地连接断→fetchHttp abort→对端 handler signal）；SSE MUST 经流式响应透传。本机端口冲突 MUST 明确报错不静默换端口。WebSocket/raw TCP 透传 v1 MUST NOT 宣称支持（面板列「即将推出」）。

#### Scenario: 双机端口映射与取消传播

- **WHEN** iMac（A）8080 起 HTTP 服务并 allowlist 授权 mini，mini（B）添加映射 9090→A:8080 后 `curl localhost:9090`
- **THEN** 响应（状态码/头/体）等同直连 A:8080；curl 中途断开时 A 侧在途请求收到取消信号并停止资源消耗

#### Scenario: 有界请求体与授权默认拒绝

- **WHEN** B 侧向映射端口 POST 超过上限的请求体；或未授权 peer 的设备向 `/wpk1/ports/proxy/<port>` 发起请求
- **THEN** 前者收到 413（含上限说明）；后者被 deny（fabric 会话身份不匹配 allowlist），零转发发生

#### Scenario: SSE 透传与端口冲突明确失败

- **WHEN** A:8080 提供 text/event-stream 服务经映射访问；或 B 添加映射时 localPort 已被占用
- **THEN** SSE 事件流持续透传不缓冲至断开；端口冲突报明确错误且不绑定任何替代端口
