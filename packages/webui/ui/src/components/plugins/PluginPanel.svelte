<script lang="ts">
	// 插件面板页（webui-plugin-kernel Phase 0 + D4 极简收束 2026-10-02）：
	// 未启用=一行卡（名 + 一句话 + 启用），零配置表单零芯片；启用后=打开页面
	// 链接 + 「高级设置」折叠（配置表单）。「即将推出」一行紧凑列出；安装/
	// 范围声明收进页头帮助层（视觉审计：README 段落与工程键不该占版面）。
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { ChevronDown } from "@lucide/svelte";
	import ErrorBanner from "../ErrorBanner.svelte";
	import PageHeader from "../PageHeader.svelte";
	import { Folder, Network, Puzzle, RefreshCw, Sparkles } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import PluginConfigForm from "./PluginConfigForm.svelte";

	// entry=App 壳统一分派props（面板为宿主内建面，标题固定——不消费注册表条目）
	let { entry }: { entry?: PluginRouteEntry } = $props();

	/** 内置插件的中文呈现名与一句话说明（展示层映射——契约 descriptor 不承载）。 */
	const META: Record<string, { name: string; blurb: string; icon: typeof Puzzle }> = {
		ports: { name: "端口共享", blurb: "在本机直接打开另一台设备上的服务。", icon: Network },
		files: { name: "文件夹共享", blurb: "在设备之间共享一个文件夹：浏览、上传、下载，可设只读或读写。", icon: Folder },
		sync: { name: "文件同步", blurb: "多台设备之间自动同步文件夹——改动自动合并，合不来的冲突交还给你。", icon: RefreshCw },
		ai: { name: "AI 订阅共享", blurb: "把这台电脑的 AI 额度分享给家人设备，家人在自己设备上直接用。", icon: Sparkles },
	};
	const COMING_SOON_LABEL: Record<string, string> = {
		vpn: "VPN 互联",
		clash: "Clash 代理",
		ssh: "SSH 终端",
		screen: "屏幕共享",
	};

	const data = $derived(cs.pluginsData);
	const plugins = $derived(data?.plugins ?? []);
	const comingSoon = $derived(data?.coming_soon ?? []);

	async function toggle(id: string, status: string) {
		const enabling = status !== "enabled";
		const ok = enabling ? await cs.enablePlugin(id) : await cs.disablePlugin(id);
		if (ok) toast.success(enabling ? "插件已启用" : "插件已停用（在途操作已收敛）");
	}
</script>

<section class="flex flex-col gap-5" data-view="plugin-panel" data-route={entry?.routeId}>
	<PageHeader title="插件" hint="这台设备上开箱即用的能力。">
		{#snippet help()}
			<dl class="grid grid-cols-[96px_1fr] items-baseline gap-x-3 gap-y-1.5">
				<dt class="shrink-0">范围</dt>
				<dd>本面板只管理内置插件；插件包的安装仅经命令行（opendweb plugin add），CLI 安装的命令插件不出现在这里。</dd>
				<dt class="shrink-0">外部插件</dt>
				<dd>外部 WebUI 插件将在后续版本提供。</dd>
				<dt class="shrink-0">即将推出</dt>
				<dd>VPN 互联（设备间虚拟组网）、Clash 代理（网络分流共享）、SSH 终端（远程命令行）、屏幕共享（远程协作）。</dd>
			</dl>
		{/snippet}
	</PageHeader>

	{#if cs.pluginsError !== null}
		<ErrorBanner error={cs.pluginsError} onRetry={() => void cs.refreshPlugins()} />
	{/if}

	{#if data === null && cs.pluginsError === null}
		<p class="text-sm text-muted-foreground">正在载入插件注册表…</p>
	{:else if data === null}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Media variant="icon"><Puzzle /></Empty.Media>
				<Empty.Title>插件面不可用。</Empty.Title>
				<Empty.Description>这个控制台后台没有提供插件控制面（旧版本或未启用本机数据目录）。升级 opendweb-webui 后重试。</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<div class="flex flex-col gap-3">
			{#each plugins as plugin (plugin.id)}
				{@const meta = META[plugin.id] ?? { name: plugin.id, blurb: "", icon: Puzzle }}
				{@const enabled = plugin.status === "enabled"}
				{@const busy = cs.pluginActionBusy === `${plugin.id}:enable` || cs.pluginActionBusy === `${plugin.id}:disable`}
				<Card.Root data-plugin={plugin.id} class="py-4">
					<Card.Content class="flex flex-col gap-3">
						<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
							<meta.icon class="size-4 text-muted-foreground" aria-hidden="true" />
							<span class="text-sm font-semibold">{meta.name}</span>
							{#if enabled}
								<Badge variant="outline" class="border-success/30 bg-success/10 text-success">已启用</Badge>
							{/if}
							<div class="ml-auto flex items-center gap-2">
								{#if enabled && plugin.pages.length > 0}
									<a
										class="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
										href={`#/p/${plugin.id}/${plugin.pages[0].id}`}
									>打开页面 →</a>
								{/if}
								{#if enabled}
									<Button variant="outline" size="sm" disabled={cs.pluginActionBusy !== null} onclick={() => void toggle(plugin.id, plugin.status)}>
										{#if busy}停用中…{:else}停用{/if}
									</Button>
								{:else}
									<Button variant="outline" size="sm" disabled={cs.pluginActionBusy !== null} onclick={() => void toggle(plugin.id, plugin.status)}>
										{#if busy}启用中…{:else}启用{/if}
									</Button>
								{/if}
							</div>
						</div>
						{#if meta.blurb}
							<p class="text-sm leading-relaxed text-muted-foreground">{meta.blurb}</p>
						{/if}
						{#if enabled}
							<details class="group" data-config={plugin.id}>
								<summary class="inline-flex cursor-pointer select-none list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
									<ChevronDown class="size-3 transition-transform group-open:rotate-180" />
									高级设置
								</summary>
								<div class="mt-3">
									<PluginConfigForm {plugin} />
								</div>
							</details>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

		<!-- 即将推出（一行紧凑；无实现仅展示——[W6]） -->
		{#if comingSoon.length > 0}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground" data-coming-soon>
				<span class="text-xs font-medium">即将推出</span>
				{#each comingSoon as item (item.id)}
					<Badge variant="outline" class="border-dashed text-muted-foreground">{COMING_SOON_LABEL[item.id] ?? item.id}</Badge>
				{/each}
			</div>
		{/if}
	{/if}
</section>
