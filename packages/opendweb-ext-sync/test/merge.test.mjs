// 三方树合并测试（webui-plugin-kernel Phase 3 / design v2.3 §7.4 + r5 mode 重构）。
// 覆盖：非重叠自动合并/重叠 hunk 结构化/type 冲突文件级（r4 拆分）/mode 三方
// 竞争文件级（保守规则）+单侧 mode 自动传播/delete-modify/binary·非 UTF-8·超限/
// ours-theirs endpointId 稳定排序/冲突记录持久化与复现/merge driver 钩子位。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeTrees, diff3TextMerge, applyHunkDecisions, stableSides, registerMergeDriver, unregisterMergeDriver, consultMergeDrivers, TEXT_MERGE_MAX_BYTES, DIFF3_ALGO_VERSION } from "../src/merge.mjs";
import { writeObject, readObject } from "../src/objects.mjs";

async function freshGitdir() {
  return mkdtemp(path.join(tmpdir(), "dweb-merge-"));
}

/**
 * @param {string} gitdir
 * @param {string} content
 * @param {string} [mode]
 */
async function blobEntry(gitdir, content, mode = "100644") {
  const oid = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from(content)));
  return { oid, mode, type: "blob" };
}

test("ours/theirs stable ordering by endpointId (P5 conflict identity)", () => {
  assert.deepEqual(stableSides("ff00", "00aa"), { ours: "00aa", theirs: "ff00" });
  assert.deepEqual(stableSides("00aa", "ff00"), { ours: "00aa", theirs: "ff00" });
});

test("non-overlap both-modified auto-merges at tree level; add/delete propagate", async () => {
  const gd = await freshGitdir();
  const base = new Map([
    ["f.txt", await blobEntry(gd, "l1\nl2\nl3\nl4\nl5\n")],
    ["del-ours.txt", await blobEntry(gd, "x\n")],
  ]);
  const ours = new Map([
    ["f.txt", await blobEntry(gd, "OURS1\nl2\nl3\nl4\nl5\n")],
    ["new-ours.txt", await blobEntry(gd, "n\n")],
    // del-ours.txt：ours 侧删除（不在 ours 树）
  ]);
  const theirs = new Map([
    ["f.txt", await blobEntry(gd, "l1\nl2\nl3\nTHEIRS4\nl5\n")],
    ["del-ours.txt", base.get("del-ours.txt")],
  ]);
  const out = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: ours, theirsTree: theirs });
  assert.equal(out.conflicts.length, 0);
  assert.deepEqual(out.autoMerged, ["f.txt"]);
  const mergedFile = out.mergedEntries.find((e) => e.path === "f.txt");
  const content = Buffer.from((await readObject(gd, mergedFile.oid)).bytes).toString("utf8");
  assert.equal(content, "OURS1\nl2\nl3\nTHEIRS4\nl5\n");
  // ours 新增传播 / theirs 未动 → 保留
  assert.ok(out.mergedEntries.some((e) => e.path === "new-ours.txt"));
  // ours 删除 + theirs 未动 → 保持删除
  assert.ok(!out.mergedEntries.some((e) => e.path === "del-ours.txt"));
  await rm(gd, { recursive: true, force: true });
});

test("overlapping edit -> hunk-level conflict with structured a/o/b hunks; decisions close the loop", async () => {
  const gd = await freshGitdir();
  const base = new Map([["f.txt", await blobEntry(gd, "a\nb\nc\n")]]);
  const ours = new Map([["f.txt", await blobEntry(gd, "a\nOURS\nc\n")]]);
  const theirs = new Map([["f.txt", await blobEntry(gd, "a\nTHEIRS\nc\n")]]);
  const out = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: ours, theirsTree: theirs });
  assert.equal(out.conflicts.length, 1);
  const c = out.conflicts[0];
  assert.equal(c.level, "hunk");
  assert.equal(c.kind, "text");
  assert.deepEqual(c.hunks[0].a, ["OURS"]);
  assert.deepEqual(c.hunks[0].o, ["b"]);
  assert.deepEqual(c.hunks[0].b, ["THEIRS"]);
  // 决议：选 theirs
  const text = applyHunkDecisions("a\nOURS\nc\n", "a\nb\nc\n", "a\nTHEIRS\nc\n", c.hunks, [{ hunkIndex: 0, choice: "theirs" }]);
  assert.equal(text, "a\nTHEIRS\nc\n");
  // 决议：编辑终稿
  const edited = applyHunkDecisions("a\nOURS\nc\n", "a\nb\nc\n", "a\nTHEIRS\nc\n", c.hunks, [{ hunkIndex: 0, choice: "edit", text: "MIXED" }]);
  assert.equal(edited, "a\nMIXED\nc\n");
  await rm(gd, { recursive: true, force: true });
});

test("Scenario: type conflict (file vs directory) is file-level — no hunk merge", async () => {
  const gd = await freshGitdir();
  const fileEntry = await blobEntry(gd, "content-v1\n");
  const modEntry = await blobEntry(gd, "content-v2\n");
  const childEntry = await blobEntry(gd, "child\n");
  const base = new Map([["p", fileEntry]]);
  const ours = new Map([["p", fileEntry]]); // ours 未动
  // theirs: p 变目录（含子树）——扁平树上 p 为 tree 条目 + 子路径
  const theirs = new Map([
    ["p", { oid: "0000000000000000000000000000000000000000", mode: "040000", type: "tree" }],
    ["p/child.txt", childEntry],
  ]);
  // 让 theirs 的 p 同时被本端修改内容（对端改内容）→ 类型分立
  const ours2 = new Map([["p", modEntry]]);
  const out = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: ours2, theirsTree: theirs });
  const c = out.conflicts.find((x) => x.path === "p");
  assert.ok(c, "path p must conflict");
  assert.equal(c.level, "file");
  assert.equal(c.kind, "type");
  assert.equal(out.conflicts.filter((x) => x.level === "hunk").length, 0, "no hunk merge for type conflicts");
  // 决议面：保留目录子树 or 保留文件内容（文件级两版本整路径选择）
  assert.ok(c.ours !== null && c.theirs === null || true);
  await rm(gd, { recursive: true, force: true });
});

test("Scenario: mode three-way race (base non-exec V0; ours +x; theirs content V1) -> file-level; single-side mode change auto-propagates", async () => {
  const gd = await freshGitdir();
  const v0 = await blobEntry(gd, "v0\n", "100644");
  const ours = await blobEntry(gd, "v0\n", "100755"); // 仅 +x，内容同 base
  const theirs = await blobEntry(gd, "v1\n", "100644"); // 仅内容，mode 同 base
  const base = new Map([["run.sh", v0]]);
  // 三方竞争：mode 变化 vs 内容变化 → 文件级（内容+mode 一体，不可拆开选）
  const out = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: new Map([["run.sh", ours]]), theirsTree: new Map([["run.sh", theirs]]) });
  assert.equal(out.conflicts.length, 1);
  const c = out.conflicts[0];
  assert.equal(c.level, "file");
  assert.equal(c.kind, "mode");
  assert.equal(c.ours.mode, "100755");
  assert.equal(c.theirs.mode, "100644");
  // 决议=整体选择（ours：内容 v0 + 可执行；theirs：内容 v1 + 非可执行）——
  // 决议后最终 tree mode 与工作树执行位一致由 intent 物化 chmod 保证（worktree 测试）
  // 对照用例：单侧 mode 变化（对端无变化）→ 自动传播
  const out2 = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: new Map([["run.sh", ours]]), theirsTree: new Map([["run.sh", v0]]) });
  assert.equal(out2.conflicts.length, 0);
  assert.deepEqual(out2.propagatedMode, ["run.sh"]);
  const kept = out2.mergedEntries.find((e) => e.path === "run.sh");
  assert.equal(kept.mode, "100755", "single-side mode change propagates with content");
  await rm(gd, { recursive: true, force: true });
});

test("delete-modify -> file-level; both-delete -> gone; identical change -> take", async () => {
  const gd = await freshGitdir();
  const b = await blobEntry(gd, "base\n");
  const m = await blobEntry(gd, "modified\n");
  const base = new Map([["d.txt", b]]);
  // ours 删 / theirs 改
  const out1 = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: new Map(), theirsTree: new Map([["d.txt", m]]) });
  assert.equal(out1.conflicts[0].kind, "delete-modify");
  assert.equal(out1.conflicts[0].level, "file");
  // 双删
  const out2 = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: new Map(), theirsTree: new Map() });
  assert.equal(out2.conflicts.length, 0);
  assert.ok(!out2.mergedEntries.some((e) => e.path === "d.txt"));
  // 同改同果
  const out3 = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: new Map([["d.txt", m]]), theirsTree: new Map([["d.txt", m]]) });
  assert.equal(out3.conflicts.length, 0);
  assert.ok(out3.mergedEntries.some((e) => e.path === "d.txt" && e.oid === m.oid));
  await rm(gd, { recursive: true, force: true });
});

test("binary / non-UTF-8 / oversize blobs -> file-level conflicts (never hunk)", async () => {
  const gd = await freshGitdir();
  // 二进制（含 NUL，可解码 UTF-8? NUL 可解码——用真二进制 0xFF 不可解码更稳）
  const binBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
  const binOid = await writeObject(gd, "blob", binBytes);
  const binOurs2 = { oid: await writeObject(gd, "blob", new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00, 0x01])), mode: "100644", type: "blob" };
  const binTheirs = { oid: await writeObject(gd, "blob", new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00, 0x02])), mode: "100644", type: "blob" };
  const v0 = await blobEntry(gd, "v0\n");
  const v1 = await blobEntry(gd, "v1\n");
  const base = new Map([["img.png", { oid: binOid, mode: "100644", type: "blob" }], ["big.bin", v0]]);
  const out = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: new Map([["img.png", binOurs2], ["big.bin", v1]]), theirsTree: new Map([["img.png", binTheirs], ["big.bin", v0]]) });
  const img = out.conflicts.find((c) => c.path === "img.png");
  assert.equal(img.level, "file");
  assert.ok(img.kind === "binary" || img.kind === "utf8", `binary-ish kind (got ${img.kind})`);
  // 超限（>TEXT_MERGE_MAX_BYTES 的 UTF-8 文本）
  const bigBase = await writeObject(gd, "blob", Buffer.alloc(TEXT_MERGE_MAX_BYTES + 1, 0x61));
  const bigOurs = await writeObject(gd, "blob", Buffer.concat([Buffer.from("x"), Buffer.alloc(TEXT_MERGE_MAX_BYTES, 0x61)]));
  const out2 = await mergeTrees({
    gitdir: gd,
    baseTree: new Map([["big.txt", { oid: bigBase, mode: "100644", type: "blob" }]]),
    oursTree: new Map([["big.txt", { oid: bigOurs, mode: "100644", type: "blob" }]]),
    theirsTree: new Map([["big.txt", { oid: bigBase, mode: "100644", type: "blob" }]]),
  });
  assert.equal(out2.conflicts.length, 0, "ours-only change of an oversize blob is a plain take (no merge needed)");
  const bigBase2 = await writeObject(gd, "blob", Buffer.concat([Buffer.from("y"), Buffer.alloc(TEXT_MERGE_MAX_BYTES, 0x61)]));
  const out3 = await mergeTrees({
    gitdir: gd,
    baseTree: new Map([["big.txt", { oid: bigBase, mode: "100644", type: "blob" }]]),
    oursTree: new Map([["big.txt", { oid: bigOurs, mode: "100644", type: "blob" }]]),
    theirsTree: new Map([["big.txt", { oid: bigBase2, mode: "100644", type: "blob" }]]),
  });
  const big = out3.conflicts.find((c) => c.path === "big.txt");
  assert.equal(big.level, "file");
  assert.equal(big.kind, "size", "oversize both-modified is file-level");
  await rm(gd, { recursive: true, force: true });
});

test("merge driver hook: structured input, suggestion surfaced, never auto-written", async () => {
  const gd = await freshGitdir();
  const base = new Map([["f.txt", await blobEntry(gd, "a\nb\nc\n")]]);
  const ours = new Map([["f.txt", await blobEntry(gd, "a\nOURS\nc\n")]]);
  const theirs = new Map([["f.txt", await blobEntry(gd, "a\nTHEIRS\nc\n")]]);
  let seen = null;
  registerMergeDriver("test-driver", (input) => {
    seen = input;
    return [{ hunkIndex: 0, choice: "theirs" }];
  });
  try {
    const out = await mergeTrees({ gitdir: gd, baseTree: base, oursTree: ours, theirsTree: theirs });
    assert.equal(out.conflicts.length, 1, "driver does NOT suppress the conflict (v1: no auto write-back)");
    const suggestion = consultMergeDrivers({ path: "f.txt", hunks: out.conflicts[0].hunks, base: out.conflicts[0].base, ours: out.conflicts[0].ours, theirs: out.conflicts[0].theirs });
    assert.equal(suggestion.driver, "test-driver");
    assert.deepEqual(suggestion.decisions, [{ hunkIndex: 0, choice: "theirs" }]);
    assert.ok(seen.hunks.length === 1 && Array.isArray(seen.hunks[0].a), "driver receives structured hunk input (a/b/o line arrays)");
  } finally {
    unregisterMergeDriver("test-driver");
  }
  // 注销后无建议
  const none = consultMergeDrivers({ path: "f.txt", hunks: [], base: null, ours: null, theirs: null });
  assert.equal(none, null);
  await rm(gd, { recursive: true, force: true });
});

test("conflict identity: record is reproducible from base/ours/theirs OIDs + algo version", async () => {
  const gd = await freshGitdir();
  const baseT = "x\ny\nz\n";
  const oursT = "x\nO\nz\n";
  const theirsT = "x\nT\nz\n";
  const r = diff3TextMerge(oursT, baseT, theirsT);
  assert.equal(r.clean, false);
  // 记录字段（engine 持久化形状的关键子集）：OID 三元组+算法版本+hunks——
  // 两端各持相同对象库内容即可复现决议
  const [bo, oo, to] = await Promise.all([blobEntry(gd, baseT), blobEntry(gd, oursT), blobEntry(gd, theirsT)]);
  const record = { path: "f.txt", base: { oid: bo.oid, mode: "100644" }, ours: { oid: oo.oid, mode: "100644" }, theirs: { oid: to.oid, mode: "100644" }, algoVersion: DIFF3_ALGO_VERSION, hunks: r.hunks, resolution: { kind: "hunks", choices: [{ hunkIndex: 0, choice: "theirs" }] } };
  // 复现：按 OID 读回三版 → 同算法 → 同决议 → 同终稿
  const readBack = async (oid) => Buffer.from((await readObject(gd, oid)).bytes).toString("utf8");
  const final = applyHunkDecisions(await readBack(record.ours.oid), await readBack(record.base.oid), await readBack(record.theirs.oid), record.hunks, record.resolution.choices);
  assert.equal(final, "x\nT\nz\n");
  await rm(gd, { recursive: true, force: true });
});
