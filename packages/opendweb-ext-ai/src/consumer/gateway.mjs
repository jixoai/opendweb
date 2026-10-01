// adapted from ai-fly src/consumer/gateway.ts (v0.6.0) —— 消费方本地回环网关
// （tasks B3）。与上游的有意分歧（design §0/§8）：
// - node:http 直挂（上游 hono+@hono/node-server）——本包零 hono 运行时依赖
//   （依赖隔离纪律：宿主不 import ext 包依赖）；
// - 端口冲突=真实 listen EADDRINUSE 明确报错（上游 listenWithFallback 静默
//   换端口——design「端口冲突真实 listen+明确报错不静默换端口」明确分歧）；
// - 仅 127.0.0.1 监听（design §8「不做」清单：非回环监听）；
// - WS 升级显式拒绝（v1 不做 WS 透传——raw 400+错误 JSON，不建隧道）。
// 照搬语义：入站凭据头协议层剥离（authorization/proxy-authorization/cookie
// 等双向零过桥）；路由=预设白名单映射（未声明路径 404 path_not_offered 本地
// 即拒、零触达上游）；SSE=字节流透明中继（逐块 flush——首块立发，后续按
// 上游块边界即到即发（≤min(256KiB|50ms|上游块边界) 上界）；错误=OpenAI
// 风格 error JSON（rate_limited/quota_exceeded 透传码）；提供方不可用族
// （A 停用 plugin-disabled/离线传输失败）→ 502 upstream_unreachable 明确码
// +固定脱敏文案（Phase D 顺手项——classifyLocalError）；本地断开→cancel+
// 在途拉取 abort（取消双向传播）。

import http from "node:http";
import { MAX_CHUNK_PAYLOAD } from "../wire/constants.mjs";

/** 仅回环监听（design §8）。 */
export const LOOPBACK_HOST = "127.0.0.1";

/** 剥离集合：凭据类（协议双向零过桥）+归属类+逐跳头（ai-fly STRIP 同拍）。 */
const STRIP_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "expect",
  "set-cookie",
]);

/**
 * 入站头过滤：小写键、去凭据/归属/逐跳；content-type 抽独立字段。
 * @param {http.IncomingMessage["headers"]} raw
 */
export function filterRequestHeaders(raw) {
  const out = {};
  let contentType;
  const ct = raw["content-type"];
  if (typeof ct === "string") contentType = ct;
  else if (Array.isArray(ct) && typeof ct[0] === "string") contentType = ct[0];
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue; // 数组值（set-cookie 等）不透传
    if (STRIP_REQUEST_HEADERS.has(name)) continue;
    out[name] = value;
  }
  return { headers: out, contentType };
}

/**
 * 路由白名单映射（localPrefix→upstreamPrefix；最长前缀优先）。
 * @param {Array<{ localPrefix: string, upstreamPrefix: string }>} routes
 * @param {string} localPath 无查询串的本地路径
 * @returns {{ upstreamPath: string } | null} null=白名单外（404 path_not_offered）
 */
export function mapRoute(routes, localPath) {
  let best = null;
  for (const route of routes ?? []) {
    const lp = route.localPrefix === "/" ? "" : route.localPrefix.replace(/\/$/, "");
    const match = lp === "" ? true : localPath === lp || localPath.startsWith(`${lp}/`);
    if (match && (best === null || lp.length > best.lp.length)) {
      best = { lp, up: route.upstreamPrefix === "/" ? "" : route.upstreamPrefix.replace(/\/$/, "") };
    }
  }
  if (best === null) return null;
  const rest = best.lp === "" ? localPath : localPath.slice(best.lp.length);
  return { upstreamPath: `${best.up}${rest}` };
}

/**
 * 错误码→本地 HTTP 状态（OpenAI 风格投影；与 provider errorHttpStatus 同拍
 * 消费侧表——rate_limited/quota_exceeded 透传码不变）。
 * @param {string} code
 */
export function localErrorStatus(code) {
  switch (code) {
    case "path_not_offered":
    case "unknown_service":
    case "response_not_found":
    case "response_expired":
      return 404;
    case "key_invalid":
    case "key_revoked":
    case "key_all_invalid":
    case "unauthorized":
      return 403;
    case "rate_limited":
    case "quota_exceeded":
      return 429;
    case "body_too_large":
      return 413;
    case "metadata_invalid":
    case "metadata_too_large":
    case "service_source_conflict":
      return 400;
    case "aborted":
    case "idle_timeout":
      return 504;
    case "upstream_unreachable":
      return 502;
    case "auth_revoked":
      return 503;
    default:
      return 502;
  }
}

/**
 * 提供方不可用族（Phase D 顺手项：「A 已停用」等会话错误的明确码化）：内核
 * wpk 路由的 plugin-disabled/router-missing/unknown-plugin（503/404 族，A 停用
 * 或摘牌）+ 会话层未识别的 internal（fabric 传输失败/A 离线）→ 本地 502
 * upstream_unreachable（502 族明确码），文案固定脱敏（不透传原始错误文案与
 * 头）。OpenAI 风格 error JSON 形态不变（openAiErrorBody）。
 */
const PROVIDER_UNAVAILABLE_CODES = new Set(["plugin-disabled", "router-missing", "unknown-plugin", "internal"]);

/**
 * 会话错误 → 本地回复三元组（状态/码/文案）。
 * @param {{ code?: string | null, message?: string | null }} err
 * @returns {{ status: number, code: string, message: string }}
 */
export function classifyLocalError(err) {
  const code = typeof err?.code === "string" && err.code !== "" ? err.code : "internal";
  if (PROVIDER_UNAVAILABLE_CODES.has(code)) {
    return {
      status: 502,
      code: "upstream_unreachable",
      message: "the provider endpoint is unreachable, offline, or its ai plugin is not running",
    };
  }
  return { status: localErrorStatus(code), code, message: err?.message ?? code };
}

/**
 * OpenAI 风格 error JSON body。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
export function openAiErrorBody(status, code, message) {
  const type = status === 429 ? "rate_limit_error" : status === 401 || status === 403 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return { error: { message, type, code } };
}

/** WS v1 显式拒绝的原始响应（不建隧道；零上游触达）。 */
function rejectUpgrade(socket) {
  const body = Buffer.from(JSON.stringify(openAiErrorBody(400, "protocol_error", "websocket passthrough is not supported")));
  socket.write(`HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`);
  socket.write(body);
  socket.destroy();
}

/**
 * 消费方本地网关（每授权服务一个独立 127.0.0.1 listener）。
 * @param {{ session: import("./sessions.mjs").ReturnType<typeof createConsumerSession>, log?: (level: "info" | "warn" | "error", msg: string) => void }} opts
 */
export function createConsumerGateway(opts) {
  const log = opts.log ?? (() => {});
  /** @type {Map<string, { server: http.Server, serviceId: string, port: number }>} */
  const listeners = new Map();
  let stopped = false;

  /**
   * 读本地请求体（有界 ≤maxChunkPayload——v1 单片；超限本地先拒）。
   * @param {http.IncomingMessage} req
   */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_CHUNK_PAYLOAD) {
        reject(new LocalBodyError());
        return;
      }
      const chunks = [];
      let total = 0;
      req.on("data", (c) => {
        total += c.length;
        if (total > MAX_CHUNK_PAYLOAD) {
          reject(new LocalBodyError());
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  class LocalBodyError extends Error {
    constructor() {
      super("request body exceeds maxChunkPayload");
      this.name = "LocalBodyError";
      this.code = "body_too_large";
    }
  }

  /**
   * 为一个授权服务起本地 listener（端口冲突=真实 listen 错误，不静默换端口）。
   * @param {{ serviceId: string, name: string, port: number, routes: Array<{ localPrefix: string, upstreamPrefix: string }>, keyId: string }} input
   * @returns {Promise<{ port: number, close: () => Promise<void> }>}
   */
  function startService(input) {
    if (stopped) return Promise.reject(new Error("gateway is stopped"));
    if (listeners.has(input.serviceId)) {
      return Promise.reject(new Error(`local endpoint for service ${input.serviceId} is already running`));
    }
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void handleLocal(req, res, input);
      });
      // WS v1 显式拒绝（design §8；零上游触达）
      server.on("upgrade", (_req, socket) => rejectUpgrade(/** @type {import("node:net").Socket} */ (socket)));
      server.once("error", (err) => {
        reject(new Error(`cannot listen on 127.0.0.1:${input.port} for service '${input.name}' (${input.serviceId}): ${err.code ?? err.message} - pick another port (no silent fallback)`));
      });
      server.listen(input.port, LOOPBACK_HOST, () => {
        listeners.set(input.serviceId, { server, serviceId: input.serviceId, port: input.port });
        resolve({
          port: input.port,
          close: () =>
            new Promise((resClose) => {
              server.closeAllConnections?.();
              server.close(() => {
                listeners.delete(input.serviceId);
                resClose(undefined);
              });
            }),
        });
      });
    });
  }

  /**
   * 本地请求处理：过滤头→白名单映射→session.forward→逐块 flush。
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handleLocal(req, res, input) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const localPath = url.pathname;
    const mapped = mapRoute(input.routes, localPath);
    /** @type {AbortController | null} */
    const abortCtrl = new AbortController();
    /** @type {{ rid?: string, epoch?: string }} */
    const wire = {};
    res.on("close", () => {
      if (!res.writableEnded) {
        // 取消双向传播：本地断开→abort 在途拉取+cancel 端点→上游 abort
        abortCtrl.abort();
        if (wire.rid !== undefined && wire.epoch !== undefined) {
          opts.session.cancel({ keyId: input.keyId, rid: wire.rid, epoch: wire.epoch }).catch(() => undefined);
        }
      }
    });
    const reply = (status, code, message, extraHeaders = {}) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const body = Buffer.from(JSON.stringify(openAiErrorBody(status, code, message)));
      res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
      res.end(body);
    };
    try {
      if (mapped === null) {
        reply(404, "path_not_offered", `path ${localPath} is not offered by this service`);
        return;
      }
      const { headers, contentType } = filterRequestHeaders(req.headers);
      const body = await readBody(req);
      const upstreamPath = url.search === "" ? mapped.upstreamPath : `${mapped.upstreamPath}${url.search}`;
      await opts.session.forward(
        {
          keyId: input.keyId,
          serviceId: input.serviceId,
          method: req.method ?? "GET",
          path: upstreamPath,
          headers,
          ...(contentType !== undefined ? { contentType } : {}),
          ...(body.length > 0 ? { body } : {}),
          signal: abortCtrl.signal,
        },
        {
          onMeta(meta) {
            if (res.headersSent || res.writableEnded) return;
            const outHeaders = {};
            for (const [name, value] of Object.entries(meta.headers ?? {})) {
              if (name === "content-length" || name === "transfer-encoding" || name === "connection") continue;
              outHeaders[name] = String(value);
            }
            res.writeHead(meta.status, outHeaders);
            res.flushHeaders?.(); // 首块立发（头即到达）
          },
          onStarted(handle) {
            wire.rid = handle.responseId;
            wire.epoch = handle.epoch;
          },
          onChunk(chunk) {
            if (res.writableEnded || res.destroyed) return;
            res.write(chunk); // 逐块 flush（上游块边界即到即发——≤min(256KiB|50ms|块边界)）
          },
          onEnd() {
            if (!res.writableEnded) res.end();
          },
          onError(err) {
            // 分族：提供方不可用族（A 停用/离线）→ 502 upstream_unreachable
            // 明确码+固定脱敏文案（Phase D 顺手项）；其余按 localErrorStatus。
            const classified = classifyLocalError(err);
            reply(classified.status, classified.code, classified.message);
          },
        },
      );
    } catch (err) {
      if (err instanceof LocalBodyError) {
        reply(413, "body_too_large", err.message);
        return;
      }
      log("error", `ai gateway: local handler failure: ${err instanceof Error ? err.message : String(err)}`);
      reply(502, "internal", "local gateway failure");
    }
  }

  /** 全部 listener 关闭（dispose 面——显式回收）。 */
  async function close() {
    stopped = true;
    const closes = [...listeners.values()].map(
      (l) =>
        new Promise((resolve) => {
          l.server.closeAllConnections?.();
          l.server.close(() => resolve(undefined));
        }),
    );
    listeners.clear();
    await Promise.all(closes);
  }

  return { startService, close, listenerCount: () => listeners.size };
}
