// 插件控制面 HTTP 面（webui-plugin-kernel Phase 0 / specs/webui delta「控制面
// 授权与零凭证」+「面板范围与安装语义（B6）」）。经 createSidecar 真实 HTTP 链路：
// 1. GET /sidecar/plugins：注册表+状态+「即将推出」（vpn/clash/ai/ssh/screen）+
//    外部插件标注（r2-B6 收口文案）；读路由基线守卫（缺失 Origin 放行/伪造 400/
//    坏 Host 400）；
// 2. POST enable|disable 与 PUT config：写路由精确 Origin 四类矩阵
//    （same-origin 200 / 缺失 403 / 伪造 403 / 坏 Host 403）；
// 3. 状态码语义：未知 id 404 / disable(registered) 409 / 未知动作 404 /
//    GET config 未知 404 / PUT 非法配置 400；
// 4. 持久化：state.json 落盘 + sidecar 重启重建；安装账本 plugins.json 零接触；
// 5. 零凭证：全响应与日志零 token；插件面源码零 argv/env 凭证读取（源级断言）；
// 6. member 姿态：插件面可用（设备本地运行时，与远端中枢 admin 面无关）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSidecar } from "../src/core/sidecar.mjs";
import { pluginStatePath } from "../src/core/plugins/state.mjs";
import { request } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, "..");

const jsonHeaders = { "content-type": "application/json" };

async function tempHome() {
  return mkdtemp(path.join(tmpdir(), "wpk-sidecar-"));
}

/** 写入安装账本哨兵并返回（home, ledgerPath, sentinelBytes）。 */
async function homeWithInstallLedger() {
  const home = await tempHome();
  const ledgerPath = path.join(home, "plugins.json");
  const sentinel = `${JSON.stringify({ cf: { package: "@jixo/opendweb-ext-cf", version: "0.3.1" } }, null, 2)}\n`;
  await writeFile(ledgerPath, sentinel, "utf8");
  return { home, ledgerPath, sentinel };
}

/** 同源写头（浏览器 same-origin POST/PUT 形态）。 */
const sameOrigin = (sc) => ({ host: `127.0.0.1:${sc.port}`, origin: sc.origin });

test.afterEach(() => {});

// ---- GET /sidecar/plugins：注册表投影 + 基线读守卫 ----------------------------------

test("GET /sidecar/plugins: registry + coming soon + external note; baseline read guard", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const sc = await createSidecar({ homeDir: home });
  t.after(() => sc.close());

  // 缺失 Origin（curl/同源 GET 形态）——基线读路由放行
  const bare = await request(sc.port, { path: "/sidecar/plugins", headers: { host: `127.0.0.1:${sc.port}` } });
  assert.equal(bare.status, 200);
  const body = JSON.parse(bare.text);
  assert.deepEqual(
    body.plugins.map((p) => p.id),
    ["ports", "files", "sync"],
  );
  assert.ok(body.plugins.every((p) => p.status === "registered" && p.webui_api === 1));
  assert.ok(body.plugins.every((p) => Array.isArray(p.pages) && p.config_schema !== undefined));
  // 「即将推出」占位（[W6]）——恰五项
  assert.deepEqual(
    body.coming_soon.map((c) => c.id),
    ["vpn", "clash", "ai", "ssh", "screen"],
  );
  // 外部 WebUI 插件=后续版本标注（r2-B6）
  assert.equal(body.external_webui_plugins.available, false);
  assert.match(body.external_webui_plugins.note, /opendweb plugin add installs CLI command plugins/);
  // 投影零 component 字段（非序列化装配位不出控制面）
  assert.ok(body.plugins.every((p) => !("component" in p) && p.pages.every((pg) => !("component" in pg))));

  // 基线读守卫四态的另两态：伪造 Origin 400 / 坏 Host 400（沿用 guardLocalOrigin）
  const forged = await request(sc.port, { path: "/sidecar/plugins", headers: { host: `127.0.0.1:${sc.port}`, origin: "http://evil.example" } });
  assert.equal(forged.status, 400);
  const badHost = await request(sc.port, { path: "/sidecar/plugins", headers: { host: "evil.example" } });
  assert.equal(badHost.status, 400);
});

// ---- 写路由 Origin 四类矩阵（enable/disable/PUT config） ----------------------------

test("write-route Origin four classes: enable/disable/PUT config = 200/403/403/403", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const sc = await createSidecar({ homeDir: home });
  t.after(() => sc.close());

  const cases = [
    { label: "enable", method: "POST", path: "/sidecar/plugins/ports/enable" },
    { label: "disable", method: "POST", path: "/sidecar/plugins/ports/disable" },
    { label: "put-config", method: "PUT", path: "/sidecar/plugins/ports/config", body: "{}" },
  ];
  for (const c of cases) {
    const same = await request(sc.port, { method: c.method, path: c.path, headers: { ...jsonHeaders, ...sameOrigin(sc) }, body: c.body });
    assert.equal(same.status, 200, `${c.label} same-origin 必须 200（got ${same.status}: ${same.text}）`);
    const bare = await request(sc.port, { method: c.method, path: c.path, headers: { ...jsonHeaders, host: `127.0.0.1:${sc.port}` }, body: c.body });
    assert.equal(bare.status, 403, `${c.label} 缺失 Origin 403`);
    const forged = await request(sc.port, { method: c.method, path: c.path, headers: { ...jsonHeaders, host: `127.0.0.1:${sc.port}`, origin: "http://evil.example" }, body: c.body });
    assert.equal(forged.status, 403, `${c.label} 伪造 Origin 403`);
    const badHost = await request(sc.port, { method: c.method, path: c.path, headers: { ...jsonHeaders, host: "evil.example", origin: sc.origin }, body: c.body });
    assert.equal(badHost.status, 403, `${c.label} 坏 Host 403`);
    // same-origin 复位到 registered（disable 只在 enabled 后 200——首测例已覆盖 409）
    if (c.label !== "enable" && c.label !== "disable") continue;
  }

  // 状态码语义：未知 id / 未知动作 / 方法不符 / disable(registered)
  assert.equal((await request(sc.port, { method: "POST", path: "/sidecar/plugins/ghost/enable", headers: { ...jsonHeaders, ...sameOrigin(sc) } })).status, 404);
  assert.equal((await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/bogus", headers: { ...jsonHeaders, ...sameOrigin(sc) } })).status, 404);
  assert.equal((await request(sc.port, { method: "GET", path: "/sidecar/plugins/ports/enable", headers: sameOrigin(sc) })).status, 404);
  const early = await request(sc.port, { method: "POST", path: "/sidecar/plugins/files/disable", headers: { ...jsonHeaders, ...sameOrigin(sc) } });
  assert.equal(early.status, 409);
  assert.equal(JSON.parse(early.text).error.code, "invalid-transition");
});

// ---- config GET/PUT ----------------------------------------------------------------

test("config: GET baseline guard; PUT validates against configSchema (unknown key 400)", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const sc = await createSidecar({ homeDir: home });
  t.after(() => sc.close());

  const got = await request(sc.port, { path: "/sidecar/plugins/sync/config", headers: sameOrigin(sc) });
  assert.equal(got.status, 200);
  assert.deepEqual(JSON.parse(got.text), { config: {} });
  assert.equal((await request(sc.port, { path: "/sidecar/plugins/ghost/config", headers: sameOrigin(sc) })).status, 404);

  const ok = await request(sc.port, { method: "PUT", path: "/sidecar/plugins/sync/config", headers: { ...jsonHeaders, ...sameOrigin(sc) }, body: "{}" });
  assert.equal(ok.status, 200);
  const rogue = await request(sc.port, { method: "PUT", path: "/sidecar/plugins/sync/config", headers: { ...jsonHeaders, ...sameOrigin(sc) }, body: JSON.stringify({ maxBody: 12 }) });
  assert.equal(rogue.status, 400, "Phase 0 内置 schema 无属性——未知键拒绝（字段集冻结语义）");
  assert.equal(JSON.parse(rogue.text).error.code, "invalid-config");
  const notJson = await request(sc.port, { method: "PUT", path: "/sidecar/plugins/sync/config", headers: { ...jsonHeaders, ...sameOrigin(sc) }, body: "not json" });
  assert.equal(notJson.status, 400);
});

// ---- 持久化 + 双账本分离（HTTP 链路端到端） ------------------------------------------

test("persistence: enable/disable survive sidecar restart; install ledger untouched", async (t) => {
  const { home, ledgerPath, sentinel } = await homeWithInstallLedger();
  t.after(() => rm(home, { recursive: true, force: true }));

  const sc = await createSidecar({ homeDir: home });
  const e = await request(sc.port, { method: "POST", path: "/sidecar/plugins/files/enable", headers: { ...jsonHeaders, ...sameOrigin(sc) } });
  assert.equal(e.status, 200);
  assert.equal(JSON.parse(e.text).plugin.status, "enabled");
  await sc.close();

  // state.json 落盘（0600）且安装账本零接触
  const raw = await readFile(pluginStatePath(home), "utf8");
  assert.equal(JSON.parse(raw).plugins.files.status, "enabled");

  // 重启：状态重建；再停用 → 落 disabled
  const sc2 = await createSidecar({ homeDir: home });
  t.after(() => sc2.close());
  const list = JSON.parse((await request(sc2.port, { path: "/sidecar/plugins", headers: sameOrigin(sc2) })).text);
  assert.equal(list.plugins.find((p) => p.id === "files").status, "enabled");
  const d = await request(sc2.port, { method: "POST", path: "/sidecar/plugins/files/disable", headers: { ...jsonHeaders, ...sameOrigin(sc2) } });
  assert.equal(d.status, 200);
  assert.equal(JSON.parse(d.text).plugin.status, "disabled");
  assert.equal((await readFile(ledgerPath, "utf8")), sentinel, "安装账本 plugins.json 零接触（spec「安装与运行双账本分离」）");
  const pluginsDir = await readdir(path.join(home, "plugins"));
  assert.ok(pluginsDir.includes("state.json") && !pluginsDir.includes("plugins.json"));
});

// ---- 零凭证（spec「控制面授权与零凭证」） -------------------------------------------

test("zero credentials: responses and logs carry no token; plugin face source never reads argv/env credentials", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const TOKEN = "wpk-secret-admin-token-9f8e7d";
  const logLines = [];
  const sc = await createSidecar({
    homeDir: home,
    target: {
      scheme: "http",
      hostname: "127.0.0.1",
      port: 1,
      hostHeader: "127.0.0.1:1",
      connectHost: "127.0.0.1",
      servername: null,
      insecure: false,
    },
    token: TOKEN,
    log: (line) => logLines.push(line),
  });
  t.after(() => sc.close());

  const responses = [
    await request(sc.port, { path: "/sidecar/plugins", headers: sameOrigin(sc) }),
    await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/enable", headers: { ...jsonHeaders, ...sameOrigin(sc) } }),
    await request(sc.port, { method: "POST", path: "/sidecar/plugins/ports/disable", headers: { ...jsonHeaders, ...sameOrigin(sc) } }),
    await request(sc.port, { path: "/sidecar/plugins/ports/config", headers: sameOrigin(sc) }),
    await request(sc.port, { method: "PUT", path: "/sidecar/plugins/ports/config", headers: { ...jsonHeaders, ...sameOrigin(sc) }, body: "{}" }),
  ];
  for (const r of responses) {
    assert.ok(!r.text.includes(TOKEN), "插件面响应不得含 admin token");
  }
  for (const line of logLines) {
    assert.ok(!line.includes(TOKEN), "插件面日志不得含 admin token");
  }

  // 源级断言：插件面代码路径零 argv/env 凭证读取（W11：新面零 argv 凭证）
  const { readFile: rf } = await import("node:fs/promises");
  for (const f of ["contract.mjs", "registry.mjs", "state.mjs", "host.mjs"]) {
    const src = await rf(path.join(PKG_ROOT, "src", "core", "plugins", f), "utf8");
    assert.ok(!src.includes("process.argv"), `${f} 零 argv 读取`);
    assert.ok(!src.includes("DWEB_ADMIN_TOKEN") && !src.includes("process.env"), `${f} 零 env 凭证读取`);
  }
});

// ---- member 姿态：插件面可用（设备本地运行时） ---------------------------------------

test("member stance: plugins control plane serves local plugin management (not member-closed)", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const sc = await createSidecar({ homeDir: home, member: true });
  t.after(() => sc.close());

  const list = await request(sc.port, { path: "/sidecar/plugins", headers: sameOrigin(sc) });
  assert.equal(list.status, 200, "插件宿主=设备本地运行时，member 姿态照常管理（对照：connect/nodes 才是 member-closed）");
  const e = await request(sc.port, { method: "POST", path: "/sidecar/plugins/sync/enable", headers: { ...jsonHeaders, ...sameOrigin(sc) } });
  assert.equal(e.status, 200);
  // 对照：member 姿态的 admin 面仍封闭（既有负向矩阵不回退）
  const connect = await request(sc.port, { method: "POST", path: "/sidecar/connect", headers: { ...jsonHeaders, ...sameOrigin(sc) } });
  assert.equal(connect.status, 403);
});

// ---- startSidecar（对外冻结形态）同样暴露插件面 -------------------------------------

test("startSidecar (frozen form) exposes the plugins face via homeDir passthrough", async (t) => {
  const home = await tempHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const sc = await startSidecarProxy(home);
  t.after(() => sc.close());
  const r = await request(sc.port, { path: "/sidecar/plugins", headers: { host: `127.0.0.1:${sc.port}` } });
  assert.equal(r.status, 200);
});

async function startSidecarProxy(home) {
  const mod = await import("../src/core/sidecar.mjs");
  return mod.startSidecar({ homeDir: home });
}
