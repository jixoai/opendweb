// sync 插件基础工具（webui-plugin-kernel Phase 3 / design v2.3 §7）。
// 意图（2026-09-29）：
// 1. 本包自持（仅 isomorphic-git + node-diff3 依赖，包内 npm install——不动根
//    pnpm）；原子写/跨进程锁/互斥等纪律从 opendweb/src/leases.mjs 家族**复制
//    纪律而非依赖**（跨包 workspace 依赖会牵动根 pnpm-lock，违反本 change 的
//    文件面约束）。实现与 leases.mjs atomicWrite0600 同协议：O_EXCL tmp +
//    chmod 0600 + fsync + rename（同一持久文件系统内）+ symlink 拒绝。
// 2. 传输完整性纪律（design §4）：EOF 不是证据——一切对象带类型+长度+OID，
//    落盘前由调用方校验（objects.mjs）。
// 3. 无轮询：调度器的 timer 全部注入式（scheduler.mjs），本模块只提供纯函数
//    与 IO 原语。

import { mkdir, open, rename, rm, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** 陈锁判定窗口（与 leases.mjs STALE_LOCK_MS 同拍） */
export const STALE_LOCK_MS = 10_000;

/**
 * 0600 原子写（O_EXCL tmp + chmod 0600 + fsync + rename；symlink 拒绝；
 * 失败清理 tmp）。design §2.2/§8 落盘纪律。
 * @param {string} file 目标绝对路径
 * @param {string | Uint8Array} data
 */
export async function atomicWrite0600(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  try {
    // symlink 拒绝：目标已存在且是 symlink → 拒绝（绝不跟随写入）
    try {
      const st = await lstat(file);
      if (st.isSymbolicLink()) throw new Error(`atomicWrite0600: refusing to write through symlink ${file}`);
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code !== "ENOENT") throw e; // 非「不存在」的探测失败一律上抛
    }
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 有界跨进程文件锁（O_EXCL 创建 `<file>.lock`；内容 pid+ts；陈锁 >10s 且 pid
 * 死可打破；获取失败短退避 ≤3 后报错）。与 leases.mjs acquireFileLock 同协议。
 * @param {string} file 被锁资源路径（锁文件 = `${file}.lock`）
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true, release: () => Promise<void> } | { ok: false, code: "lock" }>}
 */
export async function acquireFileLock(file, ctx = {}) {
  const now = ctx.now ?? (() => Date.now());
  const isPidAlive =
    ctx.isPidAlive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
      }
    });
  const lockFile = `${file}.lock`;
  await mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const backoff = [25, 50, 100];
  for (let attempt = 0; ; attempt++) {
    const payload = { pid: process.pid, ts: now() };
    try {
      const fh = await open(lockFile, "wx", 0o600);
      try {
        await fh.writeFile(`${JSON.stringify(payload)}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
      const release = async () => {
        // 归属校验后释放（同 leases.mjs：内容比对，防误释放他人锁）
        try {
          const cur = await readFile(lockFile, "utf8");
          if (cur.trim() === JSON.stringify(payload)) await rm(lockFile, { force: true });
        } catch {
          /* 锁文件已被打破/移除——无事可做 */
        }
      };
      return { ok: true, release };
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
      // 陈锁判定
      try {
        const raw = await readFile(lockFile, "utf8");
        const rec = JSON.parse(raw);
        const stale = now() - (rec.ts ?? 0) > STALE_LOCK_MS && isPidAlive(rec.pid ?? -1) === false;
        if (stale) {
          await rm(lockFile, { force: true });
          continue; // 立即重试本轮（不计退避）
        }
      } catch {
        /* 读失败/解析失败——退避后重试 */
      }
      if (attempt >= backoff.length) return { ok: false, code: "lock" };
      await new Promise((r) => setTimeout(r, backoff[attempt]));
    }
  }
}

/**
 * 进程内互斥（每 repo 单写者——design §7.3「单写者」+ §2.2 dispose 串行）。
 * @returns {{ run: <T>(label: string, fn: () => Promise<T>) => Promise<T>, depth: () => number }}
 */
export function createMutex() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  let depth = 0;
  return {
    depth: () => depth,
    run(label, fn) {
      const next = tail.then(async () => {
        depth += 1;
        try {
          return await fn();
        } finally {
          depth -= 1;
        }
      });
      tail = next.catch(() => {}); // 链不因单次失败断裂（后续排队者可继续）
      return /** @type {Promise<any>} */ (next);
    },
  };
}

/**
 * 随机不透明 id（CSPRNG hex）。
 * @param {number} [bytes]
 */
export function randomId(bytes = 8) {
  return crypto.getRandomValues(new Uint8Array(bytes)).reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");
}

/** @param {Uint8Array} b */
export function toBase64(b) {
  return Buffer.from(b).toString("base64");
}

/** @param {string} s */
export function fromBase64(s) {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/**
 * 严格 UTF-8 解码（fatal——非 UTF-8 blob 判文件级冲突用，design §7.4）。
 * @param {Uint8Array} bytes
 * @returns {string | null} 解码失败返回 null
 */
export function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 读有界请求体（design §4：未知 Content-Length 的入站请求 MUST 边读边累计、
 * 达到上限立即断开拒绝——不得先缓冲后判）。
 * @param {Uint8Array | AsyncIterable<Uint8Array> | null | undefined} body
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array>}
 * @throws {{ code: "body-too-large", maxBytes: number }} 超限（立即停止消费）
 */
export async function readBoundedBody(body, maxBytes) {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw { code: "body-too-large", maxBytes };
    return body;
  }
  /** @type {Buffer[]} */
  const parts = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      parts.length = 0;
      throw { code: "body-too-large", maxBytes };
    }
    parts.push(Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * 逐行读有界请求体（ndjson 帧：每行一个 JSON 对象；行级+总长双上限——push 的
 * 边读边拒基础）。总上限由 readBoundedBody 强制（内存有界），行超限/解析失败
 * 立即抛。
 * @param {Uint8Array | AsyncIterable<Uint8Array> | null | undefined} body
 * @param {{ maxTotal: number, maxLine?: number }} limits
 * @returns {AsyncGenerator<unknown>}
 */
export async function* readBoundedJsonLines(body, limits) {
  const maxLine = limits.maxLine ?? 64 * 1024 * 1024;
  const all = Buffer.from(await readBoundedBody(body, limits.maxTotal));
  let start = 0;
  while (true) {
    const idx = all.indexOf(0x0a, start);
    if (idx === -1) break;
    const line = all.subarray(start, idx);
    start = idx + 1;
    if (line.length > maxLine) throw { code: "line-too-large", maxLine };
    const text = line.toString("utf8").trim();
    if (text !== "") yield JSON.parse(text);
  }
  const rest = all.subarray(start).toString("utf8").trim();
  if (rest !== "") {
    if (rest.length > maxLine) throw { code: "line-too-large", maxLine };
    yield JSON.parse(rest);
  }
}

/** JSON 响应体编码（端点出站统一）。 @param {unknown} v */
export function jsonBody(v) {
  return new Uint8Array(Buffer.from(`${JSON.stringify(v)}\n`, "utf8"));
}

/**
 * 目录存在且非空（seed 非空阻断的粗判；细判用 worktree 扫描对照基线）。
 * @param {string} dir
 */
export async function dirHasEntries(dir) {
  try {
    const names = await readdir(dir);
    return names.length > 0;
  } catch {
    return false;
  }
}

/**
 * 崩溃注入异常（测试四边界用：kill 模拟=向 executeIntent 传 crashAt 钩子后由
 * 恢复入口 recoverIntent 收敛——不真的 kill 进程）。
 */
export class CrashInjection extends Error {
  /**
   * @param {string} stage
   */
  constructor(stage) {
    super(`simulated crash at ${stage}`);
    this.stage = stage;
  }
}
