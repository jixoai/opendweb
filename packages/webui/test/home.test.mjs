// home-hub Phase 2b/2c 测试面（specs/webui 四个新增 Requirement 的 Scenario 逐条）：
// 1. sidecar 模式分流五行：显式 --server（基线既有面钉住）/ fresh hub 零数据
//    admin 化（hub 本机自动）/ 成员 member 化 / --setup 强制；
// 2. member 安全负向矩阵：/admin/*（含编码变体/未知子路径）404 且上游 mock 零
//    收包、connect/nodes 403、不生成配对码；
// 3. 本机数据面：leases 投影 expires_in / visits / hub 投影（无=404）/
//    probe 五类经路由（member 姿态——r18 P1-1：probe 写面仅成员侧，admin/
//    hub-local 同族 403 forbidden）/ label（id 路由/空串清除/超长拒/未知 id
//    404/并发经锁）；写路由 Origin 四类（same-origin 200 / 缺失 403 / 伪造
//    403 / 坏 Host 403）；
// 4. 接入卡片三形态同源：webui 模型与 CLI runHub(["card"]) 对拍同地址同短码；
//    golden V1；qrSvg 同矩阵；卡片无凭证；
// 5. 路由/视角纯函数：#/lease、#/visits、member 收敛 no-hub、默认视角顺序、
//    记忆最近使用、直连/借道标注、label 边界；
// 6. getSnapshot().hub 槽位接通（admin hub 形态填充；无 hub.json=null；member
//    role 快照）；
// 7. 关键 UI 文案存在性（dist 提交产物 grep——本包无 Svelte 组件测试基建，
//  沿 ui-dist.test.mjs 的产物门禁形态）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import { createSidecar, startSidecar } from "../src/core/sidecar.mjs";
import { main } from "../src/cli.mjs";
import {
  resolveLaunch,
  leasesProjection,
  setLeaseLabel,
  hubProjection,
} from "../src/core/home.mjs";
import { hubCardModel, qrSvg, loadRenderHubCard } from "../src/core/cardkit.mjs";
import { createConsole } from "../src/index.mjs";
import { upsertLease, loadLeases, loadVisits } from "opendweb/src/leases.mjs";
import { runHub } from "opendweb/src/hub.mjs";
import { decodeShortCode } from "opendweb/src/util.mjs";
import { fakeUpstream, request, postJson } from "./helpers.mjs";

// ---- 公共 fixture ------------------------------------------------------------------

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** hub-state.test.mjs 同款网卡 fixture（对拍口径一致：IPv4 优先 + ULA + link-local）。 */
const FIXTURE_INTERFACES = {
  en0: [
    { family: "IPv4", address: "192.168.2.13", internal: false, mac: "", cidr: "", netmask: "" },
    { family: "IPv6", address: "fd00::13", internal: false, mac: "", cidr: "", netmask: "", scopeid: 5 },
    { family: "IPv6", address: "fe80::1", internal: false, mac: "", cidr: "", netmask: "", scopeid: 5 },
  ],
};

async function tmpHome(prefix = "webui-home-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { home: dir, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

/** 假中枢：/healthz 200 + /admin/* 200（token 计数供泄漏断言）。 */
async function fakeHub() {
  const hits = [];
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      hits.push({ url: req.url, auth: req.headers.authorization ?? "" });
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.url.startsWith("/services.json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ server_id: "a".repeat(64), services: [] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  });
  return { ...upstream, hits };
}

/** hub.json + hub-token 落盘（fresh hub——尚无任何租约/到访数据）。 */
async function writeHubState(home, { gatewayBind = "0.0.0.0:8787", token = "T".repeat(43) } = {}) {
  await writeFile(
    path.join(home, "hub.json"),
    JSON.stringify(
      {
        version: 1,
        data_dir: path.join(home, "hub-data"),
        gateway_bind: gatewayBind,
        relay_bind: "0.0.0.0:3340",
        autostart: false,
        initialized_at: "2026-09-25T00:00:00Z",
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(home, "hub-token"), `${token}\n`);
  return token;
}

/** 一条租约（hex64 全量合法形态）。 */
async function writeOneLease(home, { server = "http://192.168.2.13:8787", expiresAt } = {}) {
  const { entry } = await upsertLease(home, {
    server,
    relayUrl: `${server.replace(/:\d+$/, "")}:3340`,
    serverId: null,
    fabricId: "a".repeat(64),
    root: "b".repeat(64),
    alias: "kzf-MacBook",
    expiresAt: expiresAt ?? 0,
    receipt: null,
  });
  return entry;
}

/** CLI main() 的受控 io（信号驱动退出；不自动开浏览器）。 */
async function runMain(args, { home, env = {} }, { injectHomeDir = true } = {}) {
  const lines = [];
  const signal = new EventEmitter();
  const p = main(args, {
    env: { ...process.env, ...env, DWEB_HOME: home },
    log: (l) => lines.push(l),
    signal,
    openImpl: () => {},
    // injectHomeDir=false 复刻 `hub open` 的 spawn 形态：DWEB_HOME 只经 env 注入，
    // CLI 必须自行 homeRoot(env) 解析（走查 D1：显式 --server 路径数据面恒注入）
    ...(injectHomeDir ? { homeDir: home } : {}),
    stdin: {},
  });
  const settle = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.once("SIGINT", () => clearTimeout(t));
    });
  await settle(500);
  const listening = lines.find((l) => l.includes("listening on"));
  const origin = listening === undefined ? null : listening.replace("opendweb-webui listening on ", "");
  return {
    lines,
    origin,
    port: origin === null ? null : Number(origin.split(":")[2]),
    finish: async () => {
      signal.emit("SIGINT");
      return p;
    },
  };
}

/** 数据面 sidecar 快捷构造（homeDir + 注入面）。 */
async function homeSidecar(t, home, opts = {}) {
  const sc = await createSidecar({
    homeDir: home,
    distDir: path.join(PKG_ROOT, "dist"),
    interfaces: FIXTURE_INTERFACES,
    hostname: "Mac-mini-书房",
    ...opts,
  });
  t.after(() => sc.close());
  return sc;
}

const sameOriginHeaders = (sc) => ({ host: `127.0.0.1:${sc.port}`, origin: sc.origin });
const jsonHeaders = { "content-type": "application/json" };

// ---- 1. 模式分流五行 ------------------------------------------------------------

test("dispatch row 4: empty home (no hub, no data) -> setup baseline preserved", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const decision = await resolveLaunch({ home });
  assert.deepEqual(decision.kind, "setup");
  const run = await runMain({}, { home });
  t.after(() => run.finish());
  assert.match(run.lines.join("\n"), /pairing code: /);
});

test("dispatch row 5: --setup forces setup even with member data (explicit re-pair channel)", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  await writeOneLease(home, { expiresAt: Date.now() + 86_400_000 });
  assert.deepEqual((await resolveLaunch({ home })).kind, "member"); // 前置：数据在
  const decision = await resolveLaunch({ home, setup: true });
  assert.deepEqual(decision.kind, "setup");
  const run = await runMain({ setup: true }, { home });
  const r = await run.finish();
  assert.equal(r.exit, 0);
  assert.match(run.lines.join("\n"), /pairing code: /, "--setup must print a pairing code");
});

test("dispatch row 1: explicit --server keeps the baseline (ready admin, node book unchanged)", async (t) => {
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  });
  t.after(() => upstream.close());
  const run = await runMain({ server: upstream.url, token: "row1-token" }, { home: tmpdir() });
  t.after(() => run.finish());
  const state = JSON.parse((await request(run.port, { path: "/sidecar/state" })).text);
  assert.equal(state.phase, "ready");
  assert.equal(state.role, "admin");
  assert.equal(state.hub_local, false); // 显式 --server 不是 hub 本机自动形态
  const biz = await request(run.port, { path: "/api/status" });
  assert.equal(biz.status, 200);
});

test("dispatch row 2 + Scenario「中枢本机无文档可达」: fresh hub, zero data -> admin via in-process hub-token", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const hub = await fakeHub();
  t.after(() => hub.close());
  const token = await writeHubState(home, { gatewayBind: `0.0.0.0:${hub.port}` });
  const run = await runMain({}, { home });
  t.after(() => run.finish());
  const out = run.lines.join("\n");
  assert.match(out, /proxying to http:\/\/127\.0\.0\.1:\d+ \(local hub\)/);
  assert.ok(!out.includes(token), "hub-token never in terminal output");
  // admin 态、不进 setup；hub-token 不出现在浏览器任何可见状态
  const state = JSON.parse((await request(run.port, { path: "/sidecar/state" })).text);
  assert.equal(state.phase, "ready");
  assert.equal(state.role, "admin");
  assert.equal(state.hub_local, true);
  const page = await request(run.port, { path: "/" });
  assert.ok(!page.text.includes(token), "hub-token not in SPA HTML");
  assert.ok(!JSON.stringify(state).includes(token), "hub-token not in state projection");
  const r = await run.finish();
  assert.equal(r.exit, 0);
});

test("dispatch row 2: hub service not running -> admin stance + hub projection reports running=false", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  // gateway_bind 指向一个确定没有服务的端口（127.0.0.1 上无监听）
  const freePort = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  await writeHubState(home, { gatewayBind: `0.0.0.0:${freePort}` });
  const sc = await homeSidecar(t, home, { hubLocal: true });
  const hub = await request(sc.port, { path: "/sidecar/hub", headers: { host: `127.0.0.1:${sc.port}` } });
  assert.equal(hub.status, 200);
  const body = JSON.parse(hub.text);
  assert.equal(body.running, false);
  assert.equal(body.machine, "Mac-mini-书房");
});

test("dispatch row 1 + `hub open` shape: explicit --server with local hub.json serves /sidecar/hub 200 (D1 access-card data plane)", async (t) => {
  // 走查 D1：`hub open`（hub.mjs hubOpen）spawn webui CLI 的精确形态——显式
  // --server 指向本机中枢 bind base、DWEB_HOME 只经 env、token 经 env。本机
  // hub.json 存在 → /sidecar/hub 200（接入卡片模型字段齐备）——与无参 row-2
  // 路径的数据面行为一致；hub_local 标记仍仅 row-2 自动形态触发（显式目标
  // 不标——远端/本机中枢由调用方声明，CLI 不擅自升格）。
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const upstream = await fakeHub(); // /healthz 200 → 接入卡片 running=true
  t.after(() => upstream.close());
  await writeHubState(home, { gatewayBind: `0.0.0.0:${upstream.port}` });
  const run = await runMain(
    { server: `http://127.0.0.1:${upstream.port}`, token: "T".repeat(43) },
    { home },
    { injectHomeDir: false },
  );
  t.after(() => run.finish());
  const state = JSON.parse((await request(run.port, { path: "/sidecar/state" })).text);
  assert.equal(state.phase, "ready");
  assert.equal(state.role, "admin");
  assert.equal(state.hub_local, false, "显式 --server 不是 row-2 hub 本机自动形态");
  const hub = await request(run.port, { path: "/sidecar/hub", headers: { host: `127.0.0.1:${run.port}` } });
  assert.equal(hub.status, 200, "hub open 路径接入卡片数据面可达（走查 D1）");
  const body = JSON.parse(hub.text);
  assert.equal(typeof body.machine, "string", "卡片模型字段：machine（中枢名）");
  assert.match(body.primary_url, /^http:\/\//, "卡片模型字段：primary_url（家里人怎么连）");
  assert.ok(typeof body.short_code === "string" && body.short_code.length > 0, "卡片模型字段：short_code");
  assert.ok(typeof body.qr_svg === "string" && body.qr_svg.includes("<svg"), "卡片模型字段：qr_svg");
  assert.equal(body.running, true, "/healthz 运行探测接通假上游");
  const r = await run.finish();
  assert.equal(r.exit, 0);
});

test("dispatch row 1 baseline: explicit --server on a machine WITHOUT hub.json keeps /sidecar/hub 404", async (t) => {
  // D1 语义的另一侧：homeDir 恒注入只打开数据面通道；hub.json 存在性门控不变
  //（无中枢身份的机器 = 404 本来就对，卡片不渲染）。
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  });
  t.after(() => upstream.close());
  const run = await runMain(
    { server: `http://127.0.0.1:${upstream.port}`, token: "T".repeat(43) },
    { home },
    { injectHomeDir: false },
  );
  t.after(() => run.finish());
  const hub = await request(run.port, { path: "/sidecar/hub", headers: { host: `127.0.0.1:${run.port}` } });
  assert.equal(hub.status, 404);
  const leases = await request(run.port, { path: "/sidecar/leases", headers: { host: `127.0.0.1:${run.port}` } });
  assert.equal(leases.status, 200, "空租约簿照常投影（数据面通道开，账本为空）");
  const r = await run.finish();
  assert.equal(r.exit, 0);
});

test("dispatch row 3 + Scenario「成员设备不进 setup」: leases data, no hub.json -> member console", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  await writeOneLease(home, { expiresAt: Date.now() + 5 * 86_400_000 });
  const decision = await resolveLaunch({ home });
  assert.deepEqual(decision.kind, "member");
  const run = await runMain({}, { home });
  t.after(() => run.finish());
  const out = run.lines.join("\n");
  assert.match(out, /member console: this device has leases or visits/);
  assert.ok(!out.includes("pairing code"), "member MUST NOT generate or print a pairing code");
  const state = JSON.parse((await request(run.port, { path: "/sidecar/state" })).text);
  assert.equal(state.role, "member");
  // member 态不进 setup：数据面与静态 SPA 正常
  const leases = await request(run.port, { path: "/sidecar/leases", headers: { host: `127.0.0.1:${run.port}` } });
  assert.equal(leases.status, 200);
  const r = await run.finish();
  assert.equal(r.exit, 0);
});

test("dispatch row 3 entry by visits data alone (no leases)", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const { probeVisit } = await import("../src/core/home.mjs");
  const reachable = () =>
    new Response(JSON.stringify({ server_id: "a".repeat(64), services: [] }), { status: 200 });
  await probeVisit(home, "http://192.168.2.13:8787", { fetchImpl: reachable });
  assert.deepEqual((await resolveLaunch({ home })).kind, "member");
});

// ---- 2. member 安全负向矩阵 --------------------------------------------------------

test("member negative matrix: /admin/* all 404 with ZERO upstream traffic (encoded variants + unknown subpaths)", async (t) => {
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  });
  t.after(() => upstream.close());
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  await writeOneLease(home, { expiresAt: Date.now() + 86_400_000 });
  // 结构性证明：即便 target 泄漏进 member sidecar，/api/* 门也先行 404（零出站）
  const sc = await homeSidecar(t, home, {
    member: true,
    target: {
      scheme: "http",
      hostname: "127.0.0.1",
      port: upstream.port,
      hostHeader: `127.0.0.1:${upstream.port}`,
      connectHost: "127.0.0.1",
      servername: null,
      insecure: false,
    },
    token: "should-never-reach-upstream",
  });
  const paths = [
    "/api/owners",
    "/api/status",
    "/api/admin/owners", // 未知子路径（/api 前缀直接带 admin 段）
    "/api/%61dmin/owners", // percent-encoded 'a'
    "/api/adm%69n/owners", // percent-encoded 'i'
    "/api/admin%2fowners", // encoded separator
    "/api/%2e%2e/admin/owners", // encoded dot segments
    "/api/admin/../owners",
    "/api/admin",
    "/api/unknown-sub/path/x",
    "/api/connections/disconnect",
  ];
  for (const p of paths) {
    const res = await request(sc.port, { path: p });
    assert.equal(res.status, 404, `${p} must be 404 for member`);
    assert.deepEqual(JSON.parse(res.text).error.code, "not-found");
  }
  assert.equal(upstream.hits.length, 0, "member sidecar must make ZERO upstream requests");
  // Bearer 亦从未出站；member 姿态经 role 表达（target 泄漏也改变不了门）
  assert.deepEqual(sc.controls.snapshot().role, "member");
  assert.equal(sc.pairingCode, null, "member generates no pairing code");
});

test("member negative matrix: connect 403 / nodes 403 / forged-origin writes 403", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  await writeOneLease(home, { expiresAt: Date.now() + 86_400_000 });
  const sc = await homeSidecar(t, home, { member: true });
  const host = { host: `127.0.0.1:${sc.port}` };
  const connect = await postJson(sc.port, "/sidecar/connect", { pairing_code: "X", server: "http://x", token: "y" }, host);
  assert.equal(connect.status, 403);
  assert.deepEqual(JSON.parse(connect.text).error.code, "member-closed");
  const nodes = await request(sc.port, { path: "/sidecar/nodes", headers: host });
  assert.equal(nodes.status, 403);
  const nodesSwitch = await postJson(sc.port, "/sidecar/nodes/switch", { node_id: "x" }, host);
  assert.equal(nodesSwitch.status, 403);
  // 伪造 Origin 的写请求全 403（负向矩阵条目）
  const forged = await postJson(sc.port, "/sidecar/visits/probe", { server: "http://192.168.2.13:8787" }, {
    host: `127.0.0.1:${sc.port}`,
    origin: "http://evil.example",
  });
  assert.equal(forged.status, 403);
});

// ---- 3. 本机数据面 ------------------------------------------------------------------

test("GET /sidecar/leases: projection carries expires_in (local snapshot semantics)", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const in5d = Date.now() + 5 * 86_400_000;
  const entry = await writeOneLease(home, { expiresAt: in5d });
  const sc = await homeSidecar(t, home);
  const res = await request(sc.port, { path: "/sidecar/leases", headers: { host: `127.0.0.1:${sc.port}` } });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.leases.length, 1);
  const got = body.leases[0];
  assert.equal(got.id, entry.id);
  assert.equal(got.server, "http://192.168.2.13:8787");
  assert.ok(got.expires_in > 4.9 * 86_400_000 && got.expires_in <= 5 * 86_400_000, "expires_in ≈ 5d in ms");
  const expired = await writeOneLease(home, { server: "http://192.168.2.14:8787", expiresAt: Date.now() - 1000 });
  assert.ok(expired, "second lease written");
  const again = JSON.parse((await request(sc.port, { path: "/sidecar/leases", headers: { host: `127.0.0.1:${sc.port}` } })).text);
  const expiredRow = again.leases.find((l) => l.server === "http://192.168.2.14:8787");
  assert.ok(expiredRow.expires_in < 0, "expired lease has negative expires_in");
});

test("GET /sidecar/visits + GET /sidecar/hub (no hub.json = 404)", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const sc = await homeSidecar(t, home);
  const host = { host: `127.0.0.1:${sc.port}` };
  const visits = await request(sc.port, { path: "/sidecar/visits", headers: host });
  assert.equal(visits.status, 200);
  assert.deepEqual(JSON.parse(visits.text), { visits: [] });
  const hub = await request(sc.port, { path: "/sidecar/hub", headers: host });
  assert.equal(hub.status, 404);
});

test("GET /sidecar/hub: projection = card model + running probe; no credentials", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const hub = await fakeHub();
  t.after(() => hub.close());
  const token = await writeHubState(home, { gatewayBind: `0.0.0.0:${hub.port}` });
  const sc = await homeSidecar(t, home);
  const res = await request(sc.port, { path: "/sidecar/hub", headers: { host: `127.0.0.1:${sc.port}` } });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.running, true);
  assert.equal(body.machine, "Mac-mini-书房");
  // 动态端口形态：地址=网卡 fixture 首地址 + gateway_bind 端口；短码离线自解回该地址
  assert.equal(body.primary_url, `http://192.168.2.13:${hub.port}`);
  assert.equal(decodeShortCode(body.short_code).url, body.primary_url);
  assert.match(body.qr_svg, /^<svg /);
  assert.ok(!res.text.includes(token), "hub-token never in hub projection");
});

test("write-route Origin four classes (probe and label): 200 / 403 / 403 / 403; probe is member-only (r18 P1-1)", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const entry = await writeOneLease(home, { expiresAt: Date.now() + 86_400_000 });
  const reachable = () => new Response(JSON.stringify({ server_id: "a".repeat(64), services: [] }), { status: 200 });
  const server = "http://192.168.2.13:8787";

  // 非 member 姿态负向（裁决 #14：到访簿仅成员侧写入）：默认（admin）与
  // hub-local 同族——即使 same-origin 合法写形态也一律 403 forbidden
  for (const stance of [{}, { hubLocal: true }]) {
    const nonMember = await homeSidecar(t, home, { homeFetch: reachable, ...stance });
    const denied = await postJson(nonMember.port, "/sidecar/visits/probe", { server }, sameOriginHeaders(nonMember));
    assert.equal(denied.status, 403, `non-member stance ${JSON.stringify(stance)} must refuse probe writes`);
    assert.deepEqual(JSON.parse(denied.text).error.code, "forbidden");
  }

  // label 写面无角色收敛（r19 P1-NEW 契约冻结）：label 是本机租约簿的显示命名
  // （本机用户的数据，非成员事实簿）——admin 姿态 same-origin 可写且持久；
  // 与 probe 的「成员事实簿」分层，各叫各的
  const adminSc = await homeSidecar(t, home, { homeFetch: reachable });
  const adminLabel = await request(adminSc.port, {
    method: "PATCH",
    path: `/sidecar/leases/${entry.id}/label`,
    headers: { ...sameOriginHeaders(adminSc), ...jsonHeaders },
    body: JSON.stringify({ label: "中枢机自看" }),
  });
  assert.equal(adminLabel.status, 200, "label=本机租约簿显示命名，admin 姿态可写（与 probe 成员事实簿分层）");
  const adminRead = await request(adminSc.port, { path: "/sidecar/leases" });
  assert.equal(
    JSON.parse(adminRead.text).leases.find((l) => l.id === entry.id)?.label,
    "中枢机自看",
    "admin 姿态 label 写入须持久到本机账本",
  );

  // member 姿态：probe 四类 Origin 矩阵（same-origin 200 / 缺失 403 / 伪造 403 / 坏 Host 403）
  const sc = await homeSidecar(t, home, { member: true, homeFetch: reachable });
  const ok = await postJson(sc.port, "/sidecar/visits/probe", { server }, sameOriginHeaders(sc));
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text).probe.result, "reachable");
  // 缺失 Origin（裸 HTTP 客户端）
  const bare = await postJson(sc.port, "/sidecar/visits/probe", { server }, jsonHeaders);
  assert.equal(bare.status, 403);
  // 伪造 Origin
  const forged = await postJson(sc.port, "/sidecar/visits/probe", { server }, {
    host: `127.0.0.1:${sc.port}`,
    origin: "http://evil.example",
  });
  assert.equal(forged.status, 403);
  // 坏 Host
  const badHost = await postJson(sc.port, "/sidecar/visits/probe", { server }, {
    host: "evil.example",
    origin: sc.origin,
  });
  assert.equal(badHost.status, 403);
  // label 同款四类（PATCH；label 无 member 收敛——admin 态照常）
  const labelOk = await request(sc.port, {
    method: "PATCH",
    path: `/sidecar/leases/${entry.id}/label`,
    headers: { ...sameOriginHeaders(sc), ...jsonHeaders },
    body: JSON.stringify({ label: "家里的 Mac" }),
  });
  assert.equal(labelOk.status, 200);
  const labelBare = await request(sc.port, {
    method: "PATCH",
    path: `/sidecar/leases/${entry.id}/label`,
    headers: jsonHeaders,
    body: JSON.stringify({ label: "x" }),
  });
  assert.equal(labelBare.status, 403);
  const labelForged = await request(sc.port, {
    method: "PATCH",
    path: `/sidecar/leases/${entry.id}/label`,
    headers: { host: `127.0.0.1:${sc.port}`, origin: "http://evil.example", ...jsonHeaders },
    body: JSON.stringify({ label: "x" }),
  });
  assert.equal(labelForged.status, 403);
  const labelBadHost = await request(sc.port, {
    method: "PATCH",
    path: `/sidecar/leases/${entry.id}/label`,
    headers: { host: "evil.example", origin: sc.origin, ...jsonHeaders },
    body: JSON.stringify({ label: "x" }),
  });
  assert.equal(labelBadHost.status, 403);
  // 读路由不受影响（沿用基线 Host 守卫：缺失 Origin 的 GET 正常、坏 Host 400）
  const readBare = await request(sc.port, { path: "/sidecar/leases" });
  assert.equal(readBare.status, 200);
  const readBadHost = await request(sc.port, { path: "/sidecar/leases", headers: { host: "evil.example" } });
  assert.equal(readBadHost.status, 400);
});

test("Scenario「label 行内编辑」: rename persists / empty clears / unknown 404 / oversize 400 / concurrent join serialized", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const entry = await writeOneLease(home, { expiresAt: Date.now() + 86_400_000 });
  const sc = await homeSidecar(t, home);
  const patch = (id, label, headers = sameOriginHeaders(sc)) =>
    request(sc.port, {
      method: "PATCH",
      path: `/sidecar/leases/${id}/label`,
      headers: { ...headers, ...jsonHeaders },
      body: JSON.stringify({ label }),
    });

  // 改名持久（id 路由命中）
  const rename = await patch(entry.id, "家里的 Mac");
  assert.equal(rename.status, 200);
  assert.equal(JSON.parse(rename.text).lease.label, "家里的 Mac");
  const persisted = await loadLeases(home);
  assert.equal(persisted.leases.find((l) => l.id === entry.id).label, "家里的 Mac");

  // 空串=清除（label 归一 null）
  const clear = await patch(entry.id, "");
  assert.equal(clear.status, 200);
  assert.equal(JSON.parse(clear.text).lease.label, null);
  assert.equal((await loadLeases(home)).leases.find((l) => l.id === entry.id).label, null);

  // 未知 id=404
  const unknown = await patch("nope12345", "x");
  assert.equal(unknown.status, 404);
  assert.deepEqual(JSON.parse(unknown.text).error.code, "not-found");

  // 超长（>64 UTF-8 字节）被拒：65 ASCII / 22 汉字（66 字节）
  const tooLongAscii = await patch(entry.id, "a".repeat(65));
  assert.equal(tooLongAscii.status, 400);
  assert.deepEqual(JSON.parse(tooLongAscii.text).error.code, "too-long");
  const tooLongCjk = await patch(entry.id, "桌".repeat(22));
  assert.equal(tooLongCjk.status, 400);
  const fitsCjk = await patch(entry.id, "桌".repeat(21)); // 63 字节——边界内
  assert.equal(fitsCjk.status, 200);

  // 并发：PATCH label 与另一进程 join（upsertLease 直调）经同一 leases.lock 串行
  await patch(entry.id, "并发前");
  const [patchRes, joinRes] = await Promise.all([
    patch(entry.id, "并发改名"),
    writeOneLease(home, { server: "http://192.168.2.99:8787", expiresAt: Date.now() + 86_400_000 }),
  ]);
  assert.equal(patchRes.status, 200);
  assert.ok(joinRes.id, "join lease written");
  const final = await loadLeases(home);
  assert.equal(final.leases.length, 2, "both updates survive the lock protocol");
  assert.equal(final.leases.find((l) => l.id === entry.id).label, "并发改名");
  assert.ok(final.leases.some((l) => l.server === "http://192.168.2.99:8787"));
});

test("probe five-class mapping through the route (last_probe lands in visits.json)", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  const respond = (fn) => ({ fetchImpl: fn });
  const goodServices = () =>
    new Response(JSON.stringify({ server_id: "a".repeat(64), services: [] }), { status: 200 });

  const cases = [
    {
      name: "2xx + parsable services -> reachable",
      ...respond(() => goodServices()),
      expect: { result: "reachable", detail: null },
    },
    {
      name: "non-2xx -> unreachable/http-status:500",
      ...respond(() => new Response("boom", { status: 500 })),
      expect: { result: "unreachable", detail: "http-status:500" },
    },
    {
      name: "connection refused -> conn-refused",
      ...respond(() => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8787"), { cause: { code: "ECONNREFUSED" } });
      }),
      expect: { result: "unreachable", detail: "conn-refused" },
    },
    {
      name: "dns -> dns",
      ...respond(() => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND no.such.host"), { cause: { code: "ENOTFOUND" } });
      }),
      expect: { result: "unreachable", detail: "dns" },
    },
    {
      name: "timeout -> timeout",
      ...respond(
        (url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
            );
          }),
      ),
      expect: { result: "unreachable", detail: "timeout" },
      timeoutMs: 150,
    },
    {
      name: "2xx + unparsable body -> bad-body",
      ...respond(() => new Response("not-json{{", { status: 200 })),
      expect: { result: "unreachable", detail: "bad-body" },
    },
  ];

  for (const c of cases) {
    // r18 P1-1 后 probe 仅 member 姿态可写——五类映射经路由的断言在 member 形态下打
    const sc = await homeSidecar(t, home, { member: true, homeFetch: c.fetchImpl, homeProbeTimeoutMs: c.timeoutMs });
    const server = `http://192.168.2.13:8787`;
    const res = await postJson(sc.port, "/sidecar/visits/probe", { server }, sameOriginHeaders(sc));
    assert.equal(res.status, 200, c.name);
    const probe = JSON.parse(res.text).probe;
    assert.deepEqual({ result: probe.result, detail: probe.detail }, c.expect, c.name);
    // 落账：visits.json 的 last_probe 同映射
    const book = await loadVisits(home);
    assert.equal(book.visits[0].last_probe.result, c.expect.result, `${c.name}: visits ledger updated`);
    assert.equal(book.visits[0].server, server);
    await sc.close();
  }
});

// ---- 4. 接入卡片三形态同源 ----------------------------------------------------------

test("Scenario「接入卡片三形态同源」: webui model vs CLI `hub card` output (same address + same short code)", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  await writeHubState(home);
  // CLI 侧：真实 runHub(["card"])（hub.mjs printHubCard 出口——非复刻）
  const lines = [];
  await runHub(["card"], {
    home,
    stdout: (l) => lines.push(l),
    hostname: "Mac-mini-书房",
    interfaces: FIXTURE_INTERFACES,
    isTTY: false,
  });
  const cliOut = lines.join("\n");
  // webui 侧：同一推导（hubCardModel——底层件与 CLI 同一 util 导出）
  const model = hubCardModel({ hostname: "Mac-mini-书房", interfaces: FIXTURE_INTERFACES, gatewayBind: "0.0.0.0:8787" });
  assert.match(cliOut, new RegExp(`地址：${model.primaryUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(cliOut, new RegExp(`短码：${model.shortCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} （电话里念给对方，等于上面的地址）`));
  assert.match(cliOut, /中枢：Mac-mini-书房/);
  // golden V1（design §3.1 冻结向量）
  assert.equal(model.primaryUrl, "http://192.168.2.13:8787");
  assert.equal(model.shortCode, "dwebh1.070ag-0gd49-9qnz8");
  // 短码离线自解回地址；IPv6 备选在列、link-local 不入卡
  assert.equal(decodeShortCode(model.shortCode).url, model.primaryUrl);
  assert.ok(model.urls.includes("http://[fd00::13]:8787"));
  assert.ok(!model.urls.some((u) => u.includes("fe80")));
  // 二维码：SVG 与终端 ASCII 同一 qrMatrix 矩阵的渲染层变体
  const svg = qrSvg(model.primaryUrl);
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes("shape-rendering=\"crispEdges\""));
  // 两形态均无凭证（O-8 实现默认）——renderHubCard 经懒加载取 CLI 同一函数
  const token = "d".repeat(43);
  const renderHubCard = await loadRenderHubCard();
  assert.ok(!renderHubCard(model).includes(token));
  assert.ok(!/dwebc1\.|邀请码[:：]/.test(cliOut.replace(/要自己的房间，就找家长拿邀请码注册成租户/, "")), "no invite codes on the card");
});

test("hub projection in sidecar equals the card model (single data source)", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  await writeHubState(home);
  const proj = await hubProjection(home, { hostname: "Mac-mini-书房", interfaces: FIXTURE_INTERFACES, fetchImpl: () => Promise.reject(new Error("down")) });
  const model = hubCardModel({ hostname: "Mac-mini-书房", interfaces: FIXTURE_INTERFACES, gatewayBind: "0.0.0.0:8787" });
  assert.equal(proj.primary_url, model.primaryUrl);
  assert.equal(proj.short_code, model.shortCode);
  assert.equal(proj.running, false, "unreachable hub -> running=false (not an error)");
});

// ---- 5. 路由 / 视角 / 成员面纯函数 ---------------------------------------------------

test("route: #/lease and #/visits resolve; member admin-hashes collapse to no-hub; admin can visit member pages", async () => {
  const { routeFor } = await import("../ui/src/lib/route.ts");
  assert.deepEqual(routeFor("#/lease", "ready"), { view: "lease" });
  assert.deepEqual(routeFor("#/visits", "ready"), { view: "visits" });
  assert.deepEqual(routeFor("#/leases", "ready"), { view: "lease" }); // 复数形态收敛
  assert.deepEqual(routeFor("#/visit", "ready"), { view: "visits" });
  assert.deepEqual(routeFor("#/overview", "ready", "member"), { view: "no-hub" });
  assert.deepEqual(routeFor("#/tenants", "ready", "member"), { view: "no-hub" });
  assert.deepEqual(routeFor("#/online", "ready", "member"), { view: "no-hub" });
  assert.deepEqual(routeFor("#/lease", "ready", "member"), { view: "lease" }); // member 自己的页不受影响
  assert.deepEqual(routeFor("#/visits", "ready", "member"), { view: "visits" });
  assert.deepEqual(routeFor("#/overview", "ready", "admin"), { view: "overview" }); // admin 亦可看租约
  assert.deepEqual(routeFor("#/lease", "setup", "member"), { view: "setup" }, "setup 态（连 member）不落应用路由");
});

test("default perspective order: hub > leases > visits > empty-hub; remembered wins over auto", async () => {
  const { defaultPerspective, rememberedPerspective, rememberPerspective, PERSPECTIVE_HASH } = await import("../ui/src/lib/route.ts");
  const mk = (o) => ({ role: "member", hubLocal: false, hubPresent: false, leases: 0, visits: 0, ...o });
  assert.equal(defaultPerspective(mk({ hubLocal: true })), "hub");
  assert.equal(defaultPerspective(mk({ hubPresent: true, leases: 3 })), "hub");
  assert.equal(defaultPerspective(mk({ leases: 2 })), "lease");
  assert.equal(defaultPerspective(mk({ visits: 1 })), "visits");
  assert.equal(defaultPerspective(mk({})), "hub"); // 全空 → 中枢引导态
  assert.equal(defaultPerspective(mk({ role: "admin", hubLocal: true, leases: 1 })), "hub");
  assert.equal(PERSPECTIVE_HASH.lease, "#/lease");
  assert.equal(PERSPECTIVE_HASH.visits, "#/visits");
  assert.equal(PERSPECTIVE_HASH.hub, "#/overview");
  // 记忆最近使用：合法值透传；非法值拒绝
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  assert.equal(rememberedPerspective(storage), null);
  rememberPerspective(storage, "visits");
  assert.equal(rememberedPerspective(storage), "visits");
  store.set("opendweb-webui-perspective", "bogus");
  assert.equal(rememberedPerspective(storage), null);
  assert.equal(rememberedPerspective(null), null, "无 localStorage 权限静默降级");
});

test("direct/relay link labeling: only known values labeled; missing stays unlabeled", async () => {
  const { linkLabel } = await import("../ui/src/lib/member.ts");
  assert.deepEqual(linkLabel("direct").label, "直连中");
  assert.deepEqual(linkLabel("relay").label, "借道中");
  assert.equal(linkLabel(undefined), null, "current server wire has no link field -> no badge");
  assert.equal(linkLabel("quic"), null, "unknown values stay unlabeled (honest rendering)");
});

test("member label helpers: byte boundary at 64; empty normalizes to clear", async () => {
  const { labelEditError, labelEditSubmit } = await import("../ui/src/lib/member.ts");
  assert.equal(labelEditError("a".repeat(64)), null);
  assert.notEqual(labelEditError("a".repeat(65)), null);
  assert.equal(labelEditError("桌".repeat(21)), null); // 63 字节
  assert.notEqual(labelEditError("桌".repeat(22)), null); // 66 字节
  assert.deepEqual(labelEditSubmit("家里的 Mac", null), { action: "save", value: "家里的 Mac" });
  assert.deepEqual(labelEditSubmit("  家里的 Mac  ", null), { action: "save", value: "家里的 Mac" });
  assert.deepEqual(labelEditSubmit("same", "same"), { action: "cancel" });
  assert.deepEqual(labelEditSubmit("", null), { action: "cancel" }); // 本就无备注：空提交=无变化
  assert.deepEqual(labelEditSubmit("", "旧备注"), { action: "save", value: "" }); // 空串=清除（store 归一 null）
});

// ---- 6. getSnapshot().hub 槽位 ------------------------------------------------------

test("createConsole snapshot: hub slot wired from /sidecar/hub projection; role surfaces", async (t) => {
  const { home, cleanup } = await tmpHome();
  t.after(() => cleanup());
  await writeHubState(home);
  const opened = [];
  const con = await createConsole({
    opener: (url) => opened.push(url),
    homeDir: home,
    hubLocal: true,
    interfaces: FIXTURE_INTERFACES,
    hostname: "Mac-mini-书房",
  });
  t.after(() => con.close());
  const snap = con.getSnapshot();
  assert.equal(snap.role, "admin");
  assert.ok(snap.hub !== null && snap.hub.present === true);
  assert.equal(snap.hub.primary_url, "http://192.168.2.13:8787");
  assert.equal(snap.hub.short_code, "dwebh1.070ag-0gd49-9qnz8");
  assert.equal(snap.hub.running, null, "snapshot slot is fs-only (probe deferred to GET /sidecar/hub)");

  const { home: home2, cleanup: cleanup2 } = await tmpHome();
  t.after(() => cleanup2());
  const member = await createConsole({ opener: () => {}, homeDir: home2, member: true });
  t.after(() => member.close());
  const msnap = member.getSnapshot();
  assert.equal(msnap.role, "member");
  assert.equal(msnap.hub, null, "no hub.json -> null slot");
  // 深链 URL 构成：至多一次性 capability，绝无 token
  const url = member.urlFor("#/lease");
  assert.match(url, /#\/lease$/);
  assert.ok(url.includes("dweb_console="));
  assert.ok(!url.includes("hub-token"));
});

// ---- 7. 关键 UI 文案存在性（dist 提交产物门禁形态） ---------------------------------

test("member-face copy lands in the committed SPA bundle (verbatim strings survive minification)", async () => {
  const assets = await readdir(path.join(PKG_ROOT, "dist", "assets"));
  const js = assets.filter((f) => f.endsWith(".js"));
  assert.ok(js.length > 0, "dist bundle present");
  const bundle = (
    await Promise.all(js.map((f) => readFile(path.join(PKG_ROOT, "dist", "assets", f), "utf8")))
  ).join("\n");
  const mustExist = [
    "我的租约",
    "我的到访",
    "我的中枢",
    "到访记录只保存在这台设备上，尽力而为——不保证完整。",
    "填地址或贴短码都行",
    "家里人怎么连",
    "邀请码不放在卡片上",
    "连不上。通常是那台服务器没开机，不代表你被拒——被拒会有明确提示。",
    "本地快照",
    "仅租户端点",
    "直连中",
    "借道中",
    "中枢没有在运行",
    "还没有到访记录。",
    "这台设备还没有加入任何网络。",
  ];
  for (const s of mustExist) {
    assert.ok(bundle.includes(s), `bundle copy missing: ${s}`);
  }
});
