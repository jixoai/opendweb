// adapted from ai-fly src/wire/z32.ts (v0.6.0)
// z-base-32 编解码（字母表与 fabric 同款）：serviceId/keyId（8B→13 字符）与
// sk-aifly- 密钥体共用的唯一随机标识编码。
// 正交意图（上游同款）：纯编码层，无 IO、无协议语义；唯一外部依赖是
// node:crypto 的随机源；编码无填充符，末组不足 5 bit 以零垫低位；decode
// 严格拒绝非规范形（非法字符/尾位非零/长度不匹配），保证编解码双射。

import { randomBytes } from "node:crypto";

/** z-base-32 字母表（fabric 同款，ybndrfg8…h769）。 */
export const Z32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

const CHAR_VALUE = new Uint8Array(128).fill(0xff);
for (let i = 0; i < Z32_ALPHABET.length; i++) {
  CHAR_VALUE[Z32_ALPHABET.charCodeAt(i)] = i;
}

/**
 * nBytes 字节密码学随机数的 z32 编码（serviceId / keyId / 密钥体共用）。
 * @param {number} nBytes
 * @param {() => Uint8Array} [random] 可注入（CSPRNG 替身——测试）
 * @returns {string}
 */
export function randomZ32(nBytes, random = () => randomBytes(nBytes)) {
  return encodeZ32(random());
}

/** 编码：高位在前、5 bit 一组；末组不足 5 bit 左移补零，不输出填充符。 */
export function encodeZ32(bytes) {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += Z32_ALPHABET.charAt((acc >>> bits) & 31);
    }
    // 丢弃已消费的高位，防止累加器无界增长（此处 bits < 5）。
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += Z32_ALPHABET.charAt((acc << (5 - bits)) & 31);
  }
  return out;
}

/** 解码：严格规范形校验（非法字符、尾位 padding 非零、非最短长度均抛错）。 */
export function decodeZ32(text) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 128 || CHAR_VALUE[code] === 0xff) {
      throw new Error(`z32: invalid character at index ${i}`);
    }
    acc = (acc << 5) | CHAR_VALUE[code];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  // 末字符低位的 padding 比特必须全零，否则不是规范编码。
  if (bits > 0 && acc !== 0) {
    throw new Error("z32: non-canonical trailing bits");
  }
  const bytes = Uint8Array.from(out);
  if (encodeZ32(bytes).length !== text.length) {
    throw new Error("z32: non-canonical length");
  }
  return bytes;
}
