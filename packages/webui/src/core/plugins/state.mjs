// 插件运行账本（webui-plugin-kernel Phase 0 / design §2.3 [P6] 双账本）。
// 意图（2026-09-29）：
// 1. 运行账本 `<DWEB_HOME>/plugins/state.json`（启停/配置；version 1）——
//    0600 原子写（O_EXCL tmp + chmod 0600 + fsync + rename，symlink 拒绝）
//    + 跨进程锁 `<DWEB_HOME>/plugins/state.lock`（acquireFileLock 家族——
//    与 leases/visits 同协议，经 workspace 依赖复用 opendweb/src/leases.mjs）。
// 2. 每插件数据目录 `<DWEB_HOME>/plugins/<id>/`（0700）惰性创建——构造/注册
//    不建目录，首次启用（或运行时首次落盘）时创建（ensurePluginDataDir）。
// 3. 安装账本 `~/.opendweb/plugins.json`（CLI 包锁）零接触：本模块不读不写
//    该文件——两账本不混用（spec「安装与运行双账本分离」）。
// 4. 损坏 fail-closed：state.json 存在但非法 JSON/形状 → 抛错（调用方拒启，
//    不静默重置——与 NodeStore 同纪律）。

import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { acquireFileLock, atomicWrite0600 } from "opendweb/src/leases.mjs";

/** 插件根目录名（<DWEB_HOME>/plugins/） */
export const PLUGINS_DIR = "plugins";
/** 运行账本文件名（<DWEB_HOME>/plugins/state.json） */
export const STATE_FILE = "state.json";
/** 运行账本锁文件名 */
export const STATE_LOCK = "state.lock";

/** 插件 id 字符集（与契约一致——路径拼接前的逃逸防线） */
const ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * @returns {{ version: 1, plugins: Record<string, { status: "enabled" | "disabled", config?: Record<string, string | number | boolean> }> }}
 */
export function emptyPluginState() {
  return { version: 1, plugins: {} };
}

/** @param {string} home */
export function pluginStatePath(home) {
  return path.join(home, PLUGINS_DIR, STATE_FILE);
}

/**
 * 读运行账本（无文件=空账本；损坏=抛错 fail-closed）。
 * @param {string} home DWEB_HOME 绝对路径
 * @returns {Promise<ReturnType<typeof emptyPluginState>>}
 */
export async function loadPluginState(home) {
  const file = pluginStatePath(home);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return emptyPluginState();
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`plugin runtime state is malformed (${file})`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.plugins !== "object" ||
    parsed.plugins === null ||
    Array.isArray(parsed.plugins)
  ) {
    throw new Error(`plugin runtime state has an invalid shape (${file})`);
  }
  return { version: 1, plugins: parsed.plugins };
}

/**
 * 锁内变更运行账本：acquireFileLock → 锁内重读 → fn(state) → 0600 原子写 →
 * 锁归属校验释放（setLeaseLabel 同协议）。
 * @param {string} home
 * @param {(state: ReturnType<typeof emptyPluginState>) => void | Promise<void>} fn 就地变更（重读后的最新状态）
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, code: "lock" }>}
 */
export async function mutatePluginState(home, fn, ctx = {}) {
  const lock = await acquireFileLock(path.join(home, PLUGINS_DIR, STATE_LOCK), ctx);
  if (!lock.ok) return { ok: false, code: "lock" };
  try {
    const state = await loadPluginState(home); // 锁内重读
    await fn(state);
    await atomicWrite0600(pluginStatePath(home), `${JSON.stringify(state, null, 2)}\n`);
    return { ok: true };
  } finally {
    await lock.release();
  }
}

/**
 * 插件数据目录 `<DWEB_HOME>/plugins/<id>/`（0700）惰性创建。id 先过契约字符集
 * （路径逃逸防线）；已存在即幂等。
 * @param {string} home
 * @param {string} id
 * @returns {Promise<string>} 目录绝对路径
 */
export async function ensurePluginDataDir(home, id) {
  if (!ID_RE.test(id)) throw new Error(`plugin id must match ${ID_RE} (got ${JSON.stringify(id)})`);
  const dir = path.join(home, PLUGINS_DIR, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
