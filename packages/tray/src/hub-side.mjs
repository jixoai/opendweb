// hub 侧只读数据面 + 子进程动作面（home-hub Phase 3a，2026-09-23）。
// 意图（对齐 packages/opendweb/src/hub.mjs 的文件形态——只读不写）：
// 1. hub 状态文件族读取：hub.json（缺失=未配置；损坏=parseError→error 态）、
//    hub.pid（pid 数字可读即采纳）、hub-token（0600 私有文件，trim 后仅用于
//    本进程内的回环 admin 轮询——绝不返回给任何输出面）；
// 2. 运行判定原语：pid 存活探测（kill 0；完整 lstart+argv 摘要三元组身份
//    核验归 hub stop/status，1s 心跳 tick 只做进程存活，语义=「进程活=running」）；
// 3. admin 面轮询：GET http://127.0.0.1:<port>/admin/status（Bearer hub-token，
//    超时兜底；失败返回 null 不抛——心跳轮次不被瞬时故障拖垮）；
// 4. hub 动作子进程：node <opendweb bin> hub start|stop|autostart（绝对路径
//    经包解析，DWEB_HOME 注入 env；输出捕获后归一为业务 error 映射，消息
//    全 ASCII 且冻结「hub not initialized」文案）。
// 妥协声明：hub.json 损坏与「配置存在但进程不在」同归 error 态（v1 四态
// schema 无 stopped 态；README 冻结该裁决）。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fsp from "node:fs/promises";
import path from "node:path";

/** DWEB_HOME 状态文件名（与 packages/opendweb/src/hub.mjs 同拍） */
export const HUB_STATE_FILE = "hub.json";
export const HUB_TOKEN_FILE = "hub-token";
export const HUB_PID_FILE = "hub.pid";

/** admin 轮询与 hub 子进程的兜底参数 */
const ADMIN_POLL_TIMEOUT_MS = 2000;
const HUB_COMMAND_TIMEOUT_MS = 30_000;

/**
 * @param {string} s
 * @returns {string} 非 ASCII 字节归一为 \xNN（CLI 错误消息入 JSON-RPC 前的纪律出口）
 */
function ascii(s) {
  let out = "";
  for (const b of Buffer.from(String(s), "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * hub 状态文件族一次性读取（心跳每 tick 调用；全容错——任何读取/解析失败
 * 都折叠进返回值，绝不抛）。
 * @param {string} home
 * @returns {Promise<{ hubState: Record<string, unknown> | null, parseError: string | null, pidTriple: { pid: number } | null, token: string | null }>}
 */
export async function readHubSide(home) {
  let hubState = null;
  let parseError = null;
  try {
    const text = await fsp.readFile(path.join(home, HUB_STATE_FILE), "utf8");
    try {
      const obj = JSON.parse(text);
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("expected a JSON object");
      hubState = /** @type {Record<string, unknown>} */ (obj);
    } catch (e) {
      parseError = `invalid hub state file: ${/** @type {Error} */ (e).message}`;
    }
  } catch {
    /* ENOENT = 未配置 */
  }
  let pidTriple = null;
  try {
    const obj = JSON.parse(await fsp.readFile(path.join(home, HUB_PID_FILE), "utf8"));
    if (obj !== null && typeof obj === "object" && typeof obj.pid === "number" && Number.isInteger(obj.pid) && obj.pid > 0) {
      pidTriple = { pid: obj.pid };
    }
  } catch {
    /* 无 pid 文件/损坏 = 无运行证据 */
  }
  let token = null;
  try {
    const text = await fsp.readFile(path.join(home, HUB_TOKEN_FILE), "utf8");
    const t = text.trim();
    if (t !== "") token = t;
  } catch {
    /* 缺 token = 轮询不可用，心跳照常 */
  }
  return { hubState, parseError, pidTriple, token };
}

/**
 * pid 存活判定（kill 0 探测；EPERM=存活但属他人——与 hub.mjs 同语义）。
 * @param {number} pid
 * @returns {boolean}
 */
export function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * gateway_bind（如 "0.0.0.0:8787"/"[::]:8787"）→ admin 面回环基址。
 * @param {unknown} bind
 * @returns {string} http://127.0.0.1:<port>（端口不可解析时回落默认 8787）
 */
export function adminBase(bind) {
  const s = typeof bind === "string" ? bind : "";
  const i = s.lastIndexOf(":");
  const port = Number(s.slice(i + 1).replace("]", ""));
  const p = i === -1 || !Number.isInteger(port) ? 8787 : port;
  return `http://127.0.0.1:${p}`;
}

/**
 * 回环 admin 状态轮询（Bearer hub-token；2s 超时）。token 只进本请求的
 * Authorization 头——返回值与任何日志都不携带它。
 * @param {string} base
 * @param {string} token
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<number | null>} knocks_pending（解析失败/HTTP 非 200/超时 → null）
 */
export async function pollKnocks(base, token, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? ADMIN_POLL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/admin/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body === null || typeof body !== "object") return null;
    const n = /** @type {Record<string, unknown>} */ (body).knocks_pending;
    return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const nodeRequire = createRequire(import.meta.url);

/**
 * opendweb CLI bin 绝对路径（hub 动作子进程入口；经包解析——同 hub 插件
 * 先例的「绝对路径解析」纪律）。解析失败返回 null（调用方归一为业务 error）。
 * @returns {string | null}
 */
export function resolveOpendwebBin() {
  try {
    const pkgJson = nodeRequire.resolve("opendweb/package.json");
    return path.join(path.dirname(pkgJson), "bin", "opendweb.mjs");
  } catch {
    return null;
  }
}

/**
 * hub 动作子进程：node <bin> hub <args...>（DWEB_HOME 注入 env；输出捕获；
 * 30s 超时兜底 SIGKILL）。绝不抛——调用方按 code/stderr 裁决。
 * @param {{ binPath: string, args: string[], home: string, execPath?: string, spawnImpl?: typeof spawn, env?: Record<string, string | undefined>, timeoutMs?: number }} input
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function runHubCommand({ binPath, args, home, execPath = process.execPath, spawnImpl = spawn, env = process.env, timeoutMs = HUB_COMMAND_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(execPath, [binPath, "hub", ...args], {
        cwd: home,
        env: { ...env, DWEB_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: String(/** @type {Error} */ (e).message) });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    child.stdin?.on("error", () => {});
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, stdout: out, stderr: `${err}\n(timeout after ${timeoutMs}ms)` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: out, stderr: String(e.message) });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout: out, stderr: err });
    });
  });
}

/**
 * hub 子进程失败 → 业务 error 映射（消息冻结面）：
 * - 未初始化（CLI 退出 2 + "not initialized"）→ "hub not initialized"（golden 冻结）；
 * - 其余失败 → "hub command failed (<首个非空 stderr 行, ASCII>)"。
 * @param {{ code: number | null, stdout: string, stderr: string }} res
 * @returns {{ code: -32000, message: string }}
 */
export function mapHubCommandError(res) {
  if (/not initialized/i.test(res.stderr) || /not initialized/i.test(res.stdout)) {
    return { code: -32000, message: "hub not initialized" };
  }
  const first = res.stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return { code: -32000, message: first !== "" ? `hub command failed (${ascii(first)})` : "hub command failed" };
}
