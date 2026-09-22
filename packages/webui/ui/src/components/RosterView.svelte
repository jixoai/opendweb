<script lang="ts">
	// 名册视角（谁可以用）：列表 / 注册 / 注销（知情前置确认 + 就地回执）。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Empty from "$lib/components/ui/empty";
	import * as Table from "$lib/components/ui/table";
	import * as Field from "$lib/components/ui/field";
	import { Input } from "$lib/components/ui/input";
	import { LoaderCircle, UserRoundPlus, Users } from "@lucide/svelte";
	import { validateHex64 } from "$lib/hex";
	import { formatTime } from "$lib/format";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import HexValue from "./HexValue.svelte";
	import ReceiptCard from "./ReceiptCard.svelte";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	const owners = $derived(Array.isArray(cs.ownersData?.owners) ? cs.ownersData!.owners : []);
	const loading = $derived(cs.ownersData === null && cs.ownersError === null);
	const onlineFabrics = $derived(cs.onlineFabricSet);
	const fabricOk = $derived(validateHex64(cs.ownerForm.fabricId) !== null || cs.ownerForm.fabricId === "");
	const rootOk = $derived(validateHex64(cs.ownerForm.root) !== null || cs.ownerForm.root === "");

	async function register(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		await cs.submitRegister();
		// 成功与否由回执/错误横幅呈现；这里只负责表单清空后的焦点回归
		document.getElementById("owner-fabric-input")?.focus();
	}
</script>

<section class="flex flex-col gap-4" data-section="roster">
	{#if cs.ownersError !== null && cs.ownersError !== undefined}
		<ErrorBanner error={cs.ownersError} onRetry={() => void cs.refreshOwners()} />
	{/if}

	<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
		<!-- 所有者名册表 -->
		<Card.Root class="gap-4 py-5">
			<Card.Header class="flex flex-row flex-wrap items-center gap-2">
				<Card.Title class="text-base">所有者名册</Card.Title>
				<Badge variant="outline" class="font-mono" title="每次所有者名册变更后加 1，用于确认变更已生效">
					名册版本 v{cs.ownersData?.generation ?? "-"}
				</Badge>
			</Card.Header>
			<Card.Content>
				{#if loading}
					<div class="flex flex-col gap-2">
						<Skeleton class="h-9 w-full" />
						<Skeleton class="h-9 w-full" />
						<Skeleton class="h-9 w-full" />
					</div>
				{:else if owners.length === 0}
					<Empty.Root class="py-8">
						<Empty.Header>
							<Empty.Media variant="icon"><Users /></Empty.Media>
							<Empty.Title>名册是空的。</Empty.Title>
							<Empty.Description>注册后，对应的 Fabric 才能通过这台服务器组网。</Empty.Description>
						</Empty.Header>
						<Empty.Content>
							<Button variant="outline" onclick={() => cs.goRegister()}>
								<UserRoundPlus data-icon="inline-start" />
								注册所有者
							</Button>
						</Empty.Content>
					</Empty.Root>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Fabric</Table.Head>
								<Table.Head>根端点</Table.Head>
								<Table.Head>注册时间</Table.Head>
								<Table.Head class="w-2"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each owners as o (o.fabric_id + o.root)}
								<Table.Row>
									<Table.Cell><HexValue value={o.fabric_id} kind="Fabric" /></Table.Cell>
									<Table.Cell><HexValue value={o.root} kind="根端点" /></Table.Cell>
									<Table.Cell class="whitespace-nowrap text-muted-foreground">
										{formatTime(o.registered_at)}
									</Table.Cell>
									<Table.Cell>
										<div class="flex items-center justify-end gap-1.5">
											<Button
												variant="outline"
												size="sm"
												class="h-6 gap-1.5 rounded-full px-2.5 text-xs"
												title={onlineFabrics.has(o.fabric_id)
													? "该所有者有活跃连接——点击查看在线连接明细"
													: "该所有者当前没有活跃连接——点击查看在线视角"}
												onclick={() => cs.goOnline(o.fabric_id)}
											>
												<span
													aria-hidden="true"
													class="size-1.5 rounded-full {onlineFabrics.has(o.fabric_id)
														? 'bg-success'
														: 'bg-muted-foreground/40'}"
												></span>
												{onlineFabrics.has(o.fabric_id) ? "在用" : "未在用"}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												class="h-7 text-destructive hover:text-destructive"
												onclick={() => cs.askUnregister(o)}
											>
												注销
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

		<!-- 注册所有者 -->
		<Card.Root class="gap-4 py-5">
			<Card.Header>
				<Card.Title class="text-base">注册所有者</Card.Title>
				<Card.Description>所有者 = 允许接入这台服务器的一个 Fabric 网络。</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					class="flex flex-col gap-4"
					onsubmit={(e) => void register(e)}
				>
					<Field.Group>
						<Field.Field data-invalid={!fabricOk}>
							<Field.Label for="owner-fabric-input">Fabric</Field.Label>
							<Input
								id="owner-fabric-input"
								name="fabricId"
								class="font-mono text-[13px]"
								aria-invalid={!fabricOk}
								value={cs.ownerForm.fabricId}
								oninput={(e) => cs.onOwnerInput("fabricId", e.currentTarget.value)}
								autocomplete="off"
								spellcheck="false"
								placeholder="64 位十六进制字符（0-9 / a-f）"
							/>
							{#if !fabricOk}
								<Field.Error>
									需为 64 位十六进制字符（0-9 / a-f），可从成员的密钥管理处复制。
								</Field.Error>
							{/if}
						</Field.Field>
						<Field.Field data-invalid={!rootOk}>
							<Field.Label for="owner-root-input">根端点</Field.Label>
							<Input
								id="owner-root-input"
								name="root"
								class="font-mono text-[13px]"
								aria-invalid={!rootOk}
								value={cs.ownerForm.root}
								oninput={(e) => cs.onOwnerInput("root", e.currentTarget.value)}
								autocomplete="off"
								spellcheck="false"
								placeholder="64 位十六进制字符（0-9 / a-f）"
							/>
							{#if !rootOk}
								<Field.Error>
									需为 64 位十六进制字符（0-9 / a-f），可从成员的密钥管理处复制。
								</Field.Error>
							{/if}
						</Field.Field>
					</Field.Group>
					{#if cs.ownerFormError !== null}
						<p class="text-sm text-destructive" role="alert">{cs.ownerFormError}</p>
					{/if}
					<Button
						type="submit"
						disabled={cs.ownerBusy || cs.ownerForm.fabricId === "" || cs.ownerForm.root === "" || !fabricOk || !rootOk}
					>
						{#if cs.ownerBusy}
							<LoaderCircle data-icon="inline-start" class="animate-spin" />
							提交中…
						{:else}
							注册
						{/if}
					</Button>
				</form>
			</Card.Content>
		</Card.Root>
	</div>

	<!-- 变更回执（动作上下文就地展示） -->
	{#if cs.receipt !== null}
		<div class="flex flex-col gap-2">
			<h3 class="text-sm font-medium text-muted-foreground">变更回执</h3>
			<ReceiptCard receipt={cs.receipt} />
		</div>
	{/if}

	<!-- 注销确认（知情前置：范围 + 连带断开 + 恢复路径） -->
	<ConfirmDialog
		open={cs.ownerConfirm !== null}
		title="注销这个所有者？"
		confirmLabel="确认注销"
		oncancel={() => cs.cancelOwnerConfirm()}
		onconfirm={() => void cs.confirmUnregister()}
	>
		<p class="text-foreground">将从名册移除以下所有者：</p>
		<p>
			Fabric
			<span class="font-mono text-[13px] text-foreground" title={cs.ownerConfirm?.fabricId}>
				{cs.ownerConfirm?.fabricId.slice(0, 8)}…
			</span>
			· 根端点
			<span class="font-mono text-[13px] text-foreground" title={cs.ownerConfirm?.root}>
				{cs.ownerConfirm?.root.slice(0, 8)}…
			</span>
		</p>
		<p>移除后，该 Fabric 的新连接立即被拒；名下如仍有在线连接，将一并断开（异步收敛）。如需恢复，重新注册即可。</p>
	</ConfirmDialog>
</section>
