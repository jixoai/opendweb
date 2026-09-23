<script lang="ts">
	// 中枢状态卡（home-hub PM §5.2：hub 本机自动形态下服务未跑——总览置顶）。
	// 「中枢没有在运行。家里人将无法新连接。」+ 启动中枢动作面：浏览器不能替
	// 用户起系统服务（产品不做越权变更）——按钮 converge 到同一动作：给出
	// `opendweb hub start` 命令（复制）并可现场重探。
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
</script>

<Card.Root class="border-warning/40 bg-warning/5 py-4" data-card="hub-not-running">
	<Card.Content class="flex flex-row flex-wrap items-center gap-3">
		<span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning" aria-hidden="true">
			<Play class="size-4" />
		</span>
		<div class="flex flex-col">
			<p class="text-base font-medium">中枢没有在运行。家里人将无法新连接。</p>
			<p class="text-sm text-muted-foreground">回到终端运行 <code class="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">{START_CMD}</code>，再回来刷新确认。</p>
		</div>
		<div class="ml-auto flex gap-2">
			<Button variant="outline" size="sm" onclick={() => void cs.refreshHub()}>
				<RefreshCw data-icon="inline-start" />
				重探
			</Button>
			<Button size="sm" onclick={() => void copyStart()}>
				<Copy data-icon="inline-start" />
				启动中枢
			</Button>
		</div>
	</Card.Content>
</Card.Root>
