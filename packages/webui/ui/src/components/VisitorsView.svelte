<script lang="ts">
	// 访客与门禁页：敲门台置顶（待办优先）→ 访客名册 → 黑名单 → 房门说明卡。
	// 敲门台四动作文案逐字采用 PRODUCT-DESIGN §4.1：定位为访客（预填+确认）/
	// 导入为租户（引导而非阻断）/ 拉黑（二次确认）/ 忽略（dismiss+带撤销 toast）。
	// 开放模式整页解释态（O-9：open 不装 gate，门禁整体不生效）。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Empty from "$lib/components/ui/empty";
	import * as Table from "$lib/components/ui/table";
	import * as Field from "$lib/components/ui/field";
	import { Input } from "$lib/components/ui/input";
	import {
		BellRing,
		DoorOpen,
		LoaderCircle,
		ShieldCheck,
		UserRoundPlus,
	} from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { validateHex64, shortHex } from "$lib/hex";
	import { formatTime } from "$lib/format";
	import { blockKindLabel, knockReasonLabel } from "$lib/terms";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import HexValue from "./HexValue.svelte";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	const open = $derived(cs.overviewData?.mode === "open");
	const knocks = $derived(Array.isArray(cs.knocksData?.knocks) ? cs.knocksData!.knocks : []);
	const knocksLoading = $derived(cs.knocksData === null && cs.knocksError === null);
	const visitors = $derived(Array.isArray(cs.visitorsData?.visitors) ? cs.visitorsData!.visitors : []);
	const visitorsLoading = $derived(cs.visitorsData === null && cs.visitorsError === null);
	const blocklist = $derived(Array.isArray(cs.blocklistData?.blocklist) ? cs.blocklistData!.blocklist : []);
	const blocklistLoading = $derived(cs.blocklistData === null && cs.blocklistError === null);
	const action = $derived(cs.knockAction);
	const visitorEndpointOk = $derived(
		validateHex64(cs.visitorForm.endpointId) !== null || cs.visitorForm.endpointId === "",
	);

	/** 忽略动作（不弹确认，低后果）：dismiss 后 toast（文案逐字）+「撤销」→undismiss。 */
	function onIgnore(e: Event): void {
		const endpointId = (e.currentTarget as HTMLElement)?.dataset?.endpointId;
		if (endpointId === undefined) return;
		const knock = knocks.find((k) => k.endpoint_id === endpointId) ?? null;
		void cs.ignoreKnock(knock ?? ({ endpoint_id: endpointId } as never)).then(() => {
			toast("已忽略。门禁没有变化——它下次敲门还会出现在这里。", {
				action: {
					label: "撤销",
					onClick: () => void cs.undoDismiss(endpointId),
				},
				duration: 8_000,
			});
		});
	}
</script>

<section class="flex flex-col gap-5" data-view="visitors">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">访客与门禁</h2>
		<p class="text-sm text-muted-foreground">
			谁能进楼（访客名册）、谁别再来（黑名单）、谁在敲门（敲门台）——门禁先于一切准入判定。
		</p>
	</div>

	{#if open}
		<!-- 开放模式整页解释态（O-9 已裁决：open 不装 gate） -->
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Media variant="icon"><DoorOpen /></Empty.Media>
				<Empty.Title>这台服务器处于开放模式。</Empty.Title>
				<Empty.Description>
					任何人都能进楼，敲门台与门禁不生效。切换到受限模式后，这里才会开始记录敲门。
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<!-- ① 敲门台（待办队列） -->
		<Card.Root class="gap-4 py-5" data-section="knocks">
			<Card.Header class="flex flex-row flex-wrap items-center gap-2">
				<BellRing class="size-4 text-muted-foreground" />
				<Card.Title class="text-base">敲门台</Card.Title>
				{#if cs.knocksData !== null && cs.knocksData.pending_count > 0}
					<Badge variant="outline" class="border-warning/40 bg-warning/10 text-warning">
						待处理 {cs.knocksData.pending_count}
					</Badge>
				{/if}
				<Card.Description class="w-full">
					陌生设备尝试连接这台服务器时，请求会出现在这里，等你放行或拒绝。
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if cs.knocksError !== null && cs.knocksError !== undefined}
					<ErrorBanner error={cs.knocksError} onRetry={() => void cs.refreshKnocks()} />
				{:else if knocksLoading}
					<div class="flex flex-col gap-2">
						<Skeleton class="h-9 w-full" />
						<Skeleton class="h-9 w-full" />
					</div>
				{:else if knocks.length === 0}
					<Empty.Root class="py-6">
						<Empty.Header>
							<Empty.Media variant="icon"><BellRing /></Empty.Media>
							<Empty.Title>现在没有人在敲门。</Empty.Title>
							<Empty.Description>
								有陌生设备尝试连接时，请求会出现在这里，等你放行或拒绝。
							</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<div class="flex flex-col gap-3">
						{#each knocks as k (k.endpoint_id)}
							<!-- 排序以服务端 seq 为准（未处置在前、组内 seq 降序），客户端不再排序 -->
							<div class="flex flex-col gap-2 rounded-lg border px-4 py-3" data-knock={k.endpoint_id}>
								<div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
									<HexValue value={k.endpoint_id} kind="端点" />
									<span class="text-xs text-muted-foreground" title={String(k.last_at)}>
										最近敲门 {formatTime(k.last_at)}
									</span>
									<Badge variant="secondary" class="font-mono text-xs">累计 {k.count} 次</Badge>
									<span class="text-xs text-muted-foreground" title={String(k.first_at)}>
										首次 {formatTime(k.first_at)}
									</span>
									<span class="text-xs text-muted-foreground">原因：{knockReasonLabel(k.last_reason)}</span>
								</div>
								<div class="flex flex-wrap items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onclick={() => cs.openKnockAction({ kind: "locate", knock: k, alias: "" })}
									>
										定位为访客
									</Button>
									<Button
										variant="outline"
										size="sm"
										onclick={() => cs.openKnockAction({ kind: "import", knock: k, fabricId: "" })}
									>
										导入为租户
									</Button>
									<Button
										variant="outline"
										size="sm"
										class="text-destructive hover:text-destructive"
										onclick={() => cs.openKnockAction({ kind: "block", knock: k })}
									>
										拉黑
									</Button>
									<Button
										variant="ghost"
										size="sm"
										data-endpoint-id={k.endpoint_id}
										onclick={onIgnore}
									>
										忽略
									</Button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<!-- ② 访客名册 -->
		<Card.Root class="gap-4 py-5" data-section="visitors">
			<Card.Header>
				<Card.Title class="text-base">访客名册</Card.Title>
				<Card.Description>
					访客 = 获准进楼、但没有自己房间的设备（一个公钥）。访客可以进楼连接（relay 通行），但没有自己的房间。
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				{#if cs.visitorsError !== null && cs.visitorsError !== undefined}
					<ErrorBanner error={cs.visitorsError} onRetry={() => void cs.refreshVisitors()} />
				{:else if visitorsLoading}
					<div class="flex flex-col gap-2">
						<Skeleton class="h-9 w-full" />
						<Skeleton class="h-9 w-full" />
					</div>
				{:else if visitors.length === 0}
					<Empty.Root class="py-6">
						<Empty.Header>
							<Empty.Media variant="icon"><ShieldCheck /></Empty.Media>
							<Empty.Title>还没有访客。</Empty.Title>
							<Empty.Description>
								访客可以进楼连接（relay 通行），但没有自己的房间。等有人敲门时定位，或直接添加已知公钥。
							</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>端点</Table.Head>
								<Table.Head>授予时间</Table.Head>
								<Table.Head>有效期</Table.Head>
								<Table.Head class="w-2"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each visitors as v (v.endpoint_id)}
								<Table.Row>
									<Table.Cell><HexValue value={v.endpoint_id} alias={v.alias ?? null} kind="端点" /></Table.Cell>
									<Table.Cell class="whitespace-nowrap text-muted-foreground">{formatTime(v.granted_at)}</Table.Cell>
									<Table.Cell class="text-muted-foreground">
										{typeof v.expires_at === "number" ? formatTime(v.expires_at) : "长期有效"}
									</Table.Cell>
									<Table.Cell>
										<div class="flex justify-end">
											<Button
												variant="ghost"
												size="sm"
												class="h-7 text-destructive hover:text-destructive"
												onclick={() => cs.askRemoveVisitor(v)}
											>
												移出
											</Button>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}

				<!-- 添加访客（直接添加已知公钥） -->
				<form
					class="flex flex-wrap items-end gap-3"
					onsubmit={(e) => {
						e.preventDefault();
						void cs.submitAddVisitor();
					}}
				>
					<Field.Field data-invalid={!visitorEndpointOk} class="min-w-72 flex-1">
						<Field.Label for="visitor-endpoint-input" class="text-xs text-muted-foreground">添加访客</Field.Label>
						<div class="flex flex-wrap gap-2">
							<Input
								id="visitor-endpoint-input"
								class="font-mono text-[13px]"
								aria-invalid={!visitorEndpointOk}
								placeholder="端点公钥（64 位十六进制字符）"
								value={cs.visitorForm.endpointId}
								oninput={(e) => cs.onVisitorInput("endpointId", e.currentTarget.value)}
								autocomplete="off"
								spellcheck="false"
							/>
							<Input
								class="w-40"
								placeholder="别名（可选）"
								value={cs.visitorForm.alias}
								oninput={(e) => cs.onVisitorInput("alias", e.currentTarget.value)}
								autocomplete="off"
							/>
							<Button type="submit" disabled={cs.visitorBusy || cs.visitorForm.endpointId === "" || !visitorEndpointOk}>
								{#if cs.visitorBusy}
									<LoaderCircle data-icon="inline-start" class="animate-spin" />
									添加中…
								{:else}
									<UserRoundPlus data-icon="inline-start" />
									添加访客
								{/if}
							</Button>
						</div>
						{#if !visitorEndpointOk}
							<Field.Error>需为 64 位十六进制字符（0-9 / a-f）。</Field.Error>
						{/if}
					</Field.Field>
				</form>
			</Card.Content>
		</Card.Root>

		<!-- ③ 黑名单 -->
		<Card.Root class="gap-4 py-5" data-section="blocklist">
			<Card.Header>
				<Card.Title class="text-base">黑名单</Card.Title>
				<Card.Description>
					被拉黑的设备即使持有有效通行票也无法接入；黑名单在一切准入判定之前生效。
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if cs.blocklistError !== null && cs.blocklistError !== undefined}
					<ErrorBanner error={cs.blocklistError} onRetry={() => void cs.refreshBlocklist()} />
				{:else if blocklistLoading}
					<Skeleton class="h-9 w-full" />
				{:else if blocklist.length === 0}
					<p class="text-sm text-muted-foreground" data-empty="blocklist">黑名单是空的。</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>维度</Table.Head>
								<Table.Head>对象</Table.Head>
								<Table.Head>原因</Table.Head>
								<Table.Head>加入时间</Table.Head>
								<Table.Head class="w-2"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each blocklist as b (b.kind + b.id)}
								<Table.Row>
									<Table.Cell>
										<Badge variant="outline" class="text-xs">{blockKindLabel(b.kind)}</Badge>
									</Table.Cell>
									<Table.Cell><HexValue value={b.id} kind="对象" /></Table.Cell>
									<Table.Cell class="text-muted-foreground">{b.reason ?? "-"}</Table.Cell>
									<Table.Cell class="whitespace-nowrap text-muted-foreground">{formatTime(b.ts)}</Table.Cell>
									<Table.Cell>
										<div class="flex justify-end">
											<Button
												variant="ghost"
												size="sm"
												class="h-7"
												onclick={() => cs.askRemoveBlock(b)}
											>
												移出
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

		<!-- ④ 房门说明（解释性静态内容，Phase 2 边界） -->
		<Card.Root class="gap-3 py-5">
			<Card.Header>
				<Card.Title class="text-base">这栋楼有两道门。</Card.Title>
			</Card.Header>
			<Card.Content class="text-sm leading-relaxed text-muted-foreground">
				<p>
					<strong class="font-medium text-foreground">楼门</strong>（本页）：由你决定谁能进——租户名册、访客名册与黑名单。
				</p>
				<p class="mt-1.5">
					<strong class="font-medium text-foreground">房门</strong>（各租户房间）：租户在自己网络内部的成员名单，由租户自管；「访客到了租户门口，租户开不开门」属于房门规则，当前由
					Fabric 成员门控承担，本控制台暂不提供租户侧门禁配置。
				</p>
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- 3a 定位为访客（预填 endpoint_id，可补别名） -->
	<ConfirmDialog
		open={action?.kind === "locate"}
		title="让这个设备进楼？"
		confirmLabel="定位为访客"
		oncancel={() => cs.cancelKnockAction()}
		onconfirm={() => void cs.confirmLocateVisitor()}
	>
		{#if action?.kind === "locate"}
			<p class="text-foreground">
				将把端点 <span class="font-mono text-[13px]">({shortHex(action.knock.endpoint_id)})</span>
				加入访客名册。加入后，这个设备可以连接这台服务器（relay 通行；定向解析=Phase
				2），但<strong class="font-medium text-foreground">没有自己的房间、不能被别人找到</strong>。访客身份长期有效，直到你把它移出名单。
			</p>
			<div class="flex items-center gap-2">
				<label class="text-sm text-muted-foreground" for="knock-alias">别名（可选）</label>
				<Input
					id="knock-alias"
					class="h-8 flex-1"
					placeholder="给这个身份起个好认的名字"
					value={action.alias}
					oninput={(e) => cs.setKnockAction({ kind: "locate", alias: e.currentTarget.value })}
					autocomplete="off"
				/>
			</div>
		{/if}
	</ConfirmDialog>

	<!-- 3b 导入为租户（引导而非阻断：敲门记录只有敲门人的钥匙，没有房间号） -->
	<ConfirmDialog
		open={action?.kind === "import"}
		title="把这个设备导入为租户？"
		confirmLabel="导入为租户"
		oncancel={() => cs.cancelKnockAction()}
		onconfirm={() => void cs.confirmImportTenant()}
	>
		{#if action?.kind === "import"}
			<p class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-foreground">
				敲门记录只有敲门人的钥匙，没有房间号：请用邀请码让 TA
				自助注册，或手工输入 fabric_id+root。
			</p>
			<div class="flex flex-col gap-3">
				<Field.Field>
					<Field.Label for="knock-root">根端点（已预填敲门端点，可修改）</Field.Label>
					<Input
						id="knock-root"
						class="font-mono text-[13px]"
						value={action.knock.endpoint_id}
						readonly
						title={action.knock.endpoint_id}
					/>
					<Field.Description>请先核对根端点缩写与敲门端点一致再导入。</Field.Description>
				</Field.Field>
				<Field.Field data-invalid={action.fabricId !== "" && validateHex64(action.fabricId) === null}>
					<Field.Label for="knock-fabric">Fabric（64 位十六进制，需补填）</Field.Label>
					<Input
						id="knock-fabric"
						class="font-mono text-[13px]"
						placeholder="64 位十六进制字符（0-9 / a-f）"
						value={action.fabricId}
						oninput={(e) => cs.setKnockAction({ kind: "import", fabricId: e.currentTarget.value })}
						autocomplete="off"
						spellcheck="false"
					/>
					{#if action.fabricId !== "" && validateHex64(action.fabricId) === null}
						<Field.Error>需为 64 位十六进制字符（0-9 / a-f）。</Field.Error>
					{/if}
				</Field.Field>
			</div>
			<p>导入后它在这台服务器上拥有自己的房间，别人可以按门牌找到它；默认租期 30 天，可随时续期或设为永久。</p>
			<p class="text-muted-foreground">不知道它的 Fabric？改用邀请码，让对方在自己客户端完成注册。</p>
		{/if}
	</ConfirmDialog>

	<!-- 3c 拉黑（强度披露：同票也进不来） -->
	<ConfirmDialog
		open={action?.kind === "block"}
		title="把这个设备拉黑？"
		confirmLabel="确认拉黑"
		oncancel={() => cs.cancelKnockAction()}
		onconfirm={() => void cs.confirmBlockKnock()}
	>
		{#if action?.kind === "block"}
			<p class="text-foreground">
				将把端点 <span class="font-mono text-[13px]">({shortHex(action.knock.endpoint_id)})</span>
				加入黑名单。此后它的敲门不再出现在敲门台；<strong class="font-medium text-foreground">即使它拿到有效通行票，也无法接入</strong>。黑名单在一切准入判定之前生效；移出名单前，这个设备与本服务器彻底无缘。
			</p>
		{/if}
	</ConfirmDialog>

	<!-- 访客移出确认 -->
	<ConfirmDialog
		open={cs.visitorConfirm !== null}
		title="把这个访客移出名册？"
		confirmLabel="确认移出"
		oncancel={() => cs.cancelVisitorConfirm()}
		onconfirm={() => void cs.confirmRemoveVisitor()}
	>
		<p class="text-foreground">
			将把 {cs.visitorConfirm?.alias !== null && cs.visitorConfirm !== null
				? `${cs.visitorConfirm.alias ?? ""} `
				: ""}
			<span class="font-mono text-[13px]">({cs.visitorConfirm ? shortHex(cs.visitorConfirm.endpointId) : ""})</span>
			移出访客名册。移出后，这个设备的新连接立即被拒；再次敲门会重新出现在敲门台。
		</p>
	</ConfirmDialog>

	<!-- 黑名单移出确认 -->
	<ConfirmDialog
		open={cs.blockConfirm !== null}
		title="把它移出黑名单？"
		confirmLabel="确认移出"
		oncancel={() => cs.cancelBlockConfirm()}
		onconfirm={() => void cs.confirmRemoveBlock()}
	>
		<p class="text-foreground">
			移出后，这个{cs.blockConfirm?.kind === "fabric" ? "Fabric" : "端点"}
			<span class="font-mono text-[13px]">({cs.blockConfirm ? shortHex(cs.blockConfirm.id) : ""})</span>
			回到「敲门可见」状态，可重新走放行流程。
		</p>
	</ConfirmDialog>
</section>
