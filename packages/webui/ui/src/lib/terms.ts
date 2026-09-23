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
  "owner-meta": "编辑别名",
  "visitor-meta": "编辑别名",
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

/** deny-set 运维投影徽章（Phase 1c；「暂不可兑」四态词风格——非第五态，与四态并列呈现）。 */
export interface CodeDeniedBadge {
  label: string;
  title: string;
}

/**
 * denied=true 的码加「暂不可兑（服务端故障保护）」徽章：补写失败 fail-closed
 * 暂时停兑，恢复后自动解除（与吊销不同——无需重发）。不改变四态机
 * （codeStatus 与本函数正交，denied+待使用是合法并存）。
 */
export function codeDeniedBadge(entry: { denied?: boolean | null }): CodeDeniedBadge | null {
  if (entry.denied !== true) return null;
  return {
    label: "暂不可兑",
    title: "暂不可兑（服务端故障保护）：这台服务器的台账补写出了故障，为防重复兑换暂时停用这张码；故障恢复后自动解除，无需吊销重发。",
  };
}

// ---- 别名行内编辑（PM §4.5 流 E；server-access-roles Phase 1c PATCH 承载面） -----------

/** 别名字节上限（与服务端 roles.rs ALIAS_MAX_BYTES 同源冻结：alias ≤ 32 UTF-8 字节）。 */
export const ALIAS_MAX_BYTES = 32;

/** UTF-8 字节长度（别名校验的唯一实现；一个汉字约占 3 字节）。 */
export function aliasByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 输入实时校验：trim 后超 32 字节 → 报错文案；否则 null（null=可提交）。 */
export function aliasEditError(value: string): string | null {
  const n = aliasByteLength(value.trim());
  if (n <= ALIAS_MAX_BYTES) return null;
  return `别名最长 ${ALIAS_MAX_BYTES} 字节（当前 ${n} 字节）——一个汉字约占 3 字节，请缩短。`;
}

/** 别名编辑提交裁决（纯函数；store 消费，node --test 直测）。 */
export type AliasEditDecision =
  | { action: "error"; message: string }
  | { action: "cancel" }
  | { action: "confirm-clear" }
  | { action: "save"; value: string };

/**
 * 提交语义（PM §4.5 + 1c 契约）：
 * - error：trim 后超 32 字节（不发请求）；
 * - cancel：与编辑前等值（含双方皆空白）——无网络请求，直接收起；
 * - confirm-clear：清空已有别名——先二次确认，确认后 PATCH body `{"alias":""}`（空串=清除）；
 * - save：常规保存（trim 后的新值）。
 */
export function aliasEditSubmit(raw: string, prev: string): AliasEditDecision {
  const value = raw.trim();
  const err = aliasEditError(value);
  if (err !== null) return { action: "error", message: err };
  if (value === prev.trim()) return { action: "cancel" };
  if (value === "") return { action: "confirm-clear" };
  return { action: "save", value };
}

/** 编辑目标的行标识（组件行匹配用：owner = `fabric/root` 二元组，visitor = endpoint_id）。 */
export function aliasTargetKey(target: {
  kind: "owner" | "visitor";
  fabricId?: string;
  root?: string;
  endpointId?: string;
}): string {
  return target.kind === "owner" ? `${target.fabricId ?? ""}/${target.root ?? ""}` : (target.endpointId ?? "");
}

/**
 * 同名警示（PM §4.5 步 3 成品文案；不阻止保存——真身份是缩写）。
 * 输入 trim 后与名册**其他行**（others 须已排除当前编辑行）的别名相同 →
 * 返回警示文案；否则 null。abbr = 当前编辑行自身的缩写（防别名钓鱼：
 * 请核对的是「你正在编辑谁」的缩写）。
 */
export function aliasDuplicateWarning(
  value: string,
  others: (string | null | undefined)[],
  abbr: string,
): string | null {
  const name = value.trim();
  if (name === "") return null;
  const dup = others.some((a) => typeof a === "string" && a.trim() === name);
  if (!dup) return null;
  return `名册里已有同名「${name}」——别名可以重复，身份以缩写为准，请核对 (${abbr})。`;
}

/**
 * 名册行 note 次要文本（PM §3.4 名册对象树：别名与 note 都是名册行元数据）。
 * trim 后为空（含 null/undefined）= null——该行不渲染 note。
 */
export function rosterNote(note: string | null | undefined): string | null {
  const t = typeof note === "string" ? note.trim() : "";
  return t !== "" ? t : null;
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
