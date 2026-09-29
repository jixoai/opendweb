// 单元面测试（webui-plugin-kernel Phase 3）：descriptor 过验（webui 契约权威源
// 跨包直调）/ 组账本 / ignore 语义 / util 原语 / UI view-model 纯函数。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncWebuiPluginDescriptor } from "../src/webui-plugin.mjs";
import { createGroup, deleteGroup, loadLedger, findGroup, gitdirFor, repoDir } from "../src/ledger.mjs";
import { loadRootIgnore, parseIgnoreLines, buildMatcher } from "../src/ignore.mjs";
import { atomicWrite0600, acquireFileLock, createMutex, readBoundedBody } from "../src/util.mjs";

// 跨包导入 webui 契约权威源（测试期相对路径——运行时零依赖不受影响；与
// webui/test/contract.test.mjs 同纪律）
const { validateWebuiPluginDescriptor } = await import("../../webui/src/core/plugins/contract.mjs");

test("descriptor passes the webui contract validator (pages=groups,status,conflicts)", () => {
  const d = syncWebuiPluginDescriptor();
  const v = validateWebuiPluginDescriptor(d);
  assert.ok(v.ok, v.ok ? "" : v.error);
  assert.equal(d.id, "sync");
  assert.deepEqual(
    d.pages.map((p) => p.id),
    ["groups", "status", "conflicts"],
  );
  assert.equal(d.pages.every((p) => p.type === "page"), true, "plugin-specific Svelte pages");
  assert.equal(d.dataEndpoints[0].path, "/wpk1/sync");
  // 每次调用新对象（纯数据工厂——防共享可变状态）
  assert.notEqual(syncWebuiPluginDescriptor(), d);
});

test("group ledger: create/validate/idempotent replay/delete; gitdir layout", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dweb-ledger-"));
  try {
    const input = {
      name: "agents-skills",
      members: [
        { endpointId: "aa11aa22aa33aa44aa55aa66aa77aa88", deviceName: "iMac" },
        { endpointId: "bb11bb22bb33bb44bb55bb66bb77bb88", deviceName: "mini" },
      ],
      roots: [{ localPath: "/tmp/agents-skills", mode: "twoway", seedAuthority: "aa11aa22aa33aa44aa55aa66aa77aa88" }],
    };
    const r1 = await createGroup(home, { ...input, id: "g1" }, { now: () => 1 });
    assert.ok(r1.ok);
    assert.equal(gitdirFor(home, "g1", "r1"), path.join(home, "plugins", "sync", "g1", "r1", "git"), "gitdir independent of the user root");
    // 幂等重放（同形状）
    const r2 = await createGroup(home, { ...input, id: "g1" }, { now: () => 2 });
    assert.ok(r2.ok);
    // 同 id 不同形状 → 拒绝
    const r3 = await createGroup(home, { ...input, id: "g1", roots: [{ ...input.roots[0], mode: "oneway" }] }, { now: () => 3 });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, "conflict");
    // 非法形状 → invalid（非 hex endpoint/相对路径/未知 mode/seed 非成员）
    assert.equal((await createGroup(home, { name: "x", members: [{ endpointId: "zz", deviceName: "z" }], roots: [{ localPath: "/a", seedAuthority: null }] })).code, "invalid");
    assert.equal((await createGroup(home, { name: "x", members: input.members, roots: [{ localPath: "rel/path", seedAuthority: null }] })).code, "invalid");
    assert.equal((await createGroup(home, { name: "x", members: input.members, roots: [{ localPath: "/a", mode: "both", seedAuthority: null }] })).code, "invalid");
    assert.equal((await createGroup(home, { name: "x", members: input.members, roots: [{ localPath: "/a", seedAuthority: "cc11cc22" }] })).code, "invalid");
    // 删除
    const del = await deleteGroup(home, "g1", { now: () => 4 });
    assert.ok(del.ok);
    const ledger = await loadLedger(home);
    assert.equal(findGroup(ledger, "g1"), null);
    // N 成员账本形状支持（v1 执行仍 pairwise [W8]——账本记录 N）
    const r5 = await createGroup(home, { name: "n", members: [...input.members, { endpointId: "cc11cc22cc33cc44", deviceName: "third" }], roots: [{ localPath: "/a", seedAuthority: null }] });
    assert.ok(r5.ok);
    assert.equal((await loadLedger(home)).groups[0].members.length, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ignore semantics: gitignore subset + .dweb-sync/exclude + implicit .git/.dweb-sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dweb-ignore-"));
  try {
    await writeFile(path.join(root, ".gitignore"), [
      "# comment",
      "node_modules/",
      "*.log",
      "/build/",
      "temp*",
      "!keep.log",
      "deep/inner.txt",
      "**/dist",
      "",
    ].join("\n"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, ".dweb-sync"), { recursive: true });
    await writeFile(path.join(root, ".dweb-sync", "exclude"), "extra-dir/\nprivate.*\n");
    const isIgnored = await loadRootIgnore(root);
    const cases = [
      ["node_modules", true, true],
      ["node_modules/x/deep.js", true, false],
      ["a.log", true, false],
      ["keep.log", false, false],
      ["build", true, true],
      ["build/out.js", true, false],
      ["src/build", true, true], // **/dist 类的目录规则；build 只锚定根——src/build 不受 /build/ 影响
      ["temporary", true, false],
      ["deep/inner.txt", true, false],
      ["other.txt", false, false],
      ["pkg/dist", true, true],
      ["extra-dir", true, true],
      ["private.key", true, false],
      [".git", true, true],
      [".git/config", true, false],
      [".dweb-sync", true, true],
      [".dweb-sync/exclude", true, false],
    ];
    for (const [p, dir, isDir] of cases) {
      assert.equal(isIgnored(p, isDir), dir, `ignore(${p}, dir=${isDir})`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseIgnoreLines + buildMatcher: negate beats earlier match (last match wins)", () => {
  const rules = parseIgnoreLines("*.txt\n!keep.txt\n", "test");
  const m = buildMatcher(rules);
  assert.equal(m("a.txt", false), true);
  assert.equal(m("keep.txt", false), false);
});

test("util: atomicWrite0600 perms + symlink refusal; mutex serializes; bounded body", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dweb-util-"));
  try {
    const file = path.join(dir, "state.json");
    await atomicWrite0600(file, '{"a":1}\n');
    const st = await (await import("node:fs/promises")).stat(file);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(await readFile(file, "utf8"), '{"a":1}\n');
    // symlink 拒绝
    const { symlink } = await import("node:fs/promises");
    const link = path.join(dir, "link.json");
    await symlink(path.join(dir, "outside.json"), link);
    await assert.rejects(() => atomicWrite0600(link, "x"));
    // 互斥串行（顺序保持）
    const mutex = createMutex();
    /** @type {number[]} */
    const order = [];
    await Promise.all([
      mutex.run("a", async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); }),
      mutex.run("b", async () => { order.push(2); }),
    ]);
    assert.deepEqual(order, [1, 2]);
    // 有界体：超限立即抛
    await assert.rejects(() => readBoundedBody(new Uint8Array(10), 5), (e) => e.code === "body-too-large");
    async function* stream() {
      yield new Uint8Array(4);
      yield new Uint8Array(4);
      yield new Uint8Array(4);
    }
    await assert.rejects(() => readBoundedBody(stream(), 10), (e) => e.code === "body-too-large");
    // 文件锁：获取/释放/再获取
    const l1 = await acquireFileLock(path.join(dir, "res"), { now: () => 1 });
    assert.ok(l1.ok);
    const l2 = await acquireFileLock(path.join(dir, "res"), { now: () => 2 });
    assert.equal(l2.ok, false, "second acquisition within window fails");
    await l1.release();
    const l3 = await acquireFileLock(path.join(dir, "res"), { now: () => 3 });
    assert.ok(l3.ok);
    await l3.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- UI view-model 纯函数（packages/webui/ui/src/components/plugins/sync/） ----
const vm = await import("../../webui/ui/src/components/plugins/sync/view-model.ts");

test("view-model: phase labels/tones, bytes, seed three-way buckets, decision completeness", () => {
  assert.equal(vm.phaseLabel("scanning"), "扫描本地");
  assert.equal(vm.phaseLabel("conflicted"), "待决议");
  assert.match(vm.phaseTone("done"), /emerald/);
  assert.equal(vm.modeLabel("oneway"), "单向（只读镜像）");
  assert.equal(vm.formatBytes(2048), "2.0 KiB");
  assert.equal(vm.progressPercent({ fetched: 1, fetchTotal: 4, bytes: 0 }), 25);
  assert.equal(vm.progressPercent({ fetched: 0, fetchTotal: 0, bytes: 0 }), null);
  // seed 三方对照四桶
  const block = {
    threeWay: {
      base: { label: "empty baseline", entries: [] },
      seed: { label: "s", entries: [{ path: "a.txt", oid: "o1", mode: "100644" }, { path: "same.txt", oid: "oS", mode: "100644" }] },
      local: { label: "l", entries: [{ path: "b.txt", oid: "o2", mode: "100644" }, { path: "same.txt", oid: "oS", mode: "100644" }] },
    },
  };
  const rows = vm.classifySeedThreeWay(block);
  assert.deepEqual(
    rows.map((r) => [r.path, r.bucket]),
    [
      ["a.txt", "seed-only"],
      ["b.txt", "local-only"],
      ["same.txt", "same"],
    ],
  );
  // 决议完整性：hunk 数不足/编辑缺文本/整缺 → missing
  const session = {
    algoVersion: "v",
    baseCommit: "b",
    oursCommit: "o",
    theirsCommit: "t",
    oursEndpoint: "e",
    conflicts: [
      { id: "1", path: "f.txt", level: "hunk", kind: "text", base: null, ours: null, theirs: null, hunks: [{ a: [], o: [], b: [], aIndex: 0, oIndex: 0, bIndex: 0 }, { a: [], o: [], b: [], aIndex: 1, oIndex: 1, bIndex: 1 }], detail: null, resolution: null },
      { id: "2", path: "g.txt", level: "file", kind: "binary", base: null, ours: null, theirs: null, hunks: [], detail: null, resolution: null },
    ],
  };
  assert.deepEqual(vm.missingDecisions(session, {}), ["f.txt", "g.txt"]);
  assert.deepEqual(
    vm.missingDecisions(session, {
      "f.txt": { level: "hunk", choices: [{ hunkIndex: 0, choice: "ours" }] }, // 少一块
      "g.txt": { level: "file", choice: "theirs" },
    }),
    ["f.txt"],
  );
  assert.deepEqual(
    vm.missingDecisions(session, {
      "f.txt": { level: "hunk", choices: [{ hunkIndex: 0, choice: "ours" }, { hunkIndex: 1, choice: "edit" }] }, // edit 缺 text
      "g.txt": { level: "file", choice: "theirs" },
    }),
    ["f.txt"],
  );
  assert.deepEqual(
    vm.missingDecisions(session, {
      "f.txt": { level: "hunk", choices: [{ hunkIndex: 0, choice: "ours" }, { hunkIndex: 1, choice: "edit", text: "ok" }] },
      "g.txt": { level: "file", choice: "edit", contentBase64: "eA==" },
    }),
    [],
  );
});
