## ADDED Requirements

### Requirement: 多租约簿（leases，[H7]-G1）

本机租约 SHALL 从单条 `registration.json` 演进为 `<DWEB_HOME>/leases.json`（`{version, leases:[]}`），条目 = `{server(归一化 origin), server_id, fabric_id, root, alias(自报机器名快照), label(本地备注，缺省 null), registered_at, expires_at, receipt}`；键 = `(server, fabric_id, root)`。写入 MUST 沿用 SecretStore 原子纪律（0600+tmp+fsync+rename；失败无半提交）。同键持新码 join = 续期 upsert：更新 expires_at/receipt，**registered_at 保持首条**（镜像服务端 first_registered_at 裁决）；alias 更新为当前自报；同设备换 server = 新条目（0..N）。

**跨进程写协议（防丢更新）**：写者=join CLI 与 label 编辑（sidecar 面）两个进程面；每个账本文件配 `<name>.lock`（O_EXCL 创建，内容 pid+ts）：获取锁→**锁内重读**→合并→tmp+fsync+rename→校验锁仍属本进程→释放；陈锁（>10s 且 pid 已死）可打破；锁获取失败=短退避重试（≤3）后报错，MUST NOT 静默丢写。**迁移**：读取器发现旧 `registration.json` 且 leases.json 缺失时，在 leases 写锁内解析并入为首条并将旧文件改名 `registration.json.migrated`（不删）；解析失败不阻塞（警告+保留原文件）；迁移与 join 并发相撞由同一把锁串行。join 的 fabric 复用语义改为按 server 维度查租约簿。

#### Scenario: 并发双写不丢更新

- **WHEN** 两个进程同时对不同 server 完成有效 join（或一 join 一 label 编辑）
- **THEN** leases.json 最终包含全部两条更新（锁内重读合并）；任一进程的更新不因另一进程的 rename 而丢失

#### Scenario: 换服务器得到两条租约

- **WHEN** 同一设备先后 join 服务器 A 与服务器 B（各持有效码）
- **THEN** leases.json 含两条租约（键不同），各自独立倒计时

#### Scenario: 同服务器新码续期不重置注册时刻

- **WHEN** 已有服务器 A 的租约（registered_at=T0），到期前持新码再次 join A
- **THEN** 同键 upsert：expires_at 刷新，registered_at 保持 T0，receipt 更新

#### Scenario: 旧 registration.json 迁移（三形态）

- **WHEN** 分别以完好/损坏/缺失的旧 registration.json 首次触发读取
- **THEN** 完好→并入首条且旧文件改名 .migrated 保留；损坏→警告不阻塞、原文件原样；缺失→无迁移动作

### Requirement: 到访簿与连通探测（visits，G-2 best-effort）

本机 SHALL 维护 `<DWEB_HOME>/visits.json`（`{version, visits:[{server, server_id?, first_visit_at, last_visit_at, last_probe:{result, detail?, at}, note}]}`，键=server；同款原子写+锁协议；写者=join CLI 与 sidecar probe）。写入触发（v1 诚实范围）：join 成功（同源记录）、webui「测一下」探测动作、既有连接类命令成功时；**不承诺**自动捕获每次放行连接（呈现面 MUST 常驻 best-effort 声明；client-sdk 连接成功事件钩子=Phase 2 候选，非本 change 承诺）。**探测结果枚举冻结**：`result ∈ {reachable, unreachable}`（不使用「refused」作用户面词，避免与准入被拒歧义）；`detail` 为内部归类字段 ∈ {`http-status:<n>`, timeout, dns, bad-body, conn-refused}。映射：HTTP 2xx 且 services.json 可解析→reachable；非 2xx→unreachable/http-status；连接拒绝→unreachable/conn-refused；DNS 失败或超时（5s）→unreachable/dns|timeout。探测=无凭证 `GET <origin>/services.json`；「连不上」话术 MUST NOT 表述为「被拒」。

#### Scenario: 探测结果落账（分类映射）

- **WHEN** 分别对可达服务器、返回 500 的地址、连接被拒的端口、不可解析域名执行「测一下」
- **THEN** 四种情况分别落 reachable / unreachable(http-status:500) / unreachable(conn-refused) / unreachable(dns)，UI 呈现均为二值话术且连不上文案不含「被拒」语义

#### Scenario: 不虚造记录

- **WHEN** 本机从未成功连接过某服务器
- **THEN** visits.json 无该条目；空态文案如实引导
