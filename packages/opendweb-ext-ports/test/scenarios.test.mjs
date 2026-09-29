// 六 Scenario 验收面（openspec/changes/webui-plugin-kernel/specs/plugins/ports/
// spec.md 全部 Scenario 的可注入等价物——fetchHttpImpl/sessionResolver 替身经
// fabric 桥直连 provider handler，不依赖真实 fabric；上游/客户端=真实
// node:http/net）。
// 1. 双机端口映射与两阶段取消传播（r2-B1）——含 (a) 响应等同直连 (b) 阶段 A
//    头前 abort (c) 阶段 B 体中 resp.abort；
// 2. 已知长度超限 413；
// 3. 未知长度累计断开（不先缓冲后判）；
// 4. 并发预算 429 + 128MiB 配置拒启；
// 5. 授权默认拒绝（零转发）；
// 6. SSE 透传 + 端口冲突明确失败。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { rm } from "node:fs/promises";
import { createPortsRuntime } from "../src/runtime.mjs";
import { createPortsProxyHandler } from "../src/provider.mjs";
import { addMapping, grantAccess } from "../src/ledger.mjs";
import { createFabricBridge, freePort, rawClient, request, startUpstream, tempHome, waitFor } from "./helpers.mjs";

/** 默认 echo 上游（直连对照与保真断言用） */
const echoUpstream = (req, res) => {
  res.writeHead(200, { "content-type": "text/plain", "x-upstream": "direct" });
  res.end(`echo ${req.method} ${req.url}`);
};

/**
 * 两机拓扑：A=provider（homeA+allowlist+handler），B=consumer（homeB+runtime+
 * 映射）。fabric 会话=桥替身（语义镜像 /http 取消协议）。
 * @param {import("node:test").TestContext} t
 * @param {{ upstreamHandler?: Parameters<typeof startUpstream>[0], config?: { maxBodyMiB?: number }, grant?: boolean }} [opts]
 */
async function twoMachines(t, opts = {}) {
  const homeA = await tempHome("wpk-scenario-a-");
  const homeB = await tempHome("wpk-scenario-b-");
  const upstream = await startUpstream(opts.upstreamHandler ?? echoUpstream);
  if (opts.grant !== false) await grantAccess(homeA, "peer-b", upstream.port);
  const bridge = createFabricBridge(createPortsProxyHandler({ home: homeA, peer: "peer-b" }));
  const localPort = await freePort();
  const rt = await createPortsRuntime({
    home: homeB,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: (peer) => (peer === "peer-a" ? { sessionId: "sess-b-to-a" } : null),
    config: opts.config,
    drainTimeoutMs: 1500,
  });
  await addMapping(homeB, { name: "A 服务", peer: "peer-a", remotePort: upstream.port, localPort, enabled: true });
  await rt.start();
  t.after(() => rt.stop());
  t.after(() => upstream.close());
  t.after(() => rm(homeA, { recursive: true, force: true }));
  t.after(() => rm(homeB, { recursive: true, force: true }));
  return { homeA, homeB, upstream, bridge, rt, localPort };
}

// ---- Scenario 1：双机端口映射与两阶段取消传播（r2-B1） ----------------------------

test("scenario 1: proxied response equals direct access (status/headers/body)", async (t) => {
  const { upstream, localPort } = await twoMachines(t);
  const direct = await request(upstream.port, { path: "/hello?x=1&y=2" });
  const proxied = await request(localPort, { path: "/hello?x=1&y=2" });
  assert.equal(proxied.status, direct.status);
  assert.equal(proxied.text, direct.text, "body identical");
  assert.equal(proxied.headers["content-type"], direct.headers["content-type"]);
  assert.equal(proxied.headers["x-upstream"], direct.headers["x-upstream"]);
  // 敏感回显重写：server=opendweb-ports、via 剥除（冻结清单）
  assert.equal(proxied.headers["server"], "opendweb-ports");
  assert.equal(proxied.headers["via"], undefined);
  // POST 体透传
  const posted = await request(localPort, { method: "POST", path: "/submit", headers: { "content-type": "text/plain" }, body: "payload-123" });
  assert.equal(posted.status, 200);
  assert.equal(posted.text, "echo POST /submit");
  const lastHit = /** @type {any} */ (upstream.hits.at(-1));
  assert.equal(lastHit.body.toString(), "payload-123");
  // hop-by-hop 头不透传到上游
  assert.equal(lastHit.headers["transfer-encoding"], undefined, "chunked 入站被重帧为 content-length");
  assert.equal(String(lastHit.headers["content-length"]), "11");
});

test("scenario 1a: cancel during header wait (phase A) — request signal → RESET → provider signal + upstream socket convergence", async (t) => {
  // 上游黑洞：收请求但永不响应（阶段 A 窗口）
  const { upstream, bridge, localPort, rt } = await twoMachines(t, {
    upstreamHandler: (req, res) => {
      /* blackhole: hold the request open */
    },
  });
  const client = rawClient(localPort, "GET /slow HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  t.after(() => client.destroy());

  // 请求已转发（B→A fetch 已发起；上游已收到）
  await waitFor(() => bridge.fetchCalls.length === 1, 2000, "fetch forwarded");
  await waitFor(() => upstream.hits.length === 1, 2000, "upstream hit");
  assert.equal(upstream.activeConnections, 1, "upstream socket open while waiting for headers");

  // 客户端在响应头返回前断开本地连接
  client.destroy();
  await waitFor(() => bridge.countEvents("request-signal-abort") === 1, 2000, "phase A: request signal abort observed");
  assert.equal(bridge.countEvents("provider-signal"), 1, "RESET reaches provider → request.signal fires");
  assert.equal(bridge.countEvents("resp-abort"), 0, "phase A must not use response handle abort");
  // 上游 socket 收敛（零悬挂）
  await waitFor(() => upstream.activeConnections === 0, 2000, "upstream socket converges after phase A cancel");
  // 在途活动归零（drain 面）
  await waitFor(() => rt.budget.inFlight === 0, 2000, "in-flight settles");
});

test("scenario 1b: cancel during body transfer (phase B, SSE) — response handle abort → RESET → provider signal + upstream socket convergence", async (t) => {
  const sseUpstream = (req, res, _hits, sendTimestamps) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      sendTimestamps.push(Date.now());
      res.write(`data: ${i}\n\n`);
      if (i >= 50) {
        clearInterval(timer);
        res.end();
      }
    }, 20);
    res.on("close", () => clearInterval(timer));
  };
  const { upstream, bridge, localPort, rt } = await twoMachines(t, { upstreamHandler: sseUpstream });
  const client = rawClient(localPort, "GET /events HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\n\r\n");
  t.after(() => client.destroy());

  // 头已回 + 至少两个事件到达（进入阶段 B）
  await waitFor(() => client.text.includes("data: 2"), 2000, "headers + first events arrive");
  assert.match(client.text, /^HTTP\/1\.1 200/);
  assert.match(client.text, /content-type: text\/event-stream/i);

  // 客户端在响应体传输中断开本地连接
  client.destroy();
  await waitFor(() => bridge.countEvents("resp-abort") === 1, 2000, "phase B: response handle abort observed");
  assert.equal(bridge.countEvents("provider-signal"), 1, "RESET reaches provider → request.signal fires");
  // B1 断言：阶段 B 不走请求 signal（其取消键在头返回后已注销）
  assert.equal(bridge.countEvents("request-signal-abort"), 0, "phase B must NOT abort via request signal (cancel key deregistered)");
  await waitFor(() => upstream.activeConnections === 0, 2000, "upstream socket converges after phase B cancel");
  await waitFor(() => rt.budget.inFlight === 0, 2000, "in-flight settles");
});

// ---- Scenario 2：已知长度超限拒绝 --------------------------------------------------

test("scenario 2: known content-length over limit → 413 with limit message, zero forwarding", async (t) => {
  const { bridge, localPort } = await twoMachines(t, { config: { maxBodyMiB: 1 } });
  const overLimit = 2 * 1024 * 1024;
  const client = rawClient(
    localPort,
    `POST /upload HTTP/1.1\r\nHost: localhost:${localPort}\r\nContent-Length: ${overLimit}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  client.write(Buffer.alloc(64)); // 只发一小段——413 基于头即回，不等体收完
  t.after(() => client.destroy());
  await waitFor(() => client.text.includes("HTTP/1.1 413"), 2000, "413 response");
  const body = client.text.slice(client.text.indexOf("\r\n\r\n"));
  assert.match(body, /exceeds the mapping limit of 1048576 bytes/);
  assert.match(body, /zero bytes were forwarded/);
  assert.equal(bridge.fetchCalls.length, 0, "zero forwarding");
});

// ---- Scenario 3：未知长度累计拒绝 --------------------------------------------------

test("scenario 3: unknown content-length (chunked) accumulates and disconnects immediately at the limit", async (t) => {
  const { bridge, localPort } = await twoMachines(t, { config: { maxBodyMiB: 1 } });
  const limitBytes = 1024 * 1024;
  const declared = limitBytes + 512 * 1024; // 声明 1.5MiB 分块
  const client = rawClient(
    localPort,
    `POST /stream-upload HTTP/1.1\r\nHost: localhost:${localPort}\r\nTransfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\n\r\n${declared.toString(16)}\r\n`,
  );
  t.after(() => client.destroy());
  // 只发送超过上限的部分（1.1MiB）然后停手：立即断开语义=服务端在累计越限当下毁
  // 连接，不等剩余体（先缓冲后判的实现会挂到收完才回 413）
  client.write(Buffer.alloc(Math.floor(limitBytes * 1.05)));
  await waitFor(() => client.closed, 2000, "client socket destroyed at limit crossing");
  assert.equal(client.text.includes("HTTP/1.1"), false, "no response was produced (immediate disconnect, not buffered-then-413)");
  assert.equal(bridge.fetchCalls.length, 0, "zero forwarding");
});

// ---- Scenario 4：并发预算与配置硬域 -------------------------------------------------

test("scenario 4: >16 concurrent in-flight → 429 until budget settles; recovery after drain", async (t) => {
  const slowUpstream = (req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("slow-ok");
    }, 350);
  };
  const { localPort, rt } = await twoMachines(t, { upstreamHandler: slowUpstream });
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => request(localPort, { path: "/slow" }).catch((e) => ({ status: 0, error: e }))),
  );
  const statuses = responses.map((r) => r.status);
  assert.equal(
    statuses.filter((s) => s === 429).length,
    4,
    "exactly the requests beyond the 16-slot budget get 429",
  );
  assert.equal(statuses.filter((s) => s === 200).length, 16, "16 in-flight requests succeed");
  assert.equal(statuses.filter((s) => s !== 200 && s !== 429).length, 0, "no transport-level failures");
  assert.equal(rt.budget.maxCount, 16, "budget cap is frozen at 16 (design §4)");
  // 在飞回落后新请求恢复放行
  await waitFor(() => rt.budget.inFlight === 0, 3000, "budget settles");
  const after = await request(localPort, { path: "/slow" });
  assert.equal(after.status, 200);
});

test("scenario 4: 128MiB config is out of the 1-64MiB hard range → mapping refuses to start with a clear error", async (t) => {
  const homeB = await tempHome("wpk-scenario-cfg-");
  t.after(() => rm(homeB, { recursive: true, force: true }));
  const bridge = createFabricBridge(async () => ({ status: 200, bodyChunks: [] }));
  const localPort = await freePort();
  const rt = await createPortsRuntime({
    home: homeB,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: () => ({ sessionId: "s" }),
    config: { maxBodyMiB: 128 },
    drainTimeoutMs: 500,
  });
  await addMapping(homeB, { name: "越界配置", peer: "peer-a", remotePort: 8080, localPort, enabled: true });
  await rt.start();
  t.after(() => rt.stop());
  assert.notEqual(rt.config.configError, null);
  assert.match(rt.config.configError ?? "", /\[1, 64\]/);
  const rows = await rt.listMappings();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].listener, "failed", "out-of-range config refuses to start the mapping");
  assert.match(rows[0].error ?? "", /maxBodyMiB/);
  // 未绑定任何端口：连接被拒（不静默换端口）
  const probe = await new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: localPort });
    s.once("error", () => resolve("refused"));
    s.once("connect", () => {
      s.destroy();
      resolve("connected");
    });
  });
  assert.equal(probe, "refused", "no listener bound for refused mapping");
  assert.equal(bridge.fetchCalls.length, 0);
});

// ---- Scenario 5：授权默认拒绝 -------------------------------------------------------

test("scenario 5: unauthorized peer gets deny from provider — zero upstream forwarding", async (t) => {
  // A 侧 allowlist 不授权 peer-b（grant:false 拓扑）
  const { upstream, bridge, localPort } = await twoMachines(t, { grant: false });
  const res = await request(localPort, { path: "/anything" });
  assert.equal(res.status, 403, "fabric session identity does not match allowlist → deny");
  assert.match(res.text, /not allowed to access port/);
  assert.equal(bridge.fetchCalls.length, 1, "the request did reach the provider endpoint over the session");
  assert.equal(upstream.connections, 0, "zero forwarding to upstream localhost service");
  assert.equal(upstream.hits.length, 0);
});

// ---- Scenario 6：SSE 透传与端口冲突明确失败 -----------------------------------------

test("scenario 6: SSE passes through incrementally (no buffering) until disconnect", async (t) => {
  const sseUpstream = (req, res, _hits, sendTimestamps) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      sendTimestamps.push(Date.now());
      res.write(`data: event-${i}\n\n`);
      if (i >= 8) {
        clearInterval(timer);
        res.end();
      }
    }, 40);
    res.on("close", () => clearInterval(timer));
  };
  const { upstream, localPort } = await twoMachines(t, { upstreamHandler: sseUpstream });
  const client = rawClient(localPort, "GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n");
  t.after(() => client.destroy());
  // 全部事件最终到达
  await waitFor(() => client.text.includes("data: event-8"), 4000, "all SSE events arrive");
  assert.equal((client.text.match(/data: event-\d/g) ?? []).length, 8, "no events lost or duplicated");
  // 增量透传（不缓冲至断开/完成）：第 1 个事件的到达早于上游第 4 次发送
  const firstArrival = client.arrivals.find((a) => a.bytes > 0)?.at ?? 0;
  assert.ok(upstream.sendTimestamps.length >= 8);
  assert.ok(firstArrival < upstream.sendTimestamps[3], "first event must be delivered before the upstream has sent 4 (incremental, not buffered)");
  assert.match(client.text, /content-type: text\/event-stream/i);
});

test("scenario 6: local port already in use → explicit error, no alternative port bound", async (t) => {
  // 先占住一个端口（不属于 ports 的哑服务）
  const squatter = net.createServer((socket) => {
    socket.end("squatter-owns-this-port\n");
  });
  await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const occupiedPort = /** @type {net.AddressInfo} */ (squatter.address()).port;
  t.after(() => new Promise((resolve) => squatter.close(() => resolve(undefined))));

  const homeB = await tempHome("wpk-scenario-conflict-");
  t.after(() => rm(homeB, { recursive: true, force: true }));
  const bridge = createFabricBridge(async () => ({ status: 200, bodyChunks: [] }));
  const rt = await createPortsRuntime({
    home: homeB,
    fetchHttpImpl: bridge.fetchHttpImpl,
    sessionResolver: () => ({ sessionId: "s" }),
    drainTimeoutMs: 500,
  });
  await rt.start();
  t.after(() => rt.stop());
  const added = await rt.addMapping({ name: "冲突映射", peer: "peer-a", remotePort: 8080, localPort: occupiedPort });
  assert.equal(added.ok, true, "mapping is persisted in the ledger");
  assert.equal(/** @type {any} */ (added).listener, "failed");
  assert.match(/** @type {any} */ (added).error ?? "", /EADDRINUSE/);
  assert.match(/** @type {any} */ (added).error ?? "", /already in use/);
  // 端口归属不变：仍是哑服务（未绑定任何替代端口、未抢占）
  const probe = await new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: occupiedPort });
    let got = "";
    s.on("data", (c) => {
      got += c.toString();
    });
    s.on("close", () => resolve(got));
    s.on("error", () => resolve("error"));
  });
  assert.match(probe, /squatter-owns-this-port/);
  const rows = await rt.listMappings();
  assert.equal(rows[0].listener, "failed");
  assert.match(rows[0].error ?? "", /EADDRINUSE/);
});
