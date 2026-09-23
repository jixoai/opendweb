# home-hub 实现期笔记（实现终验 r18 输入）

- 评审对象：本 worktree（分支 sdk-mgmt-surface）HEAD `333d73e`。
- 设计基线：`design.md` v17 + specs 四 delta（cli/hub、cli/leases、webui、packaging/tray-plugin、sdk/node 共五份）；r17 设计层 GO 9.0/10（docs/codex-review-hh-r17.md）。
- 相邻 change：`server-access-roles` 已独立终验 RELEASE-READY 9.2/10（docs/codex-review-sar-r13.md），**不在本轮范围**，仅需注意两 change 的共存回归面（webui 同时承载节点管理台 `/api/*` 与家庭数据面 `/sidecar/*`；server 二进制含两者服务端变更）。

## 1. 实现提交序列

| Phase | Commit | 内容 |
|---|---|---|
| 0a | 5acc6ce | dweb-fabric：deferStart 生命周期 + Roster 显式 fabric_id 采纳（[H8]） |
| 0b | df60ac6 / 2662713 | client-sdk NAPI deferStart/start()/fabricId + d.ts；darwin .node 重打包（win32 依 CI） |
| 1a-1e | b8c1d54 / 0950c78 | hub 命令族/状态模型/init 零残留/统一执行链/自启/短码卡片 + 验收层大测试 |
| 1d A/B | f3467b0 | 多租约簿+到访簿+跨进程锁+迁移+纯 JS blake3 码哈希 |
| 1d C/D | 94604e7 | join 改造：admission 锁+journal 恢复状态机+preflight 前置+短码接线 |
| 2a | 140c334 | webui core/壳重组（零行为变化）+ createConsole 进程内宿主契约 |
| 2b+2c | dadc6cb | 三视角控制台 + sidecar 数据面 + 接入卡片 |
| 3a | fcb5034 | opendweb-tray 无头插件：心跳+stdout 事件流 / --ipc JSON-RPC 双模式 |
| 3b | 84f2a11 | G-3 test-only 用例 + docs/acceptance-home-hub-g3.md |
| 走查修复 | 333d73e | D1/D2/D3 三缺陷修复 + 10 例新测试 + dist 重建 |

## 2. r17 实现期义务对照

| r17 义务 | 落点 | 证据 |
|---|---|---|
| journal 三类故障注入 | packages/opendweb/test/join-admission.test.mjs | e2e 故障1 响应丢失（L547）/ 故障2 register 成功后落账前崩溃 kill（L577）/ 故障3 陈锁接管（L618） |
| 同码回放对拍 | 同上 | L223 同码同 tuple 幂等回放→补账清 journal，POST 体 fabric/root/server 全用 journal 值 |
| deferStart 零出站 | crates/dweb-fabric/tests/deferred_lifecycle.rs | deferred 构造与 ensure 阶段零网络出站断言（L285 起） |
| 缓存票据优先级 | 同上 | ensured 票 > tuple 校验缓存票；四类旧票忽略；同 URL 冲突 ensured 胜；start 不覆盖 |
| 首触带票 | 同上 | start() 后 RelayMap 持租约匹配票=ensured 票（文件头注释即契约） |
| Custom restricted 路径 | deferred_lifecycle.rs + fabric_integration.rs 既有 Custom 面 | 主路径 CustomWithCaps 有端到端；restricted 兼容面靠既有集成测试维持 |
| G-3 300s | crates/dweb-fabric/tests/g3_hub_outage.rs | #[ignore=g3-300s] 设计性跳过 + 显式实跑记录 docs/acceptance-home-hub-g3.md（六字段；docker relay-only 对照 33.6s 死/21.0s 自愈） |

## 3. 实现期裁决清单（终验请逐条 adjudicate）

> 以下为实现期各代理的关键选择，标签为压缩记录；**落点与实义以当前源码为准**，请核验实际实现是否为合理选择（含是否有更优解被错过）。

### Phase 2a（webui 分层）×3

1. **workspace 依赖分类**：不新建 npm 子包；壳层消费走主包导出（packages/webui/src/index.mjs 导出 createConsole / CAPABILITY_QUERY_PARAM，手写 index.d.ts）。
2. **capability 单次消费语义**：core/capability.mjs——consume 成功即置 used 墓碑留至 TTL（120s）失效；同值再消费判 reason "replay"；128-bit v1。
3. **hub 槽位**：core/home.mjs resolveLaunch 五行分流；hub 判定=本机 hub.json 存在性；hub_local 仅 row-2（无参自动形态）置位。

### Phase 3a（tray）×5

4. **stopped→error 映射**：hub 已停时的探活失败映射为专用错误帧/文案，不落通用错误。
5. **heartbeat pid 核验降级**：pid 校验失败不致命，降级为「未核实」状态继续心跳。
6. **opened 帧序**：hub 侧 opened 事件先于首个 heartbeat 帧发出。
7. **envelope 未冻结注记**：JSON-RPC golden 帧只冻结语义字段；envelope 外额外字段不纳入冻结面（README 注记）。
8. **默认模式断管退出（双信号；r18 P1-2 改写）**：stdout 模式下「stdout 写错（EPIPE）**或**宿主关闭 stdin（EOF）」任一发生 → 幂等 stop() 退出（exit 0，心跳 mtime 冻结），不挂死；宿主干净关管无写错时 stdin EOF 是可靠即时的宿主消失信号，故默认模式宿主 MUST 保持 stdin 打开（`stdio: ignore` 形态立即触发退出，不再适用——初版「stdin EOF 不退出防秒退」裁决作废）。停机时释放 stdin 读柄（流动态 EOF 探测的 ref'd handle 不释放则 SIGTERM 路径无法退出）。

### Phase 1d（leases/join）×8

9. **legacy fixture 码无效替换**：迁移测试的 legacy fixture 不携带可兑换真码，用替换值测迁移面本身。
10. **英文 fail-closed 文案**：selectRelayFromManifest 的 disabled/null 拒绝文案为英文（CLI 错误面），与 webui 中文产品文案分层（join-admission L115「未启用中继」为 CLI 面断言）。
11. **roster wire 格式自源读取**：fabric_id/identity 直接读 roster 文件实际值（单一事实源），不做第二份手抄。
12. **journal 陈旧性未定义**：journal 不设时间戳过期（保留=安全侧）；陈旧 journal 由人工恢复路径承接，不做自动判死。
13. **10s 崩溃窗**：admission 陈锁阈值 >10s 可打破（与 hub.lock 陈锁规则同值；join-admission L577/L618 覆盖）。
14. **visits 写面**：到访簿仅成员侧（join/SDK 路径）写入；hub/服务端不写 visits。r18 P1-1 修复后补：sidecar `/sidecar/visits/probe` 对非 member 姿态（admin/默认/hub-local）一律 403（授权先于 Origin）；UI 对偶面——Lease/Visits 视图的「测一下」按钮仅成员视角渲染（不给必然 403 的按钮；源断言测试钉住）。r19 P1-NEW 契约冻结：**403 收敛只限 probe/visits（成员事实簿）**——`PATCH /sidecar/leases/{id}/label` 是本机租约簿的显示命名（本机用户自己的数据，无身份上下文），任意本机姿态可写（Origin 严格策略不变），与 spec webui 数据面既有契约一致；admin 姿态可写有显式测试。早前「admin 落这两页只读」为过宽表述，作废。
15. **迁移触发点**：租约簿 v0→v1 迁移在读路径首次打开时触发（含备份），不设显式迁移命令。
16. **id 零租约显示**：opendweb id 零租约时显示计数 0，不隐藏行（join-admission L481 有租约计数断言）。

### Phase 2b+2c ×6

17. **link 字段前向兼容**：server wire 现无 link 字段；webui 以前向兼容方式标注「直连中/借道中」，字段出现即升级显示。
18. **F1 3s/5s 节奏**：admin=在线面 5s+成员面 3s；member=仅成员面 3s；闭包内按当前 route 取值（333d73e 后由 mock-timer 回归测试钉死，/sidecar/state 稳态零重拉）。
19. **start 按钮收敛解释**：成员/访客视角涉及「启动」类动作的 UI 收敛为指引语义，不触发本机 hub 副作用（与 member 负向矩阵一致）。
20. **--server 优先级（D1 修复后语义）**：显式 --server 永远直连目标；本机数据面（/sidecar/hub|leases|visits）无条件跟随本机 DWEB_HOME（五行所有行同权）；hub_local 标记仅 row-2 自动形态——显式目标是声明行为，CLI 不擅自升格为「本机中枢视角」。
21. **镜像私有函数**：ui 层与 core 层存在少量同名私有 helper 镜像（不强行抽公共导出），换取壳层独立可测。
22. **无组件测试基建**：Svelte 组件无单测基建；测试落在 store 层（console-store.test.mjs，compileModule 直测 runes）+ runMain e2e + curl 面；视觉面由 vision 走查承接。

### Phase 3b 工程发现 ×2

23. **drop(Server) ≠ shutdown**：实测 Rust drop 不停止进程；G-3 用例改用显式 shutdown()。该发现对今后一切「停机语义」测试都是警示（acceptance 文档已载）。
24. **relay-only 恢复竞态观察**：断连自愈实测 21.0s，join 侧重新收敛约 26s——先后存在窗口；处置=记录不阻塞（六字段已载）。

## 4. 三角色走查（ego-browser + vision 代理）与缺陷修复

七幕功能全过（init 三件事/五行分流②/邀请码一次性弹窗/成员 join 全字段一致性/成员分流③租约+探测+label 持久化/名册 [H6] 双层联动/tray 心跳+停机语义文案）。发现三缺陷，已修（333d73e）：

- **D1[高]** hub open 接入卡片缺失：homeDir 恒注入（无 hub.json 仍 404 门控不变）；真实链路 curl /sidecar/hub 200（machine/short_code/qr_svg/running 全字段）。
- **D2[高]** 轮询风暴 ~800 req/s：根因=生命周期 effect 追踪 sidecar 引用+refreshSidecar 赋新对象→无限重入。三层修复（untrack 接线/投影等值复用引用/节奏回归测试）；修复后实测 1.1 req/s。
- **D3[中]** member 默认落点被竞态钉死：#bootHash 捕获先于规范化；记忆键只记 settle 后用户显式切换；member 干净首启落 #/lease 且记忆键空。

## 5. 绿门证据（2026-09-24 当日实跑）

| 门 | 结果 |
|---|---|
| packages/opendweb node --test | 240/240（walkthrough 前；333d73e 仅动 packages/webui） |
| packages/webui node --test | 194/194（333d73e 后独立复跑，含 10 例新增） |
| packages/tray node --test | 22/22 |
| packages/client-sdk node --test | 95/95（2662713 重打包后） |
| mbx test -p dweb-fabric | 262 pass + 1 预存环境性失败（与本 change 无关，已单独验证）+ 2 ignored（G-3 300s 与 20s 变体，设计性 ignore，均显式实跑绿） |
| clippy --all-targets -D warnings | 全绿（80ff612 解除两处预存 single_match_else） |
| rustfmt | 变更文件已过 |
| openspec validate home-hub --strict | valid（server-access-roles 亦 valid） |
| git diff --check | 干净 |

已知遗留（非阻塞声明，请裁决）：win32 .node 与 Windows exe 依 CI 交叉编译重建；G-3 300s 主用例默认 ignore（门禁时长考量，acceptance 文档记录实跑）。

## 6. 本轮终验输出要求

1. 阻塞问题清单（各附可验证修复建议）；
2. 实现质量评价：r17 义务闭合度、§3 裁决合理性、测试深度、工程纪律（安全红线：token 不出面/0600/argv 零 token 等是否全链路维持）；
3. 综合评分 0-10 + 依据，并与 r17（设计 9.0）、sar-r13（实现终验 9.2）口径对照；
4. 明确结论：RELEASE-READY 或 NOT-READY。

评审报告写入 docs/codex-review-hh-r18.md。
