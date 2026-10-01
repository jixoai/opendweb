// 测试共用工具（ai-subscription-sharing Phase A）。
// 1. wire handler 直调替身：ext-ports HttpHandlerRequestLike 同形状（Phase C
//    经 createWpkRouter 挂内核；本 Phase fake/注入面做单测——design §7.1）。
// 2. 真上游（node:http 127.0.0.1）：请求数组/连接计数；全部 listener 显式回收
//    （t.after 留证——子代理常驻进程回收纪律）。

import http from "node:http";
import net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** fixture 临时 home（回收由调用方 t.after 负责） */
export async function tempHome(prefix = "odai-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** 插件数据目录 <home>/plugins/ai（design §0 路径根）。 */
export function aiDataDir(home) {
  return path.join(home, "plugins", "ai");
}

/**
 * 事件驱动等待（轮询 10ms；超时抛错）。
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
 * 真上游（127.0.0.1）：连接/关闭计数 + 请求数组（method/url/headers/body）。
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>} handler
 */
export async function startUpstream(handler) {
  const hits = [];
  let connections = 0;
  let closedConnections = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      Promise.resolve(handler(req, res)).catch(() => {
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
    origin: `http://127.0.0.1:${port}`,
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
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * wire handler 直调（静态结算路径摊平；signal 可注入）。
 * @param {(req: any, peer: string) => Promise<any>} handler
 * @param {{
 *   method?: string, path?: string, headers?: Array<{name: string, value: string}>,
 *   body?: Buffer | string | Uint8Array, peer?: string, signal?: AbortSignal,
 * }} [opts]
 */
export async function callWire(handler, opts = {}) {
  const controller = new AbortController();
  const input = opts.body === undefined ? [] : [Buffer.from(opts.body)];
  let idx = 0;
  const req = {
    requestId: 1,
    streamId: 1,
    sessionId: "sess-test",
    signal: opts.signal ?? controller.signal,
    method: opts.method ?? "GET",
    path: opts.path ?? "/wpk1/ai/v1/auth",
    headers: opts.headers ?? [],
    bodyNext: async () => (idx < input.length ? input[idx++] : null),
    respondStreaming: () => null,
  };
  const res = await handler(req, opts.peer ?? "peer-test");
  return {
    status: res?.status,
    headers: res?.headers ?? [],
    body: Buffer.concat((res?.bodyChunks ?? []).map((c) => Buffer.from(c))),
    json() {
      return JSON.parse(this.body.toString("utf8"));
    },
    header(name) {
      const found = this.headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
      return found === undefined ? null : found.value;
    },
  };
}

/**
 * 头表小工具。
 * @param {Array<[string, string]>} pairs
 */
export function headers(...pairs) {
  return pairs.map(([name, value]) => ({ name, value }));
}

/**
 * JSON body 断言字符串（契约 byte 级断言用）。
 * @param {Record<string, unknown>} obj
 */
export function jsonBytes(obj) {
  return Buffer.from(JSON.stringify(obj));
}
