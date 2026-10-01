<script lang="ts">
	// 插件面板页（webui-plugin-kernel Phase 0——宿主内建管理面 #/p/host/panel，
	// r2-B6 冻结范围）：内置插件（ports/files/sync/ai——ai 自 Phase C 入册）启停/
	// 配置 + 「即将推出」占位（vpn/clash/ssh/screen——[W6] 无实现仅展示）+
	// 「外部 WebUI 插件=后续版本」标注。marketplace 的 CLI 插件候选不呈现为可
	// 安装/可启用（CLI 插件清单是独立入口；`opendweb plugin add` 安装的命令
	// 插件不出现在这里）。
	// 面板不触发 npm 安装（[W10]——安装仅 CLI）。
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Separator } from "$lib/components/ui/separator";
	import ErrorBanner from "../ErrorBanner.svelte";
	import { Puzzle, Folder, Network, RefreshCw, Sparkles } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import PluginConfigForm from "./PluginConfigForm.svelte";

	// entry=App 壳统一分派props（面板为宿主内建面，标题固定——不消费注册表条目）
	let { entry }: { entry?: PluginRouteEntry } = $props();

	/** 内置插件的中文呈现名与一句话说明（展示层映射——契约 descriptor 不承载）。 */
	const META: Record<string, { name: string; blurb: string; icon: typeof Puzzle }> = {
		ports: { name: "端口共享", blurb: "把另一台设备的本地端口映射到本机——B:9090 等同 A:8080。", icon: Network },
		files: { name: "文件夹共享", blurb: "在设备之间共享一个文件夹——浏览、上传、下载，可设只读或读写。", icon: Folder },
		sync: { name: "文件同步", blurb: "多台设备间同步 agents-skills、prompt、wiki 与配置，自动合并、冲突交还。", icon: RefreshCw },
		ai: { name: "AI 订阅共享", blurb: "把本机 AI 订阅共享给家庭设备：提供方配服务签密钥，消费方贴链接起本地端点。", icon: Sparkles },
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

	function statusBadge(status: string) {
		if (status === "enabled") return { text: "已启用", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
		if (status === "disabled") return { text: "已停用", cls: "border-muted-foreground/30 bg-muted text-muted-foreground" };
		return { text: "未启用", cls: "border-muted-foreground/30 bg-muted text-muted-foreground" };
	}

	async function toggle(id: string, status: string) {
		const enabling = status !== "enabled";
		const ok = enabling ? await cs.enablePlugin(id) : await cs.disablePlugin(id);
		if (ok) toast.success(enabling ? "插件已启用" : "插件已停用（在途操作已收敛）");
	}
</script>

<section class="flex flex-col gap-5" data-view="plugin-panel" data-route={entry?.routeId}>
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">插件面板</h2>
		<p class="text-sm text-muted-foreground">这台设备上的 WebUI 插件——启停、配置与即将推出的能力。</p>
	</div>

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
		<!-- 内置三插件：启停 + 配置 -->
		<div class="flex flex-col gap-4">
			{#each plugins as plugin (plugin.id)}
				{@const meta = META[plugin.id] ?? { name: plugin.id, blurb: "", icon: Puzzle }}
				{@const badge = statusBadge(plugin.status)}
				{@const busy = cs.pluginActionBusy === `${plugin.id}:enable` || cs.pluginActionBusy === `${plugin.id}:disable`}
				<Card.Root data-plugin={plugin.id}>
					<Card.Header>
						<Card.Title class="flex items-center gap-2.5">
							<meta.icon class="size-4 text-muted-foreground" />
							{meta.name}
							<span class="font-mono text-xs font-normal text-muted-foreground">{plugin.id}</span>
							<Badge variant="outline" class={badge.cls}>{badge.text}</Badge>
						</Card.Title>
						{#if meta.blurb}
							<Card.Description>{meta.blurb}</Card.Description>
						{/if}
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						<div class="flex flex-wrap items-center gap-2">
							{#if plugin.status === "enabled"}
								<Button size="sm" variant="outline" disabled={cs.pluginActionBusy !== null} onclick={() => void toggle(plugin.id, plugin.status)}>
									{#if busy}停用中——等待在途操作收敛…{:else}停用{/if}
								</Button>
							{:else}
								<Button size="sm" disabled={cs.pluginActionBusy !== null} onclick={() => void toggle(plugin.id, plugin.status)}>
									{#if busy}启用中…{:else}启用{/if}
								</Button>
							{/if}
							{#if plugin.status === "registered"}
								<span class="text-xs text-muted-foreground">启用后即可在「工具」区进入插件页面。</span>
							{:else if plugin.status === "enabled" && plugin.pages.length > 0}
								<a
									class="text-xs text-muted-foreground underline-offset-2 hover:underline"
									href={`#/p/${plugin.id}/${plugin.pages[0].id}`}
								>打开插件页面 →</a>
							{/if}
						</div>
						<Separator />
						<div class="flex flex-col gap-2">
							<p class="text-xs font-medium text-muted-foreground">配置</p>
							<PluginConfigForm {plugin} />
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>

		<!-- 即将推出（[W6]：无实现仅展示——不可启停/配置） -->
		<div class="flex flex-col gap-3">
			<h3 class="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
				<Sparkles class="size-4" />
				即将推出
			</h3>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each comingSoon as item (item.id)}
					<div class="rounded-lg border border-dashed bg-muted/30 p-4" data-coming-soon={item.id}>
						<p class="flex items-center gap-2 text-sm font-medium text-muted-foreground">
							{COMING_SOON_LABEL[item.id] ?? item.id}
							<Badge variant="outline" class="border-muted-foreground/30 text-muted-foreground">即将推出</Badge>
						</p>
					</div>
				{/each}
			</div>
		</div>

		<!-- 外部 WebUI 插件标注（r2-B6：v1 只管理编译内置插件；安装仅 CLI） -->
		<p class="text-xs leading-relaxed text-muted-foreground" data-external-note>
			外部 WebUI 插件将在后续版本提供——本面板只管理内置的端口共享、文件夹共享、文件同步与 AI 订阅共享。插件包的安装仅经命令行（opendweb plugin add）；CLI 安装的命令插件不会出现在这里，也不能在 WebUI 中启用。
		</p>
	{/if}
</section>
