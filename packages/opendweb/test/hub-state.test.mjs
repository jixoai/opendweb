// 中枢状态模型测试（home-hub 1a/1b/1c/1e 单元层，specs/cli/hub）：
// hub.json/hub-token 纪律（0600/原子/最后写零残留）、init 各步故障注入、
// 接管协议三态、自检三态、hub.lock 陈锁规则、pid 三元组复用防护、自启
// 生成物快照（真实绝对路径/三变体/安装失败不假成功）、卡片无凭证、
// 默认不启动负向探针、hub open 未 init/未运行分支。
// 真实 server 二进制的链级 e2e 见 hub-process.test.mjs（admin 能力门控）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  HUB_BIN_PATH,
  acquireHubLock,
  buildLaunchAgentPlist,
  buildWindowsStartupCmd,
  digestCommand,
  hubTokenFile,
  hubPidFile,
  hubStateFile,
  hubStatus,
  launchAgentPlistPath,
  readHubPidTriple,
  runHub,
  verifyPidTriple,
} from "../src/hub.mjs";

const execFileAsync = promisify(execFile);
const NODE = process.execPath;

/** @returns {Promise<{home: string, cleanup: () => Promise<void>}>} */
async function tmpHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hub-state-"));
  return { home: dir, cleanup: async () => fsp.rm(dir, { recursive: true, force: true }) };
}

/**
 * @param {Partial<import("../src/hub.mjs").HubCtx>} [overrides]
 * @returns {import("../src/hub.mjs").HubCtx} 全注入 ctx（确认恒 true，可覆盖）
 */
function unitCtx(overrides = {}) {
  /** @type {string[]} */
  const lines = [];
  const home = /** @type {{home?: string}} */ (overrides).home;
  return {
    cwd: home ?? "/nonexistent-cwd",
    confirm: async () => true,
    stdout: (l) => lines.push(l),
    hostname: "Mac-mini-书房",
    interfaces: {
      en0: [
        { family: "IPv4", address: "192.168.2.13", internal: false, mac: "", cidr: "", netmask: "" },
        { family: "IPv6", address: "fd00::13", internal: false, mac: "", cidr: "", netmask: "", scopeid: 5 },
        { family: "IPv6", address: "fe80::1", internal: false, mac: "", cidr: "", netmask: "", scopeid: 5 },
      ],
    },
    isTTY: false,
    ...overrides,
    // @ts-expect-error 测试注入面聚合（home/lines 由调用方读取）
    __lines: lines,
  };
}

/**
 * @param {string} home
 * @param {string[]} argv
 * @param {Partial<import("../src/hub.mjs").HubCtx>} [overrides]
 */
async function runInit(home, argv, overrides = {}) {
  const ctx = unitCtx({ home, cwd: overrides.cwd ?? home, ...overrides });
  const lines = /** @type {any} */ (ctx).__lines;
  try {
    const code = await runHub(["init", ...argv], ctx);
    return { code, lines };
  } catch (e) {
    return { code: /** @type {{exitCode?: number}} */ (e).exitCode ?? 1, lines, error: /** @type {Error} */ (e) };
  }
}

/** 随机空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 占住端口的假服务（可选 /healthz 应答；host 与被测 bind 同址制造真实冲突） */
async function occupyPort(port, healthz = false, host = "127.0.0.1") {
  const srv = http.createServer((req, res) => {
    if (healthz && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => srv.listen(port, host, resolve));
  return () => new Promise((resolve) => srv.close(() => resolve(null)));
}

/** 同 execPath 的无关 node 脚本（pid 复用测试的占位进程） */
function spawnSleeper(ms = 30000) {
  const child = spawn(NODE, ["-e", `setTimeout(()=>{}, ${ms})`], { stdio: "ignore" });
  return child;
}

/** 守护命令行（detached 三元组的 argv_digest 输入形态） */
const DAEMON_COMMAND_SAMPLE = `${NODE} ${HUB_BIN_PATH} hub start --foreground`;

// ---- init：一键变中枢 + 状态模型纪律 ----------------------------------------------

test("init: happy path writes hub.json last with frozen fields; token 0600; card printed from the same source", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    const { code, lines } = await runInit(home, ["--yes"]);
    assert.equal(code, 0);
    const out = lines.join("\n");
    // 流程文案（PM §4.2）
    assert.match(out, /管理凭证已保存到本机/);
    assert.match(out, /自检通过：家里人应该能连上 http:\/\/192\.168\.2\.13:8787。/);
    assert.match(out, /接入卡片 · 家里人怎么连/);
    assert.match(out, /中枢：Mac-mini-书房/);
    assert.match(out, /家里人的三步/);
    // hub.json 字段（状态模型冻结）
    const state = JSON.parse(await fsp.readFile(hubStateFile(home), "utf8"));
    assert.equal(state.version, 1);
    assert.equal(state.data_dir, path.join(home, "hub-data"));
    assert.equal(state.gateway_bind, "0.0.0.0:8787");
    assert.equal(state.relay_bind, "0.0.0.0:3340");
    assert.equal(state.autostart, false);
    assert.equal(typeof state.initialized_at, "string");
    assert.equal(state.config_path, undefined);
    // token 纪律
    const tokenStat = await fsp.stat(hubTokenFile(home));
    assert.equal(tokenStat.mode & 0o777, 0o600);
    const token = (await fsp.readFile(hubTokenFile(home), "utf8")).trim();
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), "32B base64url (43 chars, no padding)");
    // token 不出现在任何输出
    assert.ok(!out.includes(token));
    // hub.pid 不由 init 产生
    assert.equal(fs.existsSync(hubPidFile(home)), false);
    // init 尾部卡片与 hub card 同源
    const cardCtx = unitCtx({ home });
    await runHub(["card"], cardCtx);
    const cardOut = /** @type {any} */ (cardCtx).__lines.join("\n");
    const cardBlock = out.slice(out.indexOf("── 接入卡片"));
    assert.equal(cardBlock, cardOut);
  } finally {
    await cleanup();
  }
});

test("init: custom ports/data-dir/public urls are validated and frozen", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    const bad = await runInit(home, ["--gateway", "not-a-bind"]);
    assert.notEqual(bad.code, 0);
    const bad2 = await runInit(home, ["--public-gateway", "ftp://x"]);
    assert.notEqual(bad2.code, 0);
    const { code } = await runInit(home, [
      "--yes",
      "--gateway",
      "0.0.0.0:18787",
      "--relay",
      "0.0.0.0:13340",
      "--data-dir",
      "./my-data",
      "--public-gateway",
      "https://example.com",
    ]);
    assert.equal(code, 0);
    const state = JSON.parse(await fsp.readFile(hubStateFile(home), "utf8"));
    assert.equal(state.gateway_bind, "0.0.0.0:18787");
    assert.equal(state.relay_bind, "0.0.0.0:13340");
    assert.equal(state.data_dir, path.join(home, "my-data"));
    assert.equal(state.public_gateway_url, "https://example.com");
  } finally {
    await cleanup();
  }
});

test("init: second init is refused with guidance (one hub identity per machine)", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    assert.equal((await runInit(home, ["--yes"])).code, 0);
    const again = await runInit(home, ["--yes"]);
    assert.equal(again.code, 0);
    assert.match(again.lines.join("\n"), /这台机器已经是中枢了/);
  } finally {
    await cleanup();
  }
});

// ---- init 零残留（故障注入式） ----------------------------------------------------

test("init failure (port occupied) leaves zero residue; retry succeeds", async () => {
  const { home, cleanup } = await tmpHome();
  const port = await freePort();
  const stop = await occupyPort(port, false);
  try {
    // 网关端口被占：自检失败 → 非零退出 → 无 hub.json/hub-token/hub.pid
    const failed = await runInit(home, ["--yes", "--gateway", `127.0.0.1:${port}`]);
    assert.notEqual(failed.code, 0);
    const out = failed.lines.join("\n");
    assert.match(out, new RegExp(`端口 ${port} 已被其他程序占用。`));
    assert.match(out, /换端口重来：opendweb hub init --gateway \d+；或先停掉占用它的程序。/);
    assert.equal(fs.existsSync(hubStateFile(home)), false);
    assert.equal(fs.existsSync(hubTokenFile(home)), false);
    assert.equal(fs.existsSync(hubPidFile(home)), false);
    // 故障解除后重试成功：状态齐备且 0600
    await stop();
    const ok = await runInit(home, ["--yes", "--gateway", `127.0.0.1:${port}`]);
    assert.equal(ok.code, 0);
    assert.equal((await fsp.stat(hubStateFile(home))).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(hubTokenFile(home))).mode & 0o777, 0o600);
  } finally {
    await stop();
    await cleanup();
  }
});

test("init: relay port occupied also aborts with zero residue", async () => {
  const { home, cleanup } = await tmpHome();
  const port = await freePort();
  const stop = await occupyPort(port, false);
  try {
    const failed = await runInit(home, ["--yes", "--relay", `127.0.0.1:${port}`]);
    assert.notEqual(failed.code, 0);
    assert.equal(fs.existsSync(hubStateFile(home)), false);
    assert.equal(fs.existsSync(hubTokenFile(home)), false);
  } finally {
    await stop();
    await cleanup();
  }
});

test("init: firewall detection failure is a non-blocking warning path; enabled state prints guidance", async () => {
  const { home: homeA, cleanup: cleanupA } = await tmpHome();
  const { home: homeB, cleanup: cleanupB } = await tmpHome();
  try {
    // 检测失败（命令不可用/非零）→ 不阻塞、不崩溃
    const unknown = await runInit(homeA, ["--yes"], {
      run: async () => ({ code: 1, stdout: "", stderr: "no such file" }),
    });
    assert.equal(unknown.code, 0);
    // enabled → PM 3b 警告文案（不阻塞）
    const enabled = await runInit(homeB, ["--yes"], {
      run: async () => ({ code: 0, stdout: "Firewall is enabled. (Block all incoming connections)" , stderr: "" }),
    });
    assert.equal(enabled.code, 0);
    const out = enabled.lines.join("\n");
    assert.match(out, /自检发现：防火墙可能挡住了端口 8787，家里人可能连不上。/);
    assert.match(out, /去系统设置的防火墙里放行 opendweb/);
  } finally {
    await cleanupA();
    await cleanupB();
  }
});

// ---- 接管协议 --------------------------------------------------------------------

test("takeover: provably running old service is refused (never auto-killed), zero residue", async () => {
  const { home, cleanup } = await tmpHome();
  const port = await freePort();
  // 占住某个探测端口（默认端口集内的非常用位）并应答 /healthz
  const stop = await occupyPort(9878, true);
  try {
    const dataDir = path.join(home, "old-data");
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(path.join(dataDir, "server.key"), "k");
    const res = await runInit(home, ["--yes", "--data-dir", dataDir]);
    assert.equal(res.code, 1);
    const out = res.lines.join("\n");
    assert.match(out, /检测到旧服务仍在运行/);
    assert.match(out, /opendweb 不会自动终止它/);
    assert.equal(fs.existsSync(hubStateFile(home)), false);
    assert.equal(fs.existsSync(hubTokenFile(home)), false);
  } finally {
    await stop();
    await cleanup();
  }
});

test("takeover: unprovable old service forces manual confirmation (decline = abort, zero residue)", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    const dataDir = path.join(home, "old-data");
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(path.join(dataDir, "server.key"), "k");
    /** @type {string[]} */
    const prompts = [];
    const declined = await runInit(home, ["--data-dir", dataDir], {
      confirm: async (text) => {
        prompts.push(text);
        return false;
      },
    });
    assert.equal(declined.code, 1);
    assert.match(declined.lines.join("\n"), /已取消，未做任何更改。/);
    assert.equal(fs.existsSync(hubStateFile(home)), false);
    assert.equal(fs.existsSync(hubTokenFile(home)), false);
    // 强制确认文案：明示无法自动验证自定义端口旧服务 + 残余风险
    const takeoverPrompt = prompts.find((p) => p.includes("无法自动验证使用自定义端口的旧服务"));
    assert.ok(takeoverPrompt !== undefined, "forced-confirm text must mention the custom-port boundary");
    assert.match(takeoverPrompt, /残余风险由本确认兜底/);
  } finally {
    await cleanup();
  }
});

test("takeover: confirmed takeover of a stopped service preserves data in place (single data dir rule)", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    const dataDir = path.join(home, "old-data");
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(path.join(dataDir, "server.key"), "k");
    await fsp.writeFile(path.join(dataDir, "owners.jsonl"), '{"fabric_id":"f"}\n');
    const res = await runInit(home, ["--yes", "--data-dir", dataDir]);
    assert.equal(res.code, 0);
    const state = JSON.parse(await fsp.readFile(hubStateFile(home), "utf8"));
    assert.equal(state.data_dir, dataDir);
    assert.equal(await fsp.readFile(path.join(dataDir, "server.key"), "utf8"), "k");
    assert.equal(await fsp.readFile(path.join(dataDir, "owners.jsonl"), "utf8"), '{"fabric_id":"f"}\n');
    // 不产生第二套数据目录
    assert.equal(fs.existsSync(path.join(home, "hub-data")), false);
    assert.match(res.lines.join("\n"), /已接管/);
  } finally {
    await cleanup();
  }
});

test("takeover: cwd dweb-data is adopted as data_dir (read-only takeover)", async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "hub-cwd-"));
  const { home, cleanup } = await tmpHome();
  try {
    await fsp.mkdir(path.join(cwd, "dweb-data"), { recursive: true });
    await fsp.writeFile(path.join(cwd, "dweb-data", "owners.jsonl"), "{}\n");
    const res = await runInit(home, ["--yes"], { cwd });
    assert.equal(res.code, 0);
    const state = JSON.parse(await fsp.readFile(hubStateFile(home), "utf8"));
    assert.equal(state.data_dir, path.join(cwd, "dweb-data"));
    assert.match(res.lines.join("\n"), /已接管家里的这台服务器/);
    assert.equal(state.config_path, undefined);
  } finally {
    await cleanup();
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test("init: config file in cwd is frozen as absolute config_path", async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "hub-cfg-"));
  const { home, cleanup } = await tmpHome();
  try {
    await fsp.writeFile(path.join(cwd, "opendweb.config.toml"), "[server]\n");
    const res = await runInit(home, ["--yes"], { cwd });
    assert.equal(res.code, 0);
    const state = JSON.parse(await fsp.readFile(hubStateFile(home), "utf8"));
    assert.equal(state.config_path, path.join(cwd, "opendweb.config.toml"));
  } finally {
    await cleanup();
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

// ---- hub.lock 陈锁规则 ------------------------------------------------------------

test("hub.lock: second acquirer fails with holder pid; stale lock (age>10s + dead pid) is broken; fresh/dead and live are not", async () => {
  const { home, cleanup } = await tmpHome();
  /** acquireHubLock 直接消费已解析 ctx 的 {now, isPidAlive} */
  const lockCtx = { now: Date.now, isPidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } } };
  try {
    const dataDir = path.join(home, "hub-data");
    const first = await acquireHubLock(dataDir, /** @type {any} */ (lockCtx));
    assert.equal(first.ok, true);
    const second = await acquireHubLock(dataDir, /** @type {any} */ (lockCtx));
    assert.equal(second.ok, false);
    assert.equal(second.holderPid, process.pid);
    await first.release();

    // 陈锁：>10s 且 pid 死 → 打破
    const sleeper = spawnSleeper(1000);
    await new Promise((resolve) => sleeper.once("exit", resolve));
    await fsp.mkdir(path.join(dataDir, "hub.lock"), { recursive: true });
    await fsp.writeFile(
      path.join(dataDir, "hub.lock", "info.json"),
      `${JSON.stringify({ pid: sleeper.pid, ts: Date.now() - 11000 })}\n`,
    );
    const brokeStale = await acquireHubLock(dataDir, /** @type {any} */ (lockCtx));
    assert.equal(brokeStale.ok, true, "stale lock must be breakable");
    await brokeStale.release();

    // 新锁 + 死 pid → 不可打破（占用错误）
    await fsp.mkdir(path.join(dataDir, "hub.lock"), { recursive: true });
    await fsp.writeFile(
      path.join(dataDir, "hub.lock", "info.json"),
      `${JSON.stringify({ pid: sleeper.pid, ts: Date.now() })}\n`,
    );
    const freshDead = await acquireHubLock(dataDir, /** @type {any} */ (lockCtx));
    assert.equal(freshDead.ok, false);

    // 活 pid → 占用
    const alive = spawnSleeper();
    try {
      await fsp.writeFile(
        path.join(dataDir, "hub.lock", "info.json"),
        `${JSON.stringify({ pid: alive.pid, ts: Date.now() })}\n`,
      );
      const liveHeld = await acquireHubLock(dataDir, /** @type {any} */ (lockCtx));
      assert.equal(liveHeld.ok, false);
      assert.equal(liveHeld.holderPid, alive.pid);
    } finally {
      alive.kill("SIGKILL");
      await new Promise((resolve) => alive.once("exit", resolve));
    }
  } finally {
    await cleanup();
  }
});

// ---- pid 三元组复用防护 --------------------------------------------------------------

test("pid reuse (same execPath, unrelated script): stop sends no signal, cleans orphan pid file, reports not running", async () => {
  const { home, cleanup } = await tmpHome();
  const sleeper = spawnSleeper();
  try {
    await runInit(home, ["--yes"]);
    const identity = await readRealIdentity(sleeper.pid);
    assert.notEqual(identity, null);
    // 场景 A：启动时刻真实、命令摘要=守护形态（无关脚本复用 pid）
    await fsp.writeFile(
      hubPidFile(home),
      `${JSON.stringify({ pid: sleeper.pid, start_identity: identity.lstart, argv_digest: digestCommand(DAEMON_COMMAND_SAMPLE) })}\n`,
    );
    const stopA = await runHubCmd(home, ["stop", "--yes"]);
    assert.equal(stopA.code, 0);
    assert.match(stopA.lines.join("\n"), /中枢未在运行。/);
    assert.equal(fs.existsSync(hubPidFile(home)), false, "orphan pid file cleaned");
    // 未发信号：占位进程仍然存活
    assert.equal(await isAlive(sleeper.pid), true);

    // 场景 B：命令摘要真实、启动时刻伪造（旧守护的 pid 被复用）
    await fsp.writeFile(
      hubPidFile(home),
      `${JSON.stringify({ pid: sleeper.pid, start_identity: "Thu Jan  1 00:00:00 1970", argv_digest: digestCommand(identity.command) })}\n`,
    );
    const stopB = await runHubCmd(home, ["stop", "--yes"]);
    assert.equal(stopB.code, 0);
    assert.match(stopB.lines.join("\n"), /中枢未在运行。/);
    assert.equal(await isAlive(sleeper.pid), true);

    // verifyPidTriple 的判定直查
    const ctx = unitCtx({ home });
    const v = await verifyPidTriple(home, /** @type {any} */ (ctx));
    assert.ok(v === null || v.status === "absent");
  } finally {
    sleeper.kill("SIGKILL");
    await new Promise((resolve) => sleeper.once("exit", resolve));
    await cleanup();
  }
});

/**
 * @param {number} pid
 * @returns {Promise<{ lstart: string, command: string } | null>}
 */
async function readRealIdentity(pid) {
  try {
    const lstart = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const command = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
    return { lstart: lstart.stdout.trim(), command: command.stdout.trim() };
  } catch {
    return null;
  }
}

/**
 * @param {number} pid
 */
async function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * @param {string} home
 * @param {string[]} argv
 * @param {Partial<import("../src/hub.mjs").HubCtx>} [overrides]
 */
async function runHubCmd(home, argv, overrides = {}) {
  const ctx = unitCtx({ home, ...overrides });
  const lines = /** @type {any} */ (ctx).__lines;
  try {
    const code = await runHub(argv, ctx);
    return { code, lines };
  } catch (e) {
    return { code: /** @type {{exitCode?: number}} */ (e).exitCode ?? 1, lines, error: /** @type {Error} */ (e) };
  }
}

// ---- 自启生成物与联动 --------------------------------------------------------------

test("autostart artifact: macOS plist snapshot with real absolute paths; no DWEB_DATA_DIR, no token", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    await runInit(home, ["--yes"]);
    const ctx = unitCtx({ home });
    await runHub(["autostart", "on", "--print"], ctx);
    const printed = /** @type {any} */ (ctx).__lines.join("\n");
    // 真实绝对路径断言（init 冻结元组同源）
    assert.ok(printed.includes(process.execPath), "real execPath");
    assert.ok(printed.includes(HUB_BIN_PATH), "real bin path");
    assert.ok(printed.includes(home), "real DWEB_HOME");
    assert.match(printed, /<key>Label<\/key>\s*<string>com\.opendweb\.hub<\/string>/);
    assert.match(printed, /<key>RunAtLoad<\/key>/);
    assert.match(printed, /<key>KeepAlive<\/key>/);
    assert.match(printed, /<key>WorkingDirectory<\/key>/);
    // EnvironmentVariables 恰好 {DWEB_HOME, DWEB_HUB_SERVICE}——DATA_DIR/token 不落 plist
    assert.ok(!printed.includes("DWEB_DATA_DIR"));
    assert.ok(!printed.includes("DWEB_ADMIN_TOKEN"));
    const token = (await fsp.readFile(hubTokenFile(home), "utf8")).trim();
    assert.ok(!printed.includes(token));
    // --print 零副作用
    assert.equal(fs.existsSync(launchAgentPlistPath()), false, "real LaunchAgents dir untouched");
    const state = JSON.parse(await fsp.readFile(hubStateFile(home), "utf8"));
    assert.equal(state.autostart, false);
  } finally {
    await cleanup();
  }
});

test("autostart artifact: Windows .cmd snapshots (plain / spaces / non-ASCII + % escaping, containment)", async () => {
  const plain = buildWindowsStartupCmd({
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    binPath: "C:\\Users\\kzf\\opendweb\\bin\\opendweb.mjs",
    home: "C:\\Users\\kzf\\.opendweb",
  });
  assert.match(plain, /cd \/d "C:\\Users\\kzf\\\.opendweb"/);
  assert.match(plain, /"C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\kzf\\opendweb\\bin\\opendweb\.mjs" hub start --foreground/);
  assert.ok(!plain.includes("DWEB_DATA_DIR"));

  const spaced = buildWindowsStartupCmd({
    execPath: "C:\\Program Files (x86)\\nodejs\\node.exe",
    binPath: "D:\\my tools\\opendweb\\bin\\opendweb.mjs",
    home: "D:\\home dir with spaces\\.opendweb",
  });
  assert.ok(spaced.includes('cd /d "D:\\home dir with spaces\\.opendweb"'));
  assert.ok(spaced.includes('"C:\\Program Files (x86)\\nodejs\\node.exe" "D:\\my tools\\opendweb\\bin\\opendweb.mjs"'));

  // 非 ASCII 用户目录 + % 双写
  const unicode = buildWindowsStartupCmd({
    execPath: "C:\\node\\node.exe",
    binPath: "C:\\仓库\\opendweb\\bin\\opendweb.mjs",
    home: "C:\\Users\\用户 100%\\\.opendweb",
  });
  assert.ok(unicode.includes('cd /d "C:\\Users\\用户 100%%\\.opendweb"'), "%% doubling for cmd");
  assert.ok(unicode.includes('"C:\\仓库\\opendweb\\bin\\opendweb.mjs"'));

  // 包含性检查：含引号的路径被拒绝（无法安全转义）
  assert.throws(() =>
    buildWindowsStartupCmd({
      execPath: "C:\\node\\node.exe",
      binPath: "C:\\x\\bin\\opendweb.mjs",
      home: "C:\\bad\"quote\\.opendweb",
    }),
  );
});

test("autostart on: install failure (plist unwritable) exits non-zero and hub.json.autostart stays false", async () => {
  const { home, cleanup } = await tmpHome();
  const roDir = path.join(home, "ro-launchagents");
  await fsp.mkdir(roDir, { recursive: true });
  try {
    await runInit(home, ["--yes"]);
    await fsp.chmod(roDir, 0o555);
    const res = await runHubCmd(home, ["autostart", "on"], {
      servicePaths: { plist: path.join(roDir, "com.opendweb.hub.plist") },
    });
    if (process.platform !== "darwin") {
      assert.notEqual(res.code, 0);
    } else {
      assert.notEqual(res.code, 0, "install must fail loudly");
      const state = JSON.parse(await fsp.readFile(hubStateFile(home), "utf8"));
      assert.equal(state.autostart, false, "hub.json not updated on install failure");
      assert.equal(fs.existsSync(path.join(roDir, "com.opendweb.hub.plist")), false);
    }
  } finally {
    await fsp.chmod(roDir, 0o755).catch(() => {});
    await cleanup();
  }
});

test("autostart on/off lifecycle with injected launchctl: file + state updates, correct command sequence", async () => {
  const { home, cleanup } = await tmpHome();
  const plistTarget = path.join(home, "LaunchAgents", "com.opendweb.hub.plist");
  /** @type {string[][]} */
  const calls = [];
  try {
    await runInit(home, ["--yes"]);
    const on = await runHubCmd(home, ["autostart", "on"], {
      servicePaths: { plist: plistTarget },
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(on.code, 0);
    assert.match(on.lines.join("\n"), /已开启。/);
    assert.equal(fs.existsSync(plistTarget), true);
    assert.equal(JSON.parse(await fsp.readFile(hubStateFile(home), "utf8")).autostart, true);
    assert.deepEqual(calls[0]?.slice(0, 2), ["launchctl", "bootstrap"]);
    assert.match(calls[0]?.[2] ?? "", /^gui\/\d+$/);

    const off = await runHubCmd(home, ["autostart", "off"], {
      servicePaths: { plist: plistTarget },
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(off.code, 0);
    assert.equal(fs.existsSync(plistTarget), false);
    assert.equal(JSON.parse(await fsp.readFile(hubStateFile(home), "utf8")).autostart, false);
    assert.deepEqual(calls[1]?.slice(0, 2), ["launchctl", "bootout"]);
  } finally {
    await cleanup();
  }
});

test("autostart off with hard uninstall failure leaves hub.json untouched", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    await runInit(home, ["--yes"]);
    // 直接造 autostart=true 的状态
    const state = JSON.parse(await fsp.readFile(hubStateFile(home), "utf8"));
    await fsp.writeFile(hubStateFile(home), JSON.stringify({ ...state, autostart: true }, null, 2));
    const res = await runHubCmd(home, ["autostart", "off"], {
      run: async () => ({ code: 1, stdout: "", stderr: "launchctl hard failure" }),
    });
    assert.notEqual(res.code, 0);
    assert.equal(JSON.parse(await fsp.readFile(hubStateFile(home), "utf8")).autostart, true, "not updated on uninstall failure");
  } finally {
    await cleanup();
  }
});

test("hub start with autostart on loads the service instead of spawning a detached daemon (no pid file)", async () => {
  const { home, cleanup } = await tmpHome();
  const plistTarget = path.join(home, "LaunchAgents", "com.opendweb.hub.plist");
  /** @type {string[][]} */
  const calls = [];
  try {
    await runInit(home, ["--yes"]);
    // 打开自启（注入 launchctl，成功路径）
    const on = await runHubCmd(home, ["autostart", "on"], {
      servicePaths: { plist: plistTarget },
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(on.code, 0);
    assert.equal(JSON.parse(await fsp.readFile(hubStateFile(home), "utf8")).autostart, true);
    const callsBefore = calls.length;
    // hub start：转交系统服务——不另起 detached、不写 pid
    const start = await runHubCmd(home, ["start"], {
      servicePaths: { plist: plistTarget },
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      spawnImpl: () => {
        throw new Error("detached spawn must not happen when autostart is on");
      },
    });
    assert.equal(start.code, 0);
    assert.match(start.lines.join("\n"), /中枢已启动（由系统服务托管/);
    assert.equal(calls.length, callsBefore + 1, "exactly one service load on start");
    assert.deepEqual(calls.at(-1)?.slice(0, 2), ["launchctl", "bootstrap"]);
    assert.equal(fs.existsSync(hubPidFile(home)), false, "service mode never writes hub.pid");
  } finally {
    await cleanup();
  }
});

test("hub stop with autostart on unloads the service first, then stops residuals; uninstall failure still stops and exits non-zero", async () => {
  const { home, cleanup } = await tmpHome();
  const plistTarget = path.join(home, "LaunchAgents", "com.opendweb.hub.plist");
  /** @type {string[][]} */
  const calls = [];
  try {
    await runInit(home, ["--yes"]);
    const on = await runHubCmd(home, ["autostart", "on"], {
      servicePaths: { plist: plistTarget },
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(on.code, 0);
    // stop（卸载成功）：先 bootout；无 pid/锁/网关 → 中枢未在运行
    const stop = await runHubCmd(home, ["stop", "--yes"], {
      servicePaths: { plist: plistTarget },
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      fetchImpl: (async () => {
        throw new Error("network unreachable");
      }) /** @type {any} */,
    });
    assert.equal(stop.code, 0);
    assert.match(stop.lines.join("\n"), /中枢未在运行。/);
    assert.deepEqual(calls.at(-1)?.slice(0, 2), ["launchctl", "bootout"], "service unloaded before residual stop");
    assert.equal(JSON.parse(await fsp.readFile(hubStateFile(home), "utf8")).autostart, false);
    assert.equal(fs.existsSync(plistTarget), false);
  } finally {
    await cleanup();
  }
});

// ---- 卡片无凭证 / hub open 分支 ------------------------------------------------------

test("hub card: address/short code/QR/guide present; no credentials", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    await runInit(home, ["--yes"]);
    const ctx = unitCtx({ home });
    await runHub(["card"], ctx);
    const out = /** @type {any} */ (ctx).__lines.join("\n");
    assert.match(out, /地址：http:\/\/192\.168\.2\.13:8787/);
    assert.match(out, /短码：dwebh1\.[0-9a-z-]+ （电话里念给对方，等于上面的地址）/);
    assert.match(out, /二维码：/);
    assert.match(out, /██/);
    assert.match(out, /家里人的三步/);
    const token = (await fsp.readFile(hubTokenFile(home), "utf8")).trim();
    assert.ok(!out.includes(token), "no admin token on the card");
    assert.ok(!/dwebc1\.|邀请码[:：]/.test(out.replace(/要自己的房间，就找家长拿邀请码注册成租户/, "")), "no invite codes");
    // 回执材料（registration 字段族）不出现在卡片
    assert.ok(!out.includes("receipt"));
    // IPv6 备选呈现：ULA 在列、link-local 不入卡
    assert.match(out, /http:\/\/\[fd00::13\]:8787/);
    assert.ok(!out.includes("fe80"));
    // 短码可离线解码回地址
    const code = /短码：(dwebh1\.[0-9a-z-]+)/.exec(out)?.[1] ?? "";
    const { decodeShortCode } = await import("../src/util.mjs");
    assert.equal(decodeShortCode(code).url, "http://192.168.2.13:8787");
  } finally {
    await cleanup();
  }
});

test("hub card: empty interfaces fall back to loopback", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    await runInit(home, ["--yes"]);
    const ctx = unitCtx({ home, interfaces: {} });
    await runHub(["card"], ctx);
    const out = /** @type {any} */ (ctx).__lines.join("\n");
    assert.match(out, /地址：http:\/\/127\.0\.0\.1:8787/);
  } finally {
    await cleanup();
  }
});

test("hub open: uninitialized -> guidance (exit 2); stopped hub -> status card (exit 1)", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    const uninit = await runHubCmd(home, ["open"]);
    assert.equal(uninit.code, 2);
    assert.match(uninit.lines.join("\n"), /中枢未初始化/);
    await runInit(home, ["--yes"]);
    const stopped = await runHubCmd(home, ["open"]);
    assert.equal(stopped.code, 1);
    const out = stopped.lines.join("\n");
    assert.match(out, /中枢没有在运行。/);
    assert.match(out, /启动中枢：opendweb hub start/);
  } finally {
    await cleanup();
  }
});

test("hub open: running hub spawns webui sidecar with token via env only (never argv/URL)", async () => {
  const { home, cleanup } = await tmpHome();
  // 假 webui CLI：打印监听行后驻留 1.2s 退出
  const fakeWebui = path.join(home, "fake-webui.mjs");
  await fsp.writeFile(
    fakeWebui,
    [
      "import net from 'node:net';",
      "const srv = net.createServer();",
      "srv.listen(0, '127.0.0.1', () => {",
      "  console.log(`opendweb-webui listening on http://127.0.0.1:${srv.address().port}`);",
      "  setTimeout(() => process.exit(0), 1200);",
      "});",
    ].join("\n"),
  );
  try {
    await runInit(home, ["--yes"]);
    /** @type {any} */
    let captured;
    /** @type {string[]} */
    const opened = [];
    const res = await runHubCmd(home, ["open", "#/knock"], {
      fetchImpl: (async (url) => ({ ok: true, status: 200, json: async () => ({}) })) /** @type {any */,
      webuiCliPath: fakeWebui,
      spawnImpl: (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
        captured = { cmd, args, env: opts.env };
        return spawn(cmd, args, opts);
      },
      openBrowser: (url) => opened.push(url),
    });
    assert.equal(res.code, 0);
    const token = (await fsp.readFile(hubTokenFile(home), "utf8")).trim();
    assert.ok(!captured.args.includes(token), "token never in argv");
    assert.ok(!captured.args.some((a) => String(a).includes(token)), "token never in any argv element");
    assert.equal(captured.env.DWEB_ADMIN_TOKEN, token, "token injected via env");
    assert.equal(captured.env.DWEB_HOME, home);
    assert.match(captured.args.join(" "), /--server http:\/\/127\.0\.0\.1:8787/);
    // 浏览器 URL：sidecar origin + 深链，且不含 token
    assert.equal(opened.length, 1);
    assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/#\/knock$/);
    assert.ok(!opened[0].includes(token));
  } finally {
    await cleanup();
  }
});

// ---- 默认不启动（[H3] 负向探针） + 派发面 --------------------------------------------

test("default-not-started: fresh DWEB_HOME survives normal commands, webui attempt and join without any hub side effects", async () => {
  const { home, cleanup } = await tmpHome();
  const before = await fsp.readdir(home).catch(() => []);
  try {
    const env = { ...process.env, DWEB_HOME: home, DWEB_NO_AUTO_INSTALL: "1" };
    // 普通命令族
    for (const argv of [["id"], ["marketplace", "list"], ["plugin", "list"], ["hub", "status"]]) {
      await execFileAsync(NODE, [HUB_BIN_PATH, ...argv], { env }).catch(() => {});
    }
    // 无 hub.json 的 webui（插件解析失败即可——重点是零副作用）
    await execFileAsync(NODE, [HUB_BIN_PATH, "webui"], { env }).catch(() => {});
    // 模拟成员会话：join 指向不可达地址（失败，无本地状态）
    await execFileAsync(NODE, [HUB_BIN_PATH, "join", "--server", "http://127.0.0.1:9", "--code", "dwebc1.x", "--allow-insecure"], { env }).catch(() => {});
    // 断言：无 hub 状态文件、无 hub-data、无服务安装、无 server 子进程（端口可 bind）
    assert.equal(fs.existsSync(hubStateFile(home)), false);
    assert.equal(fs.existsSync(hubTokenFile(home)), false);
    assert.equal(fs.existsSync(hubPidFile(home)), false);
    assert.equal(fs.existsSync(path.join(home, "hub-data")), false);
    assert.equal(fs.existsSync(launchAgentPlistPath()), false);
    const bindable = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(8787, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    assert.equal(bindable, true, "frozen gateway port must be free (no hidden server)");
    // join 等普通命令的既有产物不算 hub 副作用（registration 等），但不应出现 hub 文件
    const after = await fsp.readdir(home);
    assert.ok(after.every((f) => !f.startsWith("hub")), `unexpected hub files: ${after.join(",")}`);
    assert.ok(before.length === 0 || true);
  } finally {
    await cleanup();
  }
});

test("hub is builtin: dispatched before adaptive plugin resolution; unknown subcommand usage error", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    // hub status 在全新 home 上输出未初始化指引——证明走的是内置命令族而非
    // marketplace 插件解析（后者会报 PluginNotResolved）
    const { stdout } = await execFileAsync(NODE, [HUB_BIN_PATH, "hub", "status"], {
      env: { ...process.env, DWEB_HOME: home, DWEB_NO_AUTO_INSTALL: "1" },
    });
    assert.match(stdout, /中枢未初始化/);
    const bad = await execFileAsync(NODE, [HUB_BIN_PATH, "hub", "bogus"], {
      env: { ...process.env, DWEB_HOME: home },
    }).catch((e) => e);
    assert.notEqual(bad.code, 0);
    assert.match(String(bad.stderr), /usage: opendweb hub/);
  } finally {
    await cleanup();
  }
});

test("platform guard: non-committed platform errors out with zero side effects", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    const ctx = unitCtx({ home, platform: /** @type {any} */ ("linux") });
    await assert.rejects(
      runHub(["status"], ctx),
      (e) => e instanceof Error && /not supported on linux/.test(e.message),
    );
    assert.equal(fs.existsSync(hubStateFile(home)), false);
    assert.equal((await fsp.readdir(home)).length, 0);
  } finally {
    await cleanup();
  }
});

test("status: uninitialized prints guidance with exit 0; initialized-not-running shows state", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    const uninit = await runHubCmd(home, ["status"]);
    assert.equal(uninit.code, 0);
    assert.match(uninit.lines.join("\n"), /中枢未初始化/);
    await runInit(home, ["--yes"]);
    const stopped = await runHubCmd(home, ["status"]);
    assert.equal(stopped.code, 0);
    const out = stopped.lines.join("\n");
    assert.match(out, /中枢：未运行/);
    assert.match(out, /机器：Mac-mini-书房/);
    assert.match(out, /地址：http:\/\/192\.168\.2\.13:8787（局域网）/);
    assert.match(out, /开机自启：已关闭/);
  } finally {
    await cleanup();
  }
});

test("hub status 成员行：/admin/owners 真实包装形状 {generation,owners} 解析（真双机实测缺陷回归）", async () => {
  const { home, cleanup } = await tmpHome();
  try {
    await fsp.writeFile(
      hubStateFile(home),
      JSON.stringify({
        version: 1,
        data_dir: path.join(home, "hub-data"),
        gateway_bind: "127.0.0.1:18787",
        relay_bind: "127.0.0.1:13340",
        autostart: false,
        initialized_at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await fsp.writeFile(hubTokenFile(home), "unit-admin-token-0123456789abcdef0123456\n", { mode: 0o600 });
    const lines = [];
    /** @param {string} url */
    const fetchImpl = async (url) => {
      if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
      // 真实 admin 面形状：owners 为包装对象（generation + owners 数组），非裸数组
      if (url.endsWith("/admin/owners")) {
        return Response.json({
          generation: 16,
          owners: [
            { fabric_id: "7162fdff", root: "aadd560f", alias: "Mac mini 实机成员", status: "active", expires_in: 2591985033 },
            { fabric_id: "bb63c1ee", root: "1122ab", alias: "旧成员", status: "active", expires_in: 1 },
          ],
        });
      }
      if (url.endsWith("/admin/status")) {
        return Response.json({ mode: "restricted", generation: 16, visitors_online: 1, knocks_pending: 2, codes_active: 1 });
      }
      return new Response("not found", { status: 404 });
    };
    const code = await hubStatus([], {
      home,
      fetchImpl,
      isPidAlive: () => false,
      stdout: (l) => lines.push(l),
      hostname: "unit.host",
    });
    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.includes("运行中")), "健康网关 → 运行中");
    assert.ok(
      lines.includes("成员：2 个租户 · 1 个访客在线 · 2 台设备在敲门"),
      `成员行必须按包装形状计数（旧代码恒 0），实际输出：${lines.join(" | ")}`,
    );
  } finally {
    await cleanup();
  }
});
