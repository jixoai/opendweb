// @jixo/opendweb-ext-ports —— ./opendweb-webui-plugin 契约子路径导出
// （webui-plugin-kernel Phase 1 / design §2.1：WebUI 插件契约独立于 CLI
// ./opendweb-plugin apiVersion 1；本子路径=descriptor（manifest），运行时工厂
// 经主出口 createPortsRuntime 消费——契约 descriptor 字段集冻结，不承载
// 运行时可调用物）。
// 契约校验权威源=packages/webui/src/core/plugins/contract.mjs
// （validateWebuiPluginDescriptor——宿主构造期 fail-fast 全量校验）。
//
// 字段说明：
// - pages[0].type="page"：Phase 1 起端口映射为插件专属 Svelte 组件页
//   （ui/src/components/plugins/ports/MappingsPage.svelte——宿主编译期在
//   plugin-pages.ts 绑定；本包不含 Svelte 代码，component 位留 null 由宿主装配）。
// - dataEndpoints：提供侧 wire 端点声明（/wpk1/ports/proxy/<port>，§3.2 版本化
//   前缀 wpk1）——声明性元数据（serveHttp 接线由编排者完成）。
// - configSchema.maxBodyMiB：请求体上限（MiB）。默认 8、配置域 [1,64] 硬范围
//   ——configSchema 子集（属性仅 type 字段）无 min/max 表达，域校验在
//   createPortsRuntime 启动映射时执行（超范围拒绝启动映射并给明确错误）。

// shape：contract.mjs 的 WebuiPluginDescriptor（id/webuiApi/pages/routes/
// dataEndpoints/configSchema——字段集冻结；本文件为纯数据，不 import 宿主包）
export const descriptor = {
  id: "ports",
  webuiApi: 1,
  pages: [
    {
      id: "mappings",
      title: "端口映射",
      nav: "tools",
      icon: "network",
      type: "page",
      perspective: "admin",
      component: null,
    },
  ],
  dataEndpoints: [{ id: "proxy", path: "/wpk1/ports/proxy" }],
  configSchema: {
    type: "object",
    properties: { maxBodyMiB: { type: "number" } },
    required: [],
  },
};

export default descriptor;
