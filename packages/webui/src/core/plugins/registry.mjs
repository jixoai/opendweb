// 编译期静态注册表（webui-plugin-kernel Phase 0 / design §2.1、§2.2；收官接线
// 升级为双源收敛）。
// 意图（2026-09-29）：
// 1. 内置三插件（ports/files/sync）的 descriptor **单一事实源=各包
//    ./opendweb-webui-plugin 子路径导出**（Phase 0 占位 → Phase 1-3 包化 →
//    收官收敛：pages/perspective/dataEndpoints/configSchema 以包内 descriptor
//    为准——files browser perspective=both（B 机成员姿态是浏览远端共享的核心
//    用例）、sync pages=groups/status/conflicts 三页）。
// 2. 「即将推出」占位清单（vpn/clash/ai/ssh/screen——[W6] Owner 裁决：无实现
//    仅展示）与「外部 WebUI 插件=后续版本」标注（r2-B6 收口：v1 不加载外部
//    npm WebUI 插件；marketplace CLI 候选不呈现为可启用的 WebUI 插件）。
// 3. 本文件零 IO——纯数据工厂（每调用返回深拷贝对象，防共享可变状态——ports
//    包导出的是模块级常量，files/sync 是工厂函数，统一经 cloneDescriptor 归一）。
// 注：webui 包自身不是自己的 WebUI 插件，故本包不导出 ./opendweb-webui-plugin
// 子路径。宿主面板页（#/p/host/panel）是宿主内建管理面，不参与插件
// 生命周期（UI 侧 plugin-registry.ts 以 managed=false 标记）。

import { descriptor as portsDescriptorSource } from "@jixo/opendweb-ext-ports/opendweb-webui-plugin";
import { filesDescriptor } from "@jixo/opendweb-ext-files/opendweb-webui-plugin";
import { syncWebuiPluginDescriptor } from "@jixo/opendweb-ext-sync/opendweb-webui-plugin";
import { validateWebuiPluginDescriptor } from "./contract.mjs";

/**
 * descriptor 深拷贝（契约字段集冻结：顶层 plain object + pages/routes/
 * dataEndpoints 数组的 plain object 元素——component 位除外（对象/函数，原样
 * 保留——宿主绑定位本就非序列化数据））。
 * @param {import("./contract.mjs").WebuiPluginDescriptor} d
 * @returns {import("./contract.mjs").WebuiPluginDescriptor}
 */
function cloneDescriptor(d) {
  /** @param {unknown} v */
  const clonePage = (v) => {
    if (v === null || typeof v !== "object") return v;
    const p = /** @type {Record<string, unknown>} */ (v);
    const out = {};
    for (const [k, val] of Object.entries(p)) out[k] = val;
    return out;
  };
  return {
    id: d.id,
    webuiApi: d.webuiApi,
    pages: d.pages.map(clonePage),
    ...(d.routes !== undefined ? { routes: d.routes.map(clonePage) } : {}),
    ...(d.dataEndpoints !== undefined ? { dataEndpoints: d.dataEndpoints.map(clonePage) } : {}),
    configSchema: { ...d.configSchema, properties: Object.fromEntries(Object.entries(d.configSchema.properties ?? {}).map(([k, v]) => [k, { ...v }])) },
  };
}

/** 内置三插件 descriptor 工厂（包内 descriptor 为单一事实源）。 */
function portsDescriptor() {
  return cloneDescriptor(portsDescriptorSource);
}

/**
 * 内置 WebUI 插件 descriptor 集（编译期静态注册）。每个 descriptor 在宿主
 * 构造时经 validateWebuiPluginDescriptor 全量校验（fail-fast）。
 * @returns {import("./contract.mjs").WebuiPluginDescriptor[]}
 */
export function builtinWebuiPluginDescriptors() {
  return [portsDescriptor(), cloneDescriptor(filesDescriptor()), cloneDescriptor(syncWebuiPluginDescriptor())];
}

/**
 * 「即将推出」占位清单（[W6]：vpn/clash/ai/ssh/screen——无实现，面板仅展示）。
 * @returns {Array<{ id: string }>}
 */
export function comingSoonPlugins() {
  return [{ id: "vpn" }, { id: "clash" }, { id: "ai" }, { id: "ssh" }, { id: "screen" }];
}

/**
 * 外部 WebUI 插件标注（控制面响应的 external_webui_plugins 槽位；ASCII 纪律）。
 * r2-B6 收口：v1 面板只管理编译内置三插件；安装仅 CLI（[W10]）；CLI 命令插件
 * 不产生可被 webui 启用的插件（两契约分版本并存，安装语义互不冒充）。
 */
export const EXTERNAL_WEBUI_PLUGINS_NOTE =
  "external webui plugins ship in a later version; this panel manages only the built-in ports/files/sync plugins; plugin packages install via the opendweb CLI only (opendweb plugin add installs CLI command plugins, which never appear here as enableable webui plugins)";

/**
 * 内置 descriptor 自检（构造期 fail-fast 用；测试直测）。
 * @param {import("./contract.mjs").WebuiPluginDescriptor[]} descriptors
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function assertDescriptorsValid(descriptors) {
  const ids = new Set();
  for (const d of descriptors) {
    const v = validateWebuiPluginDescriptor(d);
    if (!v.ok) return { ok: false, error: `builtin descriptor "${d?.id}" is invalid: ${v.error}` };
    if (ids.has(d.id)) return { ok: false, error: `duplicate builtin descriptor id "${d.id}"` };
    ids.add(d.id);
  }
  return { ok: true };
}
