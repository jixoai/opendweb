// sidecar 进程内 Fabric 宿主生命周期（webui-plugin-kernel 收官接线 / design v2.3
// §1「薄核含互联=sidecar 宿主 fabric」+ §3.2 数据面经 serveHttp/fetchHttp）。
// 意图（2026-09-29）：
// 1. 凭证链权威=openspec/changes/archive/2026-09-24-home-hub/design.md §2（冻结）：
//    - dataDir 恒=DWEB_HOME（identity.key 与 join 同源——resolve_identity(Default)
//      读 <dataDir>/identity.key；dataDir != DWEB_HOME 的构造在本消费路径禁止）；
//    - relay 凭证从租约装配 CustomWithCaps：relays=[{url: lease.relay_url,
//      serverId: lease.server_id}]（无凭证 urls 形态在 restricted 中枢被拒——
//      relay.rs 事实，不采用）；
//    - deferStart 五步时序：①Fabric.open(deferStart=true——构造期零网络出站)
//      → ②ensureRelayCapabilities（deferred 态可执行）→ ③断言返回条目覆盖租约
//      (relay_url) 且 token 注入同实例 → ④fabric_id/endpointId 元组断言
//      （fabricIdHex()==lease.fabric_id、endpointId==lease.root）→ ⑤fabric.start()。
//      ②③④任一不符=fail-closed（不 start、明确报错、不静默降级）。
// 2. 惰性启动：构造本模块零 Fabric 构造、零网络——ensureStarted() 才走五步
//    （single-flight）。触发源=任一数据面插件 enable（sidecar 组装处 onTransition）
//    或消费侧 sessionResolver 首用（数据面需求）。无数据面插件的 sidecar 不付出
//    fabric 连接代价（bind/relay 接触/会话保活全为零）。
// 3. 会话解析器 sessionResolver(peer)→SessionHandle：per-peer 缓存
//    （SessionHandle 内建 auto-resume——长缓存即设计）；失效=peer-disconnected
//    事件 / 会话 onState 投影 disconnected/closing（订阅解绑+缓存逐出，下次
//    调用重开）。resolvePeerBySession(sessionId)→peer 反查（files 授权与
//    sync/serveHttp 请求同一张 sessionId→peer 表——noteSession 由聚合路由
//    在每个入站请求上登记）。
// 4. 提供侧：peer-connected → serveHttp(fabric, peer, router(peer, req))
//    （per-peer 绑定；peer-disconnected → server.close()）。router 由组装处
//    setRouter 注入（createWpkRouter 聚合路由——/wpk1/<plugin>/<...> 分发，
//    未启用 deny/未知插件 404）。
// 5. close 顺序：serveHttp servers 关闭 → 缓存会话 close → 事件退订 →
//    fabric.shutdown()（幂等；sidecar close 路径在 plugins.close() 之后调用
//    ——插件先 drain 在途数据面活动，再拆 fabric）。
// 6. 测试注入面：sdk={Fabric, fetchHttp, serveHttp} 可注入替身（真实面=
//    @jixo/opendweb-client-sdk + /http 胶水——动态 import，模块加载期不触碰
//    原生二进制）；leasesLoader 可注入（缺省 opendweb/src/leases.mjs loadLeases）。
// 零凭证：本模块不读 argv/env 凭证；身份经 <DWEB_HOME>/identity.key（SDK
// resolve_identity 语义）与租约（relays/元组断言材料）。

import os from "node:os";
import { loadLeases } from "opendweb/src/leases.mjs";

/** 真实 SDK 面（动态 import——原生二进制只在首次 ensureStarted 才加载）。 */
async function defaultSdk() {
  const [sdk, httpGlue] = await Promise.all([import("@jixo/opendweb-client-sdk"), import("@jixo/opendweb-client-sdk/http")]);
  return { Fabric: sdk.Fabric, fetchHttp: httpGlue.fetchHttp, serveHttp: httpGlue.serveHttp };
}

/** 静态 JSON 响应（serveHttp handler 形状）。 */
function jsonResp(status, code, message) {
  return {
    status,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyChunks: [Buffer.from(JSON.stringify({ error: { code, message } }), "utf8")],
  };
}

/**
 * Fabric 宿主（sidecar 数据面底座）。
 * @param {{
 *   home: string,
 *   sdk?: { Fabric: object, fetchHttp: Function, serveHttp: Function },
 *   leasesLoader?: (home: string) => Promise<{ version: 1, leases: Array<Record<string, unknown>> }>,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   deviceName?: string,
 * }} opts
 * @returns {Promise<import("./fabric.mjs").FabricHost>}
 */
export async function createFabricHost(opts = {}) {
  const { home } = opts;
  if (typeof home !== "string" || home === "") throw new Error("createFabricHost: home (DWEB_HOME absolute path) is required");
  const leasesLoader = opts.leasesLoader ?? loadLeases;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());

  /** @type {{ Fabric: object, fetchHttp: Function, serveHttp: Function } | null} */
  let sdk = opts.sdk ?? null;
  const loadSdk = async () => {
    if (sdk === null) sdk = await defaultSdk();
    return sdk;
  };

  /**
   * @typedef {Object} SessionCacheEntry
   * @property {object} session SessionHandle
   * @property {boolean} closed
   * @property {() => void} unsubscribe onState 退订
   */
  /** @type {Map<string, SessionCacheEntry>} peer → 会话缓存 */
  const sessions = new Map();
  /** @type {Map<string, string>} sessionId → peer（本端打开的会话 + 入站 serveHttp 请求登记） */
  const sessionPeers = new Map();
  /** @type {Map<string, { close: (reason?: string) => unknown }>} peer → serveHttp server 句柄 */
  const servers = new Map();
  /** @type {Set<string>} 已连接 peer（router 后置绑定与 close 清点用） */
  const connectedPeers = new Set();
  /** @type {((peerId: string) => void)[]} 会话在线回调（sync 调度器 notifyOnline 接线） */
  const peerOnlineCallbacks = new Set();

  /** @type {((peerId: string, req: object) => Promise<object | null | void>) | null} */
  let router = null;
  /** @type {object | null} Fabric 实例 */
  let fabric = null;
  /** @type {(() => void) | null} fabric.on 退订 */
  let unsubscribeEvents = null;
  let status = /** @type {"idle" | "starting" | "started" | "failed" | "closed"} */ ("idle");
  let failureCode = null;
  let failureMessage = null;
  /** @type {Promise<object> | null} single-flight start */
  let startPromise = null;

  /**
   * 读租约并推导身份/relays（home-hub §2：单 fabric 约束——leases 的 fabric 维度
   * 恒 1，取首条为元组断言期望）。无租约/无可用 relay 条目 → null（本设备未加入
   * 任何中枢——数据面不可用是明示事实，不是错误）。
   */
  async function readIdentity() {
    const ledger = await leasesLoader(home);
    const valid = ledger.leases.filter(
      (l) => typeof l.relay_url === "string" && l.relay_url !== "" && typeof l.server_id === "string" && l.server_id !== "",
    );
    if (valid.length === 0) return null;
    const lease = valid[0];
    return {
      lease,
      relays: valid.map((l) => ({ url: l.relay_url, serverId: l.server_id })),
      fabricId: lease.fabric_id,
      endpointId: lease.root,
      deviceName: opts.deviceName ?? lease.alias ?? os.hostname(),
    };
  }

  /**
   * ③断言：ensureRelayCapabilities 返回条目覆盖租约 (relay_url)。
   * @param {Array<{ url: string }>} caps
   * @param {Array<{ url: string }>} relays
   */
  function assertRelayCoverage(caps, relays) {
    const covered = new Set(caps.map((c) => c.url));
    const missing = relays.filter((r) => !covered.has(r.url)).map((r) => r.url);
    if (missing.length > 0) {
      throw new Error(`ensureRelayCapabilities did not cover lease relays: ${missing.join(", ")}`);
    }
  }

  /** 绑定单 peer 的 serveHttp（幂等——已绑定即返回）。 */
  async function bindPeer(peer) {
    if (status === "closed" || servers.has(peer)) return;
    const s = await sdk.serveHttp(fabric, peer, (req) => {
      if (router === null) return Promise.resolve(jsonResp(503, "router-missing", "the wpk router is not wired yet"));
      return router(peer, req);
    });
    if (status === "closed") {
      try {
        s.close?.();
      } catch {
        /* close 竞态：句柄即弃 */
      }
      return;
    }
    servers.set(peer, s);
  }

  function unbindPeer(peer) {
    const s = servers.get(peer);
    if (s !== undefined) {
      try {
        s.close?.();
      } catch {
        /* close 异常不阻塞拆线 */
      }
      servers.delete(peer);
    }
    evictSession(peer);
  }

  /** 逐出（并关闭）peer 的缓存会话。 */
  function evictSession(peer) {
    const hit = sessions.get(peer);
    if (hit === undefined) return;
    sessions.delete(peer);
    sessionPeers.delete(hit.session.sessionId);
    try {
      hit.unsubscribe();
    } catch {
      /* 退订异常忽略 */
    }
    if (!hit.closed) {
      hit.closed = true;
      Promise.resolve(hit.session.close?.()).catch(() => {});
    }
  }

  /**
   * 五步时序（home-hub §2 冻结；②→③→④→⑤逐条 fail-closed）。
   * @returns {Promise<object>} Fabric 实例
   */
  async function startSequence() {
    status = "starting";
    const identity = await readIdentity();
    if (identity === null) {
      throw Object.assign(new Error("no lease with a usable relay on this device; join a hub first (opendweb hub join)"), {
        code: "no-lease",
      });
    }
    const s = await loadSdk();
    // ① deferStart 构造（零网络出站；open=既有 root 名册路径——home 设备 join 后
    // roster 已在 <DWEB_HOME>，createRoot 会 AlreadyExists）
    const f = await s.Fabric.open({
      dataDir: home,
      relay: { mode: "custom", relays: identity.relays },
      deferStart: true,
      fabricId: identity.fabricId,
    });
    if (status === "closed") {
      await f.shutdown().catch(() => {});
      throw Object.assign(new Error("fabric host closed during start"), { code: "closed" });
    }
    fabric = f;
    try {
      // ② 显式 ensure（deferred 态可执行——root roster 与 RelayMap 已就绪）
      const caps = await f.ensureRelayCapabilities();
      // ③ 覆盖断言（不匹配=fail-closed 不 start）
      assertRelayCoverage(caps, identity.relays);
      // ④ 元组断言（fabric_id / endpointId 与租约连续性——桥接层错误防御）
      const fabricIdHex = await f.fabricIdHex();
      if (fabricIdHex !== identity.fabricId) {
        throw new Error(`fabric id mismatch: roster ${fabricIdHex} != lease ${identity.fabricId}`);
      }
      if (f.endpointId !== identity.endpointId) {
        throw new Error(`endpoint id mismatch: fabric ${f.endpointId} != lease root ${identity.endpointId}`);
      }
      // ⑤ start（原构造期语义后移——缓存票据注入/bind/online）
      await f.start();
    } catch (e) {
      await f.shutdown().catch(() => {});
      fabric = null;
      throw e;
    }
    // 事件接线（start 后才有会话事件）：peer-connected 绑 serveHttp + 在线回调；
    // peer-disconnected 拆线+逐出会话
    unsubscribeEvents = f.on((ev) => {
      if (ev?.type === "peer-connected" && typeof ev.endpointId === "string") {
        connectedPeers.add(ev.endpointId);
        bindPeer(ev.endpointId).catch((err) => log(`fabric: serveHttp bind failed for ${ev.endpointId}: ${err?.message ?? err}`));
        for (const cb of peerOnlineCallbacks) {
          try {
            cb(ev.endpointId);
          } catch {
            /* 回调异常不进事件泵 */
          }
        }
      } else if (ev?.type === "peer-disconnected" && typeof ev.endpointId === "string") {
        connectedPeers.delete(ev.endpointId);
        unbindPeer(ev.endpointId);
      }
    });
    status = "started";
    log(`fabric: started (endpoint ${f.endpointId}, relays ${identity.relays.length})`);
    return f;
  }

  /**
   * 惰性启动入口（single-flight；失败可重试——Failed 态语义）。
   * @returns {Promise<object>}
   */
  function ensureStarted() {
    if (status === "started") return Promise.resolve(fabric);
    if (status === "closed") return Promise.reject(new Error("fabric host is closed"));
    if (startPromise !== null) return startPromise;
    startPromise = startSequence()
      .then((f) => {
        startPromise = null;
        return f;
      })
      .catch((e) => {
        startPromise = null;
        status = "failed";
        failureCode = e?.code ?? "start-failed";
        failureMessage = e?.message ?? String(e);
        log(`fabric: start failed (${failureCode}): ${failureMessage}`);
        throw e;
      });
    return startPromise;
  }

  return {
    /** 惰性启动（single-flight；触发=数据面插件 enable 或消费侧首用）。 */
    ensureStarted,

    /** 身份投影（读租约推导；无租约=null——sync runtime 的 endpointId/deviceName 源）。 */
    async identity() {
      return readIdentity();
    },

    /**
     * 消费侧会话解析器（ports/sync fetchHttp 的 session 源）。
     * @param {string} peer 对端 endpointId
     * @returns {Promise<object>} SessionHandle
     */
    async sessionResolver(peer) {
      if (typeof peer !== "string" || peer === "") throw new Error("sessionResolver: peer endpoint id is required");
      const f = await ensureStarted();
      const hit = sessions.get(peer);
      if (hit !== undefined && !hit.closed) return hit.session;
      if (hit !== undefined) evictSession(peer);
      await f.connect(peer); // 幂等（活跃连接直接成功）
      const session = await f.openSession(peer);
      const entry = {
        session,
        closed: false,
        unsubscribe:
          typeof session.onState === "function"
            ? session.onState((st) => {
                if (st?.phase === "disconnected" || st?.phase === "closing") evictSession(peer);
              })
            : () => {},
      };
      if (status === "closed") {
        Promise.resolve(session.close?.()).catch(() => {});
        throw new Error("fabric host is closed");
      }
      sessions.set(peer, entry);
      sessionPeers.set(session.sessionId, peer);
      return session;
    },

    /**
     * 入站请求登记（聚合路由逐请求调用——files 授权的 sessionId→peer 反查源）。
     * @param {string} sessionId
     * @param {string} peer
     */
    noteSession(sessionId, peer) {
      if (typeof sessionId === "string" && sessionId !== "" && typeof peer === "string" && peer !== "") {
        sessionPeers.set(sessionId, peer);
      }
    },

    /**
     * sessionId → peer 反查（files resolvePeer 注入面；未知=null=deny-by-default）。
     * @param {string} sessionId
     * @returns {Promise<string | null>}
     */
    async resolvePeerBySession(sessionId) {
      return sessionPeers.get(sessionId) ?? null;
    },

    /**
     * 聚合路由注入（组装处 createWpkRouter 产物；绑定发生在 peer-connected——
     * 已连接 peer 防御性补绑）。
     * @param {(peerId: string, req: object) => Promise<object | null | void>} fn
     */
    setRouter(fn) {
      router = fn;
      if (status === "started") {
        for (const peer of [...connectedPeers]) {
          bindPeer(peer).catch((err) => log(`fabric: serveHttp rebind failed for ${peer}: ${err?.message ?? err}`));
        }
      }
    },

    /**
     * 会话在线回调（sync 调度器 notifyOnline 的触发源）。
     * @param {(peerId: string) => void} cb
     * @returns {() => void} disposer
     */
    onPeerOnline(cb) {
      peerOnlineCallbacks.add(cb);
      return () => peerOnlineCallbacks.delete(cb);
    },

    /** 观测面（测试/日志）。 */
    status() {
      return { status, failureCode, failureMessage, sessions: sessions.size, servers: servers.size, fabric: fabric !== null };
    },

    /** client-sdk /http fetchHttp 直通（ports runtime fetchHttpImpl 注入面）。 */
    async fetchHttpImpl(session, request) {
      const s = await loadSdk();
      return s.fetchHttp(session, request);
    },

    /**
     * 关闭（sidecar close 路径——在 plugins.close() 之后调用）：serveHttp 拆线 →
     * 会话关闭 → 事件退订 → fabric.shutdown()。幂等。
     */
    async close() {
      if (status === "closed") return;
      status = "closed";
      startPromise = null;
      for (const s of servers.values()) {
        try {
          s.close?.();
        } catch {
          /* 同上 */
        }
      }
      servers.clear();
      connectedPeers.clear();
      for (const peer of [...sessions.keys()]) evictSession(peer);
      sessionPeers.clear();
      try {
        unsubscribeEvents?.();
      } catch {
        /* 退订异常忽略 */
      }
      unsubscribeEvents = null;
      const f = fabric;
      fabric = null;
      if (f !== null) await f.shutdown().catch(() => {});
    },
  };
}

/** /wpk1/ 版本化前缀（design §3.2——聚合路由的分发键）。 */
export const WPK_PREFIX = "/wpk1/";

/**
 * 聚合路由（/wpk1/<plugin>/<...> → 各插件 handler；serveHttp 单挂点）。
 * 分发矩阵：非 /wpk1 前缀/未装配路由的插件 → 404（unknown-plugin）；插件已装配
 * 但未启用（宿主 isAccepting=false，含从未 enabled 与停用摘牌中）→ 503
 * plugin-disabled（deny）；授权判定（ports allowlist / files peers / sync
 * group members）在各插件 handler 内 deny-by-default——路由层不重复判定。
 * @param {{
 *   gate: (pluginId: string) => boolean,
 *   routes: Record<string, (req: object, peer: string) => Promise<object | null | void>>,
 * }} opts
 * @returns {(peer: string, req: object) => Promise<object | null | void>}
 */
export function createWpkRouter(opts) {
  const { gate, routes } = opts;
  if (typeof gate !== "function") throw new Error("createWpkRouter: gate (pluginId) => boolean is required");
  if (routes === null || typeof routes !== "object") throw new Error("createWpkRouter: routes {pluginId: handler} is required");
  return async function wpkRouter(peer, req) {
    const path = typeof req?.path === "string" ? req.path : "";
    if (!path.startsWith(WPK_PREFIX)) {
      return jsonResp(404, "not-found", `the fabric data plane only serves ${WPK_PREFIX} paths`);
    }
    const plugin = path.slice(WPK_PREFIX.length).split("?")[0].split("/")[0];
    const route = routes[plugin];
    if (route === undefined) {
      return jsonResp(404, "unknown-plugin", `no webui plugin is mounted at ${WPK_PREFIX}${plugin}`);
    }
    if (!gate(plugin)) {
      return jsonResp(503, "plugin-disabled", `plugin "${plugin}" is not enabled on this device`);
    }
    return route(req, peer);
  };
}

/**
 * sync handler 适配器：serveHttp 请求形状 → sync 端点请求形状（body 转
 * AsyncIterable 拉流——端点内 readBoundedJsonLines 自持有界）；响应
 * {status, body} → serveHttp {status, headers, bodyChunks}。
 * @param {(request: { method: string, path: string, body?: object, sessionId?: string, peerEndpointId?: string, signal?: AbortSignal }) => Promise<{ status: number, body: Uint8Array }>} handler sync 端点 handler
 * @returns {(req: object, peer: string) => Promise<object | null>}
 */
export function adaptSyncHandler(handler) {
  return async function syncRoute(req, peer) {
    /** @type {Buffer[]} */
    const parts = [];
    let done = false;
    const body = {
      async *[Symbol.asyncIterator]() {
        while (!done) {
          let chunk;
          try {
            chunk = await req.bodyNext();
          } catch {
            return; // 拉取失败（会话终态）：流提前 EOF，端点侧按截断体拒绝
          }
          if (chunk === null) {
            done = true;
            return;
          }
          yield chunk;
        }
      },
    };
    const res = await handler({
      method: req.method,
      path: req.path,
      body,
      sessionId: req.sessionId,
      peerEndpointId: peer,
      signal: req.signal,
    });
    done = true;
    return {
      status: res.status,
      headers: [{ name: "content-type", value: "application/json" }],
      bodyChunks: [res.body],
    };
  };
}

/**
 * @typedef {Object} FabricHost
 * @property {() => Promise<object>} ensureStarted
 * @property {() => Promise<{ lease: object, relays: Array<{ url: string, serverId: string }>, fabricId: string, endpointId: string, deviceName: string } | null>} identity
 * @property {(peer: string) => Promise<object>} sessionResolver
 * @property {(sessionId: string, peer: string) => void} noteSession
 * @property {(sessionId: string) => Promise<string | null>} resolvePeerBySession
 * @property {(fn: (peerId: string, req: object) => Promise<object | null | void>) => void} setRouter
 * @property {(cb: (peerId: string) => void) => () => void} onPeerOnline
 * @property {() => { status: string, failureCode: string | null, failureMessage: string | null, sessions: number, servers: number, fabric: boolean }} status
 * @property {(session: object, request: object) => Promise<object>} fetchHttpImpl
 * @property {() => Promise<void>} close
 */
