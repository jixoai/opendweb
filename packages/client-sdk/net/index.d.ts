/**
 * @jixo/opendweb-client-sdk/net —— 会话/逻辑流类型面（design §1.4/§3.3）。
 *
 * 本阶段 runtime = 根模块再导出（SessionHandle 及其 state/onState/close/
 * journalBytes 面）；LogicalStream/OpenStreamMeta 为前瞻类型声明
 * （openStream/sendDatagram runtime 随后续 phase 落地——如实标注，不冒充）。
 */
export { Fabric, SessionHandle } from "../index.js";
export type {
  ConnectionStateSnapshotJs as ConnectionStateSnapshot,
  SessionStateSnapshotJs as SessionStateSnapshot,
} from "../index.js";

/**
 * openStream 元数据（design §2.4：幂等键/方法/路径/副作用策略）。
 * 前瞻类型：runtime 面（SessionHandle.openStream）未实现，后续 phase 落地。
 */
export interface OpenStreamMeta {
  /** 128bit 随机幂等键（同一用户请求的所有 connection epoch 中不变，§2.8） */
  idempotencyKey: string;
  method?: string;
  path?: string;
  sideEffectPolicy?: "at-most-once";
  bodyLength?: number;
  contentType?: string;
}

/**
 * 逻辑流（design §3.3 LogicalStream）。前瞻类型：runtime 面未实现；
 * HTTP/WS 投影（/http）当前经引擎承载流语义。
 */
export interface LogicalStream {
  readonly streamId: number;
  send(chunk: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  recv(): Promise<Uint8Array | null>;
}
