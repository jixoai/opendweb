// 测试共用工具（home-hub Phase 3a）：假 hub home（hub.json/pid/token 伪造面）、
// 本地 /admin/status mock（断言 Bearer 形态）、死 pid 供给、子进程跑器与
// 行读取队列。mock 纪律：不依赖真实 hub/守护——全部临时 DWEB_HOME 隔离。
import http from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(HERE, "..");
export const TRAY_BIN = path.join(PKG_ROOT, "src", "bin.mjs");
export const OPENDWEB_BIN = path.resolve(PKG_ROOT, "..", "opendweb", "bin", "opendweb.mjs");
export const NODE = process.execPath;

/**
 * 本地 /admin/status mock：Bearer 校验 + knocks_pending 可变。
 * @param {{ token: string, knocks?: number }} opts
 */
export async function fakeAdmin(opts) {
  const state = { knocks: opts.knocks ?? 0 };
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      if (req.method === "GET" && req.url === "/admin/status") {
        if (req.headers.authorization !== `Bearer ${opts.token}`) {
          res.writeHead(401);
          res.end("unauthorized");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ knocks_pending: state.knocks, visitors_online: 0 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    hits,
    setKnocks: (n) => {
      state.knocks = n;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * 伪造 hub home（临时 DWEB_HOME）。
 * @param {{ configured?: boolean, autostart?: boolean, gatewayPort?: number, pid?: number | null, token?: string | null, malformedState?: boolean }} [opts]
 * @returns {Promise<{ home: string, token: string }>}
 */
export async function makeHubHome(opts = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "tray-home-"));
  const token = opts.token ?? `tok_${randomBytes(12).toString("hex")}`;
  if (opts.configured !== false) {
    if (opts.malformedState === true) {
      await fsp.writeFile(path.join(home, "hub.json"), "{ not json", "utf8");
    } else {
      const state = {
        version: 1,
        data_dir: path.join(home, "hub-data"),
        gateway_bind: `127.0.0.1:${opts.gatewayPort ?? 8787}`,
        relay_bind: "127.0.0.1:3340",
        initialized_at: new Date(0).toISOString(),
        autostart: opts.autostart === true,
      };
      await fsp.writeFile(path.join(home, "hub.json"), `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
    }
  }
  if (opts.pid !== null && opts.pid !== undefined) {
    await fsp.writeFile(
      path.join(home, "hub.pid"),
      `${JSON.stringify({ pid: opts.pid, start_identity: "", argv_digest: "" }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  if (opts.token !== null && opts.configured !== false && opts.malformedState !== true) {
    await fsp.writeFile(path.join(home, "hub-token"), `${token}\n`, { mode: 0o600 });
  }
  return { home, token };
}

/** 供给一个确定已死的 pid（spawn 后 SIGKILL；复用窗口内唯一） */
export async function deadPid() {
  const child = spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve) => {
    if (child.pid === undefined) return resolve(undefined);
    child.once("spawn", resolve);
  });
  const pid = child.pid;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

/** 子进程跑器（bin 直跑；DWEB_HOME 隔离） */
export function spawnTray(args, { home, extraEnv = {} } = {}) {
  return spawn(NODE, [TRAY_BIN, ...args], {
    env: { PATH: process.env.PATH, DWEB_HOME: home, NO_COLOR: "1", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** 通用子进程跑器（opendweb bin 冒烟用；extraEnv 供 DWEB_NO_AUTO_INSTALL 等） */
export function spawnNode(script, args, { home, cwd, extraEnv = {} } = {}) {
  return spawn(NODE, [script, ...args], {
    ...(cwd !== undefined ? { cwd } : {}),
    env: { PATH: process.env.PATH, DWEB_HOME: home, NO_COLOR: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 收集子进程输出直至退出 */
export function collect(child) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: null, out, err: String(e) }));
    child.on("exit", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

/** 行读取队列（JSON-lines 帧断言面；超时拒绝防挂死） */
export function lineReader(stream, timeoutMs = 8000) {
  const lines = [];
  const waiters = [];
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  return {
    next: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`line reader timeout (pending ${lines.length})`)), timeoutMs);
        const l = lines.shift();
        if (l !== undefined) {
          clearTimeout(timer);
          resolve(l);
        } else {
          waiters.push((line) => {
            clearTimeout(timer);
            resolve(line);
          });
        }
      }),
    pending: () => lines.length,
  };
}

/** 内存输出流（进程内控制器的 stdout/stderr 注入面） */
export function memWriter() {
  const chunks = [];
  const w = {
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
    text: () => chunks.join(""),
    lines: () => chunks.join("").split("\n").filter((l) => l !== ""),
  };
  return w;
}

/** runHubCommand 的假子进程（spawnImpl 注入面） */
export function fakeSpawnResult({ code = 0, out = "", err = "" } = {}) {
  const calls = [];
  /** @type {import("node:child_process").spawn} */
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdin = null;
    child.stdout = Readable.from([out]);
    child.stderr = Readable.from([err]);
    child.kill = () => {};
    setTimeout(() => child.emit("exit", code), 0);
    return child;
  };
  return { spawnImpl, calls };
}

/** 轮询直至谓词为真（超时抛错带上下文） */
export async function until(fn, { timeoutMs = 5000, stepMs = 25, what = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** 读心跳快照 */
export async function readStatus(home) {
  const text = await fsp.readFile(path.join(home, "tray-status.json"), "utf8");
  return JSON.parse(text);
}
