// opendweb join 命令测试（server-access-roles Phase 3 + home-hub Phase 1d）。
// 单元（零网络，注入 fetch/dns/now/home）：参数解析、明文守卫矩阵（sidecar
// 语义对齐）、fabric 决策（复用/生成/--fabric 等值采纳/异值 fail-closed）、
// 错误码映射（非零退出、无租约半提交、journal 按协议保留）、回执验签
// fail-closed、码与私钥零泄露。
// e2e（真实 127.0.0.1 mock 服务 + 子进程 CLI）：完整兑换链（守卫放行→
// preflight→签名兑换→验签复核→leases.json 落账 0600）、fabric 复用、失败码
// 端到端。多租约/admission/journal/恢复状态机专测见 join-admission.test.mjs。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { CliExit, machineName, truncateUtf8Bytes, ALIAS_MAX_BYTES } from "../src/util.mjs";
import { parseJoinArgs, validateServerUrl, selectFabricId, runJoin, resolveSelfAlias } from "../src/join.mjs";
import { loadLeases, loadAdmissionJournal } from "../src/leases.mjs";
import { endpointIdHexFromSeed, signDetached, verifyDetached } from "../src/ed25519.mjs";
import { buildRegisterCanonical, buildRegisterReceiptCanonical, toBase64UrlNoPad, inviteCodeHashHex } from "../src/register.mjs";
import { ensureDeviceSeed, deviceKeyFile, loadDeviceSeed } from "../src/device-key.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");
const FABRIC = "aa".repeat(32);
const CODE = "dwebc1.e2e0-qrs7-tvxy-zhjk";
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
function signedReceipt(serverSeed, { ts = FIXED_TS, generation = 7, fabricId, root, expiresAt = FIXED_TS + 30 * 24 * 3600 * 1000, code = CODE } = {}) {
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
      return new Response(
        JSON.stringify({
          server_id: impl.serverId,
          services: [
            { name: "rendezvous", enabled: true, url: `${u.replace("/services.json", "")}/rendezvous` },
            { name: "relay", enabled: true, url: `http://127.0.0.1:3340` },
          ],
        }),
        { status: 200 },
      );
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

// ---- [H6] 自报别名（默认=本机机器名） ------------------------------------------

test("parseJoinArgs [H6]: --alias 空间/等号双形式、缺省 undefined、空值/缺值拒绝", () => {
  const ok = parseJoinArgs(["--server", "http://127.0.0.1:8787", "--code", "c", "--alias", "my-box"]);
  assert.equal(ok.alias, "my-box");
  assert.equal(parseJoinArgs(["--server", "s", "--code", "c", "--alias=box2"]).alias, "box2");
  assert.equal(parseJoinArgs(["--server", "s", "--code", "c"]).alias, undefined);
  assert.throws(() => parseJoinArgs(["--server", "s", "--code", "c", "--alias"]), /missing value/);
  assert.throws(() => parseJoinArgs(["--server", "s", "--code", "c", "--alias", ""]), /must not be empty/);
});

test("resolveSelfAlias [H6]: 机器名默认（剥 .local，大小写不敏感）/--alias 覆盖/超限截断到字符边界/空→无自报", () => {
  assert.deepEqual(resolveSelfAlias({ alias: undefined, hostname: "kzf-MacBook.local" }), { alias: "kzf-MacBook", truncated: false });
  assert.deepEqual(resolveSelfAlias({ alias: undefined, hostname: "kzf-MacBook" }), { alias: "kzf-MacBook", truncated: false });
  assert.deepEqual(resolveSelfAlias({ alias: undefined, hostname: "Box.LOCAL" }), { alias: "Box", truncated: false });
  assert.deepEqual(resolveSelfAlias({ alias: "explicit", hostname: "whatever.local" }), { alias: "explicit", truncated: false });
  // ASCII 40B → 截 32B
  const r = resolveSelfAlias({ alias: "a".repeat(40), hostname: "h" });
  assert.deepEqual(r, { alias: "a".repeat(32), truncated: true });
  // CJK：漢=3B，11 个=33B → 截到 10 个（30B，不劈字符）
  const r2 = resolveSelfAlias({ alias: "漢".repeat(11), hostname: "h" });
  assert.equal(r2.alias, "漢".repeat(10));
  assert.equal(Buffer.byteLength(/** @type {string} */ (r2.alias), "utf8"), 30);
  assert.equal(r2.truncated, true);
  // 恰 32B 不截
  const exact = "漢".repeat(10) + "ab";
  assert.deepEqual(resolveSelfAlias({ alias: exact, hostname: "h" }), { alias: exact, truncated: false });
  // 极端：hostname 为空 → 无自报
  assert.deepEqual(resolveSelfAlias({ alias: undefined, hostname: "" }), { alias: null, truncated: false });
});

test("util [H6]: machineName/truncateUtf8Bytes 纯函数边界", () => {
  assert.equal(machineName(".local"), "");
  assert.equal(machineName("a.local.local"), "a.local", "仅剥尾部一段");
  assert.deepEqual(truncateUtf8Bytes("abc", 32), { value: "abc", truncated: false });
  assert.deepEqual(truncateUtf8Bytes("漢漢", 4), { value: "漢", truncated: true });
  assert.deepEqual(truncateUtf8Bytes("漢漢", 6), { value: "漢漢", truncated: false });
  assert.deepEqual(truncateUtf8Bytes("漢", 0), { value: "", truncated: true });
  assert.equal(ALIAS_MAX_BYTES, 32, "与服务端 ALIAS_MAX_BYTES 同拍");
});

test("runJoin [H6]: body.alias 自报（hostname 默认/剥 .local/--alias 覆盖/空 hostname 无字段）+ 输出呈现", async () => {
  const serverSeed = crypto.randomBytes(32);
  /** @type {any[]} */
  const bodies = [];
  const outputs = [];
  const mkFetch = () => {
    return async (url, init) => {
      const u = String(url);
      if (u.endsWith("/register")) {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return new Response(
          JSON.stringify(signedReceipt(serverSeed, { fabricId: body.fabric_id, root: body.root })),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.endsWith("/services.json")) {
        return new Response(
          JSON.stringify({
            server_id: endpointIdHexFromSeed(serverSeed),
            services: [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    };
  };
  const run = async (argv, hostname) => {
    const cap = capture();
    const code = await runJoin(argv, { home: await tmpHome(), now: () => FIXED_TS, fetchImpl: mkFetch(), stdout: cap.stdout, hostname });
    assert.equal(code, 0);
    outputs.push(cap.lines.join("\n"));
  };

  // ① 默认：hostname 带 .local → 自报剥除形态
  await run(["--server", "http://127.0.0.1:8787", "--code", CODE], "kzf-MacBook.local");
  assert.equal(bodies[0].alias, "kzf-MacBook", "body.alias = 机器名（剥 .local）");
  assert.match(outputs[0], /alias\s+kzf-MacBook \(self-reported\)/, "输出呈现自报别名");
  // ② --alias 显式覆盖
  await run(["--server", "http://127.0.0.1:8787", "--code", CODE, "--alias", "studio-box"], "kzf-MacBook.local");
  assert.equal(bodies[1].alias, "studio-box", "--alias 覆盖机器名");
  // ③ 空 hostname（极端环境）→ body 无 alias 字段、输出无 alias 行
  await run(["--server", "http://127.0.0.1:8787", "--code", CODE], "");
  assert.ok(!("alias" in bodies[2]), "空机器名 = 无自报字段");
  assert.ok(!/^\s{2}alias/m.test(outputs[2]), "无 alias 输出行");
  // ④ 超长 --alias：截断 + note 提示；body 恒 ≤32 UTF-8 字节
  await run(["--server", "http://127.0.0.1:8787", "--code", CODE, "--alias", "x".repeat(40)], "h");
  assert.equal(bodies[3].alias, "x".repeat(32));
  assert.equal(Buffer.byteLength(String(bodies[3].alias), "utf8"), 32);
  assert.match(outputs[3], /exceeded 32 UTF-8 bytes and was truncated/, "截断提示");
  // ⑤ 多字节边界：33B CJK → 30B 合法截断
  await run(["--server", "http://127.0.0.1:8787", "--code", CODE, "--alias", "漢".repeat(11)], "h");
  assert.equal(bodies[4].alias, "漢".repeat(10));
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

test("selectFabricId [1d]: --fabric 显式（大写归一）；既有复用；首设备随机；异值 fail-closed", async () => {
  assert.deepEqual(selectFabricId({ fabric: FABRIC.toUpperCase(), existing: null }), {
    fabricId: FABRIC,
    origin: "flag",
  });
  assert.throws(() => selectFabricId({ fabric: "zz", existing: null }), /64 hex/);
  assert.deepEqual(selectFabricId({ fabric: undefined, existing: FABRIC }), {
    fabricId: FABRIC,
    origin: "reused",
  });
  // 显式值=既有值：采纳（显式确认语义）
  assert.deepEqual(selectFabricId({ fabric: FABRIC, existing: FABRIC }), {
    fabricId: FABRIC,
    origin: "flag",
  });
  // 单 fabric 约束：显式异值=fail-closed（exit 1，非 usage 错误）
  const other = "bb".repeat(32);
  assert.throws(
    () => selectFabricId({ fabric: other, existing: FABRIC }),
    (e) => e instanceof CliExit && e.exitCode === 1 && /one fabric per machine/.test(e.message),
  );
  const a = selectFabricId({ fabric: undefined, existing: null });
  const b = selectFabricId({ fabric: undefined, existing: null });
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

  // 本地数据面：identity.key + leases.json（0600）
  const seed = await loadDeviceSeed(home);
  assert.ok(seed);
  assert.equal(endpointIdHexFromSeed(seed), capturedBody.root);
  const ledgerStat = await fsp.stat(path.join(home, "leases.json"));
  assert.equal(ledgerStat.mode & 0o777, 0o600);
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 1);
  const reg = ledger.leases[0];
  assert.equal(reg.server, "http://127.0.0.1:8787");
  assert.equal(reg.fabric_id, capturedBody.fabric_id);
  assert.equal(reg.root, capturedBody.root);
  assert.equal(reg.expires_at, FIXED_TS + 30 * 24 * 3600 * 1000);
  assert.equal(reg.server_id, serverId);
  assert.equal(reg.relay_url, "http://127.0.0.1:3340");
  assert.equal(reg.label, null);
  assert.match(reg.id, /^[0-9a-z]{10}$/, "10 字符不透明 id");
  assert.equal(reg.receipt.generation, 7);
  // 成功后 journal 清空
  assert.equal((await loadAdmissionJournal(home)).journal, null);

  // 输出：缩写 + 到期日 + 新 fabric 标注 + relay/lease 行；码与私钥零泄露
  const out = cap.lines.join("\n");
  assert.match(out, new RegExp(`${capturedBody.root.slice(0, 3)}\\*\\*\\*${capturedBody.root.slice(-3)}`));
  assert.match(out, /expires\s+\d{4}-\d{2}-\d{2}/);
  assert.match(out, /newly generated/);
  assert.match(out, /receipt\s+verified/);
  assert.match(out, /relay\s+http:\/\/127\.0\.0\.1:3340/);
  assert.match(out, /lease\s+[0-9a-z]{10} \(new entry, 1 in ledger\)/);
  assert.ok(!out.includes(CODE), "码不落输出");
  assert.ok(!out.includes(seed.toString("hex")), "私钥不落输出");
});

test("runJoin 成功: 既有 fabric 复用（旧 registration.json 残留形态），不生成第二个", async () => {
  const home = await tmpHome();
  // 旧单条文件不完整（无 server/root）：迁移按损坏告警保留，fabric preflight
  // 仍读其 fabric_id 复用
  await fsp.writeFile(path.join(home, "registration.json"), JSON.stringify({ version: 1, fabric_id: FABRIC }));
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
    return new Response(
      JSON.stringify({
        server_id: endpointIdHexFromSeed(serverSeed),
        services: [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }],
      }),
      { status: 200 },
    );
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
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 1);
  assert.equal(ledger.leases[0].fabric_id, FABRIC);
});

test("runJoin 失败: --fabric 异值于既有=fail-closed（单 fabric），零网络零落账", async () => {
  const home = await tmpHome();
  const serverSeed = crypto.randomBytes(32);
  await fsp.writeFile(path.join(home, "registration.json"), JSON.stringify({ version: 1, fabric_id: FABRIC }));
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("must not be called");
  };
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE, "--fabric", "bb".repeat(32)], {
      home,
      now: () => FIXED_TS,
      fetchImpl,
      stdout: () => {},
    }),
  );
  assert.equal(info.thrown?.exitCode, 1);
  assert.match(info.thrown?.message ?? "", /one fabric per machine/);
  assert.equal(fetchCalls, 0, "preflight/register 均未发出");
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 0, "零租约落账");
  assert.equal((await loadAdmissionJournal(home)).journal, null, "未写 journal");
});

test("runJoin 失败: legacy registration 与 roster fabric 冲突 → 一致性闸门先于迁移（零迁移副作用不变性）", async () => {
  // r18 P2-1：旧序先提交迁移再查一致性——冲突机器被留在半迁移状态（leases
  // 已写、registration.json 已改名）。新序只读预检（预演迁移条目）→ 冲突
  // CliExit 时零写入：registration.json 原名原字节、无 .migrated、leases.json
  // 不存在、零网络。
  const home = await tmpHome();
  const legacyBytes = `${JSON.stringify(
    {
      version: 1,
      server: "http://192.168.2.13:8787",
      fabric_id: FABRIC,
      root: "cc".repeat(32),
      registered_at: 1757000000000,
      expires_at: 1757900000000,
    },
    null,
    2,
  )}\n`;
  await fsp.writeFile(path.join(home, "registration.json"), legacyBytes);
  // roster.facts 头部 fabric 与 legacy 冲突（DWEBRST1 + 32B fabric）
  await fsp.writeFile(
    path.join(home, "roster.facts"),
    Buffer.concat([Buffer.from("DWEBRST1"), Buffer.from("bb".repeat(32), "hex"), Buffer.alloc(64)]),
  );
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("must not be called");
  };
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      now: () => FIXED_TS,
      fetchImpl,
      stdout: () => {},
    }),
  );
  assert.equal(info.thrown?.exitCode, 1);
  assert.match(info.thrown?.message ?? "", /local fabric state is inconsistent/);
  assert.match(info.thrown?.message ?? "", /left untouched/, "文案明示 legacy 未被触碰");
  assert.equal(fetchCalls, 0, "一致性闸门先于一切网络（含迁移 relay 探测）");
  // 零迁移副作用三断言：字节不变 / 文件名不变 / 租约簿仍不存在
  assert.equal(await fsp.readFile(path.join(home, "registration.json"), "utf8"), legacyBytes, "registration.json 原字节");
  assert.equal(await fsp.stat(path.join(home, "registration.json.migrated")).then(() => true, () => false), false, "无 .migrated 改名");
  assert.equal(await fsp.stat(path.join(home, "leases.json")).then(() => true, () => false), false, "leases.json 仍不存在");
  assert.equal((await loadLeases(home)).leases.length, 0);
  assert.equal((await loadAdmissionJournal(home)).journal, null, "未写 journal");
});

test("runJoin 成功: legacy 与 roster 一致 → 一致性预检过后迁移正常发生（构建语义等价）", async () => {
  // 同一 fixture 族但 roster fabric 与 legacy 一致：预检以「迁移后条目」参与
  // 裁决通过 → 提交路径照常迁移（.migrated 改名 + 首条并入）+ join 落账。
  const home = await tmpHome();
  await fsp.writeFile(
    path.join(home, "registration.json"),
    JSON.stringify({
      version: 1,
      server: "http://127.0.0.1:8787",
      fabric_id: FABRIC,
      root: "cc".repeat(32),
      registered_at: 1757000000000,
      expires_at: 1757900000000,
    }),
  );
  await fsp.writeFile(
    path.join(home, "roster.facts"),
    Buffer.concat([Buffer.from("DWEBRST1"), Buffer.from(FABRIC, "hex"), Buffer.alloc(64)]),
  );
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
    return new Response(
      JSON.stringify({
        server_id: endpointIdHexFromSeed(serverSeed),
        services: [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }],
      }),
      { status: 200 },
    );
  };
  const cap = capture();
  await runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
    home,
    now: () => FIXED_TS,
    fetchImpl,
    stdout: cap.stdout,
  });
  assert.equal(captured.fabric_id, FABRIC, "复用 legacy/roster 一致的本地 fabric");
  // 迁移正常发生：改名 + 迁移首条在簿（root=legacy root），join 新条随后并入
  assert.equal(await fsp.stat(path.join(home, "registration.json.migrated")).then(() => true, () => false), true);
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 2, "迁移首条 + join 新条");
  assert.ok(ledger.leases.some((e) => e.root === "cc".repeat(32) && e.registered_at === 1757000000000), "迁移条目保留 legacy root/registered_at");
  assert.ok(ledger.leases.every((e) => e.fabric_id === FABRIC), "单 fabric 约束");
});

// ---- runJoin：失败矩阵（非零退出 + 无半提交 + 码不泄露） -----------------------

const FAIL_CODES = ["bad-signature", "stale-ts", "code-invalid", "code-exhausted", "code-expired", "code-pending", "code-unavailable", "rate-limited", "invalid-request"];

const manifestOk = (serverId) =>
  new Response(
    JSON.stringify({
      server_id: serverId,
      services: [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }],
    }),
    { status: 200 },
  );

for (const errCode of FAIL_CODES) {
  test(`runJoin 失败映射: ${errCode} → 非零退出、人类可读、无租约半提交、journal 保留`, async () => {
    const home = await tmpHome();
    const serverId = endpointIdHexFromSeed(crypto.randomBytes(32));
    let registerCalls = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/register")) {
        registerCalls += 1;
        return new Response(JSON.stringify({ error: { code: errCode, message: "server detail" } }), { status: 400 });
      }
      return manifestOk(serverId);
    };
    const info = await exitInfo(
      runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], { home, now: () => FIXED_TS, fetchImpl, stdout: () => {} }),
    );
    assert.equal(info.thrown?.exitCode, 1);
    assert.match(info.thrown?.message ?? "", new RegExp(errCode));
    assert.equal(registerCalls, 1, "register 恰一次（journal 前置）");
    assert.equal((await loadLeases(home)).leases.length, 0, "无租约半提交");
    const j = await loadAdmissionJournal(home);
    assert.ok(j.journal, "journal 按协议保留（重试经幂等回放恢复）");
    if (errCode === "code-invalid" || errCode === "code-expired") {
      assert.match(info.thrown?.message ?? "", /manual recovery/i, "不得判「明确未登记」");
    }
  });
}

test("runJoin 失败: preflight 非 2xx/坏 JSON 明确归并；register 网络未知=journal 保留+回放提示", async () => {
  const home = await tmpHome();
  // services.json 500 → preflight 失败（register 未发出）
  let registerCalls = 0;
  const http500 = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/register")) {
          registerCalls += 1;
          return new Response("oops", { status: 500 });
        }
        return new Response("oops", { status: 500 });
      },
      stdout: () => {},
    }),
  );
  assert.match(http500.thrown?.message ?? "", /HTTP 500/);
  assert.match(http500.thrown?.message ?? "", /services preflight failed/);
  assert.equal(registerCalls, 0, "preflight 失败时 register 未发出");

  // register 网络不可达：结果未知 → journal 保留 + 幂等回放提示
  const unreachable = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/register")) {
          throw new Error("ECONNREFUSED");
        }
        return manifestOk(endpointIdHexFromSeed(crypto.randomBytes(32)));
      },
      stdout: () => {},
    }),
  );
  assert.match(unreachable.thrown?.message ?? "", /cannot reach/);
  assert.match(unreachable.thrown?.message ?? "", /idempotent replay/);
  assert.equal((await loadLeases(home)).leases.length, 0);
  const j = await loadAdmissionJournal(home);
  assert.ok(j.journal, "journal 保留");
  assert.match(j.journal?.last_error ?? "", /network/);
});

test("runJoin 失败: 畸形成功响应/preflight 公钥不可得/回执验签不过 → 拒绝落账+journal 保留", async () => {
  const home = await tmpHome();
  const serverSeed = crypto.randomBytes(32);
  const serverId = endpointIdHexFromSeed(serverSeed);
  const goodRoot = endpointIdHexFromSeed(crypto.randomBytes(32));

  // 畸形 200 体（register 成功形态非 JSON 契约）
  const malformed = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async (url) => (String(url).endsWith("/register") ? new Response(JSON.stringify({ what: 1 }), { status: 200 }) : manifestOk(serverId)),
      stdout: () => {},
    }),
  );
  assert.match(malformed.thrown?.message ?? "", /malformed success response/);
  assert.ok((await loadAdmissionJournal(home)).journal, "journal 保留");

  // services.json 不可得 → preflight 失败（register 未发出、journal 未写）；
  // 独立 home（malformed 案例留下的 journal 会把后续 join 切入恢复模式）
  const noServicesHome = await tmpHome();
  const noServices = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home: noServicesHome,
      fetchImpl: async () => new Response("down", { status: 503 }),
      stdout: () => {},
    }),
  );
  assert.match(noServices.thrown?.message ?? "", /services preflight failed.*services\.json/);
  assert.equal((await loadAdmissionJournal(noServicesHome)).journal, null, "preflight 失败不写 journal");

  // 回执由另一把 key 签（伪造）→ 验签失败拒绝保存（独立 home，同上）
  const forgedHome = await tmpHome();
  const forged = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home: forgedHome,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/register")) {
          const receipt = signedReceipt(crypto.randomBytes(32), { fabricId: FABRIC, root: goodRoot });
          return new Response(JSON.stringify(receipt), { status: 200 });
        }
        return manifestOk(serverId);
      },
      stdout: () => {},
    }),
  );
  assert.match(forged.thrown?.message ?? "", /did not verify/);
  assert.equal((await loadLeases(home)).leases.length, 0, "全部失败路径无租约半提交");
});
// （forged 用独立 home；同 home 的 malformed 案例已各自断言）

test("runJoin 失败: 回执 fabric/root 与本 admission 不符 → 拒绝落账（防错配）", async () => {
  const home = await tmpHome();
  const serverSeed = crypto.randomBytes(32);
  const wrong = signedReceipt(serverSeed, { fabricId: FABRIC, root: "cc".repeat(32) });
  const info = await exitInfo(
    runJoin(["--server", "http://127.0.0.1:8787", "--code", CODE], {
      home,
      fetchImpl: async (url) =>
        String(url).endsWith("/register")
          ? new Response(JSON.stringify(wrong), { status: 200 })
          : manifestOk(endpointIdHexFromSeed(serverSeed)),
      stdout: () => {},
    }),
  );
  assert.match(info.thrown?.message ?? "", /do not match this admission/);
  assert.equal((await loadLeases(home)).leases.length, 0);
  assert.ok((await loadAdmissionJournal(home)).journal, "journal 保留（远端已登记提示回放恢复）");
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
  assert.equal((await loadLeases(home)).leases.length, 0);
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
  let mockPortBase = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url === "/services.json") {
        seen.push({ path: req.url, body: null });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            server_id: serverId,
            gateway: `http://127.0.0.1:${mockPortBase}`,
            services: [
              { name: "rendezvous", enabled: true, url: `http://127.0.0.1:${mockPortBase}/rendezvous` },
              { name: "relay", enabled: true, url: "http://127.0.0.1:3340" },
            ],
          }),
        );
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
    server.listen(0, "127.0.0.1", () => {
      mockPortBase = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      resolve({ server, port: mockPortBase, seen, serverId });
    });
  });
}

test("e2e join: 持有效码完整兑换（loopback http 免 --allow-insecure）→ 落账 + id 一致", async (t) => {
  const mock = await startMockRegisterServer();
  t.after(() => new Promise((r) => mock.server.close(() => r(null))));
  const home = await tmpHome();
  const env = { DWEB_HOME: home };

  const r = await runCli("join", ["--server", `http://127.0.0.1:${mock.port}`, "--code", CODE], { env });
  assert.equal(r.code, 0, r.stderr);
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 1, "leases.json 落账一条");
  const reg = ledger.leases[0];
  assert.equal(reg.server, `http://127.0.0.1:${mock.port}`);
  assert.equal(reg.relay_url, "http://127.0.0.1:3340", "relay_url 来自 services manifest");
  assert.match(String(reg.fabric_id), /^[0-9a-f]{64}$/);
  const seed = await loadDeviceSeed(home);
  assert.equal(reg.root, endpointIdHexFromSeed(seed));
  assert.equal(reg.server_id, mock.serverId);
  const stat = await fsp.stat(path.join(home, "leases.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.match(r.stdout, new RegExp(`${reg.root.slice(0, 3)}\\*\\*\\*${reg.root.slice(-3)}`));
  assert.match(r.stdout, /expires\s+\d{4}-\d{2}-\d{2}/);
  assert.ok(!r.stdout.includes(CODE) && !r.stderr.includes(CODE), "码全文不落 stdout/stderr");
  // join 成功不产生到访记录（租户路径只写 leases）
  assert.equal(await fsp.stat(path.join(home, "visits.json")).then(() => true, () => false), false);

  // 服务端收到了可验签的 PoP（mock 已验签）+ services.json 拉取序（preflight+复核=2）
  assert.equal(mock.seen.filter((s) => s.path === "/register").length, 1);
  assert.equal(mock.seen.filter((s) => s.path === "/services.json").length, 2);
  // [H6] 自报别名：子进程 CLI 以本机机器名（剥 .local）入 body + 输出呈现
  const regBody = /** @type {{ path: string, body: any }} */ (mock.seen.find((s) => s.path === "/register")).body;
  assert.equal(regBody.alias, machineName(os.hostname()), "body.alias = 本机机器名（剥 .local）");
  assert.match(r.stdout, /alias\s+\S+ \(self-reported\)/, "join 成功输出呈现自报别名");

  // opendweb id 与 join 的 root 一致（同一设备身份）；[H6] 机器名行 + [1d] 租约计数行
  const idr = await runCli("id", [], { env });
  assert.equal(idr.code, 0);
  assert.match(idr.stdout, new RegExp(reg.root));
  assert.ok(
    idr.stdout.includes(`hostname     ${machineName(os.hostname())}`),
    `id 输出本机机器名（实际：${idr.stdout}）`,
  );
  assert.ok(idr.stdout.includes("leases       1"), `id 输出租约计数（实际：${idr.stdout}）`);

  // 第二次 join（同码再兑）：fabric 复用、root 不变、同键续期（不新增条目）
  const firstFabric = String(reg.fabric_id);
  const firstRegisteredAt = reg.registered_at;
  const r2 = await runCli("join", ["--server", `http://127.0.0.1:${mock.port}`, "--code", CODE], { env });
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /reused local fabric/);
  const ledger2 = await loadLeases(home);
  assert.equal(ledger2.leases.length, 1, "同键 upsert 不新增条目");
  assert.equal(ledger2.leases[0].fabric_id, firstFabric, "不静默生成第二个 fabric");
  assert.equal(ledger2.leases[0].registered_at, firstRegisteredAt, "registered_at 保持首条");
  const idr2 = await runCli("id", [], { env });
  assert.ok(idr2.stdout.includes("leases       1"), "同键续期后计数仍为 1");
});

test("e2e join: 失效码非零退出、人类可读、无租约落账（journal 保留+人工恢复文案）", async (t) => {
  const mock = await startMockRegisterServer();
  t.after(() => new Promise((r) => mock.server.close(() => r(null))));
  const home = await tmpHome();
  const env = { DWEB_HOME: home };
  const r = await runCli("join", ["--server", `http://127.0.0.1:${mock.port}`, "--code", "dwebc1.dddd-dddd-dddd-dddd"], { env });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /code-expired/);
  assert.match(r.stderr, /expired/, "人类可读错误");
  assert.match(r.stderr, /manual recovery/i, "code-expired 不得判「明确未登记」");
  assert.equal((await loadLeases(home)).leases.length, 0, "无租约半提交");
  assert.ok((await loadAdmissionJournal(home)).journal, "journal 保留");
  // 设备 key 属设备级引导（首启生成、重试复用）——非注册半提交状态
  const seed = await loadDeviceSeed(home);
  assert.ok(seed, "设备 key 已引导（join 职责）；租约未落账");
});

test("e2e join: 非 loopback 明文 http → 守卫 exit 2，零本地状态", async () => {
  const home = await tmpHome();
  const r = await runCli("join", ["--server", "http://192.0.2.1:8787", "--code", CODE], { env: { DWEB_HOME: home } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /non-loopback/);
  assert.match(r.stderr, /--allow-insecure/);
  assert.equal((await loadLeases(home)).leases.length, 0);
  assert.equal(await loadDeviceSeed(home), null, "守卫拒绝时不生成设备 key");
});
