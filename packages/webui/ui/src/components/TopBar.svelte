<script lang="ts">
	// 应用顶栏（三视角共用外壳；jixoai 法则 2026-10-03：终端条恒深色 chrome——
	// 浅色模式也保持深底；品牌位 = opendweb icon + Share Tech Mono 字标）。
	// 健康灯/节点簿（admin 概念）只在「我的中枢」视角呈现。
	import { Button } from "$lib/components/ui/button";
	import { Separator } from "$lib/components/ui/separator";
	import { ChevronDown, Moon, Sun } from "@lucide/svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import BrandMark from "./BrandMark.svelte";
	import HealthLight from "./HealthLight.svelte";
	import NodeBook from "./NodeBook.svelte";
	import PerspectiveSwitcher from "./PerspectiveSwitcher.svelte";

	// 初始态以 localStorage 为真源（index.html boot 内联脚本已首帧前应用类；
	// 无 localStorage 权限时退回读当前类）。
	function initialTheme(): "light" | "dark" {
		if (typeof document === "undefined") return "light";
		try {
			return localStorage.getItem("opendweb-webui-theme") === "dark" ? "dark" : "light";
		} catch {
			return document.documentElement.classList.contains("dark") ? "dark" : "light";
		}
	}
	let theme = $state<"light" | "dark">(initialTheme());

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
	class="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-terminal-foreground/20 bg-terminal px-4 text-terminal-foreground lg:px-6"
>
	<span class="flex items-center gap-2.5">
		<BrandMark class="size-6 shrink-0" />
		<span class="font-nav text-base tracking-wide">
			opendweb<span class="ml-1.5 font-mono text-xs font-normal text-terminal-muted">控制台</span>
		</span>
	</span>
	{#if cs.perspective === "hub"}
		<Separator orientation="vertical" class="mx-1 !h-5 !bg-terminal-foreground/20" />
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
			class="border-terminal-foreground/30 bg-transparent text-terminal-foreground hover:bg-terminal-hover hover:text-terminal-foreground"
			onclick={() => cs.toggleDetails()}
			aria-expanded={cs.detailsOpen}
			title="节点簿"
		>
			<span class="text-xs">节点簿</span>
			<span class="max-w-44 truncate font-mono text-xs text-terminal-muted">{cs.sidecar?.server_host_masked ?? "-"}</span>
			<ChevronDown data-icon="inline-end" />
		</Button>
	{/if}
	<Button
		variant="ghost"
		size="icon"
		class="text-terminal-foreground hover:bg-terminal-hover hover:text-terminal-foreground"
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
