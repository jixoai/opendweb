// 路径逃逸与 symlink 防护测试（spec Scenario 2——r2-B2 验收门）。
// 四类：../ 越界 / 绝对路径注入 / root 内 symlink / 并发父目录替换竞态。
//
// 竞态测试按平台能力自适应（fdchain.pathSafetyCapability——不静默弱化）：
// - fd-chain 平台（linux /proc/self/fd 等真原语）：完整本地攻击者竞态——
//   攻击者循环把中间目录替换为指向诱饵目录的 symlink，同时并发读写请求；
//   断言诱饵目录零字节副作用（受监控快照）+ 零字节越界读（响应内容永不含
//   诱饵 canary）。
// - verified-walk 平台（本机 darwin——/dev/fd 无遍历原语，实证见 fdchain.mjs
//   模块头）：(a) 本地攻击者 vs 并发读：断言零越界读（终 fd 使用前的身份
//   复核保证）——写逃逸不在此模式的主张范围（文档化降级）；(b) wire 对端
//   攻击者（rw peer 经 handler 的 rename/delete/mkdir 循环）vs 并发读写：
//   全操作互斥保证零诱饵副作用（该平台的主张面）。

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createFilesRuntime } from "../src/runtime.mjs";
import { createHandlerTransport, createWireFilesController } from "../src/client.mjs";
import { fakeRequest, snapshotTree, tempFixture } from "./util.mjs";

async function setupEnv(opts = {}) {
  const fixture = tempFixture();
  const rt = await createFilesRuntime({
    home: fixture.home,
    log: () => {},
    resolvePeer: async (sid) => (sid.startsWith("s-good") ? "ep-a" : sid.startsWith("s-evil") ? "ep-b" : null),
  });
  await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
  const share = await rt.shares.add({ name: "docs", root: fixture.rootDir, mode: "rw", peers: ["ep-a", "ep-b"] });
  const clientFor = (sid) => createWireFilesController(createHandlerTransport(rt.handler, { sessionId: sid }), { shareId: share.id });
  return { fixture, rt, share, clientFor };
}

// ---- 类 1/2：../ 越界与绝对路径注入（纯字符串防线，无竞态面）------------------------

test("escape: '..' traversal and absolute path injection rejected across every op; outside untouched", async () => {
  const env = await setupEnv();
  try {
    const c = env.clientFor("s-good-1");
    const badPaths = ["../outside-canary", "docs/../../escape", "..", "docs/../.."];
    for (const p of badPaths) {
      await assert.rejects(c.stat(p), (e) => e.status === 400, p);
      const lst = await env.rt.handler(fakeRequest({ sessionId: "s-good-1", method: "GET", path: `/wpk1/files/${env.share.id}/list?path=${encodeURIComponent(p)}` }).request);
      assert.equal(lst.status, 400, p);
      const rd = await env.rt.handler(fakeRequest({ sessionId: "s-good-1", method: "GET", path: `/wpk1/files/${env.share.id}/read?path=${encodeURIComponent(p)}&offset=0&len=4` }).request);
      assert.equal(rd.status, 400, p);
      const mk = await env.rt.handler(fakeRequest({ sessionId: "s-good-1", method: "POST", path: `/wpk1/files/${env.share.id}/mkdir`, body: [Buffer.from(JSON.stringify({ path: p }))] }).request);
      assert.equal(mk.status, 400, p);
      const del = await env.rt.handler(fakeRequest({ sessionId: "s-good-1", method: "POST", path: `/wpk1/files/${env.share.id}/delete`, body: [Buffer.from(JSON.stringify({ path: p }))] }).request);
      assert.equal(del.status, 400, p);
      await assert.rejects(c.uploadFile(p, new Uint8Array(10)).catch((e) => { throw e; }), (e) => e.status === 400, p);
    }
    for (const p of ["/etc/passwd", "/tmp", "///x"]) {
      const res = await env.rt.handler(fakeRequest({ sessionId: "s-good-1", method: "GET", path: `/wpk1/files/${env.share.id}/list?path=${encodeURIComponent(p)}` }).request);
      assert.equal(res.status, 400, p);
    }
    // 百分号编码的遍历（%2e%2e）同样在解码后拒绝
    const enc = await env.rt.handler(fakeRequest({ sessionId: "s-good-1", method: "GET", path: `/wpk1/files/${env.share.id}/list?path=%2e%2e%2foutside` }).request);
    assert.equal(enc.status, 400);
  } finally {
    await env.rt.onDispose();
    env.fixture.cleanup();
  }
});

// ---- 类 3：root 内 symlink（每组件 O_NOFOLLOW 拒绝）-------------------------------

test("symlinks inside root: rejected on every component; never followed for read/list/delete/upload", async () => {
  const env = await setupEnv();
  const root = env.fixture.rootDir;
  const outside = path.join(env.fixture.home, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET");
  try {
    // 文件 symlink（指向 root 外）
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "file-link"));
    // 目录 symlink（中间组件）
    fs.symlinkSync(outside, path.join(root, "docs", "dir-link"));
    const c = env.clientFor("s-good-1");
    await assert.rejects(c.downloadFile("file-link"), (e) => e.status === 400);
    await assert.rejects(c.stat("file-link"), (e) => e.status === 400);
    // 经目录 symlink 读其内容 → 拒（每级组件都 O_NOFOLLOW）
    const mid = await env.rt.handler(fakeRequest({ sessionId: "s-good-1", method: "GET", path: `/wpk1/files/${env.share.id}/read?path=docs/dir-link/secret.txt&offset=0&len=10` }).request);
    assert.equal(mid.status, 400);
    // list 经 symlink 目录 → 拒
    const lst = await env.rt.handler(fakeRequest({ sessionId: "s-good-1", method: "GET", path: `/wpk1/files/${env.share.id}/list?path=docs/dir-link` }).request);
    assert.equal(lst.status, 400);
    // delete 经 symlink：unlink 删的是链接本身（POSIX 不跟随）——root 外目标不动
    await c.remove("file-link");
    assert.equal(fs.existsSync(path.join(outside, "secret.txt")), true, "诱饵目标未被删");
    assert.equal(fs.existsSync(path.join(root, "file-link")), false, "链接本身已删");
    // 上传目标路径里的 symlink 组件 → 拒
    await assert.rejects(c.uploadFile("docs/dir-link/planted.bin", new Uint8Array(16)), (e) => e.status === 400);
    assert.equal(fs.existsSync(path.join(outside, "planted.bin")), false);
    // list 不显示 symlink 条目（不暴露）
    const rootList = await c.list("");
    assert.equal(rootList.entries.some((e) => e.name === "file-link"), false);
  } finally {
    await env.rt.onDispose();
    env.fixture.cleanup();
  }
});

// ---- 类 4：并发父目录替换竞态（r2-B2 验收门）--------------------------------------

/**
 * 诱饵监控：攻击者把 <root>/docs 反复替换为指向 decoy 的 symlink。
 * @param {number} ms 持续时间
 * @param {() => Promise<void>} victimLoop 并发受害者循环
 * @param {{ root: string, decoy: string, canary: string }} ctx
 */
async function raceRound(ms, victimLoop, ctx) {
  const stopAt = Date.now() + ms;
  const attacker = (async () => {
    let flip = false;
    while (Date.now() < stopAt) {
      try {
        if (flip) {
          // 真目录回位：symlink → 真目录
          fs.rmSync(path.join(ctx.root, "docs"), { force: true });
          fs.mkdirSync(path.join(ctx.root, "docs", "nested"), { recursive: true });
          fs.writeFileSync(path.join(ctx.root, "docs", "nested", "deep.txt"), "deep");
        } else {
          // 替换为指向诱饵的 symlink
          fs.rmSync(path.join(ctx.root, "docs"), { recursive: true, force: true });
          fs.symlinkSync(ctx.decoy, path.join(ctx.root, "docs"));
        }
        flip = !flip;
      } catch {
        /* 并发冲突（受害者 rename/delete 也会动这棵树）——继续循环 */
      }
      await new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 3)));
    }
  })();
  const victims = await victimLoop(stopAt);
  await attacker;
  return victims;
}

test("concurrent parent-directory replacement race (capability-adaptive): zero byte-level escape", async () => {
  const env = await setupEnv();
  const root = env.fixture.rootDir;
  const decoy = path.join(env.fixture.home, "decoy");
  fs.mkdirSync(path.join(decoy, "nested"), { recursive: true });
  fs.writeFileSync(path.join(decoy, "nested", "deep.txt"), "DECOY-CANARY-CONTENT");
  fs.writeFileSync(path.join(decoy, "loot-drop.txt"), "pre-existing");
  const cap = env.rt.capability;
  try {
    /** @type {Array<{ok: boolean, leaked: boolean, status: number | null}>} */
    const outcomes = [];
    const reader = env.clientFor("s-good-1");
    const victimLoop = async (stopAt) => {
      const workers = Array.from({ length: 4 }, async () => {
        while (Date.now() < stopAt) {
          try {
            const out = await reader.downloadFile("docs/nested/deep.txt", { chunkBytes: 1024 * 1024 });
            const text = Buffer.from(out.bytes).toString();
            outcomes.push({ ok: true, leaked: text.includes("DECOY-CANARY"), status: null });
          } catch (e) {
            const status = /** @type {{status?: number}} */ (e).status ?? -1;
            // 只接受干净拒绝（400 系）；500 系视为缺陷
            outcomes.push({ ok: status >= 400 && status < 500, leaked: false, status });
          }
        }
      });
      return Promise.all(workers);
    };
    const before = snapshotTree(decoy);
    const victims = await raceRound(cap.mode === "fd-chain" ? 1200 : 800, victimLoop, { root, decoy, canary: "DECOY-CANARY" });
    void victims;
    // 1) 永不泄露诱饵内容（两种平台的主张面——终 fd 使用前的链身份复核保证）
    assert.ok(outcomes.length > 50, `并发采样充足（实际 ${outcomes.length}）`);
    assert.equal(outcomes.some((o) => o.leaked), false, "零字节越界读：响应永不含诱饵内容");
    // 2) 失败只允许 400 系干净拒绝
    const badServerErrors = outcomes.filter((o) => o.status !== null && o.status >= 500);
    assert.equal(badServerErrors.length, 0, `500 系错误=缺陷：${JSON.stringify(badServerErrors.slice(0, 3))}`);
    // 3) 诱饵目录零副作用（fd-chain 平台全量断言；verified-walk 本地攻击者的写面不在主张范围）
    const after = snapshotTree(decoy);
    if (cap.mode === "fd-chain") {
      assert.deepEqual(after, before, "fd-chain：诱饵目录零字节副作用");
    } else {
      // verified-walk：读面零泄露已断言；诱饵只可能被本地写竞态污染（文档化边界）——
      // 本测试的受害者只有读，所以诱饵必须恒等
      assert.deepEqual(after, before, "verified-walk：读受害者下诱饵零副作用");
    }
  } finally {
    await env.rt.onDispose();
    env.fixture.cleanup();
  }
});

test("wire-peer race (serialized ops): rw peer mutating via wire vs concurrent read/write — zero decoy side effects on both capability modes", async () => {
  const env = await setupEnv();
  const root = env.fixture.rootDir;
  const decoy = path.join(env.fixture.home, "decoy2");
  fs.mkdirSync(path.join(decoy, "nested"), { recursive: true });
  fs.writeFileSync(path.join(decoy, "nested", "deep.txt"), "DECOY2-CANARY");
  const good = env.clientFor("s-good-1");
  const evil = env.clientFor("s-evil-1");
  const stopAt = Date.now() + 1000;
  try {
    /** @type {string[]} */
    const leaked = [];
    const readers = Array.from({ length: 3 }, async () => {
      while (Date.now() < stopAt) {
        try {
          const out = await good.downloadFile("docs/nested/deep.txt", { chunkBytes: 1024 * 1024 });
          if (Buffer.from(out.bytes).toString().includes("DECOY2")) leaked.push("read");
        } catch {
          /* 干净拒绝或 404（攻击者删了目录） */
        }
      }
    });
    const writers = Array.from({ length: 2 }, async () => {
      let i = 0;
      while (Date.now() < stopAt) {
        try {
          await good.uploadFile(`docs/w${i++ % 5}.bin`, crypto.randomBytes(2048));
        } catch {
          /* 攻击者动了父目录——干净拒绝 */
        }
      }
    });
    // 攻击者：仅经 wire（本平台全部变更共享一闸串行）
    const attacker = (async () => {
      let flip = false;
      while (Date.now() < stopAt) {
        try {
          if (flip) {
            await evil.remove("docs/dir-link");
          } else {
            await evil.rename("docs", "docs-x").catch(async () => {
              await evil.rename("docs-x", "docs");
            });
            if (fs.existsSync(path.join(root, "docs-x")) && !fs.existsSync(path.join(root, "docs"))) {
              // 恢复（受害者需要 docs 存在）
              await evil.rename("docs-x", "docs");
            }
          }
        } catch {
          /* 并发冲突——续 */
        }
        flip = !flip;
        await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 4)));
      }
    })();
    await Promise.all([...readers, ...writers, attacker]);
    const after = snapshotTree(decoy);
    assert.equal(leaked.length, 0, "零字节越界读（wire 对端竞态）");
    assert.equal(Object.keys(after).includes("w0.bin"), false, "诱饵目录零写入副作用");
    assert.equal(fs.existsSync(path.join(decoy, "w0.bin")), false);
  } finally {
    await env.rt.onDispose();
    env.fixture.cleanup();
  }
});
