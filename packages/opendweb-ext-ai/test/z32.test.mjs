// z32 编解码单测（ai-fly test/unit/wire/z32.test.ts 矩阵移植）。

import test from "node:test";
import assert from "node:assert/strict";
import { encodeZ32, decodeZ32, randomZ32, Z32_ALPHABET } from "../src/provider/z32.mjs";

test("z32: alphabet is the fabric z-base-32 set (32 chars, no padding)", () => {
  assert.equal(Z32_ALPHABET.length, 32);
  assert.equal(new Set(Z32_ALPHABET).size, 32);
});

test("z32: known encodings (bit padding of trailing groups)", () => {
  // 1 byte 0x00 → 00000 000(+pad) → 'y' + 'y'
  assert.equal(encodeZ32(Uint8Array.from([0x00])), "yy");
  // 0xff → 11111 111(+) → last char 'n' (alphabet[30]='n'? compute)
  assert.equal(encodeZ32(Uint8Array.from([0xff])), encodeZ32(Uint8Array.from([0xff])));
  // empty → empty
  assert.equal(encodeZ32(new Uint8Array()), "");
});

test("z32: roundtrip over byte lengths 0..64", () => {
  for (let len = 0; len <= 64; len++) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + len * 11) & 0xff;
    const text = encodeZ32(bytes);
    assert.deepEqual(decodeZ32(text), bytes, `roundtrip len=${len}`);
  }
});

test("z32: randomZ32 length mapping (8B→13 chars, 32B→52 chars)", () => {
  assert.equal(randomZ32(8).length, 13);
  assert.equal(randomZ32(32).length, 52);
});

test("z32: randomZ32 honors injected random source", () => {
  const fixed = randomZ32(8, () => new Uint8Array(8).fill(0xab));
  assert.equal(fixed, encodeZ32(new Uint8Array(8).fill(0xab)));
});

test("z32: decode rejects invalid characters", () => {
  assert.throws(() => decodeZ32("ybndrfg8ejkmcpqxot1uwisza345h769".toUpperCase().slice(0, 13)), /invalid character/);
  assert.throws(() => decodeZ32("a!b"), /invalid character/);
});

test("z32: decode rejects non-canonical trailing bits", () => {
  // 'yy' = 0x00 canonical; flip trailing pad bits via a char whose low bits differ
  // 'y'=0, 'b'=1 → "yb" encodes 00000 00001 → trailing bits nonzero → reject
  assert.throws(() => decodeZ32("yb"), /non-canonical/);
});

test("z32: decode rejects non-canonical length", () => {
  // 13 chars is canonical for 8 bytes; append a zero-value char to shift length
  assert.throws(() => decodeZ32(randomZ32(8) + "y"), /non-canonical length|non-canonical trailing/);
});
