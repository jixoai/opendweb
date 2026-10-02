<script lang="ts">
	// 接入卡片卡（home-hub 2c [H1] + D4 极简收束 2026-10-02）：分享主卡——
	// 短码是首要分享方式（电话里念给对方），二维码与三步引导在展开区。
	// 默认收起=题+短码+地址一行（视觉审计：IPv6 长串与 CLI 脚注全部收起；
	// 「邀请码不在此卡/地址变了重新出示」两条脚注删——挪帮助层语义）。
	// 卡片无凭证——数据即 GET /sidecar/hub 投影（与 `opendweb hub card` 同源）。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { ChevronDown, Copy, QrCode } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { consoleStore as cs } from "$lib/console.svelte";

	let collapsed = $state(true);

	async function copy(text: string, what: string): Promise<void> {
		if (await cs.copyText(text)) toast.success(`${what}已复制`);
		else toast.error(`复制失败——请手动选择复制`);
	}
</script>

{#if cs.hubData !== null}
	<Card.Root class="gap-4 py-5" data-card="hub-access">
		<Card.Header class="flex flex-row items-center gap-2">
			<QrCode class="size-4 text-muted-foreground" />
			<Card.Title class="text-base">家里人怎么连</Card.Title>
			<Button
				variant="ghost"
				size="sm"
				class="ml-auto h-7"
				onclick={() => (collapsed = !collapsed)}
				aria-expanded={!collapsed}
			>
				<ChevronDown
					data-icon="inline-end"
					class={collapsed ? "transition-transform" : "rotate-180 transition-transform"}
				/>
				{collapsed ? "展开" : "折叠"}
			</Button>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if collapsed}
				<!-- 收起态（默认）：短码优先 + 地址一行 -->
				<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
					<div class="flex items-center gap-2">
						<span class="text-sm text-muted-foreground">短码</span>
						<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[15px] font-semibold tracking-wide">{cs.hubData.short_code}</code>
						<Button
							variant="ghost"
							size="sm"
							class="size-6 p-0"
							onclick={() => void copy(cs.hubData!.short_code, "短码")}
							title="复制短码"
							aria-label="复制短码"
						>
							<Copy class="size-3.5" />
						</Button>
					</div>
					<Badge variant="secondary" class="text-xs">电话里念给对方，等于地址</Badge>
				</div>
			{:else}
				<div class="flex flex-wrap items-start gap-6">
					<!-- 二维码（视觉主角）：SVG 由 sidecar 经同一 qrMatrix 生成 -->
					<div
						class="size-[148px] shrink-0 rounded-md border bg-white p-2"
						aria-label="接入二维码（扫码得到地址）"
						role="img"
					>
						{@html cs.hubData.qr_svg}
					</div>
					<dl class="flex min-w-64 flex-1 flex-col gap-2.5 text-sm">
						<div class="flex items-baseline gap-3">
							<dt class="w-16 shrink-0 text-muted-foreground">中枢</dt>
							<dd class="font-medium">{cs.hubData.machine}</dd>
						</div>
						<div class="flex items-baseline gap-3">
							<dt class="w-16 shrink-0 text-muted-foreground">地址</dt>
							<dd class="flex flex-wrap items-center gap-2">
								<span class="font-mono text-[13px]">{cs.hubData.primary_url}</span>
								<Button
									variant="ghost"
									size="sm"
									class="size-6 p-0"
									onclick={() => void copy(cs.hubData!.primary_url, "地址")}
									title="复制地址"
									aria-label="复制地址"
								>
									<Copy class="size-3.5" />
								</Button>
							</dd>
						</div>
						<div class="flex items-baseline gap-3">
							<dt class="w-16 shrink-0 text-muted-foreground">短码</dt>
							<dd class="flex flex-wrap items-center gap-2">
								<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[15px] font-semibold tracking-wide">{cs.hubData.short_code}</code>
								<Button
									variant="ghost"
									size="sm"
									class="size-6 p-0"
									onclick={() => void copy(cs.hubData!.short_code, "短码")}
									title="复制短码"
									aria-label="复制短码"
								>
									<Copy class="size-3.5" />
								</Button>
							</dd>
						</div>
					</dl>
				</div>
				{#if cs.hubData.urls.length > 1}
					<details class="group text-sm">
						<summary class="inline-flex cursor-pointer select-none list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
							更多地址（{cs.hubData.urls.length - 1}）
							<ChevronDown class="size-3 transition-transform group-open:rotate-180" />
						</summary>
						<div class="mt-1.5 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
							{#each cs.hubData.urls.slice(1) as u (u)}
								<span class="flex items-center gap-1.5">
									{u}
									<button
										type="button"
										class="text-foreground/70 hover:text-foreground"
										onclick={() => void copy(u, "地址")}
										aria-label="复制这个地址"
									>
										<Copy class="size-3" />
									</button>
								</span>
							{/each}
						</div>
					</details>
				{/if}
				<div class="rounded-md border border-dashed p-4 text-sm leading-relaxed">
					<p class="font-medium">家里人的三步：</p>
					<ol class="mt-1.5 list-decimal space-y-1 pl-5 text-muted-foreground">
						<li>装 opendweb</li>
						<li>扫二维码 / 输短码 / 手动填地址，连上中枢</li>
						<li>等放行——家长在中枢管理台点「定位为访客」；要自己的房间，就找家长拿邀请码注册成租户</li>
					</ol>
					<p class="mt-3 text-xs text-muted-foreground">邀请码不放在卡片上——要发给谁，去 租户管理 → 邀请码 单独签发。</p>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
