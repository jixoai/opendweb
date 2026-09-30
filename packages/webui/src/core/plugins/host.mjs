// 插件宿主运行时（webui-plugin-kernel Phase 0 / design §2.2 生命周期与停用语义）。
// 意图（2026-09-29）：
// 1. 进程内注册表：编译期静态注册（builtinWebuiPluginDescriptors——Phase 0 占位；
//    外部 npm 插件 v1 不做运行时加载，design §2.1 r2-B6 收口）。运行时钩子
//    （onEnable/onDispose）经独立 runtimes 通道注入（Phase 1+ 的 ports/files/sync
//    实现面）——契约 descriptor 字段集冻结，不承载运行时可调用物。
// 2. 生命周期状态机（两条有向转换 + 起点）：registered → enabled（enable）、
//    enabled → disabled（disable）、disabled → enabled（enable）。幂等规则：
//    enable(enabled)/disable(disabled) = 到位即成功；disable(registered) =
//    invalid-transition（从未启用，无在途可 drain）。包卸载经 CLI；宿主只管启停。
//    同插件并发启停/改配互斥（mutationInFlight——第二个请求 busy 拒绝）。
// 3. 停用顺序（design 冻结）：①摘牌（status→disabled，beginActivity 立即稳定
//    拒绝）→ ②在途 drain（有界超时，默认 10s 可配；超时强制 cancel——句柄
//    持有者给其消费者稳定错误）→ ③dispose（运行时钩子：定时器/watcher/订阅/
//    锁释放位）→ ④状态落盘（mutatePluginState 锁内重读+0600 原子写）。
//    enable 逆序装配：落盘 → 数据目录（ensurePluginDataDir 惰性创建）→
//    onEnable 钩子 → 接受新活动。
// 4. 崩溃恢复：重启按落盘状态重建（loadPluginState）；半写状态由原子写纪律
//    排除（leases.mjs atomicWrite0600）。
// 5. close（进程退出路径）：仅拆运行时（拒新+drain+dispose 钩子），**不改落盘
//    状态**——关掉控制台不等于停用插件（重启后 enabled 保持）。
// 6. 零凭证：本模块不读 argv/env 凭证（spec「控制面授权与零凭证」——测试有
//    源级断言）。

import { validatePluginConfig, validateWebuiPluginDescriptor } from "./contract.mjs";
import { assertDescriptorsValid, builtinWebuiPluginDescriptors, comingSoonPlugins, EXTERNAL_WEBUI_PLUGINS_NOTE } from "./registry.mjs";
import { ensurePluginDataDir, loadPluginState, mutatePluginState } from "./state.mjs";

/** 停用 drain 默认超时（design §2.2：默认 10s 可配） */
export const DRAIN_TIMEOUT_MS = 10_000;
/** drain 轮询间隔（在途集合空判定的采样粒度） */
const DRAIN_POLL_MS = 10;
/** 强制 cancel 后等待句柄自行释放的宽限（有界——挂死句柄不阻塞停用收尾） */
const CANCEL_GRACE_MS = 250;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 进程内插件宿主。
 * @param {{ home: string, descriptors?: import("./contract.mjs").WebuiPluginDescriptor[], runtimes?: Record<string, PluginRuntime>, drainTimeoutMs?: number, now?: () => number }} opts
 *   - home：DWEB_HOME 绝对路径（运行账本与数据目录的根）
 *   - descriptors：编译期注册集（缺省=内置三插件占位；测试可注入——逐一经
 *     validateWebuiPluginDescriptor 校验，非法即拒启）
 *   - runtimes：按插件 id 注入的运行时钩子（Phase 1+；缺省无）
 *   - drainTimeoutMs：停用 drain 超时（缺省 10s）
 * @returns {Promise<PluginHost>}
 */
export async function createPluginHost(opts = {}) {
  const { home } = opts;
  if (typeof home !== "string" || home === "") throw new Error("createPluginHost: home (DWEB_HOME absolute path) is required");
  const drainTimeoutMs = opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  if (!(drainTimeoutMs > 0)) throw new Error("createPluginHost: drainTimeoutMs must be positive");
  const now = opts.now ?? (() => Date.now());
  const descriptors = opts.descriptors ?? builtinWebuiPluginDescriptors();
  const builtinCheck = assertDescriptorsValid(descriptors);
  if (!builtinCheck.ok) throw new Error(`createPluginHost: ${builtinCheck.error}`);
  for (const d of descriptors) {
    // assertDescriptorsValid 已全量校验；此行只为类型流（validate 是权威源）
    const v = validateWebuiPluginDescriptor(d);
    if (!v.ok) throw new Error(`createPluginHost: ${v.error}`);
  }
  const runtimes = opts.runtimes ?? {};

  /**
   * 宿主条目。
   * @typedef {Object} HostEntry
   * @property {import("./contract.mjs").WebuiPluginDescriptor} descriptor
   * @property {PluginRuntime | undefined} runtime
   * @property {"registered" | "enabled" | "disabled"} status
   * @property {Record<string, string | number | boolean>} config
   * @property {Set<ActivityHandle>} inflight
   * @property {boolean} disposed dispose 钩子是否已跑（重复停用不重放）
   * @property {boolean} mutationInFlight 启停/改配互斥（并发第二请求 busy 拒）
   */
  /** @type {Map<string, HostEntry>} */
  const entries = new Map();
  for (const d of descriptors) {
    entries.set(d.id, { descriptor: d, runtime: runtimes[d.id], status: "registered", config: {}, inflight: new Set(), disposed: false, mutationInFlight: false });
  }

  // 重启恢复：按落盘状态重建（未知 id 条目保留在账本不丢弃，但不进注册表——
  // v1 注册表全集=编译期集合；外部包不运行时加载）。恢复 enabled 不只是置位：
  // **必须重放 enable 的运行时副作用（onEnable 钩子）**，否则重启后 listeners/
  // watcher/调度器静默缺席（真双机验收抓出的恢复缺口——与 sidecar 侧 fabric
  // 补触发同族）。重放失败不回滚状态位：置 enabled + 记录运行时错误，管理面
  // 呈现后可再 disable/enable 修复。
  const persisted = await loadPluginState(home);
  /** @type {Promise<void>[]} */
  const restoreRuntimeEffects = [];
  for (const [id, entry] of entries) {
    const rec = persisted.plugins[id];
    if (rec?.status === "enabled") entry.status = "enabled";
    else if (rec?.status === "disabled") entry.status = "disabled";
    if (rec !== undefined && rec.config !== null && typeof rec.config === "object") entry.config = { ...rec.config };
    if (entry.status === "enabled") {
      entry.disposed = false;
      restoreRuntimeEffects.push(
        (async () => {
          try {
            await entry.runtime?.onEnable?.({ home, dataDir: `${home}/plugins/${id}`, config: { ...entry.config } });
          } catch (e) {
            entry.runtimeError = e instanceof Error ? e.message : String(e);
          }
        })(),
      );
    }
  }
  await Promise.all(restoreRuntimeEffects);

  /**
   * 条目投影（控制面 GET /sidecar/plugins 的行形状；component 非序列化不外发）。
   * @param {HostEntry} entry
   */
  function project(entry) {
    const d = entry.descriptor;
    return {
      id: d.id,
      webui_api: d.webuiApi,
      status: entry.status,
      pages: d.pages.map((p) => ({ id: p.id, title: p.title, nav: p.nav ?? null, icon: p.icon ?? null, type: p.type, perspective: p.perspective })),
      config_schema: d.configSchema,
      config: { ...entry.config },
    };
  }

  /**
   * 落盘单插件记录（锁内重读→改→原子写）。未知 id 条目不受影响。
   * @param {string} id
   * @param {"registered" | "enabled" | "disabled"} status
   * @param {Record<string, string | number | boolean>} config
   * @returns {Promise<{ ok: true } | { ok: false, code: "lock" }>}
   */
  const persist = (id, status, config) =>
    mutatePluginState(
      home,
      (state) => {
        state.plugins[id] = { status, config: { ...config } };
      },
      { now },
    );

  /** @param {string} id @returns {HostEntry | null} */
  const find = (id) => entries.get(id) ?? null;

  /**
   * 在途活动句柄（Phase 1+ 运行时与 Phase 0 测试的对接面）。
   * @typedef {Object} ActivityHandle
   * @property {string} pluginId
   * @property {() => void} cancel 强制取消（drain 超时后由宿主调用——持有者须给
   *   其消费者稳定错误并尽快 end()）
   * @property {() => void} end 活动完成（从在途集合摘除；幂等）
   */

  const host = {
    /** 注册表全集投影（内置插件 + 状态 + 「即将推出」+ 外部插件标注）。 */
    list() {
      return {
        plugins: [...entries.values()].map(project),
        coming_soon: comingSoonPlugins(),
        external_webui_plugins: { available: false, note: EXTERNAL_WEBUI_PLUGINS_NOTE },
      };
    },

    /**
     * 单插件投影（enable/disable 成功响应体；未知 id=null）。
     * @param {string} id
     */
    get(id) {
      const entry = find(id);
      return entry === null ? null : project(entry);
    },

    /**
     * 插件是否接受新活动（摘牌语义：enabled 才接受）。
     * @param {string} id
     */
    isAccepting(id) {
      const entry = find(id);
      return entry !== null && entry.status === "enabled";
    },

    /**
     * 登记在途活动（运行时请求入口调用）。非 enabled（registered/disabled/
     * 摘牌中）→ 稳定拒绝 {ok:false, code:"plugin-disabled"}。
     * @param {string} id
     * @param {{ cancel: () => void }} activity
     * @returns {{ ok: true, end: () => void } | { ok: false, code: "plugin-disabled" | "unknown-plugin" } }
     */
    beginActivity(id, activity) {
      const entry = find(id);
      if (entry === null) return { ok: false, code: "unknown-plugin" };
      if (entry.status !== "enabled") return { ok: false, code: "plugin-disabled" };
      /** @type {ActivityHandle} */
      const handle = { pluginId: id, cancel: activity.cancel, end: () => entry.inflight.delete(handle) };
      entry.inflight.add(handle);
      return { ok: true, end: handle.end };
    },

    /**
     * 启用（registered→enabled / disabled→enabled；enabled 幂等成功）。
     * 逆序装配：落盘 → 数据目录（惰性创建）→ onEnable 钩子 → 接受新活动。
     * onEnable 失败=账本回滚 + 结构化 enable-failed（不留 ledger=enabled /
     * 宿主=disabled 分裂态——真浏览器走查 P1：loadShares 损坏 fail-closed 等）。
     * @param {string} id
     * @returns {Promise<{ ok: true, plugin: object } | { ok: false, code: "unknown-plugin" | "busy" | "lock" | "enable-failed", message?: string }>}
     */
    async enable(id) {
      const entry = find(id);
      if (entry === null) return { ok: false, code: "unknown-plugin" };
      if (entry.status === "enabled") return { ok: true, plugin: project(entry) };
      if (entry.mutationInFlight) return { ok: false, code: "busy" };
      entry.mutationInFlight = true;
      try {
        const transition = entry.status === "disabled" ? "disabled→enabled" : "registered→enabled";
        const p = await persist(id, "enabled", entry.config);
        if (!p.ok) return p;
        await ensurePluginDataDir(home, id);
        try {
          await entry.runtime?.onEnable?.({ home, dataDir: `${home}/plugins/${id}`, config: { ...entry.config } });
        } catch (e) {
          // 原子性回滚：onEnable 抛错时把账本恢复到转换前状态（best-effort——
          // 回滚自身失败仅极 rare 的锁竞争，此时返回的错误仍如实指示失败）。
          await persist(id, entry.status, entry.config);
          return { ok: false, code: "enable-failed", message: String(/** @type {Error} */ (e)?.message ?? e) };
        }
        entry.disposed = false;
        entry.status = "enabled";
        if (host.onTransition) host.onTransition(id, transition);
        return { ok: true, plugin: project(entry) };
      } finally {
        entry.mutationInFlight = false;
      }
    },

    /**
     * 停用（enabled→disabled；disabled 幂等成功；registered→invalid-transition）。
     * 顺序（design §2.2 冻结）：摘牌 → drain（有界超时+强制取消）→ dispose → 落盘。
     * @param {string} id
     * @returns {Promise<{ ok: true, plugin: object, drained: boolean, timedOut: boolean } | { ok: false, code: "unknown-plugin" | "invalid-transition" | "busy" | "lock" }>}
     */
    async disable(id) {
      const entry = find(id);
      if (entry === null) return { ok: false, code: "unknown-plugin" };
      if (entry.status === "registered") return { ok: false, code: "invalid-transition" };
      if (entry.status === "disabled") return { ok: true, plugin: project(entry), drained: true, timedOut: false };
      if (entry.mutationInFlight) return { ok: false, code: "busy" };
      entry.mutationInFlight = true;
      try {
        // ① 摘牌：状态先置 disabled——此后 beginActivity 稳定拒绝（新请求零进入）
        entry.status = "disabled";
        // ② drain：等在途集合清空（有界）；超时→强制 cancel（持有者给稳定错误）
        const deadline = now() + drainTimeoutMs;
        let timedOut = false;
        while (entry.inflight.size > 0) {
          if (now() >= deadline) {
            timedOut = true;
            break;
          }
          await delay(DRAIN_POLL_MS);
        }
        if (timedOut) {
          for (const handle of [...entry.inflight]) {
            try {
              handle.cancel();
            } catch {
              // 钩子异常不阻塞停用（防御：持有者错误不得卡死宿主）
            }
          }
          await delay(Math.min(CANCEL_GRACE_MS, drainTimeoutMs)); // 有界宽限：cancel→end 的传播窗口
        }
        const drained = entry.inflight.size === 0;
        // ③ dispose（一次性；定时器/watcher/订阅/锁释放位——Phase 1+ 运行时钩子）
        if (!entry.disposed) {
          entry.disposed = true;
          await entry.runtime?.onDispose?.();
        }
        // ④ 落盘
        const p = await persist(id, "disabled", entry.config);
        if (!p.ok) return p;
        if (host.onTransition) host.onTransition(id, "enabled→disabled");
        return { ok: true, plugin: project(entry), drained, timedOut };
      } finally {
        entry.mutationInFlight = false;
      }
    },

    /**
     * 读插件配置（未知 id=null）。
     * @param {string} id
     */
    getConfig(id) {
      const entry = find(id);
      return entry === null ? null : { ...entry.config };
    },

    /**
     * 写插件配置（validatePluginConfig 全量校验：未知键/类型不符/缺 required 拒绝）。
     * 状态原样落盘（对 registered 插件改配置不改变其生命周期状态——账本三态之一）。
     * @param {string} id
     * @param {unknown} values
     * @returns {Promise<{ ok: true, config: Record<string, string | number | boolean> } | { ok: false, code: "unknown-plugin" | "busy" | "invalid-config" | "lock", error?: string }>}
     */
    async setConfig(id, values) {
      const entry = find(id);
      if (entry === null) return { ok: false, code: "unknown-plugin" };
      if (entry.mutationInFlight) return { ok: false, code: "busy" };
      entry.mutationInFlight = true;
      try {
        const v = validatePluginConfig(entry.descriptor.configSchema, values);
        if (!v.ok) return { ok: false, code: "invalid-config", error: v.error };
        const p = await persist(id, entry.status, v.value);
        if (!p.ok) return p;
        entry.config = v.value;
        // F5（2026-09-30）：配置写入后通知运行时（可选钩子——sync 接线
        // intervalMs/debounceMs 到调度器节律；无钩子的插件不受影响）。
        // 钩子抛错不回滚配置（已落盘）：按 warn 记录——配置面语义上仍成功。
        if (typeof entry.runtime?.onConfigChange === "function") {
          try {
            await entry.runtime.onConfigChange({ ...v.value });
          } catch (e) {
            /* host 无日志通道时静默；调用方（sidecar）经 onConfigChangeError 观测 */
            host.onConfigChangeError?.(id, e);
          }
        }
        return { ok: true, config: { ...v.value } };
      } finally {
        entry.mutationInFlight = false;
      }
    },

    /** 数据目录绝对路径（不创建——ensurePluginDataDir 的纯路径推导）。 */
    dataDir(id) {
      return `${home}/plugins/${id}`;
    },

    /**
     * 宿主关闭（sidecar close 路径）：拆运行时（拒新+drain+dispose 钩子）但
     * **不落盘状态变更**——重启后按账本恢复 enabled。幂等。
     */
    async close() {
      for (const entry of [...entries.values()]) {
        if (entry.status !== "enabled") continue;
        entry.status = "disabled"; // 进程内摘牌（不落盘）
        const deadline = now() + drainTimeoutMs;
        while (entry.inflight.size > 0 && now() < deadline) await delay(DRAIN_POLL_MS);
        for (const handle of [...entry.inflight]) {
          try {
            handle.cancel();
          } catch {
            /* 同 disable：防御 */
          }
        }
        if (!entry.disposed) {
          entry.disposed = true;
          await entry.runtime?.onDispose?.();
        }
      }
    },

    /**
     * 转移观察位（测试/事件接线；每次 enable/disable 成功后回调）。
     * @type {((id: string, transition: string) => void) | null}
     */
    onTransition: null,
  };

  return host;
}

/**
 * 运行时钩子位（Phase 1+ 的 ports/files/sync 实现经 createPluginHost 的
 * runtimes 通道注入；契约 descriptor 不承载可调用物）。
 * @typedef {Object} PluginRuntime
 * @property {(ctx: { home: string, dataDir: string, config: Record<string, string | number | boolean> }) => Promise<void>} [onEnable] enable 逆序装配钩子（config=当前落盘配置——F5：运行时按需消费）
 * @property {() => Promise<void>} [onDispose] disable dispose 钩子（定时器/watcher/订阅/锁释放）
 * @property {(values: Record<string, string | number | boolean>) => Promise<void>} [onConfigChange] 配置写入后的可选通知（F5；抛错不回滚已落盘配置）
 */

/**
 * @typedef {Object} PluginHost
 * @property {() => { plugins: Array<Record<string, unknown>>, coming_soon: Array<{ id: string }>, external_webui_plugins: { available: boolean, note: string } }} list
 * @property {(id: string) => Record<string, unknown> | null} get
 * @property {(id: string) => boolean} isAccepting
 * @property {(id: string, activity: { cancel: () => void }) => { ok: true, end: () => void } | { ok: false, code: "plugin-disabled" | "unknown-plugin" }} beginActivity
 * @property {(id: string) => Promise<{ ok: true, plugin: object } | { ok: false, code: "unknown-plugin" | "busy" | "lock" }>} enable
 * @property {(id: string) => Promise<{ ok: true, plugin: object, drained: boolean, timedOut: boolean } | { ok: false, code: "unknown-plugin" | "invalid-transition" | "busy" | "lock" }>} disable
 * @property {(id: string) => Record<string, string | number | boolean> | null} getConfig
 * @property {(id: string, values: unknown) => Promise<{ ok: true, config: Record<string, string | number | boolean> } | { ok: false, code: "unknown-plugin" | "busy" | "invalid-config" | "lock", error?: string }>} setConfig
 * @property {(id: string) => string} dataDir
 * @property {() => Promise<void>} close
 * @property {((id: string, transition: string) => void) | null} onTransition
 * @property {((id: string, error: unknown) => void) | null} [onConfigChangeError] onConfigChange 钩子抛错的观测位（配置已落盘不回滚——F5）
 */
