<script lang="ts">
	// sync 同步组页绑定层：store sync 面（/sidecar/plugins/sync/groups|seed-block）
	// → GroupsPage props。投影形状=runtime.listGroups（与 view-model GroupView
	// 同构——服务端直投，此处仅空态/类型归一）。建组草稿 seedAuthority "self"
	// 在服务端解析为本端 endpointId。
	import { untrack } from "svelte";
	import { consoleStore as cs } from "$lib/console.svelte";
	import type { GroupView, SeedBlockView } from "../sync/view-model";
	import GroupsPage from "../sync/GroupsPage.svelte";

	$effect(() => {
		untrack(() => void cs.refreshSync());
	});

	const groups = $derived<GroupView[] | null>(
		cs.syncGroups === null
			? null
			: cs.syncGroups.map((g) => ({
					id: g.id,
					name: g.name,
					members: g.members,
					roots: g.roots.map((r) => ({
						id: r.id,
						localPath: r.localPath,
						mode: r.mode,
						seedAuthority: r.seedAuthority,
						isSeedAuthority: r.isSeedAuthority,
						groupRef: r.groupRef,
						deviceRef: r.deviceRef,
						seedBlock: r.seedBlock,
						hasConflicts: r.hasConflicts,
					})),
					self: g.self,
				})),
	);

	const seedBlock = $derived(cs.syncSeedBlock === null ? null : (cs.syncSeedBlock.block as SeedBlockView | null));
</script>

<GroupsPage
	{groups}
	loading={cs.syncGroups === null}
	error={cs.syncError}
	{seedBlock}
	onCreateGroup={(draft) => void cs.createSyncGroupAction(draft)}
	onDeleteGroup={(groupId) => void cs.deleteSyncGroupAction(groupId)}
	onSyncNow={(groupId) => void cs.syncNowAction(groupId)}
	onResolveSeedBlock={(groupId, rootId) => void cs.resolveSyncSeedBlockAction(groupId, rootId)}
/>
