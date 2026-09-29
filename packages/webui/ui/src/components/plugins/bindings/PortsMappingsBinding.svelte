<script lang="ts">
	// ports 映射页绑定层（webui-plugin-kernel 收官接线）：store ↔ MappingsPage
	// props 的装配点（组件零 fetch 纪律的编排者侧）。数据=console store 的
	// ports 面（/sidecar/plugins/ports/mappings|allowlist）；动作回传 store。
	import { untrack } from "svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import MappingsPage from "../ports/MappingsPage.svelte";

	let { entry }: { entry?: PluginRouteEntry } = $props();

	$effect(() => {
		untrack(() => void cs.refreshPorts());
	});
</script>

<MappingsPage
	{entry}
	mappings={cs.portsMappings}
	peers={cs.portsPeerOptions}
	error={cs.portsError}
	onCreate={(input) => cs.createPortMapping(input)}
	onToggle={(id, nextEnabled) => cs.togglePortMapping(id, nextEnabled)}
	onDelete={(id) => cs.removePortMapping(id)}
/>
