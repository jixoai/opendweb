// ports 提供侧：/wpk1/ports/proxy/<port> 数据端点（webui-plugin-kernel Phase 1 /
// design §3.2/§5、specs/plugins/ports「授权默认拒绝」Scenario）。
// 意图（2026-09-29）：
// 1. serveHttp handler 工厂（编排者接线：serveHttp(fabric, peerId,
//    createPortsProxyHandler({ home, peer: peerId }))——serveHttp 按 peer 绑定，
//    peer 身份即本工厂入参；request.sessionId 为隔离键（/http 既有注释语义：
//    同 peer 异 session 不继承任何状态——本 handler 无跨请求会话状态，逐请求
//    独立判定，sessionId 进日志与观测）。
// 2. 授权 deny-by-default：(peer, remotePort) 必须在 allowlist 显式授权，
//    否则 403 零转发（fabric 会话密码学身份=第一道门，allowlist=第二道门）。
// 3. 端点语义：/wpk1/ports/proxy/<remotePort><原始 path+query> → 转发
//    http://127.0.0.1:<remotePort><path>（WS/raw TCP 不透传——v1 冻结）。
//    请求体有界（§4 [W7] 纵深防御：已知长度超限 413；未知长度边拉边累计、
//    超限停拉 413——消费侧已限，双保险）；零转发=上游 socket 从未建立。
// 4. 取消传播：request.signal（对端 RESET/会话终态遗弃）→ 上游请求 destroy
//    （上游 socket 收敛——spec 断言面）+ 下游 writer.abort()（显式 RESET——
//    上游被取消掐断的截断响应不得伪装干净 EOF）；流式 write 错误（对端已弃）
//    同样收敛。
// 5. 响应流式：上游响应头一到即 respondStreaming（SSE 首包早发），body 逐块
//    write（有界背压：上游 pause/resume 传导消费速度）；hop-by-hop 剥除+敏感
//    回显重写（headers.mjs 冻结清单；content-length 剥除——fabric 体无可靠长度）。

import http from "node:http";
import { headerValue, forwardRequestHeaders, forwardResponseHeaders, nodeHeadersToArray, arrayHeadersToNode } from "./headers.mjs";
import { isAccessAllowed, isValidPort } from "./ledger.mjs";
import { DEFAULT_MAX_BODY_MIB, resolveLimitBytes } from "./proxy.mjs";

/** 端点路径（design §3.2 版本化前缀 wpk1） */
export const PROXY_PATH_PREFIX = "/wpk1/ports/proxy/";
const PROXY_PATH_RE = /^\/wpk1\/ports\/proxy\/(\d{1,5})(\/.*)?$/;

/**
 * 解析端点路径 → { remotePort, upstreamPath }；不匹配返回 null。
 * @param {string} requestPath
 * @returns {{ remotePort: number, upstreamPath: string } | null}
 */
export function parseProxyPath(requestPath) {
  const m = PROXY_PATH_RE.exec(requestPath);
  if (m === null) return null;
  const remotePort = Number(m[1]);
  if (!isValidPort(remotePort)) return null;
  return { remotePort, upstreamPath: m[2] ?? "/" };
}

/**
 * 提供侧 handler 工厂（serveHttp 接线面）。
 * @param {{
 *   home: string,
 *   peer: string,
 *   maxBodyMiB?: number,
 *   now?: () => number,
 *   log?: (level: "info" | "warn" | "error", msg: string) => void,
 * }} opts
 * @returns {(req: HttpHandlerRequestLike) => Promise<HttpHandlerResponseLike | null | void>}
 */
export function createPortsProxyHandler(opts) {
  const { home, peer } = opts;
  const log = opts.log ?? (() => {});
  const limit = resolveLimitBytes(opts.maxBodyMiB ?? DEFAULT_MAX_BODY_MIB);
  if (!limit.ok) throw new Error(`createPortsProxyHandler: ${limit.error}`);
  const limitBytes = limit.bytes;

  /** 静态 JSON 错误响应（未进入流式结算路径统一走它） */
  const errorResponse = (status, code, message) => ({
    status,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyChunks: [Buffer.from(JSON.stringify({ error: { code, message } }))],
  });

  return async function portsProxyHandler(req) {
    if (req.signal.aborted) return null; // 对端已取消：无响应面
    const parsed = parseProxyPath(req.path);
    if (parsed === null) {
      return errorResponse(404, "not-found", `ports proxy endpoint expects /wpk1/ports/proxy/<port><path>; got ${JSON.stringify(req.path)}`);
    }
    const { remotePort, upstreamPath } = parsed;
    // 授权（deny-by-default；peer=serveHttp 绑定对端；sessionId=隔离键——逐请求
    // 独立判定，无跨 session 状态继承）
    let allowed;
    try {
      allowed = await isAccessAllowed(home, peer, remotePort);
    } catch (e) {
      log("error", `ports allowlist read failed: ${e instanceof Error ? e.message : String(e)}`);
      return errorResponse(500, "allowlist-unavailable", "ports allowlist ledger cannot be read; access denied");
    }
    if (!allowed) {
      // 零转发：上游从未连接（spec「授权默认拒绝」）
      log("warn", `ports proxy denied peer=${peer} session=${req.sessionId} port=${remotePort}`);
      return errorResponse(403, "access-denied", `peer ${peer} is not allowed to access port ${remotePort}; grant it in the ports allowlist first`);
    }
    // 请求体（pull-first bodyNext）：已知长度超限 413；未知长度边拉边累计
    const contentLengthHeader = headerValue(req.headers ?? [], "content-length");
    if (contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader) && Number(contentLengthHeader) > limitBytes) {
      return errorResponse(413, "body-too-large", `request body of ${Number(contentLengthHeader)} bytes exceeds the provider limit of ${limitBytes} bytes; zero bytes were forwarded`);
    }
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let overLimit = false;
    for (;;) {
      let chunk;
      try {
        chunk = await req.bodyNext();
      } catch {
        return null; // 拉取失败（会话终态）：对端已弃，无响应面
      }
      if (chunk === null) break;
      total += chunk.length;
      if (total > limitBytes) {
        overLimit = true;
        break; // 停拉 + 零转发
      }
      chunks.push(chunk);
    }
    if (overLimit) {
      return errorResponse(413, "body-too-large", `request body exceeded the provider limit of ${limitBytes} bytes while streaming; zero bytes were forwarded`);
    }
    if (req.signal.aborted) return null;
    // 上行头：冻结 hop-by-hop 剥除 + content-length 按实际字节重算
    const upstreamHeaders = arrayHeadersToNode(forwardRequestHeaders(req.headers ?? []));
    delete upstreamHeaders["content-length"];
    if (total > 0 || contentLengthHeader !== null) upstreamHeaders["content-length"] = String(total);

    // 转发（127.0.0.1:<remotePort>）+ 流式回写
    return await new Promise((resolve) => {
      /** @type {{ write: (chunk: Uint8Array) => Promise<void>, finish: () => void } | null} */
      let writer = null;
      let streaming = false;
      let done = false;
      /**
       * 取消传播唯一入口（对端 RESET/遗弃 → request.signal）：上游 destroy
       * （socket 收敛）+ 已开流时下游 finish。注意：已 aborted 的 signal 不会
       * 对后注册的 listener 重放事件——注册前必须显式检查（防「abort 发生在
       * http.request 建立前」的窗口漏取消）。
       */
      /**
       * 取消传播唯一入口（对端 RESET/遗弃 → request.signal）：上游 destroy
       * （socket 收敛）+ 已开流时下游 abort（向对端显式 RESET——上游被取消
       * 掐断的截断响应不得伪装干净 EOF，真双机实证 2026-09-30；无 abort 面
       * 的旧 writer 回落 finish）。注意：已 aborted 的 signal 不会对后注册的
       * listener 重放事件——注册前必须显式检查（防「abort 发生在 http.request
       * 建立前」的窗口漏取消）。
       */
      const abortUpstream = () => {
        upstreamReq.destroy(); // 上游 socket 收敛（取消传播断言面）
        if (streaming && !done) {
          done = true;
          try {
            if (typeof writer?.abort === "function") writer.abort();
            else writer?.finish();
          } catch {
            /* 通道已死 */
          }
        }
      };
      const upstreamReq = http.request(
        { host: "127.0.0.1", port: remotePort, method: req.method, path: upstreamPath, headers: upstreamHeaders },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502;
          if (!(status >= 100 && status <= 599)) {
            upstreamReq.destroy();
            resolve(errorResponse(502, "bad-upstream-status", `upstream returned an invalid status ${JSON.stringify(status)}`));
            return;
          }
          const outHeaders = forwardResponseHeaders(nodeHeadersToArray(upstreamRes.headers));
          const w = req.respondStreaming(status, outHeaders);
          if (w === null) {
            // 已结算/晚到（对端先弃）：收敛上游即可
            upstreamReq.destroy();
            resolve(null);
            return;
          }
          writer = w;
          streaming = true;
          const settleDownstream = () => {
            if (done) return;
            done = true;
            try {
              writer?.finish();
            } catch {
              /* 通道已死 */
            }
          };
          upstreamRes.on("data", (/** @type {Buffer} */ chunk) => {
            if (done) return;
            upstreamRes.pause(); // 有界背压：write 消费速度传导到上游读速
            Promise.resolve(writer?.write(chunk) ?? Promise.resolve()).then(
              () => {
                if (!done) upstreamRes.resume();
              },
              () => {
                // write 错误=对端已弃的真相面：收敛上游
                done = true;
                upstreamReq.destroy();
              },
            );
          });
          upstreamRes.on("end", settleDownstream);
          upstreamRes.on("aborted", abortUpstream);
          upstreamRes.on("error", abortUpstream);
          resolve(null); // 流式结算已发起（先到者胜——handler 返回 null 不再静态结算）
        },
      );
      upstreamReq.on("error", (e) => {
        if (streaming) {
          // 流式已开：上游错误后通道由 abortUpstream/错误面收敛，不再静态结算
          abortUpstream();
          return;
        }
        // 上游连接失败/取消（未进入响应路径）：静态 502
        resolve(errorResponse(502, "upstream-unreachable", `cannot reach localhost:${remotePort}: ${e.message}`));
      });
      if (req.signal.aborted) abortUpstream();
      else req.signal.addEventListener("abort", abortUpstream, { once: true });
      for (const chunk of chunks) upstreamReq.write(chunk);
      upstreamReq.end();
    });
  };
}

/**
 * @typedef {Object} HttpHandlerRequestLike
 * @property {number} requestId
 * @property {number} streamId
 * @property {string} sessionId 逻辑会话（隔离键）
 * @property {AbortSignal} signal 对端取消信号
 * @property {string} method
 * @property {string} path
 * @property {Array<{name: string, value: string}>} headers
 * @property {() => Promise<Buffer | null>} bodyNext
 * @property {(status: number, headers?: Array<{name: string, value: string}>) => { write: (chunk: Uint8Array) => Promise<void>, finish: () => void, abort?: () => void, finished: boolean, cancelled: boolean, closed: boolean } | null} respondStreaming
 *
 * @typedef {Object} HttpHandlerResponseLike
 * @property {number} status
 * @property {Array<{name: string, value: string}>} [headers]
 * @property {Array<Uint8Array>} [bodyChunks]
 */
