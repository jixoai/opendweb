<script lang="ts">
	// 顶栏健康灯（§4.2：常驻四态；由 5s 轮询驱动，切页不消失）。
	// 2026-10-03：顶栏为恒深色终端条（jixoai 法则）——文案一律 terminal 前景，
	// 状态由色点承载（ok 绿 / bad 暖红 / pending 脉冲灰）。
	import { healthCopy } from "$lib/copy";
	import type { AdminError } from "$lib/api";
	import { cn } from "$lib/utils";

	let {
		error,
		loading = false,
	}: { error: AdminError | null; loading?: boolean } = $props();

	const state = $derived(
		loading ? { tone: "pending" as const, label: "正在连接服务器…" } : healthCopy(error),
	);
</script>

<span
	class={cn(
		"inline-flex items-center gap-2 rounded-full border border-terminal-foreground/25 px-3 py-1 text-[13px] font-medium",
		state.tone === "ok" && "text-terminal-foreground",
		state.tone === "pending" && "text-terminal-muted",
		state.tone === "bad" && "text-terminal-foreground",
	)}
	role="status"
	title={state.label}
>
	<span
		aria-hidden="true"
		class={cn(
			"size-2 rounded-full",
			state.tone === "ok" && "bg-emerald-400",
			state.tone === "pending" && "animate-pulse bg-terminal-muted",
			state.tone === "bad" && "bg-red-400",
		)}
	></span>
	{state.label}
</span>
