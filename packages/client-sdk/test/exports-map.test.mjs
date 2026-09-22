// exports map 五子路径三层实测（app-protocol-layer task 4.2）：
// - CJS require（相对路径 + 包名自引用）
// - ESM dynamic import（自引用）
// - 类型层由 test:types fixture 覆盖（types.fixture.ts import 各子路径）
// 仅加载/形状断言——网络 e2e 见 continuity-http.test.mjs。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

test("exports map: five subpaths resolve (require.resolve self-reference)", () => {
  const self = [
    "@jixo/opendweb-client-sdk",
    "@jixo/opendweb-client-sdk/net",
    "@jixo/opendweb-client-sdk/net/internals",
    "@jixo/opendweb-client-sdk/http",
    "@jixo/opendweb-client-sdk/http/internals",
  ];
  for (const id of self) {
    const resolved = require.resolve(id);
    assert.ok(resolved.endsWith(".js"), `${id} -> ${resolved}`);
  }
});

test("exports map: runtime shapes via CJS require (relative + self-reference)", () => {
  const root = require("../index.js");
  const net = require("../net/index.js");
  const netInternals = require("../net/internals.js");
  const http = require("../http/index.js");
  const httpInternals = require("../http/internals.js");

  assert.equal(typeof root.Fabric, "function");
  // /net：SessionHandle 再导出（本阶段 runtime = 根模块）
  assert.equal(typeof net.SessionHandle, "function");
  assert.equal(net.Fabric, root.Fabric, "/net 是根模块的再导出");
  assert.equal(typeof net.SessionHandle.prototype.onState, "function");
  // /net/internals：journal 观测
  assert.equal(typeof netInternals.journalBytes, "function");
  // /http：§3.4 规范签名
  assert.equal(typeof http.fetchHttp, "function");
  assert.equal(typeof http.serveHttp, "function");
  // /http/internals：native request id/puller 观测
  assert.equal(typeof httpInternals.serverStats, "function");

  // 包名自引用与相对路径解析到同一模块实例
  assert.equal(require("@jixo/opendweb-client-sdk"), root);
  assert.equal(require("@jixo/opendweb-client-sdk/http"), http);
  assert.equal(require("@jixo/opendweb-client-sdk/net/internals"), netInternals);
});

test("exports map: ESM dynamic import (self-reference)", async () => {
  // CJS 命名空间：module.exports 重赋值（root/net 为 require 结果透传）时
  // cjs-module-lexer 无法静态抽取命名导出——统一走 default 解包。
  const esm = (m) => m.default ?? m;
  const http = esm(await import("@jixo/opendweb-client-sdk/http"));
  assert.equal(typeof http.fetchHttp, "function");
  assert.equal(typeof http.serveHttp, "function");
  const root = esm(await import("@jixo/opendweb-client-sdk"));
  assert.equal(typeof root.Fabric, "function");
  const net = esm(await import("@jixo/opendweb-client-sdk/net"));
  assert.equal(typeof net.SessionHandle, "function");
  const netI = esm(await import("@jixo/opendweb-client-sdk/net/internals"));
  assert.equal(typeof netI.journalBytes, "function");
  const httpI = esm(await import("@jixo/opendweb-client-sdk/http/internals"));
  assert.equal(typeof httpI.serverStats, "function");
});

test("exports map: unknown subpath rejects (fail-loud)", () => {
  assert.throws(() => require.resolve("@jixo/opendweb-client-sdk/nope"), (e) => {
    assert.match(e.code, /^ERR_PACKAGE_PATH_NOT_EXPORTED$|^ERR_MODULE_NOT_FOUND$/);
    return true;
  });
});

// 相对路径形态（模拟外部消费者按 exports map 目标文件直接取用）
test("exports map: relative file targets exist for all entries (final set: 5 CJS + admin/token ESM)", () => {
  const pkg = require("../package.json");
  const entries = Object.keys(pkg.exports);
  // sdk-mgmt-surface task 2.2 完成态断言：最终 exports 全集 = . /net /net/internals
  // /http /http/internals /admin /token（design §3 共享面协议冻结）
  assert.deepEqual(entries.sort(), [
    ".",
    "./admin",
    "./http",
    "./http/internals",
    "./net",
    "./net/internals",
    "./token",
  ]);
  for (const key of entries) {
    const target = pkg.exports[key];
    const jsPath = path.join(here, "..", target.default.replace("./", ""));
    const dtsPath = path.join(here, "..", target.types.replace("./", ""));
    const fs = require("node:fs");
    assert.ok(fs.existsSync(jsPath), `${key}: ${jsPath}`);
    assert.ok(fs.existsSync(dtsPath), `${key}: ${dtsPath}`);
  }
});

// sdk-mgmt-surface task 2.1：./admin 与 ./token 为 .mjs + .d.mts 纯 ESM
// entrypoint（CJS 包内合法共存；ESM-only 契约——import 载入，不承诺 require()）
test("exports map: admin/token ESM subpaths resolve and import (self-reference)", async () => {
  const adminPath = require.resolve("@jixo/opendweb-client-sdk/admin");
  const tokenPath = require.resolve("@jixo/opendweb-client-sdk/token");
  assert.ok(adminPath.endsWith("admin/index.mjs"), adminPath);
  assert.ok(tokenPath.endsWith("token/index.mjs"), tokenPath);

  const admin = await import("@jixo/opendweb-client-sdk/admin");
  assert.equal(typeof admin.AdminClient, "function");
  assert.equal(typeof admin.AdminError, "function");
  assert.equal(typeof admin.receiptCanonical, "function");
  assert.equal(typeof admin.verifyReceipt, "function");
  assert.equal(typeof admin.adminPublicKeyFromServices, "function");

  const token = await import("@jixo/opendweb-client-sdk/token");
  assert.equal(typeof token.decodeInvite, "function");
  assert.equal(typeof token.decodeCapability, "function");
  assert.equal(typeof token.TokenError, "function");
});

// 隔离规则（design §2.1）：两 subpath 源码零 import——MUST NOT 引包内
// root/net/http（无传递 native 加载）。静态断言：源码不出现任何模块加载语句。
test("exports map: admin/token sources contain no module loading (native isolation)", () => {
  const fs = require("node:fs");
  for (const file of ["admin/index.mjs", "token/index.mjs"]) {
    const src = fs.readFileSync(path.join(here, "..", file), "utf8");
    assert.ok(!/(?:^|\n)\s*import[\s("'{*]/.test(src), `${file}: 不含 import 语句`);
    assert.ok(!/(?:^|\n)\s*export[\s{*]+from\s/.test(src), `${file}: 不含 re-export`);
    assert.ok(!/\brequire\s*\(/.test(src), `${file}: 不含 require() 调用`);
  }
});
