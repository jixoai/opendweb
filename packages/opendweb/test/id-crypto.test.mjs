// 加密与 canonical 冻结向量测试（server-access-roles Phase 3，cli/identity）。
// - RFC 8032 TEST 1 官方向量钉死 node:crypto OpenSSL Ed25519 与内核
//   （iroh_base::SecretKey = dalek，RFC 8032）跨实现一致——同一 32B seed
//   派生同公钥、同签名（Ed25519 确定性签名）
// - register/receipt canonical 冻结向量（hex 直钉，spec 域分隔符不可漂移）
// - services.json server_id 提取与回执验签往返（含篡改负例）

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { endpointIdHexFromSeed, signDetached, verifyDetached } from "../src/ed25519.mjs";
import {
  buildRegisterCanonical,
  buildRegisterReceiptCanonical,
  RECEIPT_CANONICAL_LEN,
  serverPublicKeyFromServices,
  parseRegisterResponse,
  verifyRegisterReceipt,
  toBase64UrlNoPad,
} from "../src/register.mjs";

const FABRIC = "11".repeat(32);
const ROOT = "22".repeat(32);
const CODE_HASH = "33".repeat(32);
const TS = 1758612345678;

// ---- RFC 8032 TEST 1（跨实现一致性锚） --------------------------------------

test("ed25519: RFC 8032 TEST 1 public key derivation (OpenSSL == dalek == RFC)", () => {
  const seed = Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  );
  assert.equal(
    endpointIdHexFromSeed(seed),
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  );
});

test("ed25519: RFC 8032 TEST 1 empty-message signature bytes", () => {
  const seed = Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  );
  assert.equal(
    signDetached(seed, Buffer.alloc(0)).toString("hex"),
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  );
});

test("ed25519: sign/verify roundtrip deterministic; tamper fails; malformed rejected", () => {
  const seed = crypto.randomBytes(32);
  const pub = endpointIdHexFromSeed(seed);
  const msg = Buffer.from("dweb register pop");
  const sig = signDetached(seed, msg);
  assert.equal(sig.length, 64);
  // 确定性：同 seed 同消息恒同签名
  assert.deepEqual(signDetached(seed, msg), sig);
  assert.equal(verifyDetached(pub, msg, sig), true);
  assert.equal(verifyDetached(pub, Buffer.from("tampered"), sig), false);
  assert.throws(() => verifyDetached("zz", msg, sig), /64 hex/);
  assert.throws(() => verifyDetached(pub, msg, Buffer.alloc(63)), /64-byte/);
  // 大写 hex 公钥规范化接受
  assert.equal(verifyDetached(pub.toUpperCase(), msg, sig), true);
});

// ---- canonical 冻结向量 ------------------------------------------------------

test("register canonical: frozen vector (domain + code + fabric + root + ts u64BE)", () => {
  const canonical = buildRegisterCanonical({
    code: "dwebc1.0123-4567-89cd-fghj",
    fabricIdHex: FABRIC,
    rootHex: ROOT,
    ts: TS,
  });
  assert.equal(canonical.length, 179); // 18 域 + 25 code + 64 + 64 + 8
  // register 域的 fabric/root 以 hex 文本（utf8）嵌入——与 body 字段同串验签
  assert.equal(
    canonical.toString("hex"),
    "647765622f72656769737465722f763100" +
      "6477656263312e303132332d343536372d383963642d6667686a" +
      Buffer.from(FABRIC, "utf8").toString("hex") +
      Buffer.from(ROOT, "utf8").toString("hex") +
      "000001997576d34e",
  );
});

test("register canonical: hex 输入大小写规范化（canonical 恒小写形态）", () => {
  const lower = buildRegisterCanonical({ code: "c", fabricIdHex: FABRIC, rootHex: ROOT, ts: 1 });
  const upper = buildRegisterCanonical({
    code: "c",
    fabricIdHex: FABRIC.toUpperCase(),
    rootHex: ROOT.toUpperCase(),
    ts: 1,
  });
  assert.deepEqual(upper, lower);
});

test("register canonical: shape errors fail-fast", () => {
  assert.throws(() => buildRegisterCanonical({ code: "", fabricIdHex: FABRIC, rootHex: ROOT, ts: 1 }), /code/);
  assert.throws(() => buildRegisterCanonical({ code: "c", fabricIdHex: "abc", rootHex: ROOT, ts: 1 }), /fabric_id/);
  assert.throws(() => buildRegisterCanonical({ code: "c", fabricIdHex: FABRIC, rootHex: ROOT, ts: 1.5 }), /ts/);
  assert.throws(() => buildRegisterCanonical({ code: "c", fabricIdHex: FABRIC, rootHex: ROOT, ts: -1 }), /ts/);
});

test("receipt canonical: frozen 137B vector (domain + 32×3 + ts + generation)", () => {
  const canonical = buildRegisterReceiptCanonical({
    codeHashHex: CODE_HASH,
    fabricIdHex: FABRIC,
    rootHex: ROOT,
    ts: TS,
    generation: 7,
  });
  assert.equal(RECEIPT_CANONICAL_LEN, 137);
  assert.equal(canonical.length, 137);
  // receipt 域的 code_hash/fabric/root 为 32B 原始字节（非 hex 文本）
  assert.equal(
    canonical.toString("hex"),
    "647765622f72656769737465722d726563656970742f763100" +
      CODE_HASH +
      FABRIC +
      ROOT +
      "000001997576d34e" +
      "0000000000000007",
  );
});

test("receipt canonical: generation bounds (u64 safe-integer domain)", () => {
  const input = { codeHashHex: CODE_HASH, fabricIdHex: FABRIC, rootHex: ROOT, ts: 1 };
  assert.equal(buildRegisterReceiptCanonical({ ...input, generation: Number.MAX_SAFE_INTEGER }).length, 137);
  assert.throws(() => buildRegisterReceiptCanonical({ ...input, generation: Number.MAX_SAFE_INTEGER + 1 }), /generation/);
});

// ---- services.json 公钥提取 + 回执验签 ----------------------------------------

test("serverPublicKeyFromServices: server_id hex64 提取与畸形拒绝", () => {
  const serverId = "ab".repeat(32);
  assert.equal(serverPublicKeyFromServices({ server_id: serverId.toUpperCase(), relay: "x" }), serverId);
  assert.equal(serverPublicKeyFromServices(JSON.stringify({ server_id: serverId })), serverId);
  assert.throws(() => serverPublicKeyFromServices({}), /server_id/);
  assert.throws(() => serverPublicKeyFromServices({ server_id: "short" }), /server_id/);
});

/** 组装一个服务端签名的回执响应体（fixture helper） */
function signedReceiptResponse(serverSeed, overrides = {}) {
  const serverId = endpointIdHexFromSeed(serverSeed);
  const fields = {
    op: "register",
    ts: TS,
    generation: 7,
    fabric_id: FABRIC,
    root: ROOT,
    code_hash: CODE_HASH,
    expires_at: TS + 30 * 24 * 3600 * 1000,
    ...overrides,
  };
  const canonical = buildRegisterReceiptCanonical({
    codeHashHex: fields.code_hash,
    fabricIdHex: fields.fabric_id,
    rootHex: fields.root,
    ts: fields.ts,
    generation: fields.generation,
  });
  return { ...fields, receipt_sig: toBase64UrlNoPad(signDetached(serverSeed, canonical)) };
}

test("verifyRegisterReceipt: server 签名验签通过；篡改任一字段失败", () => {
  const serverSeed = crypto.randomBytes(32);
  const serverId = endpointIdHexFromSeed(serverSeed);
  const receipt = signedReceiptResponse(serverSeed);
  assert.equal(verifyRegisterReceipt(toReceipt(receipt), serverId), true);
  // 篡改 ts（重签前体）→ 验签失败
  assert.equal(verifyRegisterReceipt(toReceipt({ ...receipt, ts: receipt.ts + 1 }), serverId), false);
  // 篡改 generation / expires_at（expires_at 不进 canonical——篡改它不影响验签，但 parse 校验形状）
  assert.equal(verifyRegisterReceipt(toReceipt({ ...receipt, generation: 8 }), serverId), false);
  // 错误公钥（另一台 server）
  const otherServer = endpointIdHexFromSeed(crypto.randomBytes(32));
  assert.equal(verifyRegisterReceipt(toReceipt(receipt), otherServer), false);
  // receipt_sig 非法形态
  assert.throws(() => verifyRegisterReceipt(toReceipt({ ...receipt, receipt_sig: "!!!" }), serverId), /base64url/);
  assert.throws(() => verifyRegisterReceipt(toReceipt({ ...receipt, receipt_sig: toBase64UrlNoPad(Buffer.alloc(10)) }), serverId), /exactly 64 bytes/);
});

/** 响应体 → 验签入参（经 parseRegisterResponse 全形状校验） */
function toReceipt(response) {
  const parsed = parseRegisterResponse(response);
  return {
    ts: parsed.ts,
    generation: parsed.generation,
    fabricIdHex: parsed.fabricId,
    rootHex: parsed.root,
    codeHashHex: parsed.codeHash,
    receiptSig: parsed.receiptSig,
  };
}

test("parseRegisterResponse: 未知字段忽略；畸形形状 fail-fast", () => {
  const serverSeed = crypto.randomBytes(32);
  const ok = signedReceiptResponse(serverSeed, { extra_field: "ignored" });
  assert.equal(parseRegisterResponse(ok).expiresAt, ok.expires_at);
  // op 错误
  assert.throws(() => parseRegisterResponse({ ...ok, op: "renew" }), /op/);
  // 缺 receipt_sig
  const { receipt_sig, ...noSig } = ok;
  assert.throws(() => parseRegisterResponse(noSig), /receipt_sig/);
  // fabric_id 非 hex64
  assert.throws(() => parseRegisterResponse({ ...ok, fabric_id: "xyz" }), /fabric_id/);
  // ts 非整数
  assert.throws(() => parseRegisterResponse({ ...ok, ts: "123" }), /ts/);
  // 非 object
  assert.throws(() => parseRegisterResponse([ok]), /object/);
});

test("base64url-nopad 编解码：非零尾位与 pad 拒绝", () => {
  const serverSeed = crypto.randomBytes(32);
  const bytes = crypto.randomBytes(64);
  const enc = toBase64UrlNoPad(bytes);
  assert.ok(!enc.includes("="));
  const parsed = parseRegisterResponse(signedReceiptResponse(serverSeed));
  assert.equal(parsed.receiptSig.length, 86); // 64B → 86 chars nopad
});
