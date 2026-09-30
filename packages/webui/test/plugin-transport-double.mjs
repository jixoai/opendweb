// 分层 transport 测试替身（webui-plugin-kernel r8-B4 最小清单第 3 项）。
//
// 目的：单机 loopback（内存直调 handler / fake transport）会绕过真实 fabric
// transport 的三层字节账——超包络请求在测试里"成功"、在真双机上确定性失败
// （第六/七批验收实录）。本模块把 transport 事实建为可复用的测试替身，供
// ext-ports / ext-files / ext-sync 三插件测试电池共享 import：
//
//   层 1 帧：单个 DATA 帧 payload ≤1MiB（crates/dweb-fabric/src/session.rs
//           `MAX_FRAME = 1MiB`；fetch_http 把请求体 Array<Uint8Array> 的每个
//           元素作为一个帧发送——client-sdk src/http.rs fetch_http 逐元素
//           `channel.send_data`，无自动拆分）。
//   层 2 流：单请求（journal 流）累计 ≤2MiB（continuity/model.rs
//           `JournalLimits::max_stream_bytes = 2MiB`；OPEN meta 不入 journal）。
//   层 3 会话：全部在飞流的未 ACK 持有字节 ≤8MiB（continuity/model.rs
//           `max_session_bytes = 8MiB`；ACK/交付后释放——本替身以「响应体
//           读尽（EOF）即释放」建模 journal 排空）。
//
// 语义对齐：
// - 违反任一层 → 抛 TransportEnvelopeError（code=frame-too-large /
//   stream-exceeds-journal / session-exceeds-journal，layer=frame|stream|
//   session）——镜像内核 FrameTooLarge / JournalError::{StreamBytesCap,
//   SessionBytesCap} 错误族；请求**不到达**被替身守卫的下层（零副作用）。
// - wrapSyncFetchImpl 与生产适配（webui src/core/plugins/data-plane.mjs
//   toSyncFetch）同形：先把单块 body 按 ≤1MiB 帧分块再入账——证明生产分块
//   策略下 push（≤2MiB wire）可通过、超包络被层 2 拦下。
// - 顺序请求在响应读尽后释放会话账（层 3 不累积）；并发在飞聚合超 8MiB
//   才触发层 3。
//
// 本替身只建模**请求方向**的静态 body（r8-B4 冻结的 v1 包络面）；响应方向是
// pull-first 流式（各插件单响应 ≤1MiB 内容/64KiB 写块，均已在包络内）。

/** 层 1：单帧 payload 上限（session.rs MAX_FRAME） */
export const TRANSPORT_MAX_FRAME_BYTES = 1024 * 1024;
/** 层 2：单流（请求）累计字节上限（JournalLimits.max_stream_bytes） */
export const TRANSPORT_MAX_STREAM_BYTES = 2 * 1024 * 1024;
/** 层 3：会话在飞（未 ACK）累计字节上限（JournalLimits.max_session_bytes） */
export const TRANSPORT_MAX_SESSION_BYTES = 8 * 1024 * 1024;

/**
 * transport 包络违规（镜像内核 FrameTooLarge / JournalError 字节上限族）。
 */
export class TransportEnvelopeError extends Error {
  /**
   * @param {"frame" | "stream" | "session"} layer
   * @param {string} code
   * @param {string} message
   * @param {{ limit?: number, actual?: number }} [detail]
   */
  constructor(layer, code, message, detail = {}) {
    super(message);
    this.name = "TransportEnvelopeError";
    this.layer = layer;
    this.code = code;
    if (detail.limit !== undefined) this.limit = detail.limit;
    if (detail.actual !== undefined) this.actual = detail.actual;
  }
}

/**
 * 会话字节账（层 2+层 3；层 1 是逐元素无状态检查）。
 * charge 在请求发起时持有并返回记账句柄；release(token) 在响应读尽（EOF）/
 * 请求终结时按该请求的字节数归还——建模 journal ACK 释放（顺序请求不累积
 * 会话账；并发在飞聚合仍受 8MiB 约束）。
 * @returns {{ charge: (chunks: Uint8Array[]) => { bytes: number }, release: (token: { bytes: number }) => void, heldBytes: () => number, requests: () => number }}
 */
export function createSessionLedger() {
  let held = 0;
  let requestCount = 0;
  return {
    charge(chunks) {
      // 层 1：帧（每个元素=一个 DATA 帧）
      for (const c of chunks) {
        if (c.byteLength > TRANSPORT_MAX_FRAME_BYTES) {
          throw new TransportEnvelopeError(
            "frame",
            "frame-too-large",
            `payload exceeds MAX_FRAME: ${c.byteLength} > ${TRANSPORT_MAX_FRAME_BYTES}`,
            { limit: TRANSPORT_MAX_FRAME_BYTES, actual: c.byteLength },
          );
        }
      }
      // 层 2：单请求流账
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      if (total > TRANSPORT_MAX_STREAM_BYTES) {
        throw new TransportEnvelopeError(
          "stream",
          "stream-exceeds-journal",
          `journal stream byte cap exceeded: ${total} > ${TRANSPORT_MAX_STREAM_BYTES}`,
          { limit: TRANSPORT_MAX_STREAM_BYTES, actual: total },
        );
      }
      // 层 3：会话在飞账（P0-3 先聚合全部流 held 再判——与 record_send 同序）
      if (held + total > TRANSPORT_MAX_SESSION_BYTES) {
        throw new TransportEnvelopeError(
          "session",
          "session-exceeds-journal",
          `journal session byte cap exceeded: held ${held} + incoming ${total} > ${TRANSPORT_MAX_SESSION_BYTES}`,
          { limit: TRANSPORT_MAX_SESSION_BYTES, actual: held + total },
        );
      }
      held += total;
      requestCount++;
      return { bytes: total };
    },
    release(token) {
      held = Math.max(0, held - token.bytes);
      requestCount = Math.max(0, requestCount - 1);
    },
    heldBytes() {
      return held;
    },
    requests() {
      return requestCount;
    },
  };
}

/**
 * 按 ≤1MiB 帧分块（生产适配 toSyncFetch/bridge 的同款策略——r8-B4）。
 * @param {Uint8Array} body
 * @returns {Uint8Array[]}
 */
export function frameBodyChunks(body) {
  if (body.byteLength <= TRANSPORT_MAX_FRAME_BYTES) return [body];
  const out = [];
  for (let off = 0; off < body.byteLength; off += TRANSPORT_MAX_FRAME_BYTES) {
    out.push(body.subarray(off, Math.min(off + TRANSPORT_MAX_FRAME_BYTES, body.byteLength)));
  }
  return out;
}

/**
 * 包装 sync 引擎 fetchImpl（契约 (session, {method, path, body: Uint8Array|
 * null, signal})）：先按生产策略做 ≤1MiB 帧分块，再入三层账，后委托；响应
 * 缓冲完成（promise 结算）即释放会话账。
 * @param {(session: unknown, req: { method: string, path: string, body?: Uint8Array | null, signal?: AbortSignal }) => Promise<{ status: number, body: Uint8Array }>} fetchImpl
 * @param {{ ledger?: ReturnType<typeof createSessionLedger> }} [opts]
 */
export function wrapSyncFetchImpl(fetchImpl, opts = {}) {
  const ledger = opts.ledger ?? createSessionLedger();
  return async (session, req) => {
    const chunks = req.body != null ? frameBodyChunks(req.body) : [];
    const token = ledger.charge(chunks);
    try {
      return await fetchImpl(session, req);
    } finally {
      ledger.release(token);
    }
  };
}

/**
 * 包装 files 客户端 transport（契约 send({method, path, headers?, body?:
 * Array<Uint8Array>})）：body 数组按原元素入账（不替调用方分块——files 的
 * 帧分块责任在客户端 chunkBytes ≤1MiB；替身如实暴露超限）。
 * @param {{ send: (req: { method: string, path: string, headers?: Array<{ name: string, value: string }>, body?: Array<Uint8Array> }) => Promise<{ status: number, headers: Record<string, string>, readBody: () => Promise<Buffer> } | { status: number, headers: Record<string, string>, readBody: () => Promise<Buffer> }> }} transport
 * @param {{ ledger?: ReturnType<typeof createSessionLedger> }} [opts]
 */
export function wrapFilesTransport(transport, opts = {}) {
  const ledger = opts.ledger ?? createSessionLedger();
  return {
    async send(req) {
      const token = ledger.charge(req.body ?? []);
      try {
        return await transport.send(req);
      } finally {
        ledger.release(token);
      }
    },
  };
}

/**
 * 包装 ports fetchHttpImpl（契约 (session, init{body?: Array<Uint8Array>})，
 * 返回 {status, headers, bodyNext, abort?}）：请求发起即入账；响应体读尽
 * （bodyNext → null=EOF）或请求失败时释放——流式响应期间账保持持有
 * （与 journal「未消费 ⟹ 未 ACK ⟹ 仍在发送方 journal」一致）。
 * @param {(session: unknown, init: { method: string, path: string, headers?: Array<{ name: string, value: string }>, body?: Array<Uint8Array> | null, signal?: AbortSignal }) => Promise<{ status: number, headers: Array<{ name: string, value: string }>, bodyNext: () => Promise<Buffer | null>, abort?: () => Promise<void> | void }>} fetchHttpImpl
 * @param {{ ledger?: ReturnType<typeof createSessionLedger> }} [opts]
 */
export function wrapPortsFetchHttp(fetchHttpImpl, opts = {}) {
  const ledger = opts.ledger ?? createSessionLedger();
  return async (session, init) => {
    const token = ledger.charge(init.body ?? []);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      ledger.release(token);
    };
    try {
      const resp = await fetchHttpImpl(session, init);
      const rawNext = resp.bodyNext.bind(resp);
      return {
        ...resp,
        async bodyNext() {
          const chunk = await rawNext();
          if (chunk === null) release(); // EOF：响应读尽 → journal 排空
          return chunk;
        },
        ...(resp.abort !== undefined
          ? {
              async abort() {
                release(); // RESET：流终结（取消路径同样释放账）
                return resp.abort();
              },
            }
          : {}),
      };
    } catch (e) {
      release();
      throw e;
    }
  };
}
