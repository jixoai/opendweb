<script lang="ts">
	// sync 冲突页绑定层：store 的冲突会话装配（/sidecar/plugins/sync/conflicts?
	// group=&root=，仅 hasConflicts 的 root）→ ConflictPage props。决议上抛
	// store（POST …/resolve——引擎 hunk 逐块/文件级整选/编辑后内容）。
	import { untrack } from "svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { ConflictSessionView } from "../sync/view-model";
	import ConflictPage from "../sync/ConflictPage.svelte";

	$effect(() => {
		untrack(() => void cs.refreshSync());
	});

	const sessions = $derived(
		(cs.syncConflictSessions ?? []).map((s) => ({
			groupId: s.groupId,
			rootId: s.rootId,
			session: (s.session as ConflictSessionView | null) ?? null,
		})),
	);
</script>

<ConflictPage
	{sessions}
	loading={cs.syncGroups === null}
	error={cs.syncError}
	onSubmit={(groupId, rootId, decisions) => void cs.resolveSyncConflictsAction(groupId, rootId, decisions)}
	onRefresh={() => void cs.refreshSync()}
/>
