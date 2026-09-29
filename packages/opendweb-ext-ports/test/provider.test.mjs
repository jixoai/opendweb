// 提供侧单元面（design §3.2/§5：授权矩阵（sessionId 隔离键+peer 授权）、
// deny 零转发、转发保真、取消传播→上游 socket 收敛、请求体纵深 413）。
// 直接调用 handler（invokeHandler 摊平静态/流式两结算路径）；上游=真实
// node:http 服务（127.0.0.1 临时端口）。

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createPortsProxyHandler } from "../src/provider.mjs";
import { grantAccess, revokeAccess } from "../src/ledger.mjs";
import { invokeHandler, startUpstream, tempHome } from "./helpers.mjs";

const PEER = "peer-b-endpoint";

/**
 * 标准环境：home（授权账本）+ 上游 echo 服务。
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void>} [handler]
 */
async function fixture(handler = (req, res) => {
  res.writeHead(200, { "content-type": "text/plain", "x-upstream": "direct" });
  res.end(`echo ${req.method} ${req.url}`);
}) {
  const home = await tempHome("wpk-provider-");
  const upstream = await startUpstream(handler);
  return { home, upstream, cleanup: async () => {
    await upstream.close();
    await rm(home, { recursive: true, force: true });
  } };
}

test("provider: authorization matrix — (peer,port) deny-by-default, zero forwarding", async (t) => {
  const { home, upstream, cleanup } = await fixture();
  t.after(() => cleanup());
  const handler = createPortsProxyHandler({ home, peer: PEER });

  // 1) 未授权（默认 deny）：403 + 上游零连接
  const denied = await invokeHandler(handler, { path: `/wpk1/ports/proxy/${upstream.port}/x` });
  assert.equal(denied.mode, "static");
  assert.equal(/** @type {any} */ (denied).status, 403);
  assert.equal(upstream.connections, 0, "denied request must not connect upstream (zero forwarding)");

  // 2) 授权后转发成功（method/path/头/体保真）
  await grantAccess(home, PEER, upstream.port);
  const ok = await invokeHandler(handler, {
    method: "POST",
    path: `/wpk1/ports/proxy/${upstream.port}/echo?x=1`,
    headers: [
      { name: "content-type", value: "text/plain" },
      { name: "host", value: `localhost:${upstream.port}` },
      { name: "connection", value: "keep-alive" },
      { name: "x-custom", value: "v" },
    ],
    bodyChunks: [Buffer.from("hello "), Buffer.from("world")],
  });
  assert.equal(/** @type {any} */ (ok).mode, "streaming");
  assert.equal(/** @type {any} */ (ok).status, 200);
  assert.equal(Buffer.concat(/** @type {any} */ (ok).bodyChunks).toString(), `echo POST /echo?x=1`);
  assert.equal(upstream.hits.length, 1);
  const hit = /** @type {any} */ (upstream.hits[0]);
  assert.equal(hit.method, "POST");
  assert.equal(hit.url, "/echo?x=1");
  assert.equal(hit.body.toString(), "hello world");
  assert.equal(hit.headers["x-custom"], "v");
  assert.equal(hit.headers["connection"] === undefined || hit.headers["connection"] === "keep-alive", true);
  assert.equal(hit.headers["host"], `localhost:${upstream.port}`);
  // 敏感回显重写：server→opendweb-ports、via 剥除；content-length 剥除（流式）
  const header = (name) => /** @type {any} */ (ok).headers.find((h) => h.name === name)?.value;
  assert.equal(header("x-upstream"), "direct");
  assert.equal(header("server"), "opendweb-ports");
  assert.equal(header("via"), undefined);
  assert.equal(header("content-length"), undefined);

  // 3) 其他端口未授权 → deny（同 peer 不同 port）
  const otherPort = await invokeHandler(handler, { path: "/wpk1/ports/proxy/65001/x" });
  assert.equal(/** @type {any} */ (otherPort).status, 403);

  // 4) 撤销授权 → deny + 零新转发
  await revokeAccess(home, PEER, upstream.port);
  const revoked = await invokeHandler(handler, { path: `/wpk1/ports/proxy/${upstream.port}/x` });
  assert.equal(/** @type {any} */ (revoked).status, 403);
  assert.equal(upstream.hits.length, 1, "no further upstream hits after revoke");
});

test("provider: sessionId is an isolation key, not an auth bypass — same peer across sessions", async (t) => {
  const { home, upstream, cleanup } = await fixture();
  t.after(() => cleanup());
  const handler = createPortsProxyHandler({ home, peer: PEER });
  await grantAccess(home, PEER, upstream.port);
  // 同 peer 异 session：授权按 (peer, port) 判定——两 session 均放行且互不继承状态
  const s1 = await invokeHandler(handler, { sessionId: "sess-aaa", path: `/wpk1/ports/proxy/${upstream.port}/` });
  const s2 = await invokeHandler(handler, { sessionId: "sess-bbb", path: `/wpk1/ports/proxy/${upstream.port}/` });
  assert.equal(/** @type {any} */ (s1).status, 200);
  assert.equal(/** @type {any} */ (s2).status, 200);
  assert.equal(upstream.hits.length, 2);
});

test("provider: 404 for non-endpoint paths; peer identity fixed at factory", async (t) => {
  const home = await tempHome("wpk-provider-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const handler = createPortsProxyHandler({ home, peer: PEER });
  for (const p of ["/wpk1/ports/other/1", "/wpk1/ports/proxy/", "/wpk1/ports/proxy/abc/x", "/other"]) {
    const r = await invokeHandler(handler, { path: p });
    assert.equal(/** @type {any} */ (r).status, 404, `${p} must be 404`);
  }
  // 非 65535 内端口拒绝
  const bad = await invokeHandler(handler, { path: "/wpk1/ports/proxy/99999/x" });
  assert.equal(/** @type {any} */ (bad).status, 404);
  // 其他 peer 的 handler（另一 serveHttp 绑定）未授权 → deny
  const otherPeerHandler = createPortsProxyHandler({ home, peer: "peer-c" });
  await grantAccess(home, PEER, 8080);
  const denied = await invokeHandler(otherPeerHandler, { path: "/wpk1/ports/proxy/8080/x" });
  assert.equal(/** @type {any} */ (denied).status, 403);
});

test("provider: known-length over-limit → 413 zero forwarding (defense in depth)", async (t) => {
  const { home, upstream, cleanup } = await fixture();
  t.after(() => cleanup());
  await grantAccess(home, PEER, upstream.port);
  const handler = createPortsProxyHandler({ home, peer: PEER, maxBodyMiB: 1 });
  const big = 2 * 1024 * 1024;
  const r = await invokeHandler(handler, {
    method: "POST",
    path: `/wpk1/ports/proxy/${upstream.port}/`,
    headers: [{ name: "content-length", value: String(big) }],
    bodyChunks: [Buffer.alloc(1024)],
  });
  assert.equal(/** @type {any} */ (r).status, 413);
  assert.match(Buffer.concat(/** @type {any} */ (r).bodyChunks).toString(), /exceeds the provider limit/);
  assert.equal(upstream.connections, 0, "over-limit body must never open an upstream socket");
});

test("provider: consumer abort (request.signal) destroys upstream socket — convergence", async (t) => {
  // SSE 上游 + 中途 signal abort → 上游 socket 收敛（closedConnections 追平）
  const { home, upstream, cleanup } = await fixture((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      res.write(`data: ${i}\n\n`);
      if (i >= 100) {
        clearInterval(timer);
        res.end();
      }
    }, 15);
    res.on("close", () => clearInterval(timer));
  });
  t.after(() => cleanup());
  await grantAccess(home, PEER, upstream.port);
  const handler = createPortsProxyHandler({ home, peer: PEER });

  const controller = new AbortController();
  const writerChunks = [];
  let resolveFinish = () => {};
  const finished = new Promise((r) => {
    resolveFinish = r;
  });
  let streaming = false;
  /** @type {import("../src/provider.mjs").HttpHandlerRequestLike} */
  const req = {
    requestId: 7,
    streamId: 7,
    sessionId: "sess-cancel",
    signal: controller.signal,
    method: "GET",
    path: `/wpk1/ports/proxy/${upstream.port}/events`,
    headers: [],
    bodyNext: async () => null,
    respondStreaming(status, headers) {
      if (streaming) return null;
      streaming = true;
      return {
        write: async (c) => writerChunks.push(c),
        finish: () => resolveFinish(),
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
  const handlerPromise = handler(req);
  // 等首批事件经流式通道回写（上游已连）
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(writerChunks.length >= 2, "SSE events flow through respondStreaming before cancel");
  controller.abort(); // 对端 RESET → provider request.signal
  await Promise.race([finished, new Promise((r) => setTimeout(r, 2000))]);
  const result = await handlerPromise;
  assert.equal(result ?? null, null, "streaming path: handler resolves null after respondStreaming");
  // 上游 socket 收敛断言（零悬挂）
  const deadline = Date.now() + 2000;
  while (upstream.activeConnections > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(upstream.activeConnections, 0, "upstream socket must converge after consumer abort");
});
