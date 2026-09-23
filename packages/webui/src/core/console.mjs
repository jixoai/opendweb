// createConsole——sidecar 的进程内宿主（home-hub [H4] Phase 2a / specs/webui
// 「webui SDK 分层与进程内宿主」+ design §5.1 契约冻结）。
// 意图：
// 1. 契约冻结：返回 { urlFor(deepLink?), open(deepLink?), mode(), getSnapshot(),
//    onEvent(type,fn)→disposer, switchTarget(id), close() }；
// 2. open=宿主注入回调：opts.opener(url) 必填——core 零浏览器 spawn（CLI 壳
//    注入既有 openImpl 形态、tray 注入自身壳行为）；打开行为只经回调发生；
// 3. urlFor=纯函数：core 只生成 URL（`origin/?dweb_console=<cap>#<deepLink>`）；
//    capability 为一次性会话凭证（见 capability.mjs）——**非 hub-token/admin
//    token**（后者永不入 URL）；query 不落 sidecar 访问日志、SPA 施加
//    no-referrer（index.html 一行）；
// 4. 事件 schema v1（events.mjs）：close 后事件静默、再订阅抛错；
// 5. getSnapshot=调用时刻同步快照（{mode,node,hub}——leases/visits/hub 数据面
//    2b/2c 落地，槽位已留）；
// 6. switchTarget=进程内直调（sidecar controls.switchNode——不经 HTTP）。
// 其余 opts 透传 createSidecar（target/token/port/distDir/log/dns/now/
// nodesFile/nodesStore——见 core/sidecar.mjs）。

import { EventBus, EVENT_TYPES } from "./events.mjs";
import { createCapabilities, CAPABILITY_TTL_MS } from "./capability.mjs";
import { createSidecar } from "./sidecar.mjs";

/** urlFor/open 的 query 参数名（会话 capability v1 引导位） */
export const CAPABILITY_QUERY_PARAM = "dweb_console";

/**
 * 深链归一：`"/lease"` → `"#/lease"`；`"#/lease"` 原样。仅接受 hash 路由
 * 形态（字母数字与 URL 安全路径字符）——query 语义位不允许出现在深链里。
 * @param {string | undefined | null} deepLink
 * @returns {string | undefined}
 */
function normalizeDeepLink(deepLink) {
  if (deepLink === undefined || deepLink === null) return undefined;
  if (typeof deepLink !== "string") throw new TypeError("deepLink must be a string like '#/lease'");
  const frag = deepLink.startsWith("#") ? deepLink : `#${deepLink}`;
  if (!/^#\/[A-Za-z0-9\-._~/]*$/.test(frag) || frag === "#/") {
    throw new TypeError(`deepLink must look like '#/lease' (hash-route path only), got: ${JSON.stringify(deepLink)}`);
  }
  return frag;
}

/**
 * 进程内控制台宿主（design §5.1 契约冻结）。
 * @param {{ opener: (url: string) => void } & Record<string, unknown>} opts
 *   - opener（必填）：浏览器/壳行为注入回调——core 自身零浏览器 spawn
 *   - capabilityTtlMs：会话 capability TTL（缺省 120s）
 *   - random/now：CSPRNG 与时钟注入（测试面；now 同时喂 sidecar/事件/capability）
 *   - 其余字段透传 createSidecar（target/token/port/distDir/log/allowInsecure/
 *     dns/nodesFile/nodesStore）
 * @returns {Promise<ConsoleHandle>}
 */
export async function createConsole(opts = {}) {
  const { opener, capabilityTtlMs = CAPABILITY_TTL_MS, random, ...rest } = opts;
  if (typeof opener !== "function") {
    throw new Error("createConsole: opts.opener(url) is required (the core never spawns a browser itself)");
  }
  const now = typeof rest.now === "function" ? rest.now : () => Date.now();
  const bus = new EventBus({ now });
  const capabilities = createCapabilities({ ttlMs: capabilityTtlMs, now, random });
  const sidecar = await createSidecar({ ...rest, now, bus, capabilities });

  let closed = false;
  /** @param {string} [message] */
  const assertOpen = (message) => {
    if (closed) throw new Error(message ?? "console is closed");
  };

  /**
   * 纯函数 URL 生成：新签 capability + 深链归一——不做任何 IO/打开动作。
   * @param {string} [deepLink]
   * @returns {string}
   */
  function urlFor(deepLink) {
    assertOpen("urlFor: console is closed (capabilities were invalidated on close)");
    const frag = normalizeDeepLink(deepLink);
    const cap = capabilities.issue();
    const url = `${sidecar.origin}/?${CAPABILITY_QUERY_PARAM}=${cap}`;
    return frag === undefined ? url : `${url}${frag}`;
  }

  return {
    urlFor,
    /**
     * 打开控制台（宿主注入回调路径——core 不自带任何 spawn）。
     * @param {string} [deepLink]
     */
    open(deepLink) {
      assertOpen("open: console is closed");
      opener(urlFor(deepLink));
    },
    /** @returns {"setup" | "ready"} */
    mode() {
      return sidecar.mode();
    },
    /** 调用时刻同步快照（{mode,node,hub}——hub/leases/visits 槽位见 design §5.1）。 */
    getSnapshot() {
      return sidecar.controls.snapshot();
    },
    /**
     * 订阅 schema v1 事件（整帧 `{v:1,type,payload,ts}` 投递）。
     * @param {string} type
     * @param {(frame: { v: 1, type: string, payload: unknown, ts: number }) => void} fn
     * @returns {() => void} disposer
     */
    onEvent(type, fn) {
      assertOpen("onEvent: console is closed (subscribing after close is an error; events are silent after close)");
      return bus.on(type, fn);
    },
    /**
     * 进程内直调切换目标（不经 HTTP；与 POST /sidecar/nodes/switch 同一序列
     * 核心——校验/互斥/原子替换/事件逐一致）。失败：emit 一帧 error 后抛错。
     * @param {string} id
     */
    async switchTarget(id) {
      assertOpen("switchTarget: console is closed");
      if (typeof id !== "string" || id === "") throw new TypeError("switchTarget: node id must be a non-empty string");
      const r = await sidecar.controls.switchNode(id);
      if (!r.ok) {
        bus.emit("error", { code: r.code, source: "switch-target" });
        throw new Error(`switchTarget failed: ${r.code} (${r.message})`);
      }
      return { node: { id: r.node.id, name: r.node.name, server_host: r.node.server_host, added_at: r.node.added_at, current: true } };
    },
    /** 关闭：sidecar 停机 + capability 即失效 + 事件总线封闭（静默/再订阅抛错）。幂等。 */
    async close() {
      if (closed) return;
      closed = true;
      await sidecar.close(); // 内含 capabilities.close()
      bus.close();
    },
  };
}

/**
 * @typedef {Object} ConsoleHandle
 * @property {(deepLink?: string) => string} urlFor
 * @property {(deepLink?: string) => void} open
 * @property {() => "setup" | "ready"} mode
 * @property {() => { mode: "setup" | "ready", node: { id: string, name: string, server_host: string, added_at: number, current: boolean } | null, hub: null }} getSnapshot
 * @property {(type: string, fn: (frame: { v: 1, type: string, payload: unknown, ts: number }) => void) => () => void} onEvent
 * @property {(id: string) => Promise<{ node: { id: string, name: string, server_host: string, added_at: number, current: boolean } }>} switchTarget
 * @property {() => Promise<void>} close
 */

export { EVENT_TYPES };
