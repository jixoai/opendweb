// hex 呈现与校验纯函数。
// key 显示规范（server-access-roles specs/webui，取代 v1 的前 8 位规则）：
// 全站缩写 = hex **首 3 字符 + `***` + 尾 3 字符**（防截断碰撞，头尾同露）；
// 呈现 `别名 (abc***xyz)`，无别名仅 `(abc***xyz)`；title 全文 + 复制全文
// （64 hex）。操作面（注册/导入/添加表单）保留 64 hex 完整输入与校验。

/** hex 缩写（首 3 + *** + 尾 3；≤6 字符原样——不足以露出头尾）。 */
export function shortHex(value: string | null | undefined): string {
  if (typeof value !== "string" || value === "") return "-";
  if (value.length <= 6) return value;
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/** 全站 key 呈现通则：`别名 (abc***xyz)`；无别名/空白别名仅 `(abc***xyz)`。 */
export function displayKey(value: string | null | undefined, alias?: string | null): string {
  const abbr = shortHex(value);
  const name = typeof alias === "string" ? alias.trim() : "";
  return name !== "" ? `${name} (${abbr})` : `(${abbr})`;
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
