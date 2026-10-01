<script lang="ts">
	// ai 消费方页绑定层（ai-subscription-sharing Phase C）：controller ↔ 页面的
	// 装配点——挂载即刷新钥环/端点数据面；页面零 fetch。
	import { untrack } from "svelte";
	import { aiController as ctl } from "$lib/plugins-ai-controller.svelte";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import ConsumerPage from "../ai/ConsumerPage.svelte";

	let { entry }: { entry?: PluginRouteEntry } = $props();

	$effect(() => {
		untrack(() => void ctl.refreshConsumer());
	});
</script>

<ConsumerPage {entry} {ctl} />
