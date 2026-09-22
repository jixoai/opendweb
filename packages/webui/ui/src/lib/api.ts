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
}

/** GET /api/connections → {mode, relay_enabled, quota{}, per_endpoint[], per_owner[]} */
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
