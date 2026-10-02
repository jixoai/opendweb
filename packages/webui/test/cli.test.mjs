// cli.mjs 单测（webui-console A.5/A.6 / spec「token 不入 help 与错误输出」）。
// 覆盖：本地 bin parser 矩阵（与官方 parseCommandArgs 语义对齐）、token
// 获取链（argv/env 横幅、非 TTY 无来源报错列两条途径、TTY 隐藏回显）、
// 端口校验、setup 模式输出配对码、信号清理退出。
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { parseWebuiArgv, main } from "../src/cli.mjs";

function makeIo({ env = {}, isTTY = false } = {}) {
  const out = [];
  const err = [];
  const stdout = { write: (s) => out.push(s) };
  const stderr = { write: (s) => err.push(s) };
  return {
    io: {
      stdout,
      stderr,
      log: (line = "") => out.push(`${line}\n`),
      env,
      stdin: { isTTY },
      signal: new EventEmitter(),
    },
    out,
    err,
  };
}

test("parseWebuiArgv mirrors the official parser matrix", () => {
  // W11（2026-10-01）：--token 移除——两种形态均为显式迁移错误（非泛型 unknown）
  assert.throws(() => parseWebuiArgv(["--token", "abc"]), /--token was removed \(W11\)/);
  assert.throws(() => parseWebuiArgv(["--token=abc"]), /--token was removed \(W11\)/);
  assert.deepEqual(parseWebuiArgv(["--allow-insecure"]), { "allow-insecure": true });
  assert.deepEqual(parseWebuiArgv(["--allow-insecure=false"]), { "allow-insecure": false });
  assert.deepEqual(parseWebuiArgv(["--no-open", "--port", "8080", "--server", "http://127.0.0.1:1"]), {
    "no-open": true,
    port: 8080,
    server: "http://127.0.0.1:1",
  });
  assert.deepEqual(parseWebuiArgv(["--help"]), { help: true });
  assert.deepEqual(parseWebuiArgv(["-h"]), { help: true });
  assert.throws(() => parseWebuiArgv(["--unknown"]), /unknown option/);
  assert.throws(() => parseWebuiArgv(["--port", "abc"]), /expects a number/);
  assert.throws(() => parseWebuiArgv(["bare"]), /unexpected positional/);
});

test("--help prints usage without starting anything", async () => {
  const { io, out } = makeIo();
  const r = await main({ help: true }, io);
  assert.equal(r.exit, 0);
  assert.match(out.join(""), /Usage:/);
  // W11：usage 不再声明 --token（提示走向 TTY 隐藏输入/配对面/节点簿）
  assert.ok(!/--token\s+<string>/.test(out.join("")));
});

test("invalid port rejected with exit 2 (token not echoed)", async () => {
  const { io, err } = makeIo();
  const r = await main({ port: 99999 }, io);
  assert.equal(r.exit, 2);
  assert.match(err.join(""), /invalid --port/);
});

test("bad --server refused with exit 1 and allow-insecure hint; no token in output", async () => {
  const { io, err } = makeIo();
  const r = await main({ server: "http://203.0.113.10:18787" }, io);
  assert.equal(r.exit, 1);
  assert.match(err.join(""), /plaintext http to a non-loopback host/);
  assert.match(err.join(""), /--allow-insecure/);
});

test("non-TTY with no token source: error points to hidden prompt / pairing / node book (W11)", async () => {
  const { io, err } = makeIo({ env: {} });
  const r = await main({ server: "http://127.0.0.1:18787" }, io);
  assert.equal(r.exit, 2);
  const text = err.join("");
  assert.match(text, /run in a terminal to type it hidden/);
  assert.match(text, /node book/);
  assert.match(text, /W11/);
});

/** 等待 captured 输出出现 marker（main 注册监听前发信号会丢事件，先等启动完成） */
async function waitForOutput(captured, marker, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  for (;;) {
    if (captured.join("").includes(marker)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`output never contained ${marker}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("W11: env DWEB_ADMIN_TOKEN is warned-and-ignored (fail-closed), value never used nor printed", async () => {
  const { io, out, err } = makeIo({ env: { DWEB_ADMIN_TOKEN: "sekret-env" }, stdin: { isTTY: false } });
  const r = await main({ server: "http://127.0.0.1:18787", "no-open": true }, io);
  assert.equal(r.exit, 2, "non-TTY + env token = refused (env is not a token source anymore)");
  const text = out.join("") + err.join("");
  assert.match(text, /DWEB_ADMIN_TOKEN is ignored \(removed, W11\)/);
  assert.ok(!text.includes("sekret-env"), "token value never printed");
});

test("setup mode: no --server starts sidecar, prints URL + pairing code (no token needed)", async () => {
  // DWEB_HOME 隔离（默认 ~/.opendweb 可能是中枢形态——no-args 会走 row-2
  // hub-local 而非 setup 分支；setup 断言必须显式给一个空 home）
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(tmpdir(), "webui-cli-setup-"));
  try {
    const { io, out } = makeIo({ env: { DWEB_HOME: home } });
    const done = main({ "no-open": true }, io);
    await waitForOutput(out, "pairing code:");
    io.signal.emit("SIGINT");
    assert.equal((await done).exit, 0);
    const text = out.join("");
    assert.match(text, /opendweb-webui listening on http:\/\/127\.0\.0\.1:\d+/);
    assert.match(text, /pairing code: [A-Z2-7]{13}/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("TTY prompt reads the token with echo suppressed (secret not in terminal output)", async (t) => {
  const input = new PassThrough();
  input.isTTY = true; // 模拟 TTY：走 promptHidden 分支
  // readline 的 output 需要真 stream（有 .on）；用 PassThrough 并录制写入
  const output = new PassThrough();
  const outputWrites = [];
  output.on("data", (c) => outputWrites.push(c.toString("utf8")));
  const { io, out } = makeIo();
  const signal = io.signal;
  const done = main({ server: "http://127.0.0.1:18787", "no-open": true }, { ...io, stdin: input, stdout: output });
  await waitForOutput(outputWrites, "admin token:", { timeoutMs: 3000 });
  input.write("hidden-secret-token\n");
  await waitForOutput(out, "opendweb-webui listening on");
  signal.emit("SIGINT");
  assert.equal((await done).exit, 0);
  const termText = outputWrites.join("");
  assert.match(termText, /admin token: /);
  assert.ok(!termText.includes("hidden-secret-token"), "typed token must not be echoed");
  assert.ok(!out.join("").includes("hidden-secret-token"), "token never printed afterwards");
});

test("allow-insecure banner prints for plaintext non-loopback target", async () => {
  // W11：token 经 TTY 隐藏输入（argv/env 通道移除后 banner 用例同样走 prompt）
  const input = new PassThrough();
  input.isTTY = true;
  const promptOut = new PassThrough();
  const promptWrites = [];
  promptOut.on("data", (c) => promptWrites.push(c.toString("utf8")));
  const { io, out } = makeIo();
  const signal = io.signal;
  const done = main({ server: "http://203.0.113.10:18787", "allow-insecure": true, "no-open": true }, { ...io, stdin: input, stdout: promptOut });
  await waitForOutput(promptWrites, "admin token:", { timeoutMs: 3000 });
  input.write("banner-test-token\n");
  await waitForOutput(out, "NOT encrypted in transit");
  signal.emit("SIGINT");
  assert.equal((await done).exit, 0);
  assert.match(out.join(""), /NOT encrypted in transit/);
});
