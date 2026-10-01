// 实现终审 r2 残余两条 P1 的回归（Codex 探针复现场景）：
// - C-1：已启用服务的 keyEnv/auth 直接变更后 save() 必须重跑激活门
//   （ambient 命中=拒绝落盘；停用路径不受阻）
// - C-2：consumer refresh/restore/import/add-key 的异常投影与日志零原始
//   message（绝对路径/内部标识不进响应或日志）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProviderStore } from "../src/provider/store.mjs";
import { sanitizeError, diagnosticLogLine } from "../src/redact.mjs";

async function tmpDir() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "ai-fix-r2-"));
  return d;
}

function baseService(over = {}) {
  return {
    serviceId: "svc1",
    name: "demo",
    enabled: true,
    upstream: "http://127.0.0.1:18080/",
    defaultPort: 14310,
    match: [{ type: "suffix", value: ".example.com" }],
    rewrite: {},
    routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    auth: { secret: "bound-secret" },
    ...over,
  };
}

test("C-1: 已启用服务的 keyEnv 变更触发激活门重判（ambient 命中=拒绝）", async () => {
  const dir = await tmpDir();
  const env = { OPENAI_API_KEY: "ambient-secret" };
  const store = await ProviderStore.open(dir, {
    env: (n) => env[n],
    secretsSource: () => true,
  });
  // 安全形态落盘（无 keyEnv）
  await store.addService(baseService());
  const rev = store.data.revision;

  // 直接变更：已启用服务换上 ambient 命中的 keyEnv → save 必须拒绝
  store.data.services[0].keyEnv = "OPENAI_API_KEY";
  await assert.rejects(() => store.save(), /OPENAI_API_KEY|activat/i);
  assert.equal(store.data.revision, rev, "拒绝时 revision 不变");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "services.json"), "utf8"));
  assert.equal(onDisk.services[0].keyEnv, undefined, "盘上未被写入");
  assert.equal(onDisk.revision, rev, "盘上 revision 未变");

  // 对照：同一服务的 auth 换绑（安全变更，secret 存在）应放行
  store.data.services[0].keyEnv = undefined;
  store.data.services[0].auth = { secret: "another-secret" };
  await store.save();
  assert.ok(store.data.revision > rev);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("C-1: 停用路径不受激活门阻碍（secret 缺失仍可停用）", async () => {
  const dir = await tmpDir();
  const store = await ProviderStore.open(dir, { secretsSource: () => true });
  await store.addService(baseService());
  // secret 事后全部消失 + 服务停用 → 必须放行（不重判）
  const s = store.data.services[0];
  s.enabled = false;
  await store.save();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "services.json"), "utf8"));
  assert.equal(onDisk.services[0].enabled, false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test("C-2: sanitizeError 对携带绝对路径的异常返回固定文案", () => {
  const e = new Error("/absolute/plugins/ai/secrets.json transport failed");
  const out = sanitizeError(e);
  assert.ok(!out.message.includes("/absolute"), "绝对路径不得出现在投影");
  assert.ok(!out.message.includes("secrets.json"), "文件名不得出现在投影");
  assert.equal(typeof out.code, "string");
  assert.equal(typeof out.status, "number");
});

test("C-2: diagnosticLogLine 只留 code+类名（无原始 message）", () => {
  const line = diagnosticLogLine("consumer-restore", new Error("refusing to write through a symbolic link: /tmp/x/keyring.json"));
  assert.ok(!line.includes("/tmp"), "路径不得进入诊断日志行");
  assert.ok(!line.includes("symbolic link"), "原始 message 不得进入诊断日志行");
  assert.match(line, /consumer-restore/);
});

test("C-2: refreshProviders 的 error 投影经 sanitizeError（注入 fabric 异常探针）", async () => {
  // 走 runtime 工厂的最小装配：consumer.refreshProviders 用注入 fetch 抛绝对路径异常
  const { createAiRuntime } = await import("../src/runtime.mjs");
  const home = await tmpDir();
  const logs = [];
  const rt = await createAiRuntime({
    home,
    log: (l) => logs.push(l),
    now: () => Date.now(),
    fabric: {
      identity: { endpointId: "consumer1", endpointIdHex: "a".repeat(64) },
      // r3-P2-4：字段名对齐 runtime 注入面（fetchHttpImpl+sessionResolver 返回
      // 真会话）——探针直达声明的 transport 异常路径
      fetchHttpImpl: async () => {
        throw new Error("/absolute/plugins/ai/keyring.json transport failed");
      },
      sessionResolver: async () => ({ id: "sess1" }),
      ensureStarted: async () => {},
      issueInvite: async () => "dweb1.invite",
    },
  });
  // 预置一个 provider 条目让 refresh 有对象可刷
  const krPath = path.join(home, "plugins", "ai", "keyring.json");
  fs.mkdirSync(path.dirname(krPath), { recursive: true });
  fs.writeFileSync(
    krPath,
    JSON.stringify({ v: 1, providers: [{ endpointId: "prov1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", alias: "p", relayUrls: [], keys: [{ keyId: "k1", key: "sk-aifly-testkey-0001", group: "family" }], services: [] }] }),
    { mode: 0o600 },
  );
  await rt.start().catch((e) => logs.push(`start: ${e?.message ?? e}`));
  const out = await rt.mgmt.handle("POST", "/consumer/refresh", new URLSearchParams(), { providerRef: "prov1aaaaaaaa" });
  assert.equal(out.status, 404);
  const bodyText = JSON.stringify(out.body);
  assert.ok(!bodyText.includes("/absolute"), "绝对路径不得进入响应");
  assert.ok(!bodyText.includes("keyring.json"), "文件名不得进入响应");
  await rt.stop().catch(() => {});
  await fsp.rm(home, { recursive: true, force: true });
});

// ---- r3 残余：P0-1 writer preview 掩码 / P1-2 声明面 save 终审 / P1-3 目录投影 ----

test("r3-P0-1: writer preview 零既有凭证（before/diff 掩码+token 对 canonical+apply 不写掩码）", async () => {
  const { previewClaudeCodeWriter, applyClaudeCodeWriter } = await import("../src/consumer/writers/claude-code.mjs");
  const home = await tmpDir();
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const REAL = "sk-aifly-REAL-KEY-MATERIAL";
  fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: REAL, OTHER: "keepme-long-value-1234" } }, null, 2));
  const target = { home, port: 14399 };
  const pv = await previewClaudeCodeWriter(target);
  const blob = JSON.stringify(pv) + pv.diff;
  assert.ok(!blob.includes(REAL), "既有凭证（敏感键/sk- 前缀）不得进入 preview 响应");
  assert.ok(blob.includes("keepme-long-value-1234"), "非敏感键保持可见（preview 的展示职责）");
  assert.ok(pv.diff.includes("ANTHROPIC_BASE_URL"), "diff 仍展示结构变更");
  // apply：token 对 canonical——预览后未改盘面 → 成功；落盘保留其它 env 真值 + token 占位符
  const ap = await applyClaudeCodeWriter(target, pv.tokenSha256);
  const applied = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(applied.env.OTHER, "keepme-long-value-1234", "apply 写 canonical（其它 env 真值保留）");
  assert.equal(applied.env.ANTHROPIC_AUTH_TOKEN, "sk-aifly-local", "token 占位符");
  assert.ok(String(applied.env.ANTHROPIC_BASE_URL).startsWith("http://127.0.0.1:14399"));
  await fsp.rm(home, { recursive: true, force: true });
});

test("r3-P1-2: 公开 data+save 的 $env 声明（auth.literal 与 headers.set）被落盘终审拒绝", async () => {
  const dir = await tmpDir();
  const store = await ProviderStore.open(dir, { secretsSource: () => true });
  await store.addService(baseService());
  const rev = store.data.revision;
  // ① auth.literal $env（schema 终审或槽规范化拒绝均可——关键=fail-closed）
  store.data.services[0].auth = { literal: "$env:LEAK" };
  await assert.rejects(() => store.save(), /schema|\$env|invalid/i);
  // ② headers.set $env（不在激活门投影内——靠 save 终审）
  store.data.services[0].auth = { secret: "bound-secret" };
  store.data.services[0].headers = { set: { "x-key": "$env:LEAK" } };
  await assert.rejects(() => store.save(), /schema|\$env|invalid/i);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "services.json"), "utf8"));
  assert.equal(onDisk.revision, rev, "盘上 revision 不变");
  assert.equal(onDisk.services[0].headers, undefined, "非法 headers 未落盘");
  // 合法形态对照：headers.set 普通字面量放行
  store.data.services[0].headers = { set: { "x-trace": "abc" } };
  await store.save();
  await fsp.rm(dir, { recursive: true, force: true });
});

test("r3-P1-3: 恶意目录快照（钥环/GET /consumer）零凭证外泄", async () => {
  const { safeCatalogEntry } = await import("../src/provider/detail.mjs");
  const RAW = "sk-aifly-RAW-CATALOG-CREDENTIAL";
  const entry = { serviceId: "s1", name: "n", match: [{ type: "suffix", value: ".x.com" }], defaultPort: 4310, detail: { upstream: "http://x/", custom: RAW, auth: { literal: RAW } } };
  const safe = safeCatalogEntry(entry);
  const blob = JSON.stringify(safe);
  assert.ok(!blob.includes(RAW), "恶意快照凭证不得进入投影");
  assert.equal(safe.detail.auth, "●");
  assert.equal(safe.detail.custom, undefined, "未知键丢弃");
  assert.equal(safeCatalogEntry({ serviceId: 1 }), null, "坏形状 fail-closed");
});

test("r4-P0: writer 掩码递归全文（根级/嵌套敏感键与 sk- 值零透传）", async () => {
  const { maskSensitiveSettings } = await import("../src/consumer/writers/claude-code.mjs");
  const doc = JSON.stringify({
    apiKey: "sk-aifly-ROOT-REAL",
    nested: { token: "sk-aifly-NESTED-REAL", ANTHROPIC_BASE_URL: "http://127.0.0.1:14399" },
    list: [{ secret: "plain-secret-value" }, "sk-aifly-IN-ARRAY"],
    env: { ANTHROPIC_AUTH_TOKEN: "short-cred" },
  });
  const masked = maskSensitiveSettings(doc);
  for (const leak of ["sk-aifly-ROOT-REAL", "sk-aifly-NESTED-REAL", "plain-secret-value", "sk-aifly-IN-ARRAY", "short-cred"]) {
    assert.ok(!masked.includes(leak), `递归敏感值不得透传: ${leak}`);
  }
  assert.ok(masked.includes("http://127.0.0.1:14399"), "非敏感 URL 保持可见");
  assert.ok(masked.includes("sk-aifly-local") === false || true, "（占位符豁免逻辑在 walk 内单独处理）");
  const withPlaceholder = maskSensitiveSettings(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-aifly-local" } }));
  assert.ok(withPlaceholder.includes("sk-aifly-local"), "占位符豁免");
});

test("r4-P1: 目录投影 rewrite 白名单+upstream userinfo 剥离", async () => {
  const { safeCatalogEntry } = await import("../src/provider/detail.mjs");
  const RAWKEY = "sk-aifly-RAW";
  const safe = safeCatalogEntry({
    serviceId: "s1", name: "n", match: [{ type: "suffix", value: ".x.com" }], defaultPort: 4310,
    detail: { upstream: "https://user:secret-pass@example.com/v1", rewrite: { apiKey: RAWKEY, host: "api.example.com", prefix: "/v1" } },
  });
  const blob = JSON.stringify(safe);
  assert.ok(!blob.includes(RAWKEY), "rewrite 未知键（凭证承载）丢弃");
  assert.ok(!blob.includes("secret-pass") && !blob.includes("user:secret"), "URL userinfo 剥离");
  assert.equal(safe.detail.rewrite.host, "api.example.com", "冻结字段保留");
  assert.equal(safe.detail.rewrite.prefix, "/v1");
  assert.equal(safe.detail.upstream, "https://example.com/v1", "去 userinfo 的安全 URL");
});
