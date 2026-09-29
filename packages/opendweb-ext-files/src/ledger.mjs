// 共享账本 shares.json（webui-plugin-kernel Phase 2 / design v2.3 §6）。
// 意图（2026-09-29）：
// 1. `<DWEB_HOME>/plugins/files/shares.json`（version 1）：{id,name,root 绝对
//    路径,mode: ro|rw,peers[](endpointId),created}；**默认 ro**；root 变更走
//    账本（重建 share——root 的冻结 fd 由 runtime 管理，账本只存路径）。
// 2. 0600 原子写 + 跨进程锁（fslock.mjs 家族：锁内重读→改→原子写→锁归属
//    校验释放——与运行账本 state.json 同协议）。
// 3. 损坏 fail-closed：存在但非法 JSON/形状 → 抛错（不静默重置）。
// 4. 校验：root 必须绝对路径且存在且为目录（创建时校验一次；运行期由
//    runtime 的 fd 冻结+身份复核兜底）；peers 为 endpointId 数组（去重）；
//    mode 缺省 "ro"。

import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { acquireFileLock, atomicWrite0600 } from "./fslock.mjs";

/** 插件数据目录名（<DWEB_HOME>/plugins/files/） */
export const FILES_DIR = "plugins/files";
/** 账本文件名 */
export const SHARES_FILE = "shares.json";
/** 账本锁文件名 */
export const SHARES_LOCK = "shares.lock";

/** share id 字符集（crockford 小写 10 字符——leases id 家族） */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * @param {() => Uint8Array} [random]
 * @returns {string}
 */
export function randomShareId(random = () => globalThis.crypto.getRandomValues(new Uint8Array(10))) {
  return Array.from(random(), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

/**
 * 共享条目。
 * @typedef {Object} ShareEntry
 * @property {string} id
 * @property {string} name 展示名（非空，≤64）
 * @property {string} root 绝对路径
 * @property {"ro" | "rw"} mode
 * @property {string[]} peers 授权 endpointId 集
 * @property {number} created
 */

/**
 * @returns {{ version: 1, shares: ShareEntry[] }}
 */
export function emptyShares() {
  return { version: 1, shares: [] };
}

/** @param {string} home */
export function sharesPath(home) {
  return path.join(home, FILES_DIR, SHARES_FILE);
}

/**
 * 读账本（无文件=空账本；损坏=抛错 fail-closed）。
 * @param {string} home
 * @returns {Promise<{ version: 1, shares: ShareEntry[] }>}
 */
export async function loadShares(home) {
  const file = sharesPath(home);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return emptyShares();
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`files shares ledger is malformed (${file})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.shares)) {
    throw new Error(`files shares ledger has an invalid shape (${file})`);
  }
  return { version: 1, shares: parsed.shares };
}

/**
 * 锁内变更账本（获取→锁内重读→fn→0600 原子写→锁归属校验释放）。
 * @param {string} home
 * @param {(ledger: { version: 1, shares: ShareEntry[] }) => void | Promise<void> | T | Promise<T>} fn
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @template T
 * @returns {Promise<{ ok: true, ledger: { version: 1, shares: ShareEntry[] } } | { ok: false, code: "lock" }>}
 */
export async function mutateShares(home, fn, ctx = {}) {
  const lock = await acquireFileLock(path.join(home, FILES_DIR, SHARES_LOCK), ctx);
  if (!lock.ok) return { ok: false, code: "lock" };
  try {
    const ledger = await loadShares(home); // 锁内重读
    await fn(ledger);
    await atomicWrite0600(sharesPath(home), `${JSON.stringify(ledger, null, 2)}\n`);
    return { ok: true, ledger };
  } finally {
    await lock.release();
  }
}

/** 输入校验错误（控制面/账本写入方 fail-fast 用） */
export class ShareValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ShareValidationError";
  }
}

/**
 * 校验共享输入（name/root/mode/peers）。root 必须是存在的真实目录（非
 * symlink 终组件——与 root fd 冻结纪律一致）。
 * @param {{ name: unknown, root: unknown, mode: unknown, peers: unknown }} input
 * @returns {Promise<{ name: string, root: string, mode: "ro" | "rw", peers: string[] }>}
 * @throws {ShareValidationError}
 */
export async function validateShareInput(input) {
  if (input === null || typeof input !== "object") throw new ShareValidationError("share input must be an object");
  const { name, root, mode, peers } = /** @type {Record<string, unknown>} */ (input);
  if (typeof name !== "string" || name === "" || name.length > 64) {
    throw new ShareValidationError("share name must be a non-empty string (<=64 chars)");
  }
  if (typeof root !== "string" || root === "" || !path.isAbsolute(root)) {
    throw new ShareValidationError("share root must be an absolute path");
  }
  if (root.includes("\0")) throw new ShareValidationError("share root contains NUL");
  if (mode !== undefined && mode !== null && mode !== "ro" && mode !== "rw") {
    throw new ShareValidationError('share mode must be "ro" or "rw"');
  }
  if (peers !== undefined && peers !== null && (!Array.isArray(peers) || peers.some((p) => typeof p !== "string" || p === "" || p.length > 128))) {
    throw new ShareValidationError("share peers must be an array of endpoint ids");
  }
  // root 存在性+类型+终组件非 symlink（创建时一次；运行期 fd 冻结兜底）
  const st = await lstat(root).catch(() => null);
  if (st === null) throw new ShareValidationError(`share root does not exist: ${root}`);
  if (st.isSymbolicLink()) throw new ShareValidationError("share root must not be a symbolic link (the final path component)");
  if (!st.isDirectory()) throw new ShareValidationError("share root must be a directory");
  return {
    name,
    root,
    mode: mode === "rw" ? "rw" : "ro", // 默认 ro（design §6）
    peers: [...new Set(/** @type {string[]} */ (peers ?? []))],
  };
}
