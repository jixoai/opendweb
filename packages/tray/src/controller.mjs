// 无头控制器（home-hub Phase 3a，2026-09-23）：opendweb tray 的进程本体。
// 意图：
// 1. 进程内消费 webui SDK（[H4]）：启动即 createConsole（opener=注入——v1
//    无头裁决：不自行 spawn 浏览器，open 记录为 opened 通知/事件，壳侧可
//    覆写——壳消费 URL 自行开窗）；hub 配置存在时注入回环 target+hub-token
//    （token 绝不入 argv/URL/输出面），未配置时 setup 形态（配对面）；
// 2. 心跳接线：createHeartbeat（tray-status.json ≤1s 刷新）+ console
//    knock-pending 事件注入（后到者覆盖）；
// 3. 双模式互斥：默认=stdout JSON-lines 事件流（webui schema v1 帧转发 +
//    tray-status 状态变化通知 + opened 事件；无请求语义，stdin 不消费——
//    不做 EOF 退出，防 stdio:ignore 形态秒退）；--ipc=JSON-RPC 2.0
//    （ipc.mjs；opened 以 server 通知帧透出）；
// 4. 方法集：open-console(deepLink?)/start/stop/set-autostart——hub 动作经
//    子进程 `node <opendweb bin> hub …`（绝对路径解析，DWEB_HOME 注入）；
//    未 init hub=业务 error -32000 "hub not initialized"（golden 冻结）；
// 5. 生命周期：SIGINT/SIGTERM/stdin EOF(ipc)/stdout EPIPE → stop()（幂等）：
//    停心跳（mtime 冻结）→ 关 console（capability 即失效）。
// stderr 只归日志；stdout 恒为当前模式的帧通道（事件与 RPC 不混流）。

import os from "node:os";
import path from "node:path";

import { createConsole, validateTarget, EVENT_TYPES } from "opendweb-webui";

import { createHeartbeat } from "./heartbeat.mjs";
import { createIpcSession, RpcError, RPC_CODES, RPC_MESSAGES } from "./ipc.mjs";
import { readHubSide, adminBase, runHubCommand, mapHubCommandError, resolveOpendwebBin } from "./hub-side.mjs";

/**
 * @param {string} s
 * @returns {string} 非 ASCII 归一为 \xNN（错误消息纪律）
 */
function ascii(s) {
  let out = "";
  for (const b of Buffer.from(String(s), "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * @param {unknown} payload
 * @returns {number | null} console knock-pending 载荷归一（2b/2c 发射源落地
 * 前宽容接受 number / {knocks_pending} / {count}）
 */
function normalizeKnockPayload(payload) {
  if (typeof payload === "number" && Number.isFinite(payload) && payload >= 0) return payload;
  if (payload !== null && typeof payload === "object") {
    const p = /** @type {Record<string, unknown>} */ (payload);
    for (const key of ["knocks_pending", "count"]) {
      const v = p[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    }
  }
  return null;
}

/**
 * argv 解析（bin 直跑形态；plugin envelope 已由 manifest args 解析承担）。
 * @param {string[]} argv
 * @returns {{ ipc: boolean }}
 */
export function parseTrayArgv(argv) {
  let ipc = false;
  for (const t of argv) {
    if (t === "--ipc") ipc = true;
    else if (t === "--ipc=true") ipc = true;
    else if (t === "--ipc=false") ipc = false;
    else throw new Error(`unknown option ${t} (usage: opendweb tray [--ipc])`);
  }
  return { ipc };
}

/**
 * 无头控制器组装（测试可注入全 IO 面）。
 * @param {{ ipc?: boolean, home?: string, stdin?: NodeJS.ReadableStream, stdout?: { write(s: string): unknown, on?: (ev: string, fn: (err?: Error) => void) => unknown }, stderr?: { write(s: string): unknown }, env?: Record<string, string | undefined>, signal?: import("node:events").EventEmitter, now?: () => number, fetchImpl?: typeof fetch, isPidAlive?: (pid: number) => boolean, spawnImpl?: import("node:child_process").spawn, execPath?: string, opendwebBinPath?: string | null, heartbeatIntervalMs?: number, pollIntervalMs?: number }} [opts]
 * @returns {Promise<TrayController>}
 */
export async function createTrayController(opts = {}) {
  const ipc = opts.ipc === true;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;
  const signal = opts.signal ?? process;
  const now = opts.now ?? (() => Date.now());
  const home = opts.home ?? env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb");
  const log = (line = "") => stderr.write(`[tray] ${line}\n`);

  // ---- 帧通道（模式互斥：事件流 vs RPC；opened 双形态） ---------------------------
  const writeLine = (line) => stdout.write(`${line}\n`);
  /** 事件流帧（默认模式专用形：{v:1,type,payload,ts}） */
  const writeEvent = (frame) => {
    if (!ipc) writeLine(JSON.stringify(frame));
  };
  /** opened 透出：ipc=server 通知帧（macrotask 延迟——结果帧先于通知写出，
   * 请求-响应序不被打开动作插队）；默认模式=schema v1 事件帧（v1 无头裁决） */
  const emitOpened = (url) => {
    if (ipc) {
      setImmediate(() => writeLine(JSON.stringify({ jsonrpc: "2.0", method: "opened", params: { url } })));
    } else {
      writeEvent({ v: 1, type: "opened", payload: { url }, ts: now() });
    }
  };
  const opener = (url) => {
    log(`console open requested (${ascii(new URL(url).origin)})`);
    emitOpened(url);
  };

  // ---- console 组装（hub 侧一次读取；此后心跳每 tick 自读） ----------------------
  const side = await readHubSide(home);
  const consoleOpts = {
    opener,
    log: (line = "") => stderr.write(`${line}\n`),
    now,
  };
  /** @type {Awaited<ReturnType<typeof createConsole>>} */
  let consoleHandle;
  if (side.hubState !== null && side.parseError === null) {
    const v = await validateTarget(adminBase(side.hubState.gateway_bind), { allowInsecure: false });
    consoleHandle = await createConsole(
      v.ok
        ? { ...consoleOpts, target: v.value, ...(side.token !== null ? { token: side.token } : {}) }
        : consoleOpts,
    );
  } else {
    consoleHandle = await createConsole(consoleOpts);
  }

  // ---- 心跳 -----------------------------------------------------------------------
  const heartbeat = await createHeartbeat({
    home,
    intervalMs: opts.heartbeatIntervalMs,
    pollIntervalMs: opts.pollIntervalMs,
    now,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.isPidAlive !== undefined ? { isPidAlive: opts.isPidAlive } : {}),
    onChange: (snap) => {
      writeEvent({ v: 1, type: "tray-status", payload: { state: snap.state, knocks_pending: snap.knocks_pending }, ts: snap.ts });
    },
    onError: (e) => log(`heartbeat write failed: ${ascii(e.message)}`),
  });

  // ---- console 事件接线 ------------------------------------------------------------
  const disposers = [];
  disposers.push(
    consoleHandle.onEvent("knock-pending", (frame) => {
      const n = normalizeKnockPayload(frame.payload);
      if (n !== null) heartbeat.noteKnocks(n);
    }),
  );
  if (!ipc) {
    for (const type of EVENT_TYPES) {
      disposers.push(consoleHandle.onEvent(type, (frame) => writeEvent(frame)));
    }
  }

  // ---- hub 动作（子进程真实形态；bin 绝对路径注入优先） ---------------------------
  const opendwebBin = opts.opendwebBinPath !== undefined ? opts.opendwebBinPath : resolveOpendwebBin();
  /** @param {string[]} hubArgs */
  const hubAction = async (hubArgs) => {
    if (typeof opendwebBin !== "string" || opendwebBin === "") {
      throw new RpcError(RPC_CODES.hubAction, "hub command failed (opendweb CLI not found)");
    }
    const res = await runHubCommand({
      binPath: opendwebBin,
      args: hubArgs,
      home,
      ...(opts.execPath !== undefined ? { execPath: opts.execPath } : {}),
      ...(opts.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
      env,
    });
    if (res.code === 0) return { ok: true };
    const mapped = mapHubCommandError(res);
    throw new RpcError(mapped.code, mapped.message);
  };

  /**
   * IPC 方法集派发（createIpcSession 的 dispatch；亦为控制面直测入口）。
   * @param {string} method
   * @param {unknown} params
   * @returns {Promise<{ ok: true }>}
   */
  const dispatch = async (method, params) => {
    if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
      throw new RpcError(RPC_CODES.invalidParams, `${RPC_MESSAGES.invalidParams}: params must be an object`);
    }
    const p = /** @type {Record<string, unknown>} */ (params ?? {});
    switch (method) {
      case "open-console": {
        const deepLink = p.deepLink;
        if (deepLink !== undefined && typeof deepLink !== "string") {
          throw new RpcError(RPC_CODES.invalidParams, `${RPC_MESSAGES.invalidParams}: deepLink must be a string like '#/lease'`);
        }
        try {
          consoleHandle.open(deepLink);
        } catch (e) {
          throw new RpcError(RPC_CODES.invalidParams, `${RPC_MESSAGES.invalidParams}: ${ascii(/** @type {Error} */ (e).message)}`);
        }
        return { ok: true };
      }
      case "start":
        return await hubAction(["start"]);
      case "stop":
        return await hubAction(["stop", "--yes"]);
      case "set-autostart": {
        if (typeof p.on !== "boolean") {
          throw new RpcError(RPC_CODES.invalidParams, `${RPC_MESSAGES.invalidParams}: on (boolean) is required`);
        }
        return await hubAction(["autostart", p.on ? "on" : "off"]);
      }
      default:
        throw new RpcError(RPC_CODES.methodNotFound, RPC_MESSAGES.methodNotFound);
    }
  };

  // ---- 生命周期 --------------------------------------------------------------------
  let stopped = false;
  let resolveShutdown = () => {};
  const shutdownPromise = new Promise((resolve) => {
    resolveShutdown = resolve;
  });
  /** 幂等停机：停心跳（mtime 冻结）→ 关 console（capability 失效） */
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    heartbeat.stop();
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch { /* close 后再 dispose 的幂等面 */ }
    }
    try {
      await consoleHandle.close();
    } catch (e) {
      log(`console close failed: ${ascii(/** @type {Error} */ (e).message)}`);
    }
    resolveShutdown();
  };
  const onSignal = () => {
    log("shutting down");
    void stop();
  };
  signal.once?.("SIGINT", onSignal);
  signal.once?.("SIGTERM", onSignal);
  // stdout 断管（壳先死）→ 退出防孤儿
  if (typeof stdout.on === "function") {
    stdout.on("error", () => void stop());
  }
  // 默认模式 stdin 不消费（见文件头注 3）；ipc 模式由 runTray 接 EOF
  void stdin;

  return {
    mode: ipc ? "ipc" : "stream",
    home,
    console: consoleHandle,
    heartbeat,
    dispatch,
    shutdownPromise,
    /** 显式唤起控制台（默认模式的 opened 事件测试面；语义同 open-console） */
    openConsole: (deepLink) => consoleHandle.open(deepLink),
    stop,
  };
}

/**
 * @typedef {Object} TrayController
 * @property {"ipc" | "stream"} mode
 * @property {string} home
 * @property {Awaited<ReturnType<typeof createConsole>>} console
 * @property {Awaited<ReturnType<typeof createHeartbeat>>} heartbeat
 * @property {(method: string, params: unknown) => Promise<{ ok: true }>} dispatch
 * @property {Promise<void>} shutdownPromise
 * @property {(deepLink?: string) => void} openConsole
 * @property {() => Promise<void>} stop
 */

/**
 * 顶层运行（bin/plugin 共用）：组装控制器 → 按模式驻留至停机。
 * @param {{ ipc?: boolean }} opts
 * @param {Parameters<typeof createTrayController>[0]} [io]
 * @returns {Promise<{ exit: number }>}
 */
export async function runTray(opts, io = {}) {
  const controller = await createTrayController({ ...io, ipc: opts.ipc === true });
  if (controller.mode === "ipc") {
    const session = createIpcSession({
      input: io.stdin ?? process.stdin,
      output: io.stdout ?? process.stdout,
      dispatch: controller.dispatch,
    });
    await Promise.race([session.finished, controller.shutdownPromise]);
  } else {
    await controller.shutdownPromise;
  }
  await controller.stop();
  return { exit: 0 };
}
