// 工作树层（webui-plugin-kernel Phase 3 / design v2.3 §7.2/§7.3.1）。
// 意图（2026-09-29）：
// 1. 工作树=用户目录本体（gitdir 独立于用户目录）。扫描（scanning 阶段）=
//    ignore 过滤后的全树 → blob 写入对象库 → 扁平树表；「用户未提交本地改动
//    MUST 已被 commit 进 device ref」由引擎在扫描后先提交再进入 fetch/merge
//    （design §7.3.1 尾段）。
// 2. 物化原语（intent.mjs 消费）：write=同文件系统临时文件+fsync+rename（逐
//    文件原子）+mode 位；delete=unlink；目录按需 mkdir（父目录链）。
// 3. 路径状态元组（判定元组=（OID，entry type，mode）——r4-N2：OID 单独不可
//    分辨 chmod/type 变化）：file→(oid,type:'blob',mode)；dir→(null,'tree',
//    null)；missing→(null,null,null)；symlink→('symlink',…) 非法状态（诊断
//    第三态「其他」承接——绝不跟随）。
// r9-B1（TOCTOU 闭合，2026-09-29）：入史/分诊读取不再「lstat 预检→按路径
// readFile」两步裸奔——四类竞态（预检后增长、普通文件换 symlink、目录换
// symlink、分诊期间替换）由受控原语 fail-closed 拦截：
//   - 普通文件：open(O_RDONLY|O_NONBLOCK|O_NOFOLLOW) 拿 fd → fd 上 fstat 复核
//     size+regular → 从 fd 有界读（累计超限即刻 oversize-history 停读）→
//     读毕长度复核（≠fstat size=并发变化→稳定 worktree-race 拒绝）→ 全部
//     确认后才 writeBlob。O_NOFOLLOW：终组件为 symlink → ELOOP（绝不跟随，
//     根外零读取）；O_NONBLOCK：非普通文件（fifo）打开不挂起，fstat 判型后跳过。
//   - 目录递归：verified-walk 锚定（平台先例=packages/opendweb-ext-files/src/
//     fdchain.mjs——macOS /dev/fd 逐级 fd 链已实证不可用，不重新发明 fd 链
//     组合）：每级 open(O_DIRECTORY|O_NOFOLLOW)+fstat 记身份（dev/ino）→按
//     路径 readdir→readdir 后 lstat 该目录复核身份，不一致/换 symlink→
//     fail-closed 拒绝整个扫描（不跟随、该分支不静默跳过——静默跳过=用户数据
//     无声缺席 device 线）。子条目（Dirent 分类）逐个以 O_NOFOLLOW 锚定打开，
//     listing 与打开间的替换由子级原语兜住。
//   - pathStateTuple 复用同一受控原语（不再 lstat 后按字符串路径读）。
//   - 稳定错误：{code:"worktree-race"}（含 path/reason/hint——「工作树并发
//     变化，零史写入，空闲后重试」）；超限仍 {code:"oversize-history"}。
//   - opts.readHook（**测试专用**确定性竞态注入——不 sleep 赌时序）：
//     "dir-open"{abs,rel} 目录 open 前；"dir-readdir"{abs,rel} 目录 open+
//     fstat 后 readdir 前；"file-open"{abs,rel} 文件 open 前；"file-read"
//     {abs,rel,size} open+fstat+尺寸预检后首块读取前。

import { lstat, mkdir, readdir, readFile, rm, open, rename, chmod } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";
import { loadRootIgnore } from "./ignore.mjs";
import { writeBlob } from "./objects.mjs";

// O_NOFOLLOW/O_DIRECTORY 在 darwin/linux 可用；win32 无此原语（undefined→0，
// 锚定降级为无保护——与旧 readFile 面等同，win32 非本包主张平台）。
const O_NOFOLLOW = FS.O_NOFOLLOW ?? 0;
const O_DIRECTORY = FS.O_DIRECTORY ?? 0;

/** 受控读取块大小（累计上限按块推进——超限即刻停读） */
const READ_CHUNK_BYTES = 64 * 1024;

/** readRegularFileAnchored 的「非普通文件」哨兵（fifo/socket/device——v1 如实不载） */
const NON_REGULAR = Symbol("non-regular");

/**
 * 稳定竞态错误（r9-B1：fail-closed——稳定 code，零史写入语义由调用方「抛出即
 * 中止扫描/分诊」保证）。
 * @param {string} relPath
 * @param {string} reason symlink-swap | size-changed | directory-identity | root-symlink | not-a-directory
 * @param {string} detail
 */
function worktreeRaceError(relPath, reason, detail) {
  return {
    code: "worktree-race",
    path: relPath,
    reason,
    message: `worktree path "${relPath}" changed during the scan (${reason}: ${detail}); nothing entered history`,
    hint: "the worktree changed between the check and the anchored read (concurrent modification or symlink swap); the scan was rejected fail-closed before any blob/tree/commit was written — re-run sync once the worktree is idle",
  };
}

/**
 * 超限入史稳定错误（r8-B4 毒化防线——形状冻结：既有测试匹配 hint 文案）。
 * @param {string} relPath
 * @param {number} size
 * @param {number} limit
 */
function oversizeHistoryError(relPath, size, limit) {
  return {
    code: "oversize-history",
    path: relPath,
    size,
    limit,
    message: `file ${relPath} is ${size} bytes (limit ${limit} = 1MiB per-blob transport envelope); device history was not written`,
    hint: "move the file out of the synced root or split it (per-file skip = filtered-tree semantics, not v1); existing oversize history is never auto-rewritten — explicitly reset/re-seed the root to migrate; other roots without it keep syncing",
  };
}

/**
 * 受控读取单文件（r9-B1 核心原语——scanWorktree 与 pathStateTuple 共用）。
 * 步骤：readHook("file-open") → open(O_RDONLY|O_NONBLOCK|O_NOFOLLOW) → fd 上
 * fstat（regular 复核+尺寸预检）→ readHook("file-read") → 从 fd 有界分块读
 * （累计>maxBytes 即刻 oversize-history 停读）→ 读毕长度复核（≠fstat size →
 * worktree-race fail-closed）→ 返回 {bytes, mode}；完整确认后调用方才 writeBlob。
 * @param {string} absPath
 * @param {string} relPath
 * @param {{ maxFileBytes?: number, readHook?: (phase: string, info: { abs: string, rel: string, size?: number }) => Promise<void> | void }} [opts]
 * @returns {Promise<{ bytes: Uint8Array, mode: number } | null | typeof NON_REGULAR>}
 *   null=打开时已消失（旧 lstat-null 容忍语义）；NON_REGULAR=非普通文件（跳过）
 */
async function readRegularFileAnchored(absPath, relPath, opts = {}) {
  const maxBytes = opts.maxFileBytes;
  const readHook = opts.readHook;
  if (readHook !== undefined) await readHook("file-open", { abs: absPath, rel: relPath });
  let fh;
  try {
    fh = await open(absPath, FS.O_RDONLY | FS.O_NONBLOCK | O_NOFOLLOW);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === "ENOENT") return null; // 打开前消失（容忍——非逃逸）
    if (code === "ELOOP") {
      // 扫描分诊时非 symlink、打开时是 symlink → 两步间被替换：绝不跟随
      throw worktreeRaceError(relPath, "symlink-swap", "open(O_NOFOLLOW) hit a symlink where the scan saw a regular file");
    }
    throw e;
  }
  try {
    const fst = await fh.stat(); // fstat——fd 上复核（不按路径再 stat）
    if (!fst.isFile()) return NON_REGULAR; // fifo/socket/device：v1 如实不载
    if (maxBytes !== undefined && fst.size > maxBytes) {
      throw oversizeHistoryError(relPath, fst.size, maxBytes); // 读前预检（fstat 版）
    }
    if (readHook !== undefined) await readHook("file-read", { abs: absPath, rel: relPath, size: fst.size });
    /** @type {Buffer[]} */
    const parts = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, READ_CHUNK_BYTES, null); // 顺序读 fd
      if (bytesRead === 0) break; // EOF
      total += bytesRead;
      if (maxBytes !== undefined && total > maxBytes) {
        // 预检后增长（TOCTOU-①）：fd 读流里累计超限即刻停——超限内容永不入史
        throw oversizeHistoryError(relPath, total, maxBytes);
      }
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    if (total !== fst.size) {
      // 长度复核：读毕字节 ≠ fstat size = 读取期间并发变化（增长未超限/收缩）→ fail-closed
      throw worktreeRaceError(relPath, "size-changed", `fstat said ${fst.size} bytes but ${total} were read before EOF`);
    }
    return { bytes: total === 0 ? new Uint8Array(0) : new Uint8Array(Buffer.concat(parts)), mode: fst.mode };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 扫描工作树（ignore 语义过滤；symlink 条目标记 type:'symlink'——不读内容、
 * 不入对象库，由合并层按文件级冲突/保守处理）。
 * r8-B4：opts.maxFileBytes 在读取文件内容/写 blob **之前**预检（commitLocal 防
 * 「超限 blob 进 device 历史」的毒化防线——超限即抛 oversize-history 稳定错误，
 * 零史写入）；r9-B1：预检与读取合并为受控 fd 原语（见文件头）。
 * @param {string} root
 * @param {string} gitdir
 * @param {{ maxFileBytes?: number, readHook?: (phase: string, info: { abs: string, rel: string, size?: number }) => Promise<void> | void }} [opts]
 * @returns {Promise<Array<{ path: string, kind: "file" | "dir" | "symlink", oid: string | null, mode: number | null }>>}
 */
export async function scanWorktree(root, gitdir, opts = {}) {
  const maxFileBytes = opts.maxFileBytes;
  const readHook = opts.readHook;
  const ignored = await loadRootIgnore(root);
  /** @type {Array<{ path: string, kind: "file" | "dir" | "symlink", oid: string | null, mode: number | null }>} */
  const out = [];
  /**
   * @param {string} abs
   * @param {string} rel
   */
  async function walk(abs, rel) {
    if (readHook !== undefined) await readHook("dir-open", { abs, rel });
    let dirFh;
    try {
      dirFh = await open(abs, FS.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === "ENOENT") return; // 容忍消失（旧 readdir-ENOENT 语义）
      if (code === "ELOOP" || code === "ENOTDIR") {
        // 目录位置换 symlink（TOCTOU-③：父级 listing 与本级递归间）或换成非目录
        // ——绝不跟随。errno 平台分歧（linux=ELOOP / darwin=ENOTDIR）：lstat 归一
        // reason，保持稳定诊断。
        const lst = await lstat(abs).catch(() => null);
        const isSymlink = lst !== null && lst.isSymbolicLink();
        throw worktreeRaceError(
          rel,
          isSymlink ? (rel === "" ? "root-symlink" : "symlink-swap") : "not-a-directory",
          isSymlink ? "open(O_DIRECTORY|O_NOFOLLOW) hit a symlink where the scan saw a directory" : "path stopped naming a directory during the scan",
        );
      }
      throw e;
    }
    try {
      const fst = await dirFh.stat(); // fstat——本目录身份锚（dev/ino）
      if (!fst.isDirectory()) throw worktreeRaceError(rel, "not-a-directory", "O_DIRECTORY open did not yield a directory");
      if (readHook !== undefined) await readHook("dir-readdir", { abs, rel });
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true }); // Node 无 fd-readdir——按路径读，身份由前后锚复核
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return;
        throw e;
      }
      // 身份复核（verified-walk：readdir 前后比对——open 时的 fstat vs 此刻 lstat）
      const lst = await lstat(abs).catch(() => null);
      if (lst === null || lst.isSymbolicLink() || lst.dev !== fst.dev || lst.ino !== fst.ino) {
        throw worktreeRaceError(rel, "directory-identity", `directory ${rel === "" ? "(root)" : rel} was replaced between open and readdir`);
      }
      for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
        if (ignored(childRel, ent.isDirectory())) continue;
        const childAbs = path.join(abs, ent.name);
        if (ent.isDirectory()) {
          out.push({ path: childRel, kind: "dir", oid: null, mode: null });
          await walk(childAbs, childRel); // 子级独立锚定（见文件头）
        } else if (ent.isSymbolicLink()) {
          out.push({ path: childRel, kind: "symlink", oid: null, mode: null }); // Dirent 分类即终态——symlink 永不打开
        } else {
          const r = await readRegularFileAnchored(childAbs, childRel, { maxFileBytes, readHook });
          if (r === null || r === NON_REGULAR) continue; // 消失容忍/非普通文件跳过
          const oid = await writeBlob(gitdir, r.bytes); // 完整确认后才入对象库
          const exec = (r.mode & 0o111) !== 0;
          out.push({ path: childRel, kind: "file", oid, mode: exec ? 0o100755 : 0o100644 });
        }
      }
    } finally {
      await dirFh.close().catch(() => {});
    }
  }
  await walk(root, "");
  return out;
}

/**
 * 扫描结果 → 扁平树表（目录条目折叠——git 树由 writeFlatTree 组嵌套；symlink
 * 不入树，但其存在会作为「工作树非树内状态」被诊断第三态检出）。
 * @param {Awaited<ReturnType<typeof scanWorktree>>} entries
 * @returns {Array<{ path: string, oid: string, mode: string, type: "blob" }>}
 */
export function scanToFlatEntries(entries) {
  return entries
    .filter((e) => e.kind === "file" && e.oid !== null && e.mode !== null)
    .map((e) => ({ path: e.path, oid: /** @type {string} */ (e.oid), mode: /** @type {number} */ (e.mode) === 0o100755 ? "100755" : "100644", type: /** @type {"blob"} */ ("blob") }));
}

/**
 * 读工作树单文件内容（物化 write 的对象库读源之外的用户态读——seed 对照等）。
 * @param {string} root
 * @param {string} relPath
 * @returns {Promise<Uint8Array | null>} 不存在/非普通文件 → null
 */
export async function readFileOrNull(root, relPath) {
  const st = await lstat(path.join(root, relPath)).catch(() => null);
  if (st === null || !st.isFile() || st.isSymbolicLink()) return null;
  return new Uint8Array(await readFile(path.join(root, relPath)));
}

/**
 * 路径状态元组（r4-N2 判定元组：（OID，entry type，mode））。
 * r9-B1：分诊读取走同一受控原语（lstat 只做分类；内容读取=受控 fd——绝不
 * lstat 后按字符串路径读）。lstat 说是普通文件、open(O_NOFOLLOW) 撞 ELOOP →
 * 分诊期间被替换 → 稳定 worktree-race（intent 现场由调用方按协议保留）。
 * @param {string} root
 * @param {string} relPath
 * @param {string} gitdir
 * @param {{ readHook?: (phase: string, info: { abs: string, rel: string, size?: number }) => Promise<void> | void }} [opts]
 * @returns {Promise<{ oid: string | null, type: "blob" | "tree" | null, mode: number | null }>} symlink → {oid:'symlink', type:'symlink' as any…} 以非匹配态呈现
 */
export async function pathStateTuple(root, relPath, gitdir, opts = {}) {
  const abs = path.join(root, relPath);
  const st = await lstat(abs).catch(() => null);
  if (st === null) return { oid: null, type: null, mode: null };
  if (st.isDirectory()) return { oid: null, type: "tree", mode: null };
  if (st.isSymbolicLink()) return { oid: "symlink", type: "tree", mode: null }; // 非任何合法 pre/postimage——诊断第三态
  if (!st.isFile()) return { oid: "special", type: "tree", mode: null };
  const r = await readRegularFileAnchored(abs, relPath, { readHook: opts.readHook });
  if (r === null) return { oid: null, type: null, mode: null }; // 分诊两步间消失=missing
  if (r === NON_REGULAR) return { oid: "special", type: "tree", mode: null };
  const oid = await writeBlob(gitdir, r.bytes); // 写入对象库幂等（哈希同则同对象）
  return { oid, type: "blob", mode: (r.mode & 0o111) !== 0 ? 0o100755 : 0o100644 };
}

/**
 * 物化单 write（同文件系统临时文件+fsync+rename——design §7.3.1 步骤 2；
 * 逐文件原子+幂等：重放同内容 rename 幂等）。
 * @param {string} root
 * @param {string} relPath
 * @param {Uint8Array} bytes
 * @param {{ mode?: number, tmpSuffix?: string }} [opts]
 */
export async function materializeWrite(root, relPath, bytes, opts = {}) {
  const target = path.join(root, relPath);
  const tmp = `${target}.dwebtmp-${opts.tmpSuffix ?? "m"}`;
  await mkdir(path.dirname(target), { recursive: true });
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(Buffer.from(bytes));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(tmp, (opts.mode ?? 0o100644) & 0o777); // git mode 含类型位——chmod 只取权限位
  await rename(tmp, target);
}

/**
 * 物化单 delete（unlink；幂等：ENOENT 视为完成）。
 * @param {string} root
 * @param {string} relPath
 */
export async function materializeDelete(root, relPath) {
  const target = path.join(root, relPath);
  try {
    const st = await lstat(target);
    if (st.isDirectory()) await rm(target, { recursive: true, force: true });
    else await rm(target, { force: true });
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
}
