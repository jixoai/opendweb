// 心跳面（home-hub Phase 3a，2026-09-23）：<DWEB_HOME>/tray-status.json。
// 意图：
// 1. schema v1 快照（spec 冻结形状）：{v:1, state:"error"|"knock"|"running"|
//    "unconfigured", knocks_pending:number, ts:number(epoch ms)}——优先级
//    异常>敲门 n>运行>未配置（PRODUCT-DESIGN §3.6 冻结表）；
// 2. 数据源聚合：hub.json 存在性 + hub.pid 进程存活（活=running；配置存在
//    但进程不在=error——v1 无 stopped 态，README 冻结裁决）+ admin 轮询
//    knocks_pending（3s，Bearer hub-token 只进请求头）+ 外部注入（console
//    knock-pending 事件）；
// 3. ≤1s 级 mtime 刷新：每 tick 无条件原子写（tmp O_EXCL + chmod 0600 +
//    fsync + rename；拒绝穿透符号链接）——壳侧以 mtime 龄期判失联，ts 与
//    mtime 同拍前进；stop() 后文件保留、mtime 冻结；
// 4. 状态变化通知：{state, knocks_pending} 变化时回调（stdout 事件流消费）。
// token 纪律：本模块不把 hub-token 写入快照/通知/任何日志。

import fsp from "node:fs/promises";
import path from "node:path";

import { readHubSide, adminBase, pollKnocks, defaultIsPidAlive } from "./hub-side.mjs";

/** 心跳文件名（spec 冻结：<DWEB_HOME>/tray-status.json） */
export const TRAY_STATUS_FILE = "tray-status.json";
/** 快照 schema 版本位 */
export const TRAY_SCHEMA_VERSION = 1;
/** 四态全集（优先序即数组序） */
export const TRAY_STATES = ["error", "knock", "running", "unconfigured"];

/** 默认节奏：心跳 1s（spec「≤1s 级 mtime 刷新」）、admin 轮询 3s（spec冻结） */
export const HEARTBEAT_INTERVAL_MS = 1000;
export const ADMIN_POLL_INTERVAL_MS = 3000;

/**
 * 纯函数：四态优先级聚合（测试直打面）。
 * @param {{ configured: boolean, parseError?: string | null, pidAlive?: boolean, knocks?: number, now: () => number }} input
 * @returns {{ v: 1, state: (typeof TRAY_STATES)[number], knocks_pending: number, ts: number }}
 */
export function computeSnapshot({ configured, parseError = null, pidAlive = false, knocks = 0, now }) {
  const ts = now();
  if (!configured) return { v: TRAY_SCHEMA_VERSION, state: "unconfigured", knocks_pending: 0, ts };
  // 配置存在：损坏或进程不在 → error（knock 数据随进程失效归零）
  if (parseError !== null || !pidAlive) {
    return { v: TRAY_SCHEMA_VERSION, state: "error", knocks_pending: 0, ts };
  }
  const n = Number.isFinite(knocks) && knocks > 0 ? Math.trunc(knocks) : 0;
  return { v: TRAY_SCHEMA_VERSION, state: n > 0 ? "knock" : "running", knocks_pending: n, ts };
}

/**
 * 0600 原子写（与 hub.mjs 的 SecretStore 纪律同款：唯一 tmp O_EXCL + chmod +
 * fsync + rename；目标为符号链接=拒绝；失败清理 tmp 再抛）。
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
 * 心跳循环（可注入节奏/时钟/fetch/pid 探测——测试面）。
 * @param {{ home: string, intervalMs?: number, pollIntervalMs?: number, now?: () => number, fetchImpl?: typeof fetch, isPidAlive?: (pid: number) => boolean, onChange?: (snap: { v: 1, state: string, knocks_pending: number, ts: number }) => void, onError?: (err: Error) => void }} opts
 * @returns {Promise<{ stop: () => void, snapshot: () => { v: 1, state: string, knocks_pending: number, ts: number } | null, noteKnocks: (n: number) => void, statusFile: string }>}
 */
export async function createHeartbeat(opts = {}) {
  const home = opts.home;
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? ADMIN_POLL_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const statusFile = path.join(home, TRAY_STATUS_FILE);

  /** 聚合的敲门数（admin 轮询与 console 事件后到者覆盖；进程不在时归零） */
  let knocks = 0;
  /** 上次写盘快照（变化通知的比较基准） */
  let last = null;
  let stopped = false;
  /** 写盘/读盘异常只上报不中断（心跳是尽力而为面；壳侧以 mtime 判生死） */
  const onError = opts.onError ?? (() => {});

  /**
   * 单次聚合 + 写盘。
   * @param {{ hubState: Record<string, unknown> | null, parseError: string | null, pidTriple: { pid: number } | null }} side
   */
  const tick = async (side) => {
    const configured = side.hubState !== null || side.parseError !== null;
    const pidAlive = side.pidTriple !== null && isPidAlive(side.pidTriple.pid);
    if (!pidAlive) knocks = 0;
    const snap = computeSnapshot({ configured, parseError: side.parseError, pidAlive, knocks, now });
    await atomicWrite0600(statusFile, `${JSON.stringify(snap)}\n`);
    if (last === null || last.state !== snap.state || last.knocks_pending !== snap.knocks_pending) {
      opts.onChange?.(snap);
    }
    last = snap;
  };

  /** admin 轮询（配置+运行+token 三者齐备才出网；失败保持上次值） */
  const poll = async (side) => {
    if (side.hubState === null || side.pidTriple === null || side.token === null) return;
    if (!isPidAlive(side.pidTriple.pid)) return;
    const n = await pollKnocks(adminBase(side.hubState.gateway_bind), side.token, { fetchImpl });
    if (n !== null) knocks = n;
  };

  await fsp.mkdir(home, { recursive: true });
  // 起搏前先写一拍（进程一启动心跳即存在）
  try {
    await tick(await readHubSide(home));
  } catch (e) {
    onError(/** @type {Error} */ (e));
  }
  const heartbeatTimer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      try {
        const side = await readHubSide(home);
        await tick(side);
      } catch (e) {
        onError(/** @type {Error} */ (e));
      }
    })();
  }, intervalMs);
  const pollTimer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      try {
        await poll(await readHubSide(home));
      } catch (e) {
        onError(/** @type {Error} */ (e));
      }
    })();
  }, pollIntervalMs);
  // 常驻面：两个 interval 维持事件循环（不 unref——退出由控制器 stop() 清理）

  return {
    statusFile,
    /** 停止刷新（mtime 冻结；文件保留——壳侧失联判定依据） */
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(pollTimer);
    },
    /** 最近一次写盘快照（尚未写盘时 null） */
    snapshot: () => (last === null ? null : { ...last }),
    /** 外部敲门数注入（console knock-pending 事件；后到者覆盖） */
    noteKnocks: (n) => {
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) knocks = Math.trunc(n);
    },
  };
}
