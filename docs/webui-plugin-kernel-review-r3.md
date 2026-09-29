# webui-plugin-kernel 设计评审 r3

> 评审对象：提交 829f5e478652541049be5bfb5e989a3cf22cfeb3 的 design v2 与四份 spec delta。逐项对照 r2 B1-B7、W7/W11 和 v2 新增协议。只读文档及既有源码；未运行重型门禁。

## B1-B7 验收

| 项 | 判定 | 依据 |
|---|---|---|
| B1 两阶段取消 | **PASS** | design §4:124-130 区分响应头前 request.signal 与响应体期 HttpClientResponse.abort()；ports Scenario :9-12 分别验头前和 SSE/长响应体取消，并断言 provider signal、上游 socket 收敛。与 client-sdk 实际取消句柄一致。 |
| B2 fd 链与逃逸门 | **PARTIAL / 不通过** | design §6:161-169 有 root fd、逐组件拒 symlink、并发替换门和平台降级边界；files Scenario :14-17 也覆盖竞态。但同一 delta 的规范性 Requirement :7 仍强制旧 lstat→open→fstat 描述，没有改成 fd-relative 逐组件规则，与 design 正文冲突。实现者可以只满足较弱 Requirement。 |
| B3 intent + roll-forward | **PARTIAL / 不通过** | design §7.3.1:218-234 与 sync Scenario :49-57 已规定 intent、永不 rollback、四个崩溃注入边界。可是“推进后”崩溃重启时，恢复重放仍按旧 ref 快照做 CAS；当前 ref 已是 targetCommit 时该 CAS 会失败，不能完成承诺的幂等 roll-forward。另缺少扫描后、物化前或恢复期间用户再次编辑同一路径的保护规则，见 N2。 |
| B4 W8 收窄 | **PASS** | design §0:21、§7.2:191-197 和 sync Requirement :7 一致限定为 N 成员账本/ref 命名、v1 双机执行、多端加入/收敛后续 change；不再承诺 N 端行为。 |
| B5 页面路由 | **PASS** | design §2.1:69-79 与 webui Requirement :7、Scenario :14-17 定义 #/p/ 前缀、静态 registry、enabled 检查、未知/disabled 回归到既有 hash 收敛、工具区和旧路由不变。场景覆盖深链刷新、停用、未知插件路由及 #/overview。 |
| B6 面板安装边界 | **PASS** | design §2.1:62-68 与 webui Requirement/Scenario :7,19-22 明确面板只管理编译内置三插件，CLI 命令插件不冒充 WebUI 插件；与既有 CLI apiVersion 1 分离。 |
| B7 新增协议 Scenario | **PARTIAL** | sync delta :29-52 已覆盖闭包缺失、显式中止、type/mode、超限对象和四边界崩溃；files delta :19-22 冻结幂等续传。仍有两个 Scenario 分支与自身目标不一致：mode 冲突分支给出的“保留目录/保留文件内容”不描述 mode 选择（sync :39-42）；超限 blob 分支要求同一同步继续让其他小对象生效，但完整 Git commit/tree 闭包含该 blob 时不能推进该 commit ref（sync :44-47）。 |

## 新问题与残余阻塞

### N1. v2 规则没有同步进规范性 delta

files Requirement 仍采用 lstat/open/fstat（specs/plugins/files/spec.md:7），即使后面的 Scenario 与 design §6 已采用 fd 链。ports Requirement 仍只写“默认 8MiB 可配”（specs/plugins/ports/spec.md:7），没有 design §4:117-122 的 1-64MiB 硬范围、未知 Content-Length 边读边拒和并发累计预算。ports Scenario :14-17 只覆盖泛化的“超过上限”，未区分未知长度，也未覆盖配置超过 64MiB 或并发预算耗尽。

**修复建议：**把 files Requirement 主句改为 fd-relative 逐组件打开，删除 lstat+open 作为合格实现；把 ports Requirement 写入 1-64MiB 配置范围和超范围拒绝、未知长度累计门、并发总预算。增加未知长度超限与并发预算拒绝 Scenario。设计与 delta 必须给出同一 MUST。

### N2. 崩溃后重放 ref CAS 不具备幂等性，且可能覆盖恢复期间的新编辑

design §7.3.1 第 3 步只规定“ref CAS 到 targetCommit”，恢复规则要求对未 done intent 重放“物化+推进”（:226-230）。四边界 Scenario 明确包含 ref 已推进、done 尚未写入时崩溃（sync :49-52）。重启后 currentRef 已是 targetCommit；若照 intent 中 old ref 快照再次 CAS(old,target)，必然是 CAS 失败，而不是成功完成 done 标记。

同节 :231-232 只保证扫描阶段先把已发现的本地修改 commit；它没有覆盖扫描结束后、物化前或进程崩溃至重启期间用户再次修改目标路径。roll-forward 会按 target OID rename 覆盖这些新内容，违反“用户未提交改动一致”的验收承诺。

**修复建议：**定义恢复 ref 判定：currentRef==targetCommit 时把推进视为已完成；currentRef==oldRef 时执行 CAS；其他值按冲突停止并保留现场。对每个受影响路径记录预期 preimage OID/不存在状态，在物化和恢复前复核；发现扫描后新增内容时保留并转成冲突或先另存，不得静默覆盖。四边界测试加一条“目标路径在扫描后、恢复前被修改”的用例。

### N3. 超限对象 Scenario 与完整闭包规则不相容

sync Requirement 要求 push 携带 commit parent、树和 blob 完整闭包，缺对象时整次 push 拒绝且 ref 不变（sync :7、design §7.3:214-216）。但超限 Scenario 同时要求 >16MiB blob 拒绝、ref 不动且“其余小对象同步不受影响”（sync :44-47）。若同一目标 commit 的树引用这个大 blob，完整闭包不成立，该 commit 不能发布；小对象可以留在 staging/object store，却不能让同一目标 ref 收敛。现有条款没有说明“不受影响”是指对象暂存、其他独立 root，还是新建不含大文件的过滤 commit。

**修复建议：**v1 简化为整个引用该 blob 的 push 拒绝、ref/worktree 不变，其他独立 root 或后续无该 blob 的 commit 可继续；若要文件级跳过大对象，则需定义过滤树/commit 的身份和用户可见语义，不能继续称原 commit 已同步。

### N4. mode 冲突 Scenario 的预期结果只适用于 type 冲突

Scenario WHEN 把 file→directory 和 executable bit 改动放在一个“或”分支，THEN 只要求 UI 让用户选择“保留目录/保留文件内容”（sync :39-42）。目录与文件是 type 冲突；executable bit 是 mode 冲突，结果必须保留所选版本的权限位及内容，不能选择“目录”。这使 mode 冲突虽然出现于 WHEN，仍没有可验收的 mode 决议。

**修复建议：**拆成两个 Scenario：file/directory 冲突明确选择路径类型与子树；mode 冲突明确选择 ours/theirs 整体条目（内容+mode），并断言最终 Git tree mode 与工作树执行位一致。

### N5. files chunk hash 出现在幂等键，却没有进入 wire 字段

design §6:170-172 把幂等键冻结为 uploadId、seq、offset、hash；files Requirement 的 PUT chunk 载荷仍只有 uploadId/seq/offset/bytes（specs/plugins/files/spec.md:7），Scenario 又要求重复 PUT 同 seq/offset/hash 幂等（:19-22）。因此 delta 没有说明 hash 是请求字段还是服务端从 bytes 计算，也不能区分相同幂等键配不同内容时应拒绝还是覆盖。

**修复建议：**冻结 chunkHash 字段或明确服务端计算规则；每块校验实际内容摘要，同幂等键同内容返回幂等成功，不同内容明确拒绝。commit 再校验有序分片总长与整文件 hash。

### N6. 生命周期状态机箭头与 delta 不一致

design §2.2:85 写 registered→enabled ⇇ disabled；webui Requirement :7 写 registered→enabled⇄disabled，且上下文要求启用与停用可往返。v2 把原来的双向箭头改成左向箭头，按字面不再表达相同状态机。

**修复建议：**design 改回 enabled⇄disabled，或用明确的有向边逐条写出两种转换。

## 指定裁决与质量

- **W7：设计正文已补硬上限，但规格未闭合。** 1-64MiB、默认 8MiB、未知长度立即拒绝和累计预算在 design §4:117-122 清楚；ports delta 仍是无最大值的“可配”，所以在 Spec 规范层不通过 N1。跨请求预算也应给 ports/files 具体并发额度，当前只写预算公式，sync 的 ≤2 流不能替代其他插件的额度。
- **两处文档错误：PASS。** tmpfs 已改为同一持久文件系统内临时文件+rename（design :89-90）；0.0.0.0 不再错误引用 W7，改为 loopback-only 和后续独立裁决（design :139-140）。
- **W11：维持待 Owner 追认；不阻塞新面实现启动。** design :24 仍标注推荐、待追认；新面零 argv 凭证继续是独立安全 MUST（design :105-106、§8:269；webui delta :7）。legacy --token 例外是否被 Owner 接受仍需记录，但实现本 change 时不得读取/传递 argv 凭证。
- **既有面冲突：**B5、B6 修订与 home-hub hash 收敛和 CLI apiVersion 1 边界相容。两个直接规范冲突是 files/ports delta 落后于 v2 design；sync 的超限与闭包场景、恢复后的 CAS 判定也需要统一。

**评分：6/10。** v2 已把 B1、B4、B5、B6 落到较完整的协议和场景；B2 的规范性 requirement 仍旧，B3 的核心恢复边界不能按文字幂等执行，B7 新场景有不可同时满足的期望，W7 还未同步入 ports delta。剩余缺口集中但触及文件安全、数据恢复与跨机收敛，不宜按“全部闭合”冻结。

**结论：NOT-READY。** 修正 N1-N5、统一 N6 状态机表述并同步 design/spec 的 MUST 和 Scenario 后再冻结。W11 旧入口的追认不作为本 change 启动阻塞条件，但需继续隔离新面零 argv 凭证。
