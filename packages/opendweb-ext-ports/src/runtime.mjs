// ports 插件运行时（webui-plugin-kernel Phase 1 / tasks §2）。
// 意图（2026-09-29）：
// 1. 运行时工厂 createPortsRuntime({home, fetchHttpImpl, sessionResolver, now,
//    log})——经 createPluginHost({runtimes: {ports}}) 通道消费（宿主 Phase 0
//    冻结的 PluginRuntime 形状：onEnable/onDispose 钩子；本模块不改宿主）。
//    宿主无 back-reference 通道——在途 drain/强制取消在 onDispose 内自持（有界
//    超时，与宿主 DRAIN_TIMEOUT_MS 同拍量级）。
// 2. 配置（configSchema: maxBodyMiB，默认 1MiB——r8-B4 v1 有效包络）：每次启动
//    映射时重解析——工厂 config 覆盖 > 宿主运行账本 <home>/plugins/state.json 的
//    plugins.ports.config（PUT /sidecar/plugins/ports/config 的落盘面——只读消费，
//    不写宿主账本；改配经 disable→enable 生效）> 默认 1MiB。配置域 64KiB–1MiB、
//    64KiB 粒度（[W7] r8-B4 收窄；transport 帧上限 1MiB）：超范围/非粒度拒绝启动
//    映射（每条启用映射 listener=failed+明确错误，spec「并发预算与配置硬域」
//    Scenario）——configSchema 子集无 min/max 表达，域校验在本层执行。
// 3. 消费侧生命周期：enable=startEnabledMappings（每条启用映射独立起监听，
//    EADDRINUSE 等失败=该映射 failed+明确错误、其余映射不受牵连）；disable=
//    拒新→在途有界 drain→强制取消（两阶段取消原语）→socket 拆除。
// 4. 提供侧不经本工厂装配（serveHttp 需要 fabric+peer，属编排者接线面）——
//    createProviderHandler(peer) 交付 handler（授权账本同 home 共享）。
// 5. 零凭证：本模块不读 argv/env；会话经 sessionResolver 注入。

import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  addMapping as ledgerAdd,
  grantAccess as ledgerGrant,
  loadMappings,
  removeMapping as ledgerRemove,
  revokeAccess as ledgerRevoke,
  setMappingEnabled as ledgerSetEnabled,
} from "./ledger.mjs";
import { loadAllowlist } from "./ledger.mjs";
import { createMappingServer, createInFlightRegistry, createProxyBudget, DEFAULT_MAX_BODY_MIB, DRAIN_TIMEOUT_MS, MAX_CONCURRENT_PROXIES, resolveLimitBytes } from "./proxy.mjs";
import { createPortsProxyHandler } from "./provider.mjs";

const DRAIN_POLL_MS = 10;
/** @param {number} ms @returns {Promise<void>} */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 读宿主运行账本中 ports 插件的 config（只读消费；缺失/损坏宿主账本=无覆盖，
 * 宿主侧 fail-closed 由宿主自身承担）。
 * @param {string} home
 * @returns {Promise<Record<string, string | number | boolean>>}
 */
async function readHostPluginConfig(home) {
  try {
    const text = await readFile(path.join(home, "plugins", "state.json"), "utf8");
    const parsed = JSON.parse(text);
    const rec = parsed?.plugins?.ports;
    if (rec !== null && typeof rec === "object" && rec.config !== null && typeof rec.config === "object") {
      return { ...rec.config };
    }
  } catch {
    /* 缺失/损坏：无配置覆盖 */
  }
  return {};
}

/**
 * ports 插件运行时（宿主 runtimes 通道 + 管理面 API）。
 * @param {{
 *   home: string,
 *   fetchHttpImpl: (session: unknown, request: { method: string, path: string, headers?: Array<{name: string, value: string}>, body?: Array<Uint8Array> | null, signal?: AbortSignal }) => Promise<{ status: number, headers: Array<{name: string, value: string}>, bodyNext: () => Promise<Buffer | null>, abort?: () => Promise<void> | void }>,
 *   sessionResolver: (peer: string) => unknown | null | Promise<unknown | null>,
 *   now?: () => number,
 *   log?: (level: "info" | "warn" | "error", msg: string) => void,
 *   config?: { maxBodyMiB?: number },
 *   drainTimeoutMs?: number,
 * }} opts
 * @returns {Promise<import("./runtime.mjs").PortsRuntime>}
 */
export async function createPortsRuntime(opts = {}) {
  const { home, fetchHttpImpl, sessionResolver } = opts;
  if (typeof home !== "string" || home === "") throw new Error("createPortsRuntime: home (DWEB_HOME absolute path) is required");
  if (typeof fetchHttpImpl !== "function") throw new Error("createPortsRuntime: fetchHttpImpl (client-sdk /http fetchHttp or test double) is required");
  if (typeof sessionResolver !== "function") throw new Error("createPortsRuntime: sessionResolver ((peer) => SessionHandle | null) is required");
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const drainTimeoutMs = opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;

  let running = false;
  /** @type {number} 生效请求体上限（MiB；startEnabledMappings 时重解析） */
  let maxBodyMiB = opts.config?.maxBodyMiB ?? DEFAULT_MAX_BODY_MIB;
  /** @type {string | null} 超范围配置的明确错误（映射不启动的裁决依据） */
  let configError = null;
  /** @type {number} 生效上限字节（0=配置超范围——无 listener 会建立） */
  let limitBytes = 0;

  const inflight = createInFlightRegistry();
  /** @type {ReturnType<typeof createProxyBudget>} 并发预算（applyConfig 重建） */
  let budget = createProxyBudget({ maxCount: MAX_CONCURRENT_PROXIES, maxBytes: MAX_CONCURRENT_PROXIES * DEFAULT_MAX_BODY_MIB * 1024 * 1024 });

  /**
   * 配置解析（每次 startEnabledMappings 时重读——宿主 PUT config 后的
   * disable→enable 生效路径）：工厂 config 覆盖 > 宿主运行账本 > 默认 8。
   * 超范围 → configError 置位、映射全部拒启。
   */
  async function applyConfig() {
    const hostConfig = await readHostPluginConfig(home);
    const mib = opts.config?.maxBodyMiB ?? (typeof hostConfig.maxBodyMiB === "number" ? hostConfig.maxBodyMiB : undefined) ?? DEFAULT_MAX_BODY_MIB;
    const limit = resolveLimitBytes(mib);
    maxBodyMiB = mib;
    configError = limit.ok ? null : limit.error;
    limitBytes = limit.ok ? limit.bytes : 0;
    // 配置超范围时预算不会被使用（无 listener 建立）——按默认量级给非零观测值
    budget = createProxyBudget({
      maxCount: MAX_CONCURRENT_PROXIES,
      maxBytes: MAX_CONCURRENT_PROXIES * (limit.ok ? limitBytes : DEFAULT_MAX_BODY_MIB * 1024 * 1024),
    });
  }
  /** @type {Map<string, ReturnType<typeof createMappingServer>>} */
  const servers = new Map();

  /**
   * 起（或重起）单条映射的 listener。超范围配置=拒绝启动（listener 不建立；
   * 明确错误经 mappingStatus 呈现——spec 硬域 Scenario 的「映射不启动」）。
   * @param {import("./ledger.mjs").PortsMapping} mapping
   * @returns {Promise<ReturnType<typeof createMappingServer> | null>} null=配置拒启
   */
  async function startMapping(mapping) {
    if (configError !== null) {
      log("error", `ports mapping ${mapping.id} not started: ${configError}`);
      return null;
    }
    const existing = servers.get(mapping.id);
    if (existing !== undefined && existing.state === "listening") return existing;
    const server = createMappingServer({
      mapping,
      limitBytes,
      budget,
      inflight,
      fetchHttpImpl,
      sessionResolver,
      now,
      log,
      drainTimeoutMs,
    });
    servers.set(mapping.id, server);
    const r = await server.start();
    if (!r.ok) log("error", `ports mapping ${mapping.id} failed to start: ${r.error}`);
    else log("info", `ports mapping ${mapping.id} listening on 127.0.0.1:${mapping.localPort} -> peer ${mapping.peer}:${mapping.remotePort}`);
    return server;
  }

  /**
   * 停单条映射 listener（有界 drain + 强制取消）。
   * @param {string} id
   */
  async function stopMapping(id) {
    const server = servers.get(id);
    if (server === undefined) return;
    await server.stop();
    servers.delete(id);
  }

  /**
   * 启动全部启用映射（onEnable/enable 入口；账本损坏 fail-closed 抛错——
   * 宿主侧消费为 enable 失败的明确错误）。先重解析配置（PUT config 后的
   * disable→enable 生效路径）。
   * @returns {Promise<{ ok: true }>}
   */
  async function startEnabledMappings() {
    await applyConfig();
    const ledger = await loadMappings(home);
    running = true;
    for (const mapping of ledger.mappings) {
      if (!mapping.enabled) continue;
      await startMapping(mapping);
    }
    return { ok: true };
  }

  /**
   * 停全部 + 在途有界 drain + 超时强制取消（onDispose/disable 入口；幂等）。
   */
  async function stopAll() {
    running = false;
    await Promise.all([...servers.keys()].map((id) => stopMapping(id)));
    const deadline = now() + drainTimeoutMs;
    while (inflight.size > 0 && now() < deadline) await delay(DRAIN_POLL_MS);
    if (inflight.size > 0) inflight.cancelAll();
  }

  /** @param {import("./ledger.mjs").PortsMapping} mapping */
  function mappingStatus(mapping) {
    const server = servers.get(mapping.id);
    if (server !== undefined) {
      return {
        id: mapping.id,
        name: mapping.name,
        peer: mapping.peer,
        remotePort: mapping.remotePort,
        localPort: mapping.localPort,
        enabled: mapping.enabled,
        /** listener 态（listening/stopped/failed） */
        listener: server.state,
        error: server.error,
      };
    }
    // 无 listener：运行中且启用但配置超范围=failed+明确错误（映射不启动）
    const refused = running && mapping.enabled && configError !== null;
    return {
      id: mapping.id,
      name: mapping.name,
      peer: mapping.peer,
      remotePort: mapping.remotePort,
      localPort: mapping.localPort,
      enabled: mapping.enabled,
      listener: refused ? "failed" : "stopped",
      error: refused ? configError : null,
    };
  }

  return {
    /** 宿主 runtimes 通道：enable 逆序装配钩子（落盘→数据目录→本钩子） */
    onEnable: async () => {
      await startEnabledMappings();
    },
    /** 宿主 runtimes 通道：dispose 钩子（拒新→drain→强制取消→锁释放面） */
    onDispose: async () => {
      await stopAll();
    },
    /** 运行态（true=onEnable 已执行且未 dispose） */
    get running() {
      return running;
    },
    /** 生效配置 + 超范围错误（configError 非空=映射全部拒启） */
    get config() {
      return { maxBodyMiB, configError };
    },
    /** 并发预算观测（429 语义的裁决面） */
    get budget() {
      return { inFlight: inflight.size, maxCount: budget.maxCount, maxBytes: budget.maxBytes, inFlightBytes: budget.bytes };
    },
    /**
     * 全量映射状态（账本 × listener 态合并——UI 列表数据源）。
     * @returns {Promise<Array<ReturnType<typeof mappingStatus>>>}
     */
    async listMappings() {
      const ledger = await loadMappings(home);
      return ledger.mappings.map(mappingStatus);
    },
    /**
     * 新增映射（账本落盘；插件运行中且映射启用→立即起监听；端口冲突等启动失败
     * =映射保留在账本、listener=failed+明确错误，绝不静默换端口）。
     * @param {{ name: string, peer: string, remotePort: number, localPort: number, enabled?: boolean }} input
     */
    async addMapping(input) {
      const r = await ledgerAdd(home, input);
      if (!r.ok) return r;
      if (r.mapping.enabled && running) await startMapping(r.mapping);
      return { ok: true, mapping: r.mapping, listener: mappingStatus(r.mapping).listener, error: mappingStatus(r.mapping).error };
    },
    /**
     * 删除映射（停 listener → 账本移除）。
     * @param {string} id
     */
    async removeMapping(id) {
      await stopMapping(id);
      return ledgerRemove(home, id);
    },
    /**
     * 启停映射（账本翻转 + listener 起/停）。
     * @param {string} id
     * @param {boolean} enabled
     */
    async setMappingEnabled(id, enabled) {
      if (!enabled) {
        await stopMapping(id);
        return ledgerSetEnabled(home, id, false);
      }
      const r = await ledgerSetEnabled(home, id, true);
      if (!r.ok) return r;
      if (running) await startMapping(r.mapping);
      return { ok: true, mapping: r.mapping, listener: mappingStatus(r.mapping).listener, error: mappingStatus(r.mapping).error };
    },
    /**
     * 提供侧 serveHttp handler 工厂（编排者接线：
     * serveHttp(fabric, peerId, rt.createProviderHandler(peerId))）。
     * @param {string} peer
     */
    createProviderHandler(peer) {
      return createPortsProxyHandler({ home, peer, maxBodyMiB, now, log });
    },
    /** 授权账本管理（提供侧 allowlist；UI/控制面接线面） */
    async listAllowlist() {
      return loadAllowlist(home);
    },
    /**
     * @param {string} peer
     * @param {number} remotePort
     */
    async grantAccess(peer, remotePort) {
      return ledgerGrant(home, peer, remotePort);
    },
    /**
     * @param {string} peer
     * @param {number} remotePort
     */
    async revokeAccess(peer, remotePort) {
      return ledgerRevoke(home, peer, remotePort);
    },
    /** 直连生命周期（测试/编排者不经宿主时的入口；幂等） */
    async start() {
      if (running) return;
      await startEnabledMappings();
    },
    async stop() {
      await stopAll();
    },
  };
}

/**
 * @typedef {Object} PortsRuntime
 * @property {(ctx: { home: string, dataDir: string }) => Promise<void>} onEnable 宿主 runtimes 通道钩子
 * @property {() => Promise<void>} onDispose 宿主 runtimes 通道钩子（drain+强制取消）
 * @property {boolean} running
 * @property {{ maxBodyMiB: number, configError: string | null }} config
 * @property {{ inFlight: number, maxCount: number, maxBytes: number, inFlightBytes: number }} budget
 * @property {() => Promise<Array<PortsMappingStatus>>} listMappings
 * @property {(input: { name: string, peer: string, remotePort: number, localPort: number, enabled?: boolean }) => Promise<{ ok: true, mapping: import("./ledger.mjs").PortsMapping, listener: string, error: string | null } | { ok: false, code: string, error?: string }>} addMapping
 * @property {(id: string) => Promise<{ ok: true } | { ok: false, code: string, error?: string }>} removeMapping
 * @property {(id: string, enabled: boolean) => Promise<{ ok: true, mapping: import("./ledger.mjs").PortsMapping, listener: string, error: string | null } | { ok: false, code: string, error?: string }>} setMappingEnabled
 * @property {(peer: string) => (req: import("./provider.mjs").HttpHandlerRequestLike) => Promise<import("./provider.mjs").HttpHandlerResponseLike | null | void>} createProviderHandler
 * @property {() => Promise<{ version: 1, entries: Array<import("./ledger.mjs").PortsAllowEntry> }>} listAllowlist
 * @property {(peer: string, remotePort: number) => Promise<{ ok: true } | { ok: false, code: string, error?: string }>} grantAccess
 * @property {(peer: string, remotePort: number) => Promise<{ ok: true } | { ok: false, code: string }>} revokeAccess
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 *
 * @typedef {Object} PortsMappingStatus
 * @property {string} id
 * @property {string} name
 * @property {string} peer
 * @property {number} remotePort
 * @property {number} localPort
 * @property {boolean} enabled
 * @property {"listening" | "stopped" | "failed" | "stopping"} listener
 * @property {string | null} error
 */
