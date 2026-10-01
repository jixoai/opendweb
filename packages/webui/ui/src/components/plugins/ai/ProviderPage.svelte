<script lang="ts">
	// ai 插件·提供方页（ai-subscription-sharing Phase C / design §6 provider 页；
	// Phase D 服务行接上游探活）。
	// 纯展示组件：数据与动作全部经 ctl（plugins-ai-controller——绑定层装配的
	// store↔props 面）注入；页面零 fetch。分区（Tabs，二八法则：高频=服务+密钥）：
	// 服务（17 预设选择+自定义+启停+secret 绑定+上游探活）/ 分组（限额=配额）/
	// 密钥与链接（签发一次性展示+本地复制+撤钥三态+aifly1. 链接生成）/ 密钥库 /
	// 用量（元数据聚合）/ 导入器（两阶段 staging）/ 插件配额配置（configSchema
	// 通用 renderer）。
	// 凭证纪律：密钥/链接原文只出现在一次性视图（关闭即清空；复制=显式动作）；
	// 列表/用量恒掩码（keyId/名称/长度指纹）；探活结果三态脱敏（无头表无原始
	// 错误文案）。
	import * as Alert from "$lib/components/ui/alert";
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import * as Tabs from "$lib/components/ui/tabs";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Separator } from "$lib/components/ui/separator";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import { CircleAlert, Copy, KeyRound, Link2, Plus, Sparkles, Trash } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ConfirmDialog from "../../ConfirmDialog.svelte";
	import PluginConfigForm from "../PluginConfigForm.svelte";
	import type { aiController as AiControllerType } from "$lib/plugins-ai-controller.svelte";

	let { entry, ctl }: { entry?: PluginRouteEntry; ctl: AiControllerType } = $props();

	const title = $derived(entry?.title ?? "AI 订阅·提供方");
	const overview = $derived(ctl.overview);
	const pluginEntry = $derived(cs.pluginsData?.plugins.find((p) => p.id === "ai") ?? null);

	async function copy(text: string, what: string): Promise<void> {
		if (await ctl.copyText(text)) toast.success(`${what}已复制到剪贴板`);
		else toast.error("复制失败——剪贴板不可用（请在一次性视图中手动选择复制）");
	}

	// ---- 添加服务（预设 / 自定义） ---------------------------------------------------

	let formPreset = $state("");
	let formName = $state("");
	let formUpstream = $state("");
	let formDomain = $state("");
	let formPort = $state("");
	let formSecret = $state("");
	let formError = $state<string | null>(null);
	let creating = $state(false);

	const presetOptions = $derived((ctl.presets ?? []).filter((p) => p.disabled !== true));
	const presetById = $derived(new Map((ctl.presets ?? []).map((p) => [p.id, p])));

	async function submitCreateService(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		formError = null;
		if (formPreset !== "") {
			creating = true;
			const ok = await ctl.createService({
				preset: formPreset,
				...(formName.trim() !== "" ? { name: formName.trim() } : {}),
				...(formPort.trim() !== "" ? { defaultPort: Number(formPort) } : {}),
				...(formSecret.trim() !== "" ? { auth: { secret: formSecret.trim() } } : {}),
			});
			creating = false;
			if (ok) {
				toast.success("服务已添加");
				formName = "";
				formPort = "";
				formSecret = "";
			}
			return;
		}
		const name = formName.trim();
		const upstream = formUpstream.trim().replace(/\/$/, "");
		const domain = formDomain.trim().replace(/^\./, "");
		if (name === "") {
			formError = "自定义服务必须填写名称。";
			return;
		}
		if (!/^https?:\/\/.+/.test(upstream)) {
			formError = "自定义服务必须填写上游 base URL（http(s)://…）。";
			return;
		}
		if (domain === "") {
			formError = "自定义服务必须填写匹配域名（消费方路由白名单）。";
			return;
		}
		creating = true;
		const ok = await ctl.createService({
			service: {
				name,
				upstream,
				match: [{ type: "suffix", value: `.${domain}` }],
			},
			...(formPort.trim() !== "" ? { defaultPort: Number(formPort) } : {}),
			...(formSecret.trim() !== "" ? { auth: { secret: formSecret.trim() } } : {}),
		});
		creating = false;
		if (ok) {
			toast.success("服务已添加");
			formName = "";
			formUpstream = "";
			formDomain = "";
			formPort = "";
			formSecret = "";
		}
	}

	// ---- 服务行动作 -----------------------------------------------------------------

	let togglingId = $state<string | null>(null);
	let removingId = $state<string | null>(null);
	let confirmService = $state<{ serviceId: string; name: string } | null>(null);

	async function toggleService(serviceId: string, enabled: boolean): Promise<void> {
		togglingId = serviceId;
		await ctl.toggleService(serviceId, enabled);
		togglingId = null;
	}

	/** 探活三态呈现文案（Phase D2：脱敏结果——无原始错误文案）。 */
	function probeText(result: { state: string; status?: number; reason?: string; keyEnv?: string; ms: number }): string {
		if (result.state === "reachable") return `可达（上游应答 ${result.status ?? "?"}，${result.ms}ms）`;
		if (result.state === "no_auth") {
			return result.reason === "keyenv_unbound" ? `未配置 auth——绑定 keyEnv ${result.keyEnv ?? ""} 对应的 secret 后再探活` : "未配置 auth——已绑 secret 在密钥库中缺失";
		}
		const reasons: Record<string, string> = {
			upstream_unreachable: "连接失败或超时",
			timeout: "上游应答超时（>5s）",
			hook_failed: "auth/headers 脚本管线失败",
			path_not_offered: "无白名单路径可探（pattern 路由服务）",
			protocol_error: "服务配置无法构造探活请求",
		};
		return `不可达——${reasons[result.reason ?? ""] ?? result.reason ?? "未知原因"}`;
	}

	async function confirmedRemoveService(): Promise<void> {
		const row = confirmService;
		confirmService = null;
		if (row === null) return;
		removingId = row.serviceId;
		if (await ctl.removeService(row.serviceId)) toast.success("服务已删除");
		removingId = null;
	}

	// ---- 分组 -----------------------------------------------------------------------

	let groupName = $state("");
	let groupError = $state<string | null>(null);
	let limitsEdit = $state<{ name: string; maxConcurrency: string; dailyRequests: string } | null>(null);
	let confirmGroup = $state<string | null>(null);

	async function submitCreateGroup(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		groupError = null;
		if (groupName.trim() === "") {
			groupError = "请填写分组名称。";
			return;
		}
		if (await ctl.createGroup(groupName.trim(), [])) {
			toast.success("分组已创建——下一步勾选服务与设置限额");
			groupName = "";
		}
	}

	async function saveLimits(): Promise<void> {
		const edit = limitsEdit;
		if (edit === null) return;
		const limits: { maxConcurrency?: number; dailyRequests?: number } | null = {};
		if (edit.maxConcurrency.trim() !== "") limits.maxConcurrency = Number(edit.maxConcurrency);
		if (edit.dailyRequests.trim() !== "") limits.dailyRequests = Number(edit.dailyRequests);
		if (await ctl.setGroupLimits(edit.name, limits)) toast.success("分组限额已更新");
		limitsEdit = null;
	}

	function toggleGroupService(group: string, serviceName: string, member: boolean): void {
		const group0 = overview?.groups.find((g) => g.name === group);
		if (group0 === undefined) return;
		const next = member ? group0.serviceNames.filter((n) => n !== serviceName) : [...group0.serviceNames, serviceName];
		void ctl.setGroupServices(group, next);
	}

	// ---- 密钥与链接 -----------------------------------------------------------------

	let keyGroup = $state("");
	let keyName = $state("");
	let linkGroup = $state("");
	let linkRecipient = $state("");
	let linkKeyId = $state("");
	let confirmKey = $state<{ keyId: string; group: string } | null>(null);

	async function submitIssueKey(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (keyGroup === "") {
			toast.error("请选择签发密钥的分组。");
			return;
		}
		if (await ctl.issueKey(keyGroup, keyName.trim())) {
			toast.success("密钥已签发——原文仅此一次展示");
			keyName = "";
		}
	}

	async function submitMakeLink(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (linkGroup === "" || linkRecipient.trim() === "") {
			toast.error("请选择分组并填写受邀方设备 ID（对端「消费方」页可见）。");
			return;
		}
		if (await ctl.makeLink(linkGroup, linkRecipient.trim(), linkKeyId.trim())) {
			toast.success("分享链接已生成——原文仅此一次展示");
			linkKeyId = "";
		}
	}

	async function confirmedRevokeKey(): Promise<void> {
		const row = confirmKey;
		confirmKey = null;
		if (row === null) return;
		if (await ctl.revokeKey(row.keyId)) toast.success("密钥已撤销（新请求 403；在途响应仍可续拉）");
	}

	// ---- 密钥库 ---------------------------------------------------------------------

	let secretName = $state("");
	let secretValue = $state("");
	let confirmSecret = $state<string | null>(null);

	async function submitSecret(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (secretName.trim() === "" || secretValue === "") {
			toast.error("请填写密钥名与值。");
			return;
		}
		if (await ctl.setSecret(secretName.trim(), secretValue)) {
			toast.success("密钥已存入本机密钥库（0600）");
			secretName = "";
			secretValue = "";
		}
	}

	// ---- 导入器（两阶段） -------------------------------------------------------------

	let importText = $state("");
	let importStaging = $state<{ blocked: Array<{ service: string; field: string; ref: string; varName?: string; reason?: string }>; ready: Array<{ name: string }> } | null>(null);
	let importMappings = $state<Record<string, string>>({});
	let importGroup = $state("");
	let stagingBusy = $state(false);

	async function submitStage(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		stagingBusy = true;
		importStaging = await ctl.stageImport(importText);
		stagingBusy = false;
		if (importStaging !== null) {
			importMappings = Object.fromEntries(importStaging.blocked.filter((b) => b.varName !== undefined).map((b) => [b.varName as string, ""]));
			toast.success(`扫描完成：${importStaging.ready.length} 项可直接导入，${importStaging.blocked.length} 项需映射`);
		}
	}

	async function submitCommit(): Promise<void> {
		if (importStaging === null) return;
		if (await ctl.commitImport({ rawText: importText, mappings: importMappings, ...(importGroup.trim() !== "" ? { groupName: importGroup.trim() } : {}) })) {
			toast.success("导入已提交（原子生效）");
			importText = "";
			importStaging = null;
			importMappings = {};
			importGroup = "";
		}
	}

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
	}
</script>

<section class="flex flex-col gap-5" data-view="plugin-page" data-plugin="ai" data-plugin-page="provider">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">{title}</h2>
		<p class="text-sm text-muted-foreground">
			把本机的 AI 订阅（OpenAI 兼容等上游）共享给家庭其它设备：配置服务与分组，签发密钥或生成
			<span class="font-mono text-xs">aifly1.</span> 分享链接，对端经 fabric 直连消费。
		</p>
	</div>

	{#if ctl.providerError !== null}
		<Alert.Root variant="destructive" data-error-banner>
			<CircleAlert />
			<Alert.Title>操作失败</Alert.Title>
			<Alert.Description>{ctl.providerError}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if overview === null}
		<div class="flex flex-col gap-3">
			<Skeleton class="h-16 w-full" />
			<Skeleton class="h-16 w-full" />
		</div>
	{:else}
		<Tabs.Root defaultValue="services">
			<Tabs.List class="mb-4 flex-wrap">
				<Tabs.Trigger value="services">服务</Tabs.Trigger>
				<Tabs.Trigger value="groups">分组</Tabs.Trigger>
				<Tabs.Trigger value="keys">密钥与链接</Tabs.Trigger>
				<Tabs.Trigger value="usage">用量与配额</Tabs.Trigger>
				<Tabs.Trigger value="import">导入</Tabs.Trigger>
			</Tabs.List>

			<!-- ── 服务 ─────────────────────────────────────────────────────────── -->
			<Tabs.Content value="services" class="flex flex-col gap-5">
				<Card.Root>
					<Card.Header>
						<Card.Title>服务列表</Card.Title>
						<Card.Description>
							{overview.services.length} 个服务（≤256）。带 <span class="font-mono text-xs">keyEnv</span> 的预设服务须先绑定本机密钥库中的 secret 才能启用（环境变量取值被拒绝——凭证只走密钥库）。每行「探活」经同一 hook 管线/auth 槽向上游发最小请求（超时 5s，三态脱敏呈现）。
						</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-3">
						{#if overview.services.length === 0}
							<Empty.Root class="border border-dashed">
								<Empty.Header>
									<Empty.Media variant="icon"><Sparkles /></Empty.Media>
									<Empty.Title>还没有服务</Empty.Title>
									<Empty.Description>从 17 个预设里选一个（如 openai），或导入 ai-fly 配置（「导入」页）。</Empty.Description>
								</Empty.Header>
							</Empty.Root>
						{:else}
							{#each overview.services as row (row.serviceId)}
								<div class="flex flex-col gap-2 rounded-lg border p-3.5" data-service={row.serviceId}>
									<div class="flex flex-wrap items-center gap-2.5">
										<span class="text-sm font-medium">{row.name}</span>
										<Badge variant="outline" class={row.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-muted-foreground/30 bg-muted text-muted-foreground"}>
											{row.enabled ? "已启用" : "已停用"}
										</Badge>
										{#if row.keyEnv !== undefined}
											<Badge variant="outline" class={row.authBound ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"}>
												{row.authBound ? "已绑定 secret" : `keyEnv ${row.keyEnv} 未绑定`}
											</Badge>
										{/if}
									<span class="ml-auto flex items-center gap-2">
										{#if ctl.probeResults[row.serviceId] !== undefined}
											<span
												class="rounded-md border px-2 py-0.5 text-xs {ctl.probeResults[row.serviceId].state === 'reachable'
													? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
													: ctl.probeResults[row.serviceId].state === 'no_auth'
																						? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
																						: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'}"
												data-probe-result={row.serviceId}
											>
												{probeText(ctl.probeResults[row.serviceId])}
											</span>
										{/if}
										<Button size="sm" variant="outline" disabled={ctl.providerBusy || ctl.probingId !== null} onclick={() => void ctl.probeService(row.serviceId)} data-action="ai-probe">
											{#if ctl.probingId === row.serviceId}探活中…{:else}探活{/if}
										</Button>
										<Button size="sm" variant="outline" disabled={ctl.providerBusy} onclick={() => void toggleService(row.serviceId, !row.enabled)}>
											{row.enabled ? "停用" : "启用"}
										</Button>
											<Button size="sm" variant="outline" class="text-destructive" disabled={ctl.providerBusy} onclick={() => (confirmService = { serviceId: row.serviceId, name: row.name })}>
												<Trash class="size-3.5" /> 删除
											</Button>
										</span>
									</div>
									<p class="font-mono text-xs text-muted-foreground">
										{row.upstream} · 默认端口 {row.defaultPort}{row.groups.length > 0 ? ` · 分组 ${row.groups.join("、")}` : ""}
									</p>
									{#if row.keyEnv !== undefined && !row.authBound}
										<div class="flex flex-wrap items-center gap-2 rounded-md bg-amber-500/5 p-2" data-bind-secret={row.serviceId}>
											<span class="text-xs text-muted-foreground">绑定密钥库 secret 后才能启用：</span>
											{#each overview.secrets as s (s.name)}
												<Button size="sm" variant="outline" disabled={ctl.providerBusy} onclick={() => void ctl.bindServiceSecret(row.serviceId, s.name)}>bind {s.name}</Button>
											{/each}
											{#if overview.secrets.length === 0}
												<span class="text-xs text-muted-foreground">密钥库为空——先在「密钥与链接」页添加。</span>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						{/if}
					</Card.Content>
				</Card.Root>

				<Separator />

				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2"><Plus class="size-4 text-muted-foreground" /> 添加服务</Card.Title>
						<Card.Description>从 17 个预设选择（自动带入上游/路由/端口），或自定义。预设的 keyEnv 需绑定密钥库 secret（可先建后绑）。</Card.Description>
					</Card.Header>
					<Card.Content>
						<form class="flex flex-col gap-4" onsubmit={(e) => void submitCreateService(e)} data-form="add-ai-service">
							<div class="grid gap-4 sm:grid-cols-2">
								<div class="flex flex-col gap-1.5">
									<Label for="ai-service-preset">预设</Label>
									<select
										id="ai-service-preset"
										class="dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
										bind:value={formPreset}
										disabled={creating}
									>
										<option value="">自定义…</option>
										{#each presetOptions as p (p.id)}
											<option value={p.id}>{p.label}（{p.id}）</option>
										{/each}
									</select>
								</div>
								<div class="flex flex-col gap-1.5">
									<Label for="ai-service-name">名称（自定义必填）</Label>
									<Input id="ai-service-name" placeholder="my-openai" bind:value={formName} disabled={creating} class="font-mono" />
								</div>
								{#if formPreset === ""}
									<div class="flex flex-col gap-1.5">
										<Label for="ai-service-upstream">上游 base URL（自定义必填）</Label>
										<Input id="ai-service-upstream" placeholder="https://api.example.com" bind:value={formUpstream} disabled={creating} class="font-mono" />
									</div>
									<div class="flex flex-col gap-1.5">
										<Label for="ai-service-domain">匹配域名（自定义必填）</Label>
										<Input id="ai-service-domain" placeholder="api.example.com" bind:value={formDomain} disabled={creating} class="font-mono" />
									</div>
								{/if}
								<div class="flex flex-col gap-1.5">
									<Label for="ai-service-port">消费方默认端口（可选）</Label>
									<Input id="ai-service-port" type="number" min="1" max="65535" placeholder={formPreset === "" || presetById.get(formPreset)?.defaultPort === undefined ? "4300" : String(presetById.get(formPreset)?.defaultPort)} bind:value={formPort} disabled={creating} class="font-mono" />
								</div>
								<div class="flex flex-col gap-1.5">
									<Label for="ai-service-secret">绑定 secret（可选）</Label>
									<Input id="ai-service-secret" placeholder="openai-main" bind:value={formSecret} disabled={creating} class="font-mono" />
								</div>
							</div>
							{#if formPreset !== "" && presetById.get(formPreset)?.notes}
								<p class="text-xs text-muted-foreground">{presetById.get(formPreset)?.notes}</p>
							{/if}
							{#if formError !== null}
								<p class="text-xs text-destructive" data-form-error>{formError}</p>
							{/if}
							<div>
								<Button size="sm" type="submit" disabled={creating || ctl.providerBusy}>
									{#if creating}添加中…{:else}添加服务{/if}
								</Button>
							</div>
						</form>
					</Card.Content>
				</Card.Root>
			</Tabs.Content>

			<!-- ── 分组 ─────────────────────────────────────────────────────────── -->
			<Tabs.Content value="groups" class="flex flex-col gap-5">
				<Card.Root>
					<Card.Header>
						<Card.Title>分组</Card.Title>
						<Card.Description>分组=授权与限额单位：密钥按分组签发；限额（并发/日请求）按分组执行——不设则吃插件级配额（「用量与配额」页）。</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-3">
						{#if overview.groups.length === 0}
							<p class="text-sm text-muted-foreground">还没有分组——签发密钥前需要至少一个分组。</p>
						{:else}
							{#each overview.groups as g (g.name)}
								{@const serviceNames = new Set(g.serviceNames)}
								<div class="flex flex-col gap-2 rounded-lg border p-3.5" data-group={g.name}>
									<div class="flex flex-wrap items-center gap-2.5">
										<span class="text-sm font-medium">{g.name}</span>
										<Badge variant="outline" class="border-muted-foreground/30 text-muted-foreground">{g.serviceNames.length} 服务</Badge>
										{#if g.limits !== undefined}
											<Badge variant="outline" class="border-muted-foreground/30 text-muted-foreground">
												{g.limits.maxConcurrency !== undefined ? `并发 ${g.limits.maxConcurrency}` : ""}{g.limits.maxConcurrency !== undefined && g.limits.dailyRequests !== undefined ? " · " : ""}{g.limits.dailyRequests !== undefined ? `日限 ${g.limits.dailyRequests}` : ""}
											</Badge>
										{/if}
										<span class="ml-auto flex items-center gap-2">
											<Button size="sm" variant="outline" disabled={ctl.providerBusy} onclick={() => (limitsEdit = { name: g.name, maxConcurrency: g.limits?.maxConcurrency === undefined ? "" : String(g.limits.maxConcurrency), dailyRequests: g.limits?.dailyRequests === undefined ? "" : String(g.limits.dailyRequests) })}>限额</Button>
											<Button size="sm" variant="outline" class="text-destructive" disabled={ctl.providerBusy} onclick={() => (confirmGroup = g.name)}>删除</Button>
										</span>
									</div>
									{#if overview.services.length > 0}
										<div class="flex flex-wrap gap-x-4 gap-y-1.5">
											{#each overview.services as s (s.serviceId)}
												<label class="flex items-center gap-1.5 text-xs text-muted-foreground">
													<input type="checkbox" class="size-3.5" checked={serviceNames.has(s.name)} disabled={ctl.providerBusy} onchange={() => toggleGroupService(g.name, s.name, serviceNames.has(s.name))} />
													{s.name}
												</label>
											{/each}
										</div>
									{/if}
									{#if limitsEdit?.name === g.name}
										<div class="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-2.5" data-limits-edit={g.name}>
											<div class="flex flex-col gap-1">
												<Label for={`ai-limits-conc-${g.name}`}>组并发上限</Label>
												<Input id={`ai-limits-conc-${g.name}`} type="number" min="1" max="32" placeholder="不限" bind:value={limitsEdit.maxConcurrency} class="w-28 font-mono" />
											</div>
											<div class="flex flex-col gap-1">
												<Label for={`ai-limits-daily-${g.name}`}>日请求上限</Label>
												<Input id={`ai-limits-daily-${g.name}`} type="number" min="0" max="1000000" placeholder="不限" bind:value={limitsEdit.dailyRequests} class="w-32 font-mono" />
											</div>
											<span class="flex items-center gap-2">
												<Button size="sm" disabled={ctl.providerBusy} onclick={() => void saveLimits()}>保存限额</Button>
												<Button size="sm" variant="ghost" onclick={() => (limitsEdit = null)}>取消</Button>
											</span>
											<p class="w-full text-xs text-muted-foreground">两项都留空=不限（吃插件级配额）。</p>
										</div>
									{/if}
								</div>
							{/each}
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2"><Plus class="size-4 text-muted-foreground" /> 新建分组</Card.Title>
					</Card.Header>
					<Card.Content>
						<form class="flex flex-wrap items-end gap-3" onsubmit={(e) => void submitCreateGroup(e)} data-form="add-ai-group">
							<div class="flex flex-col gap-1.5">
								<Label for="ai-group-name">名称</Label>
								<Input id="ai-group-name" placeholder="family" bind:value={groupName} class="font-mono" />
							</div>
							<div>
								<Button size="sm" type="submit" disabled={ctl.providerBusy}>创建分组</Button>
							</div>
							{#if groupError !== null}
								<p class="text-xs text-destructive">{groupError}</p>
							{/if}
						</form>
					</Card.Content>
				</Card.Root>
			</Tabs.Content>

			<!-- ── 密钥与链接 ────────────────────────────────────────────────────── -->
			<Tabs.Content value="keys" class="flex flex-col gap-5">
				{#if ctl.issuedKey !== null}
					<Card.Root data-issued-key>
						<Card.Header>
							<Card.Title class="flex items-center gap-2"><KeyRound class="size-4" /> 新签发密钥（仅此一次展示）</Card.Title>
							<Card.Description>关闭后无法再次取回原文（列表只剩 keyId 与状态）；复制后请交给分组成员。</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-2">
							<div class="flex items-center gap-2 rounded-md border bg-muted/40 p-2.5">
								<code class="min-w-0 flex-1 truncate font-mono text-xs">{ctl.issuedKey.key}</code>
								<Button size="sm" variant="outline" onclick={() => void copy(ctl.issuedKey?.key ?? "", "密钥")}>
									<Copy class="size-3.5" /> 复制
								</Button>
							</div>
							<p class="font-mono text-xs text-muted-foreground">keyId {ctl.issuedKey.keyId} · 分组 {ctl.issuedKey.group}</p>
							<div>
								<Button size="sm" variant="ghost" onclick={() => ctl.closeIssuedKey()}>我已保存，关闭</Button>
							</div>
						</Card.Content>
					</Card.Root>
				{/if}

				{#if ctl.issuedLink !== null}
					<Card.Root data-issued-link>
						<Card.Header>
							<Card.Title class="flex items-center gap-2"><Link2 class="size-4" /> 分享链接（内嵌密钥原文，仅此一次展示）</Card.Title>
							<Card.Description>像密码一样对待；对端在「AI 订阅·消费方」页粘贴导入。</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-2">
							<div class="flex items-center gap-2 rounded-md border bg-muted/40 p-2.5">
								<code class="min-w-0 flex-1 truncate font-mono text-xs">{ctl.issuedLink.link}</code>
								<Button size="sm" variant="outline" onclick={() => void copy(ctl.issuedLink?.link ?? "", "链接")}>
									<Copy class="size-3.5" /> 复制
								</Button>
							</div>
							<p class="font-mono text-xs text-muted-foreground">keyId {ctl.issuedLink.keyId} · 分组 {ctl.issuedLink.group} · {ctl.issuedLink.services} 服务 → {ctl.issuedLink.recipient.slice(0, 8)}…</p>
							<div>
								<Button size="sm" variant="ghost" onclick={() => ctl.closeIssuedLink()}>我已发送，关闭</Button>
							</div>
						</Card.Content>
					</Card.Root>
				{/if}

				<Card.Root>
					<Card.Header>
						<Card.Title>已签发密钥</Card.Title>
						<Card.Description>撤销后该密钥的新请求得 403（key_revoked）；已在途的响应仍可续拉至终态（5s 有界 drain 语义在会话全钥失效时适用）。</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-3">
						{#if overview.keys.length === 0}
							<p class="text-sm text-muted-foreground">还没有密钥。</p>
						{:else}
							{#each overview.keys as k (k.keyId)}
								<div class="flex flex-wrap items-center gap-2.5 rounded-lg border p-3" data-key={k.keyId}>
									<span class="font-mono text-xs">{k.keyId}</span>
									<Badge variant="outline" class={k.status === "active" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-muted-foreground/30 bg-muted text-muted-foreground line-through"}>
										{k.status === "active" ? "有效" : "已撤销"}
									</Badge>
									<span class="text-xs text-muted-foreground">分组 {k.group} · {k.name}</span>
									{#if k.status === "active"}
										<span class="ml-auto">
											<Button size="sm" variant="outline" class="text-destructive" disabled={ctl.providerBusy} onclick={() => (confirmKey = { keyId: k.keyId, group: k.group })}>撤销</Button>
										</span>
									{/if}
								</div>
							{/each}
						{/if}
					</Card.Content>
				</Card.Root>

				<div class="grid gap-4 lg:grid-cols-2">
					<Card.Root>
						<Card.Header>
							<Card.Title>签发密钥</Card.Title>
						</Card.Header>
						<Card.Content>
							<form class="flex flex-col gap-3" onsubmit={(e) => void submitIssueKey(e)} data-form="issue-ai-key">
								<div class="grid gap-3 sm:grid-cols-2">
									<div class="flex flex-col gap-1.5">
										<Label for="ai-key-group">分组</Label>
										<select id="ai-key-group" class="dark:bg-input/30 border-input h-9 w-full rounded-md border bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none" bind:value={keyGroup}>
											<option value="">选择分组…</option>
											{#each overview.groups as g (g.name)}
												<option value={g.name}>{g.name}</option>
											{/each}
										</select>
									</div>
									<div class="flex flex-col gap-1.5">
										<Label for="ai-key-name">名称（可选）</Label>
										<Input id="ai-key-name" placeholder="laptop" bind:value={keyName} class="font-mono" />
									</div>
								</div>
								<div>
									<Button size="sm" type="submit" disabled={ctl.providerBusy}>签发（原文一次性展示）</Button>
								</div>
							</form>
						</Card.Content>
					</Card.Root>

					<Card.Root>
						<Card.Header>
							<Card.Title>生成 aifly1. 分享链接</Card.Title>
							<Card.Description>链接=邀请+密钥+目录快照（复用已存密钥可指定 keyId）。</Card.Description>
						</Card.Header>
						<Card.Content>
							<form class="flex flex-col gap-3" onsubmit={(e) => void submitMakeLink(e)} data-form="make-ai-link">
								<div class="grid gap-3 sm:grid-cols-2">
									<div class="flex flex-col gap-1.5">
										<Label for="ai-link-group">分组</Label>
										<select id="ai-link-group" class="dark:bg-input/30 border-input h-9 w-full rounded-md border bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none" bind:value={linkGroup}>
											<option value="">选择分组…</option>
											{#each overview.groups as g (g.name)}
												<option value={g.name}>{g.name}</option>
											{/each}
										</select>
									</div>
									<div class="flex flex-col gap-1.5">
										<Label for="ai-link-recipient">受邀方设备 ID</Label>
										<Input id="ai-link-recipient" placeholder="对端消费方页的设备 ID" bind:value={linkRecipient} class="font-mono" />
									</div>
									<div class="flex flex-col gap-1.5">
										<Label for="ai-link-key">复用密钥 keyId（可选）</Label>
										<Input id="ai-link-key" placeholder="留空=新签发" bind:value={linkKeyId} class="font-mono" />
									</div>
								</div>
								<div>
									<Button size="sm" type="submit" disabled={ctl.providerBusy}>生成链接（一次性展示）</Button>
								</div>
							</form>
						</Card.Content>
					</Card.Root>
				</div>

				<Separator />

				<Card.Root>
					<Card.Header>
						<Card.Title>本机密钥库（secrets）</Card.Title>
						<Card.Description>上游凭证的唯一入口（<span class="font-mono text-xs">plugins/ai/secrets.json</span>，0600）。值只进不出——列表只有名称。</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-3">
						{#if overview.secrets.length === 0}
							<p class="text-sm text-muted-foreground">密钥库为空。</p>
						{:else}
							<div class="flex flex-wrap gap-2">
								{#each overview.secrets as s (s.name)}
									<span class="flex items-center gap-2 rounded-md border px-2.5 py-1 font-mono text-xs" data-secret={s.name}>
										{s.name}
										<button class="text-destructive hover:underline" disabled={ctl.providerBusy} onclick={() => (confirmSecret = s.name)}>删除</button>
									</span>
								{/each}
							</div>
						{/if}
						<form class="flex flex-wrap items-end gap-3" onsubmit={(e) => void submitSecret(e)} data-form="add-ai-secret">
							<div class="flex flex-col gap-1.5">
								<Label for="ai-secret-name">名称</Label>
								<Input id="ai-secret-name" placeholder="openai-main" bind:value={secretName} class="w-44 font-mono" />
							</div>
							<div class="flex flex-col gap-1.5">
								<Label for="ai-secret-value">值</Label>
								<Input id="ai-secret-value" type="password" placeholder="Bearer sk-…" bind:value={secretValue} class="w-64 font-mono" />
							</div>
							<div>
								<Button size="sm" type="submit" disabled={ctl.providerBusy}>存入</Button>
							</div>
						</form>
					</Card.Content>
				</Card.Root>
			</Tabs.Content>

			<!-- ── 用量与配额 ────────────────────────────────────────────────────── -->
			<Tabs.Content value="usage" class="flex flex-col gap-5">
				<Card.Root>
					<Card.Header>
						<Card.Title>插件配额配置</Card.Title>
						<Card.Description>maxConcurrency（在途上游并发，1–32）· dailyRequests（分组未设限额时的日请求缺省，0–1,000,000）· usageLog（用量日志开关——只记元数据）。保存后即时生效。</Card.Description>
					</Card.Header>
					<Card.Content>
						{#if pluginEntry !== null}
							<PluginConfigForm plugin={pluginEntry} />
						{:else}
							<p class="text-sm text-muted-foreground">插件注册表未加载——刷新插件面板后重试。</p>
						{/if}
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>用量（元数据聚合）</Card.Title>
						<Card.Description>
							{#if ctl.usage?.enabled !== true}
								用量日志未开启（usageLog=false）——开启后这里呈现按密钥/服务的请求与字节聚合。当日配额计数（quota-day）独立于日志开关。
							{:else}
								共 {ctl.usage?.totals.requests ?? 0} 次请求 · {formatBytes(ctl.usage?.totals.bytes ?? 0)}
							{/if}
						</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						{#if ctl.usage?.quotaDay !== null && ctl.usage?.quotaDay !== undefined}
							<div>
								<p class="mb-1.5 text-xs font-medium text-muted-foreground">当日请求计数（quota-day {ctl.usage.quotaDay.date}）</p>
								<div class="flex flex-wrap gap-2">
									{#each Object.entries(ctl.usage.quotaDay.counts) as [keyId, n] (keyId)}
										<Badge variant="outline" class="border-muted-foreground/30 font-mono text-muted-foreground">{keyId.slice(0, 8)}… × {n}</Badge>
									{/each}
								</div>
							</div>
						{/if}
						{#if (ctl.usage?.byKey.length ?? 0) > 0}
							<div>
								<p class="mb-1.5 text-xs font-medium text-muted-foreground">按密钥</p>
								{#each ctl.usage?.byKey ?? [] as row (row.keyId)}
									<p class="font-mono text-xs text-muted-foreground">{row.keyId} · {row.requests} 次 · {formatBytes(row.bytes)}</p>
								{/each}
							</div>
							<div>
								<p class="mb-1.5 text-xs font-medium text-muted-foreground">按服务</p>
								{#each ctl.usage?.byService ?? [] as row (row.serviceId)}
									<p class="font-mono text-xs text-muted-foreground">{row.serviceId} · {row.requests} 次 · {formatBytes(row.bytes)}</p>
								{/each}
							</div>
						{/if}
						{#if overview.plane !== null}
							<p class="text-xs text-muted-foreground">提供方平面运行中（epoch {overview.plane.epoch.slice(0, 8)}… · 在途 {overview.plane.inflight}）</p>
						{:else}
							<p class="text-xs text-muted-foreground">提供方平面未运行——在插件面板启用 ai 后对外服务。</p>
						{/if}
					</Card.Content>
				</Card.Root>
			</Tabs.Content>

			<!-- ── 导入 ─────────────────────────────────────────────────────────── -->
			<Tabs.Content value="import" class="flex flex-col gap-5">
				<Card.Root>
					<Card.Header>
						<Card.Title>导入 ai-fly 配置（两阶段）</Card.Title>
						<Card.Description>粘贴 ai-fly 的 services.json 原文 → 扫描：安全条目列出待导入；<span class="font-mono text-xs">$env:</span> 引用条目被拦下，完成「变量 → 本机密钥库名」映射后一次性原子提交（不会从环境变量快照任何值）。</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						<form class="flex flex-col gap-3" onsubmit={(e) => void submitStage(e)} data-form="ai-import-stage">
						<textarea
							class="dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 min-h-32 w-full rounded-md border bg-transparent p-2.5 font-mono text-xs shadow-xs outline-none focus-visible:ring-3"
							placeholder="粘贴 ai-fly 的 services.json 原文（&lbrace;&quot;services&quot;: [&rbrack; …&rbrace;）"
							bind:value={importText}
							disabled={stagingBusy}
						></textarea>
							<div>
								<Button size="sm" type="submit" disabled={stagingBusy || importText.trim() === ""}>
									{#if stagingBusy}扫描中…{:else}阶段一：扫描{/if}
								</Button>
							</div>
						</form>

						{#if importStaging !== null}
							<Separator />
							<div class="flex flex-col gap-3" data-import-staging>
								{#if importStaging.ready.length > 0}
									<p class="text-sm text-muted-foreground">可直接导入：{importStaging.ready.map((r) => r.name).join("、")}</p>
								{/if}
								{#if importStaging.blocked.length > 0}
									<div class="flex flex-col gap-2">
										<p class="text-xs font-medium text-amber-600 dark:text-amber-400">以下引用需映射到本机密钥库（或移除）：</p>
										{#each importStaging.blocked as b (b.service + b.field)}
											<div class="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
												<span class="font-mono">{b.service}</span>
												<span class="text-muted-foreground">{b.field} = {b.ref}</span>
												{#if b.reason !== undefined}
													<span class="text-muted-foreground">（{b.reason}——不可导入）</span>
												{:else if b.varName !== undefined}
													<span class="ml-auto flex items-center gap-1.5">
														<span class="text-muted-foreground">→ secret</span>
														<input class="dark:bg-input/30 border-input h-8 w-40 rounded-md border bg-transparent px-2 font-mono text-xs" placeholder="openai-main" bind:value={importMappings[b.varName]} />
													</span>
												{/if}
											</div>
										{/each}
									</div>
								{/if}
								<div class="flex flex-wrap items-end gap-3">
									<div class="flex flex-col gap-1.5">
										<Label for="ai-import-group">导入到分组（可选）</Label>
										<Input id="ai-import-group" placeholder="imported" bind:value={importGroup} class="w-44 font-mono" />
									</div>
									<Button size="sm" disabled={ctl.providerBusy} onclick={() => void submitCommit()}>阶段二：提交导入</Button>
								</div>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			</Tabs.Content>
		</Tabs.Root>
	{/if}

	<ConfirmDialog
		open={confirmService !== null}
		title="删除这个服务？"
		onconfirm={() => void confirmedRemoveService()}
		oncancel={() => (confirmService = null)}
	>
		{#if confirmService !== null}
			<p>将删除服务「{confirmService.name}」并移出所有分组；此操作不可撤销。</p>
		{/if}
	</ConfirmDialog>

	<ConfirmDialog
		open={confirmGroup !== null}
		title="删除这个分组？"
		onconfirm={() => {
			if (confirmGroup !== null) void ctl.removeGroup(confirmGroup);
			confirmGroup = null;
		}}
		oncancel={() => (confirmGroup = null)}
	>
		<p>仍有未撤销密钥的分组会被拒绝（先撤钥）。确认删除？</p>
	</ConfirmDialog>

	<ConfirmDialog
		open={confirmKey !== null}
		title="撤销这把密钥？"
		onconfirm={() => void confirmedRevokeKey()}
		oncancel={() => (confirmKey = null)}
	>
		{#if confirmKey !== null}
			<p>撤销后该密钥（{confirmKey.keyId}）的新请求将被拒绝；已在途的响应可继续拉取至终态。</p>
		{/if}
	</ConfirmDialog>

	<ConfirmDialog
		open={confirmSecret !== null}
		title="删除这个密钥库条目？"
		onconfirm={() => {
			if (confirmSecret !== null) void ctl.removeSecret(confirmSecret);
			confirmSecret = null;
		}}
		oncancel={() => (confirmSecret = null)}
	>
		<p>绑定该 secret 的已启用服务在下次凭证解析时会失败（secret_missing）。</p>
	</ConfirmDialog>
</section>
