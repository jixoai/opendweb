// ports 消费侧：本机 listener + 逐请求代理（webui-plugin-kernel Phase 1 /
// design §4/§5、specs/plugins/ports 全部 Scenario）。
// 意图（2026-09-29）：
// 1. 映射 listener：node:http server，仅绑定 127.0.0.1（v1 唯一形态；0.0.0.0
//    属后续独立裁决——spec 冻结）；端口冲突 EADDRINUSE=明确报错，不静默换端口。
// 2. 逐请求代理：method/path/headers 透传（hop-by-hop 剥除清单冻结于 headers.mjs；
//    host 重写为 localhost:<remotePort> 直连语义；content-length 按缓冲后实际
//    字节重算——/http 请求体=静态分块 Array<Uint8Array>，须先有界缓冲）→
//    fetchHttp(session, {path:"/wpk1/ports/proxy/<remotePort><原始path+query>"})
//    → 响应头延迟提交（首个 body 块或干净 EOF 才 writeHead）+ 流式体回写
//    （bodyNext 逐块 pull，SSE 不缓冲）。体传输失败绝不允许伪装干净 200：
//    头未外显→502 upstream-body-lost；头已外显→销毁连接（传输失败形态）。
// 3. 两阶段取消（design §4 r2-B1 冻结协议，按 /http 实际面实现）：
//    - 阶段 A（响应头等待期）：本机下游断开 → 请求 AbortController.abort() →
//      fetchHttp request.signal（头等待期取消键仍注册）→ 即时 RESET → 对端
//      provider request.signal 触发；
//    - 阶段 B（响应体传输期）：请求 signal 的取消键在响应头返回后已注销——
//      本机下游断开 MUST 调响应句柄 abort()（HttpClientResponse.abort → RESET
//      → provider signal + 上游 socket 收敛）；
//    - 取消路径一律静默收敛（客户端已断，无响应面）。
// 4. 限额（[W7] 硬域，r8-B4 收窄）：默认 1MiB，配置域 64KiB–1MiB、64KiB 粒度
//    （超范围由 runtime 拒启映射——v1 有效包络=min(插件预算, transport 实况)
//    =1MiB 帧（session.rs MAX_FRAME）；不得允许必然失败的配置）；
//    已知 Content-Length 超限 → 413 零转发；未知长度边读边累计、达上限立即断开
//    （不先缓冲后判）；并发 ≤16 在飞（429 拒新直至回落），在飞字节预算=16×上限
//    （已知长度入场检查+未知长度逐请求上限联立保证 ≤16×上限）。
// 5. WS/raw TCP 不透传（v1 冻结——面板「即将推出」）；upgrade 头在剥除清单内。

import http from "node:http";
import { forwardRequestHeaders, forwardResponseHeaders, nodeHeadersToArray, arrayHeadersToNode } from "./headers.mjs";

/** 默认请求体上限（MiB）——[W7]；r8-B4：v1 有效包络=min(插件预算, transport
 * 实况)=1MiB（fabric session MAX_FRAME=1MiB——更大默认在真实网络上必然失败） */
export const DEFAULT_MAX_BODY_MIB = 1;
/** 配置域硬边界（MiB）：[0.0625, 1]＝64KiB–1MiB（transport 可容纳域；超出=必然
 * 失败配置，配置期拒绝——r8-B4 裁定，替代旧 [1,64] 域） */
export const MIN_CONFIG_MIB = 0.0625;
export const MAX_CONFIG_MIB = 1;
/** 配置粒度（字节）：64KiB 整数倍（0.0625 MiB 步进） */
export const CONFIG_GRANULARITY_BYTES = 64 * 1024;
/** 并发代理上限（在飞请求数）——design §4 冻结 */
export const MAX_CONCURRENT_PROXIES = 16;
/** 映射级停用/进程 dispose 的在途 drain 默认超时（宿主 DRAIN_TIMEOUT_MS 同拍） */
export const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 10;

const MIB = 1024 * 1024;

/**
 * 配置域校验（r8-B4 收窄）：maxBodyMiB 解析为字节后须落在 [64KiB, 1MiB] 且为
 * 64KiB 整数倍（超范围/非粒度=必然失败配置，拒绝——由 runtime 拒启映射）。
 * @param {number} maxBodyMiB
 * @returns {{ ok: true, bytes: number } | { ok: false, error: string }}
 */
export function resolveLimitBytes(maxBodyMiB) {
  const bad = (why) => ({ ok: false, error: `maxBodyMiB ${why}; the v1 transport envelope admits 64KiB–1MiB in 64KiB steps (fabric session MAX_FRAME = 1MiB — larger limits deterministically fail on the real transport); mappings are not started (got ${JSON.stringify(maxBodyMiB)})` });
  if (typeof maxBodyMiB !== "number" || !Number.isFinite(maxBodyMiB)) return bad("must be a finite number");
  const bytes = maxBodyMiB * MIB;
  if (bytes < MIN_CONFIG_MIB * MIB || bytes > MAX_CONFIG_MIB * MIB) return bad("is outside the [0.0625, 1] MiB (64KiB–1MiB) hard range");
  if (bytes % CONFIG_GRANULARITY_BYTES !== 0) return bad("must be a multiple of 64KiB (0.0625 MiB)");
  return { ok: true, bytes };
}

/** @param {number} ms @returns {Promise<void>} */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 并发预算（design §4：并发 ≤16、在飞字节=16×上限；超预算拒新直至回落）。
 * 字节不变式：已知长度入场检查 + 未知长度逐请求上限（≤limitBytes）联立 ⇒
 * 在飞字节恒 ≤ 16×limitBytes（未知长度请求按 0 入账、读体完成后回填真实值）。
 * @param {{ maxCount?: number, maxBytes: number }} opts
 */
export function createProxyBudget({ maxCount = MAX_CONCURRENT_PROXIES, maxBytes }) {
  let count = 0;
  let bytes = 0;
  return {
    get count() {
      return count;
    },
    get bytes() {
      return bytes;
    },
    get maxCount() {
      return maxCount;
    },
    get maxBytes() {
      return maxBytes;
    },
    /**
     * @param {number | null} knownBytes 已知 Content-Length（null=未知，按 0 入账）
     * @returns {{ setBytes: (n: number) => void, release: () => void } | null} null=超预算（429）
     */
    tryAcquire(knownBytes) {
      const initial = knownBytes ?? 0;
      if (count + 1 > maxCount) return null;
      if (bytes + initial > maxBytes) return null;
      count += 1;
      bytes += initial;
      let current = initial;
      let released = false;
      return {
        setBytes(n) {
          bytes += n - current;
          current = n;
        },
        release() {
          if (released) return;
          released = true;
          count -= 1;
          bytes -= current;
        },
      };
    },
  };
}

/**
 * 在途活动登记（映射级停用与进程 dispose 的 drain/强制取消面）。
 */
export function createInFlightRegistry() {
  /** @type {Set<{ mappingId: string, cancel: () => void }>} */
  const set = new Set();
  return {
    get size() {
      return set.size;
    },
    /**
     * @param {{ mappingId: string, cancel: () => void }} handle
     * @returns {{ end: () => void }} end 幂等
     */
    begin(handle) {
      set.add(handle);
      let ended = false;
      return {
        end: () => {
          if (ended) return;
          ended = true;
          set.delete(handle);
        },
      };
    },
    /** @param {string} [mappingId] 只取消该映射的在途（缺省=全部） */
    cancelAll(mappingId) {
      for (const h of [...set]) {
        if (mappingId !== undefined && h.mappingId !== mappingId) continue;
        try {
          h.cancel();
        } catch {
          /* 持有者异常不得阻塞批量取消 */
        }
      }
    },
    /** @param {string} [mappingId] */
    countFor(mappingId) {
      let n = 0;
      for (const h of set) if (mappingId === undefined || h.mappingId === mappingId) n += 1;
      return n;
    },
  };
}

/**
 * @param {string | string[] | undefined} v
 * @returns {number | null | "invalid"} Content-Length 字节数（无头=null；非法="invalid"）
 */
function parseContentLength(v) {
  if (v === undefined) return null;
  const s = Array.isArray(v) ? v[0] : v;
  if (!/^\d+$/.test(String(s))) return "invalid";
  return Number(s);
}

/**
 * 未知/已知长度统一的有界读体：边读边累计，累计超上限立即销毁 socket（未知
 * 长度的「不先缓冲后判」语义；已知长度超限在调用前已 413，此处兜底防说谎头）。
 * 客户端中断（error/aborted/close）一律按 ECLIENTGONE 结算——不转发部分体。
 * @param {http.IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<{ chunks: Uint8Array[], total: number }>} 超限抛
 *   code="EBODYLIMIT"（socket 已销毁）；客户端中断抛 code="ECLIENTGONE"
 */
/** 单帧 payload 上限（transport 事实：fabric session.rs MAX_FRAME=1MiB——r8-B4） */
const TRANSPORT_MAX_FRAME_BYTES = MIB;

/**
 * 请求体分块再切：保证每个元素 ≤1MiB（fetch_http 逐元素单帧发送；超限帧在
 * 真实 transport 上确定性失败）。总量已由 limitBytes 有界——此为逐元素防线。
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array[]}
 */
function rechunkForFrames(chunks) {
  /** @type {Uint8Array[]} */
  const out = [];
  for (const c of chunks) {
    if (c.byteLength <= TRANSPORT_MAX_FRAME_BYTES) {
      out.push(c);
      continue;
    }
    for (let off = 0; off < c.byteLength; off += TRANSPORT_MAX_FRAME_BYTES) {
      out.push(c.subarray(off, Math.min(off + TRANSPORT_MAX_FRAME_BYTES, c.byteLength)));
    }
  }
  return out;
}

function readBoundedBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let settled = false;
    // 只以 settled 旗守卫重复结算——不用 removeAllListeners（会误伤 Node 内部
    // 监听器；settled 后事件全部 no-op，监听器随 req 一起回收）
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (/** @type {Buffer} */ chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limitBytes) {
        // 立即断开拒绝（spec：达上限立即断开，不先缓冲后判）
        req.socket.destroy();
        const err = new Error(`request body exceeds mapping limit (${limitBytes} bytes)`);
        err.code = "EBODYLIMIT";
        finish(() => reject(err));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(() => resolve({ chunks, total })));
    req.on("error", (e) => finish(() => reject(clientGoneError(e))));
    req.on("aborted", () => finish(() => reject(clientGoneError())));
    req.on("close", () => finish(() => reject(clientGoneError())));
  });
}

/** @param {Error} [cause] */
function clientGoneError(cause) {
  const err = new Error(`local client request stream terminated${cause ? `: ${cause.message}` : ""}`);
  err.code = "ECLIENTGONE";
  return err;
}

/**
 * JSON 错误响应 + 发送后断开（connection: close；避免未消费请求体滞留 keep-alive
 * 连接——Node 对未读完 body 的连接会自毁，此处显式化保证确定性）。
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {{ code: string, message: string }} error
 */
function respondJsonAndClose(res, status, error) {
  if (res.headersSent || res.destroyed) return;
  res.setHeader("connection", "close");
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error }), () => {
    res.socket?.destroy();
  });
}

/**
 * 代理路径：/wpk1/ports/proxy/<remotePort><原始 path+query>（版本化前缀 wpk1，
 * design §3.2；原始路径原样保留——B:9090/foo ≡ A:8080/foo）。
 * @param {number} remotePort
 * @param {string} requestUrl
 */
export function proxyPath(remotePort, requestUrl) {
  const suffix = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  return `/wpk1/ports/proxy/${remotePort}${suffix}`;
}

/**
 * 消费侧请求头：冻结 hop-by-hop 剥除 + host 重写（直连语义 localhost:<remotePort>）
 * + content-length 按缓冲后实际字节重算（原请求带 body 指示头时）。
 * @param {Record<string, string | string[] | undefined>} nodeHeaders
 * @param {number} remotePort
 * @param {number} total 缓冲后请求体字节数
 * @param {boolean} hadBodyIndication 原请求含 content-length/transfer-encoding
 * @returns {Array<{name: string, value: string}>}
 */
export function buildFetchRequestHeaders(nodeHeaders, remotePort, total, hadBodyIndication) {
  const headers = forwardRequestHeaders(nodeHeadersToArray(nodeHeaders));
  const out = [];
  let hasHost = false;
  for (const h of headers) {
    const n = h.name.toLowerCase();
    if (n === "host") {
      if (!hasHost) {
        hasHost = true;
        out.push({ name: "host", value: `localhost:${remotePort}` }); // 直连语义
      }
      continue;
    }
    if (n === "content-length") continue; // 重算（见下）
    out.push(h);
  }
  if (!hasHost) out.unshift({ name: "host", value: `localhost:${remotePort}` });
  if (hadBodyIndication || total > 0) out.push({ name: "content-length", value: String(total) });
  return out;
}

/**
 * 单个映射的本机 listener（仅 127.0.0.1）。
 * @param {{
 *   mapping: import("./ledger.mjs").PortsMapping,
 *   limitBytes: number,
 *   budget: ReturnType<typeof createProxyBudget>,
 *   inflight: ReturnType<typeof createInFlightRegistry>,
 *   fetchHttpImpl: (session: unknown, request: { method: string, path: string, headers?: Array<{name: string, value: string}>, body?: Array<Uint8Array> | null, signal?: AbortSignal }) => Promise<{ status: number, headers: Array<{name: string, value: string}>, bodyNext: () => Promise<Buffer | null>, abort?: () => Promise<void> | void }>,
 *   sessionResolver: (peer: string) => unknown | null | Promise<unknown | null>,
 *   now?: () => number,
 *   log?: (level: "info" | "warn" | "error", msg: string) => void,
 *   drainTimeoutMs?: number,
 * }} opts
 */
export function createMappingServer(opts) {
  const { mapping, limitBytes, budget, inflight, fetchHttpImpl, sessionResolver } = opts;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const drainTimeoutMs = opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;

  /** @type {"stopped" | "listening" | "failed" | "stopping"} */
  let state = "stopped";
  /** @type {string | null} */
  let lastError = null;
  /** @type {http.Server | null} */
  let server = null;

  async function handle(req, res) {
    // 两阶段取消状态机（B1 冻结协议的 /http 实现面）。close 监听在 handle 入口
    // 即注册——防「读体/解析会话窗口内客户端断开」漏事件（listener 后挂会错过
    // close，fetch 悬挂到头超时）。
    /** @type {AbortController | null} */
    let controller = null;
    /** @type {{ abort?: () => Promise<void> | void } | null} */
    let fetchResp = null;
    let phase = "init"; // init → head → body → done/cancelled
    let clientGone = false; // init 阶段断开（fetch 前置检查）
    const onLocalGone = () => {
      if (res.writableFinished) return; // 正常完成后的 close：无事可做
      if (phase === "head") {
        controller?.abort(); // 阶段 A：请求 signal → 即时 RESET
      } else if (phase === "body") {
        phase = "cancelled";
        void Promise.resolve(fetchResp?.abort?.()).catch(() => {}); // 阶段 B：响应句柄 abort → RESET
      } else {
        clientGone = true; // init（fetch 未发起）/收尾竞态窗口
      }
    };
    res.on("close", onLocalGone);
    const cancelHandle = {
      mappingId: mapping.id,
      cancel: () => {
        // drain 超时后的强制取消：两阶段各自的取消原语 + 本机 socket 兜底
        if (phase === "head") controller?.abort();
        else if (phase === "body") {
          phase = "cancelled";
          void Promise.resolve(fetchResp?.abort?.()).catch(() => {});
        }
        res.socket?.destroy();
      },
    };
    const activity = inflight.begin(cancelHandle);
    /** @type {{ setBytes: (n: number) => void, release: () => void } | null} */
    let ticket = null;
    try {
      const contentLength = parseContentLength(req.headers["content-length"]);
      if (contentLength === "invalid") {
        respondJsonAndClose(res, 400, { code: "invalid-content-length", message: "content-length header is not a valid byte count" });
        return;
      }
      // 已知长度超限：413 + 零转发（spec Scenario「已知长度超限拒绝」）
      if (contentLength !== null && contentLength > limitBytes) {
        respondJsonAndClose(res, 413, {
          code: "body-too-large",
          message: `request body of ${contentLength} bytes exceeds the mapping limit of ${limitBytes} bytes; zero bytes were forwarded`,
        });
        return;
      }
      // 并发预算：超额 429 直至在飞回落（spec Scenario「并发预算与配置硬域」）
      ticket = budget.tryAcquire(contentLength);
      if (ticket === null) {
        respondJsonAndClose(res, 429, {
          code: "concurrency-budget-exhausted",
          message: `ports proxy budget exhausted (${budget.maxCount} in-flight requests / ${budget.maxBytes} bytes); retry when in-flight requests settle`,
        });
        return;
      }
      // 有界读体（未知长度边读边累计、达上限立即断开）
      let chunks;
      let total;
      try {
        const body = await readBoundedBody(req, limitBytes);
        chunks = body.chunks;
        total = body.total;
        ticket.setBytes(total);
      } catch (e) {
        // EBODYLIMIT=socket 已断开（零转发）；ECLIENTGONE=客户端中断——均无响应面
        return;
      }
      if (clientGone || res.writableEnded || res.destroyed) return; // 读体期间客户端已断：零转发
      // r8-B4 帧包络防线：fetch_http 把每个 Uint8Array 元素作为单个 DATA 帧发送
      // （fabric session MAX_FRAME=1MiB）——Node 读体 chunk 通常 ≤64KiB，但此处
      // 对逐元素做确定性 ≤1MiB 再分块（总量已被 limitBytes ≤1MiB 有界）。
      chunks = rechunkForFrames(chunks);
      // 会话解析（fabric 会话不可得 → 502 明确错误）
      const session = await sessionResolver(mapping.peer);
      if (session == null) {
        respondJsonAndClose(res, 502, { code: "peer-unavailable", message: `no active fabric session to peer ${mapping.peer} (mapping "${mapping.name}")` });
        return;
      }
      // 阶段 A：请求 signal（头等待期取消键注册中）
      controller = new AbortController();
      phase = "head";
      const hadBodyIndication = req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined;
      const headers = buildFetchRequestHeaders(req.headers, mapping.remotePort, total, hadBodyIndication);
      /** @type {{ status: number, headers: Array<{name: string, value: string}>, bodyNext: () => Promise<Buffer | null>, abort?: () => Promise<void> | void }} */
      let resp;
      try {
        resp = await fetchHttpImpl(session, {
          method: req.method,
          path: proxyPath(mapping.remotePort, req.url ?? "/"),
          headers,
          body: total > 0 ? chunks : null,
          signal: controller.signal,
        });
      } catch (e) {
        if (controller.signal.aborted || res.destroyed || res.writableEnded) return; // 阶段 A 取消：静默收敛
        log("warn", `ports mapping ${mapping.id} fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        respondJsonAndClose(res, 502, { code: "upstream-unreachable", message: `proxied request to peer ${mapping.peer}:${mapping.remotePort} failed: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      if (res.destroyed || res.writableEnded) {
        // 头返回时本机已断（竞态窗口）：阶段 B 语义取消对端在途流
        void Promise.resolve(resp.abort?.()).catch(() => {});
        return;
      }
      if (!Number.isInteger(resp.status) || resp.status < 100 || resp.status > 599) {
        respondJsonAndClose(res, 502, { code: "bad-upstream-status", message: `peer returned an invalid status ${JSON.stringify(resp.status)}` });
        return;
      }
      // 阶段 B：响应头已回——请求 signal 取消键已注销，此后取消走响应句柄 abort()
      fetchResp = resp;
      phase = "body";
      // 响应头延迟提交（真双机实证 2026-09-30：会话翻转/对端取消的截断流曾以
      // 「200+空/截断体」外显——ports 等价性承诺：要么成功有体、要么明确失败）：
      // 首个 body 块到达或干净 EOF 才 writeHead——体失败发生在头未落本地前时
      // 仍可回 5xx。SSE 首事件随首块即时透传（不缓冲）。
      let headSent = false;
      const sendHead = () => {
        if (headSent || res.destroyed || res.writableEnded) return;
        headSent = true;
        res.writeHead(resp.status, arrayHeadersToNode(forwardResponseHeaders(resp.headers ?? [])));
      };
      let bodyFailed = false;
      // 流式回写（bodyNext pull-first——SSE 逐事件透传，不缓冲）
      for (;;) {
        let chunk;
        try {
          chunk = await resp.bodyNext();
        } catch {
          bodyFailed = true; // 传输失败（RESET/会话终态/本端 abort）——不是干净 EOF
          break;
        }
        if (chunk === null) break; // 干净 EOF（对端 FIN）
        if (res.destroyed || res.writableEnded) break;
        sendHead(); // 首块即提交头
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            res.once("drain", resolve);
            res.once("close", resolve);
            res.once("error", resolve);
          });
        }
      }
      if (bodyFailed) {
        if (!headSent && !res.headersSent) {
          // 头未外显：明确 5xx——空/截断响应绝不允许以 200 形态外显
          log("warn", `ports mapping ${mapping.id} body transfer failed (status ${resp.status} never surfaced)`);
          respondJsonAndClose(res, 502, {
            code: "upstream-body-lost",
            message: `proxied response body to peer ${mapping.peer}:${mapping.remotePort} was terminated mid-transfer before any body byte; the upstream response (status ${resp.status}) was not delivered`,
          });
          return;
        }
        // 头已外显（HTTP 状态行无法改写）：销毁连接——客户端见到传输失败，
        // 而不是把截断体当作完整 200
        log("warn", `ports mapping ${mapping.id} body transfer failed after head; destroying local connection`);
        res.destroy();
        return;
      }
      sendHead(); // 干净 EOF 且零体（合法空响应）：此刻提交头
      // 流式回写完成（writableFinished 置位——close 监听据此分辨正常收尾）
      if (!res.destroyed && res.writable) res.end();
    } catch (e) {
      // 防御：handle 内部异常不给客户端挂死
      log("error", `ports mapping ${mapping.id} request handler error: ${e instanceof Error ? e.message : String(e)}`);
      respondJsonAndClose(res, 500, { code: "proxy-internal-error", message: "ports proxy request handler failed" });
    } finally {
      ticket?.release();
      activity.end();
    }
  }

  return {
    get mapping() {
      return mapping;
    },
    get state() {
      return state;
    },
    get error() {
      return lastError;
    },
    /** 本映射在途请求数 */
    get inFlight() {
      return inflight.countFor(mapping.id);
    },
    /**
     * 起监听（仅 127.0.0.1）。端口冲突=明确报错，绝不静默换端口。
     * @returns {Promise<{ ok: true } | { ok: false, code: "port-in-use" | "listen-failed" | "invalid-state", error: string }>}
     */
    async start() {
      if (state === "listening" || state === "stopping") return { ok: false, code: "invalid-state", error: `mapping listener is ${state}` };
      const s = http.createServer((req, res) => {
        void handle(req, res);
      });
      server = s;
      const outcome = await new Promise((resolve) => {
        s.once("error", (e) => {
          const err = /** @type {NodeJS.ErrnoException} */ (e);
          const message =
            err.code === "EADDRINUSE"
              ? `local port ${mapping.localPort} is already in use (EADDRINUSE); mapping "${mapping.name}" is NOT started and no alternative port was bound`
              : `cannot listen on 127.0.0.1:${mapping.localPort}: ${err.message ?? err.code}`;
          resolve({ ok: false, code: err.code === "EADDRINUSE" ? "port-in-use" : "listen-failed", error: message });
        });
        // 仅回环绑定（v1 冻结；非 loopback 监听需本地鉴权设计，属后续裁决）
        s.listen(mapping.localPort, "127.0.0.1", () => resolve({ ok: true }));
      });
      if (!outcome.ok) {
        state = "failed";
        lastError = outcome.error;
        server = null;
        s.close(() => {}); // 未 listen 成功的句柄防御性释放（幂等，无回调错误外泄）
        return outcome;
      }
      s.on("error", (e) => {
        log("error", `ports mapping ${mapping.id} server error: ${e instanceof Error ? e.message : String(e)}`);
      });
      state = "listening";
      lastError = null;
      return { ok: true };
    },
    /**
     * 停监听：拒新（close）→ 在途有界 drain → 超时强制取消（两阶段原语+socket
     * 兜底）→ 全连接拆除。幂等。
     */
    async stop() {
      if (state === "stopped" || state === "failed" || server === null) {
        state = "stopped";
        return;
      }
      state = "stopping";
      const s = server;
      const closed = new Promise((resolve) => s.close(() => resolve(undefined)));
      s.closeIdleConnections?.();
      const deadline = now() + drainTimeoutMs;
      while (inflight.countFor(mapping.id) > 0 && now() < deadline) await delay(DRAIN_POLL_MS);
      if (inflight.countFor(mapping.id) > 0) inflight.cancelAll(mapping.id);
      s.closeAllConnections?.();
      await closed;
      server = null;
      state = "stopped";
    },
  };
}
