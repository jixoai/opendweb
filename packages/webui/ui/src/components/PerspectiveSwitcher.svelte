<script lang="ts">
	// 三视角切换器（home-hub [H5]/[H7] 组 B：顶栏最右的身份锚点）。
	// 当前视角名 + 下拉三项 + 各自徽章（中枢=敲门 n；租约=临期 n；到访无徽章）；
	// 一击切换、整页重渲、无确认（低后果：只是看的角度）。克制呈现：无头像化
	// 装饰，徽章只承载待办计数（PM §6 气质约定）。
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Building2, Check, ChevronDown, DoorOpen, Map } from "@lucide/svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import { PERSPECTIVE_LABEL, type Perspective } from "$lib/route";
	import { cn } from "$lib/utils";

	let open = $state(false);
	/** 下拉根节点（外点关闭）。 */
	let root = $state<HTMLDivElement | null>(null);

	const items: { id: Perspective; icon: typeof Building2; badge: () => number | null; badgeTitle: string }[] = [
		{ id: "hub", icon: Building2, badge: () => (cs.role === "admin" ? cs.knocksPending : null), badgeTitle: "有设备在敲门，等待处置" },
		{ id: "lease", icon: DoorOpen, badge: () => (cs.leaseExpiringCount > 0 ? cs.leaseExpiringCount : null), badgeTitle: "有租约 7 天内到期" },
		{ id: "visits", icon: Map, badge: () => null, badgeTitle: "" },
	];

	function switchTo(p: Perspective): void {
		open = false;
		cs.switchPerspective(p);
	}

	function onWindowPointerDown(e: PointerEvent): void {
		if (open && root !== null && !root.contains(e.target as Node)) open = false;
	}
	function onWindowKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape" && open) open = false;
	}
	$effect(() => {
		window.addEventListener("pointerdown", onWindowPointerDown, { capture: true });
		window.addEventListener("keydown", onWindowKeydown);
		return () => {
			window.removeEventListener("pointerdown", onWindowPointerDown, { capture: true } as EventListenerOptions);
			window.removeEventListener("keydown", onWindowKeydown);
		};
	});
</script>

<div class="relative" bind:this={root} data-perspective={cs.perspective}>
	{#if cs.role === "member"}
		<!-- member 姿态：两个目的地的分段控件（D4 2026-10-02——下拉穿着账户菜单
		     的外衣，诚实形态是页面切换） -->
		<div class="flex items-center rounded-md border p-0.5" role="tablist" aria-label="切换视角">
			{#each items.filter((i) => i.id !== "hub") as item (item.id)}
				<button
					type="button"
					role="tab"
					aria-selected={cs.perspective === item.id}
					class={cn(
						"flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-sm transition-colors",
						cs.perspective === item.id
							? "bg-accent font-medium text-accent-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
					onclick={() => switchTo(item.id)}
				>
					<item.icon class="size-4 shrink-0" aria-hidden="true" />
					{PERSPECTIVE_LABEL[item.id]}
					{#if item.badge() !== null && item.badge()! > 0}
						<Badge variant="outline" class="border-warning/40 bg-warning/10 text-warning" title={item.badgeTitle}>
							{item.badge()}
						</Badge>
					{/if}
				</button>
			{/each}
		</div>
	{:else}
		<Button variant="outline" size="sm" aria-haspopup="listbox" aria-expanded={open} onclick={() => (open = !open)} title="切换视角">
			<span class="text-sm">{PERSPECTIVE_LABEL[cs.perspective]}</span>
			<ChevronDown data-icon="inline-end" class="text-muted-foreground" />
		</Button>
		{#if open}
			<div
				role="listbox"
				aria-label="切换视角"
				class="absolute right-0 z-30 mt-1.5 flex w-52 flex-col gap-0.5 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
			>
				{#each items as item (item.id)}
					<button
						type="button"
						role="option"
						aria-selected={cs.perspective === item.id}
						class={cn(
							"flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-sm transition-colors",
							cs.perspective === item.id
								? "bg-accent font-medium text-accent-foreground"
								: "hover:bg-accent/60",
						)}
						onclick={() => switchTo(item.id)}
					>
						<item.icon class="size-4 shrink-0 text-muted-foreground" />
						<span>{PERSPECTIVE_LABEL[item.id]}</span>
						{#if item.badge() !== null && item.badge()! > 0}
							<Badge variant="outline" class="ml-auto border-warning/40 bg-warning/10 text-warning" title={item.badgeTitle}>
								{item.badge()}
							</Badge>
						{:else if cs.perspective === item.id}
							<Check class="ml-auto size-4 text-muted-foreground" />
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	{/if}
</div>
