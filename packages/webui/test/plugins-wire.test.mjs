// 收官接线端到端（sidecar 组装：fabric 宿主 + 三 runtime + 聚合路由 + 管理面
// 路由）。经 createSidecar 真实 HTTP 链路 + 注入 SDK 替身：
// 1. 惰性：sidecar 启动零 Fabric 构造；数据面插件 enable（HTTP POST）触发
//    ensureStarted（fake Fabric.open 断言——deferStart 形态经 fabric-host 测试
//    单测，此处断言触发链）；
// 2. 聚合路由全链路：fake fabric peer-connected → serveHttp 绑定 → 请求经
//    sidecar 包装（noteSession）→ 真实 files handler 授权矩阵；
// 3. 管理面矩阵：ports mappings CRUD（Origin 四类）/allowlist 授予回收；
//    files shares CRUD + bridge 信封（fake fetchHttp 断言 wire 路径钉死）；
//    sync 无租约=503 unavailable；有租约=建组/列表/sync-now 门（停用 409）；
// 4. close：fabric shutdown 在插件 dispose 之后（调用序断言）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSidecar } from "../src/core/sidecar.mjs";
import { hexToZ32 } from "../src/core/fabric.mjs";
import { request } from "./helpers.mjs";

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
const PEER = "ab".repeat(32);

async function tempHome(withLease) {
  const home = await mkdtemp(path.join(tmpdir(), "wpk-wire-"));
  if (withLease) {
    await writeFile(path.join(home, "leases.json"), JSON.stringify({ version: 1, leases: [LEASE] }, null, 2), "utf8");
  }
  return home;
}

/** SDK 替身（fabric-host 测试同族；serveHttp 捕获 handler 供直接调用）。 */
function makeFakeSdk() {
  const calls = [];
  let eventCb = null;
  const serveHandlers = new Map();
  /** @type {Array<{ path: string, body: string | null }>} fetchHttp 请求记录 */
  const fetches = [];
  /** fetchHttp 应答队列（测试注入） */
  const fetchResponses = [];
  const sessions = [];
  const fabric = {
    // SDK endpointId 是 z32 展示串（租约 root 的 hex64 同钥异码——④断言先归一）
    endpointId: hexToZ32(LEASE.root),
    async rootEndpointId() {
      return fabric.endpointId;
    },
    async fabricIdHex() {
      return LEASE.fabric_id;
    },
    async ensureRelayCapabilities() {
      calls.push("ensure");
      return [{ url: LEASE.relay_url, token: "dwebr1.test" }];
    },
    async start() {
      calls.push("start");
    },
    async connect() {},
    async openSession(peer) {
      const s = {
        peerId: peer,
        sessionId: `sess-out-${peer}`,
        onState: () => () => {},
        async close() {},
      };
      sessions.push(s);
      return s;
    },
    on(cb) {
      eventCb = cb;
      return () => {};
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
          return fabric;
        },
      },
      async serveHttp(f, peer, handler) {
        calls.push(`serve:${peer}`);
        serveHandlers.set(peer, handler);
        return { close: () => calls.push(`serveClose:${peer}`) };
      },
      async fetchHttp(session, req) {
        calls.push("fetchHttp");
        fetches.push({ path: req.path, body: req.body?.[0] ? Buffer.from(req.body[0]).toString("utf8") : null });
        const r = fetchResponses.length > 0 ? fetchResponses.shift() : { status: 200, headers: [], bodyNext: async () => null };
        return { status: r.status, headers: r.headers ?? [], bodyNext: r.bodyNext ?? (async () => null) };
      },
    },
    calls,
    fabric,
    serveHandlers,
    sessions,
    fetches,
    fetchResponses,
    emit(ev) {
      eventCb?.(ev);
    },
  };
}

/** serveHttp 类型化请求替身。 */
function typedRequest(over = {}) {
  const controller = new AbortController();
  const bodyQueue = (over.bodyChunks ?? []).map((c) => Buffer.from(c));
  let streamed = null;
  return {
    requestId: 1,
    streamId: 1,
    sessionId: over.sessionId ?? "sess-in",
    signal: controller.signal,
    method: over.method ?? "GET",
    path: over.path ?? "/",
    headers: over.headers ?? [],
    bodyNext: async () => bodyQueue.shift() ?? null,
    respondStreaming: (status, headers) => {
      streamed = { status, headers: headers ?? [], chunks: [] };
      return {
        write: async (chunk) => streamed.chunks.push(Buffer.from(chunk)),
        finish: () => {},
        finished: false,
        cancelled: false,
        closed: false,
      };
    },
    get streamed() {
      return streamed;
    },
  };
}

async function flushAsync(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

const jsonHeaders = { "content-type": "application/json" };

test.afterEach(() => {});

// ---- 惰性启动触发链 --------------------------------------------------------------------

test("wire: sidecar start is zero-fabric; enabling a data-plane plugin lazily starts it", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  t.after(() => sc.close());

  assert.deepEqual(fake.calls, [], "sidecar assembly constructs zero fabric (lazy policy)");
  const sameOrigin = { host: `127.0.0.1:${sc.port}`, origin: sc.origin };

  // ports 插件从未 enabled：数据面 deny
  const enabled = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/ports/enable",
    headers: { ...sameOrigin, ...jsonHeaders },
  });
  assert.equal(enabled.status, 200);
  await flushAsync();
  assert.ok(fake.calls.includes("open"), "data-plane plugin enable triggers ensureStarted");
  assert.ok(fake.calls.includes("start"), "five-step sequence completed");
});

test("wire: enabling a non-data-plane action (config PUT) does not start the fabric", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  t.after(() => sc.close());
  const sameOrigin = { host: `127.0.0.1:${sc.port}`, origin: sc.origin };

  const put = await request(sc.port, {
    method: "PUT",
    path: "/sidecar/plugins/ports/config",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ maxBodyMiB: 0.5 }), // r8-B4 配置域 64KiB-1MiB
  });
  assert.equal(put.status, 200);
  await flushAsync();
  assert.deepEqual(fake.calls, [], "config changes alone never connect");
});

// ---- 聚合路由全链路（经 sidecar 的 serveHttp 绑定 + noteSession） -----------------------

test("wire: aggregated route through the sidecar wiring serves files with session→peer notes", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  t.after(() => sc.close());
  const sameOrigin = { host: `127.0.0.1:${sc.port}`, origin: sc.origin };

  // 提供侧：share 名单收 PEER；files 插件 enable
  const root = path.join(home, "shared");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "a.txt"), "A", "utf8");
  const shareRes = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/files/shares",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ name: "docs", root, mode: "ro", peers: [PEER] }),
  });
  assert.equal(shareRes.status, 200, shareRes.text);
  const shareId = JSON.parse(shareRes.text).share.id;

  const enableFiles = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/files/enable",
    headers: { ...sameOrigin, ...jsonHeaders },
  });
  assert.equal(enableFiles.status, 200);
  await flushAsync();

  // peer 上线 → serveHttp 绑定 → 请求分发（noteSession 使 sessionId 反查到 peer）
  fake.emit({ type: "peer-connected", endpointId: PEER });
  await flushAsync();
  const handler = fake.serveHandlers.get(PEER);
  assert.ok(handler !== undefined, "serveHttp bound for the connected peer");

  const ok = typedRequest({ sessionId: "sess-remote-1", path: `/wpk1/files/${shareId}/list?path=` });
  const okRes = await handler(ok);
  assert.equal(okRes.status, 200, JSON.stringify(okRes));
  const body = JSON.parse(Buffer.from(okRes.bodyChunks[0]).toString("utf8"));
  assert.ok(body.entries.some((e) => e.name === "a.txt"));

  // files 插件停用（摘牌）后同请求 deny
  const disable = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/files/disable",
    headers: { ...sameOrigin, ...jsonHeaders },
  });
  assert.equal(disable.status, 200);
  const denied = await handler(typedRequest({ sessionId: "sess-remote-2", path: `/wpk1/files/${shareId}/list?path=` }));
  assert.equal(denied.status, 503);
  assert.equal(JSON.parse(Buffer.from(denied.bodyChunks[0]).toString("utf8")).error.code, "plugin-disabled");

  // 未知插件段
  const unknown = await handler(typedRequest({ path: "/wpk1/nope/x" }));
  assert.equal(unknown.status, 404);
});

// ---- 管理面：ports ---------------------------------------------------------------------

test("wire: ports management routes CRUD with the Origin four-class matrix", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  t.after(() => sc.close());
  const sameOrigin = { host: `127.0.0.1:${sc.port}`, origin: sc.origin };
  const body = JSON.stringify({ name: "svc", peer: PEER, remotePort: 8080, localPort: 19080 });

  // 写路由 Origin 四类
  const ok = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/mappings", headers: { ...sameOrigin, ...jsonHeaders }, body });
  assert.equal(ok.status, 200, ok.text);
  const noOrigin = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/mappings", headers: { host: `127.0.0.1:${sc.port}`, ...jsonHeaders }, body });
  assert.equal(noOrigin.status, 403, "missing Origin on write routes is rejected");
  const forged = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/mappings", headers: { host: `127.0.0.1:${sc.port}`, origin: "http://evil.example", ...jsonHeaders }, body });
  assert.equal(forged.status, 403);
  const badHost = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/mappings", headers: { host: "evil.example", origin: sc.origin, ...jsonHeaders }, body });
  assert.equal(badHost.status, 403);

  // 读路由基线守卫（缺失 Origin 放行）
  const list = await request(sc.port, { path: "/sidecar/plugins/ports/mappings", headers: { host: `127.0.0.1:${sc.port}` } });
  assert.equal(list.status, 200);
  const row = JSON.parse(list.text).mappings.find((m) => m.name === "svc");
  assert.ok(row !== undefined, "mapping persisted in the ledger");
  assert.equal(row.listener, "stopped", "disabled plugin keeps listeners down");

  // 启停/删除
  const id = row.id;
  const toggle = await request(sc.port, { method: "POST", path: `/sidecar/plugins/ports/mappings/${id}/enabled`, headers: { ...sameOrigin, ...jsonHeaders }, body: JSON.stringify({ enabled: false }) });
  assert.equal(toggle.status, 200);
  const del = await request(sc.port, { method: "DELETE", path: `/sidecar/plugins/ports/mappings/${id}`, headers: sameOrigin });
  assert.equal(del.status, 200);
  const afterDel = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/ports/mappings", headers: { host: `127.0.0.1:${sc.port}` } })).text);
  assert.equal(afterDel.mappings.length, 0);

  // allowlist 授予/回收
  const grant = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/allowlist", headers: { ...sameOrigin, ...jsonHeaders }, body: JSON.stringify({ peer: PEER, remotePort: 8080 }) });
  assert.equal(grant.status, 200);
  const allow = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/ports/allowlist", headers: { host: `127.0.0.1:${sc.port}` } })).text);
  assert.deepEqual(allow.entries.map((e) => [e.peer, e.remotePort]), [[PEER, 8080]]);
  const revoke = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/allowlist/revoke", headers: { ...sameOrigin, ...jsonHeaders }, body: JSON.stringify({ peer: PEER, remotePort: 8080 }) });
  assert.equal(revoke.status, 200);
});

// ---- 管理面：files shares + bridge -----------------------------------------------------

test("wire: files shares CRUD and the bridge envelope forward to the fabric wire path", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  t.after(() => sc.close());
  const sameOrigin = { host: `127.0.0.1:${sc.port}`, origin: sc.origin };

  const root = path.join(home, "shr");
  await mkdir(root, { recursive: true });
  const created = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/files/shares",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ name: "s", root, mode: "rw", peers: [PEER] }),
  });
  assert.equal(created.status, 200, created.text);
  const shareId = JSON.parse(created.text).share.id;

  // mode/peers 更新
  const mode = await request(sc.port, { method: "POST", path: `/sidecar/plugins/files/shares/${shareId}/mode`, headers: { ...sameOrigin, ...jsonHeaders }, body: JSON.stringify({ mode: "ro" }) });
  assert.equal(mode.status, 200);
  const peers = await request(sc.port, { method: "POST", path: `/sidecar/plugins/files/shares/${shareId}/peers`, headers: { ...sameOrigin, ...jsonHeaders }, body: JSON.stringify({ peers: [PEER, "cc".repeat(32)] }) });
  assert.equal(peers.status, 200);
  const list = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/files/shares", headers: { host: `127.0.0.1:${sc.port}` } })).text);
  assert.deepEqual(list.shares.map((s) => [s.id, s.mode, s.peers.length]), [[shareId, "ro", 2]]);

  // bridge：wire 应答注入（headers/body base64 往返 + 路径钉死断言）
  let servedChunks = 0;
  fake.fetchResponses.push({
    status: 200,
    headers: [{ name: "x-opendweb-oid", value: "oid-1" }],
    bodyNext: async () => (servedChunks++ === 0 ? Buffer.from("[1,2]") : null),
  });
  const bridge = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/files/bridge",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ peer: PEER, shareId, method: "GET", path: `/wpk1/files/${shareId}/list?path=` }),
  });
  assert.equal(bridge.status, 200, bridge.text);
  const bRes = JSON.parse(bridge.text);
  assert.equal(bRes.status, 200);
  assert.equal(bRes.headers["x-opendweb-oid"], "oid-1");
  assert.equal(Buffer.from(bRes.bodyBase64, "base64").toString("utf8"), "[1,2]");
  assert.deepEqual(fake.fetches.at(-1), { path: `/wpk1/files/${shareId}/list?path=`, body: null }, "bridge forwards the pinned wire path verbatim");

  // bridge 路径越界（非 files wire 前缀）拒绝
  const evil = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/files/bridge",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ peer: PEER, shareId, method: "GET", path: "/wpk1/ports/proxy/1/x" }),
  });
  assert.equal(evil.status, 400, "bridge is pinned to /wpk1/files/<shareId>/ — not a generic proxy");

  // share 删除
  const del = await request(sc.port, { method: "DELETE", path: `/sidecar/plugins/files/shares/${shareId}`, headers: sameOrigin });
  assert.equal(del.status, 200);
});

// ---- 管理面：sync（无租约 unavailable / 有租约建组+门） --------------------------------

test("wire: sync management without a lease is explicitly unavailable; with a lease it manages groups and gates data-plane actions", async (t) => {
  const noLease = await tempHome(false);
  t.after(() => rm(noLease, { recursive: true, force: true }));
  const fake1 = makeFakeSdk();
  const sc1 = await createSidecar({ homeDir: noLease, sdk: fake1.sdk });
  t.after(() => sc1.close());

  const groups1 = await request(sc1.port, { path: "/sidecar/plugins/sync/groups", headers: { host: `127.0.0.1:${sc1.port}` } });
  assert.equal(groups1.status, 503);
  assert.equal(JSON.parse(groups1.text).error.code, "sync-unavailable");

  // 有租约设备：建组 → 列表；sync-now 停用门（409）→ enable 后 200
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake2 = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake2.sdk });
  t.after(() => sc.close());
  const sameOrigin = { host: `127.0.0.1:${sc.port}`, origin: sc.origin };

  const rootDir = path.join(home, "sync-root");
  await mkdir(rootDir, { recursive: true });
  const created = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/sync/groups",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({
      name: "agents",
      peerEndpointId: PEER,
      peerDeviceName: "iMac",
      roots: [{ localPath: rootDir, mode: "twoway", seedAuthority: "self" }],
    }),
  });
  assert.equal(created.status, 200, created.text);
  const group = JSON.parse(created.text).group;
  assert.equal(group.roots[0].seedAuthority, LEASE.root, '"self" resolves to the local endpoint id');

  const groups = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/sync/groups", headers: { host: `127.0.0.1:${sc.port}` } })).text);
  assert.equal(groups.groups.length, 1);
  assert.equal(groups.groups[0].members.length, 2, "members=[self, peer]");
  assert.equal(groups.groups[0].self.endpointId, LEASE.root);

  // 停用态 sync-now → 409（数据面摘牌）
  const gated = await request(sc.port, { method: "POST", path: `/sidecar/plugins/sync/groups/${group.id}/sync-now`, headers: sameOrigin });
  assert.equal(gated.status, 409);
  assert.equal(JSON.parse(gated.text).error.code, "plugin-disabled");

  const enable = await request(sc.port, { method: "POST", path: "/sidecar/plugins/sync/enable", headers: { ...sameOrigin, ...jsonHeaders } });
  assert.equal(enable.status, 200);
  const syncNow = await request(sc.port, { method: "POST", path: `/sidecar/plugins/sync/groups/${group.id}/sync-now`, headers: sameOrigin });
  assert.equal(syncNow.status, 200, syncNow.text);
  const status = await request(sc.port, { path: "/sidecar/plugins/sync/status", headers: { host: `127.0.0.1:${sc.port}` } });
  assert.equal(status.status, 200);

  const del = await request(sc.port, { method: "DELETE", path: `/sidecar/plugins/sync/groups/${group.id}`, headers: sameOrigin });
  assert.equal(del.status, 200);
});

// ---- close 顺序 ------------------------------------------------------------------------

test("wire: close runs plugin dispose before the fabric shutdown", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  const sameOrigin = { host: `127.0.0.1:${sc.port}`, origin: sc.origin };
  await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/enable", headers: { ...sameOrigin, ...jsonHeaders } });
  await flushAsync();
  const openIdx = fake.calls.indexOf("open");
  assert.ok(openIdx !== -1);

  await sc.close();
  const shutdownIdx = fake.calls.indexOf("shutdown");
  assert.ok(shutdownIdx > openIdx, "fabric shutdown happens during close");
  assert.equal(fake.calls.filter((c) => c === "shutdown").length, 1, "close is idempotent on the fabric");
});

// ---- 管理面：sync 建组显式 id 透传（真双机验收 F3，2026-09-30） ------------------------
// 组模型语义=两端各建一次**同 id** 组（design §7.2/GroupsPage 表单说明）；建组路由
// 不透传 id 时对端永远无法配对（随机 id）。显式 id 必须被采纳，非法字符集按
// invalid 拒绝，同 id 同形状幂等、同 id 异形状 conflict。

test("wire: sync group creation honors an explicit id (cross-device same-id pairing); invalid/duplicate shapes rejected", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  t.after(() => sc.close());
  const sameOrigin = { host: `127.0.0.1:${sc.port}`, origin: sc.origin };
  const rootDir = path.join(home, "sync-root");
  await mkdir(rootDir, { recursive: true });
  const draft = {
    name: "agents-skills",
    peerEndpointId: PEER,
    peerDeviceName: "peer-device",
    roots: [{ localPath: rootDir, mode: "twoway", seedAuthority: "self" }],
  };

  const created = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/sync/groups",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ ...draft, id: "agents-skills-main" }),
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(JSON.parse(created.text).group.id, "agents-skills-main", "explicit id is honored (not randomized)");

  // 同 id 同形状（本端视角成员顺序恒 [self, peer]）→ 幂等成功
  const replay = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/sync/groups",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ ...draft, id: "agents-skills-main" }),
  });
  assert.equal(replay.status, 200, replay.text);

  // 同 id 异形状 → conflict 400
  const clash = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/sync/groups",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ ...draft, id: "agents-skills-main", name: "renamed" }),
  });
  assert.equal(clash.status, 400);
  assert.equal(JSON.parse(clash.text).error.code, "conflict");

  // 非法字符集（大写/下划线）→ invalid 400
  const badId = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/sync/groups",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify({ ...draft, id: "Bad_Id" }),
  });
  assert.equal(badId.status, 400);
  assert.equal(JSON.parse(badId.text).error.code, "invalid");

  // 无 id → 随机生成（既有行为不变）
  const auto = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/sync/groups",
    headers: { ...sameOrigin, ...jsonHeaders },
    body: JSON.stringify(draft),
  });
  assert.equal(auto.status, 200, auto.text);
  const autoId = JSON.parse(auto.text).group.id;
  assert.match(autoId, /^g-/, "omitted id still falls back to random generation");
});
