## ADDED Requirements

### Requirement: 多租约簿（leases，[H7]-G1）

本机租约 SHALL 从单条 `registration.json` 演进为 `<DWEB_HOME>/leases.json`（`{version, leases:[]}`），条目 = `{server(归一化 origin), server_id, fabric_id, root, alias(自报机器名快照), label(本地备注，缺省 null), registered_at, expires_at, receipt}`；键 = `(server, fabric_id, root)`。写入 MUST 沿用 SecretStore 原子纪律（0600+tmp+fsync+rename；失败无半提交——join 既有纪律平移）。同键持新码 join = 续期 upsert：更新 expires_at/receipt，**registered_at 保持首条**（镜像服务端 first_registered_at 裁决）；alias 更新为当前自报；同设备换 server = 新条目（0..N）。**迁移**：读取器发现旧 `registration.json` 且 leases.json 缺失时，解析成功则并入为首条并将旧文件改名 `registration.json.migrated`（不删）；解析失败不阻塞（警告+保留原文件）。join 的 fabric 复用语义改为按 server 维度查租约簿。

#### Scenario: 换服务器得到两条租约

- **WHEN** 同一设备先后 join 服务器 A 与服务器 B（各持有效码）
- **THEN** leases.json 含两条租约（键不同），各自独立倒计时

#### Scenario: 同服务器新码续期不重置注册时刻

- **WHEN** 已有服务器 A 的租约（registered_at=T0），到期前持新码再次 join A
- **THEN** 同键 upsert：expires_at 刷新，registered_at 保持 T0，receipt 更新

#### Scenario: 旧 registration.json 迁移

- **WHEN** 存在既有单条 registration.json 的设备首次使用新版 join/webui
- **THEN** 首条租约并入 leases.json，旧文件改名 .migrated 保留；损坏的旧文件只警告不阻塞

### Requirement: 到访簿与连通探测（visits，G-2 best-effort）

本机 SHALL 维护 `<DWEB_HOME>/visits.json`（`{version, visits:[{server, server_id?, first_visit_at, last_visit_at, last_probe:{result:reachable|unreachable, at}, note}]}`，键=server；同款原子写纪律）。写入触发（v1 诚实范围）：join 成功（同源记录）、webui「测一下」探测动作、既有连接类命令成功时。**不承诺**自动捕获每次放行连接——呈现面 MUST 常驻 best-effort 声明（PRODUCT-DESIGN §3.4 逐字文案）；client-sdk 连接成功事件钩子为 Phase 2 候选（非本 change 承诺）。探测实现 = 对 server origin 发无凭证 `GET /services.json`（5s 超时）。

#### Scenario: 探测结果落账

- **WHEN** 在到访视角对某服务器点「测一下」且服务器可达
- **THEN** 该条 last_probe={result:reachable, at:当前}；服务器停机时 result=unreachable，页面话术不误导为「被拒」

#### Scenario: 不虚造记录

- **WHEN** 本机从未成功连接过某服务器
- **THEN** visits.json 无该条目；空态文案如实引导
