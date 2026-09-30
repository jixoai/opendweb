// 调度器测试（webui-plugin-kernel Phase 3 / design v2.3 §7.5——注入式 timer，
// 无真实等待）。覆盖：start 即跑/在线事件触发/30s 兜底/本地变更 debounce 2s
// 合并/dispose 清零/未 start 的组不触发。
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createScheduler } from "../src/scheduler.mjs";

/**
 * 假 timer 时钟：手动推进。
 */
function fakeTimers() {
  /** @type {Array<{ id: number, at: number, fn: () => void, interval: number | null }>} */
  const timers = [];
  let nextId = 1;
  let now = 0;
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { id: nextId++, at: now + (ms ?? 0), fn, interval: null };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i !== -1) timers.splice(i, 1);
    },
    setInterval: (fn, ms) => {
      const t = { id: nextId++, at: now + (ms ?? 0), fn, interval: ms ?? 0 };
      timers.push(t);
      return t.id;
    },
    clearInterval: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i !== -1) timers.splice(i, 1);
    },
    /** @param {number} ms */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        now = due.at;
        if (due.interval === null) {
          const i = timers.indexOf(due);
          if (i !== -1) timers.splice(i, 1);
        } else {
          due.at = now + due.interval;
        }
        due.fn();
        await Promise.resolve(); // 让 schedule() 的微任务落定
      }
      now = end;
    },
    pending: () => timers.length,
  };
}

test("start runs immediately; online event triggers; 30s fallback ticks; dispose clears all", async () => {
  const t = fakeTimers();
  /** @type {string[]} */
  const runs = [];
  const s = createScheduler({ run: async (g, init) => runs.push(`${g}:${init?.trigger}`), intervalMs: 30_000, timers: t });
  s.start("g1");
  await t.advance(0);
  assert.deepEqual(runs, ["g1:start"], "start triggers an immediate first sync");
  s.notifyOnline("g1");
  await t.advance(0);
  assert.deepEqual(runs, ["g1:start", "g1:online"], "session-online event triggers within the window");
  await t.advance(30_000);
  assert.deepEqual(runs, ["g1:start", "g1:online", "g1:interval"], "30s fallback tick");
  await t.advance(30_000);
  assert.deepEqual(runs, ["g1:start", "g1:online", "g1:interval", "g1:interval"], "second interval tick");
  s.dispose();
  assert.equal(t.pending(), 0, "dispose clears every timer");
  await t.advance(120_000);
  assert.equal(runs.length, 4, "no runs after dispose");
  assert.deepEqual(s.activeGroups(), []);
});

test("local-change events debounce to a single run after 2s of quiet", async () => {
  const t = fakeTimers();
  /** @type {string[]} */
  const runs = [];
  const s = createScheduler({ run: async (g, init) => runs.push(`${g}:${init?.trigger}`), debounceMs: 2_000, intervalMs: 60_000, timers: t });
  s.start("g1");
  await t.advance(0);
  runs.length = 0;
  s.notifyLocalChange("g1");
  await t.advance(1_000);
  s.notifyLocalChange("g1");
  await t.advance(1_000);
  s.notifyLocalChange("g1");
  assert.equal(runs.length, 0, "no run while events keep arriving (debounce window resets)");
  await t.advance(2_100);
  assert.deepEqual(runs, ["g1:debounce"], "exactly one debounced run after 2s quiet");
  assert.equal(s.pendingDebounces(), 0);
  s.dispose();
});

test("unregistered group ignores online/local-change; stop halts interval; run errors are swallowed", async () => {
  const t = fakeTimers();
  /** @type {string[]} */
  const runs = [];
  const s = createScheduler({
    run: async (g, init) => {
      runs.push(`${g}:${init?.trigger}`);
      if (runs.length === 2) throw new Error("boom");
    },
    intervalMs: 1_000,
    timers: t,
    log: { warn: () => {} },
  });
  s.notifyOnline("ghost"); // 未 start——无副作用
  s.notifyLocalChange("ghost");
  await t.advance(5_000);
  assert.deepEqual(runs, []);
  s.start("g1");
  await t.advance(0);
  assert.deepEqual(runs, ["g1:start"]);
  s.stop("g1");
  await t.advance(5_000);
  assert.deepEqual(runs, ["g1:start"], "stop halts the interval");
  // run 抛错不炸调度器
  s.start("g2");
  await t.advance(0);
  await t.advance(1_000);
  assert.ok(runs.includes("g2:interval"));
  s.dispose();
});

// ---- F5（2026-09-30）：intervalMs/debounceMs 配置接线 --------------------------------

test("F5: setTiming re-arms active intervals immediately and applies debounce to future events", async () => {
  const t = fakeTimers();
  /** @type {string[]} */
  const runs = [];
  const s = createScheduler({ run: async (g, init) => runs.push(`${g}:${init?.trigger}`), intervalMs: 30_000, debounceMs: 2_000, timers: t });
  s.start("g1");
  await t.advance(0);
  runs.length = 0;
  // 30s 窗内重设为 5s：从当下起 5s 后首次 interval tick（而非等满旧 30s）
  s.setTiming({ intervalMs: 5_000 });
  assert.deepEqual(s.timing(), { intervalMs: 5_000, debounceMs: 2_000 });
  await t.advance(5_000);
  assert.deepEqual(runs, ["g1:interval"], "re-armed interval ticks at the new cadence from now");
  // debounce 重设为 500ms：后续事件按新窗合并
  s.setTiming({ debounceMs: 500 });
  s.notifyLocalChange("g1");
  await t.advance(600);
  assert.deepEqual(runs, ["g1:interval", "g1:debounce"], "new debounce window applies to subsequent events");
  // 非法值拒绝（不改变现值）
  assert.throws(() => s.setTiming({ intervalMs: 0 }), /intervalMs/);
  assert.throws(() => s.setTiming({ intervalMs: Number.POSITIVE_INFINITY }), /intervalMs/);
  assert.throws(() => s.setTiming({ debounceMs: -1 }), /debounceMs/);
  assert.deepEqual(s.timing(), { intervalMs: 5_000, debounceMs: 500 });
  // 未 start 的组随后 start：新节律生效
  s.start("g2");
  await t.advance(0);
  runs.length = 0;
  await t.advance(5_000);
  assert.ok(runs.includes("g2:interval"), "groups started after setTiming use the new cadence");
  s.dispose();
});

test("F5: createSyncRuntime wires config into the scheduler; applyConfig updates; invalid config rejected", async () => {
  const { makeHome } = await import("./helpers.mjs");
  const { createSyncRuntime } = await import("../src/index.mjs");
  const home = await makeHome("dweb-sync-f5-");
  const runtime = createSyncRuntime({
    home,
    endpointId: "aa11aa22aa33aa44aa55aa66aa77aa88",
    deviceName: "device-a",
    fetchImpl: async () => ({ status: 404, body: new Uint8Array() }),
    sessionResolver: () => null,
    config: { intervalMs: 45_000, debounceMs: 1_500 },
  });
  assert.deepEqual(runtime.scheduler.timing(), { intervalMs: 45_000, debounceMs: 1_500 }, "构造期配置直入调度器");
  // applyConfig：运行中变更（宿主 onConfigChange 路径）
  assert.deepEqual(runtime.applyConfig({ intervalMs: 60_000 }), { intervalMs: 60_000, debounceMs: 1_500 });
  assert.deepEqual(runtime.applyConfig({ debounceMs: 250 }), { intervalMs: 60_000, debounceMs: 250 });
  // 非法配置：构造期与 applyConfig 一致拒绝
  assert.throws(() => runtime.applyConfig({ intervalMs: 0 }), /intervalMs/);
  assert.throws(
    () =>
      createSyncRuntime({
        home,
        endpointId: "aa11aa22aa33aa44aa55aa66aa77aa88",
        deviceName: "device-a",
        fetchImpl: async () => ({ status: 404, body: new Uint8Array() }),
        sessionResolver: () => null,
        config: { debounceMs: "fast" },
      }),
    /debounceMs/,
  );
  // 缺省：30s/2s（§7.5 冻结值——config 未提供时行为零变化）
  const plain = createSyncRuntime({
    home,
    endpointId: "aa11aa22aa33aa44aa55aa66aa77aa88",
    deviceName: "device-a",
    fetchImpl: async () => ({ status: 404, body: new Uint8Array() }),
    sessionResolver: () => null,
  });
  assert.deepEqual(plain.scheduler.timing(), { intervalMs: 30_000, debounceMs: 2_000 });
  runtime.scheduler.dispose();
  plain.scheduler.dispose();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});
