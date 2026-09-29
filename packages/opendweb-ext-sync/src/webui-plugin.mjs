// WebUI 插件 descriptor（webui-plugin-kernel Phase 3——`./opendweb-webui-plugin`
// 子路径导出；契约权威源=packages/webui/src/core/plugins/contract.mjs）。
// 意图（2026-09-29）：
// 1. id=sync；pages=[groups,status,conflicts]（type=page——插件专属 Svelte 组件
//    编入同一 bundle，组件在 webui 侧 packages/webui/ui/src/components/plugins/
//    sync/；component 绑定位留宿主（契约唯一非 wire 字段，此处不携带））。
// 2. routes/dataEndpoints 声明：数据端点前缀 /wpk1/sync/*（serveHttp 分派）。
// 3. configSchema 冻结：默认触发间隔与 debounce（§7.5 参数面）。
// 4. 零运行时依赖纪律：本模块纯数据工厂（每调用新对象）。

/**
 * sync 插件 descriptor（webuiApi 1）。
 */
export function syncWebuiPluginDescriptor() {
  return {
    id: "sync",
    webuiApi: 1,
    pages: [
      { id: "groups", title: "同步组", nav: "tools", icon: "refresh", type: "page", perspective: "admin", component: null },
      { id: "status", title: "同步状态", nav: "tools", icon: "activity", type: "page", perspective: "admin", component: null },
      { id: "conflicts", title: "同步冲突", nav: "tools", icon: "triangle-alert", type: "page", perspective: "admin", component: null },
    ],
    routes: [{ id: "groups" }, { id: "status" }, { id: "conflicts" }],
    dataEndpoints: [
      { id: "object-sync", path: "/wpk1/sync" },
    ],
    configSchema: {
      type: "object",
      properties: {
        intervalMs: { type: "number" },
        debounceMs: { type: "number" },
      },
      required: [],
    },
  };
}

export default syncWebuiPluginDescriptor();
