// 向后兼容 re-export（home-hub 2a 分层）：NodeStore 已迁 src/core/nodes.mjs
// （design §5.1：NodeStore 属 core；公共导出经 src/index.mjs）。
export { NODES_FILE_VERSION, NodeStoreError, NodeStore, publicNode } from "./core/nodes.mjs";
