// 向后兼容 re-export（home-hub 2a 分层）：sidecar 运行时已迁 src/core/sidecar.mjs。
// 本文件保持既有深导入路径（包内测试与旧内部消费方）可用；包公共入口为
// src/index.mjs（package.json exports "."——startSidecar/createConsole/NodeStore/
// validateTarget 同出）。
export {
  LIMITS,
  parseApiPath,
  maskTarget,
  generatePairingCode,
  startSidecar,
  createSidecar,
} from "./core/sidecar.mjs";
