// adapted from ai-fly src/provider/engine.ts (v0.6.0) —— 响应中继状态机
// （design §3.2 r2-P0-B 冻结面：单飞拉取+连续提交游标；tasks B1）。
//
// 状态机（冻结）：
//   allocated → producing →（逐 seq：ready(seq) → in-flight → committed）→ done
//   终态（互斥）：done | cancelled | expired
//
// - 全部状态转移（produce/cancel/expiry/commit/拉取）在 per-rid 互斥锁内完成：
//   单线程事件循环+显式临界区（design 原文语义）——本实现以「每个临界区为
//   同步代码段（无 await）」+ per-rid promise 链互斥锁双保险：同步段在事件
//   循环上天然原子，互斥锁把异步复合操作（hold 等待、背压等待）串行化，
//   等待本身发生在锁外（无锁内等待=无死锁）。
// - 单飞拉取：同 rid 并发第二个 response 调用=409 pull_in_flight。
// - 连续提交游标 committedSeq 初值 −1：拉取必须 fromSeq===committedSeq+1
//   （否则 409 invalid_from_seq）；提交=消费方下一次拉取 fromSeq 推进（隐式
//   连续提交）或终态确认；ring 槽仅随游标推进释放。已送达未确认的末片保留
//   在 ring——丢包重试 fromSeq=seq 得到同内容重放（(epoch,rid,seq) 同键同
//   内容——幂等仅同进程内保证）。
// - 未就绪=204 hold ≤20s（hold 期产出即返回；204 不续 TTL）+x-odai-next-seq。
// - 空闲 TTL=最后 200 拉取活动+120s；绝对寿命=创建+10min 硬上界（到点未
//   终态即 expired——先 abort 上游再释放占位）。
// - done：上游 EOF 后，末片拉取带 x-odai-done:1；下一次拉取（终态确认）=
//   摘要 200 零 body；此后拉取=摘要重放（body 分片即弃，旧 seq 不可再拉）。
// - 终态摘要 LRU 独立 ≤4MiB（done/error 摘要可重放；cancelled/expired 404
//   族标记）；不占活跃 ring 预算（活跃 ring=per-rid ≤2MiB）。
// - 满 buffer=上游读暂停背压（sink.chunk 等待 ring 空间；拉取推进/终态唤醒）。
// - 撤钥三态（design §2）：单 keyId 撤销=新 request 403（endpoints 层）；
//   在途 rid 按创建时快照续拉至终态（本层不因撤钥拒拉取）。全钥失效=
//   drainForKeys（5s 有界 deadline：在途 settle 或 abort auth_revoked——
//   由宿主在 drain 完成后断会话）。gate 撤销=closeAll（在途随会话收敛）。
// - 上游中途失败（meta 已下发后）：显式 error 终态（requirements「断线/
//   过期/竞态 MUST 显式错误，MUST NOT 静默截断成成功」）——拉取得到映射的
//   HTTP 错误（OpenAI 风格 {code,message}），非静默截断。meta 前失败不产生
//   rid（request 端点直接回错误）。

import { HDR_DONE, HDR_NEXT_SEQ, HDR_SEQ, PER_REQUEST_BUFFER_BYTES, jsonResponse } from "../wire/constants.mjs";
import { UpstreamAbortError } from "./upstream.mjs";

/** 空闲 TTL（最后 200 拉取活动起算；204 hold 不续期）。 */
export const DEFAULT_IDLE_TTL_MS = 120_000;
/** 绝对寿命硬上界（创建起算；不可续期）。 */
export const DEFAULT_ABSOLUTE_LIFETIME_MS = 10 * 60_000;
/** 过期扫描间隔（unref 计时器；仅存在活跃 rid 时运转）。 */
export const DEFAULT_SWEEP_INTERVAL_MS = 1_000;
/** 终态摘要 LRU 独立上界（§3.1）。 */
export const SUMMARY_LRU_MAX_BYTES = 4 * 1024 * 1024;
/** 全钥失效 drain deadline（design §2 ②：5s 有界）。 */
export const DEFAULT_DRAIN_DEADLINE_MS = 5_000;

/** 终态种类。 */
export const TERMINAL_KIND = { done: "done", cancelled: "cancelled", expired: "expired", error: "error" };

/**
 * per-rid 互斥锁（promise 链）：临界区内禁止 await（同步段——见文件头）。
 * @returns {(fn: () => T) => Promise<T>} 泛型串行化
 */
function createRidLock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(() => fn());
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * 响应中继登记簿（每 forward plane 一个；epoch=进程启动 CSPRNG）。
 * @param {{
 *   epoch: string,
 *   bufferBytes?: number,
 *   idleTtlMs?: number,
 *   absoluteLifetimeMs?: number,
 *   sweepIntervalMs?: number,
 *   drainDeadlineMs?: number,
 *   now?: () => number,
 *   log?: (level: "info" | "warn" | "error", msg: string) => void,
 * }} opts
 */
export function createRelayRegistry(opts) {
  const epoch = opts.epoch;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const perRidBufferBytes = opts.bufferBytes ?? PER_REQUEST_BUFFER_BYTES;
  const idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const absoluteLifetimeMs = opts.absoluteLifetimeMs ?? DEFAULT_ABSOLUTE_LIFETIME_MS;
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const drainDeadlineMs = opts.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;

  /** @type {Map<string, Entry>} 活跃（未终态确认）rid */
  const active = new Map();
  /** @type {Map<string, object>} 终态摘要 LRU（插入序=年龄序；访问重插） */
  const summaries = new Map();
  let summaryBytes = 0;
  let sweepTimer = null;

  // -------------------------------------------------------------------------
  // 内部：终态申请（全部转移的汇聚点——锁内调用；先 abort 上游再释放占位）
  // -------------------------------------------------------------------------

  /**
   * @typedef {Object} Entry
   * @property {string} rid
   * @property {string} keyId 创建时授权快照（撤键不撕在途流）
   * @property {string} group
   * @property {string} serviceId
   * @property {number} createdAt
   * @property {number} lastActivityAt
   * @property {number} committedSeq
   * @property {number} producedSeq
   * @property {number} servedSeq 已送达（serve 过）的最高 seq（确认上界）
   * @property {Array<{ seq: number, buf: Buffer }>} pending committedSeq+1..producedSeq
   * @property {number} bufferBytes
   * @property {boolean} eof 上游 EOF 已产
   * @property {{ status: number, contentType: string, headers?: Record<string, string> } | null} meta
   * @property {boolean} terminalApplied
   * @property {{ kind: string, code?: string, message?: string } | null} terminal
   * @property {boolean} pullInFlight
   * @property {Array<() => void>} pullWaiters hold 中的拉取唤醒（produced/terminal）
   * @property {Array<() => void>} spaceWaiters 背压中的上游读唤醒（拉取推进/终态）
   * @property {AbortController} upstream 上游中止链
   * @property {() => void} onTerminal 占位释放回调（forward plane 注入）
   * @property {(value: any) => void} resolveMeta
   * @property {(err: Error) => void} rejectMeta
   * @property {Promise<any>} metaPromise
   * @property {(fn: () => any) => Promise<any>} withLock
   */

  /**
   * 终态摘要/标记入 LRU（超 4MiB 逐最旧淘汰）。
   * @param {string} rid
   * @param {object} record
   */
  function putSummary(rid, record) {
    summaries.delete(rid);
    summaries.set(rid, record);
    summaryBytes += Buffer.byteLength(JSON.stringify(record));
    while (summaryBytes > SUMMARY_LRU_MAX_BYTES && summaries.size > 1) {
      const oldest = summaries.keys().next().value;
      summaryBytes -= Buffer.byteLength(JSON.stringify(summaries.get(oldest)));
      summaries.delete(oldest);
    }
  }

  /**
   * 终态申请：abort 上游 → 摘要入 LRU → 唤醒全部等待 → 释放占位。
   * 锁内同步段（无 await）。
   * @param {Entry} entry
   * @param {string} kind
   * @param {{ code?: string, message?: string }} [extra]
   */
  function applyTerminal(entry, kind, extra = {}) {
    if (entry.terminalApplied) return;
    entry.terminalApplied = true;
    entry.terminal = { kind, ...extra };
    // ①先 abort 上游（expired/cancelled/drain/收敛路径上游可能仍在读；对已
    // settle 的上游是 no-op）
    entry.upstream.abort(new UpstreamAbortError(kind === TERMINAL_KIND.error ? (extra.code ?? "aborted") : kind));
    // ②摘要/标记入 LRU（done=可重放摘要；error=显式错误重放；cancelled/expired=404 族标记）
    if (kind === TERMINAL_KIND.done) {
      putSummary(entry.rid, { kind, keyId: entry.keyId, status: entry.meta?.status ?? 0, headers: entry.meta?.headers ?? {}, committedSeq: entry.producedSeq });
    } else if (kind === TERMINAL_KIND.error) {
      putSummary(entry.rid, { kind, keyId: entry.keyId, code: extra.code ?? "internal", message: extra.message ?? "" });
    } else {
      putSummary(entry.rid, { kind, keyId: entry.keyId });
    }
    entry.pending = [];
    entry.bufferBytes = 0;
    active.delete(entry.rid);
    // ③唤醒 hold 拉取与背压读
    for (const wake of entry.pullWaiters.splice(0)) wake();
    for (const wake of entry.spaceWaiters.splice(0)) wake();
    // ④释放并发占位（终态即释放——不等 TTL）
    try {
      entry.onTerminal();
    } catch (err) {
      log("error", `ai relay: onTerminal callback failed for ${entry.rid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    stopSweepIfIdle();
  }

  /**
   * meta 前失败：消费端从未见过 rid——直接整体丢弃（无 LRU 记录）。
   * @param {Entry} entry
   */
  function dropEntry(entry) {
    if (entry.terminalApplied) return;
    entry.terminalApplied = true;
    entry.terminal = { kind: TERMINAL_KIND.error };
    entry.upstream.abort(new UpstreamAbortError("aborted"));
    entry.pending = [];
    entry.bufferBytes = 0;
    active.delete(entry.rid);
    for (const wake of entry.pullWaiters.splice(0)) wake();
    for (const wake of entry.spaceWaiters.splice(0)) wake();
    try {
      entry.onTerminal();
    } catch {
      /* 占位释放失败不阻塞错误回送 */
    }
    stopSweepIfIdle();
  }

  // -------------------------------------------------------------------------
  // 内部：过期扫描（空闲 TTL + 绝对寿命——先 abort 上游再释放占位）
  // -------------------------------------------------------------------------

  function startSweepIfNeeded() {
    if (sweepTimer !== null || active.size === 0) return;
    sweepTimer = setInterval(sweep, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  function stopSweepIfIdle() {
    if (sweepTimer !== null && active.size === 0) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function sweep() {
    const t = now();
    for (const entry of [...active.values()]) {
      // 绝对寿命=创建+10min 硬上界（不可续期；到点未终态即 expired）
      if (t - entry.createdAt >= absoluteLifetimeMs) {
        entry.withLock(() => applyTerminal(entry, TERMINAL_KIND.expired));
        continue;
      }
      // 空闲 TTL=最后 200 拉取活动+idleTtlMs（204 hold 不续期）
      if (t - entry.lastActivityAt >= idleTtlMs) {
        entry.withLock(() => applyTerminal(entry, TERMINAL_KIND.expired));
      }
    }
  }

  // -------------------------------------------------------------------------
  // 中继 sink（upstream.mjs ResponseSink 面——produce 转移）
  // -------------------------------------------------------------------------

  /**
   * @param {Entry} entry
   */
  function createRelaySink(entry) {
    return {
      async meta(header) {
        await entry.withLock(() => {
          if (entry.terminalApplied) return;
          // 响应头投影：RESP_META 白名单 + content-type 并入（消费方本地重建
          // 响应头的完整投影面——ai-fly RespMeta.contentType 同拍）
          const headers = { ...(header.headers ?? {}) };
          if (headers["content-type"] === undefined && typeof header.contentType === "string" && header.contentType !== "") {
            headers["content-type"] = header.contentType;
          }
          entry.meta = { status: header.status, headers };
          entry.resolveMeta({ status: header.status, headers });
        });
      },
      async chunk(piece) {
        for (;;) {
          let appended = false;
          await entry.withLock(() => {
            if (entry.terminalApplied || entry.eof) return;
            if (entry.bufferBytes + piece.length <= perRidBufferBytes) {
              entry.producedSeq += 1;
              entry.pending.push({ seq: entry.producedSeq, buf: Buffer.from(piece) });
              entry.bufferBytes += piece.length;
              appended = true;
              for (const wake of entry.pullWaiters.splice(0)) wake();
            }
          });
          if (appended) return;
          // 满 buffer=上游读暂停（背压）：等待拉取推进/终态（锁外等待）
          await new Promise((resolve) => {
            entry.spaceWaiters.push(resolve);
          });
        }
      },
      async end() {
        await entry.withLock(() => {
          if (entry.terminalApplied) return;
          entry.eof = true;
          // EOF 空流（零分片）：无占位数据——hold 拉取即刻走摘要路径
          for (const wake of entry.pullWaiters.splice(0)) wake();
          for (const wake of entry.spaceWaiters.splice(0)) wake();
        });
      },
      async error(header) {
        await entry.withLock(() => {
          if (entry.terminalApplied) return;
          if (entry.meta === null) {
            // meta 前失败：request 端点直接回错误（rid 不存在过）
            const err = new Error(header.message);
            err.code = header.code;
            entry.rejectMeta(err);
            dropEntry(entry);
            return;
          }
          // meta 后中途失败：显式 error 终态（拉取得到映射错误——不静默截断）
          applyTerminal(entry, TERMINAL_KIND.error, { code: header.code, message: header.message });
        });
      },
    };
  }

  // -------------------------------------------------------------------------
  // 拉取（response 端点核心）与取消
  // -------------------------------------------------------------------------

  /**
   * 摘要响应（终态后：200 零 body+x-odai-done:1）。
   * @param {{ kind: string, status?: number, headers?: Record<string, string>, committedSeq?: number, code?: string, message?: string }} record
   */
  function summaryResponse(record) {
    return {
      status: 200,
      headers: [
        { name: HDR_DONE, value: "1" },
        { name: HDR_NEXT_SEQ, value: String((record.committedSeq ?? 0) + 1) },
      ],
      bodyChunks: [],
      summary: record,
    };
  }

  /**
   * 拉取（全部裁决在锁内同步段；hold 等待在锁外——产出/终态/中止/超时四源唤醒，
   * 唤醒注册与单飞占位在同一锁内完成=无漏醒窗口）。
   * @param {string} rid
   * @param {number} fromSeq
   * @param {string} keyId
   * @param {{ signal?: AbortSignal, holdMs?: number }} [pullOpts]
   * @returns {Promise<object | null>} wire 响应（null=消费端中止）
   */
  async function pull(rid, fromSeq, keyId, pullOpts = {}) {
    const holdMs = Math.min(pullOpts.holdMs ?? 20_000, 20_000);
    if (pullOpts.signal?.aborted) return null;
    const entry = active.get(rid);
    if (entry === undefined) return terminalReplay(rid, keyId);
    // 在途 rid 按创建时授权快照（撤键不撕在途流；keyId 不匹配=对该绑定不可见）
    if (entry.keyId !== keyId) return jsonResponse(404, { code: "response_not_found" });

    // hold 等待机制（resolver 在下方锁内登记——与裁决同临界区=无漏醒窗口）
    let wakeResolveRef = () => {};
    const racedRef = new Promise((resolve) => {
      wakeResolveRef = resolve;
    });

    // ---- 裁决第 1 轮（锁内）：就绪即回；未就绪=登记唤醒+单飞占位 ----
    /** @type {(() => void) | null} */
    let registeredWake = null;
    const first = await entry.withLock(() => {
      if (entry.pullInFlight) return { held: false, value: jsonResponse(409, { code: "pull_in_flight" }) };
      const ready = decideReady(entry, fromSeq);
      if (ready !== null) return { held: false, value: ready };
      entry.pullInFlight = true; // 单飞拉取占位（并发第二拉取=409）
      registeredWake = wakeResolveRef; // 与锁外 raced promise 共享的 resolver
      entry.pullWaiters.push(registeredWake);
      return { held: true, value: null };
    });
    if (!first.held) return first.value;

    // ---- hold（≤20s；锁外等待；204 不续 TTL） ----
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      wakeResolveRef();
    };
    const signal = pullOpts.signal;
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(wakeResolveRef, holdMs);
    timer.unref?.();
    await racedRef;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);

    // ---- 裁决第 2 轮（锁内）：清单飞位→中止 null / 状态优先 / 否则 204 ----
    return entry.withLock(() => {
      entry.pullInFlight = false;
      if (registeredWake !== null) {
        const i = entry.pullWaiters.indexOf(registeredWake);
        if (i >= 0) entry.pullWaiters.splice(i, 1);
      }
      if (aborted) return null; // 在途拉取 abort（consumer 本地断开路径）
      const ready = decideReady(entry, fromSeq);
      if (ready !== null) return ready;
      return { status: 204, headers: [{ name: HDR_NEXT_SEQ, value: String(entry.committedSeq + 1) }], bodyChunks: [] };
    });
  }

  /**
   * 拉取裁决（锁内同步段）：就绪/终态/越前判定；null=未就绪（hold）。
   * @param {Entry} entry
   * @param {number} fromSeq
   * @returns {object | null}
   */
  function decideReady(entry, fromSeq) {
    if (entry.terminalApplied) {
      // hold 期间终态（cancel/expired/error）：按终态族回送
      return terminalReplay(entry.rid, entry.keyId);
    }
    // 隐式连续提交：本次拉取的 fromSeq 即「< fromSeq 全部已收」的确认——
    // 游标推进仅覆盖**已送达**分片（servedSeq 界），ring 槽随游标推进释放；
    // 未送达的分片不可被越前声明确认（无提前释放、无 seq 空洞）。
    const confirmTarget = Math.min(fromSeq - 1, entry.servedSeq);
    if (confirmTarget > entry.committedSeq) {
      entry.committedSeq = confirmTarget;
      while (entry.pending.length > 0 && entry.pending[0].seq <= entry.committedSeq) {
        entry.bufferBytes -= entry.pending[0].buf.length;
        entry.pending.shift();
      }
      for (const wake of entry.spaceWaiters.splice(0)) wake(); // 背压恢复读
    }
    // 连续提交游标：拉取必须 fromSeq===committedSeq+1（首片 fromSeq=0；初值 −1；
    // 已送达未确认的末片=committedSeq+1 保留在 ring，同 seq 重试合法且同内容）
    if (fromSeq !== entry.committedSeq + 1) {
      return jsonResponse(409, { code: "invalid_from_seq" });
    }
    if (entry.pending.length > 0 && entry.pending[0].seq === fromSeq) {
      // 就绪：serve 单分片
      const chunk = entry.pending[0];
      const isLast = entry.eof && fromSeq === entry.producedSeq;
      const headers = [
        { name: HDR_SEQ, value: String(fromSeq) },
        { name: HDR_NEXT_SEQ, value: String(fromSeq + 1) },
      ];
      if (isLast) headers.push({ name: HDR_DONE, value: "1" }); // 上游 EOF 分片带 done 标记
      entry.servedSeq = fromSeq;
      entry.lastActivityAt = now(); // 200 拉取活动（续空闲 TTL）
      return { status: 200, headers, bodyChunks: [chunk.buf] };
    }
    if (entry.eof && entry.producedSeq < fromSeq) {
      // 终态确认（提交=终态确认）：done 定格——committedSeq 推进至 producedSeq
      entry.committedSeq = entry.producedSeq;
      entry.lastActivityAt = now();
      const record = {
        kind: TERMINAL_KIND.done,
        keyId: entry.keyId,
        status: entry.meta?.status ?? 0,
        headers: entry.meta?.headers ?? {},
        committedSeq: entry.producedSeq,
      };
      applyTerminal(entry, TERMINAL_KIND.done);
      return summaryResponse(record);
    }
    return null; // 未就绪→hold
  }

  /**
   * 终态重放（LRU 记录面：done=摘要 200 零 body；expired=404 response_expired；
   * cancelled=404 response_not_found；error=映射错误——旧 seq body 不可再拉）。
   * @param {string} rid
   * @param {string} keyId 绑定校验（不匹配=对该绑定不可见）
   */
  function terminalReplay(rid, keyId) {
    const record = summaries.get(rid);
    if (record === undefined || record.keyId !== keyId) return jsonResponse(404, { code: "response_not_found" });
    summaries.delete(rid);
    summaries.set(rid, record); // LRU 触摸
    if (record.kind === TERMINAL_KIND.expired) return jsonResponse(404, { code: "response_expired" });
    if (record.kind === TERMINAL_KIND.cancelled) return jsonResponse(404, { code: "response_not_found" });
    if (record.kind === TERMINAL_KIND.error) {
      return jsonResponse(errorRelayStatus(record.code), { code: record.code, message: record.message });
    }
    return summaryResponse(record);
  }

  /**
   * 取消（幂等：终态后重放同响应）。
   * @param {string} rid
   * @param {string} epochClaim
   * @param {string} keyId
   */
  async function cancel(rid, epochClaim, keyId) {
    if (epochClaim !== epoch) return jsonResponse(404, { code: "response_not_found" });
    const entry = active.get(rid);
    if (entry === undefined) {
      const record = summaries.get(rid);
      if (record === undefined || record.keyId !== keyId) return jsonResponse(404, { code: "response_not_found" });
      summaries.delete(rid);
      summaries.set(rid, record);
      if (record.kind === TERMINAL_KIND.expired) return jsonResponse(404, { code: "response_expired" });
      return jsonResponse(200, { status: record.kind }); // 幂等终态重放
    }
    if (entry.keyId !== keyId) return jsonResponse(404, { code: "response_not_found" });
    await entry.withLock(() => {
      // cancel×done 交叉：锁内先到定终态，后到幂等返回
      applyTerminal(entry, TERMINAL_KIND.cancelled);
    });
    return jsonResponse(200, { status: TERMINAL_KIND.cancelled });
  }

  // -------------------------------------------------------------------------
  // 撤钥三态 ②③面 + 生命周期收敛
  // -------------------------------------------------------------------------

  /**
   * 全钥失效 drain（design §2 ②）：deadline 内在途 settle，未 settle 的以
   * auth_revoked abort（错误码回送拉取端）；完成即解析（宿主随后断会话）。
   * @param {string[]} keyIds
   * @param {{ deadlineMs?: number }} [o]
   * @returns {Promise<Array<{ rid: string, outcome: string }>>}
   */
  function drainForKeys(keyIds, o = {}) {
    const deadlineMs = o.deadlineMs ?? drainDeadlineMs;
    const wanted = new Set(keyIds);
    const targets = [...active.values()].filter((e) => wanted.has(e.keyId));
    return new Promise((resolve) => {
      const timer = setTimeout(finish, deadlineMs);
      timer.unref?.();
      let finished = false;
      const onTerminalAny = () => {
        if (targets.every((e) => e.terminalApplied)) void finish();
      };
      async function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const outcomes = [];
        for (const entry of targets) {
          if (!entry.terminalApplied) {
            // 未 settle：abort（auth_revoked）——锁内申请后读取终态
            await entry.withLock(() => {
              if (!entry.terminalApplied) {
                applyTerminal(entry, TERMINAL_KIND.error, { code: "auth_revoked", message: "all session keys were revoked" });
              }
            });
          }
          outcomes.push({ rid: entry.rid, outcome: entry.terminal?.kind ?? "settled" });
        }
        resolve(outcomes);
      }
      for (const entry of targets) {
        const prev = entry.onTerminal;
        entry.onTerminal = () => {
          try {
            prev();
          } finally {
            onTerminalAny();
          }
        };
      }
      onTerminalAny(); // 已全 settle（如空 targets）即刻完成
    });
  }

  /**
   * 会话收敛/gate 撤销/生命周期 dispose：全部在途 abort（在途随会话关闭收敛）。
   * @param {{ code?: string }} [o]
   */
  async function closeAll(o = {}) {
    const code = o.code ?? "aborted";
    for (const entry of [...active.values()]) {
      await entry.withLock(() => {
        if (!entry.terminalApplied) {
          applyTerminal(entry, TERMINAL_KIND.error, { code, message: `relay closed (${code})` });
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // 登记（forward plane 拨号成功路径调用）
  // -------------------------------------------------------------------------

  /**
   * @param {{ rid: string, keyId: string, group: string, serviceId: string, onTerminal: () => void }} input
   * @returns {{ sink: object, upstreamSignal: AbortSignal, metaPromise: Promise<{ status: number, headers: Record<string, string> }>, abortLocal: () => void, entry: Entry }}
   */
  function create(input) {
    const entry = /** @type {Entry} */ ({
      rid: input.rid,
      keyId: input.keyId,
      group: input.group,
      serviceId: input.serviceId,
      createdAt: now(),
      lastActivityAt: now(),
      committedSeq: -1,
      producedSeq: -1,
      servedSeq: -1,
      pending: [],
      bufferBytes: 0,
      eof: false,
      meta: null,
      terminalApplied: false,
      terminal: null,
      pullInFlight: false,
      pullWaiters: [],
      spaceWaiters: [],
      upstream: new AbortController(),
      onTerminal: input.onTerminal,
    });
    entry.withLock = createRidLock();
    /** @type {(value: any) => void} */
    entry.resolveMeta = () => {};
    /** @type {(err: Error) => void} */
    entry.rejectMeta = () => {};
    entry.metaPromise = new Promise((resolve, reject) => {
      entry.resolveMeta = resolve;
      entry.rejectMeta = reject;
    });
    active.set(entry.rid, entry);
    startSweepIfNeeded();
    const sink = createRelaySink(entry);
    return {
      sink,
      upstreamSignal: entry.upstream.signal,
      metaPromise: entry.metaPromise,
      entry,
      /** consumer 本地断开（仅 meta 前）：abort 上游+drop（meta 后断开不撕 rid）。 */
      abortLocal: () => {
        void entry.withLock(() => {
          if (entry.terminalApplied || entry.meta !== null) return;
          const err = new Error("upstream request aborted (aborted)");
          err.code = "aborted";
          entry.rejectMeta(err);
          dropEntry(entry);
        });
      },
    };
  }

  /** 测试/UI 观测面（非 wire 契约）。 */
  function inspect(rid) {
    const entry = active.get(rid);
    if (entry === undefined) {
      const record = summaries.get(rid);
      return record === undefined ? undefined : { terminal: record };
    }
    return {
      committedSeq: entry.committedSeq,
      producedSeq: entry.producedSeq,
      servedSeq: entry.servedSeq,
      bufferBytes: entry.bufferBytes,
      eof: entry.eof,
      terminal: entry.terminal,
      pullInFlight: entry.pullInFlight,
    };
  }

  return {
    epoch,
    create,
    pull,
    cancel,
    drainForKeys,
    closeAll,
    inspect,
    activeCount: () => active.size,
    /** 生命周期：停扫描计时器（dispose 面）。 */
    dispose: () => {
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    },
  };
}

/**
 * 上游中途失败码→拉取回送 HTTP 状态（与 forward.errorHttpStatus 同拍的中继面
 * 映射；auth_revoked=撤钥 drain 的 503）。
 * @param {string} code
 */
export function errorRelayStatus(code) {
  switch (code) {
    case "auth_revoked":
      return 503;
    case "aborted":
    case "idle_timeout":
      return 504;
    default:
      return 502;
  }
}
