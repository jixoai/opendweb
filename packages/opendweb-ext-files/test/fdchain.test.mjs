// fd 链路径安全测试（design v2.3 §6 r2-B2 + spec「路径逃逸与 symlink 防护」的
// 静态面；并发竞态在 wire-scenarios.test.mjs）。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WIN32_DEGRADATION_NOTE,
  WireFsError,
  openRootFd,
  pathSafetyCapability,
  resetCapabilityCacheForTest,
  validateComponents,
  withResolved,
  EXPECT,
} from "../src/fdchain.mjs";
import { tempFixture } from "./util.mjs";

test("capability probe runs and reports an honest mode with evidence", async () => {
  resetCapabilityCacheForTest();
  const cap = await pathSafetyCapability({ force: true });
  assert.ok(cap.mode === "fd-chain" || cap.mode === "verified-walk" || cap.mode === "unsupported");
  assert.ok(cap.evidence.length > 0);
  if (cap.mode === "fd-chain") {
    assert.ok(typeof cap.prefix === "string" && cap.prefix.startsWith("/"));
    // 安全力探针必须实证四要素（子开/O_NOFOLLOW 拒 symlink/换名钉定/变更器）
    assert.match(cap.evidence.join("\n"), /fd-pinned traversal verified/);
  }
  if (cap.mode === "verified-walk") {
    // 降级必须显式（不静默弱化）：evidence 载明边界
    assert.match(cap.evidence.join("\n"), /documented degradation/);
  }
});

test("win32 degradation note is explicit and non-empty (no silent weakening)", () => {
  assert.ok(WIN32_DEGRADATION_NOTE.length > 80);
  assert.match(WIN32_DEGRADATION_NOTE, /win32/i);
  assert.match(WIN32_DEGRADATION_NOTE, /openat|\/dev\/fd/);
});

test("validateComponents: first-line defense rejects escape shapes, normalizes benign ones", () => {
  // 越界拒绝
  for (const bad of ["../x", "a/../b", "..", "a/..", "/abs", "/etc/passwd", "a\0b"]) {
    const v = validateComponents(bad);
    assert.equal(v.ok, false, bad);
    assert.equal(v.code, "ESCAPE", bad);
  }
  // 深度/长度上限
  assert.equal(validateComponents("a/".repeat(65) + "b").ok, false);
  assert.equal(validateComponents("x".repeat(256)).ok, false);
  assert.equal(validateComponents("x".repeat(4097)).ok, false);
  // 良性归一
  assert.deepEqual(validateComponents(""), { ok: true, components: [] });
  assert.deepEqual(validateComponents("docs/"), { ok: true, components: ["docs"] });
  assert.deepEqual(validateComponents("a//b/./c"), { ok: true, components: ["a", "b", "c"] });
  assert.deepEqual(validateComponents("a+b c"), { ok: true, components: ["a+b c"] });
});

test("withResolved walks components with per-component symlink rejection and fstat type recheck", async () => {
  const cap = await pathSafetyCapability();
  if (cap.mode === "unsupported") return; // win32：不可达（share 创建已拒）
  const { home, rootDir, cleanup } = tempFixture();
  try {
    const fd = await openRootFd(rootDir);
    const st = fs.fstatSync(fd);
    const root = { rootFd: fd, rootPath: rootDir, rootIno: st.ino, rootDev: st.dev };
    // 正常两跳：docs/nested/deep.txt
    const got = await withResolved(cap, root, ["docs", "nested", "deep.txt"], { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, expect: EXPECT.FILE }, async (t) => {
      return { name: t.name, isFile: t.stat.isFile() };
    });
    assert.deepEqual(got, { name: "deep.txt", isFile: true });
    // root 内 symlink 终组件 → SYMLINK（ELOOP 映射）
    fs.symlinkSync(path.join(rootDir, "hello.txt"), path.join(rootDir, "docs", "file-link"));
    await assert.rejects(
      withResolved(cap, root, ["docs", "file-link"], { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, expect: EXPECT.FILE }, async () => 1),
      (e) => e instanceof WireFsError && e.code === "SYMLINK",
    );
    // root 内 symlink 目录组件 → 拒
    fs.symlinkSync(path.join(rootDir, "docs", "nested"), path.join(rootDir, "docs", "dir-link"));
    await assert.rejects(
      withResolved(cap, root, ["docs", "dir-link", "deep.txt"], { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, expect: EXPECT.FILE }, async () => 1),
      (e) => e instanceof WireFsError && (e.code === "SYMLINK" || e.code === "NOT_DIR" || e.code === "NOT_FOUND"),
    );
    // 期望 file 但是目录 → IS_DIR（fstat 复核）
    await assert.rejects(
      withResolved(cap, root, ["docs"], { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, expect: EXPECT.FILE }, async () => 1),
      (e) => e instanceof WireFsError && e.code === "IS_DIR",
    );
    // 期望 dir 但是文件 → NOT_DIR
    await assert.rejects(
      withResolved(cap, root, ["hello.txt"], { flags: fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW, expect: EXPECT.DIR }, async () => 1),
      (e) => e instanceof WireFsError,
    );
    fs.closeSync(fd);
  } finally {
    cleanup();
  }
});

test("verified-walk mode: replacing the share root directory itself fails closed (ROOT_GONE)", async () => {
  const cap = await pathSafetyCapability();
  if (cap.mode !== "verified-walk") return; // fd-chain 模式：root fd 即锚，无此判定面
  const { home, rootDir, cleanup } = tempFixture();
  try {
    const fd = await openRootFd(rootDir);
    const st = fs.fstatSync(fd);
    const root = { rootFd: fd, rootPath: rootDir, rootIno: st.ino, rootDev: st.dev };
    // 攻击者把 root 目录换名（fd 仍持有）并在原路径放新目录（诱饵）
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret"), "SECRET");
    fs.renameSync(rootDir, `${rootDir}-moved`);
    fs.mkdirSync(rootDir);
    fs.symlinkSync(outside, path.join(rootDir, "ln"));
    await assert.rejects(
      withResolved(cap, root, ["ln", "secret"], { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, expect: EXPECT.FILE }, async () => 1),
      (e) => e instanceof WireFsError && e.code === "ROOT_GONE",
    );
    fs.closeSync(fd);
  } finally {
    cleanup();
  }
});
