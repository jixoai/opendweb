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
### Requirement: rendezvous 登记/解析与访问控制（可选，不可信发现辅助）

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

`restricted` 模式下，rendezvous announce 与 resolve MUST 要求 capability（HTTP `Authorization: Bearer dwebr1.…`），且出示的 capability MUST 通过与 relay 面同一套不可绕过验证器（L1 密码学完整性 + L1b 票有效性底线：registry 二元组等，各失败 reason 一致映射为 HTTP 401 响应体 `{"error":"dweb/<reason>"}`；"存在但非法"的凭证同样不得按无票处理）。announce：capability 的 caps MUST 含 RDZ_ANNOUNCE，且 **capability.recipient MUST == announce 请求体中签名的 EndpointId**（既有签名验证保留，签名私钥即 PoP，窃取 capability 者无法以他人身份登记）；不满足返回 401。resolve：caps MUST 含 RDZ_RESOLVE，为 **bearer-only 语义**（无 HTTP 面身份证明，capability 泄露即可用直至 TTL，属明示的降级承诺；L1 的 recipient==握手身份检查在 resolve 面不适用——无握手身份，仅验密码学有效性）；不满足返回 401。**访客在 rendezvous 面的可达性 v1 冻结为空**：无 capability 的 resolve 维持 401（restricted），无票 announce 亦恒拒——rendezvous HTTP 面无端点身份证明，无法把无票请求绑定到具体访客；访客的可达面为 relay 通行（敲门即连，见"Server 访问策略"）；带访客身份绑定的定向解析（签名 resolve 变体）列为 Phase 2。rendezvous 不接入 callback webhook（动态策略另立 change）。`open` 模式下 announce/resolve 行为与现状一致（签名 announce / 匿名 resolve）。**基础限流**：resolve 与 announce 的 HTTP 面 MUST 实施 per-来源-IP 令牌桶限流（resolve 默认 60 次/分钟、announce 默认 20 次/分钟，`DWEB_RDZ_RATE_RESOLVE_PER_MIN`/`DWEB_RDZ_RATE_ANNOUNCE_PER_MIN` 可配，突发为速率值的一半；超限返回 429 + error envelope），与 access mode 正交（open 模式同样生效）。**IP 取值冻结**：限流键 MUST 为**直连 TCP peer 地址**（`ConnectInfo<SocketAddr>`）；`X-Forwarded-For`/`Forwarded` 等代理头 v1 一律不采信（可伪造）——反代部署下限流按代理地址聚合，属明示取舍；trusted-proxy CIDR 配置列为 Phase 2。

#### Scenario: restricted 下匿名 resolve 被拒

- **WHEN** `restricted` 模式下无 capability 的 GET /rendezvous/{id}，且访客名册为空
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

#### Scenario: 无票 resolve/announce 维持现状（访客可达面为空）

- **WHEN** `restricted` 模式，活跃访客存在，无 capability 的 GET /rendezvous/{id} 或 announce
- **THEN** 均返回 401（访客的可达面在 relay，不在 rendezvous）

#### Scenario: resolve 限流独立生效

- **WHEN** 同一来源 IP 在一分钟内发起超过配额的 resolve 请求
- **THEN** 超限请求返回 429 + error envelope（`rate-limited`），与凭证有效性无关

#### Scenario: open 模式现状不变

- **WHEN** `open` 模式下匿名 resolve
- **THEN** 行为与本变更前一致

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

服务端 SHALL 维护 owner registry（`<data_dir>/owners.jsonl`，append-only，register/unregister 事件归并出活跃集合）：每条记录为 `(fabric_id, root EndpointId)` 二元组，并可携带元数据 `alias`/`note` 与有效期 `expires_at`（u64 毫秒时间戳；**新增字段 MUST `serde(default)` 兼容——旧格式条目（无这些字段）解析为「永久、无别名」，MUST NOT 因缺字段启动失败**）。活跃集合的判定含时间维度：`expires_at` 已过的条目视为不活跃（L1b 拒绝，见"relay capability 验证"的 `dweb/owner-expired`）。access mode 经 `--access-mode`（CLI）与 `DWEB_ACCESS_MODE`（env）与 config.toml `[server.access]` 配置（优先级 flag > env > config > default），取值 `open`（默认）或 `restricted`。`restricted` 模式下 L2 准入策略由 `policy` 配置项选择 provider：`static`（默认，无票必拒 + 有效票放行）或 `callback`（见"动态策略回调" requirement；`callback_url`/`callback_token` 必填，缺失时启动 fail-fast）。空 registry 语义按 policy 分裂：`static` + 空 registry MUST 拒绝一切 relay 接入（fail-closed）；`callback` + 空 registry = 一切票据被 L1b 拒绝，仅 webhook 放行的无票端点（A_cb(S)，identity-only 动态名单，admin 自担）可达。registry 变更 MUST 持久化并在重启后恢复，且 MUST 使缓存 generation+1（清空策略缓存）。registry 移除 Owner、Owner 到期、加入黑名单的语义一致：**新连接即时拒绝**；已建立的存量连接保持至自然断开或重连收敛（主动断连经管理面 disconnect）。Server Admin（本地配置管理者）与 Relay Owner（registry 内 fabric root，UI 呈现层称「租户」）是不同身份；Owner 自助注册仅经邀请码兑换端点（见"租户邀请码与公开自助注册"），管理面注册仍是 Admin 动作。

服务端 SHALL 另维护两个同构 append-only 台账（同一 registry 存储模式：事件归并出活跃/当前集合、坏行启动 fail-fast、变更 generation+1、mtime 热重载、全字段 `serde(default)` 向后兼容）：

- **访客名册** `<data_dir>/visitors.jsonl`：事件 `{"op":"grant"|"revoke","endpoint_id":"<64hex>","alias"?, "note"?, "expires_at"?, "ts"}`。活跃访客 = 最新 grant 未 revoke 且未过期（`expires_at` 缺省 = 永久）。访客准入语义：relay 握手已密码学认证 endpoint_id（E1 链），设备 key 即身份——**无票接入按以下次序裁决，次序 MUST NOT 重排**：① 黑名单 endpoint 维度命中 → 拒 `dweb/blocked`；② 访客表命中（活跃）→ 放行（不咨询 callback webhook）；③ policy=callback → webhook 裁决（A_cb(S)）；④ 拒 `dweb/no-capability` 并记敲门（见"敲门日志"）。访客的可达面 MUST 限定为 relay 通行（rendezvous 可达面为空，无票 resolve/announce 维持 401，见"rendezvous 访问控制"）；访客不属于任何 fabric、不出现在 per-owner 投影。访客在线连接计入两级独立配额：per-endpoint `DWEB_RELAY_MAX_CONNECTIONS_PER_VISITOR`（默认 4）与全局 `DWEB_RELAY_MAX_VISITOR_CONNECTIONS`（默认 64，防多 key 女巫聚合；超限拒绝 reason 同为 `dweb/visitor-quota-exceeded`），不受（也不占）per-owner 配额。访客→租户转换后旧访客连接**不迁移**（新连接按租户身份计数；存量按自然断开收敛）。**在线投影**：在线表以 `(endpoint_id, Option<fabric_id>)` 为键——访客条目 fabric 为 None（MUST NOT 使用任何 sentinel 值，真实 FabricId 空间不得被保留字污染）；`GET /admin/connections` 的 `per_endpoint` 仅含租户对，新增 `per_visitor` 数组（`[{endpoint_id, connections}]`，endpoint_id 字典序）——纯增量字段，旧消费者忽略；`GET /admin/status` 以 `visitors_online` 计数呈现。**callback 缓存联动**：无票路径的 webhook 缓存键 MUST 纳入访客名册世代（复合 generation：owners 世代与 visitors 世代的组合；任一台账变更即相关缓存失效）——防止「访客 revoke 后仍命中 revoke 前的 allow 缓存」。
- **黑名单** `<data_dir>/blocklist.jsonl`：事件 `{"op":"add"|"remove","kind":"endpoint"|"fabric","id":"<64hex>","reason"?, "ts"}`，当前集合 = add 未 remove。endpoint 维度在凭证分类（C0）**之前**检查（有票无票同样生效）；fabric 维度在 L1 解析出 issuer 后、L1b 之前检查（命中的 issuer fabric 拒 `dweb/blocked`）。黑名单在 `open` 模式下不生效（open 不装配 gate），部署文档 MUST 明示这一边界。

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

#### Scenario: 旧格式 owners 条目解析为永久租户

- **WHEN** owners.jsonl 含本变更前格式的条目（无 expires_at/alias 字段），服务端启动
- **THEN** 启动成功，该条目按「永久、无别名」参与活跃集合（MUST NOT 因缺字段失败）

#### Scenario: 访客裁决次序——名册先于 webhook

- **WHEN** policy=callback，某端点是活跃访客，webhook 若被咨询将返回 allow=false，该端点无票连接 relay
- **THEN** 接入成功且 webhook 未被咨询（访客表命中即放行，次序 ② 先于 ③）

#### Scenario: 访客过期或吊销后回落原路径

- **WHEN** 某访客的 grant 已过期或被 revoke，policy=static，该端点无票连接 relay
- **THEN** 按无票路径拒绝（`dweb/no-capability`），并记敲门

#### Scenario: 访客连接配额独立于租户配额

- **WHEN** 活跃访客已建立 4 条连接（默认配额），发起第 5 条
- **THEN** 拒绝 `dweb/visitor-quota-exceeded`；同访客的连接不出现在任何 per-owner 投影中

#### Scenario: 黑名单 endpoint 维度先于凭证分类

- **WHEN** 某端点被加入黑名单（endpoint 维度），该端点随后持**有效** capability 连接 relay
- **THEN** 接入被拒 `dweb/blocked`（有效票不豁免黑名单）

#### Scenario: 黑名单 fabric 维度拒整个租户

- **WHEN** 某 fabric_id 被加入黑名单，该 fabric 名下任何 issuer 的有效 capability 连接 relay
- **THEN** 接入被拒 `dweb/blocked`

#### Scenario: 到期/黑名单/吊销不踢存量连接

- **WHEN** 某 owner 到期（或被加入黑名单、某访客被 revoke）时已有存量连接
- **THEN** 存量连接保持至自然断开或经管理面 disconnect；仅新连接被拒
### Requirement: relay capability 验证（L1 密码学完整性 + L1b 票有效性底线）

`restricted` 模式下，relay 的每条客户端接入若出示 capability，MUST 先通过不可绕过、不可插拔（与 policy provider 无关）的两级验证：**L1 密码学完整性**（本地、无网络调用，fail-closed 顺序执行）：长度门（≤1KiB）与 base64url 字符集白名单 → `dwebr1.` 格式与字段形状校验 → caps 位图无未知保留位 → issuer Ed25519 验签（域分隔 `dweb/relay-cap/v1`）→ server_id == 本服务端 ServerId → 时间校验（`now >= expires_at` 拒绝；`issued_at` 容忍 120s 时钟偏移；`issued_at <= expires_at`；TTL 验证侧统一上限 180 天）→ recipient == iroh-relay 握手认证的 endpoint_id。**L1b 票有效性底线**：(fabric_id, issuer) ∈ owner registry 活跃集合**且该条目未过期**（时间维度判定；已过期 → 拒 `dweb/owner-expired`，与未注册的 `dweb/unknown-owner` 区分）→ caps 含当前操作所需位（relay 接入需 RELAY）。两级验证均须在接入注册前完成、在任何策略 provider 决策（含 callback webhook）之前完成——策略层只能收紧不能放宽（无效票据 MUST 在到达 webhook 前被拒）。L1 计算成本为 O(1) + 单次验签。capability 是身份绑定凭证而非纯 bearer：仅持有令牌串而无对应私钥者在 relay 面与 rendezvous announce 面 MUST 被拒绝。

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

#### Scenario: 租户条目过期拒绝且 reason 与未注册区分

- **WHEN** registry 中存在该 (fabric_id, issuer) 二元组但条目 expires_at 已过，持其有效 capability 连接 relay
- **THEN** 接入被拒，deny reason 为 `dweb/owner-expired`（非 `dweb/unknown-owner`）
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

### Requirement: 敲门日志（KnockLog）

`restricted` 模式下，被拒绝的接入尝试 MUST 记入服务端内存敲门台账供管理面观察。**身份来源冻结（P0 红线）**：台账只接受 **relay 握手密码学认证的 endpoint_id**（E1 链）——rendezvous HTTP 面的 deny（匿名 resolve 无调用方身份；announce 签名验证前的 ACL 拒绝同样无已验身份）**MUST NOT 记入 endpoint 台账**（仅结构化 debug 日志；可另设 per-IP abuse 计数器，但不得伪装成"谁在敲门"）。挂点为 relay on_connect 的 Deny 臂。台账按 endpoint_id 聚合：`{endpoint_id, seq, first_at, last_at, count, last_reason, dismissed}`；同一端点重复敲门递增 count（u64 饱和递增，不回绕）并更新 last_at/last_reason；`seq` 为进程内单调序号，**每次 deny 分配新 seq**（排序键 = seq 降序——seq 单调故时钟回拨不影响排序，last_at 仅作展示字段）。dismiss/undismiss/新 deny/容量逐出 MUST 在同一锁内原子完成；并发 dismiss 与新 deny 的胜者 = 后获得锁者（deny 置 dismissed=false，dismiss 置 true，无 CAS 需求）。对不存在条目的 dismiss/undismiss 返回 404 no-match（与 disconnect 判定一致）；**`pending_count` 恒为未 dismissed 条目数**（`include_dismissed` 不改变该字段语义）。**排除项**：deny reason 为 `dweb/blocked` 的尝试 MUST NOT 记入；`dweb/owner-expired` 记入且作为租户到期提醒类别。**dismiss 语义**：dismiss 为幂等管理动作（不删除记录）；**该端点再次发生 deny 时 `dismissed` 自动复位为 false**（重新进入待办）；`undismiss` 为对等管理动作（手动恢复待办，幂等）。容量有界：最多 4096 个 endpoint 条目，超限按 **seq 最小者**逐出（与排序键同源，时钟回拨免疫；endpoint_id 升序仅作同 seq 的稳定 tie-break；last_at 仅展示不参与排序/逐出）（重启清空——敲门是运营提示而非审计事实，审计以管理操作回执为准；持久化列为未来工作）。

#### Scenario: 同端点重复敲门聚合计数

- **WHEN** 同一 endpoint_id 无票连接被拒 3 次（不同时间）
- **THEN** 台账中该端点为单一条目：count=3，first_at 为首次、last_at 为最近，last_reason 为最近一次原因

#### Scenario: 伪造身份不可入账（rendezvous 面隔离）

- **WHEN** 匿名 HTTP 请求以任意声称的 endpoint_id 触发 rendezvous deny（如无票 resolve/announce）
- **THEN** endpoint 敲门台账不新增/不更新任何条目（仅 debug 日志），攻击者无法污染待办列表或诱导授权

#### Scenario: 黑名单拒绝不入台账

- **WHEN** 端点命中黑名单被拒 `dweb/blocked`
- **THEN** 台账不新增/不更新该端点的记录

#### Scenario: 重启清空

- **WHEN** 服务端重启后查询敲门台账
- **THEN** 台账为空（无持久化承诺）

#### Scenario: dismiss 幂等与再次敲门复位

- **WHEN** 对同一敲门条目连续两次 dismiss，随后该端点再次无票被拒
- **THEN** 两次 dismiss 均成功（dismissed=true）；新 deny 使 dismissed 复位 false，重新计入 pending_count

#### Scenario: 排序契约

- **WHEN** 列表排序时两条记录 last_at 相同
- **THEN** 以进程内 seq 单调序号决出先后（seq 降序，last_at 仅展示；endpoint_id 升序为最终 tie-break），排序确定可测；时钟回拨不改变任何相对顺序

### Requirement: 租户邀请码与公开自助注册

服务端 SHALL 提供邀请码台账 `<data_dir>/codes.jsonl`（append-only，同一 registry 存储模式：坏行 fail-fast、generation、热重载、`serde(default)` 向后兼容）：事件 `{"op":"issue"|"revoke"|"consume","code_hash":"<blake3 64hex>","alias_hint"?,"max_uses"?,"expires_at","default_ttl_days"?,"fabric_id"?,"root"?,"ts"}`——**`consume` 为消费事件**（携带兑换出的 fabric_id/root），`used_count` 由事件归并推导（= consume 事件计数），MUST NOT 只存在于内存。码本体格式 `dwebc1.` + base32 16 字符（crockford 字符集，4-4-4-4 分组展示）；**生成 MUST 使用 OS CSPRNG**；**哈希输入规范化冻结**：取码本体 16 字符的小写规范化形态（剥离 `dwebc1.` 前缀与分组连字符）后 blake3；**存储与一切列表响应只含哈希，码全文仅出现在签发响应一次；日志/指标/错误消息 MUST NOT 含码全文或其可逆变换**（对齐 callback_token 脱敏纪律）。签发默认 `max_uses=1`、`expires_at=签发+7天`、`default_ttl_days=30`，逐项可自定义（R4）；输入上限：`max_uses ≤ 1000`、`expires_in_days ≥ 1`、`default_ttl_days ≥ 1`、`alias_hint ≤ 32` UTF-8 字节，越界 400 `invalid-request`。**fabric_id 语义（P1 明示）**：fabric_id 是**租户自声明标签**（FabricId 由 Roster 随机生成、无服务端可验的 genesis 绑定），身份键 = (fabric_id, root) 二元组（与 owners registry 既有精确匹配语义一致）；同 fabric_id 多 root 为合法并存条目，管理面 MUST 以二元组呈现租户身份（不可单显 fabric），同 fabric 多 root 时 UI 附钓鱼警示。错误码 `code-invalid`/`code-exhausted`/`code-expired` 的**状态区分为有意的产品取舍**（排障需要），属明示的信息泄露面。

**公开兑换端点 `POST /register`**（挂 gateway 根路径，不经 admin token；请求/响应体 ≤4KiB）：body `{"code","fabric_id":"<64hex>","root":"<64hex>","ts","sig"}`，其中 `sig` 为 body.root 对应 Ed25519 私钥对 `b"dweb/register/v1\0" || code || fabric_id || root || ts(u64BE)` 的签名（**root PoP：冒名注册他人 (fabric_id, root) 需要他人 root 私钥，不成立**；残余面=自声明 fabric_id，见上）。校验序（fail-closed）：per-来源-IP 令牌桶限流（**直连 TCP peer 地址，XFF 不采信**；默认 10 次/分钟，突发 5，`DWEB_REGISTER_RATE_PER_MIN` 可配；超限 429 `rate-limited`）→ 字段形状 → ts 窗口 ±120s（拒绝 `stale-ts`）→ **PoP 验签**（`bad-signature`——**幂等回放路径同样先验签**：认证边界与普通注册一致，r5-P2-1）→ **幂等命中**（同键 consume 已 durable → **200 幂等回放**：返回该键首次兑换持久化的结果，`expires_at` 不刷新、不新增 consume、不重复建条目；回执以当前时刻重签——旧码耗尽后同键重试同样走此路径，**不可用于续期**）→ 码哈希命中且未吊销未耗尽未过期（`code-invalid`/`code-exhausted`/`code-expired`）→ 新兑换。**续期语义的唯一入口是持新有效码的兑换**（同键旧码重试=幂等回放，不构成续期）。**消费原子性**：兑换判定与 consume 事件追加 MUST 在同一临界区内按 code_hash 串行（同码并发兑换互斥；`max_uses=1` 时并发双兑 MUST 恰一个成功，另一个 `code-exhausted`）。
**跨台账提交协议（consume 与 register 分属两个 jsonl，顺序冻结）**：① owners.jsonl 追加 register 事件（携带 `via_code_hash` 字段，`serde(default)` 兼容旧行）并 fsync；② codes.jsonl 追加 consume 事件并 fsync；③ **双 fsync 成功后才允许返回成功响应/签发回执**。**启动恢复**：归并时对每个带 via_code_hash 且无匹配 consume 事件的 register 事件，MUST 自动补齐缺失的 consume 事件（完成提交，相关 generation 递增）——崩溃窗口的结果恒为「完整兑换」或「码完好」，MUST NOT 出现「码已消费但租户不在册」（烧码无租户）。② 落盘失败且进程存活 = 500 且挂起补写（见下「码级 pending 预留」）；回执的 `generation` 字段 = **owners registry 世代**（register 为兑换的主效果；客户端视为不透明 u64）。
**码级 pending 预留与幂等键（r3-P0-1/P1-2）**：兑换幂等键 = `(code_hash, fabric_id, root)` 三元组。任一兑换通过校验后，该码即在台账锁内进入 pending 状态：pending 期间**其他幂等键的兑换请求一律 409 `code-pending`**（MUST NOT 基于未归并的 used_count 放行第二键——pending 释放以 consume durable 或兑换失败回滚为条件）；**同幂等键重试 = 幂等完成且不刷新租期**：consume 未 durable（pending 挂起）→ 按首次尝试已持久化的 register 结果补写 consume（**不重新计算租期**）；consume 已 durable → 幂等回放（见校验序，200、不重复 consume、回执以重试时刻重签）。**恢复/归并不变量**：孤儿匹配键为**完整三元组**（按 code_hash 粗匹配禁止——max_uses>1 同码多租户会漏补）；每个带 `via_code_hash` 的 register 事件至多对应一个同键 consume（重复 consume 事件按键去重）；`used_count` = 去重后的 consume 键数；无 `via_code_hash` 的旧行/管理员直加行**永不触发补写**。
**reconciliation 覆盖热重载（r3-P0-2）**：孤儿 consume 补齐 MUST 作为**每次加载（启动 + mtime 热重载）的同锁步骤**执行（与 pending 预留同一台账锁协调）；运行时经文件入口手工追加的带 via_code_hash register 在下次 reload 归并时同样补齐。**失败分级（r4-P1-3）**：(a) **台账加载/归并失败**（含首次启动——坏行/IO 不可读，此时无旧快照）= **服务 fail-fast 拒绝启动**（与 owners 坏行纪律完全一致——v1 不做台账级降级；重启后磁盘仍坏则持续拒绝启动，启动日志含台账路径与失败原因）；(b) **加载成功后的补写 append 失败** = 保留当前快照 + 受影响码加入**进程内 deny-set**（不落盘；deny-set 中的码兑换一律 503 `code-unavailable`）+ 告警；补写成功即按来源从 deny-set 移除（**仅 Redemption 来源自愈；Reconciliation 来源仅由整轮成功 reload 解除**，见下方细化语义）；进程重启后 deny-set 不复存在——由归并重演自然恢复（若磁盘仍坏则落入 (a) fail-fast）。可观测：告警含 code_hash、失败原因、重试次数。
**reconciliation 部分失败的细化语义（r10 实现期冻结）**：① mtime reload 中孤儿补写**部分失败**=保留既有快照（generation/内容不变）+失败 hash 合并入 deny-set（重试计数+1）——不发布部分补写的新快照（防 used_count 未整轮推进时绕过 max_uses）；部分失败轮的 deny 面=本轮孤儿中「存在任一 durable 三元组未包含在已发布快照」的 code hash **差集**（append 失败者恒在差集内；整轮成功=consumed 覆盖全部 durable 三元组时 deny 全量清空——**不采用"全部孤儿 deny"**：code_orphans 含历史全部兑换，会把无关码一并 503）；同键 pending 补写成功可完成当前请求但**不解除**该 hash 的 Reconciliation 来源 deny（仅 Redemption 来源自愈）；② redeem 错误优先级按 deny 来源区分：**同键 pending 重试恒为幂等补写恢复路径**（即使该码在 deny-set 也继续补写，再失败 500——崩溃窗口的恢复通道）；**他键**遇 deny 来源=Reconciliation（reload 补写整轮失败）→ **503 `code-unavailable` 优先**；来源=Redemption（首次 consume append 失败的 pending 窗口）→ 409 `code-pending`（既有语义不回退）。
**重放与中间层日志（r3-P2-2）**：同幂等键重放 = 幂等 200（见上）；跨键重放被 PoP 结构性阻止（签名绑定 fabric_id+root，换键即验签失败——无需额外 nonce）；生产部署文档 MUST 明示反向代理/access-log/tracing **禁止记录 `POST /register` 请求体**（与码全文脱敏同级的红线）。
**实现期冻结（1b 增补，与 CLI join 实现对拍互认）**：① `body.sig` 编码 = **base64url-nopad 严格**（拒绝 pad/非零尾位，非 64B → 400 `invalid-request`）；② canonical 中 `code` 取**请求原文**（服务端以 body 重建自洽验签），规范化（剥 `dwebc1.` 前缀/连字符、小写、crockford 16 字符校验）**仅用于 code_hash 计算**，规范化失败 → 400 `code-invalid`；③ 成功响应最小冻结 `{op:"register", code_hash, fabric_id, root, expires_at, ts, generation, receipt_sig}`（ts=响应当前时刻，幂等回放同以当前时刻重签；未知字段忽略）；④ HTTP 状态映射：400 `invalid-request`/`code-invalid`/`code-exhausted`/`code-expired`、401 `stale-ts`/`bad-signature`（对齐 rendezvous 面 401 先例）、429 `rate-limited`、500 落盘失败、>4KiB 体 413；/register 错误体用嵌套 envelope（同 admin 家族），rendezvous 限流 429 体为扁平 `{"error":"rate-limited"}`（同其 ACL envelope 家族）；⑤ register 限流突发 = rate/2（随 env 缩放，与 rendezvous 规则统一）；⑥ 幂等回放时若租户条目已注销/永久化，`expires_at` 回落 `u64::MAX`（wire 恒数字；该形态下注册已不在册，回放仅确认兑换事实）。通过后：registry 追加 register 事件（expires_at = now + default_ttl_days×24h，checked 运算防溢出；缺省 30 天——R5）；**同 (fabric_id, root) 已活跃 = 续期语义**（刷新 expires_at、保留 alias/note，不重复建条目）；返回 server.key 签名回执（canonical：`b"dweb/register-receipt/v1\0" || code_hash 32B || fabric_id 32B || root 32B || ts u64BE || generation u64BE`；**回执不含 code 本体**）。注册后该 root 即可经 capability 签发面获得 relay 准入（capability 由 root 侧自行签发——server 只认票据不签票据，identity.rs 域纪律不变）。**客户端入口**：`opendweb join` CLI（见 cli/identity capability）承担 root 选取/fabric 生成/签名/兑换/回执保存，HTTP 面不要求租户手工构造。

**[H6] 实现期增补（home-hub 默认别名=本机机器名，2026-09-23）**：① register body 增**可选 `alias` 字段**（设备自报别名；`serde(default)` 兼容旧客户端 body——无字段按缺省处理，不拒收）；形状约束与 alias_hint 同拍：非空、≤32 **UTF-8 字节**（按字节而非字符计数），越界 → 400 `invalid-request`；**不进 PoP canonical**（canonical 域冻结——自报是展示层标签而非认证载荷，不参与验签）；② 落 owners 条目 alias 的优先级 = **body.alias（设备自报）> 码条目 alias_hint > 无**；③ **首写语义**：alias 仅在新兑换路径落册；同键已存在（续期语义）时 body.alias **不覆盖**既有 alias（管理员 PATCH 命名与先前自报同受保护——v1 不区分「管理员设的」与「自报的」，以「既有即保留」收敛；管理员显式清除（PATCH 空串）后下一次自报可再首写）；④ 幂等回放路径零 owners 副作用，alias 不变（既有回放语义自然覆盖，无新增判定）。CLI 侧（对拍义务）：`opendweb join` 默认自报本机机器名（`os.hostname()` 剥尾部 `.local`，大小写不敏感），`--alias` 显式覆盖；客户端预截断到 ≤32 UTF-8 字节的**合法字符边界**（不劈多字节字符）并在输出提示截断；`opendweb id` 增输出本机机器名行（同一剥 `.local` 规范化）。

#### Scenario: 正常兑换与回执验签

- **WHEN** 租户以有效码 + 正确 root 签名调用 POST /register
- **THEN** 返回 200（op=register 回执字段 + expires_at）；registry 活跃集合出现该 (fabric_id, root)；回执可用 server.key 公钥按 canonical 验签；consume 事件已持久化（重启后 used_count 不丢失）

#### Scenario: 幂等回放不构成续期（max_uses=1 同键旧码重试）

- **WHEN** max_uses=1 的码已被键 K1 兑换耗尽后，K1 持有者以新 ts 重新签名同键请求
- **THEN** 返回 200 幂等回放：expires_at 与首次兑换持久化值相同（不刷新）、无新 consume/条目；任何他键请求返回 `code-exhausted`

#### Scenario: max_uses=2 的串行序列

- **WHEN** max_uses=2 的码：K1 首兑成功 → K1 同键重试（durable 后）→ K2 请求到达
- **THEN** K1 成功；同键重试 200 幂等回放且 used_count 仍为 1；K2 在 K1 durable 后按剩余次数成功（used_count=2）

#### Scenario: deny-set 码的 fail-closed

- **WHEN** 某码因补写 IO 失败进入 deny-set，持有效码请求兑换
- **THEN** 返回 503 `code-unavailable`（非 exhausted/expired——状态可区分）；补写成功后该码恢复兑换

#### Scenario: 并发双兑恰一个成功（max_uses=1）

- **WHEN** 两个并发请求持同一 max_uses=1 的码同时到达
- **THEN** 恰一个 200；另一个 `code-exhausted`；codes.jsonl 恰一条 consume 事件；无半提交

#### Scenario: 冒名注册被 PoP 拒绝

- **WHEN** 攻击者使用他人已注册的 (fabric_id, root) 与自己的私钥签名调用 POST /register
- **THEN** 返回 `bad-signature`（验签键为 body.root，攻击者无私钥即不成立）

#### Scenario: 自声明 fabric_id 不构成冒名（明示语义）

- **WHEN** 攻击者以自己的 root + 受害者的 fabric_id 兑换成功
- **THEN** registry 出现同 fabric_id 的第二个二元组条目（合法并存）；管理面以二元组区分并呈现钓鱼警示；该条目不能为攻击者带来受害者 fabric 的任何能力（fabric 成员资格由租户侧 roster 判定）

#### Scenario: 重放窗口

- **WHEN** 同一合法请求在 ts+120s 之后重发
- **THEN** 返回 `stale-ts`

#### Scenario: 码耗尽与过期

- **WHEN** max_uses=1 的码被**其他幂等键**第二次兑换（`code-exhausted`——同键重试走幂等回放，不耗尽）；或码 expires_at 已过（`code-expired`）
- **THEN** 两次拒绝的错误码互不相同且均不消耗对方状态

#### Scenario: 限流独立于码有效性（XFF 不采信）

- **WHEN** 同一来源 IP 一分钟内第 11 次调用 POST /register（即使前 10 次均为合法拒绝）；或请求伪造 X-Forwarded-For 试图分裂限流键
- **THEN** 第 11 次返回 429 `rate-limited`；限流键始终为直连 peer 地址，XFF 不影响

#### Scenario: 码全文零泄露

- **WHEN** 审查签发后的全部服务端日志、指标与错误响应
- **THEN** 不含码全文或其可逆变换（只允许哈希形态）

#### Scenario: register 落盘后崩溃，恢复补齐 consume

- **WHEN** 兑换完成 owners register（含 via_code_hash）fsync 后、consume 落盘前进程崩溃，重启后再次兑换同码
- **THEN** 启动归并补齐缺失 consume；租户在册且码计数正确（完整兑换）；若重启前有并发重试，同码幂等收敛不产生第二次租户条目

#### Scenario: pending 期间第二幂等键被拒

- **WHEN** 码 H 的兑换（键 K1）consume 落盘失败挂起补写期间，持同码不同 (fabric_id, root) 的键 K2 请求到达
- **THEN** K2 返回 409 `code-pending`（不得按未归并 used_count 放行）；K1 补写完成后 K2 按码状态正常裁决（max_uses=1 时 `code-exhausted`）

#### Scenario: consume 已 durable 后响应丢失的重试

- **WHEN** 客户端未收到响应（网络中断）后以同键重试 POST /register
- **THEN** 返回 200（幂等，不重复 consume、不重复建租户条目）；used_count 不因重试增加

#### Scenario: 热重载触发孤儿补齐

- **WHEN** 运行中经文件入口追加一条带 via_code_hash 的 register（无 consume），mtime 热重载发生
- **THEN** reload 归并补齐对应 consume（同锁、完整三元组匹配）；补写 IO 失败时保留旧快照且该码禁止兑换，其他功能不受影响

#### Scenario: unknown 敲门条目的处置动作

- **WHEN** 对不在台账的 endpoint_id 调用 dismiss 或 undismiss
- **THEN** 返回 404 + `no-match` envelope，无副作用

#### Scenario: pending_count 语义恒定

- **WHEN** `GET /admin/knocks?include_dismissed=true`
- **THEN** 响应包含已处置条目，但 `pending_count` 仍且仅为未 dismissed 条目数

#### Scenario: 重复注册为续期

- **WHEN** 已活跃租户持新有效码再次兑换同一 (fabric_id, root)
- **THEN** 成功返回且 expires_at 被刷新为 now + default_ttl_days（名册不出现重复条目；alias/note 保留）

### Requirement: 三角色管理面 API（敲门/访客/邀请码/黑名单/续期）

在 sdk-mgmt-surface 冻结的管理面基座（`/admin/*` Bearer token 认证、错误 envelope `{"error":{code,message}}`、未配置 token=零暴露 404、变更类操作 server.key 回执）之上，服务端 SHALL 提供三角色管理增量路由。全部响应 snake_case、未知字段忽略；全部变更类操作返回同构回执（canonical 复用 103B `b"dweb/admin-receipt/v1\0"` 布局，**generation = 该操作所属台账的 generation**（客户端视为不透明 u64；owners=register/renew、visitors=visitor-\*/knock-\*、codes=code-\*、blocklist=block-\*；KnockLog 为内存台账，knock-dismiss/undismiss 使用其内部单调计数器），op 枚举：renew=0x04 / visitor-grant=0x05 / visitor-revoke=0x06 / code-issue=0x07 / code-revoke=0x08 / block-add=0x09 / block-remove=0x0A / knock-dismiss=0x0B / knock-undismiss=0x0C / owner-meta=0x0D / visitor-meta=0x0E（**实现期增补（2a 集成发现）**：PM 别名/备注行内编辑的承载路由）。canonical/wire 槽位映射（未用维度置零字节）：

| op | fabric 32B | target 32B | 响应形态（除共享 op/ts/generation/receipt_sig 外） |
|---|---|---|---|
| renew 0x04 | fabric_id | root | `fabric_id`/`root`/`expires_at` |
| visitor-grant 0x05 / revoke 0x06 | 零 | endpoint_id | `endpoint_id`/`expires_at?` |
| code-issue 0x07 / revoke 0x08 | 零 | code_hash | 签发响应另含 `code` 全文（仅一次）；列表/吊销只回 `code_hash` |
| block-add 0x09 / remove 0x0A | fabric 命中时为 id、endpoint 维度为零 | id（非 32B 的 kind 用哈希填充并同步 wire 明示） | `kind`/`id`/`reason?` |
| knock-dismiss 0x0B / undismiss 0x0C | 零 | endpoint_id | `endpoint_id` |
| owner-meta 0x0D | fabric_id | root | `fabric_id`/`root`/`alias?`/`note?` |
| visitor-meta 0x0E | 零 | endpoint_id | `endpoint_id`/`alias?`/`note?` |

**实现期冻结（1c 增补）**：① `permanent` 的 wire 形态=回执/兑换响应 `expires_at: u64::MAX`（恒数字，与回放回落先例一致）、owners 列表 `expires_at: null`；② 回执 wire 显式携带两槽位字段（未用维度为 64 个 "0"，与 canonical 置零同步——客户端零特例重建）；③ visitors/blocklist 台账在 **open 模式下同样加载**（管理面与门禁执行面正交；O-9 冻结不变——open 不装 gate、门禁不生效；open 下坏行同样 fail-fast）；④ revoke/dismiss 族对 unknown 目标=404 no-match 且不写无效事件；重复 blocklist DELETE 第二次 404（幂等收敛）。
**client-sdk 同步义务**：`packages/client-sdk` 的 `./admin` subpath MUST 同步扩展 op 映射（0x04-0x0C）、Receipt 类型 union 与 canonical builder；`receipt-vector.json` fixture MUST 增补新 op 向量（Rust 生成断言 + TS 只读对拍，重生走既有 `DWEB_REGEN_FIXTURES=1` 门）；`register-receipt/v1` 的客户端验签 helper 随 `opendweb join` 提供。输入校验上限（越界 400 `invalid-request`）：`alias ≤ 32` UTF-8 字节、`note ≤ 256`、`alias_hint ≤ 32`、`max_uses ≤ 1000`、`expires_in_days ≥ 1`（0 非法）、`permanent:true` 与 `expires_in_days` 恰好其一；**到期边界冻结**：`now >= expires_at` 即过期（等值=过期）。

- **敲门**：`GET /admin/knocks`（排序冻结：dismissed 在前与否分组——未处置在前、组内 seq 降序（last_at 仅展示）、endpoint_id 升序 tie-break；`?include_dismissed=true` 含已处置；响应 `{"knocks":[…聚合条目…],"pending_count":N}`）；`POST /admin/knocks/{endpoint_id}/dismiss` 与 `POST /admin/knocks/{endpoint_id}/undismiss`（均幂等，回执 op=knock-dismiss/knock-undismiss）。
- **访客名册**：`GET /admin/visitors`（活跃列表：endpoint_id/alias/note/granted_at/expires_at）；`POST /admin/visitors`（body：endpoint_id 必填、alias/note/expires_in_days 可选，缺省=永久；回执 op=visitor-grant）；`DELETE /admin/visitors/{endpoint_id}`（revoke；回执 op=visitor-revoke）。语义糖路由 `POST /admin/visitors/from-knock`（body 含 endpoint_id，等同 POST，供敲门台一键定位）。
- **邀请码**：`GET /admin/codes`（列表只含 code_hash/max_uses/used_count/expires_at/alias_hint/revoked/default_ttl_days，**绝不含码全文**）；`POST /admin/codes`（body：alias_hint/max_uses/expires_in_days/default_ttl_days 可选，缺省 1/7/30；**响应含 `code` 全文——仅此一次**；回执 op=code-issue）；`DELETE /admin/codes/{code_hash}`（吊销；回执 op=code-revoke）。
- **租户续期**：`POST /admin/owners/{fabric_id}/{root}/renew`（body：`expires_in_days` 或 `permanent:true` 恰好其一；回执 op=renew）。**实现期增补（三角色走查 r2，2026-09-23）**：`expires_in_days` 基准冻结 = **max(now, 当前 expires_at)**（「顺延」语义：未到期从当前到期日起算；过期条目从 now 起算恢复准入；permanent→days 以 now 起算）。**元数据编辑（实现期增补，2a 集成发现）**：`PATCH /admin/owners/{fabric_id}/{root}`（body：`alias`/`note` 至少其一，空串=清除；长度上限同签发；回执 op=owner-meta）与 `PATCH /admin/visitors/{endpoint_id}`（同构；回执 op=visitor-meta）——PM 别名行内编辑的承载面。`GET /admin/owners` 列表条目增量携带 alias/note/expires_at/expires_in（剩余毫秒）/状态（active|expired）——增量字段，旧消费者忽略；`registered_at` = **首次注册时刻**——续期/元数据编辑/同键再兑换不刷新（事件行增量字段 `first_registered_at` 携带，旧事件行回退 `ts`；三角色走查发现改写问题后冻结）。
- **黑名单**：`GET /admin/blocklist`（当前集合：kind/id/reason/ts）；`POST /admin/blocklist`（body：kind(endpoint|fabric)/id/reason?；回执 op=block-add）；`DELETE /admin/blocklist/{kind}/{id}`（回执 op=block-remove）。
- **状态增量**：`GET /admin/status` 响应增量字段 `knocks_pending`/`visitors_active`/`codes_active`/`visitors_online`（既有 wire 冻结不变，新字段为纯增量）。

#### Scenario: 敲门列表排序契约

- **WHEN** 存在 2 条未处置与 1 条已处置敲门（未处置的 last_at 较新），`GET /admin/knocks`
- **THEN** 前两条为未处置且按 seq 降序（last_at 仅展示），已处置条目不在默认响应中；pending_count=2

#### Scenario: 签发响应码全文仅一次

- **WHEN** `POST /admin/codes` 签发成功
- **THEN** 响应含 `code` 全文（`dwebc1.` 前缀 + 16 字符）与回执；此后 `GET /admin/codes` 与一切后续响应只含 code_hash

#### Scenario: 吊销后兑换立即拒绝

- **WHEN** 码签发后立即 `DELETE /admin/codes/{code_hash}`，随后持码全文调用 POST /register
- **THEN** 兑换被拒（`code-invalid`）

#### Scenario: 续期恢复准入

- **WHEN** 租户条目已过期（连接被拒 `dweb/owner-expired`），`POST /admin/owners/{fabric}/{root}/renew` body `{"expires_in_days":30}`
- **THEN** 回执 op=renew；该租户的有效 capability 随后接入成功

#### Scenario: 未到期租户续期顺延

- **WHEN** 租户条目剩余 20 天有效期（未到期），`POST /admin/owners/{fabric}/{root}/renew` body `{"expires_in_days":30}`
- **THEN** 新到期时刻 = 旧到期时刻 + 30 天（顺延基准 = max(now, 当前 expires_at)，非 now + 30 天）；名册 `registered_at` 保持首次注册时刻不变

#### Scenario: status 增量字段不破坏旧消费者

- **WHEN** 旧版本消费者（只读 owners_count/active_connections 等既有字段）请求 `GET /admin/status`
- **THEN** 既有字段语义与 sdk-mgmt-surface 冻结 wire 逐字节一致；新增 knocks_pending 等字段被旧消费者忽略不致错
