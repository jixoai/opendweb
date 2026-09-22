<script lang="ts">
	// 明文传输常驻告警（警告色非危险色；ready 且 insecure 目标——顶栏下全宽条）。
	import * as Alert from "$lib/components/ui/alert";
	import { TriangleAlert } from "@lucide/svelte";
</script>

<Alert.Root class="rounded-none border-x-0 border-t-0 border-warning/40 bg-warning/10">
	<TriangleAlert class="text-warning" />
	<Alert.Title class="text-warning">连接未加密</Alert.Title>
	<Alert.Description class="text-warning/90">
		当前目标经明文 http 连接（启动时使用了 --allow-insecure）：管理凭证与管理流量在传输中未加密。建议改用
		https 目标，或通过加密隧道访问。生产环境请务必消除此告警。
	</Alert.Description>
</Alert.Root>
