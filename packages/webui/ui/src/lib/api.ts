// 可注入 apiFetch 抽象层（自 ui/api.mjs 原样移植，webui-console design §4 r2-P2-4）。
// 1. SPA 的全部网络访问收敛到单一 transport（/api/* 业务代理面 +
//    /sidecar/* 本地控制面）——单测经 setApiFetch 注入失败态 fixture；
// 2. 错误归一镜像 client-sdk ./admin：envelope {"error":{code,message}} 优先
//    透传，无 envelope 兜底 http-<status>；传输层 reject → network；超时 → timeout；
// 3. 浏览器零凭证——Authorization 由 sidecar 注入，本层不持有 token。
// 框架无关（无 Svelte 导入），node --test 可直测。

/** 管理面错误（与 @jixo/opendweb-client-sdk ./admin AdminError 同构判别面）。 */
export class AdminError extends Error {
  /** 机器可读判别码（admin-not-enabled / unauthorized / no-match / network / timeout / no-target / http-<status> / …） */
  code: string;
  /** HTTP 状态码（网络/超时为 null） */
  status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.status = status;
  }

  /** 由非 2xx Response 归一（envelope 优先；兜底 http-<status>）。 */
  static async fromResponse(res: Response): Promise<AdminError> {
    let code: string | null = null;
    let message: string | null = null;
    try {
      const body = JSON.parse(await res.text());
      const err = body && typeof body === "object" ? body.error : null;
      if (err && typeof err === "object" && typeof err.code === "string" && typeof err.message === "string") {
        code = err.code;
        message = err.message;
      }
    } catch {
      // body 非 JSON / 空——走兜底
    }
    if (code === null) code = `http-${res.status}`;
    if (message === null) {
      message =
        res.statusText && res.statusText !== ""
          ? `HTTP ${res.status} ${res.statusText}`
          : `HTTP ${res.status}`;
    }
    return new AdminError(code, message, res.status);
  }
}

type Transport = (path: string, init?: RequestInit) => Promise<Response>;

/** 注入面：默认同源 fetch；测试以 fixture 替换（签名与 fetch 一致）。 */
let transport: Transport = defaultTransport;

/** 注入 transport 替身（单测专用）。传入 null 恢复默认。 */
export function setApiFetch(fn: Transport | null) {
  transport = fn ?? defaultTransport;
}

/** 恢复默认 transport（测试 afterEach）。 */
export function resetApiFetch() {
  transport = defaultTransport;
}

/** 默认 transport：同源 fetch + 15s 客户端超时（sidecar 上游超时 10s 的外圈）。 */
function defaultTransport(path: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(15_000);
  return fetch(path, { ...init, signal });
}

/** 传输层异常归一：TimeoutError/AbortError → timeout；其余 → network。 */
function transportError(err: unknown): AdminError {
  const name = err && typeof err === "object" ? (err as { name?: string }).name ?? null : null;
  if (name === "TimeoutError" || name === "AbortError") {
    return new AdminError("timeout", "request timed out", null);
  }
  const detail = err instanceof Error ? err.message : String(err ?? "unknown error");
  return new AdminError("network", `request failed: ${detail}`, null);
}

/** catch 边界归一（r8-P2-2）：unknown → AdminError。AdminError 原样透传，其余按
 * 传输层语义归一（timeout/network）——store/组件层不再对 caught 值 as 直断。 */
export function toAdminError(e: unknown): AdminError {
  if (e instanceof AdminError) return e;
  return transportError(e);
}

/** JSON 往返（全部网络访问的单一出口——注入点在此生效）。 */
async function jsonFetch(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await transport(path, init);
  } catch (e) {
    throw transportError(e);
  }
  if (!res.ok) throw await AdminError.fromResponse(res);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new AdminError("invalid-response", `response body is not JSON (status ${res.status})`, res.status);
  }
}

// ---- /sidecar/* 本地控制面 ----------------------------------------------------

export interface SidecarState {
  phase: "setup" | "ready";
  server_host_masked: string | null;
  insecure: boolean;
  /** home-hub 2b 增量：姿态（member=本机数据面姿态，SPA 不进 setup）；缺省 admin */
  role?: "admin" | "member";
  /** home-hub 2b 增量：hub 本机自动形态（row 2——中枢视角/中枢状态卡数据源） */
  hub_local?: boolean;
}

/** SidecarState 结构守卫（r8-P2-2 API 边界校验）：畸形 JSON 不进组件状态。 */
function parseSidecarState(v: unknown): SidecarState {
  const bad = () => new AdminError("invalid-response", "sidecar state response malformed");
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  if (o.phase !== "setup" && o.phase !== "ready") throw bad();
  if (o.server_host_masked !== null && typeof o.server_host_masked !== "string") throw bad();
  if (typeof o.insecure !== "boolean") throw bad();
  if (o.role !== undefined && o.role !== "admin" && o.role !== "member") throw bad();
  if (o.hub_local !== undefined && typeof o.hub_local !== "boolean") throw bad();
  return {
    phase: o.phase,
    server_host_masked: o.server_host_masked,
    insecure: o.insecure,
    ...(o.role !== undefined ? { role: o.role } : {}),
    ...(o.hub_local !== undefined ? { hub_local: o.hub_local } : {}),
  };
}

/** GET /sidecar/state → {phase, server_host_masked, insecure}（经边界结构校验）。 */
export function fetchSidecarState(): Promise<SidecarState> {
  return jsonFetch("/sidecar/state").then(parseSidecarState);
}

// ---- /sidecar/nodes* 本地控制面（server-access-roles 节点簿；响应零 token） ------

export interface SidecarNode {
  id: string;
  name: string;
  server_host: string;
  added_at: number;
  current: boolean;
}

/** GET /sidecar/nodes → {nodes:[{id,name,server_host,added_at,current}]}。 */
export function fetchSidecarNodes(): Promise<{ nodes: SidecarNode[] }> {
  return jsonFetch("/sidecar/nodes") as Promise<{ nodes: SidecarNode[] }>;
}

/**
 * POST /sidecar/nodes（添加节点：{pairing_code, server, token, name?}）。
 * 配对码只出现在终端；token 仅随本请求走一次，调用方提交后必须清空输入框。
 */
export function addSidecarNode(payload: { pairing_code: string; server: string; token: string; name?: string }): Promise<{ node: SidecarNode }> {
  return jsonFetch("/sidecar/nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) as Promise<{ node: SidecarNode }>;
}

/**
 * POST /sidecar/nodes/switch {node_id}：唯一被许可的运行时重指向通道——
 * 仅接受已存 node_id（任何 URL/host 字段 400）；进程内原子切换（无重启）。
 */
export function switchSidecarNode(nodeId: string): Promise<{ ok: boolean; node: SidecarNode }> {
  return jsonFetch("/sidecar/nodes/switch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node_id: nodeId }),
  }) as Promise<{ ok: boolean; node: SidecarNode }>;
}

/** DELETE /sidecar/nodes/{id}（当前节点 409——先切走）。 */
export function deleteSidecarNode(nodeId: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/sidecar/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" }) as Promise<{ ok: boolean }>;
}

/**
 * POST /sidecar/connect（配对面提交 {pairing_code, server, token}）。
 * 失败码：bad-pairing / bad-origin-host / bad-target / invalid-request /
 * target-frozen。token 仅随本请求走一次，调用方提交后必须清空输入框。
 */
export function postConnect(payload: { pairing_code: string; server: string; token: string }): Promise<unknown> {
  return jsonFetch("/sidecar/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---- /sidecar 本机数据面（home-hub 2b：leases/visits/hub/probe/label） ----------

/** 租约条目投影（GET /sidecar/leases；expires_in=本地快照倒计时毫秒）。 */
export interface LeaseEntry {
  id: string;
  server: string;
  relay_url: string;
  server_id: string | null;
  fabric_id: string;
  root: string;
  alias: string | null;
  label: string | null;
  registered_at: number;
  expires_at: number;
  expires_in: number | null;
  receipt: { ts: number; generation: number; code_hash: string; receipt_sig: string } | null;
}

/** GET /sidecar/leases → {leases:[…]}。 */
export function fetchSidecarLeases(): Promise<{ leases: LeaseEntry[] }> {
  return jsonFetch("/sidecar/leases") as Promise<{ leases: LeaseEntry[] }>;
}

/** 到访条目投影（GET /sidecar/visits；best-effort 账本）。 */
export interface VisitEntry {
  server: string;
  server_id: string | null;
  first_visit_at: number;
  last_visit_at: number | null;
  last_probe: { result: "reachable" | "unreachable"; detail?: string; at: number };
  note: string | null;
}

/** GET /sidecar/visits → {visits:[…]}。 */
export function fetchSidecarVisits(): Promise<{ visits: VisitEntry[] }> {
  return jsonFetch("/sidecar/visits") as Promise<{ visits: VisitEntry[] }>;
}

/** POST /sidecar/visits/probe {server} → {probe, entry}（五类映射 + 落账）。 */
export function probeSidecarVisit(server: string): Promise<{ probe: { result: "reachable" | "unreachable"; detail: string | null; at: number }; entry: VisitEntry }> {
  return jsonFetch("/sidecar/visits/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server }),
  }) as Promise<{ probe: { result: "reachable" | "unreachable"; detail: string | null; at: number }; entry: VisitEntry }>;
}

/** PATCH /sidecar/leases/{id}/label {label: string|null}（空串语义在客户端先行归一为 null）。 */
export function patchSidecarLeaseLabel(id: string, label: string | null): Promise<{ lease: LeaseEntry }> {
  return jsonFetch(`/sidecar/leases/${encodeURIComponent(id)}/label`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  }) as Promise<{ lease: LeaseEntry }>;
}

/** hub.json 投影 + 接入卡片模型（GET /sidecar/hub；无 hub.json=404 → AdminError）。 */
export interface HubData {
  version: number;
  machine: string;
  urls: string[];
  primary_url: string;
  short_code: string;
  qr_svg: string;
  gateway_bind: string;
  running: boolean;
}

/** GET /sidecar/hub（调用方以 404 判定「这台设备没有中枢身份」）。 */
export function fetchSidecarHub(): Promise<HubData> {
  return jsonFetch("/sidecar/hub") as Promise<HubData>;
}

// ---- /sidecar/plugins* WebUI 插件控制面（webui-plugin-kernel Phase 0） -----------

/** 插件页声明（服务端 descriptor 投影；与宿主契约 webuiApi 1 同形）。 */
export interface WebuiPluginPageMeta {
  id: string;
  title: string;
  nav: string | null;
  icon: string | null;
  type: "settings" | "page";
  perspective: "admin" | "member" | "both";
}

export interface PluginConfigSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "boolean" }>;
  required?: string[];
}

export type PluginConfigValues = Record<string, string | number | boolean>;

/** 插件投影（注册表条目 + 生命周期状态 + 配置面）。 */
export interface WebuiPluginEntry {
  id: string;
  webui_api: 1;
  status: "registered" | "enabled" | "disabled";
  pages: WebuiPluginPageMeta[];
  config_schema: PluginConfigSchema;
  config: PluginConfigValues;
}

/** GET /sidecar/plugins 投影（面板数据源；零凭证面——无任何秘密字段）。 */
export interface PluginsData {
  plugins: WebuiPluginEntry[];
  coming_soon: Array<{ id: string }>;
  external_webui_plugins: { available: boolean; note: string };
}

/** GET /sidecar/plugins（读路由——基线 Host 守卫）。 */
export function fetchSidecarPlugins(): Promise<PluginsData> {
  return jsonFetch("/sidecar/plugins") as Promise<PluginsData>;
}

/** POST /sidecar/plugins/<id>/enable（写路由——浏览器 same-origin 自动带 Origin）。 */
export function enableSidecarPlugin(id: string): Promise<{ plugin: WebuiPluginEntry }> {
  return jsonFetch(`/sidecar/plugins/${encodeURIComponent(id)}/enable`, { method: "POST" }) as Promise<{ plugin: WebuiPluginEntry }>;
}

/** POST /sidecar/plugins/<id>/disable（停用按序执行：摘牌→drain→dispose→落盘）。 */
export function disableSidecarPlugin(id: string): Promise<{ plugin: WebuiPluginEntry }> {
  return jsonFetch(`/sidecar/plugins/${encodeURIComponent(id)}/disable`, { method: "POST" }) as Promise<{ plugin: WebuiPluginEntry }>;
}

/** GET /sidecar/plugins/<id>/config。 */
export function fetchSidecarPluginConfig(id: string): Promise<{ config: PluginConfigValues }> {
  return jsonFetch(`/sidecar/plugins/${encodeURIComponent(id)}/config`) as Promise<{ config: PluginConfigValues }>;
}

/** PUT /sidecar/plugins/<id>/config（值经服务端 configSchema 校验；未知键 400）。 */
export function putSidecarPluginConfig(id: string, config: PluginConfigValues): Promise<{ config: PluginConfigValues }> {
  return jsonFetch(`/sidecar/plugins/${encodeURIComponent(id)}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  }) as Promise<{ config: PluginConfigValues }>;
}

// ---- /sidecar/plugins/<id>/<mgmt> 三插件管理面（webui-plugin-kernel 收官接线） ----

// ports：映射账本 + listener 态（runtime.listMappings 投影——MappingsPage 行形状）

export interface PortsMappingRow {
	id: string;
	name: string;
	/** 对端 endpointId */
	peer: string;
	remotePort: number;
	localPort: number;
	enabled: boolean;
	listener: "listening" | "stopped" | "failed" | "stopping";
	error: string | null;
}

/** GET /sidecar/plugins/ports/mappings（读路由——基线 Host 守卫）。 */
export function fetchPortsMappings(): Promise<{ mappings: PortsMappingRow[] }> {
	return jsonFetch("/sidecar/plugins/ports/mappings") as Promise<{ mappings: PortsMappingRow[] }>;
}

/** POST /sidecar/plugins/ports/mappings（写路由——精确 Origin）。 */
export function createPortsMapping(input: {
	name: string;
	peer: string;
	remotePort: number;
	localPort: number;
}): Promise<{ mapping: PortsMappingRow }> {
	return jsonFetch("/sidecar/plugins/ports/mappings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	}) as Promise<{ mapping: PortsMappingRow }>;
}

/** POST /sidecar/plugins/ports/mappings/<id>/enabled {enabled}。 */
export function setPortsMappingEnabled(id: string, enabled: boolean): Promise<{ mapping: PortsMappingRow }> {
	return jsonFetch(`/sidecar/plugins/ports/mappings/${encodeURIComponent(id)}/enabled`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled }),
	}) as Promise<{ mapping: PortsMappingRow }>;
}

/** DELETE /sidecar/plugins/ports/mappings/<id>。 */
export function deletePortsMapping(id: string): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/ports/mappings/${encodeURIComponent(id)}`, { method: "DELETE" }) as Promise<{ ok: true }>;
}

/** ports 提供侧授权条目（(peer, remotePort) 显式授权）。 */
export interface PortsAllowEntry {
	peer: string;
	remotePort: number;
	granted_at: number;
}

/** GET /sidecar/plugins/ports/allowlist。 */
export function fetchPortsAllowlist(): Promise<{ version: 1; entries: PortsAllowEntry[] }> {
	return jsonFetch("/sidecar/plugins/ports/allowlist") as Promise<{ version: 1; entries: PortsAllowEntry[] }>;
}

/** POST /sidecar/plugins/ports/allowlist {peer, remotePort}（授予）。 */
export function grantPortsAccess(peer: string, remotePort: number): Promise<{ ok: true }> {
	return jsonFetch("/sidecar/plugins/ports/allowlist", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ peer, remotePort }),
	}) as Promise<{ ok: true }>;
}

/** POST /sidecar/plugins/ports/allowlist/revoke {peer, remotePort}（回收）。 */
export function revokePortsAccess(peer: string, remotePort: number): Promise<{ ok: true }> {
	return jsonFetch("/sidecar/plugins/ports/allowlist/revoke", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ peer, remotePort }),
	}) as Promise<{ ok: true }>;
}

// files：提供侧共享账本 + B 侧 bridge（浏览器→sidecar→fabric fetchHttp）

export interface FilesShareRow {
	id: string;
	name: string;
	root: string;
	mode: "ro" | "rw";
	peers: string[];
	created: number;
}

/** GET /sidecar/plugins/files/shares。 */
export function fetchFilesShares(): Promise<{ shares: FilesShareRow[] }> {
	return jsonFetch("/sidecar/plugins/files/shares") as Promise<{ shares: FilesShareRow[] }>;
}

/** POST /sidecar/plugins/files/shares {name, root, mode?, peers?}（默认 ro）。 */
export function createFilesShare(input: {
	name: string;
	root: string;
	mode?: "ro" | "rw";
	peers?: string[];
}): Promise<{ share: FilesShareRow }> {
	return jsonFetch("/sidecar/plugins/files/shares", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	}) as Promise<{ share: FilesShareRow }>;
}

/** DELETE /sidecar/plugins/files/shares/<id>。 */
export function deleteFilesShare(id: string): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/files/shares/${encodeURIComponent(id)}`, { method: "DELETE" }) as Promise<{ ok: true }>;
}

/** POST /sidecar/plugins/files/shares/<id>/mode {mode}。 */
export function setFilesShareMode(id: string, mode: "ro" | "rw"): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/files/shares/${encodeURIComponent(id)}/mode`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mode }),
	}) as Promise<{ ok: true }>;
}

/** POST /sidecar/plugins/files/shares/<id>/peers {peers}。 */
export function setFilesSharePeers(id: string, peers: string[]): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/files/shares/${encodeURIComponent(id)}/peers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ peers }),
	}) as Promise<{ ok: true }>;
}

/** files bridge 信封（B 侧 wire 转发——路径钉死 /wpk1/files/<shareId>/）。 */
export interface FilesBridgeRequest {
	peer: string;
	shareId: string;
	method: "GET" | "PUT" | "POST";
	path: string;
	headers?: Array<{ name: string; value: string }>;
	body?: Uint8Array | null;
}

/** files bridge 响应（fetchHttp 投影——body 经 base64 过 JSON 面）。 */
export interface FilesBridgeResponse {
	status: number;
	headers: Record<string, string>;
	bodyBase64: string;
}

/** POST /sidecar/plugins/files/bridge（wire 信封转发；bridge 错误=502 envelope）。 */
export async function filesBridge(req: FilesBridgeRequest): Promise<FilesBridgeResponse> {
	return (await jsonFetch("/sidecar/plugins/files/bridge", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			peer: req.peer,
			shareId: req.shareId,
			method: req.method,
			path: req.path,
			...(req.headers !== undefined ? { headers: req.headers } : {}),
			...(req.body != null ? { bodyBase64: bytesToBase64(req.body) } : {}),
		}),
	})) as FilesBridgeResponse;
}

/** Uint8Array → base64（分块过 btoa——大分片不爆 String.fromCharCode 栈）。 */
function bytesToBase64(bytes: Uint8Array): string {
	let out = "";
	const CH = 0x8000;
	for (let i = 0; i < bytes.length; i += CH) {
		out += String.fromCharCode(...bytes.subarray(i, i + CH));
	}
	return btoa(out);
}

/** base64 → Uint8Array（bridge 响应体解码）。 */
export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// sync：组账本/状态/冲突/seed（投影形状=GroupView/JobView/ConflictSessionView 同构——
// 服务端 runtime.listGroups/status()/conflicts() 直投）

export type SyncMode = "oneway" | "twoway";

export interface SyncMemberRow {
	endpointId: string;
	deviceName: string;
}

export interface SyncRootRow {
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

export interface SyncGroupRow {
	id: string;
	name: string;
	members: SyncMemberRow[];
	roots: SyncRootRow[];
	self: SyncMemberRow;
}

export interface SyncJobRow {
	groupId: string;
	rootId: string;
	phase: "idle" | "scanning" | "fetching" | "merging" | "conflicted" | "pushing" | "done" | "error";
	error: { code: string; message: string; hint?: string } | null;
	progress: { fetched: number; fetchTotal: number; bytes: number };
	updatedAt: number;
}

/** 建组草稿（GroupsPage 表单 → 服务端组装 members=[self, peer]）。 */
export interface SyncGroupDraft {
	name: string;
	peerEndpointId: string;
	peerDeviceName: string;
	roots: Array<{ localPath: string; mode: SyncMode; seedAuthority: string }>;
}

/** GET /sidecar/plugins/sync/groups。 */
export function fetchSyncGroups(): Promise<{ groups: SyncGroupRow[] }> {
	return jsonFetch("/sidecar/plugins/sync/groups") as Promise<{ groups: SyncGroupRow[] }>;
}

/** POST /sidecar/plugins/sync/groups（seedAuthority "self" 在服务端解析为本端）。 */
export function createSyncGroup(draft: SyncGroupDraft): Promise<{ group: SyncGroupRow }> {
	return jsonFetch("/sidecar/plugins/sync/groups", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(draft),
	}) as Promise<{ group: SyncGroupRow }>;
}

/** DELETE /sidecar/plugins/sync/groups/<id>。 */
export function deleteSyncGroup(id: string): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/sync/groups/${encodeURIComponent(id)}`, { method: "DELETE" }) as Promise<{ ok: true }>;
}

/** POST /sidecar/plugins/sync/groups/<id>/sync-now（要求插件 enabled）。 */
export function syncNow(id: string): Promise<{ results: Array<{ rootId: string; result: unknown }> }> {
	return jsonFetch(`/sidecar/plugins/sync/groups/${encodeURIComponent(id)}/sync-now`, { method: "POST" }) as Promise<{
		results: Array<{ rootId: string; result: unknown }>;
	}>;
}

/** GET /sidecar/plugins/sync/status。 */
export function fetchSyncStatus(): Promise<{ jobs: SyncJobRow[] }> {
	return jsonFetch("/sidecar/plugins/sync/status") as Promise<{ jobs: SyncJobRow[] }>;
}

/** GET /sidecar/plugins/sync/conflicts?group=&root=（无会话= {session: null}）。 */
export function fetchSyncConflicts(groupId: string, rootId: string): Promise<{ session: unknown }> {
	return jsonFetch(
		`/sidecar/plugins/sync/conflicts?group=${encodeURIComponent(groupId)}&root=${encodeURIComponent(rootId)}`,
	) as Promise<{ session: unknown }>;
}

/** POST /sidecar/plugins/sync/conflicts/<g>/<r>/resolve {decisions}。 */
export function resolveSyncConflicts(groupId: string, rootId: string, decisions: unknown): Promise<unknown> {
	return jsonFetch(
		`/sidecar/plugins/sync/conflicts/${encodeURIComponent(groupId)}/${encodeURIComponent(rootId)}/resolve`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ decisions }),
		},
	);
}

/** GET /sidecar/plugins/sync/seed-block?group=&root=（无阻断= {block: null}）。 */
export function fetchSyncSeedBlock(groupId: string, rootId: string): Promise<{ block: unknown }> {
	return jsonFetch(
		`/sidecar/plugins/sync/seed-block?group=${encodeURIComponent(groupId)}&root=${encodeURIComponent(rootId)}`,
	) as Promise<{ block: unknown }>;
}

/** POST /sidecar/plugins/sync/seed-block/<g>/<r>/resolve（adopt-seed 显式处置）。 */
export function resolveSyncSeedBlock(groupId: string, rootId: string): Promise<unknown> {
	return jsonFetch(
		`/sidecar/plugins/sync/seed-block/${encodeURIComponent(groupId)}/${encodeURIComponent(rootId)}/resolve`,
		{ method: "POST" },
	);
}

// ---- /sidecar/plugins/ai/* 管理面（ai-subscription-sharing Phase C——提供方
// ---- 服务/分组/密钥/配额/用量/导入 + 消费方钥环/目录/本地端点） -------------------
// 凭证纪律：密钥原文只出现在签发（issueAiKey）与链接（createAiLink）的**一次性
// 响应体**（本地面显式复制）；一切列表/usage 投影恒掩码。控制面请求体携带 secret
// 值（写路由 same-origin Origin 内——与 CLI 同位），绝不进 URL query。

/** 服务管理面投影（detail=脱敏披露——auth 槽/脚本位恒掩码 ●）。 */
export interface AiServiceRow {
	serviceId: string;
	name: string;
	enabled: boolean;
	upstream: string;
	defaultPort?: number;
	keyEnv?: string;
	/** 预设 keyEnv 是否已绑定 secret（未绑定不可启用——§4 ③） */
	authBound?: boolean;
	detail: Record<string, unknown>;
	groups: string[];
}

export interface AiGroupRow {
	name: string;
	serviceIds: string[];
	serviceNames: string[];
	limits?: { maxConcurrency?: number; dailyRequests?: number };
}

/** 密钥行（无原文——status 三态 active/revoked 呈现撤钥语义）。 */
export interface AiKeyRow {
	keyId: string;
	group: string;
	name: string;
	createdAt: number;
	revokedAt?: number;
	status: "active" | "revoked";
}

export interface AiOverviewData {
	services: AiServiceRow[];
	groups: AiGroupRow[];
	keys: AiKeyRow[];
	secrets: Array<{ name: string; createdAt: number; updatedAt: number }>;
	hooks: Array<{ name: string; source: string; stages: string[] }>;
	config: { maxConcurrency?: number; dailyRequests?: number; usageLog?: boolean };
	plane: { epoch: string; inflight: number } | null;
}

/** GET /sidecar/plugins/ai/overview（读路由——基线 Host 守卫）。 */
export function fetchAiOverview(): Promise<AiOverviewData> {
	return jsonFetch("/sidecar/plugins/ai/overview") as Promise<AiOverviewData>;
}

/** 预设（17 可启用 + codex 占位——disabled=true 项不可选）。 */
export interface AiPreset {
	id: string;
	label: string;
	apiForm: string;
	baseUrl: string;
	keyEnv?: string;
	defaultPort?: number;
	matchDomains?: string[];
	notes?: string;
	disabled?: boolean;
	requires?: string;
}

/** GET /sidecar/plugins/ai/presets。 */
export function fetchAiPresets(): Promise<{ presets: AiPreset[] }> {
	return jsonFetch("/sidecar/plugins/ai/presets") as Promise<{ presets: AiPreset[] }>;
}

/** 用量元数据聚合（零凭证零正文）。 */
export interface AiUsageData {
	enabled: boolean;
	totals: { requests: number; bytes: number };
	byKey: Array<{ keyId: string; requests: number; bytes: number }>;
	byService: Array<{ serviceId: string; requests: number; bytes: number }>;
	quotaDay: { date: string; counts: Record<string, number> } | null;
	recent: Array<{ ts: number; keyId: string; serviceId: string; status: number | string; bytes: number }>;
}

/** GET /sidecar/plugins/ai/usage。 */
export function fetchAiUsage(): Promise<AiUsageData> {
	return jsonFetch("/sidecar/plugins/ai/usage") as Promise<AiUsageData>;
}

/** POST /sidecar/plugins/ai/services（预设或自定义 ServiceInput；写路由）。 */
export function createAiService(input: {
	preset?: string;
	name?: string;
	auth?: Record<string, unknown>;
	defaultPort?: number;
	enabled?: boolean;
	service?: Record<string, unknown>;
}): Promise<{ service: AiServiceRow }> {
	return jsonFetch("/sidecar/plugins/ai/services", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	}) as Promise<{ service: AiServiceRow }>;
}

/** PATCH /sidecar/plugins/ai/services/<id>（启停 / auth 重绑——预设变更面）。 */
export function patchAiService(serviceId: string, patch: { enabled?: boolean; auth?: Record<string, unknown> | null }): Promise<{ service: AiServiceRow }> {
	return jsonFetch(`/sidecar/plugins/ai/services/${encodeURIComponent(serviceId)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	}) as Promise<{ service: AiServiceRow }>;
}

/** DELETE /sidecar/plugins/ai/services/<id>。 */
export function deleteAiService(serviceId: string): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/ai/services/${encodeURIComponent(serviceId)}`, { method: "DELETE" }) as Promise<{ ok: true }>;
}

/** POST /sidecar/plugins/ai/groups。 */
export function createAiGroup(input: { name: string; serviceNames?: string[]; limits?: { maxConcurrency?: number; dailyRequests?: number } }): Promise<{ group: AiGroupRow }> {
	return jsonFetch("/sidecar/plugins/ai/groups", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	}) as Promise<{ group: AiGroupRow }>;
}

/** PATCH /sidecar/plugins/ai/groups/<name>（服务引用整表替换/限额变更；limits:null=清除）。 */
export function patchAiGroup(name: string, patch: { serviceNames?: string[]; limits?: { maxConcurrency?: number; dailyRequests?: number } | null }): Promise<{ group: AiGroupRow }> {
	return jsonFetch(`/sidecar/plugins/ai/groups/${encodeURIComponent(name)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	}) as Promise<{ group: AiGroupRow }>;
}

/** DELETE /sidecar/plugins/ai/groups/<name>（仍有未撤密钥=409）。 */
export function deleteAiGroup(name: string): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/ai/groups/${encodeURIComponent(name)}`, { method: "DELETE" }) as Promise<{ ok: true }>;
}

/** 签发密钥（原文仅本响应体一次性出现——本地面显式复制）。 */
export function issueAiKey(input: { group: string; name?: string }): Promise<{ keyId: string; key: string; createdAt: number }> {
	return jsonFetch("/sidecar/plugins/ai/keys", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	}) as Promise<{ keyId: string; key: string; createdAt: number }>;
}

/** DELETE /sidecar/plugins/ai/keys/<keyId>（撤钥——幂等；在途 rid 按授权快照续拉）。 */
export function revokeAiKey(keyId: string): Promise<{ keyId: string; status: "revoked"; revokedAt: number }> {
	return jsonFetch(`/sidecar/plugins/ai/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" }) as Promise<{
		keyId: string;
		status: "revoked";
		revokedAt: number;
	}>;
}

/** POST /sidecar/plugins/ai/secrets（值不回显——响应只含名称/时间戳）。 */
export function setAiSecret(name: string, value: string): Promise<{ secret: { name: string; createdAt: number; updatedAt: number } }> {
	return jsonFetch("/sidecar/plugins/ai/secrets", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, value }),
	}) as Promise<{ secret: { name: string; createdAt: number; updatedAt: number } }>;
}

/** DELETE /sidecar/plugins/ai/secrets/<name>。 */
export function deleteAiSecret(name: string): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/ai/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }) as Promise<{ ok: true }>;
}

/** aifly1. 分享链接（原文内嵌密钥——仅本响应体一次性出现）。 */
export function createAiLink(input: { group: string; recipient: string; keyId?: string; name?: string }): Promise<{ link: string; keyId: string; group: string; services: number; recipient: string; note: string }> {
	return jsonFetch("/sidecar/plugins/ai/link", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	}) as Promise<{ link: string; keyId: string; group: string; services: number; recipient: string; note: string }>;
}

/** 两阶段导入·阶段一（扫描——ready 不回显 ServiceInput，blocked 列 $env 引用）。 */
export function stageAiImport(rawText: string): Promise<{
	blocked: Array<{ service: string; field: string; ref: string; varName?: string; reason?: string }>;
	ready: Array<{ name: string }>;
}> {
	return jsonFetch("/sidecar/plugins/ai/import-stage", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ rawText }),
	}) as Promise<{
		blocked: Array<{ service: string; field: string; ref: string; varName?: string; reason?: string }>;
		ready: Array<{ name: string }>;
	}>;
}

/** 两阶段导入·阶段二（$env→secret 映射 + 原子 commit）。 */
export function commitAiImport(input: { rawText: string; mappings: Record<string, string>; groupName?: string }): Promise<{ added: string[]; group?: string }> {
	return jsonFetch("/sidecar/plugins/ai/import-commit", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	}) as Promise<{ added: string[]; group?: string }>;
}

/** 消费方钥环投影（密钥恒掩码——长度指纹）。 */
export interface AiConsumerData {
	providers: Array<{
		endpointId: string;
		alias: string;
		keys: Array<{ keyId: string; group: string; masked: string }>;
		services: Array<Record<string, unknown>>;
	}>;
	endpoints: AiConsumerEndpointRow[];
}

/** 消费方本地端点行（listener 运行态）。 */
export interface AiConsumerEndpointRow {
	id: string;
	providerEndpointId: string;
	serviceId: string;
	name: string;
	port: number;
	createdAt: number;
	listener: "listening" | "stopped";
}

/** GET /sidecar/plugins/ai/consumer。 */
export function fetchAiConsumer(): Promise<AiConsumerData> {
	return jsonFetch("/sidecar/plugins/ai/consumer") as Promise<AiConsumerData>;
}

/** POST /sidecar/plugins/ai/consumer/import（贴 aifly1. 链接——钥环不回显原文）。 */
export function importAiLink(link: string): Promise<{ provider: { alias: string; endpointId: string }; group: string; keyId: string; keyMasked: string; services: number }> {
	return jsonFetch("/sidecar/plugins/ai/consumer/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ link }),
	}) as Promise<{ provider: { alias: string; endpointId: string }; group: string; keyId: string; keyMasked: string; services: number }>;
}

/** POST /sidecar/plugins/ai/consumer/add-key（裸密钥入环——需已导入提供者）。 */
export function addAiConsumerKey(key: string, providerRef: string): Promise<{ added: boolean; provider: { alias: string; endpointId: string } }> {
	return jsonFetch("/sidecar/plugins/ai/consumer/add-key", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key, providerRef }),
	}) as Promise<{ added: boolean; provider: { alias: string; endpointId: string } }>;
}

/** POST /sidecar/plugins/ai/consumer/refresh（AUTH 回填 + catalog 快照刷新）。 */
export function refreshAiConsumer(providerRef?: string): Promise<{ results: Array<{ ok: boolean; endpointId?: string; alias?: string; error?: string }> }> {
	return jsonFetch("/sidecar/plugins/ai/consumer/refresh", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(providerRef === undefined ? {} : { providerRef }),
	}) as Promise<{ results: Array<{ ok: boolean; endpointId?: string; alias?: string; error?: string }> }>;
}

/** POST /sidecar/plugins/ai/consumer/endpoints（端口冲突=真实报错——不静默换端口）。 */
export function startAiConsumerEndpoint(input: { providerEndpointId: string; serviceId: string; port: number }): Promise<{ id: string; endpoint: AiConsumerEndpointRow }> {
	return jsonFetch("/sidecar/plugins/ai/consumer/endpoints", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	}) as Promise<{ id: string; endpoint: AiConsumerEndpointRow }>;
}

/** DELETE /sidecar/plugins/ai/consumer/endpoints/<id>。 */
export function stopAiConsumerEndpoint(id: string): Promise<{ ok: true }> {
	return jsonFetch(`/sidecar/plugins/ai/consumer/endpoints/${encodeURIComponent(id)}`, { method: "DELETE" }) as Promise<{ ok: true }>;
}

// ---- claude-code 写手 + 上游探活（ai-subscription-sharing Phase D） ------------------

/** claude-code 写手预览（不写盘；tokenSha256=sha256(diff)——apply 前置确认令牌）。 */
export interface AiWriterPreview {
	endpointId: string;
	agent: "claude-code";
	path: string;
	exists: boolean;
	baseUrl: string;
	before: string | null;
	after: string;
	diff: string;
	tokenSha256: string;
}

/** POST /sidecar/plugins/ai/consumer/writer/preview（真实凭证绝不入产物——token 恒占位符）。 */
export function previewAiWriter(endpointId: string): Promise<AiWriterPreview> {
	return jsonFetch("/sidecar/plugins/ai/consumer/writer/preview", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ endpointId }),
	}) as Promise<AiWriterPreview>;
}

/** POST /sidecar/plugins/ai/consumer/writer/apply（令牌不符=409 stale-preview；预览后盘面被并发改动同样拒绝）。 */
export function applyAiWriter(endpointId: string, tokenSha256: string): Promise<{ applied: true; agent: "claude-code"; path: string; baseUrl: string }> {
	return jsonFetch("/sidecar/plugins/ai/consumer/writer/apply", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ endpointId, tokenSha256 }),
	}) as Promise<{ applied: true; agent: "claude-code"; path: string; baseUrl: string }>;
}

/** 上游探活三态结果（脱敏投影——零头表零原始错误文案）。 */
export interface AiServiceProbeResult {
	serviceId: string;
	name: string;
	state: "reachable" | "unreachable" | "no_auth";
	/** reachable：上游应答的 HTTP 状态（任意状态即达）。 */
	status?: number;
	/** unreachable/no_auth：原因码（upstream_unreachable/timeout/hook_failed/path_not_offered/protocol_error | keyenv_unbound/secret_missing）。 */
	reason?: string;
	/** no_auth(keyenv_unbound)：待绑定的环境变量名提示。 */
	keyEnv?: string;
	ms: number;
}

/** POST /sidecar/plugins/ai/services/<id>/probe（provider 本机经同一 hook 管线发最小请求，超时 5s）。 */
export function probeAiService(serviceId: string): Promise<AiServiceProbeResult> {
	return jsonFetch(`/sidecar/plugins/ai/services/${encodeURIComponent(serviceId)}/probe`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	}) as Promise<AiServiceProbeResult>;
}


// ---- /api/* 业务代理面（wire 冻结于 sdk-mgmt-surface specs/server） -----------

/** GET /api/status → {mode, policy, generation, active_connections[], …} */
export function loadStatus(): Promise<StatusData> {
  return jsonFetch("/api/status") as Promise<StatusData>;
}

export interface OwnerEntry {
  fabric_id: string;
  root: string;
  registered_at: number;
  /** 三角色增量（旧服务端无这些字段 = 永久/无别名；未知字段忽略规则延续） */
  alias?: string | null;
  note?: string | null;
  expires_at?: number | null;
  /** 剩余毫秒（服务端投影；客户端亦可由 expires_at 推导） */
  expires_in?: number | null;
  status?: "active" | "expired";
}

export interface OwnersData {
  generation: number;
  owners: OwnerEntry[];
}

/** GET /api/owners → {generation, owners:[{fabric_id, root, registered_at}]} */
export function loadOwners(): Promise<OwnersData> {
  return jsonFetch("/api/owners") as Promise<OwnersData>;
}

export interface ConnectionsData {
  mode: string;
  policy?: string;
  relay_enabled: boolean;
  quota: { configured?: boolean; max_connections_per_owner?: number };
  /**
   * 每端点在线投影。home-hub G-3 增量位 `link`：服务端将来携带 "direct"|"relay"
   * 时 UI 标「直连中/借道中」；当前服务端 wire 无此字段——缺失即不标（如实
   * 呈现，不虚构链路状态）。
   */
  per_endpoint: { endpoint_id: string; fabric_id: string; connections: number; link?: string }[];
  per_owner: { fabric_id: string; connections: number }[];
  /** 三角色增量：访客在线投影（fabric=None 的连接；endpoint_id 字典序） */
  per_visitor?: { endpoint_id: string; connections: number; link?: string }[];
}

/** GET /api/connections → {mode, relay_enabled, quota{}, per_endpoint[], per_owner[], per_visitor?[]} */
export function loadConnections(): Promise<ConnectionsData> {
  return jsonFetch("/api/connections") as Promise<ConnectionsData>;
}

export interface StatusData {
  mode: string;
  policy: string;
  generation: number;
  max_connections_per_owner?: number;
  active_connections: { endpoint_id: string; fabric_id: string; connections: number }[];
  per_owner_connections?: { fabric_id: string; connections: number }[];
  relay_enabled?: boolean;
  /** 三角色增量（旧服务端无这些字段；总览四问的数据源） */
  knocks_pending?: number;
  visitors_active?: number;
  codes_active?: number;
  visitors_online?: number;
}

/** POST /api/owners（注册 (fabric_id, root)）→ 回执。入参先过 hex64 客户端校验。 */
export function registerOwner(fabricId: string, root: string): Promise<Receipt> {
  return jsonFetch("/api/owners", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fabric_id_hex: fabricId, root_hex: root }),
  }) as Promise<Receipt>;
}

/** DELETE /api/owners/{fabric_id}/{root} → 注销回执（kicked_* 计数）。 */
export function unregisterOwner(fabricId: string, root: string): Promise<Receipt> {
  return jsonFetch(`/api/owners/${fabricId}/${root}`, { method: "DELETE" }) as Promise<Receipt>;
}

export interface Receipt {
  op: "register" | "unregister" | "disconnect" | string;
  fabric_id?: string;
  root?: string;
  endpoint_id?: string;
  ts: number;
  generation: number;
  receipt_sig: string;
  kicked_connections?: number;
}

/** POST /api/connections/disconnect（恰好其一）→ {disconnected[], receipts[]}。 */
export function disconnectByEndpoint(endpointId: string): Promise<{ receipts: Receipt[] }> {
  return jsonFetch("/api/connections/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint_id: endpointId }),
  }) as Promise<{ receipts: Receipt[] }>;
}

/** POST /api/connections/disconnect（按 owner fabric 全量断开）。 */
export function disconnectByFabric(fabricId: string): Promise<{ receipts: Receipt[] }> {
  return jsonFetch("/api/connections/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fabric_id: fabricId }),
  }) as Promise<{ receipts: Receipt[] }>;
}

// ---- 三角色业务面（server-access-roles specs/webui 路径契约：一律 /api/* → /admin/*） ---

export interface KnockEntry {
  endpoint_id: string;
  seq: number;
  first_at: number;
  last_at: number;
  count: number;
  last_reason: string;
  dismissed?: boolean;
}

export interface KnocksData {
  knocks: KnockEntry[];
  pending_count: number;
}

/** GET /api/knocks（排序冻结：未处置在前、组内 seq 降序——以服务端 seq 为准，客户端不再排序）。 */
export function loadKnocks(): Promise<KnocksData> {
  return jsonFetch("/api/knocks") as Promise<KnocksData>;
}

/** POST /api/knocks/{endpoint_id}/dismiss（幂等；忽略 = 待办离场，门禁不变）。 */
export function dismissKnock(endpointId: string): Promise<Receipt> {
  return jsonFetch(`/api/knocks/${encodeURIComponent(endpointId)}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }) as Promise<Receipt>;
}

/** POST /api/knocks/{endpoint_id}/undismiss（幂等；toast 撤销路径）。 */
export function undismissKnock(endpointId: string): Promise<Receipt> {
  return jsonFetch(`/api/knocks/${encodeURIComponent(endpointId)}/undismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }) as Promise<Receipt>;
}

export interface VisitorEntry {
  endpoint_id: string;
  alias?: string | null;
  note?: string | null;
  granted_at: number;
  expires_at?: number | null;
}

/** GET /api/visitors → {visitors:[{endpoint_id,alias,note,granted_at,expires_at}]}。 */
export function loadVisitors(): Promise<{ visitors: VisitorEntry[] }> {
  return jsonFetch("/api/visitors") as Promise<{ visitors: VisitorEntry[] }>;
}

/** POST /api/visitors（授权访客：endpoint_id 必填；缺省=永久）。 */
export function grantVisitor(payload: { endpoint_id: string; alias?: string; note?: string; expires_in_days?: number }): Promise<Receipt> {
  return jsonFetch("/api/visitors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) as Promise<Receipt>;
}

/** POST /api/visitors/from-knock（敲门台一键定位——语义糖，等同 POST）。 */
export function grantVisitorFromKnock(payload: { endpoint_id: string; alias?: string }): Promise<Receipt> {
  return jsonFetch("/api/visitors/from-knock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) as Promise<Receipt>;
}

/** DELETE /api/visitors/{endpoint_id}（移出访客名册）。 */
export function revokeVisitor(endpointId: string): Promise<Receipt> {
  return jsonFetch(`/api/visitors/${encodeURIComponent(endpointId)}`, { method: "DELETE" }) as Promise<Receipt>;
}

export interface CodeEntry {
  code_hash: string;
  max_uses: number;
  used_count: number;
  expires_at: number;
  alias_hint?: string | null;
  revoked?: boolean;
  default_ttl_days?: number | null;
  /** deny-set 命中（Phase 1c 运维投影：补写失败 fail-closed 的码暂时停兑；恢复后自动解除）。 */
  denied?: boolean;
}

/** GET /api/codes → {codes:[…]}——列表只含哈希与计数，绝无码全文。 */
export function loadCodes(): Promise<{ codes: CodeEntry[] }> {
  return jsonFetch("/api/codes") as Promise<{ codes: CodeEntry[] }>;
}

/** POST /api/codes（签发；**响应含 code 全文——仅此一次**）。 */
export function issueCode(payload: { alias_hint?: string; max_uses?: number; expires_in_days?: number; default_ttl_days?: number }): Promise<{ code: string } & Receipt> {
  return jsonFetch("/api/codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) as Promise<{ code: string } & Receipt>;
}

/** DELETE /api/codes/{code_hash}（吊销：未用次数立即作废；已注册租户不受影响）。 */
export function revokeCode(codeHash: string): Promise<Receipt> {
  return jsonFetch(`/api/codes/${encodeURIComponent(codeHash)}`, { method: "DELETE" }) as Promise<Receipt>;
}

/** POST /api/owners/{fabric_id}/{root}/renew（续期：expires_in_days 或 permanent 恰好其一）。 */
export function renewOwner(fabricId: string, root: string, body: { expires_in_days?: number; permanent?: boolean }): Promise<Receipt & { expires_at?: number }> {
  return jsonFetch(`/api/owners/${encodeURIComponent(fabricId)}/${encodeURIComponent(root)}/renew`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as Promise<Receipt & { expires_at?: number }>;
}

/**
 * PATCH /api/owners/{fabric_id}/{root}（元数据编辑：body alias/note 至少其一，
 * **空串=清除**；上限 alias ≤ 32 / note ≤ 256 UTF-8 字节，越界 400）。
 * 回执 op=owner-meta（0x0D，alias/note 为编辑后终值）——PM §4.5 别名行内编辑的承载面。
 */
export function patchOwnerMeta(fabricId: string, root: string, body: { alias?: string; note?: string }): Promise<Receipt> {
  return jsonFetch(`/api/owners/${encodeURIComponent(fabricId)}/${encodeURIComponent(root)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as Promise<Receipt>;
}

/**
 * PATCH /api/visitors/{endpoint_id}（访客元数据编辑，与 owner 同构；空串=清除）。
 * 回执 op=visitor-meta（0x0E；fabric_id 维度置零，endpoint_id 承载身份）。
 */
export function patchVisitorMeta(endpointId: string, body: { alias?: string; note?: string }): Promise<Receipt> {
  return jsonFetch(`/api/visitors/${encodeURIComponent(endpointId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as Promise<Receipt>;
}

export interface BlockEntry {
  kind: "endpoint" | "fabric";
  id: string;
  reason?: string | null;
  ts: number;
}

/** GET /api/blocklist 响应（wire 与 roles.rs BlocklistList 同拍：容器键 = entries）。 */
export interface BlocklistData {
  generation: number;
  entries: BlockEntry[];
}

/** GET /api/blocklist → {generation, entries:[{kind,id,reason,ts}]}。 */
export function loadBlocklist(): Promise<BlocklistData> {
  return jsonFetch("/api/blocklist") as Promise<BlocklistData>;
}

/** POST /api/blocklist（拉黑：kind=endpoint|fabric；先于一切准入判定生效）。 */
export function addBlocklist(payload: { kind: "endpoint" | "fabric"; id: string; reason?: string }): Promise<Receipt> {
  return jsonFetch("/api/blocklist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) as Promise<Receipt>;
}

/** DELETE /api/blocklist/{kind}/{id}（移出黑名单）。 */
export function removeBlocklist(kind: "endpoint" | "fabric", id: string): Promise<Receipt> {
  return jsonFetch(`/api/blocklist/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: "DELETE" }) as Promise<Receipt>;
}
