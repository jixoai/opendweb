// 消费侧单元面（design §4/§5 的纯函数与不变式）。
// 1. hop-by-hop 剥除清单冻结（connection/keep-alive/transfer-encoding/upgrade/
//    proxy-*）+ host 重写（直连语义）+ content-length 重算；
// 2. 响应方向：server/via 回显重写、content-length 剥除（流式分帧）；
// 3. 预算不变式（≤16 计数 / 字节预算 / 未知长度回填）；
// 4. 配置域校验（1-64MiB 硬边界、默认 8）与代理路径拼装。

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFetchRequestHeaders,
  createProxyBudget,
  DEFAULT_MAX_BODY_MIB,
  MAX_CONCURRENT_PROXIES,
  proxyPath,
  resolveLimitBytes,
} from "../src/proxy.mjs";
import { forwardResponseHeaders, isHopByHop, nodeHeadersToArray } from "../src/headers.mjs";

const MIB = 1024 * 1024;

test("proxy: hop-by-hop strip list is frozen and applied to forwarded requests", () => {
  for (const name of ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-connection", "proxy-authenticate"]) {
    assert.equal(isHopByHop(name), true, `${name} is hop-by-hop`);
  }
  for (const name of ["content-type", "x-custom", "accept", "authorization", "host", "content-length"]) {
    assert.equal(isHopByHop(name), false, `${name} is end-to-end`);
  }
  const out = buildFetchRequestHeaders(
    {
      host: "localhost:9090",
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      upgrade: "websocket",
      "proxy-authorization": "Basic x",
      "content-type": "text/plain",
      "x-custom": "v",
      "content-length": "999",
    },
    8080,
    11,
    true,
  );
  const names = out.map((h) => h.name);
  for (const stripped of ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization"]) {
    assert.equal(names.includes(stripped), false, `${stripped} must be stripped`);
  }
  // host 重写为直连语义 + content-length 按缓冲后实际字节重算
  assert.deepEqual(out.find((h) => h.name === "host"), { name: "host", value: "localhost:8080" });
  assert.deepEqual(out.find((h) => h.name === "content-length"), { name: "content-length", value: "11" });
  assert.deepEqual(out.find((h) => h.name === "x-custom"), { name: "x-custom", value: "v" });
});

test("proxy: response headers — server/via rewritten, hop-by-hop and content-length dropped", () => {
  const out = forwardResponseHeaders([
    { name: "content-type", value: "text/event-stream" },
    { name: "server", value: "nginx/1.25" },
    { name: "via", value: "1.1 upstream-proxy" },
    { name: "connection", value: "keep-alive" },
    { name: "transfer-encoding", value: "chunked" },
    { name: "content-length", value: "123" },
    { name: "x-custom", value: "v" },
  ]);
  const get = (n) => out.find((h) => h.name === n)?.value;
  assert.equal(get("server"), "opendweb-ports", "upstream server header must be rewritten, not echoed");
  assert.equal(get("via"), undefined, "via must not be echoed");
  assert.equal(get("connection"), undefined);
  assert.equal(get("transfer-encoding"), undefined);
  assert.equal(get("content-length"), undefined, "streamed responses re-frame; no length claim");
  assert.equal(get("content-type"), "text/event-stream");
  assert.equal(get("x-custom"), "v");
});

test("proxy: node header object → /http array conversion (set-cookie arrays preserved)", () => {
  const arr = nodeHeadersToArray({ a: "1", "set-cookie": ["x=1", "y=2"], "x-undef": undefined });
  assert.deepEqual(
    arr.sort((x, y) => x.name.localeCompare(y.name)),
    [
      { name: "a", value: "1" },
      { name: "set-cookie", value: "x=1" },
      { name: "set-cookie", value: "y=2" },
    ],
  );
});

test("proxy: budget invariants — 16-slot cap, byte budget, unknown-size backfill", () => {
  const limitBytes = 8 * MIB;
  const budget = createProxyBudget({ maxBytes: 16 * limitBytes });
  const tickets = [];
  for (let i = 0; i < 16; i++) {
    const t = budget.tryAcquire(0);
    assert.ok(t !== null, `request ${i + 1} acquires`);
    tickets.push(t);
  }
  assert.equal(budget.tryAcquire(0), null, "17th request is over the frozen 16-slot budget");
  assert.equal(budget.count, 16);
  tickets[0].release();
  assert.equal(budget.tryAcquire(0) !== null, true, "a slot frees after release");

  // 已知长度入场检查：字节预算 16×limit
  const big = createProxyBudget({ maxBytes: 16 * limitBytes });
  const held = big.tryAcquire(limitBytes);
  assert.ok(held !== null);
  assert.equal(big.tryAcquire(16 * limitBytes), null, "known-size request beyond the byte budget is rejected");
  held.release();

  // 未知长度（null）：0 入账、读体完成后回填真实值——不变式 16×limit 联立保持
  const unknown = createProxyBudget({ maxBytes: 16 * limitBytes });
  const u1 = unknown.tryAcquire(null);
  assert.ok(u1 !== null);
  u1.setBytes(limitBytes);
  assert.equal(unknown.bytes, limitBytes);
  const u2 = unknown.tryAcquire(limitBytes * 15);
  assert.ok(u2 !== null, "15×limit still fits alongside one backfilled limit");
  assert.equal(unknown.tryAcquire(1), null, "beyond 16×limit is over budget");
});

test("proxy: config hard range 64KiB-1MiB (r8-B4 v1 transport envelope) with default 1", () => {
  assert.equal(DEFAULT_MAX_BODY_MIB, 1);
  assert.equal(MAX_CONCURRENT_PROXIES, 16);
  // 界内：1MiB（默认）、0.5MiB、64KiB（下界）
  for (const ok of [1, 0.5, 0.0625]) assert.deepEqual(resolveLimitBytes(ok), { ok: true, bytes: ok * MIB });
  // 界外/非粒度：0、2（旧上界内值——现超 transport 包络必拒）、64、128、8.5
  // （非 64KiB 步进）、-1、"8"
  for (const bad of [0, 2, 64, 128, 8.5, 0.07, -1, "8"]) {
    const r = resolveLimitBytes(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} MiB is out of the hard range`);
    assert.match(/** @type {any} */ (r).error, /64KiB.1MiB/);
  }
});

test("proxy: proxyPath composes wpk1 prefix + original path+query", () => {
  assert.equal(proxyPath(8080, "/foo/bar?x=1&y=2"), "/wpk1/ports/proxy/8080/foo/bar?x=1&y=2");
  assert.equal(proxyPath(8080, "/"), "/wpk1/ports/proxy/8080/");
  assert.equal(proxyPath(80, "*"), "/wpk1/ports/proxy/80/*");
});
