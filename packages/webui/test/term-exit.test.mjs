// 真实进程 TERM 退出门（r8-B5：活跃会话 TERM 闩锁回归）。
// 背景（2026-09-30 定位，scratch 实例 + libuv 诊断报告实证）：数据面 serveHttp
// 的原生 handler TSFN 与 JS 回调互持成环（napi_ref 强根），close() 走完后空闲
// 事件循环不触发 GC → 进程停泊 kevent 永不退出（修复前实测 >15s 不退）。
// cli.mjs settleExit 的 unref 宽限兜底（TERM_LATCH_GRACE_MS）闭合该面：
//   1) 空载 sidecar（无数据面插件/fabric）：TERM 自然快速退出，不触发兜底；
//   2) 活跃数据面（ports enable → fabric start → roster 预绑 serveHttp——
//      对端无需在线即已闩锁）：TERM 后 ≤7s 退出且退出码 0
//      （内核 drain 最坏 5s + 兜底宽限 2s）。
// 进程纪律：全部子进程 finally kill+wait（TERM 5s 宽限后 SIGKILL）；scratch
// home mkdtemp 用后即删。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { TERM_LATCH_GRACE_MS } from "../src/cli.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.mjs");
const FIXTURE = path.join(here, "fixtures", "term-exit-fabric-home.mjs");
/** 内核 Fabric drain 单一全局 deadline（B2 冻结值 5s）+ 兜底宽限 = TERM 退出预算 */
const TERM_EXIT_BUDGET_MS = 5000 + TERM_LATCH_GRACE_MS;

/** 行流收集（防管道写满阻塞） */
function drainLines(stream, sink) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (l) => sink.push(l));
}

class Child {
  constructor(name, child, lines) {
    this.name = name;
    this.child = child;
    this.lines = lines;
    this.exited = null;
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
    });
  }
  get text() {
    return this.lines.join("\n");
  }
  /** kill + wait（回收纪律；SIGTERM 5s 宽限后 SIGKILL） */
  async kill() {
    if (this.exited !== null) return this.exited;
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.kill("SIGTERM");
    });
    return this.exited;
  }
}

/** 起 sidecar CLI 子进程（DWEB_HOME 注入；--port 缺省=内核随机分配）并等 listening 行 */
async function spawnSidecar(home, { name = "sidecar" } = {}) {
  const lines = [];
  const child = spawn(process.execPath, [CLI, "--no-open"], {
    env: { ...process.env, DWEB_HOME: home, DWEB_ADMIN_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  drainLines(child.stdout, lines);
  drainLines(child.stderr, lines);
  const wrapper = new Child(name, child, lines);
  const port = await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = /opendweb-webui listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(wrapper.text);
      if (m !== null) {
        clearInterval(timer);
        resolve(Number(m[1]));
        return;
      }
      if (wrapper.exited !== null) {
        clearInterval(timer);
        reject(new Error(`${name} exited early (${JSON.stringify(wrapper.exited)}):\n${wrapper.text}`));
        return;
      }
      if (Date.now() - started > 10_000) {
        clearInterval(timer);
        reject(new Error(`${name} did not start in 10s:\n${wrapper.text}`));
      }
    }, 50);
  });
  return { port, child: wrapper };
}

/** 等行出现（有界轮询日志行） */
async function waitForLine(wrapper, pattern, what, timeoutMs) {
  const started = Date.now();
  for (;;) {
    if (pattern.test(wrapper.text)) return;
    if (wrapper.exited !== null) {
      throw new Error(`${wrapper.name} exited while waiting for ${what} (${JSON.stringify(wrapper.exited)}):\n${wrapper.text}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for ${what} in ${timeoutMs}ms:\n${wrapper.text}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** SIGTERM → 计时至退出（有界：超预算即 SIGKILL 并失败） */
async function termAndTime(wrapper, budgetMs) {
  const termAt = Date.now();
  wrapper.child.kill("SIGTERM");
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wrapper.child.kill("SIGKILL");
      reject(new Error(`${wrapper.name} did not exit within ${budgetMs}ms after SIGTERM (TERM latch):\n${wrapper.text.split("\n").slice(-8).join("\n")}`));
    }, budgetMs);
    wrapper.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, dt: Date.now() - termAt });
    });
  });
  return outcome;
}

test("term-exit: idle sidecar (no data plane) exits fast and naturally on SIGTERM", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-term-idle-"));
  const sidecar = await spawnSidecar(home, { name: "sidecar-idle" });
  t.after(async () => {
    await sidecar.child.kill();
    await rm(home, { recursive: true, force: true });
    assert.equal(sidecar.child.exited === null, false, "sidecar child must be reaped");
  });

  const out = await termAndTime(sidecar.child, 10_000);
  assert.equal(out.signal, null, `idle sidecar must exit by itself, not by signal: ${JSON.stringify(out)}`);
  assert.equal(out.code, 0, `idle sidecar exit code: ${JSON.stringify(out)}`);
  assert.ok(out.dt <= 3000, `idle sidecar should TERM-exit in well under 3s (got ${out.dt}ms)`);
  assert.ok(!sidecar.child.text.includes("forcing exit"), "idle sidecar must take the natural exit path (no watchdog)");
});

// 真实 client-sdk 原生面平台守卫（darwin-arm64/win32-x64 之外 skip——与
// client-sdk 自身测试同纪律）
let canLoadSdk = false;
try {
  const m = (await import("@jixo/opendweb-client-sdk")).default ?? (await import("@jixo/opendweb-client-sdk"));
  canLoadSdk = typeof m?.Fabric === "function";
} catch {
  canLoadSdk = false;
}

(
  canLoadSdk
    ? test
    : test.skip
)("term-exit: sidecar with active fabric serveHttp exits within budget on SIGTERM (B5 latch)", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "webui-term-fabric-"));
  const peerHome = await mkdtemp(path.join(tmpdir(), "webui-term-peer-"));

  // scratch home 装配（独立子进程——原生句柄零沾染）
  const fixtureLines = [];
  const fixtureChild = spawn(process.execPath, [FIXTURE, home, peerHome], { stdio: ["ignore", "pipe", "pipe"] });
  drainLines(fixtureChild.stdout, fixtureLines);
  drainLines(fixtureChild.stderr, fixtureLines);
  const fixture = new Child("fixture", fixtureChild, fixtureLines);

  const sidecar = await spawnSidecar(home, { name: "sidecar-fabric" });
  t.after(async () => {
    await sidecar.child.kill();
    await fixture.kill();
    await rm(home, { recursive: true, force: true });
    await rm(peerHome, { recursive: true, force: true });
    assert.equal(sidecar.child.exited === null, false, "sidecar child must be reaped");
    assert.equal(fixture.exited === null, false, "fixture child must be reaped");
  });
  const fixtureExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture did not finish:\n${fixture.text}`)), 30_000);
    fixtureChild.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(
    { code: fixtureExit.code, signal: fixtureExit.signal },
    { code: 0, signal: null },
    `fabric home fixture must finish cleanly:\n${fixture.text}`,
  );

  // enable ports → fabric 惰性启动（open 既有 roster → 断言 → start → roster
  // 预绑 serveHttp——TERM 闩锁的充分条件，对端无需在线）
  const origin = `http://127.0.0.1:${sidecar.port}`;
  const enable = await fetch(`${origin}/sidecar/plugins/ports/enable`, {
    method: "POST",
    headers: { origin },
  });
  assert.equal(enable.status, 200, `ports enable must succeed: ${await enable.text()}`);
  await waitForLine(sidecar.child, /fabric: started/, "fabric start", 20_000);

  // TERM 门：≤ 内核 drain 最坏 5s + 兜底宽限 TERM_LATCH_GRACE_MS
  const out = await termAndTime(sidecar.child, TERM_EXIT_BUDGET_MS + 1000);
  assert.equal(out.signal, null, `sidecar must exit by itself, not by signal: ${JSON.stringify(out)}`);
  assert.equal(out.code, 0, `sidecar exit code: ${JSON.stringify(out)}\n${sidecar.child.text.split("\n").slice(-6).join("\n")}`);
  assert.ok(out.dt <= TERM_EXIT_BUDGET_MS, `TERM → exit must be within ${TERM_EXIT_BUDGET_MS}ms (got ${out.dt}ms)`);
  assert.ok(/received SIGTERM, shutting down/.test(sidecar.child.text), "sidecar must log the signal-driven shutdown");
});
