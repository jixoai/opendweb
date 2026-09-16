/**
 * @jixo/opendweb-client-sdk/net/internals —— 内部观测面（semver 宽松：跨版本
 * 不承诺兼容，消费方自担风险；design §1.4）。
 */
import type { SessionHandle } from "../index.js";

/** 单流 journal 持有字节（发送侧未 ACK 水位观测） */
export declare function journalBytes(session: SessionHandle, streamId: number): Promise<number>;
