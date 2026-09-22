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
  assert.deepEqual(parseWebuiArgv(["--token", "abc"]), { token: "abc" });
  assert.deepEqual(parseWebuiArgv(["--token=abc"]), { token: "abc" });
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
  assert.throws(() => parseWebuiArgv(["--token"]), /missing value/);
  assert.throws(() => parseWebuiArgv(["--port", "abc"]), /expects a number/);
  assert.throws(() => parseWebuiArgv(["bare"]), /unexpected positional/);
});

test("--help prints usage without starting anything", async () => {
  const { io, out } = makeIo();
  const r = await main({ help: true }, io);
  assert.equal(r.exit, 0);
  assert.match(out.join(""), /Usage:/);
  assert.match(out.join(""), /--token/);
});

test("invalid port rejected with exit 2 (token not echoed)", async () => {
  const { io, err } = makeIo();
  const r = await main({ port: 99999, token: "cli-secret-token-42" }, io);
  assert.equal(r.exit, 2);
  assert.match(err.join(""), /invalid --port/);
  assert.ok(!err.join("").includes("cli-secret-token-42"));
});

test("bad --server refused with exit 1 and allow-insecure hint; no token in output", async () => {
  const { io, err } = makeIo();
  const r = await main({ server: "http://203.0.113.10:18787", token: "cli-secret-token-42" }, io);
  assert.equal(r.exit, 1);
  assert.match(err.join(""), /plaintext http to a non-loopback host/);
  assert.match(err.join(""), /--allow-insecure/);
  assert.ok(!err.join("").includes("cli-secret-token-42"));
});

test("non-TTY with no token source: error lists both channels (--token / DWEB_ADMIN_TOKEN)", async () => {
  const { io, err } = makeIo({ env: {} });
  const r = await main({ server: "http://127.0.0.1:18787" }, io);
  assert.equal(r.exit, 2);
  const text = err.join("");
  assert.match(text, /--token <token>/);
  assert.match(text, /DWEB_ADMIN_TOKEN/);
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

test("argv token prints visibility banner; env token prints env banner", async () => {
  // argv
  {
    const { io, out } = makeIo();
    const done = main({ server: "http://127.0.0.1:18787", token: "sekret-argv", "no-open": true }, io);
    await waitForOutput(out, "opendweb-webui listening on");
    io.signal.emit("SIGINT");
    assert.equal((await done).exit, 0);
    const text = out.join("");
    assert.match(text, /command line is visible to other local processes/);
    assert.match(text, /shell history, ps/);
    assert.ok(!text.includes("sekret-argv"), "token value never printed");
  }
  // env
  {
    const { io, out } = makeIo({ env: { DWEB_ADMIN_TOKEN: "sekret-env" } });
    const done = main({ server: "http://127.0.0.1:18787", "no-open": true }, io);
    await waitForOutput(out, "opendweb-webui listening on");
    io.signal.emit("SIGINT");
    assert.equal((await done).exit, 0);
    const text = out.join("");
    assert.match(text, /DWEB_ADMIN_TOKEN is readable from the process environment/);
    assert.ok(!text.includes("sekret-env"), "token value never printed");
  }
});

test("setup mode: no --server starts sidecar, prints URL + pairing code (no token needed)", async () => {
  const { io, out } = makeIo();
  const done = main({ "no-open": true }, io);
  await waitForOutput(out, "pairing code:");
  io.signal.emit("SIGINT");
  assert.equal((await done).exit, 0);
  const text = out.join("");
  assert.match(text, /opendweb-webui listening on http:\/\/127\.0\.0\.1:\d+/);
  assert.match(text, /pairing code: [A-Z2-7]{13}/);
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
  const { io, out } = makeIo();
  const done = main({ server: "http://203.0.113.10:18787", token: "t", "allow-insecure": true, "no-open": true }, io);
  await waitForOutput(out, "NOT encrypted in transit");
  io.signal.emit("SIGINT");
  assert.equal((await done).exit, 0);
  assert.match(out.join(""), /NOT encrypted in transit/);
});
