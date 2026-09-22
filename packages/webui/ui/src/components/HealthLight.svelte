<script lang="ts">
	// 顶栏健康灯（§4.2：常驻四态；由 5s 轮询驱动，切页不消失）。
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
		"inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-medium",
		state.tone === "ok" && "border-success/30 bg-success/10 text-success",
		state.tone === "pending" && "border-border bg-muted text-muted-foreground",
		state.tone === "bad" && "border-destructive/30 bg-destructive/10 text-destructive",
	)}
	role="status"
	title={state.label}
>
	<span
		aria-hidden="true"
		class={cn(
			"size-2 rounded-full",
			state.tone === "ok" && "bg-success",
			state.tone === "pending" && "animate-pulse bg-muted-foreground",
			state.tone === "bad" && "bg-destructive",
		)}
	></span>
	{state.label}
</span>
