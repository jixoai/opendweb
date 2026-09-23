// 无头控制器测试（home-hub Phase 3a / specs tray-plugin「无头运行」+「可选性」）：
// 1. 默认模式 stdout 事件流帧序（进程内）：首帧 tray-status（创建期第一拍）→
//    knock 提升（admin mock）→ opened 事件（openConsole 深链落点+capability
//    URL）→ webui error 事件转发；
// 2. token 不出面全量断言（stdout 帧/stderr 日志/心跳文件）；
// 3. hub 动作方法矩阵（假 spawn 注入）：start/stop/set-autostart 的 argv 与
//    DWEB_HOME 注入、成功形状 {ok:true}、未 init 业务 error 映射（真实 CLI
//    stderr 形态）、参数校验 -32602、未知方法 -32601；
// 4. 子进程冒烟：bin 常驻（真实节奏心跳 1s）/SIGTERM 优雅退出后 mtime 冻结
//    ——「进程退出后心跳 mtime 不再前进」的进程面证据 + 常驻进程回收；
// 5. 可选性：未装 tray 时 hub 命令族行为不变（真实 opendweb bin hub status
//    冒烟 + opendweb 包依赖面静态断言）；
// 6. marketplace 派发：临时项目 node_modules 里 `opendweb tray --help` 经
//    默认 glob npm:opendweb-* 命中本包（零执行 help，形态与 webui 先例同款）。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import { createTrayController } from "../src/controller.mjs";
import { RpcError } from "../src/ipc.mjs";
import {
  fakeAdmin,
  makeHubHome,
  spawnTray,
  spawnNode,
  collect,
  memWriter,
  fakeSpawnResult,
  readStatus,
  until,
  OPENDWEB_BIN,
  PKG_ROOT,
} from "./helpers.mjs";

/** 从内存 stdout 行流解析 schema v1 帧 */
function parseFrames(mem) {
  return mem.lines().map((l) => JSON.parse(l));
}

test("controller (stream mode): frame sequence tray-status → knock → opened; console events forwarded; token off every face", async (t) => {
  const token = `tok_secret_${Math.random().toString(36).slice(2)}`;
  const admin = await fakeAdmin({ token, knocks: 0 });
  t.after(() => admin.close());
  const { home } = await makeHubHome({ gatewayPort: admin.port, pid: process.pid, token });
  const out = memWriter();
  const errMem = memWriter();
  const signals = new EventEmitter();
  const controller = await createTrayController({
    home,
    stdout: out,
    stderr: errMem,
    signal: signals,
    heartbeatIntervalMs: 100,
    pollIntervalMs: 100,
  });
  t.after(() => controller.stop());

  // 首帧=创建期第一拍心跳（tray-status）
  await until(() => out.lines().length > 0, { what: "first tray-status frame" });
  const first = parseFrames(out)[0];
  assert.equal(first.type, "tray-status");
  assert.equal(first.v, 1);
  assert.equal(first.payload.state, "running");

  // admin mock 出现 1 台敲门 → knock 帧提升（心跳状态变化通知）
  admin.setKnocks(1);
  await until(() => parseFrames(out).some((f) => f.type === "tray-status" && f.payload.state === "knock"), {
    what: "knock tray-status frame",
  });

  // openConsole 深链 → opened 事件（URL 含一次性 capability 与深链落点）
  controller.openConsole("#/lease");
  const opened = await until(() => parseFrames(out).find((f) => f.type === "opened") ?? null, {
    what: "opened event",
  });
  assert.match(opened.payload.url, /dweb_console=/);
  assert.match(opened.payload.url, /#\/lease$/);
  assert.equal(typeof opened.ts, "number");

  // webui 事件转发：switchTarget 失败 → error 帧（schema v1 同款）
  await assert.rejects(() => controller.console.switchTarget("nope"));
  await until(() => parseFrames(out).some((f) => f.type === "error"), { what: "error event forwarded" });

  // token 不出面（stdout 全量/stderr 全量/心跳文件全量）
  const rawStatus = await fsp.readFile(path.join(home, "tray-status.json"), "utf8");
  for (const [label, text] of [["stdout", out.text()], ["stderr", errMem.text()], ["heartbeat", rawStatus]]) {
    assert.ok(!text.includes(token), `${label} must not contain the hub token`);
  }
});

test("controller: hub action method matrix via fake spawn (argv/env/success/business error/param validation)", async (t) => {
  const { home, token } = await makeHubHome({ pid: process.pid });
  const out = memWriter();
  const fake = fakeSpawnResult({ code: 0 });
  const controller = await createTrayController({
    home,
    stdout: out,
    stderr: memWriter(),
    signal: new EventEmitter(),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10_000,
    opendwebBinPath: "/opt/fake/opendweb.mjs",
    spawnImpl: fake.spawnImpl,
  });
  t.after(() => controller.stop());

  // 成功形状与 argv/DWEB_HOME 注入
  assert.deepEqual(await controller.dispatch("start", {}), { ok: true });
  assert.deepEqual(await controller.dispatch("stop", {}), { ok: true });
  assert.deepEqual(await controller.dispatch("set-autostart", { on: false }), { ok: true });
  assert.deepEqual(await controller.dispatch("set-autostart", { on: true }), { ok: true });
  assert.deepEqual(
    fake.calls.map((c) => c.args),
    [
      ["/opt/fake/opendweb.mjs", "hub", "start"],
      ["/opt/fake/opendweb.mjs", "hub", "stop", "--yes"],
      ["/opt/fake/opendweb.mjs", "hub", "autostart", "off"],
      ["/opt/fake/opendweb.mjs", "hub", "autostart", "on"],
    ],
  );
  for (const c of fake.calls) {
    assert.equal(c.opts.env.DWEB_HOME, home, "DWEB_HOME injected into hub subprocess env");
    assert.ok(!JSON.stringify(c.opts).includes(token), "hub token never in spawn argv/env dump");
    assert.equal(c.opts.env.DWEB_ADMIN_TOKEN, undefined, "no token leak via env");
  }

  // 未 init 业务 error（真实 CLI stderr 形态映射为冻结文案）
  const fakeFail = fakeSpawnResult({ code: 2, err: `error: hub is not initialized; run "opendweb hub init" first\n` });
  const controller2 = await createTrayController({
    home,
    stdout: memWriter(),
    stderr: memWriter(),
    signal: new EventEmitter(),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10_000,
    opendwebBinPath: "/opt/fake/opendweb.mjs",
    spawnImpl: fakeFail.spawnImpl,
  });
  t.after(() => controller2.stop());
  await assert.rejects(
    () => controller2.dispatch("start", {}),
    (e) => e instanceof RpcError && e.code === -32000 && e.message === "hub not initialized",
  );

  // 参数校验与未知方法
  await assert.rejects(() => controller.dispatch("set-autostart", {}), (e) => e instanceof RpcError && e.code === -32602);
  await assert.rejects(() => controller.dispatch("set-autostart", { on: "yes" }), (e) => e.code === -32602);
  await assert.rejects(() => controller.dispatch("open-console", { deepLink: 123 }), (e) => e.code === -32602);
  await assert.rejects(() => controller.dispatch("open-console", { deepLink: "not-a-link" }), (e) => e.code === -32602);
  await assert.rejects(() => controller.dispatch("open-console", "scalar"), (e) => e.code === -32602);
  await assert.rejects(() => controller.dispatch("bogus", {}), (e) => e instanceof RpcError && e.code === -32601);
});

test("controller: stop() is idempotent and closes the console (mode/setup degenerate)", async () => {
  const { home } = await makeHubHome({ configured: false });
  const controller = await createTrayController({
    home,
    stdout: memWriter(),
    stderr: memWriter(),
    signal: new EventEmitter(),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10_000,
  });
  assert.equal(controller.mode, "stream");
  assert.equal(controller.console.mode(), "setup", "unconfigured home degrades to the setup console");
  await controller.stop();
  await controller.stop(); // 幂等
  assert.throws(() => controller.console.onEvent("state-change", () => {}), /closed/);
});

test("child process: heartbeat runs at the real 1s cadence and freezes after SIGTERM (常驻进程回收)", async () => {
  const { home } = await makeHubHome({ configured: true, pid: process.pid });
  const child = spawnTray([], { home });
  try {
    // 心跳文件出现且以真实节奏（≤1s 级）前进
    await until(async () => (await fsp.stat(path.join(home, "tray-status.json")).catch(() => null)) !== null, {
      what: "heartbeat file appears",
    });
    const m1 = (await fsp.stat(path.join(home, "tray-status.json"))).mtimeMs;
    await until(
      async () => (await fsp.stat(path.join(home, "tray-status.json"))).mtimeMs > m1,
      { timeoutMs: 3000, what: "mtime advances at the real cadence" },
    );
    const snap = await readStatus(home);
    assert.equal(snap.state, "running");
    // SIGTERM 优雅退出：心跳冻结
    child.kill("SIGTERM");
    const r = await collect(child);
    assert.equal(r.code, 0, `graceful SIGTERM exit (stderr: ${r.err.slice(0, 300)})`);
    const mStopped = (await fsp.stat(path.join(home, "tray-status.json"))).mtimeMs;
    await new Promise((res) => setTimeout(res, 1600));
    const mAfter = (await fsp.stat(path.join(home, "tray-status.json"))).mtimeMs;
    assert.equal(mAfter, mStopped, "mtime frozen after process exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("optionality smoke: hub command family is unchanged without the tray plugin installed", async () => {
  const { home } = await makeHubHome({ configured: false });
  const r = await collect(spawnNode(OPENDWEB_BIN, ["hub", "status"], { home }));
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("中枢未初始化"), "hub status baseline unchanged");
  assert.ok(!r.out.toLowerCase().includes("tray"), "no tray coupling in core CLI output");
  // 核心包静态面：opendweb 不依赖 tray（核心不依赖插件）
  const opendwebPkg = JSON.parse(await fsp.readFile(path.join(PKG_ROOT, "..", "opendweb", "package.json"), "utf8"));
  const deps = { ...opendwebPkg.dependencies, ...opendwebPkg.devDependencies };
  assert.ok(!Object.keys(deps).some((d) => d.includes("tray")), "opendweb package does not depend on tray");
});

test("marketplace dispatch: `opendweb tray --help` resolves this package via the default glob (zero-exec)", async () => {
  const os = await import("node:os");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tray-dispatch-"));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "tray-dispatch-home-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  // 把本包装进临时项目（package.json + src——与 webui dispatch-fold 先例同款）
  const installed = path.join(dir, "node_modules", "opendweb-tray");
  await fsp.mkdir(installed, { recursive: true });
  await fsp.copyFile(path.join(PKG_ROOT, "package.json"), path.join(installed, "package.json"));
  await fsp.cp(path.join(PKG_ROOT, "src"), path.join(installed, "src"), { recursive: true });
  const r = await collect(spawnNode(OPENDWEB_BIN, ["tray", "--help"], { home, cwd: dir }));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /opendweb tray tray \[--ipc\]/, "folded single-command usage renders");
  assert.match(r.out, /headless hub tray controller/, "manifest description renders");
  assert.match(r.out, /^[\x00-\x7F]*$/, "help output is all ASCII");
  // 未安装形态：关闭自愈安装后为明确错误（核心不因缺插件改变行为）
  const bare = await fsp.mkdtemp(path.join(os.tmpdir(), "tray-bare-"));
  const r2 = await collect(spawnNode(OPENDWEB_BIN, ["tray", "--help"], { home, cwd: bare, extraEnv: { DWEB_NO_AUTO_INSTALL: "1" } }));
  assert.notEqual(r2.code, 0, "uninstalled tray does not resolve");
  assert.match(r2.err, /no plugin found for "tray"/);
  assert.match(r2.err, /plugin add tray/);
});

test("envelope e2e: `opendweb tray --ipc` runs the real run envelope through adaptive dispatch (workspace links)", async () => {
  const os = await import("node:os");
  const { spawn } = await import("node:child_process");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tray-envelope-"));
  const { home } = await makeHubHome({ configured: false });
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  const nm = path.join(dir, "node_modules");
  await fsp.mkdir(nm, { recursive: true });
  // 本包以目录形态安装 + workspace 依赖以符号链接注入（Node realpath 解析回
  // 真实包位置——本地开发链接形态）
  const installed = path.join(nm, "opendweb-tray");
  await fsp.mkdir(installed, { recursive: true });
  await fsp.copyFile(path.join(PKG_ROOT, "package.json"), path.join(installed, "package.json"));
  await fsp.cp(path.join(PKG_ROOT, "src"), path.join(installed, "src"), { recursive: true });
  await fsp.symlink(path.resolve(PKG_ROOT, "..", "webui"), path.join(nm, "opendweb-webui"), "dir");
  await fsp.symlink(path.resolve(PKG_ROOT, "..", "opendweb"), path.join(nm, "opendweb"), "dir");
  // 已安装形态的 lock 记录（plugins.json）——锁定的解析路径无 orphan note 混入
  // stdout 帧通道（note 只属于未锁定的磁盘解析首次使用场景）
  await fsp.writeFile(
    path.join(home, "plugins.json"),
    `${JSON.stringify({ tray: { package: "opendweb-tray", version: "0.1.0" } }, null, 2)}\n`,
    "utf8",
  );
  const child = spawn(process.execPath, [OPENDWEB_BIN, "tray", "--ipc"], {
    cwd: dir,
    env: { PATH: process.env.PATH, DWEB_HOME: home, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = (await import("./helpers.mjs")).lineReader(child.stdout);
  try {
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"open-console","params":{"deepLink":"#/lease"}}\n');
    assert.equal(await reader.next(), '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', "envelope path serves golden frames");
    const opened = JSON.parse(await reader.next());
    assert.equal(opened.method, "opened");
    child.stdin.end();
    const done = await collect(child);
    assert.equal(done.code, 0, `envelope EOF exit (stderr: ${done.err.slice(0, 300)})`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
