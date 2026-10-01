// adapted from ai-fly src/provider/limits.ts (v0.6.0)
// 分组级限额执行与用量记录：
// - maxConcurrency：分组在途计数（拨号前检查，超限 rate_limited）；
// - dailyRequests：按 keyId 的日请求数（UTC 日界重置，quota-day.json 0600
//   原子持久化，重启不丢，超限 quota_exceeded）；
// - usage.jsonl：显式启用时追加，仅元数据（ts/keyId/serviceId/status/bytes），
//   MUST NOT 记录正文与凭证。
// 与上游的有意分歧：持久化换 atomicWrite0600（async）——acquire/release 变
// async；时序语义照搬（JS 单线程，检查+占用之间无并发窗口）。

import { appendFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWrite0600 } from "../fsutil.mjs";
import { ensurePrivateDir } from "./store.mjs";

/** 超限结果码（wire 429 族）。 */
export const LIMIT_REJECT_CODES = ["rate_limited", "quota_exceeded"];

const QUOTA_DAY_SCHEMA = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counts: z.record(z.string(), z.number().int().min(0)),
});

/**
 * 用量元数据记录（无正文、无凭证）。
 * @typedef {Object} UsageRecord
 * @property {number} ts
 * @property {string} keyId
 * @property {string} serviceId
 * @property {number | string} status HTTP status（number）或终结错误码（string）
 * @property {number} bytes
 */

export class LimitEnforcer {
  /**
   * @param {{ dataDir: string, now?: () => Date }} opts
   */
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? (() => new Date());
    /** @type {Map<string, {maxConcurrency?: number, dailyRequests?: number}>} */
    this.limitsByGroup = new Map();
    this.inflight = new Map();
    this.quotaDate = "";
    this.quotaCounts = new Map();
    this.quotaLoadedPromise = null;
  }

  /** @param {string} dataDir */
  static quotaFilePath(dataDir) {
    return join(dataDir, "quota-day.json");
  }

  /** 引擎在 store（重）加载后同步分组限额配置（整体替换）。 */
  syncFromStore(store) {
    this.limitsByGroup = new Map(store.listGroups().map((g) => [g.name, g.limits ? { ...g.limits } : {}]));
  }

  /**
   * @param {string} group
   * @param {{maxConcurrency?: number, dailyRequests?: number}} limits
   */
  setGroupLimits(group, limits) {
    this.limitsByGroup.set(group, { ...limits });
  }

  /**
   * 拨号前检查+占用（原子）：并发按分组计，日限按 keyId 计。
   * @param {string} keyId
   * @param {string} group
   * @returns {Promise<{ ok: true } | { ok: false, code: "rate_limited" | "quota_exceeded" }>}
   */
  async acquire(keyId, group) {
    const limits = this.limitsByGroup.get(group) ?? {};
    const current = this.inflight.get(group) ?? 0;
    if (limits.maxConcurrency !== undefined && current >= limits.maxConcurrency) {
      return { ok: false, code: "rate_limited" };
    }
    await this.ensureQuotaLoaded();
    const used = this.quotaCounts.get(keyId) ?? 0;
    if (limits.dailyRequests !== undefined && used >= limits.dailyRequests) {
      return { ok: false, code: "quota_exceeded" };
    }
    this.inflight.set(group, current + 1);
    this.quotaCounts.set(keyId, used + 1);
    await this.persistQuota();
    return { ok: true };
  }

  /** 请求终结时释放并发占用（幂等保护：下限 0）。 */
  release(group) {
    const current = this.inflight.get(group) ?? 0;
    this.inflight.set(group, Math.max(0, current - 1));
  }

  /** @param {string} group */
  inflightCount(group) {
    return this.inflight.get(group) ?? 0;
  }

  /** @param {string} keyId */
  async dailyCount(keyId) {
    await this.ensureQuotaLoaded();
    return this.quotaCounts.get(keyId) ?? 0;
  }

  today() {
    return this.now().toISOString().slice(0, 10);
  }

  /** 加载/日界重置（懒加载：首次 acquire 或查询时；损坏视同空表不阻塞）。 */
  async ensureQuotaLoaded() {
    const today = this.today();
    if (this.quotaDate === today) return;
    let counts = new Map();
    const path = LimitEnforcer.quotaFilePath(this.dataDir);
    if (existsSync(path)) {
      try {
        const parsed = QUOTA_DAY_SCHEMA.parse(JSON.parse(readFileSync(path, "utf8")));
        if (parsed.date === today) {
          counts = new Map(Object.entries(parsed.counts));
        }
        // 日期不符 → 日界重置（旧文件被今天的首写覆盖）。
      } catch {
        /* 损坏视同空表（不阻塞服务；下次写入覆盖修复） */
      }
    }
    this.quotaDate = today;
    this.quotaCounts = counts;
  }

  async persistQuota() {
    const payload = { date: this.quotaDate, counts: Object.fromEntries(this.quotaCounts) };
    await atomicWrite0600(LimitEnforcer.quotaFilePath(this.dataDir), `${JSON.stringify(payload, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// 用量日志（仅元数据；usageLog 默认关闭、显式启用——requirements 配额 requirement）
// ---------------------------------------------------------------------------

export class UsageLog {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.path = join(dataDir, "usage.jsonl");
    this.dirReady = false;
  }

  /** @param {UsageRecord} record */
  async append(record) {
    if (!this.dirReady) {
      await ensurePrivateDir(dirname(this.path));
      this.dirReady = true;
    }
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "a" });
  }

  pathOf() {
    return this.path;
  }
}
