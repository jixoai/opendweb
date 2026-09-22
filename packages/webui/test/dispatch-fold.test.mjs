// 单命令折叠派发集成测试（webui-console「零安装直达」→ cli/marketplace
// spec delta「单命令插件折叠派发」）：用本包真实 manifest 验证 CLI 派发链。
// 两层：(1) foldSingleCommand 纯函数矩阵（真实 manifest 的折叠判定）；
// (2) 真实 opendweb bin 子进程 e2e——把本包装进临时项目 node_modules，实测
// `opendweb webui --help`（零执行）与折叠/显式两形态的派发等价。
// 跨包 import 与 contract.test.mjs 同风格（../../opendweb/src/...，测试期
// 相对路径；本包运行时零依赖不受影响）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { foldSingleCommand } from "../../opendweb/src/plugin-contract.mjs";
import { wantsPluginHelp } from "../../opendweb/src/plugin-resolve.mjs";
import plugin from "../src/plugin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const OPENDWEB_BIN = path.resolve(HERE, "../../opendweb/bin/opendweb.mjs");
const NODE = process.execPath;
const ASCII = /^[\x00-\x7F]*$/;

test("foldSingleCommand with the real webui manifest: sole command dispatch, all forms agree", () => {
  assert.equal(plugin.commands.length, 1, "webui manifest stays single-command");
  // flag 首 token：折叠派发唯一命令，argv 原样（零安装直达形态）
  assert.deepEqual(
    foldSingleCommand({ manifest: plugin, rest: ["--server", "https://srv.example:18787"] }),
    { command: "webui", argv: ["--server", "https://srv.example:18787"] },
  );
  // 空 argv：折叠直达（缺省 --server 的 setup 模式语义由命令自担）
  assert.deepEqual(foldSingleCommand({ manifest: plugin, rest: [] }), { command: "webui", argv: [] });
  // 显式命令 token：既有拆分语义，与折叠形态等价
  assert.deepEqual(
    foldSingleCommand({ manifest: plugin, rest: ["webui", "--server", "https://srv.example:18787"] }),
    { command: "webui", argv: ["--server", "https://srv.example:18787"] },
  );
  // 折叠不改变 --help 零执行门：派发判定之前仍以完整 argv 判定 help
  assert.equal(wantsPluginHelp({ argv: ["--help"] }), true);
  assert.equal(wantsPluginHelp({ argv: ["--server", "https://srv.example:18787", "--help"] }), true);
});

/** 临时项目（package.json + node_modules/opendweb-webui = 本包 package.json+src）+ 隔离 DWEB_HOME */
async function cliProjectEnv() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "webui-fold-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "webui-home-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  const installed = path.join(dir, "node_modules", "opendweb-webui");
  await fsp.mkdir(installed, { recursive: true });
  await fsp.copyFile(path.join(PKG_ROOT, "package.json"), path.join(installed, "package.json"));
  await fsp.cp(path.join(PKG_ROOT, "src"), path.join(installed, "src"), { recursive: true });
  return { dir, home };
}

/** 以指定 cwd/DWEB_HOME 跑 opendweb bin 子进程，收集 stdout/stderr/退出码 */
function runCli(args, { dir, home }, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [OPENDWEB_BIN, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DWEB_HOME: home, NO_COLOR: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

test("cli e2e: opendweb webui --help renders zero-exec usage through the fold-aware dispatcher", async () => {
  const env = await cliProjectEnv();
  const r = await runCli(["webui", "--help"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /opendweb webui webui \[--server <string> --token <string> --port <number> --allow-insecure --no-open\]/);
  // --token OS 可见性提示由 help 渲染器原样呈现（spec「CLI 面接线」）
  assert.match(r.out, /--token or DWEB_ADMIN_TOKEN is visible to other local processes/);
  assert.match(r.out, ASCII, "help output must be all-ASCII");
  // 零执行：run 未被调用（sidecar 从未启动，无监听横幅）
  assert.ok(!r.out.includes("opendweb-webui listening on"), `run executed in help path: ${r.out}`);
});

test("cli e2e: folded dispatch reaches the real command (bad --server refused, token never in output)", async () => {
  const env = await cliProjectEnv();
  // 折叠形态：省略命令 token，--server 直接跟插件名
  const folded = await runCli(["webui", "--server", "http://203.0.113.10:18787", "--token", "fold-secret-token-7"], env);
  assert.equal(folded.code, 1, `stderr: ${folded.err}`);
  assert.match(folded.err, /invalid --server/);
  assert.ok(!folded.out.includes("fold-secret-token-7") && !folded.err.includes("fold-secret-token-7"), "token must not appear in CLI output");

  // 显式形态等价：同样的 argv（含命令 token）产生同样的失败面
  const explicit = await runCli(["webui", "webui", "--server", "http://203.0.113.10:18787", "--token", "fold-secret-token-7"], env);
  assert.equal(explicit.code, 1);
  assert.match(explicit.err, /invalid --server/);
});
