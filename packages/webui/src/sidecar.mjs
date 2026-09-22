// 本地管理 sidecar（webui-console design §2 / specs/webui「本地管理 sidecar」）。
// 意图（2026-09-22，webui-console Phase A）：
// 1. 127.0.0.1 + 随机端口绑定；静态面 dist/（缺失降级占位页）+ SPA fallback；
// 2. /api/* 白名单反代：GET/POST/DELETE → /admin/*（Bearer 注入；入站 raw
//    path 独立解析 + 拼接后二次 /admin/ 断言，越界 404 且零出站）；
// 3. /sidecar/connect 配对面：一次性配对码（常时比较/10min/连败 5 次销毁）
//    + Host === 127.0.0.1:port + Origin 同源或缺失；成功即目标冻结；
// 4. stdlib http/https.request 按解析 IP + SNI + Host 逐请求连接（agent:false
//    + 响应结束/abort 即 destroy socket）；body 界 64KiB/1MiB；10s 超时；
// 5. 日志只记 method/path/status/耗时——token 不进任何日志/响应。
// 零运行时依赖（node 标准库）；测试经 startSidecar 注入 distDir/dns/now。

import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTarget } from "./target.mjs";

/** 资源界与配对面参数（design §2.3/§2.2 冻结值） */
export const LIMITS = {
  /** 请求 body 上限（入站 /api 与 /sidecar/connect 共用） */
  requestBytes: 64 * 1024,
  /** 上游响应 body 上限（超限 abort + 502 upstream-too-large） */
  responseBytes: 1024 * 1024,
  /** 上游超时（连接 + 响应整体） */
  upstreamTimeoutMs: 10_000,
  /** 配对码有效期 */
  pairingTtlMs: 10 * 60_000,
  /** 配对码连续失败销毁阈值（防在线猜测） */
  pairingMaxFailures: 5,
};

/** 代理方法白名单（非通用代理） */
const API_METHODS = new Set(["GET", "POST", "DELETE"]);

/** 上游响应头白名单（其余剥除；hop-by-hop 永不透传） */
const RESPONSE_HEADER_WHITELIST = ["content-type", "etag", "last-modified"];

/** dist 缺失时的占位页（UI 未构建/发布裁剪的显式降级，测试钉住） */
const PLACEHOLDER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>opendweb-webui</title></head>
<body>
<h1>opendweb-webui</h1>
<p>The console UI is not built in this copy (dist/ is missing).</p>
<p>The sidecar itself is running: the <code>/api/*</code> proxy and the
<code>/sidecar/connect</code> pairing endpoint are operational. Install a
release that ships dist/, or build the UI package.</p>
</body>
</html>
`;

/** 静态面 MIME（按扩展名；缺省 octet-stream） */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 入站 raw path 独立解析（design §2.4 r2-P1-7）：`/api/x` → 单层 admin 相对
 * 路径。拒绝 dot-segment、percent-encoded 分隔符/点、反斜杠、空段与重复
 * 斜杠——任一命中即 404 且零出站。raw 检查先于任何解码（Node 不规范化
 * req.url，编码差异在此全数拦截）。
 * @param {string} rawUrl
 * @returns {{ ok: true, value: { rel: string, query: string } } | { ok: false, error: string }}
 */
export function parseApiPath(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl === "") return { ok: false, error: "empty path" };
  const q = rawUrl.indexOf("?");
  const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? "" : rawUrl.slice(q + 1);
  if (!rawPath.startsWith("/api/")) return { ok: false, error: "not under /api/" };
  const rel = rawPath.slice("/api/".length);
  if (rel === "") return { ok: false, error: "empty /api/ tail" };
  const lower = rel.toLowerCase();
  if (rel.includes("\\") || lower.includes("%2f") || lower.includes("%5c") || lower.includes("%2e")) {
    return { ok: false, error: "encoded separator or dot segment" };
  }
  const segs = rel.split("/");
  if (segs.includes(".") || segs.includes("..")) return { ok: false, error: "dot segment" };
  if (segs.includes("")) return { ok: false, error: "empty segment (duplicate or trailing slash)" };
  return { ok: true, value: { rel, query } };
}

/** 8 随机字节 → base32（RFC 4648，无填充；13 字符定长） */
export function generatePairingCode(random = randomBytes) {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const buf = random(8);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 常时比较：先哈希到定长再 timingSafeEqual（输入长度差不泄漏内容比较） */
function constantTimeEqual(a, b) {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * 启动 sidecar。
 * @param {{ target?: object | null, token?: string, port?: number, distDir?: string, log?: (line: string) => void, allowInsecure?: boolean, dns?: object, now?: () => number }} [opts]
 *   - target：validateTarget 成功值（给出即 ready；缺省 setup 模式）
 *   - token：admin token（仅驻内存；不落任何日志/响应）
 *   - dns/now：注入面（测试）
 * @returns {Promise<{ port: number, origin: string, url: string, mode: () => "setup" | "ready", pairingCode: string | null, close: () => Promise<void> }>}
 */
export async function startSidecar(opts = {}) {
  const {
    target = null,
    token = "",
    port = 0,
    distDir = path.join(pkgRoot, "dist"),
    log = () => {},
    allowInsecure = false,
    dns,
    now = () => Date.now(),
  } = opts;
  if (target && (typeof token !== "string" || token === "")) {
    throw new Error("startSidecar: target requires a token");
  }
  const distRoot = path.resolve(distDir);

  /** 目标生命周期状态机：setup → ready → 进程退出（无运行时改目标路径） */
  const state = {
    mode: /** @type {"setup" | "ready"} */ (target ? "ready" : "setup"),
    target: target ?? null,
    token,
    pairing:
      target === null
        ? { code: generatePairingCode(), expiresAt: now() + LIMITS.pairingTtlMs, failures: 0, dead: false }
        : null,
  };
  /** 在途上游请求（close 时全量销毁，不留半开连接） */
  const inflight = new Set();

  const server = http.createServer((req, res) => {
    Promise.resolve(route(req, res)).catch((e) => {
      log(`sidecar error: ${safeError(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { code: "internal" } });
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });
  const actualPort = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const origin = `http://127.0.0.1:${actualPort}`;

  async function route(req, res) {
    const p = req.url ?? "/";
    if (p === "/api" || p.startsWith("/api/") || p.startsWith("/api?")) return handleApi(req, res);
    if (p === "/sidecar" || p.startsWith("/sidecar/")) return handleSidecar(req, res);
    return handleStatic(req, res);
  }

  // ---- /api/* 白名单代理面 ----

  async function handleApi(req, res) {
    const startedAt = now();
    if (state.mode === "setup") {
      sendJson(res, 503, { error: { code: "no-target", message: "no target configured; open the sidecar URL and pair a server first" } });
      logAccess(req, 503, startedAt);
      return;
    }
    if (!API_METHODS.has(req.method ?? "")) {
      sendJson(res, 405, { error: { code: "method-not-allowed", message: `${req.method} is not allowed on /api/*` } });
      logAccess(req, 405, startedAt);
      return;
    }
    const parsed = parseApiPath(req.url);
    if (!parsed.ok) {
      // 越界请求：404 且零出站（此 return 之前没有任何上游连接动作）
      sendJson(res, 404, { error: { code: "not-found" } });
      logAccess(req, 404, startedAt);
      return;
    }
    const body = await readBody(req, res);
    if (body === null) {
      // 超限：413 已发出
      logAccess(req, 413, startedAt);
      return;
    }
    await proxyAdmin(req, res, parsed.value, body, startedAt);
  }

  function proxyAdmin(req, res, parsed, body, startedAt) {
    return new Promise((resolve) => {
      // 拼接 + 二次断言（双保险：即便未来解析函数被改，也不把带 Bearer 的
      // 请求送出 /admin/ 白名单）
      const upstreamPath = `/admin/${parsed.rel}${parsed.query ? `?${parsed.query}` : ""}`;
      if (!upstreamPath.startsWith("/admin/")) {
        sendJson(res, 500, { error: { code: "internal" } });
        logAccess(req, 500, startedAt);
        resolve(undefined);
        return;
      }
      const t = /** @type {NonNullable<typeof state.target>} */ (state.target);
      const mod = t.scheme === "https" ? https : http;
      const options = {
        method: req.method,
        host: t.connectHost, // 解析缓存 IP——请求内不复解析（防 rebinding）
        port: t.port,
        servername: t.servername ?? undefined, // TLS SNI（域名才有）
        path: upstreamPath,
        agent: false, // 逐请求连接：禁用 keep-alive 复用
        headers: {
          host: t.hostHeader, // 原序列化 host[:port]
          authorization: `Bearer ${state.token}`,
        },
      };
      const ctype = req.headers["content-type"];
      if (ctype !== undefined) options.headers["content-type"] = ctype;
      if (body.length > 0) options.headers["content-length"] = String(body.length);

      let settled = false;
      let timedOut = false;
      const upstreamReq = mod.request(options, (up) => {
        const chunks = [];
        let size = 0;
        up.on("data", (chunk) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) {
            // 上游资源界：abort 连接（socket 回收）+ 502 envelope
            if (settled) return;
            settled = true;
            upstreamReq.destroy();
            sendJson(res, 502, { error: { code: "upstream-too-large" } });
            logAccess(req, 502, startedAt);
            return;
          }
          chunks.push(chunk);
        });
        up.on("end", () => {
          if (settled) return;
          settled = true;
          const headers = {};
          for (const name of RESPONSE_HEADER_WHITELIST) {
            const v = up.headers[name];
            if (v !== undefined) headers[name] = v;
          }
          // 3xx 原状态透传（不跟随重定向——fetch 未参与，天然不跟）
          res.writeHead(up.statusCode ?? 502, headers);
          res.end(Buffer.concat(chunks));
          logAccess(req, up.statusCode ?? 502, startedAt);
          finish(upstreamReq);
        });
        up.on("error", () => {
          if (settled) return;
          settled = true;
          sendJson(res, 502, { error: { code: "upstream-unreachable" } });
          logAccess(req, 502, startedAt);
          finish(upstreamReq);
        });
        up.on("aborted", () => {
          if (settled) return;
          settled = true;
          sendJson(res, 502, { error: { code: "upstream-unreachable" } });
          logAccess(req, 502, startedAt);
          finish(upstreamReq);
        });
      });
      inflight.add(upstreamReq);
      upstreamReq.on("close", () => inflight.delete(upstreamReq));
      upstreamReq.setTimeout(LIMITS.upstreamTimeoutMs, () => {
        timedOut = true;
        upstreamReq.destroy(new Error("upstream timeout"));
      });
      upstreamReq.on("error", (e) => {
        if (settled) return;
        settled = true;
        if (timedOut) sendJson(res, 504, { error: { code: "upstream-timeout" } });
        else sendJson(res, 502, { error: { code: "upstream-unreachable", message: safeError(e) } });
        logAccess(req, timedOut ? 504 : 502, startedAt);
      });
      if (body.length > 0) upstreamReq.write(body);
      upstreamReq.end();
      resolve(undefined);
    });
  }

  /** 响应结束即销毁 socket（keep-alive 不跨请求存活；abort 路径同走 destroy） */
  function finish(upstreamReq) {
    upstreamReq.destroy();
  }

  // ---- /sidecar/* 配对面 ----

  async function handleSidecar(req, res) {
    const startedAt = now();
    if (req.method !== "POST") {
      sendJson(res, 404, { error: { code: "not-found" } });
      logAccess(req, 404, startedAt);
      return;
    }
    if (state.mode === "ready") {
      // 目标冻结：任何 /sidecar/* 提交一律 target-frozen（重指向 = 重启）
      sendJson(res, 400, { error: { code: "target-frozen", message: "target is frozen for this sidecar lifetime; restart to re-point" } });
      logAccess(req, 400, startedAt);
      return;
    }
    if (req.url !== "/sidecar/connect") {
      sendJson(res, 404, { error: { code: "not-found" } });
      logAccess(req, 404, startedAt);
      return;
    }
    const body = await readBody(req, res);
    if (body === null) {
      logAccess(req, 413, startedAt);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: { code: "invalid-request", message: "body must be JSON" } });
      logAccess(req, 400, startedAt);
      return;
    }
    // 防线 (2)(3)：Host 精确等于 127.0.0.1:port（防 DNS rebinding）；Origin
    // 缺失（curl/同源表单）或等于 sidecar origin（防外站 CSRF）。先于配对码
    // 校验——header 坏不烧配对次数。
    if (req.headers.host !== `127.0.0.1:${actualPort}`) {
      sendJson(res, 400, { error: { code: "bad-origin-host", message: "Host header must be the sidecar origin" } });
      logAccess(req, 400, startedAt);
      return;
    }
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && originHeader !== origin) {
      sendJson(res, 400, { error: { code: "bad-origin-host", message: "cross-origin posts are rejected" } });
      logAccess(req, 400, startedAt);
      return;
    }
    // 防线 (1)：一次性配对码（常时比较；10min；连败 5 次销毁）
    const pairing = state.pairing;
    const code = typeof parsed?.pairing_code === "string" ? parsed.pairing_code.trim().toUpperCase() : "";
    const codeAlive =
      pairing !== null && !pairing.dead && now() <= pairing.expiresAt && pairing.code.length > 0;
    if (!codeAlive || code === "" || !constantTimeEqual(code, pairing?.code ?? "")) {
      if (pairing !== null) {
        pairing.failures += 1;
        if (pairing.failures >= LIMITS.pairingMaxFailures) pairing.dead = true;
      }
      sendJson(res, 400, { error: { code: "bad-pairing", message: "pairing code is wrong, expired, or burned" } });
      logAccess(req, 400, startedAt);
      return;
    }
    const server = typeof parsed?.server === "string" ? parsed.server : "";
    const token = typeof parsed?.token === "string" ? parsed.token : "";
    if (server === "" || token === "") {
      sendJson(res, 400, { error: { code: "invalid-request", message: "server and token are required" } });
      logAccess(req, 400, startedAt);
      return;
    }
    const v = await validateTarget(server, { allowInsecure, dns });
    if (!v.ok) {
      // 目标守卫失败：配对码匹配成功不烧次数（URL 笔误可重试）
      sendJson(res, 400, { error: { code: "bad-target", message: v.error } });
      logAccess(req, 400, startedAt);
      return;
    }
    // 三防线全过：存内存目标 + token → 冻结 → 配对码销毁（单次有效）
    state.target = v.value;
    state.token = token;
    state.mode = "ready";
    state.pairing = null;
    sendJson(res, 200, { ok: true });
    log(`sidecar: target connected (${v.value.scheme}://${v.value.hostHeader})`);
  }

  // ---- 静态面 ----

  async function handleStatic(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    // dist 缺失降级：单页占位说明 UI 未构建（/api 与 /sidecar 照常工作）。
    // 有意为之的显式降级而非 500——sidecar 的核心价值（代理 + 配对）不依赖
    // 静态资源；发布产物裁剪或开发未构建时保持可用。
    if (!existsSync(path.join(distRoot, "index.html"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : PLACEHOLDER_HTML);
      return;
    }
    /** @type {string} */
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://sidecar.local").pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad path encoding");
      return;
    }
    const clean = path.posix.normalize(pathname);
    const filePath = path.resolve(distRoot, `.${clean}`);
    if (filePath !== distRoot && !filePath.startsWith(distRoot + path.sep)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    let st = null;
    try {
      st = await stat(filePath);
    } catch {
      st = null;
    }
    const target = st !== null && st.isFile() ? filePath : path.join(distRoot, "index.html"); // SPA fallback（hash 路由）
    try {
      const buf = await readFile(target);
      res.writeHead(200, {
        "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-length": String(buf.length),
      });
      res.end(req.method === "HEAD" ? undefined : buf);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  }

  // ---- 共用工具 ----

  /**
   * 读请求 body（cap 上限）。超限：发 413 并销毁连接，返回 null。
   * @returns {Promise<Buffer | null>}
   */
  function readBody(req, res) {
    return new Promise((resolve) => {
      const declared = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > LIMITS.requestBytes) {
        sendJson(res, 413, { error: { code: "request-too-large" } });
        req.destroy();
        resolve(null);
        return;
      }
      const chunks = [];
      let size = 0;
      let over = false;
      req.on("data", (c) => {
        if (over) return;
        size += c.length;
        if (size > LIMITS.requestBytes) {
          over = true;
          sendJson(res, 413, { error: { code: "request-too-large" } });
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (over) return;
        resolve(Buffer.concat(chunks));
      });
      req.on("error", () => {
        if (over) return;
        over = true;
        resolve(null);
      });
    });
  }

  /** 日志纪律：只记 method/path（不含 query）/status/耗时——无 headers/token */
  function logAccess(req, status, startedAt) {
    const p = req.url ?? "/";
    const pathOnly = p.includes("?") ? p.slice(0, p.indexOf("?")) : p;
    log(`${req.method} ${pathOnly} ${status} ${now() - startedAt}ms`);
  }

  return {
    port: actualPort,
    origin,
    url: origin,
    mode: () => state.mode,
    pairingCode: state.pairing?.code ?? null,
    close: async () => {
      for (const r of inflight) r.destroy();
      inflight.clear();
      const closing = new Promise((resolve) => server.close(() => resolve(undefined)));
      server.closeAllConnections?.();
      await closing;
    },
  };
}

/** JSON envelope 输出（ASCII 纪律：code/message 均为程序内 ASCII 常量或已转义错误） */
function sendJson(res, status, body) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": String(buf.length) });
  res.end(buf);
}

/** 错误信息净化（防 token/非 ASCII 意外入日志） */
function safeError(e) {
  const s = String(e?.message ?? e);
  let out = "";
  for (const ch of s) out += ch >= "\x20" && ch <= "\x7e" ? ch : "?";
  return out;
}
