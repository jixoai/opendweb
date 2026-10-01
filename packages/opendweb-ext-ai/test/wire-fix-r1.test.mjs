// codex 实现终审 r1 修复回归（wire 面）：
// - P1-4 response 端点 body 必须为空：1 字节与分块 1 字节 body → 400
//   metadata_invalid（冻结 ABI：POST response/<rid> body 为空；旧实现上限 1
//   恰好一字节时漏拒）；
// - P1-5 serviceId 双源检测用解析后的上游 path（x-odai-path 的值）+ URL 查询
//   解析器规范化 percent encoding——`x-odai-path: /v1/models?serviceId=evil`
//   明文/编码变体 → 400 且 forward 未被调用（承载端点 path 检测保留）；
// - P2-3 catalog since 坏 percent encoding → 400 metadata_invalid（旧实现
//   decodeURIComponent 抛异常被外层折叠为 500）。

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir, callWire, headers, jsonBytes } from "./helpers.mjs";
import { ProviderStore } from "../src/provider/store.mjs";
import { createAiProviderWireHandler, serviceIdDuplicateSource } from "../src/wire/endpoints.mjs";
import { HDR_KEY_ID, HDR_METHOD, HDR_PATH, HDR_SERVICE } from "../src/wire/constants.mjs";

/** 装配：openai 服务 + alpha 组一钥。 */
async function fixture(home) {
  const store = await ProviderStore.open(aiDataDir(home));
  await store.addService({
    name: "openai",
    upstream: "https://api.openai.com",
    match: [{ type: "suffix", value: ".openai.com" }],
    defaultPort: 4300,
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
  });
  await store.addGroup("alpha", ["openai"]);
  const key = await store.issueKey("alpha");
  return { store, key };
}

/**
 * 转发面替身（计数注入面——不触网）。
 * @param {(input: unknown) => object} impl
 */
function fakeForwardPlane(impl) {
  return {
    epoch: "ep-test",
    async request(input) {
      return impl(input);
    },
  };
}

const okUpstream = () => ({ ok: true, responseId: "ep-test:1", epoch: "ep-test", status: 200, headers: {}, bytes: 2 });

/**
 * 多块 body 直调（callWire 单块限制之外——分块注入面）。
 * @param {(req: unknown, peer: string) => Promise<unknown>} handler
 * @param {{ method?: string, path?: string, headers?: Array<{name: string, value: string}>, chunks?: Buffer[] }} opts
 */
async function callWireChunked(handler, opts = {}) {
  const chunks = opts.chunks ?? [];
  let idx = 0;
  const controller = new AbortController();
  const req = {
    requestId: 1,
    streamId: 1,
    sessionId: "sess-test",
    signal: controller.signal,
    method: opts.method ?? "POST",
    path: opts.path ?? "/wpk1/ai/v1/response/x",
    headers: opts.headers ?? [],
    bodyNext: async () => (idx < chunks.length ? chunks[idx++] : null),
    respondStreaming: () => null,
  };
  const res = /** @type {any} */ (await handler(req, "peer-test"));
  return {
    status: res?.status,
    body: Buffer.concat((res?.bodyChunks ?? []).map((c) => Buffer.from(c))),
    json() {
      return JSON.parse(this.body.toString("utf8"));
    },
  };
}

// ---------------------------------------------------------------------------
// P1-4 response 端点 body 必须为空
// ---------------------------------------------------------------------------

test("P1-4: response 端点 1 字节 body=400 metadata_invalid（relay 零触达）；空 body 对照放行", async (t) => {
  const home = await tempHome("odai-wirefix-body-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, key } = await fixture(home);
  let pulls = 0;
  const handler = createAiProviderWireHandler({
    store,
    forwardPlane: {
      epoch: "ep-test",
      request: async () => okUpstream(),
      relay: {
        pull: async () => {
          pulls += 1;
          return { status: 204, headers: [], bodyChunks: [] };
        },
        cancel: async () => ({ status: 200, headers: [], bodyChunks: [] }),
      },
    },
  });
  const pullHeaders = () => headers([HDR_KEY_ID, key.keyId], ["x-odai-from-seq", "0"]);
  // 单块 1 字节
  const one = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/response/ep-test:1",
    headers: pullHeaders(),
    body: Buffer.from("x"),
  });
  assert.equal(one.status, 400);
  assert.equal(one.json().code, "metadata_invalid");
  // 分块 1 字节（两块合计 1 字节）
  const chunked = await callWireChunked(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/response/ep-test:1",
    headers: pullHeaders(),
    chunks: [Buffer.from("x"), Buffer.alloc(0)],
  });
  assert.equal(chunked.status, 400);
  assert.equal(chunked.json().code, "metadata_invalid");
  // 空 body 对照：进入 relay
  const empty = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/response/ep-test:1",
    headers: pullHeaders(),
  });
  assert.equal(empty.status, 204);
  assert.equal(pulls, 1, "仅空 body 对照触达 relay（1 字节/分块 1 字节均前置 400）");
});

// ---------------------------------------------------------------------------
// P1-5 serviceId 双源：解析后的上游 path + percent encoding 规范化
// ---------------------------------------------------------------------------

test("P1-5: x-odai-path 查询串携带 serviceId（明文+编码变体）→400 service_source_conflict 且 forward 零调用", async (t) => {
  const home = await tempHome("odai-wirefix-dual-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, key } = await fixture(home);
  let forwards = 0;
  const handler = createAiProviderWireHandler({
    store,
    forwardPlane: fakeForwardPlane(() => {
      forwards += 1;
      return okUpstream();
    }),
  });
  const svcId = store.getServiceByName("openai").serviceId;
  const mk = (upstreamPath) => callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, svcId], [HDR_METHOD, "GET"], [HDR_PATH, upstreamPath], [HDR_KEY_ID, key.keyId]),
  });
  // 明文（旧实现漏检——承载端点 path 干净即放行）
  const plain = await mk("/v1/models?serviceId=evil");
  assert.equal(plain.status, 400);
  assert.equal(plain.json().code, "service_source_conflict");
  // 编码键变体（URL 查询解析器规范化 percent encoding）
  for (const variant of [
    "/v1/models?servi%63eId=evil", // 'c' 编码 → serviceId
    "/v1/models?%73erviceId=evil", // 's' 编码 → serviceId
    "/v1/models?service=%65vil", // service
    "/v1/models?x-odai-servi%63e=evil", // x-odai-service
    "/v1/models?x%2Dodai-service=evil", // '-' 编码
  ]) {
    const res = await mk(variant);
    assert.equal(res.status, 400, `${variant} 必须 400`);
    assert.equal(res.json().code, "service_source_conflict");
  }
  assert.equal(forwards, 0, "全部冲突请求零 forward 触达");
  // 对照：无关查询串放行
  const clean = await mk("/v1/models?limit=2");
  assert.equal(clean.status, 200);
  assert.equal(forwards, 1);
  // 纯函数面：编码键检测
  assert.equal(serviceIdDuplicateSource("/x?servi%63eId=a", Buffer.alloc(0)), true);
  assert.equal(serviceIdDuplicateSource("/x?service%49d=a", Buffer.alloc(0)), true);
  assert.equal(serviceIdDuplicateSource("/x?serviced=a", Buffer.alloc(0)), false);
  assert.equal(serviceIdDuplicateSource("/x?limit=1", Buffer.alloc(0)), false);
});

// ---------------------------------------------------------------------------
// P2-3 catalog since 坏 percent encoding → 400
// ---------------------------------------------------------------------------

test("P2-3: catalog since 坏 percent encoding →400 metadata_invalid（非 500）", async (t) => {
  const home = await tempHome("odai-wirefix-cat-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, key } = await fixture(home);
  const handler = createAiProviderWireHandler({ store, forwardPlane: fakeForwardPlane(okUpstream) });
  for (const bad of ["%zz", "%E0%A4%A", "%"]) {
    const res = await callWire(handler, {
      method: "GET",
      path: `/wpk1/ai/v1/catalog?since=${bad}`,
      headers: headers([HDR_KEY_ID, key.keyId]),
    });
    assert.equal(res.status, 400, `since=${bad} 必须 400`);
    assert.equal(res.json().code, "metadata_invalid");
  }
  // 对照：合法 since（数字/编码数字）正常
  const okNum = await callWire(handler, {
    method: "GET",
    path: "/wpk1/ai/v1/catalog?since=0",
    headers: headers([HDR_KEY_ID, key.keyId]),
  });
  assert.equal(okNum.status, 200);
  const okEnc = await callWire(handler, {
    method: "GET",
    path: "/wpk1/ai/v1/catalog?since=%31",
    headers: headers([HDR_KEY_ID, key.keyId]),
  });
  assert.equal(okEnc.status, 200);
});
