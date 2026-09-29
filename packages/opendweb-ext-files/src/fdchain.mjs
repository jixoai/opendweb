// fd 链路径安全核心（webui-plugin-kernel Phase 2 / design v2.3 §6 r2-B2 冻结 +
// specs/plugins/files/spec.md「路径逃逸与 symlink 防护」）。
// 意图（2026-09-29）：
// 1. **合格实现（fd 链逐组件遍历）**：share root 以目录 fd 打开并冻结；每操作
//    从 root fd 按路径组件逐级打开——目录组件 `O_DIRECTORY|O_NOFOLLOW`（拒绝
//    每级 symlink），最终组件按操作类型带 `O_NOFOLLOW`，逐级持有父目录 fd，
//    最终操作只作用于已验证 fd（fstat 复核类型）。lstat+open 两步不作为实现。
//    逐级「fd 相对打开」需要平台原语：
//    - linux：`/proc/self/fd/<fd>/<comp>`——内核 magic link 跳转到 fd 记录的
//      dentry（rename 后仍指向同一 inode），等效 openat；
//    - darwin：`/dev/fd/<fd>/<comp>`——**本仓已实证不可用**（macOS 27/APFS 实测
//      2026-09-29：遍历 ENOENT、open(O_DIRECTORY) 与 chdir 均 ENOTDIR——devfs
//      fdesc 只对终组件委托 getattr/stat（stat 是 fd 钉定的），不提供子组件
//      lookup；/.vol volfs 已死（ENOENT）；Node 无 openat/fchdir 面）。
// 2. **能力探测（安全探测，非存在性探测）**：`pathSafetyCapability()` 在临时
//    目录实测五件事——(a) `<prefix>/<fd>/<comp>` 逐级可开；(b) 多跳遍历可读；
//    (c) O_NOFOLLOW 经前缀拒绝 symlink（ELOOP）；(d) **fd 钉定判别**（换名
//    父目录后在原路径放诱饵目录，经 fd 链必须读不到诱饵条目——部分 BSD 的
//    /dev/fd 是指向原路径的符号链接，遍历「能开」但是路径回解析，必须判为
//    不可用）；(e) mkdir/rename/unlink 经前缀可用。任何一步失败 → 前缀不可用。
// 3. **降级策略（显式，不静默弱化）**：探测失败的非 win32 平台（本机 darwin
//    即是）落入 `verified-walk` 模式：仍冻结 root fd 并逐级 `O_DIRECTORY|
//    O_NOFOLLOW` 打开+逐级持 fd+fstat 复核，另加 (i) root 路径身份校验
//    （lstat(rootPath) 的 dev+ino === fstat(rootFd)，root 被换名/替换 →
//    fail-closed 拒绝）、(ii) 每级身份复核（lstat(该级路径) 与 fstat(该级 fd)
//    比对 dev+ino，在终 fd 交给调用方使用之前完成）、(iii) **运行时全操作互斥**
//    （runtime.mjs 的 ops mutex——wire 对端的一切变更经同一串行闸，对端竞态按
//    构造排除；本地属主进程属可信域）。此模式对「wire 对端竞态」免疫（串行化+
//    逐级 O_NOFOLLOW+身份复核），对「本地属主竞态」不主张 fd 链级免疫——能力
//    与边界经 capability 显式上报；后续如需 darwin 全量免疫需 openat NAPI 绑定
//    （另行 change）。
// 4. **win32 分支**：无 fd 遍历原语且 Node 亦无等效物——share 创建/操作显式
//    拒绝（NotImplementedError 语义，文案见 WIN32_DEGRADATION_NOTE），不静默
//    弱化。
// 5. 纯 Node 标准库；能力探测按进程缓存一次（测试可重置/强探）。

import fsSync, { constants as FS, open as openCb } from "node:fs";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** promisified fs.open —— 返回裸 fd（number）：fd 链的锚必须是 fd 号，不是 FileHandle */
const openRaw = promisify(openCb);

/** 最终组件期望类型（fstat 复核用） */
export const EXPECT = {
  FILE: "file",
  DIR: "dir",
};

/**
 * win32 显式降级文案（design §6：降级必须显式落文档，不得静默）。
 * @type {string}
 */
export const WIN32_DEGRADATION_NOTE =
  "the files plugin requires per-component fd-relative path traversal (O_DIRECTORY|O_NOFOLLOW against a frozen root directory fd); " +
  "node on win32 exposes no such primitive (no openat, no /dev/fd or /proc/self/fd namespace), so shares are not supported on win32 in this version " +
  "(design v2.3 §6 degradation boundary; a native openat binding would be a separate change)";

/**
 * @typedef {"fd-chain" | "verified-walk" | "unsupported"} PathSafetyMode
 * fd-chain=逐级 fd 相对打开（平台原语可用；本地竞态免疫）
 * verified-walk=冻结 root fd+逐级 O_NOFOLLOW 打开+身份复核+运行时全操作互斥
 *   （对 wire 对端竞态免疫；本地属主竞态不在主张范围——显式降级）
 * unsupported=win32（share 创建/操作显式拒绝）
 */

/**
 * @typedef {Object} PathSafetyCapability
 * @property {string} platform process.platform
 * @property {PathSafetyMode} mode
 * @property {string | null} prefix 可用的 fd 命名空间前缀（fd-chain 模式）
 * @property {string[]} evidence 探针实证记录（报告/日志用）
 */

/**
 * wire 层文件系统错误（code → HTTP 状态映射在 runtime）。
 */
export class WireFsError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WireFsError";
    this.code = code;
  }
}

/** 候选 fd 命名空间前缀（按平台优先序） */
function candidatePrefixes(platform) {
  if (platform === "darwin") return ["/dev/fd"];
  if (platform === "linux") return ["/proc/self/fd", "/dev/fd"];
  return [];
}

/**
 * 打开 share root 目录 fd（冻结入口）。终组件 O_NOFOLLOW（root 本身是
 * symlink → 拒绝；中间组件正常跟随——账本 root 是本机管理面录入的绝对路径，
 * 例如 /tmp/... 在 macOS 上经由 /private/tmp symlink 是合法的）。
 * @param {string} rootPath
 * @returns {Promise<number>} 目录 fd（调用方负责 close）
 */
export async function openRootFd(rootPath) {
  const fh = await openRaw(rootPath, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  return fh;
}

/**
 * 单组件相对打开（两种模式同一形状）。
 * fd-chain 模式：`<prefix>/<parentFd>/<name>`——O_NOFOLLOW 只约束终组件
 * （name）；前缀里的 magic link 是中间组件、按语义跟随（正是所需）。
 * verified-walk 模式：绝对路径打开（父链身份由 withResolved 复核）。
 * @param {{ mode: PathSafetyMode, prefix: string | null }} cap
 * @param {number} parentFd 父目录 fd（fd-chain 模式的锚）
 * @param {string} parentPath 父目录绝对路径（verified-walk 模式用）
 * @param {string} name 组件名（已过 validateComponents——无 / 无 .. 无 NUL）
 * @param {number} flags
 * @returns {Promise<number>}
 */
export async function openChild(cap, parentFd, parentPath, name, flags) {
  if (cap.mode === "fd-chain") {
    const fh = await openRaw(`${cap.prefix}/${parentFd}/${name}`, flags);
    return fh;
  }
  const fh = await openRaw(path.join(parentPath, name), flags);
  return fh;
}

/**
 * 目录组件一级打开（O_DIRECTORY|O_NOFOLLOW）+ fstat 复核为目录。
 * @param {{ mode: PathSafetyMode, prefix: string | null }} cap
 * @param {number} parentFd
 * @param {string} parentPath
 * @param {string} name
 * @returns {Promise<{ fd: number, stat: import("node:fs").Stats, path: string }>}
 *   path=该级绝对路径（fd-chain 模式仅为诊断信息——锚是 fd，不是路径）
 */
export async function openChildDir(cap, parentFd, parentPath, name) {
  const fd = await openChild(cap, parentFd, parentPath, name, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  const stat = fsSync.fstatSync(fd);
  if (!stat.isDirectory()) {
    fsSync.closeSync(fd);
    throw new WireFsError("TYPE_MISMATCH", `component "${name}" is not a directory`);
  }
  return { fd, stat, path: path.join(parentPath, name) };
}

/**
 * 相对变更类操作（fd-chain 模式经前缀锚定父 fd；verified-walk 模式路径式、
 * 依赖调用方（runtime ops mutex）串行化与父链身份复核）。
 */
export const mutators = {
  /** @param {{ mode: PathSafetyMode, prefix: string | null }} cap @returns {Promise<void>} */
  async mkdir(cap, parentFd, parentPath, name) {
    if (cap.mode === "fd-chain") await fsp.mkdir(`${cap.prefix}/${parentFd}/${name}`);
    else await fsp.mkdir(path.join(parentPath, name));
  },
  /** @param {{ mode: PathSafetyMode, prefix: string | null }} cap @returns {Promise<void>} */
  async unlink(cap, parentFd, parentPath, name) {
    if (cap.mode === "fd-chain") await fsp.unlink(`${cap.prefix}/${parentFd}/${name}`);
    else await fsp.unlink(path.join(parentPath, name));
  },
  /** @param {{ mode: PathSafetyMode, prefix: string | null }} cap @returns {Promise<void>} */
  async rmdir(cap, parentFd, parentPath, name) {
    if (cap.mode === "fd-chain") await fsp.rmdir(`${cap.prefix}/${parentFd}/${name}`);
    else await fsp.rmdir(path.join(parentPath, name));
  },
  /**
   * rename（两锚点：src/dst 父目录可以不同——fd-chain 模式两操作数各自经前缀
   * 锚定其父 fd；POSIX rename 保证同文件系统内单次原子换名）。
   * @param {{ mode: PathSafetyMode, prefix: string | null }} cap
   * @param {number} fromParentFd
   * @param {string} fromParentPath
   * @param {string} fromName
   * @param {number} toParentFd
   * @param {string} toParentPath
   * @param {string} toName
   * @returns {Promise<void>}
   */
  async rename(cap, fromParentFd, fromParentPath, fromName, toParentFd, toParentPath, toName) {
    if (cap.mode === "fd-chain") {
      await fsp.rename(`${cap.prefix}/${fromParentFd}/${fromName}`, `${cap.prefix}/${toParentFd}/${toName}`);
    } else {
      await fsp.rename(path.join(fromParentPath, fromName), path.join(toParentPath, toName));
    }
  },
};

/**
 * 客户端相对路径 → 组件数组（第一道防线：纯字符串校验，无竞态面）。
 * 拒绝：绝对路径、`..`、NUL、组件超长、层数超深；空组件（`//`）与 `.` 归一。
 * （反斜杠在 posix 是合法文件名字符，放行；win32 share 已整体拒绝。）
 * @param {string} raw 客户端 path 参数（已百分号解码）
 * @returns {{ ok: true, components: string[] } | { ok: false, code: "ESCAPE", reason: string }}
 */
export function validateComponents(raw) {
  if (typeof raw !== "string") return { ok: false, code: "ESCAPE", reason: "path must be a string" };
  if (raw === "") return { ok: true, components: [] };
  if (raw.length > 4096) return { ok: false, code: "ESCAPE", reason: "path too long" };
  if (raw.includes("\0")) return { ok: false, code: "ESCAPE", reason: "NUL byte in path" };
  if (raw.startsWith("/")) return { ok: false, code: "ESCAPE", reason: "absolute paths are rejected" };
  const parts = raw.split("/");
  /** @type {string[]} */
  const components = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue; // 尾斜杠/双斜杠归一
    if (part === "..") return { ok: false, code: "ESCAPE", reason: "\"..\" is rejected" };
    if (part.length > 255) return { ok: false, code: "ESCAPE", reason: "component too long" };
    components.push(part);
  }
  if (components.length > 64) return { ok: false, code: "ESCAPE", reason: "path too deep" };
  return { ok: true, components };
}

/**
 * errno → WireFsError 映射（打开/变更失败时调用）。
 * @param {unknown} e
 * @param {string} what 诊断语境
 * @returns {WireFsError}
 */
export function mapOpenError(e, what) {
  const err = /** @type {NodeJS.ErrnoException} */ (e);
  switch (err.code) {
    case "ENOENT":
      return new WireFsError("NOT_FOUND", `${what}: not found`, { cause: e });
    case "ELOOP":
      return new WireFsError("SYMLINK", `${what}: symbolic links are rejected on every path component`, { cause: e });
    case "ENOTDIR":
      return new WireFsError("NOT_DIR", `${what}: a component is not a directory`, { cause: e });
    case "EISDIR":
      return new WireFsError("IS_DIR", `${what}: is a directory`, { cause: e });
    case "EEXIST":
      return new WireFsError("EXISTS", `${what}: already exists`, { cause: e });
    case "ENOTEMPTY":
      return new WireFsError("NOT_EMPTY", `${what}: directory is not empty`, { cause: e });
    case "EPERM":
    case "EACCES":
      return new WireFsError("DENIED", `${what}: permission denied`, { cause: e });
    default:
      return new WireFsError("IO", `${what}: ${err.code ?? err.message}`, { cause: e });
  }
}

/**
 * 解析结果（withResolved 的 use 回调入参）。
 * @typedef {Object} ResolvedTarget
 * @property {number} fd 终组件 fd（root 本身时=冻结 fd——release 不会关它）
 * @property {import("node:fs").Stats} stat 终组件 fstat（类型已复核）
 * @property {number} parentFd 终组件父目录 fd（变更类操作的锚；root 本身时=冻结 fd）
 * @property {string} parentPath 终组件父目录路径
 * @property {string | null} name 终组件名（null=root 本身）
 * @property {() => Promise<void>} release 关闭本次解析新开的所有 fd（幂等）
 */

/**
 * 沿链解析+使用+释放的统一纪律（单一实现面；中间 fd 与终 fd 永不泄漏）。
 * 步骤：verified-walk 先做 root 路径身份校验 → 逐级持 fd 打开目录组件
 * （O_DIRECTORY|O_NOFOLLOW）→ 终组件按 spec 打开（O_NOFOLLOW）→ fstat 复核
 * 类型 → verified-walk 逐级身份复核（在把 fd 交给 use 之前完成——任何不一致
 * 即拒绝且不使用 fd）→ use(target) → finally 关闭本次新开 fd。
 * @param {{ mode: PathSafetyMode, prefix: string | null }} cap
 * @param {{ rootFd: number, rootPath: string, rootIno: number, rootDev: number }} root
 * @param {string[]} components validateComponents 的产物（空数组=root 本身）
 * @param {{ flags: number, expect: "file" | "dir" }} finalSpec
 * @param {(t: ResolvedTarget) => Promise<T>} use
 * @template T
 * @returns {Promise<T>}
 */
export async function withResolved(cap, root, components, finalSpec, use) {
  /** @type {number[]} 本次新开的 fd（含终 fd；不含冻结 root fd） */
  const opened = [];
  try {
    if (cap.mode === "verified-walk") {
      const st = await fsp.lstat(root.rootPath).catch(() => null);
      if (st === null || st.isSymbolicLink() || st.ino !== root.rootIno || st.dev !== root.rootDev) {
        throw new WireFsError(
          "ROOT_GONE",
          "share root path no longer names the frozen root directory (moved or replaced); re-create the share",
        );
      }
    }
    let parentFd = root.rootFd;
    let parentPath = root.rootPath;
    for (let i = 0; i < components.length - 1; i++) {
      const step = await openChildDir(cap, parentFd, parentPath, components[i]).catch((e) => {
        throw mapOpenError(e, `component "${components[i]}"`);
      });
      opened.push(step.fd);
      parentFd = step.fd;
      parentPath = step.path;
    }
    const name = components.length > 0 ? components[components.length - 1] : null;
    /** @type {number} */
    let fd;
    /** @type {import("node:fs").Stats} */
    let stat;
    if (name === null) {
      stat = fsSync.fstatSync(root.rootFd);
      if (finalSpec.expect === "file") throw new WireFsError("IS_DIR", "share root itself is a directory");
      if (!stat.isDirectory()) throw new WireFsError("TYPE_MISMATCH", "share root is not a directory");
      fd = root.rootFd;
    } else {
      fd = await openChild(cap, parentFd, parentPath, name, finalSpec.flags).catch((e) => {
        throw mapOpenError(e, `opening "${name}"`);
      });
      opened.push(fd);
      stat = fsSync.fstatSync(fd);
      if (finalSpec.expect === "file" && !stat.isFile()) {
        throw new WireFsError("IS_DIR", `"${name}" is not a regular file`);
      }
      if (finalSpec.expect === "dir" && !stat.isDirectory()) {
        throw new WireFsError("NOT_DIR", `"${name}" is not a directory`);
      }
    }
    if (cap.mode === "verified-walk") {
      await verifyChainIdentity(root, components, opened);
    }
    /** @type {ResolvedTarget} */
    const target = {
      fd,
      stat,
      parentFd,
      parentPath,
      name,
      release: async () => {
        for (const cfd of opened) fsSync.closeSync(cfd);
        opened.length = 0;
      },
    };
    return await use(target);
  } finally {
    for (const cfd of opened) fsSync.closeSync(cfd);
  }
}

/**
 * verified-walk 身份复核：从 root 路径起逐级 lstat，与本次打开的 fd（fstat）
 * 比对 dev+ino；不一致/缺失 → RACE_DETECTED（fail-closed，不使用已开的 fd）。
 * @param {{ rootPath: string }} root
 * @param {string[]} components
 * @param {number[]} opened 本次新开的 fd 序（= 组件序，逐级对应）
 */
async function verifyChainIdentity(root, components, opened) {
  let cur = root.rootPath;
  for (let i = 0; i < components.length; i++) {
    cur = path.join(cur, components[i]);
    const lst = await fsp.lstat(cur).catch(() => null);
    if (lst === null) {
      throw new WireFsError("RACE_DETECTED", `"${components[i]}" changed during resolution; operation rejected`);
    }
    const fd = opened[i];
    if (fd === undefined) continue;
    const fst = fsSync.fstatSync(fd);
    if (lst.ino !== fst.ino || lst.dev !== fst.dev) {
      throw new WireFsError("RACE_DETECTED", `"${components[i]}" was replaced during resolution; operation rejected`);
    }
  }
}

// ---- 能力探测 ---------------------------------------------------------------------

/** @type {PathSafetyCapability | null} 进程级缓存（探测只做一次） */
let cachedCapability = null;

/**
 * 安全力探针：验证 `<prefix>/<fd>/<comp>` 是否**真正 fd 钉定**。
 * 场景：P=<tmp>/p（开 fd）；P/sub 真目录+canary 文件；随后换名 P→P-old 并在
 * 原路径重建新 P（decoy-entry 仅存在于新 P）。经 fd 链：sub/canary 换名后仍
 * 可读（fd 钉定）；decoy-entry 必须 ENOENT（若可读=路径回解析，判不可用）。
 * @param {string} prefix
 * @param {string[]} evidence
 * @returns {Promise<boolean>}
 */
async function probePrefixPinned(prefix, evidence) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-fdprobe-"));
  /** @type {Array<number>} */
  const fds = [];
  try {
    const p = path.join(base, "p");
    await fsp.mkdir(path.join(p, "sub"), { recursive: true });
    await fsp.writeFile(path.join(p, "sub", "canary"), "CANARY");
    const pfd = await openRaw(p, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
    fds.push(pfd);
    // (a) 子目录逐级可开（O_DIRECTORY|O_NOFOLLOW）
    const subfd = await openRaw(`${prefix}/${pfd}/sub`, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW).catch(() => null);
    if (subfd === null) {
      evidence.push(`${prefix}: child directory open via ${prefix}/<fd>/<comp> failed`);
      return false;
    }
    fds.push(subfd);
    // (b) 两跳遍历可读
    const canary = await fsp.readFile(`${prefix}/${pfd}/sub/canary`, "utf8").catch(() => null);
    if (canary !== "CANARY") {
      evidence.push(`${prefix}: nested traversal read failed`);
      return false;
    }
    // (c) O_NOFOLLOW 经前缀拒绝 symlink 终组件（root 内 symlink 指向 root 外）
    await fsp.writeFile(path.join(base, "outside"), "OUTSIDE");
    await fsp.symlink(path.join(base, "outside"), path.join(p, "sub", "sln"));
    const slnOpen = await openRaw(`${prefix}/${pfd}/sub/sln`, FS.O_RDONLY | FS.O_NOFOLLOW).then(
      (fh) => {
        fds.push(fh);
        return true;
      },
      () => false,
    );
    if (slnOpen) {
      evidence.push(`${prefix}: O_NOFOLLOW did not reject a symlink component`);
      return false;
    }
    // (d) fd 钉定判别（换名+诱饵）
    await fsp.rename(p, `${p}-old`);
    await fsp.mkdir(p);
    await fsp.writeFile(path.join(p, "decoy-entry"), "DECOY");
    const decoyViaFd = await fsp.readFile(`${prefix}/${pfd}/decoy-entry`, "utf8").catch(() => null);
    if (decoyViaFd !== null) {
      evidence.push(`${prefix}: traversal is path-resolved, not fd-pinned (decoy readable via fd path)`);
      return false;
    }
    const canaryAfter = await fsp.readFile(`${prefix}/${pfd}/sub/canary`, "utf8").catch(() => null);
    if (canaryAfter !== "CANARY") {
      evidence.push(`${prefix}: fd-pinned read failed after parent rename`);
      return false;
    }
    // (e) 变更类操作经前缀可用（mkdir/rename/unlink）
    await fsp.mkdir(`${prefix}/${subfd}/nd`);
    await fsp.rename(`${prefix}/${subfd}/nd`, `${prefix}/${subfd}/nd2`);
    await fsp.unlink(`${prefix}/${subfd}/nd2`);
    evidence.push(`${prefix}: fd-pinned traversal verified (child open, O_NOFOLLOW rejection, rename-swap pinning, mutators)`);
    return true;
  } catch (e) {
    evidence.push(`${prefix}: probe error ${/** @type {Error} */ (e).message}`);
    return false;
  } finally {
    for (const fd of fds) fsSync.closeSync(fd);
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 平台路径安全能力（进程级缓存；`force=true` 供测试重探）。
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<PathSafetyCapability>}
 */
export async function pathSafetyCapability(opts = {}) {
  if (cachedCapability !== null && opts.force !== true) return cachedCapability;
  const platform = process.platform;
  /** @type {string[]} */
  const evidence = [];
  if (platform === "win32") {
    evidence.push("win32: no fd namespace and no openat in node - shares unsupported (explicit degradation)");
    cachedCapability = { platform, mode: "unsupported", prefix: null, evidence };
    return cachedCapability;
  }
  for (const prefix of candidatePrefixes(platform)) {
    if (await probePrefixPinned(prefix, evidence)) {
      cachedCapability = { platform, mode: "fd-chain", prefix, evidence };
      return cachedCapability;
    }
  }
  evidence.push(
    "no fd-pinned traversal primitive available; falling back to verified-walk " +
      "(frozen root fd + per-component O_DIRECTORY|O_NOFOLLOW opens + identity re-verification + serialized wire ops); " +
      "wire-peer races are excluded by construction; local-owner races are outside the claim (documented degradation)",
  );
  cachedCapability = { platform, mode: "verified-walk", prefix: null, evidence };
  return cachedCapability;
}

/** 测试钩子：重置能力缓存。 */
export function resetCapabilityCacheForTest() {
  cachedCapability = null;
}
