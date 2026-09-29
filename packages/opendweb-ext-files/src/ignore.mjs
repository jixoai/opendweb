// .opendweb-ignore 行 glob（webui-plugin-kernel Phase 2 / design v2.3 §6）。
// 意图（2026-09-29）：
// 1. `<root>/.opendweb-ignore`：每行一个 glob；空行与 `#` 注释跳过；语义仅由
//    提供侧定义（忽略清单不下传——B 侧看不到哪些条目被忽略）。
// 2. 匹配语义（提供侧冻结）：
//    - `*` 匹配单段内任意字符（不含 `/`）；`?` 单个非 `/` 字符；`**` 跨段；
//    - 模式不含 `/`（且未锚定）→ 对**任意深度**的该名字匹配（类 gitignore）；
//    - 模式含 `/` → 从 share root 锚定匹配（行首 `/` 等价锚定，不重复锚）；
//    - 行尾 `/` → 仅匹配目录；
//    - 命中目录 → 其全部内容视为忽略（祖先段命中即忽略）。
// 3. 匹配的条目：list 不返回；read/stat/chunk/commit/mkdir/rename/delete 一律
//    拒绝（404 语义——与不存在不可区分，不泄露存在性）。

/**
 * 单条 ignore 规则。
 * @typedef {Object} IgnoreRule
 * @property {RegExp} re 全相对路径（posix 连接）匹配器
 * @property {boolean} dirOnly
 * @property {boolean} anchored
 * @property {string} source 原始行（诊断用）
 */

/**
 * glob → 正则（`**`=跨段任意，`*`=段内任意，`?`=单字符；其余字面转义）。
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**`（可能形如 `a/**/b`——跨任意段）
        let j = i + 2;
        if (pattern[j] === "/") j++; // `**/` 允许零段：`(?:[^/]+/)*`
        re += "(?:[^/]+/)*";
        i = j;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}

/**
 * 解析 .opendweb-ignore 文本 → 规则集。
 * @param {string} text
 * @returns {IgnoreRule[]}
 */
export function parseIgnoreRules(text) {
  /** @type {IgnoreRule[]} */
  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    let pat = line;
    let dirOnly = false;
    if (pat.endsWith("/")) {
      dirOnly = true;
      pat = pat.slice(0, -1);
    }
    let anchored = false;
    if (pat.startsWith("/")) {
      anchored = true;
      pat = pat.slice(1);
    } else if (pat.includes("/")) {
      anchored = true; // 含 / 即从 root 锚定（gitignore 同语义）
    }
    if (pat === "") continue;
    rules.push({ re: globToRegExp(pat), dirOnly, anchored, source: line });
  }
  return rules;
}

/**
 * 相对路径是否被忽略。
 * @param {IgnoreRule[]} rules
 * @param {string[]} components 相对路径组件（validateComponents 产物）
 * @param {{ isDir?: boolean }} [entry] 终条目类型（dirOnly 规则判定；缺省按
 *   未知处理——dirOnly 规则不匹配未知类型？——保守读法：未知视为可能为目录，
 *   dirOnly 规则对祖先段判定不依赖该标记）
 * @returns {boolean}
 */
export function isIgnored(rules, components, entry = {}) {
  if (rules.length === 0 || components.length === 0) return false;
  // 祖先段（全部按目录处理——命中目录即忽略其内容）
  for (let depth = 1; depth <= components.length; depth++) {
    const prefix = components.slice(0, depth).join("/");
    const isLast = depth === components.length;
    const treatAsDir = isLast ? entry.isDir === true : true;
    for (const rule of rules) {
      if (rule.dirOnly && !treatAsDir) continue;
      if (matchRule(rule, prefix, components.slice(0, depth))) return true;
    }
  }
  return false;
}

/**
 * 单规则匹配：anchored 规则匹配全路径；非 anchored 规则匹配任意段对齐后缀
 * （类 gitignore 的「任意深度名字」）。
 * @param {IgnoreRule} rule
 * @param {string} joined 段连接（`a/b/c`）
 * @param {string[]} comps
 * @returns {boolean}
 */
function matchRule(rule, joined, comps) {
  if (rule.anchored) return rule.re.test(joined);
  // 非 anchored：任一段起点开始的后缀全匹配（名字规则命中任意深度）
  for (let start = 0; start < comps.length; start++) {
    if (rule.re.test(comps.slice(start).join("/"))) return true;
  }
  return false;
}

/**
 * 读 root 的 .opendweb-ignore（经已解析的 root fd 链语义由调用方保证；本函数
 * 只做纯文本解析的入口封装——读文件由 ops 层完成以复用链纪律）。导出
 * parseIgnoreRules/isIgnored 供 ops 调用。
 */
export const IGNORE_FILE_NAME = ".opendweb-ignore";
