// 泄露面扫描 e2e（tasks B5；requirements「泄露面扫描（e2e 断言）」Scenario）：
// 全链路（auth/请求/流式/撤钥/配额/错误路径/usage 开启）后扫描：
// - 进程 argv（凭证判定线内——值进入上游请求头/体才算凭证）；
// - 进程 env 值（等值 secret 不在 env；secret 槽值不经 env）；
// - 提供方日志（log 注入收集——含错误路径文案）；
// - usage.jsonl（仅 ts/keyId/serviceId/status/bytes——无正文无凭证）；
// - 网关错误 JSON 本地响应体（OpenAI 风格——不含上游 secret 与密钥原文）；
// - keyring.json 权限 0600。
// 零命中断言（掩码投影与密钥指纹除外——本测试不输出任何密钥原文到 stdout）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { tempHome, aiDataDir, startUpstream, waitFor } from "../helpers.mjs";
import { ProviderStore } from "../../src/provider/store.mjs";
import { SecretsStore } from "../../src/provider/secrets.mjs";
import { UsageLog } from "../../src/provider/limits.mjs";
import { createAiProviderWireHandler } from "../../src/wire/endpoints.mjs";
import { buildServiceEntry } from "../../src/provider/detail.mjs";
import { openKeyring } from "../../src/consumer/keyring.mjs";
import { importLink, SHARE_LINK_PREFIX } from "../../src/consumer/join.mjs";
import { createConsumerSession } from "../../src/consumer/sessions.mjs";
import { createConsumerGateway } from "../../src/consumer/gateway.mjs";
import { createAiManagement } from "../../src/mgmt.mjs";

/** 本地请求（带凭据头——剥离面）。 */
function localRequest(port, opts = {}) {
  const { method = "GET", requestPath = "/", headers = {}, body } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

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

test("leak-scan: 全链路后 argv/env/日志/usage/错误体零凭证；keyring 0600", async (t) => {
  const home = await tempHome("odai-leak-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const consumerRoot = await mkdtemp(path.join(tmpdir(), "odai-leak-cons-"));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));

  // 提供方日志收集（错误文案面）
  const capturedLogs = [];
  const log = (level, msg) => capturedLogs.push(`[${level}] ${msg}`);

  const UPSTREAM_SECRET = "sk-leakscan-upstream-slot-77c31e";
  const up = await startUpstream(async (_rq, rs) => {
    rs.writeHead(200, { "content-type": "text/event-stream" });
    rs.write("data: one\n\n");
    rs.write("data: two\n\n");
    rs.end();
  });
  t.after(() => up.close());
  const secrets = await SecretsStore.open(aiDataDir(home));
  await secrets.set("upstream-key", UPSTREAM_SECRET);
  const usageLog = new UsageLog(aiDataDir(home));
  const store = await ProviderStore.open(aiDataDir(home));
  await store.addService({
    name: "openai",
    upstream: up.origin,
    match: [{ type: "suffix", value: ".openai.com" }],
    defaultPort: 4300,
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    auth: { secret: "upstream-key" },
  });
  const svcEntry = buildServiceEntry(store.getServiceByName("openai"));
  await store.addGroup("alpha", ["openai"], { dailyRequests: 50 });
  const keyA = await store.issueKey("alpha");
  const providerHandler = createAiProviderWireHandler({
    store,
    secrets: (n) => secrets.get(n),
    usageLog,
    log,
    sweepIntervalMs: 50,
  });

  // fake fabric 桥（消费侧注入面）+ 调用记录（wire 面泄露扫描对象）
  const wireCalls = [];
  async function fetchImpl(init) {
    wireCalls.push({ method: init.method, path: init.path, headers: init.headers ?? [], body: (init.body ?? []).map((c) => Buffer.from(c)) });
    const bodyChunks = (init.body ?? []).map((c) => Buffer.from(c));
    let idx = 0;
    const controller = new AbortController();
    const req = {
      requestId: wireCalls.length,
      streamId: wireCalls.length,
      sessionId: "sess-leak",
      signal: controller.signal,
      method: init.method,
      path: init.path,
      headers: init.headers ?? [],
      bodyNext: async () => (idx < bodyChunks.length ? bodyChunks[idx++] : null),
      respondStreaming: () => null,
    };
    const res = await providerHandler(req, "peer-leak");
    return { status: res.status, headers: res.headers ?? [], bodyChunks: res.bodyChunks ?? [] };
  }

  // 消费方装配（keyring 导入→会话→网关）
  const keyringFile = path.join(consumerRoot, "plugins", "ai", "keyring.json");
  const keyring = await openKeyring(keyringFile);
  const link = `${SHARE_LINK_PREFIX}${Buffer.from(
    JSON.stringify({
      v: 1,
      invite: "dweb1.leakscanfaketoken000000000000000000",
      key: keyA.key,
      keyId: keyA.keyId,
      provider: { alias: "leak-provider", endpointId: "leakscanep0001aaaaaaaaaaaa", relayUrls: [] },
      group: "alpha",
      services: [svcEntry],
    }),
  ).toString("base64url")}`;
  await importLink(link, { keyring, fabric: { fetchImpl } });
  await keyring.save();

  const session = createConsumerSession({ fetchImpl, log });
  await session.auth([keyA.key]);
  const gateway = createConsumerGateway({ session });
  const port = await freePort();
  await gateway.startService({
    serviceId: svcEntry.serviceId,
    name: "openai",
    port,
    routes: [{ localPrefix: "/v1", upstreamPrefix: "/v1" }],
    keyId: keyA.keyId,
  });
  t.after(() => gateway.close());

  // ---- 全链路驱动（成功流/凭据头剥离/错误路径） ----
  const ok = await localRequest(port, {
    method: "POST",
    requestPath: "/v1/chat/completions",
    headers: { authorization: "Bearer sk-local-client-cred-leak", cookie: "sid=leak", "content-type": "application/json" },
    body: JSON.stringify({ model: "m" }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString(), "data: one\n\ndata: two\n\n");
  // 错误路径（撤钥后的本地响应=OpenAI JSON；白名单外 404）
  const notOffered = await localRequest(port, { method: "GET", requestPath: "/balance" });
  assert.equal(notOffered.status, 404);
  await store.revokeKey(keyA.keyId);
  const revoked = await localRequest(port, { method: "POST", requestPath: "/v1/chat/completions", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(revoked.status, 403);
  await new Promise((r) => setTimeout(r, 250)); // usage 追加落盘
  await gateway.close();

  // ---- 扫描面 ----
  const secretsToScan = [keyA.key, UPSTREAM_SECRET, "sk-local-client-cred-leak"];
  const scanTexts = (label, texts) => {
    for (const text of texts) {
      for (const secret of secretsToScan) {
        assert.ok(!text.includes(secret), `${label} 泄露密钥原文（指纹 ${secret.slice(0, 8)}…）`);
      }
    }
  };
  // ① 进程 argv
  scanTexts("process.argv", [process.argv.join(" ")]);
  // ② 进程 env 值（凭证判定线内——等值 secret 不得出现在 env 值中）
  scanTexts("process.env values", [Object.values(process.env).join("\n")]);
  // ③ 提供方日志（含错误路径文案）
  scanTexts("provider logs", capturedLogs);
  // ④ usage.jsonl（仅元数据；键集断言）
  const usagePath = usageLog.pathOf();
  const usageRaw = await readFile(usagePath, "utf8");
  scanTexts("usage.jsonl", [usageRaw]);
  for (const line of usageRaw.split("\n").filter((l) => l.trim() !== "")) {
    const rec = JSON.parse(line);
    assert.deepEqual(Object.keys(rec).sort(), ["bytes", "keyId", "serviceId", "status", "ts"], "usage 仅元数据字段");
  }
  // ⑤ 网关错误响应体（OpenAI 风格——零凭证）
  scanTexts("gateway error bodies", [notOffered.body.toString(), revoked.body.toString()]);
  // ⑥ wire 调用记录：auth 调用的 body 是唯一合法密钥载体；其余调用（request/
  //    response/cancel）零密钥——头内仅 keyId（非密钥）。P2-4：除密钥原文外，
  //    增加名称+路径结构化断言——secret 名/存储文件名/本地绝对路径不得出现在
  //    任何非 AUTH wire 面（AUTH body 保留为协议规定的唯一凭证呈交通道）。
  for (const call of wireCalls) {
    if (call.path.split("?")[0] === "/wpk1/ai/v1/auth") continue; // AUTH 载荷=协议面（密钥呈交的唯一通道）
    const flat = [call.path, JSON.stringify(call.headers), ...call.body.map((b) => b.toString("utf8"))].join("\n");
    scanTexts(`wire call ${call.path}`, [flat]);
    scanInternalIdentifiers(`wire call ${call.path}`, [flat]);
  }
  // ⑦ keyring.json 权限 0600（本机明文与密钥库同威胁模型——远程面才是零容忍）；
  //    内容扫描（P2-4）：原文=keyring 的合法内容，但 secret 名/本地路径不得混入
  const keyringStat = await stat(keyringFile);
  assert.equal(keyringStat.mode & 0o777, 0o600, "keyring.json 必须 0600");
  const keyringRaw = await readFile(keyringFile, "utf8");
  scanInternalIdentifiers("keyring.json", [keyringRaw]);
  const usageStat = await stat(usagePath);
  assert.equal(usageStat.mode & 0o777, 0o600, "usage.jsonl 必须 0600");
  // ⑧ 提供方日志的名称/路径纪律（P1-8/P2-4：日志零 secret 名/存储文件名/绝对路径）
  scanInternalIdentifiers("provider logs", capturedLogs);

  /** 名称/路径结构化断言（P2-4）：secret 名、存储文件名、本地绝对路径零命中。 */
  function scanInternalIdentifiers(label, texts) {
    const forbidden = [/upstream-key/, /services\.json/, /secrets\.json/, /keyring\.json/, new RegExp(home.replaceAll("/", "\\/"))];
    for (const text of texts) {
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(text), `${label} 泄露内部标识（${pattern}）`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// P1-8：管理面错误投影单一脱敏层——固定 code+固定脱敏文案；secret 名/脚本路径/
// 绝对路径不进响应与日志（keyEnv 变量名按规范可保留）。腐坏文件/激活门拒绝/
// secret 操作三面 + 浏览器可达 UI 投影（overview）扫描。
// ---------------------------------------------------------------------------
test("leak-scan: 管理面错误投影固定脱敏——腐坏/激活门/secret 操作零名称零路径（响应+日志）", async (t) => {
  const home = await tempHome("odai-leak-mgmt-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = aiDataDir(home);
  const capturedLogs = [];
  const SECRET_NAME = "zzleakprobe-secret";
  const KEY_ENV = "ZZ_LEAKPROBE_ENV";

  const consumerStub = {
    keyring: async () => {
      throw new Error("not reached in this test");
    },
    refreshProviders: async () => ({ results: [] }),
    loadEndpoints: async () => [],
    startConsumerEndpoint: async () => {
      throw new Error("not reached");
    },
    stopConsumerEndpoint: async () => ({ removed: {} }),
    previewWriter: async () => {
      throw new Error("not reached");
    },
    applyWriter: async () => {
      throw new Error("not reached");
    },
  };

  /**
   * 装配 mgmt + 同实例 store/secrets（共享内存态——避免实例分叉）。
   * @param {{ env?: (name: string) => string | undefined }} [over]
   */
  const mk = async (over = {}) => {
    const secretsStore = await SecretsStore.open(dir);
    const store = await ProviderStore.open(dir, over.env !== undefined ? { env: over.env } : undefined);
    const mgmt = createAiManagement({
      dataDir: dir,
      now: () => Date.now(),
      log: (line) => capturedLogs.push(line),
      store: async () => store,
      secrets: () => secretsStore,
      getPlane: () => null,
      getConfig: () => ({ maxConcurrency: 4, usageLog: false }),
      refreshLimitDefaults: async () => {},
      consumer: consumerStub,
      fabric: {},
    });
    return { mgmt, store, secretsStore };
  };

  /** 泄露扫描：secret 名/存储文件名/本地绝对路径零命中（响应体+日志）。 */
  const scanProjection = (label, bodyText) => {
    const forbidden = [
      new RegExp(SECRET_NAME),
      /services\.json/,
      /secrets\.json/,
      /keyring\.json/,
      new RegExp(home.replaceAll(".", "\\.").replaceAll("/", "\\/")),
    ];
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(bodyText), `${label} 响应泄露（${pattern}）: ${bodyText.slice(0, 200)}`);
      for (const line of capturedLogs) {
        assert.ok(!pattern.test(line), `${label} 日志泄露（${pattern}）: ${line}`);
      }
    }
  };

  // ① 腐坏 services.json：路由期 store 打开抛错 → 固定 500 文案（路径零出现）
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "services.json"), "{corrupt", "utf8");
  const lazyMgmt = createAiManagement({
    dataDir: dir,
    now: () => Date.now(),
    log: (line) => capturedLogs.push(line),
    store: async () => ProviderStore.open(dir), // 路由期打开——腐坏即抛
    secrets: async () => SecretsStore.open(dir),
    getPlane: () => null,
    getConfig: () => ({ maxConcurrency: 4, usageLog: false }),
    refreshLimitDefaults: async () => {},
    consumer: consumerStub,
    fabric: {},
  });
  const corruptView = await lazyMgmt.handle("GET", "/overview", new URLSearchParams(), undefined);
  assert.equal(corruptView.status, 500);
  assert.deepEqual(corruptView.body.error, {
    code: "corrupt",
    message: "the local data store is unreadable (corrupt or incompatible); fix or remove the file manually",
  });
  scanProjection("corrupt overview", JSON.stringify(corruptView.body));

  // ② 激活门三态（干净目录重建）
  await rm(dir, { recursive: true, force: true });
  const first = await mk();
  const svc = await first.store.addService({
    name: "probe-svc",
    upstream: "https://api.probe.dev",
    match: [{ type: "suffix", value: ".probe.dev" }],
    defaultPort: 4400,
    keyEnv: KEY_ENV,
    enabled: false, // 停用加入（激活门跳过 disabled）
  });
  // ②a 未绑定 secret → 400 固定文案（webui 断言短语冻结保留）
  const unbound = await first.mgmt.handle("PATCH", `/services/${svc.serviceId}`, new URLSearchParams(), { enabled: true });
  assert.equal(unbound.status, 400);
  assert.equal(unbound.body.error.code, "invalid");
  assert.match(unbound.body.error.message, /bind its credential via the \{secret/);
  scanProjection("gate unbound", JSON.stringify(unbound.body));
  // ②b 绑定不在库 secret → 400 固定文案（secret 名零出现）
  await first.store.setServiceAuth(svc.serviceId, { secret: SECRET_NAME }); // 库中无此 secret
  const missing = await first.mgmt.handle("PATCH", `/services/${svc.serviceId}`, new URLSearchParams(), { enabled: true });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.message, "the bound secret is not in the secrets store; add it first");
  scanProjection("gate missing-secret", JSON.stringify(missing.body));
  // ②c ambient env 命中 → 409（keyEnv 变量名按规范可保留；secret 名零出现）
  await first.secretsStore.set(SECRET_NAME, "sk-in-store-value"); // 入库（此后 secret 在库）
  const ambient = await mk({ env: (n) => (n === KEY_ENV ? "sk-ambient" : undefined) });
  const ambientView = await ambient.mgmt.handle("PATCH", `/services/${svc.serviceId}`, new URLSearchParams(), { enabled: true });
  assert.equal(ambientView.status, 409);
  assert.equal(ambientView.body.error.code, "conflict");
  assert.ok(ambientView.body.error.message.includes(KEY_ENV), "keyEnv 变量名按规范保留");
  scanProjection("gate ambient-env", JSON.stringify(ambientView.body));
  // 对照：干净 env + secret 在库 → 启用放行
  const clean = await mk();
  const okEnable = await clean.mgmt.handle("PATCH", `/services/${svc.serviceId}`, new URLSearchParams(), { enabled: true });
  assert.equal(okEnable.status, 200, JSON.stringify(okEnable.body));
  assert.equal(okEnable.body.service.enabled, true);

  // ③ secret 操作错误投影
  // ③a 删除不存在的 secret → 404 固定文案（名称零回显）
  const ghost = await clean.mgmt.handle("DELETE", "/secrets/zzleakprobe-ghost", new URLSearchParams(), undefined);
  assert.equal(ghost.status, 404);
  assert.deepEqual(ghost.body.error, { code: "not-found", message: "not found" });
  scanProjection("secret remove ghost", JSON.stringify(ghost.body));
  // ③b 非法名 set → 400 固定文案（名称零回显）
  const badName = await clean.mgmt.handle("POST", "/secrets", new URLSearchParams(), { name: "Bad Name!", value: "x" });
  assert.equal(badName.status, 400);
  assert.deepEqual(badName.body.error, { code: "invalid", message: "invalid input" });
  scanProjection("secret set invalid", JSON.stringify(badName.body));
  // ③c 腐坏 secrets.json → 500 固定文案（路径零出现）
  await writeFile(path.join(dir, "secrets.json"), "{corrupt", "utf8");
  const corruptSecret = await clean.mgmt.handle("DELETE", "/secrets/zzleakprobe-x", new URLSearchParams(), undefined);
  assert.equal(corruptSecret.status, 500);
  assert.equal(corruptSecret.body.error.code, "corrupt");
  scanProjection("secrets corrupt", JSON.stringify(corruptSecret.body));

  // ④ 浏览器可达 UI 投影（overview 200 面）：服务视图/密钥清单零 secret 名/路径
  await rm(dir, { recursive: true, force: true });
  const ui = await mk();
  await ui.secretsStore.set(SECRET_NAME, "sk-ui-probe-value");
  await ui.store.addService({
    name: "ui-svc",
    upstream: "https://api.ui.dev",
    match: [{ type: "suffix", value: ".ui.dev" }],
    defaultPort: 4401,
    keyEnv: KEY_ENV,
    auth: { secret: SECRET_NAME },
  });
  const overview = await ui.mgmt.handle("GET", "/overview", new URLSearchParams(), undefined);
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  const overviewText = JSON.stringify(overview.body);
  assert.ok(!overviewText.includes("sk-ui-probe-value"), "secret 值零回显");
  // secret 名在清单/绑定面是合法管理数据（本机 UI 绑定 UX）；错误投影之外的
  // 扫描聚焦：值零回显 + 路径/存储文件名零出现。
  const forbiddenUi = [/services\.json/, /secrets\.json/, /keyring\.json/, new RegExp(home.replaceAll(".", "\\.").replaceAll("/", "\\/"))];
  for (const pattern of forbiddenUi) {
    assert.ok(!pattern.test(overviewText), `overview UI 泄露路径（${pattern}）`);
  }
  // 服务详情 auth 槽=掩码（detail 投影脱敏面——review D 已核对的保持性断言）
  assert.equal(overview.body.services[0].detail.auth.secret, "\u25cf", "auth 槽掩码 ●");
});
