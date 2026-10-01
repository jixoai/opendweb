// adapted from ai-fly src/provider/lifecycle.ts (v0.6.0)
// hooks-lifecycle v2 领域类型单源：四段生命周期管线（onRequestBearerAuthentication
// → onRequestHeaders → onRequest → onResponse）的配置槽 schema 在此冻结；
// wire 投影（src/wire/schemas.mjs）、存储投影（store.mjs）一律 import 消费，
// 只做传输/存储面投影，禁止手写镜像。
//
// 【与 ai-fly 的有意分歧（design §4 冻结——env 二分法）】
// - **`$env:` 凭证引用族不存在**：上游 `ENV_REF_PREFIX` 的「请求期环境变量
//   解析」语义整体删除。本文件保留该前缀常量**仅用于构造期拒绝**
//   （`rejectEnvRef`）——auth.literal 与 headers.set 值凡以 `$env:` 开头，
//   schema 层即失败（指回 secret/script 槽）；`hooks/env.cjs` 不随包。
// - literal 间接引用仅 `$secret:`。
// - HookCtx 无 `env` 访问器（上游有）——插件自身代码路径不经 env 取凭证；
//   v1 hook 为宿主进程内 require()（与宿主同权限），本 change 不宣称防御
//   恶意 hook（其可自行读 process.env/secrets.json——见 README/design 明示）。

import { z } from "zod";

// ---------------------------------------------------------------------------
// 阶段常量
// ---------------------------------------------------------------------------

/** 四阶段脚本导出名（顺序 = 管线执行顺序）。 */
export const STAGE_FN_NAMES = [
  "onRequestBearerAuthentication",
  "onRequestHeaders",
  "onRequest",
  "onResponse",
];

// ---------------------------------------------------------------------------
// 披露掩码与字面量间接引用（仅 $secret:）
// ---------------------------------------------------------------------------

/** 投影脱敏掩码 ●（wire/detail 投影中脚本绑定、密钥名、引用型字面量的统一掩码）。 */
export const SERVICE_VALUE_MASK = "\u25cf";

/** $secret 间接引用前缀（请求期密钥库解析；缺失 → secret_missing）。 */
export const SECRET_REF_PREFIX = "$secret:";

/**
 * `$env:` 前缀——**仅作构造期拒绝的检测常量**（无解析语义；design §4：
 * 声明面防线——该形态 MUST NOT 存在于任何凭证/头值声明中）。
 */
export const ENV_REF_PREFIX = "$env:";

/** @param {string} value */
export function isSecretRef(value) {
  return value.startsWith(SECRET_REF_PREFIX);
}

/**
 * `$env:` 形态检测（构造期拒绝用——见 rejectEnvRef）。
 * @param {string} value
 */
export function isEnvRef(value) {
  return value.startsWith(ENV_REF_PREFIX);
}

/**
 * 构造期拒绝 `$env:` 引用（design §4/requirements「$env 拒绝」Scenario：
 * 前者构造期拒绝（指回 secret/script））。上游允许请求期 env 解析——本包
 * 删除该语义，声明即拒绝。
 * @param {string} value
 * @returns {string | null} 错误文案（null=合法）
 */
export function envRefError(value) {
  if (isEnvRef(value)) {
    return `'$env:' references are not supported; bind the credential via the auth slot ({secret: name} or {script: name}) or '$secret:' instead`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 共享字段 schema（canonical；wire/存储投影复用的基础对象）
// ---------------------------------------------------------------------------

/** 脚本名（小写开头，小写数字横杠下划线，≤64）。 */
export const SCRIPT_NAME_SCHEMA = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/** 脚本 args（变量名 → 字符串）。 */
export const SCRIPT_ARGS_SCHEMA = z.record(z.string().min(1).max(128), z.string().max(2048));

/** auth.secret 引用的密钥库名（与 SECRET_NAME_SCHEMA 同词汇与上限）。 */
export const AUTH_SECRET_NAME_SCHEMA = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

/** 头名（headers.remove 条目 / headers.set 键）。 */
export const HEADER_NAME_SCHEMA = z.string().min(1).max(1024);

/**
 * headers.set 值：仅字面量 string + `$secret:` 间接引用（`$env:` 构造期拒绝
 * ——与上游分歧：上游允许 $env 请求期解析）。
 */
export const HEADER_VALUE_SCHEMA = z
  .string()
  .max(8192)
  .refine((v) => envRefError(v) === null, { message: "'$env:' references are not supported in header values" });

/** Bearer 前缀开关：auth 槽唯一来源。 */
export const AUTH_BEARER_SCHEMA = z.boolean().optional();

// ---------------------------------------------------------------------------
// ① auth 槽（onRequestBearerAuthentication）：三族单选 + 可选 bearer
// ---------------------------------------------------------------------------

export const AUTH_SECRET_SLOT_SCHEMA = z.strictObject({
  secret: AUTH_SECRET_NAME_SCHEMA,
  bearer: AUTH_BEARER_SCHEMA,
});

export const AUTH_SCRIPT_SLOT_SCHEMA = z.strictObject({
  script: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
  bearer: AUTH_BEARER_SCHEMA,
});

export const AUTH_LITERAL_SLOT_SCHEMA = z.strictObject({
  // $env: 构造期拒绝（design §4：auth literal 写 $env:MY_KEY → 构造期拒绝）。
  literal: z
    .string()
    .min(1)
    .max(8192)
    .refine((v) => envRefError(v) === null, {
      message: "'$env:' references are not supported; use the {secret} or {script} auth slot",
    }),
  bearer: AUTH_BEARER_SCHEMA,
});

/** auth 槽：{secret} | {script, args?} | {literal}（+可选 bearer；literal 间接引用仅 $secret:）。 */
export const AUTH_SLOT_SCHEMA = z.union([
  AUTH_SECRET_SLOT_SCHEMA,
  AUTH_SCRIPT_SLOT_SCHEMA,
  AUTH_LITERAL_SLOT_SCHEMA,
]);

// ---------------------------------------------------------------------------
// ② headers 槽（onRequestHeaders）：remove[] + set{}（值仅字面量/$secret:）+ 可选整段脚本
// ---------------------------------------------------------------------------

export const HEADERS_SCRIPT_SLOT_SCHEMA = z.strictObject({
  name: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
});

export const HEADERS_REMOVE_SCHEMA = z.array(HEADER_NAME_SCHEMA).max(32);

export const HEADERS_SET_SCHEMA = z.record(HEADER_NAME_SCHEMA, HEADER_VALUE_SCHEMA);

export const HEADERS_SLOT_SCHEMA = z.strictObject({
  remove: HEADERS_REMOVE_SCHEMA.optional(),
  set: HEADERS_SET_SCHEMA.optional(),
  script: HEADERS_SCRIPT_SLOT_SCHEMA.optional(),
});

// ---------------------------------------------------------------------------
// ③ request 槽 / ④ response 槽：脚本绑定
// ---------------------------------------------------------------------------

export const REQUEST_SLOT_SCHEMA = z.strictObject({
  script: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
});

export const RESPONSE_SLOT_SCHEMA = z.strictObject({
  script: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
});

// ---------------------------------------------------------------------------
// 四槽合体 + 预设模式整段绑定
// ---------------------------------------------------------------------------

/** 生命周期四槽（嵌入服务配置的 canonical 形）。 */
export const LIFECYCLE_SLOTS_SCHEMA = z.strictObject({
  auth: AUTH_SLOT_SCHEMA.optional(),
  headers: HEADERS_SLOT_SCHEMA.optional(),
  request: REQUEST_SLOT_SCHEMA.optional(),
  response: RESPONSE_SLOT_SCHEMA.optional(),
});

/**
 * 预设模式整段绑定（与四槽互斥——store 层裁决；codex 脚本不随包，
 * 由后续 change ai-codex-oauth 承接）。
 */
export const HOOKS_SLOT_SCHEMA = z.strictObject({
  script: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
});

/** 密钥库名词汇（与 ai-fly SECRET_NAME_SCHEMA 同拍）。 */
export const SECRET_NAME_SCHEMA = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, dot, dash, underscore");
