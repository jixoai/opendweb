<script lang="ts">
	// ai 插件·消费方页（ai-subscription-sharing Phase C / design §6 consumer 页；
	// Phase D 写手区接真）。
	// 纯展示组件：数据与动作经 ctl（plugins-ai-controller）注入；页面零 fetch。
	// 分区：接入（贴 aifly1. 链接 / 邀请+密钥分开输入）→ 目录列表（钥环快照 +
	// AUTH/catalog 刷新）→ 本地端点（端口管理——冲突真实报错，不静默换端口）→
	// claude-code 写手（Phase D：选端点 → 预览 diff → 确认应用；token 恒占位符
	// sk-aifly-local——真实凭证绝不写进 ~/.claude/settings.json）。
	// 凭证纪律：粘贴的链接/密钥提交后即刻清空、不回显（钥环列表只有掩码）；
	// 本页不落任何凭证到 localStorage。
	import * as Alert from "$lib/components/ui/alert";
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import { Bot, CircleAlert, PenLine, Play, RefreshCw, Square } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import ConfirmDialog from "../../ConfirmDialog.svelte";
	import type { aiController as AiControllerType } from "$lib/plugins-ai-controller.svelte";
	import type { AiConsumerEndpointRow } from "$lib/api";

	let { entry, ctl }: { entry?: PluginRouteEntry; ctl: AiControllerType } = $props();

	const title = $derived(entry?.title ?? "AI 订阅·消费方");
	const data = $derived(ctl.consumer);

	// ---- 接入表单（链接 / 邀请+密钥 分开输入） ---------------------------------------

	let linkInput = $state("");
	let keyInput = $state("");
	let keyRefInput = $state("");
	let linkBusy = $state(false);
	let keyBusy = $state(false);

	async function submitLink(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const link = linkInput.trim();
		if (!link.startsWith("aifly1.")) {
			toast.error("请粘贴 aifly1. 开头的分享链接。");
			return;
		}
		linkBusy = true;
		const ok = await ctl.importLink(link);
		linkBusy = false;
		// 链接内嵌密钥原文——提交后即刻清空、不回显
		linkInput = "";
		if (ok) toast.success("已导入钥环——刷新目录完成 AUTH 后即可起本地端点");
	}

	async function submitKey(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const key = keyInput.trim();
		const ref = keyRefInput.trim();
		if (!key.startsWith("sk-aifly-")) {
			toast.error("密钥须为 sk-aifly- 开头（裸密钥不带网络信息——需先导入过链接）。");
			return;
		}
		if (ref === "") {
			toast.error("请填写归属提供者（endpointId / 8 字符前缀 / 别名）。");
			return;
		}
		keyBusy = true;
		const ok = await ctl.addKey(key, ref);
		keyBusy = false;
		keyInput = "";
		if (ok) toast.success("密钥已入环（keyId 待下次 AUTH 回填）");
	}

	// ---- 本地端点 -------------------------------------------------------------------

	let epProvider = $state("");
	let epService = $state("");
	let epPort = $state("");
	let epError = $state<string | null>(null);
	let stoppingId = $state<string | null>(null);
	let confirmEndpoint = $state<AiConsumerEndpointRow | null>(null);

	const providerOptions = $derived(data?.providers ?? []);

	async function submitEndpoint(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		epError = null;
		const port = Number(epPort);
		if (epProvider === "" || epService === "") {
			epError = "请选择提供者与服务。";
			return;
		}
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			epError = "本地端口必须是 1-65535 的整数（被占用会真实报错，不会自动换端口）。";
			return;
		}
		if (await ctl.startEndpoint(epProvider, epService, port)) {
			toast.success(`本地端点已监听 127.0.0.1:${port}`);
			epPort = "";
		}
	}

	async function confirmedStopEndpoint(): Promise<void> {
		const row = confirmEndpoint;
		confirmEndpoint = null;
		if (row === null) return;
		stoppingId = row.id;
		if (await ctl.stopEndpoint(row.id)) toast.success("本地端点已关闭");
		stoppingId = null;
	}

	/** 目录服务条目的展示行（ServiceEntry 投影——掩码 detail）。 */
	function serviceRows(services: Array<Record<string, unknown>>): Array<{ serviceId: string; name: string; port: number | string }> {
		return services.map((s) => ({
			serviceId: typeof s.serviceId === "string" ? s.serviceId : "",
			name: typeof s.name === "string" ? s.name : "",
			port: typeof s.defaultPort === "number" ? s.defaultPort : "—",
		}));
	}

	// ---- claude-code 写手（Phase D1：选端点 → 预览 diff → 确认应用） -------------------

	let writerEndpointId = $state("");

	const listeningEndpoints = $derived((data?.endpoints ?? []).filter((e) => e.listener === "listening"));

	async function applyWriter(): Promise<void> {
		await ctl.applyWriter();
		if (ctl.writerApplied !== null) toast.success(`已写入 ${ctl.writerApplied.path}（token=占位符）`);
	}
</script>

<section class="flex flex-col gap-5" data-view="plugin-page" data-plugin="ai" data-plugin-page="consumer">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">{title}</h2>
		<p class="text-sm text-muted-foreground">
			导入提供方分享的 <span class="font-mono text-xs">aifly1.</span> 链接（或邀请+密钥），为授权服务在
			<span class="font-mono text-xs">127.0.0.1</span> 起本地端点——本机工具按 OpenAI 兼容地址接入，字节流透明中继（SSE 流式可用）。
		</p>
	</div>

	{#if ctl.consumerError !== null}
		<Alert.Root variant="destructive" data-error-banner>
			<CircleAlert />
			<Alert.Title>操作失败</Alert.Title>
			<Alert.Description>{ctl.consumerError}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if data === null}
		<div class="flex flex-col gap-3">
			<Skeleton class="h-16 w-full" />
			<Skeleton class="h-16 w-full" />
		</div>
	{:else}
		{#if providerOptions.length === 0}
			<Empty.Root class="border border-dashed">
				<Empty.Header>
					<Empty.Media variant="icon"><Bot /></Empty.Media>
					<Empty.Title>还没有导入任何提供方</Empty.Title>
					<Empty.Description>粘贴对方在「AI 订阅·提供方」页生成的 aifly1. 分享链接开始。</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/if}

		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>贴 aifly1. 分享链接</Card.Title>
					<Card.Description>链接内嵌邀请+密钥+目录快照；提交后原文即刻清空（钥环 0600 本机保存）。</Card.Description>
				</Card.Header>
				<Card.Content>
					<form class="flex flex-col gap-3" onsubmit={(e) => void submitLink(e)} data-form="ai-import-link">
						<div class="flex flex-col gap-1.5">
							<Label for="ai-consumer-link">分享链接</Label>
							<Input id="ai-consumer-link" placeholder="aifly1.eyJ2Ijox…" bind:value={linkInput} disabled={linkBusy} class="font-mono text-xs" />
						</div>
						<div>
							<Button size="sm" type="submit" disabled={linkBusy || linkInput.trim() === ""}>
								{#if linkBusy}导入中…{:else}导入钥环{/if}
							</Button>
						</div>
					</form>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>追加裸密钥（可选）</Card.Title>
					<Card.Description>仅密钥、无网络信息——需先导入过该提供者的链接（提供者=endpointId / 8 字符前缀 / 别名）。</Card.Description>
				</Card.Header>
				<Card.Content>
					<form class="flex flex-col gap-3" onsubmit={(e) => void submitKey(e)} data-form="ai-add-key">
						<div class="grid gap-3 sm:grid-cols-2">
							<div class="flex flex-col gap-1.5">
								<Label for="ai-consumer-key">密钥</Label>
								<Input id="ai-consumer-key" type="password" placeholder="sk-aifly-…" bind:value={keyInput} disabled={keyBusy} class="font-mono text-xs" />
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="ai-consumer-key-ref">归属提供者</Label>
								<Input id="ai-consumer-key-ref" placeholder="imac / 0a1b2c3d…" bind:value={keyRefInput} disabled={keyBusy} class="font-mono text-xs" />
							</div>
						</div>
						<div>
							<Button size="sm" type="submit" disabled={keyBusy || keyInput.trim() === ""}>入环</Button>
						</div>
					</form>
				</Card.Content>
			</Card.Root>
		</div>

		{#each providerOptions as provider (provider.endpointId)}
			<Card.Root data-provider={provider.endpointId}>
				<Card.Header>
					<Card.Title class="flex flex-wrap items-center gap-2.5">
						{provider.alias}
						<span class="font-mono text-xs font-normal text-muted-foreground">{provider.endpointId.slice(0, 16)}…</span>
						<Button size="sm" variant="outline" disabled={ctl.consumerBusy} onclick={() => void ctl.refreshCatalog(provider.endpointId)}>
							<RefreshCw class="size-3.5" /> 刷新目录（AUTH）
						</Button>
					</Card.Title>
					<Card.Description>
						{#each provider.keys as k (k.keyId + k.group)}
							<span class="font-mono text-xs">key {k.keyId === "" ? "（待 AUTH 回填）" : `${k.keyId} · ${k.group}`}</span>
						{:else}
							<span class="text-xs">无密钥</span>
						{/each}
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-col gap-2">
					<p class="text-xs font-medium text-muted-foreground">授权目录</p>
					{#if provider.services.length === 0}
						<p class="text-sm text-muted-foreground">目录为空——点「刷新目录」拉取。</p>
					{:else}
						<div class="flex flex-col gap-1.5">
							{#each serviceRows(provider.services) as s (s.serviceId)}
								<div class="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
									<span class="font-medium">{s.name}</span>
									<span class="font-mono text-muted-foreground">{s.serviceId}</span>
									<Badge variant="outline" class="border-muted-foreground/30 text-muted-foreground">默认端口 {s.port}</Badge>
								</div>
							{/each}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		{/each}

		<Card.Root>
			<Card.Header>
				<Card.Title>本地端点</Card.Title>
				<Card.Description>每个授权服务在 127.0.0.1 起独立监听（启用插件后自动恢复）；端口被占用会真实报错——换一个端口重试。</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				{#if (data.endpoints ?? []).length === 0}
					<p class="text-sm text-muted-foreground">还没有本地端点。</p>
				{:else}
					{#each data.endpoints as row (row.id)}
						<div class="flex flex-wrap items-center gap-2.5 rounded-lg border p-3" data-endpoint={row.id}>
							<span class="text-sm font-medium">{row.name}</span>
							<code class="font-mono text-xs text-muted-foreground">127.0.0.1:{row.port}</code>
							<Badge variant="outline" class={row.listener === "listening" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-muted-foreground/30 bg-muted text-muted-foreground"}>
								{row.listener === "listening" ? "监听中" : "未监听"}
							</Badge>
							<span class="ml-auto">
								<Button size="sm" variant="outline" class="text-destructive" disabled={ctl.consumerBusy} onclick={() => (confirmEndpoint = row)}>
									<Square class="size-3.5" /> 关闭并移除
								</Button>
							</span>
						</div>
					{/each}
				{/if}

				<form class="flex flex-col gap-3" onsubmit={(e) => void submitEndpoint(e)} data-form="ai-start-endpoint">
					<div class="grid gap-3 sm:grid-cols-3">
						<div class="flex flex-col gap-1.5">
							<Label for="ai-ep-provider">提供者</Label>
							<select id="ai-ep-provider" class="dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:ring-3" bind:value={epProvider}>
								<option value="">选择提供者…</option>
								{#each providerOptions as p (p.endpointId)}
									<option value={p.endpointId}>{p.alias}</option>
								{/each}
							</select>
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="ai-ep-service">服务</Label>
							<select id="ai-ep-service" class="dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:ring-3" bind:value={epService} disabled={epProvider === ""}>
								<option value="">选择服务…</option>
								{#each serviceRows(providerOptions.find((p) => p.endpointId === epProvider)?.services ?? []) as s (s.serviceId)}
									<option value={s.serviceId}>{s.name}（默认 {s.port}）</option>
								{/each}
							</select>
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="ai-ep-port">本地端口</Label>
							<Input id="ai-ep-port" type="number" min="1" max="65535" placeholder="4300" bind:value={epPort} class="font-mono" />
						</div>
					</div>
					{#if epError !== null}
						<p class="text-xs text-destructive" data-form-error>{epError}</p>
					{/if}
					<div>
						<Button size="sm" type="submit" disabled={ctl.consumerBusy}>
							<Play class="size-3.5" /> 起本地端点
						</Button>
					</div>
				</form>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><PenLine class="size-4 text-muted-foreground" /> claude-code 写手</Card.Title>
				<Card.Description>
					把选中本地端点写进 <span class="font-mono text-xs">~/.claude/settings.json</span> 的
					<span class="font-mono text-xs">env.ANTHROPIC_BASE_URL</span>；token 恒为占位符
					<span class="font-mono text-xs">sk-aifly-local</span>（真实凭证绝不写入——本地网关剥离凭据头，跨网凭证走钥环）。
					先预览 diff，确认后才落盘。
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3" data-writer-section>
				{#if listeningEndpoints.length === 0}
					<p class="text-sm text-muted-foreground">没有监听中的本地端点——先在上方「本地端点」启动一个。</p>
				{:else}
					<div class="flex flex-wrap items-end gap-2.5">
						<div class="flex min-w-56 flex-col gap-1.5">
							<Label for="ai-writer-endpoint">本地端点</Label>
							<select id="ai-writer-endpoint" class="dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:ring-3" bind:value={writerEndpointId} disabled={ctl.writerBusy}>
								<option value="">选择端点…</option>
								{#each listeningEndpoints as ep (ep.id)}
									<option value={ep.id}>{ep.name} · 127.0.0.1:{ep.port}</option>
								{/each}
							</select>
						</div>
						<Button size="sm" variant="outline" disabled={ctl.writerBusy || writerEndpointId === ""} onclick={() => void ctl.previewWriter(writerEndpointId)} data-action="ai-writer-preview">
							<Play class="size-3.5" /> 预览改动
						</Button>
					</div>

					{#if ctl.writerError !== null}
						<Alert.Root variant="destructive" data-writer-error>
							<CircleAlert />
							<Alert.Title>写手操作失败</Alert.Title>
							<Alert.Description>{ctl.writerError}</Alert.Description>
						</Alert.Root>
					{/if}

					{#if ctl.writerPreview !== null}
						{@const preview = ctl.writerPreview}
						<div class="flex flex-col gap-2 rounded-lg border p-3" data-writer-diff>
							<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<span class="font-medium text-foreground">{preview.path}</span>
								<Badge variant="outline" class="border-muted-foreground/30 text-muted-foreground">{preview.exists ? "已存在，surgical 合并" : "新建"}</Badge>
								<code class="font-mono">base = {preview.baseUrl}</code>
							</div>
							{#if preview.diff === ""}
								<p class="text-sm text-muted-foreground">无变更——配置已是目标状态（可直接关闭）。</p>
							{:else}
								<pre class="max-h-72 overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed">{preview.diff}</pre>
							{/if}
							<div class="flex flex-wrap items-center gap-2">
								<Button size="sm" disabled={ctl.writerBusy || preview.diff === ""} onclick={() => void applyWriter()} data-action="ai-writer-apply">
									{#if ctl.writerBusy}写入中…{:else}确认应用（写入文件）{/if}
								</Button>
								<Button size="sm" variant="ghost" disabled={ctl.writerBusy} onclick={() => ctl.closeWriterView()}>取消</Button>
								<span class="text-xs text-muted-foreground">令牌 sha256:{preview.tokenSha256.slice(0, 12)}…（预览后文件被改动会拒绝写入）</span>
							</div>
						</div>
					{/if}

					{#if ctl.writerApplied !== null}
						<div class="flex flex-col gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3" data-writer-applied>
							<p class="text-sm font-medium text-emerald-600 dark:text-emerald-400">已写入 {ctl.writerApplied.path}</p>
							<p class="font-mono text-xs text-muted-foreground">ANTHROPIC_BASE_URL = {ctl.writerApplied.baseUrl} · ANTHROPIC_AUTH_TOKEN = sk-aifly-local（占位符）</p>
							<div>
								<Button size="sm" variant="ghost" onclick={() => ctl.closeWriterView()}>知道了</Button>
							</div>
						</div>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}

	<ConfirmDialog
		open={confirmEndpoint !== null}
		title="关闭并移除这个本地端点？"
		onconfirm={() => void confirmedStopEndpoint()}
		oncancel={() => (confirmEndpoint = null)}
	>
		{#if confirmEndpoint !== null}
			<p>127.0.0.1:{confirmEndpoint.port} 的监听将关闭（在途请求被中断）；账本条目一并移除。</p>
		{/if}
	</ConfirmDialog>
</section>
