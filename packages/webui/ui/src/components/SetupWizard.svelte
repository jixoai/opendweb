<script lang="ts">
	// setup 世界：首次连接引导——三条用户故事同屏（2026-10-02 走查修复）：
	// ① 连接远程服务器（原配对仪式，§4.1 流 A——主入口不变）；
	// ② 把这台电脑变成中枢（用户故事 B「一键启动本地服务并连接」：POST
	//    /sidecar/hub/start——hub init --yes + detached 启动 + admin 连接，全链
	//    在本地控制面完成，浏览器零 URL/凭证输入；CLI 替代路径仍披露）；
	// ③ 连接已保存的节点（用户故事 C「管理本地连接」：节点簿已存节点一键连接/
	//    删除——不再依赖先连上一台服务器才能打开顶栏节点簿）。
	// 成功确认幕短暂呈现（掩码目标 + 目标已锁定），随后应用层进入 ready 世界。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import * as Alert from "$lib/components/ui/alert";
	import * as Field from "$lib/components/ui/field";
	import { Input } from "$lib/components/ui/input";
	import { Separator } from "$lib/components/ui/separator";
	import { Badge } from "$lib/components/ui/badge";
	import {
		CircleAlert,
		House,
		LoaderCircle,
		LockKeyhole,
		Play,
		Server,
		Trash2,
	} from "@lucide/svelte";
	import { untrack } from "svelte";
	import { connectErrorCopy } from "$lib/copy";
	import { maskNodeUrl } from "$lib/terms";
	import { fmtDate } from "$lib/format";
	import type { SidecarNode } from "$lib/api";
	import { consoleStore as cs } from "$lib/console.svelte";
	import ConfirmDialog from "./ConfirmDialog.svelte";

	// 挂载期首拉本机数据面（hub 投影决定故事 B 形态；节点簿决定故事 C 可见性）。
	// untrack 防数据赋值重入（D2 同源防线）。
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

	// ---- 故事 B：一键本地中枢 --------------------------------------------------------
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

	// ---- 故事 C：已保存节点 -----------------------------------------------------------
	const nodes = $derived(Array.isArray(cs.nodesData?.nodes) ? cs.nodesData!.nodes : []);
	const nodesLoading = $derived(cs.nodesData === null && cs.nodesError === null);
	// 节点簿未启用（如 --setup 强制 setup 的 member 形态）= 该子面不存在，静默收敛
	const nodesUnavailable = $derived(cs.nodesError !== null && cs.nodesError.code === "not-found");
	const confirmNode = $derived(cs.nodeConfirm);

	function nodeLabel(n: SidecarNode): string {
		return n.name.trim() !== "" ? n.name : maskNodeUrl(n.server_host);
	}
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
		<Card.Root class="w-full max-w-xl">
			<Card.Header>
				<Card.Description class="text-xs font-medium tracking-wide text-muted-foreground">
					opendweb 服务器控制台 · 首次设置
				</Card.Description>
				<Card.Title class="text-2xl font-semibold">把控制台接上你的服务器</Card.Title>
				<Card.Description class="text-sm leading-relaxed">
					三种开始方式，选一种就行。这个页面运行在你自己的电脑上——管理凭证只交给本地进程，浏览器不保存、不回显。
				</Card.Description>
			</Card.Header>

			<Card.Content class="flex flex-col gap-6">
				<!-- ① 连接远程服务器（原配对仪式，主入口不变） -->
				<section class="flex flex-col gap-4">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						<Server class="size-4 text-muted-foreground" aria-hidden="true" />
						① 连接一台远程服务器
					</h2>
					<section class="rounded-lg border bg-muted/40 p-4">
						<h3 class="mb-2 text-sm font-medium">从终端抄三样东西</h3>
						<ol class="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
							<li>
								<strong class="font-medium text-foreground">服务器地址</strong>——形如
								<span class="font-mono text-[13px]">https://srv.example.com:18787</span>
							</li>
							<li>
								<strong class="font-medium text-foreground">管理凭证</strong>——服务器启动时设置的
								<span class="font-mono text-[13px]">DWEB_ADMIN_TOKEN</span>
							</li>
							<li>
								<strong class="font-medium text-foreground">配对码</strong>——终端最新打印的一行
								13 位码，10 分钟内有效、只能用一次
							</li>
						</ol>
					</section>

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
								<Field.Label for="setup-server">① 服务器地址</Field.Label>
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
								<Field.Label for="setup-token">② 管理凭证</Field.Label>
								<Input
									id="setup-token"
									name="token"
									type="password"
									value={cs.connectForm.token}
									oninput={(e) => cs.onConnectInput("token", e.currentTarget.value)}
									autocomplete="off"
									placeholder="粘贴后立即交给本地进程，本页不留存"
								/>
							</Field.Field>
							<Field.Field>
								<Field.Label for="setup-code">③ 配对码</Field.Label>
								<Input
									id="setup-code"
									name="code"
									value={cs.connectForm.code}
									oninput={(e) => cs.onConnectInput("code", e.currentTarget.value)}
									autocomplete="off"
									spellcheck="false"
									placeholder="13 位大写字母或数字"
									class="font-mono uppercase"
								/>
							</Field.Field>
						</Field.Group>

						<div class="flex flex-col gap-2">
							<Button
								type="submit"
								size="lg"
								disabled={cs.connectBusy || !canSubmit}
							>
								{#if cs.connectBusy}
									<LoaderCircle data-icon="inline-start" class="animate-spin" />
									正在连接…
								{:else}
									连接并锁定
								{/if}
							</Button>
							<p class="text-xs leading-relaxed text-muted-foreground">
								连接成功后目标即锁定——本进程运行期间不能经此表单改指；需要换节点时，用顶栏「节点簿」切换已保存的节点。
							</p>
						</div>
					</form>
				</section>

				<Separator />

				<!-- ② 把这台电脑变成中枢（一键：本地控制面完成 init+start+连接） -->
				<section class="flex flex-col gap-3" data-story="local-hub">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						<House class="size-4 text-muted-foreground" aria-hidden="true" />
						② 把这台电脑变成中枢（一键）
					</h2>
					{#if hubChecking}
						<p class="text-sm text-muted-foreground">正在检查本机中枢状态…</p>
					{:else if cs.hubAbsent === true}
						<p class="text-sm leading-relaxed text-muted-foreground">
							没有远程服务器也行：这台电脑自己当中枢，家人设备直连互传，它只管牵线、兜底、守门。
							点击后自动完成初始化并启动（家庭端口默认 服务 8787 / 中转 3340），管理凭证只保存在本机。
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
					<div class="flex flex-wrap items-center gap-2">
						<Button size="lg" disabled={hubBusy} onclick={() => void startLocalHub()}>
							{#if hubBusy}
								<LoaderCircle data-icon="inline-start" class="animate-spin" />
								正在启动…
							{:else}
								<Play data-icon="inline-start" />
								{hubActionLabel}
							{/if}
						</Button>
						<span class="text-xs text-muted-foreground">
							命令行等价：<code class="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">opendweb hub init && opendweb hub start</code>
						</span>
					</div>
				</section>

				<Separator />

				<!-- ③ 连接已保存的节点（节点簿；不依赖先连上一台服务器） -->
				{#if nodesUnavailable}
					<p class="text-xs text-muted-foreground">这台设备未启用节点簿。</p>
				{:else}
					<section class="flex flex-col gap-3" data-story="saved-nodes">
						<h2 class="flex items-center gap-2 text-sm font-semibold">
							<LockKeyhole class="size-4 text-muted-foreground" aria-hidden="true" />
							③ 连接已保存的节点
						</h2>
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
								还没有保存的节点。用上面任意方式连上一台服务器后，它会自动保存进节点簿，下次从这里一键回来。
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
										<Badge variant="outline" class="border-success/30 bg-success/10 text-success">当前</Badge>
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
						<p class="text-xs leading-relaxed text-muted-foreground">
							节点凭证只保存在本机私有文件（权限 0600）；「连接」立即切换，无需重新配对。
						</p>
					</section>
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
