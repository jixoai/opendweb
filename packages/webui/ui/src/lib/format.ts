// 时间呈现纯函数（自 ui/views.mjs 原样移植；§5.1/§7.3：无 ISO 8601 原文）。

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 毫秒时间戳 → 本地时间 YYYY-MM-DD HH:mm:ss。 */
export function fmtLocal(ts: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 毫秒时间戳 → 本地时钟 HH:mm:ss（轮询失败时刻等轻量呈现）。 */
export function fmtClock(ts: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 相对时间（刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前）。now 可注入（测试面）。 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 时间通则：本地时间 + 相对时间。 */
export function formatTime(ts: number, now: number = Date.now()): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  return `${fmtLocal(ts)}（${relativeTime(ts, now)}）`;
}

/** 毫秒时间戳 → 本地日期 YYYY-MM-DD（到期日等纯日期呈现）。 */
export function fmtDate(ts: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 租期状态（server-access-roles 流 C）：permanent / active / expiring(≤7 天) / expired。
 * 到期边界冻结：now >= expires_at 即过期（等值=过期）。 */
export interface LeaseState {
  state: "permanent" | "active" | "expiring" | "expired";
  daysLeft: number | null;
  label: string;
}

export function leaseState(expiresAt: number | null | undefined, now: number = Date.now()): LeaseState {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return { state: "permanent", daysLeft: null, label: "租期中 · 长期" };
  }
  // 台账 wire 上「永久」以 2100 年哨兵时间戳承载（server 端 null 投影）——
  // 按长期呈现，绝不说「剩 26754 天」
  if (expiresAt >= 4_102_444_800_000) {
    return { state: "permanent", daysLeft: null, label: "租期中 · 长期" };
  }
  if (now >= expiresAt) return { state: "expired", daysLeft: 0, label: "已到期" };
  const daysLeft = Math.max(1, Math.ceil((expiresAt - now) / 86_400_000));
  if (daysLeft <= 7) return { state: "expiring", daysLeft, label: `临期 · 剩 ${daysLeft} 天` };
  return { state: "active", daysLeft, label: `租期中 · 剩 ${daysLeft} 天` };
}

/** 邀请码展示分组：`dwebc1.` 前缀 + 本体每 4 字符一组（4-4-4-4；只对 dwebc1. 形态重组，其他字符串原样）。 */
export function groupInviteCode(code: string | null | undefined): string {
  const raw = String(code ?? "");
  const m = /^(dwebc1\.)([0-9A-Za-z-]+)$/.exec(raw);
  if (m === null) return raw;
  const body = m[2].replace(/-/g, "").replace(/(.{4})(?=.)/g, "$1-");
  return `${m[1]}${body}`;
}
