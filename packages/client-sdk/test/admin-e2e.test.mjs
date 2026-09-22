// sdk-mgmt-surface task 4.1：AdminClient 打真实本地 dweb-server 的 e2e
// （node --test；design §4「TS e2e」行——与 Rust e2e e17/e18 同构的管理面场景，
// 全部经 SDK 客户端而非裸 HTTP 发起）。
//
// 形态：child_process 起真实 dweb-server 子进程（debug 产物，端口 0 内核
// 分配：--gateway/--relay），实际地址从 stdout 就绪日志行解析（与
// crates/dweb-server/tests/server_access_e2e.rs 的 Server::spawn/wait_ready
// 同款——tracing 行前缀含 ANSI/时间戳，一律子串/正则匹配），再以
// GET /healthz 有界轮询等就绪。数据目录 mkdtemp 隔离。
//
// 场景（与 Rust e2e 管理面同构，经 AdminClient）：
// - probeEnabled() → true（200 判定）
// - connections() 初始空投影（mode=restricted / relay_enabled 拆分 /
//   quota 结构 / 空数组）
// - registerOwner（固定 hex 测试值）→ 回执 receiptCanonical 103B 布局 +
//   node:crypto 以 services.json 公告的 server_id 独立验签（adminPublicKey-
//   FromServices 提取；+ 篡改 ts 负面对照）+ listOwners 含该二元组
// - unregisterOwner → 回执验签 + kicked_* 零计数 + listOwners 移除
// - disconnect 未命中（endpoint_id / fabric_id 两形态）→ AdminError no-match
// - 错误 token 的第二 client → unauthorized（普通面 + probeEnabled 双钉：
//   401 = 已挂载但凭证错，绝不折叠为 admin-not-enabled）
// - kill server 后 probeEnabled → network（status null）
//
// 进程纪律（硬性）：t.after 恒 kill+wait（SIGTERM→5s→SIGKILL 兜底，幂等）
// + mkdtemp 数据目录清理；kill 场景与 after 复用同一出口。测试收尾由
// 运行方以 ps/lsof 自检无残留（见 change 收口报告）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  AdminClient,
  AdminError,
  adminPublicKeyFromServices,
  receiptCanonical,
  verifyReceipt,
} from "../admin/index.mjs";

const ADMIN_TOKEN = "e2e-admin-token";
const BIN = path.join(os.homedir(), ".cargo-target", "dweb", "debug", "dweb-server");
// 固定测试值（服务端 parse_owner_hex 只验 hex64——任意 32B 字节可注册）
const FABRIC = "f1".repeat(32);
const ROOT = "7c".repeat(32);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** raw 32B hex 公钥 → node:crypto Ed25519 验签函数（SPKI DER 前缀包装）。
 * 与 admin-receipt.test.mjs 的独立实现同款——与服务端 admin.rs 的
 * ed25519_dalek 签名互为交叉验证。 */
function verifierFor(pubkeyHex) {
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(pubkeyHex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  return (message, signature) =>
    ed25519Verify(null, Buffer.from(message), key, Buffer.from(signature));
}

/**
 * 起真实 dweb-server 子进程并等就绪（restricted + admin token + relay）。
 * 返回 { child, exitPromise, base, logs, dataDir }。
 */
async function spawnServer() {
  if (!existsSync(BIN)) {
    throw new Error(
      `dweb-server 二进制缺失：${BIN}\n` +
        `先构建：PATH="$HOME/.cargo/bin:$PATH" mbx build -j 2 -p dweb-server -q`,
    );
  }
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "dweb-admin-e2e-"));
  const child = spawn(
    BIN,
    ["--gateway", "127.0.0.1:0", "--relay", "127.0.0.1:0"],
    {
      env: {
        ...process.env,
        DWEB_DATA_DIR: dataDir,
        DWEB_ACCESS_MODE: "restricted",
        DWEB_ADMIN_TOKEN: ADMIN_TOKEN,
        DWEB_RELAY_MAX_CONNECTIONS_PER_OWNER: "8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // 两流持续行缓冲（防管道写满阻塞；日志兜底诊断用）
  const logs = [];
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", (line) => logs.push(line));
  }
  // exit 监听在 spawn 后立即挂——之后任何时刻 wait 不丢事件
  const exitPromise = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const dump = () => logs.join("\n");

  // 就绪日志等待（≤15s/50ms；提前退出即失败带日志）——与 Rust e2e 同款双标记
  const deadline = Date.now() + 15_000;
  let gateway = null;
  let relayUp = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const { code, signal } = await exitPromise;
      throw new Error(`dweb-server 提前退出（code=${code} signal=${signal}）：\n${dump()}`);
    }
    for (const line of logs) {
      if (gateway === null) {
        const m = line.match(/gateway listening on http:\/\/(\S+)/);
        if (m) gateway = m[1];
      }
      if (!relayUp && line.includes("iroh relay listening on")) relayUp = true;
    }
    if (gateway !== null && relayUp) break;
    await sleep(50);
  }
  if (gateway === null || !relayUp) {
    await killAndWait(child, exitPromise);
    throw new Error(`15s 内未见 gateway/relay 就绪日志：\n${dump()}`);
  }

  // healthz 有界等待（≤10s/100ms；单探测 2s 超时）
  const base = `http://${gateway}`;
  const healthDeadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (res.status === 200) break;
    } catch {
      // 未就绪——继续轮询
    }
    if (Date.now() >= healthDeadline) {
      await killAndWait(child, exitPromise);
      throw new Error(`10s 内 healthz 未就绪：\n${dump()}`);
    }
    await sleep(100);
  }
  return { child, exitPromise, base, logs, dataDir };
}

/** kill + wait（SIGTERM→5s→SIGKILL 兜底）；幂等——已退出直接返回结算值。 */
async function killAndWait(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return await exitPromise;
  }
  child.kill("SIGTERM");
  let settled = await Promise.race([exitPromise, sleep(5_000).then(() => null)]);
  if (settled === null) {
    child.kill("SIGKILL");
    settled = await exitPromise;
  }
  return settled;
}

test("AdminClient e2e against a real local dweb-server (restricted + admin token)", async (t) => {
  const server = await spawnServer();
  // 进程回收纪律（硬性）：无论成败恒 kill+wait + 数据目录清理
  t.after(async () => {
    await killAndWait(server.child, server.exitPromise);
    rmSync(server.dataDir, { recursive: true, force: true });
  });

  const client = new AdminClient({
    baseUrl: server.base,
    token: ADMIN_TOKEN,
    timeoutMs: 5_000,
  });
  let serverId = "";

  await t.test("probeEnabled() resolves true against the mounted admin plane", async () => {
    assert.equal(await client.probeEnabled(), true);
  });

  await t.test("connections(): initial empty projection with mode/relay_enabled split", async () => {
    const view = await client.connections();
    assert.equal(view.mode, "restricted", "mode 取配置字段而非 gate 句柄推导");
    assert.equal(view.relay_enabled, true, "--relay 起服 → relay_enabled 如实为 true");
    assert.deepEqual(view.quota, { configured: true, max_connections_per_owner: 8 });
    assert.deepEqual(view.per_endpoint, []);
    assert.deepEqual(view.per_owner, []);
  });

  await t.test("registerOwner(): receipt canonical + server_id 验签 + listOwners 命中", async () => {
    const servicesText = await (await fetch(`${server.base}/services.json`)).text();
    serverId = adminPublicKeyFromServices(servicesText);
    assert.match(serverId, /^[0-9a-f]{64}$/, "services.json 公告的 server_id 为小写 hex64");
    const verifier = verifierFor(serverId);

    const receipt = await client.registerOwner(FABRIC, ROOT);
    assert.equal(receipt.op, "register");
    assert.equal(receipt.fabric_id, FABRIC);
    assert.equal(receipt.root, ROOT);
    assert.ok(Number.isSafeInteger(receipt.ts) && receipt.ts > 0, "ts 毫秒域");
    assert.ok(Number.isSafeInteger(receipt.generation) && receipt.generation >= 1);
    assert.equal(typeof receipt.receipt_sig, "string");
    assert.equal(receipt.kicked_endpoints, undefined, "kicked_* 仅注销回执携带");
    assert.equal(receipt.kicked_connections, undefined);
    // canonical 布局（admin.rs 冻结：22+1+32+32+8+8 = 103B）
    assert.equal(receiptCanonical(receipt).length, 103);
    assert.equal(
      await verifyReceipt(receipt, verifier),
      true,
      "receipt_sig 可用 services.json 的 server_id 独立验签",
    );
    // 负面对照：篡改任一字段验签必假（证明上面的 true 有牙齿）
    assert.equal(
      await verifyReceipt({ ...receipt, ts: receipt.ts + 1 }, verifier),
      false,
      "篡改 ts 后验签必须失败",
    );

    const owners = await client.listOwners();
    assert.equal(typeof owners.generation, "number");
    const hit = owners.owners.find((o) => o.fabric_id === FABRIC && o.root === ROOT);
    assert.ok(hit, `listOwners 含注册二元组：${JSON.stringify(owners.owners)}`);
    assert.ok(Number.isSafeInteger(hit.registered_at) && hit.registered_at > 0);
  });

  await t.test("unregisterOwner(): receipt verifies + kicked counters + list removal", async () => {
    assert.match(serverId, /^[0-9a-f]{64}$/, "serverId 已由 register 子测试提取");
    const receipt = await client.unregisterOwner(FABRIC, ROOT);
    assert.equal(receipt.op, "unregister");
    assert.equal(receipt.fabric_id, FABRIC);
    assert.equal(receipt.root, ROOT);
    assert.equal(receipt.kicked_endpoints, 0, "无在线连接 → kicked_* 零计数（字段恒在）");
    assert.equal(receipt.kicked_connections, 0);
    assert.equal(
      await verifyReceipt(receipt, verifierFor(serverId)),
      true,
      "注销回执同样可 server_id 验签",
    );
    const owners = await client.listOwners();
    assert.ok(
      !owners.owners.some((o) => o.fabric_id === FABRIC && o.root === ROOT),
      "unregister 后 listOwners 移除该二元组",
    );
  });

  await t.test("disconnect(): no online target → 404 no-match (both selector forms)", async () => {
    for (const selector of [{ endpointId: "ab".repeat(32) }, { fabricId: FABRIC }]) {
      await assert.rejects(
        client.disconnect(selector),
        (err) => {
          assert.ok(err instanceof AdminError, JSON.stringify(selector));
          assert.equal(err.code, "no-match");
          assert.equal(err.status, 404);
          assert.ok(typeof err.message === "string" && err.message.length > 0);
          return true;
        },
        JSON.stringify(selector),
      );
    }
  });

  await t.test("wrong-token client → unauthorized (bad credentials ≠ not-enabled)", async () => {
    const bad = new AdminClient({
      baseUrl: server.base,
      token: "not-the-admin-token",
      timeoutMs: 5_000,
    });
    await assert.rejects(bad.listOwners(), (err) => {
      assert.ok(err instanceof AdminError);
      assert.equal(err.code, "unauthorized");
      assert.equal(err.status, 401);
      assert.ok(err.message.length > 0, "envelope message 透传");
      return true;
    });
    // probeEnabled 矩阵 401 路：已挂载但凭证错——绝不折叠为 admin-not-enabled
    await assert.rejects(bad.probeEnabled(), (err) => {
      assert.equal(err.code, "unauthorized");
      assert.equal(err.status, 401);
      return true;
    });
  });

  await t.test("after server kill: probeEnabled rejects with network (status null)", async () => {
    const settled = await killAndWait(server.child, server.exitPromise);
    assert.ok(settled !== null, "server 进程确实退出（exitPromise 已结算）");
    await assert.rejects(client.probeEnabled(), (err) => {
      assert.ok(err instanceof AdminError);
      assert.equal(err.code, "network");
      assert.equal(err.status, null);
      return true;
    });
    // 数据目录由 t.after 统一清理（killAndWait 幂等，after 里二次调用直接返回）
  });
});
