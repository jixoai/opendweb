// 插件页组件绑定表（webui-plugin-kernel Phase 0 / design §2.1 r2-B5）。
// routeId → Svelte 组件的编译期映射（「复杂页=插件专属 Svelte 组件编入同一
// bundle」；无运行时远程 bundle/iframe/动态导入 [P2]）。本文件含 Svelte 导入
// ——node --test 纯逻辑测试不得 import（路由形状/裁决在 plugin-registry.ts）。
// host/panel=宿主内建管理面；其余 settings 页=通用 renderer。

import PluginPanel from "../components/plugins/PluginPanel.svelte";
import PluginSettingsPage from "../components/plugins/PluginSettingsPage.svelte";
import type { PluginRouteEntry } from "./plugin-registry";

/** 组件类型（Svelte 5 组件构造形态）。 */
type SvelteComponentLike = new (...args: never[]) => unknown;

/** routeId → 组件。settings 页统一通用 renderer（entry 作 props）；面板专属组件。 */
export const PLUGIN_PAGE_COMPONENTS: Record<string, SvelteComponentLike> = {
  "#/p/host/panel": PluginPanel as SvelteComponentLike,
  "#/p/ports/mappings": PluginSettingsPage as SvelteComponentLike,
  "#/p/files/browser": PluginSettingsPage as SvelteComponentLike,
  "#/p/sync/groups": PluginSettingsPage as SvelteComponentLike,
};

/**
 * 取组件（注册表命中但缺组件绑定=编程错误——编译期装配漏项，fail-fast）。
 * @param entry findPluginRoute 命中的注册表条目
 */
export function pluginPageComponent(entry: PluginRouteEntry): SvelteComponentLike {
  const component = PLUGIN_PAGE_COMPONENTS[entry.routeId];
  if (component === undefined) {
    throw new Error(`plugin route ${entry.routeId} has no compiled component binding (PLUGIN_PAGE_COMPONENTS)`);
  }
  return component;
}
