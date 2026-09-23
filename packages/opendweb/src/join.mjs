// opendweb join —— 租户自助注册命令（server-access-roles Phase 3，R4 自助入口）。
// 意图：租户不手工构造 HTTP——CLI 以本机默认设备 key 为 root（R2）完成
// fabric 选取（无则生成/有则复用，--fabric 显式指定，绝不静默造第二个）、
// register canonical 构造与签名、POST /register 兑换、server_id 回执验签、
// 本地数据面保存。纪律（spec 冻结）：
//   - 码与私钥不落日志/输出/错误（码全文任何形态不出现在 stdout/stderr）
//   - 失败（bad-signature/stale-ts/code-*/rate-limited）非零退出，无半提交
//     本地状态（registration.json 仅在兑换+验签成功后原子落盘；设备 key 的
//     首次生成为设备级引导，非注册状态，重试复用同一身份）
//   - https 默认期望；http 仅 loopback 放行（判定语义与 webui sidecar
//     target.mjs 明文守卫逐条对齐：字面 IP 直判、域名含 localhost 走 DNS
//     全记录校验、混合记录=非 loopback），非 loopback 明文需 --allow-insecure

import net from "node:net";
import os from "node:os";
import { lookup as dnsLookup } from "node:dns/promises";
import { readFile, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CliExit, asciiEscape } from "./util.mjs";
import { ensureDeviceSeed, loadDeviceSeed } from "./device-key.mjs";
import {
  buildRegisterCanonical,
  parseRegisterResponse,
  serverPublicKeyFromServices,
  signDetached,
  endpointIdHexFromSeed,
  toBase64UrlNoPad,
  verifyRegisterReceipt,
} from "./register.mjs";

/** 契约默认 DNS（node:dns/promises lookup {all:true}；测试注入替身） */
export const defaultDns = { lookup: dnsLookup };

/** 无显式端口时的默认端口 */
const DEFAULT_PORTS = { http: 80, https: 443 };

/** 注册状态文件名（<DWEB_HOME>/registration.json，SecretStore 目录纪律） */
export const REGISTRATION_FILE = "registration.json";

/** /register 错误码 → 人类可读文案（exit 1；文案不含码全文/私钥） */
export const REGISTER_ERROR_TEXT = {
  "bad-signature": "the server rejected our proof-of-possession signature (bad-signature); check this machine's clock, then retry",
  "stale-ts": "our timestamp fell outside the server's ±120s window (stale-ts); check this machine's clock, then retry",
  "code-invalid": "the invite code is not recognized by this server (code-invalid)",
  "code-exhausted": "the invite code has no uses left (code-exhausted); ask the server admin for a new code",
  "code-expired": "the invite code has expired (code-expired); ask the server admin for a new code",
  "code-pending": "the invite code is mid-redemption by another key (code-pending); retry in a moment",
  "code-unavailable": "the server's code ledger is temporarily unavailable (code-unavailable); retry shortly",
  "rate-limited": "too many attempts from your address (rate-limited); wait a minute and retry",
  "invalid-request": "the server rejected the request shape (invalid-request)",
};

/**
 * 解析 join 参数：--server <URL> 与 --code <码> 必填，--fabric <hex64> 与
 * --allow-insecure 可选；--opt value 与 --opt=value 双形式；未知选项退出码 2
 * （与 server/plugin 子命令同纪律，防静默忽略）。
 * @param {string[]} argv
 * @returns {{ server: string, code: string, fabric: string | undefined, allowInsecure: boolean }}
 */
export function parseJoinArgs(argv) {
  const out = { fabric: undefined, allowInsecure: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const eq = t.indexOf("=");
    const name = eq === -1 ? t : t.slice(0, eq);
    let value = eq === -1 ? undefined : t.slice(eq + 1);
    if (name === "--allow-insecure") {
      if (value !== undefined) throw new CliExit("--allow-insecure takes no value", 2);
      out.allowInsecure = true;
      continue;
    }
    if (name !== "--server" && name !== "--code" && name !== "--fabric") {
      throw new CliExit(`unknown option ${name}`, 2);
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new CliExit(`missing value for ${name}`, 2);
    }
    if (value === "") throw new CliExit(`${name} must not be empty`, 2);
    if (name === "--server") out.server = value;
    else if (name === "--code") out.code = value;
    else out.fabric = value;
  }
  if (!out.server) throw new CliExit("usage: opendweb join --server <URL> --code <dwebc1 code> [--fabric <hex64>] [--allow-insecure]", 2);
  if (!out.code) throw new CliExit("usage: opendweb join --server <URL> --code <dwebc1 code> [--fabric <hex64>] [--allow-insecure]", 2);
  return /** @type {{ server: string, code: string, fabric: string | undefined, allowInsecure: boolean }} */ (out);
}

/**
 * server URL 守卫（语义与 webui sidecar target.mjs 明文守卫逐条对齐——
 * 同一份判定规则在 CLI 侧的独立实现，两包互不依赖）：
 * 绝对 http(s)、无 userinfo/query/fragment/path、raw 尾部防线（反斜杠/
 * 编码分隔符/点段/空段）、loopback 判定（字面 IP 直判；localhost 与域名走
 * DNS 全 A/AAAA 记录校验，全部 loopback 才算），http 非 loopback 需
 * --allow-insecure。https 恒放行。
 * @param {string} rawUrl
 * @param {{ allowInsecure?: boolean, dns?: { lookup: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string, family: number }>> } }} [opts]
 * @returns {Promise<{ ok: true, value: { origin: string } } | { ok: false, error: string }>}
 */
export async function validateServerUrl(rawUrl, { allowInsecure = false, dns = defaultDns } = {}) {
  /** @type {(error: string) => { ok: false, error: string }} */
  const fail = (error) => ({ ok: false, error });
  if (typeof rawUrl !== "string" || rawUrl === "") return fail("--server URL is required");
  /** @type {URL} */
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail("--server must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("--server scheme must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    return fail("--server must not embed credentials (userinfo)");
  }
  if (url.search !== "" || url.hash !== "") {
    return fail("--server must not carry a query or fragment");
  }
  // raw 尾部防线：WHATWG URL 会把 `/a/../b`、`%2e%2e`、`\` 规范化掉——校验
  // 必须看原始串（sidecar 同款规则）
  const schemeSep = rawUrl.indexOf("://");
  const rawTail = schemeSep === -1 ? rawUrl : rawUrl.slice(schemeSep + 3);
  const tailErr = checkRawTail(rawTail);
  if (tailErr) return fail(tailErr);
  if (url.pathname !== "/") {
    return fail("--server must not carry a path (the register endpoint lives at the server root)");
  }
  let hostname = url.hostname.toLowerCase();
  const bracketed = hostname.startsWith("[") && hostname.endsWith("]");
  if (bracketed) hostname = hostname.slice(1, -1);
  if (hostname.includes("%")) return fail("--server must not use an IPv6 zone-id address");
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "") return fail("--server has no host");

  const scheme = /** @type {"http" | "https"} */ (url.protocol.slice(0, -1));
  const port = url.port === "" ? DEFAULT_PORTS[scheme] : Number(url.port);
  // loopback 判定（sidecar 同款）：字面 IP 直判；域名（含 localhost）DNS 全
  // 记录校验（混合记录 = rebinding 面，视为非 loopback）。https 无明文策略
  // 依赖，不做解析（连接解析由 fetch 自行完成，失败以网络错误报告）
  let loopback = false;
  if (net.isIP(hostname) !== 0) {
    loopback = isLoopbackIp(hostname);
  } else if (scheme === "http") {
    /** @type {Array<{ address: string, family: number }>} */
    let records;
    try {
      records = await dns.lookup(hostname, { all: true });
    } catch {
      return fail(`cannot resolve server hostname ${hostname} (treated as non-loopback)`);
    }
    if (!Array.isArray(records) || records.length === 0) {
      return fail(`server hostname ${hostname} resolves to no addresses`);
    }
    loopback = records.every((r) => isLoopbackIp(r.address));
  }
  if (scheme === "http" && !loopback && !allowInsecure) {
    return fail(
      `--server uses plaintext http to a non-loopback host (${hostname}); pass --allow-insecure to allow it`,
    );
  }
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const origin = port === DEFAULT_PORTS[scheme] ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
  return { ok: true, value: { origin } };
}

/**
 * raw 尾部防线（sidecar target.mjs checkRawTail 同规则）。
 * @param {string} tail
 * @returns {string | null}
 */
function checkRawTail(tail) {
  if (tail.includes("\\")) return "--server must not contain backslashes";
  const lower = tail.toLowerCase();
  if (lower.includes("%2f")) return "--server must not contain encoded path separators (%2f)";
  if (lower.includes("%5c")) return "--server must not contain encoded path separators (%5c)";
  if (lower.includes("%2e")) return "--server must not contain encoded dot segments (%2e)";
  const pathStart = tail.search(/[/?#]/);
  const rawPath = pathStart === -1 ? "" : tail.slice(pathStart).split(/[?#]/)[0];
  if (rawPath === "" || rawPath === "/") return null;
  const segs = rawPath.slice(1).split("/");
  if (segs.includes(".") || segs.includes("..")) return "--server must not contain dot segments (..)";
  if (segs.includes("")) return "--server must not contain empty path segments";
  return null;
}

/**
 * 字面 IP 的 loopback 判定（sidecar target.mjs isLoopbackIp 同规则）：
 * 127.0.0.0/8、::1（含展开形）、IPv4-mapped ::ffff:127.0.0.0/104。
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

// ---- 本地注册数据面（SecretStore 目录纪律：0600 + tmp+fsync+rename） ----------

/**
 * 载入本地注册状态（无文件 → null；损坏 JSON → 报含路径错误）。
 * @param {string} home
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function loadRegistration(home) {
  const file = path.join(home, REGISTRATION_FILE);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
  try {
    const obj = JSON.parse(text);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("expected a JSON object");
    }
    return /** @type {Record<string, unknown>} */ (obj);
  } catch (e) {
    throw new Error(`invalid registration file ${file}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * 原子保存注册状态（0600 文件 + 0700 目录 + tmp+fsync+rename；失败清理 tmp）。
 * @param {string} home
 * @param {Record<string, unknown>} state
 * @returns {Promise<string>} 落盘路径
 */
export async function saveRegistration(home, state) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, REGISTRATION_FILE);
  const tmp = path.join(home, `.${REGISTRATION_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      try {
        await fh.chmod(0o600);
      } catch { /* Windows best effort */ }
      await fh.write(JSON.stringify(state, null, 2) + "\n");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`cannot write registration file ${file}: ${/** @type {Error} */ (e).message}`);
  }
  return file;
}

// ---- 编排 --------------------------------------------------------------------

/**
 * 选取 fabric：--fabric 显式（hex64 校验）> 本地既有 registration.json 的
 * fabric_id（复用，绝不静默生成第二个）> OS CSPRNG 32B 随机（与内核
 * FabricId::random() 同语义——FabricId 无轻量 JS 暴露面，见模块注释）。
 * @param {{ fabric: string | undefined, registration: Record<string, unknown> | null }} input
 * @returns {{ fabricId: string, origin: "flag" | "reused" | "new" }}
 */
export function selectFabricId({ fabric, registration }) {
  if (fabric !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(fabric)) {
      throw new CliExit("--fabric must be 64 hex characters (32 bytes)", 2);
    }
    return { fabricId: fabric.toLowerCase(), origin: "flag" };
  }
  const existing = registration?.fabric_id;
  if (typeof existing === "string" && /^[0-9a-f]{64}$/.test(existing)) {
    return { fabricId: existing, origin: "reused" };
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return { fabricId: Buffer.from(bytes).toString("hex"), origin: "new" };
}

/**
 * join 主流程（编排：守卫 → fabric 选取 → 设备 key ensure → canonical 签名 →
 * POST /register → server_id 回执验签 → 原子落盘 → 输出摘要）。
 * 上下文全部可注入（home/now/fetch/dns/stdout），测试零网络。
 * @param {string[]} argv
 * @param {{ home?: string, now?: () => number, fetchImpl?: typeof fetch, dns?: { lookup: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string, family: number }>> }, stdout?: (line: string) => void }} [ctx]
 * @returns {Promise<number>} 退出码（0 成功；失败 throw CliExit）
 */
export async function runJoin(argv, ctx = {}) {
  const {
    home = process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb"),
    now = Date.now,
    fetchImpl = fetch,
    dns = defaultDns,
    stdout = (line) => console.log(line),
  } = ctx;
  const args = parseJoinArgs(argv);
  const guard = await validateServerUrl(args.server, { allowInsecure: args.allowInsecure, dns });
  if (guard.ok === false) throw new CliExit(guard.error, 2);

  const registration = await loadRegistration(home);
  const { fabricId, origin: fabricOrigin } = selectFabricId({ fabric: args.fabric, registration });

  // 设备 key：默认设备 key 即 root（R2）；首启生成属设备级引导（重试复用同
  // 一身份），注册状态落盘严格后置于兑换成功——失败无半提交
  const { seed, created } = await ensureDeviceSeed(home);
  const rootHex = endpointIdHexFromSeed(seed);

  const ts = now();
  const canonical = buildRegisterCanonical({ code: args.code, fabricIdHex: fabricId, rootHex, ts });
  const sig = signDetached(seed, canonical);
  const body = JSON.stringify({
    code: args.code,
    fabric_id: fabricId,
    root: rootHex,
    ts,
    sig: toBase64UrlNoPad(sig),
  });

  let res;
  try {
    res = await fetchImpl(`${guard.value.origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (e) {
    throw new CliExit(`cannot reach ${asciiEscape(guard.value.origin)}/register: ${asciiEscape(/** @type {Error} */ (e).message)}`, 1);
  }

  if (!res.ok) {
    // 错误 envelope {"error":{"code","message"}}（sdk-mgmt-surface 冻结家族）；
    // 未知形态按 HTTP 状态归并——任何分支都不回显请求体（码不落日志）
    let code = "";
    let message = "";
    try {
      const errBody = /** @type {unknown} */ (await res.json());
      // unknown 窄化守卫（r9-P2-1）：逐键证明形态，不经 any 断言读取
      const envelope =
        errBody !== null && typeof errBody === "object" && "error" in errBody ? errBody.error : null;
      if (envelope !== null && typeof envelope === "object" && "code" in envelope) {
        if (typeof envelope.code === "string") code = envelope.code;
        if ("message" in envelope && typeof envelope.message === "string") message = envelope.message;
      }
    } catch { /* 非 JSON 错误体：按状态归并 */ }
    const human = REGISTER_ERROR_TEXT[/** @type {keyof typeof REGISTER_ERROR_TEXT} */ (code)];
    if (human) {
      throw new CliExit(`join failed: ${human}`, 1);
    }
    throw new CliExit(
      `join failed: server returned HTTP ${res.status}${code ? ` (${asciiEscape(code)})` : ""}${message ? `: ${asciiEscape(message)}` : ""}`,
      1,
    );
  }

  let parsed;
  try {
    parsed = parseRegisterResponse(await res.json());
  } catch (e) {
    throw new CliExit(`join failed: malformed success response (${asciiEscape(/** @type {Error} */ (e).message)})`, 1);
  }

  // 回执验签公钥 = ServerId，公开通道 = GET /services.json 的 server_id 字段
  let serverId;
  try {
    const servicesRes = await fetchImpl(`${guard.value.origin}/services.json`);
    if (!servicesRes.ok) {
      throw new Error(`HTTP ${servicesRes.status}`);
    }
    serverId = serverPublicKeyFromServices(await servicesRes.json());
  } catch (e) {
    throw new CliExit(
      `join failed: cannot obtain the server's verification key from ${asciiEscape(guard.value.origin)}/services.json (${asciiEscape(/** @type {Error} */ (e).message)}); refusing to save unverified state`,
      1,
    );
  }
  let verified;
  try {
    verified = verifyRegisterReceipt(
      {
        ts: parsed.ts,
        generation: parsed.generation,
        fabricIdHex: parsed.fabricId,
        rootHex: parsed.root,
        codeHashHex: parsed.codeHash,
        receiptSig: parsed.receiptSig,
      },
      serverId,
    );
  } catch (e) {
    throw new CliExit(`join failed: malformed receipt (${asciiEscape(/** @type {Error} */ (e).message)})`, 1);
  }
  if (!verified) {
    throw new CliExit(
      "join failed: the register receipt did not verify against this server's server_id; refusing to save state (possible tampering)",
      1,
    );
  }
  if (parsed.fabricId !== fabricId || parsed.root !== rootHex) {
    throw new CliExit("join failed: receipt fabric_id/root do not match this device; refusing to save state", 1);
  }

  const shortId = `${rootHex.slice(0, 3)}***${rootHex.slice(-3)}`;
  const stateFile = await saveRegistration(home, {
    version: 1,
    server: guard.value.origin,
    server_id: serverId,
    fabric_id: fabricId,
    root: rootHex,
    registered_at: now(),
    expires_at: parsed.expiresAt,
    receipt: {
      ts: parsed.ts,
      generation: parsed.generation,
      code_hash: parsed.codeHash,
      receipt_sig: parsed.receiptSig,
    },
  });

  const expiry = new Date(parsed.expiresAt).toISOString().slice(0, 10);
  stdout(`joined ${asciiEscape(guard.value.origin)} as a tenant`);
  stdout(`  endpoint_id  ${rootHex}`);
  stdout(`  short        ${shortId}`);
  stdout(`  fabric_id    ${fabricId} (${fabricOrigin === "new" ? "newly generated" : fabricOrigin === "reused" ? "reused local fabric" : "from --fabric"})`);
  stdout(`  expires      ${expiry}`);
  stdout(`  receipt      verified (generation ${parsed.generation})`);
  stdout(`  state        ${asciiEscape(stateFile)}`);
  if (created) {
    stdout(`  note         a new device key was created at ${asciiEscape(path.join(home, "identity.key"))} (one default key per device)`);
  }
  return 0;
}

export { loadDeviceSeed };
