// @jixo/opendweb-ext-ai —— ./opendweb-webui-plugin 契约子路径导出
// （ai-subscription-sharing Phase C / design §1 宿主接入七点）。
// 契约校验权威源=packages/webui/src/core/plugins/contract.mjs
// （validateWebuiPluginDescriptor——宿主构造期 fail-fast 全量校验）。
//
// 字段说明（与 ports 包同拍）：
// - pages：provider=提供方管理页（admin 视角——服务/分组/密钥/配额/用量/导入）；
//   consumer=消费方页（member 视角——贴链接入环/目录/本地端点/写手占位）。
//   双姿态共存互不排斥（design §1）：一台机可同时提供+消费；视角过滤只是 UI
//   呈现面，宿主运行时对两姿态无排斥语义。
// - component=null：宿主编译期在 ui/src/lib/plugin-pages.ts 绑定 Svelte 组件
//   （本包不含 Svelte 代码）。
// - dataEndpoints：提供侧 wire 端点声明（/wpk1/ai/v1/*——§3 header framing
//   ABI；声明性元数据，serveHttp 接线由宿主 sidecar 装配）。
// - configSchema（JSON Schema 子集，属性仅 type）：域校验在工厂做——
//   maxConcurrency 1–32 且活跃 ring ≤64MiB 超积拒启（§3.1 admission 公式）、
//   dailyRequests 0–1,000,000、usageLog bool（默认关——requirements 配额面）。

/** shape：contract.mjs 的 WebuiPluginDescriptor（字段集冻结；纯数据，不 import 宿主包）。 */
export const aiWebuiPluginDescriptor = {
  id: "ai",
  webuiApi: 1,
  pages: [
    {
      id: "provider",
      title: "AI 订阅·提供方",
      nav: "tools",
      icon: "sparkles",
      type: "page",
      perspective: "admin",
      component: null,
    },
    {
      id: "consumer",
      title: "AI 订阅·消费方",
      nav: "tools",
      icon: "bot",
      type: "page",
      perspective: "member",
      component: null,
    },
  ],
  dataEndpoints: [{ id: "wire", path: "/wpk1/ai/" }],
  configSchema: {
    type: "object",
    properties: {
      maxConcurrency: { type: "number" },
      dailyRequests: { type: "number" },
      usageLog: { type: "boolean" },
    },
    required: [],
  },
};

export default aiWebuiPluginDescriptor;
