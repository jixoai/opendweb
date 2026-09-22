// opendweb id —— 身份查看命令（server-access-roles Phase 3，cli/identity）。
// 只读：输出来自本机默认设备 key（R2「一台设备一个默认 key」）的
// endpoint_id（完整 64 hex）、防钓鱼缩写（首 3 + *** + 尾 3，[R6] 同规则）
// 与 key 存储路径。MUST NOT 输出私钥材料；MUST NOT 修改任何状态（幂等——
// 无 key 时非零退出并指引 join，绝不顺手生成）。
// 缩写规则与 webui [R6] `alias (abc***xyz)` 的 hex 首尾各 3 字符一致。

import { CliExit, asciiEscape } from "./util.mjs";
import { deviceKeyFile, loadDeviceSeed } from "./device-key.mjs";
import { endpointIdHexFromSeed } from "./ed25519.mjs";

/**
 * 防钓鱼缩写：hex 首 3 + `***` + 尾 3（[R6] 冻结；输入须为 ≥6 字符 hex）。
 * @param {string} hex
 * @returns {string}
 */
export function abbreviateHex(hex) {
  if (typeof hex !== "string" || hex.length < 6) {
    throw new TypeError("abbreviateHex: expected a hex string of at least 6 characters");
  }
  return `${hex.slice(0, 3)}***${hex.slice(-3)}`;
}

/**
 * id 主流程（只读）：设备 key 存在 → 输出 endpoint_id/缩写/路径；缺失 →
 * 非零退出指引 join（生成属 join 的设备引导职责，id 零副作用）。
 * @param {{ home: string, stdout?: (line: string) => void }} ctx
 * @returns {Promise<number>} 退出码 0
 */
export async function runId({ home, stdout = (line) => console.log(line) }) {
  const keyPath = deviceKeyFile(home);
  let seed;
  try {
    seed = await loadDeviceSeed(home);
  } catch (e) {
    throw new CliExit(asciiEscape(/** @type {Error} */ (e).message), 1);
  }
  if (seed === null) {
    throw new CliExit(
      `no device key yet (${asciiEscape(keyPath)}); run "opendweb join --server <URL> --code <dwebc1 code>" to create one on first join`,
      1,
    );
  }
  const endpointId = endpointIdHexFromSeed(seed);
  stdout(`endpoint_id  ${endpointId}`);
  stdout(`short        ${abbreviateHex(endpointId)}`);
  stdout(`key          ${asciiEscape(keyPath)}`);
  return 0;
}
