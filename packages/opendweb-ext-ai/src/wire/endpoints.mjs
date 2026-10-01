// adapted from ai-fly src/provider/{engine,serve}.ts + src/wire/http-protocol.ts
// (v0.6.0) —— `/wpk1/ai/v1/*` header framing ABI 的 provider 端（design §3 端点
// 表逐项）。engine 三拆的装配层：accept（peer/op 准入+统一 404）→ auth/catalog
// → forward。
//
// 端点（冻结面）：
// - POST auth：{v:1,keys:[≤8]} → 200 {v:1,status:"ok",groups[…],rejected?} |
//   全错 403 {v:1,code:"key_all_invalid"}；
// - GET catalog?since=<rev>：hold ≤20s；204 无变化 / 200 {v:1,refresh:true,
//   catalog,rev}；未 auth（x-odai-key-id 无效/缺失）=403 key_all_invalid；
// - POST request：x-odai-* 头（service 唯一来源/body+query 同名=400、头预算
//   ≤8KiB=400 metadata_too_large、x-odai-key-id 绑定三码分立 key_invalid/
//   key_revoked、413 超限、429 rate_limited/quota_exceeded、404
//   path_not_offered）→ 200 {responseId,epoch,status,headers}；
// - POST response/<rid> / POST cancel：Phase B（B1 中继状态机）——当前一律
//   404 同体（端点已登记、实现未挂）。
//
// handler 面：与 ext-ports 同款可注入面 `(req, peer) => resp | null`
// （HttpHandlerRequestLike——Phase C 经 createWpkRouter routes.ai 挂入内核；
// 本 Phase 用同形状 fake/注入面做单测）。

import {
  AI_WIRE_PREFIX,
  HDR_HEADERS,
  HDR_KEY_ID,
  HDR_METHOD,
  HDR_PATH,
  HDR_REV,
  HDR_SERVICE,
  METADATA_HEADER_BUDGET_BYTES,
  MAX_CHUNK_PAYLOAD,
  PASSTHROUGH_HEADERS_MAX_BYTES,
  jsonResponse,
  notFoundResponse,
} from "./constants.mjs";
import {
  AUTH_BODY_SCHEMA,
  ERROR_CODE,
  HTTP_METHODS,
  passthroughHeadersError,
  requestPathError,
} from "./schemas.mjs";
import { parseWirePath, createOpGate, opGateName } from "../provider/accept.mjs";
import { authDirectoryFromStore, handleAuthRequest } from "../provider/auth.mjs";
import { assertCatalogBudget, buildCatalogView, watchCatalogRevision } from "../provider/catalog.mjs";
import { createForwardPlane, validateAdmission } from "../provider/forward.mjs";
import { LimitEnforcer } from "../provider/limits.mjs";
import { assertStartupEnvSafety } from "../provider/envguard.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** AUTH/错误体读取上限（防线：控制面小载荷）。 */
const CONTROL_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * 默认密钥读取面（直读 secrets.json——无内存态；与 SecretsStore.get 同拍语义，
 * 避免 endpoints↔secrets 循环 import）。
 * @param {string} dataDir
 */
function defaultSecretReader(dataDir) {
  return (name) => {
    try {
      const parsed = JSON.parse(readFileSync(join(dataDir, "secrets.json"), "utf8"));
      const entry = parsed?.secrets?.[name];
      return typeof entry?.value === "string" ? entry.value : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * @param {Array<{name: string, value: string}>} headers
 * @param {string} name 小写头名
 * @returns {string | null}
 */
function headerValue(headers, name) {
  for (const h of headers ?? []) {
    if (h.name.toLowerCase() === name) return h.value;
  }
  return null;
}

/**
 * ai 元数据头预算：全部 `x-odai-*` 头的 name+value 字节合计。
 * @param {Array<{name: string, value: string}>} headers
 */
export function metadataHeaderBytes(headers) {
  let total = 0;
  for (const h of headers ?? []) {
    if (h.name.toLowerCase().startsWith("x-odai-")) {
      total += Buffer.byteLength(h.name) + Buffer.byteLength(h.value);
    }
  }
  return total;
}

/**
 * 请求体拉取（有界；超限停止拉取并标记）。
 * @param {{ bodyNext: () => Promise<Buffer | null> }} req
 * @param {number} limit
 */
async function readBoundedBody(req, limit) {
  const chunks = [];
  let total = 0;
  for (;;) {
    let chunk;
    try {
      chunk = await req.bodyNext();
    } catch {
      return { error: "pull" };
    }
    if (chunk === null) break;
    total += chunk.length;
    if (total > limit) return { error: "over-limit" };
    chunks.push(Buffer.from(chunk));
  }
  return { body: Buffer.concat(chunks) };
}

/**
 * serviceId 双源检测（design §3：x-odai-service 唯一来源；body/查询串同名
 * 信息=400 拒绝——无冲突规则）。body 仅在可解析为 JSON object 时检测顶层键。
 * @param {string} path 含查询串
 * @param {Buffer} body
 * @returns {boolean}
 */
export function serviceIdDuplicateSource(path, body) {
  const qIdx = path.indexOf("?");
  if (qIdx >= 0) {
    for (const pair of path.slice(qIdx + 1).split("&")) {
      const key = pair.split("=", 1)[0];
      if (key === "service" || key === "serviceId" || key === HDR_SERVICE) return true;
    }
  }
  if (body.length === 0) return false;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return "service" in parsed || "serviceId" in parsed || HDR_SERVICE in parsed;
    }
  } catch {
    /* 非 JSON body=纯载荷（二进制等）——不是 serviceId 声明 */
  }
  return false;
}

/**
 * provider wire handler 工厂（工厂期拒绝：catalog 超配 / ambient env 启动命中 /
 * admission 超积——任一命中即抛错不可启动）。
 * @param {{
 *   store: import("../provider/store.mjs").ProviderStore,
 *   limits?: import("../provider/limits.mjs").LimitEnforcer,
 *   secrets?: (name: string) => string | undefined,
 *   usageLog?: import("../provider/limits.mjs").UsageLog | null,
 *   maxConcurrency?: number,
 *   env?: (name: string) => string | undefined,
 *   authorize?: (peer: string, op: string) => boolean | Promise<boolean>,
 *   forwardPlane?: { request: (input: any) => Promise<any>, epoch: string },
 *   home?: string,
 *   loader?: (name: string, home: string) => Record<string, unknown> | undefined,
 *   fetchImpl?: typeof fetch,
 *   probeConnect?: (url: URL, ms: number) => Promise<void>,
 *   timeouts?: { connectMs?: number, firstByteMs?: number, stallMs?: number },
 *   holdMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (level: "info" | "warn" | "error", msg: string) => void,
 * }} opts
 */
export function createAiProviderWireHandler(opts) {
  const { store } = opts;
  if (store === undefined || store === null) throw new Error("createAiProviderWireHandler: store is required");
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());

  // ---- 工厂期拒绝面（fail-closed：超配/环境命中/admission 超积即不可启动） ----
  assertCatalogBudget(store);
  assertStartupEnvSafety(store.listServices(), opts.env !== undefined ? { get: opts.env } : undefined);
  if (opts.maxConcurrency !== undefined) {
    // 超积/超域在注入 forwardPlane 的路径同样拒启（§3.1 admission 公式）。
    const admission = validateAdmission(opts.maxConcurrency);
    if (!admission.ok) throw new Error(`createAiProviderWireHandler: ${admission.error}`);
  }

  const limits =
    opts.limits ??
    (() => {
      const enforcer = new LimitEnforcer({ dataDir: store.dataDir, now: () => new Date(now()) });
      enforcer.syncFromStore(store);
      return enforcer;
    })();
  const secrets = opts.secrets ?? defaultSecretReader(store.dataDir);
  const forwardPlane =
    opts.forwardPlane ??
    createForwardPlane({
      store,
      limits,
      maxConcurrency: opts.maxConcurrency,
      secrets,
      ...(opts.usageLog !== undefined && opts.usageLog !== null ? { usageLog: opts.usageLog } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.loader !== undefined ? { loader: opts.loader } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.probeConnect !== undefined ? { probeConnect: opts.probeConnect } : {}),
      ...(opts.timeouts !== undefined ? { timeouts: opts.timeouts } : {}),
      now,
    });
  const opGate = createOpGate({ ...(opts.authorize !== undefined ? { authorize: opts.authorize } : {}) });
  const directory = () => authDirectoryFromStore(store);

  /**
   * @param {string} op
   * @returns {(req: any) => Promise<any>}
   */
  const dispatch = (op) => {
    switch (op) {
      case "auth":
        return handleAuth;
      case "catalog":
        return handleCatalog;
      case "request":
        return handleRequest;
      default:
        // response/cancel=Phase B（B1 中继状态机）；端点登记但不实现——统一 404 同体。
        return async () => notFoundResponse();
    }
  };

  /**
   * @param {any} req
   * @param {string} peer
   */
  async function handleAuth(req) {
    if (req.method !== "POST") return notFoundResponse();
    const read = await readBoundedBody(req, CONTROL_BODY_LIMIT_BYTES);
    if (read.error === "pull") return null;
    if (read.error === "over-limit") {
      return jsonResponse(400, { code: "metadata_invalid", message: "auth body exceeds the control-body budget" });
    }
    let parsed;
    try {
      parsed = read.body.length === 0 ? {} : JSON.parse(read.body.toString("utf8"));
    } catch {
      return jsonResponse(400, { code: "metadata_invalid", message: "auth body is not valid JSON" });
    }
    const schema = AUTH_BODY_SCHEMA.safeParse(parsed);
    if (!schema.success) {
      return jsonResponse(400, { code: "metadata_invalid", message: "auth body must be {v:1, keys:[<=8 strings]}" });
    }
    const decision = handleAuthRequest({ keys: schema.data.keys }, directory());
    if (decision.kind === "err") {
      return jsonResponse(403, decision.body);
    }
    return jsonResponse(200, decision.body);
  }

  /**
   * @param {any} req
   */
  async function handleCatalog(req) {
    if (req.method !== "GET") return notFoundResponse();
    // 未 auth（无有效 keyId 绑定）=403 key_all_invalid
    const keyId = headerValue(req.headers, HDR_KEY_ID);
    const keyCheck = keyId === null ? { status: "invalid" } : store.keyStatus(keyId);
    if (keyCheck.status !== "valid") {
      return jsonResponse(403, { v: 1, code: ERROR_CODE.key_all_invalid });
    }
    const grant = { keyId: keyCheck.keyId, group: keyCheck.group };
    // since 解析（缺省=0=全量直取）
    let since = 0;
    const qIdx = req.path.indexOf("?");
    if (qIdx >= 0) {
      for (const pair of req.path.slice(qIdx + 1).split("&")) {
        const eq = pair.indexOf("=");
        if (eq < 0 || pair.slice(0, eq) !== "since") continue;
        const raw = decodeURIComponent(pair.slice(eq + 1));
        if (!/^\d+$/.test(raw)) {
          return jsonResponse(400, { code: "metadata_invalid", message: "since must be a non-negative integer" });
        }
        since = Number(raw);
      }
    }
    const watch = await watchCatalogRevision(store, {
      since,
      ...(opts.holdMs !== undefined ? { holdMs: opts.holdMs } : {}),
      ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
      now,
    });
    if (!watch.changed) {
      return {
        status: 204,
        headers: [{ name: HDR_REV, value: String(watch.rev) }],
        bodyChunks: [],
      };
    }
    const catalog = buildCatalogView(store, grant);
    const body = { v: 1, refresh: true, catalog, rev: watch.rev };
    // 防御性预算复核（工厂期已拒；运行期新增服务仍经 store ≤256 门）
    const bytes = Buffer.byteLength(JSON.stringify(body));
    if (bytes > 256 * 1024) {
      log("error", "ai wire: catalog body exceeds 256KiB budget despite factory gate");
      return jsonResponse(500, { code: ERROR_CODE.internal, message: "catalog exceeds the size budget" });
    }
    return {
      status: 200,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: HDR_REV, value: String(watch.rev) },
      ],
      bodyChunks: [Buffer.from(JSON.stringify(body))],
    };
  }

  /**
   * @param {any} req
   */
  async function handleRequest(req) {
    if (req.method !== "POST") return notFoundResponse();
    // ① 头预算（ai 元数据头合计 ≤8KiB）
    if (metadataHeaderBytes(req.headers) > METADATA_HEADER_BUDGET_BYTES) {
      return jsonResponse(400, { code: "metadata_too_large", message: "x-odai-* metadata headers exceed 8 KiB" });
    }
    // ② 元数据解析
    const serviceId = headerValue(req.headers, HDR_SERVICE);
    const method = headerValue(req.headers, HDR_METHOD);
    const path = headerValue(req.headers, HDR_PATH);
    const keyId = headerValue(req.headers, HDR_KEY_ID);
    if (serviceId === null || serviceId === "") {
      return jsonResponse(400, { code: "metadata_invalid", message: "x-odai-service header is required" });
    }
    if (keyId === null || keyId === "") {
      return jsonResponse(400, { code: "metadata_invalid", message: "x-odai-key-id header is required" });
    }
    if (method === null || !HTTP_METHODS.includes(method)) {
      return jsonResponse(400, { code: "metadata_invalid", message: "x-odai-method must be one of GET/HEAD/POST/PUT/PATCH/DELETE" });
    }
    if (path === null) {
      return jsonResponse(400, { code: "metadata_invalid", message: "x-odai-path header is required" });
    }
    const pathError = requestPathError(path);
    if (pathError !== null) {
      return jsonResponse(400, { code: "metadata_invalid", message: pathError });
    }
    // ③ x-odai-headers（上游头白名单 JSON 数组 ≤4KiB）
    let passthroughHeaders = {};
    let contentType;
    const rawPassthrough = headerValue(req.headers, HDR_HEADERS);
    if (rawPassthrough !== null) {
      if (Buffer.byteLength(rawPassthrough) > PASSTHROUGH_HEADERS_MAX_BYTES) {
        return jsonResponse(400, { code: "metadata_invalid", message: "x-odai-headers exceeds 4 KiB" });
      }
      let list;
      try {
        list = JSON.parse(rawPassthrough);
      } catch {
        return jsonResponse(400, { code: "metadata_invalid", message: "x-odai-headers is not valid JSON" });
      }
      if (!Array.isArray(list) || list.length > 32 || list.some((e) => e === null || typeof e !== "object" || typeof e.name !== "string" || typeof e.value !== "string")) {
        return jsonResponse(400, { code: "metadata_invalid", message: "x-odai-headers must be a JSON array of {name,value} (<=32)" });
      }
      passthroughHeaders = {};
      for (const e of list) passthroughHeaders[e.name] = e.value;
      // content-type=结构性头（非凭据）：从白名单表抽出、经独立字段折叠（与
      // ai-fly REQ.contentType 同语义）；凭据/归属类头（authorization/
      // proxy-authorization/cookie/host）仍协议层拒绝。
      if (passthroughHeaders["content-type"] !== undefined) {
        contentType = passthroughHeaders["content-type"];
        delete passthroughHeaders["content-type"];
      }
      const headersError = passthroughHeadersError(passthroughHeaders);
      if (headersError !== null) {
        return jsonResponse(400, { code: "metadata_invalid", message: headersError });
      }
    }
    // ④ keyId 绑定（三码分立：request 未知 keyId=key_invalid / 已撤=key_revoked）
    const keyCheck = store.keyStatus(keyId);
    if (keyCheck.status === "invalid") {
      return jsonResponse(403, { code: "key_invalid", message: "keyId was never issued by this provider" });
    }
    if (keyCheck.status === "revoked") {
      return jsonResponse(403, { code: "key_revoked", message: "keyId has been revoked" });
    }
    // ⑤ 请求体（≤maxChunkPayload；serviceId 双源拒绝）
    const read = await readBoundedBody(req, MAX_CHUNK_PAYLOAD);
    if (read.error === "pull") return null;
    if (read.error === "over-limit") {
      return jsonResponse(413, { code: "body_too_large", message: `request body exceeds maxChunkPayload (${MAX_CHUNK_PAYLOAD} bytes)` });
    }
    if (serviceIdDuplicateSource(req.path, read.body)) {
      return jsonResponse(400, {
        code: "service_source_conflict",
        message: "x-odai-service is the only serviceId source; service info in the query string or body is rejected",
      });
    }
    if (req.signal?.aborted) return null;
    // ⑥ 服务定位 + 组成员（disabled 服务按 unknown_service）
    const service = store.getService(serviceId);
    if (service === undefined || service.enabled === false) {
      return jsonResponse(404, { code: "unknown_service", message: "no such service is offered" });
    }
    const group = store.getGroup(keyCheck.group);
    if (group === undefined || !group.serviceIds.includes(serviceId)) {
      return jsonResponse(404, { code: "unknown_service", message: "no such service is offered" });
    }
    // ⑦ forward（admission/limits→rewrite 白名单→上游；path_not_offered 仅双过后）
    const outcome = await forwardPlane.request({
      keyId,
      group: keyCheck.group,
      service,
      method,
      path,
      headers: passthroughHeaders,
      ...(contentType !== undefined ? { contentType } : {}),
      body: read.body,
      signal: req.signal ?? new AbortController().signal,
    });
    if (!outcome.ok) {
      return jsonResponse(outcome.httpStatus, { code: outcome.code, message: outcome.message });
    }
    return jsonResponse(200, {
      responseId: outcome.responseId,
      epoch: outcome.epoch,
      status: outcome.status,
      headers: outcome.headers ?? {},
    });
  }

  /**
   * handler（createWpkRouter routes.ai 挂点；peer=serveHttp 绑定对端）。
   * @param {any} req
   * @param {string} peer
   */
  return async function aiWireHandler(req, peer) {
    if (req?.signal?.aborted) return null;
    const parsed = parseWirePath(typeof req?.path === "string" ? req.path : "");
    if (parsed === null) {
      // 未知子路径/无 op 段——404 同体（不解析 key）
      return notFoundResponse();
    }
    if (!(await opGate.allows(peer, opGateName(parsed.op)))) {
      // peer 未授权 / op 未授权——404 同体（不解析 key）
      return notFoundResponse();
    }
    try {
      return await dispatch(parsed.op)(req);
    } catch (err) {
      log("error", `ai wire handler error at ${parsed.op}: ${err instanceof Error ? err.message : String(err)}`);
      return jsonResponse(500, { code: ERROR_CODE.internal, message: "internal provider error" });
    }
  };
}

export { AI_WIRE_PREFIX };
