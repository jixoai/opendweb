<script lang="ts">
	// ready 世界 · 总览（§3.1 裁决 2）：健康结论 → 关键数字 → 配置投影 → 空名册引导。
	// 3 秒巡检（§7.2）：首屏不滚动、不点击回答三问。
	import * as Card from "$lib/components/ui/card";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Empty from "$lib/components/ui/empty";
	import { ArrowRight, CircleCheck, ServerCog, Users } from "@lucide/svelte";
import { modeBadge, policyLabel } from "$lib/terms";
import { errorCopy } from "$lib/copy";
import { fmtClock } from "$lib/format";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";

	const active = $derived(
		Array.isArray(cs.overviewData?.active_connections) ? cs.overviewData!.active_connections : [],
	);
	// 所有者计数真源 = 名册列表（ownersData）——status 的 per_owner_connections
	// 是「有活跃连接的所有者」在线投影（0 连接即空），不是名册计数。
	const owners = $derived(Array.isArray(cs.ownersData?.owners) ? cs.ownersData!.owners : []);
	const ownersLoaded = $derived(Array.isArray(cs.ownersData?.owners));
	const totalConns = $derived(active.reduce((n, e) => n + (Number(e?.connections) || 0), 0));
	const mode = $derived(modeBadge(cs.overviewData?.mode));
	const hasError = $derived(cs.overviewError !== null && cs.overviewError !== undefined);
	const retryable = $derived(hasError && cs.overviewError !== null ? errorCopy(cs.overviewError).retry : false);
	const loading = $derived(cs.overviewData === null && !hasError);
</script>

<section class="flex flex-col gap-6" data-view="overview">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">总览</h2>
		<p class="text-sm text-muted-foreground">这台服务器正常吗、谁在用、谁能用——打开即答。</p>
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
					一切正常。{totalConns} 条在线连接{ownersLoaded ? `，${owners.length} 个所有者` : ""}。
				</p>
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- 关键数字区 / 配置投影 / 空名册引导 -->
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
						<span class="text-xs text-muted-foreground">按端点 {active.length} 个</span>
					</Card.Content>
				</Card.Root>
			</button>
			<button
				type="button"
				class="cursor-pointer text-left"
				onclick={() => cs.goRegister()}
				title="管理所有者名册"
			>
				<Card.Root class="gap-3 py-5 transition-colors hover:border-ring/50">
					<Card.Content class="flex flex-col gap-2">
						<span class="text-sm text-muted-foreground">所有者</span>
						<span class="font-mono text-3xl font-semibold tabular-nums">
							{ownersLoaded ? `${owners.length} 个` : "…"}
						</span>
						<span class="text-xs text-muted-foreground">名册内可接入的 Fabric</span>
					</Card.Content>
				</Card.Root>
			</button>
			<Card.Root class="gap-3 py-5">
				<Card.Content class="flex flex-col gap-2">
					<span class="text-sm text-muted-foreground">接入模式</span>
					<span class="flex h-9 items-center">
						{#if mode !== null}
							<Badge variant="secondary" class="text-sm" title={mode.title}>{mode.label}</Badge>
						{:else}
							<span class="text-muted-foreground">-</span>
						{/if}
					</span>
					<span class="text-xs text-muted-foreground">
						{cs.overviewData.mode === "restricted" ? "名册内的所有者可接入" : "未启用身份验证"}
					</span>
				</Card.Content>
			</Card.Root>
			<Card.Root class="gap-3 py-5">
				<Card.Content class="flex flex-col gap-2">
					<span class="text-sm text-muted-foreground">名册版本</span>
					<span class="font-mono text-3xl font-semibold tabular-nums">v{cs.overviewData.generation ?? "-"}</span>
					<span class="text-xs text-muted-foreground" title="每次所有者名册变更后加 1，用于确认变更已生效">
						变更后加 1，用于确认生效
					</span>
				</Card.Content>
			</Card.Root>
		</div>

		{#if cs.overviewData.mode === "open"}
			<p class="text-sm text-muted-foreground">这台服务器未启用身份验证，任何人都能接入。</p>
		{/if}

		{#if cs.overviewData.mode === "restricted" && ownersLoaded && owners.length === 0}
			<Empty.Root class="border border-dashed">
				<Empty.Header>
					<Empty.Media variant="icon"><Users /></Empty.Media>
					<Empty.Title>还没有任何所有者能使用这台服务器。</Empty.Title>
					<Empty.Description>
						受限模式下，名册为空意味着除了你没有人能接入。如果有 Fabric 需要接入，去注册第一个所有者。
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={() => cs.goRegister()}>
						去注册所有者
						<ArrowRight data-icon="inline-end" />
					</Button>
				</Empty.Content>
			</Empty.Root>
		{/if}

		<Card.Root class="gap-4 py-5">
			<Card.Header class="flex flex-row items-center gap-2">
				<ServerCog class="size-4 text-muted-foreground" />
				<Card.Title class="text-base">配置</Card.Title>
			</Card.Header>
			<Card.Content>
				<dl class="grid grid-cols-[160px_1fr] items-baseline gap-x-4 gap-y-2.5 text-sm">
					<dt class="text-muted-foreground">准入策略</dt>
					<dd>{policyLabel(cs.overviewData.policy)}</dd>
					<dt class="text-muted-foreground">每所有者连接上限</dt>
					<dd class="font-mono">{cs.overviewData.max_connections_per_owner ?? "未设置"}</dd>
					<dt class="text-muted-foreground">中继（relay）</dt>
					<dd>
						{cs.overviewData.relay_enabled === true
							? "已启用"
							: cs.overviewData.relay_enabled === false
								? "未启用"
								: "-"}
					</dd>
				</dl>
			</Card.Content>
		</Card.Root>
	{/if}
</section>
