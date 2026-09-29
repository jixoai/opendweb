// 对象库与 refs 原语（webui-plugin-kernel Phase 3 / design v2.3 §7.1/§7.3）。
// 意图（2026-09-29）：
// 1. isomorphic-git 只做对象/refs/commit 底座（探针实证）；refs 读写直接走
//    gitdir/refs 文件（isomorphic-git@1.42 listRefs 对 loose refs 返回空——
//    不可依赖；resolveRef/writeRef 正常）。
// 2. 对象哈希本地实现（sha1(`<type> <len>\0`+content)——与 git loose object
//    布局一致）：staging 校验（类型+长度+OID 自证）不依赖写入即可验 OID。
// 3. 传输原子粒度=单松散对象（readObject/writeObject format:"content" 字节级
//    round-trip 探针已证 oid 逐字节一致）。
// 4. ref 命名（design §7.2 [W8]）：每设备一 ref `refs/devices/<endpointId>/main`
//    + 组收敛 ref `refs/heads/main`；v1 执行只保证双机 pairwise。

import git from "isomorphic-git";
import promisesFs from "node:fs/promises";
import * as callbackFs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** isomorphic-git fs 绑定（promises 优先） */
export const gitFs = { ...callbackFs, promises: promisesFs };

/** @param {string} endpointId */
export function deviceRef(endpointId) {
  if (!/^[0-9a-f]{8,64}$/.test(endpointId)) throw new Error(`endpointId must be hex (got ${JSON.stringify(endpointId)})`);
  return `refs/devices/${endpointId}/main`;
}

/** 组收敛 ref */
export const GROUP_REF = "refs/heads/main";

/** ref 全量白名单（端点 push 目标校验 + 路径逃逸防线） */
export function isAllowedRef(ref) {
  return ref === GROUP_REF || /^refs\/devices\/[0-9a-f]{8,64}\/main$/.test(ref);
}

/**
 * 本地 refs 快照（直接遍历 gitdir/refs——loose refs 真源）。
 * @param {string} gitdir
 * @returns {Promise<Record<string, string>>}
 */
export async function listRefsDirect(gitdir) {
  /** @type {Record<string, string>} */
  const out = {};
  const refsRoot = path.join(gitdir, "refs");
  /** @param {string} abs @param {string} rel */
  async function walk(abs, rel) {
    let entries;
    try {
      entries = await promisesFs.readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return;
      throw e;
    }
    for (const ent of entries) {
      const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      const childAbs = path.join(abs, ent.name);
      if (ent.isDirectory()) await walk(childAbs, childRel);
      else if (ent.isFile()) {
        const value = (await promisesFs.readFile(childAbs, "utf8")).trim();
        if (/^[0-9a-f]{40}$/.test(value)) out[`refs/${childRel}`] = value;
      }
    }
  }
  await walk(refsRoot, "");
  return out;
}

/**
 * 读单 ref（不存在返回 null——CAS 判空用）。
 * @param {string} gitdir
 * @param {string} ref 完整 ref 名（refs/...）
 * @returns {Promise<string | null>}
 */
export async function readRef(gitdir, ref) {
  try {
    return await git.resolveRef({ fs: gitFs, gitdir, ref });
  } catch (e) {
    const code = /** @type {{ code?: string }} */ (e).code;
    if (code === "NotFoundError" || code === "CommitNotFountError" || code === "RefNotSetError") return null;
    // ENOENT/ref 文件缺失也归一为 null（首拉前）
    if (code === "ENOENT") return null;
    const msg = String(/** @type {Error} */ (e)?.message ?? e);
    if (/not a valid ref|does not exist|Could not resolve|Cannot find|ENOTDIR/.test(msg)) return null;
    throw e;
  }
}

/**
 * 写 ref（force——CAS 由调用方在互斥内先读比对；design §7.3 CAS）。
 * @param {string} gitdir
 * @param {string} ref
 * @param {string} oid
 */
export async function writeRef(gitdir, ref, oid) {
  if (!isAllowedRef(ref)) throw new Error(`ref not allowed: ${ref}`);
  await git.writeRef({ fs: gitFs, gitdir, ref, value: oid, force: true });
}

/**
 * 对象哈希（git loose object 语义：sha1(`<type> <len>\0`+content)）。
 * @param {string} type blob|tree|commit
 * @param {Uint8Array} content 原始内容字节
 */
export function objectOid(type, content) {
  const header = Buffer.from(`${type} ${content.byteLength}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(Buffer.from(content)).digest("hex");
}

/**
 * 本地是否有该对象。
 * @param {string} gitdir
 * @param {string} oid
 */
export async function hasObject(gitdir, oid) {
  try {
    await git.readObject({ fs: gitFs, gitdir, oid, format: "content" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 写对象（content 字节 → oid；内容寻址幂等）。
 * @param {string} gitdir
 * @param {string} type
 * @param {Uint8Array} content
 * @returns {Promise<string>}
 */
export async function writeObject(gitdir, type, content) {
  return git.writeObject({ fs: gitFs, gitdir, type: /** @type {"blob" | "tree" | "commit"} */ (type), object: Buffer.from(content), format: "content" });
}

/**
 * 读对象原始字节（transport/物化共用；format:"content" 不解析）。
 * @param {string} gitdir
 * @param {string} oid
 * @returns {Promise<{ type: string, bytes: Uint8Array }>}
 */
export async function readObject(gitdir, oid) {
  const r = await git.readObject({ fs: gitFs, gitdir, oid, format: "content" });
  return { type: /** @type {string} */ (r.type), bytes: new Uint8Array(Buffer.from(/** @type {Uint8Array} */ (r.object))) };
}

/**
 * 读对象（parsed——树条目/提交字段用）。
 * @param {string} gitdir
 * @param {string} oid
 */
export async function readParsed(gitdir, oid) {
  const r = await git.readObject({ fs: gitFs, gitdir, oid, format: "parsed" });
  return { type: /** @type {string} */ (r.type), object: r.object };
}

/**
 * 写 blob（工作树扫描用；返回 oid）。
 * @param {string} gitdir
 * @param {Uint8Array} bytes
 */
export async function writeBlob(gitdir, bytes) {
  return git.writeBlob({ fs: gitFs, gitdir, blob: Buffer.from(bytes) });
}

/**
 * 扁平全路径 blob 表 → 嵌套树写入（isomorphic-git writeTree **不**接受带 `/` 的
 * path 自行组嵌套——实测 UnsafeFilepathError；故自建分层结构逐层 writeTree。
 * 排序按 path 字典序（确定性——同输入同 oid，两端收敛前提））。
 * @param {string} gitdir
 * @param {Array<{ path: string, oid: string, mode: "100644" | "100755" }>} flatEntries 仅 blob 全路径
 * @returns {Promise<string>} 根树 oid
 */
export async function writeTreeFromFlat(gitdir, flatEntries) {
  /**
   * @typedef {Object} TreeNode
   * @property {{ mode: "100644" | "100755", oid: string } | null} leaf
   * @property {Map<string, TreeNode>} children
   */
  /** @type {TreeNode} */
  const root = { leaf: null, children: new Map() };
  for (const e of [...flatEntries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const segs = e.path.split("/");
    /** @type {TreeNode} */
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      let child = node.children.get(seg);
      if (child === undefined) {
        child = { leaf: null, children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.children.set(segs[segs.length - 1], { leaf: { mode: e.mode, oid: e.oid }, children: new Map() });
  }
  /**
   * @param {TreeNode} node
   * @param {string} prefix
   */
  async function build(node, prefix) {
    const entries = [];
    for (const [name, child] of [...node.children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (child.leaf !== null && child.children.size === 0) {
        entries.push({ mode: child.leaf.mode, path: name, type: "blob", oid: child.leaf.oid });
      } else {
        // 文件/目录同路径互斥由合并层保证（type 冲突拦截）；此处目录优先安全网
        entries.push({ mode: "040000", path: name, type: "tree", oid: await build(child, prefix === "" ? name : `${prefix}/${name}`) });
      }
    }
    return git.writeTree({ fs: gitFs, gitdir, tree: entries });
  }
  return build(root, "");
}

/**
 * 读树为扁平全路径表（path → {oid, mode, type}；递归子树）。文件不存在
 * （oid 非 tree）→ 抛。
 * @param {string} gitdir
 * @param {string} treeOid
 * @returns {Promise<Map<string, { oid: string, mode: string, type: "blob" | "tree" }>>}
 */
export async function readFlatTree(gitdir, treeOid) {
  /** @type {Map<string, { oid: string, mode: string, type: "blob" | "tree" }>} */
  const out = new Map();
  /**
   * @param {string} oid
   * @param {string} prefix
   */
  async function walk(oid, prefix) {
    const r = await git.readTree({ fs: gitFs, gitdir, oid });
    for (const ent of r.tree) {
      const p = prefix === "" ? ent.path : `${prefix}/${ent.path}`;
      if (ent.type === "tree") {
        out.set(p, { oid: ent.oid, mode: ent.mode, type: "tree" });
        await walk(ent.oid, p);
      } else {
        out.set(p, { oid: ent.oid, mode: ent.mode, type: "blob" });
      }
    }
  }
  await walk(treeOid, "");
  return out;
}

/**
 * 写提交（parent 数组；作者=设备身份——design §9「author=设备 endpoint 缩写+
 * 机器名」；noUpdateBranch：ref 推进统一走 intent/CAS，不隐写 HEAD）。
 * @param {string} gitdir
 * @param {{ message: string, tree: string, parent: string[], authorName: string, authorEmail: string, timestamp: number }} spec
 */
export async function writeCommitOid(gitdir, spec) {
  const author = { name: spec.authorName, email: spec.authorEmail, timestamp: Math.floor(spec.timestamp / 1000), timezoneOffset: 0 };
  return git.writeCommit({
    fs: gitFs,
    gitdir,
    commit: { message: spec.message, tree: spec.tree, parent: spec.parent, author, committer: author },
    noUpdateBranch: true,
  });
}

/** @param {string} gitdir @param {string} oid */
export async function readCommitParsed(gitdir, oid) {
  const r = await git.readCommit({ fs: gitFs, gitdir, oid });
  return r.commit;
}

/**
 * commit DAG parent 闭包遍历（§7.6 首批验收义务——探针瑕疵之一的实现义务）。
 * 返回闭包内全部对象（commit/树/blob）的 {oid,type,size}（size=原始内容长度）。
 * `resolver(oid)` 返回 null 表示对象缺失（闭包校验/缺失清单共用）。
 * @param {string} startCommit
 * @param {(oid: string) => Promise<{ type: string, bytes: Uint8Array } | null>} resolver
 * @returns {Promise<Array<{ oid: string, type: string, size: number }>>} 缺失时抛 {code:'missing', missing:string[]}
 */
export async function walkClosure(startCommit, resolver) {
  /** @type {Map<string, { oid: string, type: string, size: number }>} */
  const seen = new Map();
  /** @type {Set<string>} */
  const missing = new Set();
  /** @type {string[]} */
  const queue = [startCommit];
  const queued = new Set([startCommit]);
  /**
   * @param {string} oid
   */
  async function ensure(oid) {
    if (seen.has(oid) || missing.has(oid)) return;
    if (!queued.has(oid)) {
      queue.push(oid);
      queued.add(oid);
    }
  }
  while (queue.length > 0) {
    const oid = /** @type {string} */ (queue.shift());
    const obj = await resolver(oid);
    if (obj === null) {
      missing.add(oid);
      continue;
    }
    seen.set(oid, { oid, type: obj.type, size: obj.bytes.byteLength });
    if (obj.type === "commit") {
      const text = Buffer.from(obj.bytes).toString("utf8");
      const treeMatch = /^tree ([0-9a-f]{40})$/m.exec(text);
      if (treeMatch) await ensure(treeMatch[1]);
      for (const m of text.matchAll(/^parent ([0-9a-f]{40})$/gm)) await ensure(m[1]);
    } else if (obj.type === "tree") {
      // 树对象二进制格式：<mode> SP <path> NUL <20B oid> 逐条
      const buf = Buffer.from(obj.bytes);
      let i = 0;
      while (i < buf.length) {
        const nul = buf.indexOf(0x00, i);
        if (nul === -1) break;
        const entryOid = buf.subarray(nul + 1, nul + 21).toString("hex");
        const head = buf.subarray(i, nul).toString("ascii");
        const isTree = head.startsWith("40");
        await ensure(entryOid); // mode 040000 → tree；其余 blob
        if (!isTree) {
          // blob 类型由 resolver 读出时自证（oid 不足辨 type）
        }
        i = nul + 21;
      }
    }
  }
  if (missing.size > 0) throw { code: "missing", missing: [...missing].sort() };
  return [...seen.values()].sort((a, b) => (a.oid < b.oid ? -1 : 1));
}

/**
 * 合并基（两 commit 的最近公共祖先——自实现 BFS 祖先集求交；isomorphic-git
 * 无 mergeBase 命令）。
 * @param {string} gitdir
 * @param {string} a
 * @param {string} b
 * @returns {Promise<string | null>}
 */
export async function mergeBase(gitdir, a, b) {
  /**
   * @param {string} start
   * @returns {Promise<string[]>} 按拓扑深度排序的祖先（含自身）
   */
  async function ancestors(start) {
    const order = [];
    const seen = new Set();
    const queue = [start];
    while (queue.length > 0) {
      const oid = /** @type {string} */ (queue.shift());
      if (seen.has(oid)) continue;
      seen.add(oid);
      order.push(oid);
      try {
        const c = await readCommitParsed(gitdir, oid);
        queue.push(...c.parent);
      } catch {
        // 对象缺失（不应发生——闭包已校验）：按叶处理
      }
    }
    return order;
  }
  const [aa, bb] = await Promise.all([ancestors(a), ancestors(b)]);
  const bset = new Set(bb);
  for (const oid of aa) if (bset.has(oid)) return oid; // aa 按 BFS 深度序——首个命中即最近公共祖先
  return null;
}
