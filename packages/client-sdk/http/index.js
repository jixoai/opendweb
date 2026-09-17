// @jixo/opendweb-client-sdk/http —— HTTP/WS 绑定面（design §1.4/§3.4，
// app-protocol-layer task 4.2）。
// fetchHttp/serveHttp 是 §3.4 规范签名（自由函数形态）的 JS 投影：
// - fetchHttp：native session.fetchHttp + [Symbol.asyncIterator] 注入
//   （body AsyncIterable 投影；pull-first——每次 next() 触发一次内核拉取）
// - serveHttp：native fabric.serveHttp 的 TSFN JSON 事件桥 → 类型化 handler
//   调用；结算经 server.resolveRequest/rejectRequest 回流
const Native = require("../index.js");

/**
 * 发起 HTTP 请求（design §3.4）。本阶段 body 为静态分块（AsyncIterable 请求
 * 体后续 phase）；响应经 pull-first bodyNext() 消费，亦可 for-await 迭代。
 * headTimeoutMs 可配（默认 30s——长轮询/慢上游按需放宽）。
 * @param {import("../index.js").SessionHandle} session
 * @param {{
 *   method: string;
 *   path: string;
 *   headers?: Array<{ name: string; value: string }>;
 *   body?: Array<Uint8Array> | null;
 *   keepOpen?: boolean;
 *   headTimeoutMs?: number;
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
  /** per-server：已流式结算的请求（返回值兜底结算需跳过） */
  const streamed = new Set();
  /** per-server：requestId → AbortController（cancel 事件触发 abort） */
  const controllers = new Map();
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
      controllers.get(ev.requestId)?.abort();
      controllers.delete(ev.requestId);
      return;
    }
    if (ev?.type !== "request") return;
    const controller = new AbortController();
    controllers.set(ev.requestId, controller);
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
            streamed.add(ev.requestId);
            // controller 生命周期 = 流生命周期（非请求结算时刻）：终态出口
            // finish / write 错误 / cancel 事件处删除，防长流期间丢 cancel
            const rid = ev.requestId;
            return {
              write: (chunk) =>
                writer.write(Buffer.from(chunk)).catch((e) => {
                  controllers.delete(rid); // 通道已死（对端取消/引擎丢弃）
                  throw e;
                }),
              finish: () => {
                writer.finish();
                controllers.delete(rid); // 本地半关：后续 cancel 无意义
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
        if (streamed.has(ev.requestId)) return; // 流式路径已结算
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
        // 静态结算即请求终态 → 清 controller；流式请求的 controller 留到
        // 流终态出口（finish / write 错误 / cancel 事件）再清
        if (!streamed.has(ev.requestId)) controllers.delete(ev.requestId);
      });
  });
  return {
    /** 停引擎循环 + 未决 handler 以取消结算（幂等） */
    close(_reason) {
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
