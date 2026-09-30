// r9-B1 确定性竞态测试（webui-plugin-kernel 归档阻塞 B1 闭合验收）。
// 四类 TOCTOU（Codex r9 点名）以 opts.readHook 显式注入——不 sleep 赌时序：
//   ① lstat/fstat 预检通过后文件增长（>1MiB → oversize-history 停读；未超限 →
//     读毕长度复核 worktree-race size-changed）；
//   ② 普通文件在分诊与受控读取之间替换为指向根外的 symlink（O_NOFOLLOW ELOOP）；
//   ③ 目录在父级 listing 与递归之间替换为根外 symlink（O_DIRECTORY|O_NOFOLLOW
//     ELOOP）；以及 open 与 readdir 之间替换（verified-walk 身份复核拦截）；
//   ④ intent 恢复分诊期间（pathStateTuple 受控读取）替换为根外 symlink。
// 每用例断言：稳定错误码、device/group ref 零变化、对象库零超限/零根外内容
// （根外哨兵字符串不出现在任何松散对象里）、intent 现场按协议保留（④）。
// 另含非竞态基线对照：受控扫描对混合树（文件/exec/嵌套/symlink）结果与旧语义一致。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile, readFile, readdir, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { makeRoot, ID_A } from "./helpers.mjs";
import { scanWorktree } from "../src/worktree.mjs";
import { objectOid, hasObject, readRef, writeRef, writeObject, writeTreeFromFlat, writeCommitOid, GROUP_REF, deviceRef } from "../src/objects.mjs";
import { prepareIntent, recoverIntent, intentPaths } from "../src/intent.mjs";

const MIB = 1024 * 1024;

/** gitdir 松散对象文件全列表（objects/xx/38hex）。 @param {string} gitdir */
async function looseObjectFiles(gitdir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} p */
  async function walk(p) {
    let ents;
    try {
      ents = await readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const c = path.join(p, ent.name);
      if (ent.isDirectory()) await walk(c);
      else if (ent.isFile() && /^[0-9a-f]{38}$/.test(ent.name)) out.push(c);
    }
  }
  await walk(path.join(gitdir, "objects"));
  return out;
}

/** 对象库全部内容拼接（哨兵检索用——根外内容必须零出现）。 @param {string} gitdir */
async function objectStoreText(gitdir) {
  const parts = [];
  for (const f of await looseObjectFiles(gitdir)) {
    parts.push(inflateSync(await readFile(f)).toString("latin1"));
  }
  return parts.join("\n");
}

test("anchored scan baseline: mixed tree (file/exec/nested/symlink) yields identical entries and oids", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-base-out-"));
  const root = await makeRoot({ "a.txt": "A", "d/b.bin": Uint8Array.from([1, 2, 3]) });
  const gitdir = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-git-"));
  try {
    await symlink(outside, path.join(root, "d", "link")); // 根外 symlink：记录、不跟随
    await chmod(path.join(root, "a.txt"), 0o755); // exec 位
    const entries = await scanWorktree(root, gitdir, { maxFileBytes: MIB });
    assert.deepEqual(
      entries.map((e) => e.path),
      ["a.txt", "d", "d/b.bin", "d/link"],
    );
    const byPath = new Map(entries.map((e) => [e.path, e]));
    assert.equal(byPath.get("a.txt").kind, "file");
    assert.equal(byPath.get("a.txt").mode, 0o100755);
    assert.equal(byPath.get("a.txt").oid, objectOid("blob", Buffer.from("A")));
    assert.deepEqual(byPath.get("d"), { path: "d", kind: "dir", oid: null, mode: null });
    assert.equal(byPath.get("d/b.bin").oid, objectOid("blob", Uint8Array.from([1, 2, 3])));
    assert.deepEqual(byPath.get("d/link"), { path: "d/link", kind: "symlink", oid: null, mode: null });
    assert.equal(await hasObject(gitdir, objectOid("blob", Buffer.from("A"))), true);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(gitdir, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test("race-1 growth after precheck (TOCTOU-1): file grows past 1MiB after the fstat precheck -> oversize-history mid-read, zero history", async () => {
  const root = await makeRoot({ "grow.bin": Buffer.alloc(256 * 1024, 0x41) });
  const gitdir = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-git-"));
  try {
    const appended = Buffer.alloc(MIB + 4096, 0x42);
    // 注入点：受控原语 file-read 阶段（open+fstat 预检已通过、首块读取前）追加
    // >1MiB——旧「lstat 预检→按路径 readFile」会把超限内容整块带进 blob
    await assert.rejects(
      () =>
        scanWorktree(root, gitdir, {
          maxFileBytes: MIB,
          readHook: async (phase, info) => {
            if (phase === "file-read" && info.rel === "grow.bin") {
              await appendFile(path.join(root, "grow.bin"), appended);
            }
          },
        }),
      (e) => e.code === "oversize-history" && e.path === "grow.bin" && e.limit === MIB && e.size > MIB,
    );
    const grownOid = objectOid("blob", Buffer.concat([Buffer.alloc(256 * 1024, 0x41), appended]));
    assert.equal(await hasObject(gitdir, grownOid), false, "oversize content never becomes a blob");
    assert.equal((await looseObjectFiles(gitdir)).length, 0, "zero objects written (scan aborted before writeBlob)");
    assert.equal(await readRef(gitdir, GROUP_REF), null, "group ref zero change");
    assert.equal(await readRef(gitdir, deviceRef(ID_A)), null, "device ref zero change");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(gitdir, { recursive: true, force: true }).catch(() => {});
  }
});

test("race-1b in-limit growth during the anchored read -> worktree-race size-changed (length re-check, fail-closed)", async () => {
  const root = await makeRoot({ "grow.txt": "abc" });
  const gitdir = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-git-"));
  try {
    // 注入点：同 race-1，但增长未超限——读毕长度复核（total≠fstat size）拦截
    await assert.rejects(
      () =>
        scanWorktree(root, gitdir, {
          maxFileBytes: MIB,
          readHook: async (phase, info) => {
            if (phase === "file-read" && info.rel === "grow.txt") {
              await appendFile(path.join(root, "grow.txt"), "defg");
            }
          },
        }),
      (e) => e.code === "worktree-race" && e.reason === "size-changed" && e.path === "grow.txt",
    );
    assert.equal((await looseObjectFiles(gitdir)).length, 0, "zero objects written");
    assert.equal(await readRef(gitdir, GROUP_REF), null, "group ref zero change");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(gitdir, { recursive: true, force: true }).catch(() => {});
  }
});

test("race-2 file swapped to outside symlink (TOCTOU-2): stable symlink-swap error, zero blobs, sentinel never read", async () => {
  const SENTINEL = "DWEB-R9-B1-OUTSIDE-SENTINEL-file-2a7f01";
  const outside = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-out-"));
  const root = await makeRoot({ "swap.bin": "in-root" });
  const gitdir = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-git-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), SENTINEL);
    // 注入点：受控原语 file-open 阶段（分类后、open 前）把普通文件换成指向根外
    // 的 symlink——旧 readFile 会跟随链接把根外内容读进对象库
    await assert.rejects(
      () =>
        scanWorktree(root, gitdir, {
          readHook: async (phase, info) => {
            if (phase === "file-open" && info.rel === "swap.bin") {
              await rm(path.join(root, "swap.bin"), { force: true });
              await symlink(path.join(outside, "secret.txt"), path.join(root, "swap.bin"));
            }
          },
        }),
      (e) => e.code === "worktree-race" && e.reason === "symlink-swap" && e.path === "swap.bin",
    );
    assert.equal((await objectStoreText(gitdir)).includes(SENTINEL), false, "outside-root sentinel content never read into any object");
    assert.equal((await looseObjectFiles(gitdir)).length, 0, "zero blobs written");
    assert.equal(await readRef(gitdir, GROUP_REF), null, "group ref zero change");
    assert.equal(await readRef(gitdir, deviceRef(ID_A)), null, "device ref zero change");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(gitdir, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test("race-3a directory swapped to outside symlink before recursion (TOCTOU-3): O_DIRECTORY|O_NOFOLLOW rejects, canary never enters the scan", async () => {
  const SENTINEL = "DWEB-R9-B1-OUTSIDE-CANARY-dir-91c3";
  const outside = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-out-"));
  const root = await makeRoot({ "keep.txt": "k", "sub/inner.txt": "i" });
  const gitdir = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-git-"));
  try {
    await writeFile(path.join(outside, "canary.txt"), SENTINEL);
    // 注入点：受控原语 dir-open 阶段（父级 listing 后、子目录锚定 open 前）把
    // 子目录换成根外 symlink——旧递归 walk(childAbs) 的 readdir 会跟随目录链接
    await assert.rejects(
      () =>
        scanWorktree(root, gitdir, {
          readHook: async (phase, info) => {
            if (phase === "dir-open" && info.rel === "sub") {
              await rm(path.join(root, "sub"), { recursive: true, force: true });
              await symlink(outside, path.join(root, "sub"));
            }
          },
        }),
      (e) => e.code === "worktree-race" && e.reason === "symlink-swap" && e.path === "sub",
    );
    assert.equal((await objectStoreText(gitdir)).includes(SENTINEL), false, "outside canary never enters the object store");
    assert.equal((await looseObjectFiles(gitdir)).length, 1, "only the file scanned before the swapped dir");
    assert.equal(await hasObject(gitdir, objectOid("blob", Buffer.from("k"))), true);
    assert.equal(await readRef(gitdir, GROUP_REF), null, "group ref zero change");
    assert.equal(await readRef(gitdir, deviceRef(ID_A)), null, "device ref zero change");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(gitdir, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test("race-3b directory swapped between anchored open and readdir: verified-walk identity re-check rejects before any child is consumed", async () => {
  const SENTINEL = "DWEB-R9-B1-OUTSIDE-CANARY-id-5b8e22";
  const outside = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-out-"));
  const root = await makeRoot({ "keep.txt": "k", "sub/inner.txt": "i" });
  const gitdir = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-git-"));
  try {
    await writeFile(path.join(outside, "canary.txt"), SENTINEL);
    // 注入点：dir-readdir 阶段（子目录已 open+fstat 锚定、readdir 前）换 symlink
    // ——readdir 按路径跟随了根外链接，但读后身份复核（lstat vs fstat dev/ino）
    // 在消费任何条目前 fail-closed
    await assert.rejects(
      () =>
        scanWorktree(root, gitdir, {
          readHook: async (phase, info) => {
            if (phase === "dir-readdir" && info.rel === "sub") {
              await rm(path.join(root, "sub"), { recursive: true, force: true });
              await symlink(outside, path.join(root, "sub"));
            }
          },
        }),
      (e) => e.code === "worktree-race" && e.reason === "directory-identity" && e.path === "sub",
    );
    assert.equal((await objectStoreText(gitdir)).includes(SENTINEL), false, "outside canary never enters the object store");
    assert.equal((await looseObjectFiles(gitdir)).length, 1, "only keep.txt was scanned; identity check fired before consuming listed entries");
    assert.equal(await readRef(gitdir, GROUP_REF), null, "group ref zero change");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(gitdir, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test("race-4 recovery triage replacement (TOCTOU-4): pathStateTuple hits symlink swap -> stable worktree-race, intent preserved, refs untouched", async () => {
  const SENTINEL = "DWEB-R9-B1-OUTSIDE-SENTINEL-triage-4e19";
  const outside = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-out-"));
  const root = await makeRoot({ "f.txt": "user-edit\n" });
  const home = await mkdtemp(path.join(tmpdir(), "dweb-r9b1-home-"));
  const repoDir = path.join(home, "g1", "r1");
  const gitdir = path.join(repoDir, "git");
  try {
    await mkdir(repoDir, { recursive: true });
    await writeFile(path.join(outside, "s.txt"), SENTINEL);
    // 现场装配：GROUP_REF==targetCommit（分诊走「只接受 postimage」分支）
    const postOid = await writeObject(gitdir, "blob", Buffer.from("post\n"));
    const tree = await writeTreeFromFlat(gitdir, [{ path: "f.txt", oid: postOid, mode: "100644" }]);
    const commit = await writeCommitOid(gitdir, { message: "seed", tree, parent: [], authorName: "t", authorEmail: "t@t", timestamp: Date.now() });
    await writeRef(gitdir, GROUP_REF, commit);
    await prepareIntent({ repoDir }, {
      ref: GROUP_REF,
      targetCommit: commit,
      oldRef: commit,
      ops: [{ op: "write", path: "f.txt", pre: null, post: { oid: postOid, type: "blob", mode: 0o100644 } }],
    });
    // 注入点：分诊 pathStateTuple 的 file-open 阶段（lstat 分类后、受控 open 前）
    // 把目标换成根外 symlink——旧实现 readFile 跟随读根外内容入对象库
    await assert.rejects(
      () =>
        recoverIntent({ repoDir, root, gitdir }, {
          readHook: async (phase, info) => {
            if (phase === "file-open" && info.rel === "f.txt") {
              await rm(path.join(root, "f.txt"), { force: true });
              await symlink(path.join(outside, "s.txt"), path.join(root, "f.txt"));
            }
          },
        }),
      (e) => e.code === "worktree-race" && e.reason === "symlink-swap" && e.path === "f.txt",
    );
    // intent 现场按协议保留（分诊被拒：不补 done、不清 intent——交 conflicted 处置）
    const { intent, done } = intentPaths(repoDir);
    assert.equal(await readFile(intent, "utf8").then(() => true, () => false), true, "intent record preserved");
    assert.equal(await readFile(done, "utf8").then(() => true, () => false), false, "done marker NOT written");
    // ref/tree/commit 零变化
    assert.equal(await readRef(gitdir, GROUP_REF), commit, "group ref unchanged");
    assert.equal(await readRef(gitdir, deviceRef(ID_A)), null, "device ref zero change");
    assert.equal((await objectStoreText(gitdir)).includes(SENTINEL), false, "outside-root sentinel never read");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});
