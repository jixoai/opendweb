# Run WorkFile：webui 控制台设计重构（world-class-designer）

## Goal

Owner 批评：「界面虽然有功能，但是确实也很混乱」→ 对 setup/admin/member 全部世界做
设计级深度重构。功能面（三用户故事 B/C 收口、62ddd07）零回退。

## Context

- 技术栈：Svelte 5 + shadcn-svelte + Tailwind；文案有 PM 冻结层（specs/PRODUCT-DESIGN
  逐字文案——重构允许调整**呈现结构**，冻结语义的句子尽量保留或收敛为单处）。
- 现状截图：/tmp/ustories-walk/audit/*.png（13 张：错误态+正常态+三世界）。
- vision 子代理独立审计（2026-10-02，agent_3c3e397a）：系统性 A1-A8 + 单页 P0-P2 +
  AI-tells C1-C6 + 保留清单 D1-D8。
- **E 一句话诊断：三种语言（家庭隐喻/协议术语/开发者词汇）每屏无层级混排 + 错误
  横幅复制粘贴 + 安全声明×N——页面在解释内部模型，而不是翻译成用户的下一步动作。**

## Workflow graph

```
Stage0 Frame ──► 现状截图+vision审计 ──► T1 seed ──► T2 方向拍板(Owner)
                                                      │
                              ┌───────────────────────┼───────────────────────┐
                              D1 家庭控制台            D3 待办驱动              D4 极简收束
                              （页面+卡片分级）        （总览=工作台）           （一屏一事）
                              └───────────────────────┴───────────────────────┘
                                                      │
T3 critic 循环(vision 只看截图, 9+/10 或 stop) ◄── 深化实现 ──┘
        │
T6 减法 + T7 AI-tells ──► 绿门(test+build) ──► 走查截图 ──► 提交
```

## Stage 0 — Personas & Stories（框架冻结）

- **P1 家长·新手**（admin）：非技术家庭主力。S1：打开总览 10 秒内答「家里正常吗/有人敲门吗」，0 击。
- **P2 家长·熟练**（admin）：S2 敲门→定位为访客 ≤2 击；S3 发邀请码 ≤2 击到签发；S4 拉黑/移黑名单 ≤2 击。
- **P3 家人**（member）：S5 打开即知租约状态（永久显示「长期」非天数），0 击；「测一下」可达 ≤1 击。
- **P4 装机者**（setup 世界）：S6 新手看懂三路径差异并 1 击选定；S7 老手节点簿 1 击连回。

### Sandbox 块清单（全集）

接入卡（地址/短码/QR）· 四问状态行 · 中枢状态卡 · 敲门台 · 访客名册 · 邀请码签发 ·
租户名册 · 手工导公钥(高级) · 黑名单 · 在线连接表 · 插件面板(启停/配置/即将推出) ·
节点簿(列表/添加/切换/删除) · setup 三路径 · member 租约/到访/身份 · 错误态 ·
InsecureStrip · 深色主题 · 架构说明(两道门/范围声明/安全模型) · CLI 等价命令 ·
工程配置键(maxBodyMiB 等)

### Sandbox 放置（novice 80% 空间 → 高频 20%）

- 总览 = 状态行(正常/异常+敲门数) + 待办(敲门台有货时置顶) + 分享短码(主卡)；四问卡次级。
- 高级面全部深层入口：公钥导入(折叠)、插件工程键(启用后+人类标签)、CLI 命令(帮助层)、
  架构说明/安全声明(统一「这是什么？」帮助层，全站 ≤1 处常驻)。
- 错误单例：顶栏状态灯 + 全局一条横幅（页面区块不再各自复制）；出错时依赖控件禁用+原因。

## T1 Seeds（Sakana String Seed，12 条已生成）

映射：D1=WuVk6AT9…（圆润→温和家庭 tile）；D3=0tnfkyzS…（小写流动→向导暖流）；
D4=dyHyiTD2…（锐利收敛→仪器感减法）；D2=P8NNWWn8…（栅格标记→操作员面板，对照项）。

## Worklog（append-only；HEAD=最新状态）

- 2026-10-02 S0：seed×12 注入；hub/webui 三世界环境（18971 admin / 18973 setup /
  18974 member）；13 张审计截图（含 401 错误态意外暴露 A1 红墙实证）；vision 独立审计
  报告（A1-A8/C1-C6/D1-D8，存 receipts/audit-vision.md）。Stage 0 框架先于实现落盘。✅
- 2026-10-02 T2：Owner 拍板 **D4 极简收束 + 术语全隐藏到帮助层**（AskUserQuestion）。✅
- 2026-10-02 实现：PageHeader（题+「这是什么？」帮助层）+ adminPlaneDown 全局降级屏 +
  Overview/HubAccessCard/SetupWizard（三选择卡）/Tenants/Visitors/Online/PluginPanel/
  ConfigForm（人类标签）/NodeBook/LeaseView/VisitsView/PerspectiveSwitcher（member 分段）；
  leaseState 2100 哨兵→「租期中 · 长期」；dialog overlay bg-black/50。✅
- 2026-10-02 T3 critic 循环（vision fresh-context 只看截图，receipt 存 receipts/）：
  **r1 6.5 → r2 7.4 → r3 7.7 → r4 8.1 → r5 8.6 → r6 8.8 → r7 9.2 ✅ 达 9.0 交付门**；
  r7 唯一发布阻塞（节点簿弹窗透底）已修并程序化验证（overlay rgba(0,0,0,.5)+blur 8px）。
  按 critic-protocol stop（达门 + 阻塞闭合）。终版截图 11 张存 final/。✅
- 2026-10-02 绿门：webui npm test 277/277 + build ✓（两次全量复跑）。
- HEAD：已完成，待提交。

## Owner 裁决 / 抗辩记录（critic 建议中未采纳项及理由）

1. **产品专名保留**（r2/r3 critic 建议家庭化改名）：端口共享/文件夹共享/文件同步/AI 订阅
   共享/VPN 互联/Clash 代理/SSH 终端/屏幕共享/节点簿——Owner 需求原文与 specs 冻结产品名。
2. **冻结 verbatim 文案保留**（测试断言即规格）：仅租户端点/倒计时本地快照句/到访尽力而为句。
3. **「测试连通」双权重**（r5）：租约行内 ghost vs 到访空态 outline——行内操作 vs 空态主行动
   的场景差异，非不一致。
4. **member 页简化页头**：角色差异化（豁免记入 r5/r6/r7 评审简报）。

## 冻结文案 delta 清单（本轮改动，均有测试同步）

- 在租 · 永久/剩 N 天 → **租期中 · 长期/剩 N 天**（2100 哨兵→长期，修「剩 26754 天」）
- 管理面连接正常 → **连接正常**；管理凭证无效 → **凭证已失效**（顶栏胶囊+errorCopy+降级屏统一）
- 管理凭证无效 errorCopy detail 语病修复（「会在提示处隐藏输入新的管理凭证」句重写）
- 访客名册/租户空态第二句删除（保留冻结首句）；黑名单/两道门/配置卡/邀请码脚注 → 帮助层

## 工程教训（新条目候选）

- Svelte 模板引用未定义变量/未 import 组件**编译期不报错**，运行时 ReferenceError 使整页
  悬死 boot 态（本轮两次：TenantsView ownersLoaded、App ArrowRight）——均被 ego 走查/
  critic 截图捕获。建议后续加「模板标识符静态扫描」或组件渲染冒烟测试。
- 批量 python patch 中途 assert 失败会静默丢失后续 patch（本轮多次）——每次批后必须
  逐项 grep 验证落盘。
