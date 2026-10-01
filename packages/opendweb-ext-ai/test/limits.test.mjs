// 限额/用量单测（ai-fly test/unit/provider/limits.test.ts 矩阵移植；acquire
// 变 async + atomicWrite0600 持久化）：并发 429 rate_limited、日限 429
// quota_exceeded、UTC 日界重置、quota-day.json 0600 重启不丢、usage 仅元数据。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir } from "./helpers.mjs";
import { LimitEnforcer, UsageLog } from "../src/provider/limits.mjs";

test("limits: maxConcurrency——超限 rate_limited；release 后恢复", async (t) => {
  const home = await tempHome("odai-limits-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const lim = new LimitEnforcer({ dataDir: aiDataDir(home) });
  lim.setGroupLimits("g", { maxConcurrency: 2 });
  assert.deepEqual(await lim.acquire("k1", "g"), { ok: true });
  assert.deepEqual(await lim.acquire("k2", "g"), { ok: true });
  assert.deepEqual(await lim.acquire("k3", "g"), { ok: false, code: "rate_limited" });
  lim.release("g");
  assert.deepEqual(await lim.acquire("k3", "g"), { ok: true });
  lim.release("g"); // 幂等下限 0
  lim.release("g");
  assert.equal(lim.inflightCount("g"), 0); // 3 成功占用 × 3 释放（其中一次在超限拒绝后）
});

test("limits: dailyRequests——按 keyId 计数、超限 quota_exceeded、跨 key 互不影响", async (t) => {
  const home = await tempHome("odai-limits-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const lim = new LimitEnforcer({ dataDir: aiDataDir(home) });
  lim.setGroupLimits("g", { dailyRequests: 2 });
  assert.deepEqual(await lim.acquire("k1", "g"), { ok: true });
  assert.deepEqual(await lim.acquire("k1", "g"), { ok: true });
  assert.deepEqual(await lim.acquire("k1", "g"), { ok: false, code: "quota_exceeded" });
  assert.deepEqual(await lim.acquire("k2", "g"), { ok: true });
  assert.equal(await lim.dailyCount("k1"), 2);
});

test("limits: quota-day.json 0600 原子持久化——重启不丢当日计数；损坏视同空表", async (t) => {
  const home = await tempHome("odai-limits-persist-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataDir = aiDataDir(home);
  const a = new LimitEnforcer({ dataDir });
  a.setGroupLimits("g", { dailyRequests: 5 });
  await a.acquire("k1", "g");
  await a.acquire("k1", "g");
  const file = LimitEnforcer.quotaFilePath(dataDir);
  assert.equal(existsSync(file), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(persisted.counts.k1, 2);

  // 重启（同日）：计数仍在
  const b = new LimitEnforcer({ dataDir });
  assert.equal(await b.dailyCount("k1"), 2);

  // 损坏：不阻塞（视同空表）
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, "not json", { mode: 0o600 });
  const c = new LimitEnforcer({ dataDir });
  assert.equal(await c.dailyCount("k1"), 0);
});

test("limits: UTC 日界重置（now 注入——跨日后计数归零、日界文件覆盖）", async (t) => {
  const home = await tempHome("odai-limits-day-");
  t.after(() => rm(home, { recursive: true, force: true }));
  let fakeNow = new Date("2026-10-01T23:59:00Z");
  const lim = new LimitEnforcer({ dataDir: aiDataDir(home), now: () => fakeNow });
  lim.setGroupLimits("g", { dailyRequests: 2 });
  await lim.acquire("k1", "g");
  fakeNow = new Date("2026-10-02T00:01:00Z"); // 跨 UTC 日界
  assert.equal(await lim.dailyCount("k1"), 0);
  assert.deepEqual(await lim.acquire("k1", "g"), { ok: true }); // 新一天恢复
});

test("limits: UsageLog——仅元数据（无正文/凭证），usage.jsonl 0600", async (t) => {
  const home = await tempHome("odai-limits-usage-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const log = new UsageLog(aiDataDir(home));
  await log.append({ ts: 1, keyId: "k1", serviceId: "s1", status: 200, bytes: 42 });
  await log.append({ ts: 2, keyId: "k1", serviceId: "s1", status: "secret_missing", bytes: 0 });
  const text = readFileSync(log.pathOf(), "utf8");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(lines[0]).sort(), ["bytes", "keyId", "serviceId", "status", "ts"]);
  assert.equal(lines[1].status, "secret_missing");
  assert.equal(statSync(log.pathOf()).mode & 0o777, 0o600);
});
