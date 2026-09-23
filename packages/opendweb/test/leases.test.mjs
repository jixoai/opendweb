// home-hub Phase 1d 测试：多租约簿/跨进程锁/迁移/到访簿探测/journal 小件/
// 码规范化+blake3 golden 对拍（A/B 段）。
// golden 向量来源：Rust blake3 1.8.7（与 crates/dweb-server 同版本依赖）在
// /tmp 独立工程离线生成的 frozen 输出（长度谱系 0..2049 覆盖块/块链/父节点
// 边界）；normalize 语义矩阵逐条对拍 crates/dweb-server/src/access/codes.rs
// 的 normalize_code_body 测试矩阵。并发双写=真子进程；探测=本地 http mock。

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { blake3Hex } from "../src/blake3.mjs";
import { normalizeInviteCode, inviteCodeHashHex } from "../src/register.mjs";
import {
  acquireFileLock,
  loadLeases,
  upsertLease,
  migrateLegacyRegistration,
  readLegacyRegistration,
  readRosterFabricId,
  resolveExistingFabricId,
  loadVisits,
  recordVisit,
  probeServer,
  selectRelayFromManifest,
  isLegalHttpUrl,
  loadAdmissionJournal,
  saveAdmissionJournal,
  clearAdmissionJournal,
  STALE_LOCK_MS,
} from "../src/leases.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const FABRIC = "aa".repeat(32);
const OTHER_FABRIC = "bb".repeat(32);
const ROOT = "11".repeat(32);


/** 关停本地 http mock（closeAllConnections 防 keep-alive 空闲连接悬死 close 回调） */
function closeHttpServer(srv) {
  return new Promise((resolve) => {
    srv.closeAllConnections?.();
    srv.close(() => resolve(null));
  });
}

/** @returns {Promise<string>} */
async function tmpHome() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-leases-"));
}

// ---- blake3 golden 对拍（Rust 独立生成 frozen 向量） ----------------------------

test("blake3: 长度谱系 frozen 向量（块/块链/父节点边界；Rust blake3 1.8.7 对拍）", () => {
  const vectors = [
    [0, "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"],
    [1, "2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213"],
    [2, "7b7015bb92cf0b318037702a6cdd81dee41224f734684c2c122cd6359cb1ee63"],
    [3, "e1be4d7a8ab5560aa4199eea339849ba8e293d55ca0a81006726d184519e647f"],
    [63, "e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b"],
    [64, "4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98"],
    [65, "de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee"],
    [1023, "10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11"],
    [1024, "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7"],
    [1025, "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444"],
    [2048, "e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a"],
    [2049, "5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030"],
  ];
  for (const [n, want] of vectors) {
    // 载荷与 Rust 侧生成器同构：(i % 251)
    const data = Buffer.from(Array.from({ length: n }, (_, i) => i % 251));
    assert.equal(blake3Hex(data), want, `len=${n}`);
  }
});

// ---- 码规范化 + hash golden 对拍（codes.rs 语义矩阵） ---------------------------

test("normalizeInviteCode: Rust normalize_code_body 测试矩阵逐条对拍", () => {
  assert.equal(normalizeInviteCode("dwebc1.0123-4567-89cd-fghj"), "0123456789cdfghj");
  assert.equal(normalizeInviteCode("DWEBC1.0123-4567-89cd-fghj"), "0123456789cdfghj");
  assert.equal(normalizeInviteCode("0123456789cdfghj"), "0123456789cdfghj");
  assert.equal(normalizeInviteCode("dwebc1.0123456789CDFGHJ"), "0123456789cdfghj");
  assert.equal(normalizeInviteCode("  dwebc1.0123-4567-89cd-fghj  "), "0123456789cdfghj");
  assert.equal(normalizeInviteCode("01234567 89cdfghj"), null, "组内空白拒绝");
  for (const bad of ["dwebc1.0123-4567-89cd-fghi", "dwebc1.0l23456789cdfghj", "dwebc1.0123456789cdfgho", "dwebc1.0123456u89cdfghj"]) {
    assert.equal(normalizeInviteCode(bad), null, `歧义字符拒绝：${bad}`);
  }
  assert.equal(normalizeInviteCode(""), null);
  assert.equal(normalizeInviteCode("dwebc1.0123-4567-89cd-fg"), null, "长度不足");
  assert.equal(normalizeInviteCode("dwebc1.0123-4567-89cd-fghjk"), null, "长度超出");
  assert.equal(normalizeInviteCode("dwebc1.0123456789cdfgh\u00e9"), null, "非 ASCII 拒绝");
});

test("inviteCodeHashHex: 同本体不同书写形态同哈希；frozen 向量（Rust blake3 对拍）", () => {
  // Rust 生成器 frozen 输出：blake3(16 字符码本体)
  assert.equal(inviteCodeHashHex("dwebc1.0123-4567-89cd-fghj"), "2855414ed8ced769c8ef33f915a38b1de7678b0a227fc55b83169ccbc34a91a6");
  assert.equal(inviteCodeHashHex("DWEBC1.0123456789CDFGHJ"), "2855414ed8ced769c8ef33f915a38b1de7678b0a227fc55b83169ccbc34a91a6");
  assert.equal(inviteCodeHashHex("dwebc1.e2e0-qrs7-tvxy-zhjk"), "38226b6eb4a0de460c28f90b0aa4100da2bf12825a6508b18c4de0855428128f");
  assert.equal(inviteCodeHashHex("dddddddddddddddd"), "9cea9316c765d78eb772642f1a7b2b2d4d4806a61c4b939e3816a1b34c6fa0bb");
  assert.equal(inviteCodeHashHex("dwebc1.0l23456789cdfghj"), null, "非法形态 null");
});

// ---- upsertLease：条目 schema/续期语义/label 保留 -------------------------------

const RECEIPT = { ts: 1758000000000, generation: 3, code_hash: "22".repeat(32), receipt_sig: "sig" };

test("upsertLease: 新条目 schema（id/label null/0600）+ 同键续期保 registered_at/id", async () => {
  const home = await tmpHome();
  const now = 1758000000000;
  const mk = (over) => ({
    server: "http://127.0.0.1:8787",
    relayUrl: "http://127.0.0.1:3340",
    serverId: "ab".repeat(32),
    fabricId: FABRIC,
    root: ROOT,
    alias: "box",
    expiresAt: now + 86_400_000,
    receipt: RECEIPT,
    ...over,
  });
  const first = await upsertLease(home, mk({}), { now: () => now });
  assert.equal(first.created, true);
  assert.match(first.entry.id, /^[0-9a-z]{10}$/, "10 字符不透明 id");
  assert.equal(first.entry.label, null);
  assert.equal(first.entry.registered_at, now);
  const stat = await fsp.stat(path.join(home, "leases.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  const lockGone = await fsp.stat(path.join(home, "leases.lock")).then(() => false, () => true);
  assert.equal(lockGone, true, "锁释放");

  // 同键持新码 join=续期 upsert：expires/receipt/relay 更新、registered_at/id 保持
  const later = now + 900_000;
  const second = await upsertLease(
    home,
    mk({ alias: "box2", relayUrl: "http://127.0.0.1:9999", expiresAt: later + 86_400_000, receipt: { ...RECEIPT, generation: 4 } }),
    { now: () => later },
  );
  assert.equal(second.created, false, "同键不新增条目");
  assert.equal(second.total, 1);
  assert.equal(second.entry.id, first.entry.id, "id 稳定");
  assert.equal(second.entry.registered_at, now, "registered_at 保持首条");
  assert.equal(second.entry.alias, "box2", "alias 更新当前自报");
  assert.equal(second.entry.relay_url, "http://127.0.0.1:9999");
  assert.equal(second.entry.receipt.generation, 4);

  // 换 server=新条目（0..N，fabric 维度恒 1 由 join 侧保证）
  const third = await upsertLease(home, mk({ server: "http://127.0.0.2:8787" }), { now: () => later });
  assert.equal(third.created, true);
  assert.equal(third.total, 2);
  assert.notEqual(third.entry.id, first.entry.id);

  // label 是本地备注：join upsert 不得重置（模拟 label 编辑后的再 join）
  const ledger = await loadLeases(home);
  ledger.leases[0].label = "家里的 Mac";
  await fsp.writeFile(path.join(home, "leases.json"), JSON.stringify(ledger, null, 2));
  await upsertLease(home, mk({ alias: "box3" }), { now: () => later + 1 });
  const after = await loadLeases(home);
  assert.equal(after.leases[0].label, "家里的 Mac", "label 保留用户值");
});

// ---- 并发双写不丢更新（真子进程，两进程同时写不同 server） -----------------------

test("并发双写不丢更新：两子进程同时 upsert 不同 server，终态两条全在", async () => {
  const home = await tmpHome();
  const writer = path.join(os.tmpdir(), `leases-writer-${process.pid}-${Date.now()}.mjs`);
  await fsp.writeFile(
    writer,
    `import { upsertLease } from ${JSON.stringify(pathToFileURL(path.join(SRC, "leases.mjs")).href)};
const home = process.argv[2];
const server = process.argv[3];
const r = await upsertLease(home, {
  server, relayUrl: "http://127.0.0.1:3340", serverId: "ab".repeat(32),
  fabricId: "${FABRIC}", root: "${ROOT}", alias: "w", expiresAt: 1, receipt: null,
});
console.log(JSON.stringify({ ok: true, id: r.entry.id }));
`,
  );
  try {
    const run = (server) =>
      new Promise((resolve, reject) =>
        execFile(process.execPath, [writer, home, server], { timeout: 30_000 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        ),
      );
    const [a, b] = await Promise.all([run("http://10.0.0.1:8787"), run("http://10.0.0.2:8787")]);
    assert.ok(JSON.parse(a).ok && JSON.parse(b).ok);
    const ledger = await loadLeases(home);
    const servers = ledger.leases.map((e) => e.server).sort();
    assert.deepEqual(servers, ["http://10.0.0.1:8787", "http://10.0.0.2:8787"], "锁内重读合并，无静默丢失");
  } finally {
    await fsp.rm(writer, { force: true });
  }
});

// ---- 文件锁协议 ------------------------------------------------------------------

test("acquireFileLock: 互斥（同进程模拟活 pid 占用→退避耗尽报错）+ 释放后可再取", async () => {
  const home = await tmpHome();
  const lockFile = path.join(home, "leases.lock");
  const nowMs = Date.now();
  const first = await acquireFileLock(lockFile, { now: () => nowMs });
  assert.equal(first.ok, true);
  // 活 pid 占用（当前进程 pid 恒活）→ 打破条件不满足 → 退避 ≤3 后报错
  const second = await acquireFileLock(lockFile, { now: () => nowMs + 1000 });
  assert.equal(second.ok, false);
  assert.equal(second.holderPid, process.pid);
  assert.equal(await first.release(), true);
  const third = await acquireFileLock(lockFile, { now: () => nowMs + 2000 });
  assert.equal(third.ok, true, "释放后可再取");
  assert.equal(await third.release(), true);
});

test("acquireFileLock: 陈锁（>10s 且 pid 死）打破；新锁/活 pid/损坏锁不可打破", async () => {
  const home = await tmpHome();
  const now = Date.now();
  // 死 pid：起一个短命子进程取其 pid
  const dead = await new Promise((resolve) => {
    const p = execFile(process.execPath, ["-e", "process.exit(0)"], () => {});
    p.on("exit", () => resolve(/** @type {number} */ (p.pid)));
  });
  assert.ok(typeof dead === "number" && dead !== process.pid);
  await new Promise((r) => setTimeout(r, 50));
  // 陈锁：ts=now-60s、pid=死进程 → 打破
  const staleFile = path.join(home, "stale.lock");
  await fsp.writeFile(staleFile, `${JSON.stringify({ pid: dead, ts: now - 60_000 })}\n`);
  const broke = await acquireFileLock(staleFile, { now: () => now });
  assert.equal(broke.ok, true, ">10s 且 pid 死 → 打破重建");
  assert.equal(await broke.release(), true);
  // 新锁（<10s）即使 pid 死也不可打破
  const freshFile = path.join(home, "fresh.lock");
  await fsp.writeFile(freshFile, `${JSON.stringify({ pid: dead, ts: now - 1000 })}\n`);
  const fresh = await acquireFileLock(freshFile, { now: () => now });
  assert.equal(fresh.ok, false, "新锁不打破");
  // 活 pid 即使陈旧也不可打破
  const aliveFile = path.join(home, "alive.lock");
  await fsp.writeFile(aliveFile, `${JSON.stringify({ pid: process.pid, ts: now - 60_000 })}\n`);
  const alive = await acquireFileLock(aliveFile, { now: () => now });
  assert.equal(alive.ok, false, "活 pid 不打破");
  // 损坏锁文件：不可打破（按活占用退避后报错）
  const corruptFile = path.join(home, "corrupt.lock");
  await fsp.writeFile(corruptFile, "not-json{{{");
  const corrupt = await acquireFileLock(corruptFile, { now: () => now });
  assert.equal(corrupt.ok, false, "损坏锁不猜不打破");
  // 锁归属校验（内容比对）：内容被他人改写 → release 不动他人的锁
  const hijack = path.join(home, "hijack.lock");
  const mine = await acquireFileLock(hijack, { now: () => now });
  assert.equal(mine.ok, true);
  await fsp.writeFile(hijack, `${JSON.stringify({ pid: process.pid + 1, ts: now })}\n`);
  assert.equal(await mine.release(), false, "归属不符不释放");
  const stillHeld = await fsp.readFile(hijack, "utf8");
  assert.match(stillHeld, /"pid":\d+/);
});

test("acquireFileLock: 陈锁阈值恰为 STALE_LOCK_MS=10s", () => {
  assert.equal(STALE_LOCK_MS, 10_000);
});

// ---- 迁移三形态 + relay_url 探测补全 ---------------------------------------------

test("迁移: 完好旧文件 → 并入首条（relay_url 探测补全）+ 改名 .migrated", async (t) => {
  const home = await tmpHome();
  const body = { server_id: "cd".repeat(32), services: [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }] };
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(() => r(null))));
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (srv.address()).port}`;
  await fsp.writeFile(
    path.join(home, "registration.json"),
    JSON.stringify({
      version: 1,
      server: origin,
      server_id: "cd".repeat(32),
      fabric_id: FABRIC,
      root: ROOT,
      registered_at: 1757000000000,
      expires_at: 1757900000000,
      receipt: RECEIPT,
    }),
  );
  const result = await migrateLegacyRegistration(home, { fetchImpl: fetch, now: () => 1758000000000 });
  assert.equal(result.migrated, true);
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases.length, 1);
  const e = ledger.leases[0];
  assert.equal(e.server, origin);
  assert.equal(e.fabric_id, FABRIC);
  assert.equal(e.root, ROOT);
  assert.equal(e.relay_url, "http://127.0.0.1:3340", "relay_url 探测补全");
  assert.equal(e.registered_at, 1757000000000, "首条注册时刻保留");
  // 旧文件改名不删
  const migrated = await fsp.stat(path.join(home, "registration.json.migrated")).then(() => true, () => false);
  assert.equal(migrated, true);
  const gone = await fsp.stat(path.join(home, "registration.json")).then(() => true, () => false);
  assert.equal(gone, false);
});

test("迁移: 不可达 server → relay_url 留空待补；条目仍并入", async () => {
  const home = await tmpHome();
  await fsp.writeFile(
    path.join(home, "registration.json"),
    JSON.stringify({ version: 1, server: "http://127.0.0.1:1", fabric_id: FABRIC, root: ROOT, registered_at: 1, expires_at: 2 }),
  );
  const warns = [];
  const result = await migrateLegacyRegistration(home, { fetchImpl: fetch, probeTimeoutMs: 500, warn: (l) => warns.push(l) });
  assert.equal(result.migrated, true, "不可达不阻塞迁移");
  const ledger = await loadLeases(home);
  assert.equal(ledger.leases[0].relay_url, "", "留空待下次 join 补");
  assert.equal(warns.length, 0);
});

test("迁移: 损坏旧文件 → 警告保留不阻塞；缺失 → 无动作；已迁移（leases 存在）→ 无动作", async () => {
  const home = await tmpHome();
  await fsp.writeFile(path.join(home, "registration.json"), "{ not json");
  const warns = [];
  const damaged = await migrateLegacyRegistration(home, { fetchImpl: fetch, warn: (l) => warns.push(l) });
  assert.equal(damaged.migrated, false);
  assert.equal(warns.length, 1, "损坏警告");
  const kept = await readLegacyRegistration(home);
  assert.equal(kept.corrupt, true, "原文件原样保留");
  assert.equal((await loadLeases(home)).leases.length, 0);
  // 必需字段缺失（无 server）= 按损坏处理
  await fsp.writeFile(path.join(home, "registration.json"), JSON.stringify({ version: 1, fabric_id: FABRIC }));
  const incomplete = await migrateLegacyRegistration(home, { fetchImpl: fetch, warn: () => {} });
  assert.equal(incomplete.migrated, false);
  // 缺失 → 无迁移动作
  const home2 = await tmpHome();
  const missing = await migrateLegacyRegistration(home2, { fetchImpl: fetch });
  assert.deepEqual(missing, { migrated: false, warning: null, entry: null });
  // leases 已存在 → 旧文件不再迁移
  await upsertLease(
    home2,
    { server: "http://127.0.0.1:9", relayUrl: "", serverId: null, fabricId: FABRIC, root: ROOT, alias: null, expiresAt: 0, receipt: null },
  );
  await fsp.writeFile(path.join(home2, "registration.json"), JSON.stringify({ version: 1, server: "http://x", fabric_id: FABRIC }));
  const skip = await migrateLegacyRegistration(home2, { fetchImpl: fetch });
  assert.equal(skip.migrated, false);
});

// ---- 既有 fabric 汇裁 + roster 头读取 --------------------------------------------

test("resolveExistingFabricId: 优先级（leases>旧文件>roster）+ 多源冲突 fail-closed", () => {
  assert.deepEqual(resolveExistingFabricId({ leases: [], legacy: null, rosterFabricId: null }), { ok: true, fabricId: null });
  assert.deepEqual(
    resolveExistingFabricId({ leases: [{ fabric_id: FABRIC }], legacy: null, rosterFabricId: null }),
    { ok: true, fabricId: FABRIC },
  );
  assert.deepEqual(
    resolveExistingFabricId({ leases: [], legacy: { fabric_id: FABRIC }, rosterFabricId: null }),
    { ok: true, fabricId: FABRIC },
  );
  assert.deepEqual(
    resolveExistingFabricId({ leases: [], legacy: null, rosterFabricId: OTHER_FABRIC }),
    { ok: true, fabricId: OTHER_FABRIC },
  );
  // 多源一致=可用；互不相等=本地不一致 fail-closed
  assert.deepEqual(
    resolveExistingFabricId({ leases: [{ fabric_id: FABRIC }], legacy: { fabric_id: FABRIC }, rosterFabricId: FABRIC }),
    { ok: true, fabricId: FABRIC },
  );
  const conflict = resolveExistingFabricId({ leases: [{ fabric_id: FABRIC }], legacy: { fabric_id: OTHER_FABRIC }, rosterFabricId: null });
  assert.equal(conflict.ok, false);
  assert.deepEqual(/** @type {{conflict: string[]}} */ (conflict).conflict.sort(), [FABRIC, OTHER_FABRIC].sort());
});

test("readRosterFabricId: DWEBRST1 头部 32B fabric_id 纯 JS 读取；非法形态 null", async () => {
  const home = await tmpHome();
  assert.equal(await readRosterFabricId(home), null, "无文件 → null");
  await fsp.writeFile(path.join(home, "roster.facts"), Buffer.concat([Buffer.from("DWEBRST1"), Buffer.from(FABRIC, "hex"), Buffer.alloc(64)]));
  assert.equal(await readRosterFabricId(home), FABRIC);
  await fsp.writeFile(path.join(home, "roster.facts"), Buffer.concat([Buffer.from("XXXXXXXX"), Buffer.alloc(32)]));
  assert.equal(await readRosterFabricId(home), null, "魔数不符 → null");
  await fsp.writeFile(path.join(home, "roster.facts"), Buffer.from("DWEBRST1"));
  assert.equal(await readRosterFabricId(home), null, "过短 → null");
});

// ---- visits：五类探测映射 + 落账 --------------------------------------------------

test("探测五类映射（本地 http mock）: reachable/http-status/conn-refused/bad-body + timeout（挂起连接）", async (t) => {
  // 可达 + 500 + 坏 JSON 三形态一个服务器出
  let mode = "ok";
  const srv = http.createServer((req, res) => {
    if (mode === "500") {
      res.writeHead(500);
      res.end("boom");
    } else if (mode === "bad-body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<<not json>>");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ server_id: "ef".repeat(32), services: [{ name: "relay", enabled: true, url: "http://127.0.0.1:3340" }] }));
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(() => r(null))));
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (srv.address()).port}`;

  const okProbe = await probeServer(origin, { fetchImpl: fetch, now: () => 1 });
  assert.deepEqual({ result: okProbe.result, detail: okProbe.detail, serverId: okProbe.serverId }, { result: "reachable", detail: null, serverId: "ef".repeat(32) });

  mode = "500";
  const s500 = await probeServer(origin, { fetchImpl: fetch, now: () => 2 });
  assert.deepEqual({ result: s500.result, detail: s500.detail }, { result: "unreachable", detail: "http-status:500" });

  mode = "bad-body";
  const bad = await probeServer(origin, { fetchImpl: fetch, now: () => 3 });
  assert.deepEqual({ result: bad.result, detail: bad.detail }, { result: "unreachable", detail: "bad-body" });

  // 连接拒绝：已关闭端口（先断 keep-alive 连接再关）
  const closedPort = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
  await closeHttpServer(srv);
  const refused = await probeServer(`http://127.0.0.1:${closedPort}`, { fetchImpl: fetch, now: () => 4 });
  assert.deepEqual({ result: refused.result, detail: refused.detail }, { result: "unreachable", detail: "conn-refused" });

  // 超时：accept 后不响应（挂起连接；socket 显式回收）
  /** @type {Set<import("node:net").Socket>} */
  const silentSockets = new Set();
  const silent = net.createServer((s) => {
    silentSockets.add(s);
    s.on("close", () => silentSockets.delete(s));
  });
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  t.after(() => {
    for (const s of silentSockets) s.destroy();
    return new Promise((r) => silent.close(() => r(null)));
  });
  const silentPort = /** @type {import("node:net").AddressInfo} */ (silent.address()).port;
  const timedOut = await probeServer(`http://127.0.0.1:${silentPort}`, { fetchImpl: fetch, timeoutMs: 300, now: () => 5 });
  assert.deepEqual({ result: timedOut.result, detail: timedOut.detail }, { result: "unreachable", detail: "timeout" });
});

test("探测映射: DNS 失败 → dns（注入 cause.code=ENOTFOUND 的网络错误）", async () => {
  const dnsFail = async () => {
    const err = /** @type {Error & { cause?: { code?: string } }} */ (new Error("fetch failed"));
    err.cause = { code: "ENOTFOUND" };
    throw err;
  };
  const probe = await probeServer("http://nope.invalid", { fetchImpl: /** @type {typeof fetch} */ (dnsFail), now: () => 1 });
  assert.deepEqual({ result: probe.result, detail: probe.detail }, { result: "unreachable", detail: "dns" });
  const agai = /** @type {Error & { cause?: { code?: string } }} */ (new Error("x"));
  agai.cause = { code: "EAI_AGAIN" };
  const probe2 = await probeServer("http://nope.invalid", { fetchImpl: /** @type {typeof fetch} */ (async () => { throw agai; }), now: () => 1 });
  assert.equal(probe2.detail, "dns");
});

test("recordVisit: 建条（first_visit_at/last_visit_at=最近 reachable）+ 更新（仅 reachable 刷新 last_visit_at）+ 0600", async (t) => {
  const home = await tmpHome();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ server_id: "ef".repeat(32) }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => closeHttpServer(srv));
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (srv.address()).port}`;

  // 首探不可达（500）：建条但 last_visit_at=null
  const failProbe = { result: "unreachable", detail: "http-status:500", at: 100, serverId: null, manifest: null };
  const r1 = await recordVisit(home, { server: origin, probe: failProbe }, { now: () => 100 });
  assert.equal(r1.created, true);
  assert.equal(r1.entry.first_visit_at, 100);
  assert.equal(r1.entry.last_visit_at, null, "从未 reachable");
  assert.deepEqual(r1.entry.last_probe, { result: "unreachable", detail: "http-status:500", at: 100 });
  assert.equal(r1.entry.note, null);

  // reachable：last_visit_at 刷新
  const okProbe = { result: "reachable", detail: null, at: 200, serverId: "ef".repeat(32), manifest: {} };
  const r2 = await recordVisit(home, { server: origin, probe: okProbe }, { now: () => 200 });
  assert.equal(r2.created, false);
  assert.equal(r2.entry.last_visit_at, 200);
  assert.equal(r2.entry.server_id, "ef".repeat(32));

  // 再不可达：last_probe 更新、last_visit_at 不回退
  const fail2 = { result: "unreachable", detail: "timeout", at: 300, serverId: null, manifest: null };
  const r3 = await recordVisit(home, { server: origin, probe: fail2 }, { now: () => 300 });
  assert.equal(r3.entry.last_visit_at, 200, "仅 reachable 刷新");
  assert.deepEqual(r3.entry.last_probe, { result: "unreachable", detail: "timeout", at: 300 });

  const book = await loadVisits(home);
  assert.equal(book.visits.length, 1, "键=server 唯一");
  const stat = await fsp.stat(path.join(home, "visits.json"));
  assert.equal(stat.mode & 0o777, 0o600);
});

// ---- relay 选择（preflight 冻结规则） ---------------------------------------------

test("selectRelayFromManifest: disabled/null/空串/错 scheme=无可用；重复条目取第一条合法者", () => {
  const sid = "ab".repeat(32);
  assert.equal(selectRelayFromManifest({ server_id: sid, services: [{ name: "relay", enabled: false, url: "http://127.0.0.1:3340" }] }).ok, false, "disabled");
  assert.equal(selectRelayFromManifest({ server_id: sid, services: [{ name: "relay", enabled: true, url: null }] }).ok, false, "url=null");
  assert.equal(selectRelayFromManifest({ server_id: sid, services: [{ name: "relay", enabled: true, url: "" }] }).ok, false, "空串");
  assert.equal(selectRelayFromManifest({ server_id: sid, services: [{ name: "relay", enabled: true, url: "ftp://127.0.0.1:3340" }] }).ok, false, "错 scheme");
  assert.equal(selectRelayFromManifest({ server_id: sid, services: [] }).ok, false, "无 relay 条目");
  assert.equal(selectRelayFromManifest({}).ok, false, "无 services 数组");
  assert.equal(selectRelayFromManifest("junk").ok, false, "非对象");
  // 非 relay 条目跳过；重复 relay：第一条合法者胜（错 scheme 的被跳过）
  const dup = selectRelayFromManifest({
    server_id: sid,
    services: [
      { name: "rendezvous", enabled: true, url: "http://127.0.0.1:8787/rendezvous" },
      { name: "relay", enabled: true, url: "ftp://bad" },
      { name: "relay", enabled: false, url: "http://127.0.0.1:1" },
      { name: "relay", enabled: true, url: "http://127.0.0.1:3340" },
      { name: "relay", enabled: true, url: "http://127.0.0.1:3341" },
    ],
  });
  assert.deepEqual(dup, { ok: true, url: "http://127.0.0.1:3340" }, "manifest 顺序第一条合法者");
  // https 合法
  assert.equal(selectRelayFromManifest({ services: [{ name: "relay", enabled: true, url: "https://relay.example.com" }] }).ok, true);
});

test("isLegalHttpUrl: 长度上限/反斜杠/unspecified host 拒绝", () => {
  assert.equal(isLegalHttpUrl("http://127.0.0.1:3340"), true);
  assert.equal(isLegalHttpUrl("https://relay.example.com"), true);
  assert.equal(isLegalHttpUrl("http://[fd00::1]:3340"), true);
  assert.equal(isLegalHttpUrl("ftp://127.0.0.1"), false);
  assert.equal(isLegalHttpUrl("not a url"), false);
  assert.equal(isLegalHttpUrl("http://"), false);
  assert.equal(isLegalHttpUrl("http://0.0.0.0:3340"), false, "unspecified v4");
  assert.equal(isLegalHttpUrl("http://[::]:3340"), false, "unspecified v6");
  assert.equal(isLegalHttpUrl(`http://example.com/${"a".repeat(2100)}`), false, "长度上限");
  assert.equal(isLegalHttpUrl("http://127.0.0.1\\@evil"), false, "反斜杠");
});

// ---- journal 小件 -----------------------------------------------------------------

test("admission journal: save/load/clear + 损坏检测", async () => {
  const home = await tmpHome();
  assert.equal((await loadAdmissionJournal(home)).journal, null);
  await saveAdmissionJournal(home, {
    server: "http://127.0.0.1:8787",
    code_hash: "22".repeat(32),
    fabric_id: FABRIC,
    root: ROOT,
    attempt: 2,
    last_error: "network",
    ts: 1758000000000,
  });
  const j = await loadAdmissionJournal(home);
  assert.equal(j.corrupt, false);
  assert.equal(j.journal?.attempt, 2);
  assert.equal(j.journal?.last_error, "network");
  const stat = await fsp.stat(path.join(home, "fabric-admission.json"));
  assert.equal(stat.mode & 0o777, 0o600);
  await clearAdmissionJournal(home);
  assert.equal((await loadAdmissionJournal(home)).journal, null);
  // 损坏=fail-closed 人工恢复（不猜）
  await fsp.writeFile(path.join(home, "fabric-admission.json"), "{{{");
  const broken = await loadAdmissionJournal(home);
  assert.equal(broken.corrupt, true);
  // 字段缺失同样按损坏
  await fsp.writeFile(path.join(home, "fabric-admission.json"), JSON.stringify({ server: "http://x" }));
  assert.equal((await loadAdmissionJournal(home)).corrupt, true);
});

