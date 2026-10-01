// adapted from ai-fly src/provider/engine.ts (v0.6.0) —— engine 三拆之 accept
// （design §0）。Phase A 形态：peer/op 准入的纯判定面（统一 404 纪律）。
// Phase C 挂 wpk 面（fabric.mjs createWpkRouter routes.ai = 本 handler——宿主
// 内核 wpk router 语义不改：unknown-plugin 404 / plugin-disabled 503 在内核层）。
//
// ai handler 内部统一 404 纪律（design §2 冻结）：
// - peer 未授权 / op 未授权 / 未知子路径 → 一律 404 {error:"not_found"}
//   byte 级同体、不解析 key；
// - path_not_offered 仅 gate+key 双过后可出现（forward/rewrite 层产出）。

import { AI_OPS, AI_WIRE_PREFIX, notFoundResponse } from "../wire/constants.mjs";

/**
 * wire 路径解析：`/wpk1/ai/v1/<op>`（+ 可选尾段，response/<rid> 归 op=response）。
 * @param {string} requestPath（含查询串的原始 path）
 * @returns {{ op: string } | null} null=未知子路径（404 同体）
 */
export function parseWirePath(requestPath) {
  const bare = requestPath.split("?", 2)[0];
  if (bare === AI_WIRE_PREFIX) return null; // 无 op 段
  if (!bare.startsWith(`${AI_WIRE_PREFIX}/`)) return null;
  const rest = bare.slice(AI_WIRE_PREFIX.length + 1);
  if (rest === "") return null;
  const segs = rest.split("/");
  const op = segs[0];
  if (!AI_OPS.includes(op)) return null;
  // response 允许 <rid> 尾段；其余 op 不带尾段
  if (op === "response") {
    if (segs.length > 2) return null;
  } else if (segs.length > 1) {
    return null;
  }
  return { op };
}

/**
 * gate op 名（design §3：内核授权粒度 = `ai/v1/<op>`）。
 * @param {string} op
 * @returns {string}
 */
export function opGateName(op) {
  return `ai/v1/${op}`;
}

/**
 * 准入门（可注入 authorize——Phase C 接 op-aware 授权账本；缺省全放行：
 * 应用层密钥（AUTH/keyId）是本插件的准入主体，peer 级 deny 由宿主内核 gate
 * 与注入的 authorize 承担）。authorize 收 gate op 名（`ai/v1/<op>`）。
 * @param {{ authorize?: (peer: string, op: string) => boolean | Promise<boolean> }} [opts]
 */
export function createOpGate(opts = {}) {
  const authorize = opts.authorize ?? (() => true);
  return {
    /**
     * @param {string} peer
     * @param {string} op
     * @returns {Promise<boolean>}
     */
    async allows(peer, op) {
      try {
        return await authorize(peer, op) === true;
      } catch {
        return false; // 授权面异常=deny-by-default
      }
    },
  };
}

export { notFoundResponse };
