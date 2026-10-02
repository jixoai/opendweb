<script lang="ts">
	// 应用壳：启动失败面 / setup 世界 / 三视角应用世界（home-hub [H5]）。
	// 副作用生命周期在此接线；状态与动作全部在 console store。
	// 我的中枢视角 = 既有四页（server-access-roles 冻结面零回退）+ 接入卡片卡/
	// 中枢状态卡（总览置顶）；我的租约 / 我的到访 = 单页台账（无侧栏导航）；
	// member 态访问中枢页 → no-hub 诚实页。视角切换 = hash 驱动整页重渲。
	// webui-plugin-kernel Phase 0（r2-B5）：#/p/* → 注册表组件分派（admin=hub 壳
	// 内；member=独立壳）；停用/未知深链 → 基线收敛（#/overview，不残留死页）。
	import { Button } from "$lib/components/ui/button";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import { Toaster } from "$lib/components/ui/sonner";
	import { ArrowRight, RefreshCw } from "@lucide/svelte";
	import { untrack } from "svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import { findPluginRoute } from "$lib/plugin-registry";
	import { pluginPageComponent } from "$lib/plugin-pages";
	import BrandMark from "./components/BrandMark.svelte";
	import SetupWizard from "./components/SetupWizard.svelte";
	import TopBar from "./components/TopBar.svelte";
	import SideNav from "./components/SideNav.svelte";
	import InsecureStrip from "./components/InsecureStrip.svelte";
	import OverviewView from "./components/OverviewView.svelte";
	import TenantsView from "./components/TenantsView.svelte";
	import VisitorsView from "./components/VisitorsView.svelte";
	import OnlineView from "./components/OnlineView.svelte";
	import LeaseView from "./components/LeaseView.svelte";
	import VisitsView from "./components/VisitsView.svelte";
	import NoHubView from "./components/NoHubView.svelte";

	// store 生命周期（hash 监听（含旧路由收敛）+ sidecar state 首拉 + 默认视角裁决）
	// D2 风暴修复：start/$poll 的同步段会读 sidecar/hash 等响应式源——若被本
	// effect 追踪，refreshSidecar 每次赋新对象都会重入 start() → 再拉 state →
	// 无限循环（走查实测 ~800 req/s）。untrack 钉死：挂载期一次性接线，零依赖。
	$effect(() => {
		untrack(() => cs.start());
		return () => cs.stop();
	});

	// 应用世界常驻轮询（admin=在线面 5s + 成员面 3s；member=仅成员面；phase/姿态
	// 翻转时重启；切页不消失）。依赖面只留 appWorld（phase/role 投影）——$poll
	// 同步段对 route/hash 的读取一律 untrack（D2：防 hash/对象引用翻转重入轮询）。
	$effect(() => {
		if (cs.appWorld) untrack(() => cs.$poll());
	});

	// 插件注册表随世界起步首拉（webui-plugin-kernel Phase 0；启停动作后显式刷新，
	// 深链渲染裁决与 SideNav 工具区行依赖它）。同样 untrack（D2 防线同源）。
	$effect(() => {
		if (cs.appWorld) untrack(() => void cs.refreshPlugins());
	});

	// 插件深链收敛（r2-B5 四场景之一）：命中 #/p/<managed> 但服务端 disabled/未知
	// → 按既有未知 hash 收敛语义落 #/overview（不残留死页/错误页）。pending=
	// 服务端状态未加载（深链首拍）——等待，不抢收敛。
	$effect(() => {
		if (cs.pluginDecision !== "converge") return;
		untrack(() => cs.applyHash("#/overview"));
	});

	// 各页数据拉取：中枢四页（admin）进页即拉，动作后各自刷新；租约/到访页由
	// 3s 列表轮询覆盖（首拍在 $poll 内）。
	$effect(() => {
		if (!cs.appWorld || cs.role !== "admin") return;
		const view = cs.route.view;
		if (view === "overview" || view === "tenants") void cs.refreshOwners();
		if (view === "overview") void cs.refreshHub();
		if (view === "tenants") void cs.refreshCodes();
		if (view === "visitors") {
			void cs.refreshKnocks();
			void cs.refreshVisitors();
			void cs.refreshBlocklist();
		}
	});

	const bootLoading = $derived(cs.sidecar === null && cs.sidecarError === null);
	const bootFailed = $derived(cs.sidecar === null && cs.sidecarError !== null);
	const setupWorld = $derived((cs.phase === "setup" && cs.role !== "member") || cs.connectResult?.ok === true);
	// 中枢视角的首页数据条件（admin：四页；member：no-hub）
	const hubPerspective = $derived(cs.perspective === "hub");
	// 插件页分派原料（routeId → 注册表条目 → 编译期组件绑定；缺绑定=fail-fast 抛错）
	const pluginEntry = $derived(cs.route.view === "plugin" ? findPluginRoute(cs.route.routeId) : null);
	const PluginPage = $derived(pluginEntry !== null ? pluginPageComponent(pluginEntry) : null);
</script>

<Toaster position="bottom-right" richColors={false} />

{#if bootFailed}
	<div class="flex min-h-svh items-center justify-center px-6">
		<div class="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-md">
			<BrandMark class="mx-auto mb-4 size-12 opacity-60" />
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
		<div class="flex w-full max-w-md flex-col items-center rounded-lg border bg-card p-8 shadow-md">
			<BrandMark class="mb-4 size-14 animate-pulse" />
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
	<div class="flex min-h-svh flex-col" data-phase="ready" data-role={cs.role} data-perspective={cs.perspective}>
		<TopBar />
		{#if cs.sidecar?.insecure === true && hubPerspective && cs.role === "admin"}
			<InsecureStrip />
		{/if}
		{#if hubPerspective && cs.role === "admin"}
			{#if cs.adminPlaneDown}
				<!-- D4 错误单例（2026-10-02）：管理面凭证级失败=整页降级屏（一条错误
				     + 恢复动作），页面内零逐卡红横幅复制 -->
				<main class="flex flex-1 items-center justify-center px-4 py-10" data-plane="admin-down">
					<div class="w-full max-w-lg rounded-lg border bg-card p-8 text-center shadow-sm">
						<h1 class="text-lg font-semibold">管理凭证已失效</h1>
						<p class="mt-2 text-sm leading-relaxed text-muted-foreground">
							这台服务器的管理凭证已失效或不可用，各页面暂时不可管理；已连接的家人不受影响。
						</p>
						<p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">
							两条恢复路径：点右上角的「节点簿」切换到其他已保存的服务器，或在跑控制台的电脑上重新启动一次。
						</p>
						<div class="mt-6 flex justify-center gap-2">
							<Button onclick={() => cs.toggleDetails()}>
								打开节点簿
								<ArrowRight data-icon="inline-end" />
							</Button>
						</div>
					</div>
				</main>
			{:else}
				<div class="flex flex-1">
					<SideNav />
					<main class="flex-1 px-4 py-6 lg:px-8">
						<div class="mx-auto flex w-full max-w-6xl flex-col gap-6">
							{#if cs.route.view === "overview"}
								<!-- 中枢状态卡与接入卡片移入总览页内（D4：页面身份先于内容，
								     2026-10-02 视觉审计 P0「版式倒置」） -->
								<OverviewView />
							{:else if cs.route.view === "tenants"}
								<TenantsView />
							{:else if cs.route.view === "visitors"}
								<VisitorsView />
							{:else if cs.route.view === "plugin" && pluginEntry !== null && PluginPage !== null}
								<!-- 插件页（admin）：hub 壳内渲染（SideNav 工具区高亮同源） -->
								<PluginPage entry={pluginEntry} />
							{:else}
								<OnlineView />
							{/if}
						</div>
					</main>
				</div>
			{/if}
		{:else if cs.route.view === "plugin" && pluginEntry !== null && pluginPageComponent(pluginEntry) !== null}
			<!-- 插件页（member 姿态的 both 可见页——如插件面板）：独立壳直给 -->
			<main class="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 lg:px-8">
				<PluginPage entry={pluginEntry} />
			</main>
		{:else if cs.route.view === "lease"}
			<!-- 我的租约：单页直给，不虚构层级 -->
			<main class="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 lg:px-8">
				<LeaseView />
			</main>
		{:else if cs.route.view === "visits"}
			<!-- 我的到访：单页直给 -->
			<main class="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 lg:px-8">
				<VisitsView />
			</main>
		{:else}
			<!-- member 态的中枢视角：诚实页（零 admin 概念） -->
			<main class="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-6 lg:px-8">
				<NoHubView />
			</main>
		{/if}
	</div>
{/if}
