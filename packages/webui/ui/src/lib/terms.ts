// 术语投影纯函数。
// 术语迁移（server-access-roles PM §1.5/§5.1）：呈现层「所有者」→「租户」
// （工程字段 owner/owners/registry 不动）；「访客」= visitor；「包租婆」仅
// 教育性引导文案，不进操作文案（v1 §8.3 纪律延续：不用「管理员/管理者」
// 指代使用者，admin token 一律「管理凭证」）。

/** 回执 op → 中文动词（title 保留原始 op 值——契约字段不丢）。0x04-0x0C 为三角色增量。 */
export const OP_LABEL: Record<string, string> = {
  register: "注册",
  unregister: "注销",
  disconnect: "断开",
  renew: "续期",
  "visitor-grant": "添加访客",
  "visitor-revoke": "移出访客",
  "code-issue": "签发邀请码",
  "code-revoke": "吊销邀请码",
  "block-add": "拉黑",
  "block-remove": "移出黑名单",
  "knock-dismiss": "忽略敲门",
  "knock-undismiss": "恢复待办",
};

export interface ModeBadge {
  label: string;
  title: string;
}

/** mode → 徽章投影（受限模式/开放模式）；悬停给出安全姿态解释（三角色话术）。 */
export function modeBadge(mode: string | null | undefined): ModeBadge | null {
  if (mode === "restricted") {
    return { label: "受限模式", title: "租户与访客可进，陌生人敲门待放行" };
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

/**
 * 敲门原因 → 管理者侧呈现（PM §4.1 呈现映射；客户端侧话术在 SDK 文档面）。
 * 无票且不在名册 →「陌生设备，无通行票」；票无效/过期 →「通行票无效」；
 * 租户到期 →「所属租户租期已到」。
 */
export function knockReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "dweb/no-capability":
      return "陌生设备，无通行票";
    case "dweb/unknown-owner":
      return "通行票无效";
    case "dweb/owner-expired":
      return "所属租户租期已到";
    case "dweb/visitor-quota-exceeded":
      return "访客连接数已达上限";
    default:
      return typeof reason === "string" && reason !== "" ? reason : "-";
  }
}

/** 邀请码状态（待使用/已用尽/已过期/已吊销；吊销优先，其次过期，最后耗尽）。 */
export type CodeStatus = "available" | "exhausted" | "expired" | "revoked";

export function codeStatus(
  entry: { used_count?: number; max_uses?: number; expires_at?: number | null; revoked?: boolean },
  now: number = Date.now(),
): { status: CodeStatus; label: string } {
  if (entry.revoked === true) return { status: "revoked", label: "已吊销" };
  if (typeof entry.expires_at === "number" && now >= entry.expires_at) {
    return { status: "expired", label: "已过期" };
  }
  const used = Number(entry.used_count ?? 0);
  const max = Number(entry.max_uses ?? 1);
  if (used >= max) return { status: "exhausted", label: "已用尽" };
  return { status: "available", label: "待使用" };
}

/**
 * 同 fabric 多 root 集合（钓鱼警示标记源——fabric_id 是自声明标签，身份键
 * = 二元组 (fabric, root)；同 fabric 多 root 合法并存但须警示核对缩写）。
 */
export function multiRootFabrics(owners: { fabric_id: string; root: string }[]): Set<string> {
  const count = new Map<string, number>();
  for (const o of owners) count.set(o.fabric_id, (count.get(o.fabric_id) ?? 0) + 1);
  return new Set([...count.entries()].filter(([, n]) => n > 1).map(([f]) => f));
}

/** 黑名单维度 → 中文（端点 / Fabric）。 */
export function blockKindLabel(kind: string | null | undefined): string {
  if (kind === "endpoint") return "端点";
  if (kind === "fabric") return "Fabric";
  return typeof kind === "string" && kind !== "" ? kind : "-";
}

/** 节点地址掩码（与 sidecar maskTarget 同规则：IPv4 掩末段、域名掩首标签、IPv6 全掩、默认端口省略）。 */
export function maskNodeUrl(serverHost: string | null | undefined): string {
  const raw = typeof serverHost === "string" ? serverHost : "";
  if (raw === "") return "-";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const scheme = url.protocol === "https:" ? "https" : "http";
  let host = url.hostname.toLowerCase();
  const bracketed = host.startsWith("[") && host.endsWith("]");
  if (bracketed) host = host.slice(1, -1);
  let masked: string;
  if (host.includes(":")) masked = "[***]";
  else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) masked = `${host.split(".").slice(0, 3).join(".")}.***`;
  else {
    const labels = host.split(".");
    masked = labels.length >= 2 ? `***.${labels.slice(1).join(".")}` : "***";
  }
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${scheme}://${masked}${port}`;
}
