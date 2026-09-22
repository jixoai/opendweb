// 设备默认 key 数据面（server-access-roles Phase 3，R2「一台设备一个默认 key」）。
// 意图：CLI 层的设备身份存储——与内核 crates/dweb-fabric FileSecretStore 同一
// 纪律（identity.rs/secret.rs 逐条镜像），因为 SecretStore 抽象只在 Rust 侧，
// CLI 包无轻量 JS 暴露面（client-sdk napi 的 Fabric 工厂会拉起 iroh 网络栈）：
//   - 位置：`<DWEB_HOME>/identity.key`（默认 ~/.opendweb/；DWEB_HOME 供测试隔离）
//   - 内容：32B 裸 Ed25519 seed；load 长度≠32B 报含路径错误（Corrupted 语义）
//   - create：唯一 tmp（O_EXCL）+ 0600 + fsync + hard-link(2) 原子
//     insert-if-absent（EEXIST=Conflict 回读胜者，绝不静默覆盖）+ 目录 fsync
//   - ensure：load → 无则 OS CSPRNG 生成并 create；并发下恰一胜、身份不分叉
// 纪律：seed 只以 Buffer 流转；错误信息只含路径与原因，绝不含 seed 材料。

import crypto from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

/** 内核 secret.rs KEY_FILE_NAME 同名（fabric 数据面同构，便于心智统一） */
export const KEY_FILE_NAME = "identity.key";
/** Ed25519 seed 长度（identity.rs SEED_LEN） */
export const SEED_LEN = 32;

/** 模块级临时名计数器（同进程多调用也绝不互踩——Rust 侧同款） */
let tmpCounter = 0;

/**
 * 设备 key 文件路径。
 * @param {string} home DWEB_HOME（CLI 状态目录）
 * @returns {string}
 */
export function deviceKeyFile(home) {
  return path.join(home, KEY_FILE_NAME);
}

/**
 * 读取设备 key（FileSecretStore.load 语义）：ENOENT → null（后端确认不存在）；
 * 长度≠32 → 报含路径错误；其余读错误 → 报含路径错误。
 * @param {string} home
 * @returns {Promise<Buffer | null>}
 */
export async function loadDeviceSeed(home) {
  const keyPath = deviceKeyFile(home);
  let bytes;
  try {
    bytes = await readFile(keyPath);
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") return null;
    throw new Error(`failed to read device key ${keyPath}: ${err.message}`);
  }
  if (bytes.length !== SEED_LEN) {
    throw new Error(
      `device key file ${keyPath} is corrupted: expected ${SEED_LEN} bytes of Ed25519 seed, found ${bytes.length}`,
    );
  }
  return bytes;
}

/**
 * 原子 insert-if-absent（FileSecretStore.create 语义镜像）：唯一 tmp（wx=O_EXCL）
 * + 0600 + write + fsync + hard-link(2)（目标已存在=EEXIST=Conflict，绝不覆盖）
 * + 清理 tmp + 目录 fsync（Windows 降级为尽力而为，文档化边界同 Rust 侧）。
 * @param {string} keyPath
 * @param {Buffer} seed
 * @returns {Promise<void>} 抛 EEXIST（code 属性）= 已有身份
 */
async function createSeedFile(keyPath, seed) {
  const dir = path.dirname(keyPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${KEY_FILE_NAME}.${process.pid}.${++tmpCounter}.tmp`);
  // wx = O_EXCL：唯一 tmp 名 + 独占创建（同进程多调用也绝不互踩）
  const fh = await open(tmp, "wx");
  try {
    try {
      await fh.chmod(0o600);
    } catch { /* Windows 无 0600：降级为宿主/目录 ACL 责任（同 Rust） */ }
    await fh.write(seed);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await link(tmp, keyPath);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await rm(tmp, { force: true });
  try {
    const dh = await open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch { /* 目录 fsync 尽力而为（平台差异） */ }
}

/**
 * 载入设备 key；无则 OS CSPRNG 生成并原子 create（ensure_with 语义）。
 * 并发下恰一胜（EEXIST 回读胜者，身份不分叉）。
 * @param {string} home
 * @returns {Promise<{ seed: Buffer, keyPath: string, created: boolean }>}
 */
export async function ensureDeviceSeed(home) {
  const keyPath = deviceKeyFile(home);
  const existing = await loadDeviceSeed(home);
  if (existing !== null) return { seed: existing, keyPath, created: false };
  const seed = crypto.randomBytes(SEED_LEN);
  try {
    await createSeedFile(keyPath, seed);
    return { seed, keyPath, created: true };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "EEXIST") {
      // 并发败者回读胜者（loadDeviceSeed 已含损坏检查）
      const winner = await loadDeviceSeed(home);
      if (winner !== null) return { seed: winner, keyPath, created: false };
    }
    throw new Error(`failed to write device key ${keyPath}: ${err.message}`);
  }
}
