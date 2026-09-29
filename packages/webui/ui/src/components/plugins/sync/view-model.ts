// sync 插件 UI view-model（webui-plugin-kernel Phase 3——packages/webui/ui/src/
// components/plugins/sync/）。
// 意图（2026-09-29）：
// 1. 组件不直接 fetch（文件面纪律）：三页面组件=纯 props 契约（数据+回调），
//    数据装配/动作转发由编排者接线层（sidecar 动作/存 store）完成。
// 2. 本文件零 Svelte 导入——node --test 类型剥离直测（plugin-registry.ts 同
//    纪律）；类型=engine/runtime 投影的 UI 侧形状。
// 3. seed 阻断三方对照（[W9]：A 内容/B 现状/空基线）与 hunk 三栏对照的纯
//    格式化都在这里——组件只渲染。

// ---- 类型面（engine 投影 → UI） ------------------------------------------------

export type SyncMode = "oneway" | "twoway";

export interface SyncMemberView {
	endpointId: string;
	deviceName: string;
}

export interface SyncRootView {
	id: string;
	localPath: string;
	mode: SyncMode;
	seedAuthority: string | null;
	isSeedAuthority: boolean;
	groupRef: string | null;
	deviceRef: string | null;
	seedBlock: boolean;
	hasConflicts: boolean;
}

export interface GroupView {
	id: string;
	name: string;
	members: SyncMemberView[];
	roots: SyncRootView[];
	self: SyncMemberView;
}

/** 建组草稿（GroupsPage 表单 → onCreateGroup 回调载荷）。
 * seedAuthority 约定：`"self"`（接线层解析为本端 endpointId）或对端 endpointId
 * hex——[W9] 初始权威端必须显式选择。 */
export interface GroupDraft {
	id?: string;
	name: string;
	peerEndpointId: string;
	peerDeviceName: string;
	roots: Array<{ localPath: string; mode: SyncMode; seedAuthority: string }>;
}

export interface JobView {
	groupId: string;
	rootId: string;
	phase: "idle" | "scanning" | "fetching" | "merging" | "conflicted" | "pushing" | "done" | "error";
	error: { code: string; message: string; hint?: string } | null;
	progress: { fetched: number; fetchTotal: number; bytes: number };
	updatedAt: number;
}

export interface SeedBlockEntry {
	path: string;
	oid: string;
	mode: string;
}

export interface SeedBlockView {
	groupId: string;
	rootId: string;
	seedCommit: string;
	threeWay: {
		base: { label: string; entries: SeedBlockEntry[] };
		seed: { label: string; entries: SeedBlockEntry[] };
		local: { label: string; entries: SeedBlockEntry[] };
	};
}

export interface MergeHunkView {
	a: string[];
	o: string[];
	b: string[];
	aIndex: number;
	oIndex: number;
	bIndex: number;
}

export interface ConflictEntryView {
	id: string;
	path: string;
	level: "hunk" | "file";
	kind: "text" | "binary" | "utf8" | "size" | "delete-modify" | "type" | "mode" | "add-add";
	base: { oid: string; mode: string } | null;
	ours: { oid: string; mode: string } | null;
	theirs: { oid: string; mode: string } | null;
	hunks: MergeHunkView[];
	detail: string | null;
	resolution: unknown;
}

export interface ConflictSessionView {
	algoVersion: string;
	baseCommit: string;
	oursCommit: string;
	theirsCommit: string;
	oursEndpoint: string;
	conflicts: ConflictEntryView[];
	resolvedAt?: string;
}

/** 冲突页提交载荷（path → 决议——engine.resolveConflicts 输入形状） */
export type ConflictDecisions = Record<
	string,
	| { level: "hunk"; choices: Array<{ hunkIndex: number; choice: "ours" | "theirs" | "edit"; text?: string }> }
	| { level: "file"; choice: "ours" | "theirs" | "edit" | "delete"; contentBase64?: string; mode?: string }
>;

// ---- 纯格式化 -----------------------------------------------------------------

const PHASE_LABELS: Record<JobView["phase"], string> = {
	idle: "空闲",
	scanning: "扫描本地",
	fetching: "拉取对端",
	merging: "三方合并",
	conflicted: "待决议",
	pushing: "推送中",
	done: "已完成",
	error: "失败",
};

export function phaseLabel(phase: JobView["phase"]): string {
	return PHASE_LABELS[phase] ?? phase;
}

/** 状态徽章色调（Phase 机器的稳定呈现——StatusPage/GroupsPage 共用） */
export function phaseTone(phase: JobView["phase"]): string {
	if (phase === "done") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
	if (phase === "error" || phase === "conflicted") return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400";
	if (phase === "idle") return "border-muted-foreground/30 bg-muted text-muted-foreground";
	return "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400";
}

export function modeLabel(mode: SyncMode): string {
	return mode === "oneway" ? "单向（只读镜像）" : "双向（自动合并）";
}

const CONFLICT_KIND_LABELS: Record<ConflictEntryView["kind"], string> = {
	text: "文本重叠",
	binary: "二进制",
	utf8: "非 UTF-8",
	size: "超限",
	"delete-modify": "删除对修改",
	type: "类型（文件对目录）",
	mode: "权限位竞争",
	"add-add": "双方新增",
};

export function conflictKindLabel(kind: ConflictEntryView["kind"]): string {
	return CONFLICT_KIND_LABELS[kind] ?? kind;
}

/** 拉取进度百分比（无总量的相位显示 50% 语义——由渲染层兜底） */
export function progressPercent(progress: JobView["progress"]): number | null {
	if (progress.fetchTotal <= 0) return null;
	return Math.min(100, Math.round((progress.fetched / progress.fetchTotal) * 100));
}

/**
 * seed 阻断三方对照分类（[W9]：A 内容/B 现状/空基线 → 仅 A/仅 B/两方都有但不同/
 * 一致——四桶展示，用户显式处置的对照面）。
 */
export function classifySeedThreeWay(
	block: Pick<SeedBlockView, "threeWay">,
): Array<{ path: string; bucket: "seed-only" | "local-only" | "differs" | "same"; seed?: SeedBlockEntry; local?: SeedBlockEntry }> {
	const seed = new Map(block.threeWay.seed.entries.map((e) => [e.path, e]));
	const local = new Map(block.threeWay.local.entries.map((e) => [e.path, e]));
	const paths = new Set([...seed.keys(), ...local.keys()]);
	return [...paths].sort().map((path) => {
		const s = seed.get(path);
		const l = local.get(path);
		if (s !== undefined && l === undefined) return { path, bucket: "seed-only", seed: s };
		if (l !== undefined && s === undefined) return { path, bucket: "local-only", local: l };
		if (s!.oid === l!.oid) return { path, bucket: "same", seed: s, local: l };
		return { path, bucket: "differs", seed: s, local: l };
	});
}

/** 冲突默认决议状态（UI 初值：hunk 逐块 ours/文件级未选——绝不默认静默取舍）。 */
export function emptyHunkChoices(hunks: MergeHunkView[]): Array<{ hunkIndex: number; choice: "ours" | "theirs" | "edit"; text?: string }> {
	return hunks.map((_, i) => ({ hunkIndex: i, choice: "ours" }));
}

/** 校验提交前的决议完整性（有未决则返回缺失路径列表——提交按钮禁用判据）。 */
export function missingDecisions(
	session: ConflictSessionView,
	decisions: ConflictDecisions,
): string[] {
	const missing: string[] = [];
	for (const c of session.conflicts) {
		if (c.resolution !== null && c.resolution !== undefined) continue;
		const d = decisions[c.path];
		if (d === undefined) {
			missing.push(c.path);
			continue;
		}
		if (d.level === "hunk") {
			const need = c.hunks.length;
			const got = new Set(d.choices.map((x) => x.hunkIndex));
			if (got.size < need) missing.push(c.path);
			for (const ch of d.choices) if (ch.choice === "edit" && typeof ch.text !== "string") missing.push(c.path);
		} else if (d.choice === "edit" && typeof d.contentBase64 !== "string") {
			missing.push(c.path);
		}
	}
	return [...new Set(missing)];
}

/** 字节格式化（进度/预算展示）。 */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
