<script lang="ts">
	// setup 世界（D4 极简收束 2026-10-02 重构）：先选路径，再做那件事——三张
	// 选择卡（连远程 / 本机当中枢 / 已保存节点），选中展开对应表单/动作，其余
	// 收起。一屏一事：选择就是那件事。纪律（视觉审计 A5/A3）：
	// - 编号只保留在路径层（表单字段一律普通标签）；
	// - 安全声明全卡仅一句（管理凭证只交给本地进程）；
	// - CLI 等价命令收进折叠；术语（DWEB_ADMIN_TOKEN）不入正文。
	// 成功确认幕短暂呈现（掩码目标），随后进入 ready 世界。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import * as Alert from "$lib/components/ui/alert";
	import * as Field from "$lib/components/ui/field";
	import { Input } from "$lib/components/ui/input";
	import { Badge } from "$lib/components/ui/badge";
	import { Check, ChevronDown, CircleAlert, House, LoaderCircle, LockKeyhole, Server, Trash2 } from "@lucide/svelte";
	import { untrack } from "svelte";
	import { connectErrorCopy } from "$lib/copy";
	import { maskNodeUrl } from "$lib/terms";
	import { fmtDate } from "$lib/format";
	import type { SidecarNode } from "$lib/api";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	type Path = "remote" | "local" | "saved";
	let path = $state<Path>("remote");

	// 挂载期首拉本机数据面（hub 投影决定路径②形态；节点簿决定路径③）。
	$effect(() => {
		untrack(() => {
			void cs.refreshHub();
			void cs.refreshNodes();
		});
	});

	const err = $derived(
		cs.connectResult !== null && cs.connectResult.ok === false
			? connectErrorCopy(cs.connectResult.error)
			: null,
	);
	const canSubmit = $derived(
		cs.connectForm.server !== "" && cs.connectForm.token !== "" && cs.connectForm.code !== "",
	);

	// ---- 路径②：一键本地中枢 ---------------------------------------------------------
	const hubChecking = $derived(cs.hubData === null && cs.hubAbsent === false);
	const hubRunning = $derived(cs.hubData?.running === true);
	const hubBusy = $derived(cs.hubStartBusy);
	const hubErrText = $derived(cs.hubStartError !== null ? cs.hubStartError.message : null);
	const hubActionLabel = $derived(
		cs.hubAbsent === true ? "把这台电脑变成中枢" : hubRunning ? "连接本机中枢" : "启动本机中枢并连接",
	);

	async function startLocalHub(): Promise<void> {
		await cs.startLocalHub(cs.hubAbsent === true);
	}

	// ---- 路径③：已保存节点 ------------------------------------------------------------
	const nodes = $derived(Array.isArray(cs.nodesData?.nodes) ? cs.nodesData!.nodes : []);
	const nodesLoading = $derived(cs.nodesData === null && cs.nodesError === null);
	const nodesUnavailable = $derived(cs.nodesError !== null && cs.nodesError.code === "not-found");
	const confirmNode = $derived(cs.nodeConfirm);

	function nodeLabel(n: SidecarNode): string {
		return n.name.trim() !== "" ? n.name : maskNodeUrl(n.server_host);
	}

	const paths: { id: Path; icon: typeof Server; title: string; scene: string }[] = [
		{ id: "remote", icon: Server, title: "连一台远程服务器", scene: "家里已有一台服务器（云上或别的机器）" },
		{ id: "local", icon: House, title: "这台电脑当中枢", scene: "没有服务器？这台电脑自己当" },
		{ id: "saved", icon: LockKeyhole, title: "连保存过的服务器", scene: "之前连过的，一键回连" },
	];
</script>

{#if cs.connectResult !== null && cs.connectResult.ok === true}
	<div class="flex min-h-svh items-center justify-center px-6">
		<Card.Root class="w-full max-w-lg text-center">
			<Card.Header class="items-center gap-3">
				<div
					class="mx-auto flex size-12 items-center justify-center rounded-full bg-success/10 text-success"
				>
					<LockKeyhole class="size-6" />
				</div>
				<Card.Title class="text-xl">已连接。正在进入总览…</Card.Title>
				<Card.Description>
					目标已锁定：<span class="font-mono">{cs.sidecar?.server_host_masked ?? "-"}</span>
					——运行期间经顶栏「节点簿」切换到其他已保存的节点。
				</Card.Description>
			</Card.Header>
			<Card.Footer class="justify-center">
				<Button onclick={() => cs.leaveSetupOnSuccess()}>立即进入总览</Button>
			</Card.Footer>
		</Card.Root>
	</div>
{:else}
	<div class="flex min-h-svh items-center justify-center px-6 py-10">
		<Card.Root class="w-full max-w-2xl">
			<Card.Header>
				<Card.Description class="text-xs font-medium tracking-wide text-muted-foreground">
					opendweb 服务器控制台 · 首次设置
				</Card.Description>
				<Card.Title class="text-2xl font-semibold">把控制台接上你的服务器</Card.Title>
				<Card.Description class="text-sm leading-relaxed">
					选一种开始方式。管理凭证只交给本地进程，浏览器不保存、不回显。
				</Card.Description>
			</Card.Header>

			<Card.Content class="flex flex-col gap-5">
				<!-- 路径选择（编号只在这一层） -->
				<div class="grid gap-3 sm:grid-cols-3" data-path-select>
					{#each paths as p (p.id)}
						<button
							type="button"
							class="flex cursor-pointer flex-col gap-1.5 rounded-lg border p-4 text-left transition-colors {path === p.id
								? 'border-primary bg-primary/5'
								: 'hover:bg-accent/60'}"
							aria-pressed={path === p.id}
							onclick={() => (path = p.id)}
							data-path={p.id}
						>
							<span class="flex items-center gap-2 text-sm font-semibold">
								<p.icon class="size-4 text-muted-foreground" aria-hidden="true" />
								{p.title}
							</span>
							<span class="text-xs leading-relaxed text-muted-foreground">{p.scene}</span>
						</button>
					{/each}
				</div>

				<!-- ① 连一台远程服务器 -->
				{#if path === "remote"}
					{#if err !== null}
						<Alert.Root variant="destructive">
							<CircleAlert />
							<Alert.Title>{err.title}</Alert.Title>
							<Alert.Description>{err.detail}</Alert.Description>
						</Alert.Root>
					{/if}
					<form
						class="flex flex-col gap-4"
						onsubmit={(e) => {
							e.preventDefault();
							void cs.submitConnect();
						}}
					>
						<Field.Group>
							<Field.Field>
								<Field.Label for="setup-server">服务器地址</Field.Label>
								<Input
									id="setup-server"
									name="server"
									value={cs.connectForm.server}
									oninput={(e) => cs.onConnectInput("server", e.currentTarget.value)}
									autocomplete="off"
									spellcheck="false"
									placeholder="https://srv.example.com:18787"
								/>
							</Field.Field>
							<Field.Field>
								<Field.Label for="setup-token">管理凭证</Field.Label>
								<Input
									id="setup-token"
									name="token"
									type="password"
									value={cs.connectForm.token}
									oninput={(e) => cs.onConnectInput("token", e.currentTarget.value)}
									autocomplete="off"
									placeholder="服务器启动时设置的那串"
								/>
							</Field.Field>
							<Field.Field>
								<Field.Label for="setup-code">配对码</Field.Label>
								<Field.Description>这台控制台连服务器用的一次性码；家人进门用的是另一种短码，两个不是一回事。</Field.Description>
								<Input
									id="setup-code"
									name="code"
									value={cs.connectForm.code}
									oninput={(e) => cs.onConnectInput("code", e.currentTarget.value)}
									autocomplete="off"
									spellcheck="false"
									placeholder="启动时打印的一行 13 位码，10 分钟内有效、只能用一次"
									class="font-mono uppercase"
								/>
							</Field.Field>
						</Field.Group>
						<Button type="submit" size="lg" disabled={cs.connectBusy || !canSubmit}>
							{#if cs.connectBusy}
								<LoaderCircle data-icon="inline-start" class="animate-spin" />
								正在连接…
							{:else}
								连接并锁定
							{/if}
						</Button>

					</form>
				{:else if path === "local"}
					<!-- ② 这台电脑当中枢（一键：本地控制面完成 init+start+连接） -->
					<div class="flex flex-col gap-3" data-story="local-hub">
						{#if hubChecking}
							<p class="text-sm text-muted-foreground">正在检查这台电脑的中枢状态…</p>
						{:else if cs.hubAbsent === true}
							<p class="text-sm leading-relaxed text-muted-foreground">
								这台电脑自己当中枢，家人设备直连互传，它只管牵线、兜底、守门。点击后自动准备并启动。
							</p>
						{:else if hubRunning}
							<p class="text-sm leading-relaxed text-muted-foreground">
								这台电脑已经是中枢，服务正在运行——直接连上管理它。
							</p>
						{:else}
							<p class="text-sm leading-relaxed text-muted-foreground">
								这台电脑已经是中枢，但服务没有在运行——点一下拉起并连上。
							</p>
						{/if}
						{#if hubErrText !== null}
							<p class="text-sm text-destructive" role="alert" data-error="hub-start">
								一键启动失败——{hubErrText}
							</p>
						{/if}
						<div class="flex flex-wrap items-center gap-3">
							<Button size="lg" disabled={hubBusy} onclick={() => void startLocalHub()}>
								{#if hubBusy}
									<LoaderCircle data-icon="inline-start" class="animate-spin" />
									正在启动…
								{:else}
									{hubActionLabel}
								{/if}
							</Button>
							<details class="group text-xs text-muted-foreground">
								<summary class="inline-flex cursor-pointer select-none list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
									高级：命令行方式
									<ChevronDown class="size-3 transition-transform group-open:rotate-180" />
								</summary>
								<code class="mt-1 block rounded bg-muted px-2 py-1 font-mono text-[12px]">
									opendweb hub init && opendweb hub start
								</code>
							</details>
						</div>
					</div>
				{:else if nodesUnavailable}
					<p class="text-sm text-muted-foreground">这台设备未启用节点簿。</p>
				{:else}
					<!-- ③ 连已保存的节点 -->
					<div class="flex flex-col gap-3" data-story="saved-nodes">
						{#if cs.switchingTo !== null}
							<div
								class="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm"
								data-state="switching"
							>
								<LoaderCircle class="size-4 animate-spin text-warning" />
								正在连接「{cs.switchingTo}」…
							</div>
						{/if}
						{#if cs.nodesError !== null && cs.nodesError.code !== "not-found"}
							<p class="text-sm text-destructive" role="alert">{cs.nodesError.message}</p>
						{/if}
						{#if nodesLoading}
							<p class="text-sm text-muted-foreground">正在读取节点簿…</p>
						{:else if nodes.length === 0}
							<p class="text-sm leading-relaxed text-muted-foreground" data-empty="nodes">
								还没有保存的节点。用其他方式连上一台服务器后，它会自动保存进来，下次从这里一键回连。
							</p>
						{:else}
							<ul class="flex flex-col gap-2">
								{#each nodes as n (n.id)}
									<li
										class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5"
										data-node={n.id}
									>
										<div class="flex min-w-0 flex-1 flex-col">
											<span class="truncate text-sm font-medium">{nodeLabel(n)}</span>
											<span class="truncate font-mono text-xs text-muted-foreground" title={maskNodeUrl(n.server_host)}>
												{maskNodeUrl(n.server_host)} · 保存于 {fmtDate(n.added_at)}
											</span>
										</div>
										{#if n.current}
											<Badge variant="outline" class="border-success/30 bg-success/10 text-success">
												<Check class="size-3" />
												当前
											</Badge>
										{:else}
											<Button
												variant="outline"
												size="sm"
												disabled={cs.switchingTo !== null}
												onclick={() => void cs.connectNodeFromSetup(n)}
											>
												连接
											</Button>
										{/if}
										<Button
											variant="ghost"
											size="icon"
											class="size-7 text-muted-foreground hover:text-destructive"
											title={n.current ? "当前节点不能删除——先连接其他节点" : "从节点簿删除"}
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
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{/if}

<!-- 删除确认（与顶栏节点簿同一动作语义） -->
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
