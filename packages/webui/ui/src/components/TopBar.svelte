<script lang="ts">
	// ready 世界顶栏（§3.2）：品牌 · 健康灯 · 目标（点击→连接详情面板）+ 主题切换。
	import { Button } from "$lib/components/ui/button";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Separator } from "$lib/components/ui/separator";
	import { ChevronDown, Moon, Sun } from "@lucide/svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import HealthLight from "./HealthLight.svelte";

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
		opendweb<span class="ml-1.5 font-normal text-muted-foreground">服务器控制台</span>
	</span>
	<Separator orientation="vertical" class="mx-1 !h-5" />
	<HealthLight
		error={cs.statusError}
		loading={cs.statusData === null && cs.statusError === null}
	/>
	<div class="flex-1"></div>
	<Button
		variant="outline"
		size="sm"
		onclick={() => cs.toggleDetails()}
		aria-expanded={cs.detailsOpen}
		title="连接详情"
	>
		<span class="font-mono text-xs">{cs.sidecar?.server_host_masked ?? "-"}</span>
		<ChevronDown data-icon="inline-end" class="text-muted-foreground" />
	</Button>
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
</header>

<Dialog.Root
	open={cs.detailsOpen}
	onOpenChange={(v) => cs.toggleDetails(v)}
>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>连接详情</Dialog.Title>
			<Dialog.Description class="sr-only">当前控制台连接的服务器与安全模型</Dialog.Description>
		</Dialog.Header>
		<dl class="flex flex-col gap-4 text-sm">
			<div class="flex flex-col gap-1">
				<dt class="text-muted-foreground">目标</dt>
				<dd class="font-mono text-[13px]">{cs.sidecar?.server_host_masked ?? "-"}</dd>
			</div>
			<div class="flex flex-col gap-1">
				<dt class="text-muted-foreground">安全模型</dt>
				<dd class="leading-relaxed">管理凭证只保存在本地 sidecar 进程内，浏览器不保存、不回显。</dd>
			</div>
			<div class="flex flex-col gap-1">
				<dt class="text-muted-foreground">更换目标</dt>
				<dd class="leading-relaxed">
					目标在本进程生命周期内已锁定。需要连接其他服务器时，退出本页并在终端重新运行启动命令。
				</dd>
			</div>
			{#if cs.sidecar?.insecure === true}
				<div class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
					连接未加密：当前目标经明文 http 传输，管理凭证与管理流量未加密。
				</div>
			{/if}
		</dl>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => cs.toggleDetails(false)}>关闭</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
