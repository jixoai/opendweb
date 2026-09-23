// 目标 URL 守卫（webui-console design §2.3 / spec「明文远端守卫」）。
// 意图（2026-09-22，webui-console Phase A）：sidecar 唯一的目标入口——
// 绝对 http(s)、raw 路径段防线（dot-segment/编码分隔符/反斜杠/空段）、
// http scheme 的 loopback 判定（字面 IP 直判；localhost 与域名走 DNS 全
// A/AAAA 记录校验）、解析一次冻结出「按解析 IP 连接 + 原序列化 Host +
// SNI hostname」的连接材料（防 TOCTOU rebinding）。
// --allow-insecure 仅放宽「http 非 loopback」的加密判断，路径/scheme 校验
// 恒全量执行。纯函数 + 可注入 dns，便于单测钉 rebinding/混合记录矩阵。

import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/** 无显式端口时的默认端口（同时决定 Host header 是否省略端口） */
const DEFAULT_PORTS = { http: 80, https: 443 };

/** 契约默认 DNS（node:dns/promises lookup {all:true}；测试注入替身） */
export const defaultDns = { lookup: dnsLookup };

/**
 * 校验目标 server URL，产出冻结的连接材料。
 * @param {string} rawUrl
 * @param {{ allowInsecure?: boolean, dns?: { lookup: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string, family: number }>> } }} [opts]
 * @returns {Promise<{ ok: true, value: { scheme: "http" | "https", hostname: string, port: number, hostHeader: string, connectHost: string, servername: string | null, insecure: boolean } } | { ok: false, error: string }>}
 *   - hostHeader：原序列化 host[:port]（IPv6 bracket；默认端口省略——与
 *     WHATWG 序列化一致，deterministic）
 *   - connectHost：解析缓存 IP（字面 IP 即本身）——连接永不复解析
 *   - servername：域名时的 TLS SNI；字面 IP 为 null（RFC 6066 禁 IP 入 SNI）
 *   - insecure：http 且非 loopback（即 --allow-insecure 放行的明文形态）
 */
export async function validateTarget(rawUrl, { allowInsecure = false, dns = defaultDns } = {}) {
  const fail = (error) => ({ ok: false, error });

  if (typeof rawUrl !== "string" || rawUrl === "") return fail("target server URL is required");
  /** @type {URL} */
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail("target server URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("target server URL scheme must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    return fail("target server URL must not embed credentials (userinfo)");
  }
  if (url.search !== "" || url.hash !== "") {
    return fail("target server URL must not carry a query or fragment");
  }

  // raw 尾部防线：WHATWG URL 会把 `/a/../b`、`%2e%2e`、`\` 规范化掉——
  // 校验必须看原始串，解析后的 pathname 不足为凭。
  const schemeSep = rawUrl.indexOf("://");
  const rawTail = schemeSep === -1 ? rawUrl : rawUrl.slice(schemeSep + 3);
  const tailErr = checkRawTail(rawTail);
  if (tailErr) return fail(tailErr);
  // admin base 冻结在目标根：任何路径前缀都拒绝（/admin/ 拼接不变式）
  if (url.pathname !== "/") {
    return fail("target server URL must not carry a path (the admin base lives at the server root)");
  }

  // hostname：URL 对 IPv6 保留方括号；尾点防御性剥除（URL 通常已剥）
  let hostname = url.hostname.toLowerCase();
  const bracketed = hostname.startsWith("[") && hostname.endsWith("]");
  if (bracketed) hostname = hostname.slice(1, -1);
  if (hostname.includes("%")) return fail("target server URL must not use an IPv6 zone-id address");
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "") return fail("target server URL has no host");

  const scheme = /** @type {"http" | "https"} */ (url.protocol.slice(0, -1));
  const port = url.port === "" ? DEFAULT_PORTS[scheme] : Number(url.port);
  const hostHeader = formatHostHeader(hostname, port, scheme);

  // 连接材料：字面 IP 直判；域名（含 localhost）DNS 全记录校验 + 解析缓存
  const ipFamily = net.isIP(hostname);
  /** @type {string | null} */
  let connectHost = null;
  let loopback = false;
  if (ipFamily !== 0) {
    connectHost = hostname;
    loopback = isLoopbackIp(hostname);
  } else {
    /** @type {Array<{ address: string, family: number }>} */
    let records;
    try {
      records = await dns.lookup(hostname, { all: true });
    } catch {
      return fail(`cannot resolve target hostname ${hostname} (treated as non-loopback)`);
    }
    if (!Array.isArray(records) || records.length === 0) {
      return fail(`target hostname ${hostname} resolves to no addresses`);
    }
    // 全 A/AAAA 记录均 loopback 才算 loopback（混合记录 = rebinding 面，拒）
    loopback = records.every((r) => isLoopbackIp(r.address));
    connectHost = records[0].address;
  }
  if (scheme === "http" && !loopback && !allowInsecure) {
    return fail(
      `target uses plaintext http to a non-loopback host (${hostHeader}); pass --allow-insecure to allow it`,
    );
  }
  const servername = ipFamily === 0 ? hostname : null;
  return {
    ok: true,
    value: { scheme, hostname, port, hostHeader, connectHost, servername, insecure: scheme === "http" && !loopback },
  };
}

/**
 * raw 尾部（scheme:// 之后整段）编码/反斜杠防线。整个尾部扫（不只路径）：
 * 合法目标 URL 不含 percent-encoded 分隔符/点，编码进 hostname 的字符
 * 一并拒绝（fail-closed；合法输入永远手写明文 host）。
 * @param {string} tail
 * @returns {string | null}
 */
function checkRawTail(tail) {
  if (tail.includes("\\")) return "target server URL must not contain backslashes";
  const lower = tail.toLowerCase();
  if (lower.includes("%2f")) return "target server URL must not contain encoded path separators (%2f)";
  if (lower.includes("%5c")) return "target server URL must not contain encoded path separators (%5c)";
  if (lower.includes("%2e")) return "target server URL must not contain encoded dot segments (%2e)";
  // 路径段检查：authority 之后的部分（非根路径最终一律拒，这里给出更精确的错误）
  const pathStart = tail.search(/[/?#]/);
  const rawPath = pathStart === -1 ? "" : tail.slice(pathStart).split(/[?#]/)[0];
  if (rawPath === "" || rawPath === "/") return null;
  const segs = rawPath.slice(1).split("/");
  if (segs.includes(".") || segs.includes("..")) return "target server URL must not contain dot segments (..)";
  if (segs.includes("")) return "target server URL must not contain empty path segments";
  return null;
}

/**
 * Host header 序列化：IPv6 加方括号；端口为 scheme 默认值时省略
 * （WHATWG 序列化惯例，deterministic）。
 */
function formatHostHeader(hostname, port, scheme) {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return port === DEFAULT_PORTS[scheme] ? host : `${host}:${port}`;
}

/**
 * 字面 IP 的 loopback 判定：127.0.0.0/8、::1（含展开形）、IPv4-mapped
 * ::ffff:127.0.0.0/104（dotted 与 hex 两种书写）。
 * @param {string} ip
 */
function isLoopbackIp(ip) {
  if (net.isIPv4(ip)) return Number(ip.split(".")[0]) === 127;
  if (!net.isIPv6(ip)) return false;
  const h = ip.toLowerCase();
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  let m = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) return Number(m[1]) === 127;
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h) ?? /^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (m) return (parseInt(m[1], 16) >> 8) === 127;
  return false;
}
