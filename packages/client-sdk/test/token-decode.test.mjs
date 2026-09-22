// sdk-mgmt-surface tasks 3.2/3.3：./token 解码冻结对拍 + 非法输入矩阵
// （node --test）。
//
// capability 向量：CROSS_CRATE_CAP_VECTOR（crates/dweb-fabric/src/lib.rs:29，
// 由 dweb-server access::cap::sign_and_encode 生成；固定输入 seed=[1u8;32] /
// fabric=[3u8;32] / server=[2u8;32] / recipient=pubkey([4u8;32]) / caps=0b111 /
// issued=1_800_000_000_000 / expires=1_800_003_600_000）。issuer/recipient 的
// 期望值在测试内用 node:crypto ed25519 从种子独立推导——跨实现（node vs
// dalek/iroh）同公钥即 Ed25519 确定性钉；canonical 布局再由独立重排 + 验签
// 钉死（布局错则验签必红）。
//
// invite 向量：附录 A 冻结布局在本测试内手工拼装（字段序即布局表）+ node:
// crypto 真签名——与 Rust decode 语义兼容（内嵌 cap 的 recipient 与 invite
// recipient 一致、cap expires ≤ invite expires），decodeInvite 逐字段断言。
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { decodeCapability, decodeInvite, TokenError } from "../token/index.mjs";

// 来源：crates/dweb-fabric/src/lib.rs:29（CROSS_CRATE_CAP_VECTOR）
const CROSS_CRATE_CAP_VECTOR =
  "dwebr1.AQMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXMqTrBcFGHBx1nuDx_8O_oEI6OxFMFdddyaHkzPb2r58BwAAAaMYXFAAAAABoxiTPoDKl8Nfr0zIfv5h5qDsMVtPs9G5afdFkgIsPxzjf50TA8kUtCXBkblcrYsEAzRO7TUzDx5Mm2kAOM7aVZ6FaV8J";

// ---- node:crypto ed25519 助手（测试专用；subpath 源码零依赖不受影响） ----------

/** Ed25519 seed(32B) → PKCS8 DER 私钥。 */
function seedToPrivateKey(seed) {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seed),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Ed25519 seed(32B) → raw 公钥 hex（node:crypto 独立推导，跨实现钉）。 */
function edPublicHex(seed) {
  const spki = createPublicKey(seedToPrivateKey(seed)).export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32).toString("hex");
}

/** raw 公钥 hex → node:crypto KeyObject。 */
function rawPubToKey(pubkeyHex) {
  return createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(pubkeyHex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
}

const u16be = (n) => Buffer.from([n >> 8, n & 0xff]);
const u64be = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const hexToBuf = (h) => Buffer.from(h, "hex");

// ---- capability：CROSS_CRATE_CAP_VECTOR 同源同值 ---------------------------------

test("decodeCapability: CROSS_CRATE_CAP_VECTOR decodes to the frozen fixed inputs", () => {
  const cap = decodeCapability(CROSS_CRATE_CAP_VECTOR);
  assert.equal(cap.fabricId, "03".repeat(32));
  assert.equal(cap.serverId, "02".repeat(32));
  // issuer/recipient 由 node:crypto 从种子独立推导（跨实现钉）
  assert.equal(cap.issuer, edPublicHex(Uint8Array.from({ length: 32 }, () => 1)));
  assert.equal(cap.recipient, edPublicHex(Uint8Array.from({ length: 32 }, () => 4)));
  assert.equal(cap.capsBits, 0b111);
  assert.deepEqual(cap.caps, { relay: true, rdzAnnounce: true, rdzResolve: true });
  assert.equal(cap.issuedAt, 1_800_000_000_000);
  assert.equal(cap.expiresAt, 1_800_003_600_000);
  assert.match(cap.signature, /^[0-9a-f]{128}$/, "签名 64B hex 透出");
});

test("decodeCapability: node:crypto independently verifies the canonical layout", () => {
  const cap = decodeCapability(CROSS_CRATE_CAP_VECTOR);
  // canonical 独立重排：域 18B + version + 4×32 + caps + 2×u64BE（§11.1 冻结）
  const message = Buffer.concat([
    Buffer.from("dweb/relay-cap/v1\0", "latin1"),
    Buffer.from([0x01]),
    hexToBuf(cap.fabricId),
    hexToBuf(cap.serverId),
    hexToBuf(cap.issuer),
    hexToBuf(cap.recipient),
    Buffer.from([cap.capsBits]),
    u64be(cap.issuedAt),
    u64be(cap.expiresAt),
  ]);
  assert.equal(
    edVerify(null, message, rawPubToKey(cap.issuer), hexToBuf(cap.signature)),
    true,
    "域前缀 + 字段序若有漂移，node:crypto 验签必红",
  );
});

test("decodeCapability: partial caps bitmaps expand by name", () => {
  // 位图命名展开（01=relay、02=rdzAnnounce、04=rdzResolve）
  const cases = [
    { bits: 0b001, caps: { relay: true, rdzAnnounce: false, rdzResolve: false } },
    { bits: 0b010, caps: { relay: false, rdzAnnounce: true, rdzResolve: false } },
    { bits: 0b100, caps: { relay: false, rdzAnnounce: false, rdzResolve: true } },
    { bits: 0b101, caps: { relay: true, rdzAnnounce: false, rdzResolve: true } },
  ];
  for (const { bits, caps } of cases) {
    const cap = decodeCapability(rewireCap((wire) => void (wire[129] = bits)));
    assert.equal(cap.capsBits, bits, `bits ${bits}`);
    assert.deepEqual(cap.caps, caps, `bits ${bits}`);
    // 除 caps 外其余字段不受位图改写影响
    assert.equal(cap.fabricId, "03".repeat(32));
    assert.equal(cap.issuedAt, 1_800_000_000_000);
  }
});

/** dwebr1. 串 → wire 变换 → 重新编码（280 字符保持不变）。 */
function rewireCap(mutate) {
  const wire = Buffer.from(CROSS_CRATE_CAP_VECTOR.slice(7), "base64url");
  mutate(wire);
  return "dwebr1." + wire.toString("base64url");
}

test("decodeCapability illegal matrix (prefix/length/charset/version/reserved bits)", () => {
  const assertTE = (fn, code) =>
    assert.throws(fn, (err) => {
      assert.ok(err instanceof TokenError, `TokenError 实例（期望 ${code}）`);
      assert.equal(err.code, code);
      assert.equal(typeof err.message, "string");
      return true;
    });
  assertTE(() => decodeCapability("dwebr2.aaaa"), "bad-prefix");
  assertTE(() => decodeCapability("dweb2.material"), "bad-prefix");
  assertTE(() => decodeCapability(""), "bad-prefix");
  assertTE(() => decodeCapability(123), "bad-input");
  // 长度门
  assertTE(() => decodeCapability(CROSS_CRATE_CAP_VECTOR.slice(0, -1)), "bad-length");
  assertTE(() => decodeCapability(CROSS_CRATE_CAP_VECTOR + "A"), "bad-length");
  // 字符集（长度先于字符集判别——与 Rust decode 的检查序一致：len != 280 先拒）
  assertTE(() => decodeCapability(CROSS_CRATE_CAP_VECTOR + "="), "bad-length");
  assertTE(
    () => decodeCapability("dwebr1." + "A".repeat(279) + "+"),
    "bad-base64url",
  );
  // C1 长度门（> 1KiB）
  assertTE(() => decodeCapability("dwebr1." + "A".repeat(1024)), "too-long");
  // 版本位
  assertTE(() => decodeCapability(rewireCap((w) => void (w[0] = 0x02))), "unsupported-version");
  // caps 保留位
  assertTE(() => decodeCapability(rewireCap((w) => void (w[129] |= 0x08))), "reserved-bits");
  assertTE(() => decodeCapability(rewireCap((w) => void (w[129] = 0xff))), "reserved-bits");
});

// ---- invite：附录 A 冻结布局手工拼装向量（字段序钉死） ---------------------------

/** 构造最小合法 dweb2. 令牌（附录 A 布局逐字段拼装；node:crypto 真签名）。 */
function buildInviteVector() {
  const issuerSeed = Uint8Array.from({ length: 32 }, () => 7);
  const issuerPub = edPublicHex(issuerSeed);
  const recipient = edPublicHex(Uint8Array.from({ length: 32 }, () => 4)); // 与 CROSS_CRATE cap 的 recipient 一致（Rust 语义合法内嵌）
  const relayA = "https://relay-a.example/relay";
  const relayB = "https://relay-b.example:8443/relay";
  const canonical = Buffer.concat([
    Buffer.from("dweb/invite/v2\0", "latin1"), // 15B 域
    Buffer.from([0x02]), // version
    hexToBuf("11".repeat(32)), // fabric_id 32B
    hexToBuf("00112233445566778899aabbccddeeff"), // invite_id 16B
    hexToBuf(issuerPub), // issuer 32B
    u64be(1_800_003_600_000), // expires_at（== 内嵌 cap expires：附录 A 允许等值）
    hexToBuf(recipient), // recipient 32B（v2 恒必填）
    Buffer.from([2]), // relay_count
    u16be(relayA.length), Buffer.from(relayA, "latin1"),
    u16be(CROSS_CRATE_CAP_VECTOR.length), Buffer.from(CROSS_CRATE_CAP_VECTOR, "latin1"),
    u16be(relayB.length), Buffer.from(relayB, "latin1"),
    u16be(0), // relay B 无凭证
    Buffer.from([2]), // addr_count
    Buffer.from([4, 192, 0, 2, 10, 0x01, 0xbb]), // 192.0.2.10:443
    Buffer.concat([
      Buffer.from([6]),
      hexToBuf("20010db8000000000000000000000001"), // 2001:db8::1
      u16be(8443),
    ]),
  ]);
  const sig = edSign(null, canonical, seedToPrivateKey(issuerSeed));
  return {
    token: `dweb2.${Buffer.concat([canonical, sig]).toString("base64url")}`,
    issuerPub,
    recipient,
  };
}

test("decodeInvite: hand-assembled appendix-A vector pins field order and values", () => {
  const { token, issuerPub, recipient } = buildInviteVector();
  const invite = decodeInvite(token);
  assert.equal(invite.fabricId, "11".repeat(32));
  assert.equal(invite.inviteId, "00112233445566778899aabbccddeeff");
  assert.equal(invite.issuer, issuerPub);
  assert.equal(invite.recipient, recipient);
  assert.equal(invite.expiresAtMs, 1_800_003_600_000);
  assert.deepEqual(invite.relays, [
    { url: "https://relay-a.example/relay", capability: CROSS_CRATE_CAP_VECTOR, hasCapability: true },
    { url: "https://relay-b.example:8443/relay", capability: null, hasCapability: false },
  ]);
  // 直连地址：v4 原样 + v6 RFC 5952 压缩（与 Rust Display 同形）
  assert.deepEqual(invite.directAddrs, ["192.0.2.10:443", "[2001:db8::1]:8443"]);
  // 内嵌 capability 可直接进 decodeCapability（同源对拍）
  const cap = decodeCapability(invite.relays[0].capability);
  assert.equal(cap.recipient, invite.recipient, "内嵌 cap 与 invite 的 recipient 同值");
});

test("decodeInvite: IPv6 zero-run compression follows RFC 5952 (Rust Display parity)", () => {
  const issuerSeed = Uint8Array.from({ length: 32 }, () => 7);
  const issuerPub = edPublicHex(issuerSeed);
  const build = (v6Hex, expected) => {
    const canonical = Buffer.concat([
      Buffer.from("dweb/invite/v2\0", "latin1"),
      Buffer.from([0x02]),
      hexToBuf("11".repeat(32)),
      hexToBuf("00112233445566778899aabbccddeeff"),
      hexToBuf(issuerPub),
      u64be(1_800_003_600_000),
      hexToBuf(edPublicHex(Uint8Array.from({ length: 32 }, () => 4))),
      Buffer.from([0]), // relay_count 0
      Buffer.from([1]), // addr_count 1
      Buffer.from([6]),
      hexToBuf(v6Hex),
      u16be(443),
    ]);
    const sig = edSign(null, canonical, seedToPrivateKey(issuerSeed));
    return { token: `dweb2.${Buffer.concat([canonical, sig]).toString("base64url")}`, expected };
  };
  const cases = [
    build("20010db8000000000000000000000001", "[2001:db8::1]:443"), // 尾部压缩
    build("00000000000000000000000000000001", "[::1]:443"), // 前导压缩
    build("00000000000000000000000000000000", "[::]:443"), // 全零
    build("20010db8000000000000ffff00000001", "[2001:db8::ffff:0:1]:443"), // 1 组零不压缩
    build("fe800000000000000002000000000001", "[fe80::2:0:0:1]:443"), // 左侧最长零段胜出
  ];
  for (const { token, expected } of cases) {
    assert.deepEqual(decodeInvite(token).directAddrs, [expected], expected);
  }
});

test("decodeInvite illegal matrix (prefix/base64/length/version/domain/counts/family/trailing)", () => {
  const assertTE = (fn, code) =>
    assert.throws(fn, (err) => {
      assert.ok(err instanceof TokenError, `TokenError 实例（期望 ${code}）`);
      assert.equal(err.code, code);
      assert.equal(typeof err.message, "string");
      return true;
    });
  assertTE(() => decodeInvite("dweb1.material"), "bad-prefix");
  assertTE(() => decodeInvite(""), "bad-prefix");
  assertTE(() => decodeInvite(42), "bad-input");
  assertTE(() => decodeInvite("dweb2.%$@"), "bad-base64url");
  assertTE(() => decodeInvite("dweb2." + Buffer.alloc(50).toString("base64url")), "truncated");

  /** 对 canonical 段（去尾部 64B 签名）做字节级变换后重新封装。 */
  const rewire = (token, mutate) => {
    const payload = Buffer.from(token.slice(6), "base64url");
    const canonical = payload.subarray(0, payload.length - 64);
    mutate(canonical, payload);
    return "dweb2." + Buffer.concat([canonical, payload.subarray(payload.length - 64)]).toString("base64url");
  };
  const good = buildInviteVector().token;

  assertTE(() => decodeInvite(rewire(good, (c) => void (c[0] = 0x78))), "bad-domain");
  assertTE(() => decodeInvite(rewire(good, (c) => void (c[15] = 0x03))), "unsupported-version");
  assertTE(() => decodeInvite(rewire(good, (c) => void (c[136] = 9))), "count-exceeded"); // relay_count > 8
  assertTE(
    () =>
      decodeInvite(
        rewire(good, (c) => {
          c[136] = 0; // relay_count 0
          c[137] = 5; // addr_count > 4
        }),
      ),
    "count-exceeded",
  );
  assertTE(
    () =>
      decodeInvite(
        rewire(good, (c) => {
          c[136] = 0;
          c[137] = 1;
          c[138] = 0x05; // 未知 family tag
        }),
      ),
    "bad-family",
  );
  // 尾随字节：payload 末尾追加 1B（canonical 段多出无法消费的字节）
  assertTE(() => decodeInvite(appendByte(good)), "trailing-bytes");
  // relay url 截断：url_len 声明 100 但后续字节不足
  {
    const canonical = Buffer.concat([
      Buffer.from("dweb/invite/v2\0", "latin1"),
      Buffer.from([0x02]),
      hexToBuf("11".repeat(32)),
      hexToBuf("00112233445566778899aabbccddeeff"),
      hexToBuf(edPublicHex(Uint8Array.from({ length: 32 }, () => 7))),
      u64be(1_800_003_600_000),
      hexToBuf(edPublicHex(Uint8Array.from({ length: 32 }, () => 4))),
      Buffer.from([1]), // relay_count 1
      u16be(100), // url_len 100
      Buffer.from("short"),
      Buffer.from([0, 0]), // cap_len 0
      Buffer.from([0, 0]), // addr_count 0
    ]);
    const sig = Buffer.alloc(64, 1);
    assertTE(() => decodeInvite("dweb2." + Buffer.concat([canonical, sig]).toString("base64url")), "truncated");
  }
});

function appendByte(token) {
  const payload = Buffer.from(token.slice(6), "base64url");
  return "dweb2." + Buffer.concat([payload, Buffer.from([0x00])]).toString("base64url");
}
