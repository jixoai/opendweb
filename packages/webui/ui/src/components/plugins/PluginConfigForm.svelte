<script lang="ts">
	// 插件配置表单（webui-plugin-kernel Phase 0 + D4 2026-10-02）：服务端
	// configSchema 驱动的通用 renderer。工程键名一律映射为人类标签+单位
	//（视觉审计：把开发者配置文件贴进家庭 UI 是最大的 AI 味）；未映射键
	// 退回键名但保留等宽体。保存=PUT（服务端二次校验：未知键/类型不符/缺
	// required 一律 400）。空 schema=诚实占位。
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { toast } from "svelte-sonner";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { WebuiPluginEntry } from "$lib/api";

	let { plugin }: { plugin: WebuiPluginEntry } = $props();

	/** 工程键 → 人类标签（跨插件通用键；插件专属键按前缀归并） */
	const LABELS: Record<string, { label: string; unit?: string }> = {
		maxBodyMiB: { label: "单次传输上限", unit: "MB" },
		stagingTtlSeconds: { label: "暂存保留时长", unit: "秒" },
		intervalMs: { label: "扫描间隔", unit: "毫秒" },
		debounceMs: { label: "变更防抖", unit: "毫秒" },
		maxConcurrency: { label: "同时请求数" },
		dailyRequests: { label: "每日请求上限", unit: "次" },
		usageLog: { label: "记录用量日志" },
	};

	function labelOf(key: string): { label: string; unit?: string } {
		return LABELS[key] ?? { label: key };
	}

	const entries = $derived(Object.entries(plugin.config_schema?.properties ?? {}));
	const draft = $derived(cs.pluginConfigDraft[plugin.id]);
	const busy = $derived(cs.pluginConfigBusy === plugin.id);
	const dirty = $derived(draft !== undefined && JSON.stringify(draft) !== JSON.stringify(plugin.config));

	async function save() {
		if (!(await cs.savePluginConfig(plugin.id))) return;
		toast.success("插件配置已保存");
	}

	$effect(() => {
		// 进入即播种草稿（以服务端 config 为底；已有未保存草稿保留）
		cs.seedPluginConfigDraft(plugin);
	});
</script>

{#if entries.length === 0}
	<p class="text-sm text-muted-foreground">暂无可配置项。</p>
{:else if draft === undefined}
	<p class="text-sm text-muted-foreground">正在载入配置…</p>
{:else}
	<div class="flex flex-col gap-4">
		{#each entries as [key, def] (key)}
			{@const meta = labelOf(key)}
			<div class="flex flex-col gap-1.5">
				{#if def.type === "boolean"}
					<label class="flex items-center gap-2.5 text-sm" for={`cfg-${plugin.id}-${key}`}>
						<input
							id={`cfg-${plugin.id}-${key}`}
							type="checkbox"
							class="size-4 accent-foreground"
							checked={draft[key] === true}
							onchange={(e) => cs.setPluginConfigDraft(plugin.id, key, (e.target as HTMLInputElement).checked)}
							disabled={busy}
						/>
						{meta.label}{plugin.config_schema.required?.includes(key) ? " *" : ""}
					</label>
				{:else}
					<label class="text-sm" for={`cfg-${plugin.id}-${key}`}>
						{meta.label}{meta.unit !== undefined ? `（${meta.unit}）` : ""}{plugin.config_schema.required?.includes(key) ? " *" : ""}
					</label>
					<Input
						id={`cfg-${plugin.id}-${key}`}
						type={def.type === "number" ? "number" : "text"}
						value={String(draft[key] ?? "")}
						oninput={(e) =>
							cs.setPluginConfigDraft(
								plugin.id,
								key,
								def.type === "number" ? Number((e.target as HTMLInputElement).value) : (e.target as HTMLInputElement).value,
							)}
						disabled={busy}
						class="max-w-xs text-sm"
					/>
				{/if}
			</div>
		{/each}
		<div class="flex items-center gap-2">
			<Button size="sm" disabled={!dirty || busy} onclick={() => void save()}>
				{#if busy}保存中…{:else}保存配置{/if}
			</Button>
			{#if dirty}
				<Button size="sm" variant="ghost" disabled={busy} onclick={() => cs.cancelPluginConfigDraft(plugin.id)}>放弃更改</Button>
			{/if}
		</div>
	</div>
{/if}
