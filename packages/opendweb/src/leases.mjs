// 租约簿/到访簿/admission 锁/journal（home-hub Phase 1d，[H7]-G1/G-2）。
// 意图（2026-09-24）：
//   1. leases.json 多租约簿：键=(server, fabric_id, root)，0..N 条（N 是
//      server 维度，fabric 维度恒 1——单 fabric 约束由 join 的 admission
//      锁+journal 保证，本模块只管账本读写的原子性与锁协议）。
//   2. visits.json 到访簿：键=server；写者=探测动作/访客连接类命令——
//      join 成功（租户路径）绝不写 visits。
//   3. 跨进程文件锁 `<name>.lock`（O_EXCL+pid+ts；锁内重读→合并→tmp+fsync+
//      rename→锁归属校验（内容比对）→释放；陈锁>10s 且 pid 死可打破；
//      获取失败短退避≤3 后报错）。admission 锁=fabric.lock 同协议。
//   4. 迁移：旧 registration.json（leases.json 缺失时）在 leases 写锁内
//      并入首条（relay_url 探测补全，不可达留空待补）；旧文件改名
//      registration.json.migrated；损坏=警告保留不阻塞。
//   5. pending admission journal（fabric-admission.json，0600 原子写）与
//      roster.facts 头部 fabric_id 读取（纯 JS，CLI 不引入 NAPI）。
// 写纪律：SecretStore 原子写（0600+O_EXCL tmp+fsync+rename）；失败无半提交。

import net from "node:net";
import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";

// ---- 文件名常量 ---------------------------------------------------------------

/** 多租约簿文件名（<DWEB_HOME>/leases.json） */
export const LEASES_FILE = "leases.json";
/** 到访簿文件名（<DWEB_HOME>/visits.json） */
export const VISITS_FILE = "visits.json";
/** admission 锁文件名（<DWEB_HOME>/fabric.lock） */
export const FABRIC_LOCK_FILE = "fabric.lock";
/** pending admission journal 文件名（<DWEB_HOME>/fabric-admission.json） */
export const ADMISSION_JOURNAL_FILE = "fabric-admission.json";
/** 旧单条注册文件名（迁移源；改名后缀 .migrated） */
export const LEGACY_REGISTRATION_FILE = "registration.json";
/** SDK roster 持久化文件名（dweb-fabric roster.rs ROSTER_FILE_NAME 同拍） */
export const ROSTER_FILE = "roster.facts";
/** roster.facts 魔数（DWEBRST1 + 32B fabric_id 头部布局） */
const ROSTER_MAGIC = Buffer.from("DWEBRST1", "ascii");

/** 陈锁判定：>10s 且 pid 死可打破（与 hub.lock 规则同拍） */
export const STALE_LOCK_MS = 10_000;
/** 探测超时（5s 冻结） */
export const PROBE_TIMEOUT_MS = 5_000;
/** 锁获取失败短退避 ≤3 后报错 */
const LOCK_RETRIES = 3;
/** 退避间隔（ms；25/50/100） */
const LOCK_BACKOFF_MS = [25, 50, 100];

/** hex64 白名单 */
const HEX64_RE = /^[0-9a-f]{64}$/;
/** 不透明 id 字符集（crockford 小写） */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** @param {number} pid @returns {boolean} */
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * 随机 10 字符不透明 id（CSPRNG；crockford 字符集）。
 * @param {() => Uint8Array} [random] 可注入（32B CSPRNG 替身）
 * @returns {string}
 */
export function randomLeaseId(random = () => globalThis.crypto.getRandomValues(new Uint8Array(10))) {
  return Array.from(random(), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

// ---- 原子写（SecretStore 纪律） ------------------------------------------------

/**
 * 0600 原子写（O_EXCL tmp + chmod 0600 + fsync + rename；符号链接拒绝；
 * 失败清理 tmp）。与 hub.mjs atomicWrite0600 同纪律（两模块互不依赖）。
 * @param {string} file 目标绝对路径
 * @param {string} data 写入内容
 */
export async function atomicWrite0600(file, data) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(file).catch(() => null);
  if (st !== null && st.isSymbolicLink()) {
    throw new Error(`refusing to write through a symbolic link: ${file}`);
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      try {
        await fh.chmod(0o600);
      } catch { /* Windows best effort */ }
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`cannot write ${file}: ${/** @type {Error} */ (e).message}`);
  }
}

// ---- 跨进程文件锁（<name>.lock） ----------------------------------------------

/**
 * 获取文件锁（O_EXCL 创建 `<lockFile>`，内容 pid+ts JSON；占用者 >10s 且
 * pid 死=打破重建；活占用短退避 ≤3 后报错）。
 * @param {string} lockFile 锁文件绝对路径
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ ok: true, holderPid: number, token: string, release: () => Promise<boolean> } | { ok: false, holderPid: number | null, ageMs: number }>}
 */
export async function acquireFileLock(lockFile, ctx = {}) {
  const { now = Date.now, isPidAlive = defaultIsPidAlive } = ctx;
  await mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  /** @param {string} content @returns {Promise<boolean>} */
  const tryCreate = async (content) => {
    try {
      const fh = await open(lockFile, "wx");
      try {
        try {
          await fh.chmod(0o600);
        } catch { /* Windows best effort */ }
        await fh.writeFile(content);
      } finally {
        await fh.close();
      }
      return true;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") return false;
      throw e;
    }
  };
  for (let attempt = 0; ; attempt++) {
    const token = `${JSON.stringify({ pid: process.pid, ts: now() })}\n`;
    if (await tryCreate(token)) {
      return {
        ok: true,
        holderPid: process.pid,
        token,
        /** 锁归属校验（内容比对）后释放；不属本进程=不动他人的锁 */
        release: async () => {
          try {
            const current = await readFile(lockFile, "utf8");
            if (current !== token) return false;
            await rm(lockFile, { force: true });
            return true;
          } catch {
            return false;
          }
        },
      };
    }
    if (attempt >= LOCK_RETRIES) {
      const exhausted = await readLockHolder(lockFile);
      return { ok: false, holderPid: exhausted.pid, ageMs: now() - exhausted.ts };
    }
    // 占用方裁决：读 pid+ts；>10s 且 pid 死 → 打破重建（无退避立即重试）
    const readHolder = await readLockHolder(lockFile);
    const pid = readHolder.pid;
    const ageMs = now() - readHolder.ts;
    if (pid !== null && ageMs > STALE_LOCK_MS && !isPidAlive(pid)) {
      await rm(lockFile, { force: true });
      continue;
    }
    await sleep(LOCK_BACKOFF_MS[Math.min(attempt, LOCK_BACKOFF_MS.length - 1)] ?? 100);
  }
}

/**
 * 读锁持有者（损坏/无内容=不可打破：pid null + ts=now → 视作活占用）。
 * @param {string} lockFile
 * @returns {Promise<{ pid: number | null, ts: number }>}
 */
async function readLockHolder(lockFile) {
  try {
    const holder = JSON.parse(await readFile(lockFile, "utf8"));
    if (holder !== null && typeof holder === "object") {
      const h = /** @type {Record<string, unknown>} */ (holder);
      return {
        pid: typeof h.pid === "number" ? h.pid : null,
        ts: typeof h.ts === "number" ? h.ts : 0,
      };
    }
  } catch { /* 无 info/损坏：不可打破 */ }
  return { pid: null, ts: Number.MAX_SAFE_INTEGER };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- leases.json 读/写/合并 -----------------------------------------------------

/** @returns {{ version: 1, leases: LeaseEntry[] }} */
function emptyLeases() {
  return { version: 1, leases: [] };
}

/**
 * 读 leases.json（无文件=空簿；损坏 JSON=抛含路径错误——fail-closed 不覆盖）。
 * @param {string} home
 * @returns {Promise<{ version: 1, leases: LeaseEntry[] }>}
 */
export async function loadLeases(home) {
  const file = path.join(home, LEASES_FILE);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return emptyLeases();
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid leases file ${file}: ${/** @type {Error} */ (e).message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(/** @type {Record<string, unknown>} */ (obj).leases)) {
    throw new Error(`invalid leases file ${file}: expected {version, leases:[]}`);
  }
  return { version: 1, leases: /** @type {LeaseEntry[]} */ (/** @type {Record<string, unknown>} */ (obj).leases) };
}

/**
 * 租约条目（design §2.1 schema 冻结）。
 * @typedef {Object} LeaseEntry
 * @property {string} id 10 字符不透明键
 * @property {string} server 归一化 origin
 * @property {string} relay_url 中转 URL（迁移不可达时空串待补）
 * @property {string | null} server_id
 * @property {string} fabric_id hex64
 * @property {string} root hex64
 * @property {string | null} alias 自报机器名快照
 * @property {string | null} label 本地备注（缺省 null；join 不得覆盖用户设置）
 * @property {number} registered_at 首条注册时刻（upsert 保持）
 * @property {number} expires_at 最后一次成功兑换的租期快照
 * @property {{ ts: number, generation: number, code_hash: string, receipt_sig: string } | null} receipt
 */

/**
 * leases.json 落盘（0600 原子写）。
 * @param {string} home
 * @param {{ version: 1, leases: LeaseEntry[] }} ledger
 * @returns {Promise<string>} 落盘路径
 */
export async function saveLeases(home, ledger) {
  const file = path.join(home, LEASES_FILE);
  await atomicWrite0600(file, `${JSON.stringify(ledger, null, 2)}\n`);
  return file;
}

/**
 * 租约簿键：同一台设备对同一 server 的同 fabric 身份。
 * @param {LeaseEntry} e
 */
export function leaseKey(e) {
  return `${e.server}\n${e.fabric_id}\n${e.root}`;
}

/**
 * upsert 一条租约（跨进程锁协议全流程：获取→锁内重读→合并→原子写→
 * 锁归属校验→释放）。同键=续期（expires_at/receipt/relay_url 更新，
 * registered_at 保持首条；alias 更新当前自报；label 保留用户值）。
 * @param {string} home
 * @param {{ server: string, relayUrl: string, serverId: string | null, fabricId: string, root: string, alias: string | null, expiresAt: number, receipt: LeaseEntry["receipt"] }} input
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean, random?: () => Uint8Array }} [ctx]
 * @returns {Promise<{ entry: LeaseEntry, created: boolean, total: number, lockReleased: boolean }>}
 * @throws {Error} 锁获取失败（退避耗尽）或既有账本损坏
 */
export async function upsertLease(home, input, ctx = {}) {
  const { now = Date.now, isPidAlive = defaultIsPidAlive, random } = ctx;
  const lock = await acquireFileLock(path.join(home, `${LEASES_FILE.replace(/\.json$/, "")}.lock`), { now, isPidAlive });
  if (!lock.ok) {
    throw new Error(
      `cannot acquire the leases lock (${LEASES_FILE.replace(/\.json$/, "")}.lock is held by pid ${lock.holderPid ?? "unknown"}); no lease was written`,
    );
  }
  const ledger = await loadLeases(home); // 锁内重读
  const key = `${input.server}\n${input.fabricId}\n${input.root}`;
  const existing = ledger.leases.find((e) => leaseKey(e) === key);
  /** @type {LeaseEntry} */
  let entry;
  let created = false;
  if (existing === undefined) {
    created = true;
    entry = {
      id: randomLeaseId(random),
      server: input.server,
      relay_url: input.relayUrl,
      server_id: input.serverId,
      fabric_id: input.fabricId,
      root: input.root,
      alias: input.alias,
      label: null,
      registered_at: now(),
      expires_at: input.expiresAt,
      receipt: input.receipt,
    };
    ledger.leases.push(entry);
  } else {
    entry = existing;
    entry.relay_url = input.relayUrl;
    entry.server_id = input.serverId;
    entry.alias = input.alias;
    entry.expires_at = input.expiresAt;
    entry.receipt = input.receipt;
    // registered_at 保持首条（镜像服务端 first_registered_at 裁决）；label 不动
  }
  await saveLeases(home, ledger);
  const lockReleased = await lock.release();
  return { entry, created, total: ledger.leases.length, lockReleased };
}

// ---- 旧 registration.json 迁移 --------------------------------------------------

/**
 * 迁移结果。
 * @typedef {Object} MigrationResult
 * @property {boolean} migrated 是否发生迁移落账
 * @property {string | null} warning 非 blocking 警告（损坏/跳过原因）
 * @property {LeaseEntry | null} entry 迁移并入的首条（migrated 时非 null）
 */

/**
 * 读旧 registration.json（ENOENT → state=null；损坏 → corrupt=true 且
 * state=null——调用方警告保留不阻塞）。
 * @param {string} home
 * @returns {Promise<{ corrupt: boolean, state: Record<string, unknown> | null, path?: string, message?: string }>}
 */
export async function readLegacyRegistration(home) {
  const file = path.join(home, LEGACY_REGISTRATION_FILE);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return { corrupt: false, state: null };
    throw e;
  }
  try {
    const obj = JSON.parse(text);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("expected a JSON object");
    return { corrupt: false, state: /** @type {Record<string, unknown>} */ (obj) };
  } catch (e) {
    return { corrupt: true, state: null, path: file, message: /** @type {Error} */ (e).message };
  }
}

/**
 * leases.json 存在性（迁移触发条件的只读探测——与 migrateLegacyRegistration
 * 的触发判定共用同一事实源；join 的一致性预检亦用）。
 * @param {string} home
 * @returns {Promise<boolean>}
 */
export async function leasesFileExists(home) {
  return readFile(path.join(home, LEASES_FILE), "utf8").then(
    () => true,
    () => false,
  );
}

/**
 * @param {unknown} v
 * @returns {v is LeaseEntry["receipt"]}
 */
function isReceipt(v) {
  if (v === null || typeof v !== "object") return false;
  const r = /** @type {Record<string, unknown>} */ (v);
  return (
    typeof r.ts === "number" && typeof r.generation === "number" &&
    typeof r.code_hash === "string" && typeof r.receipt_sig === "string"
  );
}

/**
 * 纯函数（r18 P2-1）：旧 registration 状态 → 租约条目构建——不落盘、不加锁、
 * 不探测网络（relay_url/serverId 由调用方探测后注入；缺省 relay_url=""、
 * server_id 取旧文件自带值）。迁移提交（migrateLegacyRegistration）与 join
 * 的一致性预检（join.freshAdmission 只读预演「迁移后条目」）共用同一构建
 * 语义，两者对「legacy 是否可迁移」的判定恒一致。
 * @param {Record<string, unknown>} state 旧 registration.json 解析对象
 * @param {{ rootFallback?: string, serverId?: string | null, relayUrl?: string, now?: () => number, random?: () => Uint8Array }} [ctx]
 * @returns {{ ok: true, entry: LeaseEntry } | { ok: false }} ok=false=必需字段缺失/非法（server/fabric_id/root）
 */
export function buildLegacyLeaseEntry(state, ctx = {}) {
  const { rootFallback, serverId = null, relayUrl = "", now = Date.now, random } = ctx;
  const server = state.server;
  const fabricId = state.fabric_id;
  const root = typeof state.root === "string" && HEX64_RE.test(state.root)
    ? state.root
    : (typeof rootFallback === "string" && HEX64_RE.test(rootFallback) ? rootFallback : null);
  if (typeof server !== "string" || server === "" || typeof fabricId !== "string" || !HEX64_RE.test(fabricId) || root === null) {
    return { ok: false };
  }
  /** @type {LeaseEntry} */
  const entry = {
    id: randomLeaseId(random),
    server,
    relay_url: relayUrl,
    server_id: typeof state.server_id === "string" && HEX64_RE.test(state.server_id) ? state.server_id : serverId,
    fabric_id: fabricId,
    root,
    alias: null,
    label: typeof state.label === "string" ? state.label : null,
    registered_at: typeof state.registered_at === "number" ? state.registered_at : now(),
    expires_at: typeof state.expires_at === "number" ? state.expires_at : 0,
    receipt: isReceipt(state.receipt) ? state.receipt : null,
  };
  return { ok: true, entry };
}

/**
 * 触发式迁移：旧 registration.json 存在且 leases.json 缺失时，在 leases
 * 写锁内并入首条（relay_url 由对 server 发 /services.json 探测补全，任何
 * 不可达=留空待下次 join 补）；旧文件改名 registration.json.migrated；
 * 损坏=警告保留不阻塞。仅在 admission 锁内调用（锁序 admission→ledger）。
 * 条目构建=buildLegacyLeaseEntry（纯函数，与 join 一致性预检共用）。
 * @param {string} home
 * @param {{ server?: string, rootFallback?: string, fetchImpl?: typeof fetch, probeTimeoutMs?: number, now?: () => number, isPidAlive?: (pid: number) => boolean, random?: () => Uint8Array, warn?: (line: string) => void }} [ctx]
 * @returns {Promise<MigrationResult>}
 */
export async function migrateLegacyRegistration(home, ctx = {}) {
  const {
    fetchImpl = fetch,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    now = Date.now,
    isPidAlive = defaultIsPidAlive,
    random,
    warn = () => {},
  } = ctx;
  const leasesExists = await leasesFileExists(home);
  const legacy = await readLegacyRegistration(home);
  if (legacy.state === null && !legacy.corrupt) return { migrated: false, warning: null, entry: null };
  if (leasesExists) return { migrated: false, warning: null, entry: null };
  if (legacy.corrupt) {
    // 损坏=警告保留不阻塞（原文件原样，join 以全新账本继续）
    warn(`warning: legacy ${LEGACY_REGISTRATION_FILE} is damaged (${legacy.message}); keeping it in place`);
    return { migrated: false, warning: `legacy registration damaged; kept in place`, entry: null };
  }

  // relay_url 探测补全（无凭证；不可达=留空待补——不阻塞迁移）
  /** @type {string} */
  let relayUrl = "";
  /** @type {string | null} */
  let serverId = null;
  if (typeof legacy.state.server === "string" && legacy.state.server !== "") {
    const probed = await probeServer(legacy.state.server, { fetchImpl, timeoutMs: probeTimeoutMs, now });
    if (probed.result === "reachable" && typeof probed.serverId === "string") {
      serverId = probed.serverId;
      const selected = selectRelayFromManifest(probed.manifest);
      if (selected.ok) relayUrl = selected.url;
    }
  }

  const built = buildLegacyLeaseEntry(legacy.state, { rootFallback: ctx.rootFallback, serverId, relayUrl, now, random });
  if (!built.ok) {
    warn(
      `warning: legacy ${LEGACY_REGISTRATION_FILE} is incomplete or damaged; keeping it in place (join continues with a fresh ledger)`,
    );
    return { migrated: false, warning: "legacy registration incomplete or damaged; kept in place", entry: null };
  }
  const entry = built.entry;

  const lock = await acquireFileLock(path.join(home, "leases.lock"), { now, isPidAlive });
  if (!lock.ok) {
    throw new Error(
      `cannot acquire the leases lock during migration (held by pid ${lock.holderPid ?? "unknown"}); retry join`,
    );
  }
  try {
    // 锁内再核（并发迁移者可能已落账）
    const again = await readFile(path.join(home, LEASES_FILE), "utf8").then(() => true, () => false);
    if (again) return { migrated: false, warning: null, entry: null };
    await saveLeases(home, { version: 1, leases: [entry] });
    await rename(path.join(home, LEGACY_REGISTRATION_FILE), path.join(home, `${LEGACY_REGISTRATION_FILE}.migrated`));
    return { migrated: true, warning: null, entry };
  } finally {
    await lock.release();
  }
}

// ---- 既有 fabric 源读取（单 fabric 约束 preflight） ------------------------------

/**
 * 读 roster.facts 头部 fabric_id（DWEBRST1 + 32B；纯 JS 读文件，不引 NAPI）。
 * 无文件/形态不符 → null。
 * @param {string} home
 * @returns {Promise<string | null>} hex64
 */
export async function readRosterFabricId(home) {
  let bytes;
  try {
    bytes = await readFile(path.join(home, ROSTER_FILE));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
  if (bytes.length < ROSTER_MAGIC.length + 32) return null;
  if (!bytes.subarray(0, ROSTER_MAGIC.length).equals(ROSTER_MAGIC)) return null;
  const hex = bytes.subarray(ROSTER_MAGIC.length, ROSTER_MAGIC.length + 32).toString("hex");
  return HEX64_RE.test(hex) ? hex : null;
}

/**
 * 汇总裁决既有 fabric（优先级：leases 首条 > 旧 registration.json >
 * roster.facts；多源且互不相等=本地 fabric 状态不一致 → fail-closed）。
 * @param {{ leases: LeaseEntry[], legacy: Record<string, unknown> | null, rosterFabricId: string | null }} sources
 * @returns {{ ok: true, fabricId: string | null } | { ok: false, conflict: string[] }}
 */
export function resolveExistingFabricId({ leases, legacy, rosterFabricId }) {
  /** @type {string[]} */
  const found = [];
  const fromLeases = leases.length > 0 && typeof leases[0].fabric_id === "string" && HEX64_RE.test(leases[0].fabric_id)
    ? leases[0].fabric_id
    : null;
  if (fromLeases !== null) found.push(fromLeases);
  if (legacy !== null && typeof legacy.fabric_id === "string" && HEX64_RE.test(legacy.fabric_id)) found.push(legacy.fabric_id);
  if (rosterFabricId !== null) found.push(rosterFabricId);
  const distinct = [...new Set(found)];
  if (distinct.length > 1) return { ok: false, conflict: distinct };
  return { ok: true, fabricId: distinct[0] ?? null };
}

// ---- visits.json 到访簿 ----------------------------------------------------------

/**
 * 探测结果（五类确定映射冻结）。
 * @typedef {Object} ProbeOutcome
 * @property {"reachable" | "unreachable"} result
 * @property {string | null} detail http-status:<n>/timeout/dns/bad-body/conn-refused
 * @property {number} at
 * @property {string | null} serverId 可解析出的 server_id（无则 null）
 * @property {unknown} manifest 可解析的 services 文档（内部复用；落账不含）
 */

/**
 * 无凭证探测 `GET <origin>/services.json`（5s 超时）。五类映射：
 * 2xx 可解析→reachable；非 2xx→unreachable/http-status:<n>；连接拒绝→
 * conn-refused；DNS→dns；超时→timeout；2xx 坏 JSON→bad-body。
 * @param {string} origin
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number }} [ctx]
 * @returns {Promise<ProbeOutcome>}
 */
export async function probeServer(origin, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, now = Date.now } = {}) {
  const at = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/services.json`, { signal: controller.signal });
    if (!(res.status >= 200 && res.status <= 299)) {
      return { result: "unreachable", detail: `http-status:${res.status}`, at, serverId: null, manifest: null };
    }
    let text;
    try {
      text = await res.text();
    } catch {
      return { result: "unreachable", detail: "conn-refused", at, serverId: null, manifest: null };
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return { result: "unreachable", detail: "bad-body", at, serverId: null, manifest: null };
    }
    const sid =
      doc !== null && typeof doc === "object" && typeof (/** @type {Record<string, unknown>} */ (doc)).server_id === "string" &&
      HEX64_RE.test((/** @type {Record<string, unknown>} */ (doc)).server_id)
        ? (/** @type {Record<string, unknown>} */ (doc)).server_id
        : null;
    return { result: "reachable", detail: null, at, serverId: sid, manifest: doc };
  } catch (e) {
    const err = /** @type {Error & { cause?: { code?: string } } } */ (e);
    if (err.name === "AbortError") return { result: "unreachable", detail: "timeout", at, serverId: null, manifest: null };
    const code = err.cause?.code ?? "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return { result: "unreachable", detail: "dns", at, serverId: null, manifest: null };
    }
    if (code === "ETIMEDOUT") return { result: "unreachable", detail: "timeout", at, serverId: null, manifest: null };
    return { result: "unreachable", detail: "conn-refused", at, serverId: null, manifest: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 到访簿条目。
 * @typedef {Object} VisitEntry
 * @property {string} server
 * @property {string | null} server_id
 * @property {number} first_visit_at
 * @property {number | null} last_visit_at 最近一次 reachable 探测时刻（从未可达=null）
 * @property {{ result: "reachable" | "unreachable", detail?: string, at: number }} last_probe
 * @property {string | null} note
 */

/**
 * 读 visits.json（无文件=空簿；损坏=抛含路径错误）。
 * @param {string} home
 * @returns {Promise<{ version: 1, visits: VisitEntry[] }>}
 */
export async function loadVisits(home) {
  const file = path.join(home, VISITS_FILE);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return { version: 1, visits: [] };
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid visits file ${file}: ${/** @type {Error} */ (e).message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(/** @type {Record<string, unknown>} */ (obj).visits)) {
    throw new Error(`invalid visits file ${file}: expected {version, visits:[]}`);
  }
  return { version: 1, visits: /** @type {VisitEntry[]} */ (/** @type {Record<string, unknown>} */ (obj).visits) };
}

/**
 * 记一条到访（探测动作/访客连接类命令的写入口；join 不调用）。键=server；
 * first_visit_at=条目创建；last_visit_at=最近 reachable 探测时刻。
 * @param {string} home
 * @param {{ server: string, serverId?: string | null, probe: ProbeOutcome }} input
 * @param {{ now?: () => number, isPidAlive?: (pid: number) => boolean }} [ctx]
 * @returns {Promise<{ entry: VisitEntry, created: boolean, lockReleased: boolean }>}
 */
export async function recordVisit(home, input, ctx = {}) {
  const { now = Date.now, isPidAlive = defaultIsPidAlive } = ctx;
  const lock = await acquireFileLock(path.join(home, "visits.lock"), { now, isPidAlive });
  if (!lock.ok) {
    throw new Error(`cannot acquire the visits lock (held by pid ${lock.holderPid ?? "unknown"}); visit not recorded`);
  }
  const book = await loadVisits(home);
  const existing = book.visits.find((v) => v.server === input.server);
  const reachable = input.probe.result === "reachable";
  const lastProbe = {
    result: input.probe.result,
    ...(input.probe.detail !== null ? { detail: input.probe.detail } : {}),
    at: input.probe.at,
  };
  const sid = input.serverId ?? input.probe.serverId ?? null;
  /** @type {VisitEntry} */
  let entry;
  let created = false;
  if (existing === undefined) {
    created = true;
    entry = {
      server: input.server,
      server_id: sid,
      first_visit_at: now(),
      last_visit_at: reachable ? input.probe.at : null,
      last_probe: lastProbe,
      note: null,
    };
    book.visits.push(entry);
  } else {
    entry = existing;
    if (sid !== null) entry.server_id = sid;
    if (reachable) entry.last_visit_at = input.probe.at;
    entry.last_probe = lastProbe;
  }
  const file = path.join(home, VISITS_FILE);
  await atomicWrite0600(file, `${JSON.stringify(book, null, 2)}\n`);
  const lockReleased = await lock.release();
  return { entry, created, lockReleased };
}

// ---- relay 选择（join services preflight；design §2.1 冻结规则） ------------------

/** relay URL 长度上限（合法 http(s) URL 判定一部分） */
export const RELAY_URL_MAX = 2048;

/**
 * 从 services manifest 选 relay：`services[]` 中 name=="relay" &&
 * enabled==true && url 非空串且为合法 http(s) URL（scheme/authority/长度）；
 * 多候选按 manifest 顺序取第一条合法者；一条都没有={ok:false}。
 * @param {unknown} manifest 已解析的 services.json 文档
 * @returns {{ ok: true, url: string } | { ok: false, reason: "no-relay" | "bad-manifest" }}
 */
export function selectRelayFromManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, reason: "bad-manifest" };
  }
  const services = (/** @type {Record<string, unknown>} */ (manifest)).services;
  if (!Array.isArray(services)) return { ok: false, reason: "bad-manifest" };
  for (const item of services) {
    if (item === null || typeof item !== "object") continue;
    const s = /** @type {Record<string, unknown>} */ (item);
    if (s.name !== "relay" || s.enabled !== true) continue;
    const url = s.url;
    if (typeof url !== "string" || url === "") continue;
    if (!isLegalHttpUrl(url)) continue;
    return { ok: true, url };
  }
  return { ok: false, reason: "no-relay" };
}

/**
 * 合法 http(s) URL 判定：scheme http/https、authority 非空、长度 ≤2048、
 * 无反斜杠；unspecified 地址（0.0.0.0/::）不算可用 authority。
 * @param {string} raw
 */
export function isLegalHttpUrl(raw) {
  if (raw.length > RELAY_URL_MAX) return false;
  if (raw.includes("\\")) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "") return false;
  if (net.isIP(host) !== 0) return host !== "0.0.0.0" && host !== "::";
  return true;
}

// ---- pending admission journal ---------------------------------------------------

/**
 * journal 载入（无=null；损坏={corrupt}——fail-closed 人工恢复，不猜）。
 * @param {string} home
 * @returns {Promise<{ corrupt: false, journal: Journal | null } | { corrupt: true, path: string, message: string }>}
 */
export async function loadAdmissionJournal(home) {
  const file = path.join(home, ADMISSION_JOURNAL_FILE);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return { corrupt: false, journal: null };
    throw e;
  }
  try {
    const obj = JSON.parse(text);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("expected a JSON object");
    const j = /** @type {Record<string, unknown>} */ (obj);
    if (typeof j.server !== "string" || typeof j.code_hash !== "string" || !HEX64_RE.test(j.code_hash) ||
      typeof j.fabric_id !== "string" || !HEX64_RE.test(j.fabric_id) || typeof j.root !== "string" || !HEX64_RE.test(j.root)) {
      throw new Error("missing or invalid admission fields");
    }
    return {
      corrupt: false,
      journal: {
        server: j.server,
        code_hash: j.code_hash,
        fabric_id: j.fabric_id,
        root: j.root,
        attempt: typeof j.attempt === "number" ? j.attempt : 1,
        last_error: typeof j.last_error === "string" ? j.last_error : null,
        ts: typeof j.ts === "number" ? j.ts : 0,
      },
    };
  } catch (e) {
    return { corrupt: true, path: file, message: /** @type {Error} */ (e).message };
  }
}

/**
 * pending admission journal（0600 原子写；远端 register 发出前落账）。
 * @typedef {Object} Journal
 * @property {string} server 归一化 origin
 * @property {string} code_hash 规范化码 blake3（hex64）
 * @property {string} fabric_id
 * @property {string} root
 * @property {number} attempt
 * @property {string | null} last_error
 * @property {number} ts
 */

/**
 * 写 journal（0600 原子写）。
 * @param {string} home
 * @param {Journal} journal
 */
export async function saveAdmissionJournal(home, journal) {
  await atomicWrite0600(path.join(home, ADMISSION_JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`);
}

/**
 * 清 journal（补账完成后）。
 * @param {string} home
 */
export async function clearAdmissionJournal(home) {
  await rm(path.join(home, ADMISSION_JOURNAL_FILE), { force: true });
}

// ---- 供测试/调用方复用的小件 -------------------------------------------------------

/**
 * admission 锁路径。
 * @param {string} home
 */
export function fabricLockFile(home) {
  return path.join(home, FABRIC_LOCK_FILE);
}

/**
 * 原子写对外单点（journal 等小文件；账本用 saveLeases/saveVisits 语义入口）。
 * @param {string} file
 * @param {string} data
 */
export { atomicWrite0600 as atomicWrite };
