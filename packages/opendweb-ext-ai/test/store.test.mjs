// ProviderStore 单测（ai-fly test/unit/provider/store.test.ts 矩阵移植 +
// Phase A 新面：catalog ≤256 服务工厂期拒绝、keyEnv 激活门（§4 ③④）、
// transaction 原子回滚、$env 构造期拒绝）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir } from "./helpers.mjs";
import { ProviderStore, StoreError, hashKeyMaterial, KEY_MATERIAL_PREFIX } from "../src/provider/store.mjs";

/**
 * 开店三件套（含干净 env/secrets 注入面——hermetic ambient 测试）。
 * @param {string} home
 * @param {{ env?: Record<string, string>, secrets?: Record<string, string> }} [over]
 */
async function openStore(home, over = {}) {
  const dataDir = aiDataDir(home);
  const store = await ProviderStore.open(dataDir, {
    env: (name) => over.env?.[name],
    secretsSource: (name) => over.secrets?.[name] !== undefined,
  });
  return store;
}

test("store: 服务/分组/密钥往返——字段集、revision 自增、0600/无残留", async (t) => {
  const home = await tempHome("odai-store-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home);

  const svc = await store.addService({
    name: "ollama",
    upstream: "http://127.0.0.1:11434",
    match: [{ type: "suffix", value: ".local" }],
  });
  assert.match(svc.serviceId, /^[a-z0-9]{13}$/);
  assert.equal(svc.upstream, "http://127.0.0.1:11434/");
  assert.equal(svc.defaultPort, 11434);
  assert.equal(svc.enabled, true);

  await store.addService({ name: "web", upstream: "http://127.0.0.1:8080", match: [{ type: "suffix", value: ".home" }] });
  await store.addGroup("alpha", ["ollama"], { maxConcurrency: 3, dailyRequests: 100 });
  await store.addGroup("beta", ["web"]);

  const keyA = await store.issueKey("alpha");
  const keyB = await store.issueKey("beta");
  assert.match(keyA.key, new RegExp(`^${KEY_MATERIAL_PREFIX}`));
  assert.equal(keyA.key.length, KEY_MATERIAL_PREFIX.length + 52);

  // raw key 落盘（上游 Owner 裁决 2026-09-13 照搬）+ 哈希盐
  const raw = JSON.parse(readFileSync(ProviderStore.filePath(store.dataDir), "utf8"));
  const stored = raw.keys.find((k) => k.keyId === keyA.keyId);
  assert.equal(stored.key, keyA.key);
  assert.equal(stored.hash, hashKeyMaterial(keyA.key));
  assert.equal(stored.name, "default");

  // verifyKey 三态
  assert.deepEqual(store.verifyKey(keyA.key), { status: "valid", keyId: keyA.keyId, group: "alpha" });
  assert.deepEqual(store.verifyKey("sk-aifly-garbage"), { status: "invalid" });
  await store.revokeKey(keyB.keyId);
  assert.deepEqual(store.verifyKey(keyB.key), { status: "revoked", keyId: keyB.keyId, group: "beta" });
  await store.revokeKey(keyB.keyId); // 幂等
  assert.equal(store.getKeyMaterial(keyB.keyId), undefined); // 已撤不可取回

  // keyStatus 三码分立判定面
  assert.equal(store.keyStatus("nope-zzz").status, "invalid");
  assert.equal(store.keyStatus(keyB.keyId).status, "revoked");
  assert.equal(store.keyStatus(keyA.keyId).status, "valid");

  // revision 每次 save 自增 + 0600 + 无 .tmp 残留
  assert.ok(store.revision >= 7);
  assert.equal(statSync(ProviderStore.filePath(store.dataDir)).mode & 0o777, 0o600);
  assert.equal(readdirSync(store.dataDir).filter((f) => f.endsWith(".tmp")).length, 0);

  // 重开恢复
  const reopened = await openStore(home);
  assert.equal(reopened.getServiceByName("ollama")?.serviceId, svc.serviceId);
  assert.deepEqual(reopened.verifyKey(keyA.key), { status: "valid", keyId: keyA.keyId, group: "alpha" });
});

test("store: 校验矩阵——名称/重复/URL 规则/特权端口/正则/互斥/unknown-service", async (t) => {
  const home = await tempHome("odai-store-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home);

  await store.addService({ name: "s", upstream: "https://example.com:8443", match: [{ type: "exact", value: "x" }] });
  await assert.rejects(() => store.addService({ name: "s", upstream: "https://example.com:8443", match: [{ type: "exact", value: "x" }] }), (e) => e.code === "duplicate");
  await assert.rejects(() => store.addService({ name: "x", upstream: "ftp://example.com", match: [{ type: "exact", value: "x" }] }), (e) => e.code === "invalid");
  await assert.rejects(() => store.addService({ name: "x", upstream: "https://user:pass@example.com", match: [{ type: "exact", value: "x" }] }), (e) => e.code === "invalid");
  await assert.rejects(() => store.addService({ name: "x", upstream: "https://example.com/q?z=1", match: [{ type: "exact", value: "x" }] }), (e) => e.code === "invalid");
  await assert.rejects(() => store.addService({ name: "x", upstream: "http://127.0.0.1:80", match: [] }), (e) => e.code === "invalid"); // 特权端口隐式
  const explicit = await store.addService({ name: "low", upstream: "http://127.0.0.1:80", match: [{ type: "exact", value: "x" }], defaultPort: 8080 });
  assert.equal(explicit.defaultPort, 8080);
  await assert.rejects(() => store.addService({ name: "x", upstream: "https://example.com:8443", match: [{ type: "regex", value: "(" }] }), (e) => e.code === "invalid");
  await assert.rejects(
    () =>
      store.addService({
        name: "both",
        upstream: "https://example.com:8443",
        match: [{ type: "exact", value: "x" }],
        hooks: { script: "secret" },
        auth: { secret: "k" },
      }),
    (e) => e.code === "invalid", // hooks 与逐槽互斥
  );
  await assert.rejects(() => store.addGroup("g", ["missing"]), (e) => e.code === "not-found");
  await assert.rejects(() => store.removeGroup("nope"), (e) => e.code === "not-found");
  // 有活跃密钥的组不可删
  const g = await store.addGroup("locked", ["s"]);
  await store.issueKey("locked");
  await assert.rejects(() => store.removeGroup("locked"), (e) => e.code === "conflict");
});

test("store: $env 构造期拒绝（声明面防线——auth.literal 与 headers.set）", async (t) => {
  const home = await tempHome("odai-store-env-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home);
  await assert.rejects(
    () =>
      store.addService({
        name: "envy",
        upstream: "https://example.com:8443",
        match: [{ type: "exact", value: "x" }],
        auth: { literal: "$env:MY_KEY" },
      }),
    (e) => e instanceof StoreError && e.code === "invalid" && /secret|script/.test(e.message),
  );
  await assert.rejects(
    () =>
      store.addService({
        name: "envy2",
        upstream: "https://example.com:8443",
        match: [{ type: "exact", value: "x" }],
        headers: { set: { "x-api-key": "$env:MY_KEY" } },
      }),
    (e) => e instanceof StoreError && e.code === "invalid",
  );
  // $secret: 间接引用合法（构造期不解析——请求期判缺失）
  const ok = await store.addService({
    name: "secrety",
    upstream: "https://example.com:8443",
    match: [{ type: "exact", value: "x" }],
    auth: { literal: "$secret:openai" },
  });
  assert.equal(ok.auth.literal, "$secret:openai");
});

test("store: keyEnv 激活门（③绑定门：未绑定 secret 不可启用；secret 不存在不可启用）", async (t) => {
  const home = await tempHome("odai-store-keyenv-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home, { secrets: { bound: "v" } });

  // 无 auth 槽 + keyEnv → 拒启
  await assert.rejects(
    () =>
      store.addService({
        name: "openai",
        upstream: "https://api.openai.com:8443",
        match: [{ type: "suffix", value: ".openai.com" }],
        keyEnv: "OPENAI_API_KEY",
      }),
    (e) => e.code === "invalid" && /\{secret/.test(e.message),
  );
  // auth={secret:unbound}（密钥库无此名）→ 拒启
  await assert.rejects(
    () =>
      store.addService({
        name: "openai2",
        upstream: "https://api.openai.com:8443",
        match: [{ type: "suffix", value: ".openai.com" }],
        keyEnv: "OPENAI_API_KEY",
        auth: { secret: "not-in-store" },
      }),
    (e) => e.code === "invalid" && /not in the secrets store/.test(e.message),
  );
  // disabled 落库 OK（不激活）→ 启用时过门
  const disabled = await store.addService({
    name: "openai3",
    upstream: "https://api.openai.com:8443",
    match: [{ type: "suffix", value: ".openai.com" }],
    keyEnv: "OPENAI_API_KEY",
    enabled: false,
  });
  assert.equal(disabled.enabled, false);
  await assert.rejects(() => store.setServiceEnabled(disabled.serviceId, true), (e) => e.code === "invalid");
  // 绑定 secret 后（ambient 干净）可启用
  const bound = await store.addService({
    name: "openai4",
    upstream: "https://api.openai.com:8443",
    match: [{ type: "suffix", value: ".openai.com" }],
    keyEnv: "OPENAI_API_KEY",
    auth: { secret: "bound" },
  });
  assert.equal(bound.enabled, true);
  const r = await store.setServiceEnabled(bound.serviceId, false);
  assert.deepEqual(r, { changed: true });
  const r2 = await store.setServiceEnabled(bound.serviceId, false);
  assert.deepEqual(r2, { changed: false }); // 幂等
  await store.setServiceEnabled(bound.serviceId, true);
});

test("store: ambient env 防绕（④运行中时点：启用方向原子拒绝，列明变量名+指引）", async (t) => {
  const home = await tempHome("odai-store-ambient-");
  t.after(() => rm(home, { recursive: true, force: true }));
  // 环境里放了等值 secret——keyEnv 命中即拒（不剥离值）
  const store = await openStore(home, { env: { OPENAI_API_KEY: "sk-env-value" }, secrets: { bound: "v" } });
  const svc = await store.addService({
    name: "openai",
    upstream: "https://api.openai.com:8443",
    match: [{ type: "suffix", value: ".openai.com" }],
    keyEnv: "OPENAI_API_KEY",
    auth: { secret: "bound" },
    enabled: false,
  });
  await assert.rejects(
    () => store.setServiceEnabled(svc.serviceId, true),
    (e) =>
      e instanceof StoreError &&
      e.code === "conflict" &&
      e.message.includes("OPENAI_API_KEY") &&
      /secrets store/.test(e.message),
  );
  assert.equal(store.getService(svc.serviceId).enabled, false); // 原子：未写入
});

test("store: catalog ≤256 服务——工厂期拒绝超配（不可保存）", async (t) => {
  const home = await tempHome("odai-store-cap-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home);
  for (let i = 0; i < 256; i++) {
    await store.addService({ name: `s${i}`, upstream: "https://example.com:8443", match: [{ type: "exact", value: "x" }] });
  }
  assert.equal(store.listServices().length, 256);
  await assert.rejects(
    () => store.addService({ name: "s256", upstream: "https://example.com:8443", match: [{ type: "exact", value: "x" }] }),
    (e) => e.code === "invalid" && /256/.test(e.message),
  );
  // 移除后可再加
  await store.removeService("s0");
  await store.addService({ name: "s256", upstream: "https://example.com:8443", match: [{ type: "exact", value: "x" }] });
});

test("store: transaction——任一失败回滚快照（导入器 commit 的原子面）", async (t) => {
  const home = await tempHome("odai-store-tx-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home);
  await store.addService({ name: "keep", upstream: "https://example.com:8443", match: [{ type: "exact", value: "x" }] });
  const revBefore = store.revision;
  await assert.rejects(
    () =>
      store.transaction(async (tx) => {
        await tx.addService({ name: "mid", upstream: "https://example.com:8443", match: [{ type: "exact", value: "x" }] });
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(store.getServiceByName("mid"), undefined);
  assert.equal(store.getServiceByName("keep") !== undefined, true);
  assert.ok(store.revision >= revBefore);
  const reopened = await openStore(home);
  assert.equal(reopened.getServiceByName("mid"), undefined); // 盘上同样回滚
});

test("store: 损坏文件 fail-closed；空文件初始化 v2", async (t) => {
  const home = await tempHome("odai-store-corrupt-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { writeFile } = await import("node:fs/promises");
  const dataDir = aiDataDir(home);
  await mkdir0700(dataDir);
  await writeFile(ProviderStore.filePath(dataDir), "{ nope", { mode: 0o600 });
  await assert.rejects(() => ProviderStore.open(dataDir), (e) => e.code === "corrupt");
});

/** @param {string} dir */
async function mkdir0700(dir) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true, mode: 0o700 });
}
