// wire 客户端控制器（B 侧 UI/测试用——webui-plugin-kernel Phase 2）。
// 意图（2026-09-29）：
// 1. UI 组件不直接 fetch（props 注入 controller）；本模块给出 controller 的
//   wire 参考实现：transport 注入（真实接线=client-sdk fetchHttp 的薄适配；
//   测试=直调注入式 handler 的回环 transport）。
// 2. 传输形状（冻结）：`transport({method, path, headers?, body?}) →
//   {status, headers(小写 record), readBody()}`；body 为静态分块
//   （Array<Uint8Array>——SDK fetchHttp 形状）。错误面：非 2xx →
//   WireClientError{status, code, message}（JSON 错误体）。
// 3. 上传：分片循环（默认 1MiB——r8-B4 v1 有效包络：transport 帧上限 1MiB，
//   真双机实证仅 1MiB chunk 稳定通过；chunkHash=sha256(bytes)）→ commit（整文件
//   sha256 增量累计——与服务端重算比对）。下载：offset/len Range 循环+
//   整体 sha256 校验（x-opendweb-oid 对账——传输层 EOF 不作完整性证据）。

import { createHash } from "node:crypto";

/** 默认分片（1MiB——与服务端 chunkMaxBytes 默认同拍；r8-B4：v1 transport 有效
 * 包络=1MiB 帧（fabric session MAX_FRAME）——更大分片在真实网络上必然失败） */
export const CLIENT_CHUNK_BYTES = 1024 * 1024;

/**
 * wire 客户端错误。
 */
export class WireClientError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = "WireClientError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @typedef {Object} WireTransport
 * @property {(req: { method: string, path: string, headers?: Array<{ name: string, value: string }>, body?: Array<Uint8Array> }) => Promise<{ status: number, headers: Record<string, string>, readBody: () => Promise<Buffer> }>} send
 */

/**
 * @typedef {Object} FileEntry
 * @property {string} name
 * @property {"dir" | "file"} type
 * @property {number} size
 * @property {number} mtime
 */

/**
 * 建 wire 客户端控制器。
 * @param {WireTransport} transport
 * @param {{ shareId: string, chunkBytes?: number }} opts
 */
export function createWireFilesController(transport, opts) {
  const chunkBytes = opts.chunkBytes ?? CLIENT_CHUNK_BYTES;
  const base = `/wpk1/files/${opts.shareId}`;

  /**
   * @param {{ method: string, path: string, body?: Array<Uint8Array> }} req
   */
  async function call(req) {
    const res = await transport.send(req);
    if (res.status < 200 || res.status > 299) {
      let code = `http-${res.status}`;
      let message = "";
      try {
        const parsed = JSON.parse((await res.readBody()).toString("utf8"));
        if (parsed !== null && typeof parsed === "object") {
          const r = /** @type {Record<string, unknown>} */ (parsed);
          if (typeof r.code === "string") code = r.code;
          if (typeof r.error === "string") code = r.error;
          if (typeof r.message === "string") message = r.message;
        }
      } catch {
        /* 非 JSON 错误体——用默认 code */
      }
      throw new WireClientError(res.status, code, message);
    }
    return res;
  }

  /**
   * @param {{ method: string, path: string, body?: Array<Uint8Array> }} req
   * @returns {Promise<Record<string, unknown>>}
   */
  async function callJson(req) {
    const res = await call(req);
    return JSON.parse((await res.readBody()).toString("utf8"));
  }

  /** @param {string} dirPath */
  async function list(dirPath) {
    const out = await callJson({ method: "GET", path: `${base}/list?path=${enc(dirPath)}` });
    return /** @type {{ entries: FileEntry[], truncated: boolean }} */ (out);
  }

  /**
   * @param {string} filePath
   * @returns {Promise<{ type: "dir" | "file", size: number, mtime: number, oid: string | null }>}
   */
  async function stat(filePath) {
    const out = await callJson({ method: "GET", path: `${base}/stat?path=${enc(filePath)}` });
    const r = /** @type {Record<string, unknown>} */ (out);
    return {
      type: r.type === "dir" ? "dir" : "file",
      size: typeof r.size === "number" ? r.size : 0,
      mtime: typeof r.mtime === "number" ? r.mtime : 0,
      oid: typeof r.oid === "string" ? r.oid : null,
    };
  }

  /**
   * 读一段（offset/len Range 语义；返回实际字节+响应 oid）。
   * @param {string} filePath
   * @param {number} offset
   * @param {number} len
   */
  async function readSlice(filePath, offset, len) {
    const res = await call({
      method: "GET",
      path: `${base}/read?path=${enc(filePath)}&offset=${offset}&len=${len}`,
    });
    return {
      bytes: new Uint8Array(await res.readBody()),
      oid: res.headers["x-opendweb-oid"] ?? null,
      size: res.headers["x-opendweb-size"] !== undefined ? Number(res.headers["x-opendweb-size"]) : null,
      rangeEnd: res.headers["content-range"] ?? null,
    };
  }

  /**
   * @param {string} filePath
   * @param {string} uploadId
   * @param {number} seq
   * @param {number} offset
   * @param {Uint8Array} bytes
   */
  async function putChunk(filePath, uploadId, seq, offset, bytes) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const out = await callJson({
      method: "PUT",
      path: `${base}/chunk?path=${enc(filePath)}&uploadId=${enc(uploadId)}&seq=${seq}&offset=${offset}&hash=${hash}`,
      body: [bytes],
    });
    return /** @type {{ idempotent: boolean, received: number }} */ (out);
  }

  /**
   * @param {string} filePath
   * @param {string} uploadId
   * @param {number} totalLength
   * @param {string} contentHash
   */
  async function commit(filePath, uploadId, totalLength, contentHash) {
    const out = await callJson({
      method: "POST",
      path: `${base}/commit`,
      body: [Buffer.from(JSON.stringify({ uploadId, path: filePath, totalLength, contentHash }))],
    });
    return /** @type {{ oid: string, size: number }} */ (out);
  }

  /** @param {string} dirPath */
  async function mkdir(dirPath) {
    await callJson({ method: "POST", path: `${base}/mkdir`, body: [Buffer.from(JSON.stringify({ path: dirPath }))] });
  }

  /**
   * @param {string} from
   * @param {string} to
   */
  async function rename(from, to) {
    await callJson({ method: "POST", path: `${base}/rename`, body: [Buffer.from(JSON.stringify({ from, to }))] });
  }

  /** @param {string} filePath */
  async function remove(filePath) {
    await callJson({ method: "POST", path: `${base}/delete`, body: [Buffer.from(JSON.stringify({ path: filePath }))] });
  }

  /**
   * 上传全流程（分片循环+进度+commit）。
   * @param {string} filePath 目标相对路径
   * @param {Uint8Array} bytes
   * @param {{ uploadId?: string, onProgress?: (sent: number, total: number) => void }} [o]
   * @returns {Promise<{ oid: string, size: number }>}
   */
  async function uploadFile(filePath, bytes, o = {}) {
    const uploadId = o.uploadId ?? `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const wholeHash = createHash("sha256");
    let seq = 0;
    for (let offset = 0; offset < bytes.length || (offset === 0 && bytes.length === 0); offset += chunkBytes, seq++) {
      const slice = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
      wholeHash.update(slice);
      await putChunk(filePath, uploadId, seq, offset, slice);
      o.onProgress?.(Math.min(offset + chunkBytes, bytes.length), bytes.length);
      if (bytes.length === 0) break;
    }
    return commit(filePath, uploadId, bytes.length, wholeHash.digest("hex"));
  }

  /**
   * 下载全流程（Range 循环+整体 sha256 对账 x-opendweb-oid）。
   * @param {string} filePath
   * @param {{ onProgress?: (received: number, total: number) => void }} [o]
   * @returns {Promise<{ bytes: Uint8Array, oid: string }>}
   */
  async function downloadFile(filePath, o = {}) {
    const first = await readSlice(filePath, 0, chunkBytes);
    const total = first.size ?? first.bytes.length;
    const oid = first.oid;
    const hash = createHash("sha256");
    /** @type {Buffer[]} */
    const parts = [Buffer.from(first.bytes)];
    hash.update(Buffer.from(first.bytes));
    let received = first.bytes.length;
    o.onProgress?.(received, total);
    while (received < total) {
      const slice = await readSlice(filePath, received, chunkBytes);
      if (slice.bytes.length === 0) break;
      parts.push(Buffer.from(slice.bytes));
      hash.update(Buffer.from(slice.bytes));
      received += slice.bytes.length;
      o.onProgress?.(received, total);
    }
    const digest = hash.digest("hex");
    if (oid !== null && digest !== oid) {
      throw new WireClientError(462, "digest-mismatch", `download digest mismatch (expected ${oid}, got ${digest})`);
    }
    return { bytes: new Uint8Array(Buffer.concat(parts)), oid: digest };
  }

  return { list, stat, readSlice, putChunk, commit, mkdir, rename, remove, uploadFile, downloadFile };
}

/**
 * 百分号编码（路径参数——空格=%20；不编码 `/`）。
 * @param {string} v
 */
function enc(v) {
  return encodeURIComponent(v);
}

/**
 * 回环 transport（测试/本机同进程用：直调注入式 handler）。
 * @param {(request: import("./http-shapes.d.mts").HttpHandlerRequestLike) => Promise<import("./http-shapes.d.mts").HttpHandlerResponseLike | null>} handler
 * @param {{ sessionId?: string }} [opts]
 * @returns {WireTransport}
 */
export function createHandlerTransport(handler, opts = {}) {
  const sessionId = opts.sessionId ?? "test-session";
  return {
    async send(req) {
      const controller = new AbortController();
      /** @type {Buffer[]} */
      const bodyQueue = (req.body ?? []).map((c) => Buffer.from(c));
      let bodyDone = false;
      /** @type {Buffer[]} */
      const streamed = [];
      /** @type {{ status: number, headers: Record<string, string> } | null} */
      let streamedMeta = null;
      const settled = await handler({
        sessionId,
        signal: controller.signal,
        method: req.method,
        path: req.path,
        headers: req.headers ?? [],
        bodyNext: async () => {
          if (bodyQueue.length > 0) return bodyQueue.shift();
          if (bodyDone) return null;
          bodyDone = true;
          return null;
        },
        respondStreaming: (status, headers) => {
          streamedMeta = {
            status,
            headers: Object.fromEntries((headers ?? []).map((h) => [h.name.toLowerCase(), h.value])),
          };
          return {
            write: async (chunk) => {
              streamed.push(Buffer.from(chunk));
            },
            finish: () => {},
            closed: false,
            cancelled: false,
          };
        },
      });
      if (settled !== null && settled !== undefined) {
        const headers = Object.fromEntries((settled.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
        const chunks = (settled.bodyChunks ?? []).map((c) => Buffer.from(c));
        return { status: settled.status, headers, readBody: async () => Buffer.concat(chunks) };
      }
      // 流式结算：status/headers 取自 respondStreaming 调用（write 全部完成于
      // handler promise 决议前——dispatch await streamRange 后才返回）
      return {
        status: streamedMeta?.status ?? 200,
        headers: streamedMeta?.headers ?? { "content-type": "application/octet-stream" },
        readBody: async () => Buffer.concat(streamed),
      };
    },
  };
}
