// 探针原语整理为仓内可复跑测试（webui-plugin-kernel Phase 3 / design §7.6——
// 探针两瑕疵已列实现义务：parent 闭包、CAS；probe-sync-engine.md 三实证对应）。
// 实证 1：isomorphic-git 对象级跨仓传输（无 git wire）——内容寻址逐字节一致；
// 实证 2：merge 边界——merge 编排自持（bothModified 非重叠自合并而非二分拒绝）；
// 实证 3：node-diff3 三场景（非重叠干净合并/同区冲突结构化 hunk/冲突标记可生成）；
// 义务 1：commit DAG parent 闭包（walkClosure 双向+缺失清单）；
// 义务 2：ref CAS（writeRef+read 比对——探针未证路径）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  writeObject,
  readObject,
  writeTreeFromFlat,
  writeCommitOid,
  writeRef,
  readRef,
  listRefsDirect,
  walkClosure,
  objectOid,
  mergeBase,
  deviceRef,
  GROUP_REF,
} from "../src/objects.mjs";
import { mergeTrees, diff3TextMerge, DIFF3_ALGO_VERSION } from "../src/merge.mjs";

const tmpBase = path.join(await import("node:os").then((m) => m.tmpdir()), "dweb-sync-probe-");

/**
 * @param {string} name
 */
async function freshGitdir(name) {
  const dir = `${tmpBase}-${name}-${process.pid}`;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
  return dir;
}

test("probe fact 1: object-level transfer between two gitdirs is byte-identical (no git wire)", async () => {
  const gd1 = await freshGitdir("gd1");
  const gd2 = await freshGitdir("gd2");
  // 嵌套树：顶层文件 + 子目录两文件（含可执行位）
  const blobA = await writeObject(gd1, "blob", new Uint8Array(Buffer.from("hello\n")));
  const blobB = await writeObject(gd1, "blob", new Uint8Array(Buffer.from("world\n")));
  const blobExec = await writeObject(gd1, "blob", new Uint8Array(Buffer.from("#!/bin/sh\n")));
  const treeOid = await writeTreeFromFlat(gd1, [
    { path: "top.txt", oid: blobA, mode: "100644" },
    { path: "sub/deep/x.txt", oid: blobB, mode: "100644" },
    { path: "sub/run.sh", oid: blobExec, mode: "100755" },
  ]);
  const commitOid = await writeCommitOid(gd1, { message: "seed", tree: treeOid, parent: [], authorName: "aa11aa22 device-a", authorEmail: "aa11aa22@device.sync", timestamp: 1_700_000_000_000 });
  // 对象级搬运：读原始字节（format content）→ 对端写入 → oid 逐字节一致断言
  for (const oid of [blobA, blobB, blobExec, treeOid, commitOid]) {
    const { type, bytes } = await readObject(gd1, oid);
    const oid2 = await writeObject(gd2, type, bytes);
    assert.equal(oid2, oid, `transported object ${oid} must be content-addressed identical`);
    const back = await readObject(gd2, oid);
    assert.deepEqual(Buffer.from(back.bytes), Buffer.from(bytes));
  }
  // 同构树重写 oid 稳定（两端收敛前提）
  const treeAgain = await writeTreeFromFlat(gd2, [
    { path: "sub/run.sh", oid: blobExec, mode: "100755" },
    { path: "top.txt", oid: blobA, mode: "100644" },
    { path: "sub/deep/x.txt", oid: blobB, mode: "100644" },
  ]);
  assert.equal(treeAgain, treeOid, "same flat entries (any order) must yield the same tree oid");
  await rm(gd1, { recursive: true, force: true });
  await rm(gd2, { recursive: true, force: true });
});

test("probe fact 2 + 3: bothModified non-overlap self-merges via diff3 (iso-git merge binary semantics not used)", async () => {
  // 实证 2 的核心：A 改第 1 行、B 改第 3 行——自持合并自动完成（不抛二分冲突）
  const base = "line1\nline2\nline3\nline4\nline5\n";
  const ours = "OURS1\nline2\nline3\nline4\nline5\n";
  const theirs = "line1\nline2\nline3\nTHEIRS4\nline5\n";
  const r = diff3TextMerge(ours, base, theirs);
  assert.equal(r.clean, true, "non-overlapping edits must auto-merge");
  assert.equal(r.text, "OURS1\nline2\nline3\nTHEIRS4\nline5\n");
  // 实证 3 场景 2：同一行不同改法——结构化冲突区 {a,o,b}（UI 选版本/并排的输入）
  const overlapOurs = "line1\nOURS2\nline3\n";
  const overlapTheirs = "line1\nTHEIRS2\nline3\n";
  const c = diff3TextMerge(overlapOurs, base, overlapTheirs);
  assert.equal(c.clean, false);
  assert.equal(c.hunks.length, 1);
  assert.deepEqual(c.hunks[0].a, ["OURS2"]);
  assert.deepEqual(c.hunks[0].o, ["line2"]);
  assert.deepEqual(c.hunks[0].b, ["THEIRS2"]);
  // 实证 3 场景 3：git 风格冲突标记文本可由结构化 hunk 生成（展示面）
  const marker = c.hunks.map((h) => `<<<<<<< ours\n${h.a.join("\n")}\n=======\n${h.b.join("\n")}\n>>>>>>> theirs`).join("\n");
  assert.match(marker, /<<<<<<< ours\nOURS2\n=======\nTHEIRS2\n>>>>>>> theirs/);
  // 算法版本标识冻结（冲突记录两端可复现判据）
  assert.match(DIFF3_ALGO_VERSION, /node-diff3/);
  // mergeTrees 层：非重叠 bothModified 自动合并（树级自持编排）
  const gd = await freshGitdir("gdm");
  const b0 = await writeObject(gd, "blob", new Uint8Array(Buffer.from(base)));
  const o1 = await writeObject(gd, "blob", new Uint8Array(Buffer.from(ours)));
  const t1 = await writeObject(gd, "blob", new Uint8Array(Buffer.from(theirs)));
  const mk = (oid) => new Map([["f.txt", { oid, mode: "100644", type: "blob" }]]);
  const out = await mergeTrees({ gitdir: gd, baseTree: mk(b0), oursTree: mk(o1), theirsTree: mk(t1) });
  assert.equal(out.conflicts.length, 0);
  assert.deepEqual(out.autoMerged, ["f.txt"]);
  const merged = await readObject(gd, out.mergedEntries[0].oid);
  assert.equal(Buffer.from(merged.bytes).toString("utf8"), "OURS1\nline2\nline3\nTHEIRS4\nline5\n");
  await rm(gd, { recursive: true, force: true });
});

test("probe obligation 1: commit DAG parent closure walk (with missing list)", async () => {
  const gd = await freshGitdir("gdc");
  const b1 = await writeObject(gd, "blob", new Uint8Array(Buffer.from("v1\n")));
  const b2 = await writeObject(gd, "blob", new Uint8Array(Buffer.from("v2\n")));
  const t1 = await writeTreeFromFlat(gd, [{ path: "a.txt", oid: b1, mode: "100644" }]);
  const t2 = await writeTreeFromFlat(gd, [{ path: "a.txt", oid: b2, mode: "100644" }]);
  const c1 = await writeCommitOid(gd, { message: "one", tree: t1, parent: [], authorName: "x", authorEmail: "x@x", timestamp: 1 });
  const c2 = await writeCommitOid(gd, { message: "two", tree: t2, parent: [c1], authorName: "x", authorEmail: "x@x", timestamp: 2 });
  const c3 = await writeCommitOid(gd, { message: "three", tree: t2, parent: [c2, c1], authorName: "x", authorEmail: "x@x", timestamp: 3 });
  // 全闭包：3 commits + 2 trees + 2 blobs
  const closure = await walkClosure(c3, async (oid) => {
    try {
      return await readObject(gd, oid);
    } catch {
      return null;
    }
  });
  assert.equal(closure.length, 7, "3 commits + 2 trees + 2 blobs");
  // 缺失：模拟对端缺 c1（闭包不全）→ 缺项清单含 c1（其 parent 链断）
  const gd2 = await freshGitdir("gdc2");
  for (const oid of [t2, b2]) {
    const { type, bytes } = await readObject(gd, oid);
    await writeObject(gd2, type, bytes);
  }
  await writeObject(gd2, "commit", (await readObject(gd, c2)).bytes);
  // 缺失对象自身的子树不可枚举（其 tree/blob 闭包无从得知）——缺项清单=精确的
  // 不可达根：c1（而非猜测其子树）
  await assert.rejects(
    () =>
      walkClosure(c2, async (oid) => {
        try {
          return await readObject(gd2, oid);
        } catch {
          return null;
        }
      }),
    (e) => e.code === "missing" && JSON.stringify(e.missing) === JSON.stringify([c1]),
  );
  // mergeBase：c3/c2 公共祖先
  assert.equal(await mergeBase(gd, c3, c2), c2);
  assert.equal(await mergeBase(gd, c2, c3), c2);
  await rm(gd, { recursive: true, force: true });
  await rm(gd2, { recursive: true, force: true });
});

test("probe obligation 2: ref CAS primitive (writeRef + read compare; device/group naming)", async () => {
  const gd = await freshGitdir("gdr");
  const blob = await writeObject(gd, "blob", new Uint8Array(Buffer.from("x\n")));
  const devA = deviceRef("aa11aa22aa33aa44");
  assert.equal(devA, "refs/devices/aa11aa22aa33aa44/main");
  assert.equal(await readRef(gd, devA), null, "absent ref reads null (CAS null baseline)");
  await writeRef(gd, GROUP_REF, blob);
  await writeRef(gd, devA, blob);
  assert.equal(await readRef(gd, GROUP_REF), blob);
  const refs = await listRefsDirect(gd);
  assert.deepEqual(refs, { [GROUP_REF]: blob, [devA]: blob });
  // 命名白名单（端点 push 目标校验的底座）
  await assert.rejects(() => writeRef(gd, "refs/heads/other", blob));
  await assert.rejects(() => writeRef(gd, "refs/heads/main/../../escape", blob));
  await rm(gd, { recursive: true, force: true });
});

test("objectOid equals git hash (blob/tree/commit loose object semantics)", async () => {
  const gd = await freshGitdir("gdo");
  const bytes = new Uint8Array(Buffer.from("sha-check\n"));
  const oid = await writeObject(gd, "blob", bytes);
  assert.equal(objectOid("blob", bytes), oid);
  await rm(gd, { recursive: true, force: true });
});
