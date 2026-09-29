# webui-plugin-kernel 设计评审 r4（窄轮复验）

## 范围与结论

复验基线为 `d4a4cf57ce85fe01ac2679cf4bbdf500bac4f110`，只核对 r3 的 N1-N6 与 v2.1 新引入的相关矛盾；按要求未运行门禁。该提交在 change 文档中只改了 `design.md` 和 `specs/plugins/files/spec.md`，ports、sync、webui 三份 delta 均未改，因此若干设计正文修复没有进入规范性验收面。

## N1-N6 验收

**N1 — PARTIAL，未通过。** `design.md:162` 与 files delta `specs/plugins/files/spec.md:7` 已将 fd 链逐组件遍历写成规范主句，并明确 lstat+open 不合格；files delta `:14` 有并发逃逸验收。ports 部分只在 `design.md:117` 写入范围、未知长度拒绝和 16/4/2 预算；ports delta `specs/plugins/ports/spec.md:7` 仍只有“默认 8MiB 可配”，没有 1-64MiB 范围、超范围拒绝、未知 Content-Length 边读边拒、具体并发额度/429，也没有未知长度、并发超限、128MiB 配置拒绝启动映射 Scenario。规范层尚不能冻结 W7。

**N2 — PARTIAL，未通过。** `design.md:231` 已加入 ref 三态和 preimage 保护，但恢复分支写 `currentRef == targetCommit` 时“仅补 done”，紧接着又要求“之后确定性 roll-forward（幂等重放物化）”；两句没有说明此分支是否重放文件操作。更关键的是只记录 preimage OID/不存在（`design.md:236`）：若进程在某路径已 rename 出 target 内容后、ref 推进前崩溃，重启会把引擎自己的 target postimage 识别成 preimage 不匹配并误报用户冲突。type/mode 也不由 blob OID 表达。sync delta `specs/plugins/sync/spec.md:49` 未增加扫描后编辑用例，仍对全部恢复边界断言无条件 roll-forward 与一致收敛；`:54` 也未覆盖 preimage 冲突分支。

**N3 — PARTIAL，未通过。** `design.md:209` 已统一为引用超限 blob 的整个 push 拒绝、ref/工作树不变，独立 root 或不含该 blob 的后续 commit 可继续。但 sync delta `specs/plugins/sync/spec.md:44` 仍只写“该对象传输被拒绝”“其余小对象同步不受影响”，没有规定引用该 blob 的 push 必须整体拒绝，也没有限定“不受影响”只指独立 root 或后续不引用该 blob 的 commit。按当前 Scenario 仍可实现部分对象成功，和完整 commit/tree 闭包约束不闭合。

**N4 — 未通过。** sync delta `specs/plugins/sync/spec.md:39` 仍是一个同时覆盖文件改目录与可执行位变化的 Scenario，决议却只给“保留目录/保留文件内容”。目录选择不适用于 mode 冲突；没有断言 mode 决议把内容与可执行位作为整体，也没有断言最终 git tree mode 与工作树执行位一致。`design.md:251` 只把 type/mode 都归入文件级冲突，未补上两种冲突各自的决议模型。

**N5 — PARTIAL，未通过。** files delta `specs/plugins/files/spec.md:7` 已冻结 `chunkHash`、服务端从 bytes 重算、同 `(uploadId, seq, offset)` 同内容幂等、不同内容拒绝覆盖，以及 commit 按序校验总长和整文件 hash。可是 `design.md:160` 的 wire 仍是 `{uploadId, seq, offset, bytes}`，没有 `chunkHash`；设计幂等键在 `design.md:171` 仍写成 `(uploadId, seq, offset, hash)`，与 delta 的键字段及冲突比较语义不同。Scenario `files/spec.md:19` 也没有覆盖伪造 chunkHash、同键异内容拒绝或整文件摘要不匹配。

**N6 — PASS。** `design.md:85` 已明确列出 `registered → enabled` 与 `enabled ⇄ disabled` 两条转换；webui delta `specs/webui/spec.md:7` 的 `registered→enabled⇄disabled` 表达相同状态关系，未发现实质语义分歧。

## v2.1 相关新问题

- **恢复状态不能区分“尚未应用”“已应用”和“用户新改动”。** preimage 比较至少要把目标 postimage 纳入判定：实际状态等于 preimage 时可执行，等于目标 postimage 时视为该路径已完成，二者都不等时保留内容并进入冲突。判定元组还需覆盖 entry type 与 mode；否则相同 blob 内容上的 chmod/type 变化会漏检。ref 已为 target 时不再 CAS；preimage 冲突要如何保留 intent、暂停或提交用户决议，也必须在协议和 Scenario 中写明。
- **v2.1 的新超限语义只在设计正文中。** sync delta Scenario 保留旧预期，规范消费者无法据此判断整次 push 是否原子拒绝。
- **files 的 wire/idempotency 主句出现设计与规范分叉。** 当前实现者可能按设计省略 `chunkHash` 并把 hash 放进幂等键，也可能按 delta 实现显式字段且对同键异内容拒绝；两种行为不能同时满足。

## 修复建议

1. 把 ports 范围、未知长度累计拒绝、16/4/2 额度、429 和超范围配置拒绝同步到 ports Requirement，并为未知长度、并发超限和配置超限各加 Scenario。
2. 重写 §7.3.1 的恢复步骤，定义 preimage/postimage/其他状态分类及 ref 三态的确切执行顺序；同步更新恢复 Scenario，覆盖引擎已写入部分路径后崩溃、扫描后用户编辑和 mode/type 变化。
3. 将超限对象 Scenario 改为引用它的整个 push 原子拒绝；把可继续同步的边界限定为独立 root 或后续不引用该 blob 的 commit。
4. 将 type 与 mode 拆成两个 Scenario。mode 决议必须选择内容与 mode 的组合，并验证 tree mode 与工作树执行位一致。
5. 统一 design §6 与 files delta 的 `chunkHash` 字段、幂等键和不同内容拒绝规则，并加摘要不匹配及整文件摘要失败验收。

**评分：4/10。** fd 链主句、files 的 chunk 摘要规范和生命周期有向状态边已有进展；但 N1、N2、N3、N4、N5 仍有规范遗漏、相互矛盾或恢复不可判定的路径。缺口集中在资源上限、同步原子性与用户数据保护，不能按已闭合设计冻结。

**结论：NOT-READY。** 完成以上修订并使 design 与四份 delta 的 Requirement/Scenario 一致后，再进行下一轮冻结验收。
