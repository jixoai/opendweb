// @jixo/opendweb-client-sdk ./admin —— Server 管理 API 客户端（sdk-mgmt-surface
// tasks 2.1-2.3，design §2.2 / specs/sdk/node/spec.md）。
//
// 形态冻结（design §2.1，r2-P0-1）：纯 ESM entrypoint（.mjs + .d.mts），包级
// 无 "type": "module"，与既有 CommonJS 入口（./index.js、./net、./http）共存；
// ESM-only 契约——`import` 载入，不承诺 CommonJS 同步加载（Node 22 前不可用，
// 见 README）。
//
// 隔离规则（design §2.1）：本目录源码零运行时依赖、零 import——MUST NOT
// 引包内 root/`./net`/`./http`（它们是 CJS + native binding，任何传递加载都会
// 把 .node 带进「纯 TS 环境导入」场景）。发布物门禁见 scripts/pack-gate.mjs。
//
// 错误归一（spec「错误归一与判别」）：AdminError{status, code, message}，
// code 判别表：admin-not-enabled / unauthorized / invalid-request / no-match /
// network / timeout，外加 `http-<status>` 形态（任意非 200 且无 envelope 的
// 兜底）。`admin-not-enabled` 只经 probeEnabled() 的专用探测判定（404）——
// 禁止把任意非 200 折叠为未启用。
//
// probeEnabled 六路互斥矩阵（r2-P1-3 + r3-P1-2 冻结）：200 → resolve true；
// 404 → admin-not-enabled；401 → unauthorized；502/503/任意非 200 →
// http-<status>；fetch reject → network；超时 → timeout。不存在 false 返回值。
//
// wire（server spec 全 JSON 示例冻结，snake_case 直映；未知字段忽略）：
// GET  /admin/status      {mode, policy, generation, max_connections_per_owner,
//                          active_connections[], per_owner_connections[], cache_entries,
//                          visitors_online, knocks_pending, visitors_active, codes_active}
//                          ——后四项为 server-access-roles Phase 1a/1c 纯增量字段
// GET  /admin/owners      {generation, owners:[{fabric_id, root, registered_at,
//                          alias?, note?, expires_at, expires_in, status}]}
//                          ——alias/note/expires_* /status 为 Phase 1c 增量
// POST /admin/owners      {fabric_id_hex, root_hex} → Receipt
// DEL  /admin/owners/{fabric_id}/{root}              → Receipt（kicked_* 仅注销）
// PATCH /admin/owners/{fabric_id}/{root} {alias?, note?} → owner-meta 回执（1c）
// POST /admin/owners/{fabric_id}/{root}/renew
//                        {expires_in_days} | {permanent: true}（恰好其一）→ renew 回执（1c）
// GET  /admin/connections {mode, policy, relay_enabled, quota{...}, per_endpoint[],
//                          per_owner[], per_visitor[]}
// POST /admin/connections/disconnect {endpoint_id}|{fabric_id}
//                          → {disconnected[], receipts[]}（回执 op=disconnect 用
//                            显式 endpoint_id 字段，不复用 root 键名）
// GET  /admin/knocks[?include_dismissed=true] {knocks[], pending_count}（1c）
// POST /admin/knocks/{endpoint_id}/dismiss|undismiss → knock 回执（1c）
// GET  /admin/visitors    {generation, visitors:[{endpoint_id, alias?, note?,
//                          granted_at, expires_at?}]}（1c）
// POST /admin/visitors[/from-knock] {endpoint_id, alias?, note?, expires_in_days?}
//                          → visitor-grant 回执（from-knock 为语义糖路由）（1c）
// DEL/PATCH /admin/visitors/{endpoint_id} → visitor-revoke / visitor-meta 回执（1c）
// GET  /admin/codes       {generation, codes:[{code_hash, max_uses, used_count,
//                          expires_at?, alias_hint?, revoked, default_ttl_days,
//                          denied}]}——绝不含码全文（1c）
// POST /admin/codes       {alias_hint?, max_uses?, expires_in_days?,
//                          default_ttl_days?} → code-issue 回执（含 code 全文仅一次）
// DEL  /admin/codes/{code_hash} → code-revoke 回执（1c）
// GET  /admin/blocklist   {generation, entries:[{kind, id, reason?, ts}]}（1c）
// POST /admin/blocklist   {kind: endpoint|fabric, id, reason?} → block-add 回执
// DEL  /admin/blocklist/{kind}/{id} → block-remove 回执（1c）
//
// 回执 canonical（admin.rs receipt_canonical 冻结布局，全大端）：
// b"dweb/admin-receipt/v1\0"(22B) || op u8 || fabric_id 32B || target 32B ||
// ts u64BE || generation u64BE。Phase 1c 起 op 扩到 0x04-0x0E（server-access-
// roles spec「三角色管理面 API」槽位映射表）：未用维度的 fabric_id 在 wire
// 上为 64 个 "0"（与 canonical 置零字节同步），target 字段按 op 族取
// root/endpoint_id/code_hash/id（TARGET_FIELD_BY_OP）。跨语言冻结对拍向量：
// crates/dweb-server/tests/fixtures/receipt-vector.json。
//
// register-receipt（POST /register 公开兑换面，server-access-roles 1b/1c）：
// canonical `b"dweb/register-receipt/v1\0" || code_hash 32B || fabric 32B ||
// root 32B || ts u64BE || generation u64BE`（137B 定长）——registerReceiptCanonical/
// verifyRegisterReceipt 与 packages/opendweb/src/register.mjs 逐字节互认。

/** 回执签名域分隔前缀（22B；admin.rs RECEIPT_DOMAIN 同值冻结）。 */
const RECEIPT_DOMAIN = Uint8Array.from("dweb/admin-receipt/v1\0".split(""), (c) =>
  c.charCodeAt(0),
);

/** op 串 ↔ 字节（admin.rs OP_* 冻结；server-access-roles Phase 1c 扩
 * 0x04-0x0E——spec「三角色管理面 API」op 枚举表逐字对齐）。 */
const RECEIPT_OP_BYTES = {
  register: 1,
  unregister: 2,
  disconnect: 3,
  renew: 4,
  "visitor-grant": 5,
  "visitor-revoke": 6,
  "code-issue": 7,
  "code-revoke": 8,
  "block-add": 9,
  "block-remove": 10,
  "knock-dismiss": 11,
  "knock-undismiss": 12,
  "owner-meta": 13,
  "visitor-meta": 14,
};

/** op → wire target 字段名（canonical 32B target 槽位的 JSON 承载键；
 * admin/mod.rs fixture target_field() 同表冻结）。 */
const TARGET_FIELD_BY_OP = {
  register: "root",
  unregister: "root",
  renew: "root",
  "owner-meta": "root",
  disconnect: "endpoint_id",
  "visitor-grant": "endpoint_id",
  "visitor-revoke": "endpoint_id",
  "visitor-meta": "endpoint_id",
  "knock-dismiss": "endpoint_id",
  "knock-undismiss": "endpoint_id",
  "code-issue": "code_hash",
  "code-revoke": "code_hash",
  "block-add": "id",
  "block-remove": "id",
};

/** canonical 总长 = 22 + 1 + 32 + 32 + 8 + 8 = 103B。 */
const RECEIPT_CANONICAL_LEN =
  RECEIPT_DOMAIN.length + 1 + 32 + 32 + 8 + 8;

/** register-receipt 域分隔前缀（25B；register.rs RECEIPT_DOMAIN 同值冻结）。 */
const REGISTER_RECEIPT_DOMAIN = Uint8Array.from(
  "dweb/register-receipt/v1\0".split(""),
  (c) => c.charCodeAt(0),
);

/** register-receipt canonical 定长 = 25 + 32×3 + 8×2 = 137B（spec 冻结）。 */
const REGISTER_RECEIPT_CANONICAL_LEN =
  REGISTER_RECEIPT_DOMAIN.length + 32 * 3 + 8 * 2;

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * 管理面错误（spec「错误归一与判别」）：携带 HTTP status（网络/超时/本地
 * 前置校验时为 null）、机器可读 code、服务端 message。
 */
export class AdminError extends Error {
  /**
   * @param {string} code 机器可读判别码
   * @param {string} message 人类可读信息（envelope 形态时透传服务端 message）
   * @param {number | null} status HTTP 状态码；网络/超时/本地校验为 null
   */
  constructor(code, message, status = null) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.status = status;
  }

  /**
   * 由非 2xx Response 归一：优先解析服务端 envelope
   * `{"error":{"code","message"}}`（design §1.2 冻结）；无 envelope（含代理
   * 剥 body / 未挂载空 404）兜底 `http-<status>`。注意这里对 404 不做
   * admin-not-enabled 折叠——未启用判别只属于 probeEnabled()。
   * @param {Response} res
   * @returns {Promise<AdminError>}
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

/**
 * Server 管理 API 客户端（Node 18+ 全局 fetch；浏览器同构可用）。
 * Bearer 注入 + baseUrl 尾斜杠归一 + 每请求 AbortSignal.timeout 超时。
 */
export class AdminClient {
  #base;
  #token;
  #timeoutMs;

  /**
   * @param {{ baseUrl: string, token: string, timeoutMs?: number }} options
   */
  constructor({ baseUrl, token, timeoutMs = 10_000 }) {
    if (typeof baseUrl !== "string" || baseUrl === "") {
      throw new TypeError("AdminClient: baseUrl must be a non-empty string");
    }
    // 仅作绝对 URL 校验（不保留实例——路径拼接走字符串连接保留任意反代前缀）
    new URL(baseUrl);
    if (typeof token !== "string" || token === "") {
      throw new TypeError("AdminClient: token must be a non-empty string");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("AdminClient: timeoutMs must be a positive integer");
    }
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  /** GET /admin/status（既有冻结 wire——mode/policy/generation/在线投影）。 */
  status() {
    return this.#json("/admin/status");
  }

  /** GET /admin/owners → {generation, owners[]}。 */
  listOwners() {
    return this.#json("/admin/owners");
  }

  /**
   * POST /admin/owners（注册 (fabric_id, root) 二元组）→ 注册回执。
   * @param {string} fabricId 64-hex
   * @param {string} root 64-hex
   */
  registerOwner(fabricId, root) {
    requireHex64(fabricId, "fabricId");
    requireHex64(root, "root");
    return this.#json("/admin/owners", {
      method: "POST",
      body: JSON.stringify({ fabric_id_hex: fabricId, root_hex: root }),
    });
  }

  /**
   * DELETE /admin/owners/{fabric_id}/{root} → 注销回执（kicked_* 计数）。
   * @param {string} fabricId 64-hex
   * @param {string} root 64-hex
   */
  unregisterOwner(fabricId, root) {
    requireHex64(fabricId, "fabricId");
    requireHex64(root, "root");
    return this.#json(`/admin/owners/${fabricId}/${root}`, { method: "DELETE" });
  }

  /** GET /admin/connections（详细在线视图：mode/relay_enabled 拆分 + quota 结构）。 */
  connections() {
    return this.#json("/admin/connections");
  }

  /**
   * POST /admin/connections/disconnect（恰好其一；服务端同规则 400 兜底）。
   * 响应报告「已下发」的 disconnected 与 per-target receipts——best-effort，
   * 收敛由调用方有界轮询 connections() 确认（design §1.2 P1-2）。
   * @param {{ endpointId?: string, fabricId?: string }} selector 恰好其一
   */
  disconnect(selector = {}) {
    const { endpointId, fabricId } = selector ?? {};
    const hasEndpoint = endpointId !== undefined;
    const hasFabric = fabricId !== undefined;
    if (hasEndpoint === hasFabric) {
      throw new AdminError(
        "invalid-request",
        "disconnect: exactly one of endpointId or fabricId is required",
        null,
      );
    }
    if (hasEndpoint) {
      requireHex64(endpointId, "endpointId");
      return this.#json("/admin/connections/disconnect", {
        method: "POST",
        body: JSON.stringify({ endpoint_id: endpointId }),
      });
    }
    requireHex64(fabricId, "fabricId");
    return this.#json("/admin/connections/disconnect", {
      method: "POST",
      body: JSON.stringify({ fabric_id: fabricId }),
    });
  }

  /**
   * 专用启用探测（spec「status 探测矩阵」，r3-P1-2 签名冻结）：
   * `Promise<true>`——仅 200 resolve true，其余一律 reject AdminError。
   * 404 = admin-not-enabled（未配置 DWEB_ADMIN_TOKEN 即未挂载）；401 =
   * unauthorized（已挂载但凭证错——不是 not-enabled）；任意其它非 200 =
   * `http-<status>`；fetch reject = network；超时 = timeout。探测判别的是
   * 路由存在性而非 body 形态（代理剥 body 场景依然成立）。
   * @returns {Promise<true>}
   */
  async probeEnabled() {
    const res = await this.#fetch("/admin/status");
    if (res.status === 200) {
      try {
        await res.arrayBuffer(); // 排空 body 释放连接
      } catch {
        // 排空失败不影响判定
      }
      return true;
    }
    let message = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(await res.text());
      if (
        body &&
        typeof body === "object" &&
        typeof body.error?.message === "string"
      ) {
        message = body.error.message;
      }
    } catch {
      // 空/非 JSON body——矩阵只按 status 判别
    }
    const code =
      res.status === 404
        ? "admin-not-enabled"
        : res.status === 401
          ? "unauthorized"
          : `http-${res.status}`;
    throw new AdminError(code, message, res.status);
  }

  // ---- server-access-roles Phase 1c：三角色管理调用 ---------------------------

  /**
   * GET /admin/knocks（排序冻结：未处置在前、组内 seq 降序、endpoint_id
   * 升序 tie-break；pending_count 恒为未 dismissed 数）。
   * @param {{ includeDismissed?: boolean }} [options]
   */
  listKnocks({ includeDismissed = false } = {}) {
    const path = includeDismissed
      ? "/admin/knocks?include_dismissed=true"
      : "/admin/knocks";
    return this.#json(path);
  }

  /**
   * POST /admin/knocks/{endpoint_id}/dismiss（幂等；unknown → no-match）。
   * @param {string} endpointId 64-hex
   */
  dismissKnock(endpointId) {
    requireHex64(endpointId, "endpointId");
    return this.#json(`/admin/knocks/${endpointId}/dismiss`, { method: "POST" });
  }

  /** POST /admin/knocks/{endpoint_id}/undismiss（幂等；unknown → no-match）。 */
  undismissKnock(endpointId) {
    requireHex64(endpointId, "endpointId");
    return this.#json(`/admin/knocks/${endpointId}/undismiss`, { method: "POST" });
  }

  /** GET /admin/visitors → {generation, visitors[]}。 */
  listVisitors() {
    return this.#json("/admin/visitors");
  }

  /**
   * POST /admin/visitors（授予访客；expiresInDays 缺省 = 永久）。
   * @param {{ endpointId: string, alias?: string, note?: string, expiresInDays?: number }} grant
   */
  grantVisitor({ endpointId, alias, note, expiresInDays } = {}) {
    requireHex64(endpointId, "endpointId");
    const body = { endpoint_id: endpointId };
    if (alias !== undefined) body.alias = alias;
    if (note !== undefined) body.note = note;
    if (expiresInDays !== undefined) body.expires_in_days = expiresInDays;
    return this.#json("/admin/visitors", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * POST /admin/visitors/from-knock（语义糖路由，等同 grantVisitor——敲门台
   * 一键定位的专用入口）。
   * @param {{ endpointId: string, alias?: string, note?: string, expiresInDays?: number }} grant
   */
  grantVisitorFromKnock(grant = {}) {
    requireHex64(grant.endpointId, "endpointId");
    const body = { endpoint_id: grant.endpointId };
    if (grant.alias !== undefined) body.alias = grant.alias;
    if (grant.note !== undefined) body.note = grant.note;
    if (grant.expiresInDays !== undefined) body.expires_in_days = grant.expiresInDays;
    return this.#json("/admin/visitors/from-knock", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * DELETE /admin/visitors/{endpoint_id}（revoke；unknown → no-match）。
   * @param {string} endpointId 64-hex
   */
  revokeVisitor(endpointId) {
    requireHex64(endpointId, "endpointId");
    return this.#json(`/admin/visitors/${endpointId}`, { method: "DELETE" });
  }

  /**
   * PATCH /admin/visitors/{endpoint_id}（元数据：alias/note 至少其一、
   * 空串 = 清除、缺省 = 保留）。
   * @param {string} endpointId 64-hex
   * @param {{ alias?: string, note?: string }} meta
   */
  updateVisitorMetadata(endpointId, meta = {}) {
    requireHex64(endpointId, "endpointId");
    const { alias, note } = meta ?? {};
    if (alias === undefined && note === undefined) {
      throw new AdminError(
        "invalid-request",
        "updateVisitorMetadata: at least one of alias or note is required",
        null,
      );
    }
    const body = {};
    if (alias !== undefined) body.alias = alias;
    if (note !== undefined) body.note = note;
    return this.#json(`/admin/visitors/${endpointId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /** GET /admin/codes → {generation, codes[]}（只含哈希与计数，绝无码全文）。 */
  listCodes() {
    return this.#json("/admin/codes");
  }

  /**
   * POST /admin/codes（签发；**响应含 code 全文仅此一次**——调用方负责
   * 即时呈现/丢弃，不得持久化）。缺省 max_uses=1 / 7 天 / 30 天租期。
   * @param {{ aliasHint?: string, maxUses?: number, expiresInDays?: number, defaultTtlDays?: number }} [params]
   */
  issueCode(params = {}) {
    const { aliasHint, maxUses, expiresInDays, defaultTtlDays } = params ?? {};
    const body = {};
    if (aliasHint !== undefined) body.alias_hint = aliasHint;
    if (maxUses !== undefined) body.max_uses = maxUses;
    if (expiresInDays !== undefined) body.expires_in_days = expiresInDays;
    if (defaultTtlDays !== undefined) body.default_ttl_days = defaultTtlDays;
    return this.#json("/admin/codes", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * DELETE /admin/codes/{code_hash}（吊销；unknown → no-match）。
   * @param {string} codeHash 64-hex（blake3）
   */
  revokeCode(codeHash) {
    requireHex64(codeHash, "codeHash");
    return this.#json(`/admin/codes/${codeHash}`, { method: "DELETE" });
  }

  /**
   * POST /admin/owners/{fabric_id}/{root}/renew（续期：expiresInDays 或
   * permanent 恰好其一——与服务端同规则，双键/空键本地 fail-fast）。
   * @param {string} fabricId 64-hex
   * @param {string} rootId 64-hex
   * @param {{ expiresInDays?: number, permanent?: boolean }} renewal 恰好其一
   */
  renewOwner(fabricId, rootId, renewal = {}) {
    requireHex64(fabricId, "fabricId");
    requireHex64(rootId, "rootId");
    const { expiresInDays, permanent } = renewal ?? {};
    const hasDays = expiresInDays !== undefined;
    const hasPermanent = permanent !== undefined;
    if (hasDays === hasPermanent) {
      throw new AdminError(
        "invalid-request",
        "renewOwner: exactly one of expiresInDays or permanent is required",
        null,
      );
    }
    const body = hasDays ? { expires_in_days: expiresInDays } : { permanent: true };
    return this.#json(`/admin/owners/${fabricId}/${rootId}/renew`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * PATCH /admin/owners/{fabric_id}/{root}（元数据：alias/note 至少其一、
   * 空串 = 清除、缺省 = 保留）。
   * @param {string} fabricId 64-hex
   * @param {string} rootId 64-hex
   * @param {{ alias?: string, note?: string }} meta
   */
  updateOwnerMetadata(fabricId, rootId, meta = {}) {
    requireHex64(fabricId, "fabricId");
    requireHex64(rootId, "rootId");
    const { alias, note } = meta ?? {};
    if (alias === undefined && note === undefined) {
      throw new AdminError(
        "invalid-request",
        "updateOwnerMetadata: at least one of alias or note is required",
        null,
      );
    }
    const body = {};
    if (alias !== undefined) body.alias = alias;
    if (note !== undefined) body.note = note;
    return this.#json(`/admin/owners/${fabricId}/${rootId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /** GET /admin/blocklist → {generation, entries[]}。 */
  listBlocklist() {
    return this.#json("/admin/blocklist");
  }

  /**
   * POST /admin/blocklist（拉黑）。
   * @param {{ kind: "endpoint" | "fabric", id: string, reason?: string }} entry
   */
  block({ kind, id, reason } = {}) {
    if (kind !== "endpoint" && kind !== "fabric") {
      throw new AdminError(
        "invalid-request",
        'block: kind must be "endpoint" | "fabric"',
        null,
      );
    }
    requireHex64(id, "id");
    const body = { kind, id };
    if (reason !== undefined) body.reason = reason;
    return this.#json("/admin/blocklist", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * DELETE /admin/blocklist/{kind}/{id}（移出名单；不在名单 → no-match）。
   * @param {"endpoint" | "fabric"} kind
   * @param {string} id 64-hex
   */
  unblock(kind, id) {
    if (kind !== "endpoint" && kind !== "fabric") {
      throw new AdminError(
        "invalid-request",
        'unblock: kind must be "endpoint" | "fabric"',
        null,
      );
    }
    requireHex64(id, "id");
    return this.#json(`/admin/blocklist/${kind}/${id}`, { method: "DELETE" });
  }

  // ---- 内部：请求/归一 -------------------------------------------------------

  /** 单一 fetch 出口：Bearer 注入 + 超时信号；传输层异常 → network/timeout。 */
  async #fetch(path, init = {}) {
    const url = `${this.#base}${path}`;
    try {
      return await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: init.body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw this.#transportError(err);
    }
  }

  /** 传输层异常归一：AbortSignal.timeout 的 TimeoutError（含旧 AbortError
   * 形态）→ timeout；其余 fetch reject → network。 */
  #transportError(err) {
    const name = err && typeof err === "object" ? err.name : null;
    if (name === "TimeoutError" || name === "AbortError") {
      return new AdminError(
        "timeout",
        `request timed out after ${this.#timeoutMs}ms`,
        null,
      );
    }
    const detail =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    return new AdminError("network", `request failed: ${detail}`, null);
  }

  /** JSON 往返：非 2xx → AdminError.fromResponse（envelope 优先）；2xx 非
   * JSON → invalid-response（防御性兜底，正常服务端不产生）。 */
  async #json(path, init = {}) {
    const res = await this.#fetch(path, init);
    if (!res.ok) {
      throw await AdminError.fromResponse(res);
    }
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
}

/**
 * 回执待签载荷（admin.rs receipt_canonical 逐字节一致的 canonical，
 * 跨语言冻结对拍钉住）：`b"dweb/admin-receipt/v1\0" || op u8 || fabric_id 32B
 * || target 32B || ts u64BE || generation u64BE`（全大端）。target 字段按
 * op 族取 root / endpoint_id / code_hash / id（TARGET_FIELD_BY_OP——
 * register/unregister/renew/owner-meta 用 root，visitor- 与 knock- 族用
 * endpoint_id，code-* 用 code_hash，block-* 用 id）；零 fabric 维度的回执
 * wire 携带 64 个 "0"（服务端同步呈现——未用维度置零字节）。
 * @param {import("./index.d.mts").AdminReceipt} receipt 服务端回执（JSON wire 字段）
 * @returns {Uint8Array} 103B 待签载荷
 */
export function receiptCanonical(receipt) {
  // Object.hasOwn 防原型键穿透（r5-P1-2）："constructor"/"toString"/
  // "__proto__" 沿原型链解析为非 undefined 值，会被静默编码为 op byte 0
  const op =
    receipt && typeof receipt === "object" && typeof receipt.op === "string"
      ? receipt.op
      : undefined;
  const opByte =
    op !== undefined && Object.hasOwn(RECEIPT_OP_BYTES, op)
      ? RECEIPT_OP_BYTES[op]
      : undefined;
  if (opByte === undefined) {
    throw new TypeError(
      `receiptCanonical: op must be one of ${Object.keys(RECEIPT_OP_BYTES).map((k) => `"${k}"`).join(" | ")}`,
    );
  }
  const targetField = TARGET_FIELD_BY_OP[op];
  const targetHex = receipt[targetField];
  const out = new Uint8Array(RECEIPT_CANONICAL_LEN);
  out.set(RECEIPT_DOMAIN, 0);
  out[RECEIPT_DOMAIN.length] = opByte;
  out.set(hexToBytes32(receipt.fabric_id, "fabric_id"), RECEIPT_DOMAIN.length + 1);
  out.set(
    hexToBytes32(targetHex, targetField),
    RECEIPT_DOMAIN.length + 33,
  );
  u64BE(out, RECEIPT_DOMAIN.length + 65, receipt.ts, "ts");
  u64BE(out, RECEIPT_DOMAIN.length + 73, receipt.generation, "generation");
  return out;
}

/**
 * 注入式验签（spec 冻结：包本身不引入签名依赖、不内置验签实现——调用方
 * 自带 @noble/ed25519 等）。verifier 收到 (canonical, sig64B)；公钥 =
 * services.json 的 server_id（`adminPublicKeyFromServices` 提取）。
 * @param {import("./index.d.mts").AdminReceipt} receipt
 * @param {import("./index.d.mts").ReceiptVerifier} verifier
 * @returns {Promise<boolean>}
 */
export async function verifyReceipt(receipt, verifier) {
  if (typeof verifier !== "function") {
    throw new TypeError(
      "verifyReceipt: verifier must be a function (message, signature) => boolean | Promise<boolean>",
    );
  }
  const message = receiptCanonical(receipt);
  const sig = fromBase64UrlNoPad(receipt.receipt_sig, "receipt_sig");
  if (sig.length !== 64) {
    throw new TypeError(
      `verifyReceipt: receipt_sig must decode to exactly 64 bytes (got ${sig.length})`,
    );
  }
  const ok = await verifier(message, sig);
  return ok === true;
}

/**
 * 从 services.json（server-access-policy task 1.8 的 server_id 公告字段）
 * 提取回执验签公钥（Ed25519 verifying key = ServerId，hex64 小写）。
 * @param {string | object} servicesJson services.json 文本或已解析对象
 * @returns {string} 64-hex 公钥（可直接喂给 @noble/ed25519 verify）
 */
export function adminPublicKeyFromServices(servicesJson) {
  const doc =
    typeof servicesJson === "string" ? JSON.parse(servicesJson) : servicesJson;
  if (doc === null || typeof doc !== "object") {
    throw new TypeError(
      "adminPublicKeyFromServices: services.json must be an object or a JSON string",
    );
  }
  const id = doc.server_id;
  if (typeof id !== "string" || !HEX64_RE.test(id)) {
    throw new TypeError(
      "adminPublicKeyFromServices: services.json server_id must be 64 hex characters",
    );
  }
  return id.toLowerCase();
}

// ---- register-receipt（POST /register 公开兑换面；server-access-roles） ----

/**
 * register 兑换回执的待签载荷（register.rs register_receipt_canonical 逐字节
 * 一致，137B 定长）：`b"dweb/register-receipt/v1\0"(25B) || code_hash 32B ||
 * fabric_id 32B || root 32B || ts u64BE || generation u64BE`。与
 * packages/opendweb/src/register.mjs 的 buildRegisterReceiptCanonical 互认
 * （跨实现冻结向量对拍见 test/admin-receipt.test.mjs）。
 * @param {import("./index.d.mts").RegisterReceipt} receipt /register 成功响应
 * @returns {Uint8Array} 137B 待签载荷
 */
export function registerReceiptCanonical(receipt) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    receipt.op !== "register"
  ) {
    throw new TypeError('registerReceiptCanonical: receipt.op must be "register"');
  }
  const out = new Uint8Array(REGISTER_RECEIPT_CANONICAL_LEN);
  out.set(REGISTER_RECEIPT_DOMAIN, 0);
  out.set(hexToBytes32(receipt.code_hash, "code_hash"), REGISTER_RECEIPT_DOMAIN.length);
  out.set(
    hexToBytes32(receipt.fabric_id, "fabric_id"),
    REGISTER_RECEIPT_DOMAIN.length + 32,
  );
  out.set(hexToBytes32(receipt.root, "root"), REGISTER_RECEIPT_DOMAIN.length + 64);
  u64BE(out, REGISTER_RECEIPT_DOMAIN.length + 96, receipt.ts, "ts");
  u64BE(out, REGISTER_RECEIPT_DOMAIN.length + 104, receipt.generation, "generation");
  return out;
}

/**
 * register 兑换回执注入式验签（隔离规则：本目录零运行时依赖——调用方自带
 * @noble/ed25519 或 node:crypto 的 verify；公钥 = services.json 的
 * server_id，经 adminPublicKeyFromServices 提取）。语义与 opendweb 包的
 * verifyRegisterReceipt（serverPublicKeyHex 直注）互认——canonical 同源。
 * @param {import("./index.d.mts").RegisterReceipt} receipt
 * @param {import("./index.d.mts").ReceiptVerifier} verifier
 * @returns {Promise<boolean>}
 */
export async function verifyRegisterReceipt(receipt, verifier) {
  if (typeof verifier !== "function") {
    throw new TypeError(
      "verifyRegisterReceipt: verifier must be a function (message, signature) => boolean | Promise<boolean>",
    );
  }
  const message = registerReceiptCanonical(receipt);
  const sig = fromBase64UrlNoPad(receipt.receipt_sig, "receipt_sig");
  if (sig.length !== 64) {
    throw new TypeError(
      `verifyRegisterReceipt: receipt_sig must decode to exactly 64 bytes (got ${sig.length})`,
    );
  }
  const ok = await verifier(message, sig);
  return ok === true;
}

// ---- 内部：编解码助手（零依赖、浏览器同构；token/ 目录各持一份同款，保持
// 两 subpath 完全自包含——design §2.1 隔离规则） --------------------------------

/** 入参 hex64 前置校验（fail-fast；服务端同规则 400 的客户端镜像）。 */
function requireHex64(value, label) {
  if (typeof value !== "string" || !HEX64_RE.test(value)) {
    throw new AdminError(
      "invalid-request",
      `${label} must be 64 hex characters (32 bytes)`,
      null,
    );
  }
  return value.toLowerCase();
}

/** hex64 → 32B（canonical 布局的 fabric/target 槽位）。 */
function hexToBytes32(value, label) {
  if (typeof value !== "string" || !HEX64_RE.test(value)) {
    throw new TypeError(`receiptCanonical: ${label} must be 64 hex characters`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** u64 大端写入（JSON number 的安全整数域即够 ts/generation 毫秒语义）。 */
function u64BE(out, offset, value, label) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      `receiptCanonical: ${label} must be a safe non-negative integer`,
    );
  }
  new DataView(out.buffer).setBigUint64(offset, BigInt(value), false);
}

const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64U_INDEX = new Map();
for (let i = 0; i < B64U_ALPHABET.length; i++) {
  B64U_INDEX.set(B64U_ALPHABET[i], i);
}

/** 严格 base64url-nopad 解码（白名单字符集 + 零尾位校验；reject "=" pad）。 */
function fromBase64UrlNoPad(s, label) {
  if (typeof s !== "string") {
    throw new TypeError(`${label}: expected a base64url-nopad string`);
  }
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64U_INDEX.get(s[i]);
    if (v === undefined) {
      throw new TypeError(
        `${label}: invalid base64url character ${JSON.stringify(s[i])} at index ${i}`,
      );
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new TypeError(`${label}: non-zero trailing bits (not canonical base64url-nopad)`);
  }
  return Uint8Array.from(out);
}
