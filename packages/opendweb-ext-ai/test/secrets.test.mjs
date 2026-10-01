// SecretsStore 单测（ai-fly test/unit/provider/secrets.test.ts 矩阵移植；
// 写路径换 async atomicWrite0600）：往返、值只落 0600 文件、目录 0700、原子写
// 无 tmp 残留、名称/值校验、损坏 fail-closed、跨实例无内存态。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { tempHome } from "./helpers.mjs";
import { SecretsStore } from "../src/provider/secrets.mjs";
import { StoreError } from "../src/provider/store.mjs";
import { rm } from "node:fs/promises";

test("secrets: set → get/list → remove → 空；list 只含名称与时间戳", async (t) => {
  const home = await tempHome("odai-secrets-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await SecretsStore.open(home);

  const first = await store.set("openai", "Bearer sk-1");
  assert.equal(first.name, "openai");
  assert.ok(first.createdAt > 0);

  await store.set("anthropic.main", "sk-ant-2");
  const listed = store.list();
  assert.deepEqual(listed.map((s) => s.name), ["anthropic.main", "openai"]);
  assert.ok(!JSON.stringify(listed).includes("sk-1"));
  assert.ok(!JSON.stringify(listed).includes("sk-ant-2"));

  assert.equal(store.get("openai"), "Bearer sk-1");
  assert.equal(store.get("nope"), undefined);
  assert.equal(store.exists("openai"), true);
  assert.equal(store.exists("nope"), false);

  await store.remove("openai");
  assert.deepEqual(store.list().map((s) => s.name), ["anthropic.main"]);
  assert.equal(store.get("openai"), undefined);
});

test("secrets: 覆写保留 createdAt、更新 updatedAt；无内存态（另一实例写入即刻可见）", async (t) => {
  const home = await tempHome("odai-secrets-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const writer = await SecretsStore.open(home);
  const reader = await SecretsStore.open(home);
  const a = await writer.set("k", "v1");
  await new Promise((r) => setTimeout(r, 5));
  const b = await writer.set("k", "v2");
  assert.equal(b.createdAt, a.createdAt);
  assert.ok(b.updatedAt >= a.updatedAt);
  assert.equal(reader.get("k"), "v2");
  await writer.set("later", "v");
  assert.equal(reader.get("later"), "v");
  await writer.remove("later");
  assert.equal(reader.get("later"), undefined);
});

test("secrets: remove 未知名 → StoreError(not-found)；名称/值校验 → invalid", async (t) => {
  const home = await tempHome("odai-secrets-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await SecretsStore.open(home);
  await assert.rejects(() => store.remove("ghost"), (e) => e instanceof StoreError && e.code === "not-found");
  for (const bad of ["", "UPPER", "1 space", "中文", "-lead"]) {
    await assert.rejects(() => store.set(bad, "v"), (e) => e instanceof StoreError && e.code === "invalid");
  }
  await assert.rejects(() => store.set("ok", ""), (e) => e.code === "invalid");
  await assert.rejects(() => store.set("ok", "x".repeat(8193)), (e) => e.code === "invalid");
  await store.set("a1._-ok", "Bearer x");
});

test("secrets: 文件 0600、目录 0700、内容为 v1 声明格式；原子写无 tmp 残留", async (t) => {
  const home = await tempHome("odai-secrets-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await SecretsStore.open(home);
  await store.set("openai", "Bearer sk-1");
  const file = SecretsStore.filePath(home);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.secrets), ["openai"]);
  assert.equal(parsed.secrets.openai.value, "Bearer sk-1");
  await store.set("b", "2");
  await store.remove("b");
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith("secrets.json")), ["secrets.json"]);
});

test("secrets: 损坏文件 → StoreError(corrupt)（fail-closed 不覆盖）；缺失=空库不落盘", async (t) => {
  const home = await tempHome("odai-secrets-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await SecretsStore.open(home);
  await store.set("a", "1");
  writeFileSync(SecretsStore.filePath(home), "{ not json", { mode: 0o600 });
  const broken = await SecretsStore.open(home);
  assert.throws(() => broken.list(), (e) => e instanceof StoreError && e.code === "corrupt");
  assert.throws(() => broken.get("a"), (e) => e.code === "corrupt");
  await assert.rejects(() => broken.set("b", "2"), (e) => e.code === "corrupt");
  await assert.rejects(() => broken.remove("a"), (e) => e.code === "corrupt");

  const fresh = await SecretsStore.open(await tempHome("odai-secrets-empty-"));
  assert.deepEqual(fresh.list(), []);
  assert.equal(existsSync(SecretsStore.filePath(fresh.dataDir)), false);
});

test("secrets: resolve 原样取值（Bearer 前缀由 auth 槽拼——bearerPrefix 退役语义）", async (t) => {
  const home = await tempHome("odai-secrets-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await SecretsStore.open(home);
  await store.set("std", "sk-1");
  await store.set("prefilled", "Bearer sk-3");
  assert.deepEqual(store.resolve("std"), { headerValue: "sk-1" });
  assert.deepEqual(store.resolve("prefilled"), { headerValue: "Bearer sk-3" });
  assert.deepEqual(Object.keys(store.list()[0]), ["name", "createdAt", "updatedAt"]);
});
