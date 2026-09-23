<script lang="ts">
	// 应用顶栏（三视角共用外壳，home-hub [H5]）：品牌 · 健康灯 · 当前节点（点击→
	// 节点簿面板）+ 主题切换 + 视角切换器（顶栏最右=全局身份锚点）。租约/到访
	// 视角导航区收起：健康灯/节点簿（admin 概念）只在「我的中枢」视角呈现。
	import { Button } from "$lib/components/ui/button";
	import { Separator } from "$lib/components/ui/separator";
	import { ChevronDown, Moon, Sun } from "@lucide/svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import HealthLight from "./HealthLight.svelte";
	import NodeBook from "./NodeBook.svelte";
	import PerspectiveSwitcher from "./PerspectiveSwitcher.svelte";

	let theme = $state<"light" | "dark">(
		typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light",
	);

	function toggleTheme(): void {
		theme = theme === "dark" ? "light" : "dark";
		document.documentElement.classList.toggle("dark", theme === "dark");
		try {
			localStorage.setItem("opendweb-webui-theme", theme);
		} catch {
			// 无 localStorage 权限：主题偏好不持久化（会话内仍生效）
		}
	}
</script>

<header
	class="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur lg:px-6"
>
	<span class="text-sm font-semibold tracking-tight">
		opendweb<span class="ml-1.5 font-normal text-muted-foreground">控制台</span>
	</span>
	{#if cs.perspective === "hub"}
		<Separator orientation="vertical" class="mx-1 !h-5" />
		<HealthLight
			error={cs.statusError}
			loading={cs.statusData === null && cs.statusError === null}
		/>
	{/if}
	<div class="flex-1"></div>
	{#if cs.perspective === "hub" && cs.role === "admin"}
		<Button
			variant="outline"
			size="sm"
			onclick={() => cs.toggleDetails()}
			aria-expanded={cs.detailsOpen}
			title="节点簿"
		>
			<span class="font-mono text-xs">{cs.sidecar?.server_host_masked ?? "-"}</span>
			<ChevronDown data-icon="inline-end" class="text-muted-foreground" />
		</Button>
	{/if}
	<Button
		variant="ghost"
		size="icon"
		onclick={toggleTheme}
		title={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
		aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
	>
		{#if theme === "dark"}
			<Sun />
		{:else}
			<Moon />
		{/if}
	</Button>
	<PerspectiveSwitcher />
</header>

{#if cs.perspective === "hub" && cs.role === "admin"}
	<NodeBook />
{/if}
