// 编译期静态注册表（webui-plugin-kernel Phase 0 / design §2.1、§2.2）。
// 意图（2026-09-29）：
// 1. 内置三插件（ports/files/sync）的占位 descriptor——经 contract 校验后由
//    PluginHost 静态注册；运行时（listener/wire 端点/账本逻辑）在 Phase 1-3
//    接入（tasks §2-§4）。descriptor 先行冻结页声明与配置面形状。
// 2. 「即将推出」占位清单（vpn/clash/ai/ssh/screen——[W6] Owner 裁决：无实现
//    仅展示）与「外部 WebUI 插件=后续版本」标注（r2-B6 收口：v1 不加载外部
//    npm WebUI 插件；marketplace CLI 候选不呈现为可启用的 WebUI 插件）。
// 3. 本文件零 IO——纯数据工厂（每调用返回新对象，防共享可变状态）。
// 注：webui 包自身不是自己的 WebUI 插件，故本包不导出 ./opendweb-webui-plugin
// 子路径；第一个真实导出者是 Phase 1 的 @jixo/opendweb-ext-ports（契约见
// contract.mjs）。宿主面板页（#/p/host/panel）是宿主内建管理面，不参与插件
// 生命周期（UI 侧 plugin-registry.ts 以 managed=false 标记）。

import { validateWebuiPluginDescriptor } from "./contract.mjs";

/** 内置三插件的页声明（nav=tools → SideNav「工具」区；settings=通用 renderer） */
function portsDescriptor() {
  return {
    id: "ports",
    webuiApi: 1,
    pages: [{ id: "mappings", title: "端口映射", nav: "tools", icon: "network", type: "settings", perspective: "admin" }],
    configSchema: { type: "object", properties: {}, required: [] },
  };
}

function filesDescriptor() {
  return {
    id: "files",
    webuiApi: 1,
    pages: [{ id: "browser", title: "文件浏览", nav: "tools", icon: "folder", type: "settings", perspective: "admin" }],
    configSchema: { type: "object", properties: {}, required: [] },
  };
}

function syncDescriptor() {
  return {
    id: "sync",
    webuiApi: 1,
    pages: [{ id: "groups", title: "同步组", nav: "tools", icon: "refresh", type: "settings", perspective: "admin" }],
    configSchema: { type: "object", properties: {}, required: [] },
  };
}

/**
 * 内置 WebUI 插件 descriptor 集（编译期静态注册）。每个 descriptor 在宿主
 * 构造时经 validateWebuiPluginDescriptor 全量校验（fail-fast）。
 * @returns {import("./contract.mjs").WebuiPluginDescriptor[]}
 */
export function builtinWebuiPluginDescriptors() {
  return [portsDescriptor(), filesDescriptor(), syncDescriptor()];
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
