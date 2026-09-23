<script lang="ts">
	// member 态的「我的中枢」落点（home-hub：无管理凭证设备切到中枢视角的诚实
	// 页——零 admin 概念、不虚构状态）。默认视角永不落这里（按数据自动选择），
	// 只在显式切换/深链时呈现。
	import * as Card from "$lib/components/ui/card";
	import * as Empty from "$lib/components/ui/empty";
	import { Building2 } from "@lucide/svelte";
</script>

<section class="flex flex-col gap-5" data-view="no-hub">
	<div class="flex flex-col gap-1">
		<h2 class="text-lg font-semibold tracking-tight">我的中枢</h2>
		<p class="text-sm text-muted-foreground">这台设备与网络的关系。</p>
	</div>
	<Empty.Root class="border border-dashed">
		<Empty.Header>
			<Empty.Media variant="icon"><Building2 /></Empty.Media>
			<Empty.Title>这台设备不是中枢。</Empty.Title>
			<Empty.Description>
				它加入过的网络在「我的租约」、到访过的楼在「我的到访」。要把一台常开的机器变成家里的中枢，回到终端在那台机器上运行 opendweb hub init。
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
</section>
