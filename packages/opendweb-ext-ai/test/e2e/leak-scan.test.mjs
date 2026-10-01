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
import { readFile, rm, mkdtemp, stat } from "node:fs/promises";
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
  //    response/cancel）零密钥——头内仅 keyId（非密钥）
  for (const call of wireCalls) {
    if (call.path === "/wpk1/ai/v1/auth") continue; // AUTH 载荷=协议面（密钥呈交的唯一通道）
    const flat = [call.path, JSON.stringify(call.headers), ...call.body.map((b) => b.toString("utf8"))].join("\n");
    scanTexts(`wire call ${call.path}`, [flat]);
  }
  // ⑦ keyring.json 权限 0600（本机明文与密钥库同威胁模型——远程面才是零容忍）
  const keyringStat = await stat(keyringFile);
  assert.equal(keyringStat.mode & 0o777, 0o600, "keyring.json 必须 0600");
  const usageStat = await stat(usagePath);
  assert.equal(usageStat.mode & 0o777, 0o600, "usage.jsonl 必须 0600");
});
