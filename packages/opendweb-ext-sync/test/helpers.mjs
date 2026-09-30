// 测试公共件（webui-plugin-kernel Phase 3——fixture 一律临时目录；进程显式
// 回收：本套件无常驻进程，只有 tmpdir 资源，after 钩子统一 rm）。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 临时 DWEB_HOME。
 * @param {string} [prefix]
 */
export async function makeHome(prefix = "dweb-sync-test-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * 临时同步根 + 写入初始文件树。
 * @param {Record<string, string | Uint8Array>} files 相对路径 → 内容
 * @param {string} [prefix]
 */
export async function makeRoot(files = {}, prefix = "dweb-sync-root-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

/**
 * 双端 loopback 装配：两台设备的 runtime 互相以内存 fetchImpl 直调对端
 * handleSyncRequest（无真实 Fabric 会话——契约同形：fetchHttp/serveHttp 的
 * JS 投影）。
 * opts.transportDouble=true 时（r8-B4）：fetchImpl 经分层 transport 替身包裹
 * （packages/webui/test/plugin-transport-double.mjs——1MiB 帧/2MiB 流/8MiB
 * 会话三层账，与生产 toSyncFetch 同款 ≤1MiB 帧分块），单机 loopback 不再
 * 绕过真实 transport 包络；共享 ledger 暴露为返回值 transportLedger。
 * @param {{ aId: string, bId: string, aName?: string, bName?: string, now?: () => number, log?: object, asyncSessionResolver?: boolean, transportDouble?: boolean }} opts
 */
export async function makePair(opts) {
  const { createSyncRuntime } = await import("../src/index.mjs");
  const { jsonBody } = await import("../src/util.mjs");
  const { createSessionLedger, wrapSyncFetchImpl } = await import("../../webui/test/plugin-transport-double.mjs");
  const aHome = await makeHome("dweb-sync-a-");
  const bHome = await makeHome("dweb-sync-b-");
  /** @type {Map<string, { runtime: any, home: string }>} */
  const endpoints = new Map();
  const transportLedger = opts.transportDouble === true ? createSessionLedger() : null;

  /**
   * @param {string} selfId
   * @param {string} selfName
   * @param {string} home
   */
  function register(selfId, selfName, home) {
    const loopbackFetch = async (session, req) => {
      // 生产保真防线（真双机验收 F4 回归网）：真实宿主 fabric.sessionResolver
      // 是异步的——引擎若不 await，fetchImpl 会收到 Promise（生产报
      // session.fetchHttp is not a function）。loopback 在此如实拒绝。
      if (session !== null && typeof session === "object" && typeof /** @type {any} */ (session).then === "function") {
        throw new Error("session.fetchHttp is not a function (engine passed an unresolved sessionResolver promise)");
      }
      const target = endpoints.get(/** @type {{ peerEndpointId: string }} */ (session).peerEndpointId);
      if (target === undefined) return { status: 404, body: jsonBody({ ok: false, code: "not-found", detail: "peer runtime not registered" }) };
      return target.runtime.handleSyncRequest({
        method: req.method,
        path: req.path,
        body: req.body,
        sessionId: "loopback",
        peerEndpointId: selfId,
        signal: req.signal,
      });
    };
    const fetchImpl = transportLedger !== null ? wrapSyncFetchImpl(loopbackFetch, { ledger: transportLedger }) : loopbackFetch;
    const sessionObj = (peerEndpointId) => ({ peerEndpointId, selfEndpointId: selfId, sessionId: "loopback" });
    // asyncSessionResolver：真实宿主形态（Promise 返回——webui fabric.mjs
    // sessionResolver 是 async 函数；同步 loopback 形态曾掩盖 F4）
    const sessionResolver = opts.asyncSessionResolver
      ? (peerEndpointId) => Promise.resolve(sessionObj(peerEndpointId))
      : (peerEndpointId) => sessionObj(peerEndpointId);
    const runtime = createSyncRuntime({ home, endpointId: selfId, deviceName: selfName, now: opts.now, fetchImpl, sessionResolver, log: opts.log ?? {} });
    endpoints.set(selfId, { runtime, home });
    return runtime;
  }

  const a = register(opts.aId, opts.aName ?? "device-a", aHome);
  const b = register(opts.bId, opts.bName ?? "device-b", bHome);
  return {
    a,
    b,
    aHome,
    bHome,
    endpoints,
    transportLedger,
    /** @param {string} id */
    registerMore: (id, name) => register(id, name, undefined),
    async cleanup() {
      await rm(aHome, { recursive: true, force: true }).catch(() => {});
      await rm(bHome, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 常用 endpointId（hex 8 字节）。 */
export const ID_A = "aa11aa22aa33aa44aa55aa66aa77aa88";
export const ID_B = "bb11bb22bb33bb44bb55bb66bb77bb88";

/**
 * 建组（两端同 id 同成员——v1 建组协议：两端各自 createGroup）。
 * @param {any} a @param {any} b
 * @param {{ id?: string, name?: string, aRoot: string, bRoot: string, mode?: "oneway" | "twoway", seedAuthority: string, rootId?: string }} spec
 */
export async function createPairGroup(a, b, spec) {
  const groupId = spec.id ?? "agents-skills";
  const rootId = spec.rootId ?? "r1";
  const members = [
    { endpointId: ID_A, deviceName: "device-a" },
    { endpointId: ID_B, deviceName: "device-b" },
  ];
  const ra = await a.createGroup({ id: groupId, name: spec.name ?? "agents-skills", members, roots: [{ id: rootId, localPath: spec.aRoot, mode: spec.mode ?? "twoway", seedAuthority: spec.seedAuthority }] });
  if (!ra.ok) throw new Error(`createGroup A failed: ${JSON.stringify(ra)}`);
  const rb = await b.createGroup({ id: groupId, name: spec.name ?? "agents-skills", members, roots: [{ id: rootId, localPath: spec.bRoot, mode: spec.mode ?? "twoway", seedAuthority: spec.seedAuthority }] });
  if (!rb.ok) throw new Error(`createGroup B failed: ${JSON.stringify(rb)}`);
  return { groupId, rootId };
}

/** 读文件（不存在→null）。 @param {string} root @param {string} rel */
export async function readOrNull(root, rel) {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}
