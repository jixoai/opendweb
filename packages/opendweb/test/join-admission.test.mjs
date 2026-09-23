// home-hub Phase 1d 测试：join 改造——services preflight 五形态、fabric
// admission 锁并发、pending journal 恢复状态机（三类故障注入）、单 fabric
// 约束、短码直收 e2e、换 server 多租约同 fabric（C 段）。
// 子进程注入：真实 CLI 子进程 + 本地 mock hub（register 计数/断连/挂起可
// 编程）；恢复状态机矩阵另有进程内单测（注入 fetch/now/home，零网络）。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { runJoin } from "../src/join.mjs";
import { CliExit } from "../src/util.mjs";
import { loadLeases, loadAdmissionJournal, saveAdmissionJournal } from "../src/leases.mjs";
import { endpointIdHexFromSeed, signDetached, verifyDetached } from "../src/ed25519.mjs";
import { buildRegisterCanonical, buildRegisterReceiptCanonical, toBase64UrlNoPad, inviteCodeHashHex } from "../src/register.mjs";
import { ensureDeviceSeed, loadDeviceSeed } from "../src/device-key.mjs";
import { encodeShortCode } from "../src/util.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");
const CODE = "dwebc1.e2e0-qrs7-tvxy-zhjk";
const OTHER_CODE = "dwebc1.0123-4567-89cd-fghj";
const FABRIC_X = "aa".repeat(32);
const FABRIC_Y = "bb".repeat(32);
const FIXED_TS = 1758612345678;

/** @returns {Promise<string>} */
async function tmpHome() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-adm-"));
}

/** @param {string[]} cmd @param {{env?: Record<string,string>}} [opts] */
function runCli(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, cmd, ...args],
      { env: { ...process.env, ...opts.env }, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) =>
        resolve({ code: error ? /** @type {any} */ (error).code ?? 1 : 0, stdout, stderr }),
    );
  });
}

/** 签名回执（mock 服务端 fixture；code_hash 与 CLI 规范化对拍） */
function signedReceipt(serverSeed, { ts, generation = 7, fabricId, root, expiresAt = ts + 30 * 24 * 3600 * 1000, code = CODE } = {}) {
  const codeHash = /** @type {string} */ (inviteCodeHashHex(code));
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

/** 输出捕获器（进程内单测用） */
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
    return { code: null, thrown: /** @type {CliExit} */ (e) };
  }
}

/**
 * 进程内注入 fetch 构造器：services manifest 可编程 + register 可编程。
 * @param {{ serverSeed: Buffer, relayEntries?: unknown[], register: (body: any) => { status: number, body?: unknown, destroy?: boolean } | { status: number, body?: unknown, destroy?: boolean } }} impl
 */
function mockTransport({ serverSeed, relayEntries, register }) {
  const relays = relayEntries ?? [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }];
  /** @type {any[]} */
  const registerBodies = [];
  let servicesCalls = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/services.json")) {
      servicesCalls += 1;
      return new Response(
        JSON.stringify({ server_id: endpointIdHexFromSeed(serverSeed), services: relays }),
        { status: 200 },
      );
    }
    if (u.endsWith("/register")) {
      const body = JSON.parse(String(init?.body));
      registerBodies.push(body);
      const r = register(body);
      if (r.destroy) throw new Error("socket destroyed by mock");
      return new Response(JSON.stringify(r.body ?? null), { status: r.status, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { fetchImpl, registerBodies, get servicesCalls() { return servicesCalls; } };
}

// ---- services preflight 五形态（顺序冻结：未发出 register） ----------------------

test("preflight: relay disabled/url null/空串/错 scheme → fail-closed「未启用中转」，未发出 register", async () => {
  const cases = [
    [{ name: "relay", enabled: false, url: "http://127.0.0.1:3340" }, /no usable relay/],
    [{ name: "relay", enabled: true, url: null }, /no usable relay/],
    [{ name: "relay", enabled: true, url: "" }, /no usable relay/],
    [{ name: "relay", enabled: true, url: "ftp://127.0.0.1:3340" }, /no usable relay/],
  ];
  for (const [relay, re] of cases) {
    const home = await tmpHome();
    const t = mockTransport({
      serverSeed: crypto.randomBytes(32),
      relayEntries: [/** @type {any} */ (relay)],
      register: () => ({ status: 200, body: {} }),
    });
    const info = await exitInfo(
      runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
        home, now: () => FIXED_TS, fetchImpl: t.fetchImpl, stdout: () => {},
      }),
    );
    assert.equal(info.thrown?.exitCode, 1, JSON.stringify(relay));
    assert.match(info.thrown?.message ?? "", re, JSON.stringify(relay));
    assert.equal(t.registerBodies.length, 0, "未发出 register");
    assert.equal((await loadLeases(home)).leases.length, 0, "无租约");
    assert.equal((await loadAdmissionJournal(home)).journal, null, "未写 journal");
  }
});

test("preflight: 重复条目=取 manifest 顺序第一条合法者继续（错 scheme 条目被跳过）", async () => {
  const home = await tmpHome();
  const serverSeed = crypto.randomBytes(32);
  const t = mockTransport({
    serverSeed,
    relayEntries: [
      { name: "relay", enabled: true, url: "ftp://bad-scheme" },
      { name: "relay", enabled: false, url: "http://127.0.0.1:1" },
      { name: "relay", enabled: true, url: "http://127.0.0.1:3340" },
      { name: "relay", enabled: true, url: "http://127.0.0.1:3341" },
    ],
    register: (body) => ({ status: 200, body: signedReceipt(serverSeed, { ts: FIXED_TS, fabricId: body.fabric_id, root: body.root }) }),
  });
  const cap = capture();
  const code = await runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
    home, now: () => FIXED_TS, fetchImpl: t.fetchImpl, stdout: cap.stdout,
  });
  assert.equal(code, 0);
  assert.equal(t.registerBodies.length, 1);
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases[0].relay_url, "http://127.0.0.1:3340", "第一条合法者");
  assert.match(cap.lines.join("\n"), /relay\s+http:\/\/127\.0\.0\.1:3340/);
});

// ---- 恢复状态机矩阵（进程内；journal 预置 + 注入 fetch） --------------------------

/**
 * 预置 pending journal + 匹配的设备身份。
 * @param {string} server
 * @param {string} code
 * @param {{ fabricId?: string }} [opts]
 */
async function seedJournal(server, code, opts = {}) {
  const home = await tmpHome();
  const { seed } = await ensureDeviceSeed(home);
  const rootHex = endpointIdHexFromSeed(seed);
  const fabricId = opts.fabricId ?? FABRIC_X;
  const journal = {
    server,
    code_hash: /** @type {string} */ (inviteCodeHashHex(code)),
    fabric_id: fabricId,
    root: rootHex,
    attempt: 1,
    last_error: "register network error: socket destroyed by mock",
    ts: 1758000000000,
  };
  await saveAdmissionJournal(home, journal);
  return { home, seed, rootHex, fabricId, journal };
}

test("恢复: 无重输码（join 缺 --code）→ usage 错误，零网络零新决策", async () => {
  const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
  let fetches = 0;
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787"], {
      home, fetchImpl: async () => { fetches += 1; throw new Error("must not"); }, stdout: () => {},
    }),
  );
  assert.equal(info.thrown?.exitCode, 2, /usage/);
  assert.equal(fetches, 0);
  const j = await loadAdmissionJournal(home);
  assert.ok(j.journal, "journal 保留");
});

test("恢复: 异码 → fail-closed 零副作用（零网络、journal 字节不动、不生成第二 fabric）", async () => {
  const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
  const before = await fsp.readFile(path.join(home, "fabric-admission.json"), "utf8");
  let fetches = 0;
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", OTHER_CODE], {
      home, fetchImpl: async () => { fetches += 1; throw new Error("must not"); }, stdout: () => {},
    }),
  );
  assert.equal(info.thrown?.exitCode, 1);
  assert.match(info.thrown?.message ?? "", /does not match its hash/);
  assert.equal(fetches, 0, "异码绝不发 register");
  const after = await fsp.readFile(path.join(home, "fabric-admission.json"), "utf8");
  assert.equal(after, before, "journal 未被触碰");
  assert.equal((await loadLeases(home)).leases.length, 0);
});

test("恢复: 同码同 tuple 幂等回放 → 补账清 journal；POST 体=fabric/root/server 全用 journal 值", async () => {
  const { home, rootHex, fabricId } = await seedJournal("http://127.0.0.1:8787", CODE);
  const serverSeed = crypto.randomBytes(32);
  const t = mockTransport({
    serverSeed,
    register: (body) => ({ status: 200, body: signedReceipt(serverSeed, { ts: FIXED_TS, fabricId: body.fabric_id, root: body.root }) }),
  });
  const cap = capture();
  const code = await runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
    home, now: () => FIXED_TS, fetchImpl: t.fetchImpl, stdout: cap.stdout,
  });
  assert.equal(code, 0);
  assert.equal(t.registerBodies.length, 1, "回放恰一次 register");
  const body = t.registerBodies[0];
  assert.equal(body.fabric_id, fabricId, "fabric_id 用 journal 值（不新决策）");
  assert.equal(body.root, rootHex);
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 1, "补账");
  assert.equal(ledger.leases[0].fabric_id, fabricId);
  assert.equal(ledger.leases[0].root, rootHex);
  assert.equal((await loadAdmissionJournal(home)).journal, null, "清 journal");
  assert.match(cap.lines.join("\n"), /recovered\s+pending admission replayed \(attempt 2\)/);
});

test("恢复: 同码得 code-pending → journal 保留（attempt 递增）、无租约", async () => {
  const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
  const t = mockTransport({
    serverSeed: crypto.randomBytes(32),
    register: () => ({ status: 400, body: { error: { code: "code-pending", message: "mid-redemption" } } }),
  });
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home, now: () => FIXED_TS, fetchImpl: t.fetchImpl, stdout: () => {},
    }),
  );
  assert.equal(info.thrown?.exitCode, 1);
  assert.match(info.thrown?.message ?? "", /code-pending/);
  const j = await loadAdmissionJournal(home);
  assert.ok(j.journal, "journal 保留");
  assert.equal(j.journal?.attempt, 2, "回放 attempt 递增");
  assert.equal((await loadLeases(home)).leases.length, 0);
});

test("恢复: 同码得 code-invalid → 不得判「未登记」→ 人工恢复文案 + journal 保留", async () => {
  const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
  const t = mockTransport({
    serverSeed: crypto.randomBytes(32),
    register: () => ({ status: 400, body: { error: { code: "code-invalid", message: "unknown" } } }),
  });
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home, now: () => FIXED_TS, fetchImpl: t.fetchImpl, stdout: () => {},
    }),
  );
  assert.match(info.thrown?.message ?? "", /manual recovery/i);
  assert.match(info.thrown?.message ?? "", /does NOT prove/);
  assert.ok((await loadAdmissionJournal(home)).journal, "journal 保留");
});

test("恢复: 网络未知（回放断连）→ journal 保留 + 幂等回放提示", async () => {
  const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
  const t = mockTransport({
    serverSeed: crypto.randomBytes(32),
    register: () => ({ status: 0, destroy: true }),
  });
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home, now: () => FIXED_TS, fetchImpl: t.fetchImpl, stdout: () => {},
    }),
  );
  assert.match(info.thrown?.message ?? "", /cannot reach/);
  assert.match(info.thrown?.message ?? "", /idempotent replay/);
  const j = await loadAdmissionJournal(home);
  assert.ok(j.journal, "journal 保留");
  assert.match(j.journal?.last_error ?? "", /network/);
});

test("恢复: --fabric 异值于 journal / --server 异 origin / 设备身份不符 → 拒绝（零 register）", async () => {
  // --fabric 异值
  {
    const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
    let fetches = 0;
    const info = await exitInfo(
      runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE, "--fabric", FABRIC_Y], {
        home, fetchImpl: async () => { fetches += 1; throw new Error("must not"); }, stdout: () => {},
      }),
    );
    assert.match(info.thrown?.message ?? "", /no new fabric decision/);
    assert.equal(fetches, 0);
  }
  // --server 异 origin
  {
    const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
    let fetches = 0;
    const info = await exitInfo(
      runJoin(["--server", "http://127.0.0.1:9999", "--code", CODE], {
        home, fetchImpl: async () => { fetches += 1; throw new Error("must not"); }, stdout: () => {},
      }),
    );
    assert.match(info.thrown?.message ?? "", /pending admission for/);
    assert.equal(fetches, 0);
  }
  // 设备 key 缺失（root 无法同源）
  {
    const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
    await fsp.rm(path.join(home, "identity.key"));
    let fetches = 0;
    const info = await exitInfo(
      runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
        home, fetchImpl: async () => { fetches += 1; throw new Error("must not"); }, stdout: () => {},
      }),
    );
    assert.match(info.thrown?.message ?? "", /manual recovery/i);
    assert.equal(fetches, 0, "身份不符不发回放");
  }
});

test("恢复: journal 损坏 → fail-closed 人工恢复（不猜）", async () => {
  const { home } = await seedJournal("http://127.0.0.1:8787", CODE);
  await fsp.writeFile(path.join(home, "fabric-admission.json"), "{{{damaged");
  let fetches = 0;
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home, fetchImpl: async () => { fetches += 1; throw new Error("must not"); }, stdout: () => {},
    }),
  );
  assert.equal(info.thrown?.exitCode, 1);
  assert.match(info.thrown?.message ?? "", /damaged/);
  assert.match(info.thrown?.message ?? "", /manual recovery/i);
  assert.equal(fetches, 0);
});

test("复核: register 成功后 server_id 漂移 → fail-closed + journal 保留 + 已登记提示", async () => {
  const home = await tmpHome();
  const serverSeed = crypto.randomBytes(32);
  let servicesCalls = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/services.json")) {
      servicesCalls += 1;
      const sid = servicesCalls <= 1 ? endpointIdHexFromSeed(serverSeed) : "ff".repeat(32);
      return new Response(JSON.stringify({ server_id: sid, services: [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(signedReceipt(serverSeed, { ts: FIXED_TS, fabricId: body.fabric_id, root: body.root })), { status: 200 });
  };
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home, now: () => FIXED_TS, fetchImpl, stdout: () => {},
    }),
  );
  assert.equal(info.thrown?.exitCode, 1);
  assert.match(info.thrown?.message ?? "", /server_id\/relay changed mid-join|services re-check failed/);
  assert.match(info.thrown?.message ?? "", /idempotent replay/, "已 register 提示回放恢复");
  assert.equal((await loadLeases(home)).leases.length, 0);
  assert.ok((await loadAdmissionJournal(home)).journal, "journal 保留");
});

// ---- mock hub（子进程 e2e 用） ---------------------------------------------------

/**
 * 可编程 mock hub：/services.json（relay manifest 可配置）+ /register
 * （计数、断连、挂起复核可编程）。register 校验 PoP 并签真实回执。
 * @param {{ relayEntries?: unknown[], destroyRegister?: boolean, hangLaterServices?: boolean }} [opts]
 */
function startMockHub(opts = {}) {
  const serverSeed = crypto.randomBytes(32);
  const serverId = endpointIdHexFromSeed(serverSeed);
  const relayEntries = opts.relayEntries ?? [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }];
  /** @type {any[]} */
  const registers = [];
  let servicesCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url === "/services.json") {
        servicesCalls += 1;
        if (opts.hangLaterServices && servicesCalls > 1) return; // 挂起：永不响应
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ server_id: serverId, services: relayEntries }));
        return;
      }
      if (req.method === "POST" && req.url === "/register") {
        const body = JSON.parse(bodyText);
        registers.push(body);
        if (opts.destroyRegister) {
          res.socket?.destroy(); // 响应丢失：连接直接销毁
          return;
        }
        const canonical = buildRegisterCanonical({ code: body.code, fabricIdHex: body.fabric_id, rootHex: body.root, ts: body.ts });
        if (!verifyDetached(body.root, canonical, Buffer.from(body.sig, "base64url"))) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "bad-signature", message: "pop" } }));
          return;
        }
        const ts = Date.now();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(signedReceipt(serverSeed, { ts, fabricId: body.fabric_id, root: body.root, expiresAt: ts + 30 * 24 * 3600 * 1000 })));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: /** @type {import("node:net").AddressInfo} */ (server.address()).port,
        registers,
        get servicesCalls() { return servicesCalls; },
        serverId,
        opts,
      }),
    );
  });
}

/** 关停 mock hub（closeAllConnections 防 keep-alive 悬死） */
function closeHub(mock) {
  return new Promise((resolve) => {
    mock.server.closeAllConnections?.();
    mock.server.close(() => resolve(null));
  });
}

/** 远端 (fabric_id, root) 去重计数 */
function distinctTuples(registers) {
  return new Set(registers.map((b) => `${b.fabric_id}\n${b.root}`)).size;
}

// ---- 短码直收 e2e（V1 向量端到端） ------------------------------------------------

test("e2e 短码: --server dwebh1.<V1> → 请求打到 decode 出的地址；坏短码 exit 2 零网络", async (t) => {
  const mock = await startMockHub();
  t.after(() => closeHub(mock));
  const shortCode = encodeShortCode("127.0.0.1", mock.port);
  assert.match(shortCode, /^dwebh1\./);
  const home = await tmpHome();
  const r = await runCli("join", ["--server", shortCode, "--code", CODE], { env: { DWEB_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.registers.length, 1);
  assert.equal(mock.registers[0].fabric_id.length, 64);
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases[0].server, `http://127.0.0.1:${mock.port}`, "server=decode 出的 origin");

  // 坏短码：离线 decode 失败=明确报错不发网络请求（mock 计数不变）
  const before = mock.registers.length + mock.servicesCalls;
  const bad = await runCli("join", ["--server", "dwebh1.zzzz", "--code", CODE], { env: { DWEB_HOME: home } });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not a valid access short code/);
  assert.equal(mock.registers.length + mock.servicesCalls, before, "零网络");
});

// ---- 换服务器两条租约（同 fabric） -----------------------------------------------

test("e2e 多租约: 先后 join A/B → 两条租约同 fabric_id/root；id 计数=2", async (t) => {
  const hubA = await startMockHub();
  const hubB = await startMockHub();
  t.after(() => closeHub(hubA));
  t.after(() => closeHub(hubB));
  const home = await tmpHome();
  const env = { DWEB_HOME: home };
  const r1 = await runCli("join", ["--server", `http://127.0.0.1:${hubA.port}`, "--code", CODE], { env });
  assert.equal(r1.code, 0, r1.stderr);
  const first = (await loadLeases(home)).leases[0];
  const r2 = await runCli("join", ["--server", `http://127.0.0.1:${hubB.port}`, "--code", CODE], { env });
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /reused local fabric/, "跨 server 复用同一 fabric");
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 2, "两条租约（server 键不同）");
  const fabrics = new Set(ledger.leases.map((e) => e.fabric_id));
  const roots = new Set(ledger.leases.map((e) => e.root));
  assert.equal(fabrics.size, 1, "fabric 维度恒 1");
  assert.equal(roots.size, 1, "同一设备身份");
  assert.equal(ledger.leases[0].fabric_id, first.fabric_id);
  const idr = await runCli("id", [], { env });
  assert.ok(idr.stdout.includes("leases       2"), `id 租约计数 2（实际：${idr.stdout}）`);
});

// ---- 并发异 fabric join（admission 锁；真子进程竞速空 DWEB_HOME） ------------------

test("e2e admission: 并发异 fabric join → 最多一个远端 register；失败者 fail-closed；胜者 fabric 重试成功", async (t) => {
  const hubA = await startMockHub();
  const hubB = await startMockHub();
  t.after(() => closeHub(hubA));
  t.after(() => closeHub(hubB));
  const home = await tmpHome();
  const env = { DWEB_HOME: home };

  // 两进程并发：server A/fabric X 与 server B/fabric Y（显式 --fabric，空 home）
  const race = await Promise.all([
    runCli("join", ["--server", `http://127.0.0.1:${hubA.port}`, "--code", CODE, "--fabric", FABRIC_X], { env }),
    runCli("join", ["--server", `http://127.0.0.1:${hubB.port}`, "--code", CODE, "--fabric", FABRIC_Y], { env }),
  ]);
  const totalRegisters = hubA.registers.length + hubB.registers.length;
  assert.equal(totalRegisters, 1, `远端恰一次 register（实际 ${totalRegisters}）`);
  assert.equal(distinctTuples([...hubA.registers, ...hubB.registers]), 1, "服务端无第二条 (fabric_id, root) 登记");
  const winnerIsA = hubA.registers.length === 1;
  const loser = race[winnerIsA ? 1 : 0];
  assert.notEqual(loser.code, 0, "失败者非零退出");
  assert.match(
    loser.stderr,
    /another join\/admission is already in progress|one fabric per machine/,
    "失败者明确 fail-closed",
  );
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 1, "失败者无 leases 变更");
  const winnerFabric = ledger.leases[0].fabric_id;
  assert.ok(winnerFabric === FABRIC_X || winnerFabric === FABRIC_Y);

  // 胜者锁释放后：失败者按胜者 fabric 重试（同 fabric 跨 server 成功路径）
  const retry = await runCli("join", ["--server", `http://127.0.0.1:${winnerIsA ? hubB.port : hubA.port}`, "--code", CODE, "--fabric", winnerFabric], { env });
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(hubA.registers.length + hubB.registers.length, 2);
  const ledger2 = await loadLeases(home);
  assert.equal(ledger2.leases.length, 2, "两条租约同 fabric");
  assert.equal(new Set(ledger2.leases.map((e) => e.fabric_id)).size, 1);
});

// ---- journal 三类故障注入（子进程） ----------------------------------------------

test("e2e 故障1 响应丢失: register 断连 → journal 保留；同码重跑幂等回放补账清 journal", async (t) => {
  const mock = await startMockHub({ destroyRegister: true });
  t.after(() => closeHub(mock));
  const home = await tmpHome();
  const env = { DWEB_HOME: home };
  const origin = `http://127.0.0.1:${mock.port}`;

  const first = await runCli("join", ["--server", origin, "--code", CODE], { env });
  assert.notEqual(first.code, 0);
  assert.match(first.stderr, /idempotent replay/, "结果未知+回放提示");
  assert.equal(mock.registers.length, 1, "服务端已受理（tuple 已发出）");
  const j = await loadAdmissionJournal(home);
  assert.ok(j.journal, "journal 保留");
  assert.equal((await loadLeases(home)).leases.length, 0, "本地未落账");

  // 同码重跑 → 幂等回放（mock 恢复正常应答）
  mock.opts.destroyRegister = false;
  const second = await runCli("join", ["--server", origin, "--code", CODE], { env });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(mock.registers.length, 2, "回放恰一次");
  assert.match(second.stdout, /recovered\s+pending admission replayed \(attempt 2\)/);
  // 两次 register 同 (fabric_id, root)：远端最多一条登记
  assert.equal(distinctTuples(mock.registers), 1);
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 1);
  assert.equal(ledger.leases[0].fabric_id, mock.registers[0].fabric_id);
  assert.equal(ledger.leases[0].root, mock.registers[0].root);
  assert.equal((await loadAdmissionJournal(home)).journal, null, "清 journal");
});

test("e2e 故障2 register 成功后落账前崩溃: kill 子进程 → journal 保留；陈锁>10s 打破后同码回放补账", async (t) => {
  const mock = await startMockHub({ hangLaterServices: true });
  t.after(() => closeHub(mock));
  const home = await tmpHome();
  const origin = `http://127.0.0.1:${mock.port}`;

  // 子进程 join：preflight OK → register 200 → 复核 services 挂起 → 落账前 SIGKILL
  const child = spawn(process.execPath, [CLI, "join", "--server", origin, "--code", CODE], {
    env: { ...process.env, DWEB_HOME: home },
    stdio: "ignore",
  });
  const deadline = Date.now() + 15_000;
  while (mock.registers.length < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(mock.registers.length, 1, "register 已发出并被受理");
  await new Promise((r) => setTimeout(r, 400)); // 确保已进入复核挂起点
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  assert.equal((await loadLeases(home)).leases.length, 0, "落账前崩溃：无租约");
  const j = await loadAdmissionJournal(home);
  assert.ok(j.journal, "journal 保留（register 已成功）");

  // 崩溃泄漏的 admission 锁为「新锁+死 pid」：按冻结规则需 >10s 才可打破
  const lockText = await fsp.readFile(path.join(home, "fabric.lock"), "utf8");
  assert.match(lockText, /"pid":\d+/);
  await new Promise((r) => setTimeout(r, 10_600));

  // 同码回放（mock 恢复正常复核）→ 补账清 journal
  mock.opts.hangLaterServices = false;
  const r = await runCli("join", ["--server", origin, "--code", CODE], { env: { DWEB_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.registers.length, 2);
  assert.equal(distinctTuples(mock.registers), 1, "远端最多一条 (fabric_id, root) 登记");
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 1);
  assert.equal(ledger.leases[0].fabric_id, mock.registers[0].fabric_id);
  assert.equal(ledger.leases[0].root, mock.registers[0].root);
  assert.equal((await loadAdmissionJournal(home)).journal, null);
});

test("e2e 故障3 陈锁接管: 伪造陈旧 admission 锁（死 pid+老 ts）→ join 打破推进成功", async (t) => {
  const mock = await startMockHub();
  t.after(() => closeHub(mock));
  const home = await tmpHome();
  // 死 pid：短命子进程
  const deadPid = await new Promise((resolve) => {
    const p = execFile(process.execPath, ["-e", "process.exit(0)"], () => {});
    p.on("exit", () => resolve(p.pid));
  });
  await fsp.writeFile(path.join(home, "fabric.lock"), `${JSON.stringify({ pid: deadPid, ts: Date.now() - 60_000 })}\n`);
  const r = await runCli("join", ["--server", `http://127.0.0.1:${mock.port}`, "--code", CODE], { env: { DWEB_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.registers.length, 1);
  assert.equal((await loadLeases(home)).leases.length, 1);
  // 打破后锁正常释放
  const lockGone = await fsp.stat(path.join(home, "fabric.lock")).then(() => false, () => true);
  assert.equal(lockGone, true, "陈锁接管后释放");
});
