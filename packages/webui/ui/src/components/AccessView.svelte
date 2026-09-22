<script lang="ts">
	// 访问管理页（一页两视角）：名册 ⇄ 在线（对象互链的宿主页）。
	// section 切换经 hash（#/access/roster | #/access/online）——可前进后退。
	import * as Tabs from "$lib/components/ui/tabs";
	import { consoleStore as cs } from "$lib/console.svelte";
	import RosterView from "./RosterView.svelte";
	import OnlineView from "./OnlineView.svelte";

	const section = $derived(cs.route.view === "access" ? cs.route.section : "roster");
</script>

<section class="flex flex-col gap-5" data-view="access">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">访问管理</h2>
		<p class="text-sm text-muted-foreground">
			谁能用这台服务器（名册）、谁正在用（在线）——同一对象的两个视角。
		</p>
	</div>

	<Tabs.Root value={section} onValueChange={(v) => cs.changeSection(v as "roster" | "online")}>
		<Tabs.List>
			<Tabs.Trigger value="roster">所有者名册</Tabs.Trigger>
			<Tabs.Trigger value="online">在线连接</Tabs.Trigger>
		</Tabs.List>
	</Tabs.Root>

	{#if section === "roster"}
		<RosterView />
	{:else}
		<OnlineView />
	{/if}
</section>
