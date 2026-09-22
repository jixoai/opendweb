// 可注入 apiFetch 抽象层（webui-console design §4 r2-P2-4）。
// 意图（2026-09-22，A.7）：
// 1. SPA 的全部网络访问收敛到单一 transport（/api/* 业务代理面 +
//    /sidecar/* 本地控制面）——单测经 setApiFetch 注入失败态 fixture，
//    不依赖真实 server（失败态矩阵的测试钩子）；
// 2. 错误归一镜像 client-sdk ./admin：envelope
//    {"error":{code,message}} 优先透传，无 envelope 兜底 http-<status>；
//    传输层 reject → network；超时 → timeout；
// 3. 浏览器零凭证——Authorization 由 sidecar 注入，本层不持有 token。

/** 管理面错误（与 @jixo/opendweb-client-sdk ./admin AdminError 同构判别面）。 */
export class AdminError extends Error {
  /**
   * @param {string} code 机器可读判别码（admin-not-enabled / unauthorized /
   *   no-match / network / timeout / no-target / http-<status> / …）
   * @param {string} message 人类可读信息
   * @param {number | null} status HTTP 状态码（网络/超时为 null）
   */
  constructor(code, message, status = null) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.status = status;
  }

  /**
   * 由非 2xx Response 归一（envelope 优先；兜底 http-<status>）。
   * @param {Response} res
   */
  static async fromResponse(res) {
    let code = null;
    let message = null;
    try {
      const body = JSON.parse(await res.text());
      const err = body && typeof body === "object" ? body.error : null;
      if (
        err &&
        typeof err === "object" &&
        typeof err.code === "string" &&
        typeof err.message === "string"
      ) {
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

/** 注入面：默认同源 fetch；测试以 fixture 替换（签名与 fetch 一致）。 */
let transport = defaultTransport;

/**
 * 注入 transport 替身（单测专用）。传入 null 恢复默认。
 * @param {((path: string, init?: object) => Promise<Response>) | null} fn
 */
export function setApiFetch(fn) {
  transport = fn ?? defaultTransport;
}

/** 恢复默认 transport（测试 afterEach）。 */
export function resetApiFetch() {
  transport = defaultTransport;
}

/** 默认 transport：同源 fetch + 15s 客户端超时（sidecar 上游超时 10s 的外圈）。 */
function defaultTransport(path, init = {}) {
  return fetch(path, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
}

/** 传输层异常归一：TimeoutError/AbortError → timeout；其余 → network。 */
function transportError(err) {
  const name = err && typeof err === "object" ? err.name : null;
  if (name === "TimeoutError" || name === "AbortError") {
    return new AdminError("timeout", "request timed out", null);
  }
  const detail = err instanceof Error ? err.message : String(err ?? "unknown error");
  return new AdminError("network", `request failed: ${detail}`, null);
}

/** JSON 往返（全部网络访问的单一出口——注入点在此生效）。 */
async function jsonFetch(path, init) {
  let res;
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
    throw new AdminError(
      "invalid-response",
      `response body is not JSON (status ${res.status})`,
      res.status,
    );
  }
}

// ---- /sidecar/* 本地控制面 ----------------------------------------------------

/** GET /sidecar/state → {phase:"setup"|"ready", server_host_masked, insecure}。 */
export function fetchSidecarState() {
  return jsonFetch("/sidecar/state");
}

/**
 * POST /sidecar/connect（配对面提交 {pairing_code, server, token}）。
 * 失败码：bad-pairing / bad-origin-host / bad-target / invalid-request /
 * target-frozen。token 仅随本请求走一次，调用方提交后必须清空输入框。
 */
export function postConnect(payload) {
  return jsonFetch("/sidecar/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---- /api/* 业务代理面（wire 冻结于 sdk-mgmt-surface specs/server） -----------

/** GET /api/status → {mode, policy, generation, active_connections[], per_owner_connections[], …} */
export function loadStatus() {
  return jsonFetch("/api/status");
}

/** GET /api/owners → {generation, owners:[{fabric_id, root, registered_at}]} */
export function loadOwners() {
  return jsonFetch("/api/owners");
}

/** GET /api/connections → {mode, policy, relay_enabled, quota{}, per_endpoint[], per_owner[]} */
export function loadConnections() {
  return jsonFetch("/api/connections");
}

/** POST /api/owners（注册 (fabric_id, root)）→ 回执。入参先过 hex64 客户端校验。 */
export function registerOwner(fabricId, root) {
  return jsonFetch("/api/owners", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fabric_id_hex: fabricId, root_hex: root }),
  });
}

/** DELETE /api/owners/{fabric_id}/{root} → 注销回执（kicked_* 计数）。 */
export function unregisterOwner(fabricId, root) {
  return jsonFetch(`/api/owners/${fabricId}/${root}`, { method: "DELETE" });
}

/** POST /api/connections/disconnect（恰好其一）→ {disconnected[], receipts[]}。 */
export function disconnectByEndpoint(endpointId) {
  return jsonFetch("/api/connections/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint_id: endpointId }),
  });
}

/** POST /api/connections/disconnect（按 owner fabric 全量断开）。 */
export function disconnectByFabric(fabricId) {
  return jsonFetch("/api/connections/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fabric_id: fabricId }),
  });
}
