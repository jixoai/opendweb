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
 * @param {import("../index.js").SessionHandle} session
 * @param {{
 *   method: string;
 *   path: string;
 *   headers?: Array<{ name: string; value: string }>;
 *   body?: Array<Uint8Array> | null;
 *   keepOpen?: boolean;
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
 * （bodyNext 拉取请求体，EOF = null），返回 { status, headers?, bodyChunks? }。
 * 本阶段响应体为静态分块（引擎有界背压承接）；流式供给后续 phase。
 * @param {import("../index.js").Fabric} fabric
 * @param {string} peerId
 * @param {(req: {
 *   requestId: number;
 *   streamId: number;
 *   method: string;
 *   path: string;
 *   headers: Array<{ name: string; value: string }>;
 *   bodyNext: () => Promise<Buffer | null>;
 * }) => Promise<{ status: number; headers?: Array<{ name: string; value: string }>; bodyChunks?: Array<Uint8Array> }> | { status: number; headers?: Array<{ name: string; value: string }>; bodyChunks?: Array<Uint8Array> }} handler
 */
async function serveHttp(fabric, peerId, handler) {
  const server = await fabric.serveHttp(peerId, (err, json) => {
    if (err) return;
    /** @type {any} */
    let ev;
    try {
      ev = JSON.parse(json);
    } catch {
      return;
    }
    if (ev?.type !== "request") return;
    Promise.resolve()
      .then(() =>
        handler({
          requestId: ev.requestId,
          streamId: ev.streamId,
          method: ev.method,
          path: ev.path,
          headers: ev.headers ?? [],
          bodyNext: () => server.requestBodyNext(ev.requestId),
        }),
      )
      .then((res) => {
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
      });
  });
  return {
    /** 停引擎循环 + 未决 handler 以取消结算（幂等） */
    close(_reason) {
      return server.close();
    },
    /**
     * 内部桥句柄（native HttpServerJs）——/http/internals 的观测/结算原语
     * （pendingRequestCount/requestBodyNext/resolveRequest/rejectRequest）。
     * semver 宽松：不构成稳定承诺。
     */
    native: server,
  };
}

module.exports = { fetchHttp, serveHttp };
