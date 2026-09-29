// @jixo/opendweb-ext-sync 公共导出面（主子路径 "."）。
// `./opendweb-webui-plugin` 子路径见 webui-plugin.mjs（descriptor——契约校验的
// 唯一权威源在 packages/webui/src/core/plugins/contract.mjs，测试跨包相对导入
// 直验）。
export { createSyncRuntime } from "./runtime.mjs";
export { createSyncEndpointHandler, gcStaging, MAX_OBJECT_BYTES, MAX_OBJECTS_PER_SYNC, MAX_TRANSFER_BYTES, MAX_STREAMS_PER_GROUP, STAGING_TTL_MS } from "./endpoint.mjs";
export { createSyncEngine } from "./engine.mjs";
export { createScheduler } from "./scheduler.mjs";
export {
  createGroup,
  deleteGroup,
  loadLedger,
  findGroup,
  gitdirFor,
  repoDir,
  syncDataDir,
  emptyLedger,
} from "./ledger.mjs";
export { GROUP_REF, deviceRef, listRefsDirect, mergeBase, objectOid, readFlatTree, readObject, readRef, walkClosure, writeCommitOid, writeObject, writeRef, writeTreeFromFlat } from "./objects.mjs";
export { executeIntent, prepareIntent, recoverIntent, readPendingIntent, clearIntent, INTENT_FILE, INTENT_DONE_FILE } from "./intent.mjs";
export {
  mergeTrees,
  diff3TextMerge,
  applyHunkDecisions,
  registerMergeDriver,
  unregisterMergeDriver,
  consultMergeDrivers,
  stableSides,
  DIFF3_ALGO_VERSION,
  TEXT_MERGE_MAX_BYTES,
} from "./merge.mjs";
export { scanWorktree, scanToFlatEntries, pathStateTuple, materializeWrite, materializeDelete } from "./worktree.mjs";
export { loadRootIgnore, parseIgnoreLines, buildMatcher } from "./ignore.mjs";
export { atomicWrite0600, acquireFileLock, createMutex, readBoundedBody, readBoundedJsonLines, jsonBody, decodeUtf8Strict, CrashInjection } from "./util.mjs";
