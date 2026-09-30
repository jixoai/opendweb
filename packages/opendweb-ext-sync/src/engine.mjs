// 同步引擎（webui-plugin-kernel Phase 3 / design v2.3 §7——编排自持）。
// 意图（2026-09-29）：
// 1. 任务状态机（§7.5）：idle→scanning→fetching→merging→(conflicted)→pushing→
//    done|error——单 root 单任务；UI 状态页经 runtime 投影消费。
// 2. 双向流程：scanning（工作树→device ref 提交——「物化前本地改动 MUST 已被
//    commit」）→ fetching（GET refs+want 分页+GET object，fetch-staging 暂存，
//    全量校验后入库；预算强制：≤5000 对象/≤256MiB/≤2 流）→ merging（自持
//    三方树合并；fast-forward 或 merge commit）→ pushing（闭包整集 push +
//    expectedOldRef CAS；cas-mismatch→重取收敛一轮）。
// 3. 单向流程（oneway=只读镜像）：不提交本地改动（不回传）；fetch+fast-forward
//    跟随；对端组 ref 非前推 → mirror-diverged 明示。
// 4. 工作树物化+组 ref 推进一律经 intent 事务（§7.3.1）；扫描后新改动由路径
//    分诊第三态承接（保留+conflicted）。
// 5. [W9] seed authority：权威端整树基线提交；对端首拉前工作树非空 → 阻断+
//    三方对照（不自动合并不覆盖）；显式 adopt-seed 后经 intent 事务物化。
// 6. 单写者：每 repo 进程内互斥（与端点共享——gitdir 键）。

import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { atomicWrite0600, fromBase64, toBase64 } from "./util.mjs";
import {
  findGroup,
  gitdirFor,
  loadLedger,
  repoDir,
} from "./ledger.mjs";
import {
  GROUP_REF,
  deviceRef,
  listRefsDirect,
  mergeBase,
  objectOid,
  readCommitParsed,
  readFlatTree,
  readObject,
  readRef,
  walkClosure,
  writeCommitOid,
  writeObject,
  writeRef,
  writeTreeFromFlat,
} from "./objects.mjs";
import { scanToFlatEntries, scanWorktree, pathStateTuple } from "./worktree.mjs";
import { executeIntent, readPendingIntent, recoverIntent } from "./intent.mjs";
import { applyHunkDecisions, conflictRecordId, consultMergeDrivers, diff3TextMerge, DIFF3_ALGO_VERSION, mergeTrees } from "./merge.mjs";
import { gcStaging, MAX_OBJECTS_PER_SYNC, MAX_STREAMS_PER_GROUP, MAX_TRANSFER_BYTES, WANT_HAVE_PAGE } from "./endpoint.mjs";

/** fetch 暂存目录（repoDir 下——与端点服务端 staging 分立；TTL 回收共用纪律） */
export const FETCH_STAGING = "fetch-staging";
/** 冲突会话文件（merge 快照+决议——两端可复现的持久化记录） */
export const CONFLICT_SESSION = "conflict-session.json";
/** seed 阻断记录 */
export const SEED_BLOCK = "seed-block.json";

/**
 * @param {string} endpointId
 * @returns {string} 缩写（author 身份与消息用）
 */
export function endpointAbbrev(endpointId) {
  return endpointId.slice(0, 8);
}

/**
 * 创建同步引擎。
 * @param {{ home: string, endpointId: string, deviceName: string, now?: () => number, fetchImpl: (session: unknown, req: { method: string, path: string, body?: Uint8Array | null, signal?: AbortSignal }) => Promise<{ status: number, body: Uint8Array }>, sessionResolver: (peerEndpointId: string) => unknown, log?: { debug?: (m: string) => void, info?: (m: string) => void, warn?: (m: string) => void, error?: (m: string) => void }, repoMutexFor: (gitdir: string) => { run: (label: string, fn: () => Promise<T>) => Promise<T> } }} opts
 * @template T
 */
export function createSyncEngine(opts) {
  const { home, endpointId, deviceName, fetchImpl, sessionResolver } = opts;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? {};
  const repoMutexFor = opts.repoMutexFor;

  /** @type {Map<string, { phase: string, error: null | { code: string, message: string, hint?: string }, progress: { fetched: number, fetchTotal: number, bytes: number }, updatedAt: number, runs: number }>} */
  const jobs = new Map();
  /** @type {Set<string>} 运行中互斥（同 root 重入拒绝——单任务串行） */
  const running = new Set();

  const jobKey = (groupId, rootId) => `${groupId}/${rootId}`;

  /**
   * @param {string} groupId
   * @param {string} rootId
   * @param {Partial<{ phase: string, error: null | { code: string, message: string, hint?: string }, progress: { fetched: number, fetchTotal: number, bytes: number } }>} patch
   */
  function setJob(groupId, rootId, patch) {
    const key = jobKey(groupId, rootId);
    const cur = jobs.get(key) ?? { phase: "idle", error: null, progress: { fetched: 0, fetchTotal: 0, bytes: 0 }, updatedAt: now(), runs: 0 };
    jobs.set(key, { ...cur, ...patch, updatedAt: now() });
  }

  /** 组内对端 endpointId（v1 pairwise：单对端——多成员组取首个非自身成员） */
  function peerOf(group) {
    const m = group.members.find((x) => x.endpointId !== endpointId);
    return m === undefined ? null : m.endpointId;
  }

  /** repo 上下文。 */
  function ctxFor(group, root) {
    return { group, root, groupId: group.id, rootId: root.id, repoDir: path.join(repoDir(home, group.id, root.id)), gitdir: gitdirFor(home, group.id, root.id), rootPath: root.localPath };
  }

  /**
   * 对端调用（sessionResolver→fetchImpl→JSON 解析）。
   * sessionResolver 可能异步（真实宿主 fabric.sessionResolver 返回 Promise；
   * 测试 loopback 返回普通对象）——统一 await 归一（真双机验收 F4：不 await
   * 时 fetchImpl 收到 Promise，报 session.fetchHttp is not a function）。
   * @param {string} peerEndpointId
   */
  function callPeer(peerEndpointId) {
    const sessionP = Promise.resolve(sessionResolver(peerEndpointId));
    /**
     * @param {string} p
     * @param {{ method?: string, body?: unknown, signal?: AbortSignal, rawBody?: Uint8Array }} [init]
     */
    return async (p, init = {}) => {
      const session = await sessionP;
      const body = init.rawBody ?? (init.body === undefined ? null : new Uint8Array(Buffer.from(JSON.stringify(init.body), "utf8")));
      const resp = await fetchImpl(session, { method: init.method ?? "GET", path: p, body, signal: init.signal });
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.from(resp.body).toString("utf8"));
      } catch {
        /* 非 JSON（不期待）——保留 null */
      }
      return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, body: parsed };
    };
  }

  /** 本地 loose 对象清单（have 集真源——want 分页比对）。 @param {string} gitdir */
  async function localOids(gitdir) {
    /** @type {string[]} */
    const out = [];
    const objs = path.join(gitdir, "objects");
    let buckets;
    try {
      buckets = await readdir(objs);
    } catch {
      return out;
    }
    for (const b of buckets) {
      if (!/^[0-9a-f]{2}$/.test(b)) continue;
      let names;
      try {
        names = await readdir(path.join(objs, b));
      } catch {
        continue;
      }
      for (const n of names) if (/^[0-9a-f]{38}$/.test(n)) out.push(b + n);
    }
    out.sort();
    return out;
  }

  /**
   * commitLocal：扫描→device ref 提交（scanning 阶段——本地改动先入 device ref）。
   * @param {{ repoDir: string, gitdir: string, rootPath: string, groupId: string, rootId: string, group: import("./ledger.mjs").SyncGroup, root: import("./ledger.mjs").SyncRoot }} ctx
   */
  async function commitLocal(ctx) {
    const mutex = repoMutexFor(ctx.gitdir);
    return mutex.run("commit-local", async () => {
      const devRef = deviceRef(endpointId);
      const head = await readRef(ctx.gitdir, devRef);
      const entries = await scanWorktree(ctx.rootPath, ctx.gitdir);
      const flat = scanToFlatEntries(entries);
      const headTree = head === null ? null : (await readCommitParsed(ctx.gitdir, head)).tree;
      const treeOid = await writeTreeFromFlat(ctx.gitdir, flat.map((e) => ({ path: e.path, oid: e.oid, mode: /** @type {"100644" | "100755"} */ (e.mode) })));
      if (treeOid === headTree) return { head, tree: treeOid, changed: false, flat };
      const commit = await writeCommitOid(ctx.gitdir, {
        message: `sync: local changes on ${deviceName} (${endpointAbbrev(endpointId)})`,
        tree: treeOid,
        parent: head === null ? [] : [head],
        authorName: `${endpointAbbrev(endpointId)} ${deviceName}`,
        authorEmail: `${endpointAbbrev(endpointId)}@device.sync`,
        timestamp: now(),
      });
      const current = await readRef(ctx.gitdir, devRef);
      if (current !== head) throw { code: "cas-mismatch", ref: devRef, expectedOldRef: head, currentRef: current };
      await writeRef(ctx.gitdir, devRef, commit);
      log.info?.(`sync ${ctx.groupId}/${ctx.rootId}: committed local changes ${commit.slice(0, 8)}`);
      return { head: commit, tree: treeOid, changed: true, flat };
    });
  }

  /**
   * fetchFromPeer：GET refs→want 分页→GET object（fetch-staging→全量校验→入库）。
   * 预算强制（明示拒绝）；AbortSignal 取消=零 ref 变化（staging 弃置/TTL 回收）。
   * @param {ReturnType<typeof ctxFor>} ctx
   * @param {string} peer
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ refs: Record<string, string>, imported: number, bytes: number }>}
   */
  async function fetchFromPeer(ctx, peer, opts = {}) {
    const call = callPeer(peer);
    const wire = `/wpk1/sync/${ctx.groupId}/${ctx.rootId}`;
    const refsResp = await call(`${wire}/refs`);
    if (!refsResp.ok || refsResp.body?.ok !== true) throw httpError("fetch-refs", refsResp);
    const peerRefs = /** @type {Record<string, string>} */ (refsResp.body.refs);
    // 目标：组 ref + 对端 device ref（v1 pairwise 单对端；多成员 refs 全量镜像留后续）
    const targets = [GROUP_REF, deviceRef(peer)];
    const have = await localOids(ctx.gitdir);
    /**
     * want 分页比对（v1 排序 OID 列表分页协议）：单页响应 R_i = closure−page_i，
     * 故真缺失 = ∩ R_i（某对象在任一 have 页中出现即从该页响应缺席）。
     * @param {string} commit
     * @returns {Promise<Set<string>>}
     */
    const wantClosure = async (commit) => {
      /** @type {Set<string> | null} */
      let missing = null;
      for (let i = 0; i < have.length || i === 0; i += WANT_HAVE_PAGE) {
        const page = have.slice(i, i + WANT_HAVE_PAGE);
        const resp = await call(`${wire}/want`, { method: "POST", body: { commit, have: page }, signal: opts.signal });
        if (!resp.ok || resp.body?.ok !== true) throw httpError("fetch-want", resp);
        const r = new Set((resp.body.missing ?? []).map((/** @type {{ oid: string }} */ m) => m.oid));
        missing = missing === null ? r : new Set([...missing].filter((oid) => r.has(oid)));
        if (i + WANT_HAVE_PAGE >= have.length) break;
      }
      return missing ?? new Set();
    };
    /** @type {Set<string>} */
    const missing = new Set();
    for (const ref of targets) {
      const commit = peerRefs[ref];
      if (commit === undefined || commit === null) continue;
      const local = await readRef(ctx.gitdir, ref);
      if (local === commit) continue;
      for (const oid of await wantClosure(commit)) missing.add(oid);
    }
    if (missing.size === 0) return { refs: peerRefs, imported: 0, bytes: 0 };
    if (missing.size > MAX_OBJECTS_PER_SYNC) {
      throw { code: "budget", message: `sync needs ${missing.size} objects (limit ${MAX_OBJECTS_PER_SYNC} per run)`, hint: "reduce the history increment or sync a smaller root; batching is a later version" };
    }
    // fetch-staging（取消/失败不碰对象库；TTL 回收兜底）
    const fetchId = `fetch-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const staging = path.join(ctx.repoDir, FETCH_STAGING, fetchId);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    setJob(ctx.groupId, ctx.rootId, { progress: { fetched: 0, fetchTotal: missing.size, bytes: 0 } });
    let bytes = 0;
    /** oid → type（GET object 响应携带——staged 副本入库判型真源） */
    const typeOf = new Map();
    try {
      // 并发 ≤2（§7.5 流预算）；busy（对端组级流上限）短重试
      const queue = [...missing];
      const workers = Array.from({ length: Math.min(MAX_STREAMS_PER_GROUP, queue.length) }, async () => {
        for (;;) {
          if (opts.signal?.aborted) throw { code: "aborted", message: "sync aborted" };
          const oid = queue.shift();
          if (oid === undefined) return;
          let resp = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            resp = await call(`${wire}/object/${oid}`, { signal: opts.signal });
            if (resp.body?.code !== "busy") break;
            await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          }
          if (resp === null || !resp.ok || resp.body?.ok !== true) throw httpError("fetch-object", resp, { oid });
          const { type, length, contentBase64 } = resp.body;
          const raw = fromBase64(contentBase64);
          if (raw.byteLength !== length || objectOid(type, raw) !== oid) {
            throw { code: "integrity", message: `object ${oid} failed type+length+oid verification (EOF is not evidence)` };
          }
          bytes += raw.byteLength;
          if (bytes > MAX_TRANSFER_BYTES) {
            throw { code: "budget", message: `transfer exceeded ${MAX_TRANSFER_BYTES} bytes`, hint: "sync a smaller root or reduce history" };
          }
          await import("node:fs/promises").then((m) => m.writeFile(path.join(staging, oid), raw, { mode: 0o600 }));
          typeOf.set(oid, type);
          const job = jobs.get(jobKey(ctx.groupId, ctx.rootId));
          if (job !== undefined) setJob(ctx.groupId, ctx.rootId, { progress: { ...job.progress, fetched: (job.progress.fetched ?? 0) + 1, bytes } });
        }
      });
      await Promise.all(workers);
      // 全量校验通过后入库+镜像 ref（中途取消零 ref 变化——组 ref 推进只经 intent）
      for (const oid of [...missing].sort()) {
        const raw = await import("node:fs/promises").then((m) => m.readFile(path.join(staging, oid)));
        await writeObject(ctx.gitdir, /** @type {string} */ (typeOf.get(oid)), new Uint8Array(raw));
      }
      const peerDevRef = deviceRef(peer);
      for (const ref of targets) {
        const commit = peerRefs[ref];
        if (commit !== undefined && commit !== null && ref === peerDevRef) {
          const local = await readRef(ctx.gitdir, ref);
          if (local !== commit) await writeRef(ctx.gitdir, ref, commit); // 对端 device ref=镜像元数据 ref
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await gcStaging(path.join(ctx.repoDir, FETCH_STAGING), { now }).catch(() => {});
    }
    return { refs: peerRefs, imported: missing.size, bytes };
  }

  /**
   * push 到对端（闭包整集；expectedOldRef CAS；cas → 上层重取）。
   * @param {ReturnType<typeof ctxFor>} ctx
   * @param {string} peer
   * @param {Record<string, string>} peerRefs 快照（expectedOldRef 来源）
   * @param {Array<{ ref: string, oid: string }>} targets
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async function pushToPeer(ctx, peer, peerRefs, targets, opts = {}) {
    const call = callPeer(peer); // callPeer 支持 init.rawBody（ndjson push 帧直传）
    const wire = `/wpk1/sync/${ctx.groupId}/${ctx.rootId}`;
    for (const { ref, oid } of targets) {
      if (peerRefs[ref] === oid) continue;
      const closure = await walkClosure(oid, async (o) => {
        try {
          return await readObject(ctx.gitdir, o);
        } catch {
          return null;
        }
      });
      if (closure.length > MAX_OBJECTS_PER_SYNC) {
        throw { code: "budget", message: `push closure is ${closure.length} objects (limit ${MAX_OBJECTS_PER_SYNC})`, hint: "reduce the history increment" };
      }
      let bytes = 0;
      /** @type {Buffer[]} */
      const lines = [Buffer.from(`${JSON.stringify({ ref, expectedOldRef: peerRefs[ref] ?? null, targetCommit: oid })}\n`)];
      for (const o of closure) {
        const { type, bytes: raw } = await readObject(ctx.gitdir, o.oid);
        bytes += raw.byteLength;
        if (bytes > MAX_TRANSFER_BYTES) throw { code: "budget", message: `push exceeded ${MAX_TRANSFER_BYTES} bytes`, hint: "sync a smaller root" };
        lines.push(Buffer.from(`${JSON.stringify({ oid: o.oid, type, length: raw.byteLength, contentBase64: toBase64(raw) })}\n`));
      }
      const body = new Uint8Array(Buffer.concat(lines));
      const resp = await call(`${wire}/push`, { method: "POST", rawBody: body, signal: opts.signal });
      if (!resp.ok) {
        if (resp.body?.code === "cas-mismatch") throw { code: "push-cas", message: `peer ref ${ref} advanced (expected ${peerRefs[ref] ?? null}, now ${resp.body.currentRef})`, hint: "re-fetch and merge, then push again (no last-write-wins)" };
        throw httpError("push", resp, { ref });
      }
      log.info?.(`sync ${ctx.groupId}/${ctx.rootId}: pushed ${ref} -> ${oid.slice(0, 8)} (${closure.length} objects)`);
    }
  }

  /** @param {string} what @param {{ status: number, ok: boolean, body: any }} resp @param {Record<string, unknown>} [extra] */
  function httpError(what, resp, extra = {}) {
    return { code: `http-${resp.status}`, message: `${what} failed (${resp.status})`, detail: resp.body, ...extra };
  }

  /** ours/merged 扁平差 → intent ops（pre=实际工作树元组——扫描后新改动第三态承接）。 */
  /**
   * @param {ReturnType<typeof ctxFor>} ctx
   * @param {Map<string, { oid: string, mode: string, type: "blob" | "tree" }>} oursFlat
   * @param {Map<string, { oid: string, mode: string }>} mergedFlat
   * @param {Array<{ path: string, oid: string, mode: string }>} mergedEntries
   */
  async function buildMaterializeOps(ctx, oursFlat, mergedEntries) {
    const mergedMap = new Map(mergedEntries.map((e) => [e.path, { oid: e.oid, mode: e.mode }]));
    const paths = new Set([...oursFlat.keys(), ...mergedMap.keys()]);
    /** @type {Array<{ op: "write" | "delete", path: string, pre: { oid: string | null, type: "blob" | "tree" | null, mode: number | null } | null, post: { oid: string | null, type: "blob" | "tree" | null, mode: number | null } | null }>} */
    const ops = [];
    for (const p of paths) {
      if (oursFlat.get(p) === undefined && !mergedMap.has(p)) continue;
      const inOurs = oursFlat.get(p);
      const inMerged = mergedMap.get(p);
      const same = inOurs !== undefined && inMerged !== undefined && inOurs.type === "blob" && inOurs.oid === inMerged.oid && inOurs.mode === inMerged.mode;
      if (same) continue;
      const pre = await pathStateTuple(ctx.rootPath, p, ctx.gitdir); // 实际状态（非树账面——r4-N2 第三态）
      if (inMerged === undefined) {
        ops.push({ op: "delete", path: p, pre, post: null });
      } else {
        ops.push({ op: "write", path: p, pre, post: { oid: inMerged.oid, type: "blob", mode: modeNum(inMerged.mode) } });
      }
    }
    return ops;
  }

  /** @param {{ oid: string, mode: string, type: "blob" | "tree" } | undefined} e */
  function tupleOf(e) {
    return e === undefined ? undefined : { oid: e.oid, type: e.type, mode: modeNum(e.mode) };
  }

  /** @param {string} m */
  function modeNum(m) {
    return m === "100755" ? 0o100755 : 0o100644;
  }

  /**
   * 单 root 全周期（对外入口——runtime/scheduler 调用）。
   * @param {string} groupId
   * @param {string} rootId
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async function runRoot(groupId, rootId, opts = {}) {
    const key = jobKey(groupId, rootId);
    if (running.has(key)) return { ok: false, code: "busy" };
    running.add(key);
    try {
      const ledger = await loadLedger(home);
      const group = findGroup(ledger, groupId);
      if (group === null) return { ok: false, code: "unknown-group" };
      const root = group.roots.find((r) => r.id === rootId);
      if (root === undefined) return { ok: false, code: "unknown-root" };
      const ctx = ctxFor(group, root);
      const peer = peerOf(group);
      setJob(groupId, rootId, { phase: "scanning", error: null, progress: { fetched: 0, fetchTotal: 0, bytes: 0 } });
      try {
        // 恢复优先：未完成 intent → 分诊（conflicted 则本轮到此为止）
        const rec = await recoverIfNeeded(ctx);
        if (rec !== null) {
          setJob(groupId, rootId, { phase: "conflicted", error: { code: rec.reason === "user-edits" ? "user-edits" : rec.reason, message: `recovery left the repo conflicted (${rec.reason}): ${ (rec.paths ?? []).join(", ") }`, hint: "resolve via the conflicts page" } });
          return { ok: true, phase: "conflicted", reason: rec.reason };
        }
        if (peer === null) {
          setJob(groupId, rootId, { phase: "done", error: null });
          return { ok: true, phase: "done", note: "single-member group: nothing to sync" };
        }
        if (root.mode === "oneway") {
          return await runOneway(ctx, peer, opts);
        }
        // twoway：CAS 重试一轮（后到者拒绝→重取→再合并）
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await runTwoway(ctx, peer, opts);
          } catch (e) {
            if (/** @type {{code?:string}} */ (e)?.code === "push-cas" && attempt === 0) {
              log.warn?.(`sync ${key}: push CAS rejected — refetching and merging once more`);
              lastError = e;
              continue;
            }
            throw e;
          }
        }
        throw lastError ?? new Error("unreachable");
      } catch (e) {
        const err = /** @type {{ code?: string, message?: string, hint?: string }} */ (e);
        setJob(groupId, rootId, { phase: "error", error: { code: err.code ?? "error", message: err.message ?? String(e), hint: err.hint, detail: err.detail } });
        log.warn?.(`sync ${key}: ${err.code ?? "error"} — ${err.message ?? e}`);
        return { ok: false, code: err.code ?? "error", error: err };
      }
    } finally {
      running.delete(key);
    }
  }

  /** 启动恢复扫描（若有 pending intent → recoverIntent 分诊）。 */
  async function recoverIfNeeded(ctx) {
    const pending = await readPendingIntent(ctx.repoDir);
    if (pending === null) return null;
    const r = await recoverIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir });
    if (r.status === "conflicted") return r;
    log.info?.(`sync ${ctx.groupId}/${ctx.rootId}: intent ${r.intent?.txId} recovered (${r.status})`);
    return null;
  }

  /**
   * 双向单轮：首拉/seed 分诊 → scanning → fetching → merging → pushing。
   * 顺序要点：**先判首拉再 commitLocal**——非空对端的首拉阻断必须在把本地
   * 工作树提交成 device ref 之前发生（否则本地非空内容会变成独立历史，
   * [W9] 的「不自动合并」就被绕开了）。
   * @param {ReturnType<typeof ctxFor>} ctx
   * @param {string} peer
   * @param {{ signal?: AbortSignal }} opts
   */
  async function runTwoway(ctx, peer, opts) {
    const devRef = deviceRef(endpointId);
    const peerDevRef = deviceRef(peer);
    const wire = `/wpk1/sync/${ctx.groupId}/${ctx.rootId}`;
    // 早期 refs 快照（首拉/seed 分诊）
    const earlyRefs = await callPeer(peer)(`${wire}/refs`, { signal: opts.signal });
    if (!earlyRefs.ok || earlyRefs.body?.ok !== true) throw httpError("fetch-refs", earlyRefs);
    const earlyPeerRefs = /** @type {Record<string, string>} */ (earlyRefs.body.refs);
    const groupCur0 = await readRef(ctx.gitdir, GROUP_REF);
    const myDev0 = await readRef(ctx.gitdir, devRef);

    if (myDev0 === null) {
      // 初始化判定只看**本端 device ref**（组 ref 可能已被对端 push 提前推进——
      // push 是纯 ref 操作，不代表本端工作树已采纳基线）。
      const peerHasBaseline = (earlyPeerRefs[GROUP_REF] ?? null) !== null;
      if (!peerHasBaseline) {
        // 双端全新：seed authority 先建基线；另一端等待
        if (ctx.root.seedAuthority === endpointId) {
          await commitLocal(ctx);
          const commit = /** @type {string} */ (await readRef(ctx.gitdir, devRef));
          await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: commit, oldRef: groupCur0, ops: [] }, { now });
          setJob(ctx.groupId, ctx.rootId, { phase: "pushing" });
          await pushToPeer(ctx, peer, earlyPeerRefs, [{ ref: GROUP_REF, oid: commit }, { ref: devRef, oid: commit }], opts);
          setJob(ctx.groupId, ctx.rootId, { phase: "done" });
          return { ok: true, phase: "done", note: "seed baseline pushed" };
        }
        setJob(ctx.groupId, ctx.rootId, { phase: "done" });
        return { ok: true, phase: "done", note: "waiting for the seed authority side to publish its baseline" };
      }
      return await firstPull(ctx, peer, earlyPeerRefs, opts);
    }

    // 常规轮：scanning（本地改动 → device ref）→ fetching → merging → pushing
    await commitLocal(ctx);
    if (opts.signal?.aborted) throw { code: "aborted", message: "sync aborted before fetch" };
    setJob(ctx.groupId, ctx.rootId, { phase: "fetching" });
    const { refs: peerRefs } = await fetchFromPeer(ctx, peer, opts);
    if (opts.signal?.aborted) throw { code: "aborted", message: "sync aborted before merge" };
    setJob(ctx.groupId, ctx.rootId, { phase: "merging" });

    const myDev = await readRef(ctx.gitdir, devRef);
    const peerDev = await readRef(ctx.gitdir, peerDevRef);
    const groupCur = await readRef(ctx.gitdir, GROUP_REF);

    // 对端尚无 device 线（未采纳基线）或已与本端一致：只推送使其赶上
    // （此判断必须先于 mergeBase——peerDev 缺席不是 unrelated，是待追赶）
    if (peerDev === null || peerDev === myDev) {
      setJob(ctx.groupId, ctx.rootId, { phase: "pushing" });
      const targets = [];
      if (myDev !== null && peerRefs[devRef] !== myDev) targets.push({ ref: devRef, oid: myDev });
      if (groupCur !== null && peerRefs[GROUP_REF] !== groupCur) targets.push({ ref: GROUP_REF, oid: groupCur });
      if (targets.length > 0) await pushToPeer(ctx, peer, peerRefs, targets, opts);
      setJob(ctx.groupId, ctx.rootId, { phase: "done" });
      return { ok: true, phase: "done", note: "up to date (pushed)" };
    }

    const base = await mergeBase(ctx.gitdir, /** @type {string} */ (myDev), peerDev);
    if (base === null) {
      throw { code: "unrelated-histories", message: "device lines share no common ancestor", hint: "recreate the group with a seed authority ([W9]) or reset the root" };
    }

    // fast-forward：一方无新变更
    if (myDev === base && peerDev !== null && peerDev !== base) {
      const tree = (await readCommitParsed(ctx.gitdir, peerDev)).tree;
      // ours=本端 device 树（工作树现行状态——组 ref 可能已被对端 push 推到
      // 目标位，物化差必须对本端实际内容算，否则工作树永不收敛）
      const oursFlat = await readFlatTree(ctx.gitdir, (await readCommitParsed(ctx.gitdir, myDev)).tree);
      const targetFlat = await readFlatTree(ctx.gitdir, tree);
      const ops = await buildMaterializeOps(ctx, oursFlat, [...targetFlat.entries()].filter(([, e]) => e.type === "blob").map(([p, e]) => ({ path: p, oid: e.oid, mode: e.mode })));
      await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: peerDev, oldRef: groupCur, ops }, { now });
      await advanceDevice(ctx, devRef, myDev, peerDev);
      setJob(ctx.groupId, ctx.rootId, { phase: "pushing" });
      await pushToPeer(ctx, peer, peerRefs, [{ ref: GROUP_REF, oid: peerDev }], opts);
      setJob(ctx.groupId, ctx.rootId, { phase: "done" });
      return { ok: true, phase: "done", note: "fast-forward" };
    }
    if (peerDev === base) {
      // 本端领先（对端无新内容）：组 ref 推进到本端 device 头（无需合并提交、
      // 无需物化——工作树已是该状态）+ 推送
      setJob(ctx.groupId, ctx.rootId, { phase: "pushing" });
      await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: /** @type {string} */ (myDev), oldRef: groupCur, ops: [] }, { now });
      await pushToPeer(ctx, peer, peerRefs, [{ ref: devRef, oid: /** @type {string} */ (myDev) }, { ref: GROUP_REF, oid: /** @type {string} */ (myDev) }], opts);
      setJob(ctx.groupId, ctx.rootId, { phase: "done" });
      return { ok: true, phase: "done", note: "local ahead (pushed)" };
    }

    // 三方合并
    const baseTree = (await readCommitParsed(ctx.gitdir, base)).tree;
    const oursTree = (await readCommitParsed(ctx.gitdir, /** @type {string} */ (myDev))).tree;
    const theirsTree = (await readCommitParsed(ctx.gitdir, /** @type {string} */ (peerDev))).tree;
    const [baseFlat, oursFlat, theirsFlat] = await Promise.all([readFlatTree(ctx.gitdir, baseTree), readFlatTree(ctx.gitdir, oursTree), readFlatTree(ctx.gitdir, theirsTree)]);
    const outcome = await mergeTrees({ gitdir: ctx.gitdir, baseTree: baseFlat, oursTree: oursFlat, theirsTree: theirsFlat });
    if (outcome.conflicts.length > 0) {
      await persistConflictSession(ctx, { baseCommit: base, oursCommit: myDev, theirsCommit: peerDev, outcome });
      setJob(ctx.groupId, ctx.rootId, { phase: "conflicted", error: { code: "conflicts", message: `${outcome.conflicts.length} path(s) conflicted (${outcome.conflicts.filter((c) => c.level === "hunk").length} hunk-level, ${outcome.conflicts.filter((c) => c.level === "file").length} file-level)`, hint: "resolve via the conflicts page, then sync resumes" } });
      return { ok: true, phase: "conflicted", conflicts: outcome.conflicts.length };
    }
    const treeOid = await writeTreeFromFlat(ctx.gitdir, outcome.mergedEntries.filter((e) => e.type === "blob").map((e) => ({ path: e.path, oid: e.oid, mode: /** @type {"100644" | "100755"} */ (e.mode) })));
    const [oursSorted, theirsSorted] = [myDev, peerDev].sort((a, b) => (a < b ? -1 : 1));
    const mergeCommit = await writeCommitOid(ctx.gitdir, {
      message: `sync: merge ${endpointAbbrev(peer)} into ${endpointAbbrev(endpointId)}`,
      tree: treeOid,
      parent: [oursSorted, theirsSorted],
      authorName: `${endpointAbbrev(endpointId)} ${deviceName}`,
      authorEmail: `${endpointAbbrev(endpointId)}@device.sync`,
      timestamp: now(),
    });
    const ops = await buildMaterializeOps(ctx, oursFlat, outcome.mergedEntries.filter((e) => e.type === "blob").map((e) => ({ path: e.path, oid: e.oid, mode: e.mode })));
    await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: mergeCommit, oldRef: groupCur, ops }, { now });
    await advanceDevice(ctx, devRef, myDev, mergeCommit);
    setJob(ctx.groupId, ctx.rootId, { phase: "pushing" });
    await pushToPeer(ctx, peer, peerRefs, [{ ref: devRef, oid: mergeCommit }, { ref: GROUP_REF, oid: mergeCommit }], opts);
    setJob(ctx.groupId, ctx.rootId, { phase: "done" });
    return { ok: true, phase: "done", note: "merged" };
  }

  /**
   * 单向轮：源端（seed authority）=提交本地+推送（不接收）；镜像端=fetch+
   * fast-forward 跟随（不提交本地、不回传——Scenario「单向跟随」）。
   * @param {ReturnType<typeof ctxFor>} ctx
   * @param {string} peer
   * @param {{ signal?: AbortSignal }} opts
   */
  async function runOneway(ctx, peer, opts) {
    const isSource = ctx.root.seedAuthority === endpointId;
    if (isSource) {
      // 源端：scanning（提交本地）→ pushing（组 ref+device ref）
      await commitLocal(ctx);
      const myDev = await readRef(ctx.gitdir, deviceRef(endpointId));
      const groupCur = await readRef(ctx.gitdir, GROUP_REF);
      if (myDev === null) {
        setJob(ctx.groupId, ctx.rootId, { phase: "done" });
        return { ok: true, phase: "done", note: "source is empty — nothing to publish" };
      }
      if (groupCur === null) {
        await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: myDev, oldRef: null, ops: [] }, { now });
      } else if (groupCur !== myDev) {
        // 组 ref 跟随源端 device 线（源端是唯一写者——不接收对端内容）
        await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: myDev, oldRef: groupCur, ops: [] }, { now });
      }
      setJob(ctx.groupId, ctx.rootId, { phase: "pushing" });
      const call = callPeer(peer);
      const refsResp = await call(`/wpk1/sync/${ctx.groupId}/${ctx.rootId}/refs`, { signal: opts.signal });
      if (!refsResp.ok || refsResp.body?.ok !== true) throw httpError("fetch-refs", refsResp);
      await pushToPeer(ctx, peer, refsResp.body.refs, [{ ref: GROUP_REF, oid: /** @type {string} */ (myDev) }, { ref: deviceRef(endpointId), oid: /** @type {string} */ (myDev) }], opts);
      setJob(ctx.groupId, ctx.rootId, { phase: "done" });
      return { ok: true, phase: "done", note: "source published" };
    }
    // 镜像端：fetch+fast-forward；本地改动不回传（不 commitLocal、不 push）。
    // 物化标记=本端 device ref（镜像从不推送它——仅记录「工作树已应用到哪」；
    // 组 ref 可能被对端 push 提前推进，不能当物化状态用）。
    setJob(ctx.groupId, ctx.rootId, { phase: "fetching" });
    const { refs: peerRefs } = await fetchFromPeer(ctx, peer, opts);
    setJob(ctx.groupId, ctx.rootId, { phase: "merging" });
    const peerGroup = peerRefs[GROUP_REF] ?? null;
    const groupCur = await readRef(ctx.gitdir, GROUP_REF);
    const myDev = await readRef(ctx.gitdir, deviceRef(endpointId));
    if (peerGroup === null) {
      setJob(ctx.groupId, ctx.rootId, { phase: "done" });
      return { ok: true, phase: "done", note: "peer has no baseline yet" };
    }
    if (myDev === peerGroup && groupCur === peerGroup) {
      setJob(ctx.groupId, ctx.rootId, { phase: "done" });
      return { ok: true, phase: "done", note: "up to date" };
    }
    if (myDev !== null) {
      const anc = await mergeBase(ctx.gitdir, myDev, peerGroup);
      if (anc !== myDev) {
        throw { code: "mirror-diverged", message: "peer group ref is not a fast-forward of the mirror's applied state", hint: "one-way mirrors must follow; reset the mirror root or switch it to two-way" };
      }
    }
    const targetTree = (await readCommitParsed(ctx.gitdir, peerGroup)).tree;
    const oursFlat = myDev !== null ? await readFlatTree(ctx.gitdir, (await readCommitParsed(ctx.gitdir, myDev)).tree) : new Map();
    const targetFlat = await readFlatTree(ctx.gitdir, targetTree);
    const ops = await buildMaterializeOps(ctx, oursFlat, [...targetFlat.entries()].filter(([, e]) => e.type === "blob").map(([p, e]) => ({ path: p, oid: e.oid, mode: e.mode })));
    await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: peerGroup, oldRef: groupCur, ops }, { now });
    await advanceDevice(ctx, deviceRef(endpointId), myDev, peerGroup);
    setJob(ctx.groupId, ctx.rootId, { phase: "done" });
    return { ok: true, phase: "done", note: "mirror followed" };
  }

  /**
   * 对端首拉（[W9]）：工作树非空 → 阻断+三方对照；空 → 采纳基线（intent 事务）。
   * @param {ReturnType<typeof ctxFor>} ctx
   * @param {string} peer
   * @param {Record<string, string>} peerRefs
   * @param {{ signal?: AbortSignal }} opts
   */
  async function firstPull(ctx, peer, peerRefs, opts) {
    void opts;
    const seedCommit = peerRefs[GROUP_REF] ?? null;
    if (seedCommit === null) {
      throw { code: "no-baseline", message: "peer has no baseline commit yet", hint: "the seed authority side should sync first" };
    }
    const entries = await scanWorktree(ctx.rootPath, ctx.gitdir);
    const localFiles = entries.filter((e) => e.kind === "file");
    const seedTreeOid = (await readCommitParsed(ctx.gitdir, seedCommit)).tree;
    const seedFlat = await readFlatTree(ctx.gitdir, seedTreeOid);
    if (localFiles.length === 0) {
      // 空工作树：直接采纳基线（intent 事务：删除多余/写入全部）。oldRef=当前
      // 组 ref 实值（可能已被对端 push 预置为 seedCommit——CAS 同值通过）。
      const groupNow = await readRef(ctx.gitdir, GROUP_REF);
      const ops = await buildMaterializeOps(ctx, new Map(), [...seedFlat.entries()].filter(([, e]) => e.type === "blob").map(([p, e]) => ({ path: p, oid: e.oid, mode: e.mode })));
      await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: seedCommit, oldRef: groupNow, ops }, { now });
      await advanceDevice(ctx, deviceRef(endpointId), null, seedCommit);
      setJob(ctx.groupId, ctx.rootId, { phase: "done" });
      return { ok: true, phase: "done", note: "baseline adopted (empty worktree)" };
    }
    // 非空 → 阻断+三方对照（A 内容/B 现状/空基线）
    const block = {
      groupId: ctx.groupId,
      rootId: ctx.rootId,
      seedCommit,
      createdAt: new Date(now()).toISOString(),
      threeWay: {
        base: { label: "empty baseline", entries: [] },
        seed: { label: "seed (authority)", entries: [...seedFlat.entries()].filter(([, e]) => e.type === "blob").map(([p, e]) => ({ path: p, oid: e.oid, mode: e.mode })) },
        local: { label: "local worktree", entries: localFiles.map((e) => ({ path: e.path, oid: /** @type {string} */ (e.oid), mode: /** @type {number} */ (e.mode) === 0o100755 ? "100755" : "100644" })) },
      },
    };
    await atomicWrite0600(path.join(ctx.repoDir, SEED_BLOCK), `${JSON.stringify(block, null, 2)}\n`);
    setJob(ctx.groupId, ctx.rootId, { phase: "conflicted", error: { code: "seed-block", message: "local worktree is not empty on first pull", hint: "explicitly adopt the seed baseline (local content is abandoned) or clean the root" } });
    log.warn?.(`sync ${ctx.groupId}/${ctx.rootId}: first pull blocked (non-empty worktree)`);
    return { ok: true, phase: "conflicted", reason: "seed-block" };
  }

  /** device ref 前进（本地写路径——CAS 单写者）。 */
  async function advanceDevice(ctx, devRef, expected, value) {
    const mutex = repoMutexFor(ctx.gitdir);
    await mutex.run("advance-device", async () => {
      const cur = await readRef(ctx.gitdir, devRef);
      if (cur !== expected) throw { code: "cas-mismatch", ref: devRef, expectedOldRef: expected, currentRef: cur };
      if (value !== cur) await writeRef(ctx.gitdir, devRef, value);
    });
  }

  /**
   * 冲突会话持久化（两端可复现：OID+算法版本+结构化 hunks+driver 建议）。
   */
  async function persistConflictSession(ctx, snap) {
    const records = snap.outcome.conflicts.map((c) => ({
      id: conflictRecordId(c),
      path: c.path,
      level: c.level,
      kind: c.kind,
      base: c.base,
      ours: c.ours,
      theirs: c.theirs,
      hunks: c.hunks ?? [],
      detail: c.detail ?? null,
      driverSuggestion: c.level === "hunk" ? consultMergeDrivers({ path: c.path, hunks: c.hunks ?? [], base: c.base, ours: c.ours, theirs: c.theirs }) : null,
      resolution: null,
    }));
    const session = {
      algoVersion: DIFF3_ALGO_VERSION,
      createdAt: new Date(now()).toISOString(),
      baseCommit: snap.baseCommit,
      oursCommit: snap.oursCommit,
      theirsCommit: snap.theirsCommit,
      oursEndpoint: endpointId,
      autoMerged: snap.outcome.autoMerged,
      propagatedMode: snap.outcome.propagatedMode,
      mergedEntries: snap.outcome.mergedEntries,
      conflicts: records,
    };
    await atomicWrite0600(path.join(ctx.repoDir, CONFLICT_SESSION), `${JSON.stringify(session, null, 2)}\n`);
  }

  /**
   * 读冲突会话（UI 冲突页投影源）。
   * @param {string} groupId @param {string} rootId
   */
  async function conflictSession(groupId, rootId) {
    const { readFile } = await import("node:fs/promises");
    try {
      const text = await readFile(path.join(repoDir(home, groupId, rootId), CONFLICT_SESSION), "utf8");
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * 读 seed 阻断记录。
   * @param {string} groupId @param {string} rootId
   */
  async function seedBlockOf(groupId, rootId) {
    const { readFile } = await import("node:fs/promises");
    try {
      const text = await readFile(path.join(repoDir(home, groupId, rootId), SEED_BLOCK), "utf8");
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * 冲突决议（hunk 逐块/文件级整选/编辑）→ 合并提交 → intent → push。
   * @param {string} groupId
   * @param {string} rootId
   * @param {Record<string, { level: "hunk" | "file", choices?: Array<{ hunkIndex: number, choice: "ours" | "theirs" | "edit", text?: string }>, choice?: "ours" | "theirs" | "edit" | "delete", contentBase64?: string, mode?: string }>} decisions path → 决议
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async function resolveConflicts(groupId, rootId, decisions, opts = {}) {
    const ledger = await loadLedger(home);
    const group = findGroup(ledger, groupId);
    if (group === null) return { ok: false, code: "unknown-group" };
    const root = group.roots.find((r) => r.id === rootId);
    if (root === undefined) return { ok: false, code: "unknown-root" };
    const ctx = ctxFor(group, root);
    const session = await conflictSession(groupId, rootId);
    if (session === null) return { ok: false, code: "no-conflicts" };
    const unresolved = session.conflicts.filter((c) => c.resolution === null);
    if (unresolved.length === 0) return { ok: false, code: "no-conflicts" };
    /** @type {Array<{ path: string, oid: string, mode: string }>} */
    const resolvedEntries = [];
    for (const c of unresolved) {
      const d = decisions[c.path];
      if (d === undefined) return { ok: false, code: "missing-decision", path: c.path };
      if (c.level === "hunk") {
        if (!Array.isArray(d.choices)) return { ok: false, code: "bad-decision", path: c.path };
        const texts = await Promise.all([c.ours?.oid, c.base?.oid, c.theirs?.oid].map(async (oid) => (oid ? Buffer.from((await readObject(ctx.gitdir, oid)).bytes).toString("utf8") : "")));
        const text = applyHunkDecisions(texts[0], texts[1], texts[2], c.hunks, d.choices);
        const oid = await writeObject(ctx.gitdir, "blob", new Uint8Array(Buffer.from(text, "utf8")));
        resolvedEntries.push({ path: c.path, oid, mode: c.ours?.mode ?? "100644" });
        c.resolution = { kind: "hunks", choices: d.choices };
      } else {
        if (d.choice === undefined) return { ok: false, code: "bad-decision", path: c.path };
        if (d.choice === "ours" && c.ours !== null) resolvedEntries.push({ path: c.path, oid: c.ours.oid, mode: c.ours.mode });
        else if (d.choice === "theirs" && c.theirs !== null) resolvedEntries.push({ path: c.path, oid: c.theirs.oid, mode: c.theirs.mode });
        else if (d.choice === "edit") {
          if (typeof d.contentBase64 !== "string") return { ok: false, code: "bad-decision", path: c.path };
          const oid = await writeObject(ctx.gitdir, "blob", fromBase64(d.contentBase64));
          resolvedEntries.push({ path: c.path, oid, mode: d.mode ?? c.ours?.mode ?? "100644" });
        } else if (d.choice === "delete") { /* delete-modify 决议=接受删除——不入 finalMap */ }
        else return { ok: false, code: "bad-decision", path: c.path };
        c.resolution = { kind: "choice", choice: d.choice };
      }
    }
    // 组装最终树：mergedEntries ∪ resolvedEntries（冲突路径替换）
    const finalMap = new Map(session.mergedEntries.filter((e) => e.type === "blob").map((e) => [e.path, { oid: e.oid, mode: e.mode }]));
    for (const r of resolvedEntries) finalMap.set(r.path, { oid: r.oid, mode: r.mode });
    for (const c of unresolved) if (c.resolution?.kind === "choice" && c.resolution.choice === "delete") finalMap.delete(c.path);
    const treeOid = await writeTreeFromFlat(ctx.gitdir, [...finalMap.entries()].map(([p, e]) => ({ path: p, oid: e.oid, mode: /** @type {"100644" | "100755"} */ (e.mode) })));
    const [oursSorted, theirsSorted] = [session.oursCommit, session.theirsCommit].sort((a, b) => (a < b ? -1 : 1));
    const commit = await writeCommitOid(ctx.gitdir, {
      message: `sync: conflict resolution on ${deviceName} (${endpointAbbrev(endpointId)})`,
      tree: treeOid,
      parent: [oursSorted, theirsSorted],
      authorName: `${endpointAbbrev(endpointId)} ${deviceName}`,
      authorEmail: `${endpointAbbrev(endpointId)}@device.sync`,
      timestamp: now(),
    });
    const oursFlat = await readFlatTree(ctx.gitdir, (await readCommitParsed(ctx.gitdir, session.oursCommit)).tree);
    const ops = await buildMaterializeOps(ctx, oursFlat, [...finalMap.entries()].map(([p, e]) => ({ path: p, oid: e.oid, mode: e.mode })));
    await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: commit, oldRef: await readRef(ctx.gitdir, GROUP_REF), ops }, { now });
    await advanceDevice(ctx, deviceRef(endpointId), await readRef(ctx.gitdir, deviceRef(endpointId)), commit);
    // 会话标记全部 resolved（持久化决议——两端可复现）
    session.resolvedAt = new Date(now()).toISOString();
    session.resolvedBy = endpointId;
    await atomicWrite0600(path.join(ctx.repoDir, CONFLICT_SESSION), `${JSON.stringify(session, null, 2)}\n`);
    // push（对端拉走决议提交）
    const peer = peerOf(group);
    if (peer !== null) {
      setJob(groupId, rootId, { phase: "pushing" });
      const call = callPeer(peer);
      const refsResp = await call(`/wpk1/sync/${groupId}/${rootId}/refs`);
      if (refsResp.ok && refsResp.body?.ok === true) {
        await pushToPeer(ctx, peer, refsResp.body.refs, [{ ref: deviceRef(endpointId), oid: commit }, { ref: GROUP_REF, oid: commit }], opts);
      }
    }
    setJob(groupId, rootId, { phase: "done", error: null });
    return { ok: true, commit };
  }

  /**
   * seed 阻断决议（显式处置：adopt-seed=采纳 A/放弃 B 内容；经 intent 事务）。
   * @param {string} groupId @param {string} rootId
   * @param {"adopt-seed"} decision
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async function resolveSeedBlock(groupId, rootId, decision, opts = {}) {
    if (decision !== "adopt-seed") return { ok: false, code: "bad-decision", error: "only adopt-seed is supported (explicit, destructive)" };
    const ledger = await loadLedger(home);
    const group = findGroup(ledger, groupId);
    if (group === null) return { ok: false, code: "unknown-group" };
    const root = group.roots.find((r) => r.id === rootId);
    if (root === undefined) return { ok: false, code: "unknown-root" };
    const ctx = ctxFor(group, root);
    const block = await seedBlockOf(groupId, rootId);
    if (block === null) return { ok: false, code: "no-seed-block" };
    const seedFlat = await readFlatTree(ctx.gitdir, (await readCommitParsed(ctx.gitdir, block.seedCommit)).tree);
    const localEntries = await scanWorktree(ctx.rootPath, ctx.gitdir);
    const localFlat = new Map(scanToFlatEntries(localEntries).map((e) => [e.path, e]));
    const seedPaths = [...seedFlat.entries()].filter(([, e]) => e.type === "blob").map(([p, e]) => ({ path: p, oid: e.oid, mode: e.mode }));
    /** @type {Array<{ op: "write" | "delete", path: string, pre: any, post: any }>} */
    const ops = [];
    for (const s of seedPaths) {
      const pre = await pathStateTuple(ctx.rootPath, s.path, ctx.gitdir);
      const same = localFlat.get(s.path);
      if (same !== undefined && same.oid === s.oid && same.mode === s.mode) continue; // 已一致
      ops.push({ op: "write", path: s.path, pre, post: { oid: s.oid, type: "blob", mode: s.mode === "100755" ? 0o100755 : 0o100644 } });
    }
    for (const [p] of localFlat) {
      if (!seedFlat.has(p)) ops.push({ op: "delete", path: p, pre: await pathStateTuple(ctx.rootPath, p, ctx.gitdir), post: null }); // B-only 文件显式放弃
    }
    await executeIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir }, { ref: GROUP_REF, targetCommit: block.seedCommit, oldRef: await readRef(ctx.gitdir, GROUP_REF), ops }, { now });
    await advanceDevice(ctx, deviceRef(endpointId), await readRef(ctx.gitdir, deviceRef(endpointId)), block.seedCommit);
    await rm(path.join(ctx.repoDir, SEED_BLOCK), { force: true }).catch(() => {});
    setJob(groupId, rootId, { phase: "done", error: null });
    log.info?.(`sync ${groupId}/${rootId}: seed block resolved (adopted ${block.seedCommit.slice(0, 8)})`);
    return { ok: true };
  }

  /**
   * 启动恢复扫描（全部组/root：intent 分诊+staging TTL 回收）。
   */
  async function recoverAll() {
    const ledger = await loadLedger(home);
    /** @type {Array<{ groupId: string, rootId: string, status: string, reason?: string, paths?: string[] }>} */
    const results = [];
    for (const group of ledger.groups) {
      for (const root of group.roots) {
        const ctx = ctxFor(group, root);
        const r = await recoverIntent({ repoDir: ctx.repoDir, root: ctx.rootPath, gitdir: ctx.gitdir });
        await gcStaging(path.join(ctx.gitdir, "staging"), { now }).catch(() => {});
        await gcStaging(path.join(ctx.repoDir, FETCH_STAGING), { now }).catch(() => {});
        results.push({ groupId: group.id, rootId: root.id, status: r.status, reason: r.reason, paths: r.paths });
        if (r.status === "conflicted") {
          setJob(group.id, root.id, { phase: "conflicted", error: { code: r.reason ?? "recovery", message: `recovery left the repo conflicted (${r.reason ?? "?"})`, hint: "resolve via the conflicts page" } });
        }
      }
    }
    return results;
  }

  /** 状态投影（UI StatusPage 源）。 */
  function statusProjection() {
    const out = [];
    for (const [key, job] of [...jobs.entries()].sort()) {
      const [groupId, rootId] = key.split("/");
      out.push({ groupId, rootId, ...job });
    }
    return out;
  }

  return {
    runRoot,
    recoverAll,
    resolveConflicts,
    resolveSeedBlock,
    conflictSession,
    seedBlockOf,
    statusProjection,
    commitLocal,
    fetchFromPeer,
    pushToPeer,
    jobsSnapshot: () => new Map(jobs),
  };
}

export { gcStaging };
