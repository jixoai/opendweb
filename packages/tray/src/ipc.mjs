// --ipc 控制面（home-hub Phase 3a，2026-09-23）：stdin/stdout JSON-RPC 2.0，
// newline 分帧，帧级冻结（spec tray-plugin「控制面」golden 样例）。
// 意图：
// 1. 帧编解码：单帧上限 64KB（UTF-8 字节，超限 -32601 "frame too large"，
//    id=帧前缀受限扫描可解析则透传否则 null）；坏 JSON -32700 "parse error"；
//    batch 数组整帧拒绝 -32600 "batch not supported"（id 恒 null）；无 id
//    notification -32600 "notifications not supported"（id 恒 null）——拒绝后
//    连接继续处理下一帧；全部响应帧（含 error）携带 "jsonrpc":"2.0"；
// 2. 受限 id 前缀扫描：正则捕获首个 `"id":<scalar>`（数字/字符串/true/
//    false/null——仅对该小片段 JSON.parse，绝不执行整个帧）；字符串值内部
//    伪 `"id":` 序列的误命中是受限扫描的已知边界（非任意 JSON 执行的代价）；
// 3. 无界行防护：无换行的超限输入只保留帧前缀（LIMIT+64B）供 id 扫描，
//    其余丢弃——恶意流不能撑爆内存；
// 4. 方法派发协议：dispatch(method, params) → {ok:true} | 抛 RpcError
//    （业务 error -32000 / 参数 -32602 / 未知方法 -32601 / 内部 -32603）；
//    stdin EOF=优雅结束（finished resolve，退出归控制器）。
// stderr 只归日志；事件与 RPC 不混流（opened 通知是唯一的 server 通知面）。

/** 单帧上限（UTF-8 字节数；>limit 即超长） */
export const IPC_FRAME_LIMIT_BYTES = 64 * 1024;

/** golden 冻结的错误消息面（契约测试逐字节比对） */
export const RPC_MESSAGES = Object.freeze({
  parseError: "parse error",
  notificationsNotSupported: "notifications not supported",
  batchNotSupported: "batch not supported",
  frameTooLarge: "frame too large",
  invalidRequest: "invalid request",
  methodNotFound: "method not found",
  invalidParams: "invalid params",
  internalError: "internal error",
  hubNotInitialized: "hub not initialized",
});

/** 业务/协议错误码（JSON-RPC 2.0 保留段 + -32000 业务段） */
export const RPC_CODES = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  hubAction: -32000,
});

/** 业务 error 载体（dispatch 抛出 → error 帧） */
export class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** 首个 `"id":<scalar>` 的受限捕获（数字/字符串/布尔/null；未命中返回 undefined） */
const ID_SCAN_RE = /"id"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|"(?:[^"\\\r\n]|\\.)*"|true|false|null)/;

/**
 * 受限 id 前缀扫描（非任意 JSON 执行）：帧语法解析失败/超长时的 id 提取。
 * @param {string} text
 * @returns {string | number | boolean | null | undefined} undefined=无可解析 id
 */
export function scanFrameId(text) {
  const m = ID_SCAN_RE.exec(text);
  if (m === null) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

/**
 * 成功帧（golden 冻结：`{"jsonrpc":"2.0","id":<id>,"result":{"ok":true}}`）。
 * @param {string | number | boolean | null} id
 * @returns {string}
 */
export function okResultFrame(id) {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } });
}

/**
 * 错误帧（golden 冻结：`{"jsonrpc":"2.0","id":<id>,"error":{"code":...,"message":...}}`）。
 * @param {string | number | boolean | null} id
 * @param {number} code
 * @param {string} message
 * @returns {string}
 */
export function errorFrame(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * 处理单帧 → 待写响应行数组（纯函数；会话循环逐帧调用）。
 * @param {string} line 已去换行的原始帧
 * @param {{ overflowPrefix?: string | null }} [meta] 无界超限行的保留前缀（优先于 line 扫描）
 * @param {(method: string, params: unknown) => Promise<{ ok: true }>} [dispatch]
 * @returns {Promise<string[]>}
 */
export async function handleFrame(line, meta = {}, dispatch = async () => {
  throw new RpcError(RPC_CODES.methodNotFound, RPC_MESSAGES.methodNotFound);
}) {
  // 无界超限行的续行：换行落在溢出之后——该帧整体已超限，按超长拒绝
  // （id 从保留前缀恢复），不能让残尾走解析分支
  if (typeof meta.overflowPrefix === "string" && meta.overflowPrefix !== "") {
    return [errorFrame(scanFrameId(meta.overflowPrefix) ?? null, RPC_CODES.methodNotFound, RPC_MESSAGES.frameTooLarge)];
  }
  if (Buffer.byteLength(line, "utf8") > IPC_FRAME_LIMIT_BYTES) {
    const id = scanFrameId(meta.overflowPrefix ?? line);
    return [errorFrame(id ?? null, RPC_CODES.methodNotFound, RPC_MESSAGES.frameTooLarge)];
  }
  /** @type {unknown} */
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    const id = scanFrameId(meta.overflowPrefix ?? line);
    return [errorFrame(id ?? null, RPC_CODES.parseError, RPC_MESSAGES.parseError)];
  }
  if (Array.isArray(msg)) {
    return [errorFrame(null, RPC_CODES.invalidRequest, RPC_MESSAGES.batchNotSupported)];
  }
  if (msg === null || typeof msg !== "object") {
    return [errorFrame(null, RPC_CODES.invalidRequest, RPC_MESSAGES.invalidRequest)];
  }
  const req = /** @type {Record<string, unknown>} */ (msg);
  if (!("id" in req)) {
    return [errorFrame(null, RPC_CODES.invalidRequest, RPC_MESSAGES.notificationsNotSupported)];
  }
  const id = /** @type {string | number | boolean | null} */ (req.id);
  if (typeof req.method !== "string") {
    return [errorFrame(id, RPC_CODES.invalidRequest, RPC_MESSAGES.invalidRequest)];
  }
  try {
    await dispatch(req.method, req.params);
    return [okResultFrame(id)];
  } catch (e) {
    if (e instanceof RpcError) {
      return [errorFrame(id, e.code, e.message)];
    }
    return [errorFrame(id, RPC_CODES.internalError, RPC_MESSAGES.internalError)];
  }
}

/**
 * IPC 会话：input（stdin）newline 分帧 → handleFrame → output（stdout）写行。
 * stdin EOF/error → finished resolve（优雅退出语义）。
 * @param {{ input: NodeJS.ReadableStream & { setEncoding?: (e: string) => void }, output: { write(s: string): unknown }, dispatch: (method: string, params: unknown) => Promise<{ ok: true }> }} opts
 * @returns {{ finished: Promise<void> }}
 */
export function createIpcSession({ input, output, dispatch }) {
  let buf = "";
  /** 无换行超限行的保留前缀（LIMIT+64B——id 扫描窗口） */
  let overflowPrefix = null;
  let done = false;
  const writeLine = (line) => {
    if (done) return;
    output.write(`${line}\n`);
  };
  const finish = () => {
    if (done) return;
    done = true;
    resolveFinished();
  };
  let resolveFinished = () => {};
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  if (typeof input.setEncoding === "function") input.setEncoding("utf8");
  input.on("data", (/** @type {string} */ chunk) => {
    if (done) return;
    buf += chunk;
    for (;;) {
      const i = buf.indexOf("\n");
      if (i === -1) break;
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      const meta = { overflowPrefix };
      overflowPrefix = null;
      void handleFrame(line, meta, dispatch).then((lines) => lines.forEach(writeLine));
    }
    // 无界行防护：超限且尚无换行 → 只保留首个前缀窗口（LIMIT+64B）供 id
    // 扫描，其余丢弃——恶意流不能撑爆内存
    if (buf.length > 0 && Buffer.byteLength(buf, "utf8") > IPC_FRAME_LIMIT_BYTES) {
      if (overflowPrefix === null) {
        overflowPrefix = Buffer.from(buf, "utf8").subarray(0, IPC_FRAME_LIMIT_BYTES + 64).toString("utf8");
      }
      buf = "";
    }
  });
  input.on("end", finish);
  input.on("error", finish);
  // 已结束的流（如 stdin ignore）不触发事件——调用方自行裁决生命周期
  return { finished };
}
