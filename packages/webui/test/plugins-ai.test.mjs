// ai 插件宿主接入直测（ai-subscription-sharing Phase C / tasks C 门用例）。
// 覆盖：
// 1. descriptor：@jixo/opendweb-ext-ai/opendweb-webui-plugin 子路径导出经
//    validateWebuiPluginDescriptor 全量校验；registry 含 ai（四内置）；
//    「即将推出」占位不含 ai；UI PLUGIN_ROUTE_REGISTRY 两页（provider=admin /
//    consumer=member，managed=true）。
// 2. data-plane 双姿态装配：buildPluginRuntimes 的 channel.ai 原生 PluginRuntime
//    形状（onEnable/onDispose/onConfigChange）+ management.ai；enable 装配
//    provider 面（wireHandler 404 统一纪律）+ dispose 拆面（在途平面停）。
// 3. /sidecar/plugins/ai/* 管理面（经 createSidecar 真实 HTTP 链路 + SDK 替身）：
//    GET=基线 Host 守卫四态；写路由精确 Origin 四类；提供方全流程（secret →
//    预设服务 → 分组 → 签发密钥（原文仅响应体）→ 脱敏 overview）。
// 4. 生命周期四步序：enable 恢复 consumer 本地端点（账本+钥环预置）→ 停用
//    =端点全关（端口拒连）+ wire 摘牌（503）。
// 凭证纪律断言：列表/overview 投影零密钥原文（掩码 ●）；签发响应体含原文。
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSidecar } from "../src/core/sidecar.mjs";
import { buildPluginRuntimes } from "../src/core/plugins/data-plane.mjs";
import { validateWebuiPluginDescriptor } from "../src/core/plugins/contract.mjs";
import { builtinWebuiPluginDescriptors, comingSoonPlugins } from "../src/core/plugins/registry.mjs";
import { request } from "./helpers.mjs";
import { hexToZ32 } from "../src/core/fabric.mjs";
import { PLUGIN_ROUTE_REGISTRY } from "../ui/src/lib/plugin-registry.ts";
import { aiWebuiPluginDescriptor as aiDescriptorSource } from "@jixo/opendweb-ext-ai/opendweb-webui-plugin";

const LEASE = {
  id: "a1b2c3d4e5",
  server: "http://192.168.2.13:8787",
  relay_url: "http://192.168.2.13:3340",
  server_id: "01".repeat(32),
  fabric_id: "aa".repeat(32),
  root: "bb".repeat(32),
  alias: "mini",
  label: null,
  registered_at: 1,
  expires_at: 2,
  receipt: null,
};
const PEER = "ab".repeat(32);
const jsonHeaders = { "content-type": "application/json" };

async function tempHome(withLease = true) {
  const home = await mkdtemp(path.join(tmpdir(), "wpk-ai-"));
  if (withLease) {
    await writeFile(path.join(home, "leases.json"), JSON.stringify({ version: 1, leases: [LEASE] }, null, 2), "utf8");
  }
  return home;
}

/** SDK 替身（plugins-wire 同族；serveHttp 捕获 handler 供直接调用）。 */
function makeFakeSdk() {
  const calls = [];
  let eventCb = null;
  const serveHandlers = new Map();
  const fetchResponses = [];
  const fabric = {
    endpointId: hexToZ32(LEASE.root),
    async rootEndpointId() {
      return fabric.endpointId;
    },
    async fabricIdHex() {
      return LEASE.fabric_id;
    },
    async ensureRelayCapabilities() {
      return [];
    },
    async start() {
      calls.push("start");
    },
    async connect() {},
    async openSession(peer) {
      return { peerId: peer, sessionId: `sess-out-${peer}`, onState: () => () => {}, async close() {} };
    },
    on(cb) {
      eventCb = cb;
      return () => {};
    },
    async shutdown() {},
    async members() {
      return [];
    },
    async invite(_ttl, recipient) {
      return `dweb1.fakeinvite.${recipient.slice(0, 8)}`;
    },
  };
  return {
    sdk: {
      Fabric: {
        async open() {
          return fabric;
        },
      },
      async serveHttp(_f, peer, handler) {
        serveHandlers.set(peer, handler);
        return { close: () => {} };
      },
      async fetchHttp(_session, _req) {
        const r = fetchResponses.length > 0 ? fetchResponses.shift() : { status: 200, headers: [], bodyNext: async () => null };
        return { status: r.status, headers: r.headers ?? [], bodyNext: r.bodyNext ?? (async () => null) };
      },
    },
    calls,
    fabric,
    serveHandlers,
    fetchResponses,
    emit(ev) {
      eventCb?.(ev);
    },
  };
}

/** serveHttp 类型化请求替身。 */
function typedRequest(over = {}) {
  const controller = new AbortController();
  const bodyQueue = (over.bodyChunks ?? []).map((c) => Buffer.from(c));
  return {
    requestId: 1,
    streamId: 1,
    sessionId: "sess-in",
    signal: controller.signal,
    method: over.method ?? "GET",
    path: over.path ?? "/",
    headers: over.headers ?? [],
    bodyNext: async () => bodyQueue.shift() ?? null,
    respondStreaming: () => null,
  };
}

/** 端口可连性探测（true=有监听接受连接）。 */
function portAccepts(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

/** 空闲端口（bind 0→读回→释放）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => resolve(port));
    });
  });
}

const sameOrigin = (sc) => ({ host: `127.0.0.1:${sc.port}`, origin: sc.origin });

test.afterEach(() => {});

// ---- ① descriptor + 注册表 + 占位删除 -----------------------------------------------

test("ai descriptor: subpath export validates; registry contains ai; coming-soon drops ai", async () => {
  const v = validateWebuiPluginDescriptor(aiDescriptorSource);
  assert.ok(v.ok, `descriptor must validate: ${v.ok ? "" : v.error}`);
  assert.equal(aiDescriptorSource.id, "ai");
  assert.equal(aiDescriptorSource.webuiApi, 1);
  assert.deepEqual(
    aiDescriptorSource.pages.map((p) => [p.id, p.perspective, p.type]),
    [
      ["provider", "admin", "page"],
      ["consumer", "member", "page"],
    ],
    "provider=admin / consumer=member 双姿态（design §1）",
  );
  assert.deepEqual(aiDescriptorSource.dataEndpoints, [{ id: "wire", path: "/wpk1/ai/" }]);
  assert.deepEqual(Object.keys(aiDescriptorSource.configSchema.properties).sort(), ["dailyRequests", "maxConcurrency", "usageLog"]);
  assert.deepEqual(aiDescriptorSource.configSchema.required, []);

  const builtins = builtinWebuiPluginDescriptors();
  assert.deepEqual(builtins.map((d) => d.id), ["ports", "files", "sync", "ai"]);
  assert.ok(!comingSoonPlugins().some((c) => c.id === "ai"), "占位清单不再含 ai");

  // UI 路由注册表对齐（managed=true；visibility 与 descriptor 一致）
  const provider = PLUGIN_ROUTE_REGISTRY.find((e) => e.routeId === "#/p/ai/provider");
  const consumer = PLUGIN_ROUTE_REGISTRY.find((e) => e.routeId === "#/p/ai/consumer");
  assert.ok(provider !== undefined && provider.managed === true && provider.visibility === "admin");
  assert.ok(consumer !== undefined && consumer.managed === true && consumer.visibility === "member");
});

// ---- ② data-plane 双姿态装配 ----------------------------------------------------------

test("data-plane: ai runtime assembles (provider stance eager, consumer stance by ledger); lifecycle assembles/disposes the plane", async (t) => {
  const home = await tempHome(false);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fabricFace = {
    async identity() {
      return null;
    },
    async sessionResolver() {
      return null;
    },
    async fetchHttpImpl() {
      throw new Error("not reached in this test");
    },
    async resolvePeerBySession() {
      return null;
    },
    async ensureStarted() {},
    async issueInvite() {
      return { token: "dweb1.x" };
    },
    onPeerOnline() {
      return () => {};
    },
  };
  const rt = await buildPluginRuntimes({ home, fabric: fabricFace, log: () => {}, now: () => Date.now() });
  const ai = rt.management.ai;
  assert.ok(typeof ai.onEnable === "function" && typeof ai.onDispose === "function" && typeof ai.onConfigChange === "function", "channel.ai 原生 PluginRuntime 形状");
  assert.equal(rt.channel.ai, ai, "channel 与 management 同一实例");

  // 未装配：wireHandler 给稳定 503（内核 gate 先行——此处直测防御路径）
  const cold = await ai.wireHandler(typedRequest({ method: "POST", path: "/wpk1/ai/v1/auth" }), "peer");
  assert.equal(cold.status, 503);

  // 配置域校验（工厂域——design §1：1–32 / 0–1,000,000 / bool）
  const { validateAiConfig } = await import("@jixo/opendweb-ext-ai");
  assert.equal(validateAiConfig({ maxConcurrency: 0 }).ok, false);
  assert.equal(validateAiConfig({ maxConcurrency: 33 }).ok, false);
  assert.equal(validateAiConfig({ dailyRequests: 1_000_001 }).ok, false);
  assert.equal(validateAiConfig({ usageLog: "yes" }).ok, false);
  assert.equal(validateAiConfig({ maxConcurrency: 32, dailyRequests: 1_000_000, usageLog: true }).ok, true);

  // enable：provider 面装配 + wire 统一 404 纪律（未知子路径不解析 key）
  await ai.onEnable({ home, dataDir: path.join(home, "plugins", "ai"), config: {} });
  const unknown = await ai.wireHandler(typedRequest({ method: "POST", path: "/wpk1/ai/v1/bogus" }), "peer");
  assert.equal(unknown.status, 404);
  assert.deepEqual(JSON.parse(Buffer.from(unknown.bodyChunks[0]).toString("utf8")), { error: "not_found" });

  // dispose：平面拆除（在途上游 abort 面）+ 幂等
  await ai.onDispose();
  await ai.onDispose();
  const cold2 = await ai.wireHandler(typedRequest({ method: "POST", path: "/wpk1/ai/v1/auth" }), "peer");
  assert.equal(cold2.status, 503);
});

// ---- ③ 管理面：守卫矩阵 + 提供方全流程（HTTP 链路） -----------------------------------

test("mgmt face: baseline read guard + write-origin four classes + provider flow with masked disclosures", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  t.after(() => sc.close());

  // GET /sidecar/plugins/ai/overview：基线读守卫四态
  const host = { host: `127.0.0.1:${sc.port}` };
  const got = await request(sc.port, { path: "/sidecar/plugins/ai/overview", headers: host });
  assert.equal(got.status, 200, got.text);
  const overview0 = JSON.parse(got.text);
  assert.deepEqual(overview0.services, []);
  assert.deepEqual(overview0.keys, []);
  assert.equal(overview0.plane, null, "未启用——提供方平面未装配");
  assert.equal((await request(sc.port, { path: "/sidecar/plugins/ai/overview", headers: { ...host, origin: "http://evil.example" } })).status, 400);
  assert.equal((await request(sc.port, { path: "/sidecar/plugins/ai/overview", headers: { host: "evil.example" } })).status, 400);

  // 写路由精确 Origin 四类（以 POST secrets 为探针）
  const secretBody = JSON.stringify({ name: "openai-main", value: "Bearer sk-test-value-0123456789" });
  const s1 = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ai/secrets", headers: { ...jsonHeaders, ...sameOrigin(sc) }, body: secretBody });
  assert.equal(s1.status, 200, s1.text);
  assert.ok(!s1.text.includes("sk-test-value"), "secret 值不回显");
  const s2 = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ai/secrets", headers: { ...jsonHeaders, host: `127.0.0.1:${sc.port}` }, body: secretBody });
  assert.equal(s2.status, 403, "缺失 Origin 403");
  const s3 = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ai/secrets", headers: { ...jsonHeaders, ...host, origin: "http://evil.example" }, body: secretBody });
  assert.equal(s3.status, 403, "伪造 Origin 403");
  const s4 = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ai/secrets", headers: { ...jsonHeaders, host: "evil.example", origin: sc.origin }, body: secretBody });
  assert.equal(s4.status, 403, "坏 Host 403");

  // 预设服务：先不绑 secret → 启用被激活门拒（keyEnv 未绑定不可启用）
  const bare = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/ai/services",
    headers: { ...jsonHeaders, ...sameOrigin(sc) },
    body: JSON.stringify({ preset: "openai" }),
  });
  assert.equal(bare.status, 400, bare.text);
  assert.match(bare.text, /bind its credential via the \{secret/);

  // 绑定 secret 创建 → 200
  const created = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/ai/services",
    headers: { ...jsonHeaders, ...sameOrigin(sc) },
    body: JSON.stringify({ preset: "openai", auth: { secret: "openai-main" } }),
  });
  assert.equal(created.status, 200, created.text);
  const service = JSON.parse(created.text).service;
  assert.equal(service.name, "openai");
  assert.equal(service.enabled, true);
  assert.equal(service.authBound, true);
  // 脱敏：auth 槽整值掩码 ●（密钥名不出网）
  assert.equal(service.detail.auth.secret, "\u25cf");

  // 分组 + 密钥签发（原文仅本响应体）
  const group = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/ai/groups",
    headers: { ...jsonHeaders, ...sameOrigin(sc) },
    body: JSON.stringify({ name: "family", serviceNames: ["openai"] }),
  });
  assert.equal(group.status, 200, group.text);
  const keyResp = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/ai/keys",
    headers: { ...jsonHeaders, ...sameOrigin(sc) },
    body: JSON.stringify({ group: "family", name: "laptop" }),
  });
  assert.equal(keyResp.status, 200, keyResp.text);
  const issued = JSON.parse(keyResp.text);
  assert.match(issued.key, /^sk-aifly-/);
  assert.ok(issued.keyId.length >= 8);

  // overview 投影：密钥零原文（keyId/状态）；服务 detail 掩码
  const overview1 = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/ai/overview", headers: host })).text);
  assert.equal(overview1.keys.length, 1);
  assert.equal(overview1.keys[0].status, "active");
  assert.ok(!JSON.stringify(overview1).includes("sk-aifly-"), "列表投影零密钥原文");
  assert.equal(overview1.secrets[0].name, "openai-main");

  // 链接生成（recipient=受邀方；identity 经注入面）→ 内嵌原文一次性返回
  const linkResp = await request(sc.port, {
    method: "POST",
    path: "/sidecar/plugins/ai/link",
    headers: { ...jsonHeaders, ...sameOrigin(sc) },
    body: JSON.stringify({ group: "family", recipient: PEER, keyId: issued.keyId }),
  });
  assert.equal(linkResp.status, 200, linkResp.text);
  const link = JSON.parse(linkResp.text);
  assert.ok(link.link.startsWith("aifly1."));
  const linkPayload = JSON.parse(Buffer.from(link.link.slice("aifly1.".length), "base64url").toString("utf8"));
  assert.equal(linkPayload.key, issued.key, "链接复用已存 key（原文内嵌）");
  assert.equal(linkPayload.provider.endpointId, LEASE.root, "身份元组经注入面");
  assert.equal(linkPayload.services.length, 1);

  // 撤钥三态呈现：DELETE → status revoked；幂等视图经 overview
  const revoked = await request(sc.port, { method: "DELETE", path: `/sidecar/plugins/ai/keys/${issued.keyId}`, headers: sameOrigin(sc) });
  assert.equal(revoked.status, 200, revoked.text);
  const overview2 = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/ai/overview", headers: host })).text);
  assert.equal(overview2.keys[0].status, "revoked");
  assert.ok(overview2.keys[0].revokedAt > 0);

  // 未知子路由 → 404
  assert.equal((await request(sc.port, { path: "/sidecar/plugins/ai/bogus", headers: host })).status, 404);
});

// ---- ④ 生命周期：enable 恢复本地端点；dispose 端点全关 + wire 摘牌 ---------------------

test("lifecycle: enable restores consumer endpoints; disable closes them all and unmounts the wire", async (t) => {
  const home = await tempHome(true);
  t.after(() => rm(home, { recursive: true, force: true }));
  const port = await freePort();

  // 预置钥环 + 端点账本（member 消费姿态——B 机已有导入）
  const aiDir = path.join(home, "plugins", "ai");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(aiDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(aiDir, "keyring.json"),
    JSON.stringify(
      {
        v: 1,
        providers: [
          {
            endpointId: PEER,
            alias: "mini-provider",
            relayUrls: [],
            keys: [{ keyId: "k1111111", key: "sk-aifly-preset-consumer-key-material-000", group: "family" }],
            services: [{ serviceId: "svc-echo", name: "openai", defaultPort: 4300, detail: { routes: [{ forms: [], localPrefix: "/v1", upstreamPrefix: "/v1" }] } }],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(aiDir, "consumer-endpoints.json"),
    JSON.stringify({ version: 1, endpoints: [{ id: "ep1", providerEndpointId: PEER, serviceId: "svc-echo", name: "openai", port, createdAt: 1 }] }, null, 2),
    "utf8",
  );

  const fake = makeFakeSdk();
  const sc = await createSidecar({ homeDir: home, sdk: fake.sdk });
  t.after(() => sc.close());
  const host = { host: `127.0.0.1:${sc.port}` };

  // enable：端点恢复（账本驱动）
  const enable = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ai/enable", headers: { ...jsonHeaders, ...sameOrigin(sc) } });
  assert.equal(enable.status, 200, enable.text);
  assert.equal(JSON.parse(enable.text).plugin.status, "enabled");
  assert.equal(await portAccepts(port), true, "本地端点已监听");
  const consumer = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/ai/consumer", headers: host })).text);
  assert.equal(consumer.endpoints.length, 1);
  assert.equal(consumer.endpoints[0].listener, "listening");
  assert.ok(!JSON.stringify(consumer).includes("sk-aifly-preset"), "钥环投影零原文");
  const overview = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/ai/overview", headers: host })).text);
  assert.notEqual(overview.plane, null, "提供方平面运行中");

  // wire 面：wpk 路由表内 ai 生效（未知子路径统一 404；auth 端点 405→404 族）
  fake.emit({ type: "peer-connected", endpointId: hexToZ32(PEER) });
  const handler = fake.serveHandlers.get(hexToZ32(PEER));
  assert.ok(handler !== undefined, "serveHttp 已绑定（peer-connected）");
  const wireResp = await handler(typedRequest({ method: "POST", path: "/wpk1/ai/v1/bogus" }));
  assert.equal(wireResp.status, 404);

  // disable：摘牌→drain→dispose→落盘；端点全关（端口拒连）+ wire 503
  const disable = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ai/disable", headers: { ...jsonHeaders, ...sameOrigin(sc) } });
  assert.equal(disable.status, 200, disable.text);
  assert.equal(JSON.parse(disable.text).plugin.status, "disabled");
  assert.equal(await portAccepts(port), false, "本地端点已全关（端口拒连）");
  const consumer2 = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/ai/consumer", headers: host })).text);
  assert.equal(consumer2.endpoints[0].listener, "stopped");
  const gated = await handler(typedRequest({ method: "POST", path: "/wpk1/ai/v1/bogus" }));
  assert.equal(gated.status, 503, "内核 gate 摘牌（plugin-disabled）");
  const overview2 = JSON.parse((await request(sc.port, { path: "/sidecar/plugins/ai/overview", headers: host })).text);
  assert.equal(overview2.plane, null, "提供方平面已 dispose");

  // 账本保留（重启再 enable 可恢复）+ 运行账本落盘 disabled
  const ledger = JSON.parse(await readFile(path.join(aiDir, "consumer-endpoints.json"), "utf8"));
  assert.equal(ledger.endpoints.length, 1);
  const state = JSON.parse(await readFile(path.join(home, "plugins", "state.json"), "utf8"));
  assert.equal(state.plugins.ai.status, "disabled");

  // 再 enable：恢复监听（enable 幂等恢复路径）
  const reenable = await request(sc.port, { method: "POST", path: "/sidecar/plugins/ai/enable", headers: { ...jsonHeaders, ...sameOrigin(sc) } });
  assert.equal(reenable.status, 200, reenable.text);
  assert.equal(await portAccepts(port), true, "端点按账本恢复");
});
