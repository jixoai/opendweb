// adapted from ai-fly src/provider/engine.ts (v0.6.0) —— engine 三拆之 forward
// （design §0/§3.1/§3.2）。Phase B 形态：request 端点的转发编排——admission
// （在途上游 ≤maxConcurrency，拨号前检查）+ limits.acquire（分组并发+keyId
// 日限）+ responseId/epoch 生成（`<epoch>:<单调号>`，epoch=进程启动 CSPRNG）+
// 上游转发（upstream.mjs forwardRequest）→ 中继状态机 sink（relay.mjs——
// produce 转移；response/cancel 端点经 forwardPlane.relay 拉取/取消）。
// meta（上游状态+响应头）一到 request 即回 200；正文经 relay 分片拉取。
// 占位（admission+limits）在流终态即释放（relay applyTerminal→onTerminal）。
// 重启=全部在途 rid 404 response_not_found（新 epoch；旧 rid 不在新 registry）。

import { randomZ32 } from "./z32.mjs";
import { forwardRequest } from "./upstream.mjs";
import { createRelayRegistry } from "./relay.mjs";
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
 * 转发平面（request 编排 + 响应中继登记簿）。
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
 *   idleTtlMs?: number,
 *   absoluteLifetimeMs?: number,
 *   sweepIntervalMs?: number,
 *   drainDeadlineMs?: number,
 *   now?: () => number,
 *   log?: (level: "info" | "warn" | "error", msg: string) => void,
 * }} opts
 */
export function createForwardPlane(opts) {
  const { store, limits } = opts;
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const gate = validateAdmission(maxConcurrency);
  if (!gate.ok) throw new Error(`createForwardPlane: ${gate.error}`);
  const epoch = opts.epoch ?? randomZ32(8, opts.random);
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let monotonic = 0;

  const relay = createRelayRegistry({
    epoch,
    ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
    ...(opts.absoluteLifetimeMs !== undefined ? { absoluteLifetimeMs: opts.absoluteLifetimeMs } : {}),
    ...(opts.sweepIntervalMs !== undefined ? { sweepIntervalMs: opts.sweepIntervalMs } : {}),
    ...(opts.drainDeadlineMs !== undefined ? { drainDeadlineMs: opts.drainDeadlineMs } : {}),
    now,
    log,
  });

  /**
   * 请求转发（编排：admission→limits→rid 登记→上游转发→meta 返回）。
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
   *   | { ok: true, responseId: string, epoch: string, status: number, headers: Record<string, string> | undefined }
   *   | { ok: false, httpStatus: number, code: string, message: string }
   * >}
   */
  async function request(input) {
    // admission：在途上游 ≤maxConcurrency（拨号前检查；终态即释放——不等 TTL）
    if (relay.activeCount() >= maxConcurrency) {
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
    const responseId = `${epoch}:${(monotonic += 1)}`;
    let released = false;
    const handle = relay.create({
      rid: responseId,
      keyId: input.keyId,
      group: input.group,
      serviceId: input.service.serviceId,
      onTerminal: () => {
        if (!released) {
          released = true;
          limits.release(input.group);
        }
      },
    });
    // consumer 本地断开（meta 前）：abort 上游+释放占位（meta 后的断开由
    // cancel 端点/空闲 TTL 收敛——rid 独立存活）
    const onReqAbort = () => handle.abortLocal();
    if (input.signal.aborted) handle.abortLocal();
    else input.signal.addEventListener("abort", onReqAbort, { once: true });
    const onUsage = opts.usageLog
      ? (record) => {
          void opts.usageLog.append(record).catch(() => undefined);
        }
      : undefined;
    // 上游转发（fire-and-forget：produce 经 relay sink；meta/error 经 metaPromise）
    void forwardRequest({
      sink: handle.sink,
      id: responseId,
      service: input.service,
      req: {
        method: input.method,
        path: input.path,
        headers: input.headers,
        ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
      },
      body: input.body,
      signal: handle.upstreamSignal,
      keyId: input.keyId,
      timeouts: opts.timeouts,
      onUsage,
      ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.loader !== undefined ? { loader: opts.loader } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.probeConnect !== undefined ? { probeConnect: opts.probeConnect } : {}),
    }).catch((err) => {
      log("error", `ai forward: unexpected failure for ${responseId}: ${err instanceof Error ? err.message : String(err)}`);
      void handle.sink.error({ id: responseId, code: "internal", message: "forward failed" }).catch(() => undefined);
    });
    let meta;
    try {
      meta = await handle.metaPromise;
    } catch (err) {
      input.signal.removeEventListener("abort", onReqAbort);
      const code = typeof err?.code === "string" ? err.code : "internal";
      return {
        ok: false,
        httpStatus: errorHttpStatus(code),
        code,
        message: err instanceof Error ? err.message : "upstream request failed",
      };
    }
    input.signal.removeEventListener("abort", onReqAbort);
    return {
      ok: true,
      responseId,
      epoch,
      status: meta.status,
      headers: meta.headers,
    };
  }

  return {
    epoch,
    /** 响应中继登记簿（response/cancel 端点消费；撤钥 drain/会话收敛面）。 */
    relay,
    /** 观测面（测试/UI）。 */
    stats() {
      return { epoch, maxConcurrency, inflight: relay.activeCount() };
    },
    request,
    /** 生命周期收敛：在途上游 abort + 扫描计时器停（dispose 面）。 */
    async dispose() {
      await relay.closeAll({ code: "aborted" });
      relay.dispose();
    },
  };
}

/**
 * forward 错误码 → wire HTTP 状态（meta 前失败的 request 直回映射；meta 后
 * 中途失败经 relay error 终态映射（relay.errorRelayStatus 同拍）；abort 族=504）。
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

export { UpstreamAbortError } from "./upstream.mjs";
