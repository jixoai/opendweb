<script lang="ts">
	// sync 插件——同步状态页（webui-plugin-kernel Phase 3，路由 #/p/sync/status）。
	// 意图（2026-09-29）：
	// 1. 任务状态机投影（§7.5：idle→scanning→fetching→merging→(conflicted)→
	//    pushing→done|error）——相位徽章+拉取进度（对象数/字节）+错误+重试。
	// 2. 组件不直接 fetch：jobs/错误经 props 注入；重试/刷新回调上抛（接线层
	//    转 sidecar 动作→runtime.syncNow）。
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import * as Table from "$lib/components/ui/table";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import ErrorBanner from "../../ErrorBanner.svelte";
	import { formatBytes, phaseLabel, phaseTone, progressPercent, type JobView } from "./view-model";

	let {
		jobs,
		loading = false,
		error = null as string | null,
		onRetry,
		onRefresh,
	}: {
		jobs: JobView[];
		loading?: boolean;
		error?: string | null;
		onRetry: (groupId: string) => void;
		onRefresh: () => void;
	} = $props();
</script>

<section class="flex flex-col gap-5" data-view="plugin-page" data-plugin="sync" data-plugin-page="status">
	<div class="flex flex-col gap-1">
		<div class="flex items-center justify-between gap-3">
			<div>
				<h2 class="text-lg font-semibold tracking-tight">同步状态</h2>
				<p class="text-sm text-muted-foreground">每个同步根一个任务——相位、进度与错误重试。</p>
			</div>
			<Button size="sm" variant="outline" onclick={() => onRefresh()}>刷新</Button>
		</div>
	</div>

	{#if error !== null}
		<ErrorBanner error={error} onRetry={() => onRefresh()} />
	{/if}

	{#if jobs.length === 0}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Title>{loading ? "正在载入…" : "暂无同步任务。"}</Empty.Title>
				<Empty.Description>创建同步组并触发一次同步后，这里会出现任务状态。</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Card.Root>
			<Card.Content class="pt-4">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>组 / 根</Table.Head>
							<Table.Head>相位</Table.Head>
							<Table.Head>进度</Table.Head>
							<Table.Head>错误</Table.Head>
							<Table.Head class="text-right">操作</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each jobs as job (`${job.groupId}/${job.rootId}`)}
							{@const pct = progressPercent(job.progress)}
							<Table.Row>
								<Table.Cell class="font-mono text-xs">{job.groupId}/{job.rootId}</Table.Cell>
								<Table.Cell>
									<Badge variant="outline" class={phaseTone(job.phase)}>{phaseLabel(job.phase)}</Badge>
								</Table.Cell>
								<Table.Cell class="text-xs text-muted-foreground">
									{#if pct !== null}
										{job.progress.fetched}/{job.progress.fetchTotal} 对象（{pct}%）· {formatBytes(job.progress.bytes)}
									{:else if job.progress.bytes > 0}
										{formatBytes(job.progress.bytes)}
									{:else}
										—
									{/if}
								</Table.Cell>
								<Table.Cell class="max-w-72 text-xs">
									{#if job.error !== null}
										<span class="font-medium">{job.error.code}</span>
										<span class="text-muted-foreground"> — {job.error.message}</span>
										{#if job.error.hint}
											<span class="text-muted-foreground">（{job.error.hint}）</span>
										{/if}
									{:else}
										—
									{/if}
								</Table.Cell>
								<Table.Cell class="text-right">
									{#if job.phase === "error"}
										<Button size="xs" variant="outline" onclick={() => onRetry(job.groupId)}>重试</Button>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{/if}
</section>
