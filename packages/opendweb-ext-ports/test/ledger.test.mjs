// 账本纪律（design §2.3/§5：0600 原子写+锁家族；损坏 fail-closed）。
// 1. mappings.json/allowlist.json：0600 权限、锁释放（无残留 .lock）、无 .tmp
//    残留（原子写失败清理面）、字段集与校验；
// 2. 并行变更不丢更新（锁内重读→合并→写的核心价值）；
// 3. 损坏 JSON/形状 → fail-closed 抛错（不静默重置）；
// 4. 授权判定默认 deny + grant/revoke 幂等。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addMapping,
  allowlistPath,
  grantAccess,
  isAccessAllowed,
  loadAllowlist,
  loadMappings,
  mappingsPath,
  mutateMappings,
  removeMapping,
  revokeAccess,
  setMappingEnabled,
} from "../src/ledger.mjs";
import { tempHome } from "./helpers.mjs";

test("ledger: mappings roundtrip — fields frozen, 0600 mode, no tmp/lock residue", async (t) => {
  const home = await tempHome("wpk-ledger-");
  t.after(() => rm(home, { recursive: true, force: true }));

  const added = await addMapping(home, { name: "iMac 8080", peer: "peer-a-endpoint", remotePort: 8080, localPort: 9090 });
  assert.equal(added.ok, true);
  assert.ok(added.ok && added.mapping);
  const m = /** @type {any} */ (added).mapping;
  assert.match(m.id, /^m-[0-9a-z]{12}$/);
  assert.deepEqual(
    { name: m.name, peer: m.peer, remotePort: m.remotePort, localPort: m.localPort, enabled: m.enabled },
    { name: "iMac 8080", peer: "peer-a-endpoint", remotePort: 8080, localPort: 9090, enabled: true },
  );

  const ledger = await loadMappings(home);
  assert.equal(ledger.version, 1);
  assert.equal(ledger.mappings.length, 1);

  // 0600 权限（原子写纪律）
  const st = await stat(mappingsPath(home));
  assert.equal(st.mode & 0o777, 0o600, "mappings.json must be 0600");

  // 目录无 .tmp 残留、无 .lock 残留（锁释放干净）
  const dirEntries = await readdir(path.join(home, "plugins", "ports"));
  assert.equal(dirEntries.filter((f) => f.endsWith(".tmp")).length, 0, "no tmp residue");
  assert.equal(dirEntries.includes("mappings.lock"), false, "lock must be released");

  // 内容=合法 JSON 且形状精确（快照断言冻结字段集）
  const raw = JSON.parse(await readFile(mappingsPath(home), "utf8"));
  assert.deepEqual(Object.keys(raw), ["version", "mappings"]);
  assert.deepEqual(Object.keys(raw.mappings[0]).sort(), ["enabled", "id", "localPort", "name", "peer", "remotePort"]);
});

test("ledger: add validation rejects invalid input without writing", async (t) => {
  const home = await tempHome("wpk-ledger-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bad = await addMapping(home, { name: "", peer: "p", remotePort: 80, localPort: 90 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid");
  assert.equal((await loadMappings(home)).mappings.length, 0, "rejected input must not touch the ledger");
  for (const override of [{ remotePort: 0 }, { remotePort: 65536 }, { localPort: -1 }, { localPort: 1.5 }, { peer: "" }]) {
    const r = await addMapping(home, { name: "n", peer: "p", remotePort: 80, localPort: 9090, ...override });
    assert.equal(r.ok, false, `invalid input ${JSON.stringify(override)} must be rejected`);
  }
  assert.equal((await loadMappings(home)).mappings.length, 0);
});

test("ledger: parallel mutations lose no updates (lock + in-lock reread)", async (t) => {
  const home = await tempHome("wpk-ledger-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => addMapping(home, { name: `map-${i}`, peer: "peer-a", remotePort: 8000 + i, localPort: 9000 + i })),
  );
  // 锁协议（leases 家族）：竞争失败方短退避 ≤3 后以 {code:"lock"} 明确上报——
  // 不静默丢、不挂死；成功方互不覆盖（锁内重读→追加→写）
  const okCount = results.filter((r) => r.ok).length;
  const lockCount = results.filter((r) => !r.ok && /** @type {any} */ (r).code === "lock").length;
  assert.equal(okCount + lockCount, 8, "every parallel mutation either persists or reports lock contention");
  assert.ok(okCount >= 2, "retry budget lets most mutations through");
  const ledger = await loadMappings(home);
  assert.equal(ledger.mappings.length, okCount, "exactly the succeeded adds persist (no lost update, no dup)");
  const localPorts = new Set(ledger.mappings.map((m) => m.localPort));
  assert.equal(localPorts.size, okCount);
});

test("ledger: remove/setMappingEnabled semantics", async (t) => {
  const home = await tempHome("wpk-ledger-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const a = await addMapping(home, { name: "a", peer: "p", remotePort: 1, localPort: 2 });
  const b = await addMapping(home, { name: "b", peer: "p", remotePort: 3, localPort: 4 });
  assert.ok(a.ok && b.ok);

  const toggled = await setMappingEnabled(home, /** @type {any} */ (a).mapping.id, false);
  assert.equal(toggled.ok, true);
  assert.equal(/** @type {any} */ (toggled).mapping.enabled, false);

  const removed = await removeMapping(home, /** @type {any} */ (b).mapping.id);
  assert.equal(removed.ok, true);
  const missing = await removeMapping(home, "m-nonexistent");
  assert.equal(missing.ok, false);
  assert.equal(/** @type {any} */ (missing).code, "not-found");

  const ledger = await loadMappings(home);
  assert.equal(ledger.mappings.length, 1);
  assert.equal(ledger.mappings[0].enabled, false);
});

test("ledger: malformed ledger is fail-closed (no silent reset)", async (t) => {
  const home = await tempHome("wpk-ledger-");
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "plugins", "ports"), { recursive: true });
  await writeFile(mappingsPath(home), "{ not json", "utf8");
  await assert.rejects(() => loadMappings(home), /malformed/);

  await writeFile(mappingsPath(home), JSON.stringify({ version: 1, mappings: [{ id: "x", name: 1 }] }), "utf8");
  await assert.rejects(() => loadMappings(home), /malformed/);

  await writeFile(allowlistPath(home), "[]", "utf8");
  await assert.rejects(() => loadAllowlist(home), /malformed/); // 数组=形状非法（fail-closed）
});

test("ledger: allowlist — default deny, grant idempotent, revoke", async (t) => {
  const home = await tempHome("wpk-ledger-");
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await isAccessAllowed(home, "peer-b", 8080), false, "default deny");

  assert.ok((await grantAccess(home, "peer-b", 8080)).ok);
  assert.ok((await grantAccess(home, "peer-b", 8080)).ok, "grant is idempotent");
  assert.equal(await isAccessAllowed(home, "peer-b", 8080), true);
  assert.equal(await isAccessAllowed(home, "peer-b", 8081), false, "other port still denied");
  assert.equal(await isAccessAllowed(home, "peer-c", 8080), false, "other peer still denied");

  const st = await stat(allowlistPath(home));
  assert.equal(st.mode & 0o777, 0o600, "allowlist.json must be 0600");

  assert.ok((await revokeAccess(home, "peer-b", 8080)).ok);
  assert.equal(await isAccessAllowed(home, "peer-b", 8080), false);
});

test("ledger: mutateMappings surfaces lock contention as {ok:false,code:'lock'}", async () => {
  // 同进程锁冲突路径：持锁期间第二次 mutate 短退避后报 lock（不挂死不静默）
  const home = await tempHome("wpk-ledger-lock-");
  try {
    const first = await (await import("../src/fsutil.mjs")).acquireFileLock(path.join(home, "plugins", "ports", "mappings.lock"));
    assert.equal(first.ok, true);
    try {
      const r = await mutateMappings(home, () => {});
      assert.equal(r.ok, false);
      assert.equal(/** @type {any} */ (r).code, "lock");
    } finally {
      await /** @type {any} */ (first).release();
    }
    const after = await mutateMappings(home, () => {});
    assert.equal(after.ok, true, "lock released → next mutation succeeds");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ledger: isAccessAllowed normalizes hex/z32 peer encodings (same key, two forms)", async () => {
  // 真双机验收实证：账本存 hex64（控制面冻结形态），fabric 会话对端是 z32
  // 展示串——同钥异码必须命中授权（此前「已授权仍 403」）。
  const home = await tempHome("wpk-ledger-z32-");
  try {
    const hex = "ec80ba47821deba5019c2fee2ecab2ccdca81885dd8d61f9d67907463e2a879a";
    const z32 = hexToZ32Local(hex);
    assert.equal(z32, "71ymwthndzi4kychf9zn71i13uqkogrf5sgsd6qsxrdwcxtko6py", "ground-truth z32 pair");
    await grantAccess(home, hex, 8080);
    assert.equal(await isAccessAllowed(home, z32, 8080), true, "z32 peer matches hex ledger entry");
    assert.equal(await isAccessAllowed(home, hex, 8080), true, "hex peer matches hex ledger entry");
    assert.equal(await isAccessAllowed(home, hexToZ32Local("cb416b034d43f11ea2fd4862ea52e6044d91a7b06a4fa7066f68d8df847934b0"), 8080), false, "other peer still denied");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** 与 src/ledger.mjs normalizePeerId 的编码面同源向量的本地引用（roundtrip
 * 由 webui fabric-host 测试覆盖；此处只消费 ground-truth 对）。 */
function hexToZ32Local(hex) {
  const A = "ybndrfg8ejkmcpqxot1uwisza345h769";
  const bytes = Buffer.from(hex, "hex");
  let bits = 0;
  let value = 0n;
  let out = "";
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += A[Number((value >> BigInt(bits)) & 31n)];
      value = value % (1n << BigInt(bits));
    }
  }
  if (bits > 0) out += A[Number((value << BigInt(5 - bits)) & 31n)];
  return out;
}
