// e2e（webui-console A.10 / design §6）：本地真实 restricted dweb-server
// （cargo 产物，缺则 mbx 构建）+ 真实 sidecar CLI 子进程，三场景：
//  1) --server 直连启动：/api/status 200 透传 + 401 envelope 原样（错 token
//     侧车）+ POST /api/owners 注册 → 列表与直连 /admin/owners 一致；
//  2) setup 流程：无 --server 起侧车 → stdout 抓一次性配对码 → 模拟浏览器
//     POST /sidecar/connect（正确 Host/无 Origin）→ 冻结 → 业务通 → 再提交
//     target-frozen；
//  3) 明文远端拒启：http + 公网字面 IP（TEST-NET-3，无 --allow-insecure）
//     → 非零退出 + 提示（域名 + 假 DNS 的公网解析变体在 target 单测矩阵）。
// 进程纪律（硬性）：dweb-server 与所有 sidecar 子进程在 finally kill+wait；
// 每个场景结束自检子进程全部退出。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { request, postJson } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.mjs");
const ADMIN_TOKEN = "e2e-admin-token-xyzzy";
const GW_TIMEOUT_MS = 20_000;

function defaultServerBin() {
  return process.env.DWEB_SERVER_BIN ?? path.join(homedir(), ".cargo-target", "dweb", "debug", "dweb-server");
}

function buildServerBin() {
  // PATH 注入 cargo/mbx；构建产物仍落在 ~/.cargo-target/dweb（repo 配置）
  const env = { ...process.env, PATH: `${path.join(homedir(), ".cargo", "bin")}:${process.env.PATH ?? ""}` };
  execFileSync("mbx", ["build", "-j", "2", "-p", "dweb-server", "-q"], {
    env,
    cwd: path.join(here, "..", "..", ".."),
    stdio: "inherit",
    timeout: 600_000,
  });
  return defaultServerBin();
}

/** 行流收集（防管道写满阻塞） */
function drainLines(stream, sink) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (l) => sink.push(l));
}

class Child {
  constructor(name, child, lines) {
    this.name = name;
    this.child = child;
    this.lines = lines;
    this.exited = null;
    child.on("exit", (code, signal) => {
      this.exited = { code, signal };
    });
  }
  get text() {
    return this.lines.join("\n");
  }
  /** kill + wait（回收纪律；SIGTERM 5s 宽限后 SIGKILL） */
  async kill() {
    if (this.exited !== null) return this.exited;
    const child = this.child;
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.kill("SIGTERM");
    });
    return this.exited;
  }
}

/** W11：sidecar 的 hub-home 装配（hub.json + 0600 hub-token 指向目标 server） */
async function writeSidecarHubHome(home, port, token) {
  await writeFile(
    path.join(home, "hub.json"),
    JSON.stringify(
      {
        version: 1,
        data_dir: path.join(home, "hub-data"),
        gateway_bind: `0.0.0.0:${port}`,
        relay_bind: "0.0.0.0:3340",
        autostart: false,
        initialized_at: "2026-10-01T00:00:00Z",
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(home, "hub-token"), `${token}\n`, { mode: 0o600 });
  await chmod(path.join(home, "hub-token"), 0o600);
}

/** 起 dweb-server（restricted + admin token，端口 0 内核分配）并等就绪 */
async function spawnServer(dataDir) {
  // W11（2026-10-01）：服务端 admin token 唯一通道 = <data_dir>/admin-token
  //（0600）——spawn 前落文件，env 注入移除
  await writeFile(path.join(dataDir, "admin-token"), `${ADMIN_TOKEN}\n`, { mode: 0o600 });
  await chmod(path.join(dataDir, "admin-token"), 0o600);
  const lines = [];
  const child = spawn(
    defaultServerBin(),
    ["--gateway", "127.0.0.1:0", "--relay", "127.0.0.1:0"],
    {
      env: {
        ...process.env,
        DWEB_DATA_DIR: dataDir,
        DWEB_ACCESS_MODE: "restricted",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  drainLines(child.stdout, lines);
  drainLines(child.stderr, lines);
  const wrapper = new Child("dweb-server", child, lines);
  const port = await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (wrapper.exited !== null) {
        clearInterval(timer);
        reject(new Error(`dweb-server exited early (${JSON.stringify(wrapper.exited)}):\n${wrapper.text}`));
        return;
      }
      const m = wrapper.lines.find((l) => l.includes("gateway listening on http://"));
      if (m !== undefined) {
        clearInterval(timer);
        const addr = m.split("gateway listening on http://")[1]?.trim().replace(/[^0-9.]|$/g, "") ?? "";
        const portMatch = /127\.0\.0\.1:(\d+)/.exec(m);
        if (portMatch === null) {
          reject(new Error(`cannot parse gateway port from: ${m}`));
          return;
        }
        resolve(Number(portMatch[1]));
        return;
      }
      if (Date.now() - started > GW_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`gateway not ready in ${GW_TIMEOUT_MS}ms:\n${wrapper.text}`));
      }
    }, 50);
  });
  return { port, child: wrapper };
}

/** 起侧车 CLI 子进程并等 listening 行 */
async function spawnSidecar(args, { name = "sidecar", home = null } = {}) {
  const lines = [];
  const child = spawn(process.execPath, [CLI, ...args, "--no-open"], {
    // W11：env token 通道移除——home 形态经 DWEB_HOME 走 row-2 hub-local 的
    // 0600 hub-token 进程内通道（spawn 子进程无 TTY，argv/env 均不可用）
    env: { ...process.env, DWEB_ADMIN_TOKEN: "", ...(home !== null ? { DWEB_HOME: home } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  drainLines(child.stdout, lines);
  drainLines(child.stderr, lines);
  const wrapper = new Child(name, child, lines);
  const port = await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const text = wrapper.text;
      const m = /opendweb-webui listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
      if (m !== null) {
        clearInterval(timer);
        resolve(Number(m[1]));
        return;
      }
      if (wrapper.exited !== null) {
        clearInterval(timer);
        reject(new Error(`${name} exited early (${JSON.stringify(wrapper.exited)}):\n${text}`));
        return;
      }
      if (Date.now() - started > 10_000) {
        clearInterval(timer);
        reject(new Error(`${name} did not start in 10s:\n${text}`));
      }
    }, 50);
  });
  return { port, child: wrapper };
}

test("e2e: scenario 1 - direct --server startup, passthrough, 401 envelope, owners register", async (t) => {
  if (!existsSync(defaultServerBin())) buildServerBin();
  const dataDir = await mkdtemp(path.join(tmpdir(), "webui-e2e-s1-"));
  /** @type {Array<Child>} */
  const children = [];
  t.after(async () => {
    // 进程回收纪律：finally kill + wait 全部子进程
    for (const c of children) await c.kill();
    await rm(dataDir, { recursive: true, force: true });
    const leftovers = children.filter((c) => c.exited === null);
    assert.deepEqual(leftovers.map((c) => c.name), [], "all children must be reaped");
  });

  const server = await spawnServer(dataDir);
  children.push(server.child);

  // W11：显式 --server + --token 的 spawn 形态随 argv 通道移除——凭证经
  // hub-home（0600 hub-token）注入，row-2 hub-local 管理员通道端到端覆盖
  const homeA = await mkdtemp(path.join(tmpdir(), "webui-e2e-s1-a-"));
  await writeSidecarHubHome(homeA, server.port, ADMIN_TOKEN);
  const sidecarA = await spawnSidecar([], { name: "sidecar-ok", home: homeA });
  children.push(sidecarA.child);

  // /api/status 200 透传（envelope/body 原样）
  const status = await request(sidecarA.port, { path: "/api/status" });
  assert.equal(status.status, 200, status.text);
  const statusBody = JSON.parse(status.text);
  assert.equal(statusBody.mode, "restricted");
  assert.equal(status.headers["content-type"], "application/json");

  // 错 token 侧车：401 envelope 原样透传（远端负责语义，sidecar 不解释）
  const homeB = await mkdtemp(path.join(tmpdir(), "webui-e2e-s1-b-"));
  await writeSidecarHubHome(homeB, server.port, "wrong-token-on-purpose");
  const sidecarB = await spawnSidecar([], { name: "sidecar-bad", home: homeB });
  children.push(sidecarB.child);
  const unauthorized = await request(sidecarB.port, { path: "/api/status" });
  assert.equal(unauthorized.status, 401, unauthorized.text);
  const env401 = JSON.parse(unauthorized.text).error;
  assert.equal(env401.code, "unauthorized");
  // 与直连（无凭证）401 envelope 一致
  const direct401 = await request(server.port, { path: "/admin/status" });
  assert.equal(direct401.status, 401);
  assert.deepEqual(JSON.parse(direct401.text).error.code, env401.code);

  // POST /api/owners 注册 → 回执；经侧车列表与直连一致
  const fabric = "11".repeat(32);
  const root = "22".repeat(32);
  const reg = await postJson(sidecarA.port, "/api/owners", { fabric_id_hex: fabric, root_hex: root });
  assert.equal(reg.status, 200, reg.text);
  const receipt = JSON.parse(reg.text);
  assert.equal(receipt.fabric_id, fabric);
  assert.equal(receipt.root, root);
  assert.ok(typeof receipt.receipt_sig === "string" || typeof receipt.receipt === "object", "receipt present");

  const viaSidecar = await request(sidecarA.port, { path: "/api/owners" });
  assert.equal(viaSidecar.status, 200);
  const listSidecar = JSON.parse(viaSidecar.text);
  assert.ok(
    (listSidecar.owners ?? []).some((o) => o.fabric_id === fabric && o.root === root),
    `registered owner visible via sidecar: ${viaSidecar.text}`,
  );
  const viaDirect = await request(server.port, { path: "/admin/owners", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const listDirect = JSON.parse(viaDirect.text);
  assert.deepEqual(listDirect.owners, listSidecar.owners, "sidecar view consistent with direct /admin/owners");

  // token 不入子进程 stdout/stderr
  const sidecarText = sidecarA.child.text;
  assert.ok(!sidecarText.includes(ADMIN_TOKEN), `token leaked in sidecar output: ${sidecarText}`);
});

test("e2e: scenario 2 - setup flow (pairing code from stdout -> connect -> frozen -> business OK)", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "webui-e2e-s2-"));
  /** @type {Array<Child>} */
  const children = [];
  t.after(async () => {
    for (const c of children) await c.kill();
    await rm(dataDir, { recursive: true, force: true });
    const leftovers = children.filter((c) => c.exited === null);
    assert.deepEqual(leftovers.map((c) => c.name), [], "all children must be reaped");
  });

  const server = await spawnServer(dataDir);
  children.push(server.child);
  // setup 态（DWEB_HOME 隔离到本用例 temp——默认 ~/.opendweb 可能是中枢形态，
  // no-args 会走 row-2 而非 setup；测试必须显式隔离）
  const sidecar = await spawnSidecar([], { name: "sidecar-setup", home: dataDir });
  children.push(sidecar.child);

  // setup 态：业务面 503 no-target
  const before = await request(sidecar.port, { path: "/api/status" });
  assert.equal(before.status, 503);
  assert.equal(JSON.parse(before.text).error.code, "no-target");

  // 从 stdout 抓一次性配对码（只在终端面）
  const code = await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = /pairing code: ([A-Z2-7]{13})/.exec(sidecar.child.text);
      if (m !== undefined && m !== null) {
        clearInterval(timer);
        resolve(m[1]);
      } else if (Date.now() - started > 5000) {
        clearInterval(timer);
        reject(new Error(`pairing code not printed:\n${sidecar.child.text}`));
      }
    }, 50);
  });

  // 模拟浏览器：正确 Host（node 客户端自动带 127.0.0.1:port）、无 Origin
  const connect = await postJson(sidecar.port, "/sidecar/connect", {
    pairing_code: code,
    server: `http://127.0.0.1:${server.port}`,
    token: ADMIN_TOKEN,
  });
  assert.equal(connect.status, 200, connect.text);
  assert.deepEqual(JSON.parse(connect.text), { ok: true });

  // 冻结后业务通
  const status = await request(sidecar.port, { path: "/api/status" });
  assert.equal(status.status, 200, status.text);
  assert.equal(JSON.parse(status.text).mode, "restricted");

  // 再提交 → target-frozen
  const again = await postJson(sidecar.port, "/sidecar/connect", {
    pairing_code: code,
    server: `http://127.0.0.1:${server.port}`,
    token: ADMIN_TOKEN,
  });
  assert.equal(again.status, 400);
  assert.equal(JSON.parse(again.text).error.code, "target-frozen");

  // 配对码/token 都不进子进程输出
  const text = sidecar.child.text;
  assert.ok(text.includes(`pairing code: ${code}`), "code printed exactly once on terminal face");
  assert.ok(!text.includes(ADMIN_TOKEN), `token leaked in sidecar output: ${text}`);
});

test("e2e: scenario 3 - plaintext public target refused without --allow-insecure", async () => {
  // 拒启是「未起任何监听即退出」——无需 finally 回收，但要断言进程确已退出
  const lines = [];
  const child = spawn(
    process.execPath,
    [CLI, "--server", "http://203.0.113.10:18787", "--no-open"],
    { env: { ...process.env, DWEB_ADMIN_TOKEN: "" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  drainLines(child.stdout, lines);
  drainLines(child.stderr, lines);
  const wrapper = new Child("sidecar-plain", child, lines);
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ timedOut: true });
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.ok(!outcome.timedOut, "process must exit on its own");
  assert.notEqual(outcome.code, 0, `expected non-zero exit, got ${JSON.stringify(outcome)}`);
  const text = wrapper.text;
  assert.match(text, /plaintext http to a non-loopback host/);
  assert.match(text, /--allow-insecure/);
  // 域名 + 假 DNS（公网解析）变体由 test/target.test.mjs 覆盖（CLI 子进程无法注入 DNS）
});
