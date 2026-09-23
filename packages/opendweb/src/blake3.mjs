// 纯 JS BLAKE3（hash mode，32B 输出）——CLI 侧码哈希唯一源。
// 意图（2026-09-24，home-hub Phase 1d）：journal 的 code_hash 必须在
// register 发出前本地计算，语义与服务端 codes.rs 的 `code_hash`（=
// blake3(规范化 16 字符小写码本体)）逐字节一致——不引 NAPI/原生依赖
// （device-key.mjs 冷启动纪律）。算法参照 BLAKE3 参考实现（公开域）：
// chunk 1024B / block 64B / 7 轮 G 函数 / CV 栈合并 / ROOT flag。
// 向量锁定在 test/leases.test.mjs（Rust blake3 1.8.7 独立生成的 frozen
// 向量：块/块链/父节点边界 12 长度谱系）。

/** IV（与 SHA-256 的 IV 同值，BLAKE3 规范冻结） */
const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** 消息字置换表（规范冻结） */
const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

const CHUNK_START = 1 << 0;
const CHUNK_END = 1 << 1;
const PARENT = 1 << 2;
const ROOT = 1 << 3;

const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

/** @param {number} x @param {number} n @returns {number} */
function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * G 函数（state 原地更新）。
 * @param {Uint32Array} state @param {number} a @param {number} b @param {number} c @param {number} d
 * @param {number} mx @param {number} my
 */
function g(state, a, b, c, d, mx, my) {
  state[a] = (state[a] + state[b] + mx) >>> 0;
  state[d] = rotr(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotr(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b] + my) >>> 0;
  state[d] = rotr(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotr(state[b] ^ state[c], 7);
}

/**
 * 压缩函数（规范 32 字 state；返回 16 词完整 state）。
 * @param {Uint32Array} cv 8 词 chaining value
 * @param {Uint32Array} block 16 词消息块
 * @param {number} counter 块计数（u64 低 32 位足够——安全整数域）
 * @param {number} blockLen 本块有效字节数
 * @param {number} flags
 * @returns {Uint32Array} 16 词 state
 */
function compress(cv, block, counter, blockLen, flags) {
  const state = new Uint32Array(16);
  state.set(cv.subarray(0, 8), 0);
  state.set(IV.subarray(0, 4), 8);
  state[12] = counter >>> 0;
  state[13] = 0; // u64 高 32 位（< 2^53 输入域恒 0）
  state[14] = blockLen >>> 0;
  state[15] = flags >>> 0;
  const msg = Uint32Array.from(block);
  for (let r = 0; r < 7; r++) {
    if (r > 0) {
      const next = new Uint32Array(16);
      for (let i = 0; i < 16; i++) next[i] = msg[MSG_PERMUTATION[i]];
      msg.set(next);
    }
    g(state, 0, 4, 8, 12, msg[0], msg[1]);
    g(state, 1, 5, 9, 13, msg[2], msg[3]);
    g(state, 2, 6, 10, 14, msg[4], msg[5]);
    g(state, 3, 7, 11, 15, msg[6], msg[7]);
    g(state, 0, 5, 10, 15, msg[8], msg[9]);
    g(state, 1, 6, 11, 12, msg[10], msg[11]);
    g(state, 2, 7, 8, 13, msg[12], msg[13]);
    g(state, 3, 4, 9, 14, msg[14], msg[15]);
  }
  for (let i = 0; i < 8; i++) {
    state[i] = (state[i] ^ state[i + 8]) >>> 0;
    state[i + 8] = (state[i + 8] ^ cv[i]) >>> 0;
  }
  return state;
}

/** @param {Uint32Array} state @returns {Uint32Array} 首 8 词 CV */
function wordsToCv(state) {
  return Uint32Array.from(state.subarray(0, 8));
}

/**
 * chunk 内逐块更新态（参考实现 ChunkState 的最小移植）。
 */
class ChunkState {
  /** @type {Uint32Array} */
  cv;
  /** @type {number} */
  chunkCounter;
  /** @type {Uint8Array} */
  block;
  /** @type {number} */
  blockLen;
  /** @type {number} */
  blocksCompressed;

  /** @param {Uint32Array} key @param {number} chunkCounter */
  constructor(key, chunkCounter) {
    this.cv = Uint32Array.from(key);
    this.chunkCounter = chunkCounter;
    this.block = new Uint8Array(BLOCK_LEN);
    this.blockLen = 0;
    this.blocksCompressed = 0;
  }

  /** @returns {number} */
  len() {
    return BLOCK_LEN * this.blocksCompressed + this.blockLen;
  }

  /** @returns {number} */
  startFlag() {
    return this.blocksCompressed === 0 ? CHUNK_START : 0;
  }

  /**
   * @param {Uint8Array} input
   */
  update(input) {
    let pos = 0;
    while (pos < input.length) {
      if (this.blockLen === BLOCK_LEN) {
        const blockWords = bytesToWords(this.block);
        const state = compress(this.cv, blockWords, this.chunkCounter, BLOCK_LEN, this.startFlag());
        this.cv = wordsToCv(state);
        this.blocksCompressed += 1;
        this.block = new Uint8Array(BLOCK_LEN);
        this.blockLen = 0;
      }
      const want = BLOCK_LEN - this.blockLen;
      const take = Math.min(want, input.length - pos);
      this.block.set(input.subarray(pos, pos + take), this.blockLen);
      this.blockLen += take;
      pos += take;
    }
  }

  /**
   * chunk 的 Output（CHUNK_END 补零块）。
   * @returns {{ cv: Uint32Array, block: Uint8Array, blockLen: number, counter: number, flags: number }}
   */
  output() {
    return {
      cv: Uint32Array.from(this.cv),
      block: Uint8Array.from(this.block),
      blockLen: this.blockLen,
      counter: this.chunkCounter,
      flags: this.startFlag() | CHUNK_END,
    };
  }
}

/**
 * Output 的 CV（首 8 词）。
 * @param {{ cv: Uint32Array, block: Uint8Array, blockLen: number, counter: number, flags: number }} output
 */
function outputCv(output) {
  return wordsToCv(compress(output.cv, bytesToWords(output.block), output.counter, output.blockLen, output.flags));
}

/**
 * 父节点 Output（左右 CV 拼块 + PARENT）。
 * @param {Uint32Array} left @param {Uint32Array} right
 */
function parentOutput(left, right) {
  const block = new Uint8Array(BLOCK_LEN);
  block.set(cvToBytes(left), 0);
  block.set(cvToBytes(right), 32);
  return { cv: Uint32Array.from(IV), block, blockLen: BLOCK_LEN, counter: 0, flags: PARENT };
}

/** @param {Uint8Array} bytes @returns {Uint32Array} 16 词小端 */
function bytesToWords(bytes) {
  const words = new Uint32Array(16);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 16; i++) words[i] = dv.getUint32(i * 4, true);
  return words;
}

/** @param {Uint32Array} cv @returns {Uint8Array} */
function cvToBytes(cv) {
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, cv[i], true);
  return out;
}

/**
 * BLAKE3 哈希（hash mode，XOF out=32B 的根输出）。
 * @param {Uint8Array | string} input（字符串按 UTF-8 字节）
 * @returns {string} 64 字符小写 hex
 */
export function blake3Hex(input) {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const hasher = new Hasher();
  hasher.update(data);
  const output = hasher.finalizeOutput();
  // 根输出：ROOT flag 压缩后取全部 16 词小端（32B 只需前 8 词）
  const state = compress(output.cv, bytesToWords(output.block), output.counter, output.blockLen, output.flags | ROOT);
  // 根输出序列化 = 状态词小端字节流；32B 摘要取前 8 词
  let hex = "";
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 4; j++) hex += ((state[i] >>> (8 * j)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * 增量哈希器（参考实现 Hasher 的最小移植；仅 hash mode 无 key/derive）。
 */
class Hasher {
  /** @type {Uint32Array} */
  keyWords;
  /** @type {ChunkState} */
  chunkState;
  /** @type {Uint32Array[]} */
  cvStack = [];

  constructor() {
    this.keyWords = Uint32Array.from(IV);
    this.chunkState = new ChunkState(this.keyWords, 0);
  }

  /**
   * @param {Uint32Array} newCv @param {number} totalChunks
   */
  pushCv(newCv, totalChunks) {
    let cv = /** @type {Uint32Array} */ (Uint32Array.from(newCv));
    let chunks = totalChunks;
    while ((chunks & 1) === 0) {
      const left = /** @type {Uint32Array} */ (this.cvStack.pop());
      cv = outputCv(parentOutput(left, cv));
      chunks >>= 1;
    }
    this.cvStack.push(cv);
  }

  /**
   * @param {Uint8Array} input
   */
  update(input) {
    let pos = 0;
    while (pos < input.length) {
      // chunk 满则结链入栈
      if (this.chunkState.len() === CHUNK_LEN) {
        const chunkCv = outputCv(this.chunkState.output());
        const totalChunks = this.chunkState.chunkCounter + 1;
        this.pushCv(chunkCv, totalChunks);
        this.chunkState = new ChunkState(this.keyWords, totalChunks);
      }
      const want = CHUNK_LEN - this.chunkState.len();
      const take = Math.min(want, input.length - pos);
      this.chunkState.update(input.subarray(pos, pos + take));
      pos += take;
    }
  }

  /** @returns {{ cv: Uint32Array, block: Uint8Array, blockLen: number, counter: number, flags: number }} */
  finalizeOutput() {
    let output = this.chunkState.output();
    let remaining = this.cvStack.length;
    while (remaining > 0) {
      remaining -= 1;
      output = parentOutput(this.cvStack[remaining], outputCv(output));
    }
    return output;
  }
}
