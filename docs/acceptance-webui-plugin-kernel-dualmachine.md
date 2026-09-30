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
