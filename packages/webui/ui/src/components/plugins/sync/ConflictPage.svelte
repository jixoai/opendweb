<script lang="ts">
	// sync 插件——冲突决议页（webui-plugin-kernel Phase 3，路由 #/p/sync/conflicts）。
	// 意图（2026-09-29）：
	// 1. hunk 级：a（本端）/o（基线）/b（对端）三栏逐块对照——每块选 ours/theirs
	//    或编辑（编辑文本即该块终稿）；ours/theirs 身份按 endpointId 稳定排序
	//    （P5——冲突记录与两端呈现一致）。
	// 2. 文件级（binary/超限/非 UTF-8/delete-modify/type/mode）：整路径二选一
	//    （内容+mode 一体，不可拆开选）或编辑（文本场景）/接受删除。
	// 3. 组件不直接 fetch：会话经 props 注入；决议经 onSubmit 上抛（接线层转
	//    runtime.resolveConflicts——记录持久化后两端可复现）。
	// 4. 决议完整性由 view-model.missingDecisions 判定——有未决路径禁提交
	//    （绝不默认静默取舍）。
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Separator } from "$lib/components/ui/separator";
	import ErrorBanner from "../../ErrorBanner.svelte";
	import {
		conflictKindLabel,
		missingDecisions,
		type ConflictDecisions,
		type ConflictSessionView,
	} from "./view-model";

	let {
		sessions,
		loading = false,
		error = null as string | null,
		onSubmit,
		onRefresh,
	}: {
		/** 每 root 一个会话（接线层按组装配） */
		sessions: Array<{ groupId: string; rootId: string; session: ConflictSessionView | null }>;
		loading?: boolean;
		error?: string | null;
		onSubmit: (groupId: string, rootId: string, decisions: ConflictDecisions) => void;
		onRefresh: () => void;
	} = $props();

	// 决议草稿：`${groupId}/${rootId}` → path → 决议（读取一律经纯 getter——
	// 模板不得有副作用调用；缺省=ours 但**提交按钮由 missingDecisions 把关**，
	// 缺省值只在用户显式点选前作为呈现态，未决议路径仍会被拦下）
	let drafts = $state<Record<string, ConflictDecisions>>({});
	// hunk 编辑框内容：key `${g}/${r}::${path}::${hunkIndex}` → text
	let edits = $state<Record<string, string>>({});
	// 文件级编辑内容：key `${g}/${r}::${path}` → text
	let fileEdits = $state<Record<string, string>>({});

	function keyOf(groupId: string, rootId: string) {
		return `${groupId}/${rootId}`;
	}

	/** hunk 现行选择（缺省 ours——仅呈现态）。 */
	function getHunkChoice(k: string, path: string, hunkIndex: number, hunkCount: number): "ours" | "theirs" | "edit" {
		const d = drafts[k]?.[path];
		if (d !== undefined && d.level === "hunk") return d.choices.find((c) => c.hunkIndex === hunkIndex)?.choice ?? "ours";
		void hunkCount;
		return "ours";
	}

	/** 文件级现行选择（缺省 ours——仅呈现态）。 */
	function getFileChoice(k: string, path: string): "ours" | "theirs" | "edit" | "delete" {
		const d = drafts[k]?.[path];
		if (d !== undefined && d.level === "file") return d.choice;
		return "ours";
	}

	function setHunkChoice(groupId: string, rootId: string, path: string, hunkCount: number, hunkIndex: number, choice: "ours" | "theirs" | "edit", text?: string) {
		const k = keyOf(groupId, rootId);
		const prev = drafts[k]?.[path];
		const baseChoices: Array<{ hunkIndex: number; choice: "ours" | "theirs" | "edit"; text?: string }> =
			prev !== undefined && prev.level === "hunk"
				? [...prev.choices]
				: Array.from({ length: hunkCount }, (_, i) => ({ hunkIndex: i, choice: "ours" as const }));
		const choices = baseChoices.map((c) => (c.hunkIndex === hunkIndex ? { hunkIndex, choice, text } : c));
		drafts[k] = { ...(drafts[k] ?? {}), [path]: { level: "hunk", choices } };
	}

	function setFileChoice(groupId: string, rootId: string, path: string, choice: "ours" | "theirs" | "edit" | "delete") {
		const k = keyOf(groupId, rootId);
		drafts[k] = { ...(drafts[k] ?? {}), [path]: { level: "file", choice } };
	}

	function toBase64(text: string): string {
		const bytes = new TextEncoder().encode(text);
		let bin = "";
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin);
	}

	function submit(groupId: string, rootId: string, session: ConflictSessionView) {
		const k = keyOf(groupId, rootId);
		const decisions: ConflictDecisions = {};
		for (const conflict of session.conflicts) {
			if (conflict.resolution !== null && conflict.resolution !== undefined) continue;
			if (conflict.level === "hunk") {
				decisions[conflict.path] = {
					level: "hunk",
					choices: conflict.hunks.map((_, i) => {
						const choice = getHunkChoice(k, conflict.path, i, conflict.hunks.length);
						return choice === "edit"
							? { hunkIndex: i, choice: "edit" as const, text: edits[`${k}::${conflict.path}::${i}`] ?? "" }
							: { hunkIndex: i, choice };
					}),
				};
			} else {
				const choice = getFileChoice(k, conflict.path);
				decisions[conflict.path] =
					choice === "edit"
						? { level: "file", choice: "edit", contentBase64: toBase64(fileEdits[`${k}::${conflict.path}`] ?? "") }
						: { level: "file", choice };
			}
		}
		onSubmit(groupId, rootId, decisions);
	}

	const unresolved = (session: ConflictSessionView) => session.conflicts.filter((c) => c.resolution === null || c.resolution === undefined);
</script>

<section class="flex flex-col gap-5" data-view="plugin-page" data-plugin="sync" data-plugin-page="conflicts">
	<div class="flex flex-col gap-1">
		<div class="flex items-center justify-between gap-3">
			<div>
				<h2 class="text-lg font-semibold tracking-tight">同步冲突</h2>
				<p class="text-sm text-muted-foreground">逐块选择或编辑完成决议——决议记录两端可复现，提交后同步继续。</p>
			</div>
			<Button size="sm" variant="outline" onclick={() => onRefresh()}>刷新</Button>
		</div>
	</div>

	{#if error !== null}
		<ErrorBanner error={error} onRetry={() => onRefresh()} />
	{/if}

	{#if sessions.length === 0 || sessions.every((s) => s.session === null)}
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Title>{loading ? "正在载入…" : "当前没有待决议的冲突。"}</Empty.Title>
				<Empty.Description>双向同步遇到重叠修改或文件级冲突时会出现在这里。</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		{#each sessions as { groupId, rootId, session } (keyOf(groupId, rootId))}
			{#if session !== null}
				{@const pending = unresolved(session)}
				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center gap-2.5">
							<span class="font-mono text-sm">{groupId}/{rootId}</span>
							<Badge variant="outline" class="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">{pending.length} 待决议</Badge>
						</Card.Title>
						<Card.Description>
							合并算法 <span class="font-mono text-xs">{session.algoVersion}</span> · 基线 {session.baseCommit.slice(0, 8)} · 本端 {session.oursCommit.slice(0, 8)} · 对端 {session.theirsCommit.slice(0, 8)}
						</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-5">
						{#each pending as conflict (conflict.path)}
							<div class="flex flex-col gap-2 rounded-lg border border-border p-3" data-conflict={conflict.path}>
								<div class="flex flex-wrap items-center gap-2 text-sm">
									<span class="font-mono text-xs">{conflict.path}</span>
									<Badge variant="secondary">{conflict.level === "hunk" ? "块级" : "文件级"}</Badge>
									<Badge variant="outline">{conflictKindLabel(conflict.kind)}</Badge>
									{#if conflict.detail}
										<span class="text-xs text-muted-foreground">{conflict.detail}</span>
									{/if}
								</div>

								{#if conflict.level === "hunk"}
									{#each conflict.hunks as hunk, i (i)}
										{@const ek = `${keyOf(groupId, rootId)}::${conflict.path}::${i}`}
										{@const cur = getHunkChoice(keyOf(groupId, rootId), conflict.path, i, conflict.hunks.length)}
										<div class="flex flex-col gap-1.5">
											<div class="grid grid-cols-3 gap-1.5 text-xs">
												<div class="rounded-md bg-muted p-2">
													<div class="mb-1 font-medium text-muted-foreground">本端 (ours)</div>
													<pre class="overflow-x-auto font-mono">{hunk.a.join("\n") || "（空）"}</pre>
												</div>
												<div class="rounded-md bg-muted/60 p-2">
													<div class="mb-1 font-medium text-muted-foreground">基线 (base)</div>
													<pre class="overflow-x-auto font-mono">{hunk.o.join("\n") || "（空）"}</pre>
												</div>
												<div class="rounded-md bg-muted p-2">
													<div class="mb-1 font-medium text-muted-foreground">对端 (theirs)</div>
													<pre class="overflow-x-auto font-mono">{hunk.b.join("\n") || "（空）"}</pre>
												</div>
											</div>
											<div class="flex flex-wrap items-center gap-2 text-xs">
												<span class="text-muted-foreground">第 {i + 1} 块：</span>
												<Button size="xs" variant={cur === "ours" ? "default" : "outline"} onclick={() => setHunkChoice(groupId, rootId, conflict.path, conflict.hunks.length, i, "ours")}>用本端</Button>
												<Button size="xs" variant={cur === "theirs" ? "default" : "outline"} onclick={() => setHunkChoice(groupId, rootId, conflict.path, conflict.hunks.length, i, "theirs")}>用对端</Button>
												<Button size="xs" variant={cur === "edit" ? "default" : "outline"} onclick={() => setHunkChoice(groupId, rootId, conflict.path, conflict.hunks.length, i, "edit", edits[ek] ?? hunk.a.join("\n"))}>编辑</Button>
												{#if cur === "edit"}
													<textarea
														class="mt-1 min-h-24 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
														bind:value={edits[ek]}
														placeholder="该块终稿（整块内容）"
													></textarea>
												{/if}
											</div>
										</div>
									{/each}
								{:else}
									{@const fk = `${keyOf(groupId, rootId)}::${conflict.path}`}
									{@const cur = getFileChoice(keyOf(groupId, rootId), conflict.path)}
									<div class="flex flex-col gap-2 text-xs">
										<div class="flex flex-wrap gap-2 text-muted-foreground font-mono">
											<span>本端: {conflict.ours ? `${conflict.ours.oid.slice(0, 8)} (${conflict.ours.mode})` : "（删除）"}</span>
											<span>对端: {conflict.theirs ? `${conflict.theirs.oid.slice(0, 8)} (${conflict.theirs.mode})` : "（删除）"}</span>
											<span>基线: {conflict.base ? `${conflict.base.oid.slice(0, 8)} (${conflict.base.mode})` : "（无）"}</span>
										</div>
										<div class="flex flex-wrap items-center gap-2">
											<Button size="xs" variant={cur === "ours" ? "default" : "outline"} onclick={() => setFileChoice(groupId, rootId, conflict.path, "ours")}>保留本端（内容+权限）</Button>
											<Button size="xs" variant={cur === "theirs" ? "default" : "outline"} onclick={() => setFileChoice(groupId, rootId, conflict.path, "theirs")}>保留对端（内容+权限）</Button>
											{#if conflict.kind === "delete-modify"}
												<Button size="xs" variant={cur === "delete" ? "default" : "outline"} onclick={() => setFileChoice(groupId, rootId, conflict.path, "delete")}>接受删除</Button>
											{/if}
											{#if conflict.kind === "text" || conflict.kind === "add-add"}
												<Button size="xs" variant={cur === "edit" ? "default" : "outline"} onclick={() => setFileChoice(groupId, rootId, conflict.path, "edit")}>编辑</Button>
											{/if}
										</div>
										{#if cur === "edit"}
											<textarea
												class="min-h-24 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
												bind:value={fileEdits[fk]}
												placeholder="整文件终稿"
											></textarea>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
						<Separator />
						<div class="flex items-center gap-3">
							<Button
								disabled={missingDecisions(session, drafts[keyOf(groupId, rootId)] ?? {}).length > 0}
								onclick={() => submit(groupId, rootId, session)}
							>
								提交决议
							</Button>
							{#if missingDecisions(session, drafts[keyOf(groupId, rootId)] ?? {}).length > 0}
								<span class="text-xs text-muted-foreground">还有未决议路径（不默认取舍）。</span>
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			{/if}
		{/each}
	{/if}
</section>
