<script lang="ts">
	// 节点簿面板（顶栏呼出；不占侧栏位）：当前节点 / 已保存节点列表（切换/删除）/
	// 添加节点（紧凑三步：地址 + 管理凭证 + 配对码——终端打印，10 分钟内有效）。
	// 切换 = 进程内即时（无重启）：行内过渡态「正在切换到 <节点名>…」，完成后
	// 健康灯恢复即完成，无成功弹窗打扰。文案逐字采用 PRODUCT-DESIGN §4.4。
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import * as Dialog from "$lib/components/ui/dialog";
	import * as Field from "$lib/components/ui/field";
	import { Input } from "$lib/components/ui/input";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import { CircleCheck, LoaderCircle, Plus, Trash2 } from "@lucide/svelte";
	import { connectErrorCopy } from "$lib/copy";
	import { maskNodeUrl } from "$lib/terms";
	import { fmtDate } from "$lib/format";
	import type { SidecarNode } from "$lib/api";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ErrorBanner from "./ErrorBanner.svelte";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	const nodes = $derived(Array.isArray(cs.nodesData?.nodes) ? cs.nodesData!.nodes : []);
	const loading = $derived(cs.nodesData === null && cs.nodesError === null);
	const switching = $derived(cs.switchingTo);
	const addErr = $derived(cs.addNodeError !== null ? connectErrorCopy(cs.addNodeError) : null);
	const confirmNode = $derived(cs.nodeConfirm);

	function nodeLabel(n: SidecarNode): string {
		return n.name.trim() !== "" ? n.name : maskNodeUrl(n.server_host);
	}

	async function addNode(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		await cs.submitAddNode();
	}
</script>

<Dialog.Root open={cs.detailsOpen} onOpenChange={(v) => cs.toggleDetails(v)}>
	<Dialog.Content class="sm:max-w-lg" data-panel="node-book">
		<Dialog.Header>
			<Dialog.Title>节点簿</Dialog.Title>
			<Dialog.Description>
				你在本地保存的多台服务器；凭证只保存在本机私有文件，浏览器不保存。
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-5">
			{#if switching !== null}
				<div class="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm" data-state="switching">
					<LoaderCircle class="size-4 animate-spin text-warning" />
					正在切换到「{switching}」…
				</div>
			{/if}

			{#if cs.nodesError !== null}
				<ErrorBanner error={cs.nodesError} onRetry={() => void cs.refreshNodes()} />
			{/if}

			<!-- 当前节点 -->
			<section class="flex flex-col gap-2">
				<h3 class="text-sm font-semibold">当前节点</h3>
				<dl class="grid grid-cols-[92px_1fr] items-baseline gap-x-3 gap-y-2 text-sm">
					<dt class="text-muted-foreground">地址</dt>
					<dd class="font-mono text-[13px]">{cs.sidecar?.server_host_masked ?? "-"}</dd>
					<dt class="text-muted-foreground">安全模型</dt>
					<dd class="leading-relaxed">
						管理凭证保存在本机（仅本机用户可读的私有文件，权限 0600），浏览器不保存、不回显。
					</dd>
				</dl>
				{#if cs.sidecar?.insecure === true}
					<div class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
						连接未加密：当前节点经明文 http 传输，管理凭证与管理流量未加密。
					</div>
				{/if}
			</section>

			<!-- 已保存节点列表（一次一个当前节点） -->
			<section class="flex flex-col gap-2">
				<h3 class="text-sm font-semibold">已保存节点</h3>
				{#if loading}
					<div class="flex flex-col gap-2">
						<Skeleton class="h-10 w-full" />
						<Skeleton class="h-10 w-full" />
					</div>
				{:else if nodes.length === 0}
					<p class="text-sm text-muted-foreground" data-empty="nodes">
						节点簿是空的。第一次切换到其他节点时，当前节点会自动保存进来。
					</p>
				{:else}
					<ul class="flex flex-col gap-2">
						{#each nodes as n (n.id)}
							<li
								class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 {n.current
									? 'border-success/30 bg-success/5'
									: ''}"
								data-node={n.id}
							>
								<div class="flex min-w-0 flex-1 flex-col">
									<span class="truncate text-sm font-medium">{nodeLabel(n)}</span>
									<span class="truncate font-mono text-xs text-muted-foreground" title={maskNodeUrl(n.server_host)}>
										{maskNodeUrl(n.server_host)} · 保存于 {fmtDate(n.added_at)}
									</span>
								</div>
								{#if n.current}
									<Badge variant="outline" class="gap-1 border-success/30 bg-success/10 text-success">
										<CircleCheck class="size-3" />
										当前
									</Badge>
								{:else if switching === null}
									<Button variant="outline" size="sm" onclick={() => cs.askSwitchNode(n)}>切换</Button>
								{/if}
								<Button
									variant="ghost"
									size="icon"
									class="size-7 text-muted-foreground hover:text-destructive"
									title={n.current ? "当前节点不能删除——先切换到其他节点" : "删除这个节点"}
									aria-label="删除节点 {nodeLabel(n)}"
									disabled={n.current}
									onclick={() => cs.askDeleteNode(n)}
								>
									<Trash2 class="size-3.5" />
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<!-- 添加节点（紧凑三步，同 setup 配对面字段与校验） -->
			<section class="flex flex-col gap-2 border-t pt-4">
				<h3 class="text-sm font-semibold">添加节点</h3>
				<form class="flex flex-col gap-3" onsubmit={(e) => void addNode(e)}>
					<Field.Field>
						<Field.Label for="node-server" class="text-xs">① 服务器地址</Field.Label>
						<Input
							id="node-server"
							placeholder="https://home.example.com:18787"
							class="h-8 font-mono text-[13px]"
							value={cs.addNodeForm.server}
							oninput={(e) => cs.onAddNodeInput("server", e.currentTarget.value)}
							autocomplete="off"
							spellcheck="false"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="node-token" class="text-xs">② 管理凭证</Field.Label>
						<Input
							id="node-token"
							type="password"
							placeholder="粘贴后立即交给本地进程，本页不留存"
							class="h-8"
							value={cs.addNodeForm.token}
							oninput={(e) => cs.onAddNodeInput("token", e.currentTarget.value)}
							autocomplete="off"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="node-code" class="text-xs">③ 配对码（终端打印，10 分钟内有效）</Field.Label>
						<!-- 不做 CSS 大写化：占位符含终端命令「node book add code:」，命令大小写敏感 -->
						<Input
							id="node-code"
							placeholder="终端「node book add code:」一行"
							class="h-8 font-mono"
							value={cs.addNodeForm.code}
							oninput={(e) => cs.onAddNodeInput("code", e.currentTarget.value)}
							autocomplete="off"
							spellcheck="false"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="node-name" class="text-xs">备注名（可选）</Field.Label>
						<Input
							id="node-name"
							placeholder="如「家里节点」"
							class="h-8"
							value={cs.addNodeForm.name}
							oninput={(e) => cs.onAddNodeInput("name", e.currentTarget.value)}
							autocomplete="off"
						/>
					</Field.Field>
					{#if addErr !== null}
						<p class="text-sm text-destructive" role="alert">
							{addErr.title}——{addErr.detail}
						</p>
					{/if}
					<Button type="submit" disabled={cs.addNodeBusy || cs.addNodeForm.server === "" || cs.addNodeForm.token === "" || cs.addNodeForm.code === ""}>
						{#if cs.addNodeBusy}
							<LoaderCircle data-icon="inline-start" class="animate-spin" />
							连接中…
						{:else}
							<Plus data-icon="inline-start" />
							连接并保存
						{/if}
					</Button>
				</form>
			</section>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => cs.toggleDetails(false)}>关闭</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- 切换确认（安全披露：即时切换 + 凭证边界 + 两楼门禁互不影响） -->
<ConfirmDialog
	open={confirmNode?.kind === "switch"}
	title="切换到「{confirmNode?.kind === "switch" ? nodeLabel(confirmNode.node) : ""}」？"
	confirmLabel="切换"
	oncancel={() => cs.cancelNodeConfirm()}
	onconfirm={() => void cs.confirmSwitchNode()}
>
	<p class="text-foreground">
		切换<strong class="font-medium">立即生效</strong>并指向新节点（无需重启本地后台进程），页面数据自动刷新。
	</p>
	<p>已保存的管理凭证只保存在本机，不会离开你的电脑。</p>
	<p>
		<strong class="font-medium text-foreground">两个节点的门禁互不影响</strong>——你在这边拉的黑，不会挡住另一边的敲门。
	</p>
</ConfirmDialog>

<!-- 删除确认（只删本地配置，不影响那台服务器） -->
<ConfirmDialog
	open={confirmNode?.kind === "delete"}
	title="移除「{confirmNode?.kind === "delete" ? nodeLabel(confirmNode.node) : ""}」？"
	confirmLabel="确认移除"
	oncancel={() => cs.cancelNodeConfirm()}
	onconfirm={() => void cs.confirmDeleteNode()}
>
	<p class="text-foreground">
		只从节点簿删除本地保存的地址与凭证，<strong class="font-medium">不影响那台服务器本身</strong>，也不影响其他节点。
	</p>
</ConfirmDialog>
