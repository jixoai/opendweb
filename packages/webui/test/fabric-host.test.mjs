// fabric 宿主生命周期集成测试（webui-plugin-kernel 收官接线 / home-hub §2
// 冻结五步时序）。SDK=注入替身（真实 Fabric 太重——原生二进制+网络面不可入
// 仓内测试）；断言面=调用序/参数/缓存行为，不触网。
// 覆盖：
// 1. 惰性：构造零调用；ensureStarted 才走五步（open(deferStart+dataDir)→
//    姿态/模式分流→[显式 relay 模式且 root] ensure+覆盖断言→元组断言→start）；
//    [W12] direct-only 缺省：构造不携带 relay（租约 relay 不进数据面），
//    root 与 member 一律跳过 ②③；
// 1b. 姿态分流：member（配对加入的对方 fabric / joinWithToken 接管）跳过
//    root-only ensure（NotRoot 根因回归面）；显式 relay opt-in 下 root 走
//    ensure+覆盖（覆盖缺口=fail-closed）；
// 1c. no-lease 边界（[W12]）：租约是身份元组源——relay_url 不可用不再阻断
//    direct-only 数据面 start；
// 2. fail-closed：无租约/（显式 relay 模式下）覆盖缺口/元组不符 → 不 start；
//    失败可重试；
// 3. single-flight：并发 ensureStarted 一次构造；
// 4. 会话缓存：同 peer 一会话；peer-disconnected/onState disconnected 逐出；
// 5. serveHttp 绑定：peer-connected→router 分发；router 未接线=503；
// 6. close 顺序：serve 拆线→会话关闭→shutdown；幂等；close 后 ensureStarted 拒绝。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFabricHost, createWpkRouter, hexToZ32, z32ToHex } from "../src/core/fabric.mjs";

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

/** SDK 替身（调用序/参数全记录）。over.rootEndpointId 模拟名册 root（缺省=
 * 本机 endpointId → root 姿态）；over.joined 模拟 Fabric.joinWithToken 的产物。 */
function makeFakeSdk(over = {}) {
  const calls = [];
  let eventCb = null;
  const serveHandlers = new Map();
  const sessions = [];
  const fabric = {
    // SDK 的 endpointId 是 z32 展示串（与租约 root 的 hex64 同钥异码——
    // startSequence ④断言先 z32ToHex 归一；替身用真实编码形态）
    endpointId: over.endpointId ?? hexToZ32(LEASE.root),
    openOpts: null,
    fabricIdHex: async () => over.fabricIdHex ?? LEASE.fabric_id,
    rootEndpointId: async () => over.rootEndpointId ?? fabric.endpointId,
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
  const joined = {
    endpointId: over.joinedEndpointId ?? "99".repeat(32),
    fabricIdHex: async () => over.joinedFabricIdHex ?? "77".repeat(32),
    rootEndpointId: async () => (over.joinedRoot !== undefined ? over.joinedRoot : LEASE.root),
    async ensureRelayCapabilities() {
      calls.push("joined-ensure");
      return [{ url: LEASE.relay_url, token: "dwebr1.joined" }];
    },
    async start() {
      calls.push("joined-start");
    },
    on(cb) {
      eventCb = cb;
      return () => {
        eventCb = null;
      };
    },
    async shutdown() {
      calls.push("joined-shutdown");
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
        async createRoot(opts) {
          calls.push("createRoot");
          fabric.openOpts = opts;
          return fabric;
        },
        async joinWithToken(opts, token) {
          calls.push(`joinWithToken:${token}`);
          if (over.joinWithTokenRejects) throw new Error(over.joinWithTokenRejects);
          joined.joinOpts = opts;
          return joined;
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
    joined,
    sessions,
    serveHandlers,
    over,
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

test("fabric host: lazy construction is zero-outbound; ensureStarted runs the frozen five-step sequence (direct-only default)", async (t) => {
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
  // ① open：dataDir=DWEB_HOME + deferStart；[W12] direct-only——构造不携带
  // relay（租约 relay 不装配数据面）；不携带 fabricId 期望（既有 roster 即
  // 权威——可能是配对加入的对方 fabric）
  const open = fake.calls.indexOf("open");
  assert.ok(open !== -1, "Fabric.open called");
  assert.deepEqual(fake.fabric.openOpts, {
    dataDir: home,
    deferStart: true,
  });
  // ② [W12] direct-only 缺省：root 也跳过 root-only ensure（无 relay 数据面
  // 可覆盖）；⑤ start 直接执行
  assert.ok(!fake.calls.includes("ensure"), "direct-only default MUST NOT call ensureRelayCapabilities ([W12])");
  assert.ok(fake.calls.indexOf("start") > open, "start after open");
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

test("fabric host: explicit relay data-plane opt-in runs root ensure+coverage; mismatch fails closed and can retry after heal", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  // [W12]：显式 relay 数据面（QUIC/TLS 形态——非 hub HTTP-only 租约 relay）
  // 是唯一执行 root ②③ 的模式；覆盖对象=显式配置的 relay 集
  const relayOpt = { mode: "custom", relays: [{ url: LEASE.relay_url, serverId: LEASE.server_id }] };
  const fake = makeFakeSdk({ caps: [{ url: "http://other-relay:1", token: "dwebr1.x" }] });
  const host = await createFabricHost({ home, sdk: fake.sdk, relay: relayOpt });
  t.after(() => host.close());

  await assert.rejects(host.ensureStarted(), /did not cover/);
  assert.ok(fake.calls.includes("ensure"), "explicit relay mode MUST run root-only ensureRelayCapabilities");
  assert.ok(!fake.calls.includes("start"), "start MUST NOT run when coverage fails");
  assert.equal(host.status().status, "failed");
  // 账本愈合（caps 覆盖显式 relay 集）后可重试
  fake.over.caps = [{ url: LEASE.relay_url, token: "dwebr1.ok" }];
  await host.ensureStarted();
  assert.equal(host.status().status, "started");
  assert.deepEqual(fake.fabric.openOpts.relay, relayOpt, "explicit relay config reaches the SDK ctor");
});

test("fabric host: tuple mismatch (fabric id / endpoint id) fails closed before start", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  // fabricId 断言只在 createRoot 采纳路径成立：无 roster → 采纳建册 →
  // 册 fabricId ≠ 租约 = fail-closed
  const badId = makeFakeSdk({ openRejects: "no persisted roster for this data directory", fabricIdHex: "cc".repeat(32) });
  const host1 = await createFabricHost({ home, sdk: badId.sdk });
  t.after(() => host1.close());
  await assert.rejects(host1.ensureStarted(), /fabric id mismatch/);
  assert.ok(!badId.calls.includes("start"));
  assert.deepEqual(badId.fabric.openOpts.fabricId, LEASE.fabric_id, "createRoot adopts the lease fabric id");

  const badEndpoint = makeFakeSdk({ endpointId: "dd".repeat(32) });
  const host2 = await createFabricHost({ home, sdk: badEndpoint.sdk });
  t.after(() => host2.close());
  await assert.rejects(host2.ensureStarted(), /endpoint id mismatch/);
  assert.ok(!badEndpoint.calls.includes("start"));
});

// ---- 2b. 姿态分流（root vs member——真双机验收 NotRoot 根因的回归面） -------------

test("fabric host: member posture (joined roster, foreign root) skips root-only ensure and starts", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  // 名册 root=邀请方（≠本机 endpointId）——设备配对加入对方 fabric 后的重启形态
  const fake = makeFakeSdk({ rootEndpointId: hexToZ32("ab".repeat(32)) });
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());

  await host.ensureStarted();
  assert.equal(host.status().status, "started");
  assert.ok(!fake.calls.includes("ensure"), "member MUST NOT call root-only ensureRelayCapabilities");
  assert.ok(fake.calls.includes("start"), "member still starts (caps via persisted OK2 + start injection)");
});

// ---- 2c. 回环 relay LAN 化（invite 可路由性——真双机验收实证） ----------------------

async function homeWithLoopbackLease() {
  const home = await mkdtemp(path.join(tmpdir(), "wpk-fabric-"));
  const loopLease = { ...LEASE, relay_url: "http://127.0.0.1:3340" };
  await writeFile(path.join(home, "leases.json"), JSON.stringify({ version: 1, leases: [loopLease] }, null, 2), "utf8");
  return home;
}

test("fabric host: loopback lease relay is rewritten to the advertised LAN host (management-plane projection only)", async (t) => {
  const home = await homeWithLoopbackLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk({ caps: [{ url: "http://192.168.2.8:3340", token: "dwebr1.lan" }] });
  const host = await createFabricHost({ home, sdk: fake.sdk, advertiseAddrs: ["192.168.2.8:3341"] });
  t.after(() => host.close());

  await host.ensureStarted();
  // [W12] direct-only：构造不携带 relay——租约 relay 只活在 identity() 投影
  //（管理面观测/显式 opt-in 材料），LAN 化改写语义保持
  assert.ok(!("relay" in fake.fabric.openOpts), "lease relay MUST NOT be assembled into the data plane ([W12])");
  assert.deepEqual(fake.fabric.openOpts.advertiseAddrs, ["192.168.2.8:3341"]);
  // identity() 同源（joinWithToken 构造与此同一 readIdentity）
  const id = await host.identity();
  assert.deepEqual(id.relays, [{ url: "http://192.168.2.8:3340", serverId: LEASE.server_id }]);
});

test("fabric host: loopback lease relay is kept verbatim without advertised LAN addrs", async (t) => {
  const home = await homeWithLoopbackLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk({ caps: [{ url: "http://127.0.0.1:3340", token: "dwebr1.loop" }] });
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());

  await host.ensureStarted();
  assert.ok(!("relay" in fake.fabric.openOpts), "direct-only ctor carries no relay ([W12])");
  const id = await host.identity();
  assert.deepEqual(id.relays, [{ url: "http://127.0.0.1:3340", serverId: LEASE.server_id }]);
});

test("fabric host: lease without a usable relay no longer blocks direct-only start ([W12] no-lease boundary)", async (t) => {
  // 边界修订：租约是身份元组来源（fabricId/endpointId/deviceName 派生不变），
  // relay_url 不可用不再阻断 start——已有 roster+known_addrs 的设备照常进
  // direct-only 数据面（此前 valid 过滤 relay 字段，无可用 relay 即 no-lease）。
  const home = await mkdtemp(path.join(tmpdir(), "wpk-fabric-"));
  const leaseNoRelay = { ...LEASE, relay_url: "", server_id: "" };
  await writeFile(path.join(home, "leases.json"), JSON.stringify({ version: 1, leases: [leaseNoRelay] }, null, 2), "utf8");
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());

  const id = await host.identity();
  assert.ok(id !== null, "identity tuple still derives from the lease");
  assert.equal(id.endpointId, LEASE.root);
  assert.deepEqual(id.relays, [], "no usable relay entries => empty projection, not no-lease");
  await host.ensureStarted();
  assert.equal(host.status().status, "started");
  assert.ok(!("relay" in fake.fabric.openOpts), "direct-only ctor ([W12])");
});

test("fabric host: joinWithToken takes over as member (no root-only ensure; wires events; returns fabricId)", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());
  const PEER = "ee".repeat(32);

  await host.ensureStarted(); // 旧 fabric（本机 root 册）先行
  const out = await host.joinWithToken({ token: "dweb2.test-token" });
  assert.deepEqual(out, { fabricId: "77".repeat(32) });
  assert.ok(fake.calls.includes("joinWithToken:dweb2.test-token"), "SDK joinWithToken invoked");
  // [W12] direct-only：join 构造不携带 relay（发现=令牌 advertiseAddrs+known_addrs）
  assert.deepEqual(fake.joined.joinOpts, { dataDir: home, deferStart: true });
  assert.ok(!fake.calls.includes("joined-ensure"), "member MUST NOT call ensureRelayCapabilities after join");
  assert.ok(fake.calls.includes("joined-start"), "joined fabric started");
  assert.ok(fake.calls.includes("shutdown"), "old fabric torn down on takeover");
  assert.equal(host.status().status, "started");

  // 接管后事件接线生效：peer-connected 绑 serveHttp（sync notifyOnline 同源）
  fake.emit({ type: "peer-connected", endpointId: PEER });
  await new Promise((r) => setImmediate(r));
  assert.ok(fake.serveHandlers.has(PEER), "serveHttp bound on joined fabric events");
});

test("fabric host: joinWithToken fails closed when the joined roster lacks a foreign root", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk({ joinedRoot: null });
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());

  await assert.rejects(host.joinWithToken({ token: "dweb2.x" }), /expected the inviter/);
  assert.ok(fake.calls.includes("joined-shutdown"), "joined fabric released on sanity failure");
  assert.ok(!fake.calls.includes("joined-start"), "no start after fail-closed");
});

// ---- 3. 会话缓存/失效 -----------------------------------------------------------------

test("fabric host: sessionResolver caches per peer and evicts on peer-disconnected / session state", async (t) => {
  const home = await homeWithLease();
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const host = await createFabricHost({ home, sdk: fake.sdk });
  t.after(() => host.close());
  // z32 形态 peer（SDK 展示串——账本 hex 输入会被归一，此处直用展示串）
  const PEER = hexToZ32("ee".repeat(32));

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

// ---- 6. z32↔hex 编码归一（会话 peer/endpointId 归一源） ----------------------------------

test("z32/hex roundtrip: hexToZ32 pads the tail group MSB-first (data_encoding semantics)", () => {
  // 尾位为 1 的键是历史缺陷的暴露面（32B=51 字符+1 bit，残余位必须左移到
  // 末字符 MSB；此前落在 LSB 产出错误末字符——对端解析成另一把公钥）
  for (const byte of ["00", "01", "07", "ab", "b0", "9a", "bb", "ff"]) {
    const hex = byte.repeat(32);
    const z = hexToZ32(hex);
    assert.equal(z.length, 52, `52 z32 chars for 32 bytes (${byte})`);
    assert.equal(z32ToHex(z), hex, `roundtrip ${byte}`);
  }
  // 现场两端点（末端 bit=0——历史缺陷与其重合的侥幸位）+ 结构化随机向量
  for (const hex of ["cb416b034d43f11ea2fd4862ea52e6044d91a7b06a4fa7066f68d8df847934b0", "ec80ba47821deba5019c2fee2ecab2ccdca81885dd8d61f9d67907463e2a879a"]) {
    assert.equal(z32ToHex(hexToZ32(hex)), hex);
  }
  for (let i = 0; i < 64; i++) {
    const hex = Buffer.from(new Uint8Array(32).map((_, j) => (i * 31 + j * 7) & 0xff)).toString("hex");
    assert.equal(z32ToHex(hexToZ32(hex)), hex, `vector ${i}`);
  }
});

// ---- 7. 聚合路由矩阵（createWpkRouter——纯函数面） --------------------------------------

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
