// HTTP 头规则（webui-plugin-kernel Phase 1 ports / design §5「header 规则」）。
// 意图（2026-09-29）：
// 1. hop-by-hop 头剥除清单冻结（design v2.3 §5 原文）：
//    connection / keep-alive / transfer-encoding / upgrade / proxy-*（前缀）。
//    清单是冻结面——不实现 Connection 头点名的动态 hop-by-hop 扩展（RFC 7230
//    6.1 允许但设计未冻结；扩展属后续 change，不得静默加宽）。
// 2. 敏感回显头重写：server 重写为本代理标识、via 剥除（不回显上游部署细节）。
// 3. 头形态=/http 契约的 Array<{name,value}>（保重复项，§3.4）。

/** hop-by-hop 头剥除清单（冻结；proxy-* 走前缀匹配） */
export const HOP_BY_HOP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade"];
/** 前缀匹配的 hop-by-hop 头（proxy-authorization/proxy-connection 等） */
export const HOP_BY_HOP_PREFIXES = ["proxy-"];
/** 敏感回显头（响应方向重写；server→重写、via→剥除） */
export const SERVER_ECHO = "opendweb-ports";

/**
 * @param {string} name 小写头名
 * @returns {boolean} 是否在冻结的 hop-by-hop 剥除清单内
 */
export function isHopByHop(name) {
  const n = name.toLowerCase();
  if (HOP_BY_HOP_HEADERS.includes(n)) return true;
  return HOP_BY_HOP_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * 请求方向转发头：剥除冻结 hop-by-hop 清单。host 不在清单内（端到端头）——
 * 由消费侧重写为直连语义（localhost:<remotePort>），见 proxy.mjs。
 * @param {Array<{name: string, value: string}>} headers
 * @returns {Array<{name: string, value: string}>}
 */
export function forwardRequestHeaders(headers) {
  return headers.filter((h) => !isHopByHop(h.name));
}

/**
 * 响应方向回写头：剥除冻结 hop-by-hop 清单 + content-length/transfer-encoding
 * （流式回写由传输层自行分帧——fabric 响应体无可靠 content-length）+ 敏感回显
 * 重写（server→opendweb-ports、via→剥除）。
 * @param {Array<{name: string, value: string}>} headers
 * @returns {Array<{name: string, value: string}>}
 */
export function forwardResponseHeaders(headers) {
  const out = [];
  for (const h of headers) {
    const n = h.name.toLowerCase();
    if (isHopByHop(n)) continue;
    if (n === "content-length") continue; // 流式回写：分帧交给传输层
    if (n === "server" || n === "via") continue; // 敏感回显重写（见下）
    out.push({ name: h.name, value: h.value });
  }
  out.push({ name: "server", value: SERVER_ECHO });
  return out;
}

/**
 * node:http 的 req.headers（小写键、重复项逗号joined、set-cookie 为数组）→
 * /http 契约的 Array<{name,value}> 形态。
 * @param {Record<string, string | string[] | undefined>} nodeHeaders
 * @returns {Array<{name: string, value: string}>}
 */
export function nodeHeadersToArray(nodeHeaders) {
  const out = [];
  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: v });
    } else {
      out.push({ name, value });
    }
  }
  return out;
}

/**
 * Array<{name,value}> → node:http 请求头对象（重复 set-cookie 保留数组，其余
 * 逗号合并；content-length 由调用方按缓冲后的实际字节数另行覆盖）。
 * @param {Array<{name: string, value: string}>} headers
 * @returns {Record<string, string | string[]>}
 */
export function arrayHeadersToNode(headers) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const h of headers) {
    const n = h.name.toLowerCase();
    if (n === "set-cookie") {
      const existing = out[n];
      if (Array.isArray(existing)) existing.push(h.value);
      else out[n] = [h.value];
    } else if (out[n] === undefined) {
      out[n] = h.value;
    } else {
      out[n] = `${out[n]}, ${h.value}`;
    }
  }
  return out;
}

/**
 * 取首个头值（大小写不敏感；/http Array 形态）。
 * @param {Array<{name: string, value: string}>} headers
 * @param {string} name
 * @returns {string | null}
 */
export function headerValue(headers, name) {
  const n = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === n) return h.value;
  }
  return null;
}
