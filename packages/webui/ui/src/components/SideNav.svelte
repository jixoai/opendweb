<script lang="ts">
	// 左侧导航（§3.2 方向 B）：总览 / 访问管理；为未来 owner-console 预留槽位
	// （当前不渲染）。
	import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import { consoleStore as cs } from "$lib/console.svelte";
	import { cn } from "$lib/utils";

	const items = [
		{ hash: "#/", label: "总览", icon: LayoutDashboard, active: () => cs.route.view === "overview" },
		{
			hash: "#/access",
			label: "访问管理",
			icon: ShieldCheck,
			active: () => cs.route.view === "access",
		},
	];
</script>

<aside class="hidden w-56 shrink-0 border-r bg-sidebar md:block">
	<nav class="flex flex-col gap-1 p-3" aria-label="控制台导航">
		{#each items as item (item.hash)}
			<a
				href={item.hash}
				class={cn(
					"flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
					item.active()
						? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
						: "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
				)}
				aria-current={item.active() ? "page" : undefined}
			>
				<item.icon class="size-4" />
				{item.label}
			</a>
		{/each}
	</nav>
</aside>
