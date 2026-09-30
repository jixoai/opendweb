# webui-plugin-kernel 终验 r8

## 核对边界

本轮基于 HEAD `8de7e8a` 只读核对 design v2、四轮至七轮双机验收记录、spec delta、核心 Rust/JS 实现与测试代码；未停止或干扰正在运行的双机进程。`fabric 316/0`、`ext-sync 61/61`、`webui 259/259`、`ext-files 53/53`、`ext-ports 35/35`、`client-sdk 96/96`、strict、双机矩阵 4/4 均视为既有验收回执，本轮未独立重跑 fabric 全量门禁。独立运行了 `node --test packages/opendweb-ext-sync/test/endpoint.test.mjs packages/opendweb-ext-sync/test/sync.test.mjs`，27/27 通过。

## 阻塞问题

### B4/F2：设计包络仍超过实际 transport 包络

**判定：未闭合，阻塞 archive。** transport 的事实是 `session.rs:19` 的 `MAX_FRAME=1MiB`，`continuity/model.rs:296-303` 的 journal 单流 2MiB、会话累计 8MiB；`fetch_http`（`continuity/http.rs:317-337`）仍接收静态 `Array<Uint8Array>`，逐 chunk 作为发送单元，没有流式请求体 ABI。第六、七批实测也记录了 >1MiB 帧失败、>2MiB 流失败、>8MiB 会话失败，以及超限历史导致后续 push 闭包持续失败。

当前规范和实现仍互相矛盾：

- design §4（约 117-123 行）及 ports delta 仍是默认 8MiB、配置域 1-64MiB；`packages/opendweb-ext-ports/src/proxy.mjs:29-32` 仍为 8MiB/1-64MiB。
- files 默认 4MiB；design §4 约 118-119 行、files delta 第 7 行、`packages/opendweb-ext-files/src/client.mjs:16-17`、`staging.mjs:26-27` 和 runtime 默认值均保持 4MiB。真双机只有 1MiB chunk 可稳定通过。
- sync 仍声明单 blob 16MiB、单次传输 256MiB；`packages/opendweb-ext-sync/src/endpoint.mjs:46-57` 保持这些值，`engine.mjs:309-334` 将整个 parent/tree/blob closure 拼成一个 `Buffer` 后单次静态 POST。它既可能超过帧/流/会话账，也没有分批实现。
- `commitLocal`（`engine.mjs:159-181`）扫描、写 tree、写 commit 时没有本地 blob 上限预检；超限 blob 可以先进入 device history，直到远端 GET/push 才在 `endpoint.mjs:181-182`、`262-265` 被拒绝，形成已实证的历史毒化。

**裁定：amend 方案③，但必须作为可实现的 v1 修订落地，不是只在文档写“取最小值”。** v1 有效包络冻结为 `min(插件预算, transport 实况)`：静态请求 chunk/frame ≤1MiB；files 默认及有效硬上限收窄到 1MiB；ports 默认收窄到 1MiB，并修改 W7 的 1-64MiB 文字，避免允许一个必然失败的配置；sync 新入历史 blob ≤1MiB，pack/流式请求 ABI 后置。sync push 还必须实现可工作的分批/逐对象协议，或明确把 v1 可提交 closure 收窄到 transport 可容纳的范围并补相应拒绝语义；继续一次性发送任意 closure 不合格。

**毒化历史策略：端点和本地提交前都拒绝。** `commitLocal` 在写入 device ref 前扫描并返回稳定的 `oversize-history`/迁移提示；远端端点仍做同一上限的原子拒绝。已有超限历史不自动重写、不静默删除，返回迁移提示，由用户显式 reset/re-seed/history rewrite；不含该历史的独立 root 继续可用。补一组 transport 分层替身测试，真实建立 1MiB 帧、2MiB 流、8MiB 会话账，避免单机 loopback 绕过此类失败。

### B5：活跃会话 TERM 闩锁的发布边界未决

**判定：条件阻塞。** B2 的 Fabric drain 已正确使用单一全局 5 秒 deadline，`abort_join_bounded`、`incomplete-drain` 和全阻塞注入均已闭合；但第七批仍记录“有活跃 fabric 会话时 TERM 后 Node 句柄不退出”，主线程停在 `kevent`。若 archive/发布目标包含 sidecar 的优雅退出和可重启性，这一项必须修复并加入真实进程退出门；若本 change 只归档插件内核且 Owner 明确把进程句柄问题转为独立 runtime change，则可带豁免归档，不能把 B2 的 drain 绿门当作已解决。

## 已验收闭合项

- **B1/W12：闭合。** Fabric/SDK 缺省 `RelayConfig::Disabled`；invite 与 learned/known_addrs relay URL 在 direct-only 数据面剥离，学习源头不再持久化 relay；WebUI 租约管理面与数据面解耦；root 的 relay 能力步骤只在显式 relay 模式执行。第七批双机静置 10 分钟 3/3×200、join 路由 0.45s 及零 relay 接触回执与代码一致。
- **B2：语义闭合。** shutdown 从 drain 入口起算单一 5 秒 deadline，endpoint、accept、inflight、detached、child 共用 `timeout_at`；超时确定性 abort、有界 join，并返回稳定 `incomplete-drain`。实现和注入测试覆盖此前的阶段预算叠加风险。
- **B3：语义闭合。** sync push 使用 `readBoundedJsonLines` 流式读取并在解析后、进入 mutex、commit point 三处裁决取消；push/GET object 共用组级 ≤2 流预算；对象逐个写真实 staging、闭包复验后才进入原子 loose import；崩溃现场保留并由 TTL 回收。F2 是其静态 transport 包络问题，不否定取消/线性化语义。
- **真双机主体：大部分闭合。** 第五批 ports SSE/中途断开、files Range/md5/越权；第六批 agents-skills 矩阵与 F6 目录树数据丢失修复；第七批 E1′ 六层互锁、known_addrs 分治/修剪、双向恢复及 #2/#3/#4/#9 4/4 复放均有记录。这里的数字是 supplied receipt，不是本轮独立复跑。

## 遗留项处置

| 项目 | 归档前判定 | 依据与要求 |
|---|---|---|
| E1′-① sidecar 进程内间歇拨号停滞 | 可后置 | 层 5/6 修复后不再阻塞第七批数据面，仍有一例同 NodeAddr 新握手抑制未根治。必须单列 issue/change，保留复现条件和“未宣称根治”边界。 |
| F3 建组 UI id 输入框 | 可后置 | 管理面已透传 id，残留为 cosmetic UI 债，不影响协议或双机收敛。 |
| 活跃会话 TERM 闩锁 | 见 B5 | 若发布要求优雅退出，归档前修复；否则 Owner 明示豁免并建立独立 runtime change。 |
| mini mihomo conntrack UDP 黑洞、iMac TUN 误开 | 可后置 | 环境级，walkthrough 已有处置说明；不得作为产品机制已修复的证据。 |

## 质量评价与评分

实现质量从 r7 的 7.0/10 提升到 **8.4/10**：W12 direct-only、全局 shutdown deadline、流式取消/持久 staging、E1′ 六层恢复和真实双机矩阵均显著提高了正确性，且第五至七批抓出的 F1/F5/F6/F7 等真实缺陷有对应修复和回归证据。未达到预期 9/10 的原因是 F2 不是测试欠缺而是规范、客户端默认值、服务端上限和 transport wire 形态同时不一致；它会让默认上传/同步在真实网络上确定性失败，并可把超限 blob 毒化进历史。B5 的 TERM 句柄也仍缺发布边界裁决。

## 结论

**NOT-READY。** 最小闭合清单：

1. 在 design、ports/files/sync delta 和实现中统一 1MiB transport 有效包络；ports W7、files chunk、sync object/closure 预算必须同步修改。
2. 为 sync 实现可工作的分批/逐对象 push（或严格收窄并验证 closure 包络），并在 `commitLocal` 入 device history 前拒绝超限 blob；为已有毒化历史定义稳定检测和显式迁移路径。
3. 增加帧/流/会话账的分层 transport 替身测试，并补一次真双机大于 1MiB 边界后的完整回归。
4. 明确 TERM 闩锁是本 change 的归档前修复，或由 Owner 记录豁免并转独立 runtime change。

完成以上最小清单后，既有 W12/B2/B3 和双机主体可支撑进入 archive/收官流程。
