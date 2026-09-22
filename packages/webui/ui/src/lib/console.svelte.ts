// 应用层响应式 store（app.mjs 副作用编排的 Svelte 5 runes 移植）。
// 纯函数在 ./api ./route ./format ./hex ./copy ./terms；本文件只做状态持有与
// 副作用编排（fetch/轮询/路由/剪贴板），组件只做渲染与状态绑定。
// 关键语义（冻结契约）：
// 1. 两个世界：phase=setup 一律全屏引导；ready 才进入驾驶舱；旧 hash 收敛；
// 2. ready 态常驻轮询 /api/status 与 /api/connections（5s；页面隐藏暂停，
//    回前台即刷）——顶栏健康灯 5 秒内反映失败，切页不消失；
// 3. 断连闭环：确认 → 已下发/收敛中（1s×15 有界观测）→ 已收敛/超时未确认，
//    全程同视图；no-match 刷新在线表供核对；
// 4. 安全契约：token 提交后即刻清空、绝不回显（失败也只保留地址与配对码）；
//    剪贴板复制静默降级。
import {
	AdminError,
	disconnectByEndpoint,
	disconnectByFabric,
	fetchSidecarState,
	loadConnections,
	loadOwners,
	loadStatus,
	postConnect,
	registerOwner,
	unregisterOwner,
	type ConnectionsData,
	type OwnersData,
	type Receipt,
	type SidecarState,
	type StatusData,
} from "./api";
import { routeFor, type Route } from "./route";
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

	connConfirm = $state<ConnConfirm | null>(null);
	disconnect = $state<DisconnectState | null>(null);

	detailsOpen = $state(false);
	onlineFilter = $state<string | null>(null);

	// ---- 派生 ------------------------------------------------------------

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

	// ---- 生命周期：路由监听 + ready 态常驻轮询 ------------------------------

	#hashHandler = () => {
		this.hash = location.hash;
	};
	#statusTimer: ReturnType<typeof setInterval> | null = null;
	#connTimer: ReturnType<typeof setInterval> | null = null;
	#visHandler: (() => void) | null = null;

	start(): void {
		window.addEventListener("hashchange", this.#hashHandler);
		void this.refreshSidecar();
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
			if (visible()) void this.refreshStatus();
		};
		const tickConn = () => {
			if (visible()) void this.refreshConnections();
		};
		void this.refreshStatus();
		void this.refreshConnections();
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
		location.hash = "#/";
		this.hash = "#/";
		this.connectResult = null;
	}

	// ---- 名册：注册 / 注销 --------------------------------------------------

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
			await Promise.all([this.refreshOwners(), this.refreshStatus()]); // 名册版本/所有者数即时反映
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
			// 名册版本/所有者数 + 在线表（名下连接被一并断开）都要反映
			await Promise.all([this.refreshOwners(), this.refreshStatus(), this.refreshConnections()]);
		} catch (e) {
			this.ownersError = e as AdminError;
		} finally {
			this.ownerBusy = false;
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

	// ---- 剪贴板（回执全文 / hex 全文共用；无权限或非安全上下文静默降级） ------

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

	// ---- 导航辅助（互链/下钻/视角切换） --------------------------------------

	goOnline(fabricId: string | null = null): void {
		this.onlineFilter = fabricId;
		location.hash = "#/access/online";
	}
	changeSection(s: "roster" | "online"): void {
		if (s !== "online") this.onlineFilter = null; // 分段切换不带旧过滤；互链才带
		location.hash = s === "online" ? "#/access/online" : "#/access/roster";
	}
	goRegister(): void {
		location.hash = "#/access/roster";
		setTimeout(() => document.getElementById("owner-fabric-input")?.focus(), 60);
	}
	clearFilter(): void {
		this.onlineFilter = null;
	}
	toggleDetails(open?: boolean): void {
		this.detailsOpen = open ?? !this.detailsOpen;
	}
}

/** 应用单例 store（组件经 import 直接消费）。 */
export const consoleStore = new ConsoleStore();
