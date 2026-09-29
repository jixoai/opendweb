<script lang="ts">
	// ports 插件·映射管理页（webui-plugin-kernel Phase 1 / design §5、tasks §2）。
	// 纯展示组件：数据与动作全部经 props 注入（编排者接线面——组件内不 fetch、
	// 不触碰 console store；接线清单见包报告）。错误呈现两层：顶层 error props
	// （端口冲突/超范围配置等服务端明确错误）+ 每行 error（listener 启动失败等）。
	// 页面可达性由路由协议保证（#/p/ports/mappings 命中且插件 enabled）。
	import * as Alert from "$lib/components/ui/alert";
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Separator } from "$lib/components/ui/separator";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import { CircleAlert, Network, Plus, Trash2 } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import type { PluginRouteEntry } from "$lib/plugin-registry";
	import ConfirmDialog from "../../ConfirmDialog.svelte";

	/** 映射行（runtime.listMappings() 的投影形状——listener/error 为运行态） */
	export interface PortsMappingRow {
		id: string;
		name: string;
		/** 对端 endpointId */
		peer: string;
		remotePort: number;
		localPort: number;
		enabled: boolean;
		listener?: "listening" | "stopped" | "failed" | "stopping" | null;
		error?: string | null;
	}

	/** 对端选项（节点簿数据经 props 注入——endpointId + 展示名） */
	export interface PortsPeerOption {
		endpointId: string;
		label: string;
	}

	let {
		entry,
		mappings,
		peers,
		error,
		onCreate,
		onToggle,
		onDelete,
	}: {
		/** App 壳统一分派 props（与其他插件页同拍） */
		entry?: PluginRouteEntry;
		/** null=载入中；[]=空列表 */
		mappings: PortsMappingRow[] | null;
		/** 节点簿对端数据（props 注入；空数组=无可选对端） */
		peers: PortsPeerOption[];
		/** 顶层错误（父层置位：端口冲突/超范围配置等明确错误文案） */
		error: string | null;
		/** 新增映射；返回 false=失败（父层经 error props 呈现原因） */
		onCreate: (input: { name: string; peer: string; remotePort: number; localPort: number }) => Promise<boolean> | boolean;
		/** 启停映射；返回 false=失败 */
		onToggle: (id: string, nextEnabled: boolean) => Promise<boolean> | boolean;
		/** 删除映射；返回 false=失败 */
		onDelete: (id: string) => Promise<boolean> | boolean;
	} = $props();

	const title = $derived(entry?.title ?? "端口映射");

	// ---- 新增表单 -----------------------------------------------------------------

	let formName = $state("");
	let formPeer = $state("");
	let formRemotePort = $state("");
	let formLocalPort = $state("");
	let formError = $state<string | null>(null);
	let creating = $state(false);

	function peerLabel(peerId: string): string {
		return peers.find((p) => p.endpointId === peerId)?.label ?? peerId;
	}

	async function submitCreate(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		formError = null;
		const name = formName.trim();
		const remotePort = Number(formRemotePort);
		const localPort = Number(formLocalPort);
		if (name === "") {
			formError = "请填写映射名称。";
			return;
		}
		if (formPeer === "") {
			formError = "请选择对端设备。";
			return;
		}
		if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
			formError = "对端端口必须是 1-65535 的整数。";
			return;
		}
		if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
			formError = "本机端口必须是 1-65535 的整数。";
			return;
		}
		creating = true;
		const ok = await onCreate({ name, peer: formPeer, remotePort, localPort });
		creating = false;
		if (ok) {
			toast.success("映射已添加");
			formName = "";
			formPeer = "";
			formRemotePort = "";
			formLocalPort = "";
		}
		// 失败文案经 error props 由父层呈现（服务端口冲突/超范围配置等）
	}

	// ---- 行动作 -------------------------------------------------------------------

	let togglingId = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let confirmRow = $state<PortsMappingRow | null>(null);

	async function toggle(row: PortsMappingRow): Promise<void> {
		togglingId = row.id;
		await onToggle(row.id, !row.enabled);
		togglingId = null;
	}

	async function confirmedDelete(): Promise<void> {
		const row = confirmRow;
		confirmRow = null;
		if (row === null) return;
		deletingId = row.id;
		const ok = await onDelete(row.id);
		deletingId = null;
		if (ok) toast.success("映射已删除");
	}

	function listenerBadge(row: PortsMappingRow): { text: string; cls: string } {
		if (row.listener === "listening") return { text: "监听中", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
		if (row.listener === "failed") return { text: "启动失败", cls: "border-destructive/40 bg-destructive/10 text-destructive" };
		return { text: "未监听", cls: "border-muted-foreground/30 bg-muted text-muted-foreground" };
	}
</script>

<section class="flex flex-col gap-5" data-view="plugin-page" data-plugin="ports" data-plugin-page="mappings">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">{title}</h2>
		<p class="text-sm text-muted-foreground">
			把另一台设备的本地端口映射到本机——<span class="font-mono text-xs">localhost:本机端口</span> 等同直接访问对端服务。仅 HTTP 语义（WebSocket / 原始 TCP 透传即将推出）。
		</p>
	</div>

	{#if error !== null}
		<Alert.Root variant="destructive" data-error-banner>
			<CircleAlert />
			<Alert.Title>操作失败</Alert.Title>
			<Alert.Description>{error}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if mappings === null}
		<div class="flex flex-col gap-3">
			<Skeleton class="h-16 w-full" />
			<Skeleton class="h-16 w-full" />
		</div>
	{:else}
		<!-- 映射列表 -->
		<Card.Root>
			<Card.Header>
				<Card.Title>已有映射</Card.Title>
				<Card.Description>启用的映射在本机回环地址（127.0.0.1）监听；删除操作不可撤销。</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				{#if mappings.length === 0}
					<Empty.Root class="border border-dashed">
						<Empty.Header>
							<Empty.Media variant="icon"><Network /></Empty.Media>
							<Empty.Title>还没有端口映射</Empty.Title>
							<Empty.Description>用下面的表单添加第一条——例如把 iMac 的 8080 映射为本机的 9090。</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{:else}
					<div class="flex flex-col gap-3">
						{#each mappings as row (row.id)}
							{@const badge = listenerBadge(row)}
							<div class="flex flex-col gap-2 rounded-lg border p-3.5" data-mapping={row.id}>
								<div class="flex flex-wrap items-center gap-2.5">
									<span class="text-sm font-medium">{row.name}</span>
									<Badge variant="outline" class="border-muted-foreground/30 text-muted-foreground">{row.enabled ? "已启用" : "已停用"}</Badge>
									<Badge variant="outline" class={badge.cls}>{badge.text}</Badge>
									<span class="ml-auto flex items-center gap-2">
										<Button size="sm" variant="outline" disabled={togglingId !== null || deletingId !== null} onclick={() => void toggle(row)}>
											{#if togglingId === row.id}{row.enabled ? "停用中…" : "启用中…"}{:else}{row.enabled ? "停用" : "启用"}{/if}
										</Button>
										<Button size="sm" variant="outline" class="text-destructive" disabled={togglingId !== null || deletingId !== null} onclick={() => (confirmRow = row)}>
											{#if deletingId === row.id}删除中…{:else}<Trash2 class="size-3.5" /> 删除{/if}
										</Button>
									</span>
								</div>
								<p class="font-mono text-xs text-muted-foreground">
									localhost:{row.localPort} → {peerLabel(row.peer)}:{row.remotePort}
								</p>
								{#if row.error}
									<p class="text-xs text-destructive" data-mapping-error>{row.error}</p>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Separator />

		<!-- 新增映射 -->
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><Plus class="size-4 text-muted-foreground" /> 添加映射</Card.Title>
				<Card.Description>选择对端设备（节点簿）与两端端口；本机端口被占用时会明确报错，不会自动改用其他端口。</Card.Description>
			</Card.Header>
			<Card.Content>
				<form class="flex flex-col gap-4" onsubmit={(e) => void submitCreate(e)} data-form="add-mapping">
					<div class="grid gap-4 sm:grid-cols-2">
						<div class="flex flex-col gap-1.5">
							<Label for="ports-mapping-name">名称</Label>
							<Input id="ports-mapping-name" placeholder="iMac 上的服务" bind:value={formName} disabled={creating} />
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="ports-mapping-peer">对端设备</Label>
							<select
								id="ports-mapping-peer"
								class="dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
								bind:value={formPeer}
								disabled={creating}
							>
								<option value="">选择对端设备…</option>
								{#each peers as peer (peer.endpointId)}
									<option value={peer.endpointId}>{peer.label}</option>
								{/each}
							</select>
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="ports-mapping-remote-port">对端端口（remote）</Label>
							<Input id="ports-mapping-remote-port" type="number" min="1" max="65535" placeholder="8080" bind:value={formRemotePort} disabled={creating} class="font-mono" />
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="ports-mapping-local-port">本机端口（local）</Label>
							<Input id="ports-mapping-local-port" type="number" min="1" max="65535" placeholder="9090" bind:value={formLocalPort} disabled={creating} class="font-mono" />
						</div>
					</div>
					{#if formError !== null}
						<p class="text-xs text-destructive" data-form-error>{formError}</p>
					{/if}
					{#if peers.length === 0}
						<p class="text-xs text-muted-foreground">当前没有可用的对端设备——先在节点簿里添加设备。</p>
					{/if}
					<div>
						<Button size="sm" type="submit" disabled={creating || peers.length === 0}>
							{#if creating}添加中…{:else}添加映射{/if}
						</Button>
					</div>
				</form>
			</Card.Content>
		</Card.Root>
	{/if}

	<ConfirmDialog
		open={confirmRow !== null}
		title="删除这条端口映射？"
		onconfirm={() => void confirmedDelete()}
		oncancel={() => (confirmRow = null)}
	>
		{#if confirmRow !== null}
			<p>
				将删除映射「{confirmRow.name}」（localhost:{confirmRow.localPort} → {peerLabel(confirmRow.peer)}:{confirmRow.remotePort}）。
			</p>
			<p>正在通过该端口的连接会被中断；此操作不可撤销。</p>
		{/if}
	</ConfirmDialog>
</section>
