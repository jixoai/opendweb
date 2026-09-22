<script lang="ts">
	// 变更回执卡片（冻结契约：op/ts/generation/签名摘要 + 复制全文；§5.1 呈现
	// 裁决：签名降级为「审计签名」次级字段 + 「已含服务端签名」说明行）。
	import * as Card from "$lib/components/ui/card";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Copy } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import type { Receipt } from "$lib/api";
	import { OP_LABEL } from "$lib/terms";
	import { formatTime } from "$lib/format";
	import { sigPrefixHex } from "$lib/hex";
	import { consoleStore } from "$lib/console.svelte";
	import HexValue from "./HexValue.svelte";

	let { receipt }: { receipt: Receipt } = $props();

	const op = $derived(typeof receipt.op === "string" ? receipt.op : "unknown");
	const target = $derived(op === "disconnect" ? receipt.endpoint_id : receipt.fabric_id);
	const targetKind = $derived(op === "disconnect" ? "端点" : "Fabric");

	async function copyFull(): Promise<void> {
		const ok = await consoleStore.copyReceipt(receipt);
		if (ok) toast.success("已复制回执全文");
	}
</script>

<Card.Root class="gap-4 py-4" data-op={op}>
	<Card.Header class="flex flex-row flex-wrap items-center gap-2">
		<Badge variant="secondary" title={`op: ${op}`}>{OP_LABEL[op] ?? op}</Badge>
		<span class="text-xs text-muted-foreground">已含服务端签名</span>
		<Button variant="outline" size="sm" class="ml-auto" type="button" onclick={copyFull}>
			<Copy data-icon="inline-start" />
			复制全文
		</Button>
	</Card.Header>
	<Card.Content>
		<dl class="grid grid-cols-[120px_1fr] items-baseline gap-x-4 gap-y-2 text-sm">
			<dt class="text-muted-foreground">时间</dt>
			<dd>{formatTime(receipt.ts)}</dd>
			<dt class="text-muted-foreground">名册版本</dt>
			<dd class="font-mono" title="每次租户名册变更后加 1，用于确认变更已生效">
				v{receipt.generation ?? "-"}
			</dd>
			<dt class="text-muted-foreground">目标</dt>
			<dd>
				<HexValue value={target ?? ""} kind={targetKind} />
			</dd>
			<dt class="text-muted-foreground">审计签名</dt>
			<dd class="truncate font-mono text-xs text-muted-foreground" title="完整签名可复制全文获取">
				{sigPrefixHex(receipt.receipt_sig) || "-"}…
			</dd>
			{#if typeof receipt.kicked_connections === "number"}
				<dt class="text-muted-foreground">一并断开的连接</dt>
				<dd class="font-mono">{receipt.kicked_connections} 条</dd>
			{/if}
		</dl>
	</Card.Content>
</Card.Root>
