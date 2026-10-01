// @jixo/opendweb-ext-ai 出口桶（ai-subscription-sharing Phase A+B——提供方纯逻辑
// + wire 契约 + 响应中继状态机 + 消费方端点；descriptor（id=ai）与宿主接入按
// tasks Phase C 定稿，本出口不含 webui-plugin 子路径）。

export { atomicWrite0600, acquireFileLock } from "./fsutil.mjs";

export * from "./provider/lifecycle.mjs";
export { ProviderStore, StoreError, hashKeyMaterial, parseUpstreamUrl, assertServiceActivatable } from "./provider/store.mjs";
export { SecretsStore } from "./provider/secrets.mjs";
export { authDirectoryFromStore, evaluateKeyring, buildAuthOk, handleAuthRequest, KeySessionIndex } from "./provider/auth.mjs";
export { LimitEnforcer, UsageLog } from "./provider/limits.mjs";
export { buildServiceEntry, buildServiceDetail, detailDisplayLines } from "./provider/detail.mjs";
export { compileMatchPattern, matchRequestPath, normalizeMatchPatternSyntax, MatchPatternError } from "./provider/match-pattern.mjs";
export { expandUriTemplate, validateUriTemplate, UriTemplateError } from "./provider/uri-template.mjs";
export {
  effectiveLifecycleSlots,
  loadHookScript,
  discoverHooks,
  scriptHasStageExports,
  resolveStageAuth,
  resolveStageHeaders,
  resolveStageRequest,
  resolveStageResponse,
  resolveHookValue,
  disposeHookSubscriptions,
  HookMissingError,
  HookStageError,
} from "./provider/hooks.mjs";
export {
  buildUpstreamRequest,
  resolveAuthSlotValue,
  resolveLiteralHeaderValue,
  applyBearerPrefix,
  isWebSocketUpgradeRequest,
  RewriteError,
  PathNotOfferedError,
  SecretMissingError,
} from "./provider/rewrite.mjs";
export {
  forwardRequest,
  normalizeBody,
  splitBodyChunks,
  createCollectingSink,
  defaultProbeConnect,
  projectRespMeta,
  DEFAULT_UPSTREAM_TIMEOUTS,
  UpstreamAbortError,
} from "./provider/upstream.mjs";
export { ambientEnvViolations, assertStartupEnvSafety, assertRuntimeChange } from "./provider/envguard.mjs";
export { stageAiflyConfig, commitAiflyImport, convertServiceInput, envRefName } from "./provider/importer.mjs";
export { assertCatalogBudget, buildCatalogView, watchCatalogRevision } from "./provider/catalog.mjs";
export { parseWirePath, createOpGate, opGateName } from "./provider/accept.mjs";
export { createForwardPlane, validateAdmission, errorHttpStatus } from "./provider/forward.mjs";
export {
  createRelayRegistry,
  errorRelayStatus,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_ABSOLUTE_LIFETIME_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_DRAIN_DEADLINE_MS,
  SUMMARY_LRU_MAX_BYTES,
  TERMINAL_KIND,
} from "./provider/relay.mjs";

// 消费方（Phase B3：本地回环网关+钥环+信封导入+会话状态机——fabric=宿主注入面）
export { openKeyring, KEYRING_SCHEMA } from "./consumer/keyring.mjs";
export {
  decodeShareLink,
  formatLinkPreview,
  assertKeyFormat,
  importLink,
  addKey,
  LINK_PAYLOAD_SCHEMA,
  JoinError,
  SHARE_LINK_PREFIX,
  KEY_PREFIX,
  INVITE_PREFIX,
} from "./consumer/join.mjs";
export { createConsumerSession, WireError } from "./consumer/sessions.mjs";
export {
  createConsumerGateway,
  filterRequestHeaders,
  mapRoute,
  localErrorStatus,
  openAiErrorBody,
  LOOPBACK_HOST,
} from "./consumer/gateway.mjs";

export {
  loadCuratedPresets,
  loadActivatablePresets,
  presetToServiceInput,
  classifyApiForm,
  derivedPortFor,
  deriveModelsDevPresets,
  deriveModels,
  fetchModelsDevRaw,
  fetchModelsDevPresets,
  readModelsDevRaw,
  hasModelsDevCache,
  modelsDevCachePath,
} from "./presets/models-dev.mjs";

export * from "./wire/constants.mjs";
export {
  ERROR_CODE,
  REJECTED_CODE,
  HTTP_METHODS,
  FORBIDDEN_REQ_HEADER_NAMES,
  RESP_META_HEADER_WHITELIST,
  requestPathError,
  passthroughHeadersError,
} from "./wire/schemas.mjs";
export { createAiProviderWireHandler, metadataHeaderBytes, serviceIdDuplicateSource } from "./wire/endpoints.mjs";
