// @jixo/opendweb-client-sdk/net/internals —— 内部观测面（semver 宽松：跨版本
// 不承诺兼容，消费方自担风险；design §1.4）。
// journal/offset 观测：journalBytes(session, streamId) = 单流 journal 持有字节
// （发送侧未 ACK 水位）；会话级聚合经 session.state().journalBytes。
const Native = require("../index.js");

/**
 * 单流 journal 持有字节（观测）。
 * @param {import("../index.js").SessionHandle} session
 * @param {number} streamId 逻辑流 id（响应 streamId / 内部面 requestId 关联值）
 * @returns {Promise<number>}
 */
function journalBytes(session, streamId) {
  if (typeof Native.SessionHandle?.prototype?.journalBytes !== "function") {
    return Promise.reject(new Error("native journalBytes unavailable (rebuild binary)"));
  }
  return session.journalBytes(streamId);
}

module.exports = { journalBytes };
