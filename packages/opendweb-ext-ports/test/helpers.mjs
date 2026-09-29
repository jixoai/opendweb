// 测试共用工具（webui-plugin-kernel Phase 1 ports）。
// 1. fabric 桥替身：以 client-sdk /http 的**已实现语义**（packages/client-sdk/
//    http/index.js + index.d.ts）为镜像——阶段 A 请求 signal abort=头等待期
//    即时 RESET（provider signal 触发 + fetch 以 AbortError 结算）；头返回后
//    请求 signal 取消键注销（晚到 abort 幂等 no-op——r2-B1 语义）；阶段 B
//    响应句柄 abort()=RESET（provider signal 触发 + writer.write 失败 +
//    消费端 bodyNext 有界失败）。不依赖真实 fabric。
// 2. 真上游/真客户端：node:http/net 实例（两机拓扑的 A 侧服务与 B 侧 curl 等
//    价物）；listener/server 进程全部显式回收（t.after 留证）。

import http from "node:http";
import net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** fixture 临时 home（t.after 回收由调用方负责） */
export async function tempHome(prefix = "wpk-ports-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * 事件驱动等待（轮询 10ms；超时抛错——时序断言的面）。
 * @param {() => boolean} pred
 * @param {number} [timeoutMs]
 * @param {string} [what]
 */
export async function waitFor(pred, timeoutMs = 3000, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * 空闲端口探测（bind 0 → 读回端口 → 立即释放；测试端口选择的惯例做法——
 * 存在微小竞争窗口，测试内串行使用可接受）。
 */
export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * 真上游（A 机 localhost 服务）：连接/关闭计数 + 请求数组（method/url/headers/body）。
 * handler 第 4 参=sendTimestamps 收集器（SSE 增量透传断言：每次 res.write 前手动
 * push 时间戳）。
 * @param {(req: http.IncomingMessage, res: http.ServerResponse, hits: Array<Record<string, unknown>>, sendTimestamps: number[]) => void | Promise<void>} handler
 */
export async function startUpstream(handler) {
  const hits = [];
  const sendTimestamps = [];
  let connections = 0;
  let closedConnections = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      Promise.resolve(handler(req, res, hits, sendTimestamps)).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
    });
  });
  server.on("connection", (socket) => {
    connections += 1;
    socket.on("close", () => {
      closedConnections += 1;
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  return {
    port,
    get hits() {
      return hits;
    },
    get connections() {
      return connections;
    },
    get closedConnections() {
      return closedConnections;
    },
    get activeConnections() {
      return connections - closedConnections;
    },
    /** 上游分块发送时间戳（SSE 增量透传断言用） */
    sendTimestamps,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * 单发 HTTP 请求（node:http；agent:false=逐请求独立连接）。
 * @param {number} port
 * @param {{ method?: string, path?: string, headers?: Record<string, string>, body?: Buffer | string }} [opts]
 */
export function request(port, opts = {}) {
  const { method = "GET", path = "/", headers = {}, body } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * 原始 socket 客户端（取消测试：可中途 destroy；记录到达分块与时间戳）。
 * @param {number} port
 * @param {string} rawRequest 首包请求字节（headers+可选部分体）
 */
export function rawClient(port, rawRequest) {
  const chunks = [];
  /** @type {Array<{ at: number, bytes: number }>} */
  const arrivals = [];
  let closed = false;
  let closeError = null;
  const socket = net.connect({ host: "127.0.0.1", port });
  // 立即写首包（net 会按序缓冲到连接建立后发出）——若等 'connect' 再写，
  // 调用方在连接前 write() 的数据会插队到请求行之前（实测产生 400）
  socket.write(rawRequest);
  socket.on("data", (c) => {
    chunks.push(c);
    arrivals.push({ at: Date.now(), bytes: c.length });
  });
  const closedPromise = new Promise((resolve) => {
    socket.on("close", () => {
      closed = true;
      resolve(undefined);
    });
    socket.on("error", (e) => {
      closeError = e;
    });
  });
  return {
    socket,
    get chunks() {
      return chunks;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get arrivals() {
      return arrivals;
    },
    get closed() {
      return closed;
    },
    get closeError() {
      return closeError;
    },
    closedPromise,
    /** @param {Buffer | string} data */
    write(data) {
      socket.write(data);
    },
    destroy() {
      socket.destroy();
    },
  };
}

/**
 * fabric 桥替身（消费侧 fetchHttpImpl ↔ 提供侧 handler 直连；语义镜像
 * client-sdk /http：见文件头）。events 记录：request-signal-abort（消费端
 * 请求 signal abort——仅头等待期有效）/ resp-abort（响应句柄 abort——阶段 B）/
 * provider-signal（RESET 到达 provider：request.signal 触发）。
 * @param {(req: import("../src/provider.mjs").HttpHandlerRequestLike) => Promise<import("../src/provider.mjs").HttpHandlerResponseLike | null | void>} handler
 */
export function createFabricBridge(handler) {
  const fetchCalls = [];
  const events = [];
  let seq = 0;

  async function fetchHttpImpl(session, init) {
    const requestId = ++seq;
    fetchCalls.push({
      requestId,
      sessionId: session?.sessionId ?? "unknown",
      method: init.method,
      path: init.path,
      headers: init.headers ?? [],
      bodyBytes: (init.body ?? []).reduce((n, c) => n + c.length, 0),
    });
    // 预中止（真实 fetchHttp P1-6：已 aborted signal 同步失败，不发起请求）
    if (init.signal?.aborted) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }

    // ---- provider 侧请求生命周期 ----
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => events.push({ type: "provider-signal", requestId }));
    const reqBody = (init.body ?? []).map((c) => Buffer.from(c));
    let bodyIdx = 0;

    // ---- 响应通道状态 ----
    let headSettled = false;
    let streaming = false;
    let cancelled = false; // RESET 已发生（阶段 A abort 或阶段 B resp.abort）
    let responseStatus = 0;
    /** @type {Array<{name: string, value: string}>} */
    let responseHeaders = [];
    const bodyQueue = [];
    let bodyEOF = false;
    const bodyWaiters = [];

    const wakeBody = () => {
      for (const w of bodyWaiters.splice(0)) w();
    };

    let headResolve = () => {};
    let headReject = () => {};
    const headPromise = new Promise((res, rej) => {
      headResolve = res;
      headReject = rej;
    });
    const settleHead = (fn) => {
      if (headSettled) return;
      headSettled = true;
      fn();
    };

    /** @type {import("../src/provider.mjs").HttpHandlerRequestLike} */
    const request = {
      requestId,
      streamId: requestId,
      sessionId: session?.sessionId ?? "unknown",
      signal: controller.signal,
      method: init.method,
      path: init.path,
      headers: init.headers ?? [],
      bodyNext: async () => (bodyIdx < reqBody.length ? reqBody[bodyIdx++] : null),
      respondStreaming(status, headers) {
        if (streaming || headSettled || cancelled) return null; // 已结算/已取消
        streaming = true;
        responseStatus = status;
        responseHeaders = headers ?? [];
        settleHead(headResolve);
        return {
          write: async (chunk) => {
            if (cancelled) throw new Error("write on cancelled stream");
            bodyQueue.push(Buffer.from(chunk));
            wakeBody();
          },
          finish: () => {
            bodyEOF = true;
            wakeBody();
          },
          get finished() {
            return bodyEOF;
          },
          get cancelled() {
            return cancelled;
          },
          get closed() {
            return cancelled || bodyEOF;
          },
        };
      },
    };

    // provider handler 调用（静态结算路径；流式经 respondStreaming）
    Promise.resolve()
      .then(() => handler(request))
      .then((res) => {
        if (streaming || cancelled) return; // 流式已结算 / 对端已弃：丢弃
        if (res !== null && res !== undefined && typeof res.status === "number") {
          responseStatus = res.status;
          responseHeaders = res.headers ?? [];
          for (const c of res.bodyChunks ?? []) bodyQueue.push(Buffer.from(c));
          bodyEOF = true;
          wakeBody();
          settleHead(headResolve);
        }
      })
      .catch((e) => {
        // provider 抛错 = rejectRequest 语义（头未回 → 消费端失败）
        settleHead(() => headReject(new Error(`provider handler failed: ${e?.message ?? e}`)));
      });

    // 消费端请求 signal（真实语义：abortKey 仅头等待期注册；结算后晚到 abort 幂等 no-op）
    init.signal?.addEventListener(
      "abort",
      () => {
        events.push({ type: "request-signal-abort", requestId });
        if (headSettled) return; // 头已回：取消键已注销（r2-B1 阶段划分）
        cancelled = true;
        controller.abort(); // RESET → provider signal
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        settleHead(() => headReject(err));
      },
      { once: true },
    );

    await headPromise; // AbortError（阶段 A）或 provider 错误在此抛出

    // 响应句柄（阶段 B 的 abort 面：HttpClientResponse.abort）
    return {
      get status() {
        return responseStatus;
      },
      get headers() {
        return responseHeaders;
      },
      streamId: requestId,
      async bodyNext() {
        if (cancelled) throw new Error("session stream aborted");
        if (bodyQueue.length > 0) return bodyQueue.shift();
        if (bodyEOF) return null;
        await new Promise((r) => bodyWaiters.push(r));
        if (cancelled) throw new Error("session stream aborted");
        if (bodyQueue.length > 0) return bodyQueue.shift();
        return null;
      },
      async abort() {
        if (cancelled || bodyEOF) return; // 幂等
        cancelled = true;
        events.push({ type: "resp-abort", requestId });
        controller.abort(); // RESET → provider signal + writer.write 失败
        wakeBody();
      },
      async sendTunnel() {
        throw new Error("not a tunnel");
      },
    };
  }

  return {
    fetchHttpImpl,
    fetchCalls,
    events,
    /** @param {string} type @param {number} [requestId] */
    countEvents(type, requestId) {
      return events.filter((e) => e.type === type && (requestId === undefined || e.requestId === requestId)).length;
    },
  };
}

/**
 * 直调 provider handler（授权矩阵等单元面）：静态/流式两条结算路径统一摊平。
 * @param {(req: import("../src/provider.mjs").HttpHandlerRequestLike) => Promise<import("../src/provider.mjs").HttpHandlerResponseLike | null | void>} handler
 * @param {{ method?: string, path?: string, headers?: Array<{name: string, value: string}>, bodyChunks?: Uint8Array[], sessionId?: string }} [opts]
 */
export async function invokeHandler(handler, opts = {}) {
  const controller = new AbortController();
  const input = (opts.bodyChunks ?? []).map((c) => Buffer.from(c));
  let idx = 0;
  let streaming = false;
  let streamStatus = 0;
  /** @type {Array<{name: string, value: string}>} */
  const streamHeaders = [];
  const bodyChunks = [];
  let resolveFinish = () => {};
  const finished = new Promise((r) => {
    resolveFinish = r;
  });
  /** @type {import("../src/provider.mjs").HttpHandlerRequestLike} */
  const req = {
    requestId: 1,
    streamId: 1,
    sessionId: opts.sessionId ?? "sess-unit",
    signal: controller.signal,
    method: opts.method ?? "GET",
    path: opts.path ?? "/wpk1/ports/proxy/8080/",
    headers: opts.headers ?? [],
    bodyNext: async () => (idx < input.length ? input[idx++] : null),
    respondStreaming(status, headers) {
      if (streaming) return null;
      streaming = true;
      streamStatus = status;
      streamHeaders.push(...(headers ?? []));
      return {
        write: async (chunk) => {
          bodyChunks.push(Buffer.from(chunk));
        },
        finish: () => {
          resolveFinish();
        },
        get finished() {
          return false;
        },
        get cancelled() {
          return controller.signal.aborted;
        },
        get closed() {
          return false;
        },
      };
    },
  };
  const result = await handler(req);
  if (streaming) {
    // 流式：handler Promise 已结算 null，body 仍异步写入——有界等 finish
    await Promise.race([finished, new Promise((r) => setTimeout(r, 3000))]);
    return { mode: "streaming", status: streamStatus, headers: streamHeaders, bodyChunks };
  }
  if (result === null || result === undefined) return { mode: "none" };
  return {
    mode: "static",
    status: result.status,
    headers: result.headers ?? [],
    bodyChunks: (result.bodyChunks ?? []).map((c) => Buffer.from(c)),
  };
}
