// 正交意图（维护于 2026-09-06 Asia/Shanghai）：构建期确定性代码 tokenizer —
// 注释/字符串/关键字/数字 四类着色，消费 app.css 的 --tok-* 主题 token。
// 无 mdsvex/shiki 的轻量替代（jixoai tech-stack 参考：小型站点可用消费相同
// 主题 token 的确定性 tokenizer）；输出确定 → {@html} 水合安全。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
// 快速开始代码块的 readonly-code 表面着色。

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  bash: new Set([
    "npx", "docker", "run", "export", "curl", "cd", "config", "set", "init",
    "invite", "join", "chat", "plugin", "add", "compose", "up",
  ]),
  js: new Set([
    "const", "let", "await", "async", "new", "import", "from", "require",
    "export", "default", "function", "return", "for", "of", "if",
  ]),
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const span = (cls: string, text: string): string =>
  `<span class="tok-${cls}">${escapeHtml(text)}</span>`;

/** 逐字符扫描的单一状态机：字符串（含未闭合到行尾的退化）→ 注释 →
 *  数字/关键字/普通词。绝不回溯、无随机性，同一输入永远同一输出。 */
export function highlight(code: string, lang: "bash" | "js" | "text"): string {
  if (lang === "text") return escapeHtml(code);
  const keywords = KEYWORDS[lang] ?? new Set<string>();
  const isWordChar = (ch: string): boolean => /[A-Za-z0-9_$@./-]/.test(ch);

  let out = "";
  let word = "";
  const flushWord = (): void => {
    if (!word) return;
    out += keywords.has(word) ? span("keyword", word) : escapeHtml(word);
    word = "";
  };

  for (let i = 0; i < code.length; i++) {
    const ch = code[i] as string;
    const rest = code.slice(i);
    // 注释：bash/js 同形（# 仅 bash）
    const commentMatch = lang === "bash" ? rest.match(/^#[^\n]*/) : rest.match(/^\/\/[^\n]*/);
    if (commentMatch) {
      flushWord();
      out += span("comment", commentMatch[0]);
      i += commentMatch[0].length - 1;
      continue;
    }
    // 字符串：'…' 与 "…"（不跨行；未闭合按到行尾退化，避免吞掉后续内容）
    if (ch === '"' || ch === "'") {
      flushWord();
      const end = code.indexOf(ch, i + 1);
      const newline = code.indexOf("\n", i + 1);
      const stop = end === -1 || (newline !== -1 && newline < end) ? newline : end;
      const literal = stop === -1 ? rest : code.slice(i, stop + (stop === end ? 1 : 0));
      out += span("string", literal);
      i += literal.length - 1;
      continue;
    }
    if (/[0-9]/.test(ch) && !/[A-Za-z_$@]/.test(word.slice(-1) ?? "")) {
      const num = rest.match(/^[0-9][0-9A-Za-z._+-]*[0-9A-Za-z._]/) ?? rest.match(/^[0-9]+/);
      const literal = num ? (num[0] as string) : ch;
      flushWord();
      out += span("number", literal);
      i += literal.length - 1;
      continue;
    }
    if (isWordChar(ch)) {
      word += ch;
      continue;
    }
    flushWord();
    out += escapeHtml(ch);
  }
  flushWord();
  return out;
}
