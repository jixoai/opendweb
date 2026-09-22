// sdk-mgmt-surface task 2.3：receiptCanonical 跨语言冻结对拍（node --test）。
// 向量唯一事实源：crates/dweb-server/tests/fixtures/receipt-vector.json
// （CROSS_CRATE_RECEIPT_VECTOR，Rust 单测固定 key/ts/generation 生成并断言；
// r3-P1-4 随仓库入库）。TS 侧只读该文件：
//   - 正向：JSON wire 回执字段 → receiptCanonical → 与 canonical_hex 逐字节相等
//   - 验签：node:crypto ed25519（独立实现）用 server_id 验 receipt_sig——
//     布局若与 Rust 漂移，验签立即红
//   - 反向：canonical_hex 逐段解析回字段 → 与 JSON wire 对拍
import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminPublicKeyFromServices,
  receiptCanonical,
  verifyReceipt,
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
  // op 码表对拍（register=1 / unregister=2 / disconnect=3）
  assert.deepEqual(vector.ops, { disconnect: 3, register: 1, unregister: 2 });
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
  // 样例覆盖：register / unregister / disconnect（按 endpoint 与按 fabric 多端点）
  assert.equal(receiptCount, 5, "4 样例共 5 张回执（disconnect-fabric 为 2）");
  assert.deepEqual(
    vector.samples.map((s) => s.kind),
    ["register", "unregister", "disconnect-endpoint", "disconnect-fabric"],
  );
});

test("receipt vector: reverse direction — canonical bytes parse back to the JSON wire fields", () => {
  for (const sample of vector.samples) {
    for (let i = 0; i < sample.receipts.length; i++) {
      const bytes = Buffer.from(sample.canonical_hex[i], "hex");
      assert.equal(bytes.length, 103, "22B 域 + 1B op + 32B fabric + 32B target + 8B ts + 8B gen");
      const opCode = bytes[22];
      const opLabel = Object.keys(vector.ops).find((k) => vector.ops[k] === opCode);
      const targetField = opCode === vector.ops.disconnect ? "endpoint_id" : "root";
      const parsed = {
        op: opLabel,
        fabric_id: hex(bytes.subarray(23, 55)),
        [targetField]: hex(bytes.subarray(55, 87)),
        ts: bytes.readBigUInt64BE(87), // 大端
        generation: bytes.readBigUInt64BE(95),
      };
      const receipt = sample.receipts[i];
      assert.equal(parsed.op, receipt.op, `${sample.kind}[${i}]`);
      assert.equal(parsed.fabric_id, receipt.fabric_id);
      assert.equal(parsed[targetField], receipt[targetField]);
      assert.equal(parsed.ts, BigInt(receipt.ts));
      assert.equal(parsed.generation, BigInt(receipt.generation));
    }
  }
});

test("receiptCanonical op semantics: target slot by op (root vs endpoint_id)", () => {
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
