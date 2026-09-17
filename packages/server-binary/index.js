// @dweb/server-binary：以子进程方式启动 dweb-server，提供可等待的停止方式。
// gateway 命名（design D1）：gatewayBind 为 canonical；
// 透传 DWEB_GATEWAY_BIND / DWEB_TRUST_PROXY 等环境变量。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLATFORM_BINARIES = {
  "darwin-arm64": "dweb-server-aarch64-apple-darwin",
  "win32-x64": "dweb-server-x86_64-pc-windows.exe",
};
const SUPPORTED = `${process.platform}-${process.arch}`;
const BINARY_NAME = PLATFORM_BINARIES[SUPPORTED];
if (!BINARY_NAME) {
  throw new Error(
    `@jixo/opendweb-server-binary: platform ${SUPPORTED} is not supported yet. v0.2 ships ${Object.keys(PLATFORM_BINARIES).join(" / ")}; use the docker image ghcr.io/gaubee/dweb for other platforms.`,
  );
}

/**
 * @typedef {Object} StartServerOptions
 * @property {string} [gatewayBind] gateway（rendezvous/healthz/services.json）监听地址，默认 127.0.0.1:8787
 * @property {string} [relayBind]   relay HTTP 监听地址，默认 127.0.0.1:3340
 * @property {boolean} [relayEnabled] 默认 true
 * @property {boolean} [trustProxy]  true 时向子进程设置 DWEB_TRUST_PROXY=1（采信 X-Forwarded-Proto）；
 *                                   false 时设为 "0"；缺省时继承父进程环境
 * @property {string} [publicGatewayUrl] 公网 gateway 入口（反代/隧道后 services.json 的公告值）；
 *                                   仅显式定义时写 DWEB_PUBLIC_GATEWAY_URL，缺省继承父进程环境
 * @property {string} [publicRelayUrl]   公网 relay 入口；仅显式定义时写 DWEB_PUBLIC_RELAY_URL
 * @property {boolean} [forwardStderr]   默认 true：子进程 stderr 实时转发到父进程；
 *                                   false 时仅留存尾部（stderrTail() 可取）
 * @property {"open" | "restricted"} [accessMode] 访问控制模式（server-access-policy task 1.3）；
 *                                   仅显式定义时写 DWEB_ACCESS_MODE，缺省继承父进程环境
 * @property {"static" | "callback"} [accessPolicy] L2 策略选择（默认 static）；
 *                                   仅显式定义时写 DWEB_ACCESS_POLICY
 * @property {string} [ownersFile] owner registry 文件路径；仅显式定义时写 DWEB_OWNERS_FILE
 * @property {string} [callbackUrl] callback policy 的 webhook 入口（policy=callback 必填）；
 *                                   仅显式定义时写 DWEB_CALLBACK_URL
 * @property {string} [callbackToken] webhook Bearer 凭证；仅显式定义时写 DWEB_CALLBACK_TOKEN
 * @property {number} [callbackTimeoutMs] webhook 超时（1..=2000，默认 2000）；
 *                                   仅显式定义时写 DWEB_CALLBACK_TIMEOUT_MS
 * @property {number} [callbackCacheTtlMs] 决策缓存 TTL（0..=60000，默认 30000；0 = 禁用）；
 *                                   仅显式定义时写 DWEB_CALLBACK_CACHE_TTL_MS
 * @property {boolean} [allowLoopbackCallback] loopback webhook 豁免（开发用）。Rust 侧无对应
 *                                   env（只认 --allow-loopback-callback flag），经 spawn 参数传递；
 *                                   仅显式 true 时追加 flag，缺省不传
 * @property {number} [relayClientRx] 每客户端 relay 接收字节率上限（字节/秒，>0）；
 *                                   仅显式定义时写 DWEB_RELAY_CLIENT_RX
 *                                   （dataDir 不透传：数据目录是部署拓扑属性，调用方需要时
 *                                   经父进程 env DWEB_DATA_DIR 继承即可）
 */

/**
 * 启动 dweb-server 子进程。
 * @param {StartServerOptions} [options]
 * @returns {Promise<{ pid: number, gatewayUrl: string, httpUrl: string, relayHttpUrl: string, servicesUrl: string, stop: () => Promise<void>, exited: Promise<number> }>}
 */
export async function startServer(options = {}) {
  const binDir = path.dirname(fileURLToPath(import.meta.url));
  const srcBin = path.join(binDir, "bin", BINARY_NAME);
  // SMB 网络磁盘（开发机）上的原生二进制会触发 CODESIGNING Invalid Page：
  // darwin 拷到私有 tmp 内容寻址路径执行。Windows 无此问题且 tmp 无扩展名
  // 拷贝会被 Defender/路径解析干扰——直接执行源路径。
  let binPath = srcBin;
  if (process.platform === "darwin") {
    try {
      const buf = fs.readFileSync(srcBin);
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 24);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendweb-server-"));
      const dest = path.join(dir, hash);
      const fd = fs.openSync(dest, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o755);
      try {
        fs.writeFileSync(fd, buf);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      binPath = dest;
    } catch {
      binPath = srcBin; // 退回直接执行源路径
    }
  }

  const gatewayBind = options.gatewayBind ?? "127.0.0.1:8787";
  const relayBind = options.relayBind ?? "127.0.0.1:3340";
  const env = {
    ...process.env,
    DWEB_GATEWAY_BIND: gatewayBind,
    DWEB_RELAY_HTTP_BIND: relayBind,
    DWEB_RELAY_ENABLED: options.relayEnabled === false ? "false" : "true",
  };
  if (options.trustProxy !== undefined) {
    env.DWEB_TRUST_PROXY = options.trustProxy ? "1" : "0";
  }
  // 公网覆盖（public-exposure D5）：仅显式定义时写 env；undefined = 继承父进程环境
  if (options.publicGatewayUrl !== undefined) {
    env.DWEB_PUBLIC_GATEWAY_URL = options.publicGatewayUrl;
  }
  if (options.publicRelayUrl !== undefined) {
    env.DWEB_PUBLIC_RELAY_URL = options.publicRelayUrl;
  }
  // 访问控制配置面（server-access-policy task 1.3）：同惯例仅显式定义时写 env，
  // 缺省继承父进程环境（用户 shell 里已 export 的 DWEB_ACCESS_* 原样生效）
  if (options.accessMode !== undefined) {
    env.DWEB_ACCESS_MODE = options.accessMode;
  }
  if (options.accessPolicy !== undefined) {
    env.DWEB_ACCESS_POLICY = options.accessPolicy;
  }
  if (options.ownersFile !== undefined) {
    env.DWEB_OWNERS_FILE = options.ownersFile;
  }
  if (options.callbackUrl !== undefined) {
    env.DWEB_CALLBACK_URL = options.callbackUrl;
  }
  if (options.callbackToken !== undefined) {
    env.DWEB_CALLBACK_TOKEN = options.callbackToken;
  }
  if (options.callbackTimeoutMs !== undefined) {
    env.DWEB_CALLBACK_TIMEOUT_MS = String(options.callbackTimeoutMs);
  }
  if (options.callbackCacheTtlMs !== undefined) {
    env.DWEB_CALLBACK_CACHE_TTL_MS = String(options.callbackCacheTtlMs);
  }
  if (options.relayClientRx !== undefined) {
    env.DWEB_RELAY_CLIENT_RX = String(options.relayClientRx);
  }
  // allowLoopbackCallback 无 Rust 侧 env（只认 flag）：经 spawn 参数传递
  const args = options.allowLoopbackCallback === true ? ["--allow-loopback-callback"] : [];

  const child = spawn(binPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  if (typeof child.pid !== "number") {
    throw new Error("failed to spawn dweb-server");
  }

  // R2 P1-2：stderr 实时转发 + 尾部留存（最后 2KB）——子进程异常退出时
  // 调用方可取诊断输出；server 日志本就该对用户可见（默认转发，可关）。
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d).slice(-2048);
    if (options.forwardStderr !== false) process.stderr.write(d);
  });

  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code ?? 0));
    child.once("error", reject);
  });

  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGINT");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5000).unref();
    });

  const gatewayUrl = `http://${gatewayBind}`;
  const relayHttpUrl = `http://${relayBind}`;
  // httpUrl 为旧字段名保留（值同 gatewayUrl）
  return {
    pid: child.pid,
    gatewayUrl,
    httpUrl: gatewayUrl,
    relayHttpUrl,
    servicesUrl: `${gatewayUrl}/services.json`,
    /** 子进程 stderr 尾部（最后 2KB；异常退出时的诊断输出） */
    stderrTail: () => stderrTail,
    stop,
    exited,
  };
}
