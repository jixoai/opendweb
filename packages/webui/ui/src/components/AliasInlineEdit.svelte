<script lang="ts">
	// 别名行内编辑（server-access-roles Phase 1c 接线，PM §4.5 流 E）：行 hover
	// 显编辑入口 → 行内输入（≤32 UTF-8 字节实时校验，纯函数 aliasEditError）→
	// 保存即 PATCH owner-meta/visitor-meta；空串提交=清除别名（经视图级确认弹窗
	// 二次确认，aliasClearConfirm 承载）。失败保留编辑态，错误走名册既有
	// ErrorBanner（ownersError/visitorsError）。无别名行 hover 显「设别名」，
	// 行高稳定（占位透明，仅行 hover 可见）。
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Check, LoaderCircle, PencilLine, X } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { aliasTargetKey } from "$lib/terms";
	import { consoleStore as cs } from "$lib/console.svelte";

	let {
		kind,
		fabricId = "",
		root = "",
		endpointId = "",
		current = null,
	}: {
		kind: "owner" | "visitor";
		/** owner 行定位（二元组，防 fabric 单显钓鱼）；visitor 行为 endpoint_id。 */
		fabricId?: string;
		root?: string;
		endpointId?: string;
		current?: string | null;
	} = $props();

	const key = $derived(aliasTargetKey({ kind, fabricId, root, endpointId }));
	const editing = $derived(cs.aliasEdit !== null && aliasTargetKey(cs.aliasEdit) === key);
	const value = $derived(editing && cs.aliasEdit !== null ? cs.aliasEdit.value : "");
	const shown = $derived(typeof current === "string" ? current.trim() : "");

	let inputEl: HTMLElement | null = $state(null);

	// 进入编辑态即聚焦输入框（Input 的 ref bindable 指向内部 input 元素）
	$effect(() => {
		if (editing) inputEl?.focus();
	});

	async function save(): Promise<void> {
		const res = await cs.submitAliasEdit();
		if (res !== null && res.ok) toast.success("别名已保存");
	}
</script>

{#if editing}
	<!-- 编辑态：Enter 提交、Esc 取消；超限实时报错并禁提交（空串保存=清除，走确认弹窗） -->
	<form
		class="flex flex-wrap items-center gap-1.5"
		data-alias-edit={key}
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<Input
			bind:ref={inputEl}
			class="h-7 w-44 text-sm"
			placeholder="给这个身份起个好认的名字（可选）"
			value={value}
			aria-invalid={cs.aliasEditError !== null}
			oninput={(e) => cs.onAliasEditInput(e.currentTarget.value)}
			onkeydown={(e) => {
				if (e.key === "Escape") cs.cancelAliasEdit();
			}}
		/>
		<Button
			type="submit"
			size="sm"
			class="h-7 gap-1 px-2.5"
			disabled={cs.aliasBusy || cs.aliasEditError !== null}
		>
			{#if cs.aliasBusy}
				<LoaderCircle data-icon="inline-start" class="animate-spin" />
				保存中…
			{:else}
				<Check data-icon="inline-start" class="size-3.5" />
				保存
			{/if}
		</Button>
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="h-7 gap-1 px-2.5"
			onclick={() => cs.cancelAliasEdit()}
		>
			<X data-icon="inline-start" class="size-3.5" />
			取消
		</Button>
	</form>
	{#if cs.aliasEditError !== null}
		<p class="text-xs text-destructive" role="alert" data-alias-error>{cs.aliasEditError}</p>
	{/if}
{:else}
	<!-- 静态态：别名（无别名时 hover 显占位）+ 行 hover 显编辑铅笔 -->
	<span class="inline-flex items-center gap-1">
		{#if shown !== ""}
			<span class="text-sm font-medium">{shown}</span>
		{:else}
			<span class="text-sm text-muted-foreground/70 opacity-0 transition-opacity group-hover/row:opacity-100">
				未设别名
			</span>
		{/if}
		<button
			type="button"
			class="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/row:opacity-100 focus-visible:opacity-100"
			title={shown !== "" ? "编辑别名（最长 32 字节；清空并保存即清除）" : "设置别名（最长 32 字节）"}
			aria-label={shown !== "" ? "编辑别名" : "设置别名"}
			data-alias-begin={key}
			onclick={() =>
				cs.beginAliasEdit(
					kind === "owner" ? { kind, fabricId, root } : { kind, endpointId },
					current,
				)}
		>
			<PencilLine class="size-3" />
		</button>
	</span>
{/if}
