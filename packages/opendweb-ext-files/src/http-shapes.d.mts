// HttpHandler 形状类型面（与 @jixo/opendweb-client-sdk/http 的
// HttpHandlerRequest/HttpHandlerResponse 对齐的本包局部声明——本包零依赖，
// 不 import SDK；serveHttp 接线时结构兼容即通）。
// 仅 JSDoc 引用；运行时零导入。

/**
 * @typedef {Object} HttpHandlerRequestLike
 * @property {string} sessionId 逻辑会话（授权隔离键）
 * @property {AbortSignal} [signal] 对端取消
 * @property {string} method
 * @property {string} path 含 query
 * @property {Array<{ name: string, value: string }>} [headers]
 * @property {() => Promise<Buffer | null>} bodyNext
 * @property {(status: number, headers?: Array<{ name: string, value: string }>) => { write: (chunk: Uint8Array) => Promise<void>, finish: () => void, closed: boolean, cancelled: boolean } | null} [respondStreaming]
 */

/**
 * @typedef {Object} HttpHandlerResponseLike
 * @property {number} status
 * @property {Array<{ name: string, value: string }>} [headers]
 * @property {Array<Uint8Array>} [bodyChunks]
 */

export {};
