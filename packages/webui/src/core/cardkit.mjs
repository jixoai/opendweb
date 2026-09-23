// 接入卡片算法复用面（home-hub [H1] Phase 2a / design §5.1「core 含 QR 与短码
// 算法」+ §3.1 短码 wire 单源在 CLI util）。本 phase 只打通 import 面：
// 经 workspace 依赖（package.json dependencies "opendweb": "workspace:*"）
// re-export 短码 encode/decode 与 QR 矩阵/ASCII 算法——2c 接入卡片卡（webui
// 总览）与 CLI `hub card` 同源同文案时消费；SVG 渲染层届时在 webui 侧实现
// （qr.mjs 头注：webui 复用同一矩阵生成，只换渲染层）。

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
