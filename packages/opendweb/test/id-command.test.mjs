// 设备 key 数据面 + `opendweb id` 命令测试（server-access-roles Phase 3）。
// device-key：FileSecretStore 纪律镜像（load None/损坏含路径、ensure 原子
// insert-if-absent、0600、并发恰一胜身份不分叉）。
// id：只读幂等（两次执行输出一致、目录零变更）、无私钥输出、无 key 非零
// 退出并指引 join（不顺手生成）。

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deviceKeyFile,
  loadDeviceSeed,
  ensureDeviceSeed,
  SEED_LEN,
} from "../src/device-key.mjs";
import { endpointIdHexFromSeed } from "../src/ed25519.mjs";
import { abbreviateHex, runId } from "../src/identity.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/opendweb.mjs");

/** @returns {Promise<string>} 一次性临时 DWEB_HOME */
async function tmpHome() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-id-"));
}

/** @param {string} cmd @param {string[]} args @param {{env?: Record<string,string>}} [opts] */
function runCli(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    /** @type {string[]} */
    const stdout = [];
    /** @type {string[]} */
    const stderr = [];
    const child = execFile(
      process.execPath,
      [CLI, cmd, ...args],
      { env: { ...process.env, ...opts.env }, maxBuffer: 16 * 1024 * 1024 },
      (error, out, err) => resolve({ error, stdout: out, stderr: err, code: error ? /** @type {any} */ (error).code ?? 1 : 0 }),
    );
    void child;
    void stdout;
    void stderr;
  });
}

// ---- 缩写规则（[R6] 冻结：首 3 + *** + 尾 3） --------------------------------

test("abbreviateHex: abc***xyz 规则与短输入拒绝", () => {
  assert.equal(abbreviateHex("abcdef"), "abc***def");
  assert.equal(abbreviateHex(endpointIdHexFromSeed(Buffer.alloc(SEED_LEN, 7))).length, 9);
  assert.throws(() => abbreviateHex("abcde"), /at least 6/);
});

// ---- device-key：FileSecretStore 纪律 ----------------------------------------

test("loadDeviceSeed: 缺失 → null；损坏 → 错误含路径；合法 → 32B", async () => {
  const home = await tmpHome();
  assert.equal(await loadDeviceSeed(home), null);
  await fsp.writeFile(deviceKeyFile(home), "garbage");
  await assert.rejects(() => loadDeviceSeed(home), (e) => {
    assert.match(e.message, /corrupted/);
    assert.match(e.message, /identity\.key/);
    return true;
  });
  const seed = Buffer.alloc(SEED_LEN, 9);
  await fsp.writeFile(deviceKeyFile(home), seed);
  assert.deepEqual(await loadDeviceSeed(home), seed);
});

test("ensureDeviceSeed: 首启生成（0600/32B）；重启复用同一身份（不静默换 key）", async () => {
  const home = await tmpHome();
  const first = await ensureDeviceSeed(home);
  assert.equal(first.created, true);
  const stat = await fsp.stat(deviceKeyFile(home));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(first.seed.length, SEED_LEN);
  const second = await ensureDeviceSeed(home);
  assert.equal(second.created, false);
  assert.deepEqual(second.seed, first.seed);
  assert.equal(endpointIdHexFromSeed(second.seed), endpointIdHexFromSeed(first.seed));
});

test("ensureDeviceSeed: 两个并发 ensure 恰一胜、身份不分叉（EEXIST 回读胜者）", async () => {
  const home = await tmpHome();
  const [a, b] = await Promise.all([ensureDeviceSeed(home), ensureDeviceSeed(home)]);
  assert.deepEqual(a.seed, b.seed, "并发初始化身份必须一致");
  // 恰好落盘一份（不是 0 也不是 2 份）
  const entries = (await fsp.readdir(home)).filter((n) => n.startsWith("identity.key"));
  assert.deepEqual(entries, ["identity.key"]);
  assert.equal(a.created || b.created, true);
});

// ---- runId（进程内）：只读、幂等、无私钥 --------------------------------------

test("runId: 无 key 非零退出并指引 join（绝不顺手生成——零副作用）", async () => {
  const home = await tmpHome();
  await assert.rejects(() => runId({ home }), (e) => {
    assert.match(e.message, /no device key yet/);
    assert.match(e.message, /opendweb join/);
    assert.equal(e.exitCode, 1);
    return true;
  });
  assert.equal(await loadDeviceSeed(home), null, "id 不得生成 key");
});

test("runId: 输出 endpoint_id/缩写/路径；重复执行完全一致；目录零变更", async () => {
  const home = await tmpHome();
  const { seed } = await ensureDeviceSeed(home);
  const expectedId = endpointIdHexFromSeed(seed);
  /** @type {string[]} */
  const lines1 = [];
  await runId({ home, stdout: (l) => lines1.push(l) });
  const before = await fsp.readdir(home);
  const statBefore = await fsp.stat(deviceKeyFile(home));
  /** @type {string[]} */
  const lines2 = [];
  await runId({ home, stdout: (l) => lines2.push(l) });
  assert.deepEqual(lines1, lines2, "重复执行输出一致");
  assert.match(lines1.join("\n"), new RegExp(`endpoint_id  ${expectedId}`));
  assert.match(lines1.join("\n"), new RegExp(`short        ${expectedId.slice(0, 3)}\\*\\*\\*${expectedId.slice(-3)}`));
  assert.match(lines1.join("\n"), new RegExp(`key          .*${path.basename(deviceKeyFile(home))}`));
  // 私钥材料不出现在输出（stdout 全量审查）
  assert.ok(!lines1.join("\n").includes(seed.toString("hex")));
  assert.ok(!lines1.join("\n").includes(seed.toString("base64")));
  // 零状态变更：目录清单与 mtime 不变
  assert.deepEqual(await fsp.readdir(home), before);
  const statAfter = await fsp.stat(deviceKeyFile(home));
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
});

// ---- e2e（子进程 CLI，DWEB_HOME 隔离） ----------------------------------------

test("e2e opendweb id: 无 key → 非零+指引；join 写入 key 后 → 一致输出", async () => {
  const home = await tmpHome();
  const env = { DWEB_HOME: home };
  const missing = await runCli("id", [], { env });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /no device key yet/);
  assert.match(missing.stderr, /opendweb join/);
  assert.equal(missing.stdout, "");
  assert.equal(fs.existsSync(deviceKeyFile(home)), false);

  // 模拟 join 的设备引导（ensure 落 key），id 只读展示
  const { seed } = await ensureDeviceSeed(home);
  const expectedId = endpointIdHexFromSeed(seed);
  const first = await runCli("id", [], { env });
  assert.equal(first.code, 0);
  const second = await runCli("id", [], { env });
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, new RegExp(expectedId));
  assert.match(first.stdout, new RegExp(`${expectedId.slice(0, 3)}\\*\\*\\*${expectedId.slice(-3)}`));
  assert.ok(!first.stdout.includes(seed.toString("hex")), "私钥 hex 不落 stdout");
  assert.ok(!first.stderr.includes(seed.toString("hex")), "私钥 hex 不落 stderr");

  // 顺手带入非法参数：usage 错误（exit 2）
  const bad = await runCli("id", ["extra"], { env });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /id takes no arguments/);
});
