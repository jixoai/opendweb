# webui-plugin-kernel 真浏览器 UI 走查记录（Phase 0 遗留义务，2026-09-30）

走查对象：http://127.0.0.1:18801（iMac sidecar，DWEB_HOME=/tmp/wpk-hub，三插件 enabled）。
截图全集 17 张：`/tmp/wpk-vision/`（step01-06 编号）。工具：agent-browser `--headed` 会话
（ZCode 内置浏览器对 subagent 不可用；headless CDP 截图在本机全系 wedge）。视觉判读均经
程序化非平凡校验（尺寸/文件量）+ DOM ground truth 交叉核对后采信。

## 结论总览

| 项 | 结果 |
|---|---|
| 插件面板主页（工具区分组/六入口/三卡片/五占位/安装文案） | PASS（文案与 design §2.1 r2-B6 逐字一致） |
| ports 页 | 空态 PASS；数据态在本 URL 不可达（消费侧账本在 mini——范围偏差非缺陷） |
| files 页 | 交互面 PASS（hex 校验/写门控/徽章）；数据态不可达（共享授权仅含 mini，自拨无 addressing） |
| sync 组/状态/冲突页 | **数据态全 PASS**（agents-skills 组、双成员、ref 收敛态、真冲突记录三方对照+diff3 溯源+不默认取舍警示） |
| 启停与 deep-link 收敛 | disable→深链刷新收敛基线 PASS；**re-enable 确定性 500（P1 缺陷 F2-v）** |
| 整体视觉（布局/暗色/错误态） | PASS（加载态因本机过快未捕捉，记录为未验证） |

## 缺陷清单

| 级别 | 编号 | 内容 | 证据 |
|---|---|---|---|
| **P1（归档前必修）** | F2-v | **files 停用后 enable 确定性 500 不可往返**：`opendweb-ext-files/src/runtime.mjs:691` 的 `disposed` 为一次性终态，而 `webui/src/core/plugins/host.mjs` enable() 先落盘再调 onEnable、抛错后 entry 停 disabled——ledger=enabled / runtime=disposed / 宿主=disabled 三态分裂，仅重启 sidecar 可复原。违反 design §2.2「enable 与 disable 可往返」冻结承诺 | step05d-enable-failed.png；sidecar log `files runtime: cannot enable a disposed runtime` ×2 |
| P2 建议 | F1-v | files listing 失败时错误横幅与「空目录」空态同屏（错误态应抑制空态） | step03-files-error-state.png |
| P3 建议 | F3-v | disabled 深链不重写 hash（未知 hash 路径会重写 #/overview）——收敛语义差半步 | step05c |
| P3 建议 | F4-v | sync 状态页相位「已完成」与冲突页待决议并存，无联动提示（状态机有 conflicted 相位） | step04-sync-status/conflicts.png |

## 范围记录（本次不可验证项）

- ports 数据态徽标/错误行（映射账本在消费侧 mini）；
- files 数据态列表/下载/上传交互（共享 peers 仅含 mini；W12 direct-only 下本机自拨无 addressing）；
- 冲突页空态文案（当前恰有 1 条真冲突记录——非缺陷，属数据态优于预期）。

## 纪律声明

未杀任何进程；ports/sync 全程未停用；/tmp/wpk-* 数据零修改（冲突未决议、上传未执行、
账本未手改）；产品代码零改动；自建三个 agent-browser 会话已优雅 close 回收；主题已还原浅色。
files 因 P1 无法进程内复原——账本已 enabled，sidecar 重启即自动恢复（走查结束态如实）。
