// ai 插件·上游探活（ai-subscription-sharing Phase D / tasks D2 / design §6
// provider 页「上游探活」）。意图（2026-10-01）：
// 1. provider 本机对一服务发最小请求（GET，超时 5s）验证上游可达性：**经同一
//    hook 管线/auth 槽**——buildUpstreamRequest 全链（① auth 三族取值→headers
//    remove/set→② 脚本增量→防护头过滤）+ 连接期 TCP 探测（forward 同款
//    defaultProbeConnect）。不新增第二条凭证路径。
// 2. 三态结果（脱敏投影）：reachable（上游应答任意 HTTP 状态即达——含 401/404，
//    携 status）/ unreachable（连接失败/超时/管线失败——reason 码，无原始错误
//    文案）/ no_auth（keyEnv 未绑定 auth 槽、或已绑 secret 在库中缺失——零上游
//    触达）。**错误不含凭证与完整头**：结果只有 state/status/reason/keyEnv/ms。
// 3. 探活路径=路由白名单内首条 prefix 路由的 localPrefix（消费方工具的实际
//    路径面）；无路由服务用 "/"；pattern-only 服务无法合成白名单路径 →
//    unreachable{reason:"path_not_offered"}（如实呈现，不绕白名单）。
// 正交意图（本文件不实现）：服务账本与鉴权（store）、管理面路由（mgmt.mjs）。

import { defaultProbeConnect } from "./upstream.mjs";
import { buildUpstreamRequest, PathNotOfferedError, RewriteError, SecretMissingError } from "./rewrite.mjs";
import { HookMissingError, HookStageError } from "./hooks.mjs";
import { routeLocalPrefix } from "./store.mjs";

/** 探活超时（连接期与首字节统一 5s——design §6「超时 5s」）。 */
export const PROBE_TIMEOUT_MS = 5_000;

/** 探活三态。 */
export const PROBE_STATES = ["reachable", "unreachable", "no_auth"];

/**
 * 探活路径候选（白名单优先）。
 * @param {Record<string, any>} service
 * @returns {string[]}
 */
function probePathCandidates(service) {
  const out = [];
  for (const route of service.routes ?? []) {
    if ((route.mode ?? "prefix") === "prefix") out.push(routeLocalPrefix(route));
  }
  out.push("/");
  return out;
}

/**
 * 上游探活。
 * @param {{
 *   service: Record<string, any>,
 *   secrets?: (name: string) => string | undefined,
 *   home?: string,
 *   timeouts?: { connectMs?: number, firstByteMs?: number },
 *   fetchImpl?: typeof fetch,
 *   probeConnect?: (url: URL, ms: number) => Promise<void>,
 * }} input
 * @returns {Promise<{ state: "reachable", status: number, ms: number } | { state: "unreachable", reason: string, ms: number } | { state: "no_auth", reason: "keyenv_unbound" | "secret_missing", keyEnv?: string, ms: number }>}
 */
export async function probeUpstream(input) {
  const { service } = input;
  const started = Date.now();
  const ms = () => Date.now() - started;
  const timeouts = input.timeouts ?? {};
  const connectMs = timeouts.connectMs ?? PROBE_TIMEOUT_MS;
  const firstByteMs = timeouts.firstByteMs ?? PROBE_TIMEOUT_MS;

  // no_auth 分诊①：预设 keyEnv 未绑定 auth 槽（hooks 预设模式的 ① 归脚本——
  // 有 hooks 声明时不在此拦）。零上游触达。
  if (service.keyEnv !== undefined && service.auth === undefined && service.hooks === undefined) {
    return { state: "no_auth", reason: "keyenv_unbound", keyEnv: service.keyEnv, ms: ms() };
  }

  // 同一管线构造（含 auth 三族解析与 ② 脚本增量）；候选路径逐个试。
  const hooksOpts = input.home !== undefined ? { home: input.home } : {};
  let plan;
  let lastError;
  for (const path of probePathCandidates(service)) {
    try {
      plan = await buildUpstreamRequest(service, { method: "GET", path }, input.secrets, hooksOpts);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof SecretMissingError || err instanceof HookMissingError) {
        // no_auth 分诊②：auth 槽已声明但 secret 在库缺失（补救动作同一：绑 secret）。
        return { state: "no_auth", reason: "secret_missing", ms: ms() };
      }
      if (err instanceof HookStageError) {
        // ①② 脚本失效——管线未通（上游未触达），固定脱敏文案在错误族内。
        return { state: "unreachable", reason: "hook_failed", ms: ms() };
      }
      // PathNotOfferedError / RewriteError → 试下一候选
    }
  }
  if (plan === undefined) {
    return {
      state: "unreachable",
      reason: lastError instanceof RewriteError ? "protocol_error" : "path_not_offered",
      ms: ms(),
    };
  }

  // 连接期 TCP 探测（forward 同款）→ fetch GET（redirect manual；任意状态即达）。
  const probeConnect = input.probeConnect ?? defaultProbeConnect;
  try {
    await probeConnect(plan.url, connectMs);
  } catch {
    return { state: "unreachable", reason: "upstream_unreachable", ms: ms() };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), firstByteMs);
  try {
    const resp = await fetchImpl(plan.url, {
      method: "GET",
      headers: { ...plan.headers, host: plan.host },
      redirect: "manual",
      signal: ctrl.signal,
    });
    try {
      await resp.body?.cancel(); // 不消费正文（最小请求——零响应体读取）
    } catch {
      /* 取消失败不影响探活结论 */
    }
    return { state: "reachable", status: resp.status, ms: ms() };
  } catch {
    return { state: "unreachable", reason: ctrl.signal.aborted ? "timeout" : "upstream_unreachable", ms: ms() };
  } finally {
    clearTimeout(timer);
  }
}
