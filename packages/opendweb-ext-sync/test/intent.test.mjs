// intent 事务协议测试（webui-plugin-kernel Phase 3 / design v2.3 §7.3.1 逐字——
// r4-N2 四边界 + 扫描后编辑保护）。
// 四边界（kill 模拟=crashAt 钩子抛出+直接调 recoverIntent——不真 kill 进程）：
//   1. prepare 之后；2. 物化进行中（含某路径已 rename 出 target 内容后的半写）；
//   3. ref 推进之后；4. done 标记写入之前。
// 断言（B3 验收）：恢复后文件内容、ref、用户未提交本地改动三者一致且无半成品。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeIntent, recoverIntent, readPendingIntent, INTENT_FILE, INTENT_DONE_FILE } from "../src/intent.mjs";
import { writeObject, writeRef, readRef, GROUP_REF, writeTreeFromFlat, writeCommitOid } from "../src/objects.mjs";
import { CrashInjection } from "../src/util.mjs";
import { chmod } from "node:fs/promises";

/**
 * 场景骨架：root 含 c.txt（将被删）+ b.txt（将改）+ 新增 a.txt；ops 顺序
 * [write a.txt, write b.txt, delete c.txt]。
 */
async function fixture(name) {
  const base = await mkdtemp(path.join(tmpdir(), `dweb-intent-${name}-`));
  const root = path.join(base, "root");
  const repoDir = path.join(base, "repo");
  const gitdir = path.join(repoDir, "git");
  await mkdir(root, { recursive: true });
  await mkdir(gitdir, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, "b.txt"), "old-b\n");
  await writeFile(path.join(root, "c.txt"), "old-c\n");
  const blobA = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from("new-a\n")));
  const blobB = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from("new-b\n")));
  const blobOldB = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from("old-b\n")));
  const blobOldC = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from("old-c\n")));
  const treeOld = await writeTreeFromFlat(gitdir, [
    { path: "b.txt", oid: blobOldB, mode: "100644" },
    { path: "c.txt", oid: blobOldC, mode: "100644" },
  ]);
  const oldCommit = await writeCommitOid(gitdir, { message: "old", tree: treeOld, parent: [], authorName: "t", authorEmail: "t@t", timestamp: 1 });
  const treeNew = await writeTreeFromFlat(gitdir, [
    { path: "a.txt", oid: blobA, mode: "100644" },
    { path: "b.txt", oid: blobB, mode: "100644" },
  ]);
  const targetCommit = await writeCommitOid(gitdir, { message: "new", tree: treeNew, parent: [oldCommit], authorName: "t", authorEmail: "t@t", timestamp: 2 });
  await writeRef(gitdir, GROUP_REF, oldCommit);
  const ctx = { repoDir, root, gitdir };
  const spec = {
    ref: GROUP_REF,
    targetCommit,
    oldRef: oldCommit,
    ops: [
      { op: "write", path: "a.txt", pre: null, post: { oid: blobA, type: "blob", mode: 0o100644 } },
      { op: "write", path: "b.txt", pre: { oid: blobOldB, type: "blob", mode: 0o100644 }, post: { oid: blobB, type: "blob", mode: 0o100644 } },
      { op: "delete", path: "c.txt", pre: { oid: blobOldC, type: "blob", mode: 0o100644 }, post: null },
    ],
  };
  return { base, root, repoDir, gitdir, ctx, spec, targetCommit, oldCommit };
}

/**
 * @param {string} root
 */
async function snapshot(root) {
  return {
    a: await readFile(path.join(root, "a.txt"), "utf8").catch(() => null),
    b: await readFile(path.join(root, "b.txt"), "utf8").catch(() => null),
    c: await readFile(path.join(root, "c.txt"), "utf8").catch(() => null),
  };
}

test("boundary 1: crash after prepare -> oldRef branch, all preimage -> full roll-forward", async () => {
  const f = await fixture("b1");
  await assert.rejects(
    () => executeIntent(f.ctx, f.spec, { crashAt: (s) => { if (s === "prepared") throw new CrashInjection(s); } }),
    (e) => e instanceof CrashInjection,
  );
  assert.ok(await readPendingIntent(f.repoDir), "intent retained after crash");
  const r = await recoverIntent(f.ctx);
  assert.equal(r.status, "recovered");
  assert.deepEqual(await snapshot(f.root), { a: "new-a\n", b: "new-b\n", c: null });
  assert.equal(await readRef(f.gitdir, GROUP_REF), f.targetCommit);
  assert.equal(await readPendingIntent(f.repoDir), null, "intent cleared after done");
  await rm(f.base, { recursive: true, force: true });
});

test("boundary 2: crash mid-materialize with half-written path (postimage on disk, others preimage)", async () => {
  const f = await fixture("b2");
  // 物化进行中：a.txt 已 rename 出 target（postimage）、b/c 仍 preimage
  await assert.rejects(
    () => executeIntent(f.ctx, f.spec, { crashAt: (s) => { if (s === "materialized:0") throw new CrashInjection(s); } }),
    (e) => e instanceof CrashInjection,
  );
  const mid = await snapshot(f.root);
  assert.equal(mid.a, "new-a\n", "half-write: a.txt already materialized");
  assert.equal(mid.b, "old-b\n");
  assert.equal(mid.c, "old-c\n");
  const r = await recoverIntent(f.ctx);
  assert.equal(r.status, "recovered", "engine half-write must NOT be misjudged as user conflict");
  assert.deepEqual(await snapshot(f.root), { a: "new-a\n", b: "new-b\n", c: null });
  assert.equal(await readRef(f.gitdir, GROUP_REF), f.targetCommit);
  await rm(f.base, { recursive: true, force: true });
});

test("boundary 3+4: crash after ref advance, before done marker -> targetCommit branch, postimage-only verify + done backfill", async () => {
  const f = await fixture("b3");
  await assert.rejects(
    () => executeIntent(f.ctx, f.spec, { crashAt: (s) => { if (s === "ref-advanced") throw new CrashInjection(s); } }),
    (e) => e instanceof CrashInjection,
  );
  assert.equal(await readRef(f.gitdir, GROUP_REF), f.targetCommit, "ref already advanced");
  assert.ok(await readPendingIntent(f.repoDir), "done marker missing -> pending");
  const r = await recoverIntent(f.ctx);
  assert.equal(r.status, "recovered");
  assert.deepEqual(await snapshot(f.root), { a: "new-a\n", b: "new-b\n", c: null });
  assert.equal(await readRef(f.gitdir, GROUP_REF), f.targetCommit, "must NOT re-CAS or re-materialize");
  assert.equal(await readPendingIntent(f.repoDir), null);
  await rm(f.base, { recursive: true, force: true });
});

test("targetCommit branch refuses done when a path is NOT postimage (user moved files after ref advance)", async () => {
  const f = await fixture("b3u");
  await assert.rejects(
    () => executeIntent(f.ctx, f.spec, { crashAt: (s) => { if (s === "ref-advanced") throw new CrashInjection(s); } }),
    () => true,
  );
  // 用户在恢复前改了 b.txt（实际≠postimage 也≠preimage）→ 不得补 done
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(f.root, "b.txt"), "user-touched\n");
  const r = await recoverIntent(f.ctx);
  assert.equal(r.status, "conflicted");
  assert.equal(r.reason, "postimage-mismatch");
  assert.deepEqual(r.paths, ["b.txt"]);
  assert.ok(await readPendingIntent(f.repoDir), "intent scene retained for user decision");
  assert.equal(await readFile(path.join(f.root, "b.txt"), "utf8"), "user-touched\n", "user content preserved, never overwritten");
  await rm(f.base, { recursive: true, force: true });
});

test("scan-after-edit protection: user content edit / chmod-only edit -> conflicted, other paths recover", async () => {
  const f = await fixture("edit");
  await assert.rejects(
    () => executeIntent(f.ctx, f.spec, { crashAt: (s) => { if (s === "prepared") throw new CrashInjection(s); } }),
    () => true,
  );
  // 用户改动 1：a.txt 内容改写（既非 preimage 亦非 postimage）
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(f.root, "a.txt"), "user-new\n");
  // 用户改动 2：c.txt 仅 chmod +x（内容不变——判定元组含 mode，必须检出）
  await chmod(path.join(f.root, "c.txt"), 0o755);
  const r = await recoverIntent(f.ctx);
  assert.equal(r.status, "conflicted");
  assert.equal(r.reason, "user-edits");
  assert.deepEqual([...(r.paths ?? [])].sort(), ["a.txt", "c.txt"]);
  // 其余路径照常恢复
  assert.equal(await readFile(path.join(f.root, "b.txt"), "utf8"), "new-b\n");
  assert.equal(await readFile(path.join(f.root, "a.txt"), "utf8"), "user-new\n", "user edit preserved");
  const cSt = await (await import("node:fs/promises")).stat(path.join(f.root, "c.txt"));
  assert.ok(cSt.mode & 0o111, "chmod-only change preserved (not deleted by the pending delete op)");
  assert.equal(await readRef(f.gitdir, GROUP_REF), f.oldCommit, "ref NOT advanced while user edits conflict");
  assert.ok(await readPendingIntent(f.repoDir), "intent retained at scene");
  await rm(f.base, { recursive: true, force: true });
});

test("ref third state: currentRef is neither targetCommit nor oldRef -> stop, keep scene", async () => {
  const f = await fixture("moved");
  await assert.rejects(
    () => executeIntent(f.ctx, f.spec, { crashAt: (s) => { if (s === "prepared") throw new CrashInjection(s); } }),
    () => true,
  );
  // 第三方推进了 ref（其他值）
  const other = await writeCommitOid(f.gitdir, { message: "other", tree: (await (await import("../src/objects.mjs")).readCommitParsed(f.gitdir, f.oldCommit)).tree, parent: [f.oldCommit], authorName: "t", authorEmail: "t@t", timestamp: 3 });
  await writeRef(f.gitdir, GROUP_REF, other);
  const r = await recoverIntent(f.ctx);
  assert.equal(r.status, "conflicted");
  assert.equal(r.reason, "ref-moved");
  assert.ok(await readPendingIntent(f.repoDir));
  assert.equal(await readRef(f.gitdir, GROUP_REF), other);
  await rm(f.base, { recursive: true, force: true });
});

test("prepare rejects a second concurrent intent; materialization is idempotent on replay", async () => {
  const f = await fixture("dup");
  await assert.rejects(
    () => executeIntent(f.ctx, f.spec, { crashAt: (s) => { if (s === "prepared") throw new CrashInjection(s); } }),
    () => true,
  );
  await assert.rejects(() => executeIntent(f.ctx, f.spec), (e) => /intent already pending/.test(e.message));
  // 幂等重放：再次执行同 spec（先恢复）→ 内容/ref 一致
  await recoverIntent(f.ctx);
  const again = await executeIntent(f.ctx, { ...f.spec, oldRef: f.targetCommit, ops: [] });
  assert.ok(again.txId);
  await rm(f.base, { recursive: true, force: true });
});

test("intent files are 0600 and named per protocol (intent.json / intent.done.json)", async () => {
  const f = await fixture("perm");
  await executeIntent(f.ctx, f.spec);
  // 完成后已清理——重新 prepare 一个空事务检查权限
  await assert.rejects(
    () => executeIntent(f.ctx, { ref: GROUP_REF, targetCommit: f.targetCommit, oldRef: f.targetCommit, ops: [] }, { crashAt: (s) => { if (s === "prepared") throw new CrashInjection(s); } }),
    () => true,
  );
  const st = await (await import("node:fs/promises")).stat(path.join(f.repoDir, INTENT_FILE));
  assert.equal(st.mode & 0o777, 0o600, `intent log must be 0600 (got ${(st.mode & 0o777).toString(8)})`);
  assert.equal(path.basename(INTENT_DONE_FILE), "intent.done.json");
  await rm(f.base, { recursive: true, force: true });
});
