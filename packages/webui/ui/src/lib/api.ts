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
}

/** GET /sidecar/state → {phase, server_host_masked, insecure}。 */
export function fetchSidecarState(): Promise<SidecarState> {
  return jsonFetch("/sidecar/state") as Promise<SidecarState>;
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
  per_endpoint: { endpoint_id: string; fabric_id: string; connections: number }[];
  per_owner: { fabric_id: string; connections: number }[];
  /** 三角色增量：访客在线投影（fabric=None 的连接；endpoint_id 字典序） */
  per_visitor?: { endpoint_id: string; connections: number }[];
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
