// adapted from ai-fly src/provider/engine.ts (v0.6.0) —— engine 三拆之 forward
// （design §0/§3.1）。Phase A 形态：request 端点的转发编排纯逻辑骨架——
// admission（在途上游 ≤maxConcurrency）+ limits.acquire + responseId/epoch
// 生成 + 上游转发（upstream.mjs forwardRequest，静态聚合 sink）→ 响应元数据。
// Phase B 换中继状态机 sink（response/cancel 端点、单飞拉取、连续提交游标）
// ——本文件的 forwardPlane 形状保持（调用方无感）。
// epoch=进程启动 CSPRNG（responseId=`<epoch>:<单调号>`；重启=全部在途 rid
// 404 response_not_found——Phase B 落地，本文件先生成形状）。

import { randomZ32 } from "./z32.mjs";
import { forwardRequest, createCollectingSink, UpstreamAbortError } from "./upstream.mjs";
import {
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_MAX,
  MAX_CONCURRENCY_MIN,
  PER_REQUEST_BUFFER_BYTES,
  MAX_RING_BYTES,
} from "../wire/constants.mjs";

/**
 * admission 配置校验（§3.1：域 1–32；活跃 ring=maxConcurrency×2MiB ≤64MiB
 * 超积工厂拒启）。
 * @param {number} maxConcurrency
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateAdmission(maxConcurrency) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < MAX_CONCURRENCY_MIN || maxConcurrency > MAX_CONCURRENCY_MAX) {
    return {
      ok: false,
      error: `maxConcurrency must be an integer in ${MAX_CONCURRENCY_MIN}..${MAX_CONCURRENCY_MAX} (got ${String(maxConcurrency)})`,
    };
  }
  if (maxConcurrency * PER_REQUEST_BUFFER_BYTES > MAX_RING_BYTES) {
    return {
      ok: false,
      error: `active ring budget exceeds ${MAX_RING_BYTES} bytes (maxConcurrency=${maxConcurrency} x ${PER_REQUEST_BUFFER_BYTES} bytes); refuse to start`,
    };
  }
  return { ok: true };
}

/**
 * 转发平面。
 * @param {{
 *   store: import("./store.mjs").ProviderStore,
 *   limits: import("./limits.mjs").LimitEnforcer,
 *   maxConcurrency?: number,
 *   secrets?: (name: string) => string | undefined,
 *   usageLog?: import("./limits.mjs").UsageLog | null,
 *   epoch?: string,
 *   random?: (n: number) => string,
 *   fetchImpl?: typeof fetch,
 *   probeConnect?: (url: URL, ms: number) => Promise<void>,
 *   timeouts?: { connectMs?: number, firstByteMs?: number, stallMs?: number },
 *   home?: string,
 *   loader?: (name: string, home: string) => Record<string, unknown> | undefined,
 *   now?: () => number,
 * }} opts
 */
export function createForwardPlane(opts) {
  const { store, limits } = opts;
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const gate = validateAdmission(maxConcurrency);
  if (!gate.ok) throw new Error(`createForwardPlane: ${gate.error}`);
  const epoch = opts.epoch ?? randomZ32(8, opts.random);
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? ((n) => randomZ32(n));
  let monotonic = 0;
  let inflight = 0;

  /**
   * 请求转发（编排：admission→limits→forward→元数据返回）。
   * @param {{
   *   keyId: string,
   *   group: string,
   *   service: Record<string, any>,
   *   method: string,
   *   path: string,
   *   headers: Record<string, string>,
   *   contentType?: string,
   *   body: Uint8Array,
   *   signal: AbortSignal,
   * }} input
   * @returns {Promise<
   *   | { ok: true, responseId: string, epoch: string, status: number, headers: Record<string, string> | undefined, bytes: number }
   *   | { ok: false, httpStatus: number, code: string, message: string }
   * >}
   */
  async function request(input) {
    // admission：在途上游 ≤maxConcurrency（拨号前检查；终态即释放——不等 TTL）
    if (inflight >= maxConcurrency) {
      return { ok: false, httpStatus: 429, code: "rate_limited", message: "provider upstream concurrency limit reached" };
    }
    const acquired = await limits.acquire(input.keyId, input.group);
    if (!acquired.ok) {
      return {
        ok: false,
        httpStatus: 429,
        code: acquired.code,
        message: acquired.code === "rate_limited" ? "group concurrency limit reached" : "daily request quota exceeded",
      };
    }
    inflight += 1;
    const responseId = `${epoch}:${(monotonic += 1)}`;
    const sink = createCollectingSink();
    const onUsage = opts.usageLog
      ? (record) => {
          void opts.usageLog.append(record).catch(() => undefined);
        }
      : undefined;
    try {
      const outcome = await forwardRequest(
        {
          sink,
          id: responseId,
          service: input.service,
          req: {
            method: input.method,
            path: input.path,
            headers: input.headers,
            ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
          },
          body: input.body,
          signal: input.signal,
          keyId: input.keyId,
          timeouts: opts.timeouts,
          onUsage,
          ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
          ...(opts.home !== undefined ? { home: opts.home } : {}),
          ...(opts.loader !== undefined ? { loader: opts.loader } : {}),
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.probeConnect !== undefined ? { probeConnect: opts.probeConnect } : {}),
        },
      );
      const result = sink.result();
      if (result.error !== null) {
        return {
          ok: false,
          httpStatus: errorHttpStatus(result.error.code),
          code: result.error.code,
          message: result.error.message,
        };
      }
      if (result.meta === null) {
        return { ok: false, httpStatus: 502, code: "upstream_unreachable", message: "upstream produced no response metadata" };
      }
      return {
        ok: true,
        responseId,
        epoch,
        status: result.meta.status,
        headers: result.meta.headers,
        bytes: result.bytes,
      };
    } finally {
      inflight -= 1;
      limits.release(input.group);
    }
  }

  return {
    epoch,
    /** 观测面（测试/UI）。 */
    stats() {
      return { epoch, maxConcurrency, inflight };
    },
    request,
  };
}

/**
 * forward 错误码 → wire HTTP 状态（path_not_offered=404；重构类 secret_missing/
 * hook_failed=502；上游不可达=502；abort 族=504——Phase A 静态聚合面的映射，
 * Phase B 中继态接管后错误进状态机）。
 * @param {string} code
 */
export function errorHttpStatus(code) {
  switch (code) {
    case "path_not_offered":
      return 404;
    case "aborted":
    case "idle_timeout":
      return 504;
    default:
      return 502;
  }
}

export { UpstreamAbortError };
