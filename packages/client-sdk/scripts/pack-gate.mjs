#!/usr/bin/env node
// pack 发布物门禁（sdk-mgmt-surface task 2.4；design §2.1「发布物门禁」，与
// app-protocol-layer 共用同一份，后合并者负责跑通）。
//
// 流程：
//   1. 干净 tmp 目录 `npm pack --pack-destination`
//   2. tarball 清单断言：admin/ token/ 目录（.mjs + .d.mts）在发布物内
//   3. 解包进真实 node_modules 布局后**删除全部 *.node**（无 native 环境）
//   4. 子进程 import("@jixo/opendweb-client-sdk/admin"|"/token") 成功 +
//      形状断言；同时断言 native 根入口在该环境必然加载失败（门禁有牙齿：
//      证明环境真无 native，admin/token 未传递加载它）
//   5. tsc --noEmit 类型检查双过（消费者 .ts 按 NodeNext 经 exports map 解
//      .d.mts）
//
// 实现注记：任务书建议「NODE_PATH 指向解包目录」——ESM 解析器不读 NODE_PATH
// （Node 文档明示），-e 裸模块名会静默失败；改用真实 node_modules 布局 +
// 消费者文件（等价且更严格的「外部消费者」形态）。
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const NAME = pkg.name;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dweb-pack-gate-"));
const fail = (msg) => {
  console.error(`pack-gate: FAIL ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`pack-gate: ok ${msg}`);

try {
  // 1. npm pack → 干净目录（scoped 包产物名为 jixo-<name>-<version>.tgz——
  // 不拼名字，直接读目录里唯一的 .tgz）
  execFileSync("npm", ["pack", "--silent", "--pack-destination", tmp], {
    cwd: pkgDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarballs = fs.readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one tarball after npm pack, got: ${tarballs.join(", ")}`);
  }
  const tarball = path.join(tmp, tarballs[0]);
  ok(`npm pack → ${path.basename(tarball)}`);

  // 2. 清单断言（files 数组含 admin/token；exports 目标文件随目录进入）
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const required = [
    "package/admin/index.mjs",
    "package/admin/index.d.mts",
    "package/token/index.mjs",
    "package/token/index.d.mts",
    "package/index.js",
    "package/index.d.ts",
    "package/net/index.js",
    "package/http/index.js",
  ];
  for (const f of required) {
    if (!entries.includes(f)) fail(`tarball missing ${f}`);
  }
  ok(`tarball 清单含 admin/ token/（${required.length} 项关键文件全在）`);

  // 3. 解包 → 真实 node_modules 布局 → 删除 *.node（无 native 环境）
  const root = path.join(tmp, "consumer");
  const scopeDir = path.dirname(path.join(root, "node_modules", NAME));
  fs.mkdirSync(scopeDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", scopeDir]);
  fs.renameSync(path.join(scopeDir, "package"), path.join(root, "node_modules", NAME));
  const stripped = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".node")) {
        fs.rmSync(p);
        stripped.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, "node_modules", NAME));
  if (stripped.length === 0) fail("发布物中未发现任何 .node（files 数组异常）");
  ok(`解包并删除 native 二进制：${stripped.join(", ")}`);

  // 4. 无 .node 环境的 self-reference import（子进程；根入口必须失败）
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
  fs.writeFileSync(
    path.join(root, "smoke.mjs"),
    `import assert from "node:assert/strict";
const admin = await import(${JSON.stringify(`${NAME}/admin`)});
assert.equal(typeof admin.AdminClient, "function");
assert.equal(typeof admin.AdminError, "function");
assert.equal(typeof admin.receiptCanonical, "function");
assert.equal(typeof admin.verifyReceipt, "function");
assert.equal(typeof admin.adminPublicKeyFromServices, "function");
const token = await import(${JSON.stringify(`${NAME}/token`)});
assert.equal(typeof token.decodeInvite, "function");
assert.equal(typeof token.decodeCapability, "function");
assert.equal(typeof token.TokenError, "function");
let rootFailed = false;
try {
  await import(${JSON.stringify(NAME)});
} catch {
  rootFailed = true;
}
assert.ok(rootFailed, "native 根入口在无 .node 环境必须加载失败（证明环境真无 native 且 admin/token 未传递加载它）");
`,
  );
  const smoke = spawnSync(process.execPath, [path.join(root, "smoke.mjs")], {
    encoding: "utf8",
  });
  if (smoke.status !== 0) {
    fail(`无 .node 环境 import 失败：\n${smoke.stdout}\n${smoke.stderr}`);
  } else {
    ok("无 .node 环境 import ./admin 与 ./token 成功（根入口如约失败）");
  }

  // 5. 类型检查双过：消费者 .ts 经 exports map 解 .d.mts（NodeNext）
  const tscJs = createRequire(import.meta.url).resolve("typescript/lib/tsc.js", {
    paths: [pkgDir],
  });
  fs.writeFileSync(
    path.join(root, "types-check.ts"),
    `import { AdminClient, receiptCanonical, verifyReceipt } from ${JSON.stringify(`${NAME}/admin`)};
import { decodeCapability, decodeInvite } from ${JSON.stringify(`${NAME}/token`)};
const client = new AdminClient({ baseUrl: "https://dweb.example", token: "t", timeoutMs: 500 });
await client.probeEnabled();
await client.disconnect({ endpointId: "ab".repeat(32) });
receiptCanonical({ op: "disconnect", fabric_id: "ab".repeat(32), endpoint_id: "cd".repeat(32), ts: 1, generation: 1, receipt_sig: "AA" });
await verifyReceipt({ op: "register", fabric_id: "ab".repeat(32), root: "cd".repeat(32), ts: 1, generation: 1, receipt_sig: "AA" }, () => true);
const invite = decodeInvite("dweb2.x");
const cap = decodeCapability("dwebr1.x");
console.log(invite.expiresAtMs, cap.caps.relay, client ? 1 : 0);
`,
  );
  const tsc = spawnSync(
    process.execPath,
    [
      tscJs,
      "--noEmit",
      "--strict",
      "--target",
      "es2022",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--skipLibCheck",
      "types-check.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (tsc.status !== 0) {
    fail(`tsc 类型检查失败：\n${tsc.stdout}\n${tsc.stderr}`);
  } else {
    ok("tsc --noEmit（NodeNext 经 exports map 解 .d.mts）通过");
  }
} catch (err) {
  fail(err instanceof Error ? err.stack : String(err));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (process.exitCode === 1) {
  console.error("pack-gate: FAILED");
} else {
  console.log("pack-gate: all checks passed");
}
