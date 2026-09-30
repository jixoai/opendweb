// files 插件运行时工厂（webui-plugin-kernel Phase 2 / design v2.3 §3.2+§6）。
// 意图（2026-09-29）：
// 1. `createFilesRuntime({home, now, log, resolvePeer, ...})`——经宿主
//    createPluginHost 的 runtimes 通道注入（onEnable/onDispose）；返回：
//    descriptor / capability / handler（HttpHandler 形状——serveHttp 直挂）/
//    shares（账本管理面）/ dispose 状态。
// 2. wire：`/wpk1/files/<shareId>/<op>`（GET list|stat|read、PUT chunk、
//    POST commit|mkdir|rename|delete）。授权 deny-by-default：
//    request.sessionId 为隔离键（design §3.2——同 peer 异 session 不继承授权：
//    每次 resolvePeer(sessionId) 现查，零授权缓存）→ peer endpointId →
//    share.peers 成员判定；写操作另过 mode=rw 门。
// 3. 预算（design §4；r8-B4 v1 有效包络收窄）：files 并发传输（chunk+read 流）
//    ≤ maxConcurrentTransfers（默认 4），超预算 429；单 chunk ≤ chunkMaxBytes
//    （默认 1MiB，超限 413、未知长度边读边累计立即拒；上限不得配置超过 1MiB
//    ——transport 帧上限，必然失败配置在工厂期拒绝）；单 read ≤ readMaxBytes
//    （默认 1MiB——客户端 Range 循环续读；同为帧上限约束）。
// 4. 序列化：**全部 share 树操作（list/stat/read 打开段/commit/mkdir/rename/
//    delete）经单 async 互斥**——verified-walk 模式的竞态免疫按构造成立
//    （wire 对端的一切变更同闸串行）；fd-chain 模式该闸只是公平性措施。
//    读流主体（fd 已开）与 chunk staging（home 下，不触 share 树）在闸外。
// 5. 停用（onDispose）：停止 TTL 扫描、关全部冻结 root fd、置 disposed——
//    新 wire 请求 503；宿主 drain 语义由 beginActivity 通道承载（接线方）。
// 6. 零凭证：本模块不读 argv/env；会话身份经注入的 resolvePeer。

import path from "node:path";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import { filesDescriptor } from "./plugin.mjs";
import {
  WIN32_DEGRADATION_NOTE,
  WireFsError,
  openRootFd,
  pathSafetyCapability,
  validateComponents,
} from "./fdchain.mjs";
import {
  emptyShares,
  loadShares,
  mutateShares,
  randomShareId,
  sharesPath,
  validateShareInput,
  ShareValidationError,
} from "./ledger.mjs";
import { createStaging, DEFAULT_CHUNK_MAX_BYTES, DEFAULT_STAGING_TTL_MS } from "./staging.mjs";
import * as ops from "./ops.mjs";

/** 默认 sweep 间隔（60s） */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** 默认并发传输上限（design §4：files ≤4） */
export const DEFAULT_MAX_CONCURRENT_TRANSFERS = 4;
/** 单 read 默认上限（1MiB——与 chunk 同档；客户端 offset/len 循环） */
export const DEFAULT_READ_MAX_BYTES = DEFAULT_CHUNK_MAX_BYTES;
/** v1 有效硬上限（r8-B4）：chunk/read 单请求字节 ≤1MiB（fabric session
 * MAX_FRAME=1MiB——更大的单帧在真实 transport 上必然失败，配置期拒绝） */
export const MAX_TRANSFER_ENVELOPE_BYTES = 1024 * 1024;
/** JSON body 上限（commit/mkdir/rename/delete 的小 JSON） */
const JSON_BODY_MAX = 64 * 1024;

/** wire 协议前缀 */
const WIRE_PREFIX = "/wpk1/files/";

/**
 * wire 层错误（HTTP 语义；runtime 自产的授权/解析/预算类）。
 */
class WireError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = "WireError";
    this.status = status;
    this.code = code;
  }
}

/** WireFsError.code → HTTP 状态（文件系统语义面） */
const FS_STATUS = {
  NOT_FOUND: 404,
  ROOT_GONE: 404,
  SYMLINK: 400,
  ESCAPE: 400,
  NOT_DIR: 400,
  IS_DIR: 400,
  TYPE_MISMATCH: 400,
  EXISTS: 409,
  NOT_EMPTY: 409,
  COVERAGE: 409,
  DIGEST: 422,
  RACE_DETECTED: 409,
  DENIED: 403,
  IO: 500,
};

/**
 * @param {unknown} e
 * @returns {{ status: number, code: string, message: string }}
 */
function toErrorResponse(e) {
  if (e instanceof WireError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof WireFsError) {
    return { status: FS_STATUS[e.code] ?? 500, code: e.code, message: e.message };
  }
  if (e instanceof ShareValidationError) return { status: 400, code: "invalid-share", message: e.message };
  const err = /** @type {NodeJS.ErrnoException} */ (e);
  return { status: 500, code: "internal", message: err.code ?? err.message ?? "internal error" };
}

/**
 * JSON 响应体（HttpHandlerResponse 形状）。
 * @param {number} status
 * @param {unknown} body
 * @returns {{ status: number, headers: Array<{ name: string, value: string }>, bodyChunks: Array<Uint8Array> }}
 */
function jsonResponse(status, body) {
  return {
    status,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyChunks: [Buffer.from(JSON.stringify(body))],
  };
}

/**
 * 解析 query（手工切分+decodeURIComponent——不做 `+`→空格换算，文件名里的
 * `+` 合法；客户端应百分号编码空格）。
 * @param {string} qs 不含 ? 的 query 串
 * @returns {Record<string, string>}
 */
function parseQuery(qs) {
  /** @type {Record<string, string>} */
  const out = {};
  if (qs === "") return out;
  for (const pair of qs.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      // 非法百分号序列——丢弃该对（deny 该参数）
    }
  }
  return out;
}

/**
 * @param {Record<string, string>} q
 * @param {string} key
 * @returns {number}
 */
function intParam(q, key) {
  const v = q[key];
  if (v === undefined) throw new WireError(400, "bad-param", `missing query parameter: ${key}`);
  if (!/^\d{1,16}$/.test(v)) throw new WireError(400, "bad-param", `${key} must be a non-negative integer`);
  return Number(v);
}

/**
 * 运行时工厂。
 * @param {{
 *   home: string,
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   resolvePeer?: (sessionId: string) => Promise<string | null>,
 *   isPidAlive?: (pid: number) => boolean,
 *   stagingTtlMs?: number,
 *   sweepIntervalMs?: number,
 *   chunkMaxBytes?: number,
 *   readMaxBytes?: number,
 *   maxConcurrentTransfers?: number,
 * }} opts
 * @returns {Promise<FilesRuntime>}
 */
export async function createFilesRuntime(opts = {}) {
  const { home } = opts;
  if (typeof home !== "string" || home === "") throw new Error("createFilesRuntime: home (DWEB_HOME absolute path) is required");
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const resolvePeer = opts.resolvePeer;
  const chunkMaxBytes = opts.chunkMaxBytes ?? DEFAULT_CHUNK_MAX_BYTES;
  const readMaxBytes = opts.readMaxBytes ?? DEFAULT_READ_MAX_BYTES;
  // r8-B4 必然失败配置防线：chunk/read 单请求上限不得超过 1MiB transport 有效
  // 包络（更大值=单帧超 fabric MAX_FRAME，真实网络上确定性失败）——工厂期拒绝。
  for (const [name, value] of /** @type {[string, number][]} */ ([["chunkMaxBytes", chunkMaxBytes], ["readMaxBytes", readMaxBytes]])) {
    if (value > MAX_TRANSFER_ENVELOPE_BYTES) {
      throw new Error(`createFilesRuntime: ${name}=${value} exceeds the v1 transport envelope of ${MAX_TRANSFER_ENVELOPE_BYTES} bytes (fabric session MAX_FRAME = 1MiB); larger per-request caps deterministically fail on the real transport`);
    }
  }
  const maxConcurrentTransfers = opts.maxConcurrentTransfers ?? DEFAULT_MAX_CONCURRENT_TRANSFERS;
  const lockCtx = { now, ...(opts.isPidAlive !== undefined ? { isPidAlive: opts.isPidAlive } : {}) };

  const capability = await pathSafetyCapability();
  if (capability.mode !== "unsupported") {
    for (const line of capability.evidence) log(`files: path-safety: ${line}`);
  } else {
    log(`files: path-safety: ${WIN32_DEGRADATION_NOTE}`);
  }

  const staging = createStaging({ home, ttlMs: opts.stagingTtlMs ?? DEFAULT_STAGING_TTL_MS, now });

  // ---- 状态 ----------------------------------------------------------------------
  /** @type {Map<string, import("./ops.mjs").RootRef>} */
  const rootCache = new Map();
  let disposed = false;
  let enabled = false;
  /** @type {NodeJS.Timeout | null} */
  let sweepTimer = null;
  /** 并发传输预算（chunk+read 流） */
  let transfersInFlight = 0;
  /** share 树操作互斥（verified-walk 竞态免疫的构造基础） */
  let opsChain = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serialize(fn) {
    if (disposed) return Promise.reject(new WireError(503, "plugin-disposed", "files runtime is disposed"));
    const run = opsChain.then(fn, fn);
    opsChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** @returns {boolean} */
  function acquireTransferSlot() {
    if (transfersInFlight >= maxConcurrentTransfers) return false;
    transfersInFlight++;
    return true;
  }

  function releaseTransferSlot() {
    transfersInFlight = Math.max(0, transfersInFlight - 1);
  }

  // ---- root 冻结 -------------------------------------------------------------------
  /**
   * 取（或打开并冻结）share root fd。
   * @param {{ id: string, root: string }} share
   * @returns {Promise<{ rootFd: number, rootPath: string, rootIno: number, rootDev: number }>}
   */
  async function rootOf(share) {
    const hit = rootCache.get(share.id);
    if (hit !== undefined && hit.rootPath === share.root) return hit;
    if (hit !== undefined) {
      fsSync.closeSync(hit.rootFd);
      rootCache.delete(share.id);
    }
    const fd = await openRootFd(share.root).catch((e) => {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "ELOOP") throw new WireFsError("SYMLINK", "share root is a symbolic link");
      if (err.code === "ENOENT") throw new WireFsError("NOT_FOUND", "share root does not exist (removed on the host)");
      if (err.code === "ENOTDIR") throw new WireFsError("NOT_DIR", "share root is not a directory");
      throw new WireFsError("IO", `opening share root: ${err.code ?? err.message}`);
    });
    const st = fsSync.fstatSync(fd);
    const ref = { rootFd: fd, rootPath: share.root, rootIno: st.ino, rootDev: st.dev };
    rootCache.set(share.id, ref);
    return ref;
  }

  // ---- 账本管理面 -------------------------------------------------------------------
  const shares = {
    /** @returns {Promise<Array<{ id: string, name: string, root: string, mode: "ro" | "rw", peers: string[], created: number }>>} */
    async list() {
      return (await loadShares(home)).shares;
    },
    /**
     * @param {string} id
     * @returns {Promise<{ id: string, name: string, root: string, mode: "ro" | "rw", peers: string[], created: number } | null>}
     */
    async get(id) {
      return (await loadShares(home)).shares.find((s) => s.id === id) ?? null;
    },
    /**
     * 新建共享（默认 ro；root 校验+win32 显式拒绝）。
     * @param {{ name: unknown, root: unknown, mode?: unknown, peers?: unknown }} input
     * @returns {Promise<{ id: string, name: string, root: string, mode: "ro" | "rw", peers: string[], created: number }>}
     */
    async add(input) {
      if (capability.mode === "unsupported") {
        throw new WireError(501, "unsupported-platform", WIN32_DEGRADATION_NOTE);
      }
      const v = await validateShareInput(input);
      /** @type {ReturnType<typeof emptyShares>["shares"][number] | null} */
      let created = null;
      const m = await mutateShares(
        home,
        (ledger) => {
          for (const s of ledger.shares) {
            if (s.root === v.root) throw new ShareValidationError(`root is already shared as "${s.id}" (${s.name})`);
          }
          created = { id: randomShareId(), name: v.name, root: v.root, mode: v.mode, peers: v.peers, created: now() };
          ledger.shares.push(created);
        },
        lockCtx,
      );
      if (!m.ok) throw new WireError(503, "lock", "cannot acquire the shares ledger lock");
      return /** @type {NonNullable<typeof created>} */ (created);
    },
    /**
     * @param {string} id
     */
    async remove(id) {
      const m = await mutateShares(
        home,
        (ledger) => {
          ledger.shares = ledger.shares.filter((s) => s.id !== id);
        },
        lockCtx,
      );
      const hit = rootCache.get(id);
      if (hit !== undefined) {
        fsSync.closeSync(hit.rootFd);
        rootCache.delete(id);
      }
      if (!m.ok) throw new WireError(503, "lock", "cannot acquire the shares ledger lock");
    },
    /**
     * @param {string} id
     * @param {"ro" | "rw"} mode
     */
    async setMode(id, mode) {
      if (mode !== "ro" && mode !== "rw") throw new ShareValidationError('mode must be "ro" or "rw"');
      const m = await mutateShares(
        home,
        (ledger) => {
          const s = ledger.shares.find((x) => x.id === id);
          if (s === undefined) throw new ShareValidationError(`unknown share: ${id}`);
          s.mode = mode;
        },
        lockCtx,
      );
      if (!m.ok) throw new WireError(503, "lock", "cannot acquire the shares ledger lock");
    },
    /**
     * @param {string} id
     * @param {string[]} peers
     */
    async setPeers(id, peers) {
      if (!Array.isArray(peers) || peers.some((p) => typeof p !== "string" || p === "" || p.length > 128)) {
        throw new ShareValidationError("share peers must be an array of endpoint ids");
      }
      const m = await mutateShares(
        home,
        (ledger) => {
          const s = ledger.shares.find((x) => x.id === id);
          if (s === undefined) throw new ShareValidationError(`unknown share: ${id}`);
          s.peers = [...new Set(peers)];
        },
        lockCtx,
      );
      if (!m.ok) throw new WireError(503, "lock", "cannot acquire the shares ledger lock");
    },
  };

  // ---- 授权 ------------------------------------------------------------------------
  /**
   * peer id 归一（真双机验收 F1 修复，2026-09-30）：fabric 会话 peer 是 z-base-32
   * 展示串，账本/控制面可能登记 hex64（server 租约冻结形态）——同钥异码先归一再
   * 比，防「已授权仍 403」。实现与 ext-ports ledger.mjs 的 normalizePeerId 同源
   * （包边界隔离，各自内联——第一轮验收 ④ 同族缺陷的 files 侧闭合）。
   * @param {string} peer
   * @returns {string} hex64 小写（z32 输入）；hex64 与未知形态原样返回
   */
  function normalizePeerId(peer) {
    if (typeof peer !== "string") return peer;
    if (/^[0-9a-f]{64}$/.test(peer)) return peer;
    if (!/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(peer)) return peer;
    const A = "ybndrfg8ejkmcpqxot1uwisza345h769";
    let bits = 0;
    let value = 0n;
    const bytes = [];
    for (const ch of peer) {
      value = value * 32n + BigInt(A.indexOf(ch));
      bits += 5;
      while (bits >= 8) {
        bits -= 8;
        bytes.push(Number((value >> BigInt(bits)) & 0xffn));
        value = value % (1n << BigInt(bits));
      }
    }
    return Buffer.from(bytes).toString("hex");
  }

  /**
   * deny-by-default：session → peer（现查，零缓存——同 peer 异 session 不继承
   * 授权）→ peers 成员（编码归一比对——z32/hex 同钥等价）→（写）mode=rw。
   * @param {{ sessionId?: string }} request
   * @param {{ peers: string[], mode: "ro" | "rw" }} share
   * @param {boolean} needWrite
   * @returns {Promise<string>} peer endpointId
   */
  async function authorize(request, share, needWrite) {
    if (capability.mode === "unsupported") throw new WireError(501, "unsupported-platform", WIN32_DEGRADATION_NOTE);
    const sessionId = request.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") throw new WireError(403, "session-unknown", "no logical session on the request");
    const peer = resolvePeer !== undefined ? await resolvePeer(sessionId) : null;
    if (peer === null || peer === undefined) {
      throw new WireError(403, "session-unknown", "the session is not bound to a known peer (deny by default)");
    }
    const wanted = normalizePeerId(peer);
    if (!share.peers.some((p) => normalizePeerId(p) === wanted)) {
      throw new WireError(403, "peer-not-authorized", `peer ${peer} is not authorized for this share`);
    }
    if (needWrite && share.mode !== "rw") {
      throw new WireError(403, "share-readonly", "the share is read-only");
    }
    return peer;
  }

  // ---- body -----------------------------------------------------------------------
  /**
   * 读全量 JSON body（上限 64KiB）。
   * @param {() => Promise<Buffer | null>} bodyNext
   * @returns {Promise<Record<string, unknown>>}
   */
  async function readJsonBody(bodyNext) {
    /** @type {Buffer[]} */
    const parts = [];
    let total = 0;
    for (;;) {
      const chunk = await bodyNext();
      if (chunk === null) break;
      total += chunk.length;
      if (total > JSON_BODY_MAX) throw new WireError(413, "payload-too-large", "JSON body exceeds 64KiB");
      parts.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new WireError(400, "bad-json", "JSON body must be an object");
      }
      return parsed;
    } catch (e) {
      if (e instanceof WireError) throw e;
      throw new WireError(400, "bad-json", "JSON body is malformed");
    }
  }

  /**
   * 读 chunk body（边读边累计——达上限立即拒，不缓冲后判）。
   * @param {() => Promise<Buffer | null>} bodyNext
   * @returns {Promise<Uint8Array>}
   */
  async function readChunkBody(bodyNext) {
    /** @type {Buffer[]} */
    const parts = [];
    let total = 0;
    for (;;) {
      const chunk = await bodyNext();
      if (chunk === null) break;
      total += chunk.length;
      if (total > chunkMaxBytes) {
        throw new WireError(413, "chunk-too-large", `chunk exceeds the ${chunkMaxBytes}-byte limit`);
      }
      parts.push(chunk);
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  // ---- wire 分派 -------------------------------------------------------------------
  /**
   * HttpHandler 形状的 wire 入口（serveHttp 直挂；测试直调）。
   * @param {import("./http-shapes.d.mts").HttpHandlerRequestLike} request
   * @returns {Promise<import("./http-shapes.d.mts").HttpHandlerResponseLike | null>}
   */
  async function handler(request) {
    try {
      return await dispatch(request);
    } catch (e) {
      const mapped = toErrorResponse(e);
      log(`files: wire error ${mapped.status} ${mapped.code}: ${mapped.message}`);
      return jsonResponse(mapped.status, { error: mapped.code, message: mapped.message });
    }
  }

  /**
   * @param {import("./http-shapes.d.mts").HttpHandlerRequestLike} request
   */
  async function dispatch(request) {
    if (disposed) throw new WireError(503, "plugin-disposed", "files runtime is disposed");
    const rawPath = request.path ?? "";
    const qIdx = rawPath.indexOf("?");
    const pathNoQuery = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx);
    const query = parseQuery(qIdx === -1 ? "" : rawPath.slice(qIdx + 1));
    if (!pathNoQuery.startsWith(WIRE_PREFIX)) {
      throw new WireError(404, "not-found", `unknown files wire path (expected ${WIRE_PREFIX}<shareId>/<op>)`);
    }
    const rest = pathNoQuery.slice(WIRE_PREFIX.length).split("/");
    let shareId = "";
    try {
      shareId = decodeURIComponent(rest[0] ?? "");
    } catch {
      throw new WireError(404, "no-such-share", "unknown files wire path (bad percent-encoding)");
    }
    const op = rest[1] ?? "";
    if (rest.length > 2 || rest[0] === "" || rest[1] === "" || rest.some((s) => s === "")) {
      throw new WireError(404, "not-found", "unknown files wire path");
    }
    const share = (await loadShares(home)).shares.find((s) => s.id === shareId);
    if (share === undefined) throw new WireError(404, "no-such-share", `unknown share: ${shareId}`);

    const method = (request.method ?? "GET").toUpperCase();
    const readOps = new Set(["GET"]);
    if (!readOps.has(method) && method !== "PUT" && method !== "POST") {
      throw new WireError(405, "method-not-allowed", `method ${method} is not allowed here`);
    }
    switch (op) {
      case "list":
      case "stat": {
        if (method !== "GET") throw new WireError(405, "method-not-allowed", `${op} requires GET`);
        await authorize(request, share, false);
        return await serialize(async () => {
          const root = await rootOf(share);
          const rules = await ops.loadIgnoreRules(capability, root);
          const v = validateComponents(query.path ?? "");
          if (!v.ok) throw new WireError(400, "path-escape", v.reason);
          if (ops.isReservedName(v.components[v.components.length - 1] ?? "")) {
            throw new WireFsError("NOT_FOUND", "reserved name");
          }
          if (op === "list") {
            const out = await ops.listDir(capability, root, v.components, rules);
            return jsonResponse(200, out);
          }
          const st = await ops.statEntry(capability, root, v.components, rules);
          return jsonResponse(200, st);
        });
      }
      case "read": {
        if (method !== "GET") throw new WireError(405, "method-not-allowed", "read requires GET");
        await authorize(request, share, false);
        if (!acquireTransferSlot()) throw new WireError(429, "too-many-transfers", "too many concurrent transfers; retry after one completes");
        /** @type {number | null} */
        let readFd = null;
        try {
          const opened = await serialize(async () => {
            const root = await rootOf(share);
            const rules = await ops.loadIgnoreRules(capability, root);
            const v = validateComponents(query.path ?? "");
            if (!v.ok) throw new WireError(400, "path-escape", v.reason);
            if (ops.isReservedName(v.components[v.components.length - 1] ?? "")) {
              throw new WireFsError("NOT_FOUND", "reserved name");
            }
            return ops.openForRead(capability, root, v.components, rules);
          });
          readFd = opened.fd;
          const offset = query.offset !== undefined ? intParam(query, "offset") : 0;
          if (offset > opened.size) {
            throw new WireError(416, "range-not-satisfiable", `offset ${offset} is past end of file (size ${opened.size})`);
          }
          const wantLen = query.len !== undefined ? intParam(query, "len") : readMaxBytes;
          if (wantLen > readMaxBytes) {
            throw new WireError(400, "len-too-large", `len must be <= ${readMaxBytes} per request (Range loop with offset)`);
          }
          const len = Math.min(wantLen, opened.size - offset);
          const writer = request.respondStreaming(200, [
            { name: "content-type", value: "application/octet-stream" },
            { name: "content-length", value: String(len) },
            { name: "etag", value: `"${opened.oid}"` },
            { name: "x-opendweb-oid", value: opened.oid },
            { name: "x-opendweb-size", value: String(opened.size) },
            { name: "accept-ranges", value: "bytes" },
            { name: "content-range", value: `bytes ${offset}-${offset + Math.max(len, 1) - 1}/${opened.size}` },
          ]);
          if (writer === null || writer === undefined) return null; // 已结算（流式句柄被竞先）
          try {
            let cancelled = false;
            request.signal?.addEventListener("abort", () => {
              cancelled = true;
            }, { once: true });
            await ops.streamRange(readFd, offset, len, async (chunk) => {
              if (cancelled || writer.closed) throw new WireError(499, "client-cancelled", "the consumer cancelled the download");
              await writer.write(chunk);
            });
          } finally {
            writer.finish();
          }
          return null;
        } finally {
          if (readFd !== null) fsSync.closeSync(readFd);
          releaseTransferSlot();
        }
      }
      case "chunk": {
        if (method !== "PUT") throw new WireError(405, "method-not-allowed", "chunk requires PUT");
        await authorize(request, share, true);
        if (!acquireTransferSlot()) throw new WireError(429, "too-many-transfers", "too many concurrent transfers; retry after one completes");
        /** @type {Uint8Array | null} */
        let body = null;
        try {
          body = await readChunkBody(request.bodyNext);
        } finally {
          releaseTransferSlot();
        }
        const uploadId = query.uploadId ?? "";
        const declaredPath = query.path ?? "";
        const v = validateComponents(declaredPath);
        if (!v.ok) throw new WireError(400, "path-escape", v.reason);
        if (ops.isReservedName(v.components[v.components.length - 1] ?? "")) {
          throw new WireFsError("NOT_FOUND", "reserved name");
        }
        const result = await staging.putChunk({
          uploadId,
          seq: intParam(query, "seq"),
          offset: intParam(query, "offset"),
          bytes: /** @type {Uint8Array} */ (body),
          declaredHash: (query.hash ?? "").toLowerCase(),
          path: declaredPath,
        });
        if (!result.ok) {
          const status = result.code === "FORGED_HASH" ? 400 : result.code === "CHUNK_CONFLICT" || result.code === "PATH_MISMATCH" ? 409 : 400;
          throw new WireError(status, result.code.toLowerCase(), result.message);
        }
        return jsonResponse(200, { ok: true, idempotent: result.idempotent, received: result.received });
      }
      case "commit": {
        if (method !== "POST") throw new WireError(405, "method-not-allowed", "commit requires POST");
        await authorize(request, share, true);
        const bodyJson = await readJsonBody(request.bodyNext);
        const declaredPath = typeof bodyJson.path === "string" ? bodyJson.path : "";
        const v = validateComponents(declaredPath);
        if (!v.ok) throw new WireError(400, "path-escape", v.reason);
        if (typeof bodyJson.uploadId !== "string") throw new WireError(400, "bad-json", "uploadId is required");
        if (typeof bodyJson.totalLength !== "number" || !Number.isInteger(bodyJson.totalLength) || bodyJson.totalLength < 0) {
          throw new WireError(400, "bad-json", "totalLength must be a non-negative integer");
        }
        if (typeof bodyJson.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(bodyJson.contentHash)) {
          throw new WireError(400, "bad-json", "contentHash must be sha256 hex");
        }
        return await serialize(async () => {
          const root = await rootOf(share);
          const rules = await ops.loadIgnoreRules(capability, root);
          const out = await ops.commitUpload(capability, root, v.components, rules, staging, {
            uploadId: bodyJson.uploadId,
            totalLength: bodyJson.totalLength,
            contentHash: bodyJson.contentHash,
          });
          return jsonResponse(201, { ok: true, path: declaredPath, size: out.size, oid: out.oid });
        });
      }
      case "mkdir": {
        if (method !== "POST") throw new WireError(405, "method-not-allowed", "mkdir requires POST");
        await authorize(request, share, true);
        const bodyJson = await readJsonBody(request.bodyNext);
        const v = validateComponents(typeof bodyJson.path === "string" ? bodyJson.path : "");
        if (!v.ok) throw new WireError(400, "path-escape", v.reason);
        return await serialize(async () => {
          const root = await rootOf(share);
          const rules = await ops.loadIgnoreRules(capability, root);
          await ops.mkdirEntry(capability, root, v.components, rules);
          return jsonResponse(201, { ok: true, path: v.components.join("/") });
        });
      }
      case "rename": {
        if (method !== "POST") throw new WireError(405, "method-not-allowed", "rename requires POST");
        await authorize(request, share, true);
        const bodyJson = await readJsonBody(request.bodyNext);
        const fromV = validateComponents(typeof bodyJson.from === "string" ? bodyJson.from : "");
        if (!fromV.ok) throw new WireError(400, "path-escape", `from: ${fromV.reason}`);
        const toV = validateComponents(typeof bodyJson.to === "string" ? bodyJson.to : "");
        if (!toV.ok) throw new WireError(400, "path-escape", `to: ${toV.reason}`);
        return await serialize(async () => {
          const root = await rootOf(share);
          const rules = await ops.loadIgnoreRules(capability, root);
          await ops.renameEntry(capability, root, fromV.components, toV.components, rules);
          return jsonResponse(200, { ok: true, from: fromV.components.join("/"), to: toV.components.join("/") });
        });
      }
      case "delete": {
        if (method !== "POST") throw new WireError(405, "method-not-allowed", "delete requires POST");
        await authorize(request, share, true);
        const bodyJson = await readJsonBody(request.bodyNext);
        const v = validateComponents(typeof bodyJson.path === "string" ? bodyJson.path : "");
        if (!v.ok) throw new WireError(400, "path-escape", v.reason);
        return await serialize(async () => {
          const root = await rootOf(share);
          const rules = await ops.loadIgnoreRules(capability, root);
          const kind = await ops.deleteEntry(capability, root, v.components, rules);
          return jsonResponse(200, { ok: true, path: v.components.join("/"), kind });
        });
      }
      default:
        throw new WireError(404, "unknown-op", `unknown files operation: ${op}`);
    }
  }

  // ---- 生命周期（宿主 runtimes 通道） ----------------------------------------------
  /**
   * enable 逆序装配钩子（数据目录惰性创建+TTL 扫描启动）。
   * @param {{ home: string, dataDir: string }} ctx
   */
  async function onEnable(ctx) {
    void ctx;
    // dispose 可逆（§2.2「enabled⇄disabled 可往返」冻结承诺；真浏览器走查 P1
    // 实证曾做成一次性终态）：onDispose 已停扫描/清缓存/关 fd，本钩子对其
    // 全量重初始化（目录/staging/共享账本/扫描），重入安全。
    disposed = false;
    await fsp.mkdir(path.join(home, "plugins/files"), { recursive: true, mode: 0o700 });
    await fsp.mkdir(staging.root, { recursive: true, mode: 0o700 });
    await loadShares(home); // 损坏 fail-closed（启用期暴露）
    startSweep();
    enabled = true;
    log("files: runtime enabled");
  }

  function startSweep() {
    stopSweep();
    const interval = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    sweepTimer = setInterval(() => {
      staging.sweep().then((removed) => {
        for (const id of removed) log(`files: staging ttl-swept upload ${id}`);
      }, (e) => log(`files: staging sweep error: ${/** @type {Error} */ (e).message}`));
    }, interval);
    sweepTimer.unref?.();
  }

  function stopSweep() {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  /** dispose 钩子（停扫描+清 staging 一次+关冻结 fd+拒新）。 */
  async function onDispose() {
    disposed = true;
    stopSweep();
    await staging.sweep().catch(() => {});
    for (const [id, ref] of rootCache) {
      fsSync.closeSync(ref.rootFd);
      rootCache.delete(id);
    }
    enabled = false;
    log("files: runtime disposed");
  }

  return {
    descriptor: filesDescriptor(),
    capability,
    handler,
    shares,
    onEnable,
    onDispose,
    staging,
    get enabled() {
      return enabled;
    },
    get disposed() {
      return disposed;
    },
    /** 测试/观测面 */
    internals: {
      transfersInFlight: () => transfersInFlight,
      serialize,
      rootOf,
      stagingPath: staging.root,
      sharesFile: sharesPath(home),
      home,
    },
  };
}

/**
 * @typedef {Awaited<ReturnType<typeof createFilesRuntime>>} FilesRuntime
 */
