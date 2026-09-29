<script lang="ts">
	// files 文件浏览页绑定层（B 侧）：FileBrowserPage 需要 (share, controller)——
	// 浏览器侧没有 fabric 直连，wire 调用经 sidecar bridge（store filesBridgeCall
	// → /sidecar/plugins/files/bridge → fabric fetchHttp）。挂载信息（对端
	// endpointId + share id）为浏览器本地态（v1 无 B 侧远端共享注册面——提供侧
	// 授权账本才是写门真源；此处仅是浏览入口，localStorage 持久化挂载）。
	import { untrack } from "svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import { createBridgeFilesController } from "$lib/plugins-files-controller";
	import type { FilesBrowserController } from "../files/types";
	import FileBrowserPage from "../files/FileBrowserPage.svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import * as Card from "$lib/components/ui/card";

	const MOUNT_KEY = "opendweb.wpk.files-mount";

	interface Mount {
		peer: string;
		shareId: string;
		name: string;
		writable: boolean;
	}

	function loadMount(): Mount | null {
		try {
			const raw = localStorage.getItem(MOUNT_KEY);
			if (raw === null) return null;
			const v = JSON.parse(raw) as Partial<Mount>;
			if (typeof v.peer !== "string" || typeof v.shareId !== "string" || v.peer === "" || v.shareId === "") return null;
			return { peer: v.peer, shareId: v.shareId, name: typeof v.name === "string" ? v.name : v.shareId, writable: v.writable === true };
		} catch {
			return null;
		}
	}

	let mount = $state<Mount | null>(loadMount());
	let formPeer = $state("");
	let formShareId = $state("");
	let formName = $state("");
	let formWritable = $state(false);
	let formError = $state<string | null>(null);

	function connect(): void {
		const peer = formPeer.trim();
		const shareId = formShareId.trim();
		if (!/^[0-9a-f]{8,64}$/.test(peer.toLowerCase())) {
			formError = "对端设备 ID 必须是十六进制 endpoint id。";
			return;
		}
		if (shareId === "") {
			formError = "请填写共享 ID（对端分享的 share id）。";
			return;
		}
		const next: Mount = { peer: peer.toLowerCase(), shareId, name: formName.trim() === "" ? shareId : formName.trim(), writable: formWritable };
		localStorage.setItem(MOUNT_KEY, JSON.stringify(next));
		mount = next;
		formError = null;
	}

	function disconnect(): void {
		localStorage.removeItem(MOUNT_KEY);
		mount = null;
		formPeer = "";
		formShareId = "";
		formName = "";
		formWritable = false;
	}

	const controller = $derived(
		mount === null ? null : createBridgeFilesController((req) => cs.filesBridgeCall(req), { peer: mount.peer, shareId: mount.shareId }),
	);

	// 挂载变化时预热 store 数据面（bridge 依赖 sidecar；错误由页面在操作时呈现）
	$effect(() => {
		if (mount !== null) untrack(() => void cs.refreshFilesShares());
	});
</script>

{#if mount !== null && controller !== null}
	<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span class="font-mono">{mount.name}</span>
		<span>（对端 {mount.peer.slice(0, 8)}… · 共享 {mount.shareId}）</span>
		<Button size="sm" variant="outline" class="ml-auto" onclick={() => disconnect()}>切换共享</Button>
	</div>
	<FileBrowserPage share={{ id: mount.shareId, name: mount.name, mode: mount.writable ? "rw" : "ro", writable: mount.writable }} {controller} />
{:else}
	<section class="flex flex-col gap-5" data-view="plugin-page" data-plugin="files" data-plugin-page="browser-mount">
		<div class="flex flex-col gap-1">
			<h2 class="text-lg font-semibold tracking-tight">文件浏览</h2>
			<p class="text-sm text-muted-foreground">
				浏览另一台设备通过 files 插件共享的文件夹。填写对端分享的共享信息开始浏览——读写权限由提供侧授权决定。
			</p>
		</div>
		<Card.Root>
			<Card.Header>
				<Card.Title>连接共享</Card.Title>
				<Card.Description>挂载信息保存在本浏览器（不落服务端）；对端需已把本设备加入共享的 peers 名单。</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					class="flex flex-col gap-4"
					onsubmit={(e) => {
						e.preventDefault();
						connect();
					}}
					data-form="mount-share"
				>
					<div class="grid gap-4 sm:grid-cols-2">
						<div class="flex flex-col gap-1.5">
							<Label for="files-mount-peer">对端设备 ID（endpoint id）</Label>
							<Input id="files-mount-peer" placeholder="0a1b2c…" bind:value={formPeer} class="font-mono" />
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="files-mount-share">共享 ID（share id）</Label>
							<Input id="files-mount-share" placeholder="sh_a1b2c3" bind:value={formShareId} class="font-mono" />
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="files-mount-name">显示名（可选）</Label>
							<Input id="files-mount-name" placeholder="iMac 的共享目录" bind:value={formName} />
						</div>
						<div class="flex flex-col gap-1.5">
							<Label for="files-mount-writable">写操作</Label>
							<label class="flex items-center gap-2 text-sm text-muted-foreground">
								<input id="files-mount-writable" type="checkbox" bind:checked={formWritable} class="size-4" />
								对端已授权我写入（勾选后才显示上传/改名/删除按钮）
							</label>
						</div>
					</div>
					{#if formError !== null}
						<p class="text-xs text-destructive" data-form-error>{formError}</p>
					{/if}
					<div>
						<Button size="sm" type="submit">浏览</Button>
					</div>
				</form>
			</Card.Content>
		</Card.Root>
	</section>
{/if}
