# webui-plugin-kernel 设计评审 r6（窄轮复验）

## 范围

基线为 `e8ea47ad229814dcc11ed922860c01e6fe88a552`。只复验 r5 两项阻塞（N2、N4）及 N1 ports Scenario 拆分；逐项核对最新 diff、design 与相关 spec delta。未运行实现门禁。

## 验收

**N1 — PASS。** `specs/plugins/ports/spec.md:14`、`:19`、`:24`、`:29` 分别覆盖已知长度超限、未知长度累计拒绝、并发预算与配置硬域、授权默认拒绝。Requirement `spec.md:7` 明确默认 8MiB、1-64MiB 配置硬域、超范围拒绝启动映射、未知长度边读边拒绝、16 并发上限及 429。边界已拆为独立 Scenario，符合 r5 修复要求。

**N2 — PASS。** `design.md:238` 的 targetRef 分支只接受逐路径 postimage；任一路径为 preimage 或其他状态时不得补 done，保留 intent 并转 conflicted，经用户决议形成新同步提交后清理。`design.md:242` 将 preimage/postimage/其他的路径三态限定在 oldRef 分支，避免与 targetRef 的只核验、不重放规则混淆。sync delta `specs/plugins/sync/spec.md:57` 同步了 targetRef 非 postimage 的冲突出口，`:61` 独立验证扫描后编辑保护。r5 的 targetRef 处理缺口已闭合。

**N4 — PASS。** sync delta `specs/plugins/sync/spec.md:44`、`:46`、`:47` 将 mode 场景独立出来，并给出 base/ours/theirs：base 为非执行 V0，ours 只增加执行位，theirs 将内容改为 V1 且 mode 不变。这构成同一路径上的竞争性变更。Scenario 明确 mode 与另一端内容变化按文件级冲突、内容与 mode 整体决议并校验 tree mode 与工作树执行位一致；单侧 mode 变化则自动传播。r5 指出的前置条件缺失已闭合。

## 新矛盾与终判

本次范围内未发现新的阻塞矛盾。N2 targetRef 分支中“物化视为完成”后再做 postimage 核验的措辞可以更精确地写成“ref 推进视为完成；工作树仅在 postimage 核验通过后视为完成”，但其非 postimage 的处置已明确为保留 intent 并转冲突，不影响当前行为判定。

**评分：9/10。** N1 拆分和 N2、N4 两项 r5 阻塞均已落实到设计及验收场景；扣分仅因 targetRef 分支的“完成”措辞仍可进一步区分 ref 与工作树状态。

**结论：GO。** r5 两项阻塞与 N1 Scenario 拆分均通过本轮文档复验。
