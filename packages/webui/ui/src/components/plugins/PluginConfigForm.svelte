<script lang="ts">
	// 插件配置表单（webui-plugin-kernel Phase 0）——服务端 configSchema 驱动的
	// 通用 renderer（string→输入框 / number→数字输入 / boolean→复选）。值改动进
	// store 草稿（pluginConfigDraft），保存=PUT /sidecar/plugins/<id>/config（服务
	// 端二次校验：未知键/类型不符/缺 required 一律 400）。空 schema=诚实占位
	// （配置面随插件运行时在后续 Phase 接入——Phase 0 三插件均无配置项）。
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import { Label } from "$lib/components/ui/label";
	import { toast } from "svelte-sonner";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { WebuiPluginEntry } from "$lib/api";

	let { plugin }: { plugin: WebuiPluginEntry } = $props();

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
	<p class="text-sm text-muted-foreground">暂无可配置项——配置面随插件运行时（后续版本）接入。</p>
{:else if draft === undefined}
	<p class="text-sm text-muted-foreground">正在载入配置…</p>
{:else}
	<div class="flex flex-col gap-4">
		{#each entries as [key, def] (key)}
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
						{key}{plugin.config_schema.required?.includes(key) ? " *" : ""}
					</label>
				{:else}
					<Label for={`cfg-${plugin.id}-${key}`}>{key}{plugin.config_schema.required?.includes(key) ? " *" : ""}</Label>
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
						class="max-w-sm font-mono text-sm"
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
