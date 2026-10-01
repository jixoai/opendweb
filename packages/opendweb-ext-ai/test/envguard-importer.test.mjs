// env 四面防线 + 两阶段导入器单测（requirements「$env 拒绝与两阶段导入」
// Scenario + design §4 两时点）：ambient 启动/运行中两时点、staging 机器可读
// blocked 清单、零部分激活、commit 映射一次性生效、禁止 env 快照。

import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tempHome, aiDataDir } from "./helpers.mjs";
import { ProviderStore } from "../src/provider/store.mjs";
import { SecretsStore } from "../src/provider/secrets.mjs";
import { ambientEnvViolations, assertStartupEnvSafety, assertRuntimeChange } from "../src/provider/envguard.mjs";
import { stageAiflyConfig, commitAiflyImport, envRefName } from "../src/provider/importer.mjs";

const AIFLY_CONFIG = JSON.stringify({
  version: 2,
  revision: 7,
  services: [
    {
      serviceId: "aaa",
      name: "openai-main",
      match: [{ type: "suffix", value: ".openai.com" }],
      upstream: "https://api.openai.com",
      defaultPort: 4300,
      enabled: true,
      auth: { literal: "$env:OPENAI_API_KEY" },
      routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    },
    {
      serviceId: "bbb",
      name: "aux-headers",
      match: [{ type: "suffix", value: ".aux.dev" }],
      upstream: "https://api.aux.dev",
      defaultPort: 4399,
      enabled: true,
      headers: { set: { "x-api-key": "$env:AUX_KEY", "x-plain": "literal" } },
    },
    {
      serviceId: "ccc",
      name: "codex-chatgpt",
      match: [{ type: "suffix", value: ".chatgpt.com" }],
      upstream: "https://chatgpt.com",
      defaultPort: 4306,
      enabled: true,
      hooks: { script: "codex" },
    },
    {
      serviceId: "ddd",
      name: "plain-local",
      match: [{ type: "suffix", value: ".local" }],
      upstream: "http://127.0.0.1:11434",
      defaultPort: 4317,
      enabled: true,
    },
  ],
});

test("importer: staging——机器可读 blocked 清单（$env 引用逐字段+codex 后续 change）；安全条目 ready 且零激活", () => {
  const staging = stageAiflyConfig(AIFLY_CONFIG);
  assert.deepEqual(staging.blocked, [
    { service: "openai-main", field: "auth.literal", ref: "$env:OPENAI_API_KEY" },
    { service: "aux-headers", field: "headers.set.x-api-key", ref: "$env:AUX_KEY" },
    { service: "codex-chatgpt", field: "hooks.script", ref: "codex", reason: "requires ai-codex-oauth" },
  ]);
  assert.deepEqual(staging.ready.map((r) => r.name), ["plain-local"]);
  assert.equal(staging.ready[0].input.upstream, "http://127.0.0.1:11434");
  // 非法 JSON 抛错
  assert.throws(() => stageAiflyConfig("{"), /not valid JSON/);
  assert.throws(() => stageAiflyConfig('{"x":1}'), /services/);
});

test("importer: staging——auth:null + headers.set $env 同样进 blocked（扫描与 auth 解耦；零 ready）", () => {
  // codex 终审 P1-6：旧实现把 headers 扫描错误绑定到 auth 非空——显式
  // auth:null 的服务携带 $env 头时被误放行进 ready（两阶段安全投影错误）。
  const staging = stageAiflyConfig(
    JSON.stringify({
      services: [
        {
          serviceId: "hhh",
          name: "no-auth-headers",
          match: [{ type: "suffix", value: ".noauth.dev" }],
          upstream: "https://api.noauth.dev",
          defaultPort: 4400,
          enabled: true,
          auth: null, // 显式无 auth——headers 扫描不得依赖 auth 存在性
          headers: { set: { "x-api-key": "$env:HEADER_ONLY_KEY", "x-plain": "ok" } },
        },
      ],
    }),
  );
  assert.deepEqual(staging.blocked, [{ service: "no-auth-headers", field: "headers.set.x-api-key", ref: "$env:HEADER_ONLY_KEY" }]);
  assert.deepEqual(staging.ready, [], "auth:null + $env 头=完整 blocked、零 ready（零部分激活）");
});

test("importer: commit——映射转换（literal→{secret}、headers→$secret:）+ 一次性生效；未映射拒绝；codex 不可映射", async (t) => {
  const home = await tempHome("odai-import-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const secrets = await SecretsStore.open(aiDataDir(home));
  await secrets.set("openai-key", "Bearer sk-real");
  await secrets.set("aux-key", "aux-val");
  const store = await ProviderStore.open(aiDataDir(home), {
    secretsSource: (name) => name === "openai-key" || name === "aux-key",
  });

  // codex 类 blocked → 任何映射都拒绝（validation 按 blocked 顺序命中）
  const staging = stageAiflyConfig(AIFLY_CONFIG);
  await assert.rejects(
    () =>
      commitAiflyImport(staging, store, {
        mappings: { OPENAI_API_KEY: "openai-key", AUX_KEY: "aux-key" },
        secretExists: () => true,
      }),
    /requires ai-codex-oauth/,
  );
  assert.equal(store.listServices().length, 0);
  // 未映射 → 拒绝（零写入；剔除 codex 条目后按 $env 顺序命中）
  const noCodex = { ...staging, blocked: staging.blocked.filter((b) => b.reason === undefined) };
  await assert.rejects(
    () => commitAiflyImport(noCodex, store, { mappings: { OPENAI_API_KEY: "openai-key" }, secretExists: (n) => n === "openai-key" }),
    /AUX_KEY has no mapping/,
  );
  assert.equal(store.listServices().length, 0);
  // 目标 secret 不存在 → 拒绝
  await assert.rejects(
    () =>
      commitAiflyImport(noCodex, store, {
        mappings: { OPENAI_API_KEY: "ghost", AUX_KEY: "aux-key" },
        secretExists: (n) => n === "aux-key",
      }),
    /not in the secrets store/,
  );

  // 两阶段落地：staging（含 $env 条目）时零激活；commit 后全量生效
  const safeOnly = { blocked: [], ready: [staging.ready[0]] };
  const result = await commitAiflyImport(safeOnly, store, { mappings: {}, secretExists: () => true, groupName: "friends" });
  assert.deepEqual(result, { added: ["plain-local"], group: "friends" });
  const plain = store.getServiceByName("plain-local");
  assert.equal(plain.enabled, true);
  assert.equal(store.getGroup("friends").serviceIds.length, 1);

  // $env→secret 转换路径（constructServiceInput 纯函数面）
  const { convertServiceInput } = await import("../src/provider/importer.mjs");
  const converted = convertServiceInput(
    { name: "openai-main", upstream: "https://api.openai.com", match: [], auth: { literal: "$env:OPENAI_API_KEY", bearer: false }, headers: { set: { "x-api-key": "$env:AUX_KEY" } } },
    { OPENAI_API_KEY: "openai-key", AUX_KEY: "aux-key" },
  );
  assert.deepEqual(converted.auth, { secret: "openai-key", bearer: false });
  assert.deepEqual(converted.headers.set, { "x-api-key": "$secret:aux-key" });
  assert.equal(envRefName("$env:X_KEY"), "X_KEY");
  // 未映射引用 → 转换期拒绝
  assert.throws(() => convertServiceInput({ name: "n", auth: { literal: "$env:NOPE" } }, {}), /unmapped/);
});

test("importer: commit 原子性——中途失败回滚（导入半程不留部分服务）", async (t) => {
  const home = await tempHome("odai-import-tx-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await ProviderStore.open(aiDataDir(home), { secretsSource: () => true });
  const staging = stageAiflyConfig(
    JSON.stringify({
      services: [
        { name: "good", match: [{ type: "exact", value: "x" }], upstream: "https://good.example.com", defaultPort: 5000 },
        { name: "bad", match: [], upstream: "https://bad.example.com", defaultPort: 5001 }, // match 空 → invalid
      ],
    }),
  );
  assert.equal(staging.blocked.length, 0);
  await assert.rejects(
    () => commitAiflyImport(staging, store, { mappings: {}, secretExists: () => true }),
    /at least one match/,
  );
  assert.equal(store.getServiceByName("good"), undefined);
  assert.equal(store.listServices().length, 0);
});

test("envguard: ambient 检测——时点一（启动拒绝，列明变量名+指引）与时点二（运行中变更原子拒绝）", () => {
  const services = [
    { name: "openai", keyEnv: "OPENAI_API_KEY", enabled: true },
    { name: "aux", keyEnv: "AUX_KEY", enabled: false }, // 停用条目不在名单
    { name: "local", enabled: true },
  ];
  // 干净环境：通过
  assert.deepEqual(ambientEnvViolations(services, { get: () => undefined }), []);
  assert.doesNotThrow(() => assertStartupEnvSafety(services, { get: () => undefined }));
  // 命中：启动拒绝
  const env = { get: (n) => (n === "OPENAI_API_KEY" ? "sk-x" : undefined) };
  assert.deepEqual(ambientEnvViolations(services, env), [{ service: "openai", keyEnv: "OPENAI_API_KEY" }]);
  assert.throws(
    () => assertStartupEnvSafety(services, env),
    (e) => e.message.includes("OPENAI_API_KEY") && e.message.includes("secrets store") && e.message.includes("'openai'"),
  );
  // 时点二：变更后集合判定
  const change = assertRuntimeChange([{ name: "aux", keyEnv: "AUX_KEY", enabled: true }], { get: (n) => (n === "AUX_KEY" ? "v" : undefined) });
  assert.equal(change.ok, false);
  assert.deepEqual(change.violations, [{ service: "aux", keyEnv: "AUX_KEY" }]);
  assert.match(change.message, /AUX_KEY/);
  // 停用方向的变更不受阻
  const disabling = assertRuntimeChange([{ name: "aux", keyEnv: "AUX_KEY", enabled: false }], { get: (n) => (n === "AUX_KEY" ? "v" : undefined) });
  assert.deepEqual(disabling, { ok: true });
});
