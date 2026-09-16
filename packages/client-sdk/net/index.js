// @jixo/opendweb-client-sdk/net —— 会话/逻辑流面（design §1.4 subpath 裁决）。
// 本阶段 runtime 为根模块再导出（Fabric.openSession / SessionHandle 及其
// state/onState/close/journalBytes 面）；LogicalStream/OpenStreamMeta 为类型面
// （net/index.d.ts），openStream/sendDatagram 的 runtime 随后续 phase 落地
// ——不冒充。
module.exports = require("../index.js");
