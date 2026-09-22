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
