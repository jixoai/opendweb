// 本地管理 sidecar——core 运行时（webui-console design §2 / specs/webui「本地管理 sidecar」）。
// 意图（2026-09-22，webui-console Phase A；2026-09-23 server-access-roles Phase 2b 增节点簿；
// 2026-09-25 home-hub Phase 2a 迁入 src/core/ 并增事件总线/会话 capability/进程内宿主面；
// 2026-09-25 home-hub Phase 2b 增 member 姿态与本机数据面）：
// 1. 127.0.0.1 + 随机端口绑定；静态面 dist/（缺失降级占位页）+ SPA fallback；
// 2. /api/* 白名单反代：GET/POST/DELETE → /admin/*（Bearer 注入；入站 raw
//    path 独立解析 + 拼接后二次 /admin/ 断言，越界 404 且零出站）——按请求
//    开始时的 target/token 快照完成（节点切换不撕裂在途请求）；
//    member 姿态（home-hub design §4.2 row 3）：/api/* 一律 404 且零上游出站；
// 3. /sidecar/connect 配对面：一次性配对码（常时比较/10min/连败 5 次销毁）
//    + Host === 127.0.0.1:port + Origin 同源或缺失；成功即目标冻结；
//    member 姿态：不生成配对码、connect 403（member-closed）；
// 3b. /sidecar/nodes* 节点簿本地控制面（server-access-roles 版本化例外）：
//    nodesFile 注入时启用——列表/添加（独立配对码，终端打印）/切换
//    （POST /sidecar/nodes/switch {node_id}——仅已存节点，任何 URL/host 字段
//    400；进程内原子替换 target+token，无需重启）/删除（当前节点 409）。
//    响应/日志零 token（publicNode 投影）；其余 /sidecar/* 重指向仍 target-frozen；
//    member 姿态：nodes 面全部 403；
// 3c. /sidecar/session 会话 capability 引导面（home-hub 2a，design §5.1 冻结）：
//    capabilities 注册表注入即启用——GET /sidecar/session?dweb_console=<cap>
//    为一次性引导（≥128-bit、TTL 120s、绑定本实例、单次消费）；重放/过期/
//    跨实例/close 后使用=403（重放留记录行，值不入日志）；query 不落访问日志；
// 3d. /sidecar 本机数据面（home-hub 2b，design §4.2「本机数据路由」；homeDir
//    注入即启用，core/home.mjs 复用 opendweb leases.mjs 锁协议/探测）：
//    GET /sidecar/leases（投影含 expires_in）· GET /sidecar/visits ·
//    GET /sidecar/hub（hub.json 投影+接入卡片模型；无 hub.json=404）——读路由
//    沿用基线 Host 守卫（Host 精确 + Origin 同源或缺失，400 族）；
//    POST /sidecar/visits/probe · PATCH /sidecar/leases/{id}/label——写路由
//    Origin 严格策略（四类冻结：same-origin 200 / 缺失 Origin 403 / 伪造 403 /
//    坏 Host 403；基线 guard 的缺失放行不适用于新写路由）；probe 另有角色
//    守卫（r18 P1-1/裁决 #14：到访簿仅成员侧写入——非 member 姿态 403）；
// 3e. /sidecar/plugins* WebUI 插件控制面（webui-plugin-kernel Phase 0，
//    design §3.1；homeDir 注入即启用——插件宿主与运行账本跟随本机 DWEB_HOME；
//    admin/member 姿态均服务——插件宿主是设备本地运行时，与远端中枢 admin 面
//    无关）：GET /sidecar/plugins（注册表+状态+「即将推出」+外部插件标注）·
//    POST /sidecar/plugins/<id>/enable|disable · GET/PUT
//    /sidecar/plugins/<id>/config。读路由=基线 Host 守卫；写路由（enable/
//    disable/PUT config）=精确 Origin 四类。零凭证：不读 token/argv/env——
//    插件面无 capability 之外的任何秘密（spec「控制面授权与零凭证」）。
// 4. stdlib http/https.request 按解析 IP + SNI + Host 逐请求连接（agent:false
//    + 响应结束/abort 即 destroy socket）；body 界 64KiB/1MiB；10s 超时；
// 5. 日志只记 method/path/status/耗时——token 不进任何日志/响应。
// 分层（home-hub 2a）：startSidecar=对外冻结形态（返回形状零破坏）；内部
// createSidecar 返回全量句柄（controls 进程内直调面 + bus/capabilities 注入位）
// ——createConsole（core/console.mjs）即其进程内宿主。零运行时依赖（node
// 标准库）；测试经 startSidecar/createSidecar 注入 distDir/dns/now/nodesFile。

import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTarget } from "./target.mjs";
import { NodeStore, publicNode } from "./nodes.mjs";
import { createPluginHost } from "./plugins/host.mjs";
import {
  hubProjection,
  hubSnapshotSlot,
  leasesProjection,
  probeVisit,
  setLeaseLabel,
  visitsProjection,
} from "./home.mjs";

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
const API_METHODS = new Set(["GET", "POST", "DELETE", "PATCH"]);

/** scheme 默认端口（maskTarget 端口省略规则；与 target.mjs 序列化一致） */
const DEFAULT_PORTS = { http: 80, https: 443 };

/** 上游响应头白名单（其余剥除；hop-by-hop 永不透传） */
const RESPONSE_HEADER_WHITELIST = ["content-type", "etag", "last-modified"];

/** dist 缺失时的占位页（UI 未构建/发布裁剪的显式降级，测试钉住）。
 * no-referrer：会话 capability 经 URL query 引导（design §5.1）——页面与
 * 一切子资源不外发 referrer，capability 不经 Referer 头泄漏给第三方。 */
const PLACEHOLDER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>opendweb-webui</title></head>
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

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/**
 * 目标掩码（/sidecar/state 的 server_host_masked）：仅保留 scheme + 域名
 * 右侧标签 + 端口——IPv4 掩末段、域名掩首标签、IPv6 全掩、单标签全掩。
 * token 与完整 URL 永不进入该面（design §4：state 暴露面最小化）。
 * @param {{ scheme: "http" | "https", hostname: string, port: number }} t
 * @returns {string}
 */
export function maskTarget(t) {
  const host = t.hostname;
  let masked;
  if (host.includes(":")) masked = "[***]";
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) masked = `${host.split(".").slice(0, 3).join(".")}.***`;
  else {
    const labels = host.split(".");
    masked = labels.length >= 2 ? `***.${labels.slice(1).join(".")}` : "***";
  }
  const portSuffix = t.port === DEFAULT_PORTS[t.scheme] ? "" : `:${t.port}`;
  return `${t.scheme}://${masked}${portSuffix}`;
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
 * 启动 sidecar（对外冻结形态——webui-console 起 HTTP 面与 CLI 壳的既有入口，
 * home-hub 2a 分层后签名与返回形状零破坏）。
 * @param {{ target?: object | null, token?: string, port?: number, distDir?: string, log?: (line: string) => void, allowInsecure?: boolean, dns?: object, now?: () => number, nodesFile?: string | null, nodesStore?: object | null }} [opts]
 *   - target：validateTarget 成功值（给出即 ready；缺省 setup 模式）
 *   - token：admin token（内存 + 节点簿例外下的 0600 nodes.json；不落任何日志/响应）
 *   - dns/now/nodesFile/nodesStore：注入面（测试）；nodesFile 给出即启用节点簿；
 *     nodesStore 直接注入 NodeStore 实例（慢存储竞态注入用，优先于 nodesFile）
 * @returns {Promise<{ port: number, origin: string, url: string, mode: () => "setup" | "ready", pairingCode: string | null, nodePairingCode: () => string | null, close: () => Promise<void> }>}
 */
export async function startSidecar(opts = {}) {
  const s = await createSidecar(opts);
  return {
    port: s.port,
    origin: s.origin,
    url: s.url,
    mode: s.mode,
    pairingCode: s.pairingCode,
    nodePairingCode: s.nodePairingCode,
    close: s.close,
  };
}

/**
 * sidecar 全量内部句柄（home-hub 2a）：createConsole 的进程内宿主消费——
 * controls.switchNode=进程内切换（不经 HTTP）、controls.snapshot=同步快照。
 * @param {{ target?: object | null, token?: string, port?: number, distDir?: string, log?: (line: string) => void, allowInsecure?: boolean, dns?: object, now?: () => number, nodesFile?: string | null, nodesStore?: object | null, bus?: import("./events.mjs").EventBus | null, capabilities?: import("./capability.mjs").CapabilityRegistry | null, member?: boolean, hubLocal?: boolean, homeDir?: string | null, hostname?: string, interfaces?: object | null, homeFetch?: typeof fetch, homeIsPidAlive?: (pid: number) => boolean }} [opts]
 *   - bus：事件总线注入（schema v1 帧派发；缺省 null=不发事件，既有行为不变）
 *   - capabilities：会话 capability 注册表注入（启用 /sidecar/session 引导面）
 *   - member（home-hub 2b design §4.2 row 3）：member 姿态——不生成配对码、
 *     connect/nodes 403、/api/* 404 零出站；仅服务租约/到访数据面与静态 SPA
 *   - hubLocal：row 2 标记（/sidecar/state.hub_local 与快照；hub 本机自动形态）
 *   - homeDir：DWEB_HOME（注入即启用 /sidecar 本机数据面——leases/visits/hub/
 *     probe/label；core/home.mjs）
 *   - hostname/interfaces/homeFetch/homeIsPidAlive/homeProbeTimeoutMs：hub 投影
 *     与锁协议/探测注入面（测试）
 * @returns {Promise<SidecarHandle>}
 */
export async function createSidecar(opts = {}) {
  const {
    target = null,
    token = "",
    port = 0,
    distDir = path.join(pkgRoot, "dist"),
    log = () => {},
    allowInsecure = false,
    dns,
    now = () => Date.now(),
    nodesFile = null,
    nodesStore = null,
    bus = null,
    capabilities = null,
    member = false,
    hubLocal = false,
    homeDir = null,
    hostname,
    interfaces = null,
    homeFetch,
    homeIsPidAlive,
    homeProbeTimeoutMs,
    pluginsHost,
  } = opts;
  if (target && (typeof token !== "string" || token === "")) {
    throw new Error("startSidecar: target requires a token");
  }
  const distRoot = path.resolve(distDir);

  /** 节点簿存储（nodesFile/nodesStore 注入即启用；损坏/symlink = fail-fast 拒启） */
  const nodes = nodesStore ?? (nodesFile === null ? null : new NodeStore(path.resolve(nodesFile)));
  if (nodes !== null) await nodes.load();

  /** 目标生命周期状态机：setup → ready（运行期重指向仅 /sidecar/nodes/switch 例外） */
  const state = {
    mode: /** @type {"setup" | "ready"} */ (target ? "ready" : "setup"),
    target: target ?? null,
    token,
    /** 当前目标对应的节点簿条目 id（null = 目标来自 --server/setup 配对，未入簿） */
    currentNodeId: null,
    /** member 姿态下不生成 setup 配对码（MUST NOT 生成或打印配对码） */
    pairing:
      target === null && !member
        ? { code: generatePairingCode(), expiresAt: now() + LIMITS.pairingTtlMs, failures: 0, dead: false }
        : null,
  };
  /** hub 槽位快照缓存（homeDir 启用数据面时启动即载，/sidecar/hub 命中时刷新） */
  let hubSlot = null;
  if (homeDir !== null) {
    hubSlot = await hubSnapshotSlot(path.resolve(homeDir), { hostname, interfaces: interfaces ?? undefined }).catch(
      () => null,
    );
  }
  /**
   * WebUI 插件宿主（webui-plugin-kernel Phase 0）：pluginsHost 注入即用（测试
   * 慢存储/超时注入面）；否则 homeDir 给出即创建（运行账本 <DWEB_HOME>/plugins/
   * state.json，损坏 fail-fast 拒启——与 NodeStore 同纪律）。两态（admin/member）
   * 均服务：插件宿主是设备本地运行时，不属远端中枢 admin 面。
   * @type {import("./plugins/host.mjs").PluginHost | null}
   */
  const plugins = pluginsHost ?? (homeDir === null ? null : await createPluginHost({ home: path.resolve(homeDir) }));
  /**
   * 节点簿添加配对码（独立于 setup 配对面；每次成功添加或连败 5 次即轮换新码
   * 并打印终端——「每次新配对码」；措辞避开 "pairing code: " 前缀，防与 setup
   * 配对码抓取正则混淆）。
   */
  const nodePairing =
    nodes === null ? null : { code: generatePairingCode(), expiresAt: now() + LIMITS.pairingTtlMs, failures: 0 };
  if (nodePairing !== null) log(nodeAddCodeLine(nodePairing.code));
  /** 节点添加的单飞锁（并发第二次请求 409；r8-P1-2 起覆盖提交段全程） */
  let nodePairingInFlight = false;
  /**
   * 节点变更互斥锁（r9-P1-2）：switch 与 delete 共用同一把——覆盖「读取条目
   * → DNS/目标验证 await → 提交（重指向 currentNodeId / 落盘删除）」全程。
   * 旧实现两 handler 各自为政：switch 的验证 await 窗口内 DELETE 可删掉其
   * 目标，提交后 currentNodeId 指向已删节点（违反 spec「切换仅接受已存节点」）。
   */
  let nodeMutationInFlight = false;

  /** 在途上游请求（close 时全量销毁，不留半开连接） */
  const inflight = new Set();

  const server = http.createServer((req, res) => {
    Promise.resolve(route(req, res)).catch((e) => {
      log(`sidecar error: ${safeError(e)}`);
      if (bus !== null) bus.emit("error", { code: "internal", message: safeError(e) });
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
    if (member) {
      // member 姿态（design §4.2 row 3 负向矩阵）：/api/*（→ /admin/*）全部
      // 404 且零上游出站——此 return 先于任何 target/proxy 动作，结构上无出站面
      sendJson(res, 404, { error: { code: "not-found" } });
      logAccess(req, 404, startedAt);
      return;
    }
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
    // 切换安全（server-access-roles spec「在途请求不被切换撕裂」）：在第一个
    // await 让出事件循环之前抓 target/token 快照——此后即便节点切换发生，
    // 本请求也按开始时的目标完成。
    const snap = { target: state.target, token: state.token };
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
    await proxyAdmin(req, res, parsed.value, body, startedAt, snap);
  }

  function proxyAdmin(req, res, parsed, body, startedAt, snap) {
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
      const t = /** @type {NonNullable<typeof state.target>} */ (snap.target);
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
          authorization: `Bearer ${snap.token}`,
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
    // GET /sidecar/state：SPA 启动期状态暴露面（design §4）——phase + 掩码
    // host + insecure 明文标志。MUST NOT 含 token/完整 URL/配对码。
    // home-hub 2b 增量字段：role（admin|member——member 态 SPA 不进 setup）、
    // hub_local（row 2 hub 本机自动形态标记——中枢视角/中枢状态卡的数据源）。
    if (req.method === "GET" && req.url === "/sidecar/state") {
      const body = {
        phase: state.mode,
        server_host_masked: state.target === null ? null : maskTarget(state.target),
        insecure: state.target?.insecure === true,
        role: member ? "member" : "admin",
        hub_local: hubLocal === true,
      };
      const buf = Buffer.from(JSON.stringify(body), "utf8");
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-length": String(buf.length),
      });
      res.end(buf);
      logAccess(req, 200, startedAt);
      return;
    }
    // 本机数据面（home-hub 2b /sidecar/leases|visits|hub + probe/label）：
    // homeDir 注入即启用（读面 member 与 admin 姿态都服务——三视角数据互不
    // 串扰；probe 写面仅 member 姿态，见 handleHomeData 角色守卫）。
    if (
      homeDir !== null &&
      (req.url === "/sidecar/leases" ||
        req.url?.startsWith("/sidecar/leases/") ||
        req.url === "/sidecar/visits" ||
        req.url?.startsWith("/sidecar/visits/") ||
        req.url === "/sidecar/hub")
    ) {
      await handleHomeData(req, res, startedAt);
      return;
    }
    // 节点簿本地控制面（/sidecar/nodes*）：ready 态仍可用——switch 是唯一被
    // 许可的运行时重指向通道（server-access-roles 版本化例外），先于
    // target-frozen 门分流。member 姿态：403（admin 面全封闭）。
    if (req.url === "/sidecar/nodes" || req.url?.startsWith("/sidecar/nodes/")) {
      if (member) {
        sendJson(res, 403, { error: { code: "member-closed", message: "this sidecar runs in member mode; the admin console is closed" } });
        logAccess(req, 403, startedAt);
        return;
      }
      await handleNodes(req, res, startedAt);
      return;
    }
    // 会话 capability 引导面（home-hub 2a，design §5.1）：capabilities 注册表
    // 注入（createConsole 形态）才存在——一次性消费 dweb_console query；一切
    // 失败形态=明确 403。query 不落访问日志（logAccess 只记 path），capability
    // 值不进任何日志/响应。非 createConsole sidecar 无此面（维持既有 404）。
    if (capabilities !== null && req.method === "GET" && (req.url === "/sidecar/session" || req.url?.startsWith("/sidecar/session?"))) {
      handleSession(req, res, startedAt);
      return;
    }
    // WebUI 插件控制面（webui-plugin-kernel Phase 0，design §3.1）：plugins 宿主
    // 存在（homeDir/pluginsHost）即启用。先于下方 POST-only 门——GET/PUT/POST
    // 三族都在本 handler 内分派。零凭证（无 token/argv/env 读取）。
    if (plugins !== null && (req.url === "/sidecar/plugins" || req.url?.startsWith("/sidecar/plugins/"))) {
      await handlePlugins(req, res, startedAt);
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 404, { error: { code: "not-found" } });
      logAccess(req, 404, startedAt);
      return;
    }
    if (member) {
      // member 姿态负向矩阵：/sidecar/connect 403（不生成配对码、无重指向面）
      sendJson(res, 403, { error: { code: "member-closed", message: "this sidecar runs in member mode; pairing is closed (run with --setup to re-pair)" } });
      logAccess(req, 403, startedAt);
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
    // 单飞消费锁（r5-P0-1）：配对码校验通过后、任何 await 让出事件循环前，
    // 同步置 in-flight——并发第二个请求在此被拒；validateTarget 失败时恢复
    // （bad-target 不烧码语义不变），成功则走提交段。
    if (pairing.inFlight) {
      sendJson(res, 409, { error: { code: "pairing-in-progress", message: "another pairing request is in flight" } });
      logAccess(req, 409, startedAt);
      return;
    }
    pairing.inFlight = true;
    let v;
    try {
      v = await validateTarget(server, { allowInsecure, dns });
    } finally {
      pairing.inFlight = false;
    }
    if (!v.ok) {
      // 目标守卫失败：配对码匹配成功不烧次数（URL 笔误可重试）
      sendJson(res, 400, { error: { code: "bad-target", message: v.error } });
      logAccess(req, 400, startedAt);
      return;
    }
    // 三防线全过：存内存目标 + token → 冻结 → 配对码销毁（单次有效）。
    // target 判定成功后二次检查配对码未被并发消费（in-flight 锁已排除窗口，
    // 此处防御深度）。
    if (state.mode !== "setup" || state.pairing === null) {
      sendJson(res, 400, { error: { code: "target-frozen", message: "target already configured; restart to change" } });
      logAccess(req, 400, startedAt);
      return;
    }
    state.target = v.value;
    state.token = token;
    state.mode = "ready";
    state.pairing = null;
    if (bus !== null) bus.emit("state-change", { mode: "ready" });
    sendJson(res, 200, { ok: true });
    log(`sidecar: target connected (${v.value.scheme}://${v.value.hostHeader})`);
  }

  // ---- /sidecar/session 会话 capability 引导面（home-hub 2a） -------------------

  /**
   * GET /sidecar/session?dweb_console=<cap>：一次性会话引导（design §5.1
   * capability v1）。Host 守卫（防 rebinding）先于凭证判定——与 connect 面
   * 同族的 400 bad-origin-host；capability 一切失败形态=403（invalid/replay/
   * expired 分别成码）；重放留一行记录（值不入日志）。
   */
  function handleSession(req, res, startedAt) {
    if (req.headers.host !== `127.0.0.1:${actualPort}`) {
      sendJson(res, 400, { error: { code: "bad-origin-host", message: "Host header must be the sidecar origin" } });
      logAccess(req, 400, startedAt);
      return;
    }
    const cap = /** @type {string | null} */ (new URL(req.url ?? "/", origin).searchParams.get("dweb_console"));
    const verdict = cap === null || cap === "" ? { ok: false, reason: "invalid" } : capabilities.consume(cap);
    if (!verdict.ok) {
      // 重放=已被消费过的值再次出现——记录在案（不含值本身）；过期/未知同理 403
      if (verdict.reason === "replay") log("sidecar: session capability replay rejected (recorded)");
      else if (verdict.reason === "expired") log("sidecar: session capability expired");
      else log("sidecar: session capability rejected");
      sendJson(res, 403, { error: { code: `capability-${verdict.reason}`, message: "session capability is invalid, replayed, expired, or from another sidecar instance" } });
      logAccess(req, 403, startedAt);
      return;
    }
    // 消费成功：本机状态投影（与 /sidecar/state 同面——无 token/完整 URL）
    sendJson(res, 200, {
      ok: true,
      phase: state.mode,
      server_host_masked: state.target === null ? null : maskTarget(state.target),
      insecure: state.target?.insecure === true,
    });
    logAccess(req, 200, startedAt);
  }

  // ---- /sidecar 本机数据面（home-hub 2b：leases/visits/hub + probe/label） ---------

  /**
   * 写路由严格守卫（probe/label；design §4.2 r2-P2-2 冻结四类）：
   * same-origin→放行；缺失 Origin→403；不匹配/伪造→403；坏 Host→403。
   * 与基线 guardLocalOrigin 的差异：Origin 必须存在且精确匹配（浏览器
   * same-origin 写请求必带 Origin；裸 HTTP 客户端缺失即拒）。
   */
  function guardWriteOrigin(req, res, startedAt) {
    if (req.headers.host !== `127.0.0.1:${actualPort}`) {
      sendJson(res, 403, { error: { code: "bad-origin-host", message: "Host header must be the sidecar origin" } });
      logAccess(req, 403, startedAt);
      return false;
    }
    const originHeader = req.headers.origin;
    if (typeof originHeader !== "string" || originHeader !== origin) {
      sendJson(res, 403, { error: { code: "bad-origin-host", message: "writes require an exact same-origin Origin header" } });
      logAccess(req, 403, startedAt);
      return false;
    }
    return true;
  }

  /** 读路由（GET leases/visits/hub）：账本不可读=500 fail-closed，不静默伪造空簿。 */
  async function handleHomeData(req, res, startedAt) {
    const home = path.resolve(/** @type {string} */ (homeDir));
    const url = req.url ?? "";

    // GET /sidecar/leases：投影含 expires_in（本地快照）
    if (req.method === "GET" && url === "/sidecar/leases") {
      if (!guardLocalOrigin(req, res, startedAt)) return;
      try {
        sendJson(res, 200, await leasesProjection(home, { now }));
        logAccess(req, 200, startedAt);
      } catch (e) {
        sendJson(res, 500, { error: { code: "ledger-unreadable", message: safeError(e) } });
        logAccess(req, 500, startedAt);
      }
      return;
    }

    // GET /sidecar/visits：best-effort 到访簿投影
    if (req.method === "GET" && url === "/sidecar/visits") {
      if (!guardLocalOrigin(req, res, startedAt)) return;
      try {
        sendJson(res, 200, await visitsProjection(home));
        logAccess(req, 200, startedAt);
      } catch (e) {
        sendJson(res, 500, { error: { code: "ledger-unreadable", message: safeError(e) } });
        logAccess(req, 500, startedAt);
      }
      return;
    }

    // GET /sidecar/hub：hub.json 投影（接入卡片模型 + 运行探测）；无 hub.json=404
    if (req.method === "GET" && url === "/sidecar/hub") {
      if (!guardLocalOrigin(req, res, startedAt)) return;
      /** @type {null | { machine: string, primary_url: string, short_code: string, running: boolean }} */
      let proj = null;
      try {
        proj = await hubProjection(home, { hostname, interfaces: interfaces ?? undefined, fetchImpl: homeFetch });
      } catch (e) {
        sendJson(res, 500, { error: { code: "hub-state-unreadable", message: safeError(e) } });
        logAccess(req, 500, startedAt);
        return;
      }
      if (proj === null) {
        sendJson(res, 404, { error: { code: "not-found", message: "no hub on this device" } });
        logAccess(req, 404, startedAt);
        return;
      }
      hubSlot = { present: true, machine: proj.machine, primary_url: proj.primary_url, short_code: proj.short_code, running: proj.running };
      sendJson(res, 200, proj);
      logAccess(req, 200, startedAt);
      return;
    }

    // POST /sidecar/visits/probe {server}：五类映射探测 + visits 落账（锁写）。
    // 角色守卫（r18 P1-1 / 裁决 #14）：到访簿仅成员侧写入——非 member 姿态
    // （admin/默认/hub-local 同族）一律 403，先于 Origin/入参守卫（授权优先）。
    if (req.method === "POST" && url === "/sidecar/visits/probe") {
      if (!member) {
        sendJson(res, 403, {
          error: { code: "forbidden", message: "visit probes write the member-side visits ledger; only a member-stance sidecar may probe" },
        });
        logAccess(req, 403, startedAt);
        return;
      }
      if (!guardWriteOrigin(req, res, startedAt)) return;
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
      const server = typeof parsed?.server === "string" ? parsed.server.trim() : "";
      let originOk = false;
      try {
        const u = new URL(server);
        originOk = (u.protocol === "http:" || u.protocol === "https:") && u.pathname === "/" && (u.search === "" && u.hash === "");
      } catch {
        originOk = false;
      }
      if (server === "" || !originOk) {
        sendJson(res, 400, { error: { code: "invalid-request", message: "server must be an absolute http(s) origin like http://192.168.2.13:8787" } });
        logAccess(req, 400, startedAt);
        return;
      }
      try {
        sendJson(res, 200, await probeVisit(home, server, { fetchImpl: homeFetch, timeoutMs: homeProbeTimeoutMs, now, isPidAlive: homeIsPidAlive }));
        logAccess(req, 200, startedAt);
      } catch (e) {
        sendJson(res, 500, { error: { code: "probe-failed", message: safeError(e) } });
        logAccess(req, 500, startedAt);
      }
      return;
    }

    // PATCH /sidecar/leases/{id}/label {label: string|null}
    const labelMatch = /^\/sidecar\/leases\/([0-9a-zA-Z-]+)\/label$/.exec(url);
    if (req.method === "PATCH" && labelMatch !== null) {
      if (!guardWriteOrigin(req, res, startedAt)) return;
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
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("label" in parsed)) {
        sendJson(res, 400, { error: { code: "invalid-request", message: "body must be {label: string|null}" } });
        logAccess(req, 400, startedAt);
        return;
      }
      const label = parsed.label;
      if (label !== null && typeof label !== "string") {
        sendJson(res, 400, { error: { code: "invalid-request", message: "label must be a string or null" } });
        logAccess(req, 400, startedAt);
        return;
      }
      const r = await setLeaseLabel(home, labelMatch[1], label, { now, isPidAlive: homeIsPidAlive });
      if (!r.ok) {
        // 未知 id=404；超长=400（setLeaseLabel 复核，双保险）；锁获取失败=503
        const status = r.code === "not-found" ? 404 : r.code === "too-long" ? 400 : 503;
        const message =
          r.code === "not-found"
            ? "unknown lease id"
            : r.code === "too-long"
              ? `label exceeds 64 UTF-8 bytes`
              : "cannot acquire the leases lock; try again";
        sendJson(res, status, { error: { code: r.code, message } });
        logAccess(req, status, startedAt);
        return;
      }
      sendJson(res, 200, { lease: r.lease });
      logAccess(req, 200, startedAt);
      return;
    }

    sendJson(res, 404, { error: { code: "not-found" } });
    logAccess(req, 404, startedAt);
  }

  // ---- /sidecar/plugins* WebUI 插件控制面（webui-plugin-kernel Phase 0） ---------

  /**
   * 插件控制面（design §3.1 冻结路由集）：
   * - GET  /sidecar/plugins：注册表+状态+「即将推出」（vpn/clash/ai/ssh/screen）
   *   +「外部 WebUI 插件=后续版本」标注——读路由基线 Host 守卫（缺失 Origin 放行）。
   * - POST /sidecar/plugins/<id>/enable|disable：写路由精确 Origin 四类
   *   （same-origin 200 / 缺失 403 / 伪造 403 / 坏 Host 403）。disable 等待
   *   drain 收敛（有界，默认 10s）后才应答。
   * - GET/PUT /sidecar/plugins/<id>/config：读=基线守卫；PUT=写路由精确 Origin。
   * 零凭证：本 handler 族不读 token/argv/env——响应与日志零秘密。
   */
  async function handlePlugins(req, res, startedAt) {
    const url = req.url ?? "";
    // GET /sidecar/plugins：面板数据源（admin/member 两态皆可读——设备本地面）
    if (req.method === "GET" && url === "/sidecar/plugins") {
      if (!guardLocalOrigin(req, res, startedAt)) return;
      sendJson(res, 200, plugins.list());
      logAccess(req, 200, startedAt);
      return;
    }
    const actionMatch = /^\/sidecar\/plugins\/([a-z][a-z0-9-]*)\/(enable|disable|config)$/.exec(url);
    if (actionMatch === null) {
      sendJson(res, 404, { error: { code: "not-found" } });
      logAccess(req, 404, startedAt);
      return;
    }
    const id = actionMatch[1];
    const action = actionMatch[2];
    if (action === "enable" || action === "disable") {
      if (req.method !== "POST") {
        sendJson(res, 404, { error: { code: "not-found" } });
        logAccess(req, 404, startedAt);
        return;
      }
      if (!guardWriteOrigin(req, res, startedAt)) return;
      const r = action === "enable" ? await plugins.enable(id) : await plugins.disable(id);
      if (!r.ok) {
        // unknown-plugin=404；invalid-transition=409（registered 无可停用物）；
        // busy=409（同插件并发启停）；lock=503（账本锁获取失败）
        const status = r.code === "unknown-plugin" ? 404 : r.code === "lock" ? 503 : 409;
        sendJson(res, status, { error: { code: r.code, message: pluginErrorMessage(r.code) } });
        logAccess(req, status, startedAt);
        return;
      }
      sendJson(res, 200, { plugin: r.plugin });
      logAccess(req, 200, startedAt);
      return;
    }
    // config：GET 读 / PUT 写（PUT 是写路由——精确 Origin 四类）
    if (req.method === "GET" && action === "config") {
      if (!guardLocalOrigin(req, res, startedAt)) return;
      const config = plugins.getConfig(id);
      if (config === null) {
        sendJson(res, 404, { error: { code: "not-found", message: "unknown webui plugin id" } });
        logAccess(req, 404, startedAt);
        return;
      }
      sendJson(res, 200, { config });
      logAccess(req, 200, startedAt);
      return;
    }
    if (req.method === "PUT" && action === "config") {
      if (!guardWriteOrigin(req, res, startedAt)) return;
      const body = await readBody(req, res);
      if (body === null) {
        logAccess(req, 413, startedAt);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: { code: "invalid-request", message: "body must be a JSON object of config values" } });
        logAccess(req, 400, startedAt);
        return;
      }
      const r = await plugins.setConfig(id, parsed);
      if (!r.ok) {
        const status = r.code === "unknown-plugin" ? 404 : r.code === "invalid-config" || r.code === "busy" ? 400 : 503;
        sendJson(res, status, { error: { code: r.code, message: r.error ?? pluginErrorMessage(r.code) } });
        logAccess(req, status, startedAt);
        return;
      }
      sendJson(res, 200, { config: r.config });
      logAccess(req, 200, startedAt);
      return;
    }
    sendJson(res, 404, { error: { code: "not-found" } });
    logAccess(req, 404, startedAt);
  }

  // ---- /sidecar/nodes* 节点簿（server-access-roles 版本化例外面） ---------------

  /** 节点簿添加码的终端打印措辞（刻意避开 "pairing code: " 前缀——不与 setup 配对码的抓取正则混淆）。 */
  function nodeAddCodeLine(code) {
    return `node book add code: ${code} (10 minutes validity; enter it in the node book "add node" form)`;
  }

  /** 轮换节点簿添加码并打印（成功添加后 / 连败 5 次 / 过期命中时）。 */
  function rotateNodePairing() {
    if (nodePairing === null) return;
    nodePairing.code = generatePairingCode();
    nodePairing.expiresAt = now() + LIMITS.pairingTtlMs;
    nodePairing.failures = 0;
    log(nodeAddCodeLine(nodePairing.code));
  }

  /** Host/Origin 守卫（与 connect 面一致：防 rebinding/CSRF，先于任何状态变更）。 */
  function guardLocalOrigin(req, res, startedAt) {
    if (req.headers.host !== `127.0.0.1:${actualPort}`) {
      sendJson(res, 400, { error: { code: "bad-origin-host", message: "Host header must be the sidecar origin" } });
      logAccess(req, 400, startedAt);
      return false;
    }
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && originHeader !== origin) {
      sendJson(res, 400, { error: { code: "bad-origin-host", message: "cross-origin posts are rejected" } });
      logAccess(req, 400, startedAt);
      return false;
    }
    return true;
  }

  async function handleNodes(req, res, startedAt) {
    if (nodes === null) {
      // 节点簿未启用（未注入 nodesFile）——本地控制面该子域不存在
      sendJson(res, 404, { error: { code: "not-found", message: "node book is not enabled" } });
      logAccess(req, 404, startedAt);
      return;
    }
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/sidecar/nodes") {
      if (!guardLocalOrigin(req, res, startedAt)) return;
      sendJson(res, 200, { nodes: nodes.nodes.map((n) => publicNode(n, n.id === state.currentNodeId)) });
      logAccess(req, 200, startedAt);
      return;
    }
    if (req.method === "POST" && url === "/sidecar/nodes") return handleNodeAdd(req, res, startedAt);
    if (req.method === "POST" && url === "/sidecar/nodes/switch") return handleNodeSwitch(req, res, startedAt);
    const delMatch = /^\/sidecar\/nodes\/([0-9a-zA-Z-]+)$/.exec(url);
    if (req.method === "DELETE" && delMatch !== null) return handleNodeDelete(req, res, startedAt, delMatch[1]);
    sendJson(res, 404, { error: { code: "not-found" } });
    logAccess(req, 404, startedAt);
  }

  /** POST /sidecar/nodes：添加节点（独立配对码 + validateTarget 全量校验 + 单飞消费锁）。 */
  async function handleNodeAdd(req, res, startedAt) {
    if (!guardLocalOrigin(req, res, startedAt)) return;
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
    const server = typeof parsed?.server === "string" ? parsed.server : "";
    const token = typeof parsed?.token === "string" ? parsed.token : "";
    const name = typeof parsed?.name === "string" ? parsed.name.slice(0, 64) : "";
    const code = typeof parsed?.pairing_code === "string" ? parsed.pairing_code.trim().toUpperCase() : "";
    // 添加码校验（常时比较；过期/连败 5 次 → 轮换新码后拒绝本次——「每次新配对码」，
    // 与 connect 面的一次性销毁不同：节点簿是长期功能面，烧死到重启不可取）
    const p = nodePairing;
    if (p !== null && code !== "" && now() > p.expiresAt) rotateNodePairing();
    const alive = p !== null && now() <= p.expiresAt && p.code.length > 0;
    if (p === null || !alive || code === "" || !constantTimeEqual(code, p.code)) {
      if (p !== null) {
        p.failures += 1;
        if (p.failures >= LIMITS.pairingMaxFailures) rotateNodePairing();
      }
      sendJson(res, 400, { error: { code: "bad-pairing", message: "node add code is wrong or expired; a fresh code was printed in the terminal" } });
      logAccess(req, 400, startedAt);
      return;
    }
    if (server === "" || token === "") {
      sendJson(res, 400, { error: { code: "invalid-request", message: "server and token are required" } });
      logAccess(req, 400, startedAt);
      return;
    }
    // 单飞消费锁（r8-P1-2）：覆盖「验证→durable 落盘→码轮换→成功响应」全程。
    // 旧实现锁只罩 validateTarget，NodeStore.add 的 fsync/rename await 窗口内
    // 第二请求可用未轮换的旧码再添一条（一次性终端码双消费）；现在轮换只随
    // 成功发生，任何失败（bad-target/落盘异常）保留配对码可重试。
    if (nodePairingInFlight) {
      sendJson(res, 409, { error: { code: "pairing-in-progress", message: "another node add request is in flight" } });
      logAccess(req, 409, startedAt);
      return;
    }
    nodePairingInFlight = true;
    try {
      const v = await validateTarget(server, { allowInsecure, dns });
      if (!v.ok) {
        // 目标守卫失败不烧码（URL 笔误可重试——与 connect 面一致）
        sendJson(res, 400, { error: { code: "bad-target", message: v.error } });
        logAccess(req, 400, startedAt);
        return;
      }
      // 提交段在锁内：NodeStore.add 事务性落盘（失败内存/磁盘均不变，异常上抛
      // → 500 internal，配对码未轮换可重试）
      const entry = await nodes.add({ name, server_host: server, token, added_at: now() });
      rotateNodePairing(); // 每次成功添加消费一个码，新码立即打印终端
      sendJson(res, 200, { node: publicNode(entry, entry.id === state.currentNodeId) });
      log(`sidecar: node added (${entry.id.slice(0, 8)})`);
      logAccess(req, 200, startedAt);
    } finally {
      nodePairingInFlight = false;
    }
  }

  /**
   * POST /sidecar/nodes/switch {node_id}：唯一被许可的运行时重指向通道。
   * 仅接受已存 node_id（body 含任何 URL/host/server 字段一律 400——目标冻结
   * 安全模型保持，无新目标注入）；切换 = 进程内原子替换 target+token（不重启）。
   * 序列核心在 switchCore（HTTP 面与进程内 controls.switchNode 同一实现）。
   */
  async function handleNodeSwitch(req, res, startedAt) {
    if (!guardLocalOrigin(req, res, startedAt)) return;
    const body = await readBody(req, res);
    if (body === null) {
      logAccess(req, 413, startedAt);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { error: { code: "invalid-request", message: "switch accepts {node_id} of a stored node only" } });
      logAccess(req, 400, startedAt);
      return;
    }
    for (const key of Object.keys(parsed)) {
      if (key !== "node_id") {
        sendJson(res, 400, { error: { code: "invalid-request", message: "switch accepts {node_id} only; no url/host fields" } });
        logAccess(req, 400, startedAt);
        return;
      }
    }
    if (typeof parsed.node_id !== "string" || parsed.node_id === "") {
      sendJson(res, 400, { error: { code: "invalid-request", message: "node_id must be a stored node id" } });
      logAccess(req, 400, startedAt);
      return;
    }
    const r = await switchCore(parsed.node_id);
    if (!r.ok) {
      sendJson(res, r.status, { error: { code: r.code, message: r.message } });
      logAccess(req, r.status, startedAt);
      return;
    }
    sendJson(res, 200, { ok: true, node: publicNode(r.node, true) });
    logAccess(req, 200, startedAt);
  }

  /**
   * 切换序列核心（r9-P1-2 冻结顺序：互斥锁→条目在簿→DNS/目标重校验→
   * 消失防御→未入簿自动入簿→进程内原子替换→事件）。HTTP switch 与进程内
   * controls.switchNode（createConsole.switchTarget）共用——进程内直调不经
   * HTTP，行为与状态转移与 HTTP 面逐一致。
   * @param {string} nodeId
   * @returns {Promise<{ ok: true, node: object } | { ok: false, status: number, code: string, message: string }>}
   */
  async function switchCore(nodeId) {
    if (nodes === null) {
      // HTTP 面不可达（handleNodes 先行 404）——进程内直调（switchTarget）的
      // 明确失败形态：节点簿未启用
      return { ok: false, status: 404, code: "not-found", message: "node book is not enabled" };
    }
    if (nodeMutationInFlight) {
      return { ok: false, status: 409, code: "node-change-in-progress", message: "another node switch or delete is in flight" };
    }
    const entry = nodes?.get(nodeId) ?? null;
    if (entry === null) {
      return { ok: false, status: 404, code: "no-match", message: "unknown node_id" };
    }
    nodeMutationInFlight = true;
    try {
      // 切换前全量重校验目标（DNS 守卫同配对面）——失败不切换（原子性）
      const v = await validateTarget(entry.server_host, { allowInsecure, dns });
      if (!v.ok) {
        return { ok: false, status: 400, code: "bad-target", message: v.error };
      }
      // 提交前重查目标仍在簿（r9-P1-2）：互斥锁下正常不可达的防御性断言——
      // 目标一旦消失即明确 409 冲突，绝不把 currentNodeId 指向不存在的条目
      if (nodes?.get(entry.id) == null) {
        return { ok: false, status: 409, code: "node-vanished", message: "target node disappeared during the switch" };
      }
      // 当前目标未入簿（来自 --server/setup 配对）→ 切走前自动入簿（可切回）
      if (state.currentNodeId === null && state.target !== null) {
        const cur = await nodes.add({
          name: "",
          server_host: `${state.target.scheme}://${state.target.hostHeader}`,
          token: state.token,
          added_at: now(),
        });
        state.currentNodeId = cur.id;
      }
      state.target = v.value;
      state.token = entry.token;
      state.currentNodeId = entry.id;
      state.mode = "ready";
      if (bus !== null) bus.emit("node-switch", { node_id: entry.id });
      log(`sidecar: switched to node ${entry.id.slice(0, 8)} (${v.value.scheme}://${v.value.hostHeader})`);
      return { ok: true, node: entry };
    } finally {
      nodeMutationInFlight = false;
    }
  }

  /** DELETE /sidecar/nodes/{id}：当前连接节点不可删（409，先切走）。 */
  async function handleNodeDelete(req, res, startedAt, id) {
    if (!guardLocalOrigin(req, res, startedAt)) return;
    // 与 switch 同一把节点变更互斥锁（r9-P1-2）：「是否当前」检查与落盘删除
    // 必须在锁内原子完成——否则 switch 提交 currentNodeId 的窗口内可删掉其目标
    if (nodeMutationInFlight) {
      sendJson(res, 409, { error: { code: "node-change-in-progress", message: "another node switch or delete is in flight" } });
      logAccess(req, 409, startedAt);
      return;
    }
    nodeMutationInFlight = true;
    try {
      const entry = nodes?.get(id) ?? null;
      if (entry === null) {
        sendJson(res, 404, { error: { code: "no-match", message: "unknown node_id" } });
        logAccess(req, 404, startedAt);
        return;
      }
      if (id === state.currentNodeId) {
        sendJson(res, 409, { error: { code: "node-current", message: "switch to another node before deleting the current one" } });
        logAccess(req, 409, startedAt);
        return;
      }
      const removed = await nodes.remove(id);
      if (removed === null) {
        // 互斥锁下不可达的并发双删兜底：仍按 unknown 语义应答
        sendJson(res, 404, { error: { code: "no-match", message: "unknown node_id" } });
        logAccess(req, 404, startedAt);
        return;
      }
      sendJson(res, 200, { ok: true });
      log(`sidecar: node removed (${id.slice(0, 8)})`);
      logAccess(req, 200, startedAt);
    } finally {
      nodeMutationInFlight = false;
    }
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

  // ---- 进程内宿主面（home-hub 2a：createConsole 消费，不经 HTTP） ----------------

  /**
   * 进程内控制面：switchNode=switchCore 直调（进程内原子替换+事件）；
   * snapshot=调用时刻同步快照（hub 槽位为最近一次投影缓存——启动即载、
   * /sidecar/hub 命中时刷新；running=null=未探测）。
   */
  const controls = {
    switchNode: (/** @type {string} */ nodeId) => switchCore(nodeId),
    snapshot: () => {
      const entry = nodes !== null && state.currentNodeId !== null ? nodes.get(state.currentNodeId) : null;
      return {
        mode: state.mode,
        node: entry !== null ? publicNode(entry, true) : null,
        hub: hubSlot,
        role: member ? "member" : "admin",
      };
    },
  };

  return {
    port: actualPort,
    origin,
    url: origin,
    mode: () => state.mode,
    pairingCode: state.pairing?.code ?? null,
    nodePairingCode: () => nodePairing?.code ?? null,
    /** @type {SidecarHandle} */
    controls,
    bus,
    capabilities,
    close: async () => {
      for (const r of inflight) r.destroy();
      inflight.clear();
      capabilities?.close(); // 会话 capability close 即失效（design §5.1）
      await plugins?.close(); // 插件宿主拆运行时（不落盘状态变更——重启按账本恢复）
      const closing = new Promise((resolve) => server.close(() => resolve(undefined)));
      server.closeAllConnections?.();
      await closing;
    },
  };
}

/**
 * @typedef {Object} SidecarHandle
 * @property {number} port
 * @property {string} origin
 * @property {string} url
 * @property {() => "setup" | "ready"} mode
 * @property {string | null} pairingCode
 * @property {() => string | null} nodePairingCode
 * @property {{ switchNode: (nodeId: string) => Promise<{ ok: true, node: object } | { ok: false, status: number, code: string, message: string }>, snapshot: () => { mode: "setup" | "ready", node: { id: string, name: string, server_host: string, added_at: number, current: boolean } | null, hub: { present: true, machine: string, primary_url: string, short_code: string, running: boolean | null } | null, role: "admin" | "member" } }} controls
 * @property {import("./events.mjs").EventBus | null} bus
 * @property {import("./capability.mjs").CapabilityRegistry | null} capabilities
 * @property {import("./plugins/host.mjs").PluginHost | null} plugins WebUI 插件宿主（homeDir/pluginsHost 启用；缺省 null）
 * @property {() => Promise<void>} close
 */

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

/** 插件控制面错误文案（ASCII 程序常量——零秘密） */
function pluginErrorMessage(code) {
  switch (code) {
    case "unknown-plugin":
      return "unknown webui plugin id";
    case "invalid-transition":
      return "plugin was never enabled; there is nothing to disable";
    case "busy":
      return "another enable/disable/config change is in flight for this plugin";
    case "invalid-config":
      return "config values do not match the plugin config schema";
    case "lock":
      return "cannot acquire the plugin state lock; try again";
    default:
      return "plugin operation failed";
  }
}
