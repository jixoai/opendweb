// POST /register 客户端协议面（server-access-roles Phase 3，cli/identity）。
// canonical 冻结（server spec delta「租户邀请码与公开自助注册」+ r7 基线
// 第 1/9 条，不得偏离）：
//   register:  b"dweb/register/v1\0"        || code(utf8) || fabric_id(hex64 utf8)
//              || root(hex64 utf8) || ts(u64BE)      —— root PoP 域
//   receipt:   b"dweb/register-receipt/v1\0" || code_hash 32B || fabric 32B
//              || root 32B || ts u64BE || generation u64BE   —— server.key 回执
// 回执验签公钥 = ServerId（hex64 小写），公开获取通道 = GET /services.json 的
// server_id 字段（server-access-policy task 1.8 既有公告；client-sdk ./admin
// 的 adminPublicKeyFromServices 同源结论）。
// wire 约定（与 sdk-mgmt-surface 冻结家族一致）：JSON snake_case、未知字段
// 忽略、错误 envelope {"error":{"code","message"}}、签名 base64url-nopad。

import { endpointIdHexFromSeed, signDetached, verifyDetached } from "./ed25519.mjs";
import { blake3Hex } from "./blake3.mjs";

/** PoP 域分隔符（17 字节域 + NUL = 18B） */
export const REGISTER_DOMAIN = Buffer.from("dweb/register/v1\0", "utf8");
/** 回执域分隔符（24 字节域 + NUL = 25B） */
export const RECEIPT_DOMAIN = Buffer.from("dweb/register-receipt/v1\0", "utf8");
/** 回执 canonical 定长：25 域 + 32×3 + 8×2 = 137B */
export const RECEIPT_CANONICAL_LEN = RECEIPT_DOMAIN.length + 32 * 3 + 8 * 2;

/** hex64 白名单（与 client-sdk ./admin 同规） */
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
/** base64url 字母表（严格 nopad 解码用） */
const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * hex64 校验 + 小写规范化（fail-fast，canonical 前置）。
 * @param {unknown} value
 * @param {string} label
 * @returns {string} 小写 hex64
 */
function requireHex64(value, label) {
  if (typeof value !== "string" || !HEX64_RE.test(value)) {
    throw new TypeError(`${label} must be 64 hex characters (32 bytes)`);
  }
  return value.toLowerCase();
}

/**
 * u64 大端写入（安全整数域；DataView.setBigUint64 big-endian）。
 * @param {Uint8Array} out
 * @param {number} offset
 * @param {unknown} value
 * @param {string} label
 */
function u64BE(out, offset, value, label) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(`${label} must be a safe non-negative integer`);
  }
  new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(offset, BigInt(value), false);
}

/**
 * register PoP canonical（spec 冻结：被签载荷含 root，域序固定不可重排）。
 * code/fabric_id/root 按其 body 字符串原文（fabric/root 小写规范化后）UTF-8
 * 拼接——服务端以 body 字段重建同串验签，客户端必须签「所发即所签」。
 * @param {{ code: string, fabricIdHex: string, rootHex: string, ts: number }} input
 * @returns {Buffer}
 */
export function buildRegisterCanonical({ code, fabricIdHex, rootHex, ts }) {
  if (typeof code !== "string" || code.length === 0) {
    throw new TypeError("buildRegisterCanonical: code must be a non-empty string");
  }
  const fabric = requireHex64(fabricIdHex, "buildRegisterCanonical: fabric_id");
  const root = requireHex64(rootHex, "buildRegisterCanonical: root");
  const tsBuf = Buffer.alloc(8);
  u64BE(tsBuf, 0, ts, "buildRegisterCanonical: ts");
  return Buffer.concat([REGISTER_DOMAIN, Buffer.from(code, "utf8"), Buffer.from(fabric, "utf8"), Buffer.from(root, "utf8"), tsBuf]);
}

/**
 * register-receipt canonical（server spec 冻结 137B 定长；code_hash/fabric/
 * root 为 32B 原始字节而非 hex 文本；回执不含 code 本体）。
 * @param {{ codeHashHex: string, fabricIdHex: string, rootHex: string, ts: number, generation: number }} input
 * @returns {Buffer} 137B
 */
export function buildRegisterReceiptCanonical({ codeHashHex, fabricIdHex, rootHex, ts, generation }) {
  const out = new Uint8Array(RECEIPT_CANONICAL_LEN);
  out.set(RECEIPT_DOMAIN, 0);
  out.set(hexToBytes32(codeHashHex, "code_hash"), RECEIPT_DOMAIN.length);
  out.set(hexToBytes32(fabricIdHex, "fabric_id"), RECEIPT_DOMAIN.length + 32);
  out.set(hexToBytes32(rootHex, "root"), RECEIPT_DOMAIN.length + 64);
  u64BE(out, RECEIPT_DOMAIN.length + 96, ts, "ts");
  u64BE(out, RECEIPT_DOMAIN.length + 104, generation, "generation");
  return Buffer.from(out);
}

/**
 * hex64 → 32B（canonical 布局槽位）。
 * @param {unknown} value
 * @param {string} label
 * @returns {Uint8Array}
 */
function hexToBytes32(value, label) {
  const hex = requireHex64(value, label);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 严格 base64url-nopad 解码（白名单字符集 + 零尾位校验；reject "=" pad）。
 * 与 client-sdk ./admin 的同款实现逐字对齐（两目录互不依赖，各持一份）。
 * @param {unknown} s
 * @param {string} label
 * @returns {Buffer}
 */
function fromBase64UrlNoPad(s, label) {
  if (typeof s !== "string" || s.length === 0) {
    throw new TypeError(`${label}: expected a non-empty base64url-nopad string`);
  }
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64U_ALPHABET.indexOf(s[i]);
    if (v === -1) {
      throw new TypeError(`${label}: invalid base64url character ${JSON.stringify(s[i])} at index ${i}`);
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new TypeError(`${label}: non-zero trailing bits (not canonical base64url-nopad)`);
  }
  return Buffer.from(out);
}

/** base64url-nopad 编码（64B 签名 → 86 字符） */
export function toBase64UrlNoPad(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * 从 services.json（server-access-policy task 1.8 的 server_id 公告字段）
 * 提取回执验签公钥（Ed25519 verifying key = ServerId，hex64 小写）。
 * @param {string | object} servicesJson services.json 文本或已解析对象
 * @returns {string} 64-hex 公钥
 */
export function serverPublicKeyFromServices(servicesJson) {
  const doc = typeof servicesJson === "string" ? JSON.parse(servicesJson) : servicesJson;
  if (doc === null || typeof doc !== "object") {
    throw new TypeError("services.json must be an object or a JSON string");
  }
  const id = /** @type {Record<string, unknown>} */ (doc).server_id;
  if (typeof id !== "string" || !HEX64_RE.test(id)) {
    throw new TypeError("services.json server_id must be 64 hex characters");
  }
  return id.toLowerCase();
}

/**
 * 解析 /register 成功响应（200）：回执字段 + expires_at；未知字段忽略
 * （wire 兼容规则）。畸形响应 TypeError（fail-closed，不落入半提交）。
 * @param {unknown} body 已 JSON.parse 的响应体
 * @returns {{ op: string | null, ts: number, generation: number, fabricId: string, root: string, codeHash: string, expiresAt: number, receiptSig: string }}
 */
export function parseRegisterResponse(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("register response must be a JSON object");
  }
  const o = /** @type {Record<string, unknown>} */ (body);
  /** @type {string | null} */
  let op = null;
  if (o.op !== undefined) {
    if (o.op !== "register") {
      throw new TypeError(`register response op must be "register" (got ${JSON.stringify(o.op)})`);
    }
    op = o.op;
  }
  const ts = o.ts;
  const generation = o.generation;
  const expiresAt = o.expires_at;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("register response ts must be a non-negative integer");
  }
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) {
    throw new TypeError("register response generation must be a non-negative integer");
  }
  if (typeof expiresAt !== "number" || !Number.isInteger(expiresAt) || expiresAt < 0) {
    throw new TypeError("register response expires_at must be a non-negative integer (u64 ms)");
  }
  const receiptSig = o.receipt_sig;
  if (typeof receiptSig !== "string" || receiptSig === "") {
    throw new TypeError("register response receipt_sig must be a base64url-nopad string");
  }
  return {
    op,
    ts,
    generation,
    fabricId: requireHex64(o.fabric_id, "register response fabric_id"),
    root: requireHex64(o.root, "register response root"),
    codeHash: requireHex64(o.code_hash, "register response code_hash"),
    expiresAt,
    receiptSig,
  };
}

/**
 * register-receipt 客户端验签 helper（spec：含 register-receipt 验签能力）。
 * 公钥由调用方注入（join 命令从 <server>/services.json 的 server_id 获取；
 * 也可手工注入以离线核验已保存的回执）。
 * @param {{ ts: number, generation: number, fabricIdHex: string, rootHex: string, codeHashHex: string, receiptSig: string }} receipt
 * @param {string} serverPublicKeyHex ServerId（hex64）
 * @returns {boolean}
 */
export function verifyRegisterReceipt(receipt, serverPublicKeyHex) {
  const sig = fromBase64UrlNoPad(receipt.receiptSig, "receipt_sig");
  if (sig.length !== 64) {
    throw new TypeError(`receipt_sig must decode to exactly 64 bytes (got ${sig.length})`);
  }
  const canonical = buildRegisterReceiptCanonical(receipt);
  return verifyDetached(serverPublicKeyHex, canonical, sig);
}

// ---- 邀请码规范化 + 哈希（home-hub Phase 1d；语义冻结对拍 dweb-server
// access/codes.rs normalize_code_body/code_hash，frozen 向量在
// test/leases.test.mjs） -----------------------------------------------------

/** 邀请码前缀（与 Rust CODE_PREFIX 同拍） */
export const INVITE_CODE_PREFIX = "dwebc1.";

/** 规范化本体长度（16 字符小写 crockford） */
const INVITE_CODE_BODY_LEN = 16;

/** crockford 小写字符集（排除 i/l/o/u） */
const CROCKFORD_LOWER = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * 邀请码规范化（Rust normalize_code_body 逐语义移植）：首尾空白容忍、
 * `dwebc1.` 前缀大小写不敏感剥除、连字符剔除、ASCII 大写折叠；最终必须
 * 恰 16 字符且全部属 crockford 小写集。歧义字符（i/l/o/u）与其他非法
 * 字符同样拒绝（不自动映射）。返回 null = 拒绝。
 * @param {string} raw
 * @returns {string | null} 规范化 16 字符本体（null = 非法形态）
 */
export function normalizeInviteCode(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const head = s.slice(0, INVITE_CODE_PREFIX.length).toLowerCase();
  const body = head === INVITE_CODE_PREFIX ? s.slice(INVITE_CODE_PREFIX.length) : s;
  let normalized = "";
  for (const c of body) {
    if (c === "-") continue;
    // 仅 ASCII A-Z 折叠（Rust to_ascii_lowercase 语义；非 ASCII 原样进集合校验被拒）
    const code = c.charCodeAt(0);
    normalized += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : c;
  }
  if (normalized.length !== INVITE_CODE_BODY_LEN) return null;
  for (const c of normalized) {
    if (!CROCKFORD_LOWER.includes(c)) return null;
  }
  return normalized;
}

/**
 * 码哈希（Rust code_hash 语义：blake3(规范化本体字节) → 64 hex）。
 * 输入为原始用户输入；非法形态返回 null（调用方 fail-fast）。
 * @param {string} raw
 * @returns {string | null}
 */
export function inviteCodeHashHex(raw) {
  const normalized = normalizeInviteCode(raw);
  return normalized === null ? null : blake3Hex(Buffer.from(normalized, "ascii"));
}

// ---- 便捷再导出（join 命令直接组包） ----------------------------------------

export { endpointIdHexFromSeed, signDetached };
