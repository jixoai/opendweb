// 接入短码 wire 冻结测试（home-hub 1e，specs/cli/hub「接入短码」）：
// golden vectors V1/V2（载荷+CRC hex 与呈现形态）、往返、逐位篡改、零位
// padding 变体、歧义字符（o/i/l/u 拒绝+映射提示）、错位/重复连字符、
// 大小写折叠、部分连字符、前缀大小写、长度与 padding 纪律、link-local
// 双向拒绝、resolveServerArg 离线解析（失败即报错零网络）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  CliExit,
  crc16CcittFalse,
  decodeShortCode,
  encodeShortCode,
  formatIpv6Groups,
  formatShortCodeForDisplay,
  parseIpv6Groups,
  resolveServerArg,
} from "../src/util.mjs";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** 与实现同规的本地 crockford 编码器（测试独立重推导，防同源盲区） */
function localCrockford(bytes) {
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 0x1f];
      bits -= 5;
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 0x1f];
  return out;
}

/** 手工构造任意载荷的短码（绕过 encode 的 link-local/ver 校验，供负例） */
function rawCode(bytes) {
  return "dwebh1." + localCrockford(bytes);
}

test("crc16CcittFalse: check vector \"123456789\" -> 0x29B1", () => {
  assert.equal(crc16CcittFalse(Buffer.from("123456789", "ascii")), 0x29b1);
});

test("golden vector V1 (IPv4 192.168.2.13:8787)", () => {
  const code = encodeShortCode("192.168.2.13", 8787);
  assert.equal(code, "dwebh1.070ag0gd499qnz8");
  assert.equal(formatShortCodeForDisplay(code), "dwebh1.070ag-0gd49-9qnz8");
  // 载荷+CRC（hex）冻结：01 c0a8020d 2253 | 7afd（8787 = 0x2253 大端；CRC=0x7AFD）
  const payload = [0x01, 192, 168, 2, 13, 0x22, 0x53];
  assert.equal(crc16CcittFalse(payload), 0x7afd);
  assert.equal(rawCode([...payload, 0x7a, 0xfd]), code);
});

test("golden vector V2 (IPv6 [fd00::13]:8787)", () => {
  const code = encodeShortCode("fd00::13", 8787);
  assert.equal(code, "dwebh1.0byg00000000000000000000009j4mz50r");
  assert.equal(formatShortCodeForDisplay(code), "dwebh1.0byg-0000-0000-0000-0000-0000-009j-4mz5-0r");
  const decoded = decodeShortCode("dwebh1.0byg-0000-0000-0000-0000-0000-009j-4mz5-0r");
  assert.equal(decoded.url, "http://[fd00::13]:8787");
  assert.equal(decoded.ip, "fd00::13");
  assert.equal(decoded.port, 8787);
});

test("length freeze: IPv4=15 chars (5-5-5), IPv6=34 chars (8x4+2)", () => {
  assert.equal(encodeShortCode("192.0.2.1", 8787).slice("dwebh1.".length).length, 15);
  const v6 = encodeShortCode("fd00::1", 8787).slice("dwebh1.".length);
  assert.equal(v6.length, 34);
  const groups = formatShortCodeForDisplay("dwebh1." + v6).slice("dwebh1.".length).split("-");
  assert.deepEqual(groups.map((g) => g.length), [4, 4, 4, 4, 4, 4, 4, 4, 2]);
});

test("roundtrip: IPv4/IPv6 encode -> decode restores ip:port and bracket URL", () => {
  const cases = [
    ["192.168.2.13", 8787],
    ["10.0.0.42", 18787],
    ["172.16.31.254", 65535],
    ["fd00::13", 8787],
    ["fd12:3456:789a:bcde::1", 3340],
    ["2001:db8::ff", 443],
  ];
  for (const [ip, port] of cases) {
    const decoded = decodeShortCode(encodeShortCode(ip, port));
    const expectedIp = ip.includes(":") ? formatIpv6Groups(/** @type {number[]} */ (parseIpv6Groups(ip))) : ip;
    assert.equal(decoded.ip, expectedIp, `${ip}`);
    assert.equal(decoded.port, port);
    if (expectedIp.includes(":")) {
      assert.equal(decoded.url, `http://[${expectedIp}]:${port}`);
    } else {
      assert.equal(decoded.url, `http://${expectedIp}:${port}`);
    }
  }
});

test("tamper: every single-char substitution of the V1 body is rejected", () => {
  const body = "070ag0gd499qnz8";
  for (let i = 0; i < body.length; i++) {
    for (const ch of CROCKFORD) {
      if (ch === body[i]) continue;
      const tampered = "dwebh1." + body.slice(0, i) + ch + body.slice(i + 1);
      assert.throws(() => decodeShortCode(tampered), undefined, `position ${i} char ${ch}`);
    }
  }
});

test("tamper: single-char substitutions of the V2 body are rejected", () => {
  const body = "0byg00000000000000000000009j4mz50r";
  // 逐位全扫太慢（34×31）——抽密集样本：每位置取 3 个异字符
  for (let i = 0; i < body.length; i++) {
    let tried = 0;
    for (const ch of CROCKFORD) {
      if (ch === body[i] || tried >= 3) continue;
      tried++;
      const tampered = "dwebh1." + body.slice(0, i) + ch + body.slice(i + 1);
      assert.throws(() => decodeShortCode(tampered), undefined, `v2 position ${i} char ${ch}`);
    }
  }
});

test("padding discipline: last char replaced with non-zero padding-bit variant is rejected", () => {
  // V1 末字符 '8' = 01000：高 2 bit 数据 + 低 3 bit padding（必须为零）。
  // 换成低 3 bit 非零的同数据字符（'9'=01001、'a'=01010、'b'=01011 …）= 非规范等价串。
  const body = "070ag0gd499qnz8";
  for (const ch of ["9", "a", "b", "c", "d", "e", "f", "g", "h"]) {
    assert.throws(() => decodeShortCode("dwebh1." + body.slice(0, -1) + ch), undefined, `pad variant ${ch}`);
  }
  // 反向：末字符非零 padding 的整串（末字符本不该出现）同样在 decode 拒绝
  assert.throws(() => decodeShortCode("dwebh1.070ag-0gd49-9qnz9"));
});

test("ambiguous characters o/i/l/u are rejected with mapping hints (no auto-mapping)", () => {
  const body = "070ag0gd499qnz8";
  const cases = [
    ["o", /"o" \(use "0"/],
    ["i", /"i" \(use "1"/],
    ["l", /"l" \(use "1"/],
    ["u", /"u" \(use "v"/],
  ];
  for (const [bad, hint] of cases) {
    assert.throws(
      () => decodeShortCode("dwebh1." + bad + body.slice(1)),
      (e) => e instanceof Error && hint.test(e.message),
      `ambiguous ${bad} must be rejected with hint`,
    );
    // 大写歧义字符同样拒绝（大小写折叠不豁免 o/i/l/u）
    assert.throws(() => decodeShortCode("dwebh1." + bad.toUpperCase() + body.slice(1)));
  }
});

test("hyphens: none / full / partial per-group accepted; misplaced, doubled, edge rejected", () => {
  const none = "dwebh1.070ag0gd499qnz8";
  const full = "dwebh1.070ag-0gd49-9qnz8";
  const partial = "dwebh1.070ag0gd49-9qnz8";
  const partial2 = "dwebh1.070ag-0gd499qnz8";
  for (const ok of [none, full, partial, partial2]) {
    assert.equal(decodeShortCode(ok).url, "http://192.168.2.13:8787", ok);
  }
  // 错位（非分组边界）
  assert.throws(() => decodeShortCode("dwebh1.070a-g0gd499qnz8"), /misplaced hyphen/);
  assert.throws(() => decodeShortCode("dwebh1.070ag0gd4-99qnz8"), /misplaced hyphen/);
  // 重复 / 首尾
  assert.throws(() => decodeShortCode("dwebh1.070ag--0gd49-9qnz8"), /misplaced|repeated/);
  assert.throws(() => decodeShortCode("dwebh1.-070ag0gd499qnz8"), /misplaced|repeated/);
  assert.throws(() => decodeShortCode("dwebh1.070ag-0gd49-9qnz8-"), /misplaced|repeated|trailing/);
});

test("case folding: any mixed case accepted; prefix case-insensitive", () => {
  assert.equal(decodeShortCode("DWEBH1.070AG-0GD49-9QNZ8").url, "http://192.168.2.13:8787");
  assert.equal(decodeShortCode("DwebH1.070aG-0gD49-9Qnz8").url, "http://192.168.2.13:8787");
});

test("length discipline: missing/extra characters rejected; prefix required", () => {
  assert.throws(() => decodeShortCode("dwebh1.070ag0gd499qnz"), /expected 15 characters/);
  assert.throws(() => decodeShortCode("dwebh1.070ag0gd499qnz80"), /expected 15 characters/);
  assert.throws(() => decodeShortCode("070ag0gd499qnz8"), /missing "dwebh1\." prefix/);
  assert.throws(() => decodeShortCode("dwebh2.070ag0gd499qnz8"), /missing "dwebh1\." prefix/);
});

test("link-local fe80::/10 rejected in both directions with ULA/global hint", () => {
  assert.throws(() => encodeShortCode("fe80::1", 8787), /link-local.*ULA or global/);
  assert.throws(() => encodeShortCode("fe89::1", 8787), /link-local/);
  // 解码端：手工构造 fe80 载荷（绕过 encode 门）
  const groups = /** @type {number[]} */ (parseIpv6Groups("fe80::1"));
  assert.notEqual(groups, null);
  const payload = [0x02];
  for (const g of /** @type {number[]} */ (groups)) payload.push(g >> 8, g & 0xff);
  payload.push(0x22, 0x63);
  const crc = crc16CcittFalse(payload);
  assert.throws(() => decodeShortCode(rawCode([...payload, crc >> 8, crc & 0xff])), /link-local/);
});

test("version byte discipline: unknown version rejected", () => {
  const payload = [0x03, 192, 168, 2, 13, 0x22, 0x63];
  const crc = crc16CcittFalse(payload);
  assert.throws(() => decodeShortCode(rawCode([...payload, crc >> 8, crc & 0xff])), /unknown version/);
  // ver=0x02 但 IPv4 长度（15 字符）→ family mismatch
  const p2 = [0x02, 192, 168, 2, 13, 0x22, 0x63];
  const c2 = crc16CcittFalse(p2);
  assert.throws(() => decodeShortCode(rawCode([...p2, c2 >> 8, c2 & 0xff])), /version\/family mismatch/);
});

test("crc mismatch rejected (payload corrupted with valid charset)", () => {
  // 篡改 CRC 字节本身（构造载荷+CRC 后翻转一个 ip 字节并重算——不重算即 mismatch）
  const payload = [0x01, 192, 168, 2, 13, 0x22, 0x63];
  const crc = crc16CcittFalse(payload);
  const wrongCrc = crc ^ 0x0001;
  assert.throws(() => decodeShortCode(rawCode([...payload, wrongCrc >> 8, wrongCrc & 0xff])), /checksum mismatch/);
});

test("encode input discipline: invalid ip / port rejected", () => {
  assert.throws(() => encodeShortCode("not-an-ip", 8787), /not a valid/);
  assert.throws(() => encodeShortCode("192.168.2", 8787), /not a valid/);
  assert.throws(() => encodeShortCode("192.168.2.13", 0), /invalid port/);
  assert.throws(() => encodeShortCode("192.168.2.13", 65536), /invalid port/);
  assert.throws(() => encodeShortCode("fd00::13%en0", 8787), /not a valid/);
});

test("ipv6 helpers: parse/compress roundtrip incl. v4-embedded and RFC 5952", () => {
  assert.equal(formatIpv6Groups(/** @type {number[]} */ (parseIpv6Groups("fd00:0000:0000:0000:0000:0000:0000:0013"))), "fd00::13");
  assert.equal(formatIpv6Groups(/** @type {number[]} */ (parseIpv6Groups("::1"))), "::1");
  assert.equal(formatIpv6Groups(/** @type {number[]} */ (parseIpv6Groups("2001:0db8:0000:0000:0000:ff00:0042:8329"))), "2001:db8::ff00:42:8329");
  // 最长零串优先（并列取首个）：压缩 2-4 组而非尾部
  assert.equal(formatIpv6Groups(/** @type {number[]} */ (parseIpv6Groups("fd00:0:0:0:0:0:0:13"))), "fd00::13");
  const v4 = parseIpv6Groups("::ffff:192.168.2.13");
  assert.notEqual(v4, null);
  assert.equal(formatIpv6Groups(/** @type {number[]} */ (v4)), "::ffff:c0a8:20d");
  assert.equal(parseIpv6Groups("fd00::13::1"), null);
  assert.equal(parseIpv6Groups("fd00::13:"), null);
});

test("resolveServerArg: short code -> URL offline; failures are CliExit with clear reason; URLs passthrough", () => {
  assert.equal(resolveServerArg("http://192.168.2.13:8787"), "http://192.168.2.13:8787");
  assert.equal(resolveServerArg("dwebh1.070ag-0gd49-9qnz8"), "http://192.168.2.13:8787");
  assert.equal(resolveServerArg("DWEBH1.0BYG-0000-0000-0000-0000-0000-009J-4MZ5-0R"), "http://[fd00::13]:8787");
  // 篡改短码在解析层失败——不发出任何网络请求（纯函数无网络面）
  assert.throws(
    () => resolveServerArg("dwebh1.070ag-0gd49-9qnz9"),
    (e) => e instanceof CliExit && /not a valid access short code/.test(e.message),
  );
});
