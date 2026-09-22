// @jixo/opendweb-client-sdk ./token —— dweb 邀请/能力令牌只读解码显示
// （sdk-mgmt-surface tasks 3.1-3.3，design §2.3 / specs/sdk/node/spec.md）。
//
// 形态与隔离同 ./admin（design §2.1）：纯 ESM（.mjs + .d.mts）、零运行时
// 依赖、零 import（MUST NOT 引包内 root/net/http——native 隔离）。
//
// 解码不验签（spec 冻结）：无密钥材料，显示用途——调用方安全决策 MUST 依赖
// 服务端验证结果而非本解码。非法输入（前缀/长度/字符集/保留位）抛可判别的
// TokenError，不返回部分解码结果。
//
// wire 权威（server-access-policy design 附录 A + §11.1，随 Rust 实现
// crates/dweb-fabric/src/protocol.rs 同源冻结）：
//
// RelayCapV1（"dwebr1." + base64url-nopad(210B)；canonical 146B + sig 64B）：
//   version u8(0x01) || fabric_id 32B || server_id 32B || issuer 32B ||
//   recipient 32B || caps u8（位图：bit0 relay / bit1 rdzAnnounce /
//   bit2 rdzResolve；高位保留——decode 拒）|| issued_at u64BE ||
//   expires_at u64BE || sig 64B
//
// InviteV2（"dweb2." + base64url-nopad(canonical || sig 64B)；canonical：
//   b"dweb/invite/v2\0"(15B) || version u8(0x02) || fabric_id 32B ||
//   invite_id 16B || issuer 32B || expires_at u64BE || recipient 32B（恒必填）
//   || relay_count u8(≤8) || 每条 { u16 url_len BE || url UTF-8 ||
//   u16 cap_len BE || cap（dwebr1. 串；0 = 无凭证）} ||
//   addr_count u8(≤4) || 每条 { family u8（4=IPv4 4B / 6=IPv6 16B）||
//   addr || port u16BE }
//
// TS 侧与 Rust decode 的差异声明：Rust InviteV2Token::decode 会验签 + 内嵌
// capability 一致性（recipient 绑定 / expires ≤ invite）；本解码器按 spec 只做
// wire 层解析（前缀/长度/字符集/保留位/计数/截断/尾随字节），语义与密码学
// 校验留给服务端验证链。跨语言对拍向量：capability = CROSS_CRATE_CAP_VECTOR
// （crates/dweb-fabric/src/lib.rs:29）；invite = 测试内按附录 A 布局手工拼装
// 的冻结向量（test/token-decode.test.mjs）。

/** 令牌解析错误（spec「非法输入拒绝」）：code 判别 + 人类可读原因。 */
export class TokenError extends Error {
  /**
   * @param {string} code 判别码：bad-input / bad-prefix / bad-base64url /
   *   bad-length / too-long / bad-domain / unsupported-version /
   *   reserved-bits / count-exceeded / length-exceeded / bad-utf8 /
   *   bad-family / truncated / trailing-bytes
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "TokenError";
    this.code = code;
  }
}

const INVITE_PREFIX = "dweb2.";
const CAP_PREFIX = "dwebr1.";
const INVITE2_DOMAIN = Uint8Array.from("dweb/invite/v2\0".split(""), (c) =>
  c.charCodeAt(0),
);
const INVITE2_VERSION = 0x02;
const CAP_VERSION = 0x01;
const SIG_LEN = 64;
/** 附录 A：固定前缀 15+1+32+16+32+8+32 = 136B。 */
const INVITE2_FIXED_LEN = INVITE2_DOMAIN.length + 1 + 32 + 16 + 32 + 8 + 32;
/** 最小 canonical = 固定前缀 + relay_count + addr_count。 */
const INVITE2_MIN_LEN = INVITE2_FIXED_LEN + 1 + 1;
const MAX_RELAYS_V2 = 8;
const MAX_DIRECT_ADDRS = 4;
const MAX_RELAY_URL_BYTES = 2048;
const MAX_RELAY_CAP_BYTES = 512;
/** dwebr1. 串总长 287（7 + 280），base64url payload 恰 280 字符（210B）。 */
const CAP_ENCODED_LEN = 280;
const CAP_WIRE_LEN = 210;
/** C1 长度门（≤ 1KiB；Rust 同值）。 */
const CAP_MAX_TOKEN_LEN = 1024;
/** CapsV1 已知位掩码（relay | rdzAnnounce | rdzResolve）。 */
const CAP_KNOWN_MASK = 0x07;

/**
 * 解码 `dweb2.` 邀请令牌（附录 A wire）→ 字段形态（camelCase 展示形态）。
 * 不验签、不做内嵌 capability 的语义一致性校验（见模块注释）。
 * @param {string} token
 * @returns {Promise<import("./index.d.mts").DecodedInvite>}
 */
export function decodeInvite(token) {
  if (typeof token !== "string") {
    throw new TokenError("bad-input", "decodeInvite: expected a string token");
  }
  if (!token.startsWith(INVITE_PREFIX)) {
    throw new TokenError(
      "bad-prefix",
      `decodeInvite: token must start with ${JSON.stringify(INVITE_PREFIX)}`,
    );
  }
  let payload;
  try {
    payload = fromBase64UrlNoPad(token.slice(INVITE_PREFIX.length), "decodeInvite");
  } catch (err) {
    throw new TokenError("bad-base64url", err instanceof Error ? err.message : String(err));
  }
  if (payload.length < SIG_LEN + INVITE2_MIN_LEN) {
    throw new TokenError(
      "truncated",
      `decodeInvite: payload shorter than the fixed prefix + signature (${payload.length}B)`,
    );
  }
  // 尾部 64B 为签名（本解码不消费、不校验）；前段是 canonical
  const bytes = payload.subarray(0, payload.length - SIG_LEN);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let off = 0;
  const take = (n, what) => {
    if (off + n > bytes.length) {
      throw new TokenError("truncated", `decodeInvite: truncated ${what}`);
    }
    const s = bytes.subarray(off, off + n);
    off += n;
    return s;
  };
  const u16 = () => {
    if (off + 2 > bytes.length) {
      throw new TokenError("truncated", `decodeInvite: truncated u16 field at offset ${off}`);
    }
    const v = (bytes[off] << 8) | bytes[off + 1];
    off += 2;
    return v;
  };
  const u64 = () => {
    if (off + 8 > bytes.length) {
      throw new TokenError("truncated", `decodeInvite: truncated u64 field at offset ${off}`);
    }
    const v = readU64BE(bytes, off);
    off += 8;
    return v;
  };
  const utf8 = (buf, what) => {
    try {
      return decoder.decode(buf);
    } catch {
      throw new TokenError("bad-utf8", `decodeInvite: ${what} is not valid UTF-8`);
    }
  };

  for (let i = 0; i < INVITE2_DOMAIN.length; i++) {
    if (bytes[i] !== INVITE2_DOMAIN[i]) {
      throw new TokenError("bad-domain", "decodeInvite: bad invite v2 domain prefix");
    }
  }
  off = INVITE2_DOMAIN.length;
  if (bytes[off] !== INVITE2_VERSION) {
    throw new TokenError(
      "unsupported-version",
      `decodeInvite: unsupported invite v2 version 0x${hex1(bytes[off])}`,
    );
  }
  off += 1;
  const fabricId = bytesToHex(take(32, "fabric_id"));
  const inviteId = bytesToHex(take(16, "invite_id"));
  const issuer = bytesToHex(take(32, "issuer"));
  const expiresAtMs = u64();
  const recipient = bytesToHex(take(32, "recipient"));

  const relayCount = bytes[off];
  off += 1;
  if (relayCount > MAX_RELAYS_V2) {
    throw new TokenError(
      "count-exceeded",
      `decodeInvite: ${relayCount} relays exceeds the limit of ${MAX_RELAYS_V2}`,
    );
  }
  const relays = [];
  for (let i = 0; i < relayCount; i++) {
    const urlLen = u16();
    if (urlLen > MAX_RELAY_URL_BYTES) {
      throw new TokenError(
        "length-exceeded",
        `decodeInvite: relay ${i} URL of ${urlLen} bytes exceeds ${MAX_RELAY_URL_BYTES}`,
      );
    }
    const url = utf8(take(urlLen, `relay ${i} url`), `relay ${i} url`);
    const capLen = u16();
    if (capLen > MAX_RELAY_CAP_BYTES) {
      throw new TokenError(
        "length-exceeded",
        `decodeInvite: relay ${i} capability of ${capLen} bytes exceeds ${MAX_RELAY_CAP_BYTES}`,
      );
    }
    const capability =
      capLen === 0 ? null : utf8(take(capLen, `relay ${i} capability`), `relay ${i} capability`);
    relays.push({ url, capability, hasCapability: capability !== null });
  }

  const addrCount = bytes[off];
  off += 1;
  if (addrCount > MAX_DIRECT_ADDRS) {
    throw new TokenError(
      "count-exceeded",
      `decodeInvite: ${addrCount} direct addrs exceeds the limit of ${MAX_DIRECT_ADDRS}`,
    );
  }
  const directAddrs = [];
  for (let i = 0; i < addrCount; i++) {
    if (off >= bytes.length) {
      throw new TokenError("truncated", `decodeInvite: truncated direct addr ${i} family tag`);
    }
    const family = bytes[off];
    off += 1;
    if (family === 4) {
      const ip = take(4, `direct addr ${i} v4 bytes`);
      const port = u16();
      directAddrs.push(`${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}:${port}`);
    } else if (family === 6) {
      const ip = take(16, `direct addr ${i} v6 bytes`);
      const port = u16();
      directAddrs.push(`${formatIpv6(ip)}:${port}`);
    } else {
      throw new TokenError(
        "bad-family",
        `decodeInvite: direct addr ${i} has unknown family tag 0x${hex1(family)}`,
      );
    }
  }
  if (off !== bytes.length) {
    throw new TokenError(
      "trailing-bytes",
      `decodeInvite: length mismatch: expected ${off} canonical bytes, got ${bytes.length}`,
    );
  }
  return { fabricId, inviteId, issuer, expiresAtMs, recipient, relays, directAddrs };
}

/**
 * 解码 `dwebr1.` 能力令牌（§11.1 wire：210B = canonical 146B + sig 64B）。
 * caps 位图命名展开 {relay, rdzAnnounce, rdzResolve}；保留位拒收。
 * 不验签（sig 原样透出 hex128 供调用方自行验证）。
 * @param {string} token
 * @returns {import("./index.d.mts").DecodedCapability}
 */
export function decodeCapability(token) {
  if (typeof token !== "string") {
    throw new TokenError("bad-input", "decodeCapability: expected a string token");
  }
  if (!token.startsWith(CAP_PREFIX)) {
    throw new TokenError(
      "bad-prefix",
      `decodeCapability: token must start with ${JSON.stringify(CAP_PREFIX)}`,
    );
  }
  if (token.length > CAP_MAX_TOKEN_LEN) {
    throw new TokenError(
      "too-long",
      `decodeCapability: token exceeds the ${CAP_MAX_TOKEN_LEN} byte length gate`,
    );
  }
  const encoded = token.slice(CAP_PREFIX.length);
  if (encoded.length !== CAP_ENCODED_LEN) {
    throw new TokenError(
      "bad-length",
      `decodeCapability: payload must be ${CAP_ENCODED_LEN} base64url characters (${CAP_WIRE_LEN}B wire); got ${encoded.length}`,
    );
  }
  let wire;
  try {
    wire = fromBase64UrlNoPad(encoded, "decodeCapability");
  } catch (err) {
    throw new TokenError("bad-base64url", err instanceof Error ? err.message : String(err));
  }
  if (wire.length !== CAP_WIRE_LEN) {
    throw new TokenError(
      "bad-length",
      `decodeCapability: wire must decode to ${CAP_WIRE_LEN}B; got ${wire.length}`,
    );
  }
  if (wire[0] !== CAP_VERSION) {
    throw new TokenError(
      "unsupported-version",
      `decodeCapability: unsupported version 0x${hex1(wire[0])} (expected 0x01)`,
    );
  }
  const capsBits = wire[129];
  if ((capsBits & ~CAP_KNOWN_MASK) !== 0) {
    throw new TokenError(
      "reserved-bits",
      `decodeCapability: caps 0x${hex1(capsBits)} contains reserved bits (known mask 0x${hex1(CAP_KNOWN_MASK)})`,
    );
  }
  return {
    fabricId: bytesToHex(wire.subarray(1, 33)),
    serverId: bytesToHex(wire.subarray(33, 65)),
    issuer: bytesToHex(wire.subarray(65, 97)),
    recipient: bytesToHex(wire.subarray(97, 129)),
    capsBits,
    caps: {
      relay: (capsBits & 0x01) !== 0,
      rdzAnnounce: (capsBits & 0x02) !== 0,
      rdzResolve: (capsBits & 0x04) !== 0,
    },
    issuedAt: readU64BE(wire, 130),
    expiresAt: readU64BE(wire, 138),
    signature: bytesToHex(wire.subarray(146, 210)),
  };
}

// ---- 内部：编解码助手（零依赖；与 admin/ 各持一份同款，两 subpath 自包含） ----

/** u64 大端读取（毫秒时间戳域 << 2^53，Number 精确）。 */
function readU64BE(bytes, off) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Number(view.getBigUint64(off, false));
}

/** 小写 hex（与 Rust hex::encode 同形态）。 */
function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function hex1(b) {
  return b.toString(16).padStart(2, "0");
}

const B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64U_INDEX = new Map();
for (let i = 0; i < B64U_ALPHABET.length; i++) {
  B64U_INDEX.set(B64U_ALPHABET[i], i);
}

/** 严格 base64url-nopad 解码（白名单字符集 + 零尾位校验；reject "=" pad）。 */
function fromBase64UrlNoPad(s, label) {
  if (typeof s !== "string") {
    throw new TypeError(`${label}: expected a base64url-nopad string`);
  }
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64U_INDEX.get(s[i]);
    if (v === undefined) {
      throw new TypeError(
        `${label}: invalid base64url character ${JSON.stringify(s[i])} at index ${i}`,
      );
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
  return Uint8Array.from(out);
}

/**
 * IPv6 展示形态（RFC 5952：小写 hex、无前导零、最长的 ≥2 组零段压缩成 ::、
 * 左优先——与 Rust std SocketAddr Display 同形态）。
 */
function formatIpv6(octets) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((octets[i] << 8) | octets[i + 1]).toString(16));
  }
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === "0") {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen >= 2) {
    const head = groups.slice(0, bestStart).join(":");
    const tail = groups.slice(bestStart + bestLen).join(":");
    return `[${head}::${tail}]`;
  }
  return `[${groups.join(":")}]`;
}
