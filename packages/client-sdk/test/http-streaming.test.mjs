// HTTP 流式面 e2e（B1/B2 收口，node --test）：
// - respondStreaming：响应头立即发出 + body 逐块 write（SSE 形态——首块到达
//   早于 handler 完成，证明真实流式而非聚齐后一次性下发）
// - per-request abort：client abort() → provider 写面报错（RESET 止付链），
//   provider handler 提前收敛（本地断开 → 上游关闭）
// - headTimeoutMs：响应头等待上限可配（收紧后快速失败）
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
    dataDir: tmpdir("dweb-js-str-a-"),
    relay: { mode: "disabled" },
    advertiseAddrs: [`127.0.0.1:${portA}`],
    bindAddr: `127.0.0.1:${portA}`,
  });
  const fabricId = await a.fabricIdHex();
  const b = await Fabric.attach(
    { dataDir: tmpdir("dweb-js-str-b-"), relay: { mode: "disabled" }, bindAddr: `127.0.0.1:${portB}` },
    fabricId,
  );
  const token = await a.invite(300_000, null, { allowRelayless: true });
  await b.join(token);
  await a.addKnownAddr(b.endpointId, `127.0.0.1:${portB}`);
  return { a, b };
}

maybeTest("streaming: respondStreaming flushes head + chunks live (SSE form)", async () => {
  const { a, b } = await pair();
  let server;
  try {
    const CHUNKS = 4;
    const chunkDelayMs = 250;
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        assert.equal(req.path, "/sse");
        const writer = req.respondStreaming(200, [
          { name: "content-type", value: "text/event-stream" },
        ]);
        assert.ok(writer, "respondStreaming must return a writer");
        for (let i = 0; i < CHUNKS; i++) {
          await writer.write(Buffer.from(`token-${i}\n`));
          await sleep(chunkDelayMs);
        }
        writer.finish();
        // 流式已结算：返回 undefined（glue 跳过静态兜底）
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
    // 首块必须早于全部 chunk 写完（真实流式：CHUNKS-1 个间隔内已到首块）
    const first = await withTimeout(resp.bodyNext(), (CHUNKS - 1) * chunkDelayMs, "first chunk arrives live");
    assert.equal(first.toString(), "token-0\n");
    const rest = [];
    for (;;) {
      const c = await withTimeout(resp.bodyNext(), 15_000, "bodyNext");
      if (c === null) break;
      rest.push(c);
    }
    assert.equal(Buffer.concat(rest).toString(), Array.from({ length: CHUNKS - 1 }, (_, i) => `token-${i + 1}\n`).join(""));
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("streaming: client abort() → provider write errors + handler converges early", async () => {
  const { a, b } = await pair();
  let server;
  try {
    let handlerSettled = false;
    let writeError = null;
    let signalWriteStart;
    const writeStarted = new Promise((resolve) => {
      signalWriteStart = resolve;
    });
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        const writer = req.respondStreaming(200, [{ name: "content-type", value: "text/plain" }]);
        signalWriteStart();
        try {
          // 持续写：client abort → RESET → 引擎止付 → 通道关闭 → write 报错
          for (let i = 0; i < 64; i++) {
            await writer.write(Buffer.alloc(64 * 1024, 0x41));
            await sleep(50);
          }
          writer.finish();
        } catch (err) {
          writeError = err;
        } finally {
          handlerSettled = true;
        }
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const resp = await withTimeout(
      fetchHttp(session, { method: "GET", path: "/stream" }),
      20_000,
      "fetchHttp head",
    );
    assert.equal(resp.status, 200);
    await writeStarted;
    await resp.bodyNext(); // 消费首块（确认供给面已建立）
    await resp.abort();
    // provider handler 在有界时间内收敛（写面报错——上游关闭链路）
    const deadline = Date.now() + 15_000;
    while (!handlerSettled && Date.now() < deadline) await sleep(100);
    assert.ok(handlerSettled, "provider handler must converge after client abort");
    assert.ok(writeError, "provider write must surface cancel (peer reset)");
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("fetch: headTimeoutMs configurable (tight timeout fails fast)", async () => {
  const { a, b } = await pair();
  let server;
  try {
    server = await withTimeout(
      serveHttp(b, a.endpointId, async () => {
        await sleep(5_000); // 头晚于收紧的超时
        return { status: 200, bodyChunks: [Buffer.from("late")] };
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const t0 = Date.now();
    await assert.rejects(
      () => withTimeout(fetchHttp(session, { method: "GET", path: "/slow-head", headTimeoutMs: 800 }), 10_000, "tight head timeout"),
      /head timeout|timeout/i,
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 4_000, `tight headTimeoutMs must fail fast (elapsed ${elapsed}ms)`);
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

// r11 B1/B2 体完整性终态（N-API 集成面）：
// - provider writer.abort()（active）→ 消费端 bodyNext 必须 reject（绝不
//   resolve null——截断不得伪装干净 EOF；修复前 abort 与 dispatch FIN 竞速
//   可让客户端以 null 收尾出空/截断 200）。
// - Recovering 窗口内 abort（RESET best-effort 失败）→ 恢复后经重放面补发
//   RESET，bodyNext 仍以 reject 终结（终态跨恢复代保留）。
maybeTest("streaming: provider writer.abort() mid-stream → client bodyNext rejects (never clean null)", async () => {
  const { a, b } = await pair();
  let server;
  try {
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        assert.equal(req.path, "/provider-abort");
        const writer = req.respondStreaming(200, [{ name: "content-type", value: "text/plain" }]);
        await writer.write(Buffer.from("prefix-chunk;"));
        await sleep(100); // 让前缀先行交付（截断形态：部分体已到）
        writer.abort();
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const resp = await withTimeout(
      fetchHttp(session, { method: "GET", path: "/provider-abort" }),
      20_000,
      "fetchHttp head",
    );
    assert.equal(resp.status, 200);
    const first = await withTimeout(resp.bodyNext(), 10_000, "first chunk");
    assert.equal(first.toString(), "prefix-chunk;");
    // 终态断言：必须以错误终结（reset by peer），绝不 resolve null
    await assert.rejects(
      () => withTimeout(resp.bodyNext(), 15_000, "terminal bodyNext"),
      (err) => {
        assert.match(err.message, /reset by peer|session/i, `terminal must be an error, got: ${err.message}`);
        return true;
      },
    );
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("streaming: provider abort during recovery → RESET re-delivered after resume, bodyNext rejects", async () => {
  const { a, b } = await pair();
  let server;
  try {
    let abortNow;
    const abortSignal = new Promise((resolve) => {
      abortNow = resolve;
    });
    server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        assert.equal(req.path, "/recover-abort");
        const writer = req.respondStreaming(200, [{ name: "content-type", value: "text/plain" }]);
        await writer.write(Buffer.from("first;"));
        await abortSignal; // 主测在通道死亡后才放行（RESET 发送必然失败）
        writer.abort();
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const resp = await withTimeout(
      fetchHttp(session, { method: "GET", path: "/recover-abort" }),
      20_000,
      "fetchHttp head",
    );
    assert.equal(resp.status, 200);
    const first = await withTimeout(resp.bodyNext(), 10_000, "first chunk");
    assert.equal(first.toString(), "first;");
    // 注入死亡（会话 Recovering）→ 在死通道上中止 → auto-resume 经重放补发 RESET
    await a.continuityReset(b.endpointId);
    abortNow();
    // 终态断言（恢复补发后）：必须以错误终结，绝不 resolve null
    await assert.rejects(
      () => withTimeout(resp.bodyNext(), 30_000, "terminal bodyNext after recovery"),
      (err) => {
        assert.match(err.message, /reset by peer|session/i, `terminal must be an error, got: ${err.message}`);
        return true;
      },
    );
    await session.close();
  } finally {
    await server?.close();
    await a.shutdown();
    await b.shutdown();
  }
});
