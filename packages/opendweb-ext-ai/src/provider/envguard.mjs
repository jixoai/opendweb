// adapted from ai-fly src/provider/{lifecycle,rewrite}.ts 的 env 面删除补充件
// （v0.6.0 对照；本文件为 design §4 的 env 四面防线落点——ai-fly 无对应物）。
//
// 凭证 env 四面防线（requirements「上游预设与凭证注入」/design §4 冻结）：
// ①声明面：`$env:` 形态与 env.cjs 不存在（lifecycle.mjs 构造期拒绝 + hooks 库
//   无该脚本）；
// ②脚本面：hook=宿主进程内 require()（内核可信插件信任模型——本 change 不
//   宣称防御恶意 hook）；保证=auth 路径 process.env fallback 删除（rewrite.mjs
//   无 env 参数）+auth 槽三族是凭证进入上游请求的唯一通道；
// ③预设面：keyEnv 降 UI 提示，服务激活前 MUST 绑定 secret 名（未绑定不可
//   启用——store.assertServiceActivatable 写路径门）；
// ④ambient env 防绕（fail-closed，两个时点）：本文件。
//   - 时点一（provider 启动）：已启用服务的预设 keyEnv 名单变量存在于进程
//     环境 → 拒绝启动（assertStartupEnvSafety）；
//   - 时点二（运行中原子变更）：服务新增/启用/预设或 keyEnv 变更/staging
//     commit → store 写路径内 assertServiceActivatable 原子拒绝（本文件
//     assertRuntimeChange 供编排层在任意「将启用」集合上复用同一判定）。
//   判定线=值进入上游请求头/体；CODEX_HOME 类运行时 env 不受限（只检测
//   keyEnv 名单）。不剥离值——剥离改变用户环境语义，拒绝才是诚实边界。

/**
 * ambient env 冲突项（机器可读）。
 * @typedef {Object} AmbientEnvViolation
 * @property {string} service 服务名（用户可定位）
 * @property {string} keyEnv 存在于进程环境的预设变量名
 */

/**
 * 收集 ambient env 冲突：services 中「已启用（或将启用）」且声明 keyEnv、
 * 且该变量存在于 env 的条目。
 * @param {Array<{ name: string, keyEnv?: string | undefined, enabled?: boolean }>} services
 * @param {{ get?: (name: string) => string | undefined }} [envSource] 缺省 process.env
 * @returns {AmbientEnvViolation[]}
 */
export function ambientEnvViolations(services, envSource) {
  const get = envSource?.get ?? ((name) => process.env[name]);
  const out = [];
  for (const service of services) {
    if (service.enabled === false) continue; // 停用条目不在名单（启用时点再判）
    if (service.keyEnv === undefined) continue;
    if (get(service.keyEnv) !== undefined) {
      out.push({ service: service.name, keyEnv: service.keyEnv });
    }
  }
  return out;
}

/**
 * 启动时点防线（时点一）：已启用服务的 keyEnv 名单命中进程环境 → 抛错拒绝
 * 启动（列明变量名+指引转 secret 槽；不剥离值）。
 * @param {Array<{ name: string, keyEnv?: string | undefined, enabled?: boolean }>} services
 * @param {{ get?: (name: string) => string | undefined }} [envSource]
 * @throws {Error}
 */
export function assertStartupEnvSafety(services, envSource) {
  const violations = ambientEnvViolations(services, envSource);
  if (violations.length === 0) return;
  const names = [...new Set(violations.map((v) => v.keyEnv))].sort();
  const affected = violations.map((v) => `'${v.service}' (${v.keyEnv})`).join(", ");
  throw new Error(
    `refusing to start the ai provider: ambient environment variable(s) [${names.join(", ")}] used by enabled service(s) ${affected}; ` +
      `move the credential into the secrets store (<DWEB_HOME>/plugins/ai/secrets.json) and bind it via the {secret} auth slot ` +
      `(values are never read from the environment)`,
  );
}

/**
 * 运行中时点防线（时点二，纯函数复用面）：对「变更后将启用」的服务集合做
 * 同一判定（store 写路径已内建；编排层对非 store 路径的自定义变更面调用）。
 * @param {Array<{ name: string, keyEnv?: string | undefined, enabled?: boolean }>} servicesAfterChange
 * @param {{ get?: (name: string) => string | undefined }} [envSource]
 * @returns {{ ok: true } | { ok: false, violations: AmbientEnvViolation[], message: string }}
 */
export function assertRuntimeChange(servicesAfterChange, envSource) {
  const violations = ambientEnvViolations(servicesAfterChange, envSource);
  if (violations.length === 0) return { ok: true };
  const names = [...new Set(violations.map((v) => v.keyEnv))].sort();
  return {
    ok: false,
    violations,
    message:
      `refusing the change: ambient environment variable(s) [${names.join(", ")}] used by service(s) ` +
      `${violations.map((v) => `'${v.service}'`).join(", ")}; bind the credential via the {secret} auth slot instead`,
  };
}
