// 同步组账本（webui-plugin-kernel Phase 3 / design v2.3 §7.2）。
// 意图（2026-09-29）：
// 1. `<DWEB_HOME>/plugins/sync/groups.json`：{version, groups:[{id, name,
//    members:[{endpointId, deviceName}], roots:[{id, localPath, mode,
//    seedAuthority}]}]}——账本/ref 命名自 v1 记录 N 成员 [W8]；v1 执行只保证
//    双机 pairwise（第三成员加入/多端 fan-in 收敛为后续 change 显式义务）。
// 2. 写路径走文件锁（acquireFileLock 家族纪律，util.mjs 复制版）：锁内重读 →
//    变更 → 0600 原子写。groupId/rootId 先过字符集（路径拼接逃逸防线）。
// 3. gitdir 布局：`<home>/plugins/sync/<groupId>/<rootId>/git`（独立于用户目录；
//    工作树=用户目录 root 本体）；`<root>/.dweb-sync` 元数据目录（ignore 语义
//    见 ignore.mjs）。
// 4. 建组是本地账本操作：两端各自 createGroup（成员表一致、groupId 一致）——
//    对端 serveHttp 端点按「peer ∈ members」授权（deny-by-default）。跨端组
//    分发协议（组账本自动同步）不在 v1（显式记录，非静默）。

import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { acquireFileLock, atomicWrite0600 } from "./util.mjs";

/** 同步插件数据目录名（<home>/plugins/sync/） */
export const SYNC_DIR = "sync";
/** 组账本文件名 */
export const GROUPS_FILE = "groups.json";
/** 同步根模式：oneway=只读镜像（fetch+fast-forward）；twoway=fetch+merge+push */
export const ROOT_MODES = new Set(["oneway", "twoway"]);

/** id 字符集（与 webui 插件契约同族；路径拼接前的逃逸防线） */
const ID_RE = /^[a-z][a-z0-9-]*$/;
/** endpointId：hex（fabric endpoint id 形态） */
const ENDPOINT_RE = /^[0-9a-f]{8,64}$/;

/** @param {string} home */
export function syncDataDir(home) {
  return path.join(home, "plugins", SYNC_DIR);
}

/** @param {string} home @param {string} groupId @param {string} rootId */
export function repoDir(home, groupId, rootId) {
  if (!ID_RE.test(groupId)) throw new Error(`groupId must match ${ID_RE} (got ${JSON.stringify(groupId)})`);
  if (!ID_RE.test(rootId)) throw new Error(`rootId must match ${ID_RE} (got ${JSON.stringify(rootId)})`);
  return path.join(home, "plugins", SYNC_DIR, groupId, rootId);
}

/** @param {string} home @param {string} groupId @param {string} rootId */
export function gitdirFor(home, groupId, rootId) {
  return path.join(repoDir(home, groupId, rootId), "git");
}

/**
 * 空账本。
 * @returns {{ version: 1, groups: SyncGroup[] }}
 */
export function emptyLedger() {
  return { version: 1, groups: [] };
}

/**
 * 校验组记录形状（账本入口统一防线——损坏 fail-closed 抛错，不静默重置）。
 * @param {unknown} g
 * @returns {SyncGroup}
 */
export function assertGroupValid(g) {
  if (g === null || typeof g !== "object" || Array.isArray(g)) throw new Error("ledger: group must be an object");
  const grp = /** @type {Record<string, unknown>} */ (g);
  if (typeof grp.id !== "string" || !ID_RE.test(grp.id)) throw new Error(`ledger: group id invalid (${JSON.stringify(grp.id)})`);
  if (typeof grp.name !== "string" || grp.name === "" || grp.name.length > 64) throw new Error(`ledger: group "${grp.id}" name invalid`);
  if (!Array.isArray(grp.members) || grp.members.length === 0) throw new Error(`ledger: group "${grp.id}" members must be a non-empty array`);
  const seen = new Set();
  const members = grp.members.map((m) => {
    if (m === null || typeof m !== "object" || Array.isArray(m)) throw new Error(`ledger: group "${grp.id}" member must be an object`);
    const mm = /** @type {Record<string, unknown>} */ (m);
    if (typeof mm.endpointId !== "string" || !ENDPOINT_RE.test(mm.endpointId)) {
      throw new Error(`ledger: group "${grp.id}" member endpointId must be hex (${JSON.stringify(mm.endpointId)})`);
    }
    if (typeof mm.deviceName !== "string" || mm.deviceName === "" || mm.deviceName.length > 64) {
      throw new Error(`ledger: group "${grp.id}" member deviceName invalid`);
    }
    if (seen.has(mm.endpointId)) throw new Error(`ledger: group "${grp.id}" duplicate member ${mm.endpointId}`);
    seen.add(mm.endpointId);
    return { endpointId: mm.endpointId, deviceName: mm.deviceName };
  });
  if (!Array.isArray(grp.roots) || grp.roots.length === 0) throw new Error(`ledger: group "${grp.id}" roots must be a non-empty array`);
  const rootIds = new Set();
  const roots = grp.roots.map((r) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new Error(`ledger: group "${grp.id}" root must be an object`);
    const rr = /** @type {Record<string, unknown>} */ (r);
    if (typeof rr.id !== "string" || !ID_RE.test(rr.id)) throw new Error(`ledger: group "${grp.id}" root id invalid`);
    if (rootIds.has(rr.id)) throw new Error(`ledger: group "${grp.id}" duplicate root id ${rr.id}`);
    rootIds.add(rr.id);
    if (typeof rr.localPath !== "string" || !path.isAbsolute(rr.localPath)) {
      throw new Error(`ledger: group "${grp.id}" root "${rr.id}" localPath must be absolute`);
    }
    const mode = rr.mode ?? "twoway";
    if (!ROOT_MODES.has(/** @type {string} */ (mode))) throw new Error(`ledger: group "${grp.id}" root "${rr.id}" mode must be oneway|twoway`);
    if (rr.seedAuthority !== null && rr.seedAuthority !== undefined && (typeof rr.seedAuthority !== "string" || !seen.has(rr.seedAuthority))) {
      throw new Error(`ledger: group "${grp.id}" root "${rr.id}" seedAuthority must be a member endpoint or null`);
    }
    return { id: rr.id, localPath: rr.localPath, mode: /** @type {"oneway" | "twoway"} */ (mode), seedAuthority: (rr.seedAuthority ?? null) };
  });
  return { id: grp.id, name: grp.name, members, roots };
}

/** @param {string} home */
function groupsPath(home) {
  return path.join(syncDataDir(home), GROUPS_FILE);
}

/**
 * 读组账本（无文件=空账本；损坏=抛错 fail-closed）。
 * @param {string} home
 * @returns {Promise<ReturnType<typeof emptyLedger>>}
 */
export async function loadLedger(home) {
  let text;
  try {
    text = await readFile(groupsPath(home), "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return emptyLedger();
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`sync groups ledger is malformed (${groupsPath(home)})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.groups)) {
    throw new Error(`sync groups ledger has an invalid shape (${groupsPath(home)})`);
  }
  return { version: 1, groups: parsed.groups.map(assertGroupValid) };
}

/**
 * 锁内变更组账本（acquireFileLock → 锁内重读 → fn → 0600 原子写）。
 * @param {string} home
 * @param {(ledger: ReturnType<typeof emptyLedger>) => void | Promise<void>} fn
 * @param {{ now?: () => number }} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, code: "lock" }>}
 */
export async function mutateLedger(home, fn, ctx = {}) {
  const lock = await acquireFileLock(groupsPath(home), ctx);
  if (!lock.ok) return lock;
  try {
    const ledger = await loadLedger(home);
    await fn(ledger);
    await atomicWrite0600(groupsPath(home), `${JSON.stringify(ledger, null, 2)}\n`);
    return { ok: true };
  } finally {
    await lock.release();
  }
}

/**
 * 建组（本地账本；两端各建、成员一致）。幂等：同 id 同形状=成功返回，同 id
 * 不同形状=拒绝。
 * @param {string} home
 * @param {{ id?: string, name: string, members: Array<{ endpointId: string, deviceName: string }>, roots: Array<{ id?: string, localPath: string, mode?: "oneway" | "twoway", seedAuthority?: string | null }> }} input
 * @param {{ now?: () => number, randomBytes?: number }} [ctx]
 * @returns {Promise<{ ok: true, group: SyncGroup } | { ok: false, code: "conflict" | "invalid" | "lock", error?: string }>}
 */
export async function createGroup(home, input, ctx = {}) {
  const { randomId } = await import("./util.mjs");
  let group;
  try {
    const id = input.id ?? `g-${randomId(4)}`;
    const members = [...input.members];
    const roots = input.roots.map((r, i) => ({ ...r, id: r.id ?? `r${i + 1}` }));
    group = await (async () => assertGroupValid({ id, name: input.name, members, roots }))();
  } catch (e) {
    return { ok: false, code: "invalid", error: /** @type {Error} */ (e).message };
  }
  let m;
  try {
    m = await mutateLedger(home, (ledger) => {
      const existing = ledger.groups.find((g) => g.id === group.id);
      if (existing !== undefined) {
        if (JSON.stringify(existing) === JSON.stringify(group)) return; // 幂等重放
        throw new Error(`__conflict__: group id "${group.id}" already exists with a different shape`);
      }
      ledger.groups.push(group);
    }, ctx);
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message ?? e);
    if (msg.includes("__conflict__")) return { ok: false, code: "conflict", error: msg.replace("__conflict__: ", "") };
    throw e;
  }
  if (!m.ok) return m;
  // 数据目录惰性创建（git/intent/conflicts 布局由使用方按需建）
  for (const root of group.roots) {
    await mkdir(repoDir(home, group.id, root.id), { recursive: true, mode: 0o700 }).catch(() => {});
  }
  return { ok: true, group };
}

/**
 * 删除组（账本摘除；gitdir 留守由调用方决定是否物理删除——删除操作需 UI 确认
 * 的纪律在宿主接线层）。
 * @param {string} home
 * @param {string} groupId
 * @param {{ now?: () => number }} [ctx]
 */
export async function deleteGroup(home, groupId, ctx = {}) {
  const r = await mutateLedger(home, (ledger) => {
    ledger.groups = ledger.groups.filter((g) => g.id !== groupId);
  }, ctx);
  return r;
}

/**
 * 查组（端点授权与引擎路由共用）。
 * @param {ReturnType<typeof emptyLedger>} ledger
 * @param {string} groupId
 */
export function findGroup(ledger, groupId) {
  return ledger.groups.find((g) => g.id === groupId) ?? null;
}

/**
 * @typedef {Object} SyncMember
 * @property {string} endpointId
 * @property {string} deviceName
 *
 * @typedef {Object} SyncRoot
 * @property {string} id
 * @property {string} localPath
 * @property {"oneway" | "twoway"} mode
 * @property {string | null} seedAuthority
 *
 * @typedef {Object} SyncGroup
 * @property {string} id
 * @property {string} name
 * @property {SyncMember[]} members
 * @property {SyncRoot[]} roots
 */
