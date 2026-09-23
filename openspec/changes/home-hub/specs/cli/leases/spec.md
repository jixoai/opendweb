## ADDED Requirements

### Requirement: 多租约簿（leases，[H7]-G1）

本机租约 SHALL 从单条 `registration.json` 演进为 `<DWEB_HOME>/leases.json`（`{version, leases:[]}`），条目 = `{id, server(归一化 origin), relay_url, server_id, fabric_id, root, alias(自报机器名快照), label(本地备注，缺省 null), registered_at, expires_at, receipt}`；键 = `(server, fabric_id, root)`；**id** = 创建时随机 10 字符不透明键（UI 引用与 label 路由的稳定句柄）。写入 MUST 沿用 SecretStore 原子纪律（0600+tmp+fsync+rename；失败无半提交）。同键持新码 join = 续期 upsert：更新 expires_at/receipt/relay_url，**registered_at 保持首条**（镜像服务端 first_registered_at 裁决）；alias 更新为当前自报；同设备换 server = 新条目（0..N）。

**relay_url（入网闭环，null/disabled 语义冻结）**：join 已访问 `/services.json` 校验 server_id——relay 选择规则：取 `services[]` 中 `name=="relay" && enabled==true && url` 非 null 的条目 → relay_url=该值；**relay disabled 或 url=null → join fail-closed**（明确报错「中枢未启用中转，无法完成家庭接入」，**不落租约条目**——不产生宣称已加入却不可连接的租约；G-3 家庭链前提由此保证）。**成员连接该 server 时 MUST 经此 relay（凭证装配冻结）**：连接器从租约构造 `FabricOptions.relay={mode:"custom",relays:[{url:relay_url,serverId:server_id}]}`——SDK `CustomWithCaps` 形态，root 据 serverId 本地自签 own/bootstrap/member capability（server-access-roles 冻结契约：capability 由 root 自签、server 只验票；SDK 既有 `ensureRelayCapabilities` 实现）；capability 为 SDK 内存态、不入 leases.json。**签发时序冻结**：①构造 relays 配置并以 **createRoot（或 open 既有 root）**构造 Fabric——**构造器限定 root 形态**（home-hub 租约消费=join 注册形态：设备=本机 fabric 的 root；attach 空成员路径对 ensureRelayCapabilities 必败 `requires root`，不在此时序内，invite/attach 属 SDK 既有机制）；②**显式 `await ensureRelayCapabilities()`**（CustomWithCaps 构造只读静态 token、own capability 不自动签发）；③断言返回条目覆盖租约 (relay_url, server_id) 且 token 注入**同一实例** RelayMap；④此后才允许 join/connect；签发失败/不匹配/token 未注入=fail-closed（不静默降级、不写租约）。**不是无凭证 `urls:[...]` 形态**（restricted 中枢会以 `dweb/no-capability` 拒绝）。**join 顺序冻结**：register **之前**完成 services preflight（**至少一条**可用 relay：enabled+url 非空串+合法 http(s) URL，一条都没有=失败；多候选按 manifest 顺序取第一条合法者），register 成功后复核 server_id 与 relay URL；任一步失败 MUST NOT 写本地账本并明确报告远端登记状态（已 register 时提示重试经幂等回放恢复）。

**expires_at=本机最后一次成功兑换的租期快照**：管理端 renew 只改服务端 owners，MUST NOT 假设回写本机（无成员侧查询协议，Phase 2 候选）；租约呈现面 MUST 以「本地快照」语义展示（临期文案指引：若管理者已续期，数字在下次持新码加入时刷新；能否连上以实际连接为准）。

**跨进程写协议**：写者=join CLI 与 label 编辑（sidecar 面）；每账本文件配 `<name>.lock`（O_EXCL 创建，内容 pid+ts）：获取锁→锁内重读→合并→tmp+fsync+rename→校验锁仍属本进程→释放；陈锁（>10s 且 pid 已死）可打破；锁获取失败=短退避重试（≤3）后报错，MUST NOT 静默丢写。**迁移**：读取器发现旧 `registration.json` 且 leases.json 缺失时，在 leases 写锁内解析并入首条（relay_url 由对 server 发 /services.json 探测补全，不可达=留空待下次 join 补）并将旧文件改名 `registration.json.migrated`（不删）；解析失败不阻塞（警告+保留原文件）。join 的 fabric 复用语义改为按 server 维度查租约簿。

#### Scenario: join 落盘 relay_url 与凭证装配（端到端）

- **WHEN** 对 restricted 中枢执行 `opendweb join` 成功，随后读取该租约构造 SDK 连接配置并实际连接
- **THEN** relay_url = /services.json 的 relay URL；SDK 配置为 relays=[{url:relay_url,serverId:server_id}]（mode=custom，非 N0Default 非 urls 无凭证形态）；**以 createRoot root 身份在首次拨号前调用 ensureRelayCapabilities 且 token 注入同一实例**（attach 形态/未调用/不匹配=连接 fail-closed）；成员实际 relay 握手成功；无票连接被拒 `dweb/no-capability`；跨 server capability 被拒；malformed server_id/URL 在落租约前失败

#### Scenario: preflight 失败无远端 register（顺序冻结）

- **WHEN** /services.json 为 relay disabled / url:null / 空串 / 非 http(s) scheme / 重复条目时执行 `opendweb join`
- **THEN** disabled/null/空串/错 scheme=preflight 失败、**未发出 register**、无本地条目；重复条目=取 manifest 顺序第一条合法者继续

#### Scenario: relay 未启用则拒绝加入（fail-closed）

- **WHEN** 中枢 /services.json 的 relay 条目为 enabled:false 或 url:null，执行 `opendweb join`
- **THEN** join 明确报错退出（中枢未启用中转），leases.json 不新增条目

#### Scenario: 并发双写不丢更新

- **WHEN** 两个进程同时对不同 server 完成有效 join（或一 join 一 label 编辑）
- **THEN** leases.json 最终包含全部两条更新（锁内重读合并），无静默丢失

#### Scenario: 换服务器得到两条租约 / 同服务器新码续期不重置注册时刻

- **WHEN** 先后 join A、B / 持新码再 join A（registered_at=T0）
- **THEN** 两条独立租约各自倒计时 / 同键 upsert：expires_at 刷新、registered_at 保持 T0、relay_url/receipt 更新

#### Scenario: 管理端续期不回写本机快照（诚实呈现）

- **WHEN** 管理员在服务端为租户续期后，租户本机打开租约视角
- **THEN** 本机倒计时仍按最后兑换快照显示（标注本地快照语义）；临期文案含「若管理者已为你续期，数字在下次持新码加入时刷新」指引；实际连接可用性以探测/实际连接为准

#### Scenario: 旧 registration.json 迁移（三形态）

- **WHEN** 分别以完好/损坏/缺失的旧文件首次触发读取
- **THEN** 完好→并入首条（relay_url 探测补全或留空）且旧文件改名 .migrated；损坏→警告不阻塞、原文件原样；缺失→无迁移动作

### Requirement: 到访簿与连通探测（visits，G-2 best-effort）

本机 SHALL 维护 `<DWEB_HOME>/visits.json`（`{version, visits:[{server, server_id?, first_visit_at, last_visit_at, last_probe:{result, detail?, at}, note}]}`，键=server origin；同款原子写+锁协议；写者=sidecar probe 与既有访客连接类命令）。**业务定义=本机作为访客被放行后的记录：join 成功（租户路径）MUST NOT 写 visits**（租户只写 leases）。写入触发（v1）：①「测一下」探测动作；②既有访客连接类命令成功时；③未来访客连接器（Phase 2 候选，非本 change 承诺）。first_visit_at=条目创建；last_visit_at=最近一次 reachable 探测时刻。不承诺自动捕获每次放行连接（呈现面常驻 best-effort 声明）。**探测枚举冻结（五类确定映射）**：`result ∈ {reachable, unreachable}`（不使用「refused」作用户面词）；detail∈{`http-status:<n>`, timeout, dns, bad-body, conn-refused}；映射：2xx 且 services.json 可解析→reachable；非 2xx→unreachable/http-status；连接拒绝→conn-refused；DNS 失败→dns；超时（5s）→timeout；**2xx 但 JSON 不可解析→bad-body**。探测=无凭证 `GET <origin>/services.json`；「连不上」话术 MUST NOT 含「被拒」语义。

#### Scenario: 探测结果落账（五类确定映射）

- **WHEN** 分别对可达服务器、返回 500 的地址、连接被拒的端口、不可解析域名、返回 2xx 但 body 非 JSON 的地址执行「测一下」
- **THEN** 分别落 reachable / unreachable(http-status:500) / unreachable(conn-refused) / unreachable(dns) / unreachable(bad-body)；UI 均为二值话术且连不上文案不含「被拒」语义

#### Scenario: 租户加入不产生到访记录

- **WHEN** join 成功（租户路径）
- **THEN** visits.json 无该 server 条目；到访簿空态文案如实引导
