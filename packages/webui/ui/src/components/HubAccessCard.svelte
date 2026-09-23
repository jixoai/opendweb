<script lang="ts">
	// 接入卡片卡（home-hub 2c [H1]：中枢视角·总览置顶、可折叠、常驻）。
	// 「家里人怎么连」：中枢名（机器名）+ 地址 + 短码 + 二维码（SVG——与 CLI 终端
	// ASCII 同一矩阵生成）+ 三步引导；附注「邀请码不放在卡片上」。卡片无凭证
	// （O-8 实现默认）——数据即 GET /sidecar/hub 投影（与 `opendweb hub card`
	// 同一数据源与生成函数）。折叠态只留题 + 地址一行（PM §5.2）。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { ChevronDown, Copy, QrCode } from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { consoleStore as cs } from "$lib/console.svelte";

	let collapsed = $state(false);

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
			{#if !collapsed}
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
						{#if cs.hubData.urls.length > 1}
							<div class="flex items-baseline gap-3">
								<dt class="w-16 shrink-0 text-muted-foreground"></dt>
								<dd class="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
									{#each cs.hubData.urls.slice(1) as u (u)}
										<span>{u}</span>
									{/each}
								</dd>
							</div>
						{/if}
						<div class="flex items-baseline gap-3">
							<dt class="w-16 shrink-0 text-muted-foreground">短码</dt>
							<dd class="flex flex-wrap items-center gap-2">
								<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[15px] font-semibold tracking-wide">{cs.hubData.short_code}</code>
								<Badge variant="secondary" class="text-xs">电话里念给对方，等于上面的地址</Badge>
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
				<div class="rounded-md border border-dashed p-4 text-sm leading-relaxed">
					<p class="font-medium">家里人的三步：</p>
					<ol class="mt-1.5 list-decimal space-y-1 pl-5 text-muted-foreground">
						<li>装 opendweb</li>
						<li>扫二维码 / 输短码 / 手动填地址，连上中枢</li>
						<li>等放行——家长在中枢管理台点「定位为访客」；要自己的房间，就找家长拿邀请码注册成租户</li>
					</ol>
					<p class="mt-3 text-xs text-muted-foreground">
						邀请码不放在卡片上——要发给谁，去 租户管理 → 邀请码 单独签发。
					</p>
					<p class="mt-1 text-xs text-muted-foreground">地址变了重新出示：终端运行 opendweb hub card，这里的卡片同步更新（同一数据源）。</p>
				</div>
			{:else}
				<!-- 折叠态：只留题 + 地址一行 -->
				<p class="font-mono text-[13px] text-muted-foreground">{cs.hubData.primary_url}</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
