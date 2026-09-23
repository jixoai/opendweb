// SDK 公共入口（home-hub Phase 3a / specs/packaging/tray-plugin）："." 导出面
// =无头控制器 + 心跳/IPC 编解码件（壳侧 opentray 进程内消费或测试直打）。
// "./opendweb-plugin" 子路径是 opendweb CLI 插件面（plugin.mjs）——两面互不
// 混用（CLI 面冻结见 plugin-contract.mjs）。

export { createTrayController, runTray, parseTrayArgv } from "./controller.mjs";
export {
  createHeartbeat,
  computeSnapshot,
  TRAY_STATUS_FILE,
  TRAY_SCHEMA_VERSION,
  TRAY_STATES,
  HEARTBEAT_INTERVAL_MS,
  ADMIN_POLL_INTERVAL_MS,
} from "./heartbeat.mjs";
export {
  createIpcSession,
  handleFrame,
  scanFrameId,
  okResultFrame,
  errorFrame,
  RpcError,
  IPC_FRAME_LIMIT_BYTES,
  RPC_MESSAGES,
  RPC_CODES,
} from "./ipc.mjs";
export { readHubSide, adminBase, pollKnocks, runHubCommand, mapHubCommandError, resolveOpendwebBin, defaultIsPidAlive } from "./hub-side.mjs";
