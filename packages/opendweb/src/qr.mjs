// 接入卡片 ASCII 二维码（home-hub [H1] 1e）：自含 byte-mode QR 编码器
// （EC level L、version 1..6 自动、mask 0..7 罚分择优）+ 终端 ASCII 渲染。
// 意图：CLI 终端卡片不引入依赖（design §3.2「CLI 终端 ASCII QR（自含实
// 现）、webui SVG（同算法）」——本模块即该算法的单源；webui Phase 2 复
// 用同一矩阵生成，只换渲染层）。
// 实现依据 ISO/IEC 18004：GF(256)（本原多项式 0x11d）Reed-Solomon 纠错、
// byte 模式段（mode 0100 + 8 bit 计数，v1-9）、0xEC/0x11 填充、数据蛇形
// 布置（跳过第 6 列）、mask 罚分 N1=3/N2=3/N3=40/N4=10、format info
// BCH(15,5)（生成多项式 0x537，XOR 掩码 0x5412）。
// 纠错表（L）与对齐中心（v1..6）按标准冻结；载荷 > v6-L 容量（106 字节）
// 明确报错（URL 用途远低于上限）。

import { Buffer } from "node:buffer";

// ---- GF(256) -------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

/** @param {number} a @param {number} b */
function gmul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * RS 生成多项式系数（次数 degree；result[i] 为 x^i 项—— Nayuki 形态：
 * result[degree-1] 初值 1，逐根 (x - α^i) 乘入）。
 * @param {number} degree
 * @returns {number[]}
 */
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gmul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gmul(root, 2);
  }
  return result;
}

/**
 * 数据码字的 RS 余式（= 纠错码字）。
 * @param {number[]} data
 * @param {number[]} divisor
 * @returns {number[]}
 */
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) {
      result[i] ^= gmul(divisor[i], factor);
    }
  }
  return result;
}

// ---- 版本表（EC level L，v1..6；对齐中心列冻结） ---------------------------------

/**
 * @typedef {Object} QrVersion
 * @property {number} version
 * @property {number} size
 * @property {number} dataCodewords
 * @property {number} ecPerBlock
 * @property {number} blockCount
 * @property {number[]} alignCenters
 */

/** @type {QrVersion[]} */
const VERSIONS_L = [
  { version: 1, size: 21, dataCodewords: 19, ecPerBlock: 7, blockCount: 1, alignCenters: [] },
  { version: 2, size: 25, dataCodewords: 34, ecPerBlock: 10, blockCount: 1, alignCenters: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, ecPerBlock: 15, blockCount: 1, alignCenters: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, ecPerBlock: 20, blockCount: 1, alignCenters: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, ecPerBlock: 26, blockCount: 1, alignCenters: [6, 30] },
  { version: 6, size: 41, dataCodewords: 136, ecPerBlock: 18, blockCount: 2, alignCenters: [6, 34] },
];

// ---- 比特缓冲与数据段 -----------------------------------------------------------

class BitBuffer {
  constructor() {
    /** @type {number[]} */
    this.bits = [];
  }
  /**
   * @param {number} value
   * @param {number} len
   */
  push(value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0);
      out.push(b);
    }
    return out;
  }
  get length() {
    return this.bits.length;
  }
}

/**
 * byte 模式数据码字（mode 0100 + 8 bit 计数 + 数据 + 终止符 + 0xEC/0x11
 * 填充到版本容量）。导出供测试逐位核对比特流。
 * @param {string} text
 * @param {QrVersion} v
 * @returns {number[]}
 */
export function qrDataCodewords(text, v) {
  const bytes = [...Buffer.from(text, "utf8")];
  const capacityBits = v.dataCodewords * 8;
  const buf = new BitBuffer();
  buf.push(0b0100, 4);
  buf.push(bytes.length, 8); // v1-9 byte 模式计数 8 bit
  for (const b of bytes) buf.push(b, 8);
  for (let i = 0; i < 4 && buf.length < capacityBits; i++) buf.push(0, 1);
  while (buf.length % 8 !== 0) buf.push(0, 1);
  const out = buf.toBytes();
  const pad = [0xec, 0x11];
  let pi = 0;
  while (out.length < v.dataCodewords) out.push(pad[pi++ % 2]);
  return out;
}

// ---- 矩阵 ----------------------------------------------------------------------

/**
 * @param {number} size
 * @returns {{ modules: number[][], reserved: boolean[][] }}
 */
function blankMatrix(size) {
  return {
    modules: Array.from({ length: size }, () => new Array(size).fill(0)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

/**
 * @param {number[][]} modules
 * @param {boolean[][]} reserved
 * @param {number} row
 * @param {number} col
 * @param {boolean} dark
 */
function setFunctionModule(modules, reserved, row, col, dark) {
  modules[row][col] = dark ? 1 : 0;
  reserved[row][col] = true;
}

/**
 * @param {{ modules: number[][], reserved: boolean[][] }} m
 * @param {number} size
 */
function drawFinders(m, size) {
  /**
   * @param {number} r
   * @param {number} c
   */
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const dark =
          dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFunctionModule(m.modules, m.reserved, rr, cc, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
}

/**
 * @param {{ modules: number[][], reserved: boolean[][] }} m
 * @param {QrVersion} v
 */
function drawTimingAndAlignment(m, v) {
  const size = v.size;
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunctionModule(m.modules, m.reserved, 6, i, dark);
    setFunctionModule(m.modules, m.reserved, i, 6, dark);
  }
  for (const r of v.alignCenters) {
    for (const c of v.alignCenters) {
      // 与 finder（含分隔带）重叠的组合不画（v2..6 的 6/18.. 角组合）
      if (r <= 8 && c <= 8) continue;
      if (r <= 8 && c >= size - 9) continue;
      if (r >= size - 9 && c <= 8) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(m.modules, m.reserved, r + dr, c + dc, dark);
        }
      }
    }
  }
  // 暗模块： (4v+9, 8)
  setFunctionModule(m.modules, m.reserved, size - 8, 8, true);
}

/** format 信息两份的模块坐标（copy1 环绕左上 finder；copy2 右下两段） */
function formatPositions(size) {
  /** @type {Array<[number, number]>} */
  const copy1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  /** @type {Array<[number, number]>} */
  const copy2 = [];
  for (let i = 0; i < 7; i++) copy2.push([size - 1 - i, 8]);
  for (let j = 0; j < 8; j++) copy2.push([8, size - 8 + j]);
  return { copy1, copy2 };
}

/**
 * @param {{ modules: number[][], reserved: boolean[][] }} m
 * @param {number} size
 */
function reserveFormat(m, size) {
  for (const [r, c] of [...formatPositions(size).copy1, ...formatPositions(size).copy2]) {
    m.reserved[r][c] = true;
  }
}

/** mask 函数（ISO 18004 表） */
const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * 生成 QR 矩阵（模块值 1=暗 0=亮；EC level L、version 自动 v1..6、mask 罚分
 * 择优）。
 * @param {string} text
 * @returns {{ size: number, modules: number[][], version: number, mask: number }}
 * @throws {Error} 载荷超 v6-L 容量
 */
export function qrMatrix(text) {
  const byteLen = Buffer.byteLength(text, "utf8");
  const v = VERSIONS_L.find((x) => x.dataCodewords >= byteLen + 2); // 2 字节段开销上取整边界
  if (!v) {
    throw new Error(`QR payload too large: ${byteLen} bytes exceeds version 6-L capacity (106 bytes)`);
  }
  // 数据码字 → 分块 → RS 纠错 → 交错
  const data = qrDataCodewords(text, v);
  const perBlock = Math.floor(v.dataCodewords / v.blockCount);
  const blocks = [];
  for (let i = 0; i < v.blockCount; i++) {
    blocks.push(data.slice(i * perBlock, (i + 1) * perBlock));
  }
  const ecBlocks = blocks.map((b) => rsRemainder(b, rsDivisor(v.ecPerBlock)));
  /** @type {number[]} */
  const interleaved = [];
  for (let i = 0; i < perBlock; i++) {
    for (const b of blocks) interleaved.push(b[i]);
  }
  for (let i = 0; i < v.ecPerBlock; i++) {
    for (const b of ecBlocks) interleaved.push(b[i]);
  }
  const bits = interleaved.flatMap((b) => {
    const out = [];
    for (let j = 7; j >= 0; j--) out.push((b >> j) & 1);
    return out;
  });

  // 功能模块 + format 预留
  const m = blankMatrix(v.size);
  drawFinders(m, v.size);
  drawTimingAndAlignment(m, v);
  reserveFormat(m, v.size);

  // 数据蛇形布置（自右下、两列一对、跳过第 6 列；预留位跳过）
  let bitIndex = 0;
  let upward = true;
  for (let col = v.size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < v.size; i++) {
      const row = upward ? v.size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!m.reserved[row][c]) {
          m.modules[row][c] = bitIndex < bits.length ? bits[bitIndex] : 0;
          bitIndex++;
        }
      }
    }
    upward = !upward;
  }

  // mask 择优（罚分只作用于暗模块模式；format 模块不参与掩码）
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules = m.modules;
  for (let mask = 0; mask < 8; mask++) {
    const masked = m.modules.map((row) => row.slice());
    for (let r = 0; r < v.size; r++) {
      for (let c = 0; c < v.size; c++) {
        if (!m.reserved[r][c] && MASK_FNS[mask](r, c)) masked[r][c] ^= 1;
      }
    }
    const penalty = maskPenalty(masked, v.size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = masked;
    }
  }

  // format info（L=01）写入两份
  const fmt = bch15((0b01 << 3) | bestMask);
  const { copy1, copy2 } = formatPositions(v.size);
  const positions = [...copy1, ...copy2];
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >>> (14 - i)) & 1;
    const [r, c] = positions[i];
    bestModules[r][c] = bit;
  }

  return { size: v.size, modules: bestModules, version: v.version, mask: bestMask };
}

/**
 * BCH(15,5)：data(5 bit) → 15 bit format（含 XOR 掩码 0x5412）。
 * @param {number} data
 * @returns {number}
 */
export function bch15(data) {
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/**
 * mask 罚分（N1 行/列长串=3+(len-5)；N2 2×2 同色=3；N3 1:1:3:1:1 探测
 * 样式=40；N4 暗占比偏离 50%=10·档）。
 * @param {number[][]} modules
 * @param {number} size
 * @returns {number}
 */
function maskPenalty(modules, size) {
  let penalty = 0;
  // N1/N3：行与列
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      /** @type {number[]} */
      const line = [];
      for (let j = 0; j < size; j++) {
        line.push(axis === 0 ? modules[i][j] : modules[j][i]);
      }
      penalty += lineRuns(line);
      penalty += finderLikeRuns(line);
    }
  }
  // N2
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      if (modules[r][c] === modules[r][c + 1] && modules[r][c] === modules[r + 1][c] && modules[r][c] === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }
  // N4
  let dark = 0;
  for (const row of modules) for (const v of row) dark += v;
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return penalty;
}

/**
 * @param {number[]} line
 * @returns {number}
 */
function lineRuns(line) {
  let penalty = 0;
  let runColor = line[0];
  let runLen = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === runColor) {
      runLen++;
    } else {
      if (runLen >= 5) penalty += 3 + (runLen - 5);
      runColor = line[i];
      runLen = 1;
    }
  }
  if (runLen >= 5) penalty += 3 + (runLen - 5);
  return penalty;
}

/**
 * @param {number[]} line
 * @returns {number}
 */
function finderLikeRuns(line) {
  // 亮-暗交替 00001011101（或镜像 10111010000）
  let penalty = 0;
  for (let i = 0; i + 11 <= line.length; i++) {
    const seg = line.slice(i, i + 11);
    if (seg.join("") === "00001011101" || seg.join("") === "10111010000") penalty += 40;
  }
  return penalty;
}

// ---- ASCII 渲染 -----------------------------------------------------------------

/**
 * 终端 ASCII 渲染：每模块 2 字符宽（终端字符 ~2:1 高，双宽保持正方形比例），
 * 暗块 "██"、亮块空格；四周 4 模块静区。
 * @param {number[][]} modules
 * @returns {string}
 */
export function renderQrAscii(modules) {
  const n = modules.length;
  const quiet = 4;
  /** @type {string[]} */
  const lines = [];
  for (let r = -quiet; r < n + quiet; r++) {
    let line = "";
    for (let c = -quiet; c < n + quiet; c++) {
      const dark = r >= 0 && r < n && c >= 0 && c < n ? modules[r][c] === 1 : false;
      line += dark ? "██" : "  ";
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

/**
 * 一站式：文本 → ASCII QR。
 * @param {string} text
 * @returns {string}
 */
export function qrAscii(text) {
  return renderQrAscii(qrMatrix(text).modules);
}
