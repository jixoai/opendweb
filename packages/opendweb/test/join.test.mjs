// opendweb join 命令测试（server-access-roles Phase 3，cli/identity）。
// 单元（零网络，注入 fetch/dns/now/home）：参数解析、明文守卫矩阵（sidecar
// 语义对齐）、fabric 选取（复用/生成/--fabric）、错误码映射（非零退出且无
// 半提交）、回执验签 fail-closed、码与私钥零泄露。
// e2e（真实 127.0.0.1 mock 服务 + 子进程 CLI）：完整兑换链（守卫放行→签名
// 兑换→services.json 验签→registration.json 落盘 0600）、fabric 复用、
// 失败码端到端。真实服务器的兑换 e2e 属验收阶段（内核 /register 未实现）。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { CliExit } from "../src/util.mjs";
import { parseJoinArgs, validateServerUrl, selectFabricId, runJoin, loadRegistration, saveRegistration } from "../src/join.mjs";
import { endpointIdHexFromSeed, signDetached, verifyDetached } from "../src/ed25519.mjs";
import { buildRegisterCanonical, buildRegisterReceiptCanonical, toBase64UrlNoPad } from "../src/register.mjs";
import { ensureDeviceSeed, deviceKeyFile, loadDeviceSeed } from "../src/device-key.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");
const FABRIC = "aa".repeat(32);
const CODE = "dwebc1.e2e0-unut-tilo-vest";
const FIXED_TS = 1758612345678;

/** @returns {Promise<string>} */
async function tmpHome() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-join-"));
}

/** @param {string} cmd @param {string[]} args @param {{env?: Record<string,string>}} [opts] */
function runCli(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, cmd, ...args],
      { env: { ...process.env, ...opts.env }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? /** @type {any} */ (error).code ?? 1 : 0, stdout, stderr }),
    );
  });
}

/** 签名回执响应体（mock 服务端 fixture） */
function signedReceipt(serverSeed, { ts = FIXED_TS, generation = 7, fabricId, root, expiresAt = FIXED_TS + 30 * 24 * 3600 * 1000 } = {}) {
  const codeHash = "33".repeat(32);
  const canonical = buildRegisterReceiptCanonical({ codeHashHex: codeHash, fabricIdHex: fabricId, rootHex: root, ts, generation });
  return {
    op: "register",
    ts,
    generation,
    fabric_id: fabricId,
    root,
    code_hash: codeHash,
    expires_at: expiresAt,
    receipt_sig: toBase64UrlNoPad(signDetached(serverSeed, canonical)),
  };
}

/**
 * 构造注入 fetch：POST /register 与 GET /services.json 的可编程替身。
 * @param {{ register: (body: any, url: string) => { status: number, body: unknown }, serverId: string }} impl
 */
function mockFetch(impl) {
  /** @type {{ url: string, body: any }[]} */
  const requests = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/register")) {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: u, body });
      const r = impl.register(body, u);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/services.json")) {
      requests.push({ url: u, body: null });
      return new Response(JSON.stringify({ server_id: impl.serverId, relay: "http://x" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { fetchImpl, requests };
}

/** join 运行并捕获输出行（stdout 收集器） */
function capture() {
  /** @type {string[]} */
  const lines = [];
  return { lines, stdout: (l) => lines.push(l) };
}

/** @param {Promise<number>} p */
async function exitInfo(p) {
  try {
    const code = await p;
    return { code, thrown: null };
  } catch (e) {
    const err = /** @type {CliExit} */ (e);
    return { code: null, thrown: err };
  }
}

// ---- 参数解析 ----------------------------------------------------------------

test("parseJoinArgs: 必填/等号形/未知选项/空值", () => {
  const ok = parseJoinArgs(["--server", "http://127.0.0.1:8787", "--code=abc", "--allow-insecure"]);
  assert.equal(ok.server, "http://127.0.0.1:8787");
  assert.equal(ok.code, "abc");
  assert.equal(ok.allowInsecure, true);
  assert.equal(parseJoinArgs(["--server", "s", "--code", "c"]).allowInsecure, false);
  assert.throws(() => parseJoinArgs(["--code", "c"]), /usage/);
  assert.throws(() => parseJoinArgs(["--server", "s"]), /usage/);
  assert.throws(() => parseJoinArgs(["--server", "s", "--code", "c", "--wat"]), /unknown option/);
  assert.throws(() => parseJoinArgs(["--server", "s", "--code", "c", "--fabric"]), /missing value/);
  assert.throws(() => parseJoinArgs(["--server", "s", "--code", ""]), /must not be empty/);
  assert.throws(() => parseJoinArgs(["--server", "s", "--code", "c", "--allow-insecure=1"]), /takes no value/);
});

// ---- 明文守卫（sidecar 语义对齐） ---------------------------------------------

/** dns 替身：hostname → 记录表 */
function dnsStub(records) {
  return {
    async lookup(hostname) {
      const r = records[hostname];
      if (!r) throw new Error("ENOTFOUND");
      return r.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
  };
}

test("guard: https 恒放行；http loopback 字面 IP 放行（127.0.0.0/8、::1、v4-mapped）", async () => {
  for (const url of ["https://example.com", "https://example.com:8443"]) {
    const r = await validateServerUrl(url, { dns: dnsStub({}) });
    assert.equal(r.ok, true, url);
  }
  for (const url of ["http://127.0.0.1:8787", "http://127.5.4.3:1", "http://[::1]:8787", "http://[::ffff:127.0.0.1]:8787"]) {
    const r = await validateServerUrl(url, { dns: dnsStub({}) });
    assert.equal(r.ok, true, url);
  }
  assert.deepEqual(await validateServerUrl("http://127.0.0.1:8787", { dns: dnsStub({}) }), {
    ok: true,
    value: { origin: "http://127.0.0.1:8787" },
  });
  // 默认端口归一（:80 省略）
  assert.deepEqual(await validateServerUrl("http://127.0.0.1:80", { dns: dnsStub({}) }), {
    ok: true,
    value: { origin: "http://127.0.0.1" },
  });
});

test("guard: http 非 loopback 拒绝并点名 --allow-insecure；显式放行通过", async () => {
  const r = await validateServerUrl("http://192.168.1.5:8787", { dns: dnsStub({}) });
  assert.equal(r.ok, false);
  assert.match(r.error, /plaintext http to a non-loopback host/);
  assert.match(r.error, /--allow-insecure/);
  const allowed = await validateServerUrl("http://192.168.1.5:8787", { allowInsecure: true, dns: dnsStub({}) });
  assert.equal(allowed.ok, true);
});

test("guard: 域名（含 localhost）走 DNS 全记录——全 loopback 放行、混合记录拒绝（rebinding 面）", async () => {
  const lo = await validateServerUrl("http://localhost:8787", { dns: dnsStub({ localhost: ["127.0.0.1"] }) });
  assert.equal(lo.ok, true);
  const mixed = await validateServerUrl("http://localhost:8787", {
    dns: dnsStub({ localhost: ["127.0.0.1", "192.168.1.5"] }),
  });
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /--allow-insecure/);
  const remote = await validateServerUrl("http://example.com", { dns: dnsStub({ "example.com": ["93.184.216.34"] }) });
  assert.equal(remote.ok, false);
  const remoteAllowed = await validateServerUrl("http://example.com", {
    allowInsecure: true,
    dns: dnsStub({ "example.com": ["93.184.216.34"] }),
  });
  assert.equal(remoteAllowed.ok, true);
  const nx = await validateServerUrl("http://nope.invalid", { dns: dnsStub({}) });
  assert.equal(nx.ok, false);
  assert.match(nx.error, /cannot resolve/);
});

test("guard: URL 形态防线（scheme/userinfo/query/path/编码/点段/反斜杠/zone-id）", async () => {
  const dns = dnsStub({});
  const cases = [
    ["ftp://127.0.0.1", /scheme/],
    ["http://user:pass@127.0.0.1", /credentials/],
    ["http://127.0.0.1/?a=b", /query or fragment/],
    ["http://127.0.0.1/#f", /query or fragment/],
    ["http://127.0.0.1/svc", /path/],
    ["http://127.0.0.1/a/../b", /dot segments/],
    // %2f 进 hostname：WHATWG URL 构造直接拒绝（归并为「absolute http(s) URL」）
    ["http://127.0.0.1%2f.junk", /absolute http\(s\) URL/],
    ["http://127\\.0.0.1", /backslashes/],
    // zone-id：Node URL 构造对 [fe80::1%25eth0] 直接拒绝（若无则由 % 防线兜住）
    ["http://[fe80::1%25eth0]", /zone-id|absolute http\(s\) URL/],
  ];
  for (const [url, re] of cases) {
    const r = await validateServerUrl(/** @type {string} */ (url), { dns });
    assert.equal(r.ok, false, url);
    assert.match(/** @type {any} */ (r).error, re, url);
  }
});

// ---- fabric 选取 -------------------------------------------------------------

test("selectFabricId: --fabric 显式（大写归一）；本地复用；无则随机生成", async () => {
  assert.deepEqual(selectFabricId({ fabric: FABRIC.toUpperCase(), registration: null }), {
    fabricId: FABRIC,
    origin: "flag",
  });
  assert.throws(() => selectFabricId({ fabric: "zz", registration: null }), /64 hex/);
  assert.deepEqual(selectFabricId({ fabric: undefined, registration: { fabric_id: FABRIC } }), {
    fabricId: FABRIC,
    origin: "reused",
  });
  const a = selectFabricId({ fabric: undefined, registration: null });
  const b = selectFabricId({ fabric: undefined, registration: null });
  assert.equal(a.origin, "new");
  assert.equal(b.origin, "new");
  assert.match(a.fabricId, /^[0-9a-f]{64}$/);
  assert.notEqual(a.fabricId, b.fabricId, "新 fabric 随机（32B CSPRNG）");
});

// ---- runJoin：成功链（注入 fetch，零网络） -------------------------------------

test("runJoin 成功: 新 fabric + 新设备 key → PoP 签名兑换 + 回执验签 + 落盘 0600", async () => {
  const home = await tmpHome();
  const serverSeed = crypto.randomBytes(32);
  const serverId = endpointIdHexFromSeed(serverSeed);
  const { fetchImpl, requests } = mockFetch({
    serverId,
    register: () => ({ status: 500, body: null }), // 会被下面覆盖逻辑替代——见 capturedBody
  });
  // 动态回执：register 时才知道 fabric/root——用闭包改写
  /** @type {any} */
  let capturedBody = null;
  const dynamicFetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/register")) {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(signedReceipt(serverSeed, { fabricId: capturedBody.fabric_id, root: capturedBody.root })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fetchImpl(url, init);
  };

  const cap = capture();
  const code = await runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
    home,
    now: () => FIXED_TS,
    fetchImpl: dynamicFetch,
    stdout: cap.stdout,
  });
  assert.equal(code, 0);

  // 请求体：PoP 域可验签（root 公钥 = body.root）
  assert.equal(capturedBody.code, CODE);
  assert.match(capturedBody.fabric_id, /^[0-9a-f]{64}$/);
  assert.equal(capturedBody.ts, FIXED_TS);
  const canonical = buildRegisterCanonical({
    code: CODE,
    fabricIdHex: capturedBody.fabric_id,
    rootHex: capturedBody.root,
    ts: capturedBody.ts,
  });
  assert.equal(verifyDetached(capturedBody.root, canonical, Buffer.from(capturedBody.sig, "base64url")), true);

  // 本地数据面：identity.key + registration.json（0600）
  const seed = await loadDeviceSeed(home);
  assert.ok(seed);
  assert.equal(endpointIdHexFromSeed(seed), capturedBody.root);
  const regStat = await fsp.stat(path.join(home, "registration.json"));
  assert.equal(regStat.mode & 0o777, 0o600);
  const reg = await loadRegistration(home);
  assert.equal(reg.server, "http://127.0.0.1:8787");
  assert.equal(reg.fabric_id, capturedBody.fabric_id);
  assert.equal(reg.root, capturedBody.root);
  assert.equal(reg.expires_at, FIXED_TS + 30 * 24 * 3600 * 1000);
  assert.equal(reg.server_id, serverId);
  assert.equal(reg.receipt.generation, 7);

  // 输出：缩写 + 到期日 + 新 fabric 标注；码与私钥零泄露
  const out = cap.lines.join("\n");
  assert.match(out, new RegExp(`${capturedBody.root.slice(0, 3)}\\*\\*\\*${capturedBody.root.slice(-3)}`));
  assert.match(out, /expires\s+\d{4}-\d{2}-\d{2}/);
  assert.match(out, /newly generated/);
  assert.match(out, /receipt\s+verified/);
  assert.ok(!out.includes(CODE), "码不落输出");
  assert.ok(!out.includes(seed.toString("hex")), "私钥不落输出");
});

test("runJoin 成功: 既有 fabric 复用（持新码=续期语义），不生成第二个", async () => {
  const home = await tmpHome();
  await saveRegistration(home, { version: 1, fabric_id: FABRIC });
  const serverSeed = crypto.randomBytes(32);
  /** @type {any} */
  let captured = null;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/register")) {
      captured = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(signedReceipt(serverSeed, { fabricId: captured.fabric_id, root: captured.root })), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ server_id: endpointIdHexFromSeed(serverSeed) }), { status: 200 });
  };
  const cap = capture();
  await runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
    home,
    now: () => FIXED_TS,
    fetchImpl,
    stdout: cap.stdout,
  });
  assert.equal(captured.fabric_id, FABRIC, "复用本地 fabric");
  assert.match(cap.lines.join("\n"), /reused local fabric/);
});

test("runJoin 成功: --fabric 显式指定（覆盖本地记录）", async () => {
  const home = await tmpHome();
  await saveRegistration(home, { version: 1, fabric_id: FABRIC });
  const other = "bb".repeat(32);
  const serverSeed = crypto.randomBytes(32);
  /** @type {any} */
  let captured = null;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/register")) {
      captured = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(signedReceipt(serverSeed, { fabricId: captured.fabric_id, root: captured.root })), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ server_id: endpointIdHexFromSeed(serverSeed) }), { status: 200 });
  };
  await runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE, "--fabric", other.toUpperCase()], {
    home,
    now: () => FIXED_TS,
    fetchImpl,
    stdout: () => {},
  });
  assert.equal(captured.fabric_id, other);
});

// ---- runJoin：失败矩阵（非零退出 + 无半提交 + 码不泄露） -----------------------

const FAIL_CODES = ["bad-signature", "stale-ts", "code-invalid", "code-exhausted", "code-expired", "code-pending", "code-unavailable", "rate-limited", "invalid-request"];

for (const errCode of FAIL_CODES) {
  test(`runJoin 失败映射: ${errCode} → 非零退出、人类可读、无半提交`, async () => {
    const home = await tmpHome();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { code: errCode, message: "server detail" } }), { status: 400 });
    const info = await exitInfo(
      runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], { home, now: () => FIXED_TS, fetchImpl, stdout: () => {} }),
    );
    assert.equal(info.thrown?.exitCode, 1);
    assert.match(info.thrown?.message ?? "", new RegExp(errCode));
    assert.equal(await loadRegistration(home), null, "无半提交：registration.json 不存在");
  });
}

test("runJoin 失败: 非 envelope 错误体按 HTTP 状态归并；网络不可达独立文案", async () => {
  const home = await tmpHome();
  const http500 = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async () => new Response("oops", { status: 500 }),
      stdout: () => {},
    }),
  );
  assert.match(http500.thrown?.message ?? "", /HTTP 500/);

  const unreachable = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      stdout: () => {},
    }),
  );
  assert.match(unreachable.thrown?.message ?? "", /cannot reach/);
  assert.equal(await loadRegistration(home), null);
});

test("runJoin 失败: 畸形成功响应/服务端公钥不可得/回执验签不过 → 拒绝落盘", async () => {
  const home = await tmpHome();
  const serverSeed = crypto.randomBytes(32);
  const goodSeed = crypto.randomBytes(32);
  const goodRoot = endpointIdHexFromSeed(goodSeed);

  // 畸形 200 体
  const malformed = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async (url) => (String(url).endsWith("/register") ? new Response(JSON.stringify({ what: 1 }), { status: 200 }) : new Response("{}", { status: 200 })),
      stdout: () => {},
    }),
  );
  assert.match(malformed.thrown?.message ?? "", /malformed success response/);

  // services.json 不可得
  const noServices = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/register")) {
          const receipt = signedReceipt(serverSeed, { fabricId: FABRIC, root: goodRoot });
          return new Response(JSON.stringify(receipt), { status: 200 });
        }
        return new Response("down", { status: 503 });
      },
      stdout: () => {},
    }),
  );
  assert.match(noServices.thrown?.message ?? "", /cannot obtain.*services\.json/);

  // 回执由另一把 key 签（伪造）→ 验签失败拒绝保存
  const forged = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/register")) {
          const receipt = signedReceipt(crypto.randomBytes(32), { fabricId: FABRIC, root: goodRoot });
          return new Response(JSON.stringify(receipt), { status: 200 });
        }
        return new Response(JSON.stringify({ server_id: endpointIdHexFromSeed(serverSeed) }), { status: 200 });
      },
      stdout: () => {},
    }),
  );
  assert.match(forged.thrown?.message ?? "", /did not verify/);
  assert.equal(await loadRegistration(home), null, "全部失败路径无半提交");
});

test("runJoin 失败: 回执 fabric/root 与本机不符 → 拒绝落盘（防错配）", async () => {
  const home = await tmpHome();
  const serverSeed = crypto.randomBytes(32);
  const wrong = signedReceipt(serverSeed, { fabricId: FABRIC, root: "cc".repeat(32) });
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async (url) =>
        String(url).endsWith("/register")
          ? new Response(JSON.stringify(wrong), { status: 200 })
          : new Response(JSON.stringify({ server_id: endpointIdHexFromSeed(serverSeed) }), { status: 200 }),
      stdout: () => {},
    }),
  );
  assert.match(info.thrown?.message ?? "", /do not match this device/);
  assert.equal(await loadRegistration(home), null);
});

test("runJoin 失败: 守卫拒绝先于一切网络与落盘（无 fetch 调用）", async () => {
  const home = await tmpHome();
  let fetchCalled = false;
  const info = await exitInfo(
    runJoin(["--server", "http://192.0.2.1:8787", "--code", CODE], {
      home,
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("must not be called");
      },
      stdout: () => {},
    }),
  );
  assert.equal(info.thrown?.exitCode, 2);
  assert.match(info.thrown?.message ?? "", /--allow-insecure/);
  assert.equal(fetchCalled, false);
  assert.equal(await loadRegistration(home), null);
  assert.equal(await loadDeviceSeed(home), null, "守卫拒绝时不生成设备 key");
});

// ---- e2e：真实 127.0.0.1 mock 服务 + 子进程 CLI -------------------------------

/** 起一个 mock 兑换服务（loopback http；返回 200 签名回执 / 4xx envelope） */
function startMockRegisterServer() {
  const serverSeed = crypto.randomBytes(32);
  const serverId = endpointIdHexFromSeed(serverSeed);
  const VALID = CODE;
  const EXPIRED = "dwebc1.dddd-dddd-dddd-dddd";
  /** @type {{ path: string, body: any }[]} */
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url === "/services.json") {
        seen.push({ path: req.url, body: null });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ server_id: serverId, gateway: "http://127.0.0.1" }));
        return;
      }
      if (req.method === "POST" && req.url === "/register") {
        const body = JSON.parse(bodyText);
        seen.push({ path: req.url, body });
        if (body.code === EXPIRED) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "code-expired", message: "expired" } }));
          return;
        }
        if (body.code !== VALID) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "code-invalid", message: "unknown" } }));
          return;
        }
        // ts 与 PoP 签名真实校验（±120s 窗口）
        if (Math.abs(Date.now() - body.ts) > 120_000) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "stale-ts", message: "clock" } }));
          return;
        }
        const canonical = buildRegisterCanonical({ code: body.code, fabricIdHex: body.fabric_id, rootHex: body.root, ts: body.ts });
        if (!verifyDetached(body.root, canonical, Buffer.from(body.sig, "base64url"))) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "bad-signature", message: "pop" } }));
          return;
        }
        const receipt = signedReceipt(serverSeed, { fabricId: body.fabric_id, root: body.root, ts: Date.now(), expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(receipt));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen, serverId }));
  });
}

test("e2e join: 持有效码完整兑换（loopback http 免 --allow-insecure）→ 落盘 + id 一致", async (t) => {
  const mock = await startMockRegisterServer();
  t.after(() => new Promise((r) => mock.server.close(() => r(null))));
  const home = await tmpHome();
  const env = { DWEB_HOME: home };

  const r = await runCli("join", ["--server", `http://127.0.0.1:${mock.port}`, "--code", CODE], { env });
  assert.equal(r.code, 0, r.stderr);
  const reg = await loadRegistration(home);
  assert.ok(reg, "registration.json 落盘");
  assert.equal(reg.server, `http://127.0.0.1:${mock.port}`);
  assert.match(String(reg.fabric_id), /^[0-9a-f]{64}$/);
  const seed = await loadDeviceSeed(home);
  assert.equal(reg.root, endpointIdHexFromSeed(seed));
  assert.equal(reg.server_id, mock.serverId);
  const stat = await fsp.stat(path.join(home, "registration.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.match(r.stdout, new RegExp(`${reg.root.slice(0, 3)}\\*\\*\\*${reg.root.slice(-3)}`));
  assert.match(r.stdout, /expires\s+\d{4}-\d{2}-\d{2}/);
  assert.ok(!r.stdout.includes(CODE) && !r.stderr.includes(CODE), "码全文不落 stdout/stderr");

  // 服务端收到了可验签的 PoP（mock 已验签）+ services.json 拉取序
  assert.equal(mock.seen.filter((s) => s.path === "/register").length, 1);
  assert.equal(mock.seen.filter((s) => s.path === "/services.json").length, 1);

  // opendweb id 与 join 的 root 一致（同一设备身份）
  const idr = await runCli("id", [], { env });
  assert.equal(idr.code, 0);
  assert.match(idr.stdout, new RegExp(reg.root));

  // 第二次 join（持新有效码=同码再兑）：fabric 复用、root 不变
  const firstFabric = String(reg.fabric_id);
  const r2 = await runCli("join", ["--server", `http://127.0.0.1:${mock.port}`, "--code", CODE], { env });
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /reused local fabric/);
  const reg2 = await loadRegistration(home);
  assert.equal(reg2.fabric_id, firstFabric, "不静默生成第二个 fabric");
});

test("e2e join: 失效码非零退出、人类可读、无 registration.json", async (t) => {
  const mock = await startMockRegisterServer();
  t.after(() => new Promise((r) => mock.server.close(() => r(null))));
  const home = await tmpHome();
  const env = { DWEB_HOME: home };
  const r = await runCli("join", ["--server", `http://127.0.0.1:${mock.port}`, "--code", "dwebc1.dddd-dddd-dddd-dddd"], { env });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /code-expired/);
  assert.match(r.stderr, /no uses left|expired/, "人类可读错误");
  assert.equal(await loadRegistration(home), null, "无半提交");
  // 设备 key 属设备级引导（首启生成、重试复用）——非注册半提交状态
  const seed = await loadDeviceSeed(home);
  assert.ok(seed, "设备 key 已引导（join 职责）；注册状态未落盘");
});

test("e2e join: 非 loopback 明文 http → 守卫 exit 2，零本地状态", async () => {
  const home = await tmpHome();
  const r = await runCli("join", ["--server", "http://192.0.2.1:8787", "--code", CODE], { env: { DWEB_HOME: home } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /non-loopback/);
  assert.match(r.stderr, /--allow-insecure/);
  assert.equal(await loadRegistration(home), null);
  assert.equal(await loadDeviceSeed(home), null, "守卫拒绝时不生成设备 key");
});
