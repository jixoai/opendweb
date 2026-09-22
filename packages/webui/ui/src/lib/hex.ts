// hex 呈现与校验纯函数（自 ui/views.mjs 原样移植）。
// 分层披露（§5.1 通则）：浏览面一律 前 8 位 + … + 复制 + 悬停全文；操作面
// （注册表单）保留 64 hex 完整输入与校验。

/** hex64 缩写显示（默认前 8 字符 + …）。 */
export function shortHex(value: string | null | undefined, head = 8): string {
  if (typeof value !== "string" || value === "") return "-";
  return value.length <= head ? value : `${value.slice(0, head)}…`;
}

/** 回执签名（base64url-nopad 64B）→ 前 N 位 hex（默认 16 hex = 8 字节）。 */
export function sigPrefixHex(b64url: string | null | undefined, chars = 16): string {
  if (typeof b64url !== "string" || b64url === "") return "";
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of b64url) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) return "";
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  return bytes
    .slice(0, Math.ceil(chars / 2))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, chars);
}

/** 客户端 hex64 校验（与服务端 400 规则同构的 fail-fast 镜像）。 */
export function validateHex64(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}
