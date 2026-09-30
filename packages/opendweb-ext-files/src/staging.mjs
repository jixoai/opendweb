// 上传 staging（webui-plugin-kernel Phase 2 / design v2.3 §6 幂等续传冻结）。
// 意图（2026-09-29）：
// 1. 布局：`<home>/plugins/files/staging/<uploadId>/`（0700 家族）：
//    `meta.json`（{path, created, lastTouch}——首个 chunk 绑定目标路径，此后
//    每 chunk/commit 校验一致）+ 分片文件 `<seq>-<offset>.bin`（tmp+rename
//    原子落盘）。
// 2. 幂等键=(uploadId, seq, offset)；内容判据=chunkHash（sha256）：
//    同键同内容=幂等成功；同键异内容=明确拒绝不覆盖（不重写既有分片）；
//    声明 hash 与 bytes 重算不符=拒绝（伪造 chunkHash）。
// 3. TTL 回收：目录 mtime 为 lastTouch（每 chunk/commit touch）；sweep 清除
//    now-lastTouch>ttl 的整个 uploadId 目录（默认 15min 可配）。取消/断线/
//    commit 成功后整体删除——正式命名空间永无半文件（commit 前 staging 与
//    正式目录互不相交）。
// 4. uploadId 字符集白名单（[A-Za-z0-9._-]{1,64}，且不得以 . 开头）——路径
//    拼接前的逃逸防线。

import path from "node:path";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { atomicWrite0600 } from "./fslock.mjs";

/** staging 目录名（<DWEB_HOME>/plugins/files/staging/） */
export const STAGING_DIR = "staging";
/** 默认 TTL（15min；design §6「staging 带 TTL 回收」默认值） */
export const DEFAULT_STAGING_TTL_MS = 15 * 60 * 1000;
/** 单 chunk 上限（1MiB；design §4 [W7] files 分片默认——r8-B4 收窄：v1 有效
 * 包络=min(插件预算, transport 实况)=1MiB 帧（fabric session MAX_FRAME），真双机
 * 实证仅 1MiB chunk 稳定通过；运行时对超过此上限的 chunkMaxBytes 配置拒绝） */
export const DEFAULT_CHUNK_MAX_BYTES = 1024 * 1024;

/** uploadId 白名单 */
const UPLOAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * @param {string} uploadId
 * @returns {boolean}
 */
export function isValidUploadId(uploadId) {
  return UPLOAD_ID_RE.test(uploadId);
}

/**
 * sha256 hex（Uint8Array）。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * staging 管理器（一个 home 一个实例）。
 * @param {{ home: string, ttlMs?: number, now?: () => number }} opts
 */
export function createStaging(opts) {
  const { home } = opts;
  const ttlMs = opts.ttlMs ?? DEFAULT_STAGING_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const root = path.join(home, "plugins/files", STAGING_DIR);

  /** @param {string} uploadId */
  const uploadDir = (uploadId) => path.join(root, uploadId);
  /** @param {number} seq @param {number} offset */
  const chunkFile = (uploadId, seq, offset) => path.join(uploadDir(uploadId), `${seq}-${offset}.bin`);
  /** @param {string} uploadId */
  const metaFile = (uploadId) => path.join(uploadDir(uploadId), "meta.json");

  /**
   * 读 upload 的目标路径绑定（无 staging=null）。
   * @param {string} uploadId
   * @returns {Promise<{ path: string, created: number, lastTouch: number } | null>}
   */
  async function readMeta(uploadId) {
    try {
      const parsed = JSON.parse(await fsp.readFile(metaFile(uploadId), "utf8"));
      if (parsed !== null && typeof parsed === "object" && typeof parsed.path === "string") {
        const m = /** @type {Record<string, unknown>} */ (parsed);
        return {
          path: m.path,
          created: typeof m.created === "number" ? m.created : 0,
          lastTouch: typeof m.lastTouch === "number" ? m.lastTouch : 0,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * touch（目录 mtime=lastTouch）。
   * @param {string} uploadId
   */
  async function touch(uploadId) {
    const t = new Date(now());
    await fsp.utimes(uploadDir(uploadId), t, t).catch(() => {});
  }

  /**
   * 写入一个分片（幂等/冲突/伪造判定在此）。
   * @param {{ uploadId: string, seq: number, offset: number, bytes: Uint8Array, declaredHash: string, path: string }} input
   * @returns {Promise<{ ok: true, idempotent: boolean, received: number } | { ok: false, code: "FORGED_HASH" | "CHUNK_CONFLICT" | "PATH_MISMATCH" | "TOO_LARGE" | "BAD_INPUT" , message: string }>}
   */
  async function putChunk(input) {
    const { uploadId, seq, offset, bytes, declaredHash } = input;
    if (!isValidUploadId(uploadId)) return { ok: false, code: "BAD_INPUT", message: "invalid uploadId" };
    if (!Number.isInteger(seq) || seq < 0 || seq > 1_000_000) return { ok: false, code: "BAD_INPUT", message: "invalid seq" };
    if (!Number.isInteger(offset) || offset < 0) return { ok: false, code: "BAD_INPUT", message: "invalid offset" };
    if (typeof declaredHash !== "string" || !/^[0-9a-f]{64}$/.test(declaredHash)) {
      return { ok: false, code: "BAD_INPUT", message: "chunkHash must be sha256 hex" };
    }
    const recomputed = sha256Hex(bytes);
    if (recomputed !== declaredHash) {
      return { ok: false, code: "FORGED_HASH", message: "chunkHash does not match the received bytes (recomputed sha256 differs)" };
    }
    // 目标路径绑定（首 chunk 建立；此后一致）
    const existingMeta = await readMeta(uploadId);
    if (existingMeta !== null && existingMeta.path !== input.path) {
      return { ok: false, code: "PATH_MISMATCH", message: `uploadId is already bound to a different destination path (${existingMeta.path})` };
    }
    // 幂等/冲突：同键已有分片
    const file = chunkFile(uploadId, seq, offset);
    const existing = await fsp.readFile(file).catch(() => null);
    if (existing !== null) {
      const existingHash = sha256Hex(existing);
      if (existingHash === recomputed) {
        await touch(uploadId);
        return { ok: true, idempotent: true, received: existing.length };
      }
      return { ok: false, code: "CHUNK_CONFLICT", message: `chunk (seq=${seq}, offset=${offset}) already staged with different content; not overwritten` };
    }
    if (existingMeta === null) {
      await fsp.mkdir(uploadDir(uploadId), { recursive: true, mode: 0o700 });
      const t = now();
      await atomicWrite0600(metaFile(uploadId), `${JSON.stringify({ path: input.path, created: t, lastTouch: t }, null, 2)}\n`);
    }
    // 原子写分片（同目录 tmp+rename——staging 内部一致性；崩溃不留半个分片名）
    const tmp = path.join(uploadDir(uploadId), `.${seq}-${offset}.${process.pid}.tmp`);
    try {
      const fh = await fsp.open(tmp, "wx");
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, file);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "EEXIST") {
        // 并发同键写者先到——按既有内容判定幂等/冲突
        const winner = await fsp.readFile(file);
        if (sha256Hex(winner) === recomputed) {
          await touch(uploadId);
          return { ok: true, idempotent: true, received: winner.length };
        }
        return { ok: false, code: "CHUNK_CONFLICT", message: `chunk (seq=${seq}, offset=${offset}) already staged with different content; not overwritten` };
      }
      throw e;
    }
    await touch(uploadId);
    return { ok: true, idempotent: false, received: bytes.length };
  }

  /**
   * 列出某 upload 的全部分片（按 offset 排序）。
   * @param {string} uploadId
   * @returns {Promise<Array<{ seq: number, offset: number, size: number, file: string }>>}
   */
  async function listChunks(uploadId) {
    let names;
    try {
      names = await fsp.readdir(uploadDir(uploadId));
    } catch {
      return [];
    }
    /** @type {Array<{ seq: number, offset: number, size: number, file: string }>} */
    const out = [];
    for (const name of names) {
      const m = /^(\d+)-(\d+)\.bin$/.exec(name);
      if (m === null) continue;
      const st = await fsp.stat(path.join(uploadDir(uploadId), name)).catch(() => null);
      if (st === null) continue;
      out.push({ seq: Number(m[1]), offset: Number(m[2]), size: st.size, file: path.join(uploadDir(uploadId), name) });
    }
    out.sort((a, b) => a.offset - b.offset || a.seq - b.seq);
    return out;
  }

  /**
   * 删除整个 upload staging（commit 成功/放弃）。
   * @param {string} uploadId
   */
  async function removeUpload(uploadId) {
    if (!isValidUploadId(uploadId)) return;
    await fsp.rm(uploadDir(uploadId), { recursive: true, force: true }).catch(() => {});
  }

  /**
   * TTL 回收（返回被回收的 uploadId 列表）。目录 mtime=lastTouch。
   * @param {{ nowMs?: number }} [o]
   * @returns {Promise<string[]>}
   */
  async function sweep(o = {}) {
    const at = o.nowMs ?? now();
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    /** @type {string[]} */
    const removed = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const st = await fsp.stat(path.join(root, ent.name)).catch(() => null);
      if (st === null) continue;
      if (at - st.mtimeMs > ttlMs) {
        await fsp.rm(path.join(root, ent.name), { recursive: true, force: true }).catch(() => {});
        removed.push(ent.name);
      }
    }
    return removed;
  }

  return {
    root,
    ttlMs,
    putChunk,
    listChunks,
    readMeta,
    removeUpload,
    sweep,
    uploadDir,
    chunkFile,
  };
}

/**
 * @typedef {ReturnType<typeof createStaging>} Staging
 */
