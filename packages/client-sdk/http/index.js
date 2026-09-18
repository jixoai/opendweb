// @jixo/opendweb-client-sdk/http —— HTTP/WS 绑定面（design §1.4/§3.4，
// app-protocol-layer task 4.2）。
// fetchHttp/serveHttp 是 §3.4 规范签名（自由函数形态）的 JS 投影：
// - fetchHttp：native session.fetchHttp + [Symbol.asyncIterator] 注入
//   （body AsyncIterable 投影；pull-first——每次 next() 触发一次内核拉取）
// - serveHttp：native fabric.serveHttp 的 TSFN JSON 事件桥 → 类型化 handler
//   调用；结算经 server.resolveRequest/rejectRequest 回流
const Native = require("../index.js");

/** fetchHttp 取消键序号（request.signal → abortKey 注册表关联）。 */
let fetchAbortKeySeq = 0;

/**
 * 发起 HTTP 请求（design §3.4）。本阶段 body 为静态分块（AsyncIterable 请求
 * 体后续 phase）；响应经 pull-first bodyNext() 消费，亦可 for-await 迭代。
 * headTimeoutMs 可配（默认 30s——长轮询/慢上游按需放宽）。
 * signal 可配（0.6.0）：abort → head 等待期即时 RESET（清理对端在途请求）。
 * @param {import("../index.js").SessionHandle} session
 * @param {{
 *   method: string;
 *   path: string;
 *   headers?: Array<{ name: string; value: string }>;
 *   body?: Array<Uint8Array> | null;
 *   keepOpen?: boolean;
 *   headTimeoutMs?: number;
 *   signal?: AbortSignal;
 * }} request
 */
async function fetchHttp(session, request) {
  // napi Option 入参：undefined = 缺省（null 会触发 ArrayExpected——Vec 通道）
  const init = {
    method: request.method,
    path: request.path,
    headers: request.headers ?? [],
  };
  if (request.body != null) init.body = request.body;
  if (request.keepOpen != null) init.keepOpen = request.keepOpen;
  if (request.headTimeoutMs != null) init.headTimeoutMs = request.headTimeoutMs;
  // 消费端取消信号（0.6.0）：head 等待期 abort → 即时 RESET 清理对端在途
  // 请求（abortKey 注册表经 SessionHandle.abortFetch 触发；fetch 结算即摘除，
  // 晚到 abort 为幂等 no-op）
  // 预中止检查（P1-6）：已 aborted 的 signal 不会再触发监听——立即同步失败，
  // 不发起网络请求（与 WHATWG fetch 语义对齐）。
  if (request.signal?.aborted) {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  }
  let abortKey = null;
  if (request.signal != null) {
    abortKey = ++fetchAbortKeySeq;
    init.abortKey = abortKey;
    request.signal.addEventListener(
      "abort",
      () => {
        try {
          session.abortFetch?.(abortKey);
        } catch {
          // 会话已关等：取消目的已达成（通道已死）
        }
      },
      { once: true },
    );
  }
  const resp = await session.fetchHttp(init);
  // §3.4 HttpResponse.body AsyncIterable 投影：迭代逐块 pull（EOF 结束）
  Object.defineProperty(resp, Symbol.asyncIterator, {
    value: async function* () {
      for (;;) {
        const chunk = await resp.bodyNext();
        if (chunk === null) return;
        yield chunk;
      }
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return resp;
}

/**
 * provider 侧 HTTP 引擎（design §3.4）。handler 收到类型化请求
 * （bodyNext 拉取请求体，EOF = null；respondStreaming 流式回响应）：
 * - 返回 { status, headers?, bodyChunks? } —— 一次性静态响应；
 * - 调用 req.respondStreaming(status, headers) —— 响应头立即发出，返回
 *   { write(chunk), finish(), finished, cancelled, closed }（SSE/长连接/
 *   WS 101 早发等真实流式）。
 *
 * 生命周期信号（0.6.0 sdk-lifecycle-signals）：
 * - req.sessionId —— 请求所属逻辑会话（hex；授权缓存隔离键）
 * - req.signal —— AbortSignal：对端取消（RESET/会话终态遗弃）事件驱动
 *   触发；挂起中的 handler（尚未 write）也能即时收到。正常完成不触发。
 * - writer 三态正交：finished（本地半关意图）/ cancelled（对端取消事件）/
 *   closed（底层投递通道已关）。getter 为观测面，write 错误仍为真相面。
 *
 * @param {import("../index.js").Fabric} fabric
 * @param {string} peerId
 * @param {(req: {
 *   requestId: number;
 *   streamId: number;
 *   sessionId: string;
 *   signal: AbortSignal;
 *   method: string;
 *   path: string;
 *   headers: Array<{ name: string; value: string }>;
 *   bodyNext: () => Promise<Buffer | null>;
 *   respondStreaming: (status: number, headers?: Array<{ name: string; value: string }>) => { write: (chunk: Uint8Array) => Promise<void>; finish: () => void; finished: boolean; cancelled: boolean; closed: boolean } | null;
 * }) => Promise<{ status: number; headers?: Array<{ name: string; value: string }>; bodyChunks?: Array<Uint8Array> } | null | void> | { status: number; headers?: Array<{ name: string; value: string }>; bodyChunks?: Array<Uint8Array> } | null | void} handler
 */
async function serveHttp(fabric, peerId, handler) {
  /**
   * per-request 生命周期记录（P1-2/P1-1 统一终态清理）：signal 控制器 +
   * 流式结算标记收敛为单一 entry，所有出口（静态结算/流 finish/write 错误/
   * cancel 事件）经 finalizeRequest 删除——长生命周期 server 零残留。
   */
  const liveRequests = new Map();
  const finalizeRequest = (requestId) => {
    liveRequests.delete(requestId);
  };
  const server = await fabric.serveHttp(peerId, (err, json) => {
    if (err) return;
    /** @type {any} */
    let ev;
    try {
      ev = JSON.parse(json);
    } catch {
      return;
    }
    if (ev?.type === "cancel") {
      const rec = liveRequests.get(ev.requestId);
      rec?.controller.abort();
      finalizeRequest(ev.requestId);
      return;
    }
    if (ev?.type !== "request") return;
    const controller = new AbortController();
    liveRequests.set(ev.requestId, { controller, streamed: false });
    Promise.resolve()
      .then(() =>
        handler({
          requestId: ev.requestId,
          streamId: ev.streamId,
          sessionId: ev.sessionId,
          signal: controller.signal,
          method: ev.method,
          path: ev.path,
          headers: ev.headers ?? [],
          bodyNext: () => server.requestBodyNext(ev.requestId),
          respondStreaming(status, headers) {
            const writer = server.respondStreaming(
              ev.requestId,
              status,
              headers ?? [],
            );
            if (writer == null) return null; // 已结算/晚到：幂等 null
            const rid = ev.requestId;
            const rec = liveRequests.get(rid);
            if (rec !== undefined) rec.streamed = true;
            // controller 生命周期 = 流生命周期（非请求结算时刻）：终态出口
            // finish / write 错误 / cancel 事件处统一 finalize，防长流期间
            // 丢 cancel、也防注册表泄漏
            return {
              write: (chunk) =>
                writer.write(Buffer.from(chunk)).catch((e) => {
                  finalizeRequest(rid); // 通道已死（对端取消/引擎丢弃）
                  throw e;
                }),
              finish: () => {
                writer.finish();
                finalizeRequest(rid); // 本地半关：后续 cancel 无意义
              },
              get finished() {
                return writer.finished;
              },
              get cancelled() {
                return writer.cancelled;
              },
              get closed() {
                return writer.closed;
              },
            };
          },
        }),
      )
      .then((res) => {
        const rec = liveRequests.get(ev.requestId);
        if (rec?.streamed) return; // 流式路径已结算
        if (!res || typeof res.status !== "number") {
          throw new Error("handler must resolve { status, headers?, bodyChunks? }");
        }
        return server.resolveRequest(
          ev.requestId,
          res.status,
          res.headers ?? [],
          res.bodyChunks ?? null,
        );
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        Promise.resolve(server.rejectRequest(ev.requestId, msg)).catch(() => {});
      })
      .finally(() => {
        // 静态结算/拒绝即请求终态 → finalize；流式请求的记录留到流终态
        // 出口（finish / write 错误 / cancel 事件）再清
        const rec = liveRequests.get(ev.requestId);
        if (!rec?.streamed) finalizeRequest(ev.requestId);
      });
  });
  return {
    /** 停引擎循环 + 未决 handler 以取消结算（幂等）。R2-P1d：流式请求的
     * controller 一并 abort + liveRequests 全清（server.close 的 native 面
     * 只 drain pending——流式请求不在其中）。 */
    close(_reason) {
      for (const { controller } of liveRequests.values()) {
        try {
          controller.abort();
        } catch {
          // 已中止：忽略
        }
      }
      liveRequests.clear();
      return server.close();
    },
    /**
     * 内部桥句柄（native HttpServerJs）——/http/internals 的观测/结算原语
     * （pendingRequestCount/requestBodyNext/resolveRequest/rejectRequest/
     * respondStreaming）。semver 宽松：不构成稳定承诺。
     */
    native: server,
  };
}

module.exports = { fetchHttp, serveHttp };
