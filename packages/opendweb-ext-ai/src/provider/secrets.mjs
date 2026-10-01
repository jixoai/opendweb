// adapted from ai-fly src/provider/secrets.ts (v0.6.0)
// 提供方本地密钥库（secrets.json）：rewrite `$secret:<name>` 引用与 auth.secret
// 槽的唯一取值面。
// 与上游的有意分歧（design §0/§2）：
// - 路径根参数化到 `<DWEB_HOME>/plugins/ai/`（上游 ~/.aifly/provider/）；
// - 写原语换 atomicWrite0600（O_EXCL tmp+fsync+rename 家族——上游为同步
//   tmp+rename）；因此 set/remove 为 async，读路径保持同步 readFileSync。
// - 值为原样存储的字符串（bearerPrefix 退役语义照搬）：请求期 Bearer 前缀
//   拼接由消费方服务的 auth 槽 bearer 开关唯一决定。
// 上游设计裁决照搬：store 不持有内存态——每次读盘（无缓存即无失效问题）；
// 目录 0700 / 文件 0600；清单只投影名称与时间戳，值绝不跨任何远程面。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SECRET_NAME_SCHEMA } from "./lifecycle.mjs";
import { atomicWrite0600 } from "../fsutil.mjs";
import { StoreError, ensurePrivateDir } from "./store.mjs";

/** 密钥清单条目（值由设计不出现在任何投影）。 */
export const SECRETS_VALUE_MAX = 8192;

/** 文件形状：{ version: 1, secrets: { [name]: { value, createdAt, updatedAt } } }
 *  （strip 语义：旧文件未知字段加载即剥离——与上游 zod strip 语义一致）。 */
const SECRETS_FILE_SCHEMA = z.object({
  version: z.literal(1),
  secrets: z.record(
    SECRET_NAME_SCHEMA,
    z.object({
      value: z.string().min(1).max(SECRETS_VALUE_MAX),
      createdAt: z.number().int().min(0),
      updatedAt: z.number().int().min(0),
    }),
  ),
});

/**
 * 密钥库（读写同一文件语义；无内存态——每次操作重读）。
 * 读（list/get/resolve/exists）同步；写（set/remove）async（原子写家族）。
 */
export class SecretsStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  /** @param {string} dataDir */
  static filePath(dataDir) {
    return join(dataDir, "secrets.json");
  }

  /** 打开（确保目录存在；文件不存在视为空库——首次 set 时落盘）。 */
  static async open(dataDir) {
    await ensurePrivateDir(dataDir);
    return new SecretsStore(dataDir);
  }

  /** 读盘 + 校验（不存在 → 空库；损坏/非法抛 StoreError(corrupt)）。 */
  #read() {
    const file = SecretsStore.filePath(this.dataDir);
    if (!existsSync(file)) return { version: 1, secrets: {} };
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      throw new StoreError("corrupt", `error: cannot read ${file}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreError("corrupt", `error: ${file} is not valid JSON (fix or remove it manually)`);
    }
    const result = SECRETS_FILE_SCHEMA.safeParse(parsed);
    if (!result.success) {
      throw new StoreError("corrupt", `error: ${file} failed validation: ${result.error.message}`);
    }
    return result.data;
  }

  /** @param {{version: 1, secrets: Record<string, {value: string, createdAt: number, updatedAt: number}>}} data */
  async #write(data) {
    await atomicWrite0600(SecretsStore.filePath(this.dataDir), `${JSON.stringify(data, null, 2)}\n`);
  }

  /** 清单（名称/时间戳；按名称排序稳定输出；值绝不出现）。 */
  list() {
    const { secrets } = this.#read();
    return Object.entries(secrets)
      .map(([name, entry]) => ({ name, createdAt: entry.createdAt, updatedAt: entry.updatedAt }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 取值（未知名返回 undefined——由调用方决定失败语义，如 secret_missing）。 */
  get(name) {
    const entry = this.#read().secrets[name];
    return entry === undefined ? undefined : entry.value;
  }

  /** 存在性（store 激活门用；不取值）。 */
  exists(name) {
    return this.#read().secrets[name] !== undefined;
  }

  /** 解析为注入值：原样（Bearer 前缀由服务 auth 槽 bearer 开关拼）。 */
  resolve(name) {
    const entry = this.#read().secrets[name];
    if (entry === undefined) return undefined;
    return { headerValue: entry.value };
  }

  /**
   * 新增/覆写（原样值；createdAt 首次落定时固定，覆写只动 updatedAt）。
   * @param {string} name @param {string} value @param {{ now?: () => number }} [ctx]
   */
  async set(name, value, ctx = {}) {
    const now = ctx.now ?? Date.now;
    if (!SECRET_NAME_SCHEMA.safeParse(name).success) {
      throw new StoreError(
        "invalid",
        "error: secret name must be 1..128 chars of lowercase letters, digits, dot, dash, underscore",
      );
    }
    if (value === "" || value.length > SECRETS_VALUE_MAX) {
      throw new StoreError("invalid", `error: secret value must be 1..${SECRETS_VALUE_MAX} chars`);
    }
    const data = this.#read();
    const previous = data.secrets[name];
    const entry = {
      value,
      createdAt: previous === undefined ? now() : previous.createdAt,
      updatedAt: now(),
    };
    data.secrets[name] = entry;
    await this.#write(data);
    return { name, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }

  /** 删除（不存在抛 StoreError(not-found)）。 */
  async remove(name) {
    const data = this.#read();
    if (data.secrets[name] === undefined) {
      throw new StoreError("not-found", `error: secret '${name}' not found`);
    }
    delete data.secrets[name];
    await this.#write(data);
  }
}
