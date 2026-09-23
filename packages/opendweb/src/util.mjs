// 共享工具：动态值 ASCII 纪律（D10）、CLI 退出语义与 [H6] 机器名/别名工具。
// 意图（2026-08-29，plugin-marketplace）：bin 与 src 各模块共用，避免双向依赖。
// 意图（2026-09-23，home-hub [H6]）：默认别名=本机机器名——join 自报与
// id 展示共用同一 hostname 规范化 + UTF-8 字节截断实现。
// 意图（2026-09-24，home-hub [H1]/G-5 1e）：接入短码 wire 冻结实现单源
// （design §3.1——CLI util，webui workspace 复用）：CRC-16/CCITT-FALSE +
// crockford-base32 MSB-first + link-local 拒绝 + resolveServerArg。
// 意图（2026-09-24，home-hub 1a/1e）：networkIPv4s/局域网 IPv6 枚举自
// bin/opendweb.mjs 迁入（hub 状态模型与横幅共用；bin 保 re-export 兼容）。

import net from "node:net";
import os from "node:os";

/** 动态值 ASCII 纪律：UTF-8 字节小写 \xNN，控制字符同转义保一行一错误 */
export function asciiEscape(v) {
  const s = String(v);
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * 插件/CLI 统一错误：message 已含 "error: " 前缀语义；exitCode 默认 1。
 * 用法：throw new CliExit("msg", 2)
 */
export class CliExit extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** 读文本文件（ENOENT → null） */
export async function readTextIfExists(fs, path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === "ENOENT") return null;
    throw e;
  }
}

// ---- home-hub [H6]：默认别名 = 本机机器名 --------------------------------------

/** 自报别名上限（与服务端 ALIAS_MAX_BYTES / alias_hint 同拍：≤32 UTF-8 字节） */
export const ALIAS_MAX_BYTES = 32;

/**
 * 本机机器名（[H6] 称呼层默认值）：os.hostname() 剥尾部 `.local` 后缀
 * （macOS Bonjour 形态；大小写不敏感匹配）。空输入透传空（调用方以空
 * 判定「无自报」）。
 * @param {string} [raw] 可注入替身（测试）；缺省 = os.hostname()
 * @returns {string}
 */
export function machineName(raw = os.hostname()) {
  const lower = raw.toLowerCase();
  if (lower.endsWith(".local")) {
    return raw.slice(0, -".local".length);
  }
  return raw;
}

/**
 * 按 UTF-8 字节上限截断到合法字符边界（不劈开多字节字符；[H6] 超限
 * 截断到合法边界并在调用方输出提示）。
 * @param {string} s
 * @param {number} maxBytes
 * @returns {{ value: string, truncated: boolean }}
 */
export function truncateUtf8Bytes(s, maxBytes) {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= maxBytes) return { value: s, truncated: false };
  // 回退到多字节序列的首字节（continuation byte = 10xxxxxx）
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return { value: bytes.subarray(0, cut).toString("utf8"), truncated: true };
}

// ---- 局域网地址枚举（home-hub 1a/1e；自 bin 迁入） ----------------------------

/**
 * IPv4 点分四段数值升序比较（task 9.2 冻结语义，与 Rust 侧统一）：
 * 逐段按数值比较，"9.0.0.1" 必须排在 "10.0.0.2" 之前（字符串字典序则相反）。
 * @param {string} a
 * @param {string} b
 */
function compareIPv4Numeric(a, b) {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < 4; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 枚举本机全部非 loopback IPv4（去重、按点分四段数值升序排序，task 9.2
 * 冻结的跨侧统一语义；Rust 侧对齐由 server 批次负责）。横幅 Network 节
 * 与 services.json 回退地址共用「首个 = 数值最小」的取值语义。
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces]
 * @returns {string[]}
 */
export function networkIPv4s(interfaces = os.networkInterfaces()) {
  const addrs = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const ni of list ?? []) {
      const family = String(ni.family);
      if ((family === "IPv4" || family === "4") && !ni.internal) addrs.push(ni.address);
    }
  }
  return [...new Set(addrs)].sort(compareIPv4Numeric);
}

/**
 * 枚举可呈现/可入短码的 IPv6（design §1.5 r2-P2-6）：仅 ULA（fc00::/7）
 * 与 global（2000::/3）；link-local fe80::/10 拒绝（无 scope id 的短码
 * 无法恢复正确接口），loopback/组播等其余段一并排除。
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces]
 * @returns {string[]}
 */
export function routableIPv6s(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const ni of list ?? []) {
      const family = String(ni.family);
      if ((family !== "IPv6" && family !== "6") || ni.internal) continue;
      const groups = parseIpv6Groups(ni.address);
      if (groups === null) continue;
      const first = groups[0];
      const ula = (first & 0xfe00) === 0xfc00; // fc00::/7
      const global = (first & 0xe000) === 0x2000; // 2000::/3
      if (ula || global) out.push(formatIpv6Groups(groups));
    }
  }
  return [...new Set(out)];
}

// ---- 接入短码（home-hub [H1]/G-5，design §3.1 wire 冻结） ----------------------

/** 短码前缀（呈现与 decode_accepts 均大小写不敏感；canonical 形态小写） */
export const SHORT_CODE_PREFIX = "dwebh1.";

/** crockford base32 字符集（小写；排除歧义字符 i/l/o/u） */
const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 歧义字符 → 规范字符提示映射（decode 拒绝时给用户，绝不自动映射） */
const AMBIGUOUS_HINT = { o: "0", i: "1", l: "1", u: "v" };

/** 字符 → 5bit 值（大小写折叠后查表；歧义字符不在表内=天然拒绝） */
const CROCKFORD_REVERSE = new Map();
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
  CROCKFORD_REVERSE.set(CROCKFORD_ALPHABET[i], i);
}

/**
 * CRC-16/CCITT-FALSE（design §3.1 冻结参数：poly=0x1021/init=0xFFFF/
 * refin=false/refout=false/xorout=0x0000；校验向量 "123456789"→0x29B1）。
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function crc16CcittFalse(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * 字节流 → crockford base32（MSB-first：自最高位每 5 bit 一字符；末尾不足
 * 5 bit 右侧补零；小写无 padding）。
 * @param {Uint8Array | number[]} bytes
 * @returns {string}
 */
function bytesToCrockford(bytes) {
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(acc >>> (bits - 5)) & 0x1f];
      bits -= 5;
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(acc << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * IPv6 文本 → 8 组 16bit（支持 "::" 压缩与 v4-embedded 尾段；zone-id 拒绝）。
 * 非法返回 null。
 * @param {string} ip
 * @returns {number[] | null}
 */
export function parseIpv6Groups(ip) {
  if (typeof ip !== "string" || ip.includes("%")) return null; // scope id 不可入 wire
  // v4-embedded 尾组（::ffff:192.0.2.1）先行拆成两个十六进制组
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const v4 = text.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    const [a, b, c, d] = /** @type {number[]} */ (v4.split(".").map(Number));
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  /** @param {string[]} parts @returns {number[] | null} */
  const parseGroups = (parts) => {
    const out = [];
    for (const g of parts) {
      const v = parseIpv6Group(g);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };
  const dbl = text.indexOf("::");
  if (dbl !== -1) {
    if (text.indexOf("::", dbl + 1) !== -1) return null; // 双 "::" 非法
    const head = text.slice(0, dbl);
    const tail = text.slice(dbl + 2);
    const headParts = head === "" ? [] : head.split(":");
    const tailParts = tail === "" ? [] : tail.split(":");
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 1) return null; // "::" 至少压一组
    const headGroups = parseGroups(headParts);
    const tailGroups = parseGroups(tailParts);
    if (headGroups === null || tailGroups === null) return null;
    return [...headGroups, ...Array.from({ length: missing }, () => 0), ...tailGroups];
  }
  const parts = text.split(":");
  if (parts.length !== 8) return null;
  return parseGroups(parts);
}

/**
 * 单组 IPv6 十六进制（≤4 位、无非法字符；支持 v4-embedded 尾组 "1.2.3.4"
 * 由调用方拆分前处理——本函数只认十六进制组）。
 * @param {string} g
 * @returns {number | null}
 */
function parseIpv6Group(g) {
  if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  return parseInt(g, 16);
}

/**
 * 8 组 16bit → IPv6 规范文本（RFC 5952：小写、去前导零、最长零串 ≥2 组压
 * "::"、并列取首个；V2 断言 fd00…13 → "fd00::13"）。
 * @param {number[]} groups 长度 8
 * @returns {string}
 */
export function formatIpv6Groups(groups) {
  const hex = groups.map((g) => g.toString(16));
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (hex[i] === "0") {
      let j = i;
      while (j < 8 && hex[j] === "0") j++;
      if (j - i > bestLen) {
        bestLen = j - i;
        bestStart = i;
      }
      i = j;
    } else {
      i++;
    }
  }
  if (bestLen < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

/**
 * IPv6 是否 link-local（fe80::/10）——短码/入卡双向拒绝（r2-P2-6）。
 * @param {number[]} groups
 * @returns {boolean}
 */
export function isLinkLocalIpv6(groups) {
  return (groups[0] & 0xffc0) === 0xfe80;
}

/**
 * 编码接入短码（encode_canonical：载荷 `ver(1B)||ip(4/16B)||port(2B BE)` +
 * `crc16(2B BE)` → crockford MSB-first 小写无 padding；返回值 = 小写前缀 +
 * 连续字符（无连字符——呈现分组用 formatShortCodeForDisplay）。
 * IPv4 → 15 字符（5-5-5）；IPv6 → 34 字符（8×4+2）。fe80::/10 拒绝。
 * @param {string} ip
 * @param {number} port
 * @returns {string} canonical 短码（dwebh1.xxxxx…）
 */
export function encodeShortCode(ip, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`short code: invalid port ${port}`);
  }
  /** @type {number[]} */
  let payload;
  if (net.isIPv4(ip)) {
    payload = [0x01, ...ip.split(".").map((s) => Number(s))];
  } else {
    const groups = parseIpv6Groups(ip);
    if (groups === null) throw new Error(`short code: not a valid IPv4/IPv6 address: ${ip}`);
    if (isLinkLocalIpv6(groups)) {
      throw new Error(
        `short code: ${formatIpv6Groups(groups)} is a link-local address (fe80::/10) and cannot be encoded; use a routable ULA or global address`,
      );
    }
    payload = [0x02];
    for (const g of groups) {
      payload.push(g >> 8, g & 0xff);
    }
  }
  payload.push(port >> 8, port & 0xff);
  const crc = crc16CcittFalse(payload);
  const bytes = [...payload, crc >> 8, crc & 0xff];
  return SHORT_CODE_PREFIX + bytesToCrockford(bytes);
}

/**
 * 呈现分组（连字符插入分组边界；IPv4 5-5-5 / IPv6 8×4+2）。
 * 输入须为 canonical（或 decode 可接受的等价串归一后）形态。
 * @param {string} code 含前缀的短码（无连字符形态）
 * @returns {string}
 */
export function formatShortCodeForDisplay(code) {
  const lower = code.toLowerCase();
  const body = lower.startsWith(SHORT_CODE_PREFIX) ? lower.slice(SHORT_CODE_PREFIX.length) : lower;
  const groups =
    body.length === 15 ? [body.slice(0, 5), body.slice(5, 10), body.slice(10, 15)] : chunk(body, 4);
  return SHORT_CODE_PREFIX + groups.join("-");
}

/**
 * @param {string} s
 * @param {number} n
 * @returns {string[]}
 */
function chunk(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** 分组边界（数据字符计数位置；连字符仅可出现在这些位置，逐位置独立可选） */
const HYPHEN_BOUNDARIES = new Map([
  [15, new Set([5, 10])],
  [34, new Set([4, 8, 12, 16, 20, 24, 28, 32])],
]);

/**
 * 解码接入短码（decode_accepts 超集，design §3.1 r4-P2-3）：
 * ① crockford 字符集，歧义字符 o/i/l/u 出现即拒绝（提示映射，不自动映射）；
 * ② 大小写折叠；③ 连字符每个分组位置独立可选（全无/完整/部分接受；错位或
 * 重复拒绝）；④ 前缀大小写不敏感；⑤ 非零 padding 位/多余/缺失字符拒绝。
 * 另校验 ver 字节、CRC 与 link-local（fe80::/10 双向拒绝）。
 * @param {string} raw
 * @returns {{ ip: string, port: number, url: string, family: 4 | 6 }}
 * @throws {Error} 任何拒绝分支（文案自解释，含歧义映射提示）
 */
export function decodeShortCode(raw) {
  if (typeof raw !== "string") throw new Error("short code: input must be a string");
  const prefixMatch = /^dwebh1\./i.exec(raw);
  if (!prefixMatch) {
    throw new Error(`short code: missing "${SHORT_CODE_PREFIX}" prefix`);
  }
  const body = raw.slice(prefixMatch[0].length);
  /** @type {string[]} */
  const dataChars = [];
  let prevHyphen = true; // 起始视为"上一字符是连字符"：首字符不得是连字符
  for (const ch of body) {
    if (ch === "-") {
      if (prevHyphen) throw new Error("short code: repeated or misplaced hyphen");
      prevHyphen = true;
      continue;
    }
    const lower = ch.toLowerCase();
    if (AMBIGUOUS_HINT[lower] !== undefined) {
      throw new Error(
        `short code: ambiguous character "${ch}" (use "${AMBIGUOUS_HINT[lower]}"; crockford excludes i/l/o/u)`,
      );
    }
    if (!CROCKFORD_REVERSE.has(lower)) {
      throw new Error(`short code: invalid character "${ch}"`);
    }
    dataChars.push(lower);
    prevHyphen = false;
  }
  if (dataChars.length === 0) throw new Error("short code: empty payload");
  const boundaries = HYPHEN_BOUNDARIES.get(dataChars.length);
  if (boundaries === undefined) {
    throw new Error(
      `short code: expected 15 characters (IPv4) or 34 characters (IPv6), got ${dataChars.length}`,
    );
  }
  // 连字符位置裁决：重放一遍（此时总长已知，逐位置核分组边界）
  {
    let count = 0;
    for (const ch of body) {
      if (ch === "-") {
        if (!boundaries.has(count)) throw new Error("short code: misplaced hyphen");
      } else {
        count++;
      }
    }
  }
  // 5bit → bit 串（MSB-first）
  /** @type {number[]} */
  const bits = [];
  for (const ch of dataChars) {
    const v = /** @type {number} */ (CROCKFORD_REVERSE.get(ch));
    for (let i = 4; i >= 0; i--) bits.push((v >> i) & 1);
  }
  const totalBits = dataChars.length * 5;
  const neededBits = dataChars.length === 15 ? 72 : 168;
  for (let i = neededBits; i < totalBits; i++) {
    if (bits[i] !== 0) throw new Error("short code: non-zero padding bits");
  }
  /** @param {number} start @param {number} len @returns {number} */
  const readBits = (start, len) => {
    let v = 0;
    for (let i = 0; i < len; i++) v = (v << 1) | bits[start + i];
    return v;
  };
  const ver = readBits(0, 8);
  const ipBytes = dataChars.length === 15 ? 4 : 16;
  if (ver !== 0x01 && ver !== 0x02) {
    throw new Error(`short code: unknown version byte 0x${ver.toString(16).padStart(2, "0")}`);
  }
  if ((ver === 0x01) !== (ipBytes === 4)) throw new Error("short code: version/family mismatch");
  const ipBitsStart = 8;
  const portStart = ipBitsStart + ipBytes * 8;
  /** @type {number[]} */
  const ip = [];
  for (let i = 0; i < ipBytes; i++) ip.push(readBits(ipBitsStart + i * 8, 8));
  const port = readBits(portStart, 16);
  const crcStored = readBits(portStart + 16, 16);
  /** @type {number[]} */
  const payload = [ver, ...ip, port >> 8, port & 0xff];
  const crcActual = crc16CcittFalse(payload);
  if (crcStored !== crcActual) {
    throw new Error(`short code: checksum mismatch (expected 0x${crcActual.toString(16)}, got 0x${crcStored.toString(16)})`);
  }
  if (ver === 0x02) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push((ip[i] << 8) | ip[i + 1]);
    if (isLinkLocalIpv6(groups)) {
      throw new Error(
        "short code: decoded address is link-local (fe80::/10); use a routable ULA or global address",
      );
    }
    const ipText = formatIpv6Groups(groups);
    return { ip: ipText, port, url: `http://[${ipText}]:${port}`, family: 6 };
  }
  return { ip: ip.join("."), port, url: `http://${ip.join(".")}:${port}`, family: 4 };
}

/**
 * `join --server` 参数归一（home-hub 1e 裁决：短码→URL 解析放 util 单源，
 * join.mjs 接线由 Phase 1d 负责）：`dwebh1.` 前缀（大小写不敏感）→ 离线
 * decode 为 `http://<ip>:<port>`（IPv6 bracket 形态）；失败即抛 CliExit
 * 明确报错（调用方不发网络请求）。其余输入原样透传（调用方按 URL 校验）。
 * @param {string} raw
 * @returns {string}
 */
export function resolveServerArg(raw) {
  if (typeof raw === "string" && /^dwebh1\./i.test(raw)) {
    try {
      return decodeShortCode(raw).url;
    } catch (e) {
      throw new CliExit(
        `--server is not a valid access short code: ${/** @type {Error} */ (e).message}`,
        2,
      );
    }
  }
  return raw;
}
