// server-access-policy task 2.5：RelayOptions.relays（per-relay capability）
// 的 JS 配置面测试。断言层次：
// - 构造期接受/拒绝（spec scenario：双字段冲突显式报错；旧形态兼容零变化）
// - relayStatus() 的配置回显（mode/urls）
// - serverId hex64 门（root 自签场景的配置面）
// - ensureRelayCapabilities 的非 restricted 空回执与非 root 拒绝
// wire 层（凭证经 Authorization 头注入 restricted relay、deny reason 经
// relay-offline 事件透出）依赖真实 restricted server——由 dweb-server
// tests/story_e2e.rs（task 2.7）黑盒覆盖，JS 层不做重实现。
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sdkModule from "../index.js";
const { Fabric } = /** @type {any} */ (sdkModule);

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const HAS_RELAYS = typeof Fabric?.prototype?.ensureRelayCapabilities === "function";
const maybeTest = HAS_RELAYS ? test : test.skip;

const DEAD_RELAY = "http://127.0.0.1:9"; // 恒不可达：配置面测试不依赖网络成功
const HEX64 = "ab".repeat(32);

// 结构合法的 dwebr1. 串（fabric 构造期对 token 做结构解码门：210B wire、
// 版本字节、caps 保留位、issuer/recipient 曲线点有效性；签名内容不校验——
// 那是 server 侧 L1 的事）。wire 布局 = design §11.1 冻结形态。
function fakeCapToken() {
  const rawPub = () =>
    generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "der" })
      .slice(-32); // SPKI 尾部 32B 原始公钥
  const issuer = rawPub();
  const recipient = rawPub();
  const wire = Buffer.alloc(210);
  wire[0] = 0x01; // version
  wire.fill(1, 1, 33); // fabric_id（任意）
  wire.fill(2, 33, 65); // server_id（任意）
  wire.set(issuer, 65);
  wire.set(recipient, 97);
  wire[129] = 0x01; // caps = RELAY 位（保留位必须为 0）
  wire.writeBigUInt64BE(1_800_000_000_000n, 130); // issued_at
  wire.writeBigUInt64BE(1_800_003_600_000n, 138); // expires_at
  // sig 64B 零：decode 不验签（server L1 才验）
  return "dwebr1." + wire.toString("base64url");
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, pattern);
    return true;
  });
}

// ---- spec scenario：双字段冲突显式报错 ------------------------------------------

maybeTest("relays + urls are mutually exclusive (construction rejects)", async () => {
  await rejects(
    Fabric.createRoot({
      dataDir: tmpdir("dweb-rl-x1-"),
      relay: {
        mode: "custom",
        urls: [DEAD_RELAY],
        relays: [{ url: DEAD_RELAY, token: fakeCapToken() }],
      },
    }),
    /mutually exclusive/,
  );
  // 空数组同样视为"已提供"（与 urls 空数组在 n0/disabled 下的语义一致）
  await rejects(
    Fabric.createRoot({
      dataDir: tmpdir("dweb-rl-x2-"),
      relay: { mode: "custom", urls: [], relays: [{ url: DEAD_RELAY }] },
    }),
    /mutually exclusive/,
  );
});

// ---- spec scenario：旧形态兼容（urls 行为零变化） --------------------------------

maybeTest("legacy urls form still works unchanged", async () => {
  const a = await Fabric.createRoot({
    dataDir: tmpdir("dweb-rl-legacy-"),
    relay: { mode: "custom", urls: [DEAD_RELAY] },
  });
  const s = await a.relayStatus();
  assert.equal(s.mode, "custom");
  assert.deepEqual(s.urls, [DEAD_RELAY]);
  await a.shutdown();
});

// ---- per-relay 条目：接受形态 + 状态回显 ------------------------------------------

maybeTest("relays with token constructs and echoes urls in relayStatus", async () => {
  const a = await Fabric.createRoot({
    dataDir: tmpdir("dweb-rl-tok-"),
    relay: {
      mode: "custom",
      relays: [{ url: DEAD_RELAY, token: fakeCapToken() }],
    },
  });
  const s = await a.relayStatus();
  assert.equal(s.mode, "custom");
  assert.deepEqual(s.urls, [DEAD_RELAY]);
  // offline（恒不可达）：online 为 false、activeUrl null；lastError 为
  // 脱敏类别或 null（deny reason 透出需 restricted server，见 story e2e）
  assert.equal(s.online, false);
  assert.equal(s.activeUrl, null);
  assert.ok(s.lastError === null || typeof s.lastError === "string");
  await a.shutdown();
});

maybeTest("relays entry with serverId (hex64) is accepted", async () => {
  const a = await Fabric.createRoot({
    dataDir: tmpdir("dweb-rl-sid-"),
    relay: {
      mode: "custom",
      relays: [{ url: DEAD_RELAY, serverId: HEX64 }],
    },
  });
  const s = await a.relayStatus();
  assert.deepEqual(s.urls, [DEAD_RELAY]);
  await a.shutdown();
});

maybeTest("relays entry without token/serverId (credential-free entry)", async () => {
  const a = await Fabric.createRoot({
    dataDir: tmpdir("dweb-rl-bare-"),
    relay: { mode: "custom", relays: [{ url: DEAD_RELAY }] },
  });
  const s = await a.relayStatus();
  assert.deepEqual(s.urls, [DEAD_RELAY]);
  await a.shutdown();
});

// ---- 构造期校验矩阵 ---------------------------------------------------------------

maybeTest("relays rejected outside mode custom", async () => {
  await rejects(
    Fabric.createRoot({
      dataDir: tmpdir("dweb-rl-n0-"),
      relay: { relays: [{ url: DEAD_RELAY }] },
    }),
    /relay\.relays is only valid with mode 'custom'/,
  );
  await rejects(
    Fabric.createRoot({
      dataDir: tmpdir("dweb-rl-dis-"),
      relay: { mode: "disabled", relays: [{ url: DEAD_RELAY }] },
    }),
    /relay\.relays is not accepted with mode 'disabled'/,
  );
});

maybeTest("relays empty array in custom rejects", async () => {
  await rejects(
    Fabric.createRoot({
      dataDir: tmpdir("dweb-rl-empty-"),
      relay: { mode: "custom", relays: [] },
    }),
    /at least one relay entry/,
  );
});

maybeTest("bad serverId (not hex64) rejects with explicit message", async () => {
  await rejects(
    Fabric.createRoot({
      dataDir: tmpdir("dweb-rl-bad1-"),
      relay: { mode: "custom", relays: [{ url: DEAD_RELAY, serverId: "zz" }] },
    }),
    /serverId must be 64 hex characters/,
  );
  await rejects(
    Fabric.createRoot({
      dataDir: tmpdir("dweb-rl-bad2-"),
      relay: {
        mode: "custom",
        relays: [{ url: DEAD_RELAY, serverId: "ab".repeat(31) }],
      },
    }),
    /serverId must be 64 hex characters/,
  );
});

maybeTest("malformed dwebr1. token rejects at construction (fabric decode gate)", async () => {
  await rejects(
    Fabric.createRoot({
      dataDir: tmpdir("dweb-rl-badcap-"),
      relay: {
        mode: "custom",
        relays: [{ url: DEAD_RELAY, token: "dwebr1.not-a-real-token" }],
      },
    }),
    /malformed dwebr1\. capability token/,
  );
});

// ---- ensureRelayCapabilities（root 自签闭环的 SDK 面） -----------------------------

maybeTest("ensureRelayCapabilities: non-restricted entries yield empty list", async () => {
  const token = fakeCapToken();
  const a = await Fabric.createRoot({
    dataDir: tmpdir("dweb-rl-ensure-"),
    relay: {
      // serverId 缺失 = 非 restricted 条目：root 无自签对象
      mode: "custom",
      relays: [{ url: DEAD_RELAY, token }],
    },
  });
  const caps = await a.ensureRelayCapabilities();
  // 静态 token 条目原样透传（本地注入用；无签发语义）
  assert.equal(caps.length, 1);
  assert.equal(caps[0].url, DEAD_RELAY);
  assert.equal(caps[0].token, token);
  await a.shutdown();
});

maybeTest("ensureRelayCapabilities: non-root callers get roster error", async () => {
  const root = await Fabric.createRoot({
    dataDir: tmpdir("dweb-rl-ens-a-"),
    relay: { mode: "custom", relays: [{ url: DEAD_RELAY, serverId: HEX64 }] },
  });
  const fabricId = await root.fabricIdHex();
  const b = await Fabric.attach(
    { dataDir: tmpdir("dweb-rl-ens-b-"), relay: { mode: "custom", relays: [{ url: DEAD_RELAY }] } },
    fabricId,
  );
  // CustomWithCaps（带 restricted 条目形态）下非 root 调用报名册 root-only 错误
  await assert.rejects(b.ensureRelayCapabilities(), /requires root/);
  await b.shutdown();
  await root.shutdown();
});
