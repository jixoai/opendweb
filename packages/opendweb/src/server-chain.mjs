// server 启动链共享件（home-hub 1b）：bin/opendweb.mjs 的 runServer 与
// src/hub.mjs 的中枢统一执行链（hub start --foreground，detached/系统服务
// 同链）共用的纯函数族——bind/URL 校验、参数三层解析（flag > env > config
// > default）、启动横幅、readiness 探测、preStart 覆写合并与单飞停机编排。
// 意图（2026-09-24）：函数体自 bin 原样迁入（测试兼容面由 bin re-export
// 保持：cli.test.mjs 仍从 bin 导入 resolveServerArgs/buildBanner 等）；
// hub 链不得反向 import bin（避免 bin→hub→bin 环）。

import { createRequire } from "node:module";

import { asciiEscape, networkIPv4s, CliExit } from "./util.mjs";

/**
 * 拆解 bind 串 "host:port"（支持 "[ipv6]:port" 括号形态）。
 * @param {string} bind
 */
export function splitBind(bind) {
  const bracket = /^\[(.+)\](?::(\d+))?$/.exec(bind);
  if (bracket) {
    return { host: bracket[1], port: bracket[2] !== undefined ? Number(bracket[2]) : undefined };
  }
  const i = bind.lastIndexOf(":");
  if (i === -1) return { host: bind, port: undefined };
  const port = Number(bind.slice(i + 1));
  if (Number.isInteger(port)) return { host: bind.slice(0, i), port };
  return { host: bind, port: undefined };
}

/**
 * 公网 URL 校验 + 规范化（public-exposure D2，与 Rust validate_public_url 同规；
 * R2 P1-1/P1-3 对齐）：`http(s)://host[:port]`；scheme 大小写不敏感并归一为
 * 小写；host 仅限 ASCII 字母/数字/`.`/`-`（或括号 IPv6）；拒绝空白与非
 * ASCII、path（尾随单个 "/" 先剥除）、query、fragment、userinfo、空端口与
 * 1-65535 之外的端口。返回 canonical 形态字符串，非法返回 null。
 * @param {string} value
 * @returns {string | null}
 */
export function normalizePublicUrl(value) {
  const raw = String(value);
  const v = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  // 纯可打印 ASCII：scheme/host/port 合法字符均为 ASCII；与 Rust 侧的显式
  // 拒绝保持一致（空格/控制字符/unicode host 不得进入公告）
  if (!/^[\x21-\x7e]+$/.test(v)) return null;
  // host 字符集排除 ':' —— 否则贪婪匹配会吞掉端口段绕过端口校验（如 ex.com:0）
  const m = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d+))?$/i.exec(v);
  if (!m) return null;
  const port = m[3];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  // 括号形态必须是合法 IPv6（net.isIP 判定；与 Rust parse::<Ipv6Addr> 同规）
  if (m[2].startsWith("[")) {
    if (isIp6Literal(m[2].slice(1, -1)) === false) return null;
  }
  // 端口 canonical 重建为十进制整数：前导零必须剥除（":00001" → ":1"，
  // 与 Rust 侧 u32 重建一致——双入口同规）
  return `${m[1].toLowerCase()}://${m[2]}${port !== undefined ? `:${Number(port)}` : ""}`;
}

/**
 * 合法 IPv6 字面量判定（net.isIP 的懒加载包装，避免顶层引入 node:net）。
 * @param {string} inner
 * @returns {boolean}
 */
function isIp6Literal(inner) {
  return netIsIP(inner) === 6;
}
let netIsIPFn = null;
function netIsIP(v) {
  if (netIsIPFn === null) {
    // createRequire 惰性加载，保持模块顶层依赖面不变
    netIsIPFn = createRequire(import.meta.url)("node:net").isIP;
  }
  return netIsIPFn(v);
}

/**
 * 公网 URL 校验（错误消息包装）：返回 null = 合法，否则错误消息。
 * @param {string} value
 * @param {string} label
 * @returns {string | null}
 */
export function validatePublicUrl(value, label) {
  const raw = String(value);
  if (normalizePublicUrl(raw) === null) {
    return `invalid ${label}: ${raw} (expected http(s)://host[:port], no path/query/fragment)`;
  }
  return null;
}

/**
 * bind 串校验（R2 阻塞-8：preStart 覆写与 flag/config 同形态）：显式
 * host:port（支持 [ipv6]:port），host 非空、port 1-65535。返回 null = 合法。
 * @param {unknown} value
 * @param {string} label
 * @returns {string | null}
 */
export function validateBind(value, label) {
  if (typeof value !== "string" || value.length === 0) return `${label} must be a non-empty host:port string`;
  const { host, port } = splitBind(value);
  if (host.length === 0) return `${label}: ${value} (empty host)`;
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    return `${label}: ${value} (expected host:port with port 1-65535)`;
  }
  if (!value.startsWith("[") && host.includes(":")) {
    return `${label}: ${value} (bare IPv6 must use [addr]:port)`;
  }
  return null;
}

/**
 * env 数值解析（[server.access] 链，与 Rust env_u64 同规）：整数 + 区间
 * 校验，非法值返回错误文案（CLI fail-fast，早于子进程 spawn）。空串/未设
 * 视为未给出（与 Rust 的 filter 空串语义一致）。
 * @param {string | undefined} raw
 * @param {{ label: string, min: number, max: number }} range
 * @returns {{ value?: number, error?: string }}
 */
function envIntInRange(raw, { label, min, max }) {
  if (raw === undefined || raw === "") return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { error: `invalid ${label} ${raw}: must be an integer in ${min}..=${max}` };
  }
  return { value: n };
}

/**
 * 解析 server 子命令参数。优先级 flag > env > config file > default
 * （plugin-marketplace D4：config 层插入在 env 之后；configServer 由静态
 * 配置文件解析而来，schema 已校验类型）。--gateway 为 canonical；
 * 支持 "--opt value" 与 "--opt=value" 双形式；未知选项报错（退出码 2）。
 * [server.access] 链（server-access-policy task 1.3）同构：flag 只设
 * --access-mode/--owners-file（与 Rust 侧 flag 集合中 TS 暴露的子集对齐，
 * --data-dir/--allow-loopback-callback 由 dweb-server 二进制直用）；其余
 * 走 env/config。mode/policy/ownersFile/callback* 不做 CLI 端白名单校验，
 * 非法值透传给 Rust fail-fast（报错带准确 env 名）；数值字段同规区间校验。
 * @param {string[]} argv process.argv.slice(3)（"server" 之后）
 * @param {Record<string, string|undefined>} [env]
 * @param {{ gatewayBind?: string, relayBind?: string, relayEnabled?: boolean, trustProxy?: boolean, publicGatewayUrl?: string, publicRelayUrl?: string, access?: { mode?: string, policy?: string, ownersFile?: string, callbackUrl?: string, callbackToken?: string, callbackTimeoutMs?: number, callbackCacheTtlMs?: number, allowLoopbackCallback?: boolean } }} [configServer]
 * @returns {{ gatewayBind: string, relayBind: string, relayEnabled: boolean, trustProxy: boolean, publicGatewayUrl: string | null, publicRelayUrl: string | null, access: { mode?: string, policy?: string, ownersFile?: string, callbackUrl?: string, callbackToken?: string, callbackTimeoutMs?: number, callbackCacheTtlMs?: number, allowLoopbackCallback?: boolean } } | { error: string }}
 */
export function resolveServerArgs(argv, env = process.env, configServer = {}) {
  /** @type {Record<string, string|boolean|undefined>} */
  const opts = {};
  const VALUE_OPTS = new Set([
    "--gateway",
    "--relay",
    "--public-gateway",
    "--public-relay",
    "--access-mode",
    "--owners-file",
  ]);
  const FLAG_OPTS = new Set(["--no-relay", "--trust-proxy"]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!VALUE_OPTS.has(name) && !FLAG_OPTS.has(name)) {
      return { error: `unknown option ${name}` };
    }
    if (FLAG_OPTS.has(name)) {
      opts[name] = true;
      continue;
    }
    let value = eq === -1 ? undefined : token.slice(eq + 1);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) return { error: `missing value for ${name}` };
    }
    opts[name] = value;
  }
  const gatewayFlag = typeof opts["--gateway"] === "string" ? opts["--gateway"] : undefined;
  const relayFlag = typeof opts["--relay"] === "string" ? opts["--relay"] : undefined;
  // flag > env > config > default（config 只在 env 未给出时生效）
  const gatewayBind =
    gatewayFlag ?? env.DWEB_GATEWAY_BIND ?? configServer.gatewayBind ?? "0.0.0.0:8787";
  const relayBind =
    relayFlag ?? env.DWEB_RELAY_HTTP_BIND ?? configServer.relayBind ?? "0.0.0.0:3340";
  // 开关链：--no-relay > env(DWEB_RELAY_ENABLED false/0/off) > config > true
  const relayEnabled = !opts["--no-relay"]
    && !["false", "0", "off"].includes(env.DWEB_RELAY_ENABLED ?? "true")
    && (configServer.relayEnabled ?? true);
  const trustProxy = Boolean(opts["--trust-proxy"])
    || env.DWEB_TRUST_PROXY === "1"
    || (configServer.trustProxy ?? false);
  const publicGatewayFlag = typeof opts["--public-gateway"] === "string" ? opts["--public-gateway"] : undefined;
  const publicRelayFlag = typeof opts["--public-relay"] === "string" ? opts["--public-relay"] : undefined;
  const rawPublicGateway =
    publicGatewayFlag ?? env.DWEB_PUBLIC_GATEWAY_URL ?? configServer.publicGatewayUrl ?? null;
  const rawPublicRelay =
    publicRelayFlag ?? env.DWEB_PUBLIC_RELAY_URL ?? configServer.publicRelayUrl ?? null;
  if (rawPublicGateway !== null) {
    const err = validatePublicUrl(rawPublicGateway, "public gateway url");
    if (err) return { error: err };
  }
  if (rawPublicRelay !== null) {
    const err = validatePublicUrl(rawPublicRelay, "public relay url");
    if (err) return { error: err };
  }
  // [server.access] 链：flag(--access-mode/--owners-file) > env > config（未
  // 给出的键保持 undefined——startServer 仅显式定义时写 env，缺省继承父进程
  // 环境或落 Rust 侧默认 open/static）。数值字段 env 形态是字符串，先过同规
  // 区间校验再数值化。allowLoopbackCallback 无 flag/env（Rust 只认二进制
  // flag --allow-loopback-callback），config 是唯一 TS 入口。
  const timeoutMs = envIntInRange(env.DWEB_CALLBACK_TIMEOUT_MS, {
    label: "DWEB_CALLBACK_TIMEOUT_MS",
    min: 1,
    max: 2000,
  });
  if (timeoutMs.error) return { error: timeoutMs.error };
  const cacheTtlMs = envIntInRange(env.DWEB_CALLBACK_CACHE_TTL_MS, {
    label: "DWEB_CALLBACK_CACHE_TTL_MS",
    min: 0,
    max: 60000,
  });
  if (cacheTtlMs.error) return { error: cacheTtlMs.error };
  const accessModeFlag = typeof opts["--access-mode"] === "string" ? opts["--access-mode"] : undefined;
  const ownersFileFlag = typeof opts["--owners-file"] === "string" ? opts["--owners-file"] : undefined;
  const access = {
    mode: accessModeFlag ?? env.DWEB_ACCESS_MODE ?? configServer.access?.mode,
    policy: env.DWEB_ACCESS_POLICY ?? configServer.access?.policy,
    ownersFile: ownersFileFlag ?? env.DWEB_OWNERS_FILE ?? configServer.access?.ownersFile,
    callbackUrl: env.DWEB_CALLBACK_URL ?? configServer.access?.callbackUrl,
    callbackToken: env.DWEB_CALLBACK_TOKEN ?? configServer.access?.callbackToken,
    callbackTimeoutMs: timeoutMs.value ?? configServer.access?.callbackTimeoutMs,
    callbackCacheTtlMs: cacheTtlMs.value ?? configServer.access?.callbackCacheTtlMs,
    allowLoopbackCallback: configServer.access?.allowLoopbackCallback,
  };
  return {
    gatewayBind,
    relayBind,
    relayEnabled,
    trustProxy,
    // canonical 形态（scheme 小写、无尾随 "/"）——与 Rust 侧重建语义一致
    publicGatewayUrl: rawPublicGateway === null ? null : normalizePublicUrl(rawPublicGateway),
    publicRelayUrl: rawPublicRelay === null ? null : normalizePublicUrl(rawPublicRelay),
    access,
  };
}

/**
 * vite 风格启动横幅（全 ASCII，码位 < 128；design D1）。设置公网覆盖时
 * 追加 Public 节（public-exposure D5/D6），并把配置入口指引切换为公网地址。
 * 动态值纪律（D10）：所有非字面量输出（version/Local host/port/Network ip/
 * Public URL/服务表 port）一律经 asciiEscape，禁止裸插值。
 * @param {{ version: string, gatewayBind: string, relayBind: string, relayEnabled: boolean, ips: string[], publicGatewayUrl?: string | null, publicRelayUrl?: string | null }} input
 */
export function buildBanner({ version, gatewayBind, relayBind, relayEnabled, ips, publicGatewayUrl = null, publicRelayUrl = null }) {
  const { host, port } = splitBind(gatewayBind);
  const relay = splitBind(relayBind);
  const unspecified = host === "0.0.0.0" || host === "::" || host === "";
  const localHost = unspecified ? "localhost" : host;
  const portText = port === undefined ? "-" : String(port);
  const relayPortText = relay.port === undefined ? "-" : String(relay.port);
  // 枚举函数已去重；此处再防御一次（规格：无遗漏、无重复）
  const uniqueIps = [...new Set(ips)];

  const lines = [];
  lines.push(`  * opendweb server v${asciiEscape(version)}`);
  lines.push(`  > Local:   http://${asciiEscape(localHost)}:${asciiEscape(portText)}`);
  if (uniqueIps.length === 0) {
    // 全部网卡不可枚举时打印占位行而非省略
    lines.push(`  > Network: (no non-loopback IPv4 found)`);
  } else {
    lines.push(`  > Network: http://${asciiEscape(uniqueIps[0])}:${asciiEscape(portText)}`);
    for (const ip of uniqueIps.slice(1)) {
      lines.push(`             http://${asciiEscape(ip)}:${asciiEscape(portText)}`);
    }
  }
  // Public 节：反代/隧道部署下这才是跨网客户端的配置入口（未设置的条目不出现）
  if (publicGatewayUrl !== null || publicRelayUrl !== null) {
    if (publicGatewayUrl !== null) {
      lines.push(`  > Public:  gateway ${asciiEscape(publicGatewayUrl)}`);
    }
    if (publicRelayUrl !== null) {
      const prefix = publicGatewayUrl === null ? "  > Public:  " : "             ";
      lines.push(`${prefix}relay   ${asciiEscape(publicRelayUrl)}`);
    }
  }
  lines.push("");
  if (publicGatewayUrl !== null || publicRelayUrl !== null) {
    lines.push("  Use the Public URLs as the config entry for clients (Network");
    lines.push("  addresses above still work on the local network).");
  } else {
    lines.push("  Use any Network address as the single config entry for clients.");
  }
  lines.push("");
  const rows = [
    ["gateway", portText, "entry point"],
    ["rendezvous", portText, "merged into gateway"],
    ["relay", relayPortText, relayEnabled ? "enabled" : "disabled"],
  ].map(([name, p, state]) => [name, asciiEscape(p), state]);
  const wName = Math.max("NAME".length, ...rows.map((r) => r[0].length)) + 3;
  const wPort = Math.max("PORT".length, ...rows.map((r) => r[1].length)) + 3;
  lines.push(`    ${"NAME".padEnd(wName)}${"PORT".padEnd(wPort)}STATE`);
  for (const [name, p, state] of rows) {
    lines.push(`    ${name.padEnd(wName)}${p.padEnd(wPort)}${state}`);
  }
  lines.push("");
  lines.push("  Press Ctrl+C to stop");
  return lines.join("\n");
}

/**
 * readiness 探测基址：unspecified bind（0.0.0.0/::）换 127.0.0.1；
 * 裸 IPv6 host 加括号。
 * @param {string} bind
 * @returns {string}
 */
export function probeBindBase(bind) {
  const { host, port } = splitBind(bind);
  const h = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  const bracketed = h.includes(":") ? `[${h}]` : h;
  return `http://${bracketed}:${port ?? 8787}`;
}

/**
 * gateway /healthz 就绪探测（R2 P1-2 readiness 门）；超时抛错（子进程仍
 * 存活但永不就绪属异常态，由调用方 stop 后上抛）。
 * @param {string} base
 * @param {number} [timeoutMs]
 */
export async function waitForGatewayReady(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return { ready: true };
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms (${base}/healthz)`);
}

/** preStart 覆写合并：键白名单 + 同规校验（URL 走 normalizePublicUrl）；
 * access 段不经插件覆写——访问控制是安全面，仅 flag/env/config 三入口 */
export function applyServerOverrides(resolved, merged) {
  if (!merged || Object.keys(merged).length === 0) return resolved;
  const out = { ...resolved };
  for (const [key, value] of Object.entries(merged)) {
    switch (key) {
      case "gatewayBind":
      case "relayBind": {
        const err = validateBind(value, `preStart override ${key}`);
        if (err) throw new CliExit(err, 2);
        out[key] = value;
        break;
      }
      case "relayEnabled":
      case "trustProxy":
        if (typeof value !== "boolean") throw new CliExit(`preStart override ${key} must be a boolean`, 2);
        out[key] = value;
        break;
      case "publicGatewayUrl":
      case "publicRelayUrl": {
        const err = validatePublicUrl(String(value), `preStart override ${key}`);
        if (err) throw new CliExit(err, 2);
        out[key] = normalizePublicUrl(String(value));
        break;
      }
      default:
        throw new CliExit(`preStart override has unknown key: ${key}`, 2);
    }
  }
  return out;
}

/**
 * R6-Major 单飞停止编排（复审 6.2 导出供回归测试）：SIGINT/SIGTERM 与重复
 * 信号共享同一停止流程——第二次调用复用同一 in-flight promise，不得绕过
 * 仍在等待的 preStop（如 cloudflared 子进程终态）抢先 server.stop/exit。
 * 流程时序：runPreStop（尽力，失败由调用方降级）→ stopServer（等子进程
 * 终态落定）→ exit(0)。
 * @param {{ runPreStop: () => Promise<void>, stopServer: () => Promise<void>, exit?: (code: number) => void }} input
 * @returns {() => Promise<void>} 信号处理器：幂等，重复调用返回同一 promise
 */
export function makeSingleFlightShutdown({ runPreStop, stopServer, exit = (code) => process.exit(code) }) {
  let inFlight = null;
  return () => {
    inFlight ??= (async () => {
      await runPreStop();
      // exit 等 stop 落定（.finally 兜底 stopServer 异常路径）；单飞 promise
      // 在完整停止流程结束时才结算——重复信号在窗口内拿到的是 pending 态
      await stopServer().finally(() => exit(0));
    })();
    return inFlight;
  };
}
