## ADDED Requirements

### Requirement: 身份查看命令（opendweb id）

`opendweb` CLI SHALL 提供只读命令 `opendweb id`：输出来自本机默认设备 key（SecretStore 既有的单 keypair，R2 裁决「一台设备一个默认 key」）的 endpoint_id（完整 64 hex）、防钓鱼缩写（首 3 + `***` + 尾 3）与 key 存储路径；MUST NOT 输出私钥材料，MUST NOT 修改任何状态（无副作用，重复执行输出一致）。多密钥对/设备指纹切换不在本命令范围（README 以「高级功能、暂未提供」指引）。README SHALL 含「一台设备一个默认 key」产品化说明：key 即设备身份（公钥即地址），重装/换机的身份迁移语义（新 key = 新身份，需管理员重新准入）。

#### Scenario: 只读且可重复

- **WHEN** 连续执行 `opendweb id` 两次
- **THEN** 输出一致（同一 endpoint_id/缩写/路径），无任何状态变更

#### Scenario: 不泄露私钥

- **WHEN** `opendweb id` 的 stdout/stderr 全量审查
- **THEN** 不含私钥或种子材料（仅公钥衍生信息）

### Requirement: 租户自助加入命令（opendweb join）

`opendweb` CLI SHALL 提供租户自助注册命令 `opendweb join --server <URL> --code <dwebc1 码>`：使用本机默认设备 key 作为 root（R2），若本地无 fabric 则生成新 fabric（FabricId 随机，复用 Roster 既有机制），构造并签名 `POST /register` 载荷（canonical：`b"dweb/register/v1\0" || code || fabric_id || root || ts u64BE`，ts 取本机时钟），发送兑换，成功后将 server URL、fabric_id、root、到期与回执保存到本地数据面（复用 SecretStore 目录纪律；**码与私钥不落日志**）。失败（bad-signature/stale-ts/code-\*/rate-limited）以人类可读错误退出非零，不产生半提交本地状态。已有 fabric 时 MUST 复用（`--fabric` 可显式指定），不得静默生成第二个。`https` 为默认期望；`http` 仅 loopback 放行，非 loopback 明文需 `--allow-insecure`（对齐 sidecar 明文守卫语义）。本命令是 R4「租户自助注册」的可执行入口——租户不手工构造 HTTP。

#### Scenario: 持码自助注册端到端

- **WHEN** 新设备执行 `opendweb join --server <URL> --code <有效码>`
- **THEN** 兑换成功，服务端名册出现 (新 fabric_id, 本机 root)，本地保存回执与到期；输出 endpoint_id 缩写与到期日

#### Scenario: 复用既有 fabric

- **WHEN** 本地已有 fabric 再次 join（持新码）
- **THEN** 以既有 (fabric_id, root) 兑换（服务端续期语义），不生成第二个 fabric

#### Scenario: 码失效的明确失败

- **WHEN** 持已耗尽/过期/吊销的码 join
- **THEN** 非零退出与对应错误码（code-exhausted/code-expired/code-invalid），本地无残留状态
