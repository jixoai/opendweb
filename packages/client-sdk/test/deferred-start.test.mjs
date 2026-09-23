// [H8] home-hub Phase 0：deferStart 生命周期 + fabricId 采纳的 JS 面集成测试。
//
// 断言层次（spec openspec/changes/home-hub/specs/sdk/node + design §2.1）：
// - deferred 构造与 ensure 阶段零网络出站（本地 HTTP 观测服务器计数）；
// - 首次 relay 接触发生于 start() 之后且携带 ensure 所签 capability
//   （Authorization: Bearer <dwebr1.…> 头对拍）；
// - 状态机：Started 幂等 no-op / Closed 明确错误（start+ensure）/ Failed
//   重试（bindAddr 冲突制造底层失败）/ shutdown 取消在途 start=resolve
//   非错误且不可重试；
// - fabricId：采纳读回逐字相等 / open 重开仍该值 / open 期望不符=wrong-fabric
//   / 既有 roster createRoot=AlreadyExists（fabricId 一致或不一致）/
//   非法形态（长度/大写/非 hex）构造 reject；
// - 缺省 eager 零回归由既有测试面（sdk.test.mjs 等全量）承载。
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as dgram from "node:dgram";
import sdkModule from "../index.js";
const { Fabric } = /** @type {any} */ (sdkModule);

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const HEX64 = "ab".repeat(32);
const SERVER_ID = "a1".repeat(32);

async function rejects(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, pattern);
    return true;
  });
}

/// 本地观测服务器：计数到达的请求并捕获 Authorization 头。iroh relay
/// client 的接触序列：GET /ping 活性探针（无凭证）→ GET /relay 会话升级
///（WebSocket Upgrade，携带 Authorization: Bearer <capability>）——
/// /ping 应答 200 后客户端才会发起带票会话。
function observatory() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (req.url.startsWith("/ping")) {
      res.writeHead(200).end("pong");
    } else {
      res.writeHead(404).end();
    }
  });
  const ready = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    async start() {
      await ready;
      return `http://127.0.0.1:${server.address().port}`;
    },
    requests,
    count: () => requests.length,
    /** 首个带凭证的 relay 会话接触（GET /relay + Authorization 头） */
    waitAuthorized(timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const poll = () => {
          const hit = requests.find((r) => r.authorization !== null);
          if (hit) return resolve(hit);
          if (Date.now() > deadline)
            return reject(new Error(`no authorized relay contact within ${timeoutMs}ms`));
          setTimeout(poll, 20);
        };
        poll();
      });
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ---- spec scenario：deferred 构造零出站与首触带票 --------------------------------

test("deferred construct + ensure are zero-outbound; first relay contact after start carries the ensured capability", async () => {
  const obs = observatory();
  const relayUrl = await obs.start();
  const fabric = await Fabric.createRoot({
    dataDir: tmpdir("dweb-ds-zero-"),
    relay: { mode: "custom", relays: [{ url: relayUrl, serverId: SERVER_ID }] },
    deferStart: true,
  });
  try {
    // 构造与 ensure 阶段零网络出站
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(obs.count(), 0, "deferred 构造零网络出站");
    const ensured = await fabric.ensureRelayCapabilities();
    assert.equal(ensured.length, 1);
    assert.equal(ensured[0].url, relayUrl);
    assert.match(ensured[0].token, /^dwebr1\./);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(obs.count(), 0, "ensure 阶段零网络出站（deferred 态可执行）");

    // 首次 relay 接触发生于 start() 之后；带凭证的会话接触携带 ensure 所签
    // capability（/ping 活性探针亦只可能在 start() 后出现——上方已断言为零）
    const starting = fabric.start();
    const session = await obs.waitAuthorized();
    assert.equal(session.authorization, `Bearer ${ensured[0].token}`,
      "首触带票：relay 会话 Authorization 头 = ensure 所签 capability");
    await fabric.shutdown();
    await starting; // resolve（取消或完成），绝不 reject
    assert.ok(obs.count() >= 1);
    // Closed 后 start/ensure 明确错误
    await rejects(fabric.start(), /shutdown|closed/i);
    await rejects(fabric.ensureRelayCapabilities(), /shutdown|closed/i);
  } finally {
    await obs.close();
  }
});

// ---- spec scenario：状态机拒绝边与并发 ------------------------------------------

test("state machine: started start() is idempotent; closed rejects start/ensure; shutdown idempotent", async () => {
  const fabric = await Fabric.createRoot({
    dataDir: tmpdir("dweb-ds-sm1-"),
    relay: { mode: "disabled" },
    deferStart: true,
  });
  await fabric.start();
  await fabric.start(); // Started 后幂等 no-op
  await fabric.shutdown();
  await fabric.shutdown(); // Closed 幂等 no-op
  await rejects(fabric.start(), /shutdown|closed/i);
  await rejects(fabric.ensureRelayCapabilities(), /shutdown|closed/i);
});

test("state machine: underlying bind failure rejects (retryable) and retry starts", async () => {
  // 占用 UDP 端口制造 bind 冲突（QUIC 数据面同端口必败）
  const guard = dgram.createSocket("udp4");
  await new Promise((r) => guard.bind(0, "127.0.0.1", r));
  const port = guard.address().port;
  const fabric = await Fabric.createRoot({
    dataDir: tmpdir("dweb-ds-fail-"),
    relay: { mode: "disabled" },
    deferStart: true,
    bindAddr: `127.0.0.1:${port}`,
  });
  await rejects(fabric.start(), /bind/i);
  // Failed 可重试：释放端口后重试成功
  await new Promise((r) => guard.close(() => r()));
  await new Promise((r) => setTimeout(r, 150));
  await fabric.start();
  await fabric.shutdown();
});

test("state machine: shutdown cancels an in-flight start — resolves (non-error), not retryable", async () => {
  // 不可达 relay：bind 完成、online 等待窗口内取消
  const fabric = await Fabric.createRoot({
    dataDir: tmpdir("dweb-ds-cancel-"),
    relay: { mode: "custom", relays: [{ url: "http://127.0.0.1:9", serverId: SERVER_ID }] },
    deferStart: true,
  });
  const events = [];
  fabric.on((ev) => events.push(ev));
  const starting = fabric.start();
  await new Promise((r) => setTimeout(r, 250)); // 进入 online 等待
  await fabric.shutdown();
  await starting; // resolve「已取消」（非错误）
  await rejects(fabric.start(), /shutdown|closed/i); // 不可重试
  // shutdown 返回后无晚到网络事件
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(events.length, 0, "shutdown 返回后无晚到 bind/网络事件");
});

test("state machine: concurrent start single-flight (same outcome)", async () => {
  const fabric = await Fabric.createRoot({
    dataDir: tmpdir("dweb-ds-conc-"),
    relay: { mode: "disabled" },
    deferStart: true,
  });
  const [a, b] = await Promise.all([fabric.start(), fabric.start()]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  await fabric.shutdown();
});

// ---- spec scenario：Roster 显式 fabric_id 采纳 -----------------------------------

test("fabricId adoption: readback verbatim, reopen keeps value, mismatch rejects, existing roster createRoot rejects", async () => {
  const dir = tmpdir("dweb-ds-fid-");
  const a = await Fabric.createRoot({
    dataDir: dir,
    relay: { mode: "disabled" },
    deferStart: true,
    fabricId: HEX64,
  });
  assert.equal(await a.fabricIdHex(), HEX64);
  await a.shutdown();

  // 同 data_dir 重开（open 无期望 / 期望一致）：仍为该值
  const b = await Fabric.open({ dataDir: dir, relay: { mode: "disabled" }, deferStart: true });
  assert.equal(await b.fabricIdHex(), HEX64);
  await b.shutdown();
  const c = await Fabric.open({
    dataDir: dir,
    relay: { mode: "disabled" },
    deferStart: true,
    fabricId: HEX64,
  });
  assert.equal(await c.fabricIdHex(), HEX64);
  await c.shutdown();

  // open 期望不符：明确错误（wrong-fabric）
  await rejects(
    Fabric.open({
      dataDir: dir,
      relay: { mode: "disabled" },
      deferStart: true,
      fabricId: "cd".repeat(32),
    }),
    /wrong-fabric|fabric/i,
  );

  // 既有 roster：createRoot（fabricId 一致或不一致）一律 AlreadyExists
  await rejects(
    Fabric.createRoot({
      dataDir: dir,
      relay: { mode: "disabled" },
      deferStart: true,
      fabricId: HEX64,
    }),
    /already hosts a roster/i,
  );
  await rejects(
    Fabric.createRoot({
      dataDir: dir,
      relay: { mode: "disabled" },
      deferStart: true,
      fabricId: "cd".repeat(32),
    }),
    /already hosts a roster/i,
  );
  // A 原样保留
  const reopened = await Fabric.open({ dataDir: dir, relay: { mode: "disabled" } });
  assert.equal(await reopened.fabricIdHex(), HEX64);
  await reopened.shutdown();

  // 缺省 = 随机 hex64（既有行为）
  const r = await Fabric.createRoot({ dataDir: tmpdir("dweb-ds-rnd-"), relay: { mode: "disabled" } });
  const hex = await r.fabricIdHex();
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.notEqual(hex, HEX64);
  await r.shutdown();
});

test("fabricId format gate: non-hex64 constructs reject", async () => {
  const base = { relay: { mode: "disabled" }, deferStart: true };
  await rejects(
    Fabric.createRoot({ ...base, dataDir: tmpdir("dweb-ds-f1-"), fabricId: "ab".repeat(31) }),
    /64 lowercase hex/,
  );
  await rejects(
    Fabric.createRoot({ ...base, dataDir: tmpdir("dweb-ds-f2-"), fabricId: "AB".repeat(32) }),
    /64 lowercase hex/,
  );
  await rejects(
    Fabric.createRoot({ ...base, dataDir: tmpdir("dweb-ds-f3-"), fabricId: "zz".repeat(32) }),
    /64 lowercase hex/,
  );
});

// ---- 缺省 eager 零回归（相位面） --------------------------------------------------

test("default (no deferStart) construction is eager — start() afterwards is an idempotent no-op", async () => {
  const fabric = await Fabric.createRoot({
    dataDir: tmpdir("dweb-ds-eager-"),
    relay: { mode: "disabled" },
  });
  const snap = await fabric.relayStatus();
  assert.equal(snap.mode, "disabled");
  assert.equal(snap.online, null);
  await fabric.start(); // 幂等 no-op（不抛错）
  await fabric.shutdown();
});
