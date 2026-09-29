<script lang="ts">
	// 插件通用 settings 页（webui-plugin-kernel Phase 0——design §2.1「通用
	// renderer 只承载简单配置/表格页」）。Phase 0 内置三插件的页面均为本形态：
	// 页面可达性由路由协议保证（命中且 enabled），内容=插件状态 + 诚实占位
	// （运行时在 Phase 1-3 接入）+ 配置表单（与面板共用 PluginConfigForm）。
	// 深链刷新=注册表重放（本组件经 App 壳按 routeId 分派——渲染前提已由
	// pluginRouteDecision 保证 enabled）。
	import * as Card from "$lib/components/ui/card";
	import { Badge } from "$lib/components/ui/badge";
	import { Separator } from "$lib/components/ui/separator";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import ErrorBanner from "../ErrorBanner.svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import PluginConfigForm from "./PluginConfigForm.svelte";

	let { entry }: { entry: PluginRouteEntry } = $props();

	const plugin = $derived(cs.pluginsData?.plugins.find((p) => p.id === entry.pluginId) ?? null);
</script>

<section class="flex flex-col gap-5" data-view="plugin-page" data-plugin={entry.pluginId} data-plugin-page={entry.pageId}>
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">{entry.title}</h2>
		<p class="text-sm text-muted-foreground">
			插件 <span class="font-mono text-xs">{entry.pluginId}</span> 的页面——由插件系统提供。
		</p>
	</div>

	{#if cs.pluginsError !== null}
		<ErrorBanner error={cs.pluginsError} onRetry={() => void cs.refreshPlugins()} />
	{/if}

	{#if plugin === null}
		<div class="flex flex-col gap-3">
			<Skeleton class="h-5 w-40" />
			<Skeleton class="h-4 w-64" />
		</div>
	{:else}
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2.5">
					{entry.title}
					<Badge variant="outline" class="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">已启用</Badge>
				</Card.Title>
				<Card.Description>
					此插件的完整功能界面随运行时在后续版本接入；当前可在这里启停（插件面板）与调整配置。
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<a class="text-xs text-muted-foreground underline-offset-2 hover:underline" href="#/p/host/panel">
					在插件面板中启停此插件 →
				</a>
				<Separator />
				<div class="flex flex-col gap-2">
					<p class="text-xs font-medium text-muted-foreground">配置</p>
					<PluginConfigForm {plugin} />
				</div>
			</Card.Content>
		</Card.Root>
	{/if}
</section>
