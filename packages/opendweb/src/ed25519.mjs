// Ed25519 助手（server-access-roles Phase 3，cli/identity）。
// 意图：`opendweb id`/`opendweb join` 需要以本机默认设备 key 做 Ed25519
// 派生/签名/验签，但内核的 SecretStore/签名能力只在 Rust 侧（client-sdk
// napi 的 Fabric 工厂会拉起整套 iroh 网络栈，对 CLI 只读/一次性签名过重，
// 且不暴露裸签名面）。本模块以 node:crypto 内建 OpenSSL 的 Ed25519 实现
// 同族密钥操作：32B 裸 seed 经固定 PKCS8/SPKI 前缀包装，派生/签名/验签与
// 内核（iroh_base::SecretKey = dalek，RFC 8032）逐字节一致——RFC 8032
// TEST 1 官方向量在 test/ed25519.test.mjs 钉死跨实现一致性。
// 纪律：私钥材料（seed）只以 Buffer 形态流转，永不进入字符串/日志/错误。

import crypto from "node:crypto";

/** PKCS8 DER 固定前缀（Ed25519 32B seed）+ seed = 私钥 DER */
const PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** SPKI DER 固定前缀 + 32B 公钥 = 公钥 DER */
const SPKI_PUB_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** hex64 白名单（与 client-sdk ./admin 同规） */
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * 32B seed → Ed25519 私钥 KeyObject（node:crypto）。
 * @param {Buffer} seed 恰 32 字节（FileSecretStore 的 identity.key 内容）
 * @returns {crypto.KeyObject}
 */
function privateKeyFromSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new TypeError("ed25519: seed must be a 32-byte Buffer");
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * 32B seed → 公钥 hex64（小写）。这就是 EndpointId 的 hex 展示形态
 * （iroh PublicKey Display 即 hex 小写 64 字符——crates/dweb-fabric
 * identity.rs 的 display_is_hex_in_iroh_but_z32_is_ours 测试钉死的既有
 * 事实；server 端 owners/visitors/codes 台账的 endpoint_id/root 均为此形态）。
 * @param {Buffer} seed
 * @returns {string} 64 hex 小写
 */
export function endpointIdHexFromSeed(seed) {
  const pub = crypto.createPublicKey(privateKeyFromSeed(seed));
  const spki = pub.export({ type: "spki", format: "der" });
  return /** @type {Buffer} */ (spki).subarray(SPKI_PUB_PREFIX.length).toString("hex");
}

/**
 * root PoP 签名（dweb/register/v1 域，server-access-roles spec 冻结）：
 * Ed25519 detached 64B 签名（确定性签名——同 seed 同消息恒同签名）。
 * @param {Buffer} seed 32B root seed
 * @param {Buffer} message canonical 载荷
 * @returns {Buffer} 64B 签名
 */
export function signDetached(seed, message) {
  return crypto.sign(null, message, privateKeyFromSeed(seed));
}

/**
 * hex64 公钥 → Ed25519 验签（回执验签用；server.key 公钥 = ServerId）。
 * @param {string} publicKeyHex 64 hex（大小写不敏感，规范为小写）
 * @param {Buffer} message canonical 载荷
 * @param {Buffer} sig 64B 签名
 * @returns {boolean}
 */
export function verifyDetached(publicKeyHex, message, sig) {
  if (typeof publicKeyHex !== "string" || !HEX64_RE.test(publicKeyHex)) {
    throw new TypeError("ed25519: public key must be 64 hex characters");
  }
  if (!Buffer.isBuffer(sig) || sig.length !== 64) {
    throw new TypeError("ed25519: signature must be a 64-byte Buffer");
  }
  const pub = crypto.createPublicKey({
    key: Buffer.concat([SPKI_PUB_PREFIX, Buffer.from(publicKeyHex.toLowerCase(), "hex")]),
    format: "der",
    type: "spki",
  });
  return crypto.verify(null, message, pub, sig);
}
