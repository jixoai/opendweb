// WebUI 插件契约 webuiApi 1（webui-plugin-kernel Phase 0 / specs/webui delta
// 「WebUI 插件宿主与插件面板」字段集冻结）。
// 意图（2026-09-29）：
// 1. 契约独立于 CLI ./opendweb-plugin（apiVersion 1 零变化，design §2.1 [P6]）：
//    WebUI 插件包在新 export 子路径 `./opendweb-webui-plugin` 导出本契约的
//    descriptor（webuiApi 1：id/pages/routes/dataEndpoints/configSchema）。
//    Phase 0 宿主只静态注册编译内置的 ports/files/sync 占位 descriptor——
//    第一个真实导出该子路径的 workspace 包在 Phase 1（@jixo/opendweb-ext-ports）。
//    本模块即该子路径的契约类型与校验的唯一权威源（宿主与插件包共用）。
// 2. 校验器零运行时依赖（node 标准库都不需要——与 sidecar「零依赖」纪律同拍；
//    不引入 zod：webui 包不依赖 zod）。
// 3. 信任模型=v1 可信插件（design §2.1）：校验是形状门，不是沙箱——manifest
//    safeParse 不能约束已信任代码的运行时行为（既有事实，文档明示）。
// 4. configSchema=JSON Schema 子集（object + string/number/boolean 属性 +
//    required）——与 CLI plugin-contract CommandSpec args 同族；config 值校验
//    （validatePluginConfig）供控制面 PUT /sidecar/plugins/<id>/config 复用。

/** WebUI 插件契约版本（破坏性变更走 2） */
export const WEBUI_PLUGIN_API = 1;

/** id/page/route 字符集：小写字母开头 + 小写字母数字连字符（与 CLI 插件名同族） */
const ID_RE = /^[a-z][a-z0-9-]*$/;

/** 页面视角可见性（admin=中枢管理姿态；member=成员姿态；both=两态皆可见） */
const PERSPECTIVES = new Set(["admin", "member", "both"]);
/** 页型：settings=通用 renderer（简单配置/表格页）；page=插件专属 Svelte 组件 */
const PAGE_TYPES = new Set(["settings", "page"]);
/** 导航区（v1 只有 SideNav「工具」区） */
const NAV_AREAS = new Set(["tools"]);

/** 标题/文案上限（UTF-16 码元；展示面防滥用） */
const TITLE_MAX = 64;
/** 属性键上限 */
const KEY_MAX = 64;

/**
 * @param {string} name
 * @returns {boolean} 属性键：字母开头 + 字母数字连字符下划线（CLI args 同族）
 */
function isPropertyName(name) {
  return typeof name === "string" && name !== "" && name.length <= KEY_MAX && /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验 configSchema（JSON Schema 子集：{type:"object", properties:{name:{type}},
 * required?:[name]}）。未知键拒绝（字段集冻结——严格读法）。
 * @param {unknown} schema
 * @returns {true | string} 错误信息（true=通过）
 */
function checkConfigSchema(schema) {
  if (!isPlainObject(schema)) return "configSchema must be an object";
  for (const key of Object.keys(schema)) {
    if (key !== "type" && key !== "properties" && key !== "required") return `configSchema has unknown field "${key}"`;
  }
  if (schema.type !== "object") return 'configSchema.type must be "object"';
  const properties = schema.properties;
  if (!isPlainObject(properties)) return "configSchema.properties must be an object";
  for (const [name, def] of Object.entries(properties)) {
    if (!isPropertyName(name)) return `configSchema property name invalid: ${JSON.stringify(name)}`;
    if (!isPlainObject(def)) return `configSchema property "${name}" must be an object`;
    for (const key of Object.keys(def)) {
      if (key !== "type") return `configSchema property "${name}" has unknown field "${key}"`;
    }
    if (def.type !== "string" && def.type !== "number" && def.type !== "boolean") {
      return `configSchema property "${name}" type must be string|number|boolean`;
    }
  }
  const required = schema.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((r) => !isPropertyName(r))) return "configSchema.required must be an array of property names";
    for (const r of required) {
      if (!(r in properties)) return `configSchema.required references unknown property "${r}"`;
    }
  }
  return true;
}

/**
 * 校验 WebUI 插件 descriptor（webuiApi 1）。字段集冻结：id/webuiApi/pages/
 * routes/dataEndpoints/configSchema；未知顶层/页面字段一律拒绝（冻结语义）。
 * `component`（页面的宿主侧 Svelte 组件绑定）是唯一例外：编译期装配位、非
 * wire 契约——存在时必须是对象或函数（深校验属宿主编译期职责）。
 * @param {unknown} value `./opendweb-webui-plugin` 子路径导出的 manifest
 * @returns {{ ok: true, value: WebuiPluginDescriptor } | { ok: false, error: string }}
 */
export function validateWebuiPluginDescriptor(value) {
  if (!isPlainObject(value)) return { ok: false, error: "descriptor must be an object" };
  for (const key of Object.keys(value)) {
    if (key !== "id" && key !== "webuiApi" && key !== "pages" && key !== "routes" && key !== "dataEndpoints" && key !== "configSchema") {
      return { ok: false, error: `unknown descriptor field "${key}" (webuiApi 1 field set is frozen: id, webuiApi, pages, routes, dataEndpoints, configSchema)` };
    }
  }
  const id = value.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: `id must match ${ID_RE} (got ${JSON.stringify(id)})` };
  if (value.webuiApi !== WEBUI_PLUGIN_API) return { ok: false, error: `webuiApi must be ${WEBUI_PLUGIN_API} (got ${JSON.stringify(value.webuiApi)})` };
  if (!Array.isArray(value.pages) || value.pages.length === 0) return { ok: false, error: "pages must be a non-empty array" };
  const pageIds = new Set();
  for (const page of value.pages) {
    if (!isPlainObject(page)) return { ok: false, error: "each page must be an object" };
    for (const key of Object.keys(page)) {
      if (key !== "id" && key !== "title" && key !== "nav" && key !== "icon" && key !== "type" && key !== "perspective" && key !== "component") {
        return { ok: false, error: `unknown page field "${key}" (frozen set: id, title, nav, icon, type, perspective, component)` };
      }
    }
    if (typeof page.id !== "string" || !ID_RE.test(page.id)) return { ok: false, error: `page id must match ${ID_RE}` };
    if (pageIds.has(page.id)) return { ok: false, error: `duplicate page id "${page.id}"` };
    pageIds.add(page.id);
    if (typeof page.title !== "string" || page.title === "" || page.title.length > TITLE_MAX) return { ok: false, error: `page "${page.id}" title must be a non-empty string (<= ${TITLE_MAX} chars)` };
    if (page.nav !== null && page.nav !== undefined && !NAV_AREAS.has(page.nav)) return { ok: false, error: `page "${page.id}" nav must be ${[...NAV_AREAS].join("|")} or null` };
    if (page.icon !== undefined && page.icon !== null && (typeof page.icon !== "string" || !/^[a-z0-9-]+$/.test(page.icon))) {
      return { ok: false, error: `page "${page.id}" icon must be a kebab-case string or null` };
    }
    if (!PAGE_TYPES.has(page.type)) return { ok: false, error: `page "${page.id}" type must be "settings"|"page"` };
    if (!PERSPECTIVES.has(page.perspective)) return { ok: false, error: `page "${page.id}" perspective must be "admin"|"member"|"both"` };
    if (page.component !== undefined && page.component !== null && typeof page.component !== "object" && typeof page.component !== "function") {
      return { ok: false, error: `page "${page.id}" component must be an object/function (host compile-time binding) or null` };
    }
  }
  if (value.routes !== undefined && value.routes !== null) {
    if (!Array.isArray(value.routes)) return { ok: false, error: "routes must be an array (declarative; consumed by later phases)" };
    const routeIds = new Set();
    for (const route of value.routes) {
      if (!isPlainObject(route)) return { ok: false, error: "each route must be an object {id}" };
      for (const key of Object.keys(route)) {
        if (key !== "id") return { ok: false, error: `route has unknown field "${key}"` };
      }
      if (typeof route.id !== "string" || !ID_RE.test(route.id)) return { ok: false, error: "route id must match kebab-case id rule" };
      if (routeIds.has(route.id)) return { ok: false, error: `duplicate route id "${route.id}"` };
      routeIds.add(route.id);
    }
  }
  if (value.dataEndpoints !== undefined && value.dataEndpoints !== null) {
    if (!Array.isArray(value.dataEndpoints)) return { ok: false, error: "dataEndpoints must be an array (declarative; consumed by later phases)" };
    const endpointIds = new Set();
    for (const ep of value.dataEndpoints) {
      if (!isPlainObject(ep)) return { ok: false, error: "each dataEndpoint must be an object {id, path?}" };
      for (const key of Object.keys(ep)) {
        if (key !== "id" && key !== "path") return { ok: false, error: `dataEndpoint has unknown field "${key}"` };
      }
      if (typeof ep.id !== "string" || !ID_RE.test(ep.id)) return { ok: false, error: "dataEndpoint id must match kebab-case id rule" };
      if (endpointIds.has(ep.id)) return { ok: false, error: `duplicate dataEndpoint id "${ep.id}"` };
      if (ep.path !== undefined && ep.path !== null && (typeof ep.path !== "string" || !ep.path.startsWith("/"))) {
        return { ok: false, error: `dataEndpoint "${ep.id}" path must be an absolute path string or null` };
      }
    }
  }
  const schemaCheck = checkConfigSchema(value.configSchema);
  if (schemaCheck !== true) return { ok: false, error: schemaCheck };
  return { ok: true, value: /** @type {WebuiPluginDescriptor} */ (value) };
}

/**
 * 校验插件 config 值（PUT /sidecar/plugins/<id>/config 的 body）。
 * 规则：plain object；键必须是已声明属性（未知键拒绝）；类型精确匹配（number
 * 不接受数字字符串）；required 必须齐。返回规范化副本（仅已声明键）。
 * @param {PluginConfigSchema} schema
 * @param {unknown} values
 * @returns {{ ok: true, value: Record<string, string | number | boolean> } | { ok: false, error: string }}
 */
export function validatePluginConfig(schema, values) {
  if (!isPlainObject(values)) return { ok: false, error: "config must be a JSON object of {name: value}" };
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const [name, value] of Object.entries(values)) {
    const def = properties[name];
    if (def === undefined) return { ok: false, error: `unknown config key "${name}"` };
    if (def.type === "boolean") {
      if (typeof value !== "boolean") return { ok: false, error: `config "${name}" must be a boolean` };
    } else if (def.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `config "${name}" must be a finite number` };
    } else if (typeof value !== "string") {
      return { ok: false, error: `config "${name}" must be a string` };
    }
    out[name] = value;
  }
  for (const r of required) {
    if (!(r in out)) return { ok: false, error: `missing required config key "${r}"` };
  }
  return { ok: true, value: out };
}

/**
 * @typedef {"admin" | "member" | "both"} PluginPagePerspective
 * @typedef {"settings" | "page"} PluginPageType
 *
 * @typedef {Object} WebuiPluginPage
 * @property {string} id
 * @property {string} title
 * @property {string | null} [nav] 导航区（"tools"=SideNav 工具区；null/缺省=不进导航）
 * @property {string | null} [icon] lucide 图标名（kebab-case）
 * @property {PluginPageType} type settings=通用 renderer；page=插件专属组件
 * @property {PluginPagePerspective} perspective 视角可见性
 * @property {unknown} [component] 宿主编译期绑定的 Svelte 组件（非 wire 契约）
 *
 * @typedef {Object} PluginConfigProperty
 * @property {"string" | "number" | "boolean"} type
 *
 * @typedef {Object} PluginConfigSchema
 * @property {"object"} type
 * @property {Record<string, PluginConfigProperty>} properties
 * @property {string[]} [required]
 *
 * @typedef {Object} WebuiPluginDescriptor
 * @property {string} id
 * @property {1} webuiApi
 * @property {WebuiPluginPage[]} pages
 * @property {Array<{ id: string }>} [routes]
 * @property {Array<{ id: string, path?: string }>} [dataEndpoints]
 * @property {PluginConfigSchema} configSchema
 */
