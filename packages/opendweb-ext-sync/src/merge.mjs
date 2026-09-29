// 自持三方树合并（webui-plugin-kernel Phase 3 / design v2.3 §7.4 + probe 实证 2/3）。
// 意图（2026-09-29）：
// 1. isomorphic-git 只做底座——merge 编排自持（探针实证 2：git.merge 对
//    bothModified 不做行级合并，直接 MergeConflictError——不采用其二分语义）。
// 2. 树分类：按 (base,ours,theirs) 扁平树 diff 分类 add/modify/delete/type/mode。
// 3. 文本 blob（严格 UTF-8 且 ≤上限）：node-diff3 `diff3Merge(ours, base,
//    theirs, {stringSeparator:"\n", excludeFalseConflicts:true})` 非重叠自动
//    合并；重叠区=结构化 hunk（{a,o,b} 行数组——UI 选块/编辑与 merge driver
//    钩子的输入）。
// 4. 冲突分级（r1 P5/r5 mode 重构）：hunk 级=文本重叠；文件级=binary/超限/
//    非 UTF-8/delete-modify/type/mode——**保守规则：mode 变化与对端内容变化
//    一律文件级；单侧 mode 变化（对端无变化）自动传播**。ours/theirs 按
//    endpointId 稳定排序（冲突身份稳定——P5）。
// 5. 冲突记录持久化：base/ours/theirs OID+mode + diff3 算法版本 + 结构化
//    hunks + 用户决议（两端可复现）。merge driver 钩子位：registerMergeDriver
//    注册 driver（结构化 hunk 输入）；v1 不自动写回（[W3] 边界——AI merge 为
//    未来 driver）。
// 6. rename=delete+add 不追踪；大小写冲突=文件级（大小写敏感 FS 语义——v1
//    实现为「同名同 oid 的不同大小写路径对」在扁平表合并中自然分立，跨平台
//    收敛为后续义务，如实标注）。

import { diff3Merge } from "node-diff3";
import { decodeUtf8Strict } from "./util.mjs";
import { readObject, writeObject } from "./objects.mjs";

/** diff3 算法版本标识（冲突记录复现判据——两端一致才可复算决议） */
export const DIFF3_ALGO_VERSION = "node-diff3@3:diff3Merge:stringSeparator=\\n:excludeFalseConflicts=true;v1";

/** 文本合并参与上限（≤16MiB 且 UTF-8——超限/非 UTF-8 → 文件级） */
export const TEXT_MERGE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * ours/theirs 稳定排序（endpointId 字典序——P5 冲突身份稳定）。
 * @param {string} endpointA @param {string} endpointB
 * @returns {{ ours: string, theirs: string }}
 */
export function stableSides(endpointA, endpointB) {
  return endpointA <= endpointB ? { ours: endpointA, theirs: endpointB } : { ours: endpointB, theirs: endpointA };
}

/**
 * @typedef {Object} FlatEntry
 * @property {string} oid
 * @property {string} mode "100644" | "100755" | "040000"
 * @property {"blob" | "tree"} type
 *
 * @typedef {Map<string, FlatEntry>} FlatTree
 *
 * @typedef {{ a: string[], o: string[], b: string[], aIndex: number, oIndex: number, bIndex: number }} MergeHunk
 *
 * @typedef {Object} MergeConflict
 * @property {string} path
 * @property {"hunk" | "file"} level
 * @property {"text" | "binary" | "utf8" | "size" | "delete-modify" | "type" | "mode" | "add-add"} kind
 * @property {{ oid: string, mode: string } | null} base
 * @property {{ oid: string, mode: string } | null} ours
 * @property {{ oid: string, mode: string } | null} theirs
 * @property {MergeHunk[]} [hunks] level=hunk 时
 * @property {string} [detail]
 *
 * @typedef {Object} MergeOutcome
 * @property {Array<{ path: string, oid: string, mode: string, type: "blob" | "tree" }>} mergedEntries 扁平全树（含未冲突路径原样保留）
 * @property {MergeConflict[]} conflicts
 * @property {string[]} autoMerged 自动合并路径
 * @property {string[]} propagatedMode 单侧 mode 变化自动传播路径
 */

/**
 * 文本三方合并（diff3Merge——探针实证 3）。
 * @param {string} oursText
 * @param {string} baseText
 * @param {string} theirsText
 * @returns {{ clean: true, text: string } | { clean: false, hunks: MergeHunk[], partialText: string }}
 */
export function diff3TextMerge(oursText, baseText, theirsText) {
  const regions = diff3Merge(oursText, baseText, theirsText, { excludeFalseConflicts: true, stringSeparator: "\n" });
  /** @type {MergeHunk[]} */
  const hunks = [];
  /** @type {string[]} */
  const lines = [];
  let hadConflict = false;
  for (const r of regions) {
    if ("ok" in r) {
      lines.push(...r.ok);
    } else {
      hadConflict = true;
      hunks.push({ a: [...r.conflict.a], o: [...r.conflict.o], b: [...r.conflict.b], aIndex: r.conflict.aIndex, oIndex: r.conflict.oIndex, bIndex: r.conflict.bIndex });
    }
  }
  // 注：stringSeparator "\n" 的 split/join 是恒等往返（结尾 "" 行保留）——不做
  // 结尾换行补写（补写会双计——probe 测试断言逐字节还原）。
  const text = lines.join("\n");
  return hadConflict ? { clean: false, hunks, partialText: text } : { clean: true, text };
}

/**
 * hunk 决议 → 最终文本（逐块选 ours/theirs 或编辑；编辑内容即终稿该块内容）。
 * @param {string} oursText
 * @param {string} baseText
 * @param {string} theirsText
 * @param {MergeHunk[]} hunks
 * @param {Array<{ hunkIndex: number, choice: "ours" | "theirs" | "edit", text?: string }>} decisions
 */
export function applyHunkDecisions(oursText, baseText, theirsText, hunks, decisions) {
  if (decisions.length !== hunks.length) throw new Error(`hunk decisions must cover every hunk (${decisions.length}/${hunks.length})`);
  const regions = diff3Merge(oursText, baseText, theirsText, { excludeFalseConflicts: true, stringSeparator: "\n" });
  /** @type {string[]} */
  const lines = [];
  let hunkIdx = 0;
  for (const r of regions) {
    if ("ok" in r) lines.push(...r.ok);
    else {
      const d = decisions.find((x) => x.hunkIndex === hunkIdx);
      if (d === undefined) throw new Error(`missing decision for hunk ${hunkIdx}`);
      const hunk = hunks[hunkIdx];
      if (d.choice === "ours") lines.push(...hunk.a);
      else if (d.choice === "theirs") lines.push(...hunk.b);
      else {
        if (typeof d.text !== "string") throw new Error(`hunk ${hunkIdx} edit decision requires text`);
        lines.push(...d.text.split("\n"));
      }
      hunkIdx += 1;
    }
  }
  return lines.join("\n"); // split/join 恒等往返（同 diff3TextMerge 注）
}

/**
 * 三方树合并（核心分类——design §7.4 步骤 1-3 逐条）。
 * @param {{ gitdir: string, baseTree: FlatTree, oursTree: FlatTree, theirsTree: FlatTree }} input
 * @returns {Promise<MergeOutcome>}
 */
export async function mergeTrees(input) {
  const { gitdir, baseTree, oursTree, theirsTree } = input;
  const paths = new Set([...baseTree.keys(), ...oursTree.keys(), ...theirsTree.keys()]);
  /** @type {MergeOutcome} */
  const out = { mergedEntries: [], conflicts: [], autoMerged: [], propagatedMode: [] };
  for (const p of [...paths].sort()) {
    const b = baseTree.get(p) ?? null;
    const o = oursTree.get(p) ?? null;
    const t = theirsTree.get(p) ?? null;
    const blobify = (e) => (e !== null && e.type === "blob" ? { oid: e.oid, mode: e.mode } : null);

    // ---- type 冲突（file↔directory）：任一侧类型分立且非全一致 → 文件级 ----
    const types = new Set([b?.type, o?.type, t?.type].filter((x) => x !== undefined));
    if (types.size > 1) {
      out.conflicts.push({ path: p, level: "file", kind: "type", base: blobify(b), ours: blobify(o), theirs: blobify(t), detail: `entry type diverges across sides (base=${b?.type ?? "absent"}, ours=${o?.type ?? "absent"}, theirs=${t?.type ?? "absent"})` });
      continue;
    }

    // 全部 tree（目录路径）：目录的存在性由其子 blob 路径承载（writeFlatTree 按
    // 全路径自动组装嵌套；空目录 git 不可表达）——目录条目本身不入扁平结果。
    // type 分歧（file↔dir）已在上一分支按文件级冲突拦截，这里三方同为 tree。
    if (types.has("tree")) continue;

    // ---- blob 路径分类（base/ours/theirs ∈ {blob, absent}） ----
    if (o === null && t === null) continue; // 双删（或本就不存在）→ 不在结果树
    if (b === null) {
      // add-add / 单侧新增
      if (o !== null && t !== null) {
        if (o.oid === t.oid && o.mode === t.mode) out.mergedEntries.push({ path: p, oid: o.oid, mode: o.mode, type: "blob" });
        else if (o.oid === t.oid) out.mergedEntries.push({ path: p, oid: o.oid, mode: pickMode(b, o, t) ?? o.mode, type: "blob" });
        else {
          // 双侧新增不同内容：按文本尝试（空基线 diff3）——可自动合并公共区，
          // 重叠区 hunk 冲突；不可文本化 → 文件级 add-add
          const r = await tryTextMerge(gitdir, o.oid, null, t.oid);
          if (r === null) out.conflicts.push({ path: p, level: "file", kind: "add-add", base: null, ours: blobify(o), theirs: blobify(t) });
          else if (r.clean) {
            const oid = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from(r.text, "utf8")));
            out.mergedEntries.push({ path: p, oid, mode: o.mode === t.mode ? o.mode : "100644", type: "blob" });
            out.autoMerged.push(p);
          } else {
            out.conflicts.push({ path: p, level: "hunk", kind: "text", base: null, ours: blobify(o), theirs: blobify(t), hunks: r.hunks });
          }
        }
      } else {
        const keep = /** @type {FlatEntry} */ (o ?? t);
        out.mergedEntries.push({ path: p, oid: keep.oid, mode: keep.mode, type: "blob" });
      }
      continue;
    }
    // base 存在（blob）
    const oChanged = o !== null && (o.oid !== b.oid || o.mode !== b.mode);
    const tChanged = t !== null && (t.oid !== b.oid || t.mode !== b.mode);
    const oContentChanged = o !== null && o.oid !== b.oid;
    const tContentChanged = t !== null && t.oid !== b.oid;
    const oModeChanged = o !== null && o.mode !== b.mode;
    const tModeChanged = t !== null && t.mode !== b.mode;

    if (o !== null && t !== null) {
      if (o.oid === t.oid && o.mode === t.mode) {
        out.mergedEntries.push({ path: p, oid: o.oid, mode: o.mode, type: "blob" }); // 同改同果
        continue;
      }
      if (!oChanged) {
        out.mergedEntries.push({ path: p, oid: t.oid, mode: t.mode, type: "blob" }); // ours 未动 → 取 theirs（含单侧 mode 变化自动传播）
        if (tModeChanged && !tContentChanged) out.propagatedMode.push(p);
        continue;
      }
      if (!tChanged) {
        out.mergedEntries.push({ path: p, oid: o.oid, mode: o.mode, type: "blob" });
        if (oModeChanged && !oContentChanged) out.propagatedMode.push(p);
        continue;
      }
      // 双侧均变更
      // mode 竞争保守规则：一侧 mode 变化 + 对端内容变化 → 文件级（mode 与内容
      // 竞争变更不做自动组合）；双侧 mode 各自不同 → 文件级
      const modeRace =
        (oModeChanged && tContentChanged) || (tModeChanged && oContentChanged) || (oModeChanged && tModeChanged && o.mode !== t.mode);
      if (modeRace) {
        out.conflicts.push({ path: p, level: "file", kind: "mode", base: blobify(b), ours: blobify(o), theirs: blobify(t), detail: "mode change competes with the peer's content/mode change (conservative: file-level; content and mode resolve as a whole)" });
        continue;
      }
      // 纯内容双方变更 → 文本合并（hunk 级）或文件级（binary/超限/非 UTF-8）
      if (!oContentChanged) {
        out.mergedEntries.push({ path: p, oid: t.oid, mode: o.mode, type: "blob" }); // ours 仅 mode 变化已被上面规则承接——此处不会到
        continue;
      }
      if (!tContentChanged) {
        out.mergedEntries.push({ path: p, oid: o.oid, mode: t.mode, type: "blob" });
        continue;
      }
      const r = await tryTextMerge(gitdir, o.oid, b.oid, t.oid);
      if (r === null) {
        out.conflicts.push({ path: p, level: "file", kind: await classifyNonText(gitdir, o.oid), base: blobify(b), ours: blobify(o), theirs: blobify(t) });
      } else if (r.clean) {
        const oid = await writeObject(gitdir, "blob", new Uint8Array(Buffer.from(r.text, "utf8")));
        out.mergedEntries.push({ path: p, oid, mode: o.mode, type: "blob" });
        out.autoMerged.push(p);
      } else {
        out.conflicts.push({ path: p, level: "hunk", kind: "text", base: blobify(b), ours: blobify(o), theirs: blobify(t), hunks: r.hunks });
      }
      continue;
    }
    // 单侧删除（delete-modify / 双删同 path）
    if (o === null && t !== null) {
      if (!tChanged) continue; // ours 删 + theirs 未动 → 保持删除
      out.conflicts.push({ path: p, level: "file", kind: "delete-modify", base: blobify(b), ours: null, theirs: blobify(t), detail: "ours deleted, theirs modified" });
      continue;
    }
    if (t === null && o !== null) {
      if (!oChanged) continue; // theirs 删 + ours 未动 → 保持删除
      out.conflicts.push({ path: p, level: "file", kind: "delete-modify", base: blobify(b), ours: blobify(o), theirs: null, detail: "theirs deleted, ours modified" });
      continue;
    }
  }
  return out;
}

/** add-add 同 oid 异 mode 的取舍：任一侧可执行 → 可执行（git 语义近似）。 */
function pickMode(b, o, t) {
  void b;
  if (o.mode === "100755" || t.mode === "100755") return "100755";
  return "100644";
}

/**
 * @param {string} gitdir
 * @param {string} oid
 */
async function classifyNonText(gitdir, oid) {
  const { bytes } = await readObject(gitdir, oid);
  if (bytes.byteLength > TEXT_MERGE_MAX_BYTES) return "size";
  if (decodeUtf8Strict(bytes) === null) return "utf8";
  return "binary";
}

/**
 * 文本合并尝试（任一侧不可文本化/超限 → null=文件级）。
 * @param {string} gitdir
 * @param {string} oursOid
 * @param {string | null} baseOid
 * @param {string} theirsOid
 */
async function tryTextMerge(gitdir, oursOid, baseOid, theirsOid) {
  const [oB, bB, tB] = await Promise.all([readObject(gitdir, oursOid), baseOid === null ? Promise.resolve({ type: "blob", bytes: new Uint8Array(0) }) : readObject(gitdir, baseOid), readObject(gitdir, theirsOid)]);
  for (const b of [oB.bytes, bB.bytes, tB.bytes]) {
    if (b.byteLength > TEXT_MERGE_MAX_BYTES) return null;
  }
  const oT = decodeUtf8Strict(oB.bytes);
  const bT = decodeUtf8Strict(bB.bytes);
  const tT = decodeUtf8Strict(tB.bytes);
  if (oT === null || bT === null || tT === null) return null;
  return diff3TextMerge(oT, bT, tT);
}

// ---- merge driver 钩子位（design §7.4-5：结构化 hunk 输入；v1 不自动写回） ----

/**
 * @typedef {(input: { path: string, hunks: MergeHunk[], base: { oid: string, mode: string } | null, ours: { oid: string, mode: string } | null, theirs: { oid: string, mode: string } | null }) =>
 *   Array<{ hunkIndex: number, choice: "ours" | "theirs" | "edit", text?: string }> | null} MergeDriver
 */

/** @type {Map<string, MergeDriver>} */
const mergeDrivers = new Map();

/**
 * 注册 merge driver（AI merge 为未来 driver；v1 只留接口不自动写回）。
 * @param {string} name
 * @param {MergeDriver} driver
 */
export function registerMergeDriver(name, driver) {
  mergeDrivers.set(name, driver);
}

/** @param {string} name */
export function unregisterMergeDriver(name) {
  mergeDrivers.delete(name);
}

/**
 * 咨询注册的 drivers（注册序）；任一返回决议即作为建议记录在冲突记录的
 * `driverSuggestion`（引擎不自动写回——UI 展示为预填建议）。
 * @param {{ path: string, hunks: MergeHunk[], base: MergeConflict["base"], ours: MergeConflict["ours"], theirs: MergeConflict["theirs"] }} input
 */
export function consultMergeDrivers(input) {
  for (const [name, driver] of mergeDrivers) {
    try {
      const r = driver(input);
      if (r !== null) return { driver: name, decisions: r };
    } catch {
      /* driver 失败=无建议——继续 */
    }
  }
  return null;
}

/**
 * 冲突记录（持久化形状——两端可复现：OID+算法版本+决议）。
 * @param {object} rec
 */
export function conflictRecordId(rec) {
  const canon = JSON.stringify({ p: rec.path, b: rec.base?.oid ?? null, o: rec.ours?.oid ?? null, t: rec.theirs?.oid ?? null });
  let h = 0;
  for (let i = 0; i < canon.length; i++) h = (h * 31 + canon.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
