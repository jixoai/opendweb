# plugins/ports delta —— webui-plugin-kernel

## ADDED Requirements

### Requirement: 端口共享插件（HTTP 语义映射）

ports 插件 SHALL 在消费侧（B 机）维护映射账本 `<DWEB_HOME>/plugins/ports/mappings.json`（id/name/peer(endpointId)/remotePort/localPort/enabled，0600 原子写+锁家族），并对每条启用映射在本机起 HTTP listener（默认 127.0.0.1；0.0.0.0 v1 不提供）逐请求经 `fetchHttp(session)` 到提供侧端点 `/wpk1/ports/proxy/<remotePort>`，提供侧转发 `localhost:<remotePort>`，实现 B 机访问 `localhost:<localPort>` 等同 A 机服务（[W1]，HTTP 语义面）。提供侧 MUST 维护 allowlist `(peer, remotePort)` 显式授权（默认 deny）。请求体 MUST 有界（默认 1MiB，配置域 64KiB–1MiB（0.0625–1 MiB、64KiB 粒度）硬范围——r8-B4：v1 有效包络=min(插件预算, transport 实况)=1MiB 单帧（fabric session MAX_FRAME），更大上限=必然失败配置，超范围/非粒度配置拒绝启动该映射 [W7]）；未知 Content-Length 的入站请求 MUST 边读边累计、达上限立即断开拒绝；并发预算 MUST 冻结（并发代理 ≤16 请求，在飞字节=16×上限，超预算 429 拒新请求直至回落）；超限 413；请求体经 fetchHttp 发送时 MUST 按 ≤1MiB 帧分块（静态分块逐元素单帧）；hop-by-hop 头（connection/keep-alive/transfer-encoding/upgrade/proxy-*）MUST 剥除，敏感回显头重写；取消 MUST 双向传播（本地连接断→fetchHttp abort→对端 handler signal）；SSE MUST 经流式响应透传。本机端口冲突 MUST 明确报错不静默换端口。WebSocket/raw TCP 透传 v1 MUST NOT 宣称支持（面板列「即将推出」）。

#### Scenario: 双机端口映射与两阶段取消传播（r2-B1）

- **WHEN** iMac（A）8080 起 HTTP 服务并 allowlist 授权 mini，mini（B）添加映射 9090→A:8080 后 `curl localhost:9090`；随后分别在「响应头未返回前」与「SSE/长响应体传输中」断开本地连接
- **THEN** 响应（状态码/头/体）等同直连 A:8080；阶段 A（头等待期）断开经请求 signal 即时取消；阶段 B（响应体期）断开经响应句柄 abort() 发 RESET——两种情况 A 侧 provider signal 均触发且上游 localhost socket 收敛，零资源悬挂

#### Scenario: 已知长度超限拒绝

- **WHEN** B 侧向映射端口 POST 带已知 Content-Length 超过上限的请求体
- **THEN** 收到 413（含上限说明），零转发

#### Scenario: 未知长度累计拒绝

- **WHEN** B 侧 POST 未知 Content-Length 的流式请求体，累计达上限
- **THEN** 立即断开拒绝（不先缓冲后判），零转发

#### Scenario: 并发预算与配置硬域

- **WHEN** 并发发起 >16 个在飞代理请求；或配置映射上限为 2MiB/128MiB
- **THEN** 超额请求收到 429 直至在飞回落；超范围配置被拒绝（64KiB–1MiB 硬域外——r8-B4：v1 有效包络=transport 帧上限 1MiB，必然失败配置不得存在；映射不启动）

#### Scenario: 授权默认拒绝

- **WHEN** 未授权 peer 的设备向 `/wpk1/ports/proxy/<port>` 发起请求
- **THEN** deny（fabric 会话身份不匹配 allowlist），零转发发生

#### Scenario: SSE 透传与端口冲突明确失败

- **WHEN** A:8080 提供 text/event-stream 服务经映射访问；或 B 添加映射时 localPort 已被占用
- **THEN** SSE 事件流持续透传不缓冲至断开；端口冲突报明确错误且不绑定任何替代端口
