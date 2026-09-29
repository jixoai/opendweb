<script lang="ts">
	// sync 插件——同步组管理页（webui-plugin-kernel Phase 3，路由 #/p/sync/groups）。
	// 意图（2026-09-29）：
	// 1. 组件不直接 fetch（文件面纪律）：数据/动作全走 props（编排者接线层装配
	//    sidecar 动作——本组件只渲染+回调）。
	// 2. 建组表单（[W9]）：对端 endpointId/设备名 + 同步根 + 单双向 + **seed
	//    authority 显式选择**（本端/对端——首拉非空阻断的前置裁决，不自动合并）。
	// 3. seed 阻断面板：A 内容/B 现状/空基线三方对照（四桶分类），显式
	//    「采纳 A（放弃本端内容）」处置按钮（destructive——需确认）。
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { Separator } from "$lib/components/ui/separator";
	import ErrorBanner from "../../ErrorBanner.svelte";
	import {
		classifySeedThreeWay,
		modeLabel,
		phaseTone,
		phaseLabel,
		type GroupView,
		type SeedBlockView,
		type GroupDraft,
		type SyncMode,
	} from "./view-model";

	let {
		groups,
		loading = false,
		error = null as string | null,
		seedBlock = null as SeedBlockView | null,
		onCreateGroup,
		onDeleteGroup,
		onSyncNow,
		onResolveSeedBlock,
	}: {
		groups: GroupView[] | null;
		loading?: boolean;
		error?: string | null;
		seedBlock?: SeedBlockView | null;
		onCreateGroup: (draft: GroupDraft) => void;
		onDeleteGroup: (groupId: string) => void;
		onSyncNow: (groupId: string) => void;
		onResolveSeedBlock: (groupId: string, rootId: string, decision: "adopt-seed") => void;
	} = $props();

	// 建组表单（$state——本地草稿，提交经 onCreateGroup 上抛）
	let name = $state("");
	let peerEndpointId = $state("");
	let peerDeviceName = $state("");
	let rootPath = $state("");
	let mode = $state<SyncMode>("twoway");
	let seedAuthorityIsSelf = $state(true);
	let confirmAdopt = $state(false);

	const formValid = $derived(
		name.trim() !== "" && /^[0-9a-f]{8,64}$/.test(peerEndpointId.trim()) && peerDeviceName.trim() !== "" && rootPath.trim().startsWith("/"),
	);

	function submitGroup() {
		if (!formValid) return;
		onCreateGroup({
			name: name.trim(),
			peerEndpointId: peerEndpointId.trim(),
			peerDeviceName: peerDeviceName.trim(),
			roots: [
				{
					localPath: rootPath.trim(),
					mode,
					seedAuthority: seedAuthorityIsSelf ? "self" : peerEndpointId.trim(),
				},
			],
		});
		name = "";
		peerEndpointId = "";
		peerDeviceName = "";
		rootPath = "";
	}

	const BUCKET_LABEL: Record<string, string> = {
		"seed-only": "仅权威端有",
		"local-only": "仅本端有",
		differs: "两方内容不同",
		same: "一致",
	};
</script>

<section class="flex flex-col gap-5" data-view="plugin-page" data-plugin="sync" data-plugin-page="groups">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">同步组</h2>
		<p class="text-sm text-muted-foreground">多台设备之间同步目录——单向跟随或双向自动合并，冲突交还用户。</p>
	</div>

	{#if error !== null}
		<ErrorBanner error={error} onRetry={() => onSyncNow(groups?.[0]?.id ?? "")} />
	{/if}

	{#if groups === null && loading}
		<p class="text-sm text-muted-foreground">正在载入同步组…</p>
	{:else if groups === null || groups.length === 0}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Title>还没有同步组。</Empty.Title>
				<Empty.Description>在下方创建第一个同步组——选择目录、模式与初始权威端。</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<div class="flex flex-col gap-4">
			{#each groups as group (group.id)}
				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2.5">
							{group.name}
							<Badge variant="outline" class="font-mono text-xs">{group.id}</Badge>
						</Card.Title>
						<Card.Description>
							成员 {group.members.map((m) => `${m.deviceName} (${m.endpointId.slice(0, 8)})`).join(" + ")}
						</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-3">
						{#each group.roots as root (root.id)}
							<div class="flex flex-wrap items-center gap-2 text-sm">
								<span class="font-mono text-xs">{root.localPath}</span>
								<Badge variant="secondary">{modeLabel(root.mode)}</Badge>
								{#if root.isSeedAuthority}
									<Badge variant="outline" class="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400">初始权威</Badge>
								{/if}
								{#if root.seedBlock}
									<Badge variant="outline" class={phaseTone("conflicted")}>首拉阻断</Badge>
								{/if}
								{#if root.hasConflicts}
									<Badge variant="outline" class={phaseTone("conflicted")}>待决议</Badge>
								{/if}
								{#if root.groupRef !== null}
									<span class="text-xs text-muted-foreground font-mono">{root.groupRef.slice(0, 8)}</span>
								{/if}
							</div>
						{/each}
						<div class="flex gap-2">
							<Button size="sm" variant="outline" onclick={() => onSyncNow(group.id)}>立即同步</Button>
							<Button size="sm" variant="destructive" onclick={() => onDeleteGroup(group.id)}>删除组</Button>
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}

	<!-- seed 阻断三方对照（[W9]：不自动合并不覆盖——显式处置） -->
	{#if seedBlock !== null}
		<Card.Root data-testid="seed-block">
			<Card.Header>
				<Card.Title class="flex items-center gap-2.5">
					首次拉取被阻断
					<Badge variant="outline" class={phaseTone("conflicted")}>{phaseLabel("conflicted")}</Badge>
				</Card.Title>
				<Card.Description>
					同步根下已有本地内容（组 {seedBlock.groupId} / {seedBlock.rootId}）。下面是权威端内容与本端现状的对照——基线为空。不自动合并、不静默覆盖。
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<ul class="flex flex-col gap-1.5 text-sm">
					{#each classifySeedThreeWay(seedBlock) as row (row.path)}
						<li class="flex flex-wrap items-center gap-2">
							<span class="font-mono text-xs">{row.path}</span>
							<Badge variant="outline">{BUCKET_LABEL[row.bucket] ?? row.bucket}</Badge>
						</li>
					{/each}
				</ul>
				<Separator />
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" bind:checked={confirmAdopt} />
					我了解采纳权威端会放弃本端上述内容（不可撤销）
				</label>
				<Button
					variant="destructive"
					disabled={!confirmAdopt}
					onclick={() => {
						onResolveSeedBlock(seedBlock.groupId, seedBlock.rootId, "adopt-seed");
						confirmAdopt = false;
					}}
				>
					采纳权威端（放弃本端内容）
				</Button>
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- 建组表单 -->
	<Card.Root>
		<Card.Header>
			<Card.Title>新建同步组</Card.Title>
			<Card.Description>两端各建一次同 id 组（成员一致）；初始权威端做整树基线，另一端首拉时若非空将被阻断并给出对照。</Card.Description>
		</Card.Header>
		<Card.Content class="grid gap-3 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="sync-group-name">组名</Label>
				<Input id="sync-group-name" bind:value={name} placeholder="agents-skills" />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="sync-peer-id">对端 endpointId（hex）</Label>
				<Input id="sync-peer-id" bind:value={peerEndpointId} placeholder="9f31c2…" class="font-mono" />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="sync-peer-name">对端设备名</Label>
				<Input id="sync-peer-name" bind:value={peerDeviceName} placeholder="Mac mini" />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="sync-root">同步根（本机绝对路径）</Label>
				<Input id="sync-root" bind:value={rootPath} placeholder="/Users/me/agents-skills" class="font-mono" />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label>模式</Label>
				<div class="flex gap-2">
					<Button size="sm" variant={mode === "twoway" ? "default" : "outline"} onclick={() => (mode = "twoway")}>双向</Button>
					<Button size="sm" variant={mode === "oneway" ? "default" : "outline"} onclick={() => (mode = "oneway")}>单向镜像</Button>
				</div>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label>初始权威端（[W9]——显式选择）</Label>
				<div class="flex gap-2">
					<Button size="sm" variant={seedAuthorityIsSelf ? "default" : "outline"} onclick={() => (seedAuthorityIsSelf = true)}>本端</Button>
					<Button size="sm" variant={!seedAuthorityIsSelf ? "default" : "outline"} onclick={() => (seedAuthorityIsSelf = false)}>对端</Button>
				</div>
			</div>
			<div class="sm:col-span-2">
				<Button disabled={!formValid} onclick={submitGroup}>创建组</Button>
			</div>
		</Card.Content>
	</Card.Root>
</section>
