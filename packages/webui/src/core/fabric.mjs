// sidecar 进程内 Fabric 宿主生命周期（webui-plugin-kernel 收官接线 / design v2.3
// §1「薄核含互联=sidecar 宿主 fabric」+ §3.2 数据面经 serveHttp/fetchHttp）。
// 意图（2026-09-29）：
// 1. 凭证链权威=openspec/changes/archive/2026-09-24-home-hub/design.md §2（冻结）：
//    - dataDir 恒=DWEB_HOME（identity.key 与 join 同源——resolve_identity(Default)
//      读 <dataDir>/identity.key；dataDir != DWEB_HOME 的构造在本消费路径禁止）；
//    - relay 凭证从租约装配 CustomWithCaps：relays=[{url: lease.relay_url,
//      serverId: lease.server_id}]（无凭证 urls 形态在 restricted 中枢被拒——
//      relay.rs 事实，不采用）；
//    - deferStart 五步时序（root 姿态）：①Fabric.open(deferStart=true——构造期
//      零网络出站；不携带 fabricId 期望——dataDir 单 fabric 语义下既有 roster 即
//      权威，可能是设备配对加入的对方 fabric）→ ②root 姿态判定
//      （rootEndpointId==本机 endpointId）：root 走 ensureRelayCapabilities+
//      ③断言返回条目覆盖租约 (relay_url)；member（对方 fabric）跳过 ②③——
//      ensure 是 root-only（member 调用即 RosterError::NotRoot），其 capability
//      由 v2 兑换 OK2 附发并持久化、start() 同源注入 → ④endpointId 元组断言
//      （fabricId 断言只在 createRoot 采纳路径）→ ⑤fabric.start()。
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

/** z-base-32（iroh to_z32 语义）→ hex64 小写。字母表与 MSB-first 位序经
 * SDK ground-truth 向量校准（seed 0x07×32 → hex ea4a6c63…d22c ↔ z32 7jfgaa9n…4esy）。
 * @param {string} z32
 * @returns {string} */
export function z32ToHex(z32) {
  const A = "ybndrfg8ejkmcpqxot1uwisza345h769";
  let bits = 0;
  let value = 0n;
  const bytes = [];
  for (const ch of z32) {
    const idx = A.indexOf(ch);
    if (idx < 0) throw new Error(`invalid z32 char ${JSON.stringify(ch)}`);
    value = value * 32n + BigInt(idx);
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push(Number((value >> BigInt(bits)) & 0xffn));
      value = value % (1n << BigInt(bits));
    }
  }
  return Buffer.from(bytes).toString("hex");
}

/** hex64 小写 → z-base-32（iroh to_z32 语义；z32ToHex 的逆）。
 * 尾组对齐（真双机验收第二轮实证修正）：32B 键 = 256 bit = 51 字符 + 1 bit，
 * data_encoding 语义把残余位**左移到末字符 MSB**、低位补零——此前写成
 * `value & 31`（残余位落在 LSB），末位为 1 的键（约半数设备）产出错误末
 * 字符（对端解析成另一把公钥）；末位为 0 时两种写法重合（首轮双机恰好
 * 两台末端 bit 均 0 而侥幸通过）。
 * @param {string} hex
 * @returns {string} */
export function hexToZ32(hex) {
  const A = "ybndrfg8ejkmcpqxot1uwisza345h769";
  const bytes = Buffer.from(hex, "hex");
  let bits = 0;
  let value = 0n;
  let out = "";
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += A[Number((value >> BigInt(bits)) & 31n)];
      value = value % (1n << BigInt(bits));
    }
  }
  if (bits > 0) out += A[Number((value << BigInt(5 - bits)) & 31n)];
  return out;
}

/** 真实 SDK 面（动态 import——原生二进制只在首次 ensureStarted 才加载）。
 * 主入口是 NAPI CJS 加载器：cjs-module-lexer 无法静态识别其命名导出（真双机
 * 实测 import() 仅得 default），故 Fabric 必须经 default 互操作取；/http 子路径
 * 为手写 ESM 胶水，命名导出可靠。 */
async function defaultSdk() {
  const [sdk, httpGlue] = await Promise.all([import("@jixo/opendweb-client-sdk"), import("@jixo/opendweb-client-sdk/http")]);
  const Fabric = sdk.Fabric ?? sdk.default?.Fabric;
  if (typeof Fabric !== "function") throw new Error("client-sdk Fabric export not found (main entry interop)");
  return { Fabric, fetchHttp: httpGlue.fetchHttp ?? httpGlue.default?.fetchHttp, serveHttp: httpGlue.serveHttp ?? httpGlue.default?.serveHttp };
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
  /** LAN 直连宣告（host:port 列表；进 invite 令牌）与本端 QUIC 绑定地址。 */
  const advertiseAddrs = Array.isArray(opts.advertiseAddrs)
    ? opts.advertiseAddrs.filter((a) => typeof a === "string" && a !== "")
    : [];
  const bindAddr = typeof opts.bindAddr === "string" && opts.bindAddr !== "" ? opts.bindAddr : null;
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
   *
   * 回环 relay LAN 化（真双机验收实证）：中枢机自 join 的租约 relay_url 是
   * issuer 本机回环形态（http://127.0.0.1:3340）——对本机 relay 连接无碍，但
   * 以此装配 fabric 后签出的 invite 会把回环 relay 交给对端（跨机恒不可达；
   * 内核侧已按「直连在场剔回环」过滤，令牌将退化为纯直连——对端拿不到
   * bootstrap capability，redeem 后也没有 OK2 member capability 可持久化，
   * 会话期 relay 发现无路径）。宣告了 LAN 直连地址（advertiseAddrs）时把
   * 回环 host 改写为宣告地址的 host——relay 服务监听通配（*:3340），LAN
   * 形态对 issuer 本机与对端同等可用；无宣告则保留原样（单机部署语义）。
   */
  function lanRelayUrl(url) {
    if (advertiseAddrs.length === 0) return url;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return url;
    }
    const host = parsed.hostname;
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    if (!isLoopback) return url;
    const advHost = advertiseAddrs.map((a) => a.replace(/^\[|\]/g, "").split(":")[0]).find((h) => /^[0-9a-fA-F.:]+$/.test(h) && h !== "localhost" && !h.startsWith("127."));
    if (advHost === undefined) return url;
    parsed.hostname = advHost.includes(":") ? `[${advHost}]` : advHost;
    // URL 规范化会给空路径补尾 "/"——relay 配置串纪律是无尾斜杠原样形态
    return parsed.toString().replace(/\/$/, "");
  }

  async function readIdentity() {
    const ledger = await leasesLoader(home);
    const valid = ledger.leases.filter(
      (l) => typeof l.relay_url === "string" && l.relay_url !== "" && typeof l.server_id === "string" && l.server_id !== "",
    );
    if (valid.length === 0) return null;
    const lease = valid[0];
    return {
      lease,
      relays: valid.map((l) => ({ url: lanRelayUrl(l.relay_url), serverId: l.server_id })),
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
   * Fabric 事件接线（startSequence 与 joinWithToken 接管两路共用）：
   * peer-connected 绑 serveHttp + 在线回调；peer-disconnected 拆线+逐出会话。
   * @param {object} f Fabric 实例
   * @returns {() => void} 退订函数
   */
  function wireFabricEvents(f) {
    return f.on((ev) => {
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
    // ① deferStart 构造（零网络出站）。home-hub v17 §2 冻结语义：CLI join 是
    // 纯 JS（不建 roster）；roster 是 SDK createRoot 的产物——**首次 SDK 接触的
    // 已 join 设备没有 roster.facts**，open() 会 "no persisted roster"。正确次序：
    // 先 open（既有 roster 复用）；无 roster 错误 → createRoot 采纳租约 fabricId
    // 建册（真双机验收抓出的集成缺陷）。
    const ctorArgs = {
      dataDir: home,
      relay: { mode: "custom", relays: identity.relays },
      deferStart: true,
      // LAN 直连宣告（真双机验收定论：本地 relay 为 HTTP-only——QUIC 数据面需
      // TLS 证书未启用，P2P 唯一路径=直连；invite 令牌携带 issuer 直连地址，
      // 未宣告时对端无路可拨=dial-timeout）。来源：组装层 env 注入。
      ...(advertiseAddrs.length > 0 ? { advertiseAddrs } : {}),
      ...(bindAddr !== null ? { bindAddr } : {}),
    };
    let f;
    /** createRoot 采纳路径（自身为 root 建册）——fabricId 断言只在此路径成立 */
    let adoptedOwnFabric = false;
    try {
      // open 不携带 fabricId 期望（真双机验收实证修正）：dataDir 单 fabric 语义
      // 下既有 roster 即权威——它可能是设备配对（/sidecar/fabric/join）加入的
      // **对方 fabric**（fabricId ≠ 本机租约；携带期望会 DirFabricMismatch 误杀
      // member 重启）。无 roster 时 NotFound（"no persisted roster"）仍是
      // createRoot 采纳入口。
      f = await s.Fabric.open(ctorArgs);
    } catch (e) {
      const msg = String(/** @type {Error} */ (e)?.message ?? e);
      if (!/no persisted roster/i.test(msg)) throw e;
      f = await s.Fabric.createRoot({ ...ctorArgs, fabricId: identity.fabricId });
      adoptedOwnFabric = true;
    }
    if (status === "closed") {
      await f.shutdown().catch(() => {});
      throw Object.assign(new Error("fabric host closed during start"), { code: "closed" });
    }
    fabric = f;
    try {
      // ② 姿态判定（root vs member）：ensureRelayCapabilities 是 root-only 的
      // 自签 own capability——member（设备配对加入的对方 fabric）调用即
      // RosterError::NotRoot（真双机验收实证：caller=本机、root=邀请方）。
      // member 的 relay capability 由 v2 兑换 OK2 附发（join 内核已持久化
      // relay.caps.json），start() 同源注入；③的租约覆盖断言对 member 同样
      // 不适用——member 覆盖由邀请方 relay 集定义，非本机租约。
      const rootId = await f.rootEndpointId();
      const amRoot = rootId !== null && rootId === f.endpointId;
      if (amRoot) {
        const caps = await f.ensureRelayCapabilities();
        // ③ 覆盖断言（不匹配=fail-closed 不 start）
        assertRelayCoverage(caps, identity.relays);
      } else {
        log(`fabric: member posture (roster root ${rootId ?? "unset"} != local ${f.endpointId}); skipping root-only capability ensure`);
      }
      // ④ 元组断言（endpointId 连续性恒断言；fabricId 连续性只在 createRoot
      // 采纳路径断言——open 到的既有 roster 可能是设备配对（/sidecar/fabric/
      // join）加入的**对方 fabric**，其 fabricId ≠ 本机租约 fabricId 属预期，
      // dataDir 单 fabric 语义下该 roster 即权威）
      if (adoptedOwnFabric) {
        const fabricIdHex = await f.fabricIdHex();
        if (fabricIdHex !== identity.fabricId) {
          throw new Error(`fabric id mismatch: roster ${fabricIdHex} != lease ${identity.fabricId}`);
        }
      }
      // SDK 的 endpointId 是 z32 展示串（iroh to_z32：字母表 ybndrfg8ejkmcpqxot
      // 1uwisza345h769、MSB-first 位序——data_encoding 语义），租约 root 是 hex64
      // 小写（server 台账/server-access-roles 冻结形态）——同钥异码，先归一再比
      // （真双机验收抓出的断言缺陷：裸字符串比对恒 mismatch）。
      if (z32ToHex(f.endpointId) !== identity.endpointId.toLowerCase()) {
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
    unsubscribeEvents = wireFabricEvents(f);
    status = "started";
    log(`fabric: started (endpoint ${f.endpointId}, relays ${identity.relays.length}${adoptedOwnFabric ? "" : ", existing roster"})`);
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

  /** 拆除当前 fabric 句柄（close 与 joinWithToken 接管共用；幂等）。 */
  async function teardownFabric() {
    for (const s of servers.values()) {
      try {
        s.close?.();
      } catch {
        /* 关闭中的 server 异常不阻塞拆除 */
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
      // 归一：账本/租约存 hex64（server 台账冻结形态），SDK connect/openSession
      // 期望 z32 展示串——同钥异码（真双机验收抓出），hex 形态先转 z32 再用；
      // 缓存键也用归一后的 z32，避免同 peer 双键双会话。
      const peerKey = /^[0-9a-f]{64}$/.test(peer) ? hexToZ32(peer) : peer;
      peer = peerKey;
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

    /**
     * 设备配对——签发 invite 令牌（SDK 既有 invite 机制；webui 薄核「互联」义务，
     * 真双机验收补齐的引导面：CLI join 只做 server 台账登记，fabric 名册互认需
     * 一次性 invite→redeem）。
     * @param {{ ttlMs?: number }} [opts]
     * @returns {Promise<{ token: string }>}
     */
    async issueInvite(opts = {}) {
      // v2 invite（appendix A）：嵌入的 relay capability 必须预绑定受邀方
      // EndpointId——recipient 必填（hex64 或 z32 均可，SDK 侧按其解析面接受）。
      if (typeof opts?.recipient !== "string" || opts.recipient === "") {
        throw Object.assign(new Error("recipient (invitee endpoint id) is required for v2 invites"), { code: "invalid-request" });
      }
      const f = await ensureStarted();
      const token = await f.invite(opts.ttlMs ?? 10 * 60_000, opts.recipient);
      return { token };
    },

    /**
     * 设备配对——凭令牌加入对方 fabric（joinWithToken：attach+兑换+名册持久化，
     * 一次性；此后 open() 沿用该名册——重启走 startSequence 的 member 分支）。
     * 要求 dataDir 尚无本属 fabric 的 roster（单目录单 fabric——既有 roster 时
     * 报错并引导，不静默替换）。
     * @param {{ token: string }} opts
     * @returns {Promise<{ fabricId: string }>}
     */
    async joinWithToken(opts) {
      if (typeof opts?.token !== "string" || opts.token === "") {
        throw Object.assign(new Error("token is required"), { code: "invalid-request" });
      }
      const identity = await readIdentity();
      if (identity === null) {
        throw Object.assign(new Error("no lease with a usable relay on this device; join a hub first"), { code: "no-lease" });
      }
      const s = await loadSdk();
      const joined = await s.Fabric.joinWithToken(
        {
          dataDir: home,
          relay: { mode: "custom", relays: identity.relays },
          deferStart: true,
        },
        opts.token,
      );
      // 配对即接管（member 语义——真双机验收实证修正）：join 成功后本机是对方
      // fabric 的 **member**，ensureRelayCapabilities 是 root-only 自签 own
      // capability（member 调用即 RosterError::NotRoot：caller=本机、root=邀请方
      // ——此前接管序列照抄 root 五步的 ②③ 即现场报错根因）。member capability
      // 已由 v2 兑换 OK2 附发并持久化（relay.caps.json），start() 同源注入；租约
      // 覆盖断言对 member 不适用（覆盖由邀请方 relay 集定义，非本机租约）。
      // 兜底断言：兑换合并后名册必须有 Genesis root，且是邀请方而非本机。
      const rootId = await joined.rootEndpointId();
      if (rootId === null || rootId === joined.endpointId) {
        await joined.shutdown().catch(() => {});
        throw Object.assign(new Error(`joined fabric root is ${rootId ?? "unset"}; expected the inviter (redeem did not establish membership)`), { code: "join-failed" });
      }
      await teardownFabric().catch(() => {});
      fabric = joined;
      await joined.start();
      unsubscribeEvents = wireFabricEvents(joined);
      status = "started";
      failureCode = null;
      failureMessage = null;
      const fabricIdHex = await joined.fabricIdHex();
      return { fabricId: fabricIdHex };
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
      await teardownFabric().catch(() => {});
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
