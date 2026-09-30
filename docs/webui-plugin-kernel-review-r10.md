# webui-plugin-kernel 实现终确 r10

## 范围与证据

本轮只复验 r9 的唯一阻塞 B1（sync 工作树读取 TOCTOU）及其最小闭合项。核对基线为 HEAD `c66e12c`；未停止双机进程，也未重跑重型 Fabric/全仓门禁。独立轻量证据如下：

- `node --test --test-concurrency=1 --test-force-exit packages/opendweb-ext-sync/test/worktree-race.test.mjs`：7/7 通过；覆盖静态基线、超限增长、限内增长、文件换 symlink、目录换 symlink（递归前与 open/readdir 间）、恢复分诊替换。
- `node --test --test-concurrency=1 --test-force-exit packages/opendweb-ext-sync/test/*.test.mjs`：74/74 通过（含上述 7 个用例）。
- `git diff --check`：通过。
- Fabric、client-sdk、webui、ext-files、ext-ports、strict 与真双机结果沿用提交/验收回执；本轮不将供应回执冒充本地重跑。

## B1 验收

**判定：闭合，非阻塞。** 当前实现已经把入史和恢复分诊的路径读取收敛到同一受控原语：

1. `readRegularFileAnchored` 先以 `O_RDONLY|O_NONBLOCK|O_NOFOLLOW` 打开，再在 fd 上 `fstat` 复核 regular 与尺寸；以 64KiB 分块读取，累计超过上限立即返回稳定 `oversize-history`；读完复核总长度，变化返回 `worktree-race`；通过完整确认后才 `writeBlob`。这同时覆盖了 FIFO 挂起、超限内容入史和读中增长。
2. 目录递归使用 `O_DIRECTORY|O_NOFOLLOW`，记录 fd 的 dev/ino，并在 `readdir` 后按路径 `lstat` 复核身份；目录替换、symlink 或类型变化 fail-closed。子文件也通过同一 `O_NOFOLLOW` 原语打开，不跟随终组件 symlink。
3. `pathStateTuple` 复用上述受控文件读取；`recoverIntent` 将测试专用 `readHook` 透传到分诊读取。出现竞态时不写 ref，不补 `done`，保留 intent 现场。
4. 竞态用例对错误码/原因、对象库零污染、ref 零变化、intent 保留及根外哨兵不进入松散对象库作出确定性断言；不依赖 sleep 或概率时序。

这满足 r9 最小修复要求：普通文件受控 fd 读取、目录锚定/复核、恢复分诊复用，以及四类确定性竞态验收。提交回执中的 ext-sync 74/74 与本轮窄测一致。

### 明确边界

macOS 上 `fdchain` 的能力探测仍采用设计 §6 已冻结的 `verified-walk` 降级：逐级 `O_DIRECTORY|O_NOFOLLOW`、身份复核、运行时 wire 操作互斥；该模式明确不宣称对**本地属主进程**在每个路径解析窗口内的完全 fd-relative 竞态免疫，win32 则显式拒绝 share。sync 目录扫描同样不是 openat NAPI 实现，因此不应把它描述成绝对的本地属主竞态免疫。这个边界已被实现注释和 files 设计契约明示；在本轮已冻结的信任域与验收范围内不构成 B1 阻塞。若未来把同步根视为恶意本地属主对手，则需另行引入 Darwin openat 等效 NAPI change，并新增对应验收，不属于本 change 的 r10 闭合条件。

## `tasks.md` 状态同步

Phase 1–3 实现验收、r9-B1、W12 已勾销，且有提交/测试/双机回执。收官门中仍未勾的项目是：

- 既有面全量回归与 strict×2 的 Owner/归档前终跑；
- Codex r10 终验（本报告完成后可勾销）；
- Owner 本人双机实走；
- W7–W11 Owner 追认（W11 的既有 `--token` 受控例外记录仍需保留）。

这些是归档流程与 Owner 追认事项，不是当前实现的 B1 失败。W12 已按 r7 approve、r8 确认落地并勾销。

## 评分与结论

**评分：9.2/10（r9：8.8/10，+0.4）。** 加分来自 B1 的代码级受控读取、fail-closed 目录/文件竞态处理、恢复分诊保护和 74/74 的独立复跑；保留 0.8 分扣减用于未由本轮重跑的全量/strict×2、Owner 实走、W7–W11 追认，以及已声明的 macOS `verified-walk` 本地属主边界。没有发现新的实现阻塞或与既有契约冲突。

**最终结论：GO。** 从 Codex 侧没有遗留的技术阻塞，可以进入 `archive change → merge → push` 收官流程。归档前仍按 `tasks.md` 完成 Owner 负责的全量终跑、双机实走和 W7–W11 追认记录；这些不会改变本轮 B1 的 GO 判定。
