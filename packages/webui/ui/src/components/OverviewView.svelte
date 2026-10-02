<script lang="ts">
	// ready 世界 · 总览（D4 极简收束 2026-10-02 重排：一屏一事=「家里状态」）。
	// 顺序：页头（题+帮助层）→ 状态行（正常/中枢未运行 + 敲门待办）→ 家人怎么连
	// （分享主卡）→ 四问紧凑数字行 → 空名册引导。配置投影与术语全部收进帮助层
	// （视觉审计 P0「版式倒置」/A3「说明文当界面」/A7「卡片同质化」）。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import * as Empty from "$lib/components/ui/empty";
	import { ArrowRight, KeyRound, Users } from "@lucide/svelte";
	import { modeBadge, policyLabel } from "$lib/terms";
	import { errorCopy } from "$lib/copy";
	import { fmtClock, leaseState } from "$lib/format";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import HubAccessCard from "./HubAccessCard.svelte";
	import HubStatusCard from "./HubStatusCard.svelte";
	import PageHeader from "./PageHeader.svelte";

	const active = $derived(
		Array.isArray(cs.overviewData?.active_connections) ? cs.overviewData!.active_connections : [],
	);
	// 租户计数真源 = 名册列表（ownersData）——status 的 per_owner_connections
	// 是「有活跃连接的租户」在线投影（0 连接即空），不是名册计数。
	const owners = $derived(Array.isArray(cs.ownersData?.owners) ? cs.ownersData!.owners : []);
	const ownersLoaded = $derived(Array.isArray(cs.ownersData?.owners));
	const totalConns = $derived(active.reduce((n, e) => n + (Number(e?.connections) || 0), 0));
	const mode = $derived(modeBadge(cs.overviewData?.mode));
	// 凭证级失败已由 App 层整页降级屏承接——这里只剩瞬时网络错误
	const hasError = $derived(cs.overviewError !== null && cs.overviewError !== undefined);
	const retryable = $derived(hasError && cs.overviewError !== null ? errorCopy(cs.overviewError).retry : false);
	const loading = $derived(cs.overviewData === null && !hasError);
	// 待处理敲门（状态行待办位 / 侧栏徽章 / 敲门台三处同一数据源）
	const knocksPending = $derived(cs.knocksPending);
	// 访客在线（status 增量；旧服务端无此字段 = 未知「-」）
	const visitorsOnline = $derived(
		typeof cs.overviewData?.visitors_online === "number" ? cs.overviewData.visitors_online : null,
	);
	// 租期临期预警：名册内 7 天内到期（或已到期）的租户数
	const expiringCount = $derived(
		owners.filter((o) => {
			const lease = leaseState(typeof o.expires_at === "number" ? o.expires_at : null);
			return lease.state === "expiring" || lease.state === "expired";
		}).length,
	);
	const codesActive = $derived(
		typeof cs.overviewData?.codes_active === "number" ? cs.overviewData.codes_active : null,
	);
</script>

<section class="flex flex-col gap-6" data-view="overview">
	<PageHeader title="总览">
		{#snippet help()}
			<dl class="grid grid-cols-[110px_1fr] items-baseline gap-x-3 gap-y-1.5">
				<dt class="shrink-0">配置</dt>
				<dd>
					准入策略：{policyLabel(cs.overviewData?.policy)} · 每租户连接上限：{cs.overviewData?.max_connections_per_owner ?? "未设置"}
					· 中继：{cs.overviewData?.relay_enabled === true ? "已启用" : cs.overviewData?.relay_enabled === false ? "未启用" : "-"}
				</dd>
				<dt class="shrink-0">名册版本</dt>
				<dd>v{cs.overviewData?.generation ?? "-"}——每次名册变更后加 1，用于确认变更已生效。</dd>
				<dt class="shrink-0">安全承诺</dt>
				<dd>管理凭证只交给本地后台进程，浏览器不保存、不回显；家人互传的数据走设备直连，不经过这台机器。</dd>
				{#if mode !== null}
					<dt class="shrink-0">准入模式</dt>
					<dd>{mode.label}——{mode.title}</dd>
				{/if}
			</dl>
		{/snippet}
	</PageHeader>

	<!-- 状态行：正常/未运行 + 敲门待办（一屏一事的「那件事」） -->
	{#if cs.hubLocal && cs.hubData?.running === false}
		<HubStatusCard />
	{:else if hasError && cs.overviewError !== null}
		<div class="flex flex-col gap-1">
			<ErrorBanner error={cs.overviewError} onRetry={retryable ? () => void cs.refreshStatus() : undefined} />
			{#if retryable}
				<p class="text-xs text-muted-foreground">
					自动重试中{cs.statusLastFailAt != null ? `（上次失败 ${fmtClock(cs.statusLastFailAt)}）` : ""}。
				</p>
			{/if}
		</div>
	{:else if loading}
		<Card.Root class="py-4">
			<Card.Content class="flex flex-row items-center gap-3">
				<span class="size-2.5 animate-pulse rounded-full bg-muted-foreground/50" aria-hidden="true"></span>
				<span class="text-base text-muted-foreground">正在连接服务器…</span>
			</Card.Content>
		</Card.Root>
	{:else if knocksPending > 0}
		<!-- 正常态由顶栏「连接正常」单点承担；此行只在有待办时出现 -->
		<div class="flex flex-wrap items-center gap-2.5 rounded-lg border border-warning/40 bg-warning/5 px-4 py-2.5" data-state="todo">
			<span class="text-sm font-medium">{knocksPending} 位在敲门。</span>
			<Button size="sm" class="ml-auto h-7" onclick={() => cs.goVisitors()}>
				去处理
				<ArrowRight data-icon="inline-end" />
			</Button>
		</div>
	{/if}

	<!-- 分享主卡（家人怎么连） -->
	<HubAccessCard />

	<!-- 四问紧凑数字行（可点导航；低视觉音量） -->
	{#if loading}
		<div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
			{#each [0, 1, 2, 3] as i (i)}
				<div class="h-16 animate-pulse rounded-lg bg-muted/50"></div>
			{/each}
		</div>
	{:else if cs.overviewData !== null}
		<div class="grid grid-cols-2 gap-3 xl:grid-cols-4" data-quickstats>
			<button
				type="button"
				class="flex flex-col justify-center gap-0.5 rounded-lg border px-4 py-3 text-left shadow-xs transition-colors hover:bg-accent/60 hover:shadow-sm"
				onclick={() => cs.goOnline(null)}
			>
				<span class="text-xs text-muted-foreground">在线连接</span>
				<span class="text-xl font-semibold tabular-nums">{totalConns}<span class="ml-1 text-sm font-normal text-muted-foreground">条</span></span>
			</button>
			<button
				type="button"
				class="flex flex-col justify-center gap-0.5 rounded-lg border px-4 py-3 text-left shadow-xs transition-colors hover:bg-accent/60 hover:shadow-sm"
				onclick={() => cs.goTenants()}
			>
				<span class="text-xs text-muted-foreground">租户{expiringCount > 0 ? `（${expiringCount} 个临期）` : ""}</span>
				<span class="text-xl font-semibold tabular-nums">{ownersLoaded ? owners.length : "…"}<span class="ml-1 text-sm font-normal text-muted-foreground">个</span></span>
			</button>
			<button
				type="button"
				class="flex flex-col justify-center gap-0.5 rounded-lg border px-4 py-3 text-left shadow-xs transition-colors hover:bg-accent/60 hover:shadow-sm"
				onclick={() => cs.goVisitors()}
			>
				<span class="text-xs text-muted-foreground">待处理敲门</span>
				<span class="text-xl font-semibold tabular-nums {knocksPending > 0 ? 'text-warning' : ''}">{knocksPending}<span class="ml-1 text-sm font-normal text-muted-foreground">次</span></span>
			</button>
			<button
				type="button"
				class="flex flex-col justify-center gap-0.5 rounded-lg border px-4 py-3 text-left shadow-xs transition-colors hover:bg-accent/60 hover:shadow-sm"
				onclick={() => cs.goIssueCode()}
			>
				<span class="text-xs text-muted-foreground">可用邀请码</span>
				<span class="text-xl font-semibold tabular-nums">{codesActive !== null ? codesActive : "…"}<span class="ml-1 text-sm font-normal text-muted-foreground">张</span></span>
			</button>
		</div>

		{#if cs.overviewData.mode === "open"}
			<p class="text-sm text-muted-foreground">这台服务器处于开放模式，任何人都能进楼，门禁不生效。</p>
		{/if}

		{#if cs.overviewData.mode === "restricted" && ownersLoaded && owners.length === 0}
			<Empty.Root class="border border-dashed">
				<Empty.Header>
					<Empty.Media variant="icon"><Users /></Empty.Media>
					<Empty.Title>这栋楼还没有租户。</Empty.Title>
					<Empty.Description>
						名册是空的话，除了你没有人能进楼。
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={() => cs.goIssueCode()}>
						<KeyRound data-icon="inline-start" />
						签发邀请码
					</Button>
				</Empty.Content>
			</Empty.Root>
		{/if}
	{/if}
</section>
