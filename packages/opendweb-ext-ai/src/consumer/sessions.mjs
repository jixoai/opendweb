// adapted from ai-fly src/consumer/providers.ts (v0.6.0) —— 消费方会话状态机
// （tasks B3）。与上游的有意分歧（design §0 consumer 行）：forward 层从自有
// fabric 改接**宿主注入面**——构造时接收 {fetchImpl} 形状的注入（镜像 client-sdk
// /http 的请求面：init {method,path,headers,body?,signal?} → {status,headers,
// bodyChunks}）；真 fabric 接线是 Phase C 宿主装配，Phase B 用注入面测。
// 职责：AUTH/catalog/request/response 拉取循环/cancel 的 wire 客户端 + 面向
// 本地网关的 forward/stream 复合面（SSE 字节流：保序/零丢失/零重复——
// committedSeq 连续推进；丢包重试同 seq 同内容）。

import {
  AI_WIRE_PREFIX,
  HDR_DONE,
  HDR_FROM_SEQ,
  HDR_HEADERS,
  HDR_KEY_ID,
  HDR_METHOD,
  HDR_NEXT_SEQ,
  HDR_PATH,
  HDR_REV,
  HDR_SEQ,
  HDR_SERVICE,
  MAX_CHUNK_PAYLOAD,
} from "../wire/constants.mjs";

/** wire 错误（OpenAI 风格 JSON 投影的源对象）。 */
export class WireError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]
   */
  constructor(status, code, message) {
    super(message ?? code);
    this.name = "WireError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {Array<{name: string, value: string}>} headers
 * @param {string} name 小写
 */
function headerValue(headers, name) {
  for (const h of headers ?? []) {
    if (h.name.toLowerCase() === name) return h.value;
  }
  return null;
}

/**
 * 消费方 wire 会话。
 * @param {{ fetchImpl: (init: { method: string, path: string, headers: Array<{name: string, value: string}>, body?: Buffer[], signal?: AbortSignal }) => Promise<{ status: number, headers: Array<{name: string, value: string}>, bodyChunks: Buffer[] }>, log?: (level: "info" | "warn" | "error", msg: string) => void }} opts
 */
export function createConsumerSession(opts) {
  if (typeof opts.fetchImpl !== "function") {
    throw new Error("createConsumerSession: fetchImpl (host-injected fabric face) is required");
  }

  /**
   * 单次 wire 调用（每调用=独立完整会话流——内核 2MiB/流记账天然覆盖）。
   * @param {{ method: string, path: string, headers?: Array<{name: string, value: string}>, body?: Buffer, signal?: AbortSignal }} init
   */
  async function call(init) {
    const res = await opts.fetchImpl({
      method: init.method,
      path: `${AI_WIRE_PREFIX}${init.path}`,
      headers: init.headers ?? [],
      ...(init.body !== undefined && init.body.length > 0 ? { body: [Buffer.from(init.body)] } : {}),
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
    });
    return {
      status: res.status,
      headers: res.headers ?? [],
      body: Buffer.concat((res.bodyChunks ?? []).map((c) => Buffer.from(c))),
      header(name) {
        return headerValue(this.headers, name);
      },
      json() {
        try {
          return JSON.parse(this.body.toString("utf8"));
        } catch {
          return undefined;
        }
      },
    };
  }

  /**
   * POST auth：{v:1,keys:[≤8]} → groups（多 key）；全错=WireError(403,key_all_invalid)。
   * @param {string[]} keys
   */
  async function auth(keys) {
    const res = await call({ method: "POST", path: "/auth", body: Buffer.from(JSON.stringify({ v: 1, keys })) });
    if (res.status === 403) throw new WireError(403, res.json()?.code ?? "key_all_invalid", res.json()?.message);
    if (res.status !== 200) throw new WireError(res.status, res.json()?.code ?? "internal", res.json()?.message);
    const body = res.json();
    return { groups: body.groups ?? [], rejected: body.rejected };
  }

  /**
   * GET catalog?since=<rev>（hold ≤20s；204 无变化/200 全量）。
   * @param {{ keyId: string, since?: number, signal?: AbortSignal }} input
   */
  async function catalog(input) {
    const res = await call({
      method: "GET",
      path: `/catalog?since=${input.since ?? 0}`,
      headers: [{ name: HDR_KEY_ID, value: input.keyId }],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (res.status === 204) return { changed: false, rev: Number(res.header(HDR_REV) ?? input.since ?? 0) };
    if (res.status !== 200) throw new WireError(res.status, res.json()?.code ?? "internal", res.json()?.message);
    const body = res.json();
    return { changed: true, rev: body.rev, catalog: body.catalog };
  }

  /**
   * POST request → {responseId, epoch, status, headers}（错误=WireError 透传码）。
   * @param {{ keyId: string, serviceId: string, method: string, path: string, headers?: Record<string, string>, contentType?: string, body?: Buffer, signal?: AbortSignal }} input
   */
  async function request(input) {
    const wireHeaders = [
      { name: HDR_SERVICE, value: input.serviceId },
      { name: HDR_METHOD, value: input.method },
      { name: HDR_PATH, value: input.path },
      { name: HDR_KEY_ID, value: input.keyId },
    ];
    const passthrough = { ...(input.headers ?? {}) };
    if (input.contentType !== undefined) passthrough["content-type"] = input.contentType;
    if (Object.keys(passthrough).length > 0) {
      wireHeaders.push({
        name: HDR_HEADERS,
        value: JSON.stringify(Object.entries(passthrough).map(([name, value]) => ({ name, value }))),
      });
    }
    if (input.body !== undefined && input.body.length > MAX_CHUNK_PAYLOAD) {
      throw new WireError(413, "body_too_large", `request body exceeds maxChunkPayload (${MAX_CHUNK_PAYLOAD} bytes)`);
    }
    const res = await call({
      method: "POST",
      path: "/request",
      headers: wireHeaders,
      ...(input.body !== undefined && input.body.length > 0 ? { body: input.body } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (res.status !== 200) throw new WireError(res.status, res.json()?.code ?? "internal", res.json()?.message);
    const body = res.json();
    return { responseId: body.responseId, epoch: body.epoch, status: body.status, headers: body.headers ?? {} };
  }

  /**
   * POST response/<rid>：单飞拉取（204 即重试；done=终态）。
   * @param {{ keyId: string, rid: string, fromSeq: number, signal?: AbortSignal }} input
   * @returns {Promise<{ status: number, seq?: number, done: boolean, nextSeq: number, chunk?: Buffer }>}
   */
  async function pull(input) {
    const res = await call({
      method: "POST",
      // rid=<epoch>:<单调号>（':' 为合法路径段字符——不得编码，provider 按原文匹配）
      path: `/response/${input.rid}`,
      headers: [
        { name: HDR_KEY_ID, value: input.keyId },
        { name: HDR_FROM_SEQ, value: String(input.fromSeq) },
      ],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (res.status === 204) {
      return { status: 204, done: false, nextSeq: Number(res.header(HDR_NEXT_SEQ) ?? input.fromSeq) };
    }
    if (res.status !== 200) throw new WireError(res.status, res.json()?.code ?? "internal", res.json()?.message);
    return {
      status: 200,
      seq: res.header(HDR_SEQ) !== null ? Number(res.header(HDR_SEQ)) : undefined,
      done: res.header(HDR_DONE) === "1",
      nextSeq: Number(res.header(HDR_NEXT_SEQ) ?? input.fromSeq),
      ...(res.body.length > 0 ? { chunk: res.body } : {}),
    };
  }

  /**
   * POST cancel（幂等）。
   * @param {{ keyId: string, rid: string, epoch: string }} input
   */
  async function cancel(input) {
    const res = await call({
      method: "POST",
      path: "/cancel",
      headers: [{ name: HDR_KEY_ID, value: input.keyId }],
      body: Buffer.from(JSON.stringify({ responseId: input.rid, epoch: input.epoch })),
    });
    if (res.status !== 200) throw new WireError(res.status, res.json()?.code ?? "internal", res.json()?.message);
    return res.json();
  }

  /**
   * 复合面：本地网关 forward（meta→逐分片流→done 确认释放占位）。
   * 取消双向传播：本地断开（abort 信号）→ cancel 端点 → 在途拉取 abort →
   * 上游 abort（provider 侧链）。
   * @param {{ keyId: string, serviceId: string, method: string, path: string, headers?: Record<string, string>, contentType?: string, body?: Buffer, signal?: AbortSignal }} input
   * @param {{ onMeta: (meta: { status: number, headers: Record<string, string> }) => void, onChunk: (chunk: Buffer) => void, onEnd: () => void, onError: (err: WireError) => void, onStarted?: (handle: { responseId: string, epoch: string }) => void }} handlers
   */
  async function forward(input, handlers) {
    let started = false;
    let doneSeen = false;
    try {
      const outcome = await request(input);
      started = true;
      handlers.onStarted?.({ responseId: outcome.responseId, epoch: outcome.epoch });
      handlers.onMeta({ status: outcome.status, headers: outcome.headers });
      // 拉取循环（SSE 字节流：保序/零丢失/零重复——committedSeq 连续推进）
      let fromSeq = 0;
      for (;;) {
        if (input.signal?.aborted) throw new WireError(499, "aborted", "local request aborted");
        let piece;
        try {
          piece = await pull({ keyId: input.keyId, rid: outcome.responseId, fromSeq, ...(input.signal !== undefined ? { signal: input.signal } : {}) });
        } catch (err) {
          if (err instanceof WireError && doneSeen && (err.code === "response_not_found" || err.code === "response_expired")) {
            break; // done 已见——终态记录已回收，数据面完整
          }
          throw err;
        }
        if (piece.status === 204) continue; // hold 醒来即重试（204 不续 TTL）
        if (piece.chunk !== undefined && piece.chunk.length > 0) handlers.onChunk(piece.chunk);
        fromSeq = piece.nextSeq;
        if (piece.done) {
          doneSeen = true;
          // 终态确认拉取（释放 provider 占位；摘要零 body）
          try {
            await pull({ keyId: input.keyId, rid: outcome.responseId, fromSeq });
          } catch {
            /* done 已见——确认拉取的 404/竞态不构成数据面错误 */
          }
          break;
        }
      }
      handlers.onEnd();
    } catch (err) {
      // 未起步=请求面错误（OpenAI 风格 JSON 投影）；流中途错误=显式错误
      // （MUST NOT 静默截断成成功）
      handlers.onError(err instanceof WireError ? err : new WireError(502, "internal", err instanceof Error ? err.message : String(err)));
    }
  }

  return { auth, catalog, request, pull, cancel, forward };
}
