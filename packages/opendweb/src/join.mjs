// opendweb join —— 租户自助注册命令（server-access-roles Phase 3，R4 自助入口）。
// 意图：租户不手工构造 HTTP——CLI 以本机默认设备 key 为 root（R2）完成
// fabric 选取（无则生成/有则复用，--fabric 显式指定；单 fabric 约束下第二
// fabric 一律 fail-closed，绝不静默造第二个）、register canonical 构造与
// 签名、POST /register 兑换、server_id 回执验签、多租约簿落账。纪律：
//   - 码与私钥不落日志/输出/错误（码全文任何形态不出现在 stdout/stderr）
//   - 失败（bad-signature/stale-ts/code-*/rate-limited）非零退出，无半提交
//     租约状态（leases.json 仅在兑换+验签+复核成功后落账；设备 key 的首次
//     生成为设备级引导，非注册状态，重试复用同一身份）
//   - https 默认期望；http 仅 loopback 放行（判定语义与 webui sidecar
//     target.mjs 明文守卫逐条对齐），非 loopback 明文需 --allow-insecure
// 意图（2026-09-23，home-hub [H6]）：join 自报别名——默认=本机机器名
// （os.hostname() 剥 .local），--alias 显式覆盖；≤32 UTF-8 字节超限截断。
// 意图（2026-09-24，home-hub Phase 1d [H7]-G1）：
//   - --server 直收接入短码（dwebh1. 前缀离线 decode，util.resolveServerArg）
//   - 多租约簿 leases.json 取代单条 registration.json（旧文件触发式迁移）
//   - join 顺序冻结：services preflight（server_id + relay 选择，无可用
//     relay=fail-closed「中枢未启用中转」）先于 register；成功后复核
//   - fabric-admission 锁（<DWEB_HOME>/fabric.lock）封 TOCTOU：锁序恒
//     admission→ledger；pending journal 在 register 发出前落账，崩溃/响应
//     丢失经幂等回放状态机恢复（异码零副作用，绝不产生第二 fabric）

import net from "node:net";
import os from "node:os";
import { lookup as dnsLookup } from "node:dns/promises";
import path from "node:path";
import {
  CliExit,
  asciiEscape,
  ALIAS_MAX_BYTES,
  machineName,
  resolveServerArg,
  truncateUtf8Bytes,
} from "./util.mjs";
import { ensureDeviceSeed, loadDeviceSeed } from "./device-key.mjs";
import {
  buildRegisterCanonical,
  parseRegisterResponse,
  serverPublicKeyFromServices,
  signDetached,
  endpointIdHexFromSeed,
  toBase64UrlNoPad,
  verifyRegisterReceipt,
  inviteCodeHashHex,
} from "./register.mjs";
import {
  ADMISSION_JOURNAL_FILE,
  FABRIC_LOCK_FILE,
  PROBE_TIMEOUT_MS,
  acquireFileLock,
  clearAdmissionJournal,
  fabricLockFile,
  loadAdmissionJournal,
  loadLeases,
  migrateLegacyRegistration,
  readLegacyRegistration,
  readRosterFabricId,
  resolveExistingFabricId,
  saveAdmissionJournal,
  selectRelayFromManifest,
  upsertLease,
} from "./leases.mjs";

/** 契约默认 DNS（node:dns/promises lookup {all:true}；测试注入替身） */
export const defaultDns = { lookup: dnsLookup };

/** 无显式端口时的默认端口 */
const DEFAULT_PORTS = { http: 80, https: 443 };

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
 * 解析 join 参数：--server <URL>（或 dwebh1. 接入短码）与 --code <码> 必填，
 * --fabric <hex64>、--alias <别名> 与 --allow-insecure 可选；--opt value 与
 * --opt=value 双形式；未知选项退出码 2（防静默忽略）。
 * @param {string[]} argv
 * @returns {{ server: string, code: string, fabric: string | undefined, alias: string | undefined, allowInsecure: boolean }}
 */
const JOIN_USAGE = "usage: opendweb join --server <URL> --code <dwebc1 code> [--fabric <hex64>] [--alias <name>] [--allow-insecure]";
export function parseJoinArgs(argv) {
  const out = { fabric: undefined, alias: undefined, allowInsecure: false };
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
    if (name !== "--server" && name !== "--code" && name !== "--fabric" && name !== "--alias") {
      throw new CliExit(`unknown option ${name}`, 2);
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new CliExit(`missing value for ${name}`, 2);
    }
    if (value === "") throw new CliExit(`${name} must not be empty`, 2);
    if (name === "--server") out.server = value;
    else if (name === "--code") out.code = value;
    else if (name === "--alias") out.alias = value;
    else out.fabric = value;
  }
  if (!out.server) throw new CliExit(JOIN_USAGE, 2);
  if (!out.code) throw new CliExit(JOIN_USAGE, 2);
  return /** @type {{ server: string, code: string, fabric: string | undefined, alias: string | undefined, allowInsecure: boolean }} */ (out);
}

/**
 * 解析自报别名（[H6]）：--alias 显式 > 本机机器名（os.hostname() 剥
 * `.local`）；≤32 UTF-8 字节超限截断到合法字符边界；空=无自报。
 * @param {{ alias: string | undefined, hostname: string }} input
 * @returns {{ alias: string | null, truncated: boolean }}
 */
export function resolveSelfAlias({ alias, hostname }) {
  const raw = alias ?? machineName(hostname);
  if (raw === "") return { alias: null, truncated: false };
  const { value, truncated } = truncateUtf8Bytes(raw, ALIAS_MAX_BYTES);
  return { alias: value, truncated };
}

/**
 * server URL 守卫（语义与 webui sidecar target.mjs 明文守卫逐条对齐）：
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
  // 记录校验（混合记录 = rebinding 面，视为非 loopback）
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

// ---- fabric 决策（单 fabric 约束） ---------------------------------------------

/**
 * 选取 fabric（Phase 1d 语义）：`--fabric` 显式（hex64 校验+小写归一）；
 * 既有 fabric（租约簿/旧 registration/roster 汇裁判决值）存在时显式值与
 * 既有不等=throw CliExit fail-closed（单 fabric 约束——不 register 不落账）；
 * 无既有则复用之（绝不静默生成第二个）；首设备=CSPRNG 32B（与内核
 * FabricId::random() 同语义）。
 * @param {{ fabric: string | undefined, existing: string | null }} input
 * @returns {{ fabricId: string, origin: "flag" | "reused" | "new" }}
 */
export function selectFabricId({ fabric, existing }) {
  const normalizedFlag =
    fabric !== undefined
      ? (/^[0-9a-fA-F]{64}$/.test(fabric) ? fabric.toLowerCase() : null)
      : undefined;
  if (normalizedFlag === null) {
    throw new CliExit("--fabric must be 64 hex characters (32 bytes)", 2);
  }
  if (existing !== null) {
    if (normalizedFlag !== undefined && normalizedFlag !== existing) {
      throw new CliExit(
        `this machine already belongs to fabric ${existing.slice(0, 8)}…; joining a different fabric (${normalizedFlag.slice(0, 8)}…) is refused (one fabric per machine) - nothing was sent to the server and no lease was written`,
        1,
      );
    }
    return { fabricId: existing, origin: normalizedFlag !== undefined ? "flag" : "reused" };
  }
  if (normalizedFlag !== undefined) return { fabricId: normalizedFlag, origin: "flag" };
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return { fabricId: Buffer.from(bytes).toString("hex"), origin: "new" };
}

// ---- services preflight / register / 恢复状态机（Phase 1d） -----------------------

/**
 * join 运行上下文（全部可注入；测试零网络）。
 * @typedef {Object} JoinCtx
 * @property {string} [home]
 * @property {() => number} [now]
 * @property {typeof fetch} [fetchImpl]
 * @property {{ lookup: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string, family: number }>> }} [dns]
 * @property {(line: string) => void} [stdout]
 * @property {string} [hostname]
 * @property {(pid: number) => boolean} [isPidAlive]
 * @property {number} [probeTimeoutMs]
 */

/**
 * services preflight：GET <origin>/services.json → server_id（hex64）+
 * relay URL（manifest 顺序第一条合法条目）。无可用 relay = {ok:false,
 * relayDisabled:true}（fail-closed「中枢未启用中转」）；任何获取失败=
 * {ok:false, error}。
 * @param {string} origin
 * @param {{ fetchImpl: typeof fetch, timeoutMs: number }} ctx
 * @returns {Promise<{ ok: true, serverId: string, relayUrl: string, doc: unknown } | { ok: false, relayDisabled?: boolean, error: string }>}
 */
async function servicesPreflight(origin, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(`${origin}/services.json`, { signal: controller.signal });
    } catch (e) {
      return { ok: false, error: `cannot fetch ${asciiEscape(origin)}/services.json (${asciiEscape(/** @type {Error} */ (e).message)})` };
    }
    if (!res.ok) {
      return { ok: false, error: `${asciiEscape(origin)}/services.json returned HTTP ${res.status}` };
    }
    let doc;
    try {
      doc = await res.json();
    } catch (e) {
      return { ok: false, error: `${asciiEscape(origin)}/services.json is not valid JSON (${asciiEscape(/** @type {Error} */ (e).message)})` };
    }
    let serverId;
    try {
      serverId = serverPublicKeyFromServices(doc);
    } catch (e) {
      return { ok: false, error: `${asciiEscape(origin)}/services.json has no valid server_id (${asciiEscape(/** @type {Error} */ (e).message)})` };
    }
    const relay = selectRelayFromManifest(doc);
    if (!relay.ok) {
      return { ok: false, relayDisabled: true, error: `no usable relay is enabled on ${asciiEscape(origin)}` };
    }
    return { ok: true, serverId, relayUrl: relay.url, doc };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * register 结果（fresh/recovery 共用）。
 * @typedef {{ kind: "ok", parsed: Awaited<ReturnType<typeof parseRegisterResponse>> } | { kind: "network", error: string } | { kind: "http-error", code: string, message: string, status: number } | { kind: "malformed", error: string }} RegisterOutcome
 */

/**
 * 构造签名并发送 POST /register（canonical/PoP 语义见 register.mjs）。
 * @param {{ origin: string, code: string, fabricId: string, rootHex: string, seed: Buffer, alias: string | null, now: () => number, fetchImpl: typeof fetch }} input
 * @returns {Promise<RegisterOutcome>}
 */
async function performRegister({ origin, code, fabricId, rootHex, seed, alias, now, fetchImpl }) {
  const ts = now();
  const canonical = buildRegisterCanonical({ code, fabricIdHex: fabricId, rootHex, ts });
  const sig = signDetached(seed, canonical);
  const body = JSON.stringify({
    code,
    ...(alias !== null ? { alias } : {}),
    fabric_id: fabricId,
    root: rootHex,
    ts,
    sig: toBase64UrlNoPad(sig),
  });
  let res;
  try {
    res = await fetchImpl(`${origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (e) {
    return { kind: "network", error: /** @type {Error} */ (e).message };
  }
  if (!res.ok) {
    // 错误 envelope {"error":{"code","message"}}；未知形态按 HTTP 状态归并
    // （任何分支都不回显请求体——码不落日志）
    let code = "";
    let message = "";
    try {
      const errBody = /** @type {unknown} */ (await res.json());
      const envelope =
        errBody !== null && typeof errBody === "object" && "error" in errBody ? errBody.error : null;
      if (envelope !== null && typeof envelope === "object" && "code" in envelope) {
        if (typeof envelope.code === "string") code = envelope.code;
        if ("message" in envelope && typeof envelope.message === "string") message = envelope.message;
      }
    } catch { /* 非 JSON 错误体：按状态归并 */ }
    return { kind: "http-error", code, message, status: res.status };
  }
  try {
    return { kind: "ok", parsed: parseRegisterResponse(await res.json()) };
  } catch (e) {
    return { kind: "malformed", error: /** @type {Error} */ (e).message };
  }
}

/** 人工恢复文案（code-invalid/code-expired/journal 损坏共用方向） */
const MANUAL_RECOVERY_SUFFIX =
  "manual recovery required: contact the server admin to verify whether this machine's admission tuple was registered, then resolve the pending admission deliberately";

/**
 * join 主流程编排（admission 锁全窗口）：
 *   守卫 → 码规范化 hash → admission 锁 → [journal 恢复 | 迁移 → fabric
 *   preflight → services preflight → journal → register → 回执验签+复核 →
 *   leases 合并 → 清 journal] → 释放。
 * @param {string[]} argv
 * @param {JoinCtx} [ctx]
 * @returns {Promise<number>} 退出码（0 成功；失败 throw CliExit）
 */
export async function runJoin(argv, ctx = {}) {
  const {
    home = process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb"),
    now = Date.now,
    fetchImpl = fetch,
    dns = defaultDns,
    stdout = (line) => console.log(line),
    hostname = os.hostname(),
    isPidAlive,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
  } = ctx;
  const args = parseJoinArgs(argv);
  // 短码直收：dwebh1. 前缀离线 decode（失败=exit 2，不发网络请求）
  const serverUrl = resolveServerArg(args.server);
  const guard = await validateServerUrl(serverUrl, { allowInsecure: args.allowInsecure, dns });
  if (guard.ok === false) throw new CliExit(guard.error, 2);

  // 码规范化+hash（journal 与回执复核共用；非法形态=usage 错误，零网络）
  const codeHash = inviteCodeHashHex(args.code);
  if (codeHash === null) {
    throw new CliExit(
      "--code is not a valid dwebc1 invite code (16 crockford characters after the dwebc1. prefix, case-insensitive, hyphens optional)",
      2,
    );
  }

  // admission 锁（O_EXCL+pid+ts；陈锁 >10s 且 pid 死可打破；退避 ≤3 后报错）
  const admission = await acquireFileLock(fabricLockFile(home), { now, isPidAlive });
  if (!admission.ok) {
    throw new CliExit(
      `another join/admission is already in progress on this machine (${FABRIC_LOCK_FILE} held by pid ${admission.holderPid ?? "unknown"}); retry when it finishes`,
      1,
    );
  }
  try {
    const journalLoad = await loadAdmissionJournal(home);
    if (journalLoad.corrupt === true) {
      throw new CliExit(
        `the pending admission journal (${ADMISSION_JOURNAL_FILE}) is damaged (${asciiEscape(journalLoad.message ?? "unparseable")}); refusing to make any fabric decision; ${MANUAL_RECOVERY_SUFFIX}`,
        1,
      );
    }
    if (journalLoad.corrupt === false && journalLoad.journal !== null) {
      return await recoverPendingAdmission({
        args,
        origin: guard.value.origin,
        codeHash,
        journal: journalLoad.journal,
        ctx: { home, now, fetchImpl, dns, stdout, hostname, isPidAlive, probeTimeoutMs },
      });
    }
    return await freshAdmission({
      args,
      origin: guard.value.origin,
      codeHash,
      ctx: { home, now, fetchImpl, dns, stdout, hostname, isPidAlive, probeTimeoutMs },
    });
  } finally {
    await admission.release();
  }
}

/**
 * 全新入网（无 pending journal）。
 * @param {{ args: { server: string, code: string, fabric: string | undefined, alias: string | undefined, allowInsecure: boolean }, origin: string, codeHash: string, ctx: Required<JoinCtx> }} input
 * @returns {Promise<number>}
 */
async function freshAdmission({ args, origin, codeHash, ctx }) {
  const { home, now, fetchImpl, stdout, hostname, isPidAlive, probeTimeoutMs } = ctx;

  // 设备 key：默认设备 key 即 root（R2）；首启生成属设备级引导（重试复用同
  // 一身份），租约落盘严格后置于兑换成功——失败无半提交
  const { seed, created } = await ensureDeviceSeed(home);
  const rootHex = endpointIdHexFromSeed(seed);

  // 触发式迁移：旧 registration.json（leases.json 缺失时）并入首条
  const migration = await migrateLegacyRegistration(home, {
    fetchImpl,
    probeTimeoutMs,
    now,
    isPidAlive,
    warn: (line) => stdout(line),
  });

  // fabric preflight：既有 roster/租约 fabric_id（单 fabric 约束）
  const leases = await loadLeases(home);
  const legacy = migration.migrated ? null : (await readLegacyRegistration(home)).state;
  const rosterFabricId = await readRosterFabricId(home);
  const resolved = resolveExistingFabricId({ leases: leases.leases, legacy, rosterFabricId });
  if (resolved.ok === false) {
    throw new CliExit(
      `local fabric state is inconsistent (ledger/legacy/roster disagree: ${resolved.conflict.map((f) => f.slice(0, 8) + "…").join(" vs ")}); refusing to join; resolve the mismatch manually`,
      1,
    );
  }
  const { fabricId, origin: fabricOrigin } = selectFabricId({ fabric: args.fabric, existing: resolved.fabricId });
  const { alias: selfAlias, truncated: aliasTruncated } = resolveSelfAlias({ alias: args.alias, hostname });

  // services preflight（先于 register：server_id + relay；无可用 relay=fail-closed）
  const pre = await servicesPreflight(origin, { fetchImpl, timeoutMs: probeTimeoutMs });
  if (pre.ok === false) {
    if (pre.relayDisabled === true) {
      throw new CliExit(
        `the hub has no usable relay enabled; family access cannot be established, so the join was refused before registration (no lease was written) - ask the hub admin to enable the relay service`,
        1,
      );
    }
    throw new CliExit(`join failed: services preflight failed (${pre.error}); nothing was registered and no lease was written`, 1);
  }

  // journal：远端 register 发出前落账（崩溃/响应丢失→恢复状态机）
  await saveAdmissionJournal(home, {
    server: origin,
    code_hash: codeHash,
    fabric_id: fabricId,
    root: rootHex,
    attempt: 1,
    last_error: null,
    ts: now(),
  });
  /** @type {import("./leases.mjs").Journal} */
  const journal = { server: origin, code_hash: codeHash, fabric_id: fabricId, root: rootHex, attempt: 1, last_error: null, ts: now() };

  const outcome = await performRegister({ origin, code: args.code, fabricId, rootHex, seed, alias: selfAlias, now, fetchImpl });
  return await settleRegister({ outcome, journal, pre, args, origin, codeHash, selfAlias, ctx, labels: { fabricOrigin, aliasTruncated, seedCreated: created } });
}

/**
 * pending admission 恢复状态机：拒绝一切新 fabric 决策；重输码 hash 与
 * journal.code_hash 逐一裁决（同码=幂等回放；异码=零副作用）。
 * @param {{ args: { server: string, code: string, fabric: string | undefined, alias: string | undefined, allowInsecure: boolean }, origin: string, codeHash: string, journal: import("./leases.mjs").Journal, ctx: Required<JoinCtx> }} input
 * @returns {Promise<number>}
 */
async function recoverPendingAdmission({ args, origin, codeHash, journal, ctx }) {
  const { home, now, fetchImpl, stdout, hostname, probeTimeoutMs } = ctx;
  if (args.fabric !== undefined && args.fabric.toLowerCase() !== journal.fabric_id) {
    throw new CliExit(
      `a pending admission exists for fabric ${journal.fabric_id.slice(0, 8)}…; no new fabric decision is allowed until it is resolved (re-run join with the original invite code)`,
      1,
    );
  }
  if (origin !== journal.server) {
    throw new CliExit(
      `a pending admission for ${asciiEscape(journal.server)} is unresolved on this machine; re-run join against that server with the original invite code to replay it`,
      1,
    );
  }
  if (codeHash !== journal.code_hash) {
    // 异码绝不修改 journal、绝不生成第二 fabric、零网络
    throw new CliExit(
      `a pending admission from an earlier join attempt exists and requires the SAME invite code that started it; the provided code does not match its hash, so nothing was sent to the server and the journal is untouched`,
      1,
    );
  }
  // 设备身份必须与 journal 同源（root=journal.root）——零网络依赖，先于一切
  // preflight 判定（确定性 fail-closed，不被网络状态掩盖）
  const seed = await loadDeviceSeed(home);
  if (seed === null || endpointIdHexFromSeed(seed) !== journal.root) {
    throw new CliExit(
      `the device key no longer matches the pending admission's root identity; ${MANUAL_RECOVERY_SUFFIX}`,
      1,
    );
  }
  // 同码回放：services preflight（补齐 server_id/relay 供租约落账）
  const pre = await servicesPreflight(journal.server, { fetchImpl, timeoutMs: probeTimeoutMs });
  if (pre.ok === false) {
    await failKeepJournal(home, journal, `services preflight failed (${pre.error})`, now);
    throw new CliExit(
      `replay preflight failed (${pre.error}); the pending admission is kept - re-run join with the same invite code`,
      1,
    );
  }
  const rootHex = journal.root;
  const { alias: selfAlias, truncated: aliasTruncated } = resolveSelfAlias({ alias: args.alias, hostname });

  // 回放 attempt 计数 +1，重签 POST /register（幂等回放，新 ts）
  const replayJournal = { ...journal, attempt: journal.attempt + 1, last_error: null, ts: now() };
  await saveAdmissionJournal(home, replayJournal);
  const outcome = await performRegister({ origin: journal.server, code: args.code, fabricId: journal.fabric_id, rootHex, seed, alias: selfAlias, now, fetchImpl });
  return await settleRegister({
    outcome,
    journal: replayJournal,
    pre,
    args,
    origin: journal.server,
    codeHash,
    selfAlias,
    ctx,
    labels: { fabricOrigin: "reused local fabric", aliasTruncated, seedCreated: false, recovered: replayJournal.attempt },
  });
}

/**
 * register 结算（fresh/recovery 共用）：验签 → tuple/code_hash 复核 →
 * post-register services 复核 → leases 合并（admission 锁内嵌套账本锁）→
 * 清 journal → 输出。任何失败保留 journal 并明确报告远端登记状态。
 * @param {{ outcome: RegisterOutcome, journal: import("./leases.mjs").Journal, pre: { ok: true, serverId: string, relayUrl: string, doc: unknown }, args: { server: string, code: string, fabric: string | undefined, alias: string | undefined, allowInsecure: boolean }, origin: string, codeHash: string, selfAlias: string | null, ctx: Required<JoinCtx>, labels: { fabricOrigin: string, aliasTruncated: boolean, seedCreated: boolean, recovered?: number } }} input
 * @returns {Promise<number>}
 */
async function settleRegister({ outcome, journal, pre, args, origin, codeHash, selfAlias, ctx, labels }) {
  const { home, now, fetchImpl, stdout, isPidAlive, probeTimeoutMs } = ctx;

  /** 远端已受理（或状态未知）时统一提示：经幂等回放可恢复 */
  const replayHint = `the server may already have this machine registered while the local ledger was not updated; re-run join with the SAME invite code - the idempotent replay will complete the ledger`;

  if (outcome.kind === "network") {
    await failKeepJournal(home, journal, `register network error: ${outcome.error}`, now);
    throw new CliExit(
      `join failed: cannot reach ${asciiEscape(origin)}/register (${asciiEscape(outcome.error)}); the request outcome is unknown. ${replayHint}`,
      1,
    );
  }
  if (outcome.kind === "http-error") {
    const human = REGISTER_ERROR_TEXT[/** @type {keyof typeof REGISTER_ERROR_TEXT} */ (outcome.code)];
    if (outcome.code === "code-invalid" || outcome.code === "code-expired") {
      // 同码得 code-invalid/code-expired ≠ 明确未登记（码可能已被本 tuple 兑换
      // 耗尽）——不得据此清 journal
      await failKeepJournal(home, journal, `register rejected: ${outcome.code}`, now);
      throw new CliExit(
        `join failed: the server answered ${human ? human : `code ${outcome.code}`}. This does NOT prove this machine is unregistered (the code may already have been consumed by this very admission); ${MANUAL_RECOVERY_SUFFIX}`,
        1,
      );
    }
    await failKeepJournal(home, journal, `register rejected: ${outcome.code || `http ${outcome.status}`}`, now);
    const suffix =
      outcome.code === "code-pending"
        ? "the pending admission is kept; re-run join with the same invite code in a moment"
        : replayHint;
    if (human) {
      throw new CliExit(`join failed: ${human}; ${suffix}`, 1);
    }
    throw new CliExit(
      `join failed: server returned HTTP ${outcome.status}${outcome.code ? ` (${asciiEscape(outcome.code)})` : ""}${outcome.message ? `: ${asciiEscape(outcome.message)}` : ""}; ${suffix}`,
      1,
    );
  }
  if (outcome.kind === "malformed") {
    await failKeepJournal(home, journal, `malformed success response: ${outcome.error}`, now);
    throw new CliExit(`join failed: malformed success response (${asciiEscape(outcome.error)}). ${replayHint}`, 1);
  }

  const parsed = outcome.parsed;
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
      pre.serverId,
    );
  } catch (e) {
    await failKeepJournal(home, journal, `malformed receipt: ${/** @type {Error} */ (e).message}`, now);
    throw new CliExit(`join failed: malformed receipt (${asciiEscape(/** @type {Error} */ (e).message)}). ${replayHint}`, 1);
  }
  if (!verified) {
    await failKeepJournal(home, journal, "receipt did not verify against preflight server_id", now);
    throw new CliExit(
      `join failed: the register receipt did not verify against this server's server_id (possible tampering). ${replayHint}`,
      1,
    );
  }
  if (parsed.fabricId !== journal.fabric_id || parsed.root !== journal.root) {
    await failKeepJournal(home, journal, "receipt tuple does not match this admission", now);
    throw new CliExit(`join failed: receipt fabric_id/root do not match this admission. ${replayHint}`, 1);
  }
  if (parsed.codeHash !== codeHash) {
    await failKeepJournal(home, journal, "receipt code_hash does not match the normalized invite code", now);
    throw new CliExit(`join failed: receipt code_hash does not match this invite code. ${replayHint}`, 1);
  }

  // post-register 复核：server_id 与 relay URL 必须与 preflight 一致
  const recheck = await servicesPreflight(origin, { fetchImpl, timeoutMs: probeTimeoutMs });
  if (recheck.ok === false || recheck.serverId !== pre.serverId || recheck.relayUrl !== pre.relayUrl) {
    const why = recheck.ok === false
      ? `services re-check failed (${recheck.error})`
      : `server_id/relay changed mid-join (relay ${asciiEscape(pre.relayUrl)} -> ${asciiEscape(/** @type {{ relayUrl: string }} */ (recheck).relayUrl)})`;
    await failKeepJournal(home, journal, why, now);
    throw new CliExit(`join failed: ${why}. ${replayHint}`, 1);
  }

  // leases 合并（admission 锁内嵌套获取 leases 写锁；锁序恒 admission→ledger）
  const merged = await upsertLease(
    home,
    {
      server: origin,
      relayUrl: pre.relayUrl,
      serverId: pre.serverId,
      fabricId: journal.fabric_id,
      root: journal.root,
      alias: selfAlias,
      expiresAt: parsed.expiresAt,
      receipt: {
        ts: parsed.ts,
        generation: parsed.generation,
        code_hash: parsed.codeHash,
        receipt_sig: parsed.receiptSig,
      },
    },
    { now, isPidAlive },
  );
  await clearAdmissionJournal(home);

  const shortId = `${journal.root.slice(0, 3)}***${journal.root.slice(-3)}`;
  const expiry = new Date(parsed.expiresAt).toISOString().slice(0, 10);
  stdout(`joined ${asciiEscape(origin)} as a tenant`);
  if (labels.recovered !== undefined) {
    stdout(`  recovered    pending admission replayed (attempt ${labels.recovered})`);
  }
  stdout(`  endpoint_id  ${journal.root}`);
  stdout(`  short        ${shortId}`);
  if (selfAlias !== null) {
    stdout(`  alias        ${asciiEscape(selfAlias)} (self-reported)`);
  }
  stdout(`  fabric_id    ${journal.fabric_id} (${labels.fabricOrigin === "new" ? "newly generated" : labels.fabricOrigin === "reused" ? "reused local fabric" : "from --fabric"})`);
  stdout(`  relay        ${asciiEscape(pre.relayUrl)}`);
  stdout(`  expires      ${expiry}`);
  stdout(`  receipt      verified (generation ${parsed.generation})`);
  stdout(`  lease        ${merged.entry.id} (${merged.created ? "new entry" : "renewed"}, ${merged.total} in ledger)`);
  stdout(`  state        ${asciiEscape(path.join(home, "leases.json"))}`);
  if (labels.aliasTruncated) {
    stdout(`  note         the self-reported alias exceeded ${ALIAS_MAX_BYTES} UTF-8 bytes and was truncated`);
  }
  if (labels.seedCreated) {
    stdout(`  note         a new device key was created at ${asciiEscape(path.join(home, "identity.key"))} (one default key per device)`);
  }
  if (!merged.lockReleased) {
    stdout(`  note         the leases lock was taken over by another writer; verify the ledger`);
  }
  return 0;
}

/**
 * 失败保账：journal 保留 + last_error/ts 更新（0600 原子写）。
 * @param {string} home
 * @param {import("./leases.mjs").Journal} journal
 * @param {string} lastError
 * @param {() => number} now
 */
async function failKeepJournal(home, journal, lastError, now) {
  await saveAdmissionJournal(home, { ...journal, last_error: lastError, ts: now() });
}

export { loadDeviceSeed };
