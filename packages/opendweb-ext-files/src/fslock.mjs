// 0600 原子写 + 跨进程文件锁（opendweb leases.mjs 家族的本包内复刻）。
// 意图（2026-09-29）：
// 1. 本包零依赖（不 workspace-import opendweb——避免动 pnpm-lock/共享包），
//    故按同协议复刻：atomicWrite0600（O_EXCL tmp + chmod 0600 + fsync +
//    rename；symlink 拒绝；失败清理 tmp）与 acquireFileLock（O_EXCL +
//    pid+ts；陈锁 >10s 且 pid 死可打破；获取失败短退避 ≤3 后报错；释放前
//    锁归属校验）。与 opendweb/src/leases.mjs、webui state.mjs 同纪律——
//    三处互不依赖（leases.mjs 原注释同款约定）。
// 2. 语义差异点：无（刻意逐字段同拍——stale 窗口、退避表、token 形状一致，
//    便于跨模块审计对照）。

import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";

/** 陈锁判定：>10s 且 pid 死可打破（与 leases.mjs/hub.lock 同拍） */
export const STALE_LOCK_MS = 10_000;
/** 锁获取失败短退避 ≤3 后报错 */
const LOCK_RETRIES = 3;
/** 退避间隔（ms；25/50/100） */
const LOCK_BACKOFF_MS = [25, 50, 100];

/** @param {number} pid @returns {boolean} */
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 0600 原子写（O_EXCL tmp + chmod 0600 + fsync + rename；符号链接拒绝；
 * 失败清理 tmp）。与 leases.mjs atomicWrite0600 同纪律。
 * @param {string} file 目标绝对路径
 * @param {string} data 写入内容
 */
export async function atomicWrite0600(file, data) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(file).catch(() => null);
  if (st !== null && st.isSymbolicLink()) {
    throw new Error(`refusing to write through a symbolic link: ${file}`);
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      try {
        await fh.chmod(0o600);
      } catch {
        /* Windows best effort */
      }
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`cannot write ${file}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * 获取文件锁（O_EXCL 创建 `<lockFile>`，内容 pid+ts JSON；占用者 >10s 且
 * pid 死=打破重建；活占用短退避 ≤3 后报错）。
 * @param {string} lockFile 锁文件绝对路径
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true, holderPid: number, token: string, release: () => Promise<boolean> } | { ok: false, holderPid: number | null, ageMs: number }>}
 */
export async function acquireFileLock(lockFile, ctx = {}) {
  const { now = Date.now, isPidAlive = defaultIsPidAlive } = ctx;
  await mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  /** @param {string} content @returns {Promise<boolean>} */
  const tryCreate = async (content) => {
    try {
      const fh = await open(lockFile, "wx");
      try {
        try {
          await fh.chmod(0o600);
        } catch {
          /* Windows best effort */
        }
        await fh.writeFile(content);
      } finally {
        await fh.close();
      }
      return true;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") return false;
      throw e;
    }
  };
  for (let attempt = 0; ; attempt++) {
    const token = `${JSON.stringify({ pid: process.pid, ts: now() })}\n`;
    if (await tryCreate(token)) {
      return {
        ok: true,
        holderPid: process.pid,
        token,
        /** 锁归属校验（内容比对）后释放；不属本进程=不动他人的锁 */
        release: async () => {
          try {
            const current = await readFile(lockFile, "utf8");
            if (current !== token) return false;
            await rm(lockFile, { force: true });
            return true;
          } catch {
            return false;
          }
        },
      };
    }
    if (attempt >= LOCK_RETRIES) {
      const exhausted = await readLockHolder(lockFile);
      return { ok: false, holderPid: exhausted.pid, ageMs: now() - exhausted.ts };
    }
    const readHolder = await readLockHolder(lockFile);
    const pid = readHolder.pid;
    const ageMs = now() - readHolder.ts;
    if (pid !== null && ageMs > STALE_LOCK_MS && !isPidAlive(pid)) {
      await rm(lockFile, { force: true });
      continue;
    }
    await sleep(LOCK_BACKOFF_MS[Math.min(attempt, LOCK_BACKOFF_MS.length - 1)] ?? 100);
  }
}

/**
 * 读锁持有者（损坏/无内容=不可打破：pid null + ts=now → 视作活占用）。
 * @param {string} lockFile
 * @returns {Promise<{ pid: number | null, ts: number }>}
 */
async function readLockHolder(lockFile) {
  try {
    const holder = JSON.parse(await readFile(lockFile, "utf8"));
    if (holder !== null && typeof holder === "object") {
      const h = /** @type {Record<string, unknown>} */ (holder);
      return {
        pid: typeof h.pid === "number" ? h.pid : null,
        ts: typeof h.ts === "number" ? h.ts : 0,
      };
    }
  } catch {
    /* 无 info/损坏：不可打破 */
  }
  return { pid: null, ts: Number.MAX_SAFE_INTEGER };
}
