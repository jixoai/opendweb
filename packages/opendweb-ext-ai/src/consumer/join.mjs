// adapted from ai-fly src/consumer/join.ts (v0.6.0) —— 消费方入口：aifly1. 组合
// 信封解码 + 入环（tasks B3）。与上游的有意分歧（design §0 consumer 行）：
// - fabric 兑换/身份归位不在此层——宿主注入面（构造时接收 {fetchImpl} 形状的
//   注入；真 fabric 接线是 Phase C 宿主装配，Phase B 用注入面测）。本层职责=
//   信封解码（schema 自带、车道隔离）+ 钥环合并落盘。
// - 密钥语法保持 ai-fly（征询①采纳）：sk-aifly- / aifly1. / dweb1.。

import { z } from "zod";
import { decodeZ32 } from "../provider/z32.mjs";

export const SHARE_LINK_PREFIX = "aifly1.";
export const KEY_PREFIX = "sk-aifly-";
export const INVITE_PREFIX = "dweb1.";

/** base64url 字符集（解码前先做形态校验，拒绝 Buffer 宽容解析）。 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** 信封载荷 schema（与 provider ServiceEntry 面共享字段集——车道隔离不 import）。 */
export const LINK_PAYLOAD_SCHEMA = z.strictObject({
  v: z.literal(1),
  invite: z.string().refine((s) => s.startsWith(INVITE_PREFIX) && s.length > INVITE_PREFIX.length, {
    message: `invite must be a '${INVITE_PREFIX}' token`,
  }),
  key: z.string().refine((s) => s.startsWith(KEY_PREFIX) && s.length > KEY_PREFIX.length, {
    message: `key must be a '${KEY_PREFIX}' secret`,
  }),
  keyId: z.string().min(1).max(128),
  provider: z.strictObject({
    alias: z.string().min(1).max(256),
    endpointId: z.string().min(8).max(128),
    relayUrls: z.array(z.string().min(1).max(2048)),
  }),
  group: z.string().min(1).max(256),
  services: z.array(z.unknown()).max(256),
});

/** 信封解码错误（用户面文案；英文 ASCII 保持仓库错误风格）。 */
export class JoinError extends Error {
  constructor(message) {
    super(message);
    this.name = "JoinError";
  }
}

/**
 * 解码 aifly1.<base64url(payload JSON)>（零网络零副作用）。
 * @param {string} link
 */
export function decodeShareLink(link) {
  if (typeof link !== "string" || !link.startsWith(SHARE_LINK_PREFIX)) {
    throw new JoinError(`not an ai share link (expected '${SHARE_LINK_PREFIX}<base64url>)`);
  }
  const body = link.slice(SHARE_LINK_PREFIX.length);
  if (body.length === 0 || !BASE64URL_RE.test(body)) {
    throw new JoinError("share link payload is not valid base64url");
  }
  let json;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new JoinError("share link payload is not valid JSON");
  }
  const parsed = LINK_PAYLOAD_SCHEMA.safeParse(json);
  if (!parsed.success) {
    // payload 不合当前 schema（旧格式）→ 明确报过期（无迁移路径）
    throw new JoinError("this share link uses an outdated format - ask the provider to generate a new one");
  }
  return parsed.data;
}

/** --preview 摘要（纯文本；零网络；不回显密钥原文——仅长度指纹）。 */
export function formatLinkPreview(payload) {
  const lines = [];
  lines.push(`provider : ${payload.provider.alias} (${payload.provider.endpointId})`);
  lines.push(`group    : ${payload.group}`);
  lines.push(`key id   : ${payload.keyId}`);
  lines.push(`key      : ${KEY_PREFIX}*** (${payload.key.length} chars, never displayed)`);
  lines.push(`relay    : ${payload.provider.relayUrls.length > 0 ? payload.provider.relayUrls.join(", ") : "(host-injected)"}`);
  lines.push(`services :`);
  const services = /** @type {Array<Record<string, any>>} */ (payload.services);
  for (const s of services) {
    lines.push(`  - ${s.name}  [${s.serviceId}]  default port ${s.defaultPort}`);
  }
  lines.push(`note: this link embeds a secret key - treat it like a password`);
  return lines;
}

/**
 * 裸密钥格式校验：sk-aifly-<z32(32B)>（z32 严格解码拒绝非规范形）。
 * @param {string} key
 */
export function assertKeyFormat(key) {
  if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) {
    throw new JoinError(`not an ai key (expected '${KEY_PREFIX}<z32>)`);
  }
  const body = key.slice(KEY_PREFIX.length);
  try {
    const bytes = decodeZ32(body);
    if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  } catch (err) {
    throw new JoinError(`invalid key format: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 导入 aifly1. 链接（fabric=宿主注入面：{fetchImpl} 形状——Phase C 真接线；
 * Phase B 仅校验形状不触网。兑换/身份归位由宿主在 fabric 面完成）。
 * @param {string} link
 * @param {{ keyring: Awaited<ReturnType<import("./keyring.mjs").openKeyring>>, fabric?: { fetchImpl: (init: any) => Promise<any> } }} opts
 * @returns {Promise<{ payload: z.infer<typeof LINK_PAYLOAD_SCHEMA> }>}
 */
export async function importLink(link, opts) {
  const payload = decodeShareLink(link);
  assertKeyFormat(payload.key);
  if (opts.fabric !== undefined && typeof opts.fabric.fetchImpl !== "function") {
    throw new JoinError("fabric injection face must be {fetchImpl} (host-assembled in Phase C)");
  }
  opts.keyring.upsertProvider(
    { endpointId: payload.provider.endpointId, alias: payload.provider.alias, relayUrls: payload.provider.relayUrls },
    { keyId: payload.keyId, key: payload.key, group: payload.group },
    /** @type {Array<Record<string, any>>} */ (payload.services),
  );
  await opts.keyring.save();
  return { payload };
}

/**
 * 裸密钥入环（定位已导入提供者；keyId/group 由下次 AUTH_OK 回填——ai-fly 同拍）。
 * @param {string} key
 * @param {string} providerRef endpointId / 8 字符前缀 / 别名
 * @param {Awaited<ReturnType<import("./keyring.mjs").openKeyring>>} keyring
 */
export async function addKey(key, providerRef, keyring) {
  assertKeyFormat(key);
  const provider = keyring.findProvider(providerRef);
  if (provider === undefined) {
    throw new JoinError(`provider '${providerRef}' is not imported on this machine - import a share link first (a bare key carries no network info)`);
  }
  const existing = provider.keys.find((k) => k.key === key);
  if (existing === undefined) provider.keys.push({ keyId: "", key, group: "" });
  await keyring.save();
  return { added: existing === undefined, provider };
}
