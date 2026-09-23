// SDK 公共入口（home-hub [H4] Phase 2a / specs/webui「webui SDK 分层与进程内宿主」
// + design §5.1）："." 导出面 = startSidecar（签名与返回形状零破坏）+
// createConsole（进程内宿主）+ NodeStore/validateTarget；类型见手写 index.d.ts。
// 分层：core/（sidecar 运行时/NodeStore/目标守卫/事件总线/会话 capability/
// 卡片算法复用面）+ 壳（cli.mjs/plugin.mjs——信号/开浏览器/退出留壳层）。

export {
  LIMITS,
  parseApiPath,
  maskTarget,
  generatePairingCode,
  startSidecar,
  createSidecar,
} from "./core/sidecar.mjs";
export { NODES_FILE_VERSION, NodeStoreError, NodeStore, publicNode } from "./core/nodes.mjs";
export { defaultDns, validateTarget } from "./core/target.mjs";
export { createConsole, CAPABILITY_QUERY_PARAM } from "./core/console.mjs";
export { EVENT_TYPES, EventBus, eventFrame } from "./core/events.mjs";
export { createCapabilities, CAPABILITY_TTL_MS } from "./core/capability.mjs";
// home-hub 2b/2c 本机数据面与接入卡片同源面（core/home.mjs + cardkit.mjs）：
// 分流裁决 / leases·visits·hub 投影 / label 锁写 / probe / 卡片模型与 SVG。
export {
  LABEL_MAX_BYTES,
  resolveLaunch,
  leasesProjection,
  visitsProjection,
  probeVisit,
  setLeaseLabel,
  hubProjection,
  hubSnapshotSlot,
} from "./core/home.mjs";
export { hubCardModel, qrSvg, loadRenderHubCard } from "./core/cardkit.mjs";
