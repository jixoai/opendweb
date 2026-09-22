<script lang="ts">
	// 左侧导航（server-access-roles IA：四页）：总览 / 租户管理 / 访客与门禁（待办
	// 徽章同源 status.knocks_pending）/ 在线连接。节点簿不占侧栏位（顶栏呼出）。
	import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
	import Building2 from "@lucide/svelte/icons/building-2";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import Network from "@lucide/svelte/icons/network";
	import { consoleStore as cs } from "$lib/console.svelte";
	import { cn } from "$lib/utils";

	const items = [
		{ hash: "#/overview", label: "总览", icon: LayoutDashboard, active: () => cs.route.view === "overview" },
		{ hash: "#/tenants", label: "租户管理", icon: Building2, active: () => cs.route.view === "tenants" },
		{
			hash: "#/visitors",
			label: "访客与门禁",
			icon: ShieldCheck,
			active: () => cs.route.view === "visitors",
			badge: () => cs.knocksPending,
		},
		{ hash: "#/online", label: "在线连接", icon: Network, active: () => cs.route.view === "online" },
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
				{#if item.badge !== undefined && item.badge() > 0}
					<span
						class="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning/15 px-1.5 font-mono text-xs font-semibold text-warning"
						title="有设备在敲门，等待处置"
					>
						{item.badge()}
					</span>
				{/if}
			</a>
		{/each}
	</nav>
</aside>
