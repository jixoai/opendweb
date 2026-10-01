// hooks 阶段契约 + rewrite 上游请求构造单测（ai-fly test/unit/provider/
// {hook-stages,rewrite}.test.ts 矩阵移植 + Phase A env 面负向）：
// 头链顺序、路由白名单（path_not_offered）、origin 双重断言、bearer、
// $secret 解析/缺失、脚本槽（loader 注入不触盘）、**env 等值负向**。

import test from "node:test";
import assert from "node:assert/strict";
import { resolveAuthSlotValue, buildUpstreamRequest, resolveLiteralHeaderValue, SecretMissingError, PathNotOfferedError, RewriteError, applyBearerPrefix } from "../src/provider/rewrite.mjs";
import { resolveStageAuth, resolveStageHeaders, resolveStageRequest, resolveStageResponse, HookMissingError, HookStageError, effectiveLifecycleSlots } from "../src/provider/hooks.mjs";
import { buildServiceDetail } from "../src/provider/detail.mjs";

const loaderOf = (mods) => (name) => mods[name];

test("hooks: ① 三态契约（string/Promise/AsyncIterable 订阅）+ 失效归 HookMissingError", async () => {
  const loader = loaderOf({
    sync: { onRequestBearerAuthentication: () => "tok-sync" },
    promise: { onRequestBearerAuthentication: async () => "tok-async" },
    stream: {
      onRequestBearerAuthentication: async function* () {
        yield "tok-1";
        yield "tok-2";
      },
    },
    missing: {},
    throwing: {
      onRequestBearerAuthentication: () => {
        throw new Error("boom");
      },
    },
    empty: { onRequestBearerAuthentication: () => "" },
  });
  assert.equal(await resolveStageAuth({ script: "sync" }, { loader }), "tok-sync");
  assert.equal(await resolveStageAuth({ script: "promise" }, { loader }), "tok-async");
  assert.equal(await resolveStageAuth({ script: "stream" }, { loader }), "tok-1");
  await assert.rejects(() => resolveStageAuth({ script: "missing" }, { loader }), HookMissingError);
  await assert.rejects(() => resolveStageAuth({ script: "throwing" }, { loader }), HookMissingError);
  await assert.rejects(() => resolveStageAuth({ script: "empty" }, { loader }), HookMissingError);
  await assert.rejects(() => resolveStageAuth({ script: "nope" }, { loader }), HookMissingError);
});

test("hooks: ② 返回形状（{set,remove}；未知键/超限/非 string → HookStageError）", async () => {
  const loader = loaderOf({
    ok: {
      onRequestHeaders: () => ({ set: { "x-a": "1" }, remove: ["x-b"] }),
    },
    noop: { onRequestHeaders: () => ({}) },
    badkey: { onRequestHeaders: () => ({ sets: {} }) },
    overflow: { onRequestHeaders: () => ({ set: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`h${i}`, "v"])) }) },
    throwing: {
      onRequestHeaders: () => {
        throw new Error("x");
      },
    },
    missing: {},
  });
  const req = { method: "GET", path: "/", headers: {} };
  assert.deepEqual(await resolveStageHeaders({ name: "ok" }, req, { loader }), { set: { "x-a": "1" }, remove: ["x-b"] });
  assert.deepEqual(await resolveStageHeaders({ name: "noop" }, req, { loader }), {});
  await assert.rejects(() => resolveStageHeaders({ name: "badkey" }, req, { loader }), HookStageError);
  await assert.rejects(() => resolveStageHeaders({ name: "overflow" }, req, { loader }), HookStageError);
  await assert.rejects(() => resolveStageHeaders({ name: "throwing" }, req, { loader }), HookStageError);
  await assert.rejects(() => resolveStageHeaders({ name: "missing" }, req, { loader }), HookStageError);
});

test("hooks: ③/④ 返回形状（status 域 200..599；顶层键 strict；body 流形态）", async () => {
  const loader = loaderOf({
    req: { onRequest: () => ({ status: 200, headers: { "content-type": "text/event-stream" } }) },
    reqBad: { onRequest: () => ({ status: 100, headers: {} }) },
    reqBody: {
      onRequest: async () => ({ status: 200, headers: {}, body: (async function* () { yield new Uint8Array([1]); })() }),
    },
    resp: { onResponse: () => ({ status: 201 }) },
    respBody: { onResponse: async () => ({ body: (async function* () {})() }) },
    respBad: { onResponse: () => ({ status: 700 }) },
  });
  const base = { loader };
  const ok = await resolveStageRequest({ name: "req" }, { url: "http://x/", method: "POST", headers: {}, body: new Uint8Array(), signal: new AbortController().signal }, base);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.headers, { "content-type": "text/event-stream" });
  await assert.rejects(
    () => resolveStageRequest({ name: "reqBad" }, { url: "http://x/", method: "POST", headers: {}, body: new Uint8Array(), signal: new AbortController().signal }, base),
    HookStageError,
  );
  const withBody = await resolveStageRequest({ name: "reqBody" }, { url: "http://x/", method: "POST", headers: {}, body: new Uint8Array(), signal: new AbortController().signal }, base);
  assert.ok(withBody.body !== undefined);
  const override = await resolveStageResponse({ name: "resp" }, { status: 200, headers: {}, body: emptyStream(), signal: new AbortController().signal }, base);
  assert.deepEqual(override, { status: 201 });
  const overrideBody = await resolveStageResponse({ name: "respBody" }, { status: 200, headers: {}, body: emptyStream(), signal: new AbortController().signal }, base);
  assert.ok(overrideBody.body !== undefined);
  await assert.rejects(() => resolveStageResponse({ name: "respBad" }, { status: 200, headers: {}, body: emptyStream(), signal: new AbortController().signal }, base), HookStageError);
});

function emptyStream() {
  return (async function* () {})();
}

test("hooks: effectiveLifecycleSlots——预设模式按 stages 矩阵逐阶段取导出", () => {
  const loader = loaderOf({
    full: {
      onRequestBearerAuthentication: () => "t",
      onRequestHeaders: () => ({}),
      onRequest: () => ({ status: 200, headers: {} }),
      onResponse: () => ({}),
    },
    authOnly: { onRequestBearerAuthentication: () => "t" },
  });
  const full = effectiveLifecycleSlots({ hooks: { script: "full" } }, { loader });
  assert.equal(full.auth.script, "full");
  assert.equal(full.headersScript.name, "full");
  assert.equal(full.request.script, "full");
  assert.equal(full.response.script, "full");
  const authOnly = effectiveLifecycleSlots({ hooks: { script: "authOnly" } }, { loader });
  assert.equal(authOnly.auth.script, "authOnly");
  assert.equal(authOnly.headersScript, undefined);
  assert.equal(authOnly.request, undefined); // ③ 缺导出 → 原生路径
  // 自定义模式原样透传
  const custom = effectiveLifecycleSlots({ auth: { secret: "x" } }, { loader });
  assert.deepEqual(custom.auth, { secret: "x" });
});

// ---------------------------------------------------------------------------
// rewrite
// ---------------------------------------------------------------------------

const svc = (over = {}) => ({
  serviceId: "s",
  name: "s",
  upstream: "https://api.example.com",
  match: [{ type: "suffix", value: ".example.com" }],
  defaultPort: 4300,
  ...over,
});

test("rewrite: 基础拼接——基础路径+请求路径+查询串；Host 缺省上游", async () => {
  const plan = await buildUpstreamRequest(svc(), { method: "GET", path: "/v1/chat/completions?x=1" });
  assert.equal(plan.url.href, "https://api.example.com/v1/chat/completions?x=1");
  assert.equal(plan.host, "api.example.com");
  assert.equal(plan.headers["host"], undefined); // host 不在出站头集（独立字段）
});

test("rewrite: 路由白名单——prefix 模式命中改写、未命中 PathNotOffered（零上游）", async () => {
  const withRoutes = svc({
    upstream: "https://api.example.com",
    routes: [
      { forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" },
      { forms: ["anthropic"], localPrefix: "/anthropic", upstreamPrefix: "/anthropic" },
    ],
  });
  const hit = await buildUpstreamRequest(withRoutes, { method: "POST", path: "/v1/chat" });
  assert.equal(hit.url.pathname, "/v1/chat");
  const anthropic = await buildUpstreamRequest(withRoutes, { method: "POST", path: "/anthropic/v1/messages" });
  assert.equal(anthropic.url.pathname, "/anthropic/v1/messages");
  // 白名单外（/user、/balance）→ path_not_offered
  for (const bad of ["/user", "/balance", "/"]) {
    await assert.rejects(() => buildUpstreamRequest(withRoutes, { method: "GET", path: bad }), PathNotOfferedError);
  }
});

test("rewrite: pattern 模式——URLPattern 捕获组+查询变量→RFC 6570 模板", async () => {
  const patternSvc = svc({
    routes: [{ forms: [], mode: "pattern", matchPattern: "/v1/:model/:thread", template: "/api/{model}/t/{thread}?m={model}" }],
  });
  const plan = await buildUpstreamRequest(patternSvc, { method: "GET", path: "/v1/gpt-4/t1?extra=9" });
  assert.equal(plan.url.pathname, "/api/gpt-4/t/t1");
  assert.equal(plan.url.search, "?m=gpt-4");
});

test("rewrite: strip/append 段边界；rewrite.host 覆盖；origin 双重断言", async () => {
  const stripAppend = svc({ rewrite: { pathPrefixStrip: "/v1", pathPrefixAppend: "/api", host: "override.example.com" } });
  const plan = await buildUpstreamRequest(stripAppend, { method: "GET", path: "/v1/chat" });
  assert.equal(plan.url.pathname, "/api/chat");
  assert.equal(plan.host, "override.example.com");
  // strip 不误伤 /v11
  const miss = await buildUpstreamRequest(stripAppend, { method: "GET", path: "/v11/x" });
  assert.equal(miss.url.pathname, "/api/v11/x");
  // 防御：路径形状（//、反斜杠、scheme、点段）
  for (const bad of ["//x", "/a\\b", "/http://x", "/a/../b", "/a/./b"]) {
    await assert.rejects(() => buildUpstreamRequest(svc(), { method: "GET", path: bad }), RewriteError);
  }
});

test("rewrite: 头链——凭据/归属头剥离→auth 注入→remove→set→脚本增量→防护过滤", async () => {
  const loader = loaderOf({
    hdr: {
      onRequestHeaders: async (ctx) => {
        assert.equal(ctx.method, "POST");
        return { set: { "x-script": "yes", host: "evil.example.com" }, remove: ["x-doomed"] };
      },
    },
  });
  const service = svc({
    auth: { secret: "openai" },
    headers: { remove: ["x-del"], set: { "x-set": "$secret:aux", "x-plain": "literal" }, script: { name: "hdr" } },
  });
  const secrets = (name) => (name === "openai" ? "sk-real" : name === "aux" ? "aux-val" : undefined);
  const plan = await buildUpstreamRequest(
    service,
    {
      method: "POST",
      path: "/v1/x",
      headers: { authorization: "Bearer consumer-key", cookie: "session=1", host: "evil", "x-keep": "v", "x-del": "gone", "x-doomed": "gone" },
      contentType: "application/json",
    },
    secrets,
    { loader },
  );
  assert.equal(plan.headers.authorization, "Bearer sk-real"); // ① 注入胜过入站
  assert.equal(plan.headers.cookie, undefined);
  assert.equal(plan.headers["x-del"], undefined);
  assert.equal(plan.headers["x-set"], "aux-val");
  assert.equal(plan.headers["x-plain"], "literal");
  assert.equal(plan.headers["x-script"], "yes");
  assert.equal(plan.headers["x-doomed"], undefined);
  assert.equal(plan.headers["content-type"], "application/json");
  assert.equal(plan.headers.host, undefined); // 防护过滤（host 由 plan.host 承载）
});

test("rewrite: bearer 开关——默认拼、已带不重复、false 原样", async () => {
  assert.equal(applyBearerPrefix("sk-1", undefined), "Bearer sk-1");
  assert.equal(applyBearerPrefix("Bearer sk-1", undefined), "Bearer sk-1");
  assert.equal(applyBearerPrefix("sk-1", false), "sk-1");
  const off = await resolveAuthSlotValue({ secret: "k", bearer: false }, { method: "GET", path: "/", headers: {}, secrets: () => "sk-1" });
  assert.equal(off, "sk-1");
});

test("rewrite: auth 三族失效——secret 未命中=SecretMissingError（消息不含名/值）；literal $secret 缺失同族", async () => {
  await assert.rejects(
    () => resolveAuthSlotValue({ secret: "ghost" }, { method: "GET", path: "/", headers: {}, secrets: () => undefined }),
    (e) => e instanceof SecretMissingError && e.message === "referenced secret is missing",
  );
  assert.throws(() => resolveLiteralHeaderValue("$secret:ghost", () => undefined), SecretMissingError);
  // resolveLiteralHeaderValue 无 env 分支：等值 secret 放入 process.env 也不影响
  process.env["ODAI_TEST_EQUIV"] = "env-equivalent";
  try {
    assert.equal(resolveLiteralHeaderValue("$secret:k", () => "store-val"), "store-val");
    assert.equal(resolveLiteralHeaderValue("plain", undefined), "plain");
    assert.equal(resolveLiteralHeaderValue("", undefined), undefined); // 空串=省略
  } finally {
    delete process.env["ODAI_TEST_EQUIV"];
  }
});

test("rewrite: 【env 等值负向（§4 必测）】env 中人为放入等值 secret，请求仍不得携带 env 值", async (t) => {
  t.after(() => {
    delete process.env.OPENAI_API_KEY;
  });
  // 环境放入与密钥库同名的变量（值为诱饵）——auth 解析只走密钥库
  process.env.OPENAI_API_KEY = "sk-from-env-decoy";
  const secrets = (name) => (name === "openai" ? "sk-from-store" : undefined);
  const plan = await buildUpstreamRequest(
    svc({ auth: { secret: "openai" }, headers: { set: { "x-api-key": "$secret:openai" } } }),
    { method: "GET", path: "/v1/x", headers: {} },
    secrets,
  );
  assert.equal(plan.headers.authorization, "Bearer sk-from-store");
  assert.equal(plan.headers["x-api-key"], "sk-from-store");
  const serialized = JSON.stringify(plan.headers);
  assert.ok(!serialized.includes("env-decoy"), "env 值绝不出现在出站头");
});

test("rewrite: script auth 槽（loader 注入）与 hooks 预设模式 ① 注入", async () => {
  const loader = loaderOf({ authHook: { onRequestBearerAuthentication: () => "tok-hook" } });
  const plan = await buildUpstreamRequest(
    svc({ auth: { script: "authHook", bearer: false } }),
    { method: "GET", path: "/v1/x", headers: {} },
    undefined,
    { loader },
  );
  assert.equal(plan.headers.authorization, "tok-hook");
  const preset = await buildUpstreamRequest(
    svc({ hooks: { script: "authHook" } }),
    { method: "GET", path: "/v1/x", headers: {} },
    undefined,
    { loader },
  );
  assert.equal(preset.headers.authorization, "Bearer tok-hook");
});

test("rewrite: WS 升级检测（v1 不透传——检测保留）", async () => {
  const plan = await buildUpstreamRequest(svc(), {
    method: "GET",
    path: "/v1/x",
    headers: { connection: "keep-alive, Upgrade", upgrade: "WebSocket" },
  });
  assert.equal(plan.isWebSocketUpgrade, true);
  const plain = await buildUpstreamRequest(svc(), { method: "GET", path: "/v1/x", headers: { connection: "keep-alive" } });
  assert.equal(plain.isWebSocketUpgrade, false);
});
