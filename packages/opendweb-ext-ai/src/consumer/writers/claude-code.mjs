// adapted from ai-fly src/app/writers/{claude-code.ts, common.ts, index.ts}
// (v0.6.0) —— claude-code 写手（ai-subscription-sharing Phase D / tasks D1）。
// 意图（2026-10-01）：
// 1. ~/.claude/settings.json 的 surgical 合并：只动 env.ANTHROPIC_BASE_URL（指向
//    本地消费端点 http://127.0.0.1:<port>）与 env.ANTHROPIC_AUTH_TOKEN（**恒占位
//    符 sk-aifly-local——真实凭证绝不写入**：本地网关剥离凭据头，跨网凭证走
//    fabric 钥环）；其余字段原样保留，非对象 JSON 拒绝改写。
// 2. anthropic base 推导照搬上游：服务声明 anthropic 路由 → localPrefix 剥尾部
//    版本段（Claude Code 自带 /v1/messages 追加）；无路由沿用裸 base。
// 3. 两段式 preview→apply：preview 纯读（diff+sha256 令牌）；apply 重算当前盘面
//    令牌一致才落盘（用户确认的与写入的是同一份内容；预览后并发变更被拒）。
//    落盘经 atomicWrite0600 家族（O_EXCL tmp+0600+rename——含凭据语义的配置按
//    私有文件处理）。
// 正交意图（本文件不实现）：本地端点生命周期（runtime.mjs）、UI 呈现（webui）。
// codex 写手随后续 change ai-codex-oauth（design §5）。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite0600 } from "../../fsutil.mjs";

/** 本地 AUTH_TOKEN 占位符（形态沿用 ai-fly——非凭证；真实密钥绝不落此文件）。 */
export const CLAUDE_CODE_PLACEHOLDER_TOKEN = "sk-aifly-local";

/** 写手失败（mgmt 映射 invalid=400 / stale-preview=409）。 */
export class WriterError extends Error {
  /**
   * @param {"invalid_settings" | "stale_preview" | "io"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "WriterError";
    this.code = code;
  }
}

/**
 * 写手目标（本地消费端点投影）。
 * @typedef {Object} WriterTarget
 * @property {number} port
 * @property {Array<{ forms: string[], localPrefix: string }>} routes 目录 ServiceEntry 的 detail.routes（pattern 路由由调用方滤除）
 */

/**
 * Claude Code 的 base：anthropic 路由 → localPrefix 剥尾部版本段（client 自带
 * /v1/messages）；无 anthropic 路由沿用裸 base。
 * @param {number} port
 * @param {ReadonlyArray<{ forms?: unknown, localPrefix?: unknown }>} routes
 */
export function anthropicBaseUrl(port, routes = []) {
  for (const route of routes) {
    const forms = Array.isArray(route?.forms) ? /** @type {unknown[]} */ (route.forms) : [];
    if (!forms.includes("anthropic")) continue;
    const local = typeof route.localPrefix === "string" ? route.localPrefix : "";
    return `http://127.0.0.1:${port}${local.replace(/\/v\d+$/, "")}`;
  }
  return `http://127.0.0.1:${port}`;
}

/** settings.json 路径（home 参数化——单测注入 tmp HOME，不触真实用户目录）。 */
export function claudeCodeSettingsPath(home) {
  return join(home, ".claude", "settings.json");
}

/**
 * 文本 → JSON 对象（compose 纯函数路径）：空/不存在 → 新对象；非对象/非法 →
 * 拒绝改写（不破坏既有内容）。
 * @param {string | null} raw
 */
function parseSettingsObject(raw) {
  if (raw === null || raw.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WriterError("invalid_settings", `settings.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); refusing to rewrite it`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WriterError("invalid_settings", "settings.json is valid JSON but not an object; refusing to rewrite it");
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * surgical 合成（纯函数，不写盘）：env 块内只覆盖两个键，其余原样。
 * @param {string | null} existing
 * @param {string} baseUrl
 */
export function composeClaudeCodeSettings(existing, baseUrl) {
  const root = parseSettingsObject(existing);
  const env = root["env"];
  if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) {
    throw new WriterError("invalid_settings", "settings.json: 'env' is not an object; refusing to rewrite it");
  }
  const envObj = env === undefined ? {} : /** @type {Record<string, unknown>} */ (env);
  envObj["ANTHROPIC_BASE_URL"] = baseUrl;
  envObj["ANTHROPIC_AUTH_TOKEN"] = CLAUDE_CODE_PLACEHOLDER_TOKEN;
  root["env"] = envObj;
  return `${JSON.stringify(root, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 统一 diff（行级 LCS——配置文件规模小，DP 足够；3 行上下文，unified 格式）
// ---------------------------------------------------------------------------

/** @typedef {{ kind: " " | "-" | "+", text: string }} DiffOp */

/** 行级 LCS 编辑脚本（等值行尽量对齐）。 */
function editScript(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  /** @type {DiffOp[]} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: " ", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "-", text: oldLines[i] });
      i++;
    } else {
      ops.push({ kind: "+", text: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", text: oldLines[i] });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "+", text: newLines[j] });
    j++;
  }
  return ops;
}

/**
 * unified diff（3 行上下文，@@ 头；无差异返回空串）。
 * @param {string} oldText
 * @param {string} newText
 * @param {string} oldLabel
 * @param {string} newLabel
 */
export function unifiedDiff(oldText, newText, oldLabel, newLabel) {
  const split = (text) => {
    if (text === "") return [];
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const oldLines = split(oldText);
  const newLines = split(newText);
  const ops = editScript(oldLines, newLines);

  const CONTEXT = 3;
  /** @type {Array<{ oldStart: number, oldCount: number, newStart: number, newCount: number, lines: string[] }>} */
  const hunks = [];
  let idx = 0;
  let oldLine = 1;
  let newLine = 1;
  while (idx < ops.length) {
    while (idx < ops.length && ops[idx].kind === " ") {
      idx++;
      oldLine++;
      newLine++;
    }
    if (idx >= ops.length) break;

    const hunk = { oldStart: oldLine, oldCount: 0, newStart: newLine, newCount: 0, lines: [] };
    const lead = [];
    for (let back = 1; back <= CONTEXT; back++) {
      const at = idx - back;
      if (at < 0 || ops[at].kind !== " ") break;
      lead.unshift(ops[at]);
    }
    hunk.oldStart = Math.max(1, oldLine - lead.length);
    hunk.newStart = Math.max(1, newLine - lead.length);
    for (const op of lead) {
      hunk.lines.push(`${op.kind}${op.text}`);
      hunk.oldCount++;
      hunk.newCount++;
    }
    let trailing = 0;
    while (idx < ops.length) {
      const op = ops[idx];
      if (op.kind === " ") {
        trailing++;
        if (trailing > CONTEXT) break;
        hunk.lines.push(` ${op.text}`);
        hunk.oldCount++;
        hunk.newCount++;
        oldLine++;
        newLine++;
        idx++;
      } else {
        trailing = 0;
        hunk.lines.push(`${op.kind}${op.text}`);
        if (op.kind === "-") {
          hunk.oldCount++;
          oldLine++;
        } else {
          hunk.newCount++;
          newLine++;
        }
        idx++;
      }
    }
    hunks.push(hunk);
  }

  if (hunks.length === 0) return "";
  const head = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  const body = hunks.map((h) => {
    const oldRange = h.oldCount === 0 ? `${h.oldStart},0` : `${h.oldStart},${h.oldCount}`;
    const newRange = h.newCount === 0 ? `${h.newStart},0` : `${h.newStart},${h.newCount}`;
    return [`@@ -${oldRange} +${newRange} @@`, ...h.lines].join("\n");
  });
  return [...head, ...body].join("\n") + "\n";
}

/** @param {string} text */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 两段式编排（preview → 确认 → apply）
// ---------------------------------------------------------------------------

/**
 * 内部 canonical 预览（不写盘、不掩码）——apply 写盘与令牌比对的唯一源。
 * @param {{ home: string, port: number, routes?: WriterTarget["routes"] }} target
 */
async function computeWriterPreview(target) {
  const path = claudeCodeSettingsPath(target.home);
  const baseUrl = anthropicBaseUrl(target.port, target.routes ?? []);
  let before = null;
  try {
    before = await readFile(path, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") {
      throw new WriterError("io", `cannot read ${path}: ${/** @type {Error} */ (e).message}`);
    }
  }
  const after = composeClaudeCodeSettings(before, baseUrl);
  const diff = unifiedDiff(before ?? "", after, path, path);
  return { path, baseUrl, before, after, diff, tokenSha256: sha256Hex(diff) };
}

/**
 * 预览（不写盘，**响应面**）：r3-P0-1——before/after/diff 全走掩码视图，既有
 * settings.json 敏感值（env 块取值）不得进入浏览器状态；确认令牌仍对未掩码
 * canonical diff 哈希（apply 侧按盘面重算比对，掩码不影响令牌链）。
 * @param {{ home: string, port: number, routes?: WriterTarget["routes"] }} target
 * @returns {Promise<{ agent: "claude-code", path: string, exists: boolean, baseUrl: string, before: string | null, after: string, diff: string, tokenSha256: string }>}
 */
export async function previewClaudeCodeWriter(target) {
  const canonical = await computeWriterPreview(target);
  const beforeMasked = canonical.before !== null ? maskSensitiveSettings(canonical.before) : null;
  const afterMasked = maskSensitiveSettings(canonical.after);
  const diffMasked = unifiedDiff(beforeMasked ?? "", afterMasked, canonical.path, canonical.path);
  return { agent: "claude-code", path: canonical.path, exists: canonical.before !== null, baseUrl: canonical.baseUrl, before: beforeMasked, after: afterMasked, diff: diffMasked, tokenSha256: canonical.tokenSha256 };
}

/**
 * 敏感值掩码（r3-P0-1/r4-P0）：**递归全文**——JSON 任意深度（对象/数组）中
 * 敏感键（token/key/secret/password/credential/auth 类）的字符串取值与所有
 * `sk-` 前缀字符串一律固定掩码；仅精确占位符 `sk-aifly-local` 保留；非敏感
 * 键（如 ANTHROPIC_BASE_URL——预览的核心展示对象）保持可见。非对象 JSON
 * 兜底正则掩码 sk- 值。掩码仅用于响应展示；apply 写盘走 canonical+占位符。
 * @param {string} text
 * @returns {string}
 */
export function maskSensitiveSettings(text) {
  const MASK = "●●●●";
  const PLACEHOLDER = "sk-aifly-local";
  const sensitiveKey = (k) => /token|key|secret|password|credential|auth/i.test(k);
  /**
   * @param {unknown} v
   * @param {string | null} key 当前属性名（数组元素=null）
   * @param {boolean} inherited 敏感祖先上下文（r5-P0：进入敏感键后，数组
   *   元素与任意深度子对象继续继承——容器边界不丢失）
   */
  const walk = (v, key, inherited) => {
    if (typeof v === "string") {
      if (v === PLACEHOLDER) return v;
      if (inherited || (key !== null && sensitiveKey(key)) || v.startsWith("sk-")) return MASK;
      return v;
    }
    if (v === null || typeof v !== "object") return v;
    const selfSensitive = inherited || (key !== null && sensitiveKey(key));
    if (Array.isArray(v)) return v.map((item) => walk(item, null, selfSensitive));
    return Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (v)).map(([k, val]) => [k, walk(val, k, selfSensitive)]));
  };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return text.replace(/"(sk-[^"\\]{8,})"/g, (m, v) => (v === PLACEHOLDER ? m : `"${MASK}"`));
  }
  if (obj === null || typeof obj !== "object") return text;
  return `${JSON.stringify(walk(obj, null), null, 2)}\n`;
}

/**
 * 确认后原子写：重算当前盘面预览，sha256 令牌一致才落盘（预览后盘面变化 /
 * 令牌不符 → WriterError("stale_preview")，不写任何字节）。
 * @param {{ home: string, port: number, routes?: WriterTarget["routes"] }} target
 * @param {string} expectedSha256
 */
export async function applyClaudeCodeWriter(target, expectedSha256) {
  if (typeof expectedSha256 !== "string" || expectedSha256 === "") {
    throw new WriterError("stale_preview", "expectedSha256 is required (preview first, then confirm the diff)");
  }
  // canonical（未掩码）重算：令牌比对与写盘同源——掩码视图绝不出现在写盘面
  const canonical = await computeWriterPreview(target);
  if (canonical.tokenSha256 !== expectedSha256) {
    throw new WriterError("stale_preview", "configuration changed since preview (or the token does not match); preview again and confirm the new diff");
  }
  await atomicWrite0600(canonical.path, canonical.after);
  return { agent: "claude-code", path: canonical.path, baseUrl: canonical.baseUrl };
}
