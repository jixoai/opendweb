<script lang="ts">
	// 中枢状态卡（home-hub PM §5.2：hub 本机自动形态下服务未跑——总览置顶）。
	// 「中枢没有在运行。家里人将无法新连接。」+ 启动动作面（2026-10-02 用户故事
	// B 收口）：主按钮经本地控制面 POST /sidecar/hub/start 拉起守护进程（hub
	// start detached 自举——浏览器本身仍不直接管理系统进程，动作由本机 sidecar
	// 代理执行）；复制终端命令保留为等价替代路径，另可现场重探。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Copy, Play, RefreshCw } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { consoleStore as cs } from "$lib/console.svelte";

	const START_CMD = "opendweb hub start";

	async function copyStart(): Promise<void> {
		if (await cs.copyText(START_CMD)) toast.success("命令已复制——回到终端运行");
		else toast.error("复制失败——请手动输入 opendweb hub start");
	}

	async function startHub(): Promise<void> {
		const ok = await cs.startLocalHub(false);
		if (ok) toast.success("中枢已启动");
		else toast.error("启动失败", { description: cs.hubStartError?.message ?? "查看终端输出与中枢日志" });
	}
</script>

<Card.Root class="border-warning/40 bg-warning/5 py-4" data-card="hub-not-running">
	<Card.Content class="flex flex-row flex-wrap items-center gap-3">
		<span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning" aria-hidden="true">
			<Play class="size-4" />
		</span>
		<div class="flex flex-col">
			<p class="text-base font-medium">中枢没有在运行。家里人将无法新连接。</p>
			<p class="text-sm text-muted-foreground">
				点「启动中枢」由本机后台拉起守护进程；或回到终端运行
				<code class="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">{START_CMD}</code>。
			</p>
		</div>
		<div class="ml-auto flex gap-2">
			<Button variant="outline" size="sm" onclick={() => void cs.refreshHub()}>
				<RefreshCw data-icon="inline-start" />
				重探
			</Button>
			<Button variant="outline" size="sm" onclick={() => void copyStart()}>
				<Copy data-icon="inline-start" />
				复制命令
			</Button>
			<Button size="sm" disabled={cs.hubStartBusy} onclick={() => void startHub()}>
				{#if cs.hubStartBusy}
					<RefreshCw data-icon="inline-start" class="animate-spin" />
					正在启动…
				{:else}
					<Play data-icon="inline-start" />
					启动中枢
				{/if}
			</Button>
		</div>
	</Card.Content>
</Card.Root>
