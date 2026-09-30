// 对象端点测试（webui-plugin-kernel Phase 3 / design v2.3 §7.3——四操作+闭包
// 校验+CAS+超限+staging TTL+有界体+授权）。对应 Scenario：
// - 闭包缺失拒绝（r2-B7）：缺 parent/树/blob → 整 push 拒+缺项清单+ref 零变化；
// - CAS 并发（Q5）：expectedOldRef 不匹配 → 拒+提示重 fetch/merge；
// - 超限对象（r4-N3）：>16MiB blob → 引用它的整个 push 原子拒绝（部分对象
//   成功不构成合法实现）+其他 root 不受影响；
// - 显式中止与 staging 回收（r2-B7）；
// - r7-B3 四用例：解析完成后 abort（裁决点 #1）/ CAS 前 abort（提交线性化点
//   裁决 #3）/ 第三个并发 push 组级 429 / 进程崩溃（kill 模拟）后真实 staging
//   文件的 TTL GC + 幂等重试 roll-forward。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSyncEndpointHandler, MAX_OBJECT_BYTES, gcStaging, STAGING_TTL_MS } from "../src/endpoint.mjs";
import { createGroup } from "../src/ledger.mjs";
import { gitdirFor } from "../src/ledger.mjs";
import { writeObject, writeTreeFromFlat, writeCommitOid, writeRef, readRef, readObject, hasObject, GROUP_REF, deviceRef, listRefsDirect } from "../src/objects.mjs";
import { toBase64, createMutex, CrashInjection } from "../src/util.mjs";

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

// 真双机验收 F-sync（2026-09-30）：fabric 会话 peer 是 z32 展示串、组账本成员
// 登记 hex64（server 租约冻结形态）——同钥异码必须归一后再比（与 ext-files F1
// 同族）。同钥对为 SDK ground-truth（第五批验收 §0 实测校准）。
const Z32_MINI = "71ymwthndzi4kychf9zn71i13uqkogrf5sgsd6qsxrdwcxtko6py";
const HEX_MINI = "ec80ba47821deba5019c2fee2ecab2ccdca81885dd8d61f9d67907463e2a879a";
const Z32_IMAC = "3pyssy4pexat7ez7jbtqwwzgytg3dj7opj84qbuxpdcp9bd3g1ay";
const HEX_IMAC = "cb416b034d43f11ea2fd4862ea52e6044d91a7b06a4fa7066f68d8df847934b0";

test("authorization: z32 wire peer is equivalent to hex64 member registration (same-key dual-encoding)", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dweb-ep-authz32-"));
  const rootA = path.join(home, "rootA");
  await mkdir(rootA, { recursive: true });
  // 账本成员按 hex64 登记（server 租约冻结形态）
  const g = await createGroup(home, {
    id: "g1",
    name: "g1",
    members: [
      { endpointId: HEX_MINI, deviceName: "mini" },
      { endpointId: HEX_IMAC, deviceName: "imac" },
    ],
    roots: [{ id: "r1", localPath: rootA, mode: "twoway", seedAuthority: HEX_IMAC }],
  });
  assert.ok(g.ok, JSON.stringify(g));
  const handler = createSyncEndpointHandler({ home, now: () => 1_700_000_000_000 });
  const gitdir = gitdirFor(home, "g1", "r1");
  const ch = await chain(gitdir);
  await writeRef(gitdir, GROUP_REF, ch.c2);

  // z32 wire peer（fabric 会话真实形态）对 hex 成员账本 → 200（修复前恒 403）
  const viaZ32 = await call(handler, "GET", "/wpk1/sync/g1/r1/refs", { peer: Z32_MINI });
  assert.equal(viaZ32.status, 200, JSON.stringify(viaZ32));
  assert.deepEqual(viaZ32.body.refs, { [GROUP_REF]: ch.c2 });

  // hex wire peer（测试/本机形态）不受影响 → 200
  const viaHex = await call(handler, "GET", "/wpk1/sync/g1/r1/refs", { peer: HEX_MINI });
  assert.equal(viaHex.status, 200);

  // 异钥 z32 → 仍拒（归一只做同钥等价，不做兜底放行）
  const strangerZ32 = Z32_MINI.slice(0, -1) + (Z32_MINI.endsWith("a") ? "y" : "a");
  const denied = await call(handler, "GET", "/wpk1/sync/g1/r1/refs", { peer: strangerZ32 });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "unauthorized");
  // 未知形态（非 z32 非 hex）→ 拒
  const deniedJunk = await call(handler, "GET", "/wpk1/sync/g1/r1/refs", { peer: "not-a-key" });
  assert.equal(deniedJunk.status, 403);

  // push 路径同享归一：z32 wire peer 推对端 device ref（hex 命名白名单不受影响）
  const push = await call(handler, "POST", "/wpk1/sync/g1/r1/push", {
    peer: Z32_IMAC,
    body: pushBody({ ref: deviceRef(HEX_IMAC), expectedOldRef: null, targetCommit: ch.c1 }, await readAll(gitdir, [ch.c1, ch.t1, ch.b1])),
  });
  assert.equal(push.status, 200, JSON.stringify(push));
  assert.equal(await readRef(gitdir, deviceRef(HEX_IMAC)), ch.c1);
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

// ---- r7-B3 四用例（取消线性化 / 组级并发预算 / 持久 staging） ----

/**
 * 独立源库造链（端点对象库保持空——「store clean/import 生效」断言才有区分度；
 * push 体须含全闭包 6 对象）。返回 { src, objects, c2 }；调用方负责 rm(src)。
 * @param {string} home（仅用于命名 tmp）
 */
async function freshChain(home) {
  const src = await mkdtemp(path.join(tmpdir(), `dweb-ep-${path.basename(home)}-src-`));
  const ch = await chain(src);
  const objects = await readAll(src, [ch.c2, ch.t2, ch.b2, ch.c1, ch.t1, ch.b1]);
  return { src, objects, c2: ch.c2 };
}

/** 直调 handler（带 signal，绕过 call() 助手——它不传 signal）。 */
async function callSignal(handler, p, { body, signal, peer = EP_B }) {
  const resp = await handler({ method: "POST", path: p, body, signal, sessionId: "s-test", peerEndpointId: peer });
  return { status: resp.status, body: JSON.parse(Buffer.from(resp.body).toString("utf8")) };
}

test("r7-B3 case 1: abort after body fully parsed -> aborted, zero ref/store change, staging reclaimed, budget released", async () => {
  const { home, handler } = await setup("abort-parsed");
  const gd = gitdirFor(home, "g1", "r1");
  const { src, objects, c2 } = await freshChain(home); // 端点库空——store 断言有区分度
  const body = pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: c2 }, objects);
  // 体完整送达后（全部行已产出=解析完成时点）、任何落库动作前触发 abort：
  // 生成器在产出末 chunk 后的恢复点同步 abort——读取器在末次拉取/收尾时观察到
  const controller = new AbortController();
  const stream = (async function* () {
    yield body;
    controller.abort();
  })();
  const resp = await callSignal(handler, "/wpk1/sync/g1/r1/push", { body: stream, signal: controller.signal });
  assert.equal(resp.status, 400);
  assert.equal(resp.body.code, "aborted");
  assert.equal(await readRef(gd, GROUP_REF), null, "ref zero change");
  for (const o of objects) assert.equal(await hasObject(gd, o.oid), false, `store clean (import never ran): ${o.oid}`);
  assert.equal((await readdir(path.join(gd, "staging")).catch(() => [])).length, 0, "staging reclaimed immediately (no TTL needed)");
  // 预算已归还（finally）：随后完整 push 成功
  const retry = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: c2 }, objects) });
  assert.equal(retry.status, 200, "budget released after abort (retry not busy)");
  await rm(src, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("r7-B3 case 2: abort before CAS (queued at repo mutex) -> rejected at commit-point adjudication, zero ref/store change", async () => {
  const { home } = await setup("abort-cas");
  const gd = gitdirFor(home, "g1", "r1");
  const { src, objects, c2 } = await freshChain(home);
  const mutex = createMutex();
  const handler = createSyncEndpointHandler({ home, now: () => 1, repoMutexFor: () => mutex });
  // 占住临界区：push 完成解析/staging/闭包后在 mutex 排队（过裁决 #1/#2）
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const hold = mutex.run("hold", async () => {
    await gate;
  });
  const controller = new AbortController();
  const pushP = (async () => handler({ method: "POST", path: "/wpk1/sync/g1/r1/push", body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: c2 }, objects), sessionId: "s", peerEndpointId: EP_B, signal: controller.signal }))();
  await new Promise((r) => setTimeout(r, 150)); // 排队等锁（过 #1/#2，卡在临界区前）
  controller.abort(); // 严格在放锁前 → 线性化点首句必然观察到 aborted
  // 放锁前 push 不得先行返回（若被 #1/#2 提前拒绝，会在 abort 时立刻 settle——
  // 仍属零变化；但本用例锁定的是「CAS 前排队窗口」的裁决 #3）
  const settledEarly = await Promise.race([Promise.resolve(pushP).then(() => true), new Promise((r) => setTimeout(() => r(false), 30))]);
  assert.equal(settledEarly, false, "push stays queued at mutex until lock release (abort lands in the pre-CAS window)");
  release();
  await hold;
  const resp = await pushP;
  const parsed = JSON.parse(Buffer.from(resp.body).toString("utf8"));
  assert.equal(resp.status, 400);
  assert.equal(parsed.code, "aborted");
  assert.equal(parsed.stage, "commit-point", "rejected by the linearization-point adjudication");
  assert.equal(await readRef(gd, GROUP_REF), null, "ref zero change");
  for (const o of objects) assert.equal(await hasObject(gd, o.oid), false, "store clean (import never ran)");
  assert.equal((await readdir(path.join(gd, "staging")).catch(() => [])).length, 0, "staging reclaimed");
  await rm(src, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("r7-B3 case 3: group stream budget includes push — third concurrent push gets busy 429; budget returned in finally", async () => {
  const { home, handler } = await setup("budget-push");
  const gd = gitdirFor(home, "g1", "r1");
  const { src, objects, c2 } = await freshChain(home);
  // 两个门控 push：body 生成器挂起 → 两条在飞流占满组级预算（≤2）
  let entered = 0;
  let open;
  const gate = new Promise((r) => {
    open = r;
  });
  const gatedBody = (ref) =>
    (async function* () {
      entered += 1;
      await gate;
      yield pushBody({ ref, expectedOldRef: null, targetCommit: c2 }, objects);
    })();
  const req = (body) => ({ method: "POST", path: "/wpk1/sync/g1/r1/push", body, sessionId: "s", peerEndpointId: EP_B });
  const p1 = handler(req(gatedBody(deviceRef(EP_A))));
  const p2 = handler(req(gatedBody(deviceRef(EP_B))));
  const deadline = Date.now() + 5000;
  while (entered < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(entered, 2, "both gated pushes started consuming (budget acquired before body read)");
  // 第三个并发 push：组级预算占满 → 稳定 429 busy（push 也占流预算）
  const third = await handler(req(pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: c2 }, objects)));
  const thirdParsed = JSON.parse(Buffer.from(third.body).toString("utf8"));
  assert.equal(third.status, 429);
  assert.equal(thirdParsed.code, "busy");
  assert.equal(thirdParsed.limit, 2);
  assert.equal(await readRef(gd, GROUP_REF), null, "third push rejected before consuming anything");
  open();
  const [r1, r2] = [await p1, await p2];
  const p1Parsed = JSON.parse(Buffer.from(r1.body).toString("utf8"));
  const p2Parsed = JSON.parse(Buffer.from(r2.body).toString("utf8"));
  assert.equal(p1Parsed.ok, true);
  assert.equal(p2Parsed.ok, true);
  assert.equal(await readRef(gd, deviceRef(EP_A)), c2);
  assert.equal(await readRef(gd, deviceRef(EP_B)), c2);
  // 预算已在 finally 归还：后续 push 不再 busy
  const after = await call(handler, "POST", "/wpk1/sync/g1/r1/push", { body: pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: c2 }, objects) });
  assert.equal(after.status, 200, "budget fully released after both pushes complete");
  await rm(src, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("r7-B3 case 4: simulated process crash -> real staging files persist, ref untouched, TTL GC reclaims, retry rolls forward idempotently", async () => {
  const { home } = await setup("crash");
  const gd = gitdirFor(home, "g1", "r1");
  const { src, objects, c2 } = await freshChain(home);
  const fullBody = () => pushBody({ ref: GROUP_REF, expectedOldRef: null, targetCommit: c2 }, objects);
  const req = () => ({ method: "POST", path: "/wpk1/sync/g1/r1/push", body: fullBody(), sessionId: "s", peerEndpointId: EP_B });
  const parse = (resp) => ({ status: resp.status, body: JSON.parse(Buffer.from(resp.body).toString("utf8")) });

  // -- 边界 1：全部对象已落 staging、闭包已过、临界区导入前 kill（push:staged） --
  let crashed1 = false;
  const h1 = createSyncEndpointHandler({
    home,
    now: () => 1,
    crashAt: (stage) => {
      if (stage === "push:staged" && !crashed1) {
        crashed1 = true;
        throw new CrashInjection(stage);
      }
    },
  });
  const resp1 = parse(await h1(req()));
  assert.equal(resp1.status, 500, "kill simulation surfaces as internal (process-death analogue)");
  // staging 留下的是**真实对象文件**（非空壳）：每对象一个文件、字节可验
  const stagingRoot = path.join(gd, "staging");
  const entries1 = await readdir(stagingRoot).catch(() => []);
  assert.equal(entries1.length, 1, "crash leaves exactly one staging scene");
  const scene1 = path.join(stagingRoot, entries1[0]);
  const stagedFiles = (await readdir(scene1)).sort();
  assert.deepEqual(stagedFiles, objects.map((o) => o.oid).sort(), "every verified object staged as a real file");
  for (const o of objects) {
    const raw = await readFile(path.join(scene1, o.oid));
    assert.ok(Buffer.compare(Buffer.from(raw), Buffer.from(o.bytes)) === 0, `staged bytes intact: ${o.oid}`);
  }
  assert.equal(await readRef(gd, GROUP_REF), null, "ref zero change after crash");
  for (const o of objects) assert.equal(await hasObject(gd, o.oid), false, "object store clean (crash before import — no half-write)");
  // TTL GC 回收崩溃现场
  const removed1 = await gcStaging(gd, { now: () => Date.now() + STAGING_TTL_MS + 1000 });
  assert.deepEqual(removed1, entries1, "GC reclaims the crashed staging scene");
  assert.equal((await readdir(stagingRoot).catch(() => [])).length, 0, "staging root empty after GC");

  // -- 边界 2：对象已原子入库、writeRef 前 kill（push:imported）——roll-forward 语义 --
  let crashed2 = false;
  const h2 = createSyncEndpointHandler({
    home,
    now: () => 2,
    crashAt: (stage) => {
      if (stage === "push:imported" && !crashed2) {
        crashed2 = true;
        throw new CrashInjection(stage);
      }
    },
  });
  const resp2 = parse(await h2(req()));
  assert.equal(resp2.status, 500);
  assert.equal(await readRef(gd, GROUP_REF), null, "ref still zero (crash before writeRef)");
  for (const o of objects) {
    assert.equal(await hasObject(gd, o.oid), true, `import completed atomically before crash: ${o.oid}`);
    const back = await readObject(gd, o.oid);
    assert.ok(Buffer.compare(Buffer.from(back.bytes), Buffer.from(o.bytes)) === 0, "imported object is complete and readable (no half-write)");
  }
  await gcStaging(gd, { now: () => Date.now() + STAGING_TTL_MS + 1000 });
  // 重试（crashAt 一次性已消耗）：幂等 roll-forward——已导入对象跳过、CAS 过、ref 推进
  const retry = parse(await h2(req()));
  assert.equal(retry.status, 200, "retry rolls forward idempotently (no partial state)");
  assert.equal(await readRef(gd, GROUP_REF), c2);
  await rm(src, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

// ---- cosmetic（2026-09-30）：staging 空壳即时回收 ------------------------------------

test("gcStaging reclaims empty shells immediately; objectful dirs wait for TTL", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "dweb-gc-shell-"));
  const gd = path.join(base, "git");
  const staging = path.join(gd, "staging");
  await mkdir(path.join(staging, "empty-shell"), { recursive: true });
  await mkdir(path.join(staging, "crash-site"), { recursive: true });
  await writeFile(path.join(staging, "crash-site", "00object"), "x");
  const removed = await gcStaging(gd, { now: () => Date.now() });
  assert.deepEqual(removed, ["empty-shell"], "0-object shells have nothing to recover — reclaim without waiting for TTL");
  const left = await readdir(staging);
  assert.deepEqual(left, ["crash-site"], "objectful crash sites survive until TTL");
  const removedTtl = await gcStaging(gd, { now: () => Date.now() + STAGING_TTL_MS + 1000 });
  assert.deepEqual(removedTtl, ["crash-site"], "TTL still governs objectful dirs");
  await rm(base, { recursive: true, force: true });
});
