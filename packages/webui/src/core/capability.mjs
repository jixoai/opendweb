// 会话 capability v1（home-hub [H4] Phase 2a / design §5.1 r3-P2-4 冻结）。
// 意图：urlFor 返回的 URL 可携带的一次性会话凭证——
// 1. ≥128-bit CSPRNG（16 字节 randomBytes → base64url 22 字符；可注入 random）；
// 2. 绑定 sidecar 实例：注册表随实例创建（跨实例的值在本表必然 unknown）；
// 3. 单次消费：consume 成功即标记 used；同值再 consume=reason "replay"（调用
//    方记日志行——值本身不入任何日志）；
// 4. TTL 默认 120s（懒惰过期——consume 时判定；墓碑随 TTL 一并失效）；
// 5. close 即失效：清空注册表并封闭（此后一切 consume=invalid）。
// 定位：一次性会话引导凭证（基线 pairingCode 族的强化）——**非 hub-token /
// admin token**：后者永不入 URL/浏览器可见状态/IPC（spec 冻结边界）。

import { randomBytes } from "node:crypto";

/** 会话 capability 默认有效期（design §5.1：TTL 默认 120s） */
export const CAPABILITY_TTL_MS = 120_000;

/** capability 熵（字节）——≥128-bit CSPRNG 要求的下限即取 16 字节 */
const CAPABILITY_BYTES = 16;

/**
 * 注册表工厂（注入面：ttlMs/now/random 供测试）。
 * @param {{ ttlMs?: number, now?: () => number, random?: (n: number) => Buffer }} [opts]
 * @returns {CapabilityRegistry}
 */
export function createCapabilities(opts = {}) {
  const { ttlMs = CAPABILITY_TTL_MS, now = () => Date.now(), random = randomBytes } = opts;
  if (!(ttlMs > 0)) throw new Error("capability ttl must be positive");
  /** @type {Map<string, { expiresAt: number, used: boolean }>} */
  const registry = new Map();
  let closed = false;

  return {
    /** 签发新 capability（URL-safe base64url；值只进内存与调用方拼装的 URL）。 */
    issue() {
      if (closed) throw new Error("capability registry is closed");
      const value = random(CAPABILITY_BYTES).toString("base64url");
      registry.set(value, { expiresAt: now() + ttlMs, used: false });
      // 顺手清扫已过 TTL 的墓碑（used 条目）——未用条目保留到 consume 判定，
      // 使「过期」与「未知」的失败码稳定可辨（两者均 403，但记录语义不同）
      const t = now();
      for (const [v, e] of registry) {
        if (e.used && t > e.expiresAt) registry.delete(v);
      }
      return value;
    },
    /**
     * 消费判定（单次消费核心）。
     * @param {string} value
     * @returns {{ ok: true } | { ok: false, reason: "invalid" | "replay" | "expired" }}
     *   - invalid：未知值（跨实例/伪造/close 后）或空值
     *   - replay：曾成功消费过的值再次出现
     *   - expired：TTL 已过（含已过期的墓碑）
     */
    consume(value) {
      if (closed || typeof value !== "string" || value === "") return { ok: false, reason: "invalid" };
      const entry = registry.get(value);
      if (entry === undefined) return { ok: false, reason: "invalid" };
      if (now() > entry.expiresAt) {
        registry.delete(value); // 过期即出表（此后同值=未知——均 403）
        return { ok: false, reason: "expired" };
      }
      if (entry.used) return { ok: false, reason: "replay" };
      entry.used = true; // 单次消费：留墓碑到 TTL 失效（重放可判定）
      return { ok: true };
    },
    /** close 即失效（sidecar close/进程退出路径调用；此后签发与消费均失败）。 */
    close() {
      closed = true;
      registry.clear();
    },
    /** 测试/诊断面：窗口内条目数（含墓碑；不含值）。 */
    get size() {
      return registry.size;
    },
  };
}

/**
 * @typedef {Object} CapabilityRegistry
 * @property {() => string} issue
 * @property {(value: string) => { ok: true } | { ok: false, reason: "invalid" | "replay" | "expired" }} consume
 * @property {() => void} close
 * @property {number} size
 */
