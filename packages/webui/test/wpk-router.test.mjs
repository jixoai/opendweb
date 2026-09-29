// 聚合路由 × 真实插件 handler 的授权矩阵（webui-plugin-kernel 收官接线 /
// design §3.2 deny-by-default）。不启 Fabric（重）——路由层直挂三包真实
// runtime 的提供侧 handler：
// 1. ports：allowlist 未授权 → 403 且上游零出站；授权 → 代理转发真实本地
//    HTTP 服务（/wpk1/ports/proxy/<port><path> 语义）；
// 2. files：sessionId 未知 → 403 session-unknown；peer 未入 share → 403
//    peer-not-authorized；授权 → list 真实落盘目录（fd 冻结根）；
// 3. sync 适配器：serveHttp 请求形状（bodyNext 拉流）→ sync 端点请求形状
//    （body AsyncIterable+peerEndpointId）；响应 {status, body} → bodyChunks。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPortsRuntime } from "@jixo/opendweb-ext-ports";
import { createFilesRuntime } from "@jixo/opendweb-ext-files";
import { createWpkRouter, adaptSyncHandler } from "../src/core/fabric.mjs";
import { fakeUpstream } from "./helpers.mjs";

const PEER = "ab".repeat(32);
const OTHER_PEER = "cd".repeat(32);

/** serveHttp 类型化请求替身（body 静态分块；respondStreaming 记账）。 */
function typedRequest(over = {}) {
  const controller = new AbortController();
  const bodyQueue = (over.bodyChunks ?? []).map((c) => Buffer.from(c));
  return {
    requestId: 1,
    streamId: 1,
    sessionId: over.sessionId ?? "sess-1",
    signal: controller.signal,
    method: over.method ?? "GET",
    path: over.path ?? "/",
    headers: over.headers ?? [],
    bodyNext: async () => bodyQueue.shift() ?? null,
    respondStreaming: (status, headers) => {
      const streamed = { status, headers: headers ?? [], chunks: [] };
      streamedMeta = streamed;
      return {
        write: async (chunk) => streamed.chunks.push(Buffer.from(chunk)),
        finish: () => {},
        finished: false,
        cancelled: false,
        closed: false,
      };
    },
    ...("respondStreaming" in over ? over : {}),
  };
}
let streamedMeta = null;

async function tempHome(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test.afterEach(() => {});

// ---- ports：allowlist deny-by-default + 真实代理转发 -----------------------------------

test("wpk ports route: ungranted peer is denied with zero upstream traffic; granted peer proxies a real local service", async (t) => {
  const home = await tempHome("wpk-ports-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`up:${req.url}`);
    },
  });
  t.after(() => upstream.close());

  const ports = await createPortsRuntime({
    home,
    fetchHttpImpl: async () => {
      throw new Error("consumer-side fetchHttp must not run on the provider path");
    },
    sessionResolver: async () => null,
  });

  const router = createWpkRouter({
    gate: () => true,
    routes: { ports: (req, peer) => ports.createProviderHandler(peer)(req) },
  });

  // 未授权：403 + 零上游出站
  const denied = await router(OTHER_PEER, typedRequest({ path: `/wpk1/ports/proxy/${upstream.port}/echo` }));
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(Buffer.from(denied.bodyChunks[0]).toString("utf8")).error.code, "access-denied");
  assert.equal(upstream.hits.length, 0, "deny-by-default: upstream never connected");

  // 非法端口路径：404（parseProxyPath 不匹配）
  const badPath = await router(PEER, typedRequest({ path: "/wpk1/ports/proxy/notaport/x" }));
  assert.equal(badPath.status, 404);

  // 授权后：真实转发（对端身份=路由绑定 peer；响应经 respondStreaming 流式结算）
  await ports.grantAccess(PEER, upstream.port);
  streamedMeta = null;
  const streamed = await router(PEER, typedRequest({ path: `/wpk1/ports/proxy/${upstream.port}/echo?x=1`, method: "GET" }));
  const settled = streamed ?? { status: streamedMeta?.status, chunks: streamedMeta?.chunks ?? [] };
  assert.equal(settled.status, 200, JSON.stringify(settled));
  assert.equal(upstream.hits.length, 1);
  assert.equal(upstream.hits[0].url, "/echo?x=1", "原始 path+query 原样转发");
  assert.equal(Buffer.concat(streamedMeta?.chunks ?? []).toString("utf8"), "up:/echo?x=1", "流式响应体透传");
});

// ---- files：sessionId→peer 反查 + share 成员判定 ----------------------------------------

test("wpk files route: unknown session / unauthorized peer denied; authorized peer lists the real frozen root", async (t) => {
  const home = await tempHome("wpk-files-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "share-root");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "hello.txt"), "hi", "utf8");

  /** sessionId → peer 反查（fabric 宿主 noteSession 同源表） */
  const sessionPeers = new Map([["sess-ok", PEER]]);
  const files = await createFilesRuntime({
    home,
    resolvePeer: async (sessionId) => sessionPeers.get(sessionId) ?? null,
  });
  await files.shares.add({ name: "docs", root, mode: "ro", peers: [PEER] });

  const router = createWpkRouter({ gate: () => true, routes: { files: (req) => files.handler(req) } });
  const shareId = (await files.shares.list())[0].id;

  // 未知 session（反查 miss）→ deny（files wire 错误形状=顶层 {error: code}）
  const unknownSession = await router(PEER, typedRequest({ sessionId: "sess-nope", path: `/wpk1/files/${shareId}/list?path=` }));
  assert.equal(unknownSession.status, 403);
  assert.equal(JSON.parse(Buffer.from(unknownSession.bodyChunks[0]).toString("utf8")).error, "session-unknown");

  // peer 未入 share 名单（路由绑定对端 ≠ 账本授权）→ deny
  sessionPeers.set("sess-other", OTHER_PEER);
  const unauthorized = await router(OTHER_PEER, typedRequest({ sessionId: "sess-other", path: `/wpk1/files/${shareId}/list?path=` }));
  assert.equal(unauthorized.status, 403);
  assert.equal(JSON.parse(Buffer.from(unauthorized.bodyChunks[0]).toString("utf8")).error, "peer-not-authorized");

  // 授权：真实列目录
  const okRes = await router(PEER, typedRequest({ sessionId: "sess-ok", path: `/wpk1/files/${shareId}/list?path=` }));
  assert.equal(okRes.status, 200);
  const body = JSON.parse(Buffer.from(okRes.bodyChunks[0]).toString("utf8"));
  assert.ok(Array.isArray(body.entries) && body.entries.some((e) => e.name === "hello.txt"), JSON.stringify(body));
});

// ---- sync 适配器 ------------------------------------------------------------------------

test("wpk sync adapter: serveHttp shape maps to the sync endpoint contract and back", async (t) => {
  const seen = [];
  const handler = async (request) => {
    seen.push({ method: request.method, path: request.path, sessionId: request.sessionId, peer: request.peerEndpointId });
    const chunks = [];
    if (request.body !== undefined && request.body !== null) {
      for await (const c of request.body) chunks.push(Buffer.from(c));
    }
    seen.push({ body: Buffer.concat(chunks).toString("utf8") });
    return { status: 201, body: new Uint8Array(Buffer.from(`{"ok":true}\n`)) };
  };
  const adapted = adaptSyncHandler(handler);

  const res = await adapted(
    typedRequest({
      method: "POST",
      path: "/wpk1/sync/g1/r1/refs",
      sessionId: "sess-2",
      bodyChunks: [Buffer.from('{"line":"a"}\n'), Buffer.from('{"line":"b"}\n')],
    }),
    PEER,
  );
  assert.equal(res.status, 201);
  assert.deepEqual(res.headers, [{ name: "content-type", value: "application/json" }]);
  assert.equal(Buffer.from(res.bodyChunks[0]).toString("utf8"), '{"ok":true}\n');
  assert.deepEqual(seen[0], { method: "POST", path: "/wpk1/sync/g1/r1/refs", sessionId: "sess-2", peer: PEER });
  assert.equal(seen[1].body, '{"line":"a"}\n{"line":"b"}\n', "body streams through as an AsyncIterable");
});

test("wpk sync adapter: ungranted sync plugin (enabled=false) is denied before the handler", async () => {
  let handlerRuns = 0;
  const router = createWpkRouter({
    gate: () => false,
    routes: { sync: adaptSyncHandler(async () => { handlerRuns += 1; return { status: 200, body: new Uint8Array() }; }) },
  });
  const denied = await router(PEER, typedRequest({ path: "/wpk1/sync/g1/r1/refs" }));
  assert.equal(denied.status, 503);
  assert.equal(JSON.parse(Buffer.from(denied.bodyChunks[0]).toString("utf8")).error.code, "plugin-disabled");
  assert.equal(handlerRuns, 0);
});
