// 向后兼容 re-export（home-hub 2a 分层）：目标守卫已迁 src/core/target.mjs
// （design §5.1：validateTarget 属 core；公共导出经 src/index.mjs）。
export { defaultDns, validateTarget } from "./core/target.mjs";
