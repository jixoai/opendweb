#!/usr/bin/env node
// ai-subscription-sharing Phase C 走查环境（tasks C4——编排者亲测用；本脚本只
// 拉起环境+自动装配+自验，不做浏览器走查）。
//
// 一键双 home 假上游演示（单进程内两个真 sidecar + 进程内 cross-fabric SDK 替身
// ——B 的 fetchHttp 直通 A 的 serveHttp handler；数据面语义=内核 wire 契约投影）：
//   A home（admin）： leases+target（UI ready 态）→ enable ai → 密钥库 secret →
//                    自定义 openai 型服务（假上游 SSE）→ 分组 → 签发 key →
//                    aifly1. 链接（recipient=B 端点）
//   B home（member）：enable ai → 导入链接 → 刷新目录（AUTH，经 cross-fabric）→
//                    起本地端点 127.0.0.1:4310
//   自验：curl 等价 fetch B 本地端点 /v1/chat/completions（stream）→ SSE 字节流。
//
// 用法：node scripts/walkthrough/ai-demo.mjs [--keep] [--exit]
//   --keep  退出时保留两个 home 目录（复检 services.json/keyring.json）
//   --exit  自验通过后自动退出（无交互；默认保持运行供浏览器走查）
// 前置：packages/webui npm run build 已产 dist（UI 静态面）。
// 退出：Ctrl+C（SIGINT/SIGTERM）——sidecar/假上游显式回收，临时目录清理。

import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEEP = process.argv.includes("--keep");
const AUTO_EXIT = process.argv.includes("--exit");
const LOCAL_PORT = Number(process.env.AI_DEMO_PORT ?? 4310);

const { createSidecar } = await import(path.join(ROOT, "packages/webui/src/core/sidecar.mjs"));
const { hexToZ32 } = await import(path.join(ROOT, "packages/webui/src/core/fabric.mjs"));

// ---------------------------------------------------------------------------
// 身份：A=root（aa*32）/ B=member（bb*32），同 fabric_id
// ---------------------------------------------------------------------------

const FABRIC_ID = "aa".repeat(32);
const ROOT_A = "aa".repeat(32);
const ROOT_B = "bb".repeat(32);
const leaseOf = (root) => ({
  id: `demo-${root.slice(0, 4)}`,
  server: "http://127.0.0.1:18787",
  relay_url: "",
  server_id: "",
  fabric_id: FABRIC_ID,
  root,
  alias: root === ROOT_A ? "demo-provider" : "demo-consumer",
  label: null,
  registered_at: 1,
  expires_at: null,
  receipt: null,
});

// ---------------------------------------------------------------------------
// 假上游（OpenAI 型：/v1/chat/completions SSE 流式 + /v1/models JSON）
// ---------------------------------------------------------------------------

async function startFakeUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "demo-1" }] }));
        return;
      }
      // Authorization 必须是 provider 侧 secret 槽注入值（走查锚点）
      const authOk = req.headers.authorization === "Bearer sk-demo-upstream-secret";
      if (!authOk) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "missing demo upstream credential" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "x-demo": "ai-fly-walkthrough" });
      res.flushHeaders();
      const stream = body.includes('"stream":true') || body.includes('"stream": true');
      if (!stream) {
        res.end(JSON.stringify({ id: "chatcmpl-demo", object: "chat.completion", choices: [{ message: { role: "assistant", content: "pong（非流式）" } }] }));
        return;
      }
      let i = 0;
      const timer = setInterval(() => {
        if (i >= 6) {
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(timer);
          return;
        }
        res.write(`data: {"id":"chatcmpl-demo","choices":[{"delta":{"content":"流式分片 ${i} "}}]}\n\n`);
        i += 1;
      }, 120);
      // 响应侧连接关闭才停（req 的 close 在请求体读毕即触发——不等同断连）
      res.on("close", () => clearInterval(timer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return { port, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)); }) };
}

// ---------------------------------------------------------------------------
// cross-fabric SDK 替身（进程内：B fetchHttp → A serveHttp handler 直通）
// ---------------------------------------------------------------------------

function makeCrossSdk(rootsByHome) {
  /** endpointId(z32) → fabric 事件泵 */
  const fabrics = new Map();
  /** 服务端 endpointId(z32) → 对端 caller(z32) → handler */
  const handlers = new Map();
  let reqId = 0;

  function makeFabric(endpointIdHex) {
    const z32 = hexToZ32(endpointIdHex);
    /** @type {((ev: object) => void) | null} */
    let eventCb = null;
    const fabric = {
      endpointId: z32,
      async rootEndpointId() {
        return z32;
      },
      async fabricIdHex() {
        return FABRIC_ID;
      },
      async ensureRelayCapabilities() {
        return [];
      },
      async start() {},
      async connect() {},
      async openSession(peer) {
        // 对端 fabric 触发 peer-connected（真实语义：入站连接让服务端绑 serveHttp）
        fabrics.get(peer)?.emit({ type: "peer-connected", endpointId: z32 });
        return {
          peerId: peer,
          callerId: z32,
          sessionId: `sess-${z32.slice(0, 6)}-${peer.slice(0, 6)}-${(reqId += 1)}`,
          onState: () => () => {},
          async close() {},
        };
      },
      on(cb) {
        eventCb = cb;
        return () => {
          eventCb = null;
        };
      },
      async shutdown() {},
      async members() {
        return [];
      },
      async invite(_ttl, recipient) {
        return `dweb1.demo-${recipient.slice(0, 8)}`;
      },
    };
    fabrics.set(z32, { emit: (ev) => eventCb?.(ev) });
    handlers.set(z32, new Map());
    return fabric;
  }

  return {
    sdk: {
      Fabric: {
        async open(opts) {
          const root = rootsByHome.get(opts?.dataDir);
          if (root === undefined) throw new Error(`cross-fabric: unknown home ${opts?.dataDir}`);
          return makeFabric(root);
        },
      },
      async serveHttp(fabric, peer, handler) {
        handlers.get(fabric.endpointId)?.set(peer, handler);
        return { close: () => handlers.get(fabric.endpointId)?.delete(peer) };
      },
      async fetchHttp(session, req) {
        const handler = handlers.get(session.peerId)?.get(session.callerId);
        if (handler === undefined) throw new Error(`cross-fabric: no serveHttp binding for ${session.callerId} on ${session.peerId}`);
        const bodyChunks = (req.body ?? []).map((c) => Buffer.from(c));
        let idx = 0;
        const typed = {
          requestId: (reqId += 1),
          streamId: reqId,
          sessionId: session.sessionId,
          signal: req.signal ?? new AbortController().signal,
          method: req.method,
          path: req.path,
          headers: req.headers ?? [],
          bodyNext: async () => (idx < bodyChunks.length ? bodyChunks[idx++] : null),
          respondStreaming: () => null,
        };
        const res = await handler(typed);
        if (res === null || res === undefined) {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        const out = (res.bodyChunks ?? []).map((c) => Buffer.from(c));
        let outIdx = 0;
        return { status: res.status, headers: res.headers ?? [], bodyNext: async () => (outIdx < out.length ? out[outIdx++] : null) };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// sidecar HTTP 客户端（走查脚本的控制面调用——same-origin Origin 形态）
// ---------------------------------------------------------------------------

async function api(sidecar, method, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${sidecar.port}${urlPath}`, {
    method,
    // Host 头由 URL 派生（fetch 禁止手工设置——恰好等于守卫期望的 127.0.0.1:<port>）；
    // Origin 手工携带=同源浏览器形态（写路由精确 Origin 四类的 same-origin 类）。
    headers: {
      origin: sidecar.origin,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${text}`);
  return text === "" ? {} : JSON.parse(text);
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

const dist = path.join(ROOT, "packages/webui/dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("缺少 UI 构建产物（packages/webui/dist/index.html）——先运行：cd packages/webui && npm run build");
  process.exit(1);
}

const homeA = await mkdtemp(path.join(tmpdir(), "ai-demo-a-"));
const homeB = await mkdtemp(path.join(tmpdir(), "ai-demo-b-"));
const upstream = await startFakeUpstream();
const { sdk } = makeCrossSdk(new Map([
  [homeA, ROOT_A],
  [homeB, ROOT_B],
]));

await writeFile(path.join(homeA, "leases.json"), JSON.stringify({ version: 1, leases: [leaseOf(ROOT_A)] }, null, 2));
await writeFile(path.join(homeB, "leases.json"), JSON.stringify({ version: 1, leases: [leaseOf(ROOT_B)] }, null, 2));

const logA = (line) => console.log(`  [A] ${line}`);
const logB = (line) => console.log(`  [B] ${line}`);

const sidecarA = await createSidecar({
  homeDir: homeA,
  sdk,
  distDir: dist,
  log: logA,
  // target=假上游（/api 代理会 404——插件页不走 /api；只为 UI 进 ready/admin 世界）
  target: { scheme: "http", hostname: "127.0.0.1", port: upstream.port, hostHeader: `127.0.0.1:${upstream.port}`, connectHost: "127.0.0.1", servername: null, insecure: true },
  token: "demo-token-not-a-credential",
});
const sidecarB = await createSidecar({ homeDir: homeB, sdk, distDir: dist, member: true, log: logB });

/** @type {Array<() => Promise<void>>} 退出回收清单 */
const teardown = [];
teardown.push(async () => {
  await sidecarB.close();
  console.log("  [B] sidecar closed");
});
teardown.push(async () => {
  await sidecarA.close();
  console.log("  [A] sidecar closed");
});
teardown.push(async () => {
  await upstream.close();
  console.log("  [upstream] fake upstream closed");
});
teardown.push(async () => {
  if (!KEEP) {
    await rm(homeA, { recursive: true, force: true });
    await rm(homeB, { recursive: true, force: true });
    console.log("  [tmp] homes removed");
  } else {
    console.log(`  [tmp] kept: ${homeA} / ${homeB}`);
  }
});

async function exitDemo(code = 0) {
  for (const fn of teardown.reverse()) await Promise.resolve(fn()).catch((e) => console.error(`  teardown: ${e?.message ?? e}`));
  process.exit(code);
}
process.on("SIGINT", () => void exitDemo(130));
process.on("SIGTERM", () => void exitDemo(143));

// ---- A：enable → secret → 服务（假上游）→ 分组 → key → 链接 -------------------------

await api(sidecarA, "POST", "/sidecar/plugins/ai/enable");
await api(sidecarA, "POST", "/sidecar/plugins/ai/secrets", { name: "upstream-key", value: "sk-demo-upstream-secret" });
await api(sidecarA, "POST", "/sidecar/plugins/ai/services", {
  service: {
    name: "demo-openai",
    upstream: upstream.origin,
    match: [{ type: "suffix", value: ".openai.com" }],
    defaultPort: LOCAL_PORT,
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    auth: { secret: "upstream-key" },
  },
});
await api(sidecarA, "POST", "/sidecar/plugins/ai/groups", { name: "family", serviceNames: ["demo-openai"] });
const key = await api(sidecarA, "POST", "/sidecar/plugins/ai/keys", { group: "family", name: "demo" });
const linkOut = await api(sidecarA, "POST", "/sidecar/plugins/ai/link", { group: "family", recipient: ROOT_B });

// ---- B：enable → 导入链接 → 刷新目录 → 起本地端点 ----------------------------------

await api(sidecarB, "POST", "/sidecar/plugins/ai/enable");
await api(sidecarB, "POST", "/sidecar/plugins/ai/consumer/import", { link: linkOut.link });
await api(sidecarB, "POST", "/sidecar/plugins/ai/consumer/refresh");
const catalog = await api(sidecarB, "GET", "/sidecar/plugins/ai/consumer");
const provider = catalog.providers[0];
const service = provider.services.find((s) => s?.name === "demo-openai");
if (service === undefined) throw new Error("consumer catalog missing demo-openai (refresh failed?)");
await api(sidecarB, "POST", "/sidecar/plugins/ai/consumer/endpoints", { providerEndpointId: provider.endpointId, serviceId: service.serviceId, port: LOCAL_PORT });

// ---- 自验：B 本地端点 → cross-fabric → A wire → 假上游 SSE ---------------------------

const verify = await fetch(`http://127.0.0.1:${LOCAL_PORT}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer sk-aifly-anything-stripped-locally" },
  body: JSON.stringify({ model: "demo-1", stream: true, messages: [{ role: "user", content: "ping" }] }),
});
const verifyBody = await verify.text();
const verified = verify.status === 200 && verifyBody.includes("data: ") && verifyBody.includes("[DONE]");

// ---------------------------------------------------------------------------
// 走查信息板
// ---------------------------------------------------------------------------

console.log("");
console.log("────────────────────────────────────────────────────────────");
console.log(" ai-subscription-sharing 走查环境（Phase C——双 home 假上游演示）");
console.log("────────────────────────────────────────────────────────────");
console.log(` A（提供方/admin） UI : http://127.0.0.1:${sidecarA.port}/#/p/ai/provider`);
console.log(` B（消费方/member） UI : http://127.0.0.1:${sidecarB.port}/#/p/ai/consumer`);
console.log(` 插件面板（启停/配置）  : http://127.0.0.1:${sidecarA.port}/#/p/host/panel`);
console.log("");
console.log(` 假上游（OpenAI 型 SSE）: ${upstream.origin}/v1/chat/completions（secret 槽注入 Bearer sk-demo-upstream-secret）`);
console.log(` B 本地端点             : http://127.0.0.1:${LOCAL_PORT}/v1/chat/completions`);
console.log("");
console.log(" 验证命令（流式）：");
console.log(`   curl -N http://127.0.0.1:${LOCAL_PORT}/v1/chat/completions \\`);
console.log(`     -H 'content-type: application/json' \\`);
console.log(`     -d '{"model":"demo-1","stream":true,"messages":[{"role":"user","content":"ping"}]}'`);
console.log("");
console.log(" 验证命令（非流式）：");
console.log(`   curl -s http://127.0.0.1:${LOCAL_PORT}/v1/chat/completions -H 'content-type: application/json' -d '{"model":"demo-1","messages":[{"role":"user","content":"ping"}]}'`);
console.log("");
console.log(` 已装配：A secret+服务 demo-openai（分组 family）+key ${key.keyId}；B 已导入目录并监听 ${LOCAL_PORT}`);
console.log(` aifly1. 链接（可在 B 页面重新粘贴导入演练）：`);
console.log(`   ${linkOut.link}`);
console.log(` 自验（SSE 往返）：${verified ? "PASS（含 data: 分片与 [DONE]）" : `FAIL（status=${verify.status}）`}`);
console.log("");
console.log(KEEP ? " --keep：退出保留 homes（见上方 tmp 路径）" : " Ctrl+C 退出（sidecar/假上游/临时目录显式回收）");
console.log("────────────────────────────────────────────────────────────");

if (AUTO_EXIT || !verified) {
  await exitDemo(verified ? 0 : 1);
} else {
  // 交互走查模式：保持运行（浏览器打开两端 UI）
  setInterval(() => {}, 60_000);
}
