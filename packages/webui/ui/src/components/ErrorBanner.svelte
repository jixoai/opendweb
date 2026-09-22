<script lang="ts">
	// 单一错误横幅（每视图至多一个——无错误风暴；unauthorized 不给重试）。
	import * as Alert from "$lib/components/ui/alert";
	import { Button } from "$lib/components/ui/button";
	import { CircleAlert, RotateCcw } from "@lucide/svelte";
	import { errorCopy } from "$lib/copy";
	import type { AdminError } from "$lib/api";

	let {
		error,
		onRetry,
		class: cls,
	}: { error: AdminError; onRetry?: () => void; class?: string } = $props();

	const copy = $derived(errorCopy(error));
</script>

<Alert.Root variant="destructive" class={cls}>
	<CircleAlert />
	<Alert.Title>{copy.title}</Alert.Title>
	<Alert.Description class="flex flex-col items-start gap-2">
		<span>{copy.detail}</span>
		{#if copy.retry && onRetry}
			<Button variant="outline" size="sm" class="mt-1" onclick={onRetry}>
				<RotateCcw data-icon="inline-start" />
				重试
			</Button>
		{/if}
	</Alert.Description>
</Alert.Root>
