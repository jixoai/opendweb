// adapted from ai-fly src/provider/hook.ts (v0.6.0)
// hooks 子系统（hooks-lifecycle v2 阶段化）——四段生命周期管线（顺序 =
// lifecycle.mjs STAGE_FN_NAMES）：
// - ① onRequestBearerAuthentication(ctx)：Authorization 头取值（返回裸值，
//   Bearer 前缀由 auth.bearer 拼）。三态返回契约：string | Promise<string> |
//   AsyncIterable<string>（订阅模式）。失败归 secret_missing 族。
// - ② onRequestHeaders(ctx)：返回 {set?, remove?} 增量；非法 → hook_failed。
// - ③ onRequest(ctx)：整体接管出站；返回 {status: 200..599, headers, body?}。
// - ④ onResponse(ctx)：响应后处理；返回 {status?, headers?, body?} 局部覆盖。
// ②③④ 缺席/抛错/形状非法 → HookStageError（hook_failed 族，消息脱敏固定文案）。
//
// 与 ai-fly 的有意分歧（design §4）：
// - 【资产模型】用户库 `<home>/plugins/ai/hooks/<name>.cjs`（上游
//   ~/.aifly/hooks）；内建库 `src/provider/hooks/<name>.cjs`（随包：secret、
//   file——**env.cjs 不存在**；codex.cjs 随后续 change ai-codex-oauth）。
// - 【env 二分法】HookCtx **无 env 访问器**（上游有）——插件自身代码路径
//   不经 env 取凭证；auth 路径 process.env fallback 删除。v1 hook 为宿主
//   进程内 require()（内核可信插件信任模型——hook 与宿主同权限，本 change
//   不宣称防御恶意 hook；文档明示此边界）。
// 信任模型照搬：脚本以宿主同权限执行 IO（无 VM 隔离）；模块经 require 缓存
// ——脚本文件修改需重启进程；值的动态性由 ① 三态契约承担。

import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { STAGE_FN_NAMES } from "./lifecycle.mjs";

export { STAGE_FN_NAMES };

// ---------------------------------------------------------------------------
// 预设模式解析（双模式裁决）
// ---------------------------------------------------------------------------

/**
 * 预设模式/自定义模式解析后的有效阶段绑定（消费面：rewrite ①② / upstream ③④）。
 * @typedef {Object} EffectiveLifecycleSlots
 * @property {import("./lifecycle.mjs").AuthSlot | undefined} auth
 * @property {{ name: string, args?: Record<string, string> } | undefined} headersScript
 * @property {{ script: string, args?: Record<string, string> } | undefined} request
 * @property {{ script: string, args?: Record<string, string> } | undefined} response
 */

/**
 * 生命周期双模式解析：自定义模式（逐槽）原样透传；预设模式（service.hooks）
 * 按 stages 矩阵逐阶段取该脚本导出。
 * @param {{ auth?: unknown, headers?: { script?: unknown }, request?: unknown, response?: unknown, hooks?: { script: string, args?: Record<string, string> } | undefined }} service
 * @param {{ home?: string, loader?: ((name: string, home: string) => Record<string, unknown> | undefined) }} [opts]
 * @returns {EffectiveLifecycleSlots}
 */
export function effectiveLifecycleSlots(service, opts = {}) {
  const preset = service.hooks;
  if (preset === undefined) {
    return {
      auth: service.auth,
      headersScript: service.headers?.script,
      request: service.request,
      response: service.response,
    };
  }
  const loader = opts.loader ?? loadHookScript;
  const home = opts.home ?? homedir();
  const mod = loader(preset.script, home);
  const stages = mod === undefined ? [] : stageFnsOf(mod);
  const args = preset.args;
  return {
    // 双模式同现（数据面不应出现——store 互斥校验）：逐槽优先（防御）。
    auth:
      service.auth !== undefined
        ? service.auth
        : stages.includes("onRequestBearerAuthentication")
          ? { script: preset.script, ...(args !== undefined ? { args } : {}) }
          : undefined,
    headersScript:
      service.headers?.script !== undefined
        ? service.headers.script
        : stages.includes("onRequestHeaders")
          ? { name: preset.script, ...(args !== undefined ? { args } : {}) }
          : undefined,
    request:
      service.request !== undefined
        ? service.request
        : stages.includes("onRequest")
          ? { script: preset.script, ...(args !== undefined ? { args } : {}) }
          : undefined,
    response:
      service.response !== undefined
        ? service.response
        : stages.includes("onResponse")
          ? { script: preset.script, ...(args !== undefined ? { args } : {}) }
          : undefined,
  };
}

// ---------------------------------------------------------------------------
// ctx 与错误
// ---------------------------------------------------------------------------

/**
 * 阶段 ctx（env 访问器不存在——与上游分歧，见文件头）。
 * @typedef {Object} HookCtx
 * @property {string} homedir
 * @property {Record<string, string>} args
 * @property {(name: string) => string | undefined} secrets
 * @property {string} [method]
 * @property {string} [path]
 * @property {Record<string, string>} [headers]
 */

/** ① auth 阶段脚本失效（secret_missing 族）：零上游请求；消息固定脱敏。 */
export class HookMissingError extends Error {
  constructor() {
    super("credential source missing");
    this.name = "HookMissingError";
  }
}

/** ②③④ 阶段脚本失效（hook_failed 族）统一脱敏文案。 */
const HOOK_STAGE_FAILED_MESSAGE = "hook stage failed";

export class HookStageError extends Error {
  constructor() {
    super(HOOK_STAGE_FAILED_MESSAGE);
    this.name = "HookStageError";
  }
}

/** ② 返回形状的 wire 帧资源上限（冻结：头数量 ≤32 / 键 ≤1KiB / 值 ≤8KiB）。 */
export const STAGE_HEADER_LIMITS = {
  maxCount: 32,
  nameMaxBytes: 1024,
  valueMaxBytes: 8192,
};

const BYTE_LEN = new TextEncoder();

/**
 * @param {string} value
 */
function byteLen(value) {
  return BYTE_LEN.encode(value).length;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {v is AsyncIterable<unknown>}
 */
function isAsyncIterableObj(v) {
  return v !== null && typeof v === "object" && Symbol.asyncIterator in v;
}

/**
 * @param {unknown} v
 * @returns {v is ReadableStream}
 */
function isReadableStreamLike(v) {
  return typeof ReadableStream === "function" && v instanceof ReadableStream;
}

// ---------------------------------------------------------------------------
// 脚本定位与加载（进程内 require——宿主信任模型）
// ---------------------------------------------------------------------------

/** 包根（向上找 name=@jixo/opendweb-ext-ai 的 package.json）。 */
function packageRoot(start = dirname(fileURLToPath(import.meta.url))) {
  let dir = resolve(start);
  for (let hops = 0; hops < 12; hops += 1) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8"));
        if (parsed !== null && typeof parsed === "object" && parsed.name === "@jixo/opendweb-ext-ai") {
          return dir;
        }
      } catch {
        /* 损坏 package.json——继续向上 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * hooks 脚本两库路径（用户库优先）。
 * @param {string} [home]
 */
export function hookScriptPaths(home = homedir()) {
  return {
    userDir: join(home, "plugins", "ai", "hooks"),
    builtinDir: join(packageRoot(), "src", "provider", "hooks"),
  };
}

/**
 * @param {string} name
 * @param {{ userDir: string, builtinDir: string }} paths
 */
function scriptCandidates(name, paths) {
  const bases = [join(paths.userDir, name), join(paths.builtinDir, name)];
  const out = [];
  for (const b of bases) {
    out.push(`${b}.cjs`);
  }
  return out;
}

const require_ = createRequire(import.meta.url);

/**
 * 加载 hooks 脚本（进程内 require——缓存语义：脚本文件修改需重启进程；
 * 用户库优先于内建库）。加载失败/不存在 → undefined。
 * @param {string} name
 * @param {string} [home]
 * @returns {Record<string, unknown> | undefined}
 */
export function loadHookScript(name, home = homedir()) {
  if (!validHookName(name)) return undefined;
  const paths = hookScriptPaths(home);
  for (const candidate of scriptCandidates(name, paths)) {
    if (!existsSync(candidate)) continue;
    try {
      return require_(candidate);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 脚本名合法性（资源标识符；防路径逃逸）。 */
export function validHookName(name) {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(name);
}

/**
 * @param {string} name
 * @param {string} [home]
 */
export function userHookPath(name, home = homedir()) {
  return join(hookScriptPaths(home).userDir, `${name}.cjs`);
}

/**
 * 模块导出面的阶段函数矩阵（按 STAGE_FN_NAMES 顺序过滤 typeof function）。
 * @param {Record<string, unknown>} mod
 * @returns {string[]}
 */
export function stageFnsOf(mod) {
  return STAGE_FN_NAMES.filter((name) => typeof mod[name] === "function");
}

/**
 * 枚举可用 hooks 脚本及其阶段矩阵（用户库优先；内建同名被覆盖不重复列出）。
 * @param {string} [home]
 */
export function discoverHooks(home = homedir()) {
  const paths = hookScriptPaths(home);
  /** @param {string} dir @returns {string[]} */
  const dirScriptNames = (dir) => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".cjs"))
        .map((f) => f.slice(0, -".cjs".length));
    } catch {
      return [];
    }
  };
  const seen = new Map();
  for (const name of dirScriptNames(paths.userDir)) {
    const mod = loadHookScript(name, home);
    if (mod === undefined) continue;
    seen.set(name, {
      name,
      source: "user",
      fns: Object.keys(mod).filter((k) => typeof mod[k] === "function"),
      stages: stageFnsOf(mod),
    });
  }
  for (const name of dirScriptNames(paths.builtinDir)) {
    if (seen.has(name)) continue;
    const mod = loadHookScript(name, home);
    if (mod === undefined) continue;
    seen.set(name, {
      name,
      source: "builtin",
      fns: Object.keys(mod).filter((k) => typeof mod[k] === "function"),
      stages: stageFnsOf(mod),
    });
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 预设模式绑定校验：脚本必须导出至少一个阶段函数。
 * @param {string} name
 * @param {{ home?: string, loader?: (name: string, home: string) => Record<string, unknown> | undefined }} [opts]
 */
export function scriptHasStageExports(name, opts = {}) {
  const loader = opts.loader ?? loadHookScript;
  const mod = loader(name, opts.home ?? homedir());
  return mod !== undefined && stageFnsOf(mod).length > 0;
}

// ---------------------------------------------------------------------------
// 三态取值（① 拉取 / 订阅——唯一保留订阅语义的契约）
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @returns {v is AsyncIterable<string>}
 */
function isAsyncIterable(v) {
  return v !== null && typeof v === "object" && Symbol.asyncIterator in v;
}

const subscriptions = new Map();

/**
 * 建立订阅并等待首个 yield：返回首值（后续值由后台循环更新 latest）。
 * @param {AsyncIterable<string>} stream
 * @param {{ latest?: string, iterator?: AsyncIterator<string> }} sub
 * @returns {Promise<string | undefined>}
 */
function startSubscription(stream, sub) {
  sub.iterator = stream[Symbol.asyncIterator]();
  return new Promise((resolveFirst) => {
    let firstSettled = false;
    void (async () => {
      try {
        const it = sub.iterator;
        for (;;) {
          const r = await it.next();
          if (r.done === true) break;
          if (typeof r.value === "string" && r.value !== "") {
            sub.latest = r.value;
            if (firstSettled === false) {
              firstSettled = true;
              resolveFirst(r.value);
            }
          }
        }
      } catch {
        /* 迭代出错：保留最后有效值（错误不外泄脚本细节） */
      }
      if (firstSettled === false) {
        firstSettled = true;
        resolveFirst(undefined);
      }
    })();
  });
}

/**
 * 回收全部订阅（dispose/测试收尾）。return() 对挂起在内部 await 的生成器可能
 * 永不结算——300ms 竞速后放弃该迭代器。
 */
export async function disposeHookSubscriptions() {
  const subs = [...subscriptions.entries()];
  subscriptions.clear();
  await Promise.all(
    subs.map(async ([, sub]) => {
      try {
        await Promise.race([
          sub.iterator?.return?.(undefined) ?? Promise.resolve(),
          new Promise((r) => setTimeout(r, 300)),
        ]);
      } catch {
        /* 终止失败不阻塞回收 */
      }
    }),
  );
}

/**
 * 解析一次钩子取值（① 阶段函数）。订阅键 = home|script|fn。任何未命中
 * （脚本/函数缺席、调用抛错、非字符串、空串、订阅未出首值）抛
 * HookMissingError（零上游请求；信息不含脚本路径与值）。
 * @param {string} fnName
 * @param {{ script: string, home?: string, args?: Record<string, string>, secrets?: (name: string) => string | undefined, request?: { method: string, path: string, headers: Record<string, string> }, loader?: (name: string, home: string) => Record<string, unknown> | undefined }} opts
 * @returns {Promise<string>}
 */
export async function resolveHookValue(fnName, opts) {
  const home = opts.home ?? homedir();
  // 订阅键含 home 作用域（多实例/跨 HOME 测试不串订阅缓存）。
  const key = `${home}|${opts.script}|${fnName}`;
  const loader = opts.loader ?? loadHookScript;
  const mod = loader(opts.script, home);
  const raw = mod?.[fnName];
  if (typeof raw !== "function") throw new HookMissingError();
  /** @type {import("./hooks.mjs").HookCtx} */
  const ctx = {
    homedir: home,
    args: opts.args ?? {},
    secrets: (n) => opts.secrets?.(n),
    ...(opts.request !== undefined
      ? { method: opts.request.method, path: opts.request.path, headers: { ...opts.request.headers } }
      : {}),
  };
  let result;
  try {
    result = raw(ctx);
  } catch {
    throw new HookMissingError();
  }
  if (isAsyncIterable(result)) {
    let sub = subscriptions.get(key);
    if (sub === undefined) {
      sub = {};
      subscriptions.set(key, sub);
      const first = await startSubscription(result, sub);
      if (first === undefined) throw new HookMissingError();
      return first;
    }
    if (sub.latest === undefined) throw new HookMissingError();
    return sub.latest;
  }
  let awaited;
  try {
    awaited = await result;
  } catch {
    // Promise 拒绝与同步抛错同族归一（不外泄脚本原始异常）
    throw new HookMissingError();
  }
  if (typeof awaited !== "string" || awaited === "") throw new HookMissingError();
  return awaited;
}

// ---------------------------------------------------------------------------
// 阶段解析器（纯函数层：调用 + 形状校验 + 错误分族）
// ---------------------------------------------------------------------------

/**
 * 阶段解析共用基础面（脚本加载 + 基础 ctx 源 + 测试注入；env 不存在）。
 * @typedef {Object} StageResolveBase
 * @property {string} [home]
 * @property {((name: string) => string | undefined)} [secrets]
 * @property {((name: string, home: string) => Record<string, unknown> | undefined)} [loader]
 */

/**
 * @param {string} scriptName
 * @param {string} fnName
 * @param {StageResolveBase} base
 * @param {string} home
 */
function loadStageFn(scriptName, fnName, base, home) {
  const loader = base.loader ?? loadHookScript;
  const mod = loader(scriptName, home);
  const raw = mod?.[fnName];
  if (typeof raw !== "function") throw new HookStageError();
  return raw;
}

/**
 * 阶段脚本的基础 ctx 面（③④ 调用壳共用；无 env——与上游分歧）。
 * @param {StageResolveBase} base
 * @param {{ name?: string, args?: Record<string, string> }} binding
 * @param {string} home
 */
function stageBaseCtx(base, binding, home) {
  return {
    homedir: home,
    args: binding.args ?? {},
    secrets: (n) => base.secrets?.(n),
  };
}

/**
 * ① onRequestBearerAuthentication：auth 槽脚本绑定取值（裸值）。三态契约
 * 平移保留；任何失效归 secret_missing 族（HookMissingError）。
 * @param {{ script: string, args?: Record<string, string> }} binding
 * @param {StageResolveBase & { request?: { method: string, path: string, headers: Record<string, string> } }} [opts]
 */
export async function resolveStageAuth(binding, opts = {}) {
  try {
    return await resolveHookValue("onRequestBearerAuthentication", {
      script: binding.script,
      ...(binding.args !== undefined ? { args: binding.args } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
      ...(opts.request !== undefined ? { request: opts.request } : {}),
      ...(opts.loader !== undefined ? { loader: opts.loader } : {}),
    });
  } catch (err) {
    // ① 失败族归一：不外泄任何脚本细节。
    throw err instanceof HookMissingError ? err : new HookMissingError();
  }
}

/**
 * ② onRequestHeaders：headers 槽整段脚本调用与返回形状校验。
 * 返回 {set?, remove?}；绑定缺席/抛错/形状非法/上限超限 → HookStageError。
 * @param {{ name: string, args?: Record<string, string> }} binding
 * @param {{ method: string, path: string, headers: Record<string, string> }} request
 * @param {StageResolveBase} [base]
 * @returns {Promise<{ set?: Record<string, string>, remove?: string[] }>}
 */
export async function resolveStageHeaders(binding, request, base = {}) {
  const home = base.home ?? homedir();
  const fn = loadStageFn(binding.name, "onRequestHeaders", base, home);
  let returned;
  try {
    returned = await fn({
      ...stageBaseCtx(base, binding, home),
      method: request.method,
      path: request.path,
      headers: { ...request.headers },
    });
  } catch {
    throw new HookStageError();
  }
  if (!isPlainObject(returned)) throw new HookStageError();
  // 顶层键 strict（拼错若被宽容吞掉会静默 no-op——未知键一律 hook_failed）。
  for (const key of Object.keys(returned)) {
    if (key !== "set" && key !== "remove") throw new HookStageError();
  }
  const out = {};
  if (returned.remove !== undefined) {
    if (!Array.isArray(returned.remove)) throw new HookStageError();
    if (returned.remove.length > STAGE_HEADER_LIMITS.maxCount) throw new HookStageError();
    const remove = [];
    for (const name of returned.remove) {
      if (typeof name !== "string" || name === "" || byteLen(name) > STAGE_HEADER_LIMITS.nameMaxBytes) {
        throw new HookStageError();
      }
      remove.push(name);
    }
    out.remove = remove;
  }
  if (returned.set !== undefined) {
    if (!isPlainObject(returned.set)) throw new HookStageError();
    const entries = Object.entries(returned.set);
    if (entries.length > STAGE_HEADER_LIMITS.maxCount) throw new HookStageError();
    const set = {};
    for (const [name, value] of entries) {
      if (
        name === "" ||
        byteLen(name) > STAGE_HEADER_LIMITS.nameMaxBytes ||
        typeof value !== "string" ||
        byteLen(value) > STAGE_HEADER_LIMITS.valueMaxBytes
      ) {
        throw new HookStageError();
      }
      set[name] = value;
    }
    out.set = set;
  }
  return out;
}

/** 中继档头限额（③④ 返回的 headers：≤128 头 / 值 ≤16KiB——上游同拍）。 */
const RELAY_HEADER_LIMITS = { maxCount: 128, valueMaxBytes: 16 * 1024 };

/**
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
function validateStageHeaders(headers) {
  if (!isPlainObject(headers)) throw new HookStageError();
  const entries = Object.entries(headers);
  if (entries.length > RELAY_HEADER_LIMITS.maxCount) throw new HookStageError();
  const out = {};
  for (const [name, value] of entries) {
    if (
      name === "" ||
      byteLen(name) > STAGE_HEADER_LIMITS.nameMaxBytes ||
      typeof value !== "string" ||
      byteLen(value) > RELAY_HEADER_LIMITS.valueMaxBytes
    ) {
      throw new HookStageError();
    }
    out[name] = value;
  }
  return out;
}

/**
 * @param {unknown} body
 * @returns {ReadableStream | AsyncIterable | undefined}
 */
function validateStageBody(body) {
  if (body === undefined || body === null) return undefined;
  if (isReadableStreamLike(body) || isAsyncIterableObj(body)) {
    return body;
  }
  throw new HookStageError();
}

/**
 * ③ onRequest：request 槽脚本调用壳（整体接管出站）。返回
 * {status: 200..599, headers, body?}（body 缺省=空流；1xx/6xx 越界即非法）。
 * @param {{ name: string, args?: Record<string, string> }} binding
 * @param {{ url: string, method: string, headers: Record<string, string>, body: Uint8Array, signal: AbortSignal }} ctx
 * @param {StageResolveBase} [base]
 */
export async function resolveStageRequest(binding, ctx, base = {}) {
  const home = base.home ?? homedir();
  const fn = loadStageFn(binding.name, "onRequest", base, home);
  let returned;
  try {
    returned = await fn({
      ...stageBaseCtx(base, binding, home),
      url: ctx.url,
      method: ctx.method,
      headers: { ...ctx.headers },
      body: ctx.body,
      signal: ctx.signal,
    });
  } catch {
    throw new HookStageError();
  }
  if (!isPlainObject(returned)) throw new HookStageError();
  for (const key of Object.keys(returned)) {
    if (key !== "status" && key !== "headers" && key !== "body") throw new HookStageError();
  }
  const status = returned.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
    throw new HookStageError();
  }
  const headers = validateStageHeaders(returned.headers);
  const body = validateStageBody(returned.body);
  return { status, headers, ...(body !== undefined ? { body } : {}) };
}

/**
 * ④ onResponse：response 槽脚本调用壳（局部覆盖 status/headers/body）。
 * @param {{ name: string, args?: Record<string, string> }} binding
 * @param {{ status: number, headers: Record<string, string>, body: AsyncIterable<Uint8Array>, signal: AbortSignal }} ctx
 * @param {StageResolveBase} [base]
 * @returns {Promise<{ status?: number, headers?: Record<string, string>, body?: ReadableStream | AsyncIterable }>}
 */
export async function resolveStageResponse(binding, ctx, base = {}) {
  const home = base.home ?? homedir();
  const fn = loadStageFn(binding.name, "onResponse", base, home);
  let returned;
  try {
    returned = await fn({
      ...stageBaseCtx(base, binding, home),
      status: ctx.status,
      headers: { ...ctx.headers },
      body: ctx.body,
      signal: ctx.signal,
    });
  } catch {
    throw new HookStageError();
  }
  if (!isPlainObject(returned)) throw new HookStageError();
  for (const key of Object.keys(returned)) {
    if (key !== "status" && key !== "headers" && key !== "body") throw new HookStageError();
  }
  const out = {};
  if (returned.status !== undefined) {
    const status = returned.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
      throw new HookStageError();
    }
    out.status = status;
  }
  if (returned.headers !== undefined) {
    out.headers = validateStageHeaders(returned.headers);
  }
  const body = validateStageBody(returned.body);
  if (body !== undefined) out.body = body;
  return out;
}

// ---------------------------------------------------------------------------
// 用户库管理面（install/remove/read——同步；与上游同拍）
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {string} content
 * @param {string} [home]
 */
export function installUserHook(name, content, home = homedir()) {
  if (!validHookName(name)) {
    return { ok: false, error: "hook name must match /^[a-z][a-z0-9_-]{0,63}$/" };
  }
  const dir = hookScriptPaths(home).userDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = userHookPath(name, home);
  writeFileSync(path, content, { mode: 0o600 });
  return { ok: true, path };
}

/**
 * @param {string} name
 * @param {string} [home]
 */
export function removeUserHook(name, home = homedir()) {
  const path = userHookPath(name, home);
  rmSync(path, { force: true });
  return { path };
}

/**
 * @param {string} name
 * @param {string} [home]
 */
export function readHookScript(name, home = homedir()) {
  if (!validHookName(name)) return undefined;
  const user = userHookPath(name, home);
  if (existsSync(user)) {
    try {
      return { path: user, source: "user", content: readFileSync(user, "utf8") };
    } catch {
      return undefined;
    }
  }
  const builtin = join(hookScriptPaths(home).builtinDir, `${name}.cjs`);
  if (existsSync(builtin)) {
    try {
      return { path: builtin, source: "builtin", content: readFileSync(builtin, "utf8") };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
