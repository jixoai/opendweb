// ports 插件双账本（webui-plugin-kernel Phase 1 / design §5、§2.3）。
// 意图（2026-09-29）：
// 1. 消费侧映射账本 `<home>/plugins/ports/mappings.json`：
//    {id, name, peer(endpointId), remotePort, localPort, enabled}——字段集按
//    design §5 冻结；0600 原子写 + 锁家族（mappings.lock）。
// 2. 提供侧授权账本 `<home>/plugins/ports/allowlist.json`：`(peer, remotePort)`
//    显式授权对，默认 deny；0600 原子写 + allowlist.lock。
// 3. 损坏 fail-closed：文件存在但非法 JSON/形状 → 抛错（调用方拒启，不静默
//    重置——state.mjs/NodeStore 同纪律）。
// 4. 变更一律锁内重读→改→原子写（acquireFileLock 家族，跨进程安全）。

import path from "node:path";
import { readFile } from "node:fs/promises";
import { acquireFileLock, atomicWrite0600 } from "./fsutil.mjs";

/** 插件数据目录名（<DWEB_HOME>/plugins/ports/——宿主 ensurePluginDataDir 同构） */
export const PORTS_DIR = "ports";
/** 映射账本文件名 */
export const MAPPINGS_FILE = "mappings.json";
/** 映射账本锁文件名 */
export const MAPPINGS_LOCK = "mappings.lock";
/** 授权账本文件名 */
export const ALLOWLIST_FILE = "allowlist.json";
/** 授权账本锁文件名 */
export const ALLOWLIST_LOCK = "allowlist.lock";

/** 端口值域（TCP；1..65535 整数） */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;
/** 名称上限（UTF-16 码元；与契约 TITLE_MAX 同拍量级） */
const NAME_MAX = 128;
/** endpointId 上限（z32 展示串量级，防御性上限） */
const PEER_MAX = 128;
/** 随机 id 字符集（crockford 小写——randomLeaseId 同族） */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** @param {number} port @returns {boolean} */
export function isValidPort(port) {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/**
 * 随机 12 字符映射 id（CSPRNG；`m-` 前缀）。
 * @param {() => Uint8Array} [random]
 * @returns {string}
 */
export function randomMappingId(random = () => globalThis.crypto.getRandomValues(new Uint8Array(12))) {
  return `m-${Array.from(random(), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("")}`;
}

/**
 * @returns {{ version: 1, mappings: Array<import("./ledger.mjs").PortsMapping> }}
 */
export function emptyMappingsLedger() {
  return { version: 1, mappings: [] };
}

/**
 * @returns {{ version: 1, entries: Array<import("./ledger.mjs").PortsAllowEntry> }}
 */
export function emptyAllowlistLedger() {
  return { version: 1, entries: [] };
}

/** @param {string} home */
export function portsDir(home) {
  return path.join(home, "plugins", PORTS_DIR);
}

/** @param {string} home */
export function mappingsPath(home) {
  return path.join(portsDir(home), MAPPINGS_FILE);
}

/** @param {string} home */
export function allowlistPath(home) {
  return path.join(portsDir(home), ALLOWLIST_FILE);
}

/**
 * 读映射账本（无文件=空账本；损坏=抛错 fail-closed）。
 * @param {string} home
 * @returns {Promise<ReturnType<typeof emptyMappingsLedger>>}
 */
export async function loadMappings(home) {
  const file = mappingsPath(home);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return emptyMappingsLedger();
    throw e;
  }
  const parsed = parseLedgerJson(text, file);
  if (parsed.version !== 1 || !Array.isArray(parsed.mappings)) {
    throw new Error(`ports mappings ledger has an invalid shape (${file})`);
  }
  for (const m of parsed.mappings) validateMappingEntry(m, file);
  return { version: 1, mappings: parsed.mappings };
}

/**
 * 读授权账本（无文件=空账本；损坏=抛错 fail-closed）。
 * @param {string} home
 * @returns {Promise<ReturnType<typeof emptyAllowlistLedger>>}
 */
export async function loadAllowlist(home) {
  const file = allowlistPath(home);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return emptyAllowlistLedger();
    throw e;
  }
  const parsed = parseLedgerJson(text, file);
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`ports allowlist ledger has an invalid shape (${file})`);
  }
  for (const e of parsed.entries) {
    if (
      typeof e.peer !== "string" ||
      e.peer === "" ||
      e.peer.length > PEER_MAX ||
      !isValidPort(e.remotePort)
    ) {
      throw new Error(`ports allowlist entry is malformed (${file})`);
    }
  }
  return { version: 1, entries: parsed.entries };
}

/** @param {string} text @param {string} file */
function parseLedgerJson(text, file) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`ports ledger is malformed (${file})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ports ledger is malformed (${file})`);
  }
  return parsed;
}

/**
 * 锁内变更映射账本：acquireFileLock → 锁内重读 → fn → 0600 原子写 → 释放。
 * @param {string} home
 * @param {(ledger: ReturnType<typeof emptyMappingsLedger>) => void | Promise<void>} fn 就地变更（重读后的最新状态）
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, code: "lock" }>}
 */
export async function mutateMappings(home, fn, ctx = {}) {
  const lock = await acquireFileLock(path.join(portsDir(home), MAPPINGS_LOCK), ctx);
  if (!lock.ok) return { ok: false, code: "lock" };
  try {
    const ledger = await loadMappings(home); // 锁内重读
    await fn(ledger);
    await atomicWrite0600(mappingsPath(home), `${JSON.stringify(ledger, null, 2)}\n`);
    return { ok: true };
  } finally {
    await lock.release();
  }
}

/**
 * 锁内变更授权账本（同 mutateMappings 协议）。
 * @param {string} home
 * @param {(ledger: ReturnType<typeof emptyAllowlistLedger>) => void | Promise<void>} fn
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, code: "lock" }>}
 */
export async function mutateAllowlist(home, fn, ctx = {}) {
  const lock = await acquireFileLock(path.join(portsDir(home), ALLOWLIST_LOCK), ctx);
  if (!lock.ok) return { ok: false, code: "lock" };
  try {
    const ledger = await loadAllowlist(home); // 锁内重读
    await fn(ledger);
    await atomicWrite0600(allowlistPath(home), `${JSON.stringify(ledger, null, 2)}\n`);
    return { ok: true };
  } finally {
    await lock.release();
  }
}

/**
 * 校验映射条目（形状门；字段集冻结——未知键不拒读（前向兼容）但已知键类型/值域
 * 精确校验）。
 * @param {unknown} m
 * @param {string} file
 * @returns {asserts m is import("./ledger.mjs").PortsMapping}
 */
function validateMappingEntry(m, file) {
  if (m === null || typeof m !== "object" || Array.isArray(m)) {
    throw new Error(`ports mapping entry is malformed (${file})`);
  }
  const r = /** @type {Record<string, unknown>} */ (m);
  if (typeof r.id !== "string" || r.id === "" || r.id.length > 64) throw new Error(`ports mapping entry is malformed (${file})`);
  if (typeof r.name !== "string" || r.name === "" || r.name.length > NAME_MAX) throw new Error(`ports mapping entry is malformed (${file})`);
  if (typeof r.peer !== "string" || r.peer === "" || r.peer.length > PEER_MAX) throw new Error(`ports mapping entry is malformed (${file})`);
  if (!isValidPort(r.remotePort) || !isValidPort(r.localPort)) throw new Error(`ports mapping entry is malformed (${file})`);
  if (typeof r.enabled !== "boolean") throw new Error(`ports mapping entry is malformed (${file})`);
}

/**
 * 新增映射（锁内重读去重 localPort？——不：同 localPort 多映射允许存在于账本，
 * 只有启用的映射会尝试绑定；端口冲突在 listener 启动处明确报错）。
 * @param {string} home
 * @param {{ name: string, peer: string, remotePort: number, localPort: number, enabled?: boolean, id?: string }} input
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true, mapping: import("./ledger.mjs").PortsMapping } | { ok: false, code: "invalid" | "lock", error: string }>}
 */
export async function addMapping(home, input, ctx = {}) {
  const invalid = (error) => ({ ok: false, code: "invalid", error });
  if (input === null || typeof input !== "object") return invalid("mapping input must be an object");
  if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > NAME_MAX) {
    return invalid(`name must be a non-empty string (<= ${NAME_MAX} chars)`);
  }
  if (typeof input.peer !== "string" || input.peer === "" || input.peer.length > PEER_MAX) {
    return invalid("peer must be a non-empty endpointId string");
  }
  if (!isValidPort(input.remotePort)) return invalid(`remotePort must be an integer in [${MIN_PORT}, ${MAX_PORT}]`);
  if (!isValidPort(input.localPort)) return invalid(`localPort must be an integer in [${MIN_PORT}, ${MAX_PORT}]`);
  const enabled = input.enabled ?? true;
  if (typeof enabled !== "boolean") return invalid("enabled must be a boolean");
  /** @type {import("./ledger.mjs").PortsMapping} */
  const mapping = { id: input.id ?? randomMappingId(), name: input.name, peer: input.peer, remotePort: input.remotePort, localPort: input.localPort, enabled };
  const w = await mutateMappings(
    home,
    (ledger) => {
      if (ledger.mappings.some((m) => m.id === mapping.id)) throw new Error(`duplicate mapping id ${mapping.id}`);
      ledger.mappings.push(mapping);
    },
    ctx,
  );
  if (!w.ok) return { ok: false, code: "lock" };
  return { ok: true, mapping };
}

/**
 * 删除映射。
 * @param {string} home
 * @param {string} id
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, code: "not-found" | "lock", error?: string }>}
 */
export async function removeMapping(home, id, ctx = {}) {
  let found = false;
  const w = await mutateMappings(
    home,
    (ledger) => {
      const before = ledger.mappings.length;
      ledger.mappings = ledger.mappings.filter((m) => m.id !== id);
      found = ledger.mappings.length < before;
    },
    ctx,
  );
  if (!w.ok) return { ok: false, code: "lock" };
  if (!found) return { ok: false, code: "not-found", error: `mapping ${id} not found` };
  return { ok: true };
}

/**
 * 启停映射（enabled 翻转）。
 * @param {string} home
 * @param {string} id
 * @param {boolean} enabled
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true, mapping: import("./ledger.mjs").PortsMapping } | { ok: false, code: "not-found" | "lock", error?: string }>}
 */
export async function setMappingEnabled(home, id, enabled, ctx = {}) {
  /** @type {import("./ledger.mjs").PortsMapping | null} */
  let updated = null;
  const w = await mutateMappings(
    home,
    (ledger) => {
      const m = ledger.mappings.find((x) => x.id === id);
      if (m === undefined) return;
      m.enabled = enabled;
      updated = m;
    },
    ctx,
  );
  if (!w.ok) return { ok: false, code: "lock" };
  if (updated === null) return { ok: false, code: "not-found", error: `mapping ${id} not found` };
  return { ok: true, mapping: updated };
}

/**
 * 授权 (peer, remotePort)（幂等：已存在=成功）。
 * @param {string} home
 * @param {string} peer
 * @param {number} remotePort
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, code: "invalid" | "lock", error?: string }>}
 */
export async function grantAccess(home, peer, remotePort, ctx = {}) {
  if (typeof peer !== "string" || peer === "" || peer.length > PEER_MAX) return { ok: false, code: "invalid", error: "peer must be a non-empty endpointId string" };
  if (!isValidPort(remotePort)) return { ok: false, code: "invalid", error: `remotePort must be an integer in [${MIN_PORT}, ${MAX_PORT}]` };
  const w = await mutateAllowlist(
    home,
    (ledger) => {
      if (!ledger.entries.some((e) => e.peer === peer && e.remotePort === remotePort)) {
        ledger.entries.push({ peer, remotePort });
      }
    },
    ctx,
  );
  return w.ok ? { ok: true } : { ok: false, code: "lock" };
}

/**
 * 撤销授权 (peer, remotePort)。
 * @param {string} home
 * @param {string} peer
 * @param {number} remotePort
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, code: "lock" }>}
 */
export async function revokeAccess(home, peer, remotePort, ctx = {}) {
  const w = await mutateAllowlist(
    home,
    (ledger) => {
      ledger.entries = ledger.entries.filter((e) => !(e.peer === peer && e.remotePort === remotePort));
    },
    ctx,
  );
  return w;
}

/**
 * 授权判定（默认 deny）。peer 编码归一（真双机验收实证）：账本/控制面存的
 * 是 hex64（server 台账冻结形态），fabric 会话（serveHttp/fetchHttp）对端是
 * z-base-32 展示串——同钥异码先归一再比，防「已授权仍 403」。
 * @param {string} home
 * @param {string} peer
 * @param {number} remotePort
 * @returns {Promise<boolean>}
 */
export async function isAccessAllowed(home, peer, remotePort) {
  const ledger = await loadAllowlist(home);
  const wanted = normalizePeerId(peer);
  return ledger.entries.some((e) => normalizePeerId(e.peer) === wanted && e.remotePort === remotePort);
}

/** peer id 归一：z-base-32（iroh to_z32：字母表 ybndrfg8ejkmcpqxot
 * 1uwisza345h769、MSB-first 位序）→ hex64 小写；hex64 与未知形态原样返回。
 * 实现与 webui core/fabric.mjs 的 z32ToHex 同源（包边界隔离，本包不反向
 * 依赖 webui）。 */
function normalizePeerId(peer) {
  if (typeof peer !== "string") return peer;
  if (/^[0-9a-f]{64}$/.test(peer)) return peer;
  if (!/^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(peer)) return peer;
  const A = "ybndrfg8ejkmcpqxot1uwisza345h769";
  let bits = 0;
  let value = 0n;
  const bytes = [];
  for (const ch of peer) {
    value = value * 32n + BigInt(A.indexOf(ch));
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push(Number((value >> BigInt(bits)) & 0xffn));
      value = value % (1n << BigInt(bits));
    }
  }
  return Buffer.from(bytes).toString("hex");
}

/**
 * @typedef {Object} PortsMapping
 * @property {string} id
 * @property {string} name
 * @property {string} peer 对端 endpointId
 * @property {number} remotePort 对端端口
 * @property {number} localPort 本机回环端口
 * @property {boolean} enabled
 *
 * @typedef {Object} PortsAllowEntry
 * @property {string} peer
 * @property {number} remotePort
 */
