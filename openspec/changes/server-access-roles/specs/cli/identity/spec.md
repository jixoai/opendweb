## ADDED Requirements

### Requirement: 身份查看命令（opendweb id）

`opendweb` CLI SHALL 提供只读命令 `opendweb id`：输出来自本机默认设备 key（SecretStore 既有的单 keypair，R2 裁决「一台设备一个默认 key」）的 endpoint_id（完整 64 hex）、防钓鱼缩写（首 3 + `***` + 尾 3）与 key 存储路径；MUST NOT 输出私钥材料，MUST NOT 修改任何状态（无副作用，重复执行输出一致）。多密钥对/设备指纹切换不在本命令范围（README 以「高级功能、暂未提供」指引）。README SHALL 含「一台设备一个默认 key」产品化说明：key 即设备身份（公钥即地址），重装/换机的身份迁移语义（新 key = 新身份，需管理员重新准入）。

#### Scenario: 只读且可重复

- **WHEN** 连续执行 `opendweb id` 两次
- **THEN** 输出一致（同一 endpoint_id/缩写/路径），无任何状态变更

#### Scenario: 不泄露私钥

- **WHEN** `opendweb id` 的 stdout/stderr 全量审查
- **THEN** 不含私钥或种子材料（仅公钥衍生信息）
