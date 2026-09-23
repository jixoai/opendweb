# server-access-roles 实现终验 r10

## 1. 结论与评分

**判定：NOT-READY。评分：7.8/10（较 r9 的 7.2 +0.6）。** r9 的节点簿 switch/delete 竞态已由共享变更锁、删除原子检查和提交前重查闭合；错误来源在失败路径中也能保守维持 Reconciliation，不降级为 Redemption。全量 Rust、clippy、三包 npm 与 diff-check 均独立通过。

仍有一项 **P1 发布阻塞**：codes 热重载 reconciliation 部分失败时，成功补写的 orphan consume 会被留在磁盘、但随旧快照一起不发布；这些成功 hash 不进入 deny-set，仍可按旧 `used_count` 再次兑换。相同 hash 的 pending 成功补写路径还会无条件清掉 Reconciliation deny。现有回归只覆盖单 hash，不能发现该窗口。修复并补多 hash/同 hash 多孤儿测试、重跑绿门后再判 RELEASE-READY。

## 2. 验证证据

评审基线为 HEAD `29d0013`，实现差异范围 `775683c..29d0013`；开始时工作树干净。Rust 因 swap 已用约 14.3/15 GiB，选择 `-j 1`。

| 独立命令 | 结果 |
|---|---|
| `PATH="$HOME/.cargo/bin:$PATH" mbx test -j 1 -p dweb-server` | 通过：264 单测 + 39 e2e + 1 story = **304/304**。 |
| `PATH="$HOME/.cargo/bin:$PATH" mbx clippy -j 1 -p dweb-server --all-targets -- -D warnings` | 通过，零 warning。 |
| `packages/client-sdk`: `npm test` | 通过：类型检查 + **87/87**。 |
| `packages/webui`: `npm test` | 通过：**139/139**。 |
| `packages/opendweb`: `npm test` | 通过：checkjs + **149/149**。 |
| `git diff --check be5d008^..HEAD` | 通过，退出码 0。 |

### 修复复核

- `CodeLedger::reload` 全段持 codes 锁，读盘、归并、补写与发布均与 redeem 写路径互斥；锁序说明为 codes→owners，watcher 两台账顺序调用不嵌套。证据：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:459)、`:482`。
- `complete_pending` 的**append 失败**分支保留既有 Reconciliation 来源，不降级；redeem 对同键仍尝试恢复、他键按来源返回 503/409。证据：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:626)、`:645`、`:776`。但成功分支会无条件移除该 hash 的 deny，见 P1。
- 节点簿 switch/delete 使用同一 `nodeMutationInFlight` 覆盖异步校验与落盘提交；delete 在锁内检查当前节点，switch await 后重查目标存在，最后才切换内存 target/token。证据：[sidecar.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/webui/src/sidecar.mjs:662)、`:685`、`:717`。三种指定交错均有回归：[nodes.test.mjs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/packages/webui/test/nodes.test.mjs:417)、`:461`、`:501`。
- `29d0013` 的 spec 裁决写在 [server spec](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/openspec/changes/server-access-roles/specs/server/spec.md:199)。代码落实了“失败时保留旧快照、失败 hash 入 deny、完整成功后发布”的字面条款；但未覆盖成功补写后被旧快照隐藏的 hash，因此没有落实该条款防止 `max_uses` 绕过的目的。

本轮未重跑提交方提供的云端生产走查和浏览器视觉验收；它们不计入上述独立门结果。

## 3. r9 基线复判

| # | r7 不可回退基线 | r10 判定 | 证据与说明 |
|---|---|---|---|
| 2 | 三元组幂等键、pending、双 fsync、启动/热重载 reconciliation | **部分满足** | 单锁、协议与完整成功恢复存在；部分失败的混合 hash 场景可能在旧快照下重复放行，见 P1。`codes.rs:418-447,482-510`。 |
| 4 | 加载失败 fail-fast；补写失败 deny-set 503 并恢复 | **部分满足** | 首启 fail-fast、失败来源映射和单 hash 恢复通过；成功补写 hash 未发布且未 deny，另有成功 pending 补写可提前清 Reconciliation deny。`codes.rs:487-502,645-668,800-809`。 |
| 6 | 节点簿 token 0600、仅 node_id switch、请求目标快照、配对码纪律 | **满足** | 变更互斥和提交前存在性复查落实；switch/delete 三项交错测试通过。`sidecar.mjs:662-710,717-748`；webui 139/139。 |

沿用 r9 其余六项满足状态，复判总计：**满足 7/9，部分满足 2/9，违背 0/9**。

## 4. 遗留问题

### P0

无。

### P1（阻塞发布）

**P1-1：reconciliation 部分失败没有对所有“未发布的 durable consume”维持 fail-closed。** owners 快照可返回多个不同 code hash 的孤儿：[registry.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/registry.rs:142)。`load_inner` 对每个 orphan 逐个 append；成功项写进 codes 文件并加到候选 `consumed`，只有 append 失败项才进入候选 `deny`：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:416)。只要有任一失败，`reload` 保留旧 `state.current`，并只合并失败项的 deny 后返回：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:487)。随后 `redeem` 仅检查当前 hash 是否在 deny，再以旧快照的 `used_count` 判耗尽：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:652)。所以 A hash 补写成功、B hash 补写失败时，A 的 consume durable 但不在已发布快照，也不在 deny；A 仍可按旧计数再次兑换并超出 `max_uses`。

同一保护还会被成功 pending 重试提前解除：`complete_pending` 成功时不区分 deny 来源，直接移除该 hash 的 deny，再仅从旧快照加入当前 key：[codes.rs](/Users/kzf/Dev/GitHub/jixoai-labs/opendweb-sdk-mgmt-surface/crates/dweb-server/src/access/codes.rs:800)。若同 hash 还有其他 orphan 未进入快照，这会在 watcher 整轮成功前解除保护。当前失败回归仅构造一个 orphan/hash（`:1879-1899,1933-1951`），未覆盖混合 hash 或同 hash 多 orphan。

**可验证修复建议：** 部分 reload 失败时，对所有本轮 orphan 中尚未包含在已发布快照的 code hash 维持 Reconciliation deny（保守做法可直接 deny 本轮全部 orphan hash），直到一次整轮成功发布新快照；成功的同键 pending 补写可完成当前请求，但不得提前清除 Reconciliation 来源 deny。增加两类测试：A/B 两个 hash、A append 成功而 B 失败时 A 的他键请求不得继续兑换；同一 hash 多 orphan、一个补写失败后同键恢复成功时，剩余他键仍不得越过配额。恢复后断言快照消费计数覆盖全部 durable 三元组、deny 仅在整轮成功时清除。

### P2（非阻塞）

无新增代码级 P2。云端生产和浏览器视觉验收未在 r10 重跑，属于本轮验证范围之外，不能视作本轮独立证据。
