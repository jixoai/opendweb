<script lang="ts">
	// 左侧导航（server-access-roles IA：四页）：总览 / 租户管理 / 访客与门禁（待办
	// 徽章同源 status.knocks_pending）/ 在线连接。节点簿不占侧栏位（顶栏呼出）。
	// webui-plugin-kernel Phase 0：增「工具」区（r2-B5——插件路由注册表的 tools
	// 行；按视角可见性过滤，受管插件须服务端 enabled 才出现，防死链弹跳）。
	import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
	import Building2 from "@lucide/svelte/icons/building-2";
	import ShieldCheck from "@lucide/svelte/icons/shield-check";
	import Network from "@lucide/svelte/icons/network";
	import Puzzle from "@lucide/svelte/icons/puzzle";
	import Folder from "@lucide/svelte/icons/folder";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import Sparkles from "@lucide/svelte/icons/sparkles";
	import Bot from "@lucide/svelte/icons/bot";
	import { consoleStore as cs } from "$lib/console.svelte";
	import { pluginNavRows } from "$lib/plugin-registry";
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

	/** 工具区图标映射（注册表 icon 名 → 组件；未知名回退拼图）。 */
	const TOOL_ICONS: Record<string, typeof Puzzle> = {
		puzzle: Puzzle,
		network: Network,
		folder: Folder,
		refresh: RefreshCw,
		sparkles: Sparkles,
		bot: Bot,
	};

	const activeRouteId = $derived(cs.route.view === "plugin" ? cs.route.routeId : null);
	const toolRows = $derived(pluginNavRows(cs.role, cs.pluginsData, activeRouteId));
</script>

<aside class="hidden w-56 shrink-0 border-r bg-sidebar md:block">
	<nav class="flex h-full flex-col gap-1 p-3" aria-label="控制台导航">
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

		{#if toolRows.length > 0}
			<div class="mt-2 flex flex-col gap-1 border-t pt-3" data-nav-area="tools">
				<p class="px-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground/70">工具</p>
				{#each toolRows as row (row.routeId)}
					{@const Icon = TOOL_ICONS[row.icon ?? ""] ?? Puzzle}
					<a
						href={row.hash}
						class={cn(
							"flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
							row.routeId === activeRouteId
								? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
								: "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
						)}
						aria-current={row.routeId === activeRouteId ? "page" : undefined}
					>
						<Icon class="size-4" />
						{row.title}
					</a>
				{/each}
			</div>
		{/if}
	</nav>
</aside>
