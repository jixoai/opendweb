<script lang="ts">
	// 在线视角（谁正在用）：连接表 / 断连闭环（不跳页）/ 收敛观测 + 回执。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Empty from "$lib/components/ui/empty";
	import * as Table from "$lib/components/ui/table";
	import { CircleX, LoaderCircle, WifiOff } from "@lucide/svelte";
	import { DISCONNECT_PHASE_LABEL } from "$lib/terms";
	import { shortHex } from "$lib/hex";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import HexValue from "./HexValue.svelte";
	import ReceiptCard from "./ReceiptCard.svelte";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	const perEndpointAll = $derived(
		Array.isArray(cs.connData?.per_endpoint) ? cs.connData!.per_endpoint : [],
	);
	const perOwnerAll = $derived(Array.isArray(cs.connData?.per_owner) ? cs.connData!.per_owner : []);
	const perEndpoint = $derived(
		cs.onlineFilter !== null ? perEndpointAll.filter((e) => e.fabric_id === cs.onlineFilter) : perEndpointAll,
	);
	const perOwner = $derived(
		cs.onlineFilter !== null ? perOwnerAll.filter((o) => o.fabric_id === cs.onlineFilter) : perOwnerAll,
	);
	const max = $derived(
		cs.connData?.quota?.configured === true ? (cs.connData.quota.max_connections_per_owner ?? "-") : "未设置",
	);
	const loading = $derived(cs.connData === null && cs.connError === null);
	const disconnectNoun = $derived(cs.disconnect?.kind === "fabric" ? "所有者" : "端点");
	const confirmNoun = $derived(cs.connConfirm?.kind === "fabric" ? "所有者" : "端点");
	const phaseFinal = $derived(
		cs.disconnect?.phase === "converged" || cs.disconnect?.phase === "unconfirmed",
	);
</script>

<section class="flex flex-col gap-4" data-section="online">
	{#if cs.connError !== null && cs.connError !== undefined}
		<ErrorBanner error={cs.connError} onRetry={() => void cs.refreshConnections()} />
	{/if}

	{#if cs.onlineFilter !== null}
		<div
			class="flex w-fit items-center gap-2 rounded-full border bg-muted/50 py-1 pr-1.5 pl-3 text-sm"
		>
			只看所有者
			<span class="font-mono text-[13px]" title={cs.onlineFilter}>{shortHex(cs.onlineFilter)}</span>
			<Button
				variant="ghost"
				size="sm"
				class="h-6 rounded-full px-2.5 text-xs"
				onclick={() => cs.clearFilter()}
				title="清除过滤"
			>
				清除
			</Button>
		</div>
	{/if}

	<!-- 断连闭环面板（同视图：已下发 → 收敛中 → 已收敛 / 超时未确认 + 回执） -->
	{#if cs.disconnect !== null}
		<Card.Root class="gap-3 py-4" data-phase={cs.disconnect.phase}>
			<Card.Content class="flex flex-col gap-3">
				<div class="flex flex-wrap items-center gap-2">
					<Badge
						title={DISCONNECT_PHASE_LABEL[cs.disconnect.phase] ?? cs.disconnect.phase}
						class={
							cs.disconnect.phase === "converged"
								? "border-success/30 bg-success/10 text-success"
								: cs.disconnect.phase === "unconfirmed"
									? "border-warning/40 bg-warning/10 text-warning"
									: ""
						}
						variant={cs.disconnect.phase === "converged" || cs.disconnect.phase === "unconfirmed"
							? "outline"
							: "secondary"}
					>
						{#if cs.disconnect.phase === "converging"}
							<LoaderCircle class="animate-spin" data-icon="inline-start" />
						{/if}
						{DISCONNECT_PHASE_LABEL[cs.disconnect.phase] ?? cs.disconnect.phase}
					</Badge>
					<span class="font-mono text-[13px]" title={cs.disconnect.id}>{shortHex(cs.disconnect.id)}</span>
					<span class="text-sm text-muted-foreground">（按{disconnectNoun}断开）</span>
					{#if phaseFinal}
						<Button variant="ghost" size="sm" class="ml-auto h-7" onclick={() => cs.dismissDisconnect()}>
							关闭
						</Button>
					{/if}
				</div>

				{#if cs.disconnect.error !== null && cs.disconnect.error !== undefined}
					{#if cs.disconnect.error.code === "no-match"}
						<p class="text-sm text-muted-foreground">
							这个{disconnectNoun}已经不在线了——可能刚好自行断开。在线表已刷新，请核对。
						</p>
					{:else}
						<ErrorBanner error={cs.disconnect.error} />
					{/if}
				{:else if cs.disconnect.phase === "dispatched"}
					<p class="text-sm text-muted-foreground">断开指令正在下发…</p>
				{:else if cs.disconnect.phase === "converging"}
					<p class="text-sm text-muted-foreground">正在确认连接已断开，通常几秒内完成…</p>
				{:else if cs.disconnect.phase === "converged"}
					<p class="text-sm text-muted-foreground">该{disconnectNoun}已从在线表消失。回执如下，可复制存档。</p>
				{:else if cs.disconnect.phase === "unconfirmed"}
					<p class="text-sm text-muted-foreground">
						指令已下发，但 15 秒内在线表未观察到收敛。断开是尽力而为的——请刷新在线表核对；若连接仍在，可再次断开。
					</p>
				{/if}

				{#if Array.isArray(cs.disconnect.receipts) && cs.disconnect.receipts.length > 0}
					<div class="flex flex-col gap-2">
						{#each cs.disconnect.receipts as r, i (i)}
							<ReceiptCard receipt={r} />
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- 空态三分 / 连接表 -->
	{#if loading}
		<div class="flex flex-col gap-2">
			<Skeleton class="h-9 w-full" />
			<Skeleton class="h-9 w-full" />
			<Skeleton class="h-9 w-full" />
			<Skeleton class="h-9 w-full" />
		</div>
	{:else if cs.connData?.mode === "open"}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Media variant="icon"><WifiOff /></Empty.Media>
				<Empty.Title>开放模式下没有在线统计。</Empty.Title>
				<Empty.Description>这台服务器未启用身份验证，管理面只能看到配置，看不到连接明细。</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if cs.connData?.relay_enabled === false}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Media variant="icon"><WifiOff /></Empty.Media>
				<Empty.Title>中继（relay）未启用。</Empty.Title>
				<Empty.Description>这台服务器没有开启中继服务，因此没有在线连接可显示。</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if cs.connData !== null}
		<Card.Root class="gap-4 py-5">
			<Card.Header>
				<Card.Title class="text-base">按端点</Card.Title>
			</Card.Header>
			<Card.Content>
				{#if perEndpointAll.length === 0}
					<Empty.Root class="py-6">
						<Empty.Header>
							<Empty.Media variant="icon"><WifiOff /></Empty.Media>
							<Empty.Title>当前没有在线连接。</Empty.Title>
							<Empty.Description>已注册的所有者建立组网后，连接会实时出现在这里。</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else if perEndpoint.length === 0}
					<p class="text-sm text-muted-foreground">该所有者当前没有在线连接。</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>端点</Table.Head>
								<Table.Head>Fabric</Table.Head>
								<Table.Head class="text-right">连接数</Table.Head>
								<Table.Head class="w-2"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each perEndpoint as e (e.endpoint_id + e.fabric_id)}
								<Table.Row>
									<Table.Cell><HexValue value={e.endpoint_id} kind="端点" /></Table.Cell>
									<Table.Cell><HexValue value={e.fabric_id} kind="Fabric" /></Table.Cell>
									<Table.Cell class="text-right font-mono tabular-nums">{e.connections}</Table.Cell>
									<Table.Cell>
										<div class="flex justify-end">
											<Button
												variant="ghost"
												size="sm"
												class="h-7 text-destructive hover:text-destructive"
												onclick={() => cs.askDisconnect("endpoint", e.endpoint_id, e.connections)}
											>
												<CircleX data-icon="inline-start" />
												断开
											</Button>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root class="gap-4 py-5">
			<Card.Header>
				<Card.Title class="text-base">按所有者</Card.Title>
			</Card.Header>
			<Card.Content>
				{#if perOwnerAll.length === 0}
					<p class="text-sm text-muted-foreground">没有所有者正在使用。</p>
				{:else if perOwner.length === 0}
					<p class="text-sm text-muted-foreground">该所有者当前没有在线连接。</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Fabric</Table.Head>
								<Table.Head class="text-right">在用 / 上限</Table.Head>
								<Table.Head class="w-2"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each perOwner as o (o.fabric_id)}
								<Table.Row>
									<Table.Cell><HexValue value={o.fabric_id} kind="Fabric" /></Table.Cell>
									<Table.Cell class="text-right font-mono tabular-nums">{o.connections} / {max}</Table.Cell>
									<Table.Cell>
										<div class="flex justify-end">
											<Button
												variant="ghost"
												size="sm"
												class="h-7 text-destructive hover:text-destructive"
												onclick={() => cs.askDisconnect("fabric", o.fabric_id, o.connections)}
											>
												<CircleX data-icon="inline-start" />
												全部断开
											</Button>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- 断开确认（知情前置：范围 + 异步性 + 进度承诺） -->
	<ConfirmDialog
		open={cs.connConfirm !== null}
		title="断开这个{confirmNoun}？"
		confirmLabel="确认断开"
		oncancel={() => cs.cancelConnConfirm()}
		onconfirm={() => void cs.confirmDisconnect()}
	>
		{#if cs.connConfirm?.kind === "endpoint"}
			<p class="text-foreground">
				将向服务器下发断开指令，端点
				<span class="font-mono text-[13px]" title={cs.connConfirm.id}>{shortHex(cs.connConfirm.id)}</span>
				的 <strong class="font-medium">{cs.connConfirm.count} 条连接</strong>会被关闭。
			</p>
		{:else if cs.connConfirm !== null}
			<p class="text-foreground">
				将向服务器下发断开指令，所有者
				<span class="font-mono text-[13px]" title={cs.connConfirm.id}>{shortHex(cs.connConfirm.id)}</span>
				名下的 <strong class="font-medium">{cs.connConfirm.count} 条连接</strong>会被关闭。
			</p>
		{/if}
		<p>断开是异步的：确认后这里会显示进度，直到连接从在线表消失。</p>
	</ConfirmDialog>
</section>
