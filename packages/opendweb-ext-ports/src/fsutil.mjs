// 落盘纪律工具（webui-plugin-kernel Phase 1 ports / design §2.3、§8「落盘」行）。
// 意图（2026-09-29）：
// 1. 本包零运行时外部依赖——0600 原子写与跨进程文件锁在本包内自持实现，
//    协议与 opendweb/src/leases.mjs（leases/visits/state 同族）逐字同拍：
//    O_EXCL tmp + chmod 0600 + fsync + rename（同一持久文件系统内）+ symlink
//    拒绝 + 失败清理 tmp；锁=O_EXCL `<name>.lock`（pid+ts JSON）+ 陈锁 >10s
//    且 pid 死可打破 + 活占用短退避 ≤3 后报错 + 释放时锁归属校验（内容比对）。
//    （leases.mjs 头注释明示「两模块互不依赖」是既有先例——本包同拍第三份。）
// 2. 账本损坏 fail-closed 由 ledger.mjs 承担；本模块只提供原子性与锁原语。

import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";

/** 陈锁判定：>10s 且 pid 死可打破（leases.mjs STALE_LOCK_MS 同拍） */
export const STALE_LOCK_MS = 10_000;
/** 锁获取失败短退避 ≤3 后报错（同拍） */
const LOCK_RETRIES = 3;
/** 退避间隔（ms；25/50/100——同拍） */
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

/**
 * 0600 原子写（O_EXCL tmp + chmod 0600 + fsync + rename；符号链接拒绝；失败清理
 * tmp——同文件系统内临时文件+rename，跨文件系统 rename 不具原子性的既有教训）。
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

/**
 * 获取文件锁（O_EXCL 创建 `<lockFile>`，内容 pid+ts JSON；占用者 >10s 且 pid
 * 死=打破重建；活占用短退避 ≤3 后报错；释放经锁归属校验——不动他人的锁）。
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
    // 占用方裁决：读 pid+ts；>10s 且 pid 死 → 打破重建（无退避立即重试）
    const readHolder = await readLockHolder(lockFile);
    const pid = readHolder.pid;
    const ageMs = now() - readHolder.ts;
    if (pid !== null && ageMs > STALE_LOCK_MS && !isPidAlive(pid)) {
      await rm(lockFile, { force: true });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_BACKOFF_MS[Math.min(attempt, LOCK_BACKOFF_MS.length - 1)] ?? 100));
  }
}
