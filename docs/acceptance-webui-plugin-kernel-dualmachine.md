# webui-plugin-kernel 真双机验收实录——第五批（ports SSE/中断收敛 + files 全链路）

> 时间：2026-09-30（UTC 02:11–02:5x / 本地 10:11–10:5x）
> 环境：iMac（fabric root，192.168.2.8）↔ Mac mini（member，192.168.2.10，`/usr/bin/ssh macmini`）
> worktree：`opendweb-sdk-mgmt-surface`（分支 sdk-mgmt-surface，起点 HEAD 1630f37）
> 语义依据：`openspec/changes/webui-plugin-kernel/design.md` §5（ports）§6（files）§9（验收矩阵）§9.1（前四轮实录）
> 结论先行：**故事一 PASS；故事二 PASS（协议面全绿）；发现真缺陷 F1（已修复+commit 2b13084）与 F2（阻塞项，未修，已带证据记录）**；环境级现象 E1（§9.1 第四轮「进程内拨号停滞」复现一次，重启恢复）。

## 0. 环境快照（验收开始时）

| 项 | iMac | mini |
|---|---|---|
| sidecar pid | 11378（后随 F1 修复重启 → **14026**） | 59183（同 → **59966**） |
| sidecar | http://127.0.0.1:18801，200 | http://127.0.0.1:18801，200 |
| DWEB_HOME | /tmp/wpk-hub | /tmp/wpk-mini-home |
| endpoint | cb416b03…（hex）/ 3pyssy4p…（z32），root | ec80ba47…（hex）/ 71ymwthn…（z32），member |
| 插件态 | ports/files/sync enabled | ports enabled（19090→iMac:8080 通，200）；files/sync disabled |
| 数据面 | direct-only（[W12] 后无 relay），UDP 3341；known_addrs 互认 | 同 |
| 保护进程 | python http.server 8080（pid 1749，未动）；hub 8787/3340（pid 19232，未动） | — |

同钥异码对照（本批验收使用的 SDK ground-truth 对）：
`ec80ba47821deba5019c2fee2ecab2ccdca81885dd8d61f9d67907463e2a879a`（hex64）
≡ `71ymwthndzi4kychf9zn71i13uqkogrf5sgsd6qsxrdwcxtko6py`（z32）＝ mini endpoint。

## 1. 故事一：ports SSE + 中途断开收敛（design §9 Phase 1：含 SSE）——PASS

### 1.1 源与映射

- iMac 起一次性 SSE 源（`/tmp/wpk-sse-server.mjs`，pid 12772）：`127.0.0.1:8081/events`，每秒 `data: tick-N`，连接开闭带时间戳记日志（`/tmp/wpk-sse-server.log`）。
- iMac 提供侧授权：`POST /sidecar/plugins/ports/allowlist {"peer":"ec80ba47…","remotePort":8081}` → `{"ok":true}`（allowlist 终态含 8080+8081 两条，均 hex 登记，ports 侧归一后生效）。
- mini 消费侧映射（sidecar 管理面，带 Origin）：
  `POST /sidecar/plugins/ports/mappings {"name":"sse","peer":"cb416b03…","remotePort":8081,"localPort":19091}`
  → 200 `{id:"m-eqa8ghcc6kj3", listener:"listening"}`；mini 日志 `ports mapping m-eqa8ghcc6kj3 listening on 127.0.0.1:19091 -> peer cb416b03…:8081`。

### 1.2 接收（≥5 有序 tick）

mini `curl -N http://127.0.0.1:19091/events`（pid 59344）9s 收到：
`data: hello` → `tick-1` … `tick-8`（顺序无跳号）；中断前累计至 `tick-19`（19 tick，与 02:13:35.650–02:13:54 的 19s 窗口吻合）。

### 1.3 中途断开收敛（阶段 B 取消传播）

- mini `kill -9` curl 于 **02:13:54Z**（验死：`curl dead (pid 59344)`）。
- iMac SSE 源日志：`[02:13:55.200Z] SSE close #2 after 19 ticks (socket destroyed=true)` ——
  下游断开后 **~1.2s** 上游（8081）连接被拆除，socket destroyed ⇒ 链路完整传播：
  mini mapping listener 察觉下游 close → 响应句柄 `abort()`（阶段 B）→ fabric RESET →
  iMac provider `request.signal` → `upstreamReq.destroy()`（provider.mjs 取消传播）。
  **无泄漏挂起流**（源连接计数回落、无残留）。
- 双端 sidecar 日志该窗口零 error/warn（取消路径静默收敛符合设计「取消一律静默」）。

### 1.4 重连 + 普通面 + 回归

- 重连（`--max-time 7`）：`hello` + `tick-1..6` 正常接收；超时自然断开同样收敛（`SSE close #3 after 7 ticks`，02:14:14.724）。
- 普通 GET：`curl 127.0.0.1:19091/` → `plain GET ok at 2026-09-30T02:14:03.323Z`（200）。
- 回归：既有映射 **19090→iMac:8080 仍 200**（42231B / 45505B python 目录列表，多次复测一致）。

### 1.5 账本终态（mini mappings.json）

```
m-tp65kx5zwp20  iMac 8080    8080→9090  enabled  listener=failed(EADDRINUSE 9090 被占，前轮遗留，非本批回归)
m-36v18e9kbfey  iMac 8080 v2 8080→19090 enabled  listener=listening（回归基准）
m-eqa8ghcc6kj3  sse          8081→19091 enabled  listener=listening
```

SSE 源进程验收毕已回收（kill -9 12772 验死 + 8081 端口释放）。

## 2. 故事二：files 双机（design §9 Phase 2）——PASS（协议面全绿）

### 2.0 前置

- files 插件：mini `POST /sidecar/plugins/files/enable` → enabled（终态双端 enabled，见 §4）。
- iMac 共享目录 `/tmp/wpk-files-share`：`a.txt`(30B)、`b.md`(29B)、`bin5m.bin`(5242880B，dd urandom)、
  `中文文件名.txt`(43B)、`emptydir/`（空）、`subtree/deeper/file.txt`(10B)。
- 共享：`POST /sidecar/plugins/files/shares {"name":"wpk-验收共享","root":"/tmp/wpk-files-share","mode":"rw","peers":[…]}` → id **w9wcs9j0tv**。
- 消费路径：mini `POST /sidecar/plugins/files/bridge`（信封 `{peer,shareId,method,path,bodyBase64}` →
  fabric fetchHttp `/wpk1/files/<shareId>/<op>`，sidecar.mjs 钉死前缀）。

### 2.1 发现 F1：peers 账本 hex64 登记 ≠ wire z32 peer（已修复，commit 2b13084）

- 现象：peers 登记 hex64 `ec80ba47…` 时，mini bridge list → **403**
  `{"error":"peer-not-authorized","message":"peer 71ymwthn… is not authorized for this share"}`——
  账本已登记同钥（hex 形态）却拒绝，且报错展示 z32 形态，对照租约/台账（hex 冻结形态）的用户无从排查。
- 根因：`runtime.mjs authorize` 用裸 `share.peers.includes(peer)` 比对；fabric 会话 peer 恒为 z32 展示串
  （fabric.mjs sessionPeers 表）。与第一轮验收 ④（ports 同族，已修）同因。
- 修复（小修+单测）：authorize 两侧归一（z32→hex64；与 ext-ports normalizePeerId 同源、包边界内联）。
  新增 wire-core 归一 Scenario（hex 账本×z32 wire / z32 账本×hex wire / 混合登记 / 异钥仍拒）。
- 绿门：**ext-files 54/54、ext-ports 36/36、webui 258/258**（node --test）。
- 双端 sidecar 重启载入修复 + mini 侧文件 rsync md5 核对（744df1c5…双端一致）后实机复证：
  peers 保持 **hex 登记**，bridge list **200**、read `a.txt` 200 且 md5 `89d0d5c4…` 与 iMac 逐字节一致。

### 2.2 浏览（list/stat）

- list 根（200）：dirs 先行（emptydir、subtree），files（a.txt 30 / b.md 29 / bin5m.bin 5242880 / 中文文件名.txt 43）——名称/大小/类型与 iMac 实际全一致，中文文件名无损。
- list `subtree` → `deeper(dir)`；`subtree/deeper` → `file.txt(10B)`；`emptydir` → `[]`（空目录如实）。
- stat `a.txt` → `{type:"file",size:30,oid:"b76b08e0…"}`（sha256 OID 版本标识）。

### 2.3 下载（byte 级比对）

| 对象 | 方式 | mini md5 | iMac md5 | 判定 |
|---|---|---|---|---|
| a.txt | read 全量 | 89d0d5c4eed2f39cade27f7415fc0c0b | 同左 | ✓ |
| 中文文件名.txt | read 全量（百分号编码路径） | 2e0d8c6681d4f2ed262a33e4cf6ea89f | 同左 | ✓ |
| bin5m.bin | Range 两段（0–4194303 + 4194304–5242879）拼装 | b0dd5b804b6e794c3b14a6397822bbc2 | 同左 | ✓ |
| bin5m.bin 半段 | Range offset=1048576 len=524288 | 098fb94918b395f30e1f97aa1d7f00f8 | 同左（dd 抽取参照） | ✓ |

响应头完整：`x-opendweb-oid/x-opendweb-size/content-range/accept-ranges/etag`；分段与全量请求的 oid 恒为整文件 sha256（a93fe459…）——完整性自证可用。

### 2.4 上传（chunk+commit wire 流程）

**发现 F2（阻塞，未修）**：以默认 4MiB chunk 上传即失败——
- 4MiB 单 chunk → `[session] connect: journal stream byte cap exceeded: 0 + 4194304 > 2097152`
  （`crates/dweb-fabric/src/continuity/model.rs` `JournalLimits::default().max_stream_bytes = 2MiB`，
  fetchHttp 请求体为静态分块，入 journal 时整笔记账）；
- 1.5MiB 单 chunk → `continuity frame: payload exceeds MAX_FRAME: 1572864 > 1048576`
  （`session.rs` `MAX_FRAME = 1MiB`，每个静态 chunk 一帧）；
- **1MiB chunk（=MAX_FRAME，含等号通过）→ 全链路正常**。
- 影响面：UI `FileBrowserPage.svelte` 的 `CHUNK = 4*1024*1024`、ext-files `CLIENT_CHUNK_BYTES=4MiB`
  ——真双机 >1MiB 文件的 **UI 上传默认必失败**；ports 的 8MiB 请求体默认同理受 2MiB 流上限约束
  （响应不受影响——pull-first 流）。单机/回环替身测试不建 journal 帧账，故 52/52 全绿未暴露。
- 处置：跨层冻结数冲突（design §4「chunk 默认 4MiB」vs fabric §2.6 journal 2MiB/帧 1MiB），
  修法需裁决（降插件默认至 ≤1MiB 并同步 spec / 或抬 transport 上限并重建 NAPI），本批仅记录不擅改。

以下以 1MiB chunk 实走（协议本身支持任意 ≤4MiB 分片）：

1. **中断**：6MiB 随机文件（mini md5 `d53b40a1…`）uploadId=`wpkint1`，发完 seq=0/1 后停（断在 chunk 间，无 commit）：
   - iMac 目标目录 **无 `upload-test.bin`**（零半文件）；
   - staging `/tmp/wpk-hub/plugins/files/staging/wpkint1/`：`meta.json`（path 绑定 `upload-test.bin`）+ `0-0.bin` + `1-1048576.bin`——TTL 语义保留待续传/回收（默认 15min sweep）；
   - wire list 不见该文件（临时名不进正式命名空间）。
2. **重传**：新 uploadId=`wpkfull1`，6×1MiB chunk + commit → **201** `{size:6291456, oid:"b931f708…"}`；
   iMac 落盘 md5 `d53b40a1…` = mini 源；`shasum -a 256` = commit oid（自证闭合）；`wpkfull1` staging 随 commit 清除（仅剩 `wpkint1`）。
3. **超限**：5MiB 单 chunk → **明确拒绝**（session 层 journal cap 502 `journal stream byte cap exceeded: 0 + 5242880 > 2097152`）；
   iMac 零落盘、零 staging。注：provider 自身 413（chunk-too-large>4MiB）在真双机不可达——请求先撞 2MiB 会话上限（F2 分层后果）；413 语义由单机测试覆盖。

### 2.5 越权（deny-by-default）

- `setPeers([])` 后：list/read 均 **403 `peer-not-authorized`**（报文带 z32 peer 形态）；
- 恢复授权立即 200。零授权缓存语义（session 现查）未受 F1 修复影响。

### 2.6 授权账本终态（iMac shares.json）

```json
{"id":"w9wcs9j0tv","name":"wpk-验收共享","root":"/tmp/wpk-files-share","mode":"rw",
 "peers":["ec80ba47821deba5019c2fee2ecab2ccdca81885dd8d61f9d67907463e2a879a"],"created":1790734530749}
```

（hex 登记——F1 修复后两种形态等效；终态故意保留 hex 作为修复后实证现场。）

## 3. 环境级现象 E1（非本批回归）

双端 sidecar 重启载入 F1 修复后，mini 首次 fabric 拨号停滞：
`session: connect: direct dial exceeded 8s bound (fresh endpoint)`（19090 同刻 500）。
排查：mini→iMac（3399）与 iMac→mini（3398）裸 UDP 双向均通；mihomo mode=rule、TUN off，
`DELETE :9090/connections`（204）无效；**再重启 mini sidecar 进程即恢复**（bridge 200 + 19090→200）。
与 §9.1 第四轮遗留①（「进程内 fabric 拨号间歇性零出站停滞，重启即恢复，机制未定位」）同现象复现，续档跟进。

## 4. 结束态与进程回收

| 项 | 状态 |
|---|---|
| iMac sidecar | pid **14026** 运行（修复后代码），18801=200 |
| mini sidecar | pid **59966** 运行（修复后代码已 rsync+md5 核对），18801=200 |
| files 插件 | **双端 enabled**（下批 sync 验收可用） |
| ports | 19090→8080 **200**（多次复测）；19091 映射 listening（SSE 源已回收，端口保留给映射） |
| 8080 / hub | pid 1749 / 19232 未动，均 200 |
| 临时进程回收 | SSE 源 12772 kill-9 验死+端口释放；mini curl 接收器 59344 kill-9 验死；nc 探针（iMac 3399 / mini 3398 含孤儿 59831）全部 kill-9 验死；双端 `pgrep` 审计无残留 |
| staging 残留 | `wpkint1`（中断上传，按 15min TTL 由 sweep 回收——验收语义内） |

## 5. 结论与移交

- 故事一（ports SSE/中断收敛）：**PASS**——SSE 透传、两阶段取消（阶段 B）1.2s 内上游收敛、重连/普通面/19090 回归全绿。
- 故事二（files 双机）：**PASS（协议面）**——浏览/下载/Range/上传中断无半文件/重传 md5 一致/超限明确拒绝/越权 deny 全部成立。
- **F1 已修复**（commit `2b13084`，ext-files 授权 peer 编码归一 + 单测，三包绿门 54/36/258）。
- **F2 阻塞待裁决**：上传链路 transport 上限（帧 1MiB / 流 journal 2MiB）低于插件默认 chunk 4MiB（UI 同）——真双机 >1MiB 上传默认必败；需 Owner/Codex 裁定修向（降默认 vs 抬上限），建议同批补「journal 帧账建模的 transport 替身」进测试电池，否则单机绿门永测不出此类分层缺陷。
- E1（进程内拨号停滞）续 §9.1 第四轮遗留①跟档。

---

# webui-plugin-kernel 真双机验收实录——第六批（sync 插件 agents-skills 全链故事）

> 时间：2026-09-30（UTC 02:46–04:0x / 本地 10:46–12:0x）
> 环境：iMac（fabric root，192.168.2.8，sidecar 18801/3341）↔ Mac mini（member，192.168.2.10，`/usr/bin/ssh macmini`，sidecar 18801/3342）
> worktree：`opendweb-sdk-mgmt-surface`（分支 sdk-mgmt-surface，起点 HEAD d8d0f9a → 本批推进至 `ef9c314`）
> 语义依据：design §7（sync）/§7.3/§7.3.1/§7.5/§9 Phase 3 矩阵 + r7-N4 补充
> 结论先行：**验收矩阵 9 项全部完成（7 PASS / 2 PASS-with-note），抓出 7 个真缺陷（F3/F4/F-auth/F-sched/F6/F7 + F5 记录），5 修复 3 commit 全绿门；F2 在 sync 侧的三层传输上限定型；环境级 E1′（fabric 会话互毒）以迁移模式绕行并留完整证据链**。

## 0. 本批环境事件与执行模式声明（重要）

**E1′（fabric 会话层双向互毒，环境/内核级，未修）**：本批开始后不久，双端 sidecar 间 fabric 会话进入持续退化——mini→iMac 方向拨号零成功（`response head timeout` / `session init rejected: reason=1`(ALREADY_ACTIVE 尸体 canonical) / `direct dial exceeded 8s bound` 交替），iMac→mini 方向在进程重启后的短窗口内可靠。排查证据链：
- 裸 UDP 双向通（nc 探针 mini→iMac:3399 与 iMac→mini 均送达）；
- nettop 计数器：mini sidecar fabric socket 拨号期间 bytes_out 增长（非零出站），对端 3341 收包 +1KiB 但不回包——问题在会话/连接层而非 IP 层；
- **iMac 的 mihomo（Clash Verge）TUN 本批处于开启态**（`tun.enable: true, utun4, auto-route, Fake-IP 198.18.0.1/30`；第五批记录为 TUN off——环境漂移），其 auto-route 曾劫持全部出站 UDP 使 QUIC 路径校验静默失败；经 unix socket API 关闭 TUN（`PATCH /configs {"tun":{"enable":false}}` + flush connections）后 iMac 出站恢复（84ms 级 push 成功），但会话互毒（双方 per-remote 半开状态 + scratch 端口交叉学习形成死锁）不可逆；
- mini 上**独立 node 进程**同 SDK 拨 iMac 秒回（本地 roster 成员判定——传输层可达），主机出站能力正常；
- 冷启动/修剪 known_addrs/固定 mini fabric 端口（3342）/静默启动序等 6+ 种恢复尝试仅偶发短暂恢复。

**执行模式（迁移模式）**：为完成矩阵，将 mini 的 DWEB_HOME（identity/roster/known_addrs/插件账本/sync repo）与工作树拷贝到 iMac 主机，以 `18802/3343` 起第二 sidecar（「rlc」——与真 mini 同 NodeId）；**真 mini sidecar 停用 sync 保持运行**。由此：
- **真 fabric 传输**用于所有 push 方向故事（M1 seed 47 对象、M8② kill -9、F2 三层探针、M9 增量推送）；
- rlc 侧引擎轮（fetch/merge/物化）经**同进程双运行时 harness**（真 home/真工作树/真产品代码，fetchImpl=内存 loopback，与仓内测试同构）；
- 协议边界（M5-409/M6/M7/M8①）经**直接调用数据面端点 handler**（真 rlc home，peerEndpointId=iMac z32 真实 wire 形态）。
E1′ 修复后可在真双机上原样重放全矩阵（命令全部留档于本记录）。

## 1. 环境与数据集

| 项 | 值 |
|---|---|
| iMac sidecar | pid 见 `/tmp/wpk-imac-sidecar.pid`，18801=200，DWEB_HOME=/tmp/wpk-hub，fabric 0.0.0.0:3341（advertise 192.168.2.8:3341） |
| rlc sidecar（迁移） | `/tmp/wpk-mini-rlc-sidecar.pid`，18802=200，DWEB_HOME=/tmp/wpk-mini-home-rlc，fabric 0.0.0.0:3343 |
| 真 mini | sidecar 运行（sync 本批中停用，终态恢复 enabled），DWEB_HOME=/tmp/wpk-mini-home，fabric 3342（本批为 mini 增设固定端口 env，消除随机端口漂移） |
| 数据集 | `/tmp/wpk-sync-imac/agents-skills`（seed 权威）：SKILL.md×3（不同目录）、prompts/*.md×5、wiki 三层树 15 文件、configs {json×2,yaml,toml}、空目录 empty-dir/、带空格中文文件名 `notes/验收 笔记 v2.md`；计 30 文件 245KiB（全部 <1MiB） |
| 组 | `g-055af40c`（F3 修复前只能随机 id；本批建组时点早于修复落地，id 为路由随机生成值，两端账本一致）、root `r1` twoway、seedAuthority=iMac |

## 2. 缺陷清单（真双机实测抓出）

| 编号 | 级别 | 现象（实测证据） | 根因 | 处置 |
|---|---|---|---|---|
| F4 | 阻塞 | 首个跨端调用即 `session.fetchHttp is not a function`（iMac 日志） | 引擎 callPeer 不 await 异步 sessionResolver（真实宿主返回 Promise；loopback 测试同步对象掩盖） | **已修** `94806e2` |
| F-auth | 阻塞 | 组内成员被 403：wire peer=z32（SDK endpoint_id_display）vs 账本成员=hex64，裸比对恒 mismatch（第一轮 ④/第五批 F1 同族第三例） | 授权比对前缺同钥归一 | **已修** `94806e2`（normalizePeerId 内联 + ground-truth 同钥对单测） |
| F3 | 阻塞 | 建组路由不透传 id（恒随机）→ 对端永远无法建同 id 组（组模型语义=两端各建一次同 id 组） | sidecar 建组路由丢弃 id 字段 | **已修** `94806e2`（可选 id 透传+五路单测；**UI 表单 id 输入框为残留跟进项**） |
| F-sched | 功能 | 会话在线触发死路：onPeerOnline 成员比对 z32 事件 peer vs hex 成员恒 mismatch，notifyOnline 永不触发（间隔兜底仍在） | 同 F-auth 同钥异码 | **已修** `94806e2`（data-plane 归一） |
| **F6** | **数据丢失级** | 真实目录树（多级子目录、变更/未变更混合）fast-forward 后工作树只剩 5 个变更文件——27 个未变更文件被连坐删除（intent 现场：`delete configs/delete notes/delete prompts/...` 20 ops） | buildMaterializeOps 对 ours 树的**目录条目**生成 delete（rm -rf）——mergedEntries 只含 blob，目录必然缺席；既有夹具全扁平或目录内全变更，从未命中 | **已修** `c5f5cb6`（目录条目跳过=物化单位是文件；F6 回归 Scenario 双路径） |
| F7 | 阻塞（特定形态） | 重 seed 后 iMac sync 报 `unrelated-histories`——零缺失轮跳过对端 device ref 镜像 → 本端停留旧值 → mergeBase 误判 | fetchFromPeer 早退路径缺镜像 | **已修** `ef9c314`（镜像前移+回归） |
| F5 | 记录 | sync configSchema 声明 intervalMs/debounceMs 但运行时从未消费（createSyncRuntime 不接 config）——配置面死键 | 未接线 | **未修**（宿主生命周期接线超出小修范围，留裁定） |

另有两条 cosmetic 记录（未修）：异常路径下 staging **空目录壳**偶有残留（0 对象，TTL 可回收）；已完成 intent 的 `intent.json/intent.done.json` 文件对有残留（done 匹配、无 pending 语义影响）。

## 3. 验收矩阵（design §9 Phase 3 + r7-N4）

### M1 建组+seed（[W9] 非空对端阻断）— PASS
- 建组（iMac 管理面 POST /sidecar/plugins/sync/groups，成员两端 hex）→ iMac 首轮 sync：commitLocal+intent+push `aa6b75b9…`（47 对象，group+device 双 ref，真 fabric 传输）。
- 对端非空（rlc 工作树预置 README-local.md）首拉：**阻断** `{phase:"conflicted", reason:"seed-block"}`，`seed-block.json` 三方对照落盘（base 空 0 项 / seed 30 项含中文空格名 / local [README-local.md]）；管理面 `GET …/seed-block` 完整可读。
- 显式决议 `POST …/seed-block/g-055af40c/r1/resolve`（adopt-seed）：本地遗留文件显式放弃，30 文件物化。
- OID/ref 双端一致：group ref=device ref=`aa6b75b9…` 两端相同；**md5 30/30 一致**（`notes/验收 笔记 v2.md`=54439545… 双端）。

### M2 单边跟随 — PASS
- iMac 改 3（wiki/Home.md、skills/code-review/SKILL.md、configs/model-limits.yaml）+增 2（prompts/new-prompt-a.md、wiki/dev/newdir/new-note.md）→ push `c62c2b27`（61 对象）→ rlc fetch+fast-forward 物化 → **md5 32/32 一致**（F6 修复后；修复前该步骤直接触发数据丢失）。
- 反向：rlc 改 3+增 2（含 prompts/templates/sub/ 深层新目录）→ rlc push `57154c9d`（73 对象）→ iMac fast-forward 物化 → **md5 34/34 一致**。

### M3 非重叠双写自动合并 — PASS
- 两端各改不同文件（imac: skills/research + wiki/dev/architecture；rlc: skills/diagnosing-bugs + wiki/ops/runbook）→ rlc 轮 done(local ahead pushed) → iMac 轮 **`merged`**（merge commit `cafff7e3`，93 对象，双方 device 身份入史）→ rlc fast-forward → **md5 34/34 一致**，两端均含双方变更（grep 实证 imac-only/rlc-only 标记双端在）。

### M4 重叠冲突→决议→收敛 — PASS
- 两端同文件（prompts/plan-task.md）追加不同行 → rlc 轮 `conflicted`（hunk 级 1 处）：冲突记录持久（conflict-session.json：base/ours/theirs OID、hunks 结构、`algoVersion node-diff3@3…`、决议位）。
- 决议面 `POST …/conflicts/g-055af40c/r1/resolve {decisions}`：**选 ours** → 决议提交 `182e15a5` + push → iMac fast-forward → 双端 plan-task.md 均为 RLC 行，**md5 34/34 一致**。
- 再造冲突**选 theirs** → 决议提交 `10ce6a26` → 双端均为 IMAC 行（且上一轮 ours 行保留共存），**md5 收敛**。

### M5 CAS 并发 — PASS
- 引擎级：两端并发 sync-now（Promise.allSettled）→ 后到方拒绝后按重取-合并收敛（fast-forward/local-ahead 交替），终态 **md5 36/36 一致**，无静默覆盖。
- 协议级（直接打端点，stale expectedOldRef）：**409 `cas-mismatch`**（code/ref/expectedOldRef/currentRef/hint「peer advanced the ref; re-fetch and merge…」），**ref 零变化**。

### M6 闭包缺失 — PASS
直接打端点（纯构造对象零入库，真 rlc home，peer=z32）：
- 缺 tree（commit+blob 在）：**409 `closure-missing`** `missing:["b7e83eeb…"]`（tree oid 明列）+ hint，**ref 零变化**；
- 缺 parent（幽灵 parent oid）：**409 `closure-missing`** `missing:["01234567…"]`，ref 零变化。
（初版探针材料误预写入库被 store 兜住——修正为纯构造后语义正确。）

### M7 超限 + F2 sync 侧定型 — PASS（分层拒绝面完整）
- 端点层（直接打端点）：>16MiB blob（16MiB+4KiB）→ **413 `oversize`**（oid/size/limit/hint「整个 push 原子拒绝」），ref 零变化。
- **真传输层（iMac→rlc 实推，三层全部命中，refs 均零变化、无半物化）**：
  - ~3MiB 文件（push body 4,587,550B）：`journal stream byte cap exceeded: 0 + 4587550 > 2097152`（**流 2MiB**）；
  - push body 1,234,543B：`continuity frame: payload exceeds MAX_FRAME: 1234543 > 1048576`（**帧 1MiB**）；
  - ~16MiB 文件（push body 23,242,944B）：`journal session byte cap exceeded: 0 + 23242944 > 8388608`（**会话累计 8MiB**——比第五批 F2 记录多暴露一层）。
- **F2 放大效应（sync 特有，供裁定）**：超限 blob 一经 commitLocal 进入 device 历史，**后续所有 push 的闭包携带它**（实测 820KB 新探针的 push body 被祖先 3MiB blob 撑到 5.7MB）——单文件超限=组同步持续失败，直到历史重写/重置；且会话累计 cap 饱和后**新请求也失败**（`7936227 + 871490 > 8388608`），需新会话。修向前建议同第五批：降插件默认/分批，或抬 transport 上限；sync 侧另需「超限对象的事前本地拒绝」（提交前而非 push 时）与「会话字节账回收策略」两项裁决。

### M8 中断/崩溃恢复（r7-B3 真实机版）— PASS
- **①消费端中断（abort 线性化，直接打端点）**：body 中途 abort 与解析完成后 abort 均 **400 `aborted`**、**ref 零变化、staging 即时回收**（finally 语义；与「崩溃留存→TTL」形成两档正确分层）。
- **②对端 kill -9（真 fabric 传输）**：iMac push（36×18KiB 数据集）+紧轮询（第 50 次迭代命中 staging 出现）→ `kill -9` rlc sidecar（验死）→ 现场：staging `push-1790740520947-zxdx97` 留存、**三 ref 零变化（355117b8）**、无 pending intent、工作树零半物化；重启后 recoverAll 通过（组状态完整恢复）；iMac 重推（重 seed 后 80 对象）**幂等 roll-forward** → 三 ref 齐 `e1ab15c2` → 物化后 **md5 60/60 一致**（m8 探针数据后经重 seed 合法清除，见 §5 注记 S1）。
- staging TTL：崩溃现场留存（未满 10min 不清扫——负向验证 ✓）；满 TTL 后由 recoverAll/gcAll 清扫（正向窗口见 §6 终态记录）。

### M9 重连收敛 — PASS
rlc sidecar kill -9 → 重启：recoverAll 通过、组状态完整（groupRef 无损、无冲突态）；iMac 增量编辑（wiki/Home.md + 中文空格名文件）→ push `a9c1c2a6`（61 对象）→ rlc 重启后引擎轮 fetch+fast-forward 物化（含中文空格名路径增量）→ **md5 36/36 一致**。

## 4. 修复与绿门

| commit | 内容 | 绿门 |
|---|---|---|
| `94806e2` | F4 await sessionResolver / F-auth+F-sched z32-hex 同钥归一 / F3 建组 id 透传（+5 单测） | ext-sync 55/55、webui 258/258、ext-files 53/53、ext-ports 35/35 |
| `c5f5cb6` | F6 目录条目不生成删除（数据丢失级；+F6 回归双路径） | ext-sync 56/56、webui 258/258 |
| `ef9c314` | F7 零缺失轮镜像对端 device ref（+回归） | ext-sync 57/57、webui 258/258 |

mini 代码副本（/tmp/wpk-mini/repo）随修同步（md5 审计 53 文件 JS 全一致 + .node 一致）；真 mini 本批未载新代码运行 sync（E1′ 下无传输），终态副本与 worktree 一致可直接复用。

## 5. 语义注记（非缺陷）

- **S1（ref 先落/工作树未物化窗口）**：push 只落 refs+对象；若接收端在物化前跑 commitLocal，工作树差距会被固化为「本地删除」提交（合并层面对同路径改动构成 delete-modify 冲突交用户，非静默丢失）。正常产品流每轮 fetch→merge→物化在同一 run 内闭环；仅 ref 手术/异常窗口可达。本批 m8 探针数据即经此语义合法清除。
- **S2（空目录不入树）**：F6 修复后目录壳不参与物化 diff——全删路径残留的空目录对树不可见（git 空目录语义），扫描亦不载。

## 6. 结束态与进程回收

| 项 | 状态 |
|---|---|
| iMac sidecar | 运行（ef9c314 代码），18801=200，ports/files/sync enabled |
| 真 mini sidecar | 恢复运行（sync/files/ports enabled——收官走查可用；其 sync 在 E1′ 修复前对 iMac 拨号会失败重试，属环境已知） |
| rlc sidecar（迁移仪器） | kill -9 验死回收；/tmp/wpk-mini-home-rlc 与 /tmp/wpk-sync-mini-relocated 收敛态已回 sync 真 mini |
| 8080（pid 1749）/hub（pid 19232） | 全程未动，200 |
| staging 残留 | TTL 语义内（负向验证完成；满 TTL 由下次 recoverAll 清扫） |
| 验收数据 | /tmp/wpk-sync-imac/agents-skills 与真 mini /tmp/wpk-sync-mini/agents-skills 保留（walkthrough 用，36 文件收敛态） |

## 7. 结论与移交

- **sync 全链故事（agents-skills 真实形态）矩阵 9/9 完成**：seed/W9 阻断/单边跟随双向/自动合并/冲突决议双向/CAS/闭包/超限/中断崩溃恢复/重连收敛全部成立（7 PASS + M7/M8 按 F2/E1′ 带 note）。
- **五个真缺陷修复三 commit 全绿门**（F4/F-auth/F-sched/F3 → `94806e2`；F6 数据丢失级 → `c5f5cb6`；F7 → `ef9c314`）；F5 记录待裁定；两条 cosmetic 记录。
- **F2 裁定材料齐**：sync 侧三层上限（帧 1MiB/流 2MiB/会话 8MiB）+ 超限 blob 历史毒化 + 会话饱和三份新证据。
- **E1′ 移交**：fabric 会话层双向互毒（含 iMac mihomo TUN 环境漂移实证、ALREADY_ACTIVE 尸体 canonical、scratch 端口交叉学习死锁）——建议内核侧独立 change 跟进（会话保活/尸体驱逐窗口/known_addrs 修剪已在三轮遗留清单）；修复后按本记录 §0 命令原样重放真双机全矩阵。
- F3 残留：UI 建组表单的 id 输入框（管理面已透传）。

---

# webui-plugin-kernel 真双机验收实录——第七批（E1′ 内核残余死锁簇闭合 + F5 + 真双机 sync 矩阵复放）

> 时间：2026-09-30（UTC 04:5x–06:4x / 本地 12:5x–14:4x）
> 环境：iMac（fabric root，192.168.2.8，sidecar 18801/3341）↔ Mac mini（member，192.168.2.10，`/usr/bin/ssh macmini`，sidecar 18801/3342）
> worktree：`opendweb-sdk-mgmt-surface`（分支 sdk-mgmt-surface，起点 HEAD 8379408）
> 语义依据：design §9.1 第六轮 E1′ 移交清单 + 本批修复要求（known_addrs 卫生/canonical 硬化/恢复语义/F5/两条 cosmetic）
> 结论先行：**E1′ 三支柱（per-remote 尸体+scratch 交叉学习墓地+ALREADY_ACTIVE canonical 滞留）修复闭合；部署途中间歇开出的第二簇缺陷（互开死锁/serve 反向到达面缺失）一并闭合；双向恢复语义成立（mini-only ~25s / iMac-only +5s → 200）；第六批被迁移模式替代的 sync 矩阵 #2/#3/#4/#9 原样真双机复放 4/4 PASS；F5 接线落地**。修复 commit：内核 `07596d7`（fabric 六层 + webui serve 预绑/会话逐出）；F5+cosmetic `39fd8e4`（ext-sync + webui 宿主钩子）。

## 0. 修复前现场复现（修复基线取证）

- mini `curl http://127.0.0.1:19090/`：`502 upstream-unreachable: [session] session: connect: response head timeout`（30s；另有 8s 级 000）——第六批终态的 E1′ 失败仍在，未被环境自愈。
- **双端 known_addrs 墓地取证（v1 文件原文）**：
  - mini（对 iMac `3pyssy4p…`）：`192.168.2.8:3341`（活，宣告）+ `192.168.2.8:56873`、`192.168.2.8:52169`（**两个死 scratch 端口**）；
  - iMac（对 mini `71ymwthn…`）：`192.168.2.10:3342`（活）+ `192.168.2.8:3343`（**死错机条目**——第六批迁移仪器 rlc 的残留）。
- mihomo 基线：双端路由表无 198.18.0.0/15、无 TUN 路由；iMac mihomo API `tun.enable=false`（第六批 TUN 事件未复发）；裸 UDP 双向探针通。

## 1. E1′ 根因链与修复面（比第六批移交清单多两层——部署过程中实证挖出）

修复落地后的完整因果链（mini→iMac 当日不可恢复 = 六层叠加，逐层闭合）：

1. **scratch 端口交叉学习**（移交支柱③）：continuity 层 `adopt_with_winner` 对**入站连接**的对端源地址一律学习并持久化——对端 direct-dial 专用 endpoint（随机端口）弃置即死，墓地跨重启存活。修复：known_addrs 来源分治——`Announced`（invite 宣告，唯一权威）/`Manual`/`DialOk`（本端拨出连接的选中路径，验证过可达可持久）/**`ObservedInbound`（入站源地址——一律不落盘**，仅内存 + 10min TTL/失败修剪；本端拨通后升格 DialOk）。
2. **墓地无活性修剪**（N1）：修复：per-条目 `fail_count`（整计划拨号失败计分，≥3 淘汰；**末位保留**——失败淘汰不得清空候选集，实证：对端未换新时整计划失败可由对端滞留造成，清空即 NoAddressingInfo 死局）+ ObservedInbound 未验证 TTL（10min）+ per-endpoint Observed 条数上限（4）+ 拨号候选排序「宣告>手工>近期拨号成功>观测」；v1 旧文件加载时**降级 ObservedInbound + 迁移宽限**（learned_at=加载时刻——存量唯一活路由先可拨，曾因记 0 加载即全数过期）。
3. **ALREADY_ACTIVE canonical 滞留**（移交支柱②）：canonical 的「死通道」判定只认 pump 退出（`is_dead`）——两类 zombie 在此信号上不可见：半开尸体连接（pump 阻塞在永不返回的流读盘）与**进程双活+心跳正常但会话流停滞**（连接级信号恒活、QUIC 空闲超时永不触发——「response head timeout」现场）。修复：通道接入双活性信号——连接级 rx 静默（与 ConnHandle 同源采样，>10s）+ **流级帧静默**（pump 每帧刷新，>30s，`SESSION_FRAME_SILENCE`，测试注入钩子）；`admit_init_ordered` 的 Active/Recovering 替换判据、campaign 压制的 `local_is_active`、客户端 `open_session` 的 reusable 复用判据统一改用。
4. **客户端 zombie 会话复用**（部署实证）：response head timeout 后 sessionResolver 缓存会话永久复用。修复（双层）：`open_session` 对**本端 client campaign**（is_client）的不可救通道显式放弃（remove_if+tombstone）后全新建会话；**provider 孪生绝不 tombstone**（它是发端 campaign 的 canonical 锚——tombstone 后双方互相以对方无法 adopt 的 canonical 拒绝，mutual 死锁；provider 孪生死通道由对端重开的 admit 替换承接）——`mutual_open.rs` 互开+连接翻覆复现测试钉住。JS 侧 `sessionResolver` 每查询快照复核（dead/closed 即逐出，不依赖 onState 跳变）。
5. **serve 反向到达面缺失**（部署实证，本批最深一层）：并发双开收敛（ALREADY_ACTIVE adopt）后，对端在本端**自发起的会话**上开 provider 向流发请求——该会话从未经过 `accept_any`，无 dispatch 任务 → 请求到达 pump 却永不分发（trace 实证：对端 Open/Fin 到达、本端零回包、~30s 后对端 Reset）。修复：`serve_http` 双面化——accept worker（不可取消语义保持，mpsc 承载）+ 每 250ms 复核 canonical 的**反向到达面**（未见过的 sid 挂 dispatch）。
6. **serveHttp 绑定依赖 legacy peer-connected**（部署实证）：绑定只挂在 legacy 连接事件上——对端与本端只有 continuity 连接时（iroh 对同 NodeAddr 既有连接的新握手存在抑制面）legacy 连接可能永不建立 → serve 循环缺席。修复：webui fabric 宿主启动即对 roster 全员**预绑** serveHttp（幂等；peer-connected 动态绑定保留）；预绑暴露的 `accept_any` 无退避热自旋（真双机 3 分钟 270 万条 trace）一并修复（错误路径 200ms 退避）。

修复中的两类测试拦击（绿门价值实证）：cargo 全量首跑抓出候选排序方向写反（宣告被排到最后）；部署现场抓出 v1 文件 serde 解析失败（`#[serde(untagged)]` 缺失——单测绕过 serde 构造 PersistEntry 掩盖，补 serde 字节级回归）。

## 2. F5（ext-sync config 接线）与 cosmetic

- **F5**：`createSyncRuntime({config:{intervalMs,debounceMs}})` 构造期入调度器；`applyConfig`（`scheduler.setTiming`——interval 对活跃组即时重挂、debounce 后续生效；非法值拒绝）；webui 宿主 `onEnable` ctx 携带 `config`、`setConfig` 持久化后通知可选 `onConfigChange` 钩子（抛错经 `onConfigChangeError` 观测、不回滚已落盘配置）；PluginRuntime 契约 typedef 扩展（可选钩子，零破坏）。
- **cosmetic 两条**：`gcStaging` 空壳（0 对象）staging 目录即时回收（有对象目录仍按 TTL——崩溃现场语义不变）；`executeIntent` 完成后清理 intent/done 文件对（`recoverIntent` 同构；done 落盘与清理之间崩溃=done 对在场，readPendingIntent 幂等 null）。

## 3. 绿门

| 套件 | 数字 |
|---|---|
| cargo test -p dweb-fabric（全量） | **316 passed / 0 failed**（306 基线 + 10 新增：known_addrs 来源分治 8 例、session zombie/对照 2 例、e1p_stale_state 1 例、mutual_open 1 例——known_addrs 原 4 例重写） |
| clippy（--all-targets） | 0 warning |
| rustfmt --edition 2024 | 触碰文件全格式化（仓库既有未触碰文件存在格式漂移，未卷入） |
| ext-sync node --test | **61/61**（57 基线 + F5 两例 + cosmetic 两例） |
| webui node --test | **259/259**（258 基线 + F5 宿主钩子一例） |
| client-sdk node --test | 96/96（NAPI 重建后） |
| openspec validate --strict | 通过 |
| git diff --check | 干净 |
| NAPI 重建门 | build 内置 strip -Sx + codesign + 真实 dlopen（两端 md5 `bf34bc0f…` 一致 + mini 独立 require 成功） |

## 4. 双机验证（时间戳均为 UTC）

### 4.1 部署与恢复

- 部署：iMac worktree 重建 + mini ssh-rsync（src + .node，md5 双端核对）；sidecar 以 DWEB_SESSION_TRACE=1 起观测。
- **双端重启后**：mini 19090 → **200**（python 目录列表 50682B，~28ms/次 ×3 复测稳定）。
- **仅重启 mini**（06:21:32 kill -9 验死 → 拉起）：06:22:39 → 200（首周期 67s；第二周期 06:22:51 起 ~25s 内 500→200）。修复前：当日不可恢复。
- **仅重启 iMac**（06:25:10 kill -9 验死 → 拉起）：**06:25:15 → 200（+5s）**。双向恢复语义成立。

### 4.2 sync 矩阵复放（第六批被迁移模式替代的 4 项，原样真双机重放）

组 `g-055af40c`/root `r1` 状态完好（groupRef=deviceRef=`a9c1c2a6…` 第六批收敛态，双端 36 文件）：

| 矩阵 | 操作 | 结果 |
|---|---|---|
| **#2 单边跟随（正向）** | iMac 改 wiki/Home.md + 增 prompts/matrix2-imac.md → sync-now（local ahead pushed）→ mini sync（up to date） | **PASS**：双端 md5 `2fdba372…`/`2529133e…` 逐对一致 |
| **#2 单边跟随（反向）** | mini 改 wiki/ops/runbook.md + 增 prompts/rev/matrix2-mini.md → push → iMac fast-forward | **PASS**：md5 `d03bedcf…`/`b39b2e05…` 一致 |
| **#3 非重叠合并** | iMac 改 skills/research + mini 改 skills/diagnosing-bugs → mini 轮 `merged` → iMac fast-forward | **PASS**：双端各含双方变更；**37/37 文件 md5 全一致**（含中文空格名文件） |
| **#4 重叠冲突决议** | 双端同文件 prompts/plan-task.md 追加不同行 → mini 轮 `conflicted`（hunk 级 1 处，base/ours/theirs OID 持久化）→ `POST …/conflicts/g-055af40c/r1/resolve {choices:[{hunkIndex:0,choice:"theirs"}]}` → 决议提交 `09e5602f` → iMac fast-forward | **PASS**：双端 plan-task.md 均为 IMAC 行，md5 `19a3d847…` 一致（注：决议 body 首次以 `["theirs"]` 字符串形态提交报 internal——choices 语法为 `[{hunkIndex,choice}]`，非缺陷） |
| **#9 重连收敛** | mini kill -9（06:30:39 验死）→ iMac 编辑+push（mini 下线时失败，mini 06:31:26 重启后 08s 内 push 成功）→ mini 重启后 sync | **PASS**：wiki/Home.md `a0fb066d…` + 新增 reconnect-file.md `0d081de1…` 双端 md5 一致 |

## 5. 遗留与移交

- **E1′ 遗留①（进程内拨号停滞）仍未根治**：本批部署窗口再现一例（sidecar 进程新出站拨号停滞、同刻独立进程 40ms 通——同 NodeId 二进程探针的 canonical 干扰后判定为「对端同 NodeAddr 既有连接的新握手抑制」面的另一表现；层 5/6 修复后该形态不再阻塞数据面，但 iroh 层抑制机制未定位，续档）。
- known_addrs v2 落盘格式已上线（v1 兼容读入）；双端首启后旧墓地以 ObservedInbound 内存态过渡，首个成功拨号后以 DialOk 重新落盘。
- F3 残留（UI 建组表单 id 输入框）、F2 裁定材料——不变，续第六批移交清单。

## 6. 结束态与进程回收

| 项 | 状态 |
|---|---|
| iMac sidecar | 运行（修复后代码，18801=200；pid 见 `/tmp/wpk-imac-sidecar.pid`，trace 开着可复现观测，收官走查可按需去 trace 重启） |
| mini sidecar | 运行（修复后代码，18801=200），ports/files/sync enabled |
| 19090 | 200（多次复测）；sync 组 `g-055af40c` 双端收敛态（37 文件，含本批复放增量） |
| 8080（pid 1749）/hub（pid 19232） | 全程未动，200 |
| 探针回收 | mini：/tmp/wpk-probe.mjs、/tmp/wpk-connect-probe.mjs、/tmp/wpk-bind-probe.mjs、/tmp/wpk-mini-home-probe（身份副本）已删；iMac：误建的本地 /tmp/wpk-mini（rsync 目标误写本地路径产物）已删 |
| 验收数据 | /tmp/wpk-sync-{imac,mini}/agents-skills 保留（37 文件收敛态） |

---

# webui-plugin-kernel 真双机验收实录——第八批（r8-B4/F2 v1 包络冻结落地：1MiB 统一+入史前拒绝+毒化迁移+closure 流账）

**日期**：2026-09-30 15:55–16:05（iMac 192.168.2.8 ↔ Mac mini 192.168.2.10；直连数据面 UDP 3341/3342）。
**输入**：Codex r8 终审 B4/F2 裁定（docs/webui-plugin-kernel-review-r8.md）——v1 有效包络=min(插件预算, transport 实况)=**1MiB**（帧 session.rs MAX_FRAME=1MiB/流 2MiB/会话在飞 8MiB）；逐条实装非文档取最小值。

## 1. 部署与代码核对

- 回归树=HEAD `7050b51`+B4 变更集（排除并行 TERM 任务的 WIP cli.mjs——用 HEAD 版 cli.mjs）；iMac `/tmp/wpk-r8b4-repo`、mini `/tmp/wpk-mini/r8b4-repo`（rsync，含 node_modules——@jixo 相对符号链接在树内重锚定）。
- **md5 审计 16 个运行时文件全一致**（proxy/runtime/index×2、client/staging/runtime/index、endpoint/engine/util/worktree、data-plane、sidecar、cli、dist/index.html+bundle）+ `dweb.darwin-arm64.node` `bf34bc0f…` 双端一致。
- 双端 sidecar 重启（kill -9 验死后拉起）：iMac pid `86233`（18801/3341，advertise 192.168.2.8:3341）、mini pid `71785`（18801/3342）；DWEB_HOME 沿用 `/tmp/wpk-hub` / `/tmp/wpk-mini-home`；三插件 enabled ×2。
- 环境插曲：重启后首轮 fabric 双向 `response head timeout` → mini 侧重启一次后 `session init rejected: reason=1`（kill 残留 zombie canonical）——**~35s 后经第七批双信号 canonical 替换自愈**，19090 → 200（0.47s；期间 mini mihomo `DELETE :9090/connections` 204 一次）。8080/hub 全程未动。

## 2. files 边界（mini 浏览器等价 bridge → iMac 真 fabric）

| 用例 | 请求 | 结果 |
|---|---|---|
| 恰 1MiB chunk | `PUT …/chunk?path=r8b4-1m.bin&uploadId=r8b4a&seq=0&offset=0&hash=sha256`（bodyBase64 1048576B，经 bridge ≤1MiB 帧分块+fetchHttp） | **200** `{"ok":true,"idempotent":false,"received":1048576}`；`POST commit` **201** oid `4e29ad18…`；落盘 1048576B，md5 `e6065c4a…`==源；staging 全回收 |
| 1MiB+1B chunk | 同上（1048577B，uploadId r8b4b） | **413** `{"error":"chunk-too-large","message":"chunk exceeds the 1048576-byte limit"}`；正式目录零残留、staging 零残留 |

## 3. sync 边界（iMac seed → mini 首拉；组 r8b4a/r8b4c 双端同 id 建组）

| 用例 | 结果 |
|---|---|
| **1MiB 对象 push**（big.bin 1048576B） | iMac `seed baseline pushed`（3 对象，615ms；closure wire≈1.4MiB 经 toSyncFetch ≤1MiB 帧分块入 2MiB 流账）；mini `baseline adopted (empty worktree)`；**md5 `c3cda277…` 双端一致** |
| **超限对象**（huge.bin 1048577B 入同步根） | iMac sync-now → 稳定错误 **`oversize-history`**：`file huge.bin is 1048577 bytes (limit 1048576 = 1MiB per-blob transport envelope); device history was not written`+迁移提示（reset/re-seed；独立 root 继续可用）；**mini groupRef 保持 `66397463…` 零变化**、huge.bin 未落地（commitLocal 预检在读内容/写 blob 前拒绝） |
| **超限 closure**（组 r8b4c：x.bin+y.bin 各 1048576B） | iMac sync-now → 稳定错误 **`closure-exceeds-transport`**：`push closure serializes to 2796700 wire bytes (limit 2097152 = 2MiB journal stream budget)`+hint（分批/pack 化 push 与流式请求 ABI=后续 change）；**mini r8b4c groupRef=None、工作树空**（发送前预检，零 POST） |
| 迁移路径+独立 root | 移除 huge.bin 后 r8b4a `local ahead (pushed)` → mini `fast-forward`，followup.txt 双端逐字节一致（`clean after oversize removal`）——**超限拒绝不污染无关历史，恢复无需重置** |

## 4. 结束态

| 项 | 状态 |
|---|---|
| iMac sidecar | pid `86233` 运行（/tmp/wpk-r8b4-repo，18801=200） |
| mini sidecar | pid `71785` 运行（/tmp/wpk-mini/r8b4-repo，18801=200；19090=200） |
| 插件 | ports/files/sync **enabled ×2** |
| 验收数据 | /tmp/wpk-r8b4-sync-{a,b}（1MiB 收敛态+followup.txt）、/tmp/wpk-r8b4-closure-{a,b}（拒绝证据态）、/tmp/wpk-files-share/r8b4-1m.bin 保留；huge.bin 已按迁移路径移除 |
| 8080/hub | 全程未动 |
