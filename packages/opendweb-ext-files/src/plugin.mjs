// `./opendweb-webui-plugin` 子路径导出（webui-plugin-kernel Phase 2——本包是
// 第一个真实导出该子路径的 files 插件包；契约权威源=
// packages/webui/src/core/plugins/contract.mjs，本 descriptor 必须过其校验
// ——仓内测试直接 import 该权威校验器断言）。
// 意图（2026-09-29）：
// 1. id=files（与 Phase 0 宿主静态注册表同 id——包化后由接线方收敛为单一
//    descriptor 源，见 webui ui/src/lib/plugin-registry.ts 双源说明）。
// 2. 页 browser：类型 page（专属 Svelte 组件 FileBrowserPage——由宿主编译期
//    绑定，descriptor 不携带可调用物/组件）；perspective=both（B 机成员姿态
//    是浏览远端共享的核心用例——与 Phase 0 占位 admin 的差异已在包文档与
//    接线清单显式标注）。
// 3. dataEndpoints 声明 wire 面 /wpk1/files/*（声明性——授权与限流在运行时）。
// 4. configSchema：stagingTtlSeconds（number，可选；运行时工厂同名配置对齐）。

/**
 * WebUI 插件 descriptor（webuiApi 1）。每次调用返回新对象（防共享可变状态）。
 */
export function filesDescriptor() {
  return {
    id: "files",
    webuiApi: 1,
    pages: [
      {
        id: "browser",
        title: "文件浏览",
        nav: "tools",
        icon: "folder",
        type: "page",
        perspective: "both",
      },
    ],
    dataEndpoints: [{ id: "wire", path: "/wpk1/files/" }],
    configSchema: {
      type: "object",
      properties: {
        stagingTtlSeconds: { type: "number" },
      },
      required: [],
    },
  };
}
