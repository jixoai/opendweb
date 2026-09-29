# plugins/sync delta —— webui-plugin-kernel

## ADDED Requirements

### Requirement: 文件同步插件（虚拟 git：单向/双向/冲突）

sync 插件 SHALL 以 isomorphic-git 为对象/refs/commit 底座 + 自定义对象同步端点（`/wpk1/sync/<groupId>/<rootId>/<op>`：`GET refs`/`POST want`/`GET object/<oid>`/`POST push`，不实现 git smart HTTP）+ 自持三方树合并（分类 add/modify/delete/type/mode；文本 blob 走 node-diff3 `stringSeparator:"\n"` 非重叠自动合并）实现 [W3] 全语义。同步组账本 `<DWEB_HOME>/plugins/sync/groups.json`（members/roots/seedAuthority）；gitdir 独立于用户目录（`<DWEB_HOME>/plugins/sync/<groupId>/<rootId>/git`），工作树=用户目录本体；组模型账本/ref 命名 MUST 支持 N 成员记录（每设备 ref `refs/devices/<endpointId>/main` + 组收敛 ref），但 v1 同步执行与收敛 MUST 只保证双机 pairwise 语义（第三成员加入/多端 fan-in 收敛为后续 change 义务）[W8]。**push/对象传输 MUST 含 commit DAG parent 闭包**；ref 更新 MUST 带 expectedOldRef 做 compare-and-swap（不匹配=拒绝并提示重新 fetch/merge，无 last-write-wins）；每 repo 同时 MUST 只有一个本地 merge/ref writer。对象落盘前 MUST 校验类型+长度+OID（传输 EOF 不得作为完整性证据）；传输先入 staging，取消/校验失败 MUST NOT 移动 ref。冲突 MUST 分级：UTF-8 文本重叠区=hunk 级（逐块选 ours/theirs 或编辑；ours/theirs 按 endpointId 稳定排序）；binary/超限/非 UTF-8/delete-modify/type/mode=文件级选择。冲突记录 MUST 持久化 base/ours/theirs OID+diff3 算法版本+用户决议（两端可复现）；merge driver 钩子 MUST 预留（结构化 a/b/o hunk 输入；AI merge 为未来 driver，v1 不自动写回）。单向同步=只读镜像（fetch+fast-forward 跟随）；双向=fetch+merge+push。[W9] 首次建组 MUST 由 UI 显式选择 seed authority，对端首拉前工作树非空 MUST 阻断并给三方对照（不自动合并不覆盖）。调度=会话在线事件+间隔兜底（默认 30s）+本地变更 debounce 2s；预算 MUST 强制（单 blob ≤16MiB、单次对象 ≤5000、单次传输 ≤256MiB、并发流 ≤2/组，超限明示拒绝）。

#### Scenario: 单向跟随（A 改 B 跟）

- **WHEN** 单向同步组内 A 机修改 agents-skills 下文件并提交，B 机会话在线
- **THEN** B 机在触发窗口内收到变更并 fast-forward 跟随（工作树与 OID 收敛）；B 侧本地改动不回传

#### Scenario: 非重叠双向自动合并

- **WHEN** A/B 同时（离线各自）修改同一文件的不同区域后互连
- **THEN** 双方各自动 fetch+diff3 合并+push，两端收敛到同一合并 commit；历史含双方设备身份（author=设备 endpoint 缩写+机器名）

#### Scenario: 重叠冲突的决议闭环

- **WHEN** A/B 修改同一文件同一区域
- **THEN** 双向同步进入 conflicted 态并阻断 push；UI 呈现 hunk 级 a/b/o 三方对照，用户逐块选择或编辑后完成决议 commit 并 push；对端 pull 后两端 OID 与工作树一致；冲突记录含算法版本与决议可复现

#### Scenario: 并发 push 的 CAS 拒绝与恢复

- **WHEN** A/B 同时基于同一旧 ref push 各自合并结果
- **THEN** 后到者 CAS 拒绝（零破坏），提示重新 fetch/merge；重试后收敛；无任何 last-write-wins 丢失

#### Scenario: 闭包缺失拒绝（r2-B7）

- **WHEN** push 的对象集缺少任一 parent commit、树或 blob（闭包不全）
- **THEN** 整个 push 拒绝并返回缺项清单；对端 ref 零变化；本端零副作用

#### Scenario: 显式中止与 staging 回收（r2-B7）

- **WHEN** 对象传输/合并进行中用户显式中止或会话断开
- **THEN** ref 与工作树零变化；staging 目录经 TTL 回收；后续同步从头幂等重算（无残留部分状态）

#### Scenario: type 与 mode 冲突的文件级决议（r2-B7）

- **WHEN** 双向同步中一端把路径从文件改为目录（或改变可执行位等 mode），另一端修改了原文件内容
- **THEN** 判为文件级冲突进入 conflicted 态（不做 hunk 合并）；UI 呈现两版本整文件选择（保留目录/保留文件内容），决议后收敛

#### Scenario: 超限对象拒绝（r2-B7）

- **WHEN** 同步根中出现 >16MiB 的单 blob
- **THEN** 该对象传输被拒绝并明示（含分批/排除建议）；ref 零变化；其余小对象同步不受影响

#### Scenario: 崩溃边界注入与确定性 roll-forward（r2-B3）

- **WHEN** 分别在 intent prepare 之后、工作树物化进行中、ref 推进之后、done 标记写入之前四个边界杀死进程，随后重启
- **THEN** 每个边界下恢复协议唯一执行确定性 roll-forward（幂等重放物化+推进）；恢复后文件内容、ref、用户未提交本地改动三者一致且无半成品

#### Scenario: 中断恢复与完整性

- **WHEN** 对象传输/工作树物化中途进程崩溃或会话断开
- **THEN** 按 §7.3.1 协议确定性 roll-forward（intent 日志幂等重放），恢复后文件内容/ref/未提交改动一致；staging 回收；两端最终收敛；任何落盘对象均通过 OID 校验（EOF 不作为完整性证据）

#### Scenario: 首次建组非空对端阻断

- **WHEN** 建组时选 A 为 seed authority，B 机同步根下已有不同内容
- **THEN** B 首拉被阻断并展示三方对照（A 内容/B 现状/空基线），由用户显式处置（采纳 A/放弃 B 内容）后才继续；不自动合并不静默覆盖
