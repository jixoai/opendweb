// share 域文件操作（webui-plugin-kernel Phase 2 / design v2.3 §6 wire 面）。
// 意图（2026-09-29）：
// 1. 每操作都以「冻结 root fd + fd 链解析（fdchain.withResolved / 内联同
//    步骤链）」到达目标；本模块只做操作语义（list/stat/read 句柄/mkdir/
//    rename/delete/commit），不做授权/预算/序列化（runtime.mjs 的职责）。
// 2. 保留名：`.opendweb-ignore`（提供侧忽略清单）与 `.opendweb.*`（commit
//    staging 临时名）不进 wire 可见面（list 隐藏；直读 404）——半文件/配置
//    永不进正式命名空间。
// 3. OID=sha256(content)（版本标识/ETag）；按 (dev,ino,mtimeMs,size) 进程内
//    缓存（上限 256 条，满即整清——避免 LRU 复杂度）。
// 4. commit：staging 分片按 offset 全覆盖核对（总长+整文件 hash）→ 目标目录
//    内 `.opendweb.upload.<uploadId>.tmp`（同文件系统）逐片写入+fsync →
//    hash/总长复核 → 单次原子 rename 入正式命名空间 → 清 staging。任何一步
//    失败：temp 必被清除（零半文件），staging 保留待重试（摘要不符）或由
//    TTL 回收（放弃）。
// 5. fd 读写：node:fs 的 readSync/writeSync 直作用 fd（分片 ≤4MiB、缓冲
//    64KiB、每 1-4MiB 让位事件循环一次）——fsp 无按裸 fd 读写面。

import fsSync from "node:fs";
import { constants as FS } from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { WireFsError, mapOpenError, mutators, withResolved, openChild, openChildDir, EXPECT } from "./fdchain.mjs";
import { IGNORE_FILE_NAME, isIgnored, parseIgnoreRules } from "./ignore.mjs";

/** 单 list 条目上限（超过置 truncated:true） */
export const MAX_LIST_ENTRIES = 10_000;
/** OID 缓存条数上限（满即整清） */
const OID_CACHE_MAX = 256;
/** 逐次读缓冲（64KiB） */
const READ_BUF = 64 * 1024;

/**
 * 保留名判定（wire 面不可见/不可达）。
 * @param {string} name
 */
export function isReservedName(name) {
  return name === IGNORE_FILE_NAME || name.startsWith(".opendweb.");
}

/**
 * @typedef {Object} RootRef 冻结的 share root
 * @property {number} rootFd
 * @property {string} rootPath
 * @property {number} rootIno
 * @property {number} rootDev
 */

/** @param {number} fd @param {import("node:fs").Stats} stat */
function oidCacheKey(fd, stat) {
  void fd;
  return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

/**
 * fd 全量读（utf8；上限 maxBytes——超限 IO 拒绝）。
 * @param {number} fd
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readFdAll(fd, maxBytes) {
  /** @type {Buffer[]} */
  const parts = [];
  const buf = Buffer.alloc(READ_BUF);
  let total = 0;
  for (;;) {
    const bytesRead = fsSync.readSync(fd, buf, 0, READ_BUF, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new WireFsError("IO", "file exceeds the read limit");
    parts.push(Buffer.from(buf.subarray(0, bytesRead)));
    if (total % (1024 * 1024) === 0) await new Promise((r) => setImmediate(r));
  }
  return Buffer.concat(parts).toString("utf8");
}

/** OID 缓存 */
const oidCache = new Map();

/**
 * 计算（或取缓存）fd 全内容 sha256。
 * @param {number} fd
 * @param {import("node:fs").Stats} stat
 * @returns {Promise<string>}
 */
export async function oidOfFd(fd, stat) {
  const key = oidCacheKey(fd, stat);
  const hit = oidCache.get(key);
  if (hit !== undefined) return hit;
  const hash = createHash("sha256");
  const buf = Buffer.alloc(READ_BUF);
  let pos = 0;
  for (;;) {
    const bytesRead = fsSync.readSync(fd, buf, 0, READ_BUF, pos);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
    if (pos % (4 * 1024 * 1024) === 0) await new Promise((r) => setImmediate(r));
  }
  const hex = hash.digest("hex");
  if (oidCache.size >= OID_CACHE_MAX) oidCache.clear();
  oidCache.set(key, hex);
  return hex;
}

/**
 * 流式区间读（read 句柄路径：fd 已在握——身份钉定，区间读不再解析路径）。
 * @param {number} fd
 * @param {number} offset
 * @param {number} len
 * @param {(chunk: Buffer) => Promise<void>} sink
 * @returns {Promise<number>} 实际送出的字节数
 */
export async function streamRange(fd, offset, len, sink) {
  const buf = Buffer.alloc(READ_BUF);
  let sent = 0;
  let pos = offset;
  while (sent < len) {
    const want = Math.min(READ_BUF, len - sent);
    const bytesRead = fsSync.readSync(fd, buf, 0, want, pos);
    if (bytesRead === 0) break;
    await sink(Buffer.from(buf.subarray(0, bytesRead)));
    sent += bytesRead;
    pos += bytesRead;
  }
  return sent;
}

/**
 * 断言未被忽略（404 语义：与不存在不可区分——忽略清单不下传）。
 * @param {RootRef} root
 * @param {string[]} comps
 * @param {import("./ignore.mjs").IgnoreRule[]} rules
 * @param {{ isDir?: boolean }} [entry]
 */
function assertNotIgnored(root, comps, rules, entry = {}) {
  void root;
  if (isIgnored(rules, comps, entry)) {
    throw new WireFsError("NOT_FOUND", "not found");
  }
}

/**
 * 读 root 的 .opendweb-ignore 规则（经链纪律；不存在/超限=空规则——忽略文件
 * 损坏时不放大为拒绝服务）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @returns {Promise<import("./ignore.mjs").IgnoreRule[]>}
 */
export async function loadIgnoreRules(cap, root) {
  try {
    return await withResolved(
      cap,
      root,
      [IGNORE_FILE_NAME],
      { flags: FS.O_RDONLY | FS.O_NOFOLLOW, expect: EXPECT.FILE },
      async (t) => parseIgnoreRules(await readFdAll(t.fd, 1024 * 1024)),
    );
  } catch (e) {
    if (e instanceof WireFsError && e.code === "NOT_FOUND") return [];
    if (e instanceof WireFsError && e.code === "IO") return [];
    throw e;
  }
}

/**
 * 锚路径（子项操作/目录枚举的基点）：
 * fd-chain 模式=`<prefix>/<t.fd>`（fd 即锚——magic link 指向其 dentry）；
 * verified-walk 模式=root+comps 重建的**已复核**路径（注意 withResolved 返回的
 * t.parentPath 是终组件之父的路径——不能当本组件的锚用）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @param {string[]} comps 本次解析的组件（终组件=锚目录自身）
 * @param {{ fd: number }} t
 */
function anchorPath(cap, root, comps, t) {
  if (cap.mode === "fd-chain") return `${cap.prefix}/${t.fd}`;
  return comps.length === 0 ? root.rootPath : path.join(root.rootPath, ...comps);
}

/**
 * 列目录（条目 name/type/size/mtime；忽略/保留名过滤；目录优先排序）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @param {string[]} comps 目标目录（空=root）
 * @param {import("./ignore.mjs").IgnoreRule[]} rules
 * @returns {Promise<{ path: string, entries: Array<{ name: string, type: "dir" | "file", size: number, mtime: number }>, truncated: boolean }>}
 */
export async function listDir(cap, root, comps, rules) {
  assertNotIgnored(root, comps, rules, { isDir: true });
  return withResolved(cap, root, comps, { flags: FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW, expect: EXPECT.DIR }, async (t) => {
    const enumPath = anchorPath(cap, root, comps, t);
    const dir = await fsp.opendir(enumPath).catch((e) => {
      throw mapOpenError(e, "opening directory for listing");
    });
    /** @type {Array<{ name: string, type: "dir" | "file", size: number, mtime: number }>} */
    const entries = [];
    let truncated = false;
    try {
      for (;;) {
        const ent = await dir.read();
        if (ent === null) break;
        if (ent.name === "." || ent.name === "..") continue;
        if (isReservedName(ent.name)) continue;
        if (ent.isSymbolicLink()) continue; // symlink 条目不暴露（不跟随）
        const isDir = ent.isDirectory();
        if (isIgnored(rules, [...comps, ent.name], { isDir })) continue;
        // 条目元数据：逐条目打开+fstat（O_NOFOLLOW——并发消失/不可开即跳过，
        // 列表=快照语义）
        const flags = isDir ? FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW : FS.O_RDONLY | FS.O_NOFOLLOW;
        const efd = await openChild(cap, t.fd, enumPath, ent.name, flags).then(
          (fd) => fd,
          () => null,
        );
        if (efd === null) continue;
        try {
          const st = fsSync.fstatSync(efd);
          entries.push({ name: ent.name, type: isDir ? "dir" : "file", size: st.size, mtime: Math.round(st.mtimeMs) });
        } finally {
          fsSync.closeSync(efd);
        }
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
      }
    } finally {
      await dir.close().catch(() => {});
    }
    entries.sort((a, b) =>
      a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === "dir" ? -1 : 1
    );
    return { path: comps.join("/"), entries, truncated };
  });
}

/**
 * stat 条目（文件返回 oid；目录 oid=null）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @param {string[]} comps
 * @param {import("./ignore.mjs").IgnoreRule[]} rules
 * @returns {Promise<{ name: string | null, type: "dir" | "file", size: number, mtime: number, oid: string | null }>}
 */
export async function statEntry(cap, root, comps, rules) {
  assertNotIgnored(root, comps, rules);
  try {
    return await withResolved(cap, root, comps, { flags: FS.O_RDONLY | FS.O_NOFOLLOW, expect: EXPECT.FILE }, async (t) => {
      const oid = await oidOfFd(t.fd, t.stat);
      return { name: t.name, type: "file", size: t.stat.size, mtime: Math.round(t.stat.mtimeMs), oid };
    });
  } catch (e) {
    if (e instanceof WireFsError && e.code === "IS_DIR") {
      return withResolved(cap, root, comps, { flags: FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW, expect: EXPECT.DIR }, async (t) => ({
        name: t.name,
        type: "dir",
        size: 0,
        mtime: Math.round(t.stat.mtimeMs),
        oid: null,
      }));
    }
    throw e;
  }
}

/**
 * 打开读句柄（read 用：fd 需存活到流尾——终 fd 不随链释放；中间 fd 在身份
 * 复核后关闭）。oid 在此处计算（ETag 头先行于流）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @param {string[]} comps
 * @param {import("./ignore.mjs").IgnoreRule[]} rules
 * @returns {Promise<{ fd: number, size: number, oid: string }>}
 */
export async function openForRead(cap, root, comps, rules) {
  assertNotIgnored(root, comps, rules);
  if (comps.length === 0) throw new WireFsError("IS_DIR", "share root itself is a directory");
  /** @type {number[]} */
  const opened = [];
  /** @type {number | null} 终 fd（成功路径由调用方持有；失败路径兜底关闭） */
  let finalFd = null;
  try {
    if (cap.mode === "verified-walk") {
      const st = await fsp.lstat(root.rootPath).catch(() => null);
      if (st === null || st.isSymbolicLink() || st.ino !== root.rootIno || st.dev !== root.rootDev) {
        throw new WireFsError("ROOT_GONE", "share root path no longer names the frozen root directory; re-create the share");
      }
    }
    let parentFd = root.rootFd;
    let parentPath = root.rootPath;
    for (let i = 0; i < comps.length - 1; i++) {
      const step = await openChildDir(cap, parentFd, parentPath, comps[i]).catch((e) => {
        throw mapOpenError(e, `component "${comps[i]}"`);
      });
      opened.push(step.fd);
      parentFd = step.fd;
      parentPath = step.path;
    }
    const name = comps[comps.length - 1];
    const fd = await openChild(cap, parentFd, parentPath, name, FS.O_RDONLY | FS.O_NOFOLLOW).catch((e) => {
      throw mapOpenError(e, `opening "${name}"`);
    });
    finalFd = fd;
    const stat = fsSync.fstatSync(fd);
    if (!stat.isFile()) {
      throw new WireFsError("IS_DIR", `"${name}" is not a regular file`);
    }
    if (cap.mode === "verified-walk") {
      await verifyChainIdentity(root, comps, [...opened, fd]);
    }
    const oid = await oidOfFd(fd, stat);
    finalFd = null; // 成功：fd 移交调用方
    return { fd, size: stat.size, oid };
  } catch (e) {
    if (finalFd !== null) fsSync.closeSync(finalFd);
    throw e;
  } finally {
    for (const cfd of opened) fsSync.closeSync(cfd);
  }
}

/**
 * verified-walk 身份复核（逐级 lstat 与 fd fstat 比对 dev+ino）。
 * @param {RootRef} root
 * @param {string[]} comps
 * @param {number[]} fds 与组件序对齐的 fd 列表
 */
async function verifyChainIdentity(root, comps, fds) {
  let cur = root.rootPath;
  for (let i = 0; i < comps.length; i++) {
    cur = path.join(cur, comps[i]);
    const lst = await fsp.lstat(cur).catch(() => null);
    if (lst === null) throw new WireFsError("RACE_DETECTED", `"${comps[i]}" changed during resolution; operation rejected`);
    const fd = fds[i];
    if (fd === undefined) continue;
    const fst = fsSync.fstatSync(fd);
    if (lst.ino !== fst.ino || lst.dev !== fst.dev) {
      throw new WireFsError("RACE_DETECTED", `"${comps[i]}" was replaced during resolution; operation rejected`);
    }
  }
}

/**
 * mkdir（父目录经链解析；保留名/忽略拒绝）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @param {string[]} comps
 * @param {import("./ignore.mjs").IgnoreRule[]} rules
 */
export async function mkdirEntry(cap, root, comps, rules) {
  if (comps.length === 0) throw new WireFsError("ESCAPE", "cannot mkdir the root");
  const name = comps[comps.length - 1];
  if (isReservedName(name)) throw new WireFsError("NOT_FOUND", "reserved name");
  assertNotIgnored(root, comps, rules, { isDir: true });
  const parent = comps.slice(0, -1);
  await withResolved(cap, root, parent, { flags: FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW, expect: EXPECT.DIR }, async (t) => {
    await mutators.mkdir(cap, t.fd, anchorPath(cap, root, parent, t), name).catch((e) => {
      throw mapOpenError(e, `mkdir "${name}"`);
    });
  });
}

/**
 * delete（目录=rmdir 仅空目录——v1 无递归删除，偏差见包文档；文件=unlink）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @param {string[]} comps
 * @param {import("./ignore.mjs").IgnoreRule[]} rules
 * @returns {Promise<"file" | "dir">}
 */
export async function deleteEntry(cap, root, comps, rules) {
  if (comps.length === 0) throw new WireFsError("ESCAPE", "cannot delete the root");
  const name = comps[comps.length - 1];
  if (isReservedName(name)) throw new WireFsError("NOT_FOUND", "reserved name");
  assertNotIgnored(root, comps, rules);
  const parent = comps.slice(0, -1);
  return withResolved(cap, root, parent, { flags: FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW, expect: EXPECT.DIR }, async (t) => {
    const anchor = anchorPath(cap, root, parent, t);
    try {
      await mutators.rmdir(cap, t.fd, anchor, name);
      return "dir";
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "ENOTDIR") {
        await mutators.unlink(cap, t.fd, anchor, name).catch((e2) => {
          throw mapOpenError(e2, `delete "${name}"`);
        });
        return "file";
      }
      throw mapOpenError(e, `delete "${name}"`);
    }
  });
}

/**
 * rename（from→to；两者父目录各自经链解析；to 已存在=拒绝不覆盖——v1 显式
 * 语义：需要覆盖时客户端先 delete 再 rename）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @param {string[]} fromComps
 * @param {string[]} toComps
 * @param {import("./ignore.mjs").IgnoreRule[]} rules
 */
export async function renameEntry(cap, root, fromComps, toComps, rules) {
  if (fromComps.length === 0 || toComps.length === 0) throw new WireFsError("ESCAPE", "cannot rename the root");
  const fromName = fromComps[fromComps.length - 1];
  const toName = toComps[toComps.length - 1];
  if (isReservedName(fromName) || isReservedName(toName)) throw new WireFsError("NOT_FOUND", "reserved name");
  assertNotIgnored(root, fromComps, rules);
  assertNotIgnored(root, toComps, rules);
  const toParentComps = toComps.slice(0, -1);
  const fromParentComps = fromComps.slice(0, -1);
  const toReady = await withResolved(
    cap,
    root,
    toParentComps,
    { flags: FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW, expect: EXPECT.DIR },
    async (t) => ({ fd: t.fd }),
  );
  // to 不存在（存在=EXISTS 拒绝不覆盖；symlink=ELOOP 拒绝）
  await openChild(cap, toReady.fd, anchorPath(cap, root, toParentComps, toReady), toName, FS.O_RDONLY | FS.O_NOFOLLOW).then(
    async (fd) => {
      fsSync.closeSync(fd);
      throw new WireFsError("EXISTS", `rename target already exists: ${toName}`);
    },
    (e) => {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "ELOOP") throw mapOpenError(e, `rename target "${toName}"`);
      if (err.code !== "ENOENT") throw mapOpenError(e, `rename target "${toName}"`);
    },
  );
  const fromReady = await withResolved(
    cap,
    root,
    fromParentComps,
    { flags: FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW, expect: EXPECT.DIR },
    async (t) => ({ fd: t.fd }),
  );
  await mutators.rename(
    cap,
    fromReady.fd,
    anchorPath(cap, root, fromParentComps, fromReady),
    fromName,
    toReady.fd,
    anchorPath(cap, root, toParentComps, toReady),
    toName,
  ).catch((e) => {
    throw mapOpenError(e, `rename "${fromName}" -> "${toName}"`);
  });
}

/**
 * commit：staging → 正式命名空间（详见模块头 4）。
 * @param {{ mode: import("./fdchain.mjs").PathSafetyMode, prefix: string | null }} cap
 * @param {RootRef} root
 * @param {string[]} comps 目标全路径组件
 * @param {import("./ignore.mjs").IgnoreRule[]} rules
 * @param {import("./staging.mjs").Staging} staging
 * @param {{ uploadId: string, totalLength: number, contentHash: string }} input
 * @returns {Promise<{ size: number, oid: string }>}
 */
export async function commitUpload(cap, root, comps, rules, staging, input) {
  const { uploadId, totalLength, contentHash } = input;
  if (comps.length === 0) throw new WireFsError("ESCAPE", "destination cannot be the root");
  const name = comps[comps.length - 1];
  if (isReservedName(name)) throw new WireFsError("NOT_FOUND", "reserved name");
  assertNotIgnored(root, comps, rules);
  const meta = await staging.readMeta(uploadId);
  if (meta === null) throw new WireFsError("NOT_FOUND", `unknown uploadId (no staging): ${uploadId}`);
  const metaComps = meta.path === "" ? [] : meta.path.split("/");
  if (metaComps.join("\u0000") !== comps.join("\u0000")) {
    throw new WireFsError("ESCAPE", "commit destination does not match the upload's bound path");
  }
  const chunks = await staging.listChunks(uploadId);
  // 全覆盖核对：按 offset 平铺 [0, totalLength) 无缝无重叠；seq 唯一
  const seqSeen = new Set();
  let cursor = 0;
  for (const c of chunks) {
    if (seqSeen.has(c.seq)) throw new WireFsError("COVERAGE", `duplicate seq ${c.seq} in staging`);
    seqSeen.add(c.seq);
    if (c.offset !== cursor) {
      throw new WireFsError("COVERAGE", `chunk coverage gap or overlap at offset ${c.offset} (expected ${cursor})`);
    }
    cursor += c.size;
  }
  if (cursor !== totalLength) {
    throw new WireFsError("COVERAGE", `total staged bytes ${cursor} != declared totalLength ${totalLength}`);
  }
  const parent = comps.slice(0, -1);
  return withResolved(cap, root, parent, { flags: FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW, expect: EXPECT.DIR }, async (t) => {
    const tempName = `.opendweb.upload.${uploadId}.tmp`;
    const anchor = anchorPath(cap, root, parent, t);
    // 清理同 uploadId 的前次崩溃残留（temp 不在正式命名空间，安全可清）
    await mutators.unlink(cap, t.fd, anchor, tempName).catch(() => {});
    const tempFd = await openChild(cap, t.fd, anchor, tempName, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW).catch((e) => {
      throw mapOpenError(e, "creating upload temp file");
    });
    let renamed = false;
    try {
      const hash = createHash("sha256");
      let written = 0;
      for (const c of chunks) {
        const bytes = await fsp.readFile(c.file);
        hash.update(bytes);
        let off = 0;
        while (off < bytes.length) {
          off += fsSync.writeSync(tempFd, bytes, off, bytes.length - off);
        }
        written += bytes.length;
        await new Promise((r) => setImmediate(r)); // 让位事件循环（分片 ≤4MiB）
      }
      fsSync.fsyncSync(tempFd);
      const digest = hash.digest("hex");
      if (written !== totalLength || digest !== contentHash) {
        throw new WireFsError("DIGEST", `whole-file digest or length mismatch (staged ${written} bytes vs declared ${totalLength}); upload rejected, nothing landed`);
      }
      await mutators.rename(cap, t.fd, anchor, tempName, t.fd, anchor, name).catch((e) => {
        throw mapOpenError(e, `committing "${name}"`);
      });
      renamed = true;
      await staging.removeUpload(uploadId);
      return { size: written, oid: digest };
    } finally {
      try {
        fsSync.closeSync(tempFd);
      } catch {
        /* 已关 */
      }
      if (!renamed) {
        await mutators.unlink(cap, t.fd, anchor, tempName).catch(() => {});
      }
    }
  });
}
