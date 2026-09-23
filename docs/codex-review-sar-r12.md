# server-access-roles 实现终验 r12

## 1. 结论与评分

**判定：NOT-READY。评分：8.6/10。**

r11 暴露的 watcher 漏计窗口已由 `owners_reload_retry` 闭合；r10/r11 的两条部分满足基线（#2、#4）本轮均达到代码语义满足，九条不可回退基线全部通过源码/既有回归证据复判。当前不能给出 `RELEASE-READY` 的唯一原因是本轮无法在受控 Herdr pane 独立运行 Rust 全量测试和 clippy：当前 shell 的 `HERDR_ENV=0`，且 swap 仅余约 284 MiB。提交方提供的 307/307 与 clippy 收据不替代本轮独立门。

若在受控 pane 以 `-j 1` 独立跑通两项 Rust 门，则本轮没有已知 P0/P1 代码或 spec 阻塞，可转为 RELEASE-READY。

## 2. 验证证据

评审 HEAD：`ee06120a795cde4215d760ab213ad28bcc1620e7`。增量范围：`971a009...HEAD`（`ce32edd` spec 措辞收敛、`ee06120` watcher 修复）。工作树在检查开始时干净。

| 检查 | 本轮结果 |
|---|---|
| `openspec validate server-access-roles --strict` | 通过：Change valid |
| `openspec validate sdk-mgmt-surface --strict` | 通过：Change valid |
| `openspec validate webui-console --strict` | 通过：Change valid |
| `packages/client-sdk` `npm test` | 通过：类型检查 + 87/87 |
| `packages/webui` `npm test` | 通过：139/139 |
| `packages/opendweb` `npm test` | 通过：checkjs + 149/149 |
| `git diff --check be5d008^..HEAD` | 通过，退出码 0 |
| `mbx test -j 1 -p dweb-server` | 未运行：Herdr 技能要求 `HERDR_ENV=1` 的受控 pane；本 shell 为 `HERDR_ENV=0`，swap 余量不足以安全绕过 |
| `mbx clippy -j 1 -p dweb-server --all-targets -- -D warnings` | 同上，未运行 |

### watcher 修复代码复核

- `codes.rs:952-976` 初始化 `owners_reload_retry=false`；指纹未变时仅在 `deny_pending` 与 retry 标志均为空才跳过。owners 归并失败置 retry 并立即 `continue`，因此本轮不调用 `codes.reload`、不推进 `last`。
- `codes.rs:979-993` 只有同轮 `codes.reload` 返回成功才清 retry、推进 `(mtime,len)`；codes reload 失败保留旧快照并等待下一轮。部分 reconciliation 失败虽返回 `Ok(())`，但保留 deny，下一轮由 `deny_pending` 强制重试，不能被指纹短路。
- `registry.rs:500-531` owners reload 在自身锁内归并；失败保留旧快照并上抛，调用方不再回落旧 orphan 集。
- `codes.rs:1844-1931` 新回归覆盖读权限变为 0、失败窗口 generation/used_count 不变、权限恢复但 mtime/len 不变仍能补齐、同键 Replay、他键 Exhausted。root 运行时会跳过该 chmod 注入，这是测试显式记录的环境限制。
- `codes.rs:518-527` 的未覆盖 hash 差集、`:854-868` 的 deny 来源判定仍保持 r11 语义；`last_orphans` 已删除，改为每轮局部 orphan 集，没有残留旧快照变量。

### spec 一致性

`openspec/changes/server-access-roles/specs/server/spec.md:198-200` 现在明确：owners 加载/归并失败走服务 fail-fast；加载成功后的 append 失败保留快照并进入 deny；Redemption 可由同键自愈，Reconciliation 仅由整轮成功 reload 解除。该文字与 `CodeLedger::load/reload`、watcher 的失败/重试路径一致。

## 3. 基线终判（9/9）

| # | 不可回退基线 | r12 判定 | 代码证据 |
|---|---|---|---|
| 1 | `/register` 限流→形状→ts→PoP→幂等/码状态；回放验签且不刷新租期 | 满足 | `openspec/.../spec.md:195`；CLI canonical/验签在 `packages/opendweb/src/register.mjs:61-96,213-226`，既有 r8-r11 对服务端 route 复核不变 |
| 2 | 规范化 code_hash 三元组、pending、双 fsync、启动/热重载 reconciliation | 满足 | `codes.rs:471-563,654-789`；`registry.rs:108-145,500-531`；本轮 retry 标志覆盖 owners 失败且指纹不变窗口 |
| 3 | 新码续期；旧码同键回放不续期；max_uses 序列/并发 | 满足 | `codes.rs:671-725`；既有 `max_uses=2`、双兑回归与 `codes.rs:1844-1931` 终态断言 |
| 4 | 加载/归并失败 fail-fast；append 失败 deny+503、可恢复 | 满足 | `main.rs:326-337` 传播加载错误；`codes.rs:481-562,696-705` 保留快照、来源化 deny；watcher 失败不再吞掉 owners 错误 |
| 5 | KnockLog relay E1 唯一入账；seq 排序/逐出；dismiss/undismiss/pending_count 同锁 | 满足 | r7-r11 已复核的 `knock.rs/gate.rs` 实现与 webui 139/139；本轮无回退 diff |
| 6 | 节点簿例外、token 0600、node_id switch、目标快照、事务/业务路径 | 满足 | r9/r10 并发与事务回归保持；webui 139/139；本轮无相关代码变更 |
| 7 | v1 访客仅 relay；无票 rendezvous 401；open 不装 gate | 满足 | r7-r11 已复核 gate/rendezvous；本轮无回退 diff |
| 8 | 103B receipt、op 扩展、generation 所属台账、SDK union/fixture、register receipt helper | 满足 | r8-r11 已复核 server/admin 与 client-sdk；client-sdk 87/87 |
| 9 | PoP 域含 code/fabric/root/ts；直连 peer 限流；80-bit CSPRNG；码全文不泄露 | 满足 | `packages/opendweb/src/register.mjs:1-96`、`join.mjs:286-404`；opendweb 149/149；本轮无回退 diff |

**基线统计：满足 9/9，部分 0/9，违背 0/9。**

## 4. 问题清单

### P0

无。

### P1

**P1-1（发布证据阻塞，非已知代码缺陷）：Rust 全量门未能独立运行。**

证据：`HERDR_ENV=0`；`sysctl vm.swapusage` 显示 used 约 15076/15360 MiB。仓库 Herdr skill 明确禁止从 pane 外控制/窥探受控 pane，因此本轮没有直接启动 `mbx test` 或 clippy。修复/验收：在 `HERDR_ENV=1` 的 `w74:p1` 或等价受控 pane 串行运行：

```text
PATH="$HOME/.cargo/bin:$PATH" mbx test -j 1 -p dweb-server
PATH="$HOME/.cargo/bin:$PATH" mbx clippy -j 1 -p dweb-server --all-targets -- -D warnings
```

两门均通过后，此 P1 关闭并复评 RELEASE-READY。

### P2

无新增实现或规范问题。`ce32edd` 已收窄 r11 的 deny 清除措辞，消除了此前文案歧义。

## 5. 发布摘要（条件性）

`server-access-roles` 为 dweb-server 增加 owners/visitors/codes/blocklist 访问台账、relay 访客门禁与 KnockLog、三角色管理 API/WebUI，以及带 PoP、跨台账 fsync、幂等回放和热重载恢复的租户邀请码注册；当前代码/规范基线为 9/9 满足，三包 JS 通过 375 项测试、三项 strict 校验通过，待受控 Rust 307 测试与 clippy 独立绿门后发布。
