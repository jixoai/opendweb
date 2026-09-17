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
  /** 响应头等待上限毫秒（默认 30000；超时发 RESET 清理 provider 在途请求） */
  headTimeoutMs?: number;
  /**
   * 消费端取消信号（0.6.0）：abort → head 等待期即时 RESET（对端在途请求
   * 不再悬挂至其自身超时）。与 provider 侧 req.signal 对偶。
   */
  signal?: AbortSignal;
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

/** 流式响应写句柄（respondStreaming 返回；三态观测正交，0.6.0 三拆） */
export interface StreamWriterHandle {
  /** 写入一块 body（有界通道背压；finish 后写或通道已死 → reject） */
  write(chunk: Uint8Array): Promise<void>;
  /** 半关（EOF；幂等） */
  finish(): void;
  /** 本地已调用 finish()（半关意图） */
  readonly finished: boolean;
  /** 对端取消事件已触发本请求（事件驱动观测；write 错误仍为真相面） */
  readonly cancelled: boolean;
  /** 底层投递通道已关（完成/放弃/取消后翻转） */
  readonly closed: boolean;
}

/** handler 收到的请求（provider 侧；请求体经 bodyNext 拉取，EOF = null） */
export interface HttpHandlerRequest {
  /** native request id（结算关联；/http/internals 观测） */
  requestId: number;
  /** 逻辑流 id */
  streamId: number;
  /**
   * 所属逻辑会话（hex；内核本地协商事实，非 wire 字段）。授权缓存应以此为
   * 隔离键——同 peer 异 session 不继承授权（spec fabric §3.2）。
   */
  sessionId: string;
  /**
   * 对端取消信号（RESET/会话终态遗弃 → abort；事件驱动，挂起中的 handler
   * 也能即时收到）。正常完成不触发。
   */
  signal: AbortSignal;
  method: string;
  path: string;
  headers: Array<Header>;
  bodyNext(): Promise<Buffer | null>;
  /**
   * 流式结算：立即发响应头（SSE 首包/WS 101 早发），body 经返回的 writer
   * 持续 write/finish。与返回值结算互斥（先到者胜）；已结算 → null。
   */
  respondStreaming(
    status: number,
    headers?: Array<Header>,
  ): StreamWriterHandle | null;
}

/** handler 返回的响应（静态分块 body；流式走 respondStreaming） */
export interface HttpHandlerResponse {
  /** 100..=599 */
  status: number;
  headers?: Array<Header>;
  bodyChunks?: Array<Uint8Array>;
}

export type HttpHandler = (
  request: HttpHandlerRequest,
) =>
  | HttpHandlerResponse
  | PromiseLike<HttpHandlerResponse | null | void>
  | null
  | void;

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
