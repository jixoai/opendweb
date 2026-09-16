// @jixo/opendweb-client-sdk/http/internals —— 内部观测面（semver 宽松：跨版本
// 不承诺兼容，消费方自担风险；design §1.4）。
// native request id / puller 观测：请求事件携带 requestId（native 侧分配），
// serverStats 观测在途 handler 数；bodyNext puller 经 server.requestBodyNext。
const Native = require("../index.js");

/**
 * 引擎桥观测：在途（未结算）handler 请求数。
 * @param {{ pendingRequestCount: number }} server native HttpServerJs 实例
 */
function serverStats(server) {
  return {
    pendingRequests: server.pendingRequestCount,
    closed: server.closed,
  };
}

module.exports = { serverStats };
