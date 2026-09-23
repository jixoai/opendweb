// 节点簿本地存储（server-access-roles design §3.4 / specs/webui「节点簿与节点切换」）。
// 意图（2026-09-23，server-access-roles Phase 2b）：
// 1. `~/.opendweb/nodes.json`（0600）是 webui-console「token MUST NOT 写入任何
//    文件」的唯一**版本化例外**落点（单用户工作站威胁模型；帮助文本披露
//    OS 可见性）——条目 {id, name, server_host, token, added_at}；
// 2. 写入纪律：同目录临时文件（O_EXCL + 0600 + fsync）→ 原子 rename；
//    **拒绝 symlink 跟随**（读/写两侧 lstat 先拒）；
// 3. token 只存在于本文件与 sidecar 进程内存——对外投影一律经 publicNode()
//    （{id,name,server_host,added_at,current}，永不含 token）。
// 零运行时依赖（node 标准库）；损坏文件 = 硬错误（照 owners 台账 fail-fast 纪律）。

import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** 存储文件格式版本（结构变更时递增） */
export const NODES_FILE_VERSION = 1;

/** 节点簿存储硬错误（symlink / 损坏 / 非法条目——启动即抛） */
export class NodeStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "NodeStoreError";
  }
}

/**
 * 节点条目存储形态校验（load 时逐条断言；坏文件整体拒载）。
 * @param {unknown} e
 * @returns {e is { id: string, name: string, server_host: string, token: string, added_at: number }}
 */
function validEntry(e) {
  return (
    e !== null &&
    typeof e === "object" &&
    !Array.isArray(e) &&
    typeof e.id === "string" &&
    e.id !== "" &&
    typeof e.name === "string" &&
    typeof e.server_host === "string" &&
    e.server_host !== "" &&
    typeof e.token === "string" &&
    e.token !== "" &&
    typeof e.added_at === "number" &&
    Number.isFinite(e.added_at)
  );
}

/** lstat 拒 symlink（读与写共用；不存在 = 无事）。 */
async function assertNotSymlink(file) {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    if (e !== null && typeof e === "object" && /** @type {any} */ (e).code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) throw new NodeStoreError(`refusing to follow symlink nodes file: ${file}`);
}

export class NodeStore {
  /**
   * @param {string} file nodes.json 绝对路径
   */
  constructor(file) {
    this.file = file;
    /** @type {Array<{ id: string, name: string, server_host: string, token: string, added_at: number }>} */
    this.nodes = [];
  }

  /** 变更串行化尾链（r8-P2-1/P1-2 共用的事务边界：add/remove 互斥完成「候选构造→落盘→内存替换」） */
  #tail = Promise.resolve();

  /** 启动加载（文件缺失 = 空簿；symlink/损坏 JSON/坏条目 = 硬错误）。 */
  async load() {
    await assertNotSymlink(this.file);
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if (e !== null && typeof e === "object" && /** @type {any} */ (e).code === "ENOENT") {
        this.nodes = [];
        return;
      }
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new NodeStoreError(`nodes file is not valid JSON: ${this.file}`);
    }
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(/** @type {any} */ (parsed).nodes)) {
      throw new NodeStoreError(`nodes file malformed (missing nodes array): ${this.file}`);
    }
    const nodes = /** @type {any} */ (parsed).nodes;
    for (const n of nodes) {
      if (!validEntry(n)) throw new NodeStoreError(`nodes file contains a malformed entry: ${this.file}`);
    }
    this.nodes = nodes;
  }

  /**
   * 原子落盘：临时文件（0600 + O_EXCL + fsync）→ rename 覆盖。
   * 失败时清理临时文件；rename 之前既有 nodes.json 若为 symlink 已被拒绝。
   * @param {Array<{ id: string, name: string, server_host: string, token: string, added_at: number }>} nodes
   *   待持久化的候选数组（事务语义：先落盘成功、后替换内存——r8-P2-1）。
   */
  async #save(nodes) {
    await assertNotSymlink(this.file);
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      dir,
      `.${path.basename(this.file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    const payload = `${JSON.stringify({ version: NODES_FILE_VERSION, nodes }, null, 2)}\n`;
    try {
      const fh = await open(tmp, "wx", 0o600);
      try {
        await fh.writeFile(payload, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await chmod(tmp, 0o600); // 显式 0600（部分平台 open mode 受 umask 影响）
      await rename(tmp, this.file);
    } catch (e) {
      await unlink(tmp).catch(() => {}); // 临时文件不留残骸
      throw e;
    }
  }

  /** @param {string} id */
  get(id) {
    return this.nodes.find((n) => n.id === id) ?? null;
  }

  /**
   * 变更互斥段（r8-P2-1）：同一时刻至多一个 add/remove 在「候选构造→#save→
   * 内存替换」全程内——并发变更不交错覆盖彼此的落盘结果；任一失败不影响
   * 后续变更继续。
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  #mutate(fn) {
    const run = this.#tail.then(fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 追加节点并落盘（事务语义：候选数组构造 → #save 成功 → 才替换内存；
   * 落盘失败时内存与磁盘均不变，异常上抛）。
   * @param {{ name?: string, server_host: string, token: string, added_at: number, id?: string }} input
   */
  add(input) {
    return this.#mutate(async () => {
      const entry = {
        id: input.id ?? randomBytes(8).toString("hex"),
        name: String(input.name ?? ""),
        server_host: String(input.server_host),
        token: String(input.token),
        added_at: input.added_at,
      };
      if (!validEntry(entry)) throw new NodeStoreError("node entry invalid");
      const candidates = [...this.nodes, entry];
      await this.#save(candidates);
      this.nodes = candidates;
      return entry;
    });
  }

  /** @param {string} id */
  remove(id) {
    return this.#mutate(async () => {
      const i = this.nodes.findIndex((n) => n.id === id);
      if (i === -1) return null;
      const removed = this.nodes[i];
      const candidates = this.nodes.filter((_, j) => j !== i);
      await this.#save(candidates);
      this.nodes = candidates;
      return removed;
    });
  }
}

/**
 * 节点对外投影（HTTP 响应/日志唯一允许形态——零 token）。
 * @param {{ id: string, name: string, server_host: string, added_at: number }} entry
 * @param {boolean} current
 */
export function publicNode(entry, current) {
  return { id: entry.id, name: entry.name, server_host: entry.server_host, added_at: entry.added_at, current: current === true };
}
