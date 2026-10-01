// adapted from ai-fly src/provider/engine.ts (v0.6.0) —— engine 三拆之 catalog
// （design §0：engine 拆 accept/catalog/forward 三文件独立验收）。
// 目录视图组装 + since 长轮询 + 全量上限（≤256 服务/JSON ≤256KiB——工厂期
// 拒绝由 store 保存门与 assertCatalogBudget 双层把守）。
// 与上游的有意分歧：目录代次=store.revision（ai-fly 用独立 catalogSeq——
// 本包 services/groups/keys 全部经 store.save 自增 revision，单一事实源）。

import {
  CATALOG_MAX_JSON_BYTES,
  CATALOG_MAX_SERVICES,
  CATALOG_WATCH_TIMEOUT_MS,
} from "../wire/constants.mjs";
import { buildServiceEntry } from "./detail.mjs";
import { StoreError } from "./store.mjs";

/**
 * 目录装配前提自检（工厂期——createAiWireHandler / runtime 启动调用）：
 * 当前 catalog 超配（服务数>256 或投影 JSON>256KiB）→ 拒绝启动。
 * @param {{ listServices: () => Array<Record<string, any>>, getGroup: (name: string) => any, listGroups: () => Array<{ name: string, serviceIds: string[] }> }} store
 */
export function assertCatalogBudget(store) {
  const services = store.listServices();
  if (services.length > CATALOG_MAX_SERVICES) {
    throw new Error(`ai provider catalog exceeds ${CATALOG_MAX_SERVICES} services (${services.length}); remove services before starting`);
  }
  if (services.length === 0) return;
  // 最坏投影：单组包含全部服务（256KiB 判定按此最坏形态）。
  const projection = {
    v: 1,
    status: "ok",
    groups: [
      {
        keyId: "budget-probe",
        group: "budget-probe",
        limits: {},
        services: services.map((s) => budgetProjection(s)),
      },
    ],
  };
  const bytes = Buffer.byteLength(JSON.stringify(projection));
  if (bytes > CATALOG_MAX_JSON_BYTES) {
    throw new Error(
      `ai provider catalog JSON exceeds ${CATALOG_MAX_JSON_BYTES} bytes (${bytes}); remove services before starting`,
    );
  }
}

/**
 * 预算探测的最小投影（detail 全量脱敏形状——与 buildServiceEntry 同字段集）。
 * @param {Record<string, any>} service
 */
function budgetProjection(service) {
  return {
    serviceId: service.serviceId,
    name: service.name,
    match: service.match ?? [],
    defaultPort: service.defaultPort,
    detail: {
      upstream: service.upstream,
      match: service.match ?? [],
      rewrite: {},
      ...(service.routes !== undefined ? { routes: service.routes } : {}),
    },
  };
}

/**
 * keyId 的目录视图（catalog 200 的 catalog 载荷 + AUTH 复用同一投影）。
 * @param {import("./store.mjs").ProviderStore} store
 * @param {{ keyId: string, group: string }} grant
 * @returns {{ groups: object[] }}
 */
export function buildCatalogView(store, grant) {
  const limits = store.getGroup(grant.group)?.limits ?? {};
  const services = store.groupServices(grant.group).map((svc) => buildServiceEntry(svc));
  return {
    groups: [
      {
        keyId: grant.keyId,
        group: grant.group,
        limits,
        services,
      },
    ],
  };
}

/**
 * catalog 长轮询骨架：等待 revision 越过 since（≤holdMs）；超时/已越过即返回。
 * sleep 可注入（测试免真实等待）。
 * @param {{ revision: number, onChange: (cb: (rev: number) => void) => () => void }} store
 * @param {{ since: number, holdMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} opts
 * @returns {Promise<{ changed: boolean, rev: number }>}
 */
export async function watchCatalogRevision(store, opts) {
  const holdMs = opts.holdMs ?? CATALOG_WATCH_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const current = store.revision;
  if (current !== opts.since) return { changed: true, rev: current };
  if (holdMs <= 0) return { changed: false, rev: current };
  const deadline = now() + holdMs;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(undefined);
    };
    const unsubscribe = store.onChange((rev) => {
      if (rev !== opts.since) finish();
    });
    const timer = setTimeout(finish, Math.max(0, deadline - now()));
  });
  return { changed: store.revision !== opts.since, rev: store.revision };
}

export { CATALOG_MAX_JSON_BYTES, CATALOG_MAX_SERVICES, CATALOG_WATCH_TIMEOUT_MS, StoreError };
