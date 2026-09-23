// opendweb hub —— 中枢命令族（home-hub Phase 1a/1b/1c/1e，[H7]-O-2）。
// 意图：把常开机器一键变成家庭中枢——状态模型（DWEB_HOME 文件族）、统一
// 守护进程模型（detached/--foreground/系统服务同一执行链）、开机自启、接入
// 短码与卡片。纪律（openspec home-hub specs/cli/hub）：
//   - 默认不启动（[H3]）：本模块不引入任何隐式启动路径；hub.json 不存在时
//     所有子命令只指引 init，零副作用。
//   - hub-token（CSPRNG 32B base64url，0600 原子写）绝不出现在 argv/plist/
//     启动脚本/日志/输出/卡片/URL；链入口以 env DWEB_ADMIN_TOKEN 注入
//     （覆盖继承值——四宿主同一注入点）。
//   - hub.pid 三元组 {pid, start_identity, argv_digest}：stop/status 三重
//     核验（pid 活+启动时刻+命令摘要），任一不符=不发信号只报告。
//   - init 零残留：hub.json 全流程最后写；任一步失败清理 hub-token。
//   - 平台冻结 darwin-arm64/win32-x64；非承诺平台明确错误、零副作用。

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadMarketplace } from "./marketplace.mjs";
import { loadConfigFile } from "./config-file.mjs";
import { loadDeclaredPlugins, fireHook } from "./plugin-runtime.mjs";
import { qrAscii } from "./qr.mjs";
import {
  applyServerOverrides,
  makeSingleFlightShutdown,
  normalizePublicUrl,
  probeBindBase,
  resolveServerArgs,
  validateBind,
  validatePublicUrl,
  waitForGatewayReady,
} from "./server-chain.mjs";
import {
  ALIAS_MAX_BYTES,
  CliExit,
  asciiEscape,
  encodeShortCode,
  formatShortCodeForDisplay,
  machineName,
  networkIPv4s,
  routableIPv6s,
  truncateUtf8Bytes,
} from "./util.mjs";

const execFileAsync = promisify(execFile);

/** DWEB_HOME 状态文件名（specs/cli/hub「中枢状态模型」冻结） */
export const HUB_STATE_FILE = "hub.json";
export const HUB_TOKEN_FILE = "hub-token";
export const HUB_PID_FILE = "hub.pid";
export const HUB_DATA_DIRNAME = "hub-data";
export const HUB_LOCK_NAME = "hub.lock";
export const HUB_LOG_NAME = "hub.log";
export const LAUNCH_AGENT_LABEL = "com.opendweb.hub";

/** 承诺平台（与 bin 顶层 PLATFORMS 同拍） */
const HUB_PLATFORMS = ["darwin-arm64", "win32-x64"];

/** 接管自动探测端口集（默认端口与常见变体；/healthz on 127.0.0.1） */
const TAKEOVER_PROBE_PORTS = [8787, 8788, 18787, 9878];

/** hub.lock 陈锁判定：>10s 且 pid 死可打破 */
const STALE_LOCK_MS = 10_000;

/** 本 CLI bin 绝对路径（detached 自举与 plist ProgramArguments 冻结元组） */
export const HUB_BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");

/**
 * @param {string} home
 * @returns {string}
 */
export function hubStateFile(home) {
  return path.join(home, HUB_STATE_FILE);
}
/**
 * @param {string} home
 * @returns {string}
 */
export function hubTokenFile(home) {
  return path.join(home, HUB_TOKEN_FILE);
}
/**
 * @param {string} home
 * @returns {string}
 */
export function hubPidFile(home) {
  return path.join(home, HUB_PID_FILE);
}
/**
 * @param {string} dataDir
 * @returns {string}
 */
export function hubLockDir(dataDir) {
  return path.join(dataDir, HUB_LOCK_NAME);
}
/**
 * @param {string} dataDir
 * @returns {string}
 */
export function hubLogFile(dataDir) {
  return path.join(dataDir, HUB_LOG_NAME);
}

// ---- 通用小件 -------------------------------------------------------------------

/**
 * 0600 原子写（SecretStore 纪律：唯一 tmp O_EXCL + chmod 0600 + fsync +
 * rename；目标已存在且为符号链接=拒绝）。失败清理 tmp。
 * @param {string} file
 * @param {string} data
 */
async function atomicWrite0600(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fsp.lstat(file).catch(() => null);
  if (st !== null && st.isSymbolicLink()) {
    throw new Error(`refusing to write through a symbolic link: ${file}`);
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fh = await fsp.open(tmp, "wx");
    try {
      try {
        await fh.chmod(0o600);
      } catch { /* Windows best effort */ }
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`cannot write ${file}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * 命令行摘要（pid 三元组第三元：sha256(ps command)）。
 * @param {string} command
 * @returns {string}
 */
export function digestCommand(command) {
  return crypto.createHash("sha256").update(command).digest("hex");
}

/**
 * pid 存活判定（kill 0 探测；EPERM=存活但属他人）。
 * @param {number} pid
 * @returns {boolean}
 */
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * 子进程执行（launchctl/ps/防火墙探测共用；超时 15s 兜底）。失败返回
 * code=null + message，绝不抛——调用方按 code/stderr 裁决。
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
async function defaultRun(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 15_000, encoding: "utf8" });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException & { stdout?: string, stderr?: string, code?: number | string }} */ (e);
    return {
      code: typeof err.code === "number" ? err.code : null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? `${cmd} failed`),
    };
  }
}

/**
 * 平台进程身份（start_identity=启动时刻，macOS `ps -o lstart=` / Windows
 * CreationDate；command=内核视角完整命令行）。进程死亡返回 null。
 * @param {number} pid
 * @returns {Promise<{ lstart: string, command: string } | null>}
 */
async function defaultReadProcessIdentity(pid) {
  if (process.platform === "darwin") {
    const lstart = await defaultRun("ps", ["-o", "lstart=", "-p", String(pid)]);
    const command = await defaultRun("ps", ["-o", "command=", "-p", String(pid)]);
    if (lstart.code !== 0 || command.code !== 0 || lstart.stdout.trim() === "") return null;
    return { lstart: lstart.stdout.trim(), command: command.stdout.trim() };
  }
  if (process.platform === "win32") {
    const res = await defaultRun("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}") | ConvertTo-Json`,
    ]);
    if (res.code !== 0) return null;
    const text = res.stdout.trim();
    if (text === "" || text === "null") return null;
    try {
      const obj = /** @type {Record<string, unknown>} */ (JSON.parse(text));
      if (obj === null || typeof obj !== "object") return null;
      return { lstart: String(obj.CreationDate ?? ""), command: String(obj.CommandLine ?? "") };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 静态文案用的机器名（控制字符清洗；UTF-8 超长按 [H6] 同款截断）。
 * @param {string} hostname
 * @returns {string}
 */
function displayMachineName(hostname) {
  const raw = machineName(hostname).replace(/[\x00-\x1f\x7f]/g, "");
  return truncateUtf8Bytes(raw, ALIAS_MAX_BYTES).value;
}

/**
 * @param {string} url
 */
function defaultOpenBrowser(url) {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore" }).on("error", () => {});
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" }).on("error", () => {});
  } else {
    console.log(`open ${url} in a browser`);
  }
}

// ---- hub 上下文（测试注入面） ----------------------------------------------------

/**
 * @typedef {Object} HubCtx
 * @property {string} [home]
 * @property {() => number} [now]
 * @property {typeof fetch} [fetchImpl]
 * @property {(prompt: string) => Promise<boolean>} [confirm]
 * @property {(line: string) => void} [stdout]
 * @property {string} [hostname]
 * @property {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces]
 * @property {(pid: number) => Promise<{ lstart: string, command: string } | null>} [readProcessIdentity]
 * @property {(pid: number) => boolean} [isPidAlive]
 * @property {(cmd: string, args: string[]) => Promise<{ code: number | null, stdout: string, stderr: string }>} [run]
 * @property {typeof spawn} [spawnImpl]
 * @property {(url: string) => void} [openBrowser]
 * @property {{ plist?: string, startupCmd?: string }} [servicePaths]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [webuiCliPath]
 * @property {boolean} [isTTY]
 * @property {string} [cwd] init 的数据目录/配置发现基点（默认 process.cwd()）
 */

/**
 * @param {Partial<HubCtx>} [ctx]
 * @returns {Required<HubCtx>}
 */
function resolveHubCtx(ctx = {}) {
  return {
    home: ctx.home ?? process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb"),
    cwd: ctx.cwd ?? process.cwd(),
    now: ctx.now ?? Date.now,
    fetchImpl: ctx.fetchImpl ?? fetch,
    confirm: ctx.confirm ?? null,
    stdout: ctx.stdout ?? ((line) => console.log(line)),
    hostname: ctx.hostname ?? os.hostname(),
    interfaces: ctx.interfaces ?? null,
    readProcessIdentity: ctx.readProcessIdentity ?? defaultReadProcessIdentity,
    isPidAlive: ctx.isPidAlive ?? defaultIsPidAlive,
    run: ctx.run ?? defaultRun,
    spawnImpl: ctx.spawnImpl ?? spawn,
    openBrowser: ctx.openBrowser ?? defaultOpenBrowser,
    servicePaths: ctx.servicePaths ?? {},
    platform: ctx.platform ?? process.platform,
    webuiCliPath: ctx.webuiCliPath ?? null,
    isTTY: ctx.isTTY ?? Boolean(process.stdin.isTTY),
  };
}

/**
 * 局域网候选地址（IPv4 优先全列，随后可路由 IPv6；均为呈现/短码可接受集）。
 * @param {Required<HubCtx>} c
 * @returns {string[]}
 */
function lanAddresses(c) {
  const interfaces = c.interfaces ?? os.networkInterfaces();
  return [...networkIPv4s(interfaces), ...routableIPv6s(interfaces)];
}

/**
 * 主呈现地址（首个 IPv4，无则首个可路由 IPv6，再无则 127.0.0.1）。
 * @param {Required<HubCtx>} c
 * @returns {string}
 */
function primaryLanIp(c) {
  return lanAddresses(c)[0] ?? "127.0.0.1";
}

/**
 * @param {string} bind
 * @returns {number}
 */
function portOf(bind) {
  const i = bind.lastIndexOf(":");
  const port = i === -1 ? NaN : Number(bind.slice(i + 1).replace("]", ""));
  return Number.isInteger(port) ? port : 8787;
}

/**
 * 呈现 URL（IPv6 加括号）。
 * @param {string} ip
 * @param {number} port
 * @returns {string}
 */
function lanUrl(ip, port) {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return `http://${host}:${port}`;
}

// ---- 状态模型 -------------------------------------------------------------------

/**
 * 载入 hub.json（无文件 → null；损坏/形状不对 → 报含路径错误）。
 * @param {string} home
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function loadHubState(home) {
  const file = hubStateFile(home);
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
  try {
    const obj = JSON.parse(text);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("expected a JSON object");
    return /** @type {Record<string, unknown>} */ (obj);
  } catch (e) {
    throw new Error(`invalid hub state file ${file}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * 原子保存 hub.json（0600；零残留纪律下只在完整状态就绪后调用）。
 * @param {string} home
 * @param {Record<string, unknown>} state
 */
export async function saveHubState(home, state) {
  await atomicWrite0600(hubStateFile(home), JSON.stringify(state, null, 2) + "\n");
}

/**
 * 生成并落盘 hub-token（CSPRNG 32B base64url + 0600 原子写）。返回 token
 * 内容供调用方注入 env——除注入点外不得流向任何输出面。
 * @param {string} home
 * @returns {Promise<string>}
 */
export async function writeHubToken(home) {
  const token = crypto.randomBytes(32).toString("base64url");
  await atomicWrite0600(hubTokenFile(home), token + "\n");
  return token;
}

/**
 * 读取 hub-token（缺失=未完成 init，明确指引）。
 * @param {string} home
 * @returns {Promise<string>}
 */
export async function readHubToken(home) {
  const file = hubTokenFile(home);
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") {
      throw new CliExit(`hub credential file is missing (${asciiEscape(file)}); run "opendweb hub init" again`, 1);
    }
    throw new Error(`cannot read hub credential file ${file}: ${err.message}`);
  }
  const token = text.trim();
  if (token === "") {
    throw new CliExit(`hub credential file is empty (${asciiEscape(file)}); run "opendweb hub init" again`, 1);
  }
  return token;
}

// ---- hub.pid 三元组 --------------------------------------------------------------

/**
 * @param {string} home
 * @param {{ pid: number, start_identity: string, argv_digest: string }} triple
 */
export async function writeHubPidTriple(home, triple) {
  await atomicWrite0600(hubPidFile(home), JSON.stringify(triple, null, 2) + "\n");
}

/**
 * @param {string} home
 * @returns {Promise<{ pid: number, start_identity: string, argv_digest: string } | null>}
 */
export async function readHubPidTriple(home) {
  let text;
  try {
    text = await fsp.readFile(hubPidFile(home), "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
  try {
    const obj = /** @type {Record<string, unknown>} */ (JSON.parse(text));
    const pid = obj.pid;
    const startIdentity = obj.start_identity;
    const argvDigest = obj.argv_digest;
    if (typeof pid !== "number" || typeof startIdentity !== "string" || typeof argvDigest !== "string") {
      throw new Error("malformed pid triple");
    }
    return { pid, start_identity: startIdentity, argv_digest: argvDigest };
  } catch (e) {
    throw new Error(`invalid hub pid file ${hubPidFile(home)}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * pid 三重核验（spec「pid 复用防护」：pid 活+启动时刻+命令摘要，任一不符
 * =不发信号只报告）。
 * @param {string} home
 * @param {Required<HubCtx>} c
 * @returns {Promise<{ status: "absent" } | { status: "not-running", recorded: { pid: number, start_identity: string, argv_digest: string } } | { status: "mismatch", recorded: { pid: number, start_identity: string, argv_digest: string }, live: { lstart: string, command: string } } | { status: "match", pid: number, live: { lstart: string, command: string } }>}
 */
export async function verifyPidTriple(home, c) {
  const recorded = await readHubPidTriple(home);
  if (recorded === null) return { status: "absent" };
  const live = await c.readProcessIdentity(recorded.pid);
  if (live === null) return { status: "not-running", recorded };
  if (live.lstart !== recorded.start_identity || digestCommand(live.command) !== recorded.argv_digest) {
    return { status: "mismatch", recorded, live };
  }
  return { status: "match", pid: recorded.pid, live };
}

// ---- hub.lock 目录锁 -------------------------------------------------------------

/**
 * 获取 `<data_dir>/hub.lock`（O_EXCL 目录锁；同目录第二进程=占用错误；
 * 陈锁 >10s 且 pid 死可打破）。
 * @param {string} dataDir
 * @param {Required<HubCtx>} c
 * @returns {Promise<{ ok: true, holderPid: number, release: () => Promise<void> } | { ok: false, holderPid: number | null, ageMs: number }>}
 */
export async function acquireHubLock(dataDir, c) {
  await fsp.mkdir(dataDir, { recursive: true });
  const lockDir = hubLockDir(dataDir);
  const infoFile = path.join(lockDir, "info.json");
  /**
   * @param {number} ts
   */
  const create = async (ts) => {
    await fsp.mkdir(lockDir); // EEXIST → 已被占用
    await fsp.writeFile(infoFile, `${JSON.stringify({ pid: process.pid, ts })}\n`, { mode: 0o600 });
  };
  try {
    await create(c.now());
    return { ok: true, holderPid: process.pid, release: () => fsp.rm(lockDir, { recursive: true, force: true }) };
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
  }
  // 占用方裁决：读 info.json（pid+ts）；>10s 且 pid 死 → 打破重建
  let holder = { pid: null, ts: c.now() };
  try {
    holder = /** @type {{ pid: number, ts: number }} */ (JSON.parse(await fsp.readFile(infoFile, "utf8")));
  } catch { /* 无 info/损坏：按新锁对待（不可打破） */ }
  const pid = typeof holder.pid === "number" ? holder.pid : null;
  const ageMs = c.now() - (typeof holder.ts === "number" ? holder.ts : c.now());
  if (pid !== null && ageMs > STALE_LOCK_MS && !c.isPidAlive(pid)) {
    await fsp.rm(lockDir, { recursive: true, force: true });
    try {
      await create(c.now());
      return { ok: true, holderPid: process.pid, release: () => fsp.rm(lockDir, { recursive: true, force: true }) };
    } catch {
      // 打破后被抢：fallthrough 报占用
    }
  }
  return { ok: false, holderPid: pid, ageMs };
}

// ---- admin 面双探 ----------------------------------------------------------------

/**
 * readiness 后 admin 面挂载断言（r3-P1-1）：无 token /admin/status 得 401
 * （已挂载）而非 404（未挂载），再以 hub-token 得 200。断言失败=启动失败。
 * @param {string} base
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function verifyAdminMounted(base, token, fetchImpl) {
  let noAuth;
  try {
    noAuth = await fetchImpl(`${base}/admin/status`);
  } catch (e) {
    return { ok: false, reason: `admin probe failed: ${/** @type {Error} */ (e).message}` };
  }
  if (noAuth.status === 404) {
    return { ok: false, reason: "admin API is not mounted (/admin/status returned 404) - the admin token env did not reach the server" };
  }
  if (noAuth.status !== 401) {
    return { ok: false, reason: `expected HTTP 401 without a token, got ${noAuth.status}` };
  }
  let withAuth;
  try {
    withAuth = await fetchImpl(`${base}/admin/status`, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    return { ok: false, reason: `admin probe failed: ${/** @type {Error} */ (e).message}` };
  }
  if (withAuth.status !== 200) {
    return { ok: false, reason: `expected HTTP 200 with the hub token, got ${withAuth.status}` };
  }
  return { ok: true };
}

// ---- 统一执行链（hub start --foreground；detached/系统服务同链） -------------------

/**
 * 中枢前台执行链：cwd=DWEB_HOME → hub.lock → env 冻结注入（DWEB_DATA_DIR/
 * DWEB_ADMIN_TOKEN 覆盖继承；绝不进 argv）→ 配置=config_path 显式（无则无
 * 配置，不依赖 cwd 发现）→ 插件钩子 → startServer → readiness → data_dir
 * 落点核实 + admin 双探 → 服务直至信号/退出（单飞停机级联，锁随停释放）。
 * 任何启动失败：停机 + 清 hub.lock + 非零退出（不假成功）。
 * @param {Required<HubCtx>} c
 * @returns {Promise<number>} 退出码
 */
export async function runHubForeground(c) {
  const home = c.home;
  const state = await loadHubState(home);
  if (state === null) {
    throw new CliExit(`hub is not initialized; run "opendweb hub init" first`, 2);
  }
  const dataDir = path.resolve(String(state.data_dir ?? ""));
  const gatewayBind = String(state.gateway_bind ?? "0.0.0.0:8787");
  const relayBind = String(state.relay_bind ?? "0.0.0.0:3340");
  // 全宿主统一 cwd=<DWEB_HOME>
  try {
    process.chdir(home);
  } catch (e) {
    throw new CliExit(`cannot enter DWEB_HOME ${asciiEscape(home)}: ${asciiEscape(/** @type {Error} */ (e).message)}`, 1);
  }
  const token = await readHubToken(home);

  const lock = await acquireHubLock(dataDir, c);
  if (!lock.ok) {
    throw new CliExit(
      `hub data directory is in use (pid ${lock.holderPid ?? "unknown"}, ${asciiEscape(dataDir)}); stop the other hub first`,
      1,
    );
  }
  /** @param {string} msg @returns {CliExit} */
  const failure = (msg) => {
    void lock.release();
    return new CliExit(msg, 1);
  };

  // ---- env 冻结（单一注入点：前台/detached/LaunchAgent/Startup 四宿主同路径）：
  // hub.json 的 data_dir/binds 与 hub-token 内容覆盖继承环境
  const env = process.env;
  env.DWEB_DATA_DIR = dataDir;
  env.DWEB_ADMIN_TOKEN = token;
  env.DWEB_GATEWAY_BIND = gatewayBind;
  env.DWEB_RELAY_HTTP_BIND = relayBind;
  env.DWEB_ACCESS_MODE = "restricted"; // 家庭预设：门禁开启
  const publicGateway = typeof state.public_gateway_url === "string" ? state.public_gateway_url : null;
  const publicRelay = typeof state.public_relay_url === "string" ? state.public_relay_url : null;
  if (publicGateway !== null) env.DWEB_PUBLIC_GATEWAY_URL = publicGateway;
  else delete env.DWEB_PUBLIC_GATEWAY_URL;
  if (publicRelay !== null) env.DWEB_PUBLIC_RELAY_URL = publicRelay;
  else delete env.DWEB_PUBLIC_RELAY_URL;

  // ---- 配置与插件（config_path 显式传入；无则无配置——不依赖 cwd 发现）
  let config = null;
  let configDir = home;
  const configPath = typeof state.config_path === "string" ? state.config_path : null;
  if (configPath !== null) {
    if (!fs.existsSync(configPath)) {
      throw failure(`frozen config file is missing: ${asciiEscape(configPath)}; restore it or re-run "opendweb hub init"`);
    }
    config = await loadConfigFile({
      path: configPath,
      validateUrl: (v) => validatePublicUrl(v, "config server url"),
    });
    configDir = path.dirname(configPath);
  }
  const resolved = resolveServerArgs([], env, config?.server ?? {});
  if ("error" in resolved) {
    throw failure(`invalid hub server configuration: ${asciiEscape(resolved.error)}`);
  }
  let plugins = [];
  if (config !== null && config.plugins.length > 0) {
    const { globs } = await loadMarketplace({ fs: fsp, path: path.join(home, "marketplace.json") });
    plugins = await loadDeclaredPlugins({ plugins: config.plugins, globs, cwd: home, configDir });
  }
  const pre = await fireHook({ plugins, hook: "server.preStart", payload: { server: { ...resolved } } });
  if (pre.failures.length > 0) {
    throw failure("a server.preStart plugin failed; hub not started");
  }
  const final = applyServerOverrides(resolved, pre.merged);

  const { startServer } = await import("@jixo/opendweb-server-binary");
  // publicGatewayUrl/publicRelayUrl 在 index.js 支持但 .d.ts 尚未同步——
  // 交叉类型补齐（值链与 bin runServer 完全一致）
  const serverOptions =
    /** @type {import("@jixo/opendweb-server-binary").StartServerOptions & { publicGatewayUrl?: string, publicRelayUrl?: string }} */ ({
      gatewayBind: final.gatewayBind,
      relayBind: final.relayBind,
      relayEnabled: final.relayEnabled,
      trustProxy: final.trustProxy,
      ...(final.publicGatewayUrl !== null ? { publicGatewayUrl: final.publicGatewayUrl } : {}),
      ...(final.publicRelayUrl !== null ? { publicRelayUrl: final.publicRelayUrl } : {}),
      accessMode: final.access.mode,
      accessPolicy: final.access.policy,
      ownersFile: final.access.ownersFile,
      callbackUrl: final.access.callbackUrl,
      callbackToken: final.access.callbackToken,
      callbackTimeoutMs: final.access.callbackTimeoutMs,
      callbackCacheTtlMs: final.access.callbackCacheTtlMs,
      allowLoopbackCallback: final.access.allowLoopbackCallback,
    });
  const server = await startServer(serverOptions);
  const probeBase = probeBindBase(final.gatewayBind);
  /**
   * 停机 + 清锁 + 抛错（启动失败=不假成功）。
   * @param {string} msg
   * @returns {Promise<never>}
   */
  const stopAndFail = async (msg) => {
    await server.stop();
    await lock.release();
    throw new CliExit(msg, 1);
  };
  let ready;
  try {
    ready = await Promise.race([
      waitForGatewayReady(probeBase),
      server.exited.then((code) => ({ exited: code })),
    ]);
  } catch (e) {
    await server.stop();
    await lock.release();
    throw new CliExit(`hub server did not become ready: ${asciiEscape(/** @type {Error} */ (e).message)}`, 1);
  }
  if (ready !== null && typeof ready === "object" && "exited" in ready && typeof ready.exited === "number") {
    await stopAndFail(`hub server exited during startup (code ${ready.exited})`);
  }

  // ---- data_dir 落点核实（防静默写错目录；不符=启动失败）
  const dataLanded =
    fs.existsSync(path.join(dataDir, "owners.jsonl")) || fs.existsSync(path.join(dataDir, "server.key"));
  if (!dataLanded) {
    await stopAndFail(
      `hub data verification failed: neither owners.jsonl nor server.key appeared in ${asciiEscape(dataDir)} (DWEB_DATA_DIR may have been overridden)`,
    );
  }
  // ---- admin 面挂载双探（401 非 404 + token 200）
  const admin = await verifyAdminMounted(probeBase, token, c.fetchImpl);
  if (admin.ok === false) {
    await stopAndFail(`hub admin mount verification failed: ${admin.reason}`);
  }

  c.stdout(`中枢已启动：${probeBase}。`);
  if (env.DWEB_HUB_SERVICE === "1") {
    c.stdout("（系统服务模式）");
  } else {
    c.stdout("Press Ctrl+C to stop");
  }
  const post = await fireHook({
    plugins,
    hook: "server.postReady",
    payload: {
      server: { ...final },
      gatewayUrl: probeBase,
      publicGatewayUrl: final.publicGatewayUrl,
      publicRelayUrl: final.publicRelayUrl,
    },
  });
  for (const f of post.failures) {
    console.error(`WARNING[plugin/${asciiEscape(f.name)}]: postReady failed (${asciiEscape(f.error)})`);
  }

  // 单飞停机（R6-Major 同款）：preStop 尽力 → 停 server → 释放锁 → exit
  const shutdown = makeSingleFlightShutdown({
    runPreStop: async () => {
      const preStop = await fireHook({ plugins, hook: "server.preStop", payload: { server: { ...final } } });
      for (const f of preStop.failures) {
        console.error(`WARNING[plugin/${asciiEscape(f.name)}]: preStop failed (${asciiEscape(f.error)})`);
      }
    },
    stopServer: async () => {
      await server.stop();
      await lock.release();
    },
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const code = await server.exited;
  await lock.release();
  return code ?? 0;
}

// ---- 自启（用户级系统服务） -------------------------------------------------------

/**
 * macOS LaunchAgent plist 生成物（design §1.4 冻结：RunAtLoad+KeepAlive；
 * ProgramArguments=绝对路径元组；WorkingDirectory=DWEB_HOME；
 * EnvironmentVariables={DWEB_HOME, DWEB_HUB_SERVICE=1}——DWEB_DATA_DIR 与
 * token 绝不落 plist，由链入口从 hub.json 注入）。
 * @param {{ execPath: string, binPath: string, home: string }} input
 * @returns {string}
 */
export function buildLaunchAgentPlist({ execPath, binPath, home }) {
  /** @param {string} s */
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
        <string>${esc(execPath)}</string>
        <string>${esc(binPath)}</string>
        <string>hub</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${esc(home)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DWEB_HOME</key>
        <string>${esc(home)}</string>
        <key>DWEB_HUB_SERVICE</key>
        <string>1</string>
    </dict>
</dict>
</plist>
`;
}

/**
 * Windows Startup .cmd 生成物（APPDATA 展开由安装路径承担；脚本内显式
 * `cd /d <DWEB_HOME>`；cmd 转义：空格引号包裹 + `%%` 双写；生成前对路径做
 * 包含性检查——含引号/控制字符的路径直接拒绝，含 `%` 的路径双写后必须仍
 * 能在脚本中还原出原路径）。
 * @param {{ execPath: string, binPath: string, home: string }} input
 * @returns {string}
 */
export function buildWindowsStartupCmd({ execPath, binPath, home }) {
  /** @param {string} p @returns {string} */
  const quote = (p) => {
    if (/["\r\n\x00-\x1f]/.test(p)) {
      throw new Error(`path contains characters that cannot be safely quoted in a .cmd file: ${JSON.stringify(p)}`);
    }
    return `"${p.replace(/%/g, "%%")}"`;
  };
  const qHome = quote(home);
  const qExec = quote(execPath);
  const qBin = quote(binPath);
  const script = `@echo off\r\ncd /d ${qHome}\r\n${qExec} ${qBin} hub start --foreground\r\n`;
  // 包含性检查：三个路径的转义形态必须原样出现在脚本中
  for (const needle of [qHome, qExec, qBin]) {
    if (!script.includes(needle)) {
      throw new Error(`cmd containment check failed for ${needle}`);
    }
  }
  return script;
}

/**
 * @param {string} [homeDir]
 * @returns {string}
 */
export function launchAgentPlistPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/**
 * @param {string} appData %APPDATA% 展开后的真实绝对路径
 * @returns {string}
 */
export function windowsStartupCmdPath(appData) {
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "opendweb-hub.cmd");
}

/**
 * 安装用户级系统服务（不提权）。安装失败抛 CliExit（调用方不更新 hub.json）。
 * @param {Required<HubCtx>} c
 */
async function installAutostartService(c) {
  const home = c.home;
  if (c.platform === "darwin") {
    const plistPath = c.servicePaths.plist ?? launchAgentPlistPath();
    const content = buildLaunchAgentPlist({ execPath: process.execPath, binPath: HUB_BIN_PATH, home });
    await fsp.mkdir(path.dirname(plistPath), { recursive: true });
    await fsp.writeFile(plistPath, content, { mode: 0o644 });
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const boot = await c.run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    if (boot.code !== 0) {
      // 幂等：已在加载态（自识别不重复 load）视为成功；其余失败回滚 plist
      const loaded = await c.run("launchctl", ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
      if (loaded.code !== 0) {
        await fsp.rm(plistPath, { force: true });
        throw new CliExit(
          `cannot load the LaunchAgent (${asciiEscape(plistPath)}): ${asciiEscape(boot.stderr.trim())}`,
          1,
        );
      }
    }
    return;
  }
  if (c.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new CliExit("APPDATA is not set; cannot install the startup script", 1);
    const cmdPath = c.servicePaths.startupCmd ?? windowsStartupCmdPath(appData);
    const content = buildWindowsStartupCmd({ execPath: process.execPath, binPath: HUB_BIN_PATH, home });
    await fsp.mkdir(path.dirname(cmdPath), { recursive: true });
    await fsp.writeFile(cmdPath, content, { mode: 0o644 });
    return;
  }
  throw new CliExit(`autostart is only supported on ${HUB_PLATFORMS.join(" / ")} (this is ${c.platform})`, 1);
}

/**
 * 卸载用户级系统服务（未加载视为成功——幂等）。失败抛 CliExit（不更新 hub.json）。
 * @param {Required<HubCtx>} c
 */
async function uninstallAutostartService(c) {
  if (c.platform === "darwin") {
    const plistPath = c.servicePaths.plist ?? launchAgentPlistPath();
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const boot = await c.run("launchctl", ["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`]);
    if (boot.code !== 0 && !/no such process|not found|not loaded|5:/i.test(boot.stderr)) {
      throw new CliExit(`cannot unload the LaunchAgent: ${asciiEscape(boot.stderr.trim())}`, 1);
    }
    await fsp.rm(plistPath, { force: true });
    return;
  }
  if (c.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new CliExit("APPDATA is not set; cannot remove the startup script", 1);
    const cmdPath = c.servicePaths.startupCmd ?? windowsStartupCmdPath(appData);
    await fsp.rm(cmdPath, { force: true });
    return;
  }
  throw new CliExit(`autostart is only supported on ${HUB_PLATFORMS.join(" / ")} (this is ${c.platform})`, 1);
}

// ---- init 自检 -------------------------------------------------------------------

/**
 * 端口 bind 探测：对冻结 bind 的 host（wildcard 加探 127.0.0.1）逐个试
 * listen——被占返回 true。macOS 下 SO_REUSEADDR 允许 wildcard 与具体地址
 * 共存，故 wildcard bind 也必须探回环地址（真实 server 绑定冲突面）。
 * @param {string} bind
 * @returns {Promise<boolean>} true = 被占用
 */
async function isBindOccupied(bind) {
  const i = bind.lastIndexOf(":");
  const host = i === -1 ? bind : bind.slice(0, i).replace(/^\[|\]$/g, "");
  const port = i === -1 ? NaN : Number(bind.slice(i + 1));
  if (!Number.isInteger(port)) return false;
  // 探测集：回环（具体持有者）+ 冻结 bind 的原 host（wildcard 持有者——同址
  // 冲突恒 EADDRINUSE）。BSD SO_REUSEADDR 允许 wildcard/具体共存，故两侧
  // 都要探；LAN 具体地址持有者检不出（残余风险由接管探测与人工排障兜底）。
  const hosts = new Set(["127.0.0.1", "::1", host]);
  for (const h of hosts) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, h, () => srv.close(() => resolve(true)));
    });
    if (!ok) return true;
  }
  return false;
}

/**
 * 防火墙状态（检测失败=unknown→警告不阻塞；产品不做越权系统变更）。
 * @param {Required<HubCtx>} c
 * @returns {Promise<"enabled" | "disabled" | "unknown">}
 */
async function firewallState(c) {
  if (c.platform === "darwin") {
    const res = await c.run("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]);
    if (res.code !== 0) return "unknown";
    if (/enabled/i.test(res.stdout)) return "enabled";
    if (/disabled/i.test(res.stdout)) return "disabled";
    return "unknown";
  }
  if (c.platform === "win32") {
    const res = await c.run("netsh", ["advfirewall", "show", "allprofiles", "state"]);
    if (res.code !== 0) return "unknown";
    return /\bON\b/i.test(res.stdout) ? "enabled" : "disabled";
  }
  return "unknown";
}

/**
 * 接管自动探测（尽力而为）：默认端口与常见变体 /healthz on 127.0.0.1。
 * 可证明运行中=found:true（拒绝接管）；探测不可达不构成已停证明。
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ found: boolean, url: string | null }>}
 */
export async function probeRunningOldServer(fetchImpl) {
  for (const port of TAKEOVER_PROBE_PORTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 400);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: ctrl.signal });
      if (res.ok) return { found: true, url: `http://127.0.0.1:${port}` };
    } catch { /* 不可达=无证据 */ } finally {
      clearTimeout(timer);
    }
  }
  return { found: false, url: null };
}

/**
 * 探测中枢网关 /healthz。
 * @param {string} base
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<boolean>}
 */
export async function probeGatewayHealthy(base, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetchImpl(`${base}/healthz`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 接入卡片（PM §4.4；CLI 与 init 尾部同源） ------------------------------------

/**
 * 渲染接入卡片（纯函数；卡片无凭证——不含 admin token/邀请码/回执材料）。
 * @param {{ machine: string, urls: string[], primaryUrl: string, shortCode: string }} input
 * @returns {string}
 */
export function renderHubCard({ machine, urls, primaryUrl, shortCode }) {
  const lines = [];
  lines.push("── 接入卡片 · 家里人怎么连 ────────────────────");
  lines.push(`中枢：${machine}`);
  lines.push(`地址：${primaryUrl}`);
  for (const u of urls.slice(1)) {
    lines.push(`      ${u}`);
  }
  lines.push(`短码：${shortCode} （电话里念给对方，等于上面的地址）`);
  lines.push("二维码：（扫一下，得到上面的地址）");
  lines.push(qrAscii(primaryUrl));
  lines.push("");
  lines.push("家里人的三步：");
  lines.push(" 1. 装 opendweb");
  lines.push(" 2. 扫二维码 / 输短码 / 手动填地址，连上中枢");
  lines.push(" 3. 等放行——家长在中枢管理台点「定位为访客」；");
  lines.push("    要自己的房间，就找家长拿邀请码注册成租户");
  lines.push("──────────────────────────────────────────────");
  return lines.join("\n");
}

/**
 * 组装并打印接入卡片（hub card 与 init 尾部同源调用）。
 * @param {Required<HubCtx>} c
 * @param {{ machine: string, port: number }} input
 */
function printHubCard(c, { machine, port }) {
  const addrs = lanAddresses(c);
  const primary = addrs[0] ?? "127.0.0.1";
  const primaryUrl = lanUrl(primary, port);
  const shortCode = formatShortCodeForDisplay(encodeShortCode(primary, port));
  const urls = addrs.map((a) => lanUrl(a, port));
  c.stdout(renderHubCard({ machine, urls, primaryUrl, shortCode }));
}

// ---- 命令实现 --------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ dataDir?: string, gateway?: string, relay?: string, publicGateway?: string, publicRelay?: string, yes: boolean }}
 */
function parseInitArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const opts = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const eq = t.indexOf("=");
    const name = eq === -1 ? t : t.slice(0, eq);
    if (name === "--yes") {
      if (eq !== -1) throw new CliExit("--yes takes no value", 2);
      opts.yes = true;
      continue;
    }
    if (!["--data-dir", "--gateway", "--relay", "--public-gateway", "--public-relay"].includes(name)) {
      throw new CliExit(`unknown option ${name}`, 2);
    }
    let value = eq === -1 ? undefined : t.slice(eq + 1);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new CliExit(`missing value for ${name}`, 2);
    }
    opts[name.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
  }
  return /** @type {{ dataDir?: string, gateway?: string, relay?: string, publicGateway?: string, publicRelay?: string, yes: boolean }} */ (opts);
}

/**
 * hub init（一次性：接管检测+家庭预设+自检+凭证+卡片+自启引导，交互确认；
 * hub.json 全流程最后写——零残留）。
 * @param {string[]} argv
 * @param {Required<HubCtx>} c
 * @returns {Promise<number>}
 */
export async function hubInit(argv, c) {
  const args = parseInitArgs(argv);
  const existing = await loadHubState(c.home);
  if (existing !== null) {
    c.stdout("这台机器已经是中枢了。家里第二台中枢请用另一台机器（一台机器一个中枢身份）。");
    return 0;
  }
  const machine = displayMachineName(c.hostname);
  const gatewayBind = args.gateway ?? "0.0.0.0:8787";
  const relayBind = args.relay ?? "0.0.0.0:3340";
  for (const [label, value] of /** @type {[string, string][]} */ ([["--gateway", gatewayBind], ["--relay", relayBind]])) {
    const err = validateBind(value, label);
    if (err) throw new CliExit(err, 2);
  }
  const publicGateway = args.publicGateway !== undefined ? normalizeOrThrow(args.publicGateway, "--public-gateway") : null;
  const publicRelay = args.publicRelay !== undefined ? normalizeOrThrow(args.publicRelay, "--public-relay") : null;

  // data_dir 解析：--data-dir 显式 > cwd 既有 dweb-data（含数据=只读接管，
  // data_dir 唯一规则）> <DWEB_HOME>/hub-data
  const cwd = c.cwd;
  let dataDir;
  if (args.dataDir !== undefined) {
    dataDir = path.resolve(cwd, args.dataDir);
  } else {
    const candidate = path.join(cwd, "dweb-data");
    dataDir = hasServerData(candidate) ? candidate : path.join(c.home, HUB_DATA_DIRNAME);
  }
  const configPath = discoverInitConfig(cwd);

  // ---- 接管协议（specs「接管既有数据目录」）----
  const takeover = hasServerData(dataDir);
  if (takeover) {
    const probe = await probeRunningOldServer(c.fetchImpl);
    if (probe.found) {
      c.stdout(`检测到旧服务仍在运行（${probe.url}/healthz 可达）。`);
      c.stdout("请先停止旧服务，再重新运行 opendweb hub init；opendweb 不会自动终止它。");
      return 1;
    }
    const okToTakeOver = await askConfirm(
      c,
      args.yes,
      [
        `检测到数据目录 ${dataDir} 已有一台 opendweb 服务器的数据（server.key/owners.jsonl）。`,
        "无法自动验证使用自定义端口的旧服务——请确认它已经停止。",
        "（若旧服务仍在运行：接管后同目录双开由 hub 启动锁阻止，但旧裸 server 不持锁的残余风险由本确认兜底。）",
        "确认旧服务已停止并接管？(y/N)",
      ].join("\n"),
    );
    if (!okToTakeOver) {
      c.stdout("已取消，未做任何更改。");
      return 1;
    }
  }

  // ---- 确认（PM §4.2 逐字）----
  const confirmed = await askConfirm(
    c,
    args.yes,
    [
      "把这台机器变成家里的中枢？",
      `这台机器：${machine} · 家庭端口：服务 ${portOf(gatewayBind)} · 中转 ${portOf(relayBind)}（可改）`,
      "将发生什么：",
      "· 起一台家庭服务器，门禁开启——只有你放行的人、和你发过邀请码的人能进",
      "· 生成管理凭证，保存到本机私有文件——不显示、不离开这台机器",
      "· 自检网络，告诉你家里人能不能连上",
      "",
      "中枢只管三件事：牵线、兜底、守门。家人互传的数据走设备直连，不经过这台机器。",
      ...(takeover ? [`· 接管既有数据目录：${dataDir}`] : []),
      "继续？(y/N)",
    ].join("\n"),
  );
  if (!confirmed) {
    c.stdout("已取消，未做任何更改。");
    return 1;
  }

  // ---- 凭证落地（PM 步骤 2：不显示是纪律）----
  await writeHubToken(c.home);
  c.stdout("管理凭证已保存到本机（仅这台机器的用户可读）。");

  // ---- 自检三态（PM 步骤 3）——失败=中止+清理（零残留）----
  const exitCode = await runInitSelfCheck(c, { gatewayBind, relayBind });
  if (exitCode !== 0) {
    await fsp.rm(hubTokenFile(c.home), { force: true });
    return exitCode;
  }

  // ---- 卡片（PM 步骤 4；init 尾部与 hub card 同源）----
  if (takeover) {
    c.stdout(`已接管家里的这台服务器（数据目录：${dataDir}，名册原样保留）。`);
  }
  printHubCard(c, { machine, port: portOf(gatewayBind) });

  // ---- 自启引导（PM 步骤 5；--yes 的非交互默认=不开启，[H3] 安全默认）----
  let autostartWanted = false;
  if (c.isTTY) {
    autostartWanted = await askConfirm(
      c,
      false,
      "要不要开机自启？这台机器重启后，中枢会自己回来。（随时可关：opendweb hub autostart off）",
    );
  }
  // hub.json 全流程最后写（零残留：此刻一切就绪）
  await saveHubState(c.home, {
    version: 1,
    data_dir: dataDir,
    gateway_bind: gatewayBind,
    relay_bind: relayBind,
    ...(publicGateway !== null ? { public_gateway_url: publicGateway } : {}),
    ...(publicRelay !== null ? { public_relay_url: publicRelay } : {}),
    ...(configPath !== null ? { config_path: configPath } : {}),
    initialized_at: new Date(c.now()).toISOString(),
    autostart: false,
  });
  if (autostartWanted) {
    try {
      await installAutostartService(c);
      await saveHubState(c.home, { ...(await loadHubStateOrThrow(c.home)), autostart: true });
      c.stdout("已开启。重启机器试试：中枢会自己回来，托盘图标会亮起。");
    } catch (e) {
      // 安装失败不假成功：回滚 autostart 并如实报告（hub.json 保持完整一致状态）
      const state = await loadHubStateOrThrow(c.home);
      await saveHubState(c.home, { ...state, autostart: false });
      throw e;
    }
  }
  return 0;
}

/**
 * init 自检（三态：通过/警告/失败）。失败返回非零退出码（调用方清理 token）。
 * @param {Required<HubCtx>} c
 * @param {{ gatewayBind: string, relayBind: string }} input
 * @returns {Promise<number>}
 */
async function runInitSelfCheck(c, { gatewayBind, relayBind }) {
  const gatewayPort = portOf(gatewayBind);
  const relayPort = portOf(relayBind);
  // 端口 bind 探测（失败态=端口被占，PM 3c 指引 --gateway 换端口）
  for (const [label, bind] of /** @type {[string, string][]} */ ([["gateway", gatewayBind], ["relay", relayBind]])) {
    if (await isBindOccupied(bind)) {
      const port = portOf(bind);
      const alt = port === 18787 ? 28787 : 18787;
      c.stdout(`端口 ${port} 已被其他程序占用。`);
      c.stdout(`换端口重来：opendweb hub init ${label === "gateway" ? "--gateway" : "--relay"} ${alt}；或先停掉占用它的程序。`);
      return 1;
    }
  }
  // 防火墙提示（检测失败=unknown 不阻塞；enabled=警告不阻塞）
  const fw = await firewallState(c);
  if (fw === "enabled") {
    c.stdout(`自检发现：防火墙可能挡住了端口 ${gatewayPort}，家里人可能连不上。`);
    c.stdout(
      c.platform === "win32"
        ? "去 Windows 安全中心→防火墙里放行 opendweb，然后运行 opendweb hub status 重新自检。"
        : "去系统设置的防火墙里放行 opendweb，然后运行 opendweb hub status 重新自检。",
    );
  }
  // 通过（局域网主地址呈现；无 LAN 地址时以回环呈现并提示）
  const primary = lanAddresses(c)[0];
  if (primary === undefined) {
    c.stdout("自检提示：未找到局域网地址（家里人暂时连不上；中枢仅本机可达 http://127.0.0.1:" + gatewayPort + "）。");
  } else {
    c.stdout(`自检通过：家里人应该能连上 ${lanUrl(primary, gatewayPort)}。`);
  }
  return 0;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasServerData(dir) {
  return fs.existsSync(path.join(dir, "server.key")) || fs.existsSync(path.join(dir, "owners.jsonl"));
}

/**
 * @param {string} cwd
 * @returns {string | null}
 */
function discoverInitConfig(cwd) {
  for (const name of ["opendweb.config.toml", "opendweb.config.json"]) {
    const p = path.resolve(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {string}
 */
function normalizeOrThrow(value, label) {
  const normalized = normalizePublicUrl(value);
  if (normalized === null) {
    throw new CliExit(validatePublicUrl(value, label) ?? `invalid ${label}: ${value}`, 2);
  }
  return normalized;
}

/**
 * @param {string} home
 * @returns {Promise<Record<string, unknown>>}
 */
async function loadHubStateOrThrow(home) {
  const state = await loadHubState(home);
  if (state === null) throw new CliExit("hub state disappeared unexpectedly", 1);
  return state;
}

/**
 * 确认原语：--yes 直过；注入 confirm 优先；否则 TTY readline（非 TTY=硬错误
 * 指引 --yes）。
 * @param {Required<HubCtx>} c
 * @param {boolean} yes
 * @param {string} prompt
 * @returns {Promise<boolean>}
 */
async function askConfirm(c, yes, prompt) {
  if (yes) return true;
  if (c.confirm !== null) return await c.confirm(prompt);
  if (!c.isTTY) {
    throw new CliExit("non-interactive session; re-run with --yes to proceed", 2);
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${prompt} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---- start / stop / status / card / open / autostart ------------------------------

/**
 * hub start [--foreground]：autostart on=安装/加载系统服务（不另起 detached、
 * 不写 pid）；否则 detached 自举（spawn(node, [bin, hub, start, --foreground],
 * {detached, stdio→hub.log}) + unref + 记 pid 三元组）；--foreground=本终端
 * 运行同一执行链。
 * @param {string[]} argv
 * @param {Required<HubCtx>} c
 * @returns {Promise<number>}
 */
export async function hubStart(argv, c) {
  let foreground = false;
  for (const t of argv) {
    if (t === "--foreground") foreground = true;
    else throw new CliExit(`unknown option ${t} (usage: opendweb hub start [--foreground])`, 2);
  }
  const state = await loadHubState(c.home);
  if (state === null) {
    throw new CliExit(`hub is not initialized; run "opendweb hub init" first`, 2);
  }
  if (foreground) {
    const code = await runHubForeground(c);
    return code;
  }
  if (state.autostart === true) {
    await installAutostartService(c);
    c.stdout(`中枢已启动（由系统服务托管；重启机器会自动回来）。`);
    return 0;
  }
  const dataDir = path.resolve(String(state.data_dir ?? ""));
  await fsp.mkdir(dataDir, { recursive: true });
  const logPath = hubLogFile(dataDir);
  const logFd = await fsp.open(logPath, "a").catch(async (e) => {
    throw new CliExit(`cannot open hub log ${asciiEscape(logPath)}: ${asciiEscape(/** @type {Error} */ (e).message)}`, 1);
  });
  const child = c.spawnImpl(process.execPath, [HUB_BIN_PATH, "hub", "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
    cwd: c.home,
    env: { ...process.env },
  });
  if (typeof child.pid !== "number") {
    await logFd.close();
    throw new CliExit("failed to spawn the hub daemon", 1);
  }
  const pid = child.pid;
  child.unref();
  await logFd.close();
  // 早退监视：启动窗口内退出（如 hub.lock 占用/配置失败）→ 读日志尾部如实报告
  const earlyExit = await Promise.race([
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(true);
      else child.once("exit", () => resolve(true));
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
  ]);
  if (earlyExit === true) {
    const tail = await readLogTail(logPath, 1600);
    throw new CliExit(
      `hub daemon exited during startup (log: ${asciiEscape(logPath)})${tail ? `:\n${tail}` : ""}`,
      1,
    );
  }
  // pid 三元组：等 ps 呈现守护命令行（exec 完成前可能短暂显示父进程镜像）
  const deadline = c.now() + 2000;
  let identity = null;
  for (;;) {
    identity = await c.readProcessIdentity(pid);
    if (identity !== null && /--foreground\s*$/.test(identity.command)) break;
    if (c.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await writeHubPidTriple(c.home, {
    pid,
    start_identity: identity?.lstart ?? "",
    argv_digest: digestCommand(identity?.command ?? ""),
  });
  const url = lanUrl(primaryLanIp(c), portOf(String(state.gateway_bind ?? "0.0.0.0:8787")));
  c.stdout(`中枢已启动：${url}。`);
  c.stdout(`（后台守护；日志：${asciiEscape(logPath)}）`);
  return 0;
}

/**
 * @param {string} logPath
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readLogTail(logPath, maxBytes) {
  try {
    const stat = await fsp.stat(logPath);
    const fh = await fsp.open(logPath, "r");
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const buf = Buffer.alloc(stat.size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf8").trim();
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

/**
 * 停止守护进程（pid 三重核验：match=SIGINT→5s→SIGKILL；其余=不发信号）。
 * @param {number} pid
 * @param {Required<HubCtx>} c
 * @returns {Promise<"stopped" | "not-running">}
 */
async function signalDaemon(pid, c) {
  const ok = await new Promise((resolve) => {
    try {
      process.kill(pid, "SIGINT");
    } catch {
      return resolve(false);
    }
    resolve(true);
  });
  if (!ok) return "not-running";
  const deadline = c.now() + 5000;
  while (c.now() < deadline) {
    if (!c.isPidAlive(pid)) return "stopped";
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
  return "stopped";
}

/**
 * hub stop [--yes]：autostart on=先卸载服务（失败不更新 hub.json、继续停残
 * 留、退出非零）；再按 pid 三元组停守护（任一不符=不发信号只报告）。
 * @param {string[]} argv
 * @param {Required<HubCtx>} c
 * @returns {Promise<number>}
 */
export async function hubStop(argv, c) {
  let yes = false;
  for (const t of argv) {
    if (t === "--yes") yes = true;
    else throw new CliExit(`unknown option ${t} (usage: opendweb hub stop [--yes])`, 2);
  }
  const state = await loadHubState(c.home);
  if (state === null) {
    throw new CliExit(`hub is not initialized; run "opendweb hub init" first`, 2);
  }
  const confirmed = await askConfirm(c, yes, "停止中枢？家里人将无法新连接；已互相直连的设备不受影响。");
  if (!confirmed) {
    c.stdout("已取消。");
    return 0;
  }
  let exitCode = 0;
  if (state.autostart === true) {
    try {
      await uninstallAutostartService(c);
      await saveHubState(c.home, { ...state, autostart: false });
    } catch (e) {
      c.stdout(`WARNING：卸载系统服务失败（${e instanceof CliExit ? e.message : asciiEscape(String(e))}）；继续停止进程。`);
      exitCode = 1;
    }
  }
  const result = await stopDaemonProcesses(c, state);
  if (result === "stopped") {
    c.stdout("已停止。");
  } else if (result === "not-running-clean") {
    c.stdout("中枢未在运行。");
  } else if (result === "unknown") {
    c.stdout("无法定位中枢进程（网关仍在应答但 pid 记录缺失）；请手动排查。");
    exitCode = 1;
  }
  return exitCode;
}

/**
 * 停残留进程编排：hub.pid（三重核验）→ hub.lock 持有者（命令行复核）→
 * 网关探测兜底。
 * @param {Required<HubCtx>} c
 * @param {Record<string, unknown>} state
 * @returns {Promise<"stopped" | "not-running-clean" | "unknown">}
 */
async function stopDaemonProcesses(c, state) {
  // 1) pid 三元组
  const verify = await verifyPidTriple(c.home, c).catch(() => null);
  if (verify !== null && verify.status !== "absent") {
    if (verify.status === "match") {
      const r = await signalDaemon(verify.pid, c);
      await fsp.rm(hubPidFile(c.home), { force: true });
      return r === "stopped" ? "stopped" : "not-running-clean";
    }
    // mismatch / not-running：绝不发信号；清理孤儿 pid 文件并报告
    await fsp.rm(hubPidFile(c.home), { force: true });
    return "not-running-clean";
  }
  // 2) hub.lock 持有者（服务 child/前台链；命令行复核防 pid 复用误杀）
  const dataDir = path.resolve(String(state.data_dir ?? ""));
  const lockInfoFile = path.join(hubLockDir(dataDir), "info.json");
  try {
    const info = JSON.parse(await fsp.readFile(lockInfoFile, "utf8"));
    const pid = typeof info.pid === "number" ? info.pid : null;
    if (pid !== null && c.isPidAlive(pid)) {
      const identity = await c.readProcessIdentity(pid);
      const looksLikeHub =
        identity !== null && identity.command.includes("hub") && identity.command.includes("start") && identity.command.includes(HUB_BIN_PATH);
      if (looksLikeHub) {
        await signalDaemon(pid, c);
        await fsp.rm(hubLockDir(dataDir), { recursive: true, force: true });
        return "stopped";
      }
    }
    await fsp.rm(hubLockDir(dataDir), { recursive: true, force: true });
  } catch { /* 无锁 */ }
  // 3) 网关探测兜底（pid/lock 均无但网关应答=无法定位）
  const base = probeBindBase(String(state.gateway_bind ?? "0.0.0.0:8787"));
  if (await probeGatewayHealthy(base, c.fetchImpl)) {
    return "unknown";
  }
  return "not-running-clean";
}

/**
 * hub status：状态一屏+排障提示（PM §4.3 样例）。
 * @param {string[]} argv
 * @param {Required<HubCtx>} c
 * @returns {Promise<number>}
 */
export async function hubStatus(argv, c) {
  if (argv.length > 0) throw new CliExit("hub status takes no arguments", 2);
  const state = await loadHubState(c.home);
  if (state === null) {
    c.stdout("中枢未初始化。变成中枢：opendweb hub init");
    return 0;
  }
  const machine = displayMachineName(c.hostname);
  const gatewayBind = String(state.gateway_bind ?? "0.0.0.0:8787");
  const base = probeBindBase(gatewayBind);
  const addrs = lanAddresses(c);
  const primary = addrs[0] ?? "127.0.0.1";

  const verify = await verifyPidTriple(c.home, c).catch(() => null);
  const lockAlive = await lockHolderAlive(c, state);
  const healthy = await probeGatewayHealthy(base, c.fetchImpl);
  const running = verify?.status === "match" || lockAlive || healthy;

  c.stdout(`中枢：${running ? "运行中" : "未运行"}`);
  c.stdout(`机器：${machine}`);
  c.stdout(`地址：${lanUrl(primary, portOf(gatewayBind))}${primary === "127.0.0.1" ? "" : "（局域网）"}`);
  for (const a of addrs.slice(1)) {
    c.stdout(`      ${lanUrl(a, portOf(gatewayBind))}`);
  }
  if (running) {
    const members = await describeMembers(c, base).catch(() => null);
    if (members !== null) c.stdout(members);
  } else if (state.autostart === true) {
    c.stdout("提示：开机自启已开启但中枢未在运行；运行 opendweb hub start 启动。");
  }
  c.stdout(`开机自启：${state.autostart === true ? "已开启" : "已关闭"}`);
  c.stdout("提示：路由器给这台机器的地址是动态分配的，建议在路由器里固定它，");
  c.stdout("      否则重启后地址可能变化（变了就重新出示接入卡片：opendweb hub card）。");
  return 0;
}

/**
 * hub.lock 持有者是否存活（status 运行判定之一）。
 * @param {Required<HubCtx>} c
 * @param {Record<string, unknown>} state
 * @returns {Promise<boolean>}
 */
async function lockHolderAlive(c, state) {
  try {
    const info = JSON.parse(await fsp.readFile(path.join(hubLockDir(String(state.data_dir ?? "")), "info.json"), "utf8"));
    return typeof info.pid === "number" && c.isPidAlive(info.pid);
  } catch {
    return false;
  }
}

/**
 * 成员行（运行中经 admin 面取数；失败=不显示，不让状态屏翻车）。
 * @param {Required<HubCtx>} c
 * @param {string} base
 * @returns {Promise<string>}
 */
async function describeMembers(c, base) {
  const token = await readHubToken(c.home);
  /** @param {string} p */
  const get = async (p) => {
    const res = await c.fetchImpl(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  };
  const owners = /** @type {unknown[]} */ (await get("/admin/owners"));
  const status = /** @type {{ visitors_online?: unknown, knocks_pending?: unknown }} */ (await get("/admin/status"));
  const tenants = Array.isArray(owners) ? owners.length : 0;
  const visitors = typeof status.visitors_online === "number" ? status.visitors_online : 0;
  const knocks = typeof status.knocks_pending === "number" ? status.knocks_pending : 0;
  return `成员：${tenants} 个租户 · ${visitors} 个访客在线 · ${knocks} 台设备在敲门`;
}

/**
 * hub card：重打接入卡片（家里人怎么连）。
 * @param {string[]} argv
 * @param {Required<HubCtx>} c
 * @returns {Promise<number>}
 */
export async function hubCard(argv, c) {
  if (argv.length > 0) throw new CliExit("hub card takes no arguments", 2);
  const state = await loadHubState(c.home);
  if (state === null) {
    throw new CliExit(`hub is not initialized; run "opendweb hub init" first`, 2);
  }
  printHubCard(c, { machine: displayMachineName(c.hostname), port: portOf(String(state.gateway_bind ?? "0.0.0.0:8787")) });
  return 0;
}

/**
 * hub open [深链]：本机中枢管理员入口——读 hub.json/hub-token，spawn webui
 * 薄壳（本 phase 用其现有 bin 形态；token 经 env DWEB_ADMIN_TOKEN 注入，
 * 绝不入 argv/URL），解析 sidecar 监听地址后开浏览器（可带深链）；进程驻留
 * 至信号退出。
 * @param {string[]} argv
 * @param {Required<HubCtx>} c
 * @returns {Promise<number>}
 */
export async function hubOpen(argv, c) {
  const deepLink = argv[0];
  if (argv.length > 1) throw new CliExit("usage: opendweb hub open [deep-link]", 2);
  const state = await loadHubState(c.home);
  if (state === null) {
    c.stdout("中枢未初始化。变成中枢：opendweb hub init");
    return 2;
  }
  const token = await readHubToken(c.home);
  const base = probeBindBase(String(state.gateway_bind ?? "0.0.0.0:8787"));
  if (!(await probeGatewayHealthy(base, c.fetchImpl))) {
    c.stdout("中枢没有在运行。家里人将无法新连接。");
    c.stdout("启动中枢：opendweb hub start");
    return 1;
  }
  const webuiCli =
    c.webuiCliPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../webui/src/cli.mjs");
  if (!fs.existsSync(webuiCli)) {
    throw new CliExit(
      `the webui console package was not found at ${asciiEscape(webuiCli)}; cannot open the admin console`,
      1,
    );
  }
  const child = c.spawnImpl(
    process.execPath,
    [webuiCli, "--server", base, "--no-open"],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, DWEB_ADMIN_TOKEN: token, DWEB_HOME: c.home },
    },
  );
  let settled = false;
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => {
      settled = true;
      resolve(code ?? 0);
    });
    child.once("error", () => {
      settled = true;
      resolve(1);
    });
  });
  const origin = await new Promise((resolve) => {
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    let acc = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      acc += chunk;
      const m = /opendweb-webui listening on (\S+)/.exec(acc);
      if (m !== null) {
        if (timer !== null) clearTimeout(timer);
        resolve(m[1]);
      } else if (!settled) {
        process.stdout.write(chunk);
      }
    });
    timer = setTimeout(() => resolve(null), 15000);
  });
  if (origin === null) {
    child.kill("SIGINT");
    await exited;
    throw new CliExit("the admin console sidecar did not report a listening address", 1);
  }
  const url = deepLink !== undefined ? `${origin}/${deepLink.replace(/^\/+/, "")}` : origin;
  c.stdout(`管理台：${url}`);
  c.openBrowser(url);
  // 驻留：信号或 sidecar 退出
  await new Promise((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve(null);
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    void exited.then(finish);
  });
  child.kill("SIGINT");
  await exited;
  return 0;
}

/**
 * hub autostart on|off [--print]：--print=生成物预览（不安装）；安装/卸载
 * 失败不更新 hub.json。
 * @param {string[]} argv
 * @param {Required<HubCtx>} c
 * @returns {Promise<number>}
 */
export async function hubAutostart(argv, c) {
  let sub = null;
  let print = false;
  for (const t of argv) {
    if (t === "on" || t === "off") sub = t;
    else if (t === "--print") print = true;
    else throw new CliExit(`unknown option ${t} (usage: opendweb hub autostart on|off [--print])`, 2);
  }
  if (sub === null) throw new CliExit("usage: opendweb hub autostart on|off [--print]", 2);
  const state = await loadHubState(c.home);
  if (state === null) {
    throw new CliExit(`hub is not initialized; run "opendweb hub init" first`, 2);
  }
  if (print) {
    const content =
      c.platform === "win32"
        ? buildWindowsStartupCmd({ execPath: process.execPath, binPath: HUB_BIN_PATH, home: c.home })
        : buildLaunchAgentPlist({ execPath: process.execPath, binPath: HUB_BIN_PATH, home: c.home });
    c.stdout(content.replace(/\n$/, ""));
    return 0;
  }
  if (sub === "on") {
    await installAutostartService(c);
    await saveHubState(c.home, { ...state, autostart: true });
    c.stdout("已开启。这台机器重启后，中枢自动回来。");
    return 0;
  }
  await uninstallAutostartService(c);
  await saveHubState(c.home, { ...state, autostart: false });
  c.stdout("已关闭。重启机器后中枢不再自动运行（运行中的中枢不受影响）。");
  return 0;
}

// ---- 派发 ------------------------------------------------------------------------

/**
 * hub 命令族入口（builtin 恒优先；平台冻结=非承诺平台明确错误零副作用）。
 * @param {string[]} rest
 * @param {Partial<HubCtx>} [ctx]
 * @returns {Promise<number>}
 */
export async function runHub(rest, ctx = {}) {
  const c = resolveHubCtx(ctx);
  const platformId = `${c.platform}-${process.arch}`;
  if (!HUB_PLATFORMS.includes(platformId)) {
    throw new CliExit(
      `opendweb hub is not supported on ${platformId} yet; v0.2 ships ${HUB_PLATFORMS.join(" / ")}`,
      1,
    );
  }
  const [sub, ...args] = rest;
  switch (sub) {
    case "init":
      return await hubInit(args, c);
    case "start":
      return await hubStart(args, c);
    case "stop":
      return await hubStop(args, c);
    case "status":
      return await hubStatus(args, c);
    case "card":
      return await hubCard(args, c);
    case "open":
      return await hubOpen(args, c);
    case "autostart":
      return await hubAutostart(args, c);
    default:
      throw new CliExit(
        `usage: opendweb hub <init|start|stop|status|card|open|autostart> (got ${sub ?? "nothing"})`,
        2,
      );
  }
}
