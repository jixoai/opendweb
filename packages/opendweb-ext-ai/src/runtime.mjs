// ai 插件运行时工厂（ai-subscription-sharing Phase C / design §1 宿主接入）。
// 意图（2026-10-01）：
// 1. 工厂 createAiRuntime({home, fabric, log, now, env?})——经宿主
//    buildPluginRuntimes 装配（data-plane.mjs 惰性 import），交付宿主
//    runtimes 通道的 PluginRuntime 形状（onEnable/onDispose/onConfigChange）+
//    wireHandler（createWpkRouter routes.ai 挂点）+ mgmt（/sidecar/plugins/ai/*
//    管理面逻辑——sidecar 只做守卫与分发，逻辑在本包 mgmt.mjs）。
// 2. 双姿态共存互不排斥（design §1）：provider 面（wire handler + 服务/分组/
//    密钥账本）恒可装配；consumer 面（钥环 + 本地回环网关端点）按 keyring/
//    账本存在性装配。构造零副作用（不建目录、不起 fabric、不起 listener——
//    未启用 ai 的 sidecar 零代价；ProviderStore/SecretsStore/keyring 全惰性）。
// 3. 生命周期四步序（宿主 disable 序）：摘牌由宿主 wpk gate 承担（503）→
//    onDispose=consumer 端点全关（gateway.close 逐 listener closeAllConnections）
//    + 在途上游 abort（forwardPlane.dispose：relay.closeAll({code:"aborted"})）
//    → 宿主落盘。enable 逆序：配置解析（域校验拒启）→ provider 面装配
//    （ambient env 启动检测 fail-closed——assertStartupEnvSafety 在 wire handler
//    构造内）→ consumer 端点恢复（账本逐条起 listener，冲突真实报错入 state）。
// 4. 配置（configSchema: maxConcurrency/dailyRequests/usageLog，域校验在本层
//    ——schema 子集无 min/max 表达）：maxConcurrency 1–32 + 活跃 ring ≤64MiB
//    超积拒启（validateAdmission）；dailyRequests 0–1,000,000（组未显式声明时
//    的缺省日限）；usageLog bool（默认关）。onConfigChange 即时生效面：
//    dailyRequests（LimitEnforcer 内存态重挂）/usageLog（记录门开关）/
//    maxConcurrency（admission 包裹层即时收紧——底层 forward plane 固定按域
//    上限 32 构造，有效门在 wireHandler 入口判定，无需重建 plane、在途 rid
//    不受扰动）。
// 5. 零凭证：密钥原文只落 <DWEB_HOME>/plugins/ai/{services.json,keyring.json}
//    （0600 本机明文——上游 Owner 裁决同威胁模型）与本地管理面显式响应体
//    （签发/链接生成）；远程面（wire 响应/目录/usage/日志）恒掩码。本模块
//    不读 argv；env 仅经注入面（ambient env 检测的判定源）。

import path from "node:path";
import { homedir } from "node:os";
import { randomZ32 } from "./provider/z32.mjs";
import { ProviderStore } from "./provider/store.mjs";
import { SecretsStore } from "./provider/secrets.mjs";
import { LimitEnforcer, UsageLog } from "./provider/limits.mjs";
import { createForwardPlane, validateAdmission } from "./provider/forward.mjs";
import { createAiProviderWireHandler } from "./wire/endpoints.mjs";
import { DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY_MAX } from "./wire/constants.mjs";
import { openKeyring } from "./consumer/keyring.mjs";
import { createConsumerSession, WireError } from "./consumer/sessions.mjs";
import { createConsumerGateway } from "./consumer/gateway.mjs";
import { atomicWrite0600 } from "./fsutil.mjs";
import { createAiManagement } from "./mgmt.mjs";

/** 消费方本地端点账本文件名（<DWEB_HOME>/plugins/ai/consumer-endpoints.json）。 */
const CONSUMER_ENDPOINTS_FILE = "consumer-endpoints.json";
/** dailyRequests 域上限（design §1：0–1,000,000）。 */
const DAILY_REQUESTS_MAX = 1_000_000;

/**
 * 配置域校验（工厂域——schema 子集只有类型面）。
 * @param {Record<string, string | number | boolean>} values
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateAiConfig(values) {
  const v = values ?? {};
  if (v.maxConcurrency !== undefined) {
    const n = v.maxConcurrency;
    if (typeof n !== "number" || !Number.isInteger(n)) return { ok: false, error: "maxConcurrency must be an integer" };
    const admission = validateAdmission(n);
    if (!admission.ok) return { ok: false, error: `maxConcurrency: ${admission.error}` };
  }
  if (v.dailyRequests !== undefined) {
    const n = v.dailyRequests;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > DAILY_REQUESTS_MAX) {
      return { ok: false, error: `dailyRequests must be an integer in 0..${DAILY_REQUESTS_MAX}` };
    }
  }
  if (v.usageLog !== undefined && typeof v.usageLog !== "boolean") {
    return { ok: false, error: "usageLog must be a boolean" };
  }
  return { ok: true };
}

/**
 * ai 运行时。
 * @param {{
 *   home: string,
 *   fabric: {
 *     fetchHttpImpl: (session: unknown, request: object) => Promise<object>,
 *     sessionResolver: (peer: string) => Promise<unknown>,
 *     identity?: () => Promise<{ endpointId: string, deviceName: string } | null>,
 *     issueInvite?: (opts: { recipient: string, ttlMs?: number }) => Promise<{ token: string }>,
 *     ensureStarted?: () => Promise<unknown>,
 *   },
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   env?: (name: string) => string | undefined,
 *   random?: (n: number) => string,
 *   writerHome?: string,
 * }} opts
 */
export async function createAiRuntime(opts = {}) {
  const { home, fabric } = opts;
  if (typeof home !== "string" || home === "") throw new Error("createAiRuntime: home (DWEB_HOME absolute path) is required");
  if (fabric === null || typeof fabric !== "object") throw new Error("createAiRuntime: fabric (host injection face) is required");
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const env = opts.env ?? ((name) => process.env[name]);
  const random = opts.random ?? ((n) => randomZ32(n));
  // claude-code 写手的配置根（~/.claude——真实用户 home；与 DWEB_HOME 独立。
  // 测试注入 tmp 路径——绝不触真实用户目录）。
  const writerHome = opts.writerHome ?? homedir();
  const dataDir = path.join(home, "plugins", "ai");

  // ---- 惰性存储面（构造零 IO——未启用 ai 的 sidecar 不建目录） --------------------

  /** @type {ProviderStore | null} */
  let storeRef = null;
  /** @type {SecretsStore | null} */
  let secretsRef = null;

  /** provider 服务/分组/密钥账本（首次使用建 0700 目录）。 */
  async function store() {
    if (storeRef === null) {
      storeRef = await ProviderStore.open(dataDir, {
        env,
        secretsSource: (name) => secrets().exists(name),
        home,
      });
    }
    return storeRef;
  }

  /** 密钥库（secrets.json 0600 家族；无内存态）。 */
  function secrets() {
    if (secretsRef === null) secretsRef = new SecretsStore(dataDir);
    return secretsRef;
  }

  // ---- 配置态（enable 时解析；onConfigChange 即时生效） ---------------------------

  /** @type {{ maxConcurrency: number, dailyRequests: number | undefined, usageLog: boolean }} */
  let config = { maxConcurrency: DEFAULT_MAX_CONCURRENCY, dailyRequests: undefined, usageLog: false };

  // ---- provider 面（enable 装配 / dispose 拆除） -----------------------------------

  /**
   * provider 平面：forward plane（域上限构造——有效 admission 门在 wireHandler
   * 入口）+ wire handler + limits + usage 记录门。
   * @type {{
   *   wireHandler: (req: any, peer: string) => Promise<any>,
   *   forwardPlane: ReturnType<typeof createForwardPlane>,
   *   limits: LimitEnforcer,
   * } | null}
   */
  let plane = null;
  /** usage 记录门：config.usageLog 关闭时丢弃（UsageLog 惰性建目录）。 */
  const usageLog = {
    /** @param {{ ts: number, keyId: string, serviceId: string, status: number | string, bytes: number }} record */
    async append(record) {
      if (!config.usageLog) return;
      await new UsageLog(dataDir).append(record);
    },
  };

  /**
   * 组限额缺省重挂：未显式声明 dailyRequests 的组吃 config.dailyRequests
   * （显式声明优先——组限额是更具体的意图）。
   */
  function applyLimitDefaults(limits, st) {
    limits.syncFromStore(st);
    if (config.dailyRequests === undefined) return;
    for (const g of st.listGroups()) {
      if (g.limits?.dailyRequests === undefined) limits.setGroupLimits(g.name, { ...g.limits, dailyRequests: config.dailyRequests });
    }
  }

  /**
   * 装配 provider 面（enable 入口；ambient env 启动命中/超积/账本损坏=抛错
   * 拒启——宿主侧 enable-failed 回滚账本）。重复调用先拆旧面（disable→enable
   * 周期：新 epoch，旧在途 rid 自然 404——§3.2 重启语义同族）。
   */
  async function buildPlane() {
    if (plane !== null) await teardownPlane();
    const st = await store();
    const limits = new LimitEnforcer({ dataDir, now: () => new Date(now()) });
    applyLimitDefaults(limits, st);
    const forwardPlane = createForwardPlane({
      store: st,
      limits,
      // 域上限构造（admission 超积公式的最外包络）；有效门见 wireHandler。
      maxConcurrency: MAX_CONCURRENCY_MAX,
      usageLog,
      secrets: (name) => secrets().get(name),
      home,
      now,
      log: (level, msg) => log(`ai(${level}): ${msg}`),
    });
    const wireHandler = await createAiProviderWireHandler({
      store: st,
      limits,
      usageLog,
      forwardPlane,
      env,
      home,
      now,
      log: (level, msg) => log(`ai(${level}): ${msg}`),
    });
    plane = {
      wireHandler,
      forwardPlane,
      limits,
    };
  }

  /** 拆除 provider 面：在途上游 abort（relay closeAll）+ 扫描计时器停。 */
  async function teardownPlane() {
    const p = plane;
    plane = null;
    if (p !== null) await p.forwardPlane.dispose();
  }

  /**
   * wpk 数据面 handler（createWpkRouter routes.ai 挂点——恒注册；gate 由内核
   * 先行：未启用 503 plugin-disabled）。有效 admission 门在此判定（域上限内的
   * 即时收紧面——onConfigChange 无需重建 plane）。
   * @param {any} req
   * @param {string} peer
   */
  async function wireHandler(req, peer) {
    if (req?.signal?.aborted) return null;
    if (plane === null) {
      return {
        status: 503,
        headers: [{ name: "content-type", value: "application/json" }],
        bodyChunks: [Buffer.from(JSON.stringify({ error: { code: "ai-provider-not-running", message: "the ai provider plane is not assembled" } }))],
      };
    }
    if (plane.forwardPlane.relay.activeCount() >= config.maxConcurrency) {
      return {
        status: 429,
        headers: [{ name: "content-type", value: "application/json" }],
        bodyChunks: [Buffer.from(JSON.stringify({ error: { code: "rate_limited", message: "provider upstream concurrency limit reached" } }))],
      };
    }
    return plane.wireHandler(req, peer);
  }

  // ---- consumer 面（钥环 + 本地回环网关端点） --------------------------------------

  /** @type {Awaited<ReturnType<typeof openKeyring>> | null} */
  let keyringRef = null;
  /** @type {Map<string, ReturnType<typeof createConsumerGateway>>} providerEndpointId → gateway */
  const gateways = new Map();
  /** @type {Map<string, { close: () => Promise<void>, startedAt: number }>} 端点账本 id → 活跃 listener */
  const activeListeners = new Map();
  /** @type {{ version: 1, endpoints: Array<{ id, providerEndpointId, serviceId, name, port, createdAt }> }} */
  let endpointsLedger = { version: 1, endpoints: [] };
  let endpointsLoaded = false;

  function endpointsFile() {
    return path.join(dataDir, CONSUMER_ENDPOINTS_FILE);
  }

  /** 端点账本加载（损坏=抛错 fail-closed——与 keyring 同纪律）。 */
  async function loadEndpoints() {
    if (endpointsLoaded) return;
    endpointsLoaded = true;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(endpointsFile(), "utf8");
      if (raw.trim() === "") return;
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || !Array.isArray(parsed.endpoints)) {
        throw new Error("invalid shape");
      }
      endpointsLedger = parsed;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return;
      throw new Error(`ai consumer endpoints ledger is malformed (${endpointsFile()})`);
    }
  }

  async function saveEndpoints() {
    await atomicWrite0600(endpointsFile(), `${JSON.stringify(endpointsLedger, null, 2)}\n`);
  }

  /** 钥环（首次使用开——plugins/ai/keyring.json 0600）。 */
  async function keyring() {
    if (keyringRef === null) keyringRef = await openKeyring(path.join(dataDir, "keyring.json"));
    return keyringRef;
  }

  /**
   * 消费侧 wire fetchImpl 适配（宿主注入面 → sessions 契约）：每调用经
   * sessionResolver 取（缓存的）会话，body 逐块透传（v1 单片 ≤1MiB 帧），
   * 响应 bodyNext 拉平为 bodyChunks。
   * @param {string} peer
   */
  function consumerFetch(peer) {
    return async (init) => {
      const session = await fabric.sessionResolver(peer);
      if (session === null || session === undefined) {
        throw new WireError(502, "internal", `no fabric session to provider ${peer}`);
      }
      const resp = await fabric.fetchHttpImpl(session, {
        method: init.method,
        path: init.path,
        headers: init.headers ?? [],
        ...(init.body !== undefined && init.body.length > 0 ? { body: init.body } : {}),
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
      });
      /** @type {Buffer[]} */
      const bodyChunks = [];
      for (;;) {
        const chunk = await resp.bodyNext();
        if (chunk === null) break;
        bodyChunks.push(Buffer.from(chunk));
      }
      return { status: resp.status, headers: resp.headers ?? [], bodyChunks };
    };
  }

  /** provider 专属 gateway（session 绑定 provider peer——一 provider 一 gateway）。 */
  function gatewayFor(peer) {
    let gw = gateways.get(peer);
    if (gw === undefined) {
      gw = createConsumerGateway({ session: createConsumerSession({ fetchImpl: consumerFetch(peer), log: (level, msg) => log(`ai-gw(${level}): ${msg}`) }) });
      gateways.set(peer, gw);
    }
    return gw;
  }

  /**
   * 起一个消费端点：钥环定位 provider/服务/密钥 → gateway.startService（端口
   * 冲突=真实 listen 错误上抛——不静默换端口）→ 账本登记。
   * @param {{ providerEndpointId: string, serviceId: string, port: number }} input
   * @returns {Promise<{ id: string, endpoint: object }>}
   */
  async function startConsumerEndpoint(input) {
    await loadEndpoints();
    const kr = await keyring();
    const provider = kr.findProvider(input.providerEndpointId);
    if (provider === undefined) {
      throw Object.assign(new Error(`provider '${input.providerEndpointId}' is not imported on this machine`), { code: "invalid" });
    }
    const service = /** @type {Array<Record<string, any>>} */ (provider.services).find((s) => s?.serviceId === input.serviceId);
    if (service === undefined) {
      throw Object.assign(new Error(`service '${input.serviceId}' is not in the imported catalog for '${provider.alias}' (refresh first)`), { code: "invalid" });
    }
    const key = provider.keys.find((k) => k.keyId !== "" && k.key !== "");
    if (key === undefined) {
      throw Object.assign(new Error(`no authorized key for provider '${provider.alias}' (refresh the catalog to complete AUTH first)`), { code: "invalid" });
    }
    // 路由白名单（prefix 模式；pattern 路由 v1 不映射——mapRoute 仅前缀语义）
    const routes = (service.detail?.routes ?? []).filter((r) => r?.mode !== "pattern").map((r) => ({ localPrefix: r.localPrefix, upstreamPrefix: r.upstreamPrefix }));
    if (routes.length === 0) routes.push({ localPrefix: "/", upstreamPrefix: "/" });
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw Object.assign(new Error("port must be an integer in 1..65535"), { code: "invalid" });
    }
    const duplicate = endpointsLedger.endpoints.find((e) => e.providerEndpointId === input.providerEndpointId && e.serviceId === input.serviceId);
    if (duplicate !== undefined) {
      throw Object.assign(new Error(`local endpoint for service '${service.name ?? input.serviceId}' already exists (port ${duplicate.port})`), { code: "conflict" });
    }
    const gw = gatewayFor(provider.endpointId);
    const listener = await gw.startService({
      serviceId: input.serviceId,
      name: typeof service.name === "string" ? service.name : input.serviceId,
      port: input.port,
      routes,
      keyId: key.keyId,
    });
    const entry = {
      id: random(6),
      providerEndpointId: provider.endpointId,
      serviceId: input.serviceId,
      name: typeof service.name === "string" ? service.name : input.serviceId,
      port: listener.port,
      createdAt: now(),
    };
    endpointsLedger.endpoints.push(entry);
    await saveEndpoints();
    activeListeners.set(entry.id, { close: listener.close, startedAt: now() });
    log(`ai consumer: local endpoint 127.0.0.1:${entry.port} -> ${provider.alias}/${entry.serviceId}`);
    return { id: entry.id, endpoint: consumerEndpointView(entry) };
  }

  /** 账本条目 → 视图（listener 运行态合并）。 */
  function consumerEndpointView(entry) {
    const active = activeListeners.get(entry.id);
    return { ...entry, listener: active !== undefined ? "listening" : "stopped", error: null };
  }

  /**
   * 停一个消费端点（listener 关闭 + 账本移除；幂等——未知 id=not-found）。
   * @param {string} id
   */
  async function stopConsumerEndpoint(id) {
    await loadEndpoints();
    const idx = endpointsLedger.endpoints.findIndex((e) => e.id === id);
    if (idx < 0) throw Object.assign(new Error(`consumer endpoint '${id}' not found`), { code: "not-found" });
    const [entry] = endpointsLedger.endpoints.splice(idx, 1);
    const active = activeListeners.get(id);
    if (active !== undefined) {
      activeListeners.delete(id);
      await active.close();
    }
    await saveEndpoints();
    return { removed: entry };
  }

  /** consumer 端点全关（onDispose 面；账本保留——下次 enable 恢复）。 */
  async function closeConsumerEndpoints() {
    const closes = [];
    for (const [id, handle] of [...activeListeners]) {
      activeListeners.delete(id);
      closes.push(handle.close().catch(() => undefined));
    }
    await Promise.all(closes);
    for (const gw of gateways.values()) await gw.close();
    gateways.clear();
  }

  /** enable 恢复：账本逐条起 listener（失败记 state 不阻塞其余——真实报错面）。 */
  async function restoreConsumerEndpoints() {
    await loadEndpoints();
    for (const entry of [...endpointsLedger.endpoints]) {
      try {
        // 复用 startConsumerEndpoint 的钥环定位/路由推导（先摘账本条目再重建）
        endpointsLedger.endpoints = endpointsLedger.endpoints.filter((e) => e.id !== entry.id);
        await startConsumerEndpoint({ providerEndpointId: entry.providerEndpointId, serviceId: entry.serviceId, port: entry.port });
      } catch (e) {
        // 恢复失败：保留账本条目（stopped 态）——端口被占/钥环变动后可手动重试
        endpointsLedger.endpoints.push(entry);
        log(`ai consumer: restore of 127.0.0.1:${entry.port} (${entry.serviceId}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await saveEndpoints();
  }

  /**
   * 写手目标解析（endpointId → 活跃端点 + anthropic 路由投影）。要求端点正在
   * 监听（写进配置的端口必须真实可用）；pattern 路由不参与写手 base 推导。
   * @param {string} endpointId
   * @returns {Promise<{ port: number, routes: Array<{ forms: string[], localPrefix: string }> }>}
   */
  async function writerTarget(endpointId) {
    await loadEndpoints();
    const entry = endpointsLedger.endpoints.find((e) => e.id === endpointId);
    if (entry === undefined) {
      throw Object.assign(new Error(`consumer endpoint '${endpointId}' not found`), { code: "not-found" });
    }
    if (!activeListeners.has(entry.id)) {
      throw Object.assign(new Error(`local endpoint 127.0.0.1:${entry.port} is not listening (start it first)`), { code: "conflict" });
    }
    const kr = await keyring();
    const provider = kr.findProvider(entry.providerEndpointId);
    const service = /** @type {Array<Record<string, any>>} */ (provider?.services ?? []).find((s) => s?.serviceId === entry.serviceId);
    const routes = /** @type {Array<Record<string, any>>} */ (service?.detail?.routes ?? [])
      .filter((r) => (r?.mode ?? "prefix") !== "pattern")
      .map((r) => ({ forms: Array.isArray(r?.forms) ? r.forms : [], localPrefix: typeof r?.localPrefix === "string" ? r.localPrefix : "" }));
    return { port: entry.port, routes };
  }

  /**
   * claude-code 写手预览（Phase D1：surgical 合成 + diff + sha256 令牌；不写盘）。
   * @param {string} endpointId
   */
  async function previewWriter(endpointId) {
    const { previewClaudeCodeWriter } = await import("./consumer/writers/claude-code.mjs");
    const target = await writerTarget(endpointId);
    const preview = await previewClaudeCodeWriter({ home: writerHome, ...target });
    return { endpointId, ...preview };
  }

  /**
   * claude-code 写手应用（令牌不符 → 409 stale-preview；文件不写任何真实凭证）。
   * @param {string} endpointId
   * @param {string} tokenSha256
   */
  async function applyWriter(endpointId, tokenSha256) {
    const { applyClaudeCodeWriter, WriterError } = await import("./consumer/writers/claude-code.mjs");
    const target = await writerTarget(endpointId);
    try {
      return await applyClaudeCodeWriter({ home: writerHome, ...target }, tokenSha256);
    } catch (e) {
      if (e instanceof WriterError && (e.code === "invalid_settings" || e.code === "stale_preview")) {
        throw Object.assign(new Error(e.message), { code: e.code === "stale_preview" ? "stale-preview" : "invalid-settings" });
      }
      throw e;
    }
  }

  /**
   * 消费方目录刷新（AUTH 回填 + catalog 快照）：逐 key 单独 AUTH（精确回填
   * keyId/group——多 key AUTH 响应不含 key→keyId 映射），再按首个有效 key 拉全量
   * catalog 更新服务快照。需要 fabric（宿主注入面 ensureStarted 惰性起）。
   * @param {string | undefined} providerRef 定位一个 provider；undefined=全部
   */
  async function refreshProviders(providerRef) {
    const kr = await keyring();
    if (typeof fabric.ensureStarted === "function") await fabric.ensureStarted();
    const targets = providerRef !== undefined && providerRef !== "" ? [kr.findProvider(providerRef)] : kr.snapshot().providers;
    const results = [];
    for (const provider of targets) {
      if (provider === undefined) {
        results.push({ ok: false, error: `provider '${providerRef}' is not imported on this machine` });
        continue;
      }
      try {
        const session = createConsumerSession({ fetchImpl: consumerFetch(provider.endpointId), log: (level, msg) => log(`ai-c(${level}): ${msg}`) });
        /** 逐 key AUTH：回填 keyId/group（失败 key 保留原状——撤销/失效面如实呈现） */
        for (const key of provider.keys) {
          try {
            const auth = await session.auth([key.key]);
            const group = auth.groups[0];
            if (group !== undefined) {
              key.keyId = group.keyId;
              key.group = group.group;
            }
          } catch {
            /* key_invalid/key_revoked——保留旧值；错误经 results 呈现 */
          }
        }
        const active = provider.keys.find((k) => k.keyId !== "");
        if (active !== undefined) {
          const cat = await session.catalog({ keyId: active.keyId, since: 0 });
          if (cat.changed && Array.isArray(cat.catalog?.groups)) {
            const services = cat.catalog.groups.flatMap((g) => g.services ?? []);
            if (services.length > 0) provider.services = services;
          }
        }
        results.push({ ok: true, endpointId: provider.endpointId, alias: provider.alias });
      } catch (e) {
        results.push({ ok: false, endpointId: provider.endpointId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    await kr.save();
    return { results };
  }

  // ---- 管理面（逻辑在 mgmt.mjs；本工厂只注入闭包） ----------------------------------

  /**
   * 账本变更后重挂组限额缺省（import-commit/新增分组后新组吃 config.dailyRequests）。
   */
  async function refreshLimitDefaults() {
    const p = plane;
    if (p === null) return;
    applyLimitDefaults(p.limits, await store());
  }

  const mgmt = createAiManagement({
    dataDir,
    now,
    log,
    store,
    secrets,
    getPlane: () => plane,
    getConfig: () => ({ ...config }),
    refreshLimitDefaults,
    consumer: {
      keyring,
      refreshProviders,
      loadEndpoints: async () => {
        await loadEndpoints();
        return endpointsLedger.endpoints.map(consumerEndpointView);
      },
      startConsumerEndpoint,
      stopConsumerEndpoint,
      previewWriter,
      applyWriter,
    },
    fabric,
  });

  // ---- 宿主 runtimes 通道形状 -------------------------------------------------------

  /**
   * 配置归一（宿主 PUT config 只落**已提交键**——validatePluginConfig 的规范化
   * 副本不含未提交项；与当前生效值合并后再域校验，防止改一项丢其余）。
   * @param {Record<string, string | number | boolean>} values 已提交键
   * @param {typeof config} prev 当前生效值
   */
  function mergeConfig(values, prev) {
    const merged = { ...prev, ...(values ?? {}) };
    const check = validateAiConfig(merged);
    if (!check.ok) throw new Error(`ai plugin config is invalid: ${check.error}`);
    return {
      maxConcurrency: typeof merged.maxConcurrency === "number" ? merged.maxConcurrency : DEFAULT_MAX_CONCURRENCY,
      dailyRequests: typeof merged.dailyRequests === "number" ? merged.dailyRequests : undefined,
      usageLog: merged.usageLog === true,
    };
  }

  return {
    /** enable 逆序装配钩子：配置域校验 → provider 面装配 → consumer 端点恢复。 */
    onEnable: async (ctx) => {
      config = mergeConfig(ctx?.config ?? {}, config);
      await buildPlane();
      await restoreConsumerEndpoints();
    },
    /** dispose 钩子：端点全关 + 在途上游 abort（drain 由 relay closeAll 有界收敛）。 */
    onDispose: async () => {
      await closeConsumerEndpoints();
      await teardownPlane();
    },
    /** 配置即时生效（dailyRequests/usageLog/maxConcurrency——见头注 4）。 */
    onConfigChange: async (values) => {
      const prev = config;
      config = mergeConfig(values ?? {}, prev);
      if (plane !== null && (prev.dailyRequests !== config.dailyRequests || prev.maxConcurrency !== config.maxConcurrency)) {
        // 日限缺省重挂（显式组限额不受影响）；maxConcurrency 已由 wireHandler 门即时生效
        const st = await store();
        applyLimitDefaults(plane.limits, st);
      }
    },
    /** wpk 数据面挂点（恒注册；内核 gate 先行）。 */
    wireHandler,
    /** 管理面（sidecar 分发消费）。 */
    mgmt,
    /** 运行态观测（测试/UI）。 */
    stats() {
      return {
        providerRunning: plane !== null,
        ...(plane !== null ? { epoch: plane.forwardPlane.epoch, inflight: plane.forwardPlane.relay.activeCount(), maxConcurrency: config.maxConcurrency } : {}),
        consumerEndpoints: activeListeners.size,
        config: { ...config },
      };
    },
    /** 直连生命周期（测试/编排者不经宿主时的入口；幂等）。 */
    async start(ctx = {}) {
      if (plane !== null) return;
      await this.onEnable(ctx);
    },
    async stop() {
      await this.onDispose();
    },
  };
}
