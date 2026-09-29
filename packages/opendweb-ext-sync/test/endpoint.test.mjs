// 对象端点测试（webui-plugin-kernel Phase 3 / design v2.3 §7.3——四操作+闭包
// 校验+CAS+超限+staging TTL+有界体+授权）。对应 Scenario：
// - 闭包缺失拒绝（r2-B7）：缺 parent/树/blob → 整 push 拒+缺项清单+ref 零变化；
// - CAS 并发（Q5）：expectedOldRef 不匹配 → 拒+提示重 fetch/merge；
// - 超限对象（r4-N3）：>16MiB blob → 引用它的整个 push 原子拒绝（部分对象
//   成功不构成合法实现）+其他 root 不受影响；
// - 显式中止与 staging 回收（r2-B7）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSyncEndpointHandler, MAX_OBJECT_BYTES, gcStaging, STAGING_TTL_MS } from "../src/endpoint.mjs";
import { createGroup } from "../src/ledger.mjs";
import { gitdirFor } from "../src/ledger.mjs";
import { writeObject, writeTreeFromFlat, writeCommitOid, writeRef, readRef, readObject, GROUP_REF, deviceRef, listRefsDirect } from "../src/objects.mjs";
import { toBase64 } from "../src/util.mjs";

const EP_A = "aa11aa22aa33aa44aa55aa66aa77aa88";
const EP_B = "bb11bb22bb33bb44bb55bb66bb77bb88";
const EP_X = "cc11cc22cc33cc44cc55cc66cc77cc88"; // 非成员

async function setup(name, extraRoots = false) {
  const home = await mkdtemp(path.join(tmpdir(), `dweb-ep-${name}-`));
  const rootA = path.join(home, "rootA");
  const rootB = path.join(home, "rootB");
  await mkdir(rootA, { recursive: true });
  const roots = [{ id: "r1", localPath: rootA, mode: "twoway", seedAuthority: EP_A }];
  if (extraRoots) {
    await mkdir(rootB, { recursive: true });
    roots.push({ id: "r2", localPath: rootB, mode: "twoway", seedAuthority: EP_A });
  }
  const g = await createGroup(home, { id: "g1", name: "g1", members: [{ endpointId: EP_A, deviceName: "a" }, { endpointId: EP_B, deviceName: "b" }], roots });
  assert.ok(g.ok);
  const now = (() => {
    let t = 1_700_000_000_000;
    return () => (t += 1000);
  })();
  const handler = createSyncEndpointHandler({ home, now });
  return { home, handler, now, rootA };
}

/**
 * push 请求体（ndjson 帧）。
 * @param {{ ref: string, expectedOldRef: string | null, targetCommit: string }} header
 * @param {Array<{ oid: string, type: string, bytes: Uint8Array }>} objects
 */
function pushBody(header, objects) {
  const lines = [Buffer.from(`${JSON.stringify(header)}\n`)];
  for (const o of objects) lines.push(Buffer.from(`${JSON.stringify({ oid: o.oid, type: o.type, length: o.bytes.byteLength, contentBase64: toBase64(o.bytes) })}\n`));
  return new Uint8Array(Buffer.concat(lines));
}

/** 造一条两 commit 链（c1←c2，各带树与 blob）。 */
async function chain(gitdir) {
  const b1 = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from("v1\n")));
  const b2 = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from("v2\n")));
  const t1 = await writeTreeFromFlat(gitdir, [{ path: "a.txt", oid: b1, mode: "100644" }]);
  const t2 = await writeTreeFromFlat(gitdir, [{ path: "a.txt", oid: b2, mode: "100644" }]);
  const c1 = await writeCommitOid(gitdir, { message: "c1", tree: t1, parent: [], authorName: "a", authorEmail: "a@a", timestamp: 1 });
  const c2 = await writeCommitOid(gitdir, { message: "c2", tree: t2, parent: [c1], authorName: "a", authorEmail: "a@a", timestamp: 2 });
  return { b1, b2, t1, t2, c1, c2 };
}

/** 读全对象（push 载荷用）。 @param {string} gitdir @param {string[]} oids */
async function readAll(gitdir, oids) {
  const { readObject } = await import("../src/objects.mjs");
  const out = [];
  for (const oid of oids) {
    const { type, bytes } = await readObject(gitdir, oid);
    out.push({ oid, type, bytes });
  }
  return out;
}

async function call(handler, method, p, { body = null, peer = EP_B } = {}) {
  const resp = await handler({ method, path: p, body, sessionId: "s-test", peerEndpointId: peer });
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(resp.body).toString("utf8"));
  } catch {
    /* keep null */
  }
  return { status: resp.status, body: parsed };
}

test("GET refs / POST want / GET object round-trip with paging semantics", async () => {
  const { home, handler } = await setup("wire");
  const gitdir = gitdirFor(home, "g1", "r1");
  const ch = await chain(gitdir);
  await writeRef(gitdir, GROUP_REF, ch.c2);
  const refsResp = await call(handler, "GET", "/wpk1/sync/g1/r1/refs");
  assert.equal(refsResp.status, 200);
  assert.deepEqual(refsResp.body.refs, { [GROUP_REF]: ch.c2 });
  // want：已有 b1/t1 → 缺 c2+b2+t2？闭包(c2)={c2,c1,t2,b2,t1,b1}；have 含全部则空
  const haveAll = [ch.c1, ch.c2, ch.t1, ch.t2, ch.b1, ch.b2];
  const full = await call(handler, "POST", "/wpk1/sync/g1/r1/want", { body: Buffer.from(JSON.stringify({ commit: ch.c2, have: haveAll })) });
  assert.equal(full.body.missing.length, 0);
  const none = await call(handler, "POST", "/wpk1/sync/g1/r1/want", { body: Buffer.from(JSON.stringify({ commit: ch.c2, have: [] })) });
  assert.equal(none.body.missing.length, 6, "full closure of c2");
  // 分页语义：R_i=closure−page_i，真缺失=∩R_i（have 不含 b2——缺 b2 一项）
  const have = [ch.c1, ch.c2, ch.t1, ch.t2, ch.b1];
  const page1 = await call(handler, "POST", "/wpk1/sync/g1/r1/want", { body: Buffer.from(JSON.stringify({ commit: ch.c2, have: have.slice(0, 3) })) });
  const page2 = await call(handler, "POST", "/wpk1/sync/g1/r1/want", { body: Buffer.from(JSON.stringify({ commit: ch.c2, have: have.slice(3) })) });
  const m1 = new Set(page1.body.missing.map((m) => m.oid));
  const m2 = new Set(page2.body.missing.map((m) => m.oid));
  const inter = [...m1].filter((o) => m2.has(o));
  assert.deepEqual(inter, [ch.b2], "page-intersection yields exact missing set");
  // GET object：类型+长度+OID 自证
  const obj = await call(handler, "GET", `/wpk1/sync/g1/r1/object/${ch.b2}`);
  assert.equal(obj.status, 200);
  assert.equal(obj.body.type, "blob");
  assert.equal(obj.body.length, 3);
  assert.equal(Buffer.from(obj.body.contentBase64, "base64").toString("utf8"), "v2\n");
  await rm(home, { recursive: true, force: true });
});

test("Scenario: closure-missing rejection (parent/tree/blob) -> whole push rejected, missing list, ref zero change", async () => {
  const { home, handler } = await setup("closure");
  const gd = gitdirFor(home, "g1", "r1"); // 端点对象库（被测方）
  const gdA = await mkdtemp(path.join(tmpdir(), "dweb-ep-closure-src-")); // 构链源库（独立——删端点对象不影响源）
  const ch = await chain(gdA);
  // 端点库预置完整闭包，然后分别制造「缺 parent」「缺 blob」的 push
  for (const oid of [ch.c1, ch.t1, ch.b1, ch.t2, ch.c2]) {
    const { type, bytes } = await readObject(gdA, oid);
    await writeObject(gd, type, bytes);
  }
  // 1) 缺 parent：push c3（parent=c2），并从端点库删掉 c2 模拟缺 parent
  const b3 = await writeObject(gdA, "blob", new Uint8Array(Buffer.from("v3\n")));
  const t3 = await writeTreeFromFlat(gdA, [{ path: "a.txt", oid: b3, mode: "100644" }]);
  const c3 = await writeCommitOid(gdA, { message: "c3", tree: t3, parent: [ch.c2], authorName: "a", authorEmail: "a@a", timestamp: 3 });
  const { rm: rmf } = await import("node:fs/promises");
  await rmf(path.join(gd, "objects", ch.c2.slice(0, 2), ch.c2.slice(2)), { force: true }); // 从端点库删 parent
  const pushNoParent = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: c3 }, await readAll(gdA, [c3, t3, b3])) });
  assert.equal(pushNoParent.status, 409);
  assert.equal(pushNoParent.body.code, "closure-missing");
  assert.ok(pushNoParent.body.missing.includes(ch.c2), "missing list names the absent parent commit");
  assert.equal(await readRef(gd, GROUP_REF), null, "ref zero change");
  // 2) 缺 blob：带上 parent 闭包但漏 b2
  await writeObject(gd, "commit", (await readObject(gdA, ch.c2)).bytes); // 恢复 c2（无 b2/t2）
  const pushNoBlob = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch.c2 }, await readAll(gdA, [ch.c2, ch.t2])) });
  assert.equal(pushNoBlob.body.code, "closure-missing");
  assert.ok(pushNoBlob.body.missing.includes(ch.b2), "missing list names the absent blob");
  assert.equal(await readRef(gd, GROUP_REF), null, "ref still zero after second rejection");
  // 对象库零新增副作用（部分对象成功不构成合法实现——被拒对象不入库）
  const { hasObject } = await import("../src/objects.mjs");
  assert.equal(await hasObject(gd, b3), false, "rejected push must not import objects");
  // 3) 完整闭包 → 成功
  const okPush = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch.c2 }, await readAll(gdA, [ch.c2, ch.t2, ch.b2])) });
  assert.equal(okPush.status, 200, JSON.stringify(okPush.body));
  assert.equal(await readRef(gd, GROUP_REF), ch.c2);
  await rm(home, { recursive: true, force: true });
});

test("Scenario: CAS mismatch rejects push and prompts refetch; correct expectedOldRef succeeds", async () => {
  const { home, handler } = await setup("cas");
  const gd = gitdirFor(home, "g1", "r1");
  const ch = await chain(gd);
  // 直接在端点库上推进（模拟对端已收敛到 c1）
  await writeRef(gd, GROUP_REF, ch.c1);
  const stale = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch.c2 }, await readAll(gd, [ch.c2, ch.t2, ch.b2])) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "cas-mismatch");
  assert.equal(stale.body.currentRef, ch.c1, "rejection carries current ref for refetch");
  assert.match(stale.body.hint, /re-fetch and merge/);
  assert.equal(await readRef(gd, GROUP_REF), ch.c1, "no last-write-wins: ref untouched");
  const good = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: ch.c1, targetCommit: ch.c2 }, await readAll(gd, [ch.c2, ch.t2, ch.b2])) });
  assert.equal(good.status, 200);
  assert.equal(await readRef(gd, GROUP_REF), ch.c2);
  await rm(home, { recursive: true, force: true });
});

test("Scenario: oversize blob (>16MiB) -> whole push rejected atomically; other root unaffected; later clean push works", async () => {
  const { home, handler } = await setup("oversize", true);
  const gd = gitdirFor(home, "g1", "r1");
  const gd2 = gitdirFor(home, "g1", "r2");
  const ch = await chain(gd);
  const big = Buffer.alloc(MAX_OBJECT_BYTES + 1, 0x41);
  const bigOid = await writeObject(gd, "blob", big);
  const tBig = await writeTreeFromFlat(gd, [
    { path: "a.txt", oid: ch.b2, mode: "100644" },
    { path: "big.bin", oid: bigOid, mode: "100644" },
  ]);
  const cBig = await writeCommitOid(gd, { message: "big", tree: tBig, parent: [ch.c1], authorName: "a", authorEmail: "a@a", timestamp: 3 });
  const push = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: cBig }, await readAll(gd, [cBig, tBig, bigOid, ch.c2, ch.t2])) });
  assert.equal(push.status, 413);
  assert.equal(push.body.code, "oversize");
  assert.equal(push.body.size, MAX_OBJECT_BYTES + 1);
  assert.match(push.body.hint, /rejected as a whole/);
  assert.equal(await readRef(gd, GROUP_REF), null, "ref zero change");
  // 其他同步根不受影响（r2 正常 push 成功）
  const ch2 = await chain(gd2);
  const push2 = await call(handler, "POST", "/wpk1/sync/g2/r2/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch2.c2 }, await readAll(gd2, [ch2.c2, ch2.t2, ch2.b2])) }).catch(async (e) => {
    return e; // g2 不存在——应 404 而非崩溃；改用 g1/r2
  });
  assert.equal(push2.status, 404, "unknown group is a clean 404");
  const push3 = await call(handler, "POST", "/wpk1/sync/g1/r2/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch2.c2 }, await readAll(gd2, [ch2.c2, ch2.t2, ch2.b2])) });
  assert.equal(push3.status, 200, "independent root unaffected");
  // 后续不含该 blob 的 commit 可继续（r1 push c2 成功）
  const push4 = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch.c2 }, await readAll(gd, [ch.c2, ch.t2, ch.b2])) });
  assert.equal(push4.status, 200, "later commit not referencing the blob proceeds");
  // GET object 也拒绝超限对象（单传上限）
  const getBig = await call(handler, "GET", `/wpk1/sync/g1/r1/object/${bigOid}`);
  assert.equal(getBig.status, 413);
  await rm(home, { recursive: true, force: true });
});

test("authorization: non-member peer denied (deny-by-default); malformed requests rejected", async () => {
  const { home, handler } = await setup("auth");
  const denied = await call(handler, "GET", "/wpk1/sync/g1/r1/refs", { peer: EP_X });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "unauthorized");
  const noPeerRaw = await handler({ method: "GET", path: "/wpk1/sync/g1/r1/refs", body: null, sessionId: "s", peerEndpointId: undefined });
  const noPeer = { status: noPeerRaw.status, body: JSON.parse(Buffer.from(noPeerRaw.body).toString("utf8")) };
  assert.equal(noPeer.status, 403, "missing peer identity = deny");
  const unknownGroup = await call(handler, "GET", "/wpk1/sync/gx/r1/refs");
  assert.equal(unknownGroup.status, 404);
  const badWant = await call(handler, "POST", "/wpk1/sync/g1/r1/want", { body: Buffer.from("not json") });
  assert.equal(badWant.status, 400);
  const badObj = await call(handler, "GET", "/wpk1/sync/g1/r1/object/zzz");
  assert.equal(badObj.status, 400);
  await rm(home, { recursive: true, force: true });
});

test("bounded body: oversize request body rejected incrementally (413-equivalent), stream stops early", async () => {
  const { home, handler } = await setup("body");
  let consumed = 0;
  const chunks = Array.from({ length: 40 }, () => new Uint8Array(1024 * 1024)); // 40MiB 流
  const stream = (async function* () {
    for (const c of chunks) {
      consumed += 1;
      yield c;
    }
  })();
  const resp = await call(handler, "POST", "/wpk1/sync/g1/r1/want", { body: stream });
  assert.equal(resp.status, 413);
  assert.equal(resp.body.code, "body-too-large");
  assert.ok(consumed < chunks.length, `stream must stop early (consumed ${consumed}/${chunks.length})`);
  await rm(home, { recursive: true, force: true });
});

test("Scenario: aborted push leaves no staging residue after TTL; retry from scratch is idempotent", async () => {
  const { home, handler, now } = await setup("abort");
  const gd = gitdirFor(home, "g1", "r1");
  const ch = await chain(gd);
  // 传输中途 abort：body 流在若干对象后抛 AbortError
  const objects = await readAll(gd, [ch.c2, ch.t2, ch.b2, ch.c1, ch.t1, ch.b1]);
  const lines = [Buffer.from(`${JSON.stringify({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch.c2 })}\n`)];
  for (const o of objects) lines.push(Buffer.from(`${JSON.stringify({ oid: o.oid, type: o.type, length: o.bytes.byteLength, contentBase64: toBase64(o.bytes) })}\n`));
  const all = Buffer.concat(lines);
  const cut = Math.floor(all.length * 0.4);
  const aborted = (async function* () {
    yield all.subarray(0, cut);
    throw new Error("aborted: session disconnected");
  })();
  const resp = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: aborted });
  assert.notEqual(resp.status, 200);
  assert.equal(await readRef(gd, GROUP_REF), null, "ref zero change on abort");
  // staging 残留 → TTL 回收（注入 now 推进 TTL）；回收后 staging 根为空
  const stagingDir = path.join(gd, "staging");
  const { readdir } = await import("node:fs/promises");
  const residue = (await readdir(stagingDir).catch(() => []));
  const removed = await gcStaging(gd, { now: () => now() + STAGING_TTL_MS + 1000 });
  const afterGc = await readdir(stagingDir).catch(() => []);
  assert.equal(afterGc.length, 0, `staging root must be empty after TTL GC (residue was ${residue.length}, removed ${removed.length})`);
  const removed2 = await gcStaging(gd, { now: () => now() + STAGING_TTL_MS * 2 });
  assert.equal(removed2.length, 0, "second GC finds nothing (already reclaimed)");
  // 从头幂等重算：完整重推成功
  const retry = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch.c2 }, objects) });
  assert.equal(retry.status, 200, "retry from scratch succeeds with no partial state");
  assert.equal(await readRef(gd, GROUP_REF), ch.c2);
  await rm(home, { recursive: true, force: true });
});

test("push object count budget (>5000) rejected with explicit code", async () => {
  const { home, handler } = await setup("budget");
  const gd = gitdirFor(home, "g1", "r1");
  const ch = await chain(gd);
  const objects = await readAll(gd, [ch.c2, ch.t2, ch.b2]);
  // 追加 4998 个合法小对象（超 MAX_OBJECTS_PER_SYNC=5000）
  const lines = [Buffer.from(`${JSON.stringify({ ref: GROUP_REF, expectedOldRef: null, targetCommit: ch.c2 })}\n`)];
  for (const o of objects) lines.push(Buffer.from(`${JSON.stringify({ oid: o.oid, type: o.type, length: o.bytes.byteLength, contentBase64: toBase64(o.bytes) })}\n`));
  for (let i = 0; i < 4998; i++) {
    const bytes = new Uint8Array(Buffer.from(`pad-${i}\n`));
    const { objectOid } = await import("../src/objects.mjs");
    lines.push(Buffer.from(`${JSON.stringify({ oid: objectOid("blob", bytes), type: "blob", length: bytes.byteLength, contentBase64: toBase64(bytes) })}\n`));
  }
  const resp = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: new Uint8Array(Buffer.concat(lines)) });
  assert.equal(resp.status, 429);
  assert.equal(resp.body.code, "budget");
  assert.equal(await readRef(gd, GROUP_REF), null);
  await rm(home, { recursive: true, force: true });
});
