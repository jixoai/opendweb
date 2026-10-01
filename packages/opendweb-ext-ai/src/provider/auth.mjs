// adapted from ai-fly src/provider/auth.ts (v0.6.0)
// AUTH 策略（纯逻辑 + 会话表）：多密钥钥环逐一校验 → AUTH_OK 目录视图 /
// AUTH_ERR；撤钥后的会话处置索引。
// 与上游的有意分歧（design §2/§3）：AUTH_OK 形状=wpk1 header framing 冻结面
// `{v:1, status:"ok", groups:[{keyId,group,limits,services}], rejected?}`
// （上游另含 alias/relayUrls——fabric 会合由内核承担，不在载荷中）；
// rejected 仅 code 不带 keyId（有效键集合=groups[].keyId，与输入的对应由此
// 确立——ai-fly frames.ts AUTH_OK 同型）。
// 语义照搬：全无效 → {v:1, code:"key_all_invalid"} 单次即断；重复 AUTH 以
// 最后一次为准；rejected 载荷码仅 key_invalid / key_revoked（≤64）。

import { REJECTED_CODE } from "../wire/schemas.mjs";
import { buildServiceEntry } from "./detail.mjs";

/**
 * 目录数据源（装配层注入；测试可用内存假体）。
 * @typedef {Object} AuthDirectory
 * @property {(key: string) => { status: string, keyId?: string, group?: string }} verifyKey
 * @property {(group: string) => ({ maxConcurrency?: number, dailyRequests?: number } | undefined)} groupLimits
 * @property {(group: string) => Array<import("./store.mjs").ServiceConfig>} groupServices
 */

/**
 * @param {import("./store.mjs").ProviderStore} store
 * @returns {AuthDirectory}
 */
export function authDirectoryFromStore(store) {
  return {
    verifyKey: (key) => store.verifyKey(key),
    groupLimits: (group) => store.getGroup(group)?.limits,
    groupServices: (group) => store.groupServices(group),
  };
}

/**
 * 有效密钥定位（AUTH_OK.groups 的骨架）。
 * @typedef {Object} KeyGrant
 * @property {string} keyId
 * @property {string} group
 */

/**
 * 钥环逐一校验（去重后；rejected 上限 64 对齐 wire schema）。
 * @param {string[]} keys
 * @param {AuthDirectory} dir
 * @returns {{ valid: KeyGrant[], rejected: Array<{ code: "key_invalid" | "key_revoked" }> }}
 */
export function evaluateKeyring(keys, dir) {
  const seen = new Set();
  const valid = [];
  const rejected = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const check = dir.verifyKey(key);
    if (check.status === "valid") {
      valid.push({ keyId: check.keyId, group: check.group });
    } else if (check.status === "revoked") {
      if (rejected.length < 64) rejected.push({ code: REJECTED_CODE.key_revoked });
    } else {
      if (rejected.length < 64) rejected.push({ code: REJECTED_CODE.key_invalid });
    }
  }
  return { valid, rejected };
}

/**
 * 每枚有效密钥 → {keyId, group, limits, services[含 detail]} 视图
 * （design §3 冻结形状）。limits 缺省空对象（schema 允许 maxConcurrency?/
 * dailyRequests? 双缺省）；disabled 服务不进视图（store.groupServices 投影）。
 * @param {KeyGrant[]} valid
 * @param {AuthDirectory} dir
 */
export function buildAuthOk(valid, dir) {
  const groups = valid.map((grant) => {
    const limits = dir.groupLimits(grant.group) ?? {};
    return {
      keyId: grant.keyId,
      group: grant.group,
      limits,
      services: dir.groupServices(grant.group).map((svc) => buildServiceEntry(svc)),
    };
  });
  return { v: 1, status: "ok", groups };
}

/**
 * AUTH 决策（纯）：全无效 → err（调用方回 403 后按断开语义处置）。
 * @param {{ keys: string[] }} header
 * @param {AuthDirectory} dir
 */
export function handleAuthRequest(header, dir) {
  const { valid, rejected } = evaluateKeyring(header.keys, dir);
  if (valid.length === 0) {
    return {
      kind: "err",
      body: { v: 1, code: "key_all_invalid" },
    };
  }
  const ok = buildAuthOk(valid, dir);
  if (rejected.length > 0) ok.rejected = rejected;
  return { kind: "ok", body: ok, valid, keys: [...new Set(header.keys)] };
}

// ---------------------------------------------------------------------------
// 会话表（keyId -> 持钥会话）：撤钥时定位受影响会话（Phase B/C 引擎装配消费）
// ---------------------------------------------------------------------------

/**
 * 持钥会话绑定：keys 为该会话最近一次 AUTH 呈交的钥环原文（仅内存，用于撤钥/
 * 目录变更后重算授权；MUST NOT 进日志）。
 * @typedef {Object} AuthSessionBinding
 * @property {readonly string[]} keys
 * @property {ReadonlySet<string>} keyIds
 * @property {(header: object) => Promise<void>} pushRefresh
 * @property {(reason: string) => void} disconnect
 */

export class KeySessionIndex {
  #byKey = new Map();

  /** 登记/更新会话的 keyId 归属（重复 AUTH 以最后一次为准）。 */
  track(binding) {
    this.untrack(binding);
    for (const keyId of binding.keyIds) {
      let set = this.#byKey.get(keyId);
      if (set === undefined) {
        set = new Set();
        this.#byKey.set(keyId, set);
      }
      set.add(binding);
    }
  }

  untrack(binding) {
    for (const [keyId, set] of this.#byKey) {
      set.delete(binding);
      if (set.size === 0) this.#byKey.delete(keyId);
    }
  }

  /** @param {string} keyId */
  sessionsWithKey(keyId) {
    return [...(this.#byKey.get(keyId) ?? [])];
  }

  size() {
    const total = new Set();
    for (const set of this.#byKey.values()) for (const b of set) total.add(b);
    return total.size;
  }
}
