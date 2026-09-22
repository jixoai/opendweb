<script lang="ts">
	// 租户管理页：租户名册（二元组呈现 + 别名 + 状态/租期 + 续期 + 注销）在上，
	// 邀请码管理子区块（签发表单 + 一次性全文视图 + 列表 + 吊销）在下——邀请码
	// 是租户的创建通道之一，不设独立一级导航。「注册租户」双通道：手工导入
	// 公钥 / 签发邀请码。文案逐字采用 PRODUCT-DESIGN §4.2/§4.3/§5.2。
	import * as Card from "$lib/components/ui/card";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Empty from "$lib/components/ui/empty";
	import * as Table from "$lib/components/ui/table";
	import * as Field from "$lib/components/ui/field";
	import { Input } from "$lib/components/ui/input";
	import { Copy, DoorOpen, KeyRound, LoaderCircle, TriangleAlert, UserRoundPlus, Users } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { validateHex64, shortHex } from "$lib/hex";
	import { fmtDate, formatTime, groupInviteCode, leaseState } from "$lib/format";
	import { codeStatus, multiRootFabrics } from "$lib/terms";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import HexValue from "./HexValue.svelte";
	import ReceiptCard from "./ReceiptCard.svelte";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	const owners = $derived(Array.isArray(cs.ownersData?.owners) ? cs.ownersData!.owners : []);
	const loading = $derived(cs.ownersData === null && cs.ownersError === null);
	const onlineFabrics = $derived(cs.onlineFabricSet);
	const multiRoot = $derived(multiRootFabrics(owners));
	const fabricOk = $derived(validateHex64(cs.ownerForm.fabricId) !== null || cs.ownerForm.fabricId === "");
	const rootOk = $derived(validateHex64(cs.ownerForm.root) !== null || cs.ownerForm.root === "");
	const codes = $derived(Array.isArray(cs.codesData?.codes) ? cs.codesData!.codes : []);
	const codesLoading = $derived(cs.codesData === null && cs.codesError === null);
	const renew = $derived(cs.renewConfirm);
	const renewTarget = $derived(
		renew === null
			? null
			: owners.find((o) => o.fabric_id === renew.fabricId && o.root === renew.root) ?? null,
	);
	/** 续期弹窗标题（PM §4.3：续期：李四团队 (ab12***cd34)——别名+缩写双展示铁则）。 */
	const renewTitle = $derived(
		renew === null ? "" : `续期：${renew.alias !== null ? `${renew.alias} ` : ""}(${shortHex(renew.root)})`,
	);
	/** 签发副注（PM §4.2 步 3：次数 1 次 · 7 天内有效（今天 9 月 23 日签发，9 月 30 日过期））。 */
	const issuedNote = $derived.by(() => {
		const ic = cs.issuedCode;
		if (ic === null) return "";
		const zhDay = (d: Date) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
		const today = new Date();
		const expiry = new Date(today.getTime() + ic.expiresInDays * 86_400_000);
		return `次数 ${ic.maxUses} 次 · ${ic.expiresInDays} 天内有效（今天 ${zhDay(today)}签发，${zhDay(expiry)}过期）`;
	});

	async function register(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		await cs.submitRegister();
		document.getElementById("owner-fabric-input")?.focus();
	}

	async function issue(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		await cs.submitIssueCode();
	}

	async function copyCode(code: string): Promise<void> {
		const ok = await cs.copyText(code);
		if (ok) toast.success("已复制邀请码全文");
	}

	function leaseBadgeClass(state: string): string {
		if (state === "expired") return "border-destructive/30 bg-destructive/10 text-destructive";
		if (state === "expiring") return "border-warning/40 bg-warning/10 text-warning";
		return "border-border bg-muted/50 text-muted-foreground";
	}
</script>

<section class="flex flex-col gap-5" data-view="tenants">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">租户管理</h2>
		<p class="text-sm text-muted-foreground">
			租户 = 在这台服务器上拥有自己房间（可被发现、可组网）的一个 Fabric 网络。名册、租期与邀请码都在这里。
		</p>
	</div>

	{#if cs.ownersError !== null && cs.ownersError !== undefined}
		<ErrorBanner error={cs.ownersError} onRetry={() => void cs.refreshOwners()} />
	{/if}

	<div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
		<!-- 租户名册表（主角） -->
		<Card.Root class="gap-4 py-5">
			<Card.Header class="flex flex-row flex-wrap items-center gap-2">
				<Card.Title class="text-base">租户名册</Card.Title>
				<Badge variant="outline" class="font-mono" title="每次租户名册变更后加 1，用于确认变更已生效">
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
							<Empty.Title>这栋楼还没有租户。</Empty.Title>
							<Empty.Description>
								受限模式下，名册为空意味着除了你没有人能进楼。开号有两种方式：发一张邀请码让对方自助注册，或手工导入已知的公钥。
							</Empty.Description>
						</Empty.Header>
						<Empty.Content class="flex gap-2">
							<Button variant="outline" onclick={() => cs.goRegister()}>
								<UserRoundPlus data-icon="inline-start" />
								手工导入
							</Button>
							<Button onclick={() => cs.goIssueCode()}>
								<KeyRound data-icon="inline-start" />
								签发邀请码
							</Button>
						</Empty.Content>
					</Empty.Root>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>租户（Fabric · 根端点）</Table.Head>
								<Table.Head>状态 / 租期</Table.Head>
								<Table.Head>注册时间</Table.Head>
								<Table.Head class="w-2"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each owners as o (o.fabric_id + o.root)}
								{@const lease = leaseState(typeof o.expires_at === "number" ? o.expires_at : null)}
								<Table.Row>
									<Table.Cell>
										<div class="flex flex-col gap-1">
											<span class="text-sm">
												{#if typeof o.alias === "string" && o.alias !== ""}
													<span class="font-medium">{o.alias}</span>
												{/if}
											</span>
											<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
												<span class="text-xs text-muted-foreground">
													Fabric <span class="font-mono text-[13px] text-foreground" title={o.fabric_id}>{shortHex(o.fabric_id)}</span>
													· 根端点 <span class="font-mono text-[13px] text-foreground" title={o.root}>{shortHex(o.root)}</span>
												</span>
												{#if multiRoot.has(o.fabric_id)}
													<Badge variant="outline" class="h-5 gap-1 border-warning/40 bg-warning/10 px-1.5 text-[11px] text-warning" title="同 Fabric 有多个根端点——别名可以仿名，仿不了缩写；请核对根端点缩写再操作">
														<TriangleAlert class="size-3" />
														同 Fabric 多根端点
													</Badge>
												{/if}
											</div>
											{#if lease.state === "expired"}
												<span class="text-xs text-destructive">新连接正被拒绝；续期后立即恢复。</span>
											{/if}
										</div>
									</Table.Cell>
									<Table.Cell>
										<Badge variant="outline" class={leaseBadgeClass(lease.state)}>{lease.label}</Badge>
									</Table.Cell>
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
													? "该租户有活跃连接——点击查看在线连接明细"
													: "该租户当前没有活跃连接——点击查看在线视角"}
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
												class="h-7"
												onclick={() => cs.askRenew(o)}
											>
												续期
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

		<!-- 手工导入（注册租户的双通道之一） -->
		<Card.Root class="gap-4 py-5">
			<Card.Header>
				<Card.Title class="text-base">手工导入公钥</Card.Title>
				<Card.Description>
					已知道对方 Fabric 与根端点时用这里；否则发一张邀请码，让对方在自己客户端完成注册。
				</Card.Description>
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
							导入为租户
						{/if}
					</Button>
					<p class="text-xs leading-relaxed text-muted-foreground">导入后默认租期 30 天，可随时续期或设为永久。</p>
				</form>
			</Card.Content>
		</Card.Root>
	</div>

	<!-- 邀请码管理子区块 -->
	<Card.Root class="gap-4 py-5" data-section="codes">
		<Card.Header>
			<Card.Title class="text-base">邀请码</Card.Title>
			<Card.Description>租户拿到码，在自己客户端完成注册，无需你手工导入。</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-5">
			{#if cs.codesError !== null && cs.codesError !== undefined}
				<ErrorBanner error={cs.codesError} onRetry={() => void cs.refreshCodes()} />
			{/if}

			<!-- 签发表单 -->
			<form class="grid gap-4 md:grid-cols-2 xl:grid-cols-4 xl:items-end" onsubmit={(e) => void issue(e)}>
				<Field.Field>
					<Field.Label for="code-alias-hint">别名提示（可选）</Field.Label>
					<Input
						id="code-alias-hint"
						value={cs.codeForm.aliasHint}
						oninput={(e) => cs.onCodeInput("aliasHint", e.currentTarget.value)}
						autocomplete="off"
						placeholder="如「李四团队」——兑换后作为名册别名预填建议"
					/>
					<Field.Description>兑换成功后作为名册别名的预填建议。</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="code-max-uses">可用次数</Field.Label>
					<Input
						id="code-max-uses"
						type="number"
						min="1"
						value={cs.codeForm.maxUses}
						oninput={(e) => cs.onCodeInput("maxUses", e.currentTarget.value)}
					/>
					<Field.Description>默认 1。每兑换一次计数减一，用尽作废。</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="code-expires">有效期（天）</Field.Label>
					<Input
						id="code-expires"
						type="number"
						min="1"
						value={cs.codeForm.expiresInDays}
						oninput={(e) => cs.onCodeInput("expiresInDays", e.currentTarget.value)}
					/>
					<Field.Description>默认 7 天。到期未用完的次数自动作废。</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="code-ttl">注册后有效期（天）</Field.Label>
					<Input
						id="code-ttl"
						type="number"
						min="1"
						value={cs.codeForm.defaultTtlDays}
						oninput={(e) => cs.onCodeInput("defaultTtlDays", e.currentTarget.value)}
					/>
					<Field.Description>默认 30 天。兑换注册后的租期长度。</Field.Description>
				</Field.Field>
				<div class="md:col-span-2 xl:col-span-4">
					<Button id="code-issue-button" type="submit" disabled={cs.codeBusy}>
						{#if cs.codeBusy}
							<LoaderCircle data-icon="inline-start" class="animate-spin" />
							签发中…
						{:else}
							<KeyRound data-icon="inline-start" />
							签发邀请码
						{/if}
					</Button>
				</div>
			</form>

			<!-- 已签发列表（真源：只含哈希缩写与计数） -->
			{#if codesLoading}
				<div class="flex flex-col gap-2">
					<Skeleton class="h-9 w-full" />
					<Skeleton class="h-9 w-full" />
				</div>
			{:else if codes.length === 0}
				<p class="text-sm text-muted-foreground" data-empty="codes">还没有签发过邀请码。</p>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>码指纹</Table.Head>
							<Table.Head>别名提示</Table.Head>
							<Table.Head class="text-right">已用 / 上限</Table.Head>
							<Table.Head>状态</Table.Head>
							<Table.Head>到期时间</Table.Head>
							<Table.Head class="w-2"></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each codes as c (c.code_hash)}
							{@const status = codeStatus(c)}
							<Table.Row>
								<Table.Cell><HexValue value={c.code_hash} kind="码指纹" /></Table.Cell>
								<Table.Cell class="text-muted-foreground">{c.alias_hint ?? "-"}</Table.Cell>
								<Table.Cell class="text-right font-mono tabular-nums">{c.used_count} / {c.max_uses}</Table.Cell>
								<Table.Cell>
									<Badge
										variant="outline"
										class={status.status === "available"
											? "border-success/30 bg-success/10 text-success"
											: status.status === "revoked"
												? "border-destructive/30 bg-destructive/10 text-destructive"
												: "border-border bg-muted/50 text-muted-foreground"}
									>
										{status.label}
									</Badge>
								</Table.Cell>
								<Table.Cell class="whitespace-nowrap text-muted-foreground">{fmtDate(c.expires_at)}</Table.Cell>
								<Table.Cell>
									<div class="flex justify-end">
										{#if status.status === "available"}
											<Button
												variant="ghost"
												size="sm"
												class="h-7 text-destructive hover:text-destructive"
												onclick={() => cs.askRevokeCode(c.code_hash)}
											>
												吊销
											</Button>
										{/if}
									</div>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- 变更回执（动作上下文就地展示） -->
	{#if cs.receipt !== null}
		<div class="flex flex-col gap-2">
			<h3 class="text-sm font-medium text-muted-foreground">变更回执</h3>
			<ReceiptCard receipt={cs.receipt} />
		</div>
	{/if}

	<!-- 注销确认（知情前置：范围 + 连带断开 + 恢复路径；到期≠注销的语义区分） -->
	<ConfirmDialog
		open={cs.ownerConfirm !== null}
		title="注销这个租户？"
		confirmLabel="确认注销"
		oncancel={() => cs.cancelOwnerConfirm()}
		onconfirm={() => void cs.confirmUnregister()}
	>
		<p class="text-foreground">将从名册移除以下租户：</p>
		<p>
			Fabric
			<span class="font-mono text-[13px] text-foreground" title={cs.ownerConfirm?.fabricId}>
				{shortHex(cs.ownerConfirm?.fabricId)}
			</span>
			· 根端点
			<span class="font-mono text-[13px] text-foreground" title={cs.ownerConfirm?.root}>
				{shortHex(cs.ownerConfirm?.root)}
			</span>
		</p>
		<p>
			注销是退租（条目移除、需重新注册），与到期（条目还在、续期即恢复）不同。移除后，该 Fabric
			的新连接立即被拒；名下如仍有在线连接，将一并断开（异步收敛）。如需恢复，重新注册即可。
		</p>
	</ConfirmDialog>

	<!-- 续期弹窗（三选项：顺延 30 天 / 自定义到期日 / 设为永久） -->
	<ConfirmDialog
		open={cs.renewConfirm !== null}
		title={renewTitle}
		confirmLabel="确认续期"
		oncancel={() => cs.cancelRenew()}
		onconfirm={() => void cs.confirmRenew()}
	>
		{#if renew !== null}
			<p class="text-foreground">
				当前到期时间：
				{#if renewTarget != null && typeof renewTarget.expires_at === "number"}
					{fmtDate(renewTarget.expires_at)}
				{:else}
					永久
				{/if}
			</p>
			<div class="flex flex-col gap-2">
				<label class="flex items-center gap-2">
					<input type="radio" name="renew-mode" checked={renew.mode === "extend30"} onchange={() => cs.setRenewMode("extend30")} />
					顺延 30 天
				</label>
				<label class="flex items-center gap-2">
					<input type="radio" name="renew-mode" checked={renew.mode === "custom"} onchange={() => cs.setRenewMode("custom")} />
					自定义到期日
					<Input
						type="date"
						class="ml-2 h-7 w-40"
						value={renew.date}
						oninput={(e) => cs.setRenewDate(e.currentTarget.value)}
						onclick={() => cs.setRenewMode("custom")}
					/>
				</label>
				<label class="flex items-center gap-2">
					<input type="radio" name="renew-mode" checked={renew.mode === "permanent"} onchange={() => cs.setRenewMode("permanent")} />
					设为永久
				</label>
			</div>
			<p>续期后新连接立即恢复，别名与门牌不变。</p>
		{/if}
	</ConfirmDialog>

	<!-- 吊销确认（二次确认：兑换立即失效，已注册租户不受影响） -->
	<ConfirmDialog
		open={cs.revokeCodeConfirm !== null}
		title="吊销这张邀请码？"
		confirmLabel="确认吊销"
		oncancel={() => cs.cancelRevokeCode()}
		onconfirm={() => void cs.confirmRevokeCode()}
	>
		<p>未使用的次数立即作废；<strong class="font-medium text-foreground">已用它注册的租户不受影响</strong>。此操作不可撤销。</p>
	</ConfirmDialog>

	<!-- 签发成功：一次性完整码视图（仅此一次） -->
	<Dialog.Root open={cs.issuedCode !== null} onOpenChange={(v) => (v === false ? cs.closeIssuedCode() : undefined)}>
		<Dialog.Content class="sm:max-w-lg" data-one-time="code">
			<Dialog.Header>
				<Dialog.Title>邀请码已签发</Dialog.Title>
				<Dialog.Description class="sr-only">完整码只显示这一次</Dialog.Description>
			</Dialog.Header>
			{#if cs.issuedCode !== null}
				<div class="flex flex-col gap-4">
					<div class="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
						<code class="text-lg font-semibold tracking-wide">{groupInviteCode(cs.issuedCode.code)}</code>
						<Button variant="outline" size="sm" onclick={() => void copyCode(cs.issuedCode!.code)}>
							<Copy data-icon="inline-start" />
							复制
						</Button>
					</div>
					<p class="text-sm leading-relaxed">
						<strong class="font-medium text-foreground">此码只显示这一次，关闭后无法再查看完整码</strong>——服务器只保存码的指纹。请立即复制并发给对方。
					</p>
					<p class="text-xs text-muted-foreground">{issuedNote}</p>
				</div>
			{/if}
			<Dialog.Footer>
				<Button onclick={() => cs.closeIssuedCode()}>
					<DoorOpen data-icon="inline-start" />
					我已复制，关闭
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
</section>
