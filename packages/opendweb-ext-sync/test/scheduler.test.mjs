// 调度器测试（webui-plugin-kernel Phase 3 / design v2.3 §7.5——注入式 timer，
// 无真实等待）。覆盖：start 即跑/在线事件触发/30s 兜底/本地变更 debounce 2s
// 合并/dispose 清零/未 start 的组不触发。
import test from "node:test";
import assert from "node:assert/strict";
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
