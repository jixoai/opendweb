// 心跳面测试（home-hub Phase 3a / specs/packaging/tray-plugin「状态面」）：
// 1. computeSnapshot 四态优先级表（纯函数矩阵）；
// 2. 心跳循环（真实临时 DWEB_HOME + 伪造 hub 文件族 + 本地 /admin/status
//    mock）：unconfigured 形状 / running / knock 提升（轮询源） / error=自启开
//    进程不在（含配置存在进程不在、hub.json 损坏）；
// 3. mtime ≤1s 级刷新与 stop() 后冻结（进程退出后心跳停止的进程内面——
//    子进程面见 controller.test.mjs）；
// 4. token 不出面（文件全量断言）+ 轮询请求 Bearer 形态；
// 5. noteKnocks 外部注入（console knock-pending 事件语义）与轮询失败的
//    keep-last-known。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";

import {
  createHeartbeat,
  computeSnapshot,
  TRAY_STATUS_FILE,
  HEARTBEAT_INTERVAL_MS,
  ADMIN_POLL_INTERVAL_MS,
} from "../src/heartbeat.mjs";
import { fakeAdmin, makeHubHome, deadPid, readStatus, until } from "./helpers.mjs";

const now = () => 1_234_567;

test("computeSnapshot: four-state priority table (spec frozen order)", () => {
  // 未配置恒 unconfigured（无论其余输入）
  assert.deepEqual(computeSnapshot({ configured: false, pidAlive: true, knocks: 9, now }), {
    v: 1,
    state: "unconfigured",
    knocks_pending: 0,
    ts: now(),
  });
  // 异常 > 敲门 > 运行：进程不在（自启开/关均同）与 hub.json 损坏都压制 knock
  assert.equal(computeSnapshot({ configured: true, pidAlive: false, knocks: 9, now }).state, "error");
  assert.equal(computeSnapshot({ configured: true, parseError: "bad", pidAlive: true, knocks: 9, now }).state, "error");
  // 进程活 + 敲门 n>0 → knock（优先级高于运行）
  assert.deepEqual(computeSnapshot({ configured: true, pidAlive: true, knocks: 1, now }), {
    v: 1,
    state: "knock",
    knocks_pending: 1,
    ts: now(),
  });
  // 进程活 + 无敲门 → running（n<=0 归零）
  assert.deepEqual(computeSnapshot({ configured: true, pidAlive: true, knocks: 0, now }), {
    v: 1,
    state: "running",
    knocks_pending: 0,
    ts: now(),
  });
  assert.equal(computeSnapshot({ configured: true, pidAlive: true, knocks: -3, now }).knocks_pending, 0);
});

test("heartbeat: unconfigured home writes the v1 schema shape immediately", async () => {
  const { home } = await makeHubHome({ configured: false });
  const hb = await createHeartbeat({ home, intervalMs: 10_000, pollIntervalMs: 10_000 });
  try {
    const snap = await readStatus(home);
    assert.deepEqual(
      Object.keys(snap).sort(),
      ["knocks_pending", "state", "ts", "v"],
      "schema v1 frozen field set",
    );
    assert.equal(snap.v, 1);
    assert.equal(snap.state, "unconfigured");
    assert.equal(snap.knocks_pending, 0);
    assert.equal(typeof snap.ts, "number");
  } finally {
    hb.stop();
  }
});

test("heartbeat: running → knock promotion via /admin/status poll; token stays off every face", async (t) => {
  const token = `tok_secret_${Math.random().toString(36).slice(2)}`;
  const admin = await fakeAdmin({ token, knocks: 0 });
  t.after(() => admin.close());
  const { home } = await makeHubHome({ gatewayPort: admin.port, pid: process.pid, token });
  const hb = await createHeartbeat({ home, intervalMs: 80, pollIntervalMs: 80 });
  t.after(() => hb.stop());
  // 基线：运行中
  await until(async () => (await readStatus(home)).state === "running", { what: "running baseline" });
  // mock 出现 1 台待敲门 → 优先级提升为 knock（高于运行态）
  admin.setKnocks(1);
  const snap = await until(async () => {
    const s = await readStatus(home);
    return s.state === "knock" ? s : null;
  }, { what: "knock promotion" });
  assert.equal(snap.knocks_pending, 1);
  // token 不出面：心跳文件全量断言（不只是 JSON 字段——整文件文本）
  const raw = await fsp.readFile(`${home}/${TRAY_STATUS_FILE}`, "utf8");
  assert.ok(!raw.includes(token), "heartbeat file must not contain the hub token");
  assert.ok(!raw.includes("Bearer"), "heartbeat file must not carry auth material");
  // 轮询请求的 Bearer 形态（token 只进请求头）
  await until(() => admin.hits.length > 0, { what: "admin poll hit" });
  assert.ok(admin.hits.every((h) => h.authorization === `Bearer ${token}`));
  assert.ok(admin.hits.every((h) => h.url === "/admin/status"));
});

test("heartbeat: error = autostart on but process gone; configured-but-not-running maps to error (v1 ruling)", async () => {
  const pid = await deadPid();
  assert.ok(typeof pid === "number" && pid > 0, "dead pid supplied");
  const { home } = await makeHubHome({ autostart: true, pid });
  const hb = await createHeartbeat({ home, intervalMs: 80, pollIntervalMs: 10_000 });
  hb.stop();
  const snap = await readStatus(home);
  assert.equal(snap.state, "error");
  assert.equal(snap.knocks_pending, 0);
  // v1 无 stopped 态：自启关但进程不在同样按异常呈现（README 冻结裁决）
  const { home: home2 } = await makeHubHome({ autostart: false, pid });
  const hb2 = await createHeartbeat({ home: home2, intervalMs: 80, pollIntervalMs: 10_000 });
  hb2.stop();
  assert.equal((await readStatus(home2)).state, "error");
});

test("heartbeat: malformed hub.json maps to error", async () => {
  const { home } = await makeHubHome({ malformedState: true, pid: process.pid });
  const hb = await createHeartbeat({ home, intervalMs: 80, pollIntervalMs: 10_000 });
  hb.stop();
  assert.equal((await readStatus(home)).state, "error");
});

test("heartbeat: mtime advances with ticks and freezes after stop()", async () => {
  const { home } = await makeHubHome({ configured: true, pid: process.pid });
  const hb = await createHeartbeat({ home, intervalMs: 120, pollIntervalMs: 10_000 });
  const statBefore = await fsp.stat(`${home}/${TRAY_STATUS_FILE}`);
  await until(
    async () => (await fsp.stat(`${home}/${TRAY_STATUS_FILE}`)).mtimeMs > statBefore.mtimeMs,
    { what: "mtime advance" },
  );
  const tsBefore = (await readStatus(home)).ts;
  hb.stop();
  // stop 后在飞的最后一拍可能仍落盘——静置后再取样（此后必须完全冻结）
  await new Promise((r) => setTimeout(r, 350));
  const statStopped = await fsp.stat(`${home}/${TRAY_STATUS_FILE}`);
  const tsStopped = await readStatus(home);
  await new Promise((r) => setTimeout(r, 450));
  const statAfter = await fsp.stat(`${home}/${TRAY_STATUS_FILE}`);
  // 停止后：mtime 与 ts 都不再前进（文件保留——壳侧失联判定依据）
  assert.equal(statAfter.mtimeMs, statStopped.mtimeMs, "mtime frozen after stop");
  assert.equal((await readStatus(home)).ts, tsStopped.ts);
  assert.ok(tsStopped.ts >= tsBefore);
});

test("heartbeat: noteKnocks injection (console knock-pending semantics; last writer wins)", async (t) => {
  // 无 token → 轮询不出网：注入值不被 poll 覆盖（console 事件面单源）
  const { home } = await makeHubHome({ pid: process.pid, token: null });
  const hb = await createHeartbeat({ home, intervalMs: 80, pollIntervalMs: 10_000 });
  t.after(() => hb.stop());
  hb.noteKnocks(4);
  const injected = await until(async () => {
    const s = await readStatus(home);
    return s.state === "knock" && s.knocks_pending === 4 ? s : null;
  }, { what: "noteKnocks promotion" });
  assert.ok(injected);
  hb.noteKnocks(0);
  await until(async () => (await readStatus(home)).state === "running", { what: "noteKnocks clear" });
});

test("heartbeat: keep-last-known knocks while running when the poll fails", async (t) => {
  const admin = await fakeAdmin({ token: "x", knocks: 2 });
  const { home } = await makeHubHome({ gatewayPort: admin.port, pid: process.pid, token: "x" });
  const hb = await createHeartbeat({ home, intervalMs: 80, pollIntervalMs: 80 });
  t.after(() => hb.stop());
  await until(async () => (await readStatus(home)).knocks_pending === 2, { what: "poll 2" });
  await admin.close(); // 轮询失败（连接拒绝）→ 运行中保持上次值
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await readStatus(home)).knocks_pending, 2);
});

test("heartbeat: default cadence constants are frozen (≤1s heartbeat / 3s poll)", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 1000);
  assert.equal(ADMIN_POLL_INTERVAL_MS, 3000);
});
