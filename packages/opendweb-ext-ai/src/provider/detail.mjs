// adapted from ai-fly src/provider/detail.ts (v0.6.0)
// 服务脱敏披露视图：把服务配置投影为 wire 目录载荷（AUTH groups[].services /
// catalog）的 ServiceEntry / ServiceDetail。
// 脱敏规则照搬（v2）：auth 槽整值掩码 ●（secret 名/script 绑定/literal 值均为
// 凭证语义——名称与值都不出网），bearer 开关可见；headers.set 的引用型字面量
// （$secret:——本包 $env 构造期拒绝，掩码分支为纵深防御）整体掩码，纯字面量
// 原样披露；headers.script / request / response / hooks 的脚本绑定掩码；
// upstream 与 match 全集原样披露；rewrite 仅 host/prefix。
// 正交意图：只做披露投影，不校验、不落盘。

import { routeLocalPrefix } from "./store.mjs";
import { SERVICE_VALUE_MASK, SECRET_REF_PREFIX, ENV_REF_PREFIX } from "./lifecycle.mjs";

export { SERVICE_VALUE_MASK, SECRET_REF_PREFIX, ENV_REF_PREFIX };

/**
 * auth 槽脱敏：三族整值掩码 ●（凭证语义——密钥名/脚本绑定/字面量值都不出网）。
 * @param {Record<string, unknown>} auth
 */
function maskAuthSlot(auth) {
  const bearer = "bearer" in auth && auth.bearer !== undefined ? { bearer: auth.bearer } : {};
  if ("secret" in auth) return { secret: SERVICE_VALUE_MASK, ...bearer };
  if ("script" in auth) return { script: SERVICE_VALUE_MASK, ...bearer };
  return { literal: SERVICE_VALUE_MASK, ...bearer };
}

/**
 * headers 槽脱敏：引用型字面量 → ●（名与值都不出）；纯字面量原样；脚本绑定掩码。
 * @param {Record<string, unknown>} slot
 */
function maskHeadersSlot(slot) {
  const out = {};
  if (slot.remove !== undefined) out.remove = [...slot.remove];
  if (slot.set !== undefined) {
    out.set = Object.fromEntries(
      Object.entries(slot.set).map(([name, value]) => [
        name,
        typeof value === "string" && (value.startsWith(SECRET_REF_PREFIX) || value.startsWith(ENV_REF_PREFIX))
          ? SERVICE_VALUE_MASK
          : value,
      ]),
    );
  }
  if (slot.script !== undefined) out.script = { name: SERVICE_VALUE_MASK };
  return out;
}

/**
 * 服务完整配置的脱敏披露（脚本/密钥/引用注入位 → ●）。
 * @param {Record<string, any>} service
 */
export function buildServiceDetail(service) {
  const rewrite = {};
  if (service.rewrite !== undefined) {
    if (service.rewrite.host !== undefined) rewrite.host = service.rewrite.host;
    const tokens = [];
    if (service.rewrite.pathPrefixStrip !== undefined) tokens.push(`strip:${service.rewrite.pathPrefixStrip}`);
    if (service.rewrite.pathPrefixAppend !== undefined) tokens.push(`append:${service.rewrite.pathPrefixAppend}`);
    if (tokens.length > 0) rewrite.prefix = tokens.join(" ");
  }
  const detail = {
    upstream: service.upstream,
    match: service.match.map((m) => ({ type: m.type, value: m.value })),
    rewrite,
    ...(service.routes !== undefined && service.routes.length > 0
      ? {
          routes: service.routes.map((r) =>
            r.mode === "pattern"
              ? { forms: r.forms, mode: "pattern", matchPattern: r.matchPattern, template: r.template }
              : { forms: r.forms, localPrefix: routeLocalPrefix(r), upstreamPrefix: r.upstreamPrefix ?? "" },
          ),
        }
      : {}),
  };
  if (service.auth !== undefined) detail.auth = maskAuthSlot(service.auth);
  if (service.headers !== undefined) detail.headers = maskHeadersSlot(service.headers);
  if (service.request !== undefined) detail.request = { script: SERVICE_VALUE_MASK };
  if (service.response !== undefined) detail.response = { script: SERVICE_VALUE_MASK };
  if (service.hooks !== undefined) detail.hooks = { script: SERVICE_VALUE_MASK };
  return detail;
}

/**
 * 目录服务条目（含 detail 脱敏披露）。
 * @param {Record<string, any>} service
 */
export function buildServiceEntry(service) {
  return {
    serviceId: service.serviceId,
    name: service.name,
    match: service.match.map((m) => ({ type: m.type, value: m.value })),
    defaultPort: service.defaultPort,
    detail: buildServiceDetail(service),
  };
}

/**
 * detail 的 ASCII 展示形（用户面文案码位 < 128——● 在终端侧替换为 <hidden>）。
 * @param {Record<string, any>} detail
 * @returns {string[]}
 */
export function detailDisplayLines(detail) {
  const lines = [`upstream: ${detail.upstream}`];
  for (const m of detail.match) lines.push(`match: ${m.type} ${m.value}`);
  for (const r of detail.routes ?? []) {
    const forms = r.forms.length > 0 ? ` (${r.forms.join("+")})` : "";
    if (r.mode === "pattern") {
      lines.push(`route: ${r.matchPattern} => ${r.template}${forms}`);
    } else {
      const to = r.upstreamPrefix === "" ? "(root)" : r.upstreamPrefix;
      lines.push(`route: ${r.localPrefix} -> ${to}${forms}`);
    }
  }
  if (detail.rewrite !== undefined) {
    const r = detail.rewrite;
    if (r.host !== undefined) lines.push(`host: ${r.host}`);
    if (r.prefix !== undefined) lines.push(`prefix: ${r.prefix}`);
  }
  if (detail.auth !== undefined) {
    const a = detail.auth;
    const kind = "secret" in a ? "secret" : "script" in a ? "script" : "literal";
    const bearer = "bearer" in a && a.bearer === false ? " (bearer off)" : "";
    lines.push(`auth: ${kind} <hidden>${bearer}`);
  }
  if (detail.headers !== undefined) {
    const h = detail.headers;
    for (const [name, value] of Object.entries(h.set ?? {})) {
      lines.push(`header-set: ${name}: ${value === SERVICE_VALUE_MASK ? "<hidden>" : value}`);
    }
    for (const name of h.remove ?? []) lines.push(`header-remove: ${name}`);
    if (h.script !== undefined) lines.push(`headers-script: <hidden>`);
  }
  if (detail.request !== undefined) lines.push(`request: script <hidden>`);
  if (detail.response !== undefined) lines.push(`response: script <hidden>`);
  if (detail.hooks !== undefined) lines.push(`hooks: preset <hidden>`);
  return lines;
}
