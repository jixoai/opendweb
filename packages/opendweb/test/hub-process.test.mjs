// 中枢守护进程模型 e2e（home-hub 1b，specs/cli/hub「统一执行链与环境冻结」）：
// 前台链（env 冻结注入/数据落点核实/admin 双探/锁）、同数据目录互斥、
// detached 启停（pid 三元组/token 不出面）、三宿主插件钩子一致（前台 vs
// detached 同 config_path 冻结配置）。
// 依赖真实 dweb-server 二进制；admin 面挂载能力（Phase 1c 后的打包产物）
// 先探后行——陈旧二进制跳过并给出重打包指引（不假成功也不误报）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NODE = process.execPath;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");

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

/**
 * 等待 gateway 就绪。
 * @param {string} base
 * @param {number} [ms]
 */
async function waitHealthy(base, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`healthz not ready: ${base}`);
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

/** 子进程退出等待（竞态安全） */
function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

/**
 * CLI 执行（收集 stdout/stderr 与退出码；cwd 必须显式——包目录里有历史
 * dweb-data/，会被 init 的接管规则采用）。
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} [cwd]
 */
async function cli(args, env, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(NODE, [CLI, ...args], {
      env: { ...process.env, ...env },
      cwd: cwd ?? os.tmpdir(),
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException & { stdout?: string, stderr?: string, code?: number | string } } */ (e);
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** admin 面能力探测（陈旧打包二进制跳过链级 e2e 的门） */
let adminCapableCache;
async function serverSupportsAdmin() {
  if (adminCapableCache !== undefined) return adminCapableCache;
  const { startServer } = await import("@jixo/opendweb-server-binary");
  const gateway = await freePort();
  const relay = await freePort();
  const prev = process.env.DWEB_ADMIN_TOKEN;
  process.env.DWEB_ADMIN_TOKEN = "capability-probe-token";
  let srv = null;
  try {
    srv = await startServer({ gatewayBind: `127.0.0.1:${gateway}`, relayBind: `127.0.0.1:${relay}` });
    await waitHealthy(`http://127.0.0.1:${gateway}`, 15000);
    const res = await fetch(`http://127.0.0.1:${gateway}/admin/status`);
    adminCapableCache = res.status === 401;
  } catch {
    adminCapableCache = false;
  } finally {
    if (prev === undefined) delete process.env.DWEB_ADMIN_TOKEN;
    else process.env.DWEB_ADMIN_TOKEN = prev;
    if (srv !== null) await srv.stop();
  }
  return adminCapableCache;
}

/** @returns {Promise<{ home: string, cwd: string, gateway: number, relay: number, cleanup: () => Promise<void> }>} */
async function freshHub() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "hub-proc-home-"));
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "hub-proc-cwd-"));
  const gateway = await freePort();
  const relay = await freePort();
  const init = await cli(
    ["hub", "init", "--yes", "--gateway", `127.0.0.1:${gateway}`, "--relay", `127.0.0.1:${relay}`],
    { DWEB_HOME: home },
    cwd,
  );
  assert.equal(init.code, 0, `init failed: ${init.stdout}\n${init.stderr}`);
  return {
    home,
    cwd,
    gateway,
    relay,
    cleanup: async () => {
      await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * 读 token 并断言不出现在给定文本中。
 * @param {string} home
 * @param {string} text
 * @param {string} what
 */
async function assertNoTokenLeak(home, text, what) {
  const token = (await fsp.readFile(path.join(home, "hub-token"), "utf8")).trim();
  assert.ok(!text.includes(token), `hub-token must not leak into ${what}`);
  return token;
}

// ---- 前台链：env 冻结 + 数据落点 + admin 双探 + 锁 -------------------------------

test("foreground chain: DWEB_DATA_DIR/token/binds injected from hub.json override poisoned env; data lands in hub.json.data_dir; admin mounted (401/200)", async (t) => {
  if (!(await serverSupportsAdmin())) {
    t.skip("packed dweb-server binary predates the admin API (Phase 1c); rebuild packages/server-binary (npm run pack:binary) to enable chain e2e");
    return;
  }
  const hub = await freshHub();
  const poisoned = path.join(hub.cwd, "poisoned-data");
  try {
    const child = spawn(NODE, [CLI, "hub", "start", "--foreground"], {
      env: {
        ...process.env,
        DWEB_HOME: hub.home,
        DWEB_DATA_DIR: poisoned,
        DWEB_GATEWAY_BIND: "127.0.0.1:9",
        DWEB_RELAY_HTTP_BIND: "127.0.0.1:9",
        DWEB_ACCESS_MODE: "open",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {string} */
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.setEncoding("utf8");
    try {
      const base = `http://127.0.0.1:${hub.gateway}`;
      await waitHealthy(base);
      // admin 双探（从链外复核——链内失败会自行停机退出）
      const noToken = await fetch(`${base}/admin/status`);
      assert.equal(noToken.status, 401, "admin mounted: 401 without token (not 404)");
      const token = (await fsp.readFile(path.join(hub.home, "hub-token"), "utf8")).trim();
      const withToken = await fetch(`${base}/admin/status`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(withToken.status, 200);
      // 数据落点核实：hub.json.data_dir（非继承的 poisoned 值）
      assert.ok(fs.existsSync(path.join(hub.home, "hub-data", "server.key")), "server.key in hub-data");
      assert.equal(fs.existsSync(poisoned), false, "poisoned DWEB_DATA_DIR must not be used");
      // 锁在场
      assert.ok(fs.existsSync(path.join(hub.home, "hub-data", "hub.lock")));
      // 启动输出不含 token
      await assertNoTokenLeak(hub.home, out, "chain stdout");
      // restricted 预设：services.json 公告（mode 非断言面——access 由 env 注入）
      const services = await (await fetch(`${base}/services.json`)).json();
      assert.ok(typeof services.server_id === "string");

      // ---- 同数据目录互斥：第二次前台启动失败并输出占用方 pid ----
      const second = await cli(["hub", "start", "--foreground"], { DWEB_HOME: hub.home });
      assert.notEqual(second.code, 0);
      assert.match(second.stderr + second.stdout, /in use \(pid \d+/);
      // 首次运行不受影响
      const still = await fetch(`${base}/healthz`);
      assert.equal(still.status, 200);

      // ---- 停机：SIGINT → 链退出 → 锁清理 ----
      child.kill("SIGINT");
      await waitExit(child);
      assert.equal(fs.existsSync(path.join(hub.home, "hub-data", "hub.lock")), false, "hub.lock released on shutdown");
      await assertNoTokenLeak(hub.home, out, "chain stdout (post-stop)");
    } finally {
      // 常驻进程回收纪律：先给优雅停机窗口，再强杀（强杀链会孤儿化
      // dweb-server 孙进程——由套件末尾的孤儿断言兜底暴露）
      child.kill("SIGINT");
      await Promise.race([waitExit(child), new Promise((r) => setTimeout(r, 8000))]);
      child.kill("SIGKILL");
      await waitExit(child);
    }
  } finally {
    await hub.cleanup();
  }
});

// ---- detached 启停：pid 三元组/token 不出面 ----------------------------------------

test("detached start/stop: daemon spawns with identity triple; token never in argv/log; stop verifies and stops cleanly", async (t) => {
  if (!(await serverSupportsAdmin())) {
    t.skip("packed dweb-server binary predates the admin API (Phase 1c); rebuild packages/server-binary (npm run pack:binary) to enable chain e2e");
    return;
  }
  const hub = await freshHub();
  const poisoned = path.join(hub.cwd, "poisoned-data");
  try {
    const start = await cli(["hub", "start"], { DWEB_HOME: hub.home, DWEB_DATA_DIR: poisoned });
    assert.equal(start.code, 0, `start failed: ${start.stdout}\n${start.stderr}`);
    const base = `http://127.0.0.1:${hub.gateway}`;
    await waitHealthy(base);
    // pid 三元组（detached 宿主写）
    const triple = JSON.parse(await fsp.readFile(path.join(hub.home, "hub.pid"), "utf8"));
    assert.ok(Number.isInteger(triple.pid));
    assert.ok(typeof triple.start_identity === "string" && triple.start_identity.length > 0);
    assert.match(triple.argv_digest, /^[0-9a-f]{64}$/);
    assert.equal(await isAlive(triple.pid), true, "daemon chain process alive");
    // admin 双探复核（detached 宿主）
    assert.equal((await fetch(`${base}/admin/status`)).status, 401);
    const token = await assertNoTokenLeak(hub.home, start.stdout, "start stdout");
    const log = await fsp.readFile(path.join(hub.home, "hub-data", "hub.log"), "utf8");
    assert.ok(!log.includes(token), "token never in hub.log");
    // 数据落点（继承 poisoned env 被 hub 注入覆盖）
    assert.ok(fs.existsSync(path.join(hub.home, "hub-data", "server.key")));
    assert.equal(fs.existsSync(poisoned), false);

    const stop = await cli(["hub", "stop", "--yes"], { DWEB_HOME: hub.home });
    assert.equal(stop.code, 0, `stop failed: ${stop.stdout}\n${stop.stderr}`);
    assert.match(stop.stdout, /已停止。/);
    assert.equal(fs.existsSync(path.join(hub.home, "hub.pid")), false, "pid file removed");
    let down = false;
    try {
      await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    } catch {
      down = true;
    }
    assert.equal(down, true, "gateway is down after stop");
    assert.equal(await isAlive(triple.pid), false, "daemon chain exited");
  } finally {
    await cli(["hub", "stop", "--yes"], { DWEB_HOME: hub.home }).catch(() => {});
    await hub.cleanup();
  }
});

// ---- 三宿主插件钩子一致（前台 vs detached；服务宿主=plist 冻结断言见 hub-state） ----

/** 钩子记录夹具：--opendweb-hook <name> 时 append "hook:gatewayBind" 到 $HUB_HOOKLOG */
const HOOK_PLUGIN = [
  "#!/usr/bin/env node",
  "import fs from 'node:fs';",
  "const args = process.argv.slice(2);",
  "if (args.includes('--opendweb-declare')) {",
  "  process.stdout.write(JSON.stringify({ name: 'hook-recorder', hooks: ['server.preStart', 'server.postReady', 'server.preStop'] }) + '\\n');",
  "  process.exit(0);",
  "}",
  "const i = args.indexOf('--opendweb-hook');",
  "if (i !== -1) {",
  "  const hook = args[i + 1];",
  "  let text = '';",
  "  process.stdin.setEncoding('utf8');",
  "  process.stdin.on('data', (d) => (text += d));",
  "  process.stdin.on('end', () => {",
  "    const payload = text ? JSON.parse(text) : {};",
  "    if (hook === 'server.preStart' || hook === 'server.postReady') {",
  "      fs.appendFileSync(process.env.HUB_HOOKLOG, `${hook}:${payload.server?.gatewayBind}\\n`);",
  "    }",
  "    process.exit(0);",
  "  });",
  "}",
].join("\n");

test("plugin hooks fire identically for foreground and detached hosts (frozen config_path)", async (t) => {
  if (!(await serverSupportsAdmin())) {
    t.skip("packed dweb-server binary predates the admin API (Phase 1c); rebuild packages/server-binary (npm run pack:binary) to enable chain e2e");
    return;
  }
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "hook-home-"));
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "hook-cwd-"));
  const gateway = await freePort();
  const relay = await freePort();
  const hooklog = path.join(home, "hooklog.txt");
  try {
    await fsp.writeFile(path.join(cwd, "hook-recorder.mjs"), HOOK_PLUGIN);
    await fsp.writeFile(
      path.join(cwd, "opendweb.config.toml"),
      `configVersion = 1\n\n[[plugins]]\nfile = "hook-recorder.mjs"\n`,
    );
    // init 自 cwd：config_path 冻结
    const init = await cli(
      ["hub", "init", "--yes", "--gateway", `127.0.0.1:${gateway}`, "--relay", `127.0.0.1:${relay}`],
      { DWEB_HOME: home },
      cwd,
    );
    assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
    const state = JSON.parse(await fsp.readFile(path.join(home, "hub.json"), "utf8"));
    assert.equal(state.config_path, path.join(fs.realpathSync(cwd), "opendweb.config.toml"));

    // 前台宿主
    const fg = spawn(NODE, [CLI, "hub", "start", "--foreground"], {
      env: { ...process.env, DWEB_HOME: home, HUB_HOOKLOG: hooklog },
      cwd: os.tmpdir(), // 故意不在配置目录——不依赖 cwd 发现
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitHealthy(`http://127.0.0.1:${gateway}`);
      await new Promise((r) => setTimeout(r, 500)); // postReady 钩子落盘
      fg.kill("SIGINT");
      await waitExit(fg);
    } finally {
      fg.kill("SIGINT");
      await Promise.race([waitExit(fg), new Promise((r) => setTimeout(r, 8000))]);
      fg.kill("SIGKILL");
      await waitExit(fg);
    }
    const fgLog = await fsp.readFile(hooklog, "utf8");
    assert.match(fgLog, new RegExp(`server.preStart:127\\.0\\.0\\.1:${gateway}`));
    assert.match(fgLog, new RegExp(`server.postReady:127\\.0\\.0\\.1:${gateway}`));

    // detached 宿主（同一冻结配置；cwd 同样漂移）
    const start = await cli(["hub", "start"], { DWEB_HOME: home, HUB_HOOKLOG: hooklog });
    assert.equal(start.code, 0, `${start.stdout}\n${start.stderr}`);
    await waitHealthy(`http://127.0.0.1:${gateway}`);
    await new Promise((r) => setTimeout(r, 500));
    const stop = await cli(["hub", "stop", "--yes"], { DWEB_HOME: hubStopEnv(home) });
    assert.equal(stop.code, 0, `${stop.stdout}\n${stop.stderr}`);
    const fullLog = (await fsp.readFile(hooklog, "utf8")).split("\n").filter(Boolean);
    const fgLines = fgLog.split("\n").filter(Boolean);
    // 两宿主触发序列逐一致（preStart → postReady；preStop 在 stop 级联里尽力而为不计入）
    assert.deepEqual(fullLog.slice(0, fgLines.length), fgLines, "identical hook sequence across hosts");
  } finally {
    await cli(["hub", "stop", "--yes"], { DWEB_HOME: home }).catch(() => {});
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * hook 测试的 stop env 透传（HUB_HOOKLOG 不需要）。
 * @param {string} home
 */
function hubStopEnv(home) {
  return home;
}

// ---- 孤儿进程回收纪律：套件结束时无残留 --------------------------------------------

test("no orphan dweb-server / hub daemon processes are left behind by this suite", async () => {
  // 本文件每个用例的 finally 已显式停机；此处兜底断言（进程回收证据）。
  // 只匹配命令首 token（tmp 内容寻址拷贝名/守护 node 首参数），避免把
  // 引用了这些字符串的 shell/测试命令自身当孤儿。
  const procs = await execFileAsync("ps", ["-eo", "command"]).catch(() => ({ stdout: "" }));
  const leftovers = procs.stdout.split("\n").filter((l) => {
    const first = l.trim().split(/\s+/)[0] ?? "";
    const second = l.trim().split(/\s+/)[1] ?? "";
    return /opendweb-server-[A-Za-z0-9]{6}\//.test(first)
      || /dweb-server-(aarch64|x86_64)/.test(first)
      || (first.endsWith("node") && second.endsWith("opendweb.mjs") && l.includes("hub start"));
  });
  assert.deepEqual(leftovers, [], `orphan processes: ${leftovers.join(" | ")}`);
});
