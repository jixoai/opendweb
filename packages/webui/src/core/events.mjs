// 事件总线（home-hub [H4] Phase 2a / specs/webui「webui SDK 分层与进程内宿主」
// + design §5.1 事件 schema v1 冻结）。
// 意图：
// 1. 帧形状冻结：订阅者收到的永远是 `{v:1, type, payload, ts}`——v=1 版本位，
//    type ∈ EVENT_TYPES 四值，payload 由发射方定义（零 token 纪律同 sidecar），
//    ts=发射时刻（可注入 now，与 sidecar 同拍）；
// 2. close 语义：close 后 emit 静默（事件不再投递）、再订阅抛错——宿主以
//    close 为会话终点，之后任何订阅都是编程错误；
// 3. disposer：onEvent 返回取消订阅函数；对已 close 的总线调用 disposer 为
//    no-op（幂等）。
// 纯内存实现（node 标准库都不需要）；createConsole 经 sidecar 注入位接线。

/** schema v1 的事件类型全集（spec 冻结；knock-pending 的发射源 2b/2c 落地） */
export const EVENT_TYPES = ["state-change", "node-switch", "knock-pending", "error"];

/**
 * schema v1 帧构造（发射路径唯一出口——订阅者永远见整帧）。
 * @param {string} type
 * @param {unknown} payload
 * @param {number} ts
 * @returns {{ v: 1, type: string, payload: unknown, ts: number }}
 */
export function eventFrame(type, payload, ts) {
  return { v: 1, type, payload, ts };
}

export class EventBus {
  /**
   * @param {{ now?: () => number }} [opts]
   */
  constructor({ now = () => Date.now() } = {}) {
    /** @type {(() => number)} */
    this.#now = now;
    /** @type {Map<string, Set<(frame: { v: 1, type: string, payload: unknown, ts: number }) => void>>} */
    this.#subs = new Map();
    this.#closed = false;
  }

  /** @type {(() => number)} */
  #now;

  /** @type {Map<string, Set<(frame: { v: 1, type: string, payload: unknown, ts: number }) => void>>} */
  #subs;

  #closed;

  get closed() {
    return this.#closed;
  }

  /**
   * 订阅事件（schema v1 整帧投递）。
   * @param {string} type
   * @param {(frame: { v: 1, type: string, payload: unknown, ts: number }) => void} fn
   * @returns {() => void} disposer（幂等；close 后调用为 no-op）
   */
  on(type, fn) {
    if (this.#closed) throw new Error("event bus is closed: subscribing after close is a programming error");
    if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type ${String(type)} (schema v1: ${EVENT_TYPES.join(" | ")})`);
    if (typeof fn !== "function") throw new Error("event listener must be a function");
    let set = this.#subs.get(type);
    if (set === undefined) {
      set = new Set();
      this.#subs.set(type, set);
    }
    set.add(fn);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      set?.delete(fn);
    };
  }

  /**
   * 发射事件（组帧 `{v:1,type,payload,ts}`）。close 后静默（no-op）；订阅者
   * 抛出的异常不中断其他订阅者（逐个隔离投递）。
   * @param {string} type
   * @param {unknown} payload
   */
  emit(type, payload) {
    if (this.#closed) return;
    const set = this.#subs.get(type);
    if (set === undefined || set.size === 0) return;
    const frame = eventFrame(type, payload, this.#now());
    for (const fn of [...set]) {
      try {
        fn(frame);
      } catch {
        // 单个订阅者的异常不拖垮总线（也与 close-静默语义一致）
      }
    }
  }

  /** 关闭：清空订阅、此后 emit 静默、再订阅抛错。幂等。 */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#subs.clear();
  }
}
