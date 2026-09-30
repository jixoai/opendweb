<script lang="ts">
	// files 插件专属页：文件浏览器（webui-plugin-kernel Phase 2 / design v2.3 §6
	// 「B 侧 UI（类型化专属页）：浏览/面包屑/上传（进度）/下载/改名/删除；写
	// 按钮按 share.mode 与授权显隐」）。
	// 纪律：
	// - 组件不直接 fetch、不 import api/console store——share 信息与全部远端
	//   动作经 props 注入（契约见 ./types.ts；宿主壳绑定层组装，参考实现=
	//   @jixo/opendweb-ext-files createWireFilesController + client-sdk fetchHttp
	//   transport 薄适配）。
	// - 上传=分片循环（4MiB）+进度回调+整文件增量摘要（./sha256.ts）；下载=
	//   Range 分片循环+落盘前 sha256 对账（x-opendweb-oid 语义）；删除显式
	//   确认（ConfirmDialog）。
	// - 写按钮显隐总开关=props 的 share.writable（mode rw 且 peer 授权——注入
	//   方判定；服务端写门仍是 wire 授权真源）。
	import * as Card from "$lib/components/ui/card";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import ConfirmDialog from "../../ConfirmDialog.svelte";
	import { Sha256 } from "./sha256";
	import type { FilesBrowserEntry, FilesShareInfo } from "./types";

	type Controller = import("./types").FilesBrowserController;

	let { share, controller }: { share: FilesShareInfo; controller: Controller } = $props();

	// r8-B4：v1 transport 有效包络=1MiB 帧（fabric session MAX_FRAME）——上传/下载
	// 分片与服务端 chunkMaxBytes 默认同拍（更大分片在真实网络上必然失败）。
	const CHUNK = 1024 * 1024;

	let segments = $state<string[]>([]);
	let entries = $state<FilesBrowserEntry[] | null>(null);
	let truncated = $state(false);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	// 上传（单活动任务；分片循环+进度）
	let upload = $state<{ name: string; sent: number; total: number } | null>(null);
	let uploadInput = $state<HTMLInputElement | null>(null);

	// 下载（Range 循环+进度+对账）
	let download = $state<{ name: string; received: number; total: number } | null>(null);

	// 新建目录（内联输入）
	let mkdirOpen = $state(false);
	let mkdirName = $state("");

	// 改名（内联编辑目标）
	let renameTarget = $state<string | null>(null);
	let renameTo = $state("");

	// 删除（显式确认）
	let deleteTarget = $state<{ name: string; path: string; kind: "dir" | "file" } | null>(null);

	const cwd = $derived(segments.join("/"));
	const crumbs = $derived(
		segments.map((name, i) => ({ name, path: segments.slice(0, i + 1).join("/") })),
	);

	function fmtSize(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
	}

	function fmtTime(ms: number): string {
		if (ms === 0) return "—";
		return new Date(ms).toLocaleString();
	}

	async function reload(): Promise<void> {
		loading = true;
		error = null;
		try {
			const out = await controller.list(cwd);
			entries = out.entries;
			truncated = out.truncated;
		} catch (e) {
			entries = [];
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function openDir(path: string): void {
		segments = path === "" ? [] : path.split("/");
		void reload();
	}

	function openEntry(entry: FilesBrowserEntry): void {
		const child = cwd === "" ? entry.name : `${cwd}/${entry.name}`;
		if (entry.type === "dir") {
			openDir(child);
		} else {
			void downloadFile(child, entry.name);
		}
	}

	/** 下载（Range 分片循环+进度+sha256 对账→浏览器保存） */
	async function downloadFile(path: string, name: string): Promise<void> {
		error = null;
		notice = null;
		const hash = new Sha256();
		const parts: BlobPart[] = [];
		let received = 0;
		let total: number | null = null;
		let oid: string | null = null;
		download = { name, received: 0, total: 0 };
		try {
			for (;;) {
				const slice = await controller.readSlice(path, received, CHUNK);
				if (total === null) {
					total = slice.size ?? received + slice.bytes.length;
					oid = slice.oid;
				}
				if (slice.bytes.length === 0) break;
				parts.push(new Uint8Array(slice.bytes));
				hash.update(slice.bytes);
				received += slice.bytes.length;
				download = { name, received, total };
				if (total !== null && received >= total) break;
			}
			const digest = hash.digestHex();
			if (oid !== null && digest !== oid) {
				throw new Error(`下载摘要不符（期望 ${oid.slice(0, 12)}… 实得 ${digest.slice(0, 12)}…）——已丢弃`);
			}
			const blob = new Blob(parts);
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			a.click();
			URL.revokeObjectURL(url);
			notice = `已下载 ${name}（${fmtSize(blob.size)}，摘要核对通过）`;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			download = null;
		}
	}

	/** 上传（分片循环+进度+commit 原子落盘；同键同内容幂等续传由 wire 层保证） */
	async function uploadFile(file: File): Promise<void> {
		const path = cwd === "" ? file.name : `${cwd}/${file.name}`;
		const uploadId = `ui-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
		const hash = new Sha256();
		upload = { name: file.name, sent: 0, total: file.size };
		error = null;
		notice = null;
		try {
			let seq = 0;
			for (let offset = 0; offset < file.size; offset += CHUNK, seq++) {
				const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + CHUNK, file.size)).arrayBuffer());
				hash.update(bytes);
				await controller.putChunk(path, uploadId, seq, offset, bytes);
				upload = { name: file.name, sent: Math.min(offset + CHUNK, file.size), total: file.size };
			}
			const out = await controller.commit(path, uploadId, file.size, hash.digestHex());
			notice = `已上传 ${file.name}（${fmtSize(out.size)}，commit 校验通过）`;
			await reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			upload = null;
		}
	}

	async function doMkdir(): Promise<void> {
		if (mkdirName.trim() === "") return;
		const path = cwd === "" ? mkdirName.trim() : `${cwd}/${mkdirName.trim()}`;
		try {
			await controller.mkdir(path);
			mkdirOpen = false;
			mkdirName = "";
			await reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doRename(): Promise<void> {
		if (renameTarget === null || renameTo.trim() === "") return;
		const parent = cwd === "" ? "" : `${cwd}/`;
		try {
			await controller.rename(`${parent}${renameTarget}`, `${parent}${renameTo.trim()}`);
			renameTarget = null;
			renameTo = "";
			await reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function doDelete(): Promise<void> {
		if (deleteTarget === null) return;
		try {
			await controller.remove(deleteTarget.path);
			deleteTarget = null;
			await reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	$effect(() => {
		// 首拍 + share 切换时重载（cwd 由 segments 派生）
		void share.id;
		segments = [];
		void reload();
	});
</script>

<section class="flex flex-col gap-4" data-view="plugin-page" data-plugin="files" data-plugin-page="browser">
	<div class="flex items-center justify-between gap-3">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold tracking-tight">文件浏览 · {share.name}</h2>
			<p class="text-sm text-muted-foreground">
				共享 <span class="font-mono text-xs">{share.id}</span>
				<Badge variant="outline" class="ml-2 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
					{share.mode === "rw" ? "可读写" : "只读"}
				</Badge>
			</p>
		</div>
		{#if share.writable}
			<div class="flex items-center gap-2">
				<input
					bind:this={uploadInput}
					type="file"
					class="hidden"
					onchange={(e) => {
						const f = e.currentTarget.files?.[0];
						if (f !== undefined) void uploadFile(f);
						e.currentTarget.value = "";
					}}
				/>
				<Button size="sm" variant="outline" onclick={() => mkdirOpen = !mkdirOpen}>新建文件夹</Button>
				<Button size="sm" onclick={() => uploadInput?.click()} disabled={upload !== null}>上传文件</Button>
			</div>
		{/if}
	</div>

	<!-- 面包屑 -->
	<nav class="flex flex-wrap items-center gap-1 text-sm" aria-label="路径">
		<button class="rounded px-1.5 py-0.5 hover:bg-accent" onclick={() => openDir("")}>{share.name}</button>
		{#each crumbs as crumb (crumb.path)}
			<span class="text-muted-foreground">/</span>
			<button class="rounded px-1.5 py-0.5 hover:bg-accent" onclick={() => openDir(crumb.path)}>{crumb.name}</button>
		{/each}
		<Button variant="ghost" size="icon-sm" class="ml-1 size-6" title="刷新" onclick={() => void reload()}>⟳</Button>
	</nav>

	{#if error !== null}
		<div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</div>
	{/if}
	{#if notice !== null}
		<div class="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400" role="status">{notice}</div>
	{/if}

	{#if mkdirOpen && share.writable}
		<div class="flex items-center gap-2">
			<input
				class="w-64 rounded-md border bg-background px-2 py-1 text-sm"
				placeholder="新文件夹名"
				bind:value={mkdirName}
				onkeydown={(e) => { if (e.key === "Enter") void doMkdir(); }}
			/>
			<Button size="sm" onclick={() => void doMkdir()}>创建</Button>
			<Button size="sm" variant="ghost" onclick={() => (mkdirOpen = false)}>取消</Button>
		</div>
	{/if}

	{#if upload !== null}
		<div class="flex flex-col gap-1 rounded-md border px-3 py-2" data-testid="upload-progress">
			<div class="flex items-center justify-between text-sm">
				<span>上传 {upload.name}</span>
				<span class="font-mono text-xs">{fmtSize(upload.sent)} / {fmtSize(upload.total)}</span>
			</div>
			<div class="h-1.5 overflow-hidden rounded bg-muted">
				<div class="h-full bg-emerald-500 transition-all" style="width: {upload.total === 0 ? 100 : Math.round((upload.sent / upload.total) * 100)}%"></div>
			</div>
		</div>
	{/if}
	{#if download !== null}
		<div class="flex flex-col gap-1 rounded-md border px-3 py-2" data-testid="download-progress">
			<div class="flex items-center justify-between text-sm">
				<span>下载 {download.name}</span>
				<span class="font-mono text-xs">{fmtSize(download.received)} / {download.total > 0 ? fmtSize(download.total) : "?"}</span>
			</div>
			<div class="h-1.5 overflow-hidden rounded bg-muted">
				<div class="h-full bg-sky-500 transition-all" style="width: {download.total === 0 ? 0 : Math.round((download.received / download.total) * 100)}%"></div>
			</div>
		</div>
	{/if}

	<Card.Root>
		<Card.Content class="p-0">
			{#if loading && entries === null}
				<div class="flex flex-col gap-2 p-4">
					<Skeleton class="h-5 w-full" />
					<Skeleton class="h-5 w-3/4" />
					<Skeleton class="h-5 w-1/2" />
				</div>
			{:else if entries !== null && entries.length === 0}
				<p class="p-6 text-center text-sm text-muted-foreground">空目录</p>
			{:else if entries !== null}
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b text-left text-xs text-muted-foreground">
							<th class="px-4 py-2 font-medium">名称</th>
							<th class="px-4 py-2 font-medium">类型</th>
							<th class="px-4 py-2 font-medium">大小</th>
							<th class="px-4 py-2 font-medium">修改时间</th>
							{#if share.writable}<th class="px-4 py-2 font-medium text-right">操作</th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each entries as entry (entry.name)}
							<tr class="border-b last:border-b-0 hover:bg-accent/40">
								<td class="px-4 py-2">
									<button class="underline-offset-2 hover:underline" onclick={() => openEntry(entry)}>
										{entry.type === "dir" ? "📁" : "📄"} {entry.name}
									</button>
								</td>
								<td class="px-4 py-2 text-muted-foreground">{entry.type === "dir" ? "目录" : "文件"}</td>
								<td class="px-4 py-2 font-mono text-xs">{entry.type === "dir" ? "—" : fmtSize(entry.size)}</td>
								<td class="px-4 py-2 text-xs text-muted-foreground">{fmtTime(entry.mtime)}</td>
								{#if share.writable}
									<td class="px-4 py-2 text-right">
										{#if renameTarget === entry.name}
											<span class="inline-flex items-center gap-1">
												<input
													class="w-36 rounded-md border bg-background px-2 py-0.5 text-xs"
													bind:value={renameTo}
													onkeydown={(e) => { if (e.key === "Enter") void doRename(); }}
												/>
												<Button size="sm" onclick={() => void doRename()}>确定</Button>
												<Button size="sm" variant="ghost" onclick={() => (renameTarget = null)}>取消</Button>
											</span>
										{:else}
											<span class="inline-flex items-center gap-1">
												<Button
													size="sm"
													variant="ghost"
													onclick={() => {
														renameTarget = entry.name;
														renameTo = entry.name;
													}}>改名</Button
												>
												<Button
													size="sm"
													variant="ghost"
													class="text-destructive"
													onclick={() => {
														deleteTarget = {
															name: entry.name,
															path: cwd === "" ? entry.name : `${cwd}/${entry.name}`,
															kind: entry.type,
														};
													}}>删除</Button
												>
											</span>
										{/if}
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
				{#if truncated}
					<p class="px-4 py-2 text-xs text-muted-foreground">条目过多，仅显示前 {entries.length} 项</p>
				{/if}
			{/if}
		</Card.Content>
	</Card.Root>

	<ConfirmDialog
		open={deleteTarget !== null}
		title="删除确认"
		confirmLabel="删除"
		onconfirm={() => void doDelete()}
		oncancel={() => (deleteTarget = null)}
	>
		{#if deleteTarget !== null}
			<p>
				将删除{deleteTarget.kind === "dir" ? "目录" : "文件"}
				<span class="font-mono text-xs">{deleteTarget.path}</span>
				{deleteTarget.kind === "dir" ? "（仅空目录；非空需先清空）" : ""}。
			</p>
			<p>该操作不可撤销。</p>
		{/if}
	</ConfirmDialog>
</section>
