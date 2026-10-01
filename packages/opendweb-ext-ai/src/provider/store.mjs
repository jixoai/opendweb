// adapted from ai-fly src/provider/store.ts (v0.6.0)
// 提供方本地存储（services.json v2）：服务 / 分组 / 密钥三类实体的唯一持久化面。
// 与上游的有意分歧（design §0/§2/§3/§4）：
// - 路径根 `<DWEB_HOME>/plugins/ai/`；写原语换 atomicWrite0600（async——
//   add/remove/set* 系列变 async；open 为 async 读盘）；
// - **全量 catalog ≤256 服务**（design §3：超配工厂期拒绝——服务数超限即
//   不可保存）；
// - 服务条目新增可选 `keyEnv` 字段：预设来源的惯用 env 名投影（仅 UI 提示
//   语义——§4 ③预设面：激活前 MUST 绑定 secret；④ambient env 防绕在
//   addService(enabled)/setServiceEnabled(true) 的原子变更内 fail-closed 拒绝）；
// - `$env:` 引用在 schema 层构造期拒绝（lifecycle.mjs HEADER_VALUE/AUTH_LITERAL
//   refine——上游允许请求期解析）；
// - legacy（pre-v2）迁移模式不移植：本包数据目录是全新目录，ai-fly 旧配置经
//   两阶段导入器（importer.mjs）接入，不经本 store 的版本门禁。
// 照搬上游：密钥 SHA-256+固定 salt 哈希、timingSafeEqual 全表扫描（不因命中
// 提前退出）、raw key 可选落盘（上游 Owner 裁决 2026-09-13）、revision 每次
// save 自增、defaultPort 特权端口规则、正则规则保存期编译检查、hooks 与逐槽
// 互斥、match 是纯展示元数据。

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AUTH_SLOT_SCHEMA,
  HEADERS_SLOT_SCHEMA,
  HOOKS_SLOT_SCHEMA,
  REQUEST_SLOT_SCHEMA,
  RESPONSE_SLOT_SCHEMA,
  LIFECYCLE_SLOTS_SCHEMA,
} from "./lifecycle.mjs";
import { compileMatchPattern } from "./match-pattern.mjs";
import { validateUriTemplate } from "./uri-template.mjs";
import { randomZ32 } from "./z32.mjs";
import { atomicWrite0600 } from "../fsutil.mjs";
import { scriptHasStageExports } from "./hooks.mjs";
import { CATALOG_MAX_SERVICES } from "../wire/constants.mjs";

// ---------------------------------------------------------------------------
// 常量与错误
// ---------------------------------------------------------------------------

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 密钥哈希固定 salt（所有提供方实例一致；防直接彩虹表对照 sk-aifly- 空间）。 */
const KEY_HASH_SALT = "aifly-provider-key-v1:";

export const KEY_MATERIAL_PREFIX = "sk-aifly-";
export const SERVICE_ID_BYTES = 8; // randomZ32(8) -> 13 字符
export const KEY_ID_BYTES = 8;
export const KEY_MATERIAL_BYTES = 32; // randomZ32(32) -> 52 字符

export const STORE_VERSION = 2;

/** 存储层错误（message 为进程内诊断全文；HTTP/UI 投影经 redact.mjs 脱敏）。 */
export class StoreError extends Error {
  /**
   * @param {"duplicate" | "not-found" | "invalid" | "corrupt" | "conflict"} code
   * @param {string} message
   * @param {Record<string, unknown>} [details] 结构化安全字段（激活门 gate/keyEnv
   *   等——redact.mjs 据此投影固定文案；secret 名/路径不得放入）
   */
  constructor(code, message, details) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// zod schema（加载校验）
// ---------------------------------------------------------------------------

export const SERVICE_MATCH_STORE_SCHEMA = z.strictObject({
  type: z.enum(["exact", "suffix", "regex"]),
  value: z.string().min(1).max(2048),
});

/** rewrite v2（瘦身）：host 头覆盖 + 路径前缀剥离/追加。 */
export const SERVICE_REWRITE_STORE_SCHEMA = z.strictObject({
  host: z.string().min(1).max(2048).optional(),
  pathPrefixStrip: z.string().min(1).max(2048).optional(),
  pathPrefixAppend: z.string().min(1).max(2048).optional(),
});

/** 路径路由：按声明顺序命中的转发规则——prefix 或 pattern 模式；forms 为 AI 层标注。 */
export const SERVICE_ROUTE_STORE_SCHEMA = z.strictObject({
  forms: z.array(z.enum(["openai-chat", "openai-responses", "anthropic"])).max(3),
  mode: z.enum(["prefix", "pattern"]).optional(),
  localPrefix: z.string().min(1).max(2048).optional(),
  upstreamPrefix: z.string().max(2048).optional(),
  matchPattern: z.string().min(1).max(2048).optional(),
  template: z.string().min(1).max(2048).optional(),
});

const SERVICE_STORE_BASE = z.strictObject({
  serviceId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  match: z.array(SERVICE_MATCH_STORE_SCHEMA).max(64),
  upstream: z.string().min(1).max(2048),
  rewrite: SERVICE_REWRITE_STORE_SCHEMA.optional(),
  ...LIFECYCLE_SLOTS_SCHEMA.shape,
  hooks: HOOKS_SLOT_SCHEMA.optional(),
  routes: z.array(SERVICE_ROUTE_STORE_SCHEMA).max(3).optional(),
  defaultPort: z.number().int().min(1).max(65535),
  /** 停用开关：false = 临时停暴露；请求按 unknown_service 拒。旧文件缺省 true。 */
  enabled: z.boolean().default(true),
  /** 预设来源的惯用 env 名（§4 ③④：仅 UI 提示；激活前 MUST 绑定 secret；
   *  ambient env 存在该变量时启用=原子拒绝）。 */
  keyEnv: z.string().min(1).max(256).optional(),
});

/** 双模式互斥（hooks 预设模式与任一逐槽同现=corrupt）。 */
export const SERVICE_STORE_SCHEMA = SERVICE_STORE_BASE.superRefine((service, ctx) => {
  if (service.hooks === undefined) return;
  const slots = ["auth", "headers", "request", "response"];
  const slot = slots.find((k) => service[k] !== undefined);
  if (slot !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["hooks"],
      message: `lifecycle 'hooks' (preset mode) and per-stage slot '${slot}' are mutually exclusive`,
    });
  }
});

export const GROUP_LIMITS_STORE_SCHEMA = z.strictObject({
  maxConcurrency: z.number().int().min(1).optional(),
  dailyRequests: z.number().int().min(1).optional(),
});

export const GROUP_STORE_SCHEMA = z.strictObject({
  name: z.string().min(1).max(256),
  serviceIds: z.array(z.string().min(1).max(128)).max(CATALOG_MAX_SERVICES),
  limits: GROUP_LIMITS_STORE_SCHEMA.optional(),
});

export const KEY_STORE_SCHEMA = z.strictObject({
  keyId: z.string().min(1).max(128),
  group: z.string().min(1).max(256),
  hash: z.string().regex(/^[0-9a-f]{64}$/, "key hash must be 64 hex chars"),
  /** key 名（签发时必填；GUI 分组视图按名展示；旧记录无此字段——迁移容忍）。 */
  name: z.string().min(1).max(128).optional(),
  /** key 原文（上游 Owner 裁决 2026-09-13：可选落盘、随时可复制；旧记录只存哈希）。 */
  key: z.string().min(8).max(256).optional(),
  createdAt: z.number().int().min(0),
  revokedAt: z.number().int().min(0).optional(),
});

/** key 名规则（同 SECRET_NAME_SCHEMA 词汇）。 */
export const KEY_NAME_SCHEMA = /^[a-z0-9][a-z0-9._-]*$/;

export const STORE_META_SCHEMA = z.strictObject({ alias: z.string().min(1).max(256).optional() });

export const STORE_FILE_SCHEMA = z.strictObject({
  version: z.literal(STORE_VERSION),
  revision: z.number().int().min(0),
  meta: STORE_META_SCHEMA.optional(),
  /** design §3：全量 catalog ≤256 服务——存储层超配即不可保存。 */
  services: z.array(SERVICE_STORE_SCHEMA).max(CATALOG_MAX_SERVICES),
  groups: z.array(GROUP_STORE_SCHEMA).max(256),
  keys: z.array(KEY_STORE_SCHEMA).max(1024),
});

// ---------------------------------------------------------------------------
// 私有目录 / 哈希 / 上游 URL 校验
// ---------------------------------------------------------------------------

/** 确保私有目录（0700；secrets.mjs 复用）。 */
export async function ensurePrivateDir(dir) {
  await mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    /* 某些文件系统不支持 chmod；尽力而为 */
  }
}

/** @param {string} material @returns {string} hex64 */
export function hashKeyMaterial(material) {
  return createHash("sha256").update(KEY_HASH_SALT + material).digest("hex");
}

const PRIVILEGED_PORT_MAX = 1023;

/** 解析并校验上游 URL：http/https、必须有主机名、禁 userinfo/query/fragment。 */
export function parseUpstreamUrl(upstream) {
  let url;
  try {
    url = new URL(upstream);
  } catch {
    throw new StoreError("invalid", `error: invalid upstream URL: ${upstream}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StoreError("invalid", "error: upstream URL scheme must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new StoreError("invalid", "error: upstream URL must not embed credentials (user:pass@)");
  }
  if (url.hostname === "") {
    throw new StoreError("invalid", "error: upstream URL must have a hostname");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new StoreError("invalid", "error: upstream URL must not contain query or fragment");
  }
  return url;
}

/** 上游生效端口（显式或缺省 scheme 端口）。 */
export function upstreamEffectivePort(url) {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** 路由的生效本地前缀（缺省按首个 form 规范前缀——ai-fly rpc-contract 同拍）。 */
export const ROUTE_LOCAL_PREFIX = {
  "openai-chat": "/v1",
  "openai-responses": "/v1",
  anthropic: "/anthropic",
};

/**
 * @param {{ forms: string[], localPrefix?: string | undefined }} route
 * @returns {string}
 */
export function routeLocalPrefix(route) {
  return route.localPrefix ?? ROUTE_LOCAL_PREFIX[route.forms[0] ?? "openai-chat"];
}

// ---------------------------------------------------------------------------
// ProviderStore
// ---------------------------------------------------------------------------

/** verifyKey 结果：有效（含定位）/ 无效 / 已撤销。 */

/**
 * 提供方存储（services.json v2）。
 * 打开时整读，save() 原子写并自增 revision；变更监听（onChange）供 catalog
 * 长轮询唤醒。激活门（keyEnv→secret 绑定 + ambient env fail-closed）在
 * addService(enabled)/setServiceEnabled(true) 的写路径内原子执行；save() 为
 * 唯一落盘写入口，对全部将启用服务重跑激活门——公开 data/save 的直接变更
 * 无法绕过（fail-closed 零写入）。
 */
export class ProviderStore {
  /** @param {string} dataDir @param {StoreData} data @param {{ random?: (n: number) => string, env?: (name: string) => string | undefined, secretsSource?: (name: string) => boolean, home?: string }} opts */
  constructor(dataDir, data, opts = {}) {
    this.dataDir = dataDir;
    this.data = data;
    this.#random = opts.random ?? ((n) => randomZ32(n));
    this.#env = opts.env ?? ((name) => process.env[name]);
    this.#secretsSource =
      opts.secretsSource ?? ((name) => defaultSecretExists(dataDir, name));
    this.#home = opts.home;
    // 落盘基线（P1-7）：构造时的 enabled 状态=「已在盘上启用」集合——save() 只对
    // 相对基线**将启用**（新增启用/停用翻转）的服务重跑激活门。
    this.#persistedEnabled = new Map(data.services.map((s) => [s.serviceId, s.enabled !== false]));
  }

  #random;
  #env;
  #secretsSource;
  #home;
  /** @type {Map<string, boolean> | null} 上次成功落盘的 per-service enabled 基线。 */
  #persistedEnabled;
  /** @type {Set<() => void>} */
  #listeners = new Set();

  /** @param {string} dataDir */
  static filePath(dataDir) {
    return join(dataDir, "services.json");
  }

  /** 干净 v2 空库。 */
  static #emptyV2(revision) {
    return { version: STORE_VERSION, revision, services: [], groups: [], keys: [] };
  }

  /**
   * 打开（不存在则初始化空 v2 存储；损坏/版本不符抛 StoreError(corrupt)）。
   * @param {string} dataDir
   * @param {{ random?: (n: number) => string, env?: (name: string) => string | undefined, secretsSource?: (name: string) => boolean, home?: string }} [opts]
   */
  static async open(dataDir, opts = {}) {
    await ensurePrivateDir(dataDir);
    const file = ProviderStore.filePath(dataDir);
    if (!existsSync(file)) {
      return new ProviderStore(dataDir, ProviderStore.#emptyV2(0), opts);
    }
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      throw new StoreError("corrupt", `error: cannot read ${file}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreError("corrupt", `error: ${file} is not valid JSON (fix or remove it manually)`);
    }
    const result = STORE_FILE_SCHEMA.safeParse(parsed);
    if (!result.success) {
      throw new StoreError("corrupt", `error: ${file} failed validation: ${result.error.message}`);
    }
    return new ProviderStore(dataDir, result.data, opts);
  }

  /** 当前文件 revision（catalog watch 的 since 基准）。 */
  get revision() {
    return this.data.revision;
  }

  /** 变更监听（每次成功 save 后唤醒；返回退订函数）。 */
  onChange(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  // -----------------------------------------------------------------------
  // 服务
  // -----------------------------------------------------------------------

  listServices() {
    return this.data.services.map((s) => ({ ...s }));
  }

  getService(serviceId) {
    const found = this.data.services.find((s) => s.serviceId === serviceId);
    return found === undefined ? undefined : { ...found };
  }

  getServiceByName(name) {
    const found = this.data.services.find((s) => s.name === name);
    return found === undefined ? undefined : { ...found };
  }

  /**
   * 新增服务（原子：校验→激活门→落盘；任何拒绝零写入）。
   * @param {object} input ServiceInput（见上游同名字段；+keyEnv?）
   */
  async addService(input) {
    const name = input.name.trim();
    if (name === "" || name.length > 256) {
      throw new StoreError("invalid", "error: service name must be 1..256 chars");
    }
    if (this.data.services.some((s) => s.name === name)) {
      throw new StoreError("duplicate", `error: service '${name}' already exists`);
    }
    if (this.data.services.length >= CATALOG_MAX_SERVICES) {
      // design §3：全量 catalog ≤256 服务——工厂期拒绝超配（不可保存）。
      throw new StoreError(
        "invalid",
        `error: catalog exceeds ${CATALOG_MAX_SERVICES} services; remove a service before adding '${name}'`,
      );
    }
    if (input.match.length === 0) {
      throw new StoreError("invalid", "error: service must declare at least one match rule");
    }
    if (input.match.length > 64) {
      throw new StoreError("invalid", "error: service match rules exceed 64 entries");
    }
    // 正则规则保存期编译检查（语法合法即可，无运行时执行面）。
    for (const rule of input.match) {
      if (rule.type === "regex") {
        try {
          new RegExp(rule.value);
        } catch (err) {
          throw new StoreError("invalid", `error: invalid regex '${rule.value}': ${err.message}`);
        }
      }
    }
    const upstreamUrl = parseUpstreamUrl(input.upstream);
    // defaultPort 规则：上游端口 <1024 必须显式；缺省继承上游端口。
    let defaultPort;
    if (input.defaultPort === undefined) {
      const eff = upstreamEffectivePort(upstreamUrl);
      if (eff <= PRIVILEGED_PORT_MAX) {
        throw new StoreError(
          "invalid",
          `error: upstream port ${eff} is privileged; declare an explicit consumer-side default port`,
        );
      }
      defaultPort = eff;
    } else {
      if (!Number.isInteger(input.defaultPort) || input.defaultPort < 1 || input.defaultPort > 65535) {
        throw new StoreError("invalid", "error: default port must be an integer in 1..65535");
      }
      defaultPort = input.defaultPort;
    }
    const rewrite = input.rewrite === undefined ? undefined : normalizeRewrite(input.rewrite);
    const auth = normalizeAuthSlot(input.auth);
    const headers = normalizeHeadersSlot(input.headers);
    const request = normalizeScriptSlot("request", REQUEST_SLOT_SCHEMA, input.request);
    const response = normalizeScriptSlot("response", RESPONSE_SLOT_SCHEMA, input.response);
    const hooks =
      input.hooks === undefined
        ? undefined
        : await this.#normalizeHooksSlot(input.hooks, auth, headers, request, response);
    const routes = normalizeRoutes(input.routes);
    let serviceId;
    do {
      serviceId = this.#random(SERVICE_ID_BYTES);
    } while (this.data.services.some((s) => s.serviceId === serviceId));
    const service = {
      serviceId,
      name,
      match: input.match.map((m) => ({ ...m })),
      upstream: upstreamUrl.href,
      rewrite,
      ...(auth !== undefined ? { auth } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(request !== undefined ? { request } : {}),
      ...(response !== undefined ? { response } : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      ...(routes !== undefined ? { routes } : {}),
      defaultPort,
      enabled: input.enabled ?? true,
      ...(input.keyEnv !== undefined ? { keyEnv: input.keyEnv } : {}),
    };
    // 激活门（§4 ③④：keyEnv→secret 绑定 + ambient env fail-closed）。
    assertServiceActivatable(service, { env: this.#env, secrets: this.#secretsSource });
    this.data.services.push(service);
    await this.save();
    return { ...service };
  }

  /** @param {{script: string, args?: Record<string, string>}} hooks @param {unknown} auth @param {unknown} headers @param {unknown} request @param {unknown} response */
  async #normalizeHooksSlot(hooks, auth, headers, request, response) {
    if (auth !== undefined || headers !== undefined || request !== undefined || response !== undefined) {
      throw new StoreError(
        "invalid",
        "error: lifecycle 'hooks' (preset mode) and per-stage slots are mutually exclusive",
      );
    }
    const parsed = HOOKS_SLOT_SCHEMA.safeParse(hooks);
    if (!parsed.success) {
      throw new StoreError("invalid", `error: invalid hooks slot: ${parsed.error.message}`);
    }
    if (!scriptHasStageExports(parsed.data.script, this.#home === undefined ? {} : { home: this.#home })) {
      throw new StoreError(
        "invalid",
        `error: hook script '${parsed.data.script}' exports no lifecycle stage function`,
      );
    }
    return {
      script: parsed.data.script,
      ...(parsed.data.args !== undefined ? { args: { ...parsed.data.args } } : {}),
    };
  }

  /**
   * 移除服务（同步清出所有分组引用）。
   * @param {string} name
   */
  async removeService(name) {
    const idx = this.data.services.findIndex((s) => s.name === name);
    if (idx < 0) {
      throw new StoreError("not-found", `error: service '${name}' not found`);
    }
    const [removed] = this.data.services.splice(idx, 1);
    for (const group of this.data.groups) {
      group.serviceIds = group.serviceIds.filter((id) => id !== removed.serviceId);
    }
    await this.save();
  }

  /**
   * 停用/启用（幂等；启用方向过激活门——原子拒绝零写入）。
   * @param {string} serviceId @param {boolean} enabled
   */
  async setServiceEnabled(serviceId, enabled) {
    const idx = this.data.services.findIndex((s) => s.serviceId === serviceId);
    if (idx < 0) {
      throw new StoreError("not-found", `error: service '${serviceId}' not found`);
    }
    if (this.data.services[idx].enabled === enabled) return { changed: false };
    const next = { ...this.data.services[idx], enabled };
    assertServiceActivatable(next, { env: this.#env, secrets: this.#secretsSource });
    this.data.services[idx] = next;
    await this.save();
    return { changed: true };
  }

  /**
   * 重绑 auth 槽（Phase C 管理面：预设 keyEnv→secret 绑定/凭证轮换——design §4 ③
   * 的 UI 落点）。启用中的服务过激活门（原子拒绝零写入）；auth 置 undefined=清除。
   * @param {string} serviceId
   * @param {unknown} auth AUTH_SLOT_SCHEMA 形状或 undefined（清除）
   */
  async setServiceAuth(serviceId, auth) {
    const idx = this.data.services.findIndex((s) => s.serviceId === serviceId);
    if (idx < 0) {
      throw new StoreError("not-found", `error: service '${serviceId}' not found`);
    }
    const normalized = auth === undefined ? undefined : normalizeAuthSlot(auth);
    const next = { ...this.data.services[idx] };
    if (normalized === undefined) delete next.auth;
    else next.auth = normalized;
    assertServiceActivatable(next, { env: this.#env, secrets: this.#secretsSource });
    this.data.services[idx] = next;
    await this.save();
    return { ...next };
  }

  // -----------------------------------------------------------------------
  // 分组
  // -----------------------------------------------------------------------

  listGroups() {
    return this.data.groups.map((g) => ({ ...g, serviceIds: [...g.serviceIds] }));
  }

  getGroup(name) {
    const found = this.data.groups.find((g) => g.name === name);
    return found === undefined
      ? undefined
      : { ...found, serviceIds: [...found.serviceIds], limits: found.limits ? { ...found.limits } : undefined };
  }

  /** 组内服务视图（引用不存在的服务Id 自动跳过；停用服务不进目录视图）。 */
  groupServices(groupName) {
    const group = this.getGroup(groupName);
    if (group === undefined) return [];
    const out = [];
    for (const id of group.serviceIds) {
      const svc = this.getService(id);
      if (svc !== undefined && svc.enabled !== false) out.push(svc);
    }
    return out;
  }

  /**
   * @param {string} name @param {string[]} serviceNames @param {{maxConcurrency?: number, dailyRequests?: number}} [limits]
   */
  async addGroup(name, serviceNames, limits) {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 256) {
      throw new StoreError("invalid", "error: group name must be 1..256 chars");
    }
    if (this.data.groups.some((g) => g.name === trimmed)) {
      throw new StoreError("duplicate", `error: group '${trimmed}' already exists`);
    }
    const serviceIds = this.#resolveServiceIds(serviceNames);
    if (limits !== undefined) validateLimits(limits);
    const group = {
      name: trimmed,
      serviceIds,
      limits: limits === undefined ? undefined : { ...limits },
    };
    this.data.groups.push(group);
    await this.save();
    return { ...group, serviceIds: [...serviceIds] };
  }

  /** 更新既有分组的服务引用（整表替换；未知服务名报错）。 */
  async setGroupServices(name, serviceNames) {
    const group = this.data.groups.find((g) => g.name === name);
    if (group === undefined) {
      throw new StoreError("not-found", `error: group '${name}' not found`);
    }
    group.serviceIds = this.#resolveServiceIds(serviceNames);
    await this.save();
    return { ...group, serviceIds: [...group.serviceIds] };
  }

  /** 更新分组限额（undefined = 清除限额变无限）。 */
  async setGroupLimits(name, limits) {
    const group = this.data.groups.find((g) => g.name === name);
    if (group === undefined) {
      throw new StoreError("not-found", `error: group '${name}' not found`);
    }
    if (limits !== undefined) validateLimits(limits);
    group.limits = limits === undefined ? undefined : { ...limits };
    await this.save();
    return { ...group, serviceIds: [...group.serviceIds] };
  }

  /** 删除分组（仍有未撤销密钥时拒绝——先 revoke 再删）。 */
  async removeGroup(name) {
    const index = this.data.groups.findIndex((g) => g.name === name);
    if (index === -1) {
      throw new StoreError("not-found", `error: group '${name}' not found`);
    }
    const activeKeys = this.data.keys.filter((k) => k.group === name && k.revokedAt === undefined);
    if (activeKeys.length > 0) {
      throw new StoreError(
        "conflict",
        `error: group '${name}' still has ${activeKeys.length} active key(s) - revoke them first`,
      );
    }
    this.data.groups.splice(index, 1);
    await this.save();
  }

  /** @param {string[]} serviceNames @returns {string[]} */
  #resolveServiceIds(serviceNames) {
    const serviceIds = [];
    for (const svcName of serviceNames) {
      const svc = this.getServiceByName(svcName);
      if (svc === undefined) {
        throw new StoreError("not-found", `error: service '${svcName}' not found`);
      }
      if (!serviceIds.includes(svc.serviceId)) serviceIds.push(svc.serviceId);
    }
    return serviceIds;
  }

  // -----------------------------------------------------------------------
  // 密钥
  // -----------------------------------------------------------------------

  listKeys() {
    return this.data.keys.map((k) => ({ ...k }));
  }

  /**
   * 签发：name 缺省 "default"；原文随记录落库（raw key 可选存储照搬）。
   * @param {string} groupName @param {string} [name] @param {{ now?: () => number }} [ctx]
   */
  async issueKey(groupName, name = "default", ctx = {}) {
    const now = ctx.now ?? Date.now;
    if (this.getGroup(groupName) === undefined) {
      throw new StoreError("not-found", `error: group '${groupName}' not found`);
    }
    if (!KEY_NAME_SCHEMA.test(name)) {
      throw new StoreError("invalid", "error: key name must match /^[a-z0-9][a-z0-9._-]*$/");
    }
    let keyId;
    do {
      keyId = this.#random(KEY_ID_BYTES);
    } while (this.data.keys.some((k) => k.keyId === keyId));
    const key = KEY_MATERIAL_PREFIX + this.#random(KEY_MATERIAL_BYTES);
    const createdAt = now();
    this.data.keys.push({ keyId, group: groupName, hash: hashKeyMaterial(key), name, key, createdAt });
    await this.save();
    return { keyId, key, createdAt };
  }

  /** key 原文取回（旧记录只存哈希/已撤销/不存在 → undefined）。 */
  getKeyMaterial(keyId) {
    const found = this.data.keys.find((k) => k.keyId === keyId);
    if (found === undefined || found.revokedAt !== undefined) return undefined;
    return found.key;
  }

  /** 撤销（幂等：已撤销为 no-op）。 @param {string} keyId @param {{ now?: () => number }} [ctx] */
  async revokeKey(keyId, ctx = {}) {
    const now = ctx.now ?? Date.now;
    const found = this.data.keys.find((k) => k.keyId === keyId);
    if (found === undefined) {
      throw new StoreError("not-found", `error: key '${keyId}' not found`);
    }
    if (found.revokedAt === undefined) {
      found.revokedAt = now();
      await this.save();
    }
    return { ...found };
  }

  /**
   * 校验密钥原文：SHA-256(salt+原文) 后对全表 timingSafeEqual 扫描（不因命中
   * 提前退出，时序与表内容无关节）。命中后按 revokedAt 区分 valid/revoked。
   * @param {string} material
   */
  verifyKey(material) {
    const digest = Buffer.from(hashKeyMaterial(material), "hex");
    let match;
    for (const record of this.data.keys) {
      const stored = Buffer.from(record.hash, "hex");
      if (digest.length === stored.length && timingSafeEqual(digest, stored)) {
        match = record;
      }
    }
    if (match === undefined) return { status: "invalid" };
    const located = { keyId: match.keyId, group: match.group };
    return match.revokedAt === undefined
      ? { status: "valid", ...located }
      : { status: "revoked", ...located };
  }

  /**
   * keyId 定位（wire request 的三码分立判定面：absent=key_invalid 从未有效；
   * present+revokedAt=key_revoked；present+active=valid）。
   * @param {string} keyId
   */
  keyStatus(keyId) {
    const found = this.data.keys.find((k) => k.keyId === keyId);
    if (found === undefined) return { status: "invalid" };
    if (found.revokedAt !== undefined) return { status: "revoked", keyId, group: found.group };
    return { status: "valid", keyId, group: found.group };
  }

  // -----------------------------------------------------------------------
  // 别名 / 快照
  // -----------------------------------------------------------------------

  get alias() {
    return this.data.meta?.alias;
  }

  async setAlias(alias) {
    const trimmed = alias.trim();
    if (trimmed === "" || trimmed.length > 256) {
      throw new StoreError("invalid", "error: alias must be 1..256 chars");
    }
    this.data.meta = { ...(this.data.meta ?? {}), alias: trimmed };
    await this.save();
  }

  /** 只读快照（引擎/测试）。 */
  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  /**
   * 唯一落盘写入口：revision 自增 + 原子写 + 监听唤醒。
   * 激活门兜底（P1-7）：对相对上次落盘基线**将启用**（新增启用/停用→启用翻转）
   * 的服务重跑 assertServiceActivatable——公开可变 `data`+`save()` 的直接变更
   * 绕过高层门时在落盘前被拒（fail-closed 零写入；判定失败文件与 revision 均
   * 不变）。已启用存量不重判（启用时点已过门——secret 事后移除不得毒化无关
   * 写路径/阻碍停用）。
   */
  async save() {
    const baseline = this.#persistedEnabled ?? new Map();
    for (const service of this.data.services) {
      if (service.enabled === false) continue;
      if (baseline.get(service.serviceId) === true) continue; // 存量启用——不重判
      assertServiceActivatable(service, { env: this.#env, secrets: this.#secretsSource });
    }
    this.data.revision += 1;
    await atomicWrite0600(ProviderStore.filePath(this.dataDir), `${JSON.stringify(this.data, null, 2)}\n`);
    this.#persistedEnabled = new Map(this.data.services.map((s) => [s.serviceId, s.enabled !== false]));
    for (const cb of [...this.#listeners]) {
      try {
        cb(this.data.revision);
      } catch {
        /* 监听者异常不阻塞存储 */
      }
    }
  }

  /**
   * 原子事务：快照→fn→任一抛错回滚快照并重写（状态等价恢复；revision 再 +1）。
   * importer commit 的「一次性全量生效」落点。回滚重写失败（极端：门/磁盘）
   * 不吞原始错误——盘上仍为事务前内容（门在写前、原子写在 tmp+rename），
   * 内存保持快照一致。
   * @param {(store: ProviderStore) => Promise<T>} fn
   * @template T
   * @returns {Promise<T>}
   */
  async transaction(fn) {
    const snapshot = this.snapshot();
    try {
      return await fn(this);
    } catch (err) {
      this.data = snapshot;
      try {
        await this.save();
      } catch {
        /* 回滚重写失败：盘=事务前内容（写未发生），保留原始错误传播 */
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 激活门（§4 ③④——纯函数，store 写路径与 importer commit 共用）
// ---------------------------------------------------------------------------

/**
 * 服务激活断言（fail-closed，原子变更内调用）：
 * - ③ 预设面：声明 keyEnv 的服务激活前 MUST 绑定 secret 名（auth={secret:X}）
 *   且该 secret 已在密钥库（未绑定不可启用）；
 * - ④ ambient env 防绕：已启用（或将启用）服务的 keyEnv 变量存在于进程环境
 *   → 拒绝（列明变量名+指引转 secret 槽；不剥离值）。
 * @param {{ name: string, keyEnv?: string | undefined, auth?: { secret?: string } & Record<string, unknown> | undefined, enabled?: boolean }} service
 * @param {{ env: (name: string) => string | undefined, secrets: (name: string) => boolean }} ctx
 * @throws {StoreError}
 */
export function assertServiceActivatable(service, { env, secrets }) {
  if (service.enabled === false) return;
  const keyEnv = service.keyEnv;
  if (keyEnv === undefined) return;
  const auth = service.auth;
  if (auth === undefined || typeof auth.secret !== "string") {
    throw new StoreError(
      "invalid",
      `error: service '${service.name}' uses preset keyEnv '${keyEnv}'; bind its credential via the {secret: <name>} auth slot before enabling it`,
      { gate: "unbound-secret" },
    );
  }
  if (!secrets(auth.secret)) {
    throw new StoreError(
      "invalid",
      `error: service '${service.name}' binds secret '${auth.secret}' which is not in the secrets store; add it first`,
      { gate: "missing-secret" },
    );
  }
  if (env(keyEnv) !== undefined) {
    throw new StoreError(
      "conflict",
      `error: refusing to enable service '${service.name}': ambient environment variable '${keyEnv}' is set; move the credential into the secrets store and keep the {secret} binding (values are never snapshotted from env)`,
      { gate: "ambient-env", keyEnv },
    );
  }
}

/**
 * 默认 secret 存在性源（直读 secrets.json——无内存态；避免 store↔secrets 循环
 * import，语义与 SecretsStore.exists 同拍）。
 * @param {string} dataDir @param {string} name
 */
function defaultSecretExists(dataDir, name) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "secrets.json"), "utf8"));
    const secrets = parsed?.secrets;
    return secrets !== null && typeof secrets === "object" && secrets[name] !== undefined;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 规范化（上游同拍）
// ---------------------------------------------------------------------------

/**
 * @param {{maxConcurrency?: number, dailyRequests?: number}} limits
 */
function validateLimits(limits) {
  for (const [key, value] of Object.entries(limits)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new StoreError("invalid", `error: limit '${key}' must be a positive integer`);
    }
  }
}

/**
 * 路由表规范化：空表→undefined；prefix 补 / 去尾斜杠；pattern 编译校验。
 * @param {Array<Record<string, unknown>> | undefined} routes
 */
function normalizeRoutes(routes) {
  if (routes === undefined) return undefined;
  const cleaned = routes.filter((r) => r !== null && r !== undefined);
  if (cleaned.length === 0) return undefined;
  const out = [];
  for (const route of cleaned) {
    const forms = [...new Set(route.forms ?? [])];
    if (route.mode === "pattern") {
      const matchPattern = (route.matchPattern ?? "").trim();
      const template = (route.template ?? "").trim();
      if (matchPattern === "" || template === "") {
        throw new StoreError("invalid", "error: pattern route requires matchPattern and template");
      }
      try {
        compileMatchPattern(matchPattern);
      } catch (err) {
        throw new StoreError("invalid", `error: invalid matchPattern '${matchPattern}': ${err.message}`);
      }
      try {
        validateUriTemplate(template);
      } catch (err) {
        throw new StoreError("invalid", `error: invalid template '${template}': ${err.message}`);
      }
      out.push({ forms, mode: "pattern", matchPattern, template });
      continue;
    }
    let local = (route.localPrefix ?? "").trim();
    if (local !== "") {
      if (!local.startsWith("/")) local = `/${local}`;
      local = local.replace(/\/+$/, "");
    }
    if (local === "") local = ROUTE_LOCAL_PREFIX[forms[0] ?? "openai-chat"];
    let up = (route.upstreamPrefix ?? "").trim();
    if (up !== "") {
      if (!up.startsWith("/")) up = `/${up}`;
      up = up.replace(/\/+$/, "");
    }
    out.push({ forms, localPrefix: local, upstreamPrefix: up });
  }
  return out;
}

/**
 * @param {{host?: string, pathPrefixStrip?: string, pathPrefixAppend?: string}} rewrite
 */
function normalizeRewrite(rewrite) {
  const out = {};
  if (rewrite.host !== undefined) {
    if (rewrite.host.trim() === "") {
      throw new StoreError("invalid", "error: rewrite host must not be empty");
    }
    out.host = rewrite.host.trim();
  }
  for (const field of ["pathPrefixStrip", "pathPrefixAppend"]) {
    const value = rewrite[field];
    if (value === undefined) continue;
    const norm = value.startsWith("/") ? value : `/${value}`;
    if (norm === "/") {
      throw new StoreError("invalid", `error: rewrite ${field} must not be '/'`);
    }
    out[field] = norm;
  }
  return out;
}

/** ① auth 槽规范化（schema 复解析——$env: 形态在此构造期拒绝）。 */
function normalizeAuthSlot(auth) {
  if (auth === undefined) return undefined;
  const result = AUTH_SLOT_SCHEMA.safeParse(auth);
  if (!result.success) {
    throw new StoreError("invalid", `error: invalid auth slot: ${result.error.message}`);
  }
  return result.data;
}

/** ② headers 槽规范化（remove 去重小写；set 键小写化 last-wins）。 */
function normalizeHeadersSlot(slot) {
  if (slot === undefined) return undefined;
  const result = HEADERS_SLOT_SCHEMA.safeParse(slot);
  if (!result.success) {
    throw new StoreError("invalid", `error: invalid headers slot: ${result.error.message}`);
  }
  const parsed = result.data;
  const out = {};
  if (parsed.remove !== undefined) {
    out.remove = [...new Set(parsed.remove.map((n) => n.toLowerCase()))];
  }
  if (parsed.set !== undefined) {
    const set = {};
    for (const [name, value] of Object.entries(parsed.set)) {
      const lower = name.toLowerCase();
      if (lower === "") throw new StoreError("invalid", "error: headers set name must not be empty");
      set[lower] = value;
    }
    out.set = set;
  }
  if (parsed.script !== undefined) out.script = { ...parsed.script };
  return out;
}

/** ③/④ 脚本槽规范化（形状经 canonical schema 复解析）。 */
function normalizeScriptSlot(label, schema, slot) {
  if (slot === undefined) return undefined;
  const result = schema.safeParse(slot);
  if (!result.success) {
    throw new StoreError("invalid", `error: invalid ${label} slot: ${result.error.message}`);
  }
  return { ...result.data };
}
