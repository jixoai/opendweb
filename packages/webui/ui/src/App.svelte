<script lang="ts">
	// 应用壳：启动失败面 / setup 世界 / ready 世界（§3.2 结构图）。
	// 副作用生命周期在此接线；状态与动作全部在 console store。
	import { Button } from "$lib/components/ui/button";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import { Toaster } from "$lib/components/ui/sonner";
	import { RefreshCw } from "@lucide/svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import SetupWizard from "./components/SetupWizard.svelte";
	import TopBar from "./components/TopBar.svelte";
	import SideNav from "./components/SideNav.svelte";
	import InsecureStrip from "./components/InsecureStrip.svelte";
	import OverviewView from "./components/OverviewView.svelte";
	import AccessView from "./components/AccessView.svelte";

	// store 生命周期（hash 监听 + sidecar state 首拉）
	$effect(() => {
		cs.start();
		return () => cs.stop();
	});

	// ready 态常驻轮询（phase 翻转时重启；切页不消失，5s 驱动顶栏健康灯）
	$effect(() => {
		if (cs.phase === "ready") cs.$poll();
	});

	// 旧路由 #/connect 在 ready 态收敛为「总览 + 连接详情面板」（§3.1 裁决 1）
	$effect(() => {
		if (cs.route.panel === true && cs.phase === "ready") cs.toggleDetails(true);
	});

	// 名册拉取：总览需要所有者计数；名册视角需要列表——两处共享同一 state
	$effect(() => {
		if (
			cs.phase === "ready" &&
			(cs.route.view === "overview" || (cs.route.view === "access" && cs.route.section === "roster"))
		) {
			void cs.refreshOwners();
		}
	});

	const bootLoading = $derived(cs.sidecar === null && cs.sidecarError === null);
	const bootFailed = $derived(cs.sidecar === null && cs.sidecarError !== null);
	const setupWorld = $derived(cs.phase === "setup" || cs.connectResult?.ok === true);
</script>

<Toaster position="bottom-right" richColors={false} />

{#if bootFailed}
	<div class="flex min-h-svh items-center justify-center px-6">
		<div class="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
			<h1 class="text-lg font-semibold">控制台后台没有响应</h1>
			<p class="mt-2 text-sm leading-relaxed text-muted-foreground">
				本地 sidecar 进程可能已退出。请回到终端查看输出，或重新运行启动命令打开新页面。
			</p>
			<Button variant="outline" class="mt-6" onclick={() => void cs.refreshSidecar()}>
				<RefreshCw data-icon="inline-start" />
				重试
			</Button>
		</div>
	</div>
{:else if bootLoading}
	<div class="flex min-h-svh items-center justify-center px-6">
		<div class="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">
			<h1 class="text-lg font-semibold">正在连接服务器…</h1>
			<div class="mt-4 flex flex-col gap-2">
				<Skeleton class="h-4 w-3/4" />
				<Skeleton class="h-4 w-1/2" />
				<Skeleton class="h-4 w-2/3" />
			</div>
		</div>
	</div>
{:else if setupWorld}
	<SetupWizard />
{:else}
	<div class="flex min-h-svh flex-col" data-phase="ready">
		<TopBar />
		{#if cs.sidecar?.insecure === true}
			<InsecureStrip />
		{/if}
		<div class="flex flex-1">
			<SideNav />
			<main class="flex-1 px-4 py-6 lg:px-8">
				<div class="mx-auto flex w-full max-w-6xl flex-col">
					{#if cs.route.view === "overview"}
						<OverviewView />
					{:else}
						<AccessView />
					{/if}
				</div>
			</main>
		</div>
	</div>
{/if}
