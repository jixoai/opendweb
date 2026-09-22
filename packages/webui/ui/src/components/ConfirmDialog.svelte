<script lang="ts">
	// 确认对话（AlertDialog；「先不了」是无压力选项——知情前置在正文）。
	// 正文由调用方以 snippet 传入（范围 / 异步性 / 恢复路径逐项披露）。
	import * as AlertDialog from "$lib/components/ui/alert-dialog";
	import type { Snippet } from "svelte";

	let {
		open = false,
		title,
		children,
		confirmLabel = "确认",
		cancelLabel = "先不了",
		onconfirm,
		oncancel,
	}: {
		open?: boolean;
		title: string;
		children: Snippet;
		confirmLabel?: string;
		cancelLabel?: string;
		onconfirm: () => void;
		oncancel?: () => void;
	} = $props();
</script>

<AlertDialog.Root
	{open}
	onOpenChange={(v) => {
		if (!v) oncancel?.();
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description class="sr-only">{title}</AlertDialog.Description>
		</AlertDialog.Header>
		<div class="flex flex-col gap-2 text-sm text-muted-foreground">
			{@render children()}
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{cancelLabel}</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={onconfirm}>{confirmLabel}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
