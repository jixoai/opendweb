# webui-plugin-kernel 设计终验 r9

## 结论摘要

**结论：NOT-READY。评分 8.8/10（r8：8.4/10）。**

r8 最小清单的 transport 包络、TERM 收尾、真双机边界回归和 P1 生命周期修复，均已在当前源码、窄测试和提交/验收回执中找到对应实现。仍有一个归档前阻塞：sync 的工作树读取把 `lstat` 预检和按路径 `readFile` 分成两个未受控操作，不能保证“超限对象永不入史”和“symlink 不跟随”这两个不变量在并发文件变化下成立。

本轮独立运行：`ext-sync` transport/endpoint、`ext-files` lifecycle、WebUI plugin host/route 窄测试共 **47/47** 通过；`git diff --check` 通过。未重跑 Fabric 全量、strict 或真双机，相关结论引用提交与验收文档中的回执。

## 最小清单逐项验收

| 项目 | 判定 | 证据与边界 |
|---|---|---|
| B4/F2：1MiB 有效包络与毒化历史 | **部分通过，阻塞** | ports 的 64KiB–1MiB 硬域、files 1MiB chunk/read、sync 1MiB blob/2MiB closure、三层 transport double 和 `oversize-history`/`closure-exceeds-transport` 场景均已落地。`endpoint.mjs` 的整 push 原子拒绝和本地预检测试通过；但 `worktree.mjs` 的本地预检存在 TOCTOU，详见 B1。 |
| B5/TERM | **通过** | `cli.mjs` 的 `settleExit` 在 close 完成后设置 2s `unref` 宽限，保留 `incomplete-drain` 诊断；空载和活跃 Fabric 进程退出门测试存在并通过。原生 `HttpServerJs` TSFN 主动释放仍明确属于独立内核 change，不伪装成已在本 change 根治。 |
| 清单 3：双机边界回归 | **通过（供应证据）** | 第八批记录了 files 恰 1MiB/超 1B、sync 恰 1MiB、超限对象、closure 超流账、移除超限后的恢复路径，且记录了双端运行态和 md5。当前轮未停止或重跑双机进程。 |
| P1：files disable→enable 往返 | **通过** | `runtime.mjs` 的 dispose 可逆化、`host.mjs` 的 enable 失败原子回滚和 `enable-failed` 语义已落地；ext-files lifecycle、WebUI host 测试及活环境双 200 回执一致。 |

## 阻塞问题

### B1：sync 入史预检存在检查/读取竞态

`packages/opendweb-ext-sync/src/worktree.mjs:55-75` 先对路径执行 `lstat`，用 `st.size` 判断是否超过 `MAX_OBJECT_BYTES`，随后再次按路径 `readFile(childAbs)` 并 `writeBlob`。预检与读取之间没有受控 fd、`O_NOFOLLOW`、读取中累计上限或读取后长度复核。因此：

1. 文件在 `lstat` 后增长，`readFile` 可以得到超过 1MiB 的内容，随后该 blob 被放进本地对象库并可由 `commitLocal` 提交到 device ref；
2. 普通文件在两步之间被替换成 symlink，`readFile(childAbs)` 可能跟随链接读取同步根外内容；
3. 目录分支使用 `Dirent.isDirectory()` 后直接递归 `walk(childAbs)`。目录在 `readdir` 与递归之间被替换成 symlink 时，扫描器会跟随目录链接并把外部文件纳入扫描结果；
4. `pathStateTuple`（同文件 `:116-124`）也采用 `lstat` 后按路径 `readFile`，并在 intent 分诊期间写 blob，因而恢复/冲突判断同样没有路径稳定性保证。

这不是当前 1MiB 正常路径测试能覆盖的情形；现有用例证明静态、无竞态的超限文件会被拒绝，但没有证明“检查到提交线性化点”之间的并发变化。它直接违反 sync spec 对入史前超限拒绝及 symlink 不跟随的安全不变量，故阻塞 archive。

**可验证的最小修复：**

- 普通文件以受控 fd 打开（`O_NOFOLLOW`），对 fd 做 `fstat`，从 fd 有界读取并在累计超过 1MiB 时立即返回 `oversize-history`；只有完整读取、长度和类型再次确认后才允许 `writeBlob`；
- 目录扫描使用 fd-relative/openat 等价的逐级锚定；若当前平台没有可靠原语，则在目录身份变化或 symlink 情况下 fail-closed，不继续递归；
- `pathStateTuple` 复用同一受控读取原语，不再 `lstat` 后按字符串路径读取；
- 增加确定性测试：预检后增长、普通文件替换为 symlink、目录替换为 symlink、恢复分诊期间替换。每个用例断言稳定错误、device/group ref/tree/commit 不变、根外无读取或写入，intent 现场按协议保留。

## 非阻塞改进与归档记录

- 用户列出的后置项清单（E1′-①、F3、P2/P3、known_addrs 历史迁移、native TSFN 根治）已覆盖本轮发现的非阻塞尾项；B1 竞态不属于后置项，必须在 archive 前闭合。
- `openspec/changes/webui-plugin-kernel/tasks.md` 仍保留大量 `[ ]`，包括收官门和 W7–W11 Owner 追认。实现证据已齐，但归档前应把任务清单与实际提交/验收状态同步，W11 的安全默认仍应留下 Owner 追认记录。
- E1′-①（iroh 同 NodeAddr 新握手抑制的单例）可作为独立诊断 change；第七批互锁修复后数据面已不再被其阻塞，但应保留复现材料和后续验收条件。
- F3 UI 建组 id 输入框、P2/P3 走查建议属于产品 polish，可后置，不阻塞内核归档。
- known_addrs 历史条目迁移/native `HttpServerJs` TSFN 主动释放应分别标为维护项/独立内核 change；当前实现已经有活性修剪和 CLI 壳层 `settleExit`，不能把后置项描述成当前 change 已完成。
- 当日 `session_resume_mid_stream_sse` 高负载偶发抖动已被记录为隔离项；建议附在归档 receipt，不把单次抖动扩大成当前功能阻塞，除非后续复现为确定性失败。
- 双机环境、Fabric 316/0、各插件套件和 strict 的绿门属于供应证据；本轮没有重启或杀死运行中的 iMac/mini 进程。

## 质量评价与评分

相较 r8，跨层 transport 约束已真正收敛到 1MiB，超限对象、closure 流账、毒化历史迁移、TERM 闩锁和 files 生命周期都有实现与回归证据，故从 8.4 提升到 **8.8**。扣分集中在 B1：它不是文档瑕疵，而是会在本地并发变更下破坏 sync 的核心安全/历史不变量；同时归档任务清单尚未反映完成状态。完成受控读取与竞态测试后，可重新复验并进入 archive/收官流程。

## 最小闭合清单

1. 修复 `scanWorktree`、`pathStateTuple` 的受控 fd/有界读取与目录递归竞态。
2. 补齐四类确定性竞态测试，并证明 ref/tree/commit、根外路径和 intent 现场的结果。
3. 更新 `tasks.md` 的收官状态和 W11 追认记录，再以现有双机 receipt 重跑轻量归档门。
