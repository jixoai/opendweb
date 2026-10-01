// e2e：双 in-process fake-fabric 互连（tasks B5）——A/B 两注入面直连（参照
// ext-ports e2e 的假会话模式：消费侧 fetchImpl ↔ 提供侧 aiWireHandler 直调；
// 每次调用=独立完整请求-响应，静态结算——本 ABI 无流式帧面）。全链路：
// keyring 导入（aifly1. 信封）→auth→catalog→本地网关（127.0.0.1 listener）→
// SSE 长响应（字节等同直连+相对延迟断言——真双机 LAN p95 留 Phase C/E）→
// 撤钥三态→配额→provider 重启（epoch 更替）→端口冲突真实报错→WS 显式拒绝→
// 凭据头协议层剥离。常驻进程（listener/upstream）显式回收（t.after 留证）。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { tempHome, aiDataDir, startUpstream, waitFor } from "../helpers.mjs";
import { ProviderStore } from "../../src/provider/store.mjs";
import { SecretsStore } from "../../src/provider/secrets.mjs";
import { UsageLog } from "../../src/provider/limits.mjs";
import { createAiProviderWireHandler } from "../../src/wire/endpoints.mjs";
import { buildServiceEntry } from "../../src/provider/detail.mjs";
import { openKeyring } from "../../src/consumer/keyring.mjs";
import { importLink, SHARE_LINK_PREFIX } from "../../src/consumer/join.mjs";
import { createConsumerSession } from "../../src/consumer/sessions.mjs";
import { createConsumerGateway } from "../../src/consumer/gateway.mjs";

// ---------------------------------------------------------------------------
// fake fabric 桥（消费侧注入面 ↔ 提供侧 handler；retarget=provider 重启模拟）
// ---------------------------------------------------------------------------

/**
 * @param {() => (req: any, peer: string) => Promise<any>} handlerRef
 * @param {string} peer
 */
function createFabricBridge(handlerRef, peer = "peer-consumer-e2e") {
  const calls = [];
  async function fetchImpl(init) {
    const requestId = calls.length + 1;
    calls.push({ requestId, method: init.method, path: init.path, headers: init.headers ?? [], bodyBytes: (init.body ?? []).reduce((n, c) => n + c.length, 0) });
    if (init.signal?.aborted) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    const bodyChunks = (init.body ?? []).map((c) => Buffer.from(c));
    let idx = 0;
    const req = {
      requestId,
      streamId: requestId,
      sessionId: `sess-${peer}`,
      signal: controller.signal,
      method: init.method,
      path: init.path,
      headers: init.headers ?? [],
      bodyNext: async () => (idx < bodyChunks.length ? bodyChunks[idx++] : null),
      respondStreaming: () => null,
    };
    const res = await handlerRef()(req, peer);
    init.signal?.removeEventListener("abort", onAbort);
    if (res === null || res === undefined) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    return { status: res.status, headers: res.headers ?? [], bodyChunks: res.bodyChunks ?? [] };
  }
  return { fetchImpl, calls };
}

/** 本地 HTTP 客户端（网关面；收集分块+到达时间戳——SSE 延迟断言）。 */
function localRequest(port, opts = {}) {
  const { method = "GET", requestPath = "/", headers = {}, body } = opts;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const firstChunkAt = [];
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => {
        if (firstChunkAt.length === 0) firstChunkAt.push(Date.now());
        chunks.push(c);
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          firstChunkMs: firstChunkAt[0] !== undefined ? firstChunkAt[0] - t0 : undefined,
          totalMs: Date.now() - t0,
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 空闲端口（bind 0→读回→释放）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// 全链路 e2e
// ---------------------------------------------------------------------------

test("e2e: 全链路——keyring 导入→auth→catalog→本地网关 SSE 长响应（字节等同+相对延迟）→撤钥→重启", async (t) => {
  const home = await tempHome("odai-e2e-full-");
  t.after(() => rm(home, { recursive: true, force: true }));

  // ---- A 机（provider）：真上游 SSE + 服务（auth 三族注入）+ 两钥 ----
  const events = [];
  for (let i = 0; i < 24; i++) events.push(`data: {"tok":${i}}\n\n`);
  const expectedStream = Buffer.from(events.join(""));
  const usageLog = new UsageLog(aiDataDir(home));
  const up = await startUpstream(async (req, res) => {
    // 凭据头协议层剥离断言锚点：上游只见 provider 注入的槽值
    assert.equal(req.headers.authorization, "Bearer sk-upstream-slot-value");
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["proxy-authorization"], undefined);
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "e2e-1" });
    if (req.url.startsWith("/v1/models")) {
      res.end('{"data":[]}');
      return;
    }
    res.flushHeaders();
    for (const e of events) {
      await res.write(e);
      await new Promise((r) => setTimeout(r, 25));
    }
    res.end();
  });
  t.after(() => up.close());
  const secrets = await SecretsStore.open(aiDataDir(home));
  await secrets.set("upstream-key", "sk-upstream-slot-value");
  const store = await ProviderStore.open(aiDataDir(home));
  await store.addService({
    name: "openai",
    upstream: up.origin,
    match: [{ type: "suffix", value: ".openai.com" }],
    defaultPort: 4300,
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    auth: { secret: "upstream-key" },
  });
  const svcEntry = buildServiceEntry(store.getServiceByName("openai"));
  await store.addGroup("alpha", ["openai"]);
  const keyA = await store.issueKey("alpha");

  // provider 面（真 fetch——default fetchImpl/probeConnect 走 127.0.0.1 真网络）
  let providerHandler = createAiProviderWireHandler({ store, secrets: (n) => secrets.get(n), usageLog, sweepIntervalMs: 50 });
  const bridge = createFabricBridge(() => providerHandler);

  // ---- B 机（consumer）：信封导入→钥环→会话→本地网关 ----
  const consumerRoot = await mkdtemp(path.join(tmpdir(), "odai-e2e-cons-"));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));
  const keyringFile = path.join(consumerRoot, "plugins", "ai", "keyring.json");
  const keyring = await openKeyring(keyringFile);
  const payload = {
    v: 1,
    invite: "dweb1.fakestokendweb1e2e000000000000000000000000000",
    key: keyA.key,
    keyId: keyA.keyId,
    provider: { alias: "iMac-provider", endpointId: "e2eproviderep0001aaaaaaaa", relayUrls: [] },
    group: "alpha",
    services: [svcEntry],
  };
  const link = `${SHARE_LINK_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const { payload: imported } = await importLink(link, { keyring, fabric: { fetchImpl: bridge.fetchImpl } });
  assert.equal(imported.keyId, keyA.keyId);
  await keyring.save();

  const session = createConsumerSession({ fetchImpl: bridge.fetchImpl });
  const auth = await session.auth([keyA.key]);
  assert.equal(auth.groups.length, 1);
  assert.equal(auth.groups[0].keyId, keyA.keyId);
  assert.equal(auth.groups[0].services.length, 1);
  const cat = await session.catalog({ keyId: keyA.keyId, since: 0 });
  assert.equal(cat.changed, true);

  const gateway = createConsumerGateway({ session });
  const port = await freePort();
  const listener = await gateway.startService({
    serviceId: svcEntry.serviceId,
    name: "openai",
    port,
    routes: [{ localPrefix: "/v1", upstreamPrefix: "/v1" }],
    keyId: keyA.keyId,
  });
  t.after(() => gateway.close());
  assert.equal(listener.port, port);

  // 本地端点等价直连：SSE 字节流（含凭据头——必须剥离）
  const sse = await localRequest(port, {
    method: "POST",
    requestPath: "/v1/chat/completions",
    headers: { authorization: "Bearer local-client-credential-must-be-stripped", cookie: "session=leak-attempt", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", stream: true }),
  });
  assert.equal(sse.status, 200);
  assert.equal(sse.headers["content-type"], "text/event-stream");
  assert.equal(sse.headers["x-request-id"], "e2e-1");
  assert.ok(sse.body.equals(expectedStream), "SSE 字节流等同直连（保序/零丢失/零重复）");
  // 相对延迟断言（注入面 in-process；真双机 LAN p95 留 Phase C/E）
  assert.ok(sse.firstChunkMs < 1500, `首分片相对延迟（实测 ${sse.firstChunkMs}ms < 1500ms）`);
  assert.ok(sse.totalMs < 30_000);
  await waitFor(() => up.hits.length >= 1, 3000, "upstream hit");

  // 白名单外路径：本地即拒（零上游触达）
  const hitsBefore = up.hits.length;
  const notOffered = await localRequest(port, { method: "GET", requestPath: "/user" });
  assert.equal(notOffered.status, 404);
  assert.equal(JSON.parse(notOffered.body.toString()).error.code, "path_not_offered");
  assert.equal(up.hits.length, hitsBefore, "白名单外零触达");

  // ---- 撤钥①：在途续拉（快照）+ 新请求 403 ----
  const midStream = localRequest(port, {
    method: "POST",
    requestPath: "/v1/chat/completions",
    headers: { authorization: "Bearer local", "content-type": "application/json" },
    body: JSON.stringify({ stream: true }),
  });
  await waitFor(() => up.hits.length >= hitsBefore + 1, 3000, "mid-stream request hit upstream");
  await new Promise((r) => setTimeout(r, 250)); // meta 已回、流已在途
  await store.revokeKey(keyA.keyId);
  const mid = await midStream;
  assert.equal(mid.status, 200, "撤钥时在途流按快照完成");
  assert.ok(mid.body.equals(expectedStream), "在途流字节完整");
  const afterRevoke = await localRequest(port, {
    method: "POST",
    requestPath: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(afterRevoke.status, 403);
  const revokedJson = JSON.parse(afterRevoke.body.toString());
  assert.equal(revokedJson.error.code, "key_revoked", "OpenAI 风格 JSON 透传码");

  // ---- provider 重启（epoch 更替）：旧钥 auth 全错；新钥全链路恢复 ----
  const keyC = await store.issueKey("alpha");
  providerHandler = createAiProviderWireHandler({ store, secrets: (n) => secrets.get(n), usageLog, sweepIntervalMs: 50 }); // 新 plane=新 epoch
  const auth2 = await session.auth([keyC.key]);
  assert.equal(auth2.groups[0].keyId, keyC.keyId);
  await assert.rejects(() => session.auth([keyA.key]), (err) => err.code === "key_all_invalid");
  // 新钥经网关全链路（网关换 keyId 绑定）
  await gateway.close();
  const gateway2 = createConsumerGateway({ session });
  t.after(() => gateway2.close());
  const port2 = await freePort();
  await gateway2.startService({
    serviceId: svcEntry.serviceId,
    name: "openai",
    port: port2,
    routes: [{ localPrefix: "/v1", upstreamPrefix: "/v1" }],
    keyId: keyC.keyId,
  });
  const renewed = await localRequest(port2, { method: "GET", requestPath: "/v1/models" });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.toString(), '{"data":[]}');
});

test("e2e: 配额——dailyRequests=2；第三请求 429 quota_exceeded（OpenAI JSON 透传）；重启后同日计数仍在", async (t) => {
  const home = await tempHome("odai-e2e-quota-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end('{"ok":1}');
  });
  t.after(() => up.close());
  const store = await ProviderStore.open(aiDataDir(home));
  await store.addService({
    name: "openai",
    upstream: up.origin,
    match: [{ type: "suffix", value: ".openai.com" }],
    defaultPort: 4300,
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
  });
  await store.addGroup("alpha", ["openai"], { dailyRequests: 2 });
  const key = await store.issueKey("alpha");
  const svcEntry = buildServiceEntry(store.getServiceByName("openai"));
  let providerHandler = createAiProviderWireHandler({ store, sweepIntervalMs: 50 });
  const bridge = createFabricBridge(() => providerHandler);
  const session = createConsumerSession({ fetchImpl: bridge.fetchImpl });
  await session.auth([key.key]);
  const gateway = createConsumerGateway({ session });
  const port = await freePort();
  await gateway.startService({
    serviceId: svcEntry.serviceId,
    name: "openai",
    port,
    routes: [{ localPrefix: "/v1", upstreamPrefix: "/v1" }],
    keyId: key.keyId,
  });
  t.after(() => gateway.close());
  const hit = () => localRequest(port, { method: "GET", requestPath: "/v1/models" });
  assert.equal((await hit()).status, 200);
  assert.equal((await hit()).status, 200);
  const third = await hit();
  assert.equal(third.status, 429);
  const errJson = JSON.parse(third.body.toString());
  assert.equal(errJson.error.code, "quota_exceeded");
  assert.equal(errJson.error.type, "rate_limit_error");
  // provider「重启」（同 store——quota-day.json 持久化）：同日计数仍在
  providerHandler = createAiProviderWireHandler({ store, sweepIntervalMs: 50 });
  const fourth = await hit();
  assert.equal(fourth.status, 429, "重启后同日计数仍在");
  assert.equal(JSON.parse(fourth.body.toString()).error.code, "quota_exceeded");
});

test("e2e: 端口冲突=真实 listen 错误（不静默换端口）；WS v1 显式拒绝", async (t) => {
  const home = await tempHome("odai-e2e-port-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200);
    rs.end();
  });
  t.after(() => up.close());
  const store = await ProviderStore.open(aiDataDir(home));
  await store.addService({
    name: "openai",
    upstream: up.origin,
    match: [{ type: "suffix", value: ".openai.com" }],
    defaultPort: 4300,
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
  });
  await store.addGroup("alpha", ["openai"]);
  const key = await store.issueKey("alpha");
  const svcEntry = buildServiceEntry(store.getServiceByName("openai"));
  const providerHandler = createAiProviderWireHandler({ store, sweepIntervalMs: 50 });
  const bridge = createFabricBridge(() => providerHandler);
  const session = createConsumerSession({ fetchImpl: bridge.fetchImpl });
  await session.auth([key.key]);
  const gateway = createConsumerGateway({ session });
  // 占位 listener（真实占用）
  const squatter = http.createServer();
  await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const busyPort = /** @type {net.AddressInfo} */ (squatter.address()).port;
  t.after(() => new Promise((resolve) => squatter.close(() => resolve(undefined))));
  // 冲突：明确报错（EADDRINUSE 语义、含端口与服务名；不静默换端口）
  await assert.rejects(
    () =>
      gateway.startService({
        serviceId: svcEntry.serviceId,
        name: "openai",
        port: busyPort,
        routes: [{ localPrefix: "/v1", upstreamPrefix: "/v1" }],
        keyId: key.keyId,
      }),
    (err) => /EADDRINUSE|cannot listen/.test(err.message) && err.message.includes(String(busyPort)),
  );
  // WS 显式拒绝（raw upgrade→400 JSON；零上游触达）
  const port = await freePort();
  await gateway.startService({
    serviceId: svcEntry.serviceId,
    name: "openai",
    port,
    routes: [{ localPrefix: "/v1", upstreamPrefix: "/v1" }],
    keyId: key.keyId,
  });
  t.after(() => gateway.close());
  const wsReply = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(`GET /v1/realtime HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n`);
    });
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
  assert.match(wsReply, /^HTTP\/1\.1 400/);
  assert.match(wsReply, /websocket passthrough is not supported/);
  assert.equal(up.hits.length, 0, "WS 拒绝零上游触达");
});
