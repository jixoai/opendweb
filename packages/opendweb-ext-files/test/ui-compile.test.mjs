// UI 面编译与算法校验（FileBrowserPage.svelte 经 webui 的 svelte 编译器编译；
// sha256.ts 对照 node:crypto 随机向量）。webui 构建不编译未接线组件——本测试
// 填补该缺口（组件由接线方后续挂入 plugin-pages.ts）。svelte/esbuild 从
// webui node_modules 借用（仓库内存在性探测，缺席则 skip——外部环境如
// webui 未装依赖时不假红）。

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WEBUI = path.resolve(import.meta.dirname, "../../webui");

async function importFromWebui(rel) {
  try {
    return await import(pathToFileURL(path.join(WEBUI, rel)).href);
  } catch {
    return null;
  }
}

test("FileBrowserPage.svelte compiles clean with the webui svelte compiler (runes mode)", async () => {
  const mod = await importFromWebui("node_modules/svelte/compiler/index.js");
  if (mod === null) return; // webui 依赖未装——skip（绿门环境必装）
  const compile = mod.compile ?? mod.default?.compile;
  const file = path.join(WEBUI, "ui/src/components/plugins/files/FileBrowserPage.svelte");
  const out = compile(fs.readFileSync(file, "utf8"), { generate: "client" });
  // a11y/未定义引用等告警不应出现（0 warnings 门）
  assert.deepEqual(
    out.warnings.map((w) => w.code ?? w.message),
    [],
    "FileBrowserPage 编译必须零告警",
  );
});

test("ui sha256.ts matches node:crypto across sizes and update splits (esbuild-transpiled)", async () => {
  const esbuildMod = await importFromWebui("node_modules/esbuild/lib/main.js");
  if (esbuildMod === null) return;
  const esbuild = esbuildMod.default ?? esbuildMod;
  const src = path.join(WEBUI, "ui/src/components/plugins/files/sha256.ts");
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "sha256-t-"));
  try {
    await esbuild.build({
      entryPoints: [src],
      bundle: true,
      format: "esm",
      platform: "neutral",
      outfile: path.join(outdir, "sha256.mjs"),
    });
    const { Sha256 } = await import(pathToFileURL(path.join(outdir, "sha256.mjs")).href);
    // 向量：空、小、块边界邻域（63/64/65/127/128/129）、1MiB、5MiB+odd、多段 update
    for (const size of [0, 1, 3, 55, 63, 64, 65, 127, 128, 129, 1000, 65535, 65536, 65537, 1024 * 1024, 5 * 1024 * 1024 + 13]) {
      const data = new Uint8Array(size);
      crypto.getRandomValues(data);
      const expect = crypto.createHash("sha256").update(data).digest("hex");
      assert.equal(new Sha256().update(data).digestHex(), expect, `size=${size}`);
      // 多段切分（每段 7B 与 随机切两种）
      const h1 = new Sha256();
      for (let i = 0; i < data.length; i += 7) h1.update(data.subarray(i, Math.min(i + 7, data.length)));
      assert.equal(h1.digestHex(), expect, `split7 size=${size}`);
      const h2 = new Sha256();
      let off = 0;
      while (off < data.length) {
        const take = 1 + Math.floor(Math.random() * 4096);
        h2.update(data.subarray(off, Math.min(off + take, data.length)));
        off += take;
      }
      if (data.length === 0) h2.update(new Uint8Array(0));
      assert.equal(h2.digestHex(), expect, `random-split size=${size}`);
    }
    // digest 后不可复用
    const spent = new Sha256().update(new Uint8Array(1));
    spent.digestHex();
    assert.throws(() => spent.update(new Uint8Array(1)), /digest already taken/);
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
});
