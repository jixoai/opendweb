// 同步调度器（webui-plugin-kernel Phase 3 / design v2.3 §7.5）。
// 意图（2026-09-29）：
// 1. 触发三源：会话在线事件（notifyOnline→立即调度）+ 间隔兜底（默认 30s——
//    每组一个 interval timer，事件驱动非轮询）+ 本地变更 debounce 2s（事件
//    合并：每次通知重置 timer，安静 2s 后调度一次）。
// 2. timer 全部注入式（{setInterval, clearInterval, setTimeout, clearTimeout}）——
//    测试用假 timer 手动推进，无真实等待。
// 3. 串行：同组同 root 的 run 已由引擎单任务互斥；调度器只做去抖与触发。
// 4. dispose：全部 timer 清零（宿主停用顺序第③步 dispose 钩子的消受方）。

/**
 * @typedef {Object} InjectedTimers
 * @property {(fn: () => void, ms?: number) => unknown} setTimeout
 * @property {(h: unknown) => void} clearTimeout
 * @property {(fn: () => void, ms?: number) => unknown} setInterval
 * @property {(h: unknown) => void} clearInterval
 */

/**
 * 创建调度器。
 * @param {{ run: (groupId: string, opts?: { trigger?: string }) => Promise<unknown>, intervalMs?: number, debounceMs?: number, timers?: InjectedTimers, log?: { debug?: (m: string) => void, warn?: (m: string) => void } }} opts
 */
export function createScheduler(opts) {
  const run = opts.run;
  const intervalMs = opts.intervalMs ?? 30_000;
  const debounceMs = opts.debounceMs ?? 2_000;
  /** @type {InjectedTimers} */
  const t = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(/** @type {NodeJS.Timeout} */ (h)),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(/** @type {NodeJS.Timeout} */ (h)),
  };
  const log = opts.log ?? {};

  /** @type {Map<string, { interval: unknown, debounce: unknown }>} groupId → timers */
  const groups = new Map();

  /**
   * @param {string} groupId
   * @param {string} trigger
   */
  function schedule(groupId, trigger) {
    const runP = run(groupId, { trigger });
    if (runP && typeof runP.catch === "function") runP.catch((/** @type {unknown} */ e) => log.warn?.(`scheduler: run(${groupId}) failed: ${e}`));
  }

  return {
    /**
     * 开始调度一个组（幂等——重复 start 无副作用）。启动即触发一次首同步。
     * @param {string} groupId
     */
    start(groupId) {
      if (groups.has(groupId)) return;
      const interval = t.setInterval(() => schedule(groupId, "interval"), intervalMs);
      groups.set(groupId, { interval, debounce: null });
      schedule(groupId, "start");
    },
    /** @param {string} groupId */
    stop(groupId) {
      const g = groups.get(groupId);
      if (g === undefined) return;
      t.clearInterval(g.interval);
      if (g.debounce !== null) t.clearTimeout(g.debounce);
      groups.delete(groupId);
    },
    /** 会话在线事件（触发窗口内跟随——Scenario「单向跟随」的触发源）。 */
    notifyOnline(groupId) {
      if (!groups.has(groupId)) return;
      schedule(groupId, "online");
    },
    /** 本地变更事件（debounce 2s 合并）。 */
    notifyLocalChange(groupId) {
      const g = groups.get(groupId);
      if (g === undefined) return;
      if (g.debounce !== null) t.clearTimeout(g.debounce);
      g.debounce = t.setTimeout(() => {
        g.debounce = null;
        schedule(groupId, "debounce");
      }, debounceMs);
    },
    /** dispose（宿主 onDispose 钩子消费——全组 timer 清零）。 */
    dispose() {
      for (const groupId of [...groups.keys()]) this.stop(groupId);
    },
    /** 活跃组清单（测试观测）。 */
    activeGroups() {
      return [...groups.keys()];
    },
    /** 未决 debounce 计数（测试观测——不读内部 timer 句柄）。 */
    pendingDebounces() {
      let n = 0;
      for (const g of groups.values()) if (g.debounce !== null) n += 1;
      return n;
    },
  };
}
