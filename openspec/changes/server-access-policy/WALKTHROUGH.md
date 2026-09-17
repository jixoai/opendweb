# server-access-policy 走查手册

> 目标读者：Owner（你）。本文档配合 `scripts/sap-verify.sh` 完成最后的
> 实际走查。全部命令在 worktree 根目录执行：
> `/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-server-access-policy`

## 你要验收的故事

```
        你（admin）                         你的用户
  ┌────────────────────┐            ┌──────────────────────┐
  │ gaubee-cloud 云机   │            │ 本地（Owner/Visitor） │
  │                    │            │                      │
  │ dweb-server        │  公网       │ Owner A（root）      │
  │  restricted 模式    │◄──────────►│  自签 capability     │
  │  owner registry    │            │  签发 dweb2. 邀请     │
  │  relay :13340      │            │        │             │
  │  gateway :18787    │            │        ▼             │
  │                    │            │ Visitor B            │
  │ 无票者 ✗ 全拒      │            │  凭邀请经公网 relay   │
  └────────────────────┘            │  加入 → 双向通信      │
                                    └──────────────────────┘
```

核心验收点（一眼版）：

1. **别人白嫖不了你的服务器**：没有 Owner 签票的任何端点连 relay 都进不来（`dweb/no-capability`）
2. **抄走的地址/票据没用**：relay IP:port 抄走不能自己用；Visitor 的票转借给别的设备被拒（`dweb/not-recipient`）
3. **门槛动态可配**：`restricted`/`open` 一键切换；owner 注册表热重载（unregister 后新连接立即被拒）；callback webhook 模式可接你自己的业务系统实时准入
4. **P2P 故事完整**：邀请（v2 内嵌凭证）→ 跨公网加入 → 直连/中继通信 → 断线重启恢复

## 一键走查（推荐）

```bash
scripts/sap-verify.sh
```

脚本做五件事（幂等，可重复跑）：本地交叉编译 musl 静态二进制 → 预铸 Owner 身份 → 传到 gaubee-cloud 隔离目录 `/tmp/opendweb-sap-verify` 并以 `restricted` 模式部署（端口 18787/13340，**不触碰 1panel 与既有 opendweb-server 容器**）→ 公网可达性检查 → 跑 S1-S8 故事验证。

**预期输出**（每行一个验收点）：

```
[story] S1✓ 远程 restricted server 就绪（server_id=…，fabric=…）
[story] S2✓ Owner 自签 + 经公网 relay 上线
[story] S3✓ v2 邀请（dweb2. + 内嵌 bootstrap cap）
[story] S4✓ Visitor join + member capability 持久化（relay.caps.json）
[story] S5✓ 公网通信成功
[story] S6✓ 越权矩阵（无票 / 转借票 ×2 全拒）
[story] S7✓ v1-only 兼容（unsupported-invite-version）
[story] S8✓ 重启恢复 + 再次通信
全部通过 ✅
```

走查后清理（杀进程 + 删云端与本地临时文件）：

```bash
scripts/sap-verify.sh --teardown-only
```

## 手动分步（想亲眼看到每一步时）

```bash
# 1) 部署状态与 ServerId（gateway 明文，无凭据要求）
curl -s http://39.107.213.167:18787/services.json | python3 -m json.tool
#    → 看 "server_id"（capability 绑定的就是它）

# 2) owner registry 内容（云端）
ssh gaubee-cloud 'cat /tmp/opendweb-sap-verify/data/owners.jsonl'

# 3) 无票者直连 relay（应被拒；WS 握手层 deny）
#    用故事工具的 S6 已覆盖——手动看日志：
ssh gaubee-cloud 'tail -20 /tmp/opendweb-sap-verify/server.log'
#    → 可见 denied … dweb/no-capability / dweb/not-recipient 记录

# 4) 热重载：移除 owner 后新连接立即被拒（动态门槛）
ssh gaubee-cloud '/tmp/dweb-server-sap owners --data-dir /tmp/opendweb-sap-verify/data \
  unregister <fabric_id> <root_pubkey>'
#    再跑 scripts/sap-verify.sh 的第 5 步 → Owner 上线失败（deny）即为生效
#    （验完重新 register 恢复）

# 5) admin API：见下一节 curl 示例（DWEB_ADMIN_TOKEN 启动时设置才有 /admin/*）
```

## admin API（Phase 3 运维面，task 3.1/3.2/3.2b）

服务以 `DWEB_ADMIN_TOKEN=<secret>` 启动时，gateway 挂载 `/admin/*`
（Bearer 鉴权；**不设置该 env = 路由不存在**，404 零暴露）。全部
curl 以走查部署为例（`GW=http://39.107.213.167:18787`，
`AUTH='Authorization: Bearer sap-verify-admin'`——sap-verify.sh 部署的
演示 token，teardown 即回收）：

```bash
# 注册 owner（即时生效——无热重载窗口；回执 receipt_sig 可用
# services.json 的 server_id 独立验签审计）
curl -s -X POST "$GW/admin/owners" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"fabric_id_hex":"<64hex>","root_hex":"<64hex>"}'

# 列表（活跃集合 + generation）
curl -s "$GW/admin/owners" -H "$AUTH"

# 运行态：mode/policy/generation/配额/per-endpoint 在线表/
# per-owner 连接计数/callback 缓存条目
curl -s "$GW/admin/status" -H "$AUTH" | python3 -m json.tool

# 注销——即时全灭：新连接立刻 unknown-owner，**存量连接一并断开**
# （响应 kicked_endpoints/kicked_connections = 实际踢掉的端点/连接数；
#   对照：CLI/文件路径的 unregister 不踢存量，只拦新连接）
curl -s -X DELETE "$GW/admin/owners/<fabric_id_hex>/<root_hex>" -H "$AUTH"
```

### per-owner 连接配额（task 3.2）

`DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER=<n>`（默认无上限）限制单个
owner（fabric 维度）名下的**票接入** relay 连接数；超限新连接 deny
`dweb/owner-quota-exceeded`（经握手回传，SDK 可见）。无票 A_cb 接入
（callback 模式）与 rendezvous 请求不占名额；断连/被踢即时释放。
`/admin/status` 的 `per_owner_connections` 即实时计数投影。

### 撤销入口的语义分层（哪条路踢存量）

| 撤销入口 | 新连接 | 存量连接 |
|---|---|---|
| admin API `DELETE /admin/owners` | 即时拒 | **即时断开**（kicked 计数回执） |
| CLI / owners.jsonl 文件（mtime 热重载 ≤5s） | 拒（热重载窗口后） | 不断开，靠 TTL/自然断连收敛 |

## 边界场景对照表（哪些边界已被哪些测试钉死）

| 边界 | 钉死它的测试 |
|---|---|
| 无票接入 / 匿名扫描 relay+rendezvous | e2e e3/e11a/e13 + 故事 S6 |
| 票据转借（B 的票给 C 的身份用） | e2e e4 + 故事 S6（not-recipient ×2） |
| 抄走 relay URL 给自己的其它网络项目用 | e2e e1/e2 场景反证 + 故事 S6（对端无票不可达） |
| 伪造/篡改票据（验签） | 单测 L1 链 malformed/bad-signature 全矩阵 |
| 过期票 / 超长 TTL / 未来时间 / 时间自相矛盾 | 单测 C6 边界（含等值即拒）+ e2e e6 |
| 跨 Server 重放票据 | 单测 wrong-server + e2e |
| 未注册 owner 的票 | e2e e5 + 故事（registry 二元组） |
| unregister 后存量票 | e2e e8（热重载收敛 unknown-owner）+ 缓存 generation 失效 |
| 老 SDK（v1）接 v2 邀请 / 老 SDK 连 restricted | 故事 S7 + SDK 测试 unsupported-invite-version |
| rendezvous 匿名枚举（restricted） | e2e e13（401）+ announce 签名身份绑定 |
| callback webhook 失联/超时/恶意响应 | 单测 17 例（fail-closed/缓存/singleflight/SSRF/reason 注入） |
| callback 并发风暴 / DNS rebinding / 私网地址 | 单测（singleflight 10 并发 1 请求、SSRF 地址矩阵、解析-连接原子） |
| 恶意 Owner 刷资源 | registry 移除即全灭 + client_rx 限流（e2e e12） |
| QAD 地址发现旁路 | restricted+QUIC bind 组合启动即拒（e2e e10） |
| 进程重启（ServerId 稳定 / 成员凭证重载） | e2e e7 + 故事 S8 |
| 撤销后的窗口期 | 设计明示：TTL 是撤销传播上界（relay.caps.json member cap ≤90d） |
| admin API 未授权（错/缺 token）与未挂载面 | e2e e14（401 / 未配 DWEB_ADMIN_TOKEN = 404） |
| owner 配额满（per-owner 连接上限） | e2e e15（owner-quota-exceeded 经握手回传） |
| admin 注销踢存量（kicked 计数 + 在线表清零） | e2e e16（对照：文件路径不踢，e8） |

完整矩阵：`crates/dweb-server/tests/server_access_e2e.rs`（17 例）、
`story_e2e.rs`（S1-S8）、`access/*.rs` 单测 140、fabric 侧 165 + OK2 6 例、
SDK `relay-relays.test.mjs`。全量绿门：

```bash
mbx test -j 2 -p dweb-server -p dweb-fabric -- --test-threads 2
```

## 两种门槛模式怎么选（部署速查）

| | `policy=static`（默认） | `policy=callback` |
|---|---|---|
| 适合 | 个人/小团队自托管 | 接入自家业务系统动态准入 |
| 授权变更方式 | `owners register/unregister` CLI（文件热重载 ≤5s） | 你的 webhook 实时返回 allow/deny |
| 无票端点 | 全拒（fail-closed） | 可经 webhook 放行（A_cb 名单，你全责） |
| 配置 | `DWEB_ACCESS_MODE=restricted` | 另需 `DWEB_ACCESS_POLICY=callback` + `DWEB_CALLBACK_URL/TOKEN` |

callback 请求/响应协议与全部安全约束（超时 2s fail-closed、缓存 60s、
并发上限、SSRF 防护、reason 白名单）：design.md §8.5。

## 故障排查

- gateway/relay 公网不可达 → 检查云安全组放行 18787/13340
- S2 上线失败 → owners.jsonl 的 fabric_id/root 与 prepare 输出一致？server.log 尾部有 deny reason
- 想完全重来 → `scripts/sap-verify.sh --teardown-only && scripts/sap-verify.sh`
- 云端日志 → `ssh gaubee-cloud 'tail -50 /tmp/opendweb-sap-verify/server.log'`

## 相关文档

- 设计全貌与安全边界：`openspec/changes/server-access-policy/design.md`
- 需求与裁决记录：同目录 `requirements.md`（共享接入语义 = 你 2026-09-17 的裁决）
- 六轮评审记录：`docs/codex-review-sap-r1..r5.md` + `codex-review-sap-impl-r1.md`
