// 分层 transport 包络测试（webui-plugin-kernel r8-B4 最小清单第 3 项——ports 面）。
// 共享替身：packages/webui/test/plugin-transport-double.mjs——真实建立 1MiB 帧
// （session.rs MAX_FRAME）/2MiB 流/8MiB 会话三层账；单机 loopback（内存 bridge）
// 不再绕过真双机才会暴露的包络失败。覆盖：
// 1. 旧「单 Buffer 一次性发送」形态（>1MiB 单元素）在 transport 层即被帧层拦下
//    ——provider 零副作用（fetchCalls=0）；
// 2. 恰 1MiB 请求体（v1 有效包络边界）经三层账通过，响应读尽后会话账释放；
// 3. 并发在飞聚合超 8MiB（9×1MiB）触发会话层稳定拒绝（journal
//    max_session_bytes 语义——「未消费 ⟹ 未 ACK ⟹ 仍在发送方 journal」）。

import test from "node:test";
import assert from "node:assert/strict";
import { createFabricBridge } from "./helpers.mjs";
import {
  wrapPortsFetchHttp,
  createSessionLedger,
  TransportEnvelopeError,
} from "../../webui/test/plugin-transport-double.mjs";

const MIB = 1024 * 1024;

/** 静态 200 handler（transport 层测试不需要真实 provider 语义） */
const okHandler = async () => ({ status: 200, headers: [], bodyChunks: [Buffer.from("ok")] });

test("envelope: legacy single-buffer >1MiB body is frame-rejected at the transport layer with zero provider side effects", async () => {
  const bridge = createFabricBridge(okHandler);
  const wrapped = wrapPortsFetchHttp(bridge.fetchHttpImpl);
  await assert.rejects(
    () => wrapped({ sessionId: "s" }, { method: "POST", path: "/wpk1/ports/proxy/8080/x", body: [new Uint8Array(Buffer.alloc(2 * MIB, 0x61))] }),
    (e) => e instanceof TransportEnvelopeError && e.layer === "frame" && e.code === "frame-too-large",
  );
  assert.equal(bridge.fetchCalls.length, 0, "over-envelope request never reached the provider");
});

test("envelope: exactly-1MiB proxied body passes the three-layer ledger and releases the session account on response EOF", async () => {
  const bridge = createFabricBridge(okHandler);
  const ledger = createSessionLedger();
  const wrapped = wrapPortsFetchHttp(bridge.fetchHttpImpl, { ledger });
  const resp = await wrapped({ sessionId: "s" }, { method: "POST", path: "/wpk1/ports/proxy/8080/x", body: [new Uint8Array(Buffer.alloc(MIB, 0x62))] });
  assert.equal(resp.status, 200);
  assert.equal(ledger.heldBytes(), MIB, "request bytes are held until the response drains (un-acked journal)");
  /** @type {Buffer[]} */
  const parts = [];
  for (;;) {
    const chunk = await resp.bodyNext();
    if (chunk === null) break;
    parts.push(chunk);
  }
  assert.equal(Buffer.concat(parts).toString(), "ok");
  assert.equal(ledger.heldBytes(), 0, "session account released at response EOF");
  // 顺序请求不累积（journal ACK 释放语义）
  const resp2 = await wrapped({ sessionId: "s" }, { method: "POST", path: "/wpk1/ports/proxy/8080/y", body: [new Uint8Array(Buffer.alloc(MIB, 0x63))] });
  for (;;) {
    if ((await resp2.bodyNext()) === null) break;
  }
  assert.equal(ledger.heldBytes(), 0);
  assert.equal(bridge.fetchCalls.length, 2);
});

test("envelope: 9 concurrent 1MiB in-flight requests exceed the 8MiB session account (journal session cap)", async () => {
  const bridge = createFabricBridge(okHandler);
  const ledger = createSessionLedger();
  /** 响应闸门：并发在飞期间不结算（慢消费者——journal 不释放） */
  let openGate = () => {};
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const gated = async (session, init) => {
    await gate;
    return bridge.fetchHttpImpl(session, init);
  };
  const wrapped = wrapPortsFetchHttp(gated, { ledger });
  const session = { sessionId: "s" };
  const calls = Array.from({ length: 9 }, (_, i) =>
    wrapped(session, { method: "POST", path: `/wpk1/ports/proxy/8080/${i}`, body: [new Uint8Array(Buffer.alloc(MIB, 0x64 + i))] })
      .then(async (resp) => {
        for (;;) {
          if ((await resp.bodyNext()) === null) break;
        }
        return resp;
      }),
  );
  // 8×1MiB 在飞=8MiB 会话账满；第 9 个请求（1MiB）超账 → 会话层稳定拒绝
  await assert.rejects(() => Promise.all(calls), (e) => {
    assert.ok(e instanceof TransportEnvelopeError, String(e));
    assert.equal(e.layer, "session");
    assert.equal(e.code, "session-exceeds-journal");
    return true;
  });
  openGate();
  const settled = await Promise.allSettled(calls);
  const fulfilled = settled.filter((r) => r.status === "fulfilled").length;
  assert.equal(fulfilled, 8, "the first 8 in-flight requests complete after the gate opens");
  assert.equal(ledger.heldBytes(), 0, "session account drains as responses complete");
});
