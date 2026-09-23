// 三视角成员面纯函数（home-hub Phase 2b / specs/webui「三视角控制台」）。
// 我的租约/我的到访两视角的文案投影与判定——框架无关（无 Svelte 导入），
// node --test 直测；组件只做渲染与状态绑定。
// 术语纪律：两视角零 admin 概念（「管中枢的人/网络的主人」是用户词）。

import { leaseState } from "./format.ts";

/** label 字节上限（与服务端 home.mjs LABEL_MAX_BYTES 同源冻结：≤64 UTF-8 字节）。 */
export const LABEL_MAX_BYTES = 64;

/** UTF-8 字节长度（label 校验唯一实现）。 */
export function labelByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** label 行内编辑实时校验：超 64 字节 → 报错文案；否则 null。 */
export function labelEditError(value: string): string | null {
  const n = labelByteLength(value.trim());
  if (n <= LABEL_MAX_BYTES) return null;
  return `备注名最长 ${LABEL_MAX_BYTES} 字节（当前 ${n} 字节）——一个汉字约占 3 字节，请缩短。`;
}

/** label 编辑提交裁决：error（超长不发请求）/ cancel（无变化收起）/ save。 */
export type LabelEditDecision =
  | { action: "error"; message: string }
  | { action: "cancel" }
  | { action: "save"; value: string };

/** 提交语义：空串=清除——客户端先行归一为 save+null（body {label:null}）。 */
export function labelEditSubmit(raw: string, prev: string | null): LabelEditDecision {
  const value = raw.trim();
  const err = labelEditError(value);
  if (err !== null) return { action: "error", message: err };
  const trimmedPrev = typeof prev === "string" ? prev.trim() : "";
  if (value === trimmedPrev) return { action: "cancel" };
  return { action: "save", value };
}

/**
 * 在线链路标注（G-3 口径）：link==="direct" →「直连中」；"relay" →「借道中」；
 * 其余（缺失/未知值）→ null 不标。当前服务端 connections wire 无 link 字段——
 * 缺失即不标（如实实现，服务端补字段后零改动生效）。
 */
export function linkLabel(link: string | null | undefined): { label: string; title: string } | null {
  if (link === "direct") {
    return { label: "直连中", title: "设备间点对点直连，不经过中枢——停中枢不影响互传" };
  }
  if (link === "relay") {
    return { label: "借道中", title: "正经中枢中转兜底——中枢回来自动恢复直连" };
  }
  return null;
}

/**
 * 租约条目的呈现状态（本地快照语义；leaseState 同款边界：now >= expires_at
 * 即过期）。permanent（无 expires）沿用「在租 · 永久」。
 */
export function leaseRowState(expiresAt: number | null | undefined, now: number = Date.now()) {
  return leaseState(typeof expiresAt === "number" ? expiresAt : null, now);
}

/** 临期黄条文案（PM §4.5 逐字；days=剩余天数、date=到期日本地呈现）。 */
export function expiringBannerCopy(days: number, date: string): { headline: string; body: string } {
  return {
    headline: `你的租约还剩 ${days} 天。（本地快照）`,
    body: `这台服务器的租期到 ${date}。续期由管中枢的人完成：请他续期，或向他要一张新邀请码后重新加入——同设备同网络，门牌不变。若管理者已为你续期，这里会在你下次持新码加入时刷新；能否连上以实际连接为准。`,
  };
}

/** 已到期红标文案（PM §4.5 逐字；date=到期日本地呈现）。 */
export function expiredBadgeCopy(date: string): { headline: string; body: string } {
  return {
    headline: `租约已到期（${date}）。新连接正被拒绝。`,
    body: `要一张新邀请码，然后重新加入`,
  };
}

/** 新码重进命令（PM §4.5 逐字形态）。 */
export function rejoinCommand(server: string): string {
  return `opendweb join --server ${server} --code <新码>`;
}

/** 探测结果文案：可连通 / 连不上（「连不上≠被拒」话术，PM §3.4 逐字）。 */
export function probeResultCopy(result: "reachable" | "unreachable"): string {
  return result === "reachable"
    ? "可连通"
    : "连不上。通常是那台服务器没开机，不代表你被拒——被拒会有明确提示。";
}

/** 探测明细 → 简短原因（title 提示用；映射五类）。 */
export function probeDetailCopy(detail: string | null | undefined): string | null {
  if (typeof detail !== "string" || detail === "") return null;
  if (detail.startsWith("http-status:")) return `服务器应答了 ${detail.slice("http-status:".length)}，但不是正常状态`;
  if (detail === "timeout") return "5 秒内没有应答";
  if (detail === "dns") return "地址解析失败（地址可能变了）";
  if (detail === "bad-body") return "服务器应答了，但内容无法识别";
  if (detail === "conn-refused") return "连接被拒绝（服务未在监听）";
  return detail;
}

/** 续期指引（双路径文案；行内展开用——与临期黄条同源，PM §4.5）。 */
export const RENEW_GUIDE =
  "续期由管中枢的人完成：请他续期，或向他要一张新邀请码后重新加入——同设备同网络，门牌不变。";
