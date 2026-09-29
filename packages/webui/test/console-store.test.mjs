// ConsoleStore 行为直测（home-hub 三角色走查 D2/D3 缺陷回归）。
// console.svelte.ts 是 Svelte 5 runes 模块（$state 编译期语义），node --test 无法
// 直接 import——测试 harness 先经 stripTypeScriptTypes（Node 原生 TS 剥离）再经
// svelte/compiler compileModule 编译为真实运行时模块（与 vite 构建同一编译器），
// 本地相对导入改写为绝对 file URL（与 api.ts 单例共享 setApiFetch 注入面），并
// 追加 ConsoleStore 类导出（生产模块只导出单例）。浏览器全局面（window/location/
// history/document/localStorage）以最小桩注入。
// 覆盖（走查三缺陷的回归防线）：
// 1. D2 轮询风暴：$poll 稳态节奏钉死设计值（admin=在线面 5s×2 + 成员面 3s；
//    member=仅成员面 3s）——mock setInterval 推进 10s，请求数按拍精确断言，
//    且 /sidecar/state 零重拉（风暴签名=state+leases+visits 三连发tight loop）；
// 2. D2 引用稳定：refreshSidecar 投影等值时复用既有对象引用（$state 不翻转）；
// 3. D2 effect 接线：App 壳生命周期/轮询 effect 必须 untrack（源断言，防回归）；
// 4. D3 落点竞态：member 干净首启落「我的租约」且记忆键零写入；用户显式切换
//    才写记忆；重载后记忆生效；中枢宿主首启落中枢；显式深链不被自动裁决覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { compileModule } from "svelte/compiler";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setApiFetch, resetApiFetch } from "../ui/src/lib/api.ts";
import { PERSPECTIVE_STORAGE_KEY } from "../ui/src/lib/route.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const LIB_DIR = path.join(PKG_ROOT, "ui", "src", "lib");
const COMPILED = path.join(HERE, ".console-store.compiled.mjs");
const LOCAL_SPECIFIERS = ["./api", "./route", "./hex", "./terms", "./member", "./format", "./plugin-registry"];

// ---- 编译 harness：console.svelte.ts → 可在 node 运行的 runes 模块 ------------------

function compileConsoleStore() {
  const src = readFileSync(path.join(LIB_DIR, "console.svelte.ts"), "utf8");
  const stripped = stripTypeScriptTypes(src, { mode: "strip" });
  const out = compileModule(stripped, { filename: "console.svelte.js" });
  let code = `${out.js.code}\nexport { ConsoleStore };\n`;
  for (const spec of LOCAL_SPECIFIERS) {
    const abs = pathToFileURL(path.join(LIB_DIR, `${spec.slice(2)}.ts`)).href;
    code = code.split(JSON.stringify(spec)).join(JSON.stringify(abs));
  }
  writeFileSync(COMPILED, code);
}

// ---- 浏览器全局最小桩 ---------------------------------------------------------------

/**
 * 每用例独立浏览器环境：独立 hash/localStorage/事件监听；返回驱动面。
 * 每次调用整体重装全局桩（node --test 每文件独立进程，无跨文件泄漏；
 * store 的 t.after 清理钩子与本地桩的拆除顺序无关）。
 */
function browserEnv(t) {
  const listeners = { hashchange: new Set(), visibilitychange: new Set() };
  const storageMap = new Map();
  const storage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
  };
  const env = {
    hash: "",
    fire: (name) => {
      for (const fn of listeners[name]) fn();
    },
    storage: {
      get: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      clear: () => storageMap.clear(),
    },
  };
  globalThis.window = {
    addEventListener: (n, fn) => listeners[n].add(fn),
    removeEventListener: (n, fn) => listeners[n].delete(fn),
    localStorage: storage,
  };
  globalThis.location = {
    get hash() {
      return env.hash;
    },
    set hash(v) {
      env.hash = String(v);
    },
  };
  globalThis.history = { replaceState: (_s, _t, url) => (env.hash = String(url ?? "")) };
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (n, fn) => listeners[n].add(fn),
    removeEventListener: (n, fn) => listeners[n].delete(fn),
  };
  return env;
}

/** setImmediate 若干轮：冲净 start()/settle 的 promise 链（transport 均同步解析）。 */
async function flushAsync(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/**
 * 计数 transport：按路径返回固定 fixture，同时计数。
 * fixtures 默认 member 干净首启形态（state=member/setup 姿态、hub 404、1 条租约）。
 */
function countingTransport(fixtures = {}) {
  const counts = {};
  const defaults = {
    "/sidecar/state": () => ok({ phase: "setup", role: "member", hub_local: false, server_host_masked: null, insecure: false }),
    "/sidecar/hub": () => new Response("", { status: 404 }),
    "/sidecar/leases": () => ok({ leases: [leaseEntry()] }),
    "/sidecar/visits": () => ok({ visits: [] }),
  };
  const routes = { ...defaults, ...fixtures };
  setApiFetch((p) => {
    const pathOnly = p.split("?")[0];
    counts[pathOnly] = (counts[pathOnly] ?? 0) + 1;
    const handler = routes[pathOnly] ?? (() => ok({}));
    return Promise.resolve(handler());
  });
  return counts;
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const leaseEntry = () => ({
  id: "l1",
  server: "http://192.168.2.13:8787",
  relay_url: "http://192.168.2.13:3340",
  server_id: null,
  fabric_id: "a".repeat(64),
  root: "b".repeat(64),
  alias: "kzf-MacBook",
  label: null,
  registered_at: 1,
  expires_at: Date.now() + 86_400_000,
  expires_in: 86_400_000,
  receipt: null,
});

compileConsoleStore();
process.on("exit", () => rmSync(COMPILED, { force: true }));
test.afterEach(() => resetApiFetch());

// ---- D3：member 干净首启落「我的租约」+ 记忆键零程序性写入 --------------------------

test("D3: member clean first boot lands on #/lease and writes NO perspective memory", async (t) => {
  const env = browserEnv(t);
  env.hash = ""; // 干净首启（清 localStorage 等价：storage 桩本为空）
  const counts = countingTransport();
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());
  store.start();
  await flushAsync();

  assert.equal(env.hash, "#/lease", "member（无 hub+1 租约）auto=lease 必须落我的租约");
  assert.equal(env.storage.get(PERSPECTIVE_STORAGE_KEY), null, "程序性自动落点不得写视角记忆键（D3 竞态根因）");
  assert.equal(store.perspective, "lease");
  // 风暴签名同时缺席：boot 全程各端点恰 1 次
  assert.deepEqual(counts, { "/sidecar/state": 1, "/sidecar/hub": 1, "/sidecar/leases": 1, "/sidecar/visits": 1 });
});

test("D3: explicit user switch (switcher callback) IS remembered; reload keeps it", async (t) => {
  const env = browserEnv(t);
  env.hash = "";
  countingTransport();
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());
  store.start();
  await flushAsync();
  assert.equal(env.hash, "#/lease");

  // 用户显式切换「我的到访」：location.hash 赋值 → hashchange → 记忆生效
  store.switchPerspective("visits");
  env.fire("hashchange");
  await flushAsync();
  assert.equal(env.hash, "#/visits");
  assert.equal(env.storage.get(PERSPECTIVE_STORAGE_KEY), "visits", "显式切换必须写入记忆键");

  // 模拟重载：新 store 实例、空 hash（清地址栏）、记忆仍持 visits
  const reloaded = new ConsoleStore();
  reloaded.start();
  await flushAsync();
  assert.equal(env.hash, "#/visits", "重载后记忆视角优先于 auto");
  reloaded.stop();
});

test("D3: hub host clean first boot lands on hub overview", async (t) => {
  const env = browserEnv(t);
  env.hash = "";
  countingTransport({
    "/sidecar/state": () => ok({ phase: "ready", role: "admin", hub_local: true, server_host_masked: "127.0.0.1:8787", insecure: false }),
    "/sidecar/hub": () => ok({ version: 1, machine: "Mac-mini-书房", urls: [], primary_url: "http://192.168.2.13:8787", short_code: "1234-5678", qr_svg: "<svg/>", gateway_bind: "0.0.0.0:8787", running: true }),
  });
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());
  store.start();
  await flushAsync();

  assert.equal(env.hash, "#/overview", "中枢宿主（hub_local）首启落中枢总览");
  assert.equal(env.storage.get(PERSPECTIVE_STORAGE_KEY), null, "自动落点不写记忆");
});

test("D3: explicit deep link (boot hash) is honored, not overridden by auto adjudication", async (t) => {
  const env = browserEnv(t);
  env.hash = "#/visits"; // 托盘/`hub open` 深链形态
  countingTransport();
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());
  store.start();
  await flushAsync();

  assert.equal(env.hash, "#/visits", "显式深链落点不被 auto 覆盖");
  assert.equal(store.perspective, "visits");
});

// ---- D2：refreshSidecar 引用稳定 ---------------------------------------------------

test("D2: refreshSidecar reuses the sidecar object reference when the projection is unchanged", async (t) => {
  const env = browserEnv(t);
  countingTransport({
    "/sidecar/state": () => ok({ phase: "ready", role: "admin", hub_local: true, server_host_masked: "127.0.0.1:8787", insecure: false }),
  });
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());

  await store.refreshSidecar();
  const first = store.sidecar;
  assert.ok(first !== null);
  await store.refreshSidecar();
  await store.refreshSidecar();
  assert.ok(store.sidecar === first, "投影等值 → 复用同一对象引用（$state 不翻转，依赖它的 effect 不重入）");

  // 真变化（role 翻转）仍必须更新引用
  setApiFetch(() => Promise.resolve(ok({ phase: "ready", role: "member", hub_local: false, server_host_masked: null, insecure: false })));
  await store.refreshSidecar();
  assert.ok(store.sidecar !== first, "投影变化 → 替换引用");
  assert.equal(store.sidecar.role, "member");
});

// ---- D2：轮询节奏回归（mock setInterval；风暴=无界增长） ------------------------------

test("D2: admin polling rhythm holds design cadence over 10s (5s status/conn + 3s leases; no /sidecar/state refetch)", async (t) => {
  const env = browserEnv(t);
  env.hash = ""; // 干净首启：settle 走自动裁决（hub_local → hub 总览）
  const counts = countingTransport({
    "/sidecar/state": () => ok({ phase: "ready", role: "admin", hub_local: true, server_host_masked: "127.0.0.1:8787", insecure: false }),
    "/sidecar/hub": () => ok({ version: 1, machine: "m", urls: [], primary_url: "http://192.168.2.13:8787", short_code: "1", qr_svg: "", gateway_bind: "0.0.0.0:8787", running: true }),
  });
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());
  store.start();
  await flushAsync();
  assert.equal(env.hash, "#/overview");

  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());
  store.$poll();
  await flushAsync();
  // 首拍（$poll 即时段）：status/conn/leases 各 1；state 仍是 boot 的 1 次
  const afterPoll = { ...counts };
  assert.equal(afterPoll["/api/status"], 1);
  assert.equal(afterPoll["/api/connections"], 1);
  assert.equal(afterPoll["/sidecar/leases"], 2, "settle 1 + $poll 首拍 1");

  t.mock.timers.tick(10_000);
  await flushAsync();

  // 设计节奏上界（走查断言口径：单页 2s ≤ 首刷+1 拍；此处推满 10s 取精确值）：
  // status/conn 5s×2 拍 → 3；leases 3s×3 拍 → 5；state/hub 零增长（风暴签名缺席）
  assert.equal(counts["/api/status"], 3, "status = 首拍 + 5s,10s 两拍");
  assert.equal(counts["/api/connections"], 3, "connections = 首拍 + 5s,10s 两拍");
  assert.equal(counts["/sidecar/leases"], 5, "leases = settle + 首拍 + 3s,6s,9s 三拍");
  assert.equal(counts["/sidecar/state"], 1, "/sidecar/state 零重拉（D2 风暴签名是它的 tight loop）");
  assert.equal(counts["/sidecar/hub"], 1, "hub 卡片数据不进轮询环（settle 拉取后仅总览进页刷新）");
  assert.equal(counts["/sidecar/visits"], 1, "总览页轮询不拉到访簿（settle 裁决的 1 次之外零增长）");
});

test("D2: member polling rhythm = leases/visits 3s only (F1 cadence; no admin faces)", async (t) => {
  const env = browserEnv(t);
  env.hash = "";
  const counts = countingTransport(); // member 默认 fixtures
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());
  store.start();
  await flushAsync();
  assert.equal(env.hash, "#/lease");

  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());
  store.$poll();
  await flushAsync();

  t.mock.timers.tick(9_000);
  await flushAsync();

  // member：仅成员面 3s（leases + lease 页的 visits 同拍）；status/conn/state 零增长
  assert.equal(counts["/sidecar/leases"], 5, "leases = settle + 首拍 + 3s,6s,9s 三拍");
  assert.equal(counts["/sidecar/visits"], 5, "visits = settle + 首拍 + 3s,6s,9s（lease 页同拍呈现 last_probe）");
  assert.equal(counts["/api/status"], undefined, "member 姿态零 admin 在线面轮询");
  assert.equal(counts["/api/connections"], undefined);
  assert.equal(counts["/sidecar/state"], 1, "state 零重拉");
});

// ---- D2：App 壳 effect 接线源断言（untrack 防线） -----------------------------------

test("D2: App.svelte lifecycle/poll effects must untrack store calls (storm wiring guard)", () => {
  const src = readFileSync(path.join(PKG_ROOT, "ui", "src", "App.svelte"), "utf8");
  assert.match(src, /untrack\(\(\) => cs\.start\(\)\)/, "start() 一经 effect 追踪即成重入环（走查 D2 根因）");
  assert.match(src, /untrack\(\(\) => cs\.\$poll\(\)\)/, "$poll() 同步段读取必须 untrack");
});

// ---- r18 P1-1 收敛：探测按钮仅成员视角渲染（服务端 403 的 UI 对偶面） ---------------

test("r18-P1-1: probe buttons gated by cs.role member in Lease/Visits views (source guard)", () => {
  for (const comp of ["LeaseView.svelte", "VisitsView.svelte"]) {
    const src = readFileSync(path.join(PKG_ROOT, "ui", "src", "components", comp), "utf8");
    const m = /\{#if cs\.role === "member"\}([\s\S]*?)\{\/if\}/.exec(src);
    assert.ok(m !== null, `${comp} 缺少 cs.role === "member" 门控块`);
    assert.match(m[1], /cs\.probeServerTarget\(/, `${comp} 的探测按钮必须在 member 门控内（非 member 姿态服务端一律 403）`);
    assert.equal(m[1].split("cs.probeServerTarget(").length - 1, 1, `${comp} member 块内只应有一个探测动作`);
  }
});

// ---- 收官接线：三插件管理面 store 动作（/sidecar/plugins/<id>/<mgmt> 转发） ---------

test("wire-store: ports mappings actions refresh state and surface errors", async (t) => {
  const env = browserEnv(t);
  env.hash = "";
  const posts = [];
  const counts = countingTransport({
    "/sidecar/plugins/ports/mappings": () => ok({ mappings: [{ id: "m1", name: "svc", peer: "ab", remotePort: 8080, localPort: 19080, enabled: true, listener: "listening", error: null }] }),
    "/sidecar/plugins/ports/allowlist": () => ok({ version: 1, entries: [] }),
  });
  setApiFetch((p, init) => {
    const pathOnly = p.split("?")[0];
    counts[pathOnly] = (counts[pathOnly] ?? 0) + 1;
    if (pathOnly === "/sidecar/plugins/ports/mappings" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Promise.resolve(ok({ mapping: { id: "m2" } }));
    }
    if (pathOnly === "/sidecar/plugins/ports/mappings/m1/enabled") return Promise.resolve(ok({ mapping: { id: "m1" } }));
    if (pathOnly === "/sidecar/plugins/ports/mappings/m1" && init?.method === "DELETE") return Promise.resolve(ok({ ok: true }));
    const routes = {
      "/sidecar/leases": () => ok({ leases: [leaseEntry()] }),
      "/sidecar/plugins/ports/mappings": () => ok({ mappings: [{ id: "m1", name: "svc", peer: "ab", remotePort: 8080, localPort: 19080, enabled: true, listener: "listening", error: null }] }),
      "/sidecar/plugins/ports/allowlist": () => ok({ version: 1, entries: [] }),
    };
    return Promise.resolve((routes[pathOnly] ?? (() => ok({})))());
  });
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());

  await store.refreshPorts();
  await store.refreshLeases();
  assert.equal(store.portsMappings?.length, 1);
  assert.equal(store.portsMappings?.[0].listener, "listening");
  assert.deepEqual(store.portsPeerOptions, [{ endpointId: "b".repeat(64), label: "kzf-MacBook" }], "peer options derive from leases (root + alias)");

  assert.equal(await store.createPortMapping({ name: "n", peer: "p", remotePort: 1, localPort: 2 }), true);
  assert.deepEqual(posts.at(-1), { name: "n", peer: "p", remotePort: 1, localPort: 2 });
  assert.equal(await store.togglePortMapping("m1", false), true);
  assert.equal(await store.removePortMapping("m1"), true);
  assert.equal(store.portsError, null);

  // 失败路径：错误文案进入 portsError（页面顶层呈现面）
  setApiFetch(() => Promise.resolve(new Response(JSON.stringify({ error: { code: "invalid", message: "bad port" } }), { status: 400 })));
  assert.equal(await store.createPortMapping({ name: "x", peer: "p", remotePort: 1, localPort: 2 }), false);
  assert.equal(store.portsError, "bad port");
});

test("wire-store: sync refresh assembles groups, jobs, conflicts, and the seed block", async (t) => {
  const env = browserEnv(t);
  env.hash = "";
  const group = {
    id: "g1",
    name: "agents",
    members: [{ endpointId: "b".repeat(64), deviceName: "mini" }],
    roots: [
      { id: "r1", localPath: "/tmp/x", mode: "twoway", seedAuthority: "b".repeat(64), isSeedAuthority: true, groupRef: null, deviceRef: null, seedBlock: false, hasConflicts: true },
      { id: "r2", localPath: "/tmp/y", mode: "twoway", seedAuthority: null, isSeedAuthority: false, groupRef: null, deviceRef: null, seedBlock: true, hasConflicts: false },
    ],
    self: { endpointId: "b".repeat(64), deviceName: "mini" },
  };
  const session = { algoVersion: "diff3-1", baseCommit: "o", oursCommit: "a", theirsCommit: "b", oursEndpoint: "b".repeat(64), conflicts: [] };
  const seed = { groupId: "g1", rootId: "r2", seedCommit: "s", threeWay: { base: { label: "base", entries: [] }, seed: { label: "seed", entries: [] }, local: { label: "local", entries: [] } } };
  const counts = countingTransport({
    "/sidecar/plugins/sync/groups": () => ok({ groups: [group] }),
    "/sidecar/plugins/sync/status": () => ok({ jobs: [{ groupId: "g1", rootId: "r1", phase: "conflicted", error: null, progress: { fetched: 0, fetchTotal: 0, bytes: 0 }, updatedAt: 1 }] }),
    "/sidecar/plugins/sync/conflicts": () => ok({ session }),
    "/sidecar/plugins/sync/seed-block": () => ok({ block: seed }),
  });
  setApiFetch((p) => {
    const pathOnly = p.split("?")[0];
    counts[pathOnly] = (counts[pathOnly] ?? 0) + 1;
    const routes = {
      "/sidecar/plugins/sync/groups": () => ok({ groups: [group] }),
      "/sidecar/plugins/sync/status": () => ok({ jobs: [{ groupId: "g1", rootId: "r1", phase: "conflicted", error: null, progress: { fetched: 0, fetchTotal: 0, bytes: 0 }, updatedAt: 1 }] }),
      "/sidecar/plugins/sync/conflicts": () => ok({ session }),
      "/sidecar/plugins/sync/seed-block": () => ok({ block: seed }),
    };
    return Promise.resolve((routes[pathOnly] ?? (() => ok({})))());
  });
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());

  await store.refreshSync();
  assert.equal(store.syncGroups?.length, 1);
  assert.equal(store.syncJobs.length, 1);
  assert.equal(store.syncJobs[0].phase, "conflicted");
  assert.deepEqual(store.syncConflictSessions, [{ groupId: "g1", rootId: "r1", session }], "conflict sessions fetched only for hasConflicts roots");
  assert.deepEqual(store.syncSeedBlock, { groupId: "g1", rootId: "r2", block: seed });
  assert.equal(store.syncError, null);
});

test("wire-store: filesBridgeCall carries the JSON envelope through the api layer", async (t) => {
  const env = browserEnv(t);
  env.hash = "";
  const bodies = [];
  setApiFetch((p, init) => {
    bodies.push({ p, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(ok({ status: 200, headers: { "x-opendweb-oid": "oid" }, bodyBase64: Buffer.from("[]").toString("base64") }));
  });
  const { ConsoleStore } = await import(pathToFileURL(COMPILED).href);
  const store = new ConsoleStore();
  t.after(() => store.stop());

  const res = await store.filesBridgeCall({ peer: "ab", shareId: "s1", method: "GET", path: "/wpk1/files/s1/list?path=" });
  assert.equal(res.headers["x-opendweb-oid"], "oid");
  assert.equal(Buffer.from(res.bodyBase64, "base64").toString("utf8"), "[]");
  assert.equal(bodies[0].p, "/sidecar/plugins/files/bridge");
  assert.deepEqual(bodies[0].body, { peer: "ab", shareId: "s1", method: "GET", path: "/wpk1/files/s1/list?path=" });
});
