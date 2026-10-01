// ai-fly 配置两阶段导入器（design §4「导入两阶段 staging」/requirements
// 「$env 拒绝与两阶段导入」——ai-fly 无对应物，规则为冻结规范）：
// - 阶段一 staging：扫描 ai-fly services.json（v1/v2 任意形状，宽松读取）→
//   返回机器可读 {blocked:[{service,field,ref,reason?}], ready:[...]}——
//   安全条目**不激活**；$env 引用条目与 codex 预设绑定进 blocked；
// - 用户完成 $env→secret 映射后阶段二 commit 一次性全量生效（store
//   transaction 内原子写入；任一失败回滚快照）；**禁止 env 自动快照**
//   （任何路径都不读 env 值——只有映射名）。
// 转换语义：auth.literal `$env:VAR`（bearer 开关保留）→ {secret:<mapped>}；
// headers.set 值 `$env:VAR` → `$secret:<mapped>`。codex hooks 绑定 v1 不可
// 导入（后续 change ai-codex-oauth）。

import { ENV_REF_PREFIX } from "./lifecycle.mjs";
import { StoreError } from "./store.mjs";

/**
 * @typedef {Object} ImportBlocked
 * @property {string} service 服务名
 * @property {string} field 声明位（"auth.literal" | "headers.set.<name>" | "hooks.script"）
 * @property {string} ref 引用原文（如 "$env:OPENAI_API_KEY"、"codex"）
 * @property {string} [reason] 机器可读原因（"requires ai-codex-oauth"）
 */

/** 内建 codex 绑定的承接 change 名（占位呈现/错误指引共用）。 */
export const CODEX_FOLLOWUP_CHANGE = "ai-codex-oauth";

/**
 * 阶段一：扫描 ai-fly services.json 原文 → 机器可读 staging 结果。
 * 解析失败抛错（不静默）；不写任何文件、不激活任何条目、不读 env。
 * @param {string} rawText ai-fly services.json 原文
 * @returns {{ blocked: ImportBlocked[], ready: Array<{ name: string, input: Record<string, any> }> }}
 */
export function stageAiflyConfig(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`ai-fly services.json is not valid JSON: ${err.message}`);
  }
  const services = parsed?.services;
  if (!Array.isArray(services)) {
    throw new Error("ai-fly services.json: expected { services: [...] }");
  }
  /** @type {ImportBlocked[]} */
  const blocked = [];
  /** @type {Array<{ name: string, input: Record<string, any> }>} */
  const ready = [];
  for (const entry of services) {
    if (entry === null || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : "(unnamed)";
    /** @type {ImportBlocked[]} */
    const entryBlocked = [];
    // ① auth.literal 的 $env 引用
    const auth = entry.auth;
    if (auth !== null && typeof auth === "object" && typeof auth.literal === "string" && auth.literal.startsWith(ENV_REF_PREFIX)) {
      entryBlocked.push({ service: name, field: "auth.literal", ref: auth.literal });
    }
    // ② headers.set 值的 $env 引用（与 auth 是否存在/为 null 无关——独立扫描面：
    // `auth:null` 的服务同样不得携带 $env 头进 ready）
    const headers = entry.headers;
    const set = headers !== null && typeof headers === "object" ? headers.set : undefined;
    if (set !== null && typeof set === "object") {
      for (const [headerName, value] of Object.entries(set)) {
        if (typeof value === "string" && value.startsWith(ENV_REF_PREFIX)) {
          entryBlocked.push({ service: name, field: `headers.set.${headerName}`, ref: value });
        }
      }
    }
    // ③ codex 预设绑定（v1 不随包——后续 change）
    const hooks = entry.hooks;
    if (hooks !== null && typeof hooks === "object" && hooks.script === "codex") {
      entryBlocked.push({
        service: name,
        field: "hooks.script",
        ref: "codex",
        reason: `requires ${CODEX_FOLLOWUP_CHANGE}`,
      });
    }
    if (entryBlocked.length > 0) {
      blocked.push(...entryBlocked);
      continue;
    }
    ready.push({ name, input: projectAiflyService(entry) });
  }
  return { blocked, ready };
}

/**
 * ai-fly 服务条目 → 本包 ServiceInput 投影（安全字段白名单拷贝；未知字段
 * 丢弃——两库语义在本包 store 层重新校验）。
 * @param {Record<string, any>} entry
 */
function projectAiflyService(entry) {
  const input = {
    name: entry.name,
    upstream: entry.upstream,
    match: Array.isArray(entry.match) ? entry.match.map((m) => ({ type: m.type, value: m.value })) : [],
    defaultPort: typeof entry.defaultPort === "number" ? entry.defaultPort : undefined,
  };
  for (const field of ["rewrite", "auth", "headers", "request", "response", "hooks", "routes"]) {
    if (entry[field] !== undefined) input[field] = entry[field];
  }
  return input;
}

/**
 * env 引用名提取（"$env:OPENAI_API_KEY" → "OPENAI_API_KEY"）。
 * @param {string} ref
 */
export function envRefName(ref) {
  return ref.slice(ENV_REF_PREFIX.length);
}

/**
 * 阶段二：一次性 commit。规则（冻结）：
 * - staging 的 blocked 必须全部被 mappings 覆盖（VAR → 已存在于密钥库的
 *   secret 名）；codex/reason 类 blocked 不可映射（抛错指明后续 change）；
 * - 转换后逐条 addService（enabled 照源文件；映射产出的 auth={secret} 服务
 *   过 store 激活门）——store.transaction 原子回滚；
 * - 不读 env（映射只含名字与 secret 名——禁止 env 自动快照）。
 * @param {{ blocked: ImportBlocked[], ready: Array<{ name: string, input: Record<string, any> }> }} staging
 * @param {import("./store.mjs").ProviderStore} store
 * @param {{ mappings: Record<string, string>, secretExists: (name: string) => boolean, groupName?: string }} opts
 * @returns {Promise<{ added: string[], group?: string }>}
 */
export async function commitAiflyImport(staging, store, opts) {
  const { mappings, secretExists } = opts;
  // ① blocked 全覆盖校验（fail-fast，零写入）
  for (const item of staging.blocked) {
    if (item.reason !== undefined) {
      throw new Error(
        `cannot import service '${item.service}': ${item.field}=${item.ref} (${item.reason}); remove it from the ai-fly config or wait for the follow-up change`,
      );
    }
    if (!item.ref.startsWith(ENV_REF_PREFIX)) {
      throw new Error(`cannot import service '${item.service}': unsupported reference ${item.ref} at ${item.field}`);
    }
    const varName = envRefName(item.ref);
    if (mappings[varName] === undefined) {
      throw new Error(
        `cannot import service '${item.service}': ${item.field}=${item.ref} has no mapping; map it to a secrets-store name first`,
      );
    }
  }
  for (const [varName, secretName] of Object.entries(mappings)) {
    if (!secretExists(secretName)) {
      // 文案不含目标 secret 名（脱敏纪律）；env 变量名（keyEnv 族）按规范可保留。
      throw new Error(`mapping '${varName}' targets a secret which is not in the secrets store; add it first`);
    }
  }
  // ② 转换 + 原子写入（transaction：任一失败回滚快照）
  return await store.transaction(async (tx) => {
    /** @type {string[]} */
    const added = [];
    for (const { input } of staging.ready) {
      const converted = convertServiceInput(input, mappings);
      await tx.addService({ ...converted, enabled: converted.enabled ?? true });
      added.push(converted.name);
    }
    // 可选分组（一次性把导入服务编组）
    let group;
    if (opts.groupName !== undefined && added.length > 0) {
      group = opts.groupName;
      const existing = tx.getGroup(group);
      if (existing === undefined) await tx.addGroup(group, added);
      else await tx.setGroupServices(group, mergeGroupNames(tx, group, added));
    }
    return { added, ...(group !== undefined ? { group } : {}) };
  });
}

/**
 * 合并既有分组服务名与新导入名（setGroupServices 按名解析）。
 * @param {import("./store.mjs").ProviderStore} tx
 * @param {string} group
 * @param {string[]} added
 */
function mergeGroupNames(tx, group, added) {
  const existing = tx.getGroup(group);
  const names = [];
  for (const id of existing?.serviceIds ?? []) {
    const svc = tx.getService(id);
    if (svc !== undefined) names.push(svc.name);
  }
  return [...new Set([...names, ...added])];
}

/**
 * ServiceInput 转换：auth.literal `$env:VAR` → {secret:<mapped>}（bearer
 * 保留）；headers.set `$env:VAR` → `$secret:<mapped>`；其余原样。
 * @param {Record<string, any>} input
 * @param {Record<string, string>} mappings
 */
export function convertServiceInput(input, mappings) {
  const out = { ...input };
  if (out.auth !== null && typeof out.auth === "object" && typeof out.auth.literal === "string" && out.auth.literal.startsWith(ENV_REF_PREFIX)) {
    const secret = mappings[envRefName(out.auth.literal)];
    if (secret === undefined) {
      throw new StoreError("invalid", `error: service '${input.name}' auth literal has an unmapped $env reference`);
    }
    out.auth = { secret, ...(out.auth.bearer !== undefined ? { bearer: out.auth.bearer } : {}) };
  }
  const set = out.headers?.set;
  if (set !== null && typeof set === "object") {
    const next = {};
    for (const [name, value] of Object.entries(set)) {
      if (typeof value === "string" && value.startsWith(ENV_REF_PREFIX)) {
        const secret = mappings[envRefName(value)];
        if (secret === undefined) {
          throw new StoreError("invalid", `error: service '${input.name}' headers.set.${name} has an unmapped $env reference`);
        }
        next[name] = `$secret:${secret}`;
        continue;
      }
      next[name] = value;
    }
    out.headers = { ...out.headers, set: next };
  }
  return out;
}
