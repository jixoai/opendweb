<script lang="ts">
	// sync 状态页绑定层：store sync jobs（/sidecar/plugins/sync/status）→
	// StatusPage props（JobView 同构直投；重试=手动 syncNow）。
	import { untrack } from "svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { JobView } from "../sync/view-model";
	import StatusPage from "../sync/StatusPage.svelte";

	$effect(() => {
		untrack(() => void cs.refreshSync());
	});

	const jobs = $derived<JobView[]>(cs.syncJobs);
</script>

<StatusPage
	{jobs}
	loading={cs.syncGroups === null}
	error={cs.syncError}
	onRetry={(groupId) => void cs.syncNowAction(groupId)}
	onRefresh={() => void cs.refreshSync()}
/>
