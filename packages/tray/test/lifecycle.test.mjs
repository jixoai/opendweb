// 生命周期双断管信号测试（home-hub r18 P1-2 / 裁决 #8 改写）：
// 1. 真实子进程（默认 stream 模式，stdio pipe）：宿主端 child.stdin.end() +
//    child.stdout.destroy()（干净关管、无写错）→ 子进程在时限内以退出码 0
//    幂等停机；退出前 tray-status.json 已写盘，退出后 mtime 冻结；
// 2. 单元级（注入 io）：默认模式双信号接线——stdout 'error'→stop、stdin
//    'end'/'close'→stop；真实流形态（PassThrough.end）经 resume 使 EOF 可观察；
//    双信号并发不二次 stop、不 reject；ipc 模式不接 stdin EOF（既有语义）。
// 子进程回收：每个 spawn 均在 finally 显式 kill 并由断言退出码验证回收。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createTrayController } from "../src/controller.mjs";
import { makeHubHome, spawnTray, collect, memWriter, until } from "./helpers.mjs";

/** shutdownPromise 限时裁决（不 resolve 即失败——不悬挂测试进程）。 */
function within(promise, ms, what) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)).then((ok) => {
      assert.ok(ok, `${what} did not settle within ${ms}ms`);
      return false;
    }),
  ]);
}

// ---- 1. 真实子进程：宿主干净关管 → 幂等停机 exit 0 ------------------------------

test("child lifecycle (stream mode): host closes stdin + destroys stdout -> exit 0, heartbeat written before and frozen after (进程回收)", async () => {
  const { home } = await makeHubHome({ configured: true, pid: process.pid });
  const child = spawnTray([], { home }); // 默认 stream 模式，stdio pipe
  try {
    const statusFile = path.join(home, "tray-status.json");
    // 退出前心跳已写盘（进程一启动首拍即写）
    await until(async () => (await fsp.stat(statusFile).catch(() => null)) !== null, {
      what: "heartbeat file appears before shutdown",
    });

    // 宿主消失形态：干净关闭其 stdin 写端 + 销毁 stdout 读端（不触发子进程写错）
    child.stdin.end();
    child.stdout.destroy();

    // 时限内以退出码 0 退出（心跳周期 1s + 余量；总体 <10s 看门狗）
    const r = await Promise.race([
      collect(child),
      new Promise((resolve) => setTimeout(() => resolve({ code: null, out: "", err: "watchdog: child did not exit within 9s" }), 9000)),
    ]);
    assert.equal(r.code, 0, `stdin EOF must stop the plugin gracefully (stderr: ${r.err.slice(0, 300)})`);

    // 退出后心跳 mtime 冻结（停机即停跳；>1 个刷新周期后仍不变）
    const mStopped = (await fsp.stat(statusFile)).mtimeMs;
    await new Promise((res) => setTimeout(res, 1600));
    const mAfter = (await fsp.stat(statusFile)).mtimeMs;
    assert.equal(mAfter, mStopped, "heartbeat mtime frozen after stdin-EOF exit");
  } finally {
    // 显式回收兜底（正常路径已在上方验证退出码）
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

// ---- 2. 单元级：双信号接线与幂等 --------------------------------------------------

test("controller wiring (stream mode): stdout error -> stop; stdin end/close -> stop; both idempotent", async () => {
  const mk = async (io) => {
    const { home } = await makeHubHome({ configured: false });
    return createTrayController({
      home,
      stdin: new EventEmitter(), // 封闭性：不触碰测试进程自身的 stdin
      stderr: memWriter(),
      signal: new EventEmitter(),
      heartbeatIntervalMs: 10_000,
      pollIntervalMs: 10_000,
      ...io,
    });
  };

  // 信号 1：stdout 写错（EPIPE）
  const stdout = new EventEmitter();
  stdout.write = () => true;
  const cErr = await mk({ stdout });
  stdout.emit("error", new Error("write EPIPE"));
  assert.equal(await within(cErr.shutdownPromise, 1000, "stdout error -> stop"), true);
  await cErr.stop(); // 幂等：再停不 reject

  // 信号 2：stdin 'end'（EventEmitter 替身——纯事件接线面）
  const stdin = new EventEmitter();
  const cEnd = await mk({ stdin, stdout: memWriter() });
  stdin.emit("end");
  assert.equal(await within(cEnd.shutdownPromise, 1000, "stdin end -> stop"), true);
  await cEnd.stop();

  // 双信号并发（error 与 EOF 同拍到）：不二次 stop、不 reject、console 关闭生效
  const stdin2 = new EventEmitter();
  const stdout2 = new EventEmitter();
  stdout2.write = () => true;
  const cBoth = await mk({ stdin: stdin2, stdout: stdout2 });
  stdin2.emit("end");
  stdin2.emit("close");
  stdout2.emit("error", new Error("write EPIPE"));
  assert.equal(await within(cBoth.shutdownPromise, 1000, "dual signals -> single stop"), true);
  await cBoth.stop();
  assert.throws(() => cBoth.console.onEvent("state-change", () => {}), /closed/, "console closed exactly once-worth (stop ran)");
});

test("controller wiring (stream mode): real-stream stdin EOF observable via resume (PassThrough.end -> stop)", async () => {
  const { home } = await makeHubHome({ configured: false });
  const stdin = new PassThrough(); // 真实流形态：暂停态不读到底不发 'end'——resume 接线是可观察性的关键
  const c = await createTrayController({
    home,
    stdin,
    stdout: { write: () => true, on: () => {} },
    stderr: memWriter(),
    signal: new EventEmitter(),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10_000,
  });
  stdin.end(); // 宿主关闭其 stdin 端
  assert.equal(await within(c.shutdownPromise, 1000, "real-stream stdin EOF -> stop"), true);
  await c.stop();
});

test("controller wiring (ipc mode): stdin EOF is NOT wired here (createIpcSession owns it; behavior unchanged)", async () => {
  const { home } = await makeHubHome({ configured: false });
  const stdin = new EventEmitter();
  const c = await createTrayController({
    ipc: true,
    home,
    stdin,
    stdout: memWriter(),
    stderr: memWriter(),
    signal: new EventEmitter(),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10_000,
  });
  stdin.emit("end"); // ipc 模式控制器不接此信号（会话层语义，非宿主消失信号）
  const settled = await Promise.race([
    c.shutdownPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
  assert.equal(settled, false, "ipc-mode controller must not stop on bare stdin 'end' (session layer owns EOF)");
  await c.stop();
});
