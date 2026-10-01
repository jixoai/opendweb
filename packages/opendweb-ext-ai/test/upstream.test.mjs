// 上游转发单测（ai-fly test/unit/provider/upstream.test.ts 矩阵移植；WS 面
// 替换为 v1 显式拒绝）：成功/分片/错误分族（secret_missing/hook_failed/
// upstream_unreachable 零触达/path_not_offered/protocol_error）、超时族
// （注入小值）、abort 链（signal → 上游连接收敛）。真上游 127.0.0.1 listener
// 全部显式回收（t.after 留证）。

import test from "node:test";
import assert from "node:assert/strict";
import { forwardRequest, createCollectingSink, splitBodyChunks, DEFAULT_BODY_CHUNK_BYTES } from "../src/provider/upstream.mjs";
import { startUpstream, waitFor } from "./helpers.mjs";
import { SecretMissingError } from "../src/provider/rewrite.mjs";

const svc = (over = {}) => ({
  serviceId: "s",
  name: "s",
  upstream: "http://127.0.0.1:1",
  match: [{ type: "exact", value: "x" }],
  defaultPort: 4300,
  ...over,
});

const req = (over = {}) => ({ method: "GET", path: "/v1/x", headers: {}, ...over });

/**
 * 直调转发（静态收集 sink）。
 * @param {Record<string, any>} args
 */
async function run(args) {
  const sink = createCollectingSink();
  const signal = args.signal ?? new AbortController().signal;
  const outcome = await forwardRequest({ sink, id: "t1", signal, keyId: "k", ...args });
  return { sink: sink.result(), outcome };
}

test("upstream: 成功——meta/chunk/end 顺序、字节完整、白名单头投影", async (t) => {
  const up = await startUpstream((rq, rs) => {
    rs.writeHead(200, { "content-type": "application/json", "x-request-id": "req-1", "x-drop": "no" });
    rs.end(Buffer.from('{"ok":true}'));
  });
  t.after(() => up.close());

  const { sink } = await run({
    service: svc({ upstream: up.origin }),
    req: req({ method: "POST" }),
    body: Buffer.from("{}"),
    fetchImpl: fetch,
    probeConnect: async () => undefined,
  });
  assert.equal(sink.error, null);
  assert.equal(sink.meta.status, 200);
  assert.equal(sink.meta.contentType, "application/json");
  assert.deepEqual(sink.meta.headers, { "x-request-id": "req-1" }); // 白名单三头挑选
  assert.equal(JSON.stringify(sink.meta.headers).includes("x-drop"), false);
  assert.equal(sink.body.toString(), '{"ok":true}');
  assert.equal(sink.ended, true);
});

test("upstream: SSE 流——分片边界按上游块（字节透明，无事件对齐）；大分片按 256KiB 拆", async (t) => {
  const up = await startUpstream((rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("data: a\n\n");
    setTimeout(() => {
      rs.write("data: b\n\n");
      rs.end();
    }, 20);
  });
  t.after(() => up.close());

  const { sink } = await run({
    service: svc({ upstream: up.origin }),
    req: req({ method: "POST" }),
    body: Buffer.from(""),
    fetchImpl: fetch,
    probeConnect: async () => undefined,
    timeouts: { stallMs: 5000 },
  });
  assert.equal(sink.body.toString(), "data: a\n\ndata: b\n\n");
  // splitBodyChunks 边界：恰好=limit 单片；+1 拆两片
  const exact = new Uint8Array(DEFAULT_BODY_CHUNK_BYTES);
  assert.equal(splitBodyChunks(exact).length, 1);
  const over = new Uint8Array(DEFAULT_BODY_CHUNK_BYTES + 1);
  const pieces = splitBodyChunks(over);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[1].length, 1);
});

test("upstream: probe 失败/超时 → upstream_unreachable，零 fetch（零上游请求）", async (t) => {
  const up = await startUpstream(() => {});
  t.after(() => up.close());
  let fetches = 0;
  const { sink } = await run({
    service: svc({ upstream: up.origin }),
    req: req(),
    body: new Uint8Array(),
    probeConnect: async () => {
      throw new Error("connect timeout");
    },
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("must not be called");
    },
  });
  assert.equal(fetches, 0);
  assert.equal(sink.error.code, "upstream_unreachable");
  assert.equal(sink.ended, false);
});

test("upstream: secret_missing（auth 失效）零上游请求；path_not_offered 本地拒绝", async (t) => {
  const up = await startUpstream(() => {});
  t.after(() => up.close());
  let fetches = 0;
  const noFetch = async () => {
    fetches += 1;
    throw new Error("must not be called");
  };
  const missing = await run({
    service: svc({ upstream: up.origin, auth: { secret: "ghost" } }),
    req: req(),
    body: new Uint8Array(),
    secrets: () => undefined,
    fetchImpl: noFetch,
    probeConnect: async () => undefined,
  });
  assert.equal(missing.sink.error.code, "secret_missing");
  const notOffered = await run({
    service: svc({ upstream: up.origin, routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }] }),
    req: req({ path: "/user" }),
    body: new Uint8Array(),
    fetchImpl: noFetch,
    probeConnect: async () => undefined,
  });
  assert.equal(notOffered.sink.error.code, "path_not_offered");
  assert.equal(fetches, 0);
});

test("upstream: GET 携带正文 → protocol_error；WS 升级 → v1 显式拒绝（零上游）", async (t) => {
  const up = await startUpstream(() => {});
  t.after(() => up.close());
  const getBody = await run({
    service: svc({ upstream: up.origin }),
    req: req({ method: "GET" }),
    body: Buffer.from("x"),
    fetchImpl: fetch,
    probeConnect: async () => undefined,
  });
  assert.equal(getBody.sink.error.code, "protocol_error");
  const ws = await run({
    service: svc({ upstream: up.origin }),
    req: req({ headers: { connection: "Upgrade", upgrade: "websocket" } }),
    body: new Uint8Array(),
    fetchImpl: fetch,
    probeConnect: async () => undefined,
  });
  assert.equal(ws.sink.error.code, "protocol_error");
  assert.match(ws.sink.error.message, /websocket/);
});

test("upstream: abort 链——外部 signal 中止 → 上游连接收敛 + aborted 结算", async (t) => {
  const up = await startUpstream((rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    // 挂住不结束：等待被中止
    rs.write("data: partial\n\n");
  });
  t.after(() => up.close());
  const controller = new AbortController();
  const promise = run({
    service: svc({ upstream: up.origin }),
    req: req({ method: "POST" }),
    body: Buffer.from(""),
    signal: controller.signal,
    fetchImpl: fetch,
    probeConnect: async () => undefined,
    timeouts: { stallMs: 10_000 },
  });
  await waitFor(() => up.hits.length === 1, 3000, "upstream request arrival");
  controller.abort();
  const { sink } = await promise;
  assert.notEqual(sink.error, null);
  assert.equal(sink.error.code, "aborted");
  assert.equal(sink.ended, false);
  await waitFor(() => up.activeConnections === 0, 3000, "upstream connection teardown after abort");
});

test("upstream: 流停滞超时（stallMs 注入）→ idle_timeout；③ 脚本接管路径 hook_failed 分族", async (t) => {
  const up = await startUpstream((rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("data: a\n\n");
    // 永不结束且不再写——停滞
  });
  t.after(() => up.close());
  const stalled = await run({
    service: svc({ upstream: up.origin }),
    req: req({ method: "POST" }),
    body: Buffer.from(""),
    fetchImpl: fetch,
    probeConnect: async () => undefined,
    timeouts: { stallMs: 80 },
  });
  assert.equal(stalled.sink.error.code, "idle_timeout");
  await waitFor(() => up.activeConnections === 0, 3000, "teardown after stall timeout");
});

test("upstream: ③ onRequest 脚本接管（loader 注入）——成功与失败分族（hook_failed）", async () => {
  const loader = (name) =>
    ({
      takeover: {
        onRequest: async () => ({ status: 201, headers: { "content-type": "application/x-test" }, body: (async function* () { yield Buffer.from("sb"); })() }),
      },
      broken: {
        onRequest: async () => {
          throw new Error("kaboom");
        },
      },
      badshape: { onRequest: async () => ({ status: 42, headers: {} }) },
    })[name];
  const ok = await run({
    service: svc({ request: { script: "takeover" } }),
    req: req({ method: "POST" }),
    body: Buffer.from(""),
    loader,
    probeConnect: async () => {
      throw new Error("probe must be skipped for script path");
    },
  });
  assert.equal(ok.sink.meta.status, 201);
  // ③ 返回头经 RESP_META 投影：白名单外头（x-from 等）不外泄、content-type 独立投影
  assert.equal(ok.sink.meta.contentType, "application/x-test");
  assert.equal(ok.sink.meta.headers, undefined);
  assert.equal(ok.sink.body.toString(), "sb");
  for (const script of ["broken", "badshape"]) {
    const failed = await run({
      service: svc({ request: { script } }),
      req: req({ method: "POST" }),
      body: Buffer.from(""),
      loader,
    });
    assert.equal(failed.sink.error.code, "hook_failed", script);
  }
});

test("upstream: ④ onResponse 变换——status/headers 覆盖与 body 替换", async (t) => {
  const up = await startUpstream((rq, rs) => {
    rs.writeHead(200, { "content-type": "text/plain" });
    rs.end("original");
  });
  t.after(() => up.close());
  const loader = (name) => ({
    transform: {
      onResponse: async (ctx) => {
        const parts = [];
        for await (const b of ctx.body) parts.push(b);
        assert.equal(Buffer.concat(parts).toString(), "original");
        return { status: 299, headers: { "x-t": "1" }, body: (async function* () { yield Buffer.from("replaced"); })() };
      },
    },
  })[name];
  const { sink } = await run({
    service: svc({ upstream: up.origin, response: { script: "transform" } }),
    req: req({ method: "POST" }),
    body: Buffer.from(""),
    loader,
    fetchImpl: fetch,
    probeConnect: async () => undefined,
  });
  assert.equal(sink.meta.status, 299);
  assert.equal(sink.body.toString(), "replaced");
});

test("upstream: 错误消息脱敏——SecretMissingError 消息不含密钥名", () => {
  const e = new SecretMissingError();
  assert.equal(e.message, "referenced secret is missing");
});
