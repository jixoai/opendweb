// AUTH 决策单测（ai-fly test/unit/provider/auth.test.ts 矩阵移植）+
// AUTH_OK 冻结形状断言（design §3：{v:1,status:"ok",groups,rejected?}——
// rejected 仅 code 不带 keyId；有效键集合=groups[].keyId）。

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir } from "./helpers.mjs";
import { ProviderStore } from "../src/provider/store.mjs";
import {
  authDirectoryFromStore,
  buildAuthOk,
  evaluateKeyring,
  handleAuthRequest,
  KeySessionIndex,
} from "../src/provider/auth.mjs";
import { AUTH_OK_BODY_SCHEMA, AUTH_ERR_BODY_SCHEMA } from "../src/wire/schemas.mjs";

async function fixture() {
  const home = await tempHome("odai-auth-");
  const store = await ProviderStore.open(aiDataDir(home));
  await store.addService({ name: "ollama", upstream: "http://127.0.0.1:11434", match: [{ type: "suffix", value: ".local" }] });
  await store.addService({ name: "web", upstream: "http://127.0.0.1:8080", match: [{ type: "suffix", value: ".home" }] });
  await store.addGroup("alpha", ["ollama"], { maxConcurrency: 3, dailyRequests: 100 });
  await store.addGroup("beta", ["web"]);
  const keyA = await store.issueKey("alpha");
  const keyB = await store.issueKey("beta");
  const keyC = await store.issueKey("alpha");
  return { home, store, keyA, keyB, keyC };
}

test("auth: 多钥一次授权——两组视图（limits+services 含 detail）；AUTH_OK 形状过 schema", async (t) => {
  const { home, store, keyA, keyB } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const decision = handleAuthRequest({ keys: [keyA.key, keyB.key] }, authDirectoryFromStore(store));
  assert.equal(decision.kind, "ok");
  const header = decision.body;
  // 冻结形状：{v:1, status:"ok", groups:[…]（≥1）, rejected?}
  assert.equal(header.v, 1);
  assert.equal(header.status, "ok");
  assert.equal(header.groups.length, 2);
  assert.equal(AUTH_OK_BODY_SCHEMA.safeParse(header).success, true);
  const alpha = header.groups.find((g) => g.group === "alpha");
  assert.deepEqual(alpha.limits, { maxConcurrency: 3, dailyRequests: 100 });
  assert.equal(alpha.services[0].name, "ollama");
  assert.equal(alpha.services[0].detail.upstream, "http://127.0.0.1:11434/");
  assert.equal(alpha.keyId, keyA.keyId);
  assert.equal(header.rejected, undefined);
  assert.deepEqual(decision.valid.map((v) => v.keyId).sort(), [keyA.keyId, keyB.keyId].sort());
});

test("auth: 同组多钥——每钥一个 groups 条目", async (t) => {
  const { home, store, keyA, keyC } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const decision = handleAuthRequest({ keys: [keyA.key, keyC.key] }, authDirectoryFromStore(store));
  assert.equal(decision.kind, "ok");
  assert.equal(decision.body.groups.length, 2);
  assert.ok(decision.body.groups.every((g) => g.group === "alpha"));
});

test("auth: 混合无效钥——AUTH_OK + rejected=[{code:'key_invalid'}]（仅 code 不带 keyId）", async (t) => {
  const { home, store, keyA } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const decision = handleAuthRequest({ keys: [keyA.key, "sk-aifly-garbage"] }, authDirectoryFromStore(store));
  assert.equal(decision.kind, "ok");
  assert.deepEqual(decision.body.rejected, [{ code: "key_invalid" }]);
  assert.equal(decision.body.groups.length, 1);
  // 序列化断言：rejected 条目不含 keyId 字段
  assert.ok(!JSON.stringify(decision.body.rejected).includes("keyId"));
});

test("auth: 撤钥后计入 rejected（key_revoked）；唯一钥被撤 → 全无效 AUTH_ERR", async (t) => {
  const { home, store, keyA, keyB } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  await store.revokeKey(keyA.keyId);
  const decision = handleAuthRequest({ keys: [keyA.key] }, authDirectoryFromStore(store));
  assert.equal(decision.kind, "err");
  assert.equal(AUTH_ERR_BODY_SCHEMA.safeParse(decision.body).success, true);
  assert.deepEqual(decision.body, { v: 1, code: "key_all_invalid" });
  const mixed = handleAuthRequest({ keys: [keyA.key, keyB.key] }, authDirectoryFromStore(store));
  assert.equal(mixed.kind, "ok");
  assert.deepEqual(mixed.body.rejected, [{ code: "key_revoked" }]);
  assert.equal(mixed.body.groups.length, 1);
});

test("auth: 全无效 → AUTH_ERR(key_all_invalid)；重复呈交去重", async (t) => {
  const { home, store, keyA } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const decision = handleAuthRequest({ keys: ["sk-aifly-nope1", "sk-aifly-nope2"] }, authDirectoryFromStore(store));
  assert.equal(decision.kind, "err");
  assert.deepEqual(decision.body, { v: 1, code: "key_all_invalid" });
  const { valid, rejected } = evaluateKeyring([keyA.key, keyA.key, keyA.key], authDirectoryFromStore(store));
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 0);
});

test("auth: 停用服务不进 groups[].services（unknown_service 投影）", async (t) => {
  const { home, store, keyA } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const ollama = store.getServiceByName("ollama");
  await store.setServiceEnabled(ollama.serviceId, false);
  const decision = handleAuthRequest({ keys: [keyA.key] }, authDirectoryFromStore(store));
  assert.equal(decision.body.groups[0].services.length, 0);
});

test("auth: KeySessionIndex——按 keyId 定位持钥会话；track 覆盖旧授权（重复 AUTH）", async (t) => {
  const { home, store, keyA, keyB } = await fixture();
  t.after(() => rm(home, { recursive: true, force: true }));
  const index = new KeySessionIndex();
  /** @type {any} */
  const binding = {
    keys: [keyA.key, keyB.key],
    keyIds: new Set([keyA.keyId, keyB.keyId]),
    pushed: [],
    disconnected: [],
    async pushRefresh(header) {
      this.pushed.push(header);
    },
    disconnect(reason) {
      this.disconnected.push(reason);
    },
  };
  index.track(binding);
  assert.deepEqual(index.sessionsWithKey(keyA.keyId), [binding]);
  assert.equal(index.size(), 1);
  // 重复 AUTH 后只剩 B
  binding.keyIds = new Set([keyB.keyId]);
  index.track(binding);
  assert.deepEqual(index.sessionsWithKey(keyA.keyId), []);
  assert.deepEqual(index.sessionsWithKey(keyB.keyId), [binding]);
  index.untrack(binding);
  assert.equal(index.size(), 0);
});
