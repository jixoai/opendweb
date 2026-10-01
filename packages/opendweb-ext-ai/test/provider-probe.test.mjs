// 上游探活单测（ai-subscription-sharing Phase D / tasks D2）。
// 覆盖：
// 1. 同一 hook 管线/auth 槽：探活请求经 buildUpstreamRequest 全链（真本地
//    上游断言路径映射与 authorization 头——Bearer secret 值）。
// 2. 三态：reachable（任意 HTTP 状态即达——401 亦算）/ unreachable（连接
//    失败、超时、管线 hook 失败）/ no_auth（keyEnv 未绑 auth 槽、secret 缺失
//    ——零上游触达）。
// 3. 脱敏：结果投影只有 state/status/reason/keyEnv/ms——无头、无 URL 查询、
//    无原始错误文案。
// 4. mgmt 接线：POST /services/:id/probe（真实本地 fake 上游 → reachable；
//    未知服务 404）。
// 常驻进程回收：fake 上游 listener 全部 t.after 显式 close（留证）。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir, startUpstream } from "./helpers.mjs";
import { probeUpstream, PROBE_TIMEOUT_MS } from "../src/provider/probe.mjs";
import { createAiRuntime } from "../src/runtime.mjs";

test("probe: reachable via same pipeline (path mapping + Bearer secret) with any upstream status", async (t) => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(() => upstream.close());
  const service = {
    serviceId: "svc1",
    name: "openai-ish",
    upstream: upstream.origin, // 预设形态：base=裸 origin，版本段在路由 upstreamPrefix
    match: [{ type: "suffix", value: ".example" }],
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    auth: { secret: "openai-main" },
  };
  const out = await probeUpstream({ service, secrets: (name) => (name === "openai-main" ? "sk-real-upstream-value" : undefined) });
  assert.deepEqual(
    { ...out, ms: 0 },
    { state: "reachable", status: 401, ms: 0 },
    "任意 HTTP 状态即达（401 证明上游应答）",
  );
  // 同一管线断言：探活走路由白名单首条 prefix 路由 + ① auth 槽取值
  assert.equal(upstream.hits.length, 1);
  assert.equal(upstream.hits[0].method, "GET");
  assert.equal(upstream.hits[0].url, "/v1");
  assert.equal(upstream.hits[0].headers["authorization"], "Bearer sk-real-upstream-value");
  // 脱敏：结果投影零头表、零 URL、零文案
  const json = JSON.stringify(out);
  assert.ok(!json.includes("authorization") && !json.includes("sk-real-upstream-value") && !json.includes("headers"));
});

test("probe: unreachable family — connect refused / timeout / no route path", async (t) => {
  // 连接拒绝：已释放端口
  const dead = net.createServer();
  const deadPort = await new Promise((resolve) => {
    dead.listen(0, "127.0.0.1", () => {
      const p = /** @type {net.AddressInfo} */ (dead.address()).port;
      dead.close(() => resolve(p));
    });
  });
  const refused = await probeUpstream({
    service: { serviceId: "s", name: "s", upstream: `http://127.0.0.1:${deadPort}`, match: [] },
    timeouts: { connectMs: 1000, firstByteMs: 1000 },
  });
  assert.equal(refused.state, "unreachable");
  assert.equal(refused.reason, "upstream_unreachable");

  // 超时：接受连接但永不响应（TCP 探测过、首字节超时）
  const silent = net.createServer((socket) => {
    socket.on("data", () => undefined); // 吞请求不响应
    socket.on("error", () => undefined);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        silent.closeAllConnections?.();
        silent.close(() => resolve(undefined));
      }),
  );
  const silentPort = await new Promise((resolve) => {
    silent.listen(0, "127.0.0.1", () => resolve(/** @type {net.AddressInfo} */ (silent.address()).port));
  });
  const timedOut = await probeUpstream({
    service: { serviceId: "s", name: "s", upstream: `http://127.0.0.1:${silentPort}`, match: [] },
    timeouts: { connectMs: 1000, firstByteMs: 300 },
  });
  assert.equal(timedOut.state, "unreachable");
  assert.equal(timedOut.reason, "timeout");

  // pattern-only 路由：无法合成白名单路径 → path_not_offered（不绕白名单）
  const patternOnly = await probeUpstream({
    service: {
      serviceId: "s",
      name: "s",
      upstream: "https://example.com",
      match: [],
      routes: [{ forms: ["openai-chat"], mode: "pattern", matchPattern: "https://example.com/x/*:rest", template: "/y/{rest}" }],
    },
    timeouts: { connectMs: 200, firstByteMs: 200 },
  });
  assert.deepEqual({ ...patternOnly, ms: 0 }, { state: "unreachable", reason: "path_not_offered", ms: 0 });
});

test("probe: no_auth family — keyEnv unbound / bound secret missing (zero upstream contact)", async () => {
  const unbound = await probeUpstream({
    service: { serviceId: "s", name: "openai", upstream: "https://api.openai.com/v1", match: [], keyEnv: "OPENAI_API_KEY" },
  });
  assert.deepEqual({ ...unbound, ms: 0 }, { state: "no_auth", reason: "keyenv_unbound", keyEnv: "OPENAI_API_KEY", ms: 0 });

  // auth 槽声明但 secret 在库缺失（补救动作同一：绑 secret）
  const missing = await probeUpstream({
    service: { serviceId: "s", name: "openai", upstream: "https://api.openai.com/v1", match: [], keyEnv: "OPENAI_API_KEY", auth: { secret: "gone" } },
    secrets: () => undefined,
  });
  assert.deepEqual({ ...missing, ms: 0 }, { state: "no_auth", reason: "secret_missing", ms: 0 });

  // 无 keyEnv 无 auth（本地 ollama 族）→ 正常探活（匿名）
  assert.equal(PROBE_TIMEOUT_MS, 5000, "design §6：探活超时 5s");
});

test("mgmt probe endpoint: POST /services/:id/probe over fake upstream + 404 unknown", async (t) => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  t.after(() => upstream.close());
  const home = await tempHome("odai-probe-");
  t.after(() => rm(home, { recursive: true, force: true }));

  const rt = await createAiRuntime({
    home,
    fabric: {
      fetchHttpImpl: async () => {
        throw new Error("fabric not exercised by probe tests");
      },
      sessionResolver: async () => null,
    },
    env: () => undefined,
    now: () => Date.now(),
    log: () => {},
  });
  await rt.start();
  t.after(() => rt.stop());

  // 自定义服务指向本地 fake 上游（无 keyEnv——匿名可达面）
  const created = await rt.mgmt.handle("POST", "/services", new URLSearchParams(), {
    service: { name: "local-fake", upstream: upstream.origin, match: [{ type: "suffix", value: ".local" }] },
  });
  assert.equal(created?.status, 200, JSON.stringify(created?.body));
  const serviceId = /** @type {any} */ (created?.body).service.serviceId;

  const probed = await rt.mgmt.handle("POST", `/services/${serviceId}/probe`, new URLSearchParams(), {});
  assert.equal(probed?.status, 200, JSON.stringify(probed?.body));
  const body = /** @type {any} */ (probed?.body);
  assert.equal(body.serviceId, serviceId);
  assert.equal(body.state, "reachable");
  assert.equal(body.status, 200);
  assert.ok(typeof body.ms === "number");
  assert.ok(!JSON.stringify(body).includes("headers"), "脱敏投影");

  const nf = await rt.mgmt.handle("POST", "/services/nope/probe", new URLSearchParams(), {});
  assert.equal(nf?.status, 404);
});
