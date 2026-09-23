// createConsole 测试面（home-hub [H4] Phase 2a / specs/webui「webui SDK 分层与
// 进程内宿主」/ design §5.1 契约冻结）。覆盖：
// 1. 契约形态：opener 必填（core 零浏览器 spawn——行为+结构双断言）；urlFor
//    纯函数（深链归一/独立 capability/无 token）；open 只经注入回调；
// 2. 会话 capability v1（本地 http 探测实测）：单次消费 200→重放 403（记录行
//    且值不入日志/query 不落访问日志）/过期 403/跨实例 403/close 后连接即拒；
//    URL 至多含一次性 capability——绝无 hub-token/admin token；
// 3. 事件 schema v1：恰一帧 {v:1,type:"node-switch",...}；disposer；close 后
//    静默+再订阅抛错；error 帧（switchTarget 失败）；knock-pending 可订阅；
//    impl 级 state-change（配对成功）与 node-switch（HTTP switch）接线；
// 4. getSnapshot 同步性（{mode,node,hub} 槽位——hub 2a 冻结 null）；
// 5. switchTarget 进程内直调（快照即刻更新/代理面转向；unknown id 抛错）；
// 6. 分层零破坏：startSidecar 返回形状冻结；普通 sidecar 无 /sidecar/session
//    （404 维持）；src/sidecar.mjs 兼容 shim 与 index 同源；plugin/bin 冒烟；
// 7. import 面：cardkit（workspace 依赖→短码/QR 算法）往返。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createConsole,
  CAPABILITY_QUERY_PARAM,
  CAPABILITY_TTL_MS,
  createCapabilities,
  startSidecar,
  NodeStore,
  EVENT_TYPES,
  EventBus,
} from "../src/index.mjs";
import { createSidecar } from "../src/core/sidecar.mjs";
import * as cardkit from "../src/core/cardkit.mjs";
import * as shimSidecar from "../src/sidecar.mjs";
import * as sdk from "../src/index.mjs";
import plugin from "../src/plugin.mjs";
import { fakeUpstream, postJson, request } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** ready 态 target（指向假上游——与其他测试文件同构） */
function targetFor(upstream) {
  return {
    scheme: "http",
    hostname: "127.0.0.1",
    port: upstream.port,
    hostHeader: `127.0.0.1:${upstream.port}`,
    connectHost: "127.0.0.1",
    servername: null,
    insecure: false,
  };
}

/** console 句柄上取回环端口（契约面无 port 字段——从 urlFor 产物解析） */
function portOf(con) {
  const u = con.urlFor(); // http://127.0.0.1:<port>/?dweb_console=...
  return Number(u.slice("http://127.0.0.1:".length, u.indexOf("/?")));
}

/** 可推进的假时钟（capability TTL/事件 ts 注入面） */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

/** 从 urlFor 产物中提取会话 capability 值 */
function capOf(url) {
  const m = new RegExp(`[?&]${CAPABILITY_QUERY_PARAM}=([A-Za-z0-9_-]+)`).exec(url);
  assert.ok(m, `url carries ${CAPABILITY_QUERY_PARAM}: ${url}`);
  return m[1];
}

const OK_HANDLER = (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

test.afterEach(async () => {}); // 各用例自管 close（t.after 显式挂）

// ---- 契约形态：opener / urlFor / open ------------------------------------------------

test("createConsole: missing opts.opener rejects with an explicit message", async () => {
  await assert.rejects(() => createConsole({}), /opener/);
  await assert.rejects(() => createConsole({ opener: "not-a-function" }), /opener/);
});

test("open: injected opener is invoked exactly once, with urlFor output; core never spawns", async (t) => {
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const urls = [];
  const con = await createConsole({ opener: (u) => urls.push(u), target: targetFor(upstream), token: "sekret-admin-token-xyz" });
  t.after(() => con.close());

  con.open("#/lease");
  assert.equal(urls.length, 1, "opener called exactly once");
  assert.match(
    urls[0],
    new RegExp(`^http://127\\.0\\.0\\.1:\\d+/\\?${CAPABILITY_QUERY_PARAM}=[A-Za-z0-9_-]{22}#/lease$`),
    "deep link lands on the lease route with a one-time capability",
  );
  assert.ok(!urls[0].includes("sekret-admin-token-xyz"), "admin token never appears in the URL");

  // opener 抛出的哨兵必须原样穿透（证明打开行为只经注入回调，core 无旁路）
  const sentinel = new Error("opener-sentinel");
  const con2 = await createConsole({ opener: () => { throw sentinel; }, target: targetFor(upstream), token: "t2" });
  t.after(() => con2.close());
  assert.throws(() => con2.open(), (e) => e === sentinel);
});

test("structural: src/core has zero browser/process spawn (shell layer keeps it)", async () => {
  const coreDir = path.join(here, "..", "src", "core");
  for (const f of await readdir(coreDir)) {
    if (!f.endsWith(".mjs")) continue;
    const src = await readFile(path.join(coreDir, f), "utf8");
    assert.ok(!src.includes("child_process"), `${f}: core must not import child_process`);
    assert.ok(!/\bspawn\s*\(/.test(src), `${f}: core must not call spawn()`);
  }
});

test("urlFor: pure URL generation — fresh capability per call, deep link normalization, no side effects", async (t) => {
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const con = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "t-urlfor" });
  t.after(() => con.close());

  const a = con.urlFor();
  const b = con.urlFor();
  const c = con.urlFor("/hub");
  const d = con.urlFor("#/lease");
  assert.match(a, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/\\?${CAPABILITY_QUERY_PARAM}=[A-Za-z0-9_-]{22}$`));
  assert.ok(!a.includes("#"), "no deep link when none requested");
  assert.notEqual(capOf(a), capOf(b), "each urlFor mints an independent capability");
  assert.ok(c.endsWith("#/hub"), "'/hub' normalizes to '#/hub'");
  assert.ok(d.endsWith("#/lease"), "'#/lease' accepted as-is");
  for (const u of [a, b, c, d]) assert.ok(!u.includes("t-urlfor"), "no token in any URL");
  // 深链校验：仅 hash 路由形态
  assert.throws(() => con.urlFor("#lease"), TypeError);
  assert.throws(() => con.urlFor("http://evil.example/"), TypeError);
  assert.throws(() => con.urlFor(""), TypeError);
  assert.throws(() => con.urlFor("#/"), TypeError);
  assert.throws(() => con.urlFor(123), TypeError);
  // 纯函数：只生成不打开——opener 零调用
  let opened = 0;
  const con2 = await createConsole({ opener: () => { opened += 1; }, target: targetFor(upstream), token: "t2" });
  t.after(() => con2.close());
  con2.urlFor();
  con2.urlFor("#/lease");
  assert.equal(opened, 0);
});

// ---- 会话 capability v1（本地 http 探测实测） ---------------------------------------

test("capability: single consumption 200 → replay 403 (recorded; value/query never logged)", async (t) => {
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const logs = [];
  const con = await createConsole({
    opener: () => {},
    target: targetFor(upstream),
    token: "t-cap",
    log: (line) => logs.push(line),
  });
  t.after(() => con.close());

  const url = con.urlFor("#/lease");
  const cap = capOf(url);
  const sessionPath = `/sidecar/session?${CAPABILITY_QUERY_PARAM}=${cap}`;
  const port = portOf(con);

  const ok1 = await request(port, { path: sessionPath });
  assert.equal(ok1.status, 200, ok1.text);
  const body = JSON.parse(ok1.text);
  assert.equal(body.ok, true);
  assert.equal(body.phase, "ready");
  assert.ok(typeof body.server_host_masked === "string", "masked host projection present");

  const replay = await request(port, { path: sessionPath });
  assert.equal(replay.status, 403, "replayed capability is rejected");
  assert.equal(JSON.parse(replay.text).error.code, "capability-replay");

  const all = logs.join("\n");
  assert.ok(/capability replay rejected/.test(all), "replay is recorded");
  assert.ok(!all.includes(cap), "capability value never appears in logs");
  const accessLines = logs.filter((l) => /^GET /.test(l)).join("\n");
  assert.ok(!accessLines.includes("?"), "access log lines carry no query string");
});

test("capability: garbage / missing / bad Host on the session face", async (t) => {
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const con = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "t-cap2" });
  t.after(() => con.close());
  const port = portOf(con);

  const garbage = await request(port, { path: `/sidecar/session?${CAPABILITY_QUERY_PARAM}=totally-bogus-value` });
  assert.equal(garbage.status, 403);
  assert.equal(JSON.parse(garbage.text).error.code, "capability-invalid");

  const missing = await request(port, { path: "/sidecar/session" });
  assert.equal(missing.status, 403);
  assert.equal(JSON.parse(missing.text).error.code, "capability-invalid");

  const cap = capOf(con.urlFor());
  const badHost = await request(port, {
    path: `/sidecar/session?${CAPABILITY_QUERY_PARAM}=${cap}`,
    headers: { host: "evil.example" },
  });
  assert.equal(badHost.status, 400);
  assert.equal(JSON.parse(badHost.text).error.code, "bad-origin-host");
});

test("capability: TTL expiry is a distinct 403 (lazy check on the injected clock)", async (t) => {
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const clock = fakeClock();
  const con = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "t-ttl", now: clock.now });
  t.after(() => con.close());

  const url = con.urlFor();
  clock.advance(CAPABILITY_TTL_MS + 1);
  const r = await request(portOf(con), { path: `/sidecar/session?${CAPABILITY_QUERY_PARAM}=${capOf(url)}` });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.text).error.code, "capability-expired");
});

test("capability: cross-instance use is invalid (bound to the issuing sidecar)", async (t) => {
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const a = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "t-a" });
  t.after(() => a.close());
  const b = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "t-b" });
  t.after(() => b.close());

  const foreign = await request(portOf(b), { path: `/sidecar/session?${CAPABILITY_QUERY_PARAM}=${capOf(a.urlFor())}` });
  assert.equal(foreign.status, 403, "a capability minted by console A does not open console B");
  assert.equal(JSON.parse(foreign.text).error.code, "capability-invalid");
});

test("capability: close() invalidates immediately (local http probe fails to connect)", async (t) => {
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const con = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "t-close" });
  const url = con.urlFor();
  const sessionPath = `/sidecar/session?${CAPABILITY_QUERY_PARAM}=${capOf(url)}`;
  const port = portOf(con);
  const alive = await request(port, { path: sessionPath });
  assert.equal(alive.status, 200);
  await con.close();
  // agent:false——不复用 keep-alive 旧 socket（否则得到的是 hang up 而非拒连）
  await assert.rejects(
    () => request(port, { path: sessionPath, agent: false }),
    (e) => e?.code === "ECONNREFUSED",
    "server is gone after close",
  );
  // close 幂等 + close 后 urlFor/open/onEvent/switchTarget 明确抛错
  await con.close();
  assert.throws(() => con.urlFor(), /closed/);
  assert.throws(() => con.open(), /closed/);
  assert.throws(() => con.onEvent("state-change", () => {}), /closed/);
  await assert.rejects(() => con.switchTarget("x"), /closed/);
});

test("capability registry unit: reasons invalid/replay/expired + close; 128-bit entropy; injectable random", () => {
  const clock = fakeClock();
  const reg = createCapabilities({ now: clock.now });
  const cap = reg.issue();
  assert.equal(cap.length, 22, "16 bytes → 22 base64url chars (≥128-bit)");
  assert.deepEqual(reg.consume(cap), { ok: true });
  assert.deepEqual(reg.consume(cap), { ok: false, reason: "replay" }, "single consumption");
  assert.deepEqual(reg.consume("no-such-capability"), { ok: false, reason: "invalid" });
  const other = reg.issue();
  clock.advance(CAPABILITY_TTL_MS + 1);
  assert.deepEqual(reg.consume(other), { ok: false, reason: "expired" });
  const closed = createCapabilities({ now: clock.now });
  const c2 = closed.issue();
  closed.close();
  assert.deepEqual(closed.consume(c2), { ok: false, reason: "invalid" }, "closed registry accepts nothing");
  const fixed = createCapabilities({ now: clock.now, random: (n) => Buffer.alloc(n, 0xab) });
  assert.equal(fixed.issue(), Buffer.alloc(16, 0xab).toString("base64url"));
});

// ---- 事件 schema v1 ------------------------------------------------------------------

test("events: node-switch delivered as exactly one schema v1 frame; disposer cancels", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-console-events-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstreamA = await fakeUpstream({ handler: OK_HANDLER });
  const upstreamB = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstreamA.close());
  t.after(() => upstreamB.close());
  const store = new NodeStore(path.join(dir, "nodes.json"));
  await store.load();
  const entryB = await store.add({ name: "node-b", server_host: upstreamB.url, token: "tok-b", added_at: 1 });

  const con = await createConsole({ opener: () => {}, target: targetFor(upstreamA), token: "tok-a", nodesStore: store });
  t.after(() => con.close());

  const frames = [];
  const disposer = con.onEvent("node-switch", (f) => frames.push(f));
  await con.switchTarget(entryB.id);
  assert.equal(frames.length, 1, "exactly one node-switch frame");
  const f = frames[0];
  assert.equal(f.v, 1);
  assert.equal(f.type, "node-switch");
  assert.deepEqual(f.payload, { node_id: entryB.id });
  assert.equal(typeof f.ts, "number");

  // disposer：取消后再有失败切换也不投递
  disposer();
  disposer(); // 幂等
  await assert.rejects(() => con.switchTarget("no-such-id"));
  assert.equal(frames.length, 1, "no further frames after dispose");
});

test("events: switchTarget failure emits one error frame and throws; unknown types rejected; knock-pending subscribable", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-console-err-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const store = new NodeStore(path.join(dir, "nodes.json"));
  await store.load();

  const con = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "tok", nodesStore: store });
  t.after(() => con.close());

  const errs = [];
  con.onEvent("error", (f) => errs.push(f));
  await assert.rejects(() => con.switchTarget("no-such-node"), /no-match/);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].v, 1);
  assert.equal(errs[0].type, "error");
  assert.equal(errs[0].payload.code, "no-match");

  assert.throws(() => con.onEvent("bogus-type", () => {}), /unknown event type/);
  assert.throws(() => con.onEvent("node-switch", "not-a-function"), /must be a function/);
  const knocks = [];
  const d = con.onEvent("knock-pending", (f) => knocks.push(f));
  assert.equal(typeof d, "function");
  d();

  // 无节点簿：switchTarget 明确失败（not-found）
  const bare = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "tok2" });
  t.after(() => bare.close());
  await assert.rejects(() => bare.switchTarget("any"), /not-found/);
});

test("events bus unit: frames, close silence, re-subscribe error", () => {
  const bus = new EventBus({ now: () => 42 });
  const seen = [];
  const d = bus.on("state-change", (f) => seen.push(f));
  bus.emit("state-change", { mode: "ready" });
  bus.emit("knock-pending", { n: 1 }); // 无订阅者：安静
  assert.deepEqual(seen, [{ v: 1, type: "state-change", payload: { mode: "ready" }, ts: 42 }]);
  d();
  bus.close();
  bus.emit("state-change", { mode: "ready" }); // close 后静默
  assert.equal(seen.length, 1);
  assert.throws(() => bus.on("state-change", () => {}), /closed/);
  assert.deepEqual(EVENT_TYPES, ["state-change", "node-switch", "knock-pending", "error"]);
});

test("events wiring (impl level): pairing success emits state-change; HTTP node switch emits node-switch", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-console-wire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstreamA = await fakeUpstream({ handler: OK_HANDLER });
  const upstreamB = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstreamA.close());
  t.after(() => upstreamB.close());
  const bus = new EventBus();
  const store = new NodeStore(path.join(dir, "nodes.json"));
  await store.load();
  const entryB = await store.add({ name: "b", server_host: upstreamB.url, token: "tok-b", added_at: 1 });

  const sc = await createSidecar({ bus, nodesStore: store, log: () => {} });
  t.after(() => sc.close());

  const frames = [];
  bus.on("state-change", (f) => frames.push(f));
  bus.on("node-switch", (f) => frames.push(f));

  const paired = await postJson(sc.port, "/sidecar/connect", {
    pairing_code: sc.pairingCode,
    server: upstreamA.url,
    token: "tok-a",
  });
  assert.equal(paired.status, 200, paired.text);

  const switched = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: entryB.id });
  assert.equal(switched.status, 200, switched.text);

  assert.deepEqual(
    frames.map((f) => ({ v: f.v, type: f.type, payload: f.payload })),
    [
      { v: 1, type: "state-change", payload: { mode: "ready" } },
      { v: 1, type: "node-switch", payload: { node_id: entryB.id } },
    ],
  );
});

// ---- getSnapshot / switchTarget -------------------------------------------------------

test("getSnapshot: synchronous {mode,node,hub} snapshot (hub slot frozen null in 2a)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-console-snap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstreamA = await fakeUpstream({ handler: OK_HANDLER });
  const upstreamB = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstreamA.close());
  t.after(() => upstreamB.close());
  const store = new NodeStore(path.join(dir, "nodes.json"));
  await store.load();
  const entryB = await store.add({ name: "家里节点", server_host: upstreamB.url, token: "tok-b", added_at: 7 });

  const con = await createConsole({ opener: () => {}, target: targetFor(upstreamA), token: "tok-a", nodesStore: store });
  t.after(() => con.close());

  const before = con.getSnapshot();
  assert.ok(!(before instanceof Promise), "snapshot is synchronous (not a promise)");
  assert.deepEqual(before, { mode: "ready", node: null, hub: null }, "--server target is not in the node book");

  await con.switchTarget(entryB.id);
  const after = con.getSnapshot();
  assert.equal(after.mode, "ready");
  assert.deepEqual(Object.keys(after.node).sort(), ["added_at", "current", "id", "name", "server_host"]);
  assert.equal(after.node.id, entryB.id);
  assert.equal(after.node.current, true);
  assert.equal(after.hub, null, "hub slot reserved for 2b (/sidecar/hub)");

  // 切换后代理面即刻指向新节点（进程未重启、同端口）
  const probe = await request(portOf(con), { path: "/api/status" });
  assert.equal(probe.status, 200);
  assert.equal(upstreamB.hits.length >= 1, true, "proxy now hits upstream B");
});

test("switchTarget: in-process direct call switches the proxy target without HTTP to the switch route", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "webui-console-sw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstreamA = await fakeUpstream({ handler: OK_HANDLER });
  const upstreamB = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstreamA.close());
  t.after(() => upstreamB.close());
  const store = new NodeStore(path.join(dir, "nodes.json"));
  await store.load();
  const entryB = await store.add({ server_host: upstreamB.url, token: "tok-b", added_at: 1 });

  const con = await createConsole({ opener: () => {}, target: targetFor(upstreamA), token: "tok-a", nodesStore: store });
  t.after(() => con.close());

  const r = await con.switchTarget(entryB.id);
  assert.deepEqual(r.node, { id: entryB.id, name: "", server_host: upstreamB.url, added_at: 1, current: true });
  // 快照即刻反映（不经 HTTP /sidecar/nodes/switch——上面没有任何对该路由的请求）
  assert.equal(con.getSnapshot().node.id, entryB.id);
});

// ---- 分层零破坏 ----------------------------------------------------------------------

test("startSidecar: public return shape is frozen (zero-break after layering)", async (t) => {
  const sc = await startSidecar({});
  t.after(() => sc.close());
  assert.deepEqual(Object.keys(sc).sort(), ["close", "mode", "nodePairingCode", "origin", "pairingCode", "port", "url"]);
  assert.equal(typeof sc.close, "function");
  assert.match(sc.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("plain startSidecar has no session face (404 unchanged); shim re-exports are the same functions", async (t) => {
  const sc = await startSidecar({});
  t.after(() => sc.close());
  const r = await request(sc.port, { path: `/sidecar/session?${CAPABILITY_QUERY_PARAM}=whatever` });
  assert.equal(r.status, 404, "session face only exists for console-hosted sidecars");
  assert.equal(sdk.startSidecar, shimSidecar.startSidecar, "src/sidecar.mjs is a backward-compatible re-export of core");
  assert.equal(typeof sdk.NodeStore, "function");
  assert.equal(typeof sdk.validateTarget, "function");
  assert.equal(typeof sdk.createConsole, "function");
});

test("SPA pages carry the no-referrer policy (dist and placeholder degradation)", async (t) => {
  const upstream = await fakeUpstream({ handler: OK_HANDLER });
  t.after(() => upstream.close());
  const con = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "t-ref" });
  t.after(() => con.close());
  const page = await request(portOf(con), { path: "/" });
  assert.equal(page.status, 200);
  assert.match(page.text, /<meta name="referrer" content="no-referrer"\s*\/?>/);

  const dir = await mkdtemp(path.join(tmpdir(), "webui-console-emptydist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const con2 = await createConsole({ opener: () => {}, target: targetFor(upstream), token: "t-ref2", distDir: dir });
  t.after(() => con2.close());
  const placeholder = await request(portOf(con2), { path: "/" });
  assert.equal(placeholder.status, 200);
  assert.match(placeholder.text, /<meta name="referrer" content="no-referrer">/);
});

// ---- 壳层冒烟（plugin envelope + bin 直跑） ------------------------------------------

test("plugin manifest envelope unchanged (thin shell over core)", () => {
  assert.equal(plugin.name, "webui");
  assert.equal(plugin.apiVersion, 1);
  assert.equal(plugin.commands.length, 1);
  assert.equal(plugin.commands[0].name, "webui");
  assert.equal(typeof plugin.run, "function");
});

test("bin smoke: node src/cli.mjs --help exits 0 with usage", async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "..", "src", "cli.mjs"), "--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve({ code: -1, out }));
    child.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage:/);
});

// ---- import 面（workspace 依赖 → 短码/QR 算法） -------------------------------------

test("cardkit: workspace import surface round-trips short codes and QR matrices", () => {
  assert.equal(typeof cardkit.encodeShortCode, "function");
  assert.equal(typeof cardkit.decodeShortCode, "function");
  assert.equal(typeof cardkit.qrMatrix, "function");
  const code = cardkit.encodeShortCode("192.168.1.10", 18787);
  assert.equal(code.startsWith("dwebh1."), true);
  const back = cardkit.decodeShortCode(code);
  assert.equal(back.ip, "192.168.1.10");
  assert.equal(back.port, 18787);
  const { size, modules } = cardkit.qrMatrix("http://192.168.1.10:18787");
  assert.ok(Number.isInteger(size) && size > 0, "QR size present");
  assert.ok(Array.isArray(modules) && modules.length === size && modules.every((row) => row.length === size), "square QR module matrix");
  assert.equal(typeof cardkit.qrAscii("http://192.168.1.10:18787"), "string");
});
