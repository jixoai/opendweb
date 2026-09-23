// 本机数据面 + 模式分流（home-hub Phase 2b / specs/webui「sidecar 模式分流」
// +「sidecar 本机数据面」/ design §4.2 五行表）。
// 意图（2026-09-25）：
// 1. resolveLaunch：CLI 无参启动时的五行分流裁决（显式 --server 由调用方先行，
//    本函数只裁决无参 + 可选 --setup 的剩余三行）——hub.json 存在→hub 本机
//    自动（admin，读 hub-token 进程内连本机中枢）；无 hub.json + 有 leases/
//    visits→member；零数据→setup；--setup 恒强制 setup。
// 2. 租约/到访/中枢的只读投影（GET /sidecar/leases|visits|hub 的数据源）：
//    读写一律经 workspace 依赖复用 packages/opendweb/src/leases.mjs 的
//    loadLeases/loadVisits/recordVisit/probeServer（锁协议与探测五类映射不在
//    webui 重写）；leases 投影附 expires_in（本地快照语义）。
// 3. setLeaseLabel：label 行内编辑的唯一写入口——经 leases.mjs 同款锁协议
//    （acquireFileLock + 锁内重读 + 原子写 + 锁归属校验释放）；id=条目不透明
//    键；空串归一 null=清除；≤64 UTF-8 字节；未知 id → not-found。
// 4. hub 投影：hub.json + 接入卡片模型（cardkit.hubCardModel 同源）+ 运行
//    探测（/healthz）——绝不含 hub-token。
// 纪律：hub-token 只进 sidecar 进程内存（row-2 target 注入），不出现在任何
// 投影/日志/响应。

import { existsSync } from "node:fs";
import path from "node:path";
import {
  LEASES_FILE,
  VISITS_FILE,
  acquireFileLock,
  loadLeases,
  loadVisits,
  probeServer,
  recordVisit,
  saveLeases,
} from "opendweb/src/leases.mjs";
import { probeBindBase } from "opendweb/src/server-chain.mjs";
import { hubCardModel, qrSvg } from "./cardkit.mjs";

/** label 上限（UTF-8 字节；spec 冻结） */
export const LABEL_MAX_BYTES = 64;
/** leases.lock 名称（leases.mjs 同款派生） */
const LEASES_LOCK = `${LEASES_FILE.replace(/\.json$/, "")}.lock`;
/** hub /healthz 运行探测超时 */
export const HUB_PROBE_TIMEOUT_MS = 1_500;

/**
 * hub.mjs 懒加载面（loadHubState/readHubToken/renderHubCard 的宿主）。hub.mjs
 * 传递依赖较重（config-file 链拉 zod/smol-toml）——显式 --server 的 CLI 启动
 * 路径零成本；真实安装中 opendweb 是声明依赖（node_modules 并存），懒加载
 * 只隔离启动面不改变可用性。模块不可达=null（fail-closed：按无中枢数据分流）。
 */
let hubModule = undefined;
async function loadHubModule() {
  if (hubModule === undefined) {
    hubModule = await import("opendweb/src/hub.mjs").then(
      (m) => m,
      () => null,
    );
  }
  return hubModule;
}

/**
 * 分流裁决结果。
 * @typedef {Object} LaunchDecision
 * @property {"hub-local" | "member" | "setup"} kind
 *   - hub-local：row 2（hub.json 存在——admin，hub 本机自动）
 *   - member：row 3（无 hub.json + 有 leases/visits 数据）
 *   - setup：row 4/5（零数据基线 / --setup 强制）
 * @property {Record<string, unknown> | null} hubState hub.json（hub-local 时非 null）
 * @property {string | null} hubToken hub-token（hub-local 且可读时；只进调用方进程内存）
 * @property {string | null} hubBase 本机中枢 admin base（hub-local 时非 null）
 */

/**
 * 无参启动分流（design §4.2 五行表的 row 2-5；row 1 显式 --server 由调用方
 * 先行处理，不进本函数）。hub-token 读取失败（init 半程残留）按 hub-local
 * 降级处理：admin 姿态保持（hub.json 存在），token/base 为 null——UI 落中枢
 * 视角 + 中枢状态卡（服务不可用形态）。
 * @param {{ home: string, setup?: boolean, readToken?: (home: string) => Promise<string> }} input
 *   - home：DWEB_HOME 绝对路径
 *   - setup：--setup flag（任何状态强制 setup，row 5）
 * @returns {Promise<LaunchDecision>}
 */
export async function resolveLaunch({ home, setup = false, readToken }) {
  if (setup) return { kind: "setup", hubState: null, hubToken: null, hubBase: null };
  /** @type {Record<string, unknown> | null} */
  let hubState = null;
  const hubMod = await loadHubModule();
  if (hubMod !== null) {
    try {
      hubState = await hubMod.loadHubState(home);
    } catch {
      hubState = null; // 损坏的 hub.json 不阻断启动——按无中枢数据处理
    }
  }
  if (hubState !== null) {
    const base = probeBindBase(String(hubState.gateway_bind ?? "0.0.0.0:8787"));
    /** @type {string | null} */
    let token = null;
    try {
      token = await (readToken ?? defaultReadToken)(home);
    } catch {
      token = null; // 半程 init 残留：admin 姿态保持，连接材料缺失如实呈现
    }
    return { kind: "hub-local", hubState, hubToken: token, hubBase: base };
  }
  const hasData = existsSync(path.join(home, LEASES_FILE)) || existsSync(path.join(home, VISITS_FILE));
  return hasData
    ? { kind: "member", hubState: null, hubToken: null, hubBase: null }
    : { kind: "setup", hubState: null, hubToken: null, hubBase: null };
}

/** hub-token 读取（hub.mjs readHubToken；失败上抛由调用方降级）。 */
async function defaultReadToken(home) {
  const hub = await loadHubModule();
  if (hub === null) throw new Error("opendweb/src/hub.mjs is not available");
  return hub.readHubToken(home);
}

// ---- 租约投影 ---------------------------------------------------------------------

/**
 * GET /sidecar/leases 数据源：leases.json 投影 + expires_in（毫秒，可负=已
 * 过期；本地快照语义——管理端续期不回写本机，spec「倒计时为本地快照」）。
 * @param {string} home
 * @param {{ now?: () => number }} [ctx]
 * @returns {Promise<{ leases: Array<Record<string, unknown> & { id: string, expires_in: number }> }>}
 */
export async function leasesProjection(home, ctx = {}) {
  const now = ctx.now ?? Date.now;
  const ledger = await loadLeases(home);
  return {
    leases: ledger.leases.map((e) => ({
      id: e.id,
      server: e.server,
      relay_url: e.relay_url,
      server_id: e.server_id,
      fabric_id: e.fabric_id,
      root: e.root,
      alias: e.alias,
      label: e.label,
      registered_at: e.registered_at,
      expires_at: e.expires_at,
      expires_in: typeof e.expires_at === "number" ? e.expires_at - now() : null,
      receipt: e.receipt,
    })),
  };
}

// ---- 到访投影 ---------------------------------------------------------------------

/**
 * GET /sidecar/visits 数据源：visits.json 原样投影（best-effort 账本）。
 * @param {string} home
 */
export async function visitsProjection(home) {
  const book = await loadVisits(home);
  return { visits: book.visits };
}

// ---- 探测（五类映射经路由；锁写复用 recordVisit） -----------------------------------

/**
 * POST /sidecar/visits/probe 数据源：无凭证 GET <origin>/services.json（五类
 * 映射冻结在 leases.mjs probeServer），结果落 visits.json（recordVisit 锁写）。
 * @param {string} home
 * @param {string} server 目标 origin（http(s) URL）
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ probe: { result: "reachable" | "unreachable", detail: string | null, at: number }, entry: Record<string, unknown> }>}
 */
export async function probeVisit(home, server, ctx = {}) {
  const probe = await probeServer(server, { fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs, now: ctx.now });
  const { entry } = await recordVisit(
    home,
    { server, probe },
    { now: ctx.now, isPidAlive: ctx.isPidAlive },
  );
  return {
    probe: { result: probe.result, detail: probe.detail, at: probe.at },
    entry,
  };
}

// ---- label 写入（leases.mjs 锁协议） ------------------------------------------------

/**
 * PATCH /sidecar/leases/{id}/label 数据源。
 * 校验序：label 形态（string|null，≤64 UTF-8 字节；空串→null=清除）→ 锁获取
 * → 锁内重读 → id 命中 → 改写 → 原子落盘 → 锁归属校验释放。join 并发写经
 * 同一 leases.lock 串行（两更新俱在）。
 * @param {string} home
 * @param {string} id 条目不透明键
 * @param {string | null} label
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true, lease: Record<string, unknown> } | { ok: false, code: "too-long" | "not-found" | "lock" }>}
 */
export async function setLeaseLabel(home, id, label, ctx = {}) {
  if (label !== null && typeof label === "string" && label !== "" && Buffer.byteLength(label, "utf8") > LABEL_MAX_BYTES) {
    return { ok: false, code: "too-long" };
  }
  const lock = await acquireFileLock(path.join(home, LEASES_LOCK), { now: ctx.now, isPidAlive: ctx.isPidAlive });
  if (!lock.ok) return { ok: false, code: "lock" };
  try {
    const ledger = await loadLeases(home); // 锁内重读
    const entry = ledger.leases.find((e) => e.id === id);
    if (entry === undefined) return { ok: false, code: "not-found" };
    entry.label = label === "" ? null : label;
    await saveLeases(home, ledger);
    return { ok: true, lease: entry };
  } finally {
    await lock.release();
  }
}

// ---- hub 投影（GET /sidecar/hub；无 hub.json=404） ----------------------------------

/**
 * hub.json 投影 + 接入卡片模型（与 CLI hub card 同源：cardkit.hubCardModel +
 * qrSvg 同一矩阵）+ 运行探测。绝不返回 hub-token。
 * @param {string} home
 * @param {{ hostname?: string, interfaces?: object, fetchImpl?: typeof fetch }} [ctx]
 * @returns {Promise<null | { version: number, machine: string, urls: string[], primary_url: string, short_code: string, qr_svg: string, gateway_bind: string, running: boolean }>}
 */
export async function hubProjection(home, ctx = {}) {
  const hubMod = await loadHubModule();
  if (hubMod === null) throw new Error("opendweb/src/hub.mjs is not available");
  let state;
  try {
    state = await hubMod.loadHubState(home);
  } catch (e) {
    throw new Error(`invalid hub state: ${/** @type {Error} */ (e).message}`);
  }
  if (state === null) return null;
  const gatewayBind = String(state.gateway_bind ?? "0.0.0.0:8787");
  const model = hubCardModel({
    hostname: ctx.hostname,
    interfaces: /** @type {NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>} */ (ctx.interfaces),
    gatewayBind,
  });
  const base = probeBindBase(gatewayBind);
  const running = await probeHealthz(base, ctx.fetchImpl);
  return {
    version: typeof state.version === "number" ? state.version : 1,
    machine: model.machine,
    urls: model.urls,
    primary_url: model.primaryUrl,
    short_code: model.shortCode,
    qr_svg: qrSvg(model.primaryUrl),
    gateway_bind: gatewayBind,
    running,
  };
}

/** hub 运行探测（/healthz on 127.0.0.1 bind base；不可达=false，不抛）。 */
async function probeHealthz(base, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HUB_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/healthz`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * hub 槽位快照（getSnapshot().hub；fs-only 部分，running=null=未探测）。
 * @param {string} home
 * @param {{ hostname?: string, interfaces?: object }} [ctx]
 */
export async function hubSnapshotSlot(home, ctx = {}) {
  const hubMod = await loadHubModule();
  let state;
  if (hubMod !== null) {
    try {
      state = await hubMod.loadHubState(home);
    } catch {
      return null;
    }
  } else {
    state = null;
  }
  if (state === null) return null;
  const gatewayBind = String(state.gateway_bind ?? "0.0.0.0:8787");
  const model = hubCardModel({
    hostname: ctx.hostname,
    interfaces: /** @type {NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>} */ (ctx.interfaces),
    gatewayBind,
  });
  return {
    present: true,
    machine: model.machine,
    primary_url: model.primaryUrl,
    short_code: model.shortCode,
    running: null,
  };
}
