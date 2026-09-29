// ignore 语义（webui-plugin-kernel Phase 3 / design v2.3 §7.2/§7.4-6）。
// 意图（2026-09-29）：
// 1. `<root>/.gitignore` 语义 + `<root>/.dweb-sync/exclude`（追加清单——两者同
//    一匹配器）。实现为 gitignore 常用子集：`#` 注释、空行、行尾空白剥离、
//    `!` 反选、尾 `/` 目录限定、首 `/` 锚定、`**` 跨段、`*`/`?` 单段通配、
//    `[...]` 字符类。完整 fnmatch 边角（八进制转义等）非 v1（如实标注）。
// 2. 隐式忽略：`.git`（根）与 `.dweb-sync`（根元数据目录）恒忽略——同步元数据
//    不入树。
// 3. 多级 .gitignore（子目录级）非 v1：仅根级两文件（简单性边界，显式记录）。

/**
 * glob → RegExp（gitignore 子集语义）。
 * @param {string} pattern
 */
function globToRegExp(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**`：跨段（`/**/` 语义=任意层级；裸 `**`=任意）
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1; // 吞掉随后的 `/`（已由 .* 覆盖）
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) {
        re += "\\[";
        i += 1;
      } else {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return re;
}

/**
 * @typedef {Object} IgnoreRule
 * @property {boolean} negate
 * @property {boolean} dirOnly
 * @property {RegExp} re
 * @property {string} source
 */

/**
 * 解析 ignore 清单（.gitignore/exclude 行）。
 * @param {string} text
 * @param {string} source
 * @returns {IgnoreRule[]}
 */
export function parseIgnoreLines(text, source) {
  /** @type {IgnoreRule[]} */
  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negate = false;
    let p = line;
    if (p.startsWith("!")) {
      negate = true;
      p = p.slice(1);
    }
    if (p === "") continue;
    let dirOnly = false;
    if (p.endsWith("/")) {
      dirOnly = true;
      p = p.slice(0, -1);
    }
    let anchored = false;
    if (p.startsWith("/")) {
      anchored = true;
      p = p.replace(/^\/+/, "");
    }
    if (p === "") continue;
    // 含 `/`（非尾）→ 相对根锚定；否则 basename 匹配
    const hasSlash = p.includes("/");
    const body = globToRegExp(p);
    const re = anchored || hasSlash ? new RegExp(`^(?:.*/)?${hasSlash && !anchored ? "" : ""}${body}(?:/.*)?$`) : new RegExp(`(?:^|/)${body}(?:/.*)?$`);
    rules.push({ negate, dirOnly, re, source });
  }
  return rules;
}

/**
 * 构造匹配器（最后命中规则胜——negate 反选语义）。
 * @param {IgnoreRule[]} rules
 * @returns {(relPath: string, isDir: boolean) => boolean}
 */
export function buildMatcher(rules) {
  return (relPath, isDir) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) {
        // 目录限定规则匹配路径的任一父目录段也生效（git 语义：dir 规则屏蔽其下全部）
        const segs = relPath.split("/");
        let hit = false;
        for (let i = 1; i < segs.length; i++) {
          if (rule.re.test(segs.slice(0, i).join("/"))) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
      } else if (!rule.re.test(relPath)) continue;
      ignored = !rule.negate;
    }
    return ignored;
  };
}

/**
 * 读根级 ignore 规则（.gitignore + .dweb-sync/exclude + 隐式 .git/.dweb-sync）。
 * @param {string} root 同步根绝对路径
 * @param {{ readFile?: (p: string) => Promise<string> }} [io]
 * @returns {Promise<(relPath: string, isDir: boolean) => boolean>}
 */
export async function loadRootIgnore(root, io = {}) {
  const readFile = io.readFile ?? ((p) => import("node:fs/promises").then((m) => m.readFile(p, "utf8")));
  /** @type {IgnoreRule[]} */
  let rules = [];
  for (const file of [".gitignore", ".dweb-sync/exclude"]) {
    try {
      const text = await readFile(`${root}/${file}`);
      rules = rules.concat(parseIgnoreLines(text, file));
    } catch {
      /* 无文件=无规则 */
    }
  }
  const m = buildMatcher(rules);
  return (relPath, isDir) => {
    if (relPath === ".git" || relPath === ".dweb-sync" || relPath.startsWith(".git/") || relPath.startsWith(".dweb-sync/")) return true;
    return m(relPath, isDir);
  };
}
