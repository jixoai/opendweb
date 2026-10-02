<script lang="ts">
	// 统一页头（D4 极简收束 2026-10-02）：题 + 至多一句 hint + 可选「这是什么？」
	// 帮助层（原生 details——零依赖、键盘可达）。纪律：帮助层是协议术语/架构
	// 说明/安全声明的**唯一常驻处**（全站安全声明 ≤1 处）；页面正文只说家庭
	// 语言。题右侧留 actions 槽（页级主动作）。
	import { ChevronDown } from "@lucide/svelte";

	let {
		title,
		hint = undefined,
		help = false,
	}: {
		title: string;
		/** 至多一句的家庭语言 hint；公式腔副标题一律不写。 */
		hint?: string;
		/** 是否渲染帮助层（内容经 slot 提供）。 */
		help?: boolean;
	} = $props();
</script>

<div class="flex flex-col gap-1" data-page-header>
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
		<h2 class="text-lg font-semibold tracking-tight">{title}</h2>
		{#if help}
			<details class="group text-sm">
				<summary
					class="inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent [&::-webkit-details-marker]:hidden"
				>
					这是什么？
					<ChevronDown class="size-3 transition-transform group-open:rotate-180" />
				</summary>
				<div
					class="mt-2 max-w-2xl rounded-lg border bg-muted/40 p-3.5 text-sm leading-relaxed text-muted-foreground"
					data-help
				>
					<slot name="help" />
				</div>
			</details>
		{/if}
		<div class="ml-auto flex items-center gap-2">
			<slot name="actions" />
		</div>
	</div>
	{#if hint !== undefined}
		<p class="text-sm text-muted-foreground">{hint}</p>
	{/if}
</div>
