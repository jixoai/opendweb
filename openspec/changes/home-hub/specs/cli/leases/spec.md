<!--
intent:
  - id: home-hub-multi-lease-book
    why: registration 单条 → leases.json 0..N（多 server/同 fabric）+relay_url
    入网闭环+本地快照语义（[H7]-G-1；r2/r4/r5-r13 评审链）
原始输入：requirements.md [H5]/[H7]/[H8]；design.md §2.1（2026-09-24）。
-->

## ADDED Requirements

### Requirement: 多租约簿（leases，[H7]-G1）

本机租约 SHALL 从单条 `registration.json` 演进为 `<DWEB_HOME>/leases.json`（`{version, leases:[]}`），条目 = `{id, server(归一化 origin), relay_url, server_id, fabric_id, root, alias(自报机器名快照), label(本地备注，缺省 null), registered_at, expires_at, receipt}`；键 = `(server, fabric_id, root)`；**id** = 创建时随机 10 字符不透明键（UI 引用与 label 路由的稳定句柄）。写入 MUST 沿用 SecretStore 原子纪律（0600+tmp+fsync+rename；失败无半提交）。同键持新码 join = 续期 upsert：更新 expires_at/receipt/relay_url，**registered_at 保持首条**（镜像服务端 first_registered_at 裁决）；alias 更新为当前自报；同设备换 server = 新条目（0..N）。

**relay_url（入网闭环，null/disabled 语义冻结）**：join 已访问 `/services.json` 校验 server_id——relay 选择规则：取 `services[]` 中 `name=="relay" && enabled==true && url` 非 null 的条目 → relay_url=该值；**relay disabled 或 url=null → join fail-closed**（明确报错「中枢未启用中转，无法完成家庭接入」，**不落租约条目**——不产生宣称已加入却不可连接的租约；G-3 家庭链前提由此保证）。**成员连接该 server 时 MUST 经此 relay（凭证装配冻结）**：连接器从租约构造 `FabricOptions.relay={mode:"custom",relays:[{url:relay_url,serverId:server_id}]}`——SDK `CustomWithCaps` 形态，root 据 serverId 本地自签 own/bootstrap/member capability（server-access-roles 冻结契约：capability 由 root 自签、server 只验票；SDK 既有 `ensureRelayCapabilities` 实现）；capability 为 SDK 内存态、不入 leases.json。**签发时序冻结（deferStart 五步，[H8]）**：①以 **createRoot/open（既有 root）的 `deferStart` 形态**构造（relays 配置同上；**构造期零网络出站**——不 bind/不等 online/不以缓存票据连 relay；构造器限定 root 形态，attach 成员路径不在此时序）；②**显式 `await ensureRelayCapabilities()`**（deferred 态可执行；CustomWithCaps 构造只读静态 token、own capability 不自动签发）；③断言返回条目覆盖租约 (relay_url, server_id) 且 token 注入**同一实例**；④`await fabric.start()`——**注入合并优先级冻结**：本次 ensure 且断言过的票 > tuple 校验通过的缓存票（同 URL 冲突 ensured 票胜；缓存票参与注入的前置=fabric/issuer/server/URL 与租约一致且未过期，不匹配=忽略+诊断；构造期完成非网络缓存预检）→bind+online（首次 relay 接触已带有效 capability；start 幂等，状态机 Deferred→Starting→Started|Failed→Closed，并发 single-flight）；⑤此后才允许 join/connect；②③任一不符=fail-closed（不调 start、不静默降级、不写租约）。**Node 桥接**：client-sdk NAPI `FabricOptions.deferStart`（缺省 false=eager 既有行为不变，仅 createRoot/open 生效）+`Fabric.start()`+d.ts 同步+集成测试（CustomWithCaps 全链含首触带票观测）；CLI 不引入 NAPI 依赖（端到端验证载体=client-sdk 集成测试，连接器命令留未来 change）；dweb-fabric 扩展附单测；dweb-server 零改动。
**身份 tuple 同源（r7-P1-1+r10-P1-1 供给路径反转）**：`(fabric_id, root)` 唯一生成点=CLI join（fabric_id 三源保留：flag/既有租约复用/CSPRNG；root=设备 seed 推导；**CLI 不引入 NAPI**）；SDK 侧以 `FabricOptions.fabricId`（仅 createRoot，见 specs/sdk/node delta；**[H8] 二次拍板明文授权**）显式采纳租约值并持久化，**消费路径 Fabric dataDir 固定=`<DWEB_HOME>`（SDK 既有默认身份解析由此天然读 join 的 identity.key——同文件同源，零新 seed API；dataDir≠DWEB_HOME=构造前禁止；identity.key 缺失/损坏=构造前明确错误；单设备单 roster 与 fabric 复用裁决一致；断言 register.root==lease.root==SDK endpointId()，重启后仍相等；异 data_dir=首拨前 fail-closed）**——首拨前断言 `fabricIdHex()==lease.fabric_id`、`endpointId()==lease.root`、capability (fabric_id,issuer,server_id) 覆盖租约保留为防御层；roster 已存在只 open 同一 roster（冲突=明确错误），不得静默生成第二个 roster 或 seed；**首次拨号前断言** `fabric_id_hex()==lease.fabric_id`、`endpoint_id()==lease.root`、capability (fabric_id, issuer, server_id) 覆盖租约——任一不符/旧 roster/异 seed/不匹配=首拨前 fail-closed 且账本不变。**不是无凭证 `urls:[...]` 形态**（restricted 中枢会以 `dweb/no-capability` 拒绝）。**单 fabric 约束**：每个 DWEB_HOME 恰好一个 fabric——join preflight 在 register 前读既有 roster/租约的 fabric_id，`--fabric` 显式值或将生成值与既有值不等=**fail-closed**（不 register、不写 leases、明确错误）；同 fabric 跨 server=必须成功（H7 多租约形态=多 server/同 fabric 子集，N 是 server 维度、fabric 维度恒 1——与 join「既有 fabric MUST 复用」冻结语义一致）。**join 顺序冻结**：register **之前**完成 services preflight（**至少一条**可用 relay：enabled+url 非空串+合法 http(s) URL，一条都没有=失败；多候选按 manifest 顺序取第一条合法者），register 成功后复核 server_id 与 relay URL；任一步失败 MUST NOT 写本地账本并明确报告远端登记状态（已 register 时提示重试经幂等回放恢复）。

**expires_at=本机最后一次成功兑换的租期快照**：管理端 renew 只改服务端 owners，MUST NOT 假设回写本机（无成员侧查询协议，Phase 2 候选）；租约呈现面 MUST 以「本地快照」语义展示（临期文案指引：若管理者已续期，数字在下次持新码加入时刷新；能否连上以实际连接为准）。

**跨进程写协议**：写者=join CLI 与 label 编辑（sidecar 面）；每账本文件配 `<name>.lock`（O_EXCL 创建，内容 pid+ts）：获取锁→锁内重读→合并→tmp+fsync+rename→校验锁仍属本进程→释放；陈锁（>10s 且 pid 已死）可打破；锁获取失败=短退避重试（≤3）后报错，MUST NOT 静默丢写。**迁移**：读取器发现旧 `registration.json` 且 leases.json 缺失时，在 leases 写锁内解析并入首条（relay_url 由对 server 发 /services.json 探测补全，不可达=留空待下次 join 补）并将旧文件改名 `registration.json.migrated`（不删）；解析失败不阻塞（警告+保留原文件）。join 的 fabric 复用语义改为按 server 维度查租约簿。

#### Scenario: join 落盘 relay_url 与凭证装配（端到端）

- **WHEN** 对 restricted 中枢执行 `opendweb join` 成功（CLI 纯 JS 生成 tuple 并落 lease），随后 SDK 以 `createRoot(fabricId=lease.fabric_id, seed=<DWEB_HOME>/identity.key, deferStart)`/open 构造并实际连接
- **THEN** relay_url = /services.json 的 relay URL；SDK 配置为 relays=[{url:relay_url,serverId:server_id}]（mode=custom，非 N0Default 非 urls 无凭证形态）；**以 createRoot root 身份在首次拨号前调用 ensureRelayCapabilities 且 token 注入同一实例**（attach 形态/未调用/不匹配=连接 fail-closed）；成员实际 relay 握手成功；无票连接被拒 `dweb/no-capability`；跨 server capability 被拒；malformed server_id/URL 在落租约前失败

#### Scenario: 身份 tuple 同源与分叉拒绝

- **WHEN** fresh 设备以 createRoot→register→ensure→restricted 握手（正向）；以及分别以篡改过的 lease.fabric_id、另一 data_dir/seed 的 roster、stale roster 尝试首拨（负向）
- **THEN** 正向全链成功（register/lease/票据用的同一 (fabric_id, root)，握手通过；deferred 构造期零网络出站、首次 relay 接触晚于 ensure）；三个负向均在**首次拨号前**被连续性断言拒绝且 leases.json 保持不变——不由「实际握手失败」兜底发现

#### Scenario: 缓存旧票不得覆盖 ensured 票（合并优先级）

- **WHEN** 目标 relay URL 存在缓存旧票（分别属错误 server/错误 fabric/错误 issuer/同 tuple 过期/同 tuple 有效）时重走五步时序
- **THEN** start 后 RelayMap 中该 URL 持有匹配本次租约的票（ensured 或同 tuple 有效缓存票；四类不匹配旧票被忽略并留诊断）；relay 侧观测首次连接携带该票；负向路径不先拨号、不写租约

#### Scenario: 重开复用（open 既有 root 正向）

- **WHEN** 同一 data_dir/seed 在成功入网后重启进程，以 open（deferStart）→ensure→断言→start→connect 重走时序
- **THEN** register 与 lease 的 (fabric_id, root) 与首次一致；ensure 重签/恢复 capability 后 restricted 握手成功；错误 seed 或目录仍在首拨前拒绝

#### Scenario: preflight 失败无远端 register（顺序冻结）

- **WHEN** /services.json 为 relay disabled / url:null / 空串 / 非 http(s) scheme / 重复条目时执行 `opendweb join`
- **THEN** disabled/null/空串/错 scheme=preflight 失败、**未发出 register**、无本地条目；重复条目=取 manifest 顺序第一条合法者继续

#### Scenario: relay 未启用则拒绝加入（fail-closed）

- **WHEN** 中枢 /services.json 的 relay 条目为 enabled:false 或 url:null，执行 `opendweb join`
- **THEN** join 明确报错退出（中枢未启用中转），leases.json 不新增条目

#### Scenario: 并发双写不丢更新

- **WHEN** 两个进程同时对不同 server 完成有效 join（或一 join 一 label 编辑）
- **THEN** leases.json 最终包含全部两条更新（锁内重读合并），无静默丢失

#### Scenario: 换服务器得到两条租约（同 fabric）

- **WHEN** 同设备先后 join 服务器 A 与 B（既有 fabric 复用，各持有效码）
- **THEN** leases.json 两条租约（server 键不同，fabric_id/root 相同）各自独立倒计时；两条均可用同一 roster 消费

#### Scenario: 第二 fabric 拒绝（单 fabric 约束）

- **WHEN** 已有 fabric A 租约/roster 时以 `--fabric=<fabricB>` 或异值生成路径 join
- **THEN** preflight fail-closed：明确错误、未发出 register、leases 不变

#### Scenario: 同服务器新码续期不重置注册时刻

- **WHEN** 持新码再 join A（registered_at=T0）
- **THEN** 同键 upsert：expires_at 刷新、registered_at 保持 T0、relay_url/receipt 更新

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
