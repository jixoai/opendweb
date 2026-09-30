// 对象同步端点（webui-plugin-kernel Phase 3 / design v2.3 §7.3——provider 侧
// handler，`/wpk1/sync/<groupId>/<rootId>/<op>`，无 git smart HTTP）。
// 意图（2026-09-29；r7-B3 闭合：取消线性化+组级并发预算+真实持久 staging）：
// 1. 四操作：GET refs（对端 refs 快照）/ POST want（期望 commit+已有 OID 排序
//    列表分页比对 → 缺失对象清单）/ GET object/<oid>（单松散对象：类型+长度+
//    OID 自证——EOF 不是完整性证据；>16MiB 拒绝 §4）/ POST push（ndjson 帧：
//    首行头 {ref, expectedOldRef, targetCommit}+逐对象行）。
// 2. push 闭包校验（r2-B7）：**parent+树+blob 全闭包**——staging 校验（每对象
//    sha1 类型+长度自证；>16MiB blob=引用该 blob 的整个 push 原子拒绝——部分
//    对象成功不构成合法实现；对象数>5000 预算拒绝）后走闭包遍历，缺任一引用
//    对象 → 整个 push 拒绝（明确缺项清单）且 **零 ref 变化**、store 零写入；
//    闭包全 → repo 互斥内 ref CAS（expectedOldRef 不匹配=拒绝+提示重
//    fetch/merge，无 last-write-wins）→ 对象入库 → ref 推进。
// 3. 单写者：每 repo 进程内互斥（引擎与本端点同进程——写路径唯一）；跨进程
//    由组账本锁+intent 协议兜底。
// 4. 授权 deny-by-default：peer endpointId ∉ 组 members → 403（sessionId 为
//    隔离键记录在日志——授权数据=组账本成员表，v1 形态）。
// 5. staging（r7-B3 真实持久语义）：每个通过校验和自证的对象**立即落真实
//    staging 文件**（`<gitdir>/staging/<pushId>/<oid>`，0600 原子写——内存只
//    留元数据）；闭包校验从 staging 读回复验 OID；导入=单写者临界区内逐对象
//    原子松散写（objects.importLooseObjectAtomic）——崩溃/取消后 staging 可
//    GC（finally 即时回收 + gcStaging TTL 兜底）、ref 不动、对象库无半写。
//    CrashInjection（kill 模拟）透传不清理 staging——留现场供 GC/恢复验收。
// 6. push 取消线性化（r7-B3，与 §7.3.1 intent 事务对齐）：读取器接受
//    AbortSignal 边读边检、中断即停（util.readBoundedJsonLines）；解析完成后
//    /进入 repo mutex 前/**提交线性化点**（临界区首句）三处裁决——线性化点前
//    取消 → 零 ref 变化+staging 回收；通过线性化点后 → 作为已接受提交完成
//    （200），绝不返回「取消但已推进」的模糊态（崩溃恢复路径=重试幂等
//    roll-forward，同 §7.3.1 三态恢复语义）。
// 7. 组级并发预算（§7.5 并发流 ≤2/组）：push 与 GET object 共享 streamsInFlight
//    在飞计数（push 每个 body 可达 256MiB 级——必须占预算），超限稳定 busy
//    429，finally 归还。
// 8. 请求体有界（§4）：读体边累计边判，超限立即拒绝（body-too-large →
//    状态 413）；push 帧行级+总长双上限、逐 chunk 流式（不整体入内存）。

import path from "node:path";
import { mkdir, rm, stat, readdir, readFile } from "node:fs/promises";
import { atomicWrite0600, fromBase64, jsonBody, readBoundedBody, readBoundedJsonLines, toBase64, CrashInjection } from "./util.mjs";
import {
  gitdirFor,
  loadLedger,
  findGroup,
} from "./ledger.mjs";
import { GROUP_REF, listRefsDirect, objectOid, readObject, walkClosure, writeRef, readRef, importLooseObjectAtomic } from "./objects.mjs";

/** 单 blob 上限（§4：sync 对象单传 16MiB；超限对象 v1 拒绝并提示） */
export const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
/** 单次同步对象数上限（§7.5 预算） */
export const MAX_OBJECTS_PER_SYNC = 5000;
/** 单次传输总字节上限（§7.5） */
export const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
/** 并发流上限/组（§7.5） */
export const MAX_STREAMS_PER_GROUP = 2;
/** push 请求体总上限（base64 膨胀 4/3+JSON 开销+余量） */
export const MAX_PUSH_BODY_BYTES = Math.ceil((MAX_TRANSFER_BYTES * 4) / 3) + 1024 * 1024;
/** want/其他 JSON 体上限（have 列表分页 ≤1000 OID×65B） */
export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
/** want have 分页建议值（客户端分页基准——v1 排序 OID 列表分页比对） */
export const WANT_HAVE_PAGE = 1000;
/** staging TTL（显式中止/断开后回收窗口——GC 扫描参数，可注入 now） */
export const STAGING_TTL_MS = 10 * 60 * 1000;

/** @type {Record<string, number>} op→HTTP 状态的稳定映射（错误码即协议） */
const ERROR_STATUS = { unauthorized: 403, "not-found": 404, "bad-request": 400, aborted: 400, "body-too-large": 413, "line-too-large": 413, oversize: 413, budget: 429, busy: 429, "cas-mismatch": 409, "closure-missing": 409, integrity: 422, internal: 500 };

/**
 * 创建对象同步端点 handler（provider 侧——宿主 serveHttp 的 /wpk1/sync/* 分派
 * 目标；测试以内存 loopback 直调）。
 * @param {{ home: string, now?: () => number, log?: { debug?: (m: string) => void, info?: (m: string) => void, warn?: (m: string) => void, error?: (m: string) => void }, repoMutexFor?: (gitdir: string) => { run: (label: string, fn: () => Promise<unknown>) => Promise<unknown> }, crashAt?: (stage: string) => void }} opts
 *   crashAt：测试崩溃注入钩子（intent.mjs 同款 kill 模拟语义）——stage ∈
 *   {push:staged（全部对象已落 staging+闭包已过、临界区前）, push:imported
 *   （对象已原子入库、writeRef 前）}；抛 CrashInjection=模拟 kill：staging
 *   现场**不清理**（留待 TTL GC/恢复验收）。
 * @returns {(request: { method: string, path: string, body?: Uint8Array | AsyncIterable<Uint8Array> | null, sessionId?: string, peerEndpointId?: string, signal?: AbortSignal }) => Promise<{ status: number, body: Uint8Array }>}
 */
export function createSyncEndpointHandler(opts) {
  const { home } = opts;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? {};
  /** @type {Map<string, number>} 组级在飞流计数（push+GET object 共享；并发流 ≤2/组） */
  const streamsInFlight = new Map();

  /**
   * @param {string} code
   * @param {Record<string, unknown>} [extra]
   */
  const fail = (code, extra = {}) => ({ status: ERROR_STATUS[code] ?? 500, body: jsonBody({ ok: false, code, ...extra }) });

  return async function handle(request) {
    // 路径解析：/wpk1/sync/<groupId>/<rootId>/<op>[/rest...]
    const m = /^\/wpk1\/sync\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\/([a-z]+)(\/.*)?$/.exec(request.path);
    if (m === null) return fail("not-found", { path: request.path });
    const [, groupId, rootId, op, rest] = m;
    try {
      const ledger = await loadLedger(home);
      const group = findGroup(ledger, groupId);
      if (group === null) return fail("not-found", { groupId });
      if (group.roots.every((r) => r.id !== rootId)) return fail("not-found", { groupId, rootId });
      // 授权 deny-by-default：peer 必须是组内成员（会话密码学身份之外的组级门）
      if (request.peerEndpointId === undefined || !group.members.some((mm) => mm.endpointId === request.peerEndpointId)) {
        log.warn?.(`sync endpoint: denied ${request.method} ${request.path} (peer ${request.peerEndpointId ?? "unknown"} not a member; session ${request.sessionId ?? "?"})`);
        return fail("unauthorized", { groupId });
      }
      const gitdir = gitdirFor(home, groupId, rootId);
      const repoMutex = opts.repoMutexFor?.(gitdir) ?? null;

      if (op === "refs" && request.method === "GET") {
        const refs = await listRefsDirect(gitdir);
        return { status: 200, body: jsonBody({ ok: true, refs }) };
      }

      if (op === "want" && request.method === "POST") {
        const raw = await readBoundedBody(request.body, MAX_JSON_BODY_BYTES);
        let req;
        try {
          req = JSON.parse(Buffer.from(raw).toString("utf8") || "{}");
        } catch {
          return fail("bad-request", { detail: "want body must be JSON" });
        }
        const commit = typeof req.commit === "string" ? req.commit : null;
        const have = Array.isArray(req.have) ? req.have.filter((h) => typeof h === "string" && /^[0-9a-f]{40}$/.test(h)) : [];
        if (commit === null || !/^[0-9a-f]{40}$/.test(commit)) return fail("bad-request", { detail: "want.commit must be a 40-hex oid" });
        try {
          const closure = await walkClosure(commit, async (oid) => {
            try {
              return await readObject(gitdir, oid);
            } catch {
              return null;
            }
          });
          // 服务端缺对象（自身闭包不全）→ 内部错误如实暴露（不静默空清单）
          const haveSet = new Set(have);
          const missing = closure.filter((o) => !haveSet.has(o.oid));
          return { status: 200, body: jsonBody({ ok: true, missing, closureSize: closure.length }) };
        } catch (e) {
          if (/** @type {{code?:string}} */ (e)?.code === "missing") return fail("internal", { detail: "server object store missing closure", missing: e.missing });
          throw e;
        }
      }

      if (op === "object" && request.method === "GET") {
        const oid = (rest ?? "").replace(/^\//, "");
        if (!/^[0-9a-f]{40}$/.test(oid)) return fail("bad-request", { detail: "object oid must be 40-hex" });
        let obj;
        try {
          obj = await readObject(gitdir, oid);
        } catch {
          return fail("not-found", { oid });
        }
        if (obj.bytes.byteLength > MAX_OBJECT_BYTES) {
          return fail("oversize", { oid, size: obj.bytes.byteLength, limit: MAX_OBJECT_BYTES, hint: "object exceeds the 16MiB per-blob limit; split or exclude it (per-file skip is a filtered-tree feature, not v1)" });
        }
        // 并发流 ≤2/组：在飞计数（finally 归还）
        const inflight = streamsInFlight.get(groupId) ?? 0;
        if (inflight >= MAX_STREAMS_PER_GROUP) return fail("busy", { groupId, limit: MAX_STREAMS_PER_GROUP });
        streamsInFlight.set(groupId, inflight + 1);
        try {
          // OID 自证：读出后重算（防错档文件/半写对象）
          const computed = objectOid(obj.type, obj.bytes);
          if (computed !== oid) return fail("integrity", { oid, computed });
          return { status: 200, body: jsonBody({ ok: true, oid, type: obj.type, length: obj.bytes.byteLength, contentBase64: toBase64(obj.bytes) }) };
        } finally {
          streamsInFlight.set(groupId, Math.max(0, (streamsInFlight.get(groupId) ?? 1) - 1));
        }
      }

      if (op === "push" && request.method === "POST") {
        return await handlePush({ request, gitdir, groupId, rootId, repoMutex, group });
      }

      return fail("not-found", { op, method: request.method });
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && typeof (/** @type {{code:unknown}} */ (e).code) === "string" && (/** @type {string} */ (e.code) in ERROR_STATUS)) {
        return fail(/** @type {string} */ (e.code), e);
      }
      log.error?.(`sync endpoint internal error on ${request.path}: ${/** @type {Error} */ (e)?.stack ?? e}`);
      return fail("internal", { detail: String(/** @type {Error} */ (e)?.message ?? e) });
    }
  };

  /**
   * push 处理（r7-B3 闭合：流式解析 → 真实 staging 落盘 → 闭包 → 临界区 CAS
   * +原子导入 → 推进）。取消线性化与组级预算见文件头注 6/7。
   * @param {{ request: { method: string, path: string, body?: Uint8Array | AsyncIterable<Uint8Array> | null, signal?: AbortSignal }, gitdir: string, groupId: string, rootId: string, repoMutex: { run: (label: string, fn: () => Promise<unknown>) => Promise<unknown> } | null, group: import("./ledger.mjs").SyncGroup }} args
   */
  async function handlePush(args) {
    const { request, gitdir, repoMutex, group } = args;
    // ---- 组级流预算（r7-B3：push 与 GET object 同池；超限稳定 429；finally 归还） ----
    const inflight = streamsInFlight.get(args.groupId) ?? 0;
    if (inflight >= MAX_STREAMS_PER_GROUP) return fail("busy", { groupId: args.groupId, limit: MAX_STREAMS_PER_GROUP });
    streamsInFlight.set(args.groupId, inflight + 1);
    let budgetReleased = false;
    const releaseBudget = () => {
      if (budgetReleased) return;
      budgetReleased = true;
      streamsInFlight.set(args.groupId, Math.max(0, (streamsInFlight.get(args.groupId) ?? 1) - 1));
    };
    const stagingRoot = path.join(gitdir, "staging");
    const pushId = `push-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stagingDir = path.join(stagingRoot, pushId);
    const cleanup = () => rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    /** kill 模拟（CrashInjection）透传时保留 staging 现场——TTL GC/恢复验收用 */
    let killed = false;
    try {
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      const stagingFile = (/** @type {string} */ oid) => path.join(stagingDir, oid);
      // ---- 帧解析（ndjson 流式：首行头+对象行；AbortSignal 边读边检、中断即停） ----
      // 每个对象行通过校验和自证（长度+类型+OID；blob>16MiB 整 push 拒绝）后
      // **立即落真实 staging 文件**（0600 原子写）——内存只留元数据（r7-B3）。
      let header = null;
      /** @type {Array<{ oid: string, type: string, length: number }>} */
      const objects = [];
      for await (const line of readBoundedJsonLines(request.body, { maxTotal: MAX_PUSH_BODY_BYTES, signal: request.signal })) {
        if (header === null) {
          header = /** @type {{ ref?: string, expectedOldRef?: string | null, targetCommit?: string }} */ (line);
          if (typeof header.ref !== "string" || typeof header.targetCommit !== "string" || !("expectedOldRef" in header)) {
            return fail("bad-request", { detail: "push header must be {ref, expectedOldRef, targetCommit}" });
          }
          continue;
        }
        const rec = /** @type {{ oid?: string, type?: string, length?: number, contentBase64?: string }} */ (line);
        if (typeof rec.oid !== "string" || typeof rec.type !== "string" || typeof rec.length !== "number" || typeof rec.contentBase64 !== "string") {
          return fail("bad-request", { detail: "object line must be {oid, type, length, contentBase64}" });
        }
        const bytes = fromBase64(rec.contentBase64);
        // staging 完整性自证（类型+长度+OID——EOF/声明均非证据）
        if (bytes.byteLength !== rec.length) return fail("integrity", { oid: rec.oid, declared: rec.length, actual: bytes.byteLength });
        if (rec.type !== "blob" && rec.type !== "tree" && rec.type !== "commit") return fail("bad-request", { detail: `object type invalid: ${rec.type}` });
        const computed = objectOid(rec.type, bytes);
        if (computed !== rec.oid) return fail("integrity", { oid: rec.oid, computed });
        // >16MiB blob：引用该 blob 的整个 push 原子拒绝（客户端按闭包整集上传，
        // 服务端对集内任一超限对象拒绝整个 push——ref/工作树零变化）
        if (rec.type === "blob" && bytes.byteLength > MAX_OBJECT_BYTES) {
          return fail("oversize", { oid: rec.oid, size: bytes.byteLength, limit: MAX_OBJECT_BYTES, hint: "the push referencing this blob is rejected as a whole; split the file or keep it out of the synced root (per-file skip = filtered-tree semantics, not v1)" });
        }
        await atomicWrite0600(stagingFile(rec.oid), bytes);
        objects.push({ oid: rec.oid, type: rec.type, length: rec.length });
        if (objects.length > MAX_OBJECTS_PER_SYNC) {
          return fail("budget", { count: objects.length, limit: MAX_OBJECTS_PER_SYNC, hint: "too many objects in one push; sync in smaller batches (smaller history increments)" });
        }
      }
      // 取消裁决 #1（r7-B3）：解析完成后——任何落库动作前
      if (request.signal?.aborted) return fail("aborted", { stage: "parsed" });
      if (header === null) return fail("bad-request", { detail: "empty push body" });
      // ref 目标白名单：组收敛 ref 或本组成员的 device ref（deny-by-default）
      if (header.ref !== GROUP_REF) {
        const dev = /^refs\/devices\/([0-9a-f]{8,64})\/main$/.exec(header.ref ?? "");
        if (dev === null || !group.members.some((mm) => mm.endpointId === dev[1])) {
          return fail("bad-request", { detail: `push target ref not allowed: ${header.ref}` });
        }
      }
      // 闭包校验（staged 真源=staging 文件，读回复验 OID ∪ store）
      const staged = new Map(objects.map((o) => [o.oid, o.type]));
      const resolver = async (/** @type {string} */ oid) => {
        const type = staged.get(oid);
        if (type !== undefined) {
          const bytes = new Uint8Array(await readFile(stagingFile(oid)));
          const computed = objectOid(type, bytes);
          if (computed !== oid) throw { code: "integrity", oid, computed, detail: "staging readback mismatch" };
          return { type, bytes };
        }
        try {
          return await readObject(gitdir, oid);
        } catch {
          return null;
        }
      };
      try {
        await walkClosure(header.targetCommit, resolver);
      } catch (e) {
        if (/** @type {{code?:string}} */ (e)?.code === "missing") {
          return fail("closure-missing", { missing: e.missing, hint: "push rejected as a whole: supply the full parent/tree/blob closure; ref is unchanged" });
        }
        throw e;
      }
      // 取消裁决 #2（r7-B3）：进入 repo mutex 前
      if (request.signal?.aborted) return fail("aborted", { stage: "pre-commit" });
      opts.crashAt?.("push:staged");
      // ---- 提交线性化点（repo 互斥内——单写者；ref 零变化直到全对象入库） ----
      const work = async () => {
        // 取消裁决 #3（r7-B3）：线性化点首句——通过后本 push 作为已接受提交
        // 完成（其后的 abort 不再回滚，返回 200——绝不出现「取消但已推进」）
        if (request.signal?.aborted) return fail("aborted", { stage: "commit-point" });
        const current = await readRef(gitdir, header.ref);
        if (current !== (header.expectedOldRef ?? null)) {
          return fail("cas-mismatch", { ref: header.ref, expectedOldRef: header.expectedOldRef ?? null, currentRef: current, hint: "peer advanced the ref; re-fetch and merge, then push again (no last-write-wins)" });
        }
        for (const meta of objects) {
          const bytes = new Uint8Array(await readFile(stagingFile(meta.oid)));
          const computed = objectOid(meta.type, bytes);
          if (computed !== meta.oid) return fail("integrity", { oid: meta.oid, computed, detail: "staging readback mismatch" });
          // 原子导入（O_EXCL tmp+fsync+rename——崩溃无半写；已存在幂等跳过）
          await importLooseObjectAtomic(gitdir, meta.type, bytes, meta.oid);
        }
        opts.crashAt?.("push:imported");
        await writeRef(gitdir, header.ref, header.targetCommit);
        return { status: 200, body: jsonBody({ ok: true, ref: header.ref, oid: header.targetCommit, imported: objects.length }) };
      };
      return await (repoMutex !== null ? repoMutex.run("push", work) : work());
    } catch (e) {
      if (e instanceof CrashInjection) killed = true; // kill 模拟：保留 staging 现场
      throw e;
    } finally {
      releaseBudget();
      if (!killed) await cleanup();
    }
  }
}

/**
 * staging TTL 回收（启动扫描+显式调用；测试注入 now）。
 * @param {string} gitdir
 * @param {{ now?: () => number, ttlMs?: number }} [opts]
 * @returns {Promise<string[]>} 回收的 staging 目录名
 */
export async function gcStaging(gitdir, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? STAGING_TTL_MS;
  const root = path.join(gitdir, "staging");
  /** @type {string[]} */
  const removed = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const abs = path.join(root, ent.name);
    const st = await stat(abs).catch(() => null);
    if (st !== null && now() - st.mtimeMs > ttlMs) {
      await rm(abs, { recursive: true, force: true }).catch(() => {});
      removed.push(ent.name);
    }
  }
  return removed;
}
