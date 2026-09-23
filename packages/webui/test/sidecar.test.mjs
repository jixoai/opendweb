// sidecar.mjs 矩阵（webui-console A.8 / design §2.2-§2.4 / spec 场景）。
// 覆盖：setup 503 no-target、配对面三重防线（无码/错码/坏 Origin/坏 Host/
// 连败 5 次销毁/成功冻结/再提交 target-frozen/配对码过期）、/api 入站路径
// 矩阵（404 且假上游零收包）、方法白名单、请求 64KiB 界、上游 1MiB 界
// （超限 abort + 502 upstream-too-large）、hop-by-hop/白名单头、3xx 透传、
// 逐请求连接不复用、日志无 token、静态面（dist 缺失占位/SPA fallback/
// 越界不逃逸 dist）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { startSidecar, parseApiPath, LIMITS, maskTarget } from "../src/sidecar.mjs";
import { fakeUpstream, fakeDns, request, postJson } from "./helpers.mjs";

/** ready 态 sidecar（指向假上游）+ 捕获日志 */
async function readySidecar(upstream, { token = "sekret-token-xyz", logs = [] } = {}) {
  const sc = await startSidecar({
    target: {
      scheme: "http",
      hostname: "127.0.0.1",
      port: upstream.port,
      hostHeader: `127.0.0.1:${upstream.port}`,
      connectHost: "127.0.0.1",
      servername: null,
      insecure: false,
    },
    token,
    log: (line) => logs.push(line),
  });
  return sc;
}

test.afterEach(async () => {}); // 各用例自管 close（t.after 显式挂）

// ---- setup 态 ----

test("bind face is loopback-only: non-loopback local interfaces cannot reach the sidecar", async (t) => {
  const os = await import("node:os");
  const sc = await startSidecar({});
  t.after(() => sc.close());
  assert.match(sc.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  // 有 routable 接口的环境上实测不可达（纯 loopback 容器里跳过实测）
  const routable = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i !== null && i.family === "IPv4" && !i.internal);
  if (routable.length === 0) return;
  const probe = routable[0].address;
  const reachable = await new Promise((resolve) => {
    const sock = net.connect({ host: probe, port: sc.port, timeout: 800 });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
  assert.equal(reachable, false, `sidecar must not be reachable via ${probe}`);
});

test("setup mode: /api/* returns 503 no-target; pairing code exposed only via handle", async (t) => {
  const logs = [];
  const sc = await startSidecar({ log: (l) => logs.push(l) });
  t.after(() => sc.close());
  assert.equal(sc.mode(), "setup");
  assert.match(sc.pairingCode, /^[A-Z2-7]{13}$/, "8 bytes base32 = 13 chars");
  const res = await request(sc.port, { path: "/api/status" });
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.text).error.code, "no-target");
});

// ---- /api 入站路径矩阵：404 且零出站 ----

test("inbound path matrix: all rejected with 404 and ZERO upstream traffic", async (t) => {
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); } });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  const badPaths = [
    "/api/../status",
    "/api/%2e%2e/status",
    "/api/%2E%2E/status",
    "/api/a%2fb",
    "/api/a%5cb",
    "/api/a\\b",
    "/api//x",
    "/api/x/",
    "/api/./x",
    "/api",
    "/api/",
    "/api/x/../y",
    "/api?x=1",
  ];
  for (const p of badPaths) {
    const res = await request(sc.port, { path: p });
    assert.equal(res.status, 404, `${p} must 404`);
  }
  assert.equal(upstream.hits.length, 0, "zero upstream requests");
  assert.equal(upstream.connections, 0, "zero upstream connections");
});

test("valid /api path proxies to /admin/* with Bearer injection", async (t) => {
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"mode":"restricted"}'); } });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/api/status" });
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"mode":"restricted"}');
  assert.equal(upstream.hits.length, 1);
  assert.equal(upstream.hits[0].url, "/admin/status");
  assert.equal(upstream.hits[0].headers.authorization, "Bearer sekret-token-xyz");
  assert.equal(upstream.hits[0].headers.host, `127.0.0.1:${upstream.port}`);
});

test("method whitelist: PUT/HEAD on /api rejected 405, DELETE/PATCH pass", async (t) => {
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(204); res.end(); } });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  assert.equal((await request(sc.port, { method: "PUT", path: "/api/x" })).status, 405);
  assert.equal(upstream.hits.length, 0);
  const del = await request(sc.port, { method: "DELETE", path: "/api/owners/aa/bb" });
  assert.equal(del.status, 204);
  assert.equal(upstream.hits[0].url, "/admin/owners/aa/bb");
  assert.equal(upstream.hits[0].method, "DELETE");
  // PATCH 透传（server-access-roles 1c：别名/备注元数据编辑路由 /admin/owners|visitors/*）
  const patch = await request(sc.port, { method: "PATCH", path: "/api/visitors/cc" });
  assert.equal(patch.status, 204);
  assert.equal(upstream.hits[1].url, "/admin/visitors/cc");
  assert.equal(upstream.hits[1].method, "PATCH");
});

test("POST body forwarded verbatim with content-type; query passthrough", async (t) => {
  const upstream = await fakeUpstream({ handler: (req, res, hits) => { res.writeHead(200); res.end(hits[hits.length - 1].body); } });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  const payload = JSON.stringify({ fabric_id_hex: "ab".repeat(32), root_hex: "cd".repeat(32) });
  const res = await request(sc.port, {
    method: "POST",
    path: "/api/owners?dry=1",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  assert.equal(res.status, 200);
  assert.equal(res.text, payload);
  assert.equal(upstream.hits[0].url, "/admin/owners?dry=1");
  assert.equal(upstream.hits[0].headers["content-type"], "application/json");
});

test("request body boundary: 64KiB passes, 64KiB+1 rejected 413 with zero upstream", async (t) => {
  const upstream = await fakeUpstream({ handler: (req, res, hits) => { res.writeHead(200); res.end(`len:${hits[hits.length - 1].body.length}`); } });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  const exact = await request(sc.port, { method: "POST", path: "/api/owners", body: Buffer.alloc(LIMITS.requestBytes, 0x61) });
  assert.equal(exact.status, 200);
  assert.equal(exact.text, `len:${LIMITS.requestBytes}`);
  const over = await request(sc.port, { method: "POST", path: "/api/owners", body: Buffer.alloc(LIMITS.requestBytes + 1, 0x61) });
  assert.equal(over.status, 413);
  assert.equal(JSON.parse(over.text).error.code, "request-too-large");
  assert.equal(upstream.hits.length, 1, "only the exact-size request reached upstream");
});

test("upstream body boundary: exactly 1MiB passes, over aborts with 502 upstream-too-large", async (t) => {
  let body;
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      if (req.url === "/admin/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(body);
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    },
  });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  body = Buffer.alloc(LIMITS.responseBytes, 0x62);
  const exact = await request(sc.port, { path: "/api/big" });
  assert.equal(exact.status, 200);
  assert.equal(exact.body.length, LIMITS.responseBytes);
  body = Buffer.alloc(LIMITS.responseBytes + 1, 0x63);
  const over = await request(sc.port, { path: "/api/big" });
  assert.equal(over.status, 502);
  assert.deepEqual(JSON.parse(over.text).error.code, "upstream-too-large");
});

test("upstream too-large aborts the upstream socket (connection closed, not lingering)", async (t) => {
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.alloc(1024 * 1024 + 1024, 0x64));
      // 不主动 end：等 sidecar abort
    },
  });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/api/status" });
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.text).error.code, "upstream-too-large");
  // 上游 socket 被 abort 回收（closedConnections 追上 connections）
  await new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (upstream.closedConnections >= 1 || Date.now() - start > 5000) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, 20);
  });
  assert.ok(upstream.closedConnections >= 1, "upstream socket was destroyed after abort");
});

test("response header whitelist: content-type passes, custom/hop-by-hop stripped", async (t) => {
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-drop-me": "yes",
        etag: '"abc123"',
        connection: "keep-alive",
        "proxy-authenticate": "Basic",
      });
      res.end("{}");
    },
  });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/api/status" });
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers.etag, '"abc123"');
  assert.equal(res.headers["x-drop-me"], undefined);
  assert.equal(res.headers["proxy-authenticate"], undefined);
  assert.equal(res.headers.trailer, undefined);
});

test("3xx passed through as-is (no redirect following; whitelist strips location)", async (t) => {
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(302, { location: "http://evil.example/admin/elsewhere" });
      res.end();
    },
  });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/api/status" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, undefined, "non-whitelisted header stripped per design §2.3");
  assert.equal(upstream.hits.length, 1, "no second (followed) request");
});

test("per-request connections: N sequential requests = N upstream connections (no keep-alive reuse)", async (t) => {
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(200); res.end("{}"); } });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  for (let i = 0; i < 4; i++) {
    const res = await request(sc.port, { path: "/api/status" });
    assert.equal(res.status, 200);
  }
  assert.equal(upstream.hits.length, 4);
  assert.equal(upstream.connections, 4, "each request built a fresh connection");
});

test("logs contain method/path/status/duration only - never token or headers", async (t) => {
  const logs = [];
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); } });
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream, { token: "sekret-token-xyz", logs });
  t.after(() => sc.close());
  await request(sc.port, { path: "/api/status" });
  await request(sc.port, { path: "/api/../escape" });
  await postJson(sc.port, "/sidecar/connect", {});
  assert.ok(logs.some((l) => /^GET \/api\/status 200 \d+ms$/.test(l)), JSON.stringify(logs));
  for (const line of logs) {
    assert.ok(!line.includes("sekret-token-xyz"), `token leaked to log: ${line}`);
    assert.ok(!line.includes("authorization"), `header name leaked: ${line}`);
  }
});

// ---- 配对面 ----

async function setupSidecar({ logs = [], dns } = {}) {
  const sc = await startSidecar({ log: (l) => logs.push(l), dns });
  return sc;
}

function connectBody(sc, server, overrides = {}) {
  return { pairing_code: sc.pairingCode, server, token: "pair-token-qq", ...overrides };
}

test("pairing: correct Host + no Origin + correct code -> frozen; business flows; re-submit -> target-frozen", async (t) => {
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"mode":"restricted"}'); } });
  t.after(() => upstream.close());
  const sc = await setupSidecar();
  t.after(() => sc.close());
  const res = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(JSON.parse(res.text), { ok: true }, "no token echo in response");
  assert.equal(sc.mode(), "ready");
  // 业务通：Bearer 是配对面提交的 token
  const biz = await request(sc.port, { path: "/api/status" });
  assert.equal(biz.status, 200);
  assert.equal(upstream.hits[0].headers.authorization, "Bearer pair-token-qq");
  // 再提交 → target-frozen
  const again = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url));
  assert.equal(again.status, 400);
  assert.equal(JSON.parse(again.text).error.code, "target-frozen");
});

test("pairing: concurrent connects with delayed DNS -> exactly one 200 (single-flight, r5-P0-1)", async (t) => {
  const upstream = await fakeUpstream({ handler: (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"mode":"restricted"}'); } });
  t.after(() => upstream.close());
  // 延迟 DNS：validateTarget 让出事件循环足够久，两个并发请求都能到达校验段
  const slowDns = {
    lookup: async (hostname) => {
      await new Promise((r) => setTimeout(r, 150));
      return [{ address: "127.0.0.1", family: 4 }];
    },
  };
  const sc = await setupSidecar({ dns: slowDns });
  t.after(() => sc.close());
  // localhost 主机名触发 DNS 全记录校验路径（字面 IP 会跳过 DNS，无竞态窗口）
  const upstreamPort = new URL(upstream.url).port;
  const body = connectBody(sc, `http://localhost:${upstreamPort}`);
  // 独立连接（默认 Agent keepAlive=false）强制真并发——全局 agent 的
  // keep-alive 会把两请求串行化到一条 socket 上，测不出竞态
  const mk = () => new http.Agent();
  const buf = JSON.stringify(body);
  const post = (agent) => request(sc.port, {
    method: "POST",
    path: "/sidecar/connect",
    headers: { "content-type": "application/json" },
    body: buf,
    agent,
  });
  const [a, b] = await Promise.all([post(mk()), post(mk())]);
  const codes = [a.status, b.status].sort();
  assert.equal(codes[0], 200, `one must succeed: ${a.status}/${b.status}`);
  assert.equal(codes[1], 409, `the other must be pairing-in-progress, got ${codes}`);
  assert.equal(sc.mode(), "ready");
  // 目标冻结后第三个请求（同码）→ target-frozen（码已消费或状态已离开 setup）
  const third = await postJson(sc.port, "/sidecar/connect", body);
  assert.equal(JSON.parse(third.text).error.code, "target-frozen");
});

test("pairing: wrong code 5 times burns the code (correct code then rejected)", async (t) => {
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const sc = await setupSidecar();
  t.after(() => sc.close());
  for (let i = 0; i < 4; i++) {
    const r = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url, { pairing_code: "WRONGWRONGWRON" }));
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.text).error.code, "bad-pairing");
  }
  // 第 5 次失败销毁
  const fifth = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url, { pairing_code: "WRONGWRONGWRON" }));
  assert.equal(JSON.parse(fifth.text).error.code, "bad-pairing");
  // 正确码也进不来了
  const correct = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url));
  assert.equal(correct.status, 400);
  assert.equal(JSON.parse(correct.text).error.code, "bad-pairing");
  assert.equal(sc.mode(), "setup");
});

test("pairing: missing code counts as a bad attempt; 4 wrongs then correct still works", async (t) => {
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const sc = await setupSidecar();
  t.after(() => sc.close());
  for (let i = 0; i < 4; i++) {
    const r = await postJson(sc.port, "/sidecar/connect", { server: upstream.url, token: "t" });
    assert.equal(JSON.parse(r.text).error.code, "bad-pairing");
  }
  const okRes = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url));
  assert.equal(okRes.status, 200, "5th attempt with correct code succeeds (threshold not hit)");
});

test("pairing: bad Host header rejected and does NOT burn pairing attempts", async (t) => {
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const sc = await setupSidecar();
  t.after(() => sc.close());
  for (let i = 0; i < 6; i++) {
    const r = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url), { host: "evil.example" });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.text).error.code, "bad-origin-host");
  }
  // Host 校验先于配对码——次数未被烧，正确请求仍成功
  const okRes = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url));
  assert.equal(okRes.status, 200);
});

test("pairing: cross-origin rejected (evil.com Origin)", async (t) => {
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const sc = await setupSidecar();
  t.after(() => sc.close());
  const r = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url), { origin: "http://evil.example" });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error.code, "bad-origin-host");
  assert.equal(sc.mode(), "setup");
});

test("pairing: same-origin Origin header accepted", async (t) => {
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const sc = await setupSidecar();
  t.after(() => sc.close());
  const r = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url), { origin: sc.origin });
  assert.equal(r.status, 200, r.text);
});

test("pairing: bad target rejected as bad-target, code not burned (URL typo retryable)", async (t) => {
  const sc = await setupSidecar();
  t.after(() => sc.close());
  const bad = await postJson(sc.port, "/sidecar/connect", connectBody(sc, "http://203.0.113.10:18787"));
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.text).error.code, "bad-target");
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const okRes = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url));
  assert.equal(okRes.status, 200, "same code still valid after a bad-target attempt");
});

test("pairing: code expires after 10 minutes (injected clock)", async (t) => {
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  let clock = 1_000_000;
  const sc = await startSidecar({ now: () => clock });
  t.after(() => sc.close());
  clock += LIMITS.pairingTtlMs + 1;
  const r = await postJson(sc.port, "/sidecar/connect", connectBody(sc, upstream.url));
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error.code, "bad-pairing");
  assert.equal(sc.mode(), "setup");
});

test("pairing: non-POST and unknown /sidecar paths -> 404; malformed JSON -> invalid-request", async (t) => {
  const sc = await setupSidecar();
  t.after(() => sc.close());
  assert.equal((await request(sc.port, { method: "GET", path: "/sidecar/connect" })).status, 404);
  assert.equal((await request(sc.port, { method: "POST", path: "/sidecar/other" })).status, 404);
  const r = await request(sc.port, { method: "POST", path: "/sidecar/connect", body: "not json" });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error.code, "invalid-request");
});

// ---- /sidecar/state（SPA 启动期状态暴露面） ----

test("sidecar state: setup phase exposes phase/null host/insecure=false, never the pairing code or token", async (t) => {
  const sc = await startSidecar({ token: "" });
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/sidecar/state" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["cache-control"], "no-store");
  const body = JSON.parse(res.text);
  // home-hub 2b 增量字段：role/hub_local（加性——旧消费者忽略未知字段）
  assert.deepEqual(body, { phase: "setup", server_host_masked: null, insecure: false, role: "admin", hub_local: false });
  assert.ok(!res.text.includes(sc.pairingCode ?? ""), "pairing code must not leak to HTTP");
});

test("sidecar state: ready phase exposes masked host and insecure flag, never the token", async (t) => {
  const upstream = await fakeUpstream();
  t.after(() => upstream.close());
  const sc = await readySidecar(upstream);
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/sidecar/state" });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.phase, "ready");
  assert.equal(body.server_host_masked, `http://127.0.0.***:${upstream.port}`);
  assert.equal(body.insecure, false);
  assert.ok(!res.text.includes("sekret-token-xyz"), "token must not leak");
});

test("sidecar state: insecure http target flips the insecure flag (plaintext banner source)", async (t) => {
  const sc = await startSidecar({
    target: {
      scheme: "http",
      hostname: "srv.example",
      port: 18787,
      hostHeader: "srv.example:18787",
      connectHost: "192.0.2.10",
      servername: "srv.example",
      insecure: true,
    },
    token: "t-ok",
  });
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/sidecar/state" });
  const body = JSON.parse(res.text);
  assert.equal(body.phase, "ready");
  assert.equal(body.server_host_masked, "http://***.example:18787");
  assert.equal(body.insecure, true);
});

test("maskTarget unit matrix", () => {
  assert.equal(maskTarget({ scheme: "http", hostname: "localhost", port: 80 }), "http://***");
  assert.equal(maskTarget({ scheme: "http", hostname: "127.0.0.1", port: 8080 }), "http://127.0.0.***:8080");
  assert.equal(maskTarget({ scheme: "https", hostname: "srv.example", port: 443 }), "https://***.example");
  assert.equal(maskTarget({ scheme: "https", hostname: "a.b.c.example", port: 8443 }), "https://***.b.c.example:8443");
  assert.equal(maskTarget({ scheme: "http", hostname: "::1", port: 9000 }), "http://[***]:9000");
});

// ---- 静态面 ----

test("static: missing dist serves the placeholder page (explicit degradation)", async (t) => {
  const sc = await startSidecar({ distDir: path.join(await mkdtemp(path.join(tmpdir(), "webui-nodist-")), "dist") });
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/" });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /^text\/html/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.text, /UI is not built/);
  assert.match(res.text, /dist\//);
  // SPA 任意路径同样落到占位页
  const deep = await request(sc.port, { path: "/status" });
  assert.match(deep.text, /UI is not built/);
});

test("static: dist served with no-store, SPA fallback, no traversal escape", async (t) => {
  const tmp = await mkdtemp(path.join(tmpdir(), "webui-dist-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dist = path.join(tmp, "dist");
  await mkdir(dist);
  await writeFile(path.join(dist, "index.html"), "<html>index-marker</html>");
  await mkdir(path.join(dist, "assets"));
  await writeFile(path.join(dist, "assets", "app.js"), "console.log(1)");
  await writeFile(path.join(tmp, "secret-outside.txt"), "TOP-SECRET-FILE");
  const sc = await startSidecar({ distDir: dist });
  t.after(() => sc.close());
  const root = await request(sc.port, { path: "/" });
  assert.match(root.text, /index-marker/);
  assert.equal(root.headers["cache-control"], "no-store");
  const js = await request(sc.port, { path: "/assets/app.js" });
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(js.text, "console.log(1)");
  const spa = await request(sc.port, { path: "/connections" });
  assert.match(spa.text, /index-marker/); // hash 路由 SPA fallback
  // 越界：解码后的 dot-segment 不逃出 dist
  const esc = await request(sc.port, { path: "/%2e%2e/secret-outside.txt" });
  assert.notEqual(esc.text, "TOP-SECRET-FILE");
  const esc2 = await request(sc.port, { path: "/assets/../../../../secret-outside.txt" });
  assert.notEqual(esc2.text, "TOP-SECRET-FILE");
});

// ---- parseApiPath 纯函数直测 ----

test("parseApiPath unit matrix", () => {
  assert.ok(parseApiPath("/api/status").ok);
  assert.deepEqual(parseApiPath("/api/a/b?x=1").value, { rel: "a/b", query: "x=1" });
  for (const p of ["/api", "/api/", "/api/../x", "/api//x", "/api/x/", "/api/a%2fb", "/api/%2e%2e", "/api/a\\b", "", "/other"]) {
    assert.ok(!parseApiPath(p).ok, p);
  }
});

// ---- 上游连接故障 ----

test("upstream connection refused maps to 502 upstream-unreachable", async (t) => {
  // 占一个端口再关掉 → 连接必拒
  const holder = http.createServer(() => {});
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const deadPort = holder.address().port;
  await new Promise((resolve) => holder.close(resolve));
  const sc = await startSidecar({
    target: {
      scheme: "http",
      hostname: "127.0.0.1",
      port: deadPort,
      hostHeader: `127.0.0.1:${deadPort}`,
      connectHost: "127.0.0.1",
      servername: null,
      insecure: false,
    },
    token: "t",
  });
  t.after(() => sc.close());
  const res = await request(sc.port, { path: "/api/status" });
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.text).error.code, "upstream-unreachable");
});

test("close() tears down the listener and in-flight upstream requests", async () => {
  const sc = await startSidecar();
  await sc.close();
  await assert.rejects(() => request(sc.port, { path: "/" }));
});
