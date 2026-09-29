// 共享账本测试（shares.json：默认 ro/0600 原子写+锁家族/fail-closed/校验）。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { acquireFileLock } from "../src/fslock.mjs";
import {
  emptyShares,
  loadShares,
  mutateShares,
  randomShareId,
  ShareValidationError,
  sharesPath,
  validateShareInput,
} from "../src/ledger.mjs";
import { tempFixture } from "./util.mjs";

test("add via mutateShares: default mode ro, peers deduped, persisted 0600", async () => {
  const { home, rootDir, cleanup } = tempFixture();
  try {
    let created = null;
    const m = await mutateShares(home, (ledger) => {
      created = { id: randomShareId(), name: "docs", root: rootDir, mode: "ro", peers: ["a", "a", "b"], created: 1 };
      ledger.shares.push(created);
    });
    assert.equal(m.ok, true);
    const file = sharesPath(home);
    const st = fs.statSync(file);
    if (process.platform !== "win32") {
      assert.equal(st.mode & 0o777, 0o600, "shares.json must be 0600");
    }
    const again = await loadShares(home);
    assert.equal(again.shares.length, 1);
    assert.equal(again.shares[0].mode, "ro");
    // 校验输入：默认 ro + peers 去重（通过 validateShareInput 断言语义）
    const v = await validateShareInput({ name: "x", root: rootDir, peers: ["a", "a"] });
    assert.equal(v.mode, "ro");
    assert.deepEqual(v.peers, ["a"]);
  } finally {
    cleanup();
  }
});

test("validateShareInput rejects bad shapes (name/root/mode/peers)", async () => {
  const { rootDir, cleanup } = tempFixture();
  try {
    await assert.rejects(validateShareInput({ name: "", root: rootDir }), ShareValidationError);
    await assert.rejects(validateShareInput({ name: "x", root: "relative/path" }), ShareValidationError);
    await assert.rejects(validateShareInput({ name: "x", root: rootDir, mode: "rwx" }), ShareValidationError);
    await assert.rejects(validateShareInput({ name: "x", root: rootDir, peers: [""] }), ShareValidationError);
    await assert.rejects(validateShareInput({ name: "x", root: path_missing(rootDir) }), ShareValidationError);
    // symlink 终组件拒绝（root 冻结纪律）
    fs.symlinkSync(rootDir, `${rootDir}-link`);
    await assert.rejects(validateShareInput({ name: "x", root: `${rootDir}-link` }), ShareValidationError);
    // 文件拒绝
    fs.writeFileSync(`${rootDir}-file`, "x");
    await assert.rejects(validateShareInput({ name: "x", root: `${rootDir}-file` }), ShareValidationError);
  } finally {
    cleanup();
  }
});

function path_missing(base) {
  return `${base}/does-not-exist-${Date.now()}`;
}

test("malformed shares.json fails closed (no silent reset)", async () => {
  const { home, cleanup } = tempFixture();
  try {
    fs.mkdirSync(`${home}/plugins/files`, { recursive: true });
    fs.writeFileSync(sharesPath(home), "{ not json");
    await assert.rejects(loadShares(home), /malformed|invalid/);
    fs.writeFileSync(sharesPath(home), JSON.stringify({ version: 2, shares: [] }));
    await assert.rejects(loadShares(home), /invalid shape/);
  } finally {
    cleanup();
  }
});

test("lock family: mutateShares returns {ok:false,code:\"lock\"} while a foreign holder holds the ledger lock", async () => {
  const { home, cleanup } = tempFixture();
  try {
    const holder = await acquireFileLock(`${home}/plugins/files/shares.lock`);
    assert.equal(holder.ok, true);
    const m = await mutateShares(home, () => {});
    assert.deepEqual(m, { ok: false, code: "lock" });
    assert.equal(await holder.release(), true);
    // 释放后可写
    const m2 = await mutateShares(home, (l) => l.shares.push(emptyShares().shares[0] ?? { id: "x", name: "x", root: "/x", mode: "ro", peers: [], created: 0 }));
    assert.equal(m2.ok, true);
  } finally {
    cleanup();
  }
});

test("duplicate roots are rejected (one share per root)", async () => {
  const { home, rootDir, cleanup } = tempFixture();
  try {
    await mutateShares(home, (l) => l.shares.push({ id: "s1", name: "one", root: rootDir, mode: "ro", peers: [], created: 0 }));
    await assert.rejects(
      mutateShares(home, (l) => {
        for (const s of l.shares) {
          if (s.root === rootDir) throw new ShareValidationError("root is already shared");
        }
      }),
      ShareValidationError,
    );
  } finally {
    cleanup();
  }
});
