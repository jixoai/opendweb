// HTTP 生命周期信号面 e2e（0.6.0 sdk-lifecycle-signals，node --test）：
// - sessionId：请求事件携带会话 hex id（同 session 稳定；授权隔离键）
// - signal：对端 abort → provider handler 的 AbortSignal 事件驱动触发
//   （挂起中的 handler——尚未 write——也能即时收到）；正常完成不触发
// - writer 三态：finished（本地半关）/ cancelled（对端取消事件）/
//   closed（内核终裁后不再消费）正交
// 顺序跑；所有 Fabric/server/session 显式回收。
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sdkModule from "../index.js";
import { fetchHttp, serveHttp } from "../http/index.js";
const { Fabric } = /** @type {any} */ (sdkModule);

const HAS_CONTINUITY = typeof Fabric?.prototype?.openSession === "function";
const maybeTest = HAS_CONTINUITY ? test : test.skip;

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms);
      t.unref?.();
    }),
  ]);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function pair() {
  const [portA, portB] = await Promise.all([reservePort(), reservePort()]);
  const a = await Fabric.createRoot({
    dataDir: tmpdir("dweb-js-lc-a-"),
    relay: { mode: "disabled" },
    advertiseAddrs: [`127.0.0.1:${portA}`],
    bindAddr: `127.0.0.1:${portA}`,
  });
  const fabricId = await a.fabricIdHex();
  const b = await Fabric.attach(
    { dataDir: tmpdir("dweb-js-lc-b-"), relay: { mode: "disabled" }, bindAddr: `127.0.0.1:${portB}` },
    fabricId,
  );
  const token = await a.invite(300_000, null, { allowRelayless: true });
  await b.join(token);
  await a.addKnownAddr(b.endpointId, `127.0.0.1:${portB}`);
  return { a, b };
}

maybeTest("lifecycle: request event carries sessionId (hex, session-stable)", async () => {
  const { a, b } = await pair();
  let server;
  try {
    /** @type {Array<string>} */
    const seen = [];
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        seen.push(req.sessionId);
        return { status: 200, bodyChunks: [Buffer.from("ok")] };
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    for (let i = 0; i < 2; i++) {
      const resp = await withTimeout(
        fetchHttp(session, { method: "GET", path: "/who" }),
        20_000,
        "fetchHttp head",
      );
      assert.equal(resp.status, 200);
      await resp.readAllBody?.();
    }
    assert.equal(seen.length, 2);
    for (const sid of seen) {
      assert.match(sid, /^[0-9a-f]{32}$/, "sessionId must be 32-char hex");
    }
    assert.equal(seen[0], seen[1], "same session → same sessionId");
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("lifecycle: client abort → req.signal fires + writer.cancelled (pending handler)", async () => {
  const { a, b } = await pair();
  let server;
  try {
    let handlerSawAbort = false;
    let writerRef = null;
    let writeError = null;
    /** @type {((v: void) => void) | undefined} */
    let resolveHandler;
    const handlerDone = new Promise((resolve) => {
      resolveHandler = resolve;
    });
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        writerRef = req.respondStreaming(200, [{ name: "content-type", value: "text/plain" }]);
        assert.ok(writerRef, "writer must exist");
        // 挂起等待 signal——不 write（挂起中的 handler 也必须能收到取消）
        await new Promise((resolve) => {
          if (req.signal.aborted) resolve(undefined);
          else req.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        handlerSawAbort = true;
        // signal 触发后 write 应报错（通道已死/止付）
        try {
          await writerRef.write(Buffer.from("late\n"));
        } catch (e) {
          writeError = e;
        }
        resolveHandler?.();
        // 流式已结算：返回 undefined
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const resp = await withTimeout(
      fetchHttp(session, { method: "GET", path: "/sse" }),
      20_000,
      "fetchHttp head",
    );
    assert.equal(resp.status, 200);
    await resp.abort();
    await withTimeout(handlerDone, 15_000, "handler abort convergence");
    assert.ok(handlerSawAbort, "handler must observe signal abort (event-driven, no write needed)");
    assert.ok(writeError, "write after cancel must reject");
    assert.ok(writerRef.cancelled, "writer.cancelled must flip true");
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("lifecycle: normal completion → signal silent, writer.closed flips, cancelled stays false", async () => {
  const { a, b } = await pair();
  let server;
  try {
    let aborted = false;
    let writerRef = null;
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        req.signal.addEventListener("abort", () => {
          aborted = true;
        });
        writerRef = req.respondStreaming(200, [{ name: "content-type", value: "text/plain" }]);
        await writerRef.write(Buffer.from("one\n"));
        writerRef.finish();
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const resp = await withTimeout(
      fetchHttp(session, { method: "GET", path: "/sse" }),
      20_000,
      "fetchHttp head",
    );
    // 读至 EOF（内核 FIN → mark_completed → watcher 置 closed）
    for (;;) {
      const c = await withTimeout(resp.bodyNext(), 15_000, "bodyNext");
      if (c === null) break;
    }
    // watcher 终裁置位为异步（mark_completed 后）——有界等待翻转
    await withTimeout(
      (async () => {
        while (!writerRef.closed) await sleep(50);
      })(),
      10_000,
      "writer.closed flips",
    );
    assert.ok(writerRef.finished, "finished reflects local finish()");
    assert.ok(writerRef.closed, "closed flips after kernel completes");
    assert.equal(writerRef.cancelled, false, "no cancel on normal completion");
    await sleep(300); // 给可能误发的 cancel 事件留窗口
    assert.equal(aborted, false, "signal must NOT fire on normal completion");
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("lifecycle: fetchHttp signal aborts head-pending request (RESET to provider)", async () => {
  const { a, b } = await pair();
  let server;
  try {
    let handlerSawAbort = false;
    /** @type {((v: void) => void) | undefined} */
    let resolveHandler;
    const handlerDone = new Promise((resolve) => {
      resolveHandler = resolve;
    });
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        // 挂起 handler：不 respondStreaming 也不返回——制造 head 等待形态
        await new Promise((resolve) => {
          if (req.signal.aborted) resolve(undefined);
          else req.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        handlerSawAbort = true;
        resolveHandler?.();
        return { status: 200, bodyChunks: [Buffer.from("late")] };
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const ctrl = new AbortController();
    const pending = fetchHttp(session, { method: "GET", path: "/hang", signal: ctrl.signal });
    // 短暂延迟确保请求已上线（head 等待中）
    await sleep(300);
    ctrl.abort();
    // fetch 以错误结算（head cancelled——不等待 30s 默认超时）
    const t0 = Date.now();
    await assert.rejects(pending, /cancel|timeout|abort|session/i);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5_000, `fetchHttp 应在取消后有界失败（${elapsed}ms）`);
    // provider 侧 signal 触发（事件驱动——RESET 到达）
    await withTimeout(handlerDone, 15_000, "provider handler abort convergence");
    assert.ok(handlerSawAbort, "provider handler must observe signal abort");
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("lifecycle: pre-aborted fetchHttp signal rejects immediately (no wire request)", async () => {
  const { a, b } = await pair();
  let server;
  try {
    let requests = 0;
    server = await withTimeout(
      serveHttp(b, a.endpointId, async () => {
        requests += 1;
        return { status: 200, bodyChunks: [Buffer.from("x")] };
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const ctrl = new AbortController();
    ctrl.abort(); // 先中止，再发起
    const t0 = Date.now();
    await assert.rejects(
      fetchHttp(session, { method: "GET", path: "/pre", signal: ctrl.signal }),
      (e) => e.name === "AbortError",
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `预中止应同步失败（${elapsed}ms）`);
    // 无 wire 请求：provider handler 不得被触达
    await sleep(300);
    assert.equal(requests, 0, "pre-aborted fetch 不得上线");
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("lifecycle: session.close() cancels hanging provider handler promptly (stream RESETs)", async () => {
  const { a, b } = await pair();
  let server;
  try {
    let handlerSawAbort = false;
    /** @type {((v: void) => void) | undefined} */
    let resolveHandler;
    const handlerDone = new Promise((resolve) => {
      resolveHandler = resolve;
    });
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        await new Promise((resolve) => {
          if (req.signal.aborted) resolve(undefined);
          else req.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        handlerSawAbort = true;
        resolveHandler?.();
        return { status: 200, bodyChunks: [] };
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    // 挂起请求（head 等待形态——handler 不返回）
    const pending = fetchHttp(session, { method: "GET", path: "/hang-close" });
    void pending.catch(() => undefined);
    await sleep(300); // 请求上线
    const t0 = Date.now();
    await session.close(); // 刻意关闭：逐流 RESET + FIN
    await withTimeout(handlerDone, 5_000, "provider handler cancel after close");
    const elapsed = Date.now() - t0;
    assert.ok(handlerSawAbort, "close 后 provider signal 必须触发");
    assert.ok(elapsed < 5_000, `close 取消应有界即时（${elapsed}ms）`);
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});
