// @jixo/opendweb-ext-ports —— 主出口（webui-plugin-kernel Phase 1）。
// 消费面：
// - 宿主/编排者：createPortsRuntime（createPluginHost({runtimes:{ports}}) 通道）
//   与 descriptor（./opendweb-webui-plugin 子路径——契约 manifest）；
// - 提供侧接线：rt.createProviderHandler(peer) → serveHttp(fabric, peer, handler)；
// - 账本管理面：mappings/allowlist 操作（控制面路由与 UI 的数据源）。
// ./opendweb-webui-plugin 子路径导出 descriptor（见 src/webui-plugin.mjs）。

export { createPortsRuntime } from "./runtime.mjs";
export { createPortsProxyHandler, parseProxyPath, PROXY_PATH_PREFIX } from "./provider.mjs";
export {
  DEFAULT_MAX_BODY_MIB,
  MIN_CONFIG_MIB,
  MAX_CONFIG_MIB,
  CONFIG_GRANULARITY_BYTES,
  MAX_CONCURRENT_PROXIES,
  DRAIN_TIMEOUT_MS,
  resolveLimitBytes,
  proxyPath,
  createProxyBudget,
  createInFlightRegistry,
  createMappingServer,
} from "./proxy.mjs";
export {
  HOP_BY_HOP_HEADERS,
  HOP_BY_HOP_PREFIXES,
  isHopByHop,
  forwardRequestHeaders,
  forwardResponseHeaders,
  nodeHeadersToArray,
  arrayHeadersToNode,
} from "./headers.mjs";
export {
  PORTS_DIR,
  MAPPINGS_FILE,
  MAPPINGS_LOCK,
  ALLOWLIST_FILE,
  ALLOWLIST_LOCK,
  MIN_PORT,
  MAX_PORT,
  portsDir,
  mappingsPath,
  allowlistPath,
  isValidPort,
  randomMappingId,
  loadMappings,
  loadAllowlist,
  mutateMappings,
  mutateAllowlist,
  addMapping,
  removeMapping,
  setMappingEnabled,
  grantAccess,
  revokeAccess,
  isAccessAllowed,
} from "./ledger.mjs";
