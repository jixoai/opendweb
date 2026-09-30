// 三插件运行时组装（webui-plugin-kernel 收官接线 / design v2.3 §1+§3.2）。
// 意图（2026-09-29）：
// 1. 三个 ext 包工厂的单一装配点：createPortsRuntime/createFilesRuntime/
//    createSyncRuntime 经注入面共享同一 fabric 宿主——消费侧 sessionResolver
//    同源（ports 映射代理与 sync 拉取推送到同一对端用同一缓存会话）、提供侧
//    resolvePeer 同源（files 授权的 sessionId→peer 反查与聚合路由登记同表）。
// 2. sync 身份=fabric 宿主 identity()（home-hub §2 冻结：endpointId==lease.root、
//    deviceName=alias 快照——读租约推导，不启动 fabric）；无租约设备=sync 运行时
//    不装配（管理面明确 unavailable，不冒充可同步），ports/files 运行时照常
//    （账本/监听不依赖身份，数据面调用时才经 sessionResolver 惰性起 fabric）。
// 3. 宿主 runtimes 通道适配：ports/files 原生即 PluginRuntime 形状；sync 包装
//    onEnable（recoverAll+全组 scheduler.start）与 onDispose（scheduler.dispose）；
//    会话在线事件（fabric peer-connected）→ 各组 scheduler.notifyOnline。
// 4. sync fetchImpl 适配：client-sdk fetchHttp（分块请求体/pull-first 响应）→
//    sync 契约 {method, path, body: Uint8Array, signal} → {status, body}。
// 5. 运行时工厂=惰性动态 import（buildPluginRuntimes 首次调用才加载）：CLI 的
//    --help 零执行路径与 target 校验失败路径保持零 ext 依赖加载（dispatch-fold
//    e2e 语义不变）；真实安装按 package.json dependencies 解析。
// 零凭证：本模块不读 argv/env；一切会话经注入的 fabric 宿主。

import { z32ToHex } from "../fabric.mjs";

/**
 * sync fetchImpl 适配（client-sdk fetchHttp → sync 契约）。
 * @param {(session: unknown, request: object) => Promise<{ bodyNext: () => Promise<Buffer | null>, status: number }>} fetchHttp
 */
function toSyncFetch(fetchHttp) {
  return async (session, req) => {
    const resp = await fetchHttp(session, {
      method: req.method,
      path: req.path,
      ...(req.body != null ? { body: [req.body] } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
    /** @type {Buffer[]} */
    const parts = [];
    for (;;) {
      const chunk = await resp.bodyNext();
      if (chunk === null) break;
      parts.push(chunk);
    }
    return { status: resp.status, body: new Uint8Array(Buffer.concat(parts)) };
  };
}

/**
 * 组装三插件运行时（sidecar 组装处消费）。
 * @param {{
 *   home: string,
 *   fabric: import("../fabric.mjs").FabricHost,
 *   log?: (line: string) => void,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<{
 *   channel: Record<string, { onEnable: (ctx: { home: string, dataDir: string }) => Promise<void>, onDispose: () => Promise<void> }>,
 *   management: { ports: object, files: object, sync: object | null, syncUnavailable: string | null },
 * }>}
 */
export async function buildPluginRuntimes(opts) {
  const { home, fabric } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());

  // 惰性加载（见头注 5；三包并行动态 import——真实面=workspace 链接）
  const [{ createPortsRuntime }, { createFilesRuntime }, { createSyncRuntime }] = await Promise.all([
    import("@jixo/opendweb-ext-ports"),
    import("@jixo/opendweb-ext-files"),
    import("@jixo/opendweb-ext-sync"),
  ]);

  const ports = await createPortsRuntime({
    home,
    fetchHttpImpl: (session, request) => fabric.fetchHttpImpl(session, request),
    sessionResolver: (peer) => fabric.sessionResolver(peer),
    now,
    log: (level, msg) => log(`ports(${level}): ${msg}`),
  });

  const files = await createFilesRuntime({
    home,
    now,
    log: (line) => log(`files: ${line}`),
    resolvePeer: (sessionId) => fabric.resolvePeerBySession(sessionId),
  });

  const identity = await fabric.identity();
  /** @type {ReturnType<typeof createSyncRuntime> | null} */
  let sync = null;
  let syncUnavailable = "no lease on this device; join a hub first (opendweb hub join) before managing sync groups";
  if (identity !== null) {
    sync = createSyncRuntime({
      home,
      endpointId: identity.endpointId,
      deviceName: identity.deviceName,
      now,
      fetchImpl: toSyncFetch((session, request) => fabric.fetchHttpImpl(session, request)),
      sessionResolver: (peer) => fabric.sessionResolver(peer),
      log: {
        debug: (m) => log(`sync(debug): ${m}`),
        info: (m) => log(`sync: ${m}`),
        warn: (m) => log(`sync(warn): ${m}`),
        error: (m) => log(`sync(error): ${m}`),
      },
    });
    syncUnavailable = null;
    // 会话在线 → 组调度跟随（design §7.5 触发源之一；notifyOnline 对未调度组
    // 是 no-op——无需在此判定插件启停）。peer 事件 endpointId 是 z32 展示串、
    // 组成员登记 hex64——同钥异码先归一再比（真双机验收 F-sync 同族修复，
    // 2026-09-30；归一与 fabric.mjs z32ToHex 同源语义，此处内联保守实现）
    fabric.onPeerOnline((peer) => {
      const peerHex = /^[0-9a-f]{64}$/.test(peer) ? peer : /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/.test(peer) ? z32ToHex(peer) : peer;
      sync
        .listGroups()
        .then((groups) => {
          for (const g of groups) {
            if (g.members.some((m) => m.endpointId.toLowerCase() === peerHex)) sync.scheduler.notifyOnline(g.id);
          }
        })
        .catch(() => {});
    });
  }

  const channel = {
    ports,
    files,
    ...(sync !== null
      ? {
          sync: {
            /** enable 逆序装配：崩溃恢复（recoverAll）→ 全组调度启动。 */
            onEnable: async (ctx) => {
              await sync.runtimeHooks.onEnable(ctx);
              for (const g of await sync.listGroups()) sync.scheduler.start(g.id);
            },
            onDispose: sync.runtimeHooks.onDispose,
          },
        }
      : {}),
  };

  return {
    channel,
    management: { ports, files, sync, syncUnavailable },
  };
}
