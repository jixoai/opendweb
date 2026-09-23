<script lang="ts">
	// 我的租约（home-hub [H5]/[H7] 组 B；单页台账，无侧栏导航、零 admin 概念）。
	// 首屏两问 3 秒答：还剩几天（倒计时列，本地快照语义）/ 现在连得上吗（测一下）。
	// 临期黄条（PM §4.5 逐字含「本地快照」副文案）；已到期红标 + 新码重进命令；
	// 行内展开（fabric 缩写/回执/续期指引双路径）；行内 label 编辑（改名/空串清除/
	// 超长拒）；空态三步加入指引（含「填地址或贴短码」）。
	import * as Card from "$lib/components/ui/card";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Empty from "$lib/components/ui/empty";
	import { Check, ChevronDown, LoaderCircle, Pencil, Radar, TriangleAlert } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import HexValue from "./HexValue.svelte";
	import { fmtDate, fmtLocal, relativeTime, leaseState } from "$lib/format";
	import { shortHex } from "$lib/hex";
	import {
		expiredBadgeCopy,
		expiringBannerCopy,
		probeResultCopy,
		rejoinCommand,
		RENEW_GUIDE,
	} from "$lib/member";

	const leases = $derived(Array.isArray(cs.leasesData?.leases) ? cs.leasesData!.leases : []);
	const loading = $derived(cs.leasesData === null && cs.leasesError === null);
	const banner = $derived(cs.soonestExpiring);
	const bannerCopy = $derived(
		banner !== null ? expiringBannerCopy(leaseState(banner.expires_at).daysLeft ?? 0, fmtDate(banner.expires_at)) : null,
	);

	function stateOf(l: (typeof leases)[number]) {
		return leaseState(l.expires_at);
	}
	function nameOf(l: (typeof leases)[number]): string {
		if (typeof l.label === "string" && l.label.trim() !== "") return l.label;
		if (typeof l.alias === "string" && l.alias.trim() !== "") return l.alias;
		return `${shortHex(l.server.replace(/^https?:\/\//, ""))}`;
	}
	/** 「现在连得上吗」的数据源：同 server 的到访簿 last_probe（探测动作的落账面）。 */
	function lastProbeFor(server: string): { text: string; title: string } | null {
		const visits = Array.isArray(cs.visitsData?.visits) ? cs.visitsData!.visits : [];
		const v = visits.find((x) => x.server === server);
		if (v === undefined) return null;
		return {
			text: probeResultCopy(v.last_probe.result),
			title: `上次探测 ${relativeTime(v.last_probe.at)}`,
		};
	}
	async function onSubmitLabel(): Promise<void> {
		const r = await cs.submitLeaseLabelEdit();
		if (r?.ok === true) toast.success("备注名已保存");
		else if (r?.ok === false) toast.error("备注名没有保存");
	}
</script>

<section class="flex flex-col gap-5" data-view="lease">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">我的租约</h2>
		<p class="text-sm text-muted-foreground">这台设备加入过的网络——还剩几天、现在连得上吗，打开即答。</p>
	</div>

	{#if cs.leasesError !== null && cs.leasesError !== undefined}
		<ErrorBanner error={cs.leasesError} onRetry={() => void cs.refreshLeases()} />
	{/if}

	<!-- 首屏黄条：最近一条临期租约（PM §4.5 逐字；本地快照语义副文案） -->
	{#if banner !== null && bannerCopy !== null}
		<Card.Root class="border-warning/40 bg-warning/5 py-4" data-banner="lease-expiring">
			<Card.Content class="flex flex-col gap-1">
				<p class="text-base font-medium text-warning">{bannerCopy.headline}</p>
				<p class="text-sm leading-relaxed text-muted-foreground">{bannerCopy.body}</p>
			</Card.Content>
		</Card.Root>
	{/if}

	{#if loading}
		<div class="flex flex-col gap-2">
			<Skeleton class="h-9 w-full" />
			<Skeleton class="h-9 w-full" />
		</div>
	{:else if leases.length === 0}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Media variant="icon"><Radar /></Empty.Media>
				<Empty.Title>这台设备还没有加入任何网络。</Empty.Title>
				<Empty.Description class="text-left leading-relaxed">
					三步加入：① 向网络的主人要接入卡片（地址或短码）；② 要一张邀请码；<br />
					③ 终端运行 <code class="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">opendweb join --server &lt;地址&gt; --code &lt;邀请码&gt;</code>——填地址或贴短码都行。<br />
					（加入动作发生在终端/客户端，本页只指路。）
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Card.Root class="gap-4 py-5">
			<Card.Header>
				<Card.Title class="text-base">租约台账</Card.Title>
				<Card.Description>倒计时是本地快照——管理端续期后，数字在你下次持新码加入时刷新。</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-2">
				{#each leases as l (l.id)}
					{@const state = stateOf(l)}
					<div class="rounded-lg border" data-lease-id={l.id}>
						<!-- 行主体：备注名 · 服务商地址 · 我的身份 · 状态 · 到期 · 测一下/展开 -->
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
							{#if cs.leaseLabelEdit?.id === l.id}
								<!-- 行内 label 编辑（改名/空串清除；超长实时拒） -->
								<div class="flex min-w-60 items-center gap-2">
									<Input
										class="h-8 w-52"
										value={cs.leaseLabelEdit.value}
										oninput={(e) => cs.onLeaseLabelInput(e.currentTarget.value)}
										onkeydown={(e) => {
											if (e.key === "Enter") void onSubmitLabel();
											if (e.key === "Escape") cs.cancelLeaseLabelEdit();
										}}
										aria-label="备注名"
										placeholder="备注名（留空清除）"
									/>
									<Button size="sm" class="h-8" disabled={cs.leaseLabelBusy} onclick={() => void onSubmitLabel()}>
										{#if cs.leaseLabelBusy}
										<LoaderCircle class="animate-spin" data-icon="inline-start" />
										{:else}
										<Check data-icon="inline-start" />
										{/if}
										保存
									</Button>
									<Button variant="ghost" size="sm" class="h-8" onclick={() => cs.cancelLeaseLabelEdit()}>取消</Button>
								</div>
							{:else}
								<button
									type="button"
									class="group flex cursor-pointer items-center gap-1.5 text-sm font-medium"
									onclick={() => cs.beginLeaseLabelEdit(l)}
									title="改备注名（只存在这台设备上）"
								>
									{nameOf(l)}
									<Pencil class="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
								</button>
							{/if}
							<span class="font-mono text-[13px] text-muted-foreground" title={l.server}>{l.server}</span>
							<span class="text-xs text-muted-foreground" title={`根端点 ${l.root}`}>
								我的身份：{l.alias ?? "-"}（{shortHex(l.root)}）
							</span>
							<!-- 状态列：语义色克制（黄临期/红到期，不整行染色） -->
							{#if state.state === "expired"}
								<Badge variant="outline" class="border-destructive/40 bg-destructive/10 text-destructive">已到期</Badge>
							{:else if state.state === "expiring"}
								<Badge variant="outline" class="border-warning/40 bg-warning/10 text-warning">{state.label}</Badge>
							{:else}
								<span class="text-sm text-muted-foreground">{state.label}</span>
							{/if}
							<span class="text-xs text-muted-foreground">到期 {fmtDate(l.expires_at)}</span>
							{#if lastProbeFor(l.server) !== null}
								{@const lastProbe = lastProbeFor(l.server)}
								<span class="text-xs text-muted-foreground" title={lastProbe.title}>最近探测：{lastProbe.text}</span>
							{/if}
							<div class="ml-auto flex items-center gap-1.5">
								<!-- 探测动作仅成员视角（服务端 /sidecar/visits/probe 对非 member 一律
								     403——到访簿是成员侧事实簿；admin 落本页只读，不给必然 403 的按钮） -->
								{#if cs.role === "member"}
									<Button
										variant="ghost"
										size="sm"
										class="h-7"
										disabled={cs.probeBusy !== null}
										onclick={() => void cs.probeServerTarget(l.server)}
										title="无凭证探测这台服务器现在是否可达"
									>
										{#if cs.probeBusy === l.server}
											<LoaderCircle class="animate-spin" data-icon="inline-start" />
										{:else}
											<Radar data-icon="inline-start" />
										{/if}
										测一下
									</Button>
								{/if}
								<Button
									variant="ghost"
									size="sm"
									class="h-7"
									onclick={() => cs.toggleLeaseExpanded(l.id)}
									aria-expanded={cs.leaseExpanded === l.id}
								>
									<ChevronDown
										data-icon="inline-end"
										class={cs.leaseExpanded === l.id ? "rotate-180 transition-transform" : "transition-transform"}
									/>
									详情
								</Button>
							</div>
						</div>

						<!-- 已到期红标：新码重进命令（PM §4.5 逐字形态） -->
						{#if state.state === "expired"}
							{@const copy = expiredBadgeCopy(fmtDate(l.expires_at))}
							<div class="flex flex-col gap-1 border-t px-4 py-3" data-expired={l.id}>
								<p class="flex items-center gap-1.5 text-sm font-medium text-destructive">
									<TriangleAlert class="size-4 shrink-0" />
									{copy.headline}
								</p>
								<p class="text-sm text-muted-foreground">
									{copy.body}：<code class="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">{rejoinCommand(l.server)}</code>
								</p>
							</div>
						{/if}

						<!-- 行内展开：fabric 缩写 / 回执 / 续期指引（双路径文案） -->
						{#if cs.leaseExpanded === l.id}
							<div class="flex flex-col gap-2.5 border-t px-4 py-3 text-sm" data-expanded={l.id}>
								<dl class="grid grid-cols-[120px_1fr] items-baseline gap-x-4 gap-y-2">
									<dt class="text-muted-foreground">Fabric</dt>
									<dd><HexValue value={l.fabric_id} kind="Fabric" /></dd>
									<dt class="text-muted-foreground">中转</dt>
									<dd class="font-mono text-[13px]">{l.relay_url === "" ? "-" : l.relay_url}</dd>
									{#if l.receipt !== null}
										<dt class="text-muted-foreground">回执</dt>
										<dd class="text-muted-foreground">
											{fmtLocal(l.receipt.ts)} · 名册 v{l.receipt.generation} · 签名
											<span class="font-mono" title={l.receipt.receipt_sig}>{shortHex(l.receipt.receipt_sig)}</span>
										</dd>
									{/if}
									<dt class="text-muted-foreground">首次加入</dt>
									<dd class="text-muted-foreground">{fmtLocal(l.registered_at)}</dd>
								</dl>
								<p class="leading-relaxed text-muted-foreground">{RENEW_GUIDE}</p>
								<p class="text-xs text-muted-foreground">能否连上以实际连接为准；「测一下」只做无凭证探测。</p>
							</div>
						{/if}
					</div>
				{/each}
				{#if cs.leaseLabelEditError !== null}
					<p class="text-xs text-destructive">{cs.leaseLabelEditError}</p>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</section>
