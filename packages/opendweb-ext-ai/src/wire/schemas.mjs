// adapted from ai-fly src/wire/frames.ts (v0.6.0)
// wire 静态定义层：稳定错误码全集、头部策略（凭据类拒绝/响应头白名单）、结构
// 上限与各载荷 schema。本包只保留 header framing ABI（design §3）所需子集：
// 帧类型号/WS 帧族不移植（帧协议已在上游退役；本 ABI 为 HTTP header framing）。
// 纯数据与校验：无 IO、无编码、无会话状态。

import { z } from "zod";
import { AUTH_MAX_KEYS } from "./constants.mjs";

// ---------------------------------------------------------------------------
// 稳定错误码（spec「中止与错误语义」全集——ai-fly 同拍）
// ---------------------------------------------------------------------------

export const ERROR_CODE = {
  aborted: "aborted",
  buffer_overflow: "buffer_overflow",
  idle_timeout: "idle_timeout",
  unauthorized: "unauthorized",
  key_all_invalid: "key_all_invalid",
  unknown_service: "unknown_service",
  path_not_offered: "path_not_offered",
  hook_failed: "hook_failed",
  upstream_unreachable: "upstream_unreachable",
  upstream_status: "upstream_status",
  secret_missing: "secret_missing",
  body_too_large: "body_too_large",
  rate_limited: "rate_limited",
  quota_exceeded: "quota_exceeded",
  forbidden_method: "forbidden_method",
  forbidden_header: "forbidden_header",
  protocol_version: "protocol_version",
  protocol_seq: "protocol_seq",
  protocol_error: "protocol_error",
  internal: "internal",
};

/**
 * 仅 AUTH_OK.rejected 载荷码（不是 ERROR 帧码——key_invalid/key_revoked 不得
 * 加入 ERROR_CODE；三码分立：AUTH 全钥失败=key_all_invalid）。
 */
export const REJECTED_CODE = {
  key_invalid: "key_invalid",
  key_revoked: "key_revoked",
};

// ---------------------------------------------------------------------------
// 结构上限与头部策略（ai-fly 同拍）
// ---------------------------------------------------------------------------

export const STRUCT_LIMITS = {
  pathMaxBytes: 4 * 1024,
  headersMaxCount: 32,
  headerNameMaxBytes: 1024,
  headerValueMaxBytes: 8 * 1024,
};

/** 请求禁止透传的凭据类/归属类头（双向零过桥；消费方入站凭据头协议层剥离）。 */
export const FORBIDDEN_REQ_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-type",
]);

/** 响应元信息白名单头子集。 */
export const RESP_META_HEADER_WHITELIST = new Set(["x-request-id", "retry-after"]);

/** HTTP 方法枚举。 */
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

// ---------------------------------------------------------------------------
// 基础构件
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

/**
 * @param {string} s
 */
function byteLen(s) {
  return TEXT_ENCODER.encode(s).length;
}

// ---------------------------------------------------------------------------
// AUTH 载荷（design §3 端点表：{v:1, keys:[≤8]}）
// ---------------------------------------------------------------------------

export const AUTH_BODY_SCHEMA = z.strictObject({
  v: z.literal(1),
  keys: z.array(z.string().min(8).max(256)).min(1).max(AUTH_MAX_KEYS),
});

/** AUTH_OK 形状（冻结面：{v:1, status:"ok", groups:[...]（≥1）, rejected?}）。 */
export const AUTH_OK_BODY_SCHEMA = z.strictObject({
  v: z.literal(1),
  status: z.literal("ok"),
  groups: z
    .array(
      z.strictObject({
        keyId: z.string().min(1).max(128),
        group: z.string().min(1).max(256),
        limits: z.strictObject({
          maxConcurrency: z.number().int().min(1).optional(),
          dailyRequests: z.number().int().min(1).optional(),
        }),
        services: z.array(z.unknown()),
      }),
    )
    .min(1),
  rejected: z
    .array(z.strictObject({ code: z.enum([REJECTED_CODE.key_invalid, REJECTED_CODE.key_revoked]) }))
    .max(64)
    .optional(),
});

/** AUTH_ERR 形状（{v:1, code:"key_all_invalid"}）。 */
export const AUTH_ERR_BODY_SCHEMA = z.strictObject({
  v: z.literal(1),
  code: z.literal(ERROR_CODE.key_all_invalid),
});

/** cancel 端点载荷（design §3 端点表：{responseId,epoch}）。 */
export const CANCEL_BODY_SCHEMA = z.strictObject({
  responseId: z.string().min(1).max(64),
  epoch: z.string().min(1).max(64),
});

// ---------------------------------------------------------------------------
// 目录载荷（AUTH groups[].services / catalog.catalog.groups[].services 共用）
// ---------------------------------------------------------------------------

export const SERVICE_MATCH_SCHEMA = z.strictObject({
  type: z.enum(["exact", "suffix", "regex"]),
  value: z.string().min(1).max(2048),
});

export const SERVICE_ENTRY_SCHEMA = z.strictObject({
  serviceId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  match: z.array(SERVICE_MATCH_SCHEMA).max(64),
  defaultPort: z.number().int().min(1).max(65535),
  detail: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// catalog 响应（{v:1, refresh:true, catalog:{groups:[...]}, rev}）
// ---------------------------------------------------------------------------

export const CATALOG_BODY_SCHEMA = z.strictObject({
  v: z.literal(1),
  refresh: z.literal(true),
  catalog: z.strictObject({ groups: z.array(z.unknown()).min(0) }),
  rev: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// 请求路径/头描述校验（rewrite 的 schema 前置面——双保险）
// ---------------------------------------------------------------------------

/**
 * 请求 path 形态校验：单个 / 开头、无 scheme、非 // 与 /\ 开头、无 . 与 ..
 * 段（可含查询串）。
 * @param {string} p
 * @returns {string | null} 错误文案（null=合法）
 */
export function requestPathError(p) {
  if (byteLen(p) > STRUCT_LIMITS.pathMaxBytes) return `path exceeds ${STRUCT_LIMITS.pathMaxBytes} bytes`;
  if (!p.startsWith("/")) return "path must start with a single '/'";
  if (p.startsWith("//") || p.startsWith("/\\")) return "path must not start with '//' or '/\\'";
  const pathPart = p.split("?", 1)[0];
  if (pathPart.includes("://")) return "path must not contain a scheme";
  for (const seg of pathPart.split("/").slice(1)) {
    if (seg === "." || seg === "..") return "path must not contain '.' or '..' segments";
  }
  return null;
}

/**
 * 透传头表校验（wire 面注入的上游头白名单条目）。
 * @param {Record<string, string>} headers
 * @returns {string | null}
 */
export function passthroughHeadersError(headers) {
  const names = Object.keys(headers);
  if (names.length > STRUCT_LIMITS.headersMaxCount) {
    return `headers exceed ${STRUCT_LIMITS.headersMaxCount} entries`;
  }
  for (const name of names) {
    const value = headers[name];
    if (FORBIDDEN_REQ_HEADER_NAMES.has(name) || FORBIDDEN_REQ_HEADER_NAMES.has(name.toLowerCase())) {
      return `forbidden header: ${name}`;
    }
    if (name !== name.toLowerCase()) return `header name not lowercase-normalized: ${name}`;
    if (byteLen(name) > STRUCT_LIMITS.headerNameMaxBytes) {
      return `header name exceeds ${STRUCT_LIMITS.headerNameMaxBytes} bytes`;
    }
    if (byteLen(value) > STRUCT_LIMITS.headerValueMaxBytes) {
      return `header value exceeds ${STRUCT_LIMITS.headerValueMaxBytes} bytes`;
    }
  }
  return null;
}
