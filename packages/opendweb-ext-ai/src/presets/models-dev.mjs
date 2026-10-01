// adapted from ai-fly presets/models-dev.ts + src/shared/rpc-contract.ts
// (PRESET_SCHEMA) (v0.6.0)
// 预设库：精选集（仓库内 providers.json，带出处；17 项 + codex 占位）+
// models.dev 长尾扩展（运行时拉取 api.json → apiForm 归类 → 数据目录缓存
// TTL 7 天 → 断网回退缓存与精选集 → 可禁用）。
// 与上游的有意分歧（design §5）：
// - **codex 条目 v1 不随包激活**：占位形态 {id, label, requires:"ai-codex-
//   oauth", disabled:true}——加载器校验放行（UI 可呈现「需要后续 change」）
//   但 presetToServiceInput 拒绝展开（disabled 预设不可启用）；
// - **presetToServiceInput 无 $env 兜底**：上游 keyEnv 无 auth 槽时兜底生成
//   auth.literal `$env:<VAR>`——本包改为：保留 keyEnv 为服务字段（UI 提示 +
//   激活门输入），auth 槽留空（未绑定 secret 不可启用——§4 ③预设面）。
// 副作用注入点照搬：cachePath/fetchImpl/now 均可注入（单测无网络、无 HOME）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AUTH_SECRET_SLOT_SCHEMA, AUTH_SCRIPT_SLOT_SCHEMA, HOOKS_SLOT_SCHEMA } from "../provider/lifecycle.mjs";
import curatedJson from "./providers.json" with { type: "json" };

/** models.dev api.json 地址（spec 点名）。 */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/** 缓存 TTL（7 天）。 */
export const MODELS_DEV_CACHE_TTL_MS = 7 * 86_400_000;

/** codex 占位的承接 change 名。 */
export const CODEX_FOLLOWUP_CHANGE = "ai-codex-oauth";

// ---------------------------------------------------------------------------
// 契约形状（ai-fly rpc-contract PRESET_SCHEMA 的本包单源投影）
// ---------------------------------------------------------------------------

export const API_FORM_SCHEMA = z.enum(["openai-completions", "anthropic-messages", "gemini-native"]);

export const PRESET_ROUTE_SCHEMA = z.strictObject({
  forms: z.array(z.enum(["openai-chat", "openai-responses", "anthropic"])).max(3),
  mode: z.enum(["prefix", "pattern"]).optional(),
  localPrefix: z.string().min(1).max(2048).optional(),
  upstreamPrefix: z.string().max(2048).optional(),
  matchPattern: z.string().min(1).max(2048).optional(),
  template: z.string().min(1).max(2048).optional(),
});

/** 精选预设条目（codex 占位另形——见 CURATED_FILE_SCHEMA 的 union 第二支）。 */
export const PRESET_SCHEMA = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  apiForm: API_FORM_SCHEMA,
  baseUrl: z.string().min(1).max(2048),
  iconId: z.string().min(1).max(128).optional(),
  /** 惯用环境变量名（**UI 提示语义**——本包不用它构造凭证；激活门用它判定）。 */
  keyEnv: z.string().min(1).max(256).optional(),
  /** auth 槽预填（{secret, bearer?} | {script, args?, bearer?}）。 */
  auth: z.union([AUTH_SECRET_SLOT_SCHEMA, AUTH_SCRIPT_SLOT_SCHEMA]).optional(),
  hooks: HOOKS_SLOT_SCHEMA.optional(),
  defaultPort: z.number().int().min(1024).max(65535),
  matchDomains: z.array(z.string().min(1).max(256)).min(1).max(16),
  routes: z.array(PRESET_ROUTE_SCHEMA).max(3).optional(),
  notes: z.string().max(2048).optional(),
  source: z.string().min(1).max(512),
  unverified: z.boolean().optional(),
});

/** codex 占位形态（design §5：requires+disabled；不随包激活）。 */
export const PRESET_PLACEHOLDER_SCHEMA = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  requires: z.string().min(1).max(128),
  disabled: z.literal(true),
  baseUrl: z.string().min(1).max(2048).optional(),
  defaultPort: z.number().int().min(1024).max(65535).optional(),
  matchDomains: z.array(z.string().min(1).max(256)).max(16).optional(),
  notes: z.string().max(2048).optional(),
});

const CURATED_FILE_SCHEMA = z.strictObject({
  version: z.literal(1),
  providers: z.array(z.union([PRESET_SCHEMA, PRESET_PLACEHOLDER_SCHEMA])).min(1),
});

/**
 * 缓存路径（默认 <DWEB_HOME>/plugins/ai/cache/models-dev.json——home 参数化；
 * 测试注入）。
 * @param {string} [home]
 */
export function modelsDevCachePath(home = homedir()) {
  return join(home, "plugins", "ai", "cache", "models-dev.json");
}

// ---------------------------------------------------------------------------
// 精选集
// ---------------------------------------------------------------------------

/**
 * 精选预设（模块加载即校验；数据损坏应 fail-fast 而非静默降级——上游同拍）。
 * @returns {Array<Record<string, any>>}
 */
export function loadCuratedPresets() {
  const parsed = CURATED_FILE_SCHEMA.parse(curatedJson);
  return parsed.providers;
}

/** 可启用预设（排除 codex 占位——design §5：17 项）。 */
export function loadActivatablePresets() {
  return loadCuratedPresets().filter((p) => p.disabled !== true);
}

/**
 * 预设 → ServiceInput 投影（**无 $env 兜底**——与上游分歧；keyEnv 保留为
 * 服务字段，激活门要求 {secret} 绑定后才可启用）。disabled 预设拒绝展开。
 * @param {Record<string, any>} preset
 * @param {{ name?: string }} [opts]
 */
export function presetToServiceInput(preset, opts = {}) {
  if (preset.disabled === true) {
    throw new Error(
      `preset '${preset.id}' is a placeholder that requires the follow-up change ${preset.requires ?? CODEX_FOLLOWUP_CHANGE}; it cannot be enabled in v1`,
    );
  }
  const input = {
    name: opts.name ?? preset.id,
    upstream: preset.baseUrl,
    match: (preset.matchDomains ?? []).map((domain) => ({ type: "suffix", value: `.${domain}` })),
    defaultPort: preset.defaultPort,
    ...(preset.auth !== undefined ? { auth: preset.auth } : {}),
    ...(preset.routes !== undefined ? { routes: preset.routes } : {}),
    ...(preset.hooks !== undefined ? { hooks: preset.hooks } : {}),
  };
  if (preset.keyEnv !== undefined) input.keyEnv = preset.keyEnv;
  return input;
}

// ---------------------------------------------------------------------------
// models.dev 长尾
// ---------------------------------------------------------------------------

/** api.json 中 provider 级条目的最小投影（防御性：多余字段忽略）。 */
const API_JSON_PROVIDER_SCHEMA = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(256).optional(),
  api: z.string().max(2048).optional(),
  env: z.array(z.string().max(256)).max(16).optional(),
  npm: z.string().max(256).optional(),
  models: z
    .record(
      z.string().min(1).max(256),
      z
        .object({
          id: z.string().min(1).max(256).optional(),
          name: z.string().max(512).optional(),
          cost: z
            .object({
              input: z.number().nonnegative().optional(),
              output: z.number().nonnegative().optional(),
            })
            .optional(),
        })
        .passthrough(),
    )
    .optional(),
});

const API_JSON_SCHEMA = z.record(z.string(), API_JSON_PROVIDER_SCHEMA);

const CACHE_FILE_SCHEMA = z.strictObject({
  fetchedAt: z.number().int().min(0),
  raw: z.string().min(2),
});

/**
 * 长尾结果：presets 可为空数组；不可用时 error 说明原因（精选集不受影响）。
 * @typedef {Object} ModelsDevResult
 * @property {Array<Record<string, any>>} presets
 * @property {"fetch" | "cache"} origin
 * @property {string} [error]
 */

/**
 * npm 包名 → apiForm 归类（npm 含 openai-compatible→openai-completions、
 * anthropic→anthropic-messages、google→gemini-native、其它归 openai-completions
 * 并标 unverified）。
 * @param {string | undefined} npm
 */
export function classifyApiForm(npm) {
  const pkg = npm ?? "";
  if (pkg.includes("anthropic")) return { apiForm: "anthropic-messages", unverified: false };
  if (pkg.includes("google")) return { apiForm: "gemini-native", unverified: false };
  if (pkg.includes("openai")) return { apiForm: "openai-completions", unverified: false };
  return { apiForm: "openai-completions", unverified: true };
}

/** 长尾 defaultPort：id 的 FNV-1a 哈希映射到 20000..64999（确定性）。 */
export function derivedPortFor(id) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(id, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 20000 + (hash % 45000);
}

/**
 * 从 api.json 原始文本派生长尾预设（跳过无显式 api 的条目；排除精选集已覆盖
 * 的 id；keyEnv 仅作提示字段保留）。
 * @param {string} raw
 * @param {ReadonlySet<string>} curatedIds
 * @returns {Array<Record<string, any>>}
 */
export function deriveModelsDevPresets(raw, curatedIds) {
  const parsed = JSON.parse(raw);
  const providers = API_JSON_SCHEMA.parse(parsed);
  const out = [];
  for (const [id, provider] of Object.entries(providers)) {
    if (provider.api === undefined || provider.api === "") continue;
    if (curatedIds.has(id)) continue; // 精选集胜出（出处更可信）
    if (!/^https?:\/\//.test(provider.api)) continue;
    const { apiForm, unverified } = classifyApiForm(provider.npm);
    let host;
    try {
      host = new URL(provider.api).hostname;
    } catch {
      continue;
    }
    const keyEnv = provider.env?.[0];
    const parsedPreset = PRESET_SCHEMA.parse({
      id,
      label: provider.name && provider.name !== "" ? provider.name : id,
      apiForm,
      baseUrl: provider.api,
      ...(keyEnv !== undefined ? { keyEnv } : {}),
      defaultPort: derivedPortFor(id),
      matchDomains: [host],
      source: "models.dev",
      ...(unverified ? { unverified: true } : {}),
    });
    out.push(parsedPreset);
  }
  return out;
}

/**
 * 读取并校验缓存（损坏/不存在返回 undefined）。
 * @param {string} cachePath
 */
function readCache(cachePath) {
  try {
    return CACHE_FILE_SCHEMA.parse(JSON.parse(readFileSync(cachePath, "utf8")));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 模型清单与价格
// ---------------------------------------------------------------------------

/**
 * 模型清单条目。
 * @typedef {Object} ModelCatalogEntry
 * @property {string} id
 * @property {string} [name]
 * @property {number} [pricePerMTok] input+output 合计 USD/Mtok；未知价省略
 * @property {boolean} priced
 * @property {boolean} chat
 */

/** non-chat 启发式（embed/image/whisper/tts/rerank/moderation/dall-e/sd3）。 */
const NON_CHAT_ID_PATTERN = /embed|image|whisper|tts|rerank|moderation|dall-e|sd3/i;

/**
 * @param {string} id
 */
export function isChatModelId(id) {
  return !NON_CHAT_ID_PATTERN.test(id);
}

/**
 * 排序权重：chat 且价已知（价格升序）→ chat 未价 → non-chat 价已知 → 未价。
 * @param {ModelCatalogEntry} entry
 */
function catalogRank(entry) {
  if (entry.chat) return entry.priced ? 0 : 1;
  return entry.priced ? 2 : 3;
}

/**
 * 从 api.json 原始文本派生某 provider 的模型清单（价格升序、chat 优先、未知价
 * 尾排）。provider 不在清单时返回 undefined。
 * @param {string} raw
 * @param {string} providerId
 * @returns {ModelCatalogEntry[] | undefined}
 */
export function deriveModels(raw, providerId) {
  const parsed = JSON.parse(raw);
  const providers = API_JSON_SCHEMA.parse(parsed);
  const provider = providers[providerId];
  if (provider === undefined) return undefined;
  /** @type {ModelCatalogEntry[]} */
  const entries = [];
  for (const [key, model] of Object.entries(provider.models ?? {})) {
    const id = model.id ?? key;
    const input = model.cost?.input;
    const output = model.cost?.output;
    const price = input !== undefined && output !== undefined ? input + output : undefined;
    entries.push({
      id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(price !== undefined ? { pricePerMTok: price } : {}),
      priced: price !== undefined,
      chat: isChatModelId(id),
    });
  }
  entries.sort((a, b) => {
    const rankDiff = catalogRank(a) - catalogRank(b);
    if (rankDiff !== 0) return rankDiff;
    if (a.priced && b.priced) {
      const priceDiff = (a.pricePerMTok ?? 0) - (b.pricePerMTok ?? 0);
      if (priceDiff !== 0) return priceDiff;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return entries;
}

/** 原子写缓存（失败静默：缓存写失败不致命）。 */
function writeCache(cachePath, raw, fetchedAt) {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
    writeFileSync(tmp, `${JSON.stringify({ fetchedAt, raw }, undefined, 2)}\n`);
    renameSync(tmp, cachePath);
  } catch {
    /* 缓存写失败不致命：本次结果仍可用 */
  }
}

/**
 * 只读缓存中的原始 api.json 文本（不存在/损坏返回 undefined——不触发网络）。
 * @param {string} [cachePath]
 */
export function readModelsDevRaw(cachePath = modelsDevCachePath()) {
  return readCache(cachePath)?.raw;
}

/**
 * 取原始 api.json（TTL 内直接回缓存；过期/未命中先刷新，失败回退缓存并附
 * 错误说明——上游同拍）。
 * @param {{ cachePath?: string, fetchImpl?: typeof fetch, now?: () => number, force?: boolean }} [opts]
 */
export async function fetchModelsDevRaw(opts = {}) {
  const now = opts.now ?? Date.now;
  const cachePath = opts.cachePath ?? modelsDevCachePath();
  const doFetch = opts.fetchImpl ?? fetch;

  const cached = readCache(cachePath);
  if (!opts.force && cached !== undefined && now() - cached.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
    return { raw: cached.raw, origin: "cache" };
  }
  try {
    const response = await doFetch(MODELS_DEV_API_URL, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const raw = await response.text();
    JSON.parse(raw); // 形状校验在派生层；这里只确保是 JSON
    writeCache(cachePath, raw, now());
    return { raw, origin: "fetch" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached !== undefined) {
      return { raw: cached.raw, origin: "cache", error: `fetch failed (${message}); serving cached copy` };
    }
    return { raw: undefined, origin: "cache", error: `fetch failed (${message}) and no cache available` };
  }
}

/**
 * 拉取（或回退缓存）models.dev 长尾。失败且无可用缓存时返回 error 结果（不抛）。
 * @param {ReadonlyArray<Record<string, any>>} curated
 * @param {{ cachePath?: string, fetchImpl?: typeof fetch, now?: () => number, force?: boolean }} [opts]
 * @returns {Promise<ModelsDevResult>}
 */
export async function fetchModelsDevPresets(curated, opts = {}) {
  const result = await fetchModelsDevRaw(opts);
  const curatedIds = new Set(curated.map((p) => p.id));
  if (result.raw === undefined) {
    return { presets: [], origin: "cache", ...(result.error !== undefined ? { error: result.error } : {}) };
  }
  return {
    presets: deriveModelsDevPresets(result.raw, curatedIds),
    origin: result.origin,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** 快速探测缓存是否存在（UI 展示「长尾不可用」状态用）。 */
export function hasModelsDevCache(cachePath = modelsDevCachePath()) {
  return existsSync(cachePath);
}
