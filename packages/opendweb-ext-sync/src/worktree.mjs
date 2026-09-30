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

import { lstat, mkdir, readdir, readFile, rm, open, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { loadRootIgnore } from "./ignore.mjs";
import { writeBlob } from "./objects.mjs";

/**
 * 扫描工作树（ignore 语义过滤；symlink 条目标记 type:'symlink'——不读内容、
 * 不入对象库，由合并层按文件级冲突/保守处理）。
 * r8-B4：opts.maxFileBytes 在读取文件内容/写 blob **之前**按 lstat 尺寸预检
 * （commitLocal 防「超限 blob 进 device 历史」的毒化防线——超限即抛
 * oversize-history 稳定错误，零史写入）。
 * @param {string} root
 * @param {string} gitdir
 * @param {{ maxFileBytes?: number }} [opts] maxFileBytes：单文件尺寸上限（字节；超限抛 {code:"oversize-history"}）
 * @returns {Promise<Array<{ path: string, kind: "file" | "dir" | "symlink", oid: string | null, mode: number | null }>>}
 */
export async function scanWorktree(root, gitdir, opts = {}) {
  const maxFileBytes = opts.maxFileBytes;
  const ignored = await loadRootIgnore(root);
  /** @type {Array<{ path: string, kind: "file" | "dir" | "symlink", oid: string | null, mode: number | null }>} */
  const out = [];
  /**
   * @param {string} abs
   * @param {string} rel
   */
  async function walk(abs, rel) {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return;
      throw e;
    }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ignored(childRel, ent.isDirectory())) continue;
      const childAbs = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        out.push({ path: childRel, kind: "dir", oid: null, mode: null });
        await walk(childAbs, childRel);
      } else {
        const st = await lstat(childAbs).catch(() => null);
        if (st === null) continue;
        if (st.isSymbolicLink()) {
          out.push({ path: childRel, kind: "symlink", oid: null, mode: null });
        } else if (st.isFile()) {
          // r8-B4 毒化防线：读内容/写 blob 前按 lstat 尺寸预检——超限文件不得
          // 进入 device 历史（稳定 oversize-history+迁移提示；不自动重写/删除）
          if (maxFileBytes !== undefined && st.size > maxFileBytes) {
            throw {
              code: "oversize-history",
              path: childRel,
              size: st.size,
              limit: maxFileBytes,
              message: `file ${childRel} is ${st.size} bytes (limit ${maxFileBytes} = 1MiB per-blob transport envelope); device history was not written`,
              hint: "move the file out of the synced root or split it (per-file skip = filtered-tree semantics, not v1); existing oversize history is never auto-rewritten — explicitly reset/re-seed the root to migrate; other roots without it keep syncing",
            };
          }
          const bytes = new Uint8Array(await readFile(childAbs));
          const oid = await writeBlob(gitdir, bytes);
          const exec = (st.mode & 0o111) !== 0;
          out.push({ path: childRel, kind: "file", oid, mode: exec ? 0o100755 : 0o100644 });
        }
        // 其他类型（fifo/socket/device）：跳过（不可同步——v1 如实不载）
      }
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
 * @param {string} root
 * @param {string} relPath
 * @param {string} gitdir
 * @returns {Promise<{ oid: string | null, type: "blob" | "tree" | null, mode: number | null }>} symlink → {oid:'symlink', type:'symlink' as any…} 以非匹配态呈现
 */
export async function pathStateTuple(root, relPath, gitdir) {
  const st = await lstat(path.join(root, relPath)).catch(() => null);
  if (st === null) return { oid: null, type: null, mode: null };
  if (st.isDirectory()) return { oid: null, type: "tree", mode: null };
  if (st.isSymbolicLink()) return { oid: "symlink", type: "tree", mode: null }; // 非任何合法 pre/postimage——诊断第三态
  if (st.isFile()) {
    const bytes = new Uint8Array(await readFile(path.join(root, relPath)));
    const oid = await writeBlob(gitdir, bytes); // 写入对象库幂等（哈希同则同对象）
    return { oid, type: "blob", mode: (st.mode & 0o111) !== 0 ? 0o100755 : 0o100644 };
  }
  return { oid: "special", type: "tree", mode: null };
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
