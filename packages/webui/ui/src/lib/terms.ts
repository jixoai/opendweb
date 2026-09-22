// 术语投影纯函数（自 ui/views.mjs 原样移植；§5.1 逐处裁决 + §8.3 消歧）。

/** 回执 op → 中文动词（title 保留原始 op 值——契约字段不丢）。 */
export const OP_LABEL: Record<string, string> = { register: "注册", unregister: "注销", disconnect: "断开" };

export interface ModeBadge {
  label: string;
  title: string;
}

/** mode → 徽章投影（受限模式/开放模式）；悬停给出安全姿态解释。 */
export function modeBadge(mode: string | null | undefined): ModeBadge | null {
  if (mode === "restricted") {
    return { label: "受限模式", title: "只有名册内的所有者可以接入" };
  }
  if (mode === "open") {
    return { label: "开放模式", title: "未启用身份验证，任何人都能接入" };
  }
  return null;
}

/** policy → 准入策略投影（静态名册 / 动态回调）。 */
export function policyLabel(policy: string | null | undefined): string {
  if (policy === "static") return "静态名册";
  if (policy === "callback") return "动态回调";
  return typeof policy === "string" && policy !== "" ? policy : "-";
}

/** 断连状态徽章文案（§4.3 C-2：已下发 → 收敛中 → 已收敛 / 超时未确认）。 */
export const DISCONNECT_PHASE_LABEL: Record<string, string> = {
  dispatched: "已下发",
  converging: "收敛中",
  converged: "已收敛",
  unconfirmed: "超时未确认",
};

/** 断连闭环相位（UI 状态机；取值即 DISCONNECT_PHASE_LABEL 的键）。 */
export type DisconnectPhase = "dispatched" | "converging" | "converged" | "unconfirmed";
