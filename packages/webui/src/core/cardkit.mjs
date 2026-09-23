// 接入卡片算法复用面（home-hub [H1] Phase 2a→2c / design §5.1「core 含 QR 与
// 短码算法」+ §3.1 短码 wire 单源在 CLI util + §3.2 卡片三形态同源）。
// 意图：
// 1. 经 workspace 依赖（package.json dependencies "opendweb": "workspace:*"）
//    re-export 短码 encode/decode 与 QR 矩阵/ASCII 算法（2a 既有面）；
// 2. 2c 接入卡片卡：`renderHubCard` 直引 CLI 同一函数（hub.mjs printHubCard 的
//    渲染出口——终端形态零分叉）；`hubCardModel` 镜像 printHubCard 的数据推导
//    （机器名/局域网地址/短码——底层件全用 util.mjs 同一导出；hub.mjs 侧三件
//    私有小函数 portOf/lanUrl/displayMachineName 在此镜像，测试对拍钉等价）；
// 3. `qrSvg`：webui 卡片的二维码渲染层（qr.mjs 头注约定——同一 qrMatrix 矩阵
//    只换渲染；SVG 与终端 ASCII 同算法同矩阵）。
// 卡片无凭证（O-8 实现默认）：模型/渲染均不含 token/邀请码/回执材料。

import os from "node:os";
import {
  ALIAS_MAX_BYTES,
  encodeShortCode,
  formatShortCodeForDisplay,
  machineName,
  networkIPv4s,
  routableIPv6s,
  truncateUtf8Bytes,
} from "opendweb/src/util.mjs";
import { qrMatrix } from "opendweb/src/qr.mjs";

export {
  SHORT_CODE_PREFIX,
  encodeShortCode,
  decodeShortCode,
  resolveServerArg,
} from "opendweb/src/util.mjs";

export {
  qrMatrix,
  qrAscii,
  renderQrAscii,
  qrDataCodewords,
  bch15,
} from "opendweb/src/qr.mjs";

// CLI `hub card` / `hub init` 尾部的同一渲染函数（printHubCard 的唯一出口）。
// 懒加载 re-export：hub.mjs 的传递依赖较重（zod/smol-toml——config-file 链），
// 显式 --server 的 CLI 启动路径不背它；hub.json 相关路径（无参分流/数据面）
// 首次使用时加载并缓存。对拍/消费方经 loadRenderHubCard() 取得同一函数引用。
/** @type {((input: { machine: string, urls: string[], primaryUrl: string, shortCode: string }) => string) | null} */
let renderHubCardFn = null;

/** 取 CLI 同一 renderHubCard（懒加载；模块缺失=明确报错——卡片同源性不可降级）。 */
export async function loadRenderHubCard() {
  if (renderHubCardFn === null) {
    const m = await import("opendweb/src/hub.mjs");
    renderHubCardFn = m.renderHubCard;
  }
  return renderHubCardFn;
}

/**
 * 接入卡片数据模型（与 CLI printHubCard 同一推导；PM §4.4 三形态同源）。
 * 镜像件说明：hub.mjs 的 lanAddresses/lanUrl/displayMachineName 为私有函数，
 * 此处用 util.mjs 同一导出复刻（对拍测试钉住两端口径一致）；hubCardModel 的
 * 输出可直接喂 renderHubCard（形状就是它的入参）。
 * @param {{ hostname?: string, interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>, gatewayBind?: string }} input
 *   - hostname/interfaces：注入面（测试/宿主）；缺省取本机
 *   - gatewayBind：hub.json 的 gateway_bind（如 "0.0.0.0:8787"）
 * @returns {{ machine: string, urls: string[], primaryUrl: string, shortCode: string, port: number }}
 */
export function hubCardModel({ hostname, interfaces, gatewayBind = "0.0.0.0:8787" } = {}) {
  const nics = interfaces ?? os.networkInterfaces();
  const addresses = [...networkIPv4s(nics), ...routableIPv6s(nics)];
  const primary = addresses[0] ?? "127.0.0.1";
  const port = bindPort(gatewayBind);
  const machine = displayMachineName(hostname ?? os.hostname());
  return {
    machine,
    urls: addresses.map((ip) => lanUrl(ip, port)),
    primaryUrl: lanUrl(primary, port),
    shortCode: formatShortCodeForDisplay(encodeShortCode(primary, port)),
    port,
  };
}

/**
 * 二维码 SVG（webui 卡片渲染层；与终端 ASCII 同一 qrMatrix 矩阵）。
 * 暗模块 rect 聚合为单条 path（体积小）；四周 4 模块静区（与 ASCII 同拍）；
 * 输出为纯静态 XML（无脚本/外部引用），SPA 经容器 innerHTML 注入。
 * @param {string} text 编码内容（卡片=主呈现地址）
 * @param {{ scale?: number }} [opts] 每模块像素（缺省 4）
 * @returns {string}
 */
export function qrSvg(text, { scale = 4 } = {}) {
  const { size, modules } = qrMatrix(text);
  const quiet = 4;
  const dim = (size + quiet * 2) * scale;
  /** @type {string[]} */
  const rects = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c] === 1) {
        rects.push(`M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${rects.join("")}" fill="#000000"/>` +
    `</svg>`
  );
}

// ---- hub.mjs 私有小函数镜像（对拍测试钉等价；改动须两侧同步） ----------------------

/** @param {string} bind */
function bindPort(bind) {
  const i = bind.lastIndexOf(":");
  const port = i === -1 ? Number.NaN : Number(bind.slice(i + 1).replace("]", ""));
  return Number.isInteger(port) ? port : 8787;
}

/** @param {string} ip @param {number} port */
function lanUrl(ip, port) {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return `http://${host}:${port}`;
}

/** @param {string} hostname */
function displayMachineName(hostname) {
  const raw = machineName(hostname).replace(/[\x00-\x1f\x7f]/g, "");
  return truncateUtf8Bytes(raw, ALIAS_MAX_BYTES).value;
}
