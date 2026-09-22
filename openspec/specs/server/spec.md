# server Specification

## Purpose
定义自托管服务端（一个二进制 + 一个 Docker 镜像）的行为契约：iroh relay 桥接与 rendezvous 登记/解析。开发者部署它即可为自己的组网提供回退与寻址基础设施，不依赖任何官方公共节点。

## Requirements

### Requirement: relay 桥接

服务端 SHALL 运行 iroh relay（`iroh-relay` crate 的 server feature）：接受客户端的 relay 协议连接，端口拓扑 MUST 明确可配置——HTTP(S) 端口（relay 控制与 WebSocket 桥接）与 QUIC/UDP 端口分开配置。无 TLS 的本地/内网部署 SHALL 可用（明文 HTTP relay），生产部署的 TLS 终结职责 MUST 在文档中写明（反代终结 TCP/WS；QUIC 数据面需要原生证书或明确降级说明）。relay MUST NOT 能解密端到端会话内容。

服务端 SHALL 实现基于 access mode 的 relay 访问控制（见"Server 访问策略"）：默认 `open` 模式行为与无访问控制一致（AllowAll）；`restricted` 模式下每条客户端接入 MUST 通过 capability 验证链（见"relay capability 验证"）后才被注册。relay 仍不是 fabric 成员授权点：fabric 成员资格判定全部在端侧 roster；本访问控制仅限制 Server 基础设施的使用，其在 `restricted` 模式下的授权边界为 design.md §0 的形式化定义（经 relay 通信的端点属于 A(S)，callback 模式下另加 webhook 动态放行集合 A_cb(S)；`open` 模式不设此边界）。客户端 SHALL 能通过配置将本服务端指定为自定义 relay（含按 relay 携带 capability 凭证）并完成经 relay 的组网。

#### Scenario: 硬 NAT 双方经自托管 relay 组网

- **WHEN** 两节点直连不可达，均配置本服务端为 relay 且服务端为 `open` 模式
- **THEN** 两节点完成连接并交换消息，路径类型为 relay

#### Scenario: restricted 模式无凭证接入被拒

- **WHEN** 服务端为 `restricted` 且 `policy=static`，客户端未携带 capability 连接 relay
- **THEN** 接入被拒绝，拒绝原因经 relay 握手协议回传客户端（`dweb/no-capability`），连接不注册
- **注** `policy=callback` 时无凭证接入交 webhook 裁决（A_cb(S) 边界，见"动态策略回调"）

#### Scenario: 拒绝原因按失败环节区分（独立用例矩阵）

以下每个失败环节均为独立可构造用例，reason 互不相同：

- **WHEN** 令牌格式/长度/base64url 字符集非法 → **THEN** `dweb/malformed-capability`
- **WHEN** Authorization header 或 `?token=` 存在但为非 Bearer 形态/非法 UTF-8/非 `dwebr1.` 前缀（即"声明了凭证但不可解析"）→ **THEN** `dweb/malformed-capability`，该接入 MUST NOT 被归类为无票（无票路径仅限凭证完全缺失，防坏票混入 A_cb 动态名单）
- **WHEN** caps 位图含未知保留位 → **THEN** `dweb/caps-unsupported`
- **WHEN** 签名与 issuer 公钥不匹配（篡改任一字段）→ **THEN** `dweb/bad-signature`
- **WHEN** issuer 的 (fabric_id, root) 二元组不在 registry 活跃集合 → **THEN** `dweb/unknown-owner`
- **WHEN** server_id 与本服务端不符 → **THEN** `dweb/wrong-server`
- **WHEN** recipient 与握手认证 endpoint_id 不匹配 → **THEN** `dweb/not-recipient`
- **WHEN** caps 缺 RELAY 位（仅含 RDZ_* 的令牌连 relay）→ **THEN** `dweb/caps-missing-relay`
### Requirement: rendezvous 登记/解析（可选，不可信发现辅助）

服务端 SHALL 提供 HTTP API：节点可登记自己的 EndpointId 与可达地址（含 TTL），其它节点可按 EndpointId 查询仍在 TTL 内的登记项。登记请求 MUST 携带 EndpointId 对应私钥的签名（含时间戳与随机数防重放），服务端 MUST 验证签名后受理；过期的登记项 MUST NOT 出现在查询结果中。本 API 是发现辅助而非信任边界：客户端 MUST 把查询结果视为不可信输入，最终以 EndpointId 的 TLS 认证为准；常规会话与兑换的正确性 MUST NOT 依赖本 API。

#### Scenario: 登记后可解析

- **WHEN** 节点 A 以签名请求登记，随后任意节点查询 A 的 EndpointId
- **THEN** 查询返回 A 登记的地址信息

#### Scenario: 签名无效的登记被拒

- **WHEN** 登记请求签名验证失败
- **THEN** 返回认证错误，不产生登记项

#### Scenario: TTL 过期

- **WHEN** 登记项 TTL 已过且未续期
- **THEN** 查询不再返回该登记项

### Requirement: 健康检查

服务端 SHALL 提供 `GET /healthz` 返回存活状态，供容器编排与监控使用。HTTP 服务 SHALL 称为 **gateway**（默认 8787 端口），除健康检查外还承载 rendezvous 与服务清单。gateway 的监听地址 MUST 可通过 `--gateway`（CLI）与 `DWEB_GATEWAY_BIND`（环境变量）配置；旧名 `--http` 与 `DWEB_HTTP_BIND` MUST 作为兼容别名继续生效。

#### Scenario: 健康检查

- **WHEN** 服务端运行中收到 `GET /healthz`
- **THEN** 返回成功状态码

#### Scenario: 旧环境变量兼容

- **WHEN** 仅设置 `DWEB_HTTP_BIND` 启动服务端
- **THEN** gateway 监听该地址，行为与 `DWEB_GATEWAY_BIND` 一致

#### Scenario: 默认端口与显式配置等价

- **WHEN** 无任何配置启动，或以 `--gateway 0.0.0.0:9999` 启动
- **THEN** 分别监听 8787 与 9999，`/healthz` 与 `/services.json` 均按实际端口响应

### Requirement: Docker 交付

项目 SHALL 提供 Docker 镜像并以 `ghcr.io/gaubee/dweb` 名发布。镜像 SHALL 通过环境变量完成全部配置（端口、relay 开关等），无配置时使用合理默认值启动。项目 SHALL 另提供 compose 部署参考物：dweb 服务与隧道 sidecar（以 Cloudflare Tunnel 的 `cloudflared` 为参考实现，`TUNNEL_TOKEN` 注入、公网入口在面板侧配置）共同编排，且隧道拓扑下 MUST NOT 向宿主发布任何端口（暴露面完全收敛到隧道）。

#### Scenario: 默认配置启动

- **WHEN** 以无环境变量方式运行镜像
- **THEN** 服务端以默认端口启动并响应健康检查

#### Scenario: compose 隧道部署

- **WHEN** 以 `docker compose up`（提供 TUNNEL_TOKEN 与公网覆盖 env）启动
- **THEN** dweb 服务不发布宿主端口，公网入口经 sidecar 隧道可达，`/services.json` 公告公网 URL

### Requirement: 服务清单（services.json）

gateway SHALL 提供 `GET /services.json`（`Content-Type: application/json`、`Cache-Control: no-store`）返回机器可读的服务清单：服务端标识与版本、gateway URL、各服务条目（rendezvous、relay）的启用状态与 URL。URL 派生规则（按条目独立）：

- 若该条目已设置公网覆盖（`DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL`，见"公网 URL 覆盖"要求），条目 URL MUST 为覆盖值（rendezvous 为 gateway 覆盖值 + `/rendezvous`），跳过以下派生规则；
- 否则 scheme 跟随请求 scheme；`X-Forwarded-Proto` 仅在 `DWEB_TRUST_PROXY=1` 时采信，否则一律 `http`；
- host 取 `Host` 头主机部分，拒绝集合冻结为：unspecified 地址（`0.0.0.0`、`::`、空 host）、含 userinfo 的形态（`user:pass@host`）、host:port 解析失败、端口 0 或大于 65535；其余一律放行（含 loopback）；校验失败或无 Host 头时 MUST 回退为本机首个非 loopback IPv4；
- 每个派生条目 MUST 使用该服务实际监听的端口。

relay 禁用时其条目 MUST 为 `enabled: false` 且 `url: null`。清单字段只增不删不改语义。gateway SHALL 另在 `GET /` 提供同信息的人类可读纯文本摘要（全 ASCII）。

#### Scenario: gateway URL 解析 relay 地址

- **WHEN** 客户端以 LAN IP 访问 `http://192.168.2.13:8787/services.json`
- **THEN** 响应中 relay 条目的 URL 以 `192.168.2.13` 为主机、以实际 relay 端口为端口

#### Scenario: 无 Host 头回退网卡地址

- **WHEN** 请求缺失 Host 头且绑定地址为 `0.0.0.0`
- **THEN** 清单 URL 使用本机首个非 loopback IPv4，而非 `0.0.0.0`

#### Scenario: 无可用回退地址

- **WHEN** Host 头无效回退时本机不存在任何非 loopback IPv4
- **THEN** 未覆盖的 gateway 与各服务条目的 `url` 为 `null`（`enabled` 照实），服务端日志 WARNING，绝不产出 `0.0.0.0` 形态 URL

#### Scenario: IPv6 Host 头

- **WHEN** 请求 Host 头为 `[fd00::1]:8787` 形态
- **THEN** 清单 URL 主机部分正确剥离括号为 `fd00::1`，URL 使用括号 IPv6 形态

#### Scenario: 反代 scheme 信任边界

- **WHEN** 请求带 `X-Forwarded-Proto: https` 且未设置 `DWEB_TRUST_PROXY=1`
- **THEN** 派生条目 URL scheme 仍为 `http`（覆盖条目不受影响）

#### Scenario: relay 禁用的清单条目

- **WHEN** 服务端以 `--no-relay` 启动
- **THEN** `services.json` 中 relay 条目为 `enabled: false`、`url: null`

#### Scenario: 字段稳定性

- **WHEN** 对比本 change 冻结的 fixture 组（contracts/services.fixtures.json 的 canonical 案例字段集）与本实现输出
- **THEN** 字段名与结构完全一致（仅 host/port/version 值不同）

#### Scenario: 公网覆盖 fixture 快照

- **WHEN** 以 contracts/services.fixtures.json 的 public-* 案例构造清单
- **THEN** 实现输出与 fixture manifest 完全一致（覆盖值原样出现在对应条目）

#### Scenario: 未知与重复服务名

- **WHEN** 清单构造时包含未知服务名条目或同名重复条目
- **THEN** 未知条目被静默忽略（前向兼容，无告警），重复条目以首个为准并在服务端日志输出一条 WARNING

#### Scenario: relay URL scheme 校验

- **WHEN** relay 条目构造时派生 scheme 非 http(s)
- **THEN** 该条目按禁用处理并在日志 WARNING，不产出非 http(s) URL

#### Scenario: 人类可读摘要

- **WHEN** 访问 `GET /`
- **THEN** 返回纯文本摘要，内容与清单一致且全部字符码位 < 128

### Requirement: 启动横幅（单一配置入口呈现）

CLI 启动横幅 SHALL 为纯英文且全部字符码位 < 128，vite 风格枚举本机全部非 loopback IPv4 的 gateway URL（Local + Network；无可枚举地址时 SHALL 打印占位说明行而非省略该节），并以 `NAME | PORT` 表格列出各服务及状态，向用户传达"任一 Network 地址即客户端唯一配置入口"。设置公网覆盖时，横幅 SHALL 另列 Public 节逐行给出已设置的公网 URL（公网部署下它才是客户端应配置的入口）。

#### Scenario: 多网卡地址枚举

- **WHEN** 服务器具有多个非 loopback IPv4 地址并启动
- **THEN** 横幅逐一列出各地址的 gateway URL，无遗漏、无重复

#### Scenario: 横幅 ASCII 纪律

- **WHEN** 任意配置下启动并捕获 stdout
- **THEN** 横幅全部字符码位 < 128

#### Scenario: 公网覆盖的横幅呈现

- **WHEN** 以 `--public-gateway` / `--public-relay`（或对应 env）启动
- **THEN** 横幅 Public 节列出已设置的公网 URL；未设置的条目不出现

### Requirement: 公网 URL 覆盖（反代/隧道部署）

服务端 SHALL 支持为 gateway 与 relay 分别声明公网 URL：`--public-gateway` /
`--public-relay`（CLI）与 `DWEB_PUBLIC_GATEWAY_URL` / `DWEB_PUBLIC_RELAY_URL`
（环境变量），优先级 flag > env > 未设置。覆盖值 MUST 在启动期通过 fail-fast
校验（非法值以退出码 2 终止）：`http(s)://host[:port]` 形态，拒绝 path（空或
`/` 之外）、query、fragment 与 userinfo。按条目独立生效：已覆盖条目 MUST
完全跳过 Host 头/scheme/回退地址派生（且不受 `DWEB_TRUST_PROXY` 影响），
未覆盖条目行为 MUST 与无覆盖时逐字节一致。relay 禁用时 relay 条目维持
`enabled:false, url:null`，覆盖值被忽略且无告警。本机制为厂商中立的反代
适配层：任何终结 TLS 并回源 HTTP/WS 的 front-end（反向代理、隧道）均适用。

#### Scenario: 双覆盖全量生效

- **WHEN** 服务端以 `--public-gateway https://gw.example.com --public-relay https://relay.example.com` 启动，任意 Host 头请求 `/services.json`
- **THEN** gateway 与 rendezvous URL 为 `https://gw.example.com[...]`，relay URL 为 `https://relay.example.com`

#### Scenario: 部分覆盖

- **WHEN** 仅设置 `DWEB_PUBLIC_RELAY_URL=https://relay.dweb.example.com`
- **THEN** gateway/rendezvous 条目维持 Host 派生，relay 条目为覆盖值

#### Scenario: 覆盖独立于回退探测

- **WHEN** 双覆盖已设置，且请求 Host 头属拒绝集合、本机无任何非 loopback IPv4
- **THEN** 全部 URL 来自覆盖值，不产生 `no non-loopback IPv4 available` WARNING

#### Scenario: 非法覆盖值启动失败

- **WHEN** 覆盖值含 path 前缀（如 `https://ex.com/dweb`）或非 http(s) scheme
- **THEN** 启动以退出码 2 失败并输出 `error: invalid public ... url: <value>` 类错误

#### Scenario: relay 禁用时覆盖被忽略

- **WHEN** `--no-relay` 与 `--public-relay` 同时给出
- **THEN** relay 条目为 `enabled:false, url:null`，无告警

### Requirement: Server 身份与持久化

服务端 SHALL 在数据目录维护持久化身份：`<data_dir>/server.key`（32B Ed25519 seed，权限 0600，tmp+fsync+rename 原子写，load-or-create 幂等）。ServerId（对应公钥）SHALL 作为服务自标识在 `services.json` 中发布（字段只增，既有字段语义不变；`packages/server-binary` 的清单断言测试同步更新）。server.key MUST NOT 用于签发 relay capability（capability 只能由注册 Owner 的 root 私钥签发）；MUST NOT 使服务端获得任何 fabric 语义。`restricted` 模式下若配置了 relay QUIC bind（QAD 地址发现服务，无访问控制钩子），服务端 MUST 以 fail-fast 拒绝启动并输出明确错误（防未授权地址探测/隐私泄漏面），不得降级为静默禁用。

#### Scenario: 首次启动生成身份

- **WHEN** 数据目录为空启动服务端
- **THEN** 生成 `server.key`（0600），`services.json` 发布稳定 ServerId；重启后 ServerId 不变

#### Scenario: restricted 与 QAD 组合 fail-fast

- **WHEN** `restricted` 模式且配置了 relay QUIC bind 启动服务端
- **THEN** 启动以非零退出码失败并输出含 QAD 字样的错误信息

### Requirement: Server 访问策略（owner registry 与 access mode）

服务端 SHALL 维护 owner registry（`<data_dir>/owners.jsonl`，append-only，register/unregister 事件归并出活跃集合）：每条记录为 `(fabric_id, root EndpointId)` 二元组。access mode 经 `--access-mode`（CLI）与 `DWEB_ACCESS_MODE`（env）与 config.toml `[server.access]` 配置（优先级 flag > env > config > default），取值 `open`（默认）或 `restricted`。`restricted` 模式下 L2 准入策略由 `policy` 配置项选择 provider：`static`（默认，无票必拒 + 有效票放行）或 `callback`（见"动态策略回调" requirement；`callback_url`/`callback_token` 必填，缺失时启动 fail-fast）。空 registry 语义按 policy 分裂：`static` + 空 registry MUST 拒绝一切 relay 接入（fail-closed）；`callback` + 空 registry = 一切票据被 L1b 拒绝，仅 webhook 放行的无票端点（A_cb(S)，identity-only 动态名单，admin 自担）可达。registry 变更 MUST 持久化并在重启后恢复，且 MUST 使缓存 generation+1（清空策略缓存）。registry 移除 Owner 的语义为：**新连接即时拒绝**（下次 on_connect 起 `dweb/unknown-owner`）；已建立的存量连接保持至自然断开或重连收敛（主动断连钩子不在本 change 承诺内）。Server Admin（本地配置管理者）与 Relay Owner（registry 内 fabric root）是不同身份；服务端 MUST NOT 提供 Owner 自助注册（注册是 Admin 动作）。

#### Scenario: 空 registry fail-closed（static）

- **WHEN** `restricted` 且 `policy=static` 且 registry 为空，任何客户端连接 relay
- **THEN** 全部接入被拒绝

#### Scenario: 空 registry 的 callback 模式为 identity-only

- **WHEN** `restricted` 且 `policy=callback` 且 registry 为空，无票端点连接 relay 且 webhook 返回 allow=true
- **THEN** 该端点接入成功（A_cb(S) 边界）；出示任何票据的端点均被 L1b 拒绝（`dweb/unknown-owner`）

#### Scenario: registry 持久化

- **WHEN** 注册 owner 后重启服务端
- **THEN** registry 活跃集合恢复，已注册 owner 签发的有效 capability 仍可通过验证链

#### Scenario: 配置优先级

- **WHEN** 同一配置项在 CLI flag、环境变量、config.toml 中同时以不同值出现
- **THEN** 生效值为 CLI flag > env > config.toml > default

#### Scenario: unregister 阻断新连接

- **WHEN** 某 owner 被 unregister 后，其名下已签发的 capability 再次用于新连接
- **THEN** 新连接被拒（`dweb/unknown-owner`）；（存量连接语义见 requirement 正文）

#### Scenario: 二元组精确匹配

- **WHEN** registry 中有 (fabric_A, root_X)，而 capability 的 (fabric_id, issuer) 为 (fabric_B, root_X)
- **THEN** 接入被拒（`dweb/unknown-owner`）

### Requirement: relay capability 验证（L1 密码学完整性 + L1b 票有效性底线）

`restricted` 模式下，relay 的每条客户端接入若出示 capability，MUST 先通过不可绕过、不可插拔（与 policy provider 无关）的两级验证：**L1 密码学完整性**（本地、无网络调用，fail-closed 顺序执行）：长度门（≤1KiB）与 base64url 字符集白名单 → `dwebr1.` 格式与字段形状校验 → caps 位图无未知保留位 → issuer Ed25519 验签（域分隔 `dweb/relay-cap/v1`）→ server_id == 本服务端 ServerId → 时间校验（`now >= expires_at` 拒绝；`issued_at` 容忍 120s 时钟偏移；`issued_at <= expires_at`；TTL 验证侧统一上限 180 天）→ recipient == iroh-relay 握手认证的 endpoint_id。**L1b 票有效性底线**：(fabric_id, issuer) ∈ owner registry 活跃集合 → caps 含当前操作所需位（relay 接入需 RELAY）。两级验证均须在接入注册前完成、在任何策略 provider 决策（含 callback webhook）之前完成——策略层只能收紧不能放宽（无效票据 MUST 在到达 webhook 前被拒）。L1 计算成本为 O(1) + 单次验签。capability 是身份绑定凭证而非纯 bearer：仅持有令牌串而无对应私钥者在 relay 面与 rendezvous announce 面 MUST 被拒绝。

#### Scenario: 窃取令牌串不可用（relay 面）

- **WHEN** 攻击者窃取 capability 串并从自己的 endpoint 连接 relay
- **THEN** recipient 与握手认证 id 不匹配，接入被拒（`dweb/not-recipient`）

#### Scenario: 跨 Server 重放被拒

- **WHEN** 为 Server A 签发的 capability 出示给 Server B
- **THEN** server_id 不匹配，接入被拒（`dweb/wrong-server`）

#### Scenario: 过期拒绝含等值边界

- **WHEN** 当前时间 == capability 的 expires_at
- **THEN** 接入被拒（`dweb/capability-expired`）

#### Scenario: 超长 TTL 被拒

- **WHEN** capability 的 expires_at - issued_at 超过 180 天统一上限
- **THEN** 接入被拒（`dweb/capability-expired`）

#### Scenario: 过大的未来签发时间被拒

- **WHEN** capability 的 issued_at 超过当前时间 + 120s 时钟偏移容忍
- **THEN** 接入被拒（`dweb/capability-expired`）

#### Scenario: issued_at 晚于 expires_at 被拒

- **WHEN** capability 的 issued_at > expires_at（自相矛盾的时间字段）
- **THEN** 接入被拒（`dweb/capability-expired`）

### Requirement: 动态策略回调（callback policy provider）

`restricted` 模式且 `policy = "callback"` 时，relay 接入的 L2 准入决策 MUST 经 HTTP webhook 外部化。**事件范围仅 relay 面**（event ∈ relay.connect / relay.disconnect）；rendezvous 不接入 callback（其 HTTP 面无握手身份，动态策略另立 change，本 change rendezvous 维持静态 ACL）。webhook 请求以 Bearer `callback_token` POST 已验证的 AuthContext（endpoint_id 为握手认证身份；capability 为已过 L1+L1b 的有效票结构化投影，不含令牌原文/签名；connection_id 关联生命周期）到 `callback_url`，请求/响应体 ≤4KiB，按 200 响应的 `allow` 布尔值决定准入。**webhook MUST NOT 能豁免 L1/L1b**：无效票据（含缺所需 caps 位、未注册 owner）在到达 webhook 前已被拒。无 capability 的接入交给 webhook 裁决，其可达集合为独立定义的动态名单边界 A_cb(S)（admin 自担责任；webhook 对无票端点一律拒绝时 A_cb(S) 为空、行为与 static 一致）。fail-closed 恒定不可配置宽松：非 200 / 3xx 重定向 / 超时（默认与硬上限均 2000ms）/ 响应解析失败 / 缺 `allow` 或非布尔 / body 超限 / 并发超限 → 拒绝并返回 `dweb/policy-unavailable`（deny 结果同样入缓存）。**并发防护**：per-key singleflight、全局并发上限（默认 64）、每来源在途上限（默认 16）、有界等待队列（默认 256，队满即拒）。**缓存**：键 = (registry_generation, endpoint_id, capability 113B 定长投影, event)（投影单射直接作键，语义等同摘要；实现裁定见 design §8.5 实现期裁定注）；registry 变更即 generation+1 并清空全部缓存；TTL = min(响应 `cache_ttl_s`（**省略 = 使用配置默认**；非法值按 0 不缓存）, `callback_cache_ttl_ms` 上限 60s)；缓存仅作用于新连接准入，不作为存量连接撤销机制；webhook 交互侧失败的 deny 入缓存，负载侧拒绝（队列/超限）为瞬时条件不入缓存。**传输边界**：生产强制 https（`allow_loopback_callback` 显式豁免 loopback）；解析后拒绝私网（RFC1918/ULA）/link-local/云 metadata 网段；不跟随重定向；callback_token 日志全程脱敏。**reason 语法**：`dweb/[a-z0-9][a-z0-9._-]{0,63}`，非法值（含控制字符/非 ASCII/超长/空）替换为 `dweb/policy-denied`。**relay.disconnect 为 best-effort 观察通知**：fire-and-forget、不重试、允许丢失，MUST NOT 作为配额或撤销依据。callback 配置（url/token）缺失或非法时启动 fail-fast。

#### Scenario: webhook 允许即接入

- **WHEN** policy=callback，webhook 对 (endpoint_id, capability, relay.connect) 返回 allow=true
- **THEN** 接入成功；同键后续接入在缓存 TTL 内不再回调

#### Scenario: webhook 拒绝并透出自定义 reason

- **WHEN** webhook 返回 allow=false, reason="dweb/quota-exceeded"
- **THEN** 接入被拒，客户端收到 deny reason `dweb/quota-exceeded`

#### Scenario: 非法 reason 被替换

- **WHEN** webhook 返回的 reason 含控制字符/非 ASCII/超长/不合 slug 语法
- **THEN** 接入被拒，reason 替换为 `dweb/policy-denied`

#### Scenario: 无效票据不触发 webhook（L1/L1b 不豁免）

- **WHEN** 端点出示缺 RELAY 位、或 issuer 未注册、或签名/时间/recipient 任一不过的 capability，policy=callback
- **THEN** 接入被拒（对应 `dweb/caps-missing-relay` / `dweb/unknown-owner` / L1 对应 reason），webhook 未被调用

#### Scenario: webhook 失联 fail-closed

- **WHEN** callback_url 不可达、返回非 200/3xx、超时（≤2000ms）、响应缺 allow 字段或 body 超限
- **THEN** 接入被拒（`dweb/policy-unavailable`），deny 结果同样进入缓存

#### Scenario: 无票端点经 webhook 准入（A_cb(S) 动态名单）

- **WHEN** 端点未携带 capability，webhook 对该 endpoint_id 返回 allow=true
- **THEN** 接入成功（A_cb(S) 边界内）；出示伪造票据的端点仍被密码学层拒绝

#### Scenario: registry 变更即时清缓存（unregistered 票据不再回调）

- **WHEN** owner 被 unregister 后，其名下已缓存的票据再次接入（缓存 TTL 未到期）
- **THEN** 缓存已被 generation+1 失效；接入由 L1b 直接拒绝（`dweb/unknown-owner`），webhook 调用计数为 0（无效票据不触发 webhook）

#### Scenario: registry 变更后有效 key 产生新回调

- **WHEN** registry 发生任何变更（generation+1）后，一个仍有效票据或无票 A_cb key 再次接入
- **THEN** 旧缓存不命中，产生一次新回调并按其结果准入

#### Scenario: 并发风暴防护

- **WHEN** 同键并发 miss 或全局/来源并发超限、等待队列耗尽
- **THEN** 同键仅发一次回调（singleflight）；超限请求被拒（`dweb/policy-unavailable`），relay executor 不被拖垮

#### Scenario: SSRF 边界

- **WHEN** callback_url 指向私网/link-local/metadata 地址或返回重定向，且未设置 loopback 豁免
- **THEN** 按失联处理（`dweb/policy-unavailable`）；不跟随重定向、不发送 token 到其它 origin

#### Scenario: DNS rebinding 与地址族绕过

- **WHEN** callback_url 主机解析出多个地址且其一为私网/IPv4-mapped 形态，或解析结果在校验与连接之间发生变化
- **THEN** 任一地址非法即整体拒绝；实现使用解析后固定地址直连（不经系统代理、不二次解析），rebinding 不可达

#### Scenario: disconnect 生命周期事件

- **WHEN** 一条已准入连接断开
- **THEN** Server 向 webhook 发送 relay.disconnect 事件（best-effort，不阻塞不重试），携带对应 connection_id；事件丢失不影响准入与撤销语义

#### Scenario: Visitor 无法为授权集合外端点提供中继

- **WHEN** 持有效 capability 的 Visitor 试图让无 capability 的第三方 peer 经本 relay 与任意端点通信，且服务端为 `policy=static`（或 `policy=callback` 且 webhook 对该第三方无票接入返回 deny）
- **THEN** 第三方 peer 自身的接入在验证链（或 webhook）被拒；relay 投递目的地只能是在线已接入 client，可达边界（A(S)，callback 模式为 A(S) ∪ A_cb(S)）之外的端点经本 Server 零可达

### Requirement: rendezvous 访问控制

`restricted` 模式下，rendezvous announce 与 resolve MUST 要求 capability（HTTP `Authorization: Bearer dwebr1.…`），且出示的 capability MUST 通过与 relay 面同一套不可绕过验证器（L1 密码学完整性 + L1b 票有效性底线：registry 二元组等，各失败 reason 一致映射为 HTTP 401 响应体 `{"error":"dweb/<reason>"}`；"存在但非法"的凭证同样不得按无票处理）。announce：capability 的 caps MUST 含 RDZ_ANNOUNCE，且 **capability.recipient MUST == announce 请求体中签名的 EndpointId**（既有签名验证保留，签名私钥即 PoP，窃取 capability 者无法以他人身份登记）；不满足返回 401。resolve：caps MUST 含 RDZ_RESOLVE，为 **bearer-only 语义**（无 HTTP 面身份证明，capability 泄露即可用直至 TTL，属明示的降级承诺；L1 的 recipient==握手身份检查在 resolve 面不适用——无握手身份，仅验密码学有效性）；不满足返回 401。rendezvous 不接入 callback webhook（动态策略另立 change）。`open` 模式下 announce/resolve 行为与现状一致（签名 announce / 匿名 resolve）。

#### Scenario: restricted 下匿名 resolve 被拒

- **WHEN** `restricted` 模式下无 capability 的 GET /rendezvous/{id}
- **THEN** 返回 401，不返回任何登记项

#### Scenario: announce 的身份绑定校验

- **WHEN** `restricted` 模式下持 A 的 capability 但以 B 的私钥签名 announce
- **THEN** 返回 401（recipient ≠ 签名 EndpointId），不产生登记项

#### Scenario: announce 缺 RDZ_ANNOUNCE 位

- **WHEN** capability caps 仅含 RELAY，用于 announce
- **THEN** 返回 401

#### Scenario: resolve 缺 RDZ_RESOLVE 位

- **WHEN** `restricted` 模式下持仅含 RELAY 位的 capability 执行 GET /rendezvous/{id}
- **THEN** 返回 401，不返回任何登记项

#### Scenario: open 模式现状不变

- **WHEN** `open` 模式下匿名 resolve
- **THEN** 行为与本变更前一致

### Requirement: relay 资源限流

服务端 SHALL 接线 iroh-relay 1.1.0 **已实现**的限流能力：`client_rx` 客户端接收字节率（`[server.access] limits` 配置透传）。连接数类限额（accept_conn_limit/accept_conn_burst）上游标注未实现，本 change MUST NOT 承诺；per-owner 连接计数配额列为 Phase 3 钩子。限流语义 MUST 与 access mode 正交（open 模式下同样生效）。

#### Scenario: client_rx 限流独立生效

- **WHEN** `open` 模式且配置 client_rx 限额，单客户端发送速率超限
- **THEN** relay 按 iroh-relay 限流语义节流该客户端，与 capability 验证无关

