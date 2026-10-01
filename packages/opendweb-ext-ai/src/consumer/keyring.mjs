// adapted from ai-fly src/consumer/store.ts (v0.6.0) —— 消费方钥环（tasks B3）。
// 与上游的有意分歧（design §0 consumer 行）：ai-fly 每提供者独立目录+fabric 身份
// 子目录；本 v1 为单文件钥环 `plugins/ai/keyring.json`（0600 原子写——宿主数据
// 目录纪律与 provider secrets.json 同拍），fabric 身份由宿主（Phase C 装配）
// 承载，钥环仅记提供者网络视图（endpointId/relayUrls）+密钥环+服务目录快照。
// 密钥原文仅落本文件（0600 本机明文——与 provider raw key 同威胁模型裁决）；
// 远程面（wire 请求头外的日志/目录披露）MUST NOT 含原文。

import { readFileSync } from "node:fs";
import { z } from "zod";
import { atomicWrite0600 } from "../fsutil.mjs";

/** 钥环 schema（v1）。 */
export const KEYRING_SCHEMA = z.strictObject({
  v: z.literal(1),
  providers: z.array(
    z.strictObject({
      /** 提供者 fabric endpointId（宿主注入面绑定键）。 */
      endpointId: z.string().min(8).max(128),
      alias: z.string().min(1).max(256),
      relayUrls: z.array(z.string().min(1).max(2048)),
      keys: z.array(
        z.strictObject({
          keyId: z.string().min(0).max(128),
          key: z.string().min(8).max(256),
          group: z.string().min(0).max(256),
        }),
      ),
      /** 目录快照（ServiceEntry[]——AUTH/catalog 合并视图）。 */
      services: z.array(z.unknown()),
    }),
  ),
});

/**
 * 打开（或新建空环）钥环。损坏文件视作显式错误（不静默重置——凭证语义）。
 * @param {string} file 钥环文件绝对路径（keyring.json）
 */
export async function openKeyring(file) {
  let data = { v: 1, providers: [] };
  try {
    const raw = readFileSync(file, "utf8");
    data = raw.length === 0 ? data : KEYRING_SCHEMA.parse(JSON.parse(raw));
  } catch (err) {
    if (err?.code === "ENOENT") {
      // 新建空环
    } else if (err instanceof z.ZodError) {
      throw new Error(`keyring file is corrupt or has an unsupported format: ${file}`);
    } else {
      throw err;
    }
  }
  let pending = data;
  return {
    file,
    /** 只读快照（结构化拷贝）。 */
    snapshot() {
      return JSON.parse(JSON.stringify(pending));
    },
    /** 提供者定位（endpointId 精确 / 8 字符前缀 / 别名——ai-findKeyringDir 同拍）。 */
    findProvider(ref) {
      const byId = pending.providers.find((p) => p.endpointId === ref);
      if (byId !== undefined) return byId;
      const byPrefix = pending.providers.find((p) => p.endpointId.startsWith(ref) && ref.length >= 8);
      if (byPrefix !== undefined) return byPrefix;
      return pending.providers.find((p) => p.alias === ref);
    },
    /**
     * 合并导入视图（ai-fly mergeImportView 同拍）：提供者网络视图 + 密钥 +
     * 服务目录 upsert（serviceId 去重，链接条目后写优先）。
     * @param {{ endpointId: string, alias: string, relayUrls?: string[] }} provider
     * @param {{ keyId: string, key: string, group: string }} key
     * @param {Array<Record<string, any>>} services
     */
    upsertProvider(provider, key, services) {
      let entry = pending.providers.find((p) => p.endpointId === provider.endpointId);
      if (entry === undefined) {
        entry = { endpointId: provider.endpointId, alias: provider.alias, relayUrls: [], keys: [], services: [] };
        pending.providers.push(entry);
      }
      entry.alias = provider.alias;
      if (provider.relayUrls !== undefined && provider.relayUrls.length > 0) entry.relayUrls = [...provider.relayUrls];
      const keyIdx = entry.keys.findIndex((k) => k.key === key.key || (key.keyId !== "" && k.keyId === key.keyId));
      if (keyIdx >= 0) entry.keys[keyIdx] = { ...key };
      else entry.keys.push({ ...key });
      const byId = new Map(entry.services.map((s) => [typeof s?.serviceId === "string" ? s.serviceId : "", s]));
      for (const svc of services) byId.set(typeof svc?.serviceId === "string" ? svc.serviceId : "", svc);
      entry.services = [...byId.values()];
      return entry;
    },
    /** 持久化（0600 原子写）。 */
    async save() {
      await atomicWrite0600(file, `${JSON.stringify(pending, null, 2)}\n`);
    },
  };
}
