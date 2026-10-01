// adapted from ai-fly src/provider/rewrite.ts (v0.6.0)
// 上游请求构造：请求描述 → 最终上游 URL + 转发头集 + Host 值。
// 头链固定顺序（hooks-lifecycle 冻结）：入站剥离（DEFENSIVE_STRIP）→ ① auth
// 值注入（service.auth 三族：secret 经密钥库 / script 走 resolveStageAuth /
// literal 间接引用[仅 $secret:]；bearer 开关拼 Bearer 前缀且已带不重复）→
// headers.remove（声明）→ headers.set（声明，字面量 $secret: 间接引用）→
// ② 整段脚本增量（resolveStageHeaders，脚本 remove 后 set、脚本胜）→ 防护头
// 再过滤（host/hop-by-hop/content-length 规则重放）。同名头 last-wins。
//
// 【与 ai-fly 的有意分歧（design §4——env 二分法）】
// - **`$env:` 引用族删除**：上游 resolveLiteralHeaderValue 的 `$env:<VAR>`
//   分支与 buildUpstreamRequest 的 env 参数/process.env 缺省整体不存在——
//   插件自身代码路径不经 env 取凭证；literal 间接引用仅 `$secret:`。
// - `$file:`/`$script:` 凭据引用族不移植（文件取值经 `{script:"file"}` 槽，
//   与上游 file 族同语义）。
// 照搬：SSR 防线（上游 URL 目标仅来自本地服务配置；拼接规范化后双重断言
// origin 一致+基础路径前缀，任一不成立抛 RewriteError 且零上游请求）；Host
// 头由服务配置决定（缺省上游 host，rewrite.host 覆盖），MUST NOT 来自请求内；
// `$secret:<name>` 每请求从密钥库解析（未命中抛 SecretMissingError →
// secret_missing，不回退空值、不带引用名出网）。

import { FORBIDDEN_REQ_HEADER_NAMES } from "../wire/schemas.mjs";
import { routeLocalPrefix } from "./store.mjs";
import { compileMatchPattern, matchRequestPath } from "./match-pattern.mjs";
import { expandUriTemplate } from "./uri-template.mjs";
import { parseUpstreamUrl } from "./store.mjs";
import { effectiveLifecycleSlots, resolveStageAuth, resolveStageHeaders } from "./hooks.mjs";
import { SECRET_REF_PREFIX, ENV_REF_PREFIX } from "./lifecycle.mjs";

export { SECRET_REF_PREFIX, ENV_REF_PREFIX };

/** 拼接/断言失败（protocol_error 语义）。 */
export class RewriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "RewriteError";
  }
}

/**
 * 服务声明了路由表但请求路径未命中任何标准前缀（path_not_offered 语义）：
 * 只转发声明的 API 标准面——防 /user、/balance 等个人信息端点被提供方凭据
 * 打穿（路由表即白名单——上游 Owner 2026-09-10 裁决照搬）。
 */
export class PathNotOfferedError extends Error {
  constructor() {
    super("path is not offered by this service");
    this.name = "PathNotOfferedError";
  }
}

/**
 * `$secret:<name>` 引用未命中（secret_missing 语义）：该请求拒绝。
 * message 固定——MUST NOT 包含密钥名与值（错误会过网）。
 */
export class SecretMissingError extends Error {
  constructor() {
    super("referenced secret is missing");
    this.name = "SecretMissingError";
  }
}

/**
 * 密钥读取面（name -> value；未命中 undefined——由解析层升级为错误）。
 * @typedef {(name: string) => string | undefined} SecretSource
 */

/**
 * 出站计划。
 * @typedef {Object} UpstreamPlan
 * @property {URL} url
 * @property {Record<string, string>} headers
 * @property {string} host
 * @property {boolean} isWebSocketUpgrade
 */

/**
 * ①② 脚本阶段的加载面（home 基准 + 测试注入缝）。
 * @typedef {Object} LifecycleHookOptions
 * @property {string} [home]
 * @property {((name: string, home: string) => Record<string, unknown> | undefined)} [loader]
 */

/** Bearer 前缀拼接（auth 槽 bearer 唯一来源；默认拼；已带 Bearer 不重复）。 */
export function applyBearerPrefix(value, bearer) {
  if (bearer === false) return value;
  return /^Bearer\s/i.test(value) ? value : `Bearer ${value}`;
}

/**
 * ① auth 槽取值（三族单选）：secret → 密钥库原样值（未命中/空 →
 * SecretMissingError，secret_missing 族）；script → resolveStageAuth 三态契约
 * （失效抛 HookMissingError）；literal → `$secret:` 间接引用解析（未命中 →
 * SecretMissingError）/原样字面量。返回值已按 bearer 开关拼前缀。
 * 【env 分支不存在——与上游分歧】
 * @param {Record<string, any>} auth
 * @param {{ method: string, path: string, headers: Record<string, string>, secrets?: SecretSource }} ctx
 * @param {LifecycleHookOptions} [hooks]
 */
export async function resolveAuthSlotValue(auth, ctx, hooks = {}) {
  let value;
  if ("secret" in auth) {
    value = ctx.secrets?.(auth.secret);
    if (value === undefined || value === "") throw new SecretMissingError();
  } else if ("script" in auth) {
    value = await resolveStageAuth(
      { script: auth.script, ...(auth.args !== undefined ? { args: auth.args } : {}) },
      {
        request: { method: ctx.method, path: ctx.path, headers: ctx.headers },
        ...(ctx.secrets !== undefined ? { secrets: ctx.secrets } : {}),
        ...(hooks.home !== undefined ? { home: hooks.home } : {}),
        ...(hooks.loader !== undefined ? { loader: hooks.loader } : {}),
      },
    );
  } else {
    value = resolveLiteralHeaderValue(auth.literal, ctx.secrets);
  }
  return applyBearerPrefix(value, auth.bearer);
}

/**
 * headers.set / auth.literal 字面量值解析（**仅 `$secret:` 间接引用**——
 * `$env:` 形态在 store 构造期已拒绝，本函数遇之按防御处理：视为缺失拒绝）：
 * - `$secret:<name>`：每请求从密钥库解析（未命中 → SecretMissingError）；
 * - 空串 = 省略该头；其余字面量原样。
 * @param {string} value
 * @param {SecretSource | undefined} secrets
 */
export function resolveLiteralHeaderValue(value, secrets) {
  if (value === "") return undefined;
  if (value.startsWith(ENV_REF_PREFIX)) {
    // 纵深防御：store 层已构造期拒绝；到达此处=手写文件绕过——按缺失拒绝。
    throw new SecretMissingError();
  }
  if (value.startsWith(SECRET_REF_PREFIX)) {
    const resolved = secrets?.(value.slice(SECRET_REF_PREFIX.length));
    if (resolved === undefined || resolved === "") throw new SecretMissingError();
    return resolved;
  }
  return value;
}

/** HTTP hop-by-hop / 传输层自管头。 */
export const HOP_BY_HOP_HEADER_NAMES = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

/** 请求内头防御性剥离集合（wire schema 已拒绝；此处纵深防御）。 */
const DEFENSIVE_STRIP = new Set([
  ...FORBIDDEN_REQ_HEADER_NAMES,
  ...HOP_BY_HOP_HEADER_NAMES,
  "content-length",
]);

/**
 * 防护头再过滤集（头链末段重放）：host（服务配置决定，绝不出自头链产物）、
 * hop-by-hop、content-length（fetch/上游自管分帧）。不含 authorization——
 * ① auth 注入的产物必须存活到出站。
 */
const GUARD_STRIP = new Set([...HOP_BY_HOP_HEADER_NAMES, "host", "content-length"]);

// ---------------------------------------------------------------------------
// 路径处理
// ---------------------------------------------------------------------------

/** 点段规范化（".", ".." 解析；不越出根，前缀断言兜底）。 */
function normalizeDotSegments(path) {
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * @param {string} raw
 * @returns {{ path: string, query: string }}
 */
function splitQuery(raw) {
  const idx = raw.indexOf("?");
  return idx < 0 ? { path: raw, query: "" } : { path: raw.slice(0, idx), query: raw.slice(idx + 1) };
}

/** 查询值解码（畸形序列原样保留；模板会重新编码）。 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

/** 查询串 → 变量表（pattern 模板变量域；同名捕获组优先覆盖）。 */
function parseQueryVars(query) {
  const vars = {};
  if (query === "") return vars;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      if (pair !== "") vars[pair] = "";
      continue;
    }
    vars[pair.slice(0, eq)] = safeDecode(pair.slice(eq + 1));
  }
  return vars;
}

/** 请求内 path 的纵深防御检查（schema 层已拒；双保险）。 */
function assertFramePathShape(path) {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new RewriteError("request path must start with a single '/'");
  }
  if (path.includes("\\")) {
    throw new RewriteError("request path must not contain backslash");
  }
  const pathPart = splitQuery(path).path;
  if (pathPart.includes("://")) {
    throw new RewriteError("request path must not contain a scheme");
  }
  for (const seg of pathPart.split("/").slice(1)) {
    if (seg === "." || seg === "..") {
      throw new RewriteError("request path must not contain '.' or '..' segments");
    }
  }
}

// ---------------------------------------------------------------------------
// WS 升级识别（v1 不透传 WS——检测保留供 forward 层显式拒绝）
// ---------------------------------------------------------------------------

/** connection 头 token 列表包含 upgrade 且 upgrade 头为 websocket（大小写不敏感）。 */
export function isWebSocketUpgradeRequest(headers) {
  const connection = headers["connection"];
  const upgrade = headers["upgrade"];
  if (connection === undefined || upgrade === undefined) return false;
  const tokens = connection.split(",").map((t) => t.trim().toLowerCase());
  return tokens.includes("upgrade") && upgrade.trim().toLowerCase() === "websocket";
}

// ---------------------------------------------------------------------------
// 主构造
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} service
 * @param {{ method: string, path: string, headers?: Record<string, string>, contentType?: string }} req
 * @param {SecretSource | undefined} [secrets]
 * @param {LifecycleHookOptions} [hooks]
 * @returns {Promise<UpstreamPlan>}
 */
export async function buildUpstreamRequest(service, req, secrets, hooks = {}) {
  const upstream = parseUpstreamUrl(service.upstream);

  // 1) path：防御性形状检查 → 路径路由（按声明顺序命中，先声明先匹配）→
  //    前缀剥离 → 前缀追加 → 基础路径拼接 → 点段规范化。路由改写优先于
  //    服务级 strip/append。
  assertFramePathShape(req.path);
  const split = splitQuery(req.path);
  let requestPath = split.path;
  let query = split.query;
  if (service.routes !== undefined && service.routes.length > 0) {
    let matched = false;
    for (const route of service.routes) {
      if (route.mode === "pattern") {
        const groups = matchRequestPath(compileMatchPattern(route.matchPattern), requestPath, query);
        if (groups === null) continue;
        // 变量 = URLPattern 捕获组 + 请求查询参数；模板产物含查询串则替换之
        const vars = { ...parseQueryVars(query), ...groups };
        const assembled = expandUriTemplate(route.template, vars);
        const qIdx = assembled.indexOf("?");
        if (qIdx >= 0) {
          requestPath = assembled.slice(0, qIdx);
          query = assembled.slice(qIdx + 1);
        } else {
          requestPath = assembled;
        }
        matched = true;
        break;
      }
      const local = routeLocalPrefix(route);
      const hit = requestPath === local || requestPath.startsWith(local + "/");
      if (!hit) continue;
      const rest = requestPath.slice(local.length); // "" | "/..."
      const up = route.upstreamPrefix ?? "";
      requestPath = rest === "" ? (up === "" ? "/" : up) : `${up}${rest}`;
      matched = true;
      break;
    }
    if (!matched) {
      // 路由表 = 白名单：未声明的路径一律拒绝（个人信息端点保护）。
      throw new PathNotOfferedError();
    }
  }
  const strip = service.rewrite?.pathPrefixStrip;
  if (strip !== undefined && (requestPath === strip || requestPath.startsWith(strip + "/"))) {
    // 仅在段边界剥离（strip=/a 命中 /a 与 /a/...，不误伤 /ab）。
    requestPath = requestPath.slice(strip.length);
    if (requestPath === "") requestPath = "/";
  }
  const append = service.rewrite?.pathPrefixAppend;
  if (append !== undefined) {
    const appendNormalized = normalizeDotSegments(append).replace(/\/+$/, "");
    if (appendNormalized !== "") {
      requestPath = appendNormalized + (requestPath === "/" ? "/" : requestPath);
    }
  }
  const basePath = upstream.pathname === "" ? "/" : upstream.pathname;
  const baseNormalized = normalizeDotSegments(basePath);
  const combined =
    baseNormalized === "/" ? requestPath : `${baseNormalized.replace(/\/+$/, "")}${requestPath}`;
  const finalPath = normalizeDotSegments(combined);

  // 2) 双重断言：origin 一致 + 规范化路径以基础路径为前缀（失败零上游请求）。
  let url;
  try {
    url = new URL(finalPath + (query === "" ? "" : `?${query}`), upstream);
  } catch {
    throw new RewriteError("cannot build upstream URL from service config and request path");
  }
  if (url.origin !== upstream.origin) {
    throw new RewriteError(`upstream origin assertion failed (${url.origin} != ${upstream.origin})`);
  }
  if (!pathHasPrefix(finalPath, baseNormalized)) {
    throw new RewriteError("upstream base path prefix assertion failed");
  }

  // 3) 头链（固定顺序；①② 脚本 ctx 携请求级 method/path/headers）。
  const headers = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (DEFENSIVE_STRIP.has(name)) continue;
    headers[name] = value;
  }
  // contentType 折叠（请求内独立字段 → content-type 头；后续 remove/set/脚本
  // 增量可覆盖或移除）。
  if (req.contentType !== undefined && req.contentType !== "") {
    headers["content-type"] = req.contentType;
  }
  // ① auth 值注入（secret_missing 族失效在此抛出：零上游请求）。双模式解析：
  // 预设模式（service.hooks）下 auth = 该脚本的 ① 导出（缺导出即无注入）。
  const eff = effectiveLifecycleSlots(service, {
    ...(hooks.home !== undefined ? { home: hooks.home } : {}),
    ...(hooks.loader !== undefined ? { loader: hooks.loader } : {}),
  });
  if (eff.auth !== undefined) {
    const authValue = await resolveAuthSlotValue(
      eff.auth,
      { method: req.method, path: req.path, headers: { ...headers }, secrets },
      hooks,
    );
    if (authValue !== undefined) headers["authorization"] = authValue;
  }
  for (const name of service.headers?.remove ?? []) {
    delete headers[name];
  }
  const headerSet = service.headers?.set;
  if (headerSet !== undefined) {
    for (const [name, value] of Object.entries(headerSet)) {
      // $secret 未命中在此抛 SecretMissingError（上游 catch 映射 secret_missing）。
      const resolved = resolveLiteralHeaderValue(value, secrets);
      if (resolved === undefined) continue;
      headers[name] = resolved;
    }
  }
  // ② 整段脚本增量（绑定声明但导出缺失/抛错/形状非法 → HookStageError）；
  // 脚本 remove 后 set——脚本胜。预设模式下 headersScript = 该脚本的 ② 导出。
  const headersScript = eff.headersScript;
  if (headersScript !== undefined) {
    const increment = await resolveStageHeaders(
      { name: headersScript.name, ...(headersScript.args !== undefined ? { args: headersScript.args } : {}) },
      { method: req.method, path: req.path, headers: { ...headers } },
      {
        ...(secrets !== undefined ? { secrets } : {}),
        ...(hooks.home !== undefined ? { home: hooks.home } : {}),
        ...(hooks.loader !== undefined ? { loader: hooks.loader } : {}),
      },
    );
    for (const name of increment.remove ?? []) {
      delete headers[name.toLowerCase()];
    }
    for (const [name, value] of Object.entries(increment.set ?? {})) {
      headers[name.toLowerCase()] = value;
    }
  }
  // 防护头再过滤：任何链段都不得引入 host/hop-by-hop/content-length
  // （规则重放；authorization 不在此列——① 的产物存活）。
  for (const name of Object.keys(headers)) {
    if (GUARD_STRIP.has(name)) delete headers[name];
  }

  // 4) Host：缺省上游 host（URL.host 已按缺省端口省略端口），rewrite 覆盖。
  const host = service.rewrite?.host ?? upstream.host;

  return { url, headers, host, isWebSocketUpgrade: isWebSocketUpgradeRequest(req.headers ?? {}) };
}

/** 段边界前缀判定：base 为根恒真；否则 final === base 或以 base/ 开头。 */
function pathHasPrefix(finalPath, basePath) {
  if (basePath === "/" || basePath === "") return true;
  if (finalPath === basePath) return true;
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return finalPath.startsWith(`${base}/`);
}
