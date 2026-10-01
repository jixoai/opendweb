// 预设库单测（ai-fly test/unit/presets/presets.test.ts 矩阵移植 + Phase A
// codex 占位与 keyEnv 语义分歧）：18 项精选（17 可启用 + codex 占位）、
// 占位不可展开、presetToServiceInput 无 $env 兜底、models.dev 长尾派生/
// 缓存 TTL/断网回退/模型清单。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempHome } from "./helpers.mjs";
import {
  loadActivatablePresets,
  loadCuratedPresets,
  presetToServiceInput,
  classifyApiForm,
  derivedPortFor,
  deriveModelsDevPresets,
  deriveModels,
  fetchModelsDevPresets,
  fetchModelsDevRaw,
  modelsDevCachePath,
  MODELS_DEV_API_URL,
} from "../src/presets/models-dev.mjs";

test("presets: 精选 18 项（17 可启用 + codex 占位）；源文件标注 upstream", () => {
  const curated = loadCuratedPresets();
  assert.equal(curated.length, 18);
  const activatable = loadActivatablePresets();
  assert.equal(activatable.length, 17);
  assert.ok(!activatable.some((p) => p.id === "codex"));
  // 源文件含 adapted 标注约定（README 承诺）
  const raw = readFileSync(new URL("../src/presets/providers.json", import.meta.url), "utf8");
  assert.ok(raw.includes('"codex"'));
  assert.ok(raw.includes("ai-codex-oauth"));
});

test("presets: codex 占位形态（requires+disabled）——不可展开（指回后续 change）", () => {
  const codex = loadCuratedPresets().find((p) => p.id === "codex");
  assert.equal(codex.disabled, true);
  assert.equal(codex.requires, "ai-codex-oauth");
  assert.throws(() => presetToServiceInput(codex), /ai-codex-oauth/);
  // 普通预设可展开
  const openai = loadCuratedPresets().find((p) => p.id === "openai");
  const input = presetToServiceInput(openai);
  assert.equal(input.name, "openai");
  assert.equal(input.upstream, "https://api.openai.com");
  assert.deepEqual(input.match, [{ type: "suffix", value: ".api.openai.com" }]);
  assert.equal(input.keyEnv, "OPENAI_API_KEY"); // 保留为提示字段
  assert.equal(input.auth, undefined); // 无 $env 兜底（与上游分歧）——激活门输入
});

test("presets: keyEnv 无 auth 槽 → ServiceInput 留空 auth（激活门将拒启直至绑定）", () => {
  const withKeyEnv = loadActivatablePresets().filter((p) => p.keyEnv !== undefined);
  assert.ok(withKeyEnv.length >= 10); // 17 项中绝大多数带 keyEnv
  for (const preset of withKeyEnv) {
    const input = presetToServiceInput(preset);
    assert.equal(input.auth, undefined, preset.id);
    assert.equal(input.keyEnv, preset.keyEnv);
  }
  // 无 keyEnv 预设（ollama/lmstudio）→ 无 keyEnv 字段
  const ollama = presetToServiceInput(loadCuratedPresets().find((p) => p.id === "ollama"));
  assert.equal(ollama.keyEnv, undefined);
});

test("presets: apiForm 归类与确定性端口", () => {
  assert.deepEqual(classifyApiForm("@ai-sdk/anthropic"), { apiForm: "anthropic-messages", unverified: false });
  assert.deepEqual(classifyApiForm("@ai-sdk/google"), { apiForm: "gemini-native", unverified: false });
  assert.deepEqual(classifyApiForm("@ai-sdk/openai-compatible"), { apiForm: "openai-completions", unverified: false });
  assert.deepEqual(classifyApiForm("weird-pkg"), { apiForm: "openai-completions", unverified: true });
  assert.equal(derivedPortFor("some-id"), derivedPortFor("some-id"));
  assert.ok(derivedPortFor("x") >= 20000 && derivedPortFor("x") <= 64999);
});

const API_JSON = JSON.stringify({
  openai: { id: "openai", npm: "@ai-sdk/openai", api: "https://api.openai.com" }, // 被精选集覆盖 → 跳过
  tailend: { id: "tailend", name: "Tail End", npm: "@tailend/sdk", api: "https://api.tailend.dev/v1", env: ["TAILEND_API_KEY"], models: {} },
  noapi: { id: "noapi", npm: "x", env: ["X_KEY"] }, // 无显式 api → 跳过
  badurl: { id: "badurl", npm: "x", api: "not-a-url" },
});

test("presets: models.dev 长尾派生——精选集 id 胜出、无 api 跳过、unverified 标注", () => {
  const curated = loadActivatablePresets();
  const curatedIds = new Set(curated.map((p) => p.id));
  const tail = deriveModelsDevPresets(API_JSON, curatedIds);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].id, "tailend");
  assert.equal(tail[0].label, "Tail End");
  assert.equal(tail[0].apiForm, "openai-completions");
  assert.equal(tail[0].unverified, true);
  assert.equal(tail[0].keyEnv, "TAILEND_API_KEY");
  assert.deepEqual(tail[0].matchDomains, ["api.tailend.dev"]);
  assert.equal(tail[0].source, "models.dev");
});

test("presets: 缓存 TTL 与断网回退（fetchImpl/now/cachePath 注入——无网络）", async (t) => {
  const home = await tempHome("odai-presets-cache-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const cachePath = modelsDevCachePath(home);
  assert.equal(path.basename(cachePath), "models-dev.json");
  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount += 1;
    assert.equal(url, MODELS_DEV_API_URL);
    return { ok: true, text: async () => API_JSON };
  };
  let clock = 1_000_000;
  const now = () => clock;

  // 首拉：fetch + 落缓存
  const first = await fetchModelsDevPresets(loadActivatablePresets(), { cachePath, fetchImpl, now });
  assert.equal(first.origin, "fetch");
  assert.equal(first.presets.length, 1);
  // TTL 内：直接回缓存
  clock += 1000;
  const second = await fetchModelsDevPresets(loadActivatablePresets(), { cachePath, fetchImpl, now });
  assert.equal(second.origin, "cache");
  assert.equal(fetchCount, 1);
  // TTL 过期 + 网络失败：回退缓存并附错误
  clock += 8 * 86_400_000;
  const failing = async () => {
    throw new Error("ENETDOWN");
  };
  const third = await fetchModelsDevPresets(loadActivatablePresets(), { cachePath, fetchImpl: failing, now });
  assert.equal(third.origin, "cache");
  assert.equal(third.presets.length, 1);
  assert.match(third.error, /ENETDOWN/);
  // 无缓存且网络失败：raw=undefined + error（不抛）
  const none = await fetchModelsDevRaw({ cachePath: path.join(home, "none.json"), fetchImpl: failing, now });
  assert.equal(none.raw, undefined);
  assert.match(none.error, /no cache available/);
});

test("presets: 损坏缓存视同未命中（fetch 补救）", async (t) => {
  const home = await tempHome("odai-presets-corrupt-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const cachePath = modelsDevCachePath(home);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  await writeFile(cachePath, "{ broken", { mode: 0o600 });
  const fetchImpl = async () => ({ ok: true, text: async () => API_JSON });
  const result = await fetchModelsDevPresets(loadActivatablePresets(), { cachePath, fetchImpl });
  assert.equal(result.origin, "fetch");
});

test("presets: 模型清单与价格（chat 优先/价格升序/未知价尾排/non-chat 启发式）", () => {
  const raw = JSON.stringify({
    p: {
      id: "p",
      id: "p",
      npm: "@ai-sdk/openai",
      api: "https://p.dev",
      models: {
        "gpt-x": { name: "GPT X", cost: { input: 1, output: 2 } },
        "cheap": { cost: { input: 0.1, output: 0.1 } },
        "noprice": { name: "No Price" },
        "embed-3": { cost: { input: 0.01, output: 0 } },
      },
    },
  });
  const list = deriveModels(raw, "p");
  assert.deepEqual(
    list.map((m) => m.id),
    ["cheap", "gpt-x", "noprice", "embed-3"],
  );
  assert.equal(list[0].pricePerMTok, 0.2);
  assert.equal(list[0].priced, true);
  assert.equal(list[2].priced, false);
  assert.equal(list[3].chat, false);
  assert.equal(deriveModels(raw, "missing"), undefined);
});
