// sdk-mgmt-surface task 2.3 + server-access-roles Phase 1c：receiptCanonical
// 跨语言冻结对拍（node --test）。向量唯一事实源：
// crates/dweb-server/tests/fixtures/receipt-vector.json
// （CROSS_CRATE_RECEIPT_VECTOR，Rust 单测固定 key/ts/generation 生成并断言；
// r3-P1-4 随仓库入库；Phase 1c 增补 op 0x04-0x0E 全族样例）。TS 侧只读该文件：
//   - 正向：JSON wire 回执字段 → receiptCanonical → 与 canonical_hex 逐字节相等
//   - 验签：node:crypto ed25519（独立实现）用 server_id 验 receipt_sig——
//     布局若与 Rust 漂移，验签立即红
//   - 反向：canonical_hex 逐段解析回字段 → 与 JSON wire 对拍
// register-receipt（POST /register 兑换回执）：registerReceiptCanonical 与
// packages/opendweb/src/register.mjs 的冻结 hex 向量（id-crypto.test.mjs 同源）
// 逐字节互认 + 注入式验签往返。
import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminPublicKeyFromServices,
  receiptCanonical,
  registerReceiptCanonical,
  verifyReceipt,
  verifyRegisterReceipt,
} from "../admin/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  here,
  "../../../crates/dweb-server/tests/fixtures/receipt-vector.json",
);
const vector = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** raw 32B 公钥 → node:crypto KeyObject（SPKI DER 包装）。 */
function verifierFor(pubkeyHex) {
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(pubkeyHex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  return (message, signature) =>
    ed25519Verify(null, Buffer.from(message), key, Buffer.from(signature));
}

test("receipt vector: canonical domain prefix matches the frozen domain_hex", () => {
  const domain = Uint8Array.from("dweb/admin-receipt/v1\0".split(""), (c) => c.charCodeAt(0));
  assert.equal(hex(domain), vector.domain_hex);
  // op 码表对拍（Phase 1c：register=1 … visitor-meta=14 全族）
  assert.deepEqual(vector.ops, {
    register: 1,
    unregister: 2,
    disconnect: 3,
    renew: 4,
    "visitor-grant": 5,
    "visitor-revoke": 6,
    "code-issue": 7,
    "code-revoke": 8,
    "block-add": 9,
    "block-remove": 10,
    "knock-dismiss": 11,
    "knock-undismiss": 12,
    "owner-meta": 13,
    "visitor-meta": 14,
  });
});

test("receipt vector: every sample recomputes canonical bytes and verifies against server_id", async () => {
  const verifier = verifierFor(vector.server_id);
  let receiptCount = 0;
  for (const sample of vector.samples) {
    assert.equal(
      sample.receipts.length,
      sample.canonical_hex.length,
      `${sample.kind}: receipts 与 canonical 一一对应`,
    );
    for (let i = 0; i < sample.receipts.length; i++) {
      const receipt = sample.receipts[i];
      const canonical = receiptCanonical(receipt);
      assert.equal(
        hex(canonical),
        sample.canonical_hex[i],
        `${sample.kind}[${i}]: receiptCanonical 与 Rust 冻结 canonical 逐字节对拍`,
      );
      assert.equal(
        await verifyReceipt(receipt, verifier),
        true,
        `${sample.kind}[${i}]: receipt_sig 可用 server_id 验签（跨实现钉）`,
      );
      receiptCount += 1;
    }
  }
  // 样例覆盖：op 0x01-0x0E 全族（16 样例共 17 张回执——disconnect-fabric 为 2）
  assert.equal(receiptCount, 17, "16 样例共 17 张回执");
  assert.deepEqual(
    vector.samples.map((s) => s.kind),
    [
      "register",
      "unregister",
      "disconnect-endpoint",
      "disconnect-fabric",
      "renew",
      "visitor-grant",
      "visitor-revoke",
      "code-issue",
      "code-revoke",
      "block-add-endpoint",
      "block-add-fabric",
      "block-remove",
      "knock-dismiss",
      "knock-undismiss",
      "owner-meta",
      "visitor-meta",
    ],
  );
});

test("receipt vector: reverse direction — canonical bytes parse back to the JSON wire fields", () => {
  // op → target 字段名（receiptCanonical 的 TARGET_FIELD_BY_OP 同表）
  const targetFieldByOpCode = new Map(
    Object.entries(vector.ops).map(([label, code]) => {
      const field =
        code === vector.ops.disconnect ||
        code === vector.ops["visitor-grant"] ||
        code === vector.ops["visitor-revoke"] ||
        code === vector.ops["visitor-meta"] ||
        code === vector.ops["knock-dismiss"] ||
        code === vector.ops["knock-undismiss"]
          ? "endpoint_id"
          : code === vector.ops["code-issue"] || code === vector.ops["code-revoke"]
            ? "code_hash"
            : code === vector.ops["block-add"] || code === vector.ops["block-remove"]
              ? "id"
              : "root";
      return [code, field];
    }),
  );
  for (const sample of vector.samples) {
    for (let i = 0; i < sample.receipts.length; i++) {
      const bytes = Buffer.from(sample.canonical_hex[i], "hex");
      assert.equal(bytes.length, 103, "22B 域 + 1B op + 32B fabric + 32B target + 8B ts + 8B gen");
      const opCode = bytes[22];
      const opLabel = Object.keys(vector.ops).find((k) => vector.ops[k] === opCode);
      const targetField = targetFieldByOpCode.get(opCode);
      const parsed = {
        op: opLabel,
        fabric_id: hex(bytes.subarray(23, 55)),
        [targetField]: hex(bytes.subarray(55, 87)),
        ts: bytes.readBigUInt64BE(87), // 大端
        generation: bytes.readBigUInt64BE(95),
      };
      const receipt = sample.receipts[i];
      assert.equal(parsed.op, receipt.op, `${sample.kind}[${i}]`);
      assert.equal(parsed.fabric_id, receipt.fabric_id, `${sample.kind}[${i}] fabric 槽位`);
      assert.equal(parsed[targetField], receipt[targetField]);
      assert.equal(parsed.ts, BigInt(receipt.ts));
      assert.equal(parsed.generation, BigInt(receipt.generation));
    }
  }
});

test("receipt vector: zero-fabric ops carry 64 zeros in the fabric slot (wire 同步置零)", () => {
  const zeros = "0".repeat(64);
  for (const kind of [
    "visitor-grant",
    "visitor-revoke",
    "code-issue",
    "code-revoke",
    "block-add-endpoint",
    "knock-dismiss",
    "knock-undismiss",
    "visitor-meta",
  ]) {
    const sample = vector.samples.find((s) => s.kind === kind);
    assert.equal(sample.fabric_id, zeros, `${kind} fabric 槽位置零`);
    assert.equal(sample.receipts[0].fabric_id, zeros, `${kind} wire fabric_id 置零`);
  }
  // block fabric 维度：fabric 槽位承载 id（spec 槽位映射表）
  const fabricSample = vector.samples.find((s) => s.kind === "block-add-fabric");
  assert.equal(fabricSample.fabric_id, fabricSample.targets[0]);
});

test("receiptCanonical op semantics: target slot by op (root vs endpoint_id vs code_hash vs id)", () => {
  const base = {
    fabric_id: "51".repeat(32),
    ts: 1789012345678,
    generation: 4,
    receipt_sig: "AA",
  };
  const rootCanonical = receiptCanonical({ ...base, op: "register", root: "52".repeat(32) });
  const unregCanonical = receiptCanonical({ ...base, op: "unregister", root: "52".repeat(32) });
  // register(0x01) vs unregister(0x02)：仅 op 字节不同（同一 root）
  assert.notEqual(rootCanonical[22], unregCanonical[22]);
  assert.deepEqual(rootCanonical.subarray(23), unregCanonical.subarray(23));
  // disconnect 的 target 槽位读 endpoint_id；缺 endpoint_id（只有 root）→ TypeError
  assert.throws(
    () => receiptCanonical({ ...base, op: "disconnect", root: "52".repeat(32) }),
    TypeError,
  );
  // Phase 1c 族：code 槽位读 code_hash、block 读 id、knock 读 endpoint_id——
  // 缺对应字段 → TypeError（防静默错槽）
  assert.throws(() => receiptCanonical({ ...base, op: "code-revoke" }), TypeError);
  assert.throws(() => receiptCanonical({ ...base, op: "block-remove" }), TypeError);
  assert.throws(() => receiptCanonical({ ...base, op: "knock-dismiss" }), TypeError);
  // 未知 op → TypeError
  assert.throws(() => receiptCanonical({ ...base, op: "mystery", root: "52".repeat(32) }), TypeError);
  // 坏 hex / 越域数字 → TypeError
  assert.throws(() => receiptCanonical({ ...base, op: "register", root: "zz".repeat(32) }), TypeError);
  assert.throws(() => receiptCanonical({ ...base, op: "register", root: "52".repeat(32), ts: -1 }), TypeError);
  assert.throws(
    () => receiptCanonical({ ...base, op: "register", root: "52".repeat(32), generation: 2 ** 53 }),
    TypeError,
  );
});

test("tampered receipts fail the injected verifier (verify never returns true on drift)", async () => {
  const verifier = verifierFor(vector.server_id);
  const sample = vector.samples[0]; // register
  const receipt = sample.receipts[0];
  for (const tampered of [
    { ...receipt, ts: receipt.ts + 1 },
    { ...receipt, generation: receipt.generation + 1 },
    { ...receipt, fabric_id: "56".repeat(32) },
    { ...receipt, root: "56".repeat(32) },
    { ...receipt, op: "unregister" }, // op 字节被换——canonical 随之变，签名失配
  ]) {
    assert.equal(await verifyReceipt(tampered, verifier), false, JSON.stringify(tampered));
  }
  // 坏 receipt_sig（非 base64url / 长度不对）→ TypeError，不误报 false
  await assert.rejects(
    verifyReceipt({ ...receipt, receipt_sig: "!!!" }, verifier),
    TypeError,
  );
  await assert.rejects(
    verifyReceipt({ ...receipt, receipt_sig: "QUJD" }, verifier), // 3B
    TypeError,
  );
  // verifier 必须是函数
  await assert.rejects(verifyReceipt(receipt, null), TypeError);
});

test("adminPublicKeyFromServices: extracts server_id from services.json (string or object)", () => {
  const doc = {
    server: "dweb",
    version: "0.6.0",
    gateway: "https://dweb.example",
    services: [{ name: "relay", enabled: true, url: "https://dweb.example/relay" }],
    server_id: vector.server_id,
  };
  assert.equal(adminPublicKeyFromServices(JSON.stringify(doc)), vector.server_id);
  assert.equal(adminPublicKeyFromServices(doc), vector.server_id);
  // 大写归一
  assert.equal(
    adminPublicKeyFromServices({ ...doc, server_id: vector.server_id.toUpperCase() }),
    vector.server_id,
  );
  // 缺字段 / 非法形态 → TypeError
  assert.throws(() => adminPublicKeyFromServices({ server: "dweb" }), TypeError);
  assert.throws(() => adminPublicKeyFromServices({ server_id: "zz".repeat(32) }), TypeError);
  assert.throws(() => adminPublicKeyFromServices(42), TypeError);
});

// r5-P1-2 回归：原型键不得穿透 op 查表（曾把 "constructor" 静默编码为 0）
test("receiptCanonical rejects prototype-key ops", () => {
  const base = {
    op: "register",
    fabric_id: "f1".repeat(32),
    root: "aa".repeat(32),
    ts: 1,
    generation: 2,
  };
  for (const bad of ["constructor", "toString", "__proto__"]) {
    assert.throws(
      () => receiptCanonical({ ...base, op: bad }),
      TypeError,
      `op=${JSON.stringify(bad)} must be rejected`,
    );
  }
});

// ---- register-receipt（POST /register 兑换回执；server-access-roles Phase 1c） ----

/** 与 packages/opendweb/test/id-crypto.test.mjs 同源的冻结向量（互认锚）：
 * register.rs receipt_canonical_frozen_vector 逐字节一致。 */
const REGISTER_FROZEN_HEX =
  "647765622f72656769737465722d726563656970742f763100" +
  "33".repeat(32) +
  "11".repeat(32) +
  "22".repeat(32) +
  "000001997576d34e" +
  "0000000000000007";

const REGISTER_RECEIPT = {
  op: "register",
  code_hash: "33".repeat(32),
  fabric_id: "11".repeat(32),
  root: "22".repeat(32),
  expires_at: 1_790_000_000_000,
  ts: 1_758_612_345_678,
  generation: 7,
  receipt_sig: "AA",
};

test("registerReceiptCanonical: frozen 137B vector (与 opendweb/Rust 互认)", () => {
  const canonical = registerReceiptCanonical(REGISTER_RECEIPT);
  assert.equal(canonical.length, 137, "25B 域 + 32×3 + 8×2");
  assert.equal(hex(canonical), REGISTER_FROZEN_HEX);
  // expires_at 不进 canonical（回执形态字段，非被签字段）——篡改不影响 canonical
  const shifted = registerReceiptCanonical({ ...REGISTER_RECEIPT, expires_at: 1 });
  assert.equal(hex(shifted), REGISTER_FROZEN_HEX);
  // op 非 register / 缺字段 / 坏 hex → TypeError
  assert.throws(() => registerReceiptCanonical({ ...REGISTER_RECEIPT, op: "renew" }), TypeError);
  assert.throws(() => registerReceiptCanonical({ ...REGISTER_RECEIPT, code_hash: "zz" }), TypeError);
  assert.throws(
    () => registerReceiptCanonical({ ...REGISTER_RECEIPT, generation: 2 ** 53 }),
    TypeError,
  );
});

test("verifyRegisterReceipt: injected verifier roundtrip (sign → verify)", async () => {
  const seed = Buffer.alloc(32, 0x5d);
  const priv = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const canonical = registerReceiptCanonical(REGISTER_RECEIPT);
  const sig = ed25519Sign(null, canonical, priv);
  const verifier = verifierFor(
    createPublicKey(priv).export({ type: "spki", format: "der" }).subarray(-32).toString("hex"),
  );
  const receipt = {
    ...REGISTER_RECEIPT,
    receipt_sig: Buffer.from(sig).toString("base64url"),
  };
  assert.equal(await verifyRegisterReceipt(receipt, verifier), true, "注入公钥验签通过");
  // 篡改 ts/generation → false；错 sig 长度 → TypeError；非函数 verifier → TypeError
  assert.equal(
    await verifyRegisterReceipt({ ...receipt, ts: receipt.ts + 1 }, verifier),
    false,
  );
  assert.equal(
    await verifyRegisterReceipt({ ...receipt, generation: 8 }, verifier),
    false,
  );
  await assert.rejects(verifyRegisterReceipt({ ...receipt, receipt_sig: "QUJD" }, verifier), TypeError);
  await assert.rejects(verifyRegisterReceipt(receipt, null), TypeError);
});
