# server-access-policy Phase 1 实现复核报告 — R1（zcode 子代理代行，Codex 会话故障）

- 复核对象：`server-access-policy` 分支 Phase 1 实现提交（相对 main@ae271cf）：
  `316a839`（identity/registry/cap/config）、`a8e15b8`（gate/callback/relay/limits/services）、
  `b79b57e`（rendezvous ACL + e2e）、`e0e042e`（TS [server.access] 贯通），含 `410797e`（裁定回写）。
- 权威依据：`openspec/changes/server-access-policy/design.md` §8.2/§8.4/§8.5/§11.1/§11.2、
  `specs/server/spec.md`；上游 `iroh-relay 1.1.0`（vendored 源码逐点对照）。
- 复核方式：全部新增 Rust/TS 源码逐行阅读（不信任注释/提交说明）、上游 iroh-relay
  关键路径（`server.rs`/`http_server.rs`/`handshake.rs`）源码求证、全套测试实跑。

## 测试实证（2026-09-17 本机实跑）

| 套件 | 命令 | 结果 |
|---|---|---|
| dweb-server 单测+集成 | `mbx test -j 2 -p dweb-server -- --test-threads 2` | **127 passed / 0 failed** |
| e2e（真 relay + 真 iroh 客户端） | 同上（`server_access_e2e` 二进制含于其中） | **14 passed / 0 failed**（7.41s） |
| packages/opendweb（TS） | `npm run test` | **100 pass / 0 fail** |
| packages/server-binary（TS） | `npm test` | **10 pass / 0 fail** |

跑前 `pgrep` 确认无孤儿 cargo/rustc/dweb-server；跑后复查同样干净（e2e 的 Server guard
Drop 恒 kill+wait，实证无泄漏）。机器 swap 深水位（20.6/21.5GB），全程 `-j 2`/`--test-threads 2` 受控。

---

## 阻塞问题（P0）

### P0-1 specs/server/spec.md 与实现矛盾：缓存键与「负载侧拒绝不入缓存」的裁定回写漏改 spec 文件

- **现象**：实现期裁定（commit `410797e`，"docs(spec): 实现期裁定回写——缓存键 113B 投影直键/负载侧拒绝不入缓存/caps 名连字符"）只改了 `design.md`，**没有改 `specs/server/spec.md`**。spec.md L119 仍冻结为：
  - 「缓存：键 = (registry_generation, endpoint_id, **BLAKE3(capability canonical 投影)**, event)」——实现（`callback.rs` `CacheKey`，L111-116）用 113B 定长投影**原文直键**（单射无碰撞，无 BLAKE3 摘要）。
  - 「非 200 / 3xx / 超时 / 解析失败 / 缺 allow / body 超限 / **并发超限** → 拒绝并返回 dweb/policy-unavailable（**deny 结果同样入缓存**）」——实现把负载侧拒绝（队列满/per-source 超限，`Decision::transient_unavailable`，callback.rs L88-95）排除在缓存之外，仅 webhook 交互侧失败入缓存（design §8.5「缓存范围细化」）。
- **证据**：`git show 410797e --stat` 仅含 `design.md`（1 file changed）；对照
  `crates/dweb-server/src/access/callback.rs:109-116`（CacheKey 无摘要）、`:88-107`（transient vs webhook_unavailable 的 cacheable 差异）与
  `openspec/changes/server-access-policy/specs/server/spec.md:119`。
- **影响**：spec delta 是归档进 `openspec/specs` 的规范源。按现文本归档后，规范冻结的缓存键形态/负载侧行为与实现不一致；任何按 spec 实现的二次实现（SDK 侧诊断工具、替代 Server）会与本项目行为分叉。语义本身设计文档已论证「等同或更优」（113B 投影是单射，抗碰撞性严格强于摘要；负载侧不缓存防过载期毒化），**运行时无错误**——这是文档一致性 P0，不是代码缺陷。
- **可验证修复**：一个 docs-only 提交，把 spec.md L119 两处改为与 design §8.5（410797e 后文本）一致：键描述改为「113B 定长投影直接作键（单射，语义等同 BLAKE3 摘要）」；缓存范围拆分为「webhook 交互侧失败 deny 入缓存；负载侧（并发/队列）瞬时拒绝不入缓存」。改后 `grep -n "BLAKE3(capability" specs/server/spec.md` 应零命中。

---

## 建议改进（P1/P2）

### P1-1 relay.disconnect 的 webhook 调用无超时——违反 design §8.5「其 callback 亦受同一并发/超时上限约束」，慢/挂起 webhook 可耗尽全局并发槽拖垮准入面

- **现象**：`notify_disconnect`（`crates/dweb-server/src/access/callback.rs:333-351`）只做全局并发 `try_acquire_owned`，随后 spawn 的任务里 `webhook_call(...)` **没有套任何超时**。`webhook_call` 内部（L454-571）的 DNS 解析、`connect_first`（OS 级 connect 超时，macOS ~75s）、TLS 握手、`resp_body.frame().await` 读体循环均无应用层上界。对照 leader 路径（L385）有 `tokio::time::timeout(self.0.timeout, ...)` 包裹。
- **影响**：webhook 端「接受 TCP 后静默不响应」或被防火墙丢包时，每个 disconnect 通知可无限期持有 1 个全局 permit（64 上限）。攻击/故障形态下 relay admissions 的 L2 决策全部 fail-closed（policy-unavailable）——方向是 fail-closed（无越权），但把 callback 模式的准入面 DoS 了数分钟到小时级。spec/design 明文要求 disconnect 回调「受同一并发/超时上限约束」。
- **可验证修复**：`notify_disconnect` 的 spawn 内改为
  `let _ = tokio::time::timeout(self.0.timeout, this.webhook_call(&body)).await;`
  （permit 已随任务 Drop 释放）。补一个单测：mock webhook `Mock::Delayed(10s, ...)` 下 `notify_disconnect` 后断言全局 permit 在 ~timeout+slack 内恢复（或直接断言后续 `decide` 不被 disconnect 占坑）。

### P1-2 [server.access] TOML 键名形态与 design §11.2 矛盾（camelCase 实装 vs snake_case 设计稿；strict zod 拒绝）

- **现象**：design §11.2 示例写 `owners_file = "…"`、`callback_url`、`callback_timeout_ms` 等 snake_case；实装 TS schema（`packages/opendweb/src/config-file.mjs:19-30`）为 camelCase（`ownersFile`/`callbackUrl`/`callbackTimeoutMs`/`callbackCacheTtlMs`/`allowLoopbackCallback`）且 `.strict()`——按 design 文档逐字写 TOML 会在装载期被拒（fail-fast，报错清晰，安全方向正确）。测试锚定 camelCase（config-file.test.mjs:28 等）。
- **裁定**：**符合工程意图、不符合 design 文本**。理由：(a) spec.md delta（规范源）只冻结「config.toml `[server.access]` 配置 + 优先级」，未冻结键名；(b) 仓库既有 config-file 约定（plugin-marketplace 落地的 `ServerConfigSchema`：`gatewayBind`/`relayBind`/`trustProxy`…）就是 camelCase，design §11.2 开头也写「沿既有 … config.toml」；(c) strict 拒绝给出明确错误、零静默漂移。但照抄 design 的用户会启动失败，文档与实装必须收敛一处。
- **附带**：design §11.2 还列了 `callback_max_concurrency`/`callback_per_source`/`callback_queue`/`limits.client_rx` 为 config 键——实装这些仅 env（`DWEB_CALLBACK_*`/`DWEB_RELAY_CLIENT_RX`），TS schema 未暴露；`dataDir` 刻意不入段（代码注释有据）。同属 §11.2 草稿与实装的漂移族。
- **可验证修复**：docs-only：把 design §11.2 的键名改为 camelCase 并标注「callback 并发三参数与 client_rx 为 env-only（Phase 1）」；或在 schema 中显式 alias 接受 snake_case（二选一，推荐改文档，保持 strict 单形态）。

### P2（清单）

1. **identity 跨进程并发创建**（前任风险点②的实证结论）：两进程同 data_dir 冷启动 → 双双 NotFound、双双生成不同 key、`create_new` 唯一 tmp 名互不覆盖、rename 后写者胜——无文件损坏、无越权，但两进程 ServerId 分裂（对方的票在本进程 `dweb/wrong-server` 拒）。`identity.rs:9-10` 头注释已声明「单进程语义由 admin 保证」。可选加固：data_dir 下 flock 锁文件（O_EXCL + pid），冲突时 fail-fast。现有 `write_atomic_0600`（L73-93）本身正确：0600 先于写入、内容 fsync、rename、目录 fsync；损坏文件报错不覆盖（L43-48）。
2. **既有 server.key 权限漂移不告警**：load 路径（`identity.rs:40-51`）不校验/修复既有文件 mode——被外部放宽到 0644 的 seed 静默继续用。建议 load 时 stat mode≠0600 记 WARNING（unix）。
3. **决策缓存无容量上界**：`Inner.cache`（callback.rs L129-130）仅惰性过期+reload 清空，无 LRU/条目上限；(generation, endpoint_id, projection) 键空间可被握手身份无限拉大（每条 ~200B、默认 TTL 30s）。可加「条目数 > N 时清最旧/整表」的粗门。
4. **singleflight 在途表的理论性泄漏**：leader spawn 任务 panic 时 `finish` 不执行，`inflight` 条目永驻 → 同键后续 decide 恒为 joiner、恒 transient 拒绝（直到 generation 变更换键）。现实 panic 源仅剩 Mutex 中毒（unwrap 链）。可改为 leader 任务内 `catch_unwind`/或 joiner 在 `Err(_)`（sender 全消亡）时顺手摘除条目自愈。
5. **CacheKey 未含 event 字段**（spec 键式含 event）：当前只有 relay.connect 入缓存，语义等价；将来若 disconnect/新事件入缓存需先补字段，建议在结构体加注释锚点。
6. **registry 热重载指纹为 (mtime, len)**（gate.rs `stat_of`）：同 mtime 同长度的改写在粗粒度 mtime 文件系统上可能漏检；配合 5s 轮询实践风险可忽略，注释标注即可。
7. **e2e e12（client_rx）断言偏弱**：仅断言「准入不受影响 + 日志行存在」，未验证节流真实发生（节流语义属上游，单测无涉）。可在后续阶段用吞吐测量补强，非本门必须。
8. **`?token=` 百分号解码不对称**：relay 面经 `query_pairs()`（percent-decoded），rendezvous 面取 raw query（`credential_sources`，rendezvous.rs:203-208）。token 字符集天然 URL-safe，合法值两侧等价、异常值两侧均 fail-closed（代码注释已声明）；仅极端编码形态行为面不同，无安全影响。
9. **rendezvous announce 的 path/body 一致性检查（400）先于 ACL（401）**：向未认证方区分了 400/401 两种失败（内容均为攻击者自选），信息量可忽略；如要绝对一致可把 IdMismatch 挪到 ACL 后。

---

## 实现质量评价（分维度）

### 密码学 — 9/10

- `cap.rs` canonical 布局与 design §11.1 逐字节一致（version u8 + 4×32B + caps u8 + 2×u64BE = 146B；签名输入 = 18B 域前缀 `dweb/relay-cap/v1\0` + canonical；wire 210B；串 287 字符——`token_shape_frozen` 冻结，e2e 侧独立重实现交叉验证）。
- `verify_l1` C3→C7 顺序与 design §8.2 完全一致；边界语义正确：`now >= expires_at` 等值即拒、skew 恰 +120_000ms 放行、TTL 恰 180d 放行/超 1ms 拒（单测边界全覆盖）；`expires_at - issued_at` 减法有前置条款防下溢（L260-264）；issuer 非法曲线点归 `bad-signature`（L243）。
- `decode` 防解析 DoS 序正确（长度门 1KiB → 前缀 → 280 定长 + base64url 白名单 → 定长缓冲解码 → checked `split_at`），全部 `expect` 由常量算术保证不可被外部输入触达。
- 113B 缓存投影布局与无票 sentinel 冻结测试齐全；`z32` 本地实现与 `iroh_base::PublicKey::to_z32` 逐字节一致性有测试（且规避了任意 32B 非曲线点被 PublicKey 构造拒绝的坑）。
- 扣分点：无实质缺陷；仅域前缀/字节布局缺一段独立的 negative-vector 外部语料（当前靠测试内互证，已足够工程置信）。

### 并发 — 7.5/10

- singleflight 设计正确：joiner 经 `watch` 订阅，先 `borrow_and_update` 再 `changed()`，leader 发布前订阅的竞态窗口闭合；leader spawn 独立任务，调用方超时取消不丢发布（joiner 不悬挂）；`LEADER_AWAIT_SLACK` 补调度抖动。
- permit 持有期真实：queue（try）→ global（await，受 timeout 包裹）→ per-source（try+Drop 递减）全程持有至 HTTP 结束；queue=1/max=1/per-source=1 的拒绝矩阵均有并发单测实证。
- 缓存键/generation/TTL 语义与冻结裁定一致（省略=默认、非法=0、>60=0、min(响应, 配置)、deny 入缓存、负载侧不入）；registry 变更 generation+1 + `invalidate_all` 双保险。
- SSRF 原子语义达标：每次调用 `lookup_host` 解析全部 A/AAAA → `to_ipv4_mapped` 归一 → **逐个校验任一非法整体拒绝** → 用已校验固定地址直连（不二次解析、不经系统代理、3xx 不跟随）；网段矩阵（RFC1918/ULA/link-local/169.254.169.254/CGNAT/组播/unspecified/IPv4-mapped）单测覆盖；https 强制 + loopback 豁免仅限 loopback + ring provider 显式装配。
- 扣分点：P1-1（disconnect 无超时）；P2-3/P2-4（缓存无界、panic 泄漏路径）。

### 测试有效性 — 8.5/10

- e2e 是**真黑盒**：`CARGO_BIN_EXE_dweb-server` 起真进程、真 iroh relay、真 iroh 客户端（raw `ClientBuilder` + 全量 `Endpoint` 两形态）；deny reason 从**握手协议线层**断言（`ServerDeniedAuth { reason }` 字符串全等），无假绿面。
- capability 在 e2e 侧**独立重实现**（不走 cap.rs），对服务端解析器构成交叉验证——这是高质量的设计。
- 覆盖面：open 回归（真 echo 回程）、有效票回程、无票/转借/未注册/过期四 deny、重启持久化（ServerId 稳定+registry 恢复+同票复用）、unregister 热重载收敛（≤20s 轮询翻转，非固定 sleep 断言）、callback 三态+webhook 计数+payload 形状（`capability: null`/Bearer/z32）、QAD fail-fast（退出码 2 + QAD 关键词）、空 registry 双语义、rendezvous 401 JSON 字节级断言 + recipient 绑定正反例 + bearer-only resolve。
- 无超时兜底掩盖失败的迹象：所有 wait 均带 deadline 且超时即 panic 带日志 dump；进程 guard Drop 恒 kill+wait。
- 扣分点：e12 偏弱（P2-7）；SSRF/重定向/singleflight 只有单测级覆盖（可接受）；deny 矩阵的 wrong-server/caps-unsupported/caps-missing-relay/malformed 未进 e2e（单测+relay.rs 适配层测试覆盖，代表性子集进 e2e 可接受）。

### 工程卫生 — 8.5/10

- **不可信输入零 panic**：非测试代码的 unwrap/expect 全数核查——仅剩 `std::sync::Mutex::lock().unwrap()`（中毒才 panic，且中毒需要先有一次别的 panic）、`serde_json` String 序列化 expect（不可失败）、TLS builder expect（构造期/admin 输入）、`decode` 的 `split_at 定长` expect（常量算术保证）。未发现外部输入可达的 panic 路径。
- **C0 接线确证不复用 `auth_token()`**：上游 `iroh-relay 1.1.0/src/server.rs` 的 `auth_token()` 文档与实现证实「非 UTF-8 header 立即返回 None」——正是 R4 P1-6 的降级陷阱；`relay.rs gate_input` 直读 header 原始字节 + lossy 转换（U+FFFD 必落 malformed），非 UTF-8 obs-text header 有专线测试。`?token=` 参数名与上游 `AUTH_TOKEN_URL_QUERY_PARAM = "token"` 一致。
- **上游装配边界核实**：`Server::spawn` → `accept` → `authorize_with`（http_server.rs:868-898）→ `Clients::register`；deny reason 经 `handshake::ServerDeniedAuth { reason }` 回传（e2e 线层实证）；`Limits::accept_conn_*` 上游确为 TODO（server.rs:486），实现只接 `client_rx`——与 design §11.2 的诚实化承诺一致。
- **日志脱敏**：`ServerIdentity`/`CallbackProvider` 的 Debug 恒脱敏；callback 失败日志只带 host；113B 投影不进日志；113B/`hash_input` 无 token 原文路径。
- **main fail-fast 顺序正确**：公网 URL 校验 → 访问配置（mode/policy/QAD）→ identity → registry → gate 构造（callback URL 边界）→ bind 解析 → spawn；全部退出码 2 先于任何监听。
- **services.json 只增**：`server_id` 追加尾部、既有字段序不动、fixture 兼容测试 + 专项断言。
- **TS 三层链**（config-file zod strict → opendweb CLI flag>env>config → startServer 显式定义才写 env + `--allow-loopback-callback` spawn 参数）与 Rust 侧 env 契约逐键对齐，100+10 测试通过。
- 扣分点：P1-2 的文档漂移归入本维度（实装内部自洽，文档侧未收敛）。

---

## 综合评分：8/10

评分依据：
- 密码学（9）：字节布局/域分隔/验证顺序/边界/防 DoS 序全对，双实现交叉验证，无安全错误。
- 并发（7.5）：主体（singleflight/permit/generation/SSRF 原子性）扎实且有并发实证；disconnect 无超时（P1-1）是 design 冻结项的实装缺口，方向 fail-closed。
- 测试有效性（8.5）：线层 deny 断言 + 黑盒交叉验证 + 热重载/重启/三态 callback，工业质量；个别断言弱（e12）。
- 工程卫生（8.5）：不可信输入零 panic、脱敏、fail-fast 顺序、上游边界诚实。
- 拉低项：P0-1（spec 文件与实现矛盾的归档阻塞项）+ P1-1/P1-2。三者均为小修复（1 个 docs-only 提交 + 1 处 timeout 包裹 + 1 处文档收敛），不动架构。

对照 R5 设计终验 8.4/10：实现质量与设计质量基本相称，未发现设计降级实现；唯裁定回写漏改 spec 与 disconnect 超时缺口两处落差。

## 结论：NEEDS-WORK（附条件，预计一个短提交收敛）

条件（全部满足即可转 RELEASE-READY）：
1. 【P0-1】specs/server/spec.md L119 与 design §8.5/实现同步（缓存键直键 + 负载侧不入缓存的拆分表述）——docs-only。
2. 【P1-1】`notify_disconnect` 的 webhook 调用套 `self.0.timeout` 超时 + 补一个慢 webhook 下的 permit 回收单测。
3. 【P1-2】design §11.2 键名改 camelCase 并标注 env-only 项（或反向为 schema 加 snake alias，二选一）——docs-only。
4. 复跑 `mbx test -j 2 -p dweb-server -- --test-threads 2` 全绿（127+14）+ TS 两包全绿。

P2 项不阻塞，建议随手或 Phase 2 处理。

---
*复核人：ZCode 子代理（GLM-5.3）代行 Codex 复核职责；Codex 会话故障，本轮为独立实现复核 R1。*
*证据基线：本报告全部行号引用基于 server-access-policy 分支当前 HEAD（e0e042e）；测试数字为 2026-09-17 当日实跑。*
