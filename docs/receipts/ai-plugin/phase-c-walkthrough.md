# Phase C 走查记录（C4——编排者 ego-browser 亲测，2026-10-02）

环境：`node scripts/walkthrough/ai-demo.mjs`（双 home 假上游；A=62259 admin / B=62260 member）
ego-browser TaskSpace 40（走查完毕已 finish）；截图 shots/。

## 步骤与结果（全 PASS）

1. **Provider 页（A `/#/p/ai/provider`）**：工具区导航「AI 订阅·提供方」；五 Tab（服务/分组/密钥与链接/用量与配额/导入）；密钥 Tab 两把有效 key+撤销+三态文案+签发/链接/密钥库表单（一次性展示标注）。
2. **插件面板（`/#/p/host/panel`）**：ai 卡「已启用」+三配置项（maxConcurrency/dailyRequests/usageLog）+停用钮；「即将推出」= VPN/Clash/SSH/屏幕共享（**AI 已从占位移除**）；外部注脚含 AI 订阅共享。
3. **生命周期（B 面板停用）**：4310 listener 完全关闭（curl 拒连 rc=7；lsof 零监听）；复启后恢复监听。
4. **生命周期（A 面板停用）**：A provider 面关闭；B 端点显式 `{"error":{"message":"internal"}}`（**非静默截断**；复启 A 后恢复）。备忘：该错误码可在 Phase D 优化为 upstream 更明确码。
5. **Consumer 页（B `/#/p/ai/consumer`）**：链接导入/裸密钥/授权目录（demo-openai c4r1x48kqfu9g）/本地端点（127.0.0.1:4310 监听中）/写手 Phase D 占位——全区块渲染。
6. **数据面往返**：非流式 `pong（非流式）`；流式 SSE `data: {…流式分片 0/1/2…}` 经 4310 完整送达。

## 视觉验收（vision 子代理）

4 图 3 PASS / 1 初判 FAIL（provider.png 服务区空白）——**复核为截图时序伪影**：截图先于快照 ~300ms 抓到 `overview===null` 的 Skeleton 骨架态（此时 Tabs 未渲染）；3s 后 DOM 探针 `[data-service]` 存在、tabs 面板文本完整（demo-openai 已启用/停用/删除/分组 family）。页面状态机（Skeleton loading→Tabs loaded→Alert error）正确。provider-retry.png 为复验图。

## 备忘（非阻塞）

- B 端点对「A 已停用」返回 internal 码——Phase D 可优化错误映射。
- panel 截图中 sync 卡底部被视口裁切=截图视口问题非布局缺陷。
