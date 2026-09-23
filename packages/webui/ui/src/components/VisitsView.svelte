<script lang="ts">
	// 我的到访（home-hub [H5]/[H7] 组 B；单页 best-effort 台账，无侧栏导航）。
	// 每条：对端（地址）· 最近连通探测（结果/时间）·「测一下」主动动作（v1 不自动
	// 轮询）。页脚 best-effort 声明常驻（PM §3.4 逐字）；「连不上≠被拒」话术。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Empty from "$lib/components/ui/empty";
	import { DoorOpen, LoaderCircle, Radar } from "@lucide/svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import { formatTime } from "$lib/format";
	import { probeDetailCopy, probeResultCopy } from "$lib/member";

	const visits = $derived(Array.isArray(cs.visitsData?.visits) ? cs.visitsData!.visits : []);
	const loading = $derived(cs.visitsData === null && cs.visitsError === null);

	function reachableOf(v: (typeof visits)[number]): boolean {
		return v.last_probe?.result === "reachable";
	}
</script>

<section class="flex flex-col gap-5" data-view="visits">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">我的到访</h2>
		<p class="text-sm text-muted-foreground">到访过的楼哪些还通、上次什么时候——打开即答；探测是主动动作。</p>
	</div>

	{#if cs.visitsError !== null && cs.visitsError !== undefined}
		<ErrorBanner error={cs.visitsError} onRetry={() => void cs.refreshVisits()} />
	{/if}

	{#if loading}
		<div class="flex flex-col gap-2">
			<Skeleton class="h-9 w-full" />
			<Skeleton class="h-9 w-2/3" />
		</div>
	{:else if visits.length === 0}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Media variant="icon"><DoorOpen /></Empty.Media>
				<Empty.Title>还没有到访记录。</Empty.Title>
				<Empty.Description>你敲开一栋楼的门、被放行之后，这里会记下这栋楼。</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Card.Root class="gap-4 py-5">
			<Card.Header>
				<Card.Title class="text-base">到访台账</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col gap-2">
				{#each visits as v (v.server)}
					<div class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3" data-visit={v.server}>
						<span class="font-mono text-[13px]" title={v.server}>{v.server}</span>
						{#if reachableOf(v)}
							<span class="text-sm font-medium text-success">可连通</span>
						{:else}
							<span class="text-sm text-muted-foreground" title={probeDetailCopy(v.last_probe?.detail) ?? undefined}>
								{probeResultCopy("unreachable")}
							</span>
						{/if}
						<span class="text-xs text-muted-foreground" title={formatTime(v.last_probe.at)}>
							上次探测 {formatTime(v.last_probe.at)}
						</span>
						{#if v.last_visit_at !== null}
							<span class="text-xs text-muted-foreground">最近连通 {formatTime(v.last_visit_at)}</span>
						{/if}
						<div class="ml-auto">
							<Button
								variant="ghost"
								size="sm"
								class="h-7"
								disabled={cs.probeBusy !== null}
								onclick={() => void cs.probeServerTarget(v.server)}
								title="无凭证探测这台服务器现在是否可达"
							>
								{#if cs.probeBusy === v.server}
									<LoaderCircle class="animate-spin" data-icon="inline-start" />
								{:else}
									<Radar data-icon="inline-start" />
								{/if}
								测一下
							</Button>
						</div>
					</div>
				{/each}
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- 页脚 best-effort 声明（PM §3.4 逐字；常驻） -->
	<footer class="border-t pt-4 text-xs leading-relaxed text-muted-foreground" data-footer="best-effort">
		到访记录只保存在这台设备上，尽力而为——不保证完整。
	</footer>
</section>
