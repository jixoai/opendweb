#!/usr/bin/env node
// CLI 薄壳（webui-console design §2.2/§3 / spec「CLI 面接线」；home-hub 2a 起
// 壳层化——运行时在 src/core/，本文件只留壳职责）。
// 意图（2026-09-22，webui-console Phase A）：
// 1. URL/port 校验自担（契约不扩展 schema 能力）；
// 2. token 获取链 --token > DWEB_ADMIN_TOKEN > TTY 交互（回显关闭）；
//    argv/env 途径打印 OS 可见性提醒横幅；
// 3. 启动 sidecar：打印访问 URL（setup 态同时打印一次性配对码）；
//    --no-open 跳过浏览器（darwin `open`，其它平台仅打印 URL）；
// 4. SIGINT/SIGTERM 清理退出；token 值不进任何 log/错误字符串。
// 双入口：bin（opendweb-webui，本文件 shebang 直跑）与 plugin envelope
// （run({command,args,log,cwd,stdout,stderr}) → main(args, io)）。
// 壳层职责冻结（design §5.1）：信号/开浏览器（openImpl 形态）/退出留在本层——
// core 零浏览器 spawn、零进程语义。

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { homedir } from "node:os";
import readline from "node:readline";
import { validateTarget } from "./core/target.mjs";
import { startSidecar } from "./core/sidecar.mjs";
import { resolveLaunch } from "./core/home.mjs";

/** bin 直跑形态的参数声明（与 plugin.mjs 的 manifest args 同集） */
const ARG_SPEC = {
  server: "string",
  token: "string",
  port: "number",
  "allow-insecure": "boolean",
  "no-open": "boolean",
  setup: "boolean",
};

const TOKEN_VISIBILITY_NOTE = {
  argv:
    "note: token passed on the command line is visible to other local processes (shell history, ps); prefer the hidden terminal prompt or the browser pairing flow",
  env:
    "note: token passed via DWEB_ADMIN_TOKEN is readable from the process environment; prefer the hidden terminal prompt or the browser pairing flow",
};

const INSECURE_BANNER =
  "warning: plaintext http to a non-loopback target (--allow-insecure); the admin token and traffic are NOT encrypted in transit";

const USAGE = `opendweb-webui - local management console (sidecar + UI)

Usage:
  opendweb-webui [--server <string>] [--token <string>] [--port <number>] [--allow-insecure] [--no-open] [--setup]
      ${TOKEN_VISIBILITY_NOTE.argv}

Default (no --server) resolves the home-hub launch mode: a local hub.json
connects this machine's hub as admin (hub-token stays in-process); leases or
visits data opens the member console (leases/visits only); an empty device
starts the setup wizard. --setup forces the setup wizard on any device.`;

/** DWEB_HOME 解析（hub.mjs resolveHubCtx 同拍：env 优先，缺省 ~/.opendweb）。 */
function homeRoot(env) {
  return env.DWEB_HOME ?? path.join(homedir(), ".opendweb");
}

/**
 * bin 直跑参数解析（--key value / --key=value / boolean flag；语义与
 * packages/opendweb 的 parseCommandArgs 对齐——那边是官方实现，本包零依赖
 * 故本地镜像，契约测试双测）。
 * @param {string[]} argv
 * @returns {Record<string, string | number | boolean> & { help?: boolean }}
 */
export function parseWebuiArgv(argv) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new Error(`unexpected positional argument: ${token}`);
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    const type = ARG_SPEC[name];
    if (!type) throw new Error(`unknown option --${name}`);
    if (type === "boolean") {
      out[name] = eq === -1 ? true : token.slice(eq + 1) === "true";
      continue;
    }
    let raw = eq === -1 ? undefined : token.slice(eq + 1);
    if (raw === undefined) {
      raw = argv[++i];
      if (raw === undefined) throw new Error(`missing value for --${name}`);
    }
    out[name] = coerceArg(type, raw, name);
  }
  return out;
}

function coerceArg(type, raw, name) {
  if (type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${name} expects a number (got ${raw})`);
    return n;
  }
  return String(raw);
}

/**
 * CLI 主流程（plugin run envelope 与 bin 共用）。
 * @param {Record<string, unknown>} args
 * @param {{ log?: (line?: string) => void, cwd?: string, stdout?: { write(s: string): void }, stderr?: { write(s: string): void }, env?: Record<string, string | undefined>, stdin?: { isTTY?: boolean }, signal?: import("node:events").EventEmitter, dns?: object, openImpl?: (url: string) => void, platform?: NodeJS.Platform, nodesFile?: string, homeDir?: string }} [io]
 * @returns {Promise<{ exit: number }>}
 */
export async function main(args, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const log = io.log ?? ((line = "") => stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const dns = io.dns;

  if (args.help === true) {
    log(USAGE);
    return { exit: 0 };
  }

  // --port：自担校验（1..65535 整数；缺省 0 = 内核随机分配）
  let port = 0;
  if (args.port !== undefined) {
    const n = typeof args.port === "number" ? args.port : Number(args.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      stderr.write(`error: webui: invalid --port (expected integer 1-65535, got ${ascii(String(args.port))})\n`);
      return { exit: 2 };
    }
    port = n;
  }
  const allowInsecure = args["allow-insecure"] === true;

  // --server：目标守卫（坏 URL 即拒启；错误信息不含 token）
  let target = null;
  if (args.server !== undefined) {
    if (typeof args.server !== "string" || args.server === "") {
      stderr.write("error: webui: --server must be a non-empty http(s) URL\n");
      return { exit: 2 };
    }
    const v = await validateTarget(args.server, { allowInsecure, dns });
    if (!v.ok) {
      stderr.write(`error: webui: invalid --server: ${v.error}\n`);
      return { exit: 1 };
    }
    target = v.value;
  }

  // token 获取链：--token > DWEB_ADMIN_TOKEN > TTY 交互（仅 ready 启动需要；
  // setup 模式的 token 经浏览器配对面提交，不进本进程 argv/env）
  let token = "";
  /** @type {"argv" | "env" | "tty" | null} */
  let tokenSource = null;
  if (target !== null) {
    if (typeof args.token === "string" && args.token !== "") {
      token = args.token;
      tokenSource = "argv";
    } else if (typeof env.DWEB_ADMIN_TOKEN === "string" && env.DWEB_ADMIN_TOKEN !== "") {
      token = env.DWEB_ADMIN_TOKEN;
      tokenSource = "env";
    } else if (stdin.isTTY === true) {
      token = await promptHidden("admin token: ", { stdin, stdout });
      tokenSource = "tty";
      if (token === "") {
        stderr.write("error: webui: empty admin token\n");
        return { exit: 2 };
      }
    } else {
      stderr.write(
        "error: webui: no admin token available; pass --token <token> or set DWEB_ADMIN_TOKEN (or run in a terminal to type it hidden)\n",
      );
      return { exit: 2 };
    }
  }

  /** @type {import("./core/sidecar.mjs").Awaited<ReturnType<typeof startSidecar>>} */
  let sidecar;
  // 节点簿存储（server-access-roles 版本化例外）：<DWEB_HOME>/nodes.json（缺省
  // ~/.opendweb/），0600 私有文件——仅节点 token 落盘；帮助文本/横幅披露 OS 可见性。
  const nodesFile =
    io.nodesFile ?? env.DWEB_WEBUI_NODES_FILE ?? path.join(env.DWEB_HOME ?? homedir(), ".opendweb", "nodes.json");

  // home-hub 2b 无参分流（design §4.2 五行表；row 1 显式 --server 已在上方处理，
  // 行为不变）：--setup 强制 setup（row 5，member 态设备重新配对的显式通道）；
  // hub.json 存在→hub 本机自动 admin（row 2——hub-token 进程内读取注入内存，
  // 绝不入 argv/URL/浏览器状态；服务未跑=中枢视角+中枢状态卡）；无 hub.json +
  // 有 leases/visits→member（row 3——不生成配对码、admin 面封闭）；零数据→
  // setup 基线（row 4）。数据面（/sidecar/leases|visits|hub）跟随本机 DWEB_HOME。
  /** @type {boolean} */
  let member = false;
  /** @type {boolean} */
  let hubLocal = false;
  /** @type {string | null} */
  let homeDir = null;
  if (target === null) {
    const home = io.homeDir ?? homeRoot(env);
    const decision = await resolveLaunch({ home, setup: args.setup === true });
    if (decision.kind === "hub-local") {
      hubLocal = true;
      if (decision.hubToken !== null) {
        const v = await validateTarget(decision.hubBase, { allowInsecure: false, dns });
        if (v.ok) {
          target = v.value;
          token = decision.hubToken;
          tokenSource = null; // 进程内读取（0600 hub-token 文件）——非 argv/env/tty 面
        }
        // 目标守卫失败（异常 bind 形态）：保持 hub-local admin 姿态、无 target——
        // UI 落中枢视角+中枢状态卡；不降级 member/setup
      }
    } else if (decision.kind === "member") {
      member = true;
    }
    homeDir = home;
  }

  try {
    sidecar = await startSidecar({
      target,
      token,
      port,
      log,
      allowInsecure,
      dns,
      nodesFile: member ? null : nodesFile,
      member,
      hubLocal,
      homeDir,
    });
  } catch (e) {
    stderr.write(`error: webui: cannot start sidecar (${ascii(String(e?.message ?? e))})\n`);
    return { exit: 1 };
  }
  log(`opendweb-webui listening on ${sidecar.origin}`);
  if (member) {
    log(`member console: this device has leases or visits; the admin console is closed (re-pair with --setup)`);
  } else if (target === null) {
    log(`pairing code: ${sidecar.pairingCode}`);
    log(`open ${sidecar.origin} in a browser and use the pairing code to connect a server`);
  } else {
    log(`proxying to ${target.scheme}://${target.hostHeader}${hubLocal ? " (local hub)" : ""}`);
    if (target.insecure) log(INSECURE_BANNER);
    if (tokenSource === "argv" || tokenSource === "env") log(TOKEN_VISIBILITY_NOTE[tokenSource]);
  }

  if (args["no-open"] !== true) {
    openBrowser(sidecar.origin, { log, platform: io.platform, openImpl: io.openImpl });
  }

  // 信号面：SIGINT/SIGTERM → 清理 sidecar（销毁在途上游连接）后退出
  const signal = io.signal ?? process;
  const received = await new Promise((resolve) => {
    const onSignal = (sig) => {
      signal.off?.("SIGINT", onSignal);
      signal.off?.("SIGTERM", onSignal);
      resolve(sig);
    };
    signal.once("SIGINT", onSignal);
    signal.once("SIGTERM", onSignal);
  });
  log(`received ${received}, shutting down`);
  await sidecar.close();
  return { exit: 0 };
}

/** darwin `open`；其它平台仅提示（失败/无 opener 一律降级为打印，不报错） */
function openBrowser(url, { log, platform, openImpl }) {
  const plat = platform ?? process.platform;
  if (openImpl) {
    openImpl(url);
    return;
  }
  if (plat === "darwin") {
    try {
      const child = spawn("open", [url], { stdio: "ignore", detached: true });
      child.on("error", () => log(`could not open a browser; visit ${url} manually`));
      child.unref();
    } catch {
      log(`could not open a browser; visit ${url} manually`);
    }
  } else {
    log(`open ${url} in a browser (auto-open is wired on macOS only for now)`);
  }
}

/**
 * 隐藏回显的终端提问（token 不落终端 scrollback）。仅 TTY 调用——
 * terminal:true 使 readline 逐键回显，覆写 _writeToOutput 吞掉输入字符。
 * @param {string} query
 * @param {{ stdin: NodeJS.ReadableStream & { isTTY?: boolean }, stdout: { write(s: string): void } }} io
 * @returns {Promise<string>}
 */
function promptHidden(query, { stdin, stdout }) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    rl._writeToOutput = (s) => {
      // 只回显提示串与换行；键入的 token 字符一律不回显
      if (s.includes(query)) stdout.write(query);
      else if (/[\r\n]/.test(s)) stdout.write(s.replace(/[^\r\n]/g, ""));
    };
    rl.question(query, (answer) => {
      rl.close();
      stdout.write("\n");
      resolve(answer ?? "");
    });
  });
}

/** ASCII 纪律（动态值入 stderr 的统一出口） */
function ascii(v) {
  const s = String(v);
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

// bin 直跑入口：`opendweb-webui ...` / `npx opendweb-webui ...`
const isDirect =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  let args;
  try {
    args = parseWebuiArgv(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: webui: ${ascii(String(e?.message ?? e))}\n\n${USAGE}\n`);
    process.exit(2);
  }
  main(args).then(
    (r) => {
      process.exitCode = r.exit;
    },
    (e) => {
      process.stderr.write(`error: webui: ${ascii(String(e?.message ?? e))}\n`);
      process.exitCode = 1;
    },
  );
}
