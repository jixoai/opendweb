// plugin 契约测试（webui-console A.9 / design §3）。
// 跨包导入 packages/opendweb 的契约实现（CLI 包，测试期相对路径 import——
// 运行时零依赖不受影响）：manifest 过 zod、help golden fixture（零执行）、
// 官方 parseCommandArgs 矩阵、dispatch 冒烟（token 不入错误输出）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManifestSchema, parseCommandArgs, renderPluginHelp, dispatchPluginCommand } from "../../opendweb/src/plugin-contract.mjs";
import plugin from "../src/plugin.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("manifest passes PluginManifestSchema (zod)", () => {
  const r = PluginManifestSchema.safeParse(plugin);
  assert.ok(r.success, JSON.stringify(r.error?.issues ?? []));
  assert.equal(r.data?.name, "webui");
  assert.equal(r.data?.apiVersion, 1);
  assert.equal(r.data?.commands.length, 1);
  assert.equal(r.data?.commands[0].name, "webui");
  assert.equal(typeof r.data?.run, "function");
});

test("help renders from the real renderer and matches the golden fixture (zero execution)", async () => {
  const text = renderPluginHelp({ name: "webui", manifest: plugin });
  const golden = await readFile(path.join(here, "fixtures", "help.txt"), "utf8");
  assert.equal(text + "\n", golden);
  // --token 可见性提示文案冻结在 fixture 里
  assert.match(text, /--token or DWEB_ADMIN_TOKEN is visible to other local processes/);
  assert.match(text, /shell history, ps, env/);
  assert.match(text, /prefer the hidden terminal prompt or the browser pairing flow/);
  // 全 ASCII
  for (const line of text.split("\n")) {
    for (const ch of line) {
      assert.ok(ch >= "\x20" && ch <= "\x7e", `non-ascii char ${JSON.stringify(ch)} in help`);
    }
  }
});

test("parseCommandArgs (official) matrix with our declared spec", () => {
  const spec = plugin.commands[0];
  assert.deepEqual(parseCommandArgs(spec, ["--token", "abc"]), { token: "abc" });
  assert.deepEqual(parseCommandArgs(spec, ["--token=abc"]), { token: "abc" });
  assert.deepEqual(parseCommandArgs(spec, ["--allow-insecure"]), { "allow-insecure": true });
  assert.deepEqual(parseCommandArgs(spec, ["--allow-insecure=false"]), { "allow-insecure": false });
  assert.deepEqual(parseCommandArgs(spec, ["--no-open", "--server", "http://127.0.0.1:1"]), {
    "no-open": true,
    server: "http://127.0.0.1:1",
  });
  assert.deepEqual(parseCommandArgs(spec, ["--port", "8080"]), { port: 8080 });
  assert.equal(typeof parseCommandArgs(spec, ["--port=18787"]).port, "number");
  assert.throws(() => parseCommandArgs(spec, ["--unknown", "x"]), /unknown option/);
  assert.throws(() => parseCommandArgs(spec, ["--token"]), /missing value/);
});

test("run envelope smoke via dispatchPluginCommand: bad --server exits non-zero, token never in output", async () => {
  const out = [];
  const err = [];
  const stdout = { write: (s) => out.push(s) };
  const stderr = { write: (s) => err.push(s) };
  const code = await dispatchPluginCommand({
    manifest: plugin,
    command: "webui",
    argv: ["--server", "http://203.0.113.10:18787", "--token", "cli-secret-token-42"],
    cwd: process.cwd(),
    stdout,
    stderr,
  });
  assert.equal(code, 1, "plaintext non-loopback without --allow-insecure refuses to start");
  const all = out.join("") + err.join("");
  assert.match(all, /invalid --server/);
  assert.ok(!all.includes("cli-secret-token-42"), `token must not appear in CLI output: ${all}`);
});

test("dispatch with --allow-insecure + bad port still validates port (self-owned validation)", async () => {
  const err = [];
  const code = await dispatchPluginCommand({
    manifest: plugin,
    command: "webui",
    argv: ["--server", "http://127.0.0.1:18787", "--token", "t", "--port", "99999"],
    cwd: process.cwd(),
    stdout: { write: () => {} },
    stderr: { write: (s) => err.push(s) },
  });
  assert.equal(code, 2);
  assert.match(err.join(""), /invalid --port/);
});
