#!/usr/bin/env node
// opendweb CLI — 顶层入口（builtin 命令 + 自适应插件派发）。
// server：启动自托管服务端（gateway: rendezvous + healthz + services.json +
// iroh relay）；静态配置 opendweb.config.toml|.json（--config 覆盖），优先级
// flag > env > config > default。marketplace/plugin/setup 管插件生命周期；
// 其余首 token 走自适应解析（未安装自愈：get ?? add）。
// 用法：
//   opendweb server [--gateway <bind>] [--relay <bind>] [--no-relay] [--trust-proxy]
//                   [--public-gateway <url>] [--public-relay <url>]
//                   [--access-mode <open|restricted>] [--owners-file <path>] [--config <path>]
//   环境变量 DWEB_GATEWAY_BIND 同义；DWEB_PUBLIC_GATEWAY_URL / DWEB_PUBLIC_RELAY_URL
//   为反代/隧道部署的公网入口公告（public-exposure）。
//   访问控制（[server.access] 配置段，task 1.3）：--access-mode/--owners-file
//   flag + DWEB_ACCESS_* env + config 三层同链；--data-dir 走 DWEB_DATA_DIR
//   env（数据目录不入 config 段）。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadMarketplace, marketplaceAdd, marketplaceRemove } from "../src/marketplace.mjs";
import { resolveAdaptive, wantsPluginHelp, PluginNotResolved } from "../src/plugin-resolve.mjs";
import { dispatchPluginCommand, renderPluginHelp, foldSingleCommand } from "../src/plugin-contract.mjs";
import { pluginAdd, pluginRemove, pluginList, pluginUpdate, latestVersion, loadLockfile, readInstalledVersion } from "../src/plugin-registry.mjs";
import { discoverConfig, loadConfigFile } from "../src/config-file.mjs";
import { loadDeclaredPlugins, fireHook } from "../src/plugin-runtime.mjs";
import { CliExit, asciiEscape, networkIPv4s } from "../src/util.mjs";
import { validatePublicUrl } from "../src/server-chain.mjs";
import { runId } from "../src/identity.mjs";
import { runJoin } from "../src/join.mjs";
import { runHub } from "../src/hub.mjs";
import {
  applyServerOverrides,
  buildBanner,
  makeSingleFlightShutdown,
  probeBindBase,
  resolveServerArgs,
  waitForGatewayReady,
} from "../src/server-chain.mjs";

const require = createRequire(import.meta.url);
const PLATFORMS = ["darwin-arm64", "win32-x64"];
const SUPPORTED = `${process.platform}-${process.arch}`;
if (!PLATFORMS.includes(SUPPORTED)) {
  console.error(
    `opendweb: platform ${SUPPORTED} is not supported yet. v0.2 ships ${PLATFORMS.join(" / ")}; use the docker image ghcr.io/gaubee/dweb for server deployments.`,
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const VERSION = pkg.version;

// 测试兼容面（cli.test.mjs 自 bin 导入的纯函数族——home-hub 1b 迁移至
// src/server-chain.mjs 与 src/util.mjs 后在此 re-export，导入路径不变）
export {
  buildBanner,
  makeSingleFlightShutdown,
  normalizePublicUrl,
  probeBindBase,
  resolveServerArgs,
  splitBind,
  validateBind,
  validatePublicUrl,
  waitForGatewayReady,
} from "../src/server-chain.mjs";
export { networkIPv4s } from "../src/util.mjs";

// ---------------------------------------------------------------------------
// 命令分发（plugin-marketplace D2）：builtin 恒优先，其余首 token 走自适应
// 插件解析；`use <name>` 为显式等价形（纯转发，无附加语义）。
// ---------------------------------------------------------------------------

/** 用户级 CLI 状态目录（DWEB_HOME 覆盖，供测试隔离） */
function dwebHome() {
  return process.env.DWEB_HOME ?? path.join(os.homedir(), ".opendweb");
}

async function marketplaceGlobs() {
  const { globs } = await loadMarketplace({
    fs: await import("node:fs/promises"),
    path: path.join(dwebHome(), "marketplace.json"),
  });
  return globs;
}

/** 继承 stdio 的子进程执行（包管理器安装/卸载的输出直通用户） */
function spawnInherit(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve({ code: null, stderr: `${cmd}: command not found` }));
    child.on("exit", (c) => resolve({ code: c ?? 0, stderr: "" }));
  });
}

/**
 * 从 argv 剥离 `--config <path>`（server/setup 共用的非业务选项）。
 * @param {string[]} rest
 * @returns {{ configFlag: string | undefined, argv: string[] }}
 */
function stripConfigFlag(rest) {
  let configFlag;
  const argv = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--config") {
      configFlag = rest[++i];
      if (configFlag === undefined) throw new CliExit("missing value for --config", 2);
      continue;
    }
    argv.push(rest[i]);
  }
  return { configFlag, argv };
}

async function runServer(rest) {
  const { configFlag, argv: serverArgv } = stripConfigFlag(rest);
  // 静态配置发现与解析（零执行；plugin-marketplace D4）
  const configPath = discoverConfig({
    cwd: process.cwd(),
    explicit: configFlag,
    existsSync: (p) => fs.existsSync(p),
  });
  const config = configPath
    ? await loadConfigFile({
        path: configPath,
        validateUrl: (v) => validatePublicUrl(v, "config server url"),
      })
    : null;
  const resolved = resolveServerArgs(serverArgv, process.env, config?.server ?? {});
  if ("error" in resolved) {
    console.error(`error: ${asciiEscape(resolved.error)}`);
    process.exit(2);
  }

  // 插件装载与 preStart（plugin-marketplace D5：失败阻断）。本地插件 file
  // 路径相对配置文件目录解析（R2 阻塞-3）
  const plugins =
    config && config.plugins.length > 0
      ? await loadDeclaredPlugins({
          plugins: config.plugins,
          globs: await marketplaceGlobs(),
          cwd: process.cwd(),
          configDir: path.dirname(configPath),
        })
      : [];
  const pre = await fireHook({
    plugins,
    hook: "server.preStart",
    payload: { server: { ...resolved } },
  });
  if (pre.failures.length > 0) process.exit(1);
  const final = applyServerOverrides(resolved, pre.merged);

  const { startServer } = await import("@jixo/opendweb-server-binary");
  // access 字段（task 1.3）：undefined 值不写 env（startServer 仅显式定义时
  // 注入），缺省继承父进程环境或落 Rust 侧默认——与 gateway/relay 链同构
  const server = await startServer({
    gatewayBind: final.gatewayBind,
    relayBind: final.relayBind,
    relayEnabled: final.relayEnabled,
    trustProxy: final.trustProxy,
    publicGatewayUrl: final.publicGatewayUrl ?? undefined,
    publicRelayUrl: final.publicRelayUrl ?? undefined,
    accessMode: final.access.mode,
    accessPolicy: final.access.policy,
    ownersFile: final.access.ownersFile,
    callbackUrl: final.access.callbackUrl,
    callbackToken: final.access.callbackToken,
    callbackTimeoutMs: final.access.callbackTimeoutMs,
    callbackCacheTtlMs: final.access.callbackCacheTtlMs,
    allowLoopbackCallback: final.access.allowLoopbackCallback,
  });
  // R2 P1-2：先等 gateway 就绪（或子进程退出）再打横幅——子进程因端口冲突/
  // 环境问题秒退时，不打印伪成功横幅；错误转发 stderr 且退出码保留。
  const probeBase = probeBindBase(final.gatewayBind);
  let ready;
  try {
    ready = await Promise.race([
      waitForGatewayReady(probeBase),
      server.exited.then((code) => ({ exited: code })),
    ]);
  } catch (e) {
    await server.stop();
    throw e;
  }
  if (ready && typeof ready.exited === "number") {
    // 根因已由 wrapper 实时转发（R3 P2：不回放 stderrTail，避免重复）；
    // 此处只补 CLI 自身的错误摘要与退出码
    console.error(`error: server exited unexpectedly (code ${ready.exited})`);
    // 退出码 0 的"秒退"同样是异常态（server 不应自行退出），归一为 1
    process.exit(ready.exited === 0 ? 1 : ready.exited);
  }

  // postReady（失败降级 WARNING；结果可带 bannerLines 扩展横幅）
  const post = await fireHook({
    plugins,
    hook: "server.postReady",
    payload: {
      server: { ...final },
      gatewayUrl: probeBase,
      publicGatewayUrl: final.publicGatewayUrl,
      publicRelayUrl: final.publicRelayUrl,
    },
  });
  for (const f of post.failures) {
    console.error(`WARNING[plugin/${asciiEscape(f.name)}]: postReady failed (${asciiEscape(f.error)})`);
  }

  console.log(
    buildBanner({
      version: VERSION,
      gatewayBind: final.gatewayBind,
      relayBind: final.relayBind,
      relayEnabled: final.relayEnabled,
      ips: networkIPv4s(),
      publicGatewayUrl: final.publicGatewayUrl,
      publicRelayUrl: final.publicRelayUrl,
    }),
  );
  for (const line of [...pre.bannerLines, ...post.bannerLines]) {
    console.log(`  ${line}`);
  }

  // R6-Major：SIGINT/SIGTERM 与重复信号共享同一停止流程（单飞编排器语义
  // 见 makeSingleFlightShutdown）——第二次调用不得绕过仍在等待的 preStop
  // （如 cloudflared 子进程终态）抢先 server.stop/exit
  const shutdown = makeSingleFlightShutdown({
    runPreStop: async () => {
      // preStop：尽力执行（失败仅 WARNING），再停 server
      const preStop = await fireHook({ plugins, hook: "server.preStop", payload: { server: { ...final } } });
      for (const f of preStop.failures) {
        console.error(`WARNING[plugin/${asciiEscape(f.name)}]: preStop failed (${asciiEscape(f.error)})`);
      }
    },
    stopServer: () => server.stop(),
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const code = await server.exited;
  process.exit(code ?? 0);
}

async function runMarketplace(rest) {
  const [sub, ...args] = rest;
  const fsp = await import("node:fs/promises");
  const mpPath = path.join(dwebHome(), "marketplace.json");
  await fsp.mkdir(dwebHome(), { recursive: true });
  if (sub === "list" || sub === undefined) {
    const { globs } = await loadMarketplace({ fs: fsp, path: mpPath });
    console.log(globs.join("\n"));
    return 0;
  }
  if (sub === "add") {
    if (args.length === 0) throw new CliExit("usage: opendweb marketplace add \"npm:<glob>, ...\"", 2);
    const { added, globs } = await marketplaceAdd({ fs: fsp, path: mpPath, input: args.join(" ") });
    console.log(added.length > 0 ? `added: ${added.join(", ")}` : "no new globs (already present)");
    console.log(globs.join("\n"));
    return 0;
  }
  if (sub === "remove") {
    if (args.length === 0) throw new CliExit("usage: opendweb marketplace remove \"npm:<glob>, ...\"", 2);
    const { removed, globs } = await marketplaceRemove({ fs: fsp, path: mpPath, input: args.join(" ") });
    console.log(`removed: ${removed.join(", ")}`);
    console.log(globs.join("\n"));
    return 0;
  }
  throw new CliExit(`unknown marketplace subcommand: ${sub} (add | list | remove)`, 2);
}

/**
 * plugin 子命令的 flag/位置参数解析：--name=<v> 与 --name <v> 两种形态，
 * 未知 --flag 硬错误（防静默忽略）。
 * @param {string[]} rest
 * @returns {{ args: string[], name?: string, alias?: string, force: boolean, full: boolean }}
 */
function parsePluginFlags(rest) {
  const out = { args: [], force: false, full: false };
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    const eq = t.match(/^--(name|alias|force|full)(?:=(.*))?$/);
    if (!eq) {
      if (t.startsWith("--")) throw new CliExit(`unknown plugin flag: ${t}`, 2);
      out.args.push(t);
      continue;
    }
    const [, key, inline] = eq;
    if (key === "force") {
      if (inline !== undefined) throw new CliExit("--force takes no value", 2);
      out.force = true;
    } else if (key === "full") {
      if (inline !== undefined) throw new CliExit("--full takes no value", 2);
      out.full = true;
    } else {
      let value = inline;
      if (value === undefined) {
        value = rest[i + 1];
        if (value === undefined) throw new CliExit(`--${key} requires a value`, 2);
        i += 1;
      }
      if (value === "") throw new CliExit(`--${key} must not be empty`, 2);
      out[key === "name" ? "name" : "alias"] = value;
    }
  }
  return out;
}

async function runPlugin(rest) {
  const [sub, ...restAfterSub] = rest;
  const fsp = await import("node:fs/promises");
  const lockPath = path.join(dwebHome(), "plugins.json");
  await fsp.mkdir(dwebHome(), { recursive: true });
  const ctx = {
    cwd: process.cwd(),
    lockPath,
    existsSync: (p) => fs.existsSync(p),
    run: spawnInherit,
  };
  if (sub === "list" || sub === undefined) {
    const { full, args } = parsePluginFlags(restAfterSub);
    if (args.length > 0) throw new CliExit("usage: opendweb plugin list [--full]", 2);
    const records = await pluginList(lockPath, { cwd: ctx.cwd });
    if (records.length === 0) {
      console.log("(no plugins installed)");
      return 0;
    }
    const aliasW = Math.max(...records.map((r) => r.alias.length), "ALIAS".length);
    const pkgW = Math.max(...records.map((r) => r.package.length), "PACKAGE".length);
    const verW = Math.max(...records.map((r) => r.version.length), "VERSION".length);
    const row = (alias, pkg, ver, p) =>
      `  ${alias.padEnd(aliasW)}  ${pkg.padEnd(pkgW)}  ${ver.padEnd(verW)}${full ? `  ${p ?? "(not resolvable)"}` : ""}`;
    console.log(row("ALIAS", "PACKAGE", "VERSION", full ? "PATH" : null));
    for (const r of records) console.log(row(r.alias, r.package, r.version, r.path));
    return 0;
  }
  if (sub === "add" || sub === "install" || sub === "get") {
    const flags = parsePluginFlags(restAfterSub);
    if (flags.args.length > 1) {
      throw new CliExit("usage: opendweb plugin add|install [alias] [--name <pkg>] [--alias <alias>] [--force]", 2);
    }
    const [positional] = flags.args;
    // 位置参数与 --name 互斥：alias 寻址与显式包名是两种安装语义
    if (positional !== undefined && flags.name !== undefined) {
      throw new CliExit(`pass either a positional alias or --name, not both ("${positional}" and "${flags.name}")`, 2);
    }
    if (flags.alias !== undefined && flags.name === undefined && positional === undefined) {
      throw new CliExit("--alias only makes sense together with --name (or a positional alias)", 2);
    }
    // --name 全名安装且未自定义 alias 时，alias 取包全名（opendweb use <full-name> 调用）
    const alias = flags.alias ?? positional ?? flags.name;
    if (!alias) throw new CliExit("usage: opendweb plugin add|install [alias] [--name <pkg>] [--alias <alias>] [--force]", 2);
    const { pkg, version, skipped } = await pluginAdd({
      alias,
      ...(flags.name !== undefined ? { pkgName: flags.name } : {}),
      globs: await marketplaceGlobs(),
      ...ctx,
      force: flags.force,
    });
    if (skipped) {
      console.log(`already installed: ${alias} (${pkg}@${version}); use --force to reinstall or "plugin update ${alias}" to upgrade`);
      return 0;
    }
    console.log(`installed: ${alias} (${pkg}@${version})`);
    return 0;
  }
  if (sub === "remove" || sub === "uninstall") {
    const { args } = parsePluginFlags(restAfterSub);
    const [alias] = args;
    if (!alias) throw new CliExit("usage: opendweb plugin remove|uninstall <alias>", 2);
    const { pkg } = await pluginRemove({ name: alias, ...ctx });
    console.log(`removed: ${alias} (${pkg})`);
    return 0;
  }
  if (sub === "update") {
    const { args } = parsePluginFlags(restAfterSub);
    const [aliasArg] = args;
    if (args.length > 1) throw new CliExit("usage: opendweb plugin update [alias]", 2);
    if (aliasArg !== undefined) {
      const r = await pluginUpdate({ alias: aliasArg, ...ctx });
      console.log(r.upToDate ? `up to date: ${aliasArg} (${r.pkg}@${r.version})` : `updated: ${aliasArg} (${r.pkg}@${r.version}, latest ${r.latest})`);
      return 0;
    }
    // 无参：全量对照。TTY 下 multiselect 勾选批量升级；非 TTY 打印对照表
    const records = await pluginList(lockPath);
    if (records.length === 0) {
      console.log("(no plugins installed)");
      return 0;
    }
    const statuses = [];
    for (const r of records) {
      let latest = null;
      let error = null;
      try {
        latest = await latestVersion(r.package);
      } catch (e) {
        error = e instanceof CliExit ? e.message : String(e);
      }
      statuses.push({ ...r, latest, error });
    }
    const outdated = statuses.filter((s) => s.latest !== null && s.latest !== s.version);
    for (const s of statuses.filter((x) => x.latest !== null && x.latest === x.version)) {
      console.log(`up to date  ${s.alias} (${s.package}@${s.version})`);
    }
    for (const s of statuses.filter((x) => x.error !== null)) {
      console.log(`unavailable ${s.alias} (${s.error})`);
    }
    if (outdated.length === 0) {
      console.log("nothing to update");
      return 0;
    }
    if (process.stdin.isTTY !== true) {
      for (const s of outdated) console.log(`outdated    ${s.alias} ${s.version} -> ${s.latest}`);
      console.log("non-interactive session; update individually: opendweb plugin update <alias>");
      return 0;
    }
    const prompts = await import("@clack/prompts");
    const picked = await prompts.multiselect({
      message: "select plugins to update",
      options: outdated.map((s) => ({
        value: s.alias,
        label: `${s.alias}  ${s.version} -> ${s.latest}`,
        hint: s.package,
      })),
      required: false,
    });
    if (prompts.isCancel(picked)) {
      console.log("aborted; nothing was updated");
      return 0;
    }
    if (picked.length === 0) {
      console.log("nothing selected; nothing was updated");
      return 0;
    }
    for (const alias of picked) {
      const s = statuses.find((x) => x.alias === alias);
      const r = await pluginUpdate({ alias, ...ctx, latest: s.latest });
      console.log(`updated: ${alias} -> ${r.version}`);
    }
    return 0;
  }
  throw new CliExit(`unknown plugin subcommand: ${sub} (add | install | list | remove | uninstall | update)`, 2);
}

/** `opendweb setup [--config <path>]`：按配置清单序执行全部 setup 钩子并聚合（D5） */
async function runSetup(rest) {
  const { configFlag, argv } = stripConfigFlag(rest);
  if (argv.length > 0) throw new CliExit(`setup takes no arguments (got ${argv[0]})`, 2);
  const configPath = discoverConfig({ cwd: process.cwd(), explicit: configFlag, existsSync: (p) => fs.existsSync(p) });
  if (configPath === null) {
    console.log("no config file found; nothing to set up");
    return 0;
  }
  const config = await loadConfigFile({
    path: configPath,
    validateUrl: (v) => validatePublicUrl(v, "config server url"),
  });
  const plugins = await loadDeclaredPlugins({
    plugins: config.plugins,
    globs: await marketplaceGlobs(),
    cwd: process.cwd(),
    configDir: path.dirname(configPath),
  });
  const targets = plugins.filter((p) => p.hooks.includes("setup"));
  if (targets.length === 0) {
    console.log("no plugins declare a setup hook");
    return 0;
  }
  let failed = false;
  for (const p of targets) {
    // configPath/configDir（R2-M2）：显式 --config 时插件必须知道目标文件，
    // 否则如 cf 向导会写错位置（固定写 cwd 下的默认名）
    const r = await p.invoke("setup", {
      server: config.server ?? {},
      cwd: process.cwd(),
      configPath,
      configDir: path.dirname(configPath),
    });
    if (r.ok) {
      console.log(`setup ok: ${asciiEscape(p.name)}`);
    } else {
      failed = true;
      console.error(`error[plugin/${asciiEscape(p.name)}]: ${asciiEscape(r.error ?? "setup failed")}`);
    }
  }
  return failed ? 1 : 0;
}

/**
 * 自适应插件调用：解析 → help 零执行 / 命令派发（D2/D3）。
 * 自愈安装（Owner 决策 2026-08-29 第四轮）：`opendweb cf` 即 get cf ?? add cf
 * ——全部候选未安装时自动取首个候选（声明序 = 官方 scoped 优先）安装并重试
 * 一次；安装输出可见（继承 stdio）。DWEB_NO_AUTO_INSTALL=1 关闭自愈，回退为
 * 手动指引（CI/确定性环境的逃生阀）。
 */
async function runAdaptive(name, rest) {
  const globs = await marketplaceGlobs();
  // lock 优先：显式安装（plugin add [--name] [--alias]）建立的 alias -> package
  // 记录是信任锚——自定义 alias（如 mycf）不在 marketplace 寻址空间内
  const lockPath = path.join(dwebHome(), "plugins.json");
  const lockRecords = await loadLockfile(lockPath);
  const lockResolved = lockRecords[name]?.package ?? null;
  let installPathTaken = false;
  let resolved;
  try {
    resolved = await resolveAdaptive({ name, globs, cwd: process.cwd(), lockResolved });
  } catch (e) {
    if (!(e instanceof PluginNotResolved) || process.env.DWEB_NO_AUTO_INSTALL === "1") throw e;
    installPathTaken = true;
    const lockPath = path.join(dwebHome(), "plugins.json");
    const { pkg, version } = await pluginAdd({
      alias: name,
      globs,
      cwd: process.cwd(),
      lockPath,
      existsSync: (p) => fs.existsSync(p),
      run: spawnInherit,
      // 自愈语境是「解析失败」：即使 lock 已有记录（安装损坏/文件丢失）也要重装
      force: true,
    });
    console.log(`installed: ${name} (${pkg}@${version})`);
    // 安装成功后重试解析一次；仍失败（布局异常等）→ resolveAdaptive 硬错误
    resolved = await resolveAdaptive({ name, globs, cwd: process.cwd() });
  }
  if (lockResolved === null && !installPathTaken) {
    // 孤儿插件（磁盘可解析但无锁定记录）：能跑但版本粘滞、list 不可见、
    // update 无从升级——提示补锁，不改行为（2026-08-30 用户实测撞上的状态）
    let diskVersion = "";
    try {
      diskVersion = `@${readInstalledVersion(resolved.pkg, process.cwd()).version} `;
    } catch { /* 版本读不出不影响提示 */ }
    console.log(
      `note: ${name} resolved an unlocked ${resolved.pkg} ${diskVersion}from disk; run "plugin install ${name}" to lock it and stay up to date`,
    );
  }
  const { manifest } = resolved;
  // 单命令折叠（webui-console）：单命令 manifest 的非命令首 token（flag 或
  // 空 argv）直接派发唯一命令；多命令 manifest 与显式命令 token 行为零变化。
  // --help 判定仍基于完整 argv（含命令 token），折叠不改变零执行路径
  const { command, argv } = foldSingleCommand({ manifest, rest });
  if (command === undefined || wantsPluginHelp({ argv: rest })) {
    console.log(renderPluginHelp({ name, manifest }));
    return 0;
  }
  const code = await dispatchPluginCommand({ manifest, command, argv, cwd: process.cwd() });
  return code;
}

async function main() {
  const command = process.argv[2] ?? "help";
  const rest = process.argv.slice(3);

  if (command === "server") return await runServer(rest);
  // home-hub [H7]-O-2：中枢命令族（builtin 恒优先——本分支先于自适应插件
  // 解析，marketplace 同名 `hub` 插件不得抢占）
  if (command === "hub") return await runHub(rest, { home: dwebHome() });
  if (command === "marketplace") return await runMarketplace(rest);
  if (command === "plugin") return await runPlugin(rest);
  if (command === "setup") return await runSetup(rest);
  // server-access-roles Phase 3：设备身份/租户自助注册（builtin，恒优先于
  // 自适应插件解析）
  if (command === "id") {
    if (rest.length > 0) throw new CliExit(`id takes no arguments (got ${rest[0]})`, 2);
    return await runId({ home: dwebHome() });
  }
  if (command === "join") return await runJoin(rest, { home: dwebHome() });
  if (command === "use") {
    const [name, ...restAfterUse] = rest;
    if (!name) throw new CliExit("usage: opendweb use <plugin-name> [command]", 2);
    const code = await runAdaptive(name, restAfterUse);
    if (code > 0) process.exit(code);
    return;
  }
  if (command === "help" || command === "--help") {
    console.log(HELP_TEXT);
    return;
  }
  // R2 阻塞-4：config 为保留字——显式拒绝，防插件经 marketplace 接管造成歧义
  if (command === "config") {
    throw new CliExit(
      '"config" is reserved; config files are auto-discovered as opendweb.config.toml|.json or passed via --config <path> to server/setup',
      2,
    );
  }
  // 自适应：非 builtin 首 token → 插件解析（未安装时错误信息含安装指引）
  const code = await runAdaptive(command, rest);
  if (code > 0) process.exit(code);
}

const HELP_TEXT = `opendweb - self-hosted server for opendweb fabrics

Usage:
  opendweb server [--gateway <bind>] [--relay <bind>] [--no-relay] [--trust-proxy]
                   [--public-gateway <url>] [--public-relay <url>]
                   [--access-mode <open|restricted>] [--owners-file <path>] [--config <path>]
      Start the self-hosted server. The gateway (default 0.0.0.0:8787) serves
      rendezvous + /healthz + /services.json; the iroh relay (default
      0.0.0.0:3340) runs on its own port. Precedence: flag > env > config
      file (opendweb.config.toml|.json) > default.
      Access control: --access-mode restricted gates relay access behind
      owner-signed capabilities (open = no access control); --owners-file
      points at the owners.jsonl registry. The [server.access] config
      section carries mode/policy/owners/callback settings; the data
      directory stays a deployment concern (DWEB_DATA_DIR env, default
      dweb-data/).

  opendweb hub init [--gateway <bind>] [--relay <bind>] [--data-dir <path>]
                    [--public-gateway <url>] [--public-relay <url>] [--yes]
      把这台机器变成家里的中枢（一次性：预设+自检+接入卡片）。
      Interactive confirmation first; on confirm: detects an existing data
      directory for takeover (a provably running old service is refused,
      never auto-killed), applies the family preset (restricted access; the
      admin credential is stored in a local 0600 file and never displayed),
      self-checks ports/gateway/firewall, prints the access card and offers
      autostart. Any failed step leaves no partial state behind. --yes
      skips the interactive prompts (non-interactive sessions require it;
      autostart then stays off until enabled explicitly).

  opendweb hub start [--foreground]
      启动中枢（start 后台守护；--foreground 在当前终端运行同一执行链）。
      The detached daemon is spawned with the same foreground chain and its
      pid is recorded in <DWEB_HOME>/hub.pid as an identity triple (pid +
      process start time + command digest). DWEB_DATA_DIR and the admin
      token are injected by the chain from hub.json/hub-token - never via
      argv. With autostart on, start loads the system service instead.

  opendweb hub stop [--yes]
      停止中枢。Stops the daemon after verifying the pid identity triple
      (a reused pid is never signalled); unloads the autostart service
      first when enabled.

  opendweb hub status
      中枢现在怎么样：运行状态、地址、成员、敲门、自启、排障提示。

  opendweb hub card
      重新出示接入卡片（家里人怎么连）。Address + short code + ASCII QR;
      carries no credentials or invite codes.

  opendweb hub open [deep-link]
      本机中枢管理员入口：read hub.json/hub-token, start the local admin
      console (webui sidecar) and open the browser. The admin credential
      never enters argv, the URL or any browser-visible state. Without an
      initialized hub this points at "hub init"; a stopped hub shows the
      hub status card instead.

  opendweb hub autostart on|off [--print]
      开机自动把中枢带回来 / 关掉。Installs/removes the user-level service
      (macOS LaunchAgent with RunAtLoad+KeepAlive, Windows Startup .cmd) -
      no elevated permissions. The service file never carries DWEB_DATA_DIR
      or the admin token; the chain injects them at boot. --print previews
      the generated file without installing anything. Install/uninstall
      failures leave hub.json untouched.

  opendweb id
      Read-only device identity view: prints the endpoint_id (64 hex) of
      this machine's default device key, the anti-phishing short form
      (abc***xyz), this machine's hostname (the default self-reported
      alias, .local suffix stripped) and the key storage path. One default
      key per device; it is created on first "opendweb join". Private key
      material is never printed and no state is modified (repeat runs
      print the same output).

  opendweb join --server <URL> --code <dwebc1 code> [--fabric <hex64>] [--alias <name>] [--allow-insecure]
      Tenant self-service registration (invite-code redemption). Uses the
      default device key as the fabric root, generates a local fabric when
      none exists (reuses the existing one otherwise; --fabric selects
      explicitly - a second fabric is never silently created), signs the
      canonical register payload as proof of possession, and exchanges it
      at POST /register. The request self-reports an alias (default: this
      machine's hostname with the .local suffix stripped; --alias
      overrides, values over 32 UTF-8 bytes are truncated at a character
      boundary). On success the receipt is verified against the
      server's server_id (from /services.json) and the registration
      (server/fabric_id/root/expiry/receipt) is saved to
      <DWEB_HOME>/registration.json. The invite code and the private key
      never appear in any output. Failures exit non-zero and leave no
      partial local state; retrying an already-redeemed code replays the
      first result (idempotent - renewal requires a fresh valid code).
      https is the default expectation; plaintext http is only allowed to
      loopback addresses unless --allow-insecure is passed.

  opendweb marketplace add|list|remove "npm:<glob>, ..."
      Manage plugin candidate globs. Default: npm:@jixo/opendweb-ext-*,
      npm:opendweb-* (declaration order = resolution order; npm: only).

  opendweb plugin list [--full]
      Show installed plugins as a table (ALIAS | PACKAGE | VERSION); --full
      adds the resolved package path.

  opendweb plugin add|install [alias] [--name <pkg>] [--alias <alias>] [--force]
      Install a plugin into the current project (detected package manager)
      and lock alias -> package@version in ~/.opendweb/plugins.json. A
      positional alias is resolved through the marketplace globs; --name
      installs an explicit package name (alias defaults to the full name,
      override with --alias). --force reinstalls over an existing lock entry.

  opendweb plugin update [alias]
      Update one plugin to the registry latest, or (no argument) compare
      all plugins against the registry and pick interactively what to
      upgrade (non-interactive sessions get the comparison table).

  opendweb plugin remove|uninstall <alias>
      Uninstall via the detected package manager and drop the lock entry.

  opendweb setup [--config <path>]
      Run the setup hook of every plugin declared in the config file, in
      declaration order; non-zero exit if any fails.

  opendweb config
      Reserved word (no subcommands): config files are auto-discovered
      (opendweb.config.toml|.json) or passed via --config to server/setup.

  opendweb <plugin-name> [command] [...]     (or: opendweb use <plugin-name> ...)
      Adaptive plugin dispatch. Non-builtin first tokens resolve via the
      marketplace globs to an installed package's ./opendweb-plugin export.
      Plugins declaring exactly one command accept its flags directly
      (opendweb webui --server X equals opendweb webui webui --server X).
      Missing plugins are fetched automatically on first use (get ?? add;
      first candidate wins, so official scoped packages are preferred);
      set DWEB_NO_AUTO_INSTALL=1 to require explicit installation.

Environment:
  DWEB_GATEWAY_BIND         gateway listen address
  DWEB_RELAY_HTTP_BIND      relay listen address
  DWEB_RELAY_ENABLED        set to false/0/off to disable the relay
  DWEB_TRUST_PROXY          set to 1 to trust X-Forwarded-Proto behind a reverse proxy
  DWEB_PUBLIC_GATEWAY_URL   public gateway URL override (see --public-gateway)
  DWEB_PUBLIC_RELAY_URL     public relay URL override (see --public-relay)
  DWEB_ACCESS_MODE          access mode: open (default) | restricted
  DWEB_OWNERS_FILE          owner registry file (default <data-dir>/owners.jsonl)
  DWEB_DATA_DIR             data directory for server.key/owners.jsonl (default dweb-data)
  DWEB_ACCESS_POLICY        L2 policy: static (default) | callback (needs
                            DWEB_CALLBACK_URL + DWEB_CALLBACK_TOKEN)
  DWEB_HOME                 CLI state directory (default ~/.opendweb):
                            marketplace.json, plugins.json, the device
                            identity.key and registration.json; hub state
                            after "hub init" (hub.json, hub-token, hub.pid)

Clients need a single config entry: pick any Network address from the startup
banner (e.g. http://192.168.2.13:8787). The gateway exposes the
machine-readable service manifest at GET /services.json.

Example flow (with @jixo/opendweb-example, in another terminal):
  opendweb-example init --data ~/.dweb-a && opendweb-example chat --data ~/.dweb-a
  opendweb-example join --data ~/.dweb-b <invite-token>
  opendweb-example chat --data ~/.dweb-b

Server deployment: docker image ghcr.io/gaubee/dweb`;

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .then((code) => {
      // 命令返回非零退出码时显式退出（resolve 自然退出恒为 0）
      if (typeof code === "number" && code > 0) process.exit(code);
    })
    .catch((e) => {
      console.error(`error: ${asciiEscape(e.message)}`);
      process.exit(e.exitCode ?? 1);
    });
}
