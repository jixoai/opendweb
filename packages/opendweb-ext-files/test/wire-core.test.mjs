// wire 核心场景测试（specs/plugins/files 三 Scenario 中的闭环与断线幂等续传 +
// ignore/授权矩阵/预算/保留名/操作语义；路径逃逸四类在 wire-escape.test.mjs）。
// 全部直调注入式 handler（fakeRequest）+ 临时目录 fixture；每测试独立 runtime。

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createFilesRuntime } from "../src/runtime.mjs";
import { createHandlerTransport, createWireFilesController, WireClientError } from "../src/client.mjs";
import { fakeRequest, tempFixture } from "./util.mjs";

/**
 * 标准环境：share(rootDir) peers=[ep-a]；session s1→ep-a、s2→ep-b、s3→null。
 */
async function setup(opts = {}) {
  const fixture = tempFixture({ withIgnore: opts.withIgnore });
  const rt = await createFilesRuntime({
    home: fixture.home,
    log: () => {},
    resolvePeer: async (sid) => (sid === "s1" ? "ep-a" : sid === "s2" ? "ep-b" : null),
    stagingTtlMs: opts.stagingTtlMs,
    sweepIntervalMs: opts.sweepIntervalMs,
    chunkMaxBytes: opts.chunkMaxBytes,
    readMaxBytes: opts.readMaxBytes,
    maxConcurrentTransfers: opts.maxConcurrentTransfers,
    now: opts.now,
  });
  await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
  const share = await rt.shares.add({
    name: "docs",
    root: fixture.rootDir,
    mode: opts.mode ?? "rw",
    peers: ["ep-a"],
  });
  const clientFor = (sessionId = "s1") => createWireFilesController(createHandlerTransport(rt.handler, { sessionId }), { shareId: share.id });
  return { fixture, rt, share, clientFor, client: clientFor("s1") };
}

async function teardown(env) {
  await env.rt.onDispose();
  env.fixture.cleanup();
}

// ---- Scenario 1：浏览/下载/上传闭环 -----------------------------------------------

test("browse: list root and nested dir (name/type/size/mtime; dirs first)", async () => {
  const env = await setup({ mode: "ro" });
  try {
    const out = await env.client.list("");
    const names = out.entries.map((e) => `${e.type}:${e.name}`);
    assert.deepEqual(names, ["dir:docs", "file:hello.txt"]);
    const hello = out.entries.find((e) => e.name === "hello.txt");
    assert.equal(hello.size, 11);
    assert.ok(hello.mtime > 0);
    const nested = await env.client.list("docs/nested");
    assert.deepEqual(nested.entries.map((e) => e.name), ["deep.txt"]);
    // 保留名不进列表
    const rootNames = out.entries.map((e) => e.name);
    assert.equal(rootNames.includes(".opendweb-ignore"), false);
  } finally {
    await teardown(env);
  }
});

test("download: read full file + Range continuation; etag/oid = content hash", async () => {
  const env = await setup({ mode: "ro" });
  try {
    const full = await env.client.downloadFile("hello.txt");
    assert.equal(Buffer.from(full.bytes).toString(), "HELLO-FILES");
    const expected = crypto.createHash("sha256").update("HELLO-FILES").digest("hex");
    assert.equal(full.oid, expected);
    // Range 续读
    const mid = await env.client.readSlice("hello.txt", 6, 5);
    assert.equal(Buffer.from(mid.bytes).toString(), "FILES");
    assert.equal(mid.oid, expected);
    // stat 的 oid 与 read 一致（版本标识）
    const st = await env.client.stat("hello.txt");
    assert.equal(st.oid, expected);
  } finally {
    await teardown(env);
  }
});

test("upload closed loop: large file (3 chunks) with progress; commit lands atomically with exact bytes", async () => {
  const env = await setup();
  const payload = new Uint8Array(crypto.randomBytes(9 * 1024 * 1024 + 77)); // 9MiB+77 → 3 片
  const progresses = [];
  try {
    const out = await env.client.uploadFile("docs/big.bin", payload, {
      onProgress: (sent, total) => progresses.push([sent, total]),
    });
    assert.equal(out.size, payload.length);
    assert.ok(progresses.length >= 3, "分片循环必须产生多档进度");
    assert.deepEqual(progresses[progresses.length - 1], [payload.length, payload.length]);
    const landed = fs.readFileSync(path.join(env.fixture.rootDir, "docs", "big.bin"));
    assert.ok(landed.equals(Buffer.from(payload)));
    // commit 后 oid=整文件 sha256
    assert.equal(out.oid, crypto.createHash("sha256").update(payload).digest("hex"));
    // 下载对账
    const back = await env.client.downloadFile("docs/big.bin", { chunkBytes: 4 * 1024 * 1024 });
    assert.ok(Buffer.from(back.bytes).equals(Buffer.from(payload)));
  } finally {
    await teardown(env);
  }
});

test("commit atomicity: interrupted upload leaves NO half file in the formal namespace", async () => {
  const env = await setup();
  const payload = crypto.randomBytes(1024 * 1024);
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  try {
    // 只 PUT 不 commit（模拟断线）
    await env.client.putChunk("docs/interrupted.bin", "u-int", 0, 0, new Uint8Array(payload));
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "docs", "interrupted.bin")), false, "正式目录无半文件");
    const listing = await env.client.list("docs");
    assert.equal(listing.entries.some((e) => e.name === "interrupted.bin"), false, "list 不可见");
    assert.equal(listing.entries.some((e) => e.name.startsWith(".opendweb.")), false, "temp 名不进正式命名空间");
    // 同 uploadId 续传（幂等重放同片）后 commit → 原子落盘
    await env.client.putChunk("docs/interrupted.bin", "u-int", 0, 0, new Uint8Array(payload));
    const out = await env.client.commit("docs/interrupted.bin", "u-int", payload.length, hash);
    assert.equal(out.size, payload.length);
    assert.ok(fs.readFileSync(path.join(env.fixture.rootDir, "docs", "interrupted.bin")).equals(payload));
    // commit 后 staging 清空
    const stagingDirs = fs.readdirSync(path.join(env.fixture.home, "plugins/files/staging"));
    assert.equal(stagingDirs.includes("u-int"), false);
  } finally {
    await teardown(env);
  }
});

test("empty file upload: zero chunks, commit with empty digest", async () => {
  const env = await setup();
  try {
    const out = await env.client.uploadFile("docs/empty.txt", new Uint8Array(0));
    assert.equal(out.size, 0);
    assert.equal(fs.statSync(path.join(env.fixture.rootDir, "docs", "empty.txt")).size, 0);
  } finally {
    await teardown(env);
  }
});

// ---- Scenario 3：断线中断与幂等续传 ------------------------------------------------

test("idempotent resume: same key + same content = success (no rewrite); different content = explicit conflict; forged chunkHash = reject", async () => {
  const env = await setup();
  const a = crypto.randomBytes(1000);
  const b = crypto.randomBytes(1000);
  try {
    const first = await env.client.putChunk("docs/f.bin", "u3", 0, 0, a);
    assert.equal(first.idempotent, false);
    const again = await env.client.putChunk("docs/f.bin", "u3", 0, 0, a);
    assert.equal(again.idempotent, true); // 同键同内容幂等成功，不报错
    // 同键异内容 → 明确拒绝不覆盖
    await assert.rejects(env.client.putChunk("docs/f.bin", "u3", 0, 0, b), (e) => e instanceof WireClientError && e.status === 409);
    // 原内容未被覆盖：用 a 拼接 commit 成功
    const hash = crypto.createHash("sha256").update(a).digest("hex");
    const out = await env.client.commit("docs/f.bin", "u3", a.length, hash);
    assert.equal(out.size, a.length);
    assert.ok(fs.readFileSync(path.join(env.fixture.rootDir, "docs", "f.bin")).equals(a));
  } finally {
    await teardown(env);
  }
});

test("forged chunkHash (declared != bytes) is rejected with zero staging", async () => {
  const env = await setup();
  const a = crypto.randomBytes(100);
  try {
    // controller 会自算 hash——伪造面必须直调 wire（声明 hash 与 bytes 重算不符）
    const forged = crypto.createHash("sha256").update("other").digest("hex");
    const req = fakeRequest({
      sessionId: "s1",
      method: "PUT",
      path: `/wpk1/files/${env.share.id}/chunk?path=docs/x.bin&uploadId=u4&seq=0&offset=0&hash=${forged}`,
      body: [a],
    });
    const res = await env.rt.handler(req.request);
    assert.equal(res.status, 400);
    const body = JSON.parse(Buffer.from(res.bodyChunks[0]).toString("utf8"));
    assert.equal(body.error, "forged_hash");
    // 拒绝时零 staging
    assert.equal(fs.existsSync(path.join(env.fixture.home, "plugins/files/staging/u4")), false);
  } finally {
    await teardown(env);
  }
});

test("whole-file digest mismatch at commit: integral rejection, zero landing, staging kept for retry", async () => {
  const env = await setup();
  const a = crypto.randomBytes(2000);
  try {
    await env.client.putChunk("docs/dg.bin", "u5", 0, 0, a);
    const wrong = crypto.createHash("sha256").update("not-the-content").digest("hex");
    await assert.rejects(
      env.client.commit("docs/dg.bin", "u5", a.length, wrong),
      (e) => e instanceof WireClientError && e.status === 422,
    );
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "docs", "dg.bin")), false, "零落盘");
    const listing = await env.client.list("docs");
    assert.equal(listing.entries.some((e) => e.name === "dg.bin"), false);
    assert.equal(listing.entries.some((e) => e.name.startsWith(".opendweb.upload.")), false, "temp 清理——不暴露半文件");
    // staging 保留（重试面）：正确 digest 重 commit 成功
    const right = crypto.createHash("sha256").update(a).digest("hex");
    const out = await env.client.commit("docs/dg.bin", "u5", a.length, right);
    assert.equal(out.size, a.length);
  } finally {
    await teardown(env);
  }
});

test("coverage gate: wrong totalLength / gap / duplicate seq rejected at commit", async () => {
  const env = await setup();
  const a = crypto.randomBytes(500);
  const b2 = crypto.randomBytes(300);
  const hash = crypto.createHash("sha256").update(Buffer.concat([a, b2])).digest("hex");
  try {
    await env.client.putChunk("docs/cv.bin", "u6", 0, 0, a);
    await env.client.putChunk("docs/cv.bin", "u6", 1, 500, b2);
    // totalLength 不符
    await assert.rejects(env.client.commit("docs/cv.bin", "u6", 999, hash), (e) => e.status === 409);
    // 空洞：直接伪造一个 offset 跳档的 staging（手工经 runtime.staging）
    await env.rt.staging.putChunk({ uploadId: "u7", seq: 0, offset: 100, bytes: a, declaredHash: crypto.createHash("sha256").update(a).digest("hex"), path: "docs/gap.bin" });
    await assert.rejects(
      env.client.commit("docs/gap.bin", "u7", 100 + a.length, crypto.createHash("sha256").update(a).digest("hex")),
      (e) => e.status === 409,
    );
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "docs", "cv.bin")), false);
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "docs", "gap.bin")), false);
  } finally {
    await teardown(env);
  }
});

test("commit destination must match the upload's bound path; unknown uploadId → 404", async () => {
  const env = await setup();
  const a = crypto.randomBytes(64);
  try {
    await env.client.putChunk("docs/one.bin", "u8", 0, 0, a);
    const hash = crypto.createHash("sha256").update(a).digest("hex");
    await assert.rejects(env.client.commit("docs/other.bin", "u8", a.length, hash), (e) => e.status === 400);
    await assert.rejects(env.client.commit("docs/one.bin", "never-existed", a.length, hash), (e) => e.status === 404);
  } finally {
    await teardown(env);
  }
});

test("TTL reclaim: abandoned staging swept (short ttl), later commit → 404", async () => {
  const env = await setup({ stagingTtlMs: 120, sweepIntervalMs: 30 });
  const a = crypto.randomBytes(64);
  try {
    await env.client.putChunk("docs/ttl.bin", "u9", 0, 0, a);
    await new Promise((r) => setTimeout(r, 260));
    const hash = crypto.createHash("sha256").update(a).digest("hex");
    await assert.rejects(env.client.commit("docs/ttl.bin", "u9", a.length, hash), (e) => e.status === 404);
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "docs", "ttl.bin")), false);
  } finally {
    await teardown(env);
  }
});

// ---- .opendweb-ignore -------------------------------------------------------------

test("ignore: hidden from list; read/stat/upload/mkdir on ignored paths → 404 (indistinguishable from missing)", async () => {
  const env = await setup({ withIgnore: "*.md\nsecret-dir/\n" });
  try {
    const docs = await env.client.list("docs");
    assert.equal(docs.entries.some((e) => e.name === "note.md"), false);
    // root 的 ignore 文件本身也隐藏（保留名）
    const rootList = await env.client.list("");
    assert.equal(rootList.entries.some((e) => e.name === ".opendweb-ignore"), false);
    await assert.rejects(env.client.stat("docs/note.md"), (e) => e.status === 404);
    const dl = await env.client.readSlice("docs/note.md", 0, 10).catch((e) => e);
    assert.equal(dl.status, 404);
    await assert.rejects(env.client.uploadFile("docs/note.md", new Uint8Array(10)), (e) => e.status === 404);
    await assert.rejects(env.client.uploadFile("secret-dir/x", new Uint8Array(10)), (e) => e.status === 404);
    await assert.rejects(env.client.mkdir("secret-dir"), (e) => e.status === 404);
    // ignore 文件本身保留名直读拒绝
    await assert.rejects(env.client.downloadFile(".opendweb-ignore"), (e) => e.status === 404);
  } finally {
    await teardown(env);
  }
});

// ---- 授权矩阵（peer/mode/sessionId deny-by-default）--------------------------------

test("authorization: peers ledger entry in hex64 authorizes a z32 wire peer (same key, different encoding)", async () => {
  // 真双机验收 F1（2026-09-30）：fabric 会话 peer 是 z32 展示串，账本若登记
  // hex64（server 租约冻结形态）——裸 includes 比对恒 mismatch（已授权仍 403）。
  // SDK ground-truth 校准过的同钥对（iMac↔mini 验收实证）：
  const HEX = "ec80ba47821deba5019c2fee2ecab2ccdca81885dd8d61f9d67907463e2a879a";
  const Z32 = "71ymwthndzi4kychf9zn71i13uqkogrf5sgsd6qsxrdwcxtko6py";
  const fixture = tempFixture();
  const rt = await createFilesRuntime({
    home: fixture.home,
    log: () => {},
    resolvePeer: async (sid) => (sid === "s1" ? Z32 : sid === "s2" ? "ep-b" : null),
  });
  await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
  try {
    // 账本登记 hex 形态，wire peer 为 z32：归一后应授权成功
    const share = await rt.shares.add({ name: "hex-ledger", root: fixture.rootDir, mode: "ro", peers: [HEX] });
    const res = await rt.handler(
      fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${share.id}/list?path=` }).request,
    );
    assert.equal(res.status, 200, "hex ledger entry must authorize the z32 wire peer (same key)");
    // 反向：账本登记 z32，wire peer hex（归一对称）
    await rt.shares.setPeers(share.id, [Z32]);
    const rtHexPeer = await createFilesRuntime({
      home: fixture.home,
      log: () => {},
      resolvePeer: async () => HEX,
    });
    const res2 = await rtHexPeer.handler(
      fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${share.id}/list?path=` }).request,
    );
    assert.equal(res2.status, 200, "z32 ledger entry must authorize the hex wire peer (same key)");
    await rtHexPeer.onDispose();
    // 混合登记里含同钥任一形态即授权；异钥仍拒
    await rt.shares.setPeers(share.id, ["ep-b", HEX]);
    assert.equal(
      (await rt.handler(fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${share.id}/list?path=` }).request)).status,
      200,
    );
    await rt.shares.setPeers(share.id, ["0".repeat(64)]);
    const denied = await rt.handler(
      fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${share.id}/list?path=` }).request,
    );
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(Buffer.from(denied.bodyChunks[0]).toString("utf8")).error, "peer-not-authorized");
  } finally {
    await rt.onDispose();
    fixture.cleanup();
  }
});

test("authorization matrix: unknown session / unauthorized peer / readonly gate / unknown share-op / method", async () => {
  const env = await setup({ mode: "ro" });
  const shareId = env.share.id;
  try {
    const wire = (sid, method, p, body) => fakeRequest({ sessionId: sid, method, path: p, body });
    // 未知 session（deny-by-default；即使 peer 曾经其它 session 授权过——零授权缓存）
    const s3 = wire("s3", "GET", `/wpk1/files/${shareId}/list?path=`);
    assert.equal((await env.rt.handler(s3.request)).status, 403);
    // 未授权 peer
    const s2 = wire("s2", "GET", `/wpk1/files/${shareId}/list?path=`);
    assert.equal((await env.rt.handler(s2.request)).status, 403);
    // 授权 peer 读 ok
    const s1 = wire("s1", "GET", `/wpk1/files/${shareId}/list?path=`);
    assert.equal((await env.rt.handler(s1.request)).status, 200);
    // ro 写门：全部写操作 403 share-readonly
    for (const [method, p, body] of [
      ["PUT", `/wpk1/files/${shareId}/chunk?path=a&uploadId=u&seq=0&offset=0&hash=${"0".repeat(64)}`, [Buffer.from("x")]],
      ["POST", `/wpk1/files/${shareId}/commit`, [Buffer.from(JSON.stringify({ uploadId: "u", path: "a", totalLength: 1, contentHash: "0".repeat(64) }))]],
      ["POST", `/wpk1/files/${shareId}/mkdir`, [Buffer.from(JSON.stringify({ path: "d" }))]],
      ["POST", `/wpk1/files/${shareId}/rename`, [Buffer.from(JSON.stringify({ from: "a", to: "b" }))]],
      ["POST", `/wpk1/files/${shareId}/delete`, [Buffer.from(JSON.stringify({ path: "a" }))]],
    ]) {
      const res = await env.rt.handler(wire("s1", method, p, body).request);
      assert.equal(res.status, 403, `${method} ${p}`);
      assert.equal(JSON.parse(Buffer.from(res.bodyChunks[0]).toString("utf8")).error, "share-readonly");
    }
    // 未知 share / 未知 op / 方法不符
    assert.equal((await env.rt.handler(wire("s1", "GET", `/wpk1/files/nosuch/list?path=`).request)).status, 404);
    assert.equal((await env.rt.handler(wire("s1", "GET", `/wpk1/files/${shareId}/frobnicate`).request)).status, 404);
    assert.equal((await env.rt.handler(wire("s1", "GET", `/wpk1/files/${shareId}/commit`).request)).status, 405);
    assert.equal((await env.rt.handler(wire("s1", "POST", `/wpk1/files/${shareId}/list?path=`).request)).status, 405);
    // 升 rw 后写 ok（mode 变更走账本）
    await env.rt.shares.setMode(shareId, "rw");
    const mkdir = await env.rt.handler(wire("s1", "POST", `/wpk1/files/${shareId}/mkdir`, [Buffer.from(JSON.stringify({ path: "newdir" }))]).request);
    assert.equal(mkdir.status, 201);
    // s2/s3 仍拒（peer 门与 mode 门独立）
    assert.equal((await env.rt.handler(wire("s2", "POST", `/wpk1/files/${shareId}/mkdir`, [Buffer.from(JSON.stringify({ path: "x" }))]).request)).status, 403);
  } finally {
    await teardown(env);
  }
});

// ---- 预算与上限（§4）--------------------------------------------------------------

test("transfer budget: maxConcurrentTransfers gate → 429 while reads are in flight", async () => {
  const env = await setup({ maxConcurrentTransfers: 2, readMaxBytes: 64 });
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    // 两个阻塞写句柄的读流占满预算
    const held = [
      fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${env.share.id}/read?path=hello.txt&len=11`, writeGate: gate }),
      fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${env.share.id}/read?path=hello.txt&len=11`, writeGate: gate }),
    ];
    const runs = held.map((h) => env.rt.handler(h.request));
    await new Promise((r) => setTimeout(r, 40));
    const third = fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${env.share.id}/read?path=hello.txt&len=11` });
    const res = await env.rt.handler(third.request);
    assert.equal(res.status, 429);
    release();
    await Promise.all(runs);
    assert.equal(held[0].getStreamStatus(), 200);
  } finally {
    await teardown(env);
  }
});

test("size caps: chunk over chunkMaxBytes → 413; read len over readMaxBytes → 400; offset past EOF → 416", async () => {
  const env = await setup({ chunkMaxBytes: 1000, readMaxBytes: 4 });
  try {
    // chunk 超限（bodyNext 流式累计——边读边拒）
    const big = fakeRequest({
      sessionId: "s1",
      method: "PUT",
      path: `/wpk1/files/${env.share.id}/chunk?path=big.bin&uploadId=ub&seq=0&offset=0&hash=${"0".repeat(64)}`,
      body: [Buffer.alloc(400), Buffer.alloc(400), Buffer.alloc(400)],
    });
    const res = await env.rt.handler(big.request);
    assert.equal(res.status, 413);
    // read len 超档
    const toolong = fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${env.share.id}/read?path=hello.txt&len=5` });
    assert.equal((await env.rt.handler(toolong.request)).status, 400);
    // offset 越界
    const past = fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${env.share.id}/read?path=hello.txt&offset=99&len=4` });
    assert.equal((await env.rt.handler(past.request)).status, 416);
  } finally {
    await teardown(env);
  }
});

// ---- 操作语义（mkdir/rename/delete）----------------------------------------------

test("write ops semantics: mkdir dup 409; rename onto existing 409 (no overwrite); delete file; delete non-empty dir 409; rename dir moves contents", async () => {
  const env = await setup();
  try {
    await env.client.mkdir("docs/newdir");
    await assert.rejects(env.client.mkdir("docs/newdir"), (e) => e.status === 409);
    // rename 拒绝覆盖既有目标
    await assert.rejects(env.client.rename("hello.txt", "docs/note.md"), (e) => e.status === 409);
    assert.equal(fs.readFileSync(path.join(env.fixture.rootDir, "docs", "note.md")).toString(), "# note\n", "目标未被覆盖");
    // 改名文件
    await env.client.rename("hello.txt", "hello-renamed.txt");
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "hello-renamed.txt")), true);
    // 改名目录（内容跟随）
    await env.client.rename("docs/newdir", "docs/moveddir");
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "docs", "moveddir")), true);
    // 删除文件
    await env.client.remove("hello-renamed.txt");
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "hello-renamed.txt")), false);
    // 非空目录拒绝（v1 无递归删除）
    await assert.rejects(env.client.remove("docs"), (e) => e.status === 409);
    // 空目录删除 ok
    await env.client.remove("docs/moveddir");
    assert.equal(fs.existsSync(path.join(env.fixture.rootDir, "docs", "moveddir")), false);
    // rename 后客户端重拉列表恢复（spec read 注记）
    const listing = await env.client.list("");
    assert.deepEqual(listing.entries.map((e) => e.name), ["docs"]);
  } finally {
    await teardown(env);
  }
});

// ---- 生命周期 -------------------------------------------------------------------

test("disposed runtime rejects new wire requests (503)", async () => {
  const env = await setup({ mode: "ro" });
  try {
    await env.rt.onDispose();
    const res = await env.rt.handler(fakeRequest({ sessionId: "s1", method: "GET", path: `/wpk1/files/${env.share.id}/list?path=` }).request);
    assert.equal(res.status, 503);
  } finally {
    await teardown(env); // 幂等 dispose
  }
});
