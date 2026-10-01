// adapted from ai-fly src/wire/http-protocol.ts (v0.6.0)
// ai wire 承载面常量（openspec/changes/ai-subscription-sharing design §3 冻结面
// ——header framing ABI `/wpk1/ai/v1/*`；与 ai-fly `x-aifly-*` 的 wpk1 化重述）。
// 纯常量与小工具：无 IO、无会话状态。
//
// 【与 ai-fly 的命名分歧】常量族改名 `x-odai-*`（上游 `x-aifly-*`）；auth/
// catalog 沿用其形状，request/response/cancel 三端点为本 change 新设的中继面。

/** wire 版本化前缀（dataEndpoints 声明 /wpk1/ai/ 的子面）。 */
export const AI_WIRE_PREFIX = "/wpk1/ai/v1";

/** 端点相对路径（gate op 名 = ai/v1/<op>——内核授权粒度）。 */
export const AI_OPS = ["auth", "catalog", "request", "response", "cancel"];

// ---------------------------------------------------------------------------
// x-odai-* 头族（ai 层元数据全部走头——body=纯载荷字节，无 multipart）
// ---------------------------------------------------------------------------

/** serviceId 唯一来源（body/查询串同名信息=400 拒绝）。 */
export const HDR_SERVICE = "x-odai-service";
/** 上游方法。 */
export const HDR_METHOD = "x-odai-method";
/** 上游路径（含查询串）。 */
export const HDR_PATH = "x-odai-path";
/** 请求绑定 keyId（AUTH 所得 groups[].keyId 之一；quota/usage/撤钥判定按它）。 */
export const HDR_KEY_ID = "x-odai-key-id";
/** 上游头白名单 JSON 数组（≤4KiB）。 */
export const HDR_HEADERS = "x-odai-headers";
/** response 端点：拉取起始 seq（必须 === committedSeq+1）。 */
export const HDR_FROM_SEQ = "x-odai-from-seq";
/** response 端点：本次返回分片 seq。 */
export const HDR_SEQ = "x-odai-seq";
/** response 端点：终态标记（1=终态/摘要）。 */
export const HDR_DONE = "x-odai-done";
/** response 端点：下次合法 fromSeq（204/200 携带）。 */
export const HDR_NEXT_SEQ = "x-odai-next-seq";
/** catalog 端点：当前目录代次（200/204 携带；since 基准）。 */
export const HDR_REV = "x-odai-rev";

/** ai 层元数据头合计预算（超限 400 metadata_too_large）。 */
export const METADATA_HEADER_BUDGET_BYTES = 8 * 1024;

/** x-odai-headers 单头预算（上游头白名单 JSON 数组）。 */
export const PASSTHROUGH_HEADERS_MAX_BYTES = 4 * 1024;

/** 请求体 v1 单片上限（§3.1 推导：1MiB−16KiB——编码后落帧 ≤1MiB 恒成立）。 */
export const MAX_CHUNK_PAYLOAD = 1024 * 1024 - 16 * 1024;

/** AUTH 一次呈交密钥数上限（§3 端点表）。 */
export const AUTH_MAX_KEYS = 8;

/** catalog 长轮询 hold 上限（对齐 ai-fly CATALOG_WATCH_TIMEOUT_MS；严小于内核
 *  head deadline 30s——consumer 侧不要求调大 head timeout）。 */
export const CATALOG_WATCH_TIMEOUT_MS = 20_000;

/** 全量 catalog 服务数上限（工厂期拒绝——store 保存门）。 */
export const CATALOG_MAX_SERVICES = 256;

/** 全量 catalog JSON 上限（工厂期拒绝）。 */
export const CATALOG_MAX_JSON_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// admission（§3.1）
// ---------------------------------------------------------------------------

/** 在途上游并发默认值。 */
export const DEFAULT_MAX_CONCURRENCY = 8;
/** maxConcurrency 域（1–32）。 */
export const MAX_CONCURRENCY_MIN = 1;
export const MAX_CONCURRENCY_MAX = 32;
/** 每活跃 rid 缓冲（活跃 ring 预算 = maxConcurrency × 2MiB ≤ 64MiB）。 */
export const PER_REQUEST_BUFFER_BYTES = 2 * 1024 * 1024;
/** 活跃 ring 超积上限（工厂期拒启）。 */
export const MAX_RING_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// gate 404 同体（design §2：ai handler 内 peer 未授权/op 未授权/未知子路径→
// 一律 404 {error:"not_found"} byte 级同体、不解析 key）
// ---------------------------------------------------------------------------

/** 404 同体三形态的唯一字节序列（契约测试的 byte 级断言锚点）。 */
export const NOT_FOUND_BODY = Buffer.from(JSON.stringify({ error: "not_found" }));

/**
 * 404 同体响应（静态——三形态恒 byte 级相等）。
 * @param {void} [_]
 */
export function notFoundResponse() {
  return {
    status: 404,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyChunks: [NOT_FOUND_BODY],
  };
}

/**
 * 应用层错误响应（{code:"..."}；AUTH 族另带 v:1——由调用方组装 body）。
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
export function jsonResponse(status, body) {
  return {
    status,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyChunks: [Buffer.from(JSON.stringify(body))],
  };
}
