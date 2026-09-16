// continuity HTTP e2e（app-protocol-layer task 4.2，node --test）。
// 覆盖：
// - 单进程组网（root+attach+join+addKnownAddr，固定端口对拨——镜像 crates
//   continuity_http.rs 的 pair() 拓扑）
// - fetchHttp POST echo 往返（serveHttp handler + bodyNext 拉取 + asyncIterator）
// - SSE 透明断线续传：handler 在途时注入 continuityReset → body 全部经
//   auto-resume 到达（JS 读循环不重启）→ 字节级精确 + handler 执行恰好一次
// - exports map 五子路径 require/import/自引用解析见 exports-map.test.mjs
//
// 顺序跑（node --test 文件内默认串行）；所有 Fabric 显式 shutdown 回收。
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sdkModule from "../index.js";
import { fetchHttp, serveHttp } from "../http/index.js";
import { serverStats } from "../http/internals.js";
import { journalBytes } from "../net/internals.js";
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

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(50);
  }
  throw new Error(`waitFor timeout: ${what}`);
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

/** 单进程 pair 组网（A=root/client，B=attach/provider；固定端口对拨） */
async function pair() {
  const [portA, portB] = await Promise.all([reservePort(), reservePort()]);
  const a = await Fabric.createRoot({
    dataDir: tmpdir("dweb-js-e2e-a-"),
    relay: { mode: "disabled" },
    advertiseAddrs: [`127.0.0.1:${portA}`],
    bindAddr: `127.0.0.1:${portA}`,
  });
  const fabricId = await a.fabricIdHex();
  const b = await Fabric.attach(
    { dataDir: tmpdir("dweb-js-e2e-b-"), relay: { mode: "disabled" }, bindAddr: `127.0.0.1:${portB}` },
    fabricId,
  );
  const token = await a.invite(300_000, null, { allowRelayless: true });
  await b.join(token);
  await a.addKnownAddr(b.endpointId, `127.0.0.1:${portB}`);
  return { a, b };
}

/** §3.4 body AsyncIterable 投影（for-await 逐块 pull；EOF 结束） */
async function readAllBody(resp, msTotal = 30_000) {
  const out = [];
  const loop = (async () => {
    for await (const c of resp) out.push(c);
  })();
  await withTimeout(loop, msTotal, "readAllBody");
  return Buffer.concat(out);
}

maybeTest("http e2e: POST echo roundtrip (serveHttp handler + pull-first body)", async () => {
  const { a, b } = await pair();
  try {
    let handlerCalls = 0;
    const server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        handlerCalls += 1;
        assert.equal(req.method, "POST");
        assert.equal(req.path, "/echo");
        const chunks = [];
        for (;;) {
          const c = await withTimeout(req.bodyNext(), 15_000, "handler bodyNext");
          if (c === null) break;
          chunks.push(c);
        }
        const body = Buffer.concat(chunks);
        return {
          status: 200,
          headers: [
            { name: "content-type", value: "application/json" },
            { name: "x-dup", value: "1" },
            { name: "x-dup", value: "2" }, // 数组保重复项（§3.4）
          ],
          bodyChunks: [body],
        };
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    assert.equal(session.peerId, b.endpointId);
    assert.match(session.sessionId, /^[0-9a-f]{32}$/);

    const resp = await withTimeout(
      fetchHttp(session, {
        method: "POST",
        path: "/echo",
        headers: [{ name: "content-type", value: "application/json" }],
        body: [Buffer.from("hello "), Buffer.from("engine")], // 静态分块
      }),
      20_000,
      "fetchHttp",
    );
    assert.equal(resp.status, 200);
    const ct = resp.headers.find((h) => h.name === "content-type");
    assert.equal(ct?.value, "application/json");
    assert.equal(resp.headers.filter((h) => h.name === "x-dup").length, 2, "重复头保序保重");

    // pull-first：bodyNext 逐块拉取
    const body = await readAllBody(resp);
    assert.equal(body.toString("utf8"), "hello engine");

    // 状态快照（§3.2 对齐子集）
    const state = await session.state();
    assert.equal(state.phase, "active");
    assert.equal(state.peerId, b.endpointId);
    assert.equal(state.sessionId, session.sessionId);
    assert.ok(state.streamCount >= 1, "至少一个活跃流");
    // 内部面观测：请求流 journal 在 ACK 推进后释放
    let released = false;
    for (let i = 0; i < 100 && !released; i++) {
      released = (await journalBytes(session, resp.streamId)) === 0;
      if (!released) await sleep(100);
    }
    assert.ok(released, "client journal 应在 ACK 后释放");

    assert.equal(handlerCalls, 1);
    await session.close();
    await server.close();
    const after = await session.state();
    assert.equal(after.phase, "closed");
  } finally {
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("sse e2e: transparent auto-resume across continuityReset, byte-exact, handler once", async () => {
  const { a, b } = await pair();
  try {
    let execCount = 0;
    let releaseBody;
    const bodyGate = new Promise((r) => {
      releaseBody = r;
    });
    const expectedChunks = [];
    for (let i = 0; i < 10; i++) {
      expectedChunks.push(Buffer.from(`data: tick-${String(i).padStart(2, "0")}\n\n`));
    }
    const expected = Buffer.concat(expectedChunks);

    // handler 等 bodyGate 放行——保证注入死亡时**没有任何 body chunk 到达
    // client**（meta 行也尚未发），续传数据必须全部经 auto-resume 恢复路径到达
    const server = await withTimeout(
      serveHttp(b, a.endpointId, async () => {
        execCount += 1;
        await bodyGate;
        return {
          status: 200,
          headers: [{ name: "content-type", value: "text/event-stream" }],
          bodyChunks: expectedChunks,
        };
      }),
      10_000,
      "serveHttp",
    );

    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const states = [];
    session.onState((s) => states.push(s.phase));

    const respPromise = fetchHttp(session, { method: "GET", path: "/sse" });

    // 请求已到 provider（handler 在途）→ 注入连接死亡 → 放行 body。
    // 此刻 meta 行尚未发出（内核 dispatch 在 handler 返回后才发首块）——
    // 后续所有数据必须经 auto-resume 恢复路径到达。
    await waitFor(
      () => serverStats(server.native).pendingRequests === 1,
      10_000,
      "handler in flight",
    );
    await a.continuityReset(b.endpointId);
    releaseBody();

    const resp = await withTimeout(respPromise, 30_000, "fetchHttp after reset");
    assert.equal(resp.status, 200);
    assert.equal(
      resp.headers.find((h) => h.name === "content-type")?.value,
      "text/event-stream",
    );

    // 单一读循环（不重启）：auto-resume 对 JS 透明
    const collected = [];
    for (;;) {
      const c = await withTimeout(resp.bodyNext(), 30_000, "sse bodyNext");
      if (c === null) break;
      collected.push(c);
    }
    assert.equal(Buffer.concat(collected).toString("utf8"), expected.toString("utf8"), "字节级精确");
    assert.ok(collected.length >= 2, "chunk 化交付");
    assert.equal(execCount, 1, "handler 执行恰好一次（STARTED 不重执行）");
    // auto-resume 生效证据：phase 经 recovering 回到 active（事件泵 100ms 轮询
    // 粒度——先等内核收敛再断言事件序列）
    await waitFor(async () => (await session.state()).phase === "active", 10_000, "phase back to active");
    await sleep(300); // 等 onState 事件泵追平
    assert.ok(states.includes("recovering"), `应观察到 recovering（实际 ${states.join(",")}）`);
    assert.equal(states[states.length - 1], "active");

    await session.close();
    await server.close();
  } finally {
    await a.shutdown();
    await b.shutdown();
  }
});

maybeTest("ws tunnel (byte-level): keepOpen + sendTunnel + provider-side bodyNext", async () => {
  const { a, b } = await pair();
  try {
    let seenRequestId = 0;
    const server = await withTimeout(
      serveHttp(b, a.endpointId, async (req) => {
        seenRequestId = req.requestId;
        // 101 + 静态首块（流式供给后续 phase；隧道 P→C 方向此处受静态分块
        // 限制——整消息通道归 Phase 4，见 http/index.d.ts WsMessage 标注）
        return {
          status: 101,
          headers: [{ name: "connection", value: "upgrade" }],
          bodyChunks: [Buffer.from("upgrade-ok")],
        };
      }),
      10_000,
      "serveHttp",
    );
    const session = await withTimeout(a.openSession(b.endpointId), 20_000, "openSession");
    const resp = await withTimeout(
      fetchHttp(session, { method: "GET", path: "/ws", keepOpen: true }),
      20_000,
      "fetchHttp keepOpen",
    );
    assert.equal(resp.status, 101, "upgrade");
    // P→C：首块（字节级）
    const first = await withTimeout(resp.bodyNext(), 15_000, "tunnel first chunk");
    assert.equal(first?.toString("utf8"), "upgrade-ok");
    // C→P：隧道方向持续写 + provider 侧拉取观测（内部面 puller）
    await resp.sendTunnel(Buffer.from("tunnel-frame-payload"));
    const fromClient = await withTimeout(
      server.native.requestBodyNext(seenRequestId),
      15_000,
      "provider requestBodyNext",
    );
    assert.equal(fromClient?.toString("utf8"), "tunnel-frame-payload");
    await session.close();
    await server.close();
  } finally {
    await a.shutdown();
    await b.shutdown();
  }
});
