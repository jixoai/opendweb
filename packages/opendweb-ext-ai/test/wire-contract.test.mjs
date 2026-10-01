// wire 契约测试（design §7.2 全清单——Phase A 内冻结面验收）：
// ①404 同体三形态 byte 级；②三码分立独立用例（AUTH key_all_invalid /
// request key_invalid / key_revoked）；③403/404/409(Phase B 端点登记)/429/
// 413 矩阵；④413 边界 maxChunkPayload±1；⑤400 头预算超限（metadata_too_
// large）；⑥serviceId 双源拒绝；⑦AUTH 多 key 正/部分失败/全失败三态
// fixture 序列化断言；⑧gate op 名；⑨admission 超积拒启；⑩catalog 256KiB
// 上限（工厂期拒绝）；⑪catalog since 长轮询（204/200/hold 唤醒）；⑫AUTH
// keys≤8；⑬request 成功形状 {responseId,epoch,status,headers}；⑭
// path_not_offered 仅双过后可出现；⑮response/cancel=Phase B 不实现（404 同体）。

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir, callWire, headers, jsonBytes, startUpstream, waitFor } from "./helpers.mjs";
import { ProviderStore } from "../src/provider/store.mjs";
import { createAiProviderWireHandler, metadataHeaderBytes, serviceIdDuplicateSource } from "../src/wire/endpoints.mjs";
import { NOT_FOUND_BODY, MAX_CHUNK_PAYLOAD, HDR_KEY_ID, HDR_SERVICE, HDR_METHOD, HDR_PATH, HDR_HEADERS } from "../src/wire/constants.mjs";
import { validateAdmission } from "../src/provider/forward.mjs";
import { parseWirePath, opGateName } from "../src/provider/accept.mjs";

/**
 * 装配：store（openai 服务带路由白名单 + anthropic 服务）+ 两钥组。
 * @param {string} home
 * @param {{ groupLimits?: object }} [over]
 */
async function fixture(home, over = {}) {
  const store = await ProviderStore.open(aiDataDir(home));
  await store.addService({
    name: "openai",
    upstream: "https://api.openai.com",
    match: [{ type: "suffix", value: ".openai.com" }],
    defaultPort: 4300,
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
  });
  await store.addService({
    name: "other",
    upstream: "https://other.example.com",
    match: [{ type: "suffix", value: ".other" }],
    defaultPort: 4301,
  });
  await store.addGroup("alpha", ["openai"], over.groupLimits);
  await store.addGroup("beta", ["other"]);
  const keyA = await store.issueKey("alpha");
  const keyB = await store.issueKey("beta");
  return { store, keyA, keyB };
}

/**
 * 转发面替身（注入面——不触网）。
 * @param {(input: any) => any} impl
 */
function fakeForwardPlane(impl) {
  return {
    epoch: "ep-test",
    async request(input) {
      return impl(input);
    },
  };
}

const okUpstream = () => ({ ok: true, responseId: "ep-test:1", epoch: "ep-test", status: 200, headers: { "x-request-id": "up-1" }, bytes: 2 });

/**
 * 真转发面装配（默认 createForwardPlane；上游 fetch/probe 注入假体——路径
 * 白名单/limits/admission 全走真实代码路径）。
 * @param {ProviderStore} store
 * @param {string} _keyMaterial（保留观测缝）
 * @param {{ hang?: Promise<void> }} [opts]
 */
function realUpstreamHandler(store, _keyMaterial, opts = {}) {
  return {
    store,
    probeConnect: async () => undefined,
    timeouts: { connectMs: 2000, firstByteMs: 5000, stallMs: 5000 },
    fetchImpl: async () => {
      if (opts.hang !== undefined) await opts.hang;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", "x-request-id": "up-1" } });
    },
  };
}

// ---------------------------------------------------------------------------
// ① 404 同体三形态（byte 级）+ 未知方法/Phase B 端点
// ---------------------------------------------------------------------------

test("wire: 404 同体三形态——peer 未授权/op 未授权/未知子路径 byte 级同体、不解析 key", async (t) => {
  const home = await tempHome("odai-wire-404-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA } = await fixture(home);
  const seen = [];
  const handler = createAiProviderWireHandler({
    store,
    authorize: (peer, op) => {
      seen.push([peer, op]);
      return op !== "ai/v1/auth"; // auth 被拒（op 未授权）；其余放行
    },
    forwardPlane: fakeForwardPlane(okUpstream),
  });

  // a) 未知子路径（不存在的 op；也无尾段）
  const unknownSub = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/bogus" });
  // b) op 未授权（auth gate 拒绝）
  const opDenied = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 1, keys: [keyA.key] }) });
  // c) peer 未授权（authorize 对全部 op 拒绝）
  const handler2 = createAiProviderWireHandler({ store, authorize: () => false, forwardPlane: fakeForwardPlane(okUpstream) });
  const peerDenied = await callWire(handler2, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 1, keys: [keyA.key] }) });

  for (const res of [unknownSub, opDenied, peerDenied]) {
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND_BODY); // byte 级同体（{"error":"not_found"}）
    assert.equal(res.header("content-type"), "application/json");
  }
  assert.deepEqual(unknownSub.body, peerDenied.body);
  assert.deepEqual(opDenied.body, unknownSub.body);
  // gate 收到的是 op 名（ai/v1/<op>）且未解析 key（无 x-odai-key-id 头时同样 404）
  assert.deepEqual(seen.at(-1), ["peer-test", "ai/v1/auth"]);
  const noKeyStill404 = await callWire(handler2, { method: "POST", path: "/wpk1/ai/v1/request" });
  assert.deepEqual(noKeyStill404.body, NOT_FOUND_BODY);
});

test("wire: 错误方法与 Phase B 端点（response/cancel）——统一 404 同体；前缀外 404", async (t) => {
  const home = await tempHome("odai-wire-404b-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store } = await fixture(home);
  const handler = createAiProviderWireHandler({ store, forwardPlane: fakeForwardPlane(okUpstream) });
  // 错误方法
  const getAuth = await callWire(handler, { method: "GET", path: "/wpk1/ai/v1/auth" });
  const postCatalog = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/catalog" });
  // Phase B 端点登记但未实现
  const response = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/response/abc:1" });
  const cancel = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/cancel", body: jsonBytes({ responseId: "x", epoch: "y" }) });
  // 前缀外/无 op 段
  const noOp = await callWire(handler, { method: "GET", path: "/wpk1/ai/v1" });
  const outside = await callWire(handler, { method: "GET", path: "/wpk1/ai/other" });
  for (const res of [getAuth, postCatalog, response, cancel, noOp, outside]) {
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND_BODY);
  }
});

// ---------------------------------------------------------------------------
// ⑦ AUTH 三态 fixture + ⑫ keys≤8 + ② AUTH 全钥失败 key_all_invalid
// ---------------------------------------------------------------------------

test("wire: AUTH 三态——正/部分失败/全失败序列化断言；keys≤8", async (t) => {
  const home = await tempHome("odai-wire-auth-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA, keyB } = await fixture(home);
  const handler = createAiProviderWireHandler({ store, forwardPlane: fakeForwardPlane(okUpstream) });

  // 正：多钥两组
  const ok = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 1, keys: [keyA.key, keyB.key] }) });
  assert.equal(ok.status, 200);
  const okBody = ok.json();
  assert.equal(okBody.v, 1);
  assert.equal(okBody.status, "ok");
  assert.equal(okBody.groups.length, 2);
  assert.ok(!("rejected" in okBody));

  // 部分失败：一有效一垃圾
  const partial = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 1, keys: [keyA.key, "sk-aifly-garbage"] }) });
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.json().rejected, [{ code: "key_invalid" }]);

  // 撤钥后混合：rejected key_revoked
  await store.revokeKey(keyA.keyId);
  const revokedMixed = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 1, keys: [keyA.key, keyB.key] }) });
  assert.equal(revokedMixed.status, 200);
  assert.deepEqual(revokedMixed.json().rejected, [{ code: "key_revoked" }]);

  // 全失败（独立三码之一）：403 {v:1,code:"key_all_invalid"}——与 request 的
  // key_invalid/key_revoked 三码分立
  const allBad = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 1, keys: ["sk-aifly-nope1", "sk-aifly-nope2"] }) });
  assert.equal(allBad.status, 403);
  assert.deepEqual(allBad.json(), { v: 1, code: "key_all_invalid" });

  // keys≤8（超限 400）；body 非 JSON/缺字段 400
  const nine = Array.from({ length: 9 }, (_, i) => `sk-aifly-${i}xxxxxxxx`);
  const tooMany = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 1, keys: nine }) });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json().code, "metadata_invalid");
  const badJson = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: "not json" });
  assert.equal(badJson.status, 400);
  const v2 = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 2, keys: [keyB.key] }) });
  assert.equal(v2.status, 400);
});

// ---------------------------------------------------------------------------
// request 端点矩阵
// ---------------------------------------------------------------------------

test("wire: request 成功——{responseId,epoch,status,headers} 形状；keyId 绑定传入 forward", async (t) => {
  const home = await tempHome("odai-wire-req-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA } = await fixture(home);
  let captured;
  const handler = createAiProviderWireHandler({
    store,
    forwardPlane: fakeForwardPlane((input) => {
      captured = input;
      return okUpstream();
    }),
  });
  const res = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers(
      [HDR_SERVICE, store.getServiceByName("openai").serviceId],
      [HDR_METHOD, "POST"],
      [HDR_PATH, "/v1/chat/completions"],
      [HDR_KEY_ID, keyA.keyId],
    ),
    body: jsonBytes({ model: "gpt-x" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { responseId: "ep-test:1", epoch: "ep-test", status: 200, headers: { "x-request-id": "up-1" } });
  assert.equal(captured.keyId, keyA.keyId);
  assert.equal(captured.group, "alpha");
  assert.equal(captured.service.name, "openai");
  assert.equal(captured.method, "POST");
  assert.equal(captured.path, "/v1/chat/completions");
});

test("wire: request x-odai-service 唯一来源——query/body 同名信息 400（service_source_conflict）", async (t) => {
  const home = await tempHome("odai-wire-dual-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA } = await fixture(home);
  const svcId = store.getServiceByName("openai").serviceId;
  const handler = createAiProviderWireHandler({ store, forwardPlane: fakeForwardPlane(okUpstream) });
  const base = headers([HDR_METHOD, "GET"], [HDR_PATH, "/v1/models"], [HDR_KEY_ID, keyA.keyId], [HDR_SERVICE, svcId]);

  const viaQuery = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request?service=evil", headers: base });
  assert.equal(viaQuery.status, 400);
  assert.equal(viaQuery.json().code, "service_source_conflict");
  const viaQuery2 = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request?serviceId=evil", headers: base });
  assert.equal(viaQuery2.status, 400);
  const viaBody = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: base,
    body: jsonBytes({ service: svcId, x: 1 }),
  });
  assert.equal(viaBody.status, 400);
  assert.equal(viaBody.json().code, "service_source_conflict");
  // 纯载荷 JSON（无 service 键）不受影响
  const clean = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request", headers: base, body: jsonBytes({ model: "m" }) });
  assert.equal(clean.status, 200);
  // 纯函数面
  assert.equal(serviceIdDuplicateSource("/x?serviceId=a", Buffer.alloc(0)), true);
  assert.equal(serviceIdDuplicateSource("/x?z=1", Buffer.from('{"serviceId":1}')), true);
  assert.equal(serviceIdDuplicateSource("/x?z=1", Buffer.from('{"model":"m"}')), false);
  assert.equal(serviceIdDuplicateSource("/x", Buffer.from([0x00, 0x01])), false);
});

test("wire: request 三码分立——未知 keyId=key_invalid（从未有效）/已撤=key_revoked（独立用例）", async (t) => {
  const home = await tempHome("odai-wire-codes-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA } = await fixture(home);
  const handler = createAiProviderWireHandler({ store, forwardPlane: fakeForwardPlane(okUpstream) });
  const svcId = store.getServiceByName("openai").serviceId;
  const mk = (keyId) => callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, svcId], [HDR_METHOD, "GET"], [HDR_PATH, "/v1/models"], [HDR_KEY_ID, keyId]),
  });
  // 从未有效
  const never = await mk("neverissued123");
  assert.equal(never.status, 403);
  assert.deepEqual(never.json(), { code: "key_invalid", message: "keyId was never issued by this provider" });
  // 已撤
  await store.revokeKey(keyA.keyId);
  const revoked = await mk(keyA.keyId);
  assert.equal(revoked.status, 403);
  assert.deepEqual(revoked.json(), { code: "key_revoked", message: "keyId has been revoked" });
  // 三码互不相同（byte 级）
  const allInvalid = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/auth", body: jsonBytes({ v: 1, keys: ["sk-aifly-zzzzzz"] }) });
  assert.equal(allInvalid.json().code, "key_all_invalid");
  assert.ok(!never.body.equals(revoked.body));
  assert.ok(!never.body.equals(allInvalid.body));
  assert.ok(!revoked.body.equals(allInvalid.body));
});

test("wire: request 404 族——unknown_service（未知/停用/跨组）与 path_not_offered（仅双过后）", async (t) => {
  const home = await tempHome("odai-wire-404svc-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA, keyB } = await fixture(home);
  const handler = createAiProviderWireHandler(realUpstreamHandler(store, keyA.key));
  const openaiId = store.getServiceByName("openai").serviceId;
  const otherId = store.getServiceByName("other").serviceId;
  const mk = (serviceId, path) => callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, serviceId], [HDR_METHOD, "GET"], [HDR_PATH, path], [HDR_KEY_ID, keyA.keyId]),
  });
  // 未知 serviceId
  const unknown = await mk("nonexistent", "/v1/x");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().code, "unknown_service");
  // 跨组（keyA=alpha，other 在 beta）
  const crossGroup = await mk(otherId, "/v1/x");
  assert.equal(crossGroup.status, 404);
  assert.equal(crossGroup.json().code, "unknown_service");
  // 停用
  await store.setServiceEnabled(openaiId, false);
  const disabled = await mk(openaiId, "/v1/x");
  assert.equal(disabled.status, 404);
  assert.equal(disabled.json().code, "unknown_service");
  await store.setServiceEnabled(openaiId, true);
  // 白名单外路径：gate+key 双过后才出现（与 not_found 同体不同体——独立 code）
  const notOffered = await mk(openaiId, "/user");
  assert.equal(notOffered.status, 404);
  assert.deepEqual(notOffered.json(), { code: "path_not_offered", message: "path is not offered by this service" });
  // gate 未过时绝不出现 path_not_offered（404 同体）
  const handler2 = createAiProviderWireHandler({ store, authorize: () => false, forwardPlane: fakeForwardPlane(okUpstream) });
  const gated = await callWire(handler2, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, openaiId], [HDR_METHOD, "GET"], [HDR_PATH, "/user"], [HDR_KEY_ID, keyA.keyId]),
  });
  assert.deepEqual(gated.body, NOT_FOUND_BODY);
  // keyB（beta 组）对 openai 同为 unknown_service
  const beta = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, openaiId], [HDR_METHOD, "GET"], [HDR_PATH, "/v1/models"], [HDR_KEY_ID, keyB.keyId]),
  });
  assert.equal(beta.json().code, "unknown_service");
});

test("wire: 400 元数据族——缺头/坏方法/坏路径/坏 x-odai-headers；头预算超限 metadata_too_large", async (t) => {
  const home = await tempHome("odai-wire-400-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA } = await fixture(home);
  const svcId = store.getServiceByName("openai").serviceId;
  const handler = createAiProviderWireHandler({ store, forwardPlane: fakeForwardPlane(okUpstream) });
  const good = headers([HDR_SERVICE, svcId], [HDR_METHOD, "POST"], [HDR_PATH, "/v1/x"], [HDR_KEY_ID, keyA.keyId]);

  const noService = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request", headers: good.filter((h) => h.name !== HDR_SERVICE) });
  assert.equal(noService.status, 400);
  assert.equal(noService.json().code, "metadata_invalid");
  const noKey = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request", headers: good.filter((h) => h.name !== HDR_KEY_ID) });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json().code, "metadata_invalid");
  const badMethod = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request", headers: good.map((h) => (h.name === HDR_METHOD ? { name: HDR_METHOD, value: "TRACE" } : h)) });
  assert.equal(badMethod.status, 400);
  const badPath = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request", headers: good.map((h) => (h.name === HDR_PATH ? { name: HDR_PATH, value: "//evil" } : h)) });
  assert.equal(badPath.status, 400);
  const badHdrList = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: [...good, { name: HDR_HEADERS, value: "not json" }],
  });
  assert.equal(badHdrList.status, 400);
  // 凭据头协议层拒绝（白名单表内 authorization）
  const credHdr = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: good,
  });
  assert.equal(credHdr.status, 200);
  const withCred = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: [...good, { name: HDR_HEADERS, value: JSON.stringify([{ name: "authorization", value: "Bearer x" }]) }],
  });
  assert.equal(withCred.status, 400);
  assert.equal(withCred.json().code, "metadata_invalid");
  // content-type 允许（结构性头——独立字段折叠）
  const withCT = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: [...good, { name: HDR_HEADERS, value: JSON.stringify([{ name: "content-type", value: "application/json" }]) }],
    body: jsonBytes({ a: 1 }),
  });
  assert.equal(withCT.status, 200);
  // 头预算：x-odai-* 合计 >8KiB → 400 metadata_too_large（其余 400 之前裁决）
  const big = "x".repeat(6000);
  const overBudget = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: [...good, { name: "x-odai-extra-a", value: big }, { name: "x-odai-extra-b", value: big }],
  });
  assert.equal(overBudget.status, 400);
  assert.equal(overBudget.json().code, "metadata_too_large");
  // 纯函数面：预算计算只计 x-odai-* 头
  assert.equal(metadataHeaderBytes(headers(["x-odai-a", "12"], ["accept", "zzz"])), Buffer.byteLength("x-odai-a") + 2);
});

test("wire: 413 边界——maxChunkPayload 恰好通过、+1 拒绝（零 forward）", async (t) => {
  const home = await tempHome("odai-wire-413-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA } = await fixture(home);
  const svcId = store.getServiceByName("openai").serviceId;
  let forwards = 0;
  const handler = createAiProviderWireHandler({
    store,
    forwardPlane: fakeForwardPlane((input) => {
      forwards += 1;
      return okUpstream();
    }),
  });
  const mkHeaders = () => headers([HDR_SERVICE, svcId], [HDR_METHOD, "POST"], [HDR_PATH, "/v1/x"], [HDR_KEY_ID, keyA.keyId]);
  // 非 2 的幂尺寸边界：恰好=MAX_CHUNK_PAYLOAD（无 content-length 头的拉流累计）
  const exact = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request", headers: mkHeaders(), body: Buffer.alloc(MAX_CHUNK_PAYLOAD, 0x61) });
  assert.equal(exact.status, 200);
  const over = await callWire(handler, { method: "POST", path: "/wpk1/ai/v1/request", headers: mkHeaders(), body: Buffer.alloc(MAX_CHUNK_PAYLOAD + 1, 0x61) });
  assert.equal(over.status, 413);
  assert.equal(over.json().code, "body_too_large");
  assert.match(over.json().message, /maxChunkPayload/);
  assert.equal(forwards, 1); // 仅恰好那次触达 forwardPlane
});

test("wire: 429 矩阵——rate_limited（并发）与 quota_exceeded（日限）独立码", async (t) => {
  const home = await tempHome("odai-wire-429-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA } = await fixture(home, { groupLimits: { dailyRequests: 1 } });
  const svcId = store.getServiceByName("openai").serviceId;
  const handler = createAiProviderWireHandler(realUpstreamHandler(store, keyA.key));
  const mk = () => callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, svcId], [HDR_METHOD, "GET"], [HDR_PATH, "/v1/models"], [HDR_KEY_ID, keyA.keyId]),
  });
  const first = await mk();
  assert.equal(first.status, 200);
  const second = await mk();
  assert.equal(second.status, 429);
  assert.deepEqual(second.json(), { code: "quota_exceeded", message: "daily request quota exceeded" });

  // rate_limited：组 maxConcurrency=1 + 在途占位（forward 挂起不结算）
  const home2 = await tempHome("odai-wire-429b-");
  t.after(() => rm(home2, { recursive: true, force: true }));
  const f2 = await fixture(home2, { groupLimits: { maxConcurrency: 1 } });
  const svc2 = f2.store.getServiceByName("openai").serviceId;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const h2 = createAiProviderWireHandler(realUpstreamHandler(f2.store, f2.keyA.key, { hang: gate }));
  const inFlight = callWire(h2, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, svc2], [HDR_METHOD, "GET"], [HDR_PATH, "/v1/models"], [HDR_KEY_ID, f2.keyA.keyId]),
  });
  await waitFor(() => true, 30);
  const concurrent = await callWire(h2, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers([HDR_SERVICE, svc2], [HDR_METHOD, "GET"], [HDR_PATH, "/v1/models"], [HDR_KEY_ID, f2.keyA.keyId]),
  });
  assert.equal(concurrent.status, 429);
  assert.deepEqual(concurrent.json(), { code: "rate_limited", message: "group concurrency limit reached" });
  release();
  const done = await inFlight;
  assert.equal(done.status, 200);
});

// ---------------------------------------------------------------------------
// catalog 端点
// ---------------------------------------------------------------------------

test("wire: catalog——未 auth=403 key_all_invalid；since 长轮询 204/200/hold 唤醒；坏 since=400", async (t) => {
  const home = await tempHome("odai-wire-cat-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store, keyA } = await fixture(home);
  const handler = createAiProviderWireHandler({ store, forwardPlane: fakeForwardPlane(okUpstream), holdMs: 400 });
  const rev0 = store.revision;

  // 未 auth（无/坏 keyId）
  for (const keyId of [null, "bogus"]) {
    const unauth = await callWire(handler, {
      method: "GET",
      path: "/wpk1/ai/v1/catalog",
      headers: keyId === null ? [] : headers([HDR_KEY_ID, keyId]),
    });
    assert.equal(unauth.status, 403);
    assert.deepEqual(unauth.json(), { v: 1, code: "key_all_invalid" });
  }
  // 全量直取（since 缺省/落后）：200 refresh:true + rev + 组视图
  const full = await callWire(handler, { method: "GET", path: "/wpk1/ai/v1/catalog", headers: headers([HDR_KEY_ID, keyA.keyId]) });
  assert.equal(full.status, 200);
  const body = full.json();
  assert.equal(body.v, 1);
  assert.equal(body.refresh, true);
  assert.equal(body.rev, rev0);
  assert.equal(body.catalog.groups.length, 1);
  assert.equal(body.catalog.groups[0].keyId, keyA.keyId);
  assert.equal(body.catalog.groups[0].services[0].name, "openai");
  assert.equal(full.header("x-odai-rev"), String(rev0));

  // 无变化：hold 超时（holdMs=400）→ 204 + x-odai-rev
  const unchanged = await callWire(handler, {
    method: "GET",
    path: `/wpk1/ai/v1/catalog?since=${rev0}`,
    headers: headers([HDR_KEY_ID, keyA.keyId]),
  });
  assert.equal(unchanged.status, 204);
  assert.deepEqual(unchanged.body, Buffer.alloc(0));
  assert.equal(unchanged.header("x-odai-rev"), String(rev0));

  // hold 期间变更 → 唤醒返回 200 新 rev
  const held = (async () =>
    callWire(handler, {
      method: "GET",
      path: `/wpk1/ai/v1/catalog?since=${rev0}`,
      headers: headers([HDR_KEY_ID, keyA.keyId]),
    }))();
  await waitFor(() => true, 10);
  await store.addService({ name: "late", upstream: "https://late.example.com:8443", match: [{ type: "exact", value: "l" }] }); // revision++
  const woken = await held;
  assert.equal(woken.status, 200);
  assert.ok(woken.json().rev > rev0);

  // 坏 since → 400
  const badSince = await callWire(handler, {
    method: "GET",
    path: "/wpk1/ai/v1/catalog?since=nope",
    headers: headers([HDR_KEY_ID, keyA.keyId]),
  });
  assert.equal(badSince.status, 400);
  assert.equal(badSince.json().code, "metadata_invalid");
});

// ---------------------------------------------------------------------------
// 工厂期拒绝面（admission 超积 / catalog 超配 / ambient env 启动命中）
// ---------------------------------------------------------------------------

test("wire: admission 域与超积——maxConcurrency 域 1..32、ring=×2MiB≤64MiB（validateAdmission）", () => {
  assert.deepEqual(validateAdmission(8), { ok: true });
  assert.deepEqual(validateAdmission(1), { ok: true });
  assert.deepEqual(validateAdmission(32), { ok: true });
  assert.equal(validateAdmission(0).ok, false);
  assert.equal(validateAdmission(33).ok, false);
  assert.equal(validateAdmission(2.5).ok, false);
  const ring = validateAdmission(32);
  assert.equal(ring.ok, true); // 32×2MiB=64MiB 恰在界内
});

test("wire: 工厂期拒绝——createAiProviderWireHandler 对超积 maxConcurrency 抛错", async (t) => {
  const home = await tempHome("odai-wire-factory-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const { store } = await fixture(home);
  assert.throws(() => createAiProviderWireHandler({ store, maxConcurrency: 33, forwardPlane: fakeForwardPlane(okUpstream) }), /maxConcurrency/);
});

test("wire: 工厂期拒绝——catalog JSON 超过 256KiB（≤256 服务但 detail 膨胀）", async (t) => {
  const home = await tempHome("odai-wire-catcap-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await ProviderStore.open(aiDataDir(home));
  // 256 服务 × ~1.2KiB match 值 → 投影 JSON 超 256KiB（服务数仍在门内）
  const bigValue = "m".repeat(1200);
  for (let i = 0; i < 256; i++) {
    await store.addService({
      name: `s${i}`,
      upstream: "https://example.com:8443",
      match: [{ type: "exact", value: bigValue }],
    });
  }
  assert.equal(store.listServices().length, 256);
  assert.throws(() => createAiProviderWireHandler({ store, forwardPlane: fakeForwardPlane(okUpstream) }), /256 KiB|catalog JSON exceeds/);
});

test("wire: 工厂期拒绝——已启用服务 keyEnv 命中进程环境（启动时点 fail-closed）", async (t) => {
  const home = await tempHome("odai-wire-startenv-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const dataDir = aiDataDir(home);
  // 手写一份「干净环境下落盘」的台账（写入路径的激活门在落盘时通过）；
  // 随后进程环境出现该变量 → provider 启动时点 fail-closed 拒绝。
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const svcId = "k8fpn1c3qxr7a";
  await writeFile(
    `${dataDir}/services.json`,
    JSON.stringify({
      version: 2,
      revision: 1,
      services: [
        {
          serviceId: svcId,
          name: "openai",
          match: [{ type: "suffix", value: ".openai.com" }],
          upstream: "https://api.openai.com:8443",
          defaultPort: 4300,
          enabled: true,
          keyEnv: "OPENAI_API_KEY",
          auth: { secret: "bound" },
        },
      ],
      groups: [],
      keys: [],
    }) + "\n",
    { mode: 0o600 },
  );
  const store = await ProviderStore.open(dataDir);
  assert.equal(store.listServices().length, 1);
  const ambient = (name) => (name === "OPENAI_API_KEY" ? "ambient-value" : undefined);
  assert.throws(
    () => createAiProviderWireHandler({ store, env: ambient, forwardPlane: fakeForwardPlane(okUpstream) }),
    (e) => e.message.includes("OPENAI_API_KEY") && e.message.includes("refusing to start"),
  );
  // 环境干净时可启动（同台账）
  const home2 = await tempHome("odai-wire-startenv2-");
  t.after(() => rm(home2, { recursive: true, force: true }));
  const store2 = await ProviderStore.open(aiDataDir(home2));
  const handler2 = createAiProviderWireHandler({ store: store2, forwardPlane: fakeForwardPlane(okUpstream) });
  assert.equal(typeof handler2, "function");
});

// ---------------------------------------------------------------------------
// 真上游一例（默认 forwardPlane 的注入缝=fetchImpl/probeConnect）+ 进程回收
// ---------------------------------------------------------------------------

test("wire: 默认 forward 面——request 经真上游（127.0.0.1 listener 显式回收）", async (t) => {
  const home = await tempHome("odai-wire-e2e-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const up = await startUpstream((rq, rs) => {
    assert.equal(rq.headers.authorization, "Bearer sk-real"); // auth 三族注入
    rs.writeHead(201, { "content-type": "application/json", "x-request-id": "real-1" });
    rs.end(Buffer.from('{"ok":1}'));
  });
  t.after(() => up.close());

  const secretsStore = await (await import("../src/provider/secrets.mjs")).SecretsStore.open(aiDataDir(home));
  await secretsStore.set("openai-key", "sk-real");
  const { store, keyA } = await fixture(home);
  const svcId = store.getServiceByName("openai").serviceId;
  // 重建服务绑定 secret auth（fixture 的 openai 无 auth）
  await store.removeService("openai");
  await store.addService({
    name: "openai",
    upstream: up.origin,
    match: [{ type: "suffix", value: ".openai.com" }],
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    auth: { secret: "openai-key" },
  });
  await store.setGroupServices("alpha", ["openai"]); // remove+add 后重建组引用
  const newId = store.getServiceByName("openai").serviceId;
  const handler = createAiProviderWireHandler({
    store,
    probeConnect: async () => undefined,
    timeouts: { connectMs: 2000, firstByteMs: 5000, stallMs: 5000 },
  });
  const res = await callWire(handler, {
    method: "POST",
    path: "/wpk1/ai/v1/request",
    headers: headers(
      [HDR_SERVICE, newId],
      [HDR_METHOD, "POST"],
      [HDR_PATH, "/v1/chat/completions"],
      [HDR_KEY_ID, keyA.keyId],
      [HDR_HEADERS, JSON.stringify([{ name: "content-type", value: "application/json" }])],
    ),
    body: jsonBytes({ model: "m" }),
  });
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.status, 201);
  assert.match(body.responseId, /^.{1,13}:1$/);
  assert.equal(body.headers["x-request-id"], "real-1");
  assert.equal(up.hits.length, 1);
  assert.equal(up.hits[0].url, "/v1/chat/completions");
  assert.equal(up.hits[0].headers["content-type"], "application/json");
  // 进程回收证据：listener 关闭后连接归零（socket close 事件异步到达——有界等待）
  await up.close();
  await waitFor(() => up.activeConnections === 0, 3000, "upstream connections drained after close");
});

// ---------------------------------------------------------------------------
// gate op 名（§3：ai/v1/{auth,catalog,request,response,cancel}）
// ---------------------------------------------------------------------------

test("wire: gate op 名与路径解析矩阵", () => {
  assert.deepEqual(parseWirePath("/wpk1/ai/v1/auth"), { op: "auth" });
  assert.deepEqual(parseWirePath("/wpk1/ai/v1/catalog?since=3"), { op: "catalog" });
  assert.deepEqual(parseWirePath("/wpk1/ai/v1/request"), { op: "request" });
  assert.deepEqual(parseWirePath("/wpk1/ai/v1/response/abc:1"), { op: "response" });
  assert.deepEqual(parseWirePath("/wpk1/ai/v1/cancel"), { op: "cancel" });
  assert.equal(parseWirePath("/wpk1/ai/v1"), null);
  assert.equal(parseWirePath("/wpk1/ai/"), null);
  assert.equal(parseWirePath("/wpk1/ai/v1/auth/extra"), null);
  assert.equal(parseWirePath("/wpk1/ai/v1/response/a/b"), null);
  assert.equal(parseWirePath("/wpk1/ports/proxy/1"), null);
  for (const op of ["auth", "catalog", "request", "response", "cancel"]) {
    assert.equal(opGateName(op), `ai/v1/${op}`);
  }
});
