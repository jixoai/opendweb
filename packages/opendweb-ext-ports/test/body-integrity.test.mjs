// 体完整性验收面（真双机实证 2026-09-30：会话翻转/对端取消的截断流曾以
// 「200+空/截断体」外显——ports 等价性承诺：要么成功有体、要么明确失败）。
// 1. 体失败于头未外显 → 502 upstream-body-lost（空响应绝不允许以 200 形态外显）；
// 2. 体失败于头已外显（部分体已回写）→ 销毁连接（传输失败形态，非伪完整 200）；
// 3. 干净 EOF 零体（上游真实空响应）→ 200 + 空体照常透传；
// 4. 响应头延迟提交：首个 body 块到达前不 writeHead（体失败仍可 5xx 的前提）；
// 5. provider 上游被取消掐断 → writer.abort()（显式 RESET 语义）优先于 finish()
//    ——截断不得伪装干净 EOF；上游 socket 同步收敛。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rm } from "node:fs/promises";
import { createInFlightRegistry, createMappingServer, createProxyBudget } from "../src/proxy.mjs";
import { createPortsProxyHandler } from "../src/provider.mjs";
import { grantAccess } from "../src/ledger.mjs";
import { freePort, rawClient, startUpstream, tempHome, waitFor } from "./helpers.mjs";

/**
 * 独立映射 listener（绕过 runtime 装配——fetchHttpImpl 完全脚本化）。
 * @param {import("node:test").TestContext} t
 * @param {(session: unknown, init: unknown) => Promise<{ status: number, headers: Array<{name: string, value: string}>, bodyNext: () => Promise<Buffer | null>, abort?: () => Promise<void> | void }>} fetchHttpImpl
 */
async function mappingServer(t, fetchHttpImpl) {
  const localPort = await freePort();
  const server = createMappingServer({
    mapping: { id: "m-integrity", name: "integrity", peer: "peer-a", remotePort: 8080, localPort, enabled: true },
    limitBytes: 1024 * 1024,
    budget: createProxyBudget({ maxBytes: 16 * 1024 * 1024 }),
    inflight: createInFlightRegistry(),
    fetchHttpImpl,
    sessionResolver: () => ({ sessionId: "sess-test" }),
  });
  const out = await server.start();
  assert.equal(out.ok, true);
  t.after(() => server.stop());
  return localPort;
}

/** 简化 HTTP 客户端（agent:false 逐请求独立连接；完整读至 end/错误） */
function get(port, path = "/") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", (e) => reject(Object.assign(e, { partial: Buffer.concat(chunks).toString("utf8") })));
    });
    req.on("error", reject);
    req.end();
  });
}

test("body integrity: body failure before head surfaces → 502 upstream-body-lost, never an empty 200", async (t) => {
  const port = await mappingServer(t, async () => ({
    status: 200,
    headers: [{ name: "content-type", value: "text/plain" }],
    bodyNext: async () => {
      // 首块前传输即死（RESET/会话终态——内核面映射为错误而非干净 EOF）
      throw new Error("[session] response stream reset by peer");
    },
  }));
  const res = await get(port);
  assert.equal(res.status, 502, "transport death before any body byte must be an explicit 5xx");
  const parsed = JSON.parse(res.text);
  assert.equal(parsed.error.code, "upstream-body-lost");
  assert.match(parsed.error.message, /terminated mid-transfer/);
});

test("body integrity: body failure after partial write destroys the connection — no fake-clean truncated 200", async (t) => {
  let call = 0;
  const port = await mappingServer(t, async () => ({
    status: 200,
    headers: [{ name: "content-type", value: "text/plain" }],
    bodyNext: async () => {
      call += 1;
      if (call === 1) return Buffer.from("partial-body-AAAA");
      throw new Error("[session] response stream reset by peer");
    },
  }));
  const client = rawClient(port, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  t.after(() => client.destroy());
  await client.closedPromise;
  const text = client.text;
  // 不变式：绝不允许「伪完整截断 200」——已外显的字节合法（头+已交付块），
  // 但连接绝不以干净 chunked 终结收尾（destroy 与 socket flush 的竞态允许
  // 两种形态：零字节 RST，或部分字节+RST——都不是干净结束）。
  if (text.length > 0) {
    assert.match(text, /^HTTP\/1\.1 200/, "any surfaced head was legitimately forwarded");
    assert.ok(text.includes("partial-body-AAAA"), "already-delivered chunk is not withdrawn");
  }
  assert.ok(!/\r\n0\r\n\r\n$/.test(text), "connection must NOT terminate as a clean chunked end (truncation is not success)");
});

test("body integrity: clean EOF with zero-length body still passes through as 200+empty", async (t) => {
  const port = await mappingServer(t, async () => ({
    status: 200,
    headers: [{ name: "content-type", value: "text/plain" }],
    bodyNext: async () => null, // 干净 FIN——上游真实空响应
  }));
  const res = await get(port);
  assert.equal(res.status, 200);
  assert.equal(res.text, "");
});

test("body integrity: response head is deferred until the first body chunk", async (t) => {
  /** @type {((v: Buffer | null) => void) | null} */
  let release = null;
  const port = await mappingServer(t, async () => ({
    status: 200,
    headers: [{ name: "content-type", value: "text/plain" }],
    bodyNext: () =>
      new Promise((resolve) => {
        release = /** @param {Buffer | null} v */ (v) => resolve(v);
      }),
  }));
  const client = rawClient(port, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  t.after(() => client.destroy());
  await waitFor(() => release !== null, 2000, "bodyNext pulled");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(client.chunks.length, 0, "no byte may leave before the first body chunk (head deferred)");
  release?.(Buffer.from("first-chunk"));
  await waitFor(() => client.chunks.length > 0, 2000, "head+chunk arrive together");
  assert.match(client.text, /^HTTP\/1\.1 200/);
  assert.ok(client.text.includes("first-chunk"));
  release?.(null); // 干净 EOF
  await client.closedPromise;
});

test("body integrity: provider upstream cancellation mid-stream aborts the writer (RESET), not a fake finish", async (t) => {
  const home = await tempHome("wpk-abort-a-");
  t.after(() => rm(home, { recursive: true, force: true }));
  // 上游：写一块后挂起（模拟取消传播前的在途响应）
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first-chunk");
    /* hang: never end */
  });
  t.after(() => upstream.close());
  await grantAccess(home, "peer-b", upstream.port);

  const controller = new AbortController();
  /** @type {Buffer[]} */ const written = [];
  let finishCalled = false;
  let abortCalled = false;
  let respondStreaming = null;
  /** @type {import("../src/provider.mjs").HttpHandlerRequestLike} */
  const req = {
    requestId: 1,
    streamId: 2,
    sessionId: "sess-abort",
    signal: controller.signal,
    method: "GET",
    path: `/wpk1/ports/proxy/${upstream.port}/`,
    headers: [],
    bodyNext: async () => null,
    respondStreaming(status, headers) {
      respondStreaming = { status, headers: headers ?? [] };
      return {
        write: async (chunk) => {
          written.push(Buffer.from(chunk));
        },
        finish: () => {
          finishCalled = true;
        },
        abort: () => {
          abortCalled = true;
        },
        get finished() {
          return finishCalled;
        },
        get cancelled() {
          return controller.signal.aborted;
        },
        get closed() {
          return finishCalled || abortCalled;
        },
      };
    },
  };
  const handler = createPortsProxyHandler({ home, peer: "peer-b" });
  const handled = handler(req);
  await waitFor(() => written.length === 1 && respondStreaming !== null, 2000, "streaming started, first chunk written");
  assert.equal(written[0].toString(), "first-chunk");
  assert.equal(respondStreaming?.status, 200, "upstream head forwarded");
  // 对端取消（RESET→signal）：上游必须被掐断且以 abort 语义终结——截断响应
  // 不得伪装干净 EOF（消费端将按错误暴露）
  controller.abort();
  await handled;
  assert.equal(abortCalled, true, "writer.abort() (explicit RESET) MUST be used for cancellation");
  assert.equal(finishCalled, false, "finish() MUST NOT be used — a cancelled stream is not a clean EOF");
  await waitFor(() => upstream.activeConnections === 0, 2000, "upstream socket converges");
});
