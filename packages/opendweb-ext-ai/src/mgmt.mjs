// ai 插件管理面逻辑（ai-subscription-sharing Phase C / tasks C3）。
// 意图（2026-10-01）：
// 1. `/sidecar/plugins/ai/*` 管理面的**纯逻辑层**：输入 (method, subPath, query,
//    body) → 输出 {status, body} | null（null=未命中）。Host/Origin 守卫、body
//    读取与响应发送都在宿主 sidecar（家族纪律：守卫在 sidecar——与 ports/
//    files/sync 管理面同拍；本模块零 HTTP 依赖，可 node --test 直测）。
// 2. 凭证纪律：密钥原文只出现在「签发（POST keys）」与「链接生成（POST link）」
//    的**本地管理面响应体**（§2 raw key 裁决）；一切 GET/列表/usage/日志投影恒
//    掩码（keyId/名称/长度指纹，无原文）。
// 3. envguard 两时点：启动时点在 provider 面装配（runtime.buildPlane →
//    createAiProviderWireHandler 内 assertStartupEnvSafety）；运行时点在 store
//    写路径的激活门内（addService/setServiceEnabled/setServiceAuth/import
//    commit 的原子变更内 assertServiceActivatable）——本层不重复实现。
// 4. 两阶段导入器面：stage（扫描，blocked/ready 机器可读——ready 不回显
//    ServiceInput 以防 literal 凭证回流）→ commit（mappings + 原文重扫描 +
//    store.transaction 原子生效；禁止 env 自动快照）。

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { buildServiceDetail, buildServiceEntry } from "./provider/detail.mjs";
import { stageAiflyConfig, commitAiflyImport, envRefName } from "./provider/importer.mjs";
import { loadCuratedPresets } from "./presets/models-dev.mjs";
import { StoreError } from "./provider/store.mjs";
import { importLink, addKey, SHARE_LINK_PREFIX } from "./consumer/join.mjs";

/**
 * StoreError → HTTP 状态映射（家族惯例：invalid=400 / not-found=404 /
 * duplicate·conflict=409 / corrupt=500）。
 * @param {unknown} e
 */
function errorStatus(e) {
  if (e instanceof StoreError) {
    if (e.code === "invalid") return 400;
    if (e.code === "not-found") return 404;
    if (e.code === "duplicate" || e.code === "conflict") return 409;
    return 500;
  }
  const code = /** @type {{ code?: string }} */ (e)?.code;
  if (code === "invalid") return 400;
  if (code === "not-found") return 404;
  if (code === "conflict") return 409;
  return 500;
}

/**
 * @param {number} status @param {string} code @param {string} message
 */
function err(status, code, message) {
  return { status, body: { error: { code, message } } };
}

/**
 * ai 管理面。
 * @param {{
 *   dataDir: string,
 *   now: () => number,
 *   log: (line: string) => void,
 *   store: () => Promise<import("./provider/store.mjs").ProviderStore>,
 *   secrets: () => import("./provider/secrets.mjs").SecretsStore,
 *   getPlane: () => ({ forwardPlane: { epoch: string, relay: { activeCount(): number } }, limits: import("./provider/limits.mjs").LimitEnforcer } | null),
 *   getConfig: () => { maxConcurrency: number, dailyRequests?: number, usageLog: boolean },
 *   refreshLimitDefaults: () => Promise<void>,
 *   consumer: {
 *     keyring: () => Promise<Awaited<ReturnType<typeof import("./consumer/keyring.mjs").openKeyring>>>,
 *     refreshProviders: (providerRef?: string) => Promise<{ results: Array<{ ok: boolean, endpointId?: string, alias?: string, error?: string }> }>,
 *     loadEndpoints: () => Promise<Array<Record<string, unknown>>>,
 *     startConsumerEndpoint: (input: { providerEndpointId: string, serviceId: string, port: number }) => Promise<{ id: string, endpoint: Record<string, unknown> }>,
 *     stopConsumerEndpoint: (id: string) => Promise<{ removed: Record<string, unknown> }>,
 *   },
 *   fabric: {
 *     identity?: () => Promise<{ endpointId: string, deviceName: string, relays?: Array<{ url: string }> } | null>,
 *     issueInvite?: (opts: { recipient: string, ttlMs?: number }) => Promise<{ token: string }>,
 *   },
 * }} deps
 * @returns {{ handle: (method: string, subPath: string, query: URLSearchParams, body: unknown) => Promise<{ status: number, body: object } | null> }}
 */
export function createAiManagement(deps) {
  const { dataDir, now, store, secrets, consumer, fabric } = deps;

  /**
   * 服务条目 → 管理面投影（detail 脱敏——buildServiceDetail 掩码凭证位）。
   * @param {Record<string, any>} service
   * @param {import("./provider/store.mjs").ProviderStore} st
   */
  function serviceView(service, st) {
    const groups = st.listGroups().filter((g) => g.serviceIds.includes(service.serviceId)).map((g) => g.name);
    return {
      serviceId: service.serviceId,
      name: service.name,
      enabled: service.enabled !== false,
      ...(service.keyEnv !== undefined ? { keyEnv: service.keyEnv, authBound: typeof service.auth?.secret === "string" } : {}),
      upstream: service.upstream,
      defaultPort: service.defaultPort,
      detail: buildServiceDetail(service),
      groups,
    };
  }

  /**
   * 钥环掩码投影（原文零出网——长度指纹形态）。
   * @param {{ key: string }} key
   */
  function maskKey(key) {
    return `${key.key.slice(0, 11)}…（${key.key.length} 字符，仅本机保存）`;
  }

  /**
   * 管理面路由（subPath 已剥 /sidecar/plugins/ai 前缀；body=已解析 JSON）。
   * @param {string} method @param {string} subPath @param {URLSearchParams} query @param {unknown} body
   * @returns {Promise<{ status: number, body: object } | null>}
   */
  async function handle(method, subPath, query, body) {
    const p = subPath.startsWith("/") ? subPath : `/${subPath}`;

    // ---- GET 读面 -----------------------------------------------------------------

    if (method === "GET" && p === "/overview") {
      const st = await store();
      const plane = deps.getPlane();
      return {
        status: 200,
        body: {
          services: st.listServices().map((s) => serviceView(s, st)),
          groups: st.listGroups().map((g) => ({
            name: g.name,
            serviceIds: g.serviceIds,
            serviceNames: g.serviceIds.map((id) => st.getService(id)?.name ?? id),
            ...(g.limits !== undefined ? { limits: g.limits } : {}),
          })),
          keys: st.listKeys().map((k) => ({
            keyId: k.keyId,
            group: k.group,
            name: k.name,
            createdAt: k.createdAt,
            ...(k.revokedAt !== undefined ? { revokedAt: k.revokedAt } : {}),
            status: k.revokedAt !== undefined ? "revoked" : "active",
          })),
          secrets: secrets().list(),
          hooks: await listHookNames(),
          config: deps.getConfig(),
          plane: plane !== null ? { epoch: plane.forwardPlane.epoch, inflight: plane.forwardPlane.relay.activeCount() } : null,
        },
      };
    }

    if (method === "GET" && p === "/presets") {
      return { status: 200, body: { presets: loadCuratedPresets() } };
    }

    if (method === "GET" && p === "/usage") {
      return { status: 200, body: usageView() };
    }

    if (method === "GET" && p === "/consumer") {
      const kr = await consumer.keyring();
      const snapshot = kr.snapshot();
      return {
        status: 200,
        body: {
          providers: snapshot.providers.map((provider) => ({
            endpointId: provider.endpointId,
            alias: provider.alias,
            keys: provider.keys.map((k) => ({ keyId: k.keyId, group: k.group, masked: maskKey(k) })),
            services: provider.services,
          })),
          endpoints: await consumer.loadEndpoints(),
        },
      };
    }

    // ---- 提供方写面 -----------------------------------------------------------------

    if (method === "POST" && p === "/services") {
      const input = body ?? {};
      const st = await store();
      try {
        /** preset 名（loadActivatablePresets 之一）或 custom ServiceInput */
        let serviceInput;
        if (typeof input.preset === "string" && input.preset !== "") {
          const preset = loadCuratedPresets().find((x) => x.id === input.preset);
          if (preset === undefined) return err(404, "not-found", `preset '${input.preset}' does not exist`);
          if (preset.disabled === true) {
            return err(409, "not-found", `preset '${preset.id}' is a placeholder that requires the follow-up change ${preset.requires ?? "ai-codex-oauth"}`);
          }
          const { presetToServiceInput } = await import("./presets/models-dev.mjs");
          serviceInput = presetToServiceInput(preset, typeof input.name === "string" && input.name !== "" ? { name: input.name } : {});
          if (input.defaultPort !== undefined) serviceInput.defaultPort = input.defaultPort;
        } else {
          serviceInput = input.service ?? {};
        }
        // 可选创建期 auth 绑定（{secret} 槽——预设 keyEnv 的激活门输入）
        if (input.auth !== undefined) serviceInput.auth = input.auth;
        const service = await st.addService({ ...serviceInput, enabled: input.enabled !== false });
        await deps.refreshLimitDefaults();
        return { status: 200, body: { service: serviceView(service, st) } };
      } catch (e) {
        if (e instanceof StoreError) {
          // 激活门拒绝（keyEnv 未绑定 secret / secret 不在库 / ambient env 命中）
          const status = e.code === "conflict" ? 409 : 400;
          return err(status, e.code, e.message);
        }
        return err(errorStatus(e), "internal", e instanceof Error ? e.message : String(e));
      }
    }

    const serviceMatch = /^\/services\/([a-zA-Z0-9_-]+)$/.exec(p);
    if (serviceMatch !== null && (method === "PATCH" || method === "DELETE")) {
      const st = await store();
      const serviceId = serviceMatch[1];
      try {
        if (method === "DELETE") {
          const service = st.getService(serviceId);
          if (service === undefined) return err(404, "not-found", `service '${serviceId}' not found`);
          await st.removeService(service.name);
          return { status: 200, body: { ok: true } };
        }
        const input = body ?? {};
        /** @type {Record<string, any> | undefined} */
        let updated;
        if (input.auth !== undefined) {
          updated = await st.setServiceAuth(serviceId, input.auth === null ? undefined : input.auth);
        }
        if (input.enabled !== undefined) {
          const r = await st.setServiceEnabled(serviceId, input.enabled === true);
          if (!r.changed && updated === undefined) {
            const current = st.getService(serviceId);
            if (current === undefined) return err(404, "not-found", `service '${serviceId}' not found`);
            if (current.enabled === input.enabled) return { status: 200, body: { service: serviceView(current, st) } };
          }
        }
        const service = st.getService(serviceId);
        if (service === undefined) return err(404, "not-found", `service '${serviceId}' not found`);
        await deps.refreshLimitDefaults();
        return { status: 200, body: { service: serviceView(service, st) } };
      } catch (e) {
        if (e instanceof StoreError) {
          const status = e.code === "conflict" ? 409 : e.code === "not-found" ? 404 : 400;
          return err(status, e.code, e.message);
        }
        return err(errorStatus(e), "internal", e instanceof Error ? e.message : String(e));
      }
    }

    if (method === "POST" && p === "/groups") {
      const input = body ?? {};
      if (typeof input.name !== "string" || input.name.trim() === "") return err(400, "invalid-request", "body must be {name: string, serviceNames?: string[], limits?: {...}}");
      const st = await store();
      try {
        const group = await st.addGroup(input.name, Array.isArray(input.serviceNames) ? input.serviceNames : [], input.limits);
        await deps.refreshLimitDefaults();
        return { status: 200, body: { group } };
      } catch (e) {
        return err(errorStatus(e), e instanceof StoreError ? e.code : "internal", e instanceof Error ? e.message : String(e));
      }
    }

    const groupMatch = /^\/groups\/([a-zA-Z0-9._-]+)$/.exec(p);
    if (groupMatch !== null && (method === "PATCH" || method === "DELETE")) {
      const name = decodeURIComponent(groupMatch[1]);
      const st = await store();
      try {
        if (method === "DELETE") {
          await st.removeGroup(name);
          return { status: 200, body: { ok: true } };
        }
        const input = body ?? {};
        if (Array.isArray(input.serviceNames)) await st.setGroupServices(name, input.serviceNames);
        if ("limits" in input) await st.setGroupLimits(name, input.limits ?? undefined);
        await deps.refreshLimitDefaults();
        const group = st.getGroup(name);
        if (group === undefined) return err(404, "not-found", `group '${name}' not found`);
        return { status: 200, body: { group } };
      } catch (e) {
        return err(errorStatus(e), e instanceof StoreError ? e.code : "internal", e instanceof Error ? e.message : String(e));
      }
    }

    if (method === "POST" && p === "/keys") {
      const input = body ?? {};
      if (typeof input.group !== "string" || input.group === "") return err(400, "invalid-request", "body must be {group: string, name?: string}");
      const st = await store();
      try {
        // 原文仅本响应体出现（一次性展示 + 本地复制——§2 raw key）
        const issued = await st.issueKey(input.group, typeof input.name === "string" && input.name !== "" ? input.name : "default", { now });
        return { status: 200, body: issued };
      } catch (e) {
        return err(errorStatus(e), e instanceof StoreError ? e.code : "internal", e instanceof Error ? e.message : String(e));
      }
    }

    const keyMatch = /^\/keys\/([a-zA-Z0-9_-]+)$/.exec(p);
    if (method === "DELETE" && keyMatch !== null) {
      const st = await store();
      try {
        const key = await st.revokeKey(keyMatch[1], { now });
        return { status: 200, body: { keyId: key.keyId, group: key.group, revokedAt: key.revokedAt, status: "revoked" } };
      } catch (e) {
        return err(errorStatus(e), e instanceof StoreError ? e.code : "internal", e instanceof Error ? e.message : String(e));
      }
    }

    if (method === "POST" && p === "/secrets") {
      const input = body ?? {};
      if (typeof input.name !== "string" || typeof input.value !== "string" || input.value === "") {
        return err(400, "invalid-request", "body must be {name: string, value: string}");
      }
      try {
        const entry = await secrets().set(input.name, input.value, { now });
        // 值不回显（名称/时间戳即可）
        return { status: 200, body: { secret: entry } };
      } catch (e) {
        return err(errorStatus(e), e instanceof StoreError ? e.code : "internal", e instanceof Error ? e.message : String(e));
      }
    }

    const secretMatch = /^\/secrets\/([a-zA-Z0-9._-]+)$/.exec(p);
    if (method === "DELETE" && secretMatch !== null) {
      try {
        await secrets().remove(decodeURIComponent(secretMatch[1]));
        return { status: 200, body: { ok: true } };
      } catch (e) {
        return err(errorStatus(e), e instanceof StoreError ? e.code : "internal", e instanceof Error ? e.message : String(e));
      }
    }

    if (method === "POST" && p === "/link") {
      return await handleLink(body ?? {});
    }

    if (method === "POST" && p === "/import-stage") {
      const input = body ?? {};
      if (typeof input.rawText !== "string" || input.rawText === "") return err(400, "invalid-request", "body must be {rawText: string}");
      try {
        const staging = stageAiflyConfig(input.rawText);
        // ready 不回显 ServiceInput（可能含 literal 凭证）——仅名字
        return {
          status: 200,
          body: {
            blocked: staging.blocked.map((b) => ({ ...b, varName: b.ref.startsWith("$env:") ? envRefName(b.ref) : undefined })),
            ready: staging.ready.map((r) => ({ name: r.name })),
          },
        };
      } catch (e) {
        return err(400, "invalid-config", e instanceof Error ? e.message : String(e));
      }
    }

    if (method === "POST" && p === "/import-commit") {
      const input = body ?? {};
      if (typeof input.rawText !== "string" || input.rawText === "") return err(400, "invalid-request", "body must be {rawText: string, mappings: Record<string,string>, groupName?}");
      if (input.mappings === null || typeof input.mappings !== "object" || Array.isArray(input.mappings)) return err(400, "invalid-request", "mappings must be a JSON object of {envVar: secretName}");
      const st = await store();
      try {
        const staging = stageAiflyConfig(input.rawText);
        const out = await commitAiflyImport(staging, st, {
          mappings: input.mappings,
          secretExists: (name) => secrets().exists(name),
          ...(typeof input.groupName === "string" && input.groupName !== "" ? { groupName: input.groupName } : {}),
        });
        await deps.refreshLimitDefaults();
        return { status: 200, body: out };
      } catch (e) {
        return err(e instanceof StoreError ? errorStatus(e) : 400, e instanceof StoreError ? e.code : "invalid-config", e instanceof Error ? e.message : String(e));
      }
    }

    // ---- 消费方写面 -----------------------------------------------------------------

    if (method === "POST" && p === "/consumer/import") {
      const input = body ?? {};
      if (typeof input.link !== "string" || !input.link.startsWith(SHARE_LINK_PREFIX)) {
        return err(400, "invalid-request", `body must be {link: "${SHARE_LINK_PREFIX}…"}`);
      }
      try {
        const kr = await consumer.keyring();
        const { payload } = await importLink(input.link, { keyring: kr });
        await kr.save();
        // 密钥原文零回显——掩码确认（长度指纹）
        return {
          status: 200,
          body: {
            provider: { alias: payload.provider.alias, endpointId: payload.provider.endpointId },
            group: payload.group,
            keyId: payload.keyId,
            keyMasked: maskKey(payload),
            services: payload.services.length,
          },
        };
      } catch (e) {
        return err(400, "invalid-link", e instanceof Error ? e.message : String(e));
      }
    }

    if (method === "POST" && p === "/consumer/add-key") {
      const input = body ?? {};
      if (typeof input.key !== "string" || typeof input.providerRef !== "string") {
        return err(400, "invalid-request", "body must be {key: string, providerRef: string}");
      }
      try {
        const kr = await consumer.keyring();
        const out = await addKey(input.key, input.providerRef, kr);
        return { status: 200, body: { added: out.added, provider: { alias: out.provider.alias, endpointId: out.provider.endpointId } } };
      } catch (e) {
        return err(400, "invalid-key", e instanceof Error ? e.message : String(e));
      }
    }

    if (method === "POST" && p === "/consumer/refresh") {
      const input = body ?? {};
      const ref = typeof input.providerRef === "string" && input.providerRef !== "" ? input.providerRef : undefined;
      const out = await consumer.refreshProviders(ref);
      if (ref !== undefined && out.results.length === 1 && out.results[0].ok === false) {
        return err(404, "not-found", out.results[0].error ?? "provider not found");
      }
      return { status: 200, body: out };
    }

    if (method === "POST" && p === "/consumer/endpoints") {
      const input = body ?? {};
      if (typeof input.providerEndpointId !== "string" || typeof input.serviceId !== "string" || !Number.isInteger(input.port)) {
        return err(400, "invalid-request", "body must be {providerEndpointId: string, serviceId: string, port: number}");
      }
      try {
        const out = await consumer.startConsumerEndpoint({ providerEndpointId: input.providerEndpointId, serviceId: input.serviceId, port: input.port });
        return { status: 200, body: out };
      } catch (e) {
        // 端口冲突=真实 listen 错误（不静默换端口）——完整文案上抛
        return err(errorStatus(e), /** @type {{code?: string}} */ (e)?.code ?? "endpoint-failed", e instanceof Error ? e.message : String(e));
      }
    }

    const endpointMatch = /^\/consumer\/endpoints\/([a-zA-Z0-9_-]+)$/.exec(p);
    if (method === "DELETE" && endpointMatch !== null) {
      try {
        await consumer.stopConsumerEndpoint(endpointMatch[1]);
        return { status: 200, body: { ok: true } };
      } catch (e) {
        return err(errorStatus(e), /** @type {{code?: string}} */ (e)?.code ?? "internal", e instanceof Error ? e.message : String(e));
      }
    }

    return null;
  }

  /**
   * 用户 hook 脚本名（<DWEB_HOME>/plugins/ai/hooks/*.cjs——创建服务时的 script
   * 槽提示用；dataDir=<home>/plugins/ai → home=上两级）。
   */
  async function listHookNames() {
    try {
      const { discoverHooks } = await import("./provider/hooks.mjs");
      const home = join(dataDir, "..", "..");
      return discoverHooks(home).map((h) => ({ name: h.name, source: h.source, stages: h.stages ?? [] }));
    } catch {
      return [];
    }
  }

  /**
   * 用量元数据聚合（usage.jsonl + quota-day.json——零凭证零正文）。
   */
  function usageView() {
    const config = deps.getConfig();
    /** @type {Array<{ ts: number, keyId: string, serviceId: string, status: number | string, bytes: number }>} */
    let records = [];
    const usageFile = join(dataDir, "usage.jsonl");
    if (config.usageLog && existsSync(usageFile)) {
      try {
        const lines = readFileSync(usageFile, "utf8").split("\n").filter((l) => l.trim() !== "");
        records = lines.map((l) => JSON.parse(l));
      } catch {
        records = [];
      }
    }
    const byKey = new Map();
    const byService = new Map();
    let totalBytes = 0;
    for (const r of records) {
      const k = byKey.get(r.keyId) ?? { keyId: r.keyId, requests: 0, bytes: 0 };
      k.requests += 1;
      k.bytes += r.bytes;
      byKey.set(r.keyId, k);
      const s = byService.get(r.serviceId) ?? { serviceId: r.serviceId, requests: 0, bytes: 0 };
      s.requests += 1;
      s.bytes += r.bytes;
      byService.set(r.serviceId, s);
      totalBytes += r.bytes;
    }
    let quotaDay = null;
    try {
      const quotaFile = join(dataDir, "quota-day.json");
      if (existsSync(quotaFile)) quotaDay = JSON.parse(readFileSync(quotaFile, "utf8"));
    } catch {
      quotaDay = null;
    }
    return {
      enabled: config.usageLog,
      totals: { requests: records.length, bytes: totalBytes },
      byKey: [...byKey.values()].sort((a, b) => b.requests - a.requests),
      byService: [...byService.values()].sort((a, b) => b.requests - a.requests),
      quotaDay,
      recent: records.slice(-100).reverse(),
    };
  }

  /**
   * aifly1. 分享链接生成（§2：链接再生成复用已存 key；invite=真 fabric 令牌
   * ——recipient=受邀方 endpointId，v2 invite 必填）。
   * @param {{ group?: unknown, recipient?: unknown, keyId?: unknown, name?: unknown }} input
   */
  async function handleLink(input) {
    const group = typeof input.group === "string" ? input.group : "";
    const recipient = typeof input.recipient === "string" ? input.recipient.trim() : "";
    if (group === "" || recipient === "") {
      return err(400, "invalid-request", "body must be {group: string, recipient: string(invitee endpoint id), keyId?, name?}");
    }
    if (!/^[0-9a-zA-Z]{8,128}$/.test(recipient)) {
      return err(400, "invalid-request", "recipient must be the invitee endpoint id (hex64 or z32)");
    }
    if (typeof fabric.identity !== "function" || typeof fabric.issueInvite !== "function") {
      return err(503, "fabric-unavailable", "the host fabric face does not expose identity/invite (host integration required)");
    }
    const identity = await fabric.identity();
    if (identity === null) {
      return err(503, "no-identity", "this device has no fabric identity (join a hub first)");
    }
    const st = await store();
    if (st.getGroup(group) === undefined) return err(404, "not-found", `group '${group}' not found`);
    const services = st.groupServices(group);
    if (services.length === 0) return err(409, "conflict", `group '${group}' has no enabled services`);
    /** @type {{ keyId: string, key: string }} */
    let key;
    if (typeof input.keyId === "string" && input.keyId !== "") {
      const status = st.keyStatus(input.keyId);
      if (status.status === "invalid") return err(404, "not-found", `key '${input.keyId}' not found`);
      if (status.status === "revoked") return err(409, "conflict", `key '${input.keyId}' is revoked; issue a new key`);
      if (status.group !== group) return err(409, "conflict", `key '${input.keyId}' belongs to group '${status.group}'`);
      const material = st.getKeyMaterial(input.keyId);
      if (material === undefined) return err(409, "conflict", `key '${input.keyId}' has no stored material (hash-only record); issue a new key`);
      key = { keyId: input.keyId, key: material };
    } else {
      const issued = await st.issueKey(group, typeof input.name === "string" && input.name !== "" ? input.name : "default", { now });
      key = { keyId: issued.keyId, key: issued.key };
    }
    let token;
    try {
      const out = await fabric.issueInvite({ recipient, ttlMs: 10 * 60_000 });
      token = out.token;
    } catch (e) {
      return err(503, "fabric-unavailable", `cannot issue a fabric invite: ${e instanceof Error ? e.message : String(e)}`);
    }
    const payload = {
      v: 1,
      invite: token,
      key: key.key,
      keyId: key.keyId,
      provider: {
        alias: identity.deviceName,
        endpointId: identity.endpointId,
        relayUrls: (identity.relays ?? []).map((r) => r.url),
      },
      group,
      services: services.map((svc) => buildServiceEntry(svc)),
    };
    const link = `${SHARE_LINK_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    // 链接内嵌密钥原文——仅本响应体（本地面显式复制）；不落日志
    return {
      status: 200,
      body: {
        link,
        keyId: key.keyId,
        group,
        services: payload.services.length,
        recipient,
        note: "this link embeds a secret key - treat it like a password",
      },
    };
  }

  return { handle };
}
