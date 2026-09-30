# webui-plugin-kernel Owner 双机实走包（iMac ↔ Mac mini）

> 对应 openspec change `webui-plugin-kernel`（归档时随 change 入库）。验收实录：
> `docs/acceptance-webui-plugin-kernel-dualmachine.md`（八批）；评审链 r1-r9；
> UI 走查 `docs/walkthrough-vision-webui-plugin-kernel.md`。

## 0. 这个 change 回答的原始诉求

> 「我有多台设备需要去同步 Agents-skills/prompt/wiki/configs 等等，平时手动维护非常麻烦」
> ——端口共享（B:9090 ≡ A:8080）、文件夹共享（简单 FS 操作）、文件同步（virtual git：
> 单向跟随/双向自动合并/冲突选版本），webui 插件化（薄核+插件面板，「即将推出」占位）。

## 1. 环境快照（活环境）

| | iMac（中枢/root） | Mac mini（成员） |
|---|---|---|
| sidecar | http://127.0.0.1:18801（pid 见 /tmp/wpk-imac-sidecar.pid） | 同（pid 见 /tmp/wpk-mini-sidecar.pid，ssh macmini） |
| DWEB_HOME | /tmp/wpk-hub | /tmp/wpk-mini-home |
| 身份 | 3pyssy4p…（root，UDP 3341 直连宣告） | 71ymwthn…（member） |
| 插件 | ports/files/sync enabled | 同 |
| 数据 | 8080 python 演示服务；/tmp/wpk-files-share 共享目录；/tmp/wpk-sync-imac/agents-skills | 19090→iMac:8080 映射；/tmp/wpk-sync-mini/agents-skills |

数据面为 **direct-only**（[W12]：hub 的 HTTP-only relay 只做管理面；LAN 直连）。

## 2. 实走剧本（约 15 分钟）

### 2.1 插件面板（webui 基础面）
1. iMac 打开 http://127.0.0.1:18801 → 侧边「工具」区六个入口 + 插件面板。
2. 三张插件卡片（ports/files/sync，已启用）；「即将推出」五个占位（VPN/Clash/AI/SSH/屏幕共享）；底部安装说明（CLI-only）。

### 2.2 端口共享（ports）
1. mini 上 `curl http://127.0.0.1:19090/` → **python 目录列表**，与 iMac 直连 `curl http://127.0.0.1:8080/` 逐字节等同——这就是「B:9090 ≡ A:8080」。
2. 流式（SSE）：`curl -N http://127.0.0.1:19091/events`（若 8081 演示源未起，见 §4 脚本）→ 持续 tick；Ctrl-C 中断后 iMac 侧 ~1.2s 收敛、无泄漏，重连即恢复。
3. 演示设计正确的显式错误：映射本地端口占用（9090 mihomo）→ 明确 EADDRINUSE 报错文案。

### 2.3 文件夹共享（files）
1. webui「文件浏览」页 → 连接 iMac 共享 → 浏览 /tmp/wpk-files-share（含中文文件名/子目录/空目录）。
2. 下载（含 Range 断点）→ md5 与 iMac 一致；上传新文件 → commit 后双端 md5/oid 一致。
3. 上传中断演示（可选）：断在 chunk 间 → **目标目录零半文件**（staging TTL 回收）。

### 2.4 文件同步（sync——核心故事）
组 `agents-skills` 已建（双成员、双向自动合并、初始权威 iMac）。工作树：
iMac `/tmp/wpk-sync-imac/agents-skills`、mini `/tmp/wpk-sync-mini/agents-skills`。
1. **单边跟随**：iMac 改 2 个文件+新增 1 个 → webui「同步组」→ 立即同步 → mini 工作树逐文件 md5 一致。
2. **双向自动合并**：两端各改**不同**文件 → 双向同步 → 两端都有双方变更（merge commit 双方身份入史）。
3. **重叠冲突决议**：两端改**同一文件不同内容** → 同步 → webui「同步冲突」页出现待决议记录（base/ours/theirs 三方对照+diff3 溯源+「不默认取舍」警示）→ 选「用本端/用对端」→ 收敛。
4. **崩溃韧性**（可选）：同步进行中对端 `kill -9` sidecar → 重启 → 重试幂等 roll-forward，双端 OID 一致（staging 留存→TTL GC）。

### 2.5 启停生命周期（P1 修复现场）
插件面板停用 files → 页面/深链收敛基线 → 重新启用 → **200 恢复**（曾为确定性 500 的三态分裂，已修复并回归）。

## 3. 快速自检脚本

`scripts/walkthrough/webui-plugin-kernel-demo.sh`（iMac 运行）：基线健康（双端 sidecar+19090 等价性）→ files 往返 md5 → sync 双端收敛 md5 对照。全程只读+临时文件自清理。

## 附录 A：环境处置手册（双机验收沉淀）

- **mini mihomo conntrack 单端口 UDP 黑洞**：症状=某五元组出站零到达（其它端口正常）；处置=`ssh macmini 'curl -X DELETE http://127.0.0.1:9090/connections'`（204）+重启 mini sidecar。
- **iMac mihomo TUN 误开**（auto-route 劫持出站 UDP）：`ifconfig | grep -c utun` + UDP 探针判；关闭 TUN 恢复基线（本验收期基线为 off）。
- **杀进程纪律**：TERM 可能有 2s 宽限兜底（正常 ≤7s 退出）；异常时 `kill -9` 后必须 `pgrep` 验死——僵尸同身份端点是「新进程网络全断」的首要嫌疑。
- sidecar 重启命令模板：见验收文档 §1。

## 附录 B：遗留后置清单（独立 change，不随本 change 归档）

1. E1′-①：sidecar 进程内新出站拨号间歇停滞（iroh 同 NodeAddr 新握手抑制面疑；一例在案，第七批后不再阻塞数据面）——保留复现材料。
2. native `HttpServerJs` TSFN 主动释放（TERM 闩锁的原生侧根治；当前壳层 settleExit 兜底）。
3. QUIC/TLS relay（server 侧）+ 数据面 relay 重新开放（[W12] 后续）。
4. 流式请求体 ABI + sync push 分批/pack 化（1MiB 包络的抬升路径）。
5. known_addrs 历史条目迁移清理（活性修剪已上线，旧脏条目迁移留维护项）。
6. F3 UI 建组 id 输入框残留；P2（files 错误态与空态同屏）/P3（深链 hash 语义、状态-冲突联动）产品 polish。

## 附录 C：[W7]-[W12] 追认清单（待 Owner 逐条追认）

| 裁决 | 内容 | 状态 |
|---|---|---|
| W7（r8 修订） | ports 请求体默认 **1MiB**（域 64KiB–1MiB，必然失败配置配置期拒绝；超限 413） | 已落地（r8 裁定修订原 8MiB/1-64MiB） |
| W8 | N 成员账本·双机执行承诺 | 已落地（真双机六/七批实证） |
| W9 | seed 权威显式选择+非空对端阻断 | 已落地（矩阵 #1 三方对照） |
| W10 | 安装仅 CLI（webui 面板只管内置三插件） | 已落地 |
| W11 | 既有 --token 入口=受控例外；**新面零 argv 凭证**（源级断言在案） | 待追认安全默认 |
| W12 | 数据面默认 direct-only；HTTP-only hub relay 仅管理面；QUIC/TLS relay 独立 change 后开放 | 已落地（Codex approve+实装） |

## 附录 D：证据索引

- 八批真双机验收：`docs/acceptance-webui-plugin-kernel-dualmachine.md`
- 评审链：`docs/webui-plugin-kernel-{discussion-r1,review-r2…r9}.md`
- UI 走查：`docs/walkthrough-vision-webui-plugin-kernel.md`（17 截图 /tmp/wpk-vision/）
- 设计与实录：`openspec/changes/webui-plugin-kernel/design.md`（§9.1 九轮）
