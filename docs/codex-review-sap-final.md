# server-access-policy 最终验收 Review

## 六维验收

### 1. 故事完整性：PASS

- `crates/dweb-server/tests/story_e2e.rs:367-582` 以真实 `dweb-server` 二进制覆盖 S1-S8：restricted 部署、root 自签、`dweb2.` 邀请与内嵌 bootstrap capability、Visitor join/OK2/member capability 持久化、通信、无票与转借票拒绝、v1 兼容错误、重启后再次通信。
- `crates/dweb-server/examples/cloud_story.rs:224-356` 将 S1（外部云端部署）与 S2-S8 公网验证接通；`openspec/changes/server-access-policy/WALKTHROUGH.md:38-50` 与 `scripts/sap-verify.sh:39-74` 的部署、验证、预期输出相互对应。
- 云端公网验证记录由 Owner 补充：全量测试唯一失败为预存环境 `relay_offline_probe_dns_failure`，pristine 基线同样失败；不归因于本 change。云端实例只读抽查未再执行，故不把该项包装成独立现场重跑证据。

### 2. 边界覆盖：PASS

- `WALKTHROUGH.md:86-101` 的 16 行均能定位到测试或设计约束：e1-e13、S1-S8、`access/callback.rs`/`gate.rs` 单测、fabric OK2/wire 测试，以及 design §13 撤销窗口。
- 关键抽查：无票/转借票 `server_access_e2e.rs:524-547,487-495`；unregister 热重载 `:628-666`；callback 无效票不回调、singleflight 10 并发 1 请求、队列/来源上限 `callback.rs:1232-1309`；SSRF/DNS rebinding/IPv4-mapped 地址矩阵 `:1312-1358`；disconnect 超时回归 `:1420-1443`；rendezvous 401 `server_access_e2e.rs:913-978`。
- 票据撤销传播窗口在 design §13 明示为 TTL 上界，未被误写成存量连接即时断开保证。

### 3. R1 收口真实性：PASS

- `40114b4` 已把 impl-r1 的 P0/P1+5P2 落到实现：disconnect webhook 调用包 `tokio::time::timeout`（`crates/dweb-server/src/access/callback.rs:347-373`），缓存容量门 `CACHE_MAX_ENTRIES=10_000`（`:75,447-456`），singleflight leader 异常自愈（`:306-327`），并有对应 timeout 回归测试（`:1420-1443`）。
- 该提交的 diff 与 `docs/codex-review-sap-impl-r1.md` 的处置项一致；无将“测试绿”冒充编译/运行证据的结论。

### 4. Phase2 wire 正确性：PASS

- InviteV2 实现 `crates/dweb-fabric/src/protocol.rs:1131-1370` 对齐 design 附录 A：域/版本、固定字段、relay/URL/cap 长度、recipient/TTL 一致性、4/6 family SocketAddr、严格尾长校验；签名与版本分派在 `:1387-1461`。
- 逐字节冻结测试 `protocol.rs:2223-2285` 覆盖偏移、BE 长度、relay capability 与二进制地址；一致性、计数、长度和 v1/v2 隔离负例在 `:2288-2408`。
- REDEEM_OK2 编解码 `crates/dweb-fabric/src/session.rs:808-936,1039-1066` 对齐附录 A2 的 u32/u16 BE、8 条/512B 上限、整帧违规、重复首条、非法 cap 跳过计数；`tests/redeem_ok2_wire.rs:303-381` 与 `:440-507` 覆盖攻击性负例、真实 join、持久化和 reload。跨 crate 冻结锚点为 `crates/dweb-fabric/src/lib.rs:29` 的 `CROSS_CRATE_CAP_VECTOR`。

### 5. 走查包可用性：PASS

- `scripts/sap-verify.sh:1-77` 可执行，包含 prepare、musl 产物检查、云端隔离目录部署、公网 healthz、S1-S8 verify 与 teardown；变量与 `cloud_story` 环境约定对应 `WALKTHROUGH.md:38-60`、`cloud_story.rs:14-18,224-356`。
- 预期输出 S1-S8 与工具实际 `story()` 输出一致；故障排查路径在 `WALKTHROUGH.md:120-132` 覆盖 server_id、registry、日志、端口和产物检查。
- 走查脚本仍使用 `cargo`/`grep`（而不是仓库日常门禁约定的 `mbx`/`rg`），但不影响其在具备依赖的 Owner 环境中执行，也未形成 P0/P1 功能缺口。

### 6. 绿门：PASS（附已知环境例外）

- OpenSpec 严格校验现场通过：`openspec validate server-access-policy --strict --no-interactive` → `Change 'server-access-policy' is valid`。
- Owner 补充的受控全量测试：fabric 侧 224 例其余全部通过；唯一失败为已知预存 `relay_offline_probe_dns_failure`，pristine 基线同样失败，与本 change 无关。dweb-server 侧沿用 `40114b4` 收口记录的 128 单测 + 14 e2e 全绿证据；本轮未因 hook 超时重复启动第二次重型门禁。
- SDK 侧 `packages/client-sdk/test/relay-relays.test.mjs`、`new-api.test.mjs` 与类型 fixture 覆盖 relay 条目、serverId、token 冲突、deny reason 和 v1/v2 分派；`40114b4`/`51bfe26` 记录的 clippy `-D warnings` 与 fmt 门禁为绿。

## 新发现问题

无新的 P0/P1。

已知残余仅为：

- `relay_offline_probe_dns_failure` 是 pristine 基线同样存在的环境依赖失败，不是本 change 回归；Owner 走查时应将其单独标注为环境例外。
- Phase 3（admin token API、per-owner 配额、member capability 续期、多平台/Docker 矩阵）在 `tasks.md:119-128` 明确另行排期，不属于本轮 Phase 1/2 完成条件。

## 综合评分 9.5/10

相对设计轨迹 5.5 → 5.9 → 6.1 → 7.0 → 8.4，本轮实现首轮 8.0/10 NEEDS-WORK 的阻塞项已在 `40114b4` 收口；Phase2 wire、真实故事链、边界矩阵和 Owner 走查包均形成可追溯证据。扣分仅来自公网真实验证依赖外部环境、已知 DNS 探针例外，以及走查脚本未完全采用仓库门禁命令前缀。

## 最终判定：ACCEPTED（Owner 可走查）

Owner 可按 `scripts/sap-verify.sh` 执行最终公网走查；将 `relay_offline_probe_dns_failure` 作为已知环境例外记录，不应阻断本 change 验收。
