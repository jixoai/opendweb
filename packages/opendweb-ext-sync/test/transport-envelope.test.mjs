// 分层 transport 包络测试（webui-plugin-kernel r8-B4 最小清单第 3 项）。
// 共享替身：packages/webui/test/plugin-transport-double.mjs——真实建立
// 1MiB 帧（session.rs MAX_FRAME）/ 2MiB 流（JournalLimits.max_stream_bytes）/
// 8MiB 会话（max_session_bytes，响应读尽释放）三层账；单机 loopback 不再
// 绕过真双机才会暴露的包络失败（第六/七批实录：>1MiB 帧失败、>2MiB 流失败、
// >8MiB 会话失败）。
// 本文件覆盖 sync 面四组事实：
// 1. 恰 1MiB blob 的闭包 push（wire≈1.4MiB）经替身端到端收敛（边界内通过）；
// 2. 2×1MiB blob 的 closure wire≈2.8MiB → 引擎发送前 closure-exceeds-transport
//    稳定拒绝、对端 ref 零变化（r8-B4 裁定第 4 条：严格收窄+拒绝语义）；
// 3. commitLocal 预检：>1MiB 工作树文件 → oversize-history 稳定错误+迁移提示，
//    不写史、独立 root 不受影响（裁定第 3/5 条）；
// 4. 毒化历史（旧超限 blob）：push 检出与 fetch 检出都返回 oversize-history
//    稳定错误（不自动重写/不静默删除）；
// 5. 替身自身账语义（帧/流/会话层单元）。

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { makePair, makeRoot, ID_A, ID_B, createPairGroup } from "./helpers.mjs";
import { gitdirFor } from "../src/ledger.mjs";
import { deviceRef, writeObject, writeTreeFromFlat, writeCommitOid, writeRef, readRef } from "../src/objects.mjs";
import {
  createSessionLedger,
  wrapSyncFetchImpl,
  TransportEnvelopeError,
  TRANSPORT_MAX_FRAME_BYTES,
  TRANSPORT_MAX_STREAM_BYTES,
  TRANSPORT_MAX_SESSION_BYTES,
} from "../../webui/test/plugin-transport-double.mjs";

const MIB = 1024 * 1024;

/** @param {Uint8Array} bytes */
const md5 = (bytes) => crypto.createHash("md5").update(bytes).digest("hex");

async function write(root, rel, content) {
  const t = path.join(root, rel);
  await rm(t, { force: true });
  await writeFile(t, content);
}

/** syncNow → 单 root 结果（runGroup 返回 [{rootId, result}]）。 */
async function syncOne(runtime, groupId) {
  const rows = await runtime.syncNow(groupId);
  return rows[0].result;
}

test("envelope: exactly-1MiB blob syncs end-to-end through the layered transport double (wire <=2MiB, frames <=1MiB)", async () => {
  const p = await makePair({ aId: ID_A, bId: ID_B, transportDouble: true });
  try {
    const big = Buffer.alloc(MIB, 0x42);
    const aRoot = await makeRoot({ "big.bin": big });
    const bRoot = await makeRoot();
    await createPairGroup(p.a, p.b, { id: "env-ok", aRoot, bRoot, seedAuthority: ID_A });
    const ra = await syncOne(p.a, "env-ok");
    assert.equal(ra.ok, true, JSON.stringify(ra));
    const rb = await syncOne(p.b, "env-ok");
    assert.equal(rb.ok, true, JSON.stringify(rb));
    const bytes = await readFile(path.join(bRoot, "big.bin"));
    assert.equal(md5(bytes), md5(big), "1MiB blob converges byte-identical through the guarded transport");
    assert.equal(/** @type {any} */ (p.transportLedger).heldBytes(), 0, "session account fully released after settle");
  } finally {
    await p.cleanup();
  }
});

test("envelope: closure with 2x1MiB blobs exceeds the 2MiB wire account -> closure-exceeds-transport before any POST; peer refs and worktree zero change", async () => {
  const p = await makePair({ aId: ID_A, bId: ID_B, transportDouble: true });
  try {
    const aRoot = await makeRoot({ "a.bin": Buffer.alloc(MIB, 0x61), "b.bin": Buffer.alloc(MIB, 0x62) });
    const bRoot = await makeRoot();
    await createPairGroup(p.a, p.b, { id: "env-closure", aRoot, bRoot, seedAuthority: ID_A });
    const r = await syncOne(p.a, "env-closure");
    assert.equal(r.ok, false);
    assert.equal(r.code, "closure-exceeds-transport", JSON.stringify(r));
    assert.match(r.error.message, /wire bytes/);
    assert.match(r.error.hint ?? "", /later change/, "error names the post-v1 path (batched/pack push, streaming request ABI)");
    const bGroups = await p.b.listGroups();
    assert.equal(bGroups[0].roots[0].groupRef, null, "peer group ref zero change");
    const has = await readdir(bRoot);
    assert.equal(has.length, 0, "peer worktree zero change (no partial push)");
  } finally {
    await p.cleanup();
  }
});

test("envelope: commitLocal precheck rejects >1MiB worktree file with oversize-history (history not written, sibling root unaffected, migration hint)", async () => {
  const p = await makePair({ aId: ID_A, bId: ID_B, transportDouble: true });
  try {
    const aRoot = await makeRoot({ "seed.txt": "v0\n" });
    const bRoot = await makeRoot();
    await createPairGroup(p.a, p.b, { id: "env-hist", aRoot, bRoot, seedAuthority: ID_A });
    assert.equal((await syncOne(p.a, "env-hist")).ok, true);
    assert.equal((await syncOne(p.b, "env-hist")).ok, true);

    // 超限文件进入工作树：commitLocal 扫描预检（读内容/写 blob 前）→ 稳定拒绝
    await write(aRoot, "huge.bin", Buffer.alloc(MIB + 1, 0x48));
    const bad = await syncOne(p.a, "env-hist");
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "oversize-history", JSON.stringify(bad));
    assert.match(bad.error.hint ?? "", /reset\/re-seed/);
    assert.match(bad.error.hint ?? "", /other roots without it keep syncing/);
    const job = p.a.status().find((j) => j.groupId === "env-hist");
    assert.equal(job.phase, "error");
    assert.equal(job.error.code, "oversize-history");

    // 不写史：B 侧永远看不到 huge.bin；A 移除文件后同步恢复（迁移路径可行）
    await syncOne(p.b, "env-hist");
    const bHas = await readFile(path.join(bRoot, "huge.bin")).then(() => true, () => false);
    assert.equal(bHas, false, "oversize file never entered device history");
    await rm(path.join(aRoot, "huge.bin"), { force: true });
    await write(aRoot, "seed.txt", "v1\n");
    assert.equal((await syncOne(p.a, "env-hist")).ok, true, "sync resumes after the oversized file leaves the root");
    assert.equal((await syncOne(p.b, "env-hist")).ok, true);
    const v1 = await readFile(path.join(bRoot, "seed.txt"), "utf8");
    assert.equal(v1, "v1\n");
  } finally {
    await p.cleanup();
  }
});

test("envelope: poisoned history (legacy oversize blob) -> oversize-history on push AND on fetch (no auto-rewrite, stable code)", async () => {
  const p = await makePair({ aId: ID_A, bId: ID_B, transportDouble: true });
  try {
    const aRoot = await makeRoot({ "seed.txt": "v0\n" });
    const bRoot = await makeRoot();
    await createPairGroup(p.a, p.b, { id: "env-poison", aRoot, bRoot, seedAuthority: ID_A });
    assert.equal((await syncOne(p.a, "env-poison")).ok, true);
    assert.equal((await syncOne(p.b, "env-poison")).ok, true);

    // 模拟「旧版本写入的毒化历史」：直接构造超限 blob 的提交链（绕过引擎——
    // commitLocal 预检已挡新入，此处复现存量历史形态）
    const gitdir = gitdirFor(p.aHome, "env-poison", "r1");
    const devRef = deviceRef(ID_A);
    const parent = await readRef(gitdir, devRef);
    assert.ok(parent !== null, "device line exists after clean seed");
    const bigOid = await writeObject(gitdir, "blob", Buffer.alloc(2 * MIB, 0x50));
    const tree = await writeTreeFromFlat(gitdir, [
      { path: "seed.txt", oid: await writeObject(gitdir, "blob", Buffer.from("v0\n")), mode: "100644" },
      { path: "poison.bin", oid: bigOid, mode: "100644" },
    ]);
    const poisonedCommit = await writeCommitOid(gitdir, {
      message: "legacy poisoned commit",
      tree,
      parent: [parent],
      authorName: "aa11aa22 device-a",
      authorEmail: "aa11aa22@device.sync",
      timestamp: Date.now(),
    });
    await writeRef(gitdir, devRef, poisonedCommit);

    // push 检出：closure（经 parent 链）含 2MiB blob → oversize-history（毒化
    // 历史稳定错误）。commitLocal 会为当前工作树新建干净子提交（合法——工作树
    // 与毒化树有差），但毒化提交/对象**不被重写、不被删除**——仍完整在库。
    const push = await syncOne(p.a, "env-poison");
    assert.equal(push.ok, false);
    assert.equal(push.code, "oversize-history", JSON.stringify(push));
    assert.match(push.error.hint ?? "", /explicitly reset\/re-seed/);
    const headAfter = await readRef(gitdir, devRef);
    assert.notEqual(headAfter, null);
    const { hasObject, walkClosure, readObject } = await import("../src/objects.mjs");
    assert.equal(await hasObject(gitdir, poisonedCommit), true, "poisoned commit is never deleted");
    assert.equal(await hasObject(gitdir, bigOid), true, "oversized blob object is never deleted");
    const closureNow = await walkClosure(/** @type {string} */ (headAfter), async (oid) => {
      try {
        return await readObject(gitdir, oid);
      } catch {
        return null;
      }
    });
    assert.ok(closureNow.some((o) => o.oid === bigOid), "current history still references the poisoned blob (no silent rewrite)");

    // fetch 检出：B 拉取对端 device 线 → GET object 413 oversize → 稳定映射
    const fetch = await syncOne(p.b, "env-poison");
    assert.equal(fetch.ok, false);
    assert.equal(fetch.code, "oversize-history", JSON.stringify(fetch));
    assert.match(fetch.error.message, /peer history contains blob/);
    // B 工作树零变化（毒化对象未落地）
    const bFiles = await readdir(bRoot);
    assert.deepEqual(bFiles.sort(), ["seed.txt"]);
  } finally {
    await p.cleanup();
  }
});

test("envelope double unit: frame layer rejects >1MiB elements; stream layer rejects >2MiB totals; session layer caps concurrent held bytes at 8MiB", async () => {
  const ledger = createSessionLedger();
  // 帧：单元素超限（旧「单 Buffer 一次性发送」形态）——到达 transport 即失败
  assert.throws(() => ledger.charge([Buffer.alloc(MIB + 1)]), (e) => e instanceof TransportEnvelopeError && e.layer === "frame" && e.code === "frame-too-large");
  // 流：元素各自 ≤1MiB 但总量 >2MiB
  assert.throws(() => ledger.charge([Buffer.alloc(MIB), Buffer.alloc(MIB), Buffer.alloc(1)]), (e) => e.layer === "stream" && e.code === "stream-exceeds-journal");
  // 边界内通过：恰 2MiB（1MiB 帧×2）——建模并发在飞请求逐步占满会话账
  const t1 = ledger.charge([Buffer.alloc(MIB), Buffer.alloc(MIB)]);
  assert.equal(t1.bytes, TRANSPORT_MAX_STREAM_BYTES);
  const t2 = ledger.charge([Buffer.alloc(MIB), Buffer.alloc(MIB)]);
  const t3 = ledger.charge([Buffer.alloc(MIB), Buffer.alloc(MIB)]);
  const t4 = ledger.charge([Buffer.alloc(MIB), Buffer.alloc(MIB)]);
  assert.equal(ledger.heldBytes(), TRANSPORT_MAX_SESSION_BYTES, "four concurrent 2MiB streams exhaust the session account");
  // 会话：在飞 8MiB 已持有 → 新请求（哪怕 1 字节）超账
  assert.throws(() => ledger.charge([Buffer.alloc(1)]), (e) => e.layer === "session" && e.code === "session-exceeds-journal");
  // 释放（响应读尽）后会话账回落，新请求可入
  for (const t of [t1, t2, t3, t4]) ledger.release(t);
  assert.equal(ledger.heldBytes(), 0);
  ledger.charge([Buffer.alloc(MIB)]);
  // 常量对齐 transport 事实
  assert.equal(TRANSPORT_MAX_FRAME_BYTES, 1024 * 1024);
  assert.equal(TRANSPORT_MAX_STREAM_BYTES, 2 * 1024 * 1024);
  assert.equal(TRANSPORT_MAX_SESSION_BYTES, 8 * 1024 * 1024);
});

test("envelope double unit: wrapSyncFetchImpl applies production <=1MiB frame chunking (2MiB wire body passes, 2MiB+1 is stream-rejected)", async () => {
  /** @type {Uint8Array[]} */
  const seenBodies = [];
  const inner = async (session, req) => {
    seenBodies.push(req.body);
    return { status: 200, body: new Uint8Array() };
  };
  const wrapped = wrapSyncFetchImpl(inner);
  // 2MiB 单块 body：生产分块（data-plane.mjs toSyncFetch 同款）后入账通过
  const ok = await wrapped(null, { method: "POST", path: "/x", body: new Uint8Array(Buffer.alloc(2 * MIB)) });
  assert.equal(ok.status, 200);
  assert.equal(seenBodies.length, 1);
  // 2MiB+1：流层拒绝（请求不到达内层——零副作用）
  await assert.rejects(
    () => wrapped(null, { method: "POST", path: "/x", body: new Uint8Array(Buffer.alloc(2 * MIB + 1)) }),
    (e) => e instanceof TransportEnvelopeError && e.layer === "stream",
  );
  assert.equal(seenBodies.length, 1, "stream-rejected request never reached the inner transport");
});
