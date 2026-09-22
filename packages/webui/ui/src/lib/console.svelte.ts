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
	fetchSidecarNodes,
	fetchSidecarState,
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
	postConnect,
	registerOwner,
	renewOwner,
	revokeCode,
	revokeVisitor,
	switchSidecarNode,
	undismissKnock,
	unregisterOwner,
	type BlockEntry,
	type CodeEntry,
	type ConnectionsData,
	type KnockEntry,
	type OwnersData,
	type Receipt,
	type SidecarNode,
	type SidecarState,
	type StatusData,
	type VisitorEntry,
} from "./api";
import { routeFor, canonicalHashFor, type Route } from "./route";
import { validateHex64 } from "./hex";
import type { DisconnectPhase } from "./terms";

export const POLL_MS = 5_000;
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

	blocklistData = $state<{ blocklist: BlockEntry[] } | null>(null);
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

	detailsOpen = $state(false);
	onlineFilter = $state<string | null>(null);

	// ---- 派生 ----------------------------------------------------------------------

	get phase(): "setup" | "ready" {
		return this.sidecar !== null && this.sidecar.phase === "ready" ? "ready" : "setup";
	}
	get route(): Route {
		return routeFor(this.hash, this.phase);
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
	#visHandler: (() => void) | null = null;

	start(): void {
		window.addEventListener("hashchange", this.#hashHandler);
		this.applyHash(location.hash);
		void this.refreshSidecar();
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
			return;
		}
		this.hash = raw;
	}
	stop(): void {
		window.removeEventListener("hashchange", this.#hashHandler);
		this.#stopPolling();
	}
	#stopPolling(): void {
		if (this.#statusTimer !== null) clearInterval(this.#statusTimer);
		if (this.#connTimer !== null) clearInterval(this.#connTimer);
		if (this.#visHandler !== null) document.removeEventListener("visibilitychange", this.#visHandler);
		this.#statusTimer = this.#connTimer = null;
		this.#visHandler = null;
	}

	async refreshSidecar(): Promise<void> {
		try {
			this.sidecar = await fetchSidecarState();
			this.sidecarError = null;
		} catch (e) {
			this.sidecarError = e as AdminError;
		}
	}

	/** ready 态常驻轮询（App 壳挂载后启动；phase 非 ready 时只抓 sidecar state）。 */
	$poll(): void {
		this.#stopPolling();
		if (this.phase !== "ready") return;
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
		this.#visHandler = () => {
			if (visible()) {
				void this.refreshStatus();
				void this.refreshConnections();
			}
		};
		document.addEventListener("visibilitychange", this.#visHandler);
	}

	async refreshStatus(): Promise<void> {
		try {
			this.statusData = await loadStatus();
			this.statusError = null;
		} catch (e) {
			this.statusError = e as AdminError;
			this.statusLastFailAt = Date.now();
		}
	}
	async refreshConnections(): Promise<void> {
		try {
			this.connData = await loadConnections();
			this.connError = null;
		} catch (e) {
			this.connError = e as AdminError;
		}
	}
	async refreshOwners(): Promise<void> {
		try {
			this.ownersData = await loadOwners();
			this.ownersError = null;
		} catch (e) {
			this.ownersError = e as AdminError;
		}
	}
	async refreshKnocks(): Promise<void> {
		try {
			this.knocksData = await loadKnocks();
			this.knocksError = null;
		} catch (e) {
			this.knocksError = e as AdminError;
		}
	}
	async refreshVisitors(): Promise<void> {
		try {
			this.visitorsData = await loadVisitors();
			this.visitorsError = null;
		} catch (e) {
			this.visitorsError = e as AdminError;
		}
	}
	async refreshBlocklist(): Promise<void> {
		try {
			this.blocklistData = await loadBlocklist();
			this.blocklistError = null;
		} catch (e) {
			this.blocklistError = e as AdminError;
		}
	}
	async refreshCodes(): Promise<void> {
		try {
			this.codesData = await loadCodes();
			this.codesError = null;
		} catch (e) {
			this.codesError = e as AdminError;
		}
	}
	async refreshNodes(): Promise<void> {
		try {
			this.nodesData = await fetchSidecarNodes();
			this.nodesError = null;
		} catch (e) {
			this.nodesError = e as AdminError;
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
			this.connectResult = { ok: false, error: e as AdminError };
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
			this.ownersError = e as AdminError;
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
			this.ownersError = e as AdminError;
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
			this.ownersError = e as AdminError;
		} finally {
			this.renewBusy = false;
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
			this.knocksError = e as AdminError;
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
			this.knocksError = e as AdminError;
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
			this.blocklistError = e as AdminError;
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
			this.knocksError = e as AdminError;
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
			this.knocksError = e as AdminError;
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
			this.visitorsError = e as AdminError;
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
			this.visitorsError = e as AdminError;
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
			this.blocklistError = e as AdminError;
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
			this.codesError = e as AdminError;
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
			this.codesError = e as AdminError;
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
			const err = e as AdminError;
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
			this.addNodeError = e as AdminError;
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
			this.nodesError = e as AdminError;
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
			this.nodesError = e as AdminError;
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
