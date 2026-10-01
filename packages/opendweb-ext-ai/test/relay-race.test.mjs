// 中继竞态矩阵（design §7.3 全清单——tasks B4；逐条对 §3.2 冻结面验收）：
// ①满 buffer×0 拉取背压+并发第二拉取 409 pull_in_flight；②fromSeq 越前 409；
// ③首片 fromSeq=0（cursor 初值 −1）；④204 hold 期产出即返回；⑤hold 20s vs
// 内核 head deadline 30s 边界（常量断言+注入 holdMs 行为断言）；⑥cancel×done
// 交叉（先到定终态幂等）；⑦空闲 TTL 过期；⑧绝对寿命到点 expired 先 abort；
// ⑨done 后旧 seq 不可拉（摘要 only）；⑩provider 重启换 epoch 旧 rid 404；
// ⑪断线重连续拉零重复零丢失（committedSeq 连续）；⑫5MiB 长响应分片完整；
// ⑬EOF 空流零分片立即 done；⑭撤钥三态×在途×拉取（含撤钥后 rid 续拉正例）；
// ⑮env 等值负向（secret 放 env 请求不携带）。
// 时序注入：TTL/寿命/扫描/hold/drain 全部短常量注入（真实计时器）。

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir, callWire, headers, startUpstream, waitFor } from "./helpers.mjs";
import { ProviderStore } from "../src/provider/store.mjs";
import { createAiProviderWireHandler } from "../src/wire/endpoints.mjs";
import { createForwardPlane } from "../src/provider/forward.mjs";
import { LimitEnforcer } from "../src/provider/limits.mjs";
import {
  HDR_DONE,
  HDR_KEY_ID,
  HDR_METHOD,
  HDR_NEXT_SEQ,
  HDR_PATH,
  HDR_SEQ,
  HDR_SERVICE,
  CATALOG_WATCH_TIMEOUT_MS,
  MAX_CHUNK_PAYLOAD,
  PER_REQUEST_BUFFER_BYTES,
} from "../src/wire/constants.mjs";

const HEAD_DEADLINE_MS = 30_000; // 内核 head deadline（design §3.2 边界断言）

/**
 * 装配：openai 服务指向真上游 listener + alpha 组两钥。
 * @param {string} home
 * @param {string} upstreamOrigin
 * @param {{ auth?: object, groupLimits?: object }} [over]
 */
async function fixture(home, upstreamOrigin, over = {}) {
  const store = await ProviderStore.open(aiDataDir(home));
  await store.addService({
    name: "openai",
    upstream: upstreamOrigin,
    match: [{ type: "suffix", value: ".openai.com" }],
    defaultPort: 4300,
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    ...(over.auth !== undefined ? { auth: over.auth } : {}),
  });
  const svcId = store.getServiceByName("openai").serviceId;
  await store.addGroup("alpha", ["openai"], over.groupLimits); // 分组按服务名解析
  const keyA = await store.issueKey("alpha");
  const keyB = await store.issueKey("alpha");
  return { store, svcId, keyA, keyB };
}

/**
 * wire handler（真上游；短常量注入）。
 * @param {ProviderStore} store
 * @param {{ holdMs?: number, idleTtlMs?: number, absoluteLifetimeMs?: number, sweepIntervalMs?: number, drainDeadlineMs?: number, secrets?: (n: string) => string | undefined, forwardPlane?: object }} [over]
 */
function makeHandler(store, over = {}) {
  return createAiProviderWireHandler({
    store,
    probeConnect: async () => undefined,
    timeouts: { connectMs: 2000, firstByteMs: 5000, stallMs: 5000 },
    sweepIntervalMs: over.sweepIntervalMs ?? 20,
    ...(over.holdMs !== undefined ? { holdMs: over.holdMs } : {}),
    ...(over.idleTtlMs !== undefined ? { idleTtlMs: over.idleTtlMs } : {}),
    ...(over.absoluteLifetimeMs !== undefined ? { absoluteLifetimeMs: over.absoluteLifetimeMs } : {}),
    ...(over.drainDeadlineMs !== undefined ? { drainDeadlineMs: over.drainDeadlineMs } : {}),
    ...(over.secrets !== undefined ? { secrets: over.secrets } : {}),
    ...(over.forwardPlane !== undefined ? { forwardPlane: over.forwardPlane } : {}),
  });
}

/** 请求→rid。 */
function mkRequest(handler, svcId, keyId, path = "/v1/chat") {
  return callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, svcId], [HDR_METHOD, "POST"], [HDR_PATH, path], [HDR_KEY_ID, keyId]),
  });
}

/** 拉取。 */
function mkPull(handler, rid, keyId, seq) {
  return callWire(handler, {
    method: "POST",
    path: `/wpk1/ai/v1/response/${rid}`,
    headers: headers([HDR_KEY_ID, keyId], ["x-odai-from-seq", String(seq)]),
  });
}

test("relay-race: 常量边界——hold ≤20s 严小于内核 head deadline 30s；分片/环预算", () => {
  assert.ok(CATALOG_WATCH_TIMEOUT_MS <= 20_000, "hold ≤ 20s");
  assert.ok(CATALOG_WATCH_TIMEOUT_MS < HEAD_DEADLINE_MS, "hold < head deadline 30s");
  assert.equal(MAX_CHUNK_PAYLOAD, 1024 * 1024 - 16 * 1024);
  assert.equal(PER_REQUEST_BUFFER_BYTES, 2 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// ③ 首片 fromSeq=0 + ⑬ EOF 空流零分片立即 done + ⑨ done 后旧 seq 摘要 only
// ---------------------------------------------------------------------------

test("relay-race: 首片 fromSeq=0（cursor 初值 −1）+ EOF 空流=零分片立即 done 摘要", async (t) => {
  const home = await tempHome("odai-rr-eof-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.end();
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store);
  const req = await mkRequest(handler, svcId, keyA.keyId);
  assert.equal(req.status, 200);
  const { responseId, epoch } = req.json();
  assert.match(responseId, /^.+:[0-9]+$/, "responseId=<epoch>:<单调号>");
  // 首个拉取（fromSeq=0=committedSeq(−1)+1）：EOF 空流=零分片+立即 done 摘要
  const first = await mkPull(handler, responseId, keyA.keyId, 0);
  assert.equal(first.status, 200);
  assert.equal(first.header(HDR_DONE), "1");
  assert.equal(first.body.length, 0, "零 body 摘要");
  assert.equal(first.header(HDR_NEXT_SEQ), "0", "committedSeq 仍 −1（零分片确认）");
  // done 后拉取=摘要重放（旧 seq body 不可再拉——⑨）
  const replay = await mkPull(handler, responseId, keyA.keyId, 0);
  assert.equal(replay.status, 200);
  assert.equal(replay.header(HDR_DONE), "1");
  assert.equal(replay.body.length, 0);
  // cancel 幂等终态重放（done 已定终态——先到定终态后到幂等）
  const cancelLate = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/cancel",
    headers: headers([HDR_KEY_ID, keyA.keyId]),
    body: JSON.stringify({ responseId, epoch }),
  });
  assert.equal(cancelLate.status, 200);
  assert.equal(cancelLate.json().status, "done");
});

test("relay-race: fromSeq 越前（未送达不可确认）=409 invalid_from_seq；ring 不提前释放", async (t) => {
  const home = await tempHome("odai-rr-seq-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("chunk-0");
    // 保持连接（不 end）——producedSeq 停在 0
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { holdMs: 50 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  assert.equal(req.status, 200);
  const rid = req.json().responseId;
  // 越前：fromSeq=5（chunk 0 未送达——越前声明确认被拒）
  const ahead = await mkPull(handler, rid, keyA.keyId, 5);
  assert.equal(ahead.status, 409);
  assert.deepEqual(ahead.json(), { code: "invalid_from_seq" });
  // 越前未破坏 ring：fromSeq=0 仍可拉
  const zero = await mkPull(handler, rid, keyA.keyId, 0);
  assert.equal(zero.status, 200);
  assert.equal(zero.header(HDR_SEQ), "0");
  assert.equal(zero.body.toString(), "chunk-0");
  // 同 seq 重试=同内容重放（(epoch,rid,seq) 同键同内容）
  const retry = await mkPull(handler, rid, keyA.keyId, 0);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.toString(), "chunk-0");
  // 推进 fromSeq=1（确认 0）后再回退 0=409
  const one = await mkPull(handler, rid, keyA.keyId, 1);
  assert.equal(one.status, 204, "无更多产出（hold 50ms 超时）");
  assert.equal(one.header(HDR_NEXT_SEQ), "1");
  const back = await mkPull(handler, rid, keyA.keyId, 0);
  assert.equal(back.status, 409);
  assert.deepEqual(back.json(), { code: "invalid_from_seq" });
});

// ---------------------------------------------------------------------------
// ④ 204 hold 期产出即返回 + ⑤ hold 边界（注入 holdMs）
// ---------------------------------------------------------------------------

test("relay-race: 204 hold 期产出即返回（不等待超时）", async (t) => {
  const home = await tempHome("odai-rr-hold-");
  t.after(() => rm(home, { recursive: true, force: true }));
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const up = await startUpstream(async (_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.flushHeaders(); // 头先行（无首字节——hold 语义）
    await gate;
    rs.write("late-chunk");
    rs.end();
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { holdMs: 4000 }); // 长 hold——产出必须立刻唤醒
  const req = await mkRequest(handler, svcId, keyA.keyId);
  assert.equal(req.status, 200);
  const rid = req.json().responseId;
  const pullPromise = mkPull(handler, rid, keyA.keyId, 0);
  await waitFor(() => true, 80);
  const startedAt = Date.now();
  release();
  const res = await pullPromise;
  assert.equal(res.status, 200, "hold 期产出即返回（非 204）");
  assert.equal(res.body.toString(), "late-chunk");
  assert.ok(Date.now() - startedAt < 2000, "产出即唤醒（不等 4s hold 超时）");
});

test("relay-race: hold 超时=204+x-odai-next-seq（holdMs 注入行为边界）", async (t) => {
  const home = await tempHome("odai-rr-holdto-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.flushHeaders(); // 静默体：不写不 end（头先行）
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { holdMs: 150 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const rid = req.json().responseId;
  const t0 = Date.now();
  const res = await mkPull(handler, rid, keyA.keyId, 0);
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 204);
  assert.equal(res.header(HDR_NEXT_SEQ), "0");
  assert.ok(elapsed >= 140 && elapsed < 2000, `204 在 holdMs≈150ms 返回（实测 ${elapsed}ms）`);
});

// ---------------------------------------------------------------------------
// ① 满 buffer 背压 + 并发第二拉取 409 + ⑫ 5MiB 长响应分片完整
// ---------------------------------------------------------------------------

test("relay-race: 满 buffer 背压（0 拉取→上游读暂停；拉取→恢复）+ 5MiB 分片完整零丢失", async (t) => {
  const home = await tempHome("odai-rr-bp-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const TOTAL = 5 * 1024 * 1024;
  const BLOCK = 64 * 1024;
  const blocks = Math.floor(TOTAL / BLOCK);
  const expected = Buffer.alloc(TOTAL, 0);
  for (let i = 0; i < blocks; i++) {
    expected.fill(i % 251, i * BLOCK, (i + 1) * BLOCK);
  }
  let sentBlocks = 0;
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "application/octet-stream" });
    void (async () => {
      for (let i = 0; i < blocks; i++) {
        rs.write(expected.subarray(i * BLOCK, (i + 1) * BLOCK));
        sentBlocks += 1;
        await new Promise((r) => setTimeout(r, 2)); // 快速产出（触发满 buffer）
      }
      rs.end();
    })();
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { idleTtlMs: 60_000, holdMs: 100 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  assert.equal(req.status, 200);
  const rid = req.json().responseId;
  // 0 拉取期：上游产出至满 buffer（2MiB 环+socket 缓冲容差）后读暂停
  await waitFor(() => sentBlocks >= 30, 5000, "upstream produced past ring cap");
  await new Promise((r) => setTimeout(r, 150));
  const stalledAt = sentBlocks;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sentBlocks, stalledAt, "满 buffer 无拉取=上游读暂停（背压）");
  // 拉取驱动：全量消费（分片完整/零丢失/零重复/每片 ≤maxChunkPayload）
  const parts = [];
  let fromSeq = 0;
  let done = false;
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 30_000) {
    const res = await mkPull(handler, rid, keyA.keyId, fromSeq);
    if (res.status === 204) continue;
    assert.ok(res.body.length <= MAX_CHUNK_PAYLOAD, `分片 ≤maxChunkPayload（实测 ${res.body.length}）`);
    parts.push(Buffer.from(res.body));
    fromSeq = Number(res.header(HDR_NEXT_SEQ));
    if (res.header(HDR_DONE) === "1") {
      done = true;
      const confirm = await mkPull(handler, rid, keyA.keyId, fromSeq); // 终态确认（释放占位）
      assert.equal(confirm.status, 200);
      assert.equal(confirm.header(HDR_DONE), "1");
      assert.equal(confirm.body.length, 0);
    }
  }
  assert.ok(done, "5MiB 流完成（绝对寿命内）");
  const received = Buffer.concat(parts);
  assert.equal(received.length, TOTAL, "零丢失（5MiB 完整）");
  assert.ok(received.equals(expected), "字节保序零损坏");
  assert.equal(sentBlocks, blocks, "背压解除后上游全部产出");
});

test("relay-race: 并发第二拉取=409 pull_in_flight（单飞）", async (t) => {
  const home = await tempHome("odai-rr-single-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.flushHeaders(); // 静默体——hold 期
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { holdMs: 300 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const rid = req.json().responseId;
  const mkPullLocal = () => mkPull(handler, rid, keyA.keyId, 0);
  const first = mkPullLocal(); // 进入 hold（单飞占位）
  await waitFor(() => true, 30);
  const second = await mkPullLocal();
  assert.equal(second.status, 409);
  assert.deepEqual(second.json(), { code: "pull_in_flight" });
  const firstRes = await first;
  assert.equal(firstRes.status, 204, "首个拉取正常完成（hold 超时）");
  const after = await mkPullLocal();
  assert.ok(after.status === 204 || after.status === 200, "单飞位已释放");
});

// ---------------------------------------------------------------------------
// ⑥ cancel×done 交叉 + ⑦ 空闲 TTL 过期 + ⑧ 绝对寿命到点 expired 先 abort
// ---------------------------------------------------------------------------

test("relay-race: cancel 中途=cancelled 幂等+上游 abort+拉取 404；done 后 cancel=done 幂等", async (t) => {
  const home = await tempHome("odai-rr-cancel-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream(async (_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("part-0");
    await new Promise((r) => setTimeout(r, 250)); // 取消窗口
    rs.write("part-1");
    rs.end();
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { holdMs: 100 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const { responseId: rid, epoch } = req.json();
  const cancel = () =>
    callWire(handler, {
      method: "POST",
      path: "/wpk1/ai/v1/cancel",
      headers: headers([HDR_KEY_ID, keyA.keyId]),
      body: JSON.stringify({ responseId: rid, epoch }),
    });
  // 先到 cancel 定终态；后到（重复 cancel）幂等同响应
  const c1 = await cancel();
  assert.equal(c1.status, 200);
  assert.deepEqual(c1.json(), { status: "cancelled" });
  const c2 = await cancel();
  assert.deepEqual(c2.json(), { status: "cancelled" });
  const pull = await mkPull(handler, rid, keyA.keyId, 0);
  assert.equal(pull.status, 404);
  assert.deepEqual(pull.json(), { code: "response_not_found" });
  await waitFor(() => up.activeConnections === 0, 3000, "cancel 后上游 abort");
  // done 先到：完整消费后 cancel→幂等 {status:"done"}（先到定终态）
  const req2 = await mkRequest(handler, svcId, keyA.keyId);
  assert.equal(req2.status, 200, "取消流占位即时释放（后续请求不受已撤流拖累）");
  const rid2 = req2.json().responseId;
  let fromSeq = 0;
  for (;;) {
    const res = await mkPull(handler, rid2, keyA.keyId, fromSeq);
    if (res.status === 204) continue; // 产出竞态：hold 醒来即重试
    assert.equal(res.status, 200);
    fromSeq = Number(res.header(HDR_NEXT_SEQ));
    if (res.header(HDR_DONE) === "1") {
      await mkPull(handler, rid2, keyA.keyId, fromSeq); // 终态确认
      break;
    }
  }
  const cancelAfterDone = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/cancel",
    headers: headers([HDR_KEY_ID, keyA.keyId]),
    body: JSON.stringify({ responseId: rid2, epoch: req2.json().epoch }),
  });
  assert.equal(cancelAfterDone.status, 200);
  assert.deepEqual(cancelAfterDone.json(), { status: "done" });
});

test("relay-race: 空闲 TTL 过期=404 response_expired+上游 abort（204 hold 不续 TTL）", async (t) => {
  const home = await tempHome("odai-rr-idle-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("x");
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { idleTtlMs: 250, holdMs: 80 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const rid = req.json().responseId;
  const res = await mkPull(handler, rid, keyA.keyId, 0);
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "x");
  await new Promise((r) => setTimeout(r, 450)); // 空闲越界（200 活动后无拉取）
  const late = await mkPull(handler, rid, keyA.keyId, 1);
  assert.equal(late.status, 404);
  assert.deepEqual(late.json(), { code: "response_expired" });
  await waitFor(() => up.activeConnections === 0, 3000, "空闲过期先 abort 上游");
});

test("relay-race: 绝对寿命到点=expired 先 abort（拉取保持活动也不豁免）", async (t) => {
  const home = await tempHome("odai-rr-abs-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream(async (_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 100; i++) {
      rs.write(`event-${i}\n`);
      await new Promise((r) => setTimeout(r, 40));
    }
    rs.end();
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { idleTtlMs: 60_000, absoluteLifetimeMs: 600, holdMs: 60 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const rid = req.json().responseId;
  let sawExpired = false;
  let fromSeq = 0;
  const t0 = Date.now();
  while (!sawExpired && Date.now() - t0 < 4000) {
    const res = await mkPull(handler, rid, keyA.keyId, fromSeq);
    if (res.status === 404 && res.json().code === "response_expired") {
      sawExpired = true;
      break;
    }
    if (res.status === 200) fromSeq = Number(res.header(HDR_NEXT_SEQ));
  }
  assert.ok(sawExpired, "绝对寿命到点=expired（持续拉取不豁免）");
  await waitFor(() => up.activeConnections === 0, 3000, "expired 先 abort 上游");
});

// ---------------------------------------------------------------------------
// ⑩ provider 重启换 epoch 旧 rid 404
// ---------------------------------------------------------------------------

test("relay-race: provider 重启（epoch 更替）→旧 rid 404 response_not_found", async (t) => {
  const home = await tempHome("odai-rr-epoch-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("before-restart");
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const req1 = await mkRequest(makeHandler(store), svcId, keyA.keyId);
  const { responseId: oldRid, epoch: oldEpoch } = req1.json();
  // 「重启」=新 handler+新 forward plane（新 epoch CSPRNG；同一 store/密钥）
  const h2 = makeHandler(store);
  const pullOld = await mkPull(h2, oldRid, keyA.keyId, 0);
  assert.equal(pullOld.status, 404);
  assert.deepEqual(pullOld.json(), { code: "response_not_found" });
  const cancelOld = await callWire(h2, {
    method: "POST",
    path: "/wpk1/ai/v1/cancel",
    headers: headers([HDR_KEY_ID, keyA.keyId]),
    body: JSON.stringify({ responseId: oldRid, epoch: oldEpoch }),
  });
  assert.equal(cancelOld.status, 404, "旧 epoch 声明≠新 epoch");
  const req2 = await mkRequest(h2, svcId, keyA.keyId);
  assert.equal(req2.status, 200);
  assert.notEqual(req2.json().epoch, oldEpoch, "新 epoch（进程启动 CSPRNG）");
});

// ---------------------------------------------------------------------------
// ⑪ 断线重连续拉零重复零丢失（committedSeq 连续）
// ---------------------------------------------------------------------------

test("relay-race: 断线重连续拉（空闲窗口内）零重复零丢失", async (t) => {
  const home = await tempHome("odai-rr-resume-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const events = [];
  for (let i = 0; i < 16; i++) events.push(`data: event-${i}\n\n`);
  const expectedAll = Buffer.from(events.join(""));
  const up = await startUpstream(async (_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) {
      rs.write(e);
      await new Promise((r) => setTimeout(r, 30));
    }
    rs.end();
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { idleTtlMs: 8_000, holdMs: 60 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const rid = req.json().responseId;
  const parts = [];
  const seqs = [];
  let fromSeq = 0;
  // 消费 3 轮后「断线」（停止拉取 600ms——恢复窗口 < 空闲 TTL）
  for (let round = 0; round < 60; round++) {
    if (round === 3) await new Promise((r) => setTimeout(r, 600));
    const res = await mkPull(handler, rid, keyA.keyId, fromSeq);
    if (res.status === 204) continue;
    seqs.push(Number(res.header(HDR_SEQ)));
    parts.push(Buffer.from(res.body));
    fromSeq = Number(res.header(HDR_NEXT_SEQ));
    if (res.header(HDR_DONE) === "1") {
      await mkPull(handler, rid, keyA.keyId, fromSeq); // 终态确认
      break;
    }
  }
  // committedSeq 连续（零重复：seq 严格递增 1；零丢失：字节全量）
  for (let i = 0; i < seqs.length; i++) assert.equal(seqs[i], i, `seq 连续（${i}）`);
  assert.ok(Buffer.concat(parts).equals(expectedAll), "断线续拉零重复零丢失（字节全量相等）");
});

// ---------------------------------------------------------------------------
// ⑭ 撤钥三态×在途×拉取
// ---------------------------------------------------------------------------

test("relay-race: 撤钥①单 keyId——新 request 403 key_revoked；在途 rid 按快照续拉至 done（正例）", async (t) => {
  const home = await tempHome("odai-rr-revoke1-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream(async (_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 8; i++) {
      rs.write(`revoked-stream-${i}\n`);
      await new Promise((r) => setTimeout(r, 25));
    }
    rs.end();
  });
  t.after(() => up.close());
  const { store, svcId, keyA, keyB } = await fixture(home, up.origin);
  const handler = makeHandler(store, { holdMs: 60 });
  const inFlight = await mkRequest(handler, svcId, keyA.keyId);
  assert.equal(inFlight.status, 200);
  const rid = inFlight.json().responseId;
  await store.revokeKey(keyA.keyId); // ①单钥撤销（keyB 仍有效）
  const afterRevoke = await mkRequest(handler, svcId, keyA.keyId);
  assert.equal(afterRevoke.status, 403);
  assert.equal(afterRevoke.json().code, "key_revoked");
  const other = await mkRequest(handler, svcId, keyB.keyId);
  assert.equal(other.status, 200, "session 另有有效 key——不断流");
  await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/cancel",
    headers: headers([HDR_KEY_ID, keyB.keyId]),
    body: JSON.stringify({ responseId: other.json().responseId, epoch: other.json().epoch }),
  });
  // 在途 rid 续拉至 done（创建时快照——response 拉取不因撤钥 403）
  const parts = [];
  let fromSeq = 0;
  let done = false;
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 5000) {
    const res = await mkPull(handler, rid, keyA.keyId, fromSeq);
    assert.notEqual(res.status, 403, "在途 rid 拉取不因撤钥 403（drain 闭合）");
    if (res.status === 204) continue;
    parts.push(Buffer.from(res.body));
    fromSeq = Number(res.header(HDR_NEXT_SEQ));
    if (res.header(HDR_DONE) === "1") {
      done = true;
      await mkPull(handler, rid, keyA.keyId, fromSeq);
    }
  }
  assert.ok(done, "撤钥后在途 rid 续拉至终态（正例）");
  const text = Buffer.concat(parts).toString();
  for (let i = 0; i < 8; i++) assert.ok(text.includes(`revoked-stream-${i}`), `分片 ${i} 完整`);
});

test("relay-race: 撤钥②全钥失效 drain——deadline 后在途 abort auth_revoked（wire 拉取=503）", async (t) => {
  const home = await tempHome("odai-rr-revoke2-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("s0");
    // 长流不 settle（drain deadline 内）
  });
  t.after(() => up.close());
  const { store, svcId, keyA, keyB } = await fixture(home, up.origin);
  // 自建 plane 注入 handler（drain 面经宿主装配路径）
  const limits = new LimitEnforcer({ dataDir: store.dataDir });
  limits.syncFromStore(store);
  const plane = createForwardPlane({
    store,
    limits,
    probeConnect: async () => undefined,
    timeouts: { connectMs: 2000, firstByteMs: 5000, stallMs: 5000 },
    sweepIntervalMs: 20,
  });
  const handler = makeHandler(store, { holdMs: 60, forwardPlane: plane });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const rid = req.json().responseId;
  // 全钥失效（keyA+keyB 都撤——该 session 持有的全部 key）
  await store.revokeKey(keyA.keyId);
  await store.revokeKey(keyB.keyId);
  // 在 drain deadline 前在途仍可拉（快照）
  const pre = await mkPull(handler, rid, keyA.keyId, 0);
  assert.equal(pre.status, 200);
  assert.equal(pre.body.toString(), "s0");
  // ②drain：5s 有界（注入 150ms）——未 settle 即 abort auth_revoked
  const drained = await plane.relay.drainForKeys([keyA.keyId, keyB.keyId], { deadlineMs: 150 });
  assert.equal(drained.length, 1);
  assert.equal(drained[0].outcome, "error");
  const post = await mkPull(handler, rid, keyA.keyId, 1);
  assert.equal(post.status, 503, "auth_revoked→503");
  assert.equal(post.json().code, "auth_revoked");
  await waitFor(() => up.activeConnections === 0, 3000, "drain 后上游 abort");
  await plane.dispose();
});

test("relay-race: ③gate/会话收敛 closeAll——在途 aborted（拉取 504 显式错误）", async (t) => {
  const home = await tempHome("odai-rr-close-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("s0");
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const limits = new LimitEnforcer({ dataDir: store.dataDir });
  limits.syncFromStore(store);
  const plane = createForwardPlane({
    store,
    limits,
    probeConnect: async () => undefined,
    timeouts: { connectMs: 2000, firstByteMs: 5000, stallMs: 5000 },
    sweepIntervalMs: 20,
  });
  const handler = makeHandler(store, { holdMs: 60, forwardPlane: plane });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const rid = req.json().responseId;
  await plane.relay.closeAll({ code: "aborted" }); // 会话关闭/gate 撤销→在途随会话收敛
  const pull = await mkPull(handler, rid, keyA.keyId, 0);
  assert.equal(pull.status, 504);
  assert.equal(pull.json().code, "aborted");
  await waitFor(() => up.activeConnections === 0, 3000, "closeAll 后上游 abort");
  await plane.dispose();
});

// ---------------------------------------------------------------------------
// ⑮ env 等值负向（secret 放 env 请求不携带）
// ---------------------------------------------------------------------------

test("relay-race: env 等值负向——槽解析不经 env（等值 env 存在时请求仍只携带槽值）", async (t) => {
  const home = await tempHome("odai-rr-env-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((_rq, rs) => {
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end("{}");
  });
  t.after(() => up.close());
  const { SecretsStore } = await import("../src/provider/secrets.mjs");
  const secretsStore = await SecretsStore.open(aiDataDir(home));
  const SLOT_VALUE = "sk-slot-secret-value-9f1";
  const OTHER_VALUE = "sk-rotated-slot-value-2c";
  await secretsStore.set("openai-key", SLOT_VALUE);
  const { store, svcId, keyA } = await fixture(home, up.origin, { auth: { secret: "openai-key" } });
  // ambient env 放入**等值** secret（负向：槽解析不经 env——请求携带的恒为槽值）
  process.env.ODAI_RR_LEAK_EQ = SLOT_VALUE;
  process.env.ODAI_RR_LEAK_OTHER = OTHER_VALUE;
  t.after(() => {
    delete process.env.ODAI_RR_LEAK_EQ;
    delete process.env.ODAI_RR_LEAK_OTHER;
  });
  const handler = makeHandler(store, { secrets: (name) => secretsStore.get(name) });
  const mk = () =>
    callWire(handler, {
      method: "POST",
      path: "/wpk1/ai/v1/request",
      headers: headers([HDR_SERVICE, svcId], [HDR_METHOD, "GET"], [HDR_PATH, "/v1/models"], [HDR_KEY_ID, keyA.keyId]),
    });
  const first = await mk();
  assert.equal(first.status, 200);
  await waitFor(() => up.hits.length === 1, 3000, "upstream hit");
  assert.equal(up.hits[0].headers.authorization, `Bearer ${SLOT_VALUE}`, "槽值注入（等值 env 不构成第二条通道）");
  // 槽值轮换：env 等值不变——上游只见新槽值
  await secretsStore.set("openai-key", OTHER_VALUE);
  const second = await mk();
  assert.equal(second.status, 200);
  await waitFor(() => up.hits.length === 2, 3000, "upstream hit 2");
  assert.equal(up.hits[1].headers.authorization, `Bearer ${OTHER_VALUE}`, "轮换后=新槽值（非 env 值）");
  // 删除槽：secret_missing（env 等值不得顶替；零上游触达）
  await secretsStore.remove("openai-key");
  const third = await mk();
  assert.equal(third.status, 502);
  assert.equal(third.json().code, "secret_missing");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(up.hits.length, 2, "secret_missing 零上游触达");
});

// ---------------------------------------------------------------------------
// ⑨ 补：done 后旧 seq 不可拉（多分片流——body 弃+摘要 only）
// ---------------------------------------------------------------------------

test("relay-race: done 后旧 seq body 不可再拉（摘要 only）", async (t) => {
  const home = await tempHome("odai-rr-dropslots-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream(async (_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("alpha\n");
    rs.write("beta\n");
    rs.write("gamma\n");
    rs.end();
  });
  t.after(() => up.close());
  const { store, svcId, keyA } = await fixture(home, up.origin);
  const handler = makeHandler(store, { holdMs: 60 });
  const req = await mkRequest(handler, svcId, keyA.keyId);
  const rid = req.json().responseId;
  const pull = (seq) => mkPull(handler, rid, keyA.keyId, seq);
  // 全量消费至 done（三块可能并成一个分片——按 next-seq 推进）
  const parts = [];
  let fromSeq = 0;
  let done = false;
  while (!done) {
    const res = await pull(fromSeq);
    assert.equal(res.status, 200);
    parts.push(Buffer.from(res.body));
    fromSeq = Number(res.header(HDR_NEXT_SEQ));
    if (res.header(HDR_DONE) === "1") {
      await pull(fromSeq); // 终态确认
      done = true;
    }
  }
  assert.equal(Buffer.concat(parts).toString(), "alpha\nbeta\ngamma\n");
  // done 后：任意旧 seq 拉取=摘要 200 零 body（body 分片即弃）
  for (const seq of [0, 1, 2, fromSeq]) {
    const old = await pull(seq);
    assert.equal(old.status, 200, `seq=${seq} 摘要 only`);
    assert.equal(old.header(HDR_DONE), "1");
    assert.equal(old.body.length, 0, "零 body（旧分片不可再拉）");
  }
});
