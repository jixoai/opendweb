// @jixo/opendweb-ext-files 公共面（webui-plugin-kernel Phase 2）。
// 导出：
// - `./opendweb-webui-plugin` 子路径：descriptor（契约权威校验器=
//   packages/webui/src/core/plugins/contract.mjs）
// - `.`：运行时工厂（宿主 runtimes 通道）、wire 客户端控制器、fd 链能力/
//   路径校验（测试与后续插件复用）、账本/staging 语义常量。
// 包零运行时依赖（node 标准库）；测试经相对路径 import webui 契约校验器。

export { filesDescriptor } from "./plugin.mjs";
export {
  WireFsError,
  WIN32_DEGRADATION_NOTE,
  pathSafetyCapability,
  validateComponents,
  openRootFd,
  resetCapabilityCacheForTest,
} from "./fdchain.mjs";
export { createFilesRuntime, DEFAULT_MAX_CONCURRENT_TRANSFERS } from "./runtime.mjs";
export {
  createWireFilesController,
  createHandlerTransport,
  WireClientError,
  CLIENT_CHUNK_BYTES,
} from "./client.mjs";
export {
  emptyShares,
  loadShares,
  mutateShares,
  randomShareId,
  sharesPath,
  validateShareInput,
  ShareValidationError,
} from "./ledger.mjs";
export { parseIgnoreRules, isIgnored, IGNORE_FILE_NAME } from "./ignore.mjs";
export { createStaging, DEFAULT_STAGING_TTL_MS, DEFAULT_CHUNK_MAX_BYTES, sha256Hex } from "./staging.mjs";
