<script lang="ts">
	// ready 世界 · 总览（server-access-roles 三角色 IA：三问变四问）。
	// 首屏不滚动、不点击，3 秒回答：楼正常吗 / 有没有人敲门 / 楼里有什么人 /
	// 几个租户几个访客。关键数字四卡：在线连接（含访客在线）/ 租户（临期预警）/
	// 待处理敲门 / 可用邀请码。名册版本与接入模式降级进配置投影区。
	import * as Card from "$lib/components/ui/card";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Empty from "$lib/components/ui/empty";
	import { ArrowRight, BellRing, CircleCheck, KeyRound, ServerCog, Users } from "@lucide/svelte";
	import { modeBadge, policyLabel } from "$lib/terms";
	import { errorCopy } from "$lib/copy";
	import { fmtClock, leaseState } from "$lib/format";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";

	const active = $derived(
		Array.isArray(cs.overviewData?.active_connections) ? cs.overviewData!.active_connections : [],
	);
	// 租户计数真源 = 名册列表（ownersData）——status 的 per_owner_connections
	// 是「有活跃连接的租户」在线投影（0 连接即空），不是名册计数。
	const owners = $derived(Array.isArray(cs.ownersData?.owners) ? cs.ownersData!.owners : []);
	const ownersLoaded = $derived(Array.isArray(cs.ownersData?.owners));
	const totalConns = $derived(active.reduce((n, e) => n + (Number(e?.connections) || 0), 0));
	const mode = $derived(modeBadge(cs.overviewData?.mode));
	const hasError = $derived(cs.overviewError !== null && cs.overviewError !== undefined);
	const retryable = $derived(hasError && cs.overviewError !== null ? errorCopy(cs.overviewError).retry : false);
	const loading = $derived(cs.overviewData === null && !hasError);
	// 待处理敲门（总览待办条 / 侧栏徽章 / 敲门台三处同一数据源）
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
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">总览</h2>
		<p class="text-sm text-muted-foreground">这台服务器正常吗、有没有人敲门、楼里有什么人——打开即答。</p>
	</div>

	<!-- 健康结论区 -->
	{#if hasError && cs.overviewError !== null}
		<div class="flex flex-col gap-2">
			<ErrorBanner error={cs.overviewError} onRetry={retryable ? () => void cs.refreshStatus() : undefined} />
			{#if retryable}
				<p class="text-xs text-muted-foreground">
					自动每 5 秒重试中{cs.statusLastFailAt != null ? `（上次失败 ${fmtClock(cs.statusLastFailAt)}）` : ""}。
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
	{:else}
		<Card.Root class="border-success/30 bg-success/5 py-4">
			<Card.Content class="flex flex-row items-center gap-3">
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
					aria-hidden="true"
				>
					<CircleCheck class="size-4.5" />
				</span>
				<p class="text-base font-medium">
					一切正常。{totalConns} 条在线连接{ownersLoaded ? `，${owners.length} 个租户` : ""}。
				</p>
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- 待办行动条（有人敲门时占据；无敲门时完全不存在） -->
	{#if !hasError && !loading && knocksPending > 0}
		<Card.Root class="border-warning/40 bg-warning/5 py-4" data-todo="knocks">
			<Card.Content class="flex flex-row flex-wrap items-center gap-3">
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning"
					aria-hidden="true"
				>
					<BellRing class="size-4.5" />
				</span>
				<p class="text-base font-medium">
					有 {knocksPending} 台设备在敲门。陌生设备在等待放行。
				</p>
				<Button size="sm" class="ml-auto" onclick={() => cs.goVisitors()}>
					去处理
					<ArrowRight data-icon="inline-end" />
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- 关键数字四卡 / 配置投影 / 空名册引导 -->
	{#if loading}
		<div class="grid grid-cols-2 gap-4 xl:grid-cols-4">
			{#each [0, 1, 2, 3] as i (i)}
				<Card.Root class="gap-3 py-5">
					<Card.Content class="flex flex-col gap-2">
						<Skeleton class="h-3.5 w-14" />
						<Skeleton class="h-8 w-20" />
						<Skeleton class="h-3 w-24" />
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{:else if cs.overviewData !== null}
		<div class="grid grid-cols-2 gap-4 xl:grid-cols-4">
			<button
				type="button"
				class="cursor-pointer text-left"
				onclick={() => cs.goOnline(null)}
				title="查看在线连接明细"
			>
				<Card.Root class="gap-3 py-5 transition-colors hover:border-ring/50">
					<Card.Content class="flex flex-col gap-2">
						<span class="text-sm text-muted-foreground">在线连接</span>
						<span class="font-mono text-3xl font-semibold tabular-nums">{totalConns} 条</span>
						<span class="text-xs text-muted-foreground">
							按端点 {active.length} 个{visitorsOnline !== null ? ` · 访客在线 ${visitorsOnline} 个` : ""}
						</span>
					</Card.Content>
				</Card.Root>
			</button>
			<button
				type="button"
				class="cursor-pointer text-left"
				onclick={() => cs.goTenants()}
				title="管理租户名册"
			>
				<Card.Root class="gap-3 py-5 transition-colors hover:border-ring/50">
					<Card.Content class="flex flex-col gap-2">
						<span class="text-sm text-muted-foreground">租户</span>
						<span class="font-mono text-3xl font-semibold tabular-nums">
							{ownersLoaded ? `${owners.length} 个` : "…"}
						</span>
						{#if expiringCount > 0}
							<span class="text-xs font-medium text-warning">{expiringCount} 个租户 7 天内到期</span>
						{:else}
							<span class="text-xs text-muted-foreground">名册内可接入的 Fabric</span>
						{/if}
					</Card.Content>
				</Card.Root>
			</button>
			<button
				type="button"
				class="cursor-pointer text-left"
				onclick={() => cs.goVisitors()}
				title="去敲门台处置"
			>
				<Card.Root class="gap-3 py-5 transition-colors hover:border-ring/50">
					<Card.Content class="flex flex-col gap-2">
						<span class="text-sm text-muted-foreground">待处理敲门</span>
						<span class="font-mono text-3xl font-semibold tabular-nums {knocksPending > 0 ? 'text-warning' : ''}">
							{knocksPending} 次
						</span>
						<span class="text-xs text-muted-foreground">等待放行或拒绝</span>
					</Card.Content>
				</Card.Root>
			</button>
			<button
				type="button"
				class="cursor-pointer text-left"
				onclick={() => cs.goIssueCode()}
				title="管理邀请码"
			>
				<Card.Root class="gap-3 py-5 transition-colors hover:border-ring/50">
					<Card.Content class="flex flex-col gap-2">
						<span class="text-sm text-muted-foreground">可用邀请码</span>
						<span class="font-mono text-3xl font-semibold tabular-nums">
							{codesActive !== null ? `${codesActive} 张` : "…"}
						</span>
						<span class="text-xs text-muted-foreground">签发后仅显示一次全文</span>
					</Card.Content>
				</Card.Root>
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
						受限模式下，名册为空意味着除了你没有人能进楼。开号有两种方式：发一张邀请码让对方自助注册，或手工导入已知的公钥。
					</Empty.Description>
				</Empty.Header>
				<Empty.Content class="flex gap-2">
					<Button onclick={() => cs.goIssueCode()}>
						<KeyRound data-icon="inline-start" />
						签发邀请码
					</Button>
					<Button variant="outline" onclick={() => cs.goRegister()}>手工导入</Button>
				</Empty.Content>
			</Empty.Root>
		{/if}

		<Card.Root class="gap-4 py-5">
			<Card.Header class="flex flex-row items-center gap-2">
				<ServerCog class="size-4 text-muted-foreground" />
				<Card.Title class="text-base">配置</Card.Title>
				{#if mode !== null}
					<Badge variant="secondary" class="ml-1 text-xs" title={mode.title}>{mode.label}</Badge>
				{/if}
			</Card.Header>
			<Card.Content>
				<dl class="grid grid-cols-[160px_1fr] items-baseline gap-x-4 gap-y-2.5 text-sm">
					<dt class="text-muted-foreground">准入策略</dt>
					<dd>{policyLabel(cs.overviewData.policy)}</dd>
					<dt class="text-muted-foreground">每租户连接上限</dt>
					<dd class="font-mono">{cs.overviewData.max_connections_per_owner ?? "未设置"}</dd>
					<dt class="text-muted-foreground">中继（relay）</dt>
					<dd>
						{cs.overviewData.relay_enabled === true
							? "已启用"
							: cs.overviewData.relay_enabled === false
								? "未启用"
								: "-"}
					</dd>
					<dt class="text-muted-foreground">名册版本</dt>
					<dd class="font-mono" title="每次租户名册变更后加 1，用于确认变更已生效">
						v{cs.overviewData.generation ?? "-"}（变更后加 1）
					</dd>
					<dt class="text-muted-foreground">房门制</dt>
					<dd>各租户房间内部自管（Phase 2 前由 Fabric 成员名单承担）</dd>
				</dl>
			</Card.Content>
		</Card.Root>
	{/if}
</section>
