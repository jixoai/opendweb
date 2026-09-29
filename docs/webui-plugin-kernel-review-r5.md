# webui-plugin-kernel 设计评审 r5（窄轮复验）

## 范围

Owner 说明：d4a4cf5 的修复脚本在锚点断言失败后整体中止，ports/sync delta 未写盘，而提交信息错误声称已闭合；本轮改为单替换脚本、逐文件读回断言和暂存清单核验。该流程原因作为 Owner 提供的背景记录；本轮判定独立依据最新提交 `7d04d2684fe009911c319a031ce809ddeabb3402` 的逐文件 diff 与当前 design/spec 文本，不以提交说明代替验收。评审范围仅为 N1-N5 和 v2.2 引入的相关矛盾；未运行实现门禁。

## N1-N5 判定

**N1 — PASS（边界覆盖；Scenario 结构有偏差）。** ports Requirement `specs/plugins/ports/spec.md:7` 已写入默认 8MiB、1-64MiB 硬域、超范围拒绝启动映射、未知长度边读边累计拒绝、最多 16 个并发代理、预算超额 429。`spec.md:16`、`:17` 覆盖已知/未知长度、并发超限和 128MiB 配置拒绝。files 的 fd 链主句仍正确。细节偏差：这三类新边界合并进一条既有 Scenario，而不是三条独立新增 Scenario；行为覆盖齐全，不单独阻塞。

**N2 — PARTIAL，阻塞。** `design.md:238` 对 `currentRef == targetCommit` 规定只做逐路径完成性核验并补 done，`design.md:242` 又把三态路径分诊限定为“仅 oldRef 分支执行”。因此 targetRef 分支发现路径不是 postimage 时，既没有重放，也没有明确转冲突、保留 intent 或禁止补 done 的规则。sync delta `specs/plugins/sync/spec.md:57` 则对 ref 与路径三态作无条件组合断言，`:61` 的扫描后编辑用例也未约束 ref 分支。ref 已推进后、done 前路径被用户修改时，design 与 Scenario 无法唯一决定恢复结果。

**N3 — PASS。** design `design.md:214` 明确整个引用超限 blob 的 push 拒绝；sync delta `specs/plugins/sync/spec.md:51`、`:52` 明确部分对象成功不合法、ref 与工作树零变化，并把可继续同步限定为其他 root 或不引用该 blob 的后续 commit。与闭包校验一致。

**N4 — PARTIAL，阻塞。** 两种冲突现已拆成 `specs/plugins/sync/spec.md:39` 和 `:44` 两条 Scenario；mode 决议也明确内容与 mode 整体选择，并在 `:47` 断言 tree mode 与工作树执行位一致。但 mode Scenario 的 WHEN 是“双方内容相同但一方改变了可执行位”，没有描述另一端对同一路径的竞争性修改，按三方合并语义这只是单侧 chmod，应自动传播而不是进入 conflicted。当前 Scenario 要求的冲突 UI 因此前置条件不足，无法验收文件级冲突策略。

**N5 — PASS。** design `design.md:160`、`:161`、`:174` 和 `:177` 已将 `chunkHash` 写入 wire，幂等键统一为 `(uploadId, seq, offset)`，并冻结同键异内容拒绝、服务端重算摘要、全片总长及整文件 hash 校验。files delta `specs/plugins/files/spec.md:7`、`:21`、`:22` 与之对齐，Scenario 覆盖伪造摘要、同键异内容和整文件摘要失败。

## v2.2 相关新矛盾

- **targetRef 恢复分支没有冲突出口。** 协议要求 `currentRef == targetCommit` 时只核验、不重放；然而路径三态分诊被限定在 oldRef 分支。若 targetRef 已推进而路径在恢复前被用户修改，Scenario 要求保留并转冲突，design 却没有定义核验失败后的状态，也没有说 intent 是否继续保留。应明确：targetRef 分支只接受 postimage；任一路径为 preimage/其他状态都不得补 done，必须保留现场并进入冲突，后续经用户决议形成新的同步提交。
- **mode 冲突用例没有制造冲突。** 明确 base/ours/theirs 状态，并让双方对同一路径产生竞争性变更；若设计意图是“mode 变化与另一端内容变化一律文件级冲突”，将这一保守规则写入 Requirement/Scenario。否则单侧 mode 变化应按普通三方合并自动传播，不能期待冲突 UI。

**评分：7/10。** N1、N3、N5 的关键规范已对齐，N4 的决议结果也已冻结；N2 的 ref 已推进恢复路径仍不确定，N4 的 mode 用例没有建立其前置冲突条件。两项都影响同步恢复或是否自动合并的核心行为，尚不宜冻结。

**结论：NOT-READY。** 先补齐 targetRef 下路径不匹配的冲突/intent 处理，再把 mode Scenario 改为可复现的三方竞争状态；复验这两项后再冻结。
