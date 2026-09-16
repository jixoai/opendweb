/**
 * @jixo/opendweb-client-sdk/http —— HTTP/WS 绑定类型面（design §3.4）。
 *
 * fetchHttp/serveHttp 为本阶段冻结面；WS 整消息通道（WsMessage/
 * WebSocketChannel）为类型占位——runtime 归 Phase 4（如实标注）。当前 WS
 * 形态 = 字节隧道（fetchHttp keepOpen + resp.sendTunnel + bodyNext）。
 */
import type { Fabric, SessionHandle } from "../index.js";
import type { HeaderJs } from "../index.js";

/** HTTP 头（数组形态保重复项，§3.4） */
export type Header = HeaderJs;

/** fetchHttp 请求初始化（本阶段静态 body 分块；AsyncIterable 请求体后续 phase） */
export interface HttpRequestInit {
  method: string;
  path: string;
  headers?: Array<Header>;
  /** 静态分块请求体 */
  body?: Array<Uint8Array> | null;
  /** WS 隧道模式：不半关请求方向（101 后双向持续；配合 sendTunnel） */
  keepOpen?: boolean;
}

/**
 * fetchHttp 响应（native 类 + §3.4 body AsyncIterable 投影）。
 * bodyNext 为 pull-first（无桥内缓冲）；EOF = null；会话 dead/closed 时有界失败。
 */
export type HttpClientResponse = import("../index.js").HttpClientResponseJs & {
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
};

/** 发起 HTTP 请求（design §3.4 规范签名） */
export declare function fetchHttp(
  session: SessionHandle,
  request: HttpRequestInit,
): Promise<HttpClientResponse>;

/** handler 收到的请求（provider 侧；请求体经 bodyNext 拉取，EOF = null） */
export interface HttpHandlerRequest {
  /** native request id（结算关联；/http/internals 观测） */
  requestId: number;
  /** 逻辑流 id */
  streamId: number;
  method: string;
  path: string;
  headers: Array<Header>;
  bodyNext(): Promise<Buffer | null>;
}

/** handler 返回的响应（本阶段静态分块 body；流式供给后续 phase） */
export interface HttpHandlerResponse {
  /** 100..=599 */
  status: number;
  headers?: Array<Header>;
  bodyChunks?: Array<Uint8Array>;
}

export type HttpHandler = (
  request: HttpHandlerRequest,
) => HttpHandlerResponse | PromiseLike<HttpHandlerResponse>;

/** serveHttp 返回句柄（design §3.4 HttpServer） */
export interface HttpServer {
  close(reason?: string): Promise<void>;
  /**
   * 内部桥句柄（native HttpServerJs）——/http/internals 的观测/结算原语。
   * semver 宽松：不构成稳定承诺。
   */
  readonly native: import("../index.js").HttpServerJs;
}

/** provider 侧 HTTP 引擎（design §3.4 规范签名） */
export declare function serveHttp(
  fabric: Fabric,
  peerId: string,
  handler: HttpHandler,
): Promise<HttpServer>;

/**
 * WS 整消息（design §3.4 冻结 ABI）。类型占位——整消息通道 runtime 归
 * Phase 4；当前 WS 形态为字节隧道（keepOpen + sendTunnel + bodyNext）。
 */
export type WsMessage =
  | { kind: "text"; data: string }
  | { kind: "binary"; data: Uint8Array };

/**
 * WebSocketChannel（design §3.4 冻结 ABI）。类型占位——runtime 归 Phase 4。
 * 错误码冻结：WS_MESSAGE_TOO_LARGE / WS_INVALID_UTF8 / WS_CLOSED。
 */
export interface WebSocketChannel {
  readonly messages: AsyncIterable<WsMessage>;
  send(message: WsMessage): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}
