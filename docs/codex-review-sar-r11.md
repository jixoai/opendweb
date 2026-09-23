# server-access-roles 实现终验 r11

## 1. 结论与评分

**判定：NOT-READY。评分：8.0/10（较 r10 的 7.8 +0.2）。** r10 的 mixed-hash 配额绕过已在实现中修复：部分失败时以“本轮孤儿三元组减去已发布快照 consumed”求 deny hash；Reconciliation deny 也不会被同键补写提前清除。新增两条回归时序能覆盖成功 append 后再制造失败及同 hash 多孤儿恢复。

仍有一个 **P1 发布阻塞**：owners 热重载失败时 watcher 仍以旧 orphan 列表执行 codes reload，并在 codes reload 成功后推进 watcher 指纹；若随后只恢复文件读取权限、mtime/len 不变，watcher 不再重试，新文件入口的 `via_code_hash` register 可长期未计入邀请码用量。另有 Rust 全量测试/clippy 未能在本轮独立运行，因此即便不计该代码问题，用户要求的绿门也尚未完整验收。

## 2. 验证证据

基线 HEAD 为 `971a009eeaf2aabeab06430ed8fe26e1ac8516eb`。运行时复核范围为 `e45e87e`；spec 细化为 `971a009`。`29d0013..HEAD` 另含前轮审计报告提交 `a50cfda`，不作为运行时代码变更评估。

| 命令 / 检查 | 独立结果 |
|---|---|
| `PATH="$HOME/.cargo/bin:$PATH" mbx test -j 1 -p dweb-server` | **未运行**：当前 shell 的 `HERDR_ENV` 未设为 `1`；仓库全局重负载规则要求通过 Herdr pane 运行 Rust 全量测试。当前 swap 已用约 15,057/16,384 MiB。实现方提供的 306/306 收据不计为本轮独立结果。 |
| `PATH="$HOME/.cargo/bin:$PATH" mbx clippy -j 1 -p dweb-server --all-targets -- -D warnings` | **未运行**：同一受控执行前提未满足。 |
| `packages/client-sdk`: `npm test` | 通过：类型检查 + **87/87**。 |
| `packages/webui`: `npm test` | 通过：**139/139**。 |
| `packages/opendweb`: `npm test` | 通过：checkjs + **149/149**。 |
| `git diff --check be5d008^..HEAD` | 通过，退出码 0。 |

OpenSpec change 已由用户直接提供；仓库没有 `docs/agents/issue-tracker.md`，本轮未做外部 issue 查询。后续若需要接入该技能的 issue tracker 流程，请先运行 `/setup-matt-pocock-skills`。

### r10 修复复核

- `code_orphans()` 返回 owners ledger 中所有带 `via_code_hash` 的历史三元组，不会因 unregister 消失：[registry.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/registry.rs:108)、`:142`。每次成功读取 owners 后，前轮已 durable 但未进入旧快照的孤儿仍会出现在本轮输入中。
- `reload` 部分失败时用本轮全部 orphan 对比**已发布** `state.current.consumed`，按未覆盖三元组 hash 去重入 Reconciliation deny；完整成功才发布候选快照并全量清 deny：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:505)。该差集同时覆盖本轮已 append 成功但未发布、先前轮次已 durable 但未发布、以及外部文件入口已被 owners reload 观察到的 orphan。
- `complete_pending` 只自动清除 Redemption 来源 deny；Reconciliation 来源保持到整轮 reload 发布：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:854)。新增混合 hash 与同 hash 多孤儿测试分别从 [codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:2067)、`:2154` 开始；源码时序合理，但 Rust 测试未在本轮实跑。
- Spec 第 199 行已写入差集定义和来源化清理规则，与上述实现吻合；第 198 行仍留有较宽泛的“补写成功即从 deny-set 移除”，见 P2。

## 3. r10 基线终判

| # | r7 不可回退基线 | r11 判定 | 证据 / 说明 |
|---|---|---|---|
| 2 | 三元组幂等键、pending、双 fsync、启动/热重载 reconciliation | **部分满足** | r10 mixed-hash 缺口已闭合；但 owners reload 失败后 watcher 可能推进指纹并遗漏新 orphan，见 P1-1。`codes.rs:921-968`。 |
| 4 | 加载失败 fail-fast；补写失败 deny-set 503 并恢复 | **部分满足** | 部分失败 deny 差集与整轮恢复正确；但 owner 文件 reload 错误被当作可继续流程，后续可能不再重试并留下未计数 register。`registry.rs:523-529`、`codes.rs:958-968`。 |
| 6 | 节点簿 token 0600、仅 node_id switch、请求目标快照、配对码纪律 | **满足** | r11 未触及；r10 独立 webui 139/139 与节点簿并发验收仍适用。 |

沿用 r10 其余六项满足状态：**满足 7/9，部分满足 2/9，违背 0/9**。Rust 门本轮未重跑，故这是代码语义复判，不代表完整 RELEASE-READY 验收。

## 4. Standards

未发现硬性编码规范违例。`HashSet<[u8; 32]>` 是局部 hash 去重集合；本模块既有固定宽度哈希表示，新增领域包装类型收益不足，不升级为 Primitive Obsession 发现。

## 5. Spec 与遗留问题

### P0

无。

### P1（阻塞发布）

**P1-1：owners reload 失败可被 watcher 记为已处理，外部 orphan 永久漏过差集。** watcher 在 owner 文件指纹变化后调用 `owners.reload_for_orphans()`；错误时只保留 `last_orphans` 并继续调用 `codes.reload`：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:958)。若 codes reload 成功，它无条件执行 `last = current`（`:966-973`）。watcher 的指纹仅为 `(mtime, len)`（`:915-918`）；临时读权限/IO 恢复不保证改变这两个值。于是 owner reload 失败期间新增的有效 `via_code_hash` register 不在旧 `last_orphans`，codes reload 可在未识别它的情况下发布并推进指纹；权限恢复后 `current == last` 且 deny 为空，后续轮次跳过。此时该码的 `used_count` 不含新 register，仍可能接受超出 `max_uses` 的兑换。该路径直接破坏 spec“运行时经文件入口追加的 register 在下次 reload 补齐”要求（[server spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/server-access-roles/specs/server/spec.md:198)）。

**修复建议：** `owners.reload_for_orphans()` 失败时本轮不要调用 `codes.reload`，也不要推进 `last`；保留待重试标志，直到 owners reload 成功并用同一轮 orphan 集合完成 codes reload。加入 watcher 回归：owner 指纹变化后注入一次 owners 读取失败，codes reload 不得发布/推进；恢复权限且 mtime/len 不变后仍必须重试并补齐 orphan，断言 `used_count`、deny 和配额终态。

### P2（非阻塞）

**P2-1：deny 清除规则仍有宽泛旧句。** [server spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/server-access-roles/specs/server/spec.md:198) 写“补写成功即从 deny-set 移除”，下一行细则则规定 Reconciliation 来源仅由整轮成功 reload 解除、只有 Redemption 来源由同键补写自愈。实现按细则执行；建议将第 198 行改为来源限定表述，避免实现者按旧句清除 Reconciliation deny。

**验证门缺口（阻塞发布，但非代码发现）：** Rust 306 测试与 clippy 本轮没有独立运行。完成 Herdr 受控执行并通过两项门后，重新评估 RELEASE-READY；当前不能用提交方提供的测试收据替代。
