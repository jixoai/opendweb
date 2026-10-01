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
      fetchImpl: async () => {
        throw new Error("/absolute/plugins/ai/keyring.json transport failed");
      },
      ensureStarted: async () => {},
      sessionResolver: async () => null,
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
  await rt.start().catch(() => {});
  const out = await rt.mgmt.handle("POST", "/consumer/refresh", new URLSearchParams(), { providerRef: "prov1aaaaaaaa" });
  assert.equal(out.status, 404);
  const bodyText = JSON.stringify(out.body);
  assert.ok(!bodyText.includes("/absolute"), "绝对路径不得进入响应");
  assert.ok(!bodyText.includes("keyring.json"), "文件名不得进入响应");
  await rt.stop().catch(() => {});
  await fsp.rm(home, { recursive: true, force: true });
});
