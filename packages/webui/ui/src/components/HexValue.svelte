<script lang="ts">
	// hex 浏览面原子件（§5.1 通则）：前 8 位缩写 + 悬停全文（title）+ 复制。
	// 操作面（注册表单）不经过本件——那里保留完整 64 hex 输入与校验。
	import { Copy, Check } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { shortHex } from "$lib/hex";
	import { consoleStore } from "$lib/console.svelte";
	import { cn } from "$lib/utils";

	let {
		value,
		kind = "值",
		class: cls,
	}: { value: string; kind?: string; class?: string } = $props();

	let copied = $state(false);

	async function copy(): Promise<void> {
		const ok = await consoleStore.copyText(value);
		if (ok) {
			copied = true;
			toast.success(`已复制完整${kind}`);
			setTimeout(() => (copied = false), 1_500);
		}
	}
</script>

<span class={cn("inline-flex items-center gap-1", cls)}>
	<span class="font-mono text-[13px] tracking-tight" title={value}>{shortHex(value)}</span>
	<button
		type="button"
		class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
		title={`复制完整${kind}`}
		aria-label={`复制完整${kind}`}
		onclick={copy}
	>
		{#if copied}
			<Check class="size-3.5 text-success" />
		{:else}
			<Copy class="size-3.5" />
		{/if}
	</button>
</span>
