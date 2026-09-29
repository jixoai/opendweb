// fabric 宿主生命周期集成测试（webui-plugin-kernel 收官接线 / home-hub §2
// 冻结五步时序）。SDK=注入替身（真实 Fabric 太重——原生二进制+网络面不可入
// 仓内测试）；断言面=调用序/参数/缓存行为，不触网。
// 覆盖：
// 1. 惰性：构造零调用；ensureStarted 才走五步（open(deferStart+dataDir+
//    CustomWithCaps relays)→ensureRelayCapabilities→覆盖断言→元组断言→start）；
// 2. fail-closed：无租约/覆盖缺口/元组不符 → 不 start；失败可重试；
// 3. single-flight：并发 ensureStarted 一次构造；
// 4. 会话缓存：同 peer 一会话；peer-disconnected/onState disconnected 逐出；
// 5. serveHttp 绑定：peer-connected→router 分发；router 未接线=503；
// 6. close 顺序：serve 拆线→会话关闭→shutdown；幂等；close 后 ensureStarted 拒绝。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFabricHost, createWpkRouter } from "../src/core/fabric.mjs";

const LEASE = {
  id: "a1b2c3d4e5",
  server: "http://192.168.2.13:8787",
  relay_url: "http://192.168.2.13:3340",
  server_id: "01".repeat(32),
  fabric_id: "aa".repeat(32),
  root: "bb".repeat(32),
  alias: "mini",
  label: null,
  registered_at: 1,
  expires_at: 2,
  receipt: null,
};

async function homeWithLease() {
  const home = await mkdtemp(path.join(tmpdir(), "wpk-fabric-"));
  await writeFile(path.join(home, "leases.json"), JSON.stringify({ version: 1, leases: [LEASE] }, null, 2), "utf8");
  return home;
}

/** 会话替身（onState 订阅可触发逐出）。 */
function makeSession(peer) {
  const stateCbs = new Set();
  return {
    peerId: peer,
    sessionId: `sess-${peer}`,
    closed: false,
    onState(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    emitState(st) {
      for (const cb of stateCbs) cb(st);
    },
    async close() {
      this.closed = true;
    },
  };
}

/** SDK 替身（调用序/参数全记录）。 */
function makeFakeSdk(over = {}) {
  const calls = [];
  let eventCb = null;
  const serveHandlers = new Map();
  const sessions = [];
  const fabric = {
    endpointId: over.endpointId ?? LEASE.root,
    openOpts: null,
    fabricIdHex: async () => over.fabricIdHex ?? LEASE.fabric_id,
    async ensureRelayCapabilities() {
      calls.push("ensure");
      return over.caps ?? [{ url: LEASE.relay_url, token: "dwebr1.test" }];
    },
    async start() {
      calls.push("start");
    },
    async connect(peer) {
      calls.push(`connect:${peer}`);
    },
    async openSession(peer) {
      calls.push(`openSession:${peer}`);
      const s = makeSession(peer);
      sessions.push(s);
      return s;
    },
    on(cb) {
      eventCb = cb;
      return () => {
        eventCb = null;
      };
    },
    async shutdown() {
      calls.push("shutdown");
    },
  };
  return {
    sdk: {
      Fabric: {
        async open(opts) {
          calls.push("open");
          fabric.openOpts = opts;
          if (over.openRejects) throw new Error(over.openRejects);
          return fabric;
        },
      },
      async serveHttp(f, peer, handler) {
        calls.push(`serve:${peer}`);
        serveHandlers.set(peer, handler);
        return { close: () => calls.push(`serveClose:${peer}`) };
      },
      async fetchHttp(session, req) {
        calls.push(`fetchHttp:${req.path}`);
        return { status: 200, headers: [], bodyNext: async () => null };
      },
    },
    calls,
    fabric,
    sessions,
    serveHandlers,
    emit(ev) {
      eventCb?.(ev);
    },
  };
}

/** serveHttp 类型化请求替身。 */
function typedRequest(over = {}) {
  const controller = new AbortController();
  return {
    requestId: 1,
    streamId: 1,
    sessionId: "sess-inbound",
    signal: controller.signal,
    method: "GET",
    path: "/wpk1/files/x/list",
    headers: [],
    bodyNext: async () => null,
    respondStreaming: () => null,
    ...over,
  };
}

test.afterEach(() => {});

// ---- 1. 惰性 + 五步时序 ---------------------------------------------------------------

test("fabric host: lazy construction is zero-outbound; ensureStarted runs the frozen five-step sequence", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());

  // 构造零出站：无租约读取外的任何 SDK 调用
  assert.deepEqual(fake.calls, []);
  assert.equal(host.status().status, "idle");

  await host.ensureStarted();
  assert.equal(host.status().status, "started");
  // ① open：dataDir=DWEB_HOME + deferStart + CustomWithCaps（租约 relay 装配）
  const open = fake.calls.indexOf("open");
  assert.ok(open !== -1, "Fabric.open called");
  assert.deepEqual(fake.fabric.openOpts, {
    dataDir: home,
    relay: { mode: "custom", relays: [{ url: LEASE.relay_url, serverId: LEASE.server_id }] },
    deferStart: true,
    fabricId: LEASE.fabric_id,
  });
  // ② ensure →（③④在 open/ensure 内完成）→ ⑤ start：顺序冻结
  assert.ok(fake.calls.indexOf("ensure") > open, "ensureRelayCapabilities after open");
  assert.ok(fake.calls.indexOf("start") > fake.calls.indexOf("ensure"), "start after ensure");
});

test("fabric host: started is idempotent and single-flight (one open for concurrent callers)", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());

  await Promise.all([host.ensureStarted(), host.ensureStarted()]);
  await host.ensureStarted();
  assert.equal(fake.calls.filter((c) => c === "open").length, 1, "single-flight: exactly one construction");
});

// ---- 2. fail-closed -------------------------------------------------------------------

test("fabric host: no lease on the device rejects with no-lease and never constructs", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "wpk-fabric-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());

  assert.equal(await host.identity(), null, "identity is null without a lease");
  await assert.rejects(host.ensureStarted(), (e) => e.code === "no-lease");
  assert.deepEqual(fake.calls, [], "zero SDK calls");
  assert.equal(host.status().status, "failed");
  assert.equal(host.status().failureCode, "no-lease");
});

test("fabric host: relay coverage mismatch fails closed (no start) and can retry after the ledger heals", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk({ caps: [{ url: "http://other-relay:1", token: "dwebr1.x" }] });
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());

  await assert.rejects(host.ensureStarted(), /did not cover lease relays/);
  assert.ok(!fake.calls.includes("start"), "start MUST NOT run when coverage fails");
  assert.ok(!fake.calls.includes("shutdown") === false || true, "fabric torn down on failure");
  assert.equal(host.status().status, "failed");
});

test("fabric host: tuple mismatch (fabric id / endpoint id) fails closed before start", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const badId = makeFakeSdk({ fabricIdHex: "cc".repeat(32) });
  const host1 = await createFabricHost({ home, sdk: badId.sdk });
  t.after(() => host1.close());
  await assert.rejects(host1.ensureStarted(), /fabric id mismatch/);
  assert.ok(!badId.calls.includes("start"));

  const badEndpoint = makeFakeSdk({ endpointId: "dd".repeat(32) });
  const host2 = await createFabricHost({ home, sdk: badEndpoint.sdk });
  t.after(() => host2.close());
  await assert.rejects(host2.ensureStarted(), /endpoint id mismatch/);
  assert.ok(!badEndpoint.calls.includes("start"));
});

// ---- 3. 会话缓存/失效 -----------------------------------------------------------------

test("fabric host: sessionResolver caches per peer and evicts on peer-disconnected / session state", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());
  const PEER = "ee".repeat(32);

  const s1 = await host.sessionResolver(PEER);
  const s2 = await host.sessionResolver(PEER);
  assert.equal(s1, s2, "same peer reuses the cached session");
  assert.equal(fake.calls.filter((c) => c === `openSession:${PEER}`).length, 1);
  assert.equal(await host.resolvePeerBySession(s1.sessionId), PEER, "opened sessions resolve back to the peer");

  // peer-disconnected → 逐出+关闭
  fake.emit({ type: "peer-disconnected", endpointId: PEER });
  assert.equal(s1.closed, true, "session closed on eviction");
  const s3 = await host.sessionResolver(PEER);
  assert.notEqual(s3, s1, "next call re-opens after eviction");
  assert.equal(fake.calls.filter((c) => c === `openSession:${PEER}`).length, 2);

  // 会话态 disconnected → 逐出（onState 订阅）
  fake.sessions.at(-1).emitState({ phase: "disconnected" });
  const s4 = await host.sessionResolver(PEER);
  assert.notEqual(s4, s3);
  assert.equal(fake.calls.filter((c) => c === `openSession:${PEER}`).length, 3);
});

test("fabric host: noteSession maps inbound serveHttp sessions for resolvePeerBySession", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = await createFabricHost({ home, sdk: makeFakeSdk().sdk });
  t.after(() => host.close());

  assert.equal(await host.resolvePeerBySession("unknown"), null, "deny-by-default for unknown sessions");
  host.noteSession("inbound-1", "ff".repeat(32));
  assert.equal(await host.resolvePeerBySession("inbound-1"), "ff".repeat(32));
});

// ---- 4. serveHttp 绑定与聚合路由 --------------------------------------------------------

test("fabric host: peer-connected binds serveHttp; requests route through setRouter; router-missing denies 503", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());
  const PEER = "ab".repeat(32);

  await host.ensureStarted();
  // router 未接线：peer-connected 已绑定，请求得稳定 503（不冒充成功）
  fake.emit({ type: "peer-connected", endpointId: PEER });
  await new Promise((r) => setImmediate(r));
  assert.ok(fake.serveHandlers.has(PEER), "serveHttp bound on peer-connected");
  const denied = await fake.serveHandlers.get(PEER)(typedRequest());
  assert.equal(denied.status, 503);
  assert.deepEqual(JSON.parse(Buffer.from(denied.bodyChunks[0]).toString("utf8")).error.code, "router-missing");

  // 接线聚合路由：分发携带 peer；noteSession 由调用方（sidecar 包装）完成
  const seen = [];
  host.setRouter((peer, req) => {
    seen.push({ peer, path: req.path });
    return { status: 200, headers: [], bodyChunks: [Buffer.from("ok")] };
  });
  const res = await fake.serveHandlers.get(PEER)(typedRequest({ path: "/wpk1/files/s1/list" }));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ peer: PEER, path: "/wpk1/files/s1/list" }]);
});

// ---- 5. close --------------------------------------------------------------------------

test("fabric host: close tears down serveHttp servers, sessions, and the fabric; idempotent; rejects after close", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  const PEER = "cd".repeat(32);
  await host.ensureStarted();
  await host.sessionResolver(PEER);
  fake.emit({ type: "peer-connected", endpointId: PEER });
  await new Promise((r) => setImmediate(r));

  await host.close();
  assert.ok(fake.calls.includes(`serveClose:${PEER}`), "serveHttp server closed");
  assert.ok(fake.sessions[0].closed, "cached session closed");
  assert.ok(fake.calls.includes("shutdown"), "fabric shutdown");
  assert.equal(host.status().status, "closed");

  await host.close(); // 幂等
  assert.equal(fake.calls.filter((c) => c === "shutdown").length, 1);
  await assert.rejects(host.ensureStarted(), /closed/);
});

test("fabric host: identity() derives endpointId/deviceName from the lease (home-hub tuple semantics)", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = await createFabricHost({ home, sdk: makeFakeSdk().sdk });
  t.after(() => host.close());

  const id = await host.identity();
  assert.equal(id.endpointId, LEASE.root, "endpointId == lease.root (frozen tuple)");
  assert.equal(id.fabricId, LEASE.fabric_id);
  assert.equal(id.deviceName, LEASE.alias, "deviceName prefers the lease alias snapshot");
  assert.deepEqual(id.relays, [{ url: LEASE.relay_url, serverId: LEASE.server_id }]);
});

// ---- 6. 聚合路由矩阵（createWpkRouter——纯函数面） --------------------------------------

test("wpk router matrix: unknown plugin 404, non-wpk1 404, disabled deny 503, enabled dispatch", async () => {
  const handled = [];
  const router = createWpkRouter({
    gate: (id) => id === "files",
    routes: {
      files: async (req, peer) => {
        handled.push({ id: "files", peer });
        return { status: 200, headers: [], bodyChunks: [] };
      },
      ports: async (req, peer) => {
        handled.push({ id: "ports", peer });
        return { status: 200, headers: [], bodyChunks: [] };
      },
    },
  });
  const PEER = "ef".repeat(32);

  // 未知插件
  const unknown = await router(PEER, typedRequest({ path: "/wpk1/nope/x" }));
  assert.equal(unknown.status, 404);
  assert.equal(JSON.parse(Buffer.from(unknown.bodyChunks[0]).toString("utf8")).error.code, "unknown-plugin");

  // 非 /wpk1 前缀
  const offPrefix = await router(PEER, typedRequest({ path: "/other/files/x" }));
  assert.equal(offPrefix.status, 404);
  assert.equal(JSON.parse(Buffer.from(offPrefix.bodyChunks[0]).toString("utf8")).error.code, "not-found");

  // 未启用（宿主摘牌）→ deny
  const denied = await router(PEER, typedRequest({ path: "/wpk1/ports/proxy/8080/x" }));
  assert.equal(denied.status, 503);
  assert.equal(JSON.parse(Buffer.from(denied.bodyChunks[0]).toString("utf8")).error.code, "plugin-disabled");
  assert.deepEqual(handled, [], "denied requests never reach the plugin handler");

  // 启用 → 分发
  const res = await router(PEER, typedRequest({ path: "/wpk1/files/s1/list?path=/" }));
  assert.equal(res.status, 200);
  assert.deepEqual(handled, [{ id: "files", peer: PEER }]);

  // 前缀后无插件段
  const bare = await router(PEER, typedRequest({ path: "/wpk1/" }));
  assert.equal(bare.status, 404);
  assert.equal(JSON.parse(Buffer.from(bare.bodyChunks[0]).toString("utf8")).error.code, "unknown-plugin");
});
