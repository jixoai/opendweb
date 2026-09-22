## MODIFIED Requirements

### Requirement: 邀请令牌（issuer-online 单次兑换）

邀请令牌 SHALL 是自包含的 `dweb1.` 前缀 base64url 字符串，编码 InviteV1：版本、fabric_id、invite_id、签发者 EndpointId、签发者 EndpointAddr（relay URL 与可选直连地址）、过期时间、可选的预期接收者 EndpointId、max_uses=1、签发者签名。兑换 SHALL 在线进行：被邀请者以自己的 EndpointId 密钥对（fabric_id, invite_id, 连接绑定材料）生成拥有权证明（PoP），通过独立兑换通道提交给签发者；签发者验证令牌签名、root 权限仍在、未过期、PoP 正确且 invite_id 未被消费过（持久化 CAS 消费）后，签发 `MemberGrant(subject=被邀请者)` 并回执。令牌被盗用时，攻击者缺少被邀请者私钥即无法完成 PoP；重复兑换因 invite_id 单次消费而失败。

**InviteV2（`dweb2.` 前缀）**：SHALL 支持 v2 布局（server-access-policy change 附录 A 为唯一 wire 权威）：recipient 变更为必填；relay 字段升级为有序列表（≤8 条），每条为 relay URL + 可选的该 server capability 凭证（`dwebr1.` 串，其 recipient MUST == 令牌 recipient 且 expires_at MUST ≤ 令牌 expires_at）；直连地址列表保留（≤4 条）。内嵌 capability 仅用于 join 拨号窗口的 relay 接入（bootstrap 语义）；长期凭证由兑换回执附发（见 session spec 的兑换通道 requirement）。旧客户端解码 `dweb2.` 令牌 MUST 报 `unsupported-invite-version` 错误码（含升级指引），不得静默降级。v1 令牌继续有效（新旧并存，物理隔离）。

**签发安全门**：当解析出的 relay URL 为空且显式直连地址列表（`advertise_addrs` 配置字段）为空时，签发操作 MUST 拒绝并返回专用错误 `InviteWithoutRelay`（含原因与配置指引），不得产出已知不可达的令牌。安全门只信显式配置来源：`advertise_addrs` MUST 在构造期校验（每项非空且可解析为 ip:port/[ipv6]:port、**拒绝通配地址**（0.0.0.0、:: unspecified）与**端口 0**（必须具体可拨；loopback 允许但文档注明仅同机可达）、重复项去重保序，非法项以 `[bad-advertise-addr]` 前缀报错），签发路径 MUST NOT 混入运行时探测地址（direct_addr_hints）。显式 `allow_relayless` 逃生阀 MUST 可绕过该门，供确有直连可达配置的调用方使用。

#### Scenario: 邀请与加入

- **WHEN** root 签发 InviteV1 令牌，被邀请者 B 以该令牌执行在线兑换
- **THEN** B 加入 fabric 并获得完整名册

#### Scenario: 单次兑换

- **WHEN** 同一令牌被第二次尝试兑换
- **THEN** 同一 invite_id 的第二次兑换尝试被拒绝

#### Scenario: 无 relay 且无持久直连地址时拒签

- **WHEN** relay 配置为空（disabled 或空列表）且 advertise_addrs 为空，调用 `invite`
- **THEN** 返回 InviteWithoutRelay 错误，不产出令牌

#### Scenario: 显式直连地址放行

- **WHEN** relay 为空但 advertise_addrs 配置了持久地址，调用 `invite`
- **THEN** 令牌正常签发，其中 relay 字段为空、直连地址为配置值

#### Scenario: 逃生阀放行

- **WHEN** relay 与 advertise_addrs 均为空，但调用方显式设置 allow_relayless
- **THEN** 令牌照常签发（可达性责任归调用方）

#### Scenario: 非法 advertise_addrs 构造报错

- **WHEN** 构造 Fabric 配置时 advertise_addrs 含空字符串、不可解析项、通配地址（0.0.0.0 / ::）或端口 0
- **THEN** 构造期以 `[bad-advertise-addr]` 前缀报错，不进入运行；loopback 与重复项（去重）被接受

#### Scenario: 过期令牌拒绝兑换

- **WHEN** 令牌过期时间已过
- **THEN** 兑换失败，B 不获得成员身份

#### Scenario: 无 PoP 的窃取者被拒

- **WHEN** 攻击者仅持有令牌但无法对连接绑定材料签名
- **THEN** 兑换失败

#### Scenario: v2 令牌携带多 relay 与 capability

- **WHEN** root 配置多条 relay（其中部分为 restricted server 且持签发 capability），签发 InviteV2
- **THEN** 令牌内嵌 relay 列表，每条含 URL 与对应 capability（recipient==令牌 recipient，TTL≤令牌 expires）；joiner 凭此在 restricted relay 上完成 join 拨号

#### Scenario: 旧客户端拒绝 v2 令牌

- **WHEN** 仅支持 v1 的客户端解码 `dweb2.` 令牌
- **THEN** 返回 `unsupported-invite-version` 错误，不尝试降级解析
