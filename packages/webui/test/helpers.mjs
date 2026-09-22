// 测试共用工具：假上游（计数连接/请求）、HTTP 请求 Promise 封装、假 DNS。
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 假上游：本地 http server，统计连接数（keep-alive 复用会令连接数 < 请求数）
 * 与请求数（越界零出站断言），handler 可按需响应。
 * @param {{ handler?: (req: http.IncomingMessage, res: http.ServerResponse, hits: Array<{ method: string, url: string, headers: Record<string, string | string[] | undefined>, body: Buffer }>) => void | Promise<void> }} [opts]
 */
export async function fakeUpstream(opts = {}) {
  const hits = [];
  let connections = 0;
  let closedConnections = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      Promise.resolve(opts.handler?.(req, res, hits)).catch(() => {
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
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    get hits() {
      return hits;
    },
    get connections() {
      return connections;
    },
    get closedConnections() {
      return closedConnections;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * 单发 HTTP 请求（路径原样发送——Node 客户端不规范化 path，dot-segment/
 * 编码分隔符保持 raw 进入被测端）。
 * @param {number} port
 * @param {{ method?: string, path?: string, headers?: Record<string, string>, body?: Buffer | string }} [opts]
 */
export function request(port, opts = {}) {
  const { method = "GET", path = "/", headers = {}, body } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
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

/** JSON POST 快捷方式 */
export async function postJson(port, urlPath, obj, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  return request(port, {
    method: "POST",
    path: urlPath,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: buf,
  });
}

/** 假 DNS：hostname → 记录表（或抛错）；记录调用参数供断言 */
export function fakeDns(map, { fail = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async lookup(hostname, opts) {
      calls.push({ hostname, opts });
      if (fail.has(hostname)) throw new Error("getaddrinfo ENOTFOUND");
      const records = map[hostname];
      if (records === undefined) throw new Error("getaddrinfo ENOTFOUND");
      return records.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
  };
}

/**
 * preact vnode → HTML 字符串（UI 单测断言面）：展开函数组件、拼接属性与
 * 文本。仅用于断言（非转义、非完整性）——关注「含预期提示」与横幅计数。
 * @param {import("preact").VNode | string | number | Array | null | undefined | boolean} v
 * @returns {string}
 */
export function vnodeHtml(v) {
  if (v === null || v === undefined || v === false || v === true) return "";
  if (Array.isArray(v)) return v.map(vnodeHtml).join("");
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (typeof v.type === "function") return vnodeHtml(v.type(v.props ?? {}));
  const props = v.props ?? {};
  const attrs = Object.entries(props)
    .filter(([k, val]) => k !== "children" && k !== "key" && k !== "ref" && val !== null && val !== undefined && val !== false)
    .map(([k, val]) => (val === true ? ` ${k}` : ` ${k}="${String(val)}"`))
    .join("");
  const tag = String(v.type);
  return `<${tag}${attrs}>${vnodeHtml(props.children)}</${tag}>`;
}

export { delay };
