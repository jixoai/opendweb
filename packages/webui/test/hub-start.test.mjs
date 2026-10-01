// /sidecar/hub/start 一键本地中枢单测（用户故事 B「连接本地服务器——一键启动
// 本地服务并连接」，2026-10-02）。守卫/行为矩阵：
// 1. 守卫：member 403 / homeDir 未注入 404 / 缺 Origin 403 / 伪造 Origin 403 /
//    坏 Host 403 / body 未知字段 400 / 非法 JSON 400；
// 2. 未初始化：{} → 409 not-initialized（零 spawn）；
// 3. 已在跑（setup 态连接段）：hub.json + 0600 hub-token + /healthz 可达 →
//    200 connected=true started=false；sidecar 翻 ready + hub_local=true；
//    /api/* 即刻注入 Bearer=hub-token（目标冻结模型不变，浏览器零 URL 输入）；
// 4. row 2 daemon-down：target+hubLocal 预注入 → spawn 替身「拉起」假中枢后
//    200 started=true connected=true，target 不变（启动即自愈语义）；
// 5. 就绪超时：spawn 后 /healthz 恒不可达 → 504 hub-not-healthy；
// 6. ensureHubRunning 直测：initialize=true 真实 init（临时端口）+ spawn 替身
//    → hub.json/hub-token 落盘（0600）；gateway 端口被占 → init-failed 且
//    零残留（无 hub.json、hub-token 已清理）。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSidecar } from "../src/sidecar.mjs";
import { ensureHubRunning } from "../src/core/home.mjs";
import { fakeUpstream, postJson, request } from "./helpers.mjs";

/** 空闲端口预留（listen(0) 取号后立即释放——测试内由假中枢/spawn 替身占用）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** 假中枢：/healthz 200；/admin/* 200 JSON（记录 Authorization）。 */
async function fakeHub() {
  const hits = [];
  const upstream = await fakeUpstream({
    handler: (req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    },
  });
  return {
    port: upstream.port,
    get hits() {
      return upstream.hits;
    },
    close: () => upstream.close(),
  };
}

/** 手工构造 hub.json + hub-token（0600）——已初始化但未必在跑的机器形态。 */
async function seedHubState(home, gatewayPort, token = "seeded-hub-token") {
  await writeFile(
    path.join(home, "hub.json"),
    JSON.stringify({
      version: 1,
      data_dir: path.join(home, "hub-data"),
      gateway_bind: `127.0.0.1:${gatewayPort}`,
      relay_bind: "127.0.0.1:3341",
      initialized_at: new Date(0).toISOString(),
      autostart: false,
    }),
  );
  await writeFile(path.join(home, "hub-token"), `${token}\n`, { mode: 0o600 });
  await chmod(path.join(home, "hub-token"), 0o600);
  return token;
}

/** hubStart 替身：假 child + 可选「daemon 启动」副作用（拉起假中枢）。 */
function fakeSpawn(onSpawn) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    onSpawn?.();
    return {
      pid: 43210,
      exitCode: null,
      signalCode: null,
      unref() {},
      once() {},
    };
  };
  return { calls, impl };
}

const fakeIdentity = async () => ({ lstart: "l", command: "node opendweb.mjs hub start --foreground" });

/** 直连 sidecar /sidecar/state（不经 UI 层断言世界翻转原料）。 */
async function sidecarState(port) {
  const res = await request(port, { path: "/sidecar/state" });
  return JSON.parse(res.text);
}

test.afterEach(() => {});

// ---- 守卫矩阵 -----------------------------------------------------------------------

test("hub/start: member 姿态 403（admin 面封闭）", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sc = await startSidecar({ homeDir: home, member: true });
  t.after(() => sc.close());
  const res = await postJson(sc.port, "/sidecar/hub/start", {});
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.text).error.code, "member-closed");
});

test("hub/start: homeDir 未注入 404（本地面不存在）", async (t) => {
  const sc = await startSidecar({});
  t.after(() => sc.close());
  const res = await postJson(sc.port, "/sidecar/hub/start", {}, { origin: sc.origin });
  assert.equal(res.status, 404);
});

test("hub/start: 写路由精确 Origin（缺失 403 / 伪造 403 / 坏 Host 403）", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sc = await startSidecar({ homeDir: home });
  t.after(() => sc.close());
  const noOrigin = await request(sc.port, { method: "POST", path: "/sidecar/hub/start", body: "{}" });
  assert.equal(noOrigin.status, 403);
  const cross = await postJson(sc.port, "/sidecar/hub/start", {}, { origin: "http://evil.example" });
  assert.equal(cross.status, 403);
  const badHost = await postJson(sc.port, "/sidecar/hub/start", {}, { origin: sc.origin, host: "evil.example" });
  assert.equal(badHost.status, 403);
});

test("hub/start: body 只接受 {initialize?}（URL/host 字段 400、非法 JSON 400）", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sc = await startSidecar({ homeDir: home });
  t.after(() => sc.close());
  const extra = await postJson(sc.port, "/sidecar/hub/start", { initialize: true, server: "http://x" }, { origin: sc.origin });
  assert.equal(extra.status, 400);
  assert.equal(JSON.parse(extra.text).error.code, "invalid-request");
  const bad = await request(sc.port, {
    method: "POST",
    path: "/sidecar/hub/start",
    headers: { "content-type": "application/json", origin: sc.origin },
    body: "not-json",
  });
  assert.equal(bad.status, 400);
});

// ---- 未初始化 -----------------------------------------------------------------------

test("hub/start: 未初始化且未请求 initialize → 409 not-initialized", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const spawn = fakeSpawn();
  const sc = await startSidecar({
    homeDir: home,
    hubStart: { spawnImpl: spawn.impl, readProcessIdentity: fakeIdentity },
  });
  t.after(() => sc.close());
  const res = await postJson(sc.port, "/sidecar/hub/start", {}, { origin: sc.origin });
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.text).error.code, "not-initialized");
  assert.equal(spawn.calls.length, 0, "未初始化绝不 spawn");
});

// ---- 已在跑：setup 态连接段 ----------------------------------------------------------

test("hub/start: 中枢已在跑 → setup 翻 ready + hub_local + Bearer=hub-token 注入", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const hub = await fakeHub();
  t.after(() => hub.close());
  const token = await seedHubState(home, hub.port);
  const spawn = fakeSpawn();
  const sc = await startSidecar({
    homeDir: home,
    hubStart: { spawnImpl: spawn.impl, readProcessIdentity: fakeIdentity },
  });
  t.after(() => sc.close());
  assert.equal((await sidecarState(sc.port)).phase, "setup");

  const res = await postJson(sc.port, "/sidecar/hub/start", {}, { origin: sc.origin });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.ok, true);
  assert.equal(body.connected, true);
  assert.equal(body.started, false, "已在跑不重复拉起");
  assert.equal(spawn.calls.length, 0);

  const st = await sidecarState(sc.port);
  assert.equal(st.phase, "ready");
  assert.equal(st.hub_local, true);
  assert.ok(typeof st.server_host_masked === "string" && st.server_host_masked !== "", "掩码目标非空（明文不暴露）");

  // /api/* 即刻代理到本机中枢并注入 Bearer（凭证只在 sidecar 进程内存）
  const api = await request(sc.port, { path: "/api/status" });
  assert.equal(api.status, 200);
  const auth = hub.hits.find((h) => h.url === "/admin/status")?.headers.authorization;
  assert.equal(auth, `Bearer ${token}`);
});

// ---- row 2 daemon-down：启动即自愈 ---------------------------------------------------

test("hub/start: row 2 daemon-down 冷启动成功 → 200 started=true connected=true", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const port = await freePort();
  await seedHubState(home, port, "row2-hub-token");
  // spawn 替身在「拉起」时把假中枢 listen 到 gateway 端口（daemon 冷启动语义）
  const hubServer = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const spawn = fakeSpawn(() => {
    void new Promise((resolve) => hubServer.listen(port, "127.0.0.1", resolve));
  });
  const sc = await startSidecar({
    homeDir: home,
    target: {
      scheme: "http",
      hostname: "127.0.0.1",
      port,
      hostHeader: `127.0.0.1:${port}`,
      connectHost: "127.0.0.1",
      servername: null,
      insecure: false,
    },
    token: "row2-sidecar-token",
    hubLocal: true,
    hubStart: { spawnImpl: spawn.impl, readProcessIdentity: fakeIdentity, startupTimeoutMs: 8_000 },
  });
  t.after(() => sc.close());
  t.after(() => new Promise((resolve) => hubServer.close(() => resolve())));

  const before = (await sidecarState(sc.port)).server_host_masked;
  const res = await postJson(sc.port, "/sidecar/hub/start", {}, { origin: sc.origin });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.started, true);
  assert.equal(body.connected, true);
  assert.equal(spawn.calls.length, 1);
  assert.ok(spawn.calls[0].args.join(" ").endsWith("hub start --foreground"), "detached 自举同链");
  const after = (await sidecarState(sc.port)).server_host_masked;
  assert.equal(after, before, "row 2 target 不变（启动即自愈）");
});

// ---- 就绪超时 -----------------------------------------------------------------------

test("hub/start: daemon 拉起但 healthz 恒不可达 → 504 hub-not-healthy", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const port = await freePort();
  await seedHubState(home, port);
  const spawn = fakeSpawn(); // 无副作用：永不就绪
  const sc = await startSidecar({
    homeDir: home,
    hubStart: { spawnImpl: spawn.impl, readProcessIdentity: fakeIdentity, startupTimeoutMs: 400 },
  });
  t.after(() => sc.close());
  const res = await postJson(sc.port, "/sidecar/hub/start", {}, { origin: sc.origin });
  assert.equal(res.status, 504);
  assert.equal(JSON.parse(res.text).error.code, "hub-not-healthy");
});

// ---- ensureHubRunning 直测（initialize 真链） ----------------------------------------

test("ensureHubRunning: initialize=true 真实 init + spawn 替身 → 0600 落盘 + started", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-init-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const gateway = await freePort();
  const relay = await freePort();
  const hubServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  t.after(() => new Promise((resolve) => hubServer.close(() => resolve())));
  const spawn = fakeSpawn(() => {
    void new Promise((resolve) => hubServer.listen(gateway, "127.0.0.1", resolve));
  });
  const r = await ensureHubRunning(home, {
    initialize: true,
    gateway: `127.0.0.1:${gateway}`,
    relay: `127.0.0.1:${relay}`,
    spawnImpl: spawn.impl,
    readProcessIdentity: fakeIdentity,
  });
  assert.equal(r.ok, true);
  assert.equal(r.initialized, false, "调用前无 hub.json");
  assert.equal(r.started, true);
  const stateFile = path.join(home, "hub.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.gateway_bind, `127.0.0.1:${gateway}`);
  const tokenMode = (await stat(path.join(home, "hub-token"))).mode & 0o777;
  assert.equal(tokenMode, 0o600);
  // pid 三元组随 detached 自举落盘
  const pid = JSON.parse(await readFile(path.join(home, "hub.pid"), "utf8"));
  assert.equal(pid.pid, 43210);
});

test("ensureHubRunning: gateway 端口被占 → init-failed 零残留", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-hubstart-busy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const squatter = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("busy");
  });
  await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => squatter.close(() => resolve())));
  const relay = await freePort();
  const spawn = fakeSpawn();
  const r = await ensureHubRunning(home, {
    initialize: true,
    gateway: `127.0.0.1:${squatter.address().port}`,
    relay: `127.0.0.1:${relay}`,
    spawnImpl: spawn.impl,
    readProcessIdentity: fakeIdentity,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "init-failed");
  await assert.rejects(readFile(path.join(home, "hub.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(home, "hub-token"), "utf8"), /ENOENT/);
  assert.equal(spawn.calls.length, 0);
});
