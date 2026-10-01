// 插件页组件绑定表（webui-plugin-kernel Phase 0 / design §2.1 r2-B5；收官接线
// 升级为绑定层组件）。routeId → Svelte 组件的编译期映射（「复杂页=插件专属
// Svelte 组件编入同一 bundle」；无运行时远程 bundle/iframe/动态导入 [P2]）。
// 本文件含 Svelte 导入——node --test 纯逻辑测试不得 import（路由形状/裁决在
// plugin-registry.ts）。host/panel=宿主内建管理面；三插件页=绑定层组件
// （bindings/*：store ↔ 页面 props 的装配点——页面组件零 fetch 纪律不变，
// 数据/动作经绑定层注入，App 壳只分派绑定层）。

import PluginPanel from "../components/plugins/PluginPanel.svelte";
import PortsMappingsBinding from "../components/plugins/bindings/PortsMappingsBinding.svelte";
import FilesBrowserBinding from "../components/plugins/bindings/FilesBrowserBinding.svelte";
import SyncGroupsBinding from "../components/plugins/bindings/SyncGroupsBinding.svelte";
import SyncStatusBinding from "../components/plugins/bindings/SyncStatusBinding.svelte";
import SyncConflictsBinding from "../components/plugins/bindings/SyncConflictsBinding.svelte";
import AiProviderBinding from "../components/plugins/bindings/AiProviderBinding.svelte";
import AiConsumerBinding from "../components/plugins/bindings/AiConsumerBinding.svelte";
import type { PluginRouteEntry } from "./plugin-registry";

/** 组件类型（Svelte 5 组件构造形态）。 */
type SvelteComponentLike = new (...args: never[]) => unknown;

/** routeId → 组件。插件页=绑定层（真实数据渲染路径：store → 页面 props）。 */
export const PLUGIN_PAGE_COMPONENTS: Record<string, SvelteComponentLike> = {
	"#/p/host/panel": PluginPanel as SvelteComponentLike,
	"#/p/ports/mappings": PortsMappingsBinding as SvelteComponentLike,
	"#/p/files/browser": FilesBrowserBinding as SvelteComponentLike,
	"#/p/sync/groups": SyncGroupsBinding as SvelteComponentLike,
	"#/p/sync/status": SyncStatusBinding as SvelteComponentLike,
	"#/p/sync/conflicts": SyncConflictsBinding as SvelteComponentLike,
	"#/p/ai/provider": AiProviderBinding as SvelteComponentLike,
	"#/p/ai/consumer": AiConsumerBinding as SvelteComponentLike,
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
