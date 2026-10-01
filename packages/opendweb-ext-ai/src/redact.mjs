// 管理面错误投影单一脱敏层（codex 实现终审 P1-8 修复——2026-10-01）。
//
// 冻结规范纪律（design §4/§5 错误文案面）：
// - HTTP/UI 只出**固定 code + 固定脱敏文案**——本模块是唯一映射点；secret 名、
//   hook 脚本路径、本地绝对路径不得进入响应/日志/错误帧；
// - `keyEnv` 变量名按规范可保留（§4 ④「列明变量名+指引转 secret 槽」——变量名
//   不是密钥名）；
// - 内部日志保留**结构化诊断**（code/错误类名/安全 detail 字段）——同样不含
//   secret 名/脚本路径/绝对路径/原始 message。内部异常对象（StoreError 等）的
//   message 仅供进程内调试与测试断言，任何 log()/HTTP 投影不得直接透出。
//
// 使用面：mgmt.mjs（全部 catch 投影）、wire/endpoints.mjs（handler 兜底日志）、
// runtime.mjs（restore 日志）。数据面（wire 错误帧）另行由 upstream.mjs/
// hooks.mjs 的固定文案纪律覆盖（HookStageError 等构造即脱敏）。

import { StoreError } from "./provider/store.mjs";

/**
 * 错误码 → HTTP 状态（家族惯例：invalid=400 / not-found=404 / duplicate·
 * conflict=409 / corrupt·internal=500）。
 * @param {string} code
 */
export function redactedStatus(code) {
  switch (code) {
    case "invalid":
      return 400;
    case "not-found":
      return 404;
    case "duplicate":
    case "conflict":
      return 409;
    default:
      return 500;
  }
}

/**
 * 激活门（§4 ③④）脱敏文案——保留 keyEnv 变量名与指引，剥离服务名/secret 名。
 * webui 测试对「bind its credential via the {secret」短语有断言——措辞冻结。
 */
const GATE_MESSAGE = {
  "unbound-secret": "bind its credential via the {secret} auth slot before enabling it",
  "missing-secret": "the bound secret is not in the secrets store; add it first",
};

/**
 * 错误 → 固定脱敏投影。
 * @param {unknown} e
 * @returns {{ status: number, code: string, message: string }}
 */
export function sanitizeError(e) {
  const code = extractCode(e);
  const details = /** @type {Record<string, unknown> | undefined} */ (/** @type {{ details?: Record<string, unknown> }} */ (e)?.details);
  let message;
  if (e instanceof StoreError && typeof details?.gate === "string") {
    // 激活门三分支：keyEnv 变量名可保留（规范许可）；其余名称剥离
    if (details.gate === "ambient-env") {
      const keyEnv = typeof details.keyEnv === "string" ? details.keyEnv : "";
      message = `refusing to enable: ambient environment variable '${keyEnv}' is set; move the credential into the secrets store and keep the {secret} binding`;
    } else {
      message = GATE_MESSAGE[/** @type {keyof typeof GATE_MESSAGE} */ (details.gate)] ?? "the request was rejected by the activation gate";
    }
  } else {
    switch (code) {
      case "invalid":
        message = "invalid input";
        break;
      case "not-found":
        message = "not found";
        break;
      case "duplicate":
        message = "an entry with the same identity already exists";
        break;
      case "conflict":
        message = "conflict with the current state";
        break;
      case "corrupt":
        message = "the local data store is unreadable (corrupt or incompatible); fix or remove the file manually";
        break;
      default:
        message = "internal error";
        break;
    }
  }
  return { status: redactedStatus(code), code, message };
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function extractCode(e) {
  if (e instanceof StoreError) return e.code;
  const code = /** @type {{ code?: unknown }} */ (e)?.code;
  if (code === "invalid" || code === "not-found" || code === "duplicate" || code === "conflict" || code === "corrupt") {
    return code;
  }
  return "internal";
}

/**
 * 内部结构化诊断日志行（不含 message/名称/路径——只含 code 与错误类名）。
 * @param {string} face 诊断位（如 "mgmt POST /services"）
 * @param {unknown} e
 */
export function diagnosticLogLine(face, e) {
  const code = extractCode(e);
  const kind = e instanceof Error ? e.constructor.name : typeof e;
  return JSON.stringify({ scope: "ai", face, error: { code, kind } });
}
