// 应用层响应式 store（app.mjs 副作用编排的 Svelte 5 runes 移植；
// server-access-roles Phase 2a/2b 扩展三角色 + 节点簿）。
// 纯函数在 ./api ./route ./format ./hex ./copy ./terms；本文件只做状态持有与
// 副作用编排（fetch/轮询/路由/剪贴板），组件只做渲染与状态绑定。
// 关键语义（冻结契约）：
// 1. 两个世界：phase=setup 一律全屏引导；ready 才进入管理台；旧 hash 收敛；
// 2. ready 态常驻轮询 /api/status 与 /api/connections（5s；页面隐藏暂停，
//    回前台即刷）；门禁页期间敲门列表同拍刷新（待办时效高于例行管理）；
// 3. 断连闭环：确认 → 已下发/收敛中（1s×15 有界观测）→ 已收敛/超时未确认，
//    全程同视图；no-match 刷新在线表供核对；
// 4. 业务数据调用只走 /api/*（→ /admin/*）；本地控制面仅 /sidecar/nodes*、
//    /sidecar/connect、/sidecar/state（路径契约，r2-P1-2）；
// 5. 安全契约：token/邀请码全文提交后即刻清空、绝不回显；剪贴板复制静默降级；
//    节点切换后全站缓存整体清空重拉（新楼的数据，不残留旧楼投影）。
import {
	AdminError,
	addBlocklist,
	addSidecarNode,
	deleteSidecarNode,
	disconnectByEndpoint,
	disconnectByFabric,
	dismissKnock,
	disableSidecarPlugin,
	enableSidecarPlugin,
	fetchSidecarHub,
	fetchSidecarLeases,
	fetchSidecarNodes,
	fetchSidecarPlugins,
	fetchSidecarState,
	fetchSidecarVisits,
	fetchSyncGroups,
	fetchSyncStatus,
	filesBridge,
	grantPortsAccess,
	grantVisitor,
	grantVisitorFromKnock,
	issueCode,
	loadBlocklist,
	loadCodes,
	loadConnections,
	loadKnocks,
	loadOwners,
	loadStatus,
	loadVisitors,
	startSidecarHub,
	patchOwnerMeta,
	patchSidecarLeaseLabel,
	patchVisitorMeta,
	postConnect,
	probeSidecarVisit,
	putSidecarPluginConfig,
	registerOwner,
	renewOwner,
	revokeCode,
	revokePortsAccess,
	revokeVisitor,
	switchSidecarNode,
	toAdminError,
	undismissKnock,
	unregisterOwner,
	type BlockEntry,
	type BlocklistData,
	type CodeEntry,
	type ConnectionsData,
	type FilesBridgeRequest,
	type FilesBridgeResponse,
	type FilesShareRow,
	type HubData,
	type KnockEntry,
	type LeaseEntry,
	type OwnersData,
	type PluginConfigValues,
	type PluginsData,
	type PortsAllowEntry,
	type PortsMappingRow,
	type Receipt,
	type SidecarNode,
	type SidecarState,
	type StatusData,
	type SyncGroupDraft,
	type SyncGroupRow,
	type SyncJobRow,
	type VisitEntry,
	type VisitorEntry,
	type WebuiPluginEntry,
	createFilesShare,
	createPortsMapping,
	createSyncGroup,
	deleteFilesShare,
	deletePortsMapping,
	deleteSyncGroup,
	fetchFilesShares,
	fetchPortsAllowlist,
	fetchPortsMappings,
	fetchSyncConflicts,
	fetchSyncSeedBlock,
	resolveSyncConflicts,
	resolveSyncSeedBlock,
	setFilesShareMode,
	setFilesSharePeers,
	setPortsMappingEnabled,
	syncNow,
} from "./api";
import {
	PERSPECTIVE_HASH,
	canonicalHashFor,
	defaultPerspective,
	rememberedPerspective,
	rememberPerspective,
	routeFor,
	perspectiveFor,
	type Perspective,
	type Route,
} from "./route";
import { pluginRouteDecision } from "./plugin-registry";
import { validateHex64 } from "./hex";
import { aliasEditError, aliasEditSubmit, type DisconnectPhase } from "./terms";
import { labelEditError, labelEditSubmit } from "./member";
import { leaseState } from "./format";

export const POLL_MS = 5_000;
/** 成员面列表轮询（home-hub F1：3s——与在线面同拍节奏、同一可见性门控机制）。 */
export const LIST_POLL_MS = 3_000;
export const CONVERGE_POLL_MS = 1_000;
/** 断连收敛观测上界 ~15s（design §4 有界轮询） */
export const CONVERGE_MAX_POLLS = 15;
/** 成功确认幕短暂呈现后进入 ready 世界 */
export const PAIRED_TRANSITION_MS = 900;

export interface ConnectForm {
	server: string;
	token: string;
	code: string;
}
export interface OwnerForm {
	fabricId: string;
	root: string;
}
export interface ConnectResult {
	ok: boolean;
	error?: AdminError;
}
export interface OwnerConfirm {
	fabricId: string;
	root: string;
}
export interface ConnConfirm {
	kind: "endpoint" | "fabric";
	id: string;
	count: number;
}
export interface DisconnectState {
	kind: "endpoint" | "fabric";
	id: string;
	phase: DisconnectPhase;
	receipts: Receipt[];
	error: AdminError | null;
}
/** 敲门台四动作的确认/表单状态（一次至多一个打开）。 */
export type KnockAction =
	| { kind: "locate"; knock: KnockEntry; alias: string }
	| { kind: "import"; knock: KnockEntry; fabricId: string }
	| { kind: "block"; knock: KnockEntry };
export interface VisitorForm {
	endpointId: string;
	alias: string;
}
export interface CodeForm {
	aliasHint: string;
	maxUses: number;
	expiresInDays: number;
	defaultTtlDays: number;
}
export interface RenewConfirm {
	fabricId: string;
	root: string;
	alias: string | null;
	mode: "extend30" | "custom" | "permanent";
	date: string;
}
export interface NodeConfirm {
	kind: "switch" | "delete";
	node: SidecarNode;
}
/** 别名行内编辑目标（一次至多一个；owner 以二元组定位，visitor 以端点定位）。 */
export type AliasEditTarget =
	| { kind: "owner"; fabricId: string; root: string }
	| { kind: "visitor"; endpointId: string };
/** 编辑会话：prev=编辑前别名（trim 后），value=当前输入。 */
export interface AliasEdit extends AliasEditTarget {
	prev: string;
	value: string;
}
export interface AddNodeForm {
	server: string;
	token: string;
	code: string;
	name: string;
}

/** 在线表快照里目标是否仍在（断连收敛观测）。 */
function snapshotHasTarget(data: ConnectionsData | null, kind: "endpoint" | "fabric", id: string): boolean {
  const rows = Array.isArray(data?.per_endpoint) ? data.per_endpoint : [];
  return rows.some((e) => (kind === "endpoint" ? e.endpoint_id === id : e.fabric_id === id));
}

/** 租约条目 → 状态（本地快照边界与名册侧 leaseState 同源）。 */
function leaseStateOf(l: { expires_at?: number | null }) {
  return leaseState(typeof l.expires_at === "number" ? l.expires_at : null);
}

const visible = () => document.visibilityState === "visible";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class ConsoleStore {
	hash = $state<string>(typeof location !== "undefined" ? location.hash : "");
	sidecar = $state<SidecarState | null>(null);
	sidecarError = $state<AdminError | null>(null);

	connectForm = $state<ConnectForm>({ server: "", token: "", code: "" });
	connectBusy = $state(false);
	connectResult = $state<ConnectResult | null>(null);

	statusData = $state<StatusData | null>(null);
	statusError = $state<AdminError | null>(null);
	statusLastFailAt = $state<number | null>(null);

	connData = $state<ConnectionsData | null>(null);
	connError = $state<AdminError | null>(null);

	ownersData = $state<OwnersData | null>(null);
	ownersError = $state<AdminError | null>(null);

	ownerForm = $state<OwnerForm>({ fabricId: "", root: "" });
	ownerFormError = $state<string | null>(null);
	ownerBusy = $state(false);
	receipt = $state<Receipt | null>(null);
	ownerConfirm = $state<OwnerConfirm | null>(null);
	renewConfirm = $state<RenewConfirm | null>(null);
	renewBusy = $state(false);

	// ---- 别名行内编辑（PM §4.5 流 E；PATCH owner-meta/visitor-meta 承载） --------------

	aliasEdit = $state<AliasEdit | null>(null);
	aliasEditError = $state<string | null>(null);
	aliasBusy = $state(false);
	/** 空串清除的二次确认（挂起的清除提交；确认后 PATCH body {"alias":""}）。 */
	aliasClearConfirm = $state<AliasEdit | null>(null);

	// ---- 敲门台 / 访客 / 黑名单 ---------------------------------------------------

	knocksData = $state<{ knocks: KnockEntry[]; pending_count: number } | null>(null);
	knocksError = $state<AdminError | null>(null);
	knockAction = $state<KnockAction | null>(null);
	knockBusy = $state(false);

	visitorsData = $state<{ visitors: VisitorEntry[] } | null>(null);
	visitorsError = $state<AdminError | null>(null);
	visitorForm = $state<VisitorForm>({ endpointId: "", alias: "" });
	visitorBusy = $state(false);
	visitorConfirm = $state<{ endpointId: string; alias: string | null } | null>(null);

	blocklistData = $state<BlocklistData | null>(null);
	blocklistError = $state<AdminError | null>(null);
	blockConfirm = $state<{ kind: "endpoint" | "fabric"; id: string } | null>(null);

	// ---- 邀请码 -------------------------------------------------------------------

	codesData = $state<{ codes: CodeEntry[] } | null>(null);
	codesError = $state<AdminError | null>(null);
	codeForm = $state<CodeForm>({ aliasHint: "", maxUses: 1, expiresInDays: 7, defaultTtlDays: 30 });
	codeBusy = $state(false);
	/** 签发成功的一次性全文视图（离开即清空——列表与一切后续界面只有哈希缩写）。 */
	issuedCode = $state<{ code: string; aliasHint: string; maxUses: number; expiresInDays: number } | null>(null);
	revokeCodeConfirm = $state<{ codeHash: string } | null>(null);

	// ---- 节点簿（本地控制面 /sidecar/nodes*） -----------------------------------------

	nodesData = $state<{ nodes: SidecarNode[] } | null>(null);
	nodesError = $state<AdminError | null>(null);
	addNodeForm = $state<AddNodeForm>({ server: "", token: "", code: "", name: "" });
	addNodeBusy = $state(false);
	addNodeError = $state<AdminError | null>(null);
	nodeConfirm = $state<NodeConfirm | null>(null);
	/** 切换行内过渡态：「正在切换到 <节点名>…」（无重启文案）。 */
	switchingTo = $state<string | null>(null);

	connConfirm = $state<ConnConfirm | null>(null);
	disconnect = $state<DisconnectState | null>(null);

	// ---- 三视角成员面（home-hub 2b：本机租约/到访/hub 数据面） -----------------------

	leasesData = $state<{ leases: LeaseEntry[] } | null>(null);
	leasesError = $state<AdminError | null>(null);
	visitsData = $state<{ visits: VisitEntry[] } | null>(null);
	visitsError = $state<AdminError | null>(null);
	hubData = $state<HubData | null>(null);
	hubError = $state<AdminError | null>(null);
	/** GET /sidecar/hub 404 = 这台设备没有中枢身份（正常态呈现，不是错误）。 */
	hubAbsent = $state(false);
	/** 一键本地中枢动作锁（setup 页故事 B / 中枢状态卡共用）。 */
	hubStartBusy = $state(false);
	hubStartError = $state<AdminError | null>(null);
	/** 行内展开的租约 id（一次至多一条）。 */
	leaseExpanded = $state<string | null>(null);
	/** label 行内编辑会话（id 定位；prev/value trim 前）。 */
	leaseLabelEdit = $state<{ id: string; server: string; prev: string; value: string } | null>(null);
	leaseLabelEditError = $state<string | null>(null);
	leaseLabelBusy = $state(false);
	/** 「测一下」进行中的目标 origin（按钮 Loading 锁，防重复触发）。 */
	probeBusy = $state<string | null>(null);

	// ---- 插件面（webui-plugin-kernel Phase 0：/sidecar/plugins* 本机控制面） ----------

	pluginsData = $state<PluginsData | null>(null);
	pluginsError = $state<AdminError | null>(null);
	/** 启停动作锁（一次一插件一动作；"<id>:enable" | "<id>:disable"）。 */
	pluginActionBusy = $state<string | null>(null);
	/** 配置保存锁（一次一插件）。 */
	pluginConfigBusy = $state<string | null>(null);
	/** 配置表单草稿（插件 id → 值；面板/通用页共用——保存成功即清除）。 */
	pluginConfigDraft = $state<Record<string, PluginConfigValues>>({});

	// ---- 三插件管理面（webui-plugin-kernel 收官接线：/sidecar/plugins/<id>/<mgmt>） ---

	portsMappings = $state<PortsMappingRow[] | null>(null);
	portsAllowlist = $state<PortsAllowEntry[] | null>(null);
	/** ports 页顶层错误（端口冲突/超范围配置等服务端明确文案）。 */
	portsError = $state<string | null>(null);
	portsBusy = $state(false);

	filesShares = $state<FilesShareRow[] | null>(null);
	filesError = $state<string | null>(null);
	filesBusy = $state(false);

	syncGroups = $state<SyncGroupRow[] | null>(null);
	syncJobs = $state<SyncJobRow[]>([]);
	/** 每 root 冲突会话（ConflictPage 装配源；null=未加载）。 */
	syncConflictSessions = $state<Array<{ groupId: string; rootId: string; session: unknown }> | null>(null);
	/** seed 阻断三方对照（GroupsPage 阻断面板；null=无）。 */
	syncSeedBlock = $state<{ groupId: string; rootId: string; block: unknown } | null>(null);
	syncError = $state<string | null>(null);
	syncBusy = $state(false);

	detailsOpen = $state(false);
	onlineFilter = $state<string | null>(null);

	// ---- 派生 ----------------------------------------------------------------------

	get phase(): "setup" | "ready" {
		return this.sidecar !== null && this.sidecar.phase === "ready" ? "ready" : "setup";
	}
	/** home-hub 2b：sidecar 姿态（member=本机数据面——SPA 不进 setup 世界）。 */
	get role(): "admin" | "member" {
		return this.sidecar?.role === "member" ? "member" : "admin";
	}
	/** hub 本机自动形态（row 2）——中枢视角/中枢状态卡的数据源。 */
	get hubLocal(): boolean {
		return this.sidecar?.hub_local === true;
	}
	/**
	 * admin 管理面整体不可用（D4 错误单例，2026-10-02）：管理 API 持续凭证级失败
	 * （unauthorized / http-401 / no-target）→ App 层整页降级屏（一条错误 + 恢复
	 * 动作），页面内不再逐卡复制红横幅。瞬时网络错误（可重试）不算 down。
	 */
	get adminPlaneDown(): boolean {
		if (this.phase !== "ready" || this.role !== "admin") return false;
		const e = this.statusError;
		if (e === null) return false;
		return e.code === "unauthorized" || e.code === "http-401" || e.code === "no-target";
	}
	/**
	 * ports 映射表单的对端选项源：本机租约的 fabric root（home-hub §2——
	 * lease.root=对端中枢设备的 endpointId；「把中枢那台设备的端口映射到本机」
	 * 是 v1 主用例）。节点簿是 server 面孔（无 endpointId），不在此列。
	 */
	get portsPeerOptions(): Array<{ endpointId: string; label: string }> {
		const leases = Array.isArray(this.leasesData?.leases) ? this.leasesData!.leases : [];
		const seen = new Set<string>();
		const out: Array<{ endpointId: string; label: string }> = [];
		for (const l of leases) {
			if (typeof l.root !== "string" || l.root === "" || seen.has(l.root)) continue;
			seen.add(l.root);
			out.push({ endpointId: l.root, label: l.label ?? l.alias ?? l.server });
		}
		return out;
	}
	/** 应用世界：ready(admin) 或 member——setup 引导只在 admin 姿态无目标时出现。 */
	get appWorld(): boolean {
		return this.phase === "ready" || this.role === "member";
	}
	get route(): Route {
		return routeFor(this.hash, this.appWorld ? "ready" : "setup", this.role);
	}
	/**
	 * 插件页渲染裁决（plugin-registry.pluginRouteDecision 的薄封装）：
	 * render=渲染；converge=停用/未知 → 基线收敛；pending=服务端状态未加载。
	 * App 壳的收敛 effect 与插件页组件共用本派生。
	 */
	get pluginDecision(): "render" | "converge" | "pending" {
		if (this.route.view !== "plugin") return "render";
		return pluginRouteDecision(this.route.pluginId, this.pluginsData).action;
	}
	/** 当前视角（切换器高亮与外壳分派）。 */
	get perspective(): Perspective {
		return perspectiveFor(this.route.view);
	}
	/** 租约临期计数（切换器徽章与租约页同源；≤7 天未到期）。 */
	get leaseExpiringCount(): number {
		const leases = Array.isArray(this.leasesData?.leases) ? this.leasesData!.leases : [];
		return leases.filter((l) => {
			const state = leaseStateOf(l);
			return state.state === "expiring";
		}).length;
	}
	/** 最近一条临期租约（首屏黄条呈现对象；null=无临期）。 */
	get soonestExpiring(): LeaseEntry | null {
		const leases = Array.isArray(this.leasesData?.leases) ? this.leasesData!.leases : [];
		return (
			leases
				.filter((l) => leaseStateOf(l).state === "expiring")
				.sort((a, b) => (a.expires_at ?? 0) - (b.expires_at ?? 0))[0] ?? null
		);
	}
	/** 名册行「在用」状态源：per_owner 的 fabric 集合（快照快）。 */
	get onlineFabricSet(): Set<string> {
		return new Set(Array.isArray(this.connData?.per_owner) ? this.connData.per_owner.map((o) => o.fabric_id) : []);
	}
	get overviewData(): (StatusData & { relay_enabled?: boolean }) | null {
		return this.statusData === null ? null : { ...this.statusData, relay_enabled: this.connData?.relay_enabled };
	}
	get overviewError(): AdminError | null {
		return this.statusError ?? this.connError;
	}
	/** 待处理敲门数（总览待办条/侧栏徽章/敲门台同一数据源：status 增量字段）。 */
	get knocksPending(): number {
		return typeof this.statusData?.knocks_pending === "number" ? this.statusData.knocks_pending : 0;
	}

	// ---- 生命周期：路由监听 + ready 态常驻轮询 --------------------------------------------

	#hashHandler = () => {
		this.applyHash(location.hash);
	};
	#statusTimer: ReturnType<typeof setInterval> | null = null;
	#connTimer: ReturnType<typeof setInterval> | null = null;
	#listTimer: ReturnType<typeof setInterval> | null = null;
	#visHandler: (() => void) | null = null;
	/** boot 默认视角只裁决一次（deep link 优先；此后记忆最近使用）。 */
	#initialRouteSettled = false;
	/**
	 * 页面载入时的原始 hash（start() 首行捕获，先于任何规范化改写）。settle 用
	 * 它区分「用户/启动器显式深链」与「空 hash 需自动裁决」——不能读当时的
	 * location.hash：applyHash 已把空 hash 规范化为 #/overview（D3 竞态根因，
	 * 程序性落点被误判为显式深链，压过 member 的 auto="lease" 裁决）。
	 */
	#bootHash = "";

	start(): void {
		this.#bootHash = location.hash;
		window.addEventListener("hashchange", this.#hashHandler);
		this.applyHash(location.hash);
		void this.refreshSidecar().then(() => this.#settleInitialRoute());
	}
	/** 旧路由 301 式收敛（应用内重定向，不 404）：非规范 hash 就地 replace 为规范形态。 */
	applyHash(raw: string): void {
		const canonical = canonicalHashFor(raw);
		if (canonical !== null) {
			// v1 #/connect 的「呼出面板」意图保留：收敛到总览的同时打开节点簿
			if (typeof raw === "string" && /^#\/?connect(\/|$)/.test(raw)) this.detailsOpen = true;
			try {
				history.replaceState(null, "", canonical);
			} catch {
				location.hash = canonical; // 无 history 权限的环境退化为赋值
			}
			this.hash = canonical;
			this.#rememberCurrent();
			return;
		}
		this.hash = raw;
		this.#rememberCurrent();
	}
	/**
	 * 视角记忆（spec「此后记忆最近使用」；D3 收紧）：只记录用户显式切换——
	 * settle 完成前一切程序性落点（boot 规范化 / settle 自动裁决）不写键，
	 * 防启动竞态把 auto 结果钉进记忆压过下次启动的自动选择。
	 */
	#rememberCurrent(): void {
		if (!this.#initialRouteSettled || !this.appWorld) return;
		rememberPerspective(window.localStorage, this.perspective);
	}
	/**
	 * boot 默认视角（home-hub spec：hub.json 存在→中枢；有租约→租约；有到访→
	 * 到访；全空→中枢引导态；记忆最近使用优先于自动选择；显式深链最优先——
	 * 托盘/`hub open` 的落点不被覆盖）。深链判定用 #bootHash（载入时的原始
	 * hash）：空 hash 一律走自动裁决——boot 规范化写下的 #/overview 不算深链
	 * （D3：member 干净首启必须落 auto 视角，且自动落点不写记忆键）。
	 */
	async #settleInitialRoute(): Promise<void> {
		if (this.#initialRouteSettled) return;
		this.#initialRouteSettled = true;
		if (this.#bootHash !== "" && this.#bootHash !== "#" && this.#bootHash !== "#/") {
			this.#rememberCurrent();
			return;
		}
		const hubPresent = await this.refreshHub().then(
			() => !this.hubAbsent,
			() => false,
		);
		const leases = await this.refreshLeases().then(
			() => (Array.isArray(this.leasesData?.leases) ? this.leasesData!.leases.length : 0),
			() => 0,
		);
		const visits = await this.refreshVisits().then(
			() => (Array.isArray(this.visitsData?.visits) ? this.visitsData!.visits.length : 0),
			() => 0,
		);
		const auto = defaultPerspective({ role: this.role, hubLocal: this.hubLocal, hubPresent, leases, visits });
		const target = rememberedPerspective(window.localStorage) ?? auto;
		const hash = PERSPECTIVE_HASH[target];
		try {
			history.replaceState(null, "", hash);
		} catch {
			location.hash = hash;
		}
		this.hash = hash;
		// 程序性自动落点不写记忆键（D3）——记忆只来自用户显式切换（#rememberCurrent
		// 经 hashchange/切换器触发；本行刻意的落点若被记忆，会压过下次启动的 auto）。
	}
	stop(): void {
		window.removeEventListener("hashchange", this.#hashHandler);
		this.#stopPolling();
	}
	#stopPolling(): void {
		if (this.#statusTimer !== null) clearInterval(this.#statusTimer);
		if (this.#connTimer !== null) clearInterval(this.#connTimer);
		if (this.#listTimer !== null) clearInterval(this.#listTimer);
		if (this.#visHandler !== null) document.removeEventListener("visibilitychange", this.#visHandler);
		this.#statusTimer = this.#connTimer = this.#listTimer = null;
		this.#visHandler = null;
	}

	async refreshSidecar(): Promise<void> {
		try {
			const next = await fetchSidecarState();
			this.sidecarError = null;
			// D2 防线（引用稳定）：投影字段全部等值时复用既有对象——$state 引用不
			// 翻转，依赖 sidecar 的任何 $effect 都不重入。风暴根因之一是本方法每次
			// 赋新对象；即便上游 effect 接线回归，此门也把重入收敛到「真变化」。
			const prev = this.sidecar;
			if (
				prev !== null &&
				prev.phase === next.phase &&
				prev.role === next.role &&
				prev.server_host_masked === next.server_host_masked &&
				prev.insecure === next.insecure &&
				prev.hub_local === next.hub_local
			) {
				return;
			}
			this.sidecar = next;
		} catch (e) {
			this.sidecarError = toAdminError(e);
		}
	}

	/** 应用世界轮询（App 壳挂载后启动；admin=在线面 5s + 成员面 3s，member=仅成员面）。 */
	$poll(): void {
		this.#stopPolling();
		if (!this.appWorld) return;
		if (this.phase === "ready") {
			const tickStatus = () => {
				if (!visible()) return;
				void this.refreshStatus();
				if (this.route.view === "visitors") void this.refreshKnocks(); // 敲门=待办，门禁页同拍刷新
			};
			const tickConn = () => {
				if (visible()) void this.refreshConnections();
			};
			void this.refreshStatus();
			void this.refreshConnections();
			if (this.route.view === "visitors") void this.refreshKnocks();
			this.#statusTimer = setInterval(tickStatus, POLL_MS);
			this.#connTimer = setInterval(tickConn, POLL_MS);
		}
		// 成员面列表（home-hub F1：3s；徽章/首屏两问的数据源；到访页与租约页的
		// last_probe 呈现同拍）
		const tickLists = () => {
			if (!visible()) return;
			void this.refreshLeases();
			if (this.route.view === "visits" || this.route.view === "lease") void this.refreshVisits();
		};
		void this.refreshLeases();
		if (this.route.view === "visits" || this.route.view === "lease") void this.refreshVisits();
		this.#listTimer = setInterval(tickLists, LIST_POLL_MS);
		this.#visHandler = () => {
			if (!visible()) return;
			if (this.phase === "ready") {
				void this.refreshStatus();
				void this.refreshConnections();
			}
			void this.refreshLeases();
			if (this.route.view === "visits" || this.route.view === "lease") void this.refreshVisits();
		};
		document.addEventListener("visibilitychange", this.#visHandler);
	}

	async refreshStatus(): Promise<void> {
		try {
			this.statusData = await loadStatus();
			this.statusError = null;
		} catch (e) {
			this.statusError = toAdminError(e);
			this.statusLastFailAt = Date.now();
		}
	}
	async refreshConnections(): Promise<void> {
		try {
			this.connData = await loadConnections();
			this.connError = null;
		} catch (e) {
			this.connError = toAdminError(e);
		}
	}
	async refreshOwners(): Promise<void> {
		try {
			this.ownersData = await loadOwners();
			this.ownersError = null;
		} catch (e) {
			this.ownersError = toAdminError(e);
		}
	}
	async refreshKnocks(): Promise<void> {
		try {
			this.knocksData = await loadKnocks();
			this.knocksError = null;
		} catch (e) {
			this.knocksError = toAdminError(e);
		}
	}
	async refreshVisitors(): Promise<void> {
		try {
			this.visitorsData = await loadVisitors();
			this.visitorsError = null;
		} catch (e) {
			this.visitorsError = toAdminError(e);
		}
	}
	async refreshBlocklist(): Promise<void> {
		try {
			this.blocklistData = await loadBlocklist();
			this.blocklistError = null;
		} catch (e) {
			this.blocklistError = toAdminError(e);
		}
	}
	async refreshCodes(): Promise<void> {
		try {
			this.codesData = await loadCodes();
			this.codesError = null;
		} catch (e) {
			this.codesError = toAdminError(e);
		}
	}
	async refreshNodes(): Promise<void> {
		try {
			this.nodesData = await fetchSidecarNodes();
			this.nodesError = null;
		} catch (e) {
			this.nodesError = toAdminError(e);
		}
	}
	async refreshLeases(): Promise<void> {
		try {
			this.leasesData = await fetchSidecarLeases();
			this.leasesError = null;
		} catch (e) {
			this.leasesError = toAdminError(e);
		}
	}
	async refreshVisits(): Promise<void> {
		try {
			this.visitsData = await fetchSidecarVisits();
			this.visitsError = null;
		} catch (e) {
			this.visitsError = toAdminError(e);
		}
	}
	/** hub 投影（404=无中枢身份——hubAbsent 常态位，不进错误面）。 */
	async refreshHub(): Promise<void> {
		try {
			this.hubData = await fetchSidecarHub();
			this.hubError = null;
			this.hubAbsent = false;
		} catch (e) {
			const err = toAdminError(e);
			if (err.status === 404) {
				this.hubAbsent = true;
				this.hubError = null;
				this.hubData = null;
			} else {
				this.hubError = err;
			}
		}
	}

	/**
	 * 一键本地中枢（用户故事 B「连接本地服务器」；setup 页与中枢状态卡共用）：
	 * initialize=true 允许在未初始化机器上走 hub init --yes。connected=true 时
	 * sidecar 已注入本机中枢 admin 目标——清空业务缓存、刷新世界（setup→ready
	 * 翻转由 refreshSidecar 驱动）并落总览；connected=false（row 2 daemon-down
	 * 恢复）仅刷新 hub 投影与健康面。
	 */
	async startLocalHub(initialize: boolean): Promise<boolean> {
		this.hubStartBusy = true;
		this.hubStartError = null;
		try {
			const r = await startSidecarHub(initialize);
			if (r.connected) {
				this.#clearAllBusinessData();
				await this.refreshSidecar();
				await Promise.all([this.refreshHub(), this.refreshStatus(), this.refreshConnections()]);
				await Promise.all([
					this.refreshOwners(),
					this.refreshKnocks(),
					this.refreshVisitors(),
					this.refreshBlocklist(),
					this.refreshCodes(),
					this.refreshNodes(),
				]);
				location.hash = "#/overview";
				this.hash = "#/overview";
			} else {
				await Promise.all([this.refreshHub(), this.refreshSidecar()]);
			}
			return true;
		} catch (e) {
			this.hubStartError = toAdminError(e);
			return false;
		} finally {
			this.hubStartBusy = false;
		}
	}

	// ---- 三视角成员面动作（label 编辑 / 探测 / 行内展开） ---------------------------

	/** 切换器一击切换（整页重渲、无确认——hash 变更驱动视角分派）。 */
	switchPerspective(p: Perspective): void {
		location.hash = PERSPECTIVE_HASH[p];
	}

	toggleLeaseExpanded(id: string): void {
		this.leaseExpanded = this.leaseExpanded === id ? null : id;
	}

	beginLeaseLabelEdit(lease: LeaseEntry): void {
		this.leaseLabelEdit = {
			id: lease.id,
			server: lease.server,
			prev: typeof lease.label === "string" ? lease.label : "",
			value: typeof lease.label === "string" ? lease.label : "",
		};
		this.leaseLabelEditError = null;
	}

	onLeaseLabelInput(value: string): void {
		if (this.leaseLabelEdit === null) return;
		this.leaseLabelEdit = { ...this.leaseLabelEdit, value };
		this.leaseLabelEditError = labelEditError(value);
	}

	cancelLeaseLabelEdit(): void {
		this.leaseLabelEdit = null;
		this.leaseLabelEditError = null;
	}

	/**
	 * 提交 label：裁决在纯函数 labelEditSubmit（node --test 直测）——save→PATCH
	 * （空串先行归一 null=清除）；cancel/error 不发请求。返回 {ok} 供 toast。
	 */
	async submitLeaseLabelEdit(): Promise<{ ok: boolean } | null> {
		const edit = this.leaseLabelEdit;
		if (edit === null) return null;
		const decision = labelEditSubmit(edit.value, edit.prev);
		if (decision.action === "error") {
			this.leaseLabelEditError = decision.message;
			return { ok: false };
		}
		if (decision.action === "cancel") {
			this.cancelLeaseLabelEdit();
			return null;
		}
		// 空串=清除——body 归一 {label: null}
		const label = decision.value === "" ? null : decision.value;
		this.leaseLabelBusy = true;
		try {
			await patchSidecarLeaseLabel(edit.id, label);
			this.leaseLabelEdit = null;
			this.leaseLabelEditError = null;
			await this.refreshLeases();
			return { ok: true };
		} catch (e) {
			this.leasesError = toAdminError(e);
			return { ok: false };
		} finally {
			this.leaseLabelBusy = false;
		}
	}

	/** 「测一下」：主动探测（写 visits；按钮 Loading 锁）。返回 {ok} 供行内结果呈现。 */
	async probeServerTarget(server: string): Promise<boolean> {
		if (this.probeBusy !== null) return false;
		this.probeBusy = server;
		try {
			await probeSidecarVisit(server);
			await this.refreshVisits();
			return true;
		} catch (e) {
			this.visitsError = toAdminError(e);
			return false;
		} finally {
			this.probeBusy = null;
		}
	}

	// ---- 插件面动作（启停/配置；写路由由浏览器 same-origin Origin 承载） ---------------

	/** 面板数据源（appWorld 起步拉 + 动作后刷新；404=该 sidecar 无插件面——面板呈现不可用态）。 */
	async refreshPlugins(): Promise<void> {
		try {
			this.pluginsData = await fetchSidecarPlugins();
			this.pluginsError = null;
		} catch (e) {
			this.pluginsError = toAdminError(e);
		}
	}

	/** 启用插件（registered/disabled→enabled；幂等）。返回 {ok} 供 toast。 */
	async enablePlugin(id: string): Promise<boolean> {
		if (this.pluginActionBusy !== null) return false;
		this.pluginActionBusy = `${id}:enable`;
		try {
			await enableSidecarPlugin(id);
			await this.refreshPlugins();
			return true;
		} catch (e) {
			this.pluginsError = toAdminError(e);
			return false;
		} finally {
			this.pluginActionBusy = null;
		}
	}

	/**
	 * 停用插件（摘牌→drain（有界）→dispose→落盘；请求在 drain 收敛后应答——
	 * 慢停用是设计行为，按钮 Loading 锁全程持有）。返回 {ok} 供 toast。
	 */
	async disablePlugin(id: string): Promise<boolean> {
		if (this.pluginActionBusy !== null) return false;
		this.pluginActionBusy = `${id}:disable`;
		try {
			await disableSidecarPlugin(id);
			await this.refreshPlugins();
			return true;
		} catch (e) {
			this.pluginsError = toAdminError(e);
			return false;
		} finally {
			this.pluginActionBusy = null;
		}
	}

	/** 配置草稿写入（受控输入；离开面板不清除——同插件回访保留未保存编辑）。 */
	setPluginConfigDraft(id: string, key: string, value: string | number | boolean): void {
		const prev = this.pluginConfigDraft[id] ?? {};
		this.pluginConfigDraft = { ...this.pluginConfigDraft, [id]: { ...prev, [key]: value } };
	}

	/** 草稿起点：进入表单时以服务端 config 为底（已有草稿则保留）。 */
	seedPluginConfigDraft(plugin: WebuiPluginEntry): void {
		if (this.pluginConfigDraft[plugin.id] !== undefined) return;
		this.pluginConfigDraft = { ...this.pluginConfigDraft, [plugin.id]: { ...plugin.config } };
	}

	cancelPluginConfigDraft(id: string): void {
		const next = { ...this.pluginConfigDraft };
		delete next[id];
		this.pluginConfigDraft = next;
	}

	/** 保存配置（PUT——服务端 configSchema 校验；成功清除草稿）。返回 {ok} 供 toast。 */
	async savePluginConfig(id: string): Promise<boolean> {
		const draft = this.pluginConfigDraft[id];
		if (draft === undefined || this.pluginConfigBusy !== null) return false;
		this.pluginConfigBusy = id;
		try {
			await putSidecarPluginConfig(id, draft);
			this.cancelPluginConfigDraft(id);
			await this.refreshPlugins();
			return true;
		} catch (e) {
			this.pluginsError = toAdminError(e);
			return false;
		} finally {
			this.pluginConfigBusy = null;
		}
	}

	// ---- 三插件管理面动作（收官接线；错误经各面 error 态呈现，动作返回 {ok} 供 toast） ---

	/** ports：映射+授权账本（页面进入/动作后刷新）。 */
	async refreshPorts(): Promise<void> {
		try {
			const [m, a] = await Promise.all([fetchPortsMappings(), fetchPortsAllowlist()]);
			this.portsMappings = m.mappings;
			this.portsAllowlist = a.entries;
			this.portsError = null;
		} catch (e) {
			this.portsError = toAdminError(e).message;
		}
	}

	async createPortMapping(input: { name: string; peer: string; remotePort: number; localPort: number }): Promise<boolean> {
		if (this.portsBusy) return false;
		this.portsBusy = true;
		try {
			await createPortsMapping(input);
			this.portsError = null;
			await this.refreshPorts();
			return true;
		} catch (e) {
			this.portsError = toAdminError(e).message;
			return false;
		} finally {
			this.portsBusy = false;
		}
	}

	async togglePortMapping(id: string, enabled: boolean): Promise<boolean> {
		if (this.portsBusy) return false;
		this.portsBusy = true;
		try {
			await setPortsMappingEnabled(id, enabled);
			this.portsError = null;
			await this.refreshPorts();
			return true;
		} catch (e) {
			this.portsError = toAdminError(e).message;
			return false;
		} finally {
			this.portsBusy = false;
		}
	}

	async removePortMapping(id: string): Promise<boolean> {
		if (this.portsBusy) return false;
		this.portsBusy = true;
		try {
			await deletePortsMapping(id);
			this.portsError = null;
			await this.refreshPorts();
			return true;
		} catch (e) {
			this.portsError = toAdminError(e).message;
			return false;
		} finally {
			this.portsBusy = false;
		}
	}

	/** ports 提供侧授权（allowlist 授予/回收）。 */
	async grantPortAccess(peer: string, remotePort: number): Promise<boolean> {
		if (this.portsBusy) return false;
		this.portsBusy = true;
		try {
			await grantPortsAccess(peer, remotePort);
			await this.refreshPorts();
			return true;
		} catch (e) {
			this.portsError = toAdminError(e).message;
			return false;
		} finally {
			this.portsBusy = false;
		}
	}

	async revokePortAccess(peer: string, remotePort: number): Promise<boolean> {
		if (this.portsBusy) return false;
		this.portsBusy = true;
		try {
			await revokePortsAccess(peer, remotePort);
			await this.refreshPorts();
			return true;
		} catch (e) {
			this.portsError = toAdminError(e).message;
			return false;
		} finally {
			this.portsBusy = false;
		}
	}

	/** files：提供侧共享账本。 */
	async refreshFilesShares(): Promise<void> {
		try {
			this.filesShares = (await fetchFilesShares()).shares;
			this.filesError = null;
		} catch (e) {
			this.filesError = toAdminError(e).message;
		}
	}

	async createFileShare(input: { name: string; root: string; mode?: "ro" | "rw"; peers?: string[] }): Promise<boolean> {
		if (this.filesBusy) return false;
		this.filesBusy = true;
		try {
			await createFilesShare(input);
			this.filesError = null;
			await this.refreshFilesShares();
			return true;
		} catch (e) {
			this.filesError = toAdminError(e).message;
			return false;
		} finally {
			this.filesBusy = false;
		}
	}

	async removeFileShare(id: string): Promise<boolean> {
		if (this.filesBusy) return false;
		this.filesBusy = true;
		try {
			await deleteFilesShare(id);
			this.filesError = null;
			await this.refreshFilesShares();
			return true;
		} catch (e) {
			this.filesError = toAdminError(e).message;
			return false;
		} finally {
			this.filesBusy = false;
		}
	}

	async setFileShareMode(id: string, mode: "ro" | "rw"): Promise<boolean> {
		if (this.filesBusy) return false;
		this.filesBusy = true;
		try {
			await setFilesShareMode(id, mode);
			this.filesError = null;
			await this.refreshFilesShares();
			return true;
		} catch (e) {
			this.filesError = toAdminError(e).message;
			return false;
		} finally {
			this.filesBusy = false;
		}
	}

	async setFileSharePeers(id: string, peers: string[]): Promise<boolean> {
		if (this.filesBusy) return false;
		this.filesBusy = true;
		try {
			await setFilesSharePeers(id, peers);
			this.filesError = null;
			await this.refreshFilesShares();
			return true;
		} catch (e) {
			this.filesError = toAdminError(e).message;
			return false;
		} finally {
			this.filesBusy = false;
		}
	}

	/** B 侧 wire 转发（FileBrowserPage 控制器的 transport 底座）。 */
	async filesBridgeCall(req: FilesBridgeRequest): Promise<FilesBridgeResponse> {
		return filesBridge(req);
	}

	/** sync：组账本+任务态（进入/动作后刷新；冲突会话与 seed 阻断按需跟随）。 */
	async refreshSync(): Promise<void> {
		try {
			const [g, s] = await Promise.all([fetchSyncGroups(), fetchSyncStatus()]);
			this.syncGroups = g.groups;
			this.syncJobs = s.jobs;
			this.syncError = null;
			await this.refreshSyncConflicts();
			await this.refreshSyncSeedBlock();
		} catch (e) {
			this.syncError = toAdminError(e).message;
		}
	}

	/** 冲突会话装配：仅拉取 hasConflicts 的 root（会话缺失=conflict 文件不存在）。 */
	async refreshSyncConflicts(): Promise<void> {
		if (this.syncGroups === null) return;
		const wanted = this.syncGroups.flatMap((g) =>
			g.roots.filter((r) => r.hasConflicts).map((r) => ({ groupId: g.id, rootId: r.id })),
		);
		const sessions: Array<{ groupId: string; rootId: string; session: unknown }> = [];
		for (const w of wanted) {
			try {
				sessions.push({ ...w, session: (await fetchSyncConflicts(w.groupId, w.rootId)).session });
			} catch {
				// 单 root 拉取失败不拖垮整页（页面 error 面呈现其余数据）
			}
		}
		this.syncConflictSessions = sessions;
	}

	/** seed 阻断三方对照（首个被阻断的 root——GroupsPage 阻断面板单实例）。 */
	async refreshSyncSeedBlock(): Promise<void> {
		if (this.syncGroups === null) return;
		const blocked = this.syncGroups.flatMap((g) => g.roots.filter((r) => r.seedBlock).map((r) => ({ groupId: g.id, rootId: r.id })))[0];
		if (blocked === undefined) {
			this.syncSeedBlock = null;
			return;
		}
		try {
			this.syncSeedBlock = { ...blocked, block: (await fetchSyncSeedBlock(blocked.groupId, blocked.rootId)).block };
		} catch {
			this.syncSeedBlock = null;
		}
	}

	async createSyncGroupAction(draft: SyncGroupDraft): Promise<boolean> {
		if (this.syncBusy) return false;
		this.syncBusy = true;
		try {
			await createSyncGroup(draft);
			this.syncError = null;
			await this.refreshSync();
			return true;
		} catch (e) {
			this.syncError = toAdminError(e).message;
			return false;
		} finally {
			this.syncBusy = false;
		}
	}

	async deleteSyncGroupAction(id: string): Promise<boolean> {
		if (this.syncBusy) return false;
		this.syncBusy = true;
		try {
			await deleteSyncGroup(id);
			this.syncError = null;
			await this.refreshSync();
			return true;
		} catch (e) {
			this.syncError = toAdminError(e).message;
			return false;
		} finally {
			this.syncBusy = false;
		}
	}

	async syncNowAction(id: string): Promise<boolean> {
		if (this.syncBusy) return false;
		this.syncBusy = true;
		try {
			await syncNow(id);
			this.syncError = null;
			await this.refreshSync();
			return true;
		} catch (e) {
			this.syncError = toAdminError(e).message;
			return false;
		} finally {
			this.syncBusy = false;
		}
	}

	async resolveSyncConflictsAction(groupId: string, rootId: string, decisions: unknown): Promise<boolean> {
		if (this.syncBusy) return false;
		this.syncBusy = true;
		try {
			await resolveSyncConflicts(groupId, rootId, decisions);
			this.syncError = null;
			await this.refreshSync();
			return true;
		} catch (e) {
			this.syncError = toAdminError(e).message;
			return false;
		} finally {
			this.syncBusy = false;
		}
	}

	async resolveSyncSeedBlockAction(groupId: string, rootId: string): Promise<boolean> {
		if (this.syncBusy) return false;
		this.syncBusy = true;
		try {
			await resolveSyncSeedBlock(groupId, rootId);
			this.syncError = null;
			await this.refreshSync();
			return true;
		} catch (e) {
			this.syncError = toAdminError(e).message;
			return false;
		} finally {
			this.syncBusy = false;
		}
	}

	// ---- setup 世界：配对引导 ----------------------------------------------

	onConnectInput(name: keyof ConnectForm, value: string): void {
		this.connectForm[name] = value;
	}

	async submitConnect(): Promise<void> {
		this.connectBusy = true;
		this.connectResult = null;
		try {
			await postConnect({
				pairing_code: this.connectForm.code.trim(),
				server: this.connectForm.server.trim(),
				token: this.connectForm.token,
			});
			// token 与配对码即刻清空、不回显（spec：提交后输入框清空且不回显）
			this.connectForm.token = "";
			this.connectForm.code = "";
			this.connectResult = { ok: true };
			// 立即取回掩码目标（确认幕呈现用）；世界翻转由确认幕接管，不闪跳
			await this.refreshSidecar();
			setTimeout(() => this.leaveSetupOnSuccess(), PAIRED_TRANSITION_MS);
		} catch (e) {
			// 失败：就地呈现，表单保留已填内容——但凭证框除外（不回显）
			this.connectForm.token = "";
			this.connectResult = { ok: false, error: toAdminError(e) };
		} finally {
			this.connectBusy = false;
		}
	}

	/** 成功确认幕退场：进入 ready 世界（hash 落总览）。 */
	leaveSetupOnSuccess(): void {
		location.hash = "#/overview";
		this.hash = "#/overview";
		this.connectResult = null;
	}

	// ---- 名册：注册 / 注销 / 续期 --------------------------------------------------

	onOwnerInput(name: keyof OwnerForm, value: string): void {
		this.ownerForm[name] = value;
	}

	async submitRegister(): Promise<void> {
		const fabricId = validateHex64(this.ownerForm.fabricId);
		const root = validateHex64(this.ownerForm.root);
		if (fabricId === null || root === null) {
			this.ownerFormError = "Fabric 与根端点均需为 64 位十六进制字符（0-9 / a-f）。通常从成员的密钥管理处复制，不要手抄。";
			return;
		}
		this.ownerFormError = null;
		this.ownerBusy = true;
		try {
			this.receipt = await registerOwner(fabricId, root);
			this.ownerForm = { fabricId: "", root: "" };
			await Promise.all([this.refreshOwners(), this.refreshStatus()]); // 名册版本/租户数即时反映
		} catch (e) {
			this.ownersError = toAdminError(e);
		} finally {
			this.ownerBusy = false;
		}
	}

	askUnregister(owner: { fabric_id: string; root: string }): void {
		this.ownerConfirm = { fabricId: owner.fabric_id, root: owner.root };
	}
	cancelOwnerConfirm(): void {
		this.ownerConfirm = null;
	}

	async confirmUnregister(): Promise<void> {
		const { fabricId, root } = this.ownerConfirm ?? {};
		this.ownerConfirm = null;
		if (fabricId === undefined) return;
		this.ownerBusy = true;
		try {
			this.receipt = await unregisterOwner(fabricId, root);
			// 名册版本/租户数 + 在线表（名下连接被一并断开）都要反映
			await Promise.all([this.refreshOwners(), this.refreshStatus(), this.refreshConnections()]);
		} catch (e) {
			this.ownersError = toAdminError(e);
		} finally {
			this.ownerBusy = false;
		}
	}

	askRenew(owner: { fabric_id: string; root: string; alias?: string | null }): void {
		this.renewConfirm = {
			fabricId: owner.fabric_id,
			root: owner.root,
			alias: typeof owner.alias === "string" ? owner.alias : null,
			mode: "extend30",
			date: "",
		};
	}
	setRenewMode(mode: RenewConfirm["mode"]): void {
		if (this.renewConfirm !== null) this.renewConfirm = { ...this.renewConfirm, mode };
	}
	setRenewDate(date: string): void {
		if (this.renewConfirm !== null) this.renewConfirm = { ...this.renewConfirm, date };
	}
	cancelRenew(): void {
		this.renewConfirm = null;
	}

	async confirmRenew(): Promise<void> {
		const rc = this.renewConfirm;
		this.renewConfirm = null;
		if (rc === null) return;
		this.renewBusy = true;
		try {
			let body: { expires_in_days?: number; permanent?: boolean };
			if (rc.mode === "permanent") body = { permanent: true };
			else if (rc.mode === "custom") {
				if (rc.date === "") throw new AdminError("invalid-request", "请选择一个到期日", 400);
				const target = new Date(`${rc.date}T23:59:59`).getTime();
				const days = Math.max(1, Math.ceil((target - Date.now()) / 86_400_000));
				body = { expires_in_days: days };
			} else body = { expires_in_days: 30 };
			const receipt = await renewOwner(rc.fabricId, rc.root, body);
			this.receipt = receipt;
			await Promise.all([this.refreshOwners(), this.refreshStatus()]);
		} catch (e) {
			this.ownersError = toAdminError(e);
		} finally {
			this.renewBusy = false;
		}
	}

	// ---- 别名行内编辑（PM §4.5 流 E：hover 入口 → 行内输入 → 保存即 PATCH） ---------

	beginAliasEdit(target: AliasEditTarget, current: string | null | undefined): void {
		const prev = typeof current === "string" ? current.trim() : "";
		this.aliasEdit = { ...target, prev, value: prev };
		this.aliasEditError = null;
	}

	onAliasEditInput(value: string): void {
		if (this.aliasEdit === null) return;
		this.aliasEdit = { ...this.aliasEdit, value };
		this.aliasEditError = aliasEditError(value); // 实时校验（trim 后计字节）
	}

	cancelAliasEdit(): void {
		this.aliasEdit = null;
		this.aliasEditError = null;
	}

	/**
	 * 提交：裁决在纯函数 aliasEditSubmit（node --test 直测）——save→PATCH；
	 * confirm-clear→挂 aliasClearConfirm 二次确认；cancel/error 不发请求。
	 * 返回 {ok} 供组件 toast；null=无需反馈（确认框接管/无变化收起）。
	 */
	async submitAliasEdit(): Promise<{ ok: boolean } | null> {
		const edit = this.aliasEdit;
		if (edit === null) return null;
		const decision = aliasEditSubmit(edit.value, edit.prev);
		if (decision.action === "error") {
			this.aliasEditError = decision.message;
			return { ok: false };
		}
		if (decision.action === "cancel") {
			this.cancelAliasEdit();
			return null;
		}
		if (decision.action === "confirm-clear") {
			this.aliasClearConfirm = edit;
			return null;
		}
		return await this.#patchAlias(edit, decision.value);
	}

	cancelClearAlias(): void {
		this.aliasClearConfirm = null;
	}

	/** 确认清除别名：PATCH body `{"alias":""}`（空串=清除）。 */
	async confirmClearAlias(): Promise<{ ok: boolean } | null> {
		const edit = this.aliasClearConfirm;
		this.aliasClearConfirm = null;
		if (edit === null) return null;
		return await this.#patchAlias(edit, "");
	}

	async #patchAlias(edit: AliasEdit, alias: string): Promise<{ ok: boolean }> {
		this.aliasBusy = true;
		try {
			this.receipt =
				edit.kind === "owner"
					? await patchOwnerMeta(edit.fabricId, edit.root, { alias })
					: await patchVisitorMeta(edit.endpointId, { alias });
			// 别名是名册呈现元数据——刷新对应名册即可（总览计数不受别名影响）
			if (edit.kind === "owner") await this.refreshOwners();
			else await this.refreshVisitors();
			this.aliasEdit = null;
			this.aliasEditError = null;
			return { ok: true };
		} catch (e) {
			// 失败走既有错误态（名册 ErrorBanner）；编辑态保留以便修正后重试
			if (edit.kind === "owner") this.ownersError = toAdminError(e);
			else this.visitorsError = toAdminError(e);
			return { ok: false };
		} finally {
			this.aliasBusy = false;
		}
	}

	// ---- 敲门台：四动作（PM §4.1 文案逐字） ----------------------------------------------

	openKnockAction(action: KnockAction): void {
		this.knockAction = action;
	}
	setKnockAction(patch: Partial<KnockAction> & { kind: KnockAction["kind"] }): void {
		if (this.knockAction === null) return;
		this.knockAction = { ...this.knockAction, ...patch } as KnockAction;
	}
	cancelKnockAction(): void {
		this.knockAction = null;
	}

	/** 定位访客：POST /api/visitors/from-knock（endpoint_id 已预填，可补别名）。 */
	async confirmLocateVisitor(): Promise<void> {
		const action = this.knockAction;
		this.knockAction = null;
		if (action?.kind !== "locate") return;
		this.knockBusy = true;
		try {
			const payload: { endpoint_id: string; alias?: string } = { endpoint_id: action.knock.endpoint_id };
			if (action.alias.trim() !== "") payload.alias = action.alias.trim();
			this.receipt = await grantVisitorFromKnock(payload);
			await Promise.all([this.refreshKnocks(), this.refreshVisitors(), this.refreshStatus()]);
		} catch (e) {
			this.knocksError = toAdminError(e);
		} finally {
			this.knockBusy = false;
		}
	}

	/** 导入租户：敲门记录无 fabric——引导（邀请码通道或手工输入二元组），不阻断。 */
	async confirmImportTenant(): Promise<void> {
		const action = this.knockAction;
		this.knockAction = null;
		if (action?.kind !== "import") return;
		const fabricId = validateHex64(action.fabricId);
		const root = validateHex64(action.knock.endpoint_id);
		if (fabricId === null || root === null) {
			this.knocksError = new AdminError("invalid-request", "Fabric 需为 64 位十六进制字符（0-9 / a-f）。", 400);
			return;
		}
		this.knockBusy = true;
		try {
			this.receipt = await registerOwner(fabricId, root);
			await Promise.all([this.refreshKnocks(), this.refreshOwners(), this.refreshStatus()]);
			this.ownerConfirm = null;
		} catch (e) {
			this.knocksError = toAdminError(e);
		} finally {
			this.knockBusy = false;
		}
	}

	/** 拉黑：二次确认后 POST /api/blocklist（endpoint 维度；先于一切准入判定生效）。 */
	async confirmBlockKnock(): Promise<void> {
		const action = this.knockAction;
		this.knockAction = null;
		if (action?.kind !== "block") return;
		await this.#blockEndpoint(action.knock.endpoint_id);
	}

	async #blockEndpoint(endpointId: string): Promise<void> {
		this.knockBusy = true;
		try {
			this.receipt = await addBlocklist({ kind: "endpoint", id: endpointId });
			await Promise.all([this.refreshKnocks(), this.refreshBlocklist(), this.refreshStatus()]);
		} catch (e) {
			this.blocklistError = toAdminError(e);
		} finally {
			this.knockBusy = false;
		}
	}

	/** 忽略：不弹确认（低后果）——dismiss + 带「撤销」的 toast（撤销 = undismiss）。 */
	async ignoreKnock(knock: KnockEntry): Promise<void> {
		try {
			await dismissKnock(knock.endpoint_id);
			await this.refreshKnocks();
			this.#pendingUndo = knock.endpoint_id;
		} catch (e) {
			this.knocksError = toAdminError(e);
		}
	}

	#pendingUndo: string | null = null;

	/** toast 撤销动作回调：undismiss 后恢复未处置（dismiss 幂等语义下撤销等价再次进入待办视图）。 */
	async undoDismiss(endpointId: string): Promise<void> {
		this.#pendingUndo = null;
		try {
			await undismissKnock(endpointId);
			await Promise.all([this.refreshKnocks(), this.refreshStatus()]);
		} catch (e) {
			this.knocksError = toAdminError(e);
		}
	}

	// ---- 访客名册 / 黑名单 ----------------------------------------------------------

	onVisitorInput(name: keyof VisitorForm, value: string): void {
		this.visitorForm[name] = value;
	}

	async submitAddVisitor(): Promise<void> {
		const endpointId = validateHex64(this.visitorForm.endpointId);
		if (endpointId === null) {
			this.visitorsError = new AdminError("invalid-request", "端点需为 64 位十六进制字符（0-9 / a-f）。", 400);
			return;
		}
		this.visitorBusy = true;
		try {
			const payload: { endpoint_id: string; alias?: string } = { endpoint_id: endpointId };
			if (this.visitorForm.alias.trim() !== "") payload.alias = this.visitorForm.alias.trim();
			this.receipt = await grantVisitor(payload);
			this.visitorForm = { endpointId: "", alias: "" };
			await Promise.all([this.refreshVisitors(), this.refreshStatus()]);
		} catch (e) {
			this.visitorsError = toAdminError(e);
		} finally {
			this.visitorBusy = false;
		}
	}

	askRemoveVisitor(entry: VisitorEntry): void {
		this.visitorConfirm = { endpointId: entry.endpoint_id, alias: typeof entry.alias === "string" ? entry.alias : null };
	}
	cancelVisitorConfirm(): void {
		this.visitorConfirm = null;
	}

	async confirmRemoveVisitor(): Promise<void> {
		const { endpointId } = this.visitorConfirm ?? {};
		this.visitorConfirm = null;
		if (endpointId === undefined) return;
		this.visitorBusy = true;
		try {
			this.receipt = await revokeVisitor(endpointId);
			await Promise.all([this.refreshVisitors(), this.refreshStatus()]);
		} catch (e) {
			this.visitorsError = toAdminError(e);
		} finally {
			this.visitorBusy = false;
		}
	}

	askRemoveBlock(entry: BlockEntry): void {
		this.blockConfirm = { kind: entry.kind, id: entry.id };
	}
	cancelBlockConfirm(): void {
		this.blockConfirm = null;
	}

	async confirmRemoveBlock(): Promise<void> {
		const { kind, id } = this.blockConfirm ?? {};
		this.blockConfirm = null;
		if (id === undefined) return;
		try {
			this.receipt = await removeBlocklist(kind ?? "endpoint", id);
			await this.refreshBlocklist();
		} catch (e) {
			this.blocklistError = toAdminError(e);
		}
	}

	// ---- 邀请码 ------------------------------------------------------------------

	onCodeInput(name: keyof CodeForm, value: string | number): void {
		if (name === "aliasHint") this.codeForm.aliasHint = String(value);
		else {
			const n = Number(value);
			if (Number.isFinite(n) && n >= 1) this.codeForm[name] = Math.floor(n);
		}
	}

	async submitIssueCode(): Promise<void> {
		this.codeBusy = true;
		this.codesError = null;
		try {
			const payload: { alias_hint?: string; max_uses: number; expires_in_days: number; default_ttl_days: number } = {
				max_uses: this.codeForm.maxUses,
				expires_in_days: this.codeForm.expiresInDays,
				default_ttl_days: this.codeForm.defaultTtlDays,
			};
			if (this.codeForm.aliasHint.trim() !== "") payload.alias_hint = this.codeForm.aliasHint.trim();
			const res = await issueCode(payload);
			// 一次性全文视图：仅此一次；关闭后无任何途径再次取回
			this.issuedCode = {
				code: res.code,
				aliasHint: this.codeForm.aliasHint.trim(),
				maxUses: this.codeForm.maxUses,
				expiresInDays: this.codeForm.expiresInDays,
			};
			this.codeForm = { aliasHint: "", maxUses: 1, expiresInDays: 7, defaultTtlDays: 30 };
			await Promise.all([this.refreshCodes(), this.refreshStatus()]);
		} catch (e) {
			this.codesError = toAdminError(e);
		} finally {
			this.codeBusy = false;
		}
	}

	closeIssuedCode(): void {
		this.issuedCode = null; // 关闭即清空——列表与后续界面只有哈希缩写
	}

	askRevokeCode(codeHash: string): void {
		this.revokeCodeConfirm = { codeHash };
	}
	cancelRevokeCode(): void {
		this.revokeCodeConfirm = null;
	}

	async confirmRevokeCode(): Promise<void> {
		const { codeHash } = this.revokeCodeConfirm ?? {};
		this.revokeCodeConfirm = null;
		if (codeHash === undefined) return;
		this.codeBusy = true;
		try {
			this.receipt = await revokeCode(codeHash);
			await Promise.all([this.refreshCodes(), this.refreshStatus()]);
		} catch (e) {
			this.codesError = toAdminError(e);
		} finally {
			this.codeBusy = false;
		}
	}

	// ---- 断连（知情前置确认 → 已下发/收敛中 → 有界轮询观测收敛，同视图闭环） ----

	askDisconnect(kind: "endpoint" | "fabric", id: string, count: number): void {
		this.connConfirm = { kind, id, count };
	}
	cancelConnConfirm(): void {
		this.connConfirm = null;
	}

	async confirmDisconnect(): Promise<void> {
		const { kind, id } = this.connConfirm ?? {};
		this.connConfirm = null;
		if (id === undefined) return;
		this.disconnect = { kind, id, phase: "dispatched", receipts: [], error: null };
		try {
			const res = kind === "endpoint" ? await disconnectByEndpoint(id) : await disconnectByFabric(id);
			this.disconnect = { kind, id, phase: "converging", receipts: res?.receipts ?? [], error: null };
			let converged = false;
			for (let i = 0; i < CONVERGE_MAX_POLLS; i++) {
				await delay(CONVERGE_POLL_MS);
				let snap: ConnectionsData;
				try {
					snap = await loadConnections();
					this.connData = snap;
					this.connError = null;
				} catch {
					continue; // 观测期瞬时失败不终止轮询
				}
				if (!snapshotHasTarget(snap, kind, id)) {
					converged = true;
					break;
				}
			}
			const finalPhase: DisconnectPhase = converged ? "converged" : "unconfirmed";
			if (this.disconnect !== null) this.disconnect = { ...this.disconnect, phase: finalPhase };
		} catch (e) {
			const err = toAdminError(e);
			// no-match：目标已自行离线——刷新在线表供核对（§4.3 C-2 步 5）
			if (err?.code === "no-match") void this.refreshConnections();
			if (this.disconnect !== null) this.disconnect = { ...this.disconnect, error: err };
		}
	}

	dismissDisconnect(): void {
		this.disconnect = null;
	}

	// ---- 节点簿（右上角节点信息区；一次一个当前节点） ---------------------------------------

	onAddNodeInput(name: keyof AddNodeForm, value: string): void {
		this.addNodeForm[name] = value;
	}

	async submitAddNode(): Promise<void> {
		this.addNodeBusy = true;
		this.addNodeError = null;
		try {
			await addSidecarNode({
				pairing_code: this.addNodeForm.code.trim(),
				server: this.addNodeForm.server.trim(),
				token: this.addNodeForm.token,
				name: this.addNodeForm.name.trim(),
			});
			// token/配对码即刻清空、不回显（与 setup 配对面同一纪律）
			this.addNodeForm = { server: "", token: "", code: "", name: "" };
			await this.refreshNodes();
		} catch (e) {
			this.addNodeForm.token = "";
			this.addNodeError = toAdminError(e);
		} finally {
			this.addNodeBusy = false;
		}
	}

	askSwitchNode(node: SidecarNode): void {
		this.nodeConfirm = { kind: "switch", node };
	}
	askDeleteNode(node: SidecarNode): void {
		this.nodeConfirm = { kind: "delete", node };
	}
	cancelNodeConfirm(): void {
		this.nodeConfirm = null;
	}

	/** 切换：进程内即时（无重启）——行内过渡态「正在切换到…」，全站数据整体重拉。 */
	async confirmSwitchNode(): Promise<void> {
		const nc = this.nodeConfirm;
		this.nodeConfirm = null;
		if (nc?.kind !== "switch") return;
		const label = nc.node.name.trim() !== "" ? nc.node.name : nc.node.server_host;
		this.switchingTo = label;
		try {
			await switchSidecarNode(nc.node.id);
			// 新楼的数据：全站缓存清空后重拉（名册/敲门/在线/邀请码都是新节点的）
			this.#clearAllBusinessData();
			await Promise.all([
				this.refreshSidecar(),
				this.refreshNodes(),
				this.refreshStatus(),
				this.refreshConnections(),
			]);
			await Promise.all([this.refreshOwners(), this.refreshKnocks(), this.refreshVisitors(), this.refreshBlocklist(), this.refreshCodes()]);
		} catch (e) {
			this.nodesError = toAdminError(e);
		} finally {
			this.switchingTo = null;
		}
	}

	/** 删除：只删本地保存的配置（当前节点 409——先切走）。 */
	async confirmDeleteNode(): Promise<void> {
		const nc = this.nodeConfirm;
		this.nodeConfirm = null;
		if (nc?.kind !== "delete") return;
		try {
			await deleteSidecarNode(nc.node.id);
			await this.refreshNodes();
		} catch (e) {
			this.nodesError = toAdminError(e);
		}
	}

	/**
	 * setup 世界的「连接已保存节点」（用户故事 C「管理本地连接」）：一次点击直达
	 * switchSidecarNode（已存节点面，零新输入），成功即 setup→ready 世界翻转
	 * （sidecar 端 switchCore 置 mode=ready）+ 业务缓存清空重拉 + 落总览。
	 */
	async connectNodeFromSetup(node: SidecarNode): Promise<void> {
		const label = node.name.trim() !== "" ? node.name : node.server_host;
		this.switchingTo = label;
		this.nodesError = null;
		try {
			await switchSidecarNode(node.id);
			this.#clearAllBusinessData();
			await this.refreshSidecar();
			await Promise.all([this.refreshNodes(), this.refreshStatus(), this.refreshConnections()]);
			await Promise.all([this.refreshOwners(), this.refreshKnocks(), this.refreshVisitors(), this.refreshBlocklist(), this.refreshCodes()]);
			location.hash = "#/overview";
			this.hash = "#/overview";
		} catch (e) {
			this.nodesError = toAdminError(e);
		} finally {
			this.switchingTo = null;
		}
	}

	#clearAllBusinessData(): void {
		this.statusData = null;
		this.statusError = null;
		this.connData = null;
		this.connError = null;
		this.ownersData = null;
		this.ownersError = null;
		this.knocksData = null;
		this.knocksError = null;
		this.visitorsData = null;
		this.visitorsError = null;
		this.blocklistData = null;
		this.blocklistError = null;
		this.codesData = null;
		this.codesError = null;
		this.receipt = null;
		this.disconnect = null;
		this.knockAction = null;
		this.aliasEdit = null;
		this.aliasEditError = null;
		this.aliasClearConfirm = null;
		this.onlineFilter = null;
		this.ownerForm = { fabricId: "", root: "" };
		this.visitorForm = { endpointId: "", alias: "" };
	}

	// ---- 剪贴板（回执全文 / hex 全文 / 邀请码全文共用；无权限或非安全上下文静默降级） ----

	async copyText(text: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false; // 无剪贴板权限/非安全上下文：静默降级（缩写与摘要已可见）
		}
	}
	async copyReceipt(r: Receipt): Promise<boolean> {
		return this.copyText(JSON.stringify(r, null, 2));
	}

	// ---- 导航辅助（互链/下钻/待办直达） ---------------------------------------------

	goOverview(): void {
		location.hash = "#/overview";
	}
	goTenants(): void {
		location.hash = "#/tenants";
	}
	goVisitors(): void {
		location.hash = "#/visitors";
	}
	goOnline(fabricId: string | null = null): void {
		this.onlineFilter = fabricId;
		location.hash = "#/online";
	}
	goKnocks(): void {
		this.onlineFilter = null;
		location.hash = "#/visitors";
	}
	goRegister(): void {
		location.hash = "#/tenants";
		setTimeout(() => document.getElementById("owner-fabric-input")?.focus(), 60);
	}
	goIssueCode(): void {
		location.hash = "#/tenants";
		setTimeout(() => document.getElementById("code-issue-button")?.focus(), 60);
	}
	clearFilter(): void {
		this.onlineFilter = null;
	}
	toggleDetails(open?: boolean): void {
		this.detailsOpen = open ?? !this.detailsOpen;
		if (this.detailsOpen) void this.refreshNodes();
	}
}

/** 应用单例 store（组件经 import 直接消费）。 */
export const consoleStore = new ConsoleStore();
