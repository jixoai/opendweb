// codex 实现终审 r1 修复回归（relay 面）：
// - P1-1 单飞位覆盖全部 response 调用路径：已 ready 分片并发 pull→恰一个 200
//   一个 409；终态摘要重放面（无 Entry/锁）同样单飞；
// - P1-2 背压「确认仍满+注册 waiter」同锁临界区（条件变量模式）：pull 与
//   waiter 注册交叉调度矩阵（微任务偏移注入）——producer 恒被唤醒（无漏醒）；
//   dispose/expiry 必然唤醒全部 waiter；
// - P1-3 终态摘要随空闲 TTL 过期回收：低 TTL 探针过期后 404 response_expired
//   （墓碑稳定非 not_found）；重放=活动续期；sweep 覆盖 summaries；
// - P2-1 hold 注册 abort 监听后同步复查预中止（ai-fly engine.ts 5.2-P1 同款）。
// 直测 createRelayRegistry（registry 级注入面——时序完全可控）。

import test from "node:test";
import assert from "node:assert/strict";
import { createRelayRegistry } from "../src/provider/relay.mjs";
import { HDR_DONE, HDR_NEXT_SEQ, HDR_SEQ } from "../src/wire/constants.mjs";

/** 响应头取值。 */
function hdr(res, name) {
  const found = (res.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found === undefined ? null : found.value;
}

/** JSON body 解析（jsonResponse 家族）。 */
function jsonOf(res) {
  return JSON.parse(Buffer.concat((res.bodyChunks ?? []).map((c) => Buffer.from(c))).toString("utf8"));
}

/** 有界等待（超时=拒绝——悬挂检测）。 */
function withTimeout(promise, ms, what = "promise") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`withTimeout: ${what} hung for ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 装配一个 registry + 已 meta 的 entry。 */
function makeRegistry(over = {}) {
  const relay = createRelayRegistry({
    epoch: "ep-fix",
    bufferBytes: over.bufferBytes ?? 64,
    idleTtlMs: over.idleTtlMs ?? 60_000,
    absoluteLifetimeMs: over.absoluteLifetimeMs ?? 600_000,
    sweepIntervalMs: over.sweepIntervalMs ?? 5_000,
    drainDeadlineMs: over.drainDeadlineMs ?? 100,
  });
  const handle = relay.create({ rid: "r1", keyId: "k1", group: "g", serviceId: "svc", onTerminal: () => {} });
  return { relay, handle };
}

async function startMeta(handle, contentType = "application/octet-stream") {
  await handle.sink.meta({ status: 200, contentType });
}

/** 驱动流到 done 终态确认（返回终态确认响应）。 */
async function driveToDone(relay, handle) {
  await startMeta(handle);
  await handle.sink.chunk(Buffer.from("part-0"));
  await handle.sink.end();
  let seq = 0;
  for (;;) {
    const res = await relay.pull("r1", seq, "k1", { holdMs: 200 });
    assert.equal(res.status, 200, `drive: unexpected status ${res.status}`);
    if (hdr(res, HDR_DONE) === "1") {
      return relay.pull("r1", Number(hdr(res, HDR_NEXT_SEQ)), "k1", { holdMs: 200 }); // 终态确认
    }
    seq = Number(hdr(res, HDR_NEXT_SEQ));
  }
}

// ---------------------------------------------------------------------------
// P1-1 单飞位覆盖全部 response 调用路径
// ---------------------------------------------------------------------------

test("P1-1: 已 ready 分片并发 pull——恰一个 200 一个 409（ready 路径占位）", async () => {
  const { relay, handle } = makeRegistry();
  await startMeta(handle);
  await handle.sink.chunk(Buffer.from("ready-chunk")); // seq0 已就绪（未拉取）
  const [a, b] = await Promise.all([
    relay.pull("r1", 0, "k1", { holdMs: 50 }),
    relay.pull("r1", 0, "k1", { holdMs: 50 }),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 409], `并发第二调用必须 409（实测 ${a.status}/${b.status}）`);
  const conflict = a.status === 409 ? a : b;
  assert.deepEqual(jsonOf(conflict), { code: "pull_in_flight" });
  const served = a.status === 200 ? a : b;
  assert.equal(served.bodyChunks[0].toString(), "ready-chunk");
  // 三个并发：1×200 + 2×409
  const { relay: r2, handle: h2 } = makeRegistry();
  await startMeta(h2);
  await h2.sink.chunk(Buffer.from("x"));
  const triple = await Promise.all([
    r2.pull("r1", 0, "k1", { holdMs: 50 }),
    r2.pull("r1", 0, "k1", { holdMs: 50 }),
    r2.pull("r1", 0, "k1", { holdMs: 50 }),
  ]);
  assert.deepEqual(triple.map((r) => r.status).sort((x, y) => x - y), [200, 409, 409]);
  // 串行不受占位影响（释放后可再拉）
  const after = await relay.pull("r1", 0, "k1", { holdMs: 50 });
  assert.equal(after.status, 200, "单飞位已释放（同 seq 幂等重放）");
  relay.dispose();
  r2.dispose();
});

test("P1-1: 终态摘要重放面并发 pull——恰一个 200 一个 409（replay 路径占位）", async () => {
  const { relay, handle } = makeRegistry();
  const confirm = await driveToDone(relay, handle);
  assert.equal(confirm.status, 200);
  assert.equal(hdr(confirm, HDR_DONE), "1");
  // 条目已终态（active 空）——重放面并发
  const [a, b] = await Promise.all([
    relay.pull("r1", 99, "k1", { holdMs: 50 }),
    relay.pull("r1", 99, "k1", { holdMs: 50 }),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 409], `重放并发第二调用必须 409（实测 ${a.status}/${b.status}）`);
  // 串行重放不受影响
  const again = await relay.pull("r1", 99, "k1", { holdMs: 50 });
  assert.equal(again.status, 200);
  relay.dispose();
});

// ---------------------------------------------------------------------------
// P1-2 背压：确认仍满+注册 waiter 同锁临界区（交叉调度矩阵）+ dispose/expiry 必然唤醒
// ---------------------------------------------------------------------------

/**
 * 交叉调度注入：producer 满环等待与 consumer 拉取推进在不同微任务偏移下交叉
 * ——不变量：producer 恒在有界时间内被唤醒（旧缺陷=注册落在锁外，唤醒可命中
 * 空列表→悬挂到过期）。
 * @param {number} settleMicrotasks chunk() 启动后注入的空微任务数（0..4 覆盖
 *   「锁内检查完成→waiter 注册」的旧竞态窗口两侧）
 */
async function backpressureCross(settleMicrotasks) {
  const { relay, handle } = makeRegistry({ bufferBytes: 64 });
  await startMeta(handle);
  await handle.sink.chunk(Buffer.alloc(32)); // seq0
  await handle.sink.chunk(Buffer.alloc(32)); // seq1 —— ring 满（64B）
  const producer = handle.sink.chunk(Buffer.alloc(32)); // seq2 → 背压等待
  for (let i = 0; i < settleMicrotasks; i++) await Promise.resolve();
  // 交叉注入的拉取：serve seq0 → 下一次拉取确认并释放 ring 空间
  const served = await relay.pull("r1", 0, "k1", { holdMs: 100 });
  assert.equal(served.status, 200);
  const confirm = await relay.pull("r1", 1, "k1", { holdMs: 100 }); // 确认 seq0→释放 32B→唤醒 producer
  assert.ok(confirm.status === 200 || confirm.status === 204);
  await withTimeout(producer, 1500, `backpressure producer (offset ${settleMicrotasks})`);
  // 收尾：end + 消费至终态（不留活跃条目/悬挂 promise）
  await handle.sink.end();
  let seq = Number(hdr(confirm, HDR_NEXT_SEQ));
  for (;;) {
    const res = await relay.pull("r1", seq, "k1", { holdMs: 200 });
    if (res.status === 204) continue;
    assert.equal(res.status, 200);
    seq = Number(hdr(res, HDR_NEXT_SEQ));
    if (hdr(res, HDR_DONE) === "1") {
      await relay.pull("r1", seq, "k1", { holdMs: 200 });
      break;
    }
  }
  relay.dispose();
}

for (const offset of [0, 1, 2, 3, 4]) {
  test(`P1-2: 背压 waiter 注册×拉取交叉（微任务偏移 ${offset}）——producer 必被唤醒`, async () => {
    await backpressureCross(offset);
  });
}

test("P1-2: closeAll（会话收敛/dispose 面）必然唤醒背压 waiter", async () => {
  const { relay, handle } = makeRegistry({ bufferBytes: 64 });
  await startMeta(handle);
  await handle.sink.chunk(Buffer.alloc(64)); // 满环
  const producer = handle.sink.chunk(Buffer.alloc(32));
  await Promise.resolve();
  const drained = relay.closeAll({ code: "aborted" });
  await withTimeout(producer, 1000, "closeAll 后背压 producer 必被唤醒");
  await drained;
  const pull = await relay.pull("r1", 0, "k1", { holdMs: 20 });
  assert.equal(pull.status, 504, "closeAll 后在途=aborted 显式错误");
  assert.equal(jsonOf(pull).code, "aborted");
  relay.dispose();
});

test("P1-2: 空闲 TTL expiry（sweep 面）必然唤醒背压 waiter（不悬挂到绝对寿命）", async () => {
  const { relay, handle } = makeRegistry({ bufferBytes: 64, idleTtlMs: 120, sweepIntervalMs: 20 });
  await startMeta(handle);
  await handle.sink.chunk(Buffer.alloc(64)); // 满环
  const producer = handle.sink.chunk(Buffer.alloc(32));
  await Promise.resolve();
  await withTimeout(producer, 2000, "expiry 后背压 producer 必被唤醒");
  const pull = await relay.pull("r1", 0, "k1", { holdMs: 20 });
  assert.equal(pull.status, 404);
  assert.equal(jsonOf(pull).code, "response_expired");
  relay.dispose();
});

// ---------------------------------------------------------------------------
// P1-3 终态摘要随空闲 TTL 过期回收
// ---------------------------------------------------------------------------

test("P1-3: 低 TTL 摘要过期后重放=404 response_expired（墓碑稳定）；重放续期；sweep 覆盖 summaries", async () => {
  const { relay, handle } = makeRegistry({ idleTtlMs: 400, sweepIntervalMs: 20 });
  const confirm = await driveToDone(relay, handle);
  assert.equal(confirm.status, 200);
  const nextSeq = Number(hdr(confirm, HDR_NEXT_SEQ));
  // 重放（TTL 内）=200 摘要 + 活动续期（空闲自最后一次重放起算）
  const early = await relay.pull("r1", nextSeq, "k1", { holdMs: 20 });
  assert.equal(early.status, 200);
  await new Promise((r) => setTimeout(r, 250)); // < 400ms（自重放起）——仍活着
  const refreshed = await relay.pull("r1", nextSeq, "k1", { holdMs: 20 });
  assert.equal(refreshed.status, 200, "重放续期（空闲 TTL 自最后活动起算）");
  // 越过 TTL（sweep 20ms 必然墓碑化）——过期后 404 response_expired
  await new Promise((r) => setTimeout(r, 600));
  const late = await relay.pull("r1", nextSeq, "k1", { holdMs: 20 });
  assert.equal(late.status, 404);
  assert.deepEqual(jsonOf(late), { code: "response_expired" }, "过期后=404 response_expired（非 not_found）");
  // 墓碑稳定：再次重放仍 response_expired；inspect 呈 expired 终态
  const late2 = await relay.pull("r1", nextSeq, "k1", { holdMs: 20 });
  assert.deepEqual(jsonOf(late2), { code: "response_expired" });
  assert.equal(relay.inspect("r1").terminal.kind, "expired");
  // cancel 同拍：过期墓碑上的幂等取消也回 response_expired
  const cancelLate = await relay.cancel("r1", "ep-fix", "k1");
  assert.equal(cancelLate.status, 404);
  assert.equal(jsonOf(cancelLate).code, "response_expired");
  relay.dispose();
});

// ---------------------------------------------------------------------------
// P2-1 hold 注册 abort 监听后同步复查预中止
// ---------------------------------------------------------------------------

test("P2-1: 预中止复查——初始检查后、监听注册前中止的 signal 秒回 null（不等 hold）", async () => {
  const { relay, handle } = makeRegistry();
  await startMeta(handle);
  // 不产分片——pull 进入 hold；abort 注入在锁裁决与 addEventListener 之间的窗口
  const controller = new AbortController();
  const t0 = Date.now();
  const pullPromise = relay.pull("r1", 0, "k1", { holdMs: 5000, signal: controller.signal });
  queueMicrotask(() => controller.abort()); // 首轮锁裁决后排入（监听注册前命中）
  const res = await withTimeout(pullPromise, 1500, "预中止 pull");
  assert.equal(res, null, "在途拉取 abort=null（消费端本地断开路径）");
  assert.ok(Date.now() - t0 < 1500, `秒回（实测 ${Date.now() - t0}ms < hold 5000ms）`);
  // 对照：未中止的正常 hold 超时=204
  const normal = await relay.pull("r1", 0, "k1", { holdMs: 60 });
  assert.equal(normal.status, 204);
  relay.dispose();
});
