/**
 * @jixo/opendweb-client-sdk/http/internals —— 内部观测面（semver 宽松：跨版本
 * 不承诺兼容，消费方自担风险；design §1.4）。
 * native request id（请求事件 requestId）与 puller（server.requestBodyNext）
 * 经 native HttpServerJs 实例直接观测；本模块提供只读聚合。
 */
import type { HttpServerJs } from "../index.js";

export interface ServerStats {
  /** 在途（未结算）handler 请求数 */
  pendingRequests: number;
  /** 引擎是否已 close */
  closed: boolean;
}

export declare function serverStats(server: HttpServerJs): ServerStats;
