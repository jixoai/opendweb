<script lang="ts">
	// ai 提供方页绑定层（ai-subscription-sharing Phase C）：controller ↔ 页面的
	// 装配点——挂载即刷新提供方数据面（overview/presets/usage）；页面零 fetch。
	import { untrack } from "svelte";
	import { aiController as ctl } from "$lib/plugins-ai-controller.svelte";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import ProviderPage from "../ai/ProviderPage.svelte";

	let { entry }: { entry?: PluginRouteEntry } = $props();

	$effect(() => {
		untrack(() => void ctl.refreshProvider());
	});
</script>

<ProviderPage {entry} {ctl} />
