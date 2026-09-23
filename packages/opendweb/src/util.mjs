// 共享工具：动态值 ASCII 纪律（D10）、CLI 退出语义与 [H6] 机器名/别名工具。
// 意图（2026-08-29，plugin-marketplace）：bin 与 src 各模块共用，避免双向依赖。
// 意图（2026-09-23，home-hub [H6]）：默认别名=本机机器名——join 自报与
// id 展示共用同一 hostname 规范化 + UTF-8 字节截断实现。

import os from "node:os";

/** 动态值 ASCII 纪律：UTF-8 字节小写 \xNN，控制字符同转义保一行一错误 */
export function asciiEscape(v) {
  const s = String(v);
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * 插件/CLI 统一错误：message 已含 "error: " 前缀语义；exitCode 默认 1。
 * 用法：throw new CliExit("msg", 2)
 */
export class CliExit extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** 读文本文件（ENOENT → null） */
export async function readTextIfExists(fs, path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code === "ENOENT") return null;
    throw e;
  }
}

// ---- home-hub [H6]：默认别名 = 本机机器名 --------------------------------------

/** 自报别名上限（与服务端 ALIAS_MAX_BYTES / alias_hint 同拍：≤32 UTF-8 字节） */
export const ALIAS_MAX_BYTES = 32;

/**
 * 本机机器名（[H6] 称呼层默认值）：os.hostname() 剥尾部 `.local` 后缀
 * （macOS Bonjour 形态；大小写不敏感匹配）。空输入透传空（调用方以空
 * 判定「无自报」）。
 * @param {string} [raw] 可注入替身（测试）；缺省 = os.hostname()
 * @returns {string}
 */
export function machineName(raw = os.hostname()) {
  const lower = raw.toLowerCase();
  if (lower.endsWith(".local")) {
    return raw.slice(0, -".local".length);
  }
  return raw;
}

/**
 * 按 UTF-8 字节上限截断到合法字符边界（不劈开多字节字符；[H6] 超限
 * 截断到合法边界并在调用方输出提示）。
 * @param {string} s
 * @param {number} maxBytes
 * @returns {{ value: string, truncated: boolean }}
 */
export function truncateUtf8Bytes(s, maxBytes) {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= maxBytes) return { value: s, truncated: false };
  // 回退到多字节序列的首字节（continuation byte = 10xxxxxx）
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return { value: bytes.subarray(0, cut).toString("utf8"), truncated: true };
}
