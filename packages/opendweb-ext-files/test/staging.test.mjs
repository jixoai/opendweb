// staging 测试（幂等键/伪造 chunkHash/TTL 回收/路径绑定）。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createStaging, sha256Hex } from "../src/staging.mjs";
import { tempFixture } from "./util.mjs";

const A = new Uint8Array([1, 2, 3, 4]);
const B = new Uint8Array([9, 9, 9]);

test("putChunk happy path: binds path, writes chunk, touches dir", async () => {
  const { home, cleanup } = tempFixture();
  try {
    const st = createStaging({ home });
    const r = await st.putChunk({ uploadId: "u1", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "docs/a.bin" });
    assert.deepEqual(r, { ok: true, idempotent: false, received: 4 });
    assert.equal((await st.readMeta("u1")).path, "docs/a.bin");
    assert.equal((await st.listChunks("u1"))[0].size, 4);
  } finally {
    cleanup();
  }
});

test("idempotency: same (uploadId,seq,offset) + same content = idempotent success, file untouched", async () => {
  const { home, cleanup } = tempFixture();
  try {
    const st = createStaging({ home });
    await st.putChunk({ uploadId: "u1", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" });
    const r = await st.putChunk({ uploadId: "u1", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" });
    assert.equal(r.ok, true);
    assert.equal(r.idempotent, true);
    // 原文件未被重写（mtime 不变即可，这里以内容与数量断言）
    assert.equal((await st.listChunks("u1")).length, 1);
  } finally {
    cleanup();
  }
});

test("same key + different content = explicit conflict, NOT overwritten", async () => {
  const { home, cleanup } = tempFixture();
  try {
    const st = createStaging({ home });
    await st.putChunk({ uploadId: "u1", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" });
    const r = await st.putChunk({ uploadId: "u1", seq: 0, offset: 0, bytes: B, declaredHash: sha256Hex(B), path: "a" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "CHUNK_CONFLICT");
    // 原内容仍在（未覆盖）
    const st2 = createStaging({ home });
    const chunks = await st2.listChunks("u1");
    assert.equal(chunks[0].size, A.length);
  } finally {
    cleanup();
  }
});

test("forged chunkHash (declared != recomputed from bytes) is rejected before staging", async () => {
  const { home, cleanup } = tempFixture();
  try {
    const st = createStaging({ home });
    const r = await st.putChunk({ uploadId: "u1", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(B), path: "a" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "FORGED_HASH");
    assert.equal((await st.listChunks("u1")).length, 0, "拒绝时零落盘");
  } finally {
    cleanup();
  }
});

test("uploadId is path-bound after the first chunk (mismatch rejected)", async () => {
  const { home, cleanup } = tempFixture();
  try {
    const st = createStaging({ home });
    await st.putChunk({ uploadId: "u1", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" });
    const r = await st.putChunk({ uploadId: "u1", seq: 1, offset: 4, bytes: A, declaredHash: sha256Hex(A), path: "different" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "PATH_MISMATCH");
  } finally {
    cleanup();
  }
});

test("bad inputs: invalid uploadId / seq / offset / hash shape", async () => {
  const { home, cleanup } = tempFixture();
  try {
    const st = createStaging({ home });
    for (const input of [
      { uploadId: "../escape", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" },
      { uploadId: ".hidden", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" },
      { uploadId: "u1", seq: -1, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" },
      { uploadId: "u1", seq: 0, offset: -5, bytes: A, declaredHash: sha256Hex(A), path: "a" },
      { uploadId: "u1", seq: 0, offset: 0, bytes: A, declaredHash: "nothex", path: "a" },
    ]) {
      const r = await st.putChunk(input);
      assert.equal(r.ok, false, JSON.stringify(input));
      assert.equal(r.code, "BAD_INPUT");
    }
  } finally {
    cleanup();
  }
});

test("TTL sweep reclaims abandoned uploads (injected clock), activity refreshes lastTouch", async () => {
  let nowMs = 1_000_000;
  const { home, cleanup } = tempFixture();
  try {
    const st = createStaging({ home, ttlMs: 15 * 60_000, now: () => nowMs });
    await st.putChunk({ uploadId: "abandoned", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" });
    nowMs += 10 * 60_000;
    await st.putChunk({ uploadId: "active", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "b" });
    nowMs += 6 * 60_000; // abandoned 已 16min 无活动；active 6min
    const removed = await st.sweep();
    assert.deepEqual(removed, ["abandoned"]);
    assert.equal(fs.existsSync(st.uploadDir("abandoned")), false);
    assert.equal(fs.existsSync(st.uploadDir("active")), true);
    // active 续片后 touch，再过 10min 仍在、16min 后回收
    nowMs += 10 * 60_000;
    await st.putChunk({ uploadId: "active", seq: 1, offset: 4, bytes: A, declaredHash: sha256Hex(A), path: "b" });
    assert.deepEqual(await st.sweep(), []);
    nowMs += 16 * 60_000;
    assert.deepEqual(await st.sweep(), ["active"]);
  } finally {
    cleanup();
  }
});

test("removeUpload clears the whole uploadId directory", async () => {
  const { home, cleanup } = tempFixture();
  try {
    const st = createStaging({ home });
    await st.putChunk({ uploadId: "u", seq: 0, offset: 0, bytes: A, declaredHash: sha256Hex(A), path: "a" });
    await st.putChunk({ uploadId: "u", seq: 1, offset: 4, bytes: B, declaredHash: sha256Hex(B), path: "a" });
    await st.removeUpload("u");
    assert.equal(fs.existsSync(st.uploadDir("u")), false);
  } finally {
    cleanup();
  }
});
