// sync 插件运行时装配（webui-plugin-kernel Phase 3 / design v2.3 §7）。
// 意图（2026-09-29）：
// 1. createSyncRuntime({home, endpointId, deviceName, now, fetchImpl,
//    sessionResolver, log})——宿主 runtimes 通道的 onEnable/onDispose 钩子形状
//    与全部管理/数据面的单一装配点（接线由编排者收口：serveHttp 挂
//    runtime.handleSyncRequest，控制面挂 groups/actions 投影）。
// 2. 每 repo 单写者互斥按 gitdir 键共享（引擎与端点同进程同锁）。
// 3. recoverAll 在 onEnable（启动/启用）时执行——崩溃恢复入口（测试直接调）。
// 4. fetchImpl/sessionResolver 契约镜像 client-sdk /http：
//    sessionResolver(peerEndpointId) → session 句柄；fetchImpl(session,
//    {method, path, body, signal}) → {status, body}——宿主接线层以
//    fetchHttp/serveHttp 适配，测试以内存 loopback 注入。

import path from "node:path";
import { createMutex } from "./util.mjs";
import { createGroup, deleteGroup, loadLedger, repoDir, syncDataDir } from "./ledger.mjs";
import { createSyncEndpointHandler, gcStaging } from "./endpoint.mjs";
import { createSyncEngine } from "./engine.mjs";
import { createScheduler } from "./scheduler.mjs";
import { readRef, GROUP_REF, deviceRef } from "./objects.mjs";

/**
 * 创建 sync 插件运行时。
 * @param {{ home: string, endpointId: string, deviceName: string, now?: () => number, fetchImpl: (session: unknown, req: { method: string, path: string, body?: Uint8Array | null, signal?: AbortSignal }) => Promise<{ status: number, body: Uint8Array }>, sessionResolver: (peerEndpointId: string) => unknown, log?: { debug?: (m: string) => void, info?: (m: string) => void, warn?: (m: string) => void, error?: (m: string) => void } }} opts
 */
export function createSyncRuntime(opts) {
  const { home, endpointId, deviceName, fetchImpl, sessionResolver } = opts;
  if (typeof home !== "string" || home === "") throw new Error("createSyncRuntime: home is required");
  if (!/^[0-9a-f]{8,64}$/.test(endpointId ?? "")) throw new Error("createSyncRuntime: endpointId must be hex");
  if (typeof deviceName !== "string" || deviceName === "") throw new Error("createSyncRuntime: deviceName is required");
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? {};

  /** @type {Map<string, ReturnType<typeof createMutex>>} gitdir → 互斥（单写者） */
  const mutexes = new Map();
  const repoMutexFor = (gitdir) => {
    let m = mutexes.get(gitdir);
    if (m === undefined) {
      m = createMutex();
      mutexes.set(gitdir, m);
    }
    return m;
  };

  const engine = createSyncEngine({ home, endpointId, deviceName, now, fetchImpl, sessionResolver, log, repoMutexFor });
  const handler = createSyncEndpointHandler({ home, now, log, repoMutexFor });

  const scheduler = createScheduler({
    run: (groupId, init) => runGroup(groupId, { trigger: init?.trigger }),
    log,
  });

  /** 同步一组全部 root（调度器/动作入口共用）。 */
  async function runGroup(groupId, opts = {}) {
    const ledger = await loadLedger(home);
    const group = ledger.groups.find((g) => g.id === groupId);
    if (group === null) return [];
    const results = [];
    for (const root of group.roots) {
      results.push({ rootId: root.id, result: await engine.runRoot(groupId, root.id, opts) });
    }
    return results;
  }

  const runtime = {
    /** 本端身份投影（UI 头部/建组表单的 seed 权威选项源）。 */
    identity() {
      return { endpointId, deviceName, home: syncDataDir(home) };
    },

    /**
     * 数据面端点 handler（/wpk1/sync/*——serveHttp 分派目标；测试 loopback 直调）。
     * request: {method, path, body, sessionId, peerEndpointId, signal}。
     */
    handleSyncRequest: handler,

    /**
     * 建组（本地账本——两端各建、成员一致；seed authority 为成员端点之一）。
     */
    async createGroup(input) {
      return createGroup(home, input, { now });
    },

    /** 删组（账本摘除；数据目录留守——显式 purge 是 UI 确认动作）。 */
    async deleteGroup(groupId) {
      return deleteGroup(home, groupId, { now });
    },

    /** 组列表投影（GroupsPage 源：组+成员+roots+seed 状态+ref 状态）。 */
    async listGroups() {
      const ledger = await loadLedger(home);
      const out = [];
      for (const group of ledger.groups) {
        const roots = [];
        for (const root of group.roots) {
          const gd = path.join(repoDir(home, group.id, root.id), "git");
          const groupRefOid = await readRef(gd, GROUP_REF).catch(() => null);
          const myRefOid = await readRef(gd, deviceRef(endpointId)).catch(() => null);
          const seedBlock = await engine.seedBlockOf(group.id, root.id);
          const conflicts = await engine.conflictSession(group.id, root.id);
          roots.push({
            id: root.id,
            localPath: root.localPath,
            mode: root.mode,
            seedAuthority: root.seedAuthority,
            isSeedAuthority: root.seedAuthority === endpointId,
            groupRef: groupRefOid,
            deviceRef: myRefOid,
            seedBlock: seedBlock !== null,
            hasConflicts: conflicts !== null && conflicts.conflicts?.some((/** @type {{ resolution: unknown }} */ c) => c.resolution === null) === true,
          });
        }
        out.push({ id: group.id, name: group.name, members: group.members, roots, self: { endpointId, deviceName } });
      }
      return out;
    },

    /** 手动触发同步（StatusPage 重试/立即同步按钮）。 */
    async syncNow(groupId, opts = {}) {
      return runGroup(groupId, opts);
    },

    /** 状态投影（StatusPage 源）。 */
    status() {
      return engine.statusProjection();
    },

    /** 冲突会话（ConflictPage 源——含 hunks/两端 OID/算法版本/决议）。 */
    async conflicts(groupId, rootId) {
      return engine.conflictSession(groupId, rootId);
    },

    /** 冲突决议（hunk 逐块/文件级整选/编辑）。 */
    async resolveConflicts(groupId, rootId, decisions, opts = {}) {
      return engine.resolveConflicts(groupId, rootId, decisions, opts);
    },

    /** seed 阻断三方对照（GroupsPage 阻断面板源）。 */
    async seedBlock(groupId, rootId) {
      return engine.seedBlockOf(groupId, rootId);
    },

    /** seed 阻断显式处置（adopt-seed=采纳 A/放弃 B 内容）。 */
    async resolveSeedBlock(groupId, rootId, decision) {
      return engine.resolveSeedBlock(groupId, rootId, decision);
    },

    /** 调度器（宿主接线层持有；UI 通过 sidecar 动作转发 online/local-change）。 */
    scheduler,

    /** 启动恢复（崩溃扫描；测试直调）。 */
    async recoverAll() {
      return engine.recoverAll();
    },

    /**
     * 插件宿主钩子（runtimes 通道形状——onEnable 恢复+调度，onDispose 停表）。
     */
    runtimeHooks: {
      onEnable: async () => {
        await engine.recoverAll();
      },
      onDispose: async () => {
        scheduler.dispose();
      },
    },

    /** staging TTL 回收手动入口（测试/管理动作）。 */
    async gcAll() {
      const ledger = await loadLedger(home);
      /** @type {Record<string, string[]>} */
      const removed = {};
      for (const group of ledger.groups) {
        for (const root of group.roots) {
          const rd = repoDir(home, group.id, root.id);
          removed[`${group.id}/${root.id}`] = [
            ...(await gcStaging(path.join(rd, "git", "staging"), { now }).catch(() => [])),
            ...(await gcStaging(path.join(rd, "fetch-staging"), { now }).catch(() => [])),
          ];
        }
      }
      return removed;
    },
  };
  return runtime;
}
