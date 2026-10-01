// adapted from ai-fly src/provider/upstream.ts (v0.6.0)
// HTTP 上游转发：请求（重组完成）→ 出站归一层 → 响应投影（ResponseSink）。
// 超时族照搬（design A6）：连接期 10s（TCP 探测，fetch 不暴露连接建立，探测
// 失败/超时回 upstream_unreachable；绑定 ③ request 脚本时跳过——连接语义归
// 脚本）、首字节 600s（fetch resolve / ③ 脚本返回 = 响应头到达）、流停滞
// 120s（分片间）。
// 出站归一层照搬：js-backend-fetch 结果与 ③ onRequest 脚本结果统一归一为
// {status, headers, body: AsyncIterable}；③ 返回 headers 小写化/last-wins；
// ④ onResponse 在归一后、meta 下发前插入；引擎中止 cancel 归一迭代器
// （ReadableStream 走 cancel、AsyncIterable 调 return()）传播到脚本流。
// 错误分族照搬：HookStageError（②③④ 缺席/抛错/形状非法/流中途失败）→
// hook_failed；① HookMissingError 与 $secret 缺失 → secret_missing。
// 【与 ai-fly 的有意分歧】
// - WS 升级通道不移植（v1 不做 WS 透传——design §8）：检测到 WS 升级请求按
//   protocol_error 显式拒绝（错误文案固定脱敏），不建隧道。
// - env 参数不存在（design §4：插件自身代码路径不经 env 取凭证）。
// 正交意图照搬：授权/限额（编排层在拨号前完成；本层只转发已放行请求）；
// 请求体重组（编排层；本层收到完整正文）；上游 URL 目标仅来自本地服务配置
// （rewrite 断言过，请求内字段不影响 origin——防 SSRF）。

import { connect as netConnect } from "node:net";
import { ERROR_CODE, RESP_META_HEADER_WHITELIST, HTTP_METHODS } from "../wire/schemas.mjs";
import {
  effectiveLifecycleSlots,
  HookMissingError,
  HookStageError,
  resolveStageRequest,
  resolveStageResponse,
} from "./hooks.mjs";
import {
  buildUpstreamRequest,
  PathNotOfferedError,
  RewriteError,
  SecretMissingError,
  isWebSocketUpgradeRequest,
} from "./rewrite.mjs";

/** 上游超时族（全部可配；测试注入小值）。 */
export const DEFAULT_UPSTREAM_TIMEOUTS = {
  /** 上游连接期（TCP 探测窗）。 */
  connectMs: 10_000,
  /** 首字节（fetch resolve = 响应头到达）。 */
  firstByteMs: 600_000,
  /** 流中途停滞（分片间隔）。 */
  stallMs: 120_000,
};

/** 引擎侧主动中止（abort reason）：code = 回送错误码。 */
export class UpstreamAbortError extends Error {
  /**
   * @param {string} code
   */
  constructor(code) {
    super(`upstream forward aborted: ${code}`);
    this.name = "UpstreamAbortError";
    this.code = code;
  }
}

/** 连接期探测失败/超时（upstream_unreachable 语义）。 */
class ProbeFailedError extends Error {
  constructor() {
    super("upstream connect failed or timed out");
    this.name = "ProbeFailedError";
  }
}

/**
 * 转发上下文。
 * @typedef {Object} ForwardCtx
 * @property {ResponseSink} sink
 * @property {string} id
 * @property {Record<string, any>} service
 * @property {{ method: string, path: string, headers?: Record<string, string>, contentType?: string }} req
 * @property {Uint8Array} body
 * @property {AbortSignal} signal
 * @property {string} keyId
 * @property {{ connectMs?: number, firstByteMs?: number, stallMs?: number }} [timeouts]
 * @property {(record: { ts: number, keyId: string, serviceId: string, status: number | string, bytes: number }) => void} [onUsage]
 * @property {(name: string) => string | undefined} [secrets]
 * @property {string} [home]
 * @property {(name: string, home: string) => Record<string, unknown> | undefined} [loader]
 * @property {(url: URL, ms: number) => Promise<void>} [probeConnect]
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * 响应投影：meta/chunk/end/error 回调（Phase A 静态聚合 sink / Phase B 中继
 * 状态机 sink 共用同一面）。实现方保证单请求内调用次序（meta 先于 chunk/end；
 * error 与 end 互斥）。
 * @typedef {Object} ResponseSink
 * @property {(header: { id: string, status: number, contentType: string, headers?: Record<string, string> }) => void | Promise<void>} meta
 * @property {(body: Uint8Array) => void | Promise<void>} chunk
 * @property {() => void | Promise<void>} end
 * @property {(header: { id?: string, code: string, message: string }) => void | Promise<void>} error
 */

/** 响应分片缺省上限（256KiB 按字节切——SSE 字节流透明中继，无事件边界对齐）。 */
export const DEFAULT_BODY_CHUNK_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// 共用小件
// ---------------------------------------------------------------------------

/** 默认连接期探测：独立 TCP 连接探活（fetch 不暴露连接建立阶段；成功即销毁）。 */
export function defaultProbeConnect(url, ms) {
  return new Promise((resolve, reject) => {
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const socket = netConnect({ host: url.hostname, port });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err === undefined) resolve();
      else reject(err);
    };
    socket.setTimeout(ms, () => finish(new Error("connect timeout")));
    socket.once("connect", () => finish());
    socket.once("error", (err) => finish(err));
  });
}

/** RESP_META 白名单头挑选（小写键）。 */
export function pickResponseWhitelist(get) {
  const out = {};
  for (const name of RESP_META_HEADER_WHITELIST) {
    const value = get(name);
    if (value !== null) out[name] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 大分片拆为 ≤ 上限的序列。 */
export function splitBodyChunks(data, limit = DEFAULT_BODY_CHUNK_BYTES) {
  if (data.length <= limit) return [data];
  const out = [];
  for (let off = 0; off < data.length; off += limit) {
    out.push(data.subarray(off, Math.min(off + limit, data.length)));
  }
  return out;
}

/**
 * 信号 reason → 回送码（缺省 aborted）。
 * @param {AbortSignal} signal
 */
export function abortCodeOf(signal) {
  const reason = signal.reason;
  if (reason instanceof UpstreamAbortError) return { code: reason.code, reply: true };
  return { code: ERROR_CODE.aborted, reply: true };
}

function mergeTimeouts(overrides) {
  return { ...DEFAULT_UPSTREAM_TIMEOUTS, ...overrides };
}

// ---------------------------------------------------------------------------
// 入口：构造 plan（含双重断言）→ HTTP 转发（v1 无 WS 通道）
// ---------------------------------------------------------------------------

/**
 * @param {ForwardCtx} ctx
 */
export async function forwardRequest(ctx) {
  let plan;
  try {
    plan = await buildUpstreamRequest(ctx.service, ctx.req, ctx.secrets, {
      ...(ctx.home !== undefined ? { home: ctx.home } : {}),
      ...(ctx.loader !== undefined ? { loader: ctx.loader } : {}),
    });
  } catch (err) {
    // 分类：① auth 失效与 $secret 未命中（secret_missing）> ② 脚本失效
    // （hook_failed——rewrite 构造期同样归此码）> 路由白名单外
    // （path_not_offered）> RewriteError（protocol_error）> 兜底。
    // 前若干类都是零上游请求；message 不含密钥名与值。
    const code =
      err instanceof SecretMissingError || err instanceof HookMissingError
        ? ERROR_CODE.secret_missing
        : err instanceof HookStageError
          ? ERROR_CODE.hook_failed
          : err instanceof PathNotOfferedError
            ? ERROR_CODE.path_not_offered
            : ERROR_CODE.protocol_error;
    const message =
      err instanceof RewriteError ||
      err instanceof SecretMissingError ||
      err instanceof PathNotOfferedError ||
      err instanceof HookStageError ||
      err instanceof HookMissingError
        ? err.message
        : "request rewrite failed";
    await ctx.sink.error({ id: ctx.id, code, message });
    ctx.onUsage?.({
      ts: Date.now(),
      keyId: ctx.keyId,
      serviceId: ctx.service.serviceId,
      status: code,
      bytes: 0,
    });
    return { code };
  }
  if (plan.isWebSocketUpgrade || isWebSocketUpgradeRequest(ctx.req.headers ?? {})) {
    // v1 不做 WS 透传（design §8「不做」清单）——显式拒绝，零上游请求。
    await ctx.sink.error({ id: ctx.id, code: ERROR_CODE.protocol_error, message: "websocket passthrough is not supported" });
    ctx.onUsage?.({
      ts: Date.now(),
      keyId: ctx.keyId,
      serviceId: ctx.service.serviceId,
      status: ERROR_CODE.protocol_error,
      bytes: 0,
    });
    return { code: ERROR_CODE.protocol_error };
  }
  await forwardHttp(ctx, plan, mergeTimeouts(ctx.timeouts));
  return null;
}

/**
 * @param {ResponseSink} sink
 * @param {string} id
 * @param {string} code
 * @param {string} message
 */
async function sendError(sink, id, code, message) {
  try {
    await sink.error({ id, code, message });
  } catch {
    /* 承载面已坏：由其关闭路径处置 */
  }
}

// ---------------------------------------------------------------------------
// 出站归一层 + HTTP 消费循环
// ---------------------------------------------------------------------------

/**
 * 归一 body 句柄：单消费异步迭代器 + 取消传播。
 * @typedef {Object} NormalizedBodyHandle
 * @property {AsyncIterable<Uint8Array>} iterable
 * @property {() => Promise<void>} cancel
 */

const EMPTY_ASYNC_ITERATOR = {
  next: async () => ({ done: true, value: undefined }),
};

/**
 * 归一 body 源：ReadableStream 走 reader；AsyncIterable 直用其迭代器；
 * 缺省/null = 空流。取消语义统一经 cancel()。
 * @param {ReadableStream | AsyncIterable<Uint8Array> | null | undefined} source
 * @returns {NormalizedBodyHandle}
 */
export function normalizeBody(source) {
  if (source === null || source === undefined) {
    return {
      iterable: { [Symbol.asyncIterator]: () => EMPTY_ASYNC_ITERATOR },
      cancel: async () => undefined,
    };
  }
  if (typeof ReadableStream === "function" && source instanceof ReadableStream) {
    const reader = source.getReader();
    let drained = false; // 自然结束（done）：锁已释放，cancel 无效
    return {
      iterable: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const r = await reader.read();
            if (r.done === true) {
              drained = true;
              reader.releaseLock();
            }
            return r;
          },
        }),
      },
      cancel: () =>
        (drained ? Promise.resolve() : reader.cancel()).then(
          () => undefined,
          () => undefined,
        ),
    };
  }
  const iterator = source[Symbol.asyncIterator]();
  return {
    iterable: { [Symbol.asyncIterator]: () => iterator },
    cancel: async () => {
      try {
        await iterator.return?.(undefined);
      } catch {
        /* 终止失败不阻塞清理（脚本流自担 signal 语义） */
      }
    },
  };
}

/**
 * 头表小写化（last-wins 字典语义）。
 * @param {Iterable<[string, string]>} source
 */
function lowercaseHeaders(source) {
  const out = {};
  for (const [name, value] of source) out[name.toLowerCase()] = value;
  return out;
}

/**
 * RESP_META 投影：白名单头挑选 + content-type 独立投影；status 204/304 无正文
 * ——contentType 归一为空。
 */
export function projectRespMeta(id, status, headers) {
  const meta = {
    id,
    status,
    contentType: status === 204 || status === 304 ? "" : (headers["content-type"] ?? ""),
  };
  const picked = pickResponseWhitelist((name) => headers[name] ?? null);
  if (picked !== undefined) meta.headers = picked;
  return meta;
}

/**
 * @param {ForwardCtx} ctx
 * @param {import("./rewrite.mjs").UpstreamPlan} plan
 * @param {{ connectMs: number, firstByteMs: number, stallMs: number }} t
 */
async function forwardHttp(ctx, plan, t) {
  const { sink, id } = ctx;
  let settled = false;
  let bytes = 0;

  const recordUsage = (status) => {
    ctx.onUsage?.({ ts: Date.now(), keyId: ctx.keyId, serviceId: ctx.service.serviceId, status, bytes });
  };
  const finishWithError = async (code, message) => {
    if (settled) return;
    settled = true;
    await sendError(sink, id, code, message);
    recordUsage(code);
  };

  // 方法域（越界=protocol_error；wire schema 层已拒，纵深防御）。
  if (!HTTP_METHODS.includes(ctx.req.method)) {
    await finishWithError(ERROR_CODE.protocol_error, "request method is not allowed");
    return;
  }
  // GET/HEAD 携带正文：HTTP 语义非法。
  if ((ctx.req.method === "GET" || ctx.req.method === "HEAD") && ctx.body.length > 0) {
    await finishWithError(ERROR_CODE.protocol_error, "request body not allowed for GET/HEAD");
    return;
  }

  // ③ 绑定（整体接管出站；跳过 probeConnect）。双模式解析：预设模式下
  // request = 该脚本的 ③ 导出；缺导出 → 原生路径（含连接期探测）。
  const effSlots = effectiveLifecycleSlots(ctx.service, {
    ...(ctx.home !== undefined ? { home: ctx.home } : {}),
    ...(ctx.loader !== undefined ? { loader: ctx.loader } : {}),
  });
  const requestSlot = effSlots.request;
  const ctrl = new AbortController();
  let stallTimer = null;
  let localAbortCode;
  /** @type {NormalizedBodyHandle | undefined} */
  let bodyHandle;
  const supersededBodies = [];

  const clearTimers = () => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  // 外部信号（ABORT/断连）：中止上游（fetch 拒绝路径）+ cancel 归一迭代器传播。
  const onExternalAbort = () => {
    ctrl.abort();
    void bodyHandle?.cancel();
    for (const b of supersededBodies) void b.cancel();
  };
  if (ctx.signal.aborted) onExternalAbort();
  else ctx.signal.addEventListener("abort", onExternalAbort, { once: true });

  // 首字节等待期（③ 脚本调用期同窗覆盖——脚本返回 = 响应头到达）。
  const abortWith = (code) => {
    if (localAbortCode === undefined) localAbortCode = code;
    ctrl.abort();
    void bodyHandle?.cancel();
    for (const b of supersededBodies) void b.cancel();
  };
  let firstByteArmed = true;
  const armFirstByte = () => {
    if (!firstByteArmed) return;
    firstByteTimer = setTimeout(() => abortWith(ERROR_CODE.idle_timeout), t.firstByteMs);
  };
  /** @type {ReturnType<typeof setTimeout> | null} */
  let firstByteTimer = null;
  armFirstByte();
  const clearTimersFull = () => {
    clearTimers();
    if (firstByteTimer !== null) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
      firstByteArmed = false;
    }
  };

  /** 中止分类：外部信号优先，其次本地超时码，否则网络失败。 */
  const classifyAbort = () => {
    if (!ctrl.signal.aborted) return undefined;
    if (ctx.signal.aborted) return abortCodeOf(ctx.signal);
    return { code: localAbortCode ?? ERROR_CODE.aborted, reply: true };
  };

  /** ③ 脚本路径：整体接管出站（跳过连接期探测）。 */
  const requestStageResponse = async () => {
    const slot = requestSlot;
    const result = await resolveStageRequest(
      { name: slot.script, ...(slot.args !== undefined ? { args: slot.args } : {}) },
      {
        url: plan.url.toString(),
        method: ctx.req.method,
        headers: { ...plan.headers, host: plan.host },
        body: ctx.body,
        signal: ctrl.signal,
      },
      {
        ...(ctx.secrets !== undefined ? { secrets: ctx.secrets } : {}),
        ...(ctx.home !== undefined ? { home: ctx.home } : {}),
        ...(ctx.loader !== undefined ? { loader: ctx.loader } : {}),
      },
    );
    return {
      status: result.status,
      headers: lowercaseHeaders(Object.entries(result.headers)),
      body: normalizeBody(result.body),
      fromScript: true,
    };
  };

  /** 原生路径：连接期探测 + fetch（fetchImpl 测试注入缝）。 */
  const nativeResponse = async () => {
    const probe = ctx.probeConnect ?? defaultProbeConnect;
    // 已中止不拨探测：probe 建立真实 TCP 连接——中止后执行仍属触达上游。
    if (ctrl.signal.aborted || ctx.signal.aborted) {
      throw new ProbeFailedError();
    }
    try {
      await probe(plan.url, t.connectMs); // 失败/超时 -> upstream_unreachable，零 fetch
    } catch {
      throw new ProbeFailedError();
    }
    const fetchFn = ctx.fetchImpl ?? fetch;
    const headers = { ...plan.headers, host: plan.host };
    const init = { method: ctx.req.method, headers, redirect: "manual", signal: ctrl.signal };
    if (ctx.body.length > 0) init.body = ctx.body;
    const resp = await fetchFn(plan.url, init);
    const out = {};
    resp.headers.forEach((value, name) => {
      out[name.toLowerCase()] = value;
    });
    return {
      status: resp.status,
      headers: out,
      body: normalizeBody(resp.body),
      fromScript: false,
    };
  };

  let normalized;
  try {
    normalized = requestSlot !== undefined ? await requestStageResponse() : await nativeResponse();
  } catch (err) {
    // 初始失败提前返回——解绑外部 abort 监听（防泄漏：每请求闭包挂在
    // ctx.signal 上直至信号自身被 GC）。
    ctx.signal.removeEventListener("abort", onExternalAbort);
    clearTimersFull();
    const aborted = classifyAbort();
    if (aborted !== undefined) {
      if (aborted.reply) await finishWithError(aborted.code, `upstream request aborted (${aborted.code})`);
      else settled = true;
      return;
    }
    if (err instanceof HookStageError) {
      await finishWithError(ERROR_CODE.hook_failed, err.message);
      return;
    }
    if (err instanceof ProbeFailedError) {
      await finishWithError(ERROR_CODE.upstream_unreachable, err.message);
      return;
    }
    await finishWithError(ERROR_CODE.upstream_unreachable, "upstream request failed");
    return;
  }
  bodyHandle = normalized.body;
  clearTimersFull(); // 首字节已到（响应头）

  try {
    // ④ onResponse：归一后、meta 下发前——局部覆盖 status/headers/body。
    const responseSlot = effSlots.response;
    if (responseSlot !== undefined) {
      let override;
      try {
        override = await resolveStageResponse(
          { name: responseSlot.script, ...(responseSlot.args !== undefined ? { args: responseSlot.args } : {}) },
          {
            status: normalized.status,
            headers: { ...normalized.headers },
            body: normalized.body.iterable,
            signal: ctrl.signal,
          },
          {
            ...(ctx.secrets !== undefined ? { secrets: ctx.secrets } : {}),
            ...(ctx.home !== undefined ? { home: ctx.home } : {}),
            ...(ctx.loader !== undefined ? { loader: ctx.loader } : {}),
          },
        );
      } catch (err) {
        if (err instanceof HookStageError) {
          await finishWithError(ERROR_CODE.hook_failed, err.message);
          return;
        }
        throw err;
      }
      if (override.status !== undefined) normalized.status = override.status;
      if (override.headers !== undefined) {
        for (const [name, value] of Object.entries(override.headers)) {
          normalized.headers[name.toLowerCase()] = value;
        }
      }
      if (override.body !== undefined) {
        supersededBodies.push(normalized.body);
        bodyHandle = normalizeBody(override.body);
        normalized.body = bodyHandle;
        normalized.fromScript = true;
      }
    }

    // 响应元信息（白名单头 + contentType 投影；4xx/5xx 原样透传）。
    await sink.meta(projectRespMeta(id, normalized.status, normalized.headers));

    // 正文流：逐块转发（SSE 不得缓冲拼齐），停滞计时每块重置。
    const armStall = () => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abortWith(ERROR_CODE.idle_timeout), t.stallMs);
    };
    armStall();
    // 中止竞速：脚本 AsyncIterable 的 pending next() 不因 abort 拒绝——ctrl.abort
    // 触发时由竞速即刻退出循环，取消传播由 finally 收尾。
    let abortRaceReject;
    const abortRace = new Promise((_, reject) => {
      abortRaceReject = reject;
    });
    const onLoopAbort = () => abortRaceReject?.(new Error("normalized body consumption aborted"));
    if (ctrl.signal.aborted) onLoopAbort();
    else ctrl.signal.addEventListener("abort", onLoopAbort, { once: true });
    const bodyIterator = normalized.body.iterable[Symbol.asyncIterator]();
    try {
      for (;;) {
        const result = await Promise.race([bodyIterator.next(), abortRace]);
        if (result.done === true) break;
        armStall();
        for (const piece of splitBodyChunks(result.value)) {
          await sink.chunk(piece);
          bytes += piece.length;
        }
      }
    } finally {
      ctrl.signal.removeEventListener("abort", onLoopAbort);
    }
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (ctx.signal.aborted) {
      const { code, reply } = abortCodeOf(ctx.signal);
      if (reply) await finishWithError(code, `upstream request aborted (${code})`);
      else settled = true;
      return;
    }
    await sink.end();
    settled = true;
    recordUsage(normalized.status);
  } catch {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    const aborted = classifyAbort();
    if (aborted !== undefined) {
      if (aborted.reply) await finishWithError(aborted.code, `upstream request aborted (${aborted.code})`);
      else settled = true;
      return;
    }
    // 流中途失败分族：脚本产出（③ 返回 / ④ 变换）→ hook_failed；上游流 →
    // upstream_unreachable（既有语义）。
    await finishWithError(
      normalized.fromScript ? ERROR_CODE.hook_failed : ERROR_CODE.upstream_unreachable,
      normalized.fromScript ? "hook stage failed" : "upstream stream failed",
    );
  } finally {
    clearTimersFull();
    // 正常完成同样解除外部 abort 监听（防泄漏）。
    ctx.signal.removeEventListener("abort", onExternalAbort);
    ctrl.abort(); // 释放上游资源（已完成的 fetch abort 是 no-op）
    // 归一迭代器取消传播（中止/失败路径显式 cancel——MUST 中止上游请求）。
    void bodyHandle?.cancel();
    for (const b of supersededBodies) void b.cancel();
  }
}

// ---------------------------------------------------------------------------
// 静态聚合 sink（Phase A：wire request 端点的响应元数据收集面；Phase B 换
// 中继状态机 sink——同一 ResponseSink 面）
// ---------------------------------------------------------------------------

/**
 * 收集型 sink：聚齐 meta + chunks + 终态（error 与 end 互斥）。body 有界
 * （Phase A 静态聚合；超界按 upstream_unreachable 族错误终结——不静默截断）。
 * @param {{ maxBytes?: number }} [opts]
 */
export function createCollectingSink(opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_BODY_CHUNK_BYTES * 8;
  /** @type {{ id: string, status: number, contentType: string, headers?: Record<string, string> } | null} */
  let metaHeader = null;
  const chunks = [];
  /** @type {{ code: string, message: string } | null} */
  let errorHeader = null;
  let ended = false;
  return {
    async meta(header) {
      metaHeader = header;
    },
    async chunk(body) {
      if (errorHeader !== null || ended) return;
      const total = chunks.reduce((n, c) => n + c.length, 0);
      if (total + body.length > maxBytes) {
        errorHeader = { code: ERROR_CODE.buffer_overflow, message: "collected response body exceeds the static sink budget" };
        return;
      }
      chunks.push(Buffer.from(body));
    },
    async end() {
      ended = true;
    },
    async error(header) {
      if (ended) return;
      errorHeader = { code: header.code, message: header.message };
    },
    result() {
      return {
        meta: metaHeader,
        error: errorHeader,
        ended,
        body: Buffer.concat(chunks),
        bytes: chunks.reduce((n, c) => n + c.length, 0),
      };
    },
  };
}
