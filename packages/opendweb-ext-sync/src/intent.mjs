// intent 事务协议（webui-plugin-kernel Phase 3 / design v2.3 §7.3.1——r2-B3
// 冻结 + r4-N2 重构，逐字实现）。
// 意图（2026-09-29）：
// 工作树物化与 ref 推进 MUST 经单一持久化事务协议：
//   1. prepare：gitdir 旁写 intent 日志（0600 原子写）：{txId, targetCommit,
//      路径操作清单（write=path/oid、delete=path）, 旧 ref 快照}——每路径记录
//      预期前像 preimage 与目标后像 postimage，判定元组=（OID，entry type，
//      mode）三元组（r4-N2：OID 单独不可分辨 chmod/type 变化）；
//   2. 物化：逐操作执行（write=对象库读内容→同文件系统临时文件+fsync+rename；
//      delete=unlink；每步幂等重放安全）；
//   3. 推进：ref CAS 到 targetCommit（expectedOldRef=prepare 时快照）；
//   4. 提交标记：intent 追加 done 标记（原子写）。
// 崩溃恢复（重启扫描；先 ref 三态分诊后执行，r4-N2 冻结）：
//   - ref==targetCommit → 物化与推进均视为完成：逐路径核验**只接受 postimage**；
//     任一路径非 postimage → **不得补 done**（保留 intent 现场、conflicted 态
//     交用户决议）；全为 postimage → 仅补 done（不 CAS、不重放物化）；
//   - ref==oldRef → 路径三态分诊：实际==preimage→应用；实际==postimage→已完成
//     （引擎自己的半写不得误判为用户冲突）；其他→用户新改动：保留内容、保留
//     intent 现场、转冲突（绝不静默覆盖）；全部完成且无冲突→CAS→done；
//   - ref==其他 → 冲突：停止、保留现场、conflicted 态交用户。
// 崩溃注入：executeIntent 接受 crashAt(stage) 钩子——stage ∈ {prepared,
// materialized:<i>, ref-advanced, before-done}；抛出即模拟 kill（测试直接调
// recoverIntent 收敛——不真 kill 进程）。

import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { atomicWrite0600, CrashInjection, randomId } from "./util.mjs";
import { materializeWrite, materializeDelete, pathStateTuple } from "./worktree.mjs";
import { readObject, readRef, writeRef } from "./objects.mjs";

/** intent 日志文件名（gitdir 旁） */
export const INTENT_FILE = "intent.json";
/** done 标记文件名（「intent 追加 done 标记」——独立 0600 原子文件，携带 txId） */
export const INTENT_DONE_FILE = "intent.done.json";

/**
 * @typedef {Object} IntentOp
 * @property {"write" | "delete"} op
 * @property {string} path 相对同步根
 * @property {{ oid: string | null, type: "blob" | "tree" | null, mode: number | null } | null} pre
 * @property {{ oid: string | null, type: "blob" | "tree" | null, mode: number | null } | null} post
 *
 * @typedef {Object} IntentRecord
 * @property {string} txId
 * @property {string} ref 目标 ref（完整名）
 * @property {string} targetCommit
 * @property {string | null} oldRef prepare 时的 ref 快照（null=当时不存在）
 * @property {IntentOp[]} ops
 * @property {string} createdAt
 * @property {string} [note]
 */

/** @param {string} repoDir（gitdir 的父目录——intent 落 repoDir/intent.json） */
export function intentPaths(repoDir) {
  return { intent: path.join(repoDir, INTENT_FILE), done: path.join(repoDir, INTENT_DONE_FILE) };
}

/**
 * 读当前未完成 intent（无/已 done → null）。
 * @param {string} repoDir
 * @returns {Promise<IntentRecord | null>}
 */
export async function readPendingIntent(repoDir) {
  const { intent, done } = intentPaths(repoDir);
  let text;
  try {
    text = await import("node:fs/promises").then((m) => m.readFile(intent, "utf8"));
  } catch {
    return null;
  }
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    throw new Error(`intent log malformed (${intent})`);
  }
  try {
    const doneText = await import("node:fs/promises").then((m) => m.readFile(done, "utf8"));
    const doneRec = JSON.parse(doneText);
    if (doneRec.txId === rec.txId) return null; // 已完成（done 标记有效匹配）
  } catch {
    /* 无 done 标记/损坏 → 视为未完成 */
  }
  return rec;
}

/**
 * 元组归一：{oid:null,type:null,mode:null} ≡ null（缺省形态的两种表示——
 * intent 记录里用 null，pathStateTuple 返回全 null 字段对象）。
 * @param {IntentOp["pre"]} t
 * @returns {IntentOp["pre"]}
 */
function normalizeTuple(t) {
  if (t === null) return null;
  if (t.oid === null && t.type === null && t.mode === null) return null;
  return t;
}

/**
 * 元组相等（判定元组=(OID,type,mode)——含 chmod/type 变化检出）。
 * @param {IntentOp["pre"]} a
 * @param {IntentOp["pre"]} b
 */
export function tupleEquals(a, b) {
  const na = normalizeTuple(a);
  const nb = normalizeTuple(b);
  if (na === null || nb === null) return na === nb; // 不存在形态
  return na.oid === nb.oid && na.type === nb.type && na.mode === nb.mode;
}

/**
 * prepare：写 intent 日志（0600 原子写）。幂等防线：repoDir 存在未完成 intent
 * 时拒绝（单事务串行——恢复或完成前不得开新事务）。
 * @param {{ repoDir: string }} ctx
 * @param {Omit<IntentRecord, "txId" | "createdAt">} spec
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<IntentRecord>}
 */
export async function prepareIntent(ctx, spec, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const pending = await readPendingIntent(ctx.repoDir);
  if (pending !== null) throw new Error(`intent already pending (txId=${pending.txId}) — recover or resolve first`);
  const rec = { ...spec, txId: `tx-${randomId(8)}`, createdAt: new Date(now()).toISOString() };
  const { intent } = intentPaths(ctx.repoDir);
  await mkdir(ctx.repoDir, { recursive: true, mode: 0o700 });
  await atomicWrite0600(intent, `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

/**
 * 物化单操作（write：对象库读内容→临时+fsync+rename+chmod；delete：unlink）。
 * 幂等：重放同内容安全（rename 覆盖同内容；delete ENOENT 完成语义）。
 * @param {{ root: string, gitdir: string }} ctx
 * @param {IntentOp} op
 * @param {string} txId
 */
export async function applyOp(ctx, op, txId) {
  if (op.op === "write") {
    const post = op.post;
    if (post === null || post.type === "tree" || post.oid === null) {
      // post 为 tree（文件→目录决议）：物化=目录存在即可（子路径由各自 write 建）
      await mkdir(`${ctx.root}/${op.path}`, { recursive: true });
      return;
    }
    const { bytes } = await readObject(ctx.gitdir, post.oid);
    await materializeWrite(ctx.root, op.path, bytes, { mode: post.mode ?? 0o100644, tmpSuffix: txId });
  } else {
    await materializeDelete(ctx.root, op.path);
  }
}

/**
 * 完整事务执行（prepare→物化→CAS→done）。crashAt(stage) 抛出=kill 模拟
 * （测试四边界：prepared / materialized:<i> / ref-advanced / before-done）。
 * @param {{ repoDir: string, root: string, gitdir: string }} ctx
 * @param {Omit<IntentRecord, "txId" | "createdAt">} spec
 * @param {{ now?: () => number, crashAt?: (stage: string) => void }} [opts]
 * @returns {Promise<IntentRecord>}
 */
export async function executeIntent(ctx, spec, opts = {}) {
  const { crashAt } = opts;
  const rec = await prepareIntent(ctx, spec, opts);
  if (crashAt) crashAt("prepared");
  for (let i = 0; i < rec.ops.length; i++) {
    await applyOp(ctx, rec.ops[i], rec.txId);
    if (crashAt) crashAt(`materialized:${i}`);
  }
  await advanceRef(ctx, rec);
  if (crashAt) crashAt("ref-advanced");
  await markDone(ctx, rec, opts);
  // done 已原子落盘——此后崩溃=readPendingIntent 返回 null（恢复幂等 clean）
  return rec;
}

/**
 * 推进 ref（CAS：current==oldRef 才写；不等=并发推进——抛 cas 错误交上层）。
 * @param {{ repoDir: string, gitdir: string }} ctx
 * @param {IntentRecord} rec
 */
export async function advanceRef(ctx, rec) {
  const current = await readRef(ctx.gitdir, rec.ref);
  if (current !== rec.oldRef) {
    throw { code: "cas-mismatch", ref: rec.ref, expectedOldRef: rec.oldRef, currentRef: current };
  }
  await writeRef(ctx.gitdir, rec.ref, rec.targetCommit);
}

/**
 * done 标记（原子写；携带 txId 供 readPendingIntent 匹配）。
 * @param {{ repoDir: string }} ctx
 * @param {IntentRecord} rec
 * @param {{ now?: () => number }} [opts]
 */
export async function markDone(ctx, rec, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const { done } = intentPaths(ctx.repoDir);
  await atomicWrite0600(done, `${JSON.stringify({ txId: rec.txId, doneAt: new Date(now()).toISOString() })}\n`);
}

/**
 * 清理 intent 现场（事务完成后的例行清理；conflicted 保留现场=不调用本函数）。
 * @param {string} repoDir
 */
export async function clearIntent(repoDir) {
  const { intent, done } = intentPaths(repoDir);
  await rm(intent, { force: true }).catch(() => {});
  await rm(done, { force: true }).catch(() => {});
}

/**
 * 崩溃恢复（§7.3.1 步骤「崩溃恢复」逐字实现；返回分诊结果）。
 * - {status:'clean'}：无 pending intent；
 * - {status:'recovered'}：确定性 roll-forward 完成（物化+CAS+done 或仅补 done）；
 * - {status:'conflicted', paths, reason}：保留现场交用户（'user-edits'=oldRef
 *   分支路径第三态；'postimage-mismatch'=targetCommit 分支非 postimage；
 *   'ref-moved'=ref 三态之其他）。
 * @param {{ repoDir: string, root: string, gitdir: string }} ctx
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<{ status: "clean" | "recovered" | "conflicted", paths?: string[], reason?: string, intent?: IntentRecord }>}
 */
export async function recoverIntent(ctx, opts = {}) {
  const rec = await readPendingIntent(ctx.repoDir);
  if (rec === null) return { status: "clean" };
  const current = await readRef(ctx.gitdir, rec.ref);

  // ---- ref 分诊（先分诊后执行） ----
  if (current === rec.targetCommit) {
    // 物化与推进均视为完成：逐路径核验只接受 postimage
    /** @type {string[]} */
    const bad = [];
    for (const op of rec.ops) {
      const actual = await pathStateTuple(ctx.root, op.path, ctx.gitdir);
      const postTuple = op.post === null ? null : { oid: op.post.oid, type: op.post.type, mode: op.post.mode };
      if (!tupleEquals(actual, postTuple)) bad.push(op.path);
    }
    if (bad.length > 0) {
      // 不得补 done：保留 intent 现场、conflicted 态交用户决议
      return { status: "conflicted", paths: bad, reason: "postimage-mismatch", intent: rec };
    }
    await markDone(ctx, rec, opts); // 仅补 done——不 CAS、不重放物化
    await clearIntent(ctx.repoDir);
    return { status: "recovered", intent: rec };
  }

  if (current === rec.oldRef) {
    // 路径三态分诊 + 物化 + CAS
    /** @type {string[]} */
    const userEdited = [];
    for (const op of rec.ops) {
      const actual = await pathStateTuple(ctx.root, op.path, ctx.gitdir);
      const preTuple = op.pre === null ? null : { oid: op.pre.oid, type: op.pre.type, mode: op.pre.mode };
      const postTuple = op.post === null ? null : { oid: op.post.oid, type: op.post.type, mode: op.post.mode };
      if (tupleEquals(actual, preTuple)) {
        await applyOp(ctx, op, rec.txId); // 实际==preimage → 应用该路径操作
      } else if (tupleEquals(actual, postTuple)) {
        // 实际==postimage → 该路径已完成（引擎半写不误判）
      } else {
        // 其他 → 用户新改动：保留内容、保留现场、转冲突（绝不静默覆盖）
        userEdited.push(op.path);
      }
    }
    if (userEdited.length > 0) {
      return { status: "conflicted", paths: userEdited, reason: "user-edits", intent: rec };
    }
    await advanceRef(ctx, rec); // 全部完成且无冲突 → CAS（oldRef→targetCommit）
    await markDone(ctx, rec, opts);
    await clearIntent(ctx.repoDir);
    return { status: "recovered", intent: rec };
  }

  // 其他 ref 值 → 冲突：停止、保留现场
  return { status: "conflicted", paths: [], reason: "ref-moved", intent: rec };
}

export { CrashInjection };
