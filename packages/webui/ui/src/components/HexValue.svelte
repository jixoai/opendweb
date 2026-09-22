<script lang="ts">
	// key 呈现原子件（server-access-roles key 显示规范）：`别名 (abc***xyz)`
	// （缩写 = 首3***尾3）；title 悬停全文；复制全文（完整 64 hex，不是缩写）。
	// 无别名时仅 `(abc***xyz)`。操作面（注册/导入表单）不经过本件——那里保留
	// 完整 64 hex 输入与校验。
	import { Copy, Check } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { displayKey, shortHex } from "$lib/hex";
	import { consoleStore } from "$lib/console.svelte";
	import { cn } from "$lib/utils";

	let {
		value,
		alias = null,
		kind = "值",
		class: cls,
	}: { value: string; alias?: string | null; kind?: string; class?: string } = $props();

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

<span class={cn("inline-flex items-center gap-1", cls)} title={value}>
	<span class="font-mono text-[13px] tracking-tight">{displayKey(value, alias)}</span>
	<button
		type="button"
		class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
		title={`复制完整${kind}（${shortHex(value)} 是缩写，复制得到的是完整 64 位字符）`}
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
